// 7단계 시간표 계산 결과 도우미(timetable-view.js 위쪽 순수 함수): 입력 서명·여러 답 중 고르기·일꾼 설정·반 표와 교사 표. 모든 자료는 합성이다.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function context() {
  const ctx = vm.createContext({});
  for (const file of ["timetable.js", "timetable-solve.js", "timetable-view.js"]) vm.runInContext(read(file), ctx);
  return ctx;
}

// 아주 작은 학교: 1학년 2반(점심 4교시 뒤)·3학년 1반(점심 3교시 뒤), 월·화 5교시, 전교 창체 월1, 3학년 블록 2시간.
function tiny() {
  return {
    semester: "1", days: "월,화", periods: 5, lunchAfter: { 1: 4, 3: 3 },
    grades: [{ grade: "1", classes: 2 }, { grade: "3", classes: 1 }],
    creative: { school: 1, schoolTimes: ["월1"] },
    teachers: [{ id: "k1", name: "김국어", departments: ["국어"] }, { id: "m1", name: "박수학", departments: ["수학"] }, { id: "s1", name: "최선택", departments: ["선택"] }, { id: "s2", name: "정선택", departments: ["선택"] }],
    lessons: [
      { id: "1국어", grade: "1", subject: "국어", department: "국어", hours: 3 }, { id: "1수학", grade: "1", subject: "수학", department: "수학", hours: 3 },
      { id: "1음악", grade: "1", subject: "음악", department: "음악", hours: 1 }, // 맡을 교사가 명단에 없음
      { id: "3국어", grade: "3", subject: "화법", department: "국어", hours: 2 }, { id: "3수학", grade: "3", subject: "확통", department: "수학", hours: 2 }
    ],
    blocks: [{ id: "3a", grade: "3", label: "3학년 a블록", sections: [{ id: "3a-1", subject: "선택 가", department: "선택", credits: 2 }, { id: "3a-2", subject: "선택 나", department: "선택", credits: 2 }] }],
    rules: {}
  };
}

test("입력 서명: 같은 입력은 같고, 한 글자만 달라도 다르다", () => {
  const ctx = context();
  const a = ctx.timetableSignature({ 1: tiny() });
  const changed = tiny();
  changed.lessons[0].hours = 4;
  assert.equal(a, ctx.timetableSignature({ 1: tiny() }));
  assert.notEqual(a, ctx.timetableSignature({ 1: changed }));
  assert.match(a, /^\d+\.[0-9a-z]+\.[0-9a-z]+$/);
});

test("여러 답 중 고르기: 못 넣은 시간 → '반드시' 위반 → 담당 교사 없음 → 비용 → 씨앗 순, 실패한 일꾼은 건너뜀", () => {
  const ctx = context();
  const answer = (seed, unplacedHours, hard, noTeacherHours, cost) => ({ seed, layers: {}, metrics: { unplacedHours, hard, noTeacherHours, cost } });
  const pick = (list) => ctx.timetableBestResult(list)?.seed;
  assert.equal(pick([answer(1, 0, 3, 0, 10), answer(2, 0, 2, 9, 999), answer(3, 1, 0, 0, 1)]), 2);
  assert.equal(pick([answer(1, 0, 2, 5, 10), answer(2, 0, 2, 4, 999)]), 2);
  assert.equal(pick([answer(4, 0, 0, 0, 30), answer(2, 0, 0, 0, 30), { failed: true }, null]), 2);
  assert.equal(ctx.timetableBestResult([{ failed: true }, null]), null);
});

test("일꾼 설정: 씨앗을 달리하고 세 번째마다 한 번 길게 식히는 것(흔들기 없음)을 섞는다", () => {
  const ctx = context();
  assert.deepEqual(plain(ctx.timetableWorkerPlans(4, 7)), [{ seed: 7 }, { seed: 8 }, { seed: 9, rounds: 0, long: true }, { seed: 10 }]);
  assert.deepEqual(plain(ctx.timetableWorkerPlans(0)), [{ seed: 1 }]);
});

test("결과 표: 반 표(점심 줄·블록·창체·담당 교사 없음)와 교사 표(실제 시각 줄, 시수 = 칸 수)", () => {
  const ctx = context();
  const input = tiny();
  const result = plain(ctx.timetableSolve({ 1: input }, { seed: 1, iterations: 8000, rounds: 2 }));
  assert.equal(plain(ctx.timetableValidate({ 1: input }, result)).ok, true);
  const tables = plain(ctx.timetableResultTables(input, result.layers["1"]));
  assert.deepEqual(tables.days, ["월", "화"]);
  assert.deepEqual(tables.classes.map((row) => row.id), ["1-1", "1-2", "3-1"]);
  // 점심 줄: 1학년은 4교시 뒤, 3학년은 3교시 뒤
  const lunchAt = (id) => tables.classes.find((row) => row.id === id).rows.findIndex((row) => row.lunch);
  assert.deepEqual([lunchAt("1-1"), lunchAt("3-1")], [4, 3]);
  // 반마다 시수만큼 칸이 차고, 한 칸에 하나씩
  const filled = (row) => Object.values(row.cells).reduce((sum, list) => sum + list.length, 0);
  assert.deepEqual(tables.classes.map(filled), [8, 8, 7]);
  assert.ok(tables.classes.every((row) => Object.values(row.cells).every((list) => list.length === 1)));
  const first = tables.classes[0];
  assert.deepEqual(first.cells["월1"], [{ kind: "creative", text: "창체", teacher: "", noTeacher: false }]);
  const all = (row) => Object.values(row.cells).flat();
  assert.deepEqual(all(first).filter((cell) => cell.text === "음악"), [{ kind: "lesson", text: "음악", teacher: "", noTeacher: true }]);
  assert.equal(all(first).filter((cell) => cell.text === "국어" && cell.teacher === "김국어" && !cell.noTeacher).length, 3);
  assert.equal(all(tables.classes[2]).filter((cell) => cell.kind === "block" && cell.text === "3학년 a블록").length, 2);
  // 교사 표: 실제 시각 줄(1·2·3교시는 함께, 4교시는 학년마다 다른 시각, 5교시는 함께)
  assert.deepEqual(tables.teacherRows.map((row) => row.label), ["1교시", "2교시", "3교시", "4교시(1학년)", "4교시(3학년)", "5교시"]);
  const kim = tables.teachers.find((row) => row.id === "k1");
  assert.deepEqual([kim.name, kim.hours, Object.values(kim.cells).flat().length], ["김국어", 8, 8]);
  assert.ok(Object.values(kim.cells).every((list) => list.length === 1), "교사는 한 시각에 한 수업");
  assert.deepEqual(Object.values(kim.cells).flat().map((cell) => cell.where).sort(), ["1-1", "1-1", "1-1", "1-2", "1-2", "1-2", "3-1", "3-1"]);
  // 블록 분반 교사 둘: 한 사람이 한 분반씩, 블록 이름으로 두 시간
  const sections = ["s1", "s2"].map((id) => Object.values(tables.teachers.find((row) => row.id === id).cells).flat().map((cell) => `${cell.text}@${cell.where}`));
  assert.deepEqual(sections.map((list) => [list.length, new Set(list).size]), [[2, 1], [2, 1]]);
  assert.deepEqual(sections.map((list) => list[0]).sort(), ["선택 가@3학년 a블록", "선택 나@3학년 a블록"]);
  assert.equal(tables.teachers.some((row) => row.id === "음악"), false);
  // 결과가 없는 학기는 빈 표
  assert.deepEqual(plain(ctx.timetableResultTables(input, null)).teachers, []);
});
