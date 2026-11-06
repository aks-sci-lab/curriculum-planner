"use strict";
// 편제표의 '택n' 묶음: 학기 칸의 '택n' 아래 학점 칸 n개가 하나의 선택 그룹이다.
// 묶음 이수학점은 n × 학점이며, 묶음 범위(이수학점 병합 범위 또는 이어진 학점 칸)의 과목이 그룹 구성 과목이다.

function curriculumChoiceNumber(value) {
  const text = String(value ?? "").replace(/\s+/g, "");
  return /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : 0;
}

function curriculumChoiceSubjectKey(name) {
  return String(name ?? "").replace(/↔/g, " ").replace(/^[*＊★☆■\s]+|[*＊★☆■\s]+$/g, "").replace(/\s+/g, "").toLowerCase();
}

function curriculumChoiceRange(reference) {
  const [startRef, endRef = startRef] = String(reference).split(":");
  const range = {
    startColumn: columnIndex(startRef), endColumn: columnIndex(endRef),
    startRow: Number(startRef.match(/\d+/)?.[0]) - 1, endRow: Number(endRef.match(/\d+/)?.[0]) - 1
  };
  return Object.values(range).every(Number.isInteger) ? range : null;
}

function curriculumSheetMerges(layout) {
  const saved = layout.sheetMerges || [];
  const savedReferences = new Set(saved.map((merge) => merge.reference));
  const result = saved.map((merge) => ({ ...merge, ...curriculumChoiceRange(merge.reference) }));
  for (const reference of layout.mergedRanges || []) {
    if (savedReferences.has(reference)) continue;
    const range = curriculumChoiceRange(reference);
    if (!range) continue;
    const label = String(layout.rows[range.startRow]?.[range.startColumn] || "");
    const match = label.match(/^(선택과목군|교차집중과목군)\s*택(\d+)\s*[·×]\s*(\d+(?:\.\d+)?)학점$/);
    if (match) result.push({ reference, ...range, kind: match[1] === "교차집중과목군" ? "cross" : "choice",
      pick: Number(match[2]), credit: Number(match[3]) });
  }
  return result;
}

function curriculumFirstCourseRow(layout, columns) {
  const rows = importedPlanCourseContexts(layout, columns).map((context) => context.rowIndex);
  return rows.length ? Math.min(...rows) : Infinity;
}

function curriculumSheetMergeLabel(merge) {
  return merge.kind === "plain" ? null :
    `${merge.kind === "cross" ? "교차집중과목군" : "선택과목군"} 택${merge.pick} · ${merge.credit}학점`;
}

function mergeCurriculumSheetCells(layout, selection, values = {}) {
  const { startRow, endRow, column } = selection;
  const endColumn = selection.endColumn ?? column;
  if (![startRow, endRow, column, endColumn].every(Number.isInteger) || startRow < 0 ||
      endRow >= layout.rows.length || column < 0 || endColumn < column || endRow < startRow ||
      endColumn >= Math.max(...layout.rows.map((row) => row.length)) ||
      (startRow === endRow && column === endColumn)) throw new Error("병합할 셀을 두 개 이상 선택하세요.");
  const columns = importedPlanColumnMap(layout);
  // 머리글(학년·학기 제목) 행의 병합은 글자를 그대로 두는 일반 병합이다. 선택과목군으로 바꾸면 제목이 학점 칸으로 바뀐다.
  const inHeader = startRow < curriculumFirstCourseRow(layout, columns);
  const semesters = inHeader ? [] : columns.semesters.filter((c) => c >= column && c <= endColumn);
  let kind = "plain";
  if (semesters.length) {
    const index = columns.semesters.indexOf(column);
    if (index < 0 || semesters.length !== endColumn - column + 1 ||
        (endColumn !== column && (index % 2 !== 0 || endColumn !== column + 1 ||
          columns.semesters[index + 1] !== endColumn))) {
      throw new Error("학기 병합은 같은 학기 한 열 또는 같은 학년 1·2학기 두 열만 선택하세요.");
    }
    kind = endColumn === column ? "choice" : "cross";
    for (let row = startRow; row <= endRow; row++) {
      if (/소계|합계|총이수|창의적체험|필수이수|과목명|세부과목/.test(
        (layout.rows[row] || []).slice(0, columns.subject + 1).join("").replace(/\s/g, ""))) {
        throw new Error("머리글·소계·합계·창체는 과목군으로 병합할 수 없습니다.");
      }
    }
    const names = new Set(importedPlanCourseContexts(layout, columns).filter((context) =>
      context.rowIndex >= startRow && context.rowIndex <= endRow).flatMap((context) => curriculumSubjectNames(context.subject)));
    if (!names.size) throw new Error("과목이 있는 행을 선택하세요.");
    const pick = Number(values.pick), credit = Number(values.credit);
    if (!Number.isInteger(pick) || pick < 1 || pick > names.size) throw new Error(`선택 수는 1~${names.size} 범위로 입력하세요.`);
    if (!Number.isFinite(credit) || credit <= 0 || credit > 30) throw new Error("학점은 0보다 크고 30 이하로 입력하세요.");
  }
  const overlaps = (layout.mergedRanges || []).filter((reference) => {
    const r = curriculumChoiceRange(reference);
    return r && r.startColumn <= endColumn && r.endColumn >= column && r.startRow <= endRow && r.endRow >= startRow;
  });
  for (const reference of overlaps) {
    const r = curriculumChoiceRange(reference);
    if (r.startRow < startRow || r.endRow > endRow || r.startColumn < column || r.endColumn > endColumn) {
      throw new Error("기존 병합 셀 전체를 포함해 선택하세요.");
    }
  }
  const oldBlocks = curriculumChoiceBlocks(layout).filter((block) => block.column >= column && block.column <= endColumn &&
    block.startRow <= endRow && block.endRow >= startRow);
  if (oldBlocks.some((block) => block.startRow < startRow || block.endRow > endRow)) throw new Error("기존 선택과목군 전체를 포함해 선택하세요.");
  const reference = `${columnName(column)}${startRow + 1}:${columnName(endColumn)}${endRow + 1}`;
  const next = JSON.parse(JSON.stringify(layout));
  next.mergedRanges = (next.mergedRanges || []).filter((r) => !overlaps.includes(r));
  next.sheetMerges = curriculumSheetMerges(layout).filter((merge) => !overlaps.includes(merge.reference))
    .map(({ reference, kind, pick, credit }) => ({ reference, kind, pick, credit }));
  next.sheetMerges.push({ reference, kind, ...(kind === "plain" ? {} : { pick: Number(values.pick), credit: Number(values.credit) }) });
  next.mergedRanges.push(reference);
  next.choiceBlockRanges = curriculumChoiceBlocks(layout).filter((block) => !oldBlocks.some((old) => old.key === block.key) && !block.sheetMerge)
    .map((block) => ({ column: block.column, startRow: block.startRow, endRow: block.endRow }));
  recalculatePlanFormulas(next);
  if (curriculumCompletionColumn(next) >= 0) syncCurriculumChoiceCompletion(next, [{ startRow, endRow }]);
  return next;
}

function unmergeCurriculumSheetCells(layout, selection) {
  const endColumn = selection.endColumn ?? selection.column;
  const selected = (layout.mergedRanges || []).filter((reference) => {
    const r = curriculumChoiceRange(reference);
    return r && r.startColumn <= endColumn && r.endColumn >= selection.column &&
      r.startRow <= selection.endRow && r.endRow >= selection.startRow;
  });
  if (!selected.length) throw new Error("해제할 병합 셀을 선택하세요.");
  const next = JSON.parse(JSON.stringify(layout));
  next.mergedRanges = next.mergedRanges.filter((reference) => !selected.includes(reference));
  next.sheetMerges = curriculumSheetMerges(layout).filter((merge) => !selected.includes(merge.reference))
    .map(({ reference, kind, pick, credit }) => ({ reference, kind, pick, credit }));
  recalculatePlanFormulas(next);
  if (curriculumCompletionColumn(next) >= 0) syncCurriculumChoiceCompletion(next, selected.map(curriculumChoiceRange));
  return next;
}

function insertCurriculumSheetCells(layout, selection) {
  const { startRow, endRow, column } = selection, endColumn = selection.endColumn ?? column;
  if (![startRow, endRow, column, endColumn].every(Number.isInteger) || startRow < 0 || endRow < startRow ||
      endRow >= layout.rows.length || column < 0 || endColumn < column ||
      endColumn >= Math.max(...layout.rows.map((row) => row.length))) throw new Error("삽입할 셀 범위를 선택하세요.");
  const header = layout.rows.findIndex((row) => row.some((value) => /과목명|세부과목/.test(String(value))));
  const firstCourse = importedPlanCourseContexts(layout).find((context) => curriculumSubjectNames(context.subject).length)?.rowIndex;
  if (startRow <= header || firstCourse === undefined || startRow < firstCourse) throw new Error("머리글 아래의 과목 영역에서 셀을 삽입하세요.");
  const amount = endRow - startRow + 1;
  const ranges = (layout.mergedRanges || []).map(curriculumChoiceRange).filter(Boolean);
  if (ranges.some((r) => r.endRow >= startRow && r.startColumn <= endColumn && r.endColumn >= column &&
      (r.startColumn < column || r.endColumn > endColumn || r.startRow < startRow))) {
    throw new Error("삽입으로 기존 병합이 나뉩니다. 병합 전체 열을 선택하거나 먼저 병합을 해제하세요.");
  }
  const next = JSON.parse(JSON.stringify(layout)), oldLength = layout.rows.length;
  const refShift = (formula) => formula.split(/("(?:[^"]|"")*")/).map((part) => part.startsWith('"') ? part :
    part.replace(/(\$?[A-Z]+\$?)(\d+)/g, (ref, letters, digits) => {
      const c = columnIndex(letters.replace(/\$/g, ""));
      return c >= column && c <= endColumn && Number(digits) > startRow ? `${letters}${Number(digits) + amount}` : ref;
    })).join("");
  for (let i = 0; i < amount; i++) next.rows.push(Array(Math.max(...layout.rows.map((r) => r.length))).fill(""));
  next.mergedRanges = (next.mergedRanges || []).map(refShift);
  next.sheetMerges = curriculumSheetMerges(layout).map(({ reference, kind, pick, credit }) =>
    ({ reference: refShift(reference), kind, pick, credit }));
  next.choiceBlockRanges = (next.choiceBlockRanges || []).map((r) => r.column >= column && r.column <= endColumn
    ? { ...r, startRow: r.startRow >= startRow ? r.startRow + amount : r.startRow,
      endRow: r.endRow >= startRow ? r.endRow + amount : r.endRow } : r);
  next.formulas = {};
  next.cellFills = {};
  next.formulaEdits = {};
  for (const [key, formula] of Object.entries(layout.formulas || {})) {
    const [r, c] = key.split(":").map(Number);
    const newKey = `${r >= startRow && c >= column && c <= endColumn ? r + amount : r}:${c}`;
    next.formulas[newKey] = refShift(formula);
    next.formulaEdits[newKey] = true;
  }
  for (const [key, fill] of Object.entries(layout.cellFills || {})) {
    const [r, c] = key.split(":").map(Number);
    next.cellFills[`${r >= startRow && c >= column && c <= endColumn ? r + amount : r}:${c}`] = fill;
  }
  next.sheetCellEdits ||= {};
  for (let r = next.rows.length - 1; r >= startRow; r--) for (let c = column; c <= endColumn; c++) {
    next.rows[r][c] = r >= startRow + amount && r - amount < oldLength ? String(layout.rows[r - amount]?.[c] ?? "") : "";
    next.sheetCellEdits[`${r}:${c}`] = true;
  }
  recalculatePlanFormulas(next);
  return next;
}

function curriculumCompletionColumn(layout) {
  const compact = (value) => String(value ?? "").replace(/\s+/g, "");
  for (const row of (layout?.rows || []).slice(0, 12)) {
    const column = (row || []).findIndex((value) => compact(value) === "이수학점");
    if (column >= 0) return column;
  }
  return -1;
}

// 원본 행 번호는 수식·엑셀 복원을 위해 유지하고, 과목 삭제로 비워진 행만 접는다.
function curriculumEmptySubjectRows(layout) {
  if (!layout?.rows?.length || layout.planData) return [];
  const columns = importedPlanColumnMap(layout);
  if (columns.subject < 0) return [];
  const covered = importedPlanCoveredCells(layout);
  const contexts = importedPlanCourseContexts(layout, columns);
  const courses = contexts.filter((context) => curriculumSubjectNames(context.subject).length);
  const first = Math.min(...courses.map((context) => context.rowIndex));
  const header = layout.rows.findIndex((row) => row.some((value) => /과목명|세부과목/.test(String(value))));
  const last = Math.max(...courses.map((context) => context.rowIndex));
  const boundary = contexts.find((context) => context.rowIndex > Math.max(header, last) &&
    /소계|합계|총이수|창의적체험/.test(context.subject))?.rowIndex ?? (courses.length ? last + 1 : header + 1);
  const retired = new Set(layout.retiredSubjectRows || []);
  const classification = new Set([columns.grade, columns.division, columns.area, columns.detail,
    ...contexts.map((context) => context.typeColumn)].filter((column) => column >= 0));
  for (let row = Math.max(header + 1, 0); row < boundary; row++) {
    const values = layout.rows[row] || [];
    if (String(values[columns.subject] || "").trim() || covered.has(`${row}:${columns.subject}`)) continue;
    // 숫자 보조 행·교차집중의 아래 행은 앞쪽에 자기 분류가 없으므로 제외한다.
    const ownClassification = [...classification].some((column) => !covered.has(`${row}:${column}`) &&
      String(values[column] || "").trim());
    if (!ownClassification || (row < first && header < 0)) continue;
    if (values.some((value, column) => !classification.has(column) && column !== columns.subject &&
      String(value || "").trim() && !/^(?:\d+(?:\.\d+)?|택\s*\d+)$/.test(String(value).trim()))) continue;
    retired.add(row);
  }
  return [...retired].filter((row) => Number.isInteger(row) && row >= 0 && row < layout.rows.length &&
    !String(layout.rows[row]?.[columns.subject] || "").trim()).sort((a, b) => a - b);
}

function curriculumChoiceTag(value) {
  const match = String(value ?? "").trim().match(/^택\s*(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function curriculumChoiceBlocks(layout, columns) {
  // 데이터로 바꾼 편제표는 선택과목군 데이터에서 묶음을 만든다.
  if (layout?.planData && typeof curriculumDataChoiceBlocks === "function") return curriculumDataChoiceBlocks(layout);
  columns ||= importedPlanColumnMap(layout);
  if (!layout?.rows?.length || columns.subject < 0) return [];
  const rows = layout.rows;
  const ranges = (layout.mergedRanges || []).map(curriculumChoiceRange).filter(Boolean);
  const completion = curriculumCompletionColumn(layout);
  const covered = new Set();
  for (const range of ranges) {
    for (let row = range.startRow; row <= range.endRow; row++) {
      for (let column = range.startColumn; column <= range.endColumn; column++) {
        if (row !== range.startRow || column !== range.startColumn) covered.add(`${row}:${column}`);
      }
    }
  }
  const contexts = importedPlanCourseContexts(layout, columns);
  const stopRow = (rowIndex) => {
    const text = (rows[rowIndex] || []).slice(0, Math.max(columns.subject + 1, 1)).join(" ").replace(/\s+/g, "");
    return /소계|합계|총이수|창의적체험|필수이수/.test(text);
  };
  const hasTagAt = (rowIndex) => columns.semesters.some((column) => column >= 0 && curriculumChoiceTag(rows[rowIndex]?.[column]));
  const blocks = [];
  const sheetMerges = curriculumSheetMerges(layout).filter((merge) => merge.kind !== "plain");
  columns.semesters.forEach((column, semesterIndex) => {
    if (column < 0) return;
    for (let start = 0; start < rows.length; start++) {
      const pick = curriculumChoiceTag(rows[start]?.[column]);
      if (sheetMerges.some((merge) => column >= merge.startColumn && column <= merge.endColumn &&
        start >= merge.startRow && start <= merge.endRow)) continue;
      if (!pick || covered.has(`${start}:${column}`)) continue;
      const selectedRange = layout.choiceBlockRanges?.find((range) => range.column === column && range.startRow === start);
      const completionRange = completion >= 0
        ? ranges.find((range) => range.startColumn === completion && range.startRow <= start && range.endRow > start)
        : null;
      let end = start;
      if (selectedRange) {
        end = selectedRange.endRow;
      } else if (completionRange) {
        while (end + 1 <= completionRange.endRow && !hasTagAt(end + 1) && !stopRow(end + 1)) end++;
      } else {
        while (end + 1 < rows.length && !hasTagAt(end + 1) && !stopRow(end + 1) &&
          (curriculumChoiceNumber(rows[end + 1]?.[column]) > 0 || covered.has(`${end + 1}:${column}`))) end++;
      }
      const creditCells = [];
      for (let row = start + 1; row <= end; row++) {
        if (!covered.has(`${row}:${column}`)) creditCells.push(row);
      }
      const credit = creditCells.map((row) => curriculumChoiceNumber(rows[row]?.[column])).find((value) => value > 0) || 0;
      const subjects = [...new Set(contexts.filter((context) => context.rowIndex >= start && context.rowIndex <= end)
        .flatMap((context) => curriculumSubjectNames(context.subject)))];
      const blocksInCompletion = completionRange
        ? Array.from({ length: completionRange.endRow - completionRange.startRow + 1 }, (_, offset) => completionRange.startRow + offset)
          .filter((row) => hasTagAt(row)).length
        : 0;
      blocks.push({
        key: `${CURRICULUM_SEMESTER_FIELDS[semesterIndex]}:${start}`,
        field: CURRICULUM_SEMESTER_FIELDS[semesterIndex],
        grade: String(Math.floor(semesterIndex / 2) + 1),
        semester: String(semesterIndex % 2 + 1),
        column, startRow: start, endRow: end, pick, credit,
        total: pick * credit,
        creditCells,
        subjects,
        completion: completionRange && blocksInCompletion === 1
          ? { row: completionRange.startRow, column: completion, formula: Boolean(layout.formulas?.[`${completionRange.startRow}:${completion}`]) }
          : null
      });
    }
  });
  for (const merge of sheetMerges) {
    for (let column = merge.startColumn; column <= merge.endColumn; column++) {
      const index = columns.semesters.indexOf(column);
      if (index < 0) continue;
      blocks.push({
        key: `${CURRICULUM_SEMESTER_FIELDS[index]}:${merge.startRow}`,
        field: CURRICULUM_SEMESTER_FIELDS[index], grade: String(Math.floor(index / 2) + 1),
        semester: String(index % 2 + 1), column, startRow: merge.startRow, endRow: merge.endRow,
        pick: merge.pick, credit: merge.credit, total: merge.pick * merge.credit, creditCells: [],
        sheetMerge: merge.reference, crossed: merge.kind === "cross", completion: null,
        subjects: [...new Set(contexts.filter((context) => context.rowIndex >= merge.startRow &&
          context.rowIndex <= merge.endRow).flatMap((context) => curriculumSubjectNames(context.subject)))]
      });
    }
  }
  const counts = new Map();
  for (const block of blocks) counts.set(`${block.field}:${block.pick}`, (counts.get(`${block.field}:${block.pick}`) || 0) + 1);
  const ordinals = new Map();
  for (const block of blocks.sort((a, b) => a.startRow - b.startRow || a.column - b.column)) {
    const base = `${block.grade}-${block.semester} 택${block.pick}`;
    const scope = `${block.field}:${block.pick}`;
    const order = (ordinals.get(scope) || 0) + 1;
    ordinals.set(scope, order);
    block.name = block.crossed ? `${block.grade}학년 교차집중 ${block.sheetMerge}` : counts.get(scope) > 1 ? `${base}-${order}` : base;
  }
  return blocks;
}

// 병합 셀처럼 묶음 전체를 편집한다. 원본 엑셀 형식(택n + 아래 학점 칸 n개)으로 다시 쓴다.
function applyCurriculumChoiceBlockEdit(layout, key, values = {}) {
  const pick = Number(String(values.pick ?? "").trim());
  const credit = Number(String(values.credit ?? "").trim());
  const block = curriculumChoiceBlocks(layout).find((item) => item.key === key);
  if (!block) throw new Error("편집할 택n 묶음을 찾지 못했습니다. 화면을 새로 고친 뒤 다시 시도하세요.");
  if (!Number.isInteger(pick) || pick < 1 || pick > 30) throw new Error("선택 수(택n)는 1 이상의 정수로 입력하세요.");
  if (!Number.isFinite(credit) || credit <= 0 || credit > 30) throw new Error("학점은 0보다 큰 숫자로 입력하세요.");
  if (block.sheetMerge) {
    if (pick > block.subjects.length) throw new Error(`묶음 과목이 ${block.subjects.length}개이므로 택${pick}을 지정할 수 없습니다.`);
    layout.sheetMerges = curriculumSheetMerges(layout).map(({ reference, kind, pick: oldPick, credit: oldCredit }) =>
      ({ reference, kind, pick: reference === block.sheetMerge ? pick : oldPick,
        credit: reference === block.sheetMerge ? credit : oldCredit }));
    recalculatePlanFormulas(layout);
    if (curriculumCompletionColumn(layout) >= 0) syncCurriculumChoiceCompletion(layout);
    return curriculumChoiceBlocks(layout).find((item) => item.key === key);
  }
  if (pick > block.creditCells.length) {
    throw new Error(`택${pick}에는 학점 칸 ${pick}개가 필요하지만 이 묶음에는 ${block.creditCells.length}칸뿐입니다. 묶음 안에 행을 추가한 뒤 다시 시도하세요.`);
  }
  if (block.subjects.length && pick > block.subjects.length) {
    throw new Error(`묶음 과목이 ${block.subjects.length}개이므로 택${pick}을 지정할 수 없습니다.`);
  }
  const write = (row, column, value) => {
    layout.rows[row] ||= [];
    layout.rows[row][column] = value;
    if (layout.formulas) delete layout.formulas[`${row}:${column}`];
  };
  write(block.startRow, block.column, `택${pick}`);
  block.creditCells.forEach((row, index) => write(row, block.column, index < pick ? String(credit) : ""));
  if (block.completion && !block.completion.formula) write(block.completion.row, block.completion.column, String(pick * credit));
  recalculatePlanFormulas(layout);
  if (curriculumCompletionColumn(layout) >= 0) syncCurriculumChoiceCompletion(layout);
  return curriculumChoiceBlocks(layout).find((item) => item.key === key) || { ...block, pick, credit, total: pick * credit };
}

function syncCurriculumChoiceCompletion(layout, changedRanges = []) {
  const column = curriculumCompletionColumn(layout);
  if (column < 0) throw new Error("오른쪽 이수학점 열을 찾지 못했습니다.");
  const columns = importedPlanColumnMap(layout);
  const blocks = curriculumChoiceBlocks(layout, columns);
  const ranges = (layout.mergedRanges || []).map(curriculumChoiceRange).filter(Boolean);
  const owners = new Map();
  for (const range of [...blocks, ...(layout.choiceBlockRanges || []), ...changedRanges]) {
    for (let row = range.startRow; row <= range.endRow; row++) {
      const merged = ranges.find((item) => item.startColumn === column && item.endColumn === column &&
        item.startRow <= row && item.endRow >= row);
      owners.set(merged?.startRow ?? row, merged?.endRow ?? row);
    }
  }
  layout.formulas ||= {};
  for (const [start, end] of owners) {
    if (!layout.choiceBlockRanges && layout.formulas[`${start}:${column}`]) continue;
    const terms = [];
    for (const block of blocks) {
      if (block.startRow < start || block.startRow > end) continue;
      if (block.sheetMerge) { terms.push(String(block.total)); continue; }
      terms.push(...block.creditCells.map((row) => `${columnName(block.column)}${row + 1}`));
    }
    for (let row = start; row <= end; row++) {
      for (const semester of columns.semesters.filter((item) => item >= 0)) {
        if (blocks.some((block) => block.column === semester && row >= block.startRow && row <= block.endRow)) continue;
        if (curriculumChoiceNumber(layout.rows[row]?.[semester])) terms.push(`${columnName(semester)}${row + 1}`);
      }
    }
    layout.formulas[`${start}:${column}`] = terms.length ? `SUM(${terms.join(",")})` : "0";
    (layout.formulaEdits ||= {})[`${start}:${column}`] = true;
  }
  recalculatePlanFormulas(layout);
}

function mergeCurriculumChoiceCells(layout, selection, values) {
  const { column, startRow, endRow } = selection;
  const columns = importedPlanColumnMap(layout);
  if (![column, startRow, endRow].every(Number.isInteger) || !columns.semesters.includes(column) ||
      startRow < 0 || endRow >= layout.rows.length || endRow <= startRow) {
    throw new Error("같은 학기의 연속된 셀을 2개 이상 선택하세요.");
  }
  const pick = Number(String(values.pick ?? "").trim());
  const credit = Number(String(values.credit ?? "").trim());
  if (!Number.isInteger(pick) || pick < 1 || pick > 30 || pick > endRow - startRow) {
    throw new Error("선택 수는 1~30의 정수이며, 선택 범위에 택n 칸과 n개의 학점 칸이 필요합니다.");
  }
  if (!Number.isFinite(credit) || credit <= 0 || credit > 30) throw new Error("학점은 0보다 크고 30 이하인 숫자로 입력하세요.");
  const contexts = importedPlanCourseContexts(layout, columns);
  const courseRows = new Set(contexts.map((context) => context.rowIndex));
  for (let row = startRow; row <= endRow; row++) {
    const text = (layout.rows[row] || []).slice(0, columns.subject + 1).join("").replace(/\s+/g, "");
    if (/소계|합계|총이수|창의적체험|필수이수/.test(text)) throw new Error("소계·합계·창체 행은 병합할 수 없습니다.");
  }
  if (!courseRows.has(startRow) || ![...courseRows].some((row) => row >= startRow && row <= endRow)) {
    throw new Error("과목이 있는 행부터 선택하세요.");
  }
  const merged = (layout.mergedRanges || []).map((reference) => ({ reference, ...curriculumChoiceRange(reference) }))
    .filter((range) => range.startColumn <= column && range.endColumn >= column &&
      range.startRow <= endRow && range.endRow >= startRow);
  if (merged.some((range) => range.startColumn !== column || range.endColumn !== column)) {
    throw new Error("여러 학기에 걸친 병합은 먼저 교차집중을 해제한 뒤 선택하세요.");
  }
  if (merged.some((range) => range.startRow < startRow || range.endRow > endRow)) {
    throw new Error("원본 병합 셀의 일부만 선택했습니다. 병합 범위 전체를 포함해 선택하세요.");
  }
  if (curriculumCompletionColumn(layout) < 0) throw new Error("오른쪽 이수학점 열을 찾지 못했습니다.");
  const blocks = curriculumChoiceBlocks(layout, columns);
  const overlaps = blocks.filter((block) => block.column === column && block.startRow <= endRow && block.endRow >= startRow);
  if (overlaps.some((block) => block.startRow < startRow || block.endRow > endRow)) {
    throw new Error("기존 묶음의 일부만 선택했습니다. 기존 묶음 전체를 포함해 선택하세요.");
  }
  const subjects = new Set(contexts.filter((context) => context.rowIndex >= startRow && context.rowIndex <= endRow)
    .flatMap((context) => curriculumSubjectNames(context.subject)));
  if (subjects.size < pick) throw new Error(`묶음 과목이 ${subjects.size}개이므로 택${pick}을 지정할 수 없습니다.`);
  const replaced = new Set(merged.map((range) => range.reference));
  layout.mergedRanges = (layout.mergedRanges || []).filter((reference) => !replaced.has(reference));
  for (const range of merged) {
    for (let row = range.startRow + 1; row <= range.endRow; row++) {
      layout.rows[row] ||= [];
      layout.rows[row][column] = "";
      if (layout.formulas) delete layout.formulas[`${row}:${column}`];
    }
  }
  layout.choiceBlockRanges = blocks.filter((block) => !overlaps.includes(block))
    .map((block) => ({ column: block.column, startRow: block.startRow, endRow: block.endRow }));
  for (const block of overlaps) layout.rows[block.startRow][column] = "";
  layout.choiceBlockRanges.push({ column, startRow, endRow });
  layout.rows[startRow][column] = `택${values.pick}`;
  const key = `${CURRICULUM_SEMESTER_FIELDS[columns.semesters.indexOf(column)]}:${startRow}`;
  return applyCurriculumChoiceBlockEdit(layout, key, values);
}

function unmergeCurriculumChoiceCells(layout, selection) {
  const blocks = curriculumChoiceBlocks(layout);
  const selected = blocks.filter((block) => block.column === selection.column &&
    block.startRow <= selection.endRow && block.endRow >= selection.startRow);
  if (!selected.length) throw new Error("해제할 묶음 안의 셀을 선택하세요.");
  layout.choiceBlockRanges = blocks.filter((block) => !selected.includes(block))
    .map((block) => ({ column: block.column, startRow: block.startRow, endRow: block.endRow }));
  for (const block of selected) {
    layout.rows[block.startRow][block.column] = "";
    if (layout.formulas) delete layout.formulas[`${block.startRow}:${block.column}`];
  }
  syncCurriculumChoiceCompletion(layout, selected);
  return selected.length;
}

// 묶음 과목의 학기 선택 그룹을 편제표 묶음과 연결한다. 묶음 밖의 자동 묶음명은 지운다.
function linkCurriculumChoiceBlockGroups(plan, layout) {
  if (!Array.isArray(plan) || !layout) return plan;
  const blocks = curriculumChoiceBlocks(layout);
  for (const row of plan) {
    row.semesterGroups ||= {};
    if (/^편제표 선택묶음 \d+$/.test(String(row.bundleName || ""))) {
      row.bundleName = "";
      row.bundlePick = 1;
    }
    for (const [field, group] of Object.entries(row.semesterGroups)) {
      if (group?.block) delete row.semesterGroups[field];
    }
  }
  for (const block of blocks) {
    const names = new Set(block.subjects.map(curriculumChoiceSubjectKey));
    for (const row of plan) {
      if (!names.has(curriculumChoiceSubjectKey(row.subject))) continue;
      row[block.field] = "●";
      row.semesterGroups[block.field] = { name: block.name, pick: block.pick, block: block.key, credit: block.credit,
        ...(block.crossed ? { crossed: true } : {}) };
      const ownGrade = CURRICULUM_SEMESTER_FIELDS.some((field, index) =>
        row[field] && String(Math.floor(index / 2) + 1) === String(row.grade));
      if (!ownGrade) row.grade = block.grade;
    }
  }
  return plan;
}
