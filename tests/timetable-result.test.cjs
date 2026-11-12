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

test("시간표가 정한 블록 자리를 6단계에 적어 넣기: 다른 블록만, 입력 칸·결과 블록 시간·서명을 함께, 분반·배정은 그대로", () => {
  const entries = {
    "1:1:2-1 택2": { blockTimes: { a: "월1,화2,수3", b: "" }, sectionResult: { signature: "sig:월1,화2,수3|", assign: { "1-1-1": ["물리학#1"] },
      blocks: [{ id: "a", letter: "a", times: ["월:1", "화:2", "수:3"], sectionIds: ["물리학#1"] }, { id: "b", letter: "b", times: [], sectionIds: ["화학#1"] }] } },
    "1:2:2-2 택2": { blockTimes: {}, sectionResult: { signature: "예전 서명", blocks: [{ id: "a", letter: "a", times: ["목:5", "금:1"], sectionIds: [] }] } }
  };
  const persisted = [];
  const ctx = vm.createContext({
    state: { currentRound: "1", timetable: { 1: { at: "2026-11-12T00:00:00Z", signature: "x", result: { metrics: {}, layers: {
      1: { lessons: {}, creative: [], blocks: { "1:1:2-1 택2|a": { slots: ["수3", "월1", "화2"] }, "1:1:2-1 택2|b": { slots: ["목4", "월2", "금1"] }, "없는 그룹|a": { slots: ["월1"] } } },
      2: { lessons: {}, creative: [], blocks: { "1:2:2-2 택2|a": { slots: ["금1", "화5"] } } } } } } } },
    classSectionsEntry: (round, key) => entries[key] || null,
    classSectionsSource: () => ({ groups: [{ key: "1:1:2-1 택2" }, { key: "1:2:2-2 택2" }] }),
    classSectionsBuildInput: (round, group, entry) => ({ times: `${entry.blockTimes.a || ""}|${entry.blockTimes.b || ""}` }),
    classSectionsSignature: (input) => `sig:${input.times}`,
    persistStateSoon: () => persisted.push(1)
  });
  for (const file of ["timetable.js", "timetable-solve.js", "timetable-view.js"]) vm.runInContext(read(file), ctx);
  // 순서만 다른 a블록은 같은 것으로 보고, 비어 있던 b블록과 2학기 a블록만 다르다
  assert.deepEqual(plain(ctx.timetableBlockTimeChanges("1")), [
    { semester: "1", groupKey: "1:1:2-1 택2", letter: "b", before: "", after: "월2,목4,금1" },
    { semester: "2", groupKey: "1:2:2-2 택2", letter: "a", before: "목5,금1", after: "화5,금1" }]);
  assert.equal(ctx.timetableWriteBlockTimes("1"), 2);
  assert.deepEqual([entries["1:1:2-1 택2"].blockTimes, plain(entries["1:1:2-1 택2"].sectionResult.blocks.map((block) => block.times))], [{ a: "월1,화2,수3", b: "월2,목4,금1" }, [["월:1", "화:2", "수:3"], ["월:2", "목:4", "금:1"]]]);
  // 적기 전에 최신이던 결과는 서명을 새로 맞추고(6단계가 '입력 변경됨'이 되지 않음), 이미 어긋나 있던 결과의 서명은 건드리지 않는다
  assert.equal(entries["1:1:2-1 택2"].sectionResult.signature, "sig:월1,화2,수3|월2,목4,금1");
  assert.deepEqual([entries["1:2:2-2 택2"].blockTimes, plain(entries["1:2:2-2 택2"].sectionResult.blocks[0].times), entries["1:2:2-2 택2"].sectionResult.signature], [{ a: "화5,금1" }, ["화:5", "금:1"], "예전 서명"]);
  // 분반·배정은 그대로, 저장 예약, 다시 보면 다른 블록 없음
  assert.deepEqual(plain(entries["1:1:2-1 택2"].sectionResult.assign), { "1-1-1": ["물리학#1"] });
  assert.equal(persisted.length, 1);
  assert.deepEqual(plain(ctx.timetableBlockTimeChanges("1")), []);
  assert.equal(ctx.timetableWriteBlockTimes("1"), 0);
});

test("엑셀 시트: 학기마다 학급별·교사별 전체 표(요일 × 교시/실제 시각) + 못 지킨 조건 + 담당 교사 없음", () => {
  const ctx = context();
  const input = tiny();
  const result = plain(ctx.timetableSolve({ 1: input }, { seed: 1, iterations: 8000, rounds: 2 }));
  const sheets = plain(ctx.timetableResultSheets({ 1: input }, result, { title: "2027학년도 2차", rules: { gap: "공강" }, reasons: { none: "맡을 수 있는 교사가 명단에 없음" } }));
  assert.deepEqual(sheets.map((sheet) => sheet.name), ["1학기 학급", "1학기 교사", "못 지킨 조건", "담당 교사 없음"]);
  const [classes, teachers, , none] = sheets;
  // 학급 표: 제목, 요일(교시 수만큼 병합), 교시 번호, 반마다 한 줄(월·화 × 5교시 = 10칸)
  assert.equal(classes.rows[0][0].v, "2027학년도 2차 1학기 학급별 시간표");
  assert.deepEqual([classes.rows[1].map((cell) => cell.v), classes.rows[2].map((cell) => cell.v)], [["반", "월", "", "", "", "", "화", "", "", "", ""], ["", 1, 2, 3, 4, 5, 1, 2, 3, 4, 5]]);
  assert.deepEqual([classes.merges, classes.freeze, classes.rows.slice(3).map((row) => row[0].v)], [["A1:K1", "A2:A3", "B2:F2", "G2:K2"], "B4", ["1-1", "1-2", "3-1"]]);
  assert.ok(classes.rows.every((row, index) => index === 0 || row.length === 11));
  const first = classes.rows[3];
  assert.equal(first[1].v, "창체");
  const filled = first.slice(1).filter((cell) => cell.v);
  assert.equal(filled.length, 8);
  assert.deepEqual(filled.filter((cell) => /^음악/.test(cell.v)).map((cell) => [cell.v, cell.s]), [["음악\n담당 교사 없음", 9]]);
  assert.equal(filled.filter((cell) => cell.v === "국어\n김국어" && cell.s === 4).length, 3);
  // 교사 표: 교사·시수 + 요일 × 실제 시각 6칸(4교시는 학년마다 다른 칸)
  assert.deepEqual(teachers.rows[2].map((cell) => cell.v), ["", "", "1", "2", "3", "4(1)", "4(3)", "5", "1", "2", "3", "4(1)", "4(3)", "5"]);
  assert.deepEqual([teachers.merges, teachers.freeze], [["A1:N1", "A2:A3", "B2:B3", "C2:H2", "I2:N2"], "C4"]);
  const kim = teachers.rows.find((row) => row[0].v === "김국어");
  assert.deepEqual([kim[1].v, kim.slice(2).filter((cell) => cell.v).length], [8, 8]);
  assert.ok(kim.slice(2).filter((cell) => cell.v).every((cell) => /^(국어\n1-[12]|화법\n3-1)$/.test(cell.v)));
  // 담당 교사 없음: 음악 2반 × 1시간
  assert.deepEqual(none.rows.slice(1).map((row) => row.map((cell) => cell.v)), [["1학기", "1", "음악", "1-1", 1, "맡을 수 있는 교사가 명단에 없음"], ["1학기", "1", "음악", "1-2", 1, "맡을 수 있는 교사가 명단에 없음"]]);
});

test("직접 고치기: 반 시간표의 두 칸 맞바꾸기 — 절대 조건에 걸리면 이유와 함께 거절, 되면 위반 목록을 다시 센다", () => {
  const ctx = context();
  const input = tiny();
  const inputs = { 1: input };
  const result = plain(ctx.timetableSolve(inputs, { seed: 1, iterations: 8000, rounds: 2 }));
  const layer = result.layers["1"];
  const cells = (res, classId) => plain(ctx.timetableResultTables(input, res.layers["1"])).classes.find((row) => row.id === classId).cells;
  const before = cells(result, "1-1");
  const slotOf = (table, test) => Object.keys(table).filter((key) => test(table[key][0]));
  // 창체·블록 칸은 반 하나만 옮길 수 없다
  const lessonSlot = slotOf(before, (cell) => cell.kind === "lesson")[0];
  assert.deepEqual(plain(ctx.timetableEditSwap(inputs, result, { semester: "1", classId: "1-1", a: "월1", b: lessonSlot })), { ok: false, reason: "월1은 창체(학년 전체가 함께 듣는 시간)이라 반 하나만 옮길 수 없습니다." });
  const blockSlot = layer.blocks["3a"].slots[0];
  const thirdLesson = slotOf(cells(result, "3-1"), (cell) => cell.kind === "lesson")[0];
  assert.match(ctx.timetableEditSwap(inputs, result, { semester: "1", classId: "3-1", a: blockSlot, b: thirdLesson }).reason, /3학년 a블록\(학년 전체가 함께 듣는 시간\)이라 반 하나만 옮길 수 없습니다/);
  // 같은 칸·없는 칸·빈칸끼리
  assert.equal(ctx.timetableEditSwap(inputs, result, { semester: "1", classId: "1-1", a: "월2", b: "월2" }).reason, "같은 칸입니다.");
  assert.equal(ctx.timetableEditSwap(inputs, result, { semester: "1", classId: "1-1", a: "월2", b: "토1" }).reason, "이 반의 시간표에 없는 칸입니다.");
  const empties = ["월", "화"].flatMap((day) => [1, 2, 3, 4, 5].map((period) => `${day}${period}`)).filter((key) => !before[key]);
  assert.equal(empties.length, 2);
  assert.equal(ctx.timetableEditSwap(inputs, result, { semester: "1", classId: "1-1", a: empties[0], b: empties[1] }).reason, "두 칸 모두 비어 있습니다.");
  // 교사가 그 시간에 다른 반에 있으면 거절(이유 = 검증기의 문장)
  const kimOther = slotOf(cells(result, "1-2"), (cell) => cell.teacher === "김국어")[0]; // 김국어가 1-2반에 있는 칸
  const mine = before[kimOther];
  const kimMine = slotOf(before, (cell) => cell.teacher === "김국어").find((key) => key !== kimOther);
  if (!mine || mine[0].teacher !== "김국어") {
    const refused = plain(ctx.timetableEditSwap(inputs, result, { semester: "1", classId: "1-1", a: kimMine, b: kimOther }));
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /김국어 교사 .*겹칩니다/);
  }
  // 음악(담당 교사 없음)과 빈칸을 맞바꾸면 된다: 칸이 옮겨지고, 위반 목록·수가 검증기와 같아진다
  const music = slotOf(before, (cell) => cell.text === "음악")[0];
  const done = plain(ctx.timetableEditSwap(inputs, result, { semester: "1", classId: "1-1", a: music, b: empties[0] }));
  assert.deepEqual([done.ok, done.text, done.result.edits], [true, `1-1반 ${music} 음악 ↔ ${empties[0]} 빈칸`, 1]);
  const after = cells(done.result, "1-1");
  assert.deepEqual([after[music], after[empties[0]].map((cell) => [cell.text, cell.noTeacher])], [undefined, [["음악", true]]]);
  const check = plain(ctx.timetableValidate(inputs, done.result));
  assert.equal(check.ok, true);
  assert.deepEqual([done.result.metrics.gap, done.result.metrics.oncePerDay, done.result.metrics.hard], [check.counts.gap, check.counts.oncePerDay, check.violations.filter((item) => item.level === "hard").reduce((sum, item) => sum + item.amount, 0)]);
  assert.deepEqual(done.result.violations.filter((item) => item.rule === "gap"), check.violations.filter((item) => item.rule === "gap"));
  // 원래 결과는 그대로(되돌리기용), 한 번 더 고치면 횟수가 는다
  assert.deepEqual(cells(result, "1-1"), before);
  assert.equal(plain(ctx.timetableEditSwap(inputs, done.result, { semester: "1", classId: "1-1", a: empties[0], b: music })).result.edits, 2);
  // 검증기의 위반 목록은 풀이기 결과와 같은 수
  const counted = plain(ctx.timetableValidate(inputs, result));
  for (const rule of ["gap", "oncePerDay", "run", "maxPerDay", "lunch"]) assert.equal(counted.violations.filter((item) => item.rule === rule).reduce((sum, item) => sum + item.amount, 0), result.metrics[rule], rule);
});

test("직접 고치기(두 학기 뼈대): 한 학기에서 옮긴 수업은 다른 학기의 짝도 묶음 표시를 풀고 '벗어난 칸'으로 센다", () => {
  const ctx = context();
  const inputs = { 1: tiny(), 2: Object.assign(tiny(), { semester: "2" }) };
  const result = plain(ctx.timetableSolve(inputs, { seed: 1, iterations: 8000, rounds: 2 }));
  assert.equal(result.metrics.frame, true);
  const table = plain(ctx.timetableResultTables(inputs[1], result.layers["1"])).classes.find((row) => row.id === "1-1").cells;
  const music = Object.keys(table).find((key) => table[key][0].text === "음악");
  const empty = ["월", "화"].flatMap((day) => [1, 2, 3, 4, 5].map((period) => `${day}${period}`)).find((key) => !table[key]);
  assert.equal(result.layers["1"].lessons["1음악@1-1"].frame, true);
  // 이미 만든 모형을 넘겨도 같다(화면은 칸마다 살필 때 모형을 한 번만 만든다)
  const models = { 1: ctx.timetableModel(inputs[1]), 2: ctx.timetableModel(inputs[2]) };
  const done = plain(ctx.timetableEditSwap(models, result, { semester: "1", classId: "1-1", a: music, b: empty }));
  assert.equal(done.ok, true);
  assert.deepEqual([done.result.layers["1"].lessons["1음악@1-1"].frame, done.result.layers["2"].lessons["1음악@1-1"].frame, done.result.metrics.frameBroken], [undefined, undefined, 1]);
  assert.deepEqual([done.result.layers["1"].lessons["1음악@1-1"].slots, done.result.layers["2"].lessons["1음악@1-1"].slots], [[empty], [music]]);
  assert.equal(done.result.layers["1"].lessons["1국어@1-1"].frame, true, "다른 수업의 묶음은 그대로");
  assert.equal(plain(ctx.timetableValidate(inputs, done.result)).ok, true);
});
