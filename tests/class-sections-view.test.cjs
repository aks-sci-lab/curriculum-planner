// 6단계 분반 편성 화면 연결(class-sections-view.js)의 입력 모으기·저장 모양·복원. 화면 클릭 확인은 Playwright(사용자처럼)로 따로 한다.
// 학생 자료는 합성(가명)이다.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const solver = fs.readFileSync(path.join(root, "class-sections.js"), "utf8");
const view = fs.readFileSync(path.join(root, "class-sections-view.js"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function context() {
  const students = [];
  for (let c = 1; c <= 4; c += 1) for (let n = 1; n <= 10; n += 1) {
    const pick = (c + n) % 2 ? ["c1", "c2"] : ["c2", "c3"];
    students.push({ id: `${c}-${n}`, grade: "1", classroom: c, number: n, name: `가명${c}${n}`, selections: pick.map((column) => ({ column, credits: 3 })) });
  }
  const courses = [{ column: "c1", name: "물리학" }, { column: "c2", name: "화학" }, { column: "c3", name: "지구과학" }];
  const state = { rounds: { "1": { students, courses } }, currentRound: "1", roundStatuses: { "1": { status: "confirmed", snapshot: {
    maxClassSize: 30, classBases: { "2": 2 }, rows: [{ grade: "1", semester: "1", group: "2-1 택2", name: "화학", classCount: 3 }] } } }, roundClosures: {}, students: [] };
  const elements = { "#schoolYear": { value: "2026" }, "#maxClassSize": { value: "34" } };
  const ctx = vm.createContext({
    state, performance, console,
    $: (selector) => elements[selector] || null,
    applicationRoundNumbers: () => ["1"],
    roundStatusData: (round) => state.rounds[round],
    isRoundLocked: (round) => state.roundStatuses[round]?.status === "confirmed",
    hoursDefaultDepartment: (name, area = "") => ({ 물리학: "과학-물리", 화학: "과학-화학", 지구과학: "과학-지구" })[name] || (/사회/.test(area) ? "사회-일사" : "기타"),
    hoursSettings: () => ({ teachers: { "과학-물리": 2, "과학-화학": 2 } }),
    hoursTargetYear: () => "2027",
    // 4단계 집계 모양만 흉내 낸다(그룹 2-1 택2, 과목 3개).
    aggregateRecords: (list) => ({ reports: [{ summary: { grade: "1", classes: 4 }, semesters: [{ order: 1, groups: [{ category: "2-1 택2", choiceCount: 2,
      courses: courses.map((course) => ({ column: course.column, name: course.name, subjectName: course.name, classCount: 2,
        enrollment: list.filter((student) => student.selections.some((selection) => selection.column === course.column)).length })) }] }] }] })
  });
  vm.runInContext(solver, ctx);
  vm.runInContext(view, ctx);
  return ctx;
}

test("source: groups from the round result, stage-4 counts from the confirmed snapshot, student keys without names", () => {
  const ctx = context();
  const source = plain(ctx.classSectionsSource("1"));
  assert.equal(source.locked, true);
  assert.equal(source.maxClassSize, 30);
  assert.equal(source.groups.length, 1);
  const group = source.groups[0];
  assert.equal(group.key, "1:1:2-1 택2");
  assert.equal(group.label, "현1 → 2학년 1학기 · 2-1 택2");
  assert.equal(group.classes, 2, "next-year classes from the snapshot");
  assert.deepEqual(group.courses.map((course) => [course.key, course.classCount, course.credits]), [["물리학", 2, 3], ["화학", 3, 3], ["지구과학", 2, 3]]);
  assert.equal(group.students.length, 40);
  assert.deepEqual(group.students[0], { key: "1-1-1", homeroom: "1", number: "1", courses: ["화학", "지구과학"] });
  assert.ok(!JSON.stringify(group).includes("가명"), "no names in the gathered input");
});

test("input: 6th-step counts and per-section capacities, block times, hours teacher counts, pins; signature tracks inputs", () => {
  const ctx = context();
  const group = ctx.classSectionsSource("1").groups[0];
  const entry = ctx.classSectionsEntry("1", group.key);
  entry.classCounts["물리학"] = 3;
  entry.capacities["화학"] = "30,31, 32";
  entry.blockTimes.a = "월1, 수2 금3";
  entry.pins.sections["물리학#1"] = "b";
  const input = plain(ctx.classSectionsBuildInput("1", group, entry));
  assert.equal(input.blocks.length, 2);
  assert.equal(input.maxSectionsPerBlock, 2);
  assert.equal(input.defaultCapacity, 30);
  assert.deepEqual(input.blocks[0].times, [{ day: "월", period: 1 }, { day: "수", period: 2 }, { day: "금", period: 3 }]);
  assert.equal(input.courses.find((course) => course.key === "물리학").sections, 3);
  assert.deepEqual(input.courses.find((course) => course.key === "화학").capacities, [30, 31, 32]);
  assert.deepEqual(input.departmentTeachers, { "과학-물리": 2, "과학-화학": 2 });
  assert.deepEqual(input.pins.sections, { "물리학#1": "b" });
  const before = ctx.classSectionsSignature(input);
  entry.capacities["화학"] = "30,30,30";
  assert.notEqual(ctx.classSectionsSignature(ctx.classSectionsBuildInput("1", group, entry)), before);
  // 계산 결과를 저장하는 모양: 학생은 키만
  const result = ctx.classSectionsSolve({ ...input, maxSectionsPerBlock: 4 });
  ctx.classSectionsSaveResult(entry, result, input, group, { locked: true });
  assert.equal(entry.sectionResult.draft, false);
  assert.ok(Object.keys(entry.sectionResult.assign).every((key) => /^1-\d+-\d+$/.test(key)));
  assert.ok(!JSON.stringify(entry).includes("가명"));
});

test("teacher list: department by default, narrowed to courses, unavailable slots with reason", () => {
  const ctx = context();
  const settings = ctx.classSectionsSettings();
  settings.teachers.push({ id: "t1", name: "김교사", alias: "물리A", department: "과학-물리", courses: "물리학", unavailable: ["월1", "수5"], reason: "육아시간" });
  settings.teachers.push({ id: "t2", name: "" });
  const list = plain(ctx.classSectionsTeacherList(settings));
  assert.deepEqual(list, [{ id: "t1", name: "물리A", departments: ["과학-물리"], courses: ["물리학"],
    unavailable: [{ day: "월", period: 1, reason: "육아시간" }, { day: "수", period: 5, reason: "육아시간" }] }]);
  assert.equal(settings.spreadWarn, 4);
});

test("restore keeps settings and round entries only; app wiring stores classSections and step 8", () => {
  const ctx = context();
  assert.deepEqual(plain(ctx.classSectionsRestore(undefined)), {});
  assert.deepEqual(plain(ctx.classSectionsRestore({ settings: { teachers: [] }, "1": { "1:1:g": { mode: "move" }, bad: 3 }, junk: {} })),
    { settings: { teachers: [] }, "1": { "1:1:g": { mode: "move" } } });
  assert.match(app, /classSections: state\.classSections,/);
  assert.match(app, /state\.classSections = typeof classSectionsRestore === "function"/);
  assert.match(app, /if \(step === 8 && typeof renderClassSections === "function"\) renderClassSections\(\);/);
  assert.match(view, /deferRenderUntilStepVisible\(8, "renderClassSections", renderClassSections\)/);
  const store = fs.readFileSync(path.join(root, "workspace-store.js"), "utf8");
  assert.match(store, /WORKSPACE_STORE_SPLIT_KEYS = \[[^\]]*"sectionResult"/);
});

test("plan 교과(군) gives the department default and the NEIS 편제명; class-unit subjects lower the suggested block count", () => {
  const ctx = context();
  ctx.collectApplicationSubjects = ({ currentGrade }) => currentGrade === "1"
    ? { "2": [{ subject: "지구과학", area: "사회(역사/도덕 포함)", credit: "4" }, { subject: "물리학", area: "과학", credit: 3 }] } : null;
  const group = ctx.classSectionsSource("1").groups[0];
  const earth = group.courses.find((course) => course.key === "지구과학");
  assert.equal(earth.area, "사회(역사/도덕 포함)");
  assert.equal(earth.department, "과학-지구", "name rule first");
  assert.equal(ctx.classSectionsNeisFamily(earth.area, earth.department), "사회(역사/도덕포함)");
  assert.equal(ctx.classSectionsNeisFamily("", "과학-물리"), "과학");
  assert.equal(ctx.classSectionsNeisFamily("", "제2외국어"), "제2외국어/한문");
  // 학급 단위: 학생이 고른 학급 단위 과목 수만큼 블록 수 기본값을 줄인다(직접 입력하면 그 값)
  const settings = ctx.classSectionsSettings();
  assert.deepEqual(plain(ctx.classSectionsSuggestedBlocks(group, settings)), { blocks: 2, removed: 0 });
  settings.courseModes["지구과학"] = "class";
  assert.deepEqual(plain(ctx.classSectionsSuggestedBlocks(group, settings)), { blocks: 1, removed: 1 });
  const entry = ctx.classSectionsEntry("1", group.key);
  assert.equal(ctx.classSectionsGroupSettings({ maxClassSize: 30 }, group, entry).blocks, 1);
  entry.blocks = 2;
  assert.equal(ctx.classSectionsGroupSettings({ maxClassSize: 30 }, group, entry).blocks, 2);
});

test("solving every group of a semester together: inputs skip saved occupancy, view wires the button", () => {
  const ctx = context();
  const group = ctx.classSectionsSource("1").groups[0];
  const entry = ctx.classSectionsEntry("1", group.key);
  const input = plain(ctx.classSectionsBuildInput("1", group, entry, { noOccupied: true }));
  assert.deepEqual(input.occupied, []);
  assert.equal(input.noOccupied, undefined);
  assert.match(view, /id="classSectionsSolveSemester"[\s\S]*?>전 학년 함께 다시 계산</);
  assert.match(view, /kind: "solveAll"/);
});

test("block time recommendation input: department demand per block (estimate before solving, real blocks after), apply writes block times", () => {
  const ctx = context();
  const group = ctx.classSectionsSource("1").groups[0];
  const entry = ctx.classSectionsEntry("1", group.key);
  const settings = ctx.classSectionsSettings();
  assert.equal(settings.gridDays, "월,화,수,목,금");
  assert.equal(settings.gridPeriods, 7);
  const estimate = plain(ctx.classSectionsBlockDemand("1", group, entry, settings));
  assert.deepEqual(estimate.map((block) => block.id), ["a", "b"]);
  assert.equal(estimate[0].hours, 3);
  const total = (blocks) => blocks.reduce((sum, block) => sum + Object.values(block.departments).reduce((a, b) => a + b, 0), 0);
  assert.equal(total(estimate), 2 + 3 + 2, "every section counted once");
  const input = ctx.classSectionsBuildInput("1", group, entry);
  ctx.classSectionsSaveResult(entry, ctx.classSectionsSolve({ ...input, maxSectionsPerBlock: 5 }), input, group, { locked: true });
  const real = plain(ctx.classSectionsBlockDemand("1", group, entry, settings));
  assert.equal(total(real), 7);
  const recommended = ctx.classSectionsRecommendTimes({ days: ["월", "화", "수", "목", "금"], periods: 7, seed: 1, groups: [{ groupId: group.key, label: group.label, grade: "2", blocks: real }] });
  ctx.CLASS_SECTIONS_VIEW.timesProposal = { round: "1", semester: "1", result: recommended, edits: { [`${group.key}|b`]: "화1,목1,금1" }, labels: {} };
  ctx.renderClassSections = () => {};
  ctx.persistStateSoon = () => {};
  ctx.classSectionsApplyTimes();
  assert.equal(entry.blockTimes.b, "화1,목1,금1", "edited cell wins");
  assert.equal(entry.blockTimes.a.split(",").length, 3);
  assert.equal(ctx.CLASS_SECTIONS_VIEW.timesProposal, null);
});

test("promotion re-forms classes (now 4 → next year 5): next-year counts, homeroom grouping and class-unit students wait for the class map", () => {
  const ctx = context();
  ctx.state.roundStatuses["1"].snapshot.classBases = { "2": 5 };
  const group = ctx.classSectionsSource("1").groups[0];
  assert.equal(group.rosterClasses, 4);
  assert.equal(group.nextClasses, 5);
  assert.equal(group.classes, 5, "block limit / class-unit default = next-year classes");
  const entry = ctx.classSectionsEntry("1", group.key);
  assert.equal(ctx.classSectionsGroupSettings({ maxClassSize: 30 }, group, entry).maxSectionsPerBlock, 5);
  assert.match(ctx.classSectionsClassesHtml(group, entry), /현 1학년 4학급 → 내년 2학년 5학급/);
  // 배정표 없음: 지금 반 기준 + 추천 제외 + 담임반 방식 경고
  let input = plain(ctx.classSectionsBuildInput("1", group, entry));
  assert.equal(input.homeroomBasis, "current");
  assert.deepEqual(input.recommendExclude, ["homeroom"]);
  entry.mode = "homeroom";
  assert.match(ctx.classSectionsClassesHtml(group, entry), /지금 반 기준 — 진급 때 반이 바뀌면 효과 없음/);
  // 학급 단위 과목: 내년 5학급으로 반 수만 확정, 학생 배정은 배정표 뒤
  const settings = ctx.classSectionsSettings();
  settings.courseModes["지구과학"] = "class";
  settings.courseModes["물리학"] = "class";
  entry.classCounts["지구과학"] = 2; entry.classCounts["물리학"] = 3;
  let plan = plain(ctx.classSectionsClassUnitPlan(group, entry, settings));
  assert.deepEqual(plan.homerooms, ["1", "2", "3", "4", "5"]);
  assert.equal(plan.mapped, false);
  assert.equal(plan.ratio, "3:2");
  assert.match(ctx.classSectionsClassUnitHtml(group, entry, settings), /학생 배정은 내년 반 배정표를 올린 뒤/);
  // 내년 반 배정표를 올리면 새 반 기준
  ctx.classSectionsStore().classMaps = { "1": Object.fromEntries(group.students.map((student, index) => [student.key, { classroom: String(1 + (index % 5)), number: String(1 + Math.floor(index / 5)) }])) };
  input = plain(ctx.classSectionsBuildInput("1", group, entry));
  assert.equal(input.homeroomBasis, "next");
  assert.deepEqual(input.recommendExclude, []);
  assert.deepEqual([...new Set(input.students.map((student) => student.homeroom))].sort(), ["1", "2", "3", "4", "5"]);
  plan = plain(ctx.classSectionsClassUnitPlan(group, entry, settings));
  assert.equal(plan.mapped, true);
  // 나이스: 학급 단위 과목 행은 새 반 'N(2학년 N반)'
  const result = ctx.classSectionsSolve({ ...input, maxSectionsPerBlock: 5 });
  const map = ctx.classSectionsClassMap("1");
  const exported = plain(ctx.classSectionsNeisExport(result, { year: 2027, semester: 1, targetGrade: 2,
    students: group.students.map((student) => ({ key: student.key, classroom: map[student.key].classroom, number: map[student.key].number })),
    classUnit: { byClass: plan.assign, courses: { 물리학: { name: "물리학", credits: 3 }, 지구과학: { name: "지구과학", credits: 3 } } } }));
  const unitRows = exported.rows.filter((row) => /^\d\(2학년 \d반\)$/.test(row[5]));
  assert.equal(unitRows.length, group.students.length);
  for (const row of unitRows) assert.equal(row[5], `${row[7].replace("반", "")}(2학년 ${row[7]})`);
  // 배정표 없는 학생은 학급 단위 행을 만들지 않고 안내
  const waiting = plain(ctx.classSectionsNeisExport(result, { targetGrade: 2, students: [{ key: group.students[0].key }], classUnit: { byClass: plan.assign, courses: {} } }));
  assert.ok(waiting.warnings.some((text) => /학생 배정은 반 배정표를 올린 뒤/.test(text)));
  assert.deepEqual(plain(ctx.classSectionsRestore({ classMaps: { "1": { "1-1-1": { classroom: "2" } } } })), { classMaps: { "1": { "1-1-1": { classroom: "2" } } } });
});
