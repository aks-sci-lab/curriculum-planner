"use strict";
// 6단계(분반 편성) 하네스: 화면 클릭으로 편성하고, 내려받은 블록표·분반 명렬표·나이스 엑셀을 직접 읽어 검증한다.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Timetable = require("./timetable-checks.cjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DAYS = ["월", "화", "수", "목", "금"];
// 나이스 학급 단위 행의 개설강의실: '3(3학년 3반)'
const CLASS_UNIT_ROOM = /^\d+\(\d학년 \d+반\)$/;
const compact = (v) => String(v ?? "").replace(/\s+/g, "");

function readXlsxAll(file) {
  const out = execFileSync("python3", ["-I", "-c", `import json,sys,openpyxl
wb=openpyxl.load_workbook(sys.argv[1])
print(json.dumps([{"name":ws.title,"rows":[[("" if c.value is None else (str(int(c.value)) if isinstance(c.value,float) and c.value.is_integer() else str(c.value))) for c in r] for r in ws.iter_rows()],"merges":[str(m) for m in ws.merged_cells.ranges]} for ws in wb.worksheets], ensure_ascii=False))`, file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}
const parseSlots = (textValue) => [...String(textValue || "").matchAll(/([월화수목금토])\s*(\d+)/g)].map((m) => `${m[1]}${m[2]}`);

async function open6(page) {
  const t0 = Date.now();
  await page.locator('[data-workflow-step="8"]').first().click();
  await page.locator("#workflowStep8Panel").waitFor({ state: "visible", timeout: 30000 });
  await sleep(300);
  return Date.now() - t0;
}
async function groups(page) {
  return page.locator("[data-cs-group]").evaluateAll((els) => els.map((e) => ({ key: e.dataset.csGroup, text: e.innerText.replace(/\s+/g, " ") })));
}
async function selectGroup(page, key) {
  await page.locator(`[data-cs-group="${key}"]`).click();
  await page.waitForFunction((k) => document.querySelector(`[data-cs-group="${CSS.escape(k)}"]`)?.getAttribute("aria-pressed") === "true", key, { timeout: 10000 });
  await sleep(200);
}
async function solve(page, button = "#classSectionsSolve") {
  const t0 = Date.now();
  await page.locator(button).click();
  await sleep(200);
  await page.waitForFunction(() => !document.querySelector("#classSectionsSolve")?.disabled, null, { timeout: 180000, polling: 200 });
  await sleep(200);
  const summary = page.locator("#classSectionsSummary");
  const has = await summary.count();
  return { ms: Date.now() - t0, feasible: has ? (await summary.getAttribute("data-feasible")) === "true" : null, summary: has ? await summary.innerText() : "",
    status: await page.locator("#classSectionsStatus").innerText().catch(() => ""), note: await page.locator('section[aria-label="편성 결과"] p.cs-note').first().innerText().catch(() => "") };
}
async function readScreen(page) {
  return page.evaluate(() => {
    const sections = [];
    for (const block of document.querySelectorAll(".cs-blocks .cs-block")) {
      const head = block.querySelector("h5");
      const letter = (head?.childNodes[0]?.textContent || "").trim().replace(/블록$/, "");
      const times = head?.querySelector("em")?.textContent || "";
      for (const li of block.querySelectorAll("li.cs-section")) {
        const [size, capacity] = (li.querySelector(".cs-size")?.textContent || "").match(/\d+/g) || [];
        // 5차부터 카드 굵은 글자는 '물리학 ②', 나이스 강의실 이름은 .cs-neis('나이스 a물리학2')
        // 6·7차: 나이스 강의실 이름·과목·인원·정원은 data-room·data-course·data-size·data-capacity(strong은 읽기 쉬운 이름)
        const neis = li.dataset.room || li.querySelector(".cs-neis")?.textContent.replace(/^\s*나이스\s*/, "").trim();
        const label = li.querySelector("strong")?.textContent.trim() || "";
        sections.push({ id: li.dataset.sectionId, room: neis || label, label, course: li.dataset.course || (li.dataset.sectionId || "").replace(/#\d+$/, ""), letter, times,
          size: Number(li.dataset.size ?? size), capacity: Number(li.dataset.capacity ?? capacity), teacher: li.querySelector("select option")?.textContent || "" });
      }
    }
    const unassigned = (document.querySelector('section[aria-label="편성 결과"] details summary')?.textContent || "").match(/미배정 (\d+)건/);
    return { sections, unassignedRows: unassigned ? Number(unassigned[1]) : 0, stale: !!document.querySelector("#classSectionsStale"),
      header: document.querySelector('section[aria-label="편성 결과"] h4')?.textContent.replace(/\s+/g, " ") || "",
      classUnit: [...document.querySelectorAll("[data-cs-unit-room]")].map((e) => [e.getAttribute("data-cs-unit-room"), e.options[e.selectedIndex]?.textContent || ""]),
      badge: document.querySelector("#classSectionsRoundBadge")?.textContent || "",
      classesLine: document.querySelector("#classSectionsClassesLine")?.textContent || "", classMapLine: document.querySelector("#classSectionsClassMapLine")?.textContent || "",
      homeroomWarn: !!document.querySelector("#classSectionsHomeroomWarn"), metrics: document.querySelector("#classSectionsMetrics")?.textContent || "",
      blockMax: document.querySelector('[aria-label="블록당 최대 분반 수"]')?.value || document.querySelector('[aria-label="블록당 최대 분반 수"]')?.placeholder || "" };
  });
}
async function download(page, name, saveAs) {
  const event = page.waitForEvent("download", { timeout: 30000 });
  await page.getByRole("button", { name, exact: true }).click();
  const file = await (await event).path();
  fs.mkdirSync(path.dirname(saveAs), { recursive: true });
  fs.copyFileSync(file, saveAs);
  return saveAs;
}
async function exportGroup(page, dir, tag) {
  return {
    blocks: readXlsxAll(await download(page, "블록표 엑셀", path.join(dir, `${tag}-blocks.xlsx`))),
    rosters: readXlsxAll(await download(page, "분반 명렬표 엑셀", path.join(dir, `${tag}-rosters.xlsx`))),
    neis: readXlsxAll(await download(page, "나이스 편성 엑셀", path.join(dir, `${tag}-neis.xlsx`))),
  };
}
// 엑셀 → 검증 모델(분반: 강의실·블록·시간·정원·교사·학생)
function modelFromExports(files, { semester }) {
  const blockSheet = files.blocks[0].rows;
  const byRoom = new Map();
  for (const row of blockSheet.slice(2)) {
    if (!/블록$/.test(row[0] || "")) continue;
    byRoom.set(row[2], { block: row[0].replace(/블록$/, ""), times: parseSlots(row[1]), course: row[3], size: Number(row[4]), capacity: Number(row[5]), teacher: row[6] || "" });
  }
  const sections = [];
  for (const sheet of files.rosters) {
    if (sheet.name === "학급 단위 과목") continue; // 맨 뒤 안내 시트(분반 아님)
    const head = sheet.rows[0]?.[0] || "";
    const room = head.split(" (")[0];
    const students = sheet.rows.slice(2).filter((r) => r[1]).map((r) => r[1]);
    const info = byRoom.get(room) || {};
    sections.push({ id: room, room, semester, subject: info.course || head.match(/\((.*)\)/)?.[1] || "", block: info.block, times: info.times || [], teacher: info.teacher,
      capacity: info.capacity, students, title: head, titleCount: Number((head.match(/(\d+)명$/) || [])[1]) });
  }
  return { sections, byRoom };
}

// 그룹 하나의 결과 검증(엑셀 기준) + 화면 대조
function checkGroup({ h, label, files, screen, selections, semester, courseNames, classUnitCourses = [] }) {
  const { sections, byRoom } = modelFromExports(files, { semester });
  const sel = new Map();
  for (const [student, list] of selections) {
    const mine = list.filter((x) => courseNames.includes(x.subject) && !classUnitCourses.includes(x.subject)).map((x) => ({ subject: x.subject, semester }));
    if (mine.length) sel.set(student, mine);
  }
  const check = Timetable.checkTimetable({ sections, selections: sel });
  const p = check.problems;
  const result = { sections: sections.length, students: sel.size, problems: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.length])) };
  h.check(!p.unassigned.length || screen.unassignedRows === p.unassigned.length, "중요", "6단계", `${label}: 미배정 ${p.unassigned.length}건(화면 미배정 표 ${screen.unassignedRows}건)`, { actual: p.unassigned.slice(0, 8) });
  if (p.unassigned.length) h.issue("경미", "6단계", `${label}: 미배정 ${p.unassigned.length}건(화면에 사유 표시)`, { actual: p.unassigned.slice(0, 8) });
  h.check(!p.blockConflict.length, "치명", "6단계", `${label}: 한 학생이 같은 블록에 두 분반 ${p.blockConflict.length}건`, { actual: p.blockConflict.slice(0, 5) });
  h.check(!p.duplicate.length, "중요", "6단계", `${label}: 한 학생이 같은 과목 여러 분반 ${p.duplicate.length}건`, { actual: p.duplicate.slice(0, 5) });
  h.check(!p.overCapacity.length, "중요", "6단계", `${label}: 정원 초과 ${p.overCapacity.length}건`, { actual: p.overCapacity.slice(0, 5) });
  h.check(!p.unknownSection.length, "중요", "6단계", `${label}: 신청하지 않은 과목에 배정 ${p.unknownSection.length}건`, { actual: p.unknownSection.slice(0, 5) });
  // 명렬표 인원 = 블록표 인원 = 화면
  const screenByRoom = new Map(screen.sections.map((s) => [s.room, s]));
  const sizeDiff = sections.filter((s) => s.students.length !== s.titleCount || s.students.length !== byRoom.get(s.room)?.size || s.students.length !== screenByRoom.get(s.room)?.size)
    .map((s) => ({ room: s.room, roster: s.students.length, title: s.titleCount, blocks: byRoom.get(s.room)?.size, screen: screenByRoom.get(s.room)?.size }));
  h.check(!sizeDiff.length && sections.length === screen.sections.length, "중요", "6단계", `${label}: 분반 명렬표 인원·블록표·화면 인원이 다름`, { actual: { sizeDiff: sizeDiff.slice(0, 5), roster: sections.length, screen: screen.sections.length } });
  // 개설강의실 이름: 블록 문자 + 과목명(띄어쓰기 없음) + 번호(그 과목이 한 블록에 2개 이상이면 그 과목 모든 분반에 번호)
  const badNames = [];
  const byCourse = new Map();
  for (const s of sections) { if (!byCourse.has(s.subject)) byCourse.set(s.subject, []); byCourse.get(s.subject).push(s); }
  for (const [course, list] of byCourse) {
    const perBlock = new Map(); for (const s of list) perBlock.set(s.block, (perBlock.get(s.block) || 0) + 1);
    const numbered = [...perBlock.values()].some((n) => n > 1);
    for (const s of list) {
      const m = s.room.match(new RegExp(`^${s.block}${compact(course).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d*)$`));
      if (!m || (numbered ? !m[1] : m[1])) badNames.push({ room: s.room, block: s.block, course, numbered });
    }
  }
  const dupRooms = sections.map((s) => s.room).filter((r, i, a) => a.indexOf(r) !== i);
  h.check(!badNames.length && !dupRooms.length, "중요", "6단계", `${label}: 개설강의실 이름 규칙 위반 ${badNames.length}건·중복 ${dupRooms.length}건`, { actual: { badNames: badNames.slice(0, 5), dupRooms } });
  // 나이스 편성 엑셀: 2줄 머리글·10열 + 참고 열, 학생·과목당 한 줄, 최종 선택과 같음, 강의실 이름 = 명렬표
  const neis = files.neis[0].rows;
  const head2 = (neis[1] || []).map(compact);
  const headOk = compact(neis[0]?.[0]) === "개설과목" && compact(neis[0]?.[6]) === "편성학생" && Timetable.NEIS_COLUMNS.every((name, i) => head2[i] === compact(name)) && /참고/.test(neis[1]?.[10] || "");
  h.check(headOk, "중요", "6단계", `${label}: 나이스 편성 엑셀 머리글(2줄·10열+참고 열)이 다름`, { actual: neis.slice(0, 2) });
  const rows = neis.slice(2).filter((r) => r.some(Boolean));
  const seen = new Set(); const dups = []; const exported = new Map(); const roomMismatch = [];
  const roomsOf = new Map(); for (const s of sections) for (const st of s.students) roomsOf.set(`${st}|${s.subject}`, s.room);
  for (const r of rows) {
    const subject = String(r[4]).replace(/\(\d+(?:\.\d+)?\)$/, "").replace(/^\([^)]*\)/, "");
    if (classUnitCourses.includes(subject) || CLASS_UNIT_ROOM.test(String(r[5]))) continue; // 학급 단위 행은 run.cjs에서 담임반 배정과 대조
    const key = `${r[10]}|${subject}`;
    if (seen.has(key)) dups.push(key); seen.add(key);
    if (!exported.has(r[10])) exported.set(r[10], []);
    exported.get(r[10]).push(subject);
    if (roomsOf.get(key) !== r[5]) roomMismatch.push({ key, neis: r[5], roster: roomsOf.get(key) });
  }
  const missing = [];
  for (const [student, list] of sel) {
    const got = (exported.get(student) || []).slice().sort().join(",");
    const assigned = list.filter((x) => roomsOf.has(`${student}|${x.subject}`)).map((x) => x.subject).sort().join(",");
    if (got !== assigned) missing.push({ student, got, assigned });
  }
  h.check(!dups.length, "중요", "6단계", `${label}: 나이스 엑셀 한 학생·과목 여러 줄 ${dups.length}건`, { actual: dups.slice(0, 5) });
  h.check(!missing.length && !roomMismatch.length, "중요", "6단계", `${label}: 나이스 엑셀 행이 분반 명렬표와 다름(학생 ${missing.length}명, 강의실 ${roomMismatch.length}줄)`, { actual: { missing: missing.slice(0, 3), roomMismatch: roomMismatch.slice(0, 3) } });
  result.neisRows = rows.length;
  return { result, sections };
}

// 여러 그룹에 걸친 시간 검증: 같은 학생·같은 교사가 같은 시간에 두 분반, 교사 불가 시간, 모든 교사 고정 시간(창체)
function checkAcross({ h, sectionsByGroup, unavailable, fixed }) {
  const studentSlot = new Map(); const teacherSlot = new Map();
  const conflicts = { student: [], teacher: [], unavailable: [], fixed: [] };
  for (const [group, sections] of Object.entries(sectionsByGroup)) {
    for (const s of sections) {
      for (const slot of s.times) {
        const sem = s.semester;
        if (fixed.includes(slot)) conflicts.fixed.push(`${group} ${s.room} ${slot}`);
        if (s.teacher) {
          const k = `${sem}|${s.teacher}|${slot}`;
          if (teacherSlot.has(k)) conflicts.teacher.push(`${k}: ${teacherSlot.get(k)} / ${group} ${s.room}`); else teacherSlot.set(k, `${group} ${s.room}`);
          if ((unavailable[s.teacher] || []).includes(slot)) conflicts.unavailable.push(`${s.teacher} ${slot} ${group} ${s.room}`);
        }
        for (const st of s.students) {
          const k = `${sem}|${st}|${slot}`;
          if (studentSlot.has(k) && studentSlot.get(k) !== `${group} ${s.room}`) conflicts.student.push(`${k}: ${studentSlot.get(k)} / ${group} ${s.room}`); else studentSlot.set(k, `${group} ${s.room}`);
        }
      }
    }
  }
  h.check(!conflicts.teacher.length, "중요", "6단계", `같은 교사가 같은 시간에 두 분반 ${conflicts.teacher.length}건(학년 간 포함)`, { actual: conflicts.teacher.slice(0, 8) });
  h.check(!conflicts.unavailable.length, "중요", "6단계", `교사 불가 시간 위반 ${conflicts.unavailable.length}건`, { actual: conflicts.unavailable.slice(0, 8) });
  h.check(!conflicts.fixed.length, "중요", "6단계", `창체 고정 시간(금6·7)에 분반 배정 ${conflicts.fixed.length}건`, { actual: conflicts.fixed.slice(0, 8) });
  h.check(!conflicts.student.length, "중요", "6단계", `같은 학생이 같은 시간에 두 분반(그룹 간) ${conflicts.student.length}건`, { actual: conflicts.student.slice(0, 8) });
  return Object.fromEntries(Object.entries(conflicts).map(([k, v]) => [k, v.length]));
}

// 블록 시간: 요일을 번갈아 도는 순서(월1,화1,…,금1,월2,…)로 학년·학기마다 차례로 나눠 준다. 같은 학년·학기 그룹끼리는 겹치지 않고,
// 2학년은 6칸 뒤에서 시작해 3학년 블록과 일부 같은 시간이 되게 한다(학년 간 교사 겹침 시험). 금6·7(창체)은 쓰지 않는다.
const SPREAD = [1, 2, 3, 4, 5, 6, 7].flatMap((p) => DAYS.map((day) => `${day}${p}`)).filter((s) => s !== "금6" && s !== "금7");
function planBlockTimes(groupsInfo) {
  const out = {};
  const cursor = {};
  for (const g of groupsInfo) {
    const k = `${g.grade}|${g.semester}`;
    if (cursor[k] === undefined) cursor[k] = g.grade === "2" ? 6 : 0;
    out[g.key] = [];
    for (let b = 0; b < g.blocks; b++) {
      if (cursor[k] + g.credit > SPREAD.length) throw new Error(`블록 시간이 모자람: ${g.key}`);
      out[g.key].push(SPREAD.slice(cursor[k], cursor[k] + g.credit).join(","));
      cursor[k] += g.credit;
    }
  }
  return out;
}

// 블록 시간 추천 → 적용 → 이 학기 전 학년 함께 다시 계산(지금 고른 그룹의 학기)
async function recommendAndSolveSemester(page) {
  const out = {};
  const button = page.locator("#classSectionsRecommendTimes");
  if (!(await button.isVisible().catch(() => false))) { await page.getByText("블록별로 다르게 · 블록 시간(요일·교시)").click(); await sleep(250); }
  let t0 = Date.now();
  await button.click();
  await page.locator("#classSectionsTimesProposal").waitFor({ timeout: 120000 });
  out.recommendMs = Date.now() - t0;
  out.proposal = (await page.locator("#classSectionsTimesProposal").innerText()).replace(/\s+/g, " ").slice(0, 400);
  out.proposalCells = await page.locator("#classSectionsTimesProposal [data-cs-proposal]").evaluateAll((els) => els.map((e) => [e.dataset.csProposal, e.value ?? e.textContent]));
  await page.locator("#classSectionsApplyTimes").click(); await sleep(400);
  t0 = Date.now();
  const together = page.locator("#classSectionsSolveSemester");
  if (await together.count()) {
    await together.click(); await sleep(200);
    await page.waitForFunction(() => !document.querySelector("#classSectionsSolve")?.disabled, null, { timeout: 300000, polling: 250 });
    out.solveMs = Date.now() - t0;
    out.status = await page.locator("#classSectionsStatus").innerText().catch(() => "");
  } else out.status = "(전 학년 함께 다시 계산 단추 없음)";
  return out;
}

module.exports = { CLASS_UNIT_ROOM, recommendAndSolveSemester, open6, groups, selectGroup, solve, readScreen, exportGroup, modelFromExports, checkGroup, checkAcross, planBlockTimes, readXlsxAll, parseSlots, SPREAD };
