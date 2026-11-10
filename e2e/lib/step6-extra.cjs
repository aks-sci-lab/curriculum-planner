// 6단계 직접 고치기(class-sections-edit.js)·출력물(class-sections-print.js) 시나리오 — 사용자처럼 클릭하고, 확인은 화면 글자·내려받은 엑셀로 한다.
//  교실 배정(모든 그룹: 분반마다 교실·같은 블록 겹침 0·같은 시간 다른 학년 같은 교실 0) · 교실 직접 고르기(roomPins)가 다시 계산·직접 고치기 뒤에도 남는지
//  분반 수 표 칸 바꾸기 → 블록 분반 수·검증·이동 학생 수 · 같이 신청 학생 수·충돌 표시 · 학생 한 명 옮기기 · 배정 결과 엑셀 내려받아 3명 바꿔 올리기
//  출석부(분반 시트 수·인원·위 3줄·날짜 칸 수) · 학생 시간표(칸 = 배정 결과·고정 시간·재신청 표시·인쇄 쪽 수·엑셀)
const fs = require("node:fs");
const path = require("node:path");
const S6 = require("./step6.cjs");
const { writeXlsx } = require("./xlsx-write.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const compact = (v) => String(v ?? "").replace(/\s+/g, "");
const bareTerm = (v) => String(v ?? "").replace(/\s*[(（]\s*[12]\s*학기\s*[)）]\s*$/, "");
const waitIdle = (page) => page.waitForFunction(() => !document.querySelector("#classSectionsSolve")?.disabled, null, { timeout: 180000, polling: 200 });
const status = (page) => page.locator("#classSectionsStatus").innerText().catch(() => "");

async function saveDownload(page, trigger, file) {
  const event = page.waitForEvent("download", { timeout: 60000 });
  await trigger();
  const download = await event;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(await download.path(), file);
  return file;
}

// 화면 카드의 교실: 분반 id·나이스 강의실·과목·블록·시간·교실 id·교실 이름·직접 고른 값
async function readRooms(page) {
  return page.evaluate(() => {
    const out = [];
    for (const block of document.querySelectorAll(".cs-blocks .cs-block")) {
      const head = block.querySelector("h5");
      const letter = (head?.childNodes[0]?.textContent || "").trim().replace(/블록$/, "");
      const times = [...String(head?.querySelector("em")?.textContent || "").matchAll(/([월화수목금토])\s*(\d+)/g)].map((m) => `${m[1]}${m[2]}`);
      for (const li of block.querySelectorAll("li.cs-section")) {
        const select = li.querySelector(".cs-room select");
        const label = (select?.selectedOptions[0]?.textContent || "").trim().replace(/^자동\((.*)\)$/, "$1");
        out.push({ id: li.dataset.sectionId, room: li.dataset.room, course: li.dataset.course, letter, times, roomId: li.querySelector(".cs-room")?.dataset.roomId || "",
          roomLabel: label, pick: select?.value || "", options: select ? [...select.options].map((o) => o.value).filter(Boolean) : [], clash: !!li.querySelector(".cs-room.is-clash") });
      }
    }
    const summary = document.querySelector("#classSectionsRoomSummary");
    return { sections: out, errors: Number(summary?.getAttribute("data-errors") || 0), summary: (summary?.innerText || "").replace(/\s+/g, " ").slice(0, 300),
      errorList: [...document.querySelectorAll("#classSectionsRoomErrors li")].map((li) => li.textContent.trim()).slice(0, 5) };
  });
}

// 모든 그룹 교실 배정 점검 + 같은 학기·같은 시간 같은 교실(학년이 달라도) 겹침
async function checkRoomsAll({ page, h, info, label = "" }) {
  const out = { groups: {}, clashes: [] };
  const used = new Map(); // 학기|시간|교실 → 그룹:강의실
  for (const g of info) {
    await S6.selectGroup(page, g.key);
    const r = await readRooms(page);
    if (!r.sections.length) { out.groups[g.key] = { sections: 0 }; continue; }
    const missing = r.sections.filter((s) => !s.roomId).map((s) => s.room);
    const perBlock = new Map();
    for (const s of r.sections) { const k = `${s.letter}|${s.roomId}`; perBlock.set(k, [...(perBlock.get(k) || []), s.room]); }
    const doubled = [...perBlock].filter(([k, list]) => list.length > 1 && !k.endsWith("|")).map(([k, list]) => `${k}: ${list.join(",")}`);
    out.groups[g.key] = { sections: r.sections.length, missing: missing.length, doubled: doubled.length, errors: r.errors, summary: r.summary };
    h.check(!missing.length && !doubled.length && r.errors === 0, "중요", "6단계", `${g.key}${label}: 교실 배정 — 교실 없는 분반 ${missing.length}·같은 블록 같은 교실 ${doubled.length}·교실 오류 ${r.errors}`,
      { actual: { missing: missing.slice(0, 5), doubled: doubled.slice(0, 5), errors: r.errorList, summary: r.summary } });
    for (const s of r.sections) for (const t of s.times) {
      if (!s.roomId) continue;
      const k = `${g.semester}|${t}|${s.roomId}`;
      if (used.has(k) && !used.get(k).startsWith(`${g.key}:${s.letter}`)) out.clashes.push(`${k}: ${used.get(k)} / ${g.key}:${s.letter}:${s.room}`);
      else used.set(k, `${g.key}:${s.letter}:${s.room}`);
    }
  }
  out.clashes = [...new Set(out.clashes)];
  h.check(!out.clashes.length, "중요", "6단계", `교실 배정${label}: 같은 학기·같은 시간에 같은 교실을 쓰는 분반(다른 그룹·다른 학년 포함) ${out.clashes.length}건`, { actual: out.clashes.slice(0, 6) });
  return out;
}

// 교실 직접 고르기: 그 블록에서 아무도 안 쓰는 교실로 → 나중에 남는지 확인
async function pinRoom(page, groupKey) {
  await S6.selectGroup(page, groupKey);
  const r = await readRooms(page);
  for (const s of r.sections) {
    const usedHere = new Set(r.sections.filter((x) => x.letter === s.letter).map((x) => x.roomId));
    const free = s.options.find((v) => !usedHere.has(v));
    if (!free) continue;
    await page.locator(`select[data-cs-room-pick="${s.id}"]`).selectOption(free);
    await sleep(600);
    const after = await readRooms(page);
    const me = after.sections.find((x) => x.id === s.id);
    return { groupKey, id: s.id, room: s.room, value: free, applied: me?.pick === free && me?.roomId === free, status: await status(page) };
  }
  // 빈 교실이 없으면 같은 블록 다른 분반의 교실을 고름(그 분반은 앱이 다른 교실로 옮김)
  const s = r.sections.find((x) => x.options.some((v) => v !== x.roomId));
  if (!s) return null;
  const value = s.options.find((v) => v !== s.roomId);
  await page.locator(`select[data-cs-room-pick="${s.id}"]`).selectOption(value);
  await sleep(600);
  const me = (await readRooms(page)).sections.find((x) => x.id === s.id);
  return { groupKey, id: s.id, room: s.room, value, applied: me?.pick === value && me?.roomId === value, status: await status(page), sharedWithOther: true };
}
async function pinKept(page, pin) {
  if (!pin) return null;
  await S6.selectGroup(page, pin.groupKey);
  const r = await readRooms(page);
  const me = r.sections.find((x) => x.id === pin.id) || r.sections.find((x) => x.room === pin.room);
  return { found: Boolean(me), sameId: me?.id === pin.id, pick: me?.pick || "", roomId: me?.roomId || "", kept: me?.pick === pin.value && me?.roomId === pin.value };
}

// ---- 직접 고치기 ----
async function readPlacement(page) {
  return page.evaluate(() => {
    const table = document.querySelector("#classSectionsPlacementTable");
    if (!table) return null;
    const blocks = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim()).filter((t) => /^[a-z]블록$/.test(t)).map((t) => t[0]);
    const rows = [...table.querySelectorAll("tbody tr")].map((tr) => ({ name: tr.querySelector("th button")?.textContent.trim() || "", demand: Number(tr.cells[1]?.textContent) || 0,
      sections: Number(tr.cells[2]?.textContent) || 0, values: [...tr.querySelectorAll("input[data-cs-place-course]")].map((i) => ({ value: Number(i.value), course: i.dataset.csPlaceCourse, block: i.dataset.csPlaceBlock })) }));
    const foot = [...table.querySelectorAll("tfoot td")].map((td) => td.textContent.trim());
    return { blocks, rows, foot: foot.slice(3, 3 + blocks.length), over: table.querySelectorAll("tfoot td.is-over").length, overTags: document.querySelectorAll("[data-cs-block-over]").length,
      pinNote: document.querySelector("#classSectionsPinNote")?.textContent.replace(/\s+/g, " ").trim() || "", conflicts: document.querySelector("#classSectionsCoConflicts")?.textContent.replace(/\s+/g, " ").trim() || "" };
  });
}
async function setCell(page, courseName, letter, value) {
  const input = page.getByLabel(`${courseName} ${letter}블록 분반 수`, { exact: true });
  await input.fill(String(value));
  await input.press("Tab");
  await sleep(300);
  await waitIdle(page); await sleep(400);
}
const roomOf = (sections) => { const m = new Map(); for (const x of sections) for (const st of x.students) m.set(`${st}|${x.subject}`, x.room); return m; };
function movedStudents(before, after) {
  const b = roomOf(before), a = roomOf(after);
  const moved = new Set();
  for (const [k, room] of b) if (a.get(k) !== room) moved.add(k.split("|")[0]);
  for (const k of a.keys()) if (!b.has(k)) moved.add(k.split("|")[0]);
  return moved;
}

// 같이 신청한 학생 수(하네스 계산): 그룹 과목만, 학생 신청 기준
function coCounts(sel, course) {
  const m = new Map();
  for (const [, list] of sel) {
    const subjects = new Set(list.map((x) => x.subject));
    if (!subjects.has(course)) continue;
    for (const s of subjects) if (s !== course) m.set(s, (m.get(s) || 0) + 1);
  }
  return m;
}

async function editScenario({ page, h, groupKey, sel, validate, dir }) {
  const out = {};
  await S6.selectGroup(page, groupKey);
  const exportModel = async (tag) => S6.modelFromExports(await S6.exportGroup(page, dir, `${groupKey.replace(/[:\s]/g, "_")}-${tag}`), { semester: groupKey.split(":")[1] });
  let table = await readPlacement(page);
  h.check(Boolean(table), "중요", "6단계", `${groupKey}: '직접 고치기' 과목 × 블록 분반 수 표(#classSectionsPlacementTable)가 없음`);
  if (!table) return out;
  out.table = { blocks: table.blocks.join(""), rows: table.rows.length, foot: table.foot };
  // 맨 아래 블록별 분반 = 열 합
  const sums = table.blocks.map((_, i) => table.rows.reduce((n, row) => n + (row.values[i]?.value || 0), 0));
  const footOk = table.foot.every((text, i) => Number(String(text).split("/")[0].trim()) === sums[i]);
  h.check(footOk && table.over === table.overTags, "중요", "6단계", `${groupKey}: 분반 수 표 맨 아래 '블록별 분반 / 최대'가 열 합과 다르거나 초과 표시 불일치`, { actual: { foot: table.foot, sums, over: table.over, overTags: table.overTags } });
  // 신청 수 = 하네스 계산
  const demand = new Map(); for (const [, list] of sel) for (const x of list) demand.set(x.subject, (demand.get(x.subject) || 0) + 1);
  const demandDiff = table.rows.filter((row) => (demand.get(bareTerm(row.name)) || 0) !== row.demand).map((row) => `${row.name}: 화면 ${row.demand} / 계산 ${demand.get(bareTerm(row.name)) || 0}`);
  h.check(!demandDiff.length, "중요", "6단계", `${groupKey}: 분반 수 표 '신청' 수가 학생 신청과 다름 ${demandDiff.length}과목`, { actual: demandDiff.slice(0, 5) });

  // 같이 신청한 학생
  const first = table.rows[0];
  await page.getByRole("button", { name: `${first.name} 같이 신청한 학생 보기`, exact: true }).click(); await sleep(400);
  const panel = await page.locator("#classSectionsCoPanel").innerText().catch(() => "");
  const shown = new Map([...panel.replace(/^.*?같이 신청한 학생:\s*/, "").matchAll(/([^,]+?)\s(\d+)명/g)].map((m) => [bareTerm(m[1].trim()), Number(m[2])]));
  const expected = coCounts(sel, bareTerm(first.name));
  const coDiff = [...new Set([...shown.keys(), ...expected.keys()])].filter((k) => (shown.get(k) || 0) !== (expected.get(k) || 0)).map((k) => `${k}: 화면 ${shown.get(k) || 0} / 계산 ${expected.get(k) || 0}`);
  out.co = { course: first.name, panel: panel.slice(0, 200), diff: coDiff.length };
  h.check(panel && !coDiff.length, "중요", "6단계", `${groupKey}: '${first.name} 같이 신청한 학생' 수가 학생 신청으로 센 수와 다름 ${coDiff.length}과목`, { actual: { panel: panel.slice(0, 200), diff: coDiff.slice(0, 5) } });
  await page.getByRole("button", { name: `${first.name} 같이 신청한 학생 보기`, exact: true }).click(); await sleep(300);

  // 칸 하나 바꾸기: 분반이 있는 블록 → 빈 블록으로 1개 옮김(먼저 늘리고 줄임)
  const before = await exportModel("edit-before");
  const pick = table.rows.map((row) => {
    const from = row.values.findIndex((v) => v.value > 0);
    const to = row.values.findIndex((v) => v.value === 0);
    return { row, from, to };
  }).find((x) => x.from >= 0 && x.to >= 0 && x.row.sections >= 2) || null;
  if (pick) {
    const name = pick.row.name, fromL = table.blocks[pick.from], toL = table.blocks[pick.to];
    await setCell(page, name, toL, 1);
    await setCell(page, name, fromL, pick.row.values[pick.from].value - 1);
    table = await readPlacement(page);
    const row = table.rows.find((x) => x.name === name);
    const files = await S6.exportGroup(page, dir, `${groupKey.replace(/[:\s]/g, "_")}-edit-cell`);
    const after = S6.modelFromExports(files, { semester: groupKey.split(":")[1] });
    const blockCount = (letter) => after.sections.filter((s) => bareTerm(s.subject) === bareTerm(name) && s.block === letter).length;
    const moved = movedStudents(before.sections, after.sections);
    const courseStudents = new Set([...sel].filter(([, list]) => list.some((x) => x.subject === bareTerm(name))).map(([k]) => k));
    const othersMoved = [...moved].filter((k) => !courseStudents.has(k));
    out.cell = { course: name, from: fromL, to: toL, table: row?.values.map((v) => v.value), excel: { [fromL]: blockCount(fromL), [toL]: blockCount(toL) }, moved: moved.size, othersMoved: othersMoved.length, groupStudents: sel.size,
      pinNote: table.pinNote.slice(0, 160), status: (await status(page)).slice(0, 200) };
    h.check(row?.values[pick.to].value === 1 && row?.values[pick.from].value === pick.row.values[pick.from].value - 1 && blockCount(toL) === 1 && blockCount(fromL) === pick.row.values[pick.from].value - 1,
      "중요", "6단계", `${groupKey}: 분반 수 표에서 '${name}' ${fromL}→${toL}블록으로 1개 옮겼는데 표·블록표 분반 수가 다름`, { actual: out.cell });
    h.check(/블록 고정 \d+개/.test(table.pinNote), "경미", "6단계", `${groupKey}: 칸을 고친 뒤 표 위 '블록 고정 n개' 안내가 없음`, { actual: table.pinNote });
    if (othersMoved.length > Math.max(5, sel.size * 0.5)) h.issue("경미", "6단계", `${groupKey}: 분반 수 칸 하나를 바꿨는데 그 과목을 신청하지 않은 학생 ${othersMoved.length}명(그룹 ${sel.size}명)의 분반도 바뀜`, { actual: out.cell });
    out.cell.validate = validate(files, await S6.readScreen(page), `${groupKey} (분반 수 칸 고친 뒤)`, { allowShownUnassigned: true });
  } else out.cell = { skipped: "분반 2개 이상이고 빈 블록이 있는 과목 없음" };

  // 같이 신청 충돌: 블록 하나에만 있는 과목 X와 같이 신청한 학생이 있는 과목 Y(분반 1개)를 X 블록으로 옮겼다가 되돌림
  table = await readPlacement(page);
  const single = table.rows.map((row) => ({ row, blocks: row.values.map((v, i) => (v.value > 0 ? i : -1)).filter((i) => i >= 0) }));
  let conflictCase = null;
  for (const x of single.filter((s) => s.blocks.length === 1)) {
    const co = coCounts(sel, bareTerm(x.row.name));
    const y = single.find((s) => s !== x && s.row.sections === 1 && s.blocks.length === 1 && s.blocks[0] !== x.blocks[0] && (co.get(bareTerm(s.row.name)) || 0) > 0);
    if (y) { conflictCase = { x, y, count: co.get(bareTerm(y.row.name)) }; break; }
  }
  if (conflictCase) {
    const { x, y, count } = conflictCase;
    const xL = table.blocks[x.blocks[0]], yL = table.blocks[y.blocks[0]];
    await setCell(page, y.row.name, xL, 1);
    await setCell(page, y.row.name, yL, 0);
    const t2 = await readPlacement(page);
    const ok = new RegExp(`${bareTerm(x.row.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${bareTerm(y.row.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t2.conflicts) && t2.conflicts.includes(`${count}명`);
    out.conflict = { x: x.row.name, y: y.row.name, block: xL, count, note: t2.conflicts.slice(0, 200) };
    h.check(ok, "중요", "6단계", `${groupKey}: 같은 블록 하나에만 있는 '${x.row.name}'·'${y.row.name}'(같이 신청 ${count}명)인데 같이 신청 충돌 안내(#classSectionsCoConflicts)가 없거나 인원이 다름`, { actual: out.conflict });
    await setCell(page, y.row.name, yL, 1);
    await setCell(page, y.row.name, xL, 0);
    const t3 = await readPlacement(page);
    out.conflict.afterRevert = t3.conflicts.slice(0, 120);
  } else out.conflict = { skipped: "블록 하나에만 있는 과목 쌍(같이 신청 > 0) 없음" };

  // 학생 한 명 옮기기 → 저장 → 그 학생만 바뀜
  const beforeMove = await exportModel("move-before");
  const candidates = [...new Set(beforeMove.sections.flatMap((s) => s.students))].sort().slice(0, 40);
  out.move = { tried: 0 };
  for (const key of candidates) {
    out.move.tried++;
    await page.locator("#classSectionsStudentSearch").fill(key); await page.locator("#classSectionsStudentSearch").press("Enter"); await sleep(400);
    const button = page.getByRole("button", { name: `${key} 옮기기`, exact: true });
    if (!(await button.count())) continue;
    await button.click();
    await page.locator("#classSectionsMoveDialog[open]").waitFor({ timeout: 10000 });
    const radios = await page.locator("#classSectionsMoveDialog input[type=radio][data-cs-move-course]").evaluateAll((els) => els.map((e) => ({ value: e.value, course: e.dataset.csMoveCourse, checked: e.checked, label: e.getAttribute("aria-label") })));
    const initialOk = /문제 없음/.test(await page.locator("#classSectionsMoveIssues").innerText());
    let picked = null;
    for (const r of radios.filter((x) => !x.checked && x.value)) {
      await page.locator(`#classSectionsMoveDialog input[type=radio][value="${r.value}"]`).check(); await sleep(150);
      const issues = await page.locator("#classSectionsMoveIssues").innerText();
      if (/문제 없음/.test(issues)) { picked = { ...r, issues: issues.slice(0, 80) }; break; }
      const current = radios.find((x) => x.course === r.course && x.checked);
      await page.locator(`#classSectionsMoveDialog input[type=radio][name="cs-move-${r.course}"][value="${current?.value || ""}"]`).check().catch(() => {}); await sleep(100);
    }
    if (!picked) { await page.locator("#classSectionsMoveClose").click(); await sleep(200); continue; }
    out.move.student = key; out.move.initialOk = initialOk; out.move.picked = picked.label;
    await page.locator("#classSectionsMoveSave").click();
    await page.locator("#classSectionsMoveDialog[open]").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    await sleep(300); await waitIdle(page); await sleep(500);
    out.move.status = (await status(page)).slice(0, 160);
    await page.locator("#classSectionsStudentSearch").fill(key); await page.locator("#classSectionsStudentSearch").press("Enter"); await sleep(400);
    const lookup = await page.locator(".cs-lookup").innerText().catch(() => "");
    const files = await S6.exportGroup(page, dir, `${groupKey.replace(/[:\s]/g, "_")}-move-after`);
    const after = S6.modelFromExports(files, { semester: groupKey.split(":")[1] });
    const moved = movedStudents(beforeMove.sections, after.sections);
    const pickedRoom = (picked.label.match(/^.+? (\S+) \d+\/\d+명/) || [])[1];
    const mine = after.sections.filter((s) => s.students.includes(key)).map((s) => s.room);
    out.move.after = mine; out.move.moved = [...moved].slice(0, 8); out.move.lookup = lookup.slice(0, 160);
    h.check(moved.has(key) && moved.size === 1 && (!pickedRoom || mine.includes(pickedRoom)), "중요", "6단계", `${groupKey}: 학생 옮기기(${key} → ${pickedRoom}) 저장 뒤 그 학생만 바뀌어야 하는데 바뀐 학생 ${moved.size}명`, { actual: out.move });
    h.check(/고정/.test(lookup), "경미", "6단계", `${groupKey}: 옮긴 학생(${key})이 학생 찾기에서 '고정'으로 표시되지 않음`, { actual: lookup.slice(0, 160) });
    out.move.validate = validate(files, await S6.readScreen(page), `${groupKey} (학생 옮기기 뒤)`, { allowShownUnassigned: true });
    break;
  }
  if (!out.move.student) h.issue("경미", "6단계", `${groupKey}: 학생 옮기기 창에서 문제 없이 옮길 칸을 찾지 못함(${out.move.tried}명 시도)`, { actual: out.move });

  // 배정 결과 엑셀: 내려받기 → 그대로 올리기(바뀐 학생 없음) → 3명 바꿔 올리기 → 확인 창 '바뀐 학생 3명' → 적용 → 다시 내려받아 확인
  const assignFile = await saveDownload(page, () => page.locator("#classSectionsAssignExport").click(), path.join(dir, `${groupKey.replace(/[:\s]/g, "_")}-assign.xlsx`));
  const sheets = S6.readXlsxAll(assignFile);
  out.assign = { sheets: sheets.map((s) => s.name) };
  h.check(sheets[0]?.name === "배정 결과" && sheets.some((s) => s.name === "과목별 블록") && sheets.some((s) => s.name === "안내"), "중요", "6단계", `${groupKey}: 배정 결과 엑셀 시트('배정 결과'·'과목별 블록'·'안내')가 다름`, { actual: out.assign.sheets });
  const rows = sheets[0].rows.map((r) => r.slice());
  const statusBefore = await status(page);
  await page.locator("#classSectionsAssignImport").setInputFiles(assignFile);
  for (let i = 0; i < 60 && (await status(page)) === statusBefore; i++) await sleep(250);
  await waitIdle(page).catch(() => {});
  out.assign.sameStatus = (await status(page)).slice(0, 120);
  h.check(/바뀐 학생이 없습니다/.test(out.assign.sameStatus), "중요", "6단계", `${groupKey}: 배정 결과 엑셀을 그대로 올렸는데 '바뀐 학생이 없습니다'가 아님`, { actual: out.assign.sameStatus });
  // 3명: 같은 블록 안 다른 번호(블록 겹침 없음)가 있는 과목의 학생, 서로 다른 학생
  const changes = [];
  const usedStudents = new Set([out.move.student].filter(Boolean));
  for (let c = 2; c < rows[0].length && changes.length < 3; c += 2) {
    const opened = [...String(rows[2][c] || "").matchAll(/([a-z])\(([\d·]+)\)/g)].map((m) => ({ letter: m[1], numbers: m[2].split("·").map(Number) })).filter((o) => o.numbers.length >= 2);
    if (!opened.length) continue;
    for (let r = 3; r < rows.length && changes.length < 3; r++) {
      const key = String(rows[r][0] || "");
      const o = opened.find((x) => x.letter === rows[r][c]);
      if (!o || usedStudents.has(key)) continue;
      const to = o.numbers.find((n) => n !== Number(rows[r][c + 1]));
      changes.push({ key, course: rows[0][c], letter: o.letter, from: Number(rows[r][c + 1]), to });
      rows[r][c + 1] = to;
      usedStudents.add(key);
      break; // 과목마다 한 명
    }
  }
  if (changes.length < 3) {
    // 과목이 적으면 같은 과목에서 더
    for (let c = 2; c < rows[0].length && changes.length < 3; c += 2) {
      const opened = [...String(rows[2][c] || "").matchAll(/([a-z])\(([\d·]+)\)/g)].map((m) => ({ letter: m[1], numbers: m[2].split("·").map(Number) })).filter((o) => o.numbers.length >= 2);
      for (let r = 3; r < rows.length && changes.length < 3 && opened.length; r++) {
        const key = String(rows[r][0] || ""); const o = opened.find((x) => x.letter === rows[r][c]);
        if (!o || usedStudents.has(key)) continue;
        const to = o.numbers.find((n) => n !== Number(rows[r][c + 1]));
        changes.push({ key, course: rows[0][c], letter: o.letter, from: Number(rows[r][c + 1]), to }); rows[r][c + 1] = to; usedStudents.add(key);
      }
    }
  }
  out.assign.changes = changes;
  if (changes.length) {
    const edited = path.join(dir, `${groupKey.replace(/[:\s]/g, "_")}-assign-edited.xlsx`);
    fs.writeFileSync(edited, writeXlsx([{ name: "배정 결과", rows }, { name: "과목별 블록", rows: sheets[1]?.rows || [] }]));
    const beforeImport = await exportModel("import-before");
    const dialogStart = Date.now();
    await page.locator("#classSectionsAssignImport").setInputFiles(edited);
    // 앱 확인 창(#appConfirmDialog)은 하네스가 기록하고 확인을 누른다 → 글자는 화면에서 바로 읽어 둔다
    let confirmText = "";
    for (let i = 0; i < 40 && !confirmText; i++) { confirmText = await page.locator("#appConfirmDialog[open] #appConfirmText").innerText({ timeout: 200 }).catch(() => ""); if (!confirmText) await sleep(100); }
    await sleep(600); await waitIdle(page); await sleep(600);
    out.assign.confirm = confirmText.slice(0, 200); out.assign.status = (await status(page)).slice(0, 200); out.assign.ms = Date.now() - dialogStart;
    const wantN = changes.length;
    h.check(new RegExp(`바뀐 학생 ${wantN}명`).test(confirmText || out.assign.status) && changes.every((x) => (confirmText || out.assign.status).includes(x.key) || wantN > 5), "중요", "6단계",
      `${groupKey}: 배정 결과 엑셀에서 ${wantN}명을 바꿔 올렸는데 확인 창에 '바뀐 학생 ${wantN}명'(학생 키)이 없음`, { actual: { confirm: confirmText.slice(0, 200), status: out.assign.status } });
    const again = S6.readXlsxAll(await saveDownload(page, () => page.locator("#classSectionsAssignExport").click(), path.join(dir, `${groupKey.replace(/[:\s]/g, "_")}-assign-after.xlsx`)))[0].rows;
    const byKey = new Map(again.slice(3).map((r) => [String(r[0]), r]));
    const col = new Map(); for (let c = 2; c < again[0].length; c += 2) col.set(again[0][c], c);
    const wrong = changes.filter((x) => { const r = byKey.get(x.key); const c = col.get(x.course); return !r || r[c] !== x.letter || Number(r[c + 1]) !== x.to; });
    const changedRows = again.slice(3).filter((r) => { const o = rows.find((x) => String(x[0]) === String(r[0])); return o && JSON.stringify(o.slice(2)) !== JSON.stringify(r.slice(2)); }).map((r) => r[0]);
    const files = await S6.exportGroup(page, dir, `${groupKey.replace(/[:\s]/g, "_")}-import-after`);
    const after = S6.modelFromExports(files, { semester: groupKey.split(":")[1] });
    const moved = movedStudents(beforeImport.sections, after.sections);
    out.assign.wrong = wrong; out.assign.otherRowsDiffer = changedRows.slice(0, 8); out.assign.moved = moved.size;
    h.check(!wrong.length, "중요", "6단계", `${groupKey}: 배정 결과 엑셀 적용 뒤 다시 내려받은 엑셀에서 바꾼 학생 ${wrong.length}명이 고친 분반이 아님`, { actual: { wrong, changes } });
    h.check(!changedRows.length && moved.size === changes.length, "중요", "6단계", `${groupKey}: 배정 결과 엑셀 적용 뒤 바꾸지 않은 학생도 바뀜(엑셀 ${changedRows.length}줄·명렬표 이동 ${moved.size}명, 바꾼 학생 ${changes.length}명)`, { actual: { changedRows: changedRows.slice(0, 5), moved: [...moved].slice(0, 8) } });
    out.assign.validate = validate(files, await S6.readScreen(page), `${groupKey} (배정 결과 엑셀 올린 뒤)`, { allowShownUnassigned: true });
  } else h.issue("경미", "6단계", `${groupKey}: 배정 결과 엑셀에서 바꿀 학생(같은 블록에 분반 2개 이상인 과목)을 찾지 못함`, { actual: rows.slice(0, 3) });
  return out;
}

// ---- 출력물 ----
function attendanceInfo(sheet) {
  const headerIndex = sheet.rows.findIndex((row) => row[0] === "순서");
  const header = sheet.rows[headerIndex] || [];
  return { title: sheet.rows[0]?.[0] || "", labels: [sheet.rows[1]?.[0], sheet.rows[2]?.[0], sheet.rows[3]?.[0]], times: String(sheet.rows[1]?.[2] || ""), room: String(sheet.rows[2]?.[2] || ""), teacher: String(sheet.rows[3]?.[2] || ""),
    header, dateCols: header.filter((v) => /^월\s+일$/.test(String(v))).length, students: sheet.rows.slice(headerIndex + 1).filter((row) => row.some((v) => v !== "" && v !== null)).map((row) => row.slice(0, 5)) };
}

async function attendanceScenario({ page, h, groupKey, dir, classMap, grade }) {
  await S6.selectGroup(page, groupKey);
  const files = await S6.exportGroup(page, dir, `${groupKey.replace(/[:\s]/g, "_")}-print`);
  const model = S6.modelFromExports(files, { semester: groupKey.split(":")[1] });
  const rooms = await readRooms(page);
  const file = await saveDownload(page, () => page.locator("#classSectionsAttendanceGroup").click(), path.join(dir, `${groupKey.replace(/[:\s]/g, "_")}-attendance.xlsx`));
  const sheets = S6.readXlsxAll(file);
  const out = { sheets: sheets.length, sections: model.sections.length, bad: [] };
  h.check(sheets.length === model.sections.length, "중요", "6단계", `${groupKey}: 출석부 시트 수 ${sheets.length} ≠ 분반 수 ${model.sections.length}`, { actual: sheets.map((s) => s.name).slice(0, 10) });
  for (const sheet of sheets) {
    const info = attendanceInfo(sheet);
    const sec = model.sections.find((s) => s.room === sheet.name);
    const card = rooms.sections.find((s) => s.room === sheet.name);
    if (!sec) { out.bad.push({ sheet: sheet.name, why: "분반 없음" }); continue; }
    const want = sec.students.map((k) => { const m = classMap.get(k); return m ? `${m.classroom}-${m.number}` : `${k.split("-")[1]}-${k.split("-")[2]}`; }).sort();
    const got = info.students.map((r) => `${r[2] ?? ""}-${r[3] ?? ""}`).sort();
    const problems = [];
    if (info.title !== `${sec.subject}(${sec.room}) 출석부` && info.title !== `${bareTerm(sec.subject)}(${sec.room}) 출석부`) problems.push(`제목 '${info.title}'`);
    if (compact(info.labels.join(",")) !== "교시,교실,교사") problems.push(`위 3줄 '${info.labels.join(",")}'`);
    if (!info.times.startsWith(`${sec.block}블록`) || !sec.times.every((t) => compact(info.times).includes(t))) problems.push(`교시 '${info.times}' (블록 ${sec.block} ${sec.times.join(",")})`);
    if (card && info.room !== card.roomLabel) problems.push(`교실 '${info.room}' (화면 ${card.roomLabel})`);
    if (sec.teacher && info.teacher !== sec.teacher) problems.push(`교사 '${info.teacher}' (블록표 ${sec.teacher})`);
    if (info.dateCols !== 17) problems.push(`날짜 칸 ${info.dateCols}`);
    if (JSON.stringify(want) !== JSON.stringify(got)) problems.push(`학생 ${got.length}명 ≠ 명렬표 ${want.length}명(반·번호 다름 ${want.filter((x, i) => got[i] !== x).length})`);
    if (problems.length) out.bad.push({ sheet: sheet.name, problems });
  }
  out.sample = sheets[0] ? attendanceInfo(sheets[0]) : null;
  if (out.sample) out.sample.students = out.sample.students.slice(0, 3);
  h.check(!out.bad.length, "중요", "6단계", `${groupKey}: 출석부 시트 ${out.bad.length}개가 명렬표·블록표·화면과 다름(제목·위 3줄·인원·반 번호·날짜 칸)`, { actual: out.bad.slice(0, 5) });
  // 날짜 칸 수 설정
  await page.locator("#classSectionsAttendanceDays").fill("12"); await page.locator("#classSectionsAttendanceDays").press("Tab"); await sleep(500);
  const s12 = S6.readXlsxAll(await saveDownload(page, () => page.locator("#classSectionsAttendanceGroup").click(), path.join(dir, `${groupKey.replace(/[:\s]/g, "_")}-attendance12.xlsx`)));
  out.days12 = s12[0] ? attendanceInfo(s12[0]).dateCols : null;
  h.check(out.days12 === 12, "중요", "6단계", `${groupKey}: 출석부 날짜 칸 수를 12로 바꿨는데 출석부 날짜 칸 ${out.days12}개`, { actual: out.days12 });
  await page.locator("#classSectionsAttendanceDays").fill("17"); await page.locator("#classSectionsAttendanceDays").press("Tab"); await sleep(400);
  return out;
}

// 학생 시간표: 같은 현 학년·학기 모든 그룹의 배정(명렬표·블록표·화면 교실)으로 기대 칸을 만들어 인쇄 묶음과 대조
async function timetableScenario({ page, h, info, groupKey, dir, fixed }) {
  const retakeOf = new Map();
  const g0 = info.find((g) => g.key === groupKey);
  const grade = groupKey[0], semester = groupKey.split(":")[1];
  const groupsHere = info.filter((g) => g.key[0] === grade && g.key.split(":")[1] === semester);
  const expected = new Map(); // 학생 → [{course, slot, room, teacher}]
  for (const g of groupsHere) {
    await S6.selectGroup(page, g.key);
    const rooms = await readRooms(page);
    if (!rooms.sections.length) continue;
    const files = await S6.exportGroup(page, dir, `${g.key.replace(/[:\s]/g, "_")}-tt`);
    const model = S6.modelFromExports(files, { semester });
    // 재신청 표시 기대: '재신청·미배정' 시트에서 사유가 '학급 단위 과목(그 반은 이동)'만이 아닌 학생(시간표는 그 사유를 재신청으로 보이지 않음)
    const retakeSheet = files.rosters.find((x) => /^재신청/.test(x.name));
    for (const r of retakeSheet ? retakeSheet.rows.slice(2) : []) {
      if (!/^\d+-\d+-\d+$/.test(String(r[0] || ""))) continue;
      const reasons = String(r[3] || "").split(", ").filter((x) => x && x !== "학급 단위 과목(그 반은 이동)");
      if (reasons.length) retakeOf.set(String(r[0]), (retakeOf.get(String(r[0])) || 0) + 1);
    }
    for (const s of model.sections) {
      const card = rooms.sections.find((x) => x.room === s.room);
      for (const st of s.students) for (const slot of s.times) expected.set(st, [...(expected.get(st) || []), { course: bareTerm(s.subject), slot, room: card?.roomLabel || "", teacher: s.teacher || "" }]);
    }
  }
  await S6.selectGroup(page, groupKey);
  const out = {};
  // 미리 보기
  await page.locator("#classSectionsStudentSearch").fill(`${grade}-1-1`); await page.locator("#classSectionsStudentSearch").press("Enter"); await sleep(500);
  const preview = await page.locator("#classSectionsTimetablePreview").innerText().catch(() => "");
  out.preview = preview.slice(0, 160);
  h.check(new RegExp(`[12]학기 · 현 ${grade}학년 → ${Number(grade) + 1}학년`).test(preview), "중요", "6단계", `${groupKey}: 학생 찾기 '${grade}-1-1' → 시간표 미리 보기가 없거나 제목에 '현 ${grade}학년 → ${Number(grade) + 1}학년'이 없음`, { actual: preview.slice(0, 160) });
  // 1반 인쇄(한 장에 2명)
  await page.locator("#classSectionsTimetableClass").selectOption("1"); await sleep(300);
  await page.locator("#classSectionsTimetablePerPage").selectOption("2"); await sleep(300);
  await page.evaluate(() => { window.__prints = window.__prints || 0; });
  await page.locator("#classSectionsTimetablePrint").click(); await sleep(1000);
  const printed = await page.evaluate(() => {
    const pages = [...document.querySelectorAll("#printBatch .cs-tt-page")];
    const tables = [...document.querySelectorAll("#printBatch .cs-tt")].map((el) => {
      const days = [...el.querySelectorAll(".cs-tt-grid thead th")].slice(1).map((th) => th.textContent.trim());
      const cells = [];
      [...el.querySelectorAll(".cs-tt-grid tbody tr")].forEach((tr, p) => [...tr.querySelectorAll("td")].forEach((td, d) => cells.push({ slot: `${days[d]}${p + 1}`, kind: td.dataset.kind, lines: [...td.querySelectorAll("span")].map((s) => s.textContent.trim()) })));
      return { key: el.dataset.student, cells, retake: Number(el.querySelector(".cs-tt-retake")?.dataset.retake || 0), list: [...el.querySelectorAll(".cs-tt-list li")].map((li) => li.textContent) };
    });
    return { prints: window.__prints || 0, pages: pages.length, per: pages[0]?.dataset.per || "", tables };
  });
  const wantKeys = [...expected.keys()].filter((k) => k.split("-")[1] === "1");
  const gotKeys = printed.tables.map((t) => t.key);
  out.print = { prints: printed.prints, pages: printed.pages, students: gotKeys.length, expectedStudents: wantKeys.length };
  h.check(printed.prints >= 1 && printed.pages === Math.ceil(gotKeys.length / 2) && gotKeys.every((k) => k.startsWith(`${grade}-1-`)) && wantKeys.every((k) => gotKeys.includes(k)), "중요", "6단계",
    `${groupKey}: 학생 시간표 1반 인쇄(한 장에 2명) — 쪽 ${printed.pages}·학생 ${gotKeys.length}명(배정 있는 1반 학생 ${wantKeys.length}명)`, { actual: { ...out.print, missing: wantKeys.filter((k) => !gotKeys.includes(k)).slice(0, 5) } });
  const bad = [];
  let cellsChecked = 0;
  for (const t of printed.tables) {
    const want = expected.get(t.key) || [];
    const bySlot = new Map(t.cells.map((c) => [c.slot, c]));
    const problems = [];
    for (const e of want) {
      const cell = bySlot.get(e.slot);
      cellsChecked++;
      const text = (cell?.lines || []).join(" | ");
      if (!cell || cell.kind !== "move" || !compact(text).includes(compact(e.course)) || !e.room || /교실 미정/.test(text) || !text.includes(e.room) || (e.teacher && !text.includes(e.teacher))) problems.push(`${e.slot}: 기대 ${e.course}/${e.room}/${e.teacher} · 칸 ${cell?.kind || "-"} '${text}'`);
    }
    const moveCells = t.cells.filter((c) => c.kind === "move").length;
    if (moveCells !== new Set(want.map((e) => e.slot)).size) problems.push(`이동 칸 ${moveCells} ≠ 배정 시간 ${new Set(want.map((e) => e.slot)).size}`);
    if (t.cells.some((c) => c.kind === "clash")) problems.push(`겹친 칸 ${t.cells.filter((c) => c.kind === "clash").map((c) => c.slot).join(",")}`);
    if (t.cells.length && fixed.some((slot) => bySlot.get(slot)?.kind !== "fixed")) problems.push(`고정 시간 ${fixed.join("·")} 칸이 '고정'이 아님(${fixed.map((s) => bySlot.get(s)?.kind).join(",")})`);
    const wantRetake = retakeOf.get(t.key) || 0;
    if (Boolean(wantRetake) !== Boolean(t.retake)) problems.push(`재신청 표시 ${t.retake} (기대 ${wantRetake})`);
    if (problems.length) bad.push({ key: t.key, problems: problems.slice(0, 4) });
  }
  out.cells = { checked: cellsChecked, badStudents: bad.length, fixedLabel: printed.tables[0]?.cells.find((c) => c.slot === fixed[0])?.lines.join("") || "" };
  h.check(!bad.length, "중요", "6단계", `${groupKey}: 학생 시간표 칸이 배정 결과(과목·교실·교사)·고정 시간·재신청 표시와 다름 — 학생 ${bad.length}명`, { actual: bad.slice(0, 4) });
  // 엑셀
  const tt = S6.readXlsxAll(await saveDownload(page, () => page.locator("#classSectionsTimetableExcel").click(), path.join(dir, `${groupKey.replace(/[:\s]/g, "_")}-timetable.xlsx`)));
  const titles = tt.reduce((n, s) => n + s.rows.filter((row) => /이동수업 시간표$/.test(String(row[0] || ""))).length, 0);
  out.excel = { sheets: tt.map((s) => s.name), titles };
  h.check(titles === gotKeys.length, "중요", "6단계", `${groupKey}: 학생 시간표 엑셀 학생 수 ${titles} ≠ 인쇄 학생 수 ${gotKeys.length}`, { actual: out.excel });
  // 빈 칸 '학급 수업'
  await page.locator("#classSectionsTimetableFill").selectOption("학급 수업"); await sleep(400);
  await page.locator("#classSectionsStudentSearch").fill(`${grade}-1-1`); await page.locator("#classSectionsStudentSearch").press("Enter"); await sleep(400);
  const filled = await page.locator('#classSectionsTimetablePreview td[data-kind="empty"]').allInnerTexts().catch(() => []);
  out.fill = { empty: filled.length, sample: filled[0] || "" };
  h.check(!filled.length || filled.every((t) => /학급 수업/.test(t)), "경미", "6단계", `${groupKey}: 시간표 빈 칸을 '학급 수업'으로 골랐는데 빈 칸 글자가 다름`, { actual: out.fill });
  await page.locator("#classSectionsTimetableFill").selectOption(""); await sleep(300);
  await page.locator("#classSectionsTimetableClass").selectOption(""); await sleep(200);
  await page.locator("#classSectionsStudentSearch").fill(""); await page.locator("#classSectionsStudentSearch").press("Enter"); await sleep(300);
  return out;
}

// 특별실(과학실 2곳)을 두 학년 같은 학기 과학 과목에 지정 → 다시 계산 → 같은 시간 같은 특별실 0
async function specialRoomScenario({ page, h, info, semester = "1" }) {
  const out = {};
  await S6.selectGroup(page, info.find((g) => g.key.split(":")[1] === semester).key);
  await page.getByRole("button", { name: "교사·시간 설정" }).click(); await sleep(300);
  const roomsInput = page.getByLabel("특별실 수(이름=수)", { exact: true });
  const prev = await roomsInput.inputValue();
  out.prevRooms = prev;
  const next = [prev.replace(/과학실=\d+/, "").replace(/^[,\s]+|[,\s]+$/g, ""), "과학실=2"].filter(Boolean).join(", ");
  await roomsInput.fill(next); await roomsInput.press("Tab"); await sleep(400);
  const names = page.getByLabel("과학실 이름(쉼표로 구분)", { exact: true });
  if (await names.count()) { await names.fill("물리실, 화학실"); await names.press("Tab"); await sleep(400); }
  await page.getByRole("button", { name: "닫기" }).first().click(); await sleep(300);
  out.assigned = [];
  const groupsHere = info.filter((g) => g.key.split(":")[1] === semester);
  for (const g of groupsHere) {
    await S6.selectGroup(page, g.key);
    const course = await page.locator("[data-cs-room]").evaluateAll((els) => els.map((el) => el.dataset.csRoom).find((name) => /물리|화학|생명|지구|과학|세포|역학|양자|물질/.test(name)) || "");
    if (!course) continue;
    await page.getByLabel(`${course} 특별실`, { exact: true }).fill("과학실"); await page.getByLabel(`${course} 특별실`, { exact: true }).press("Tab"); await sleep(400);
    const r = await S6.solve(page);
    const rooms = await readRooms(page);
    const mine = rooms.sections.filter((s) => s.course === bareTerm(course));
    const perBlock = new Map(); for (const s of mine) perBlock.set(s.letter, (perBlock.get(s.letter) || 0) + 1);
    out.assigned.push({ group: g.key, course, feasible: r.feasible, rooms: mine.map((s) => `${s.letter}:${s.roomLabel}`), perBlock: Object.fromEntries(perBlock), errors: rooms.errors, errorList: rooms.errorList });
    const fits = [...perBlock.values()].every((n) => n <= 2);
    h.check(!fits || mine.every((s) => /^(물리실|화학실)$/.test(s.roomLabel)), "경미", "6단계", `${g.key}: '${course}' 특별실(과학실 2곳) 지정 뒤 분반 교실이 물리실·화학실이 아님(블록당 2개 이하)`, { actual: out.assigned.at(-1) });
  }
  out.rooms = await checkRoomsAll({ page, h, info: groupsHere, label: " (특별실 지정 뒤)" });
  return out;
}

module.exports = { readRooms, checkRoomsAll, pinRoom, pinKept, editScenario, attendanceScenario, timetableScenario, specialRoomScenario, readPlacement };
