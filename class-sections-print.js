"use strict";
// 6단계 분반 편성 출력물: ④ 분반 → 교실 배정(화면·설정), ② 이동 출석부(엑셀), ③ 학생 개인 이동수업 시간표(미리 보기·인쇄·엑셀).
// class-sections.js(순수 계산, 교실 배정 classSectionsAssignRooms) · class-sections-view.js(입력 모으기·결과 화면) 뒤에 로드한다.
// 위쪽은 순수 계산(DOM·state 없음, 테스트에서 vm으로 올림) → `// ---- 앱 연결 ----` 아래 화면 연결.
// 개인정보: 저장하는 것은 교실 직접 고른 값(분반 id → 교실 이름)과 출력 설정뿐. 성명은 내보낼 때 차수 자료에서 읽어 파일·인쇄에만 쓴다.

var CLASS_SECTIONS_PRINT_DEFAULTS = { attendanceDays: 17, timetableFill: "", perPage: 1, handoutPer: 4 };

function classSectionsPrintText(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function classSectionsPrintEsc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// '월:1'·'월1'·{day,period} → { day, period }
function classSectionsPrintTime(time) {
  if (time && typeof time === "object") return Number(time.period) > 0 && time.day ? { day: String(time.day), period: Number(time.period) } : null;
  const match = String(time || "").replace(/\s+/g, "").match(/^([월화수목금토일])[:\-]?(\d{1,2})$/);
  return match ? { day: match[1], period: Number(match[2]) } : null;
}

function classSectionsPrintTimesText(times) {
  return (times || []).map(classSectionsPrintTime).filter(Boolean).map((time) => `${time.day}${time.period}`).join(", ");
}

function classSectionsPrintCircled(number) {
  const n = Number(number) || 0;
  return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : n ? `(${n})` : "";
}

function classSectionsPrintFilePart(value) {
  return classSectionsPrintText(value).replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "");
}

// ---- ② 이동 출석부 ----
// info: { year, semester, grade(현 학년), targetGrade, courseName, roomName(나이스 강의실), blockLetter, times, roomLabel, teacherName,
//   basis: "map"(내년 반 배정표) | "same"(그대로 올라감, 번호 모름) | "none"(내년 반 모름),
//   students: [{ key(현학년-반-번호), classroom, number(내년 반·번호, basis none이면 비움), name }] }
// 반환: createWorkbookBlob 시트 하나. 위 3줄 교시·교실·교사, 제목 '과목명(강의실) 출석부', 날짜 칸 days개 + 비고. A4 세로, 제목 줄 반복, 한 장에 맞춤.
function classSectionsAttendanceSheet(info, options = {}) {
  const days = Math.max(1, Math.min(40, Math.floor(Number(options.days) || CLASS_SECTIONS_PRINT_DEFAULTS.attendanceDays)));
  const basis = info.basis || "none";
  const known = basis !== "none";
  const students = (info.students || []).slice();
  const order = (student) => {
    const [, c, n] = String(student.key || "").split("-");
    return known ? [Number(student.classroom) || 999, Number(student.number) || 999, Number(c) || 0, Number(n) || 0] : [Number(c) || 999, Number(n) || 999, 0, 0];
  };
  students.sort((a, b) => { const x = order(a); const y = order(b); for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] - y[i]; return String(a.key).localeCompare(String(b.key)); });
  const cols = 5 + days + 1;
  const last = classSectionsPrintColumn(cols - 1);
  const title = `${info.courseName}(${info.roomName}) 출석부`;
  const rows = [];
  const merges = [`A1:${last}1`];
  const heights = [];
  rows.push([{ v: title, s: 1 }]);
  heights[0] = 30;
  const infoRow = (label, value) => {
    const row = [{ v: label, s: 2 }, { v: "", s: 2 }, { v: value, s: 3 }];
    for (let c = 3; c < cols; c += 1) row.push({ v: "", s: 3 });
    rows.push(row);
    const r = rows.length;
    merges.push(`A${r}:B${r}`, `C${r}:${last}${r}`);
  };
  infoRow("교시", `${info.blockLetter ? `${info.blockLetter}블록 · ` : ""}${classSectionsPrintTimesText(info.times) || "시간 미정"}`);
  infoRow("교실", info.roomLabel || "미정");
  infoRow("교사", info.teacherName || "미정");
  const subtitle = `${info.year}학년도 ${info.semester}학기 · 현 ${info.grade}학년 → ${info.targetGrade}학년 · ${students.length}명${options.subtitle ? ` · ${options.subtitle}` : ""}`;
  rows.push([{ v: subtitle, s: 8 }]);
  merges.push(`A${rows.length}:${last}${rows.length}`);
  let warning = "";
  if (basis === "none") warning = `내년 반·번호를 몰라 현 ${info.grade}학년 반·번호로 적었습니다. 내년 반 배정표를 올린 뒤 다시 내려받으세요.`;
  else if (basis === "same") warning = "진급 때 반이 그대로 올라가 내년 반은 지금 반, 번호는 비웠습니다(진급 때 번호를 다시 매길 수 있음).";
  if (warning) { rows.push([{ v: `⚠ ${warning}`, s: 8 }]); merges.push(`A${rows.length}:${last}${rows.length}`); }
  const header = [{ v: "순서", s: 2 }, { v: known ? "학년" : "현 학년", s: 2 }, { v: known ? "반" : "현 반", s: 2 }, { v: known ? "번호" : "현 번호", s: 2 }, { v: "성명", s: 2 }];
  for (let d = 0; d < days; d += 1) header.push({ v: "월  일", s: 2 });
  header.push({ v: "비고", s: 2 });
  rows.push(header);
  const headerRow = rows.length;
  heights[headerRow - 1] = 30;
  students.forEach((student, index) => {
    const [g, c, n] = String(student.key || "").split("-");
    const cells = known
      ? [index + 1, Number(info.targetGrade) || info.targetGrade, classSectionsPrintNumber(student.classroom), classSectionsPrintNumber(student.number)]
      : [index + 1, Number(g) || g, classSectionsPrintNumber(c), classSectionsPrintNumber(n)];
    const row = cells.map((v) => ({ v, s: 4 }));
    row.push({ v: student.name || "", s: 4 });
    for (let d = 0; d < days; d += 1) row.push({ v: "", s: 4 });
    row.push({ v: "", s: 4 });
    rows.push(row);
    heights[rows.length - 1] = 19;
  });
  const widths = [5, 5, 4.5, 5, 9, ...Array(days).fill(3.6), 9];
  return { name: options.sheetName || info.roomName || info.courseName, rows, merges, widths, heights, orientation: "portrait", fitToHeight: 1,
    printTitles: `$1:$${headerRow}`, freeze: `A${headerRow + 1}`, headerRow, studentCount: students.length, studentKeys: students.map((student) => student.key) };
}

function classSectionsPrintNumber(value) {
  const text = classSectionsPrintText(value);
  return /^\d+$/.test(text) ? Number(text) : text;
}

function classSectionsPrintColumn(index) {
  let name = "";
  let n = index + 1;
  while (n > 0) { const r = (n - 1) % 26; name = String.fromCharCode(65 + r) + name; n = Math.floor((n - 1) / 26); }
  return name;
}

// 분반 하나 파일 이름: '2027_1학기_물리학(a물리학1)_2학년5반_교사명.xlsx'
function classSectionsAttendanceFileName(info) {
  const room = classSectionsPrintFilePart(info.roomLabel) || "교실미정";
  const teacher = classSectionsPrintFilePart(info.teacherName) || "교사미정";
  return `${info.year}_${info.semester}학기_${classSectionsPrintFilePart(info.courseName)}(${classSectionsPrintFilePart(info.roomName)})_${room}_${teacher}.xlsx`;
}

// 출석부 묶음(저장 단위). 종류마다 함수 하나 → 나중에 '담임반별'(그 반 학생들이 듣는 이동 분반 명단) 같은 묶음을 한 줄로 더할 수 있다.
// infos는 classSectionsAttendanceSheet의 info에 groupKey·groupLabel·groupCategory·sectionId·teacherId가 붙은 목록. 반환: [{ name(파일 이름), sheets }]
//   group    이 그룹: 그룹 하나 = 파일 하나, 분반마다 시트
//   file     전체 파일: 그 학기 모든 그룹·분반을 한 파일에(맨 앞 '목록' 시트 + 분반마다 시트, 시트 이름 = 강의실 이름)
//   sections 학급별 파일: 분반(이동 학급)마다 파일 하나(zip으로 묶음)
//   teacher  교사별: 교사마다 파일 하나(zip)
var CLASS_SECTIONS_ATTENDANCE_BUNDLES = {
  group: (infos, options) => [{ name: `${infos[0].year}_${infos[0].targetGrade || ""}학년_${infos[0].semester}학기_${classSectionsPrintFilePart(infos[0].groupCategory || "")}_출석부.xlsx`,
    sheets: infos.map((info) => classSectionsAttendanceSheet(info, options)) }],
  file: (infos, options) => {
    const names = classSectionsAttendanceSheetNames(infos);
    return [{ name: `${infos[0].year}_${infos[0].semester}학기_이동출석부_전체.xlsx`,
      sheets: [classSectionsAttendanceListSheet(infos, names), ...infos.map((info, index) => classSectionsAttendanceSheet(info, { ...options, sheetName: names[index] }))] }];
  },
  sections: (infos, options) => infos.map((info) => ({ name: classSectionsAttendanceFileName(info), sheets: [classSectionsAttendanceSheet(info, options)] })),
  teacher: (infos, options) => {
    const byTeacher = new Map();
    for (const info of infos) {
      const key = info.teacherName || "";
      if (!byTeacher.has(key)) byTeacher.set(key, []);
      byTeacher.get(key).push(info);
    }
    const names = [...byTeacher.keys()].sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || a.localeCompare(b, "ko"));
    return names.map((teacher) => ({ name: `${infos[0].year}_${infos[0].semester}학기_출석부_${classSectionsPrintFilePart(teacher) || "교사미정"}.xlsx`,
      sheets: byTeacher.get(teacher).map((info) => classSectionsAttendanceSheet(info, { ...options, sheetName: `${info.targetGrade}-${info.semester} ${info.roomName}` })) }));
  }
};
CLASS_SECTIONS_ATTENDANCE_BUNDLES.all = CLASS_SECTIONS_ATTENDANCE_BUNDLES.sections; // 예전 이름

function classSectionsAttendanceBundles(infos, kind, options = {}) {
  if (!infos.length) return [];
  return (CLASS_SECTIONS_ATTENDANCE_BUNDLES[kind] || CLASS_SECTIONS_ATTENDANCE_BUNDLES.group)(infos, options);
}

// 전체 파일 시트 이름 = 강의실 이름. 다른 학년 그룹에 같은 강의실 이름이 있으면 '3학년 a물리학' 처럼 학년을 붙인다(엑셀 31자, 겹침 없음).
function classSectionsAttendanceSheetNames(infos) {
  const count = new Map();
  for (const info of infos) count.set(info.roomName, (count.get(info.roomName) || 0) + 1);
  const used = new Set(["목록"]);
  return infos.map((info) => {
    let base = String(count.get(info.roomName) > 1 ? `${info.targetGrade}학년 ${info.roomName}` : info.roomName).replace(/[\[\]:*?\/\\]/g, " ").slice(0, 31);
    let name = base;
    for (let n = 2; used.has(name); n += 1) name = `${base.slice(0, 27)}(${n})`;
    used.add(name);
    return name;
  });
}

// 전체 파일 맨 앞 '목록' 시트: 분반마다 한 줄(시트 이름·학년·학기·그룹·과목·블록 시간·교실·교사·인원).
function classSectionsAttendanceListSheet(infos, names) {
  const head = ["번호", "시트(강의실)", "수업 학년", "학기", "그룹", "과목", "교시", "교실", "교사", "인원"];
  const rows = [[{ v: `${infos[0].year}학년도 ${infos[0].semester}학기 이동 출석부 목록 (분반 ${infos.length}개)`, s: 1 }], head.map((v) => ({ v, s: 2 }))];
  infos.forEach((info, index) => rows.push([index + 1, names[index], `${info.targetGrade}학년(현 ${info.grade})`, `${info.semester}학기`, info.groupCategory || "", info.courseName,
    `${info.blockLetter}블록 ${classSectionsPrintTimesText(info.times)}`.trim(), info.roomLabel || "미정", info.teacherName || "미정", (info.students || []).length].map((v, c) => ({ v, s: c === 5 ? 3 : 4 }))));
  return { name: "목록", rows, merges: ["A1:J1"], widths: [6, 22, 12, 7, 14, 22, 18, 14, 12, 7], freeze: "A3", orientation: "portrait", printTitles: "$1:$2" };
}

// 출석부 시트 모델 → 화면 표(엑셀과 같은 칸·같은 글자). 가로 병합은 colspan으로, 머리글 줄까지는 <thead>(인쇄 때 쪽마다 반복).
function classSectionsSheetHtml(sheet, options = {}) {
  const esc = classSectionsPrintEsc;
  const spans = new Map();
  const covered = new Set();
  for (const ref of sheet.merges || []) {
    const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref);
    if (!match) continue;
    const col = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const r = Number(match[2]) - 1;
    const c1 = col(match[1]);
    const c2 = col(match[3]);
    spans.set(`${r}:${c1}`, c2 - c1 + 1);
    for (let c = c1 + 1; c <= c2; c += 1) covered.add(`${r}:${c}`);
  }
  const width = Math.max(...(sheet.rows || []).map((row) => (row || []).length), 1);
  const kind = (s) => (s === 1 ? "title" : s === 2 ? "head" : s === 8 ? "note" : s === 3 ? "left" : "cell");
  const headerRows = sheet.headerRow || 0;
  const highlight = new Set(options.highlight || []);
  const rowHtml = (row, r) => {
    const cells = [];
    for (let c = 0; c < width; c += 1) {
      if (covered.has(`${r}:${c}`)) continue;
      const cell = row?.[c];
      const spec = cell && typeof cell === "object" ? cell : { v: cell };
      const span = spans.get(`${r}:${c}`);
      const tag = spec.s === 2 ? "th" : "td";
      cells.push(`<${tag}${span ? ` colspan="${span}"` : ""} data-kind="${kind(spec.s)}">${esc(spec.v ?? "")}</${tag}>`);
    }
    const key = options.keys?.[r - headerRows];
    return `<tr${key ? ` data-student="${esc(key)}"${highlight.has(key) ? ' class="is-found"' : ""}` : ""}>${cells.join("")}</tr>`;
  };
  const rows = sheet.rows || [];
  const cols = (sheet.widths || []).map((w) => `<col style="width:${(Number(w) || 4) * 7}px">`).join("");
  return `<table class="cs-att-table" data-sheet="${esc(sheet.name || "")}"><colgroup>${cols}</colgroup><thead>${rows.slice(0, headerRows).map((row, r) => rowHtml(row, r)).join("")}</thead>
    <tbody>${rows.slice(headerRows).map((row, r) => rowHtml(row, r + headerRows)).join("")}</tbody></table>`;
}

// ---- 담임학급별 출석부 ----
// 기준 반: 내년 반(배정표 또는 '그대로 올라감')을 알면 내년 반, 모르면 현재 반(경고). 학년·반마다 한 묶음.
// roster: [{ key(현학년-반-번호), grade, targetGrade, classroom(내년 반, 모르면 ""), number(내년 번호), name, basis }]
// extras: { 학생키: { unit: [학급 단위 과목], retake: [{ courseName, reason }] } }
// 반환: [{ id, grade, targetGrade, room, basis, label, students: [{ key, number, name, cells: {열키: 칸}, unit, retake }],
//   columns: [{ key, groupKey, groupCategory, blockLetter, times }], sections: [info(그 반 학생만, sectionTotal = 분반 전체 인원)] }]
function classSectionsHomerooms(infos, roster, extras = {}) {
  const homerooms = new Map();
  const homeroomOf = new Map();
  const year = infos[0]?.year || "";
  const semester = infos[0]?.semester || "";
  for (const student of roster || []) {
    const [, curClass, curNumber] = String(student.key).split("-");
    const known = student.basis !== "none" && classSectionsPrintText(student.classroom);
    const room = known ? classSectionsPrintText(student.classroom) : curClass;
    const id = `${student.grade}|${known ? "next" : "now"}|${room}`;
    if (!homerooms.has(id)) {
      homerooms.set(id, { id, year, semester, grade: String(student.grade), targetGrade: String(student.targetGrade), room, basis: known ? student.basis : "none",
        label: known ? `내년 ${student.targetGrade}학년 ${room}반` : `현 ${student.grade}학년 ${room}반`, students: [], columns: [], sections: [] });
    }
    const homeroom = homerooms.get(id);
    homeroom.students.push({ key: student.key, number: known ? classSectionsPrintText(student.number) : curNumber, name: student.name || "", cells: {},
      unit: (extras[student.key]?.unit || []).slice(), retake: (extras[student.key]?.retake || []).slice(), unsubmitted: Boolean(student.unsubmitted) });
    homeroomOf.set(student.key, homeroom);
  }
  const groupOrder = new Map();
  for (const info of infos) if (!groupOrder.has(info.groupKey)) groupOrder.set(info.groupKey, groupOrder.size);
  for (const info of infos) {
    const colKey = `${info.groupKey}|${info.blockId || info.blockLetter}`;
    const byRoom = new Map();
    for (const member of info.students || []) {
      const homeroom = homeroomOf.get(member.key);
      if (!homeroom) continue;
      const student = homeroom.students.find((item) => item.key === member.key);
      student.cells[colKey] = { courseName: info.courseName, roomName: info.roomName, roomLabel: info.roomLabel || "", teacher: info.teacherName || "" };
      if (!homeroom.columns.some((col) => col.key === colKey)) {
        homeroom.columns.push({ key: colKey, groupKey: info.groupKey, groupCategory: info.groupCategory || "", blockLetter: info.blockLetter, times: info.times || [], order: groupOrder.get(info.groupKey) });
      }
      if (!byRoom.has(homeroom)) byRoom.set(homeroom, []);
      byRoom.get(homeroom).push(member);
    }
    for (const [homeroom, members] of byRoom) homeroom.sections.push({ ...info, students: members, sectionTotal: (info.students || []).length });
  }
  const num = (value) => (/^\d+$/.test(String(value)) ? Number(value) : 999);
  const list = [...homerooms.values()];
  for (const homeroom of list) {
    homeroom.unsubmitted = homeroom.students.filter((student) => student.unsubmitted).length;
    homeroom.students.sort((a, b) => num(a.number) - num(b.number) || a.key.localeCompare(b.key, "ko", { numeric: true }));
    homeroom.columns.sort((a, b) => a.order - b.order || String(a.blockLetter).localeCompare(String(b.blockLetter)));
  }
  return list.sort((a, b) => a.grade.localeCompare(b.grade) || (a.basis === "none") - (b.basis === "none") || num(a.room) - num(b.room) || a.room.localeCompare(b.room, "ko"));
}

// ① 그 반 '이동수업 현황' 시트: 행 = 학생, 열 = 블록(그룹·블록·시간), 칸 = 과목 강의실 / 교실 · 교사. A4 가로.
// 인쇄는 칸 글자 9pt 이상 + 쪽 나눔(classSectionsHomeroomStatusPlan): 학생을 번호순으로 고르게 나눠 1~3쪽, 쪽마다 제목·머리글 반복.
// 엑셀은 같은 나눔을 수동 쪽 나눔(rowBreaks) + 배율(scale, 90% 이상 = 10pt 글자가 9pt 이상) + 머리글 행 반복 + 오른쪽 위 '쪽/전체'로.
// 칸 줄 수는 열 폭과 글자 수로 어림한다(한글 1.95, 그 밖 1.1, 띄어쓰기 0.6 폭 단위; 폭 단위 = 엑셀 열 너비 1, 90% 배율 기준).
var CLASS_SECTIONS_HR_PRINT = { maxUnits: 160, fixed: [5, 11, 9], unitWidth: 10, retakeWidth: 16, emptyWidth: 6.5, minBlock: 10, maxBlock: 40,
  pagePt: 597, linePt: 13, padPt: 3, titlePt: 24, notePt: 16, maxPages: 3, minScale: 90, pageWidthPt: 805, pageHeightPt: 538, fontPt: 9 };

function classSectionsTextUnits(text) {
  let units = 0;
  for (const ch of String(text ?? "")) units += /[ᄀ-ᇿ㄰-㆏가-힯一-鿿①-⓿·○]/.test(ch) ? 1.95 : ch === " " ? 0.6 : 1.1;
  return units;
}

function classSectionsTextLines(text, width) {
  const avail = Math.max(1, (Number(width) || 1) - 0.8) * 0.92;
  return String(text ?? "").split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(classSectionsTextUnits(line) / avail)), 0);
}

function classSectionsHomeroomStatusLayout(homeroom) {
  const C = CLASS_SECTIONS_HR_PRINT;
  const emptyUnit = !homeroom.students.some((student) => student.unit.length);
  const emptyRetake = !homeroom.students.some((student) => student.retake.length || student.unsubmitted);
  const unitWidth = emptyUnit ? C.emptyWidth : C.unitWidth;
  const retakeWidth = emptyRetake ? C.emptyWidth : C.retakeWidth;
  const fixed = C.fixed.reduce((a, b) => a + b, 0) + unitWidth + retakeWidth;
  const k = homeroom.columns.length;
  const blockWidth = Math.max(C.minBlock, Math.min(C.maxBlock, Math.floor((C.maxUnits - fixed) / Math.max(1, k))));
  const widths = [...C.fixed, ...homeroom.columns.map(() => blockWidth), unitWidth, retakeWidth];
  const head = ["번호", "현 학년-반-번호", "성명", ...homeroom.columns.map((col) => `${col.groupCategory} ${col.blockLetter}블록\n${classSectionsPrintTimesText(col.times) || "시간 미정"}`),
    emptyUnit ? "학급\n단위" : "학급 단위", emptyRetake ? "재신청\n미배정" : "재신청·미배정"];
  const body = homeroom.students.map((student) => [classSectionsPrintNumber(student.number), student.key, student.name,
    ...homeroom.columns.map((col) => {
      const cell = student.cells[col.key];
      return cell ? `${cell.courseName} ${cell.roomName}\n${[cell.roomLabel, cell.teacher].filter(Boolean).join(" · ")}` : "";
    }),
    student.unit.join(", "),
    [student.unsubmitted ? "미제출" : "", ...student.retake.map((item) => `${item.courseName}${item.reason ? `(${item.reason})` : ""}`)].filter(Boolean).join(", ")]);
  const rowLines = (row) => Math.max(1, ...row.map((value, c) => (value === "" || value === null || value === undefined ? 1 : classSectionsTextLines(value, widths[c]))));
  return { widths, head, body, headLines: rowLines(head), lines: body.map(rowLines), emptyUnit, emptyRetake, blockWidth };
}

// 쪽 나눔: 한 쪽에 들어가는 학생 줄 = (쪽 높이 − 제목·부제·안내·머리글) ÷ 가장 높은 학생 줄. 학생 수를 쪽마다 고르게(31명 → 16 + 15).
function classSectionsHomeroomStatusPlan(homeroom, layout = classSectionsHomeroomStatusLayout(homeroom)) {
  const C = CLASS_SECTIONS_HR_PRINT;
  const rowPt = (lines) => lines * C.linePt + C.padPt;
  const note = homeroom.basis === "none" || homeroom.basis === "same";
  const headerPt = C.titlePt + C.notePt + (note ? C.notePt : 0) + rowPt(layout.headLines);
  const maxLines = Math.max(1, ...layout.lines);
  const rowsPerPage = Math.max(1, Math.floor((C.pagePt - headerPt) / rowPt(maxLines)));
  const n = homeroom.students.length;
  const need = Math.max(1, Math.ceil(n / rowsPerPage));
  const pages = need; // 9pt로 세 장을 넘으면 그대로 더 나누고 overflow로 알린다(글자를 줄이지 않음)
  const parts = [];
  for (let i = 0, from = 0; i < pages; i += 1) {
    const size = Math.ceil((n - from) / (pages - i));
    parts.push({ from, to: from + size });
    from += size;
  }
  const widthPt = layout.widths.reduce((sum, w) => sum + (w * 7 + 5) * 0.75, 0);
  const tallest = Math.max(0, ...parts.map((part) => layout.lines.slice(part.from, part.to).reduce((sum, lines) => sum + rowPt(lines), 0)));
  const fit = Math.floor(Math.min(100, (C.pageWidthPt / widthPt) * 100, (C.pageHeightPt / (headerPt + tallest)) * 100));
  return { pages, parts, rowsPerPage, maxLines, headerPt, overflow: need > C.maxPages || fit < C.minScale, scale: Math.max(C.minScale, fit), fontPt: C.fontPt };
}

function classSectionsHomeroomStatusSheet(homeroom, options = {}) {
  const C = CLASS_SECTIONS_HR_PRINT;
  const layout = options.layout || classSectionsHomeroomStatusLayout(homeroom);
  const plan = options.plan || classSectionsHomeroomStatusPlan(homeroom, layout);
  const part = options.part || { from: 0, to: homeroom.students.length };
  const cols = layout.widths.length;
  const last = classSectionsPrintColumn(cols - 1);
  const rows = [[{ v: `${homeroom.label} 이동수업 현황`, s: 1 }]];
  const merges = [`A1:${last}1`];
  const heights = [C.titlePt];
  rows.push([{ v: `${homeroom.year}학년도 ${homeroom.semester}학기 · ${homeroom.basis === "none" ? `현 ${homeroom.grade}학년` : `현 ${homeroom.grade}학년 → ${homeroom.targetGrade}학년`} · 학생 ${homeroom.students.length}명${homeroom.unsubmitted ? ` · 미제출 ${homeroom.unsubmitted}명` : ""}${homeroom.rosterBasis ? ` (${homeroom.rosterBasis})` : ""}`, s: 8 }]);
  merges.push(`A2:${last}2`);
  heights.push(C.notePt);
  if (homeroom.basis === "none") { rows.push([{ v: "⚠ 내년 반 미정 — 현재 반 기준입니다. 내년 반 배정표를 올리면 내년 반으로 묶습니다.", s: 8 }]); merges.push(`A3:${last}3`); heights.push(C.notePt); }
  else if (homeroom.basis === "same") { rows.push([{ v: "진급 때 반이 그대로 올라가 지금 반을 내년 반으로 보았습니다(번호는 진급 뒤 확인).", s: 8 }]); merges.push(`A3:${last}3`); heights.push(C.notePt); }
  rows.push(layout.head.map((v) => ({ v, s: 2 })));
  const headerRow = rows.length;
  heights.push(layout.headLines * C.linePt + C.padPt);
  const students = homeroom.students.slice(part.from, part.to);
  students.forEach((student, i) => {
    const retakeStyle = student.retake.length || student.unsubmitted ? 9 : 4;
    rows.push(layout.body[part.from + i].map((v, c) => ({ v, s: c === cols - 1 ? retakeStyle : 4 })));
    heights.push(layout.lines[part.from + i] * C.linePt + C.padPt);
  });
  // 엑셀(나누지 않은 시트): 쪽마다 끝 행 뒤에 수동 쪽 나눔. 쪽 맞춤(fitToPage)은 수동 나눔을 무시하므로 배율로.
  const rowBreaks = options.part ? [] : plan.parts.slice(0, -1).map((item) => headerRow + item.to);
  return { name: options.sheetName || "이동수업 현황", rows, merges, heights, widths: layout.widths, orientation: "landscape", fitToHeight: plan.pages,
    scale: plan.scale, rowBreaks, headerText: "&R&P/&N", printTitles: `$1:$${headerRow}`, freeze: `D${headerRow + 1}`, headerRow,
    studentKeys: students.map((student) => student.key),
    printPlan: { pages: plan.pages, parts: plan.parts.map((item) => item.to - item.from), rowsPerPage: plan.rowsPerPage, maxLines: plan.maxLines, overflow: plan.overflow, scale: plan.scale } };
}

// 인쇄용: 쪽마다 시트 하나(제목·부제·머리글 반복) + 오른쪽 위 '1/2'.
function classSectionsHomeroomStatusPages(homeroom) {
  const layout = classSectionsHomeroomStatusLayout(homeroom);
  const plan = classSectionsHomeroomStatusPlan(homeroom, layout);
  return plan.parts.map((part, index) => ({ ...classSectionsHomeroomStatusSheet(homeroom, { layout, plan, part }), pageIndex: index + 1, pageCount: plan.pages, pageLabel: `${index + 1}/${plan.pages}` }));
}

// ② 그 반 학생만 추린 분반 출석부 시트들(같은 양식, 부제에 '○반 학생만 n/전체 m명').
function classSectionsHomeroomAttendanceSheets(homeroom, options = {}) {
  const used = new Set(["이동수업 현황"]);
  return homeroom.sections.map((info) => {
    let name = String(info.roomName).slice(0, 31);
    for (let n = 2; used.has(name); n += 1) name = `${String(info.roomName).slice(0, 27)}(${n})`;
    used.add(name);
    return classSectionsAttendanceSheet(info, { ...options, sheetName: name, subtitle: `${homeroom.label} 학생만 ${info.students.length}/${info.sectionTotal}명` });
  });
}

function classSectionsHomeroomFileName(homeroom) {
  return `${homeroom.year}_${homeroom.semester}학기_담임학급_${classSectionsPrintFilePart(homeroom.label)}_출석부.xlsx`;
}

function classSectionsHomeroomSheetName(homeroom) {
  return homeroom.basis === "none" ? `현${homeroom.grade}-${homeroom.room}반` : `${homeroom.targetGrade}-${homeroom.room}반`;
}

// 담임학급별 파일(반마다 파일 하나: ① + ②) / 담임학급 전체 파일(맨 앞 목록 + 반마다 ①). options.homerooms = classSectionsHomerooms(…)
CLASS_SECTIONS_ATTENDANCE_BUNDLES.homeroom = (infos, options) => (options.homerooms || []).map((homeroom) => ({ name: classSectionsHomeroomFileName(homeroom),
  sheets: [classSectionsHomeroomStatusSheet(homeroom), ...classSectionsHomeroomAttendanceSheets(homeroom, options)] }));
CLASS_SECTIONS_ATTENDANCE_BUNDLES.homeroomFile = (infos, options) => {
  const homerooms = options.homerooms || [];
  const head = ["번호", "시트", "반", "학생", "미제출", "이동 분반", "기준"];
  const list = { name: "목록", orientation: "portrait", merges: ["A1:G1"], widths: [6, 14, 20, 8, 8, 10, 20], freeze: "A3", printTitles: "$1:$2",
    rows: [[{ v: `${infos[0]?.year || ""}학년도 ${infos[0]?.semester || ""}학기 담임학급별 이동수업 현황 (반 ${homerooms.length}개)`, s: 1 }], head.map((v) => ({ v, s: 2 })),
      ...homerooms.map((homeroom, i) => [i + 1, classSectionsHomeroomSheetName(homeroom), homeroom.label, homeroom.students.length, homeroom.unsubmitted || 0, homeroom.sections.length,
        homeroom.basis === "none" ? "현재 반(내년 반 미정)" : homeroom.basis === "same" ? "그대로 올라감" : "내년 반 배정표"].map((v) => ({ v, s: 4 })))] };
  return [{ name: `${infos[0]?.year || ""}_${infos[0]?.semester || ""}학기_담임학급별_이동수업현황_전체.xlsx`,
    sheets: [list, ...homerooms.map((homeroom) => classSectionsHomeroomStatusSheet(homeroom, { sheetName: classSectionsHomeroomSheetName(homeroom) }))] }];
};

// ---- ③ 학생 개인 이동수업 시간표 ----
// info: { year, semester, grade, targetGrade, key, name, nextClass, nextNumber, days:["월",…], periods, fill(빈칸 글자),
//   fixedSlots: [{ label, times }], entries: [{ blockLetter, times, courseName, sectionNo, roomName, roomLabel, teacher, groupLabel }],
//   unitCourses: [과목명], retake: [{ courseName, reason }] }
// 반환: { title, student, grid: [[{ kind, lines, block }]] | null, untimed: [문장], unitCourses, retake }
function classSectionsStudentTimetable(info) {
  const days = (info.days || []).length ? info.days.slice() : ["월", "화", "수", "목", "금"];
  const periods = Math.max(1, Math.floor(Number(info.periods) || 7));
  const title = `${info.year}학년도 ${info.semester}학기 · 현 ${info.grade}학년 → ${info.targetGrade}학년 이동수업 시간표`;
  const next = info.nextClass ? ` · 내년 ${info.targetGrade}학년 ${info.nextClass}반${info.nextNumber ? ` ${info.nextNumber}번` : ""}` : "";
  const student = `${info.key}${info.name ? ` ${info.name}` : ""}${next}`;
  const cellText = (entry) => [`${entry.courseName}${entry.sectionNo ? ` ${classSectionsPrintCircled(entry.sectionNo)}` : ""}`, entry.roomLabel || "교실 미정", entry.teacher || ""].filter((line, i) => i < 2 || line);
  const entries = (info.entries || []).map((entry) => ({ ...entry, slots: (entry.times || []).map(classSectionsPrintTime).filter(Boolean) }));
  const timed = entries.filter((entry) => entry.slots.length);
  const untimed = entries.filter((entry) => !entry.slots.length).map((entry) => `${entry.blockLetter}블록: ${cellText(entry).join(" · ")}`);
  let grid = null;
  if (timed.length) {
    const fill = classSectionsPrintText(info.fill);
    grid = Array.from({ length: periods }, () => days.map(() => ({ kind: "empty", lines: fill ? [fill] : [] })));
    const at = (time) => { const d = days.indexOf(time.day); return d >= 0 && time.period >= 1 && time.period <= periods ? grid[time.period - 1][d] : null; };
    for (const slot of info.fixedSlots || []) {
      for (const time of (slot.times || []).map(classSectionsPrintTime).filter(Boolean)) {
        const cell = at(time);
        if (cell) Object.assign(cell, { kind: "fixed", lines: [classSectionsPrintText(slot.label) || "고정"] });
      }
    }
    for (const entry of timed) {
      for (const time of entry.slots) {
        const cell = at(time);
        if (!cell) { untimed.push(`${entry.blockLetter}블록(${time.day}${time.period}, 격자 밖): ${cellText(entry).join(" · ")}`); continue; }
        if (cell.kind === "move" || cell.kind === "clash") {
          cell.kind = "clash";
          cell.lines = [...cell.lines, ...cellText(entry)];
          cell.block = `${cell.block}/${entry.blockLetter}`;
        } else Object.assign(cell, { kind: cell.kind === "fixed" ? "clash" : "move", lines: cell.kind === "fixed" ? [...cell.lines, ...cellText(entry)] : cellText(entry), block: entry.blockLetter });
      }
    }
  } else {
    untimed.splice(0, untimed.length, ...entries.map((entry) => `${entry.blockLetter}블록: ${cellText(entry).join(" · ")}`));
  }
  return { title, student, days, periods, grid, untimed, unitCourses: (info.unitCourses || []).slice(), retake: (info.retake || []).slice() };
}

// 1·2학기를 한 장에(사용자 결정): 학기마다 classSectionsStudentTimetable 모델을 받아 한 학생 모델로.
// 제목 '2027학년도 · 현 1학년 → 2학년 이동수업 시간표', 학기마다 격자(블록 시간이 없으면 그 학기는 목록).
function classSectionsStudentTimetableYear(models, info = {}) {
  const first = models[0] || {};
  return { title: `${info.year}학년도 · 현 ${info.grade}학년 → ${info.targetGrade}학년 이동수업 시간표`, student: first.student || info.student || "",
    semesters: models.map((model, i) => ({ ...model, semester: String(info.semesters?.[i] ?? model.semester ?? i + 1) })),
    retake: models.flatMap((model, i) => model.retake.map((item) => ({ ...item, semester: String(info.semesters?.[i] ?? i + 1) }))) };
}

function classSectionsTimetableSemesterHtml(model) {
  const esc = classSectionsPrintEsc;
  const grid = model.grid ? `<table class="cs-tt-grid"><thead><tr><th></th>${model.days.map((day) => `<th scope="col">${esc(day)}</th>`).join("")}</tr></thead><tbody>
    ${model.grid.map((row, p) => `<tr><th scope="row">${p + 1}</th>${row.map((cell) => `<td data-kind="${cell.kind}">${cell.block ? `<small>${esc(cell.block)}</small>` : ""}${cell.lines.map((line) => `<span>${esc(line)}</span>`).join("")}</td>`).join("")}</tr>`).join("")}</tbody></table>` : "";
  const list = model.untimed.length ? `<ul class="cs-tt-list">${model.untimed.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : "";
  const unit = model.unitCourses.length ? `<p class="cs-tt-unit">학급 단위 과목: ${model.unitCourses.map(esc).join(", ")}</p>` : "";
  const empty = !model.grid && !model.untimed.length ? '<p class="cs-tt-unit">이 학기 이동 수업 배정이 없습니다.</p>' : "";
  return `${grid}${list}${unit}${empty}`;
}

// 시간표 하나 HTML(화면 미리 보기·인쇄 공용). 두 학기 모델(semesters)이면 학기마다 격자를 위아래로.
function classSectionsTimetableHtml(model) {
  if (model.semesters) {
    const esc = classSectionsPrintEsc;
    const retake = model.retake.length
      ? `<p class="cs-tt-retake" data-retake="${model.retake.length}">재신청 필요: ${model.retake.map((item) => esc(`${item.semester}학기 ${item.courseName}${item.reason ? `(${item.reason})` : ""}`)).join(", ")}</p>` : "";
    return `<article class="cs-tt cs-tt-year" data-student="${esc(model.student.split(" ")[0])}" data-semesters="${model.semesters.length}"><header><h4>${esc(model.title)}</h4><p>${esc(model.student)}</p></header>${retake}
      ${model.semesters.map((item) => `<section class="cs-tt-sem" data-semester="${esc(item.semester)}"><h5>${esc(item.semester)}학기</h5>${classSectionsTimetableSemesterHtml(item)}</section>`).join("")}</article>`;
  }
  const esc = classSectionsPrintEsc;
  const retake = model.retake.length
    ? `<p class="cs-tt-retake" data-retake="${model.retake.length}">재신청 필요: ${model.retake.map((item) => esc(`${item.courseName}${item.reason ? `(${item.reason})` : ""}`)).join(", ")}</p>` : "";
  const grid = model.grid ? `<table class="cs-tt-grid"><thead><tr><th></th>${model.days.map((day) => `<th scope="col">${esc(day)}</th>`).join("")}</tr></thead><tbody>
    ${model.grid.map((row, p) => `<tr><th scope="row">${p + 1}</th>${row.map((cell) => `<td data-kind="${cell.kind}">${cell.block ? `<small>${esc(cell.block)}</small>` : ""}${cell.lines.map((line) => `<span>${esc(line)}</span>`).join("")}</td>`).join("")}</tr>`).join("")}</tbody></table>` : "";
  const list = model.untimed.length ? `<ul class="cs-tt-list">${model.untimed.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>` : "";
  const unit = model.unitCourses.length ? `<p class="cs-tt-unit">학급 단위 과목: ${model.unitCourses.map(esc).join(", ")}</p>` : "";
  const empty = !model.grid && !model.untimed.length ? '<p class="cs-tt-unit">이 학기 이동 수업 배정이 없습니다.</p>' : "";
  return `<article class="cs-tt" data-student="${esc(model.student.split(" ")[0])}"><header><h4>${esc(model.title)}</h4><p>${esc(model.student)}</p></header>${retake}${grid}${list}${unit}${empty}</article>`;
}

// 시간표 엑셀: 한 시트에 학생 여러 명(위에서 아래로), 학생마다 제목·격자(또는 목록).
function classSectionsTimetableSheet(name, models) {
  const rows = [];
  const merges = [];
  const heights = [];
  const width = 1 + Math.max(5, ...models.flatMap((model) => (model.semesters || [model]).map((item) => item.days.length)));
  const last = classSectionsPrintColumn(width - 1);
  // 두 학기 모델: 학생 제목 한 번 + 학기마다 '1학기' 줄과 격자.
  for (const year of models.filter((model) => model.semesters)) {
    rows.push([{ v: year.title, s: 6 }]); merges.push(`A${rows.length}:${last}${rows.length}`);
    rows.push([{ v: year.student, s: 3 }]); merges.push(`A${rows.length}:${last}${rows.length}`);
    if (year.retake.length) { rows.push([{ v: `재신청 필요: ${year.retake.map((item) => `${item.semester}학기 ${item.courseName}${item.reason ? `(${item.reason})` : ""}`).join(", ")}`, s: 9 }]); merges.push(`A${rows.length}:${last}${rows.length}`); }
    for (const model of year.semesters) {
      rows.push([{ v: `${model.semester}학기`, s: 2 }]); merges.push(`A${rows.length}:${last}${rows.length}`);
      if (model.grid) {
        rows.push([{ v: "교시", s: 2 }, ...model.days.map((day) => ({ v: day, s: 2 }))]);
        model.grid.forEach((row, p) => {
          rows.push([{ v: p + 1, s: 2 }, ...row.map((cell) => ({ v: [cell.block ? `[${cell.block}]` : "", ...cell.lines].filter(Boolean).join("\n"), s: cell.kind === "clash" ? 9 : 4 }))]);
          heights[rows.length - 1] = 42;
        });
      }
      for (const line of model.untimed) { rows.push([{ v: line, s: 3 }]); merges.push(`A${rows.length}:${last}${rows.length}`); }
      if (model.unitCourses.length) { rows.push([{ v: `학급 단위 과목: ${model.unitCourses.join(", ")}`, s: 3 }]); merges.push(`A${rows.length}:${last}${rows.length}`); }
      if (!model.grid && !model.untimed.length) { rows.push([{ v: "이 학기 이동 수업 배정이 없습니다.", s: 3 }]); merges.push(`A${rows.length}:${last}${rows.length}`); }
    }
    rows.push([]);
  }
  for (const model of models.filter((item) => !item.semesters)) {
    rows.push([{ v: model.title, s: 6 }]); merges.push(`A${rows.length}:${last}${rows.length}`);
    rows.push([{ v: model.student, s: 3 }]); merges.push(`A${rows.length}:${last}${rows.length}`);
    if (model.retake.length) { rows.push([{ v: `재신청 필요: ${model.retake.map((item) => `${item.courseName}${item.reason ? `(${item.reason})` : ""}`).join(", ")}`, s: 9 }]); merges.push(`A${rows.length}:${last}${rows.length}`); }
    if (model.grid) {
      rows.push([{ v: "교시", s: 2 }, ...model.days.map((day) => ({ v: day, s: 2 }))]);
      model.grid.forEach((row, p) => {
        rows.push([{ v: p + 1, s: 2 }, ...row.map((cell) => ({ v: [cell.block ? `[${cell.block}]` : "", ...cell.lines].filter(Boolean).join("\n"), s: cell.kind === "clash" ? 9 : 4 }))]);
        heights[rows.length - 1] = 42;
      });
    }
    for (const line of model.untimed) { rows.push([{ v: line, s: 3 }]); merges.push(`A${rows.length}:${last}${rows.length}`); }
    if (model.unitCourses.length) { rows.push([{ v: `학급 단위 과목: ${model.unitCourses.join(", ")}`, s: 3 }]); merges.push(`A${rows.length}:${last}${rows.length}`); }
    rows.push([]);
  }
  return { name, rows, merges, heights, widths: [6, ...Array(width - 1).fill(18)], orientation: "portrait" };
}

// ---- ⑤ 학생 배부용 '이동수업 안내' 쪽지 ----
// 담임이 반 학생에게 한 장씩 나눠 주는 쪽지. 학생 한 명에 쪽지 하나, 1·2학기를 한 쪽지에(표: 학기 | 블록(요일·교시) | 과목 | 강의실 | 교실 | 선생님).
// 재료는 담임반 묶음(classSectionsHomerooms)을 학기마다 하나씩: semesters = [{ semester, homeroom }]. 명단·내년 반·미제출은 담임반 규칙 그대로.
// A4 세로에 쪽지 2·4·6장(classSectionsHandoutLayout이 글자 크기와 1열/2열 배치를 고름, 6장은 8pt보다 작으면 막음).
var CLASS_SECTIONS_HANDOUT = { per: [2, 4, 6], defaultPer: 4, minPt: 8, basePt: { 2: 12, 4: 10.5, 6: 9.5 }, pageW: 182, pageH: 268, pad: 3, ptMm: 0.3528 };

function classSectionsHandoutSlips(semesters, options = {}) {
  const slips = new Map();
  const list = (semesters || []).filter((item) => item?.homeroom);
  for (const { semester, homeroom } of list) {
    const known = homeroom.basis !== "none";
    const colByKey = new Map(homeroom.columns.map((col) => [col.key, col]));
    for (const student of homeroom.students) {
      const [, curClass, curNumber] = String(student.key).split("-");
      if (!slips.has(student.key)) {
        slips.set(student.key, { key: student.key, year: homeroom.year || options.year || "", grade: homeroom.grade, targetGrade: homeroom.targetGrade, curClass, curNumber,
          name: student.name || "", nextClass: known ? homeroom.room : "", nextNumber: known ? classSectionsPrintText(student.number) : "", basis: homeroom.basis, unsubmitted: false, rows: [], semesters: [] });
      }
      const slip = slips.get(student.key);
      if (!slip.name && student.name) slip.name = student.name;
      if (!slip.semesters.includes(String(semester))) slip.semesters.push(String(semester));
      if (student.unsubmitted) slip.unsubmitted = true;
      for (const [colKey, cell] of Object.entries(student.cells || {})) {
        const col = colByKey.get(colKey) || {};
        slip.rows.push({ semester: String(semester), kind: "section", blockLetter: col.blockLetter || "", block: `${col.blockLetter || ""}블록 · ${classSectionsPrintTimesText(col.times) || "시간 미정"}`,
          courseName: cell.courseName, roomName: cell.roomName, roomLabel: cell.roomLabel || "미정", teacher: cell.teacher || "", order: col.order || 0 });
      }
      for (const name of student.unit || []) slip.rows.push({ semester: String(semester), kind: "unit", blockLetter: "~", block: "학급 단위", courseName: name, order: 900 });
      for (const item of student.retake || []) slip.rows.push({ semester: String(semester), kind: "retake", blockLetter: "~~", block: "—", courseName: item.courseName, reason: item.reason || "", order: 999 });
    }
  }
  const num = (value) => (/^\d+$/.test(String(value)) ? Number(value) : 999);
  const out = [...slips.values()];
  for (const slip of out) {
    slip.rows.sort((a, b) => a.semester.localeCompare(b.semester) || a.order - b.order || String(a.blockLetter).localeCompare(String(b.blockLetter)) || String(a.courseName).localeCompare(String(b.courseName), "ko"));
    slip.semesters.sort();
    const next = slip.basis === "none" || !slip.nextClass ? "내년 반 미정"
      : `내년 ${slip.targetGrade}학년 ${slip.nextClass}반${slip.nextNumber ? ` ${slip.nextNumber}번` : ""}`;
    slip.who = `현 ${slip.grade}학년 ${slip.curClass}반 ${num(slip.curNumber) === 999 ? slip.curNumber : num(slip.curNumber)}번 ${slip.name}`.trim();
    slip.next = next;
  }
  return out.sort((a, b) => (Number(a.curClass) || 0) - (Number(b.curClass) || 0) || num(a.curNumber) - num(b.curNumber) || a.key.localeCompare(b.key, "ko", { numeric: true }));
}

// 쪽지 표 열 폭(비율, 합 1): 학기 · 블록(요일·교시) · 과목 · 강의실 · 교실 · 선생님. 화면·인쇄 모두 table-layout:fixed + 이 colgroup.
var CLASS_SECTIONS_HANDOUT_COLS = [0.12, 0.19, 0.2, 0.19, 0.13, 0.17];

// 칸 하나의 줄 수(칸마다 따로 접힘): 글자 폭 합 ÷ 칸 안 폭. 폭 단위 1.95 = 한글 한 글자 = pt.
function classSectionsHandoutCellLines(text, pt, cellMm) {
  const C = CLASS_SECTIONS_HANDOUT;
  const unitMm = (pt * C.ptMm) / 1.95;
  const avail = Math.max(1, cellMm - pt * C.ptMm * 0.7 - 0.4) * 0.9;
  return String(text ?? "").split("\n").reduce((n, line) => n + Math.max(1, Math.ceil((classSectionsTextUnits(line) * unitMm) / avail)), 0);
}

function classSectionsHandoutRowLines(row, pt, innerMm) {
  const W = CLASS_SECTIONS_HANDOUT_COLS.map((f) => f * innerMm);
  const cells = row.kind === "section"
    ? [[row.block, W[1]], [row.courseName, W[2]], [row.roomName, W[3]], [row.roomLabel, W[4]], [row.teacher, W[5]]]
    : [[row.block, W[1]], [row.courseName, W[2]], [row.kind === "retake" ? `재신청 필요(${row.reason})` : "학급 단위(우리 반 교실)", W[3] + W[4] + W[5]]];
  return Math.max(1, ...cells.map(([text, width]) => classSectionsHandoutCellLines(text, pt, width)));
}

// 쪽지 높이(mm): 제목 + 학생 줄(접힘) + 표 머리 + 줄들(칸마다 접힘) + 아래 작은 글씨 + 여백·테두리. 넉넉하게 어림한다.
function classSectionsHandoutHeight(slip, pt, widthMm) {
  const C = CLASS_SECTIONS_HANDOUT;
  const em = pt * C.ptMm;
  const line = em * 1.3;
  const inner = widthMm - 2 * 4 - 0.6; // 쪽지 좌우 여백 4mm + 점선
  const cellPad = em * 0.3 + 0.35; // 칸 위아래 여백 + 테두리
  const title = em * 1.3 * 1.25;
  const who = classSectionsHandoutCellLines(`${slip.who} → ${slip.next}`, pt, inner + 1) * line + em * 0.9;
  const foot = em * 0.85 * 1.3 + em * 0.4;
  const frame = 2 * 3 + 0.6; // 쪽지 위아래 여백 3mm + 점선
  if (slip.unsubmitted && !slip.rows.length) return frame + title + who + em * 1.25 * 1.3 * 2 + em * 2.8 + foot;
  const head = Math.max(1, ...["학기", "블록(요일·교시)", "과목", "강의실", "교실", "선생님"].map((text, i) => classSectionsHandoutCellLines(text, pt, CLASS_SECTIONS_HANDOUT_COLS[i] * inner))) * line + cellPad;
  const rows = slip.rows.length ? slip.rows : [{ kind: "unit", block: "", courseName: "이동수업 없음" }];
  const body = rows.reduce((sum, row) => sum + classSectionsHandoutRowLines(row, pt, inner) * line + cellPad, 0);
  return frame + title + who + head + body + foot;
}
// 한 장에 per장: 1열(위아래로 per칸) / 2열 중 글자를 크게 쓸 수 있는 쪽. 가장 긴 쪽지가 칸에 들어가는 가장 큰 글자(0.5pt 단위).
// options.measure(slip, pt, widthMm) → 실제 높이(mm): 브라우저에서 재면 그 값으로(어림 높이가 큰 쪽지 몇 개만 잼, 1mm 여유). 없으면 어림(classSectionsHandoutHeight).
function classSectionsHandoutLayout(slips, per, options = {}) {
  const C = CLASS_SECTIONS_HANDOUT;
  const count = C.per.includes(Number(per)) ? Number(per) : C.defaultPer;
  const shapes = count === 2 ? [{ cols: 1, rows: 2 }] : [{ cols: 1, rows: count }, { cols: 2, rows: count / 2 }];
  let best = null;
  for (const option of shapes) {
    const width = C.pageW / option.cols;
    const height = C.pageH / option.rows;
    let fit = 0;
    const measure = typeof options.measure === "function" ? options.measure : null;
    const candidates = measure ? (slips || []).slice().sort((a, b) => classSectionsHandoutHeight(b, 9, width) - classSectionsHandoutHeight(a, 9, width)).slice(0, options.candidates || 6) : slips || [];
    for (let pt = C.basePt[count]; pt >= 6; pt -= 0.5) {
      if (candidates.every((slip) => (measure ? measure(slip, pt, width) + 1 : classSectionsHandoutHeight(slip, pt, width)) <= height)) { fit = pt; break; }
    }
    if (!best || fit > best.fontPt) best = { per: count, ...option, fontPt: fit, slipW: width, slipH: height };
  }
  const longest = Math.max(0, ...(slips || []).map((slip) => slip.rows.length));
  const ok = best.fontPt >= C.minPt;
  return { ...best, fontPt: ok ? best.fontPt : C.minPt, ok, longest,
    message: ok ? "" : `한 장에 ${count}장이면 가장 긴 쪽지(${longest}줄)의 글자가 ${C.minPt}pt보다 작아집니다. ${count === 6 ? "4장이나 2장" : "2장"}을 고르세요.` };
}

function classSectionsHandoutHtml(slip) {
  const esc = classSectionsPrintEsc;
  const year = slip.year ? `${esc(slip.year)}학년도 ` : "";
  const foot = '<p class="cs-ho-foot">교실·시간은 바뀔 수 있습니다. 바뀌면 다시 안내합니다.</p>';
  const head = `<header><h4>${year}이동수업 안내</h4><p class="cs-ho-who">${esc(slip.who)} → ${esc(slip.next)}</p></header>`;
  if (slip.unsubmitted && !slip.rows.length) {
    return `<article class="cs-ho is-unsubmitted" data-student="${esc(slip.key)}">${head}<p class="cs-ho-unsub"><strong>수강신청 미제출 — 담임 선생님께 확인하세요</strong></p>${foot}</article>`;
  }
  const spans = new Map();
  for (const row of slip.rows) spans.set(row.semester, (spans.get(row.semester) || 0) + 1);
  const seen = new Set();
  const body = slip.rows.map((row) => {
    const first = !seen.has(row.semester) && seen.add(row.semester);
    const sem = first ? `<th scope="rowgroup" rowspan="${spans.get(row.semester)}">${esc(row.semester)}학기</th>` : "";
    if (row.kind === "retake") return `<tr class="cs-ho-retake">${sem}<td>${esc(row.block)}</td><td>${esc(row.courseName)}</td><td colspan="3"><strong>재신청 필요${row.reason ? `(${esc(row.reason)})` : ""}</strong></td></tr>`;
    if (row.kind === "unit") return `<tr class="cs-ho-unit">${sem}<td>${esc(row.block)}</td><td>${esc(row.courseName)}</td><td colspan="3">학급 단위(우리 반 교실)</td></tr>`;
    return `<tr>${sem}<td>${esc(row.block)}</td><td>${esc(row.courseName)}</td><td>${esc(row.roomName)}</td><td>${esc(row.roomLabel)}</td><td>${esc(row.teacher)}</td></tr>`;
  }).join("") || '<tr><td colspan="6">이동수업 없음</td></tr>';
  return `<article class="cs-ho" data-student="${esc(slip.key)}">${head}<table class="cs-ho-table"><colgroup>${CLASS_SECTIONS_HANDOUT_COLS.map((f) => `<col style="width:${Math.round(f * 100)}%">`).join("")}</colgroup><thead><tr><th>학기</th><th>블록(요일·교시)</th><th>과목</th><th>강의실</th><th>교실</th><th>선생님</th></tr></thead><tbody>${body}</tbody></table>${foot}</article>`;
}

// 인쇄 장들: 장마다 쪽지 per장, 자르는 선(쪽지 테두리 점선).
function classSectionsHandoutPagesHtml(slips, layout) {
  const pages = [];
  for (let i = 0; i < slips.length; i += layout.per) {
    pages.push(`<div class="print-page cs-ho-page" data-per="${layout.per}" data-cols="${layout.cols}" style="--ho-font:${layout.fontPt}pt;--ho-cols:${layout.cols};--ho-rows:${layout.rows}">${slips.slice(i, i + layout.per).map(classSectionsHandoutHtml).join("")}</div>`);
  }
  return pages;
}

// ---- 앱 연결 ----
var CLASS_SECTIONS_PRINT_VIEW = { timetableClass: "", busy: false };

function classSectionsPrintSettings() {
  const settings = typeof classSectionsSettings === "function" ? classSectionsSettings() : {};
  if (!settings.print || typeof settings.print !== "object" || Array.isArray(settings.print)) settings.print = {};
  for (const key of ["classrooms", "roomNames"]) if (!settings[key] || typeof settings[key] !== "object" || Array.isArray(settings[key])) settings[key] = {};
  return settings;
}

function classSectionsPrintOption(key) {
  const value = classSectionsPrintSettings().print[key];
  return value === undefined || value === null || value === "" ? CLASS_SECTIONS_PRINT_DEFAULTS[key] : value;
}

function classSectionsSplitNames(text) {
  return String(text || "").split(/[,\n]+/).map((item) => item.trim()).filter(Boolean);
}

// 학년별 내년 학급 수(교실 기본 수): 그 수업 학년 그룹의 내년 학급 수 → 없으면 지금 반 수.
function classSectionsGradeClassCounts(source) {
  const counts = {};
  for (const group of source?.groups || []) {
    const value = Number(group.nextClasses) || Number(group.rosterClasses) || Number(group.classes) || 0;
    if (value) counts[group.targetGrade] = Math.max(counts[group.targetGrade] || 0, value);
  }
  return counts;
}

// 교사·시간 설정의 교실 입력 → 교실 목록(순수 함수 classSectionsRoomList에 넘길 모양).
function classSectionsRoomSpecFromSettings(settings, gradeCounts) {
  const classrooms = {};
  const grades = new Set([...Object.keys(gradeCounts || {}), ...Object.keys(settings.classrooms || {})]);
  for (const grade of [...grades].sort()) {
    const conf = settings.classrooms?.[grade] || {};
    const names = classSectionsSplitNames(conf.names);
    const count = Number(conf.count) > 0 ? Number(conf.count) : Number(gradeCounts?.[grade]) || 0;
    classrooms[grade] = names.length ? names : (typeof classSectionsDefaultRoomNames === "function" ? classSectionsDefaultRoomNames("", count, grade) : []);
  }
  const special = {};
  for (const [type, count] of Object.entries(settings.rooms || {})) {
    const names = classSectionsSplitNames(settings.roomNames?.[type]);
    special[type] = names.length ? names : (typeof classSectionsDefaultRoomNames === "function" ? classSectionsDefaultRoomNames(type, count) : []);
  }
  return { classrooms, special, extra: classSectionsSplitNames(settings.extraRooms) };
}

// 한 차수·학기의 교실 배정(모든 그룹 함께). 계산 결과가 있는 그룹만. state가 바뀌면 다시 계산.
function classSectionsRoomPlan(round, semester) {
  const compute = () => classSectionsRoomPlanCompute(round, semester);
  const year = typeof $ === "function" ? $("#schoolYear")?.value || "" : "";
  return typeof cachedByStateRevision === "function" ? cachedByStateRevision("classSectionsRoomPlan", `${round}|${semester}|${year}`, compute) : compute();
}

function classSectionsRoomPlanCompute(round, semester) {
  if (typeof classSectionsSource !== "function" || typeof classSectionsAssignRooms !== "function") return null;
  const source = classSectionsSource(round);
  const settings = classSectionsPrintSettings();
  const rooms = classSectionsRoomList(classSectionsRoomSpecFromSettings(settings, classSectionsGradeClassCounts(source)));
  const groups = [];
  for (const group of source.groups) {
    if (group.semester !== String(semester)) continue;
    const entry = typeof classSectionsEntry === "function" ? classSectionsEntry(round, group.key, false) : null;
    const result = entry?.sectionResult;
    if (!result?.sections?.length) continue;
    const { map } = typeof classSectionsEffectiveClassMap === "function" ? classSectionsEffectiveClassMap(group) : { map: null };
    const members = new Map(result.sections.map((section) => [section.id, {}]));
    for (const [key, ids] of Object.entries(result.assign || {})) {
      const room = map?.[key]?.classroom ? String(map[key].classroom) : "";
      if (!room) continue;
      for (const id of ids) { const counts = members.get(id); if (counts) counts[room] = (counts[room] || 0) + 1; }
    }
    const specials = typeof classSectionsCourseConf === "function" ? classSectionsCourseConf(settings, "courseRooms", group.grade) : {};
    groups.push({ groupId: group.key, label: `${group.targetGrade}학년 ${group.semester}학기 ${group.category}`, grade: group.grade, targetGrade: group.targetGrade,
      blocks: (result.blocks || []).map((block) => ({ id: block.id, letter: block.letter, times: block.times || [] })),
      sections: result.sections.filter((section) => section.blockId).map((section) => ({ id: section.id, courseName: section.courseName, blockId: section.blockId, roomName: section.roomName,
        size: section.size, special: specials[section.courseKey] || "", homerooms: members.get(section.id) || {} })),
      pins: result.roomPins && typeof result.roomPins === "object" ? { ...result.roomPins } : {}, knownHomerooms: Boolean(map) });
  }
  const plan = classSectionsAssignRooms({ rooms, groups });
  return { ...plan, rooms, roomById: new Map(rooms.map((room) => [room.id, room])), groups };
}

function classSectionsRoomOf(round, group, sectionId) {
  const plan = classSectionsRoomPlan(round, group.semester);
  const roomId = plan?.assign?.[group.key]?.[sectionId] || "";
  return { roomId, room: roomId ? plan.roomById.get(roomId) : null, reason: plan?.reasons?.[group.key]?.[sectionId] || "", plan };
}

function classSectionsRoomLabel(round, group, sectionId) {
  const { room } = classSectionsRoomOf(round, group, sectionId);
  return room ? room.label : "";
}

// 결과 카드의 교실 칸: 지금 교실(자동 추천 또는 직접 고름)과 바꾸기 목록.
function classSectionsRoomCardHtml(round, group, section) {
  const esc = classSectionsPrintEsc;
  if (!section.blockId) return "";
  const { roomId, room, reason, plan } = classSectionsRoomOf(round, group, section.id);
  if (!plan) return "";
  const entry = typeof classSectionsEntry === "function" ? classSectionsEntry(round, group.key, false) : null;
  const pinned = entry?.sectionResult?.roomPins?.[section.id] || "";
  const clash = (plan.issues || []).some((issue) => issue.severity === "error" && issue.type !== "room-short" && ((issue.groupId === group.key && (issue.sectionId === section.id || (issue.sectionIds || []).includes(section.id))) || (issue.otherGroupId === group.key && issue.otherSectionId === section.id)));
  const choices = plan.choices?.[group.key]?.[section.id];
  // 학년 교실이 모자라 교실을 못 정한 분반: 교사가 고른다(후보 = 그 시간에 비어 있는 다른 교실 → 다른 학년 교실 → 특별실, 첫 후보 '추천').
  if (!roomId && choices) {
    const kindLabel = { extra: "다른 교실", "other-grade": "다른 학년 교실", special: "특별실", class: "학년 교실" };
    const options = choices.map((item) => `<option value="${esc(item.id)}">${esc(`${item.label}${item.recommended ? " (추천)" : ""} · ${kindLabel[item.kind] || item.kind}`)}</option>`).join("");
    return `<span class="cs-room is-choose" data-room-id="" data-choose="${choices.length}" title="${esc(reason || "")}">교실 선택 필요 <select data-cs-room-pick="${esc(section.id)}" data-focus-key="cs-room-pick-${esc(section.id)}" aria-label="${esc(section.roomName)} 교실">
      <option value="">고르세요 (${choices.length ? `후보 ${choices.length}개` : "빈 교실 없음"})</option>${options}</select>
      <input class="cs-text" type="text" placeholder="새 교실 이름" data-cs-room-new="${esc(section.id)}" data-focus-key="cs-room-new-${esc(section.id)}" aria-label="${esc(section.roomName)} 새 교실 이름(다른 교실 목록에 추가)"></span>`;
  }
  const usable = plan.rooms.filter((item) => item.kind !== "class" || item.grade === group.targetGrade || item.id === pinned);
  const options = usable.map((item) => `<option value="${esc(item.id)}"${pinned === item.id ? " selected" : ""}>${esc(item.label)}</option>`).join("");
  return `<span class="cs-room${clash ? " is-clash" : ""}" data-room-id="${esc(roomId)}" title="${esc(reason || "")}">교실 <select data-cs-room-pick="${esc(section.id)}" data-focus-key="cs-room-pick-${esc(section.id)}" aria-label="${esc(section.roomName)} 교실">
    <option value="">${pinned ? "자동으로 되돌리기" : room ? `자동(${esc(room.label)})` : "자동(미정)"}</option>${options}</select></span>`;
}

// 내보내기·인쇄 전에 보일 경고: 교실을 고르지 않은 분반(같은 학기 모든 그룹), 자리 이름 교사(6단계 세션 classSectionsTeacherNameWarnings).
function classSectionsOutputWarnings(round, group) {
  const out = [];
  const plan = classSectionsRoomPlan(round, group.semester);
  if (plan) {
    let total = 0;
    let mine = 0;
    for (const item of plan.groups) for (const section of item.sections) {
      if (plan.assign?.[item.groupId]?.[section.id]) continue;
      total += 1;
      if (item.groupId === group.key) mine += 1;
    }
    if (total) out.push({ type: "room", count: total, message: `교실을 고르지 않은 분반 ${total}개${mine !== total ? `(이 그룹 ${mine}개)` : ""} — 분반 카드에서 교실을 고르세요(출석부·시간표에는 '미정'으로 나옵니다).` });
  }
  if (typeof classSectionsTeacherNameWarnings === "function") {
    let list = [];
    try { list = classSectionsTeacherNameWarnings() || []; } catch { list = []; }
    if (!Array.isArray(list)) list = list.teachers || [];
    // class-sections-teachers.js는 안내 문장 배열을 돌려준다(그대로 보임). 교사 객체 배열이면 이름을 모아 한 문장으로.
    const sentences = list.filter((item) => typeof item === "string" && item.trim());
    for (const message of sentences) out.push({ type: "teacher", count: Number(message.match(/(\d+)명/)?.[1]) || 1, message });
    const objects = list.filter((item) => item && typeof item === "object");
    const names = objects.map((item) => item.name || item.alias || item.label || "").filter(Boolean);
    if (objects.length) out.push({ type: "teacher", count: objects.length, message: `실제 이름이 아닌 교사 ${objects.length}명(${names.slice(0, 4).join(", ")}${names.length > 4 ? " …" : ""}) — 교사 명단을 올리거나 이름을 고치세요.` });
  }
  return out;
}

function classSectionsOutputWarningsHtml(round, group) {
  const list = classSectionsOutputWarnings(round, group);
  if (!list.length) return "";
  return `<ul class="cs-list is-error" id="classSectionsOutputWarnings" data-count="${list.length}">${list.map((item) => `<li data-type="${item.type}">${classSectionsPrintEsc(item.message)}</li>`).join("")}</ul>`;
}

// 내보내기·인쇄 상태 줄 끝에 경고를 붙인다(막지는 않음).
function classSectionsWarnAfterOutput() {
  if (CLASS_SECTIONS_PRINT_VIEW.busy) return void setTimeout(classSectionsWarnAfterOutput, 100); // zip 만드는 중이면 끝난 뒤
  const context = classSectionsCurrent();
  if (!context?.group) return;
  const list = classSectionsOutputWarnings(context.round, context.group);
  if (!list.length) return;
  const box = typeof document !== "undefined" ? document.getElementById("classSectionsStatus") : null;
  const before = box?.textContent || CLASS_SECTIONS_VIEW.status?.text || "";
  classSectionsSetStatus(`${before ? `${before} ` : ""}⚠ ${list.map((item) => item.message).join(" ")}`, true);
}

// 블록 아래 교실 배정 요약: 이 그룹 관련 오류·확인, 내년 반을 모를 때 안내.
function classSectionsRoomSummaryHtml(round, group, result) {
  const esc = classSectionsPrintEsc;
  const plan = classSectionsRoomPlan(round, group.semester);
  if (!plan || !result?.sections?.length) return "";
  const mine = (plan.issues || []).filter((issue) => !issue.groupId || issue.groupId === group.key || issue.otherGroupId === group.key);
  const errors = mine.filter((issue) => issue.severity === "error");
  const others = mine.filter((issue) => issue.severity !== "error");
  const assigned = result.sections.filter((section) => plan.assign?.[group.key]?.[section.id]).length;
  const known = plan.groups.find((item) => item.groupId === group.key)?.knownHomerooms;
  const pins = Object.keys(result.roomPins || {}).length;
  return `<div class="cs-room-summary" id="classSectionsRoomSummary" data-errors="${errors.length}">
    <p class="cs-note${errors.length ? " is-warn" : ""}">교실 배정: 분반 ${assigned}/${result.sections.length}개${pins ? ` · 직접 고름 ${pins}개` : ""} · ${known ? "수강생이 가장 많은 내년 반 교실" : "내년 반을 몰라 학년 교실을 순서대로(반 배정표를 올리면 수강생이 가장 많은 반 교실)"} · 특별실 과목은 특별실 · 같은 시간 다른 학년과 겹침 금지
      ${pins ? `<button class="button" type="button" id="classSectionsRoomReset">교실 자동으로 되돌리기</button>` : ""}</p>
    ${errors.length ? `<ul class="cs-list is-error" id="classSectionsRoomErrors">${errors.map((issue) => `<li>${esc(issue.message)}</li>`).join("")}</ul>` : ""}
    ${others.length ? `<details><summary>교실 확인 ${others.length}건</summary><ul class="cs-list">${others.map((issue) => `<li>${esc(issue.message)}</li>`).join("")}</ul></details>` : ""}
  </div>`;
}

// 출력물 단추 줄 + 학생 시간표 미리 보기(학생 찾기 칸에 한 학생 키를 넣으면 그 학생).
function classSectionsPrintButtonsHtml(round, group, result) {
  const esc = classSectionsPrintEsc;
  if (!result?.sections?.length) return "";
  const homerooms = [...new Set((group.gradeStudents || group.students).map((student) => student.homeroom))].sort((a, b) => (Number(a) || 0) - (Number(b) || 0));
  const fill = classSectionsPrintOption("timetableFill");
  const perPage = Math.min(2, Number(classSectionsPrintOption("perPage")) || 1);
  const query = (typeof CLASS_SECTIONS_VIEW !== "undefined" ? CLASS_SECTIONS_VIEW.search || "" : "").trim();
  let preview = "";
  if (query) {
    const key = classSectionsTimetableFindKey(round, group, query);
    if (key) {
      const model = classSectionsTimetableModels(round, group, [key])[0];
      preview = model ? `<div class="cs-tt-preview" id="classSectionsTimetablePreview">${classSectionsTimetableHtml(model)}</div>` : "";
    }
  }
  return `<section class="cs-print" aria-label="출력물">
    <h5>출력물 <span class="cs-note">출석부·학생 시간표 (성명은 내려받을 때 차수 자료에서 채움, 저장하지 않음)</span></h5>
    ${classSectionsOutputWarningsHtml(round, group)}
    <div class="cs-actions">
      <span class="cs-note">출석부 저장(${esc(group.semester)}학기):</span>
      <button class="button" id="classSectionsAttendanceFile" type="button" title="${esc(group.semester)}학기 모든 그룹·분반을 한 엑셀에(맨 앞 '목록' 시트 + 분반마다 시트)">출석부 전체 파일</button>
      <button class="button" id="classSectionsAttendanceAll" type="button" title="${esc(group.semester)}학기 분반(이동 학급)마다 파일 하나, zip으로 묶음">출석부 분반별 파일(zip)</button>
      <button class="button" id="classSectionsAttendanceHomeroom" type="button" title="${esc(group.semester)}학기 · 담임반마다 파일 하나(그 반 이동수업 현황 + 그 반 학생 분반 출석부), zip으로 묶음">담임학급별 파일(zip)</button>
      <button class="button" id="classSectionsAttendanceHomeroomFile" type="button" title="${esc(group.semester)}학기 · 한 파일에 맨 앞 목록 + 반마다 이동수업 현황 시트">담임학급 전체 파일</button>
      <button class="button" id="classSectionsAttendanceTeacher" type="button" title="${esc(group.semester)}학기 · 교사마다 파일 하나(zip)">출석부 교사별(zip)</button>
      <button class="button" id="classSectionsAttendanceGroup" type="button" title="이 그룹만 · 분반마다 시트 하나">출석부 이 그룹 파일</button>
      <label>날짜 칸 <input class="cs-num" type="number" min="1" max="40" id="classSectionsAttendanceDays" value="${esc(classSectionsPrintOption("attendanceDays"))}" data-focus-key="cs-att-days" aria-label="출석부 날짜 칸 수"></label>
    </div>
    ${classSectionsAttendanceViewHtml(round, group)}
    <div class="cs-actions">
      <label>시간표 반 <select id="classSectionsTimetableClass" data-focus-key="cs-tt-class" aria-label="학생 시간표 인쇄할 반(현 반)"><option value="">전체</option>${homerooms.map((room) => `<option value="${esc(room)}"${CLASS_SECTIONS_PRINT_VIEW.timetableClass === room ? " selected" : ""}>현 ${esc(group.grade)}학년 ${esc(room)}반</option>`).join("")}</select></label>
      <label>한 장에 <select id="classSectionsTimetablePerPage" data-focus-key="cs-tt-per" aria-label="한 장에 학생 수">${[1, 2].map((n) => `<option value="${n}"${perPage === n ? " selected" : ""}>${n}명</option>`).join("")}</select></label>
      <label>빈 칸 <select id="classSectionsTimetableFill" data-focus-key="cs-tt-fill" aria-label="이동 수업이 아닌 칸에 쓸 글자"><option value=""${fill ? "" : " selected"}>비움</option><option value="학급 수업"${fill === "학급 수업" ? " selected" : ""}>학급 수업</option></select></label>
      <button class="button" id="classSectionsTimetablePrint" type="button">학생 시간표 인쇄</button>
      <button class="button" id="classSectionsTimetableExcel" type="button">학생 시간표 엑셀</button>
      <span class="cs-note">현 ${esc(group.grade)}학년 1·2학기를 한 장에(학기마다 그 학기 모든 그룹을 합친 격자) · 학생 찾기에 '${esc(group.grade)}-3-12'처럼 넣으면 미리 보기</span>
    </div>
    ${preview}
  </section>`;
}

function classSectionsTimetableFindKey(round, group, query) {
  const keys = classSectionsTimetableStudentKeys(round, group);
  if (keys.includes(query)) return query;
  const normalized = typeof classSectionsStudentKey === "function" ? (() => { const [g, c, n] = query.split("-"); return n ? classSectionsStudentKey(g, c, n) : ""; })() : "";
  if (normalized && keys.includes(normalized)) return normalized;
  const matches = keys.filter((key) => key.startsWith(`${query}-`) || key.endsWith(`-${query}`));
  return matches.length === 1 ? matches[0] : matches[0] || "";
}

// 같은 현 학년·학기의 그룹들(계산 결과 있는 것).
function classSectionsSemesterGroups(round, grade, semester) {
  const source = classSectionsSource(round);
  return source.groups.filter((item) => item.grade === String(grade) && item.semester === String(semester))
    .map((item) => ({ group: item, entry: classSectionsEntry(round, item.key, false) })).filter(({ entry }) => entry?.sectionResult);
}

function classSectionsTimetableStudentKeys(round, group) {
  const keys = new Set();
  for (const semester of ["1", "2"]) for (const { group: item } of classSectionsSemesterGroups(round, group.grade, semester)) for (const student of item.students) keys.add(student.key);
  return [...keys].sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
}

function classSectionsPrintYear() {
  return String((Number(typeof $ === "function" ? $("#schoolYear")?.value : "") || new Date().getFullYear()) + 1);
}

function classSectionsTeacherNames() {
  const settings = classSectionsPrintSettings();
  return new Map((settings.teachers || []).filter(Boolean).map((teacher) => [String(teacher.id), String(teacher.name || teacher.alias || "")]));
}

function classSectionsPrintFixedSlots(settings) {
  return (settings.fixedSlots || []).map((slot) => ({ label: slot.label || "고정", times: typeof classSectionsParseTimes === "function" ? classSectionsParseTimes(slot.times) : [] })).filter((slot) => slot.times.length);
}

// 학생마다 1·2학기를 한 모델로(계산 결과가 있는 학기만). 학기 하나만 있으면 그 학기만.
function classSectionsTimetableSemesters(round, group) {
  return ["1", "2"].filter((semester) => classSectionsSemesterGroups(round, group.grade, semester).length);
}

function classSectionsTimetableModels(round, group, keys) {
  const semesters = classSectionsTimetableSemesters(round, group);
  const bySemester = semesters.map((semester) => classSectionsTimetableSemesterModels(round, group, keys, semester));
  const year = classSectionsPrintYear();
  return keys.map((key, i) => classSectionsStudentTimetableYear(bySemester.map((models) => models[i]), { year, grade: group.grade, targetGrade: group.targetGrade, semesters }));
}

function classSectionsTimetableSemesterModels(round, group, keys, semester = group.semester) {
  const settings = classSectionsPrintSettings();
  const names = typeof classSectionsStudentNames === "function" ? classSectionsStudentNames(round) : new Map();
  const teacherName = classSectionsTeacherNames();
  const groups = classSectionsSemesterGroups(round, group.grade, semester);
  const days = String(settings.gridDays || "월,화,수,목,금").split(/[,\s]+/).filter(Boolean);
  const fixedSlots = classSectionsPrintFixedSlots(settings);
  const effective = typeof classSectionsEffectiveClassMap === "function" ? classSectionsEffectiveClassMap(group) : { map: null };
  const reasons = typeof CLASS_SECTIONS_UNASSIGNED_REASONS !== "undefined" ? CLASS_SECTIONS_UNASSIGNED_REASONS : {};
  const year = classSectionsPrintYear();
  const prepared = groups.map(({ group: item, entry }) => {
    const result = entry.sectionResult;
    const unitPlan = typeof classSectionsClassUnitPlan === "function" && item.courses.some((course) => classSectionsCourseConf(settings, "courseModes", item.grade)[course.key] === "class")
      ? classSectionsClassUnitPlan(item, entry, settings) : null;
    return { item, result, sectionById: new Map(result.sections.map((section) => [section.id, section])), blockById: new Map((result.blocks || []).map((block) => [block.id, block])), unitPlan,
      courseName: new Map(item.courses.map((course) => [course.key, course.name])) };
  });
  return keys.map((key) => {
    const entries = [];
    const unitCourses = [];
    const retake = [];
    for (const { item, result, sectionById, blockById, unitPlan, courseName } of prepared) {
      for (const id of result.assign?.[key] || []) {
        const section = sectionById.get(id);
        if (!section) continue;
        const block = blockById.get(section.blockId);
        entries.push({ blockLetter: section.blockLetter || block?.letter || "", times: block?.times || [], courseName: section.courseName, sectionNo: section.roomNo || 0,
          roomName: section.roomName, roomLabel: classSectionsRoomLabel(round, item, section.id), teacher: teacherName.get(String(section.teacherId || "")) || "", groupLabel: item.label });
      }
      for (const miss of [...(result.unassigned || []), ...(result.closedRequests || [])]) {
        if (miss.studentKey !== key || miss.reason === "class-unit-other-room") continue;
        retake.push({ courseName: courseName.get(miss.courseKey) || (typeof classSectionsDisplayName === "function" ? classSectionsDisplayName(miss.courseKey) : miss.courseKey), reason: reasons[miss.reason] || miss.reason });
      }
      if (unitPlan && effective.map?.[key]?.classroom) {
        const unitKey = unitPlan.assign[String(effective.map[key].classroom)];
        if (unitKey) unitCourses.push(courseName.get(unitKey) || unitKey);
      }
    }
    entries.sort((a, b) => a.blockLetter.localeCompare(b.blockLetter) || a.groupLabel.localeCompare(b.groupLabel, "ko"));
    return classSectionsStudentTimetable({ year, semester, grade: group.grade, targetGrade: group.targetGrade, key, name: names.get(key) || "",
      nextClass: effective.map?.[key]?.classroom || "", nextNumber: effective.map?.[key]?.number || "", days, periods: Number(settings.gridPeriods) || 7,
      fill: classSectionsPrintOption("timetableFill"), fixedSlots, entries, unitCourses, retake });
  });
}

function classSectionsTimetableKeysFor(round, group) {
  const room = CLASS_SECTIONS_PRINT_VIEW.timetableClass;
  return classSectionsTimetableStudentKeys(round, group).filter((key) => !room || key.split("-")[1] === room);
}

function classSectionsTimetablePrint() {
  const context = classSectionsCurrent();
  if (!context?.group) return;
  const keys = classSectionsTimetableKeysFor(context.round, context.group);
  const target = document.getElementById("printBatch");
  if (!keys.length || !target) return void classSectionsSetStatus("인쇄할 학생이 없습니다(계산 결과가 있는 그룹의 학생만).", true);
  const perPage = Math.min(2, Number(classSectionsPrintOption("perPage")) || 1);
  const models = classSectionsTimetableModels(context.round, context.group, keys);
  const pages = [];
  for (let i = 0; i < models.length; i += perPage) pages.push(models.slice(i, i + perPage));
  target.innerHTML = pages.map((list) => `<div class="print-page cs-tt-page" data-per="${perPage}">${list.map(classSectionsTimetableHtml).join("")}</div>`).join("");
  classSectionsSetStatus(`학생 시간표 ${models.length}명(${pages.length}장)을 인쇄합니다.`);
  if (typeof window !== "undefined" && typeof window.print === "function") window.print();
}

function classSectionsTimetableExcel() {
  const context = classSectionsCurrent();
  if (!context?.group || typeof createWorkbookBlob !== "function") return;
  const keys = classSectionsTimetableKeysFor(context.round, context.group);
  if (!keys.length) return void classSectionsSetStatus("내보낼 학생이 없습니다.", true);
  const models = classSectionsTimetableModels(context.round, context.group, keys);
  const byClass = new Map();
  models.forEach((model, index) => { const room = keys[index].split("-")[1]; if (!byClass.has(room)) byClass.set(room, []); byClass.get(room).push(model); });
  const sheets = [...byClass.entries()].sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0)).map(([room, list]) => classSectionsTimetableSheet(`현${context.group.grade}-${room}반`, list));
  const year = classSectionsPrintYear();
  downloadBlob(createWorkbookBlob(sheets), `${year}_현${context.group.grade}학년${CLASS_SECTIONS_PRINT_VIEW.timetableClass ? `_${CLASS_SECTIONS_PRINT_VIEW.timetableClass}반` : ""}_학생시간표.xlsx`);
  classSectionsSetStatus(`학생 시간표 엑셀: ${models.length}명, 반별 시트 ${sheets.length}개.`);
}

// 출석부 자료: scope "group"이면 지금 그룹, 아니면 같은 차수·학기 모든 그룹.
function classSectionsAttendanceInfos(round, group, scope) {
  const source = classSectionsSource(round);
  const settings = classSectionsPrintSettings();
  const names = typeof classSectionsStudentNames === "function" ? classSectionsStudentNames(round) : new Map();
  const teacherName = classSectionsTeacherNames();
  const year = classSectionsPrintYear();
  const list = [];
  const warnings = [];
  const groups = scope === "group" ? [group] : source.groups.filter((item) => item.semester === group.semester);
  for (const item of groups) {
    const entry = classSectionsEntry(round, item.key, false);
    const result = entry?.sectionResult;
    if (!result?.sections?.length) continue;
    const effective = typeof classSectionsEffectiveClassMap === "function" ? classSectionsEffectiveClassMap(item) : { map: null, basis: "none" };
    if (effective.basis === "none") warnings.push(`현 ${item.grade}학년: 내년 반을 몰라 현 학년-반-번호로 적었습니다.`);
    const members = new Map(result.sections.map((section) => [section.id, []]));
    for (const [key, ids] of Object.entries(result.assign || {})) for (const id of ids) members.get(id)?.push(key);
    const blockById = new Map((result.blocks || []).map((block) => [block.id, block]));
    const ordered = result.sections.slice().sort((a, b) => String(a.blockLetter).localeCompare(String(b.blockLetter)) || a.courseName.localeCompare(b.courseName, "ko") || (a.roomNo || 0) - (b.roomNo || 0) || a.ord - b.ord);
    for (const section of ordered) {
      const teacherId = String(section.teacherId || "");
      list.push({ year, semester: item.semester, grade: item.grade, targetGrade: item.targetGrade, groupKey: item.key, groupLabel: item.label, groupCategory: item.category, sectionId: section.id, courseKey: section.courseKey, blockId: section.blockId,
        courseName: section.courseName, roomName: section.roomName, blockLetter: section.blockLetter, times: blockById.get(section.blockId)?.times || [],
        roomLabel: classSectionsRoomLabel(round, item, section.id), teacherId, teacherName: teacherName.get(teacherId) || "", basis: effective.basis,
        students: (members.get(section.id) || []).map((key) => ({ key, classroom: effective.map?.[key]?.classroom || "", number: effective.map?.[key]?.number || "", name: names.get(key) || "" })) });
    }
  }
  return { list, warnings: [...new Set(warnings)] };
}

async function classSectionsAttendanceExport(kind) {
  const context = classSectionsCurrent();
  if (!context?.group || typeof createWorkbookBlob !== "function" || typeof downloadBlob !== "function" || CLASS_SECTIONS_PRINT_VIEW.busy) return;
  const { list, warnings } = classSectionsAttendanceInfos(context.round, context.group, kind === "group" ? "group" : "semester");
  if (!list.length) return void classSectionsSetStatus("출석부를 만들 분반이 없습니다(먼저 편성 계산).", true);
  const days = Number(classSectionsPrintOption("attendanceDays")) || 17;
  const homeroomKind = kind === "homeroom" || kind === "homeroomFile";
  const homerooms = homeroomKind ? classSectionsHomeroomData(context.round, context.group).homerooms : null;
  const bundles = classSectionsAttendanceBundles(list, kind, { days, homerooms });
  const note = warnings.length ? ` ${warnings.join(" ")}` : "";
  if (kind === "group" || kind === "file" || kind === "homeroomFile") {
    downloadBlob(createWorkbookBlob(bundles[0].sheets), bundles[0].name);
    return void classSectionsSetStatus(kind === "homeroomFile" ? `담임학급 전체 파일: 반 ${homerooms.length}개 시트 + 목록을 내려받았습니다.${note}`
      : `출석부 ${kind === "file" ? "전체 파일" : "이 그룹 파일"}: 분반 ${list.length}개 시트${kind === "file" ? " + 목록" : ""}를 내려받았습니다.${note}`, Boolean(warnings.length));
  }
  CLASS_SECTIONS_PRINT_VIEW.busy = true;
  try {
    const files = {};
    for (const bundle of bundles) {
      let name = bundle.name;
      for (let n = 2; files[name]; n += 1) name = bundle.name.replace(/\.xlsx$/, `(${n}).xlsx`);
      files[name] = new Uint8Array(await createWorkbookBlob(bundle.sheets).arrayBuffer());
    }
    const zip = new Blob([createXlsxBlob(files)], { type: "application/zip" });
    const year = classSectionsPrintYear();
    const label = kind === "teacher" ? "교사별" : kind === "homeroom" ? "담임학급별" : "분반별";
    downloadBlob(zip, `${year}_${context.group.semester}학기_출석부_${label}.zip`);
    classSectionsSetStatus(`출석부 ${label} 파일(zip): 파일 ${bundles.length}개(${kind === "teacher" ? "교사마다" : kind === "homeroom" ? "담임반마다" : "분반마다"}), 분반 ${list.length}개.${note}`, Boolean(warnings.length));
  } catch (error) {
    classSectionsSetStatus(`출석부 zip을 만들지 못했습니다: ${error?.message || error}`, true);
  } finally {
    CLASS_SECTIONS_PRINT_VIEW.busy = false;
  }
}

// ---- 이동 출석부 보기(화면 조회·인쇄) ----
// 보기 범위: 이 그룹 / 이 학기 전체. 고른 분반 = 'groupKey|sectionId'. 표는 엑셀과 같은 시트 모델(classSectionsAttendanceSheet)을 그린다.
function classSectionsAttendanceViewList(round, group) {
  const scope = CLASS_SECTIONS_PRINT_VIEW.attScope === "semester" ? "semester" : "group";
  return classSectionsAttendanceInfos(round, group, scope);
}

function classSectionsAttendanceCurrent(round, group, list) {
  const query = (typeof CLASS_SECTIONS_VIEW !== "undefined" ? CLASS_SECTIONS_VIEW.search || "" : "").trim();
  const student = query ? classSectionsTimetableFindKey(round, group, query) : "";
  const id = (info) => `${info.groupKey}|${info.sectionId}`;
  let index = list.findIndex((info) => id(info) === CLASS_SECTIONS_PRINT_VIEW.attPick);
  // 학생 찾기와 연결: 고른 분반에 그 학생이 없으면 그 학생이 있는 첫 분반으로.
  if (student && !(list[index]?.students || []).some((item) => item.key === student)) {
    const found = list.findIndex((info) => info.students.some((item) => item.key === student));
    if (found >= 0) index = found;
  }
  if (index < 0) index = 0;
  return { index, info: list[index] || null, student, id };
}

function classSectionsAttendanceViewHtml(round, group) {
  if (CLASS_SECTIONS_PRINT_VIEW.attScope === "homeroom") return classSectionsHomeroomViewHtml(round, group);
  const esc = classSectionsPrintEsc;
  const open = CLASS_SECTIONS_PRINT_VIEW.attOpen !== false;
  const { list } = classSectionsAttendanceViewList(round, group);
  if (!list.length) return "";
  const { index, info, student, id } = classSectionsAttendanceCurrent(round, group, list);
  const days = Number(classSectionsPrintOption("attendanceDays")) || 17;
  const sheet = classSectionsAttendanceSheet(info, { days });
  const options = list.map((item, i) => `<option value="${esc(id(item))}"${i === index ? " selected" : ""}>${esc(`${CLASS_SECTIONS_PRINT_VIEW.attScope === "semester" ? `${item.targetGrade}학년 ${item.groupCategory} · ` : ""}${item.roomName} (${item.courseName}, ${item.students.length}명)${student && item.students.some((s) => s.key === student) ? ` ★${student}` : ""}`)}</option>`).join("");
  const retake = classSectionsAttendanceRetake(round, info);
  const inSections = student ? list.filter((item) => item.students.some((s) => s.key === student)).map((item) => item.roomName) : [];
  return `<details class="cs-att-view" id="classSectionsAttendanceView"${open ? " open" : ""}><summary>이동 출석부 보기 <span class="cs-note">${index + 1}/${list.length} · ${esc(info.roomName)}</span></summary>
    <div class="cs-actions">
      ${classSectionsAttendanceScopeHtml(group)}
      <button class="button" id="classSectionsAttendancePrev" type="button" aria-label="앞 분반 출석부"${index <= 0 ? " disabled" : ""}>◀ 앞</button>
      <label>분반 <select id="classSectionsAttendancePick" data-focus-key="cs-att-pick" aria-label="출석부 분반 고르기">${options}</select></label>
      <button class="button" id="classSectionsAttendanceNext" type="button" aria-label="다음 분반 출석부"${index >= list.length - 1 ? " disabled" : ""}>뒤 ▶</button>
      <span class="cs-note">인쇄(분반마다 A4 세로 한 장):</span>
      <button class="button" id="classSectionsAttendancePrintOne" type="button">이 분반 인쇄</button>
      <button class="button" id="classSectionsAttendancePrintGroup" type="button">이 그룹 인쇄</button>
      <button class="button" id="classSectionsAttendancePrintSemester" type="button">${esc(group.semester)}학기 전체 인쇄</button>
    </div>
    ${student ? `<p class="cs-note" id="classSectionsAttendanceStudent">${esc(student)}: ${inSections.length ? `${esc(inSections.join(", "))} 출석부에 있음(표에 강조)` : "이 범위 출석부에 없음"}</p>` : ""}
    ${retake.length ? `<p class="cs-note is-warn" id="classSectionsAttendanceRetake" data-count="${retake.length}">재신청·미배정 ${retake.length}명은 이 출석부(${esc(info.courseName)})에 없습니다: ${esc(retake.slice(0, 12).map((item) => `${item.key}(${item.reason})`).join(", "))}${retake.length > 12 ? " …" : ""}</p>` : ""}
    <div class="cs-att-scroll" data-scroll-key="cs-att">${classSectionsSheetHtml(sheet, { keys: sheet.studentKeys, highlight: student ? [student] : [] }).replace("<table ", '<table id="classSectionsAttendanceTable" ')}</div>
  </details>`;
}

// 이 분반 과목을 신청했지만 미배정·폐강 재신청인 학생(그 그룹 결과에서).
function classSectionsAttendanceRetake(round, info) {
  const entry = classSectionsEntry(round, info.groupKey, false);
  const result = entry?.sectionResult;
  const reasons = typeof CLASS_SECTIONS_UNASSIGNED_REASONS !== "undefined" ? CLASS_SECTIONS_UNASSIGNED_REASONS : {};
  const seen = new Set();
  return [...(result?.unassigned || []), ...(result?.closedRequests || [])]
    .filter((item) => item.courseKey === info.courseKey && item.reason !== "class-unit-other-room" && !seen.has(item.studentKey) && seen.add(item.studentKey))
    .map((item) => ({ key: item.studentKey, reason: reasons[item.reason] || item.reason }))
    .sort((a, b) => a.key.localeCompare(b.key, "ko", { numeric: true }));
}

function classSectionsAttendanceRerender() {
  if (typeof preserveViewDuring === "function" && typeof renderClassSectionsView === "function") return preserveViewDuring(["#workflowStep8Panel"], renderClassSectionsView);
  if (typeof renderClassSections === "function") renderClassSections();
}

function classSectionsAttendanceStep(delta) {
  const context = classSectionsCurrent();
  if (!context?.group) return;
  if (CLASS_SECTIONS_PRINT_VIEW.attScope === "homeroom") {
    const { homerooms } = classSectionsHomeroomData(context.round, context.group);
    const { index } = classSectionsHomeroomCurrent(context.round, context.group, homerooms);
    const next = homerooms[Math.max(0, Math.min(homerooms.length - 1, index + delta))];
    if (!next) return;
    CLASS_SECTIONS_PRINT_VIEW.attPick = next.id;
    if (typeof CLASS_SECTIONS_VIEW !== "undefined") CLASS_SECTIONS_VIEW.search = "";
    return classSectionsAttendanceRerender();
  }
  const { list } = classSectionsAttendanceViewList(context.round, context.group);
  const { index, id } = classSectionsAttendanceCurrent(context.round, context.group, list);
  const next = list[Math.max(0, Math.min(list.length - 1, index + delta))];
  if (!next) return;
  CLASS_SECTIONS_PRINT_VIEW.attPick = id(next);
  if (typeof CLASS_SECTIONS_VIEW !== "undefined") CLASS_SECTIONS_VIEW.search = ""; // 넘기면 학생 찾기 고정을 푼다
  classSectionsAttendanceRerender();
}

// 인쇄: one(고른 분반) / group(이 그룹) / semester(이 학기 전체). 분반마다 .print-page 한 장.
function classSectionsAttendancePrint(kind) {
  const context = classSectionsCurrent();
  const target = typeof document !== "undefined" ? document.getElementById("printBatch") : null;
  if (!context?.group || !target) return;
  const days = Number(classSectionsPrintOption("attendanceDays")) || 17;
  let infos;
  if (kind === "one") {
    const { list } = classSectionsAttendanceViewList(context.round, context.group);
    const { info } = classSectionsAttendanceCurrent(context.round, context.group, list);
    infos = info ? [info] : [];
  } else infos = classSectionsAttendanceInfos(context.round, context.group, kind === "semester" ? "semester" : "group").list;
  if (!infos.length) return void classSectionsSetStatus("인쇄할 출석부가 없습니다.", true);
  target.innerHTML = infos.map((info) => `<div class="print-page cs-att-page">${classSectionsSheetHtml(classSectionsAttendanceSheet(info, { days }))}</div>`).join("");
  classSectionsSetStatus(`출석부 ${infos.length}장(분반마다 한 장)을 인쇄합니다.`);
  if (typeof window !== "undefined" && typeof window.print === "function") window.print();
}

// ---- 담임학급별 출석부(화면·저장·인쇄) ----
// 같은 차수·학기 모든 그룹(학년)의 분반 + 그 학년 학생 전체(신청하지 않은 학생 포함) → 반마다 묶음(classSectionsHomerooms).
function classSectionsHomeroomData(round, group) {
  const compute = () => {
    const { list, warnings } = classSectionsAttendanceInfos(round, group, "semester");
    const source = classSectionsSource(round);
    const settings = classSectionsPrintSettings();
    const names = typeof classSectionsStudentNames === "function" ? classSectionsStudentNames(round) : new Map();
    const reasons = typeof CLASS_SECTIONS_UNASSIGNED_REASONS !== "undefined" ? CLASS_SECTIONS_UNASSIGNED_REASONS : {};
    const roster = new Map();
    const unsubmitted = {}; // 현 학년 → 미제출 수(명렬·배정표가 둘 다 없으면 null = 알 수 없음)
    const rosterInfo = {}; // 현 학년 → { source: "roster"|"map"|null, uploadedAt, notInRoster }
    const gradeItems = new Map();
    const resultKeys = new Set();
    const extras = {};
    const extra = (key) => (extras[key] || (extras[key] = { unit: [], retake: [] }));
    for (const item of source.groups.filter((other) => other.semester === group.semester)) {
      const entry = classSectionsEntry(round, item.key, false);
      const result = entry?.sectionResult;
      if (!result) continue;
      const effective = typeof classSectionsEffectiveClassMap === "function" ? classSectionsEffectiveClassMap(item) : { map: null, basis: "none" };
      if (!gradeItems.has(item.grade)) gradeItems.set(item.grade, { item, effective });
      for (const student of item.gradeStudents || item.students) resultKeys.add(student.key);
      const courseName = new Map(item.courses.map((course) => [course.key, course.name]));
      for (const miss of [...(result.unassigned || []), ...(result.closedRequests || [])]) {
        if (miss.reason === "class-unit-other-room") continue;
        const list = extra(miss.studentKey).retake;
        const name = courseName.get(miss.courseKey) || miss.courseKey;
        if (!list.some((x) => x.courseName === name)) list.push({ courseName: name, reason: reasons[miss.reason] || miss.reason });
      }
      const unitCourses = item.courses.filter((course) => classSectionsCourseConf(settings, "courseModes", item.grade)[course.key] === "class");
      if (unitCourses.length && effective.map && typeof classSectionsClassUnitPlan === "function") {
        const plan = classSectionsClassUnitPlan(item, entry, settings);
        for (const student of item.gradeStudents || item.students) {
          const unitKey = plan.assign[String(effective.map[student.key]?.classroom || "")];
          if (unitKey) extra(student.key).unit.push(courseName.get(unitKey) || unitKey);
        }
      }
    }
    // 학년마다 담임반 명단: 명렬(현 학년 전체, 이 PC에 저장) > 내년 반 배정표 > 차수 결과(제출한 학생만).
    // 결과에 없는 학생 = 미제출. 내년 반: 배정표 반 > '그대로 올라감'이면 지금 반 > 미정. 성명: 결과 > 명렬.
    for (const [grade, { item, effective }] of gradeItems) {
      const listed = typeof applicationRosterFor === "function" ? applicationRosterFor(grade) : null;
      const uploaded = typeof classSectionsClassMap === "function" ? classSectionsClassMap(grade) : null;
      const same = effective.basis === "same";
      const rosterName = new Map((listed?.students || []).map((student) => [student.key, student.name || ""]));
      const keys = new Set([...resultKeys].filter((key) => key.startsWith(`${grade}-`)));
      const base = listed ? listed.students.map((student) => student.key) : uploaded ? Object.keys(uploaded).filter((key) => key.startsWith(`${grade}-`)) : [];
      for (const key of base) keys.add(key);
      let missing = 0;
      for (const key of [...keys].sort((a, b) => a.localeCompare(b, "ko", { numeric: true }))) {
        const inResult = resultKeys.has(key);
        const next = uploaded ? uploaded[key] : same ? { classroom: key.split("-")[1], number: "" } : null;
        if (!inResult && (listed || uploaded)) missing += 1;
        roster.set(key, { key, grade, targetGrade: item.targetGrade, classroom: next?.classroom || "", number: next?.number || "", name: names.get(key) || rosterName.get(key) || "",
          basis: next?.classroom ? (uploaded ? "map" : "same") : "none", unsubmitted: !inResult && Boolean(listed || uploaded) });
      }
      unsubmitted[grade] = listed || uploaded ? missing : null;
      rosterInfo[grade] = { source: listed ? "roster" : uploaded ? "map" : null, uploadedAt: listed?.uploadedAt || "",
        notInRoster: listed ? [...resultKeys].filter((key) => key.startsWith(`${grade}-`) && !rosterName.has(key)).length : 0 };
    }
    const homerooms = classSectionsHomerooms(list, [...roster.values()], extras);
    for (const homeroom of homerooms) {
      const info = rosterInfo[homeroom.grade];
      const date = info?.uploadedAt ? new Date(info.uploadedAt).toLocaleDateString("ko-KR") : "";
      homeroom.rosterBasis = info?.source === "roster" ? `명렬 ${date} 기준`.replace("  ", " ") : info?.source === "map" ? "내년 반 배정표 기준" : "미제출 확인 불가(명렬 없음)";
    }
    return { list, warnings, unsubmitted, rosterInfo, homerooms };
  };
  return typeof cachedByStateRevision === "function" ? cachedByStateRevision("classSectionsHomeroomData", `${round}|${group.semester}|${typeof $ === "function" ? $("#schoolYear")?.value || "" : ""}`, compute) : compute();
}

function classSectionsAttendanceScopeHtml(group) {
  const esc = classSectionsPrintEsc;
  const scope = CLASS_SECTIONS_PRINT_VIEW.attScope || "group";
  return `<label>범위 <select id="classSectionsAttendanceScope" data-focus-key="cs-att-scope" aria-label="출석부 보기 범위"><option value="group">이 그룹(분반별)</option><option value="semester"${scope === "semester" ? " selected" : ""}>${esc(group.semester)}학기 전체(분반별)</option><option value="homeroom"${scope === "homeroom" ? " selected" : ""}>담임반별</option></select></label>`;
}

function classSectionsHomeroomCurrent(round, group, homerooms) {
  const query = (typeof CLASS_SECTIONS_VIEW !== "undefined" ? CLASS_SECTIONS_VIEW.search || "" : "").trim();
  const student = query ? classSectionsTimetableFindKey(round, group, query) : "";
  let index = homerooms.findIndex((item) => item.id === CLASS_SECTIONS_PRINT_VIEW.attPick);
  if (student && !(homerooms[index]?.students || []).some((item) => item.key === student)) {
    const found = homerooms.findIndex((item) => item.students.some((s) => s.key === student));
    if (found >= 0) index = found;
  }
  if (index < 0) index = Math.max(0, homerooms.findIndex((item) => item.grade === group.grade));
  return { index, homeroom: homerooms[index] || null, student };
}

function classSectionsHomeroomViewHtml(round, group) {
  const esc = classSectionsPrintEsc;
  const open = CLASS_SECTIONS_PRINT_VIEW.attOpen !== false;
  const { homerooms, unsubmitted, rosterInfo } = classSectionsHomeroomData(round, group);
  if (!homerooms.length) return "";
  const { index, homeroom, student } = classSectionsHomeroomCurrent(round, group, homerooms);
  const gradeUnsub = unsubmitted?.[homeroom.grade];
  const sheet = classSectionsHomeroomStatusSheet(homeroom);
  const options = homerooms.map((item, i) => `<option value="${esc(item.id)}"${i === index ? " selected" : ""}>${esc(`${item.label} (${item.students.length}명, 분반 ${item.sections.length})`)}</option>`).join("");
  const retake = homeroom.students.filter((item) => item.retake.length).length;
  return `<details class="cs-att-view" id="classSectionsAttendanceView"${open ? " open" : ""}><summary>이동 출석부 보기 <span class="cs-note">담임반 ${index + 1}/${homerooms.length} · ${esc(homeroom.label)}</span></summary>
    <div class="cs-actions">
      ${classSectionsAttendanceScopeHtml(group)}
      <button class="button" id="classSectionsAttendancePrev" type="button" aria-label="앞 담임반"${index <= 0 ? " disabled" : ""}>◀ 앞</button>
      <label>담임반 <select id="classSectionsHomeroomPick" data-focus-key="cs-hr-pick" aria-label="담임반 고르기">${options}</select></label>
      <button class="button" id="classSectionsAttendanceNext" type="button" aria-label="다음 담임반"${index >= homerooms.length - 1 ? " disabled" : ""}>뒤 ▶</button>
      <span class="cs-note">인쇄(반마다 A4 가로 + 그 반 학생 분반 출석부):</span>
      <button class="button" id="classSectionsHomeroomPrintOne" type="button">이 반 인쇄</button>
      <button class="button" id="classSectionsHomeroomPrintGrade" type="button">${esc(homeroom.basis === "none" ? `현 ${homeroom.grade}학년` : `${homeroom.targetGrade}학년`)} 전체 인쇄</button>
    </div>
    ${homeroom.basis === "none" ? '<p class="cs-note is-warn" id="classSectionsHomeroomBasis">내년 반 미정 — 현재 반 기준입니다(내년 반 배정표를 올리거나 진급 반 편성을 ‘그대로 올라감’으로 하면 내년 반으로 묶음).</p>' : ""}
    ${classSectionsHomeroomRosterNote(homeroom, gradeUnsub, rosterInfo?.[homeroom.grade])}
    ${retake ? `<p class="cs-note is-warn" id="classSectionsHomeroomRetake" data-count="${retake}">이 반 재신청·미배정 학생 ${retake}명(표 맨 오른쪽 칸)</p>` : ""}
    <div class="cs-att-scroll" data-scroll-key="cs-hr">${classSectionsSheetHtml(sheet, { keys: sheet.studentKeys, highlight: student ? [student] : [] }).replace("<table ", '<table id="classSectionsHomeroomTable" ')}</div>
    ${classSectionsHandoutViewHtml(round, group, homeroom, student)}
  </details>`;
}

// 담임반 화면 요약: 이 반 학생·미제출, 근거(명렬 날짜·배정표), 명렬에 없는 학생, 근거가 없으면 '명렬 올리기'.
function classSectionsHomeroomRosterNote(homeroom, gradeUnsub, info) {
  const esc = classSectionsPrintEsc;
  const grade = esc(homeroom.grade);
  const date = info?.uploadedAt ? new Date(info.uploadedAt).toLocaleDateString("ko-KR") : "";
  const basis = info?.source === "roster" ? `명렬${date ? ` ${date}` : ""} 기준` : info?.source === "map" ? "내년 반 배정표 기준" : "";
  const upload = typeof importApplicationRosterFile === "function"
    ? ` <label class="button">명렬 올리기(이 PC에만 저장)<input id="classSectionsRosterInput" type="file" accept=".xlsx" data-grade="${grade}" hidden></label>` : "";
  const unknown = gradeUnsub === null;
  return `<p class="cs-note${homeroom.unsubmitted || unknown ? " is-warn" : ""}" id="classSectionsHomeroomUnsubmitted" data-count="${homeroom.unsubmitted || 0}" data-basis="${esc(info?.source || "none")}">이 반 학생 ${homeroom.students.length}명 · ${unknown ? "미제출 확인 불가" : `미제출 ${homeroom.unsubmitted || 0}명`}${unknown
    ? ` — 현 ${grade}학년 명렬·내년 반 배정표가 없어 미제출 학생은 알 수 없습니다(웹 신청 결과에는 제출한 학생만 옵니다). 명렬을 올리면 반 명단에 넣습니다.${upload}`
    : ` (현 ${grade}학년 미제출 ${gradeUnsub}명 · ${esc(basis)}${info?.notInRoster ? ` · 명렬에 없는 학생 ${info.notInRoster}명(전입 등, 그대로 넣음)` : ""})`}</p>`;
}

// 담임반 인쇄: one(이 반) / grade(같은 학년 모든 반). 반마다 ① 현황(A4 가로) + ② 그 반 학생 분반 출석부(A4 세로).
function classSectionsHomeroomPrint(kind) {
  const context = classSectionsCurrent();
  const target = typeof document !== "undefined" ? document.getElementById("printBatch") : null;
  if (!context?.group || !target) return;
  const { homerooms } = classSectionsHomeroomData(context.round, context.group);
  const { homeroom } = classSectionsHomeroomCurrent(context.round, context.group, homerooms);
  if (!homeroom) return void classSectionsSetStatus("인쇄할 담임반이 없습니다.", true);
  const chosen = kind === "grade" ? homerooms.filter((item) => item.grade === homeroom.grade && (item.basis === "none") === (homeroom.basis === "none")) : [homeroom];
  const days = Number(classSectionsPrintOption("attendanceDays")) || 17;
  let sheets = 0;
  let statusPages = 0;
  const overflow = [];
  target.innerHTML = chosen.map((item) => {
    const attendance = classSectionsHomeroomAttendanceSheets(item, { days });
    const pages = classSectionsHomeroomStatusPages(item);
    statusPages += pages.length;
    if (pages[0]?.printPlan?.overflow || pages.length > 2) overflow.push(`${item.label} ${pages.length}쪽`);
    sheets += pages.length + attendance.length;
    const id = classSectionsPrintEsc(item.id);
    return pages.map((sheet) => `<div class="print-page cs-hr-page" data-homeroom="${id}" data-page="${sheet.pageLabel}"><div class="cs-hr-pageno">${sheet.pageLabel}</div>${classSectionsSheetHtml(sheet)}</div>`).join("")
      + attendance.map((sheet) => `<div class="print-page cs-att-page" data-homeroom="${id}">${classSectionsSheetHtml(sheet)}</div>`).join("");
  }).join("");
  classSectionsSetStatus(`담임반 ${chosen.length}개(현황 ${statusPages}쪽 + 분반 출석부 ${sheets - statusPages}장)를 인쇄합니다.${overflow.length ? ` 블록 열이 많아 세 쪽 이상: ${overflow.join(", ")}.` : ""}`);
  if (typeof window !== "undefined" && typeof window.print === "function") window.print();
}

// ---- 학생 배부용 쪽지(화면 미리 보기·인쇄) ----
// 담임반 묶음을 학기마다(계산 결과가 있는 학기) 만들어 같은 반(id)끼리 모은다. kind: one(이 반) / grade(같은 학년·같은 기준 모든 반).
function classSectionsHandoutSemesters(round, group) {
  const semesters = typeof classSectionsTimetableSemesters === "function" ? classSectionsTimetableSemesters(round, group) : [group.semester];
  return (semesters.length ? semesters : [group.semester]).map((semester) => ({ semester, data: classSectionsHomeroomData(round, { ...group, semester }) }));
}

function classSectionsHandoutSlipsFor(round, group, kind) {
  const { homerooms } = classSectionsHomeroomData(round, group);
  const { homeroom } = classSectionsHomeroomCurrent(round, group, homerooms);
  if (!homeroom) return { homeroom: null, slips: [], rooms: 0 };
  const ids = kind === "grade"
    ? homerooms.filter((item) => item.grade === homeroom.grade && (item.basis === "none") === (homeroom.basis === "none")).map((item) => item.id) : [homeroom.id];
  const bySemester = classSectionsHandoutSemesters(round, group);
  const slips = [];
  for (const id of ids) {
    const semesters = bySemester.map(({ semester, data }) => ({ semester, homeroom: data.homerooms.find((item) => item.id === id) || null }));
    slips.push(...classSectionsHandoutSlips(semesters, { year: homeroom.year }));
  }
  return { homeroom, slips, rooms: ids.length };
}

// 쪽지 실제 높이 재기(화면 밖 상자, 인쇄와 같은 .cs-ho 규칙). DOM이 없으면 null → 어림.
function classSectionsHandoutMeasurer() {
  if (typeof document === "undefined" || typeof document.createElement !== "function" || !document.body) return null;
  const box = document.createElement("div");
  box.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden;";
  document.body.appendChild(box);
  const measure = (slip, pt, widthMm) => {
    box.style.width = `${widthMm}mm`;
    box.style.setProperty("--ho-font", `${pt}pt`);
    box.innerHTML = classSectionsHandoutHtml(slip);
    const el = box.firstElementChild;
    if (!el) return 0;
    el.style.height = "auto";
    return (el.getBoundingClientRect().height * 25.4) / 96;
  };
  measure.done = () => box.remove();
  return measure;
}

function classSectionsHandoutLayoutFor(slips, per) {
  const measure = classSectionsHandoutMeasurer();
  try { return classSectionsHandoutLayout(slips, per, measure ? { measure } : {}); } finally { measure?.done?.(); }
}

function classSectionsHandoutPer() {
  const value = Number(classSectionsPrintOption("handoutPer"));
  return CLASS_SECTIONS_HANDOUT.per.includes(value) ? value : CLASS_SECTIONS_HANDOUT.defaultPer;
}

// 담임반 보기 아래 쪽지 줄: 한 장에 n장 · 이 반/학년 인쇄 · 인쇄 전 경고 · 미리 보기(학생 찾기에 있으면 그 학생, 아니면 이 반 첫 학생).
function classSectionsHandoutViewHtml(round, group, homeroom, student) {
  const esc = classSectionsPrintEsc;
  const { slips } = classSectionsHandoutSlipsFor(round, group, "one");
  if (!slips.length) return "";
  const per = classSectionsHandoutPer();
  const layout = classSectionsHandoutLayoutFor(slips, per);
  const slip = slips.find((item) => item.key === student) || slips[0];
  const warnings = classSectionsOutputWarnings(round, group);
  const gradeLabel = homeroom.basis === "none" ? `현 ${homeroom.grade}학년` : `${homeroom.targetGrade}학년`;
  return `<div class="cs-ho-box" id="classSectionsHandout" data-per="${per}" data-font="${layout.fontPt}" data-ok="${layout.ok ? 1 : 0}">
    <div class="cs-actions">
      <span class="cs-note">학생 배부용 이동수업 안내(학생마다 1·2학기 한 쪽지, A4 세로에 자르는 선):</span>
      <label>한 장에 <select id="classSectionsHandoutPer" data-focus-key="cs-ho-per" aria-label="한 장에 쪽지 수">${CLASS_SECTIONS_HANDOUT.per.map((n) => `<option value="${n}"${n === per ? " selected" : ""}>${n}장</option>`).join("")}</select></label>
      <button class="button" id="classSectionsHandoutPrintOne" type="button"${layout.ok ? "" : " disabled"}>학생 배부용 인쇄(이 반)</button>
      <button class="button" id="classSectionsHandoutPrintGrade" type="button"${layout.ok ? "" : " disabled"}>학생 배부용 인쇄(${esc(gradeLabel)} 전체)</button>
      <span class="cs-note">이 반 ${slips.length}명 → ${Math.ceil(slips.length / per)}장 · 글자 ${layout.fontPt}pt · ${layout.cols === 2 ? "2열" : "1열"}</span>
    </div>
    ${layout.ok ? "" : `<p class="cs-note is-warn" id="classSectionsHandoutBlocked">${esc(layout.message)}</p>`}
    ${warnings.length ? `<ul class="cs-list is-error" id="classSectionsHandoutWarnings">${warnings.map((item) => `<li data-type="${item.type}">인쇄 전 확인: ${esc(item.message)}</li>`).join("")}</ul>` : ""}
    <div class="cs-ho-preview" id="classSectionsHandoutPreview" data-student="${esc(slip.key)}">${classSectionsHandoutHtml(slip)}</div>
  </div>`;
}

function classSectionsHandoutPrint(kind) {
  const context = classSectionsCurrent();
  const target = typeof document !== "undefined" ? document.getElementById("printBatch") : null;
  if (!context?.group || !target) return;
  const { slips, rooms } = classSectionsHandoutSlipsFor(context.round, context.group, kind);
  if (!slips.length) return void classSectionsSetStatus("인쇄할 학생이 없습니다.", true);
  const layout = classSectionsHandoutLayoutFor(slips, classSectionsHandoutPer());
  if (!layout.ok) return void classSectionsSetStatus(layout.message, true);
  const pages = classSectionsHandoutPagesHtml(slips, layout);
  target.innerHTML = pages.join("");
  const unsubmitted = slips.filter((slip) => slip.unsubmitted).length;
  classSectionsSetStatus(`학생 배부용 이동수업 안내: 반 ${rooms}개 · ${slips.length}명(${pages.length}장, 한 장에 ${layout.per}장 · 글자 ${layout.fontPt}pt)${unsubmitted ? ` · 미제출 ${unsubmitted}명` : ""}을 인쇄합니다.`);
  if (typeof window !== "undefined" && typeof window.print === "function") window.print();
}

// 교사·시간 설정 창의 교실 칸(학년별 교실 수·이름, 특별실 이름, 다른 교실).
function classSectionsRoomSettingsHtml(settings) {
  const esc = classSectionsPrintEsc;
  const s = classSectionsPrintSettings();
  const round = (typeof CLASS_SECTIONS_VIEW !== "undefined" && CLASS_SECTIONS_VIEW.round) || (typeof classSectionsDefaultRound === "function" ? classSectionsDefaultRound() : "");
  const counts = round ? classSectionsGradeClassCounts(classSectionsSource(round)) : {};
  const grades = [...new Set([...Object.keys(counts), ...Object.keys(s.classrooms)])].sort();
  const gradeRows = grades.map((grade) => {
    const conf = s.classrooms[grade] || {};
    return `<tr><th scope="row">${esc(grade)}학년</th>
      <td><input class="cs-num" type="number" min="0" max="40" value="${esc(conf.count ?? "")}" placeholder="${esc(counts[grade] || "")}" data-cs-classroom-count="${esc(grade)}" data-focus-key="cs-classroom-count-${esc(grade)}" aria-label="${esc(grade)}학년 교실 수"></td>
      <td><input class="cs-text cs-wide" type="text" value="${esc(conf.names || "")}" placeholder="${esc(`${grade}-1, ${grade}-2, …`)}" data-cs-classroom-names="${esc(grade)}" data-focus-key="cs-classroom-names-${esc(grade)}" aria-label="${esc(grade)}학년 교실 이름(쉼표로 구분, 순서 = 반)"></td></tr>`;
  }).join("");
  const specialRows = Object.entries(s.rooms || {}).map(([type, count]) => `<tr><th scope="row">${esc(type)}</th><td>${esc(count)}개</td>
      <td><input class="cs-text cs-wide" type="text" value="${esc(s.roomNames[type] || "")}" placeholder="${esc((typeof classSectionsDefaultRoomNames === "function" ? classSectionsDefaultRoomNames(type, count) : []).join(", "))}" data-cs-room-names="${esc(type)}" data-focus-key="cs-room-names-${esc(type)}" aria-label="${esc(type)} 이름(쉼표로 구분)"></td></tr>`).join("");
  return `<section id="classSectionsRoomSettings"><h3>교실 <span class="cs-note">분반 → 교실 배정 추천(수강생이 가장 많은 내년 반 교실, 특별실 과목은 특별실)</span></h3>
    <table class="cs-table"><thead><tr><th>수업 학년</th><th>교실 수</th><th>이름(비우면 기본)</th></tr></thead><tbody>${gradeRows || '<tr><td colspan="3">편성할 그룹이 없습니다.</td></tr>'}</tbody></table>
    <table class="cs-table"><thead><tr><th>특별실</th><th>수</th><th>이름(넣으면 수도 바뀜)</th></tr></thead><tbody>${specialRows || '<tr><td colspan="3">특별실이 없습니다. 위 ‘특별실 수’에 과학실=2처럼 넣고, 과목 표의 특별실 칸에 그 이름을 쓰세요.</td></tr>'}</tbody></table>
    <div class="cs-fields"><label>다른 교실(모자랄 때) <input class="cs-text cs-wide" type="text" id="classSectionsExtraRooms" value="${esc(s.extraRooms || "")}" placeholder="다목적실, 세미나실" data-focus-key="cs-extra-rooms" aria-label="학년 교실이 모자랄 때 쓸 다른 교실(쉼표로 구분)"></label></div>
  </section>`;
}

function classSectionsRoomSettingsEvent(event) {
  if (event.type !== "change") return;
  const target = event.target;
  const data = target.dataset || {};
  const s = classSectionsPrintSettings();
  if (data.csClassroomCount !== undefined) {
    const conf = s.classrooms[data.csClassroomCount] || (s.classrooms[data.csClassroomCount] = {});
    if (target.value === "") delete conf.count; else conf.count = Math.max(0, Number(target.value) || 0);
  } else if (data.csClassroomNames !== undefined) {
    const conf = s.classrooms[data.csClassroomNames] || (s.classrooms[data.csClassroomNames] = {});
    conf.names = target.value.trim();
  } else if (data.csRoomNames !== undefined) {
    const value = target.value.trim();
    if (value) { s.roomNames[data.csRoomNames] = value; s.rooms[data.csRoomNames] = classSectionsSplitNames(value).length; } else delete s.roomNames[data.csRoomNames];
  } else if (target.id === "classSectionsExtraRooms") s.extraRooms = target.value.trim();
  else return;
  if (typeof persistStateSoon === "function") persistStateSoon(); else if (typeof persistState === "function") persistState();
  if (typeof renderClassSectionsTeachers === "function") {
    if (typeof preserveViewDuring === "function") preserveViewDuring(["#classSectionsTeacherDialog"], renderClassSectionsTeachers); else renderClassSectionsTeachers();
  }
}

function classSectionsPrintHandleChange(event) {
  const target = event.target;
  const s = classSectionsPrintSettings();
  if (target.dataset?.csRoomNew !== undefined) {
    const name = target.value.trim();
    const result = classSectionsCurrent()?.entry?.sectionResult;
    if (!name || !result) return;
    const extras = classSectionsSplitNames(s.extraRooms);
    if (!extras.includes(name)) s.extraRooms = [...extras, name].join(", ");
    if (!result.roomPins || typeof result.roomPins !== "object") result.roomPins = {};
    result.roomPins[target.dataset.csRoomNew] = name;
    classSectionsSetStatus(`'${name}' 교실을 다른 교실 목록에 넣고 ${target.dataset.csRoomNew.split("#")[0]} 분반에 배정했습니다.`);
  } else if (target.dataset?.csRoomPick !== undefined) {
    const context = classSectionsCurrent();
    const result = context?.entry?.sectionResult;
    if (!result) return;
    if (!result.roomPins || typeof result.roomPins !== "object") result.roomPins = {};
    const before = { ...(classSectionsRoomPlan(context.round, context.group.semester)?.assign?.[context.group.key] || {}) };
    if (target.value) result.roomPins[target.dataset.csRoomPick] = target.value; else delete result.roomPins[target.dataset.csRoomPick];
    const plan = classSectionsRoomPlan(context.round, context.group.semester);
    const clash = (plan?.issues || []).filter((issue) => issue.severity === "error" && (issue.sectionId === target.dataset.csRoomPick || issue.otherSectionId === target.dataset.csRoomPick));
    // 직접 고른 교실을 쓰던 다른 분반은 자동으로 다른 교실로 옮겨진다(고정한 분반끼리만 겹침).
    const label = (id) => plan?.roomById?.get(id)?.label || id;
    const moved = result.sections.filter((section) => section.id !== target.dataset.csRoomPick && before[section.id] && plan?.assign?.[context.group.key]?.[section.id] !== before[section.id])
      .map((section) => `${section.roomName} ${label(before[section.id])} → ${label(plan.assign[context.group.key][section.id] || "미정")}`);
    classSectionsSetStatus(clash.length ? `교실 겹침: ${clash.map((issue) => issue.message).join(" / ")}`
      : `${target.value ? `${label(target.value)} 교실로 바꿨습니다.` : "교실을 자동 추천으로 되돌렸습니다."}${moved.length ? ` 함께 옮긴 분반: ${moved.join(", ")}` : ""}`, clash.length > 0);
  } else if (target.id === "classSectionsAttendanceDays") s.print.attendanceDays = Math.max(1, Math.min(40, Number(target.value) || 17));
  else if (target.id === "classSectionsTimetableClass") { CLASS_SECTIONS_PRINT_VIEW.timetableClass = target.value; return; }
  else if (target.id === "classSectionsRosterInput") {
    const file = target.files?.[0];
    if (!file || typeof importApplicationRosterFile !== "function") return;
    target.value = "";
    // app.js importApplicationRosterFile → Promise<{ count, message }>(실패하면 count 0, message에 이유)
    return void Promise.resolve(importApplicationRosterFile(file, target.dataset.grade)).then((done) => {
      classSectionsSetStatus(done?.message || (done?.count ? `명렬 ${done.count}명을 저장했습니다.` : "명렬을 저장하지 못했습니다."), !(done?.count > 0));
      classSectionsAttendanceRerender();
    }, (error) => classSectionsSetStatus(`명렬을 올리지 못했습니다: ${error?.message || error}`, true));
  }
  else if (target.id === "classSectionsHomeroomPick") { CLASS_SECTIONS_PRINT_VIEW.attPick = target.value; return void classSectionsAttendanceRerender(); }
  else if (target.id === "classSectionsAttendancePick") { CLASS_SECTIONS_PRINT_VIEW.attPick = target.value; return void classSectionsAttendanceRerender(); }
  else if (target.id === "classSectionsAttendanceScope") { CLASS_SECTIONS_PRINT_VIEW.attScope = ["semester", "homeroom"].includes(target.value) ? target.value : "group"; CLASS_SECTIONS_PRINT_VIEW.attPick = ""; return void classSectionsAttendanceRerender(); }
  else if (target.id === "classSectionsHandoutPer") {
    s.print.handoutPer = CLASS_SECTIONS_HANDOUT.per.includes(Number(target.value)) ? Number(target.value) : CLASS_SECTIONS_HANDOUT.defaultPer;
    if (typeof classSectionsChanged === "function") classSectionsChanged();
    return void classSectionsAttendanceRerender();
  }
  else if (target.id === "classSectionsTimetablePerPage") s.print.perPage = [1, 2].includes(Number(target.value)) ? Number(target.value) : 1;
  else if (target.id === "classSectionsTimetableFill") s.print.timetableFill = target.value === "학급 수업" ? "학급 수업" : "";
  else return;
  if (typeof classSectionsChanged === "function") classSectionsChanged();
}

function classSectionsPrintHandleClick(event) {
  const button = event.target.closest?.("button");
  if (!button) return;
  // 6단계 화면의 블록표·명렬표·나이스 내보내기(class-sections-view.js가 먼저 처리)와 이 파일의 출력물 단추: 끝나면 경고를 상태 줄에 붙인다.
  if (/^classSections(ExportBlocks|ExportRosters|ExportNeis|Attendance(File|All|Teacher|Group|Homeroom|HomeroomFile|PrintOne|PrintGroup|PrintSemester)|Homeroom(PrintOne|PrintGrade)|Handout(PrintOne|PrintGrade)|Timetable(Print|Excel))$/.test(button.id)) {
    setTimeout(classSectionsWarnAfterOutput, 0);
  }
  if (button.id === "classSectionsAttendanceGroup") return void classSectionsAttendanceExport("group");
  if (button.id === "classSectionsAttendanceTeacher") return void classSectionsAttendanceExport("teacher");
  if (button.id === "classSectionsAttendanceAll") return void classSectionsAttendanceExport("sections");
  if (button.id === "classSectionsAttendanceFile") return void classSectionsAttendanceExport("file");
  if (button.id === "classSectionsAttendanceHomeroom") return void classSectionsAttendanceExport("homeroom");
  if (button.id === "classSectionsAttendanceHomeroomFile") return void classSectionsAttendanceExport("homeroomFile");
  if (button.id === "classSectionsHomeroomPrintOne") return classSectionsHomeroomPrint("one");
  if (button.id === "classSectionsHomeroomPrintGrade") return classSectionsHomeroomPrint("grade");
  if (button.id === "classSectionsHandoutPrintOne") return classSectionsHandoutPrint("one");
  if (button.id === "classSectionsHandoutPrintGrade") return classSectionsHandoutPrint("grade");
  if (button.id === "classSectionsAttendancePrev" || button.id === "classSectionsAttendanceNext") return classSectionsAttendanceStep(button.id === "classSectionsAttendanceNext" ? 1 : -1);
  if (button.id === "classSectionsAttendancePrintOne") return classSectionsAttendancePrint("one");
  if (button.id === "classSectionsAttendancePrintGroup") return classSectionsAttendancePrint("group");
  if (button.id === "classSectionsAttendancePrintSemester") return classSectionsAttendancePrint("semester");
  if (button.id === "classSectionsTimetablePrint") return classSectionsTimetablePrint();
  if (button.id === "classSectionsTimetableExcel") return classSectionsTimetableExcel();
  if (button.id === "classSectionsRoomReset") {
    const result = classSectionsCurrent()?.entry?.sectionResult;
    if (result) result.roomPins = {};
    classSectionsSetStatus("이 그룹 교실을 모두 자동 추천으로 되돌렸습니다.");
    if (typeof classSectionsChanged === "function") classSectionsChanged();
  }
}

function initClassSectionsPrint() {
  const content = document.getElementById("classSectionsContent");
  if (!content || content.dataset.printReady) return;
  content.dataset.printReady = "1";
  content.addEventListener("change", classSectionsPrintHandleChange);
  content.addEventListener("click", classSectionsPrintHandleClick);
  // 출석부 보기 접힘 상태 기억(toggle은 거품이 없어 잡기 단계로 받음)
  content.addEventListener("toggle", (event) => { if (event.target?.id === "classSectionsAttendanceView") CLASS_SECTIONS_PRINT_VIEW.attOpen = event.target.open; }, true);
  document.getElementById("classSectionsTeacherDialog")?.addEventListener("change", classSectionsRoomSettingsEvent);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initClassSectionsPrint);
  else initClassSectionsPrint();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { classSectionsAttendanceSheet, classSectionsAttendanceFileName, classSectionsAttendanceBundles, classSectionsStudentTimetable, classSectionsSheetHtml, classSectionsAttendanceListSheet, classSectionsAttendanceSheetNames, classSectionsHomerooms, classSectionsHomeroomStatusSheet, classSectionsHomeroomAttendanceSheets,
    classSectionsHomeroomStatusLayout, classSectionsHomeroomStatusPlan, classSectionsHomeroomStatusPages, classSectionsTextLines,
    classSectionsHandoutSlips, classSectionsHandoutLayout, classSectionsHandoutHtml, classSectionsHandoutPagesHtml, classSectionsHandoutHeight,
    classSectionsTimetableHtml, classSectionsTimetableSheet, classSectionsStudentTimetableYear, classSectionsRoomSpecFromSettings };
}
