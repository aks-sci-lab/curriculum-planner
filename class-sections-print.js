"use strict";
// 6단계 분반 편성 출력물: ④ 분반 → 교실 배정(화면·설정), ② 이동 출석부(엑셀), ③ 학생 개인 이동수업 시간표(미리 보기·인쇄·엑셀).
// class-sections.js(순수 계산, 교실 배정 classSectionsAssignRooms) · class-sections-view.js(입력 모으기·결과 화면) 뒤에 로드한다.
// 위쪽은 순수 계산(DOM·state 없음, 테스트에서 vm으로 올림) → `// ---- 앱 연결 ----` 아래 화면 연결.
// 개인정보: 저장하는 것은 교실 직접 고른 값(분반 id → 교실 이름)과 출력 설정뿐. 성명은 내보낼 때 차수 자료에서 읽어 파일·인쇄에만 쓴다.

var CLASS_SECTIONS_PRINT_DEFAULTS = { attendanceDays: 17, timetableFill: "", perPage: 2 };

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
  const subtitle = `${info.year}학년도 ${info.semester}학기 · 현 ${info.grade}학년 → ${info.targetGrade}학년 · ${students.length}명`;
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

// 시간표 하나 HTML(화면 미리 보기·인쇄 공용).
function classSectionsTimetableHtml(model) {
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
  const width = 1 + Math.max(5, ...models.map((model) => model.days.length));
  const last = classSectionsPrintColumn(width - 1);
  for (const model of models) {
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
  const clash = (plan.issues || []).some((issue) => issue.severity === "error" && ((issue.groupId === group.key && (issue.sectionId === section.id || (issue.sectionIds || []).includes(section.id))) || (issue.otherGroupId === group.key && issue.otherSectionId === section.id)));
  const usable = plan.rooms.filter((item) => item.kind !== "class" || item.grade === group.targetGrade);
  const options = usable.map((item) => `<option value="${esc(item.id)}"${pinned === item.id ? " selected" : ""}>${esc(item.label)}</option>`).join("");
  return `<span class="cs-room${clash ? " is-clash" : ""}" data-room-id="${esc(roomId)}" title="${esc(reason || "")}">교실 <select data-cs-room-pick="${esc(section.id)}" data-focus-key="cs-room-pick-${esc(section.id)}" aria-label="${esc(section.roomName)} 교실">
    <option value="">${pinned ? "자동으로 되돌리기" : room ? `자동(${esc(room.label)})` : "자동(미정)"}</option>${options}</select></span>`;
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
  const perPage = Number(classSectionsPrintOption("perPage")) || 2;
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
    <div class="cs-actions">
      <span class="cs-note">출석부 저장(${esc(group.semester)}학기):</span>
      <button class="button" id="classSectionsAttendanceFile" type="button" title="${esc(group.semester)}학기 모든 그룹·분반을 한 엑셀에(맨 앞 '목록' 시트 + 분반마다 시트)">출석부 전체 파일</button>
      <button class="button" id="classSectionsAttendanceAll" type="button" title="${esc(group.semester)}학기 분반(이동 학급)마다 파일 하나, zip으로 묶음">출석부 학급별 파일(zip)</button>
      <button class="button" id="classSectionsAttendanceTeacher" type="button" title="${esc(group.semester)}학기 · 교사마다 파일 하나(zip)">출석부 교사별(zip)</button>
      <button class="button" id="classSectionsAttendanceGroup" type="button" title="이 그룹만 · 분반마다 시트 하나">출석부 이 그룹 파일</button>
      <label>날짜 칸 <input class="cs-num" type="number" min="1" max="40" id="classSectionsAttendanceDays" value="${esc(classSectionsPrintOption("attendanceDays"))}" data-focus-key="cs-att-days" aria-label="출석부 날짜 칸 수"></label>
    </div>
    ${classSectionsAttendanceViewHtml(round, group)}
    <div class="cs-actions">
      <label>시간표 반 <select id="classSectionsTimetableClass" data-focus-key="cs-tt-class" aria-label="학생 시간표 인쇄할 반(현 반)"><option value="">전체</option>${homerooms.map((room) => `<option value="${esc(room)}"${CLASS_SECTIONS_PRINT_VIEW.timetableClass === room ? " selected" : ""}>현 ${esc(group.grade)}학년 ${esc(room)}반</option>`).join("")}</select></label>
      <label>한 장에 <select id="classSectionsTimetablePerPage" data-focus-key="cs-tt-per" aria-label="한 장에 학생 수">${[2, 3, 4].map((n) => `<option value="${n}"${perPage === n ? " selected" : ""}>${n}명</option>`).join("")}</select></label>
      <label>빈 칸 <select id="classSectionsTimetableFill" data-focus-key="cs-tt-fill" aria-label="이동 수업이 아닌 칸에 쓸 글자"><option value=""${fill ? "" : " selected"}>비움</option><option value="학급 수업"${fill === "학급 수업" ? " selected" : ""}>학급 수업</option></select></label>
      <button class="button" id="classSectionsTimetablePrint" type="button">학생 시간표 인쇄</button>
      <button class="button" id="classSectionsTimetableExcel" type="button">학생 시간표 엑셀</button>
      <span class="cs-note">현 ${esc(group.grade)}학년 ${esc(group.semester)}학기 모든 그룹을 합친 학생별 시간표 · 학생 찾기에 '${esc(group.grade)}-3-12'처럼 넣으면 미리 보기</span>
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
  for (const { group: item } of classSectionsSemesterGroups(round, group.grade, group.semester)) for (const student of item.students) keys.add(student.key);
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

function classSectionsTimetableModels(round, group, keys) {
  const settings = classSectionsPrintSettings();
  const names = typeof classSectionsStudentNames === "function" ? classSectionsStudentNames(round) : new Map();
  const teacherName = classSectionsTeacherNames();
  const groups = classSectionsSemesterGroups(round, group.grade, group.semester);
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
    return classSectionsStudentTimetable({ year, semester: group.semester, grade: group.grade, targetGrade: group.targetGrade, key, name: names.get(key) || "",
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
  const perPage = Number(classSectionsPrintOption("perPage")) || 2;
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
  downloadBlob(createWorkbookBlob(sheets), `${year}_${context.group.semester}학기_현${context.group.grade}학년${CLASS_SECTIONS_PRINT_VIEW.timetableClass ? `_${CLASS_SECTIONS_PRINT_VIEW.timetableClass}반` : ""}_학생시간표.xlsx`);
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
      list.push({ year, semester: item.semester, grade: item.grade, targetGrade: item.targetGrade, groupKey: item.key, groupLabel: item.label, groupCategory: item.category, sectionId: section.id, courseKey: section.courseKey,
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
  const bundles = classSectionsAttendanceBundles(list, kind, { days });
  const note = warnings.length ? ` ${warnings.join(" ")}` : "";
  if (kind === "group" || kind === "file") {
    downloadBlob(createWorkbookBlob(bundles[0].sheets), bundles[0].name);
    return void classSectionsSetStatus(`출석부 ${kind === "file" ? "전체 파일" : "이 그룹 파일"}: 분반 ${list.length}개 시트${kind === "file" ? " + 목록" : ""}를 내려받았습니다.${note}`, Boolean(warnings.length));
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
    downloadBlob(zip, `${year}_${context.group.semester}학기_출석부_${kind === "teacher" ? "교사별" : "학급별"}.zip`);
    classSectionsSetStatus(`출석부 ${kind === "teacher" ? "교사별" : "학급별 파일"}(zip): 파일 ${bundles.length}개(${kind === "teacher" ? "교사마다" : "분반마다"}), 분반 ${list.length}개.${note}`, Boolean(warnings.length));
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
      <label>범위 <select id="classSectionsAttendanceScope" data-focus-key="cs-att-scope" aria-label="출석부 보기 범위"><option value="group">이 그룹</option><option value="semester"${CLASS_SECTIONS_PRINT_VIEW.attScope === "semester" ? " selected" : ""}>${esc(group.semester)}학기 전체</option></select></label>
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
  if (target.dataset?.csRoomPick !== undefined) {
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
  else if (target.id === "classSectionsAttendancePick") { CLASS_SECTIONS_PRINT_VIEW.attPick = target.value; return void classSectionsAttendanceRerender(); }
  else if (target.id === "classSectionsAttendanceScope") { CLASS_SECTIONS_PRINT_VIEW.attScope = target.value === "semester" ? "semester" : "group"; CLASS_SECTIONS_PRINT_VIEW.attPick = ""; return void classSectionsAttendanceRerender(); }
  else if (target.id === "classSectionsTimetablePerPage") s.print.perPage = [2, 3, 4].includes(Number(target.value)) ? Number(target.value) : 2;
  else if (target.id === "classSectionsTimetableFill") s.print.timetableFill = target.value === "학급 수업" ? "학급 수업" : "";
  else return;
  if (typeof classSectionsChanged === "function") classSectionsChanged();
}

function classSectionsPrintHandleClick(event) {
  const button = event.target.closest?.("button");
  if (!button) return;
  if (button.id === "classSectionsAttendanceGroup") return void classSectionsAttendanceExport("group");
  if (button.id === "classSectionsAttendanceTeacher") return void classSectionsAttendanceExport("teacher");
  if (button.id === "classSectionsAttendanceAll") return void classSectionsAttendanceExport("sections");
  if (button.id === "classSectionsAttendanceFile") return void classSectionsAttendanceExport("file");
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
  module.exports = { classSectionsAttendanceSheet, classSectionsAttendanceFileName, classSectionsAttendanceBundles, classSectionsStudentTimetable, classSectionsSheetHtml, classSectionsAttendanceListSheet, classSectionsAttendanceSheetNames,
    classSectionsTimetableHtml, classSectionsTimetableSheet, classSectionsRoomSpecFromSettings };
}
