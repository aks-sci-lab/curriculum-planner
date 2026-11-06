const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
function context() {
  const ctx = vm.createContext({
    CURRICULUM_DETAIL_OPTIONS: ["공통", "일반선택", "진로선택", "융합선택"],
    CURRICULUM_SEMESTER_FIELDS: ["sem11", "sem12", "sem21", "sem22", "sem31", "sem32"],
  });
  for (const name of ["columnIndex", "columnName", "curriculumCellFill", "normalizeCurriculumDetail",
    "curriculumSelectionType", "normalizeCurriculumDivision", "normalizeCurriculumAreaName",
    "normalizeCurriculumPlanRow", "importedPlanCoveredCells", "importedPlanCourseContexts",
    "curriculumSubjectNames", "importedPlanColumnMap", "expandCurriculumLayoutRows", "insertImportedPlanLayoutRow"]) {
    const start = app.indexOf(`function ${name}(`);
    const end = app.indexOf("\n    function ", start + 1);
    assert.ok(start >= 0 && end > start, name);
    vm.runInContext(app.slice(start, end), ctx);
  }
  const workbook = fs.readFileSync(path.join(root, "curriculum-workbook.js"), "utf8");
  vm.runInContext(workbook.slice(0, workbook.indexOf('document.getElementById("exportCurriculumPlan")')), ctx);
  const versions = fs.readFileSync(path.join(root, "curriculum-versions.js"), "utf8");
  vm.runInContext(versions.slice(0, versions.indexOf("function initCurriculumVersions(")), ctx);
  const actions = fs.readFileSync(path.join(root, "curriculum-subject-actions.js"), "utf8");
  vm.runInContext(fs.readFileSync(path.join(root, "curriculum-subject-list.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, "curriculum-choice-blocks.js"), "utf8"), ctx);
  vm.runInContext(actions.slice(0, actions.indexOf('if (typeof document !== "undefined")')), ctx);
  return ctx;
}
function fixture() {
  return {
    rows: [
      ["학년", "교육과정구분", "교과군", "과목유형", "과목명", "기준학점", "운영학점", "1-1", "1-2", "2-1", "2-2", "3-1", "3-2"],
      ["2", "학생 선택 교육과정", "과학", "일반", "물리학", "4", "3", "", "", "3", "3", "", ""],
      ["3", "학생 선택 교육과정", "국어", "진로", "주제 탐구 독서", "4", "4", "", "", "", "", "4", ""],
      ["2", "학생 선택 교육과정", "사회", "융합", "세계사, 사회와 문화", "4", "2", "", "", "2", "", "", ""],
      ["", "", "", "", "합계", "", "", "", "", "5", "3", "4", ""],
    ],
    mergedRanges: [], rowInsertions: [], rowHeights: {}, cellFills: {},
    formulas: { "4:9": "SUM(J2:J4)", "4:10": "SUM(K2:K4)", "4:11": "SUM(L2:L4)" },
    columnWidths: Array(13).fill(12),
  };
}
function placements(ctx, layout, subject) {
  return plain(ctx.curriculumSubjectCatalog(layout).find((item) => item.subject === subject)?.placements || []);
}
const move = { action: "move", subject: "물리학", detail: "일반선택", grade: "1", semester: "2", credit: 6 };

test("deleting true group members preserves the merge and rejects an insufficient member count", () => {
  const ctx = context(), layout = fixture();
  const merged = ctx.mergeCurriculumSheetCells(layout, { column: 9, endColumn: 10, startRow: 1, endRow: 3 }, { pick: 2, credit: 4 });
  const deleted = ctx.buildCurriculumSubjectChange(merged, [], { action: "delete", subject: "물리학" }).layout;
  assert.ok(deleted.mergedRanges.includes("J2:K4"));
  assert.ok(ctx.curriculumChoiceBlocks(deleted).every(block => !block.subjects.includes("물리학") && block.subjects.length === 3));
  const another = ctx.buildCurriculumSubjectChange(deleted, [], { action: "delete", subject: "세계사" }).layout;
  assert.ok(ctx.curriculumChoiceBlocks(another).every(block => block.subjects.length === 2));
  const before = plain(another);
  assert.throws(() => ctx.buildCurriculumSubjectChange(another, [], { action: "delete", subject: "사회와 문화" }), /선택 수/);
  assert.deepEqual(plain(another), before);
});

test("deleting the last member removes actual merge metadata and leaves no ghost group", () => {
  const ctx = context();
  const merged = ctx.mergeCurriculumSheetCells(fixture(), { column: 9, endColumn: 10, startRow: 1, endRow: 1 }, { pick: 1, credit: 3 });
  const deleted = ctx.buildCurriculumSubjectChange(merged, [], { action: "delete", subject: "물리학" }).layout;
  assert.equal(deleted.sheetMerges.length, 0);
  assert.ok(!deleted.mergedRanges.includes("J2:K2"));
  assert.equal(ctx.curriculumChoiceBlocks(deleted).length, 0);
});

test("editing a general sheet merge releases it without overwriting hidden original subjects", () => {
  const ctx = context();
  const merged = ctx.mergeCurriculumSheetCells(fixture(), { column: 4, startRow: 1, endRow: 3 });
  ctx.writeCurriculumSubjectCell(merged, 1, 4, "");
  assert.deepEqual(plain(merged.rows.slice(1, 4).map(row => row[4])), ["", "주제 탐구 독서", "세계사, 사회와 문화"]);
  assert.ok(!merged.mergedRanges.includes("E2:E4"));
  assert.equal(merged.sheetMerges.length, 0);
});

test("cross-intensive add/remove preserves credits, formulas, and reuses the auxiliary row", () => {
  const ctx = context(), layout = fixture();
  const options = { action: "cross-add", subject: "물리학", grade: "2" };
  const added = ctx.buildCurriculumSubjectChange(layout, [], options);
  assert.equal(added.layout.rows.length, layout.rows.length + 1);
  assert.deepEqual(placements(ctx, added.layout, "물리학"), placements(ctx, layout, "물리학"));
  assert.ok(added.layout.mergedRanges.includes("J2:K2"));
  assert.ok(ctx.curriculumPlanEntries(added.layout).entries.filter((entry) => entry.subject === "물리학").every((entry) => entry.crossed));
  const subtotal = added.layout.rows.find((row) => row[4] === "합계");
  assert.equal(subtotal[9], "5");
  assert.equal(subtotal[10], "3");
  const removed = ctx.buildCurriculumSubjectChange(added.layout, [], { ...options, action: "cross-remove" });
  assert.deepEqual(placements(ctx, removed.layout, "물리학"), placements(ctx, layout, "물리학"));
  assert.ok(ctx.curriculumPlanEntries(removed.layout).entries.filter((entry) => entry.subject === "물리학").every((entry) => !entry.crossed));
  const again = ctx.buildCurriculumSubjectChange(removed.layout, [], options);
  assert.equal(again.layout.rows.length, added.layout.rows.length);
  assert.deepEqual(placements(ctx, again.layout, "물리학"), placements(ctx, layout, "물리학"));
  assert.throws(() => ctx.buildCurriculumSubjectChange(again.layout, [], options), /이미 교차집중/);
  assert.throws(() => ctx.buildCurriculumSubjectChange(layout, [], { ...options, subject: "주제 탐구 독서", grade: "3" }), /각각 학점/);
});

test("cross-intensive additions reuse existing numeric rows without increasing the sheet", () => {
  const ctx = context(), layout = fixture();
  layout.rows.splice(2, 0, Array(13).fill(""));
  layout.rows[2][9] = layout.rows[1][9]; layout.rows[1][9] = "";
  layout.rows[2][10] = layout.rows[1][10]; layout.rows[1][10] = "";
  layout.formulas = {};
  const result = ctx.buildCurriculumSubjectChange(layout, [], { action: "cross-add", subject: "물리학", grade: "2" });
  assert.equal(result.layout.rows.length, layout.rows.length);
  assert.deepEqual(placements(ctx, result.layout, "물리학"), placements(ctx, layout, "물리학"));
});

test("horizontal semester selection creates cross-intensive, and selecting its merged marker releases it", () => {
  const ctx = context(), layout = fixture();
  const selection = { column: 9, endColumn: 10, startRow: 1, endRow: 1 };
  const result = ctx.buildCurriculumCrossSelectionChange(layout, [], selection);
  assert.ok(result.layout.mergedRanges.includes("J2:K2"));
  assert.deepEqual(placements(ctx, result.layout, "물리학"), placements(ctx, layout, "물리학"));
  const released = ctx.buildCurriculumCrossSelectionChange(result.layout, [], selection, true);
  assert.ok(!released.layout.mergedRanges.includes("J2:K2"));
  assert.deepEqual(placements(ctx, released.layout, "물리학"), placements(ctx, layout, "물리학"));
  assert.ok(ctx.curriculumPlanEntries(released.layout).entries.filter(e => e.subject === "물리학").every(e => !e.crossed));
  assert.deepEqual(layout, fixture(), "source remains untouched for undo");
});

test("cross-semester selection rejects cross-grade, totals and missing credits without changing source", () => {
  const ctx = context(), layout = fixture(), before = plain(layout);
  for (const selection of [
    { column: 8, endColumn: 9, startRow: 1, endRow: 1 },
    { column: 7, endColumn: 10, startRow: 1, endRow: 1 },
    { column: 9, endColumn: 10, startRow: 4, endRow: 4 },
    { column: 11, endColumn: 12, startRow: 2, endRow: 2 }
  ]) assert.throws(() => ctx.buildCurriculumCrossSelectionChange(layout, [], selection), /같은 학년|합계|각각 학점/);
  assert.deepEqual(layout, before);
});

test("cross-intensive movement preserves semester formulas and marks relocated references for Excel export", () => {
  const ctx = context(), layout = fixture();
  layout.formulas["1:9"] = "1+2";
  layout.formulas["4:7"] = "J2+K2";
  const result = ctx.buildCurriculumSubjectChange(layout, [], { action: "cross-add", subject: "물리학", grade: "2" });
  assert.equal(result.layout.formulas["2:9"], "1+2");
  assert.equal(result.layout.formulas["5:7"], "J3+K3");
  assert.equal(result.layout.formulaEdits["2:9"], true);
  assert.equal(result.layout.formulaEdits["5:7"], true);
  assert.equal(result.layout.rows[5][7], "6");
});

test("subject moves add only a missing target semester, not grade or unused semester columns", () => {
  const ctx = context(), layout = fixture();
  for (const row of layout.rows) row.splice(0, 1);
  const sameColumns = ctx.buildCurriculumSubjectChange(layout, [], move);
  assert.equal(sameColumns.layout.rows[0].length, layout.rows[0].length);
  const minimal = { rows: [
    ["교육과정구분", "교과군", "과목유형", "과목명", "1-1"],
    ["학교지정", "수학", "공통", "수학", "3"]
  ], mergedRanges: [] };
  const result = ctx.buildCurriculumSubjectChange(minimal, [], {
    action: "move", subject: "수학", grade: "3", semester: "2", credit: 3
  });
  assert.deepEqual(plain(result.layout.rows[0]), [...minimal.rows[0], "3-2"]);
  assert.deepEqual(placements(ctx, result.layout, "수학"), [{ grade: "3", semester: "2", credit: 3 }]);
});

function versionContext() {
  const ctx = context();
  ctx.normalizeResultCourseName = (name) => String(name).replace(/\s+/g, "").toLowerCase();
  ctx.state = {
    curriculumPlanType: "cohort", curriculumCohortYear: "2026", curriculumVersions: {},
    curriculumImportedLayout: fixture(), curriculumPlan: [], curriculumTemplateRows: [],
    curriculumPlanFileName: "original.xlsx", curriculumMutationRevision: 0
  };
  ctx.persistState = () => true;
  return ctx;
}

test("explicit saves preserve independent full snapshots without pruning and rollback appends a copy", () => {
  const ctx = versionContext();
  ctx.state.curriculumImportedLayout.archiveId = "original";
  const initial = ctx.saveCurriculumDraftVersion({ reason: "최초 저장" });
  const frozen = JSON.stringify(initial);
  ctx.state.curriculumImportedLayout.rows[1][9] = "4";
  assert.equal(JSON.stringify(initial), frozen);
  for (let index = 0; index < 21; index++) ctx.saveCurriculumDraftVersion({ reason: `시점 ${index}` });
  assert.equal(ctx.state.curriculumVersions["2026"].length, 22);
  const rolledBack = ctx.rollbackCurriculumVersion(initial.id);
  assert.equal(ctx.state.curriculumVersions["2026"].length, 23);
  assert.equal(rolledBack.rollbackOf, initial.id);
  assert.equal(JSON.stringify(initial), frozen);
  assert.deepEqual(plain(rolledBack.snapshot), plain(initial.snapshot));
  assert.equal(ctx.state.curriculumImportedLayout.rows[1][9], "3");
  assert.equal(ctx.state.curriculumImportedLayout.changeBaseline.versionId, rolledBack.id);
  assert.equal(rolledBack.snapshot.layout.changeBaseline, undefined);
  ctx.state.curriculumImportedLayout.rows[1][9] = "8";
  assert.equal(rolledBack.snapshot.layout.rows[1][9], "3");
  const restored = versionContext();
  restored.state.curriculumVersions = JSON.parse(JSON.stringify(ctx.state.curriculumVersions));
  assert.equal(restored.latestCurriculumSavedVersion().id, rolledBack.id);
});

test("failed saves and rollbacks leave prior history and draft intact; legacy summaries cannot restore", () => {
  const ctx = versionContext();
  const initial = ctx.saveCurriculumDraftVersion({ reason: "처음" });
  ctx.state.curriculumImportedLayout.rows[1][9] = "4";
  const before = JSON.stringify(ctx.state);
  ctx.persistState = () => false;
  assert.throws(() => ctx.saveCurriculumDraftVersion({ reason: "실패" }), /저장하지 못/);
  assert.equal(JSON.stringify(ctx.state), before);
  assert.throws(() => ctx.rollbackCurriculumVersion(initial.id), /저장하지 못/);
  assert.equal(JSON.stringify(ctx.state), before);
  ctx.state.curriculumVersions["2026"].push({ id: "legacy", plan: initial.plan });
  assert.throws(() => ctx.rollbackCurriculumVersion("legacy"), /전체 편제표/);
});

test("adding an official subject creates its placement and subtotal without changing existing subjects", () => {
  const ctx = context(), layout = fixture(), before = plain(layout);
  const result = ctx.buildCurriculumSubjectChange(layout, [], {
    action: "add", subject: "화학", grade: "2", semester: "1", credit: 4, division: "학생 선택 교육과정"
  });
  assert.deepEqual(layout, before);
  assert.deepEqual(placements(ctx, result.layout, "화학"), [{ grade: "2", semester: "1", credit: 4 }]);
  assert.deepEqual(placements(ctx, result.layout, "물리학"), placements(ctx, layout, "물리학"));
  const added = result.plan.find((row) => row.subject === "화학");
  assert.equal(added.detail, "일반선택");
  assert.equal(added.area, "과학");
  const subtotal = result.layout.rows.findIndex((row) => row[4] === "합계");
  assert.equal(result.layout.rows[subtotal][9], "9");
  assert.throws(() => ctx.buildCurriculumSubjectChange(result.layout, result.plan, {
    action: "add", subject: "화학", grade: "2", semester: "2", credit: 4, division: "학생 선택 교육과정"
  }), /이미 편성/);
});

test("added subjects write their completion credits into the right-hand column", () => {
  const ctx = context(), layout = fixture();
  layout.rows[0][13] = "이수학점";
  layout.choiceBlockRanges = [];
  const result = ctx.buildCurriculumSubjectChange(layout, [], {
    action: "add", subject: "화학", grade: "3", semester: "2", credit: 3, division: "학생 선택 교육과정"
  });
  assert.equal(result.layout.rows.find((row) => row[4] === "화학")[13], "3");
});

test("subject additions reject unknown names, changed classifications and invalid placements", () => {
  const ctx = context();
  const options = { action: "add", subject: "화학", grade: "3", semester: "2", credit: 3, division: "학교 지정 교육과정" };
  for (const invalid of [{ subject: "목록에 없는 과목" }, { grade: "4" }, { semester: "3" }, { credit: 0 },
    { credit: Infinity }, { detail: "융합선택" }, { division: "임의구분" }]) {
    assert.throws(() => ctx.buildCurriculumSubjectChange(fixture(), [], { ...options, ...invalid }));
  }
  const result = ctx.buildCurriculumSubjectChange(fixture(), [], options);
  assert.equal(result.plan[0].division, "학교 지정 교육과정");
});

test("whole-subject moves clear old semesters, preserve total credits, create a row, and retain fixed classification", () => {
  const ctx = context(), layout = fixture(), before = plain(layout);
  const plan = [ctx.normalizeCurriculumPlanRow({ subject: "물리학", grade: "2", sem21: "●", sem22: "●" })];
  const result = ctx.buildCurriculumSubjectChange(layout, plan, move);
  assert.deepEqual(layout, before, "the input must not be mutated");
  assert.deepEqual(placements(ctx, result.layout, "물리학"), [{ grade: "1", semester: "2", credit: 6 }]);
  const item = ctx.curriculumSubjectCatalog(result.layout).find((item) => item.subject === "물리학");
  assert.equal(item.detail, "일반선택");
  assert.equal(item.area, "과학");
  assert.equal(result.plan[0].grade, "1");
  assert.deepEqual(plain(result.plan[0].semesterGroups), { sem12: { name: "", pick: 0 } });
  assert.equal(result.layout.rowInsertions.length, 1);
  assert.ok(Object.values(result.layout.formulas).includes("SUM(J2:J5)"));
  assert.equal(result.layout.rows[1][5], "");
  assert.equal(result.layout.rows[1][6], "");
  const edited = Object.entries(result.layout.formulaEdits).find(([key]) => result.layout.formulas[key] === "SUM(J2:J5)");
  assert.ok(edited, "an expanded subtotal must remain expanded in exported workbooks");
});

test("moving one name from a shared cell leaves the other subject and its credits unchanged", () => {
  const ctx = context(), layout = fixture();
  const result = ctx.buildCurriculumSubjectChange(layout, [], {
    ...move, subject: "세계사", grade: "3", semester: "2", credit: 3, detail: "융합선택",
  });
  assert.deepEqual(placements(ctx, result.layout, "세계사"), [{ grade: "3", semester: "2", credit: 3 }]);
  assert.deepEqual(placements(ctx, result.layout, "사회와 문화"), [{ grade: "2", semester: "1", credit: 2 }]);
  assert.deepEqual(placements(ctx, result.layout, "물리학"), [
    { grade: "2", semester: "1", credit: 3 }, { grade: "2", semester: "2", credit: 3 },
  ]);
});

test("swap exchanges complete semester and credit slots while subject metadata follows each subject", () => {
  const ctx = context(), layout = fixture();
  const result = ctx.buildCurriculumSubjectChange(layout, [], {
    action: "swap", subject: "물리학", targetSubject: "주제 탐구 독서", detail: "일반선택",
  });
  assert.deepEqual(placements(ctx, result.layout, "물리학"), [{ grade: "3", semester: "1", credit: 4 }]);
  assert.deepEqual(placements(ctx, result.layout, "주제 탐구 독서"), [
    { grade: "2", semester: "1", credit: 3 }, { grade: "2", semester: "2", credit: 3 },
  ]);
  const items = ctx.curriculumSubjectCatalog(result.layout);
  assert.equal(items.find((item) => item.subject === "물리학").detail, "일반선택");
  assert.equal(items.find((item) => item.subject === "물리학").area, "과학");
  assert.equal(items.find((item) => item.subject === "주제 탐구 독서").detail, "진로선택");
  assert.equal(items.find((item) => item.subject === "주제 탐구 독서").area, "국어");
});

test("delete removes all placements of just the selected subject, including shared cells", () => {
  const ctx = context(), layout = fixture();
  const deleted = ctx.buildCurriculumSubjectChange(layout, [], { action: "delete", subject: "물리학" });
  assert.deepEqual(placements(ctx, deleted.layout, "물리학"), []);
  const shared = ctx.buildCurriculumSubjectChange(deleted.layout, [], { action: "delete", subject: "세계사" });
  assert.deepEqual(placements(ctx, shared.layout, "세계사"), []);
  assert.deepEqual(placements(ctx, shared.layout, "사회와 문화"), [{ grade: "2", semester: "1", credit: 2 }]);
});

test("deleted subject rows fold automatically and clear standalone completion credits without changing row references", () => {
  const ctx = context(), layout = fixture(), before = plain(layout);
  layout.rows[0][13] = "이수학점";
  layout.rows[1][13] = "6";
  const result = ctx.buildCurriculumSubjectChange(layout, [], { action: "delete", subject: "물리학" });
  assert.deepEqual([...ctx.curriculumEmptySubjectRows(result.layout)], [1]);
  assert.equal(result.layout.rows[1][13], "");
  assert.equal(result.layout.rows.length, layout.rows.length);
  assert.equal(result.layout.formulas["4:9"], before.formulas["4:9"]);
  assert.equal(result.layout.rows[4][9], "2");
  assert.equal(result.layout.rows[4][10], "0");
  assert.deepEqual(placements(ctx, result.layout, "주제 탐구 독서"), placements(ctx, layout, "주제 탐구 독서"));
  const shifted = ctx.insertImportedPlanLayoutRow(result.layout, 1, []);
  assert.deepEqual([...shifted.retiredSubjectRows], [2]);
  const shared = ctx.buildCurriculumSubjectChange(layout, [], { action: "delete", subject: "세계사" });
  assert.ok(!ctx.curriculumEmptySubjectRows(shared.layout).includes(3));
});

test("folding detects legacy orphan rows but keeps cross-intensive credits, notes and subtotals", () => {
  const ctx = context(), layout = fixture();
  layout.rows[1][4] = "";
  layout.rows[1][13] = "6";
  assert.deepEqual([...ctx.curriculumEmptySubjectRows(layout)], [1]);
  layout.rows[1][13] = "협의 필요";
  assert.deepEqual([...ctx.curriculumEmptySubjectRows(layout)], []);
  const crossed = ctx.buildCurriculumSubjectChange(fixture(), [], { action: "cross-add", subject: "물리학", grade: "2" });
  assert.deepEqual([...ctx.curriculumEmptySubjectRows(crossed.layout)], []);
  const removed = ctx.buildCurriculumSubjectChange(crossed.layout, [], { action: "delete", subject: "물리학" });
  assert.deepEqual([...ctx.curriculumEmptySubjectRows(removed.layout)], [1, 2]);
});

test("deleting choice-block members keeps group credits and shared completion; impossible pick counts are rejected", () => {
  const ctx = context(), layout = fixture();
  layout.rows[0][13] = "이수학점";
  layout.rows[1][9] = "택1"; layout.rows[2][9] = "3"; layout.rows[3][9] = "";
  layout.rows[1][13] = "3";
  layout.mergedRanges = ["N2:N3"];
  const before = ctx.curriculumChoiceBlocks(layout)[0];
  const result = ctx.buildCurriculumSubjectChange(layout, [], { action: "delete", subject: "물리학" });
  const block = ctx.curriculumChoiceBlocks(result.layout)[0];
  assert.equal(block.total, before.total);
  assert.equal(block.pick, 1);
  assert.equal(result.layout.rows[1][13], "3");
  assert.ok(!block.subjects.includes("물리학"));
  assert.deepEqual([...ctx.curriculumEmptySubjectRows(result.layout)], [1]);
  const last = ctx.buildCurriculumSubjectChange(result.layout, [], { action: "delete", subject: "주제 탐구 독서" });
  assert.equal(ctx.curriculumChoiceBlocks(last.layout).length, 0);
  assert.equal(last.layout.rows[1][9], "");
  assert.equal(last.layout.rows[1][13], "0");
  layout.rows[1][9] = "택2";
  assert.throws(() => ctx.buildCurriculumSubjectChange(layout, [], { action: "delete", subject: "물리학" }), /선택 수를 먼저/);
});

test("missing grade and semester columns are created without inventing a classification", () => {
  const ctx = context();
  const layout = { rows: [
    ["과목유형", "과목명", "기준학점", "운영학점", "1-1"],
    ["융합", "수학", "3", "3", "3"],
  ], mergedRanges: [], rowInsertions: [] };
  const result = ctx.buildCurriculumSubjectChange(layout, [], {
    ...move, subject: "수학", grade: "3", semester: "2", credit: 3, detail: "융합선택",
  });
  assert.deepEqual(placements(ctx, result.layout, "수학"), [{ grade: "3", semester: "2", credit: 3 }]);
  assert.equal(ctx.curriculumSubjectCatalog(result.layout)[0].detail, "융합선택");
});

test("fixed course classifications cannot be changed and missing classifications are not guessed", () => {
  const ctx = context(), layout = fixture(), before = plain(layout);
  assert.throws(() => ctx.buildCurriculumSubjectChange(layout, [], { ...move, detail: "융합선택" }), /고정 분류/);
  assert.deepEqual(layout, before);
  layout.rows[1][3] = "";
  assert.equal(ctx.curriculumSubjectCatalog(layout).find((item) => item.subject === "물리학").detail, "일반선택");
  layout.rows[1][4] = "목록에 없는 과목";
  assert.throws(() => ctx.buildCurriculumSubjectChange(layout, [], { ...move, subject: "목록에 없는 과목" }), /기준 목록/);
  const missingTarget = fixture();
  [missingTarget.rows[1], missingTarget.rows[2]] = [missingTarget.rows[2], missingTarget.rows[1]];
  missingTarget.rows[1][3] = "";
  missingTarget.rows[1][4] = "목록에 없는 과목";
  assert.throws(() => ctx.buildCurriculumSubjectChange(missingTarget, [], {
    action: "swap", subject: "물리학", targetSubject: "목록에 없는 과목",
  }), /기준 목록/);
});

test("division-only changes preserve all semesters, credits and fixed types and exclude school-designated groups", () => {
  const ctx = context(), layout = fixture();
  const result = ctx.buildCurriculumSubjectChange(layout, [], {
    action: "division", subject: "물리학", division: "학교 지정 교육과정",
  });
  assert.deepEqual(placements(ctx, result.layout, "물리학"), placements(ctx, layout, "물리학"));
  const selected = ctx.curriculumSubjectCatalog(result.layout).find((item) => item.subject === "물리학");
  assert.equal(selected.division, "학교 지정 교육과정");
  assert.equal(selected.detail, "일반선택");
  assert.equal(selected.area, "과학");
  assert.deepEqual(plain(result.plan[0].semesterGroups), {});
  const reversed = ctx.buildCurriculumSubjectChange(result.layout, result.plan, {
    action: "division", subject: "물리학", division: "학생 선택 교육과정",
  });
  assert.equal(ctx.curriculumSubjectCatalog(reversed.layout).find((item) => item.subject === "물리학").division, "학생 선택 교육과정");
  assert.deepEqual(placements(ctx, reversed.layout, "물리학"), placements(ctx, layout, "물리학"));
  assert.throws(() => ctx.buildCurriculumSubjectChange(layout, [], {
    action: "division", subject: "물리학", division: "invalid",
  }), /교육과정/);
  assert.throws(() => ctx.buildCurriculumSubjectChange(layout, [], {
    action: "division", subject: "물리학", division: "학생 선택 교육과정",
  }), /다른 편성 구분/);
});

test("changing division of one shared-cell subject preserves the other subject's division and placements", () => {
  const ctx = context(), layout = fixture();
  const result = ctx.buildCurriculumSubjectChange(layout, [], {
    action: "division", subject: "세계사", division: "학교 지정 교육과정",
  });
  const items = ctx.curriculumSubjectCatalog(result.layout);
  assert.equal(items.find((item) => item.subject === "세계사").division, "학교 지정 교육과정");
  assert.equal(items.find((item) => item.subject === "사회와 문화").division, "학생 선택 교육과정");
  assert.deepEqual(placements(ctx, result.layout, "사회와 문화"), placements(ctx, layout, "사회와 문화"));
});

test("merged course and semester cells can be edited without deleting adjacent subjects", () => {
  const ctx = context(), layout = fixture();
  layout.rows[1][10] = "";
  layout.rows[2][4] = "화학";
  layout.rows[2][9] = "";
  layout.rows[2][11] = "";
  layout.rows[2][0] = "";
  layout.rows[2][1] = "";
  layout.rows[2][2] = "";
  layout.rows[2][3] = "";
  layout.rows[1][9] = "택1";
  layout.mergedRanges = ["A2:A3", "B2:B3", "C2:C3", "D2:D3", "J2:J3"];
  const result = ctx.buildCurriculumSubjectChange(layout, [], move);
  assert.deepEqual(placements(ctx, result.layout, "화학"), [{ grade: "2", semester: "1", credit: 4 }]);
  assert.deepEqual(placements(ctx, result.layout, "물리학"), [{ grade: "1", semester: "2", credit: 6 }]);
});

test("invalid inputs and unsupported formulas fail atomically without changing the layout", () => {
  const ctx = context(), layout = fixture(), original = plain(layout);
  for (const options of [{ ...move, grade: "4" }, { ...move, credit: 0 },
    { ...move, credit: NaN }, { ...move, detail: "invalid" },
    { action: "swap", subject: "물리학", targetSubject: "물리학", detail: "일반선택" },
    { action: "swap", subject: "물리학", targetSubject: "없는 과목", detail: "일반선택" }]) {
    assert.throws(() => ctx.buildCurriculumSubjectChange(layout, [], options));
    assert.deepEqual(layout, original);
  }
  layout.formulas["4:9"] = "IF(J2>0,1,0)";
  const unsupported = plain(layout);
  assert.throws(() => ctx.buildCurriculumSubjectChange(layout, [], move), /지원하지 않는/);
  assert.deepEqual(layout, unsupported);
});

test("semester notes and vertically merged course labels are cleared without orphaned credits", () => {
  const ctx = context(), layout = fixture();
  layout.rows[1][9] = "";
  layout.rows[1][10] = "";
  layout.rows[1][7] = "2학년/1,2학기/3학점";
  layout.mergedRanges = ["H2:M2"];
  const moved = ctx.buildCurriculumSubjectChange(layout, [], move);
  assert.deepEqual(placements(ctx, moved.layout, "물리학"), [{ grade: "1", semester: "2", credit: 6 }]);
  assert.ok(moved.layout.rows[1].slice(7, 13).every((value) => !value));
  const vertical = fixture();
  vertical.rows[2] = Array(13).fill("");
  vertical.rows[1][10] = "";
  vertical.rows[2][10] = "3";
  vertical.mergedRanges = ["E2:E3"];
  const deleted = ctx.buildCurriculumSubjectChange(vertical, [], { action: "delete", subject: "물리학" });
  assert.deepEqual(placements(ctx, deleted.layout, "물리학"), []);
  assert.equal(deleted.layout.rows[1][9], "");
  assert.equal(deleted.layout.rows[2][10], "");
});

test("subject buttons escape course names, split shared cells and leave other cells editable", () => {
  const ctx = context();
  ctx.$ = () => ({ textContent: "" });
  ctx.renderWorkspaceContext = () => {};
  for (const name of ["escapeHtml", "curriculumSubjectSignatures", "curriculumTableChanges", "curriculumChangeAttributes", "curriculumImportedSheetHtml"]) {
    const start = app.indexOf(`function ${name}(`), end = app.indexOf("\n    function ", start + 1);
    vm.runInContext(app.slice(start, end), ctx);
  }
  const layout = fixture();
  layout.rows[1][4] = '<img src=x onerror="bad">과목';
  layout.rows.push(Array(13).fill(""));
  const html = ctx.curriculumImportedSheetHtml(layout);
  assert.match(html, /data-curriculum-subject="세계사"/);
  assert.match(html, /data-curriculum-subject="사회와 문화"/);
  assert.match(html, /data-curriculum-subject="&lt;img src=x onerror=&quot;bad&quot;&gt;과목"/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /contenteditable="true"/);
  const typeCell = html.match(/<td[^>]*data-source-row="1" data-source-column="3"[^>]*>/)?.[0];
  assert.ok(typeCell);
  assert.doesNotMatch(typeCell, /contenteditable="true"/);
  assert.match(typeCell, /aria-readonly="true"/);
  const newSubjectCell = html.match(/<td[^>]*data-source-row="5" data-source-column="4"[^>]*>/)?.[0];
  assert.ok(newSubjectCell);
  assert.doesNotMatch(newSubjectCell, /contenteditable="true"/);
  assert.match(newSubjectCell, /2022 개정 교육과정 과목 목록으로 검증/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "index.html"), "utf8"), /<select id="curriculumSubjectDetail"/);
});
