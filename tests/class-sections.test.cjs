// 6단계 분반 편성 순수 계산(class-sections.js): 블록 배치·학생 배정·검증기·고정·부분 재계산·교사 불가 시간·학년 간 교사 겹침·
// 정원 제안·방식 비교·학급 단위 과목·나이스 행·Worker 소스·성능. 모든 학생 자료는 합성(가명 키)이다.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "class-sections.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function context() {
  const ctx = vm.createContext({ performance });
  vm.runInContext(source, ctx);
  return ctx;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 과목 인기도를 다르게 둔 합성 신청. 분반 수 = ceil(신청 / sizeFor).
function synthetic({ courses, choose, students, seed = 1, homerooms = 10, capacity = 30, sizeFor = capacity, grade = 1 }) {
  const random = rng(seed);
  const weights = courses.map(() => 0.4 + random() * 1.2);
  const list = [];
  const demand = new Map();
  for (let i = 0; i < students; i += 1) {
    const pool = courses.map((_, k) => k);
    const pick = [];
    while (pick.length < choose) {
      const total = pool.reduce((sum, k) => sum + weights[k], 0);
      let x = random() * total;
      for (let j = 0; j < pool.length; j += 1) { x -= weights[pool[j]]; if (x <= 0 || j === pool.length - 1) { pick.push(pool[j]); pool.splice(j, 1); break; } }
    }
    const homeroom = String(1 + (i % homerooms));
    const number = 1 + Math.floor(i / homerooms);
    const names = pick.map((k) => courses[k].name);
    names.forEach((name) => demand.set(name, (demand.get(name) || 0) + 1));
    list.push({ key: `${grade}-${homeroom}-${number}`, homeroom, courses: names });
  }
  return {
    groupId: "1:1:2-1", label: "현1 → 2학년 1학기", grade, targetGrade: grade + 1, semester: 1, blocks: choose, defaultCapacity: capacity,
    courses: courses.map((course) => ({ key: course.name, name: course.name, department: course.department || "", room: course.room || "", credits: 3,
      sections: course.sections ?? Math.ceil((demand.get(course.name) || 0) / sizeFor) })),
    students: list, seed: 7
  };
}

const SCIENCE = [
  { name: "물리학", department: "물리" }, { name: "화학", department: "화학" },
  { name: "생명과학", department: "생명" }, { name: "지구과학", department: "지구" }
];
const EIGHT = [
  { name: "세계시민과 지리", department: "지리" }, { name: "세계사", department: "역사" }, { name: "사회와 문화", department: "일반사회" },
  { name: "현대사회와 윤리", department: "윤리" }, ...SCIENCE
];

function errors(issues) {
  return issues.filter((issue) => issue.severity === "error");
}

test("solve: every chosen course assigned once, no block conflicts, capacities and block limits respected", () => {
  const ctx = context();
  const input = synthetic({ courses: EIGHT, choose: 3, students: 240, capacity: 30, sizeFor: 27, seed: 3 });
  input.maxSectionsPerBlock = 11;
  const result = plain(ctx.classSectionsSolve(input));
  assert.equal(result.unassigned.length, 0, result.explain.summary);
  assert.deepEqual(errors(result.issues), []);
  const sections = new Map(result.sections.map((section) => [section.id, section]));
  for (const student of input.students) {
    const ids = result.assign[student.key];
    assert.equal(ids.length, student.courses.length);
    assert.deepEqual(ids.map((id) => sections.get(id).courseKey).sort(), student.courses.slice().sort());
    assert.equal(new Set(ids.map((id) => sections.get(id).blockId)).size, ids.length, `${student.key} block conflict`);
  }
  for (const section of result.sections) assert.ok(section.size <= section.capacity);
  for (const block of result.blocks) assert.ok(block.sectionIds.length <= 11);
  assert.equal(result.blocks.map((block) => block.letter).join(""), "abc");
  assert.equal(result.explain.feasible, true);
  // 검증기는 결과만 보고 다시 센다: 같은 결과면 같은 판정
  assert.deepEqual(errors(plain(ctx.classSectionsValidate(input, result))), []);
});

test("validator catches block conflict, over capacity, duplicates, unchosen, missing and block limit", () => {
  const ctx = context();
  const input = synthetic({ courses: SCIENCE, choose: 2, students: 60, capacity: 30, sizeFor: 20, seed: 5 });
  input.maxSectionsPerBlock = Math.ceil(input.courses.reduce((sum, course) => sum + course.sections, 0) / 2) + 1;
  const good = plain(ctx.classSectionsSolve(input));
  assert.deepEqual(errors(good.issues), []);
  const bad = plain(good);
  const [first, second] = input.students;
  const firstIds = bad.assign[first.key];
  const sameBlock = bad.sections.find((section) => section.blockId === bad.sections.find((s) => s.id === firstIds[0]).blockId && section.courseKey !== bad.sections.find((s) => s.id === firstIds[0]).courseKey);
  if (sameBlock) bad.assign[first.key] = [firstIds[0], sameBlock.id];
  bad.assign[second.key] = [bad.assign[second.key][0], bad.assign[second.key][0]];
  const victim = bad.sections[0];
  victim.capacity = 1;
  const unchosen = input.students.find((student) => !student.courses.includes(bad.sections[1].courseKey));
  bad.assign[unchosen.key] = [...bad.assign[unchosen.key], bad.sections[1].id];
  const missing = input.students[5];
  bad.assign[missing.key] = [];
  bad.blocks[0].maxSections = 1;
  bad.unassigned = [];
  const types = new Set(plain(ctx.classSectionsValidate(input, bad)).map((issue) => issue.type));
  for (const type of ["duplicate", "over-capacity", "not-chosen", "missing", "block-over"]) assert.ok(types.has(type), `${type} found`);
  if (sameBlock) assert.ok(types.has("block-conflict"));
});

test("same seed gives the same result; a different seed may differ but stays valid", () => {
  const ctx = context();
  const input = synthetic({ courses: EIGHT, choose: 3, students: 180, capacity: 30, sizeFor: 27, seed: 11 });
  const strip = (result) => { const copy = plain(result); delete copy.elapsedMs; return copy; };
  const a = strip(ctx.classSectionsSolve(input));
  const b = strip(ctx.classSectionsSolve(input));
  assert.deepEqual(a, b);
  const c = plain(ctx.classSectionsSolve({ ...input, seed: 99 }));
  assert.deepEqual(errors(c.issues), []);
});

test("pins: a fixed section stays in its block, a pinned student gets that section, a pinned teacher is kept", () => {
  const ctx = context();
  const input = synthetic({ courses: SCIENCE, choose: 2, students: 100, capacity: 30, seed: 8 });
  const physics = `물리학#1`;
  const student = input.students.find((item) => item.courses.includes("물리학"));
  const chemistryStudent = input.students.find((item) => item.courses.includes("화학"));
  input.pins = { sections: { [physics]: "b" }, students: { [student.key]: [physics], [chemistryStudent.key]: ["화학#1"] } };
  input.teachers = [{ id: "p1", name: "물리A", departments: ["물리"] }, { id: "p2", name: "물리B", departments: ["물리"] },
    { id: "c1", name: "화학A", departments: ["화학"] }, { id: "c2", name: "화학B", departments: ["화학"] },
    { id: "b1", name: "생명A", departments: ["생명"] }, { id: "b2", name: "생명B", departments: ["생명"] },
    { id: "e1", name: "지구A", departments: ["지구"] }, { id: "e2", name: "지구B", departments: ["지구"] }];
  input.pins.teachers = { [physics]: "p2" };
  const result = plain(ctx.classSectionsSolve(input));
  const section = result.sections.find((item) => item.id === physics);
  assert.equal(section.blockId, "b");
  assert.ok(result.assign[student.key].includes(physics));
  assert.ok(result.assign[chemistryStudent.key].includes("화학#1"));
  assert.equal(result.teacherOf[physics], "p2");
  assert.equal(section.teacherId, "p2");
  assert.deepEqual(errors(result.issues), []);
});

test("partial recompute keeps unchanged students and the block placement; only changed students move", () => {
  const ctx = context();
  const input = synthetic({ courses: EIGHT, choose: 3, students: 200, capacity: 30, sizeFor: 26, seed: 21 });
  const first = plain(ctx.classSectionsSolve(input));
  assert.equal(first.unassigned.length, 0);
  const next = plain(input);
  const changed = next.students.slice(0, 4);
  for (const student of changed) {
    const missing = EIGHT.map((course) => course.name).find((name) => !student.courses.includes(name));
    student.courses = [student.courses[0], student.courses[1], missing];
  }
  next.students.push({ key: "1-1-99", homeroom: "1", courses: ["물리학", "화학", "세계사"] });
  const changedKeys = ctx.classSectionsChangedStudents(input.students, next.students);
  assert.deepEqual(plain(changedKeys).sort(), [...changed.map((student) => student.key), "1-1-99"].sort());
  const second = plain(ctx.classSectionsSolve({ ...next, partial: true, changedStudents: changedKeys,
    previous: { sections: first.sections.map((section) => ({ id: section.id, blockId: section.blockId })), assign: first.assign } }));
  for (const section of first.sections) assert.equal(second.sections.find((item) => item.id === section.id).blockId, section.blockId);
  const changedSet = new Set(changedKeys);
  for (const student of next.students) {
    if (changedSet.has(student.key)) continue;
    assert.deepEqual(second.assign[student.key], first.assign[student.key], `${student.key} kept`);
  }
  for (const key of changedKeys) assert.equal(second.assign[key].length, 3, `${key} placed`);
  assert.deepEqual(errors(second.issues).filter((issue) => issue.type !== "over-capacity"), []);
  assert.ok(second.metrics.moved <= changed.length * 3);
  // 입력 서명: 학생 과목이 바뀌면 달라지고, 화면용 라벨만 바뀌면 같다
  assert.notEqual(ctx.classSectionsSignature(input), ctx.classSectionsSignature(next));
  assert.equal(ctx.classSectionsSignature(input), ctx.classSectionsSignature({ ...input, label: "다른 이름" }));
});

test("teacher unavailable time limits the block and the teacher is not assigned there", () => {
  const ctx = context();
  const input = synthetic({ courses: SCIENCE, choose: 2, students: 100, capacity: 30, sizeFor: 25, seed: 4 });
  input.blocks = [{ id: "a", times: [{ day: "월", period: 1 }, { day: "수", period: 2 }] }, { id: "b", times: [{ day: "화", period: 3 }, { day: "목", period: 4 }] }];
  input.teachers = [
    { id: "p1", name: "물리A", departments: ["물리"] }, { id: "p2", name: "물리B", departments: ["물리"], unavailable: [{ day: "월", period: 1, reason: "육아시간" }] },
    { id: "c1", name: "화학A", departments: ["화학"] }, { id: "c2", name: "화학B", departments: ["화학"] }, { id: "c3", name: "화학C", courses: ["화학"] },
    { id: "b1", name: "생명A", departments: ["생명"] }, { id: "b2", name: "생명B", departments: ["생명"] }, { id: "b3", name: "생명C", departments: ["생명"] },
    { id: "e1", name: "지구A", departments: ["지구"] }, { id: "e2", name: "지구B", departments: ["지구"] }, { id: "e3", name: "지구C", departments: ["지구"] }];
  const result = plain(ctx.classSectionsSolve(input));
  assert.equal(result.unassigned.length, 0, result.explain.summary);
  const physicsInA = result.sections.filter((section) => section.courseKey === "물리학" && section.blockId === "a");
  assert.ok(physicsInA.length <= 1, "only one physics teacher free in block a");
  for (const section of physicsInA) assert.equal(result.teacherOf[section.id], "p1");
  for (const section of result.sections.filter((item) => item.courseKey === "물리학" && item.blockId === "b")) assert.ok(result.teacherOf[section.id]);
  assert.deepEqual(errors(result.issues), []);
  assert.ok(!result.issues.some((issue) => issue.type === "no-times"));
  // 블록 시간이 없으면 교사 시간 점검은 건너뛰고 안내
  const untimed = plain(ctx.classSectionsSolve({ ...input, blocks: 2 }));
  assert.ok(untimed.issues.some((issue) => issue.type === "no-times" && issue.severity === "info"));
});

test("solveAll: teachers shared by grade 2 and grade 3 blocks at the same time are not double-booked", () => {
  const ctx = context();
  const g2 = synthetic({ courses: SCIENCE, choose: 2, students: 100, capacity: 30, sizeFor: 27, seed: 31, grade: 1 });
  g2.groupId = "1:1:2-1"; g2.label = "2학년 1학기";
  g2.blocks = [{ id: "a", times: ["월1", "수2"] }, { id: "b", times: ["화3", "목4"] }];
  const g3 = synthetic({ courses: SCIENCE, choose: 3, students: 60, capacity: 30, sizeFor: 27, seed: 32, grade: 2 });
  g3.groupId = "1:2:3-1"; g3.label = "3학년 1학기";
  g3.blocks = [{ id: "a", times: ["월1", "수2"] }, { id: "b", times: ["화3", "목4"] }, { id: "c", times: ["금1", "금2"] }];
  const teachers = [
    { id: "p1", name: "물리A", departments: ["물리"] }, { id: "p2", name: "물리B", departments: ["물리"] },
    { id: "c1", name: "화학A", departments: ["화학"] }, { id: "c2", name: "화학B", departments: ["화학"] },
    { id: "b1", name: "생명A", departments: ["생명"] }, { id: "b2", name: "생명B", departments: ["생명"] },
    { id: "p3", name: "물리C", departments: ["물리"] }, { id: "c3", name: "화학C", departments: ["화학"] }, { id: "b3", name: "생명C", departments: ["생명"] },
    { id: "e1", name: "지구A", departments: ["지구"] }, { id: "e2", name: "지구B", departments: ["지구"], unavailable: [{ day: "금", period: 1, reason: "순회" }] },
    { id: "e3", name: "지구C", departments: ["지구"] }];
  const fixedSlots = [{ label: "창체", times: ["금6", "금7"], teacherIds: teachers.map((teacher) => teacher.id) }];
  const all = plain(ctx.classSectionsSolveAll({ groups: [g3, g2], teachers, fixedSlots, seed: 3 }));
  assert.equal(all.groups.length, 2);
  for (const group of all.groups) assert.equal(group.result.unassigned.length, 0, group.label);
  assert.deepEqual(all.issues.filter((issue) => issue.severity === "error"), []);
  // 같은 시각에 한 교사가 두 분반을 맡지 않는다(직접 다시 확인)
  const busy = new Map();
  for (const group of all.groups) {
    const blocks = new Map(group.result.blocks.map((block) => [block.id, block]));
    for (const section of group.result.sections) {
      const teacher = group.result.teacherOf[section.id];
      assert.equal(all.teacherOf[`${group.groupId}::${section.id}`], teacher);
      assert.ok(teacher, `${group.label} ${section.id} has a teacher`);
      for (const slot of blocks.get(section.blockId).times) {
        const key = `${teacher}|${slot}`;
        assert.ok(!busy.has(key), `${key} double`);
        busy.set(key, section.id);
      }
      if (teacher === "e2") assert.ok(!blocks.get(section.blockId).times.includes("금:1"));
    }
  }
  // 학년 간 겹침 검사기는 일부러 겹친 배정을 잡는다
  const forged = plain(all.groups);
  const s2 = forged[0].result.sections.find((section) => section.blockId === "a");
  const s3 = forged[1].result.sections.find((section) => section.blockId === "a");
  forged[0].result.teacherOf = { [s2.id]: "p1" };
  forged[1].result.teacherOf = { [s3.id]: "p1" };
  const cross = plain(ctx.classSectionsValidateAcross(forged.map((group) => ({ input: { groupId: group.groupId, label: group.label }, result: group.result })), teachers));
  assert.ok(cross.some((issue) => issue.type === "teacher-cross"));
});

test("infeasible: structural cause is explained and the 35-person suggestion is verified", () => {
  const ctx = context();
  // 과목 하나가 분반 정원 합보다 많다 → 구조적 원인
  const over = synthetic({ courses: SCIENCE.map((course) => ({ ...course, sections: 1 })), choose: 2, students: 70, capacity: 34, seed: 2 });
  const result = plain(ctx.classSectionsSolve(over));
  assert.ok(result.unassigned.length > 0);
  assert.ok(result.explain.causes.some((cause) => cause.type === "course-capacity"));
  // 정원 34로는 몇 명이 넘치고 35면 되는 경우(분반 수는 35명 기준으로 정함): 제안대로 올리면 같은 배치에서 모두 배정된다
  const tight = ctx.classSectionsFromCombos(comboSynthetic({ subjects: EIGHT.map((course) => course.name), choose: 3, students: 338, comboCount: 30, seed: 5, capacity: 35, maxSectionsPerBlock: 11 }));
  tight.defaultCapacity = 34;
  const first = plain(ctx.classSectionsSolve(tight));
  assert.ok(first.unassigned.length > 0, "34 is too tight for this synthetic group");
  assert.match(first.explain.summary, /정원 34명·블록당 최대 11개로는/);
  const suggestion = first.explain.suggestions.find((item) => item.type === "capacity");
  assert.ok(suggestion, JSON.stringify(first.explain));
  assert.equal(suggestion.verified, true);
  assert.match(suggestion.message, /35명.*올리면 모두 배정됩니다/);
  for (const item of suggestion.sections) assert.ok(item.to > item.from && item.to <= 36);
  const capacities = Object.fromEntries(suggestion.sections.map((item) => [item.sectionId, item.to]));
  const verified = plain(ctx.classSectionsSolve({ ...tight, capacities, suggest: false }, suggestion.source === "same-placement" ? first.placement : undefined));
  if (suggestion.source === "same-placement") assert.equal(verified.unassigned.length, 0, verified.explain.summary);
});

test("too many courses, closed courses and unknown courses are reported, not silently dropped", () => {
  const ctx = context();
  const input = synthetic({ courses: SCIENCE, choose: 2, students: 40, capacity: 30, seed: 9 });
  input.courses.find((course) => course.key === "지구과학").sections = 0;
  input.students.push({ key: "1-9-50", homeroom: "9", courses: ["물리학", "화학", "생명과학"] });
  input.students.push({ key: "1-9-51", homeroom: "9", courses: ["물리학", "없는과목"] });
  const result = plain(ctx.classSectionsSolve(input));
  const reasons = new Set(result.unassigned.map((item) => item.reason));
  assert.ok(reasons.has("too-many"));
  if (input.students.some((student) => student.courses.includes("지구과학"))) assert.ok(reasons.has("closed"));
  assert.ok(result.issues.some((issue) => issue.type === "unknown-course"));
  assert.ok(result.explain.causes.some((cause) => cause.type === "too-many"));
  assert.ok(result.assign["1-9-50"].length === 2);
});

test("compare modes: metrics for each mode, homeroom mode groups classmates more, a recommendation with a reason", () => {
  const ctx = context();
  const input = synthetic({ courses: EIGHT, choose: 3, students: 240, capacity: 30, sizeFor: 25, seed: 14, homerooms: 8 });
  const compared = plain(ctx.classSectionsCompare(input));
  assert.deepEqual(compared.rows.map((row) => row.mode), ["move", "homeroom", "balance"]);
  const row = (mode) => compared.rows.find((item) => item.mode === mode);
  for (const item of compared.rows) assert.equal(item.unassigned, 0);
  assert.ok(row("homeroom").sameHomeroomRatio >= row("move").sameHomeroomRatio);
  assert.ok(row("balance").maxSpread <= row("homeroom").maxSpread);
  assert.ok(["move", "homeroom", "balance"].includes(compared.recommended));
  assert.ok(compared.reason.length > 10);
  // 세 방식은 같은 블록 배치를 쓴다(학생 배정만 다름)
  assert.deepEqual(compared.results.homeroom.placement, compared.results.move.placement);
});

test("class-unit courses: homerooms are split by section counts and by wishes when given", () => {
  const ctx = context();
  const homerooms = Array.from({ length: 11 }, (_, i) => ({ id: String(i + 1), size: 28 }));
  const plainSplit = plain(ctx.classSectionsClassUnitSplit({ courses: [{ key: "일본어", sections: 8 }, { key: "정보", sections: 3 }], homerooms }));
  assert.equal(plainSplit.ratio, "8:3");
  assert.equal(Object.values(plainSplit.assign).filter((value) => value === "일본어").length, 8);
  assert.equal(plainSplit.assign["9"], "정보");
  const students = [];
  for (const room of homerooms) for (let k = 0; k < 20; k += 1) students.push({ key: `1-${room.id}-${k + 1}`, courses: [["2", "5", "7"].includes(room.id) ? "정보" : "일본어"] });
  const wished = plain(ctx.classSectionsClassUnitSplit({ courses: [{ key: "일본어", sections: 8 }, { key: "정보", sections: 3 }], homerooms, students }));
  assert.equal(wished.assign["2"], "정보");
  assert.equal(wished.assign["5"], "정보");
  assert.equal(wished.assign["7"], "정보");
  assert.equal(wished.mismatched, 0);
  // 학급 단위 과목은 이동 블록 계산에서 빠진다
  const input = synthetic({ courses: SCIENCE.map((course) => ({ ...course, sections: 2 })), choose: 2, students: 40, capacity: 30, seed: 3 });
  input.courses.push({ key: "정보", name: "정보", mode: "class", sections: 2 });
  input.students[0].courses.push("정보");
  const result = plain(ctx.classSectionsSolve(input));
  assert.equal(result.blocks.length, 2);
  assert.ok(!result.sections.some((section) => section.courseKey === "정보"));
  assert.equal(result.unassigned.length, 0);
});

test("NEIS rows: header, room name rule (block letter + name without spaces + number only when the block has several)", () => {
  const ctx = context();
  assert.equal(ctx.classSectionsRoomName("a", "사회와 문화", 1, 2), "a사회와문화1");
  assert.equal(ctx.classSectionsRoomName("c", "지구과학", 1, 1), "c지구과학");
  const input = synthetic({ courses: EIGHT, choose: 3, students: 120, capacity: 30, sizeFor: 20, seed: 6 });
  const result = plain(ctx.classSectionsSolve(input));
  const rows = plain(ctx.classSectionsNeisRows(result, { year: 2027, semester: 1, targetGrade: 2,
    courses: Object.fromEntries(input.courses.map((course) => [course.key, { family: "사회(역사/도덕포함)", credits: 3 }])),
    students: [{ key: input.students[0].key, classroom: "3", number: 12, name: "" }] }));
  assert.deepEqual(rows[1], ["학년도", "학기", "학년", "편제명", "개설과목(학점)", "개설강의실", "계열/학년/학과", "반", "번호", "성명"]);
  assert.equal(rows.length, 2 + input.students.length * 3);
  const mine = rows.filter((row, index) => index >= 2 && row[7] === "3반");
  assert.equal(mine.length, 3);
  for (const row of rows.slice(2)) {
    assert.match(row[5], /^[a-c][^\s]+$/);
    assert.match(row[4], /\(3\)$/);
    assert.equal(row[6], "2학년");
  }
  const multi = result.sections.find((section) => section.countInBlock > 1);
  if (multi) assert.match(multi.roomName, /\d$/);
  const single = result.sections.find((section) => section.countInBlock === 1);
  if (single) assert.doesNotMatch(single.roomName, /\d$/);
});

test("min cost flow and the worker source run the same solver", () => {
  const ctx = context();
  const flow = plain(ctx.classSectionsMinCostFlow(4, [[0, 1, 2, 0], [0, 2, 2, 0], [1, 3, 2, 1], [2, 3, 1, 5], [1, 2, 1, 0]], 0, 3));
  assert.equal(flow.flow, 3);
  assert.equal(flow.cost, 2 + 5);
  const input = synthetic({ courses: SCIENCE, choose: 2, students: 50, capacity: 30, seed: 12 });
  const posted = [];
  const workerCtx = vm.createContext({ performance, self: { postMessage: (message) => posted.push(message) } });
  vm.runInContext(ctx.classSectionsWorkerSource(), workerCtx);
  workerCtx.self.onmessage({ data: { id: 7, kind: "solve", input } });
  assert.equal(posted[0].id, 7);
  assert.equal(posted[0].ok, true);
  const direct = plain(ctx.classSectionsSolve(input));
  const viaWorker = plain(posted[0].value);
  delete direct.elapsedMs; delete viaWorker.elapsedMs;
  assert.deepEqual(viaWorker, direct);
});

test("combos input (subjects, choose, combos) runs the block placement directly", () => {
  const ctx = context();
  const input = ctx.classSectionsFromCombos({ subjects: ["A", "B", "C", "D"], choose: 2, capacity: 30,
    combos: { "A|B": 40, "C|D": 40, "A|C": 20, "B|D": 20 }, maxSectionsPerBlock: 4 });
  assert.equal(input.students.length, 120);
  assert.deepEqual(plain(input.courses.map((course) => course.sections)), [2, 2, 2, 2]);
  const result = plain(ctx.classSectionsSolve(input));
  assert.equal(result.unassigned.length, 0);
  assert.equal(result.blocks.length, 2);
  assert.equal(result.metrics.blockSections.reduce((sum, value) => sum + value, 0), 8);
  for (const count of result.metrics.blockSections) assert.ok(count <= 4);
});

// 성능: 실제 규모와 비슷한 합성 자료(학생·조합 수만 비슷, 실제 자료 아님).
function comboSynthetic({ subjects, choose, students, comboCount, seed, capacity, maxSectionsPerBlock }) {
  const random = rng(seed);
  const weights = subjects.map(() => 0.3 + random() * 1.5);
  const combos = new Map();
  while (combos.size < comboCount) {
    const pool = subjects.map((_, i) => i);
    const pick = [];
    while (pick.length < choose) {
      const total = pool.reduce((sum, i) => sum + weights[i], 0);
      let x = random() * total;
      for (let k = 0; k < pool.length; k += 1) { x -= weights[pool[k]]; if (x <= 0 || k === pool.length - 1) { pick.push(pool[k]); pool.splice(k, 1); break; } }
    }
    combos.set(pick.sort((a, b) => a - b).map((i) => subjects[i]).join("|"), 0);
  }
  const keys = [...combos.keys()];
  const cw = keys.map((_, i) => 1 / Math.pow(i + 1, 0.9));
  const total = cw.reduce((sum, value) => sum + value, 0);
  for (let s = 0; s < students; s += 1) {
    let x = random() * total;
    for (let i = 0; i < keys.length; i += 1) { x -= cw[i]; if (x <= 0 || i === keys.length - 1) { combos.set(keys[i], combos.get(keys[i]) + 1); break; } }
  }
  for (const key of keys) if (!combos.get(key)) combos.delete(key);
  return { subjects, choose, combos: Object.fromEntries(combos), capacity, maxSectionsPerBlock, homerooms: 11, seed: 1 };
}

test("performance: a 338-student choose-3 group (blocks of 11) and a 308-student choose-5 group finish in seconds", () => {
  const ctx = context();
  const g21 = ctx.classSectionsFromCombos(comboSynthetic({ subjects: EIGHT.map((course) => course.name), choose: 3, students: 338, comboCount: 30, seed: 5, capacity: 35, maxSectionsPerBlock: 11 }));
  let started = Date.now();
  const r21 = plain(ctx.classSectionsSolve(g21));
  const t21 = Date.now() - started;
  assert.equal(r21.unassigned.length, 0, r21.explain.summary);
  assert.deepEqual(errors(r21.issues), []);
  assert.ok(t21 < 8000, `2-1 took ${t21}ms`);
  const subjects = "ABCDEFGHIJKLMNOP".split("").map((letter) => `과목${letter}`);
  const g31 = ctx.classSectionsFromCombos(comboSynthetic({ subjects, choose: 5, students: 308, comboCount: 127, seed: 9, capacity: 35, maxSectionsPerBlock: 11 }));
  started = Date.now();
  const r31 = plain(ctx.classSectionsSolve(g31));
  const t31 = Date.now() - started;
  assert.equal(r31.unassigned.length, 0, r31.explain.summary);
  assert.deepEqual(errors(r31.issues), []);
  assert.ok(t31 < 15000, `3-1 took ${t31}ms`);
});
