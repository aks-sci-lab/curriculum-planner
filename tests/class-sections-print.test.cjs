// 6단계 출력물: 분반 → 교실 배정(class-sections.js 끝 '교실 배정' 구간), 이동 출석부·학생 시간표(class-sections-print.js).
// 학생 자료는 합성(가명)이다. 화면 클릭 확인은 Playwright(e2e/class-sections-print-ui.cjs)로 따로 한다.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const solverSource = fs.readFileSync(path.join(root, "class-sections.js"), "utf8");
const viewSource = fs.readFileSync(path.join(root, "class-sections-view.js"), "utf8");
const printSource = fs.readFileSync(path.join(root, "class-sections-print.js"), "utf8");
const cs = require("../class-sections.js");
const pr = require("../class-sections-print.js");
const plain = (value) => JSON.parse(JSON.stringify(value));

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// 합성 그룹: 학년 2·3, 블록 3개, 블록마다 분반 여럿, 일부 과학실·컴퓨터실 과목. times가 있으면 학년 사이 같은 시간 블록이 생긴다.
function syntheticSpec(seed, { timed = true, scienceRooms = 3 } = {}) {
  const random = rng(seed);
  const classrooms = { "2": cs.classSectionsDefaultRoomNames("", 11, "2"), "3": cs.classSectionsDefaultRoomNames("", 10, "3") };
  const rooms = cs.classSectionsRoomList({ classrooms, special: { 과학실: cs.classSectionsDefaultRoomNames("과학실", scienceRooms), 컴퓨터실: ["컴퓨터실"] } });
  const groups = ["2", "3"].map((grade, g) => {
    const blocks = ["a", "b", "c"].map((id, b) => ({ id, letter: id, times: timed ? [`${["월", "화", "수"][b]}:${1 + g}`, `목:${b + 1}`] : [] }));
    const sections = [];
    for (const block of blocks) {
      const count = 6 + Math.floor(random() * 4);
      for (let k = 0; k < count; k += 1) {
        const special = k === 0 ? "과학실" : k === 1 && random() < 0.5 ? "과학실" : k === 2 && random() < 0.4 ? "컴퓨터실" : "";
        const homerooms = {};
        let size = 0;
        for (let h = 1; h <= (grade === "2" ? 11 : 10); h += 1) if (random() < 0.35) { const n = 1 + Math.floor(random() * 8); homerooms[String(h)] = n; size += n; }
        sections.push({ id: `${grade}${block.id}${k}#1`, courseName: `과목${grade}${block.id}${k}`, blockId: block.id, roomName: `${block.id}과목${k}`, size, special, homerooms });
      }
    }
    return { groupId: `g${grade}`, label: `${grade}학년 1학기`, targetGrade: grade, blocks, sections, pins: {} };
  });
  return { rooms, groups };
}

test("교실 배정: 같은 블록 안 겹침 0, 같은 시간 다른 학년 특별실 겹침 0, 결정적(같은 입력 = 같은 결과)", () => {
  for (let seed = 1; seed <= 12; seed += 1) {
    const spec = syntheticSpec(seed);
    const first = cs.classSectionsAssignRooms(spec);
    const again = cs.classSectionsAssignRooms(JSON.parse(JSON.stringify(spec)));
    assert.deepEqual(plain(again.assign), plain(first.assign), `seed ${seed} deterministic`);
    const check = cs.classSectionsValidateRooms(spec, first.assign);
    const clashes = check.filter((issue) => ["room-double", "room-cross"].includes(issue.type));
    assert.deepEqual(clashes, [], `seed ${seed} no clashes`);
    // 직접 다시 센다: (그룹, 블록) 안 교실 중복 없음, 시간이 겹치는 다른 그룹 블록과 교실 중복 없음.
    const uses = [];
    for (const group of spec.groups) for (const section of group.sections) {
      const roomId = first.assign[group.groupId][section.id];
      if (!roomId) continue;
      uses.push({ group: group.groupId, block: section.blockId, times: group.blocks.find((block) => block.id === section.blockId).times, roomId, special: section.special });
    }
    for (let i = 0; i < uses.length; i += 1) for (let j = i + 1; j < uses.length; j += 1) {
      const a = uses[i]; const b = uses[j];
      if (a.roomId !== b.roomId) continue;
      const sameTime = a.group === b.group ? a.block === b.block : a.times.some((slot) => b.times.includes(slot));
      assert.ok(!sameTime, `seed ${seed}: ${a.roomId} used twice at the same time`);
    }
    // 특별실은 특별실 과목만, 학년 교실은 그 학년 분반만.
    const rooms = new Map(spec.rooms.map((room) => [room.id, room]));
    for (const group of spec.groups) for (const section of group.sections) {
      const room = rooms.get(first.assign[group.groupId][section.id]);
      if (!room) continue;
      if (room.kind === "special") assert.equal(room.type, section.special);
      if (room.kind === "class") assert.equal(room.grade, group.targetGrade);
    }
  }
});

test("교실 배정: 기본은 수강생이 가장 많은 내년 반 교실, 특별실 과목은 특별실, 모자라면 원인 설명", () => {
  const rooms = cs.classSectionsRoomList({ classrooms: { "2": ["2-1", "2-2", "2-3"], "3": ["3-1", "3-2"] }, special: { 과학실: ["과학실1"] } });
  assert.deepEqual(rooms.slice(0, 1), [{ id: "2-1", label: "2학년 1반", kind: "class", grade: "2", homeroom: "1" }]);
  const groups = [
    { groupId: "g2", label: "2학년 1학기 택3", targetGrade: "2", blocks: [{ id: "a", letter: "a", times: ["월:1"] }, { id: "b", letter: "b", times: ["화:1"] }], sections: [
      { id: "물#1", courseName: "물리학", blockId: "a", roomName: "a물리학1", size: 20, special: "과학실", homerooms: { "1": 10 } },
      { id: "물#2", courseName: "물리학", blockId: "a", roomName: "a물리학2", size: 20, special: "과학실", homerooms: { "2": 10 } },
      { id: "사#1", courseName: "사회와 문화", blockId: "a", roomName: "a사회와문화", size: 20, homerooms: { "2": 12, "3": 8 } },
      { id: "사#2", courseName: "사회와 문화", blockId: "b", roomName: "b사회와문화", size: 20, homerooms: { "3": 12, "1": 3 } }] },
    { groupId: "g3", label: "3학년 1학기 택1", targetGrade: "3", blocks: [{ id: "a", letter: "a", times: ["월:1"] }],
      sections: [{ id: "화#1", courseName: "화학", blockId: "a", roomName: "a화학", size: 10, special: "과학실", homerooms: { "2": 5 } }] }];
  const plan = cs.classSectionsAssignRooms({ rooms, groups });
  assert.equal(plan.assign.g2["사#1"], "2-2", "most students already in 2-2");
  assert.equal(plan.assign.g2["사#2"], "2-3");
  assert.equal(plan.reasons.g2["사#2"], "수강생 12명이 이 반(가장 많음)");
  assert.equal(Object.values(plan.assign.g2).filter((id) => id === "과학실1").length, 1, "one science room in block a");
  const fallback = plan.issues.filter((issue) => issue.type === "special-fallback");
  assert.equal(fallback.length, 2, "one physics section + chemistry (same time) fall back to classrooms");
  assert.match(fallback.find((issue) => issue.groupId === "g3").message, /같은 시간 다른 학년 2학년 1학기 택3 a블록이 1개 사용/);
  assert.equal(plan.assign.g3["화#1"], "3-2", "fallback uses a 3rd-grade classroom (most students: none in 3-x → order)");
  // 직접 고른 교실은 지키고, 겹치면 오류로 알린다.
  groups[0].pins = { "사#1": "2-3" };
  groups[0].sections[3].blockId = "a";
  const pinned = cs.classSectionsAssignRooms({ rooms, groups });
  assert.equal(pinned.assign.g2["사#1"], "2-3");
  assert.notEqual(pinned.assign.g2["사#2"], "2-3", "auto avoids the pinned room in the same block");
  groups[0].pins = { "사#1": "2-3", "사#2": "2-3" };
  const clash = cs.classSectionsAssignRooms({ rooms, groups });
  assert.ok(clash.issues.some((issue) => issue.type === "room-double" && /2학년 3반: 같은 블록 두 분반/.test(issue.message)));
  // 교실이 모자라면(분반 4개 > 교실 3 + 특별실 1, 이미 쓰는 것 제외) 원인 문장.
  groups[0].pins = {};
  groups[0].sections.push({ id: "윤#1", courseName: "윤리와 사상", blockId: "a", roomName: "a윤리와사상", size: 20, homerooms: {} });
  groups[0].sections.push({ id: "경#1", courseName: "경제", blockId: "a", roomName: "a경제", size: 20, homerooms: {} });
  const short = cs.classSectionsAssignRooms({ rooms, groups });
  const shortage = short.issues.find((issue) => issue.type === "room-short");
  assert.ok(shortage, "room shortage reported");
  assert.match(shortage.message, /교실 2개가 모자랍니다 — 아래에서 교실을 고르세요.*분반 6개 > 2학년 교실 3개/);
  // 다른 교실(다목적실·세미나실)이 있어도 자동으로 넣지 않는다(사용자 결정: 교사가 고름) → '교실 선택 필요' + 후보.
  const moreRooms = cs.classSectionsRoomList({ classrooms: { "2": ["2-1", "2-2", "2-3"], "3": ["3-1", "3-2"] }, special: { 과학실: ["과학실1"] }, extra: ["다목적실", "세미나실"] });
  const more = cs.classSectionsAssignRooms({ rooms: moreRooms, groups });
  assert.ok(!Object.values(more.assign.g2).some((id) => ["다목적실", "세미나실"].includes(id)), "no automatic extra room");
  const unplaced = groups[0].sections.filter((section) => !more.assign.g2[section.id]).map((section) => section.id);
  assert.equal(unplaced.length, 2);
  const lists = unplaced.map((id) => plain(more.choices.g2[id]));
  // 후보 순서(결정적): 다른 교실 → 다른 학년 교실(같은 시간 3학년 블록이 쓰는 3-x 제외) → 특별실(같은 시간 사용 중이면 제외)
  assert.deepEqual(lists[0].map((item) => item.id), ["다목적실", "세미나실", "3-1"]);
  assert.deepEqual(lists[0].map((item) => item.kind), ["extra", "extra", "other-grade"]);
  assert.deepEqual(lists.map((list) => list.find((item) => item.recommended).id), ["다목적실", "세미나실"], "different recommendation per section");
  assert.deepEqual(plain(cs.classSectionsAssignRooms({ rooms: moreRooms, groups: JSON.parse(JSON.stringify(groups)) }).choices), plain(more.choices), "deterministic");
  assert.match(more.reasons.g2[unplaced[0]], /교실 선택 필요/);
  // 추천대로 고르면(roomPins) 겹침 0, 교실 선택 필요 없음
  groups[0].pins = Object.fromEntries(unplaced.map((id, i) => [id, lists[i].find((item) => item.recommended).id]));
  const picked = cs.classSectionsAssignRooms({ rooms: moreRooms, groups });
  assert.ok(!picked.issues.some((issue) => ["room-short", "room-double", "room-cross"].includes(issue.type)), JSON.stringify(picked.issues.map((issue) => issue.type)));
  assert.deepEqual(plain(picked.choices), {});
  groups[0].pins = {};
});

test("교실 배정: 블록 시간이 없으면 다른 학년 특별실 겹침은 안내만, 학년 교실은 학년별", () => {
  const spec = syntheticSpec(3, { timed: false, scienceRooms: 2 });
  const plan = cs.classSectionsAssignRooms(spec);
  assert.ok(plan.issues.some((issue) => issue.type === "no-times"));
  assert.equal(plan.timed, false);
  assert.equal(cs.classSectionsValidateRooms(spec, plan.assign).filter((issue) => issue.type === "room-double").length, 0);
});

test("출석부 시트: 위 3줄 교시·교실·교사, 제목 '과목명(강의실) 출석부', 날짜 칸 17개 + 비고, 인원 = 명렬, 제목 줄 반복·한 장", () => {
  const info = { year: "2027", semester: "1", grade: "1", targetGrade: "2", courseName: "물리학", roomName: "a물리학1", blockLetter: "a", times: ["월:1", "화:2", "목:1"],
    roomLabel: "2학년 5반", teacherName: "김교사", basis: "map",
    students: [{ key: "1-3-2", classroom: "5", number: "7", name: "가명B" }, { key: "1-1-4", classroom: "2", number: "3", name: "가명A" }, { key: "1-2-9", classroom: "5", number: "1", name: "가명C" }] };
  const sheet = pr.classSectionsAttendanceSheet(info);
  assert.equal(sheet.rows[0][0].v, "물리학(a물리학1) 출석부");
  assert.deepEqual(sheet.rows.slice(1, 4).map((row) => [row[0].v, row[2].v]), [["교시", "a블록 · 월1, 화2, 목1"], ["교실", "2학년 5반"], ["교사", "김교사"]]);
  const header = sheet.rows[sheet.headerRow - 1].map((cell) => cell.v);
  assert.deepEqual(header.slice(0, 5), ["순서", "학년", "반", "번호", "성명"]);
  assert.equal(header.filter((value) => value === "월  일").length, 17);
  assert.equal(header.at(-1), "비고");
  assert.equal(header.length, 23);
  const body = sheet.rows.slice(sheet.headerRow);
  assert.equal(body.length, 3);
  assert.deepEqual(body.map((row) => row.slice(0, 5).map((cell) => cell.v)), [[1, 2, 2, 3, "가명A"], [2, 2, 5, 1, "가명C"], [3, 2, 5, 7, "가명B"]], "sorted by next-year class·number");
  assert.equal(sheet.printTitles, `$1:$${sheet.headerRow}`);
  assert.equal(sheet.orientation, "portrait");
  assert.equal(sheet.fitToHeight, 1);
  assert.ok(sheet.merges.includes("A1:W1"));
  // 내년 반을 모르면 현 학년-반-번호 + 경고, 날짜 칸 수는 설정.
  const unknown = pr.classSectionsAttendanceSheet({ ...info, basis: "none", students: info.students.map((s) => ({ ...s, classroom: "", number: "" })) }, { days: 10 });
  const unknownHeader = unknown.rows[unknown.headerRow - 1].map((cell) => cell.v);
  assert.deepEqual(unknownHeader.slice(0, 4), ["순서", "현 학년", "현 반", "현 번호"]);
  assert.equal(unknownHeader.length, 16);
  assert.ok(unknown.rows.some((row) => /^⚠ 내년 반·번호를 몰라 현 1학년 반·번호로/.test(row[0]?.v || "")));
  assert.deepEqual(unknown.rows.slice(unknown.headerRow).map((row) => row.slice(1, 4).map((cell) => cell.v)), [[1, 1, 4], [1, 2, 9], [1, 3, 2]]);
});

test("출석부 묶음: 그룹 = 파일 하나(분반마다 시트), 교사별 = 교사마다 파일, 전체 = 분반마다 파일(이름 규칙)", () => {
  const base = { year: "2027", semester: "1", grade: "1", targetGrade: "2", groupCategory: "2-1 택3", basis: "map", times: [], students: [] };
  const infos = [
    { ...base, courseName: "물리학", roomName: "a물리학1", blockLetter: "a", roomLabel: "2학년 5반", teacherName: "김교사" },
    { ...base, courseName: "물리학", roomName: "b물리학1", blockLetter: "b", roomLabel: "과학실1", teacherName: "김교사" },
    { ...base, courseName: "화학", roomName: "a화학", blockLetter: "a", roomLabel: "", teacherName: "" }];
  const group = pr.classSectionsAttendanceBundles(infos, "group");
  assert.equal(group.length, 1);
  assert.equal(group[0].name, "2027_2학년_1학기_2-1택3_출석부.xlsx");
  assert.deepEqual(group[0].sheets.map((sheet) => sheet.name), ["a물리학1", "b물리학1", "a화학"]);
  const teacher = pr.classSectionsAttendanceBundles(infos, "teacher");
  assert.deepEqual(teacher.map((file) => [file.name, file.sheets.length]), [["2027_1학기_출석부_김교사.xlsx", 2], ["2027_1학기_출석부_교사미정.xlsx", 1]]);
  assert.equal(teacher[0].sheets[0].name, "2-1 a물리학1");
  const all = pr.classSectionsAttendanceBundles(infos, "all");
  assert.deepEqual(all.map((file) => file.name), ["2027_1학기_물리학(a물리학1)_2학년5반_김교사.xlsx", "2027_1학기_물리학(b물리학1)_과학실1_김교사.xlsx", "2027_1학기_화학(a화학)_교실미정_교사미정.xlsx"]);
});

test("학생 시간표: 요일×교시 격자(이동 칸 = 과목·분반·교실·교사, 고정 = 창체, 빈칸 설정), 시간 없으면 목록, 재신청 표시", () => {
  const info = { year: "2027", semester: "1", grade: "1", targetGrade: "2", key: "1-3-12", name: "가명", nextClass: "5", nextNumber: "", days: ["월", "화", "수", "목", "금"], periods: 7,
    fill: "학급 수업", fixedSlots: [{ label: "창체", times: [{ day: "금", period: 6 }, { day: "금", period: 7 }] }],
    entries: [{ blockLetter: "a", times: ["월:1", "수:2"], courseName: "물리학", sectionNo: 2, roomName: "a물리학2", roomLabel: "과학실1", teacher: "김교사" },
      { blockLetter: "b", times: ["화:3"], courseName: "독서 토론과 글쓰기", sectionNo: 0, roomName: "b독서토론과글쓰기", roomLabel: "2학년 3반", teacher: "" },
      { blockLetter: "c", times: [], courseName: "경제", sectionNo: 0, roomName: "c경제", roomLabel: "", teacher: "" }],
    unitCourses: ["정보"], retake: [{ courseName: "화학", reason: "정원 부족" }] };
  const model = pr.classSectionsStudentTimetable(info);
  assert.equal(model.title, "2027학년도 1학기 · 현 1학년 → 2학년 이동수업 시간표");
  assert.equal(model.student, "1-3-12 가명 · 내년 2학년 5반");
  assert.deepEqual(plain(model.grid[0][0]), { kind: "move", lines: ["물리학 ②", "과학실1", "김교사"], block: "a" });
  assert.deepEqual(plain(model.grid[1][2]), { kind: "move", lines: ["물리학 ②", "과학실1", "김교사"], block: "a" });
  assert.deepEqual(plain(model.grid[2][1]), { kind: "move", lines: ["독서 토론과 글쓰기", "2학년 3반"], block: "b" });
  assert.deepEqual(plain(model.grid[5][4]), { kind: "fixed", lines: ["창체"] });
  assert.deepEqual(plain(model.grid[0][1]), { kind: "empty", lines: ["학급 수업"] });
  assert.deepEqual(model.untimed, ["c블록: 경제 · 교실 미정"]);
  const html = pr.classSectionsTimetableHtml(model);
  assert.match(html, /재신청 필요: 화학\(정원 부족\)/);
  assert.match(html, /반 수업\(시간표에서 배치\) · 학급 단위 과목: 정보/);
  // 블록 시간이 하나도 없으면 'a블록: 물리학 ② · 교실 · 교사' 목록만.
  const listOnly = pr.classSectionsStudentTimetable({ ...info, fill: "", entries: info.entries.map((entry) => ({ ...entry, times: [] })) });
  assert.equal(listOnly.grid, null);
  assert.deepEqual(listOnly.untimed, ["a블록: 물리학 ② · 과학실1 · 김교사", "b블록: 독서 토론과 글쓰기 · 2학년 3반", "c블록: 경제 · 교실 미정"]);
  // 같은 칸에 두 이동 수업(입력 오류)은 'clash'.
  const clash = pr.classSectionsStudentTimetable({ ...info, entries: [info.entries[0], { ...info.entries[1], times: ["월:1"] }] });
  assert.equal(clash.grid[0][0].kind, "clash");
  const sheet = pr.classSectionsTimetableSheet("현1-3반", [model]);
  assert.equal(sheet.rows[0][0].v, model.title);
  assert.ok(sheet.rows.some((row) => row[0]?.v === "교시" && row[1]?.v === "월"));
});

// ---- 화면 연결(vm: 계산 + 화면 + 출력물) ----
function context({ twoSemesters = false } = {}) {
  const students = [];
  for (let c = 1; c <= 4; c += 1) for (let n = 1; n <= 10; n += 1) {
    const pick = (c + n) % 2 ? ["c1", "c2"] : ["c2", "c3"];
    students.push({ id: `${c}-${n}`, grade: "1", classroom: c, number: n, name: `가명${c}${n}`, selections: pick.map((column) => ({ column, credits: 3 })) });
  }
  const courses = [{ column: "c1", name: "물리학" }, { column: "c2", name: "화학" }, { column: "c3", name: "지구과학" }];
  const state = { rounds: { "1": { students, courses } }, currentRound: "1", roundStatuses: { "1": { status: "confirmed", snapshot: {
    maxClassSize: 30, classBases: { "2": 4 }, rows: [] } } }, roundClosures: {}, students: [] };
  const elements = { "#schoolYear": { value: "2026" }, "#maxClassSize": { value: "34" } };
  const downloads = [];
  const ctx = vm.createContext({
    state, performance, console, Blob, TextEncoder, Uint8Array,
    $: (selector) => elements[selector] || null,
    applicationRoundNumbers: () => ["1"],
    roundStatusData: (round) => state.rounds[round],
    isRoundLocked: (round) => state.roundStatuses[round]?.status === "confirmed",
    hoursDefaultDepartment: (name) => ({ 물리학: "과학-물리", 화학: "과학-화학", 지구과학: "과학-지구" })[name] || "기타",
    hoursSettings: () => ({ teachers: {} }), hoursTargetYear: () => "2027",
    aggregateRecords: (list) => ({ reports: [{ summary: { grade: "1", classes: 4 }, semesters: (twoSemesters ? [1, 2] : [1]).map((order) => ({ order, groups: [{ category: `2-${order} 택2`, choiceCount: 2,
      courses: courses.map((course) => ({ column: course.column, name: course.name, subjectName: course.name, classCount: 2,
        enrollment: list.filter((student) => student.selections.some((selection) => selection.column === course.column)).length })) }] })) }] }),
    createWorkbookBlob: (sheets) => ({ sheets }), downloadBlob: (blob, name) => downloads.push({ blob, name })
  });
  ctx.downloads = downloads;
  vm.runInContext(solverSource, ctx);
  vm.runInContext(viewSource, ctx);
  vm.runInContext(printSource, ctx);
  return ctx;
}

function solved(ctx, { times = true, sameClasses = true } = {}) {
  const group = ctx.classSectionsSource("1").groups[0];
  const entry = ctx.classSectionsEntry("1", group.key);
  if (times) { entry.blockTimes.a = "월1,수2"; entry.blockTimes.b = "화1,목2"; }
  const settings = ctx.classSectionsSettings();
  if (sameClasses) settings.promotion["1"] = "same";
  settings.rooms = { 과학실: 1 };
  ctx.classSectionsCourseConf(settings, "courseRooms", "1")["지구과학"] = "과학실";
  settings.teachers.push({ id: "t1", name: "김물리", department: "과학-물리" }, { id: "t2", name: "이화학", department: "과학-화학" }, { id: "t3", name: "박지구", department: "과학-지구" }, { id: "t4", name: "최화학", department: "과학-화학" });
  const input = ctx.classSectionsBuildInput("1", group, entry);
  const result = ctx.classSectionsSolve({ ...input, maxSectionsPerBlock: 4 });
  ctx.classSectionsSaveResult(entry, result, input, group, { locked: true });
  ctx.CLASS_SECTIONS_VIEW.round = "1";
  ctx.CLASS_SECTIONS_VIEW.group = group.key;
  return { group, entry, result: entry.sectionResult };
}

test("화면 연결: 교실 목록 기본값 = 내년 학급 수, 특별실 이름 입력, 교실 배정이 그룹 결과(직접 고른 값만 저장)·블록표 교실 열", () => {
  const ctx = context();
  const { group, entry, result } = solved(ctx);
  const settings = ctx.classSectionsPrintSettings();
  const spec = plain(ctx.classSectionsRoomSpecFromSettings(settings, ctx.classSectionsGradeClassCounts(ctx.classSectionsSource("1"))));
  assert.deepEqual(spec.classrooms, { "2": ["2-1", "2-2", "2-3", "2-4"] });
  assert.deepEqual(spec.special, { 과학실: ["과학실"] });
  settings.roomNames["과학실"] = "지구과학실, 물리실";
  settings.rooms["과학실"] = 2;
  const plan = ctx.classSectionsRoomPlan("1", "1");
  const assigned = result.sections.map((section) => plan.assign[group.key][section.id]);
  assert.ok(assigned.every(Boolean), "every section has a room");
  for (const block of result.blocks) {
    const ids = block.sectionIds.map((id) => plan.assign[group.key][id]);
    assert.equal(new Set(ids).size, ids.length, `${block.letter}: no room twice`);
  }
  for (const section of result.sections.filter((item) => item.courseKey === "지구과학")) assert.match(plan.assign[group.key][section.id], /^(지구과학실|물리실)$/);
  // 직접 고르기 → sectionResult.roomPins에만 저장(성명 없음), 겹치면 오류.
  const first = result.blocks[0].sectionIds;
  result.roomPins = { [first[0]]: "2-4", [first[1]]: "2-4" };
  const clash = ctx.classSectionsRoomPlan("1", "1");
  assert.ok(clash.issues.some((issue) => issue.type === "room-double"));
  assert.ok(!JSON.stringify(entry).includes("가명"));
  const html = ctx.classSectionsRoomCardHtml("1", group, result.sections.find((section) => section.id === first[0]));
  assert.match(html, /data-cs-room-pick=/);
  assert.match(html, /is-clash/);
  assert.match(ctx.classSectionsRoomSummaryHtml("1", group, result), /같은 블록 두 분반/);
  // 블록표 엑셀에 '교실' 열.
  result.roomPins = {};
  ctx.classSectionsExport("blocks");
  const sheet = ctx.downloads.at(-1).blob.sheets[0];
  assert.equal(sheet.rows[1][7], "교실");
  assert.ok(sheet.rows.slice(2).filter((row) => row.length > 6).every((row) => row[7]), "room column filled");
});

test("화면 연결: 출석부 인원 = 분반 명렬표, 성명은 차수 자료에서, 내년 반(그대로 올라감) 기준·모르면 경고", () => {
  const ctx = context();
  const { group, result } = solved(ctx);
  const { list, warnings } = ctx.classSectionsAttendanceInfos("1", group, "group");
  assert.equal(list.length, result.sections.length);
  assert.deepEqual(plain(warnings), []);
  const members = new Map(result.sections.map((section) => [section.id, 0]));
  for (const ids of Object.values(result.assign)) for (const id of ids) members.set(id, members.get(id) + 1);
  for (const info of list) {
    const section = result.sections.find((item) => item.roomName === info.roomName);
    assert.equal(info.students.length, members.get(section.id), `${info.roomName} head count = roster`);
    assert.ok(info.students.every((student) => /^가명\d+$/.test(student.name)));
    assert.ok(info.roomLabel, "room label");
    assert.equal(info.basis, "same");
    const sheet = ctx.classSectionsAttendanceSheet(info);
    assert.equal(sheet.rows.length - sheet.headerRow, info.students.length);
  }
  ctx.classSectionsSettings().promotion["1"] = "unknown";
  const unknown = ctx.classSectionsAttendanceInfos("1", group, "group");
  assert.equal(unknown.list[0].basis, "none");
  assert.match(unknown.warnings[0], /내년 반을 몰라/);
});

test("화면 연결: 학생 시간표 1·2학기 한 장 = 학기마다 그룹 배정 + 블록 시간 + 고정 시간(창체), 재신청 학생 표시, 학생 찾기로 미리 보기", () => {
  const ctx = context({ twoSemesters: true });
  const { group, result } = solved(ctx);
  // 2학기 그룹도 편성(블록 시간 없음 → 그 학기는 목록)
  const second = ctx.classSectionsSource("1").groups.find((item) => item.semester === "2");
  const entry2 = ctx.classSectionsEntry("1", second.key);
  const input2 = ctx.classSectionsBuildInput("1", second, entry2);
  ctx.classSectionsSaveResult(entry2, ctx.classSectionsSolve({ ...input2, maxSectionsPerBlock: 4 }), input2, second, { locked: true });
  const settings = ctx.classSectionsSettings();
  settings.fixedSlots.push({ label: "창체", times: "금6,금7", allTeachers: true });
  const key = Object.keys(result.assign)[0];
  const [model] = ctx.classSectionsTimetableModels("1", group, [key]);
  assert.equal(model.title, "2027학년도 · 현 1학년 → 2학년 이동수업 시간표");
  assert.match(model.student, new RegExp(`^${key} 가명\\d+ · 내년 2학년 \\d반$`));
  assert.deepEqual(plain(model.semesters.map((item) => item.semester)), ["1", "2"]);
  const [first, two] = model.semesters;
  assert.equal(first.grid.flat().filter((cell) => cell.kind === "move").length, result.assign[key].length * 2, "1학기: two periods per block");
  assert.equal(first.grid[5][4].kind, "fixed");
  assert.equal(two.grid, null, "2학기 블록 시간 없음 → 목록");
  assert.equal(two.untimed.length, entry2.sectionResult.assign[key].length);
  // 미배정 학생은 '재신청 필요'(학기 표시).
  result.unassigned.push({ studentKey: key, courseKey: "지구과학", reason: "capacity" });
  assert.deepEqual(plain(ctx.classSectionsTimetableModels("1", group, [key])[0].retake), [{ courseName: "지구과학", reason: "정원 부족", semester: "1" }]);
  ctx.CLASS_SECTIONS_VIEW.search = key;
  const html = ctx.classSectionsPrintButtonsHtml("1", group, result);
  assert.match(html, /id="classSectionsTimetablePreview"[\s\S]*재신청 필요: 1학기 지구과학/);
  assert.match(html, /data-semesters="2"[\s\S]*data-semester="1"[\s\S]*data-semester="2"/);
  assert.match(html, /aria-label="한 장에 학생 수"><option value="1" selected>1명<\/option><option value="2">2명<\/option>/);
  // 엑셀: 학생마다 두 학기
  const sheet = ctx.classSectionsTimetableSheet("현1-1반", [model]);
  assert.deepEqual(plain(sheet.rows.filter((row) => /^[12]학기$/.test(row[0]?.v || "")).map((row) => row[0].v)), ["1학기", "2학기"]);
  // 반 고르기: 그 반 학생만.
  ctx.CLASS_SECTIONS_PRINT_VIEW.timetableClass = "2";
  assert.ok(ctx.classSectionsTimetableKeysFor("1", group).every((item) => item.startsWith("1-2-")));
});

test("내보내기 전 경고: 교실을 고르지 않은 분반 수·자리 이름 교사(classSectionsTeacherNameWarnings가 있을 때)", () => {
  const ctx = context();
  const { group, result } = solved(ctx);
  const settings = ctx.classSectionsPrintSettings();
  settings.classrooms["2"] = { count: 1 }; // 교실 1개 → 블록마다 분반이 남는다
  const warnings = plain(ctx.classSectionsOutputWarnings("1", group));
  const room = warnings.find((item) => item.type === "room");
  assert.ok(room && room.count > 0 && /교실을 고르지 않은 분반 \d+개/.test(room.message));
  // 카드: 교실 선택 필요 + 후보(추천) + 새 교실 이름
  const plan = ctx.classSectionsRoomPlan("1", "1");
  const unplaced = result.sections.find((section) => !plan.assign[group.key][section.id]);
  const card = ctx.classSectionsRoomCardHtml("1", group, unplaced);
  assert.match(card, /교실 선택 필요/);
  assert.match(card, /data-cs-room-new=/);
  assert.match(ctx.classSectionsPrintButtonsHtml("1", group, result), /id="classSectionsOutputWarnings"/);
  // class-sections-teachers.js 모양: 안내 문장 배열 → 그대로
  const sentence = "실제 이름이 없는 교사 2명(사회(지리) 1, 과학(물리) 2) — 교사 명단에서 이름을 넣으세요.";
  ctx.classSectionsTeacherNameWarnings = () => [sentence];
  const both = plain(ctx.classSectionsOutputWarnings("1", group));
  assert.deepEqual(both.find((item) => item.type === "teacher"), { type: "teacher", count: 2, message: sentence });
  // 교사 객체 배열도 받는다
  ctx.classSectionsTeacherNameWarnings = () => [{ name: "사회(지리) 1" }];
  assert.match(plain(ctx.classSectionsOutputWarnings("1", group)).find((item) => item.type === "teacher").message, /실제 이름이 아닌 교사 1명\(사회\(지리\) 1\)/);
  // 교사 이름을 바꾸면 출석부·시간표에 새 이름(저장된 결과는 교사 id만 가짐)
  const teacherId = result.sections.find((section) => section.teacherId)?.teacherId;
  assert.ok(teacherId, "a section has a teacher");
  const teacher = ctx.classSectionsSettings().teachers.find((item) => item.id === teacherId);
  teacher.name = "새이름교사";
  const infos = ctx.classSectionsAttendanceInfos("1", group, "group").list.filter((info) => info.teacherId === teacherId);
  assert.ok(infos.length && infos.every((info) => info.teacherName === "새이름교사"));
  const key = Object.keys(result.assign).find((item) => result.assign[item].some((id) => result.sections.find((section) => section.id === id)?.teacherId === teacherId));
  const [model] = ctx.classSectionsTimetableModels("1", group, [key]);
  assert.ok(model.semesters[0].grid.flat().some((cell) => cell.lines.includes("새이름교사")));
});

test("createWorkbookBlob: printTitles가 있으면 시트별 인쇄 제목 줄(_xlnm.Print_Titles)", () => {
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const start = app.indexOf("    function createWorkbookBlob(");
  const source = app.slice(start, app.indexOf("    function downloadBlob(", start));
  const ctx = vm.createContext({ createXlsxBlob: (files) => files, createReportStylesXml: () => "REPORT",
    xmlEscape: (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    columnName: (index) => String.fromCharCode(65 + index) });
  vm.runInContext(`${source}; this.createWorkbookBlob = createWorkbookBlob;`, ctx);
  const files = ctx.createWorkbookBlob([{ name: "a물리학1", rows: [["x"]], printTitles: "$1:$6" }, { name: "plain", rows: [["y"]] }]);
  assert.match(files["xl/workbook.xml"], /<definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">'a물리학1'!\$1:\$6<\/definedName><\/definedNames>/);
  assert.doesNotMatch(ctx.createWorkbookBlob([{ name: "x", rows: [] }])["xl/workbook.xml"], /definedNames/);
});

test("출석부 저장 묶음: 전체 파일 = 목록 + 분반마다 시트(시트 이름 = 강의실 이름, 학년 겹침은 학년 붙임), 학급별 = 분반마다 파일, 화면 표 = 엑셀 칸", () => {
  const base = { year: "2027", semester: "1", grade: "1", targetGrade: "2", groupCategory: "2-1 택3", basis: "map", times: ["월:1"], roomLabel: "2학년 1반", teacherName: "김교사" };
  const infos = [
    { ...base, courseName: "물리학", roomName: "a물리학1", blockLetter: "a", students: [{ key: "1-1-1", classroom: "1", number: "1", name: "가명A" }, { key: "1-1-2", classroom: "1", number: "2", name: "가명B" }] },
    { ...base, courseName: "화학", roomName: "b화학", blockLetter: "b", students: [{ key: "1-2-1", classroom: "2", number: "1", name: "가명C" }] },
    { ...base, grade: "2", targetGrade: "3", groupCategory: "3-1 택5", courseName: "화학", roomName: "b화학", blockLetter: "b", students: [] }];
  const [file] = pr.classSectionsAttendanceBundles(infos, "file");
  assert.equal(file.name, "2027_1학기_이동출석부_전체.xlsx");
  assert.equal(file.sheets.length, infos.length + 1, "목록 + 분반 수");
  assert.deepEqual(file.sheets.map((sheet) => sheet.name), ["목록", "a물리학1", "2학년 b화학", "3학년 b화학"]);
  const list = file.sheets[0];
  assert.deepEqual(list.rows[1].map((cell) => cell.v), ["번호", "시트(강의실)", "수업 학년", "학기", "그룹", "과목", "교시", "교실", "교사", "인원"]);
  assert.deepEqual(list.rows.slice(2).map((row) => [row[1].v, row[9].v]), [["a물리학1", 2], ["2학년 b화학", 1], ["3학년 b화학", 0]]);
  const sections = pr.classSectionsAttendanceBundles(infos, "sections");
  assert.equal(sections.length, infos.length, "학급별 파일 수 = 분반 수");
  assert.deepEqual(plain(sections.map((item) => item.name)), plain(pr.classSectionsAttendanceBundles(infos, "all").map((item) => item.name)), "예전 이름 'all'도 같은 묶음");
  // 화면 표: 같은 시트 모델 → 칸 글자가 엑셀 행과 같다(병합은 colspan).
  const sheet = pr.classSectionsAttendanceSheet(infos[0], { days: 5 });
  const html = pr.classSectionsSheetHtml(sheet, { keys: sheet.studentKeys, highlight: ["1-1-2"] });
  const cellsOf = (row) => [...row.matchAll(/<(?:td|th)[^>]*>([^<]*)<\/(?:td|th)>/g)].map((m) => m[1]);
  const htmlRows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => cellsOf(m[1]));
  const sheetRows = sheet.rows.map((row) => row.map((cell) => String(cell.v ?? "")));
  assert.equal(htmlRows.length, sheetRows.length);
  assert.deepEqual(htmlRows[0], [sheetRows[0][0]], "title merged across");
  assert.deepEqual(htmlRows[1], ["교시", sheetRows[1][2]], "info rows: label (A:B) + value (C:end)");
  for (let r = sheet.headerRow - 1; r < sheetRows.length; r += 1) assert.deepEqual(htmlRows[r], sheetRows[r], `row ${r + 1} = excel row`);
  assert.match(html, /<thead>[\s\S]*순서[\s\S]*<\/thead>/, "header rows in thead (repeat on print)");
  assert.match(html, /<tr data-student="1-1-2" class="is-found">/);
});

test("화면 연결: 출석부 보기(이 그룹/학기 전체, 앞·뒤, 학생 찾기 연결, 재신청 안내) · 인쇄 분반마다 한 장 · 저장 단추", () => {
  const ctx = context();
  const { group, result } = solved(ctx);
  const html = ctx.classSectionsPrintButtonsHtml("1", group, result);
  for (const id of ["classSectionsAttendanceFile", "classSectionsAttendanceAll", "classSectionsAttendanceTeacher", "classSectionsAttendanceGroup", "classSectionsAttendanceView",
    "classSectionsAttendancePick", "classSectionsAttendancePrev", "classSectionsAttendanceNext", "classSectionsAttendanceTable", "classSectionsAttendancePrintOne", "classSectionsAttendancePrintGroup", "classSectionsAttendancePrintSemester"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, />출석부 전체 파일</);
  assert.match(html, />출석부 분반별 파일\(zip\)</);
  const { list } = ctx.classSectionsAttendanceInfos("1", group, "group");
  assert.equal((html.match(/<option value="1:1:2-1 택2\|/g) || []).length, list.length, "분반 목록 = 분반 수");
  // 학생 찾기: 그 학생이 있는 분반으로, 표에서 강조.
  const key = Object.keys(result.assign).find((item) => result.assign[item].length);
  ctx.CLASS_SECTIONS_VIEW.search = key;
  const found = ctx.classSectionsPrintButtonsHtml("1", group, result);
  assert.match(found, new RegExp(`<tr data-student="${key}" class="is-found">`));
  assert.match(found, /id="classSectionsAttendanceStudent"/);
  // 재신청 안내: 그 분반 과목의 미배정 학생.
  ctx.CLASS_SECTIONS_VIEW.search = "";
  const info = list[0];
  result.unassigned.push({ studentKey: "1-4-10", courseKey: info.courseKey, reason: "capacity" });
  ctx.CLASS_SECTIONS_PRINT_VIEW.attPick = `${info.groupKey}|${info.sectionId}`;
  assert.match(ctx.classSectionsPrintButtonsHtml("1", group, result), /id="classSectionsAttendanceRetake" data-count="1">재신청·미배정 1명은 이 출석부\([^)]*\)에 없습니다: 1-4-10\(정원 부족\)/);
  // 인쇄: 분반마다 .print-page 한 장
  const printBatch = { innerHTML: "" };
  ctx.document = { getElementById: (id) => (id === "printBatch" ? printBatch : null) };
  ctx.classSectionsSetStatus = () => {};
  ctx.classSectionsAttendancePrint("group");
  assert.equal((printBatch.innerHTML.match(/class="print-page cs-att-page"/g) || []).length, list.length);
  ctx.classSectionsAttendancePrint("one");
  assert.equal((printBatch.innerHTML.match(/class="print-page cs-att-page"/g) || []).length, 1);
});

test("담임학급별: 내년 반 기준(모르면 현재 반 + 경고), 반 학생 수 = 명단, 칸 = 배정 결과, 분반 출석부는 그 반 학생만, 반 수 = 파일 수", () => {
  const base = { year: "2027", semester: "1", grade: "1", targetGrade: "2", groupCategory: "2-1 택2", basis: "map", roomLabel: "2학년 1반", teacherName: "김교사" };
  const infos = [
    { ...base, groupKey: "g1", sectionId: "물#1", blockId: "a", blockLetter: "a", times: ["월:1"], courseName: "물리학", roomName: "a물리학",
      students: [{ key: "1-1-1", classroom: "3", number: "2", name: "가명A" }, { key: "1-2-5", classroom: "1", number: "1", name: "가명B" }] },
    { ...base, groupKey: "g1", sectionId: "화#1", blockId: "b", blockLetter: "b", times: ["화:1"], courseName: "화학", roomName: "b화학",
      students: [{ key: "1-1-1", classroom: "3", number: "2", name: "가명A" }] },
    { ...base, grade: "2", targetGrade: "3", groupKey: "g2", sectionId: "경#1", blockId: "a", blockLetter: "a", times: ["월:1"], courseName: "경제", roomName: "a경제", basis: "none",
      students: [{ key: "2-4-7", classroom: "", number: "", name: "가명C" }] }];
  const roster = [
    { key: "1-1-1", grade: "1", targetGrade: "2", classroom: "3", number: "2", name: "가명A", basis: "map" },
    { key: "1-2-5", grade: "1", targetGrade: "2", classroom: "1", number: "1", name: "가명B", basis: "map" },
    { key: "1-2-9", grade: "1", targetGrade: "2", classroom: "3", number: "1", name: "가명D", basis: "map" },
    { key: "2-4-7", grade: "2", targetGrade: "3", classroom: "", number: "", name: "가명C", basis: "none" }];
  const extras = { "1-2-9": { unit: ["정보"], retake: [{ courseName: "화학", reason: "정원 부족" }] } };
  const homerooms = pr.classSectionsHomerooms(infos, roster, extras);
  assert.deepEqual(homerooms.map((item) => [item.label, item.students.length]), [["내년 2학년 1반", 1], ["내년 2학년 3반", 2], ["현 2학년 4반", 1]]);
  const three = homerooms[1];
  assert.deepEqual(three.students.map((item) => item.key), ["1-2-9", "1-1-1"], "sorted by next-year number");
  assert.deepEqual(three.columns.map((col) => col.blockLetter), ["a", "b"]);
  assert.deepEqual(plain(three.students[1].cells["g1|a"]), { courseName: "물리학", roomName: "a물리학", roomLabel: "2학년 1반", teacher: "김교사" });
  const sheet = pr.classSectionsHomeroomStatusSheet(three);
  assert.equal(sheet.rows[0][0].v, "내년 2학년 3반 이동수업 현황");
  assert.equal(sheet.orientation, "landscape");
  const header = sheet.rows[sheet.headerRow - 1].map((cell) => cell.v);
  assert.deepEqual(header, ["번호", "현 학년-반-번호", "성명", "2-1 택2 a블록\n월1", "2-1 택2 b블록\n화1", "학급 단위", "재신청·미배정"]);
  assert.equal(sheet.rows.length - sheet.headerRow, three.students.length, "반 학생 수 = 명단");
  const d = sheet.rows[sheet.headerRow].map((cell) => cell.v);
  assert.deepEqual(d, [1, "1-2-9", "가명D", "", "", "정보", "화학(정원 부족)"]);
  assert.equal(sheet.rows[sheet.headerRow + 1][3].v, "물리학 a물리학\n2학년 1반 · 김교사");
  // 현재 반 기준 경고
  const now = pr.classSectionsHomeroomStatusSheet(homerooms[2]);
  assert.match(now.rows[2][0].v, /내년 반 미정 — 현재 반 기준/);
  // ② 그 반 학생만 추린 분반 출석부
  const att = pr.classSectionsHomeroomAttendanceSheets(three);
  assert.deepEqual(att.map((item) => [item.name, item.studentCount]), [["a물리학", 1], ["b화학", 1]]);
  assert.match(att[0].rows[4][0].v, /내년 2학년 3반 학생만 1\/2명/);
  // 저장: 담임학급별 파일 = 반마다 파일(①+②), 전체 파일 = 목록 + 반마다 ①
  const files = pr.classSectionsAttendanceBundles(infos, "homeroom", { homerooms });
  assert.equal(files.length, homerooms.length, "반 수 = 파일 수");
  assert.deepEqual(files[1].sheets.map((item) => item.name), ["이동수업 현황", "a물리학", "b화학"]);
  assert.equal(files[1].name, "2027_1학기_담임학급_내년2학년3반_출석부.xlsx");
  const [all] = pr.classSectionsAttendanceBundles(infos, "homeroomFile", { homerooms });
  assert.deepEqual(all.sheets.map((item) => item.name), ["목록", "2-1반", "2-3반", "현2-4반"]);
  assert.equal(all.sheets[0].rows.length - 2, homerooms.length);
});

test("화면 연결: 담임반 범위(반 고르기·앞뒤·학생 찾기) · 칸 = 배정 결과 · 저장 단추 · 인쇄(반마다 가로 현황 + 그 반 분반 출석부)", () => {
  const ctx = context();
  const { group, result } = solved(ctx);
  ctx.CLASS_SECTIONS_PRINT_VIEW.attScope = "homeroom";
  const html = ctx.classSectionsPrintButtonsHtml("1", group, result);
  for (const id of ["classSectionsHomeroomPick", "classSectionsHomeroomTable", "classSectionsHomeroomPrintOne", "classSectionsHomeroomPrintGrade", "classSectionsAttendanceHomeroom", "classSectionsAttendanceHomeroomFile"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  const { homerooms } = ctx.classSectionsHomeroomData("1", group);
  assert.equal(homerooms.length, 4, "내년 2학년 4반(그대로 올라감)");
  assert.equal(homerooms.reduce((n, item) => n + item.students.length, 0), group.gradeStudents.length, "모든 학생이 한 반에");
  // 칸 = 배정 결과
  const byId = new Map(result.sections.map((section) => [section.id, section]));
  for (const homeroom of homerooms) for (const student of homeroom.students) {
    const want = (result.assign[student.key] || []).map((id) => byId.get(id).roomName).sort();
    const got = Object.values(student.cells).map((cell) => cell.roomName).sort();
    assert.deepEqual(plain(got), plain(want), student.key);
  }
  // 학생 찾기 → 그 학생의 반, 강조
  ctx.CLASS_SECTIONS_VIEW.search = "1-3-4";
  assert.match(ctx.classSectionsPrintButtonsHtml("1", group, result), /<tr data-student="1-3-4" class="is-found">/);
  ctx.CLASS_SECTIONS_VIEW.search = "";
  // 인쇄: 이 반 = 현황 1장 + 그 반 분반 출석부, 학년 전체 = 4개 반
  const printBatch = { innerHTML: "" };
  ctx.document = { getElementById: (id) => (id === "printBatch" ? printBatch : null) };
  ctx.classSectionsSetStatus = () => {};
  ctx.classSectionsHomeroomPrint("one");
  assert.equal((printBatch.innerHTML.match(/class="print-page cs-hr-page"/g) || []).length, 1);
  assert.equal((printBatch.innerHTML.match(/class="print-page cs-att-page"/g) || []).length, homerooms[0].sections.length);
  ctx.classSectionsHomeroomPrint("grade");
  assert.equal((printBatch.innerHTML.match(/class="print-page cs-hr-page"/g) || []).length, 4);
  ctx.CLASS_SECTIONS_PRINT_VIEW.attScope = "group";
});

test("교사 이름 경고: 진짜 class-sections-teachers.js와 함께 — 자리 이름 교사 62명 문장이 그대로(중첩 없음)", () => {
  const ctx = context();
  vm.runInContext(fs.readFileSync(path.join(root, "class-sections-teachers.js"), "utf8"), ctx);
  const { group } = solved(ctx);
  const settings = ctx.classSectionsSettings();
  settings.teachers.splice(0, settings.teachers.length);
  for (let n = 1; n <= 62; n += 1) settings.teachers.push({ id: `t-사회-지리-${n}`, name: `사회-지리 ${n}`, department: "사회-지리", unavailable: [] });
  const real = plain(ctx.classSectionsTeacherNameWarnings());
  assert.equal(real.length, 1);
  assert.match(real[0], /^실제 이름이 없는 교사 62명\(/);
  const teacher = plain(ctx.classSectionsOutputWarnings("1", group)).filter((item) => item.type === "teacher");
  assert.equal(teacher.length, 1);
  assert.equal(teacher[0].message, real[0], "sentence shown as is");
  assert.equal(teacher[0].count, 62);
  assert.doesNotMatch(teacher[0].message, /교사 1명\(/, "no nesting");
  assert.doesNotMatch(teacher[0].message, /실제 이름이 아닌 교사/);
});

test("담임반 현황 명단: 명렬만 / 배정표만 / 둘 다 / 둘 다 없음 — 반 학생 수 합 = 명단, 미제출·성명·내년 반·명렬에 없는 학생, 분반 출석부는 배정 학생만", () => {
  const ctx = context();
  const { group } = solved(ctx, { sameClasses: false });
  const result = () => ctx.classSectionsEntry("1", group.key).sectionResult;
  const sum = (data) => data.homerooms.reduce((n, item) => n + item.students.length, 0);
  const view = (pick) => { ctx.CLASS_SECTIONS_PRINT_VIEW.attScope = "homeroom"; ctx.CLASS_SECTIONS_PRINT_VIEW.attPick = pick || ""; return ctx.classSectionsPrintButtonsHtml("1", group, result()); };
  // 명렬: 결과 40명 중 39명(1-4-10은 전입 → 명렬에 없음) + 미제출 3명(반마다 11번, 성명은 명렬에서)
  const rosterStudents = group.gradeStudents.filter((student) => student.key !== "1-4-10").map((student) => ({ key: student.key, classroom: student.homeroom, number: student.number, name: "" }));
  for (const c of [1, 2, 3]) rosterStudents.push({ key: `1-${c}-11`, classroom: String(c), number: "11", name: `명렬${c}` });
  const roster = { students: rosterStudents, uploadedAt: "2026-11-10T03:00:00Z", source: "명렬.xlsx" };
  // 배정표: 결과 40명 + 미제출 2명(1-1-11, 1-2-11)만
  const map = {};
  for (const student of group.gradeStudents) map[student.key] = { classroom: String(((Number(student.homeroom) + Number(student.number)) % 4) + 1), number: student.number };
  for (const c of [1, 2]) map[`1-${c}-11`] = { classroom: String(c), number: "20" };

  // ① 둘 다 없음: 결과 40명만, '미제출 확인 불가'(명렬 올리기는 import 함수가 있을 때만)
  let data = ctx.classSectionsHomeroomData("1", group);
  assert.equal(sum(data), 40);
  assert.equal(data.unsubmitted["1"], null);
  assert.match(view(), /미제출 확인 불가 — 현 1학년 명렬·내년 반 배정표가 없어/);
  assert.doesNotMatch(view(), /classSectionsRosterInput/);
  ctx.importApplicationRosterFile = async () => {};
  assert.match(view(), /id="classSectionsRosterInput" type="file" accept=".xlsx" data-grade="1"/);

  // ② 명렬만(진급 반 '아직 모름' → 내년 반 미정 = 현재 반 기준): 합 = 명렬 42 + 명렬에 없는 1 = 43, 미제출 3, 성명은 명렬에서
  ctx.applicationRosterFor = (grade) => (grade === "1" ? roster : null);
  data = ctx.classSectionsHomeroomData("1", group);
  assert.equal(sum(data), 43, "명렬 + 명렬에 없는 결과 학생");
  assert.equal(data.unsubmitted["1"], 3);
  assert.equal(data.rosterInfo["1"].notInRoster, 1);
  const s11 = data.homerooms.flatMap((item) => item.students).find((student) => student.key === "1-3-11");
  assert.equal(s11.name, "명렬3");
  assert.ok(s11.unsubmitted);
  assert.ok(data.homerooms.every((item) => item.basis === "none"), "내년 반 미정 → 현재 반");
  const rosterNote = view(data.homerooms[0].id);
  assert.match(rosterNote, /data-basis="roster">이 반 학생 \d+명 · 미제출 1명 \(현 1학년 미제출 3명 · 명렬 2026\. 11\. 10\. 기준 · 명렬에 없는 학생 1명/);
  // '그대로 올라감'이면 명렬의 지금 반 = 내년 반
  ctx.classSectionsSettings().promotion["1"] = "same";
  data = ctx.classSectionsHomeroomData("1", group);
  assert.equal(sum(data), 43);
  assert.ok(data.homerooms.every((item) => item.basis === "same"));
  assert.equal(data.homerooms.find((item) => item.room === "3").students.filter((student) => student.unsubmitted).length, 1);
  ctx.classSectionsSettings().promotion["1"] = "unknown";

  // ③ 배정표만: 합 = 배정표 42, 미제출 2(성명 없음)
  ctx.applicationRosterFor = () => null;
  ctx.state.classSections.classMaps = { "1": map };
  data = ctx.classSectionsHomeroomData("1", group);
  assert.equal(sum(data), Object.keys(map).length);
  assert.equal(data.unsubmitted["1"], 2);
  const room = data.homerooms.find((item) => item.students.some((student) => student.key === "1-2-11"));
  const sheet = ctx.classSectionsHomeroomStatusSheet(room);
  assert.match(sheet.rows[1][0].v, /미제출 \d+명 \(내년 반 배정표 기준\)/);
  const row = sheet.rows.slice(sheet.headerRow).find((cells) => cells[1].v === "1-2-11");
  assert.equal(row.at(-1).v, "미제출");
  assert.ok(row.slice(3, -2).every((cell) => cell.v === ""), "블록 칸은 비움");
  for (const info of room.sections) assert.ok(!info.students.some((student) => student.key === "1-2-11"), "분반 출석부에는 배정된 학생만");

  // ④ 둘 다: 명렬 기준(미제출 3), 내년 반은 배정표(1-3-11은 배정표에 없음 → 내년 반 미정), 성명은 명렬
  ctx.applicationRosterFor = (grade) => (grade === "1" ? roster : null);
  data = ctx.classSectionsHomeroomData("1", group);
  assert.equal(sum(data), 43);
  assert.equal(data.unsubmitted["1"], 3);
  const all = data.homerooms.flatMap((item) => item.students.map((student) => ({ ...student, homeroom: item })));
  assert.equal(all.find((student) => student.key === "1-3-11").homeroom.basis, "none", "명렬에 있고 배정표에 없음 → 내년 반 미정");
  assert.equal(all.find((student) => student.key === "1-1-11").homeroom.label, "내년 2학년 1반");
  assert.equal(all.find((student) => student.key === "1-1-11").name, "명렬1");
  assert.match(ctx.classSectionsHomeroomStatusSheet(all.find((student) => student.key === "1-1-11").homeroom).rows[1][0].v, /명렬 2026\. 11\. 10\. 기준/);
  ctx.CLASS_SECTIONS_PRINT_VIEW.attScope = "group";
  ctx.CLASS_SECTIONS_PRINT_VIEW.attPick = "";
});

// ---- 담임용 두 장 인쇄 · 학생 배부용 쪽지 ----
// 합성 담임반: 학생 n명, 블록 열 k개(칸 = '과목 강의실\n교실 · 교사'), 재신청 학생 retake명.
function syntheticHomeroom(n, k, { retake = 0, unit = false, basis = "map" } = {}) {
  const columns = Array.from({ length: k }, (_, i) => ({ key: `g|${i}`, groupKey: "g", groupCategory: "2-1 택3", blockLetter: String.fromCharCode(65 + i), times: ["월:1", "수:3"], order: 0 }));
  const students = Array.from({ length: n }, (_, i) => ({ key: `1-3-${i + 1}`, number: String(i + 1), name: `가명${i + 1}`, unsubmitted: false,
    unit: unit && i === 0 ? ["정보"] : [], retake: i < retake ? [{ courseName: "화학", reason: "정원 부족" }] : [],
    cells: Object.fromEntries(columns.map((col, c) => [col.key, { courseName: `과목${c}물리`, roomName: `${col.blockLetter}과목${c}물리1`, roomLabel: "2학년 3반", teacher: "김교사" }])) }));
  return { id: `1|next|3`, year: "2027", semester: "1", grade: "1", targetGrade: "2", room: "3", basis, label: "내년 2학년 3반", students, columns, sections: [], unsubmitted: 0, rosterBasis: "명렬 기준" };
}

test("담임용 이동수업 현황: 31명 → 두 장(16 + 15), 쪽마다 제목·부제·머리글 반복 + 1/2·2/2, 적으면 한 장, 블록 열이 많으면 최대 세 장", () => {
  const homeroom = syntheticHomeroom(31, 4);
  const plan = pr.classSectionsHomeroomStatusPlan(homeroom);
  assert.equal(plan.pages, 2);
  assert.deepEqual(plan.parts.map((part) => part.to - part.from), [16, 15]);
  assert.equal(plan.fontPt, 9);
  const pages = pr.classSectionsHomeroomStatusPages(homeroom);
  assert.deepEqual(pages.map((sheet) => sheet.pageLabel), ["1/2", "2/2"]);
  for (const sheet of pages) {
    assert.equal(sheet.rows[0][0].v, "내년 2학년 3반 이동수업 현황", "제목 반복");
    assert.match(sheet.rows[1][0].v, /학생 31명/, "부제 반복(반 전체 인원)");
    assert.equal(sheet.rows[sheet.headerRow - 1][0].v, "번호", "머리글 반복");
    assert.equal(sheet.orientation, "landscape");
  }
  assert.deepEqual(pages.map((sheet) => sheet.rows.length - sheet.headerRow), [16, 15]);
  assert.deepEqual(plain(pages.flatMap((sheet) => sheet.studentKeys)), homeroom.students.map((student) => student.key), "번호순으로 빠짐없이");
  assert.equal(pages[1].rows[pages[1].headerRow][0].v, 17, "둘째 쪽은 17번부터");
  // 엑셀: 나누지 않은 시트 하나 + 같은 자리 수동 쪽 나눔 + 배율 90% 이상(10pt 글자 → 9pt 이상) + 머리글 반복 + 쪽 번호
  const sheet = pr.classSectionsHomeroomStatusSheet(homeroom);
  assert.equal(sheet.rows.length - sheet.headerRow, 31);
  assert.deepEqual(plain(sheet.rowBreaks), [sheet.headerRow + 16]);
  assert.ok(sheet.scale >= 90 && sheet.scale <= 100, `scale ${sheet.scale}`);
  assert.equal(sheet.printTitles, `$1:$${sheet.headerRow}`);
  assert.equal(sheet.headerText, "&R&P/&N");
  assert.equal(sheet.printPlan.overflow, false);
  // 한 쪽에 들어가는 높이(어림, pt): 제목·부제·머리글 + 학생 줄
  const C = pr.CLASS_SECTIONS_HR_PRINT || vm.runInNewContext(`${printSource}; CLASS_SECTIONS_HR_PRINT`, { console });
  const used = plan.headerPt + homeroom.students.slice(0, 16).length * (plan.maxLines * C.linePt + C.padPt);
  assert.ok(used <= C.pagePt, `첫 쪽 높이 ${used}pt ≤ ${C.pagePt}`);
  // 한 쪽 줄 수: 칸이 두 줄이면 한 쪽 19명 → 38명도 두 장(19 + 19), 39명부터 세 장. 쪽 나눔은 쪽마다 줄 높이 합으로 판단.
  const big = pr.classSectionsHomeroomStatusPlan(syntheticHomeroom(38, 3));
  assert.equal(big.maxLines, 2);
  assert.deepEqual(big.parts.map((part) => part.to - part.from), [19, 19]);
  assert.equal(pr.classSectionsHomeroomStatusPlan(syntheticHomeroom(39, 3)).pages, 3);
  // 한 학생만 세 줄(재신청 사유가 길어도)이면 그 쪽만 조금 줄어들 뿐 쪽 수는 같다
  const one = syntheticHomeroom(36, 3);
  one.students[0].retake = [{ courseName: "인공지능 기초와 활용 심화", reason: "정원 부족" }, { courseName: "화학", reason: "정원 부족" }];
  assert.equal(pr.classSectionsHomeroomStatusPlan(one).pages, 2);
  // 인쇄는 브라우저에서 잰 높이(measure)로 나눔: 머리 25mm + 학생 줄 8mm, 한 쪽 187mm → 한 쪽 20명, 엑셀(어림)은 따로
  const wideReal = syntheticHomeroom(38, 4);
  const estimatePages = pr.classSectionsHomeroomStatusPlan(wideReal).pages;
  const measuredPages = pr.classSectionsHomeroomStatusPages(wideReal, { measure: (sheet) => ({ header: 25, rows: sheet.studentKeys.map(() => 8), page: 187 }) });
  assert.deepEqual(measuredPages.map((sheet) => sheet.studentKeys.length), [19, 19]);
  assert.ok(estimatePages >= measuredPages.length, `엑셀 어림 ${estimatePages}쪽 ≥ 인쇄 ${measuredPages.length}쪽`);
  assert.equal(pr.classSectionsHomeroomStatusPages(syntheticHomeroom(41, 4), { measure: (sheet) => ({ header: 25, rows: sheet.studentKeys.map(() => 8), page: 187 }) }).length, 3);
  assert.equal(pr.classSectionsHomeroomStatusPages(syntheticHomeroom(31, 4), { measure: () => null }).length, pr.classSectionsHomeroomStatusPlan(syntheticHomeroom(31, 4)).pages, "잴 수 없으면 어림");
  // 적으면 한 장
  const small = pr.classSectionsHomeroomStatusPages(syntheticHomeroom(14, 4));
  assert.deepEqual(small.map((item) => item.pageLabel), ["1/1"]);
  assert.deepEqual(plain(pr.classSectionsHomeroomStatusSheet(syntheticHomeroom(14, 4)).rowBreaks), []);
  // 블록 열 6개(택5 등): 1단계(9pt 두 줄)는 세 장 → 두 장을 넘으면 overflow, 단계 고르기는 한 줄 칸으로 두 장 안
  const wide = pr.classSectionsHomeroomStatusPlan(syntheticHomeroom(31, 6));
  assert.ok(wide.maxLines > 2, `접힘 ${wide.maxLines}줄`);
  assert.equal(wide.pages, 3);
  assert.equal(wide.overflow, true, "두 장 넘음");
  assert.ok(wide.parts.every((part) => part.to - part.from <= wide.rowsPerPage));
  const wideChosen = pr.classSectionsHomeroomStatusChoose(syntheticHomeroom(31, 6));
  assert.ok(wideChosen.plan.pages <= 2 && wideChosen.mode.level >= 2, `단계 ${wideChosen.mode.level} · ${wideChosen.plan.pages}장`);
  // 블록 열 10개 31명은 한 줄 칸으로 두 장 안, 90명처럼 8pt 한 줄로도 안 되면 그대로 더 나누고 overflow로 알림(8pt 아래로 안 줄임)
  assert.ok(pr.classSectionsHomeroomStatusChoose(syntheticHomeroom(31, 10)).plan.pages <= 2);
  const huge = pr.classSectionsHomeroomStatusChoose(syntheticHomeroom(90, 10));
  assert.deepEqual([huge.mode.level, huge.mode.fontPt], [3, 8]);
  assert.ok(huge.plan.pages > 2 && huge.plan.overflow);
  assert.ok(huge.plan.parts.every((part) => part.to - part.from <= huge.plan.rowsPerPage));
});

// 3학년 택5 + 택1(블록 열 6개, 긴 과목명·자리 이름 교사): 하네스에서 반당 3~4쪽이던 경우
function seniorHomeroom(n) {
  const groups = [...["a", "b", "c", "d", "e"].map((letter) => ({ groupKey: "g5", groupCategory: "3-1 택5", blockLetter: letter })), { groupKey: "g1", groupCategory: "3-1 택1", blockLetter: "a" }];
  const columns = groups.map((item, i) => ({ key: `${item.groupKey}|${item.blockLetter}`, ...item, times: ["월:1", "화:3", "목:2"], order: item.groupKey === "g5" ? 0 : 1, i }));
  const names = ["인공지능 기초와 활용", "세계시민과 지리", "동아시아 역사 기행", "물질과 에너지", "기하", "미적분Ⅱ"];
  const students = Array.from({ length: n }, (_, i) => ({ key: `2-4-${i + 1}`, number: String(i + 1), name: `가명${i + 1}`, unsubmitted: false, unit: [], retake: [],
    cells: Object.fromEntries(columns.map((col, c) => {
      const course = names[(c + i) % names.length];
      return [col.key, { courseName: course, roomName: `${col.blockLetter}${course.replace(/\s/g, "")}${1 + (i % 2)}`, roomLabel: `3학년 ${1 + ((i + c) % 11)}반`, teacher: `과학(물리) ${1 + (i % 3)}` }];
    })) }));
  return { id: "2|next|4", year: "2027", semester: "1", grade: "2", targetGrade: "3", room: "4", basis: "map", label: "내년 3학년 4반", students, columns, sections: [], unsubmitted: 0 };
}

test("담임용 현황 단계: 3학년 택5 + 택1 → 9pt 두 줄은 두 장 넘음 → 한 줄 칸 '과목 · 교실' + 범례로 두 장 안, 엑셀도 같은 단계", () => {
  const homeroom = seniorHomeroom(30);
  const one = pr.classSectionsHomeroomStatusPlan(homeroom, pr.classSectionsHomeroomStatusLayout(homeroom, { level: 1, compact: false, fontPt: 9 }));
  assert.ok(one.pages > 2, `1단계 ${one.pages}장`);
  const chosen = pr.classSectionsHomeroomStatusChoose(homeroom);
  assert.ok(chosen.plan.pages <= 2, `${chosen.mode.level}단계 ${chosen.plan.pages}장`);
  assert.equal(chosen.mode.compact, true);
  // 한 줄 칸 = '과목 · 교실(3-11)'(9pt 단계는 약칭 없음, 8pt 단계만 칸에 안 들어가면 약칭), 범례 = 분반마다 한 번 '강의실(과목 전체, 교실) → 선생님'
  const cells = chosen.layout.body.flatMap((row) => row.slice(3, 9));
  assert.ok(cells.every((text) => !text.includes("\n") && / · \d+-\d+$/.test(text)), cells.slice(0, 3).join(" / "));
  const nine = pr.classSectionsHomeroomStatusLayout(homeroom, { level: 2, compact: true, fontPt: 9 });
  assert.ok(nine.body.some((row) => row.includes("인공지능 기초와 활용 · 3-5") || row.some((text) => /^인공지능 기초와 활용 · /.test(text))), "9pt 한 줄 칸은 전체 과목명");
  const eight = pr.classSectionsHomeroomStatusLayout(homeroom, { level: 3, compact: true, fontPt: 8, short: true });
  const longCell = eight.body.flatMap((row) => row.slice(3, 9)).find((text) => !/^인공지능 기초와 활용 · /.test(text) && /^인/.test(text));
  assert.ok(!longCell || longCell.length < "인공지능 기초와 활용 · 3-10".length, `8pt 단계 약칭 ${longCell}`);
  const legendText = chosen.layout.legend.join(" ");
  assert.match(legendText, /^범례 — 강의실\(과목, 교실\) → 선생님:/);
  const sections = new Set(homeroom.students.flatMap((student) => Object.entries(student.cells).map(([key, cell]) => `${key}|${cell.roomName}`)));
  assert.equal((legendText.match(/ → 과학\(물리\) \d/g) || []).length, sections.size, "분반마다 한 번");
  assert.match(legendText, /a인공지능기초와활용1\(인공지능 기초와 활용, 3-\d+\) → 과학\(물리\) \d/, "범례에는 전체 이름");
  // 인쇄 쪽: 범례는 마지막 쪽 표 아래에만, 글자 크기 표시
  const pages = pr.classSectionsHomeroomStatusPages(homeroom);
  assert.ok(pages.length <= 2);
  assert.deepEqual(pages.map((sheet) => sheet.legendRows > 0), pages.map((_, i) => i === pages.length - 1));
  assert.ok(pages.every((sheet) => sheet.fontPt === chosen.mode.fontPt && sheet.level === chosen.mode.level));
  assert.deepEqual(plain(pages.flatMap((sheet) => sheet.studentKeys)), homeroom.students.map((student) => student.key));
  // 엑셀 시트: 같은 단계, 범례 행(표 폭 병합), 배율 = 9pt 단계 90% 이상 / 8pt 단계 80% 이상
  const sheet = pr.classSectionsHomeroomStatusSheet(homeroom);
  assert.equal(sheet.level, chosen.mode.level);
  assert.equal(sheet.legendRows, chosen.layout.legend.length);
  assert.ok(sheet.scale >= (chosen.mode.fontPt === 8 ? 80 : 90));
  assert.equal(sheet.rows.length, sheet.headerRow + 30 + sheet.legendRows);
  assert.ok(sheet.merges.includes(`A${sheet.rows.length}:${String.fromCharCode(64 + sheet.widths.length)}${sheet.rows.length}`), "범례 행 = 표 폭 병합");
  // 화면 표는 늘 1단계(두 줄 칸, 범례 없음)
  const screen = pr.classSectionsHomeroomStatusSheet(homeroom, { mode: { level: 1, compact: false, fontPt: 9 } });
  assert.equal(screen.legendRows, 0);
  assert.match(screen.rows[screen.headerRow][3].v, /\n/);
  // 브라우저에서 잰 높이: 1단계가 두 장에 들면 1단계(줄 높이 8mm × 30 = 240 > 187 → 두 장 = 15 + 15)
  const measured = pr.classSectionsHomeroomStatusChoose(homeroom, { measure: (s) => ({ header: 25, rows: s.studentKeys.map(() => 8), legend: 0, page: 187 }) });
  assert.deepEqual([measured.mode.level, measured.plan.pages], [1, 2]);
  // 잰 높이로도 1단계가 넘치면 2단계, 그 범례 높이까지 셈
  const tall = pr.classSectionsHomeroomStatusChoose(homeroom, { measure: (s, mode) => ({ header: 25, rows: s.studentKeys.map(() => (mode.compact ? 5 : 13)), legend: mode.compact ? 30 : 0, page: 187 }) });
  assert.deepEqual([tall.mode.level, tall.plan.pages, tall.plan.parts.map((part) => part.to - part.from).join("+")], [2, 2, "15+15"]);
  const small8 = pr.classSectionsHomeroomStatusChoose(homeroom, { measure: (s, mode) => ({ header: 25, rows: s.studentKeys.map(() => (mode.fontPt === 8 ? 5 : 13)), legend: 20, page: 187 }) });
  assert.deepEqual([small8.mode.level, small8.mode.fontPt, small8.plan.pages], [3, 8, 2]);
});

test("담임용 현황: 빈 열(학급 단위·재신청)은 그 반에 값이 없으면 좁게, 있으면 원래 폭 · 인쇄 글자 9pt(12px) 이상", () => {
  const empty = pr.classSectionsHomeroomStatusLayout(syntheticHomeroom(10, 3));
  assert.deepEqual(plain(empty.widths.slice(-2)), [7.5, 7.5]);
  assert.equal(empty.headLines, 2, "좁은 열 머리글도 두 줄 안");
  assert.deepEqual(plain(empty.head.slice(-2)), ["학급\n단위", "재신청\n미배정"]);
  const full = pr.classSectionsHomeroomStatusLayout(syntheticHomeroom(10, 3, { retake: 1, unit: true }));
  assert.deepEqual(plain(full.widths.slice(-2)), [10, 16]);
  assert.deepEqual(plain(full.head.slice(-2)), ["학급 단위", "재신청·미배정"]);
  // 인쇄 CSS: 현황 칸 12px(=9pt), 부제 12px
  const css = fs.readFileSync(path.join(root, "src", "legacy.css"), "utf8");
  const rule = css.match(/\.print-page\.cs-hr-page \.cs-att-table \{[^}]*\}/)?.[0] || "";
  const px = Number(rule.match(/font-size:\s*([\d.]+)px/)?.[1]);
  assert.ok(px >= 12, `현황 인쇄 글자 ${px}px`);
  assert.doesNotMatch(css.match(/@media print \{[^@]*cs-hr-page[^@]*\}/)?.[0] || "", /font-size:\s*(7|8|9|10|11)(\.\d+)?px/);
});

test("createWorkbookBlob: scale이 있으면 쪽 맞춤 대신 배율 + 수동 쪽 나눔(rowBreaks) + 머리글(쪽 번호), 없으면 예전과 같음", () => {
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const start = app.indexOf("    function createWorkbookBlob(");
  const source = app.slice(start, app.indexOf("    function downloadBlob(", start));
  const ctx = vm.createContext({ createXlsxBlob: (files) => files, createReportStylesXml: () => "REPORT",
    xmlEscape: (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    columnName: (index) => String.fromCharCode(65 + index) });
  vm.runInContext(`${source}; this.createWorkbookBlob = createWorkbookBlob;`, ctx);
  const files = ctx.createWorkbookBlob([{ name: "2-3반", rows: [["x"]], scale: 92, rowBreaks: [20], headerText: "&R&P/&N", orientation: "landscape" }, { name: "plain", rows: [["y"]], fitToHeight: 1 }]);
  const xml = files["xl/worksheets/sheet1.xml"];
  assert.match(xml, /<pageSetup paperSize="9" orientation="landscape" scale="92"\/><headerFooter><oddHeader>&amp;R&amp;P\/&amp;N<\/oddHeader><\/headerFooter><rowBreaks count="1" manualBreakCount="1"><brk id="20" max="16383" man="1"\/><\/rowBreaks><\/worksheet>$/);
  assert.doesNotMatch(xml, /fitToPage/);
  assert.match(files["xl/worksheets/sheet2.xml"], /<sheetPr><pageSetUpPr fitToPage="1"\/><\/sheetPr>.*fitToWidth="1" fitToHeight="1"\/><\/worksheet>$/);
});

// 두 학기 담임반(같은 반 id): 1학기 블록 2개 + 학급 단위, 2학기 블록 1개 + 재신청, 미제출 학생, 내년 반 미정 반.
function handoutSemesters() {
  const columns1 = [{ key: "g1|a", groupKey: "g1", groupCategory: "2-1 택2", blockLetter: "A", times: ["월:3", "수:5"], order: 0 }, { key: "g1|b", groupKey: "g1", groupCategory: "2-1 택2", blockLetter: "B", times: ["화:1"], order: 0 }];
  const columns2 = [{ key: "g2|a", groupKey: "g2", groupCategory: "2-2 택1", blockLetter: "A", times: [], order: 0 }];
  const cell = (courseName, roomName) => ({ courseName, roomName, roomLabel: "2학년 1반", teacher: "김교사" });
  const base = { id: "1|next|1", year: "2027", grade: "1", targetGrade: "2", room: "1", basis: "map", label: "내년 2학년 1반", sections: [] };
  const s1 = { ...base, semester: "1", columns: columns1, students: [
    { key: "1-1-11", number: "3", name: "가명가", unsubmitted: false, unit: ["정보"], retake: [], cells: { "g1|a": cell("물리학", "A물리학1"), "g1|b": cell("화학", "B화학") } },
    { key: "1-2-4", number: "1", name: "가명나", unsubmitted: true, unit: [], retake: [], cells: {} }] };
  const s2 = { ...base, semester: "2", columns: columns2, students: [
    { key: "1-1-11", number: "3", name: "가명가", unsubmitted: false, unit: [], retake: [{ courseName: "지구과학", reason: "정원 부족" }], cells: { "g2|a": cell("생명과학", "A생명과학") } },
    { key: "1-2-4", number: "1", name: "가명나", unsubmitted: true, unit: [], retake: [], cells: {} }] };
  return [{ semester: "1", homeroom: s1 }, { semester: "2", homeroom: s2 }];
}

test("학생 배부용 쪽지: 1·2학기 한 쪽지, 표(학기·블록·과목(아래 강의실)·교실·선생님), 학급 단위 한 줄, 재신청 굵게, 미제출 안내, 내년 반 미정, 그룹이 둘이면 블록에 그룹 표시", () => {
  const slips = pr.classSectionsHandoutSlips(handoutSemesters());
  assert.deepEqual(slips.map((slip) => slip.key), ["1-1-11", "1-2-4"], "현 반·번호순");
  const [a, b] = slips;
  assert.equal(a.who, "현 1학년 1반 11번 가명가");
  assert.equal(a.next, "내년 2학년 1반 3번");
  assert.deepEqual(plain(a.semesters), ["1", "2"]);
  assert.deepEqual(a.rows.map((row) => [row.semester, row.kind, row.courseName]), [["1", "section", "물리학"], ["1", "section", "화학"], ["1", "unit", "정보"], ["2", "section", "생명과학"], ["2", "retake", "지구과학"]]);
  assert.equal(a.rows[0].block, "A블록 · 월3, 수5");
  assert.equal(a.rows[3].block, "A블록 · 시간 미정");
  const html = pr.classSectionsHandoutHtml(a);
  assert.match(html, /<h4>2027학년도 이동수업 안내<\/h4>/);
  assert.match(html, /현 1학년 1반 11번 가명가 → 내년 2학년 1반 3번/);
  assert.match(html, /<thead><tr><th>학기<\/th><th>블록\(요일·교시\)<\/th><th>과목\(강의실\)<\/th><th>교실<\/th><th>선생님<\/th><\/tr><\/thead>/);
  assert.equal((html.match(/<col style/g) || []).length, 5);
  assert.match(html, /rowspan="3">1학기<\/th><td>A블록 · 월3, 수5<\/td><td class="cs-ho-course">물리학<small class="cs-ho-room">A물리학1<\/small><\/td><td>2학년 1반<\/td><td>김교사<\/td>/);
  assert.match(html, /<td>정보<\/td><td colspan="2">학급 단위\(우리 반 교실\)<\/td>/);
  assert.match(html, /<td>반 수업<\/td><td>정보<\/td>/, "학급 단위 과목은 블록 시간 대신 '반 수업'");
  assert.match(html, /<td>지구과학<\/td><td colspan="2"><strong>재신청 필요\(정원 부족\)<\/strong><\/td>/);
  // 한 학기 그룹 하나 → 블록에 그룹 표시 없음
  assert.doesNotMatch(html, /택\d A블록/);
  // 2학기에 그룹 둘(택3 + 택1 수학): 같은 'a블록'이 두 번 → '택3 a블록'·'택1 a블록'
  const two = handoutSemesters();
  const sem2 = two[1].homeroom;
  sem2.columns = [{ key: "g2|a", groupKey: "g2", groupCategory: "2-2 택3", blockLetter: "a", times: ["월:6"], order: 0 }, { key: "g3|a", groupKey: "g3", groupCategory: "2-2 택1", blockLetter: "a", times: ["월:3"], order: 1 }];
  sem2.students[0].cells = { "g2|a": { courseName: "정치", roomName: "a정치", roomLabel: "2학년 5반", teacher: "김교사" }, "g3|a": { courseName: "미적분Ⅰ", roomName: "a미적분Ⅰ1", roomLabel: "2학년 1반", teacher: "이교사" } };
  const labeled = pr.classSectionsHandoutSlips(two)[0].rows.filter((row) => row.semester === "2" && row.kind === "section").map((row) => [row.block, row.courseName]);
  assert.deepEqual(labeled, [["택3 a블록 · 월6", "정치"], ["택1 a블록 · 월3", "미적분Ⅰ"]]);
  assert.ok(pr.classSectionsHandoutSlips(two)[0].rows.filter((row) => row.semester === "1" && row.kind === "section").every((row) => /^A블록|^B블록/.test(row.block)), "1학기는 그룹 하나 → 표시 없음");
  // 짧은 표시가 다르면 짧게, 같으면(둘 다 '택3') 그룹 이름 그대로
  sem2.columns[1].groupCategory = "2-2 택3(과학)";
  sem2.columns[0].groupCategory = "2-2 택3";
  assert.equal(pr.classSectionsHandoutSlips(two)[0].rows.find((row) => row.courseName === "미적분Ⅰ").block, "택3(과학) a블록 · 월3");
  sem2.columns[1].groupCategory = "2-2 택3";
  assert.equal(pr.classSectionsHandoutSlips(two)[0].rows.find((row) => row.courseName === "미적분Ⅰ").block, "2-2 택3 a블록 · 월3", "짧은 표시가 같으면 그룹 이름 그대로");
  assert.match(html, /교실·시간은 바뀔 수 있습니다\. 바뀌면 다시 안내합니다\./);
  assert.equal(b.unsubmitted, true);
  assert.match(pr.classSectionsHandoutHtml(b), /수강신청 미제출 — 담임 선생님께 확인하세요/);
  assert.doesNotMatch(pr.classSectionsHandoutHtml(b), /<table/);
  // 내년 반 미정(현재 반 기준) · 그대로 올라감(번호 모름)
  const none = handoutSemesters().map((item) => ({ ...item, homeroom: { ...item.homeroom, basis: "none", label: "현 1학년 1반" } }));
  assert.equal(pr.classSectionsHandoutSlips(none)[0].next, "내년 반 미정");
  const same = handoutSemesters().map((item) => ({ ...item, homeroom: { ...item.homeroom, basis: "same", students: item.homeroom.students.map((s) => ({ ...s, number: "" })) } }));
  assert.equal(pr.classSectionsHandoutSlips(same)[0].next, "내년 2학년 1반");
  // 한 학기만 있으면 그 학기만
  assert.deepEqual(plain(pr.classSectionsHandoutSlips([handoutSemesters()[0]])[0].semesters), ["1"]);
});

test("학생 배부용 쪽지 배치: 한 장에 2·4·6장(기본 4), 장 수 = ceil(학생/장당), 글자 8pt 이상, 6장에 너무 길면 막고 안내", () => {
  const [slip] = pr.classSectionsHandoutSlips(handoutSemesters());
  const many = Array.from({ length: 31 }, (_, i) => ({ ...slip, key: `1-1-${i + 1}` }));
  for (const per of [2, 4, 6]) {
    const layout = pr.classSectionsHandoutLayout(many, per);
    assert.equal(layout.per, per);
    assert.equal(layout.ok, true, `${per}장`);
    assert.ok(layout.fontPt >= 8, `${per}장 글자 ${layout.fontPt}pt`);
    assert.ok(pr.classSectionsHandoutHeight(slip, layout.fontPt, layout.slipW) <= layout.slipH);
    const pages = pr.classSectionsHandoutPagesHtml(many, layout);
    assert.equal(pages.length, Math.ceil(31 / per));
    assert.equal((pages[0].match(/<article class="cs-ho/g) || []).length, per);
    assert.match(pages[0], new RegExp(`data-per="${per}"`));
  }
  assert.equal(pr.classSectionsHandoutLayout(many, 3).per, 4, "기본 4장");
  assert.ok(pr.classSectionsHandoutLayout(many, 2).fontPt > pr.classSectionsHandoutLayout(many, 6).fontPt, "장 수가 적을수록 글자가 큼");
  // 긴 쪽지(10줄): 6장이면 8pt 아래 → 막음 + 안내, 2장은 됨
  const long = { ...slip, rows: Array.from({ length: 10 }, (_, i) => ({ ...slip.rows[0], semester: i < 5 ? "1" : "2", courseName: `인공지능 기초와 활용 심화${i}`, roomName: `A인공지능기초와활용심화${i}` })) };
  const blocked = pr.classSectionsHandoutLayout([long], 6);
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /한 장에 6장이면 가장 긴 쪽지\(10줄\)의 글자가 8pt보다 작아집니다\. 4장이나 2장을 고르세요\./);
  assert.equal(pr.classSectionsHandoutLayout([long], 2).ok, true);
  // 브라우저에서 잰 높이(measure)가 있으면 어림 대신 그 값: 1열(182mm 폭) pt×7mm, 2열(91mm 폭) pt×12mm → 1열 9pt(9×7+1 ≤ 67) vs 2열 10.5pt(≤ 134) → 2열
  const measured = pr.classSectionsHandoutLayout(many, 4, { measure: (item, pt, width) => (width > 100 ? pt * 7 : pt * 12) });
  assert.deepEqual([measured.cols, measured.fontPt, measured.ok], [2, 10.5, true]);
  const tight = pr.classSectionsHandoutLayout(many, 6, { measure: (item, pt) => pt * 12 });
  assert.equal(tight.ok, false, "6장: 잰 높이로도 8pt 아래면 막음");
});

test("화면 연결: 담임반 보기에 학생 배부용 단추·미리 보기(첫 학생 / 학생 찾기) · 인쇄 = 학생 수/4장, 두 학기 함께, 6장 막힘", () => {
  const ctx = context({ twoSemesters: true });
  const source = ctx.classSectionsSource("1");
  assert.equal(source.groups.length, 2);
  let first = null;
  for (const group of source.groups) {
    const entry = ctx.classSectionsEntry("1", group.key);
    entry.blockTimes.a = "월1,수2"; entry.blockTimes.b = "화1,목2";
    ctx.classSectionsSettings().promotion["1"] = "same";
    const input = ctx.classSectionsBuildInput("1", group, entry);
    ctx.classSectionsSaveResult(entry, ctx.classSectionsSolve({ ...input, maxSectionsPerBlock: 4 }), input, group, { locked: true });
    first = first || { group, entry };
  }
  ctx.CLASS_SECTIONS_VIEW.round = "1";
  ctx.CLASS_SECTIONS_VIEW.group = first.group.key;
  ctx.CLASS_SECTIONS_PRINT_VIEW.attScope = "homeroom";
  const html = ctx.classSectionsPrintButtonsHtml("1", first.group, first.entry.sectionResult);
  for (const id of ["classSectionsHandout", "classSectionsHandoutPer", "classSectionsHandoutPrintOne", "classSectionsHandoutPrintGrade", "classSectionsHandoutPreview"]) assert.match(html, new RegExp(`id="${id}"`), id);
  const preview = html.match(/<div class="cs-ho-preview" id="classSectionsHandoutPreview" data-student="([^"]+)">/);
  assert.equal(preview[1], "1-1-1", "이 반 첫 학생");
  assert.match(html, /1학기<\/th>/);
  assert.match(html, /2학기<\/th>/);
  ctx.CLASS_SECTIONS_VIEW.search = "1-1-7";
  assert.match(ctx.classSectionsPrintButtonsHtml("1", first.group, first.entry.sectionResult), /id="classSectionsHandoutPreview" data-student="1-1-7"/);
  ctx.CLASS_SECTIONS_VIEW.search = "";
  const printBatch = { innerHTML: "" };
  ctx.document = { getElementById: (id) => (id === "printBatch" ? printBatch : null) };
  const statuses = [];
  ctx.classSectionsSetStatus = (text, error) => statuses.push({ text, error });
  ctx.classSectionsHandoutPrint("one");
  assert.equal((printBatch.innerHTML.match(/class="print-page cs-ho-page"/g) || []).length, Math.ceil(10 / 4));
  assert.equal((printBatch.innerHTML.match(/<article class="cs-ho/g) || []).length, 10, "반 학생 10명");
  ctx.classSectionsHandoutPrint("grade");
  assert.equal((printBatch.innerHTML.match(/<article class="cs-ho/g) || []).length, 40, "학년 4개 반");
  assert.match(statuses.at(-1).text, /반 4개 · 40명\(10장, 한 장에 4장/);
  // 성명은 저장하지 않음(쪽지는 인쇄에만)
  assert.doesNotMatch(JSON.stringify(ctx.state.classSections || {}), /가명/);
  // 담임용 이 반 인쇄: 쪽 번호 표시
  ctx.classSectionsHomeroomPrint("one");
  assert.match(printBatch.innerHTML, /<div class="cs-hr-pageno">1\/1<\/div>/);
  ctx.CLASS_SECTIONS_PRINT_VIEW.attScope = "group";
});
