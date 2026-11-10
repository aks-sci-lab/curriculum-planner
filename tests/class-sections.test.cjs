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
  // 폐강 과목 신청은 미배정이 아니라 재신청 대상으로 따로 센다
  assert.ok(!reasons.has("closed"));
  if (input.students.some((student) => student.courses.includes("지구과학"))) {
    assert.ok(result.closedRequests.length > 0);
    assert.match(result.explain.summary, /재신청 대상 \d+명\(폐강 과목 \d+건\)/);
  }
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
  for (const item of compared.rows) assert.equal(item.moved, null, "no earlier result → nothing to compare");
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
  const exported = plain(ctx.classSectionsNeisExport(result, { year: 2027, semester: 1, targetGrade: 2,
    courses: Object.fromEntries(input.courses.map((course) => [course.key, { family: "사회(역사/도덕포함)", credits: 3 }])),
    students: [{ key: input.students[0].key, classroom: "3", number: 12, name: "" }] }));
  const rows = exported.rows;
  assert.deepEqual(rows[1], ["학년도", "학기", "학년", "편제명", "개설과목(학점)", "개설강의실", "계열/학년/학과", "반", "번호", "성명", "참고: 현 학년-반-번호"]);
  assert.equal(rows.length, 2 + input.students.length * 3);
  const mine = rows.filter((row, index) => index >= 2 && row[7] === "3반");
  assert.equal(mine.length, 3);
  for (const row of mine) assert.equal(row[8], "12");
  for (const row of rows.slice(2)) {
    assert.match(row[5], /^[a-c][^\s]+$/);
    assert.match(row[4], /\(3\)$/);
    assert.equal(row[6], "2학년");
  }
  // 내년 반이 없는 학생은 반·번호를 비우고 참고 열에 현 학년-반-번호, 경고 문구
  const other = rows.find((row, index) => index >= 2 && row[10] === input.students[1].key);
  assert.equal(other[7], "");
  assert.equal(other[8], "");
  assert.ok(exported.warnings.some((text) => /내년 반·번호가 없는 학생/.test(text)));
  assert.equal(plain(ctx.classSectionsNeisRows(result, { reference: false }))[1].length, 10);
  // 번호 규칙: 어느 블록에서든 2개 이상이면 그 과목 모든 분반에 번호, 한 번도 없으면 번호 없음
  const byCourse = new Map();
  for (const section of result.sections) { if (!byCourse.has(section.courseKey)) byCourse.set(section.courseKey, []); byCourse.get(section.courseKey).push(section); }
  for (const list of byCourse.values()) {
    const multi = list.some((section) => section.countInBlock > 1);
    for (const section of list) {
      if (multi) assert.match(section.roomName, /\d$/, section.roomName);
      else assert.doesNotMatch(section.roomName, /\d$/, section.roomName);
    }
  }
  // 내년 반 배정표(고정 양식)
  const mapped = plain(ctx.classSectionsClassMapFromRows([["현 학년", "현 반", "현 번호", "새 반", "새 번호"], ["1", "3반", "12", "5", "7"], ["1", "", "3", "", ""]]));
  assert.deepEqual(mapped.map, { "1-3-12": { classroom: "5", number: "7" } });
  assert.equal(mapped.errors.length, 1);
});

test("room numbers follow teachers when every section has one (same teacher = same number, e.g. physics a1 a2 b2 c1)", () => {
  const ctx = context();
  const result = {
    blocks: [{ id: "a" }, { id: "b" }, { id: "c" }],
    sections: [
      { id: "p1", courseKey: "물리학", courseName: "물리학", ord: 1, blockId: "a", blockLetter: "a", noInBlock: 1, teacherId: "T1" },
      { id: "p2", courseKey: "물리학", courseName: "물리학", ord: 2, blockId: "a", blockLetter: "a", noInBlock: 2, teacherId: "T2" },
      { id: "p3", courseKey: "물리학", courseName: "물리학", ord: 3, blockId: "b", blockLetter: "b", noInBlock: 1, teacherId: "T2" },
      { id: "p4", courseKey: "물리학", courseName: "물리학", ord: 4, blockId: "c", blockLetter: "c", noInBlock: 1, teacherId: "T1" },
      { id: "w1", courseKey: "세계사", courseName: "세계사", ord: 1, blockId: "a", blockLetter: "a", noInBlock: 1, teacherId: "H1" },
      { id: "w2", courseKey: "세계사", courseName: "세계사", ord: 2, blockId: "b", blockLetter: "b", noInBlock: 1, teacherId: "H1" }
    ]
  };
  ctx.classSectionsAssignRoomNames(result);
  assert.deepEqual(result.sections.map((section) => section.roomName), ["a물리학1", "a물리학2", "b물리학2", "c물리학1", "a세계사", "b세계사"]);
  // 교사가 비면 블록 안 순번
  result.sections[2].teacherId = "";
  ctx.classSectionsAssignRoomNames(result);
  assert.deepEqual(result.sections.slice(0, 4).map((section) => section.roomName), ["a물리학1", "a물리학2", "b물리학1", "c물리학1"]);
});

test("more sections than blocks × limit: not feasible, cause shown, and a verified 'raise capacity to cut sections' suggestion", () => {
  const ctx = context();
  let input = null;
  for (let seed = 5; seed < 20 && !input; seed += 1) {
    const candidate = ctx.classSectionsFromCombos(comboSynthetic({ subjects: EIGHT.map((course) => course.name), choose: 3, students: 338, comboCount: 30, seed, capacity: 34, maxSectionsPerBlock: 11 }));
    if (candidate.courses.reduce((sum, course) => sum + course.sections, 0) === 34) input = candidate;
  }
  assert.ok(input, "a synthetic group with 34 sections > 33 slots");
  const result = plain(ctx.classSectionsSolve(input));
  assert.equal(result.explain.feasible, false);
  assert.match(result.explain.summary, /블록 한도 초과: 분반 34개 > 블록 3개/);
  assert.ok(result.issues.some((issue) => issue.type === "block-over" && issue.severity === "error"));
  assert.ok(result.explain.causes.some((cause) => cause.type === "block-limit"));
  const fewer = result.explain.suggestions.find((item) => item.type === "sections");
  assert.ok(fewer, JSON.stringify(result.explain.suggestions));
  assert.equal(fewer.verified, true);
  assert.match(fewer.message, /정원 3[56]명\(분반 \d+→\d+개\)/);
  const changed = new Map(fewer.courses.map((item) => [item.courseKey, item]));
  const applied = plain(ctx.classSectionsSolve({ ...input, suggest: false, courses: input.courses.map((course) => changed.has(course.key)
    ? { ...course, sections: changed.get(course.key).toSections, capacity: changed.get(course.key).capacity } : course) }));
  assert.equal(applied.explain.feasible, true, applied.explain.summary);
  assert.ok(applied.metrics.blockSections.every((count) => count <= 11));
  assert.ok(result.explain.suggestions.some((item) => item.type === "block-limit" && item.maxSectionsPerBlock === 12));
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

test("teacher assignment: swap search (augmenting path) never does worse than plain greedy and fixes some cases", () => {
  const ctx = context();
  const random = rng(77);
  let better = 0;
  for (let trial = 0; trial < 60; trial += 1) {
    const teachers = Array.from({ length: 4 }, (_, i) => ({ id: `T${i}`, name: `T${i}`, departments: ["A", "B", "C"].filter(() => random() < 0.5) }));
    const sections = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, courseKey: "x", courseName: "x", department: ["A", "B", "C"][Math.floor(random() * 3)],
      credits: 3, blockKey: `g:${"abc"[Math.floor(random() * 3)]}`, times: [] }));
    const count = (depth) => Object.keys(ctx.classSectionsAssignTeachers({ teachers, sections, depth }).teacherOf).length;
    const plainCount = count(0);
    const swapped = count(3);
    assert.ok(swapped >= plainCount, `trial ${trial}`);
    if (swapped > plainCount) better += 1;
    // 결과는 늘 유효: 같은 블록에 한 교사 두 분반 없음, 자격 있음
    const result = ctx.classSectionsAssignTeachers({ teachers, sections, depth: 3 });
    const seen = new Set();
    for (const [sectionId, teacherId] of Object.entries(result.teacherOf)) {
      const section = sections.find((item) => item.id === sectionId);
      assert.ok(teachers.find((teacher) => teacher.id === teacherId).departments.includes(section.department));
      const key = `${teacherId}|${section.blockKey}`;
      assert.ok(!seen.has(key));
      seen.add(key);
    }
  }
  assert.ok(better > 0, "the swap search helps in at least one random case");
});

test("solveAll tries several group orders, keeps results reproducible, and explains teacher shortages by subject and time", () => {
  const ctx = context();
  const make = (grade, seed, choose, students) => {
    const input = synthetic({ courses: SCIENCE, choose, students, capacity: 30, sizeFor: 27, seed, grade });
    input.groupId = `1:${grade}:g`; input.label = `${grade + 1}학년 1학기`;
    input.blocks = Array.from({ length: choose }, (_, i) => ({ id: "abc"[i], times: [["월1", "수2"], ["화3", "목4"], ["금1", "금2"]][i] }));
    return input;
  };
  const g2 = make(1, 41, 2, 100);
  const g3 = make(2, 42, 3, 60);
  const teachers = [];
  for (const [dept, n] of [["물리", 3], ["화학", 3], ["생명", 3], ["지구", 2]]) for (let k = 1; k <= n; k += 1) teachers.push({ id: `${dept}${k}`, name: `${dept}${k}`, departments: [dept] });
  teachers[0].unavailable = [{ day: "월", period: 1, reason: "육아시간" }];
  const spec = { groups: [g2, g3], teachers, fixedSlots: [{ label: "창체", times: ["금6", "금7"], teacherIds: teachers.map((t) => t.id) }], seed: 5 };
  const noTime = (value) => JSON.parse(JSON.stringify(value, (key, item) => (key === "elapsedMs" ? undefined : item)));
  const first = noTime(ctx.classSectionsSolveAll(spec));
  const second = noTime(ctx.classSectionsSolveAll(spec));
  assert.deepEqual(first, second, "same seed → same result");
  assert.ok(first.orders.length >= 2, "several orders tried");
  assert.equal(first.groups.map((group) => group.groupId).join(), "1:1:g,1:2:g", "results come back in input order");
  const best = first.orders.find((order) => order.label === first.chosenOrder);
  for (const order of first.orders) {
    const [a, b, c] = order.score;
    assert.ok(best.score[0] < a || (best.score[0] === a && (best.score[1] < b || (best.score[1] === b && best.score[2] <= c))), "chosen order is the best");
  }
  // 교사를 줄이면 '어느 교과가 어느 시간에 몇 명 모자람'
  const few = { ...spec, teachers: teachers.filter((teacher) => teacher.departments[0] !== "지구" || teacher.id === "지구1") };
  const short = plain(ctx.classSectionsSolveAll(few));
  const shortage = short.shortages.find((item) => item.department === "지구");
  if (short.issues.some((issue) => issue.type === "teacher-missing")) {
    assert.ok(shortage, JSON.stringify(short.issues.slice(0, 3)));
    assert.match(shortage.message, /^지구: .요일 \d교시 분반 \d+개\(.+\) > 가능한 교사 1명 → \d+명 모자람$/);
  }
});

test("block time recommendation: no clash within a grade, fixed slots kept free, spread over days, teacher limits across grades", () => {
  const ctx = context();
  const teachers = [];
  for (let k = 1; k <= 4; k += 1) teachers.push({ id: `p${k}`, departments: ["물리"], unavailable: k === 1 ? [{ day: "월", period: 1 }] : [] });
  for (let k = 1; k <= 3; k += 1) teachers.push({ id: `c${k}`, departments: ["화학"] });
  const spec = {
    days: ["월", "화", "수", "목", "금"], periods: 7, seed: 3, teachers, reserve: { "2": 10, "3": 6 },
    fixedSlots: [{ label: "창체·진로", times: ["금6", "금7"], teacherIds: teachers.map((t) => t.id) }],
    groups: [
      { groupId: "g2", label: "2학년 1학기 택3", grade: "2", blocks: "abc".split("").map((id) => ({ id, hours: 3, departments: { 물리: 2, 화학: 2 } })) },
      { groupId: "g3", label: "3학년 1학기 택5", grade: "3", blocks: "abcde".split("").map((id) => ({ id, hours: 3, departments: { 물리: 2, 화학: 1 } })) }
    ]
  };
  const result = plain(ctx.classSectionsRecommendTimes(spec));
  assert.deepEqual(result, (() => { const again = plain(ctx.classSectionsRecommendTimes(spec)); return { ...again, elapsedMs: result.elapsedMs }; })(), "reproducible");
  assert.deepEqual(result.shortages, []);
  assert.deepEqual(result.issues.filter((issue) => issue.severity === "error"), []);
  const demand = new Map();
  for (const group of result.groups) {
    const grade = spec.groups.find((item) => item.groupId === group.groupId).grade;
    const used = new Set();
    for (const block of group.blocks) {
      assert.equal(block.times.length, 3);
      assert.equal(new Set(block.times.map((time) => time.day)).size, 3, "a block meets on three different days");
      for (const time of block.times) {
        const slot = `${time.day}:${time.period}`;
        assert.ok(!["금:6", "금:7"].includes(slot), "fixed creative slots stay free");
        assert.ok(!used.has(slot), `${grade}학년 ${slot} clash`);
        used.add(slot);
        const departments = spec.groups.find((item) => item.groupId === group.groupId).blocks.find((item) => item.id === block.id).departments;
        for (const [dept, n] of Object.entries(departments)) demand.set(`${dept}|${slot}`, (demand.get(`${dept}|${slot}`) || 0) + n);
      }
    }
  }
  for (const [key, count] of demand) {
    const [dept, slot] = key.split("|");
    const limit = dept === "물리" ? (slot === "월:1" ? 3 : 4) : 3;
    assert.ok(count <= limit, `${key} ${count} > ${limit}`);
  }
  assert.equal(result.free["2"], 33 - 9);
  // 교사가 모자라면 시각·교과별로 설명
  const tight = plain(ctx.classSectionsRecommendTimes({ ...spec, teachers: teachers.filter((t) => t.id !== "c2" && t.id !== "c3") }));
  assert.ok(tight.shortages.length > 0);
  assert.match(tight.shortages[0].message, /^화학: .요일 \d교시 분반 \d개 > 가능한 교사 1명 → \d명 모자람$/);
});

test("regression: synthetic real-size groups keep their section totals and block sizes at 35 (32·33·52·53-type checks)", () => {
  const ctx = context();
  const cases = [
    { subjects: EIGHT.map((course) => course.name), choose: 3, students: 338, comboCount: 30, seed: 5, total: 33 },
    { subjects: ["확률과 통계", "법과 사회", "윤리와 사상", "국제 관계의 이해", "역학과 에너지", "화학 반응의 세계", "생물의 유전"], choose: 3, students: 338, comboCount: 18, seed: 6, total: 32 },
    { subjects: "ABCDEFGHIJKLMNOP".split("").map((letter) => `과목${letter}`), choose: 5, students: 308, comboCount: 127, seed: 9, total: 52 },
    { subjects: "ABCDEFGHIJKLMNO".split("").map((letter) => `교과${letter}`), choose: 5, students: 308, comboCount: 108, seed: 10, total: 53 }
  ];
  for (const item of cases) {
    const input = ctx.classSectionsFromCombos(comboSynthetic({ ...item, capacity: 35, maxSectionsPerBlock: 11 }));
    const total = input.courses.reduce((sum, course) => sum + course.sections, 0);
    assert.equal(total, item.total, "synthetic section total (35명 기준)");
    const result = plain(ctx.classSectionsSolve(input));
    assert.equal(result.unassigned.length, 0, `${item.seed}: ${result.explain.summary}`);
    assert.equal(result.metrics.blockSections.reduce((sum, value) => sum + value, 0), total);
    assert.ok(result.metrics.blockSections.every((value) => value <= 11));
    assert.equal(result.explain.feasible, true);
  }
});

test("compare: a mode can be shown but kept out of the recommendation (homeroom grouping without next-year classes)", () => {
  const ctx = context();
  const input = synthetic({ courses: EIGHT, choose: 3, students: 240, capacity: 30, sizeFor: 25, seed: 14, homerooms: 8 });
  const compared = plain(ctx.classSectionsCompare({ ...input, recommendExclude: ["homeroom"] }));
  assert.equal(compared.rows.find((row) => row.mode === "homeroom").excluded, true);
  assert.notEqual(compared.recommended, "homeroom");
});

test("6차·7차 계산: 서명에서 다른 학년 점유 제외, 학생 키 정규화, 학급 단위 반 번호, 같은 학생 그룹 시간 겹침, 폐강 신청 분리, 교사 부족 제안", () => {
  const ctx = context();
  const input = synthetic({ courses: SCIENCE, choose: 2, students: 60, capacity: 30, sizeFor: 25, seed: 7 });
  // 서명: occupied는 사용자 입력이 아니므로 빠진다
  assert.equal(ctx.classSectionsSignature(input), ctx.classSectionsSignature({ ...input, occupied: [{ times: ["월1"], departments: { 물리: 2 } }] }));
  // 학생 키·배정표 정규화('01반'·'3번'·앞 0)
  assert.equal(ctx.classSectionsStudentKey("1", "01반", "03번"), "1-1-3");
  const mapped = plain(ctx.classSectionsClassMapFromRows([["현 학년", "현 반", "현 번호", "새 반", "새 번호"], ["1학년", "01반", "07", "02반", "05번"]]));
  assert.deepEqual(mapped.map, { "1-1-7": { classroom: "2", number: "5" } });
  // 나이스 학급 단위 행: 새 반 '01'도 1반으로, 과목이 없는 반은 경고
  const neis = plain(ctx.classSectionsNeisExport({ sections: [], assign: {} }, { targetGrade: 3, reference: false,
    students: [{ key: "2-1-1", classroom: "01", number: "1" }, { key: "2-1-2", classroom: "12", number: "2" }],
    classUnit: { byClass: { "1": "일본어" }, courses: { 일본어: { name: "일본어", credits: 2 } } } }));
  assert.equal(neis.rows.length, 3);
  assert.equal(neis.rows[2][5], "1(3학년 1반)");
  assert.ok(neis.warnings.some((text) => /내년 12반에 정한 과목이 없어 1명분/.test(text)));
  // 같은 현 학년·학기 그룹끼리 블록 시간 겹침
  const one = { ...input, blocks: [{ id: "a", times: ["월1", "수1"] }, { id: "b", times: ["화1", "목1"] }], cohortTimes: [{ label: "2-2 택1 a블록", times: ["수1"] }] };
  const clash = plain(ctx.classSectionsSolve(one));
  assert.ok(clash.issues.some((issue) => issue.type === "cohort-clash" && /2-2 택1 a블록/.test(issue.message)));
  assert.equal(clash.explain.feasible, false);
  assert.match(clash.explain.summary, /^학생은 모두 배정했지만 확인 필요/);
  const across = plain(ctx.classSectionsValidateAcross([
    { input: { groupId: "g1", label: "2-2 택3", grade: 1, semester: 2 }, result: { blocks: [{ id: "a", letter: "a", times: ["월:1"] }], sections: [] } },
    { input: { groupId: "g2", label: "2-2 택1", grade: 1, semester: 2 }, result: { blocks: [{ id: "a", letter: "a", times: ["월:1"] }], sections: [] } },
    { input: { groupId: "g3", label: "3-2 택5", grade: 2, semester: 2 }, result: { blocks: [{ id: "a", letter: "a", times: ["월:1"] }], sections: [] } }], []));
  assert.equal(across.filter((issue) => issue.type === "cohort-clash").length, 1, "only the same-grade pair clashes");
  // 폐강 과목 신청은 재신청 대상으로 따로(편성 가능 여부·미배정에 넣지 않음)
  const closed = { ...input, courses: [...input.courses, { key: "천문학", name: "천문학", sections: 0 }] };
  closed.students = input.students.map((student, index) => (index < 5 ? { ...student, courses: [...student.courses.slice(0, 1), "천문학"] } : student));
  const closedResult = plain(ctx.classSectionsSolve(closed));
  assert.equal(closedResult.unassigned.length, 0);
  assert.equal(closedResult.closedRequests.length, 5);
  assert.equal(closedResult.explain.feasible, true);
  assert.match(closedResult.explain.summary, /재신청 대상 5명\(폐강 과목 5건\)/);
  // 교사 부족: 블록 늘리기(다시 풀어 확인)·교사 수 확인 안내
  const short = { ...input, courses: input.courses.map((course) => (course.key === "물리학" ? { ...course, sections: 3 } : course)), departmentTeachers: { 물리: 1 } };
  const shortResult = plain(ctx.classSectionsSolve(short));
  assert.ok(shortResult.issues.some((issue) => ["teacher-count", "placement-forced"].includes(issue.type)));
  assert.equal(shortResult.explain.feasible, false);
  const types = shortResult.explain.suggestions.map((item) => item.type);
  assert.ok(types.includes("more-blocks"), JSON.stringify(shortResult.explain.suggestions));
  assert.equal(shortResult.explain.suggestions.find((item) => item.type === "more-blocks").verified, true);
  assert.ok(types.includes("check-teachers"));
  assert.match(shortResult.explain.suggestions.find((item) => item.type === "check-teachers").message, /물리 교사가 그 시간에 모자랍니다/);
});

test("real-scale teacher shortages are actually solved by a verified suggestion (수학 11 > 10, 제2외국어 11 > 2, 지리 교사 2)", () => {
  const ctx = context();
  const random = rng(31);
  void random;
  // 과목별 인원을 정해 둔다(분반 정원 34 안): names[k]를 counts[k]명이 신청.
  const studentsOf = (names, counts, count, grade) => Array.from({ length: count }, (_, i) => {
    let pick = 0;
    for (let acc = counts[0]; i >= acc && pick < names.length - 1; acc += counts[pick + 1]) pick += 1;
    return { key: `${grade}-${1 + (i % 11)}-${1 + Math.floor(i / 11)}`, courses: [names[pick]] };
  });
  const verifiedFix = (input) => {
    const result = plain(ctx.classSectionsSolve(input));
    assert.equal(result.explain.feasible, false, "the shortage is detected");
    const fixes = result.explain.suggestions.filter((item) => item.verified && ["more-blocks", "class-unit"].includes(item.type));
    assert.ok(fixes.length, JSON.stringify(result.explain.suggestions.map((item) => item.message)));
    assert.ok(result.explain.suggestions.some((item) => item.type === "check-teachers"));
    return fixes;
  };
  // 2-2 택1 한 블록: 확률과 통계 6 + 기하 5 = 수학 11분반 > 교사 10명 → 블록 2개면 해결
  const math = { blocks: 1, maxSectionsPerBlock: 11, defaultCapacity: 34, departmentTeachers: { 수학: 10 }, seed: 1,
    courses: [{ key: "확률과 통계", sections: 6, department: "수학" }, { key: "기하", sections: 5, department: "수학" }],
    students: studentsOf(["확률과 통계", "기하"], [200, 170], 370, 1) };
  assert.ok(verifiedFix(math).some((item) => item.type === "more-blocks"));
  // 3-1 택1: 일본어 6 + 중국어 5 = 제2외국어 11 > 교사 2명 → 둘 다 학급 단위로
  const lang = { blocks: 1, maxSectionsPerBlock: 11, defaultCapacity: 34, departmentTeachers: { 제2외국어: 2 }, seed: 1,
    courses: [{ key: "일본어", sections: 6, department: "제2외국어" }, { key: "중국어", sections: 5, department: "제2외국어" }],
    students: studentsOf(["일본어", "중국어"], [190, 150], 330, 2) };
  const langFix = verifiedFix(lang).find((item) => item.type === "class-unit");
  assert.deepEqual(plain(langFix.courseKeys).sort(), ["일본어", "중국어"]);
  // 택3 그룹: 세계지리 4분반이 지리 교사 2명보다 많이 한 블록에 몰리지 않게 — 블록 시간이 같은 다른 학년이 지리 교사 1명을 쓰고 있음
  const geo = synthetic({ courses: [{ name: "세계지리", department: "지리", sections: 4 }, { name: "물리학", department: "물리" }, { name: "화학", department: "화학" }, { name: "생명과학", department: "생명" }],
    choose: 2, students: 140, capacity: 30, sizeFor: 26, seed: 12 });
  geo.blocks = [{ id: "a", times: ["월1"] }, { id: "b", times: ["화1"] }];
  geo.departmentTeachers = { 지리: 2 };
  geo.occupied = [{ label: "3학년 a블록", times: ["월1"], departments: { 지리: 1 } }, { label: "3학년 b블록", times: ["화1"], departments: { 지리: 1 } }];
  verifiedFix(geo);
});

test("partial recompute keeps existing room names; only new sections get the next free number, forced renames are listed", () => {
  const ctx = context();
  const input = synthetic({ courses: EIGHT, choose: 3, students: 240, capacity: 30, sizeFor: 27, seed: 21 });
  const first = plain(ctx.classSectionsSolve(input));
  assert.equal(first.unassigned.length, 0);
  const next = plain(input);
  for (let k = 0; k < 3; k += 1) next.students.push({ key: `1-9-${90 + k}`, homeroom: "9", courses: ["물리학", "화학", "세계사"] });
  const physics = next.courses.find((course) => course.key === "물리학");
  physics.sections += 1;
  const roomNames = Object.fromEntries(first.sections.map((section) => [section.id, section.roomName]));
  const second = plain(ctx.classSectionsSolve({ ...next, partial: true, roomNames,
    changedStudents: ctx.classSectionsChangedStudents(input.students, next.students),
    previous: { sections: first.sections.map((section) => ({ id: section.id, blockId: section.blockId })), assign: first.assign } }));
  const renamed = new Set((second.roomRenames || []).map((item) => item.sectionId));
  for (const section of first.sections) {
    const now = second.sections.find((item) => item.id === section.id);
    if (!renamed.has(section.id)) assert.equal(now.roomName, section.roomName, `${section.id} keeps ${section.roomName}`);
  }
  const added = second.sections.find((section) => section.id === `물리학#${physics.sections}`);
  assert.ok(added && added.roomName);
  const names = second.sections.map((section) => section.roomName);
  assert.equal(new Set(names).size, names.length, "room names stay unique");
  for (const item of second.roomRenames || []) {
    assert.equal(item.reason, "numbered");
    assert.match(item.to, /\d$/);
    assert.doesNotMatch(item.from, /\d$/);
  }
  if ((second.roomRenames || []).length) assert.ok(second.issues.some((issue) => issue.type === "room-renamed"));
  // 직접: 번호 없던 과목에 같은 블록 분반이 생기면 기존 분반에 1, 새 분반에 2
  const result = { blocks: [{ id: "a" }], sections: [
    { id: "s#1", courseKey: "세계사", courseName: "세계사", ord: 1, blockId: "a", blockLetter: "a", noInBlock: 1 },
    { id: "s#2", courseKey: "세계사", courseName: "세계사", ord: 2, blockId: "a", blockLetter: "a", noInBlock: 2 }] };
  ctx.classSectionsAssignRoomNames(result, ["a"], new Map([["s#1", "a세계사"]]));
  assert.deepEqual(result.sections.map((section) => section.roomName), ["a세계사1", "a세계사2"]);
  assert.deepEqual(plain(result.roomRenames), [{ sectionId: "s#1", from: "a세계사", to: "a세계사1", reason: "numbered" }]);
  // 교사 순번 규칙과 충돌해도 기존 이름 유지
  const teacherResult = { blocks: [{ id: "a" }, { id: "b" }], sections: [
    { id: "p#1", courseKey: "물리학", courseName: "물리학", ord: 1, blockId: "a", blockLetter: "a", noInBlock: 1, teacherId: "T2" },
    { id: "p#2", courseKey: "물리학", courseName: "물리학", ord: 2, blockId: "a", blockLetter: "a", noInBlock: 2, teacherId: "T1" },
    { id: "p#3", courseKey: "물리학", courseName: "물리학", ord: 3, blockId: "b", blockLetter: "b", noInBlock: 1, teacherId: "T1" }] };
  ctx.classSectionsAssignRoomNames(teacherResult, ["a", "b"], new Map([["p#1", "a물리학2"], ["p#2", "a물리학1"], ["p#3", "b물리학1"]]));
  assert.deepEqual(teacherResult.sections.map((section) => section.roomName), ["a물리학2", "a물리학1", "b물리학1"]);
});

test("[치명 회귀] 택1 한 과목만 학급 단위로: 그 반 학생은 이동 분반에서 빠져 이중 배정 0, 제안은 반 배분과 이동 반이 함께 성립할 때만 확인됨", () => {
  const ctx = context();
  // 내년 11반 × 31명, 택1: 인공지능 기초(정보) 4반분 · 프로그래밍(정보) 3분반 · 일본어(제2외국어) 4분반, 정보 교사 2명 → 정보 7분반이 한 블록에 몰려 부족
  const students = [];
  for (let room = 1; room <= 11; room += 1) for (let n = 1; n <= 31; n += 1) {
    const pick = room <= 4 ? (n <= 26 ? "인공지능 기초" : "일본어") : room <= 7 ? (n <= 20 ? "프로그래밍" : "일본어") : (n <= 6 ? "프로그래밍" : "일본어");
    students.push({ key: `2-${room}-${n}`, homeroom: String(room), courses: [pick] });
  }
  const count = (name) => students.filter((student) => student.courses[0] === name).length;
  assert.deepEqual([count("인공지능 기초"), count("프로그래밍"), count("일본어")], [104, 84, 153]);
  const input = { blocks: 1, choose: 1, homeroomCount: 11, maxSectionsPerBlock: 11, defaultCapacity: 35, seed: 1, departmentTeachers: { 정보: 2, 제2외국어: 6 },
    courses: [{ key: "인공지능 기초", sections: 3, department: "정보" }, { key: "프로그래밍", sections: 3, department: "정보" },
      { key: "일본어", sections: 5, department: "제2외국어" }], students };
  const before = plain(ctx.classSectionsSolve(input));
  assert.equal(before.explain.feasible, false, "정보 교사 부족");
  const fix = before.explain.suggestions.find((item) => item.type === "class-unit" && item.verified);
  assert.ok(fix, JSON.stringify(before.explain.suggestions.map((item) => item.message)));
  assert.match(fix.message, /희망과 다른 학생 \d+명\(\d+%\)/);
  assert.match(fix.message, /\d+개 반 전원이 그 과목(, 나머지 \d+개 반은 이동)?\)/);
  assert.doesNotMatch(fix.message, /을\(를\)/, "조사 자동 처리");
  // 제안 적용(화면과 같은 순서): 반 배분(남는 반은 이동) → 학생 이동 과목 → 풀기
  const unitKeys = fix.courseKeys;
  const split = plain(ctx.classSectionsClassUnitSplit({ allowMove: true, homerooms: Array.from({ length: 11 }, (_, i) => ({ id: String(i + 1) })),
    courses: input.courses.filter((course) => unitKeys.includes(course.key)).map((course) => ({ key: course.key, sections: course.sections })), students }));
  assert.ok(Object.values(split.assign).some((value) => value === ""), "남는 반은 이동");
  const moved = plain(ctx.classSectionsClassUnitStudents({ students, choose: 1, unitKeys, byClass: split.assign }));
  const after = plain(ctx.classSectionsSolve({ ...input, courses: input.courses.map((course) => (unitKeys.includes(course.key) ? { ...course, mode: "class" } : course)),
    students: moved.students, classUnit: { choose: 1, unitOf: moved.unitOf } }));
  let doubles = 0;
  for (const student of students) {
    const total = (after.assign[student.key] || []).length + (moved.unitOf[student.key] ? 1 : 0);
    if (total > 1) doubles += 1;
  }
  assert.equal(doubles, 0, "한 그룹에서 2과목 이상 배정된 학생 없음");
  assert.ok(!after.issues.some((issue) => issue.type === "choice-over"));
  // 남은 미배정은 '이동 반이라 학급 단위 과목을 못 듣는' 학생뿐(재신청 필요, 화면 미배정 표에 사유와 함께)
  assert.ok(after.unassigned.every((item) => item.reason === "class-unit-other-room"), JSON.stringify(after.unassigned.slice(0, 3)));
  assert.equal(new Set(after.unassigned.map((item) => item.studentKey)).size, fix.retake || 0);
  assert.ok(!after.issues.some((issue) => issue.severity === "error" && !["unassigned"].includes(issue.type)));
  // 검증기는 이중 배정을 오류로 잡는다
  const forged = plain(after);
  const unitStudent = Object.keys(moved.unitOf).find((key) => moved.unitOf[key]);
  forged.assign[unitStudent] = [after.sections[0].id];
  const issues = plain(ctx.classSectionsValidate({ ...input, students: moved.students, classUnit: { choose: 1, unitOf: moved.unitOf } }, forged));
  assert.ok(issues.some((issue) => issue.type === "choice-over" && issue.severity === "error"));
  assert.equal(ctx.classSectionsJosa("정보", "을/를"), "정보를");
  assert.equal(ctx.classSectionsJosa("인공지능 기초", "을/를"), "인공지능 기초를");
  assert.equal(ctx.classSectionsJosa("일본어·중국어", "을/를"), "일본어·중국어를");
  assert.equal(ctx.classSectionsJosa("물리학", "을/를"), "물리학을");
});
