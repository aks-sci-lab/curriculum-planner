"use strict";

function curriculumSubjectKey(value) {
  return String(value ?? "").replace(/\s+/g, "").toLocaleLowerCase();
}

// 편제표에 종류 칸이 비어 있으면 2022 개정 과목 목록의 과목 구분을 쓴다(전문교과는 진로선택으로 편성).
function curriculumOfficialDetail(subject) {
  const official = typeof findCurriculumOfficialSubject === "function" ? findCurriculumOfficialSubject(subject) : null;
  if (!official) return "";
  if (CURRICULUM_DETAIL_OPTIONS.includes(official.type)) return official.type;
  return official.category === "전문교과" ? "진로선택" : "";
}

function curriculumSubjectCatalog(layout) {
  const columns = importedPlanColumnMap(layout);
  if (columns.subject < 0) throw new Error("과목명 열을 찾지 못했습니다.");
  const contexts = importedPlanCourseContexts(layout, columns);
  const entries = curriculumPlanEntries(layout).entries;
  const catalog = new Map();
  for (const context of contexts) {
    for (const subject of curriculumSubjectNames(context.subject)) {
      const key = curriculumSubjectKey(subject);
      let item = catalog.get(key);
      if (!item) {
        item = { subject, contexts: [], placements: [], detail: context.selectionType || curriculumOfficialDetail(subject),
          division: normalizeCurriculumDivision(context.division), area: context.area,
          baseCredit: curriculumCellNumber(context.row[columns.baseCredit]) || curriculumCellNumber(context.row[columns.genericCredit]) };
        catalog.set(key, item);
      }
      item.contexts.push(context);
      for (const entry of entries.filter((entry) => entry.rowIndex === context.rowIndex && curriculumSubjectKey(entry.subject) === key)) {
        if (item.placements.some((existing) => existing.grade === entry.grade && existing.semester === entry.semester)) {
          throw new Error(`${subject}: 같은 학년·학기에 중복 편성되어 있습니다. 중복 행을 먼저 정리하세요.`);
        }
        item.placements.push({ grade: entry.grade, semester: entry.semester, credit: entry.credit });
      }
    }
  }
  return [...catalog.values()];
}

// 병합 칸 하나만 수정할 때 나머지 구간의 값과 병합은 유지한다.
function writeCurriculumSubjectCell(layout, row, column, value) {
  const ref = (r, c) => `${columnName(c)}${r + 1}`;
  const remaining = [];
  for (const range of layout.mergedRanges || []) {
    const [a, b = a] = range.split(":");
    const top = Number(a.match(/\d+/)[0]) - 1, bottom = Number(b.match(/\d+/)[0]) - 1;
    const left = columnIndex(a), right = columnIndex(b);
    if (row < top || row > bottom || column < left || column > right) { remaining.push(range); continue; }
    const sheetMerge = curriculumSheetMerges(layout).find((merge) => merge.reference === range);
    if (sheetMerge && sheetMerge.kind !== "plain") {
      throw new Error("과목군 병합 칸은 먼저 셀 병합을 해제한 뒤 직접 수정하세요.");
    }
    if (sheetMerge) {
      layout.sheetMerges = curriculumSheetMerges(layout).filter((merge) => merge.reference !== range)
        .map(({ reference, kind, pick, credit }) => ({ reference, kind, pick, credit }));
      continue;
    }
    if (layout.formulas?.[`${top}:${left}`]) throw new Error("병합된 수식 칸은 먼저 병합을 해제한 뒤 수정하세요.");
    const text = layout.rows[top]?.[left] ?? "";
    const fill = curriculumCellFill(layout, top, left);
    const keep = (r1, c1, r2, c2) => {
      if (r1 > r2 || c1 > c2) return;
      layout.rows[r1] ||= [];
      layout.rows[r1][c1] = text;
      if (fill) (layout.cellFills ||= {})[`${r1}:${c1}`] = fill;
      if (r1 !== r2 || c1 !== c2) remaining.push(`${ref(r1, c1)}:${ref(r2, c2)}`);
    };
    keep(top, left, row - 1, right);
    keep(row + 1, left, bottom, right);
    keep(row, left, row, column - 1);
    keep(row, column + 1, row, right);
  }
  layout.mergedRanges = remaining;
  layout.rows[row] ||= [];
  layout.rows[row][column] = String(value);
  if (layout.formulas) delete layout.formulas[`${row}:${column}`];
}

function curriculumSubjectSpan(layout, context, columns) {
  const rows = expandCurriculumLayoutRows(layout);
  const nextContexts = new Set(importedPlanCourseContexts(layout, columns).map((item) => item.rowIndex));
  const firstSemester = Math.min(...columns.semesters.filter((column) => column >= 0));
  let end = context.rowIndex;
  while (end - context.rowIndex < 3 && end + 1 < rows.length && !nextContexts.has(end + 1)) {
    const next = rows[end + 1];
    if (next.some((value, column) => column < firstSemester && String(value ?? "").trim() &&
        !next._mergedFillColumns?.has(column))) break;
    end++;
  }
  return end;
}

function curriculumSubjectActionColumns(layout, options) {
  let columns = importedPlanColumnMap(layout);
  const header = layout.rows.findIndex((row) => row.some((value) => /과목명|세부과목/.test(String(value))));
  if (header < 0) throw new Error("편제표의 과목명 머리글을 찾지 못했습니다.");
  const append = (label) => {
    const column = Math.max(...layout.rows.map((row) => row.length));
    for (const row of layout.rows) while (row.length <= column) row.push("");
    layout.rows[header][column] = label;
    layout.columnWidths ||= [];
    layout.columnWidths[column] = 14;
    return column;
  };
  for (const [field, label] of [["division", "교육과정구분"], ["area", "교과군"]]) {
    if (columns[field] < 0) columns[field] = append(label);
  }
  if (columns.detail < 0) {
    const typeColumns = [...new Set(importedPlanCourseContexts(layout, columns)
      .map((context) => context.typeColumn).filter((column) => column >= 0))];
    columns.detail = typeColumns.length === 1 ? typeColumns[0] : append("과목유형");
  }
  if (["add", "move"].includes(options.action)) {
    const index = (Number(options.grade) - 1) * 2 + Number(options.semester) - 1;
    if (columns.semesters[index] < 0) columns.semesters[index] = append(`${options.grade}-${options.semester}`);
  }
  return columns;
}

function buildCurriculumCrossSelectionChange(layout, plan, selection, release = false) {
  const { column, endColumn, startRow, endRow } = selection;
  const columns = importedPlanColumnMap(layout);
  const index = columns.semesters.indexOf(column);
  if (![column, endColumn, startRow, endRow].every(Number.isInteger) || startRow < 0 ||
      endRow < startRow || endRow >= layout.rows.length || index < 0 || index % 2 !== 0 ||
      columns.semesters[index + 1] !== endColumn || endColumn !== column + 1) {
    throw new Error("가로 병합은 같은 학년의 1·2학기 두 열만 선택하세요. 다른 학년을 함께 병합할 수 없습니다.");
  }
  for (let row = startRow; row <= endRow; row++) {
    const text = (layout.rows[row] || []).slice(0, columns.subject + 1).join(" ").replace(/\s/g, "");
    if (/소계|합계|총이수|창의적체험|필수이수/.test(text)) throw new Error("소계·합계·창체 행은 교차집중으로 병합할 수 없습니다.");
  }
  const contexts = importedPlanCourseContexts(layout, columns).filter((context) =>
    curriculumSubjectNames(context.subject).length && context.rowIndex <= endRow &&
    curriculumSubjectSpan(layout, context, columns) >= startRow);
  if (!contexts.length) throw new Error("교차집중으로 편성할 과목 행을 선택하세요.");
  let next = JSON.parse(JSON.stringify(layout));
  for (const context of contexts.sort((a, b) => b.rowIndex - a.rowIndex)) {
    const subject = curriculumSubjectNames(context.subject)[0];
    next = buildCurriculumCrossIntensiveChange(next, plan, {
      subject, grade: String(Math.floor(index / 2) + 1), action: release ? "cross-remove" : "cross-add"
    }).layout;
  }
  return { layout: next, plan: JSON.parse(JSON.stringify(plan)) };
}

function buildCurriculumCrossIntensiveChange(layout, plan, options) {
  if (!["1", "2", "3"].includes(options.grade)) throw new Error("교차집중을 적용할 학년을 선택하세요.");
  const columns = importedPlanColumnMap(layout);
  const source = curriculumSubjectCatalog(layout).find((item) => curriculumSubjectKey(item.subject) === curriculumSubjectKey(options.subject));
  if (!source) throw new Error("선택한 과목을 찾지 못했습니다.");
  const semesterColumns = columns.semesters.slice((Number(options.grade) - 1) * 2, Number(options.grade) * 2);
  if (semesterColumns.some((column) => column < 0) || semesterColumns[1] !== semesterColumns[0] + 1) {
    throw new Error("교차집중에는 나란한 1·2학기 열이 필요합니다.");
  }
  const contexts = source.contexts.filter((context) => {
    const end = curriculumSubjectSpan(layout, context, columns);
    return layout.rows.slice(context.rowIndex, end + 1).some((row) =>
      semesterColumns.some((column) => String(row[column] || "").trim()));
  });
  if (contexts.length !== 1) throw new Error("같은 행에 편성된 1·2학기 과목을 선택하세요. 분리된 과목 행은 먼저 확인하세요.");
  const context = contexts[0];
  const end = curriculumSubjectSpan(layout, context, columns);
  const markers = [];
  for (let row = context.rowIndex; row <= end; row++) {
    for (const column of semesterColumns) {
      if (/교차\s*집중/.test(String(layout.rows[row]?.[column] || ""))) markers.push({ row, column });
    }
  }
  const removing = options.action === "cross-remove";
  if (!removing && markers.length) throw new Error("이미 교차집중으로 편성되어 있습니다.");
  if (removing && !markers.length && !context.subject.includes("↔")) throw new Error("제거할 교차집중 표시가 없습니다.");
  let next = JSON.parse(JSON.stringify(layout));
  if (removing) {
    for (const marker of markers) {
      const ranges = (next.mergedRanges || []).map(curriculumChoiceRange).filter(Boolean);
      const range = ranges.find((item) => item.startRow === marker.row && item.startColumn === marker.column);
      if (range && (range.startColumn < semesterColumns[0] || range.endColumn > semesterColumns[1] || range.endRow > end)) {
        throw new Error("다른 학년·과목과 함께 병합된 교차집중은 분리한 뒤 제거하세요.");
      }
      const right = range?.endColumn ?? marker.column;
      const bottom = range?.endRow ?? marker.row;
      for (let row = marker.row; row <= bottom; row++) {
        for (let column = marker.column; column <= right; column++) writeCurriculumSubjectCell(next, row, column, "");
      }
    }
    if (context.subject.includes("↔")) {
      if (source.placements.some((placement) => placement.grade !== options.grade)) {
        throw new Error("과목명의 ↔ 표시는 여러 학년에 공통 적용되어 있습니다. 학년별 교차집중 칸을 확인하세요.");
      }
      writeCurriculumSubjectCell(next, context.rowIndex, columns.subject, context.subject.replace(/↔/g, "").trim());
    }
  } else {
    const memberships = curriculumChoiceBlocks(layout, columns).filter((block) =>
      block.grade === options.grade && context.rowIndex >= block.startRow && context.rowIndex <= block.endRow);
    if (memberships.length) throw new Error("택n 묶음 안의 과목은 묶음을 해제한 뒤 교차집중을 지정하세요.");
    const credits = semesterColumns.map((column) => {
      const values = [];
      for (let row = context.rowIndex; row <= end; row++) {
        const credit = curriculumCellNumber(layout.rows[row]?.[column]);
        if (credit) values.push({ row, credit });
      }
      if (values.length !== 1) throw new Error("1·2학기에 각각 학점이 하나씩 편성되어 있어야 합니다. 먼저 학기·학점을 확인하세요.");
      return values[0];
    });
    let insertion = -1;
    for (let row = context.rowIndex + 1; row <= end; row++) {
      if (semesterColumns.every((column, index) => {
        const value = String(layout.rows[row]?.[column] || "").trim();
        return !value || (credits[index].row === row && curriculumCellNumber(value) > 0);
      })) { insertion = row; break; }
    }
    if (insertion < 0) {
      if (end - context.rowIndex >= 2) throw new Error("이미 여러 행으로 편성된 과목입니다. 학기·학점 행을 먼저 정리하세요.");
      insertion = end + 1;
      next = insertImportedPlanLayoutRow(next, insertion, [], end);
    }
    for (const [index, column] of semesterColumns.entries()) {
      const formula = next.formulas?.[`${credits[index].row}:${column}`];
      for (let row = context.rowIndex; row <= end; row++) writeCurriculumSubjectCell(next, row, column, "");
      writeCurriculumSubjectCell(next, insertion, column, credits[index].credit);
      if (formula) {
        (next.formulas ||= {})[`${insertion}:${column}`] = formula;
        (next.formulaEdits ||= {})[`${insertion}:${column}`] = true;
      }
    }
    writeCurriculumSubjectCell(next, context.rowIndex, semesterColumns[0], "교차집중(↔)");
    writeCurriculumSubjectCell(next, context.rowIndex, semesterColumns[1], "");
    next.mergedRanges.push(`${columnName(semesterColumns[0])}${context.rowIndex + 1}:${columnName(semesterColumns[1])}${context.rowIndex + 1}`);
    for (const [key, formula] of Object.entries(next.formulas || {})) {
      const updated = formula.replace(/\$?[A-Z]+\$?\d+/g, (reference) => {
        const column = columnIndex(reference.replace(/\$/g, ""));
        const row = Number(reference.match(/\d+/)[0]) - 1;
        const index = semesterColumns.indexOf(column);
        return index >= 0 && row === credits[index].row
          ? reference.replace(/\d+$/, String(insertion + 1)) : reference;
      });
      if (formula !== updated) {
        next.formulas[key] = updated;
        (next.formulaEdits ||= {})[key] = true;
      }
    }
  }
  recalculatePlanFormulas(next);
  return { layout: next, plan: JSON.parse(JSON.stringify(plan)) };
}

function buildCurriculumSubjectChange(layout, plan, options) {
  if (!layout?.rows?.length) throw new Error("편제표를 먼저 업로드하세요.");
  if (["cross-add", "cross-remove"].includes(options.action)) return buildCurriculumCrossIntensiveChange(layout, plan, options);
  if (!["add", "move", "swap", "delete", "division"].includes(options.action)) throw new Error("추가·이동·맞교체·삭제·구분 변경 중 작업을 선택하세요.");
  const catalog = curriculumSubjectCatalog(layout);
  const adding = options.action === "add";
  const official = adding ? findCurriculumOfficialSubject(options.subject) : null;
  if (adding && !official) throw new Error("2022 개정 교육과정 과목 목록에서 과목을 선택하세요.");
  if (adding && catalog.some((item) => curriculumOfficialSubjectKey(item.subject) === curriculumOfficialSubjectKey(official.name))) {
    throw new Error("이미 편성된 과목입니다. 기존 과목명을 눌러 편성을 변경하세요.");
  }
  const source = adding ? {
    subject: official.name, detail: curriculumOfficialDetail(official.name), area: official.area,
    division: options.division, baseCredit: options.credit, contexts: [], placements: []
  } : catalog.find((item) => curriculumSubjectKey(item.subject) === curriculumSubjectKey(options.subject));
  if (!source) throw new Error("선택한 과목이 편제표에 없습니다. 화면을 새로 확인하세요.");
  const detail = source.detail;
  if (options.action !== "delete") {
    if (!CURRICULUM_DETAIL_OPTIONS.includes(detail)) throw new Error("과목 종류를 확인할 수 없습니다. 기준 목록으로 확인한 뒤 변경하세요.");
    if (options.detail !== undefined && options.detail !== detail) throw new Error("과목 종류는 고정 분류이므로 변경할 수 없습니다.");
  }
  const division = options.division ?? source.division;
  if (options.action !== "delete" && !["학생 선택 교육과정", "학교 지정 교육과정"].includes(division)) {
    throw new Error("학생선택 또는 학교지정 교육과정을 선택하세요.");
  }
  if (options.action === "division" && !source.placements.length) throw new Error("기존 학년·학기 편성을 확인한 뒤 구분을 변경하세요.");
  if (options.action === "division" && division === source.division) throw new Error("현재와 다른 편성 구분을 선택하세요.");
  let target = null;
  if (options.action === "swap") {
    target = catalog.find((item) => curriculumSubjectKey(item.subject) === curriculumSubjectKey(options.targetSubject));
    if (!target || target === source) throw new Error("맞교체할 다른 과목을 자동완성 목록에서 선택하세요.");
    if (!CURRICULUM_DETAIL_OPTIONS.includes(target.detail)) throw new Error("맞교체할 과목의 종류를 기준 목록으로 먼저 확인하세요.");
    if (!source.placements.length || !target.placements.length) throw new Error("두 과목 모두 학년·학기가 편성되어 있어야 맞교체할 수 있습니다.");
  }
  if ((adding || options.action === "move") && (!["1", "2", "3"].includes(options.grade) ||
      !["1", "2"].includes(options.semester) || !Number.isFinite(options.credit) || options.credit <= 0)) {
    throw new Error("편성할 학년·학기와 0보다 큰 학점을 입력하세요.");
  }
  if (options.action !== "delete" && [...source.placements, ...(target?.placements || [])].some((entry) => entry.credit <= 0)) {
    throw new Error("기존 편성의 학점을 읽지 못했습니다. 학점을 먼저 확인하세요.");
  }
  let next = JSON.parse(JSON.stringify(layout));
  const columns = options.action === "delete" ? importedPlanColumnMap(next) : curriculumSubjectActionColumns(next, options);
  const removed = new Set((adding ? [] : [source, target]).filter(Boolean).map((item) => curriculumSubjectKey(item.subject)));
  const affected = new Map();
  const blocks = curriculumChoiceBlocks(next, columns);
  const emptiedSheetMerges = new Set(blocks.filter((block) => block.sheetMerge &&
    block.subjects.every((name) => removed.has(curriculumSubjectKey(name)))).map((block) => block.sheetMerge));
  if (emptiedSheetMerges.size) {
    next.mergedRanges = next.mergedRanges.filter((ref) => !emptiedSheetMerges.has(ref));
    next.sheetMerges = curriculumSheetMerges(layout).filter((merge) => !emptiedSheetMerges.has(merge.reference))
      .map(({ reference, kind, pick, credit }) => ({ reference, kind, pick, credit }));
  }
  const completion = curriculumCompletionColumn(next);
  for (const block of blocks) {
    const remaining = block.subjects.filter((name) => !removed.has(curriculumSubjectKey(name)));
    if (["delete", "move"].includes(options.action) && remaining.length && remaining.length < block.pick) {
      throw new Error(`${block.name}: 삭제·이동 후 남는 과목이 ${remaining.length}개입니다. 선택 수를 먼저 줄인 뒤 변경하세요.`);
    }
  }
  for (const item of [source, target].filter(Boolean)) for (const context of item.contexts) {
    affected.set(context.rowIndex, context);
  }
  for (const context of [...affected.values()].sort((a, b) => b.rowIndex - a.rowIndex)) {
    const end = curriculumSubjectSpan(next, context, columns);
    const names = String(context.subject).split(/[,，、]/)
      .filter((name) => !removed.has(curriculumSubjectKey(curriculumSubjectNames(name)[0])));
    writeCurriculumSubjectCell(next, context.rowIndex, columns.subject, names.join(", "));
    if (!names.some((name) => String(name).trim())) {
      next.retiredSubjectRows ||= [];
      for (let row = context.rowIndex; row <= end; row++) {
        next.retiredSubjectRows.push(row);
        if (row !== context.rowIndex) writeCurriculumSubjectCell(next, row, columns.subject, "");
        for (const column of new Set([...columns.semesters, columns.baseCredit, columns.opCredit, columns.genericCredit].filter((column) => column >= 0))) {
          if (blocks.some((block) => block.column === column && row >= block.startRow && row <= block.endRow &&
            block.subjects.some((name) => !removed.has(curriculumSubjectKey(name))))) continue;
          writeCurriculumSubjectCell(next, row, column, "");
          if (next.cellFills) delete next.cellFills[`${row}:${column}`];
        }
        const sharedCompletion = (next.mergedRanges || []).map(curriculumChoiceRange).filter(Boolean).some((range) =>
          range.startColumn === completion && range.endColumn === completion && range.startRow <= row && range.endRow >= row &&
          (range.startRow < context.rowIndex || range.endRow > end));
        if (completion >= 0 && !sharedCompletion) writeCurriculumSubjectCell(next, row, completion, "");
      }
    }
    const emptiedBlocks = blocks.filter((block) => block.subjects.length &&
      block.subjects.every((name) => removed.has(curriculumSubjectKey(name))));
    for (const block of emptiedBlocks) {
      for (let row = block.startRow; row <= block.endRow; row++) writeCurriculumSubjectCell(next, row, block.column, "");
    }
    if (emptiedBlocks.length && completion >= 0) syncCurriculumChoiceCompletion(next, emptiedBlocks);
  }
  const additions = [];
  const add = (identity, placements, selectedDetail) => {
    const byCredit = new Map();
    for (const placement of placements) {
      const key = `${placement.grade}:${placement.credit}`;
      const group = byCredit.get(key) || [];
      group.push(placement); byCredit.set(key, group);
    }
    for (const placements of byCredit.values()) {
      const grade = placements[0].grade, credit = placements[0].credit;
      const record = normalizeCurriculumPlanRow({ ...identity, grade, detail: selectedDetail, opCredit: credit,
        bundleName: "", bundlePick: 1, semesterGroups: {} });
      const values = [];
      if (adding) {
        const completionColumn = typeof curriculumCompletionColumn === "function" ? curriculumCompletionColumn(next) : -1;
        if (completionColumn >= 0) values[completionColumn] = String(placements.reduce((sum, placement) => sum + placement.credit, 0));
      }
      for (const [field, column] of Object.entries(columns)) {
        if (column >= 0 && ["subject", "grade", "division", "area", "detail", "baseCredit", "opCredit"].includes(field)) values[column] = record[field];
      }
      for (const field of CURRICULUM_SEMESTER_FIELDS) record[field] = "";
      for (const placement of placements) {
        const index = (Number(placement.grade) - 1) * 2 + Number(placement.semester) - 1;
        values[columns.semesters[index]] = String(placement.credit);
        record[CURRICULUM_SEMESTER_FIELDS[index]] = "●";
        if (record.division === "학생 선택 교육과정") {
          record.semesterGroups[CURRICULUM_SEMESTER_FIELDS[index]] = { name: "", pick: 0 };
        }
      }
      const current = importedPlanCourseContexts(next, columns).filter((context) => curriculumSubjectNames(context.subject).length);
      const entries = curriculumPlanEntries(next).entries;
      const matches = current.filter((context) => entries.some((entry) => entry.rowIndex === context.rowIndex && entry.grade === grade));
      const peer = matches.filter((context) => normalizeCurriculumDetail(context.selectionType || context.detail) === selectedDetail &&
        context.area === identity.area).at(-1) || matches.at(-1) || current.at(-1);
      let insertion = peer ? curriculumSubjectSpan(next, peer, columns) + 1 : headerAfter();
      if (adding && typeof curriculumChoiceBlocks === "function") {
        const blocks = curriculumChoiceBlocks(next, columns);
        while (blocks.some((block) => insertion > block.startRow && insertion <= block.endRow)) {
          insertion = Math.max(...blocks.filter((block) => insertion > block.startRow && insertion <= block.endRow).map((block) => block.endRow + 1));
        }
      }
      const following = current.find((context) => context.rowIndex >= insertion);
      next = insertImportedPlanLayoutRow(next, insertion, values);
      for (const [key, formula] of Object.entries(next.formulas || {})) {
        if (Number(key.split(":")[0]) <= insertion) continue;
        const extended = formula.replace(/\bSUM\(([^()]*)\)/gi, (sum, args) =>
          `SUM(${args.replace(/(\$?[A-Z]+\$?\d+):(\$?[A-Z]+\$?)(\d+)/gi, (range, start, endColumn, endRow) =>
            Number(endRow) === insertion && Number(start.match(/\d+/)[0]) <= insertion
              ? `${start}:${endColumn}${insertion + 1}` : range)})`);
        if (extended !== formula) {
          next.formulas[key] = extended;
          (next.formulaEdits ||= {})[key] = true;
        }
      }
      for (const column of new Set([...Object.values(columns).filter(Number.isInteger), ...columns.semesters,
        ...(adding && typeof curriculumCompletionColumn === "function" ? [curriculumCompletionColumn(next)] : [])])) {
        if (column < 0 || !Object.hasOwn(values, column)) continue;
        writeCurriculumSubjectCell(next, insertion, column, values[column]);
      }
      if (following) {
        for (const [field, value] of [["grade", following.grade], ["division", following.division],
          ["area", following.area], ["detail", following.selectionType || following.detail]]) {
          if (columns[field] >= 0) writeCurriculumSubjectCell(next, following.rowIndex + 1, columns[field], value);
        }
      }
      additions.push(record);
    }
  };
  function headerAfter() {
    return next.rows.findIndex((row) => row.some((value) => /과목명|세부과목/.test(String(value)))) + 1;
  }
  const identity = { ...source, division };
  if (adding || options.action === "move") add(identity, [{ grade: options.grade, semester: options.semester, credit: options.credit }], detail);
  if (options.action === "division") add(identity, source.placements, detail);
  if (options.action === "swap") {
    add(identity, target.placements, detail);
    add(target, source.placements, target.detail);
  }
  recalculatePlanFormulas(next);
  if (next.choiceBlockRanges && completion >= 0 &&
      typeof syncCurriculumChoiceCompletion === "function") syncCurriculumChoiceCompletion(next);
  const nextPlan = plan.flatMap((row) => curriculumSubjectNames(row.subject).filter((name) => !removed.has(curriculumSubjectKey(name)))
    .map((subject) => normalizeCurriculumPlanRow({ ...row, subject }))).concat(additions);
  if (typeof linkCurriculumChoiceBlockGroups === "function") linkCurriculumChoiceBlockGroups(nextPlan, next);
  return { layout: next, plan: nextPlan };
}

function initCurriculumSubjectActions() {
  document.getElementById("curriculumEmptyRowsToggle").addEventListener("click", () => {
    if (typeof requireLocalWorkspaceAccess === "function" && !requireLocalWorkspaceAccess()) return;
    const layout = state.curriculumImportedLayout;
    if (!layout) return;
    layout.showEmptySubjectRows = !layout.showEmptySubjectRows;
    renderCurriculumStep();
    if (!persistState()) {
      status.style.color = "#a44939";
      status.textContent = "빈 과목 행 표시 설정을 저장하지 못했습니다. 상단 저장 경고를 확인하세요.";
    }
  });
  const dialog = document.getElementById("curriculumSubjectDialog");
  const form = document.getElementById("curriculumSubjectForm");
  const field = (name) => document.getElementById(`curriculumSubject${name}`);
  let selected = null, catalog = [], revision = 0;
  const placementLabel = (item) => item.placements.map((p) => `${p.grade}학년 ${p.semester}학기 ${p.credit}학점`).join(", ") || "학기 미정";
  const total = (item) => item.placements.reduce((sum, p) => sum + p.credit, 0);
  function options() {
    return { subject: field("Action").value === "add" ? field("Name").value : selected.subject, action: field("Action").value, grade: field("Grade").value,
      semester: field("Semester").value, credit: Number(field("Credit").value), detail: field("Detail").value,
      division: field("Division").value,
      targetSubject: field("Target").value };
  }
  function refresh() {
    const action = field("Action").value;
    const adding = action === "add";
    const crossing = action === "cross-add" || action === "cross-remove";
    const placement = adding || action === "move";
    field("AddFields").classList.toggle("hidden", !adding);
    field("Name").disabled = !adding;
    field("Name").required = adding;
    if (adding) {
      const official = findCurriculumOfficialSubject(field("Name").value);
      field("Detail").value = official ? curriculumOfficialDetail(official.name) : "";
    }
    field("MoveFields").classList.toggle("hidden", !placement && !crossing);
    field("Semester").disabled = crossing;
    field("Semester").closest("div").querySelector('label[for="curriculumSubjectSemester"]').hidden = crossing;
    field("Semester").hidden = crossing;
    field("Credit").hidden = crossing;
    field("Credit").closest("div").querySelector('label[for="curriculumSubjectCredit"]').hidden = crossing;
    field("SwapFields").classList.toggle("hidden", action !== "swap");
    field("DetailField").classList.toggle("hidden", action === "delete" || crossing);
    field("Credit").required = placement;
    field("Credit").disabled = !placement;
    field("Target").required = action === "swap";
    field("Target").disabled = action !== "swap";
    const target = catalog.find((item) => curriculumSubjectKey(item.subject) === curriculumSubjectKey(field("Target").value));
    field("CreditHelp").textContent = crossing
      ? "기존 1·2학기 학점을 유지하고 교차집중 표시를 추가·제거합니다. 같은 칸의 여러 과목은 함께 적용됩니다. 택n 묶음은 먼저 해제하세요."
      : adding
      ? "기준 목록의 과목 종류·교과군을 사용합니다. 지정한 학년·학기에 새 과목 행을 추가합니다."
      : "기존 편성 전체를 비우고 이 학기에 배치합니다. 기본값은 기존 총학점이며 수정할 수 있습니다. 필요한 행·학기 칸은 자동 생성합니다.";
    field("Preview").textContent = crossing
      ? `${selected.subject} · ${field("Grade").value}학년 교차집중 ${action === "cross-add" ? "추가" : "제거"} · 1·2학기 학점 유지(같은 과목 칸 전체 적용)`
      : adding
      ? `${field("Name").value || "과목 선택"} → ${field("Grade").value}학년 ${field("Semester").value}학기 ${field("Credit").value || "?"}학점 · ${field("Detail").value || "목록에서 선택하세요"} · ${field("Division").value}`
      : action === "delete"
      ? `${selected.subject}의 기존 편성 전체를 삭제합니다.`
      : action === "move"
        ? `기존 총 ${total(selected)}학점 → ${field("Grade").value}학년 ${field("Semester").value}학기 ${field("Credit").value || "?"}학점 · ${selected.detail} · ${field("Division").value}`
        : action === "division"
          ? `${selected.subject}: ${selected.division} → ${field("Division").value}\n${placementLabel(selected)} · ${selected.detail} 유지`
        : target && target !== selected
          ? `${selected.subject} → ${placementLabel(target)} / ${target.subject} → ${placementLabel(selected)}. 학점은 편성 위치를 따라 맞교체됩니다.`
          : "맞교체할 과목명을 입력하고 자동완성 목록에서 선택하세요.";
    field("Error").textContent = "";
  }
  document.getElementById("curriculumAddSubject").addEventListener("click", () => {
    try {
      if (typeof isWorkspaceStorageProtected === "function" && isWorkspaceStorageProtected()) throw new Error("저장 원본을 먼저 복원하세요.");
      if (!state.curriculumImportedLayout) throw new Error("편제표를 먼저 업로드하세요.");
      catalog = curriculumSubjectCatalog(state.curriculumImportedLayout);
      selected = null;
      revision = state.curriculumMutationRevision;
      field("Title").textContent = "과목 추가";
      field("Current").textContent = "2022 개정 교육과정 과목 목록에서 선택하세요. 과목 종류와 교과군은 자동 지정됩니다.";
      field("Action").querySelector('[value="add"]').disabled = false;
      field("Action").value = "add";
      field("Action").disabled = true;
      field("Name").value = "";
      field("Grade").value = state.curriculumTargetGrade || "1";
      field("Semester").value = "1";
      field("Credit").value = "4";
      field("Division").value = "학생 선택 교육과정";
      field("OfficialSuggestions").replaceChildren(...[...curriculumOfficialSubjects().values()].map((item) => {
        const option = document.createElement("option");
        option.value = item.name;
        option.label = `${item.area} · ${curriculumOfficialDetail(item.name)}`;
        return option;
      }));
      refresh();
      dialog.showModal();
      field("Name").focus();
    } catch (error) { showAppToast(`과목 추가 열기 실패: ${error.message}`, "error"); }
  });
  document.getElementById("curriculumPlanWrap").addEventListener("click", (event) => {
    const button = event.target.closest("[data-curriculum-subject]");
    if (!button) return;
    setTimeout(() => {
      try {
        if (typeof isWorkspaceStorageProtected === "function" && isWorkspaceStorageProtected()) throw new Error("저장 원본을 먼저 복원하세요.");
        catalog = curriculumSubjectCatalog(state.curriculumImportedLayout);
        selected = catalog.find((item) => curriculumSubjectKey(item.subject) === curriculumSubjectKey(button.dataset.curriculumSubject));
        if (!selected) throw new Error("편제표에서 선택한 과목을 찾지 못했습니다.");
        if (selected.placements.length > 1 && !window.confirm(`${selected.subject}은(는) ${placementLabel(selected)}에 편성되어 있습니다.\n기존 편성 전체가 변경됩니다. 이동 시 총 ${total(selected)}학점을 유지하거나 직접 수정할 수 있습니다.\n계속할까요?`)) return;
        revision = state.curriculumMutationRevision;
        field("Title").textContent = `${selected.subject} 편성 변경`;
        field("Current").textContent = `현재: ${placementLabel(selected)} · ${selected.division} · ${selected.detail || "종류 미확인"}`;
        field("Action").value = "move";
        field("Action").disabled = false;
        field("Action").querySelector('[value="add"]').disabled = true;
        field("Grade").value = selected.placements[0]?.grade || "2";
        field("Semester").value = selected.placements[0]?.semester || "1";
        field("Credit").value = String(total(selected) || selected.baseCredit || "");
        field("Detail").value = selected.detail;
        field("Division").value = selected.division;
        field("Target").value = "";
        field("Suggestions").replaceChildren(...catalog.filter((item) => item !== selected).map((item) => {
          const option = document.createElement("option"); option.value = item.subject;
          option.label = `${placementLabel(item)} · ${item.detail}`; return option;
        }));
        refresh(); dialog.showModal(); field("Action").focus();
      } catch (error) { showAppToast(`과목 편성 열기 실패: ${error.message}`, "error"); }
    }, 0);
  });
  form.addEventListener("input", refresh);
  form.addEventListener("change", refresh);
  field("Cancel").addEventListener("click", () => dialog.close());
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      if (typeof isWorkspaceStorageProtected === "function" && isWorkspaceStorageProtected()) throw new Error("저장 원본을 먼저 복원하세요.");
      if (revision !== state.curriculumMutationRevision) throw new Error("편제표가 변경되었습니다. 팝업을 닫고 과목을 다시 선택하세요.");
      const request = options();
      const change = buildCurriculumSubjectChange(state.curriculumImportedLayout, state.curriculumPlan, request);
      const groupHelp = ["cross-add", "cross-remove"].includes(request.action) ? ""
        : " 편제표 택n 묶음 안으로 옮기면 그 묶음 그룹에 자동 연결되고, 그 밖의 선택 그룹은 새 위치에서 다시 지정해야 합니다.";
      if (!window.confirm(`${field("Preview").textContent}\n변경을 적용할까요?${groupHelp}`)) return;
      recordCurriculumUndo();
      state.curriculumImportedLayout = change.layout;
      state.curriculumPlan = change.plan;
      syncCurriculumTemplateRows();
      state.curriculumEditBefore = null;
      state.curriculumEditUndoRecorded = false;
      if (request.action !== "delete") {
        state.curriculumPlanFilters.grade = request.action === "move" ? request.grade : "";
        state.curriculumPlanFilters.detail = "";
        state.curriculumPlanFilters.division = "";
        state.curriculumPlanFilters.query = "";
      }
      renderCurriculumStep();
      const saved = persistState();
      renderCurriculumVersions();
      dialog.close();
      const movedButton = [...document.querySelectorAll("#curriculumPlanWrap [data-curriculum-subject]")]
        .find((button) => curriculumSubjectKey(button.dataset.curriculumSubject) === curriculumSubjectKey(request.subject));
      if (movedButton) {
        movedButton.focus();
        movedButton.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      status.style.color = saved ? "#287956" : "#a44939";
      status.textContent = saved ? "과목 편성 변경을 저장했습니다. 변경 사유·근거를 입력해 이력에 저장하세요."
        : "과목 편성은 변경했지만 저장하지 못했습니다. 상단 저장 경고를 확인하세요.";
      showAppToast(saved ? "과목 편성을 변경했습니다. 실행취소로 되돌릴 수 있습니다." : status.textContent, saved ? "success" : "error");
    } catch (error) { field("Error").textContent = `편성 변경 실패: ${error.message}`; }
  });
}

if (typeof document !== "undefined") initCurriculumSubjectActions();
