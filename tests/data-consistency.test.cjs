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
  vm.runInContext(read("round-copy.js"), ctx);
  vm.runInContext(between(app, "function applicationRoundNumbers(", "function switchRound("), ctx);
  ctx.switchRound = (round) => { state.currentRound = String(round); const data = state.rounds[round]; state.students = data?.students || []; state.courses = data?.courses || []; };
  ctx.syncActiveRound = () => {};
  ctx.persistStateSoon = () => {};
  vm.runInContext(read("class-sections.js"), ctx);
  const view = read("class-sections-view.js");
  vm.runInContext(between(view, "function classSectionsPlanSubjects(", "function classSectionsNeisFamily("), ctx);
  vm.runInContext(between(view, "function classSectionsRoundChoices(", "function classSectionsPlanSubjects("), ctx);
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

test("고르지 않아도(추천값) 한 번만 나온 과목은 학생별로 섞지 않고 한 학기로 — 단계마다 같은 값", () => {
  const env = context();
  const fixture = load(env);
  const result = stages(env);
  assertSame(result, "추천값");
  const courseKey = env.ctx.normalizeResultCourseName(COURSE);
  assert.equal(result.four.get(`1|${courseKey}`) || 0, 0, "1학기 없음(섞지 않음)");
  assert.ok(result.four.get(`2|${courseKey}`) > 0, "추천 = 학생별 추정 다수(2학기)");
  const same = env.state.courses.filter((course) => env.ctx.courseSemesterPickKey(course.name) === env.ctx.courseSemesterPickKey(COURSE));
  assert.equal(same.length, 1);
  assert.equal(same[0].semesterSource, "recommend");
  assert.equal(env.state.students.filter((student) => student.selections.some((selection) => selection.column === same[0].column)).length, fixture.firstCount + fixture.secondCount);
});

test("4단계 '개설 학기 바꾸기'(applyTwoSemesterPick) 뒤에도 세 단계가 같고, 나뉜 열이 하나로 모인다", () => {
  const env = context();
  const fixture = load(env, { pick: "2" });
  const { ctx, state } = env;
  const data = plain({ courses: state.courses, students: state.students });
  const key = ctx.courseSemesterPickKey(COURSE);
  const moved = ctx.applyTwoSemesterPick(data, "2", key, "1", { credits: 3 });
  assert.equal(moved.students, fixture.firstCount + fixture.secondCount);
  assert.equal(moved.removed.length, 0, "한 열 그대로 학기만 바뀜");
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

test("고른 값은 차수마다: 결과를 다시 취합해도 이 차수 고른 학기가 유지되고, 다른 차수에는 쓰지 않는다", () => {
  const env = context();
  const { ctx, state } = env;
  ctx.setCourseSemesterPick("2", COURSE, "1", "2026", "1");
  const fixture = twoSemesterWideRows({});
  const classify = () => { const data = ctx.createRecords(fixture.rows); return ctx.classifyApplicationRecords(data); };
  let entry = classify().twoSemesterCourses.find((item) => item.key === ctx.courseSemesterPickKey(COURSE));
  assert.deepEqual([entry.once, entry.pick, entry.semester], [true, "1", "1"]);
  // 미리보기 목록: 추천(저장된 선택 없이) = 학기 경계 열이라 학생별 추정 다수 2학기, 고른 값 1학기.
  const candidates = ctx.twoSemesterPickCandidates(classify().twoSemesterCourses, "2");
  assert.equal(candidates.length, 1);
  assert.deepEqual([candidates[0].estimate, candidates[0].pick, candidates[0].choosers], ["2", "1", fixture.firstCount + fixture.secondCount]);
  assert.equal(candidates[0].basis, `학생별 추정 1학기 ${fixture.firstCount}명 · 2학기 ${fixture.secondCount}명`);
  state.currentRound = "2"; state.rounds["2"] = null;
  entry = classify().twoSemesterCourses.find((item) => item.key === ctx.courseSemesterPickKey(COURSE));
  assert.equal(entry.pick, "", "2차에는 1차 고른 값을 자동으로 쓰지 않음");
});

test("추천 근거: 이웃 열 학기 · 학생별 다수 · 앞 차수 폐강 학기 / 한 학기만 개설", () => {
  const { ctx } = context();
  assert.deepEqual(plain(ctx.courseSemesterPickEstimate({ position: "2", counts: { "1": 0, "2": 40, "": 0 } })), { semester: "2", basis: "이웃 열 2학기" });
  assert.equal(ctx.courseSemesterPickEstimate({ position: "", counts: { "1": 5, "2": 3, "": 1 } }).semester, "1");
  assert.equal(ctx.courseSemesterPickEstimate({ position: "", counts: { "1": 0, "2": 0, "": 4 } }).semester, "");
  const key = ctx.courseSemesterPickKey(COURSE);
  const row = (semester, decision, classCount) => ({ grade: "2", semester, name: COURSE, decision, classCount });
  assert.deepEqual(plain(ctx.courseSemesterRecommendFromRows([row("1", "open", 6), row("2", "closed", 0)], "2", key, "1")), { semester: "2", basis: "앞 차수(1차) 2학기 폐강" });
  assert.deepEqual(plain(ctx.courseSemesterRecommendFromRows([row("1", "open", 6)], "2", key, "1")), { semester: "1", basis: "앞 차수(1차) 1학기만 개설" });
  assert.equal(ctx.courseSemesterRecommendFromRows([row("1", "open", 6), row("2", "open", 3)], "2", key, "1"), null, "두 학기 모두 개설이면 추천 없음");
});

test("2차 재신청 파일에 한 열만 나오면 앞 차수(1차) 4단계에서 폐강한 학기를 추천한다", () => {
  const env = context();
  const { ctx, state } = env;
  // 1차: 2학기로 고른 결과 → 4단계에서 2학기 심화 영어를 폐강으로 확정.
  load(env, { pick: "2" });
  const second = state.courses.find((course) => ctx.courseSemesterPickKey(course.name) === ctx.courseSemesterPickKey(COURSE));
  state.roundClosures["1"] = { [`2:${second.column}`]: "closed" };
  ctx.bump();
  const snapshot = ctx.buildRoundSnapshot("1");
  state.rounds = { "1": { students: state.students, courses: state.courses, classOverrides: {}, semesterAssignments: {}, groupAssignments: {} }, "2": null };
  state.roundStatuses = { "1": { status: "confirmed", snapshot } };
  state.currentRound = "2"; state.students = []; state.courses = [];
  ctx.bump();
  assert.deepEqual(plain(ctx.courseSemesterPreviousRecommendation("2", COURSE)), { semester: "2", basis: "앞 차수(1차) 2학기 폐강" });
  // 2차 재신청 파일(심화 영어 한 열): 학생별 추정보다 앞 차수 폐강 학기(2학기)를 먼저 추천한다.
  const rows = twoSemesterWideRows({ seed: 3 }).rows;
  const data = ctx.createRecords(rows);
  const entry = ctx.classifyApplicationRecords(data).twoSemesterCourses.find((item) => item.once);
  assert.deepEqual(plain(entry.recommend), { semester: "2", basis: "앞 차수(1차) 2학기 폐강" });
  assert.equal(entry.pick, "");
});

test("머리글 학기·그룹 표시('3-2 택5' 병합 머리글·시트 이름)가 있으면 묻지 않고 그 학기, 같은 이름 두 열은 '위치로 정함' 근거", () => {
  const { ctx } = context();
  const fixture = twoSemesterWideRows({});
  const at = fixture.rows[1].indexOf(COURSE);
  const letter = (index) => String.fromCharCode(65 + index);
  // 과목 이름 줄 위에 그룹 머리글 줄: 심화 영어 ~ 3-2 택5 과목들 위에 '3-2 택5' 병합.
  const groupRow = fixture.rows[1].map(() => "");
  groupRow[4] = "3-1 택5"; groupRow[at] = "3-2 택5";
  const rows = [fixture.rows[0], groupRow, ...fixture.rows.slice(1)];
  const merges = [`${letter(4)}2:${letter(at - 1)}2`, `${letter(at)}2:${letter(at + 10)}2`];
  let data = ctx.createRecords(rows, { merges });
  const course = data.courses.find((item) => item.name === COURSE);
  assert.deepEqual([course.semesterKey, course.semesterSource, course.semesterHint], ["2", "header", "3-2 택5"]);
  let result = ctx.classifyApplicationRecords(data);
  assert.deepEqual(plain(ctx.twoSemesterPickCandidates(result.twoSemesterCourses, "2")), [], "표시로 정해지면 묻지 않음");
  assert.deepEqual(plain(ctx.twoSemesterDecidedNotes(data.courses, "2", new Set([ctx.courseSemesterPickKey(COURSE)]))), [{ name: COURSE, semester: "2", basis: "머리글 표시 '3-2 택5' → 2학기" }]);
  // 학년이 다르면(현 2학년 결과에 '2-2' 표시) 쓰지 않는다.
  groupRow[at] = "2-2 택3";
  data = ctx.createRecords([fixture.rows[0], groupRow, ...fixture.rows.slice(1)], { merges });
  assert.equal(data.courses.find((item) => item.name === COURSE).semesterKey, "");
  // 시트 이름 '3학년 2학기'
  data = ctx.createRecords(fixture.rows, { sheetName: "3학년 2학기 결과" });
  assert.deepEqual([data.courses.find((item) => item.name === COURSE).semesterKey, data.courses.find((item) => item.name === COURSE).semesterSource], ["2", "sheet"]);
  // 같은 이름 두 열(동시 개설): 왼쪽 1학기 · 오른쪽 2학기 + 근거.
  const twice = fixture.rows.map((row, index) => index === 1 ? [...row, COURSE] : index === 2 ? [...row, 3] : index > 2 ? [...row, ""] : row);
  data = ctx.createRecords(twice);
  assert.deepEqual(plain(ctx.twoSemesterDecidedNotes(data.courses, "2", new Set([ctx.courseSemesterPickKey(COURSE)])).map((note) => note.basis)),
    ["위치로 정함: 왼쪽 열 → 1학기", "위치로 정함: 오른쪽 열 → 2학기"]);
  result = ctx.classifyApplicationRecords(data);
  assert.deepEqual(plain(ctx.twoSemesterPickCandidates(result.twoSemesterCourses, "2")), []);
});

test("웹 신청 결과(online, 'X (n학기)')도 4단계 = 5단계 = 6단계", () => {
  const env = context();
  const { ctx, state } = env;
  load(env, { pick: "2" });
  // 웹 결과처럼: 과목이 서버 목록(online) · 현 학년 지정 · 이름에 학기 꼬리표.
  for (const course of state.courses) { course.applicationGroupSource = "online"; course.applicationCurrentGrade = "2"; }
  for (const student of state.students) for (const selection of student.selections) Object.assign(selection, state.courses.find((course) => course.column === selection.column));
  ctx.bump();
  const result = stages(env);
  assertSame(result, "웹 결과");
  assert.ok(result.five.get(`2|${ctx.normalizeResultCourseName(COURSE)}`) > 0);
});

test("저장 형식: 학년도·현학년·차수·과목 키 → '1'|'2'만 남기고 정리, 예전 키는 1차로", () => {
  const { ctx } = context();
  assert.deepEqual(plain(ctx.courseSemesterPicksRestore({ "2026": { "2": { "2": { 심화영어: "2", 기하: "3" } }, "3": { "1": { a: "1" } } }, x: {}, "2027": [] })), { "2026": { "2": { "2": { 심화영어: "2" } } } });
  // 차수 없는 예전 키·다른 구현의 twoSemesterPicks → 1차
  assert.deepEqual(plain(ctx.courseSemesterPicksRestore({ "2026": { "2": { 심화영어: "1" } } }, { "2026": { "1": { 기후: "2" } } })), { "2026": { "2": { "1": { 심화영어: "1" } }, "1": { "1": { 기후: "2" } } } });
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

test("5·6단계가 읽는 차수 = 맨 위에서 고른 차수(courseOpeningRound · 숨은 규칙 없음)", () => {
  const env = context();
  const { ctx, state } = env;
  load(env, { pick: "2" });
  state.rounds = { "1": { students: state.students, courses: state.courses }, "2": null };
  state.roundStatuses = { "1": { status: "confirmed", snapshot: ctx.buildRoundSnapshot("1") } };
  state.currentRound = "2"; state.students = [];
  ctx.bump();
  assert.equal(ctx.courseOpeningRound("2"), "2", "2차에 결과가 없어도 1차 확정으로 넘어가지 않음");
  assert.equal(ctx.computeHoursStats("2027").grades.find((info) => info.grade === "3").source, null);
  assert.equal(ctx.classSectionsDefaultRound(), "2");
  state.currentRound = "1";
  ctx.bump();
  assert.equal(ctx.courseOpeningRound("2"), "1");
});

test("직접 입력이 있어도 2·3학년 선택과목 개설반은 4단계 값(4단계 연동) — 예전 직접 입력은 지우지 않고 안내만", () => {
  const env = context();
  const { ctx, state } = env;
  load(env, { pick: "2" });
  const key = ctx.normalizeResultCourseName(COURSE);
  const before = stages(env);
  const auto = before.five.get(`2|${key}`);
  // 예전 버전에서 넣은 값(사용자 화면: 주제 탐구 독서 10 · 독서 토론과 글쓰기 1 처럼 4단계와 다른 값)
  state.hoursStats["2027"].classOverrides = { [`3|2|${key}`]: auto + 3, [`3|1|${ctx.normalizeResultCourseName("화학 반응의 세계")}`]: 10 };
  ctx.bump();
  const result = stages(env);
  assertSame(result, "직접 입력 있음");
  const item = result.stats.items.find((entry) => entry.grade === "3" && entry.semester === "2" && entry.subject === COURSE);
  assert.deepEqual([item.classes, item.autoClasses, item.manual, item.linked], [auto, auto, false, true]);
  assert.equal(state.hoursStats["2027"].classOverrides[`3|2|${key}`], auto + 3, "저장 자료는 그대로(되돌릴 수 있게)");
  const notice = result.stats.issues.find((issue) => /^4단계와 다른 직접 입력 2개를 4단계 값으로 바꿨습니다/.test(issue.text));
  assert.ok(notice && notice.level === "info", result.stats.issues.map((issue) => issue.text).join("\n"));
  assert.match(notice.text, new RegExp(`3학년 2학기 ${COURSE} ${auto + 3} → ${auto}`));
  // 시수표 칸: 연동 칸은 입력 상자가 아니라 값 단추(4단계에서 고치기)
  const model = ctx.hoursFormModel(result.stats, { schoolName: "가상고", date: new Date(2026, 10, 11) });
  const cell = [...model.cells.values()].find((entry) => entry.item === item);
  assert.equal(cell.input, null);
  assert.equal(cell.link.value, auto);
});

test("학교 지정 과목 개설반 = 편제표 × 내년 학급 수(4단계 기준 설정과 같은 값) — 예전 직접 입력은 무시하고 안내, 교차집중 홀수는 고른 과목이 1반 더", () => {
  const env = context();
  const { ctx, state } = env;
  load(env, { pick: "2" });
  const base = ctx.curriculumPlanEntries().entries;
  const designated = (semester, subject, area, extra = {}) => ({ grade: "3", semester, subject, area, credit: 2, kind: "지정", names: 1, nameIndex: 0, rowIndex: 90, ...extra });
  const cross = (semester, subject, nameIndex) => designated(semester, subject, "예술", { names: 2, nameIndex, crossed: true, crossSemesters: 2, crossExtra: 0 });
  ctx.curriculumPlanEntries = () => ({ entries: [...base, designated("1", "영어 독해와 작문", "영어"), cross("1", "음악 연주와 창작", 0), cross("1", "미술 창작", 1),
    cross("2", "음악 연주와 창작", 0), cross("2", "미술 창작", 1)], issues: [] });
  const key = (subject, semester = "1") => `3|${semester}|${ctx.normalizeResultCourseName(subject)}`;
  state.hoursStats["2027"].classOverrides = { [key("영어 독해와 작문")]: 7, [key("미술 창작")]: 5 };
  ctx.bump();
  const read = () => {
    const stats = ctx.computeHoursStats("2027");
    const at = (subject, semester = "1") => stats.items.find((item) => item.key === key(subject, semester));
    return { stats, at };
  };
  let { stats, at } = read();
  const english = at("영어 독해와 작문");
  assert.deepEqual([english.classes, english.manual, english.linked, english.designated], [11, false, true, true]);
  // 교차집중 11학급, 1반 더 = 음악(crossExtra 0): 1학기 음악 6·미술 5, 2학기 음악 5·미술 6 — 미술 1학기 직접 입력 5는 편제표 값과 같아 안내하지 않음.
  assert.deepEqual([at("음악 연주와 창작").classes, at("미술 창작").classes, at("음악 연주와 창작", "2").classes, at("미술 창작", "2").classes], [6, 5, 5, 6]);
  assert.ok(at("미술 창작").crossPick);
  const notice = stats.issues.find((issue) => /^편제표와 다른 직접 입력 1개를 편제표 값으로 바꿨습니다/.test(issue.text));
  assert.ok(notice && notice.level === "info", stats.issues.map((issue) => issue.text).join("\n"));
  assert.match(notice.text, /3학년 1학기 영어 독해와 작문 7 → 11/);
  assert.equal(state.hoursStats["2027"].classOverrides[key("영어 독해와 작문")], 7, "저장 자료는 그대로");
  // 선택과목은 여전히 4단계 연동(학교 지정 항목을 더해도 4단계 = 5단계 = 6단계).
  const selected = stats.items.filter((item) => !item.designated);
  assert.ok(selected.length && selected.every((item) => item.linked || item.kind === "지정"));
  // 내년 학급 수(4단계 기준 설정 nextYearClasses3 = 시수 설정 hoursClasses3 = settings.classCounts)를 바꾸면 따라 바뀐다.
  state.hoursStats["2027"].classCounts["3"] = 12;
  ctx.bump();
  ({ stats, at } = read());
  assert.equal(at("영어 독해와 작문").classes, 12);
  assert.deepEqual([at("음악 연주와 창작").classes, at("미술 창작").classes], [6, 6]);
  assert.ok(!at("미술 창작").crossPick, "짝수 학급이면 1반 더 받을 과목을 고르지 않음");
  assert.match(stats.issues.find((issue) => /^편제표와 다른 직접 입력/.test(issue.text)).text, /^편제표와 다른 직접 입력 2개/);
});

test("4단계에 없는 선택과목(과목명 불일치 등)만 직접 입력을 쓰고 '4단계에 없는 과목 · 직접 입력' 표시", () => {
  const env = context();
  const { ctx, state } = env;
  load(env, { pick: "2" });
  // 4단계 결과에서 한 과목을 빼서(과목명이 달라 집계에 없음) 직접 입력만 남긴다.
  const name = "행성우주과학";
  state.courses = state.courses.filter((course) => !course.name.startsWith(name));
  for (const student of state.students) student.selections = student.selections.filter((selection) => !selection.name.startsWith(name));
  state.hoursStats["2027"].classOverrides = { [`3|2|${ctx.normalizeResultCourseName(name)}`]: 4 };
  ctx.bump();
  const item = ctx.computeHoursStats("2027").items.find((entry) => entry.grade === "3" && entry.semester === "2" && entry.subject === name);
  assert.deepEqual([item.linked || false, item.manual, item.classes, item.missingStage4], [false, true, 4, true]);
  assert.match(item.basis, /^4단계에 없는 과목 · 직접 입력 4반/);
});

// 원인 재현(사용자 화면 v2026.11.23, 사용자가 '선택과목 근거'를 '자동'으로 바꾸자 해결됨): 5단계 시수 설정의 '선택과목 근거' 고정값
// (settings.sourceRounds, 예전에 한 번 고른 1차)이 자동 규칙(courseOpeningRound)보다 먼저라, 4단계가 2차(확정)여도 5단계는 미확정 1차를 읽는다.
// 원인(사용자 화면 v2026.11.23): 예전 5단계 '선택과목 근거' 고정값(settings.sourceRounds, 1차)이 자동 규칙보다 먼저라 4단계 2차(확정)와 달리
// 미확정 1차를 읽었다. 차수별 흐름 분리 뒤에는 고정값을 읽지 않고 맨 위 차수만 쓴다.
test("여러 차수: 1차 미확정 + 2차 확정 + 예전 고정값(1차) → 화면 2차면 5단계도 2차(고정값 무시), 화면 1차면 1차(미확정이어도 그 차수 값)", () => {
  const env = context();
  const { ctx, state } = env;
  state.currentRound = "1";
  load(env, { pick: "1" });
  state.rounds = { "1": { students: state.students, courses: state.courses, classOverrides: {}, semesterAssignments: {}, groupAssignments: {} } };
  state.currentRound = "2";
  load(env, { pick: "2" });
  state.rounds["2"] = { students: state.students, courses: state.courses, classOverrides: {}, semesterAssignments: {}, groupAssignments: {} };
  state.roundStatuses = { "2": { status: "confirmed", snapshot: ctx.buildRoundSnapshot("2") } };
  state.hoursStats["2027"].sourceRounds = { "3": "1" };
  const key = ctx.normalizeResultCourseName(COURSE);
  const read = () => {
    ctx.bump();
    const result = stages(env);
    const info = result.stats.grades.find((item) => item.grade === "3");
    return { result, round: info.source.round, confirmed: info.source.confirmed, label: info.label, first: result.five.get(`1|${key}`), second: result.five.get(`2|${key}`), issues: result.stats.issues.map((issue) => issue.text) };
  };
  let view = read();
  assert.deepEqual([view.round, view.confirmed], ["2", true], "예전 고정값(1차)은 읽지 않음");
  assert.ok(view.second > 0 && view.first === 0);
  assertSame(view.result, "화면 2차");
  assert.ok(!view.issues.some((text) => /확정되지 않아/.test(text)));
  // 화면을 1차로 바꾸면(미확정) 5·6단계도 1차 값 — '임시 계산' 경고 없이 근거 줄에 '미확정'
  state.currentRound = "1"; state.students = state.rounds["1"].students; state.courses = state.rounds["1"].courses;
  view = read();
  assert.deepEqual([view.round, view.confirmed], ["1", false]);
  assert.ok(view.first > 0 && view.second === 0);
  assertSame(view.result, "화면 1차");
  assert.ok(!view.issues.some((text) => /확정되지 않아 현재 집계로 임시 계산/.test(text)));
  assert.match(ctx.roundBasisHtml("1"), /근거: 1차<\/b> · <span class="round-basis-item">현1: 결과 없음<\/span> · <span class="round-basis-item">현2: 1차 결과\(미확정\)<\/span>/);
});

test("근거 줄: 복사한 학년은 '2차에서 복사', 앞 차수가 복사 뒤 바뀌면 '2차가 복사 뒤 바뀜 · 이 학년 다시 복사' → 누르면 다시 복사", async () => {
  const env = context();
  const { ctx, state } = env;
  load(env, { pick: "2" });
  state.rounds = { "1": { students: state.students, courses: state.courses, classOverrides: {}, semesterAssignments: {}, groupAssignments: {}, customGroupNames: [] } };
  state.roundClosures = { "1": {} };
  ctx.bump();
  ctx.addApplicationRound();
  assert.match(ctx.roundBasisHtml("2"), /근거: 2차<\/b> · .*현2: 1차에서 복사\(미확정\)<\/span>/);
  assert.doesNotMatch(ctx.roundBasisHtml("2"), /복사 뒤 바뀜/);
  const course = state.rounds["1"].courses[0];
  state.roundClosures["1"] = { [`2:${course.column}`]: "closed" };
  ctx.bump();
  assert.match(ctx.roundBasisHtml("2"), /1차가 복사 뒤 바뀜<\/span> <button type="button" class="button button-quiet" data-round-recopy="2">이 학년 다시 복사<\/button>/);
  ctx.appConfirm = async () => true;
  assert.equal(await ctx.recopyRoundGrade("2"), true);
  assert.equal(state.roundClosures["2"][`2:${course.column}`], "closed", "다시 복사");
  assert.doesNotMatch(ctx.roundBasisHtml("2"), /복사 뒤 바뀜/);
});

test("차수 비교(buildRoundCompare): 복사한 학년은 머리글에 '1차에서 복사', 재신청 학생만 바꾼 학년은 '재신청 학생만 바꿈'", () => {
  const env = context();
  const { ctx, state } = env;
  load(env, { pick: "2" });
  state.rounds = { "1": { students: state.students, courses: state.courses, classOverrides: {}, semesterAssignments: {}, groupAssignments: {}, customGroupNames: [] } };
  state.roundClosures = { "1": {} };
  ctx.bump();
  ctx.addApplicationRound();
  ctx.bump();
  let compare = ctx.buildRoundCompare();
  assert.deepEqual(plain(compare.rounds), ["1", "2"]);
  const grade2 = compare.grades.find((entry) => entry.grade === "2");
  assert.deepEqual(plain(grade2.sources), { "2": "1차에서 복사" }, "1차는 직접 올린 결과라 꼬리표 없음");
  state.rounds["2"].gradeSources["2"] = { kind: "partial", round: "2" };
  ctx.bump();
  compare = ctx.buildRoundCompare();
  assert.equal(compare.grades.find((entry) => entry.grade === "2").sources["2"], "재신청 학생만 바꿈");
  assert.match(read("round-status.js"), /\$\{round\}차\$\{sources\[round\] \? `<small class="round-compare-source">/, "화면 머리글");
  assert.match(read("round-status.js"), /roundStatusLabel\(round\)\}\$\{sources\[round\] \? ` · \$\{sources\[round\]\}` : ""\}\)`/, "엑셀 머리글");
});

test("개설 학기 선택 저장: 작업 자료·백업·복원·전체 초기화에 연결, 스크립트는 result-import.js 뒤", () => {
  assert.match(app, /courseSemesterPicks: \{\},/, "state 기본값");
  assert.match(between(app, "function workspacePayload(", "function workspaceBackupCompact("), /courseSemesterPicks: state\.courseSemesterPicks,/);
  assert.match(app, /state\.courseSemesterPicks = typeof courseSemesterPicksRestore === "function" \? courseSemesterPicksRestore\(saved\.courseSemesterPicks, saved\.twoSemesterPicks\)/, "다른 구현의 예전 값도 옮김");
  assert.doesNotMatch(app, /switchTwoSemesterCourse|data-two-semester-once|state\.twoSemesterPicks =/, "겹치던 다른 구현은 없음");
  assert.match(between(app, "function resetWorkspace(", "state.groupAssignments = {};"), /state\.courseSemesterPicks = \{\};/, "전체 초기화 때 지움");
  const html = read("index.html");
  const at = (file) => html.indexOf(`src="${file}?`);
  assert.ok(at("course-semester-picks.js") > at("result-import.js") && at("result-import.js") > 0);
  // 4단계 메뉴·미리보기 연결
  assert.match(app, /data-opening-semester/);
  assert.match(read("result-import.js"), /twoSemesterPickMarkup\(candidate\.semesterPicks, preview\.grade, candidate\.semesterNotes\)/);
});

// ---- 차수별 흐름 분리(사용자 결정 2026-11) ----
test("새 차수 = 직전 차수 복사: 두 학년 결과·개설/폐강·6단계 분반, 확정·고른 학기는 복사하지 않음 · 학년마다 '복사' 근거와 서명", () => {
  const env = context();
  const { ctx, state } = env;
  load(env, { pick: "2" });
  const course = state.courses.find((item) => ctx.courseSemesterPickKey(item.name) === ctx.courseSemesterPickKey(COURSE));
  state.rounds = { "1": { students: state.students, courses: state.courses, classOverrides: { [`2:${course.column}`]: 5 }, semesterAssignments: {}, groupAssignments: {}, customGroupNames: [] } };
  state.roundClosures = { "1": { [`2:${course.column}`]: "closed" } };
  state.roundStatuses = { "1": { status: "confirmed", snapshot: ctx.buildRoundSnapshot("1") } };
  state.classSections = { settings: {}, "1": { "2:2:3-2 택5": { classCounts: { [COURSE]: 4 } } } };
  ctx.bump();
  ctx.addApplicationRound();
  assert.equal(state.currentRound, "2");
  const copied = state.rounds["2"];
  assert.equal(copied.students.length, state.rounds["1"].students.length);
  assert.notEqual(copied.students, state.rounds["1"].students, "깊은 복사");
  assert.deepEqual(plain(copied.classOverrides), { [`2:${course.column}`]: 5 });
  assert.deepEqual(plain(state.roundClosures["2"]), { [`2:${course.column}`]: "closed" });
  assert.equal(state.roundStatuses["2"], undefined, "확정은 복사하지 않음(미확정으로 시작)");
  assert.deepEqual(plain(state.classSections["2"]), plain(state.classSections["1"]));
  assert.equal(state.courseSemesterPicks["2026"]["2"]["2"], undefined, "고른 개설 학기는 복사하지 않음(차수마다 따로 · 추천은 앞 차수 결과에서)");
  assert.deepEqual([copied.gradeSources["2"].kind, copied.gradeSources["2"].round], ["copy", "1"]);
  assert.equal(copied.gradeSources["2"].from.signature, ctx.roundGradeSignature(state.rounds["1"], state.roundClosures["1"], "2"));
  assert.equal(copied.gradeSources["1"], undefined, "결과가 없는 학년은 복사 근거 없음");
  // 앞 차수가 바뀌면 서명이 달라진다(근거 줄 '복사 뒤 바뀜').
  state.roundClosures["1"][`2:${course.column}`] = "open";
  assert.notEqual(copied.gradeSources["2"].from.signature, ctx.roundGradeSignature(state.rounds["1"], state.roundClosures["1"], "2"));
});

test("학년 몫 바꾸기(roundReplaceGrade)는 다른 학년을 그대로 두고, 겹치는 열 이름은 바꿔 넣는다", () => {
  const { ctx } = context();
  const course = (column, name, grade) => ({ column, name, semesterKey: "1", applicationCurrentGrade: grade });
  const data = { students: [{ grade: "1", classroom: "1", number: "1", selections: [course("app1", "물리학", "1")] }, { grade: "2", classroom: "1", number: "1", selections: [course("app2", "경제", "2")] }],
    courses: [course("app1", "물리학", "1"), course("app2", "경제", "2")], classOverrides: { "1:app1": 3, "2:app2": 2 }, semesterAssignments: {}, groupAssignments: {} };
  const slice = { students: [{ grade: "2", classroom: "1", number: "1", selections: [course("app1", "기하", "2")] }], courses: [course("app1", "기하", "2")], classOverrides: { "2:app1": 4 }, semesterAssignments: {}, groupAssignments: {}, closures: { "2:app1": "closed" } };
  const result = ctx.roundReplaceGrade(data, { "1:app1": "open", "2:app2": "closed" }, "2", slice);
  assert.deepEqual(plain(result.data.courses.map((item) => [item.column, item.name])), [["app1", "물리학"], ["app1~1", "기하"]]);
  assert.equal(result.data.students.find((student) => student.grade === "2").selections[0].column, "app1~1");
  assert.deepEqual(plain(result.data.classOverrides), { "1:app1": 3, "2:app1~1": 4 });
  assert.deepEqual(plain(result.closures), { "1:app1": "open", "2:app1~1": "closed" });
});

test("웹 재신청처럼 열 번호가 밀려도 개설 결정·학급수 입력은 이름·학기로 옮긴다(roundRemapKeysByName)", () => {
  const { ctx } = context();
  const from = [{ column: "app0", name: "미적분", semesterKey: "1", applicationCurrentGrade: "1" }, { column: "app1", name: "기하", semesterKey: "1", applicationCurrentGrade: "1" }];
  const to = [{ column: "app0", name: "기하", semesterKey: "1", applicationCurrentGrade: "1" }];
  assert.deepEqual(plain(ctx.roundRemapKeysByName(from, to, { "1:app0": "closed", "1:app1": "open", "2:app1": "open" }, "1")), { "1:app0": "open" });
});

test("'재신청한 학생만 있는 파일': 파일 학생만 바꾸고(학년·반·번호) 나머지는 그대로, 없던 학생은 추가, 과목 열은 같은 이름·학기 열", () => {
  const env = context();
  const { ctx, state } = env;
  load(env, { pick: "2" });
  const before = plain(state.students);
  const seat = (student) => `${student.classroom}-${student.number}`;
  const target = before.slice(0, 3);
  // 3명은 다른 과목(일본어 회화 → 중국어 회화 등)으로, 1명은 전입(없던 번호)
  const swap = (student) => ({ ...student, selections: student.selections.map((selection) => /일본어 회화/.test(selection.name) ? { ...selection, column: "z1", name: "중국어 회화" }
    : /중국어 회화/.test(selection.name) ? { ...selection, column: "z2", name: "일본어 회화" } : selection) });
  const overlay = { courses: [{ column: "z1", name: "중국어 회화", semesterKey: "2", credits: 2 }, { column: "z2", name: "일본어 회화", semesterKey: "2", credits: 2 }, { column: "z3", name: "새 과목", semesterKey: "2", credits: 2 }],
    students: [...target.map(swap), { grade: "2", classroom: "11", number: "99", name: "학생전입", selections: [{ column: "z3", name: "새 과목", semesterKey: "2", credits: 2 }] }] };
  const { slice, counts } = ctx.roundMergeGradeStudents({ students: state.students, courses: state.courses }, {}, "2", overlay);
  assert.deepEqual(plain(counts), { changed: 3, same: 0, added: 1, kept: before.length - 3 });
  assert.equal(slice.students.length, before.length + 1);
  const columns = new Map(state.courses.map((course) => [course.name.replace(/\s+/g, ""), course.column]));
  const changed = slice.students.find((student) => seat(student) === seat(target[0]));
  for (const selection of changed.selections) if (/회화/.test(selection.name)) assert.equal(selection.column, columns.get(selection.name.replace(/\s+/g, "")), "기존 열");
  assert.ok(slice.courses.some((course) => course.name === "새 과목" && course.column.startsWith("result-2-")), "없던 과목은 새 열");
  const untouched = slice.students.find((student) => seat(student) === seat(before[10]));
  assert.deepEqual(plain(untouched.selections.map((item) => item.name)), plain(before[10].selections.map((item) => item.name)));
});

test("예전 자료 옮기기 계획: 빈 학년은 복사, 일부 학생만 있는 학년(직전 차수의 절반 미만, 모두 직전 차수 학생)은 묻기, 확정·이미 정한 학년은 건너뜀", () => {
  const { ctx } = context();
  const student = (grade, number) => ({ grade, classroom: "1", number: String(number), selections: [] });
  const many = (grade, count) => Array.from({ length: count }, (_, index) => student(grade, index + 1));
  const rounds = {
    "1": { students: [...many("1", 30), ...many("2", 28)] },
    "2": { students: [...many("1", 30)] },                       // 현2 비어 있음 → 복사
    "3": { students: [...many("1", 30), student("2", 3), student("2", 7)] } // 현2 2명뿐 → 묻기
  };
  let plan = ctx.roundMigrationPlan(rounds, () => false);
  assert.deepEqual(plain(plan.map((item) => [item.round, item.grade, item.action, item.from])), [["2", "2", "copy", "1"]]);
  // 2차에 현2를 복사하고 나면 3차 현2(2명)를 묻는다.
  rounds["2"].students.push(...many("2", 28));
  plan = ctx.roundMigrationPlan(rounds, () => false);
  assert.deepEqual(plain(plan.map((item) => [item.round, item.grade, item.action, item.count, item.previous])), [["3", "2", "ask", 2, 28]]);
  assert.deepEqual(plain(ctx.roundMigrationPlan(rounds, (round) => round === "3")), [], "확정 차수는 묻지 않음");
  rounds["3"].gradeSources = { "2": { kind: "upload", decided: "kept" } };
  assert.deepEqual(plain(ctx.roundMigrationPlan(rounds, () => false)), [], "이미 정한 학년은 다시 묻지 않음");
});

test("예전 자료 옮기기(migrateRoundGrades): 빈 학년은 직전 차수에서 복사·안내, 3명뿐인 학년은 물어서 합치기/그대로 두기, 다시 묻지 않음", async () => {
  const env = context();
  const { ctx, state } = env;
  load(env, { pick: "2" });
  const full = plain({ students: state.students, courses: state.courses, classOverrides: {}, semesterAssignments: {}, groupAssignments: {}, customGroupNames: [] });
  const few = plain(full);
  few.students = few.students.slice(0, 3);
  state.rounds = { "1": full, "2": { ...plain(full), students: [], courses: [] }, "3": few };
  state.roundClosures = { "1": {}, "2": {}, "3": {} };
  state.currentRound = "3"; state.students = few.students; state.courses = few.courses;
  const asked = [];
  ctx.appConfirm = async (text, options) => { asked.push({ text, options }); return true; };
  ctx.bump();
  const notes = await ctx.migrateRoundGrades();
  assert.equal(state.rounds["2"].students.length, full.students.length, "빈 2차 현2를 1차에서 복사");
  assert.deepEqual([state.rounds["2"].gradeSources["2"].kind, state.rounds["2"].gradeSources["2"].round], ["copy", "1"]);
  assert.match(notes[0], /^2차에 현2 결과가 없어 1차 결과를 복사했습니다$/);
  assert.equal(asked.length, 1);
  assert.match(asked[0].text, /^3차 현2 결과가 3명뿐입니다\(2차 308명\)\. 재신청한 학생만 있는 결과로 보고 2차 결과와 합칠까요\?/);
  assert.deepEqual([asked[0].options.ok, asked[0].options.cancel], ["합치기", "그대로 두기"]);
  assert.equal(state.rounds["3"].students.length, full.students.length, "합치면 3차 현2 = 2차 + 3명");
  assert.equal(state.students.length, full.students.length, "지금 보는 차수 화면 자료도 바뀜");
  assert.equal(state.rounds["3"].gradeSources["2"].decided, "merged");
  // 다시 열어도 묻지 않음
  asked.length = 0;
  await ctx.migrateRoundGrades();
  assert.equal(asked.length, 0);
});

test("예전 자료 옮기기: '그대로 두기'면 그 학년은 그대로이고 다시 묻지 않는다 · 확정 차수는 묻지 않음", async () => {
  const env = context();
  const { ctx, state } = env;
  load(env, { pick: "2" });
  const full = plain({ students: state.students, courses: state.courses, classOverrides: {}, semesterAssignments: {}, groupAssignments: {}, customGroupNames: [] });
  const few = plain(full); few.students = few.students.slice(0, 3);
  state.rounds = { "1": full, "2": few };
  state.roundClosures = { "1": {}, "2": {} };
  state.currentRound = "1"; state.students = full.students; state.courses = full.courses;
  let count = 0;
  ctx.appConfirm = async () => { count++; return false; };
  ctx.bump();
  await ctx.migrateRoundGrades();
  assert.equal(count, 1);
  assert.equal(state.rounds["2"].students.length, 3);
  assert.equal(state.rounds["2"].gradeSources["2"].decided, "kept");
  await ctx.migrateRoundGrades();
  assert.equal(count, 1, "다시 묻지 않음");
  state.rounds["2"].gradeSources = {};
  state.roundStatuses = { "2": { status: "confirmed", snapshot: { rows: [] } } };
  ctx.bump();
  await ctx.migrateRoundGrades();
  assert.equal(count, 1, "확정 차수는 묻지 않음");
});

test("하네스 회귀: 웹 과목 열 번호가 밀려도 폐강이 다른 과목(중국어)에 붙지 않고, '재신청 학생만' 파일의 'X (2학기)'는 2학기 열에 들어간다", () => {
  const { ctx } = context();
  const web = (column, subject, semester, group) => ({ column, name: subject, applicationCurrentGrade: "2", applicationGroupSource: "online",
    applicationSubject: { subject: semester ? `${subject} (${semester}학기)` : subject, semester: semester || "1", groupName: group } });
  // 1차(복사해 온 열): app17 = 심화 영어 2학기(폐강), 2차 웹 결과: 폐강 과목을 빼서 app17 = 중국어
  const before = [web("app16", "심화 영어", "1", "3-1 택5"), web("app17", "심화 영어", "2", "3-2 택5"), web("app18", "중국어", "", "3-1 택1")];
  const after = [web("app16", "심화 영어", "1", "3-1 택5"), web("app17", "중국어", "", "3-1 택1")];
  assert.deepEqual(plain(ctx.roundRemapKeysByName(before, after, { "2:app17": "closed", "2:app18": "open" }, "2")), { "2:app17": "open" }, "중국어는 앞 차수 중국어 결정(개설)");
  // '재신청 학생만': 학기 칸 없이 웹 과목 정보로 학기를 아는 두 열 → 파일의 '심화 영어 (2학기)'는 2학기 열
  const data = { students: [{ grade: "2", classroom: "1", number: "1", selections: [before[0]] }], courses: before };
  const overlay = { courses: [{ column: 9, name: "심화 영어 (2학기)", semesterKey: "2" }],
    students: [{ grade: "2", classroom: "1", number: "1", selections: [{ column: 9, name: "심화 영어 (2학기)", semesterKey: "2" }] }] };
  const { slice } = ctx.roundMergeGradeStudents(data, {}, "2", overlay);
  assert.equal(slice.students[0].selections[0].column, "app17");
  assert.deepEqual(plain(ctx.roundCourseIdentity(before[1])), { name: "심화영어", semester: "2", key: "심화영어|2" });
});
