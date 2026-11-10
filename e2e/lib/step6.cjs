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
    const unassigned = (document.querySelector("#classSectionsUnassigned summary")?.textContent || document.querySelector('section[aria-label="편성 결과"] details summary')?.textContent || "").match(/미배정 (\d+)건/);
    const unassignedStudents = [...new Set([...document.querySelectorAll("#classSectionsUnassigned tbody tr")].map((tr) => (tr.cells[0]?.textContent.match(/\d+-\d+-\d+/) || [""])[0]).filter(Boolean))];
    const metricStudents = Number((document.querySelector("#classSectionsMetrics")?.textContent.match(/미배정 (\d+)명/) || [])[1] || 0);
    return { sections, unassignedRows: unassigned ? Number(unassigned[1]) : 0, unassignedStudents, metricStudents, stale: !!document.querySelector("#classSectionsStale"),
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
    if (/^학급 단위/.test(sheet.name) || /^재신청/.test(sheet.name)) continue; // '학급 단위 과목'·'학급 단위 N반' 시트(이동 분반 아님)
    const head = sheet.rows[0]?.[0] || "";
    const room = head.split(" (")[0];
    const students = sheet.rows.slice(2).filter((r) => r[1]).map((r) => r[1]);
    const info = byRoom.get(room) || {};
    sections.push({ id: room, room, semester, subject: String(info.course || head.match(/\((.*)\)/)?.[1] || "").replace(/\s*[(（]\s*[12]\s*학기\s*[)）]\s*$/, ""), block: info.block, times: info.times || [], teacher: info.teacher,
      capacity: info.capacity, students, title: head, titleCount: Number((head.match(/(\d+)명$/) || [])[1]) });
  }
  return { sections, byRoom };
}

// 11차: 명렬표 첫 시트 '재신청·미배정'(1행 안내, 2행 머리글, 3행부터 학생) · 나이스 '확인 필요' 시트(2행 안내, 3행 머리글)
// 학생 수 = 화면 미배정 학생 수(폐강 재신청만인 학생은 화면 미배정 표에 없으므로 따로 셈), 안내 문장 n명 = 행 수, 두 파일 같은 학생.
const RETAKE_HEADER = ["현 학년-반-번호", "성명", "빠진 과목", "사유"];
function retakeFrom(rows, start) {
  const note = String(rows[start]?.[0] || "");
  const header = (rows[start + 1] || []).slice(0, 4).map(compact);
  const list = [];
  for (const r of rows.slice(start + 2)) { if (!/^\d+-\d+-\d+$/.test(String(r[0] || ""))) break; list.push({ key: String(r[0]), name: r[1] || "", courses: String(r[2] || ""), reasons: String(r[3] || "") }); }
  return { note, headerOk: RETAKE_HEADER.every((name, i) => header[i] === compact(name)), list, noteCount: Number((note.match(/(\d+)명/) || [])[1]) };
}
function checkRetakeSheets({ h, label, files, screen }) {
  const sheet = files.rosters.find((x) => /^재신청/.test(x.name));
  const firstOk = !sheet || files.rosters[0] === sheet;
  const screenSet = new Set(screen.unassignedStudents || []);
  const roster = sheet ? retakeFrom(sheet.rows, 0) : { list: [], headerOk: true, note: "", noteCount: 0 };
  const neisSheet = files.neis.find((x) => x.name === "확인 필요");
  const neisStart = neisSheet ? neisSheet.rows.findIndex((r, i) => i > 0 && /^재신청이 필요한 학생/.test(String(r[0] || ""))) : -1;
  const neis = neisStart > 0 ? retakeFrom(neisSheet.rows, neisStart) : { list: [], headerOk: true, note: "", noteCount: 0 };
  const onlyClosed = roster.list.filter((x) => x.reasons && x.reasons.split(", ").every((r) => r === "폐강")).map((x) => x.key);
  const sheetNonClosed = roster.list.map((x) => x.key).filter((k) => !onlyClosed.includes(k));
  const missingOnSheet = [...screenSet].filter((k) => !roster.list.some((x) => x.key === k));
  const extraOnSheet = sheetNonClosed.filter((k) => !screenSet.has(k));
  const neisDiff = roster.list.length !== neis.list.length || roster.list.some((x, i) => neis.list[i]?.key !== x.key || neis.list[i]?.courses !== x.courses);
  const result = { sheet: Boolean(sheet), students: roster.list.length, screen: screenSet.size, metric: screen.metricStudents, onlyClosed: onlyClosed.length, neis: neis.list.length };
  const ok = firstOk && roster.headerOk && neis.headerOk && (!sheet || roster.noteCount === roster.list.length) && !missingOnSheet.length && !extraOnSheet.length
    && (screen.metricStudents === undefined || sheetNonClosed.length === screen.metricStudents || screenSet.size === screen.metricStudents) && !neisDiff && (Boolean(sheet) === Boolean(roster.list.length));
  h.check(ok, "중요", "6단계", `${label}: '재신청·미배정' 시트 학생 ${roster.list.length}명(폐강만 ${onlyClosed.length})·화면 미배정 학생 ${screenSet.size}명(요약 ${screen.metricStudents}명)·나이스 확인 필요 ${neis.list.length}명이 맞지 않음`,
    { actual: { ...result, firstOk, headerOk: [roster.headerOk, neis.headerOk], note: roster.note.slice(0, 120), noteCount: roster.noteCount, missingOnSheet: missingOnSheet.slice(0, 5), extraOnSheet: extraOnSheet.slice(0, 5), neisDiff } });
  return result;
}

// 그룹 하나의 결과 검증(엑셀 기준) + 화면 대조
function checkGroup({ h, label, files, screen, selections, semester, courseNames, classUnitCourses = [], unitCourseOf = new Map(), expectedUnassigned = 0 }) {
  const { sections, byRoom } = modelFromExports(files, { semester });
  const pick = Number((label.match(/택(\d+)/) || [])[1]) || 1;
  const movingOf = new Map();
  for (const sec of sections) for (const st of sec.students) { if (!movingOf.has(st)) movingOf.set(st, []); movingOf.get(st).push(sec.subject); }
  const sel = new Map();
  const explained = new Set(); // 학급 단위 반 학생이 이동 칸(택n−1)에 못 넣은 희망 과목 = '희망과 다름'(오류 아님)
  const unitCountWrong = [];
  for (const [student, list] of selections) {
    let mine = list.filter((x) => courseNames.includes(x.subject) && (!x.semester || x.semester === semester) && !classUnitCourses.includes(x.subject)).map((x) => ({ subject: x.subject, semester }));
    const unitCourse = unitCourseOf.get(student);
    if (unitCourse !== undefined) {
      // 학급 단위 반 학생: 그 반 과목 1개는 학급 단위 행으로 받고, 나머지 택n−1은 이동 분반(신청 과목 중에서)
      mine = mine.filter((x) => x.subject !== unitCourse);
      const moving = movingOf.get(student) || [];
      if (moving.length !== pick - 1) unitCountWrong.push({ student, unitCourse, moving });
      for (const x of mine) if (!moving.includes(x.subject)) explained.add(`${student}|${x.subject}`);
    }
    if (mine.length) sel.set(student, mine);
  }
  const check = Timetable.checkTimetable({ sections, selections: sel, unassignedExplained: explained });
  if (unitCourseOf.size) h.check(!unitCountWrong.length, "중요", "6단계", `${label}: 학급 단위 반 학생의 이동 분반 수가 택${pick}−1이 아님 ${unitCountWrong.length}명`, { actual: unitCountWrong.slice(0, 5) });
  const p = check.problems;
  const result = { sections: sections.length, students: sel.size, unitStudents: unitCourseOf.size, unitWish: explained.size, unitCountWrong: unitCountWrong.length, problems: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.length])) };
  h.check(!p.unassigned.length || screen.unassignedRows === p.unassigned.length, "중요", "6단계", `${label}: 미배정 ${p.unassigned.length}건(화면 미배정 표 ${screen.unassignedRows}건)`, { actual: p.unassigned.slice(0, 8) });
  if (p.unassigned.length && p.unassigned.length !== expectedUnassigned) h.issue("경미", "6단계", `${label}: 미배정 ${p.unassigned.length}건(화면에 사유 표시)`, { actual: p.unassigned.slice(0, 8) });
  result.retake = checkRetakeSheets({ h, label, files, screen });
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
  // 두 학기 과목 꼬리표 '(1학기)/(2학기)'가 나이스 개설과목·강의실 이름·명렬표에 들어가면 안 됨
  const TAG = /[(（]\s*[12]\s*학기\s*[)）]|[12]학기\)/;
  const taggedRows = neis.slice(2).filter((r) => TAG.test(String(r[4])) || TAG.test(String(r[5]))).map((r) => `${r[4]} / ${r[5]}`);
  const taggedRooms = sections.filter((x) => TAG.test(x.room) || TAG.test(x.title || "")).map((x) => x.room);
  if (taggedRows.length || taggedRooms.length) h.issue("중요", "6단계", `${label}: 두 학기 과목 꼬리표 '(n학기)'가 나이스 개설과목·강의실 이름·명렬표에 들어감(${taggedRows.length}줄) [수정 대기]`, { actual: { rows: [...new Set(taggedRows)].slice(0, 4), rooms: taggedRooms.slice(0, 4) }, pending: true });
  const head2 = (neis[1] || []).map(compact);
  const headOk = compact(neis[0]?.[0]) === "개설과목" && compact(neis[0]?.[6]) === "편성학생" && Timetable.NEIS_COLUMNS.every((name, i) => head2[i] === compact(name)) && /참고/.test(neis[1]?.[10] || "");
  h.check(headOk, "중요", "6단계", `${label}: 나이스 편성 엑셀 머리글(2줄·10열+참고 열)이 다름`, { actual: neis.slice(0, 2) });
  const rows = neis.slice(2).filter((r) => r.some(Boolean));
  const seen = new Set(); const dups = []; const exported = new Map(); const roomMismatch = [];
  const roomsOf = new Map(); for (const s of sections) for (const st of s.students) roomsOf.set(`${st}|${s.subject}`, s.room);
  for (const r of rows) {
    const subject = String(r[4]).replace(/\(\d+(?:\.\d+)?\)$/, "").replace(/^\([^)]*\)/, "").replace(/\s*[(（]\s*[12]\s*학기\s*[)）]\s*$/, "");
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
