"use strict";
// 교육청 제출 양식(울산광역시교육청 「2022 개정 고등학교 교육과정 편제 점검 프로그램」)과 주고받기.
// 1) 내보내기: 우리 편제표 데이터(과목·선택과목군·메모)로 울산 「N학년_편제표」·「편제표통합」과 같은 열 구성·서식의 엑셀을 만든다.
//    열: A 구분 · B 교과(군) · C 과목유형 · D 세부교과목 · E 기준학점 · F 운영학점 · G~L 1~3학년 1·2학기 · M 선택군 · N 선택수 · O 비고.
//    소계 = 학교지정 학점 + 교차집중은 한 과목만 + 선택군은 택n × 학점(울산 예시와 같은 규칙), 그 외(소인수·공동)는 소계에 넣지 않는다.
// 2) 불러오기: 울산 프로그램 파일의 「N학년_편성과목」 입력 영역(학교지정·교차집중·학생선택·그 외)을 편제표 데이터로 바꾼다.
// 위쪽은 순수 계산(테스트 대상), `// ---- 앱 연결` 아래는 화면·파일 연결이다. app.js 등 다른 파일 함수는 실행 시점에만 부른다.

const OFFICE_FIELDS = ["sem11", "sem12", "sem21", "sem22", "sem31", "sem32"];
const OFFICE_AREAS = ["국어", "수학", "영어", "사회(역사/도덕포함)", "과학", "체육", "예술", "기술⋅가정/정보", "제2외국어/한문", "교양"];
// 울산 예시 파일의 선택군 칸 색(A, B, C …)과 교차집중 묶음 색(가, 나, 다 …)
const OFFICE_CHOICE_COLORS = ["F4B084", "FFF2CC", "C6E0B4", "95BDE5", "FFC7CE", "C8C2DE", "F4CCCC", "FFEB9C", "C6E0B4", "C8C2DE", "FFEB9C", "8DDC72", "95BDE5"];
const OFFICE_CROSS_COLORS = ["FFC7CE", "FFEB9C", "C6EFCE", "C8C2DE", "F4CCCC", "DDEBF7"];
const OFFICE_DIVISION_FILLS = { 학교지정: "BFDFFF", 학생선택: "FFFFCC" };
const OFFICE_CROSS_LABELS = "가나다라마바사아자차카타파하";
const OFFICE_COLUMN_WIDTHS = [7.94, 12.24, 4.7, 38.2, 5.25, 5.25, 6.19, 6.19, 6.19, 6.19, 6.19, 6.19, 7.8, 7.8, 9.95];
const OFFICE_FONT = "맑은 고딕";

function officeText(value) {
  return String(value ?? "");
}

// '4', '4.5', '3‘'(울산 교차선택 표시)처럼 숫자로 시작하는 학점을 읽는다.
function officeNumber(value) {
  const match = String(value ?? "").replace(/,/g, "").trim().match(/^(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function officeNumberText(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.round(number * 1000) / 1000) : "";
}

function officeColumnName(index) {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name;
  return name;
}

function officeXml(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/[<>&'"]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[character]);
}

function officeSubjectNames(name) {
  if (typeof planDataSubjectNames === "function") return planDataSubjectNames(name);
  return String(name ?? "").split(/[,，、]/).map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function officeOfficial(name) {
  if (typeof findCurriculumOfficialSubject !== "function") return null;
  return findCurriculumOfficialSubject(officeSubjectNames(name)[0] || name) || findCurriculumOfficialSubject(name);
}

// 과목유형: 공통 / 일반 / 진로 / 융합
function curriculumOfficeKind(subject) {
  const text = officeText(subject?.kindText || subject?.kind).replace(/\s+/g, "");
  for (const kind of ["공통", "일반", "진로", "융합"]) if (text.includes(kind)) return kind;
  const official = officeOfficial(subject?.name);
  const type = official?.type || "";
  for (const kind of ["공통", "일반", "진로", "융합"]) if (type.includes(kind)) return kind;
  return text;
}

// 교과(군): 울산 양식 표기(사회(역사/도덕포함), 기술⋅가정/정보, 제2외국어/한문 …)로 맞춘다.
function curriculumOfficeArea(subject) {
  const normalize = (value) => {
    const text = officeText(value).replace(/\s+/g, "");
    if (!text) return "";
    const exact = OFFICE_AREAS.find((area) => area.replace(/[⋅·•ㆍ∙]/g, "") === text.replace(/[⋅·•ㆍ∙]/g, ""));
    if (exact) return exact;
    if (/^(한국사|역사|도덕|윤리|지리|사회)/.test(text) || /^사회\(/.test(text)) return "사회(역사/도덕포함)";
    if (/^(기술|가정|정보)/.test(text)) return "기술⋅가정/정보";
    if (/^(제2외국어|한문|외국어\/|중국어|일본어)/.test(text)) return "제2외국어/한문";
    return "";
  };
  return normalize(officeOfficial(subject?.name)?.area) || normalize(subject?.area) ||
    officeText(subject?.area).replace(/\s+/g, " ").trim();
}

// 메모 '소인수/2학년/1학기/3학점(순증)', '공동/2학년/1,2학기/3학점'을 읽는다.
function curriculumOfficeNoteInfo(note) {
  const text = officeText(note).trim();
  if (!text) return null;
  const grade = text.match(/([123])\s*학년/)?.[1];
  const semesters = text.match(/([12](?:\s*[,·・]\s*[12])?)\s*학기/)?.[1];
  const credit = officeNumber(text.match(/(\d+(?:\.\d+)?)\s*학점/)?.[1]);
  if (!grade || !semesters || credit === null) return null;
  const fields = [...new Set(semesters.split(/[,·・]/).map((part) => part.trim()).filter(Boolean))].map((semester) => `sem${grade}${semester}`);
  const label = (text.match(/소인수|공동|학교\s*밖|온라인/)?.[0] || "").replace(/\s+/g, "");
  return { label, fields, credit, text };
}

// 편성 영역: school(학교지정) / cross(교차집중) / choice(학생선택) / extra(소인수·공동 등 그 외).
// 편성 영역 데이터(curriculumPlanSection, subject.planSection)가 있으면 그 값을 쓰고, 없으면 메모·교차·선택과목군·구분 열로 추정한다.
function curriculumOfficeSection(subject, context = {}) {
  let section = "";
  if (typeof curriculumPlanSection === "function") {
    try { section = curriculumPlanSection(subject, context.data) || ""; } catch (error) { section = ""; }
  }
  if (!section) section = officeText(subject?.planSection);
  if (["school", "cross", "choice", "extra"].includes(section)) return section;
  if (curriculumOfficeNoteInfo(subject?.note)) return "extra";
  if (!context.inGroup && subject?.cross?.length) return "cross";
  if (context.inGroup) return "choice";
  const category = officeText(subject?.category).replace(/\s+/g, "");
  if (/^학생|학생선택/.test(category)) return "choice";
  return "school";
}

// '구분' 열 글자: 학교지정 / 학생선택 / 소인수·공동 등.
function curriculumOfficeDivision(subject, context = {}) {
  const section = context.section || curriculumOfficeSection(subject, context);
  if (section === "extra") return curriculumOfficeNoteInfo(subject?.note)?.label || "그 외";
  return section === "choice" ? "학생선택" : "학교지정";
}

// 편제표 데이터 → 울산 양식 행 조각. fields: 넣을 학기(전학년은 학년별 2개 학기만), key: 묶음 id 앞머리(전학년에서 입학생별로 구분).
function curriculumOfficeEntries(data, fields = OFFICE_FIELDS, { key = "" } = {}) {
  const include = new Set(fields);
  const subjects = (data?.subjects || []).filter((item) => !item.fixed);
  const groups = (data?.groups || []).map((group) => ({ ...group, fields: OFFICE_FIELDS.filter((field) => group.fields?.includes(field) && include.has(field)) }))
    .filter((group) => group.fields.length && group.members?.length);
  const parts = { school: [], cross: [], choicePlain: [], groups: [], extra: [] };
  const groupRows = new Map(groups.map((group) => [group.id, []]));
  const valuesOf = (subject, skip) => OFFICE_FIELDS.map((field) => {
    if (!include.has(field) || skip.has(field)) return "";
    if (Object.hasOwn(subject.credits || {}, field)) return Number(subject.credits[field]);
    return officeText(subject.texts?.[field]).trim();
  });
  const hasValue = (values) => values.some((value) => value !== "" && value !== null && value !== undefined);
  subjects.forEach((subject, order) => {
    const own = groups.filter((group) => group.members.includes(subject.id));
    const inGroup = (data.groups || []).some((group) => group.members?.includes(subject.id));
    const section = curriculumOfficeSection(subject, { data, inGroup });
    const base = {
      source: subject.id, order, area: curriculumOfficeArea(subject), kind: curriculumOfficeKind(subject),
      base: officeText(subject.base).trim(), op: officeText(subject.op).trim(), name: officeText(subject.name).trim()
    };
    if (section === "extra") {
      const note = curriculumOfficeNoteInfo(subject.note);
      const values = OFFICE_FIELDS.map((field) => note && note.fields.includes(field) && include.has(field) ? note.credit : "");
      const plain = valuesOf(subject, new Set());
      const merged = values.map((value, index) => value !== "" ? value : plain[index]);
      if (hasValue(merged)) parts.extra.push({ ...base, division: curriculumOfficeDivision(subject, { section }), values: merged, count: false });
      return;
    }
    const groupFields = new Set(own.flatMap((group) => group.fields));
    const plainValues = valuesOf(subject, groupFields);
    const crossFields = (subject.cross || []).filter((field) => include.has(field) && !groupFields.has(field));
    const division = curriculumOfficeDivision(subject, { section });
    if (crossFields.length && hasValue(plainValues)) {
      // 교차집중: 과목마다 한 줄, 두 학기에 같은 학점. 소계에는 첫 줄만 센다.
      const names = officeSubjectNames(subject.name);
      const crossKey = `${key}x:${subject.id}`;
      (names.length ? names : [base.name]).forEach((name, index) => {
        const values = plainValues.map((value, column) => index === 0 || crossFields.includes(OFFICE_FIELDS[column]) ? value : "");
        parts.cross.push({ ...base, name, division, values, crossKey, crossFields, crossIndex: index });
      });
    } else if (hasValue(plainValues)) {
      (section === "choice" ? parts.choicePlain : parts.school).push({ ...base, division, values: plainValues });
    }
    for (const group of own) {
      // 학점을 읽지 못한 묶음(0)은 구성 과목 운영학점(curriculum-data.js planDataGroupCredit)을 쓴다.
      const credit = Number(group.credit) > 0 ? Number(group.credit) : typeof planDataGroupCredit === "function" ? planDataGroupCredit(data, group) : 0;
      const values = OFFICE_FIELDS.map((field) => group.fields.includes(field) ? credit : "");
      // 울산 양식은 세부교과목 한 칸에 한 과목(불러올 때 이어진 같은 학점 줄을 '가, 나'로 묶은 것의 반대): 이름마다 한 줄.
      // 선택군 소계는 택n × 학점이라 줄 수와 무관하다.
      const names = officeSubjectNames(subject.name);
      for (const name of names.length ? names : [base.name]) {
        groupRows.get(group.id).push({ ...base, name, division: curriculumOfficeDivision(subject, { section: "choice" }), values });
      }
    }
  });
  for (const group of groups) {
    const rows = groupRows.get(group.id);
    if (!rows.length) continue;
    parts.groups.push({ key: `${key}${group.id}`, pick: Math.max(1, Number(group.pick) || 1), fields: group.fields,
      firstField: OFFICE_FIELDS.indexOf(group.fields[0]), order: rows[0].order, rows });
  }
  return parts;
}

// 여러 조각(전학년은 학년별 조각 3개)을 울산 순서로 늘어놓고 선택군 이름(A, B … / 가, 나 …)·색·소계 방식을 정한다.
function curriculumOfficeOrderRows(partsList, { sortSchoolByArea = false } = {}) {
  const all = (name) => partsList.flatMap((parts, index) => (parts[name] || []).map((item) => ({ ...item, partIndex: index })));
  let school = all("school");
  if (sortSchoolByArea) {
    const firstArea = new Map();
    school.forEach((row, index) => { if (!firstArea.has(row.area)) firstArea.set(row.area, index); });
    school = school.map((row, index) => ({ row, index })).sort((a, b) =>
      firstArea.get(a.row.area) - firstArea.get(b.row.area) || a.index - b.index).map(({ row }) => row);
  }
  const groups = all("groups").map((group, index) => ({ group, index }))
    .sort((a, b) => a.group.firstField - b.group.firstField || a.group.partIndex - b.group.partIndex || a.group.order - b.group.order || a.index - b.index)
    .map(({ group }) => group);
  const rows = [];
  const plainCount = (row) => row.values.map((value) => value === "" ? "" : "plain");
  for (const row of school) rows.push({ ...row, count: plainCount(row) });
  let crossIndex = -1, lastCross = null;
  for (const row of all("cross")) {
    if (row.crossKey !== lastCross) { crossIndex++; lastCross = row.crossKey; }
    const label = OFFICE_CROSS_LABELS[crossIndex] || `교차${crossIndex + 1}`;
    const color = OFFICE_CROSS_COLORS[crossIndex % OFFICE_CROSS_COLORS.length];
    rows.push({ ...row, groupKey: row.crossKey, groupLabel: label, pick: "", remark: "교차집중",
      count: row.values.map((value, column) => value === "" ? "" : row.crossIndex > 0 && row.crossFields.includes(OFFICE_FIELDS[column]) ? "skip" : "plain"),
      colors: row.values.map((value, column) => value !== "" && row.crossFields.includes(OFFICE_FIELDS[column]) ? color : "") });
  }
  for (const row of all("choicePlain")) rows.push({ ...row, count: plainCount(row) });
  groups.forEach((group, index) => {
    const label = index < 26 ? String.fromCharCode(65 + index) : `${String.fromCharCode(65 + Math.floor(index / 26) - 1)}${String.fromCharCode(65 + index % 26)}`;
    const color = OFFICE_CHOICE_COLORS[index % OFFICE_CHOICE_COLORS.length];
    group.rows.forEach((row, offset) => rows.push({ ...row, groupKey: group.key, groupLabel: label, pick: `택${group.pick}`, pickNumber: group.pick,
      groupFirst: offset === 0, count: row.values.map((value) => value === "" ? "" : "group"), colors: row.values.map((value) => value === "" ? "" : color) }));
  });
  for (const row of all("extra")) rows.push({ ...row, count: row.values.map(() => "") });
  return rows;
}

const OFFICE_V_BORDERS = new Map([[0, "medium"], [1, "medium"], [2, "medium"], [3, "medium"], [4, "medium"], [5, "hair"], [6, "medium"],
  [7, "hair"], [8, "medium"], [9, "hair"], [10, "medium"], [11, "hair"], [12, "medium"], [13, "medium"], [14, "medium"], [15, "medium"]]);

function officeVertical(column) {
  return OFFICE_V_BORDERS.get(column) || "";
}

// 행 조각 → 시트 모델(칸 값·수식·서식·병합·열 너비). 모든 행·열 번호는 0부터.
function buildCurriculumOfficeSheet({ name, title, school, gradeLabels = ["1학년", "2학년", "3학년"], rows = [], activity = [] }) {
  const cells = [];
  const merges = [];
  const heights = { 0: 26.85, 1: 17.15, 2: 16.9 };
  const put = (row, column, spec) => { (cells[row] ||= [])[column] = spec; };
  const normal = { font: "normal", h: "center", v: "center" };
  const bodyStart = 4;
  for (let column = 0; column < 15; column++) put(0, column, { v: column === 0 ? title : "", style: { font: "title", h: "centerContinuous", v: "center" } });
  for (let column = 0; column < 15; column++) {
    put(1, column, { v: column === 14 ? `(${school || "○○고등학교"})` : "", style: { font: "school", h: column === 14 ? "right" : "general", v: "center", border: { b: "medium" } } });
  }
  const header = ["구분", "교과(군)", "과목유형", "세부교과목", "기준학점", "운영학점", gradeLabels[0], "", gradeLabels[1], "", gradeLabels[2], "", "선택군", "선택수", "비  고"];
  for (let column = 0; column < 15; column++) {
    const semester = column >= 6 && column <= 11;
    const border = { l: officeVertical(column), r: officeVertical(column + 1), t: "medium", b: semester ? "hair" : "" };
    if (semester) { border.l = column % 2 === 0 ? "medium" : "hair"; border.r = column % 2 === 0 ? "hair" : "medium"; }
    put(2, column, { v: header[column], style: { ...normal, h: semester ? "centerContinuous" : "center", wrap: [2, 4, 5, 14].includes(column), border } });
    put(3, column, { v: semester ? (column % 2 === 0 ? "1학기" : "2학기") : "", style: { ...normal, border: { l: border.l, r: border.r, t: semester ? "hair" : "", b: "medium" } } });
    if (!semester) merges.push(`${officeColumnName(column)}3:${officeColumnName(column)}4`);
  }
  // 과목 행
  rows.forEach((row, index) => {
    const r = bodyStart + index;
    const last = index === rows.length - 1;
    const border = (column) => ({ l: officeVertical(column), r: officeVertical(column + 1), t: index === 0 ? "medium" : "hair", b: last ? "thin" : "hair" });
    const style = (column, extra = {}) => ({ ...normal, shrink: true, border: border(column), ...extra });
    put(r, 0, { v: row.division, style: style(0, { fill: OFFICE_DIVISION_FILLS[row.division] || "" }) });
    put(r, 1, { v: row.area, style: style(1) });
    put(r, 2, { v: row.kind, style: style(2) });
    put(r, 3, { v: row.name, style: style(3) });
    put(r, 4, { v: officeNumber(row.base) ?? row.base, style: style(4) });
    put(r, 5, { v: officeNumber(row.op) ?? row.op, style: style(5) });
    row.values.forEach((value, k) => put(r, 6 + k, { v: value, style: style(6 + k, { fill: row.colors?.[k] || "" }) }));
    const first = index === 0 || rows[index - 1].groupKey !== row.groupKey || !row.groupKey;
    put(r, 12, { v: row.groupKey && first ? row.groupLabel : "", style: style(12) });
    put(r, 13, { v: row.groupKey && first ? row.pick : "", style: style(13) });
    put(r, 14, { v: row.remark || "", style: style(14) });
    heights[r] = 15;
  });
  // 선택군·선택수 세로 병합
  for (let index = 0; index < rows.length;) {
    let end = index;
    while (rows[index].groupKey && end + 1 < rows.length && rows[end + 1].groupKey === rows[index].groupKey) end++;
    if (end > index) for (const column of [12, 13]) merges.push(`${officeColumnName(column)}${bodyStart + index + 1}:${officeColumnName(column)}${bodyStart + end + 1}`);
    index = end + 1;
  }
  // 소계: 학교지정·교차집중 첫 줄은 칸 그대로, 선택군은 택n × 첫 줄 학점.
  const footer = bodyStart + rows.length;
  const subtotalFormula = (k) => {
    const letter = officeColumnName(6 + k);
    const terms = [];
    let value = 0;
    let runStart = -1, runHas = false;
    const flush = (endIndex) => {
      if (runStart >= 0 && runHas) {
        const a = bodyStart + runStart + 1, b = bodyStart + endIndex + 1;
        terms.push(a === b ? `${letter}${a}` : `${letter}${a}:${letter}${b}`);
      }
      runStart = -1; runHas = false;
    };
    rows.forEach((row, index) => {
      const mode = row.count?.[k] || "";
      const neutral = mode === "plain" || row.values[k] === "";
      if (neutral) {
        if (runStart < 0) runStart = index;
        if (mode === "plain" && typeof row.values[k] === "number") { runHas = true; value += row.values[k]; }
      } else flush(index - 1);
    });
    flush(rows.length - 1);
    const plain = terms.length ? [`SUM(${terms.join(",")})`] : [];
    rows.forEach((row, index) => {
      if (row.count?.[k] === "group" && row.groupFirst && typeof row.values[k] === "number") {
        plain.push(`${row.pickNumber}*${letter}${bodyStart + index + 1}`);
        value += row.pickNumber * row.values[k];
      }
    });
    // 학점이 하나도 없는 학기는 나중에 과목을 넣으면 바로 더해지도록 과목 영역 전체 SUM으로 둔다.
    const empty = rows.length && rows.every((row) => row.values[k] === "");
    const fallback = empty ? `SUM(${letter}${bodyStart + 1}:${letter}${bodyStart + rows.length})` : "0";
    return { f: plain.length ? plain.join("+") : fallback, v: Math.round(value * 1000) / 1000 };
  };
  const footerRow = (r, label, kind) => {
    const lastFooter = kind === "total";
    for (let column = 0; column < 15; column++) {
      const border = { l: column === 0 ? "medium" : column <= 5 ? "" : officeVertical(column), r: column < 5 ? "" : column === 5 ? "medium" : officeVertical(column + 1),
        t: "thin", b: lastFooter ? "medium" : "thin" };
      put(r, column, { v: column === 0 ? label : "", style: { ...normal, h: column <= 5 ? "centerContinuous" : "center", shrink: column > 5, border } });
    }
    heights[r] = 15;
  };
  footerRow(footer, "이수학점 소계", "subtotal");
  footerRow(footer + 1, "창의적 체험활동", "activity");
  footerRow(footer + 2, "학기별 이수 학점 합계", "total");
  const totals = [0, 0, 0];
  for (let k = 0; k < 6; k++) {
    const letter = officeColumnName(6 + k);
    const subtotal = subtotalFormula(k);
    cells[footer][6 + k].f = subtotal.f; cells[footer][6 + k].v = subtotal.v;
    const act = officeNumber(activity[k]);
    if (act !== null) cells[footer + 1][6 + k].v = act;
    cells[footer + 2][6 + k].f = `${letter}${footer + 1}+${letter}${footer + 2}`;
    cells[footer + 2][6 + k].v = subtotal.v + (act || 0);
    totals[0] += subtotal.v; totals[1] += act || 0; totals[2] += subtotal.v + (act || 0);
  }
  [0, 1, 2].forEach((offset) => {
    if (offset === 1 && !activity.some((value) => officeNumber(value) !== null)) return;
    const r = footer + offset;
    cells[r][14].f = `SUM(G${r + 1}:L${r + 1})`;
    cells[r][14].v = Math.round(totals[offset] * 1000) / 1000;
  });
  return { name, cells, merges, heights, widths: OFFICE_COLUMN_WIDTHS, freezeRow: 4, printTitles: "$3:$4", lastRow: footer + 2, lastColumn: 14, bodyStart, footer };
}

// 서식 목록을 모아 styles.xml과 칸별 서식 번호를 만든다.
function officeStyleRegistry() {
  const fonts = new Map(), fills = new Map(), borders = new Map(), xfs = new Map();
  const fontXml = { normal: `<font><sz val="10"/><name val="${OFFICE_FONT}"/><family val="3"/><charset val="129"/></font>`,
    bold: `<font><b/><sz val="10"/><name val="${OFFICE_FONT}"/><family val="3"/><charset val="129"/></font>`,
    title: `<font><b/><sz val="20"/><name val="${OFFICE_FONT}"/><family val="3"/><charset val="129"/></font>`,
    school: `<font><b/><sz val="12"/><name val="${OFFICE_FONT}"/><family val="3"/><charset val="129"/></font>` };
  const index = (map, key, xml) => { if (!map.has(key)) map.set(key, { id: map.size, xml }); return map.get(key).id; };
  index(fonts, "normal", fontXml.normal);
  index(fills, "none", '<fill><patternFill patternType="none"/></fill>');
  index(fills, "gray125", '<fill><patternFill patternType="gray125"/></fill>');
  index(borders, "||||", "<border><left/><right/><top/><bottom/><diagonal/></border>");
  index(xfs, "default", '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>');
  const side = (name, style) => style ? `<${name} style="${style}"><color auto="1"/></${name}>` : `<${name}/>`;
  const id = (style = {}) => {
    const fontId = index(fonts, style.font || "normal", fontXml[style.font] || fontXml.normal);
    const fillKey = style.fill || "none";
    const fillId = fillKey === "none" ? 0 : index(fills, fillKey, `<fill><patternFill patternType="solid"><fgColor rgb="FF${fillKey}"/><bgColor indexed="64"/></patternFill></fill>`);
    const b = style.border || {};
    const borderKey = [b.l, b.r, b.t, b.b].map((value) => value || "").join("|");
    const borderId = index(borders, borderKey, `<border>${side("left", b.l)}${side("right", b.r)}${side("top", b.t)}${side("bottom", b.b)}<diagonal/></border>`);
    const align = `<alignment${style.h && style.h !== "general" ? ` horizontal="${style.h}"` : ""}${style.v ? ` vertical="${style.v}"` : ""}${style.wrap ? ' wrapText="1"' : ""}${style.shrink ? ' shrinkToFit="1"' : ""}/>`;
    const key = `${fontId}|${fillId}|${borderId}|${align}`;
    return index(xfs, key, `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${align}</xf>`);
  };
  const list = (map) => [...map.values()].map((item) => item.xml).join("");
  const xml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="${fonts.size}">${list(fonts)}</fonts><fills count="${fills.size}">${list(fills)}</fills><borders count="${borders.size}">${list(borders)}</borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.size}">${list(xfs)}</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="표준" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  return { id, xml };
}

function officeSheetXml(sheet, styles) {
  const rowsXml = [];
  for (let r = 0; r <= sheet.lastRow; r++) {
    const row = sheet.cells[r] || [];
    const cellsXml = [];
    for (let c = 0; c < row.length; c++) {
      const spec = row[c];
      if (!spec) continue;
      const ref = `${officeColumnName(c)}${r + 1}`;
      const s = ` s="${styles.id(spec.style)}"`;
      if (spec.f) {
        const cached = typeof spec.v === "number" ? `<v>${spec.v}</v>` : "";
        cellsXml.push(`<c r="${ref}"${s}><f>${officeXml(spec.f)}</f>${cached}</c>`);
      } else if (typeof spec.v === "number" && Number.isFinite(spec.v)) cellsXml.push(`<c r="${ref}"${s}><v>${spec.v}</v></c>`);
      else if (officeText(spec.v) !== "") cellsXml.push(`<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${officeXml(spec.v)}</t></is></c>`);
      else cellsXml.push(`<c r="${ref}"${s}/>`);
    }
    const height = sheet.heights?.[r];
    rowsXml.push(`<row r="${r + 1}"${height ? ` ht="${height}" customHeight="1"` : ""}>${cellsXml.join("")}</row>`);
  }
  const widths = sheet.widths || [];
  const cols = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("") +
    (sheet.hideRest ? `<col min="${widths.length + 1}" max="${widths.length + 2}" width="9.01" hidden="1" customWidth="1"/><col min="${widths.length + 3}" max="16384" width="8.74" hidden="1" customWidth="1"/>` : "");
  const freeze = sheet.freezeRow ? `<pane ySplit="${sheet.freezeRow}" topLeftCell="A${sheet.freezeRow + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${sheet.freezeRow + 1}" sqref="A${sheet.freezeRow + 1}"/>` : "";
  const merges = [...new Set(sheet.merges || [])];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${officeColumnName(sheet.lastColumn)}${sheet.lastRow + 1}"/>` +
    `<sheetViews><sheetView workbookViewId="0">${freeze}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>` +
    `<cols>${cols}</cols><sheetData>${rowsXml.join("")}</sheetData>` +
    (merges.length ? `<mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>` : "") +
    `<pageMargins left="0.708" right="0.708" top="0.748" bottom="0.748" header="0.512" footer="0.512"/>` +
    `<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}

// 시트 모델 목록 → xlsx 압축 파일에 넣을 파일 목록.
function curriculumOfficeWorkbookFiles(sheets) {
  const styles = officeStyleRegistry();
  const used = new Set();
  const names = sheets.map((sheet, index) => {
    let base = officeText(sheet.name || `시트${index + 1}`).replace(/[\[\]:*?\/\\]/g, " ").trim().slice(0, 31) || `시트${index + 1}`;
    let name = base;
    for (let suffix = 2; used.has(name); suffix++) name = `${base.slice(0, 28)}(${suffix})`;
    used.add(name);
    return name;
  });
  const files = {};
  sheets.forEach((sheet, index) => { files[`xl/worksheets/sheet${index + 1}.xml`] = officeSheetXml(sheet, styles); });
  const quoted = (name) => `'${name.replace(/'/g, "''")}'`;
  const definedNames = sheets.map((sheet, index) => sheet.printTitles
    ? `<definedName name="_xlnm.Print_Titles" localSheetId="${index}">${officeXml(`${quoted(names[index])}!${sheet.printTitles}`)}</definedName>` : "").join("");
  files["[Content_Types].xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  files["_rels/.rels"] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  files["xl/workbook.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((name, index) => `<sheet name="${officeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>${definedNames ? `<definedNames>${definedNames}</definedNames>` : ""}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  files["xl/_rels/workbook.xml.rels"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  files["xl/styles.xml"] = styles.xml();
  return files;
}

// 편제표 양식(planTemplate)의 '창의적 체험활동' 행에서 학기별 시간(학점)을 읽는다.
function curriculumOfficeActivity(layout) {
  const template = layout?.planTemplate;
  const semesters = template?.columns?.semesters || [];
  const row = (template?.footer?.rows || []).find((values) => values.some((value) => /창의적\s*체험/.test(officeText(value))));
  return OFFICE_FIELDS.map((_, index) => row && semesters[index] >= 0 ? officeText(row[semesters[index]]).trim() : "");
}

// 입학생 편제표 1개 → 울산 「N학년_편제표」 시트 모델.
function curriculumOfficeCohortSheet(layout, { year, grade, school }) {
  const data = layout?.planData;
  if (!data) throw new Error("편제표 데이터가 없습니다. 편제표를 다시 업로드하세요.");
  const rows = curriculumOfficeOrderRows([curriculumOfficeEntries(data)]);
  const sheet = buildCurriculumOfficeSheet({
    name: grade >= 1 && grade <= 3 ? `${grade}학년_편제표` : `${year}입학생_편제표`,
    title: `${year}학년도 입학생 교육과정 편제표(안)`, school, rows, activity: curriculumOfficeActivity(layout)
  });
  sheet.hideRest = true;
  return sheet;
}

// 전학년 편제표: 1학년=올해 입학생, 2학년=전년도, 3학년=전전년도 입학생 편제표의 학년 열 → 울산 「편제표통합」 시트 모델.
function curriculumOfficeAnnualSheet(layoutsByGrade, { year, school }) {
  const parts = [];
  const activity = ["", "", "", "", "", ""];
  for (const grade of [1, 2, 3]) {
    const layout = layoutsByGrade[grade];
    if (!layout?.planData) continue;
    const fields = [`sem${grade}1`, `sem${grade}2`];
    parts.push(curriculumOfficeEntries(layout.planData, fields, { key: `${grade}:` }));
    const cohortActivity = curriculumOfficeActivity(layout);
    for (const field of fields) activity[OFFICE_FIELDS.indexOf(field)] = cohortActivity[OFFICE_FIELDS.indexOf(field)];
  }
  if (!parts.length) throw new Error("전학년 편제표를 만들 입학생 편제표가 없습니다.");
  const short = (value) => String(Number(year) - value + 1).slice(-2);
  const sheet = buildCurriculumOfficeSheet({
    name: "편제표통합", title: `${year}학년도 전학년 교육과정 편제표(안)`, school,
    gradeLabels: [`1학년(${short(1)})`, `2학년(${short(2)})`, `3학년(${short(3)})`],
    rows: curriculumOfficeOrderRows(parts, { sortSchoolByArea: true }), activity
  });
  sheet.hideRest = true;
  return sheet;
}

// 원본 양식이 없는 편제표(울산 파일에서 불러온 것)의 '기본 양식': 화면 표 그대로(값·병합·수식).
function curriculumBasicSheet(layout, name) {
  const cells = [];
  const width = Math.max(1, ...layout.rows.map((row) => row.length));
  const meta = layout.planRowMeta || [];
  layout.rows.forEach((values, r) => {
    const type = meta[r]?.type || "subject";
    for (let c = 0; c < width; c++) {
      const text = officeText(values[c]);
      const formula = layout.formulas?.[`${r}:${c}`];
      const number = text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : null;
      const fill = officeText(layout.cellFills?.[`${r}:${c}`]).replace(/^#/, "");
      (cells[r] ||= [])[c] = { v: number ?? text, f: formula, style: { font: type === "header" && r > 0 ? "bold" : r === 0 ? "school" : "normal",
        h: "center", v: "center", wrap: true, fill: /^[0-9A-F]{6}$/i.test(fill) ? fill.toUpperCase() : "",
        border: r === 0 ? {} : { l: "thin", r: "thin", t: "thin", b: "thin" } } };
    }
  });
  const heights = {};
  for (const [row, height] of Object.entries(layout.rowHeights || {})) heights[row] = height;
  return { name, cells, merges: layout.mergedRanges || [], heights, widths: Array.from({ length: width }, (_, c) => Number(layout.columnWidths?.[c]) || 8.43),
    freezeRow: Math.max(0, meta.findIndex((item) => item.type !== "header")), lastRow: layout.rows.length - 1, lastColumn: width - 1 };
}

// ---- 울산 프로그램 파일 불러오기(순수 계산) ----
const OFFICE_INPUT_AREAS = {
  school: { start: "B", name: "E", area: "C", kind: "D", credits: "F" },
  cross: { start: "S", group: "T", area: "U", kind: "V", name: "W", credits: "X" },
  choice: { start: "AL", group: "AM", pick: "AN", area: "AO", kind: "AP", name: "AQ", credits: "AR" },
  other: { start: "BF", label: "BG", area: "BH", kind: "BI", name: "BJ", credits: "BK" }
};

function officeColumnIndex(name) {
  let result = 0;
  for (const letter of name) result = result * 26 + letter.charCodeAt(0) - 64;
  return result - 1;
}

function isCurriculumOfficeProgram(sheets) {
  return (sheets || []).some((sheet) => /^[123]학년_편성과목$/.test(officeText(sheet.name).trim()));
}

// 학교정보 시트의 학년별 입학연도(3학년 C8, 2학년 C9, 1학년 C10; 두 자리 또는 네 자리).
function curriculumOfficeProgramYears(sheets) {
  const info = (sheets || []).find((sheet) => officeText(sheet.name).trim() === "학교정보");
  const years = {};
  if (!info) return years;
  [[3, 7], [2, 8], [1, 9]].forEach(([grade, row]) => {
    const label = officeText(info.rows?.[row]?.[1]);
    const value = officeNumber(info.rows?.[row]?.[2]);
    if (value !== null && (!label || label.includes(`${grade}학년`))) years[grade] = value < 100 ? 2000 + value : value;
  });
  const school = officeText(info.rows?.[4]?.[2]).trim();
  if (school && !/○/.test(school)) years.school = school;
  return years;
}

// 과목목록 시트(B 교과(군), D 과목유형, E 과목명, F 기준학점)
function curriculumOfficeCatalog(sheets) {
  const sheet = (sheets || []).find((item) => officeText(item.name).trim() === "과목목록");
  const catalog = new Map();
  for (const row of sheet?.rows?.slice(3) || []) {
    const name = officeText(row?.[4]).trim();
    if (name) catalog.set(name.replace(/\s+/g, ""), { area: officeText(row[1]).trim(), type: officeText(row[3]).trim(), base: officeText(row[5]).trim() });
  }
  return catalog;
}

// 「N학년_편성과목」 입력 영역을 읽는다. 과목명이 있는 줄만.
function curriculumOfficeReadInputs(sheet) {
  const result = { school: [], cross: [], choice: [], other: [] };
  const rows = sheet?.rows || [];
  for (const [area, spec] of Object.entries(OFFICE_INPUT_AREAS)) {
    const at = (row, letter) => letter ? officeText(row?.[officeColumnIndex(letter)]).trim() : "";
    const creditStart = officeColumnIndex(spec.credits);
    for (let r = 7; r < rows.length; r++) {
      const row = rows[r];
      const name = at(row, spec.name);
      if (!name) continue;
      const credits = {};
      OFFICE_FIELDS.forEach((field, index) => {
        const value = officeNumber(row?.[creditStart + index]);
        if (value !== null && value > 0) credits[field] = value;
      });
      result[area].push({ row: r + 1, name, area: at(row, spec.area), kind: at(row, spec.kind), credits,
        group: at(row, spec.group), pick: at(row, spec.pick), label: at(row, spec.label) });
    }
  }
  return result;
}

function curriculumOfficeInputCount(inputs) {
  return Object.values(inputs || {}).reduce((total, rows) => total + rows.length, 0);
}

function officeKindText(kind) {
  const text = officeText(kind).replace(/\s+/g, "");
  return ["공통", "일반", "진로", "융합"].find((item) => text.includes(item)) || text;
}

function officeKindFull(kind) {
  const short = officeKindText(kind);
  return short === "공통" || !short ? short : ["일반", "진로", "융합"].includes(short) ? `${short}선택` : short;
}

// 입력 영역 → 편제표 데이터(planData). planSection(school/cross/choice/extra)은 교사가 지정한 값으로 둔다.
function curriculumOfficeDataFromInputs(inputs, catalog = new Map()) {
  let nextId = 1;
  const subjects = [];
  const groups = [];
  const info = (name) => catalog.get(officeText(officeSubjectNames(name)[0] || name).replace(/\s+/g, "")) || catalog.get(officeText(name).replace(/\s+/g, "")) || {};
  const make = (row, section, extra = {}) => {
    const known = info(row.name);
    const kind = row.kind || known.type || "";
    const total = Object.values(row.credits).reduce((sum, value) => sum + value, 0);
    return {
      id: `s${nextId++}`, category: section === "school" || section === "cross" ? "학교지정" : "학생선택", domain: "",
      area: row.area || known.area || "", kindText: officeKindText(kind), kind: officeKindFull(kind), kindJoin: false,
      name: row.name, base: known.base || "", op: officeNumberText(total), opFormula: false,
      credits: { ...row.credits }, texts: {}, cross: null, note: "", completion: null, required: null, extra: {},
      span: 1, semMerge: false, fills: [{}], heights: [null], hidden: false, styleRows: [null],
      planSection: section, planSectionManual: true, ...extra
    };
  };
  for (const row of inputs.school || []) subjects.push(make(row, "school"));
  // 교차집중: 같은 그룹 과목을 한 과목(이름 나열)으로 묶고, 두 학기에 같은 학점을 둔다.
  const crossGroups = new Map();
  for (const row of inputs.cross || []) {
    const key = row.group || `#${row.row}`;
    if (!crossGroups.has(key)) crossGroups.set(key, []);
    crossGroups.get(key).push(row);
  }
  for (const rows of crossGroups.values()) {
    const credits = {};
    for (const row of rows) for (const [field, value] of Object.entries(row.credits)) credits[field] = Math.max(credits[field] || 0, value);
    const first = rows[0];
    const fields = OFFICE_FIELDS.filter((field) => credits[field]);
    const subject = make({ ...first, name: [...new Set(rows.map((row) => row.name))].join(", "), credits }, "cross",
      { cross: fields.length > 1 ? fields : null });
    subject.op = officeNumberText(Object.values(first.credits).reduce((sum, value) => sum + value, 0) / Math.max(1, fields.length > 1 ? 2 : 1));
    subjects.push(subject);
  }
  // 학생선택: 그룹(A, B …)마다 선택과목군. 이어진 같은 교과(군)·유형·학점 줄은 한 과목(이름 나열)으로 묶는다.
  const choiceGroups = new Map();
  for (const row of inputs.choice || []) {
    if (!row.group) { subjects.push(make(row, "choice")); continue; }
    if (!choiceGroups.has(row.group)) choiceGroups.set(row.group, []);
    choiceGroups.get(row.group).push(row);
  }
  for (const [label, rows] of choiceGroups) {
    const signature = (row) => [row.area, officeKindText(row.kind), OFFICE_FIELDS.map((field) => row.credits[field] || "").join(",")].join("|");
    const members = [];
    let current = null;
    for (const row of rows) {
      if (current && signature(current.rows[0]) === signature(row)) current.rows.push(row);
      else { current = { rows: [row] }; members.push(current); }
    }
    const fields = OFFICE_FIELDS.filter((field) => rows.some((row) => row.credits[field]));
    const counts = new Map();
    for (const row of rows) for (const field of fields) if (row.credits[field]) counts.set(row.credits[field], (counts.get(row.credits[field]) || 0) + 1);
    const credit = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] || 0;
    const pick = officeNumber(String(rows.find((row) => row.pick)?.pick || "").replace(/^택\s*/, "")) || 1;
    const ids = [];
    for (const member of members) {
      const subject = make({ ...member.rows[0], name: member.rows.map((row) => row.name).join(", ") }, "choice");
      subject.op = officeNumberText(credit) || subject.op;
      subject.credits = {};
      subjects.push(subject);
      ids.push(subject.id);
    }
    if (fields.length) groups.push({ id: `g${nextId++}`, fields, pick, credit, members: ids, officeLabel: label });
  }
  // 그 외(소인수·공동·학교 밖·온라인): 메모로 학년·학기·학점을 남긴다(소계에 넣지 않는 기존 편제표 표기와 같다).
  for (const row of inputs.other || []) {
    const fields = OFFICE_FIELDS.filter((field) => row.credits[field]);
    const subject = make(row, "extra", { credits: {} });
    if (fields.length) subject.op = officeNumberText(row.credits[fields[0]]);
    if (fields.length) {
      const grade = fields[0].slice(3, 4);
      const semesters = fields.filter((field) => field.slice(3, 4) === grade).map((field) => field.slice(4, 5)).join(",");
      subject.note = `${row.label || "그 외"}/${grade}학년/${semesters}학기/${officeNumberText(row.credits[fields[0]])}학점`;
    } else subject.note = row.label || "그 외";
    subjects.push(subject);
  }
  return { version: typeof PLAN_DATA_VERSION !== "undefined" ? PLAN_DATA_VERSION : 1,
    converter: typeof PLAN_DATA_CONVERTER !== "undefined" ? PLAN_DATA_CONVERTER : 2, nextId, subjects, groups };
}

// 불러온 편제표의 화면용 양식(머리글·소계 행). 원본 엑셀이 없으므로 앱이 만든다.
function curriculumOfficeTemplate({ year, school = "", activity = [] } = {}) {
  const blank = () => Array.from({ length: 12 }, () => "");
  const title = blank(); title[0] = `${year}학년도 입학생 교육과정 편제표 (울산 편제 점검 프로그램에서 불러옴)`;
  const info = blank(); info[11] = school;
  const header = ["구분", "교과(군)", "과목유형", "과목명", "기준학점", "운영학점", "1학년", "1학년", "2학년", "2학년", "3학년", "3학년"];
  const semesters = ["", "", "", "", "", "", "1학기", "2학기", "1학기", "2학기", "1학기", "2학기"];
  const footerRow = (label) => { const row = blank(); for (let c = 0; c < 6; c++) row[c] = label; return row; };
  const subtotal = footerRow("이수학점 소계"), act = footerRow("창의적 체험활동"), total = footerRow("학기별 총 이수 학점");
  const formulas = {};
  for (let k = 0; k < 6; k++) {
    const letter = officeColumnName(6 + k);
    formulas[`0:${6 + k}`] = `SUM(${letter}5:${letter}5)`;
    if (officeNumber(activity[k]) !== null) act[6 + k] = officeNumberText(officeNumber(activity[k]));
    formulas[`2:${6 + k}`] = `SUM(${letter}6:${letter}7)`;
  }
  const part = (rows, extra = {}) => ({ rows, sources: rows.map(() => null), formulas: {}, fills: {}, heights: {}, hidden: [], merges: [], ...extra });
  return {
    version: typeof PLAN_DATA_VERSION !== "undefined" ? PLAN_DATA_VERSION : 1, width: 12,
    columnWidths: [10, 14, 8, 30, 7, 7, 7, 7, 7, 7, 7, 7],
    columns: { category: 0, domain: -1, area: 1, kind: 2, name: 3, base: 4, op: 5, semesters: [6, 7, 8, 9, 10, 11], completion: -1, required: -1 },
    header: part([title, info, header, semesters], { merges: ["A1:L1", "A3:A4", "B3:B4", "C3:C4", "D3:D4", "E3:E4", "F3:F4", "G3:H3", "I3:J3", "K3:L3"], heights: { 0: 24 } }),
    footer: part([subtotal, act, total], { formulas, merges: ["A1:F1", "A2:F2", "A3:F3"] }),
    bodyStart: 4, bodyEnd: 4, crossLabel: "교차집중(↔)", defaultHeight: null
  };
}

// 울산 파일에서 어느 학년 시트를 쓸지 고른다: 학교정보의 입학연도가 카드 연도와 같은 학년 → 없으면 (학년도+2−입학연도) → 과목이 있는 첫 시트.
function curriculumOfficeChooseGrade(options, { cohortYear, schoolYear } = {}) {
  const byYear = options.find((option) => option.year && String(option.year) === String(cohortYear));
  if (byYear) return byYear.grade;
  const guess = Number(schoolYear) + 2 - Number(cohortYear);
  if (options.some((option) => option.grade === guess && !option.year)) return guess;
  return options.find((option) => option.count)?.grade ?? options[0]?.grade ?? null;
}

// ---- xlsb(바이너리 엑셀)에서 필요한 시트 값만 읽기 ----
function officeXlsbRecords(bytes) {
  const records = [];
  let i = 0;
  while (i < bytes.length) {
    let id = bytes[i++];
    if (id & 0x80) id = (id & 0x7f) | ((bytes[i++] & 0x7f) << 7);
    let size = 0;
    for (let shift = 0; shift < 28; shift += 7) {
      const byte = bytes[i++];
      size |= (byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
    }
    records.push([id, i, size]);
    i += size;
  }
  return records;
}

function officeXlsbWideString(view, offset) {
  const length = view.getUint32(offset, true);
  let text = "";
  for (let index = 0; index < length; index++) text += String.fromCharCode(view.getUint16(offset + 4 + index * 2, true));
  return { text, end: offset + 4 + length * 2 };
}

function officeXlsbRk(value) {
  let number;
  if (value & 2) number = value >> 2;
  else {
    const buffer = new DataView(new ArrayBuffer(8));
    buffer.setUint32(4, value & 0xfffffffc, true);
    buffer.setUint32(0, 0, true);
    number = buffer.getFloat64(0, true);
  }
  return value & 1 ? number / 100 : number;
}

// entries: { "xl/workbook.bin": Uint8Array, ... } → [{ name, rows }] (wanted(name)이 참인 시트만)
function curriculumOfficeXlsbSheets(entries, wanted = () => true) {
  const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const workbook = entries["xl/workbook.bin"];
  if (!workbook) throw new Error("xlsb 통합 문서 정보를 찾지 못했습니다.");
  const rels = new TextDecoder("utf-8").decode(entries["xl/_rels/workbook.bin.rels"] || new Uint8Array());
  const targets = new Map();
  for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = match[0].match(/\bId="([^"]+)"/)?.[1], target = match[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) targets.set(id, target.replace(/^\/?xl\//, "").replace(/^\//, ""));
  }
  const sheets = [];
  const wb = viewOf(workbook);
  for (const [id, start] of officeXlsbRecords(workbook)) {
    if (id !== 156) continue; // BrtBundleSh
    const rel = officeXlsbWideString(wb, start + 8);
    const name = officeXlsbWideString(wb, rel.end).text;
    if (wanted(name)) sheets.push({ name, path: `xl/${targets.get(rel.text) || ""}` });
  }
  const shared = [];
  const sst = entries["xl/sharedStrings.bin"];
  if (sst) {
    const view = viewOf(sst);
    for (const [id, start] of officeXlsbRecords(sst)) if (id === 19) shared.push(officeXlsbWideString(view, start + 1).text);
  }
  return sheets.map(({ name, path }) => {
    const bytes = entries[path];
    const rows = [];
    if (!bytes) return { name, rows };
    const view = viewOf(bytes);
    let row = -1;
    for (const [id, start, size] of officeXlsbRecords(bytes)) {
      if (id === 0) { row = view.getUint32(start, true); continue; }
      if (![2, 5, 6, 7, 8, 9].includes(id) || size < 8 || row < 0) continue;
      const column = view.getUint32(start, true);
      let value = "";
      if (id === 2) value = officeXlsbRk(view.getInt32(start + 8, true));
      else if (id === 5 || id === 9) value = view.getFloat64(start + 8, true);
      else if (id === 7) value = shared[view.getUint32(start + 8, true)] ?? "";
      else if (id === 6 || id === 8) value = officeXlsbWideString(view, start + 8).text;
      (rows[row] ||= [])[column] = typeof value === "number" ? officeNumberText(value) : value;
    }
    return { name, rows };
  });
}

// ---- 앱 연결 ----
const CURRICULUM_OFFICE_SHEET_PATTERN = /^(?:[123]학년_편성과목|학교정보|과목목록|[123]학년_편제표)$/;

// 학교명: 기본 정보 → 편제표 원본 머리글에 적힌 학교명(예: 천상고등학교) → ○○고등학교
function curriculumOfficeTemplateSchool(layouts) {
  for (const layout of layouts) {
    for (const row of layout?.planTemplate?.header?.rows || []) {
      const found = row.map((value) => officeText(value).trim()).find((value) => /^[^\s()]{1,20}(고등학교|고)$/.test(value) && !/○/.test(value));
      if (found) return found;
    }
  }
  return "";
}

function curriculumOfficeSchoolName(layouts = []) {
  const fromState = typeof state !== "undefined" ? officeText(state.schoolName).trim() : "";
  const fromInput = typeof document !== "undefined" ? officeText(document.getElementById("schoolName")?.value || document.getElementById("certificateSchoolName")?.value).trim() : "";
  return fromState || fromInput || curriculumOfficeTemplateSchool(layouts) || "○○고등학교";
}

function curriculumOfficeDownload(blob, fileName) {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = fileName; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function curriculumOfficeCohortLayout(year) {
  const cohort = String(year) === String(state.curriculumCohortYear) && state.curriculumPlanType !== "annual"
    ? state.curriculumImportedLayout : state.curriculumCohorts?.[year]?.importedLayout;
  if (!cohort) return null;
  return cohort.planData ? cohort : typeof curriculumLayoutData === "function" ? curriculumLayoutData(cohort) : null;
}

function buildCurriculumOfficeExport() {
  const schoolYear = Number(document.getElementById("schoolYear")?.value || state.schoolYear || new Date().getFullYear());
  const year = Number(state.curriculumCohortYear);
  if (state.curriculumPlanType === "annual") {
    const layouts = {};
    for (const grade of [1, 2, 3]) layouts[grade] = curriculumOfficeCohortLayout(String(year - grade + 1));
    const school = curriculumOfficeSchoolName(Object.values(layouts));
    const missing = [1, 2, 3].filter((grade) => !layouts[grade]?.planData).map((grade) => `${grade}학년(${year - grade + 1} 입학생)`);
    if (missing.length === 3) throw new Error("전학년 편제표를 만들 입학생 편제표가 없습니다.");
    const sheet = curriculumOfficeAnnualSheet(layouts, { year, school });
    return { sheet, fileName: `${year}학년도_전학년_편제표_교육청양식.xlsx`, missing };
  }
  const layout = curriculumOfficeCohortLayout(String(year));
  if (!layout?.planData) throw new Error("편제표 데이터가 없습니다. 편제표를 다시 업로드하세요.");
  const school = curriculumOfficeSchoolName([layout]);
  const sheet = curriculumOfficeCohortSheet(layout, { year, grade: schoolYear + 2 - year, school });
  return { sheet, fileName: `${year}학년도_입학생_편제표_교육청양식.xlsx`, missing: [] };
}

function buildCurriculumBasicWorkbook(layout) {
  if (typeof createXlsxBlob !== "function") throw new Error("엑셀 파일을 만들 수 없습니다.");
  return createXlsxBlob(curriculumOfficeWorkbookFiles([curriculumBasicSheet(layout, layout.sheetName || "편제표")]));
}

function curriculumOfficeStatus(message, ok) {
  const node = document.getElementById("status");
  if (!node) return;
  node.style.color = ok ? "#287956" : "#a44939";
  node.textContent = message;
}

// 학년 시트 선택 확인 창. 고른 학년(숫자) 또는 null(취소).
function askCurriculumOfficeGrade(options, chosen, cohortYear) {
  const dialog = document.getElementById("curriculumOfficeImportDialog");
  if (!dialog || typeof dialog.showModal !== "function") {
    const option = options.find((item) => item.grade === chosen);
    return Promise.resolve(window.confirm(`울산 편제 점검 프로그램의 '${option?.sheet}'(과목 ${option?.count || 0}개)을 ${cohortYear}학년도 입학생 편제표로 불러올까요?`) ? chosen : null);
  }
  document.getElementById("curriculumOfficeImportScope").textContent = `${cohortYear}학년도 입학생 편제표로 불러올 학년 시트를 확인하세요. 지금 편제표는 바뀌고, 되돌리기로 돌아갈 수 있습니다.`;
  const list = document.getElementById("curriculumOfficeImportOptions");
  list.innerHTML = options.map((option) => `<label class="curriculum-office-option"><input type="radio" name="curriculumOfficeGrade" value="${option.grade}"${option.grade === chosen ? " checked" : ""}>
    <span><strong>${officeXml(option.sheet)}</strong> · ${option.year ? `${option.year}학년도 입학생` : "입학연도 미입력"} · ${option.count ? `편성 과목 ${option.count}개` : "편성 과목 없음"}${option.year && String(option.year) === String(cohortYear) ? " · 카드와 입학연도 일치" : ""}</span></label>`).join("");
  return new Promise((resolve) => {
    const finish = (value) => { dialog.close(); resolve(value); };
    document.getElementById("confirmCurriculumOfficeImport").onclick = () => {
      const picked = list.querySelector("input:checked");
      finish(picked ? Number(picked.value) : null);
    };
    document.getElementById("cancelCurriculumOfficeImport").onclick = () => finish(null);
    dialog.oncancel = () => resolve(null);
    dialog.showModal();
  });
}

// app.js의 편제표 업로드에서 울산 프로그램 파일을 알아보면 이 함수로 넘긴다.
async function importCurriculumOfficeProgram(sheets, file, verifyTarget = () => {}) {
  const years = curriculumOfficeProgramYears(sheets);
  const cohortYear = String(state.curriculumCohortYear);
  const schoolYear = document.getElementById("schoolYear")?.value || "";
  const options = [1, 2, 3].map((grade) => {
    const sheet = sheets.find((item) => officeText(item.name).trim() === `${grade}학년_편성과목`);
    const inputs = sheet ? curriculumOfficeReadInputs(sheet) : null;
    return sheet ? { grade, sheet: sheet.name, year: years[grade] || null, inputs, count: curriculumOfficeInputCount(inputs) } : null;
  }).filter(Boolean);
  if (!options.some((option) => option.count)) {
    curriculumOfficeStatus("울산 편제 점검 프로그램 파일이지만 편성 과목이 없습니다. 'N학년_편성과목' 시트에 과목을 입력·저장한 뒤 다시 올려 주세요.", false);
    return false;
  }
  const chosen = await askCurriculumOfficeGrade(options, curriculumOfficeChooseGrade(options, { cohortYear, schoolYear }), cohortYear);
  if (chosen === null) { curriculumOfficeStatus("울산 프로그램 파일 불러오기를 취소했습니다.", false); return false; }
  const option = options.find((item) => item.grade === chosen);
  if (!option?.count) { curriculumOfficeStatus(`'${option?.sheet || `${chosen}학년_편성과목`}'에 편성 과목이 없습니다.`, false); return false; }
  verifyTarget();
  const data = curriculumOfficeDataFromInputs(option.inputs, curriculumOfficeCatalog(sheets));
  const plan = sheets.find((item) => officeText(item.name).trim() === `${chosen}학년_편제표`);
  const activityRow = plan?.rows?.find((row) => /창의적\s*체험/.test(officeText(row?.[0])));
  const activity = OFFICE_FIELDS.map((_, index) => officeText(activityRow?.[6 + index]));
  const template = curriculumOfficeTemplate({ year: cohortYear, school: years.school || "", activity });
  const layout = { sheetName: option.sheet, sourceRowOffset: 0, sourceColumnOffset: 0, sheetPath: null, originalRowCount: 0, rowInsertions: [],
    formulas: {}, rows: [], mergedRanges: [], cellFills: {}, columnWidths: [], rowHeights: {}, hiddenRows: [],
    officeImport: { fileName: file.name, sheet: option.sheet, grade: chosen, year: option.year || null } };
  applyCurriculumData(layout, data, template);
  let planRows = [];
  try { planRows = curriculumPlanFromLayout(layout, `${file.name} ${option.sheet}`); } catch (error) { planRows = []; }
  if (!planRows.length && typeof planRowsFromImportedLayout === "function") planRows = planRowsFromImportedLayout(layout);
  const versionYear = typeof curriculumPlanVersionKey === "function" ? curriculumPlanVersionKey() : cohortYear;
  recordCurriculumUndo();
  state.curriculumMutationRevision += 1;
  state.curriculumPlanFilters = { grade: "", division: "", area: "", detail: "", query: "" };
  state.curriculumPlan = planRows;
  state.curriculumTemplateRows = planRows.map((row) => normalizeCurriculumPlanRow(row));
  state.curriculumPlanFileName = file.name;
  state.curriculumImportedLayout = layout;
  if (typeof recordCurriculumVersion === "function" && typeof latestCurriculumSavedVersion === "function" && !latestCurriculumSavedVersion(versionYear)) {
    recordCurriculumVersion(versionYear, layout, { reason: "울산 편제 점검 프로그램에서 불러옴", fileName: file.name, auto: true });
  }
  renderCurriculumStep();
  persistState();
  const groupCount = data.groups.length;
  curriculumOfficeStatus(`울산 편제 점검 프로그램 '${option.sheet}'에서 ${cohortYear}학년도 입학생 편제표를 불러왔습니다: 과목 ${planRows.length}개, 선택과목군 ${groupCount}개. 원본 양식이 없으므로 내보내기는 교육청 양식 또는 기본 양식으로 저장됩니다.`, true);
  return true;
}

// xlsb 파일: 필요한 시트만 바이너리로 읽는다. 읽지 못하면 xlsx로 바꿔 올리도록 안내한다.
async function importCurriculumOfficeXlsbFile(file) {
  const cohortYear = String(state.curriculumCohortYear), planType = state.curriculumPlanType;
  const revision = state.curriculumMutationRevision;
  try {
    const buffer = await file.arrayBuffer();
    const directory = readZipDirectory(buffer);
    const entries = {};
    for (const name of directory.keys()) {
      if (/^xl\/(workbook\.bin|_rels\/workbook\.bin\.rels|sharedStrings\.bin|worksheets\/sheet\d+\.bin)$/.test(name)) entries[name] = await readZipEntry(buffer, directory, name);
    }
    const sheets = curriculumOfficeXlsbSheets(entries, (name) => CURRICULUM_OFFICE_SHEET_PATTERN.test(name.trim()));
    if (!isCurriculumOfficeProgram(sheets)) {
      curriculumOfficeStatus("xlsb 파일은 울산 편제 점검 프로그램 파일만 읽을 수 있습니다. 다른 편제표는 엑셀에서 '다른 이름으로 저장 → Excel 통합 문서(*.xlsx)'로 바꿔 올려 주세요.", false);
      return false;
    }
    return await importCurriculumOfficeProgram(sheets, file, () => {
      if (String(state.curriculumCohortYear) !== cohortYear || state.curriculumPlanType !== planType || state.curriculumMutationRevision !== revision) {
        throw new Error("파일을 읽는 중 편제표가 바뀌었습니다. 대상 자료를 확인한 뒤 다시 올려 주세요.");
      }
    });
  } catch (error) {
    curriculumOfficeStatus(`xlsb 파일을 읽지 못했습니다(${error?.message || error}). 엑셀에서 '다른 이름으로 저장 → Excel 통합 문서(*.xlsx)'로 바꿔 올려 주세요.`, false);
    return false;
  }
}

if (typeof document !== "undefined") {
  document.getElementById("exportCurriculumOfficePlan")?.addEventListener("click", () => {
    if (typeof requireLocalWorkspaceAccess === "function" && !requireLocalWorkspaceAccess()) return;
    const button = document.getElementById("exportCurriculumOfficePlan");
    button.disabled = true;
    try {
      const { sheet, fileName, missing } = buildCurriculumOfficeExport();
      curriculumOfficeDownload(createXlsxBlob(curriculumOfficeWorkbookFiles([sheet])), fileName);
      curriculumOfficeStatus(`교육청 양식(울산 편제 점검 프로그램 「${sheet.name}」 모양)으로 저장했습니다.${missing.length ? ` ${missing.join("·")} 편제표가 없어 그 학년은 비어 있습니다.` : ""}`, true);
    } catch (error) {
      curriculumOfficeStatus(`교육청 양식 내보내기 실패: ${error?.message || error}`, false);
    } finally {
      button.disabled = false;
    }
  });
}
