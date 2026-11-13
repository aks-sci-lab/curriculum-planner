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
  // 창체 칸은 옮길 수 없다(블록 칸은 아래 '블록 한 시간 옮기기')
  const lessonSlot = slotOf(before, (cell) => cell.kind === "lesson")[0];
  assert.deepEqual(plain(ctx.timetableEditSwap(inputs, result, { semester: "1", classId: "1-1", a: "월1", b: lessonSlot })), { ok: false, reason: "월1은 창체 시간이라 옮길 수 없습니다(창체 시간은 조건 설정에서 정합니다)." });
  const blockSlot = layer.blocks["3a"].slots[0];
  assert.equal(ctx.timetableEditSwap(inputs, result, { semester: "1", classId: "3-1", a: blockSlot, b: "월1" }).reason, "월1은 창체 시간이라 옮길 수 없습니다(창체 시간은 조건 설정에서 정합니다).");
  assert.equal(ctx.timetableEditSwap(inputs, result, { semester: "1", classId: "3-1", a: blockSlot, b: layer.blocks["3a"].slots[1] }).reason, "같은 블록의 두 시간입니다.");
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

test("직접 고치기: 블록 한 시간 옮기기 — 그 블록을 듣는 모든 반에서 함께, 옮겨 갈 칸의 반 수업은 블록 자리로, 같은 반들의 다른 블록과는 맞바꿈", () => {
  const ctx = context();
  // 3학년 2반: a·b블록(2시간씩) + 반 수업 2과목, 월·화 5교시. 1학년은 없음(교사 겹침을 단순하게)
  const input = { semester: "1", days: "월,화", periods: 5, grades: [{ grade: "3", classes: 2 }],
    teachers: [{ id: "k1", name: "김국어", departments: ["국어"] }, { id: "m1", name: "박수학", departments: ["수학"] }, { id: "s1", name: "최선택", departments: ["선택"] }, { id: "s2", name: "정선택", departments: ["선택"] }],
    lessons: [{ id: "3국어", grade: "3", subject: "화법", department: "국어", hours: 2 }, { id: "3수학", grade: "3", subject: "확통", department: "수학", hours: 2 }],
    blocks: [{ id: "3a", grade: "3", label: "a블록", sections: [{ id: "3a-1", subject: "선택 가", department: "선택", credits: 2 }, { id: "3a-2", subject: "선택 나", department: "선택", credits: 2 }] },
      { id: "3b", grade: "3", label: "b블록", sections: [{ id: "3b-1", subject: "선택 다", department: "선택", credits: 2 }, { id: "3b-2", subject: "선택 라", department: "선택", credits: 2 }] }],
    rules: {} };
  const inputs = { 1: input };
  const result = plain(ctx.timetableSolve(inputs, { seed: 1, iterations: 8000, rounds: 2 }));
  assert.equal(plain(ctx.timetableValidate(inputs, result)).ok, true);
  const layer = result.layers["1"];
  const keys = ["월", "화"].flatMap((day) => [1, 2, 3, 4, 5].map((period) => `${day}${period}`));
  const cellsOf = (res, classId) => plain(ctx.timetableResultTables(input, res.layers["1"])).classes.find((row) => row.id === classId).cells;
  const table = cellsOf(result, "3-1");
  const from = layer.blocks["3a"].slots[0];
  const tryAll = keys.filter((key) => key !== from).map((key) => [key, plain(ctx.timetableEditSwap(inputs, result, { semester: "1", classId: "3-1", a: from, b: key }))]);
  // ① 반 수업 칸으로: 블록은 두 반 모두 그 칸으로, 그 칸에 있던 두 반의 수업은 블록 자리로. 검증기 통과, 위반 수는 검증기와 같다
  const toLesson = tryAll.find(([key, outcome]) => outcome.ok && table[key]?.[0].kind === "lesson" && cellsOf(result, "3-2")[key]?.[0].kind === "lesson");
  assert.ok(toLesson, tryAll.map(([key, outcome]) => `${key}:${outcome.ok ? "ok" : outcome.reason}`).join(" / "));
  const [target, moved] = toLesson;
  assert.deepEqual([moved.block, moved.text, moved.result.edits], [true, `3학년 a블록 ${from} → ${target}(2개 반 함께, 그 칸의 반 수업 2개는 ${from}으로)`, 1]);
  assert.deepEqual([moved.result.layers["1"].blocks["3a"].slots.includes(target), moved.result.layers["1"].blocks["3a"].slots.includes(from)], [true, false]);
  for (const classId of ["3-1", "3-2"]) {
    const after = cellsOf(moved.result, classId);
    assert.deepEqual([after[target][0].kind, after[from][0].kind, after[from][0].text], ["block", "lesson", cellsOf(result, classId)[target][0].text], classId);
  }
  const check = plain(ctx.timetableValidate(inputs, moved.result));
  assert.deepEqual([check.ok, moved.result.metrics.hard], [true, check.violations.filter((item) => item.level === "hard").reduce((sum, item) => sum + item.amount, 0)]);
  // 반 수업 칸을 먼저 고르고 블록 칸을 눌러도 같은 이동
  assert.deepEqual(plain(ctx.timetableEditSwap(inputs, result, { semester: "1", classId: "3-2", a: target, b: from })).result.layers["1"], moved.result.layers["1"]);
  // ② 같은 반들의 다른 블록 칸으로: 두 블록이 자리를 맞바꾼다
  const other = layer.blocks["3b"].slots[0];
  const swapped = plain(ctx.timetableEditSwap(inputs, result, { semester: "1", classId: "3-1", a: from, b: other }));
  assert.deepEqual([swapped.ok, swapped.text], [true, `3학년 ${from} a블록 ↔ ${other} b블록`]);
  assert.deepEqual([swapped.result.layers["1"].blocks["3a"].slots.includes(other), swapped.result.layers["1"].blocks["3b"].slots.includes(from)], [true, true]);
  assert.equal(plain(ctx.timetableValidate(inputs, swapped.result)).ok, true);
  // ③ 안 되는 칸은 이유(검증기의 문장): 그 칸의 반 수업 교사가 블록 자리 시각에 다른 반에 있으면 겹침
  const refused = tryAll.filter(([, outcome]) => !outcome.ok);
  for (const [, outcome] of refused) assert.match(outcome.reason, /겹칩니다|같은 블록의 두 시간|창체|정해진 블록 시간/);
  // ④ 블록 시간이 6단계에서 정해져 있으면(그 시간 그대로 쓰는 조건) 옮길 수 없다
  const fixedInput = JSON.parse(JSON.stringify(input));
  fixedInput.blocks[0].times = layer.blocks["3a"].slots.join(",");
  const fixedResult = plain(ctx.timetableSolve({ 1: fixedInput }, { seed: 1, iterations: 8000, rounds: 2 }));
  const fixedFrom = fixedResult.layers["1"].blocks["3a"].slots[0];
  const lessonKey = keys.find((key) => cellsOf(fixedResult, "3-1")[key]?.[0].kind === "lesson" && cellsOf(fixedResult, "3-2")[key]?.[0].kind === "lesson");
  const fixedTry = plain(ctx.timetableEditSwap({ 1: fixedInput }, fixedResult, { semester: "1", classId: "3-1", a: fixedFrom, b: lessonKey }));
  assert.equal(fixedTry.ok, false);
  assert.match(fixedTry.reason, /정해진 블록 시간|겹칩니다/);
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
  // 블록도 같다: 한 학기에서 블록 한 시간을 옮기면 두 학기 블록의 묶음 표시가 풀리고 '벗어난 칸'이 는다(그 칸의 묶음 반 수업도 함께)
  assert.deepEqual([result.layers["1"].blocks["3a"].frame, result.layers["2"].blocks["3a"].frame], [true, true]);
  const third = plain(ctx.timetableResultTables(inputs[1], result.layers["1"])).classes.find((row) => row.id === "3-1").cells;
  const allKeys = ["월", "화"].flatMap((day) => [1, 2, 3, 4, 5].map((period) => `${day}${period}`));
  const tries = result.layers["1"].blocks["3a"].slots.flatMap((slot) => allKeys.filter((key) => !third[key] || third[key][0].kind === "lesson").map((key) => [slot, key, plain(ctx.timetableEditSwap(models, result, { semester: "1", classId: "3-1", a: slot, b: key }))]));
  const moves = tries.filter(([, , outcome]) => outcome.ok);
  assert.ok(moves.length >= 1, tries.map(([slot, key, outcome]) => `${slot}→${key}: ${outcome.reason}`).join(" / "));
  const [from, to, blockDone] = moves[0];
  assert.deepEqual([blockDone.result.layers["1"].blocks["3a"].frame, blockDone.result.layers["2"].blocks["3a"].frame, blockDone.result.layers["1"].blocks["3a"].slots.includes(to), blockDone.result.layers["2"].blocks["3a"].slots.includes(from)], [undefined, undefined, true, true]);
  assert.ok(blockDone.result.metrics.frameBroken >= 1);
  assert.equal(plain(ctx.timetableValidate(inputs, blockDone.result)).ok, true);
});

test("직접 고치기: 담당 교사 바꾸기 — 전공 일치 후보만, 그 수업의 모든 시간에 설 수 있어야 하고 필수 상한을 넘지 않아야 한다, 담당 교사 없음으로 비우기", () => {
  const ctx = context();
  // 1학년 2반, 월요일 3교시. 국어(1시간)·문학(1시간, 국어 교과)·수학(1시간). 이국어는 필수 상한 2시간.
  const make = (semester) => ({ semester, days: "월", periods: 3, grades: [{ grade: "1", classes: 2 }],
    teachers: [{ id: "k1", name: "김국어", departments: ["국어"] }, { id: "k2", name: "이국어", departments: ["국어"], maxHours: 2 }, { id: "m1", name: "박수학", departments: ["수학"] }],
    lessons: [{ id: "국어", grade: "1", subject: "국어", department: "국어", hours: 1 }, { id: "문학", grade: "1", subject: "문학", department: "국어", hours: 1 }, { id: "수학", grade: "1", subject: "수학", department: "수학", hours: 1 }],
    blocks: [], rules: {} });
  const layerOf = (frame) => ({ blocks: {}, creative: [], lessons: Object.fromEntries(Object.entries({
    "국어@1-1": ["월1", "k1"], "수학@1-1": ["월2", "m1"], "문학@1-1": ["월3", "k1"], "국어@1-2": ["월1", "k2"], "문학@1-2": ["월2", "k2"], "수학@1-2": ["월3", "m1"]
  }).map(([id, [slot, teacherId]]) => [id, { slots: [slot], teacherId, ...(frame ? { frame: true } : {}) }])) });
  const inputs = { 1: make("1") };
  const result = { layers: { 1: layerOf(false) }, violations: [], noTeacher: [], metrics: { noTeacherHours: 0 } };
  assert.equal(plain(ctx.timetableValidate(inputs, result)).ok, true);
  assert.deepEqual(["k1", "k2", "m1"].map((id) => ctx.timetableTeacherHours(result.layers["1"], id)), [2, 2, 2]);
  const change = (res, lessonId, teacherId, semester = "1", data = inputs) => plain(ctx.timetableEditTeacher(data, res, { semester, lessonId, teacherId }));
  // 거절: 같은 교사 · 전공이 다른 교사 · 그 시간에 다른 반에 있는 교사(이유 = 검증기의 문장) · 필수 상한
  assert.equal(change(result, "국어@1-1", "k1").reason, "지금 담당 교사와 같습니다.");
  assert.equal(change(result, "국어@1-1", "m1").reason, "박수학 교사는 국어의 담당 후보(전공 일치)가 아닙니다.");
  assert.match(change(result, "국어@1-2", "k1").reason, /^김국어 교사 월1: .*겹칩니다\.$/);
  assert.equal(change(result, "문학@1-1", "k2").reason, "이국어 교사는 1학기 주 2시간 — 1시간을 더하면 필수 상한 2시간을 넘습니다.");
  assert.equal(change(result, "없는 수업", "k1").reason, "이 학기의 계산 결과에 없는 수업입니다.");
  // 담당 교사 없음으로 비우기: 담당 교사 없음 목록·시간이 늘고(직접 비움), 원래 결과는 그대로
  const cleared = change(result, "국어@1-1", "");
  assert.deepEqual([cleared.ok, cleared.text, cleared.result.edits, cleared.result.layers["1"].lessons["국어@1-1"].teacherId], [true, "1-1반 국어 담당 교사 김국어 → 담당 교사 없음", 1, null]);
  assert.deepEqual([cleared.result.noTeacher, cleared.result.metrics.noTeacherHours], [[{ semester: "1", kind: "lesson", grade: "1", classId: "1-1", subject: "국어", hours: 1, reason: "manual" }], 1]);
  assert.equal(result.layers["1"].lessons["국어@1-1"].teacherId, "k1");
  assert.equal(plain(ctx.timetableValidate(inputs, cleared.result)).ok, true);
  // 김국어가 월1에 비었으니 이제 1-2반 국어를 김국어로 바꿀 수 있다 → 이국어는 1시간이 되어 1-1반 문학을 맡을 수 있다
  const moved = change(cleared.result, "국어@1-2", "k1");
  assert.deepEqual([moved.ok, moved.text, moved.result.edits], [true, "1-2반 국어 담당 교사 이국어 → 김국어", 2]);
  const taken = change(moved.result, "문학@1-1", "k2");
  assert.deepEqual([taken.ok, ctx.timetableTeacherHours(taken.result.layers["1"], "k2"), ctx.timetableTeacherHours(taken.result.layers["1"], "k1")], [true, 2, 1]);
  // 비운 수업에 다시 교사를 넣으면 담당 교사 없음 목록에서 빠진다
  const back = change(taken.result, "국어@1-1", "k2");
  assert.equal(back.ok, false); // 이국어는 월1에 없지만 이미 2시간(필수 상한)
  const refill = change(moved.result, "국어@1-1", "k2");
  assert.deepEqual([refill.ok, refill.result.noTeacher, refill.result.metrics.noTeacherHours], [true, [], 0]);
  assert.equal(plain(ctx.timetableValidate(inputs, refill.result)).ok, true);
  // 두 학기 같은 자리 묶음 수업은 두 학기 함께 바뀐다(묶음은 그대로)
  const both = { 1: make("1"), 2: make("2") };
  const framed = { layers: { 1: layerOf(true), 2: layerOf(true) }, violations: [], noTeacher: [], metrics: { noTeacherHours: 0 } };
  assert.equal(plain(ctx.timetableValidate(both, framed)).ok, true);
  const pair = change(framed, "국어@1-1", "", "1", both);
  assert.deepEqual([pair.ok, pair.text, pair.semesters, pair.result.layers["1"].lessons["국어@1-1"].teacherId, pair.result.layers["2"].lessons["국어@1-1"].teacherId, pair.result.layers["2"].lessons["국어@1-1"].frame, pair.result.metrics.noTeacherHours],
    [true, "1-1반 국어 담당 교사 김국어 → 담당 교사 없음(두 학기 함께)", ["1", "2"], null, null, true, 2]);
  assert.equal(plain(ctx.timetableValidate(both, pair.result)).ok, true);
  // 고정한 교사(입력 pins.teachers)가 있는 수업은 고정을 푼 뒤에만 바꾼다, 6단계·5단계가 정한 교사는 바꿀 수 없다
  const pinnedInputs = { 1: { ...make("1"), pins: { teachers: { "국어@1-1": "k1" } } } };
  assert.equal(change(result, "국어@1-1", "", "1", pinnedInputs).reason, "1-1반 국어 수업은 담당 교사를 고정해 두었습니다 — 교사 고정을 푼 뒤 바꾸세요.");
  const fixedInputs = { 1: make("1") };
  fixedInputs[1].lessons[0].teacherByClass = { "1-1": "k1" };
  assert.match(change(result, "국어@1-1", "", "1", fixedInputs).reason, /담당 교사가 정해져 있습니다\(김국어/);
  // 고정이 결과에서 지켜지는지: 담당 교사 고정도 함께 본다
  assert.deepEqual([ctx.timetablePinsHeld(result, {}, { 1: { "국어@1-1": "k1" } }), ctx.timetablePinsHeld(result, {}, { 1: { "국어@1-1": "k2" } }), ctx.timetablePinsHeld(result, {}, { 1: { "없는 수업": "k2" } })], [true, false, true]);
});

test("나눠 맡긴 수업(others): 표는 칸마다 그 칸의 교사, 맞바꾸면 그 칸의 교사가 함께 옮겨 가고, 교사를 바꾸면 한 교사로 합쳐진다", () => {
  const ctx = context();
  const input = { semester: "1", days: "월", periods: 3, grades: [{ grade: "1", classes: 1 }],
    teachers: [{ id: "k1", name: "김국어", departments: ["국어"] }, { id: "k2", name: "이국어", departments: ["국어"], maxHours: 1 }],
    lessons: [{ id: "국어", grade: "1", subject: "국어", department: "국어", hours: 2 }], blocks: [], rules: {} };
  const inputs = { 1: input };
  const result = { layers: { 1: { blocks: {}, creative: [], lessons: { "국어@1-1": { slots: ["월1", "월2"], teacherId: "k1", others: [{ teacherId: "k2", slots: ["월2"] }] } } } }, violations: [], noTeacher: [], metrics: { noTeacherHours: 0 } };
  assert.equal(plain(ctx.timetableValidate(inputs, result)).ok, true);
  const tables = plain(ctx.timetableResultTables(input, result.layers["1"]));
  assert.deepEqual([tables.classes[0].cells["월1"][0].teacher, tables.classes[0].cells["월2"][0].teacher, tables.teachers.map((row) => [row.name, row.hours])], ["김국어", "이국어", [["김국어", 1], ["이국어", 1]]]);
  assert.deepEqual(["k1", "k2"].map((id) => ctx.timetableTeacherHours(result.layers["1"], id)), [1, 1]);
  // 월2(이국어가 맡은 시간)를 빈칸 월3과 맞바꾸면 이국어의 칸도 월3으로
  const swapped = plain(ctx.timetableEditSwap(inputs, result, { semester: "1", classId: "1-1", a: "월2", b: "월3" }));
  assert.deepEqual([swapped.ok, swapped.result.layers["1"].lessons["국어@1-1"].slots, swapped.result.layers["1"].lessons["국어@1-1"].others], [true, ["월1", "월3"], [{ teacherId: "k2", slots: ["월3"] }]]);
  assert.equal(plain(ctx.timetableValidate(inputs, swapped.result)).ok, true);
  // 담당 교사를 김국어로 바꾸면(이미 1시간을 맡고 있음) 한 교사가 2시간 모두 — others가 없어진다. 이국어는 필수 상한 1시간이라 2시간을 다 맡을 수 없다
  const unified = plain(ctx.timetableEditTeacher(inputs, result, { semester: "1", lessonId: "국어@1-1", teacherId: "k1" }));
  assert.deepEqual([unified.ok, unified.result.layers["1"].lessons["국어@1-1"].others, ctx.timetableTeacherHours(unified.result.layers["1"], "k1"), ctx.timetableTeacherHours(unified.result.layers["1"], "k2")], [true, undefined, 2, 0]);
  assert.equal(plain(ctx.timetableEditTeacher(inputs, result, { semester: "1", lessonId: "국어@1-1", teacherId: "k2" })).reason, "이국어 교사는 1학기 주 1시간 — 1시간을 더하면 필수 상한 1시간을 넘습니다.");
});

test("칸 고정 도우미: 고정이 결과에서 지켜지는지, 그 칸의 반 수업 id", () => {
  const ctx = context();
  const result = { layers: { 1: { lessons: { "1|국어@1-1": { slots: ["월2", "수3"] }, "1|통합과학|1@1-1#2": { slots: ["화1"] }, "1|음악@1-2": { slots: ["금6"], pinMissed: ["월1"] } }, blocks: {}, creative: [] } } };
  assert.equal(ctx.timetablePinsHeld(result, undefined), true);
  assert.equal(ctx.timetablePinsHeld(result, { 1: { "1|국어@1-1": ["월2"] } }), true);
  assert.equal(ctx.timetablePinsHeld(result, { 1: { "1|국어@1-1": ["월2", "목4"] } }), false, "결과에 없는 칸에 고정 → 다시 계산해야 함");
  assert.equal(ctx.timetablePinsHeld(result, { 1: { "1|음악@1-2": ["월1", "금6"] } }), true, "못 지켰다고 표시된 칸은 따지지 않는다");
  assert.equal(ctx.timetablePinsHeld(result, { 1: { "없는 수업@9-9": ["월1"] }, 2: { "1|국어@1-1": ["화5"] } }), true, "결과에 없는 수업·학기는 넘어간다");
  assert.deepEqual([ctx.timetableLessonAt(result.layers[1], "1-1", "수3"), ctx.timetableLessonAt(result.layers[1], "1-1", "화1"), ctx.timetableLessonAt(result.layers[1], "1-2", "수3"), ctx.timetableLessonAt(result.layers[1], "1-1", "금6")],
    ["1|국어@1-1", "1|통합과학|1@1-1#2", "", ""]);
});

test("낱장 인쇄: 반·교사 시간표를 한 장에 2개씩, 한 반·한 교사만도", () => {
  const ctx = context();
  const input = tiny();
  const result = plain(ctx.timetableSolve({ 1: input }, { seed: 1, iterations: 8000, rounds: 2 }));
  const tables = ctx.timetableResultTables(input, result.layers["1"]);
  const classes = plain(ctx.timetablePrintHtml(tables, "class", { title: "2027학년도 1학기", perPage: 2 }));
  assert.deepEqual([classes.cards, classes.pages], [3, 2]);
  assert.equal((classes.html.match(/class="print-page tt-print-page"/g) || []).length, 2);
  assert.match(classes.html, /<h3>2027학년도 1학기 1-1반 시간표<\/h3>/);
  assert.match(classes.html, /<strong>국어<\/strong><small>김국어<\/small>/);
  assert.match(classes.html, /<strong>음악<\/strong><small>담당 교사 없음<\/small>/);
  assert.equal((classes.html.match(/tt-print-lunch/g) || []).length, 3, "반마다 점심 줄");
  const one = plain(ctx.timetablePrintHtml(tables, "class", { title: "t", only: "3-1" }));
  assert.deepEqual([one.cards, one.pages, /data-id="3-1"/.test(one.html), /data-id="1-1"/.test(one.html)], [1, 1, true, false]);
  const teachers = plain(ctx.timetablePrintHtml(tables, "teacher", { title: "2027학년도 1학기", perPage: 2 }));
  assert.equal(teachers.cards, plain(tables).teachers.length);
  assert.match(teachers.html, /김국어 선생님 시간표 <small>주 8시간<\/small>/);
  assert.match(teachers.html, /<th>4교시\(1학년\)<\/th>/);
  assert.match(teachers.html, /<strong>국어<\/strong><small>1-[12]<\/small>/);
  assert.deepEqual(plain(ctx.timetablePrintHtml(tables, "teacher", { only: "없는 교사" })), { html: "", cards: 0, pages: 0 });
});

test("6단계 학생 시간표용 반 수업 칸: 결과가 지금 조건의 것이고 블록 자리가 6단계와 같을 때만, 내년 반마다 { 칸: 과목·교사 }", () => {
  const input = tiny();
  const base = context();
  const result = plain(base.timetableSolve({ 1: input }, { seed: 1, iterations: 8000, rounds: 2 }));
  const slots = result.layers["1"].blocks["3a"].slots;
  const entries = { "그룹": { blockTimes: { a: slots.join(",") }, sectionResult: { blocks: [{ id: "a", letter: "a", times: slots.map((key) => `${key[0]}:${key.slice(1)}`) }] } } };
  const make = (saved, pins) => {
    const ctx = vm.createContext({ state: { currentRound: "1", timetable: { settings: pins ? { pins } : {}, 1: saved } }, classSectionsEntry: (round, key) => entries[key] || null });
    for (const file of ["timetable.js", "timetable-solve.js", "timetable-view.js"]) vm.runInContext(read(file), ctx);
    vm.runInContext("timetableInput = (round, semester) => ({ input: __input, year: '2027' }); timetableCurrentSignature = () => 'sig';", ctx);
    ctx.__input = input;
    return ctx;
  };
  const renamed = plain(result);
  renamed.layers["1"].blocks = { "그룹|a": result.layers["1"].blocks["3a"] }; // 6단계 그룹 키 모양의 블록 id
  const ok = make({ at: "t", signature: "sig", result: renamed });
  const lessons = plain(ok.timetableStudentLessons("1", "1", "1"));
  assert.deepEqual(Object.keys(lessons), ["1", "2"]);
  assert.equal(Object.keys(lessons["1"]).length, 8, "1학년 1반: 반 수업 7 + 창체 1");
  assert.deepEqual(lessons["1"]["월1"], { text: "창체", teacher: "" });
  assert.ok(Object.values(lessons["1"]).some((cell) => cell.text === "국어" && cell.teacher === "김국어"));
  assert.ok(Object.values(lessons["1"]).some((cell) => cell.text === "음악" && cell.teacher === ""), "담당 교사 없음은 교사 빈칸");
  assert.deepEqual(Object.keys(plain(ok.timetableStudentLessons("1", "3", "1"))), ["1"]);
  // 결과가 없거나, 바뀌기 전 것이거나, 블록 자리가 6단계 블록 시간과 다르면 null
  assert.equal(make(undefined).timetableStudentLessons("1", "1", "1"), null);
  assert.equal(make({ at: "t", signature: "옛 서명", result: renamed }).timetableStudentLessons("1", "1", "1"), null);
  assert.equal(ok.timetableStudentLessons("1", "1", "2"), null, "그 학기 결과가 없음");
  entries["그룹"].blockTimes.a = "금5,금6";
  assert.equal(make({ at: "t", signature: "sig", result: renamed }).timetableStudentLessons("1", "1", "1"), null, "블록 시간을 아직 6단계에 적어 넣지 않음");
});
