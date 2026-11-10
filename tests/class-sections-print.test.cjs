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
  assert.match(shortage.message, /교실이 모자라 분반 2개.*분반 6개 > 2학년 교실 3개/);
  // 다른 교실(다목적실·세미나실)을 더하면 해결.
  const more = cs.classSectionsAssignRooms({ rooms: cs.classSectionsRoomList({ classrooms: { "2": ["2-1", "2-2", "2-3"], "3": ["3-1", "3-2"] }, special: { 과학실: ["과학실1"] }, extra: ["다목적실", "세미나실"] }), groups });
  assert.ok(!more.issues.some((issue) => issue.type === "room-short"));
  assert.ok(Object.values(more.assign.g2).includes("다목적실"));
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
  assert.match(html, /학급 단위 과목: 정보/);
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
function context() {
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
    aggregateRecords: (list) => ({ reports: [{ summary: { grade: "1", classes: 4 }, semesters: [{ order: 1, groups: [{ category: "2-1 택2", choiceCount: 2,
      courses: courses.map((course) => ({ column: course.column, name: course.name, subjectName: course.name, classCount: 2,
        enrollment: list.filter((student) => student.selections.some((selection) => selection.column === course.column)).length })) }] }] }] }),
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

test("화면 연결: 학생 시간표 = 그룹 배정 + 블록 시간 + 고정 시간(창체), 재신청 학생 표시, 학생 찾기로 미리 보기", () => {
  const ctx = context();
  const { group, result } = solved(ctx);
  const settings = ctx.classSectionsSettings();
  settings.fixedSlots.push({ label: "창체", times: "금6,금7", allTeachers: true });
  const key = Object.keys(result.assign)[0];
  const [model] = ctx.classSectionsTimetableModels("1", group, [key]);
  assert.equal(model.title, "2027학년도 1학기 · 현 1학년 → 2학년 이동수업 시간표");
  assert.match(model.student, new RegExp(`^${key} 가명\\d+ · 내년 2학년 \\d반$`));
  const moves = model.grid.flat().filter((cell) => cell.kind === "move");
  assert.equal(moves.length, result.assign[key].length * 2, "two periods per block");
  assert.equal(model.grid[5][4].kind, "fixed");
  // 미배정 학생은 '재신청 필요'.
  result.unassigned.push({ studentKey: key, courseKey: "지구과학", reason: "capacity" });
  assert.deepEqual(plain(ctx.classSectionsTimetableModels("1", group, [key])[0].retake), [{ courseName: "지구과학", reason: "정원 부족" }]);
  ctx.CLASS_SECTIONS_VIEW.search = key;
  assert.match(ctx.classSectionsPrintButtonsHtml("1", group, result), /id="classSectionsTimetablePreview"[\s\S]*재신청 필요: 지구과학/);
  // 반 고르기: 그 반 학생만.
  ctx.CLASS_SECTIONS_PRINT_VIEW.timetableClass = "2";
  assert.ok(ctx.classSectionsTimetableKeysFor("1", group).every((item) => item.startsWith("1-2-")));
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
