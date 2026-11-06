const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const appFunction = (name) => {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf("\n    function ", start + 1);
  assert.ok(start >= 0 && end > start, name);
  return app.slice(start, end);
};

function context() {
  const ctx = vm.createContext({
    CURRICULUM_DETAIL_OPTIONS: ["공통", "일반선택", "진로선택", "융합선택"],
    CURRICULUM_SEMESTER_FIELDS: ["sem11", "sem12", "sem21", "sem22", "sem31", "sem32"],
    escapeHtml: (value) => String(value),
  });
  for (const name of ["columnIndex", "columnName", "curriculumCellFill", "normalizeCurriculumDetail",
    "curriculumSelectionType", "normalizeCurriculumDivision", "normalizeCurriculumAreaName",
    "normalizeCurriculumPlanRow", "sheetMergeReferenceSet", "importedPlanCoveredCells", "importedPlanCourseContexts",
    "curriculumSubjectNames", "importedPlanColumnMap", "expandCurriculumLayoutRows", "insertImportedPlanLayoutRow",
    "curriculumSemesterHoursSummaryHtml", "curriculumSubjectSignatures", "curriculumTableChanges", "curriculumChangeAttributes"]) {
    vm.runInContext(appFunction(name), ctx);
  }
  const workbook = fs.readFileSync(path.join(root, "curriculum-workbook.js"), "utf8");
  vm.runInContext(workbook.slice(0, workbook.indexOf('document.getElementById("exportCurriculumPlan")')), ctx);
  const versions = fs.readFileSync(path.join(root, "curriculum-versions.js"), "utf8");
  vm.runInContext(versions.slice(0, versions.indexOf("function initCurriculumVersions(")), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, "curriculum-subject-list.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, "curriculum-choice-blocks.js"), "utf8"), ctx);
  return ctx;
}

// 실제 편제표 형식: 2행 머리글(학년/학기), 세부과목 병합 머리글, 이수학점 병합 칸, '택n' 아래 학점 칸.
function fixture() {
  return {
    rows: [
      ["2026학년도 신입생 교육과정 편제표"],
      ["구분", "교과(군)", "세부과목", "", "기준학점", "운영학점", "1학년", "", "2학년", "", "3학년", "", "이수 학점", "필수이수"],
      ["", "", "", "", "", "", "1학기", "2학기", "1학기", "2학기", "1학기", "2학기", "", ""],
      ["학생 선택 교육과정", "사회", "일반", "세계사", "4", "4", "", "", "택2", "", "", "", "8", ""],
      ["", "사회", "일반", "사회와 문화", "4", "4", "", "", "4", "", "", "", "", ""],
      ["", "과학", "일반", "화학", "4", "4", "", "", "4", "", "", "", "", ""],
      ["", "", "소계", "", "", "", "", "", "8", "", "", "", "", ""],
    ],
    mergedRanges: ["A2:A3", "B2:B3", "C2:D3", "E2:E3", "F2:F3", "G2:H2", "I2:J2", "K2:L2", "M2:M3", "N2:N3", "A4:A6", "M4:M6"],
    rowInsertions: [], rowHeights: {}, cellFills: {},
    formulas: { "6:8": "SUM(I5:I6)" },
    columnWidths: Array(14).fill(12),
  };
}

test("택n blocks combine the tag cell and the credit cells below into one group", () => {
  const ctx = context();
  const [block, ...rest] = plain(ctx.curriculumChoiceBlocks(fixture()));
  assert.equal(rest.length, 0);
  assert.equal(block.key, "sem21:3");
  assert.equal(block.name, "2-1 택2");
  assert.deepEqual([block.grade, block.semester, block.pick, block.credit, block.total], ["2", "1", 2, 4, 8]);
  assert.deepEqual(block.creditCells, [4, 5]);
  assert.deepEqual(block.subjects, ["세계사", "사회와 문화", "화학"]);
  assert.deepEqual(block.completion, { row: 3, column: 12, formula: false });
});

test("editing a block rewrites 택n, the credit cells and completion credits as n × credit", () => {
  const ctx = context();
  const layout = fixture();
  const edited = plain(ctx.applyCurriculumChoiceBlockEdit(layout, "sem21:3", { pick: "1", credit: "5" }));
  assert.equal(edited.total, 5);
  assert.deepEqual([3, 4, 5].map((row) => layout.rows[row][8]), ["택1", "5", ""]);
  assert.equal(layout.rows[3][12], "5", "이수학점 = 택1 × 5학점");
  assert.equal(String(layout.rows[6][8]), "5", "소계 수식도 다시 계산한다");
  assert.throws(() => ctx.applyCurriculumChoiceBlockEdit(fixture(), "sem21:3", { pick: "3", credit: "4" }), /행을 추가/);
  assert.throws(() => ctx.applyCurriculumChoiceBlockEdit(fixture(), "sem21:3", { pick: "", credit: "4" }), /정수/);
  assert.throws(() => ctx.applyCurriculumChoiceBlockEdit(fixture(), "sem21:3", { pick: "2", credit: "0" }), /학점/);
  const formula = fixture();
  formula.formulas["3:12"] = "I5+I6";
  ctx.applyCurriculumChoiceBlockEdit(formula, "sem21:3", { pick: "2", credit: "3" });
  assert.equal(formula.formulas["3:12"], "I5+I6", "수식 이수학점 칸은 수식을 유지한다");
});

test("block subjects are linked to one selection group and hours count n × credit once", () => {
  const ctx = context();
  const layout = fixture();
  const plan = ["세계사", "사회와 문화", "*화학", "문학"].map((subject) => ctx.normalizeCurriculumPlanRow({
    subject, grade: "1", opCredit: 4, semesterGroups: subject === "문학" ? { sem11: { name: "수동", pick: 1 } } : {}
  }));
  ctx.linkCurriculumChoiceBlockGroups(plan, layout);
  for (const row of plan.slice(0, 3)) {
    assert.equal(row.sem21, "●");
    assert.equal(row.grade, "2");
    assert.deepEqual(plain(row.semesterGroups.sem21), { name: "2-1 택2", pick: 2, block: "sem21:3", credit: 4 });
  }
  assert.deepEqual(plain(plan[3].semesterGroups), { sem11: { name: "수동", pick: 1 } });
  const summary = ctx.curriculumSemesterHoursSummaryHtml(plan.slice(0, 3).map((item) => ({ item })), "2");
  assert.match(summary, /2-1 · 8시간/);
  ctx.applyCurriculumChoiceBlockEdit(layout, "sem21:3", { pick: "1", credit: "4" });
  ctx.linkCurriculumChoiceBlockGroups(plan, layout);
  assert.equal(plan[0].semesterGroups.sem21.name, "2-1 택1");
  layout.rows[3][8] = "4";
  ctx.linkCurriculumChoiceBlockGroups(plan, layout);
  assert.equal(plan[0].semesterGroups.sem21, undefined, "묶음이 사라지면 연결도 해제한다");
});

test("the 구분 column is found even when a wide merged title sits above the header", () => {
  const ctx = context();
  const layout = fixture();
  layout.mergedRanges.push("A1:N1");
  const columns = plain(ctx.importedPlanColumnMap(layout));
  assert.equal(columns.division, 0);
  assert.equal(columns.subject, 3);
  const contexts = ctx.importedPlanCourseContexts(layout, ctx.importedPlanColumnMap(layout));
  assert.ok(contexts.filter((item) => item.subject !== "").every((item) => item.division === "학생 선택 교육과정"));
});

test("the embedded 2022 subject list validates names and fixed subject types", () => {
  const ctx = context();
  assert.equal(ctx.CURRICULUM_OFFICIAL_SUBJECT_ROWS.length, 833);
  assert.equal(ctx.findCurriculumOfficialSubject("공통국어1").type, "공통");
  assert.equal(ctx.findCurriculumOfficialSubject(" 사회와  문화 ").name, "사회와 문화");
  assert.equal(ctx.curriculumOfficialTypeCheck("사회와 문화", "일반선택").ok, true);
  assert.equal(ctx.curriculumOfficialTypeCheck("공통국어1", "일반선택").ok, false);
  assert.equal(ctx.curriculumOfficialTypeCheck("없는과목", "일반선택").ok, false);
  assert.equal(ctx.curriculumOfficialTypeCheck("학교자율과목☆", "진로선택").ok, true);
});

test("selected semester cells persist as an exact block and link completion credits on the right", () => {
  const ctx = context(), layout = fixture();
  const block = ctx.mergeCurriculumChoiceCells(layout, { column: 8, startRow: 3, endRow: 5 }, { pick: "2", credit: "5" });
  assert.equal(block.total, 10);
  assert.deepEqual(plain(layout.choiceBlockRanges), [{ column: 8, startRow: 3, endRow: 5 }]);
  assert.equal(layout.rows[3][12], "10");
  assert.equal(layout.formulaEdits["3:12"], true, "the completion formula must also be written on Excel export");
  const restored = plain(layout);
  ctx.applyCurriculumChoiceBlockEdit(restored, "sem21:3", { pick: "1", credit: "3" });
  assert.equal(restored.rows[3][12], "3");
  assert.equal(restored.rows[6][8], "3");
  assert.equal(ctx.curriculumChoiceBlocks(restored)[0].endRow, 5, "blank trailing cells remain inside the selected range");
});

test("spreadsheet merges are actual ranges, do not need a tag row, and preserve original values on release", () => {
  const ctx = context(), layout = fixture(), before = plain(layout);
  const result = ctx.mergeCurriculumSheetCells(layout, { column: 8, startRow: 3, endRow: 5 }, { pick: 3, credit: 4 });
  assert.ok(result.mergedRanges.includes("I4:I6"));
  assert.equal(result.rows.length, layout.rows.length);
  assert.deepEqual(plain(result.rows.slice(3, 6).map(r => r[8])), ["택2", "4", "4"]);
  const block = ctx.curriculumChoiceBlocks(result)[0];
  assert.equal(block.pick, 3);
  assert.equal(block.total, 12);
  assert.equal(result.rows[3][12], "12");
  assert.equal(result.rows[6][8], "12");
  const released = ctx.unmergeCurriculumSheetCells(result, { column: 8, startRow: 3, endRow: 5 });
  assert.deepEqual(plain(released.rows.slice(3, 6).map(r => r[8])), before.rows.slice(3, 6).map(r => r[8]));
  assert.equal(ctx.curriculumChoiceBlocks(released)[0].pick, 2);
  assert.deepEqual(layout, before);
});

test("two-semester rectangular merge links all member subjects to matching cross-intensive groups", () => {
  const ctx = context(), layout = fixture();
  const merged = ctx.mergeCurriculumSheetCells(layout, { column: 8, endColumn: 9, startRow: 3, endRow: 5 }, { pick: 2, credit: 4 });
  assert.ok(merged.mergedRanges.includes("I4:J6"));
  const blocks = ctx.curriculumChoiceBlocks(merged);
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every(b => b.crossed && b.total === 8 && b.subjects.length === 3));
  assert.equal(blocks[0].name, blocks[1].name);
  const plan = ["세계사", "사회와 문화", "화학"].map(subject => ctx.normalizeCurriculumPlanRow({ subject, grade: "2", opCredit: 4 }));
  ctx.linkCurriculumChoiceBlockGroups(plan, merged);
  assert.ok(plan.every(row => row.sem21 === "●" && row.sem22 === "●" &&
    row.semesterGroups.sem21.name === row.semesterGroups.sem22.name));
  assert.equal(merged.rows[3][12], "16");
  const entries = ctx.curriculumPlanEntries(merged).entries;
  assert.equal(entries.length, 6);
  assert.ok(entries.every(e => e.crossed && e.credit === 4));
  ctx.applyCurriculumChoiceBlockEdit(merged, blocks[0].key, { pick: 1, credit: 3 });
  assert.ok(ctx.curriculumChoiceBlocks(merged).every(b => b.total === 3));
  assert.equal(merged.rows[3][12], "6");
});

test("actual merged cells remain one rectangular cell during selection and normal display", () => {
  const ctx = context(), layout = fixture();
  const merged = ctx.mergeCurriculumSheetCells(layout, { column: 8, endColumn: 9, startRow: 3, endRow: 5 }, { pick: 2, credit: 4 });
  ctx.$ = () => ({ textContent: "" });
  ctx.renderWorkspaceContext = () => {};
  vm.runInContext(appFunction("curriculumImportedSheetHtml"), ctx);
  for (const mode of [false, true]) {
    const html = ctx.curriculumImportedSheetHtml(merged, {}, mode);
    assert.match(html, /rowspan="3" colspan="2"/);
    assert.match(html, /교차집중/);
    assert.doesNotMatch(html, /data-source-row="4" data-source-column="8"/);
    assert.doesNotMatch(html, /data-source-row="5" data-source-column="9"/);
    if (mode) assert.match(html, /rowspan="3" colspan="2"[^>]*data-choice-selectable[^>]*>교차집중과목군/);
  }
  merged.rows[3][3] = "";
  merged.retiredSubjectRows = [3];
  const html = ctx.curriculumImportedSheetHtml(merged, {}, true);
  assert.match(html, /rowspan="2" colspan="2"[^>]*data-source-row="3" data-source-column="8" data-choice-column="8" data-choice-start="3"/);
});

test("spreadsheet operations reject out-of-sheet columns without modifying the source", () => {
  const ctx = context(), layout = fixture(), before = plain(layout);
  const selection = { column: 14, endColumn: 15, startRow: 3, endRow: 4 };
  assert.throws(() => ctx.mergeCurriculumSheetCells(layout, selection), /셀/);
  assert.throws(() => ctx.insertCurriculumSheetCells(layout, selection), /셀/);
  assert.deepEqual(layout, before);
});

test("general cell merges preserve all subject records without creating an academic group", () => {
  const ctx = context(), layout = fixture();
  const merged = ctx.mergeCurriculumSheetCells(layout, { column: 3, startRow: 3, endRow: 5 }, {});
  assert.equal(merged.sheetMerges[0].kind, "plain");
  assert.equal(ctx.curriculumPlanEntries(merged).entries.length, ctx.curriculumPlanEntries(layout).entries.length);
  assert.equal(ctx.curriculumChoiceBlocks(merged).length, 1);
  assert.ok(merged.mergedRanges.includes("D4:D6"));
  const released = ctx.unmergeCurriculumSheetCells(merged, { column: 3, startRow: 3, endRow: 5 });
  assert.deepEqual(plain(released.rows.slice(3, 6).map(r=>r[3])), layout.rows.slice(3, 6).map(r=>r[3]));
});

test("cell-only insertion shifts selected columns, formulas and merges without changing unrelated columns", () => {
  const ctx = context(), layout = fixture();
  layout.formulas["6:9"] = "SUM(J4:J6)";
  const result = ctx.insertCurriculumSheetCells(layout, { column: 9, startRow: 4, endRow: 4 });
  assert.equal(result.rows.length, layout.rows.length + 1);
  assert.equal(result.rows[4][9], "");
  assert.equal(result.formulas["7:9"], "SUM(J4:J7)");
  assert.equal(result.formulas["6:8"], layout.formulas["6:8"]);
  assert.equal(result.rows[4][3], layout.rows[4][3]);
  assert.equal(result.sheetCellEdits["4:9"], true);
  assert.equal(result.formulaEdits["7:9"], true);
  const merged = ctx.mergeCurriculumSheetCells(layout, { column: 8, startRow: 3, endRow: 5 }, { pick: 2, credit: 4 });
  const inserted = ctx.insertImportedPlanLayoutRow(merged, 4, []);
  assert.equal(inserted.sheetMerges[0].reference, "I4:I7");
  assert.ok(inserted.mergedRanges.includes("I4:I7"));
  assert.throws(() => ctx.insertCurriculumSheetCells(merged, { column: 8, startRow: 4, endRow: 4 }), /기존 병합/);
});

test("exported merge labels restore automatic groups without private metadata", () => {
  const ctx = context(), layout = fixture();
  const merged = ctx.mergeCurriculumSheetCells(layout, { column: 8, endColumn: 9, startRow: 3, endRow: 5 }, { pick: 2, credit: 4 });
  const exported = plain(merged);
  exported.rows[3][8] = ctx.curriculumSheetMergeLabel(exported.sheetMerges[0]);
  delete exported.sheetMerges;
  const blocks = ctx.curriculumChoiceBlocks(exported);
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every(b => b.total === 8 && b.crossed));
});

test("saved actual merges survive row insertion without mutating snapshots or shading unchanged subjects", () => {
  const ctx = context();
  const merged = ctx.mergeCurriculumSheetCells(fixture(), { column: 8, endColumn: 9, startRow: 3, endRow: 5 }, { pick: 2, credit: 4 });
  const snapshot = ctx.curriculumVersionSnapshot(merged, [], "test.xlsx");
  merged.changeBaseline = ctx.curriculumSavedBaseline(snapshot, "saved", "2026-01-01");
  ctx.state = { curriculumPlan: [] };
  const inserted = ctx.insertImportedPlanLayoutRow(merged, 3, []);
  assert.equal(inserted.sheetMerges[0].reference, "I5:J7");
  assert.equal(snapshot.layout.sheetMerges[0].reference, "I4:J6");
  assert.equal(ctx.curriculumTableChanges(inserted).size, 0);
  const released = ctx.unmergeCurriculumSheetCells(inserted, { column: 8, endColumn: 9, startRow: 4, endRow: 6 });
  assert.equal(ctx.curriculumTableChanges(released).size, 3);
});

test("selection cannot merge across semesters, subtotals, partial blocks or partially selected original merges", () => {
  const ctx = context();
  for (const selection of [
    { column: 4, startRow: 3, endRow: 5 },
    { column: 8, startRow: 3, endRow: 6 },
    { column: 8, startRow: 4, endRow: 5 },
    { column: 8, startRow: 3, endRow: 3 }
  ]) {
    assert.throws(() => ctx.mergeCurriculumChoiceCells(fixture(), selection, { pick: "1", credit: "4" }));
  }
  const merged = fixture();
  merged.mergedRanges.push("I4:I7");
  assert.throws(() => ctx.mergeCurriculumChoiceCells(merged, { column: 8, startRow: 3, endRow: 5 }, { pick: "1", credit: "4" }), /원본 병합/);
});

test("fully selected original vertical semester merges are replaced without touching other merges or formulas", () => {
  const ctx = context(), layout = fixture();
  layout.mergedRanges.push("I5:I6");
  layout.rows[5][8] = "";
  const unrelated = layout.mergedRanges.filter((reference) => reference !== "I5:I6");
  const block = ctx.mergeCurriculumChoiceCells(layout, { column: 8, startRow: 3, endRow: 5 }, { pick: "2", credit: "4" });
  assert.deepEqual(plain(layout.mergedRanges), unrelated);
  assert.deepEqual(plain(block.subjects), ["세계사", "사회와 문화", "화학"]);
  assert.deepEqual(layout.rows.slice(3, 6).map((row) => row[8]), ["택2", "4", "4"]);
  assert.equal(layout.rows[3][12], "8");
  assert.equal(layout.rows[6][8], "8");
  assert.equal(layout.formulas["6:8"], "SUM(I5:I6)");
  assert.equal(layout.formulaEdits["3:12"], true);
  const restored = plain(layout);
  assert.equal(ctx.curriculumChoiceBlocks(restored)[0].total, 8);
  ctx.unmergeCurriculumChoiceCells(restored, { column: 8, startRow: 3, endRow: 5 });
  assert.deepEqual(restored.rows.slice(3, 6).map((row) => row[8]), ["", "4", "4"]);
});

test("unsafe original cross-semester and partial vertical merges fail before mutation", () => {
  const ctx = context();
  for (const range of ["I4:J4", "I5:I7"]) {
    const layout = fixture();
    layout.mergedRanges.push(range);
    const before = plain(layout);
    assert.throws(() => ctx.mergeCurriculumChoiceCells(layout, { column: 8, startRow: 3, endRow: 5 },
      { pick: "1", credit: "4" }), /교차집중|일부만/);
    assert.deepEqual(layout, before);
  }
});

test("row insertion shifts selected block boundaries", () => {
  const ctx = context(), previous = fixture(), next = fixture();
  previous.choiceBlockRanges = [{ column: 8, startRow: 3, endRow: 5 }];
  ctx.insertPlanFormulaRow(previous, next, 4);
  assert.deepEqual(plain(next.choiceBlockRanges), [{ column: 8, startRow: 3, endRow: 6 }]);
});

test("unmerging preserves credit cells and permits a different selection range", () => {
  const ctx = context(), layout = fixture();
  assert.equal(ctx.unmergeCurriculumChoiceCells(layout, { column: 8, startRow: 3, endRow: 3 }), 1);
  assert.equal(ctx.curriculumChoiceBlocks(layout).length, 0);
  assert.deepEqual(layout.rows.slice(3, 6).map((row) => row[8]), ["", "4", "4"]);
  const block = ctx.mergeCurriculumChoiceCells(layout, { column: 8, startRow: 4, endRow: 5 }, { pick: "1", credit: "3" });
  assert.deepEqual([block.startRow, block.endRow, block.total], [4, 5, 3]);
  assert.equal(layout.rows[3][12], "3");
});

test("merged cells omit duplicate totals and selection mode exposes individual semester cells", () => {
  const ctx = context();
  ctx.$ = () => ({ textContent: "" });
  ctx.renderWorkspaceContext = () => {};
  vm.runInContext(appFunction("curriculumImportedSheetHtml"), ctx);
  const html = ctx.curriculumImportedSheetHtml(fixture());
  assert.match(html, /data-choice-block="sem21:3"/);
  assert.doesNotMatch(html, /curriculum-choice-total/);
  const selectable = ctx.curriculumImportedSheetHtml(fixture(), {}, true);
  assert.doesNotMatch(selectable, /data-choice-block=/);
  assert.match(selectable, /data-choice-selectable data-source-row="4" data-source-column="8"/);
  assert.match(html, /data-choice-column="8" data-choice-start="3" data-choice-end="5"/);
  assert.match(html, /data-source-row="4" data-source-column="9" data-choice-column="9"/);
});

function selectionContext() {
  const listeners = {};
  const element = (dataset = {}) => ({
    dataset, style: {}, classList: { toggle() {}, remove() {} },
    setAttribute() {}, focus() {}, scrollTop: 0, scrollLeft: 0,
    addEventListener(name, handler) { listeners[name] = handler; }
  });
  const cells = [3, 4, 5, 6].map((row) => element({ sourceRow: String(row), sourceColumn: "8" }));
  const original = element({ choiceStart: "3", choiceEnd: "5", choiceColumn: "8" });
  const editable = element({ sourceRow: "6", sourceColumn: "8", choiceStart: "6", choiceEnd: "6", choiceColumn: "8" });
  const sheet = element(), table = element();
  const col = { style: {}, getBoundingClientRect: () => ({ width: 80 }) };
  const row = { style: {}, getBoundingClientRect: () => ({ height: 36 }) };
  table.rows = [row];
  table.getBoundingClientRect = () => ({ width: 800 });
  table.querySelectorAll = () => [col];
  const wrap = element();
  wrap.querySelectorAll = () => cells;
  wrap.querySelector = (selector) => {
    if (selector === ".curriculum-imported-sheet") return sheet;
    if (selector === ".curriculum-source-table") return table;
    const row = selector.match(/data-source-row="(\d+)"/)?.[1];
    return cells.find((cell) => cell.dataset.sourceRow === row);
  };
  const controls = new Map([["#curriculumPlanWrap", wrap]]);
  const ctx = vm.createContext({
    state: { curriculumImportedLayout: {} },
    $: (selector) => {
      if (!controls.has(selector)) controls.set(selector, element());
      return controls.get(selector);
    },
    document: {
      addEventListener(name, handler) { listeners[name] = handler; },
      elementFromPoint: () => ({ closest: () => cells[3] })
    },
    window: { addEventListener(name, handler) { listeners[name] = handler; } },
    curriculumChoiceBlocks: () => [],
    importedPlanColumnMap: () => ({ semesters: [6, 7, 8, 9, 10, 11] }),
    curriculumFirstCourseRow: () => 0,
    curriculumChoiceRange: () => null,
    columnName: () => "I"
  });
  vm.runInContext(`
    let curriculumFirstRowCache = null;
    let curriculumCellSelectionMode = false, curriculumCellSelection = null;
    let curriculumSelectionAnchor = null, curriculumSelectionDragging = false, curriculumSelectionGesture = null;
    function renderCurriculumStep() {
      curriculumCellSelection = curriculumSelectionAnchor = curriculumSelectionGesture = null;
      curriculumSelectionDragging = false;
    }
  `, ctx);
  vm.runInContext(appFunction("selectCurriculumCellRange"), ctx);
  vm.runInContext(appFunction("startCurriculumRangeSelection"), ctx);
  const start = app.indexOf('    $("#curriculumPlanWrap").addEventListener("pointerdown"');
  const end = app.indexOf('    $("#curriculumPlanWrap").addEventListener("keydown"', start);
  vm.runInContext(app.slice(start, end), ctx);
  const down = (cell, shiftKey = false) => listeners.pointerdown({
    target: { closest: (selector) => selector === "input, button" ? null : cell },
    button: 0, shiftKey, clientX: 10, clientY: 10, pointerId: 1, preventDefault() {}
  });
  return { ctx, listeners, cells, original, editable, down, col, row, table };
}

test("direct drag enters range selection without a mode-button click and keeps table geometry", () => {
  const { ctx, listeners, editable, down, col, row, table } = selectionContext();
  down(editable);
  assert.equal(vm.runInContext("curriculumCellSelectionMode", ctx), false, "a plain click must still allow editing");
  listeners.pointermove({ pointerId: 1, buttons: 1, clientX: 11, clientY: 11, preventDefault() {} });
  assert.equal(vm.runInContext("curriculumCellSelectionMode", ctx), false, "small mouse movements must not start a drag");
  listeners.pointermove({ pointerId: 1, buttons: 1, clientX: 10, clientY: 40, preventDefault() {} });
  assert.equal(vm.runInContext("curriculumCellSelectionMode", ctx), true);
  assert.equal(col.style.width, "80px");
  assert.equal(row.style.height, "36px");
  assert.equal(table.style.tableLayout, "fixed");
  listeners.pointercancel();
  assert.equal(vm.runInContext("curriculumSelectionGesture", ctx), null);
});

test("Shift-click uses the previous cell and includes the full span of an existing merged block", () => {
  const { ctx, original, editable, down } = selectionContext();
  down(original);
  down(editable, true);
  assert.deepEqual(plain(vm.runInContext("curriculumCellSelection", ctx)), { column: 8, startRow: 3, endRow: 6 });
});

test("Shift horizontal selection retains both semester columns in either direction", () => {
  const { ctx, cells, down } = selectionContext();
  const right = { ...cells[0], dataset: { sourceRow: "3", sourceColumn: "9" } };
  cells.push(right);
  down(cells[0]);
  ctx.selectCurriculumCellRange(right, true);
  assert.deepEqual(plain(vm.runInContext("curriculumCellSelection", ctx)),
    { column: 8, endColumn: 9, startRow: 3, endRow: 3 });
  ctx.selectCurriculumCellRange(right, false);
  ctx.selectCurriculumCellRange(cells[0], true);
  assert.deepEqual(plain(vm.runInContext("curriculumCellSelection", ctx)),
    { column: 8, endColumn: 9, startRow: 3, endRow: 3 });
});

test("vertical selection includes the entire original merged cell even when selected as the end cell", () => {
  const { ctx, cells, down } = selectionContext();
  cells[2].dataset.choiceEnd = "8";
  down(cells[0]);
  ctx.selectCurriculumCellRange(cells[2], true);
  assert.deepEqual(plain(vm.runInContext("curriculumCellSelection", ctx)), { column: 8, startRow: 3, endRow: 8 });
  ctx.selectCurriculumCellRange(cells[2], false);
  ctx.selectCurriculumCellRange(cells[0], true);
  assert.deepEqual(plain(vm.runInContext("curriculumCellSelection", ctx)), { column: 8, startRow: 3, endRow: 8 });
});

test("focus leaving an unchanged editable cell must not schedule a table re-render", () => {
  let handler;
  const ctx = vm.createContext({
    $: () => ({ addEventListener: (name, callback) => { handler = callback; } }),
    state: { curriculumImportedLayout: {}, curriculumEditBefore: {}, curriculumEditUndoRecorded: false },
    setTimeout: () => assert.fail("unchanged focusout must not reset the selection")
  });
  const start = app.indexOf('    $("#curriculumPlanWrap").addEventListener("focusout"');
  const end = app.indexOf('    $("#curriculumTopToggle").addEventListener', start);
  vm.runInContext(app.slice(start, end), ctx);
  handler({ target: { closest: () => ({}) } });
  assert.equal(ctx.state.curriculumEditBefore, null);
});

test("subject changes match names rather than inserted row positions and detect actual credit changes", () => {
  const ctx = context(), layout = fixture();
  layout.rows[3][8] = "4";
  layout.changeBaseline = { ...plain(layout), version: 2 };
  layout.rows[4][5] = "5";
  layout.rows[5][3] = "";
  const inserted = Array(14).fill("");
  inserted[3] = "새 과목";
  const next = ctx.insertImportedPlanLayoutRow(layout, 4, inserted);
  const changes = ctx.curriculumTableChanges(next);
  assert.equal(changes.get("사회와문화").kind, "changed");
  assert.equal(changes.get("화학").kind, "removed");
  assert.equal(changes.get("새과목").kind, "added");
  const restored = plain(next);
  restored.rows[5][5] = "4";
  assert.equal(ctx.curriculumTableChanges(restored).has("사회와문화"), false, "restoring credit clears the mark despite row insertion");
  restored.rows[6][3] = "화학";
  assert.equal(ctx.curriculumTableChanges(restored).has("화학"), false);
  assert.equal(ctx.curriculumTableChanges(restored).size, 1, "only the newly added subject remains changed");
});

test("last confirmed snapshot remains the baseline through draft edits and resets only on explicit save", async () => {
  const ctx = context(), layout = fixture();
  ctx.normalizeResultCourseName = (name) => String(name).replace(/\s+/g, "");
  ctx.state = {
    curriculumPlanType: "cohort", curriculumCohortYear: "2026",
    curriculumImportedLayout: layout, curriculumPlan: [], curriculumVersions: {},
    curriculumTemplateRows: [], curriculumPlanFileName: "test.xlsx"
  };
  ctx.persistState = () => true;
  const first = ctx.saveCurriculumDraftVersion({ reason: "첫 시점" });
  assert.equal(ctx.curriculumTableChanges(layout).size, 0);
  layout.rows[4][5] = "5";
  ctx.persistState();
  assert.equal(ctx.curriculumTableChanges(layout).get("사회와문화").kind, "changed");
  assert.equal(first.snapshot.layout.rows[4][5], "4");
  const second = ctx.saveCurriculumDraftVersion({ reason: "다음 시점" });
  assert.equal(ctx.curriculumTableChanges(layout).size, 0);
  layout.changeBaseline = ctx.curriculumSavedBaseline(first.snapshot, first.id, first.savedAt);
  vm.runInContext(`async ${appFunction("ensureCurriculumChangeBaseline")}`, ctx);
  await ctx.ensureCurriculumChangeBaseline(layout);
  assert.equal(layout.changeBaseline.versionId, second.id);
  assert.equal(ctx.curriculumTableChanges(layout).size, 0);
});

test("manual semester group changes shade subject names against saved plan groups", () => {
  const ctx = context(), layout = fixture();
  layout.rows[3][8] = "4";
  const plan = [{ subject: "세계사", grade: "2", sem21: "●", semesterGroups: { sem21: { name: "선택 A", pick: 1 } } }];
  const snapshot = ctx.curriculumVersionSnapshot(layout, plan, "test.xlsx");
  layout.changeBaseline = ctx.curriculumSavedBaseline(snapshot, "saved", "2026-01-01");
  ctx.state = { curriculumPlan: plan };
  assert.equal(ctx.curriculumTableChanges(layout).size, 0);
  plan[0].semesterGroups.sem21.name = "선택 B";
  assert.equal(ctx.curriculumTableChanges(layout).get("세계사").kind, "changed");
});

test("only changed subject buttons are marked, never semester, completion or subtotal cells", () => {
  const ctx = context();
  vm.runInContext(appFunction("escapeHtml"), ctx);
  ctx.$ = () => ({ textContent: "" });
  ctx.renderWorkspaceContext = () => {};
  vm.runInContext(appFunction("curriculumImportedSheetHtml"), ctx);
  const layout = fixture();
  layout.changeBaseline = { ...plain(layout), version: 2 };
  layout.rows[4][5] = "5";
  const html = ctx.curriculumImportedSheetHtml(layout);
  assert.match(html, /<button[^>]*data-change-kind="changed"[^>]*data-curriculum-subject="사회와 문화"/);
  assert.doesNotMatch(html, /<td[^>]*data-change/);
  assert.doesNotMatch(html, /<button[^>]*data-change-kind[^>]*data-curriculum-subject="세계사"/);
  assert.match(html, /data-source-row="4" data-source-column="5"[^>]*>5<\/td>/);
});

test("adding unchanged helper columns and recalculated totals does not mark subjects", () => {
  const ctx = context(), layout = fixture();
  layout.changeBaseline = { ...plain(layout), version: 2 };
  layout.rows[1][14] = "학년";
  layout.rows[3][14] = "2";
  layout.rows[3][12] = "999";
  layout.rows[6][8] = "999";
  layout.rows[4][5] = "4.0";
  layout.rows[4][3] = " 사회와  문화 ";
  assert.equal(ctx.curriculumTableChanges(layout).size, 0);
});

test("unchanged subjects moved to new rows or split into separate semester rows are not changed", () => {
  const ctx = context();
  const layout = {
    rows: [
      ["교육과정구분", "교과군", "과목유형", "과목명", "기준학점", "운영학점", "2-1", "2-2", "이수학점"],
      ["학생 선택 교육과정", "과학", "일반", "물리학", "4", "4", "4", "4", "8"],
      ["", "", "", "화학", "4", "4", "4", "", "4"]
    ],
    mergedRanges: [], rowInsertions: []
  };
  layout.changeBaseline = { ...plain(layout), version: 2 };
  const first = [...layout.rows[1]], second = [...layout.rows[1]];
  first[7] = ""; first[8] = "4";
  second[6] = ""; second[8] = "4";
  layout.rows = [layout.rows[0], layout.rows[2], second, first];
  layout.rows[1][0] = "학생 선택 교육과정";
  layout.rows[1][1] = "과학";
  layout.rows[1][2] = "일반";
  assert.equal(ctx.curriculumTableChanges(layout).size, 0);
  layout.rows[2][7] = "3";
  assert.deepEqual([...ctx.curriculumTableChanges(layout).keys()], ["물리학"]);
});

test("choice count or credit changes mark precisely the block's subjects and undo clears them", () => {
  const ctx = context(), layout = fixture();
  const outside = ["학교 지정 교육과정", "국어", "공통", "공통국어1", "4", "4", "4"];
  const next = ctx.insertImportedPlanLayoutRow(layout, 3, outside);
  next.changeBaseline = { ...plain(next), version: 2 };
  ctx.applyCurriculumChoiceBlockEdit(next, "sem21:4", { pick: "1", credit: "3" });
  assert.deepEqual([...ctx.curriculumTableChanges(next).keys()].sort(), ["세계사", "사회와문화", "화학"].sort());
  ctx.applyCurriculumChoiceBlockEdit(next, "sem21:4", { pick: "2", credit: "4" });
  assert.equal(ctx.curriculumTableChanges(next).size, 0);
});

test("a shared subject cell highlights only the newly added name", () => {
  const ctx = context(), layout = fixture();
  layout.rows[3][8] = "4";
  layout.changeBaseline = { ...plain(layout), version: 2 };
  layout.rows[4][3] = "사회와 문화, 경제";
  ctx.$ = () => ({ textContent: "" });
  ctx.renderWorkspaceContext = () => {};
  vm.runInContext(appFunction("curriculumImportedSheetHtml"), ctx);
  const html = ctx.curriculumImportedSheetHtml(layout);
  assert.match(html, /<button[^>]*data-change-kind="added"[^>]*data-curriculum-subject="경제"/);
  assert.doesNotMatch(html, /<button[^>]*data-change-kind[^>]*data-curriculum-subject="사회와 문화"/);
});

test("empty subject rows are folded by default and can be displayed without altering underlying cells", () => {
  const ctx = context(), layout = fixture();
  layout.rows[4][3] = "";
  ctx.$ = () => ({ textContent: "" });
  ctx.renderWorkspaceContext = () => {};
  vm.runInContext(appFunction("curriculumImportedSheetHtml"), ctx);
  assert.deepEqual([...ctx.curriculumEmptySubjectRows(layout)], [4]);
  const html = ctx.curriculumImportedSheetHtml(layout);
  assert.doesNotMatch(html, /data-source-row="4"/);
  assert.match(html, /data-curriculum-subject="세계사"/);
  assert.match(html, /data-curriculum-subject="화학"/);
  assert.match(html, /소계/);
  assert.match(html, /rowspan="2" data-choice-block/);
  layout.showEmptySubjectRows = true;
  assert.match(ctx.curriculumImportedSheetHtml(layout), /data-source-row="4"/);
  assert.equal(layout.rows[4][8], "4");
});

test("old cell-only baselines are not used for subject comparison before original metadata is restored", () => {
  const ctx = context(), layout = fixture();
  layout.changeBaseline = { rows: plain(layout.rows) };
  layout.rows[4][5] = "5";
  assert.equal(ctx.curriculumTableChanges(layout).size, 0);
});

test("change highlighting uses shading only without generated text or extra borders", () => {
  const css = fs.readFileSync(path.join(root, "src", "legacy.css"), "utf8");
  assert.match(css, /\.curriculum-subject-name\[data-change-kind\]\s*\{[^}]*background-color:/);
  assert.doesNotMatch(css, /td\[data-change-kind\]/);
  assert.doesNotMatch(css, /td\[data-change-note\]::(?:after|before)/);
  assert.doesNotMatch(css, /td\[data-change-kind[^\]]*\]\s*\{[^}]*(?:box-shadow|border):/);
  assert.doesNotMatch(app, /셀 아래 이전 값 표시/);
});

test("compact table hides only title rows and retains semester headers and subject cells", () => {
  const ctx = context();
  ctx.$ = () => ({ textContent: "" });
  ctx.renderWorkspaceContext = () => {};
  vm.runInContext(appFunction("curriculumImportedSheetHtml"), ctx);
  const html = ctx.curriculumImportedSheetHtml(fixture(), {}, false, true);
  assert.doesNotMatch(html, /2026학년도 신입생 교육과정 편제표/);
  assert.match(html, /1학기/);
  assert.match(html, /data-curriculum-subject="세계사"/);
  assert.match(ctx.curriculumImportedSheetHtml(fixture()), /2026학년도 신입생 교육과정 편제표/);
});

test("original comparison baseline is loaded from the archived workbook, not the current edited cells", async () => {
  const layout = fixture();
  const original = plain(layout);
  layout.archiveId = "test-archive";
  layout.sheetPath = "xl/worksheets/sheet1.xml";
  layout.rows[4][8] = "5";
  layout.changeBaseline = { rows: plain(layout.rows), source: "original" };
  let renders = 0, saves = 0;
  const ctx = vm.createContext({
    curriculumBaselineLoads: new WeakSet(),
    curriculumArchiveStore: async () => new ArrayBuffer(1),
    parseWorkbook: async () => [{ layout: { sheetPath: layout.sheetPath }, data: original }],
    cropCurriculumSheet: (sheet) => sheet.data,
    state: { curriculumImportedLayout: layout },
    renderCurriculumStep: () => { renders++; },
    persistState: () => { saves++; }
  });
  vm.runInContext(`async ${appFunction("ensureCurriculumChangeBaseline")}`, ctx);
  await ctx.ensureCurriculumChangeBaseline(layout);
  assert.equal(layout.changeBaseline.rows[4][8], "4");
  assert.equal(layout.changeBaseline.source, "original");
  assert.equal(layout.changeBaseline.version, 2);
  assert.deepEqual(plain(layout.changeBaseline.mergedRanges), original.mergedRanges);
  assert.equal(renders, 1);
  assert.equal(saves, 1);
});

test("missing archived workbooks surface a comparison error without inventing a baseline", async () => {
  const layout = { archiveId: "missing" };
  const status = { textContent: "" };
  let toast = "";
  const ctx = vm.createContext({
    curriculumBaselineLoads: new WeakSet(),
    curriculumArchiveStore: async () => null,
    parseWorkbook() {},
    state: { curriculumImportedLayout: layout },
    $: () => status,
    showAppToast: (message) => { toast = message; }
  });
  vm.runInContext(`async ${appFunction("ensureCurriculumChangeBaseline")}`, ctx);
  await ctx.ensureCurriculumChangeBaseline(layout);
  assert.equal(layout.changeBaseline, undefined);
  assert.match(status.textContent, /변경 비교 실패/);
  assert.match(toast, /원본 편제표 파일/);
});

test("merging header cells keeps them as a plain merge instead of a choice group", () => {
  const ctx = context();
  const merged = plain(ctx.mergeCurriculumSheetCells(fixture(), { startRow: 2, endRow: 2, column: 8, endColumn: 9 }, { pick: 1, credit: 4 }));
  const added = merged.sheetMerges.find((merge) => merge.reference === "I3:J3");
  assert.equal(added.kind, "plain");
  assert.equal(added.pick, undefined);
  assert.equal(merged.rows[2][8], "1학기", "header text is not replaced by a credit value");
  const body = plain(ctx.mergeCurriculumSheetCells(fixture(), { startRow: 4, endRow: 5, column: 10, endColumn: 10 }, { pick: 1, credit: 4 }));
  assert.equal(body.sheetMerges.at(-1).kind, "choice", "merges in the subject area still become choice groups");
});
