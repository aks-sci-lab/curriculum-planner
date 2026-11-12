// 7단계 시간표 순수 계산(timetable.js): 입력 모형과 사전 점검 P0~P10. 모든 자료는 합성(실제 학교와 같은 크기의 가상 학교)이다.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "timetable.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function context() {
  const ctx = vm.createContext({});
  vm.runInContext(source, ctx);
  return ctx;
}

// 가상 학교: 1학년 10반(반 수업 30 + 창체 2), 2학년 11반(반 수업 19 + 택3 블록 12 + 창체 2), 3학년 11반(택5 블록 20 + 반 수업 6 + 창체 2), 주 35칸.
// 3학년 반 수업(스포츠 생활 2 + 인공지능 기초 4)을 맡는 교사 수 = options.pe3 + options.info3 (기본 6 + 6 = 12 ≥ 11반).
const BLOCK_DEPARTMENTS = ["지리", "역사", "윤리", "일반사회", "물리", "화학", "생명", "지구", "일본어", "중국어", "경제"];
function school(options = {}) {
  const teachers = [];
  const staff = (department, count, extra = {}) => {
    for (let n = 1; n <= count; n += 1) teachers.push({ id: `t-${department}-${n}`, name: `${department} ${n}`, departments: [department], ...extra });
  };
  for (const [department, count] of Object.entries({ 국어: 5, 수학: 5, 영어: 5, 한국사: 2, 통합사회: 2, 음악: 1, 미술: 3, 한문: 2, 체육1: 3, ...(options.staff || {}) })) staff(department, count);
  for (const department of BLOCK_DEPARTMENTS) staff(department, options.blockTeachers ?? 2);
  teachers.push({ id: "t-물리-과탐", name: "물리 과탐", departments: ["물리"] }); // 물리는 통합과학·과학탐구실험까지 맡는다
  staff("체육3", options.pe3 ?? 6);
  staff("정보3", options.info3 ?? 6);
  const sections = (prefix) => BLOCK_DEPARTMENTS.map((department, index) => ({ id: `${prefix}-${index + 1}`, subject: `${department} 선택`, department, credits: 4 }));
  const input = {
    semester: "1", days: "월,화,수,목,금", periods: 7, lunchAfter: { 3: 3 },
    grades: [{ grade: "1", classes: 10 }, { grade: "2", classes: 11 }, { grade: "3", classes: 11 }],
    creative: { school: 2, schoolTimes: ["금6", "금7"], expected: { 1: 2, 2: 2, 3: 2 } },
    teachers,
    lessons: [
      { id: "1국어", grade: "1", subject: "공통국어", department: "국어", hours: 4 },
      { id: "1수학", grade: "1", subject: "공통수학", department: "수학", hours: 4 },
      { id: "1영어", grade: "1", subject: "공통영어", department: "영어", hours: 4 },
      { id: "1한국사", grade: "1", subject: "한국사", department: "한국사", hours: 3 },
      { id: "1통사", grade: "1", subject: "통합사회", department: "통합사회", hours: 4 },
      { id: "1통과", grade: "1", subject: "통합과학", hours: 4, parts: ["물리", "화학", "생명", "지구"].map((department) => ({ department, hours: 1 })) },
      { id: "1과탐", grade: "1", subject: "과학탐구실험", department: "물리", hours: 1 },
      { id: "1체육", grade: "1", subject: "체육", department: "체육1", hours: 2 },
      { id: "1음악", grade: "1", subject: "음악", department: "음악", hours: 2 },
      { id: "1미술", grade: "1", subject: "미술", department: "미술", hours: 2 },
      { id: "2문학", grade: "2", subject: "문학", department: "국어", hours: 4 },
      { id: "2대수", grade: "2", subject: "대수", department: "수학", hours: 4 },
      { id: "2영어", grade: "2", subject: "영어Ⅰ", department: "영어", hours: 4 },
      { id: "2체육", grade: "2", subject: "체육", department: "체육1", hours: 2 },
      { id: "2한문", grade: "2", subject: "한문", department: "한문", hours: 3 },
      { id: "2미술", grade: "2", subject: "미술 창작", department: "미술", hours: 2 },
      { id: "3스포츠", grade: "3", subject: "스포츠 생활", department: "체육3", hours: 2 },
      { id: "3인공", grade: "3", subject: "인공지능 기초", department: "정보3", hours: 4 }
    ],
    blocks: [
      ...["a", "b", "c"].map((id) => ({ id: `2${id}`, grade: "2", label: `${id}블록`, sections: sections(`2${id}`) })),
      ...["a", "b", "c", "d", "e"].map((id) => ({ id: `3${id}`, grade: "3", label: `${id}블록`, sections: sections(`3${id}`) }))
    ],
    rules: options.rules || {}
  };
  return input;
}
const issuesOf = (result, id, level) => result.issues.filter((issue) => issue.id === id && (!level || issue.level === level));

test("모형: 학년별 점심으로 실제 시각 축을 만들고, 반·조각 수업·교사 후보·불가 시간을 정리한다", () => {
  const ctx = context();
  const model = ctx.timetableModel({
    days: ["월", "화"], periods: 7, periodsByDay: { 화: 6 }, lunchAfter: { 3: 3 },
    grades: [{ grade: "1", classes: 2 }, { grade: "3", classes: ["1", "3-2"] }],
    teachers: [
      { id: "a", name: "가", departments: ["물리"], unavailable: ["월4", { day: "화", period: 1 }] },
      { id: "b", departments: ["화학"], courses: ["스포츠 생활"], days: ["화"] },
      { id: "c", departments: ["체육"], maxHours: 16 }
    ],
    lessons: [
      { id: "통과", grade: "1", subject: "통합과학", parts: [{ department: "물리", hours: 1 }, { department: "화학", hours: 1 }] },
      { id: "스포츠", grade: "3", subject: "스포츠 생활", department: "체육", hours: 2, teacherByClass: { "3-1": "c" } },
      { id: "없음", grade: "3", classes: ["2"], subject: "발명", department: "기술", hours: 1, teacherId: "zz" }
    ],
    blocks: [{ id: "x", grade: "3", label: "a블록", times: "월1, 화2", sections: [{ subject: "물리학", department: "물리", credits: 4 }, { subject: "화학", department: "화학", credits: 3, teacherId: "b" }] }]
  });
  assert.equal(model.positions, 8);
  assert.deepEqual(plain(model.grades.map((grade) => [grade.grade, grade.classes, grade.slotCount, grade.lunchAfter])), [["1", ["1-1", "1-2"], 13, 4], ["3", ["3-1", "3-2"], 13, 3]]);
  const abs = (grade, key) => model.gradeOf.get(grade).slotByKey.get(key).abs;
  // 하루 8칸 1,2,3,A,B,5,6,7: 1학년 4교시 = A(3), 3학년 4교시 = B(4), 5교시부터는 같다. 화요일은 8칸 뒤.
  assert.deepEqual([abs("1", "월3"), abs("1", "월4"), abs("3", "월4"), abs("1", "월5"), abs("3", "월5"), abs("1", "화1")], [2, 3, 4, 5, 5, 8]);
  assert.deepEqual(plain(model.lunchPositions), [3, 4]);
  // 조각 수업: 반마다 조각마다 한 줄, 과목은 같고 교과(교사 후보)가 다르다
  const pieces = model.lessons.filter((lesson) => lesson.subject === "통합과학");
  assert.deepEqual(plain(pieces.map((lesson) => [lesson.id, lesson.department, lesson.candidates])), [["통과@1-1#1", "물리", ["a"]], ["통과@1-1#2", "화학", ["b"]], ["통과@1-2#1", "물리", ["a"]], ["통과@1-2#2", "화학", ["b"]]]);
  // 교사 후보: 반별 확정 교사 → 그 교사만, 없으면 담당 교과·담당 과목
  const sports = model.lessons.filter((lesson) => lesson.subject === "스포츠 생활");
  assert.deepEqual(plain(sports.map((lesson) => [lesson.classId, lesson.candidates, lesson.fixedTeacher])), [["3-1", ["c"], "c"], ["3-2", ["b", "c"], ""]]);
  assert.equal(model.lessons.find((lesson) => lesson.subject === "발명").unknownTeacher, true);
  // 블록: 시수 = 가장 큰 학점, 분반 시수 = 그 과목 학점
  assert.deepEqual(plain([model.blocks[0].hours, model.blocks[0].classIds, model.blocks[0].times, model.blocks[0].sections.map((section) => [section.hours, section.fixedTeacher])]),
    [4, ["3-1", "3-2"], [{ day: "월", period: 1 }, { day: "화", period: 2 }], [[4, ""], [3, "b"]]]);
  // 불가 시간 '월4'는 학년마다 실제 시각이 달라 A·B 둘 다 막는다. 출근 요일이 화요일뿐이면 월요일 전부.
  assert.deepEqual([...model.teacherOf.get("a").blocked].sort((x, y) => x - y), [3, 4, 8]);
  assert.equal([...model.teacherOf.get("b").blocked].filter((value) => value < 8).length, 8);
  // 교사별 상한은 필수 상한, 없으면 필수 상한 없음(참고 상한 22는 알림만)
  assert.deepEqual([model.teacherOf.get("c").maxHours, model.teacherOf.get("a").maxHours, model.teacherOf.get("a").softHours, model.rules.maxHours], [16, Infinity, 22, 22]);
});

test("교사 하루 최대 수업 수: 연강 3 이하·점심 한 칸·하루 최대", () => {
  const ctx = context();
  const rules = { ...vm.runInContext("TIMETABLE_DEFAULT_RULES", ctx) };
  assert.equal(ctx.timetableDayCapacity(0b11111111, 8, rules, [3, 4]), 6); // 3 + 점심 + 3
  assert.equal(ctx.timetableDayCapacity(0b11101111, 8, rules, [3, 4]), 6); // 1·2학년만 가르치는 교사(B칸 없음)
  assert.equal(ctx.timetableDayCapacity(0b11111111, 8, { ...rules, run: 4, maxPerDay: 7 }, [3, 4]), 7);
  assert.equal(ctx.timetableDayCapacity(0b11111111, 8, { ...rules, maxPerDay: 5 }, [3, 4]), 5);
  assert.equal(ctx.timetableDayCapacity(0b00011000, 8, rules, [3, 4]), 1); // 점심 칸 둘 중 하나는 비움
  assert.equal(ctx.timetableDayCapacity(0b00011000, 8, { ...rules, lunch: "soft" }, [3, 4]), 2);
});

test("가상 학교 기본 자료는 사전 점검을 통과하고(필수 실패 0), 남는 칸은 참고로 알린다", () => {
  const ctx = context();
  const started = Date.now();
  const result = plain(ctx.timetablePrecheck(school()));
  assert.ok(Date.now() - started < 1000, "실제 크기 학교도 1초 안");
  assert.deepEqual([result.ok, result.counts.block, result.counts.fail], [true, 0, 0], JSON.stringify(result.issues.filter((issue) => issue.level !== "info"), null, 1));
  assert.deepEqual(result.grades.map((row) => [row.grade, row.classes, row.slots, row.lessonHours, row.blockHours, row.creative, row.total, row.spare]),
    [["1", 10, 35, 30, 0, 2, 32, 3], ["2", 11, 35, 19, 12, 2, 33, 2], ["3", 11, 35, 6, 20, 2, 28, 7]]);
  assert.deepEqual(issuesOf(result, "P1", "info").map((issue) => issue.cause), [
    "1학년: 주간 수업 32시간 < 주 35칸 — 3칸은 요일 끝 교시를 비웁니다(일찍 마침).",
    "2학년: 주간 수업 33시간 < 주 35칸 — 2칸은 요일 끝 교시를 비웁니다(일찍 마침).",
    "3학년: 주간 수업 28시간 < 주 35칸 — 7칸은 요일 끝 교시를 비웁니다(일찍 마침)."]);
  // 3학년 반 수업 칸 = 35 − 블록 20 − 창체 2 = 13
  assert.deepEqual([result.grades[2].free, result.grades[2].simultaneous], [13, 11]);
});

test("P0: 자료가 없으면 계산을 막는다(누락 목록은 화면 쪽이 넘긴 것 그대로)", () => {
  const ctx = context();
  const input = school();
  input.missing = [{ level: "block", cause: "2학년 1학기 분반 편성 결과가 없습니다.", where: [ctx.timetableWhere("sections")] }];
  input.teachers = [];
  input.lessons = input.lessons.filter((lesson) => lesson.grade !== "1");
  const result = plain(ctx.timetablePrecheck(input));
  assert.equal(result.ok, false);
  assert.deepEqual(issuesOf(result, "P0", "block").map((issue) => issue.cause), ["2학년 1학기 분반 편성 결과가 없습니다.", "교사 명단(또는 교과별 교사 수)이 없습니다.", "1학년 수업 목록이 없습니다(편제표·분반 편성 결과 확인)."]);
  assert.deepEqual(result.issues[0].where[0], { key: "sections", step: 8, label: "6단계 분반 편성(분반·블록·분반 교사)" });
});

test("P1: 주간 수업 수가 칸 수를 넘으면 실패, 반마다 다르면 경고", () => {
  const ctx = context();
  const input = school();
  input.periodsByDay = { 수: 6, 금: 6 }; // 주 33칸
  input.creative.schoolTimes = ["금5", "금6"];
  input.lessons.push({ id: "2정보", grade: "2", subject: "정보", department: "정보3", hours: 2 }, { id: "1진로", grade: "1", classes: ["1", "2"], subject: "진로", department: "국어", hours: 1 });
  const result = plain(ctx.timetablePrecheck(input));
  const fail = issuesOf(result, "P1", "fail");
  assert.equal(fail.length, 1);
  assert.equal(fail[0].cause, "2학년: 주간 수업 35시간(반 수업 21 + 블록 12 + 창체 2) > 주 33칸 — 2시간은 넣을 자리가 없습니다(11개 반).");
  assert.deepEqual(fail[0].relax, ["unplaced"]);
  assert.match(issuesOf(result, "P1", "warn")[0].cause, /^1학년: 반마다 주간 수업 수가 다릅니다\(32~33시간\)/);
});

test("P2: 학기별 교사 시수 — 맡을 수 있는 교사가 설 수 있는 시간보다 수업이 많으면 실패, 참고 상한(22)은 알림만, 교사가 없으면 '담당 교사 없음'", () => {
  const ctx = context();
  const input = school({ staff: { 한문: 1 } }); // 한문 2학년 11반 × 3 = 33시간, 교사 1명이 설 수 있는 시간은 주 28시간(하루 6시간·연강 3, 금 6·7 창체)
  input.lessons.push({ id: "3발명", grade: "3", classes: ["1"], subject: "발명", department: "기술", hours: 1 });
  const result = plain(ctx.timetablePrecheck(input));
  const p2 = issuesOf(result, "P2", "fail");
  assert.deepEqual(p2.map((issue) => issue.cause), [
    "기술: 3학년 발명 1시간을 맡을 수 있는 교사가 명단에 없습니다 → '담당 교사 없음' 1시간(교사 명단의 담당 교과·담당 과목, 5단계 담당 교과를 확인하세요).",
    "한문: 맡을 수 있는 교사가 설 수 있는 시간 1명 × 28 = 28시간 < 이번 학기 수업 33시간(5시간은 넣을 수 없음)."]);
  assert.deepEqual(p2[1].data, { departments: ["한문"], teachers: ["t-한문-1"], demand: 33, capacity: 28, shortage: 5 });
  assert.deepEqual([p2[0].relax, p2[1].relax], [["otherDepartment", "noTeacher"], ["teacherRules", "otherDepartment", "noTeacher"]]);
  assert.ok(!result.issues.some((issue) => /명 필요|증원|강사|순회/.test(issue.cause)), "교사를 늘리라는 문구는 쓰지 않는다");
  // 조건은 설정값: 하루 7시간·연강 4까지 풀면 설 수 있는 시간이 33 → 실패가 아니라 참고 상한 알림(22시간 초과)
  input.rules = { maxPerDay: 7, run: 4 };
  const relaxed = plain(ctx.timetablePrecheck(input));
  assert.equal(issuesOf(relaxed, "P2", "fail").filter((issue) => /한문/.test(issue.cause)).length, 0);
  assert.deepEqual(issuesOf(relaxed, "P2", "warn").map((issue) => issue.cause), ["한문: 교사 1명 × 22 = 22시간 < 이번 학기 수업 33시간 — 참고 상한을 11시간 넘습니다(1인당 약 33시간, 필수 조건은 아니어서 편성은 됩니다)."]);
  input.rules = { maxPerDay: 7, run: 4, maxHours: 33 };
  assert.equal(issuesOf(plain(ctx.timetablePrecheck(input)), "P2").filter((issue) => /한문/.test(issue.cause)).length, 0);
  // 교사 후보가 겹치는 묶음(지리·역사를 함께 맡는 교사)은 합쳐서 본다 — 참고 상한 알림
  const shared = ctx.timetablePrecheck({ grades: [{ grade: "1", classes: 10 }], teachers: [{ id: "a", departments: ["지리", "역사"] }, { id: "b", departments: ["지리"] }, { id: "x", departments: ["기타"] }],
    lessons: [{ grade: "1", subject: "지리", department: "지리", hours: 3 }, { grade: "1", subject: "역사", department: "역사", hours: 2 }, { grade: "1", subject: "기타", department: "기타", hours: 1 }] });
  assert.deepEqual(plain(issuesOf(shared, "P2").map((issue) => `${issue.level} ${issue.cause}`)), ["warn 지리, 역사: 교사 2명 × 22 = 44시간 < 이번 학기 수업 50시간 — 참고 상한을 6시간 넘습니다(1인당 약 25시간, 필수 조건은 아니어서 편성은 됩니다)."]);
  // 전공 일치(절대): 담당 교과·과목에 없는 수업을 맡은 교사
  const wrong = ctx.timetablePrecheck({ grades: [{ grade: "1", classes: 1 }], teachers: [{ id: "a", name: "가", departments: ["지리"] }],
    lessons: [{ grade: "1", subject: "물리학", department: "물리", hours: 3, teacherId: "a", teacherMismatch: true }] });
  assert.deepEqual(plain(issuesOf(wrong, "P2", "fail").map((issue) => issue.cause)), ["가 교사: 1학년 물리학 3시간은 이 교사의 담당 교과·담당 과목에 없는 수업입니다(교양 과목만 다른 교과 교사가 맡을 수 있습니다)."]);
});

test("P3: 교사가 설 수 있는 칸(불가 시간·출근 요일·점심·연강)·필수 상한(진로 10시간)보다 배정이 많으면 실패, 참고 상한(22)은 알림", () => {
  const ctx = context();
  const input = school();
  input.teachers.push({ id: "강사", name: "한문 겸임", departments: [], days: ["화", "목"] }, { id: "많음", name: "많음", departments: [] }, { id: "진로", name: "진로쌤", departments: ["진로"] });
  input.lessons.find((lesson) => lesson.id === "2한문").teacherByClass = { 1: "강사", 2: "강사", 3: "강사", 4: "강사", 5: "강사" }; // 15시간, 이틀 × 6 = 12
  input.lessons.find((lesson) => lesson.id === "2문학").teacherByClass = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [n, "많음"])); // 24시간 > 참고 22
  input.lessons.push({ id: "3진로", grade: "3", subject: "진로와 직업", department: "진로", hours: 1, teacherId: "진로" }); // 11반 × 1 = 11시간 > 진로 교사 필수 상한 10
  const result = plain(ctx.timetablePrecheck(input));
  assert.deepEqual(issuesOf(result, "P3").map((issue) => `${issue.level} ${issue.cause}`), [
    "fail 한문 겸임 교사: 배정 15시간(2학년 한문 15)인데 불가 시간·출근 요일·점심·연강을 빼면 주 12시간까지만 수업할 수 있습니다.",
    "fail 진로쌤 교사: 배정 11시간(3학년 진로와 직업 11)이 필수 상한 10시간을 넘습니다.",
    "warn 많음 교사: 배정 24시간(2학년 문학 24)이 참고 상한 22시간을 넘습니다(필수 조건은 아니어서 편성은 됩니다)."]);
  assert.deepEqual(result.teachers.find((row) => row.id === "강사"), { id: "강사", name: "한문 겸임", maxHours: null, softHours: 22, slotCapacity: 12, capacity: 12, fixedHours: 15 });
  assert.deepEqual([result.teachers.find((row) => row.id === "진로").maxHours, result.teachers.find((row) => row.id === "진로").capacity], [10, 10]);
  assert.equal(issuesOf(result, "P2").length, 0, "한 교사에 몰린 것은 P3에서만 알린다");
  // 진로 상한도 설정값
  input.rules = { departmentMax: { 진로: 12 } };
  assert.equal(issuesOf(plain(ctx.timetablePrecheck(input)), "P3", "fail").length, 1);
});

test("P4: 블록 안 동시 분반 ≤ 맡을 수 있는 교사, 같은 시각에 놓인 다른 학년 블록까지", () => {
  const ctx = context();
  const input = school();
  for (const id of ["x", "y", "z"]) input.blocks[3].sections.push({ id: `3a-${id}`, subject: "물리 선택", department: "물리", credits: 4 });
  const result = plain(ctx.timetablePrecheck(input));
  assert.deepEqual(issuesOf(result, "P4").map((issue) => issue.cause), ["3학년 a블록: 물리 선택 4분반인데 맡을 수 있는 교사 3명 — 같은 시간에 열 수 없습니다."]);
  // 같은 시각: 2학년 a블록과 3학년 a블록이 월5(같은 실제 시각)에 있으면 과목마다 교사 2명이 다 필요 → 교사 1명이면 모자람. 월4는 학년마다 시각이 달라 겹치지 않는다.
  const tight = school({ blockTeachers: 1 });
  tight.blocks[0].times = ["월4", "화1", "수1", "목1"];
  tight.blocks[3].times = ["월4", "화2", "수2", "목2"];
  assert.equal(issuesOf(ctx.timetablePrecheck(tight), "P4").length, 0);
  tight.blocks[3].times = ["월5", "화1", "수2", "목2"];
  tight.blocks[0].times = ["월5", "화3", "수1", "목1"];
  const clash = plain(issuesOf(ctx.timetablePrecheck(tight), "P4"));
  assert.deepEqual(clash.map((issue) => issue.cause), ["2학년 a블록(월5) · 3학년 a블록(월5)이 같은 시각인데 교사가 10명 모자랍니다(같은 교사가 두 블록에 필요)."]);
  assert.deepEqual(clash[0].relax, ["blockTimes"]);
});

test("P5: 블록 시간 — 격자 밖·전교 고정 시간·같은 학년 같은 시간·시수와 칸 수·같은 교사를 쓰는 블록 묶음", () => {
  const ctx = context();
  const input = school();
  input.blocks[0].times = ["월8", "화1", "수1"];
  input.blocks[1].times = ["화1", "금6", "수2", "수3"];
  const causes = plain(issuesOf(ctx.timetablePrecheck(input), "P5")).map((issue) => `${issue.level} ${issue.cause}`);
  assert.deepEqual(causes, [
    "fail 2학년 a블록: 월8은 시간 격자에 없는 칸입니다.",
    "fail 2학년 b블록: 금6은 전교 고정 시간(창체·회의)과 겹칩니다.",
    "fail 2학년 a블록과 b블록이 같은 시간(화1)입니다.",
    "warn 2학년 a블록: 블록 시간 3칸 ≠ 시수 4시간(시간표에서 다시 놓습니다).",
    "warn 2학년 b블록: 같은 날 두 번 들어 있습니다(같은 교사 하루 한 번 규칙)."]);
  // 블록 8개가 모두 같은 확정 교사를 쓰면 서로 다른 시간이어야 한다: 12 + 20 = 32칸 ≤ 33칸(35 − 창체 2)은 통과, 블록 시수가 늘면 실패
  const shared = school();
  shared.teachers.push({ id: "공동", name: "공동", departments: [], maxHours: 40 });
  for (const block of shared.blocks) block.sections[0].teacherId = "공동";
  assert.equal(issuesOf(ctx.timetablePrecheck(shared), "P5").length, 0);
  shared.blocks[0].hours = 6;
  assert.match(plain(issuesOf(ctx.timetablePrecheck(shared), "P5", "fail")).map((issue) => issue.cause).join("\n"), /블록 8개\(.*\)가 같은 교사를 써서 서로 다른 시간이어야 하는데, 모두 34칸이 필요합니다\(주 33칸\)\./);
  assert.match(plain(issuesOf(ctx.timetablePrecheck(shared), "P5", "fail"))[0].cause, /^2학년 a블록: 주 6시간인데 요일은 5일 — 같은 교사가 같은 분반에 하루 두 번 들어갈 수밖에 없습니다\./);
});

test("P6: 학년 반 수업 동시성(13칸 문제) — 같은 시간에 가르칠 교사가 반 수보다 적으면 반 수업은 하루 끝 쪽에만 올 수 있다", () => {
  const ctx = context();
  // 3학년 11반, 반 수업 칸 13개, 반 수업 교사 체육 3 + 정보 4 = 7명. 창체 금 6·7 고정 → 금요일은 1~5교시가 모두 블록이어야 하고,
  // 나머지 나흘의 끝 쪽 칸에 한 반이 하루 2시간(과목 2개, 하루 1번)까지 → 4일 × 2칸 × 7명 = 56 < 66시간.
  const input = school({ pe3: 3, info3: 4 });
  const result = plain(ctx.timetablePrecheck(input));
  const p6 = issuesOf(result, "P6");
  assert.equal(p6.length, 1);
  assert.equal(p6[0].cause, "3학년: 반 수업 칸 13개(주 35칸 − 블록 20 − 창체 2)에 11반이 6시간씩(모두 66시간) 들어가야 하는데, 같은 시간에 가르칠 수 있는 교사는 7명뿐이라 최대 56시간만 들어갑니다(한 반은 하루 2시간까지 — 같은 교사는 하루 한 번, 하루 끝 쪽 8칸 × 7명).");
  assert.deepEqual(p6[0].data, { grade: "3", classes: 11, free: 13, need: 66, simultaneous: 7, perDay: 2, tailTotal: 8, capacity: 56 });
  assert.deepEqual(p6[0].relax, ["creativeFree", "creativeGroup", "blockTimes", "oncePerDay", "gaps", "stagger"]);
  assert.equal(result.ok, false);
  // 창체를 학년별로 풀면(시간 미정) 닷새 × 2칸 × 7명 = 70 ≥ 66 → 이 점검은 통과
  const freed = school({ pe3: 3, info3: 4 });
  freed.creative = { grade: 2 };
  assert.equal(issuesOf(ctx.timetablePrecheck(freed), "P6").length, 0);
  // 교사 6명이면 창체를 풀어도 60 < 66
  const six = school({ pe3: 3, info3: 3 });
  six.creative = { grade: 2 };
  assert.deepEqual(plain(issuesOf(ctx.timetablePrecheck(six), "P6")[0].data), { grade: "3", classes: 11, free: 13, need: 66, simultaneous: 6, perDay: 2, tailTotal: 10, capacity: 60 });
  // 조건은 설정값: 하루 1번을 끄면 끝 쪽 13칸 × 6명 = 78 ≥ 66, 공강 금지를 끄면 min(13, …) × 6
  six.rules = { oncePerDay: "soft" };
  assert.equal(issuesOf(ctx.timetablePrecheck(six), "P6").length, 0);
  // 반군 나누기(엇갈림 블록): 1~6반과 7~11반이 다른 블록 개체를 들으면 반군마다 따로 본다 → 6반 ≤ 교사 6명
  const groups = school({ pe3: 3, info3: 3 });
  groups.creative = { grade: 2 };
  const front = ["1", "2", "3", "4", "5", "6"];
  const back = ["7", "8", "9", "10", "11"];
  const g3 = groups.blocks.filter((block) => block.grade === "3");
  groups.blocks = groups.blocks.filter((block) => block.grade !== "3").concat(
    g3.slice(0, 3), g3.slice(3).map((block) => ({ ...block, id: `${block.id}가`, label: `${block.label}(가)`, classes: front })), g3.slice(3).map((block) => ({ ...block, id: `${block.id}나`, label: `${block.label}(나)`, classes: back })));
  assert.equal(issuesOf(ctx.timetablePrecheck(groups), "P6").length, 0);
});

test("P6: 블록·창체 시간이 정해져 있어 반 수업 칸이 하루 가운데에 생기면 공강이 불가피하다고 알린다", () => {
  const ctx = context();
  const input = school({ pe3: 3, info3: 3 });
  // 3학년 블록을 모두 1~4교시에(월~목), 금요일은 블록 없음 + 창체 금 6·7 → 금 1~5교시가 반 수업 칸인데 창체 앞이라 비울 수 없다
  ["a", "b", "c", "d", "e"].forEach((id, index) => { input.blocks.find((block) => block.id === `3${id}`).times = ["월", "화", "수", "목"].map((day, d) => `${day}${((index + d) % 5) + 1}`); });
  const p6 = plain(issuesOf(ctx.timetablePrecheck(input), "P6"));
  assert.equal(p6.length, 1);
  assert.equal(p6[0].cause, "3학년: 반 수업 칸 13개(주 35칸 − 블록 20 − 창체 2)가 하루 가운데에 생길 수밖에 없는데, 그 칸에 11반을 동시에 가르칠 교사는 6명뿐입니다 → 공강이 생깁니다.");
  // 블록 시간만 다시 놓으면 되는 경우(창체는 학년별로 풀림, 교사 7명): 지금 블록 시간으로는 실패지만 '블록 시간 다시 놓기'로 안내
  const movable = school({ pe3: 3, info3: 4 });
  movable.creative = { grade: 2 };
  ["a", "b", "c", "d", "e"].forEach((id, index) => { movable.blocks.find((block) => block.id === `3${id}`).times = ["월", "화", "수", "목"].map((day, d) => `${day}${((index + d) % 5) + 3}`); });
  const moved = plain(issuesOf(ctx.timetablePrecheck(movable), "P6"));
  assert.equal(moved.length, 1);
  assert.match(moved[0].cause, /블록 시간을 다시 놓으면 이 점검은 통과합니다\.$/);
  assert.deepEqual([moved[0].relax, moved[0].where.map((where) => where.target)], [["blockTimes"], ["블록 시간", "블록 시간 다시 놓기"]]);
  // 반군별 창체를 허용하면(설정) 학년별 창체는 반마다 다른 시간에 둘 수 있어 반 수업 칸이 15개로 늘고, 교사 6명으로도 이 점검은 통과
  const byGroup = school({ pe3: 3, info3: 3 });
  byGroup.creative = { grade: 2, byGroup: true };
  assert.equal(issuesOf(ctx.timetablePrecheck(byGroup), "P6").length, 0);
  byGroup.creative.byGroup = false;
  assert.equal(issuesOf(ctx.timetablePrecheck(byGroup), "P6").length, 1);
});

test("P7: 교사 한 명에 몰린 반 수업 — 한 학년 반 수업 시수는 그 학년 반 수업 칸 수를 넘을 수 없다, 같은 교사가 한 반에 하루 두 번은 안 됨", () => {
  const ctx = context();
  const input = school();
  input.teachers.push({ id: "겸", name: "정보·기술", departments: [] });
  input.lessons.push({ id: "3발명", grade: "3", classes: ["1", "2", "3", "4", "5"], subject: "발명", department: "기술", hours: 4, teacherId: "겸" });
  input.lessons.find((lesson) => lesson.id === "3인공").classes = ["6", "7", "8", "9", "10", "11"];
  const result = plain(ctx.timetablePrecheck(input));
  const p7 = issuesOf(result, "P7", "fail");
  assert.deepEqual(p7.map((issue) => issue.cause), ["정보·기술 교사: 3학년 반 수업 발명 20시간인데 3학년 반 수업 칸은 13개입니다(한 칸에 한 반만 가르칠 수 있음) → 7시간은 넣을 수 없습니다."]);
  assert.deepEqual(p7[0].data, { grade: "3", teachers: ["겸"], demand: 20, free: 13, shortage: 7, capacity: 13 });
  assert.equal(issuesOf(result, "P3").length, 0, "설 수 있는 칸·참고 상한(22)은 넘지 않는다");
  // 교과 단위: 정보 교사 3명이 인공지능 기초 11반 × 4 = 44시간 → 3명 × 13칸 = 39시간
  const few = plain(issuesOf(ctx.timetablePrecheck(school({ info3: 3, pe3: 8 })), "P7"));
  assert.deepEqual(few.map((issue) => issue.cause), ["3학년 정보3: 교사 3명으로는 반 수업 칸 13개에 인공지능 기초 44시간을 넣을 수 없습니다(한 칸에 한 반, 3명 × 13칸 = 39시간) → 5시간이 남습니다."]);
  assert.deepEqual(few[0].relax, ["creativeGroup", "stagger", "sectionsMove", "noTeacher"]);
  // 반군별 창체를 허용하면 반 수업 칸이 15개 → 3명 × 15 = 45 ≥ 44로 풀린다(학년별로만 풀면 13칸 그대로)
  const freed = school({ info3: 3, pe3: 8 });
  freed.creative = { grade: 2 };
  assert.equal(issuesOf(ctx.timetablePrecheck(freed), "P7").length, 1);
  freed.creative = { grade: 2, byGroup: true };
  assert.equal(issuesOf(ctx.timetablePrecheck(freed), "P7").length, 0);
  // 같은 교사가 한 반에 주 6시간(요일 5일)이면 같은 날 두 번이 불가피 — 과목이 달라도 같은 교사면 합쳐서 본다
  const long = school();
  long.lessons.find((lesson) => lesson.id === "3인공").hours = 6;
  assert.deepEqual(plain(issuesOf(ctx.timetablePrecheck(long), "P7", "fail")).map((issue) => issue.cause), ["3학년 인공지능 기초: 한 반에 주 6시간이라 같은 교사가 같은 날 두 번 들어갈 수밖에 없습니다(요일 5일)."]);
  const pair = school();
  pair.teachers.push({ id: "둘", name: "둘", departments: [] });
  pair.lessons.push({ id: "1가", grade: "1", classes: ["1"], subject: "진로", department: "x", hours: 1, teacherId: "둘" }, { id: "1나", grade: "1", classes: ["1"], subject: "논술", department: "x", hours: 5, teacherId: "둘" });
  pair.lessons = pair.lessons.filter((lesson) => !["1음악", "1미술", "1체육"].includes(lesson.id));
  assert.deepEqual(plain(issuesOf(ctx.timetablePrecheck(pair), "P7", "fail")).map((issue) => issue.cause), ["1학년 둘 교사 진로·논술: 한 반에 주 6시간이라 같은 교사가 같은 날 두 번 들어갈 수밖에 없습니다(요일 5일)."]);
  // 규칙을 '최대한'으로 낮추면 알리지 않는다
  pair.rules = { oncePerDay: "soft" };
  assert.equal(issuesOf(ctx.timetablePrecheck(pair), "P7").length, 0);
});

test("P8·P9·P10: 장소 수용, 창체 시수와 칸, 알림(블록 안 학점 차이·자리 이름 교사·확대학급·학기 미정)", () => {
  const ctx = context();
  const input = school();
  for (const lesson of input.lessons) if (/체육|스포츠/.test(lesson.subject)) lesson.venue = "체육";
  input.lessons.find((lesson) => lesson.id === "1음악").venue = "음악실";
  input.blocks[0].sections[4].venue = "과학실"; input.blocks[0].sections[5].venue = "과학실"; input.blocks[0].sections[6].venue = "과학실";
  input.blocks[0].sections[8].credits = 3;
  input.venues = { 체육: 1, 과학실: 2 };
  input.creative = { school: 1, schoolTimes: ["금4", "금7"], grade: 1, gradeTimes: { 1: ["목6", "목7"] }, expected: { 1: 3, 2: 2, 3: 2 } };
  input.teachers[0].placeholder = true;
  input.notes = { expandedClasses: true, undecided: ["2학년 심화 수학"], staleSections: ["3학년 1학기 택5"] };
  const result = plain(ctx.timetablePrecheck(input));
  assert.deepEqual(issuesOf(result, "P8").map((issue) => `${issue.level} ${issue.cause}`), [
    "fail 2학년 a블록: 과학실을(를) 쓰는 분반이 3개인데 과학실은(는) 2곳입니다.",
    "fail 체육: 수업 64시간 > 1곳 × 주 35칸 = 35시간.",
    "warn 음악실: 동시에 쓸 수 있는 곳 수가 없어 겹침을 점검하지 않습니다."]);
  assert.deepEqual(issuesOf(result, "P9").map((issue) => issue.cause), [
    "1학년 창체: 5단계 시수 3시간 ≠ 시간표 설정 2시간(전교 동시 1 + 학년별 1).",
    "1학년 창체: 학년별 1시간인데 시간은 2칸 적혀 있습니다.",
    "전교 동시 창체 1시간인데 시간은 2칸 적혀 있습니다.",
    "전교 동시 창체 금4: 점심이 다른 학년은 실제 시각이 달라 같은 시간이 아닙니다."]);
  assert.deepEqual(issuesOf(result, "P10").map((issue) => issue.cause), [
    "2학년 a블록: 학점이 다른 과목이 섞여 있어(일본어 선택 3 < 블록 4시간) 그 과목 학생은 개인 공강이 생깁니다.",
    "실제 이름이 아닌 교사 1명(5단계 교사 수로 만든 자리) — 불가 시간·출근 요일을 모릅니다.",
    "5단계 확대학급(수준별 이동수업)이 켜져 있습니다 — 시간표에는 아직 반영하지 않습니다(5단계 시수와 어긋날 수 있음).",
    "2학년 심화 수학: 개설 학기가 정해지지 않아 시간표에 넣지 않았습니다.",
    "3학년 1학기 택5: 분반 편성 입력이 바뀌었습니다(6단계에서 다시 계산)."]);
  assert.ok(result.issues.every((issue) => issue.where.every((where) => where.step && where.label)), "모든 항목에 고칠 곳");
});

test("최대 유량 묶음: 모자란 묶음을 같은 교사로 이어진 것끼리 뭉쳐 돌려준다", () => {
  const ctx = context();
  const cover = plain(ctx.timetableCoverage([
    { name: "가", hours: 30, candidates: ["a", "b"] }, { name: "나", hours: 20, candidates: ["b"] }, { name: "다", hours: 10, candidates: ["c"] }, { name: "라", hours: 25, candidates: ["d"] }
  ], () => 22));
  assert.deepEqual([cover.total, cover.flow], [85, 76]);
  assert.deepEqual(cover.clusters.map((cluster) => [cluster.groups.map((group) => group.name), cluster.teachers.sort(), cluster.demand, cluster.capacity, cluster.shortage]),
    [[["가", "나"], ["a", "b"], 50, 44, 6], [["라"], ["d"], 25, 22, 3]]);
  assert.deepEqual(plain(ctx.timetableMatch([["x"], ["x", "y"], ["y"]])).size, 2);
});

test("6단계 시간표 미리 점검은 timetable.js 규칙 하나를 쓴다", () => {
  const ctx = context();
  const view = fs.readFileSync(path.join(root, "class-sections-view.js"), "utf8");
  assert.match(view, /function classSectionsTimetablePrecheck\(spec\) \{\n  return timetablePrecheckDepartments\(spec\);\n\}/);
  const check = plain(ctx.timetablePrecheckDepartments({ slots: 35, fixed: 2, blockHours: 20, label: "3학년 1학기", lessons: [{ department: "정보", label: "인공지능 기초 7반 × 4시간", hours: 28 }], teachers: { 정보: 2 } }));
  assert.deepEqual([check.free, check.issues.length, check.issues[0].capacity, check.issues[0].shortage, check.teachersKnown], [13, 1, 26, 2, true]);
  // 같은 상황을 7단계 사전 점검(P7)으로 보면 같은 결론(2명 × 13칸 = 26시간 < 28시간)
  const input = { grades: [{ grade: "3", classes: 7 }], creative: { school: 2 }, teachers: [{ id: "a", departments: ["정보"] }, { id: "b", departments: ["정보"] }, { id: "z", departments: ["기타"] }],
    lessons: [{ grade: "3", subject: "인공지능 기초", department: "정보", hours: 4 }], blocks: ["a", "b", "c", "d", "e"].map((id) => ({ id, grade: "3", hours: 4, sections: [{ subject: "기타", department: "기타", credits: 4 }] })) };
  assert.deepEqual([plain(issuesOf(ctx.timetablePrecheck(input), "P7"))[0].data.capacity, plain(issuesOf(ctx.timetablePrecheck(input), "P7"))[0].data.shortage], [26, 2]);
});
