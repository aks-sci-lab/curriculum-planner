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

test("두 학기 뼈대 + 학기마다 다른 6단계 블록 시간: 앞 학기 자리를 따르고 표시하며, 반 시간표는 빠짐없이 찬다", () => {
  const ctx = context();
  const first = small((input) => {
    input.blocks.find((block) => block.id === "3a").times = ["월2", "화2", "수2", "목2"];
    input.blocks.find((block) => block.id === "3b").times = ["월4", "화4", "수4", "목4"];
    input.blocks.find((block) => block.id === "3c").times = ["월5", "화5", "수5", "목5"];
  });
  const second = small((input) => {
    input.semester = "2";
    // 2학기: 블록 이름이 다르고(3x·3y·3z) 시간도 일부만 같다 → 시간이 많이 겹치는 것끼리 짝(3a–3y, 3b–3z, 3c–3x)
    const rename = { "3a": "3x", "3b": "3y", "3c": "3z" };
    for (const block of input.blocks) if (rename[block.id]) { block.id = rename[block.id]; block.label = `${block.id} 블록`; block.sections.forEach((section, index) => { section.id = `${block.id}-${index + 1}`; }); }
    input.blocks.find((block) => block.id === "3x").times = ["월6", "화6", "수6", "목6"];
    input.blocks.find((block) => block.id === "3y").times = ["월2", "화2", "수2", "금2"];
    input.blocks.find((block) => block.id === "3z").times = ["월4", "화4", "수4", "목4"];
  });
  const inputs = { 1: first, 2: second };
  const result = plain(ctx.timetableSolve(inputs, { seed: 3, iterations: 120000 }));
  const check = plain(ctx.timetableValidate(inputs, result));
  assert.deepEqual([check.ok, check.errors], [true, []]);
  const one = result.layers["1"].blocks;
  const two = result.layers["2"].blocks;
  const sorted = (item) => item.slots.slice().sort();
  // 1학기는 6단계 시간 그대로, 2학기는 1학기 자리(뼈대)
  assert.deepEqual([sorted(one["3a"]), one["3a"].timesOverridden], [["월2", "목2", "수2", "화2"].sort(), undefined]);
  assert.deepEqual([sorted(two["3y"]), sorted(two["3z"]), sorted(two["3x"])], [sorted(one["3a"]), sorted(one["3b"]), sorted(one["3c"])]);
  // 시간이 같은 3z는 표시 없음, 달라진 3y(금2 → 목2)·3x는 표시 + 알림
  assert.deepEqual([two["3z"].timesOverridden, two["3y"].timesOverridden, two["3x"].timesOverridden, result.metrics.blockTimesChanged], [undefined, true, true, 2]);
  assert.equal(result.notes.filter((note) => /두 학기 뼈대를 맞추려고 6단계 블록 시간 대신 1학기 자리/.test(note)).length, 2);
  // 반 시간표는 두 학기 모두 빠짐없이
  assert.deepEqual([result.metrics.unplacedHours, result.unplaced], [0, []]);
  assert.equal(check.hours["1"], check.hours["2"]);
});

test("칸 고정(input.pins.lessons): 고정한 반 수업 시간은 그 칸에 두고 탐색이 옮기지 않는다, 못 지키면 알림, 검증기도 확인", () => {
  const ctx = context();
  const pins = { "1국어@1-1": ["화3", "목5"], "2수학@2-2": ["수1"], "1음악@1-3": ["월1", "금6", "없는칸"] }; // 월1은 전교 창체 자리 → 못 지킴
  const inputs = { 1: small((input) => { input.pins = { lessons: pins }; }) };
  const result = plain(ctx.timetableSolve(inputs, { seed: 3, iterations: 80000, rounds: 2 }));
  const layer = result.layers["1"];
  assert.equal(plain(ctx.timetableValidate(inputs, result)).ok, true);
  assert.ok(["화3", "목5"].every((key) => layer.lessons["1국어@1-1"].slots.includes(key)), layer.lessons["1국어@1-1"].slots.join(","));
  assert.ok(layer.lessons["2수학@2-2"].slots.includes("수1"));
  assert.equal(layer.lessons["1국어@1-1"].slots.length, 4);
  // 못 지킨 고정: 창체 자리(월1)는 표시 + 알림, 지킬 수 있는 금6은 지킴
  assert.deepEqual([layer.lessons["1음악@1-3"].pinMissed, layer.lessons["1음악@1-3"].slots.includes("금6")], [["월1"], true]);
  assert.ok(result.notes.some((note) => /1-3반 음악: 고정한 칸 월1에 놓지 못했습니다/.test(note)), result.notes.join(" / "));
  // 씨앗을 바꿔도 고정은 그대로, 고정이 없는 수업은 달라질 수 있다
  const other = plain(ctx.timetableSolve(inputs, { seed: 9, iterations: 40000, rounds: 0 })).layers["1"];
  assert.ok(["화3", "목5"].every((key) => other.lessons["1국어@1-1"].slots.includes(key)));
  // 검증기: 고정한 칸에서 벗어나면 오류
  const moved = plain(result);
  const free = ["월", "화", "수", "목", "금"].flatMap((day) => [1, 2, 3, 4, 5, 6].map((period) => `${day}${period}`)).find((key) => !Object.entries(moved.layers["1"].lessons).some(([id, item]) => id.endsWith("@2-2") && item.slots.includes(key))
    && !Object.values(moved.layers["1"].blocks).some((item) => item.slots.includes(key)) && key !== "월1");
  moved.layers["1"].lessons["2수학@2-2"].slots = moved.layers["1"].lessons["2수학@2-2"].slots.map((key) => (key === "수1" ? free : key));
  assert.ok(plain(ctx.timetableValidate(inputs, moved)).errors.some((item) => item.type === "pin" && /2-2 수학Ⅱ: 고정한 칸 수1에 놓이지 않았습니다/.test(item.text)));
  // 두 학기 뼈대: 한 학기에만 고정해도 묶음째 그 칸(두 학기 같은 자리), 학기마다 다른 칸에 고정하면 묶지 않고 따로
  const both = { 1: small((input) => { input.pins = { lessons: { "1수학@1-1": ["수2"] } }; }), 2: small((input) => { input.semester = "2"; }) };
  const framed = plain(ctx.timetableSolve(both, { seed: 3, iterations: 60000, rounds: 0 }));
  assert.deepEqual([framed.layers["1"].lessons["1수학@1-1"].slots.includes("수2"), framed.layers["2"].lessons["1수학@1-1"].slots.includes("수2"), framed.layers["1"].lessons["1수학@1-1"].frame], [true, true, true]);
  both[2].pins = { lessons: { "1수학@1-1": ["목4"] } };
  const split = plain(ctx.timetableSolve(both, { seed: 3, iterations: 60000, rounds: 0 }));
  assert.deepEqual([split.layers["1"].lessons["1수학@1-1"].slots.includes("수2"), split.layers["2"].lessons["1수학@1-1"].slots.includes("목4"), split.layers["1"].lessons["1수학@1-1"].frame], [true, true, undefined]);
  assert.equal(plain(ctx.timetableValidate(both, split)).ok, true);
});

test("담당 교사 고정(input.pins.teachers): 후보(전공 일치)인 교사만 고정되고, 풀이기는 그 수업을 그 교사에게 맡긴다", () => {
  const ctx = context();
  const make = (pins) => ({ semester: "1", days: "월,화", periods: 4, grades: [{ grade: "1", classes: 2 }],
    teachers: [{ id: "k1", name: "김국어", departments: ["국어"] }, { id: "k2", name: "이국어", departments: ["국어"] }, { id: "m1", name: "박수학", departments: ["수학"] }],
    lessons: [{ id: "국어", grade: "1", subject: "국어", department: "국어", hours: 2 }, { id: "수학", grade: "1", subject: "수학", department: "수학", hours: 2 }],
    blocks: [], rules: {}, ...(pins ? { pins } : {}) });
  // 모형: 고정한 교사가 후보면 그 교사만 후보·정해진 교사로, 전공이 다른 교사·명단에 없는 교사는 무시
  const lessonsOf = (pins) => Object.fromEntries(plain(ctx.timetableModel(make(pins)).lessons).map((lesson) => [lesson.id, [lesson.candidates, lesson.fixedTeacher, lesson.teacherPinned]]));
  const pinned = lessonsOf({ teachers: { "국어@1-1": "k2", "국어@1-2": "m1", "수학@1-1": "없는 교사" } });
  assert.deepEqual([pinned["국어@1-1"], pinned["국어@1-2"], pinned["수학@1-1"]], [[["k2"], "k2", true], [["k1", "k2"], "", false], [["m1"], "", false]]);
  // 풀이기: 두 반 국어를 모두 이국어에게 고정하면 둘 다 이국어가 맡는다(고정이 없으면 시수를 고르게 나눠 한 반씩)
  const free = plain(ctx.timetableSolve({ 1: make() }, { seed: 1, iterations: 4000, rounds: 1 }));
  assert.deepEqual([free.layers["1"].lessons["국어@1-1"].teacherId, free.layers["1"].lessons["국어@1-2"].teacherId].sort(), ["k1", "k2"]);
  const inputs = { 1: make({ teachers: { "국어@1-1": "k2", "국어@1-2": "k2" } }) };
  const result = plain(ctx.timetableSolve(inputs, { seed: 1, iterations: 4000, rounds: 1 }));
  assert.deepEqual([result.layers["1"].lessons["국어@1-1"].teacherId, result.layers["1"].lessons["국어@1-2"].teacherId], ["k2", "k2"]);
  assert.deepEqual([plain(ctx.timetableValidate(inputs, result)).ok, result.metrics.hard], [true, 0]);
  // 검증기: 고정한 교사와 다른 교사가 배정된 결과는 오류
  const wrong = JSON.parse(JSON.stringify(result));
  wrong.layers["1"].lessons["국어@1-1"].teacherId = "k1";
  assert.ok(plain(ctx.timetableValidate(inputs, wrong)).errors.some((error) => error.type === "fixedTeacher" || /정해진 교사와 다른 교사/.test(error.text)));
});

test("창체 교시 범위·하루 최소 교시: 시간을 정하지 않은 창체는 n교시 이후에만(검증기도 확인), 일찍 끝나는 날은 '최대한' 위반으로", () => {
  const ctx = context();
  // 학년별 창체 2시간(시간 미정) + 전교 동시 없음, 4교시 이후에만
  const inputs = { 1: small((input) => { input.creative = { school: 0, grade: 2, fromPeriod: 4 }; }) };
  const result = plain(ctx.timetableSolve(inputs, { seed: 4, iterations: 60000, rounds: 2 }));
  assert.equal(plain(ctx.timetableValidate(inputs, result)).ok, true);
  const creative = result.layers["1"].creative;
  assert.equal(creative.length, 3);
  assert.ok(creative.every((item) => item.scope === "grade" && item.slots.length === 2 && item.slots.every((key) => Number(key.slice(1)) >= 4)), JSON.stringify(creative));
  // 검증기: 앞 교시에 놓인 창체는 오류(자리가 없어 앞에 놓았다는 표시 anyPeriod가 있으면 넘어감)
  const moved = plain(result);
  const firstKey = moved.layers["1"].creative[0].slots[0];
  const lessonsAt = Object.values(moved.layers["1"].lessons);
  const early = ["월", "화", "수", "목", "금"].flatMap((day) => [1, 2, 3].map((period) => `${day}${period}`));
  moved.layers["1"].creative[0].slots[0] = early[0];
  const errors = plain(ctx.timetableValidate(inputs, moved)).errors.map((item) => item.type);
  assert.ok(errors.includes("creativePeriod"), errors.join(","));
  moved.layers["1"].creative[0].anyPeriod = true;
  assert.equal(plain(ctx.timetableValidate(inputs, moved)).errors.some((item) => item.type === "creativePeriod"), false);
  assert.ok(firstKey && lessonsAt.length > 0);
  // 하루 최소 교시(기본 4교시, '최대한'): 수업이 있는데 일찍 끝나는 날은 위반 목록에(끄면 안 나옴)
  const shortDays = result.violations.filter((item) => item.rule === "shortDay");
  assert.ok(shortDays.every((item) => item.level === "soft" && /교시에 끝납니다\(하루 최소 4교시\)/.test(item.cause)));
  const off = { 1: small((input) => { input.rules = { shortDay: "off" }; }) };
  assert.equal(plain(ctx.timetableSolve(off, { seed: 4, iterations: 20000, rounds: 0 })).violations.some((item) => item.rule === "shortDay"), false);
  assert.deepEqual([vm.runInContext("TIMETABLE_DEFAULT_RULES.minPerDay", ctx), vm.runInContext("TIMETABLE_DEFAULT_RULES.shortDay", ctx)], [4, "soft"]);
});

test("두 학기 뼈대 '블록은 같은 시간대만'(order): 블록 칸 집합은 두 학기 같고 순서는 달라도 됨, 이어지는 수업은 같은 칸·같은 교사, 어긋나면 '반드시' 위반", () => {
  const ctx = context();
  const make = (semester) => small((input) => { input.semester = semester; input.rules = { semesterFrame: "order" }; });
  const inputs = { 1: make("1"), 2: make("2") };
  const result = plain(ctx.timetableSolve(inputs, { seed: 5, iterations: 120000, rounds: 2 }));
  const check = plain(ctx.timetableValidate(inputs, result));
  assert.deepEqual([check.ok, check.errors], [true, []]);
  assert.deepEqual([result.metrics.frame, result.metrics.frameMode, result.metrics.frameZone, result.metrics.unplacedHours], [true, "order", 0, 0]);
  // 블록 칸 집합(학년별)은 두 학기 같다 — 블록마다의 자리는 묶이지 않는다(frame 표시 없음)
  const zone = (semester, grade) => Object.entries(result.layers[semester].blocks).filter(([id]) => id.startsWith(grade)).flatMap(([, item]) => item.slots).sort().join(",");
  for (const grade of ["2", "3"]) assert.equal(zone("1", grade), zone("2", grade), `${grade}학년 블록 시간대`);
  assert.ok(Object.values(result.layers["1"].blocks).every((item) => item.frame === undefined));
  // 이어지는 반 수업·창체는 같은 칸·같은 교사
  for (const id of ["1국어@1-1", "2영어@2-1", "3체육@3-2"]) assert.deepEqual([result.layers["2"].lessons[id].slots.slice().sort(), result.layers["2"].lessons[id].teacherId, result.layers["2"].lessons[id].frame], [result.layers["1"].lessons[id].slots.slice().sort(), result.layers["1"].lessons[id].teacherId, true], id);
  assert.deepEqual(result.layers["2"].creative, result.layers["1"].creative);
  assert.equal(check.violations.some((item) => item.rule === "frame"), false);
  // 검증기: 한 학기의 블록 한 시간이 다른 시간대로 가면 '두 학기 뼈대' 위반으로 센다(풀이기 결과에는 없던 것)
  const moved = plain(result);
  const taken = new Set([...Object.values(moved.layers["2"].blocks).flatMap((item) => item.slots), ...Object.entries(moved.layers["2"].lessons).filter(([id]) => /@3-/.test(id)).flatMap(([, item]) => item.slots), "월1"]);
  const free = ["월", "화", "수", "목", "금"].flatMap((day) => [1, 2, 3, 4, 5, 6].map((period) => `${day}${period}`)).find((key) => !taken.has(key));
  const was = moved.layers["2"].blocks["3a"].slots[0];
  moved.layers["2"].blocks["3a"].slots[0] = free;
  const off = plain(ctx.timetableValidate(inputs, moved)).violations.filter((item) => item.rule === "frame");
  assert.ok(off.length >= 1 && off.every((item) => item.level === "hard" && /두 학기의 블록 시간대가 다릅니다/.test(item.cause)), JSON.stringify(off));
  assert.equal(off.reduce((sum, item) => sum + item.amount, 0), was[0] === free[0] ? 2 : 2);
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
  assert.ok(result.metrics.hard > 0, "기본(교사 먼저)은 교사를 최대한 세워 공강·하루 두 번이 남는다");
  // '공강 먼저'(rules.cover = soft): 걸리는 수업의 교사를 비워 위반을 없앤다 — 담당 교사 없음이 늘고, 이유는 released
  const soft = { 1: school({ pe3: 3, info3: 3, rules: { cover: "soft" } }) };
  const released = plain(ctx.timetableSolve(soft, { seed: 1, iterations: 200000 }));
  assert.equal(plain(ctx.timetableValidate(soft, released)).ok, true);
  assert.ok(released.metrics.hard < result.metrics.hard, `위반 ${result.metrics.hard} → ${released.metrics.hard}`);
  assert.ok(released.metrics.noTeacherHours > result.metrics.noTeacherHours, `담당 교사 없음 ${result.metrics.noTeacherHours} → ${released.metrics.noTeacherHours}`);
  const reasons = released.noTeacher.filter((item) => item.reason === "released");
  assert.ok(reasons.length > 0 && reasons.every((item) => item.grade === "3" && item.kind === "lesson" && item.hours > 0));
  for (const item of reasons) assert.equal(released.layers["1"].lessons[Object.keys(released.layers["1"].lessons).find((id) => id.endsWith(`@${item.classId}`) && released.layers["1"].lessons[id].teacherId === null && id.startsWith(item.subject === "스포츠 생활" ? "3스포츠" : "3인공"))].teacherId, null);
});

test("실제 학교 모양(3학년 11반 · 블록 20 · 반 수업 2과목(2 + 4시간) · 반 수업 교사 6명 · 창체 금6·7): 블록을 1교시부터 빈틈없이 놓아 3학년 공강이 한 자리 수", () => {
  const ctx = context();
  // 3학년 반 수업 교사 = 체육 3명(전 학년 체육까지 맡음) + 정보 3명 = 6명 < 11반 → 반 수업은 하루 끝 쪽에만 올 수 있다
  const inputs = { 1: school({ pe3: 0, info3: 3, sharedPe: true }) };
  const result = plain(ctx.timetableSolve(inputs, { seed: 1, iterations: 300000, rounds: 4 }));
  assert.equal(plain(ctx.timetableValidate(inputs, result)).ok, true);
  const gaps = (grade) => result.violations.filter((item) => item.rule === "gap" && item.id.startsWith(`${grade}-`)).reduce((sum, item) => sum + item.amount, 0);
  assert.ok(gaps("3") <= 9, `3학년 공강 ${gaps("3")}칸`);
  assert.deepEqual([gaps("1"), gaps("2"), result.metrics.unplacedHours], [0, 0, 0]);
  // 3학년 블록은 요일마다 1교시부터 이어지고(사이에 낀 칸 없음), 창체가 있는 금요일은 5교시까지 블록
  const blocks = Object.entries(result.layers["1"].blocks).filter(([id]) => id.startsWith("3")).flatMap(([, item]) => item.slots);
  const byDay = {};
  for (const key of blocks) (byDay[key[0]] = byDay[key[0]] || []).push(Number(key.slice(1)));
  for (const [day, periods] of Object.entries(byDay)) assert.deepEqual(periods.slice().sort((a, b) => a - b), periods.map((_, index) => index + 1), `${day}요일 블록 ${periods.join(",")}`);
  assert.equal(byDay["금"].length, 5);
  // '반드시' 조건끼리 부딪칠 때는 공강을 먼저 막는다(무게 공강 3000 > 하루 두 번 2000 > 교사 규칙 1000)
  assert.deepEqual(plain(vm.runInContext("TIMETABLE_HARD_WEIGHTS", ctx)), { gap: 3000, oncePerDay: 2000 });
  // 남는 '하루 두 번'은 같은 수업이 하루에 두 번인 경우 — 위반에 과목이 실려 '그 과목 2시간 연속 수업 허용' 선택지가 된다
  const twice = result.violations.filter((item) => item.rule === "oncePerDay");
  assert.ok(twice.length > 0 && twice.some((item) => (item.subjects || []).includes("인공지능 기초")), JSON.stringify(twice.slice(0, 2)));
  // 인공지능 기초(4시간)에 2시간 연속 수업을 허용하면 '반드시' 위반이 없어진다(이어진 2시간은 위반이 아님, 검증기도 같은 판정)
  const doubled = { 1: school({ pe3: 0, info3: 3, sharedPe: true }) };
  doubled[1].lessons.find((lesson) => lesson.id === "3인공").double = true;
  const relaxed = plain(ctx.timetableSolve(doubled, { seed: 1, iterations: 300000, rounds: 4 }));
  const relaxedCheck = plain(ctx.timetableValidate(doubled, relaxed));
  assert.deepEqual([relaxedCheck.ok, relaxedCheck.counts.oncePerDay], [true, relaxed.metrics.oncePerDay]);
  assert.ok(relaxed.metrics.hard <= 3 && relaxed.metrics.hard < result.metrics.hard / 3, `'반드시' 위반 ${result.metrics.hard} → ${relaxed.metrics.hard}`); // 짧게 돌린 값(기본 횟수로는 0)
  // 이어진 2시간은 위반으로 세지 않는다: 하루에 두 번 든 인공지능 기초 가운데 이어지지 않은 것의 수 ≤ 남은 '하루 두 번' 위반
  const pairs = Object.entries(relaxed.layers["1"].lessons).filter(([id]) => id.startsWith("3인공")).map(([, item]) => item.slots);
  let together = 0;
  let apart = 0;
  for (const slots of pairs) { const byDay = {}; for (const key of slots) (byDay[key[0]] = byDay[key[0]] || []).push(Number(key.slice(1))); for (const list of Object.values(byDay)) { if (list.length === 2 && Math.abs(list[0] - list[1]) === 1) together += 1; else if (list.length > 1) apart += 1; } }
  assert.ok(together > 0, "어떤 반은 인공지능 기초가 하루에 2시간(연속)");
  assert.ok(apart <= relaxed.metrics.oncePerDay, `떨어진 2시간 ${apart} ≤ 하루 두 번 위반 ${relaxed.metrics.oncePerDay}`);
  // 어떤 두 블록도 같은 시간에 둘 수 없는 극단(블록 과목 교사 1명씩)에서도 3학년 공강은 한 자리 수 근처(예전: 66칸)
  const hard = { 1: school({ pe3: 0, info3: 3, sharedPe: true, blockTeachers: 1 }) };
  const tough = plain(ctx.timetableSolve(hard, { seed: 1, iterations: 300000, rounds: 4 }));
  assert.equal(plain(ctx.timetableValidate(hard, tough)).ok, true);
  assert.ok(tough.metrics.gap <= 15, `극단 사례 공강 ${tough.metrics.gap}칸`);
});

test("두 학기 뼈대 + 학기마다 다른 블록 분반 교사(블록 교사가 1학년 반 수업도 맡음): 검증 통과·블록 사이 낀 칸 없음·묶음 유지", () => {
  const ctx = context();
  const make = (semester) => school({ pe3: 0, info3: 3, sharedPe: true, sharedSocial: true, unevenBlocks: true, semester });
  const inputs = { 1: make("1"), 2: make("2") };
  const result = plain(ctx.timetableSolve(inputs, { seed: 1, iterations: 300000, rounds: 2 }));
  const check = plain(ctx.timetableValidate(inputs, result));
  assert.deepEqual([check.ok, check.errors, result.metrics.unplacedHours, result.metrics.frameBroken], [true, [], 0, 0]);
  // 3학년 블록은 두 학기 같은 자리, 요일마다 1교시부터 이어진다(탐색이 블록을 흩지 않는다)
  for (const semester of ["1", "2"]) {
    const byDay = {};
    for (const [id, item] of Object.entries(result.layers[semester].blocks)) if (id.startsWith("3")) for (const key of item.slots) (byDay[key[0]] = byDay[key[0]] || []).push(Number(key.slice(1)));
    for (const [day, periods] of Object.entries(byDay)) assert.deepEqual(periods.slice().sort((a, b) => a - b), periods.map((_, index) => index + 1), `${semester}학기 ${day}요일 블록 ${periods.join(",")}`);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(result.layers["1"].blocks).map(([id, item]) => [id, item.slots.slice().sort().join(",")])), Object.fromEntries(Object.entries(result.layers["2"].blocks).map(([id, item]) => [id, item.slots.slice().sort().join(",")])));
  // 3학년 공강은 블록 사이 낀 칸이 없으니 한 자리 수, 남는 교사 위반(점심·연강)은 위반 목록에 교사·요일과 함께
  const gap3 = result.violations.filter((item) => item.rule === "gap" && item.id.startsWith("3-")).reduce((sum, item) => sum + item.amount, 0);
  assert.ok(gap3 <= 9, `3학년 공강 ${gap3}칸`);
  // 2학년 블록을 옮기다가 한 칸이 학년 전체(11반) 빈 채로 굳지 않는다 — 블록을 옮기면서 그 반들의 빈칸을 함께 메우고,
  // 블록 교사가 그 시각에 맡고 있던 다른 반 수업을 비켜 주는 묶음 이동(예전에는 이 설정에서 2학년 공강 22칸이 남았다)
  assert.ok(result.metrics.gap <= 6, `두 학기 공강 ${result.metrics.gap}칸`);
  assert.ok(result.violations.filter((item) => item.rule === "lunch").every((item) => item.kind === "teacher" && item.day && /점심 시간이 없습니다/.test(item.cause)));
});

test("흔들기·일찍 끝내기: 판 수는 설정값, 위반이 없고 나아지지 않으면 일찍 끝나고, 풀리지 않는 위반이 남으면 세 판 내리 그대로일 때 끝난다", () => {
  const ctx = context();
  const inputs = { 1: small() };
  // rounds 0 = 첫 담금질만
  const once = plain(ctx.timetableSolve(inputs, { seed: 2, iterations: 20000, rounds: 0 }));
  assert.deepEqual([once.iterations, once.total], [20000, 20000]);
  // 위반 0이면 최대 판 수(12)를 다 쓰지 않고 끝난다
  const easy = plain(ctx.timetableSolve(inputs, { seed: 2, iterations: 60000 }));
  assert.equal(easy.metrics.hard, 0);
  assert.ok(easy.iterations < 60000 + 12 * 30000, `일찍 끝남: ${easy.iterations}`);
  assert.equal(easy.iterations % 30000, 0);
  // 풀리지 않는 위반(교사 1명이 한 반에 하루 두 번 들어갈 수밖에 없음: 주 5일에 7시간): 끝나고, 결과는 검증 통과
  const stuck = { 1: small((input) => { input.lessons.find((lesson) => lesson.id === "1국어").hours = 7; input.lessons.find((lesson) => lesson.id === "1사회").hours = 0; input.teachers = input.teachers.filter((teacher) => !["국어2", "국어3"].includes(teacher.id)); input.lessons = input.lessons.filter((lesson) => lesson.hours > 0 && lesson.id !== "2국어"); }) };
  const hard = plain(ctx.timetableSolve(stuck, { seed: 2, iterations: 20000, rounds: 8 }));
  assert.ok(hard.metrics.hard > 0, "위반이 남는 자료");
  assert.ok(hard.iterations <= 20000 + 8 * 10000);
  assert.equal(plain(ctx.timetableValidate(stuck, hard)).ok, true);
  // 같은 씨앗 = 같은 결과(교사 맞바꾸기·사슬 이동 포함)
  assert.deepEqual(plain(ctx.timetableSolve(stuck, { seed: 2, iterations: 20000, rounds: 8 })), hard);
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
  assert.ok(progress.length >= 5 && progress.every((message) => message.id === "a" && message.progress.total >= 30000 && message.progress.best <= message.progress.cost + 1e-6));
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
