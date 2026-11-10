"use strict";
// 6단계 분반 편성 화면 연결(내부 단계 번호 8). 계산은 class-sections.js(순수, Worker), 이 파일은 입력 모으기·저장·그리기·내보내기.
// app.js·hours-stats.js 뒤에 로드한다. 다른 파일 함수는 typeof 가드로 부른다.
// 저장: state.classSections = { settings: {교사·고정 시간·특별실·기준}, "<차수>": { "<현학년>:<학기>:<그룹>": 그룹 설정 + sectionResult } }
// 개인정보: 저장하는 학생 키는 '현학년-반-번호'뿐이다. 성명은 명렬표·나이스 내보내기 때 차수 자료에서 읽어 파일에만 쓴다.

var CLASS_SECTIONS_VIEW = { round: "", group: "", running: false, worker: null, workerFailed: false, compare: null, search: "", teacherSlot: -1 };
var CLASS_SECTIONS_DAY_NAMES = ["월", "화", "수", "목", "금"];
var CLASS_SECTIONS_PERIODS = 7;
var CLASS_SECTIONS_MODE_OPTIONS = [["move", "완전 이동"], ["homeroom", "같은 담임반끼리 묶기 우선"], ["balance", "분반 인원 균형"]];
// 나이스 편제명(교과군). 5단계 담당 교과에서 추정한다(확인 필요).
var CLASS_SECTIONS_NEIS_FAMILY = { 국어: "국어", 수학: "수학", 영어: "영어", 과학: "과학", 사회: "사회(역사/도덕포함)", 체육: "체육", 음악: "예술", 미술: "예술",
  제2외국어: "제2외국어/한문", 정보: "기술·가정/정보", 기술가정: "기술·가정/정보", 교양: "교양", 진로: "교양" };

function classSectionsEsc(value) {
  return typeof escapeHtml === "function" ? escapeHtml(value) : String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function classSectionsPlain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ---- 저장 ----
function classSectionsStore() {
  if (!classSectionsPlain(state.classSections)) state.classSections = {};
  return state.classSections;
}

function classSectionsSettings() {
  const store = classSectionsStore();
  if (!classSectionsPlain(store.settings)) store.settings = {};
  const settings = store.settings;
  if (!Array.isArray(settings.teachers)) settings.teachers = [];
  // 교사 id가 겹치면(삭제 후 다시 만들기 등) 두 사람이 한 사람으로 배정되므로 뒤의 것을 다시 매긴다.
  const seenIds = new Set();
  for (const teacher of settings.teachers) {
    if (!teacher || typeof teacher !== "object") continue;
    let id = String(teacher.id || "") || `t${seenIds.size + 1}`;
    if (seenIds.has(id)) {
      let serial = 2;
      while (seenIds.has(`${id}~${serial}`)) serial += 1;
      CLASS_SECTIONS_VIEW.teacherIdWarning = `교사 id가 겹쳐 '${id}'를 '${id}~${serial}'로 바꿨습니다(같은 사람으로 배정되지 않게).`;
      id = `${id}~${serial}`;
    }
    if (teacher.id !== id) teacher.id = id;
    seenIds.add(id);
  }
  if (!Array.isArray(settings.fixedSlots)) settings.fixedSlots = [];
  for (const key of ["rooms", "courseModes", "courseDepartments", "courseRooms"]) if (!classSectionsPlain(settings[key])) settings[key] = {};
  if (!(Number(settings.spreadWarn) > 0)) settings.spreadWarn = 4;
  if (typeof settings.useHoursTeachers !== "boolean") settings.useHoursTeachers = true;
  if (typeof settings.gridDays !== "string" || !settings.gridDays.trim()) settings.gridDays = "월,화,수,목,금";
  if (!(Number(settings.gridPeriods) > 0)) settings.gridPeriods = 7;
  if (!classSectionsPlain(settings.reserve)) settings.reserve = {};
  if (!classSectionsPlain(settings.promotion)) settings.promotion = {};
  return settings;
}

// 과목 운영(이동/학급 단위)·담당 교과·특별실은 현 학년마다 따로 둔다(2학년 '정보' 학급 단위가 3학년 '정보'에 번지지 않게).
// 예전 저장값(과목 이름 → 값, 모든 학년 공통)은 처음 읽을 때 1·2·3학년에 복사해 옮긴다.
function classSectionsCourseConf(settings, kind, grade) {
  const store = settings[kind];
  const values = Object.values(store);
  if (values.length && values.some((value) => !classSectionsPlain(value))) {
    const flat = Object.fromEntries(Object.entries(store).filter(([, value]) => !classSectionsPlain(value)));
    for (const key of Object.keys(flat)) delete store[key];
    for (const g of ["1", "2", "3"]) store[g] = { ...(classSectionsPlain(store[g]) ? store[g] : {}), ...flat };
  }
  const key = String(grade);
  if (!classSectionsPlain(store[key])) store[key] = {};
  return store[key];
}

function classSectionsEntry(round, groupKey, create = true) {
  const store = classSectionsStore();
  if (!classSectionsPlain(store[round])) { if (!create) return null; store[round] = {}; }
  if (!classSectionsPlain(store[round][groupKey])) { if (!create) return null; store[round][groupKey] = {}; }
  const entry = store[round][groupKey];
  for (const key of ["classCounts", "capacities", "blockMax", "blockTimes", "classUnit"]) if (!classSectionsPlain(entry[key])) entry[key] = {};
  if (!classSectionsPlain(entry.pins)) entry.pins = {};
  for (const key of ["sections", "students", "teachers"]) if (!classSectionsPlain(entry.pins[key])) entry.pins[key] = {};
  return entry;
}

// 내년 반 배정표(현 학년마다): { '현학년-반-번호': { classroom, number } }. 진급 때 반이 새로 편성되므로(예 현1 10학급 → 내년 11학급)
// '같은 담임반끼리 묶기'·학급 단위 과목 학생 배정·나이스 반·번호는 이 표가 있을 때만 새 반 기준으로 한다. 학생 키·반·번호만 저장(성명 없음).
function classSectionsClassMap(grade) {
  const maps = classSectionsStore().classMaps;
  const map = classSectionsPlain(maps) ? maps[String(grade)] : null;
  return classSectionsPlain(map) && Object.keys(map).length ? map : null;
}

// 진급 때 반 편성(현 학년마다): "same" 그대로 올라감 / "new" 새로 편성 / "unknown" 아직 모름.
// 학급 수가 바뀌면(현 반 수 ≠ 내년 학급 수) 'new'로 고정한다. 고르지 않았으면 같을 때 'unknown'.
var CLASS_SECTIONS_PROMOTION_LABELS = { same: "그대로 올라감", new: "새로 편성", unknown: "아직 모름" };
function classSectionsPromotion(group) {
  const changes = Boolean(group.nextClasses && group.rosterClasses && group.nextClasses !== group.rosterClasses);
  if (changes) return { value: "new", forced: true, reason: `현 ${group.rosterClasses}학급 → 내년 ${group.nextClasses}학급으로 학급 수가 바뀌어 새로 편성합니다.` };
  const saved = classSectionsSettings().promotion[String(group.grade)];
  return { value: ["same", "new", "unknown"].includes(saved) ? saved : "unknown", forced: false, reason: "" };
}

// 실제로 쓸 내년 반: 올린 배정표 > '그대로 올라감'(지금 반 = 내년 반, 번호는 비움) > 없음.
// 번호를 비우는 이유: 반이 그대로여도 진급 때 번호는 다시 매기는 경우가 많고(전입·전출·성명 순), 틀린 번호로 나이스에 올리면
// 다른 학생에게 잘못 편성돼도 알아채기 어렵지만 빈칸은 올리기 전에 드러난다.
function classSectionsEffectiveClassMap(group) {
  const map = classSectionsClassMap(group.grade);
  if (map) return { map, basis: "map" };
  if (classSectionsPromotion(group).value === "same") {
    return { map: Object.fromEntries((group.gradeStudents || group.students).map((student) => [student.key, { classroom: String(student.homeroom), number: "" }])), basis: "same" };
  }
  return { map: null, basis: "none" };
}

// 복원: 예전 저장분·백업에 없으면 빈 객체. 모양이 틀린 값은 버린다(app.js restorePersistedState가 부름).
function classSectionsRestore(saved) {
  if (!classSectionsPlain(saved)) return {};
  const result = {};
  for (const [key, value] of Object.entries(saved)) {
    if (key === "settings" && classSectionsPlain(value)) result.settings = value;
    else if (key === "classMaps" && classSectionsPlain(value)) result.classMaps = value;
    else if (/^\d+$/.test(key) && classSectionsPlain(value)) {
      result[key] = Object.fromEntries(Object.entries(value).filter(([, entry]) => classSectionsPlain(entry)));
    }
  }
  return result;
}

// ---- 입력 모으기(차수 자료 → 그룹) ----
function classSectionsRoundChoices() {
  const rounds = typeof applicationRoundNumbers === "function" ? applicationRoundNumbers() : Object.keys(state.rounds || {});
  return rounds.filter((round) => typeof roundStatusData === "function" && roundStatusData(round)?.students?.length);
}

function classSectionsDefaultRound() {
  const rounds = classSectionsRoundChoices();
  const locked = rounds.slice().reverse().find((round) => typeof isRoundLocked === "function" && isRoundLocked(round));
  return locked || (rounds.includes(String(state.currentRound)) ? String(state.currentRound) : rounds.at(-1) || "");
}

// 편제표 교과(군)·학점: 현 학년 신청 과목 목록(collectApplicationSubjects)에서 N+1학년 과목을 이름으로 찾는다.
function classSectionsPlanSubjects(grade) {
  const map = new Map();
  const key = (name) => (typeof normalizeResultCourseName === "function" ? normalizeResultCourseName(name) : String(name || "").replace(/\s+/g, ""));
  map.lookup = (name) => map.get(key(name)) || null;
  if (typeof collectApplicationSubjects !== "function") return map;
  let subjects = null;
  try { subjects = collectApplicationSubjects({ includeExcluded: true, currentGrade: String(grade) }); } catch { subjects = null; }
  for (const item of subjects?.[String(Number(grade) + 1)] || []) {
    const name = key(item.subject);
    if (name && !map.has(name)) map.set(name, { area: String(item.area || "").trim(), credit: Number(String(item.credit || "").match(/\d+/)?.[0]) || 0 });
  }
  return map;
}

// 나이스 편제명: 편제표 교과(군)이 있으면 그것(띄어쓰기 없앰, 예 '사회(역사/도덕포함)'), 없으면 담당 교과에서 추정.
function classSectionsNeisFamily(area, department) {
  const value = String(area || "").replace(/\s+/g, "");
  return value || classSectionsFamily(department);
}

function classSectionsFamily(department) {
  const group = String(department || "").split("-")[0];
  return CLASS_SECTIONS_NEIS_FAMILY[group] || CLASS_SECTIONS_NEIS_FAMILY[department] || "";
}

function classSectionsSource(round) {
  const year = $("#schoolYear")?.value || "";
  let thresholds = { openingPercent: 90, divisionPercent: 110 };
  try { if (typeof aggregateThresholds === "function") thresholds = aggregateThresholds(); } catch { /* 기본값 */ }
  const compute = () => classSectionsSourceCompute(round, thresholds);
  return typeof cachedByStateRevision === "function"
    ? cachedByStateRevision("classSectionsSource", `${round}|${year}|${thresholds.openingPercent}|${thresholds.divisionPercent}`, compute)
    : compute();
}

function classSectionsSourceCompute(round, thresholds) {
  const data = typeof roundStatusData === "function" ? roundStatusData(round) : null;
  if (!data?.students?.length || typeof aggregateRecords !== "function") return { groups: [], locked: false };
  const locked = typeof isRoundLocked === "function" && isRoundLocked(round);
  const snapshot = locked ? state.roundStatuses?.[round]?.snapshot : null;
  const classBases = snapshot?.classBases || (typeof nextYearClassBases === "function" ? nextYearClassBases() : {});
  const aggregate = aggregateRecords(data.students, data.courses, thresholds.openingPercent, thresholds.divisionPercent,
    data.classOverrides || {}, data.semesterAssignments || {}, data.groupAssignments || {}, classBases, state.roundClosures?.[round] || {});
  const unassignedName = typeof UNASSIGNED_GROUP === "string" ? UNASSIGNED_GROUP : "미분류";
  const snapshotCount = new Map((snapshot?.rows || []).map((row) => [`${row.grade}|${row.semester}|${row.group}|${row.name}`, Number(row.classCount) || 0]));
  const groups = [];
  for (const { summary, semesters } of aggregate.reports) {
    const grade = String(summary.grade);
    const plan = classSectionsPlanSubjects(grade);
    const targetGrade = String(Number(grade) + 1);
    const gradeRecords = data.students.filter((student) => String(student.grade) === grade);
    // 그 현 학년 학생 전체(학급 단위 과목 나이스 행·내년 반 배정표 양식은 신청하지 않은 학생도 대상).
    const gradeStudents = gradeRecords.map((student) => ({ key: classSectionsStudentKey(grade, student.classroom, student.number),
      homeroom: classSectionsKeyPart(student.classroom), number: classSectionsKeyPart(student.number) }));
    for (const semester of semesters) {
      const semesterKey = semester.order === 1 || semester.order === 2 ? String(semester.order) : "";
      if (!semesterKey) continue;
      for (const group of semester.groups) {
        if (group.category === unassignedName || !(Number(group.choiceCount) > 0)) continue;
        const columns = new Map();
        const courses = [];
        for (const course of group.courses) {
          const name = course.subjectName || course.name;
          if (courses.some((item) => item.key === name)) { columns.set(String(course.column), name); continue; }
          const stage4 = snapshot ? (snapshotCount.get(`${grade}|${semesterKey}|${group.category}|${name}`) ?? course.classCount) : course.classCount;
          const planned = plan.lookup(name);
          const area = planned?.area || "";
          const department = typeof hoursDefaultDepartment === "function" ? hoursDefaultDepartment(name, area) : "";
          courses.push({ key: name, name, enrollment: course.enrollment, classCount: Number(stage4) || 0, closed: Boolean(course.closed), department, area,
            planCredits: planned?.credit || 0, credits: 0 });
          columns.set(String(course.column), name);
        }
        const credits = new Map();
        const students = [];
        for (const student of gradeRecords) {
          const picked = [];
          for (const selection of student.selections || []) {
            const key = columns.get(String(selection.column));
            if (!key || picked.includes(key)) continue;
            picked.push(key);
            const value = Number(selection.credits);
            if (value > 0) credits.set(key, value);
          }
          if (picked.length) students.push({ key: classSectionsStudentKey(grade, student.classroom, student.number), homeroom: classSectionsKeyPart(student.classroom), number: classSectionsKeyPart(student.number), courses: picked });
        }
        for (const course of courses) course.credits = credits.get(course.key) || course.planCredits || 0;
        // 학급 수 기준은 내년 학급 수(4단계 기준 설정·확정 스냅샷). 없을 때만 지금 명단의 반 수.
        const rosterClasses = new Set(gradeStudents.map((student) => student.homeroom)).size;
        const nextClasses = Number(classBases?.[targetGrade]) || 0;
        const classes = nextClasses || rosterClasses || Number(summary.classes) || 0;
        groups.push({ key: `${grade}:${semesterKey}:${group.category}`, grade, targetGrade, semester: semesterKey, category: group.category,
          choice: Number(group.choiceCount), classes, rosterClasses, nextClasses, courses, students, gradeStudents,
          label: `현${grade} → ${targetGrade}학년 ${semesterKey}학기 · ${group.category}` });
      }
    }
  }
  // 현 학년별로 묶고 그 안에서 학기 순(현1 → 2-1 택3, 2-1 택1, 2-2 …; 현2 → …).
  const choiceOf = (group) => -group.choice;
  groups.sort((a, b) => a.grade.localeCompare(b.grade) || a.semester.localeCompare(b.semester) || choiceOf(a) - choiceOf(b) || a.category.localeCompare(b.category, "ko"));
  return { groups, locked, maxClassSize: Number(snapshot?.maxClassSize) || Number($("#maxClassSize")?.value) || 34 };
}

function classSectionsParseTimes(text) {
  return String(text || "").split(/[,\s/]+/).map((item) => item.trim()).filter(Boolean)
    .map((item) => item.match(/^([월화수목금토])\s*:?\s*(\d{1,2})$/)).filter(Boolean)
    .map((match) => ({ day: match[1], period: Number(match[2]) }));
}

function classSectionsTimesText(times) {
  return (times || []).map((time) => (typeof time === "string" ? time.replace(":", "") : `${time.day}${time.period}`)).join(",");
}

// 학급 단위 과목은 이동 블록에서 빠지므로, 학생이 고른 학급 단위 과목 수(가장 많은 학생 기준)만큼 블록 수를 줄여 제안한다.
function classSectionsSuggestedBlocks(group, settings = classSectionsSettings()) {
  const classUnit = new Set(group.courses.filter((course) => classSectionsCourseConf(settings, "courseModes", group.grade)[course.key] === "class").map((course) => course.key));
  if (!classUnit.size) return { blocks: group.choice, removed: 0 };
  const removed = group.students.reduce((max, student) => Math.max(max, student.courses.filter((key) => classUnit.has(key)).length), 0);
  return { blocks: Math.max(1, group.choice - removed), removed };
}

function classSectionsGroupSettings(source, group, entry) {
  return {
    capacity: Number(entry.defaultCapacity) || source.maxClassSize || 34,
    blocks: Number(entry.blocks) || classSectionsSuggestedBlocks(group).blocks,
    maxSectionsPerBlock: Number(entry.maxSectionsPerBlock) || group.classes || 0
  };
}

// 담임반 묶기 기준 반: 내년 반 배정표가 있으면 새 반(없는 학생은 '미정'), 없으면 지금 반.
function classSectionsHomeroomStudents(group) {
  const { map } = classSectionsEffectiveClassMap(group);
  if (!map) return group.students;
  return group.students.map((student) => ({ ...student, homeroom: String(map[student.key]?.classroom || "미정") }));
}

function classSectionsTeacherList(settings) {
  // 이름(또는 별칭)을 아직 안 넣은 줄(방금 추가한 빈 줄)은 빼고 센다.
  return settings.teachers.filter((teacher) => teacher && (teacher.name || teacher.alias)).map((teacher, index) => ({
    id: String(teacher.id || `t${index + 1}`), name: String(teacher.alias || teacher.name || teacher.id), departments: teacher.department ? [teacher.department] : [],
    courses: String(teacher.courses || "").split(/[,·]/).map((item) => item.trim()).filter(Boolean),
    unavailable: (teacher.unavailable || []).map((slot) => ({ ...classSectionsParseTimes(slot)[0], reason: teacher.reason || "" })).filter((slot) => slot.day)
  }));
}

function classSectionsBuildInput(round, group, entry, extra = {}) {
  const settings = classSectionsSettings();
  const source = classSectionsSource(round);
  const base = classSectionsGroupSettings(source, group, entry);
  const blocks = Array.from({ length: Math.max(1, Math.min(10, base.blocks)) }, (_, index) => {
    const letter = "abcdefghij"[index];
    return { id: letter, maxSections: Number(entry.blockMax[letter]) || base.maxSectionsPerBlock || undefined, times: classSectionsParseTimes(entry.blockTimes[letter]) };
  });
  const courses = group.courses.map((course) => {
    const sections = entry.classCounts[course.key] !== undefined ? Number(entry.classCounts[course.key]) || 0 : course.classCount;
    const capacities = String(entry.capacities[course.key] || "").split(/[,\s]+/).map(Number).filter((value) => value > 0);
    return { key: course.key, name: course.name, sections, capacity: base.capacity, capacities,
      department: classSectionsCourseConf(settings, "courseDepartments", group.grade)[course.key] || course.department, room: classSectionsCourseConf(settings, "courseRooms", group.grade)[course.key] || "",
      credits: course.credits, mode: classSectionsCourseConf(settings, "courseModes", group.grade)[course.key] === "class" ? "class" : "move" };
  });
  const teachers = classSectionsTeacherList(settings);
  let departmentTeachers = null;
  if (!teachers.length && settings.useHoursTeachers && typeof hoursSettings === "function" && typeof hoursTargetYear === "function") {
    const counts = hoursSettings(hoursTargetYear()).teachers || {};
    const used = Object.entries(counts).filter(([, value]) => Number(value) > 0);
    if (used.length) departmentTeachers = Object.fromEntries(used.map(([key, value]) => [key, Number(value)]));
  }
  // 같은 차수·학기의 다른 그룹(다른 학년) 결과가 차지한 교사·교과·특별실(블록 시간이 있을 때만).
  const occupied = [];
  const store = classSectionsStore()[round] || {};
  const { noOccupied, ...rest } = extra;
  for (const other of noOccupied ? [] : source.groups) {
    if (other.key === group.key || other.semester !== group.semester) continue;
    const result = store[other.key]?.sectionResult;
    if (!result?.blocks) continue;
    const otherSettings = classSectionsSettings();
    for (const block of result.blocks) {
      if (!block.times?.length) continue;
      const departments = {};
      const teacherIds = [];
      for (const id of block.sectionIds || []) {
        const section = result.sections.find((item) => item.id === id);
        if (!section) continue;
        const department = classSectionsCourseConf(otherSettings, "courseDepartments", other.grade)[section.courseKey] || other.courses.find((course) => course.key === section.courseKey)?.department || "";
        if (department) departments[department] = (departments[department] || 0) + 1;
        if (section.teacherId) teacherIds.push(section.teacherId);
      }
      occupied.push({ label: `${other.label} ${block.letter}블록`, times: block.times, departments: teachers.length ? {} : departments, teacherIds });
    }
  }
  // 같은 현 학년·학기의 다른 그룹(같은 학생) 블록 시간: 겹치면 검증기가 오류로 알린다.
  const cohortTimes = [];
  for (const other of source.groups) {
    if (other.key === group.key || other.grade !== group.grade || other.semester !== group.semester) continue;
    const otherEntry = classSectionsEntry(round, other.key, false);
    for (const [letter, text] of Object.entries(otherEntry?.blockTimes || {})) {
      const times = classSectionsParseTimes(text);
      if (times.length) cohortTimes.push({ label: `${other.label} ${letter}블록`, times });
    }
  }
  const fixedSlots = settings.fixedSlots.map((slot) => ({ label: slot.label, times: classSectionsParseTimes(slot.times),
    teacherIds: slot.allTeachers ? teachers.map((teacher) => teacher.id) : [] })).filter((slot) => slot.times.length);
  const rooms = Object.keys(settings.rooms).length ? Object.fromEntries(Object.entries(settings.rooms).map(([key, value]) => [key, Number(value) || 0])) : null;
  return {
    groupId: `${round}:${group.key}`, label: group.label, grade: group.grade, targetGrade: group.targetGrade, semester: group.semester,
    blocks, maxSectionsPerBlock: base.maxSectionsPerBlock || undefined, defaultCapacity: base.capacity,
    courses, students: classSectionsHomeroomStudents(group), cohortTimes, teachers, departmentTeachers, rooms, occupied, fixedSlots, spreadWarn: settings.spreadWarn,
    homeroomBasis: classSectionsEffectiveClassMap(group).map ? "next" : "current", recommendExclude: classSectionsEffectiveClassMap(group).map ? [] : ["homeroom"],
    mode: entry.mode || "move", seed: Number(entry.seed) || 1,
    pins: { sections: { ...entry.pins.sections }, students: { ...entry.pins.students }, teachers: { ...entry.pins.teachers } },
    ...rest
  };
}

// ---- 계산(Worker, 실패하면 메인 스레드) ----
function classSectionsRunSolver(request) {
  if (!CLASS_SECTIONS_VIEW.workerFailed && typeof Worker === "function" && typeof classSectionsWorkerSource === "function") {
    try {
      if (!CLASS_SECTIONS_VIEW.worker) {
        const url = URL.createObjectURL(new Blob([classSectionsWorkerSource()], { type: "text/javascript" }));
        CLASS_SECTIONS_VIEW.worker = new Worker(url);
      }
      const worker = CLASS_SECTIONS_VIEW.worker;
      const id = `${Date.now()}-${Math.random()}`;
      return new Promise((resolve, reject) => {
        const done = (event) => {
          if (event.data?.id !== id) return;
          worker.removeEventListener("message", done);
          worker.removeEventListener("error", failed);
          if (event.data.ok) resolve(event.data.value);
          else reject(new Error(event.data.error));
        };
        const failed = () => {
          worker.removeEventListener("message", done);
          worker.removeEventListener("error", failed);
          CLASS_SECTIONS_VIEW.workerFailed = true;
          CLASS_SECTIONS_VIEW.worker = null;
          classSectionsRunSolver(request).then(resolve, reject);
        };
        worker.addEventListener("message", done);
        worker.addEventListener("error", failed);
        worker.postMessage(JSON.parse(JSON.stringify({ ...request, id })));
      });
    } catch {
      CLASS_SECTIONS_VIEW.workerFailed = true;
    }
  }
  return new Promise((resolve, reject) => setTimeout(() => {
    try { resolve(classSectionsRun(JSON.parse(JSON.stringify(request)))); } catch (error) { reject(error); }
  }, 30));
}

function classSectionsCompactResult(result, input, draft) {
  return {
    version: result.version, signature: classSectionsSignature(input), createdAt: new Date().toISOString(), draft: Boolean(draft),
    mode: result.mode, seed: result.seed, blocks: result.blocks, sections: result.sections, assign: result.assign, unassigned: result.unassigned,
    metrics: result.metrics, explain: result.explain, teacherOf: result.teacherOf || {}, placement: result.placement,
    issues: (result.issues || []).slice(0, 200), elapsedMs: result.elapsedMs, roomRenames: result.roomRenames || []
  };
}

async function classSectionsSolveCurrent(kind = "solve") {
  const context = classSectionsCurrent();
  if (!context || CLASS_SECTIONS_VIEW.running) return;
  const { round, group, entry, source } = context;
  const scope = { round, group: group.key };
  const previous = entry.sectionResult;
  let input;
  if (kind === "partial" && previous?.assign) {
    const before = classSectionsPlain(entry.inputStudents) ? Object.entries(entry.inputStudents).map(([key, courses]) => ({ key, courses })) : [];
    input = classSectionsBuildInput(round, group, entry, { partial: true, roomNames: classSectionsPreviousRoomNames(previous),
      previous: { sections: previous.sections.map((section) => ({ id: section.id, blockId: section.blockId })), assign: previous.assign, teacherOf: previous.teacherOf },
      changedStudents: before.length ? classSectionsChangedStudents(before, group.students) : group.students.map((student) => student.key) });
  } else {
    // 새로 계산: 기존 결과는 '기존 대비 이동' 비교에만 쓴다(배정을 붙잡지 않음). 그대로 두려면 '바뀐 학생만 다시 계산'.
    // 블록 고정이 있으면 고정한 분반의 이름이 바뀌지 않게 기존 이름을 넘긴다.
    const keepNames = Object.keys(entry.pins.sections || {}).length ? { roomNames: classSectionsPreviousRoomNames(previous) } : {};
    input = classSectionsBuildInput(round, group, entry, { ...keepNames, ...(previous?.assign ? { baseline: { assign: previous.assign } } : {}) });
  }
  CLASS_SECTIONS_VIEW.running = true;
  classSectionsSetStatus(kind === "compare" ? "편성 방식 3가지를 계산하는 중…" : "분반 편성을 계산하는 중…", false, scope);
  renderClassSections();
  try {
    if (kind === "compare") {
      const compared = await classSectionsRunSolver({ kind: "compare", input });
      const pick = compared.results[compared.recommended] || compared.results.move;
      CLASS_SECTIONS_VIEW.compare = { groupKey: group.key, round, rows: compared.rows, recommended: compared.recommended, reason: compared.reason, results: compared.results, input,
        baselineAt: previous?.createdAt || "" };
      entry.mode = compared.recommended;
      classSectionsSaveResult(entry, pick, { ...input, mode: compared.recommended }, group, source);
      classSectionsSetStatus(`편성 방식 비교 완료 · 추천: ${CLASS_SECTIONS_MODE_LABELS[compared.recommended]}`, false, scope);
    } else {
      const result = await classSectionsRunSolver({ kind: "solve", input });
      classSectionsSaveResult(entry, result, input, group, source);
      classSectionsSetStatus(result.explain.feasible ? `편성 완료 · ${result.explain.summary}` : `편성 결과 확인 필요 · ${result.explain.summary}`, !result.explain.feasible, scope);
    }
  } catch (error) {
    classSectionsSetStatus(`편성 계산 실패: ${error?.message || error}`, true, scope);
  } finally {
    CLASS_SECTIONS_VIEW.running = false;
    if (typeof persistStateSoon === "function") persistStateSoon(); else if (typeof persistState === "function") persistState();
    renderClassSections();
  }
}

// 함께 배정한 교사·그룹 간 이슈: 원인 그룹(분반이 실제 속한 그룹, issue.groups·분반 id 접두 '그룹id::')에만 오류로 붙이고,
// 같은 학기 다른 그룹에는 '참고'(severity info)로만 붙인다 — 배정이 다 된 그룹이 다른 그룹 교사 부족 때문에 '불가'가 되지 않게.
function classSectionsJointIssuesFor(issues, groupId) {
  const prefix = `${groupId}::`;
  const own = [];
  for (const issue of issues) {
    const mine = Array.isArray(issue.groups) ? issue.groups.includes(groupId)
      : issue.sectionId ? String(issue.sectionId).startsWith(prefix) : issue.severity !== "error";
    if (mine) own.push(issue);
  }
  // 다른 그룹이 원인인 오류는 저장하지 않는다. 화면이 그릴 때 그 그룹의 지금 결과에서 '참고'로 보여 준다
  // (원인 그룹을 고쳐 다시 계산하면 참고도 함께 사라지게).
  return own;
}

// 같은 차수·학기의 모든 그룹(학년)을 함께 푼다(classSectionsSolveAll). 그룹 순서는 화면 순서(학기·학년·그룹)로 고정이라
// 어느 그룹 화면에서 누르든 결과가 같다. 교사는 모든 그룹을 함께 배정한다.
async function classSectionsSolveSemesterCurrent() {
  const context = classSectionsCurrent();
  if (!context?.group || CLASS_SECTIONS_VIEW.running) return;
  const { round, source, group } = context;
  const scope = { round, group: group.key };
  const groups = source.groups.filter((item) => item.semester === group.semester);
  const inputs = groups.map((item) => {
    const entry = classSectionsEntry(round, item.key, true);
    const previous = entry.sectionResult;
    const keepNames = Object.keys(entry.pins.sections || {}).length ? { roomNames: classSectionsPreviousRoomNames(previous) } : {};
    return classSectionsBuildInput(round, item, entry, { noOccupied: true, ...keepNames, ...(previous?.assign ? { baseline: { assign: previous.assign } } : {}) });
  });
  CLASS_SECTIONS_VIEW.running = true;
  classSectionsSetStatus(`${group.semester}학기 그룹 ${groups.length}개를 함께 계산하는 중…`, false, scope);
  renderClassSections();
  try {
    const all = await classSectionsRunSolver({ kind: "solveAll", input: { groups: inputs, teachers: inputs[0]?.teachers || [], seed: inputs[0]?.seed || 1 } });
    let problems = 0;
    const batch = `all-${new Date().toISOString()}`;
    all.groups.forEach((item, index) => {
      const result = item.result;
      const own = classSectionsJointIssuesFor(all.issues || [], inputs[index].groupId);
      result.issues = [...(result.issues || []), ...own];
      const hard = result.issues.filter((issue) => issue.severity === "error" && issue.type !== "unassigned");
      if (hard.length && result.explain?.feasible) {
        result.explain = { ...result.explain, feasible: false,
          summary: `${result.unassigned.length ? result.explain.summary : "학생은 모두 배정했지만 확인 필요 —"} 오류 ${hard.length}건: ${hard.slice(0, 2).map((issue) => issue.message).join(" / ")}` };
      }
      // 함께 계산에서 생긴 학년 간 교사 부족: 블록 시간 추천 실행·교사 수 확인 제안을 붙인다.
      if (own.some((issue) => issue.type === "teacher-shortage" && issue.severity === "error")) {
        const extra = [{ type: "recommend-times", verified: false, message: "블록 시간 추천을 실행해 다른 학년 블록과 같은 교과 교사가 겹치지 않는 시간으로 바꿔 보세요." },
          { type: "check-teachers", verified: false, message: `교사 명단·5단계 교사 수를 확인하세요: ${[...new Set(own.filter((issue) => issue.type === "teacher-shortage").map((issue) => issue.department))].join(", ")} 교사가 그 시간에 모자랍니다.` }];
        const have = new Set((result.explain?.suggestions || []).map((item) => item.type));
        result.explain = { ...result.explain, suggestions: [...(result.explain?.suggestions || []), ...extra.filter((item) => !have.has(item.type))] };
      }
      if (!result.explain?.feasible) problems += 1;
      classSectionsSaveResult(classSectionsEntry(round, groups[index].key, true), result, inputs[index], groups[index], source, batch);
    });
    const orderText = (all.orders || []).length > 1 ? ` · 순서 ${all.orders.length}가지 비교 → ‘${all.chosenOrder}’` : "";
    const shortText = (all.shortages || []).length ? ` · 교사 부족 ${all.shortages.length}곳(예: ${all.shortages[0].message})` : "";
    classSectionsSetStatus(`${group.semester}학기 전 학년 ${groups.length}개 그룹을 함께 다시 계산했습니다${problems ? ` · 확인 필요 ${problems}개` : " · 모두 배정"}${orderText}${shortText}.`, problems > 0 || Boolean(shortText), scope);
  } catch (error) {
    classSectionsSetStatus(`함께 계산 실패: ${error?.message || error}`, true, scope);
  } finally {
    CLASS_SECTIONS_VIEW.running = false;
    if (typeof persistStateSoon === "function") persistStateSoon(); else if (typeof persistState === "function") persistState();
    renderClassSections();
  }
}

// ---- 블록 시간 추천 ----
// 블록마다 교과별 분반 수: 저장된 편성 결과가 있으면 그 블록의 분반, 없으면 과목 분반을 블록에 고르게 나눈 추정.
function classSectionsBlockDemand(round, group, entry, settings) {
  const source = classSectionsSource(round);
  const base = classSectionsGroupSettings(source, group, entry);
  const letters = Array.from({ length: base.blocks }, (_, index) => "abcdefghij"[index]);
  const departmentOf = (key) => classSectionsCourseConf(settings, "courseDepartments", group.grade)[key] || group.courses.find((course) => course.key === key)?.department || "";
  const result = entry.sectionResult;
  const demand = Object.fromEntries(letters.map((letter) => [letter, {}]));
  if (result?.blocks?.length === letters.length) {
    for (const block of result.blocks) for (const id of block.sectionIds) {
      const section = result.sections.find((item) => item.id === id);
      const dept = section ? departmentOf(section.courseKey) : "";
      if (dept && demand[block.id]) demand[block.id][dept] = (demand[block.id][dept] || 0) + 1;
    }
  } else {
    let turn = 0;
    for (const course of group.courses) {
      if (classSectionsCourseConf(settings, "courseModes", group.grade)[course.key] === "class") continue;
      const count = entry.classCounts[course.key] !== undefined ? Number(entry.classCounts[course.key]) || 0 : course.classCount;
      const dept = departmentOf(course.key);
      for (let k = 0; k < count; k += 1) {
        const letter = letters[(turn + k) % letters.length];
        if (dept) demand[letter][dept] = (demand[letter][dept] || 0) + 1;
      }
      turn += count;
    }
  }
  const hours = Math.max(...group.courses.map((course) => Number(course.credits) || 0), 0) || 3;
  return letters.map((letter) => ({ id: letter, hours, departments: demand[letter] }));
}

async function classSectionsRecommendTimesCurrent() {
  const context = classSectionsCurrent();
  if (!context?.group || CLASS_SECTIONS_VIEW.running) return;
  const { round, source, group } = context;
  const scope = { round, group: group.key };
  const settings = classSectionsSettings();
  const groups = source.groups.filter((item) => item.semester === group.semester);
  const teachers = classSectionsTeacherList(settings);
  const sample = classSectionsBuildInput(round, group, context.entry, { noOccupied: true });
  const spec = {
    days: settings.gridDays.split(","), periods: settings.gridPeriods, seed: Number(context.entry.seed) || 1, reserve: { ...settings.reserve },
    teachers, departmentTeachers: sample.departmentTeachers, fixedSlots: sample.fixedSlots,
    groups: groups.map((item) => ({ groupId: item.key, label: item.label, grade: item.targetGrade, blocks: classSectionsBlockDemand(round, item, classSectionsEntry(round, item.key, true), settings) }))
  };
  CLASS_SECTIONS_VIEW.running = true;
  classSectionsSetStatus(`${group.semester}학기 블록 ${spec.groups.reduce((sum, item) => sum + item.blocks.length, 0)}개의 시간을 추천하는 중…`, false, scope);
  renderClassSections();
  try {
    const result = await classSectionsRunSolver({ kind: "recommendTimes", input: spec });
    CLASS_SECTIONS_VIEW.timesProposal = { round, semester: group.semester, result, edits: {},
      labels: Object.fromEntries(groups.map((item) => [item.key, item.label])) };
    classSectionsSetStatus(`블록 시간 추천 완료${result.shortages.length ? ` · 교사 부족 ${result.shortages.length}곳` : " · 교사 부족 없음"}. 칸을 고친 뒤 ‘추천 적용’을 누르세요.`, result.shortages.length > 0, scope);
  } catch (error) {
    classSectionsSetStatus(`블록 시간 추천 실패: ${error?.message || error}`, true, scope);
  } finally {
    CLASS_SECTIONS_VIEW.running = false;
    renderClassSections();
  }
}

function classSectionsTimesProposalHtml(round, source, group) {
  const proposal = CLASS_SECTIONS_VIEW.timesProposal;
  if (!proposal || proposal.round !== round || proposal.semester !== group.semester) return "";
  const esc = classSectionsEsc;
  const rows = proposal.result.groups.flatMap((item) => item.blocks.map((block) => {
    const key = `${item.groupId}|${block.id}`;
    const value = proposal.edits[key] ?? classSectionsTimesText(block.times);
    return `<tr${item.groupId === group.key ? ' class="is-current"' : ""}><th scope="row">${esc(proposal.labels[item.groupId] || item.groupId)}</th><td>${esc(block.id)}블록</td>
      <td><input class="cs-text cs-wide" type="text" value="${esc(value)}" data-cs-proposal="${esc(key)}" data-focus-key="cs-proposal-${esc(key)}" aria-label="${esc(proposal.labels[item.groupId] || item.groupId)} ${esc(block.id)}블록 추천 시간"></td></tr>`;
  })).join("");
  const free = Object.entries(proposal.result.free || {}).map(([grade, count]) => `${grade}학년 남는 칸 ${count}개`).join(" · ");
  const shortages = proposal.result.shortages.slice(0, 12).map((item) => `<li>${esc(item.message)}</li>`).join("");
  const issues = proposal.result.issues.slice(0, 12).map((item) => `<li>${esc(item.message)}</li>`).join("");
  return `<div class="cs-proposal" id="classSectionsTimesProposal" aria-label="블록 시간 추천안">
    <h5>블록 시간 추천안 <span class="cs-note">${esc(free)} (학교 지정·학급 단위 과목용)</span></h5>
    ${shortages ? `<ul class="cs-list is-error">${shortages}</ul>` : '<p class="cs-note">학년 간 같은 시각 같은 교과 분반 합이 교사 수를 넘는 곳이 없습니다.</p>'}
    ${issues ? `<ul class="cs-list">${issues}</ul>` : ""}
    <table class="cs-table"><thead><tr><th>그룹</th><th>블록</th><th>추천 시간(고칠 수 있음)</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="cs-actions"><button class="button button-primary" id="classSectionsApplyTimes" type="button">추천 적용</button>
      <button class="button" id="classSectionsDiscardTimes" type="button">추천 닫기</button></div></div>`;
}

function classSectionsApplyTimes() {
  const proposal = CLASS_SECTIONS_VIEW.timesProposal;
  if (!proposal) return;
  let count = 0;
  for (const item of proposal.result.groups) {
    const entry = classSectionsEntry(proposal.round, item.groupId, true);
    for (const block of item.blocks) {
      const key = `${item.groupId}|${block.id}`;
      entry.blockTimes[block.id] = proposal.edits[key] ?? classSectionsTimesText(block.times);
      count += 1;
    }
  }
  CLASS_SECTIONS_VIEW.timesProposal = null;
  classSectionsSetStatus(`블록 ${count}개에 시간을 넣었습니다. ‘전 학년 함께 다시 계산’으로 교사 배정을 다시 하세요.`);
  classSectionsChanged();
}

// 앞 결과의 분반 id → 강의실 이름(나이스·명렬표에 이미 쓴 이름을 유지하려고 계산에 넘김).
function classSectionsPreviousRoomNames(previous) {
  return Object.fromEntries((previous?.sections || []).filter((section) => section.roomName).map((section) => [section.id, section.roomName]));
}

function classSectionsSaveResult(entry, result, input, group, source, batch = "") {
  entry.sectionResult = classSectionsCompactResult(result, input, !source.locked);
  entry.sectionResult.batch = batch || entry.sectionResult.createdAt;
  entry.inputStudents = Object.fromEntries(group.students.map((student) => [student.key, student.courses.slice()]));
}

// 상태 문구는 그 문구를 만든 차수·그룹에서만 보인다(그룹을 바꾸면 다른 그룹 결과 문구가 남지 않게).
function classSectionsSetStatus(text, error = false, scope = null) {
  CLASS_SECTIONS_VIEW.status = { text, error, round: scope?.round ?? CLASS_SECTIONS_VIEW.round, group: scope?.group ?? CLASS_SECTIONS_VIEW.group };
  if (scope && (scope.round !== CLASS_SECTIONS_VIEW.round || scope.group !== CLASS_SECTIONS_VIEW.group)) return;
  const box = typeof document !== "undefined" ? document.getElementById("classSectionsStatus") : null;
  if (box) { box.textContent = text; box.dataset.state = error ? "error" : "ok"; }
}

function classSectionsCurrent() {
  const rounds = classSectionsRoundChoices();
  if (!rounds.length) return null;
  if (!rounds.includes(CLASS_SECTIONS_VIEW.round)) CLASS_SECTIONS_VIEW.round = classSectionsDefaultRound();
  const round = CLASS_SECTIONS_VIEW.round;
  const source = classSectionsSource(round);
  if (!source.groups.length) return { round, source, group: null, entry: null };
  if (!source.groups.some((group) => group.key === CLASS_SECTIONS_VIEW.group)) CLASS_SECTIONS_VIEW.group = source.groups[0].key;
  const group = source.groups.find((item) => item.key === CLASS_SECTIONS_VIEW.group);
  return { round, source, group, entry: classSectionsEntry(round, group.key, true) };
}

// ---- 그리기 ----
function renderClassSections() {
  if (typeof deferRenderUntilStepVisible === "function" && deferRenderUntilStepVisible(8, "renderClassSections", renderClassSections)) return;
  if (typeof preserveViewDuring === "function") return preserveViewDuring(["#workflowStep8Panel", "#classSectionsTeacherDialog"], renderClassSectionsView);
  return renderClassSectionsView();
}

function renderClassSectionsView() {
  const panel = document.getElementById("classSectionsContent");
  if (!panel) return;
  const esc = classSectionsEsc;
  const rounds = classSectionsRoundChoices();
  const select = document.getElementById("classSectionsRound");
  if (!rounds.length) {
    if (select) select.innerHTML = "";
    panel.innerHTML = `<p class="cs-empty">수강신청 결과가 있는 차수가 없습니다. 2단계에서 결과를 반영하고 4단계에서 개설 과목·분반 수를 확정한 뒤 분반을 편성하세요.</p>`;
    return;
  }
  const context = classSectionsCurrent();
  if (select) {
    select.innerHTML = rounds.map((round) => `<option value="${esc(round)}"${round === context.round ? " selected" : ""}>${esc(round)}차${typeof isRoundLocked === "function" && isRoundLocked(round) ? " (확정)" : " (확정 전)"}</option>`).join("");
  }
  const badge = document.getElementById("classSectionsRoundBadge");
  if (badge) {
    badge.textContent = context.source.locked ? `${context.round}차 확정 결과` : `${context.round}차 · 확정 전 시안`;
    badge.dataset.state = context.source.locked ? "done" : "draft";
  }
  if (!context.group) {
    panel.innerHTML = `<p class="cs-empty">${esc(context.round)}차 결과에서 택n 선택 그룹을 찾지 못했습니다. 2단계 그룹 설정(택n)을 확인하세요.</p>`;
    return;
  }
  const { round, source, group, entry } = context;
  const settings = classSectionsSettings();
  const base = classSectionsGroupSettings(source, group, entry);
  const result = entry.sectionResult || null;
  const input = classSectionsBuildInput(round, group, entry);
  const signature = typeof classSectionsSignature === "function" ? classSectionsSignature(input) : "";
  const stale = Boolean(result && result.signature !== signature);
  const groupsHtml = source.groups.map((item) => {
    const saved = classSectionsEntry(round, item.key, false)?.sectionResult;
    const state = !saved ? "미편성" : saved.explain?.feasible ? "편성됨" : "확인 필요";
    return `<button class="cs-group${item.key === group.key ? " is-active" : ""}" type="button" data-cs-group="${esc(item.key)}" aria-pressed="${item.key === group.key}">
      <strong>${esc(item.label)}</strong><span>${item.students.length}명 · 과목 ${item.courses.length} · 택${item.choice}</span><em data-state="${saved ? (saved.explain?.feasible ? "done" : "warn") : "wait"}">${state}</em></button>`;
  }).join("");
  const courseRows = group.courses.map((course) => {
    const sections = entry.classCounts[course.key] !== undefined ? Number(entry.classCounts[course.key]) || 0 : course.classCount;
    const differs = sections !== course.classCount;
    const department = classSectionsCourseConf(settings, "courseDepartments", group.grade)[course.key] || course.department;
    const deptOptions = (typeof HOURS_DEPARTMENTS !== "undefined" ? HOURS_DEPARTMENTS : []).map((item) =>
      `<option value="${esc(item.id)}"${item.id === department ? " selected" : ""}>${esc(typeof hoursDepartmentName === "function" ? hoursDepartmentName(item.id) : item.id)}</option>`).join("");
    const key = esc(course.key);
    return `<tr${differs ? ' class="is-changed"' : ""}>
      <th scope="row">${esc(course.name)}${course.closed ? ' <span class="cs-tag">폐강</span>' : ""}</th>
      <td>${course.enrollment}</td>
      <td>${course.classCount}</td>
      <td><input class="cs-num" type="number" min="0" max="30" value="${sections}" data-cs-sections="${key}" data-focus-key="cs-sections-${key}" aria-label="${key} 6단계 분반 수">${differs ? `<span class="cs-diff" title="4단계 확정 ${course.classCount}개">4단계와 다름</span>` : ""}</td>
      <td><input class="cs-text" type="text" inputmode="numeric" value="${esc(entry.capacities[course.key] || "")}" placeholder="${base.capacity}" data-cs-capacities="${key}" data-focus-key="cs-cap-${key}" aria-label="${key} 분반별 정원(쉼표로 구분)"></td>
      <td><select data-cs-mode="${key}" data-focus-key="cs-mode-${key}" aria-label="${key} 운영 방식"><option value="move">이동</option><option value="class"${classSectionsCourseConf(settings, "courseModes", group.grade)[course.key] === "class" ? " selected" : ""}>학급 단위</option></select></td>
      <td><select data-cs-dept="${key}" data-focus-key="cs-dept-${key}" aria-label="${key} 담당 교과">${deptOptions}</select></td>
      <td><input class="cs-text" type="text" value="${esc(classSectionsCourseConf(settings, "courseRooms", group.grade)[course.key] || "")}" placeholder="없음" data-cs-room="${key}" data-focus-key="cs-room-${key}" aria-label="${key} 특별실"></td>
    </tr>`;
  }).join("");
  const blockRows = Array.from({ length: base.blocks }, (_, index) => {
    const letter = "abcdefghij"[index];
    return `<tr><th scope="row">${letter}블록</th>
      <td><input class="cs-num" type="number" min="1" max="40" value="${esc(entry.blockMax[letter] || "")}" placeholder="${base.maxSectionsPerBlock || ""}" data-cs-block-max="${letter}" data-focus-key="cs-block-max-${letter}" aria-label="${letter}블록 최대 분반"></td>
      <td><input class="cs-text cs-wide" type="text" value="${esc(entry.blockTimes[letter] || "")}" placeholder="예: 월1,수2,금3" data-cs-block-times="${letter}" data-focus-key="cs-block-times-${letter}" aria-label="${letter}블록 요일·교시"></td></tr>`;
  }).join("");
  const sum = group.courses.reduce((total, course) => total + (entry.classCounts[course.key] !== undefined ? Number(entry.classCounts[course.key]) || 0 : course.classCount), 0);
  const limit = base.maxSectionsPerBlock ? base.maxSectionsPerBlock * base.blocks : 0;
  const modeOptions = CLASS_SECTIONS_MODE_OPTIONS.map(([value, label]) => `<option value="${value}"${(entry.mode || "move") === value ? " selected" : ""}>${label}</option>`).join("");
  const statusHere = CLASS_SECTIONS_VIEW.status && CLASS_SECTIONS_VIEW.status.round === round && CLASS_SECTIONS_VIEW.status.group === group.key ? CLASS_SECTIONS_VIEW.status : null;
  const teacherNote = classSectionsTeacherNote(settings, group, input);
  panel.innerHTML = `
    <div class="cs-groups" role="group" aria-label="편성할 그룹">${groupsHtml}</div>
    <div class="cs-badges">
      ${source.locked ? "" : '<span class="cs-badge" data-state="draft">확정 전 시안</span>'}
      ${stale ? '<span class="cs-badge" data-state="stale" id="classSectionsStale">입력 변경됨, 재계산 필요</span>' : ""}
      <span class="cs-note">${esc(teacherNote)}</span>
    </div>
    <section class="cs-card" aria-label="편성 기준">
      <h4>기준</h4>
      <div class="cs-fields">
        <label>기본 정원 <input class="cs-num" type="number" min="1" max="60" value="${base.capacity}" data-cs-field="defaultCapacity" data-focus-key="cs-capacity" aria-label="분반 기본 정원"></label>
        <label>블록 수 <input class="cs-num" type="number" min="1" max="10" value="${base.blocks}" data-cs-field="blocks" data-focus-key="cs-blocks" aria-label="블록 수"></label>
        ${(() => { const hint = classSectionsSuggestedBlocks(group, settings); return hint.removed ? `<span class="cs-note${Number(entry.blocks) && Number(entry.blocks) !== hint.blocks ? " is-warn" : ""}" id="classSectionsBlocksHint">학급 단위 과목 ${hint.removed}개를 빼면 블록 ${hint.blocks}개(택${group.choice} − ${hint.removed}) 제안${Number(entry.blocks) && Number(entry.blocks) !== hint.blocks ? ` · 지금 ${entry.blocks}개로 직접 입력됨` : ""}</span>` : ""; })()}
        <label>블록당 최대 분반 <input class="cs-num" type="number" min="1" max="40" value="${base.maxSectionsPerBlock || ""}" data-cs-field="maxSectionsPerBlock" data-focus-key="cs-max" aria-label="블록당 최대 분반 수"></label>
        <label>편성 방식 <select data-cs-field="mode" data-focus-key="cs-mode" aria-label="편성 방식">${modeOptions}</select></label>
        <span class="cs-note${limit && sum > limit ? " is-warn" : ""}">분반 합 ${sum}개${limit ? ` / 블록 ${base.blocks}개 × ${base.maxSectionsPerBlock}개 = ${limit}개` : ""}</span>
      </div>
      ${classSectionsClassesHtml(group, entry)}
      <details class="cs-advanced"${Object.keys(entry.blockMax).length || Object.keys(entry.blockTimes).length || CLASS_SECTIONS_VIEW.timesProposal ? " open" : ""}>
        <summary>블록별로 다르게 · 블록 시간(요일·교시)</summary>
        <p class="cs-note">블록 시간을 넣으면 교사 불가 시간·다른 학년 블록과의 겹침을 점검합니다. 블록 시수 = 과목 학점.</p>
        <table class="cs-table"><thead><tr><th>블록</th><th>최대 분반</th><th>요일·교시</th></tr></thead><tbody>${blockRows}</tbody></table>
        <div class="cs-actions"><button class="button" id="classSectionsRecommendTimes" type="button" title="이 학기 모든 학년 그룹의 블록에 요일·교시를 추천합니다(고정 시간·교사 불가 시간·학년 간 교사 수 고려)"${CLASS_SECTIONS_VIEW.running ? " disabled" : ""}>블록 시간 추천</button>
          <span class="cs-note">한 주 ${esc(settings.gridDays)} × ${settings.gridPeriods}교시 격자(교사·시간 설정에서 바꿈). 전체 시간표가 아니라 블록 칸만 정합니다.</span></div>
        ${classSectionsTimesProposalHtml(round, source, group)}
      </details>
      <div class="cs-scroll" data-scroll-key="cs-courses"><table class="cs-table">
        <thead><tr><th>과목</th><th>신청</th><th>4단계 분반</th><th>6단계 분반</th><th>분반별 정원</th><th>운영</th><th>담당 교과</th><th>특별실</th></tr></thead>
        <tbody>${courseRows}</tbody></table></div>
      <div class="cs-actions">
        <button class="button button-primary" id="classSectionsSolve" type="button"${CLASS_SECTIONS_VIEW.running ? " disabled" : ""}>편성 계산</button>
        <button class="button" id="classSectionsCompare" type="button"${CLASS_SECTIONS_VIEW.running ? " disabled" : ""}>방식 비교·추천</button>
        ${source.groups.filter((item) => item.semester === group.semester).length > 1 ? `<button class="button" id="classSectionsSolveSemester" type="button" title="${group.semester}학기 그룹 ${source.groups.filter((item) => item.semester === group.semester).length}개를 함께 풀어 학년 간 교사 겹침이 편성 순서에 따라 달라지지 않게 합니다"${CLASS_SECTIONS_VIEW.running ? " disabled" : ""}>전 학년 함께 다시 계산</button>` : ""}
        ${result ? `<button class="button" id="classSectionsPartial" type="button"${CLASS_SECTIONS_VIEW.running ? " disabled" : ""}>바뀐 학생만 다시 계산</button>` : ""}
        <span class="cs-status" id="classSectionsStatus" role="status" aria-live="polite" data-state="${statusHere?.error ? "error" : "ok"}">${esc(statusHere?.text || "")}</span>
      </div>
    </section>
    ${classSectionsCompareHtml(group, entry)}
    ${result ? classSectionsResultHtml(round, group, entry, result, settings) : '<p class="cs-empty">아직 편성하지 않았습니다. 기준을 확인하고 ‘편성 계산’을 누르세요.</p>'}
    ${classSectionsClassUnitHtml(group, entry, settings)}`;
}

function classSectionsClassesHtml(group, entry) {
  const esc = classSectionsEsc;
  const uploaded = classSectionsClassMap(group.grade);
  const promotion = classSectionsPromotion(group);
  const mapped = uploaded ? group.students.filter((student) => uploaded[student.key]?.classroom).length : 0;
  const classLine = group.nextClasses
    ? `현 ${group.grade}학년 ${group.rosterClasses}학급 → 내년 ${group.targetGrade}학년 ${group.nextClasses}학급 (블록당 최대 분반·학급 단위 반 수 기본값 = 내년 학급 수)`
    : `내년 ${group.targetGrade}학년 학급 수가 없어 지금 반 수 ${group.rosterClasses}학급으로 잡았습니다. 4단계 기준 설정에서 내년 학급 수를 넣으세요.`;
  let mapLine;
  if (uploaded) mapLine = `내년 반 배정표: ${mapped}/${group.students.length}명 · 담임반 묶기·학급 단위 학생 배정·나이스 반·번호를 새 반 기준으로 합니다.`;
  else if (promotion.value === "same") mapLine = "진급 때 반이 그대로 올라감 · 지금 반을 내년 반으로 보고 담임반 묶기·학급 단위 학생 배정·나이스 반을 정합니다(나이스 번호는 진급 때 다시 매길 수 있어 비움). 배정표를 올리면 그것이 우선입니다.";
  else if (promotion.value === "new") mapLine = "내년 반 배정표 없음 · 진급 때 반을 새로 편성하므로 ‘같은 담임반끼리 묶기’는 지금 반 기준이라 효과가 없어 추천에서 뺍니다. 학급 단위 과목 학생 배정은 배정표를 올린 뒤.";
  else mapLine = "내년 반 배정표 없음 · 진급 때 반이 바뀌면 ‘같은 담임반끼리 묶기’(지금 반 기준)는 효과가 없으므로 추천에서 뺍니다. 반이 그대로 올라가면 ‘진급 때 반 편성’을 ‘그대로 올라감’으로 고르세요.";
  const warnText = promotion.value === "new" ? "지금 반 기준 — 진급 때 반을 새로 편성하므로 효과 없음" : "지금 반 기준 — 진급 때 반이 바뀌면 효과 없음";
  const warn = (entry.mode || "move") === "homeroom" && !uploaded && promotion.value !== "same"
    ? `<p class="cs-note is-warn" id="classSectionsHomeroomWarn">같은 담임반끼리 묶기: ${esc(warnText)}. 내년 반 배정표를 올리면 새 반 기준으로 묶습니다.</p>` : "";
  const options = ["same", "new", "unknown"].map((value) => `<option value="${value}"${promotion.value === value ? " selected" : ""}${promotion.forced && value !== "new" ? " disabled" : ""}>${CLASS_SECTIONS_PROMOTION_LABELS[value]}</option>`).join("");
  return `<p class="cs-note${group.nextClasses ? "" : " is-warn"}" id="classSectionsClassesLine">${esc(classLine)}</p>
    <div class="cs-fields"><label>진급 때 반 편성 <select data-cs-promotion="${esc(group.grade)}" data-focus-key="cs-promotion-${esc(group.grade)}" aria-label="현 ${esc(group.grade)}학년 진급 때 반 편성"${promotion.forced ? ' title="' + esc(promotion.reason) + '"' : ""}>${options}</select></label>
      ${promotion.forced ? `<span class="cs-note" id="classSectionsPromotionReason">${esc(promotion.reason)}</span>` : ""}</div>
    <p class="cs-note" id="classSectionsClassMapLine">${esc(mapLine)}</p>${warn}`;
}

// 교사 수 안내: 무엇으로 블록 분반 수를 제한하는지, 비어 있는 교과는 제한 없이 계산함을 분명히.
function classSectionsTeacherNote(settings, group, input) {
  const label = (id) => (typeof hoursDepartmentName === "function" ? hoursDepartmentName(id) : id);
  const departments = [...new Set(input.courses.filter((course) => course.mode !== "class").map((course) => course.department).filter(Boolean))];
  if (settings.teachers.length) {
    const covered = new Set(classSectionsTeacherList(settings).flatMap((teacher) => teacher.departments));
    const missing = departments.filter((dept) => !covered.has(dept));
    return `교사 ${settings.teachers.length}명 입력됨${missing.length ? ` · 명단에 없는 교과는 교사 수 제한 없이 계산: ${missing.map(label).join(", ")}` : ""}`;
  }
  if (!settings.useHoursTeachers) return "교사 명단 없음 · 교사 수 제한 없이 계산합니다";
  if (!input.departmentTeachers) return "교사 명단 없음 · 5단계 교사 수가 비어 있어 교사 수 제한 없이 계산합니다";
  const missing = departments.filter((dept) => input.departmentTeachers[dept] === undefined);
  return `교사 명단 없음 · 5단계 교과별 교사 수로 블록당 분반을 제한합니다${missing.length ? ` · 5단계 교사 수가 비어 있는 교과(제한 없음): ${missing.map(label).join(", ")}` : ""}`;
}

function classSectionsCircled(number) {
  return number >= 1 && number <= 20 ? String.fromCharCode(0x2460 + number - 1) : number ? `(${number})` : "";
}

function classSectionsCompareHtml(group, entry) {
  const compare = CLASS_SECTIONS_VIEW.compare;
  if (!compare || compare.groupKey !== group.key || compare.round !== CLASS_SECTIONS_VIEW.round) return "";
  const esc = classSectionsEsc;
  const rows = compare.rows.map((row) => `<tr${row.mode === compare.recommended ? ' class="is-recommended"' : ""}>
    <th scope="row">${esc(row.label)}${row.mode === compare.recommended ? ' <span class="cs-tag">추천</span>' : ""}${row.excluded ? ' <span class="cs-tag" title="내년 반 배정표가 없어 지금 반 기준입니다. 진급 때 반이 바뀌면 효과가 없어 추천에서 뺐습니다.">추천 제외 · 지금 반 기준</span>' : ""}</th>
    <td>${row.unassigned}</td><td>${row.maxSpread}명 (평균 ${row.avgSpread})</td><td>${Math.round(row.sameHomeroomRatio * 100)}%</td><td>${row.moved === null || row.moved === undefined ? '<span title="앞 편성 결과가 없어 비교하지 않았습니다">–</span>' : row.moved}</td>
    <td><button class="button" type="button" data-cs-use-mode="${esc(row.mode)}"${(entry.mode || "move") === row.mode ? ' aria-pressed="true"' : ""}>이 방식으로 편성</button></td></tr>`).join("");
  return `<section class="cs-card" aria-label="편성 방식 비교"><h4>편성 방식 비교</h4>
    <p class="cs-note">${esc(compare.reason)}</p>
    <table class="cs-table"><thead><tr><th>방식</th><th>미배정</th><th title="같은 과목 분반들의 인원 최대 − 최소(과목 중 가장 큰 값)">분반 인원 차이(최대)</th><th title="같은 담임반 학생이 같은 분반에 모인 비율(과목·반마다 가장 많이 모인 분반 기준)">같은 반끼리 비율</th><th title="앞 편성 결과에서 분반이 바뀐 학생·과목 수">앞 편성 대비 이동</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <p class="cs-note">분반 인원 차이 = 같은 과목 분반 인원의 최대 − 최소 · 같은 반끼리 비율 = 같은 담임반 학생이 같은 분반에 모인 비율</p>
    <p class="cs-note">${compare.baselineAt ? `앞 편성 대비 이동 = ${esc(new Date(compare.baselineAt).toLocaleString("ko-KR"))}에 저장한 편성 결과에서 분반이 바뀐 학생·과목 수.` : "앞 편성 결과가 없어 이동 수는 ‘–’로 표시합니다."}</p></section>`;
}

// 결과 머리글: 시안으로 계산한 뒤 그 차수를 확정했으면, 입력이 같을 때 '확정 결과 기준(시안 때 계산 · 입력 같음)'.
function classSectionsResultBasis(round, group, entry, result) {
  if (!result.draft) return "확정 결과 기준";
  const locked = typeof isRoundLocked === "function" && isRoundLocked(round);
  if (!locked) return "확정 전 시안";
  const same = result.signature === classSectionsSignature(classSectionsBuildInput(round, group, entry));
  return same ? "확정 결과 기준(시안 때 계산 · 입력 같음)" : "확정 전 시안 · 입력 변경됨";
}

// 참고: 같은 학기 다른 그룹 결과의 그룹 간 오류(교사 부족·겹침)가 이 그룹 블록 시간과 겹치는데 원인이 그 그룹일 때.
function classSectionsOtherGroupNotes(round, group, result) {
  const store = classSectionsStore()[round] || {};
  const slots = new Set((result.blocks || []).flatMap((block) => block.times || []));
  if (!slots.size) return [];
  const notes = [];
  for (const other of classSectionsSource(round).groups) {
    if (other.key === group.key || other.semester !== group.semester) continue;
    for (const issue of store[other.key]?.sectionResult?.issues || []) {
      if (issue.severity !== "error" || !["teacher-shortage", "teacher-cross", "cohort-clash"].includes(issue.type)) continue;
      if (Array.isArray(issue.groups) && issue.groups.includes(`${round}:${group.key}`)) continue; // 이 그룹도 원인이면 이미 이 그룹 오류에 있음
      if (issue.slot && !slots.has(issue.slot)) continue;
      notes.push(`참고: 같은 시간 다른 그룹(${other.label}) — ${issue.message}`);
    }
  }
  return [...new Set(notes)];
}

function classSectionsOtherGroupNotesHtml(round, group, result) {
  const notes = classSectionsOtherGroupNotes(round, group, result);
  return notes.length ? `<details id="classSectionsOtherNotes"><summary>참고 ${notes.length}건 · 다른 그룹 교사 부족·겹침(이 그룹은 원인 아님)</summary><ul class="cs-list">${notes.slice(0, 20).map((text) => `<li>${classSectionsEsc(text)}</li>`).join("")}</ul></details>` : "";
}

// 같은 학기 다른 학년 편성이 이 결과보다 나중에 따로 바뀌었으면(블록 시간이 있을 때만 교사 겹침에 영향) 안내한다.
function classSectionsOtherChangedHtml(round, group, result) {
  const store = classSectionsStore()[round] || {};
  const source = classSectionsSource(round);
  const timed = (result.blocks || []).some((block) => block.times?.length);
  if (!timed) return "";
  const newer = source.groups.filter((other) => other.key !== group.key && other.semester === group.semester && other.grade !== group.grade)
    .filter((other) => { const saved = store[other.key]?.sectionResult; return saved && saved.batch !== result.batch && String(saved.createdAt) > String(result.createdAt); });
  if (!newer.length) return "";
  return `<p class="cs-note is-warn" id="classSectionsOtherChanged">다른 학년 편성(${classSectionsEsc(newer.map((item) => item.label).join(", "))})이 이 결과보다 나중에 바뀌어 학년 간 교사 겹침을 다시 확인해야 합니다. ‘전 학년 함께 다시 계산’을 권합니다.</p>`;
}

function classSectionsResultHtml(round, group, entry, result, settings) {
  const esc = classSectionsEsc;
  const explain = result.explain || {};
  const teachers = classSectionsTeacherList(settings);
  const issues = (result.issues || []).filter((issue) => issue.type !== "unassigned");
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity !== "error");
  const suggestions = (explain.suggestions || []).map((item, index) => `<li>${esc(item.message)}${item.verified ? ' <span class="cs-tag">확인됨</span>' : ""}
    ${["capacity", "sections", "block-limit", "more-blocks", "class-unit"].includes(item.type) ? `<button class="button" type="button" data-cs-apply="${index}">제안 적용</button>`
      : item.type === "recommend-times" ? `<button class="button" type="button" data-cs-apply="${index}">블록 시간 추천 실행</button>` : ""}</li>`).join("");
  const causes = (explain.causes || []).map((item) => `<li>${esc(item.message)}</li>`).join("");
  const blocks = result.blocks.map((block) => {
    const cards = block.sectionIds.map((id) => {
      const section = result.sections.find((item) => item.id === id);
      if (!section) return "";
      const department = classSectionsCourseConf(settings, "courseDepartments", group.grade)[section.courseKey] || group.courses.find((course) => course.key === section.courseKey)?.department || "";
      const eligible = teachers.filter((teacher) => teacher.departments.includes(department) || teacher.courses.includes(section.courseName));
      const pinned = entry.pins.teachers[section.id] || "";
      const teacherSelect = teachers.length ? `<select data-cs-teacher="${esc(section.id)}" data-focus-key="cs-teacher-${esc(section.id)}" aria-label="${esc(section.roomName)} 담당 교사">
        <option value="">${section.teacherId ? `자동(${esc(teachers.find((teacher) => teacher.id === section.teacherId)?.name || section.teacherId)})` : "자동(없음)"}</option>
        ${(eligible.length ? eligible : teachers).map((teacher) => `<option value="${esc(teacher.id)}"${pinned === teacher.id ? " selected" : ""}>${esc(teacher.name)}</option>`).join("")}</select>` : "";
      const over = section.size > section.capacity;
      return `<li class="cs-section${over ? " is-over" : ""}" data-section-id="${esc(section.id)}" data-room="${esc(section.roomName)}" data-course="${esc(section.courseName)}" data-size="${section.size}" data-capacity="${section.capacity}">
        <strong title="${esc(section.courseName)}${section.roomNo ? ` ${section.roomNo}반` : ""}">${esc(section.courseName)}${section.roomNo ? ` ${classSectionsCircled(section.roomNo)}` : ""}</strong>
        <span class="cs-size" aria-label="인원">${section.size}/${section.capacity}명</span>
        <span class="cs-neis" title="나이스 개설강의실 이름(내보내기에 이 이름을 씀)">나이스 ${esc(section.roomName)}</span>
        <span class="cs-controls">${teacherSelect}<label class="cs-pin" title="이 분반을 ${esc(block.letter)}블록에 고정합니다. 다시 계산해도 블록이 바뀌지 않습니다."><input type="checkbox" data-cs-pin="${esc(section.id)}" data-cs-pin-block="${esc(block.id)}"${entry.pins.sections[section.id] ? " checked" : ""} aria-label="${esc(section.roomName)} 블록 고정"> 블록 고정</label></span></li>`;
    }).join("");
    return `<div class="cs-block"><h5>${esc(block.letter)}블록 <span>${block.sectionIds.length}개${block.maxSections ? ` / 최대 ${block.maxSections}` : ""}</span>${block.times?.length ? ` <em>${esc(classSectionsTimesText(block.times))}</em>` : ""}</h5><ul>${cards}</ul></div>`;
  }).join("");
  const unassigned = result.unassigned.slice(0, 200).map((item) => `<tr><td>${esc(item.studentKey)}</td><td>${esc(item.courseKey)}</td><td>${esc({ capacity: "정원 부족", "no-block": "같은 블록 과목", closed: "폐강", "too-many": "블록 수 초과" }[item.reason] || item.reason)}</td></tr>`).join("");
  const query = CLASS_SECTIONS_VIEW.search.trim();
  let lookup = "";
  if (query) {
    const keys = Object.keys(result.assign).filter((key) => key === query || key.startsWith(`${query}-`) || key.endsWith(`-${query}`)).slice(0, 12);
    lookup = keys.length ? `<ul class="cs-lookup">${keys.map((key) => `<li><strong>${esc(key)}</strong> ${result.assign[key].map((id) => esc(result.sections.find((section) => section.id === id)?.roomName || id)).join(", ")}</li>`).join("")}</ul>`
      : '<p class="cs-note">찾는 학생이 없습니다(현학년-반-번호, 예: 1-3-12).</p>';
  }
  const metrics = result.metrics || {};
  return `<section class="cs-card" aria-label="편성 결과">
    <h4>편성 결과 <span class="cs-note">${esc(CLASS_SECTIONS_MODE_LABELS?.[result.mode] || result.mode)} · ${esc(classSectionsResultBasis(round, group, entry, result))} · ${esc(new Date(result.createdAt).toLocaleString("ko-KR"))}</span></h4>
    ${classSectionsOtherChangedHtml(round, group, result)}
    ${classSectionsOtherGroupNotesHtml(round, group, result)}
    <p class="cs-summary" id="classSectionsSummary" data-feasible="${explain.feasible ? "true" : "false"}">${esc(explain.summary || "")}</p>
    <p class="cs-note" id="classSectionsMetrics">미배정 ${metrics.unassignedStudents || 0}명 · <span title="같은 과목 분반 인원의 최대 − 최소(과목 중 가장 큰 값)">분반 인원 차이 최대 ${metrics.maxSpread || 0}명</span> · <span title="같은 담임반 학생이 같은 분반에 모인 비율(과목·반마다 가장 많이 모인 분반 기준)">같은 반끼리 ${Math.round((metrics.sameHomeroomRatio || 0) * 100)}%(같은 담임반 학생이 같은 분반에 모인 비율)</span>${metrics.moved !== null && metrics.moved !== undefined ? ` · 앞 편성 대비 이동 ${metrics.moved}` : ""}</p>
    ${unassigned ? `<details open id="classSectionsUnassigned"><summary>미배정 ${result.unassigned.length}건</summary><table class="cs-table"><thead><tr><th>학생</th><th>과목</th><th>사유</th></tr></thead><tbody>${unassigned}</tbody></table></details>` : ""}
    ${causes ? `<h5>원인</h5><ul class="cs-list">${causes}</ul>` : ""}
    ${suggestions ? `<h5>제안</h5><ul class="cs-list" id="classSectionsSuggestions">${suggestions}</ul>` : ""}
    ${errors.length ? `<h5>오류 ${errors.length}건</h5><ul class="cs-list is-error">${errors.slice(0, 30).map((issue) => `<li>${esc(issue.message)}</li>`).join("")}</ul>` : ""}
    ${warnings.length ? `<details><summary>확인 ${warnings.length}건</summary><ul class="cs-list">${warnings.slice(0, 50).map((issue) => `<li>${esc(issue.message)}</li>`).join("")}</ul></details>` : ""}
    <div class="cs-blocks" data-scroll-key="cs-blocks">${blocks}</div>

    <div class="cs-fields">
      <label>학생 찾기 <input class="cs-text" type="search" id="classSectionsStudentSearch" value="${esc(query)}" placeholder="1-3-12" data-focus-key="cs-search" aria-label="학생 찾기(현학년-반-번호)"></label>
    </div>
    ${lookup}
    <div class="cs-actions">
      <button class="button" id="classSectionsExportBlocks" type="button">블록표 엑셀</button>
      <button class="button" id="classSectionsExportRosters" type="button">분반 명렬표 엑셀</button>
      <button class="button" id="classSectionsExportNeis" type="button">나이스 편성 엑셀</button>
      <button class="button" id="classSectionsClassMapTemplate" type="button">내년 반 배정표 양식</button>
      <label class="button">내년 반 배정표 올리기<input id="classSectionsClassMap" type="file" accept=".xlsx" hidden></label>
      ${classSectionsClassMap(group.grade) ? `<button class="button" id="classSectionsClassMapClear" type="button">배정표 지우기</button>` : ""}
      <span class="cs-note">${classSectionsClassMap(group.grade) ? `내년 반 배정표 ${(group.gradeStudents || group.students).filter((student) => classSectionsClassMap(group.grade)[student.key]).length}/${(group.gradeStudents || group.students).length}명 반영` : "내년 반이 없으면 나이스 파일의 반·번호는 비우고 참고 열(현 학년-반-번호)을 붙입니다."}</span>
    </div>
  </section>`;
}

function classSectionsClassUnitHtml(group, entry, settings) {
  const courses = group.courses.filter((course) => classSectionsCourseConf(settings, "courseModes", group.grade)[course.key] === "class");
  if (!courses.length) return "";
  const esc = classSectionsEsc;
  const split = classSectionsClassUnitPlan(group, entry, settings);
  const rows = split.homerooms.map((room) => `<tr><th scope="row">내년 ${esc(room)}반</th><td><select data-cs-unit-room="${esc(room)}" data-focus-key="cs-unit-${esc(room)}" aria-label="내년 ${esc(room)}반 학급 단위 과목">
    ${courses.map((course) => `<option value="${esc(course.key)}"${split.assign[room] === course.key ? " selected" : ""}>${esc(course.name)}</option>`).join("")}</select></td></tr>`).join("");
  const status = split.mapped
    ? `희망과 다른 학생 ${split.mismatched}명(내년 반 배정표 기준)`
    : "과목별 반 수만 확정 · 학생 배정은 내년 반 배정표를 올린 뒤";
  return `<section class="cs-card" aria-label="학급 단위 과목"><h4>학급 단위 과목 · 내년 반 배정 <span class="cs-note">추천 비율 ${esc(split.ratio)} · 내년 ${split.homerooms.length}학급 · ${esc(status)}</span></h4>
    <p class="cs-note" id="classSectionsClassUnitNote">학급 단위 과목은 이동 블록에서 빠집니다. 반 배분은 내년 ${group.targetGrade}학년 ${split.homerooms.length}학급 기준입니다${split.mapped ? "(학생 희망을 새 반 기준으로 반영)" : ". 내년 반이 정해지지 않아 학생별 과목은 아직 정하지 않습니다(오류 아님)"}.</p>
    <button class="button" type="button" id="classSectionsClassUnitReset">추천으로 되돌리기</button>
    ${entry.sectionResult ? "" : `<button class="button" id="classSectionsExportBlocks" type="button">블록표 엑셀</button>
      <button class="button" id="classSectionsExportNeis" type="button">나이스 편성 엑셀</button>
      <button class="button" id="classSectionsClassMapTemplate" type="button">내년 반 배정표 양식</button>
      <label class="button">내년 반 배정표 올리기<input id="classSectionsClassMap" type="file" accept=".xlsx" hidden></label>`}
    <table class="cs-table"><thead><tr><th>내년 반</th><th>과목</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function classSectionsClassUnitPlan(group, entry, settings) {
  const courses = group.courses.filter((course) => classSectionsCourseConf(settings, "courseModes", group.grade)[course.key] === "class").map((course) => ({ key: course.key, name: course.name,
    sections: entry.classCounts[course.key] !== undefined ? Number(entry.classCounts[course.key]) || 0 : course.classCount }));
  const count = group.nextClasses || group.rosterClasses || group.classes || 0;
  const homerooms = Array.from({ length: count }, (_, index) => String(index + 1));
  const { map } = classSectionsEffectiveClassMap(group);
  // 학생 희망은 내년 반을 알 때만 반영한다(배정표, 또는 '그대로 올라감'이면 지금 반).
  const students = map ? classSectionsHomeroomStudents(group).filter((student) => student.homeroom !== "미정") : [];
  const split = typeof classSectionsClassUnitSplit === "function" ? classSectionsClassUnitSplit({ courses, homerooms: homerooms.map((id) => ({ id })), students }) : { assign: {}, ratio: "", mismatched: 0 };
  const manual = classSectionsPlain(entry.classUnit.assign) ? entry.classUnit.assign : {};
  const assign = { ...split.assign };
  for (const [room, key] of Object.entries(manual)) if (homerooms.includes(room)) assign[room] = key;
  return { ...split, assign, homerooms, mapped: Boolean(map) };
}

// ---- 교사·시간 설정 창 ----
function renderClassSectionsTeachers() {
  const body = document.getElementById("classSectionsTeacherBody");
  if (!body) return;
  const esc = classSectionsEsc;
  const settings = classSectionsSettings();
  const departments = typeof HOURS_DEPARTMENTS !== "undefined" ? HOURS_DEPARTMENTS : [];
  const rows = settings.teachers.map((teacher, index) => {
    const deptOptions = [`<option value="">교과 선택</option>`, ...departments.map((item) => `<option value="${esc(item.id)}"${teacher.department === item.id ? " selected" : ""}>${esc(typeof hoursDepartmentName === "function" ? hoursDepartmentName(item.id) : item.id)}</option>`)].join("");
    const open = CLASS_SECTIONS_VIEW.teacherSlot === index;
    const grid = open ? `<tr class="cs-grid-row"><td colspan="7"><table class="cs-grid" aria-label="${esc(teacher.name)} 불가 시간"><thead><tr><th></th>${CLASS_SECTIONS_DAY_NAMES.map((day) => `<th>${day}</th>`).join("")}</tr></thead><tbody>
      ${Array.from({ length: CLASS_SECTIONS_PERIODS }, (_, p) => `<tr><th>${p + 1}교시</th>${CLASS_SECTIONS_DAY_NAMES.map((day) => {
        const slot = `${day}${p + 1}`;
        return `<td><input type="checkbox" data-cs-t-slot="${index}|${slot}"${(teacher.unavailable || []).includes(slot) ? " checked" : ""} aria-label="${esc(teacher.name)} ${day}요일 ${p + 1}교시 불가"></td>`;
      }).join("")}</tr>`).join("")}</tbody></table></td></tr>` : "";
    return `<tr>
      <td><input class="cs-text" type="text" value="${esc(teacher.name || "")}" data-cs-t="${index}|name" data-focus-key="cs-t-name-${index}" aria-label="교사 ${index + 1} 이름"></td>
      <td><input class="cs-text" type="text" value="${esc(teacher.alias || "")}" data-cs-t="${index}|alias" data-focus-key="cs-t-alias-${index}" aria-label="교사 ${index + 1} 별칭"></td>
      <td><select data-cs-t="${index}|department" data-focus-key="cs-t-dept-${index}" aria-label="교사 ${index + 1} 담당 교과">${deptOptions}</select></td>
      <td><input class="cs-text" type="text" value="${esc(teacher.courses || "")}" placeholder="비우면 교과 전체" data-cs-t="${index}|courses" data-focus-key="cs-t-courses-${index}" aria-label="교사 ${index + 1} 담당 과목 좁히기"></td>
      <td><button class="button" type="button" data-cs-t-grid="${index}" aria-expanded="${open}">${(teacher.unavailable || []).length ? `불가 ${(teacher.unavailable || []).length}시간` : "불가 시간"}</button></td>
      <td><input class="cs-text" type="text" value="${esc(teacher.reason || "")}" placeholder="육아시간·순회" data-cs-t="${index}|reason" data-focus-key="cs-t-reason-${index}" aria-label="교사 ${index + 1} 불가 사유"></td>
      <td><button class="button" type="button" data-cs-t-remove="${index}" aria-label="교사 ${index + 1} 삭제">삭제</button></td></tr>${grid}`;
  }).join("");
  const fixed = settings.fixedSlots.map((slot, index) => `<tr>
    <td><input class="cs-text" type="text" value="${esc(slot.label || "")}" data-cs-f="${index}|label" data-focus-key="cs-f-label-${index}" aria-label="고정 시간 ${index + 1} 이름"></td>
    <td><input class="cs-text cs-wide" type="text" value="${esc(slot.times || "")}" placeholder="금6,금7" data-cs-f="${index}|times" data-focus-key="cs-f-times-${index}" aria-label="고정 시간 ${index + 1} 요일·교시"></td>
    <td><label><input type="checkbox" data-cs-f="${index}|allTeachers"${slot.allTeachers ? " checked" : ""}> 모든 교사</label></td>
    <td><button class="button" type="button" data-cs-f-remove="${index}" aria-label="고정 시간 ${index + 1} 삭제">삭제</button></td></tr>`).join("");
  body.innerHTML = `
    <section><h3>교사 <span class="cs-note">${settings.teachers.length}명 · 교과 단위가 기본, 과목으로 좁힐 수 있음</span></h3>
      ${CLASS_SECTIONS_VIEW.teacherIdWarning ? `<p class="cs-note is-warn" id="classSectionsTeacherIdWarning">${esc(CLASS_SECTIONS_VIEW.teacherIdWarning)}</p>` : ""}
      <div class="cs-actions"><button class="button" type="button" id="classSectionsTeacherAdd">교사 추가</button>
      <button class="button" type="button" id="classSectionsTeacherFromHours">5단계 교사 수로 명단 만들기</button></div>
      <div class="cs-scroll" data-scroll-key="cs-teachers"><table class="cs-table"><thead><tr><th>이름</th><th>별칭</th><th>교과</th><th>과목(선택)</th><th>불가 시간</th><th>사유</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7">교사 명단이 없습니다. 없으면 5단계 교과별 교사 수만으로 블록당 분반을 제한합니다.</td></tr>'}</tbody></table></div>
    </section>
    <section><h3>고정 시간 <span class="cs-note">창체·진로, 스포츠 + 창체 묶음 등</span></h3>
      <div class="cs-actions"><button class="button" type="button" id="classSectionsFixedAdd">고정 시간 추가</button>
      <button class="button" type="button" id="classSectionsFixedCreative">창체·진로 금 6·7교시 넣기</button></div>
      <table class="cs-table"><thead><tr><th>이름</th><th>요일·교시</th><th>대상</th><th></th></tr></thead><tbody>${fixed || '<tr><td colspan="4">없음</td></tr>'}</tbody></table>
    </section>
    <section><h3>특별실·기준</h3><div class="cs-fields">
      <label>특별실 수 <input class="cs-text cs-wide" type="text" id="classSectionsRooms" value="${esc(Object.entries(settings.rooms).map(([key, value]) => `${key}=${value}`).join(", "))}" placeholder="과학실=3, 컴퓨터실=1" data-focus-key="cs-rooms" aria-label="특별실 수(이름=수)"></label>
      <label>분반 인원 차이 경고 <input class="cs-num" type="number" min="1" max="20" id="classSectionsSpreadWarn" value="${settings.spreadWarn}" data-focus-key="cs-spread" aria-label="분반 인원 차이 경고 기준(명)">명 초과</label>
      <label><input type="checkbox" id="classSectionsUseHours"${settings.useHoursTeachers ? " checked" : ""}> 교사 명단이 없으면 5단계 교과별 교사 수로 블록 제한</label>
    </div></section>
    <section><h3>블록 시간 추천 격자</h3><div class="cs-fields">
      <label>요일 <input class="cs-text" type="text" id="classSectionsGridDays" value="${esc(settings.gridDays)}" data-focus-key="cs-grid-days" aria-label="시간 격자 요일(쉼표로 구분)"></label>
      <label>하루 교시 수 <input class="cs-num" type="number" min="1" max="12" id="classSectionsGridPeriods" value="${settings.gridPeriods}" data-focus-key="cs-grid-periods" aria-label="하루 교시 수"></label>
      ${["2", "3"].map((grade) => `<label>${grade}학년 공통 과목용 남길 시간 <input class="cs-num" type="number" min="0" max="60" data-cs-reserve="${grade}" value="${esc(settings.reserve[grade] ?? "")}" data-focus-key="cs-reserve-${grade}" aria-label="${grade}학년 공통 과목용 남길 시간(주당)"></label>`).join("")}
    </div><p class="cs-note">고정 시간(창체·진로 등)은 블록에 쓰지 않습니다. 남길 시간은 학교 지정·학급 단위 과목 수업용으로 비워 둘 주당 시간입니다.</p></section>`;
}

// ---- 이벤트 ----
function classSectionsChanged(rerender = true) {
  if (typeof persistStateSoon === "function") persistStateSoon(); else if (typeof persistState === "function") persistState();
  if (rerender) renderClassSections();
}

function classSectionsApplySuggestion(index) {
  const context = classSectionsCurrent();
  const item = context?.entry?.sectionResult?.explain?.suggestions?.[index];
  if (!item) return;
  const { entry } = context;
  if (item.type === "capacity") {
    // 분반별 정원(과목마다 '34,35,34' 모양)으로 옮긴다.
    const byCourse = new Map();
    for (const section of item.sections) {
      if (!byCourse.has(section.courseKey)) byCourse.set(section.courseKey, []);
      byCourse.get(section.courseKey).push(section);
    }
    for (const [courseKey, list] of byCourse) {
      const all = context.entry.sectionResult.sections.filter((section) => section.courseKey === courseKey).sort((a, b) => a.ord - b.ord);
      entry.capacities[courseKey] = all.map((section) => list.find((raised) => raised.sectionId === section.id)?.to || section.capacity).join(",");
    }
    // 같은 배치에서 확인한 제안이므로 지금 배치를 고정해 다시 계산한다.
    if (item.source === "same-placement") for (const section of context.entry.sectionResult.sections) entry.pins.sections[section.id] = section.blockId;
  } else if (item.type === "sections") {
    for (const course of item.courses) {
      entry.classCounts[course.courseKey] = course.toSections;
      entry.capacities[course.courseKey] = Array(course.toSections).fill(course.capacity).join(",");
    }
  } else if (item.type === "more-blocks") {
    entry.blocks = item.blocks;
  } else if (item.type === "class-unit") {
    // 제안은 지금 블록 수로 다시 풀어 확인한 것이므로, 학급 단위로 바꿔도 블록 수 기본값이 줄지 않게 지금 값을 고정한다.
    if (!Number(entry.blocks)) entry.blocks = classSectionsGroupSettings(context.source, context.group, entry).blocks;
    const modes = classSectionsCourseConf(classSectionsSettings(), "courseModes", context.group.grade);
    for (const key of item.courseKeys || [item.courseKey]) modes[key] = "class";
  } else if (item.type === "recommend-times") {
    return void classSectionsRecommendTimesCurrent();
  } else if (item.type === "block-limit") {
    entry.maxSectionsPerBlock = item.maxSectionsPerBlock;
  }
  classSectionsChanged(false);
  classSectionsSolveCurrent("solve");
}

function classSectionsHandleClick(event) {
  const target = event.target.closest("button, [data-cs-group]");
  if (!target) return;
  if (target.dataset.csGroup) { CLASS_SECTIONS_VIEW.group = target.dataset.csGroup; CLASS_SECTIONS_VIEW.search = ""; CLASS_SECTIONS_VIEW.status = null; renderClassSections(); return; }
  if (target.id === "classSectionsSolve") return void classSectionsSolveCurrent("solve");
  if (target.id === "classSectionsCompare") return void classSectionsSolveCurrent("compare");
  if (target.id === "classSectionsPartial") return void classSectionsSolveCurrent("partial");
  if (target.id === "classSectionsSolveSemester") return void classSectionsSolveSemesterCurrent();
  if (target.id === "classSectionsRecommendTimes") return void classSectionsRecommendTimesCurrent();
  if (target.id === "classSectionsApplyTimes") return classSectionsApplyTimes();
  if (target.id === "classSectionsDiscardTimes") { CLASS_SECTIONS_VIEW.timesProposal = null; return renderClassSections(); }
  if (target.dataset.csUseMode) {
    const context = classSectionsCurrent();
    const compare = CLASS_SECTIONS_VIEW.compare;
    context.entry.mode = target.dataset.csUseMode;
    const picked = compare?.results?.[target.dataset.csUseMode];
    if (picked && compare.groupKey === context.group.key) {
      classSectionsSaveResult(context.entry, picked, { ...compare.input, mode: target.dataset.csUseMode }, context.group, context.source);
      classSectionsSetStatus(`${CLASS_SECTIONS_MODE_LABELS[target.dataset.csUseMode]} 결과로 바꿨습니다.`);
      return classSectionsChanged();
    }
    classSectionsChanged(false);
    return void classSectionsSolveCurrent("solve");
  }
  if (target.dataset.csApply !== undefined) return classSectionsApplySuggestion(Number(target.dataset.csApply));
  if (target.id === "classSectionsExportBlocks") return classSectionsExport("blocks");
  if (target.id === "classSectionsExportRosters") return classSectionsExport("rosters");
  if (target.id === "classSectionsExportNeis") return classSectionsExport("neis");
  if (target.id === "classSectionsClassMapTemplate") return classSectionsExport("classMapTemplate");
  if (target.id === "classSectionsClassMapClear") {
    const context = classSectionsCurrent();
    if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(`현 ${context.group.grade}학년 내년 반 배정표를 지울까요?`)) return;
    const maps = classSectionsStore().classMaps;
    if (classSectionsPlain(maps)) delete maps[String(context.group.grade)];
    classSectionsSetStatus(`현 ${context.group.grade}학년 내년 반 배정표를 지웠습니다.`);
    return classSectionsChanged();
  }
  if (target.id === "classSectionsClassUnitReset") {
    const context = classSectionsCurrent();
    context.entry.classUnit.assign = {};
    return classSectionsChanged();
  }
}

function classSectionsHandleChange(event) {
  const target = event.target;
  const context = classSectionsCurrent();
  if (!context?.entry) return;
  const { entry } = context;
  const settings = classSectionsSettings();
  const data = target.dataset;
  if (data.csField) {
    if (data.csField === "mode") entry.mode = target.value;
    else entry[data.csField] = target.value === "" ? undefined : Number(target.value);
  } else if (data.csSections !== undefined) entry.classCounts[data.csSections] = Math.max(0, Number(target.value) || 0);
  else if (data.csCapacities !== undefined) entry.capacities[data.csCapacities] = target.value.trim();
  else if (data.csMode !== undefined) classSectionsCourseConf(settings, "courseModes", context.group.grade)[data.csMode] = target.value === "class" ? "class" : "move";
  else if (data.csDept !== undefined) classSectionsCourseConf(settings, "courseDepartments", context.group.grade)[data.csDept] = target.value;
  else if (data.csRoom !== undefined) classSectionsCourseConf(settings, "courseRooms", context.group.grade)[data.csRoom] = target.value.trim();
  else if (data.csBlockMax !== undefined) entry.blockMax[data.csBlockMax] = target.value === "" ? undefined : Number(target.value);
  else if (data.csBlockTimes !== undefined) entry.blockTimes[data.csBlockTimes] = target.value.trim();
  else if (data.csTeacher !== undefined) { if (target.value) entry.pins.teachers[data.csTeacher] = target.value; else delete entry.pins.teachers[data.csTeacher]; }
  else if (data.csPin !== undefined) { if (target.checked) entry.pins.sections[data.csPin] = data.csPinBlock; else delete entry.pins.sections[data.csPin]; }
  else if (data.csPromotion !== undefined) settings.promotion[data.csPromotion] = ["same", "new", "unknown"].includes(target.value) ? target.value : "unknown";
  else if (data.csUnitRoom !== undefined) { if (!classSectionsPlain(entry.classUnit.assign)) entry.classUnit.assign = {}; entry.classUnit.assign[data.csUnitRoom] = target.value; }
  else if (target.id === "classSectionsStudentSearch") { CLASS_SECTIONS_VIEW.search = target.value; return renderClassSections(); }
  else if (target.id === "classSectionsClassMap") return void classSectionsReadClassMap(target.files?.[0]);
  else if (data.csProposal !== undefined) {
    // 추천안 칸 고치기: 적용 전까지 화면 메모리에만 둔다.
    const proposal = CLASS_SECTIONS_VIEW.timesProposal;
    if (proposal) proposal.edits[data.csProposal] = target.value.trim();
    return;
  }
  else return;
  classSectionsChanged();
}

function classSectionsHandleTeacherEvent(event) {
  const target = event.target;
  const settings = classSectionsSettings();
  if (event.type === "click") {
    const button = target.closest("button");
    if (!button) return;
    if (button.id === "classSectionsTeacherAdd") settings.teachers.push({ id: `t${Date.now().toString(36)}${settings.teachers.length}`, name: "", department: "", unavailable: [] });
    else if (button.id === "classSectionsTeacherFromHours") {
      const counts = typeof hoursSettings === "function" && typeof hoursTargetYear === "function" ? hoursSettings(hoursTargetYear()).teachers || {} : {};
      let made = 0;
      for (const [department, value] of Object.entries(counts)) {
        const label = typeof hoursDepartmentName === "function" ? hoursDepartmentName(department) : department;
        for (let k = settings.teachers.filter((teacher) => teacher.department === department).length; k < Number(value); k += 1) {
          const used = new Set(settings.teachers.map((teacher) => String(teacher.id)));
          let serial = k + 1;
          while (used.has(`t-${department}-${serial}`)) serial += 1;
          settings.teachers.push({ id: `t-${department}-${serial}`, name: `${label} ${serial}`, department, unavailable: [] });
          made += 1;
        }
      }
      classSectionsSetStatus(made ? `5단계 교사 수로 교사 ${made}명을 만들었습니다. 이름·불가 시간을 고치세요.` : "5단계 교과별 교사 수가 없거나 이미 명단이 있습니다.");
    } else if (button.dataset.csTGrid !== undefined) {
      const index = Number(button.dataset.csTGrid);
      CLASS_SECTIONS_VIEW.teacherSlot = CLASS_SECTIONS_VIEW.teacherSlot === index ? -1 : index;
      return renderClassSectionsTeachers();
    } else if (button.dataset.csTRemove !== undefined) settings.teachers.splice(Number(button.dataset.csTRemove), 1);
    else if (button.id === "classSectionsFixedAdd") settings.fixedSlots.push({ label: "", times: "", allTeachers: true });
    else if (button.id === "classSectionsFixedCreative") settings.fixedSlots.push({ label: "창체·진로", times: "금6,금7", allTeachers: true });
    else if (button.dataset.csFRemove !== undefined) settings.fixedSlots.splice(Number(button.dataset.csFRemove), 1);
    else if (button.id === "classSectionsTeacherClose") { document.getElementById("classSectionsTeacherDialog")?.close(); return renderClassSections(); }
    else return;
  } else {
    const data = target.dataset;
    if (data.csT) {
      const [index, field] = data.csT.split("|");
      settings.teachers[Number(index)][field] = target.value.trim();
    } else if (data.csTSlot) {
      const [index, slot] = data.csTSlot.split("|");
      const teacher = settings.teachers[Number(index)];
      const list = new Set(teacher.unavailable || []);
      if (target.checked) list.add(slot); else list.delete(slot);
      teacher.unavailable = [...list];
    } else if (data.csF) {
      const [index, field] = data.csF.split("|");
      settings.fixedSlots[Number(index)][field] = field === "allTeachers" ? target.checked : target.value.trim();
    } else if (target.id === "classSectionsRooms") {
      settings.rooms = Object.fromEntries(target.value.split(/[,\n]+/).map((item) => item.split("=").map((part) => part.trim())).filter(([key, value]) => key && Number(value) >= 0).map(([key, value]) => [key, Number(value) || 0]));
    } else if (target.id === "classSectionsSpreadWarn") settings.spreadWarn = Math.max(1, Number(target.value) || 4);
    else if (target.id === "classSectionsUseHours") settings.useHoursTeachers = target.checked;
    else if (target.id === "classSectionsGridDays") settings.gridDays = target.value.split(/[,\s]+/).filter((day) => /^[월화수목금토]$/.test(day)).join(",") || "월,화,수,목,금";
    else if (target.id === "classSectionsGridPeriods") settings.gridPeriods = Math.max(1, Math.min(12, Number(target.value) || 7));
    else if (data.csReserve) { if (target.value === "") delete settings.reserve[data.csReserve]; else settings.reserve[data.csReserve] = Math.max(0, Number(target.value) || 0); }
    else return;
  }
  if (typeof persistStateSoon === "function") persistStateSoon(); else if (typeof persistState === "function") persistState();
  if (typeof preserveViewDuring === "function") preserveViewDuring(["#classSectionsTeacherDialog"], renderClassSectionsTeachers); else renderClassSectionsTeachers();
}

// ---- 내보내기 ----
// 학급 단위 과목 반별 명렬(내년 반을 알 때만: 배정표 또는 '그대로 올라감'). 시트 이름 '학급 단위 N반'.
function classSectionsClassUnitRosterSheets(group, entry, settings, names) {
  const effective = classSectionsEffectiveClassMap(group);
  if (!effective.map) return [];
  const plan = classSectionsClassUnitPlan(group, entry, settings);
  const nameOf = new Map(group.courses.map((course) => [course.key, course.name]));
  const byRoom = new Map(plan.homerooms.map((room) => [room, []]));
  for (const student of group.gradeStudents || group.students) {
    const info = effective.map[student.key];
    if (info?.classroom && byRoom.has(info.classroom)) byRoom.get(info.classroom).push({ key: student.key, number: info.number });
  }
  return plan.homerooms.map((room) => {
    const list = byRoom.get(room).sort((a, b) => (Number(a.number) || 999) - (Number(b.number) || 999) || a.key.localeCompare(b.key, "ko", { numeric: true }));
    return { name: `학급 단위 ${room}반`, orientation: "portrait", widths: [8, 16, 10, 14], freeze: "A3",
      rows: [[`내년 ${group.targetGrade}학년 ${room}반 · ${nameOf.get(plan.assign[room]) || "(과목 미정)"} ${list.length}명`], ["새 번호", "현 학년-반-번호", "현 반", "성명"],
        ...list.map((item) => [item.number || "", item.key, Number(item.key.split("-")[1]) || item.key.split("-")[1], names.get(item.key) || ""])] };
  });
}

// '학급 단위 과목' 시트: 내년 반 → 과목, 반별 학생 수(내년 반을 알 때만), 비고.
function classSectionsClassUnitSheet(group, entry, settings) {
  const plan = classSectionsClassUnitPlan(group, entry, settings);
  const effective = classSectionsEffectiveClassMap(group);
  const counts = new Map();
  if (effective.map) for (const student of group.gradeStudents || group.students) {
    const room = effective.map[student.key]?.classroom;
    if (room) counts.set(room, (counts.get(room) || 0) + 1);
  }
  const nameOf = new Map(group.courses.map((course) => [course.key, course.name]));
  const note = effective.basis === "map" ? "내년 반 배정표 기준" : effective.basis === "same" ? "진급 때 반 그대로(지금 반 기준)" : "학생 배정은 반 배정표를 올린 뒤";
  const rows = [[`${group.label} 학급 단위 과목 (내년 ${group.targetGrade}학년 ${plan.homerooms.length}학급, 비율 ${plan.ratio})`], ["내년 반", "과목", "학생 수", "비고"],
    ...plan.homerooms.map((room) => [`${room}반`, nameOf.get(plan.assign[room]) || "(미정)", effective.map ? (counts.get(room) || 0) : "", note])];
  return { name: "학급 단위 과목", rows, widths: [10, 22, 10, 30], merges: ["A1:D1"], freeze: "A3", orientation: "portrait" };
}

function classSectionsStudentNames(round) {
  const data = typeof roundStatusData === "function" ? roundStatusData(round) : null;
  return new Map((data?.students || []).map((student) => [classSectionsStudentKey(student.grade, student.classroom, student.number), String(student.name || "")]));
}

// 올린 배정표를 학년별 지도에 합친다(파일에 있는 학생만 갱신, 나머지 유지). 반영 수는 실제로 학생과 맞은 수.
function classSectionsMergeClassMap(map) {
  const store = classSectionsStore();
  if (!classSectionsPlain(store.classMaps)) store.classMaps = {};
  const known = new Set();
  const round = CLASS_SECTIONS_VIEW.round || classSectionsDefaultRound();
  for (const group of round ? classSectionsSource(round).groups : []) for (const student of group.gradeStudents || group.students) known.add(student.key);
  const parts = [];
  let updated = 0;
  let unmatched = 0;
  const byGrade = new Map();
  for (const [key, value] of Object.entries(map)) {
    const grade = key.split("-")[0];
    if (!byGrade.has(grade)) byGrade.set(grade, []);
    byGrade.get(grade).push([key, value]);
  }
  for (const [grade, list] of byGrade) {
    if (!classSectionsPlain(store.classMaps[grade])) store.classMaps[grade] = {};
    const target = store.classMaps[grade];
    let changed = 0;
    let missing = 0;
    // 차수 자료에 없는 학생(결과 미제출·전입 예정 등)도 저장해 둔다. 반영 인원은 화면의 'n/N명'(실제 일치 수)으로 따로 보인다.
    let notSubmitted = 0;
    const knownRooms = new Set([...known].filter((key) => key.startsWith(`${grade}-`)).map((key) => key.split("-")[1]));
    for (const [key, value] of list) {
      if (known.size && !known.has(key)) {
        // 그 학년에 있는 반·숫자 번호면 신청 결과가 없는 학생(미제출), 아니면 표기 확인이 필요한 학생.
        const [, room, number] = key.split("-");
        if (knownRooms.has(room) && /^\d+$/.test(number || "")) notSubmitted += 1;
        else missing += 1;
      }
      target[key] = { classroom: classSectionsKeyPart(value.classroom), number: classSectionsKeyPart(value.number) };
      changed += 1;
    }
    const kept = Object.keys(target).length - changed;
    updated += changed;
    unmatched += missing;
    parts.push(`현 ${grade}학년 ${list.length}명 읽음 · 갱신 ${changed}명 · 유지 ${kept}명${notSubmitted ? ` · 이 차수 결과가 없는 학생(미제출 등) ${notSubmitted}명` : ""}${missing ? ` · 배정표에만 있는 학생 ${missing}명(반·번호 표기 확인)` : ""}`);
  }
  return { updated, unmatched, text: `내년 반 배정표: ${parts.join(" / ") || "읽은 학생 0명"}` };
}

async function classSectionsReadClassMap(file) {
  if (!file) return;
  try {
    const sheets = await parseWorkbook(await file.arrayBuffer());
    const { map, errors } = classSectionsClassMapFromRows(sheets[0]?.rows || []);
    const result = classSectionsMergeClassMap(map);
    if (typeof persistStateSoon === "function") persistStateSoon(); else if (typeof persistState === "function") persistState();
    classSectionsSetStatus(`${result.text}${errors.length ? ` · 확인 ${errors.length}건(${errors.slice(0, 2).join(" ")})` : ""}`, errors.length > 0 || !result.updated);
  } catch (error) {
    classSectionsSetStatus(`내년 반 배정표를 읽지 못했습니다: ${error?.message || error}`, true);
  }
  renderClassSections();
}

function classSectionsExport(kind) {
  const context = classSectionsCurrent();
  if (!context?.entry || typeof createWorkbookBlob !== "function" || typeof downloadBlob !== "function") return;
  const { round, group, entry } = context;
  let result = entry.sectionResult;
  const year = String((Number($("#schoolYear")?.value) || new Date().getFullYear()) + 1);
  const base = `${year}_${group.targetGrade}학년_${group.semester}학기_${String(group.category).replace(/[\\/:*?"<>|]/g, "")}`;
  if (kind === "classMapTemplate") {
    const rows = [["현 학년", "현 반", "현 번호", "새 반", "새 번호"],
      ...(group.gradeStudents || group.students).map((student) => [group.grade, student.homeroom, student.number, "", ""])];
    return downloadBlob(createWorkbookBlob([{ name: "내년 반 배정", rows, widths: [10, 10, 10, 10, 10], freeze: "A2", orientation: "portrait" }]), `${year}_현${group.grade}학년_내년반배정표.xlsx`);
  }
  const settingsForUnits = classSectionsSettings();
  const hasClassUnit = group.courses.some((course) => classSectionsCourseConf(settingsForUnits, "courseModes", group.grade)[course.key] === "class");
  // 학급 단위 과목만 있는 그룹은 이동 편성 결과가 없어도 내보낼 수 있다.
  if (!result && !hasClassUnit) return;
  if (!result) result = { blocks: [], sections: [], assign: {}, unassigned: [], draft: true, explain: { summary: "이동 수업 편성 없음(학급 단위 과목만)" } };
  const unitSheet = hasClassUnit ? classSectionsClassUnitSheet(group, entry, settingsForUnits) : null;
  const names = classSectionsStudentNames(round);
  const sectionById = new Map(result.sections.map((section) => [section.id, section]));
  if (kind === "blocks") {
    const settings = classSectionsSettings();
    const teacherName = new Map(classSectionsTeacherList(settings).map((teacher) => [teacher.id, teacher.name]));
    const rows = [[`${group.label} 블록표 (${result.draft ? "확정 전 시안" : `${round}차 확정 결과`})`], ["블록", "요일·교시", "강의실", "과목", "인원", "정원", "담당 교사"]];
    for (const block of result.blocks) for (const id of block.sectionIds) {
      const section = sectionById.get(id);
      rows.push([`${block.letter}블록`, classSectionsTimesText(block.times), section.roomName, section.courseName, section.size, section.capacity, teacherName.get(section.teacherId) || ""]);
    }
    rows.push([], ["요약", result.explain?.summary || ""]);
    return downloadBlob(createWorkbookBlob([{ name: "블록표", rows, widths: [8, 16, 18, 22, 8, 8, 14], merges: ["A1:G1"], freeze: "A3", orientation: "portrait" }, ...(unitSheet ? [unitSheet] : [])]), `${base}_블록표.xlsx`);
  }
  if (kind === "rosters") {
    const members = new Map(result.sections.map((section) => [section.id, []]));
    for (const [key, ids] of Object.entries(result.assign)) for (const id of ids) members.get(id)?.push(key);
    const ordered = result.sections.slice().sort((a, b) => a.blockLetter.localeCompare(b.blockLetter) || a.courseName.localeCompare(b.courseName, "ko") || (a.roomNo || 0) - (b.roomNo || 0) || a.ord - b.ord);
    const sheets = ordered.map((section) => {
      const list = (members.get(section.id) || []).sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
      return { name: section.roomName, orientation: "portrait", widths: [6, 16, 8, 8, 14], freeze: "A3",
        rows: [[`${section.roomName} (${section.courseName}) ${list.length}명`], ["번호", "현 학년-반-번호", "현 반", "현 번호", "성명"],
          ...list.map((key, index) => { const [, classroom, number] = key.split("-"); return [index + 1, key, Number(classroom) || classroom, Number(number) || number, names.get(key) || ""]; })] };
    });
    // '학급 단위 과목' 시트는 맨 뒤(분반 시트는 앞에 분반마다 하나). 내년 반을 알면 반별 학생 명렬 시트도 붙인다.
    const unitRosters = unitSheet ? classSectionsClassUnitRosterSheets(group, entry, settingsForUnits, names) : [];
    const all = [...sheets, ...(unitSheet ? [unitSheet] : []), ...unitRosters];
    return downloadBlob(createWorkbookBlob(all.length ? all : [{ name: "분반 없음", rows: [["이 그룹에는 이동 분반이 없습니다."]] }]), `${base}_분반명렬표.xlsx`);
  }
  if (kind === "neis") {
    const settings = classSectionsSettings();
    const courses = Object.fromEntries(group.courses.map((course) => {
      const department = classSectionsCourseConf(settings, "courseDepartments", group.grade)[course.key] || course.department;
      return [course.key, { family: classSectionsNeisFamily(course.area, department), credits: course.credits }];
    }));
    const effective = classSectionsEffectiveClassMap(group);
    const map = effective.map || {};
    const students = (group.gradeStudents || group.students).map((student) => ({ key: student.key, classroom: map[student.key]?.classroom || "", number: map[student.key]?.number || "", name: names.get(student.key) || "" }));
    const unitCourses = group.courses.filter((course) => classSectionsCourseConf(settings, "courseModes", group.grade)[course.key] === "class");
    const classUnit = unitCourses.length ? { byClass: classSectionsClassUnitPlan(group, entry, settings).assign,
      courses: Object.fromEntries(unitCourses.map((course) => [course.key, { name: course.name, ...courses[course.key] }])) } : null;
    const { rows, warnings } = classSectionsNeisExport(result, { year, semester: group.semester, targetGrade: group.targetGrade, courses, students, classUnit });
    if (result.roomRenames?.length) warnings.push(`강의실 이름이 바뀐 분반 ${result.roomRenames.length}개(번호 없던 과목이 한 블록에 2개가 됨 등): ${result.roomRenames.map((item) => `${item.from} → ${item.to}`).join(", ")}. 이미 나이스에 올렸으면 바뀐 이름을 확인하세요.`);
    if (effective.basis === "same") warnings.push("진급 때 반이 그대로 올라감으로 설정해 반은 지금 반으로 넣고 번호는 비웠습니다(진급 때 번호를 다시 매길 수 있음). 내년 반 배정표를 올리면 반·번호를 채웁니다.");
    const sheets = [{ name: "수강학생 편성", rows, widths: [8, 6, 6, 18, 22, 18, 12, 6, 6, 10, 16], merges: ["A1:F1", "G1:J1"], freeze: "A3" },
      { name: "확인 필요", orientation: "portrait", widths: [100], rows: [["확인 필요"], ...warnings.map((text) => [text]),
        ["개설강의실 번호: 어느 블록에서든 그 과목 분반이 2개 이상이면 모든 분반에 번호, 교사가 배정돼 있으면 같은 교사는 같은 번호(사용자 나이스 파일에서 추정)."]] }];
    classSectionsSetStatus(warnings.join(" "));
    return downloadBlob(createWorkbookBlob(sheets), `${base}_나이스_수강학생편성.xlsx`);
  }
}

function initClassSections() {
  const panel = document.getElementById("workflowStep8Panel");
  if (!panel || panel.dataset.ready) return;
  panel.dataset.ready = "1";
  const content = document.getElementById("classSectionsContent");
  content.addEventListener("click", classSectionsHandleClick);
  content.addEventListener("change", classSectionsHandleChange);
  document.getElementById("classSectionsRound")?.addEventListener("change", (event) => {
    CLASS_SECTIONS_VIEW.round = event.target.value;
    CLASS_SECTIONS_VIEW.compare = null;
    renderClassSections();
  });
  document.getElementById("classSectionsTeachersOpen")?.addEventListener("click", () => {
    renderClassSectionsTeachers();
    document.getElementById("classSectionsTeacherDialog")?.showModal();
  });
  const dialog = document.getElementById("classSectionsTeacherDialog");
  dialog?.addEventListener("click", classSectionsHandleTeacherEvent);
  dialog?.addEventListener("change", classSectionsHandleTeacherEvent);
  dialog?.addEventListener("close", () => renderClassSections());
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initClassSections);
  else initClassSections();
}
