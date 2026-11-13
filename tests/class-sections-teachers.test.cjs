// 6단계 교사 명단(class-sections-teachers.js): 자리 이름 판별·안내, 엑셀 양식 내려받기 → 올리기(번호·이름으로 맞춤, 추가·갱신·유지·명단에 없음),
// 이름을 바꿔도 배정(teacherOf)·고정(pins.teachers)이 교사 id로 이어지는지. 교사 이름은 가명.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const solver = fs.readFileSync(path.join(root, "class-sections.js"), "utf8");
const teachersSource = fs.readFileSync(path.join(root, "class-sections-teachers.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const labels = { "과학-물리": "과학(물리)", "사회-지리": "사회(지리)", 국어: "국어" };
const labelOf = (id) => labels[id] || id;

function context() {
  const ctx = vm.createContext({ performance, console });
  vm.runInContext(solver, ctx);
  vm.runInContext(teachersSource.slice(0, teachersSource.indexOf("\n// ---- 앱 연결 ----")), ctx);
  return ctx;
}

test("자리 이름(5단계 교사 수로 만든 't-교과-n' + '교과 이름 n')만 안내, 실제 이름·별칭이면 안내 없음", () => {
  const ctx = context();
  const teachers = [{ id: "t-사회-지리-1", department: "사회-지리", name: "사회(지리) 1" }, { id: "t-사회-지리-2", department: "사회-지리", name: "김가상" },
    { id: "t-과학-물리-1", department: "과학-물리", name: "과학(물리) 1", alias: "물리A" }, { id: "t9", department: "국어", name: "국어 1" }];
  assert.deepEqual(teachers.map((teacher) => ctx.classSectionsTeacherPlaceholder(teacher, labelOf)), [true, false, false, false]);
  const warnings = plain(ctx.classSectionsTeacherNameWarningsFor(teachers, labelOf));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^실제 이름이 없는 교사 1명\(사회\(지리\) 1\) — 교사 명단에서 이름을 넣으세요/);
  assert.deepEqual(plain(ctx.classSectionsTeacherNameWarningsFor([teachers[1]], labelOf)), []);
});

test("불가 시간 글자: 하루 전체는 요일만, '화6~7'·'목' 읽기, 모르는 글자는 문제", () => {
  const ctx = context();
  const days = ["월", "화", "수", "목", "금"];
  const all = Array.from({ length: 7 }, (_, p) => `목${p + 1}`);
  assert.equal(ctx.classSectionsTeacherSlotsText(["화7", ...all, "월7"], days, 7), "목,월7,화7");
  const parsed = plain(ctx.classSectionsTeacherParseSlots("월7, 화6~7 목 토3 월9 x", days, 7));
  assert.deepEqual(parsed.slots.sort(), ["월7", "화6", "화7", ...all].sort());
  assert.deepEqual(parsed.problems, ["토3", "월9", "x"]);
});

test("불가 시간의 학년 구분: '월4(3학년)'·'월4(1, 2학년)'을 읽고 같은 글자로 내보낸다(구분 없는 '월4'는 그대로)", () => {
  const ctx = context();
  const days = ["월", "화", "수", "목", "금"];
  const parsed = plain(ctx.classSectionsTeacherParseSlots("월4(3학년), 화4 (1, 2학년) 수3~4（3학년） 목7, 금4(1·2·3학년), 월5(오후) 화5()", days, 7));
  assert.deepEqual(parsed.slots, ["월4(3학년)", "화4(1·2학년)", "수3(3학년)", "수4(3학년)", "목7", "금4"]);
  assert.deepEqual(parsed.problems, ["월5(?)", "화5(?)"]);
  // 내보내기: 구분 없는 칸 먼저, 학년 구분은 뒤에 같은 글자로 — 다시 읽으면 같은 칸
  const text = ctx.classSectionsTeacherSlotsText(["화4(1·2학년)", "목7", "월4(3학년)", "수4(3학년)"], days, 7);
  assert.equal(text, "목7,화4(1·2학년),월4(3학년),수4(3학년)");
  assert.deepEqual(plain(ctx.classSectionsTeacherParseSlots(text, days, 7)).slots.sort(), ["화4(1·2학년)", "목7", "월4(3학년)", "수4(3학년)"].sort());
  // 하루 전체에 학년을 적으면 요일만 + 학년
  const all = Array.from({ length: 7 }, (_, p) => `목${p + 1}(3학년)`);
  assert.equal(ctx.classSectionsTeacherSlotsText(all, days, 7), "목(3학년)");
  assert.deepEqual(plain(ctx.classSectionsTeacherParseSlots("목(3학년)", days, 7)).slots, all);
  // 양식 왕복
  const rows = ctx.classSectionsTeacherSheetRows([{ id: "a", name: "가", department: "국어", unavailable: ["월4(3학년)", "금7"] }], { days, periods: 7 });
  assert.equal(rows[1][3], "금7,월4(3학년)");
});

test("양식 내려받기 → 이름만 실제 이름으로 고쳐 올리면 번호(id)로 맞춰 갱신, 새 줄은 추가, 빠진 교사는 '명단에 없음' 표시만", () => {
  const ctx = context();
  const existing = [
    { id: "t-사회-지리-1", department: "사회-지리", name: "사회(지리) 1", unavailable: ["월7"], reason: "육아시간" },
    { id: "t-사회-지리-2", department: "사회-지리", name: "사회(지리) 2", unavailable: [] },
    { id: "t-과학-물리-1", department: "과학-물리", name: "과학(물리) 1", unavailable: [] }];
  const rows = plain(ctx.classSectionsTeacherSheetRows(existing, { days: ["월", "화", "수", "목", "금"], periods: 7 }));
  assert.deepEqual(rows[0], ["이름", "담당 교과", "담당 과목", "불가 시간", "사유", "비고", "번호(고치지 마세요)", "담임(내년 학년-반)"]);
  assert.deepEqual(rows[1], ["사회(지리) 1", "사회-지리", "", "월7", "육아시간", "", "t-사회-지리-1", ""]);
  // 사용자: 1행 이름을 실제 이름으로, 불가 시간 추가 · 2행 그대로 · 3행 삭제 · 새 교사 한 줄(교과는 화면 이름으로 써도 됨)
  const edited = [rows[0], ["김가상", "사회-지리", "", "월7,목", "육아시간", "", "t-사회-지리-1"], rows[2], ["이가상", "국어", "", "", "", "순회", ""], ["박가상", "모르는교과", "", "", "", "", ""]];
  const read = plain(ctx.classSectionsTeacherReadRows(edited, existing, { departments: Object.keys(labels), labelOf, days: ["월", "화", "수", "목", "금"], periods: 7, newId: (n) => `new${n}` }));
  assert.equal(read.text, "교사 명단: 추가 2·갱신 1·유지 1 · 명단에 없음 1명(지우지 않고 표시만)");
  const byId = Object.fromEntries(read.teachers.map((teacher) => [teacher.id, teacher]));
  assert.equal(byId["t-사회-지리-1"].name, "김가상", "같은 id로 이름만 바뀜");
  assert.equal(byId["t-사회-지리-1"].unavailable.length, 8);
  assert.equal(byId["t-과학-물리-1"].notInList, true, "파일에 없는 교사는 지우지 않고 표시");
  assert.equal(read.teachers.length, 5);
  assert.ok(read.teachers.some((teacher) => teacher.name === "이가상" && teacher.department === "국어" && teacher.note === "순회"));
  assert.ok(read.problems.some((text) => /박가상: 담당 교과 '모르는교과'/.test(text)), JSON.stringify(read.problems));
  // 번호 열이 없어도 이름으로 맞춤(띄어쓰기 무시)
  const byName = plain(ctx.classSectionsTeacherReadRows([["이름", "담당 교과"], ["사회(지리) 2 ", "사회-지리"]], existing, { departments: Object.keys(labels), labelOf }));
  assert.equal(byName.kept, 1);
  assert.equal(byName.added, 0);
  assert.match(ctx.classSectionsTeacherReadRows([["성명"]], existing, {}).error, /'이름' 머리글/);
});

test("이름을 바꿔도 배정(teacherOf)·고정(pins.teachers)은 교사 id로 이어지고 출력 이름만 새 이름", () => {
  const ctx = context();
  const students = [];
  for (let n = 1; n <= 60; n += 1) students.push({ key: `1-${1 + (n % 3)}-${n}`, homeroom: String(1 + (n % 3)), courses: [n % 2 ? "물리" : "지리"] });
  const teachers = [{ id: "t-과학-물리-1", name: "과학(물리) 1", departments: ["과학-물리"] }, { id: "t-사회-지리-1", name: "사회(지리) 1", departments: ["사회-지리"] }];
  const input = { blocks: [{ id: "a", times: ["월:1"] }], choose: 1, defaultCapacity: 35, seed: 1,
    courses: [{ key: "물리", sections: 1, department: "과학-물리" }, { key: "지리", sections: 1, department: "사회-지리" }], students, teachers,
    pins: { teachers: { "물리#1": "t-과학-물리-1" } } };
  const before = plain(ctx.classSectionsSolve(input));
  const renamed = teachers.map((teacher) => ({ ...teacher, name: teacher.id === "t-과학-물리-1" ? "김가상" : teacher.name }));
  const after = plain(ctx.classSectionsSolve({ ...input, teachers: renamed }));
  assert.deepEqual(after.teacherOf, before.teacherOf, "배정은 id 그대로");
  assert.equal(after.teacherOf["물리#1"], "t-과학-물리-1", "고정 유지");
  const nameOf = new Map(renamed.map((teacher) => [teacher.id, teacher.name]));
  assert.equal(nameOf.get(after.sections.find((section) => section.id === "물리#1").teacherId), "김가상");
});

test("화면 연결: 교사·시간 창 처리기·블록표 제목·출력물용 classSectionsTeacherNameWarnings()", () => {
  const view = fs.readFileSync(path.join(root, "class-sections-view.js"), "utf8");
  assert.match(view, /classSectionsTeachersEvent\(event\)\) return;/);
  assert.match(view, /classSectionsTeacherToolsHtml\(\)/);
  assert.match(view, /classSectionsTeacherNameWarnings\(\) : \[\]/);
  assert.match(teachersSource, /function classSectionsTeacherNameWarnings\(\) \{/);
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(html.indexOf("class-sections-teachers.js") > html.indexOf("class-sections-view.js"));
});

test("담임 열: '2-3'·'2학년 3반'을 '2-3'으로 맞춰 읽고, 읽지 못하거나 겹치면 확인 항목, 담임 열이 없는 예전 양식은 담임을 그대로 둔다", () => {
  const ctx = context();
  assert.deepEqual(["2-3", "2학년 3반", " 3학년11반 ", "", "4-1", "2반", "2-0"].map((value) => ctx.classSectionsTeacherHomeroom(value)), ["2-3", "2-3", "3-11", "", null, null, null]);
  const existing = [{ id: "a", name: "가", department: "국어", unavailable: [], homeroom: "1-1" }, { id: "b", name: "나", department: "국어", unavailable: [] }, { id: "c", name: "다", department: "국어", unavailable: [] }];
  const rows = plain(ctx.classSectionsTeacherSheetRows(existing));
  assert.deepEqual(rows[1].slice(-2), ["a", "1-1"]);
  const edited = [rows[0], ["가", "국어", "", "", "", "", "a", "2학년 3반"], ["나", "국어", "", "", "", "", "b", "2-3"], ["다", "국어", "", "", "", "", "c", "삼반"]];
  const read = plain(ctx.classSectionsTeacherReadRows(edited, existing, { departments: ["국어"] }));
  assert.deepEqual(read.teachers.map((teacher) => teacher.homeroom || ""), ["2-3", "", ""]);
  assert.deepEqual(read.problems, ["3행 나: 담임 2-3이 가 교사와 겹칩니다(뒤의 것은 비움)", "4행 다: 담임 '삼반'를 읽지 못했습니다(예: 2-3 = 내년 2학년 3반)"]);
  assert.equal(read.text, "교사 명단: 추가 0·갱신 1·유지 2");
  // 담임 열이 없는 예전 양식을 올려도 넣어 둔 담임은 그대로
  const old = [rows[0].slice(0, 7), ["가", "국어", "", "", "", "", "a"]];
  assert.equal(plain(ctx.classSectionsTeacherReadRows(old, existing, { departments: ["국어"] })).teachers[0].homeroom, "1-1");
  // 담임을 비우면 지운다
  assert.equal(plain(ctx.classSectionsTeacherReadRows([rows[0], ["가", "국어", "", "", "", "", "a", ""]], existing, { departments: ["국어"] })).teachers[0].homeroom, undefined);
});
