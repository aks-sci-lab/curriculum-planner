// 6단계 직접 고치기(class-sections-edit.js 순수 계산): 과목 × 블록 분반 수 표·같이 신청한 학생, 학생 옮기기 검사·추천,
// 배정 결과 엑셀 내려받기 → 올리기. 모든 학생 자료는 합성(가명 키)이다.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const solver = fs.readFileSync(path.join(root, "class-sections.js"), "utf8");
const edit = fs.readFileSync(path.join(root, "class-sections-edit.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function context() {
  const ctx = vm.createContext({ performance, console });
  vm.runInContext(solver, ctx);
  vm.runInContext(edit.slice(0, edit.indexOf("\n// ---- 앱 연결 ----")), ctx);
  return ctx;
}

// 72명 택2, 블록 3개: 물리 2분반·화학 2분반·생명 1분반·지구 1분반(정원 30)
function sample() {
  const combos = [[["물리", "화학"], 30], [["물리", "생명"], 12], [["화학", "지구"], 18], [["생명", "지구"], 6], [["물리", "지구"], 6]];
  const students = [];
  let n = 0;
  for (const [courses, count] of combos) for (let k = 0; k < count; k += 1) { n += 1; students.push({ key: `1-${1 + (n % 4)}-${n}`, homeroom: String(1 + (n % 4)), courses }); }
  return { blocks: 3, choose: 2, defaultCapacity: 30, seed: 1, maxSectionsPerBlock: 4,
    courses: [{ key: "물리", sections: 2 }, { key: "화학", sections: 2 }, { key: "생명", sections: 1 }, { key: "지구", sections: 1 }], students };
}

test("같이 신청한 학생 수·과목 × 블록 표·같은 블록 하나에만 있는 쌍(충돌)", () => {
  const ctx = context();
  const input = sample();
  const co = ctx.classSectionsEditCoRequests(input.students);
  assert.equal(co.get("물리", "화학"), 30);
  assert.equal(co.get("화학", "물리"), 30, "순서 무관");
  assert.equal(co.get("생명", "화학"), 0);
  assert.equal(co.demand.get("지구"), 30);
  const result = plain(ctx.classSectionsSolve(input));
  assert.equal(result.explain.feasible, true, result.explain.summary);
  const courses = input.courses.map((course) => ({ key: course.key, name: course.key }));
  const model = plain({ ...ctx.classSectionsEditPlacementModel(result, courses, input.students), co: undefined });
  assert.deepEqual(model.rows.map((row) => row.sections), [2, 2, 1, 1]);
  assert.equal(model.rows[0].demand, 48);
  assert.equal(model.rows[0].capacity, 60);
  assert.equal(model.blocks.reduce((sum, block) => sum + block.count, 0), 6);
  for (const row of model.rows) assert.equal(Object.values(row.perBlock).reduce((a, b) => a + b, 0), row.sections);
  assert.equal(model.conflicts.length, 0, "풀린 편성에는 충돌 없음");
  // 생명·지구를 같은 블록 하나에 몰면 둘 다 신청한 6명이 충돌
  const forced = plain(result);
  const life = forced.sections.find((section) => section.courseKey === "생명");
  const earth = forced.sections.find((section) => section.courseKey === "지구");
  earth.blockId = life.blockId;
  const bad = ctx.classSectionsEditPlacementModel(forced, courses, input.students);
  assert.deepEqual(plain(bad.conflicts.map((item) => [item.a, item.b, item.count])), [["생명", "지구", 6]]);
});

test("표의 칸을 바꾸면 그 과목 분반을 블록에 고정, 다른 분반은 지금 블록에 고정 → 다시 계산하면 그대로 배치되고 학생만 다시 배정", () => {
  const ctx = context();
  const input = sample();
  const result = plain(ctx.classSectionsSolve(input));
  const physics = result.sections.filter((section) => section.courseKey === "물리").map((section) => section.blockId);
  // 물리 2분반을 한 블록(지금 첫 분반 블록)에 모두 둔다
  const target = physics[0];
  const counts = Object.fromEntries(result.blocks.map((block) => [block.id, block.id === target ? 2 : 0]));
  const { pins, sections } = plain(ctx.classSectionsEditPlacementPins(result, "물리", counts));
  assert.equal(sections, 2);
  assert.equal(pins["물리#1"], target);
  assert.equal(pins["물리#2"], target);
  for (const section of result.sections) if (section.courseKey !== "물리") assert.equal(pins[section.id], section.blockId);
  const again = plain(ctx.classSectionsSolve({ ...input, pins: { sections: pins } }));
  for (const section of again.sections) assert.equal(section.blockId, pins[section.id], `${section.id} 고정 블록`);
  // 분반 수를 늘리면(물리 3분반) 새 분반 id '물리#3'
  const more = plain(ctx.classSectionsEditPlacementPins(result, "물리", { ...counts, [result.blocks.find((block) => block.id !== target).id]: 1 }));
  assert.equal(more.sections, 3);
  assert.ok(more.pins["물리#3"]);
});

test("학생 한 명 옮기기: 칸(블록별 분반)·지금·추천, 검사(블록 겹침·정원 초과·택n·신청 안 한 과목), 고정 뒤 바뀐 학생만 다시 계산", () => {
  const ctx = context();
  const input = sample();
  const result = plain(ctx.classSectionsSolve(input));
  const key = input.students.find((student) => student.courses.includes("물리") && student.courses.includes("화학")).key;
  const rows = plain(ctx.classSectionsEditStudentRows(result, key, ["물리", "화학"]));
  assert.deepEqual(rows.map((row) => row.courseKey), ["물리", "화학"]);
  for (const row of rows) {
    assert.ok(row.current, "지금 분반");
    assert.equal(Object.values(row.cells).flat().length, result.sections.filter((section) => section.courseKey === row.courseKey).length);
    assert.deepEqual(Object.keys(row.cells), result.blocks.map((block) => block.id), "블록마다 칸(없으면 빈 목록 = 회색)");
  }
  const now = result.assign[key];
  assert.ok(ctx.classSectionsEditCheck({ result, studentKey: key, ids: now, choose: 2, wishes: ["물리", "화학"] }).ok);
  // 같은 블록 두 과목
  const byBlock = new Map();
  for (const section of result.sections) { if (!byBlock.has(section.blockId)) byBlock.set(section.blockId, []); byBlock.get(section.blockId).push(section); }
  const clash = [...byBlock.values()].map((list) => [list.find((item) => item.courseKey === "물리"), list.find((item) => item.courseKey === "화학")]).find(([a, b]) => a && b);
  if (clash) {
    const check = plain(ctx.classSectionsEditCheck({ result, studentKey: key, ids: clash.map((item) => item.id), choose: 2 }));
    assert.ok(check.errors.some((text) => /블록에 두 과목/.test(text)), JSON.stringify(check));
  }
  // 정원 초과: 다른 물리 분반 정원을 지금 인원으로 줄이고 옮기면 오류
  const other = result.sections.find((section) => section.courseKey === "물리" && !now.includes(section.id));
  const full = plain(result);
  full.sections.find((section) => section.id === other.id).capacity = other.size;
  const over = plain(ctx.classSectionsEditCheck({ result: full, studentKey: key, ids: [other.id, now.find((id) => id.startsWith("화학"))], choose: 2 }));
  assert.ok(over.errors.some((text) => /정원 초과/.test(text)) || over.errors.some((text) => /블록에 두 과목/.test(text)), JSON.stringify(over));
  // 택n: 학급 단위 과목이 있으면 이동 2과목 + 1 > 택2
  assert.ok(ctx.classSectionsEditCheck({ result, studentKey: key, ids: now, choose: 2, unit: "지구" }).errors.some((text) => /택2보다 많은/.test(text)));
  assert.ok(ctx.classSectionsEditCheck({ result, studentKey: key, ids: now.slice(0, 1), choose: 2 }).warnings.some((text) => /택2보다 적은/.test(text)));
  const earth = result.sections.find((section) => section.courseKey === "지구");
  assert.ok(ctx.classSectionsEditCheck({ result, studentKey: key, ids: [now[0], earth.id], choose: 2, wishes: ["물리", "화학"] }).warnings.some((text) => /신청하지 않은 지구/.test(text)));
  // 추천: 지금 배정이 가능하면 그대로(바꾸는 과목 0)
  assert.deepEqual(plain(ctx.classSectionsEditRecommend(rows, key, result)).sort(), now.slice().sort());
  // 고정(pins.students) 뒤 바뀐 학생만 다시 계산: 다른 물리 분반이 다른 블록이면 그 학생은 그 분반
  const alt = result.sections.filter((section) => section.courseKey === "물리" && !now.includes(section.id))
    .find((section) => !now.some((id) => result.sections.find((item) => item.id === id).blockId === section.blockId && !id.startsWith("물리")));
  if (alt) {
    const chem = result.sections.find((section) => section.courseKey === "화학" && section.blockId !== alt.blockId);
    const ids = [alt.id, chem.id];
    const partial = plain(ctx.classSectionsSolve({ ...input, partial: true, pins: { students: { [key]: ids } },
      previous: { sections: result.sections.map((section) => ({ id: section.id, blockId: section.blockId })), assign: result.assign }, changedStudents: [] }));
    assert.deepEqual(partial.assign[key].slice().sort(), ids.slice().sort());
    let moved = 0;
    for (const student of input.students) if (student.key !== key && partial.assign[student.key].slice().sort().join() !== result.assign[student.key].slice().sort().join()) moved += 1;
    assert.equal(moved, 0, "다른 학생은 그대로");
  }
});

test("배정 결과 엑셀: 학생마다 과목별 블록·분반 번호, 열린 블록 표시·과목별 블록(열리지 않은 블록 회색) → 올리면 바뀐 학생·문제", () => {
  const ctx = context();
  const input = sample();
  const result = plain(ctx.classSectionsSolve(input));
  const courses = input.courses.map((course) => ({ key: course.key, name: course.key }));
  const names = new Map([[input.students[0].key, "가명"]]);
  const sheets = plain(ctx.classSectionsEditAssignSheets(result, courses, input.students, names));
  assert.deepEqual(sheets.map((sheet) => sheet.name), ["배정 결과", "과목별 블록", "안내"]);
  const main = sheets[0];
  const value = (cell) => (cell && typeof cell === "object" ? cell.v : cell);
  const rows = main.rows.map((row) => row.map(value));
  assert.deepEqual(rows[0].slice(0, 4), ["현 학년-반-번호", "성명", "물리", ""]);
  assert.deepEqual(rows[1].slice(2, 4), ["블록", "분반 번호"]);
  assert.equal(rows[2][0], "열린 블록");
  assert.match(rows[2][2], /^[a-c]\(\d(·\d)*\)( [a-c]\(\d(·\d)*\))*$/);
  assert.equal(rows.length, 3 + input.students.length);
  assert.equal(rows.find((row) => row[0] === input.students[0].key)[1], "가명");
  assert.ok(main.merges.includes("C1:D1"));
  const blockSheet = sheets[1];
  const greyCells = blockSheet.rows.slice(1).flat().filter((cell) => cell && typeof cell === "object" && cell.s === 6);
  assert.ok(greyCells.length > 0, "열리지 않은 블록은 회색(style 6)");
  // 그대로 올리면 바뀐 학생 0
  const same = plain(ctx.classSectionsEditReadAssign(rows, result, { choose: 2 }));
  assert.equal(same.changed.length, 0, JSON.stringify(same.problems));
  // 한 학생의 물리를 다른 물리 분반으로(다른 블록이면 화학과 겹치지 않는지는 검사가 알려 줌)
  const key = input.students.find((student) => student.courses.includes("물리")).key;
  const rowIndex = rows.findIndex((row) => row[0] === key);
  const current = result.sections.find((section) => result.assign[key].includes(section.id) && section.courseKey === "물리");
  const other = result.sections.find((section) => section.courseKey === "물리" && section.id !== current.id);
  const edited = rows.map((row) => row.slice());
  edited[rowIndex][2] = other.blockLetter.toUpperCase();
  edited[rowIndex][3] = String(other.noInBlock);
  edited[rowIndex][0] = key.replace(/-/g, " - ");
  const read = plain(ctx.classSectionsEditReadAssign(edited, result, { choose: 2, normalizeKey: (text) => text.replace(/\s+/g, "") }));
  assert.deepEqual(read.changed, [key]);
  assert.ok(read.changes[key].includes(other.id));
  assert.ok(!read.changes[key].includes(current.id));
  // 없는 분반·이 그룹에 없는 학생·모르는 과목 열
  const broken = rows.map((row) => row.slice());
  broken[rowIndex][2] = "z"; broken[rowIndex][3] = "9";
  broken.push(["9-9-9", "", "a", "1"]);
  broken[0] = broken[0].slice(); broken[0].push("없는과목");
  const bad = plain(ctx.classSectionsEditReadAssign(broken, result, { choose: 2 }));
  assert.ok(bad.problems.some((text) => /z블록 9번 분반이 없습니다/.test(text)), JSON.stringify(bad.problems));
  assert.deepEqual(bad.unknownStudents, ["9-9-9"]);
  assert.deepEqual(bad.unknownCourses, ["없는과목"]);
  // 블록 겹침: 물리를 화학과 같은 블록 분반으로
  const chem = result.sections.find((section) => result.assign[key].includes(section.id) && section.courseKey !== "물리");
  const clashPhysics = result.sections.find((section) => section.courseKey === "물리" && section.blockId === chem.blockId);
  if (clashPhysics) {
    const clash = rows.map((row) => row.slice());
    clash[rowIndex][2] = clashPhysics.blockLetter; clash[rowIndex][3] = clashPhysics.noInBlock;
    assert.ok(plain(ctx.classSectionsEditReadAssign(clash, result, { choose: 2 })).problems.some((text) => /블록에 두 과목/.test(text)));
  }
  assert.match(ctx.classSectionsEditReadAssign([["이름", "x"]], result, {}).error, /현 학년-반-번호/);
});
