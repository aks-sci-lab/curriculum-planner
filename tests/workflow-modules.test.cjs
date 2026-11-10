const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const resultImport = fs.readFileSync(path.join(root, "result-import.js"), "utf8");
const roundStatus = fs.readFileSync(path.join(root, "round-status.js"), "utf8");
const curriculumVersions = fs.readFileSync(path.join(root, "curriculum-versions.js"), "utf8");
const hoursStats = fs.readFileSync(path.join(root, "hours-stats.js"), "utf8");

function functionSource(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.notEqual(first, -1, `missing function marker ${start}`);
  assert.notEqual(last, -1, `missing function marker ${end}`);
  return source.slice(first, last);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("result preview validates round, warns on duplicate seats, and compares against stored selections", () => {
  const ctx = vm.createContext({
    document: { getElementById: () => null },
    splitGoogleFormSelections(text, known, strict) {
      const selected = String(text).split(",").map((item) => item.trim()).filter(Boolean);
      if (strict && selected.some((item) => !known.has(item))) throw new Error("편제표에 없는 선택과목입니다");
      return selected;
    },
    mergeApplications(entries, subjects) {
      const courses = (subjects["2"] || []).map((item, index) => ({
        column: `c${index}`, name: item.subject, semesterKey: item.semester
      }));
      return {
        errors: [],
        courses,
        students: entries.map((entry) => ({
          ...entry, id: `${entry.classroom}-${entry.number}`,
          selections: entry.selections.map((name) => courses.find((course) => course.name === name)),
          totalCredits: 3
        }))
      };
    },
    createRecords: () => ({ students: [], courses: [], skippedRows: [] }),
    classifyApplicationRecords: () => [],
    status: { style: {} },
    state: { currentRound: "2", applicationMenuGrade: "1", applicationImportRevision: 4 }
  });
  vm.runInContext(resultImport, ctx);
  const subjects = { "2": [
    { subject: "물리학", semester: "1", credit: 3 },
    { subject: "화학", semester: "2", credit: 3 }
  ] };
  const options = {
    fileName: "results.xlsx", round: "2", grade: "1", revision: 4, subjects, groups: [],
    existingStudents: [{ grade: "1", classroom: "1", number: "1", name: "기존", selections: [
      { name: "화학", semesterKey: "2" }
    ] }]
  };
  const rows = [
    ["차수", "학년", "반", "번호", "성명", "선택과목"],
    ["2", "1", "1", "01", "가", "물리학"],
    ["2", "1", "1", "1", "나", "물리학"],
    ["2", "2", "1", "2", "다", "물리학"]
  ];
  const preview = ctx.buildResultImportPreview([{ name: "응답", rows }], options);
  const candidate = preview.candidates[preview.selected];
  assert.equal(candidate.summary.students, 2);
  assert.equal(candidate.otherGradeCount, 1);
  assert.ok(candidate.issues.warnings.some((warning) => warning.includes("같은 반·번호")));
  assert.ok(candidate.comparison.some((item) => item.name === "화학" && item.before === 1 && item.after === 0));
  assert.equal(candidate.issues.blocking.length, 0);
  const wrongRound = ctx.buildResultImportPreview([{ name: "응답", rows: [
    rows[0], ["1", "1", "1", "1", "가", "물리학"]
  ] }], options);
  assert.match(wrongRound.candidates[0].issues.blocking[0], /차수와 현재 선택한 2차가 다릅니다/);
});

test("result confirmation rechecks round and only stores after all guards pass", () => {
  let stored = 0;
  const ctx = vm.createContext({
    document: { getElementById: () => null },
    status: { style: {}, textContent: "" },
    state: { currentRound: "3", applicationMenuGrade: "1", applicationImportRevision: 7 },
    isRoundLocked: () => false,
    classifyApplicationRecords: () => [],
    storeGradeResults: () => { stored++; return { kept: 0, dropped: 0 }; },
    renderWorkspaceContext() {}
  });
  vm.runInContext(resultImport, ctx);
  ctx.resultImportPending = {
    round: "2", grade: "1", revision: 7, fileName: "result.xlsx", selected: 0,
    candidates: [{ issues: { blocking: [] }, data: { students: [] }, summary: { students: 0 } }]
  };
  ctx.confirmResultImport();
  assert.equal(stored, 0);
  assert.match(ctx.status.textContent, /차수가 바뀌었습니다/);
  ctx.state.currentRound = "2";
  ctx.resultImportPending = {
    round: "2", grade: "1", revision: 7, fileName: "result.xlsx", selected: 0,
    candidates: [{ issues: { blocking: [] }, data: { students: [] }, summary: { students: 0 } }]
  };
  ctx.confirmResultImport();
  assert.equal(stored, 1);
  assert.match(ctx.status.textContent, /반영했습니다/);
});

test("round status locks confirmed rounds, draft deletes status, and drift detects changed inputs", () => {
  const state = {
    currentRound: "1", students: [{ grade: "1" }], courses: [],
    roundStatuses: { "1": { status: "review", snapshot: {
      openingPercent: 90, divisionPercent: 110, classBases: { "2": 10, "3": 11 }, rows: []
    } } }
  };
  const ctx = vm.createContext({
    state, document: { getElementById: () => null },
    aggregateThresholds: () => ({ openingPercent: 90, divisionPercent: 110 }),
    nextYearClassBases: () => ({ "2": 12, "3": 11 })
  });
  vm.runInContext(roundStatus, ctx);
  assert.equal(ctx.roundStatus("1"), "review");
  assert.equal(ctx.isRoundLocked("1"), false);
  ctx.setRoundStatus("1", "confirmed", { rows: [] });
  assert.equal(ctx.isRoundLocked("1"), true);
  ctx.setRoundStatus("1", "draft");
  assert.equal(state.roundStatuses["1"], undefined);
  state.roundStatuses["1"] = { status: "confirmed", snapshot: {
    openingPercent: 90, divisionPercent: 110, classBases: { "2": 10, "3": 11 }, rows: []
  } };
  assert.deepEqual(plain(ctx.roundSnapshotDrift("1")), ["내년 2학년 학급 수(확정 10)"]);
});

test("curriculum history diff reports additions, removals, changes, and semester moves", () => {
  const ctx = vm.createContext({
    document: { getElementById: () => null },
    normalizeResultCourseName: (name) => String(name).replace(/\s+/g, "").toLowerCase()
  });
  vm.runInContext(resultImport, ctx);
  vm.runInContext(curriculumVersions, ctx);
  const diff = ctx.diffCurriculumPlans([
    { g: "2", s: "1", n: "문학", c: 4, k: "지정" },
    { g: "2", s: "1", n: "물리학", c: 3, k: "선택", group: "과학 선택", pick: 2 },
    { g: "2", s: "1", n: "삭제 과목", c: 2, k: "선택" },
    { g: "2", s: "1", n: "이동 과목", c: 3, k: "선택" }
  ], [
    { g: "2", s: "1", n: "문학", c: 5, k: "지정" },
    { g: "2", s: "1", n: "물리학", c: 3, k: "지정", group: "과학 심화", pick: 1 },
    { g: "2", s: "1", n: "신규 과목", c: 2, k: "선택" },
    { g: "2", s: "2", n: "이동 과목", c: 3, k: "선택" }
  ]);
  assert.equal(diff.added[0].n, "신규 과목");
  assert.equal(diff.removed[0].n, "삭제 과목");
  assert.deepEqual(plain(diff.changed.map(({ entry }) => entry.n)), ["문학", "물리학"]);
  assert.match(diff.changed.find(({ entry }) => entry.n === "물리학").details.join(" "),
    /선택 그룹 과학 선택 → 과학 심화.*선택 수 2 → 1/);
  assert.equal(diff.moved[0].from.n, "이동 과목");
  assert.equal(diff.moved[0].to.s, "2");
});

test("annual whole-school curriculum history is isolated from same-year cohort history", () => {
  const ctx = vm.createContext({
    state: {
      curriculumPlanType: "annual",
      curriculumCohortYear: "2026",
      curriculumImportedLayout: { scope: "annual-active" },
      curriculumAnnualPlans: { "2026": { importedLayout: { scope: "annual-saved" } } },
      curriculumCohorts: { "2026": { importedLayout: { scope: "cohort" } } }
    }
  });
  vm.runInContext(curriculumVersions, ctx);
  assert.equal(ctx.activeCurriculumVersionKey(), "annual:2026");
  assert.equal(ctx.curriculumCohortLayout("annual:2026").scope, "annual-active");
  assert.equal(ctx.curriculumCohortLayout("2026").scope, "cohort");
  assert.equal(ctx.curriculumVersionScopeLabel("annual:2026"), "2026학년도 전학년 편제표");
  assert.equal(ctx.curriculumChangeImpact("annual:2026", { removed: [], moved: [] }), null);
});

test("curriculum plan parser reads merged-row credits and crossed subjects from a synthetic layout", () => {
  const ctx = vm.createContext({
    normalizeResultCourseName: (name) => String(name).replace(/\s+/g, "").toLowerCase(),
    curriculumSelectionType: (value) => /공통/.test(String(value)) ? "공통" : ""
  });
  vm.runInContext(functionSource(app, "function columnIndex(", "function curriculumCellFill("), ctx);
  vm.runInContext(functionSource(app, "function sheetMergeReferenceSet(", "function importedPlanCourseContexts("), ctx);
  vm.runInContext(functionSource(app, "function importedPlanCourseContexts(", "function importedPlanColumnMap("), ctx);
  vm.runInContext(functionSource(app, "function importedPlanColumnMap(", "function planRowsFromImportedLayout("), ctx);
  vm.runInContext(functionSource(app, "function expandCurriculumLayoutRows(", "function handleCurriculumPlanWorkbook("), ctx);
  vm.runInContext(curriculumVersions, ctx);
  const headers = ["교육과정구분", "교과군", "세부과목", "운영학점", "1학년 1학기", "1학년 2학기", "2학년 1학기", "2학년 2학기", "3학년 1학기", "3학년 2학기"];
  const layout = { mergedRanges: [], rows: [
    headers,
    ["학교지정", "예술", "음악 연주 ↔, 미술 창작", "3", "", "", "교차집중", "", "", ""],
    ["", "", "", "", "", "", "3", "", "", ""],
    ["학생선택", "과학", "물리학", "3", "", "", "택1", "", "", ""],
    ["", "", "", "", "", "", "3", "", "", ""]
  ] };
  const parsed = ctx.curriculumPlanEntries(layout);
  const crossed = parsed.entries.filter((entry) => entry.subject.includes("음악") || entry.subject.includes("미술"));
  assert.deepEqual(plain(crossed.map((entry) => [entry.subject, entry.grade, entry.semester, entry.credit, entry.names, entry.crossed])),
    [["음악 연주", "2", "1", 3, 2, true], ["미술 창작", "2", "1", 3, 2, true]]);
  const physics = parsed.entries.find((entry) => entry.subject === "물리학");
  assert.deepEqual([physics.grade, physics.semester, physics.credit, physics.kind], ["2", "1", 3, "선택"]);
});

test("hours statistics use planned classes and confirmed selections without double-counting allocations", () => {
  const planByCohort = {
    "2027": [
      { grade: "1", semester: "1", subject: "국어", area: "국어", credit: 4, kind: "지정", names: 1, nameIndex: 0 },
      { grade: "1", semester: "1", subject: "통합과학", area: "과학", credit: 3, kind: "지정", names: 1, nameIndex: 0 }
    ],
    "2026": [
      { grade: "2", semester: "1", subject: "문학", area: "국어", credit: 4, kind: "지정", names: 1, nameIndex: 0 },
      { grade: "2", semester: "1", subject: "음악 연주", area: "예술", credit: 3, kind: "지정", names: 2, nameIndex: 0, crossed: true },
      { grade: "2", semester: "1", subject: "미술 창작", area: "예술", credit: 3, kind: "지정", names: 2, nameIndex: 1, crossed: true },
      { grade: "2", semester: "1", subject: "물리학", area: "과학", credit: 3, kind: "선택", names: 1, nameIndex: 0 },
      { grade: "2", semester: "2", subject: "화학", area: "과학", credit: 3, kind: "선택", names: 1, nameIndex: 0 },
      { grade: "2", semester: "1", subject: "지구과학", area: "과학", credit: 3, kind: "선택", names: 1, nameIndex: 0 },
      { grade: "2", semester: "2", subject: "공동 과목", area: "과학", credit: 2, kind: "공동", names: 1, nameIndex: 0 },
      { grade: "2", semester: "2", subject: "진로와 직업", area: "진로", credit: 2, kind: "지정", names: 1, nameIndex: 0 }
    ],
    "2025": [
      { grade: "3", semester: "1", subject: "수학", area: "수학", credit: 3, kind: "지정", names: 1, nameIndex: 0 }
    ]
  };
  const snapshot = { rows: [
    { grade: "1", name: "물리학", semester: "1", classCount: 2, enrollment: 45, decision: "open" },
    { grade: "1", name: "화학", semester: "", classCount: 3, enrollment: 70, decision: "open" },
    { grade: "1", name: "생명과학", semester: "1", classCount: 1, enrollment: 20, decision: "open" }
  ] };
  const settings = { "2027": {
    classCounts: { "1": 10, "2": 11, "3": 11 },
    creativeHours: 2,
    teachers: Object.fromEntries(["국어", "과학-공통", "과학-물리", "과학-화학", "음악", "미술", "수학"].map((key) => [key, 1])),
    allocations: { "과학-물리": { "1": 10 } }
  } };
  const layouts = Object.fromEntries(Object.keys(planByCohort).map((year) => [year, { rows: [] }]));
  let drift = [];
  const ctx = vm.createContext({
    document: { getElementById: () => null },
    state: { curriculumCohortYear: "", curriculumCohorts: {}, hoursStats: settings, roundStatuses: { "1": { status: "confirmed", snapshot } } },
    $: (selector) => selector === "#schoolYear" ? { value: "2026" } : { value: "고등학교" },
    curriculumCohortLayout: (year) => layouts[year] || null,
    curriculumPlanEntries: (layout) => ({ entries: planByCohort[Object.keys(planByCohort).find((year) => planByCohort[year] && layout === layouts[year])] || [], issues: [] }),
    applicationRoundNumbers: () => ["1"],
    roundStatusData: () => ({ students: [{ grade: "1" }] }),
    isRoundLocked: () => true,
    buildRoundSnapshot: () => snapshot,
    roundSnapshotDrift: () => drift,
    normalizeResultCourseName: (name) => String(name).replace(/[()]/g, "").replace(/\s+/g, "").toLowerCase(),
    resultExampleList: (items) => items.join(", "),
    columnName: (index) => String.fromCharCode(65 + index),
    escapeHtml: String
  });
  vm.runInContext(hoursStats, ctx);
  const stats = ctx.computeHoursStats("2027");
  const department = (id) => stats.departments.find((item) => item.id === id);
  const item = (name) => stats.items.find((entry) => entry.subject === name);
  assert.deepEqual(plain(ctx.nextYearClassBases()), { "1": 10, "2": 11, "3": 11 });
  assert.equal(item("음악 연주").classes, 6);
  assert.equal(item("미술 창작").classes, 5);
  assert.equal(item("물리학").classes, 2);
  assert.equal(item("화학").classes, 3);
  assert.equal(item("지구과학").classes, 0);
  assert.equal(stats.items.some((entry) => entry.subject === "공동 과목"), false);
  assert.equal(department("진로").hours["2"], 22);
  assert.equal(department("과학-공통").unallocated["1"], 20);
  assert.equal(department("과학-물리").totals["1"], 16);
  assert.equal(stats.totals["1"], 186);
  assert.equal(stats.totals["2"], 9);
  assert.equal(stats.totals.excludedHours, 22);
  assert.equal(stats.totals.creative, 64);
  const sheets = ctx.buildHoursWorkbookSheets(stats);
  assert.equal(sheets[0].freeze, "D5");
  assert.equal(sheets[0].name, "2027 교사시수표");
  assert.ok(sheets[0].rows.some((row) => row.some((cell) => cell?.f?.includes("SUM(P"))));
  const physicsRow = sheets[1].rows.findIndex((row) => row[4]?.v === "물리학");
  assert.ok(physicsRow > 0);
  assert.equal(sheets[1].rows[physicsRow][10].f, `H${physicsRow + 1}*J${physicsRow + 1}`);
  assert.deepEqual(plain(sheets[1].rows[physicsRow].slice(0, 3).map((cell) => cell.v)), [2, 2026, "현 1학년"]);
  assert.equal(sheets[1].rows[physicsRow][11].v, "1차 확정");
  assert.equal(sheets[1].rows[0][11].v, "근거 차수");
  assert.deepEqual(plain(stats.grades.map((info) => info.label)),
    ["1학년(2027 입학 · 신입생)", "2학년(2026 입학 · 현 1학년 1차 확정)", "3학년(2025 입학 · 현 2학년 결과 없음)"]);
  // 원래 양식의 'N학년' 머리글에 입학연도와 근거(현 N−1학년 결과)를 붙인다.
  const headerText = sheets[0].rows[2].map((cell) => cell?.v);
  assert.ok(headerText.includes("2학년 (2026 입학 · 현 1학년 1차 확정)"));
  assert.ok(headerText.includes("3학년 (2025 입학 · 현 2학년 결과 없음)"));
  assert.equal(stats.issues.some((issue) => issue.drift), false);
  drift = ["내년 2학년 학급 수(확정 명단 반 수)"];
  const drifted = ctx.computeHoursStats("2027");
  const driftIssue = drifted.issues.find((issue) => issue.drift === "1");
  assert.ok(driftIssue && driftIssue.level === "warning" && driftIssue.action === "4");
  assert.ok(driftIssue.text.includes("1차 확정 이후") && driftIssue.text.includes("내년 2학년 학급 수"));
  assert.equal(drifted.issues.filter((issue) => issue.drift).length, 1);
  drift = [];
  settings["2027"].allocations["과학-물리"]["1"] = 31;
  const overallocated = ctx.computeHoursStats("2027");
  assert.ok(overallocated.issues.some((issue) => issue.level === "error" && issue.text.includes("과학 세부 교과")));
});

test("hours stats treat a course closed in an earlier round as closed, not as a missing result", () => {
  const entries = [
    { grade: "2", semester: "1", subject: "물리학", area: "과학", credit: 3, kind: "선택", names: 1, nameIndex: 0 },
    { grade: "2", semester: "1", subject: "지구과학", area: "과학", credit: 3, kind: "선택", names: 1, nameIndex: 0 },
    { grade: "2", semester: "2", subject: "화학", area: "과학", credit: 3, kind: "선택", names: 1, nameIndex: 0 }
  ];
  const snapshots = {
    "1": { rows: [
      { grade: "1", name: "물리학", semester: "1", classCount: 2, enrollment: 45, decision: "open" },
      { grade: "1", name: "지구과학", semester: "1", classCount: 0, enrollment: 6, decision: "closed" },
      { grade: "1", name: "화학", semester: "2", classCount: 2, enrollment: 50, decision: "open" }
    ] },
    "2": { rows: [
      { grade: "1", name: "물리학", semester: "1", classCount: 2, enrollment: 48, decision: "open" },
      { grade: "1", name: "화학", semester: "2", classCount: 2, enrollment: 53, decision: "open" }
    ] }
  };
  const layout = { rows: [] };
  const ctx = vm.createContext({
    document: { getElementById: () => null },
    state: { curriculumCohortYear: "", curriculumCohorts: {}, hoursStats: { "2027": { classCounts: { "1": 10, "2": 10, "3": 10 } } },
      roundStatuses: { "1": { status: "confirmed", snapshot: snapshots["1"] }, "2": { status: "confirmed", snapshot: snapshots["2"] } } },
    $: (selector) => selector === "#schoolYear" ? { value: "2026" } : { value: "고등학교" },
    curriculumCohortLayout: (year) => year === "2026" ? layout : null,
    curriculumPlanEntries: () => ({ entries, issues: [] }),
    applicationRoundNumbers: () => ["1", "2"],
    roundStatusData: () => ({ students: [{ grade: "1" }] }),
    isRoundLocked: () => true,
    buildRoundSnapshot: (round) => snapshots[round],
    roundSnapshotDrift: () => [],
    normalizeResultCourseName: (name) => String(name).replace(/\s+/g, "").toLowerCase(),
    resultExampleList: (items) => items.join(", "),
    columnName: (index) => String.fromCharCode(65 + index),
    escapeHtml: String
  });
  vm.runInContext(hoursStats, ctx);
  const stats = ctx.computeHoursStats("2027");
  const earth = stats.items.find((item) => item.subject === "지구과학");
  assert.equal(earth.classes, 0);
  assert.equal(earth.basis, "현 1학년 1차 폐강");
  const texts = stats.issues.map((issue) => issue.text);
  assert.equal(texts.some((text) => text.includes("지구과학") && text.includes("결과에 없어")), false);
  const closedIssue = stats.issues.find((issue) => issue.text.includes("지구과학"));
  assert.equal(closedIssue.level, "info");
  assert.ok(closedIssue.text.includes("1차에서 폐강"));
  // 앞 차수 폐강이 아닌 과목이 근거 차수에 없으면 여전히 과목명 확인 경고를 낸다.
  snapshots["1"].rows[1].decision = "open";
  const missing = ctx.computeHoursStats("2027").issues.find((issue) => issue.text.includes("지구과학"));
  assert.equal(missing.level, "warning");
  assert.ok(missing.text.includes("2차 결과에 없어"));
});

test("aggregate reports prefer positive planned class bases and otherwise use roster classes", () => {
  const ctx = vm.createContext({
    collectApplicationSubjects: () => [],
    state: {}
  });
  vm.runInContext(functionSource(app, "function aggregateRecords(", "function currentStudent("), ctx);
  const students = [
    { grade: "1", classroom: "1" }, { grade: "1", classroom: "2" }
  ];
  const planned = ctx.aggregateRecords(students, [], 90, 110, {}, {}, {}, { "2": 10 }).reports[0].summary;
  const roster = ctx.aggregateRecords(students, [], 90, 110, {}, {}, {}, {}).reports[0].summary;
  assert.equal(planned.classes, 10);
  assert.equal(planned.classSource, "planned");
  assert.equal(roster.classes, 2);
  assert.equal(roster.classSource, "roster");
});

test("application mode toggles the matching workflow tab and persists without deleting results", () => {
  const elements = new Map();
  const element = () => ({
    attributes: {}, dataset: {}, textContent: "", innerHTML: "",
    setAttribute(name, value) { this.attributes[name] = value; },
    classList: { states: {}, toggle(name, value) { this.states[name] = value; }, contains(name) { return !!this.states[name]; } }
  });
  let activeTabId = "applicationGroupsTab";
  for (const id of [
    "#applicationModeExternal", "#applicationModeWeb", "#applicationModeSummary", "#applicationModeStatus",
    "#applicationResultsTab", "#applicationResultsPanel", "#applicationOnlineTab",
    "#supabaseTeacherPanel", "#applicationGuideResults"
  ]) elements.set(id, element());
  const results = [{ grade: "1", name: "existing" }];
  const state = { applicationMode: "external", students: results };
  let persisted = 0, selectedTab = "";
  const ctx = vm.createContext({
    state,
    $: (id) => elements.get(id),
    document: { querySelector: () => {
      const current = elements.get(`#${activeTabId}`);
      return current || { classList: { contains: () => false } };
    } },
    openApplicationWorkspaceTab: (tab) => { selectedTab = tab; activeTabId = tab === "results" ? "applicationResultsTab" : `${tab === "groups" ? "applicationGroupsTab" : "applicationOnlineTab"}`; },
    persistState: () => { persisted++; }
  });
  vm.runInContext(functionSource(app, "function renderApplicationMode(", "function renderWorkflowLayout("), ctx);
  ctx.renderApplicationMode();
  assert.equal(elements.get("#applicationModeExternal").attributes["aria-pressed"], "true");
  assert.equal(elements.get("#applicationResultsTab").classList.states.hidden, false);
  assert.equal(elements.get("#applicationResultsPanel").classList.states.hidden, false);
  assert.equal(elements.get("#applicationOnlineTab").classList.states.hidden, true);
  ctx.selectApplicationMode("web");
  assert.equal(state.applicationMode, "web");
  assert.equal(elements.get("#applicationModeWeb").attributes["aria-pressed"], "true");
  assert.equal(elements.get("#applicationResultsTab").classList.states.hidden, true);
  assert.equal(elements.get("#applicationResultsPanel").classList.states.hidden, true);
  assert.equal(elements.get("#applicationOnlineTab").classList.states.hidden, false);
  assert.equal(selectedTab, "groups");
  assert.equal(state.students, results);
  assert.equal(persisted, 1);
});

function resultImportContext(extra = {}) {
  return vm.createContext({
    document: { getElementById: () => null },
    splitGoogleFormSelections: (text) => String(text).split(",").map((item) => item.trim()).filter(Boolean),
    mergeApplications: (entries, subjects) => {
      const courses = (subjects["2"] || []).map((item, index) => ({ column: `c${index}`, name: item.subject, semesterKey: item.semester }));
      return { errors: [], courses, students: entries.map((entry) => ({
        ...entry, id: `${entry.classroom}-${entry.number}`, totalCredits: 3,
        selections: entry.selections.map((name) => courses.find((course) => course.name === name) || { name, column: name })
      })) };
    },
    createRecords: () => ({ students: [], courses: [], skippedRows: [] }),
    classifyApplicationRecords: () => [],
    status: { style: {}, textContent: "" },
    state: { currentRound: "2", applicationMenuGrade: "1", applicationImportRevision: 4 },
    isRoundLocked: () => false,
    renderWorkspaceContext() {},
    ...extra
  });
}

test("import warnings offer a jump to the matching settings and can be re-validated without re-uploading", () => {
  const subjects = { "2": [{ subject: "물리학", semester: "1", credit: 3 }] };
  let optionCalls = 0, jumped = null;
  const ctx = resultImportContext({
    resultImportOptions: () => { optionCalls++; return { subjects: optionCalls > 1 ? { "2": [...subjects["2"], { subject: "화학", semester: "2", credit: 3 }] } : subjects, existingStudents: [], groups: [] }; },
    openApplicationWorkspaceTab: (name) => { jumped = name; }
  });
  vm.runInContext(resultImport, ctx);
  const rows = [["차수", "학년", "반", "번호", "성명", "선택과목"], ["2", "1", "1", "1", "가", "물리학"]];
  // 이 시점의 createRecords는 쓰지 않으므로 분류 경고를 직접 만든다.
  ctx.classifyApplicationRecords = () => ["2학년 물리학"];
  const preview = ctx.buildResultImportPreview([{ name: "응답", rows }], {
    fileName: "r.xlsx", round: "2", grade: "1", revision: 4, subjects, groups: [], existingStudents: []
  });
  const actions = preview.candidates[0].issues.actions;
  assert.deepEqual(plain(actions.map((action) => action.target)), ["groups"]);
  assert.ok(preview.sheets, "the parsed sheets are kept so the file need not be uploaded again");

  vm.runInContext("resultImportPending = null", ctx);
  ctx.resultImportPending = preview;
  ctx.resultImportElement = () => null;
  // 설정을 고쳤다고 가정하고 분류 경고가 사라진 상태에서 다시 검증한다.
  ctx.classifyApplicationRecords = () => [];
  ctx.revalidateResultImport();
  const refreshed = vm.runInContext("resultImportPending", ctx);
  assert.equal(refreshed.candidates[0].issues.actions.length, 0);
  assert.equal(optionCalls, 1, "re-validation reads the latest options");
  assert.match(ctx.status.textContent, /다시 검증했습니다/);

  // 차수가 바뀐 뒤에는 다시 검증하지 않고 미리보기를 닫는다.
  ctx.state.currentRound = "3";
  ctx.revalidateResultImport();
  assert.equal(vm.runInContext("resultImportPending", ctx), null);
  assert.match(ctx.status.textContent, /다시 업로드/);
});

test("a save failure keeps the validated preview while a stale preview is closed", () => {
  let attempts = 0, ctx;
  ctx = resultImportContext({
    storeGradeResults: () => {
      attempts++;
      if (attempts === 1) throw new (vm.runInContext("Error", ctx))("저장 공간 부족");
      return { kept: 0, dropped: 0 };
    }
  });
  vm.runInContext(resultImport, ctx);
  const makePreview = () => ({
    round: "2", grade: "1", revision: 4, fileName: "r.xlsx", selected: 0,
    candidates: [{ issues: { blocking: [] }, data: { students: [] }, summary: { students: 1 }, unclassified: ["미분류"] }]
  });
  ctx.resultImportPending = makePreview();
  ctx.confirmResultImport();
  assert.match(ctx.status.textContent, /저장 공간 부족/);
  assert.ok(vm.runInContext("resultImportPending", ctx), "preview survives a transient save error");
  ctx.confirmResultImport();
  assert.equal(attempts, 2);
  assert.match(ctx.status.textContent, /그룹 미확인 2학년 과목\(현 1학년 신청\) 1개/);
  assert.equal(vm.runInContext("resultImportPending", ctx), null);
  ctx.state.currentRound = "9";
  ctx.resultImportPending = makePreview();
  ctx.confirmResultImport();
  assert.equal(vm.runInContext("resultImportPending", ctx), null, "a stale preview is dropped");
});

test("backup status flags missing or old backups and nudges at most once per ten minutes", () => {
  const store = new Map();
  const label = { textContent: "", title: "", classList: { on: false, toggle(name, value) { this.on = value; } } };
  const toasts = [];
  const ctx = vm.createContext({
    localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
    document: { getElementById: (id) => (id === "workspaceBackupStatus" ? label : null) },
    state: { curriculumImportedLayout: null, students: [], rounds: {} },
    showAppToast: (message) => toasts.push(message),
    Date
  });
  vm.runInContext(functionSource(app, "const BACKUP_TIME_KEY", "function downloadWorkspaceBackup("), ctx);
  ctx.renderBackupStatus();
  assert.equal(label.classList.on, false, "nothing to protect yet");
  ctx.state.students = [{ id: "s" }];
  ctx.renderBackupStatus();
  assert.equal(label.textContent, "백업 없음");
  assert.equal(label.classList.on, true);
  ctx.suggestWorkspaceBackup("결과 반영");
  ctx.suggestWorkspaceBackup("결과 반영");
  assert.equal(toasts.length, 1);
  ctx.markWorkspaceBackup();
  assert.match(label.textContent, /방금 백업/);
  assert.equal(label.classList.on, false);
  ctx.suggestWorkspaceBackup("차수 확정");
  assert.equal(toasts.length, 1, "no nudge right after a backup");
});

test("workflow menu badges reflect plan, result and confirmation progress", () => {
  const roundState = { value: "draft" };
  const ctx = vm.createContext({
    state: { curriculumImportedLayout: null, curriculumPlan: [], students: [], currentRound: "1" },
    getApplicationPreparationStatus: () => ({ subjects: 3, unassigned: 1, invalidGroups: 0, hasSelections: true }),
    roundStatus: () => roundState.value
  });
  vm.runInContext(functionSource(app, "function workflowStepStates(", "function renderWorkflowStepStates("), ctx);
  let states = plain(ctx.workflowStepStates());
  assert.deepEqual(states[1], ["todo", "필요"]);
  assert.deepEqual(states[2], ["wait", "대기"]);
  ctx.state.curriculumPlan = [{}];
  states = plain(ctx.workflowStepStates());
  assert.deepEqual(states[1], ["done", "완료"]);
  assert.deepEqual(states[2], ["todo", "확인"], "unassigned subjects need attention");
  ctx.state.students = [{ id: "s" }];
  states = plain(ctx.workflowStepStates());
  assert.deepEqual(states[2], ["done", "반영됨"]);
  assert.deepEqual(states[4], ["todo", "확정 필요"]);
  roundState.value = "confirmed";
  states = plain(ctx.workflowStepStates());
  assert.deepEqual(states[4], ["done", "확정"]);
  assert.deepEqual(states[7], ["done", "가능"]);
});

test("full reset asks twice, keeps the teacher login and clears only this app's workspace data", async () => {
  const store = new Map([
    ["course-certificate-studio-v1", "{}"], ["curriculum-color-semester-groups-v3", "[]"], ["curriculum-color-semester-groups-v3:2026-seeded", "[]"],
    ["curriculum-last-backup-at", "1"], ["curriculum-cloud-links:u1", "[]"],
    ["curriculum-teacher-session-v1", "keep"], ["curriculum-google-pkce", "keep"], ["other-app", "keep"]
  ]);
  let reloaded = 0, deletedDb = null, backups = 0, answers = { prompt: "초기화", confirm: true };
  const toasts = [];
  const ctx = vm.createContext({
    localStorage: { get length() { return store.size; }, key: (index) => [...store.keys()][index], removeItem: (key) => store.delete(key) },
    indexedDB: { deleteDatabase: (name) => { deletedDb = name; const request = {}; setTimeout(() => request.onsuccess(), 0); return request; } },
    requireLocalWorkspaceAccess: () => true, lastWorkspaceBackup: () => 0, workspaceHasWork: () => true,
    downloadWorkspaceBackup: () => { backups++; }, showAppToast: (message) => toasts.push(message), Date,
    window: { confirm: () => answers.confirm, prompt: () => answers.prompt, clearTimeout() {}, location: { reload: () => { reloaded++; } } }
  });
  vm.runInContext("var statePersistenceBlocked = false, statePersistenceTimer = null;", ctx);
  vm.runInContext(functionSource(app, "const WORKSPACE_RESET_KEYS", "function downloadWorkspaceBackup("), ctx);
  answers.prompt = "취소";
  await ctx.resetWorkspaceAll();
  assert.equal(reloaded, 0);
  assert.equal(store.size, 8, "a wrong confirmation word deletes nothing");
  assert.match(toasts.at(-1), /취소/);
  answers = { prompt: "초기화", confirm: false };
  await ctx.resetWorkspaceAll();
  assert.equal(store.size, 8, "declining the warning deletes nothing");
  answers = { prompt: "초기화", confirm: true };
  await ctx.resetWorkspaceAll();
  assert.deepEqual([...store.keys()].sort(), ["curriculum-google-pkce", "curriculum-teacher-session-v1", "other-app"]);
  assert.equal(deletedDb, "curriculum-workspace-db", "the new workspace store is deleted too");
  assert.equal(reloaded, 1);
  assert.ok(backups >= 1, "a backup is offered first when there is unsaved work");
});

test("plan and result names match across Roman numerals and spacing", () => {
  const ctx = vm.createContext({});
  vm.runInContext(functionSource(app, "function normalizeRomanNumerals(", "function classifyApplicationRecords("), ctx);
  assert.equal(ctx.normalizeRomanNumerals("미적분Ⅱ"), "미적분2");
  assert.equal(ctx.normalizeRomanNumerals("물리학ⅰ"), "물리학1");
  const results = vm.createContext({ normalizeRomanNumerals: ctx.normalizeRomanNumerals });
  vm.runInContext(resultImport, results);
  assert.equal(results.normalizeResultCourseName("미적분Ⅱ"), results.normalizeResultCourseName("미적분 2"));
  assert.equal(results.normalizeResultCourseName("수학과제 탐구"), results.normalizeResultCourseName("수학과제탐구"));
  const bare = vm.createContext({ document: { getElementById: () => null } });
  vm.runInContext(resultImport, bare);
  assert.equal(bare.normalizeResultCourseName("미적분 2"), "미적분2", "works without the app helper too");
});

test("the statistics badge waits for the three cohort plans even after the round is confirmed", () => {
  const cohorts = { "2027": { plan: [{}] }, "2026": { plan: [{}] } };
  const ctx = vm.createContext({
    state: { curriculumImportedLayout: {}, curriculumPlan: [{}], students: [{ id: "s" }], currentRound: "1" },
    getApplicationPreparationStatus: () => ({ subjects: 1, unassigned: 0, invalidGroups: 0, hasSelections: true }),
    roundStatus: () => "confirmed",
    annualSourceCohorts: () => cohorts,
    $: () => ({ value: "2026" })
  });
  vm.runInContext(functionSource(app, "function workflowStepStates(", "function renderWorkflowStepStates("), ctx);
  assert.deepEqual(plain(ctx.workflowStepStates())[7], ["todo", "편제표 필요"], "2025 입학생 편제표가 없다");
  cohorts["2025"] = { plan: [{}] };
  assert.deepEqual(plain(ctx.workflowStepStates())[7], ["done", "가능"]);
});

test("bulk certificate printing reads the group settings once instead of once per course", () => {
  let reads = 0;
  const ctx = vm.createContext({
    getApplicationGroupSettings: () => { reads++; return []; },
    applicationGroupForCourse: (course, grade, groups) => { assert.ok(Array.isArray(groups), "settings are passed in"); return null; },
    resolveSemesterKey: () => "", resolveCourseCategoryForOutput: () => "과목",
    escapeHtml: String, applicationCourseLabel: String, isCoreCourse: () => false,
    $: () => ({ value: "2026", innerHTML: "" })
  });
  vm.runInContext(functionSource(app, "function courseGroupLabel(", "function courseIndexByColumn("), ctx);
  vm.runInContext(functionSource(app, "function certificateGroupSettings(", "function renderPreview("), ctx);
  const students = Array.from({ length: 50 }, (_, index) => ({ grade: "1", classroom: "1", number: String(index + 1), name: "홍", totalCredits: 8,
    selections: [{ name: "가", credits: 4 }, { name: "나", credits: 4 }] }));
  const groups = ctx.certificateGroupSettings();
  for (const student of students) ctx.certificateMarkup(student, true, groups);
  assert.equal(reads, 1, "50 certificates, one read");
});

test("the student list can be limited by grade so classes of different grades are never mixed", () => {
  const values = { "#searchInput": "", "#classFilter": "", "#gradeFilter": "" };
  const students = [
    { id: "a", grade: "1", classroom: "1", number: "1", name: "가" }, { id: "b", grade: "2", classroom: "1", number: "1", name: "나" },
    { id: "c", grade: "2", classroom: "2", number: "1", name: "다" }
  ];
  const ctx = vm.createContext({ state: { students }, $: (selector) => ({ value: values[selector] }) });
  vm.runInContext(functionSource(app, "function visibleStudents(", "function renderRoster("), ctx);
  assert.equal(ctx.visibleStudents().length, 3);
  values["#classFilter"] = "1";
  assert.equal(ctx.visibleStudents().length, 2, "1반 alone mixes the grades");
  values["#gradeFilter"] = "2";
  assert.deepEqual(plain(ctx.visibleStudents().map((s) => s.id)), ["b"]);
});

test("the retake list download names the next round without throwing", () => {
  let files = null, clicked = 0;
  const ctx = vm.createContext({
    retakeTargets: () => ({ sourceRound: "1", rows: [{ student: { grade: "2", classroom: "1", number: "3", name: "가" }, courses: ["수학과 문화"] }] }),
    columnName: (index) => "ABCDEF"[index], xmlEscape: String, createStylesXml: () => "<styleSheet/>",
    createXlsxBlob: (parts) => { files = parts; return {}; },
    document: { createElement: () => ({ click() { clicked++; } }) },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} }, setTimeout: () => 0
  });
  vm.runInContext(functionSource(app, "function downloadRetakeList(", "function applicationCohortYear("), ctx);
  ctx.downloadRetakeList();
  assert.equal(clicked, 1);
  assert.match(files["xl/workbook.xml"], /2차 대상자/);
  assert.match(files["xl/worksheets/sheet1.xml"], /신청 학년/);
});

test("a subject offered in both semesters is placed in the semester where its choosers are one pick short", () => {
  const groups = [
    { grade: "3", semester: "1", name: "3-1 택2", count: 2, courses: ["물리", "화학", "기후"] },
    { grade: "3", semester: "2", name: "3-2 택2", count: 2, courses: ["생명", "지구", "기후"] }
  ];
  const ctx = vm.createContext({ getApplicationGroupSettings: () => groups, parseSemesterFromCourseName: () => "" });
  vm.runInContext(functionSource(app, "function applicationGroupForCourse(", "function courseGroupLabel("), ctx);
  const course = (column, name) => ({ column, name });
  const courses = [course("a", "물리"), course("b", "화학"), course("c", "생명"), course("d", "지구"), course("e", "기후")];
  const student = (picks) => ({ grade: "2", selections: picks.map((column) => ({ ...courses.find((c) => c.column === column) })) });
  // 기후를 고른 학생은 1학기 2과목을 이미 채웠고 2학기는 1과목뿐이다 → 2학기에 고른 것
  const data = { courses, students: [student(["a", "b", "c", "e"]), student(["a", "b", "d", "e"]), student(["a", "b", "c", "d"])] };
  const warnings = ctx.classifyApplicationRecords(data);
  assert.deepEqual(plain(warnings), []);
  assert.deepEqual(plain(courses[4].applicationGroups["2"]), { name: "3-2 택2", semester: "2", inferred: true });
  assert.deepEqual(plain(ctx.applicationGroupForCourse(courses[4], "2", groups)), { name: "3-2 택2", semester: "2", inferred: true });
  // 증거가 엇갈리면 추측하지 않는다
  const unclear = { courses: courses.map((c) => ({ ...c })), students: [student(["a", "c", "e"]), student(["a", "b", "c", "d"])] };
  assert.deepEqual(plain(ctx.classifyApplicationRecords(unclear)), ["3학년 기후"]);
});

test("when a result sheet lists the same subject twice, the left column is the 1st semester", () => {
  const ctx = vm.createContext({ normalizeRomanNumerals: (text) => String(text ?? "").replace(/Ⅱ/g, "2") });
  vm.runInContext(functionSource(app, "function labelRepeatedCourseColumns(", "function createRecords("), ctx);
  const courses = [
    { column: 30, name: "융합과학 탐구", semesterKey: "" }, { column: 5, name: "화법과 언어", semesterKey: "" },
    { column: 12, name: "융합과학 탐구", semesterKey: "" },
    { column: 20, name: "미적분Ⅱ", semesterKey: "" }, { column: 22, name: "미적분 2", semesterKey: "2" }
  ];
  ctx.labelRepeatedCourseColumns(courses);
  const by = (column) => courses.find((course) => course.column === column);
  assert.deepEqual([by(12).semesterKey, by(12).name], ["1", "융합과학 탐구(1학기)"]);
  assert.deepEqual([by(30).semesterKey, by(30).name], ["2", "융합과학 탐구(2학기)"]);
  assert.equal(by(5).semesterKey, "", "a subject listed once is left alone");
  assert.equal(by(20).semesterKey, "1", "the unlabeled partner gets the other semester");
});

test("Roman numerals are mapped to digits, so 미적분Ⅱ matches 미적분2 but never 미적분1", () => {
  const ctx = vm.createContext({});
  vm.runInContext(functionSource(app, "const COURSE_NAME_EQUIVALENTS", "function parseGoogleFormsRows("), ctx);
  vm.runInContext(functionSource(app, "function normalizeRomanNumerals(", "function classifyApplicationRecords("), ctx);
  const known = ["미적분Ⅰ", "미적분Ⅱ", "수학과제 탐구"];
  assert.deepEqual(plain(ctx.splitGoogleFormSelections("미적분2, 수학과제탐구", known, true)), ["미적분Ⅱ", "수학과제 탐구"]);
  assert.deepEqual(plain(ctx.splitGoogleFormSelections("미적분1", known, true)), ["미적분Ⅰ"]);
  assert.throws(() => ctx.splitGoogleFormSelections("미적분3", known, true), /편제표에 없는/);
  const results = vm.createContext({ normalizeRomanNumerals: ctx.normalizeRomanNumerals, document: { getElementById: () => null } });
  vm.runInContext(resultImport, results);
  assert.equal(results.normalizeResultCourseName("미적분Ⅱ"), results.normalizeResultCourseName("미적분2"));
  assert.notEqual(results.normalizeResultCourseName("미적분Ⅰ"), results.normalizeResultCourseName("미적분2"));
  const columns = vm.createContext({ normalizeRomanNumerals: ctx.normalizeRomanNumerals });
  vm.runInContext(functionSource(app, "function labelRepeatedCourseColumns(", "function createRecords("), columns);
  const courses = [{ column: 1, name: "미적분1", semesterKey: "" }, { column: 2, name: "미적분2", semesterKey: "" }];
  columns.labelRepeatedCourseColumns(courses);
  assert.deepEqual(plain(courses.map((course) => course.semesterKey)), ["", ""], "미적분1 and 미적분2 are different subjects, not a 1st/2nd-semester pair");
});

test("aggregate uses integer math for class counts and at-risk checks and zeroes closed courses", () => {
  const ctx = vm.createContext({
    collectApplicationSubjects: () => [], state: {}, UNASSIGNED_GROUP: "미분류",
    parseSemesterFromCourseName: () => "", applicationGroupForCourse: () => null,
    parseAssignedGroupLabel: () => ({ semesterKey: "", category: "" }), applicationCourseLabel: (subject) => subject.subject
  });
  vm.runInContext(functionSource(app, "function aggregateRecords(", "function currentStudent("), ctx);
  const build = (sizes, targets) => {
    const students = []; const used = {};
    sizes.forEach((size, classIndex) => {
      for (let number = 1; number <= size; number++) {
        const selections = [];
        targets.forEach((target, column) => {
          used[column] = used[column] || 0;
          if (used[column] < target) { used[column]++; selections.push({ column }); }
        });
        students.push({ grade: "1", classroom: String(classIndex + 1), number, selections });
      }
    });
    return { students, courses: targets.map((_, column) => ({ column, name: `과목${column}` })) };
  };
  const courseOf = (aggregate, column) => aggregate.reports[0].semesters[0].groups[0].courses.find((item) => item.column === column);
  // 64명 3학급 50%/50%: 32명은 정확히 3학급, 64명은 6학급이어야 한다(실수 계산은 4·7로 올림).
  const float = build([22, 21, 21], [32, 64]);
  const a = ctx.aggregateRecords(float.students, float.courses, 50, 50);
  assert.equal(courseOf(a, 0).classCount, 3);
  assert.equal(courseOf(a, 1).classCount, 6);
  // 100명 3학급 120%: 개설기준 40.00 → 40명은 기준 충족.
  const edge = build([34, 33, 33], [40, 39]);
  const b = ctx.aggregateRecords(edge.students, edge.courses, 120, 120);
  assert.equal(courseOf(b, 0).atRisk, false);
  assert.equal(courseOf(b, 1).atRisk, true);
  // 폐강 결정은 개설 학급수 0과 합계 제외로 반영되고, 해제하면 원래 값으로 돌아온다.
  const base = build([10, 10, 10], [12, 22]);
  const open = ctx.aggregateRecords(base.students, base.courses, 90, 110, {}, {}, {}, {}, {});
  const closed = ctx.aggregateRecords(base.students, base.courses, 90, 110, {}, {}, {}, {}, { "1:1": "closed" });
  assert.equal(courseOf(open, 1).classCount, 2);
  assert.equal(courseOf(closed, 1).classCount, 0);
  assert.equal(courseOf(closed, 1).closed, true);
  assert.equal(courseOf(closed, 1).rawClassCount, 2);
  assert.equal(closed.reports[0].semesters[0].groups[0].totalClasses, open.reports[0].semesters[0].groups[0].totalClasses - 2);
});

test("round status locks threshold inputs while confirmed and the snapshot reuses the aggregate at-risk flag", () => {
  assert.match(roundStatus, /input\.disabled = status === "confirmed"/);
  assert.match(roundStatus, /const atRisk = course\.atRisk;/);
  assert.doesNotMatch(roundStatus, /course\.enrollment < summary\.openingLimit/);
  // 기준 비율·최대 인원을 바꾸면 잠금 상태를 갱신한 뒤 (개설/폐강 결정 칸이 들어 있는) 집계표를 다시 그린다.
  assert.match(app, /for \(const selector of \["#openingPercent", "#divisionPercent", "#maxClassSize"\]\)[\s\S]{0,400}?renderRoundStatusControls\(\);\n\s+renderAggregate\(\);/);
  assert.match(roundStatus, /\["openingPercent", "divisionPercent", "maxClassSize"\]/);
  assert.doesNotMatch(app + hoursStats, /renderClosurePanel/);
});

function aggregateHelpers(extra = {}) {
  const values = Object.assign(extra.values || {}, { "#openingPercent": "90", "#divisionPercent": "110", "#maxClassSize": "34", ...(extra.values || {}) });
  const ctx = vm.createContext({ $: (id) => ({ value: values[id] }), escapeHtml: String, state: {}, ...extra.globals });
  vm.runInContext(functionSource(app, "function aggregateThresholds(", "function renderAggregate("), ctx);
  return { ctx, values };
}

test("4단계 기준 미달 요약은 교사 결정(미정·폐강·개설)을 나눠 보여 '처리할 것만'과 같은 기준으로 미정만 남은 일로 센다", () => {
  const { ctx } = aggregateHelpers();
  const course = (column, atRisk) => ({ column, atRisk, enrollment: atRisk ? 3 : 40, classCount: atRisk ? 0 : 2, capacity: 34 });
  const report = { summary: { grade: "1", classes: 10, students: 300, openingLimit: 20 }, semesters: [{ name: "1학기", groups: [
    { category: "택1", courses: [course("A", true), course("B", true), course("C", true), course("D", false)], totalClasses: 2 }] }] };
  assert.deepEqual(plain(ctx.aggregateRiskCounts(report, {})), { risk: 3, undecided: 3, closed: 0, opened: 0 });
  assert.equal(ctx.aggregateRiskText(ctx.aggregateRiskCounts(report, {})), "기준 미달 3과목(폐강 확정 아님)");
  const closures = { "1:A": "closed", "1:B": "open", "1:D": "closed" };
  const counts = ctx.aggregateRiskCounts(report, closures);
  assert.deepEqual(plain(counts), { risk: 3, undecided: 1, closed: 1, opened: 1 });
  assert.equal(ctx.aggregateRiskText(counts), "기준 미달 3과목(미정 1 · 폐강 결정 1 · 개설 결정 1)");
  assert.equal(ctx.aggregateRiskText(counts, { short: true }), "미달 3(미정 1)");
  assert.equal(ctx.aggregateRiskText({ risk: 0 }), "기준 미달 0과목");
  // 미정 수는 '처리할 것만'의 미정 기준 미달 과목과 같다.
  const attention = ctx.aggregateAttention(report, closures, 34, null);
  assert.equal([...attention.courses].filter((key) => ["1:A", "1:B", "1:C"].includes(key)).length, counts.undecided);
});

test("class-count adjustment meets n × classes, gives extra classes to the fullest course, and leaves impossible groups alone", () => {
  const { ctx } = aggregateHelpers();
  const plan = (rows, target, max = 34) => {
    const result = ctx.planGroupClassCounts(rows.map(([key, enrollment, closed]) => ({ key, enrollment, closed })), target, max);
    return { ...plain(result), counts: result.counts ? plain(result.counts) : null };
  };
  // 최소 학급(34명 이하): 30→1, 60→2, 10→1 = 4. 목표 4면 그대로.
  assert.deepEqual(plan([["a", 30], ["b", 60], ["c", 10]], 4).counts, { a: 1, b: 2, c: 1 });
  // 목표 5: 남는 1학급은 학급당 인원이 가장 많은 과목에(30/1 = 60/2 동률이면 표 순서상 앞 과목).
  assert.deepEqual(plan([["a", 30], ["b", 60], ["c", 10]], 5).counts, { a: 2, b: 2, c: 1 });
  // 목표 7: a·b가 15·30명 → b, 그다음 b 20명 > a 15명 → b.
  assert.deepEqual(plan([["a", 30], ["b", 60], ["c", 10]], 7).counts, { a: 2, b: 4, c: 1 });
  // 34명 이하로는 최소 6학급이 필요한데 목표가 5면 맞출 수 없다(값을 바꾸지 않음).
  const impossible = plan([["a", 100], ["b", 100]], 5);
  assert.equal(impossible.ok, false);
  assert.equal(impossible.counts, null);
  assert.equal(impossible.minimum, 6);
  assert.match(ctx.aggregatePlanMessage(impossible), /34명 이하로는 최소 6학급이 필요해 목표 5와 맞출 수 없음 — 협의회 결정 필요/);
  // 폐강 과목은 0학급으로 빠지고, 신청자 없는 과목도 0학급이다.
  assert.deepEqual(plan([["a", 50, true], ["b", 40], ["z", 0]], 3).counts, { a: 0, b: 3, z: 0 });
  // 최대 인원은 설정값을 쓴다(40명이면 80명은 2학급).
  assert.deepEqual(plan([["a", 80], ["b", 40]], 3, 40).counts, { a: 2, b: 1 });
  assert.equal(ctx.aggregateGroupTarget({ choiceCount: 3 }, 11), 33);
  assert.equal(ctx.aggregateGroupTarget({ choiceCount: null }, 11), null);
  assert.equal(ctx.aggregateMaxClassSize(), 34);
});

test("aggregate groups carry their pick count from group settings or the 택n name and read settings once", () => {
  let reads = 0;
  const settings = [{ grade: "2", semester: "1", name: "과학 묶음", count: 3, courses: ["물리"] }];
  const ctx = vm.createContext({
    collectApplicationSubjects: () => [], UNASSIGNED_GROUP: "미분류",
    getApplicationGroupSettings: () => { reads++; return settings; },
    parseSemesterFromCourseName: () => "",
    applicationGroupForCourse: (course) => course.name === "물리" ? { name: "과학 묶음", semester: "1" }
      : course.name === "일본어" ? { name: "2-2 택2", semester: "2" } : null,
    parseAssignedGroupLabel: () => ({ semesterKey: "", category: "" }), applicationCourseLabel: (subject) => subject.subject
  });
  vm.runInContext(functionSource(app, "function aggregateRecords(", "function currentStudent("), ctx);
  const courses = [{ column: 1, name: "물리" }, { column: 2, name: "일본어" }, { column: 3, name: "기타" }];
  const students = [{ grade: "1", classroom: "1", selections: [{ column: 1 }, { column: 2 }] }];
  const groups = ctx.aggregateRecords(students, courses, 90, 110).reports[0].semesters.flatMap((semester) => semester.groups);
  assert.deepEqual(plain(groups.map((group) => [group.category, group.choiceCount])),
    [["과학 묶음", 3], ["2-2 택2", 2], ["미분류", null]]);
  assert.equal(reads, 1, "group settings are read once per aggregate, not once per course");
});

test("automatic class adjustment saves manual class counts, skips closed courses, can be undone, and is blocked while confirmed", () => {
  let locked = false;
  const students = [];
  // 현1학년 60명이 3과목 중 2과목 선택: A 50명, B 40명, C 30명.
  for (let index = 0; index < 60; index++) {
    const picks = index < 30 ? [0, 1] : index < 40 ? [1, 2] : [0, 2];
    students.push({ grade: "1", classroom: String(index % 2 + 1), number: index, selections: picks.map((column) => ({ column })) });
  }
  const state = { students, courses: [0, 1, 2].map((column) => ({ column, name: `과목${column}` })),
    classOverrides: { "1:0": 9 }, semesterAssignments: {}, groupAssignments: {}, roundClosures: { "1": {} }, currentRound: "1" };
  const values = { "#openingPercent": "90", "#divisionPercent": "110", "#maxClassSize": "34" };
  const { ctx } = aggregateHelpers({ values, globals: {
    state, collectApplicationSubjects: () => [], UNASSIGNED_GROUP: "미분류", parseSemesterFromCourseName: () => "",
    applicationGroupForCourse: () => ({ name: "2-1 택2", semester: "1" }),
    parseAssignedGroupLabel: () => ({ semesterKey: "", category: "" }), applicationCourseLabel: (subject) => subject.subject,
    nextYearClassBases: () => ({ "2": 3 }), isRoundLocked: () => locked
  } });
  vm.runInContext(functionSource(app, "function aggregateRecords(", "function currentStudent("), ctx);
  vm.runInContext(functionSource(app, "function adjustAggregateClassCounts(", "function renderRoundStatus("), ctx);
  const enrollments = ctx.aggregateRecords(students, state.courses, 90, 110).reports[0].semesters[0].groups[0].courses.map((course) => course.enrollment);
  assert.deepEqual(plain(enrollments), [50, 40, 30]);
  // 목표 2 × 3학급 = 6: 최소 2·2·1 = 5, 남는 1학급은 학급당 30명인 C에.
  const result = ctx.adjustAggregateClassCounts("1");
  assert.equal(result.problems.length, 0);
  assert.deepEqual(plain(result.changed), ["2-1 택2 13→6"], "9 (manual) + 2 + 2 recommended → 6");
  assert.deepEqual(plain(state.classOverrides), { "1:0": 2, "1:1": 2, "1:2": 2 });
  // 조정한 그룹을 기억해 그 그룹의 총 학급수 칸에 '조정 취소'를 둔다.
  assert.deepEqual(plain(vm.runInContext("[...aggregateAdjustUndo.groups]", ctx)), ["2학년 1학기\u00002-1 택2"]);
  assert.equal(ctx.undoAggregateClassAdjust(), true);
  assert.deepEqual(plain(state.classOverrides), { "1:0": 9 }, "undo restores the values from right before the adjustment");
  assert.equal(ctx.undoAggregateClassAdjust(), false, "only one adjustment is kept for undo");
  // B 폐강: B는 0학급으로 빠지고 수동 입력도 만들지 않는다. A 2·C 1에서 C 30명 → 2, A 25명 → 3, A 16.7명 → 4.
  state.roundClosures["1"] = { "1:1": "closed" };
  ctx.adjustAggregateClassCounts("1", "2학년 1학기", "2-1 택2");
  assert.deepEqual(plain(state.classOverrides), { "1:0": 4, "1:2": 2 });
  // 최대 10명이면 최소 5 + 3 = 8 > 목표 6 → 바꾸지 않고 이유를 돌려준다.
  values["#maxClassSize"] = "10";
  const impossible = ctx.adjustAggregateClassCounts("1");
  assert.deepEqual(plain(impossible.changed), []);
  assert.match(impossible.problems[0], /2-1 택2: 10명 이하로는 최소 8학급이 필요해 목표 6와 맞출 수 없음/);
  assert.deepEqual(plain(state.classOverrides), { "1:0": 4, "1:2": 2 });
  locked = true;
  assert.equal(ctx.adjustAggregateClassCounts("1"), null);
});

test("plan issues list groups that miss n × classes and courses above the per-class maximum", () => {
  const { ctx } = aggregateHelpers();
  const aggregate = { reports: [{ summary: { grade: "2", classes: 11 }, semesters: [{ name: "3학년 1학기", groups: [
    { category: "3-1 택5", choiceCount: 5, totalClasses: 57, courses: [
      { name: "물리", displayName: "물리(진로)", enrollment: 70, classCount: 2, averageClassSize: 35, closed: false },
      { name: "화학", enrollment: 60, classCount: 2, averageClassSize: 30, closed: false },
      { name: "폐강", enrollment: 80, classCount: 0, averageClassSize: 0, closed: true }
    ] },
    { category: "3-1 택1", choiceCount: 1, totalClasses: 11, courses: [] },
    { category: "미분류", choiceCount: null, totalClasses: 3, courses: [] }
  ] }] }] };
  assert.deepEqual(plain(ctx.aggregateClassPlanIssues(aggregate, 34)), [
    "3-1 택5(현2학년): 총 57학급 / 목표 55 (+2)",
    "물리(진로)(현2학년): 학급당 35.0명 > 최대 34명"
  ]);
});

test("confirming a round lists class-plan issues and asks before confirming without blocking", () => {
  const questions = [];
  let answer = false;
  const state = { currentRound: "1", students: [{ grade: "2" }], courses: [], classOverrides: {}, semesterAssignments: {}, groupAssignments: {},
    roundClosures: { "1": {} }, roundStatuses: {} };
  const report = { summary: { grade: "2", students: 1, classes: 11, classSource: "roster" }, semesters: [{ name: "3학년 1학기", order: 1, groups: [
    { category: "3-1 택5", choiceCount: 5, totalClasses: 57, courses: [{ column: 1, name: "물리", enrollment: 1, classCount: 57, averageClassSize: 0.02, atRisk: false, closed: false }] }
  ] }] };
  const ctx = vm.createContext({
    state, document: { getElementById: () => null }, window: { confirm: (text) => { questions.push(text); return answer; } },
    aggregateThresholds: () => ({ openingPercent: 90, divisionPercent: 110 }), aggregateRecords: () => ({ reports: [report] }),
    aggregateClassPlanIssues: () => ["3-1 택5(현2학년): 총 57학급 / 목표 55 (+2)"],
    syncActiveRound() {}, persistState() {}, renderAggregate() {}, renderRoundStatus() {}, renderWorkflowLayout() {},
    status: { style: {}, textContent: "" }
  });
  vm.runInContext(roundStatus, ctx);
  assert.equal(ctx.confirmCurrentRound(), false);
  assert.match(questions[0], /협의회 확정 전 조정이 필요합니다\.\n- 3-1 택5\(현2학년\): 총 57학급 \/ 목표 55 \(\+2\)/);
  assert.match(questions[0], /그래도 확정할까요\?/);
  assert.equal(ctx.isRoundLocked("1"), false);
  answer = true;
  assert.equal(ctx.confirmCurrentRound(), true, "the warning does not block confirmation");
  assert.equal(ctx.isRoundLocked("1"), true);
});

test("retake targets, the retake download and the aggregate tabs follow the selected current grade", () => {
  const state = {
    rounds: { "1": { courses: [{ column: "a", name: "물리", applicationCurrentGrade: "1" }, { column: "b", name: "기하", applicationCurrentGrade: "2" }],
      students: [
        { grade: "1", classroom: "1", number: "1", name: "가", selections: [{ column: "a", name: "물리" }] },
        { grade: "2", classroom: "1", number: "2", name: "나", selections: [{ column: "b", name: "기하" }] },
        { grade: "2", classroom: "2", number: "3", name: "다", selections: [{ column: "b", name: "기하" }] }
      ] } },
    roundClosures: { "1": { "1:a": "closed", "2:b": "closed" } }
  };
  const ctx = vm.createContext({ state, applicationRoundNumbers: () => ["1"] });
  vm.runInContext(functionSource(app, "function retakeTargets(", "function renderRetakeProgress("), ctx);
  assert.equal(ctx.retakeTargets().rows.length, 3);
  assert.equal(ctx.retakeTargets().closedCount, 2);
  assert.deepEqual(plain(ctx.retakeTargets("2").rows.map((row) => row.student.name)), ["나", "다"]);
  assert.equal(ctx.retakeTargets("2").closedCount, 1);
  assert.equal(ctx.retakeTargets("1").rows.length, 1);

  let files = null, link = null;
  const download = vm.createContext({
    retakeTargets: ctx.retakeTargets, activeAggregateGrade: () => "2",
    columnName: (index) => "ABCDEF"[index], xmlEscape: String, createStylesXml: () => "<styleSheet/>",
    createXlsxBlob: (parts) => { files = parts; return {}; },
    document: { createElement: () => (link = { click() {} }) },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} }, setTimeout: () => 0
  });
  vm.runInContext(functionSource(app, "function downloadRetakeList(", "function applicationCohortYear("), download);
  download.downloadRetakeList();
  assert.equal(link.download, "2차_수강신청_대상자_현2학년(1차_기준).xlsx");
  assert.match(files["xl/workbook.xml"], /name="2차 대상자\(현2학년\)"/);
  assert.doesNotMatch(files["xl/worksheets/sheet1.xml"], />가</, "the other grade is not exported");
  assert.match(files["xl/worksheets/sheet1.xml"], />나</);

  // 학년 탭은 화면 상태: 결과가 없는 학년을 고른 상태면 전체로 돌아가고, 저장 자료에는 넣지 않는다.
  const { ctx: tabs } = aggregateHelpers({ globals: { state: { students: [{ grade: "2" }] } } });
  vm.runInContext('aggregateGradeScope = "2";', tabs);
  assert.equal(tabs.activeAggregateGrade(), "2");
  vm.runInContext('state.students = [{ grade: "1" }];', tabs);
  assert.equal(tabs.activeAggregateGrade(), "", "a round without that grade shows every grade");
  vm.runInContext('state.students = [{ grade: "2" }];', tabs);
  assert.equal(tabs.activeAggregateGrade(), "2", "the chosen grade comes back when the round has it again");
  assert.doesNotMatch(app.slice(app.indexOf("function workspacePayload("), app.indexOf("function persistState(")), /aggregateGradeScope/);
});

test("result import names the file's actual current grade and the tab it belongs to", () => {
  const ctx = resultImportContext();
  vm.runInContext(resultImport, ctx);
  const subjects = { "2": [{ subject: "물리학", semester: "1", credit: 3 }] };
  const options = { fileName: "r.xlsx", round: "2", grade: "1", revision: 4, subjects, groups: [], existingStudents: [] };
  const header = ["차수", "학년", "반", "번호", "성명", "선택과목"];
  // 현 2학년 결과를 '현 1학년' 탭에 올린 경우
  const wrongTab = ctx.buildResultImportPreview([{ name: "응답", rows: [header, ["2", "2", "1", "1", "가", "물리학"], ["2", "2", "1", "2", "나", "물리학"]] }], options);
  const message = wrongTab.candidates[0].issues.blocking[0];
  assert.match(message, /이 파일은 현 2학년\(3학년 과목 신청\) 2명 결과입니다/);
  assert.match(message, /지금 선택한 탭은 '현 1학년'입니다/);
  assert.match(message, /'현 2학년' 탭에 올려 주세요/);
  assert.match(message, /학년 열은 현재 학년입니다\(현 1학년 → 2학년 과목 신청/);

  // 학생별 과목 표시 형식도 같은 안내를 쓴다. 신청 학년(3)을 적은 파일은 현재 학년으로 고치라고 알린다.
  ctx.createRecords = () => ({ students: [{ grade: "3", classroom: "1", number: "1", name: "다", selections: [] }], courses: [], skippedRows: [] });
  const targetGrade = ctx.buildResultImportPreview([{ name: "결과", rows: [] }], { ...options, grade: "2" });
  assert.match(targetGrade.candidates[0].issues.blocking[0], /학년이 '3'인 학생 1명/);
  assert.match(targetGrade.candidates[0].issues.blocking[0], /현재 학년으로 고쳐 주세요/);

  // 두 학년이 섞인 파일은 선택한 학년만 쓰고 나머지 학년이 어느 탭인지 알려 준다.
  const mixed = ctx.buildResultImportPreview([{ name: "응답", rows: [header, ["2", "1", "1", "1", "가", "물리학"], ["2", "2", "1", "1", "나", "물리학"]] }], options);
  assert.equal(mixed.candidates[0].issues.blocking.length, 0);
  assert.ok(mixed.candidates[0].issues.info.includes("현 2학년(3학년 과목 신청) 1명은 제외했습니다. '현 2학년' 탭에서 따로 올려 주세요."));
});

test("result import warnings say which grade's subjects (and which current grade) they are about", () => {
  const ctx = resultImportContext({ classifyApplicationRecords: () => ["2학년 물리학"] });
  vm.runInContext(resultImport, ctx);
  const subjects = { "2": [{ subject: "물리학", semester: "1", credit: 3 }, { subject: "화학", semester: "2", credit: 3 }] };
  const rows = [["차수", "학년", "반", "번호", "성명", "선택과목"], ["2", "1", "1", "1", "가", "물리학, 지구과학"]];
  ctx.mergeApplications = (entries) => {
    const courses = [{ column: "c0", name: "물리학", semesterKey: "1" }, { column: "c1", name: "지구과학", semesterKey: "1" }];
    return { errors: [], courses, students: entries.map((entry) => ({ ...entry, id: "s", selections: courses })) };
  };
  const preview = ctx.buildResultImportPreview([{ name: "응답", rows }], {
    fileName: "r.xlsx", round: "2", grade: "1", revision: 4, subjects, cohortYear: "2026", groups: [], existingStudents: []
  });
  const { warnings, info } = preview.candidates[0].issues;
  assert.ok(warnings.some((item) => item.startsWith("2학년 과목(현 1학년 신청) 중 2026학년도 입학생 편제표(2학년 열)에 없는 과목 1개: 지구과학")), warnings.join("\n"));
  assert.ok(warnings.some((item) => item.startsWith("선택 그룹이 정해지지 않은 2학년 과목(현 1학년 신청) 1개: 물리학.")), warnings.join("\n"));
  assert.ok(info.some((item) => item.startsWith("2026학년도 입학생 편제표(2학년 열)의 2학년 과목(현 1학년 신청) 중 결과 파일에 없는 과목 1개: 화학")), info.join("\n"));
});

test("result file line lists each current grade's file and says when a grade has none", () => {
  const ctx = vm.createContext({});
  vm.runInContext(functionSource(app, "function resultFileNameLabel(", "function clearApplicationRound("), ctx);
  assert.equal(ctx.resultFileNameLabel(null), "현 1학년: 업로드 없음 / 현 2학년: 업로드 없음");
  assert.equal(ctx.resultFileNameLabel({ fileName: "현 1학년: a.xlsx", gradeFiles: { "1": "a.xlsx" } }), "현 1학년: a.xlsx / 현 2학년: 업로드 없음");
  assert.equal(ctx.resultFileNameLabel({ gradeFiles: { "1": "a.xlsx", "2": "b.xlsx" } }), "현 1학년: a.xlsx / 현 2학년: b.xlsx");
  assert.equal(ctx.resultFileNameLabel({ fileName: "온라인 자동 연동 5명", gradeFiles: {} }), "온라인 자동 연동 5명");
  vm.runInContext(functionSource(app, "function describeUnclassifiedCourses(", "function courseGroupLabel("), ctx);
  assert.equal(ctx.describeUnclassifiedCourses(["2학년 물리학", "3학년 기하", "2학년 화학"]),
    "2학년 과목(현 1학년 신청) 물리학, 화학 / 3학년 과목(현 2학년 신청) 기하");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(html, /id="resultGradeNote">파일의 학년은 현재 학년입니다\(현 1학년 → 2학년 과목 신청\)/);
  assert.match(app, /gradeNote\.textContent = `파일의 학년은 현재 학년입니다\(현 \$\{grade\}학년/);
});

test("long help text and settings live in dialogs, leaving a one-line summary and a button on screen", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const dialogIds = new Set([...html.matchAll(/<dialog[^>]*\sid="([^"]+)"/g)].map((match) => match[1]));
  const openers = [...(html + hoursStats).matchAll(/data-open-dialog="([^"$]+)"/g)].map((match) => match[1]);
  assert.ok(openers.length >= 5);
  for (const id of openers) assert.ok(dialogIds.has(id), `${id} dialog exists`);
  const dialogBody = (id) => html.slice(html.indexOf(`id="${id}"`), html.indexOf("</dialog>", html.indexOf(`id="${id}"`)));
  // 상단 학교·학년도 설정, 2단계 결과·그룹 안내, 5단계 시수 설정은 팝업 안에 있다.
  assert.match(dialogBody("workspaceSettingsDialog"), /id="schoolYear"[\s\S]*id="schoolName"/);
  assert.doesNotMatch(html, /<details class="workspace-settings">/);
  assert.match(dialogBody("resultUploadHelpDialog"), /차수별로 올립니다[\s\S]*서버로 전송되지 않습니다/);
  assert.match(dialogBody("groupHelpDialog"), /그룹 카드로 끌어 놓아/);
  assert.match(dialogBody("hoursSettingsDialog"), /id="hoursSettingsBody"/);
  // 자주 쓰는 업로드 버튼과 탭은 화면에 그대로 둔다.
  for (const id of ["rosterInput", "addApplicationRound", "applicationGroupsTab", "applicationResultsTab", "downloadHoursStats"]) {
    assert.doesNotMatch(Object.values(Object.fromEntries([...dialogIds].map((dialog) => [dialog, dialogBody(dialog)]))).join(""), new RegExp(`id="${id}"`));
  }
  // 입력 칸이 팝업 안에 있으면 '다음 작업' 버튼이 팝업을 먼저 연다.
  assert.match(app, /const dialog = target\?\.closest\?\.\("dialog"\);\s*if \(dialog && !dialog\.open\)/);

  const ctx = vm.createContext({ escapeHtml: (value) => String(value) });
  vm.runInContext(functionSource(hoursStats, "function hoursFormat(", "function hoursStatsReadiness("), ctx);
  vm.runInContext(functionSource(hoursStats, "const HOURS_ISSUE_LABELS", "function renderHoursStats("), ctx);
  const issues = [
    { level: "info", text: "참고 문장" },
    { level: "warning", text: "확인 문장" },
    { level: "error", text: "2학년 학급 수를 입력하세요." }
  ];
  const summary = ctx.hoursIssueSummary(issues);
  assert.match(summary, /필수 1<\/span>[\s\S]*확인 1<\/span>[\s\S]*참고 1<\/span>/);
  assert.match(summary, /2학년 학급 수를 입력하세요\./, "the most urgent item is shown on the line");
  assert.match(summary, /data-open-dialog="hoursIssuesDialog"[^>]*>확인 항목 보기 \(3\)/);
  assert.match(ctx.hoursIssueSummary([]), /확인할 문제가 없습니다/);
  const settings = ctx.hoursSettingsSummary({ creativeHours: 2, grades: [
    { grade: "1", cohortYear: "2027", hasLayout: false, classes: null },
    { grade: "2", cohortYear: "2026", hasLayout: true, classes: 10, source: { round: "1", confirmed: true } },
    { grade: "3", cohortYear: "2025", hasLayout: true, classes: 11, source: null }
  ] });
  assert.match(settings, /<b>1학년<\/b> <span class="is-missing">학급 수 미입력<\/span>[\s\S]*data-hours-cohort="2027"/);
  assert.match(settings, /<b>2학년<\/b> 10학급 \(현1 1차 확정\)/);
  assert.match(settings, /<b>3학년<\/b> 11학급 \(현2 결과 없음\)/);
  assert.match(settings, /창체 2시간[\s\S]*data-open-dialog="hoursSettingsDialog"[^>]*>시수 설정</);
});
