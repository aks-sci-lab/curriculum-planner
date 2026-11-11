// 단계 간 일관성: 같은 결과 자료로 4단계 개설 학급수 = 5단계 개설반 자동 값 = 6단계 분반 수(과목·학기마다), 개설 학기 바꾸기 뒤에도 같다.
// 실제 코드(app.js 결과 분류·집계, round-status.js 스냅샷·한 출처, hours-stats.js computeHoursStats, class-sections-view.js 입력 모으기,
// course-semester-picks.js 개설 학기)를 vm에 올리고, 편제표·화면만 흉내 낸다. 가상 학생(성명 '학생n')만 쓴다. 연결 지도는 docs/data-flow.md.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const app = read("app.js");
const between = (source, start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from + 1);
  assert.ok(from >= 0 && to > from, `${start} … ${end}`);
  return source.slice(from, to);
};
const plain = (value) => JSON.parse(JSON.stringify(value));
const { GROUPS, choiceGroups } = require(path.join(root, "e2e", "lib", "plan-fixture.cjs"));
const { twoSemesterWideRows } = require(path.join(root, "e2e", "lib", "two-semester-fixture.cjs"));
const COURSE = "심화 영어";

function context() {
  // 2단계 선택 그룹(편제표 3학년 학기별 택5·택1) — 심화 영어는 3-1 택5·3-2 택5에 모두 있다.
  const groups = choiceGroups(3).map((group) => ({ grade: "3", semester: group.semester, name: `3-${group.semester} 택${group.pick}`, count: group.pick, courses: group.courses }));
  // 2025 입학생 편제표의 3학년 선택과목(5단계 curriculumPlanEntries 흉내): 학기마다 그룹 과목 하나씩.
  const entries = GROUPS.filter((group) => group.field.startsWith("sem3")).flatMap((group) => group.members.map(([area, , subject], nameIndex) => ({
    grade: "3", semester: group.field.slice(-1), subject, area, credit: group.credit, kind: "선택", names: 1, nameIndex, choiceTag: `택${group.pick}`, rowIndex: 1 })));
  const plan = { "3": [...new Map(entries.map((entry) => [entry.subject, entry])).values()].map((entry) => {
    const semesters = entries.filter((item) => item.subject === entry.subject).map((item) => item.semester);
    return { subject: entry.subject, area: entry.area, credit: entry.credit, semester: semesters.join("·"), semesterCredits: Object.fromEntries(semesters.map((semester) => [semester, entry.credit])),
      ...(semesters.length > 1 ? { sameCourseOnce: true } : {}) };
  }), "1": [], "2": [] };
  const state = { currentRound: "1", rounds: { "1": null }, roundStatuses: {}, roundClosures: { "1": {} }, students: [], courses: [], classOverrides: {}, semesterAssignments: {}, groupAssignments: {},
    hoursStats: { "2027": { classCounts: { "1": 10, "2": 11, "3": 11 } } }, courseSemesterPicks: {}, classSections: {}, curriculumCohorts: {}, curriculumCohortYear: "" };
  let revision = 0;
  const caches = new Map();
  const ctx = vm.createContext({
    document: {}, state, console,
    $: (selector) => selector === "#schoolYear" ? { value: "2026" } : selector === "#maxClassSize" ? { value: "34" } : { value: "" },
    getApplicationGroupSettings: () => groups,
    collectApplicationSubjects: () => plain(plan),
    curriculumCohortLayout: (year) => (year === "2025" ? { rows: [] } : null),
    curriculumPlanEntries: () => ({ entries, issues: [] }),
    aggregateThresholds: () => ({ openingPercent: 90, divisionPercent: 110 }),
    aggregateMaxClassSize: () => 34,
    nextYearClassBases: () => ({ "2": 11, "3": 11 }),
    applicationRoundNumbers: () => Object.keys(state.rounds).sort((a, b) => Number(a) - Number(b)),
    // 같은 state 판(revision)에서만 캐시(app.js cachedByStateRevision 흉내: 자료를 바꾸면 bump()).
    cachedByStateRevision: (name, key, compute) => { const id = `${revision}|${name}|${key}`; if (!caches.has(id)) caches.set(id, compute()); return caches.get(id); },
    resultExampleList: (items) => [...items].join(", "),
    columnName: (index) => String.fromCharCode(65 + index),
    escapeHtml: String,
    UNASSIGNED_GROUP: "미분류"
  });
  ctx.bump = () => { revision++; };
  const importer = read("result-import.js");
  vm.runInContext(between(importer, "function normalizeResultCourseName(", "function resultSeatKey("), ctx);
  vm.runInContext(between(app, "function isSelected(", "function createCurriculumPlanRecords("), ctx);
  vm.runInContext(between(app, "function aggregateRecords(", "function currentStudent("), ctx);
  vm.runInContext(between(app, "function applicationCourseLabel(", "function renderApplicationSubjects("), ctx);
  ctx.curriculumSelectionType = (value) => String(value || "");
  vm.runInContext(read("round-status.js"), ctx);
  vm.runInContext(read("hours-stats.js"), ctx);
  vm.runInContext(read("course-semester-picks.js"), ctx);
  vm.runInContext(read("class-sections.js"), ctx);
  const view = read("class-sections-view.js");
  vm.runInContext(between(view, "function classSectionsPlanSubjects(", "function classSectionsNeisFamily("), ctx);
  vm.runInContext(between(view, "function classSectionsDisplayName(", "function classSectionsFamily("), ctx);
  vm.runInContext(between(view, "function classSectionsSourceCompute(", "function classSectionsParseTimes("), ctx);
  return { ctx, state, groups };
}

// 가로형 결과(심화 영어 한 열, 학기 경계) → 2단계 분류(학기 나누기 · 저장된 개설 학기) → 지금 차수 자료.
function load({ ctx, state }, { pick = "", seed = 7 } = {}) {
  if (pick) ctx.setCourseSemesterPick("2", COURSE, pick, "2026");
  const fixture = twoSemesterWideRows({ seed });
  const data = ctx.createRecords(fixture.rows);
  ctx.classifyApplicationRecords(data);
  state.students = data.students;
  state.courses = data.courses;
  ctx.bump();
  return fixture;
}

// 과목·학기마다 4단계(집계표 개설 학급수) · 스냅샷(5·6단계 한 출처) · 5단계(개설반 자동 값) · 6단계(분반 수).
function stages({ ctx, state }) {
  const key = (name) => ctx.normalizeResultCourseName(name);
  const four = new Map();
  const aggregate = ctx.aggregateRecords(state.students, state.courses, 90, 110, state.classOverrides, state.semesterAssignments, state.groupAssignments, { "3": 11 }, {});
  for (const report of aggregate.reports) for (const semester of report.semesters) for (const group of semester.groups) for (const course of group.courses) {
    const id = `${semester.order === 1 || semester.order === 2 ? semester.order : ""}|${key(course.subjectName || course.name)}`;
    four.set(id, (four.get(id) || 0) + course.classCount);
  }
  const five = new Map();
  const stats = ctx.computeHoursStats("2027");
  for (const item of stats.items.filter((entry) => entry.grade === "3")) five.set(`${item.semester}|${key(item.subject)}`, item.autoClasses);
  const six = new Map();
  for (const group of ctx.classSectionsSourceCompute(state.currentRound, { openingPercent: 90, divisionPercent: 110 }).groups) {
    for (const course of group.courses) { const id = `${group.semester}|${key(course.key)}`; six.set(id, (six.get(id) || 0) + course.classCount); }
  }
  return { four, five, six, stats };
}

function assertSame({ four, five, six }, label) {
  for (const [id, classes] of five) {
    assert.equal(four.get(id) || 0, classes, `${label} 4단계 = 5단계 (${id})`);
    assert.equal(six.get(id) || 0, classes, `${label} 6단계 = 5단계 (${id})`);
  }
  for (const [id, classes] of four) if (id.startsWith("|")) assert.equal(classes, 0, `${label} 학기 미정 구역에 개설 학급 없음 (${id})`);
  for (const [id, classes] of six) assert.equal(five.get(id) ?? 0, classes, `${label} 6단계에만 있는 과목 없음 (${id})`);
}

test("개설 학기를 고르면 4단계·5단계·6단계 모두 그 학기 하나에만 같은 학급 수", () => {
  const env = context();
  const fixture = load(env, { pick: "2" });
  const result = stages(env);
  assertSame(result, "2학기 고름");
  const courseKey = env.ctx.normalizeResultCourseName(COURSE);
  assert.ok(result.five.get(`2|${courseKey}`) > 0, "2학기 개설");
  assert.equal(result.five.get(`1|${courseKey}`), 0, "1학기는 편제표에만 있고 개설 안 함 → 0");
  const first = result.stats.items.find((item) => item.grade === "3" && item.semester === "1" && item.subject === COURSE);
  assert.match(first.basis, /두 학기 편성 · .*2학기만 개설/);
  assert.ok(!result.stats.issues.some((issue) => issue.text.includes(COURSE)), "한 학기만 개설은 경고가 아니다");
  // 그 과목을 고른 학생 전부가 2학기(학생별로 섞지 않음).
  const chosen = env.state.students.filter((student) => student.selections.some((selection) => env.ctx.courseSemesterPickKey(selection.name) === env.ctx.courseSemesterPickKey(COURSE)));
  assert.equal(chosen.length, fixture.firstCount + fixture.secondCount);
  assert.ok(chosen.every((student) => student.selections.filter((selection) => env.ctx.courseSemesterPickKey(selection.name) === env.ctx.courseSemesterPickKey(COURSE)).every((selection) => selection.semesterKey === "2")));
});

test("고르지 않으면 지금 규칙(학기 경계 → 학생별 추정)으로 두 학기에 나뉘어도 단계마다 학기별 값이 같다", () => {
  const env = context();
  load(env);
  const result = stages(env);
  assertSame(result, "학생별");
  const courseKey = env.ctx.normalizeResultCourseName(COURSE);
  assert.ok(result.four.get(`1|${courseKey}`) > 0 && result.four.get(`2|${courseKey}`) > 0, "두 학기로 나뉨(추정 그대로)");
});

test("4단계 '개설 학기 바꾸기'(applyTwoSemesterPick) 뒤에도 세 단계가 같고, 나뉜 열이 하나로 모인다", () => {
  const env = context();
  const fixture = load(env); // 처음엔 학생별로 두 학기에 나뉨
  const { ctx, state } = env;
  const data = plain({ courses: state.courses, students: state.students });
  const key = ctx.courseSemesterPickKey(COURSE);
  const moved = ctx.applyTwoSemesterPick(data, "2", key, "1", { credits: 3 });
  assert.equal(moved.students, fixture.firstCount + fixture.secondCount);
  assert.equal(moved.removed.length, 1, "2학기 열을 1학기 열로 합침");
  ctx.setCourseSemesterPick("2", COURSE, "1", "2026");
  ctx.classifyApplicationRecords(data);
  state.students = data.students; state.courses = data.courses; ctx.bump();
  const same = data.courses.filter((course) => ctx.courseSemesterPickKey(course.name) === key);
  assert.deepEqual(plain(same.map((course) => [course.name, course.semesterKey])), [[`${COURSE} (1학기)`, "1"]]);
  const result = stages(env);
  assertSame(result, "1학기로 바꿈");
  const courseKey = ctx.normalizeResultCourseName(COURSE);
  assert.ok(result.five.get(`1|${courseKey}`) > 0);
  assert.equal(result.five.get(`2|${courseKey}`), 0);
  // 다시 2학기로: 같은 열이 학기만 바뀐다.
  ctx.applyTwoSemesterPick(data, "2", key, "2", { credits: 3 });
  ctx.classifyApplicationRecords(data);
  state.students = data.students; state.courses = data.courses; ctx.bump();
  assertSame(stages(env), "2학기로 되돌림");
  assert.equal(data.courses.filter((course) => ctx.courseSemesterPickKey(course.name) === key).length, 1);
});

test("결과를 다시 취합해도 저장된 개설 학기가 유지된다(splitUntaggedTwoSemesterCourses가 courseSemesterPickFor를 읽음)", () => {
  const env = context();
  env.ctx.setCourseSemesterPick("2", COURSE, "1", "2026");
  const fixture = twoSemesterWideRows({});
  const data = env.ctx.createRecords(fixture.rows);
  const split = env.ctx.splitUntaggedTwoSemesterCourses(data, env.groups);
  const entry = split.courses.find((item) => item.key === env.ctx.courseSemesterPickKey(COURSE));
  assert.equal(entry.pick, "1");
  assert.deepEqual(plain(entry.counts), { "1": fixture.firstCount + fixture.secondCount, "2": 0, "": 0 });
  // 추정값(저장된 선택 없이): 학기 경계 열이라 학생별, 다수 2학기.
  const candidates = env.ctx.twoSemesterPickCandidates(env.ctx.createRecords(fixture.rows), "2", env.groups);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].estimate, "2");
  assert.equal(candidates[0].pick, "1");
  assert.match(candidates[0].basis, new RegExp(`학기 경계 열 · 학생별 추정 1학기 ${fixture.firstCount}명 · 2학기 ${fixture.secondCount}명`));
  assert.equal(candidates[0].mixed, true);
});

test("개설 학기 추정 근거: 이웃 열 학기 · 학생별 다수 · 근거 없음", () => {
  const { ctx } = context();
  assert.deepEqual(plain(ctx.courseSemesterPickEstimate({ position: "2", counts: { "1": 0, "2": 40, "": 0 } })), { semester: "2", basis: "이웃 열 2학기", mixed: false });
  assert.equal(ctx.courseSemesterPickEstimate({ position: "", counts: { "1": 5, "2": 3, "": 1 } }).semester, "1");
  assert.equal(ctx.courseSemesterPickEstimate({ position: "", counts: { "1": 0, "2": 0, "": 4 } }).semester, "");
});

test("저장 형식: 학년도·현학년·과목 키 → '1'|'2'만 남기고 정리", () => {
  const { ctx } = context();
  assert.deepEqual(plain(ctx.courseSemesterPicksRestore({ "2026": { "2": { 심화영어: "2", 기하: "3" }, "3": { a: "1" } }, x: {}, "2027": [] })), { "2026": { "2": { 심화영어: "2" } } });
  assert.deepEqual(plain(ctx.courseSemesterPicksRestore(null)), {});
});

test("학기 미정으로 남은 두 학기 과목은 5단계가 앞 학기에 넣지 않고 4단계에서 정하라고 알린다", () => {
  const env = context();
  const { ctx, state } = env;
  load(env, { pick: "2" });
  // 예전 자료 흉내: 2학기 과목을 학기 미정 기본 과목으로 되돌린다.
  const course = state.courses.find((item) => ctx.courseSemesterPickKey(item.name) === ctx.courseSemesterPickKey(COURSE));
  course.name = COURSE; course.semesterKey = ""; course.semesterUndecided = true; course.applicationGroups = {};
  for (const student of state.students) for (const selection of student.selections) if (selection.column === course.column) { selection.name = COURSE; selection.semesterKey = ""; selection.applicationGroups = {}; }
  ctx.bump();
  const { stats, five, four } = stages(env);
  const courseKey = ctx.normalizeResultCourseName(COURSE);
  assert.ok(four.has(`|${courseKey}`), "4단계 '학기 미정' 구역");
  assert.equal(five.get(`1|${courseKey}`), 0);
  assert.equal(five.get(`2|${courseKey}`), 0);
  assert.ok(stats.issues.some((issue) => /학기 미정 신청 \d+명.*개설 학기 바꾸기/.test(issue.text)));
});

test("확정 스냅샷이 지금 집계와 달라지면 roundSnapshotStale이 과목을 알려 주고, 5·6단계는 확정 스냅샷을 쓴다", () => {
  const env = context();
  const { ctx, state } = env;
  load(env, { pick: "2" });
  const snapshot = ctx.buildRoundSnapshot("1");
  state.roundStatuses["1"] = { status: "confirmed", snapshot };
  ctx.bump();
  assert.deepEqual(plain(ctx.roundSnapshotStale("1")), []);
  assert.equal(ctx.courseOpeningRound("2"), "1");
  assert.equal(ctx.courseOpeningSnapshot("1"), snapshot);
  // 확정 뒤 자료가 바뀐 경우(예전 규칙으로 확정한 스냅샷 등): 심화 영어를 1학기로 옮긴다.
  const data = plain({ courses: state.courses, students: state.students });
  ctx.applyTwoSemesterPick(data, "2", ctx.courseSemesterPickKey(COURSE), "1", { credits: 3 });
  ctx.classifyApplicationRecords(data);
  state.students = data.students; state.courses = data.courses; ctx.bump();
  const stale = ctx.roundSnapshotStale("1");
  assert.ok(stale.some((item) => item.name === COURSE && item.semester === "1" && item.confirmed === null));
  assert.ok(stale.some((item) => item.name === COURSE && item.semester === "2" && item.current === null));
  assert.match(ctx.roundSnapshotStaleText(stale), /3학년 [12]학기 심화 영어/);
  const stats = ctx.computeHoursStats("2027");
  assert.ok(stats.issues.some((issue) => /1차 확정 스냅샷이 지금 4단계 집계와 다릅니다/.test(issue.text)));
  // 5단계·6단계는 같은 확정 스냅샷 값(2학기)을 그대로 쓴다.
  const courseKey = ctx.normalizeResultCourseName(COURSE);
  const five = stats.items.find((item) => item.grade === "3" && item.semester === "2" && ctx.normalizeResultCourseName(item.subject) === courseKey).autoClasses;
  assert.equal(five, snapshot.rows.find((row) => row.semester === "2" && ctx.normalizeResultCourseName(row.name) === courseKey).classCount);
});

test("5·6단계가 읽는 차수는 같은 규칙(courseOpeningRound): 최근 확정 → 4단계에서 보는 차수 → 최근 결과", () => {
  const env = context();
  const { ctx, state } = env;
  load(env, { pick: "2" });
  state.rounds = { "1": { students: state.students, courses: state.courses }, "2": null };
  state.roundStatuses = { "1": { status: "confirmed", snapshot: ctx.buildRoundSnapshot("1") } };
  state.currentRound = "2";
  state.students = [];
  ctx.bump();
  assert.equal(ctx.courseOpeningRound("2"), "1", "확정 차수");
  state.roundStatuses = {};
  ctx.bump();
  assert.equal(ctx.courseOpeningRound("2"), "1", "지금 차수(2차)에 결과 없음 → 결과가 있는 최근 차수");
  state.currentRound = "1";
  ctx.bump();
  assert.equal(ctx.courseOpeningRound("2"), "1");
  assert.equal(ctx.courseOpeningRound("1"), "", "현 1학년 결과 없음");
});

test("5단계 직접 입력 개설반은 우선하되 4단계 값과 다르면 표시(is-differ)", () => {
  const env = context();
  const { ctx, state } = env;
  load(env, { pick: "2" });
  const auto = stages(env).five.get(`2|${ctx.normalizeResultCourseName(COURSE)}`);
  state.hoursStats["2027"].classOverrides = { [`3|2|${ctx.normalizeResultCourseName(COURSE)}`]: auto + 1 };
  ctx.bump();
  const item = ctx.computeHoursStats("2027").items.find((entry) => entry.grade === "3" && entry.semester === "2" && entry.subject === COURSE);
  assert.equal(item.classes, auto + 1);
  assert.equal(item.differs, true);
  assert.match(item.basis, new RegExp(`직접 입력 ${auto + 1}반 · 4단계 ${auto}반과 다름`));
});

test("개설 학기 선택 저장: 작업 자료·백업·복원·전체 초기화에 연결, 스크립트는 result-import.js 뒤", () => {
  assert.match(app, /courseSemesterPicks: \{\},/, "state 기본값");
  assert.match(between(app, "function workspacePayload(", "function workspaceBackupCompact("), /courseSemesterPicks: state\.courseSemesterPicks,/);
  assert.match(app, /state\.courseSemesterPicks = typeof courseSemesterPicksRestore === "function" \? courseSemesterPicksRestore\(saved\.courseSemesterPicks\)/);
  assert.match(between(app, "function resetWorkspace(", "state.groupAssignments = {};"), /state\.courseSemesterPicks = \{\};/, "전체 초기화 때 지움");
  const html = read("index.html");
  const at = (file) => html.indexOf(`src="${file}?`);
  assert.ok(at("course-semester-picks.js") > at("result-import.js") && at("result-import.js") > 0);
  // 4단계 메뉴·미리보기 연결
  assert.match(app, /data-opening-semester/);
  assert.match(read("result-import.js"), /twoSemesterPickMarkup\(candidate\.semesterPicks, preview\.grade\)/);
});
