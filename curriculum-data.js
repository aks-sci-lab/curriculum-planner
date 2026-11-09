"use strict";
// 1단계 편제표 데이터 모델.
// 업로드한 편제표 표(layout)를 과목·선택과목군 데이터(planData)로 바꾸고, 원본의 제목·머리글·소계 행과 열 너비는
// 내보내기용 양식(planTemplate)으로만 보관한다. 화면·계산·내보내기에 쓰는 표(layout.rows 등)는 매번 데이터에서 다시 만든다.
// 이 파일은 app.js보다 먼저 로드되므로, 다른 파일의 함수는 실행 시점에만 부른다.

const PLAN_DATA_FIELDS = ["sem11", "sem12", "sem21", "sem22", "sem31", "sem32"];
const PLAN_DATA_VERSION = 1;
// 업로드 변환기 버전. 저장된 편제표 데이터의 planData.converter가 이보다 낮으면(없으면 1 이하) 원본 엑셀을 새 변환기로 다시 읽는다
// (curriculum-reconvert.js). 2: 교차집중 과목·묶음 학점(수식·글자 칸)·공식 과목명 자동 수정.
const PLAN_DATA_CONVERTER = 2;
const PLAN_DATA_STOP = /소계|합계|총이수|창의적체험|필수이수|표기방법/;
const PLAN_DATA_NOTE = /[123]\s*학년[\s\S]*학기/;

function planDataText(value) {
  return String(value ?? "");
}

function planDataKey(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

function planDataNumber(value) {
  const text = String(value ?? "").replace(/,/g, "").trim();
  return /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
}

function planDataNumberText(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.round(number * 1000) / 1000) : "";
}

// '택3', '택1(2학점)'처럼 학기 칸에 적힌 선택 수(와 학점)를 읽는다.
function planDataTag(value) {
  const match = String(value ?? "").trim().match(/^택\s*(\d+)(?:\s*[·×(（,]?\s*(\d+(?:\.\d+)?)\s*(?:학점)?\s*[)）]?)?$/);
  return match ? { pick: Number(match[1]), credit: match[2] ? Number(match[2]) : 0 } : null;
}

function planDataRange(reference) {
  const [startRef, endRef = startRef] = String(reference || "").split(":");
  const range = {
    startColumn: columnIndex(startRef), endColumn: columnIndex(endRef),
    startRow: Number(startRef.match(/\d+/)?.[0]) - 1, endRow: Number(endRef.match(/\d+/)?.[0]) - 1
  };
  const valid = Object.values(range).every(Number.isInteger) && range.startColumn >= 0 && range.startRow >= 0 &&
    range.endColumn >= range.startColumn && range.endRow >= range.startRow;
  return valid ? range : null;
}

function planDataRef(startRow, startColumn, endRow = startRow, endColumn = startColumn) {
  const start = `${columnName(startColumn)}${startRow + 1}`;
  const end = `${columnName(endColumn)}${endRow + 1}`;
  return start === end ? start : `${start}:${end}`;
}

function planDataClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function planDataSubjectNames(name) {
  return typeof curriculumSubjectNames === "function"
    ? curriculumSubjectNames(name)
    : String(name ?? "").split(/[,，、]/).map((part) => part.replace(/↔/g, " ").replace(/^[*＊★☆■\s]+|[*＊★☆■\s]+$/g, "")
      .replace(/\s+/g, " ").trim()).filter(Boolean);
}

function planDataNameKey(name) {
  return String(name ?? "").replace(/↔/g, " ").replace(/^[*＊★☆■\s]+|[*＊★☆■\s]+$/g, "").replace(/\s+/g, "").toLowerCase();
}

// 학생 선택·학교 지정·그 밖(공동교육과정 등)을 구분한다. 알 수 없으면 빈 값이다.
function planDataDivision(category) {
  const text = planDataKey(category);
  if (text.includes("학생선택") || /^학생/.test(text)) return "학생 선택 교육과정";
  if (text.includes("학교지정") || /^학교/.test(text)) return "학교 지정 교육과정";
  return "";
}

function planDataGrade(field) {
  return field.slice(3, 4);
}

function planDataSemester(field) {
  return field.slice(4, 5);
}

function planDataFieldLabel(fields) {
  if (!fields.length) return "";
  if (fields.length === 1) return `${planDataGrade(fields[0])}-${planDataSemester(fields[0])}`;
  return `${planDataGrade(fields[0])}-${fields.map(planDataSemester).join("·")}`;
}

function planDataGroupLabel(group) {
  return `${planDataFieldLabel(group.fields)} 택${group.pick} · ${planDataNumberText(group.credit)}학점`;
}

// 원본 엑셀 행 번호(크롭 기준). 예전 앱에서 끼워 넣은 행은 원본 행이 없다(null).
function planDataRowSources(layout) {
  if (Array.isArray(layout.planRowMeta) && layout.planRowMeta.length === layout.rows.length) {
    return layout.planRowMeta.map((meta) => meta?.source ?? null);
  }
  const count = Number.isInteger(layout.originalRowCount) ? layout.originalRowCount : layout.rows.length;
  const sources = Array.from({ length: count }, (_, index) => index);
  for (const row of layout.rowInsertions || []) sources.splice(row, 0, null);
  while (sources.length < layout.rows.length) sources.push(null);
  return sources.slice(0, layout.rows.length);
}

function planDataHeaderLabels(layout, rowsBefore, mergeAt, expanded) {
  const width = Math.max(0, ...layout.rows.map((row) => row?.length || 0));
  return Array.from({ length: width }, (_, column) => layout.rows.slice(0, rowsBefore).map((_, row) => {
    const merge = mergeAt.get(`${row}:${column}`);
    if (merge && merge.endColumn - merge.startColumn >= 3) return "";
    return planDataKey(expanded[row]?.[column]).replace(/[()（）]/g, "");
  }).filter(Boolean).join(" "));
}

// 편제표 표(layout)를 과목·선택과목군 데이터와 내보내기 양식으로 나눈다.
function curriculumDataFromLayout(layout) {
  if (!layout?.rows?.length) throw new Error("편제표 표가 비어 있습니다.");
  const columns = importedPlanColumnMap(layout);
  if (columns.subject < 0) throw new Error("편제표에서 과목명 열을 찾지 못했습니다.");
  const semesterColumns = columns.semesters.map((column) => Number.isInteger(column) ? column : -1);
  if (!semesterColumns.some((column) => column >= 0)) throw new Error("편제표에서 학년·학기 열을 찾지 못했습니다.");
  const rows = layout.rows;
  const width = Math.max(layout.columnWidths?.length || 0, ...rows.map((row) => row?.length || 0));
  const ranges = (layout.mergedRanges || []).map((reference) => {
    const range = planDataRange(reference);
    return range ? { reference, ...range } : null;
  }).filter(Boolean);
  const mergeAt = new Map();
  for (const range of ranges) {
    for (let row = range.startRow; row <= range.endRow; row++) {
      for (let column = range.startColumn; column <= range.endColumn; column++) mergeAt.set(`${row}:${column}`, range);
    }
  }
  const covered = (row, column) => {
    const merge = mergeAt.get(`${row}:${column}`);
    return Boolean(merge) && (merge.startRow !== row || merge.startColumn !== column);
  };
  const raw = (row, column) => column < 0 || covered(row, column) ? "" : planDataText(rows[row]?.[column]);
  const formulas = layout.formulas || {};
  // 학기 칸의 학점: 숫자, '4학점'·'(4)' 같은 글자, 저장값 없이 수식만 있는 칸(=F61처럼 다른 칸을 가리키는 수식)을 읽는다.
  const cellNumber = (row, column, depth = 0) => {
    const text = raw(row, column).trim();
    const number = planDataNumber(text) ?? planDataNumber(text.replace(/^[(（]\s*|\s*[)）]$/g, "").replace(/\s*학점$/, ""));
    if (number !== null || text || depth > 2) return number;
    const reference = String(formulas[`${row}:${column}`] ?? "").replace(/^=/, "").trim().match(/^\$?([A-Z]{1,3})\$?(\d+)$/);
    return reference ? cellNumber(Number(reference[2]) - 1, columnIndex(reference[1]), depth + 1) : null;
  };
  const expanded = expandCurriculumLayoutRows(layout);
  const contexts = importedPlanCourseContexts(layout, columns);
  const usedSemesters = semesterColumns.filter((column) => column >= 0);
  const firstSemester = Math.min(...usedSemesters);
  const headerRow = rows.findIndex((row) => (row || []).some((value) => /과목명|세부과목/.test(planDataKey(value))));
  const subjectContexts = contexts.filter((context) => context.rowIndex > headerRow &&
    !covered(context.rowIndex, columns.subject) && planDataSubjectNames(context.subject).length &&
    !PLAN_DATA_STOP.test(planDataKey(context.subject)));
  if (!subjectContexts.length) throw new Error("편제표에서 과목 행을 찾지 못했습니다.");
  const bodyStart = subjectContexts[0].rowIndex;
  const labels = planDataHeaderLabels(layout, bodyStart, mergeAt, expanded);
  const typeCounts = new Map();
  for (const context of subjectContexts) {
    if (context.typeColumn >= 0) typeCounts.set(context.typeColumn, (typeCounts.get(context.typeColumn) || 0) + 1);
  }
  const kindColumn = columns.detail >= 0 && columns.detail !== columns.subject
    ? columns.detail : [...typeCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1;
  const completionColumn = typeof curriculumCompletionColumn === "function" ? curriculumCompletionColumn(layout) : -1;
  const requiredColumn = labels.findIndex((label) => /필수이수/.test(label));
  const columnSet = {
    category: columns.division, domain: Number.isInteger(columns.domain) ? columns.domain : -1, area: columns.area,
    kind: kindColumn, name: columns.subject, base: columns.baseCredit, op: columns.opCredit === columns.baseCredit ? -1 : columns.opCredit,
    semesters: semesterColumns, completion: completionColumn, required: requiredColumn === completionColumn ? -1 : requiredColumn
  };
  for (const key of ["category", "domain", "area", "kind"]) {
    if (columnSet[key] === columnSet.name) columnSet[key] = -1;
  }
  const known = new Set([columnSet.category, columnSet.domain, columnSet.area, columnSet.kind, columnSet.name,
    columnSet.base, columnSet.op, columnSet.completion, columnSet.required, ...usedSemesters].filter((column) => column >= 0));
  const isStop = (row) => PLAN_DATA_STOP.test((expanded[row] || []).slice(0, Math.max(firstSemester, 1)).map(planDataKey).join(""));
  const startRows = new Set(subjectContexts.map((context) => context.rowIndex));
  const ownLabel = (row) => {
    for (let column = 0; column < firstSemester; column++) {
      if (column === columnSet.name) continue;
      if (raw(row, column).trim()) return true;
    }
    return false;
  };
  const semesterContent = (row) => usedSemesters.some((column) => raw(row, column).trim());
  const spanEnd = (start) => {
    let end = start;
    while (end + 1 < rows.length && !startRows.has(end + 1) && !isStop(end + 1)) {
      const next = end + 1;
      const nameMerge = mergeAt.get(`${next}:${columnSet.name}`);
      if (nameMerge && nameMerge.startRow >= start && nameMerge.startRow <= end) { end = next; continue; }
      if (raw(next, columnSet.name).trim() || ownLabel(next) || !semesterContent(next)) break;
      end = next;
    }
    return end;
  };
  const spans = new Map(subjectContexts.map((context) => [context.rowIndex, spanEnd(context.rowIndex)]));
  const bodyEnd = Math.max(...spans.values());
  const rowSources = planDataRowSources(layout);

  // 선택과목군: 학기 칸의 '택n'과 그 아래 학점 칸. 이수학점 병합 칸이 있으면 그 범위가 묶음 범위다.
  const tagRows = new Set();
  const tags = [];
  for (let row = bodyStart; row <= bodyEnd; row++) {
    semesterColumns.forEach((column) => {
      if (column < 0 || covered(row, column)) return;
      const tag = planDataTag(raw(row, column));
      if (!tag) return;
      const merge = mergeAt.get(`${row}:${column}`);
      const tagColumns = merge && merge.endColumn > merge.startColumn
        ? usedSemesters.filter((item) => item >= merge.startColumn && item <= merge.endColumn) : [column];
      tags.push({ row, column, columns: tagColumns, ...tag });
      tagRows.add(row);
    });
  }
  const groupDrafts = [];
  for (const tag of tags) {
    const explicit = (layout.choiceBlockRanges || []).find((range) => range.column === tag.column && range.startRow === tag.row);
    let end = tag.row;
    if (explicit) {
      end = explicit.endRow;
    } else {
      const completion = completionColumn >= 0 ? mergeAt.get(`${tag.row}:${completionColumn}`) : null;
      if (completion && completion.endRow > tag.row) {
        while (end + 1 <= completion.endRow && !tagRows.has(end + 1) && !isStop(end + 1)) end++;
      } else {
        while (end + 1 <= bodyEnd && !tagRows.has(end + 1) && !isStop(end + 1) &&
          (planDataNumber(raw(end + 1, tag.column)) !== null || covered(end + 1, tag.column) || !startRows.has(end + 1))) end++;
      }
    }
    groupDrafts.push({ start: tag.row, end, columns: tag.columns, pick: tag.pick, tagCredit: tag.credit, credit: 0 });
  }
  // 예전 앱의 병합 기록: '선택과목군 택n · m학점'은 선택과목군, '교차집중과목군'(같은 학년 1·2학기 병합)은 교차집중 과목이다.
  for (const merge of typeof curriculumSheetMerges === "function" ? curriculumSheetMerges(layout) : []) {
    if (merge.kind === "plain") continue;
    const mergeColumns = usedSemesters.filter((column) => column >= merge.startColumn && column <= merge.endColumn);
    if (!mergeColumns.length) continue;
    const credit = Number(merge.credit) > 0 ? Number(merge.credit) : 0;
    groupDrafts.push({ start: merge.startRow, end: merge.endRow, columns: mergeColumns, pick: merge.pick,
      tagCredit: credit, credit, legacy: true, cross: merge.kind === "cross" && mergeColumns.length > 1 });
  }
  const slotCells = new Set();
  for (const draft of groupDrafts) {
    // 묶음 범위 안에서 시작한 과목의 아래 행까지 범위를 넓힌다.
    for (const [start, end] of spans) if (start >= draft.start && start <= draft.end) draft.end = Math.max(draft.end, end);
    if (!draft.credit) {
      for (let row = draft.start + 1; row <= draft.end && !draft.credit; row++) {
        for (const column of draft.columns) {
          const value = cellNumber(row, column);
          if (value > 0) { draft.credit = value; break; }
        }
      }
      if (!draft.credit) draft.credit = draft.tagCredit || 0;
    }
    for (let row = draft.start; row <= draft.end; row++) for (const column of draft.columns) slotCells.add(`${row}:${column}`);
  }

  let nextId = 1;
  let crossLabel = "";
  const subjects = [];
  const subjectAtRow = new Map();
  let lastDomain = "";
  for (const context of subjectContexts) {
    const start = context.rowIndex;
    const end = spans.get(start);
    const expandedRow = expanded[start] || [];
    if (columnSet.domain >= 0 && planDataText(expandedRow[columnSet.domain]).trim()) lastDomain = planDataText(expandedRow[columnSet.domain]);
    const kindMerge = columnSet.kind >= 0 ? mergeAt.get(`${start}:${columnSet.kind}`) : null;
    const kindJoin = Boolean(kindMerge && kindMerge.startRow < start && kindMerge.startColumn === columnSet.kind &&
      kindMerge.startRow >= bodyStart);
    const subject = {
      id: `s${nextId++}`,
      category: columnSet.category >= 0 ? planDataText(expandedRow[columnSet.category]).trim() ? planDataText(expandedRow[columnSet.category]) : context.division : "",
      domain: columnSet.domain >= 0 ? lastDomain : "",
      area: columnSet.area >= 0 ? planDataText(expandedRow[columnSet.area]).trim() ? planDataText(expandedRow[columnSet.area]) : context.area : "",
      kindText: columnSet.kind >= 0 ? (kindJoin ? planDataText(expandedRow[columnSet.kind]) : raw(start, columnSet.kind)) : "",
      kind: context.selectionType || "",
      kindJoin,
      name: planDataText(rows[start]?.[columnSet.name]),
      base: columnSet.base >= 0 ? raw(start, columnSet.base) : "",
      op: columnSet.op >= 0 ? raw(start, columnSet.op) : "",
      opFormula: columnSet.op >= 0 && Object.hasOwn(formulas, `${start}:${columnSet.op}`),
      credits: {}, texts: {}, cross: null, note: "",
      completion: null, required: null, extra: {},
      span: end - start + 1,
      // 여러 행에 걸친 과목에서 원본이 학기 칸을 세로로 병합했는지(빈 칸 포함) 기억한다.
      semMerge: end > start && usedSemesters.some((column) => {
        if (slotCells.has(`${start}:${column}`)) return false;
        const merge = mergeAt.get(`${start}:${column}`);
        return merge && merge.startRow === start && merge.endRow > start && merge.startColumn === merge.endColumn;
      }),
      fills: [], heights: [], hidden: false, styleRows: []
    };
    semesterColumns.forEach((column, index) => {
      if (column < 0) return;
      const field = PLAN_DATA_FIELDS[index];
      for (let row = start; row <= end; row++) {
        if (slotCells.has(`${row}:${column}`) || covered(row, column)) continue;
        const value = raw(row, column).trim();
        if (!value) {
          const number = cellNumber(row, column);
          if (number > 0 && !Object.hasOwn(subject.credits, field)) subject.credits[field] = number;
          continue;
        }
        if (PLAN_DATA_NOTE.test(value)) { if (!subject.note) subject.note = raw(row, column); continue; }
        if (/교차/.test(value)) {
          if (!crossLabel) crossLabel = raw(row, column).trim();
          const merge = mergeAt.get(`${row}:${column}`);
          const crossColumns = merge && merge.endColumn > merge.startColumn
            ? usedSemesters.filter((item) => item >= merge.startColumn && item <= merge.endColumn) : [column];
          subject.cross = crossColumns.map((item) => PLAN_DATA_FIELDS[semesterColumns.indexOf(item)]);
          continue;
        }
        const number = planDataNumber(value) ?? cellNumber(row, column);
        if (number !== null) { if (!Object.hasOwn(subject.credits, field)) subject.credits[field] = number; continue; }
        if (/^[-–—]+$/.test(value) || planDataTag(value)) continue;
        if (!Object.hasOwn(subject.texts, field)) subject.texts[field] = value;
      }
    });
    if (columnSet.completion >= 0) {
      const merge = mergeAt.get(`${start}:${columnSet.completion}`);
      const segmentStart = merge && merge.startColumn === columnSet.completion ? merge.startRow : start;
      subject.completion = { seg: `c${segmentStart}`, text: planDataText(rows[segmentStart]?.[columnSet.completion]),
        formula: Object.hasOwn(formulas, `${segmentStart}:${columnSet.completion}`) };
    }
    if (columnSet.required >= 0) {
      const merge = mergeAt.get(`${start}:${columnSet.required}`);
      const segmentStart = merge && merge.startColumn === columnSet.required ? merge.startRow : start;
      subject.required = { seg: `q${segmentStart}`, text: planDataText(rows[segmentStart]?.[columnSet.required]) };
    }
    for (let column = 0; column < width; column++) {
      if (known.has(column)) continue;
      const value = raw(start, column);
      if (value.trim()) subject.extra[column] = value;
    }
    for (let row = start; row <= end; row++) {
      const fills = {};
      for (let column = 0; column < width; column++) {
        const fill = layout.cellFills?.[`${row}:${column}`];
        if (fill) fills[column] = fill;
      }
      subject.fills.push(fills);
      subject.heights.push(Number(layout.rowHeights?.[row]) || null);
      subject.styleRows.push(rowSources[row] ?? null);
      if ((layout.hiddenRows || []).includes(row)) subject.hidden = true;
    }
    subjects.push(subject);
    subjectAtRow.set(start, subject);
  }

  // 과목 사이의 소계 같은 고정 행은 그대로 두고, 아무 값도 없는 빈 행(예전 삭제 흔적)은 버린다.
  const body = [];
  const ownedRows = new Set();
  for (const [start, end] of spans) for (let row = start; row <= end; row++) ownedRows.add(row);
  for (let row = bodyStart; row <= bodyEnd; row++) {
    if (subjectAtRow.has(row)) { body.push(subjectAtRow.get(row)); continue; }
    if (ownedRows.has(row)) continue;
    const meaningful = [columnSet.name, columnSet.base, columnSet.op, columnSet.completion, ...usedSemesters]
      .some((column) => column >= 0 && raw(row, column).trim());
    if (!meaningful) continue;
    body.push({
      id: `s${nextId++}`, fixed: true, values: Array.from({ length: width }, (_, column) => raw(row, column)),
      fills: [Object.fromEntries(Array.from({ length: width }, (_, column) => [column, layout.cellFills?.[`${row}:${column}`]]).filter(([, fill]) => fill))],
      heights: [Number(layout.rowHeights?.[row]) || null], styleRows: [rowSources[row] ?? null],
      hidden: (layout.hiddenRows || []).includes(row), span: 1
    });
  }

  const groups = [];
  const usedSlots = new Set();
  for (const draft of groupDrafts.sort((a, b) => a.start - b.start)) {
    const members = [...subjectAtRow].filter(([start]) => start >= draft.start && start <= draft.end).map(([, subject]) => subject);
    if (!members.length) continue;
    const fields = draft.columns.map((column) => PLAN_DATA_FIELDS[semesterColumns.indexOf(column)]).filter(Boolean);
    const clash = fields.some((field) => members.some((member) => usedSlots.has(`${member.id}:${field}`)));
    if (clash || !fields.length) continue;
    for (const field of fields) for (const member of members) usedSlots.add(`${member.id}:${field}`);
    if (draft.cross) {
      // 교차집중: 학생이 고르는 묶음이 아니라 학급마다 학기를 엇갈려 이수하는 과목이다. 학기마다 같은 학점을 둔다.
      for (const member of members) {
        member.cross = fields.slice();
        for (const field of fields) if (Number(draft.credit) > 0) member.credits[field] = Number(draft.credit);
      }
      continue;
    }
    groups.push({ id: `g${nextId++}`, fields, pick: Math.max(1, Number(draft.pick) || 1), credit: Number(draft.credit) || 0,
      members: members.map((member) => member.id) });
  }

  const pickRows = (from, to) => {
    const result = { rows: [], formulas: {}, fills: {}, heights: {}, hidden: [], sources: [] };
    for (let row = from; row <= to; row++) {
      const offset = row - from;
      result.rows.push(Array.from({ length: width }, (_, column) => planDataText(rows[row]?.[column])));
      result.sources.push(rowSources[row] ?? null);
      if (layout.rowHeights?.[row]) result.heights[offset] = Number(layout.rowHeights[row]);
      if ((layout.hiddenRows || []).includes(row)) result.hidden.push(offset);
      for (let column = 0; column < width; column++) {
        if (Object.hasOwn(formulas, `${row}:${column}`)) result.formulas[`${offset}:${column}`] = formulas[`${row}:${column}`];
        if (layout.cellFills?.[`${row}:${column}`]) result.fills[`${offset}:${column}`] = layout.cellFills[`${row}:${column}`];
      }
    }
    return result;
  };
  const header = pickRows(0, bodyStart - 1);
  header.merges = ranges.filter((range) => range.endRow < bodyStart).map((range) => range.reference);
  const footer = pickRows(bodyEnd + 1, rows.length - 1);
  footer.merges = ranges.filter((range) => range.startRow > bodyEnd)
    .map((range) => planDataRef(range.startRow - bodyEnd - 1, range.startColumn, range.endRow - bodyEnd - 1, range.endColumn));
  const template = {
    version: PLAN_DATA_VERSION, width, columnWidths: Array.from({ length: width }, (_, column) => layout.columnWidths?.[column] ?? null),
    columns: columnSet, header, footer, bodyStart, bodyEnd, crossLabel: crossLabel || "교차집중(↔)",
    defaultHeight: subjects.map((subject) => subject.heights[0]).filter(Boolean).sort((a, b) => a - b)[Math.floor(subjects.length / 2)] || null
  };
  const data = { version: PLAN_DATA_VERSION, converter: PLAN_DATA_CONVERTER, nextId, subjects: body, groups };
  normalizeCurriculumData(data);
  const repairs = curriculumDataRepair(data);
  return { data, template, repairs };
}

function planDataSubjects(data) {
  return (data?.subjects || []).filter((item) => !item.fixed);
}

// 묶음 구성 과목은 표에서 이어진 행이어야 한다. 사이에 있는 과목은 묶음에 들어간다(엑셀의 '택n' 범위와 같은 규칙).
function normalizeCurriculumData(data) {
  const order = new Map(data.subjects.map((item, index) => [item.id, index]));
  const seen = new Set();
  data.groups = (data.groups || []).flatMap((group) => {
    const indexes = group.members.map((id) => order.get(id)).filter((index) => index !== undefined && !data.subjects[index].fixed);
    if (!indexes.length || !group.fields?.length) return [];
    const first = Math.min(...indexes), last = Math.max(...indexes);
    const members = data.subjects.slice(first, last + 1).filter((item) => !item.fixed).map((item) => item.id);
    if (members.some((id) => group.fields.some((field) => seen.has(`${id}:${field}`)))) return [];
    for (const id of members) for (const field of group.fields) seen.add(`${id}:${field}`);
    return [{ ...group, members, pick: Math.max(1, Number(group.pick) || 1), credit: Number(group.credit) || 0 }];
  });
  for (const subject of planDataSubjects(data)) {
    for (const group of data.groups) {
      if (!group.members.includes(subject.id)) continue;
      for (const field of group.fields) {
        delete subject.credits[field];
        delete subject.texts[field];
      }
      if (subject.cross?.some((field) => group.fields.includes(field))) subject.cross = null;
    }
  }
  return data;
}

// 선택과목군 학점을 학기 칸에서 읽지 못했으면(0) 구성 과목의 운영학점(없으면 기준학점)을 쓴다.
// 여러 학기에 걸친 묶음(1·2학기 택1)은 운영학점이 두 학기 합이므로 학기 수로 나눈다. 구성 과목 학점이 서로 다르면 가장 큰 값을 쓰고 확인 표시를 남긴다.
function planDataMemberCredits(data, group) {
  const byId = new Map((data?.subjects || []).map((item) => [item.id, item]));
  const fields = Math.max(1, group?.fields?.length || 1);
  return (group?.members || []).map((id) => byId.get(id)).filter((item) => item && !item.fixed)
    .map((item) => (planDataNumber(item.op) || planDataNumber(item.base) || 0) / fields)
    .filter((value) => value > 0).map((value) => Math.round(value * 1000) / 1000);
}

function planDataGroupCredit(data, group) {
  if (Number(group?.credit) > 0) return Number(group.credit);
  const values = planDataMemberCredits(data, group);
  return values.length ? Math.max(...values) : 0;
}

// 학점을 읽지 못한 묶음(0)의 계산용 대체값 안내. 저장 데이터는 바꾸지 않고 계산할 때만 운영학점을 쓴다.
function planDataGroupCreditInfo(data, group) {
  if (Number(group?.credit) > 0) return { credit: Number(group.credit), from: "sheet", note: "" };
  const values = [...new Set(planDataMemberCredits(data, group))].sort((a, b) => a - b);
  if (!values.length) return { credit: 0, from: "", note: "" };
  const credit = Math.max(...values);
  return { credit, from: "op", note: values.length > 1 ? `구성 과목 운영학점(${values.map(planDataNumberText).join("·")})이 서로 달라 가장 큰 ${planDataNumberText(credit)}학점을 썼습니다.` : "" };
}

function planDataSchoolDesignated(subject) {
  return planDataDivision(subject?.category) === "학교 지정 교육과정" ||
    (typeof normalizeCurriculumDivision === "function" && normalizeCurriculumDivision(String(subject?.category || "").replace(/↔/g, " ").trim()) === "학교 지정 교육과정");
}

function planDataIsGradePair(fields) {
  return fields?.length === 2 && planDataGrade(fields[0]) === planDataGrade(fields[1]) &&
    new Set(fields.map(planDataSemester)).size === 2;
}

// 선택과목군(들)을 교차집중 과목 한 행으로 바꾼다. 구성 과목이 여러 행이면 첫 행에 과목명을 모은다.
function planDataGroupsToCross(data, groups) {
  const fields = PLAN_DATA_FIELDS.filter((field) => groups.some((group) => group.fields.includes(field)));
  const ids = [...new Set(groups.flatMap((group) => group.members))];
  const members = data.subjects.filter((item) => ids.includes(item.id) && !item.fixed);
  if (!members.length) throw new Error("교차집중으로 바꿀 과목을 찾지 못했습니다.");
  const first = members[0];
  const names = [...new Set(members.flatMap((item) => planDataNameParts(item.name).map((part) => part.trim())))];
  const credits = {};
  for (const field of fields) {
    const group = groups.find((item) => item.fields.includes(field));
    credits[field] = planDataGroupCredit(data, group);
  }
  data.groups = data.groups.filter((group) => !groups.includes(group));
  for (const other of members.slice(1)) {
    for (const group of planDataGroupsOf(data, other.id)) group.members = group.members.filter((id) => id !== other.id);
    data.subjects.splice(planDataIndex(data, other.id), 1);
  }
  data.groups = data.groups.filter((group) => group.members.length);
  first.name = names.join(", ");
  first.cross = fields;
  for (const field of fields) {
    delete first.texts?.[field];
    if (credits[field] > 0) first.credits[field] = credits[field];
  }
  if (first.planSectionManual && first.planSection === "choice") { delete first.planSection; delete first.planSectionManual; }
  first.opFormula = false;
  return first;
}

// 학교 지정 과목의 '같은 학년 1·2학기 택1'은 학생이 고르는 묶음이 아니라 교차집중(반마다 학기를 엇갈려 이수)이다.
// ① 묶음 하나가 1·2학기 두 열에 걸친 택1, ② 같은 구성 과목의 택1 묶음이 1학기·2학기에 따로 있는 경우를 교차집중으로 바꾼다.
function planDataRecognizeCross(data) {
  const changed = [];
  const byId = new Map(planDataSubjects(data).map((item) => [item.id, item]));
  const eligible = (group) => Number(group.pick) === 1 && group.members.length &&
    group.members.every((id) => byId.has(id) && planDataSchoolDesignated(byId.get(id)) && !byId.get(id).note) &&
    planDataNamesCount(data, group.members) >= 2;
  const used = new Set();
  for (const group of [...(data.groups || [])]) {
    if (used.has(group) || !eligible(group)) continue;
    const set = planDataCrossCandidates(data, group);
    if (!set || set.some((item) => used.has(item) || !eligible(item))) continue;
    set.forEach((item) => used.add(item));
    const subject = planDataGroupsToCross(data, set);
    changed.push(`${planDataSubjectNames(subject.name).join("↔")}(${planDataFieldLabel(subject.cross)})`);
  }
  return changed;
}

// 업로드 변환의 마지막 단계: 교차집중 인식(원본의 학교 지정 1·2학기 택1), 학점을 읽지 못한 묶음 안내(계산할 때만 운영학점).
function curriculumDataRepair(data) {
  if (!data?.subjects) return [];
  const cross = planDataRecognizeCross(data);
  const empty = (data.groups || []).map((group) => ({ group, info: planDataGroupCreditInfo(data, group) })).filter(({ info }) => info.from === "op");
  return [...cross.map((text) => `교차집중으로 인식: ${text}`),
    ...empty.map(({ group, info }) => `${planDataFieldLabel(group.fields)} 택${group.pick}: 학기 칸에 학점이 없어 계산에는 구성 과목 운영학점 ${planDataNumberText(info.credit)}학점을 씁니다.${info.note ? ` ${info.note}` : ""}`)];
}

function planDataGroupsOf(data, id) {
  return (data.groups || []).filter((group) => group.members.includes(id));
}

// 데이터에서 표(행 값·병합·수식·채움색·행 높이)를 다시 만든다. 화면과 엑셀 내보내기가 같은 표를 쓴다.
function curriculumSheetFromData(data, template) {
  const columns = template.columns;
  const width = template.width;
  const semesterColumns = columns.semesters;
  const usedSemesters = semesterColumns.filter((column) => column >= 0);
  const firstSemester = Math.min(...usedSemesters), lastSemester = Math.max(...usedSemesters);
  const rows = [];
  const merges = [];
  const formulas = {};
  const fills = {};
  const heights = {};
  const hidden = [];
  const meta = [];
  const blank = () => Array.from({ length: width }, () => "");
  const set = (row, column, value) => { if (column >= 0) rows[row][column] = planDataText(value); };
  const merge = (startRow, startColumn, endRow, endColumn) => {
    if (startColumn < 0 || (startRow === endRow && startColumn === endColumn)) return;
    merges.push(planDataRef(startRow, startColumn, endRow, endColumn));
  };
  const copyPart = (part, offset, type) => {
    part.rows.forEach((values, index) => {
      rows.push(Array.from({ length: width }, (_, column) => planDataText(values[column])));
      meta.push({ type, source: part.sources[index] ?? null, part: index });
    });
    for (const [key, fill] of Object.entries(part.fills || {})) {
      const [row, column] = key.split(":").map(Number);
      fills[`${row + offset}:${column}`] = fill;
    }
    for (const [row, height] of Object.entries(part.heights || {})) heights[Number(row) + offset] = height;
    for (const row of part.hidden || []) hidden.push(row + offset);
  };
  copyPart(template.header, 0, "header");
  merges.push(...(template.header.merges || []));
  for (const [key, formula] of Object.entries(template.header.formulas || {})) formulas[key] = formula;
  const bodyStart = rows.length;
  const items = data.subjects;
  const groups = data.groups || [];
  const byId = new Map(items.map((item) => [item.id, item]));
  // 선택과목군은 '택n' 칸과 학점 칸 n개가 필요하다. 행이 모자라면 마지막 과목 행을 늘린다.
  const extra = new Map();
  for (const group of groups) {
    const members = group.members.map((id) => byId.get(id)).filter(Boolean);
    const total = members.reduce((sum, member) => sum + Math.max(1, member.span || 1, member.cross?.length ? 2 : 1), 0);
    const need = group.pick + 1;
    if (members.length && total < need) {
      const last = members.at(-1);
      extra.set(last.id, Math.max(extra.get(last.id) || 0, need - total));
    }
  }
  const slotColumns = new Map();
  for (const group of groups) {
    for (const id of group.members) {
      const set = slotColumns.get(id) || new Set();
      for (const field of group.fields) {
        const column = semesterColumns[PLAN_DATA_FIELDS.indexOf(field)];
        if (column >= 0) set.add(column);
      }
      slotColumns.set(id, set);
    }
  }
  for (const item of items) {
    const span = Math.max(1, item.fixed ? 1 : item.span || 1, item.cross?.length ? 2 : 1) + (extra.get(item.id) || 0);
    const start = rows.length;
    const end = start + span - 1;
    item.row = start;
    item.rowEnd = end;
    for (let offset = 0; offset < span; offset++) {
      rows.push(blank());
      meta.push({ type: item.fixed ? "fixed" : "subject", id: item.id, part: offset, source: item.styleRows?.[offset] ?? item.styleRows?.[0] ?? null });
      const height = item.heights?.[offset] ?? (offset >= (item.heights?.length || 0) ? item.heights?.[0] : null) ?? template.defaultHeight;
      if (height) heights[start + offset] = height;
      for (const [column, fill] of Object.entries(item.fills?.[offset] || {})) fills[`${start + offset}:${column}`] = fill;
      if (item.hidden) hidden.push(start + offset);
    }
    if (item.fixed) {
      item.values.forEach((value, column) => set(start, column, value));
      continue;
    }
    const verticalColumns = [columns.name, columns.base, columns.op, ...Object.keys(item.extra || {}).map(Number)];
    set(start, columns.name, item.name);
    set(start, columns.base, item.base);
    set(start, columns.op, item.op);
    set(start, columns.kind, item.kindText);
    set(start, columns.category, item.category);
    set(start, columns.domain, item.domain);
    set(start, columns.area, item.area);
    for (const [column, value] of Object.entries(item.extra || {})) set(start, Number(column), value);
    for (const column of verticalColumns) if (column >= 0) merge(start, column, end, column);
    if (item.opFormula && columns.op >= 0) {
      formulas[`${start}:${columns.op}`] = `SUM(${planDataRef(start, firstSemester)}:${planDataRef(end, lastSemester)})`;
    }
    const slots = slotColumns.get(item.id) || new Set();
    if (item.note) {
      set(start, firstSemester, item.note);
      merge(start, firstSemester, end, lastSemester);
      continue;
    }
    const crossColumns = (item.cross || []).map((field) => semesterColumns[PLAN_DATA_FIELDS.indexOf(field)])
      .filter((column) => column >= 0 && !slots.has(column)).sort((a, b) => a - b);
    semesterColumns.forEach((column, index) => {
      if (column < 0 || slots.has(column) || crossColumns.includes(column)) return;
      const field = PLAN_DATA_FIELDS[index];
      const value = Object.hasOwn(item.credits || {}, field) ? planDataNumberText(item.credits[field]) : item.texts?.[field] || "";
      set(start, column, value);
      if (item.semMerge || end === start) merge(start, column, end, column);
    });
    if (crossColumns.length) {
      set(start, crossColumns[0], template.crossLabel || "교차집중(↔)");
      merge(start, crossColumns[0], start, crossColumns.at(-1));
      for (const column of crossColumns) {
        const field = PLAN_DATA_FIELDS[semesterColumns.indexOf(column)];
        set(start + 1, column, Object.hasOwn(item.credits, field) ? planDataNumberText(item.credits[field]) : "");
        if (item.semMerge) merge(start + 1, column, end, column);
      }
    }
  }
  const bodyEnd = rows.length - 1;
  for (const group of groups) {
    const members = group.members.map((id) => byId.get(id)).filter(Boolean);
    if (!members.length) continue;
    const start = members[0].row, end = members.at(-1).rowEnd;
    const groupColumns = group.fields.map((field) => semesterColumns[PLAN_DATA_FIELDS.indexOf(field)]).filter((column) => column >= 0).sort((a, b) => a - b);
    if (!groupColumns.length) continue;
    set(start, groupColumns[0], `택${group.pick}`);
    merge(start, groupColumns[0], start, groupColumns.at(-1));
    // 학점 칸 n개: 첫 칸에 학점을 적고 나머지는 첫 칸을 가리키는 수식이다. 이수학점·소계 SUM이 n × 학점을 센다.
    for (let offset = 1; offset <= group.pick && start + offset <= end; offset++) {
      for (const column of groupColumns) {
        set(start + offset, column, planDataNumberText(planDataGroupCredit(data, group)));
        if (offset > 1) formulas[`${start + offset}:${column}`] = planDataRef(start + 1, column);
      }
    }
  }
  // 구분·교과 영역·교과(군) 세로 병합은 데이터 묶음(같은 값이 이어진 과목)에 맞춰 다시 계산한다.
  const subjects = items.filter((item) => !item.fixed);
  const runs = (column, keyOf, parentOf) => {
    if (column < 0) return new Map();
    const owner = new Map();
    let run = null;
    items.forEach((item, index) => {
      const previous = items[index - 1];
      const continues = run && !item.fixed && previous && !previous.fixed && keyOf(item) === keyOf(previous) &&
        (!parentOf || parentOf.get(item.id) === parentOf.get(previous.id));
      if (item.fixed) { run = null; return; }
      if (!continues) run = { start: item, items: [] };
      run.items.push(item);
      owner.set(item.id, run);
    });
    for (const value of new Set(owner.values())) {
      const first = value.items[0], last = value.items.at(-1);
      for (const item of value.items.slice(1)) set(item.row, column, "");
      merge(first.row, column, last.rowEnd, column);
    }
    return owner;
  };
  const categoryRuns = runs(columns.category, (item) => planDataKey(item.category));
  const domainRuns = runs(columns.domain, (item) => planDataKey(item.domain), categoryRuns);
  const areaRuns = runs(columns.area, (item) => planDataKey(item.area), columns.domain >= 0 ? domainRuns : categoryRuns);
  if (columns.kind >= 0) {
    let run = null;
    const kindRuns = [];
    items.forEach((item, index) => {
      const previous = items[index - 1];
      if (item.fixed) { run = null; return; }
      const continues = run && item.kindJoin && previous && !previous.fixed && planDataKey(previous.kindText) === planDataKey(item.kindText) &&
        areaRuns.get(previous.id) === areaRuns.get(item.id);
      if (!continues) { run = [item]; kindRuns.push(run); } else run.push(item);
    });
    for (const run of kindRuns) {
      for (const item of run.slice(1)) set(item.row, columns.kind, "");
      if (run.length > 1 || run[0].rowEnd > run[0].row) merge(run[0].row, columns.kind, run.at(-1).rowEnd, columns.kind);
    }
  }
  // 이수학점·필수이수학점: 원본에서 함께 병합된 과목과 같은 선택과목군 과목을 한 칸으로 묶는다.
  const segments = (column, keyOf, valueOf) => {
    if (column < 0) return [];
    const parent = new Map(subjects.map((item) => [item.id, item.id]));
    const find = (id) => { while (parent.get(id) !== id) id = parent.get(id); return id; };
    const union = (a, b) => { const x = find(a), y = find(b); if (x !== y) parent.set(y, x); };
    items.forEach((item, index) => {
      const previous = items[index - 1];
      if (!item.fixed && previous && !previous.fixed && keyOf(item) && keyOf(item) === keyOf(previous)) union(previous.id, item.id);
    });
    for (const group of groups) group.members.slice(1).forEach((id) => byId.has(id) && byId.has(group.members[0]) && union(group.members[0], id));
    const sets = new Map();
    for (const item of subjects) {
      const root = find(item.id);
      if (!sets.has(root)) sets.set(root, []);
      sets.get(root).push(item);
    }
    const result = [];
    for (const members of sets.values()) {
      // 이어지지 않은 부분은 따로 묶는다.
      members.sort((a, b) => a.row - b.row);
      let current = [members[0]];
      for (const item of members.slice(1)) {
        if (item.row === current.at(-1).rowEnd + 1) current.push(item);
        else { result.push(current); current = [item]; }
      }
      result.push(current);
    }
    for (const members of result) {
      const start = members[0].row, end = members.at(-1).rowEnd;
      for (let row = start; row <= end; row++) set(row, column, "");
      merge(start, column, end, column);
      valueOf(members, start, end);
    }
    return result;
  };
  segments(columns.completion, (item) => item.completion?.seg || "", (members, start, end) => {
    const numeric = members.some((item) => Object.values(item.credits || {}).some((value) => Number(value) > 0) ||
      groups.some((group) => group.members.includes(item.id)));
    if (numeric) {
      formulas[`${start}:${columns.completion}`] = `SUM(${planDataRef(start, firstSemester)}:${planDataRef(end, lastSemester)})`;
    } else {
      const first = members.find((item) => item.completion?.text) || members[0];
      set(start, columns.completion, first.completion?.text ?? planDataNoteCredit(first.note));
    }
  });
  segments(columns.required, (item) => item.required?.seg || "", (members, start) => {
    const first = members.find((item) => item.required?.text) || members[0];
    set(start, columns.required, first.required?.text || "");
  });
  // 소계·합계 행: 원본 수식의 과목 영역 참조를 새 과목 영역 전체로 바꾸고, 그 아래 행 참조는 밀린 만큼 옮긴다.
  const footerStart = rows.length;
  copyPart(template.footer, footerStart, "footer");
  for (const reference of template.footer.merges || []) {
    const range = planDataRange(reference);
    if (range) merges.push(planDataRef(range.startRow + footerStart, range.startColumn, range.endRow + footerStart, range.endColumn));
  }
  const oldFooterStart = template.bodyEnd + 1;
  const mapRow = (row, end) => {
    if (row < template.bodyStart) return row;
    if (row > template.bodyEnd) return row - oldFooterStart + footerStart;
    return end ? bodyEnd : bodyStart;
  };
  for (const [key, formula] of Object.entries(template.footer.formulas || {})) {
    const [row, column] = key.split(":").map(Number);
    formulas[`${row + footerStart}:${column}`] = planDataRemapFormula(formula, mapRow);
  }
  // 병합으로 가려진 칸에는 값을 두지 않는다(원본에서 복사된 펼침 값이 남아 소계와 어긋나지 않게).
  for (const reference of new Set(merges)) {
    const range = planDataRange(reference);
    if (!range) continue;
    for (let row = range.startRow; row <= range.endRow; row++) {
      for (let column = range.startColumn; column <= range.endColumn; column++) {
        if ((row !== range.startRow || column !== range.startColumn) && rows[row]) {
          rows[row][column] = "";
          delete formulas[`${row}:${column}`];
        }
      }
    }
  }
  return { rows, mergedRanges: [...new Set(merges)], formulas, cellFills: fills, rowHeights: heights,
    hiddenRows: [...new Set(hidden)].sort((a, b) => a - b), rowMeta: meta, bodyStart, bodyEnd };
}

function planDataNoteCredit(note) {
  return String(note || "").match(/(\d+(?:\.\d+)?)\s*학점/)?.[1] || "";
}

// 수식의 행 참조를 바꾼다. 범위의 끝은 end=true로 옮긴다.
function planDataRemapFormula(formula, mapRow) {
  return String(formula).split(/("(?:[^"]|"")*")/).map((part) => part.startsWith('"') ? part :
    part.replace(/(\$?[A-Z]{1,3}\$?)(\d+)(?::(\$?[A-Z]{1,3}\$?)(\d+))?/g, (match, startColumn, startRow, endColumn, endRow) => {
      if (endColumn === undefined) return `${startColumn}${mapRow(Number(startRow) - 1, false) + 1}`;
      return `${startColumn}${mapRow(Number(startRow) - 1, false) + 1}:${endColumn}${mapRow(Number(endRow) - 1, true) + 1}`;
    })).join("");
}

// 데이터로 표를 다시 만들어 layout에 반영한다. 원본 칸·병합 흔적(예전 앱의 행 삽입·병합 기록)은 지운다.
function applyCurriculumData(layout, data = layout.planData, template = layout.planTemplate) {
  normalizeCurriculumData(data);
  const sheet = curriculumSheetFromData(data, template);
  layout.rows = sheet.rows;
  layout.mergedRanges = sheet.mergedRanges;
  layout.formulas = sheet.formulas;
  layout.cellFills = sheet.cellFills;
  layout.rowHeights = sheet.rowHeights;
  layout.hiddenRows = sheet.hiddenRows;
  layout.planRowMeta = sheet.rowMeta;
  layout.columnWidths = template.columnWidths.map((width) => width ?? 8.43);
  layout.planData = data;
  layout.planTemplate = template;
  for (const key of ["sheetMerges", "choiceBlockRanges", "retiredSubjectRows", "sheetCellEdits", "formulaEdits", "showEmptySubjectRows"]) {
    delete layout[key];
  }
  if (typeof recalculatePlanFormulas === "function") {
    try { recalculatePlanFormulas(layout); } catch (error) { layout.planFormulaError = error?.message || String(error); }
  }
  return layout;
}

// 업로드 변환에서 보정한 내용(교차집중 인식·운영학점으로 채운 묶음 학점). 상태 문구에만 쓰고 저장하지 않는다.
const planDataRepairNotes = new WeakMap();
function curriculumDataRepairNotes(layout) {
  return planDataRepairNotes.get(layout) || [];
}

// 예전에 저장한 편제표(표 기반)는 열 때 데이터로 바꾼다. 실패하면 표 기반 그대로 둔다.
function ensureCurriculumPlanData(layout) {
  if (!layout || layout.derived && layout.planData) return false;
  if (layout.planData?.version === PLAN_DATA_VERSION && layout.planTemplate) return false;
  if (!Array.isArray(layout.rows) || !layout.rows.length) return false;
  try {
    const { data, template, repairs } = curriculumDataFromLayout(layout);
    applyCurriculumData(layout, data, template);
    planDataRepairNotes.set(layout, repairs || []);
    return true;
  } catch (error) {
    layout.planDataError = error?.message || String(error);
    return false;
  }
}

const planDataConversionCache = new WeakMap();
// 비교 기준·이전 이력처럼 데이터가 없는 표는 읽기 전용으로 변환해 쓴다(원본은 바꾸지 않는다).
function curriculumLayoutData(layout) {
  if (!layout) return null;
  if (layout.planData) return layout;
  if (planDataConversionCache.has(layout)) return planDataConversionCache.get(layout);
  let converted = null;
  try {
    const copy = planDataClone({ rows: layout.rows, mergedRanges: layout.mergedRanges || [], formulas: layout.formulas || {},
      choiceBlockRanges: layout.choiceBlockRanges, sheetMerges: layout.sheetMerges, columnWidths: layout.columnWidths || [],
      cellFills: layout.cellFills || {}, rowHeights: layout.rowHeights || {}, hiddenRows: layout.hiddenRows || [] });
    const { data, template } = curriculumDataFromLayout(copy);
    converted = applyCurriculumData(copy, data, template);
  } catch (error) {
    converted = null;
  }
  planDataConversionCache.set(layout, converted);
  return converted;
}

// 편제표 택n 묶음(학기별)을 데이터에서 만든다. 예전 curriculumChoiceBlocks와 같은 모양이다.
function curriculumDataChoiceBlocks(layout) {
  const data = layout.planData;
  const columns = layout.planTemplate?.columns;
  if (!data || !columns) return [];
  const byId = new Map(data.subjects.map((item) => [item.id, item]));
  const blocks = [];
  for (const group of data.groups || []) {
    const members = group.members.map((id) => byId.get(id)).filter(Boolean);
    if (!members.length) continue;
    const subjects = [...new Set(members.flatMap((member) => planDataSubjectNames(member.name)))];
    for (const field of group.fields) {
      const index = PLAN_DATA_FIELDS.indexOf(field);
      blocks.push({
        key: `${field}:${members[0].row}`, groupId: group.id, field,
        grade: planDataGrade(field), semester: planDataSemester(field), column: columns.semesters[index],
        startRow: members[0].row, endRow: members.at(-1).rowEnd, pick: group.pick, credit: planDataGroupCredit(data, group),
        total: group.pick * planDataGroupCredit(data, group), creditCells: [], subjects, completion: null,
        ...(group.fields.length > 1 ? { crossed: true } : {})
      });
    }
  }
  const counts = new Map();
  for (const block of blocks) counts.set(`${block.field}:${block.pick}`, (counts.get(`${block.field}:${block.pick}`) || 0) + 1);
  const ordinals = new Map();
  for (const block of blocks.sort((a, b) => a.startRow - b.startRow || a.column - b.column)) {
    const scope = `${block.field}:${block.pick}`;
    const order = (ordinals.get(scope) || 0) + 1;
    ordinals.set(scope, order);
    const base = `${block.grade}-${block.semester} 택${block.pick}`;
    block.name = counts.get(scope) > 1 ? `${base}-${order}` : base;
  }
  return blocks;
}

function planDataCleanName(name) {
  return String(name ?? "").replace(/↔/g, " ").replace(/^[*＊★☆■\s]+|[*＊★☆■\s]+$/g, "").replace(/\s+/g, " ").trim();
}

// 학년·학기별 과목 항목(시수 통계·이력 비교·학기 합계에 쓴다). 예전 curriculumPlanEntries와 같은 모양이다.
function curriculumDataPlanEntries(layout) {
  const result = { entries: [], issues: [] };
  const data = layout?.planData;
  if (!data) return result;
  for (const subject of planDataSubjects(data)) {
    const names = String(subject.name).split(/[,，、]/).map(planDataCleanName).filter(Boolean)
      .filter((name) => !/소계|창의적체험|총이수|이수학점|합계|과목명|세부과목|교육과정|표기방법/.test(planDataKey(name)) &&
        !["공통", "일반", "진로", "융합"].includes(planDataKey(name)));
    if (!names.length) continue;
    const divisionName = planDataDivision(subject.category);
    const division = divisionName === "학생 선택 교육과정" ? "학생선택" : divisionName === "학교 지정 교육과정" ? "학교지정" : "";
    const credit = planDataNumber(subject.op) || planDataNumber(subject.base) || 0;
    const memberships = planDataGroupsOf(data, subject.id);
    const tagged = memberships.find((group) => group.members[0] === subject.id);
    const choiceTag = tagged ? `택${tagged.pick}` : "";
    const crossedName = String(subject.name).includes("↔");
    const area = String(subject.area || "").replace(/↔/g, " ").replace(/\s+/g, " ").trim();
    const base = { area, division, detail: subject.kind || "", names: names.length, crossed: Boolean(subject.cross?.length) || crossedName,
      crossSemesters: subject.cross?.length || 0, ...(subject.cross?.length && names.length > 1 ? { crossExtra: planDataCrossSplitIndex(subject) } : {}),
      choiceTag, rowIndex: subject.row };
    if (subject.note) {
      const note = String(subject.note).trim();
      const kind = /공동/.test(note) ? "공동" : /소인수/.test(note) ? "소인수" : "";
      const grade = note.match(/([123])\s*학년/)?.[1] || "";
      const semesters = (note.match(/([12](?:\s*[,·]\s*[12])*)\s*학기/)?.[1] || "").split(/[,·]/).map((part) => part.trim()).filter(Boolean);
      const noteCredit = Number(planDataNoteCredit(note)) || credit;
      if (!grade || !semesters.length) {
        result.issues.push(`${names.join(", ")}: 학기 칸 메모 '${note}'의 학년·학기를 읽지 못했습니다.`);
        continue;
      }
      for (const semester of semesters) {
        names.forEach((name, nameIndex) => result.entries.push({ ...base, grade, semester, subject: name, nameIndex,
          credit: noteCredit, creditSource: "note", note, kind: kind || (division === "학생선택" || choiceTag ? "선택" : "지정") }));
      }
      continue;
    }
    PLAN_DATA_FIELDS.forEach((field, index) => {
      const grade = String(Math.floor(index / 2) + 1), semester = String(index % 2 + 1);
      const group = memberships.find((item) => item.fields.includes(field));
      if (group) {
        names.forEach((name, nameIndex) => result.entries.push({ ...base, crossed: group.fields.length > 1 || crossedName,
          grade, semester, subject: name, nameIndex, credit: planDataGroupCredit(data, group) || credit, creditSource: "block", kind: "선택" }));
        return;
      }
      const value = subject.credits?.[field];
      const text = subject.texts?.[field];
      if (value === undefined && !text) return;
      if (value !== undefined && !(value > 0)) return;
      if (!(value > 0)) {
        result.issues.push(`${names.join(", ")} ${grade}학년 ${semester}학기 칸 '${text}'을(를) 숫자로 읽지 못해 운영학점 ${credit}을(를) 사용했습니다.`);
      }
      names.forEach((name, nameIndex) => result.entries.push({ ...base,
        crossed: Boolean(subject.cross?.includes(field)) || crossedName, grade, semester, subject: name, nameIndex,
        credit: value > 0 ? value : credit, creditSource: value > 0 ? "semester" : "credit",
        kind: division === "학생선택" || choiceTag ? "선택" : "지정" }));
    });
  }
  return result;
}

// 비교 기준과 현재 편제표의 과목별 편성 지문(변경 음영에 쓴다).
function curriculumDataSignatures(layout, plan = null) {
  const target = curriculumLayoutData(layout);
  const subjects = new Map();
  if (!target) return subjects;
  const data = target.planData;
  const entries = curriculumDataPlanEntries(target).entries;
  const byId = new Map(data.subjects.map((item) => [item.id, item]));
  const official = (name) => typeof findCurriculumOfficialSubject === "function" ? findCurriculumOfficialSubject(name) : null;
  for (const subject of planDataSubjects(data)) {
    const memberships = planDataGroupsOf(data, subject.id);
    for (const name of planDataSubjectNames(subject.name)) {
      const key = planDataNameKey(name);
      if (!key) continue;
      const item = subjects.get(key) || { name, records: new Set() };
      const placements = new Set(entries.filter((entry) => entry.rowIndex === subject.row && planDataNameKey(entry.subject) === key &&
        !memberships.some((group) => group.fields.includes(`sem${entry.grade}${entry.semester}`)))
        .map((entry) => JSON.stringify([`sem${entry.grade}${entry.semester}`, Number(entry.credit), entry.kind, entry.crossed])));
      for (const group of memberships) for (const field of group.fields) {
        placements.add(JSON.stringify([field, planDataGroupCredit(data, group), "선택", group.fields.length > 1]));
      }
      const officialSubject = official(name);
      const identity = {
        division: planDataDivision(subject.category) || subject.category,
        area: planDataKey(subject.area),
        detail: subject.kind || (officialSubject?.category === "전문교과" ? "진로선택" : officialSubject?.type) || "",
        baseCredit: planDataNumber(subject.base) || 0, opCredit: planDataNumber(subject.op) || 0
      };
      for (const placement of placements.size ? placements : [""]) {
        const field = placement ? JSON.parse(placement)[0] : "";
        item.records.add(JSON.stringify({
          ...identity, placement,
          groups: memberships.filter((group) => group.fields.includes(field)).map((group) =>
            JSON.stringify([group.pick, planDataGroupCredit(data, group), [...new Set(group.members.flatMap((id) =>
              planDataSubjectNames(byId.get(id)?.name).map(planDataNameKey)))].sort()])).sort(),
          ...(plan ? { manualGroups: [...new Set(plan.filter((row) => planDataNameKey(row.subject) === key && row[field] &&
            row.semesterGroups?.[field] && !row.semesterGroups[field].block).map((row) =>
            JSON.stringify([row.semesterGroups[field].name, row.semesterGroups[field].pick])))].sort() } : {})
        }));
      }
      subjects.set(key, item);
    }
  }
  return new Map([...subjects].map(([key, item]) => [key, { name: item.name, signature: JSON.stringify([...item.records].sort()) }]));
}

// ---- 편집: 모든 편집은 데이터만 바꾸고 표는 다시 만든다.

function planDataIndex(data, id) {
  return data.subjects.findIndex((item) => item.id === id);
}

function planDataNewId(data, prefix = "s") {
  data.nextId = Math.max(Number(data.nextId) || 1, 1);
  let id;
  do { id = `${prefix}${data.nextId++}`; } while (data.subjects.some((item) => item.id === id) || (data.groups || []).some((group) => group.id === id));
  return id;
}

function curriculumDataEdit(layout, mutate) {
  if (!layout?.planData || !layout.planTemplate) throw new Error("편제표 데이터가 없습니다. 편제표를 다시 업로드하세요.");
  if (layout.derived) throw new Error("전학년 편제표는 3개년 편제표에서 자동으로 만들어 수정할 수 없습니다.");
  const next = planDataClone(layout);
  const result = mutate(next.planData, next.planTemplate, next);
  applyCurriculumData(next);
  return { layout: next, result };
}

// 전학년 편제표에서 쓰는 과목별 학기 학점(묶음 과목은 묶음 학점, 메모 과목은 메모 학점).
// 교차집중 과목은 함께 엇갈려 이수하는 과목명(crossNames)과 학기(crossFields)를 함께 남긴다(전학년 편제표가 한 행으로 다시 묶는다).
function curriculumDataSubjectCredits(layout) {
  const credits = new Map();
  for (const entry of curriculumDataPlanEntries(layout).entries) {
    const key = planDataNameKey(entry.subject);
    const item = credits.get(key) || {};
    const field = `sem${entry.grade}${entry.semester}`;
    if (!item[field]) item[field] = Number(entry.credit) || 0;
    credits.set(key, item);
  }
  for (const subject of planDataSubjects(layout?.planData)) {
    if (!subject.cross?.length || subject.note) continue;
    const names = planDataSubjectNames(subject.name);
    if (names.length < 2) continue;
    for (const name of names) {
      const item = credits.get(planDataNameKey(name));
      if (item) { item.crossNames = names.slice(); item.crossFields = subject.cross.slice(); if (subject.crossSplit) item.crossSplit = subject.crossSplit; }
    }
  }
  return credits;
}

function planDataSelectionFields(template, selection) {
  const endColumn = selection.endColumn ?? selection.column;
  return template.columns.semesters.flatMap((column, index) => column >= 0 && column >= selection.column && column <= endColumn ? [PLAN_DATA_FIELDS[index]] : []);
}

function planDataSelectionSubjects(data, selection) {
  return planDataSubjects(data).filter((item) => item.row <= selection.endRow && item.rowEnd >= selection.startRow);
}

function planDataNamesCount(data, ids) {
  const byId = new Map(data.subjects.map((item) => [item.id, item]));
  return new Set(ids.flatMap((id) => planDataSubjectNames(byId.get(id)?.name).map(planDataNameKey))).size;
}

function planDataCheckGroup(fields, pick, credit, names) {
  if (!fields.length) throw new Error("학기 열(1-1 ~ 3-2)에서 과목 칸을 선택하세요.");
  if (fields.length > 2 || (fields.length === 2 && planDataGrade(fields[0]) !== planDataGrade(fields[1]))) {
    throw new Error("선택과목군은 한 학기 열, 또는 같은 학년의 1·2학기 두 열만 묶을 수 있습니다.");
  }
  if (!Number.isInteger(pick) || pick < 1) throw new Error("선택 수(택n)는 1 이상의 정수로 입력하세요.");
  if (pick > names) throw new Error(`묶음 과목이 ${names}개이므로 택${pick}을 지정할 수 없습니다.`);
  if (!Number.isFinite(credit) || credit <= 0 || credit > 30) throw new Error("학점은 0보다 크고 30 이하인 숫자로 입력하세요.");
}

// 학기 열에서 고른 과목 칸들을 선택과목군으로 묶는다. 고른 범위 안의 기존 묶음은 새 묶음으로 바뀐다.
function curriculumDataGroupSelection(layout, selection, values) {
  return curriculumDataEdit(layout, (data, template) => {
    const fields = planDataSelectionFields(template, selection);
    const members = planDataSelectionSubjects(data, selection);
    if (!members.length) throw new Error("과목이 있는 행을 선택하세요.");
    if (members.some((item) => item.note)) throw new Error("학기 칸 메모(소인수·공동) 과목은 선택과목군으로 묶을 수 없습니다.");
    const ids = members.map((item) => item.id);
    const pick = Number(String(values.pick ?? "").trim()), credit = Number(String(values.credit ?? "").trim());
    planDataCheckGroup(fields, pick, credit, planDataNamesCount(data, ids));
    const overlapping = data.groups.filter((group) => group.fields.some((field) => fields.includes(field)) &&
      group.members.some((id) => ids.includes(id)));
    if (overlapping.some((group) => group.members.some((id) => !ids.includes(id)))) {
      throw new Error("기존 선택과목군의 일부만 선택했습니다. 기존 묶음 전체를 포함해 선택하거나 먼저 묶음을 푸세요.");
    }
    data.groups = data.groups.filter((group) => !overlapping.includes(group));
    for (const item of members) {
      if (item.opFormula) item.opFormula = false;
      if (item.cross?.some((field) => fields.includes(field))) item.cross = null;
    }
    const group = { id: planDataNewId(data, "g"), fields, pick, credit, members: ids };
    data.groups.push(group);
    return group;
  });
}

// 고른 칸과 겹치는 선택과목군을 푼다. 구성 과목은 그 학기에 묶음 학점으로 각각 편성된다.
function curriculumDataUngroupSelection(layout, selection) {
  return curriculumDataEdit(layout, (data, template) => {
    const fields = planDataSelectionFields(template, selection);
    const rows = planDataSelectionSubjects(data, selection).map((item) => item.id);
    const selected = data.groups.filter((group) => group.fields.some((field) => fields.includes(field)) &&
      group.members.some((id) => rows.includes(id)));
    if (!selected.length) throw new Error("풀 선택과목군 안의 칸을 선택하세요.");
    planDataReleaseGroups(data, selected);
    return selected;
  });
}

// 드래그로 고른 두 학기 칸(같은 학년 1·2학기)을 교차집중 과목으로 묶는다. 학기당 학점은 고른 칸의 학점(없으면 운영학점 ÷ 2).
function curriculumDataSelectionToCross(layout, selection) {
  return curriculumDataEdit(layout, (data, template) => {
    const fields = planDataSelectionFields(template, selection);
    if (!planDataIsGradePair(fields)) throw new Error("교차집중은 같은 학년의 1·2학기 두 열을 함께 고르세요.");
    const members = planDataSelectionSubjects(data, selection);
    if (!members.length) throw new Error("과목이 있는 행을 선택하세요.");
    if (members.some((item) => item.note)) throw new Error("학기 칸 메모(소인수·공동) 과목은 교차집중으로 묶을 수 없습니다.");
    const ids = members.map((item) => item.id);
    if (planDataNamesCount(data, ids) < 2) throw new Error("교차집중은 과목이 두 개 이상이어야 합니다(예: 음악, 미술).");
    const overlapping = data.groups.filter((group) => group.fields.some((field) => fields.includes(field)) && group.members.some((id) => ids.includes(id)));
    if (overlapping.some((group) => group.members.some((id) => !ids.includes(id)))) {
      throw new Error("기존 선택과목군의 일부만 선택했습니다. 기존 묶음 전체를 포함해 선택하거나 먼저 묶음을 푸세요.");
    }
    const credits = members.flatMap((item) => fields.map((field) => Number(item.credits?.[field]) || 0)).filter((value) => value > 0);
    const credit = Math.max(0, ...credits, ...overlapping.map((group) => planDataGroupCredit(data, group))) ||
      (planDataNumber(members[0].op) || planDataNumber(members[0].base) || 0) / fields.length;
    data.groups = data.groups.filter((group) => !overlapping.includes(group));
    const group = { id: planDataNewId(data, "g"), fields, pick: 1, credit: credit > 0 ? credit : 0, members: ids };
    data.groups.push(group);
    return planDataGroupsToCross(data, [group]);
  });
}

// 묶음 띠의 위·아래 끝을 끌어 범위를 바꾼다. edge: "top" | "bottom", targetId: 새 끝 과목 행.
// 빠지는 과목은 묶음 학점을 자기 학기 학점으로 가지고, 들어오는 과목의 그 학기 학점·글자는 지운다.
function curriculumDataResizeGroup(layout, groupId, edge, targetId) {
  return curriculumDataEdit(layout, (data) => {
    const group = data.groups.find((item) => item.id === groupId);
    if (!group) throw new Error("선택과목군을 찾지 못했습니다.");
    const indexes = group.members.map((id) => planDataIndex(data, id));
    const target = planDataIndex(data, targetId);
    if (target < 0 || data.subjects[target].fixed) throw new Error("과목 행까지 끌어 놓으세요.");
    const first = edge === "top" ? target : Math.min(...indexes);
    const last = edge === "top" ? Math.max(...indexes) : target;
    if (first > last) throw new Error("묶음에는 과목이 하나 이상 있어야 합니다.");
    const inside = data.subjects.slice(first, last + 1);
    if (inside.some((item) => item.fixed)) throw new Error("소계 같은 고정 행을 넘어 묶을 수 없습니다.");
    if (inside.some((item) => item.note)) throw new Error("학기 칸 메모(소인수·공동) 과목은 선택과목군에 넣을 수 없습니다.");
    const ids = inside.map((item) => item.id);
    const clash = data.groups.find((other) => other !== group && other.fields.some((field) => group.fields.includes(field)) &&
      other.members.some((id) => ids.includes(id)));
    if (clash) throw new Error(`${planDataGroupLabel(clash)} 묶음과 학기 칸이 겹칩니다.`);
    const names = planDataNamesCount(data, ids);
    if (group.pick > names) throw new Error(`묶음 과목이 ${names}개가 되어 택${group.pick}을 유지할 수 없습니다. 택 수를 먼저 줄이세요.`);
    const credit = planDataGroupCredit(data, group);
    for (const id of group.members) {
      if (ids.includes(id)) continue;
      const item = data.subjects.find((subject) => subject.id === id);
      for (const field of group.fields) if (credit > 0) item.credits[field] = credit;
    }
    for (const item of inside) {
      if (group.members.includes(item.id)) continue;
      for (const field of group.fields) { delete item.credits?.[field]; delete item.texts?.[field]; }
      if (item.cross?.some((field) => group.fields.includes(field))) item.cross = null;
      if (item.opFormula) item.opFormula = false;
    }
    group.members = ids;
    return group;
  });
}

// 2단계 선택 그룹 편집기에서 편제표와 연동된 과목 칩을 다른 묶음(또는 묶음 밖)으로 끌었을 때.
// 편제표가 기준이므로 과목 행을 목표 묶음의 끝으로 옮겨 묶음을 바꾼다. targetGroupId가 없으면 묶음 밖(원래 묶음 바로 아래)으로.
function curriculumDataMoveSubjectToGroup(layout, name, field, targetGroupId) {
  return curriculumDataEdit(layout, (data) => {
    let item = planDataFindName(data, name);
    if (!item) throw new Error(`${name}: 편제표에서 과목을 찾지 못했습니다.`);
    const source = planDataGroupsOf(data, item.id).find((group) => group.fields.includes(field)) || null;
    const target = targetGroupId ? data.groups.find((group) => group.id === targetGroupId) : null;
    if (targetGroupId && !target) throw new Error("옮길 선택과목군을 찾지 못했습니다.");
    if (target && !target.fields.includes(field)) throw new Error("같은 학기의 선택과목군으로만 옮길 수 있습니다.");
    if (source && target && source === target) return item;
    if (item.note) throw new Error("학기 칸 메모(소인수·공동) 과목은 선택과목군에 넣을 수 없습니다.");
    if (planDataNameParts(item.name).length > 1) item = planDataIsolate(data, name);
    const others = planDataGroupsOf(data, item.id).filter((group) => group !== source);
    if (others.length) throw new Error(`${name}은(는) ${others.map(planDataGroupLabel).join(", ")} 묶음에도 있어 행을 옮길 수 없습니다. 1단계 편제표에서 바꾸세요.`);
    const credit = source ? planDataGroupCredit(data, source) : 0;
    if (source) {
      const rest = source.members.filter((id) => id !== item.id);
      if (rest.length && planDataNamesCount(data, rest) < source.pick) throw new Error(`${planDataGroupLabel(source)}: 남는 과목이 ${planDataNamesCount(data, rest)}개입니다. 선택 수를 먼저 줄이세요.`);
    }
    const lastOf = (group) => Math.max(...group.members.map((id) => planDataIndex(data, id)));
    const anchor = target ? lastOf(target) : source ? lastOf(source) : -1;
    if (source) source.members = source.members.filter((id) => id !== item.id);
    data.groups = data.groups.filter((group) => group.members.length);
    if (anchor >= 0) {
      const anchorId = data.subjects[anchor].id === item.id ? null : data.subjects[anchor].id;
      data.subjects.splice(planDataIndex(data, item.id), 1);
      const at = anchorId ? planDataIndex(data, anchorId) + 1 : Math.min(anchor, data.subjects.length);
      data.subjects.splice(at, 0, item);
    }
    for (const group of target ? [target] : []) {
      group.members.push(item.id);
      for (const key of group.fields) { delete item.credits?.[key]; delete item.texts?.[key]; }
    }
    if (!target && credit > 0) item.credits[field] = credit;
    normalizeCurriculumData(data);
    const joined = planDataGroupsOf(data, item.id).filter((group) => group !== target);
    if (joined.length) throw new Error(`${name}을(를) 옮길 자리에 ${joined.map(planDataGroupLabel).join(", ")} 묶음도 있어 다른 학기 묶음까지 바뀝니다. 1단계 편제표에서 묶음 띠 끝을 끌어 바꾸세요.`);
    return item;
  });
}

function planDataReleaseGroups(data, groups) {
  for (const group of groups) {
    for (const id of group.members) {
      const item = data.subjects.find((subject) => subject.id === id);
      if (!item) continue;
      const credit = planDataGroupCredit(data, group);
      for (const field of group.fields) if (credit > 0) item.credits[field] = credit;
    }
  }
  data.groups = data.groups.filter((group) => !groups.includes(group));
}

function curriculumDataUpdateGroup(layout, groupId, values) {
  return curriculumDataEdit(layout, (data) => {
    const group = data.groups.find((item) => item.id === groupId);
    if (!group) throw new Error("선택과목군을 찾지 못했습니다. 화면을 새로 고친 뒤 다시 시도하세요.");
    if (values.remove) { planDataReleaseGroups(data, [group]); return null; }
    const pick = Number(String(values.pick ?? "").trim()), credit = Number(String(values.credit ?? "").trim());
    planDataCheckGroup(group.fields, pick, credit, planDataNamesCount(data, group.members));
    group.pick = pick;
    group.credit = credit;
    delete group.creditFrom;
    delete group.creditNote;
    return group;
  });
}

// 선택과목군(같은 학년 1·2학기)을 교차집중 과목으로 바꾼다. 한 학기짜리 묶음은 같은 구성 과목의 다른 학기 묶음과 함께 바꾼다.
function curriculumDataGroupToCross(layout, groupId) {
  return curriculumDataEdit(layout, (data) => {
    const group = data.groups.find((item) => item.id === groupId);
    if (!group) throw new Error("선택과목군을 찾지 못했습니다. 화면을 새로 고친 뒤 다시 시도하세요.");
    const set = planDataCrossCandidates(data, group);
    if (!set) throw new Error("교차집중은 같은 학년 1·2학기에 걸친 묶음만 바꿀 수 있습니다. 1·2학기 두 열을 함께 묶거나 다른 학기에 같은 과목 묶음이 있어야 합니다.");
    if (planDataNamesCount(data, set.flatMap((item) => item.members)) < 2) throw new Error("교차집중은 과목이 두 개 이상이어야 합니다(예: 음악, 미술).");
    if (set.some((item) => item.members.some((id) => data.subjects.find((subject) => subject.id === id)?.note))) {
      throw new Error("학기 칸 메모(소인수·공동) 과목은 교차집중으로 바꿀 수 없습니다.");
    }
    return planDataGroupsToCross(data, set);
  });
}

function planDataCrossCandidates(data, group) {
  if (planDataIsGradePair(group.fields)) return [group];
  if (group.fields.length !== 1) return null;
  const sibling = (data.groups || []).find((other) => other !== group && other.fields.length === 1 &&
    planDataIsGradePair([group.fields[0], other.fields[0]].sort()) &&
    other.members.length === group.members.length && other.members.every((id) => group.members.includes(id)));
  return sibling ? [group, sibling] : null;
}

// 교차집중 과목을 1·2학기 택1 선택과목군으로 바꾼다(학생이 고르는 과목일 때).
function curriculumDataCrossToGroup(layout, id) {
  return curriculumDataEdit(layout, (data) => {
    const subject = planDataSubjects(data).find((item) => item.id === id);
    if (!subject?.cross?.length) throw new Error("교차집중 과목을 찾지 못했습니다.");
    const fields = PLAN_DATA_FIELDS.filter((field) => subject.cross.includes(field));
    const credit = Math.max(0, ...fields.map((field) => Number(subject.credits?.[field]) || 0)) ||
      (planDataNumber(subject.op) || planDataNumber(subject.base) || 0);
    if (!(credit > 0)) throw new Error("교차집중 학기 학점을 먼저 입력하세요.");
    if (planDataGroupsOf(data, id).some((group) => group.fields.some((field) => fields.includes(field)))) {
      throw new Error("이미 선택과목군에 들어 있는 학기입니다.");
    }
    for (const field of fields) { delete subject.credits[field]; delete subject.texts?.[field]; }
    subject.cross = null;
    const group = { id: planDataNewId(data, "g"), fields, pick: 1, credit, members: [id] };
    data.groups.push(group);
    return group;
  });
}

// 교차집중 과목의 학기당 학점을 바꾼다. split: 학급 수가 홀수일 때 첫 학기에 1반 더 받는 과목(이름, 생략하면 그대로).
function curriculumDataSetCrossCredit(layout, id, value, split) {
  const credit = Number(String(value ?? "").trim());
  if (!Number.isFinite(credit) || credit <= 0 || credit > 30) throw new Error("학기당 학점은 0보다 크고 30 이하인 숫자로 입력하세요.");
  return curriculumDataEdit(layout, (data) => {
    const subject = planDataSubjects(data).find((item) => item.id === id);
    if (!subject?.cross?.length) throw new Error("교차집중 과목을 찾지 못했습니다.");
    for (const field of subject.cross) subject.credits[field] = credit;
    if (split !== undefined) planDataSetCrossSplit(subject, split);
    return subject;
  });
}

// 교차집중 학급 배분: 학급 수가 홀수면 한 과목이 1반 더 받는다. 첫 학기(예: 2-1)에 1반 더 받는 과목은 subject.crossSplit(과목명),
// 둘째 학기는 반대로. 값이 없으면 뒤 과목(시수표와 같은 기본값: 1학기 미술 6·음악 5, 2학기 음악 6·미술 5).
function planDataCrossSplitIndex(subject) {
  const names = planDataSubjectNames(subject?.name);
  if (!subject?.cross?.length || names.length < 2) return -1;
  const index = subject.crossSplit ? names.map(planDataNameKey).indexOf(planDataNameKey(subject.crossSplit)) : -1;
  return index >= 0 ? index : names.length - 1;
}

// 전학년 편제표(curriculum-annual.js)가 남긴 교차집중 학급 배분을 변환한 과목 데이터에 옮긴다.
function curriculumDataApplyCrossSplits(layout) {
  const splits = layout?.crossSplits;
  if (!splits || !layout.planData) return;
  for (const subject of planDataSubjects(layout.planData)) {
    const split = subject.cross?.length ? splits[String(subject.name ?? "").replace(/\s+/g, "")] : null;
    if (split) planDataSetCrossSplit(subject, split);
  }
}

function planDataSetCrossSplit(subject, name) {
  const names = planDataSubjectNames(subject.name);
  const index = names.map(planDataNameKey).indexOf(planDataNameKey(name));
  if (!name || index < 0 || index === names.length - 1) delete subject.crossSplit;
  else subject.crossSplit = names[index];
}

// 교차집중 과목의 학기별 반 수(과목 순서대로). 학급 수가 짝수면 똑같이 나눈다.
function planDataCrossClasses(subject, total) {
  const names = planDataSubjectNames(subject?.name);
  const count = Math.max(1, names.length);
  const split = planDataCrossSplitIndex(subject);
  return [1, 2].map((semester) => names.map((_, index) => {
    const base = Math.floor(total / count), extra = total % count;
    const position = semester === 1 ? (index - split + count) % count : (split - 1 - index + 2 * count) % count;
    return base + (position < extra ? 1 : 0);
  }));
}

// 교차집중 띠 문구: '교차집중 · 음악↔미술 · 학기당 2학점'
function planDataCrossLabel(subject) {
  const names = planDataSubjectNames(subject?.name);
  const fields = PLAN_DATA_FIELDS.filter((field) => subject?.cross?.includes(field));
  const credits = [...new Set(fields.map((field) => Number(subject.credits?.[field]) || 0))];
  const creditText = credits.length === 1 ? `학기당 ${planDataNumberText(credits[0])}학점`
    : fields.map((field) => `${planDataSemester(field)}학기 ${planDataNumberText(subject.credits?.[field] || 0)}`).join("·") + "학점";
  return `교차집중 · ${names.join("↔")} · ${creditText}`;
}

// ---- 공식 과목명 자동 수정(업로드·원본 재변환 단계). 원래 이름은 subject.originalName에 남긴다.
// 과목 칸 하나에 여러 과목(쉼표)이 있으면 과목마다 고치고 쉼표·표기 기호(*·★)는 그대로 둔다.
function planDataAutoName(name) {
  if (typeof curriculumOfficialAutoName !== "function") return null;
  let changed = false;
  const fixes = [];
  const next = String(name ?? "").split(/([,，、])/).map((part, index) => {
    if (index % 2) return part;
    const lead = part.match(/^\s*/)[0], tail = part.match(/\s*$/)[0];
    const core = part.trim();
    const marks = core.match(/^[*＊★]*/)[0], after = core.slice(marks.length).match(/[*＊★]*$/)[0];
    const plain = core.slice(marks.length, core.length - after.length);
    const fix = plain ? curriculumOfficialAutoName(plain) : null;
    if (!fix || fix.name === plain) return part;
    changed = true;
    fixes.push({ from: plain.trim(), to: fix.name, kind: fix.kind });
    return `${lead}${marks}${fix.name}${after}${tail}`;
  }).join("");
  return changed ? { name: next, fixes } : null;
}

// 편제표 데이터의 과목명을 공식명으로 고친다(같은 데이터를 바꾼다). 고친 목록을 돌려준다.
function curriculumDataAutoNames(data) {
  const fixed = [];
  for (const subject of planDataSubjects(data)) {
    if (subject.originalName !== undefined) continue;
    const result = planDataAutoName(subject.name);
    if (!result) continue;
    subject.originalName = subject.name;
    subject.name = result.name;
    fixed.push({ id: subject.id, from: subject.originalName, to: result.name, fixes: result.fixes });
  }
  return fixed;
}

// 자동 수정 대상 편제표인지: 2022 개정(2025학년도 이후 입학생) 입학생 편제표이고 교사가 끄지 않았을 때.
function curriculumAutoNameEligible(layout, cohortYear) {
  if (!layout?.planData || layout.derived || layout.autoNameOff) return false;
  const revision = typeof planComplianceRevision === "function" ? planComplianceRevision(layout, cohortYear).revision
    : Number(cohortYear) >= 2025 ? "2022" : "2015";
  return revision === "2022";
}

// 업로드·원본 재변환 직후 부른다. 고치면 표를 다시 만든다.
function curriculumApplyAutoNames(layout, cohortYear) {
  if (!curriculumAutoNameEligible(layout, cohortYear)) return [];
  const fixed = curriculumDataAutoNames(layout.planData);
  if (fixed.length) applyCurriculumData(layout);
  return fixed;
}

// 자동 수정한 과목 목록(표시·되돌리기)
// 한 칸에 여러 과목이 있으면 바뀐 과목만 'from → to'로 보인다(전체 이름은 fullFrom·fullTo).
function curriculumAutoNameList(layout) {
  return planDataSubjects(layout?.planData).filter((subject) => subject.originalName !== undefined && subject.originalName !== subject.name)
    .map((subject) => {
      const before = planDataSubjectNames(subject.originalName), after = planDataSubjectNames(subject.name);
      const pairs = before.length === after.length ? before.map((name, index) => [name, after[index]]).filter(([a, b]) => a !== b) : [];
      return { id: subject.id, from: pairs.length ? pairs.map(([a]) => a).join(", ") : subject.originalName,
        to: pairs.length ? pairs.map(([, b]) => b).join(", ") : subject.name, fullFrom: subject.originalName, fullTo: subject.name };
    });
}

// 자동 수정 되돌리기(과목 하나). 이름을 원래대로 두고 originalName을 지운다.
function curriculumDataRevertAutoName(layout, id) {
  return curriculumDataEdit(layout, (data) => {
    const subject = planDataSubjects(data).find((item) => item.id === id);
    if (!subject || subject.originalName === undefined) throw new Error("자동 수정한 과목을 찾지 못했습니다.");
    subject.name = subject.originalName;
    delete subject.originalName;
    return subject;
  });
}

// 편제표별 자동 수정 켜기·끄기. 끄면 모두 원래 이름으로, 켜면 지금 이름을 다시 고친다.
function curriculumDataSetAutoNames(layout, on, cohortYear) {
  return curriculumDataEdit(layout, (data, template, next) => {
    if (on) {
      delete next.autoNameOff;
      return curriculumAutoNameEligible(next, cohortYear) ? curriculumDataAutoNames(data) : [];
    }
    next.autoNameOff = true;
    const reverted = [];
    for (const subject of planDataSubjects(data)) {
      if (subject.originalName === undefined) continue;
      reverted.push({ id: subject.id, from: subject.name, to: subject.originalName });
      subject.name = subject.originalName;
      delete subject.originalName;
    }
    return reverted;
  });
}

// 과목명 별칭: 자동 수정 전 이름(originalName)도 같은 과목으로 본다(수강신청 결과·선택 그룹·위계 규칙이 예전 표기를 써도 연결).
// result-import.js normalizeResultCourseName이 정규화한 키로 묻는다. 편제표가 바뀔 때마다 다시 만든다.
let planDataAliasCache = null;
function curriculumNameAlias(key, normalize) {
  if (typeof state === "undefined" || !key) return null;
  const layouts = [state.curriculumImportedLayout, ...Object.values(state.curriculumCohorts || {}).map((item) => item?.importedLayout),
    ...Object.values(state.curriculumAnnualPlans || {}).map((item) => item?.importedLayout)].filter((layout) => layout?.planData);
  const stamp = layouts.map((layout) => layout.planData);
  if (!planDataAliasCache || planDataAliasCache.stamp.length !== stamp.length || planDataAliasCache.stamp.some((item, index) => item !== stamp[index])) {
    const map = new Map();
    for (const layout of layouts) {
      for (const subject of planDataSubjects(layout.planData)) {
        if (subject.originalName === undefined) continue;
        const from = planDataSubjectNames(subject.originalName), to = planDataSubjectNames(subject.name);
        from.forEach((name, index) => {
          const a = normalize(name), b = to[index] ? normalize(to[index]) : "";
          if (a && b && a !== b && !map.has(a)) map.set(a, b);
        });
      }
    }
    planDataAliasCache = { stamp, map };
  }
  return planDataAliasCache.map.get(key) || null;
}

// 표의 칸 하나를 고친다. 학기 칸(학점·메모), 기준·운영학점, 필수이수학점, 추가 열, 소계 아래 행의 값.
function curriculumDataSetCell(layout, target, text) {
  const value = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  return curriculumDataEdit(layout, (data, template) => {
    if (target.footer) {
      const [row, column] = String(target.footer).split(":").map(Number);
      if (!template.footer.rows[row] || Object.hasOwn(template.footer.formulas || {}, `${row}:${column}`)) {
        throw new Error("수식 칸은 직접 고칠 수 없습니다.");
      }
      template.footer.rows[row][column] = value;
      return null;
    }
    const item = data.subjects.find((subject) => subject.id === target.id);
    if (!item || item.fixed) throw new Error("고칠 과목 행을 찾지 못했습니다.");
    const field = target.field;
    if (PLAN_DATA_FIELDS.includes(field)) {
      if (planDataGroupsOf(data, item.id).some((group) => group.fields.includes(field))) {
        throw new Error("선택과목군 칸입니다. 묶음 띠를 눌러 택 수·학점을 바꾸세요.");
      }
      delete item.credits[field];
      delete item.texts[field];
      if (!value) return null;
      if (PLAN_DATA_NOTE.test(value)) { item.note = value; return null; }
      const number = planDataNumber(value);
      if (number === null || number < 0 || number > 30) throw new Error("학기 칸에는 0~30 사이의 학점 숫자를 입력하세요.");
      item.credits[field] = number;
      return null;
    }
    if (field === "note") { item.note = value; return null; }
    if (field === "base" || field === "op") {
      if (value && planDataNumber(value) === null) throw new Error("학점은 숫자로 입력하세요.");
      item[field] = value;
      if (field === "op") item.opFormula = false;
      return null;
    }
    if (field === "required") {
      const seg = item.required?.seg || `q${item.id}`;
      for (const subject of planDataSubjects(data)) if (subject.required?.seg === seg) subject.required.text = "";
      item.required = { seg, text: value };
      return null;
    }
    if (String(field).startsWith("extra:")) {
      const column = Number(field.slice(6));
      if (value) item.extra[column] = value; else delete item.extra[column];
      return null;
    }
    throw new Error("이 칸은 직접 고칠 수 없습니다.");
  });
}

// 같은 구분 안에서 과목 행을 한 칸 위·아래로 옮긴다. 선택과목군은 행 위치를 따른다(엑셀에서 행을 옮긴 것과 같다).
function curriculumDataMoveRow(layout, id, direction) {
  return curriculumDataEdit(layout, (data) => {
    const index = planDataIndex(data, id);
    const item = data.subjects[index];
    if (!item || item.fixed) throw new Error("옮길 과목 행을 찾지 못했습니다.");
    const otherIndex = index + (direction < 0 ? -1 : 1);
    const other = data.subjects[otherIndex];
    if (!other || other.fixed || planDataKey(other.category) !== planDataKey(item.category)) {
      throw new Error(direction < 0 ? "같은 구분의 맨 위 과목입니다." : "같은 구분의 맨 아래 과목입니다.");
    }
    const spans = data.groups.map((group) => {
      const indexes = group.members.map((member) => planDataIndex(data, member));
      return { group, first: Math.min(...indexes), last: Math.max(...indexes) };
    });
    [data.subjects[index], data.subjects[otherIndex]] = [data.subjects[otherIndex], data.subjects[index]];
    for (const span of spans) {
      const before = new Set(span.group.members);
      span.group.members = data.subjects.slice(span.first, span.last + 1).filter((subject) => !subject.fixed).map((subject) => subject.id);
      // 묶음 밖으로 나간 과목은 묶음 학점을 자기 학기 학점으로 가진다.
      for (const leaving of [item, other]) {
        if (!before.has(leaving.id) || span.group.members.includes(leaving.id)) continue;
        const credit = planDataGroupCredit(data, span.group);
        for (const field of span.group.fields) if (credit > 0) leaving.credits[field] = credit;
      }
      for (const joining of [item, other]) {
        if (before.has(joining.id) || !span.group.members.includes(joining.id)) continue;
        if (joining.note) throw new Error("학기 칸 메모(소인수·공동) 과목은 선택과목군 안으로 옮길 수 없습니다.");
      }
      const names = planDataNamesCount(data, span.group.members);
      if (span.group.pick > names) throw new Error(`${planDataGroupLabel(span.group)}: 옮기면 묶음 과목이 ${names}개만 남습니다. 선택 수를 먼저 줄이세요.`);
    }
    return item;
  });
}

function planDataRemoveFromGroups(data, id) {
  for (const group of planDataGroupsOf(data, id)) {
    const rest = group.members.filter((member) => member !== id);
    const names = planDataNamesCount(data, rest);
    if (names && names < group.pick) {
      throw new Error(`${planDataGroupLabel(group)}: 남는 과목이 ${names}개입니다. 선택 수를 먼저 줄인 뒤 변경하세요.`);
    }
    group.members = rest;
  }
  data.groups = data.groups.filter((group) => group.members.length);
}

// 과목 행을 지운다. 묶음 안의 행이면 묶음 과목에서도 빠진다.
function curriculumDataDeleteRow(layout, id) {
  return curriculumDataEdit(layout, (data) => {
    const index = planDataIndex(data, id);
    if (index < 0) throw new Error("지울 과목 행을 찾지 못했습니다.");
    planDataRemoveFromGroups(data, id);
    return data.subjects.splice(index, 1)[0];
  });
}

function planDataKindText(data, kind) {
  const short = { "공통": "공통", "일반선택": "일반", "진로선택": "진로", "융합선택": "융합" }[kind] || kind || "";
  const long = planDataSubjects(data).some((item) => /선택$/.test(planDataKey(item.kindText)));
  return long ? kind : short;
}

function planDataCategoryText(data, division) {
  return planDataSubjects(data).find((item) => planDataDivision(item.category) === division)?.category || division;
}

// 새 과목 위치: 같은 구분·교과(군)의 끝, 없으면 같은 구분의 끝. 묶음 한가운데에는 넣지 않는다.
function planDataInsertIndex(data, category, area) {
  const divisionOf = (item) => planDataDivision(item.category) || planDataKey(item.category);
  const division = planDataDivision(category) || planDataKey(category);
  const sameDivision = (item) => !item.fixed && divisionOf(item) === division;
  let index = -1;
  data.subjects.forEach((item, position) => { if (sameDivision(item) && planDataKey(item.area) === planDataKey(area)) index = position; });
  if (index < 0) data.subjects.forEach((item, position) => { if (sameDivision(item)) index = position; });
  let insertion = index < 0 ? data.subjects.length : index + 1;
  if (index < 0) {
    // 같은 구분이 없으면 학교 지정 → 학생 선택 → 그 밖 순서를 지킨다.
    const order = ["학교 지정 교육과정", "학생 선택 교육과정"];
    const rank = order.indexOf(division);
    if (rank >= 0) {
      const after = data.subjects.findIndex((item) => !item.fixed && (order.indexOf(divisionOf(item)) > rank || order.indexOf(divisionOf(item)) < 0));
      if (after >= 0) insertion = after;
    }
  }
  for (let guard = 0; guard < 50; guard++) {
    const inside = data.groups.find((group) => {
      const indexes = group.members.map((member) => planDataIndex(data, member));
      return insertion > Math.min(...indexes) && insertion <= Math.max(...indexes);
    });
    if (!inside) break;
    insertion = Math.max(...inside.members.map((member) => planDataIndex(data, member))) + 1;
  }
  return insertion;
}

// 새 과목을 넣는다. before가 있으면 그 행 위에, 없으면 같은 구분·교과(군)의 끝에 넣는다.
function planDataInsert(data, spec, before = null) {
  const id = planDataNewId(data);
  let index = before ? planDataIndex(data, before) : planDataInsertIndex(data, spec.category, spec.area);
  if (index < 0) index = data.subjects.length;
  const previous = data.subjects.slice(0, index).reverse().find((item) => !item.fixed) || null;
  const following = data.subjects.slice(index).find((item) => !item.fixed) || null;
  const sameRun = (item) => item && planDataKey(item.category) === planDataKey(spec.category) && planDataKey(item.area) === planDataKey(spec.area);
  const neighbor = sameRun(previous) ? previous : sameRun(following) ? following : previous || following;
  const sharedSegment = (key, seg) => seg && planDataSubjects(data).filter((item) => item[key]?.seg === seg).length > 1;
  const inherit = (key) => sameRun(neighbor) && planDataDivision(spec.category) !== "학생 선택 교육과정" && sharedSegment(key, neighbor?.[key]?.seg)
    ? { ...neighbor[key] } : { seg: `${key[0]}${id}`, text: "" };
  const subject = {
    id, category: spec.category, domain: spec.domain ?? (neighbor && planDataKey(neighbor.category) === planDataKey(spec.category) ? neighbor.domain : ""),
    area: spec.area, kindText: spec.kindText ?? planDataKindText(data, spec.kind), kind: spec.kind || "", kindJoin: false,
    name: spec.name, base: planDataNumberText(spec.base ?? spec.op), op: planDataNumberText(spec.op ?? spec.base),
    opFormula: Boolean(neighbor?.opFormula && !spec.note),
    credits: { ...(spec.credits || {}) }, texts: {}, cross: null, note: spec.note || "",
    completion: inherit("completion"), required: inherit("required"), extra: {},
    span: 1, semMerge: false, fills: [{}], heights: [neighbor?.heights?.[0] ?? null], hidden: false,
    styleRows: [neighbor?.styleRows?.[0] ?? null], added: true
  };
  data.subjects.splice(index, 0, subject);
  return subject;
}

// 행 메뉴의 '위에 과목 추가'와 과목 추가 팝업이 함께 쓴다.
function curriculumDataInsertSubject(layout, spec, before = null) {
  return curriculumDataEdit(layout, (data) => planDataInsert(data, spec, before));
}

function planDataOfficialDetail(name) {
  if (typeof curriculumOfficialDetail === "function") return curriculumOfficialDetail(name);
  const official = typeof findCurriculumOfficialSubject === "function" ? findCurriculumOfficialSubject(name) : null;
  return official?.type || "";
}

// 과목명 팝업(이동·맞교체·삭제)에 쓰는 과목 목록.
function curriculumDataCatalog(layout) {
  const entries = curriculumDataPlanEntries(layout).entries;
  const catalog = new Map();
  for (const subject of planDataSubjects(layout.planData)) {
    for (const name of planDataSubjectNames(subject.name)) {
      const key = planDataNameKey(name);
      let item = catalog.get(key);
      if (!item) {
        item = { subject: name, ids: [], contexts: [], placements: [], detail: subject.kind || planDataOfficialDetail(name),
          division: planDataDivision(subject.category) || "학생 선택 교육과정", area: subject.area,
          baseCredit: planDataNumber(subject.base) || 0 };
        catalog.set(key, item);
      }
      item.ids.push(subject.id);
      for (const entry of entries) {
        if (entry.rowIndex !== subject.row || planDataNameKey(entry.subject) !== key) continue;
        if (item.placements.some((placement) => placement.grade === entry.grade && placement.semester === entry.semester)) continue;
        item.placements.push({ grade: entry.grade, semester: entry.semester, credit: entry.credit });
      }
    }
  }
  return [...catalog.values()];
}

function planDataFindName(data, name) {
  const key = planDataNameKey(name);
  return planDataSubjects(data).find((item) => planDataSubjectNames(item.name).some((part) => planDataNameKey(part) === key)) || null;
}

function planDataNameParts(name) {
  return String(name ?? "").split(/[,，、]/).filter((part) => planDataSubjectNames(part).length);
}

// 한 칸에 여러 과목이 적힌 행에서 과목 하나만 바꿀 때는 그 과목을 바로 아래 자기 행으로 떼어 낸다.
function planDataIsolate(data, name) {
  const subject = planDataFindName(data, name);
  if (!subject) throw new Error(`${name}: 편제표에서 과목을 찾지 못했습니다.`);
  const parts = planDataNameParts(subject.name);
  if (parts.length <= 1) return subject;
  const key = planDataNameKey(name);
  const own = parts.find((part) => planDataNameKey(planDataSubjectNames(part)[0]) === key);
  subject.name = parts.filter((part) => part !== own).map((part) => part.trim()).join(", ");
  const copy = planDataClone(subject);
  copy.id = planDataNewId(data);
  copy.name = String(own).trim();
  Object.assign(copy, { span: 1, semMerge: false, kindJoin: false, fills: [subject.fills?.[0] || {}],
    heights: [subject.heights?.[0] ?? null], styleRows: [subject.styleRows?.[0] ?? null], added: true });
  data.subjects.splice(planDataIndex(data, subject.id) + 1, 0, copy);
  for (const group of planDataGroupsOf(data, subject.id)) if (!group.members.includes(copy.id)) group.members.push(copy.id);
  return copy;
}

function planDataClearPlacement(item) {
  item.credits = {};
  item.texts = {};
  item.cross = null;
  item.note = "";
}

// 묶음 안의 과목을 묶음 밖(묶음 바로 아래)으로 옮긴다.
function planDataLeaveGroups(data, item) {
  const groups = planDataGroupsOf(data, item.id);
  if (!groups.length) return;
  const last = Math.max(...groups.flatMap((group) => group.members.map((member) => planDataIndex(data, member))));
  planDataRemoveFromGroups(data, item.id);
  data.subjects.splice(planDataIndex(data, item.id), 1);
  data.subjects.splice(last, 0, item);
}

function planDataReposition(data, item) {
  data.subjects.splice(planDataIndex(data, item.id), 1);
  data.subjects.splice(planDataInsertIndex(data, item.category, item.area), 0, item);
}

function planDataPlacement(item, data) {
  return { credits: { ...item.credits }, texts: { ...item.texts }, cross: item.cross ? [...item.cross] : null, note: item.note,
    groups: planDataGroupsOf(data, item.id) };
}

// 과목명 팝업의 이동·맞교체·삭제·구분 변경·교차집중과 '과목 추가'를 데이터로 처리한다.
function buildCurriculumDataSubjectChange(layout, plan, options) {
  const action = options.action;
  if (!["add", "move", "swap", "delete", "division", "cross-add", "cross-remove"].includes(action)) {
    throw new Error("추가·이동·맞교체·삭제·구분 변경 중 작업을 선택하세요.");
  }
  const catalog = curriculumDataCatalog(layout);
  const findItem = (name) => catalog.find((item) => planDataNameKey(item.subject) === planDataNameKey(name));
  const official = action === "add" && typeof findCurriculumOfficialSubject === "function" ? findCurriculumOfficialSubject(options.subject) : null;
  if (action === "add" && !official) throw new Error("2022 개정 교육과정 과목 목록에서 과목을 선택하세요.");
  if (action === "add" && findItem(official.name)) throw new Error("이미 편성된 과목입니다. 기존 과목명을 눌러 편성을 변경하세요.");
  const source = action === "add" ? null : findItem(options.subject);
  if (action !== "add" && !source) throw new Error("선택한 과목이 편제표에 없습니다. 화면을 새로 확인하세요.");
  const placementNeeded = action === "add" || action === "move";
  if (placementNeeded && (!["1", "2", "3"].includes(String(options.grade)) || !["1", "2"].includes(String(options.semester)) ||
      !Number.isFinite(options.credit) || options.credit <= 0)) {
    throw new Error("편성할 학년·학기와 0보다 큰 학점을 입력하세요.");
  }
  const division = options.division || source?.division || "학생 선택 교육과정";
  if (["add", "move", "division"].includes(action) && !["학생 선택 교육과정", "학교 지정 교육과정"].includes(division)) {
    throw new Error("학생선택 또는 학교지정 교육과정을 선택하세요.");
  }
  if (action === "division" && division === source.division) throw new Error("현재와 다른 편성 구분을 선택하세요.");
  if (action === "division" && !source.placements.length) throw new Error("기존 학년·학기 편성을 확인한 뒤 구분을 변경하세요.");
  const field = placementNeeded ? `sem${options.grade}${options.semester}` : "";
  const { layout: next } = curriculumDataEdit(layout, (data) => {
    if (action === "add") {
      const before = options.before && planDataIndex(data, options.before) >= 0 ? options.before : null;
      const beforeItem = before ? data.subjects.find((item) => item.id === before) : null;
      const category = beforeItem && planDataDivision(beforeItem.category) === division ? beforeItem.category : planDataCategoryText(data, division);
      const areaText = planDataSubjects(data).find((item) => planDataKey(item.area) === planDataKey(official.area))?.area || official.area;
      planDataInsert(data, { category, area: areaText, kind: planDataOfficialDetail(official.name) || "", name: official.name,
        base: options.credit, op: options.credit, credits: { [field]: options.credit } }, before);
      return;
    }
    if (action === "delete") {
      const subject = planDataFindName(data, source.subject);
      const parts = planDataNameParts(subject.name);
      if (parts.length > 1) {
        subject.name = parts.filter((part) => planDataNameKey(planDataSubjectNames(part)[0]) !== planDataNameKey(source.subject))
          .map((part) => part.trim()).join(", ");
        for (const group of planDataGroupsOf(data, subject.id)) {
          const names = planDataNamesCount(data, group.members);
          if (names < group.pick) throw new Error(`${planDataGroupLabel(group)}: 남는 과목이 ${names}개입니다. 선택 수를 먼저 줄인 뒤 변경하세요.`);
        }
      } else {
        planDataRemoveFromGroups(data, subject.id);
        data.subjects.splice(planDataIndex(data, subject.id), 1);
      }
      return;
    }
    if (action === "cross-add" || action === "cross-remove") {
      const subject = planDataFindName(data, source.subject);
      const fields = [`sem${options.grade}1`, `sem${options.grade}2`];
      if (action === "cross-remove") {
        if (!subject.cross?.length && !String(subject.name).includes("↔")) throw new Error("제거할 교차집중 표시가 없습니다.");
        subject.cross = null;
        subject.name = String(subject.name).replace(/↔/g, "").trim();
        return;
      }
      if (subject.cross?.length) throw new Error("이미 교차집중으로 편성되어 있습니다.");
      if (planDataGroupsOf(data, subject.id).some((group) => group.fields.some((item) => fields.includes(item)))) {
        throw new Error("택n 묶음 안의 과목은 묶음을 해제한 뒤 교차집중을 지정하세요.");
      }
      if (!fields.every((item) => subject.credits[item] > 0)) {
        throw new Error("1·2학기에 각각 학점이 하나씩 편성되어 있어야 합니다. 먼저 학기·학점을 확인하세요.");
      }
      subject.cross = fields;
      return;
    }
    if (action === "move" || action === "division") {
      const subject = planDataIsolate(data, source.subject);
      const categoryChanged = division !== (planDataDivision(subject.category) || "학생 선택 교육과정");
      if (action === "move") {
        planDataLeaveGroups(data, subject);
        planDataClearPlacement(subject);
        subject.credits[field] = options.credit;
        subject.opFormula = false;
        subject.op = planDataNumberText(options.credit);
      }
      if (categoryChanged) {
        if (action === "division") planDataLeaveGroups(data, subject);
        subject.category = planDataCategoryText(data, division);
        subject.completion = { seg: `c${subject.id}`, text: "" };
        subject.required = { seg: `q${subject.id}`, text: "" };
        subject.kindJoin = false;
        planDataReposition(data, subject);
      }
      return;
    }
    const target = findItem(options.targetSubject);
    if (!target || target === source) throw new Error("맞교체할 다른 과목을 자동완성 목록에서 선택하세요.");
    if (!source.placements.length || !target.placements.length) throw new Error("두 과목 모두 학년·학기가 편성되어 있어야 맞교체할 수 있습니다.");
    const a = planDataIsolate(data, source.subject);
    const b = planDataIsolate(data, target.subject);
    const pa = planDataPlacement(a, data), pb = planDataPlacement(b, data);
    for (const [item, placement] of [[a, pb], [b, pa]]) {
      Object.assign(item, { credits: placement.credits, texts: placement.texts, cross: placement.cross, note: placement.note, opFormula: false });
    }
    if (pa.groups.length || pb.groups.length) {
      const ia = planDataIndex(data, a.id), ib = planDataIndex(data, b.id);
      [data.subjects[ia], data.subjects[ib]] = [data.subjects[ib], data.subjects[ia]];
      for (const group of data.groups) group.members = group.members.map((id) => id === a.id ? b.id : id === b.id ? a.id : id);
    }
  });
  const nextPlan = typeof curriculumPlanFromLayout === "function"
    ? curriculumPlanFromLayout(next, `${next.sheetName || ""}`, plan) : plan;
  return { layout: next, plan: nextPlan };
}
