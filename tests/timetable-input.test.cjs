// 7단계 시간표 자료 모으기(timetable-view.js timetableInput): 5단계 시수 항목·6단계 분반 결과 → 시간표 입력 + 가정 목록.
// 5·6단계 함수는 흉내(stub)로 넣는다 — 실제 연결은 하네스 백업으로 e2e/timetable-input-check.cjs가 확인한다.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function item(grade, semester, subject, credit, classes, extra = {}) {
  return { grade, semester, subject, credit, classes, autoClasses: classes, kind: "지정", designated: true, linked: true, department: extra.department || subject, hours: credit * classes, key: `${grade}|${semester}|${subject}`, basis: "", ...extra };
}

function world(overrides = {}) {
  const stats = {
    classCounts: { 1: 2, 2: 3, 3: 3 }, creativeHours: 2,
    settings: { teachers: { 국어: 2, "과학-물리": 1, "과학-화학": 1, 체육: 1 } },
    issues: [],
    items: [
      item("1", "1", "공통국어", 4, 2, { department: "국어" }),
      item("1", "1", "통합과학", 2, 2, { department: "과학-공통" }),
      item("2", "1", "문학", 4, 3, { department: "국어" }),
      item("2", "1", "미술", 2, 1, { department: "미술" }), item("2", "1", "연극", 2, 2, { department: "미술" }), // 교차집중: 3반을 1 + 2로
      item("2", "1", "물리학", 3, 2, { kind: "선택", designated: false, department: "과학-물리" }),
      item("2", "1", "화학", 3, 1, { kind: "선택", designated: false, department: "과학-화학" }),
      item("3", "1", "체육", 2, 3, { department: "체육" }),
      item("3", "1", "일본어", 2, 2, { kind: "선택", designated: false, department: "제2외국어" }),
      item("3", "1", "중국어", 2, 1, { kind: "선택", designated: false, department: "제2외국어" }),
      item("2", "2", "독서", 4, 3, { department: "국어" })
    ],
    ...(overrides.stats || {})
  };
  const settings = {
    gridDays: "월,화,수,목,금", gridPeriods: 7, rooms: { 과학실: 1 },
    fixedSlots: [{ label: "창체·진로", times: "금6,금7", allTeachers: true }, { label: "교직원 회의", times: "월7", allTeachers: true }],
    teachers: [
      { id: "t-국어-1", name: "국어 1", department: "국어", unavailable: [] }, { id: "k2", name: "김국어", department: "국어", unavailable: ["월1"], maxHours: 18 },
      { id: "p1", name: "박물리", department: "과학-물리" }, { id: "c1", name: "최화학", department: "과학-화학" }, { id: "pe", name: "체육쌤", department: "체육" }, { id: "art", name: "미술쌤", department: "미술" },
      { id: "jp", name: "일본어쌤", department: "제2외국어", courses: "일본어" }
    ],
    ...(overrides.settings || {})
  };
  const groups = overrides.groups || [
    { key: "1:1:2-1 택2", grade: "1", targetGrade: "2", semester: "1", category: "2-1 택2", label: "현1 → 2학년 1학기 · 2-1 택2", classes: 3,
      courses: [{ key: "물리학", name: "물리학", credits: 3, department: "과학-물리", classCount: 2 }, { key: "화학", name: "화학", credits: 3, department: "과학-화학", classCount: 1 }] },
    { key: "2:1:3-1 택1", grade: "2", targetGrade: "3", semester: "1", category: "3-1 택1", label: "현2 → 3학년 1학기 · 3-1 택1", classes: 3, unitOnly: true,
      courses: [{ key: "일본어", name: "일본어", credits: 2, department: "제2외국어", classCount: 2 }, { key: "중국어", name: "중국어", credits: 2, department: "제2외국어", classCount: 1 }] },
    { key: "1:2:2-2 택2", grade: "1", targetGrade: "2", semester: "2", category: "2-2 택2", label: "현1 → 2학년 2학기 · 2-2 택2", classes: 3, courses: [] }
  ];
  const entries = overrides.entries || {
    "1:1:2-1 택2": { classCounts: {}, classUnit: {}, blockTimes: { a: "월1,화2,수3", b: "" },
      sectionResult: { signature: "sig", teacherOf: { "화학#1": "c1" },
        blocks: [{ id: "a", letter: "a", times: ["목:1"], sectionIds: ["물리학#1", "화학#1"] }, { id: "b", letter: "b", times: [], sectionIds: ["물리학#2"] }],
        sections: [{ id: "물리학#1", courseKey: "물리학", blockId: "a", teacherId: "p1" }, { id: "물리학#2", courseKey: "물리학", blockId: "b", teacherId: "" }, { id: "화학#1", courseKey: "화학", blockId: "a" }] } },
    "2:1:3-1 택1": { classCounts: {}, classUnit: {} }
  };
  const ctx = vm.createContext({
    state: { currentRound: "1", timetable: overrides.timetable },
    hoursTargetYear: () => "2027",
    hoursStatsCached: () => { if (overrides.statsError) throw new Error(overrides.statsError); return stats; },
    hoursCommonClassAssignment: (grade) => Object.defineProperty(grade === "1" ? { 통합과학: { 1: { "과학-물리": 1, "과학-화학": 1 }, 2: { "과학-물리": 1, "과학-화학": 1 } } } : {}, "matchesSaved", { value: overrides.matchesSaved !== false }),
    hoursDepartmentName: (id) => id,
    hoursDesignatedShare: (total) => total,
    hoursDefaultDepartment: (subject, area) => area,
    classSectionsSettings: () => settings,
    classSectionsTeacherList: (cs) => cs.teachers.filter((teacher) => teacher.name).map((teacher) => ({ id: teacher.id, name: teacher.name, departments: teacher.department ? [teacher.department] : [],
      courses: String(teacher.courses || "").split(",").filter(Boolean), unavailable: (teacher.unavailable || []).map((slot) => ({ day: slot[0], period: Number(slot.slice(1)), reason: "" })) })),
    classSectionsTeacherPlaceholder: (teacher) => /^t-/.test(String(teacher?.id || "")),
    classSectionsSource: () => ({ groups }),
    classSectionsEntry: (round, key) => entries[key] || null,
    classSectionsCourseConf: (cs, kind, grade) => (kind === "courseModes" && grade === "2" ? { 일본어: "class", 중국어: "class" } : kind === "courseRooms" && grade === "1" ? { 물리학: "과학실" } : {}),
    classSectionsCourseModes: (cs, group) => (group.merged ? {} : group.grade === "2" ? { 일본어: "class", 중국어: "class" } : {}),
    classSectionsClassUnitOnly: (group) => Boolean(group.unitOnly),
    classSectionsClassUnitPlan: () => ({ assign: { 1: "일본어", 2: "일본어", 3: "중국어" }, mapped: Boolean(overrides.mapped) }),
    classSectionsSignature: () => overrides.signature || "sig",
    classSectionsBuildInput: () => ({}),
    curriculumCohortLayout: (year) => (overrides.fallbackPlan && year === "2026" ? { planData: null } : null),
    curriculumPlanEntries: () => ({ entries: [{ grade: "1", semester: "1", subject: "공통수학", area: "수학", credit: 4, kind: "지정", rowIndex: 1 }, { grade: "1", semester: "2", subject: "공통수학2", area: "수학", credit: 4, kind: "지정", rowIndex: 2 },
      { grade: "2", semester: "1", subject: "대수", area: "수학", credit: 4, kind: "지정", rowIndex: 3 }] })
  });
  vm.runInContext(read("timetable.js"), ctx);
  vm.runInContext(read("timetable-view.js"), ctx);
  return ctx;
}

test("5·6단계 자료를 시간표 입력으로 모은다: 학교 지정 과목 = 반 수업, 선택과목 = 6단계 블록·학급 단위, 교사·격자·창체", () => {
  const ctx = world();
  const { input, assumptions, year, round, semester } = plain(ctx.timetableInput("1", "1"));
  assert.deepEqual([year, round, semester], ["2027", "1", "1"]);
  assert.deepEqual([input.days, input.periods, input.lunchAfter, input.grades], ["월,화,수,목,금", 7, { 1: 4, 2: 4, 3: 3 }, [{ grade: "1", classes: 2 }, { grade: "2", classes: 3 }, { grade: "3", classes: 3 }]]);
  // 6단계 고정 시간 가운데 '창체'는 창체(전교 동시)로, 나머지만 고정 시간으로
  assert.deepEqual(input.creative, { school: 2, schoolTimes: ["금6", "금7"], grade: 0, gradeTimes: {}, byGroup: false, expected: { 1: 2, 2: 2, 3: 2 }, fromPeriod: 5 });
  assert.deepEqual(input.fixedSlots, [{ label: "교직원 회의", times: "월7", allTeachers: true }]);
  // 교사: 6단계 명단(상한·불가 시간·자리 이름 표시)
  assert.deepEqual(input.teachers.slice(0, 2), [
    { id: "t-국어-1", name: "국어 1", departments: ["국어"], courses: [], unavailable: [], homeroom: "", placeholder: true },
    { id: "k2", name: "김국어", departments: ["국어"], courses: [], unavailable: [{ day: "월", period: 1 }], maxHours: 18, homeroom: "", placeholder: false }]);
  // 반 수업: 지정 과목(전체 반), 공통 과목은 반마다 조각, 교차집중은 앞 반부터 차례로, 학급 단위 과목은 6단계 반 배정
  const lessons = input.lessons.map((lesson) => [lesson.grade, lesson.subject, lesson.classes || "전체", lesson.hours, lesson.parts ? lesson.parts.map((part) => `${part.department}${part.hours}`).join("+") : lesson.department]);
  assert.deepEqual(lessons, [
    ["1", "공통국어", "전체", 4, "국어"],
    ["1", "통합과학", ["1"], 2, "과학-물리1+과학-화학1"], ["1", "통합과학", ["2"], 2, "과학-물리1+과학-화학1"],
    ["2", "문학", "전체", 4, "국어"], ["2", "미술", ["1"], 2, "미술"], ["2", "연극", ["2", "3"], 2, "미술"],
    ["3", "체육", "전체", 2, "체육"],
    ["3", "일본어", ["1"], 2, "제2외국어"], ["3", "일본어", ["2"], 2, "제2외국어"], ["3", "중국어", ["3"], 2, "제2외국어"]]);
  // 블록: 6단계 결과의 분반·교사, 시간은 지금 6단계 입력 칸(없으면 결과), 특별실
  assert.deepEqual(input.blocks, [
    { id: "1:1:2-1 택2|a", grade: "2", label: "2-1 택2 a블록", times: "", sections: [
      { id: "1:1:2-1 택2|물리학#1", subject: "물리학", department: "과학-물리", credits: 3, teacherId: "p1", venue: "과학실" },
      { id: "1:1:2-1 택2|화학#1", subject: "화학", department: "과학-화학", credits: 3, teacherId: "c1", venue: "" }] },
    { id: "1:1:2-1 택2|b", grade: "2", label: "2-1 택2 b블록", times: "", sections: [{ id: "1:1:2-1 택2|물리학#2", subject: "물리학", department: "과학-물리", credits: 3, teacherIds: ["p1"], venue: "과학실" }] }]);
  assert.deepEqual(input.venues, { 과학실: 1 });
  assert.deepEqual(input.missing, []);
  // 5단계 교사 수와 6단계 명단이 다르면 알림만(시간표는 명단으로 계산)
  assert.deepEqual(input.notes, { undecided: [], staleSections: [], expandedClasses: false, teacherCounts: ["5단계 교사 수와 6단계 교사 명단이 다른 교과: 미술 0 → 1명, 제2외국어 0 → 1명 — 시간표는 6단계 명단으로 계산합니다."] });
  assert.deepEqual(assumptions.map((entry) => entry.key), ["periods", "lunch", "creative", "homeroom", "partial:2", "classUnit:2:1:3-1 택1"]);
  // 교사 후보(전공 일치): 담당 교과가 같거나 담당 과목에 그 과목이 있는 교사만 — 일본어는 제2외국어 교사, 담당 과목 '일본어'도 같은 교사
  assert.deepEqual(input.lessons.find((lesson) => lesson.subject === "일본어").teacherIds, ["jp"]);
  assert.deepEqual(input.lessons.find((lesson) => lesson.subject === "문학").teacherIds, ["t-국어-1", "k2"]);
  assert.ok(assumptions.every((entry) => entry.text && entry.where.step && entry.where.label));
  // 5단계 시수 합 = 7단계(반 수업 + 블록 분반) 시수 합
  const model = ctx.timetableModel(input);
  const hours7 = model.lessons.reduce((sum, lesson) => sum + lesson.hours, 0) + model.blocks.reduce((sum, block) => sum + block.sections.reduce((x, section) => x + section.hours, 0), 0);
  assert.equal(hours7, ctx.hoursStatsCached().items.filter((entry) => entry.semester === "1").reduce((sum, entry) => sum + entry.hours, 0));
  // 사전 점검까지: 가정 목록이 함께 온다
  const check = plain(ctx.timetablePrecheckFor("1", "1"));
  assert.equal(check.assumptions.length, 6);
  assert.equal(check.counts.block, 0);
  assert.deepEqual(check.grades.map((row) => [row.grade, row.lessonHours, row.blockHours, row.creative]), [["1", 6, 0, 2], ["2", 6, 6, 2], ["3", 4, 0, 2]]);
});

test("자료가 없을 때: 막는 것(분반 결과·학급 수·5단계 오류)과 가정으로 채우는 것(교사 자리·신입생 편제표·창체 나눔)", () => {
  const noResult = world({ entries: { "1:1:2-1 택2": { classCounts: {}, classUnit: {}, blockTimes: {} } }, stats: { classCounts: { 1: 2, 2: 3, 3: 0 } } });
  const missing = plain(noResult.timetableInput("1", "1")).input.missing;
  assert.deepEqual(missing.map((entry) => [entry.level, entry.cause, entry.where[0].step]), [
    ["block", "3학년 내년 학급 수가 없습니다.", 4],
    ["block", "현1 → 2학년 1학기 · 2-1 택2: 분반 편성 결과가 없습니다.", 8],
    ["warn", "2학년 1학기 선택과목: 5단계 시수 9시간 ≠ 6단계 분반 0시간(분반 수·학점·학급 단위 과목을 확인하세요).", 8]]);
  assert.equal(plain(noResult.timetablePrecheckFor("1", "1")).ok, false);
  // 5단계 계산 오류·확인 항목(필수)은 그대로 막는 사유로
  const broken = plain(world({ statsError: "학년도를 먼저 올바르게 입력하세요." }).timetableInput("1", "1")).input.missing;
  assert.equal(broken[0].cause, "학년도를 먼저 올바르게 입력하세요.");
  const errors = world({ stats: { issues: [{ level: "error", text: "2학년 선택과목: 1차에 현 1학년 수강신청 결과가 없어 개설반을 0으로 계산했습니다.", action: "results" }, { level: "warning", text: "참고" }] } });
  assert.deepEqual(plain(errors.timetableInput("1", "1")).input.missing.map((entry) => [entry.level, entry.where[0].key]), [["block", "aggregate"]]);
  // 교사 명단이 없으면 5단계 교사 수로 자리 교사(가정), 창체 고정 시간이 없으면 전교 동시 1 + 학년별 나머지(가정)
  const bare = world({ settings: { teachers: [], fixedSlots: [] } });
  const prepared = plain(bare.timetableInput("1", "1"));
  assert.deepEqual(prepared.input.teachers.map((teacher) => teacher.id), ["t-국어-1", "t-국어-2", "t-과학-물리-1", "t-과학-화학-1", "t-체육-1"]);
  assert.ok(prepared.input.teachers.every((teacher) => teacher.placeholder));
  assert.deepEqual(prepared.input.creative, { school: 1, schoolTimes: [], grade: 1, gradeTimes: {}, byGroup: false, expected: { 1: 2, 2: 2, 3: 2 }, fromPeriod: 5 });
  assert.deepEqual(prepared.assumptions.filter((entry) => ["teachers", "creative"].includes(entry.key)).map((entry) => entry.text), [
    "창체 2시간: 전교 동시 1시간(동아리) + 학년별 1시간으로 나누고 시간은 정하지 않음",
    "교사 명단 없음 → 5단계 교과별 교사 수(5명)로 자리 교사를 만들어 계산(불가 시간·출근 요일 모름)"]);
  // 신입생 편제표가 없으면(1학년 항목 없음 + 5단계 오류) 올해 1학년 편제표의 1학년 과목으로(가정), 그 오류는 막는 사유에서 뺀다
  const fresh = world({ fallbackPlan: true, stats: { issues: [{ level: "error", text: "1학년: 2027학년도 입학생 편제표가 없습니다. 1단계에서 업로드하세요.", action: "cohort:2027" }],
    items: [item("2", "1", "문학", 4, 3, { department: "국어" })] }, groups: [] });
  const fallback = plain(fresh.timetableInput("1", "1"));
  assert.deepEqual(fallback.input.lessons.map((lesson) => [lesson.grade, lesson.subject, lesson.department, lesson.hours]), [["2", "문학", "국어", 4], ["1", "공통수학", "수학", 4]]);
  assert.deepEqual(fallback.input.missing, []);
  assert.match(fallback.assumptions.find((entry) => entry.key === "plan1").text, /^1학년: 2027학년도 입학생 편제표가 없어 2026학년도 입학생 편제표의 1학년 과목으로 계산/);
});

test("시간표 조건(state.timetable.settings)이 있으면 그 값을 쓰고 가정에서 빠진다, 알림(입력 변경됨·확대학급·학기 미정·공통 배분)", () => {
  const ctx = world({ signature: "changed", matchesSaved: false, mapped: true,
    timetable: { settings: { periodsByDay: { 수: 6 }, lunchAfter: { 1: 4, 2: 4, 3: 4 }, creative: { school: 1, schoolTimes: ["금7"], grade: { 1: 1, 2: 1, 3: 1 }, byGroup: true },
      rules: { maxHours: 20, gap: "soft" }, venues: { 체육: 2 }, openDepartments: ["교양", "정보"] } },
    stats: { items: [item("1", "1", "통합과학", 2, 2, { department: "과학-공통" }), item("2", "1", "체육", 2, 4, { department: "체육", expanded: 4, autoClasses: 3 }),
      item("2", "1", "심화 영어", 3, 0, { kind: "선택", designated: false, basis: "두 학기 편성 · 4단계 학기 미정" }), item("2", "1", "물리학", 3, 2, { kind: "선택", designated: false }), item("2", "1", "화학", 3, 1, { kind: "선택", designated: false })] } });
  // 담임은 6단계 교사 명단의 '담임'(내년 학년-반) 한 곳에서 읽는다. 없는 반(9-9, 2-7)은 쓰지 않는다.
  ctx.classSectionsSettings().teachers[1].homeroom = "2-1";
  ctx.classSectionsSettings().teachers[2].homeroom = "2-7";
  const prepared = plain(ctx.timetableInput("1", "1"));
  const { input, assumptions } = prepared;
  // 담임 명단이 있으면 담임 규칙은 '최대한'(직접 고르면 그 값)
  assert.deepEqual([input.periodsByDay, input.lunchAfter, input.rules, input.venues], [{ 수: 6 }, { 1: 4, 2: 4, 3: 4 }, { maxHours: 20, gap: "soft", homeroom: "soft" }, { 과학실: 1, 체육: 2 }]);
  assert.deepEqual([prepared.homeroomCount, prepared.openDepartments, input.teachers.find((teacher) => teacher.id === "p1").homeroom], [1, ["교양", "정보"], ""]);
  assert.deepEqual(input.notes.homerooms, ["담임이 정해지지 않은 반 7개(1-1, 1-2, 2-2, 2-3, 3-1, 3-2 …) — 그 반은 담임 규칙을 적용하지 않습니다."]);
  assert.deepEqual(input.creative, { school: 1, schoolTimes: ["금7"], grade: { 1: 1, 2: 1, 3: 1 }, gradeTimes: {}, byGroup: true, expected: { 1: 2, 2: 2, 3: 2 }, fromPeriod: 5 });
  assert.equal(input.teachers.find((teacher) => teacher.id === "k2").homeroom, "2-1");
  assert.deepEqual([input.notes.undecided, input.notes.staleSections, input.notes.expandedClasses], [["2학년 심화 영어"], ["현1 → 2학년 1학기 · 2-1 택2"], true]);
  assert.deepEqual(input.lessons.find((lesson) => lesson.subject === "체육").classes, undefined, "확대학급은 반영하지 않고 편제표 값(전체 반)");
  assert.deepEqual(assumptions.map((entry) => entry.key), ["common"]);
  // 사전 점검에 알림으로 나온다
  const causes = plain(ctx.timetablePrecheckFor("1", "1")).issues.filter((issue) => issue.id === "P10").map((issue) => issue.cause);
  assert.ok(causes.some((cause) => /확대학급/.test(cause)) && causes.some((cause) => /2학년 심화 영어: 개설 학기/.test(cause)) && causes.some((cause) => /분반 편성 입력이 바뀌었습니다/.test(cause)));
});

test("반 일부만 듣는 과목(교차집중·분할 편성)의 반 배정: 기본은 앞 반부터, 받은 값은 반 수가 편제표와 같을 때만, 교차집중은 다른 학기에 맞바꿈", () => {
  const ctx = world();
  const split = (index, crossed = true) => ({ row: 7, names: 2, index, crossed });
  const items = [item("2", "1", "미술", 2, 5, { split: split(0) }), item("2", "1", "연극", 2, 6, { split: split(1) }), item("2", "2", "미술", 2, 6, { split: split(0) }), item("2", "2", "연극", 2, 5, { split: split(1) }),
    item("2", "1", "문학", 4, 11), item("3", "1", "음악 감상", 2, 4, { split: { row: 3, names: 3, index: 0, crossed: false } }), item("3", "1", "미술 감상", 2, 4, { split: { row: 3, names: 3, index: 1, crossed: false } }), item("3", "1", "연극 감상", 2, 3, { split: { row: 3, names: 3, index: 2, crossed: false } })];
  const groups = plain(ctx.timetableSplitGroups(items));
  assert.deepEqual(groups.map((group) => [group.key, group.label, group.crossed, group.members.map((member) => [member.subject, member.counts])]), [
    ["2|미술↔연극", "2학년 미술 ↔ 연극(교차집중)", true, [["미술", { 1: 5, 2: 6 }], ["연극", { 1: 6, 2: 5 }]]],
    ["3|음악 감상↔미술 감상↔연극 감상", "3학년 음악 감상 · 미술 감상 · 연극 감상(분할 편성)", false, [["음악 감상", { 1: 4, 2: 0 }], ["미술 감상", { 1: 4, 2: 0 }], ["연극 감상", { 1: 3, 2: 0 }]]]]);
  const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => String(from + index));
  // 기본: 앞 반부터, 2학기는 맞바꿈(1학기에 미술을 들은 반은 2학기에 연극)
  const basic = plain(ctx.timetableSplitPlan(groups[0], 11));
  assert.deepEqual([basic.base, basic.source, basic.errors, basic.classes], ["1", "default", [], { 1: { 미술: range(1, 5), 연극: range(6, 11) }, 2: { 미술: range(6, 11), 연극: range(1, 5) } }]);
  // 받은 값: 한 과목만 적으면 남는 반이 다른 과목, 범위(7-11)·'반' 글자 허용
  const saved = plain(ctx.timetableSplitPlan(groups[0], 11, { 미술: "7-11" }));
  assert.deepEqual([saved.source, saved.classes[1], saved.classes[2]], ["saved", { 미술: range(7, 11), 연극: range(1, 6) }, { 미술: range(1, 6), 연극: range(7, 11) }]);
  assert.deepEqual(plain(ctx.timetableSplitPlan(groups[0], 11, { 미술: "11반, 1 3 5 7" })).classes[1].미술, ["1", "3", "5", "7", "11"]);
  // 반 수가 편제표 × 학급 수(1단계 교차집중 1반 더 받을 과목)와 다르면 쓰지 않는다
  for (const [text, pattern] of [["1,2", /미술: 1학기 5반이어야 합니다\(지금 2반\)/], ["1,2,3,4,12", /반 번호를 1~11 사이 숫자로/], ["가,나", /반 번호를 1~11 사이 숫자로/]]) {
    const bad = plain(ctx.timetableSplitPlan(groups[0], 11, { 미술: text }));
    assert.equal(bad.source, "default");
    assert.match(bad.errors[0], pattern);
    assert.deepEqual(bad.classes[1].미술, range(1, 5));
  }
  assert.match(plain(ctx.timetableSplitPlan(groups[0], 11, { 미술: "1-5", 연극: "5-10" })).errors[0], /연극: 다른 과목과 겹치는 반/);
  // 분할 편성(세 과목): 적지 않은 과목은 남는 반을 차례로
  const three = plain(ctx.timetableSplitPlan(groups[1], 11, { "연극 감상": "1,2,3" }));
  assert.deepEqual(three.classes, { 1: { "연극 감상": ["1", "2", "3"], "음악 감상": range(4, 7), "미술 감상": range(8, 11) } });
});

test("교차집중 반 배정이 시간표 입력에 들어간다: 조건에서 받으면 가정이 사라지고, 틀린 값은 경고", () => {
  const split = (index) => ({ row: 7, names: 2, index, crossed: true });
  const items = [item("2", "1", "미술", 2, 1, { department: "미술", split: split(0) }), item("2", "1", "연극", 2, 2, { department: "미술", split: split(1) }),
    item("2", "2", "미술", 2, 2, { department: "미술", split: split(0) }), item("2", "2", "연극", 2, 1, { department: "미술", split: split(1) })];
  const classesOf = (ctx, semester) => Object.fromEntries(plain(ctx.timetableInput("1", semester)).input.lessons.map((lesson) => [lesson.subject, lesson.classes]));
  const basic = world({ stats: { items }, groups: [] });
  assert.deepEqual([classesOf(basic, "1"), classesOf(basic, "2")], [{ 미술: ["1"], 연극: ["2", "3"] }, { 미술: ["2", "3"], 연극: ["1"] }]);
  assert.ok(plain(basic.timetableInput("1", "1")).assumptions.some((entry) => entry.key === "partial:2"));
  const chosen = world({ stats: { items }, groups: [], timetable: { settings: { splitClasses: { "2|미술↔연극": { 미술: "3" } } } } });
  assert.deepEqual([classesOf(chosen, "1"), classesOf(chosen, "2")], [{ 미술: ["3"], 연극: ["1", "2"] }, { 미술: ["1", "2"], 연극: ["3"] }]);
  const prepared = plain(chosen.timetableInput("1", "2"));
  assert.ok(!prepared.assumptions.some((entry) => entry.key === "partial:2"));
  assert.deepEqual(prepared.splits, [{ key: "2|미술↔연극", label: "2학년 미술 ↔ 연극(교차집중)", grade: "2", crossed: true, base: "1", source: "saved", errors: [],
    members: [{ subject: "미술", count: 1, classes: ["3"], here: ["1", "2"] }, { subject: "연극", count: 2, classes: ["1", "2"], here: ["3"] }] }]);
  const wrong = world({ stats: { items }, groups: [], timetable: { settings: { splitClasses: { "2|미술↔연극": { 미술: "1,2" } } } } });
  assert.match(plain(wrong.timetableInput("1", "1")).input.missing[0].cause, /^2학년 미술 ↔ 연극\(교차집중\) 반 배정: 미술: 1학기 1반이어야 합니다\(지금 2반\).* 앞 반부터 차례로 계산했습니다\.$/);
  // 체육 장소 수를 넣으면 체육 교과 수업에 장소가 붙는다(장소 겹침 점검 대상)
  const venue = world({ timetable: { settings: { venues: { 체육: 2 } } } });
  assert.equal(plain(venue.timetableInput("1", "1")).input.lessons.find((lesson) => lesson.subject === "체육").venue, "체육");
});

test("조건을 바꾸기 전·후 사전 점검 비교(풀림·달라짐·새로 생김), 저장 복원", () => {
  const ctx = world();
  const issue = (id, level, cause) => ({ id, level, cause });
  const before = [issue("P2", "fail", "음악: 교사 2명 × 22 = 44시간 < 이번 학기 수업 45시간(1시간 초과)."), issue("P6", "fail", "3학년: 반 수업 칸 13개(주 35칸 − 블록 20 − 창체 2)에 11반이 … 최대 56시간만 들어갑니다."),
    issue("P1", "info", "1학년: 주간 수업 32시간 < 주 35칸")];
  const after = [issue("P6", "fail", "3학년: 반 수업 칸 13개(주 35칸 − 블록 20 − 창체 2)에 11반이 … 최대 60시간만 들어갑니다."), issue("P10", "warn", "현1 → 2학년 1학기: 분반 편성 입력이 바뀌었습니다."), issue("P1", "info", "1학년: 달라진 참고")];
  const changes = plain(ctx.timetableIssueChanges(before, after));
  assert.deepEqual([changes.resolved.map((entry) => entry.id), changes.changed.map((entry) => [entry.after.id, /56시간/.test(entry.before), /60시간/.test(entry.after.cause)]), changes.added.map((entry) => entry.id)], [["P2"], [["P6", true, true]], ["P10"]]);
  assert.deepEqual(plain(ctx.timetableIssueChanges(before, before)), { resolved: [], added: [], changed: [] });
  // 저장 복원: 조건(settings)과 차수별 값만, 그 밖은 버림(예전 백업은 빈 객체)
  assert.deepEqual(plain(ctx.timetableRestore({ settings: { rules: { maxHours: 20 } }, 1: { 1: {} }, junk: 3, 2: "x" })), { settings: { rules: { maxHours: 20 } }, 1: { 1: {} } });
  assert.deepEqual([plain(ctx.timetableRestore(undefined)), plain(ctx.timetableRestore([1]))], [{}, {}]);
  // 앱 연결: 기본값·작업 자료(백업·저장소)·복원·전체 초기화·단계 그리기
  const app = read("app.js");
  assert.match(app, /classSections: \{\},\n\s+timetable: \{\},/);
  assert.match(app, /timetable: state\.timetable,/);
  assert.match(app, /state\.timetable = typeof timetableRestore === "function" \? timetableRestore\(saved\.timetable\)/);
  assert.match(app, /state\.applicationRosters = \{\};\n\s+state\.timetable = \{\};/);
  assert.match(app, /if \(step === 6 && typeof renderTimetable === "function"\) renderTimetable\(\);/);
  const view = read("timetable-view.js");
  assert.match(view, /deferRenderUntilStepVisible\(6, "renderTimetable", renderTimetable\)\) return;\n  if \(typeof preserveViewDuring === "function"\) return preserveViewDuring\(\["#workflowStep6Panel"\], renderTimetableView\);/);
});

test("전공 일치: 담당 과목으로 두 교과를 함께 맡는 교사, 6단계가 다른 전공 교사를 붙였으면 표시, 교양만 다른 교과 교사 허용, 블록 시간 다시 놓기", () => {
  const entries = { "1:1:2-1 택2": { classCounts: {}, classUnit: {}, blockTimes: { a: "월1,화2,수3" },
    sectionResult: { signature: "sig", blocks: [{ id: "a", letter: "a", sectionIds: ["물리학#1", "화학#1"] }],
      sections: [{ id: "물리학#1", courseKey: "물리학", blockId: "a", teacherId: "pe" }, { id: "화학#1", courseKey: "화학", blockId: "a", teacherId: "c1" }] } } };
  const ctx = world({ entries, groups: [{ key: "1:1:2-1 택2", grade: "1", targetGrade: "2", semester: "1", category: "2-1 택2", label: "현1 → 2학년 1학기 · 2-1 택2", classes: 3,
    courses: [{ key: "물리학", name: "물리학", credits: 3, department: "과학-물리", classCount: 1 }, { key: "화학", name: "화학", credits: 3, department: "과학-화학", classCount: 1 }] }],
  settings: { teachers: [{ id: "c1", name: "최화학", department: "과학-화학" }, { id: "pe", name: "체육쌤", department: "체육" }, { id: "info", name: "정보쌤", department: "정보", courses: "지식 재산 일반, 발명" }],
    fixedSlots: [] },
  stats: { items: [item("3", "1", "지식 재산 일반", 4, 3, { department: "기술가정" }), item("3", "1", "생태와 환경", 1, 3, { department: "교양" }), item("2", "1", "물리학", 3, 1, { kind: "선택", designated: false }), item("2", "1", "화학", 3, 1, { kind: "선택", designated: false })] } });
  const { input } = plain(ctx.timetableInput("1", "1"));
  // 정보 교사가 담당 과목으로 기술·가정 과목을 함께 맡는다
  assert.deepEqual(input.lessons.find((lesson) => lesson.subject === "지식 재산 일반").teacherIds, ["info"]);
  // 교양 과목은 담당 교과(5단계)가 교양이면 교양 교사만 후보(여기서는 없음 → '담당 교사 없음')
  assert.deepEqual(input.lessons.find((lesson) => lesson.subject === "생태와 환경").teacherIds, []);
  // 6단계가 체육 교사를 물리학 분반에 붙였으면 전공 불일치 표시
  assert.deepEqual(input.blocks[0].sections.map((section) => [section.subject, section.teacherId, section.teacherMismatch || false]), [["물리학", "pe", true], ["화학", "c1", false]]);
  const causes = plain(ctx.timetablePrecheck(input)).issues.filter((issue) => issue.level === "fail").map((issue) => issue.cause);
  assert.ok(causes.some((cause) => /^교양: 3학년 생태와 환경 3시간을 맡을 수 있는 교사가 명단에 없습니다 → '담당 교사 없음' 3시간/.test(cause)), causes.join("\n"));
  assert.ok(causes.some((cause) => /^체육쌤 교사: 2학년 물리학\(2-1 택2 a블록\) 3시간은 이 교사의 담당 교과·담당 과목에 없는 수업입니다/.test(cause)), causes.join("\n"));
  // 블록 시간은 시간표가 정하는 것이 기본(6단계 블록 시간을 넘기지 않음), '6단계 블록 시간 그대로'를 켜면 고정 시간으로 넘긴다
  assert.equal(input.blocks[0].times, "");
  const keep = world({ entries, timetable: { settings: { keepBlockTimes: true } }, groups: ctx.classSectionsSource().groups });
  assert.equal(plain(keep.timetableInput("1", "1")).input.blocks[0].times, "월1,화2,수3");
});

test("선택형 해결: 항목마다 고를 수 있는 선택지와 예상 효과, 적용하면 고른 내역이 남고 되돌릴 수 있다(교사를 늘리는 선택지는 없음)", () => {
  const ctx = world();
  const result = { counts: { block: 0, fail: 2, warn: 0, info: 0 }, issues: [
    { id: "P6", level: "fail", cause: "3학년: 반 수업 칸 13개…", relax: ["creativeFree", "creativeGroup", "blockTimes", "oncePerDay", "gaps", "stagger"] },
    { id: "P2", level: "fail", cause: "교양: 3학년 생태와 환경 10시간을 맡을 수 있는 교사가 명단에 없습니다", data: { department: "교양" }, relax: ["otherDepartment", "noTeacher"] },
    { id: "P2", level: "fail", cause: "기술가정: 3학년 지식 재산 일반 16시간을 맡을 수 있는 교사가 명단에 없습니다", data: { department: "기술가정" }, relax: ["otherDepartment", "noTeacher"] },
    { id: "P10", level: "warn", cause: "알림", relax: [] }] };
  const prepared = { creativeTotal: 2, input: { creative: { school: 2, schoolTimes: ["금6", "금7"], grade: 0, gradeTimes: {}, byGroup: false }, blocks: [{ times: "월1" }] } };
  const asked = [];
  const preview = (key) => { asked.push(key); return key === "creativeGroup" ? { counts: { block: 0, fail: 1 }, issues: [result.issues[1]] } : { counts: { block: 0, fail: 2 }, issues: result.issues }; };
  // 블록 시간을 이미 시간표가 정하고 있으면(기본) '블록 시간 다시 놓기' 선택지는 없다
  assert.equal(plain(ctx.timetableChoicesFor(result, prepared, { rules: { gap: "soft" } }, preview).get("P6|3학년")).some((choice) => choice.key === "blockTimes"), false);
  asked.length = 0;
  const choices = ctx.timetableChoicesFor(result, prepared, { rules: { gap: "soft" }, keepBlockTimes: true }, preview);
  const view = (key) => plain(choices.get(key)).map((choice) => [choice.key, choice.kind, choice.effect ? [choice.effect.solved, choice.effect.failBefore, choice.effect.failAfter] : choice.where.step]);
  // P6: 추천 순서(양보가 작은 것부터), 이미 '최대한'인 공강은 빠짐, 반 묶음 나누기는 6단계 안내
  assert.deepEqual(view("P6|3학년"), [["blockTimes", "setting", [false, 2, 2]], ["creativeFree", "setting", [false, 2, 2]], ["creativeGroup", "setting", [true, 2, 1]], ["oncePerDay", "setting", [false, 2, 2]], ["stagger", "link", 8]]);
  // 교양 과목만 '다른 교과 교사가 맡기', 교양이 아닌 과목은 '담당 교사 없음'으로 두기뿐
  assert.deepEqual(view("P2|교양"), [["otherDepartment", "link", 7], ["noTeacher", "accept", 4]]);
  assert.deepEqual(view("P2|기술가정"), [["noTeacher", "accept", 4]]);
  assert.equal(choices.size, 3);
  assert.deepEqual([...new Set(asked)].sort(), ["blockTimes", "creativeFree", "creativeGroup", "oncePerDay"], "같은 선택은 한 번만 계산");
  const labels = Object.values(vm.runInContext("TIMETABLE_CHOICES", ctx)).map((choice) => `${choice.label} ${choice.gives}`).join(" ");
  assert.doesNotMatch(labels, /증원|강사|순회|교사를 늘/);
  // 계산 뒤 남은 위반에 맞는 선택지 이름은 모두 조건을 바꾸는 선택지(patch)
  const resultChoices = plain(vm.runInContext("TIMETABLE_RESULT_CHOICES", ctx));
  assert.deepEqual(Object.keys(resultChoices).sort(), ["gap", "lunch", "maxPerDay", "oncePerDay", "run"]);
  // 뼈대 중간 단계: 점심·연강 위반에 '블록 순서를 학기마다 다르게 허용' — 뼈대가 '같은 칸'일 때만 나온다
  assert.deepEqual([resultChoices.lunch, resultChoices.run], [["frameOrder"], ["teacherRules", "frameOrder"]]);
  assert.deepEqual(plain(vm.runInContext("TIMETABLE_CHOICES.frameOrder.patch({ rules: { run: 4 } })", ctx)), { rules: { run: 4, semesterFrame: "order" } });
  assert.deepEqual([vm.runInContext("TIMETABLE_CHOICES.frameOrder.skip({})", ctx), vm.runInContext("TIMETABLE_CHOICES.frameOrder.skip({ rules: { semesterFrame: 'order' } })", ctx), vm.runInContext("TIMETABLE_CHOICES.frameOrder.skip({ rules: { semesterFrame: 'soft' } })", ctx)], [false, true, true]);
  assert.ok(Object.values(resultChoices).flat().every((key) => vm.runInContext(`typeof TIMETABLE_CHOICES.${key}.patch`, ctx) === "function"));
  // 두 학기 같은 칸 결과에 교사 점심·연강이 남으면 '블록 순서를 학기마다 다르게 허용'이 맨 앞·추천(실제 자료에서 이 선택으로 풀린 위반)
  const leftover = { metrics: { frameMode: "hard" }, noTeacher: [], violations: [
    { level: "hard", rule: "oncePerDay", amount: 2, subjects: [] }, { level: "hard", rule: "lunch", amount: 1 }, { level: "hard", rule: "lunch", amount: 1 }, { level: "hard", rule: "run", amount: 1 }, { level: "soft", rule: "lunch", amount: 5 }] };
  assert.deepEqual(plain(ctx.timetableResultChoiceKeys(leftover, {}, {})), { keys: ["frameOrder", "releaseTeacher", "oncePerDay", "teacherRules"], recommended: "frameOrder", lunch: 2, run: 1 });
  // 한 학기만 계산한 결과·이미 '같은 시간대'인 조건·점심·연강이 없는 결과에는 추천하지 않는다
  assert.equal(ctx.timetableResultChoiceKeys({ ...leftover, metrics: { frameMode: "off" } }, {}, {}).recommended, "");
  assert.deepEqual(plain(ctx.timetableResultChoiceKeys(leftover, { rules: { semesterFrame: "order" } }, {})), { keys: ["releaseTeacher", "oncePerDay", "teacherRules"], recommended: "", lunch: 2, run: 1 });
  assert.deepEqual(plain(ctx.timetableResultChoiceKeys({ metrics: { frameMode: "hard" }, violations: [{ level: "hard", rule: "oncePerDay", amount: 1 }] }, {}, {})), { keys: ["releaseTeacher", "oncePerDay"], recommended: "", lunch: 0, run: 0 });
  // 과목을 붙이는 선택지 'double:과목' = 그 과목 2시간 연속 수업 허용(이미 고른 과목이면 빠짐)
  const double = vm.runInContext("timetableChoiceOf('double:발명과 기업가 정신')", ctx);
  assert.equal(double.label, "'발명과 기업가 정신' 2시간 연속 수업 허용");
  assert.deepEqual(plain(double.patch({ doubleSubjects: ["체육"] })), { doubleSubjects: ["체육", "발명과 기업가 정신"] });
  assert.deepEqual([double.skip({}), double.skip({ doubleSubjects: ["발명과 기업가 정신"] })], [false, true]);
  // '공강 먼저' 선택: 규칙 cover = soft, 이미 켜져 있으면 선택지에서 빠짐
  assert.deepEqual(plain(vm.runInContext("TIMETABLE_CHOICES.releaseTeacher.patch({ rules: { run: 4 } })", ctx)), { rules: { run: 4, cover: "soft" } });
  assert.deepEqual([vm.runInContext("TIMETABLE_CHOICES.releaseTeacher.skip({})", ctx), vm.runInContext("TIMETABLE_CHOICES.releaseTeacher.skip({ rules: { cover: 'soft' } })", ctx)], [false, true]);
  // 적용: 조건이 바뀌고 고른 내역(되돌릴 값)이 남는다 → 되돌리기
  vm.runInContext("TIMETABLE_VIEW.prepared = " + JSON.stringify(prepared), ctx);
  ctx.state.timetable = { settings: { rules: { run: 4 } } };
  assert.equal(ctx.timetableApplyChoice("creativeGroup"), "선택 — 같은 학년 안에서 반 묶음마다 창체 시간을 다르게(반군별)");
  assert.equal(ctx.timetableApplyChoice("gaps"), "선택 — 반 공강 허용(최대한 줄이고 끝 교시 쪽으로)");
  const settings = plain(ctx.state.timetable.settings);
  assert.deepEqual([settings.creative, settings.rules, settings.choices.map((entry) => [entry.key, entry.before.creative, entry.before.rules])],
    [{ school: 1, schoolTimes: [], grade: 1, gradeTimes: {}, byGroup: true }, { run: 4, gap: "soft" }, [["creativeGroup", null, { run: 4 }], ["gaps", { school: 1, schoolTimes: [], grade: 1, gradeTimes: {}, byGroup: true }, { run: 4 }]]]);
  // 과목 선택지도 고른 내역에 남고 되돌릴 수 있다
  assert.equal(ctx.timetableApplyChoice("double:체육"), "선택 — '체육' 2시간 연속 수업 허용");
  assert.deepEqual([plain(ctx.state.timetable.settings.doubleSubjects), ctx.state.timetable.settings.choices.length], [["체육"], 3]);
  assert.equal(ctx.timetableUndoChoice(), "되돌림 — '체육' 2시간 연속 수업 허용");
  assert.equal(ctx.state.timetable.settings.doubleSubjects, undefined);
  assert.equal(ctx.timetableUndoChoice(), "되돌림 — 반 공강 허용(최대한 줄이고 끝 교시 쪽으로)");
  assert.deepEqual([plain(ctx.state.timetable.settings.rules), ctx.state.timetable.settings.choices.length], [{ run: 4 }, 1]);
  assert.equal(ctx.timetableUndoChoice(), "되돌림 — 같은 학년 안에서 반 묶음마다 창체 시간을 다르게(반군별)");
  assert.deepEqual(plain(ctx.state.timetable.settings), { rules: { run: 4 } });
  assert.equal(ctx.timetableUndoChoice(), "");
});

test("시간을 정하지 않은 창체를 놓을 수 있는 첫 교시: 기본 5교시 이후, 조건 칸으로 바꾸면 입력에 실린다(기본값이면 저장하지 않음)", () => {
  const ctx = world();
  assert.equal(plain(ctx.timetableInput("1", "1")).input.creative.fromPeriod, 5);
  ctx.state.timetable = { settings: {} };
  assert.equal(ctx.timetableApplyField("creativeFrom", { value: "3" }), "시간을 정하지 않은 창체는 3교시 이후에만");
  assert.equal(ctx.state.timetable.settings.creativeFrom, 3);
  assert.equal(ctx.timetableApplyField("creativeFrom", { value: "5" }), "시간을 정하지 않은 창체는 5교시 이후에만");
  assert.equal(ctx.state.timetable.settings.creativeFrom, undefined);
  assert.equal(ctx.timetableApplyField("creativeFrom", { value: "0" }), "");
  const custom = world({ timetable: { settings: { creativeFrom: 1 } } });
  assert.equal(plain(custom.timetableInput("1", "1")).input.creative.fromPeriod, 1);
});

test("칸 고정: settings.pins[학기]가 그 학기 입력의 pins.lessons로 실리고, 없으면 입력에 pins 키가 없다(서명 그대로)", () => {
  const plainCtx = world();
  assert.equal("pins" in plain(plainCtx.timetableInput("1", "1")).input, false);
  const ctx = world({ timetable: { settings: { pins: { 1: { "1|공통국어@1-1": ["월2"] }, 2: { "2|독서@2-1": ["화3"] } } } } });
  assert.deepEqual(plain(ctx.timetableInput("1", "1")).input.pins, { lessons: { "1|공통국어@1-1": ["월2"] } });
  assert.deepEqual(plain(ctx.timetableInput("1", "2")).input.pins, { lessons: { "2|독서@2-1": ["화3"] } });
  // 담당 교사 고정(settings.teacherPins[학기])도 그 학기 입력의 pins.teachers로 실린다(칸 고정이 없어도)
  const teacherCtx = world({ timetable: { settings: { teacherPins: { 1: { "1|공통국어@1-1": "t-국어-1" } } } } });
  assert.deepEqual(plain(teacherCtx.timetableInput("1", "1")).input.pins, { teachers: { "1|공통국어@1-1": "t-국어-1" } });
  assert.equal("pins" in plain(teacherCtx.timetableInput("1", "2")).input, false);
  // 모형: 그 반 수업에만 고정이 붙는다(격자에 없는 칸은 버림)
  const model = ctx.timetableModel(ctx.timetableInput("1", "1").input);
  assert.deepEqual(plain(model.lessons.filter((lesson) => lesson.pins.length).map((lesson) => [lesson.id, lesson.pins])), [["1|공통국어@1-1", ["월2"]]]);
});

test("반군 엇갈림 견적(T7a): 6단계 분반 결과를 읽어 블록 k개를 엇갈릴 때 늘어나는 분반 수를 학기별로 내고 큰 쪽을 보여 준다(6단계 자료는 그대로)", () => {
  // 3학년 4반, 1학기 택2: a블록 물리학 2분반(1·2반 학생 40명, 3·4반 10명)·화학 1분반(반마다 7명), b블록 생명과학 2분반(같은 학생들: 1·2반 40명, 3·4반 10명)
  const students = [];
  const assign = {};
  const add = (room, count, ids) => { for (let n = 0; n < count; n += 1) { const key = `2-${room}-${students.length + 1}`; students.push({ key, homeroom: String(room) }); assign[key] = ids; } };
  add(1, 20, ["물리#1", "생명#1"]); add(2, 20, ["물리#2", "생명#1"]); add(3, 6, ["물리#1", "생명#2"]); add(4, 4, ["물리#2", "생명#2"]);
  for (const room of [1, 2, 3, 4]) add(room, 7, ["화학#1"]);
  const sectionResult = { signature: "sig", blocks: [{ id: "a", letter: "a" }, { id: "b", letter: "b" }], assign,
    sections: [{ id: "물리#1", courseKey: "물리", blockId: "a" }, { id: "물리#2", courseKey: "물리", blockId: "a" }, { id: "화학#1", courseKey: "화학", blockId: "a" }, { id: "생명#1", courseKey: "생명", blockId: "b" }, { id: "생명#2", courseKey: "생명", blockId: "b" }] };
  const before = JSON.stringify(sectionResult);
  const group = { key: "2:1:3-1 택2", grade: "2", targetGrade: "3", semester: "1", category: "3-1 택2", students, courses: [{ key: "물리", name: "물리학" }, { key: "화학", name: "화학" }, { key: "생명", name: "생명과학" }] };
  const ctx = world({ groups: [group], entries: { "2:1:3-1 택2": { blockTimes: {}, classCounts: {}, classUnit: {}, sectionResult } } });
  ctx.classSectionsSource = () => ({ groups: [group], maxClassSize: 30 });
  ctx.classSectionsHomeroomStudents = (target) => target.students;
  ctx.classSectionsEffectiveClassMap = () => ({ map: null });
  const estimate = plain(ctx.timetableStaggerFor("1", "3", 4, {}));
  assert.deepEqual([estimate.label, estimate.mapped, Object.keys(estimate.semesters)], ["1~2반 / 3~4반", false, ["1"]]);
  // 정원 30: b블록(생명과학 40·10 → 2 + 1 = 3분반, +1) 먼저, 그다음 a블록(물리학 40·10 → +1, 화학 14·14 → +1). 뒤 묶음 10명은 '10명 미만'이 아니다
  assert.deepEqual(estimate.plans, [{ k: 1, extra: 1, small: 0, blocks: { 1: ["3-1 택2 b블록"] } }, { k: 2, extra: 3, small: 0, blocks: { 1: ["3-1 택2 b블록", "3-1 택2 a블록"] } }]);
  assert.equal(JSON.stringify(sectionResult), before, "6단계 결과는 읽기만");
  // 반 묶음을 직접 지정('1-3/4'): 물리학·생명과학 46·4, 화학 21·7 → 과목마다 +1이고 4반 묶음 분반 3개는 모두 10명 미만
  const custom = plain(ctx.timetableStaggerFor("1", "3", 4, { staggerGroups: { 3: "1-3/4" } }));
  assert.deepEqual([custom.label, custom.plans[1].extra, custom.plans[1].small], ["1~3반 / 4반", 3, 3]);
  // 반 묶음 글 읽기: 둘 이상·겹치지 않게·범위 안
  assert.deepEqual(plain(ctx.timetableStaggerGroups("1-6/7-11", "3", 11)), { A: ["3-1", "3-2", "3-3", "3-4", "3-5", "3-6"], B: ["3-7", "3-8", "3-9", "3-10", "3-11"] });
  assert.deepEqual([ctx.timetableStaggerGroups("1-6", "3", 11), ctx.timetableStaggerGroups("1-6/6-11", "3", 11), ctx.timetableStaggerGroups("1-6/12", "3", 11), ctx.timetableStaggerGroups("가/나", "3", 11)], [null, null, null, null]);
  // 분반 결과가 없는 학년은 견적 없음
  assert.equal(ctx.timetableStaggerFor("1", "1", 4, {}), null);
  // 사전 점검 선택지: P6의 '반 묶음을 나눠 블록 일부를 엇갈리게'에 견적이 붙는다
  const result = { counts: { block: 0, fail: 1, warn: 0, info: 0 }, issues: [{ id: "P6", level: "fail", cause: "3학년: 반 수업 칸 13개…", data: { grade: "3", classes: 4 }, relax: ["stagger"] }] };
  const choices = plain(ctx.timetableChoicesFor(result, { round: "1", input: { creative: {}, blocks: [] } }, {}, () => null).get("P6|3학년"));
  assert.deepEqual(choices.map((choice) => [choice.key, choice.kind, choice.estimate?.label, choice.estimate?.plans.map((plan) => [plan.k, plan.extra])]), [["stagger", "link", "1~2반 / 3~4반", [[1, 1], [2, 3]]]]);
  assert.deepEqual(choices[0].estimate.plans.map((plan) => plan.effect), [undefined, undefined], "입력에 그 블록이 없으면 예상 효과는 붙이지 않는다");
  // 예상 효과(T7a-2): 이 학기 입력을 엇갈린 구조로 바꿔 사전 점검을 다시 돌린다.
  // 3학년 4반, 주 20칸, 블록 a·b 4시간씩, 반 수업 체육 4시간(교사 2명 < 4반, 한 반 하루 1시간) → 하루 끝 쪽 닷새 × 2명 = 10 < 16시간(13칸 문제)
  const staff = (id, department) => ({ id, name: id, departments: [department] });
  const section = (id, subject, department, teacherId) => ({ id, subject, department, credits: 4, teacherId });
  const input = { semester: "1", days: "월,화,수,목,금", periods: 4, grades: [{ grade: "3", classes: 4 }], creative: { school: 0, schoolTimes: [] },
    teachers: [staff("체1", "체육"), staff("체2", "체육"), staff("물1", "물리"), staff("물2", "물리"), staff("화1", "화학"), staff("생1", "생명"), staff("생2", "생명"), staff("생3", "생명")],
    lessons: [{ id: "체육", grade: "3", subject: "체육", department: "체육", hours: 4 }],
    blocks: [{ id: "2:1:3-1 택2|a", grade: "3", label: "3-1 택2 a블록", sections: [section("물리#1", "물리학", "물리", "물1"), section("물리#2", "물리학", "물리", "물2"), section("화학#1", "화학", "화학", "화1")] },
      { id: "2:1:3-1 택2|b", grade: "3", label: "3-1 택2 b블록", sections: [section("생명#1", "생명과학", "생명", "생1"), section("생명#2", "생명과학", "생명", "생2")] }] };
  const checked = ctx.timetablePrecheck(input);
  assert.deepEqual(plain(checked.issues.filter((issue) => issue.level === "fail").map((issue) => [issue.id, issue.data.capacity, issue.data.need])), [["P6", 10, 16]]);
  const staggered = plain(ctx.timetableChoicesFor(checked, { round: "1", input }, {}, () => null).get("P6|3학년")).find((choice) => choice.key === "stagger");
  // b블록 하나를 엇갈리면(생명과학 2 + 1분반): 한 묶음(2반)이 b블록일 때 다른 묶음 2반이 체육을 받는다 → 4칸 × 2반 × 2묶음 = 16시간 → 이 항목 풀림, 조건 위반 1 → 0건
  assert.deepEqual(staggered.estimate.plans.map((plan) => [plan.k, plan.extra, plan.effect]), [[1, 1, { solved: true, note: "", failBefore: 1, failAfter: 0 }], [2, 3, { solved: true, note: "", failBefore: 1, failAfter: 0 }]]);
  // 풀리지 않을 때는 얼마나 나아지는지: 체육 교사가 한 명이면(4반 × 4시간 = 16시간을 한 칸에 한 반씩) 반 수업 칸 12 → 엇갈리면 16칸
  const solo = { ...input, teachers: input.teachers.filter((teacher) => teacher.id !== "체2") };
  const soloCheck = ctx.timetablePrecheck(solo);
  const p7 = plain(soloCheck.issues.find((issue) => issue.id === "P7"));
  assert.deepEqual([p7.data.free, p7.data.shortage, p7.relax.includes("stagger")], [12, 4, true]);
  const soloChoice = plain(ctx.timetableChoicesFor(soloCheck, { round: "1", input: solo }, {}, () => null).get(ctx.timetableIssueKey(p7))).find((choice) => choice.key === "stagger");
  assert.deepEqual(soloChoice.estimate.plans.map((plan) => [plan.k, plan.effect.solved, plan.effect.note]), [[1, true, ""], [2, true, ""]]);
  // 체육이 5시간이면(20시간): 블록 하나를 엇갈려도 16칸이라 4시간이 남는다 → '그대로'와 함께 줄어든 만큼을 적고, 둘 다 엇갈리면 풀림
  const heavy = { ...solo, lessons: [{ ...solo.lessons[0], hours: 5 }] };
  const heavyCheck = ctx.timetablePrecheck(heavy);
  const heavyIssue = plain(heavyCheck.issues.find((issue) => issue.id === "P7"));
  const heavyChoice = plain(ctx.timetableChoicesFor(heavyCheck, { round: "1", input: heavy }, {}, () => null).get(ctx.timetableIssueKey(heavyIssue))).find((choice) => choice.key === "stagger");
  assert.deepEqual(heavyChoice.estimate.plans.map((plan) => [plan.k, plan.effect.solved, plan.effect.note]), [[1, false, "넣을 수 없는 시간 8 → 4시간"], [2, true, ""]]);
  assert.match(ctx.timetableChoicesHtml([heavyChoice]), /data-solved="false" data-fail-after="\d+">이 항목은 그대로\(넣을 수 없는 시간 8 → 4시간\) · 조건 위반 \d+ → \d+건</);
  const after = plain(ctx.timetableStaggerPrecheck(input, ctx.timetableStaggerFor("1", "3", 4, {}), "3", 1));
  assert.deepEqual([after.counts.fail, after.issues.filter((issue) => issue.id === "P6").length], [0, 0]);
  assert.match(ctx.timetableChoicesHtml([staggered]), /data-tt-stagger-effect="1" data-solved="true" data-fail-after="0">이 항목 풀림 · 조건 위반 1 → 0건</);
  // 다른 학기(이 학기에는 그 학년 블록 견적이 없음)면 예상 효과 없음
  assert.equal(ctx.timetableStaggerPrecheck({ ...input, semester: "2" }, ctx.timetableStaggerFor("1", "3", 4, {}), "3", 1), null);
});

test("2시간 연속 수업 허용 과목: 고른 과목의 반 수업에만 double 표시(과목명 표기 차이는 맞춰 봄), 조건 칸으로 넣고 뺀다", () => {
  const ctx = world({ timetable: { settings: { doubleSubjects: ["체 육"] } } });
  const { input } = plain(ctx.timetableInput("1", "1"));
  const doubled = input.lessons.filter((lesson) => lesson.double).map((lesson) => lesson.subject);
  assert.deepEqual([...new Set(doubled)], ["체육"]);
  assert.ok(input.lessons.some((lesson) => lesson.subject === "공통국어" && lesson.double === undefined));
  // 사전 점검도 그 과목은 하루 2시간까지로 본다(같은 교사가 한 반에 주 5시간 넘어도 알리지 않음)
  const off = plain(world().timetableInput("1", "1")).input;
  assert.ok(off.lessons.every((lesson) => lesson.double === undefined));
  // 조건 칸: 체크하면 목록에 넣고, 풀면 빼고, 비면 키를 지운다
  ctx.state.timetable = { settings: {} };
  assert.equal(ctx.timetableApplyField("double:문학", { checked: true }), "'문학' 2시간 연속 수업 허용");
  assert.equal(ctx.timetableApplyField("double:체육", { checked: true }), "'체육' 2시간 연속 수업 허용");
  assert.deepEqual(plain(ctx.state.timetable.settings.doubleSubjects), ["문학", "체육"]);
  assert.equal(ctx.timetableApplyField("double:문학", { checked: false }), "'문학' 2시간 연속 수업 허용 안 함");
  ctx.timetableApplyField("double:체육", { checked: false });
  assert.equal(ctx.state.timetable.settings.doubleSubjects, undefined);
});

test("교사 0명인데 수업이 있는 교과는 자리 교사 1명을 두고 계산한다(사용자 결정) — 맡을 교사가 명단에 없을 때만, 가정으로 표시", () => {
  const items = [item("3", "1", "지식 재산 일반", 4, 3, { department: "기술가정" }), item("3", "1", "생태와 환경", 1, 3, { department: "교양" }), item("2", "1", "문학", 4, 3, { department: "국어" })];
  const assumed = [{ id: "기술가정", hours: { 1: 12, 2: 0 } }];
  // 1) 명단에 기술·가정을 맡을 교사가 없다 → t-기술가정-1(6단계 명단 만들기와 같은 자리 이름), 전공은 그 교과뿐
  const ctx = world({ groups: [], stats: { items, assumedTeachers: assumed } });
  const prepared = plain(ctx.timetableInput("1", "1"));
  const added = prepared.input.teachers.find((teacher) => teacher.id === "t-기술가정-1");
  assert.deepEqual(added, { id: "t-기술가정-1", name: "기술가정 1", departments: ["기술가정"], courses: [], unavailable: [], homeroom: "", placeholder: true });
  assert.deepEqual(prepared.input.lessons.find((lesson) => lesson.subject === "지식 재산 일반").teacherIds, ["t-기술가정-1"]);
  assert.deepEqual(prepared.input.lessons.find((lesson) => lesson.subject === "생태와 환경").teacherIds, [], "교양은 대상이 아니다(다른 교과 교사가 맡음)");
  const note = prepared.assumptions.find((entry) => entry.key === "assumed:기술가정");
  assert.match(note.text, /^기술가정: 교사 0명 → 1명 배치로 계산\(5단계 교사 수에 넣으면 사라짐/);
  assert.equal(note.where.step, 7);
  const causes = plain(ctx.timetablePrecheck(prepared.input)).issues.map((issue) => issue.cause);
  assert.ok(!causes.some((cause) => /^기술가정: .*담당 교사 없음/.test(cause)) && causes.some((cause) => /^교양: .*담당 교사 없음/.test(cause)), causes.join("\n"));
  // 2) 다른 교사가 담당 과목으로 이미 맡고 있으면(정보 교사가 지식 재산 일반) 더하지 않는다
  const covered = world({ groups: [], stats: { items, assumedTeachers: assumed },
    settings: { teachers: [{ id: "info", name: "정보쌤", department: "정보", courses: "지식 재산 일반" }, { id: "kor", name: "국어쌤", department: "국어" }], fixedSlots: [] } });
  const second = plain(covered.timetableInput("1", "1"));
  assert.equal(second.input.teachers.some((teacher) => teacher.id === "t-기술가정-1"), false);
  assert.equal(second.assumptions.some((entry) => entry.key === "assumed:기술가정"), false);
  // 3) 교사 명단이 없으면(5단계 교사 수로 자리 교사) 그 교과도 1명
  const bare = world({ groups: [], stats: { items, assumedTeachers: assumed }, settings: { teachers: [], fixedSlots: [] } });
  assert.ok(plain(bare.timetableInput("1", "1")).input.teachers.some((teacher) => teacher.id === "t-기술가정-1"));
});
