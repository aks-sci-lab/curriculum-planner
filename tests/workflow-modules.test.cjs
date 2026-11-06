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
  assert.equal(sheets[0].freeze, "A5");
  assert.ok(sheets[0].rows.some((row) => row.some((cell) => cell?.f?.includes("SUM(P"))));
  const physicsRow = sheets[1].rows.findIndex((row) => row[2]?.v === "물리학");
  assert.ok(physicsRow > 0);
  assert.equal(sheets[1].rows[physicsRow][8].f, `F${physicsRow + 1}*H${physicsRow + 1}`);
  settings["2027"].allocations["과학-물리"]["1"] = 31;
  const overallocated = ctx.computeHoursStats("2027");
  assert.ok(overallocated.issues.some((issue) => issue.level === "error" && issue.text.includes("과학 세부 교과")));
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
  assert.match(ctx.status.textContent, /그룹 미확인 1개/);
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
  assert.equal(deletedDb, "curriculum-original-workbooks");
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
