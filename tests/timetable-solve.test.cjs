// 7단계 시간표 풀이기(timetable-solve.js): 문제 만들기·구성·탐색·항상 결과·두 학기 뼈대·검증기·Worker. 모든 자료는 합성이다.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { school } = require("./helpers/timetable-school.cjs");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function context() {
  const ctx = vm.createContext({});
  vm.runInContext(read("timetable.js"), ctx);
  vm.runInContext(read("timetable-solve.js"), ctx);
  return ctx;
}

// 작은 학교: 학년마다 3반, 월~금 6교시(30칸), 전교 동시 창체 월1. 1학년 반 수업 24, 2학년 반 수업 14 + 블록 2개 × 3, 3학년 반 수업 3 + 블록 3개 × 4.
function small(change = () => {}) {
  const teachers = [];
  const staff = (department, count) => { for (let n = 1; n <= count; n += 1) teachers.push({ id: `${department}${n}`, name: `${department}${n}`, departments: [department] }); };
  for (const [department, count] of Object.entries({ 국어: 3, 수학: 3, 영어: 3, 사회: 1, 과학: 1, 체육: 2, 음악: 1, 미술: 1, 진로: 1, 선택가: 2, 선택나: 2, 선택다: 2 })) staff(department, count);
  const sections = (prefix, hours) => ["선택가", "선택나", "선택다"].map((department, index) => ({ id: `${prefix}-${index + 1}`, subject: `${department} 과목`, department, credits: hours }));
  const input = {
    semester: "1", days: "월,화,수,목,금", periods: 6, lunchAfter: { 3: 3 },
    grades: [{ grade: "1", classes: 3 }, { grade: "2", classes: 3 }, { grade: "3", classes: 3 }],
    creative: { school: 1, schoolTimes: ["월1"] }, teachers,
    lessons: [
      ...[["국어", 4], ["수학", 4], ["영어", 4], ["사회", 3], ["과학", 3], ["체육", 2], ["음악", 2], ["미술", 2]].map(([subject, hours]) => ({ id: `1${subject}`, grade: "1", subject, department: subject, hours })),
      ...[["국어", 4], ["수학", 4], ["영어", 4], ["체육", 2]].map(([subject, hours]) => ({ id: `2${subject}`, grade: "2", subject: `${subject}Ⅱ`, department: subject, hours })),
      { id: "3체육", grade: "3", subject: "스포츠", department: "체육", hours: 2 }, { id: "3진로", grade: "3", subject: "진로", department: "진로", hours: 1 }
    ],
    blocks: [
      ...["a", "b"].map((id) => ({ id: `2${id}`, grade: "2", label: `${id}블록`, sections: sections(`2${id}`, 3) })),
      ...["a", "b", "c"].map((id) => ({ id: `3${id}`, grade: "3", label: `${id}블록`, sections: sections(`3${id}`, 4) }))
    ],
    rules: {}
  };
  change(input);
  return input;
}
const hoursOf = (layer) => Object.values(layer.lessons).reduce((sum, item) => sum + item.slots.filter(Boolean).length, 0);

test("작은 학교: 필수 조건을 모두 지킨 시간표, 검증기와 같은 수, 같은 씨앗 = 같은 결과", () => {
  const ctx = context();
  const inputs = { 1: small() };
  const result = plain(ctx.timetableSolve(inputs, { seed: 3, iterations: 60000 }));
  const check = plain(ctx.timetableValidate(inputs, result));
  assert.deepEqual([check.ok, check.errors], [true, []]);
  assert.deepEqual([result.metrics.hard, result.metrics.noTeacherHours, result.metrics.unplacedHours, result.violations.filter((item) => item.level === "hard")], [0, 0, 0, []]);
  assert.deepEqual(check.counts, { gap: 0, oncePerDay: 0, run: 0, maxPerDay: 0, lunch: 0 });
  // 반마다 주간 수업 수 그대로: (24 + 14 + 3) × 3반 + 블록(2 × 3 + 3 × 4) × 3반 + 창체 9
  assert.equal(check.hours["1"], (24 + 14 + 3) * 3 + (6 + 12) * 3 + 9);
  assert.equal(hoursOf(result.layers["1"]), (24 + 14 + 3) * 3);
  // 교사는 모두 후보(전공 일치) 안에서, 같은 교사가 같은 반에 하루 한 번
  const korean = Object.entries(result.layers["1"].lessons).filter(([id]) => id.startsWith("1국어@")).map(([, item]) => item.teacherId);
  assert.ok(korean.every((id) => /^국어\d$/.test(id)));
  assert.deepEqual(result.layers["1"].creative, [{ scope: "school", grade: "", slots: ["월1"] }]);
  // 재현: 같은 씨앗 = 같은 결과(조각 크기와 무관), 다른 씨앗 = 다른 배치
  assert.deepEqual(plain(ctx.timetableSolve(inputs, { seed: 3, iterations: 60000, chunk: 777 })), result);
  assert.notDeepEqual(plain(ctx.timetableSolve(inputs, { seed: 4, iterations: 60000 })).layers, result.layers);
  // 중단: 조각으로 돌리다 멈춰도 늘 완성된 결과
  const run = ctx.timetableSolveStart(inputs, { seed: 3, iterations: 60000 });
  const progress = plain(ctx.timetableSolveStep(run, 500));
  assert.deepEqual([progress.done, progress.iteration, progress.total], [false, 500, 60000]);
  const early = plain(ctx.timetableSolveFinish(run));
  assert.equal(plain(ctx.timetableValidate(inputs, early)).ok, true);
  assert.equal(early.metrics.unplacedHours, 0);
});

test("항상 결과: 맡을 교사가 없거나 모자라면 '담당 교사 없음'으로 반 시간표에 넣고, 못 지킨 조건은 위반 목록으로", () => {
  const ctx = context();
  // 1) 후보가 없는 과목(기술), 설 수 있는 시간보다 많은 수업(사회 1명에게 3반 × 12시간)
  const inputs = { 1: small((input) => {
    input.lessons.push({ id: "3기술", grade: "3", subject: "기술", department: "기술", hours: 2 });
    input.lessons.find((lesson) => lesson.id === "1사회").hours = 12;
    input.lessons = input.lessons.filter((lesson) => !["1음악", "1미술", "1체육", "1과학"].includes(lesson.id));
  }) };
  const result = plain(ctx.timetableSolve(inputs, { seed: 1, iterations: 40000 }));
  const check = plain(ctx.timetableValidate(inputs, result));
  assert.deepEqual([check.ok, check.errors], [true, []]);
  assert.equal(result.metrics.unplacedHours, 0, "반 시간표는 빠짐없이");
  const none = result.noTeacher.filter((item) => item.subject === "기술");
  assert.deepEqual(none.map((item) => [item.semester, item.grade, item.hours, item.reason]), [["1", "3", 2, "none"], ["1", "3", 2, "none"], ["1", "3", 2, "none"]]);
  assert.ok(Object.entries(result.layers["1"].lessons).filter(([id]) => id.startsWith("3기술@")).every(([, item]) => item.teacherId === null && item.slots.length === 2));
  // 사회 교사 1명이 설 수 있는 시간(약 25~29시간)에 36시간 → 한 반(12시간)은 담당 교사 없음
  const social = result.noTeacher.filter((item) => item.subject === "사회");
  assert.deepEqual(social.map((item) => [item.hours, item.reason]), [[12, "capacity"]]);
  assert.equal(result.metrics.noTeacherHours, 6 + 12);
  // 한 교사가 한 반에 주 12시간이면 하루 한 번을 지킬 수 없다 → 위반 목록(자동으로 풀지 않음)
  const twice = result.violations.filter((item) => item.rule === "oncePerDay");
  assert.ok(twice.length > 0 && twice.every((item) => item.level === "hard" && /하루에 두 번/.test(item.cause)));
  assert.equal(result.metrics.oncePerDay, check.counts.oncePerDay);
  // 2) 규칙을 '최대한'으로 낮추면 같은 상황이 위반이 아니라 최대한 줄일 대상
  inputs[1].rules = { oncePerDay: "soft" };
  const soft = plain(ctx.timetableSolve(inputs, { seed: 1, iterations: 40000 }));
  assert.equal(soft.metrics.hard, 0);
  assert.ok(soft.violations.every((item) => item.level !== "hard"));
  assert.equal(plain(ctx.timetableValidate(inputs, soft)).ok, true);
});

test("교사 불가 시간·정해진 블록 시간·정해진 교사·분반 교사·장소를 지킨다", () => {
  const ctx = context();
  const inputs = { 1: small((input) => {
    input.teachers.find((teacher) => teacher.id === "사회1").unavailable = ["월1", "월2", "화1", "화2", "수1"];
    input.teachers.find((teacher) => teacher.id === "체육2").days = ["화", "목"];
    input.blocks.find((block) => block.id === "2a").times = ["화1", "수2", "금3"];
    input.blocks.find((block) => block.id === "3a").sections[0].teacherId = "선택가2";
    input.lessons.find((lesson) => lesson.id === "1국어").teacherByClass = { "1-1": "국어3" };
    for (const lesson of input.lessons) if (/체육|스포츠/.test(lesson.subject)) lesson.venue = "체육";
    input.venues = { 체육: 1 };
  }) };
  const result = plain(ctx.timetableSolve(inputs, { seed: 2, iterations: 80000 }));
  const check = plain(ctx.timetableValidate(inputs, result));
  assert.deepEqual([check.ok, check.errors], [true, []], "검증기: 불가 시간·교사 겹침·장소·후보·블록 시간");
  assert.deepEqual(result.layers["1"].blocks["2a"].slots.slice().sort(), ["금3", "수2", "화1"]);
  assert.equal(result.layers["1"].blocks["3a"].teachers["3a-1"], "선택가2");
  assert.equal(result.layers["1"].lessons["1국어@1-1"].teacherId, "국어3");
  const pe2 = Object.values(result.layers["1"].lessons).filter((item) => item.teacherId === "체육2").flatMap((item) => item.slots);
  assert.ok(pe2.length > 0 && pe2.every((key) => /^[화목]/.test(key)), "출근 요일(화·목)에만 수업");
  const social = Object.values(result.layers["1"].lessons).filter((item) => item.teacherId === "사회1").flatMap((item) => item.slots);
  assert.ok(social.every((key) => !["월1", "월2", "화1", "화2", "수1"].includes(key)));
  // 체육 장소 1곳: 같은 시각에 체육 수업 하나만(검증기가 확인), 블록 분반 교사는 서로 다르다
  for (const block of Object.values(result.layers["1"].blocks)) { const list = Object.values(block.teachers).filter(Boolean); assert.equal(new Set(list).size, list.length); }
  // 검증기는 틀린 결과를 잡는다: 한 수업을 다른 수업과 같은 칸으로 옮기면 반 겹침, 후보가 아닌 교사면 전공 불일치
  const broken = plain(result);
  const [first, second] = Object.keys(broken.layers["1"].lessons).filter((id) => id.endsWith("@1-1"));
  broken.layers["1"].lessons[first].slots[0] = broken.layers["1"].lessons[second].slots[0];
  broken.layers["1"].lessons[second].teacherId = "미술1";
  const types = plain(ctx.timetableValidate(inputs, broken)).errors.map((error) => error.type);
  assert.ok(types.includes("class") && types.includes("qualification"), types.join(","));
});

test("두 학기 뼈대: 이어지는 수업·블록·창체는 두 학기 같은 칸·같은 교사, 한 학기에만 있는 수업은 그 학기에만", () => {
  const ctx = context();
  const second = small((input) => {
    input.semester = "2";
    // 2학기: 1학년 사회 → 역사(같은 교과·같은 시수 = 이어짐), 음악 2 → 음악 1 + 연극 1(달라짐), 3학년 진로 없음 + 논술 2
    input.lessons.find((lesson) => lesson.id === "1사회").subject = "역사";
    input.lessons.find((lesson) => lesson.id === "1음악").hours = 1;
    input.lessons.push({ id: "1연극", grade: "1", subject: "연극", department: "음악", hours: 1 });
    input.lessons = input.lessons.filter((lesson) => lesson.id !== "3진로");
    input.lessons.push({ id: "3논술", grade: "3", subject: "논술", department: "국어", hours: 2 });
  });
  const inputs = { 1: small(), 2: second };
  const result = plain(ctx.timetableSolve(inputs, { seed: 5, iterations: 150000 }));
  const check = plain(ctx.timetableValidate(inputs, result));
  assert.deepEqual([check.ok, check.errors], [true, []]);
  assert.deepEqual([result.semesters, result.metrics.frame, result.metrics.unplacedHours], [["1", "2"], true, 0]);
  const one = result.layers["1"];
  const two = result.layers["2"];
  // 이어지는 수업: 같은 칸·같은 교사(과목 이름이 달라도 같은 교과·같은 시수면 이어짐)
  for (const id of ["1국어@1-1", "1수학@1-2", "1사회@1-3", "2영어@2-1", "3체육@3-2"]) {
    assert.deepEqual([two.lessons[id].slots.slice().sort(), two.lessons[id].teacherId, two.lessons[id].frame], [one.lessons[id].slots.slice().sort(), one.lessons[id].teacherId, true], id);
  }
  // 블록·창체도 같은 자리
  for (const id of ["2a", "2b", "3a", "3b", "3c"]) assert.deepEqual(two.blocks[id].slots.slice().sort(), one.blocks[id].slots.slice().sort(), id);
  assert.deepEqual(two.creative, one.creative);
  // 한 학기에만 있는 수업: 묶음이 아니고, 그 학기에만 놓인다
  assert.equal(one.lessons["3진로@3-1"].frame, undefined);
  assert.equal(two.lessons["3진로@3-1"], undefined);
  assert.deepEqual([two.lessons["3논술@3-1"].slots.length, two.lessons["3논술@3-1"].frame], [2, undefined]);
  assert.deepEqual([one.lessons["1음악@1-1"].slots.length, two.lessons["1음악@1-1"].slots.length, two.lessons["1연극@1-1"].slots.length], [2, 1, 1]);
  assert.equal(result.metrics.hard, 0, JSON.stringify(result.violations.slice(0, 5)));
  // 뼈대 규칙을 '최대한'으로 두면 묶지 않고 학기마다 따로(묶음 표시 없음)
  inputs[1].rules = { semesterFrame: "soft" };
  inputs[2].rules = { semesterFrame: "soft" };
  const loose = plain(ctx.timetableSolve(inputs, { seed: 5, iterations: 60000 }));
  assert.deepEqual([loose.metrics.frame, loose.metrics.frameActs, Object.values(loose.layers["2"].lessons).some((item) => item.frame)], [false, 0, false]);
  assert.equal(plain(ctx.timetableValidate(inputs, loose)).ok, true);
});

test("창체: 학년별(시간은 계산이 정함)·반군별 허용(반마다 따로)·전교 동시 시간 미정", () => {
  const ctx = context();
  const grade = { 1: small((input) => { input.creative = { school: 1, grade: 1 }; }) };
  const result = plain(ctx.timetableSolve(grade, { seed: 1, iterations: 40000 }));
  assert.equal(plain(ctx.timetableValidate(grade, result)).ok, true);
  assert.deepEqual(result.layers["1"].creative.map((item) => [item.scope, item.grade, item.slots.length]), [["school", "", 1], ["grade", "1", 1], ["grade", "2", 1], ["grade", "3", 1]]);
  const byGroup = { 1: small((input) => { input.creative = { school: 0, grade: 2, byGroup: true }; input.teachers.find((teacher) => teacher.id === "미술1").homeroom = "1-1"; }) };
  const classes = plain(ctx.timetableSolve(byGroup, { seed: 1, iterations: 40000 }));
  assert.equal(plain(ctx.timetableValidate(byGroup, classes)).ok, true);
  assert.equal(classes.layers["1"].creative.length, 9, "반마다 창체 한 줄");
  assert.deepEqual(classes.layers["1"].creative.find((item) => item.classId === "1-1").teacherId, "미술1", "담임이 있으면 담임이 그 시간에 묶인다");
  assert.ok(classes.layers["1"].creative.every((item) => item.scope === "class" && item.slots.length === 2));
});

test("실제 크기 가상 학교(10·11·11반, 교사 60여 명): 한 학기 필수 위반 0, 두 학기 뼈대도 검증 통과", () => {
  const ctx = context();
  const one = { 1: school() };
  const started = Date.now();
  const result = plain(ctx.timetableSolve(one, { seed: 1, iterations: 600000 }));
  const elapsed = Date.now() - started;
  const check = plain(ctx.timetableValidate(one, result));
  assert.deepEqual([check.ok, check.errors], [true, []]);
  assert.deepEqual([result.metrics.hard, result.metrics.noTeacherHours, result.metrics.unplacedHours], [0, 0, 0], JSON.stringify(result.violations.slice(0, 5)));
  assert.ok(elapsed < 60000, `한 학기 ${elapsed}ms`);
  // 두 학기(같은 편제): 모든 수업이 묶음, 검증 통과(탐색은 짧게 — 품질이 아니라 절대 조건·뼈대만 본다)
  const both = { 1: school(), 2: school() };
  both[2].semester = "2";
  const frame = plain(ctx.timetableSolve(both, { seed: 1, iterations: 150000 }));
  const frameCheck = plain(ctx.timetableValidate(both, frame));
  assert.deepEqual([frameCheck.ok, frameCheck.errors, frame.metrics.frame, frame.metrics.unplacedHours], [true, [], true, 0]);
  assert.deepEqual(frame.layers["2"].lessons["1국어@1-1"].slots.slice().sort(), frame.layers["1"].lessons["1국어@1-1"].slots.slice().sort());
});

test("13칸 문제(교사가 반 수보다 적음): 조건을 다 지킬 수 없어도 결과가 나오고 남은 위반을 알려 준다", () => {
  const ctx = context();
  const inputs = { 1: school({ pe3: 3, info3: 3 }) };
  assert.equal(ctx.timetablePrecheck(inputs[1]).ok, false, "사전 점검에서 이미 걸린다");
  const result = plain(ctx.timetableSolve(inputs, { seed: 1, iterations: 200000 }));
  const check = plain(ctx.timetableValidate(inputs, result));
  assert.deepEqual([check.ok, check.errors, result.metrics.unplacedHours], [true, [], 0], "절대 조건은 지키고 반 시간표는 빠짐없이");
  assert.ok(result.metrics.hard > 0 || result.metrics.noTeacherHours > 0, "남은 위반 또는 담당 교사 없음으로 드러난다");
  assert.ok(result.violations.every((item) => item.cause && item.semester === "1" && ["class", "teacher"].includes(item.kind)));
  assert.deepEqual([result.metrics.gap, result.metrics.oncePerDay, result.metrics.run, result.metrics.maxPerDay, result.metrics.lunch], [check.counts.gap, check.counts.oncePerDay, check.counts.run, check.counts.maxPerDay, check.counts.lunch]);
});

test("Worker 소스: 조각으로 돌며 진행 상황을 보내고, 중단하면 그때까지의 결과를 돌려준다(직접 풀이와 같은 결과)", () => {
  const ctx = context();
  const inputs = { 1: small() };
  const direct = plain(ctx.timetableSolve(inputs, { seed: 7, iterations: 30000 }));
  const start = (messagesOut) => {
    const queue = [];
    const worker = vm.createContext({ self: { postMessage: (message) => messagesOut.push(plain(message)) }, setTimeout: (fn) => queue.push(fn) });
    vm.runInContext(ctx.timetableWorkerSource(), worker);
    return { worker, queue, send: (data) => vm.runInContext("self.onmessage", worker)({ data }) };
  };
  const messages = [];
  const full = start(messages);
  full.send({ id: "a", inputs, options: { seed: 7, iterations: 30000 }, chunk: 4000 });
  while (full.queue.length) full.queue.shift()();
  const last = messages[messages.length - 1];
  assert.deepEqual([last.ok, last.done, last.stopped], [true, true, false]);
  assert.deepEqual(last.value, direct, "Worker 결과 = 직접 풀이");
  const progress = messages.filter((message) => !message.done);
  assert.ok(progress.length >= 5 && progress.every((message) => message.id === "a" && message.progress.total === 30000));
  // 중단
  const stopped = [];
  const partial = start(stopped);
  partial.send({ id: "b", inputs, options: { seed: 7, iterations: 30000 }, chunk: 1000 });
  partial.queue.shift()(); partial.queue.shift()();
  partial.send({ type: "stop", id: "b" });
  while (partial.queue.length) partial.queue.shift()();
  const end = stopped[stopped.length - 1];
  assert.deepEqual([end.done, end.stopped, end.value.iterations < 30000], [true, true, true]);
  assert.equal(plain(ctx.timetableValidate(inputs, end.value)).ok, true);
  // 오류는 메시지로
  const failed = [];
  start(failed).send({ id: "c", inputs: {} });
  assert.deepEqual([failed[0].ok, failed[0].error], [false, "시간표 입력이 없습니다."]);
});
