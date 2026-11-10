"use strict";
// 6단계 분반 편성(순수 계산: DOM·state·localStorage 없음, Web Worker에서도 그대로 돈다). 화면 연결은 class-sections-view.js(2차).
// 설계 문서: docs/class-sections-design.md
//
// 한 그룹 = (차수, 현 학년, 학기). 학생은 그 그룹의 이동 수업 과목을 m개(보통 택n = 블록 수) 고르고,
// 과목마다 분반 k개가 있다. 블록(a, b, c …)은 같은 시간에 열리는 분반 묶음이다.
//   1) 블록 배치(A): 분반 → 블록. 학생마다 고른 과목을 서로 다른 블록에 넣을 수 있어야 한다(학생 충돌 0).
//      제약: 블록당 최대 분반 수, 교과(부서)별 그 시간 가능한 교사 수, 특별실 수, 다른 학년 블록과 시간이 겹치면 함께 센다.
//      방법: 동시 신청(공출현) 기반 탐욕 배치 → 넘침 칸을 겨냥한 이동·교환 지역 탐색(평가 = 아래 B의 넘침 수).
//   2) 학생 배정(B): 학생(같은 조합끼리 묶은 단위)마다 '과목 → 블록' 단사 함수를 고른다.
//      비용 = 1000×정원 넘침 + 균형(칸 인원²/분반 수) + 담임반 흩어짐 + 기존 배정에서 바뀐 수. 탐욕 시작 + 담금질 지역 탐색.
//   3) 칸 안 분반 배정(C): 한 블록에 같은 과목 분반이 여럿이면 최소 비용 유량으로 나눈다(고정·기존 분반·담임반 묶음 우선, 인원 균등).
//   4) 교사 배정 추천: 자격(과목·교과) + 불가 시간 + 같은 시간 겹침(학년 간 포함) + 시수 균형, 탐욕 + 한 단계 교체.
//   5) 검증기·설명(불가능 원인, 몇 분반을 35명으로 올리면 되는지)·방식별 비교와 추천.
// 재현성: 난수는 seed로 고정하고 탐색 예산은 반복 횟수로 정한다(시간 제한 timeLimitMs는 안전장치이며 걸리면 stats.timedOut).
// 개인정보: 학생은 '현학년-반-번호' 키만 다룬다. 성명은 나이스 내보내기에서 부르는 쪽이 채운다.

var CLASS_SECTIONS_VERSION = 1;
var CLASS_SECTIONS_DEFAULT_CAPACITY = 34;
var CLASS_SECTIONS_MODES = ["move", "homeroom", "balance"];
var CLASS_SECTIONS_MODE_LABELS = { move: "완전 이동", homeroom: "같은 담임반끼리 묶기 우선", balance: "분반 인원 균형" };
// 학생 배정 비용 가중치(넘침 1명 = 1000).
var CLASS_SECTIONS_MODE_WEIGHTS = {
  move: { bal: 1, home: 0, keep: 4 },
  homeroom: { bal: 0.4, home: 6, keep: 4 },
  balance: { bal: 5, home: 0, keep: 4 }
};
var CLASS_SECTIONS_OVERFLOW_COST = 1000;
var CLASS_SECTIONS_BLOCK_LETTERS = "abcdefghijklmnopqrstuvwxyz";
var CLASS_SECTIONS_SPREAD_WARN = 4;
var CLASS_SECTIONS_DAYS = ["월", "화", "수", "목", "금", "토"];

// ---- 작은 도우미 ----
function classSectionsText(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function classSectionsCompact(value) {
  return classSectionsText(value).replace(/\s+/g, "");
}

function classSectionsNow() {
  return typeof performance !== "undefined" && performance && typeof performance.now === "function" ? performance.now() : Date.now();
}

// mulberry32: seed가 같으면 같은 수열.
// 뜨거운 반복 안에서는 전역 이름(Math·다른 함수)을 지역 변수로 받아 쓴다(vm·Worker에서 전역 조회가 느림).
function classSectionsRng(seed) {
  let a = (Math.floor(Number(seed)) || 1) >>> 0;
  const imul = Math.imul;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = imul(t ^ (t >>> 15), t | 1);
    t ^= t + imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 요일·교시 → '월:3'. 문자열 '월3'/'월:3'/'월-3'도 받는다.
function classSectionsSlot(time) {
  if (time === undefined || time === null) return "";
  if (typeof time === "string") {
    const match = time.replace(/\s+/g, "").match(/^([^\d:]+)[:\-]?(\d+)/);
    return match ? `${match[1]}:${Number(match[2])}` : time.replace(/\s+/g, "");
  }
  const day = classSectionsText(time.day);
  const period = Number(time.period);
  return day && Number.isFinite(period) ? `${day}:${period}` : "";
}

function classSectionsSlots(times) {
  return [...new Set((Array.isArray(times) ? times : []).map(classSectionsSlot).filter(Boolean))];
}

function classSectionsOverlap(a, b) {
  if (!a?.length || !b?.length) return false;
  const set = new Set(a);
  return b.some((slot) => set.has(slot));
}

// 정렬된 키로 직렬화(입력 서명용).
function classSectionsStable(value) {
  if (Array.isArray(value)) return `[${value.map(classSectionsStable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${classSectionsStable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function classSectionsHash(textValue) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < textValue.length; i += 1) {
    const code = textValue.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ code, 2246822519) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// 결과에 영향을 주는 입력만 서명한다. 화면 표시용 값(라벨 등)이 바뀌어도 '재계산 필요'가 뜨지 않게.
function classSectionsSignature(input) {
  const src = input || {};
  const pick = {
    defaultCapacity: src.defaultCapacity ?? src.capacity ?? null,
    maxSectionsPerBlock: src.maxSectionsPerBlock ?? null,
    blocks: Array.isArray(src.blocks) ? src.blocks.map((block) => ({ id: block.id ?? null, maxSections: block.maxSections ?? null, times: classSectionsSlots(block.times) })) : (src.blocks ?? src.choose ?? null),
    courses: (src.courses || []).map((course) => ({ key: course.key ?? course.name, sections: course.sections ?? course.classCount ?? 0,
      capacities: course.capacities || null, capacity: course.capacity ?? null, department: course.department || "", room: course.room || "", mode: course.mode || "move" })),
    sections: src.sections || null,
    students: (src.students || []).map((student) => [student.key, student.homeroom ?? null, classSectionsStudentCourseList(student).slice().sort()]),
    pins: src.pins || null,
    teachers: src.teachers || null,
    departmentTeachers: src.departmentTeachers || null,
    rooms: src.rooms || null,
    // occupied(다른 학년 편성 결과에서 온 교사·교과 사용량)는 사용자 입력이 아니므로 넣지 않는다(다른 그룹을 편성할 때마다 '입력 변경됨'이 되지 않게).
    fixedSlots: src.fixedSlots || null
  };
  return classSectionsHash(classSectionsStable(pick));
}

function classSectionsStudentCourseList(student) {
  if (Array.isArray(student?.courses)) return student.courses.map((item) => classSectionsText(typeof item === "object" ? (item.key ?? item.name) : item)).filter(Boolean);
  if (Array.isArray(student?.selections)) return student.selections.map((item) => classSectionsText(item?.key ?? item?.applicationSubject ?? item?.name)).filter(Boolean);
  return [];
}

// 학생 키 조각: 앞뒤 공백·끝의 '학년/반/번'·숫자의 앞 0을 없앤다('01반' → '1'). 그룹 자료·배정표·이름·명렬표·나이스가 모두 이것을 쓴다.
// 유지할 강의실 이름: input.roomNames { 분반id: 이름 } (부분 재계산·고정이 있는 재계산에서 화면이 넘김).
function classSectionsKeepMap(src) {
  const map = new Map();
  for (const [id, value] of Object.entries(src?.roomNames || {})) if (classSectionsText(value)) map.set(classSectionsText(id), classSectionsText(value));
  return map;
}

function classSectionsKeyPart(value) {
  const text = classSectionsText(value).replace(/\s+/g, "").replace(/(학년|반|번)$/, "");
  return /^\d+$/.test(text) ? String(Number(text)) : text;
}

function classSectionsStudentKey(grade, classroom, number) {
  return `${classSectionsKeyPart(grade)}-${classSectionsKeyPart(classroom)}-${classSectionsKeyPart(number)}`;
}

function classSectionsHomeroomOf(student) {
  const explicit = classSectionsText(student?.homeroom ?? student?.classroom);
  if (explicit) return explicit;
  const parts = classSectionsText(student?.key).split("-");
  return parts.length >= 3 ? parts[parts.length - 2] : "";
}

// 바뀐 학생: 새로 생겼거나 고른 과목이 달라진 학생 키(부분 재계산용).
function classSectionsChangedStudents(previousStudents, students) {
  const before = new Map((previousStudents || []).map((student) => [classSectionsText(student.key), classSectionsStudentCourseList(student).slice().sort().join("|")]));
  return (students || []).filter((student) => before.get(classSectionsText(student.key)) !== classSectionsStudentCourseList(student).slice().sort().join("|"))
    .map((student) => classSectionsText(student.key));
}

// ---- 입력 정규화 ----
// input: {
//   groupId, label, grade(현 학년), targetGrade, semester,
//   blocks: 수 또는 [{ id, label, maxSections, times:[{day,period}] }], choose(블록 수 대신), maxSectionsPerBlock,
//   defaultCapacity(기본 34), capacities: { 분반id: 정원 },
//   courses: [{ key, name, sections(분반 수), capacity, capacities:[분반별], department(교과·부서), room(특별실 종류), credits, family(편제명), mode:'move'|'class' }],
//   sections: [{ id, courseKey, capacity, blockId, fixed }] (주면 courses.sections 대신),
//   students: [{ key:'현학년-반-번호', homeroom, courses:[과목 key] }],
//   pins: { sections: { 분반id: 블록id }, students: { 학생key: [분반id] }, teachers: { 분반id: 교사id } },
//   teachers: [{ id, name, departments:[], courses:[], unavailable:[{day,period,reason}] }], departmentTeachers: { 교과: 수 },
//   rooms: { 특별실: 수 }, occupied: [{ label, times, teacherIds, departments:{교과:수}, rooms:{특별실:수} }], fixedSlots: (occupied와 같은 모양),
//   mode, seed, previous: { sections:[{id, blockId}], assign:{ 학생key:[분반id] }, teacherOf }, partial, changedStudents,
//   baseline: { assign } (비교 지표 '기존 대비 이동'만, 없으면 previous),
//   placementSteps, evalIterations, finalIterations, timeLimitMs, suggest(기본 true)
// }
function classSectionsNormalize(input) {
  const src = input || {};
  const issues = [];
  const defaultCapacity = Math.max(1, Math.floor(Number(src.defaultCapacity ?? src.capacity) || CLASS_SECTIONS_DEFAULT_CAPACITY));
  const mode = CLASS_SECTIONS_MODES.includes(src.mode) ? src.mode : "move";
  const courses = [];
  const classUnitCourses = [];
  const byKey = new Map();
  const byName = new Map();
  for (const raw of src.courses || []) {
    const key = classSectionsText(raw?.key ?? raw?.name);
    if (!key || byKey.has(key)) continue;
    const course = {
      key, name: classSectionsText(raw.name ?? key), department: classSectionsText(raw.department), room: classSectionsText(raw.room),
      credits: Number(raw.credits) || 0, family: classSectionsText(raw.family), mode: raw.mode === "class" ? "class" : "move",
      sections: Math.max(0, Math.floor(Number(raw.sections ?? raw.classCount) || 0)), capacity: Number(raw.capacity) || 0,
      capacities: Array.isArray(raw.capacities) ? raw.capacities : [], index: -1, demand: 0
    };
    byKey.set(key, course);
    if (!byName.has(classSectionsCompact(course.name))) byName.set(classSectionsCompact(course.name), course);
    if (course.mode === "class") { classUnitCourses.push(course); continue; }
    course.index = courses.length;
    courses.push(course);
  }
  const findCourse = (value) => byKey.get(classSectionsText(value)) || byName.get(classSectionsCompact(value)) || null;

  // 블록
  let blockSpecs = Array.isArray(src.blocks) ? src.blocks : null;
  const studentsRaw = Array.isArray(src.students) ? src.students : [];
  let blockCount = blockSpecs ? blockSpecs.length : Math.floor(Number(src.blocks ?? src.choose) || 0);
  if (!blockCount) {
    blockCount = studentsRaw.reduce((max, student) => Math.max(max, classSectionsStudentCourseList(student)
      .filter((value) => findCourse(value)?.mode === "move").length), 0);
  }
  blockCount = Math.max(1, Math.min(CLASS_SECTIONS_BLOCK_LETTERS.length, blockCount));
  const groupMax = Number(src.maxSectionsPerBlock) > 0 ? Math.floor(Number(src.maxSectionsPerBlock)) : Infinity;
  const blocks = [];
  for (let b = 0; b < blockCount; b += 1) {
    const raw = blockSpecs?.[b] || {};
    const letter = CLASS_SECTIONS_BLOCK_LETTERS[b];
    blocks.push({ index: b, id: classSectionsText(raw.id) || letter, letter, label: classSectionsText(raw.label) || `${letter}블록`,
      maxSections: Number(raw.maxSections) > 0 ? Math.floor(Number(raw.maxSections)) : groupMax, times: classSectionsSlots(raw.times) });
  }
  const blockById = new Map(blocks.map((block) => [block.id, block.index]));
  const pins = src.pins || {};
  const pinSections = pins.sections || {};
  const capacityOverride = src.capacities || {};

  // 분반
  const sections = [];
  const sectionById = new Map();
  const addSection = (course, id, capacity, blockValue, fixed) => {
    if (sectionById.has(id)) { issues.push({ type: "input", severity: "warn", message: `분반 id가 겹칩니다: ${id}` }); return; }
    const block = blockById.has(classSectionsText(blockValue)) ? blockById.get(classSectionsText(blockValue)) : -1;
    const section = { index: sections.length, id, course: course.index, ord: 0, capacity: Math.max(0, Math.floor(Number(capacity) || 0)) || defaultCapacity,
      fixedBlock: fixed && block >= 0 ? block : -1, hintBlock: block };
    sections.push(section);
    sectionById.set(id, section);
  };
  if (Array.isArray(src.sections) && src.sections.length) {
    for (const raw of src.sections) {
      const course = findCourse(raw.courseKey ?? raw.course);
      if (!course || course.mode !== "move") continue;
      const id = classSectionsText(raw.id) || `${course.key}#${sections.filter((s) => s.course === course.index).length + 1}`;
      const pinned = pinSections[id];
      addSection(course, id, capacityOverride[id] ?? raw.capacity ?? course.capacity, pinned ?? raw.blockId, pinned !== undefined || raw.fixed === true);
    }
    for (const course of courses) course.sections = sections.filter((section) => section.course === course.index).length;
  } else {
    for (const course of courses) {
      for (let i = 0; i < course.sections; i += 1) {
        const id = `${course.key}#${i + 1}`;
        const pinned = pinSections[id];
        addSection(course, id, capacityOverride[id] ?? course.capacities[i] ?? course.capacity, pinned, pinned !== undefined);
      }
    }
  }
  const ordByCourse = new Map();
  for (const section of sections) {
    const next = (ordByCourse.get(section.course) || 0) + 1;
    ordByCourse.set(section.course, next);
    section.ord = next;
  }

  // 이전 결과(부분 재계산·기존 배정 유지)
  const previous = src.previous && typeof src.previous === "object" ? src.previous : null;
  const previousBlocks = new Map();
  for (const item of previous?.sections || []) {
    const section = sectionById.get(classSectionsText(item.id));
    const block = blockById.get(classSectionsText(item.blockId));
    if (section && block !== undefined) previousBlocks.set(section.index, block);
  }
  const partial = Boolean(src.partial && previous);
  if (partial) {
    // 부분 재계산: 분반-블록 배치는 그대로 둔다(분반 수가 바뀐 과목의 새 분반만 자유).
    for (const section of sections) if (section.fixedBlock < 0 && previousBlocks.has(section.index)) section.fixedBlock = previousBlocks.get(section.index);
  }
  for (const section of sections) if (section.hintBlock < 0 && previousBlocks.has(section.index)) section.hintBlock = previousBlocks.get(section.index);
  const changed = new Set((src.changedStudents || []).map(classSectionsText));

  // 학생
  const students = [];
  const unassignedInput = [];
  const studentPins = pins.students || {};
  for (const raw of studentsRaw) {
    const key = classSectionsText(raw?.key);
    if (!key) continue;
    const homeroom = classSectionsHomeroomOf(raw);
    const list = [];
    const classUnit = [];
    for (const value of classSectionsStudentCourseList(raw)) {
      const course = findCourse(value);
      if (!course) { issues.push({ type: "unknown-course", severity: "warn", studentKey: key, message: `${key}: 이 그룹에 없는 과목 '${value}'` }); continue; }
      if (course.mode === "class") { classUnit.push(course.key); continue; }
      if (!list.includes(course.index)) list.push(course.index);
    }
    list.sort((a, b) => a - b);
    const courseList = [];
    for (const c of list) {
      if (courses[c].sections === 0) { unassignedInput.push({ studentKey: key, courseKey: courses[c].key, reason: "closed" }); continue; }
      courseList.push(c);
    }
    while (courseList.length > blockCount) {
      const dropped = courseList.pop();
      unassignedInput.push({ studentKey: key, courseKey: courses[dropped].key, reason: "too-many" });
    }
    for (const c of courseList) courses[c].demand += 1;
    for (const value of raw.classUnitMissed || []) unassignedInput.push({ studentKey: key, courseKey: classSectionsText(value), reason: "class-unit-other-room" });
    const student = { index: students.length, key, homeroom, courses: courseList, classUnit, pinSec: courseList.map(() => -1), prevSec: courseList.map(() => -1), locked: false };
    const pinned = Array.isArray(studentPins[key]) ? studentPins[key] : Object.values(studentPins[key] || {});
    for (const id of pinned) {
      const section = sectionById.get(classSectionsText(id));
      const pos = section ? courseList.indexOf(section.course) : -1;
      if (pos >= 0) student.pinSec[pos] = section.index;
    }
    const before = previous?.assign?.[key];
    if (Array.isArray(before)) {
      for (const id of before) {
        const section = sectionById.get(classSectionsText(id));
        const pos = section ? courseList.indexOf(section.course) : -1;
        if (pos >= 0) student.prevSec[pos] = section.index;
      }
      if (partial && !changed.has(key) && student.prevSec.every((value) => value >= 0)) {
        student.locked = true;
        student.pinSec = student.pinSec.map((value, pos) => (value >= 0 ? value : student.prevSec[pos]));
      }
    }
    students.push(student);
  }

  // 교사·교실·다른 학년 점유
  const teachers = (Array.isArray(src.teachers) ? src.teachers : []).map((raw, index) => {
    const unavailable = (raw.unavailable || []).map((item) => ({ slot: classSectionsSlot(item), reason: classSectionsText(item?.reason) })).filter((item) => item.slot);
    const coursesTaught = (raw.courses || []).map((value) => findCourse(value)?.key || classSectionsText(value)).filter(Boolean);
    const departments = new Set((raw.departments || []).map(classSectionsText).filter(Boolean));
    for (const value of coursesTaught) { const course = byKey.get(value); if (course?.department) departments.add(course.department); }
    return { index, id: classSectionsText(raw.id) || classSectionsText(raw.name) || `t${index + 1}`, name: classSectionsText(raw.name ?? raw.id),
      departments: [...departments], courses: coursesTaught, unavailable };
  });
  const occupied = [...(src.occupied || []), ...(src.fixedSlots || [])].map((item) => ({
    label: classSectionsText(item.label), times: classSectionsSlots(item.times), teacherIds: (item.teacherIds || []).map(classSectionsText),
    departments: item.departments || {}, rooms: item.rooms || {}
  }));
  const timed = blocks.some((block) => block.times.length);
  if (teachers.length && !timed) issues.push({ type: "no-times", severity: "info", message: "블록 시간(요일·교시)이 없어 교사 불가 시간·학년 간 겹침 점검을 건너뜁니다." });

  const model = {
    groupId: classSectionsText(src.groupId), label: classSectionsText(src.label), grade: src.grade ?? null, targetGrade: src.targetGrade ?? null,
    semester: src.semester ?? null, defaultCapacity, mode, seed: Number(src.seed) || 1, courses, classUnitCourses, blocks, sections, students,
    teachers, departmentTeachers: src.departmentTeachers || null, rooms: src.rooms || null, occupied, partial, previous,
    // baseline: 비교용 기존 배정(옮긴 수 지표만, 배정 비용에는 쓰지 않음). previous는 유지 비용·부분 재계산에 쓴다.
    baseline: src.baseline && typeof src.baseline === "object" ? src.baseline : previous,
    teacherPins: pins.teachers || {}, issues, unassignedInput,
    keepRoomNames: classSectionsKeepMap(src),
    choose: Math.max(0, Math.floor(Number(src.choose) || 0)),
    classUnitCheck: src.classUnit && src.classUnit.unitOf ? { choose: Math.max(1, Number(src.classUnit.choose) || 1), unitOf: src.classUnit.unitOf } : null,
    cohortTimes: (src.cohortTimes || []).map((item) => ({ label: classSectionsText(item.label), times: classSectionsSlots(item.times) })).filter((item) => item.times.length), sectionById, courseByKey: byKey,
    options: {
      placementSteps: Number(src.placementSteps) || 0, evalIterations: Number(src.evalIterations) || 0, finalIterations: Number(src.finalIterations) || 0,
      timeLimitMs: Number(src.timeLimitMs) || 20000, suggest: src.suggest !== false,
      spreadWarn: Number(src.spreadWarn) > 0 ? Number(src.spreadWarn) : CLASS_SECTIONS_SPREAD_WARN
    }
  };
  model.supply = classSectionsSupply(model);
  return model;
}

// 블록마다 교과별 '그 시간에 비어 있는 교사 수'와 특별실 수. 제한이 없으면 null.
function classSectionsSupply(model) {
  const B = model.blocks.length;
  const dept = Array.from({ length: B }, () => null);
  const rooms = Array.from({ length: B }, () => null);
  const hasTeachers = model.teachers.length > 0;
  const counts = model.departmentTeachers && typeof model.departmentTeachers === "object" ? model.departmentTeachers : null;
  for (let b = 0; b < B; b += 1) {
    const times = model.blocks[b].times;
    const overlapping = times.length ? model.occupied.filter((item) => classSectionsOverlap(times, item.times)) : [];
    if (hasTeachers) {
      const busy = new Set(overlapping.flatMap((item) => item.teacherIds));
      const map = new Map();
      for (const teacher of model.teachers) {
        if (busy.has(teacher.id)) continue;
        if (times.length && teacher.unavailable.some((item) => times.includes(item.slot))) continue;
        for (const name of teacher.departments) map.set(name, (map.get(name) || 0) + 1);
      }
      dept[b] = map;
    } else if (counts) {
      dept[b] = new Map(Object.entries(counts).map(([name, value]) => [name, Math.max(0, Math.floor(Number(value) || 0))]));
    }
    if (dept[b]) {
      for (const item of overlapping) {
        for (const [name, value] of Object.entries(item.departments || {})) {
          if (dept[b].has(name)) dept[b].set(name, Math.max(0, dept[b].get(name) - (Number(value) || 0)));
        }
      }
    }
    if (model.rooms && typeof model.rooms === "object") {
      const map = new Map(Object.entries(model.rooms).map(([name, value]) => [name, Math.max(0, Math.floor(Number(value) || 0))]));
      for (const item of overlapping) {
        for (const [name, value] of Object.entries(item.rooms || {})) if (map.has(name)) map.set(name, Math.max(0, map.get(name) - (Number(value) || 0)));
      }
      rooms[b] = map;
    }
  }
  return { dept, rooms };
}

// ---- 블록 배치 상태 ----
function classSectionsPlacementNew(model) {
  const C = model.courses.length;
  const B = model.blocks.length;
  return { blockOf: new Int32Array(model.sections.length).fill(-1), total: new Int32Array(B), cellSec: new Int32Array(C * B), cellCap: new Int32Array(C * B),
    dept: Array.from({ length: B }, () => new Map()), room: Array.from({ length: B }, () => new Map()) };
}

function classSectionsCanPlace(model, place, s, b, ignore) {
  const section = model.sections[s];
  const course = model.courses[section.course];
  const skip = ignore >= 0 && place.blockOf[ignore] === b ? model.sections[ignore] : null;
  const skipCourse = skip ? model.courses[skip.course] : null;
  if (place.total[b] - (skip ? 1 : 0) >= model.blocks[b].maxSections) return false;
  const deptLimit = model.supply.dept[b];
  if (deptLimit && course.department && deptLimit.has(course.department)) {
    const used = (place.dept[b].get(course.department) || 0) - (skipCourse && skipCourse.department === course.department ? 1 : 0);
    if (used >= deptLimit.get(course.department)) return false;
  }
  const roomLimit = model.supply.rooms[b];
  if (roomLimit && course.room && roomLimit.has(course.room)) {
    const used = (place.room[b].get(course.room) || 0) - (skipCourse && skipCourse.room === course.room ? 1 : 0);
    if (used >= roomLimit.get(course.room)) return false;
  }
  return true;
}

function classSectionsPut(model, place, s, b) {
  const section = model.sections[s];
  const course = model.courses[section.course];
  const B = model.blocks.length;
  const old = place.blockOf[s];
  if (old >= 0) {
    place.total[old] -= 1;
    place.cellSec[section.course * B + old] -= 1;
    place.cellCap[section.course * B + old] -= section.capacity;
    if (course.department) place.dept[old].set(course.department, place.dept[old].get(course.department) - 1);
    if (course.room) place.room[old].set(course.room, place.room[old].get(course.room) - 1);
  }
  place.blockOf[s] = b;
  if (b >= 0) {
    place.total[b] += 1;
    place.cellSec[section.course * B + b] += 1;
    place.cellCap[section.course * B + b] += section.capacity;
    if (course.department) place.dept[b].set(course.department, (place.dept[b].get(course.department) || 0) + 1);
    if (course.room) place.room[b].set(course.room, (place.room[b].get(course.room) || 0) + 1);
  }
}

function classSectionsCooccurrence(model) {
  const C = model.courses.length;
  const co = new Float64Array(C * C);
  for (const student of model.students) {
    const list = student.courses;
    for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
      co[list[i] * C + list[j]] += 1;
      co[list[j] * C + list[i]] += 1;
    }
  }
  return co;
}

// 탐욕 첫 배치: 분반이 적은 과목부터, 같이 듣는 학생이 많은 과목이 이미 있는 블록을 피하고, 같은 과목 분반은 흩뜨린다.
function classSectionsInitialPlacement(model, rng) {
  const place = classSectionsPlacementNew(model);
  const C = model.courses.length;
  const B = model.blocks.length;
  const co = classSectionsCooccurrence(model);
  const issues = [];
  for (const section of model.sections) if (section.fixedBlock >= 0) classSectionsPut(model, place, section.index, section.fixedBlock);
  const order = model.courses.map((course) => course.index).sort((a, b) => model.courses[a].sections - model.courses[b].sections
    || model.courses[b].demand - model.courses[a].demand || a - b);
  for (const c of order) {
    for (const section of model.sections) {
      if (section.course !== c || place.blockOf[section.index] >= 0) continue;
      let best = -1;
      let bestScore = Infinity;
      for (let b = 0; b < B; b += 1) {
        if (!classSectionsCanPlace(model, place, section.index, b, -1)) continue;
        let conflict = 0;
        for (let other = 0; other < C; other += 1) {
          if (other === c) continue;
          const here = place.cellSec[other * B + b];
          if (here) conflict += co[c * C + other] * here / Math.max(1, model.courses[other].sections);
        }
        const same = place.cellSec[c * B + b] * (model.courses[c].demand + 1);
        const fill = place.total[b] / (Number.isFinite(model.blocks[b].maxSections) ? model.blocks[b].maxSections : 50);
        const hint = section.hintBlock === b ? -0.5 : 0;
        const score = conflict + same + fill * 5 + hint + rng() * 1e-6;
        if (score < bestScore) { bestScore = score; best = b; }
      }
      if (best < 0) {
        // 제약 때문에 둘 곳이 없으면 가장 덜 찬 블록에 두고 문제로 알린다.
        best = 0;
        for (let b = 1; b < B; b += 1) if (place.total[b] < place.total[best]) best = b;
        issues.push({ type: "placement-forced", severity: "error", sectionId: section.id, department: model.courses[c].department || "",
          message: `${model.courses[c].name} 분반을 둘 블록이 없습니다(블록당 최대 분반·교사·특별실 제한). ${model.blocks[best].letter}블록에 억지로 둡니다.` });
      }
      classSectionsPut(model, place, section.index, best);
    }
  }
  return { place, issues };
}

// ---- 학생 배정(블록 단위): 단위 = 같은 조합(·담임반·고정·기존 배정)의 학생 묶음 ----
function classSectionsUnits(model, withDetail) {
  const map = new Map();
  const units = [];
  for (const student of model.students) {
    if (!student.courses.length) continue;
    const parts = [student.courses.join(","), student.pinSec.join(",")];
    if (withDetail) parts.push(student.homeroom, student.prevSec.join(","));
    const key = parts.join("|");
    let unit = map.get(key);
    if (!unit) {
      unit = { key, courses: student.courses, pinSec: student.pinSec, prevSec: withDetail ? student.prevSec : null,
        homeroom: withDetail ? student.homeroom : "", count: 0, students: [], combo: student.courses.join(",") + "|" + student.pinSec.join(",") };
      map.set(key, unit);
      units.push(unit);
    }
    unit.count += 1;
    unit.students.push(student.index);
  }
  return units;
}

function classSectionsRouterNew(model, units, weights) {
  const C = model.courses.length;
  const B = model.blocks.length;
  const homeIds = new Map();
  const r = { model, C, B, units, weights, load: new Int32Array(C * B), cap: new Int32Array(C * B), sec: new Int32Array(C * B),
    perms: units.map(() => null), np: new Int32Array(units.length), y: units.map(() => null), act: units.map(() => []), keep: units.map(() => null),
    home: weights.home > 0 ? new Map() : null, homeId: new Int32Array(units.length), overflow: 0, W: CLASS_SECTIONS_OVERFLOW_COST, byCourse: Array.from({ length: C }, () => []), capUnit: model.defaultCapacity };
  units.forEach((unit, u) => {
    unit.courses.forEach((c) => r.byCourse[c].push(u));
    if (!homeIds.has(unit.homeroom)) homeIds.set(unit.homeroom, homeIds.size);
    r.homeId[u] = homeIds.get(unit.homeroom);
  });
  return r;
}

function classSectionsCellCost(r, cell, load) {
  const cap = r.cap[cell];
  const sec = r.sec[cell];
  if (load <= 0) return 0;
  if (sec === 0) return r.W * load * 2;
  const over = load > cap ? load - cap : 0;
  return r.W * over + r.weights.bal * load * load / (sec * r.capUnit);
}

function classSectionsEnumerate(r, unit, blockOf) {
  const B = r.B;
  const m = unit.courses.length;
  const out = [];
  const current = new Array(m);
  const walk = (pos, used) => {
    if (pos === m) { out.push(...current); return; }
    const c = unit.courses[pos];
    const pinned = unit.pinSec[pos];
    for (let b = 0; b < B; b += 1) {
      if (used & (1 << b)) continue;
      if (r.sec[c * B + b] === 0) continue;
      if (pinned >= 0 && blockOf[pinned] !== b) continue;
      current[pos] = b;
      walk(pos + 1, used | (1 << b));
    }
  };
  walk(0, 0);
  return Int8Array.from(out);
}

function classSectionsHomeArr(r, c, h) {
  const key = c * 65536 + h;
  let arr = r.home.get(key);
  if (!arr) { arr = new Int32Array(r.B); r.home.set(key, arr); }
  return arr;
}

// 단위 u 학생 한 명을 순열 p에 더할 때(sign=1) 또는 뺄 때(sign=-1)의 비용 변화.
function classSectionsUnitDelta(r, u, p, sign) {
  const unit = r.units[u];
  const perms = r.perms[u];
  const courses = unit.courses;
  const m = courses.length;
  const B = r.B;
  const load = r.load;
  const capArr = r.cap;
  const secArr = r.sec;
  const W = r.W;
  const bal = r.weights.bal / r.capUnit;
  let delta = 0;
  for (let i = 0; i < m; i += 1) {
    const b = perms[p * m + i];
    const cell = courses[i] * B + b;
    const before = load[cell];
    const after = before + sign;
    const sec = secArr[cell];
    if (sec === 0) delta += W * 2 * (after - before);
    else {
      const cap = capArr[cell];
      delta += W * ((after > cap ? after - cap : 0) - (before > cap ? before - cap : 0)) + bal * (after * after - before * before) / sec;
    }
    if (r.home) {
      const key = courses[i] * 65536 + r.homeId[u];
      const arr = r.home.get(key);
      const count = arr ? arr[b] : 0;
      if (sign > 0 && count === 0) delta += r.weights.home;
      if (sign < 0 && count === 1) delta -= r.weights.home;
    }
  }
  if (r.keep[u]) delta += sign * r.weights.keep * r.keep[u][p];
  return delta;
}

function classSectionsUnitApply(r, u, p, sign) {
  const unit = r.units[u];
  const perms = r.perms[u];
  const courses = unit.courses;
  const m = courses.length;
  const B = r.B;
  const load = r.load;
  const capArr = r.cap;
  let overflow = r.overflow;
  for (let i = 0; i < m; i += 1) {
    const b = perms[p * m + i];
    const cell = courses[i] * B + b;
    const before = load[cell];
    const after = before + sign;
    load[cell] = after;
    const cap = capArr[cell];
    overflow += (after > cap ? after - cap : 0) - (before > cap ? before - cap : 0);
    if (r.home) {
      const key = courses[i] * 65536 + r.homeId[u];
      let arr = r.home.get(key);
      if (!arr) { arr = new Int32Array(B); r.home.set(key, arr); }
      arr[b] += sign;
    }
  }
  r.overflow = overflow;
  const y = r.y[u];
  const prev = y[p];
  y[p] = prev + sign;
  if (prev === 0 && sign > 0) r.act[u].push(p);
  else if (prev + sign === 0) { const list = r.act[u]; const at = list.indexOf(p); list[at] = list[list.length - 1]; list.pop(); }
}

// 학생 한 명을 가장 싼 순열에 넣는다. 가능한 순열이 없으면 false.
function classSectionsUnitPlaceOne(r, u, rng) {
  const np = r.np[u];
  if (!np) return false;
  let best = -1;
  let bestDelta = Infinity;
  let ties = 0;
  for (let p = 0; p < np; p += 1) {
    const delta = classSectionsUnitDelta(r, u, p, 1);
    if (delta < bestDelta - 1e-9) { bestDelta = delta; best = p; ties = 1; }
    else if (delta <= bestDelta + 1e-9) { ties += 1; if (rng() * ties < 1) best = p; }
  }
  classSectionsUnitApply(r, u, best, 1);
  return true;
}

// 배치가 바뀌면 순열을 다시 만들고 기존 인원을 같은 순열로 옮긴다(없어진 순열의 학생은 탐욕으로 다시 넣음).
function classSectionsRouterRebuild(r, place, rng, warm) {
  r.cap.set(place.cellCap);
  r.sec.set(place.cellSec);
  const pending = [];
  for (let u = 0; u < r.units.length; u += 1) {
    const unit = r.units[u];
    const m = unit.courses.length;
    const oldPerms = r.perms[u];
    const oldY = r.y[u];
    const perms = classSectionsEnumerate(r, unit, place.blockOf);
    const np = perms.length / m;
    r.perms[u] = perms;
    r.np[u] = np;
    r.y[u] = new Int32Array(np);
    r.act[u] = [];
    if (unit.prevSec && unit.prevSec.some((value) => value >= 0)) {
      const keep = new Int32Array(np);
      for (let p = 0; p < np; p += 1) {
        let miss = 0;
        for (let i = 0; i < m; i += 1) if (unit.prevSec[i] >= 0 && place.blockOf[unit.prevSec[i]] !== perms[p * m + i]) miss += 1;
        keep[p] = miss;
      }
      r.keep[u] = keep;
    } else r.keep[u] = null;
    let placed = 0;
    if (warm && oldPerms && oldY) {
      const index = new Map();
      for (let p = 0; p < np; p += 1) index.set(Array.prototype.join.call(perms.subarray(p * m, p * m + m), ","), p);
      const oldNp = oldPerms.length / m;
      for (let p = 0; p < oldNp; p += 1) {
        if (!oldY[p]) continue;
        const at = index.get(Array.prototype.join.call(oldPerms.subarray(p * m, p * m + m), ","));
        if (at !== undefined) { r.y[u][at] += oldY[p]; placed += oldY[p]; }
      }
    }
    for (let p = 0; p < np; p += 1) if (r.y[u][p]) r.act[u].push(p);
    for (let k = placed; k < unit.count; k += 1) pending.push(u);
  }
  classSectionsRouterRecount(r);
  pending.sort((a, b) => r.np[a] - r.np[b] || a - b);
  let impossible = 0;
  for (const u of pending) if (!classSectionsUnitPlaceOne(r, u, rng)) impossible += 1;
  return impossible;
}

function classSectionsRouterRecount(r) {
  r.load.fill(0);
  if (r.home) r.home.clear();
  for (let u = 0; u < r.units.length; u += 1) {
    const unit = r.units[u];
    const m = unit.courses.length;
    const perms = r.perms[u];
    const y = r.y[u];
    if (!y) continue;
    for (let p = 0; p < y.length; p += 1) {
      if (!y[p]) continue;
      for (let i = 0; i < m; i += 1) {
        const b = perms[p * m + i];
        r.load[unit.courses[i] * r.B + b] += y[p];
        if (r.home) classSectionsHomeArr(r, unit.courses[i], r.homeId[u])[b] += y[p];
      }
    }
  }
  r.overflow = 0;
  for (let cell = 0; cell < r.load.length; cell += 1) if (r.load[cell] > r.cap[cell]) r.overflow += r.load[cell] - r.cap[cell];
  r.impossible = 0;
  for (let u = 0; u < r.units.length; u += 1) if (!r.np[u]) r.impossible += r.units[u].count;
}

function classSectionsRouterCost(r) {
  let cost = 0;
  for (let cell = 0; cell < r.load.length; cell += 1) cost += classSectionsCellCost(r, cell, r.load[cell]);
  if (r.home) for (const arr of r.home.values()) { let used = 0; for (let b = 0; b < arr.length; b += 1) if (arr[b]) used += 1; if (used) cost += r.weights.home * (used - 1); }
  for (let u = 0; u < r.units.length; u += 1) {
    if (!r.keep[u]) continue;
    const y = r.y[u];
    for (let p = 0; p < y.length; p += 1) if (y[p]) cost += r.weights.keep * r.keep[u][p] * y[p];
  }
  return cost;
}

function classSectionsRouterSnapshot(r) {
  return { perms: r.perms.slice(), np: r.np.slice(), y: r.y.map((arr) => (arr ? arr.slice() : arr)), keep: r.keep.slice(), cap: r.cap.slice(), sec: r.sec.slice() };
}

function classSectionsRouterRestore(r, snap) {
  r.perms = snap.perms.slice();
  r.np = snap.np.slice();
  r.y = snap.y.map((arr) => (arr ? arr.slice() : arr));
  r.keep = snap.keep.slice();
  r.cap.set(snap.cap);
  r.sec.set(snap.sec);
  r.act = r.y.map((arr) => { const list = []; if (arr) for (let p = 0; p < arr.length; p += 1) if (arr[p]) list.push(p); return list; });
  classSectionsRouterRecount(r);
}

// 담금질 지역 탐색: 학생 한 명을 다른 순열로 옮긴다. 넘침이 있으면 넘친 칸의 학생을 우선 고른다.
function classSectionsRouterSearch(r, rng, iterations, stopWhenFeasible, deadline) {
  const B = r.B;
  const unitDelta = classSectionsUnitDelta;
  const unitApply = classSectionsUnitApply;
  const now = classSectionsNow;
  const floor = Math.floor;
  const exp = Math.exp;
  const pow = Math.pow;
  const movable = [];
  for (let u = 0; u < r.units.length; u += 1) if (r.np[u] > 1) movable.push(u);
  if (!movable.length || iterations <= 0) return { iterations: 0 };
  let bestCost = classSectionsRouterCost(r);
  let bestOverflow = r.overflow;
  let best = null;
  let cost = bestCost;
  let overCells = [];
  const refreshOver = () => {
    overCells = [];
    for (let cell = 0; cell < r.load.length; cell += 1) if (r.load[cell] > r.cap[cell]) overCells.push(cell);
  };
  refreshOver();
  const T0 = 2;
  const T1 = 0.02;
  let sinceBest = 0;
  let it = 0;
  for (; it < iterations; it += 1) {
    if (stopWhenFeasible && r.overflow === 0) break;
    if ((it & 255) === 0) {
      refreshOver();
      if (deadline && now() > deadline) break;
    }
    let u = -1;
    let p = -1;
    if (r.overflow > 0 && overCells.length && rng() < 0.75) {
      const cell = overCells[floor(rng() * overCells.length)];
      const c = floor(cell / B);
      const b = cell % B;
      const list = r.byCourse[c];
      for (let tries = 0; tries < 6 && p < 0; tries += 1) {
        const cand = list[floor(rng() * list.length)];
        if (r.np[cand] < 2 || !r.act[cand].length) continue;
        const pos = r.units[cand].courses.indexOf(c);
        const m = r.units[cand].courses.length;
        const act = r.act[cand];
        const start = floor(rng() * act.length);
        for (let k = 0; k < act.length; k += 1) {
          const q = act[(start + k) % act.length];
          if (r.perms[cand][q * m + pos] === b) { u = cand; p = q; break; }
        }
      }
    }
    if (p < 0) {
      u = movable[floor(rng() * movable.length)];
      const act = r.act[u];
      if (!act.length) continue;
      p = act[floor(rng() * act.length)];
    }
    const removeDelta = unitDelta(r, u, p, -1);
    unitApply(r, u, p, -1);
    let bestQ = -1;
    let bestDelta = Infinity;
    let ties = 0;
    const np = r.np[u];
    for (let q = 0; q < np; q += 1) {
      if (q === p) continue;
      const delta = unitDelta(r, u, q, 1);
      if (delta < bestDelta - 1e-9) { bestDelta = delta; bestQ = q; ties = 1; }
      else if (delta <= bestDelta + 1e-9) { ties += 1; if (rng() * ties < 1) bestQ = q; }
    }
    const total = removeDelta + bestDelta;
    const temp = T0 * pow(T1 / T0, it / iterations);
    if (bestQ >= 0 && (total <= 1e-9 || rng() < exp(-total / temp))) {
      unitApply(r, u, bestQ, 1);
      cost += total;
    } else {
      unitApply(r, u, p, 1);
    }
    // 넘침이 줄 때만 상태를 저장한다(비용만 나아지는 경우는 낮은 온도에서 현재 상태가 곧 가장 좋은 상태라 저장하지 않음).
    if (r.overflow < bestOverflow) {
      bestOverflow = r.overflow;
      best = r.overflow === 0 ? null : classSectionsRouterSnapshotY(r);
    }
    if (cost < bestCost - 1e-6) { bestCost = cost; sinceBest = 0; }
    else {
      sinceBest += 1;
      if (!stopWhenFeasible && r.overflow === 0 && sinceBest > ((a, b) => (a > b ? a : b))(3000, iterations / 4)) { it += 1; break; }
    }
  }
  if (best && r.overflow > bestOverflow) classSectionsRouterRestoreY(r, best);
  return { iterations: it };
}

function classSectionsRouterSnapshotY(r) {
  return r.y.map((arr) => (arr ? arr.slice() : arr));
}

function classSectionsRouterRestoreY(r, ys) {
  r.y = ys.map((arr) => (arr ? arr.slice() : arr));
  r.act = r.y.map((arr) => { const list = []; if (arr) for (let p = 0; p < arr.length; p += 1) if (arr[p]) list.push(p); return list; });
  classSectionsRouterRecount(r);
}

// ---- 블록 배치 탐색 ----
function classSectionsPlacementMove(model, place, r, rng, co) {
  const B = model.blocks.length;
  const C = model.courses.length;
  const S = model.sections.length;
  const free = (s) => model.sections[s].fixedBlock < 0;
  const changes = [];
  // 블록이 하나뿐이면(택1) 옮길 곳이 없다.
  if (B < 2) return changes;
  const tryMove = (s, target) => {
    if (!free(s) || place.blockOf[s] === target) return false;
    const from = place.blockOf[s];
    if (classSectionsCanPlace(model, place, s, target, -1)) {
      changes.push([s, from]);
      classSectionsPut(model, place, s, target);
      return true;
    }
    // 블록이 차 있으면 그 블록의 다른 과목 분반 하나와 맞바꾼다.
    const others = [];
    for (let t = 0; t < S; t += 1) if (t !== s && place.blockOf[t] === target && free(t) && model.sections[t].course !== model.sections[s].course) others.push(t);
    for (let k = others.length - 1; k > 0; k -= 1) { const j = Math.floor(rng() * (k + 1)); [others[k], others[j]] = [others[j], others[k]]; }
    for (const t of others.slice(0, 6)) {
      classSectionsPut(model, place, s, -1);
      classSectionsPut(model, place, t, -1);
      const ok = classSectionsCanPlace(model, place, s, target, -1) && (classSectionsPut(model, place, s, target), classSectionsCanPlace(model, place, t, from, -1));
      if (ok) {
        classSectionsPut(model, place, t, from);
        changes.push([s, from], [t, target]);
        return true;
      }
      if (place.blockOf[s] === target) classSectionsPut(model, place, s, -1);
      classSectionsPut(model, place, s, from);
      classSectionsPut(model, place, t, target);
    }
    return false;
  };
  if (r.impossible > 0 && rng() < 0.5) {
    // 함께 들을 블록이 없는 학생 묶음: 그 과목 분반 하나를 다른 블록으로.
    const stuck = [];
    for (let u = 0; u < r.units.length; u += 1) if (!r.np[u]) stuck.push(u);
    const unit = r.units[stuck[Math.floor(rng() * stuck.length)]];
    const c = unit.courses[Math.floor(rng() * unit.courses.length)];
    const cands = [];
    for (let s = 0; s < S; s += 1) if (model.sections[s].course === c && free(s)) cands.push(s);
    if (cands.length && B > 1) {
      const s = cands[Math.floor(rng() * cands.length)];
      let target = Math.floor(rng() * (B - 1));
      if (target >= place.blockOf[s]) target += 1;
      tryMove(s, target);
    }
  }
  if (!changes.length && r.overflow > 0 && rng() < 0.8) {
    const overCells = [];
    for (let cell = 0; cell < r.load.length; cell += 1) if (r.load[cell] > r.cap[cell]) overCells.push(cell);
    const cell = overCells[Math.floor(rng() * overCells.length)];
    const c = Math.floor(cell / B);
    const b = cell % B;
    if (rng() < 0.6) {
      // 넘친 과목의 다른 블록 분반을 이 블록으로.
      const cands = [];
      for (let s = 0; s < S; s += 1) if (model.sections[s].course === c && place.blockOf[s] !== b && free(s)) cands.push(s);
      if (cands.length) tryMove(cands[Math.floor(rng() * cands.length)], b);
    } else {
      // 같이 듣는 학생이 많은 다른 과목 분반을 이 블록에서 빼낸다.
      let total = 0;
      const cands = [];
      for (let s = 0; s < S; s += 1) {
        const other = model.sections[s].course;
        if (other === c || place.blockOf[s] !== b || !free(s)) continue;
        const weight = co[c * C + other] + 0.5;
        total += weight;
        cands.push([s, weight]);
      }
      let pick = rng() * total;
      for (const [s, weight] of cands) {
        pick -= weight;
        if (pick <= 0) {
          let target = Math.floor(rng() * (B - 1));
          if (target >= b) target += 1;
          tryMove(s, target);
          break;
        }
      }
    }
  }
  if (!changes.length) {
    const s = Math.floor(rng() * S);
    if (B > 1) {
      let target = Math.floor(rng() * (B - 1));
      if (target >= place.blockOf[s]) target += 1;
      tryMove(s, target);
    }
  }
  return changes;
}

function classSectionsUndo(model, place, changes) {
  for (let k = changes.length - 1; k >= 0; k -= 1) classSectionsPut(model, place, changes[k][0], changes[k][1]);
}

// 블록 배치를 찾는다. 반환: { place, router(조합 단위), steps, issues }
function classSectionsPlace(model, rng, deadline, startPlace) {
  const weights = { bal: 0.2, home: 0, keep: 0 };
  const units = classSectionsUnits(model, false);
  const r = classSectionsRouterNew(model, units, weights);
  let place;
  let issues = [];
  if (startPlace) place = startPlace;
  else ({ place, issues } = classSectionsInitialPlacement(model, rng));
  const studentsCount = model.students.length;
  const evalIterations = model.options.evalIterations || Math.min(6000, 600 + studentsCount * 4);
  const maxSteps = model.options.placementSteps || Math.min(1500, 150 + model.sections.length * 12);
  classSectionsRouterRebuild(r, place, rng, false);
  classSectionsRouterSearch(r, rng, evalIterations * 2, true, deadline);
  let curOver = r.overflow + r.impossible;
  let curCost = classSectionsRouterCost(r);
  const co = classSectionsCooccurrence(model);
  let steps = 0;
  let timedOut = false;
  const freeSections = model.blocks.length > 1 && model.sections.some((section) => section.fixedBlock < 0);
  for (; steps < maxSteps && curOver > 0 && freeSections; steps += 1) {
    if (deadline && classSectionsNow() > deadline) { timedOut = true; break; }
    const snap = classSectionsRouterSnapshot(r);
    const changes = classSectionsPlacementMove(model, place, r, rng, co);
    if (!changes.length) continue;
    classSectionsRouterRebuild(r, place, rng, true);
    classSectionsRouterSearch(r, rng, evalIterations, true, deadline);
    const over = r.overflow + r.impossible;
    const cost = classSectionsRouterCost(r);
    const accept = over < curOver || (over === curOver && (cost <= curCost || rng() < 0.15));
    if (accept) { curOver = over; curCost = cost; }
    else { classSectionsUndo(model, place, changes); classSectionsRouterRestore(r, snap); }
  }
  return { place, router: r, steps, issues, timedOut };
}

// ---- 학생 배정(최종) ----
function classSectionsRoute(model, place, comboRouter, weights, rng, deadline) {
  const units = classSectionsUnits(model, true);
  const r = classSectionsRouterNew(model, units, weights);
  r.cap.set(place.cellCap);
  r.sec.set(place.cellSec);
  for (let u = 0; u < units.length; u += 1) {
    const unit = units[u];
    const m = unit.courses.length;
    r.perms[u] = classSectionsEnumerate(r, unit, place.blockOf);
    r.np[u] = r.perms[u].length / m;
    r.y[u] = new Int32Array(r.np[u]);
    if (unit.prevSec && unit.prevSec.some((value) => value >= 0)) {
      const keep = new Int32Array(r.np[u]);
      for (let p = 0; p < r.np[u]; p += 1) {
        let miss = 0;
        for (let i = 0; i < m; i += 1) if (unit.prevSec[i] >= 0 && place.blockOf[unit.prevSec[i]] !== r.perms[u][p * m + i]) miss += 1;
        keep[p] = miss;
      }
      r.keep[u] = keep;
    }
  }
  classSectionsRouterRecount(r);
  // 조합 단위 해의 순열 꾸러미를 세부 단위에 나눠 준다(넘침 0을 유지한 채 시작).
  const pools = new Map();
  if (comboRouter) {
    comboRouter.units.forEach((unit, u) => {
      const m = unit.courses.length;
      const list = [];
      const y = comboRouter.y[u];
      if (y) for (let p = 0; p < y.length; p += 1) for (let k = 0; k < y[p]; k += 1) list.push(Array.prototype.join.call(comboRouter.perms[u].subarray(p * m, p * m + m), ","));
      pools.set(unit.combo, list);
    });
  }
  const order = units.map((_, u) => u).sort((a, b) => (units[b].homeroom < units[a].homeroom ? 1 : units[b].homeroom > units[a].homeroom ? -1 : 0) || a - b);
  for (const u of order) {
    const unit = units[u];
    const m = unit.courses.length;
    const pool = pools.get(unit.combo) || [];
    const index = new Map();
    for (let p = 0; p < r.np[u]; p += 1) index.set(Array.prototype.join.call(r.perms[u].subarray(p * m, p * m + m), ","), p);
    for (let k = 0; k < unit.count; k += 1) {
      let chosen = -1;
      if (pool.length) {
        let bestDelta = Infinity;
        let bestAt = -1;
        const seen = new Set();
        for (let at = 0; at < pool.length; at += 1) {
          if (seen.has(pool[at])) continue;
          seen.add(pool[at]);
          const p = index.get(pool[at]);
          if (p === undefined) continue;
          const delta = classSectionsUnitDelta(r, u, p, 1);
          if (delta < bestDelta) { bestDelta = delta; bestAt = at; chosen = p; }
        }
        if (bestAt >= 0) { pool[bestAt] = pool[pool.length - 1]; pool.pop(); }
      }
      if (chosen >= 0) classSectionsUnitApply(r, u, chosen, 1);
      else classSectionsUnitPlaceOne(r, u, rng);
    }
  }
  const studentsCount = model.students.length;
  const iterations = model.options.finalIterations || Math.min(60000, 4000 + studentsCount * 40);
  const search = classSectionsRouterSearch(r, rng, iterations, false, deadline);
  return { router: r, iterations: search.iterations };
}

// 가능한 순열이 없는 학생: 과목을 빼면서(-1) 넣을 수 있는 과목 수가 가장 많고 넘침이 적은 배치.
function classSectionsPartialPerm(r, unit, blockOf) {
  const B = r.B;
  const m = unit.courses.length;
  const current = new Array(m).fill(-1);
  let best = current.slice();
  let bestScore = -Infinity;
  const walk = (pos, used, count, over) => {
    if (pos === m) {
      const score = count * 1000 - over;
      if (score > bestScore) { bestScore = score; best = current.slice(); }
      return;
    }
    const c = unit.courses[pos];
    const pinned = unit.pinSec[pos];
    for (let b = 0; b < B; b += 1) {
      if (used & (1 << b)) continue;
      const cell = c * B + b;
      if (r.sec[cell] === 0) continue;
      if (pinned >= 0 && blockOf[pinned] !== b) continue;
      current[pos] = b;
      walk(pos + 1, used | (1 << b), count + 1, over + (r.load[cell] >= r.cap[cell] ? 1 : 0));
    }
    current[pos] = -1;
    walk(pos + 1, used, count, over);
  };
  walk(0, 0, 0, 0);
  return best;
}

// ---- 최소 비용 유량(작은 그래프용, SPFA) ----
// edges: [[from, to, cap, cost]], 반환: { flow, cost, flows:[간선별 흐름] }
function classSectionsMinCostFlow(nodeCount, edges, source, sink, maxFlow) {
  const head = new Int32Array(nodeCount).fill(-1);
  const to = [];
  const cap = [];
  const cost = [];
  const next = [];
  const add = (a, b, c, w) => {
    to.push(b); cap.push(c); cost.push(w); next.push(head[a]); head[a] = to.length - 1;
    to.push(a); cap.push(0); cost.push(-w); next.push(head[b]); head[b] = to.length - 1;
  };
  edges.forEach(([a, b, c, w]) => add(a, b, c, w));
  let flow = 0;
  let total = 0;
  const limit = maxFlow === undefined ? Infinity : maxFlow;
  const dist = new Float64Array(nodeCount);
  const inQueue = new Uint8Array(nodeCount);
  const prevEdge = new Int32Array(nodeCount);
  while (flow < limit) {
    dist.fill(Infinity);
    prevEdge.fill(-1);
    dist[source] = 0;
    const queue = [source];
    inQueue[source] = 1;
    for (let qi = 0; qi < queue.length; qi += 1) {
      const a = queue[qi];
      inQueue[a] = 0;
      for (let e = head[a]; e >= 0; e = next[e]) {
        if (cap[e] <= 0) continue;
        const nd = dist[a] + cost[e];
        if (nd < dist[to[e]] - 1e-12) {
          dist[to[e]] = nd;
          prevEdge[to[e]] = e;
          if (!inQueue[to[e]]) { inQueue[to[e]] = 1; queue.push(to[e]); }
        }
      }
    }
    if (dist[sink] === Infinity) break;
    let push = limit - flow;
    for (let v = sink; v !== source; v = to[prevEdge[v] ^ 1]) push = Math.min(push, cap[prevEdge[v]]);
    for (let v = sink; v !== source; v = to[prevEdge[v] ^ 1]) { cap[prevEdge[v]] -= push; cap[prevEdge[v] ^ 1] += push; }
    flow += push;
    total += push * dist[sink];
  }
  const flows = edges.map((edge, i) => cap[i * 2 + 1]);
  return { flow, cost: total, flows };
}

// ---- 칸(과목×블록) 안 분반 나누기 ----
function classSectionsFillCells(model, place, r) {
  const B = model.blocks.length;
  const sectionOf = model.students.map((student) => student.courses.map(() => -1));
  const unassigned = [];
  const cells = new Map();
  // 단위 순열을 학생에게 나눈다(기존 블록과 같은 순열을 그 학생에게 먼저).
  r.units.forEach((unit, u) => {
    const m = unit.courses.length;
    const y = r.y[u];
    const pool = [];
    if (y) for (let p = 0; p < y.length; p += 1) for (let k = 0; k < y[p]; k += 1) pool.push(p);
    const students = unit.students.slice();
    if (!r.np[u]) {
      // 모든 과목을 서로 다른 블록에 넣을 수 없으면 되도록 많은 과목만 넣고 나머지를 미배정으로 둔다.
      for (const s of students) {
        const blocksFor = classSectionsPartialPerm(r, unit, place.blockOf);
        for (let i = 0; i < m; i += 1) {
          if (blocksFor[i] < 0) { unassigned.push({ studentKey: model.students[s].key, courseKey: model.courses[unit.courses[i]].key, reason: "no-block" }); continue; }
          const cell = unit.courses[i] * B + blocksFor[i];
          r.load[cell] += 1;
          if (!cells.has(cell)) cells.set(cell, []);
          cells.get(cell).push([s, i]);
        }
      }
      return;
    }
    for (const s of students) {
      const p = pool.pop();
      for (let i = 0; i < m; i += 1) {
        const cell = unit.courses[i] * B + r.perms[u][p * m + i];
        if (!cells.has(cell)) cells.set(cell, []);
        cells.get(cell).push([s, i]);
      }
    }
  });
  const sectionsByCell = new Map();
  for (const section of model.sections) {
    const cell = section.course * B + place.blockOf[section.index];
    if (!sectionsByCell.has(cell)) sectionsByCell.set(cell, []);
    sectionsByCell.get(cell).push(section.index);
  }
  const homeroomMode = model.mode === "homeroom";
  for (const [cell, members] of cells) {
    const list = sectionsByCell.get(cell) || [];
    if (!list.length) {
      for (const [s, i] of members) unassigned.push({ studentKey: model.students[s].key, courseKey: model.courses[model.students[s].courses[i]].key, reason: "no-block" });
      continue;
    }
    const L = members.length;
    const caps = list.map((s) => model.sections[s].capacity);
    // 목표 인원: 균등(담임반 모드는 +2까지 허용), 정원 이내.
    let targets;
    if (list.length === 1) targets = [Math.min(caps[0], L)];
    else {
      const total = caps.reduce((sum, value) => sum + value, 0);
      targets = caps.map((value) => Math.floor(L * value / total));
      let rest = L - targets.reduce((sum, value) => sum + value, 0);
      for (let k = 0; rest > 0 && k < list.length * 4; k += 1) { const i = k % list.length; if (targets[i] < caps[i]) { targets[i] += 1; rest -= 1; } }
      if (homeroomMode) targets = targets.map((value, i) => Math.min(caps[i], value + 2));
      targets = targets.map((value, i) => Math.min(value, caps[i]));
    }
    // 학생별 희망 분반: 고정 > 기존 분반 > 담임반 묶음.
    const prefOf = new Array(L).fill(-1);
    const forced = new Array(L).fill(false);
    const localIndex = new Map(list.map((s, k) => [s, k]));
    members.forEach(([s, i], at) => {
      const student = model.students[s];
      if (student.pinSec[i] >= 0 && localIndex.has(student.pinSec[i])) { prefOf[at] = localIndex.get(student.pinSec[i]); forced[at] = true; }
      else if (student.prevSec[i] >= 0 && localIndex.has(student.prevSec[i])) prefOf[at] = localIndex.get(student.prevSec[i]);
    });
    if (list.length > 1) {
      const groups = new Map();
      members.forEach(([s], at) => { if (prefOf[at] >= 0) return; const h = model.students[s].homeroom; if (!groups.has(h)) groups.set(h, []); groups.get(h).push(at); });
      const room = targets.slice();
      members.forEach((_, at) => { if (prefOf[at] >= 0) room[prefOf[at]] -= 1; });
      const sorted = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
      for (const [, ats] of sorted) {
        let best = 0;
        for (let k = 1; k < list.length; k += 1) if (room[k] > room[best]) best = k;
        for (const at of ats) prefOf[at] = best;
        room[best] -= ats.length;
      }
    }
    // 묶음(희망 분반·고정 여부) → 분반 최소 비용 유량.
    const buckets = new Map();
    members.forEach((_, at) => {
      const key = `${prefOf[at]}|${forced[at] ? 1 : 0}`;
      if (!buckets.has(key)) buckets.set(key, { pref: prefOf[at], forced: forced[at], ats: [] });
      buckets.get(key).ats.push(at);
    });
    const bucketList = [...buckets.values()];
    const source = 0;
    const sink = 1 + bucketList.length + list.length;
    const edges = [];
    bucketList.forEach((bucket, k) => {
      edges.push([source, 1 + k, bucket.ats.length, 0]);
      for (let j = 0; j < list.length; j += 1) {
        if (bucket.forced && j !== bucket.pref) continue;
        edges.push([1 + k, 1 + bucketList.length + j, bucket.ats.length, j === bucket.pref ? 0 : 1]);
      }
    });
    list.forEach((s, j) => edges.push([1 + bucketList.length + j, sink, targets[j], 0]));
    const flowResult = classSectionsMinCostFlow(sink + 1, edges, source, sink);
    let edgeAt = 0;
    const leftovers = [];
    bucketList.forEach((bucket) => {
      edgeAt += 1;
      let cursor = 0;
      for (let j = 0; j < list.length; j += 1) {
        if (bucket.forced && j !== bucket.pref) continue;
        const amount = flowResult.flows[edgeAt];
        edgeAt += 1;
        for (let k = 0; k < amount; k += 1) {
          const [s, i] = members[bucket.ats[cursor]];
          sectionOf[s][i] = list[j];
          cursor += 1;
        }
      }
      for (; cursor < bucket.ats.length; cursor += 1) leftovers.push(bucket.ats[cursor]);
    });
    for (const at of leftovers) {
      const [s, i] = members[at];
      if (forced[at]) { sectionOf[s][i] = list[prefOf[at]]; continue; } // 고정은 정원을 넘어도 지킨다(검증기가 알림).
      unassigned.push({ studentKey: model.students[s].key, courseKey: model.courses[model.students[s].courses[i]].key, reason: "capacity" });
    }
  }
  return { sectionOf, unassigned };
}

// ---- 교사 배정 추천 ----
// spec: { teachers(정규화 전 모양), sections:[{ id, courseKey, courseName, department, credits, blockKey, times }], fixedSlots, pins:{분반:교사}, previous:{분반:교사} }
function classSectionsAssignTeachers(spec) {
  const teachers = (spec.teachers || []).map((raw, index) => ({
    index, id: classSectionsText(raw.id) || classSectionsText(raw.name) || `t${index + 1}`, name: classSectionsText(raw.name ?? raw.id),
    departments: new Set((raw.departments || []).map(classSectionsText)), courses: new Set((raw.courses || []).map(classSectionsText)),
    unavailable: (raw.unavailable || []).map((item) => ({ slot: classSectionsSlot(item), reason: classSectionsText(item?.reason) })).filter((item) => item.slot),
    maxHours: Number(raw.maxHours) || Infinity, busySlots: new Set(), busyBlocks: new Set(), hours: 0
  }));
  const byId = new Map(teachers.map((teacher) => [teacher.id, teacher]));
  for (const slot of spec.fixedSlots || []) {
    for (const id of slot.teacherIds || []) { const teacher = byId.get(classSectionsText(id)); if (teacher) classSectionsSlots(slot.times).forEach((value) => teacher.busySlots.add(value)); }
  }
  const sections = (spec.sections || []).map((raw) => ({ ...raw, times: classSectionsSlots(raw.times) }));
  const qualified = (teacher, section) => teacher.courses.has(classSectionsText(section.courseKey)) || teacher.courses.has(classSectionsText(section.courseName))
    || (section.department && teacher.departments.has(section.department));
  const unavailableReason = (teacher, section) => teacher.unavailable.find((item) => section.times.includes(item.slot)) || null;
  const free = (teacher, section) => !teacher.busyBlocks.has(section.blockKey) && !section.times.some((slot) => teacher.busySlots.has(slot));
  const assignTo = (teacher, section, sign) => {
    if (sign > 0) { teacher.busyBlocks.add(section.blockKey); section.times.forEach((slot) => teacher.busySlots.add(slot)); teacher.hours += section.credits || 0; }
    else { teacher.busyBlocks.delete(section.blockKey); section.times.forEach((slot) => teacher.busySlots.delete(slot)); teacher.hours -= section.credits || 0; }
  };
  const teacherOf = {};
  const issues = [];
  const pins = spec.pins || {};
  const previous = spec.previous || {};
  const eligible = new Map();
  for (const section of sections) {
    eligible.set(section.id, teachers.filter((teacher) => qualified(teacher, section) && !unavailableReason(teacher, section)));
  }
  // 고정 먼저
  for (const section of sections) {
    const teacher = byId.get(classSectionsText(pins[section.id]));
    if (!teacher) continue;
    const reason = unavailableReason(teacher, section);
    if (reason) issues.push({ type: "teacher-unavailable", severity: "error", sectionId: section.id, teacherId: teacher.id, message: `${teacher.name} 선생님은 ${reason.slot.replace(":", "요일 ")}교시에 수업할 수 없습니다${reason.reason ? `(${reason.reason})` : ""}: ${section.courseName}` });
    if (!free(teacher, section)) issues.push({ type: "teacher-double", severity: "error", sectionId: section.id, teacherId: teacher.id, message: `${teacher.name} 선생님이 같은 시간에 두 분반을 맡습니다: ${section.courseName}` });
    teacherOf[section.id] = teacher.id;
    assignTo(teacher, section, 1);
  }
  const noQualified = new Map();
  // 교사별 맡은 분반(교환 탐색용).
  const assigned = new Map(teachers.map((teacher) => [teacher.id, new Set()]));
  for (const [sectionId, teacherId] of Object.entries(teacherOf)) assigned.get(teacherId)?.add(sectionId);
  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const give = (teacher, section) => { teacherOf[section.id] = teacher.id; assigned.get(teacher.id).add(section.id); assignTo(teacher, section, 1); };
  const take = (teacher, section) => { delete teacherOf[section.id]; assigned.get(teacher.id).delete(section.id); assignTo(teacher, section, -1); };
  const fits = (teacher, section) => free(teacher, section) && teacher.hours + (section.credits || 0) <= teacher.maxHours;
  // 교환 지역 탐색(증가 경로): 맡을 교사가 없으면, 막고 있는 분반 하나를 다른 교사에게 넘기기를 깊이 depth까지 시도한다(고정 분반은 그대로).
  const place = (section, depth, seen) => {
    const list = eligible.get(section.id).filter((teacher) => !seen.has(teacher.id));
    let best = null;
    for (const teacher of list) {
      if (!fits(teacher, section)) continue;
      const score = teacher.hours - (previous[section.id] === teacher.id ? 100 : 0);
      if (!best || score < best.score) best = { teacher, score };
    }
    if (best) { give(best.teacher, section); return true; }
    if (depth <= 0) return false;
    for (const teacher of list) {
      const blockers = [...assigned.get(teacher.id)].map((id) => sectionById.get(id))
        .filter((other) => other.blockKey === section.blockKey || classSectionsOverlap(other.times, section.times));
      if (blockers.length !== 1 || pins[blockers[0].id]) continue;
      const blocker = blockers[0];
      take(teacher, blocker);
      if (fits(teacher, section)) {
        give(teacher, section);
        seen.add(teacher.id);
        if (place(blocker, depth - 1, seen)) return true;
        seen.delete(teacher.id);
        take(teacher, section);
      }
      give(teacher, blocker);
    }
    return false;
  };
  const rest = sections.filter((section) => !teacherOf[section.id]).sort((a, b) => eligible.get(a.id).length - eligible.get(b.id).length || (a.id < b.id ? -1 : 1));
  for (const section of rest) {
    const chosen = place(section, Number(spec.depth) >= 0 ? Number(spec.depth) : 3, new Set()) ? { teacher: byId.get(teacherOf[section.id]) } : null;
    if (chosen) { /* place()가 이미 배정함 */ }
    else if (!teachers.some((teacher) => qualified(teacher, section))) noQualified.set(section.courseName, (noQualified.get(section.courseName) || 0) + 1);
    else issues.push({ type: "teacher-missing", severity: "warn", sectionId: section.id,
      message: `${section.courseName}${section.label ? ` ${section.label}` : ""}: 그 시간에 맡을 수 있는 교사가 없습니다.` });
  }
  // 명단에 그 과목·교과 교사가 아예 없으면 과목마다 한 번만 안내(교사를 일부만 입력한 경우).
  for (const [name, count] of noQualified) issues.push({ type: "teacher-none", severity: "info", courseName: name,
    message: `${name}: 교사 명단에 담당 교사가 없어 분반 ${count}개의 교사를 비워 둡니다.` });
  const load = {};
  for (const teacher of teachers) load[teacher.id] = teacher.hours;
  return { teacherOf, issues, load };
}

// ---- 결과 만들기 ----
function classSectionsRoomName(blockLetter, courseName, noInBlock, countInBlock) {
  return `${blockLetter}${classSectionsCompact(courseName)}${countInBlock > 1 ? noInBlock : ""}`;
}

function classSectionsBuildResult(model, place, sectionOf, unassigned) {
  const B = model.blocks.length;
  const sizes = new Int32Array(model.sections.length);
  const assign = {};
  model.students.forEach((student, s) => {
    const list = [];
    student.courses.forEach((c, i) => { const sec = sectionOf[s][i]; if (sec >= 0) { list.push(model.sections[sec].id); sizes[sec] += 1; } });
    if (list.length || student.courses.length) assign[student.key] = list;
  });
  const perCell = new Map();
  const sections = model.sections.map((section) => {
    const b = place.blockOf[section.index];
    const cell = section.course * B + b;
    const no = (perCell.get(cell) || 0) + 1;
    perCell.set(cell, no);
    return { id: section.id, courseKey: model.courses[section.course].key, courseName: model.courses[section.course].name, ord: section.ord,
      blockId: b >= 0 ? model.blocks[b].id : "", blockLetter: b >= 0 ? model.blocks[b].letter : "", noInBlock: no, countInBlock: 0,
      capacity: section.capacity, size: sizes[section.index], fixed: section.fixedBlock >= 0, teacherId: "", roomName: "" };
  });
  for (const section of sections) {
    const course = model.courseByKey.get(section.courseKey);
    section.countInBlock = perCell.get(course.index * B + model.blocks.findIndex((block) => block.id === section.blockId)) || 0;
    section.roomName = classSectionsRoomName(section.blockLetter, section.courseName, section.noInBlock, section.countInBlock);
  }
  const blocks = model.blocks.map((block) => ({ id: block.id, letter: block.letter, label: block.label,
    maxSections: Number.isFinite(block.maxSections) ? block.maxSections : null, times: block.times.slice(),
    sectionIds: sections.filter((section) => section.blockId === block.id).map((section) => section.id) }));
  // 폐강 과목 신청(재신청 대상)은 미배정에서 따로 센다: 편성 가능 여부·미배정 수에 넣지 않는다.
  const closedRequests = model.unassignedInput.filter((item) => item.reason === "closed");
  const others = model.unassignedInput.filter((item) => item.reason !== "closed");
  return { blocks, sections, assign, unassigned: [...others, ...unassigned], closedRequests };
}

// ---- 검증기 ----
// 결과만 보고 다시 센다(계산 과정과 독립). input은 classSectionsSolve에 준 것과 같은 모양.
function classSectionsValidate(input, result, options) {
  const model = input && input.sections && input.sectionById ? input : classSectionsNormalize(input);
  const issues = [];
  const spreadWarn = Number(options?.spreadWarn) || model.options?.spreadWarn || CLASS_SECTIONS_SPREAD_WARN;
  const sectionById = new Map((result.sections || []).map((section) => [section.id, section]));
  const blockById = new Map((result.blocks || []).map((block) => [block.id, block]));
  const counts = new Map();
  const unassignedSet = new Set([...(result.unassigned || []), ...(result.closedRequests || [])].map((item) => `${item.studentKey}|${item.courseKey}`));
  for (const student of model.students) {
    const ids = result.assign?.[student.key] || [];
    const usedBlocks = new Map();
    const usedCourses = new Map();
    for (const id of ids) {
      const section = sectionById.get(id);
      if (!section) { issues.push({ type: "unknown-section", severity: "error", studentKey: student.key, message: `${student.key}: 없는 분반 ${id}` }); continue; }
      counts.set(id, (counts.get(id) || 0) + 1);
      if (usedCourses.has(section.courseKey)) issues.push({ type: "duplicate", severity: "error", studentKey: student.key, message: `${student.key}: ${section.courseName}에 두 번 편성됨` });
      usedCourses.set(section.courseKey, id);
      if (usedBlocks.has(section.blockId)) issues.push({ type: "block-conflict", severity: "error", studentKey: student.key,
        message: `${student.key}: ${section.blockLetter}블록에 두 과목(${sectionById.get(usedBlocks.get(section.blockId)).courseName}, ${section.courseName})` });
      usedBlocks.set(section.blockId, id);
      if (!student.courses.some((c) => model.courses[c].key === section.courseKey)) issues.push({ type: "not-chosen", severity: "error", studentKey: student.key, message: `${student.key}: 신청하지 않은 ${section.courseName}에 편성됨` });
    }
    for (const c of student.courses) {
      const key = model.courses[c].key;
      if (!usedCourses.has(key) && !unassignedSet.has(`${student.key}|${key}`)) issues.push({ type: "missing", severity: "error", studentKey: student.key, message: `${student.key}: ${model.courses[c].name} 배정도 미배정 기록도 없음` });
    }
  }
  // 같은 학생 집단(같은 현 학년·학기)의 다른 그룹 블록과 시간이 겹치면 학생이 두 과목을 동시에 들어야 한다.
  for (const block of result.blocks || []) {
    for (const other of model.cohortTimes || []) {
      const shared = (block.times || []).filter((slot) => other.times.includes(slot));
      if (shared.length) issues.push({ type: "cohort-clash", severity: "error", blockId: block.id,
        message: `${block.letter}블록이 같은 학생이 듣는 ${other.label}와 같은 시간(${shared.map((slot) => slot.replace(":", "")).join(", ")})입니다.` });
    }
  }
  // 학생별 그룹 과목 수 = 이동 배정 + 학급 단위(있으면 1)는 택n을 넘으면 안 된다(이중 배정).
  if (model.classUnitCheck) {
    const { choose, unitOf } = model.classUnitCheck;
    let over = 0;
    const sample = [];
    for (const [key, unit] of Object.entries(unitOf)) {
      const count = (result.assign?.[key] || []).length + (unit ? 1 : 0);
      if (count > choose) { over += 1; if (sample.length < 5) sample.push(key); }
    }
    if (over) issues.push({ type: "choice-over", severity: "error", count: over,
      message: `한 그룹에서 택${choose}보다 많은 과목에 배정된 학생 ${over}명(학급 단위 + 이동 분반 이중 배정, 예: ${sample.join(", ")})` });
  }
  // 택n보다 적게 배정됐는데 미배정·재신청(폐강) 기록도 없는 학생: 앞 단계에서 과목이 조용히 빠졌다는 뜻이므로 오류.
  if (model.choose) {
    const recorded = new Map();
    for (const item of [...(result.unassigned || []), ...(result.closedRequests || [])]) {
      if (!recorded.has(item.studentKey)) recorded.set(item.studentKey, new Set());
      recorded.get(item.studentKey).add(item.courseKey);
    }
    const unitOf = model.classUnitCheck?.unitOf || {};
    let under = 0;
    const sample = [];
    for (const student of model.students) {
      const count = (result.assign?.[student.key] || []).length + (unitOf[student.key] ? 1 : 0) + student.classUnit.length + (recorded.get(student.key)?.size || 0);
      if (count < model.choose) { under += 1; if (sample.length < 5) sample.push(student.key); }
    }
    if (under) issues.push({ type: "choice-under", severity: "error", count: under,
      message: `택${model.choose}보다 적게 배정됐는데 미배정·재신청 기록이 없는 학생 ${under}명(신청 과목이 계산에 들어오지 않음, 예: ${sample.join(", ")})` });
  }
  const unassignedCount = (result.unassigned || []).length;
  if (unassignedCount) {
    const students = new Set((result.unassigned || []).map((item) => item.studentKey));
    issues.push({ type: "unassigned", severity: "error", count: unassignedCount, students: students.size, message: `미배정 ${students.size}명(${unassignedCount}과목)` });
  }
  const blockTotals = new Map();
  const perBlockDept = new Map();
  const perBlockRoom = new Map();
  const sizesByCourse = new Map();
  for (const section of result.sections || []) {
    const size = counts.get(section.id) || 0;
    if (size > section.capacity) issues.push({ type: "over-capacity", severity: "error", sectionId: section.id, message: `${section.courseName} ${section.blockLetter}블록 분반 ${size}명 > 정원 ${section.capacity}명` });
    blockTotals.set(section.blockId, (blockTotals.get(section.blockId) || 0) + 1);
    const course = model.courseByKey.get(section.courseKey);
    if (course?.department) { const key = `${section.blockId}|${course.department}`; perBlockDept.set(key, (perBlockDept.get(key) || 0) + 1); }
    if (course?.room) { const key = `${section.blockId}|${course.room}`; perBlockRoom.set(key, (perBlockRoom.get(key) || 0) + 1); }
    if (!sizesByCourse.has(section.courseKey)) sizesByCourse.set(section.courseKey, []);
    sizesByCourse.get(section.courseKey).push(size);
  }
  for (const [blockId, total] of blockTotals) {
    const block = blockById.get(blockId);
    if (block && block.maxSections && total > block.maxSections) issues.push({ type: "block-over", severity: "error", blockId, message: `${block.letter}블록 분반 ${total}개 > 최대 ${block.maxSections}개` });
  }
  model.blocks.forEach((block, b) => {
    const dept = model.supply.dept[b];
    if (dept) for (const [name, limit] of dept) { const used = perBlockDept.get(`${block.id}|${name}`) || 0; if (used > limit) issues.push({ type: "teacher-count", severity: "error", blockId: block.id, department: name, message: `${block.letter}블록 ${name} 분반 ${used}개 > 그 시간 가능한 교사 ${limit}명` }); }
    const rooms = model.supply.rooms[b];
    if (rooms) for (const [name, limit] of rooms) { const used = perBlockRoom.get(`${block.id}|${name}`) || 0; if (used > limit) issues.push({ type: "room-count", severity: "error", blockId: block.id, message: `${block.letter}블록 ${name} 분반 ${used}개 > 특별실 ${limit}개` }); }
  });
  for (const [key, sizes] of sizesByCourse) {
    if (sizes.length < 2) continue;
    const diff = Math.max(...sizes) - Math.min(...sizes);
    if (diff > spreadWarn) issues.push({ type: "spread", severity: "warn", courseKey: key, message: `${model.courseByKey.get(key)?.name || key}: 분반 인원 차이 ${diff}명(${Math.min(...sizes)}~${Math.max(...sizes)})` });
  }
  // 교사(이 그룹 안): 불가 시간·같은 블록 두 분반
  if (result.teacherOf && model.teachers.length) {
    const seen = new Map();
    for (const section of result.sections || []) {
      const teacherId = result.teacherOf[section.id];
      if (!teacherId) continue;
      const teacher = model.teachers.find((item) => item.id === teacherId);
      const block = model.blocks.find((item) => item.id === section.blockId);
      const hit = teacher && block ? teacher.unavailable.find((item) => block.times.includes(item.slot)) : null;
      if (hit) issues.push({ type: "teacher-unavailable", severity: "error", sectionId: section.id, message: `${teacher.name} 선생님 불가 시간(${hit.slot}${hit.reason ? `, ${hit.reason}` : ""})에 ${section.courseName} 배정` });
      const key = `${teacherId}|${section.blockId}`;
      if (seen.has(key)) issues.push({ type: "teacher-double", severity: "error", sectionId: section.id, message: `${teacher?.name || teacherId} 선생님이 ${section.blockLetter}블록에 두 분반` });
      seen.set(key, section.id);
    }
  }
  return issues;
}

// 여러 그룹 결과의 교사 겹침(학년 간). groups: [{ input, result }]
function classSectionsValidateAcross(groups, teachersRaw) {
  const issues = [];
  // 같은 현 학년·학기 그룹끼리 블록 시간이 겹치면(같은 학생이 두 그룹 과목을 다 들음) 오류.
  for (let i = 0; i < groups.length; i += 1) for (let j = i + 1; j < groups.length; j += 1) {
    const a = groups[i];
    const b = groups[j];
    if (String(a.input.grade ?? "") !== String(b.input.grade ?? "") || String(a.input.semester ?? "") !== String(b.input.semester ?? "")) continue;
    for (const x of a.result.blocks || []) for (const y of b.result.blocks || []) {
      const shared = (x.times || []).filter((slot) => (y.times || []).includes(slot));
      if (shared.length) issues.push({ type: "cohort-clash", severity: "error", groupId: a.input.groupId, groups: [a.input.groupId, b.input.groupId],
        message: `${a.input.label || a.input.groupId} ${x.letter}블록과 ${b.input.label || b.input.groupId} ${y.letter}블록이 같은 시간(${shared.map((slot) => slot.replace(":", "")).join(", ")})입니다 — 같은 학생이 두 과목을 동시에 들어야 합니다.` });
    }
  }
  const busy = new Map();
  const names = new Map((teachersRaw || []).map((teacher) => [classSectionsText(teacher.id ?? teacher.name), classSectionsText(teacher.name ?? teacher.id)]));
  for (const { input, result } of groups) {
    const blocks = new Map((result.blocks || []).map((block) => [block.id, block]));
    for (const section of result.sections || []) {
      const teacherId = result.teacherOf?.[section.id];
      if (!teacherId) continue;
      const times = blocks.get(section.blockId)?.times || [];
      for (const slot of times) {
        const key = `${teacherId}|${slot}`;
        const other = busy.get(key);
        if (other && other.group !== (input.groupId || "")) {
          issues.push({ type: "teacher-cross", severity: "error", teacherId, slot, groups: [other.group, input.groupId || ""],
            message: `${names.get(teacherId) || teacherId} 선생님: ${slot.replace(":", "요일 ")}교시에 ${other.label}와 ${input.label || input.groupId} ${section.courseName}가 겹칩니다.` });
        } else if (!other) busy.set(key, { group: input.groupId || "", label: `${input.label || input.groupId} ${section.courseName}` });
      }
    }
  }
  return issues;
}

// ---- 지표·설명·제안 ----
function classSectionsMetrics(model, result, previous) {
  const sizes = new Map();
  const homeroomCount = new Map();
  const sectionById = new Map(result.sections.map((section) => [section.id, section]));
  for (const student of model.students) {
    for (const id of result.assign[student.key] || []) {
      const section = sectionById.get(id);
      if (!section) continue;
      sizes.set(id, (sizes.get(id) || 0) + 1);
      const key = `${section.courseKey}|${student.homeroom}`;
      if (!homeroomCount.has(key)) homeroomCount.set(key, new Map());
      const map = homeroomCount.get(key);
      map.set(id, (map.get(id) || 0) + 1);
    }
  }
  let maxSpread = 0;
  let spreadSum = 0;
  let spreadCourses = 0;
  const byCourse = new Map();
  for (const section of result.sections) {
    if (!byCourse.has(section.courseKey)) byCourse.set(section.courseKey, []);
    byCourse.get(section.courseKey).push(sizes.get(section.id) || 0);
  }
  for (const list of byCourse.values()) {
    if (list.length < 2) continue;
    const diff = Math.max(...list) - Math.min(...list);
    maxSpread = Math.max(maxSpread, diff);
    spreadSum += diff;
    spreadCourses += 1;
  }
  let together = 0;
  let total = 0;
  for (const [key, map] of homeroomCount) {
    const course = model.courseByKey.get(key.split("|")[0]);
    if (!course || course.sections < 2) continue;
    let max = 0;
    let sum = 0;
    for (const value of map.values()) { sum += value; if (value > max) max = value; }
    together += max;
    total += sum;
  }
  // 앞 편성 결과가 없으면 비교할 것이 없으므로 null('–'로 표시).
  let moved = previous?.assign ? 0 : null;
  if (previous?.assign) {
    for (const student of model.students) {
      const before = new Set(previous.assign[student.key] || []);
      if (!before.size) continue;
      for (const id of result.assign[student.key] || []) if (!before.has(id)) moved += 1;
    }
  }
  const unassignedStudents = new Set(result.unassigned.map((item) => item.studentKey)).size;
  return { unassigned: result.unassigned.length, unassignedStudents, maxSpread, avgSpread: spreadCourses ? Math.round(spreadSum / spreadCourses * 10) / 10 : 0,
    sameHomeroomRatio: total ? Math.round(together / total * 1000) / 1000 : 1, moved,
    blockSections: result.blocks.map((block) => block.sectionIds.length) };
}

function classSectionsExplain(model, result, place) {
  const causes = [];
  const B = model.blocks.length;
  for (const course of model.courses) {
    const capacity = model.sections.filter((section) => section.course === course.index).reduce((sum, section) => sum + section.capacity, 0);
    if (course.demand > capacity) causes.push({ type: "course-capacity", courseKey: course.key,
      message: `${course.name}: 신청 ${course.demand}명 > 분반 ${course.sections}개 × 정원 합 ${capacity}명. 분반을 늘리거나 정원을 올려야 합니다.` });
  }
  const totalSections = model.sections.length;
  const maxTotal = model.blocks.reduce((sum, block) => sum + block.maxSections, 0);
  if (totalSections > maxTotal) causes.push({ type: "block-limit", message: `분반 ${totalSections}개 > 블록 ${B}개 × 블록당 최대 분반 합 ${maxTotal}개` });
  const closed = model.unassignedInput.filter((item) => item.reason === "closed");
  if (closed.length) causes.push({ type: "closed", message: `분반이 0개(폐강)인 과목 신청 ${closed.length}건` });
  const unitMissed = model.unassignedInput.filter((item) => item.reason === "class-unit-other-room");
  if (unitMissed.length) causes.push({ type: "class-unit-other-room", message: `학급 단위 과목(${[...new Set(unitMissed.map((item) => item.courseKey))].join(", ")})을 고른 학생 ${new Set(unitMissed.map((item) => item.studentKey)).size}명이 '이동' 반이라 그 과목을 들을 수 없습니다 — 반 배정을 바꾸거나 다른 과목으로 재신청하세요.` });
  const tooMany = model.unassignedInput.filter((item) => item.reason === "too-many");
  if (tooMany.length) causes.push({ type: "too-many", message: `블록 수(${B})보다 많은 과목을 고른 학생 ${new Set(tooMany.map((item) => item.studentKey)).size}명` });
  const noBlock = result.unassigned.filter((item) => item.reason === "no-block");
  if (noBlock.length) {
    const combos = new Map();
    for (const item of noBlock) {
      const student = model.students.find((value) => value.key === item.studentKey);
      if (!student) continue;
      const blocked = [];
      for (let i = 0; i < student.courses.length; i += 1) for (let j = i + 1; j < student.courses.length; j += 1) {
        const a = model.sections.filter((section) => section.course === student.courses[i]).map((section) => place.blockOf[section.index]);
        const b = model.sections.filter((section) => section.course === student.courses[j]).map((section) => place.blockOf[section.index]);
        if (new Set([...a, ...b]).size < 2) blocked.push(`${model.courses[student.courses[i]].name}·${model.courses[student.courses[j]].name}`);
      }
      const key = blocked[0] || student.courses.map((c) => model.courses[c].name).join("·");
      combos.set(key, (combos.get(key) || 0) + 1);
    }
    for (const [key, count] of combos) causes.push({ type: "no-block", message: `${key}: 같은 블록에만 열려 함께 들을 수 없는 학생 ${count}명` });
  }
  const capacityShort = result.unassigned.filter((item) => item.reason === "capacity");
  if (capacityShort.length && !causes.some((item) => item.type === "course-capacity")) {
    const byCell = new Map();
    for (const item of capacityShort) byCell.set(item.courseKey, (byCell.get(item.courseKey) || 0) + 1);
    for (const [key, count] of byCell) causes.push({ type: "cell-capacity", courseKey: key, message: `${model.courseByKey.get(key)?.name || key}: 들을 수 있는 블록의 분반 정원이 모자라 ${count}명 미배정` });
  }
  return causes;
}

// 받침에 따라 조사 고르기: classSectionsJosa('정보', '을/를') → '정보를'. 한글이 아니면 '을(를)'.
function classSectionsJosa(word, pair) {
  const [withFinal, withoutFinal] = pair.split("/");
  const text = classSectionsText(word);
  const last = text.charCodeAt(text.length - 1);
  if (!(last >= 0xac00 && last <= 0xd7a3)) return `${text}${withFinal}(${withoutFinal})`;
  return `${text}${(last - 0xac00) % 28 ? withFinal : withoutFinal}`;
}

// 학급 단위로 바꿨을 때를 실제로 풀어 본다: 반 배분(남는 반은 이동) → 학생 이동 과목 → 풀기. 반 정보가 없으면 null.
function classSectionsClassUnitTrial(input, unitKeys) {
  const students = input.students || [];
  const rooms = [...new Set(students.map((student) => classSectionsKeyPart(classSectionsHomeroomOf(student))).filter(Boolean))];
  const count = Math.max(Number(input.homeroomCount) || 0, rooms.length);
  if (!count) return null;
  const ids = new Set(rooms);
  for (let i = 1; ids.size < count; i += 1) ids.add(String(i));
  const homerooms = [...ids].sort((a, b) => (Number(a) - Number(b)) || a.localeCompare(b)).map((id) => ({ id }));
  const keys = new Set(unitKeys);
  const courses = (input.courses || []).map((raw) => ({ ...raw, key: classSectionsText(raw.key ?? raw.name) }));
  const unitCourses = courses.filter((course) => keys.has(course.key)).map((course) => ({ key: course.key, sections: course.sections ?? course.classCount }));
  // 내년 반을 모르면(배정표 없음·새로 편성) 학생의 반은 지금 반이라 반별 희망을 쓸 수 없다: 화면과 같이 반을 차례로 나누고,
  // 희망과 다른 학생·재신청 학생은 학교 전체 희망 비율로 어림한다(없는 반을 '이동'으로 공짜로 잡지 않음).
  const roomsKnown = input.classUnitRoomsKnown !== false;
  const split = classSectionsClassUnitSplit({ allowMove: true, homerooms, courses: unitCourses, students: roomsKnown ? students : [] });
  const choose = Number(input.choose) || (Array.isArray(input.blocks) ? input.blocks.length : Number(input.blocks)) || 1;
  const allUnit = Object.values(split.assign).length && Object.values(split.assign).every(Boolean);
  const blockCount = Array.isArray(input.blocks) ? input.blocks.length : Number(input.blocks) || choose;
  const blocks = allUnit ? Math.max(1, blockCount - 1) : blockCount;
  const unitRooms = Object.values(split.assign).filter(Boolean).length;
  const trialCourses = courses.map((course) => (keys.has(course.key) ? { ...course, mode: "class" } : course));
  const trialBlocks = Array.isArray(input.blocks) ? input.blocks.slice(0, blocks) : blocks;
  if (!roomsKnown) {
    const result = classSectionsSolve({ ...input, courses: trialCourses, blocks: trialBlocks, suggest: false });
    const total = students.length;
    // 학생이 어느 반에 갈지 모르므로 반마다 같은 확률(1/count)로 본다: 고른 학급 단위 과목 c의 반(q_c개)에 가면 희망대로,
    // 다른 과목 반이나 이동 반이면 희망과 다름(이동 반이면 재신청). 학급 단위 과목을 안 고른 학생은 학급 단위 반에 가면 희망과 다름.
    let retakeSum = 0;
    let mismatchSum = 0;
    for (const student of students) {
      const wished = classSectionsStudentCourseList(student).filter((value) => keys.has(value));
      if (!wished.length) { mismatchSum += unitRooms / count; continue; }
      const best = Math.max(...wished.map((value) => Number(split.quotas?.[value]) || 0));
      mismatchSum += 1 - best / count;
      retakeSum += (count - unitRooms) / count;
    }
    const retake = Math.round(retakeSum);
    const mismatched = Math.round(mismatchSum);
    return { result, mismatched, total, rooms: { unit: unitRooms, move: count - unitRooms }, split, estimated: true, retakeEstimate: retake };
  }
  const moved = classSectionsClassUnitStudents({ students, choose, unitKeys: [...keys], byClass: split.assign });
  const result = classSectionsSolve({ ...input, courses: trialCourses, students: moved.students, blocks: trialBlocks, classUnit: { choose, unitOf: moved.unitOf }, suggest: false });
  return { result, mismatched: moved.mismatched, total: moved.total, rooms: { unit: unitRooms, move: count - unitRooms }, split };
}

// 학급 단위 과목이 하나이고 '이동' 반 학생 중 그 과목을 고른 학생이 있으면(재신청 필요): 이동 반도 모두 학급 단위로 하면 어떻게 되는지 풀어 본다.
// 재신청은 없어지지만 이동 반에서 그 과목을 고르지 않은 학생은 희망과 다르게 된다(그 수를 함께 알림).
function classSectionsClassUnitRoomsSuggestion(result, input, deadline) {
  const missed = (result.unassigned || []).filter((item) => item.reason === "class-unit-other-room");
  if (!missed.length || !input?.classUnit?.unitOf || (deadline && classSectionsNow() > deadline)) return [];
  const unitCourses = (input.courses || []).filter((course) => course.mode === "class");
  if (unitCourses.length !== 1) return [];
  const course = unitCourses[0];
  const key = classSectionsText(course.key ?? course.name);
  const unitOf = input.classUnit.unitOf;
  const rooms = new Set();
  const moveRooms = new Set();
  let newlyMismatched = 0;
  // 학급 단위로 바꾸기 전 희망으로 되돌린 학생(학급 단위 반 학생은 그 과목을 이미 듣는 것으로 둠).
  const students = (input.students || []).map((raw) => {
    const studentKey = classSectionsText(raw.key);
    const room = classSectionsKeyPart(classSectionsHomeroomOf(raw));
    if (room) rooms.add(room);
    const { classUnitMissed, ...rest } = raw;
    const wishes = classSectionsStudentCourseList(raw);
    if (unitOf[studentKey]) return { ...rest, courses: [...wishes, unitOf[studentKey]] };
    if (room) moveRooms.add(room);
    const missing = (classUnitMissed || []).map(classSectionsText);
    if (!missing.length) newlyMismatched += 1;
    return { ...rest, courses: [...wishes, ...missing] };
  });
  const count = Math.max(Number(input.homeroomCount) || 0, rooms.size);
  if (!moveRooms.size || !count) return [];
  const name = classSectionsText(course.name ?? key);
  const retake = new Set(missed.map((item) => item.studentKey)).size;
  const raw = { ...input, classUnitRoomsKnown: true, classUnit: undefined, students };
  const solid = (trial) => trial && !trial.result.unassigned.some((item) => item.reason !== "class-unit-other-room")
    && !trial.result.issues.some((issue) => issue.severity === "error" && issue.type !== "unassigned");
  const retakeOf = (trial) => new Set(trial.result.unassigned.filter((item) => item.reason === "class-unit-other-room").map((item) => item.studentKey)).size;
  const out = [];
  // 1) 이동 반도 그 과목 학급 단위로(학급 수 = 내년 학급 수)
  const from = Number(course.sections ?? course.classCount) || 0;
  const all = classSectionsClassUnitTrial({ ...raw, courses: (input.courses || []).map((item) => (item === course ? { ...item, sections: count } : item)) }, [key]);
  if (all && !all.rooms.move && solid(all)) {
    out.push({ type: "class-unit-rooms", verified: true, courseKey: key, courseName: name, sections: count, fromSections: from, mismatched: newlyMismatched, retake,
      message: `'이동' 반 ${moveRooms.size}개도 ${classSectionsJosa(name, "을/를")} 학급 단위로 하면(${name} 학급 ${from}→${count}개, 모든 반 전원) 재신청이 필요한 학생 ${retake}명이 없어집니다 · 대신 그 반에서 ${classSectionsJosa(name, "을/를")} 고르지 않은 학생 ${newlyMismatched}명이 희망과 다르게 됩니다.` });
  }
  // 2) 같은 교과의 다른 과목도 함께 학급 단위로(이동 반이 그 교과 다른 과목 반이 됨)
  const sameDept = course.department ? (input.courses || []).filter((item) => item !== course && item.mode !== "class" && item.department === course.department) : [];
  if (sameDept.length && !(deadline && classSectionsNow() > deadline)) {
    const keys = [key, ...sameDept.map((item) => classSectionsText(item.key ?? item.name))];
    const trial = classSectionsClassUnitTrial(raw, keys);
    if (solid(trial) && retakeOf(trial) < retake) {
      const names = [name, ...sameDept.map((item) => classSectionsText(item.name ?? item.key))].join("·");
      const after = retakeOf(trial);
      out.push({ type: "class-unit", verified: true, courseKey: keys[0], courseKeys: keys, courseName: names, mismatched: trial.mismatched, total: trial.total, rooms: trial.rooms, retake: after,
        message: `${classSectionsJosa(names, "을/를")} 모두 학급 단위로 운영하면(${trial.rooms.unit}개 반 전원이 그 과목${trial.rooms.move ? `, 나머지 ${trial.rooms.move}개 반은 이동` : ""}) 재신청이 필요한 학생이 ${retake}명 → ${after}명 · 희망과 다른 학생 ${trial.mismatched}명(${trial.total ? Math.round(trial.mismatched / trial.total * 100) : 0}%).` });
    }
  }
  return out;
}

function classSectionsTeacherSuggestions(model, result, input, deadline) {
  const short = (result.issues || []).filter((issue) => ["teacher-count", "teacher-shortage", "placement-forced"].includes(issue.type) && issue.severity === "error");
  if (!short.length || !input) return [];
  const departments = [...new Set(short.map((issue) => issue.department).filter(Boolean))];
  const out = [];
  const late = () => deadline && classSectionsNow() > deadline;
  const ok = (trial) => trial.explain.feasible;
  const blockCount = model.blocks.length;
  if (blockCount < CLASS_SECTIONS_BLOCK_LETTERS.length && !late()) {
    const letter = CLASS_SECTIONS_BLOCK_LETTERS[blockCount];
    const blocks = Array.isArray(input.blocks) ? [...input.blocks, { id: letter }] : blockCount + 1;
    const trial = classSectionsSolve({ ...input, blocks, suggest: false });
    if (ok(trial)) out.push({ type: "more-blocks", verified: true, blocks: blockCount + 1,
      message: `블록을 ${blockCount + 1}개로 늘리면(새 블록 시간은 따로 정함) 교사 수 안에서 모두 배정됩니다.` });
  }
  // 학급 단위로: 과목 하나씩 → 안 되면 모자라는 교과의 과목 전부(예: 제2외국어 일본어·중국어 11분반 > 교사 2명).
  // 확인 = 그 과목을 듣는 반(그 반 전원)과 나머지 반(이동)이 함께 성립: 반 배분 → 학생 이동 과목 다시 만들기 → 다시 풀기.
  const shortCourses = model.courses.filter((item) => departments.includes(item.department)).sort((a, b) => a.demand - b.demand);
  const trySet = (list) => {
    const trial = classSectionsClassUnitTrial(input, list.map((course) => course.key));
    if (!trial) return null;
    // 성립 = 이동 반 학생의 이동 과목이 모두 배정되고 오류가 없음. 학급 단위 과목을 골랐는데 이동 반인 학생은 '재신청 필요'로 따로 알린다.
    const others = trial.result.unassigned.filter((item) => item.reason !== "class-unit-other-room");
    const hard = trial.result.issues.filter((issue) => issue.severity === "error" && issue.type !== "unassigned");
    trial.retake = trial.estimated ? trial.retakeEstimate : new Set(trial.result.unassigned.filter((item) => item.reason === "class-unit-other-room").map((item) => item.studentKey)).size;
    return !others.length && !hard.length ? trial : null;
  };
  const pct = (n, total) => (total ? Math.round(n / total * 100) : 0);
  // 후보: 과목 하나씩 + 모자라는 교과 과목 전부. 확인된 것 중 재신청이 필요한 학생(이동 반이라 그 과목을 못 듣는 학생) → 희망과 다른 학생이 적은 것.
  const candidates = [...shortCourses.map((course) => [course]), ...(shortCourses.length > 1 ? [shortCourses] : [])];
  let best = null;
  for (const list of candidates) {
    if (late()) break;
    const trial = trySet(list);
    if (!trial) continue;
    const score = [trial.retake, trial.mismatched, list.length];
    if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && (score[1] < best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2])))) best = { list, trial, score };
  }
  if (best) {
    const { list, trial } = best;
    const names = list.map((course) => course.name).join("·");
    const rooms = `${trial.rooms.unit}개 반 전원이 그 과목${trial.rooms.move ? `, 나머지 ${trial.rooms.move}개 반은 이동` : ""}`;
    const about = trial.estimated ? "약 " : "";
    out.push({ type: "class-unit", verified: true, courseKey: list[0].key, courseKeys: list.map((course) => course.key), courseName: names,
      mismatched: trial.mismatched, total: trial.total, rooms: trial.rooms, retake: trial.retake, estimated: Boolean(trial.estimated),
      message: `${classSectionsJosa(names, "을/를")} ${list.length > 1 ? "모두 " : ""}학급 단위로 운영하면(${rooms}) 교사 수 안에서 배정됩니다 · 희망과 다른 학생 ${about}${trial.mismatched}명(${pct(trial.mismatched, trial.total)}%)${trial.retake ? ` · 그중 이동 반이라 그 과목을 못 들어 재신청이 필요한 학생 ${about}${trial.retake}명` : ""}${trial.estimated ? " — 내년 반 배정표가 없어 학교 전체 희망 비율로 어림했습니다(배정표를 올리면 반별 희망으로 정해짐)" : ""}.` });
  }
  // 블록 시간을 바꿔서 풀리는 경우만(한 블록의 그 교과 분반이 그 교과 교사 전체보다 많으면 어느 시간이든 모자람).
  const totalTeachers = (dept) => {
    if ((input.teachers || []).length) return input.teachers.filter((teacher) => (teacher.departments || []).includes(dept)).length || Infinity;
    return Number(input.departmentTeachers?.[dept] ?? Infinity);
  };
  const perBlock = new Map();
  for (const issue of short) if (issue.department && issue.blockId) perBlock.set(`${issue.blockId}|${issue.department}`, issue);
  const hopeless = short.some((issue) => {
    if (!issue.department) return false;
    const count = (result.sections || []).filter((section) => section.blockId === issue.blockId && model.courseByKey.get(section.courseKey)?.department === issue.department).length;
    return count > totalTeachers(issue.department);
  });
  if (!hopeless && (model.blocks.some((block) => block.times.length) || (input.occupied || []).length)) {
    out.push({ type: "recommend-times", verified: false,
      message: "블록 시간 추천을 실행해 다른 학년 블록과 같은 교과 교사가 겹치지 않는 시간으로 바꿔 보세요." });
  }
  out.push({ type: "check-teachers", verified: false,
    message: `교사 명단·5단계 교사 수를 확인하세요${departments.length ? `: ${departments.join(", ")} 교사가 그 시간에 모자랍니다` : ""}.` });
  return out;
}

// 미배정이 있을 때: 어느 분반을 몇 명으로 올리면 모두 배정되는지(같은 배치에서 확인한 값).
function classSectionsCapacitySuggestion(model, place, rng, deadline, maxRaise) {
  const limit = maxRaise || 2;
  const working = classSectionsPlacementNew(model);
  model.sections.forEach((section) => classSectionsPut(model, working, section.index, place.blockOf[section.index]));
  const raised = new Map();
  const units = classSectionsUnits(model, false);
  const r = classSectionsRouterNew(model, units, { bal: 0.2, home: 0, keep: 0 });
  const iterations = model.options.evalIterations || Math.min(6000, 600 + model.students.length * 4);
  classSectionsRouterRebuild(r, working, rng, false);
  classSectionsRouterSearch(r, rng, iterations * 3, true, deadline);
  const B = model.blocks.length;
  for (let round = 0; round < 80 && (r.overflow > 0 || r.impossible > 0); round += 1) {
    if (r.impossible > 0) return null;
    if (deadline && classSectionsNow() > deadline) return null;
    let worst = -1;
    let worstOver = 0;
    for (let cell = 0; cell < r.load.length; cell += 1) {
      const over = r.load[cell] - r.cap[cell];
      if (over > worstOver) { worstOver = over; worst = cell; }
    }
    if (worst < 0) break;
    const c = Math.floor(worst / B);
    const b = worst % B;
    const candidates = model.sections.filter((section) => section.course === c && working.blockOf[section.index] === b)
      .filter((section) => (raised.get(section.index) || 0) < limit)
      .sort((x, y) => (raised.get(x.index) || 0) - (raised.get(y.index) || 0) || x.index - y.index);
    if (!candidates.length) return null;
    const section = candidates[0];
    raised.set(section.index, (raised.get(section.index) || 0) + 1);
    working.cellCap[c * B + b] += 1;
    r.cap[c * B + b] += 1;
    classSectionsRouterRecount(r);
    classSectionsRouterSearch(r, rng, iterations, true, deadline);
  }
  if (r.overflow > 0) return null;
  return [...raised.entries()].map(([index, add]) => {
    const section = model.sections[index];
    const block = model.blocks[place.blockOf[index]];
    return { sectionId: section.id, courseKey: model.courses[section.course].key, courseName: model.courses[section.course].name,
      blockId: block.id, blockLetter: block.letter, from: section.capacity, to: section.capacity + add };
  }).sort((a, b) => (a.blockLetter < b.blockLetter ? -1 : a.blockLetter > b.blockLetter ? 1 : 0) || (a.courseName < b.courseName ? -1 : 1));
}

function classSectionsSuggest(model, place, result, rng, deadline, input) {
  const suggestions = [];
  const maxTotal = model.blocks.reduce((sum, block) => sum + block.maxSections, 0);
  if (model.sections.length > maxTotal) {
    // 분반이 블록에 다 들어가지 않으면 정원 올리기(같은 분반 수)로는 풀리지 않는다 → 분반 수 줄이기·블록 한도 늘리기.
    const fewer = classSectionsSectionsSuggestion(model, input, deadline);
    if (fewer) suggestions.push(fewer);
    const need = Math.ceil(model.sections.length / model.blocks.length);
    if (input && !(deadline && classSectionsNow() > deadline)) {
      const trial = classSectionsSolve({ ...input, maxSectionsPerBlock: need,
        blocks: Array.isArray(input.blocks) ? input.blocks.map((block) => ({ ...block, maxSections: Math.max(need, Number(block.maxSections) || 0) })) : input.blocks, suggest: false });
      if (trial.explain.feasible) suggestions.push({ type: "block-limit", verified: true, maxSectionsPerBlock: need,
        message: `블록당 최대 분반을 ${need}개로 늘리면 지금 분반 수·정원으로 모두 배정됩니다.` });
    }
    // 블록 한도와 함께 교사 수도 모자라면(예: 택1 한 블록) 블록 늘리기·학급 단위 제안도 함께.
    suggestions.push(...classSectionsTeacherSuggestions(model, result, input, deadline).filter((item) => !suggestions.some((other) => other.type === item.type)));
    return suggestions;
  }
  // 교사 수 부족(그 시간 가능한 교사 < 블록의 교과 분반): 블록 늘리기·학급 단위로 운영을 다시 풀어 확인, 시간 추천·교사 수 확인은 안내.
  suggestions.push(...classSectionsTeacherSuggestions(model, result, input, deadline));
  if (!result.unassigned.length) return suggestions;
  suggestions.push(...classSectionsClassUnitRoomsSuggestion(result, input, deadline).filter((item) => !suggestions.some((other) => other.message === item.message)));
  const structuralReasons = ["closed", "too-many", "class-unit-other-room"];
  const structural = result.unassigned.some((item) => structuralReasons.includes(item.reason));
  const onlyStructural = result.unassigned.every((item) => structuralReasons.includes(item.reason));
  if (onlyStructural) return suggestions;
  // 1) 같은 배치에서 정원만 올리기
  let raise = classSectionsCapacitySuggestion(model, place, rng, deadline, 2);
  let source = "same-placement";
  // 2) 모든 분반 +1로 배치를 다시 찾은 뒤, 그 배치에서 최소한만 올리기
  if (!raise && input) {
    const plusOne = { ...input, defaultCapacity: model.defaultCapacity + 1, capacities: Object.fromEntries(model.sections.map((section) => [section.id, section.capacity + 1])), suggest: false };
    const bumped = classSectionsNormalize(plusOne);
    const found = classSectionsPlace(bumped, classSectionsRng(model.seed + 7), deadline, null);
    if (found.router.overflow === 0 && found.router.impossible === 0) {
      const again = classSectionsPlacementNew(model);
      model.sections.forEach((section) => classSectionsPut(model, again, section.index, found.place.blockOf[section.index]));
      raise = classSectionsCapacitySuggestion(model, again, rng, deadline, 2);
      if (raise) source = "new-placement";
    }
  }
  if (raise && raise.length) {
    const groups = new Map();
    for (const item of raise) {
      const key = `${item.blockLetter}블록 ${item.courseName}`;
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    const parts = [...groups.entries()].map(([key, count]) => `${key}${count > 1 ? ` ${count}개` : ""}`);
    const top = parts.slice(0, 4).join(", ");
    const maxTo = Math.max(...raise.map((item) => item.to));
    suggestions.push({ type: "capacity", source, sections: raise, verified: true,
      message: `${top}${parts.length > 4 ? ` 등 모두 ${raise.length}개` : ""} 분반을 ${maxTo}명${raise.some((item) => item.to !== maxTo) ? "까지" : ""}으로 올리면 모두 배정됩니다${source === "new-placement" ? "(블록 배치도 바뀜)" : ""}.` });
  }
  // 3) 블록당 최대 분반 +1
  const limited = model.blocks.every((block) => Number.isFinite(block.maxSections));
  if (limited && input && !(deadline && classSectionsNow() > deadline)) {
    const more = classSectionsNormalize({ ...input, maxSectionsPerBlock: Math.max(...model.blocks.map((block) => block.maxSections)) + 1,
      blocks: Array.isArray(input.blocks) ? input.blocks.map((block) => ({ ...block, maxSections: block.maxSections ? block.maxSections + 1 : block.maxSections })) : input.blocks, suggest: false });
    const found = classSectionsPlace(more, classSectionsRng(model.seed + 11), deadline, null);
    if (found.router.overflow === 0 && found.router.impossible === 0 && !found.issues.length) {
      suggestions.push({ type: "block-limit", verified: true, maxSectionsPerBlock: more.blocks[0].maxSections,
        message: `블록당 최대 분반을 ${more.blocks[0].maxSections}개로 늘리면 지금 정원으로 모두 배정됩니다.` });
    }
  }
  if (structural) suggestions.push({ type: "structural", message: "폐강 과목 신청·블록 수보다 많은 신청은 정원으로 풀리지 않습니다(재신청 또는 블록 수 조정)." });
  return suggestions;
}

// ---- 한 그룹 풀기 ----
function classSectionsSolve(input, presetPlacement) {
  const start = classSectionsNow();
  const model = classSectionsNormalize(input);
  const deadline = start + model.options.timeLimitMs;
  const rng = classSectionsRng(model.seed);
  // keepWeight: 직접 고치기 뒤 다시 풀 때 앞 배정(previous)에서 바뀌는 학생에게 큰 비용(기본 4).
  const keepWeight = Number(input?.keepWeight);
  const weights = keepWeight > 0 ? { ...CLASS_SECTIONS_MODE_WEIGHTS[model.mode], keep: keepWeight } : CLASS_SECTIONS_MODE_WEIGHTS[model.mode];
  let placed;
  if (presetPlacement) {
    const place = classSectionsPlacementNew(model);
    model.sections.forEach((section) => classSectionsPut(model, place, section.index, presetPlacement[section.id] ?? 0));
    const units = classSectionsUnits(model, false);
    const r = classSectionsRouterNew(model, units, { bal: 0.2, home: 0, keep: 0 });
    classSectionsRouterRebuild(r, place, rng, false);
    classSectionsRouterSearch(r, rng, (model.options.evalIterations || 3000) * 3, true, deadline);
    placed = { place, router: r, steps: 0, issues: [], timedOut: false };
  } else placed = classSectionsPlace(model, rng, deadline, null);
  const routed = classSectionsRoute(model, placed.place, placed.router, weights, rng, deadline);
  const filled = classSectionsFillCells(model, placed.place, routed.router);
  const result = classSectionsBuildResult(model, placed.place, filled.sectionOf, filled.unassigned);
  // 교사 배정(이 그룹 안). 여러 그룹을 함께 맞추려면 classSectionsSolveAll.
  result.teacherOf = {};
  const teacherIssues = [];
  if (model.teachers.length) {
    const assigned = classSectionsAssignTeachers({ teachers: input.teachers, fixedSlots: [...(input.occupied || []), ...(input.fixedSlots || [])],
      sections: classSectionsTeacherSections(model, result), pins: model.teacherPins, previous: model.previous?.teacherOf || {} });
    result.teacherOf = assigned.teacherOf;
    result.teacherLoad = assigned.load;
    teacherIssues.push(...assigned.issues);
  }
  result.teacherOf && result.sections.forEach((section) => { section.teacherId = result.teacherOf[section.id] || ""; });
  result.version = CLASS_SECTIONS_VERSION;
  result.groupId = model.groupId;
  result.mode = model.mode;
  result.seed = model.seed;
  result.signature = classSectionsSignature(input);
  result.metrics = classSectionsMetrics(model, result, model.baseline);
  classSectionsAssignRoomNames(result, model.blocks.map((block) => block.id), model.keepRoomNames);

  result.issues = [...model.issues, ...placed.issues, ...teacherIssues, ...classSectionsValidate(model, result)];
  if (result.roomRenames?.length) result.issues.push({ type: "room-renamed", severity: "warn",
    message: `강의실 이름이 바뀐 분반 ${result.roomRenames.length}개: ${result.roomRenames.slice(0, 6).map((item) => `${item.from} → ${item.to}`).join(", ")}${result.roomRenames.length > 6 ? " …" : ""}` });
  result.explain = classSectionsExplainResult(model, placed.place, result, deadline, input);
  result.placement = Object.fromEntries(model.sections.map((section) => [section.id, placed.place.blockOf[section.index]]));
  result.elapsedMs = Math.round(classSectionsNow() - start);
  result.stats = { placementSteps: placed.steps, routeIterations: routed.iterations, timedOut: Boolean(placed.timedOut || classSectionsNow() > deadline) };
  return result;
}

// 결과 판정: 미배정이 없어도 오류(블록 한도 초과·교사 불가 시간 등)가 있으면 '가능'이 아니다.
function classSectionsHardErrors(issues) {
  return (issues || []).filter((issue) => issue.severity === "error" && issue.type !== "unassigned");
}

function classSectionsExplainResult(model, place, result, deadline, input) {
  const hard = classSectionsHardErrors(result.issues);
  const feasible = result.unassigned.length === 0 && hard.length === 0;
  const causes = feasible ? [] : classSectionsExplain(model, result, place);
  const suggestions = !feasible && model.options.suggest ? classSectionsSuggest(model, place, result, classSectionsRng(model.seed + 3), deadline, input) : [];
  const maxText = Number.isFinite(model.blocks[0]?.maxSections) ? `${model.blocks[0].maxSections}개` : "제한 없음";
  const parts = [];
  if (result.unassigned.length) {
    // 이동 반인데 학급 단위 과목을 고른 학생은 정원 문제가 아니라 재신청 대상: 따로 말한다.
    const unitMissed = result.unassigned.filter((item) => item.reason === "class-unit-other-room");
    const rest = result.unassigned.filter((item) => item.reason !== "class-unit-other-room");
    if (rest.length) parts.push(`미배정 ${new Set(rest.map((item) => item.studentKey)).size}명(${rest.length}과목). 정원 ${model.defaultCapacity}명·블록당 최대 ${maxText}로는 모두 배정하는 편성을 찾지 못했습니다.`);
    if (unitMissed.length) parts.push(`학급 단위로 바꾼 과목(${[...new Set(unitMissed.map((item) => item.courseKey))].join(", ")})을 고른 '이동' 반 학생 ${new Set(unitMissed.map((item) => item.studentKey)).size}명은 재신청이 필요합니다.`);
  }
  const blockLimit = causes.find((cause) => cause.type === "block-limit");
  if (blockLimit) parts.push(`블록 한도 초과: ${blockLimit.message.replace(/^분반 /, "분반 ")}(블록별 ${result.metrics.blockSections.join("·")}개).`);
  const otherHard = hard.filter((issue) => !["block-over", "placement-forced"].includes(issue.type) || !blockLimit);
  if (otherHard.length) parts.push(`오류 ${otherHard.length}건: ${otherHard.slice(0, 3).map((issue) => issue.message).join(" / ")}${otherHard.length > 3 ? " …" : ""}`);
  const closed = result.closedRequests || [];
  const closedText = closed.length ? ` 재신청 대상 ${new Set(closed.map((item) => item.studentKey)).size}명(폐강 과목 ${closed.length}건)은 따로 셉니다.` : "";
  if (!feasible && !result.unassigned.length && !parts.length) parts.push(`학생은 모두 배정했지만 확인할 오류가 ${hard.length}건 있습니다.`);
  const summary = (feasible
    ? `모든 학생 배정(분반 ${model.sections.length}개, 블록별 ${result.metrics.blockSections.join("·")}개).`
    : (!result.unassigned.length && !parts[0].startsWith("학생은") ? `학생은 모두 배정했지만 확인 필요 — ${parts.join(" ")}` : parts.join(" "))) + closedText;
  return { feasible, causes, suggestions, summary };
}

// 분반 수가 블록 수 × 블록당 최대보다 많을 때: 몇 과목의 정원을 올려 분반 수를 줄이면 들어가는지 다시 풀어 확인한다.
function classSectionsSectionsSuggestion(model, input, deadline) {
  if (!input || (Array.isArray(input.sections) && input.sections.length)) return null;
  const maxTotal = model.blocks.reduce((sum, block) => sum + block.maxSections, 0);
  const excess = model.sections.length - maxTotal;
  if (!(excess > 0) || !Number.isFinite(maxTotal)) return null;
  for (const add of [1, 2]) {
    const capacity = model.defaultCapacity + add;
    const candidates = model.courses.map((course) => {
      const need = Math.max(1, Math.ceil(course.demand / capacity));
      return { course, need, saving: course.sections - need, fill: course.demand / (need * capacity) };
    }).filter((item) => item.saving > 0 && item.course.demand > 0)
      .sort((a, b) => b.saving - a.saving || a.fill - b.fill || a.course.index - b.course.index);
    if (candidates.reduce((sum, item) => sum + item.saving, 0) < excess) continue;
    // 고르는 순서를 바꿔 가며 최대 6가지 조합을 실제로 풀어 본다.
    for (let start = 0; start < Math.min(6, candidates.length); start += 1) {
      if (deadline && classSectionsNow() > deadline) return null;
      const order = [...candidates.slice(start), ...candidates.slice(0, start)];
      const chosen = [];
      let saved = 0;
      for (const item of order) { if (saved >= excess) break; chosen.push(item); saved += item.saving; }
      if (saved < excess) continue;
      const changed = new Map(chosen.map((item) => [item.course.key, item]));
      const courses = (input.courses || []).map((raw) => {
        const item = changed.get(classSectionsText(raw.key ?? raw.name));
        return item ? { ...raw, sections: item.need, classCount: item.need, capacity, capacities: [] } : raw;
      });
      const trial = classSectionsSolve({ ...input, courses, suggest: false });
      if (trial.explain.feasible) {
        const list = chosen.map((item) => ({ courseKey: item.course.key, courseName: item.course.name, fromSections: item.course.sections,
          toSections: item.need, capacity, demand: item.course.demand }));
        return { type: "sections", verified: true, courses: list, capacity,
          message: `${list.map((item) => `${item.courseName} 정원 ${capacity}명(분반 ${item.fromSections}→${item.toSections}개)`).join(", ")}으로 바꾸면 분반 ${model.sections.length - saved}개가 블록 ${model.blocks.length}개 × ${model.blocks[0].maxSections}개에 들어가고 모두 배정됩니다.` };
      }
    }
  }
  return null;
}

// 개설강의실 번호(나이스): 어느 블록에서든 그 과목 분반이 2개 이상이면 그 과목의 모든 분반에 번호, 아니면 번호 없음.
// 번호는 교사가 모두 배정돼 있으면 과목 안 교사 순번(같은 교사 = 같은 번호, 블록 안에서 겹치지 않을 때), 아니면 블록 안 순번.
// (사용자 나이스 파일: 물리학 a1·a2·b2·c1 — b블록 단독 분반이 2 → 교사 순번으로 해석. 확인 필요)
function classSectionsAssignRoomNames(result, blockOrder, keep) {
  const order = new Map((blockOrder || result.blocks.map((block) => block.id)).map((id, index) => [id, index]));
  const byCourse = new Map();
  for (const section of result.sections) {
    if (!byCourse.has(section.courseKey)) byCourse.set(section.courseKey, []);
    byCourse.get(section.courseKey).push(section);
  }
  for (const list of byCourse.values()) {
    list.sort((a, b) => (order.get(a.blockId) ?? 99) - (order.get(b.blockId) ?? 99) || a.ord - b.ord);
    const perBlock = new Map();
    for (const section of list) perBlock.set(section.blockId, (perBlock.get(section.blockId) || 0) + 1);
    const numbered = [...perBlock.values()].some((count) => count > 1);
    let numbers = null;
    if (numbered && list.every((section) => section.teacherId)) {
      const teacherNo = new Map();
      for (const section of list) if (!teacherNo.has(section.teacherId)) teacherNo.set(section.teacherId, teacherNo.size + 1);
      numbers = list.map((section) => teacherNo.get(section.teacherId));
      const seen = new Set();
      for (let i = 0; i < list.length; i += 1) {
        const key = `${list[i].blockId}|${numbers[i]}`;
        if (seen.has(key)) { numbers = null; break; }
        seen.add(key);
      }
    }
    list.forEach((section, i) => {
      section.roomNo = numbered ? (numbers ? numbers[i] : section.noInBlock) : 0;
      section.roomNumbering = numbered ? (numbers ? "teacher" : "block") : "none";
      section.roomName = `${section.blockLetter}${classSectionsCompact(section.courseName)}${section.roomNo || ""}`;
    });
    if (keep && keep.size) classSectionsKeepRoomNames(list, numbered, keep, result);
  }
  return result;
}

// 부분 재계산·고정이 있는 재계산: 기존 분반은 강의실 이름(번호)을 그대로 두고, 새 분반에만 그 블록에서 비어 있는 다음 번호를 준다
// (학생 분반은 그대로인데 이름만 바뀌어 나이스·명렬표가 달라지지 않게). 교사 순번 규칙보다 기존 이름이 우선.
// 번호 없던 과목이 한 블록에 2개가 되면 기존 분반에도 번호가 붙어야 하므로 그때만 이름이 바뀌고 result.roomRenames에 남긴다.
function classSectionsKeepRoomNames(list, numbered, keep, result) {
  const name = (section, no) => `${section.blockLetter}${classSectionsCompact(section.courseName)}${no || ""}`;
  const pattern = (section) => new RegExp(`^${section.blockLetter}${classSectionsCompact(section.courseName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d*)$`);
  const used = new Map();
  const take = (block, no) => { if (!used.has(block)) used.set(block, new Set()); used.get(block).add(no); };
  const kept = [];
  const fresh = [];
  for (const section of list) {
    const before = keep.get(section.id);
    const match = before ? before.match(pattern(section)) : null;
    if (match) { kept.push([section, before, Number(match[1]) || 0]); take(section.blockId, Number(match[1]) || 0); }
    else fresh.push([section, before]);
  }
  const next = (block) => { let no = 1; while (used.get(block)?.has(no)) no += 1; take(block, no); return no; };
  if (!result.roomRenames) result.roomRenames = [];
  for (const [section, before, no] of kept) {
    if (numbered && !no) {
      const assigned = next(section.blockId);
      section.roomNo = assigned;
      section.roomName = name(section, assigned);
      result.roomRenames.push({ sectionId: section.id, from: before, to: section.roomName, reason: "numbered" });
    } else {
      section.roomNo = no;
      section.roomName = before;
    }
    section.roomNumbering = "kept";
  }
  for (const [section, before] of fresh) {
    const no = numbered ? next(section.blockId) : 0;
    section.roomNo = no;
    section.roomName = name(section, no);
    section.roomNumbering = "new";
    if (before && before !== section.roomName) result.roomRenames.push({ sectionId: section.id, from: before, to: section.roomName, reason: "moved" });
  }
}

function classSectionsTeacherSections(model, result) {
  const blocks = new Map(model.blocks.map((block) => [block.id, block]));
  return result.sections.map((section) => {
    const course = model.courseByKey.get(section.courseKey);
    return { id: section.id, courseKey: section.courseKey, courseName: section.courseName, department: course?.department || "", credits: course?.credits || 0,
      blockKey: `${model.groupId}:${section.blockId}`, times: blocks.get(section.blockId)?.times || [], label: `${section.blockLetter}블록 ${section.ord}반` };
  });
}

// ---- 여러 그룹(학년 간 교사·특별실 겹침) ----
// spec: { groups:[그룹 input], teachers, departmentTeachers, rooms, fixedSlots, seed }.
// 같은 학기 그룹은 앞에서 푼 그룹의 블록 시간 사용량(교과 교사·특별실)을 뒤 그룹이 뺀다. 순서에 따라 결과가 달라지므로
// 여러 순서(입력 순서·거꾸로·교사 수가 빠듯한 그룹 먼저·나중)를 모두 풀고 가장 좋은 것을 고른다
// (평가: 미배정 → 교사 불가/겹침/부족 위반 → 분반 인원 차이). 같은 seed면 같은 결과.
// 반환 teacherOf는 '그룹id::분반id' 키, 그룹별 result.teacherOf는 분반id 키.
function classSectionsSolveAll(spec) {
  const start = classSectionsNow();
  const base = (spec.groups || []).map((group, order) => ({ group, order }));
  const fixedSlots = classSectionsMergeFixed([...(spec.fixedSlots || []), ...base.flatMap(({ group }) => group.fixedSlots || [])]);
  const timed = base.some(({ group }) => Array.isArray(group.blocks) && group.blocks.some((block) => classSectionsSlots(block.times).length));
  const limited = (spec.teachers || []).length || spec.departmentTeachers || spec.rooms || base.some(({ group }) => (group.teachers || []).length || group.departmentTeachers || group.rooms);
  const orders = timed && limited && base.length > 1 ? classSectionsSolveAllOrders(base, spec) : [{ label: "입력 순서", list: base }];
  const runs = orders.map((order) => ({ order, run: classSectionsSolveAllOnce(spec, order.list, fixedSlots) }));
  for (const item of runs) item.score = classSectionsSolveAllScore(item.run);
  runs.sort((a, b) => a.score[0] - b.score[0] || a.score[1] - b.score[1] || a.score[2] - b.score[2] || orders.indexOf(a.order) - orders.indexOf(b.order));
  const best = runs[0].run;
  const shortages = classSectionsTeacherShortages(best.results, spec, fixedSlots);
  const shortageIssues = shortages.map((item) => ({ type: "teacher-shortage", severity: "error", department: item.department, slot: item.slot, groups: item.groups, message: item.message }));
  // 그룹 결과 순서는 입력 순서로 돌려준다.
  const byGroup = new Map(best.results.map((item) => [item.input.groupId, item]));
  const ordered = base.map(({ group }) => byGroup.get(group.groupId)).filter(Boolean);
  return { groups: ordered.map(({ input, result }) => ({ groupId: input.groupId, label: input.label, result })),
    teacherOf: best.teacherResult?.teacherOf || {}, teacherLoad: best.teacherResult?.load || {},
    issues: [...(best.teacherResult?.issues || []), ...best.across, ...shortageIssues], shortages,
    orders: runs.map((item) => ({ label: item.order.label, groups: item.order.list.map(({ group }) => group.label || group.groupId), score: item.score })),
    chosenOrder: runs[0].order.label, elapsedMs: Math.round(classSectionsNow() - start) };
}

function classSectionsMergeFixed(list) {
  const seen = new Map();
  for (const item of list) {
    const key = `${classSectionsText(item.label)}|${classSectionsSlots(item.times).join(",")}`;
    const prev = seen.get(key);
    if (prev) prev.teacherIds = [...new Set([...prev.teacherIds, ...(item.teacherIds || []).map(classSectionsText)])];
    else seen.set(key, { label: item.label, times: classSectionsSlots(item.times), teacherIds: (item.teacherIds || []).map(classSectionsText) });
  }
  return [...seen.values()];
}

// 시도할 순서들(학기 순서는 지키고 학기 안에서만 바꿈). 압박 = 교과별 (분반 수 / 교사 수)의 최댓값.
function classSectionsSolveAllOrders(base, spec) {
  const counts = new Map();
  for (const teacher of spec.teachers || []) for (const name of teacher.departments || []) counts.set(name, (counts.get(name) || 0) + 1);
  for (const [name, value] of Object.entries(spec.departmentTeachers || {})) if (!counts.has(name)) counts.set(name, Number(value) || 0);
  const pressure = ({ group }) => {
    let max = 0;
    for (const course of group.courses || []) {
      const supply = counts.get(course.department);
      if (!supply) continue;
      max = Math.max(max, (Number(course.sections ?? course.classCount) || 0) / supply);
    }
    return max;
  };
  const semesterOf = ({ group }) => String(group.semester ?? "");
  const bySemester = (list) => list.slice().sort((a, b) => semesterOf(a).localeCompare(semesterOf(b)));
  const stable = (list, compare) => bySemester(list.map((item, index) => ({ item, index })).sort((a, b) => compare(a.item, b.item) || a.index - b.index).map(({ item }) => item));
  const candidates = [
    { label: "입력 순서", list: bySemester(base) },
    { label: "거꾸로", list: bySemester(base.slice().reverse()) },
    { label: "교사 수가 빠듯한 그룹 먼저", list: stable(base, (a, b) => pressure(b) - pressure(a)) },
    { label: "교사 수가 빠듯한 그룹 나중", list: stable(base, (a, b) => pressure(a) - pressure(b)) }
  ];
  const seen = new Set();
  return candidates.filter((item) => { const key = item.list.map(({ order }) => order).join(","); if (seen.has(key)) return false; seen.add(key); return true; });
}

function classSectionsSolveAllScore(run) {
  let unassigned = 0;
  let violations = 0;
  let spread = 0;
  for (const { result } of run.results) {
    unassigned += result.unassigned.length;
    spread += result.metrics?.maxSpread || 0;
    violations += (result.issues || []).filter((issue) => issue.severity === "error" && issue.type !== "unassigned").length;
  }
  violations += (run.teacherResult?.issues || []).filter((issue) => issue.severity === "error" || issue.type === "teacher-missing").length;
  violations += run.across.filter((issue) => issue.severity === "error").length;
  return [unassigned, violations, spread];
}

function classSectionsSolveAllOnce(spec, list, fixedSlots) {
  const results = [];
  const occupied = [];
  for (const { group } of list) {
    const input = { ...group, teachers: group.teachers || spec.teachers, departmentTeachers: group.departmentTeachers || spec.departmentTeachers,
      rooms: group.rooms || spec.rooms, fixedSlots, occupied: [...(group.occupied || []), ...occupied],
      seed: group.seed ?? spec.seed, timeLimitMs: group.timeLimitMs ?? spec.timeLimitMs };
    const result = classSectionsSolve(input);
    results.push({ input, result });
    const model = classSectionsNormalize({ ...input, students: [] });
    for (const block of result.blocks) {
      if (!block.times.length) continue;
      const departments = {};
      const rooms = {};
      for (const id of block.sectionIds) {
        const section = result.sections.find((item) => item.id === id);
        const course = model.courseByKey.get(section.courseKey);
        if (course?.department) departments[course.department] = (departments[course.department] || 0) + 1;
        if (course?.room) rooms[course.room] = (rooms[course.room] || 0) + 1;
      }
      occupied.push({ label: `${group.label || group.groupId} ${block.letter}블록`, times: block.times, departments, rooms });
    }
  }
  // 교사는 모든 그룹을 함께 배정(같은 시간 겹침 방지, 교환 지역 탐색 포함).
  let teacherResult = null;
  if ((spec.teachers || []).length) {
    const sections = [];
    for (const { input, result } of results) {
      const model = classSectionsNormalize({ ...input, students: [] });
      model.groupId = input.groupId || "";
      // 그룹마다 분반 id가 같을 수 있으므로(예: '물리학#1') '그룹id::분반id'로 구분한다.
      sections.push(...classSectionsTeacherSections(model, result).map((section) => ({ ...section, id: `${input.groupId || ""}::${section.id}`,
        groupId: input.groupId, courseName: `${input.label || input.groupId} ${section.courseName}` })));
    }
    const qualify = (map, input) => Object.fromEntries(Object.entries(map || {}).map(([id, teacher]) => [`${input.groupId || ""}::${id}`, teacher]));
    const pins = Object.assign({}, ...results.map(({ input }) => qualify(input.pins?.teachers, input)));
    const previous = Object.assign({}, ...results.map(({ input }) => qualify(input.previous?.teacherOf, input)));
    teacherResult = classSectionsAssignTeachers({ teachers: spec.teachers, sections, fixedSlots, pins, previous });
    for (const { input, result } of results) {
      result.teacherOf = {};
      for (const section of result.sections) {
        section.teacherId = teacherResult.teacherOf[`${input.groupId || ""}::${section.id}`] || "";
        if (section.teacherId) result.teacherOf[section.id] = section.teacherId;
      }
      result.issues = result.issues.filter((issue) => !String(issue.type).startsWith("teacher-"));
      classSectionsAssignRoomNames(result, undefined, classSectionsKeepMap(input));
    }
  }
  const across = classSectionsValidateAcross(results, spec.teachers);
  return { results, teacherResult, across };
}

// 교과별 '그 시각에 가능한 교사 수' (교사 명단 → 교과·과목 자격, 불가 시간·고정 시간 제외; 명단이 없으면 departmentTeachers).
function classSectionsSlotSupply(spec, fixedSlots, courseDepartment) {
  const teachers = (spec.teachers || []).map((raw) => ({ id: classSectionsText(raw.id ?? raw.name), departments: new Set((raw.departments || []).map(classSectionsText)),
    courses: (raw.courses || []).map(classSectionsText), unavailable: new Set((raw.unavailable || []).map(classSectionsSlot)) }));
  for (const teacher of teachers) for (const course of teacher.courses) { const dept = courseDepartment(course); if (dept) teacher.departments.add(dept); }
  const busy = new Map();
  for (const slot of fixedSlots || []) for (const id of slot.teacherIds || []) for (const time of classSectionsSlots(slot.times)) {
    if (!busy.has(time)) busy.set(time, new Set());
    busy.get(time).add(classSectionsText(id));
  }
  const counts = spec.departmentTeachers || {};
  return (department, slot) => {
    if (teachers.length) {
      const known = teachers.some((teacher) => teacher.departments.has(department));
      if (!known) return Infinity;
      return teachers.filter((teacher) => teacher.departments.has(department) && !teacher.unavailable.has(slot) && !busy.get(slot)?.has(teacher.id)).length;
    }
    return counts[department] !== undefined ? Number(counts[department]) || 0 : Infinity;
  };
}

// 교사 부족 설명: 시각마다 교과별로 (그 시각 블록들의 분반 수) > (가능한 교사 수)이면 '어느 교과가 어느 시간에 몇 명 모자람'.
function classSectionsTeacherShortages(results, spec, fixedSlots) {
  const departmentOf = new Map();
  for (const { input } of results) for (const course of input.courses || []) {
    const key = classSectionsText(course.key ?? course.name);
    if (course.department) { departmentOf.set(key, course.department); departmentOf.set(classSectionsText(course.name), course.department); }
  }
  const supply = classSectionsSlotSupply(spec, fixedSlots, (course) => departmentOf.get(course));
  const demand = new Map();
  for (const { input, result } of results) {
    for (const block of result.blocks || []) {
      for (const slot of block.times || []) {
        for (const id of block.sectionIds) {
          const section = result.sections.find((item) => item.id === id);
          const department = departmentOf.get(section?.courseKey);
          if (!department) continue;
          const key = `${department}|${slot}`;
          if (!demand.has(key)) demand.set(key, { department, slot, count: 0, parts: new Map(), groups: new Set() });
          const entry = demand.get(key);
          entry.count += 1;
          entry.groups.add(input.groupId || "");
          const label = `${input.label || input.groupId} ${block.letter}블록`;
          entry.parts.set(label, (entry.parts.get(label) || 0) + 1);
        }
      }
    }
  }
  const list = [];
  for (const entry of demand.values()) {
    const available = supply(entry.department, entry.slot);
    if (!(entry.count > available)) continue;
    const [day, period] = entry.slot.split(":");
    // groups: 그 시각에 그 교과 분반을 실제로 가진 그룹(오류는 이 그룹들에만, 나머지 그룹엔 참고로).
    list.push({ department: entry.department, slot: entry.slot, demand: entry.count, supply: available, short: entry.count - available, groups: [...entry.groups],
      message: `${entry.department}: ${day}요일 ${period}교시 분반 ${entry.count}개(${[...entry.parts].map(([label, count]) => `${label} ${count}`).join(", ")}) > 가능한 교사 ${available}명 → ${entry.count - available}명 모자람` });
  }
  return list.sort((a, b) => b.short - a.short || a.slot.localeCompare(b.slot) || a.department.localeCompare(b.department));
}

// ---- 블록 시간 추천(블록 → 요일·교시. 전체 시간표가 아니라 블록 칸 배치까지만) ----
// spec: { days:["월",…], periods:7, fixedSlots:[{ label, times, teacherIds }], teachers, departmentTeachers, reserve:{ 학년: 남길 시간 },
//   groups:[{ groupId, label, grade(수업 듣는 학년), blocks:[{ id, hours, departments:{ 교과: 분반 수 } }] }], seed, iterations }
// 같은 학년(같은 학생) 블록끼리는 시간이 겹치면 안 되고, 다른 학년끼리는 같은 시각 같은 교과 분반 합이 그 시각 교사 수를 넘지 않게 한다.
// 비용 = 1000×교사 부족 + 50×블록이 같은 날 두 번 + 학년별 요일 몰림(시간²) + 남길 시간 부족. 탐욕 시작 + 지역 탐색(시드 고정).
function classSectionsRecommendTimes(spec) {
  const start = classSectionsNow();
  const rng = classSectionsRng(Number(spec.seed) || 1);
  const days = (spec.days && spec.days.length ? spec.days : ["월", "화", "수", "목", "금"]).map(classSectionsText).filter(Boolean);
  const periods = Math.max(1, Math.min(12, Math.floor(Number(spec.periods) || 7)));
  const fixedSlots = classSectionsMergeFixed(spec.fixedSlots || []);
  const blocked = new Set(fixedSlots.flatMap((slot) => slot.times));
  const all = [];
  for (const day of days) for (let p = 1; p <= periods; p += 1) all.push(`${day}:${p}`);
  const slotsIndex = new Map(all.map((slot, index) => [slot, index]));
  const usable = all.filter((slot) => !blocked.has(slot));
  const departmentOf = () => "";
  const supplyOf = classSectionsSlotSupply(spec, fixedSlots, departmentOf);
  const blocks = [];
  for (const group of spec.groups || []) {
    for (const block of group.blocks || []) {
      blocks.push({ groupId: group.groupId, label: `${group.label || group.groupId} ${block.id}블록`, id: block.id, grade: classSectionsText(group.grade),
        hours: Math.max(1, Math.min(usable.length, Math.floor(Number(block.hours) || 1))), departments: Object.entries(block.departments || {}).filter(([, n]) => Number(n) > 0), slots: [] });
    }
  }
  const grades = [...new Set(blocks.map((block) => block.grade))];
  const issues = [];
  for (const grade of grades) {
    const need = blocks.filter((block) => block.grade === grade).reduce((sum, block) => sum + block.hours, 0);
    const reserve = Number(spec.reserve?.[grade]) || 0;
    if (need + reserve > usable.length) issues.push({ type: "grid-full", severity: "error", grade,
      message: `${grade}학년: 블록 시간 ${need}시간 + 남길 시간 ${reserve}시간 > 쓸 수 있는 칸 ${usable.length}개(고정 시간 제외)` });
  }
  // 상태: 학년별 칸 점유, 칸×교과 수요
  const used = new Map(grades.map((grade) => [grade, new Map()]));
  const demand = new Map();
  const supplyCache = new Map();
  const supply = (dept, slot) => {
    const key = `${dept}|${slot}`;
    if (!supplyCache.has(key)) supplyCache.set(key, supplyOf(dept, slot));
    return supplyCache.get(key);
  };
  const overAt = (dept, slot, value) => Math.max(0, value - supply(dept, slot));
  const dayOf = (slot) => slot.split(":")[0];
  const dayLoad = new Map();
  const loadKey = (grade, day) => `${grade}|${day}`;
  // 한 블록을 slot에 넣거나(+1) 뺄 때(-1) 비용 변화
  const delta = (block, slot, sign) => {
    let cost = 0;
    for (const [dept, n] of block.departments) {
      const key = `${dept}|${slot}`;
      const before = demand.get(key) || 0;
      cost += 1000 * (overAt(dept, slot, before + sign * n) - overAt(dept, slot, before));
    }
    const day = dayOf(slot);
    const sameDay = block.slots.filter((other) => other !== slot && dayOf(other) === day).length;
    if (block.hours <= days.length) cost += sign * 50 * sameDay;
    const load = dayLoad.get(loadKey(block.grade, day)) || 0;
    cost += (load + sign) ** 2 - load ** 2;
    return cost;
  };
  const apply = (block, slot, sign) => {
    for (const [dept, n] of block.departments) { const key = `${dept}|${slot}`; demand.set(key, (demand.get(key) || 0) + sign * n); }
    const key = loadKey(block.grade, dayOf(slot));
    dayLoad.set(key, (dayLoad.get(key) || 0) + sign);
    const grid = used.get(block.grade);
    if (sign > 0) { grid.set(slot, block); block.slots.push(slot); }
    else { grid.delete(slot); block.slots.splice(block.slots.indexOf(slot), 1); }
  };
  const order = blocks.slice().sort((a, b) => b.hours - a.hours || b.departments.reduce((s, [, n]) => s + n, 0) - a.departments.reduce((s, [, n]) => s + n, 0));
  for (const block of order) {
    for (let h = 0; h < block.hours; h += 1) {
      let best = null;
      for (const slot of usable) {
        if (used.get(block.grade).has(slot)) continue;
        const cost = delta(block, slot, 1) + rng() * 1e-3;
        if (!best || cost < best.cost) best = { slot, cost };
      }
      if (!best) break;
      apply(block, best.slot, 1);
    }
  }
  const iterations = Number(spec.iterations) || Math.min(20000, 2000 + blocks.length * 400);
  for (let it = 0; it < iterations && blocks.length; it += 1) {
    const block = blocks[Math.floor(rng() * blocks.length)];
    if (!block.slots.length) continue;
    const from = block.slots[Math.floor(rng() * block.slots.length)];
    const grid = used.get(block.grade);
    const to = usable[Math.floor(rng() * usable.length)];
    if (to === from) continue;
    const other = grid.get(to);
    if (other === block) continue;
    // 빈 칸으로 옮기기 또는 같은 학년 다른 블록과 칸 맞바꾸기
    let change = delta(block, from, -1);
    apply(block, from, -1);
    if (other) { change += delta(other, to, -1); apply(other, to, -1); }
    change += delta(block, to, 1);
    apply(block, to, 1);
    if (other) { change += delta(other, from, 1); apply(other, from, 1); }
    const temp = 2 * (1 - it / iterations) + 0.01;
    if (change <= 0 || rng() < Math.exp(-change / temp)) continue;
    if (other) { apply(other, from, -1); }
    apply(block, to, -1);
    if (other) apply(other, to, 1);
    apply(block, from, 1);
  }
  // 결과·부족·남는 칸
  const shortages = [];
  for (const [key, count] of demand) {
    const [dept, slot] = [key.slice(0, key.lastIndexOf("|")), key.slice(key.lastIndexOf("|") + 1)];
    const available = supply(dept, slot);
    if (count > available) {
      const [day, period] = slot.split(":");
      shortages.push({ department: dept, slot, demand: count, supply: available, short: count - available,
        message: `${dept}: ${day}요일 ${period}교시 분반 ${count}개 > 가능한 교사 ${available}명 → ${count - available}명 모자람` });
    }
  }
  const sortSlots = (list) => list.slice().sort((a, b) => slotsIndex.get(a) - slotsIndex.get(b));
  const toTime = (slot) => { const [day, period] = slot.split(":"); return { day, period: Number(period) }; };
  const groups = (spec.groups || []).map((group) => ({ groupId: group.groupId,
    blocks: blocks.filter((block) => block.groupId === group.groupId).map((block) => ({ id: block.id, times: sortSlots(block.slots).map(toTime) })) }));
  const free = Object.fromEntries(grades.map((grade) => [grade, usable.length - used.get(grade).size]));
  for (const grade of grades) {
    const reserve = Number(spec.reserve?.[grade]) || 0;
    if (reserve && free[grade] < reserve) issues.push({ type: "reserve", severity: "warn", grade, message: `${grade}학년: 남는 칸 ${free[grade]}개 < 공통 과목용 ${reserve}시간` });
  }
  for (const block of blocks) {
    const daysUsed = new Set(block.slots.map(dayOf)).size;
    if (block.hours <= days.length && daysUsed < block.slots.length) issues.push({ type: "same-day", severity: "warn", message: `${block.label}: 같은 날 두 시간 이상` });
    if (block.slots.length < block.hours) issues.push({ type: "unplaced", severity: "error", message: `${block.label}: ${block.hours}시간 중 ${block.slots.length}시간만 배치(칸 부족)` });
  }
  return { groups, shortages: shortages.sort((a, b) => b.short - a.short || a.slot.localeCompare(b.slot)), free, issues,
    grid: { days, periods, blocked: [...blocked] }, elapsedMs: Math.round(classSectionsNow() - start) };
}

// ---- 방식별 비교·추천 ----
function classSectionsCompare(input, modes) {
  const list = (modes || CLASS_SECTIONS_MODES).filter((mode) => CLASS_SECTIONS_MODES.includes(mode));
  const base = classSectionsSolve({ ...input, mode: list[0] || "move", suggest: input.suggest });
  const results = { [base.mode]: base };
  for (const mode of list) {
    if (results[mode]) continue;
    results[mode] = classSectionsSolve({ ...input, mode, suggest: false }, base.placement && Object.fromEntries(Object.entries(base.placement)));
  }
  // recommendExclude: 비교표에는 보이되 추천에서는 뺄 방식(예: 내년 반 배정표가 없을 때의 담임반 묶기 — 진급 때 반이 바뀌면 효과 없음).
  const exclude = new Set(Array.isArray(input.recommendExclude) ? input.recommendExclude : []);
  const rows = list.map((mode) => ({ mode, label: CLASS_SECTIONS_MODE_LABELS[mode], excluded: exclude.has(mode), ...results[mode].metrics }));
  const candidates = rows.filter((row) => !row.excluded);
  const recommendation = classSectionsRecommend(candidates.length ? candidates : rows, Boolean(input.previous));
  return { results, rows, recommended: recommendation.mode, reason: recommendation.reason };
}

function classSectionsRecommend(rows, hasPrevious) {
  if (!rows.length) return { mode: "move", reason: "" };
  const minUnassigned = Math.min(...rows.map((row) => row.unassigned));
  const ok = rows.filter((row) => row.unassigned === minUnassigned);
  const get = (mode) => ok.find((row) => row.mode === mode);
  const pct = (value) => `${Math.round(value * 100)}%`;
  const move = get("move") || ok[0];
  const home = get("homeroom");
  const balance = get("balance");
  let pick = move;
  let reason = `${move.label}: 미배정 ${move.unassigned}건, 분반 인원 차이 최대 ${move.maxSpread}명.`;
  if (home && home.sameHomeroomRatio - move.sameHomeroomRatio >= 0.1 && home.maxSpread <= move.maxSpread + 3) {
    pick = home;
    reason = `같은 반끼리 비율이 ${pct(move.sameHomeroomRatio)} → ${pct(home.sameHomeroomRatio)}로 높아지고 분반 인원 차이는 최대 ${home.maxSpread}명이라 ${home.label}을 추천합니다.`;
  } else if (balance && balance.maxSpread < move.maxSpread) {
    pick = balance;
    reason = `분반 인원 차이가 최대 ${move.maxSpread}명 → ${balance.maxSpread}명으로 줄어 ${balance.label}을 추천합니다.`;
  }
  if (hasPrevious) {
    const fewest = ok.slice().sort((a, b) => a.moved - b.moved)[0];
    if (fewest && pick.moved - fewest.moved > 20) { pick = fewest; reason = `기존 배정에서 옮기는 학생 과목이 가장 적은(${fewest.moved}건) ${fewest.label}을 추천합니다.`; }
  }
  if (minUnassigned > 0) reason = `모든 방식에서 미배정이 남습니다(${minUnassigned}건). ${reason}`;
  return { mode: pick.mode, reason };
}

// ---- 학급 단위 과목: 담임반 → 과목 나누기 ----
// spec: { courses:[{ key, name, sections(맡을 학급 수) }], homerooms:[{ id, size }], students?:[{ homeroom, courses:[key] }] }
// 학생 신청이 있으면 희망과 다른 학생이 가장 적게(최소 비용 유량), 없으면 반 번호 순서대로 나눈다.
function classSectionsClassUnitSplit(spec) {
  const courses = (spec.courses || []).map((course) => ({ key: classSectionsText(course.key ?? course.name), name: classSectionsText(course.name ?? course.key), sections: Math.max(0, Math.floor(Number(course.sections) || 0)) }));
  const homerooms = (spec.homerooms || []).map((room) => ({ id: classSectionsText(room.id), size: Number(room.size) || 0 }))
    .sort((a, b) => (Number(a.id) - Number(b.id)) || (a.id < b.id ? -1 : 1));
  const H = homerooms.length;
  const issues = [];
  // allowMove: 학급 단위 반 수 합이 담임반 수보다 적으면 남는 반은 '이동'(그 반 학생은 이동 분반에서 다른 과목).
  const allowMove = Boolean(spec.allowMove);
  let quotas = courses.map((course) => course.sections);
  const totalQuota = quotas.reduce((sum, value) => sum + value, 0);
  if (H && (totalQuota > H || (!allowMove && totalQuota !== H))) {
    issues.push({ type: "quota", severity: "warn", message: `과목 학급 수 합(${totalQuota})과 담임반 수(${H})가 달라 비율로 맞췄습니다.` });
    const base = totalQuota || courses.length || 1;
    quotas = courses.map((course) => Math.floor(H * (totalQuota ? course.sections : 1) / base));
    let rest = H - quotas.reduce((sum, value) => sum + value, 0);
    for (let i = 0; rest > 0; i = (i + 1) % courses.length) { quotas[i] += 1; rest -= 1; }
  }
  const moveQuota = Math.max(0, H - quotas.reduce((sum, value) => sum + value, 0));
  // 반마다: 학생 수, 학급 단위 과목별 희망 수
  const want = homerooms.map(() => new Map());
  const size = homerooms.map(() => 0);
  const homeIndex = new Map(homerooms.map((room, i) => [room.id, i]));
  for (const student of spec.students || []) {
    const h = homeIndex.get(classSectionsHomeroomOf(student));
    if (h === undefined) continue;
    size[h] += 1;
    for (const value of classSectionsStudentCourseList(student)) {
      const c = courses.findIndex((course) => course.key === value || classSectionsCompact(course.name) === classSectionsCompact(value));
      if (c >= 0) want[h].set(c, (want[h].get(c) || 0) + 1);
    }
  }
  const hasWish = size.some((value) => value > 0);
  const assign = {};
  let mismatched = 0;
  if (hasWish) {
    // 비용: 학급 단위 과목 c로 정한 반 = 그 반에서 c를 고르지 않은 학생 수, '이동' 반 = 학급 단위 과목을 고른 학생 수.
    const choices = [...courses.map((course, c) => ({ key: course.key, quota: quotas[c], cost: (h) => size[h] - (want[h].get(c) || 0) })),
      ...(moveQuota ? [{ key: "", quota: moveQuota, cost: (h) => [...want[h].values()].reduce((sum, value) => sum + value, 0) }] : [])];
    const source = 0;
    const sink = 1 + H + choices.length;
    const edges = [];
    homerooms.forEach((room, h) => {
      edges.push([source, 1 + h, 1, 0]);
      choices.forEach((choice, c) => edges.push([1 + h, 1 + H + c, 1, choice.cost(h) + h * 1e-6 * (c + 1)]));
    });
    choices.forEach((choice, c) => edges.push([1 + H + c, sink, choice.quota, 0]));
    const flow = classSectionsMinCostFlow(sink + 1, edges, source, sink);
    let at = 0;
    homerooms.forEach((room, h) => {
      at += 1;
      choices.forEach((choice, c) => { if (flow.flows[at]) { assign[room.id] = choice.key; mismatched += Math.round(choice.cost(h)); } at += 1; });
    });
  } else {
    let h = 0;
    courses.forEach((course, c) => { for (let k = 0; k < quotas[c] && h < H; k += 1, h += 1) assign[homerooms[h].id] = course.key; });
    for (; h < H; h += 1) assign[homerooms[h].id] = "";
  }
  const ratio = [...quotas, ...(moveQuota ? [moveQuota] : [])].join(":");
  return { assign, ratio, quotas: Object.fromEntries(courses.map((course, c) => [course.key, quotas[c]])), moveRooms: moveQuota, mismatched, issues };
}

// 학급 단위 과목이 정해진 뒤 학생별 이동 과목: 학급 단위 반(그 반 전원이 그 과목 하나)의 학생은 학급 단위 과목을 빼고 남은 칸(택n−1)만 이동,
// '이동' 반 학생은 학급 단위 과목을 들을 수 없으므로 그 희망을 뺀다. 같은 그룹에서 과목 수가 택n을 넘지 않게(이중 배정 방지).
// spec: { students:[{ key, homeroom(내년 반), courses }], choose, unitKeys:[학급 단위 과목], byClass:{ 반: 과목key | "" } }
function classSectionsClassUnitStudents(spec) {
  const unitKeys = new Set((spec.unitKeys || []).map(classSectionsText));
  const byClass = spec.byClass || {};
  const choose = Math.max(1, Math.floor(Number(spec.choose) || 1));
  const students = [];
  const unitOf = {};
  const lost = [];
  let mismatched = 0;
  for (const raw of spec.students || []) {
    const key = classSectionsText(raw.key);
    const wishes = classSectionsStudentCourseList(raw);
    const room = classSectionsKeyPart(classSectionsHomeroomOf(raw));
    const unit = classSectionsText(byClass[room] || "");
    const moving = wishes.filter((value) => !unitKeys.has(value));
    unitOf[key] = unit;
    let keep = moving;
    if (unit) {
      if (!wishes.includes(unit)) mismatched += 1;
      const slots = Math.max(0, choose - 1);
      if (moving.length > slots) { lost.push({ studentKey: key, courses: moving.slice(slots), reason: "class-unit-room", unit }); keep = moving.slice(0, slots); }
    } else {
      const missed = wishes.filter((value) => unitKeys.has(value));
      if (missed.length) { mismatched += 1; lost.push({ studentKey: key, courses: missed, reason: "class-unit-other-room" }); }
    }
    // 이동 반인데 학급 단위 과목을 골라 그 칸이 빈 학생은 미배정(재신청·다른 과목 필요)으로 계산에 넘긴다.
    const missing = unit ? [] : wishes.filter((value) => unitKeys.has(value));
    students.push({ ...raw, courses: keep, ...(missing.length ? { classUnitMissed: missing } : {}) });
  }
  return { students, unitOf, lost, mismatched, total: students.length };
}

// ---- 조합-인원 입력(총괄 검토용) ----
// { subjects:[이름] 또는 [{ name, sections, department }], choose, combos:{ "A|B|C": 인원 }, capacity, maxSectionsPerBlock, sections:{ 이름: 분반 수 } }
function classSectionsFromCombos(spec) {
  const capacity = Number(spec.capacity ?? spec.defaultCapacity) || CLASS_SECTIONS_DEFAULT_CAPACITY;
  const demand = new Map();
  const students = [];
  let n = 0;
  for (const [combo, count] of Object.entries(spec.combos || {})) {
    const names = combo.split("|").map(classSectionsText).filter(Boolean);
    for (let k = 0; k < Number(count); k += 1) {
      n += 1;
      const homeroom = spec.homerooms ? String(1 + (n % Number(spec.homerooms))) : "1";
      students.push({ key: `x-${homeroom}-${n}`, homeroom, courses: names });
      for (const name of names) demand.set(name, (demand.get(name) || 0) + 1);
    }
  }
  const subjects = (spec.subjects || [...demand.keys()]).map((item) => (typeof item === "string" ? { name: item } : item));
  const courses = subjects.map((item) => {
    const name = classSectionsText(item.name ?? item.key);
    const given = item.sections ?? spec.sections?.[name];
    return { key: name, name, department: item.department || spec.departments?.[name] || "", room: item.room || "", credits: Number(item.credits) || 0,
      sections: given !== undefined ? Number(given) : Math.ceil((demand.get(name) || 0) / capacity) };
  });
  return { groupId: spec.groupId || "combos", label: spec.label || "", blocks: spec.blocks ?? spec.choose, choose: spec.choose,
    maxSectionsPerBlock: spec.maxSectionsPerBlock, defaultCapacity: capacity, courses, students, seed: spec.seed, mode: spec.mode,
    departmentTeachers: spec.departmentTeachers, timeLimitMs: spec.timeLimitMs };
}

// ---- 나이스 수강학생 편성 행(초안: 실제 업로드 양식 확인 필요) ----
// opts: { year, semester, targetGrade, students:[{ key, classroom(내년 반, 없으면 빈칸), number, name }], courses:{ key: { family, credits } }, label('(공동)' 등) }
var CLASS_SECTIONS_NEIS_HEADER = [
  ["개설 과목", "", "", "", "", "", "편성 학생", "", "", ""],
  ["학년도", "학기", "학년", "편제명", "개설과목(학점)", "개설강의실", "계열/학년/학과", "반", "번호", "성명"]
];

// 반환: { rows, warnings }. 내년 반·번호를 모르면 반·번호 칸을 비우고 오른쪽에 참고 열(현 학년-반-번호)을 붙인다.
function classSectionsNeisExport(result, opts) {
  const options = opts || {};
  const sectionById = new Map((result.sections || []).map((section) => [section.id, section]));
  const studentInfo = new Map((options.students || []).map((student) => [classSectionsText(student.key), student]));
  const grade = classSectionsText(options.targetGrade);
  const reference = options.reference !== false;
  const rows = CLASS_SECTIONS_NEIS_HEADER.map((row) => (reference ? [...row, row === CLASS_SECTIONS_NEIS_HEADER[1] ? "참고: 현 학년-반-번호" : ""] : row.slice()));
  const keys = Object.keys(result.assign || {}).sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
  let missingClass = 0;
  for (const key of keys) {
    const info = studentInfo.get(key) || {};
    const classroom = classSectionsText(info.classroom).replace(/반$/, "");
    if (!classroom) missingClass += 1;
    for (const id of result.assign[key]) {
      const section = sectionById.get(id);
      if (!section) continue;
      const course = options.courses?.[section.courseKey] || {};
      const credits = Number(course.credits) || "";
      const row = [classSectionsText(options.year), classSectionsText(options.semester), grade, classSectionsText(course.family),
        `${course.label || ""}${section.courseName}${credits !== "" ? `(${credits})` : ""}`, section.roomName, grade ? `${grade}학년` : "",
        classroom ? `${classroom}반` : "", classroom ? classSectionsText(info.number) : "", classSectionsText(info.name)];
      if (reference) row.push(key);
      rows.push(row);
    }
  }
  // 학급 단위 과목: 내년 반이 있는 학생만 그 반의 과목으로 한 줄(개설강의실 'N(학년 N반)'), 없으면 반 배정표를 올린 뒤.
  let classUnitWaiting = 0;
  const classUnitUndecided = new Map();
  const classUnitMove = new Map();
  if (options.classUnit && Object.keys(options.classUnit.byClass || {}).length) {
    for (const info of options.students || []) {
      const classroom = classSectionsKeyPart(info.classroom);
      if (!classroom) { classUnitWaiting += 1; continue; }
      const courseKey = options.classUnit.byClass[classroom];
      const course = courseKey ? options.classUnit.courses?.[courseKey] || {} : null;
      // 반 배분에서 '이동'(빈 값)으로 정한 반은 정상: 학급 단위 행 없음. 배분에 아예 없는 반 번호만 배정표 확인 안내.
      if (!course) {
        const moveRoom = Object.prototype.hasOwnProperty.call(options.classUnit.byClass, classroom) && !courseKey;
        const target = moveRoom ? classUnitMove : classUnitUndecided;
        target.set(classroom, (target.get(classroom) || 0) + 1);
        continue;
      }
      const credits = Number(course.credits) || "";
      const row = [classSectionsText(options.year), classSectionsText(options.semester), grade, classSectionsText(course.family),
        `${course.name || courseKey}${credits !== "" ? `(${credits})` : ""}`, `${classroom}(${grade}학년 ${classroom}반)`, grade ? `${grade}학년` : "",
        `${classroom}반`, classSectionsText(info.number), classSectionsText(info.name)];
      if (reference) row.push(classSectionsText(info.key));
      rows.push(row);
    }
  }
  const warnings = ["나이스 '조회' 파일 양식을 따랐습니다. 실제 업로드 양식과 다를 수 있으니 확인하세요."];
  if (classUnitWaiting) warnings.push(`학급 단위 과목: 내년 반이 없는 학생 ${classUnitWaiting}명분 행은 반 배정표를 올린 뒤 생성합니다(과목별 반 수만 확정).`);
  if (options.classUnit && !Object.keys(options.classUnit.byClass || {}).length && (options.students || []).length) {
    warnings.push(`학급 단위 과목: 반마다 과목이 정해지지 않아 ${(options.students || []).length}명분 행을 만들지 않았습니다.`);
  }
  if (classUnitMove.size) {
    const list = [...classUnitMove.keys()].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    warnings.push(`학급 단위 과목: 내년 ${list.map((room) => `${room}반`).join("·")}은 이동 반 — 학급 단위 행 없음(정상, ${[...classUnitMove.values()].reduce((sum, value) => sum + value, 0)}명).`);
  }
  for (const [classroom, count] of classUnitUndecided) warnings.push(`학급 단위 과목: 내년 ${classroom}반에 정한 과목이 없어 ${count}명분 행을 만들지 않았습니다(반 배정표의 새 반 번호를 확인하세요).`);
  if (missingClass) warnings.push(`내년 반·번호가 없는 학생 ${missingClass}명: 반·번호 칸을 비웠습니다(참고 열의 현 학년-반-번호로 확인). 내년 반 배정표를 올리면 채워집니다.`);
  if (rows.slice(2).some((row) => !row[3])) warnings.push("편제명(교과군)이 빈 행이 있습니다.");
  return { rows, warnings };
}

function classSectionsNeisRows(result, opts) {
  return classSectionsNeisExport(result, opts).rows;
}

// 내년 반 배정표(고정 양식): 1행 머리글, 열 = 현 학년 | 현 반 | 현 번호 | 새 반 | 새 번호. 반환 { map: { '현학년-반-번호': {classroom, number} }, errors }
function classSectionsClassMapFromRows(rows) {
  const map = {};
  const errors = [];
  (rows || []).slice(1).forEach((row, index) => {
    const values = (row || []).map(classSectionsKeyPart);
    if (!values.some(Boolean)) return;
    const [grade, classroom, number, nextClass, nextNumber] = values;
    if (!grade || !classroom || !number || !nextClass) { errors.push(`${index + 2}행: 현 학년·반·번호·새 반이 필요합니다.`); return; }
    map[classSectionsStudentKey(grade, classroom, number)] = { classroom: nextClass, number: nextNumber || "" };
  });
  return { map, errors };
}

// ---- Worker 진입 ----
function classSectionsRun(request) {
  const kind = request?.kind || "solve";
  if (kind === "solveAll") return classSectionsSolveAll(request.input);
  if (kind === "compare") return classSectionsCompare(request.input, request.modes);
  if (kind === "classUnit") return classSectionsClassUnitSplit(request.input);
  if (kind === "recommendTimes") return classSectionsRecommendTimes(request.input);
  return classSectionsSolve(request.input, request.placement);
}

// Blob Worker용 소스(이 파일의 함수·상수 전부). file://에서도 쓰려고 fetch 대신 toString으로 모은다.
function classSectionsWorkerSource() {
  const names = Object.keys(CLASS_SECTIONS_CONSTANTS_FOR_WORKER());
  const constants = names.map((name) => `var ${name} = ${JSON.stringify(CLASS_SECTIONS_CONSTANTS_FOR_WORKER()[name])};`).join("\n");
  const functions = CLASS_SECTIONS_FUNCTIONS_FOR_WORKER().map((fn) => fn.toString()).join("\n");
  return `"use strict";\n${constants}\n${functions}\nself.onmessage = function (event) { var id = event.data && event.data.id; try { self.postMessage({ id: id, ok: true, value: classSectionsRun(event.data) }); } catch (error) { self.postMessage({ id: id, ok: false, error: String(error && error.message || error) }); } };`;
}

function CLASS_SECTIONS_CONSTANTS_FOR_WORKER() {
  return { CLASS_SECTIONS_VERSION, CLASS_SECTIONS_DEFAULT_CAPACITY, CLASS_SECTIONS_MODES, CLASS_SECTIONS_MODE_LABELS, CLASS_SECTIONS_MODE_WEIGHTS,
    CLASS_SECTIONS_OVERFLOW_COST, CLASS_SECTIONS_BLOCK_LETTERS, CLASS_SECTIONS_SPREAD_WARN, CLASS_SECTIONS_DAYS, CLASS_SECTIONS_NEIS_HEADER };
}

function CLASS_SECTIONS_FUNCTIONS_FOR_WORKER() {
  return [classSectionsText, classSectionsCompact, classSectionsNow, classSectionsRng, classSectionsSlot, classSectionsSlots, classSectionsOverlap,
    classSectionsStable, classSectionsHash, classSectionsSignature, classSectionsStudentCourseList, classSectionsHomeroomOf, classSectionsChangedStudents,
    classSectionsNormalize, classSectionsSupply, classSectionsPlacementNew, classSectionsCanPlace, classSectionsPut, classSectionsCooccurrence,
    classSectionsInitialPlacement, classSectionsJosa, classSectionsClassUnitTrial, classSectionsClassUnitRoomsSuggestion, classSectionsClassUnitStudents, classSectionsTeacherSuggestions, classSectionsKeepMap, classSectionsKeepRoomNames, classSectionsKeyPart, classSectionsStudentKey, classSectionsUnits, classSectionsRouterNew, classSectionsCellCost, classSectionsEnumerate, classSectionsHomeArr,
    classSectionsUnitDelta, classSectionsUnitApply, classSectionsUnitPlaceOne, classSectionsRouterRebuild, classSectionsRouterRecount,
    classSectionsRouterCost, classSectionsRouterSnapshot, classSectionsRouterRestore, classSectionsRouterSearch, classSectionsRouterSnapshotY,
    classSectionsRouterRestoreY, classSectionsPlacementMove, classSectionsUndo, classSectionsPlace, classSectionsRoute, classSectionsMinCostFlow,
    classSectionsPartialPerm, classSectionsFillCells, classSectionsAssignTeachers, classSectionsRoomName, classSectionsBuildResult, classSectionsValidate,
    classSectionsValidateAcross, classSectionsMetrics, classSectionsExplain, classSectionsCapacitySuggestion, classSectionsSuggest, classSectionsSolve,
    classSectionsTeacherSections, classSectionsSolveAll, classSectionsMergeFixed, classSectionsSolveAllOrders, classSectionsSolveAllScore,
    classSectionsSolveAllOnce, classSectionsSlotSupply, classSectionsTeacherShortages, classSectionsRecommendTimes, classSectionsCompare, classSectionsRecommend, classSectionsClassUnitSplit,
    classSectionsFromCombos, classSectionsHardErrors, classSectionsExplainResult, classSectionsSectionsSuggestion, classSectionsAssignRoomNames,
    classSectionsNeisExport, classSectionsNeisRows, classSectionsClassMapFromRows, classSectionsRun];
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { classSectionsSolve, classSectionsSolveAll, classSectionsCompare, classSectionsValidate, classSectionsValidateAcross,
    classSectionsFromCombos, classSectionsClassUnitSplit, classSectionsAssignTeachers, classSectionsNeisRows, classSectionsSignature,
    classSectionsChangedStudents, classSectionsRun, classSectionsWorkerSource, classSectionsMinCostFlow, classSectionsNeisExport, classSectionsClassMapFromRows, classSectionsRecommendTimes, classSectionsTeacherShortages };
}

// ---- 교실 배정 ----
// 분반 → 교실 추천(순수 계산, 결정적). 블록마다 그 블록의 분반을 교실에 하나씩 놓는다(같은 블록 안 겹침 없음).
// 기본: 그 분반 수강생이 가장 많은 내년 반 교실(학생 이동이 가장 적게), 특별실 과목은 그 종류 특별실. 블록마다 최소 비용 매칭.
// 블록 시간이 있으면 같은 시간의 다른 그룹(다른 학년) 블록이 쓰는 교실·특별실은 못 쓴다(학년 교실은 학년별이라 보통 안 겹침).
// 블록 시간이 없으면 다른 그룹과의 겹침은 알 수 없으므로 안내만 한다(같은 그룹 블록끼리는 시간이 다르다).
// rooms: [{ id, label, kind: "class" | "special" | "extra", grade(수업 학년, class만), homeroom(반 번호, class만), type(special만) }]
// groups: [{ groupId, label, targetGrade, blocks: [{ id, letter, times }], sections: [{ id, courseName, blockId, roomName, size, special, homerooms: { 반: 인원 } }], pins: { 분반id: 교실id } }]
var CLASS_SECTIONS_ROOM_COST = { special: 0, extra: 3000, fallback: 6000, perStudent: 100 };

// 기본 교실 이름: 학년 교실 '2-1'…, 특별실은 하나면 '컴퓨터실', 여럿이면 '과학실1'·'과학실2'.
function classSectionsDefaultRoomNames(type, count, grade) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (grade !== undefined && grade !== null && grade !== "") return Array.from({ length: n }, (_, i) => `${grade}-${i + 1}`);
  return n === 1 ? [String(type)] : Array.from({ length: n }, (_, i) => `${type}${i + 1}`);
}

// 교실 목록 만들기. spec: { classrooms: { 학년: [이름] }, special: { 종류: [이름] }, extra: [이름] }
// 학년 교실의 반 번호는 목록 순서(1번째 = 1반)다. 이름이 '2-3'처럼 생겼으면 화면 이름은 '2학년 3반'.
function classSectionsRoomList(spec) {
  const rooms = [];
  const seen = new Set();
  const push = (room) => { if (!room.id || seen.has(room.id)) return; seen.add(room.id); rooms.push(room); };
  for (const [grade, names] of Object.entries(spec?.classrooms || {})) {
    (names || []).map(classSectionsText).filter(Boolean).forEach((name, index) => {
      const match = name.match(/^(\d+)\s*-\s*(\d+)$/);
      push({ id: name, label: match ? `${Number(match[1])}학년 ${Number(match[2])}반` : name, kind: "class", grade: String(grade), homeroom: String(index + 1) });
    });
  }
  for (const [type, names] of Object.entries(spec?.special || {})) {
    (names || []).map(classSectionsText).filter(Boolean).forEach((name) => push({ id: name, label: name, kind: "special", type: classSectionsText(type) }));
  }
  (spec?.extra || []).map(classSectionsText).filter(Boolean).forEach((name) => push({ id: name, label: name, kind: "extra" }));
  return rooms;
}

// 두 블록이 같은 시간에 열리는가: 같은 그룹이면 같은 블록일 때만, 다른 그룹이면 시간(요일·교시)이 겹칠 때만.
function classSectionsRoomBlocksClash(a, b) {
  if (a.groupId === b.groupId) return a.blockId === b.blockId;
  return classSectionsOverlap(a.times, b.times);
}

// 분반이 그 교실을 쓸 수 있는가와 비용(작을수록 좋음). 못 쓰면 null.
function classSectionsRoomCost(section, room, targetGrade, roomIndex) {
  const C = CLASS_SECTIONS_ROOM_COST;
  if (section.special) {
    if (room.kind === "special") return room.type === section.special ? C.special + roomIndex : null;
    if (room.kind === "class" && room.grade === targetGrade) return C.fallback + C.perStudent * (section.size - (section.homerooms?.[room.homeroom] || 0)) + roomIndex;
    return null;
  }
  if (room.kind === "class") return room.grade === targetGrade ? C.perStudent * (section.size - (section.homerooms?.[room.homeroom] || 0)) + roomIndex : null;
  if (room.kind === "extra") return C.extra + roomIndex;
  return null;
}

function classSectionsAssignRooms(spec) {
  const rooms = Array.isArray(spec?.rooms) ? spec.rooms : [];
  const roomById = new Map(rooms.map((room, index) => [room.id, { ...room, index }]));
  const issues = [];
  const assign = {};
  const reasons = {};
  // 블록 목록(그룹 순서 → 블록 순서). 시간은 '월:1' 모양으로 맞춘다.
  const blocks = [];
  let timed = 0;
  let untimed = 0;
  for (const group of spec?.groups || []) {
    assign[group.groupId] = {};
    reasons[group.groupId] = {};
    const sectionsByBlock = new Map();
    for (const raw of group.sections || []) {
      const section = { ...raw, size: Number(raw.size) || 0, special: classSectionsText(raw.special), homerooms: raw.homerooms || {} };
      if (!sectionsByBlock.has(section.blockId)) sectionsByBlock.set(section.blockId, []);
      sectionsByBlock.get(section.blockId).push(section);
    }
    for (const block of group.blocks || []) {
      const times = classSectionsSlots(block.times);
      if (times.length) timed += 1; else untimed += 1;
      blocks.push({ groupId: group.groupId, label: group.label || group.groupId, targetGrade: String(group.targetGrade || ""), blockId: block.id, letter: block.letter || block.id,
        times, sections: sectionsByBlock.get(block.id) || [], pins: group.pins || {}, order: blocks.length });
    }
  }
  const used = []; // [{ block, roomId, sectionId }]
  const takenAt = (block) => {
    const taken = new Map();
    for (const item of used) if (classSectionsRoomBlocksClash(item.block, block)) taken.set(item.roomId, item);
    return taken;
  };
  // 1) 직접 고른 교실(고정)을 먼저 둔다. 겹쳐도 지키고 검증기가 알린다.
  for (const block of blocks) for (const section of block.sections) {
    const roomId = classSectionsText(block.pins[section.id]);
    if (!roomId || !roomById.has(roomId)) continue;
    assign[block.groupId][section.id] = roomId;
    reasons[block.groupId][section.id] = "직접 고름";
    used.push({ block, roomId, sectionId: section.id });
  }
  // 2) 특별실 수요가 많은 블록부터(같은 수요면 입력 순서) 블록마다 최소 비용 매칭.
  const order = blocks.slice().sort((a, b) => b.sections.filter((s) => s.special).length - a.sections.filter((s) => s.special).length || a.order - b.order);
  for (const block of order) {
    const todo = block.sections.filter((section) => !assign[block.groupId][section.id]);
    if (!todo.length) continue;
    const taken = takenAt(block);
    const free = rooms.filter((room) => !taken.has(room.id));
    const edges = [];
    const source = 0;
    const sink = 1 + todo.length + free.length;
    todo.forEach((section, i) => {
      edges.push([source, 1 + i, 1, 0]);
      free.forEach((room, j) => {
        const cost = classSectionsRoomCost(section, room, block.targetGrade, roomById.get(room.id).index);
        if (cost !== null) edges.push([1 + i, 1 + todo.length + j, 1, cost]);
      });
    });
    const firstRoomEdge = edges.length;
    free.forEach((room, j) => edges.push([1 + todo.length + j, sink, 1, 0]));
    const flow = classSectionsMinCostFlow(sink + 1, edges, source, sink);
    const picked = new Map();
    for (let e = 0; e < firstRoomEdge; e += 1) {
      const [from, to] = edges[e];
      if (from === source || !flow.flows[e]) continue;
      picked.set(from - 1, free[to - 1 - todo.length]);
    }
    const missing = [];
    todo.forEach((section, i) => {
      const room = picked.get(i);
      if (!room) { missing.push(section); return; }
      assign[block.groupId][section.id] = room.id;
      used.push({ block, roomId: room.id, sectionId: section.id });
      const here = section.homerooms?.[room.homeroom] || 0;
      reasons[block.groupId][section.id] = room.kind === "special" ? `특별실(${room.type})`
        : section.special ? `${section.special} 부족 → 일반 교실`
        : room.kind === "extra" ? "학년 교실 부족 → 다른 교실"
        : here > 0 ? `수강생 ${here}명이 이 반(가장 많음)` : "수강생 반 정보 없음(순서대로)";
      if (section.special && room.kind !== "special") {
        issues.push({ type: "special-fallback", severity: "warn", groupId: block.groupId, sectionId: section.id,
          message: `${block.label} ${block.letter}블록 ${section.roomName || section.courseName}: ${section.special}이 모자라 일반 교실 ${room.label}에 배정했습니다${classSectionsRoomShortWhy(block, section.special, rooms, taken)}.` });
      }
    });
    if (missing.length) {
      const classCount = rooms.filter((room) => room.kind === "class" && room.grade === block.targetGrade).length;
      const extraCount = rooms.filter((room) => room.kind === "extra").length;
      const busy = [...taken.values()].filter((item) => item.block.groupId !== block.groupId);
      issues.push({ type: "room-short", severity: "error", groupId: block.groupId, sectionIds: missing.map((section) => section.id),
        message: `${block.label} ${block.letter}블록: 교실이 모자라 분반 ${missing.length}개(${missing.map((section) => section.roomName || section.courseName).join(", ")})에 교실을 못 정했습니다 — 분반 ${block.sections.length}개 > ${block.targetGrade}학년 교실 ${classCount}개${extraCount ? ` + 다른 교실 ${extraCount}개` : ""}${busy.length ? `(같은 시간 다른 학년이 ${busy.length}개 사용)` : ""}. 교사·시간 설정에서 교실을 늘리거나 블록당 분반을 줄이세요.` });
    }
  }
  if (untimed && blocks.some((block) => block.sections.some((section) => section.special)) && new Set(blocks.map((block) => block.groupId)).size > 1) {
    issues.push({ type: "no-times", severity: "info", message: "블록 시간(요일·교시)이 없는 블록이 있어 다른 학년과의 특별실 겹침은 확인하지 못했습니다. 블록 시간을 넣으면 같은 시간 겹침을 막습니다." });
  }
  const check = classSectionsValidateRooms({ rooms, groups: spec?.groups || [] }, assign);
  const fellBack = new Set(issues.filter((item) => item.type === "special-fallback").map((item) => `${item.groupId}|${item.sectionId}`));
  const extra = check.filter((item) => item.type !== "room-missing" && !(item.type === "special-mismatch" && fellBack.has(`${item.groupId}|${item.sectionId}`)));
  return { assign, reasons, issues: [...issues, ...extra], timed: timed > 0 && !untimed };
}

function classSectionsRoomShortWhy(block, type, rooms, taken) {
  const total = rooms.filter((room) => room.kind === "special" && room.type === type).length;
  const others = [...taken.values()].filter((item) => item.block.groupId !== block.groupId && rooms.find((room) => room.id === item.roomId)?.type === type);
  const need = block.sections.filter((section) => section.special === type).length;
  return ` — ${type} ${total}개, 이 블록 ${type} 과목 분반 ${need}개${others.length ? `, 같은 시간 다른 학년 ${[...new Set(others.map((item) => `${item.block.label} ${item.block.letter}블록`))].join(", ")}이 ${others.length}개 사용` : ""}`;
}

// 교실 배정 검증(계산과 독립): 같은 블록 두 분반 한 교실, 같은 시간 다른 학년 블록과 같은 교실, 특별실 과목이 다른 교실, 없는 교실, 교실 미정.
function classSectionsValidateRooms(spec, assign) {
  const rooms = new Map((spec.rooms || []).map((room) => [room.id, room]));
  const issues = [];
  const uses = [];
  for (const group of spec.groups || []) {
    const blockOf = new Map((group.blocks || []).map((block) => [block.id, block]));
    for (const section of group.sections || []) {
      const roomId = assign?.[group.groupId]?.[section.id] || "";
      const block = blockOf.get(section.blockId);
      const name = `${group.label || group.groupId} ${block?.letter || section.blockId}블록 ${section.roomName || section.courseName}`;
      if (!roomId) { issues.push({ type: "room-missing", severity: "error", groupId: group.groupId, sectionId: section.id, message: `${name}: 교실 미정` }); continue; }
      const room = rooms.get(roomId);
      if (!room) { issues.push({ type: "room-unknown", severity: "error", groupId: group.groupId, sectionId: section.id, message: `${name}: 교실 '${roomId}'이(가) 교실 목록에 없습니다.` }); continue; }
      const special = classSectionsText(section.special);
      if (special && room.type !== special) issues.push({ type: "special-mismatch", severity: "warn", groupId: group.groupId, sectionId: section.id, message: `${name}: ${special} 과목인데 ${room.label}에 배정됨` });
      if (room.kind === "class" && String(room.grade) !== String(group.targetGrade || "")) issues.push({ type: "room-grade", severity: "warn", groupId: group.groupId, sectionId: section.id, message: `${name}: 다른 학년 교실 ${room.label}(그 반 수업과 겹칠 수 있음)` });
      uses.push({ groupId: group.groupId, blockId: section.blockId, times: classSectionsSlots(block?.times), roomId, label: name, sectionId: section.id });
    }
  }
  const seen = new Set();
  for (let i = 0; i < uses.length; i += 1) for (let j = i + 1; j < uses.length; j += 1) {
    const a = uses[i]; const b = uses[j];
    if (a.roomId !== b.roomId || !classSectionsRoomBlocksClash(a, b)) continue;
    const key = `${a.sectionId}|${b.sectionId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const room = rooms.get(a.roomId)?.label || a.roomId;
    issues.push({ type: a.groupId === b.groupId ? "room-double" : "room-cross", severity: "error", groupId: b.groupId, sectionId: b.sectionId, otherGroupId: a.groupId, otherSectionId: a.sectionId,
      message: a.groupId === b.groupId ? `${room}: 같은 블록 두 분반(${a.label}, ${b.label})` : `${room}: 같은 시간 두 분반(${a.label}, ${b.label})` });
  }
  return issues;
}

if (typeof module !== "undefined" && module.exports) {
  Object.assign(module.exports, { classSectionsDefaultRoomNames, classSectionsRoomList, classSectionsAssignRooms, classSectionsValidateRooms });
}
