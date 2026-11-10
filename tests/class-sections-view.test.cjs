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
  assert.match(ctx.classSectionsClassesHtml(group, entry), /지금 반 기준 — 진급 때 반을 새로 편성하므로 효과 없음/);
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
  assert.ok(waiting.warnings.some((text) => /1명분 행은 반 배정표를 올린 뒤 생성/.test(text)));
  assert.deepEqual(plain(ctx.classSectionsRestore({ classMaps: { "1": { "1-1-1": { classroom: "2" } } } })), { classMaps: { "1": { "1-1-1": { classroom: "2" } } } });
});

test("screen tidy-up: status belongs to its group, readable section names with the NEIS name beside, teacher-limit note, group order", () => {
  const ctx = context();
  const group = ctx.classSectionsSource("1").groups[0];
  // 상태 문구: 다른 그룹(또는 그룹을 바꾼 뒤)에는 보이지 않는다
  ctx.CLASS_SECTIONS_VIEW.round = "1";
  ctx.CLASS_SECTIONS_VIEW.group = "1:2:other";
  ctx.classSectionsSetStatus("편성 완료 · 분반 55개", false, { round: "1", group: group.key });
  assert.equal(ctx.CLASS_SECTIONS_VIEW.status.group, group.key);
  // 교사 수 안내: 5단계 교사 수가 비면 '제한 없이'
  const settings = ctx.classSectionsSettings();
  const entry = ctx.classSectionsEntry("1", group.key);
  const input = ctx.classSectionsBuildInput("1", group, entry);
  assert.match(ctx.classSectionsTeacherNote(settings, group, input), /5단계 교과별 교사 수로 블록당 분반을 제한합니다 · 5단계 교사 수가 비어 있는 교과\(제한 없음\): 과학-지구/);
  assert.match(ctx.classSectionsTeacherNote(settings, group, { ...input, departmentTeachers: null }), /5단계 교사 수가 비어 있어 교사 수 제한 없이 계산합니다/);
  settings.teachers.push({ id: "t1", name: "물리A", department: "과학-물리" });
  assert.match(ctx.classSectionsTeacherNote(settings, group, input), /명단에 없는 교과는 교사 수 제한 없이 계산: 과학-화학, 과학-지구/);
  assert.equal(ctx.classSectionsCircled(2), "②");
  const view = fs.readFileSync(path.join(root, "class-sections-view.js"), "utf8");
  assert.match(view, /나이스 \$\{esc\(section\.roomName\)\}/, "card shows the NEIS room name in small text");
  assert.match(view, /> 블록 고정<\/label>/);
  assert.match(view, /같은 담임반 학생이 같은 분반에 모인 비율/);
  // 그룹 순서: 현 학년 → 학기 → 택n 큰 것
  assert.match(view, /a\.grade\.localeCompare\(b\.grade\) \|\| a\.semester\.localeCompare\(b\.semester\)/);
});

test("promotion setting per grade: same classes & '그대로' / same & '아직 모름' / different counts (forced '새로 편성')", () => {
  // 1) 반 수 같음(4 → 4) + 그대로 올라감: 지금 반 = 내년 반, 추천 대상, 학급 단위 학생 배정 확정, 나이스 반은 지금 반·번호는 비움
  let ctx = context();
  ctx.state.roundStatuses["1"].snapshot.classBases = { "2": 4 };
  let group = ctx.classSectionsSource("1").groups[0];
  let entry = ctx.classSectionsEntry("1", group.key);
  const settings = ctx.classSectionsSettings();
  assert.deepEqual(plain(ctx.classSectionsPromotion(group)), { value: "unknown", forced: false, reason: "" }, "default when counts are equal");
  settings.promotion["1"] = "same";
  let input = plain(ctx.classSectionsBuildInput("1", group, entry));
  assert.equal(input.homeroomBasis, "next");
  assert.deepEqual(input.recommendExclude, []);
  assert.deepEqual(input.students.map((student) => student.homeroom), plain(group.students.map((student) => student.homeroom)));
  settings.courseModes["지구과학"] = "class";
  assert.equal(ctx.classSectionsClassUnitPlan(group, entry, settings).mapped, true);
  const effective = plain(ctx.classSectionsEffectiveClassMap(group));
  assert.equal(effective.basis, "same");
  assert.deepEqual(effective.map["1-3-7"], { classroom: "3", number: "" });
  assert.match(ctx.classSectionsClassesHtml(group, entry), /진급 때 반이 그대로 올라감/);
  entry.mode = "homeroom";
  assert.doesNotMatch(ctx.classSectionsClassesHtml(group, entry), /classSectionsHomeroomWarn/);
  // 배정표를 올리면 그것이 우선
  ctx.classSectionsStore().classMaps = { "1": { "1-1-1": { classroom: "2", number: "5" } } };
  assert.equal(ctx.classSectionsEffectiveClassMap(group).basis, "map");

  // 2) 반 수 같음 + 아직 모름: 조건형 문구, 추천 제외
  ctx = context();
  ctx.state.roundStatuses["1"].snapshot.classBases = { "2": 4 };
  group = ctx.classSectionsSource("1").groups[0];
  entry = ctx.classSectionsEntry("1", group.key);
  input = plain(ctx.classSectionsBuildInput("1", group, entry));
  assert.deepEqual(input.recommendExclude, ["homeroom"]);
  entry.mode = "homeroom";
  const html = ctx.classSectionsClassesHtml(group, entry);
  assert.match(html, /진급 때 반이 바뀌면 ‘같은 담임반끼리 묶기’\(지금 반 기준\)는 효과가 없으므로 추천에서 뺍니다/);
  assert.match(html, /지금 반 기준 — 진급 때 반이 바뀌면 효과 없음/);
  assert.equal(ctx.classSectionsClassUnitPlan(group, entry, ctx.classSectionsSettings()).mapped, false);

  // 3) 반 수 다름(4 → 5): '새로 편성' 고정, '그대로'는 고를 수 없음(이유 표시) — 저장값이 'same'이어도 무시
  ctx = context();
  ctx.state.roundStatuses["1"].snapshot.classBases = { "2": 5 };
  group = ctx.classSectionsSource("1").groups[0];
  entry = ctx.classSectionsEntry("1", group.key);
  ctx.classSectionsSettings().promotion["1"] = "same";
  const forced = plain(ctx.classSectionsPromotion(group));
  assert.equal(forced.value, "new");
  assert.equal(forced.forced, true);
  assert.match(forced.reason, /현 4학급 → 내년 5학급/);
  assert.equal(ctx.classSectionsEffectiveClassMap(group).basis, "none");
  assert.deepEqual(plain(ctx.classSectionsBuildInput("1", group, entry)).recommendExclude, ["homeroom"]);
  const forcedHtml = ctx.classSectionsClassesHtml(group, entry);
  assert.match(forcedHtml, /<option value="same" disabled>그대로 올라감<\/option>/);
  assert.match(forcedHtml, /id="classSectionsPromotionReason"/);
});

test("6차 화면: 다른 학년 점유로 '입력 변경됨' 안 됨·다른 학년 변경 안내, 키 정규화·배정표 합치기·지우기, 교사 id 중복, 학년별 과목 설정, 시안→확정 머리글, 학급 단위 시트", () => {
  const ctx = context();
  // '01'반·'3반' 표기 → 정규화된 키
  ctx.state.rounds["1"].students.forEach((student) => { student.classroom = `0${student.classroom}`; });
  ctx.state.rounds["1"].students.push({ id: "x", grade: "1", classroom: "04", number: 11, name: "미신청", selections: [] });
  const group = ctx.classSectionsSource("1").groups[0];
  assert.equal(group.students[0].key, "1-1-1");
  assert.equal(group.gradeStudents.length, 41, "all grade students, including ones without selections");
  assert.equal(ctx.classSectionsStudentNames("1").get("1-1-1"), "가명11");
  const entry = ctx.classSectionsEntry("1", group.key);
  // 다른 학년 결과가 있어도 서명은 같다(occupied 제외)
  entry.blockTimes.a = "월1,수1";
  const plainSig = ctx.classSectionsSignature(ctx.classSectionsBuildInput("1", group, entry, { noOccupied: true }));
  assert.equal(ctx.classSectionsSignature(ctx.classSectionsBuildInput("1", group, entry)), plainSig);
  // 배정표 합치기: 파일에 있는 학생만 갱신, 나머지 유지, 명단에 없는 키는 따로 셈
  ctx.CLASS_SECTIONS_VIEW.round = "1";
  let merged = ctx.classSectionsMergeClassMap({ "1-1-1": { classroom: "02", number: "03" }, "1-9-9": { classroom: "1" } });
  assert.equal(merged.updated, 1);
  assert.equal(merged.unmatched, 1);
  merged = ctx.classSectionsMergeClassMap({ "1-2-1": { classroom: "3" } });
  assert.match(merged.text, /갱신 1명 · 유지 1명/);
  assert.deepEqual(plain(ctx.classSectionsClassMap("1")["1-1-1"]), { classroom: "2", number: "3" });
  // 교사 id 중복은 다시 매김
  const settings = ctx.classSectionsSettings();
  settings.teachers.push({ id: "t-물리-1", name: "가" }, { id: "t-물리-1", name: "나" });
  ctx.classSectionsSettings();
  assert.deepEqual(plain(settings.teachers.map((teacher) => teacher.id)), ["t-물리-1", "t-물리-1~2"]);
  assert.match(ctx.CLASS_SECTIONS_VIEW.teacherIdWarning, /바꿨습니다/);
  // 학년별 과목 설정 + 예전 값 옮기기
  settings.courseModes = { 지구과학: "class" };
  assert.equal(ctx.classSectionsCourseConf(settings, "courseModes", "1")["지구과학"], "class");
  assert.equal(ctx.classSectionsCourseConf(settings, "courseModes", "2")["지구과학"], "class", "old flat value copied to every grade");
  ctx.classSectionsCourseConf(settings, "courseModes", "2")["지구과학"] = "move";
  assert.equal(ctx.classSectionsCourseConf(settings, "courseModes", "1")["지구과학"], "class", "grade 2 change stays in grade 2");
  // 학급 단위 시트
  const sheet = plain(ctx.classSectionsClassUnitSheet(group, entry, settings));
  assert.deepEqual(sheet.rows[1], ["내년 반", "과목", "학생 수", "비고"]);
  assert.equal(sheet.rows.length, 2 + group.classes);
  // 시안 → 확정: 입력이 같으면 '확정 결과 기준(시안 때 계산 · 입력 같음)'
  const input = ctx.classSectionsBuildInput("1", group, entry);
  ctx.classSectionsSaveResult(entry, ctx.classSectionsSolve({ ...input, maxSectionsPerBlock: 5 }), input, group, { locked: false });
  assert.equal(entry.sectionResult.draft, true);
  assert.equal(ctx.classSectionsResultBasis("1", group, entry, entry.sectionResult), "확정 결과 기준(시안 때 계산 · 입력 같음)");
  entry.classCounts["화학"] = 4;
  assert.equal(ctx.classSectionsResultBasis("1", group, entry, entry.sectionResult), "확정 전 시안 · 입력 변경됨");
});
