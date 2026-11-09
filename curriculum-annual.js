"use strict";
// 올해 전학년 편제표는 따로 올리지 않고, 올해 1·2·3학년 입학생의 신입생 3개년 편제표에서
// 각 학년 열만 가져와 만든다. 1학년=올해 입학생, 2학년=전년도 입학생, 3학년=전전년도 입학생이다.

function annualCohortYears(schoolYear) {
  const year = Number(schoolYear);
  return { 1: String(year), 2: String(year - 1), 3: String(year - 2) };
}

function annualCreditNumber(value) {
  const number = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function annualCreditText(number) {
  return number ? String(Math.round(number * 100) / 100) : "";
}

function annualSubjectKey(subject) {
  return String(subject ?? "").replace(/\s+/g, "");
}

function annualGradeRows(cohorts, schoolYear, grade) {
  const year = annualCohortYears(schoolYear)[grade];
  return (cohorts?.[year]?.plan || []).filter((row) =>
    annualCreditNumber(row[`sem${grade}1`]) || annualCreditNumber(row[`sem${grade}2`]));
}

// 원본 3개년 편제표가 바뀌었는지 알 수 있도록 만들 때 쓴 학기 학점의 지문을 남긴다.
function annualCurriculumSignature(cohorts, schoolYear) {
  const parts = [];
  for (const grade of [1, 2, 3]) {
    parts.push(annualCohortYears(schoolYear)[grade], annualGradeRows(cohorts, schoolYear, grade)
      .map((row) => [row.division, row.area, row.detail, row.subject, row.baseCredit, row.opCredit,
        row[`sem${grade}1`], row[`sem${grade}2`]].join("|")).join("\n"));
  }
  return parts.join("\n#\n");
}

function annualSourceStatus(cohorts, schoolYear) {
  const years = annualCohortYears(schoolYear);
  return [1, 2, 3].map((grade) => ({
    grade, year: years[grade],
    fileName: cohorts?.[years[grade]]?.fileName || "",
    rows: annualGradeRows(cohorts, schoolYear, grade).length
  }));
}

function buildAnnualCurriculumLayout(cohorts, schoolYear) {
  // 세 입학생 편제표 모두 데이터(원본 양식)가 있으면 학교 입학생 편제표와 같은 양식으로 만든다.
  if (typeof buildAnnualCurriculumDataLayout === "function") {
    try {
      const formed = buildAnnualCurriculumDataLayout(cohorts, schoolYear);
      if (formed) return formed;
    } catch (error) {
      if (typeof console !== "undefined") console.warn("전학년 편제표를 학교 양식으로 만들지 못해 기본 양식으로 만듭니다.", error);
    }
  }
  const entries = new Map();
  for (const grade of [1, 2, 3]) {
    for (const row of annualGradeRows(cohorts, schoolYear, grade)) {
      let key = annualSubjectKey(row.subject);
      if (!key) continue;
      // 교차집중(음악↔미술): 과목마다 따로 두면 학기 학점을 두 번 세므로 한 행('음악, 미술' + 교차집중 표시)으로 묶는다.
      const crossFields = (row.crossFields || []).filter((field) => field.slice(3, 4) === String(grade));
      if (row.crossNames?.length > 1 && crossFields.length > 1) {
        key = `cross:${grade}:${row.crossNames.map(annualSubjectKey).join(",")}`;
        if (entries.has(key)) continue;
        entries.set(key, {
          division: row.division || "", area: row.area || "", detail: row.detail || "", subject: row.crossNames.join(", "),
          baseCredit: row.baseCredit || 0, opCredit: row.opCredit || 0, credits: {}, cross: crossFields.map((field) => `${field.slice(3, 4)}-${field.slice(4, 5)}`),
          ...(row.crossSplit ? { crossSplit: row.crossSplit } : {})
        });
        for (const semester of [1, 2]) entries.get(key).credits[`${grade}-${semester}`] = annualCreditNumber(row[`sem${grade}${semester}`]);
        continue;
      }
      if (!entries.has(key)) {
        entries.set(key, {
          division: row.division || "", area: row.area || "", detail: row.detail || "", subject: row.subject,
          baseCredit: row.baseCredit || 0, opCredit: row.opCredit || 0, credits: {}
        });
      }
      const entry = entries.get(key);
      if (!entry.baseCredit && row.baseCredit) entry.baseCredit = row.baseCredit;
      if (!entry.opCredit && row.opCredit) entry.opCredit = row.opCredit;
      for (const semester of [1, 2]) entry.credits[`${grade}-${semester}`] = annualCreditNumber(row[`sem${grade}${semester}`]);
    }
  }
  const divisions = new Map();
  for (const entry of entries.values()) {
    if (!divisions.has(entry.division)) divisions.set(entry.division, new Map());
    const areas = divisions.get(entry.division);
    if (!areas.has(entry.area)) areas.set(entry.area, []);
    areas.get(entry.area).push(entry);
  }
  const header = [
    ["", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["구분", "교과(군)", "세부과목", "", "기준학점", "운영학점", "1학년", "", "2학년", "", "3학년", "", "이수 학점", "필수이수 학점"],
    ["", "", "", "", "", "", "1학기", "2학기", "1학기", "2학기", "1학기", "2학기", "", ""]
  ];
  header[0][0] = `${schoolYear}학년도 전학년 편제표 (신입생 3개년 편제표 기준)`;
  const semesterKeys = ["1-1", "1-2", "2-1", "2-2", "3-1", "3-2"];
  const totals = Object.fromEntries(semesterKeys.map((key) => [key, 0]));
  const body = [];
  const crossMerges = [];
  const crossSplits = {};
  for (const [division, areas] of divisions) {
    let firstOfDivision = true;
    for (const [area, rows] of areas) {
      let firstOfArea = true;
      for (const entry of rows) {
        const sum = semesterKeys.reduce((total, key) => total + (entry.credits[key] || 0), 0);
        for (const key of semesterKeys) totals[key] += entry.credits[key] || 0;
        const head = [firstOfDivision ? division : "", firstOfArea ? area : "", entry.detail, entry.subject,
          annualCreditText(entry.baseCredit), annualCreditText(entry.opCredit)];
        if (entry.cross?.length > 1) {
          // 원본 편제표와 같은 모양: 윗줄 '교차집중(↔)'(두 학기 병합), 아랫줄 학기 학점.
          const columns = entry.cross.map((key) => 6 + semesterKeys.indexOf(key)).sort((a, b) => a - b);
          const label = semesterKeys.map((key, index) => index + 6 === columns[0] ? "교차집중(↔)" : "");
          const row = 3 + body.length + 1;
          crossMerges.push(`${String.fromCharCode(65 + columns[0])}${row}:${String.fromCharCode(65 + columns.at(-1))}${row}`);
          // 교차집중 학급 배분(첫 학기에 1반 더 받는 과목)은 원본 입학생 편제표의 선택을 물려받는다.
          if (entry.crossSplit) crossSplits[annualSubjectKey(entry.subject)] = entry.crossSplit;
          body.push([...head, ...label, annualCreditText(sum), ""]);
          body.push(["", "", "", "", "", "", ...semesterKeys.map((key) => annualCreditText(entry.credits[key])), "", ""]);
        } else {
          body.push([...head, ...semesterKeys.map((key) => annualCreditText(entry.credits[key])), annualCreditText(sum), ""]);
        }
        firstOfDivision = false;
        firstOfArea = false;
      }
    }
  }
  const grandTotal = semesterKeys.reduce((total, key) => total + totals[key], 0);
  const subtotal = ["", "", "소계", "", "", "", ...semesterKeys.map((key) => annualCreditText(totals[key])), annualCreditText(grandTotal), ""];
  return {
    rows: [...header, ...body, subtotal],
    mergedRanges: ["A1:N1", "A2:A3", "B2:B3", "C2:D3", "E2:E3", "F2:F3", "G2:H2", "I2:J2", "K2:L2", "M2:M3", "N2:N3", ...crossMerges],
    rowInsertions: [], rowHeights: {}, cellFills: {}, formulas: {}, ...(Object.keys(crossSplits).length ? { crossSplits } : {}),
    columnWidths: [16, 14, 10, 24, 8, 8, 8, 8, 8, 8, 8, 8, 10, 10],
    sheetName: "전학년 편제표",
    derived: true
  };
}

// 원본 엑셀이 없는 자동 생성 편제표를 내려받을 때 쓴다. 학교 양식으로 만든 전학년 편제표는 화면과 같은 서식으로 저장한다.
function buildDerivedCurriculumWorkbook(layout) {
  if (layout?.annualForm && layout.planTemplate && typeof createXlsxBlob === "function") return createXlsxBlob(buildAnnualStyledWorkbookFiles(layout));
  const rows = layout.rows.map((row, rowIndex) => Array.from({ length: layout.columnWidths.length }, (_, column) => {
    const text = row[column] ?? "";
    if (rowIndex === 0) return { v: text, s: 1 };
    if (rowIndex <= 2) return { v: text, s: 2 };
    const numeric = column >= 4 && text !== "" && Number.isFinite(Number(text));
    return { v: numeric ? Number(text) : text, s: column >= 4 ? 4 : 3 };
  }));
  return createWorkbookBlob([{
    name: layout.sheetName || "전학년 편제표",
    rows,
    widths: layout.columnWidths,
    merges: layout.mergedRanges,
    freeze: "A4"
  }]);
}

// ---- 학교 입학생 편제표와 같은 양식의 전학년 편제표(데이터 기반)
// 가장 최근 입학생(Y) 편제표의 양식(planTemplate: 제목·학교명·머리글 2행·열 구성·열 너비·글꼴·테두리·채움색·소계·창체·표기방법 안내)을 쓰고,
// 과목 행은 Y의 행 순서·묶음을 따른다. 각 학년 열(학점·택n 묶음·교차집중·메모)과 그 칸의 서식은 그 학년 입학생 편제표에서 가져온다.
// 같은 과목(과목명 칸이 같은 행)은 한 행으로 합치고, Y에 없는 과목은 같은 학기 열을 쓰는 같은 구분의 행 뒤(없으면 같은 교과(군) 끝)에 둔다.
// 원본 양식 데이터가 없으면(울산 파일만 있는 경우 등) null → buildAnnualCurriculumLayout의 기본 양식.

function annualRowKey(subject) {
  const names = planDataSubjectNames(subject?.name);
  return names.length ? names.map(planDataNameKey).join("|") : planDataNameKey(subject?.name);
}

function annualGradeFields(grade) {
  return [`sem${grade}1`, `sem${grade}2`];
}

// 그 학년 열에 쓰이는 내용: 학점·글자·교차집중·선택과목군·그 학년 메모(소인수·공동). 쓰는 학기 목록을 돌려준다(메모는 "note").
function annualGradeContent(data, subject, grade) {
  if (!subject || subject.fixed) return [];
  const fields = annualGradeFields(grade);
  const used = new Set();
  for (const field of fields) {
    if (Number(subject.credits?.[field]) > 0 || String(subject.texts?.[field] || "").trim()) used.add(field);
    if (subject.cross?.includes(field)) used.add(field);
  }
  for (const group of data.groups || []) {
    if (!group.members.includes(subject.id)) continue;
    for (const field of group.fields) if (fields.includes(field)) used.add(field);
  }
  if (subject.note && new RegExp(`${grade}\\s*학년`).test(subject.note)) used.add("note");
  return [...used];
}

// 두 양식의 열 역할(구분·교과(군)·과목명·학점·학기·이수학점…)로 원본 열 → Y 양식 열을 잇는다.
function annualColumnMap(from, to) {
  const map = new Map();
  for (const key of ["category", "domain", "area", "kind", "name", "base", "op", "completion", "required"]) {
    if (from[key] >= 0 && to[key] >= 0) map.set(from[key], to[key]);
  }
  from.semesters.forEach((column, index) => { if (column >= 0 && to.semesters[index] >= 0) map.set(column, to.semesters[index]); });
  return map;
}

function annualFormatTable() {
  const table = [];
  const keys = new Map();
  return {
    table,
    add(descriptor) {
      if (!descriptor) return -1;
      const key = JSON.stringify(descriptor);
      if (!keys.has(key)) { keys.set(key, table.length); table.push(planDataClone(descriptor)); }
      return keys.get(key);
    }
  };
}

// 같은 구분(학교 지정/학생 선택) 안 같은 교과(군)의 이어진 행 묶음(교과(군) 칸이 한 칸으로 병합되는 범위)
function annualAreaRuns(subjects) {
  const runs = [];
  const keyOf = (item) => `${planDataDivision(item.category) || planDataKey(item.category)}|${planDataKey(item.area)}`;
  for (const item of subjects) {
    const last = runs.at(-1);
    if (last && keyOf(last[0]) === keyOf(item) && planDataKey(item.area)) last.push(item);
    else runs.push([item]);
  }
  return runs;
}

// 그 교과(군) 행들의 학기 학점 합: 교차집중은 그 과목 행 한 번(학기마다), 택n 묶음은 n × 묶음 학점, 학기 칸 메모(소인수·공동)는 메모 학점.
function annualAreaCredit(run, groups) {
  const ids = new Set(run.map((item) => item.id));
  const grouped = new Set();
  let total = 0;
  for (const group of groups) {
    if (!group.members.some((id) => ids.has(id))) continue;
    for (const field of group.fields) total += (Number(group.pick) || 0) * (Number(group.credit) || 0);
    for (const id of group.members) for (const field of group.fields) grouped.add(`${id}:${field}`);
  }
  for (const item of run) {
    for (const [field, value] of Object.entries(item.credits || {})) if (!grouped.has(`${item.id}:${field}`)) total += Number(value) || 0;
    if (!Object.keys(item.credits || {}).length && item.note) total += Number(planDataNoteCredit(item.note)) || 0;
  }
  return total;
}

// 다른 입학생 편제표에서만 있는 과목 행이 끼어든 교과(군): 이수학점·필수이수학점을 교과(군) 전체 한 칸으로 합친다
// (예전에는 끼어든 행이 자기 편제표의 칸을 따로 가져 '필수이수 10'이 두 번 나왔다). 이수학점 = 그 교과(군) 모든 행의 학기 학점 합
// (화면·엑셀은 학기 칸 합계 수식), 필수이수학점 = Y 입학생 편제표의 그 교과(군) 값 한 번. 원본 양식이면 교과(군) 경계 테두리도
// 그 범위에 맞춘다(끼어든 행은 이웃 Y 행 서식을 쓰므로 교과(군) 끝 굵은 선이 가운데 생길 수 있다). Y 행만 있는 교과(군)은 Y 그대로.
function annualJoinAreaRuns(subjects, groups, formats, original) {
  let count = 0;
  for (const run of annualAreaRuns(subjects)) {
    if (run.length < 2 || run.every((item) => item.annualFromY)) continue;
    const segs = new Set(run.map((item) => item.completion?.seg || "")), required = new Set(run.map((item) => item.required?.seg || ""));
    if (segs.size < 2 && required.size < 2) continue;
    count++;
    const yRequired = run.find((item) => item.annualFromY && String(item.required?.text || "").trim()) || run.find((item) => String(item.required?.text || "").trim());
    const total = annualAreaCredit(run, groups);
    for (const item of run) {
      item.completion = { seg: `annual-c${count}`, text: total ? planDataNumberText(total) : "", formula: false };
      item.required = { seg: `annual-q${count}`, text: yRequired?.required?.text || "" };
    }
    if (original) annualRunBorders(run, formats);
  }
  return count;
}

// 교과(군) 묶음 경계: 첫 행 위·마지막 행 아래는 그 교과(군) Y 첫 행·마지막 행의 선, 그 사이는 Y 안쪽 행의 선(없으면 가는 선).
function annualRunBorders(run, formats) {
  const table = formats.table;
  const edge = (styles, side) => {
    const result = {};
    for (const [column, index] of Object.entries(styles || {})) result[column] = table[index]?.bd?.[side] ? { s: table[index].bd[side], c: table[index].bd[`${side}c`] } : null;
    return result;
  };
  const ys = run.filter((item) => item.annualFromY && item.styles?.length);
  if (!ys.length) return;
  const top = edge(ys[0].styles[0], "t"), bottom = edge(ys.at(-1).styles.at(-1), "b");
  const innerBottom = ys.length > 1 ? edge(ys[0].styles.at(-1), "b") : {};
  const innerTop = ys.length > 1 ? edge(ys.at(-1).styles[0], "t") : {};
  const set = (styles, side, value) => {
    for (const [column, index] of Object.entries(styles)) {
      const descriptor = planDataClone(table[index] || {});
      const want = value[column] === undefined ? (side === "b" || side === "t" ? { s: "thin" } : null) : value[column];
      descriptor.bd ||= {};
      if (want) { descriptor.bd[side] = want.s; if (want.c) descriptor.bd[`${side}c`] = want.c; else delete descriptor.bd[`${side}c`]; }
      else { delete descriptor.bd[side]; delete descriptor.bd[`${side}c`]; }
      if (!Object.keys(descriptor.bd).length) delete descriptor.bd;
      styles[column] = formats.add(descriptor);
    }
  };
  run.forEach((item, index) => {
    if (!item.styles?.length) return;
    set(item.styles[0], "t", index === 0 ? top : innerTop);
    set(item.styles.at(-1), "b", index === run.length - 1 ? bottom : innerBottom);
  });
}

function buildAnnualCurriculumDataLayout(cohorts, schoolYear) {
  if (typeof curriculumSheetFromData !== "function" || typeof applyCurriculumData !== "function") return null;
  const years = annualCohortYears(schoolYear);
  const sources = {};
  for (const grade of [1, 2, 3]) {
    const layout = cohorts?.[years[grade]]?.layout;
    if (!layout?.planData || !layout.planTemplate || layout.derived) return null;
    sources[grade] = { grade, year: years[grade], layout, data: layout.planData, template: layout.planTemplate };
  }
  const base = sources[1];
  const template = planDataClone(base.template);
  const columns = template.columns;
  const formats = annualFormatTable();
  const original = Boolean(base.template.format?.styleTable);
  const styleMaps = {};
  for (const grade of [1, 2, 3]) {
    const source = sources[grade];
    source.columnMap = annualColumnMap(source.template.columns, columns);
    const table = source.template.format?.styleTable || [];
    styleMaps[grade] = (index) => Number.isInteger(index) && table[index] ? formats.add(table[index]) : null;
  }
  // 양식(머리글·소계) 서식 번호는 Y 서식 표를 그대로 앞에 둔다.
  for (const descriptor of base.template.format?.styleTable || []) formats.add(descriptor);
  const keyed = (source) => {
    const map = new Map();
    for (const subject of planDataSubjects(source.data)) {
      const key = annualRowKey(subject);
      if (key && !map.has(key)) map.set(key, subject);
    }
    return map;
  };
  for (const grade of [1, 2, 3]) sources[grade].byKey = keyed(sources[grade]);

  // 1) 행 순서: Y 편제표의 과목 행(모든 학년 열 내용으로 위치를 기억) → 2·3학년 입학생 편제표에만 있는 과목을 끼워 넣는다.
  const slots = [];
  const slotByKey = new Map();
  const addSlot = (slot, index = slots.length) => { slots.splice(index, 0, slot); slotByKey.set(slot.key, slot); };
  for (const subject of planDataSubjects(base.data)) {
    const key = annualRowKey(subject);
    if (!key || slotByKey.has(key)) continue;
    const fields = new Set([1, 2, 3].flatMap((grade) => annualGradeContent(base.data, subject, grade)));
    addSlot({ key, y: subject, fields, division: planDataDivision(subject.category), area: planDataKey(subject.area), category: planDataKey(subject.category) });
  }
  for (const grade of [2, 3]) {
    const source = sources[grade];
    for (const subject of planDataSubjects(source.data)) {
      const content = annualGradeContent(source.data, subject, grade);
      if (!content.length) continue;
      const key = annualRowKey(subject);
      if (slotByKey.has(key)) { for (const field of content) slotByKey.get(key).fields.add(field); continue; }
      const division = planDataDivision(subject.category), area = planDataKey(subject.area), category = planDataKey(subject.category);
      const sameDivision = (slot) => slot.division === division || slot.category === category;
      let after = -1;
      const group = (source.data.groups || []).find((item) => item.members.includes(subject.id) && item.fields.some((field) => content.includes(field)));
      if (group) {
        const placed = group.members.map((id) => source.data.subjects.find((item) => item.id === id)).filter(Boolean)
          .map((member) => slots.findIndex((slot) => slot.key === annualRowKey(member))).filter((index) => index >= 0);
        if (placed.length) after = Math.max(...placed);
      }
      const field = content.find((item) => item !== "note");
      const lastIndex = (test) => { for (let index = slots.length - 1; index >= 0; index--) if (test(slots[index])) return index; return -1; };
      if (after < 0 && field) after = lastIndex((slot) => sameDivision(slot) && slot.fields.has(field));
      if (after < 0) after = lastIndex((slot) => sameDivision(slot) && slot.area === area);
      if (after < 0) after = lastIndex((slot) => sameDivision(slot));
      // 이웃 행: 끼워 넣는 자리 바로 위(없으면 아래)의 Y 과목 행. 새 행은 이 행의 칸 모양을 쓴다.
      const position = after < 0 ? slots.length : after + 1;
      const above = slots.slice(0, position).reverse().find((slot) => slot.y && sameDivision(slot)) || slots.slice(0, position).reverse().find((slot) => slot.y);
      const below = slots.slice(position).find((slot) => slot.y && sameDivision(slot));
      addSlot({ key, y: null, neighbor: (above || below)?.y || null, fields: new Set(content), division, area, category }, position);
    }
  }

  // 2) 행마다 학년 열 내용을 그 학년 입학생 편제표에서 가져와 한 과목 행으로 합친다.
  let nextId = 1;
  const subjects = [];
  const memberIds = new Map(); // `${grade}:${원래 id}` → 새 id
  for (const slot of slots) {
    const parts = {};
    for (const grade of [1, 2, 3]) {
      const subject = sources[grade].byKey.get(slot.key);
      const content = annualGradeContent(sources[grade].data, subject, grade);
      if (subject && content.length) parts[grade] = { subject, content, source: sources[grade] };
    }
    const grades = Object.keys(parts).map(Number);
    if (!grades.length) continue;
    const primary = parts[grades[0]];
    const shape = slot.y || primary.subject;
    const id = `a${nextId++}`;
    for (const grade of grades) memberIds.set(`${grade}:${parts[grade].subject.id}`, id);
    const mapColumns = (rowValues, source, accept, convert = (value) => value) => {
      const result = {};
      for (const [column, value] of Object.entries(rowValues || {})) {
        const target = source.columnMap.get(Number(column));
        if (target === undefined || !accept(target)) continue;
        const converted = convert(value);
        if (converted !== null && converted !== undefined && converted !== "") result[target] = converted;
      }
      return result;
    };
    // 서식: 칸 모양(글꼴 크기·굵기·정렬·테두리)은 Y 양식의 그 행(Y에 없는 과목은 바로 위 같은 구분의 Y 행 = 이웃 행)을 쓰고,
    // 학년 열·과목명의 글자색(변경 표시 빨간 글씨 등)과 학년 열 채움색은 그 학년 입학생 편제표에서 가져온다.
    const neighbor = slot.y || slot.neighbor || primary.subject;
    const neighborOwn = Boolean(slot.y || slot.neighbor);
    const semesterOf = (column) => columns.semesters.indexOf(column);
    const gradeOfColumn = (column) => semesterOf(column) >= 0 ? Math.floor(semesterOf(column) / 2) + 1 : 0;
    const span = Math.max(1, ...grades.map((grade) => parts[grade].subject.span || 1), slot.y?.span || 1);
    const pickRow = (list, offset) => list?.[Math.min(offset, (list?.length || 1) - 1)] || {};
    const yTable = base.template.format?.styleTable || [];
    const sourceDescriptor = (part, offset, column) => {
      const from = [...part.source.columnMap].find(([, target]) => target === column)?.[0];
      const table = part.source.template.format?.styleTable || [];
      return from === undefined ? null : table[pickRow(part.subject.styles, offset)[from]] || null;
    };
    // 다른 입학생 편제표에서 온 칸: Y 칸 모양 + 그 편제표 글자색. 학기 칸은 Y 칸에 가로 정렬이 없으면 그 편제표 정렬(없으면 가운데).
    const withColor = (descriptor, source, semester) => {
      const next = { ...(descriptor || {}) };
      if (source?.fc) next.fc = source.fc; else delete next.fc;
      if (semester && !next.h) next.h = source?.h || "center";
      return formats.add(next);
    };
    const styles = [], fills = [];
    for (let offset = 0; offset < span; offset++) {
      const own = neighborOwn ? pickRow(neighbor.styles, offset) : {};
      const style = {};
      for (let column = 0; column < template.width; column++) {
        const descriptor = neighborOwn ? yTable[own[column]] : null;
        if (!descriptor) continue;
        const grade = gradeOfColumn(column);
        const part = grade ? parts[grade] : [columns.name, columns.base, columns.op].includes(column) ? primary : null;
        // Y 편제표의 그 학년 열(또는 Y 과목명)은 서식 그대로, 다른 입학생 편제표에서 온 칸은 Y 칸 모양 + 그 편제표 글자색.
        if (!part || (slot.y && part.source === base)) { style[column] = formats.add(descriptor); continue; }
        style[column] = withColor(descriptor, sourceDescriptor(part, offset, column), Boolean(grade));
      }
      if (!neighborOwn) {
        for (const [column, index] of Object.entries(pickRow(primary.subject.styles, offset))) {
          const target = primary.source.columnMap.get(Number(column));
          if (target !== undefined) style[target] = styleMaps[primary.source.grade](index);
        }
      }
      const fill = {};
      const shapeFill = neighborOwn ? pickRow(neighbor.fills, offset) : {};
      for (const [column, color] of Object.entries(shapeFill)) if (!gradeOfColumn(Number(column))) fill[column] = color;
      for (const grade of grades) {
        for (const [column, color] of Object.entries(pickRow(parts[grade].subject.fills, offset))) {
          const target = parts[grade].source.columnMap.get(Number(column));
          if (target !== undefined && gradeOfColumn(target) === grade) fill[target] = color;
        }
      }
      styles.push(style);
      fills.push(fill);
    }
    // 행 높이: Y 행(이웃 행) 높이, 다른 편제표에서 온 행은 그 편제표 높이를 Y 확대 비율로 맞춘 값과 비교해 큰 쪽.
    const zoomRatio = (Number(primary.source.template.format?.zoom) || 100) / (Number(base.template.format?.zoom) || 100);
    const heights = Array.from({ length: span }, (_, offset) => {
      const own = neighborOwn ? (neighbor.heights?.[offset] ?? neighbor.heights?.[0] ?? null) : null;
      if (slot.y && primary.source === base) return own;
      const scaled = Number(primary.subject.heights?.[offset] ?? primary.subject.heights?.[0]) * zoomRatio;
      return Math.max(Number(own) || 0, Number.isFinite(scaled) ? Math.round(scaled * 10) / 10 : 0) || null;
    });
    const sameDivision = slot.neighbor && planDataDivision(slot.neighbor.category) === planDataDivision(primary.subject.category);
    const category = slot.y ? shape.category : sameDivision ? slot.neighbor.category : primary.subject.category;
    const nameRuns = primary.subject.nameRuns
      ? (primary.source === base ? planDataClone(primary.subject.nameRuns)
        : primary.subject.nameRuns.map((run) => Object.fromEntries(Object.entries(run).filter(([key]) => !["sz", "fn"].includes(key)))))
      : null;
    const credits = {}, texts = {};
    let cross = null, crossSplit = null, note = "";
    for (const grade of grades) {
      const subject = parts[grade].subject;
      for (const field of annualGradeFields(grade)) {
        if (Object.hasOwn(subject.credits || {}, field)) credits[field] = subject.credits[field];
        if (subject.texts?.[field]) texts[field] = subject.texts[field];
      }
      const ownCross = (subject.cross || []).filter((field) => annualGradeFields(grade).includes(field));
      if (ownCross.length) { cross = [...(cross || []), ...ownCross]; if (subject.crossSplit) crossSplit = subject.crossSplit; }
      if (!note && parts[grade].content.includes("note")) note = subject.note;
    }
    const seg = (value, prefix) => value ? { ...value, seg: `${prefix}:${value.seg}` } : null;
    const shapePrefix = slot.y ? `y${base.year}` : `y${primary.source.year}`;
    subjects.push({
      id, category, domain: slot.y ? shape.domain || "" : sameDivision ? slot.neighbor.domain || "" : shape.domain || "", area: shape.area,
      kindText: shape.kindText, kind: shape.kind || primary.subject.kind || "",
      kindJoin: Boolean(slot.y && shape.kindJoin), name: primary.subject.name,
      ...(primary.subject.originalName !== undefined ? { originalName: primary.subject.originalName } : {}),
      ...(nameRuns ? { nameRuns } : {}),
      base: primary.subject.base, op: primary.subject.op, opFormula: false,
      credits, texts, cross: cross && cross.length ? cross : null, ...(crossSplit ? { crossSplit } : {}), note,
      completion: seg(shape.completion, shapePrefix), required: seg(shape.required, shapePrefix), extra: {},
      span, semMerge: Boolean(primary.subject.semMerge), styles: original ? styles : [], fills, heights,
      hidden: false, styleRows: [], annualSources: Object.fromEntries(grades.map((grade) => [grade, parts[grade].source.year])),
      ...(slot.y ? { annualFromY: true } : {}),
      ...(shape.planSectionManual ? { planSection: shape.planSection, planSectionManual: true } : {})
    });
  }
  // 3) 선택과목군: 그 학년 입학생 편제표의 그 학년 묶음(택n·학점)을 그대로.
  const groups = [];
  for (const grade of [1, 2, 3]) {
    const source = sources[grade];
    for (const group of source.data.groups || []) {
      const fields = group.fields.filter((field) => annualGradeFields(grade).includes(field));
      if (!fields.length) continue;
      const members = [...new Set(group.members.map((member) => memberIds.get(`${grade}:${member}`)).filter(Boolean))];
      if (!members.length) continue;
      groups.push({ id: `ag${nextId++}`, fields, pick: group.pick, credit: planDataGroupCredit(source.data, group), members });
    }
  }
  // 묶음 과목이 이어진 행이 되도록(택n 칸 아래 학점 칸) 떨어진 구성 과목을 첫 과목 뒤로 모은다.
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const group of groups) {
      const indexes = group.members.map((id) => subjects.findIndex((item) => item.id === id)).sort((a, b) => a - b);
      if (indexes.every((value, index) => index === 0 || value === indexes[index - 1] + 1)) continue;
      const items = indexes.map((index) => subjects[index]);
      const first = items[0];
      for (const item of items.slice(1)) subjects.splice(subjects.indexOf(item), 1);
      subjects.splice(subjects.indexOf(first) + 1, 0, ...items.slice(1));
      moved = true;
    }
    if (!moved) break;
  }
  for (const group of groups) {
    const order = new Map(subjects.map((item, index) => [item.id, index]));
    group.members.sort((a, b) => order.get(a) - order.get(b));
  }
  annualJoinAreaRuns(subjects, groups, formats, original);

  // 4) 양식: 제목은 '전학년'으로, 학년 머리글에 입학연도(작은 글씨), 창의적 체험활동 같은 소계 아래 값은 그 학년 입학생 편제표 값.
  const headerRows = template.header.rows;
  template.header.rich ||= {};
  template.header.styles ||= {};
  headerRows.forEach((values, row) => values.forEach((value, column) => {
    const text = String(value ?? "");
    if (/편제표/.test(text) && /학년도/.test(text)) {
      let next = text.replace(/\d{4}\s*학년도/, `${schoolYear}학년도`);
      next = /신입생\s*3\s*개년/.test(next) ? next.replace(/신입생\s*3\s*개년/, "전학년") : next.replace(/학년도\s*/, "학년도 전학년 ");
      values[column] = next;
      delete template.header.rich[`${row}:${column}`];
      return;
    }
    const grade = text.trim().match(/^([123])\s*학년$/)?.[1];
    if (grade && columns.semesters.includes(column)) {
      const descriptor = base.template.format?.styleTable?.[template.header.styles[`${row}:${column}`]] || {};
      const size = Math.max(6, Math.round((Number(descriptor.sz) || 11) * 0.6));
      template.header.rich[`${row}:${column}`] = [{ t: text, inherit: 1 },
        { t: `(${years[grade]})`, ...(descriptor.b ? { b: 1 } : {}), sz: size, ...(descriptor.fn ? { fn: descriptor.fn } : {}), ...(descriptor.fc ? { fc: descriptor.fc } : {}) }];
      values[column] = `${text}(${years[grade]})`;
    }
  }));
  template.header.styles = Object.fromEntries(Object.entries(template.header.styles).map(([key, index]) => [key, styleMaps[1](index)]));
  template.footer.styles = Object.fromEntries(Object.entries(template.footer.styles || {}).map(([key, index]) => [key, styleMaps[1](index)]));
  const firstSemester = Math.min(...columns.semesters.filter((column) => column >= 0));
  const footerLabel = (part, row, width) => part.rows[row].slice(0, Math.min(width, firstSemester)).map((value) => planDataKey(value)).join("");
  template.footer.rows.forEach((values, row) => {
    const label = footerLabel(template.footer, row, template.width);
    if (!label) return;
    let changed = false;
    for (const grade of [2, 3]) {
      const other = sources[grade].template;
      const match = other.footer.rows.findIndex((_, index) => footerLabel(other.footer, index, other.width) === label);
      if (match < 0) continue;
      [0, 1].forEach((offset) => {
        const index = (grade - 1) * 2 + offset;
        const from = other.columns.semesters[index], to = columns.semesters[index];
        if (from < 0 || to < 0) return;
        if (Object.hasOwn(template.footer.formulas || {}, `${row}:${to}`) || Object.hasOwn(other.footer.formulas || {}, `${match}:${from}`)) return;
        values[to] = String(other.footer.rows[match][from] ?? "");
        changed = true;
      });
    }
    // 학기 값이 바뀐 행의 이수학점(합계) 칸이 수식이 아니면 여섯 학기 값의 합으로 고친다.
    const total = columns.completion;
    if (changed && total >= 0 && !Object.hasOwn(template.footer.formulas || {}, `${row}:${total}`) && planDataNumber(values[total]) !== null) {
      values[total] = planDataNumberText(columns.semesters.filter((column) => column >= 0).reduce((sum, column) => sum + (planDataNumber(values[column]) || 0), 0));
    }
  });
  if (template.format) template.format = { ...template.format, styleTable: formats.table };
  const data = { version: PLAN_DATA_VERSION, converter: PLAN_DATA_CONVERTER, nextId, subjects, groups };
  const layout = {
    rows: [], mergedRanges: [], formulas: {}, rowInsertions: [], rowHeights: {}, cellFills: {},
    sheetName: "전학년 편제표", derived: true, annualForm: true,
    annualSources: Object.fromEntries([1, 2, 3].map((grade) => [grade, years[grade]]))
  };
  applyCurriculumData(layout, data, template);
  return layout;
}

// 전학년 편제표(학교 양식)를 엑셀로: 화면과 같은 칸·병합·수식·서식(글꼴·테두리·정렬·채움색·열 너비·행 높이·서식 있는 글자).
function annualXmlEscape(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char])
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function annualColumnName(index) {
  let value = index + 1, name = "";
  while (value > 0) { const remainder = (value - 1) % 26; name = String.fromCharCode(65 + remainder) + name; value = Math.floor((value - 1) / 26); }
  return name;
}

function buildAnnualStyledWorkbookFiles(sourceLayout) {
  // 선택과목군은 학기 열에서 구성 과목 행 전체를 한 칸으로 병합해 '택n\nm학점'만 적는다(curriculum-data.js curriculumExportLayout).
  const layout = typeof curriculumExportLayout === "function" ? curriculumExportLayout(sourceLayout) : sourceLayout;
  const template = layout.planTemplate;
  const table = template?.format?.styleTable || layout.styleTable || [];
  const baseFont = template?.format?.baseFont || { sz: 11, fn: "맑은 고딕" };
  const width = template?.width || Math.max(...layout.rows.map((row) => row.length));
  const fontKey = new Map(), fonts = [], fillKey = new Map(), fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borderKey = new Map(), borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const xfKey = new Map(), xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const fontXml = (item) => `<font>${item.b ? "<b/>" : ""}${item.i ? "<i/>" : ""}${item.s ? "<strike/>" : ""}${item.u ? "<u/>" : ""}<sz val="${Number(item.sz) || Number(baseFont.sz) || 11}"/>${item.fc ? `<color rgb="FF${String(item.fc).replace(/^#/, "")}"/>` : '<color theme="1"/>'}<name val="${annualXmlEscape(item.fn || baseFont.fn || "맑은 고딕")}"/><family val="3"/><charset val="129"/></font>`;
  const intern = (map, list, xml) => { if (!map.has(xml)) { map.set(xml, list.length); list.push(xml); } return map.get(xml); };
  intern(fontKey, fonts, fontXml({}));
  const runProperties = (run) => fontXml(run).replace(/^<font>/, "<rPr>").replace(/<\/font>$/, "</rPr>").replace(/<name /, "<rFont ");
  const xfFor = (descriptor, fill) => {
    const fontId = intern(fontKey, fonts, fontXml(descriptor || {}));
    const fillId = fill ? intern(fillKey, fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${String(fill).replace(/^#/, "")}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const bd = descriptor?.bd || {};
    const edge = (side, name) => bd[side] ? `<${name} style="${bd[side]}">${bd[`${side}c`] ? `<color rgb="FF${String(bd[`${side}c`]).replace(/^#/, "")}"/>` : '<color indexed="64"/>'}</${name}>` : `<${name}/>`;
    const borderId = intern(borderKey, borders, `<border>${edge("l", "left")}${edge("r", "right")}${edge("t", "top")}${edge("b", "bottom")}<diagonal/></border>`);
    const alignment = descriptor ? `<alignment${descriptor.h ? ` horizontal="${descriptor.h}"` : ""}${descriptor.v && descriptor.v !== "bottom" ? ` vertical="${descriptor.v}"` : ""}${descriptor.w ? ' wrapText="1"' : ""}${descriptor.sh ? ' shrinkToFit="1"' : ""}${descriptor.rot ? ` textRotation="${descriptor.rot}"` : ""}${descriptor.ind ? ` indent="${descriptor.ind}"` : ""}/>` : "";
    return intern(xfKey, xfs, `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">${alignment}</xf>`);
  };
  const covered = new Set();
  const mergeEdges = new Map();
  for (const reference of layout.mergedRanges || []) {
    const range = planDataRange(reference);
    if (!range) continue;
    for (let row = range.startRow; row <= range.endRow; row++) for (let column = range.startColumn; column <= range.endColumn; column++) {
      if (row !== range.startRow || column !== range.startColumn) covered.add(`${row}:${column}`);
      mergeEdges.set(`${row}:${column}`, range);
    }
  }
  const subjectById = new Map((layout.planData?.subjects || []).map((item) => [item.id, item]));
  const meta = layout.planRowMeta || [];
  const sheetRows = layout.rows.map((values, row) => {
    const cells = [];
    for (let column = 0; column < width; column++) {
      const key = `${row}:${column}`;
      // 병합 범위 안의 가려진 칸도 테두리를 그리도록 서식만 둔다(엑셀이 병합 칸 테두리를 칸마다 그린다).
      const range = mergeEdges.get(key);
      const anchorKey = range ? `${range.startRow}:${range.startColumn}` : key;
      let descriptor = table[layout.cellStyles?.[key] ?? layout.cellStyles?.[anchorKey]] || null;
      if (layout.wrapCells?.has(anchorKey)) descriptor = { ...(descriptor || {}), w: 1, v: "center", h: descriptor?.h || "center" };
      const fill = layout.cellFills?.[key] || (range ? layout.cellFills?.[anchorKey] : "") || "";
      const style = descriptor || fill ? xfFor(descriptor, fill) : 0;
      const reference = `${annualColumnName(column)}${row + 1}`;
      const s = style ? ` s="${style}"` : "";
      if (covered.has(key)) { if (style) cells.push(`<c r="${reference}"${s}/>`); continue; }
      const value = String(values[column] ?? "");
      const formula = layout.formulas?.[key];
      if (formula) {
        const number = planDataNumber(value);
        cells.push(number !== null ? `<c r="${reference}"${s}><f>${annualXmlEscape(String(formula).replace(/^=/, ""))}</f><v>${number}</v></c>`
          : `<c r="${reference}"${s}><f>${annualXmlEscape(String(formula).replace(/^=/, ""))}</f></c>`);
        continue;
      }
      if (!value.trim()) { if (style) cells.push(`<c r="${reference}"${s}/>`); continue; }
      if (planDataNumber(value) !== null && !/^0\d/.test(value.trim())) { cells.push(`<c r="${reference}"${s}><v>${Number(value)}</v></c>`); continue; }
      const info = meta[row] || {};
      const subject = info.type === "subject" && column === template?.columns?.name ? subjectById.get(info.id) : null;
      let runs = subject && typeof planDataNameRuns === "function" ? planDataNameRuns(subject) : null;
      if (!runs && layout.cellRich?.[key] && layout.cellRich[key].map((run) => run.t).join("") === value) runs = layout.cellRich[key];
      if (runs) {
        cells.push(`<c r="${reference}"${s} t="inlineStr"><is>${runs.map((run) => run.inherit ? `<r><t xml:space="preserve">${annualXmlEscape(run.t)}</t></r>`
          : `<r>${runProperties(run)}<t xml:space="preserve">${annualXmlEscape(run.t)}</t></r>`).join("")}</is></c>`);
        continue;
      }
      cells.push(`<c r="${reference}"${s} t="inlineStr"><is><t xml:space="preserve">${annualXmlEscape(value)}</t></is></c>`);
    }
    const height = Number(layout.rowHeights?.[row]);
    const hidden = (layout.hiddenRows || []).includes(row) ? ' hidden="1"' : "";
    return `<row r="${row + 1}"${Number.isFinite(height) && height > 0 ? ` ht="${height}" customHeight="1"` : ""}${hidden}>${cells.join("")}</row>`;
  }).join("");
  const cols = Array.from({ length: width }, (_, column) => {
    const value = Number(layout.columnWidths?.[column]) || Number(template?.format?.defaultColumnWidth) || 8.43;
    return `<col min="${column + 1}" max="${column + 1}" width="${value}" customWidth="1"/>`;
  }).join("");
  const merges = (layout.mergedRanges || []).length ? `<mergeCells count="${layout.mergedRanges.length}">${layout.mergedRanges.map((reference) => `<mergeCell ref="${reference}"/>`).join("")}</mergeCells>` : "";
  const zoom = Number(template?.format?.zoom) || 100;
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0" zoomScale="${zoom}"/></sheetViews><sheetFormatPr defaultRowHeight="${Number(template?.format?.defaultRowHeight) || 15}"/><cols>${cols}</cols><sheetData>${sheetRows}</sheetData>${merges}<pageMargins left="0.3" right="0.3" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="1"/></worksheet>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="${fonts.length}">${fonts.join("")}</fonts><fills count="${fills.length}">${fills.join("")}</fills><borders count="${borders.length}">${borders.join("")}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="표준" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const name = annualXmlEscape(String(layout.sheetName || "전학년 편제표").replace(/[\[\]:*?\/\\]/g, " ").slice(0, 31));
  return {
    "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
    "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    "xl/styles.xml": stylesXml,
    "xl/worksheets/sheet1.xml": sheetXml
  };
}
