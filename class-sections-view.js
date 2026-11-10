"use strict";
// 6단계 분반 편성 화면 연결(내부 단계 번호 8). 계산은 class-sections.js(순수, Worker), 이 파일은 입력 모으기·저장·그리기·내보내기.
// app.js·hours-stats.js 뒤에 로드한다. 다른 파일 함수는 typeof 가드로 부른다.
// 저장: state.classSections = { settings: {교사·고정 시간·특별실·기준}, "<차수>": { "<현학년>:<학기>:<그룹>": 그룹 설정 + sectionResult } }
// 개인정보: 저장하는 학생 키는 '현학년-반-번호'뿐이다. 성명은 명렬표·나이스 내보내기 때 차수 자료에서 읽어 파일에만 쓴다.

var CLASS_SECTIONS_VIEW = { round: "", group: "", running: false, worker: null, workerFailed: false, compare: null, search: "", teacherSlot: -1, classMap: null };
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
  if (!Array.isArray(settings.fixedSlots)) settings.fixedSlots = [];
  for (const key of ["rooms", "courseModes", "courseDepartments", "courseRooms"]) if (!classSectionsPlain(settings[key])) settings[key] = {};
  if (!(Number(settings.spreadWarn) > 0)) settings.spreadWarn = 4;
  if (typeof settings.useHoursTeachers !== "boolean") settings.useHoursTeachers = true;
  return settings;
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

// 복원: 예전 저장분·백업에 없으면 빈 객체. 모양이 틀린 값은 버린다(app.js restorePersistedState가 부름).
function classSectionsRestore(saved) {
  if (!classSectionsPlain(saved)) return {};
  const result = {};
  for (const [key, value] of Object.entries(saved)) {
    if (key === "settings" && classSectionsPlain(value)) result.settings = value;
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
    const gradeStudents = data.students.filter((student) => String(student.grade) === grade);
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
        for (const student of gradeStudents) {
          const picked = [];
          for (const selection of student.selections || []) {
            const key = columns.get(String(selection.column));
            if (!key || picked.includes(key)) continue;
            picked.push(key);
            const value = Number(selection.credits);
            if (value > 0) credits.set(key, value);
          }
          if (picked.length) students.push({ key: `${grade}-${student.classroom}-${student.number}`, homeroom: String(student.classroom), number: String(student.number), courses: picked });
        }
        for (const course of courses) course.credits = credits.get(course.key) || course.planCredits || 0;
        const classes = Number(classBases?.[targetGrade]) || Number(summary.classes) || 0;
        groups.push({ key: `${grade}:${semesterKey}:${group.category}`, grade, targetGrade, semester: semesterKey, category: group.category,
          choice: Number(group.choiceCount), classes, courses, students,
          label: `현${grade} → ${targetGrade}학년 ${semesterKey}학기 · ${group.category}` });
      }
    }
  }
  groups.sort((a, b) => a.semester.localeCompare(b.semester) || a.grade.localeCompare(b.grade) || a.category.localeCompare(b.category, "ko"));
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
  const classUnit = new Set(group.courses.filter((course) => settings.courseModes[course.key] === "class").map((course) => course.key));
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
      department: settings.courseDepartments[course.key] || course.department, room: settings.courseRooms[course.key] || "",
      credits: course.credits, mode: settings.courseModes[course.key] === "class" ? "class" : "move" };
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
        const department = otherSettings.courseDepartments[section.courseKey] || other.courses.find((course) => course.key === section.courseKey)?.department || "";
        if (department) departments[department] = (departments[department] || 0) + 1;
        if (section.teacherId) teacherIds.push(section.teacherId);
      }
      occupied.push({ label: `${other.label} ${block.letter}블록`, times: block.times, departments: teachers.length ? {} : departments, teacherIds });
    }
  }
  const fixedSlots = settings.fixedSlots.map((slot) => ({ label: slot.label, times: classSectionsParseTimes(slot.times),
    teacherIds: slot.allTeachers ? teachers.map((teacher) => teacher.id) : [] })).filter((slot) => slot.times.length);
  const rooms = Object.keys(settings.rooms).length ? Object.fromEntries(Object.entries(settings.rooms).map(([key, value]) => [key, Number(value) || 0])) : null;
  return {
    groupId: `${round}:${group.key}`, label: group.label, grade: group.grade, targetGrade: group.targetGrade, semester: group.semester,
    blocks, maxSectionsPerBlock: base.maxSectionsPerBlock || undefined, defaultCapacity: base.capacity,
    courses, students: group.students, teachers, departmentTeachers, rooms, occupied, fixedSlots, spreadWarn: settings.spreadWarn,
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
    issues: (result.issues || []).slice(0, 200), elapsedMs: result.elapsedMs
  };
}

async function classSectionsSolveCurrent(kind = "solve") {
  const context = classSectionsCurrent();
  if (!context || CLASS_SECTIONS_VIEW.running) return;
  const { round, group, entry, source } = context;
  const previous = entry.sectionResult;
  let input;
  if (kind === "partial" && previous?.assign) {
    const before = classSectionsPlain(entry.inputStudents) ? Object.entries(entry.inputStudents).map(([key, courses]) => ({ key, courses })) : [];
    input = classSectionsBuildInput(round, group, entry, { partial: true,
      previous: { sections: previous.sections.map((section) => ({ id: section.id, blockId: section.blockId })), assign: previous.assign, teacherOf: previous.teacherOf },
      changedStudents: before.length ? classSectionsChangedStudents(before, group.students) : group.students.map((student) => student.key) });
  } else {
    // 새로 계산: 기존 결과는 '기존 대비 이동' 비교에만 쓴다(배정을 붙잡지 않음). 그대로 두려면 '바뀐 학생만 다시 계산'.
    input = classSectionsBuildInput(round, group, entry, previous?.assign ? { baseline: { assign: previous.assign } } : {});
  }
  CLASS_SECTIONS_VIEW.running = true;
  classSectionsSetStatus(kind === "compare" ? "편성 방식 3가지를 계산하는 중…" : "분반 편성을 계산하는 중…");
  renderClassSections();
  try {
    if (kind === "compare") {
      const compared = await classSectionsRunSolver({ kind: "compare", input });
      const pick = compared.results[compared.recommended] || compared.results.move;
      CLASS_SECTIONS_VIEW.compare = { groupKey: group.key, round, rows: compared.rows, recommended: compared.recommended, reason: compared.reason, results: compared.results, input,
        baselineAt: previous?.createdAt || "" };
      entry.mode = compared.recommended;
      classSectionsSaveResult(entry, pick, { ...input, mode: compared.recommended }, group, source);
      classSectionsSetStatus(`편성 방식 비교 완료 · 추천: ${CLASS_SECTIONS_MODE_LABELS[compared.recommended]}`);
    } else {
      const result = await classSectionsRunSolver({ kind: "solve", input });
      classSectionsSaveResult(entry, result, input, group, source);
      classSectionsSetStatus(result.explain.feasible ? `편성 완료 · ${result.explain.summary}` : `편성 결과 확인 필요 · ${result.explain.summary}`, !result.explain.feasible);
    }
  } catch (error) {
    classSectionsSetStatus(`편성 계산 실패: ${error?.message || error}`, true);
  } finally {
    CLASS_SECTIONS_VIEW.running = false;
    if (typeof persistStateSoon === "function") persistStateSoon(); else if (typeof persistState === "function") persistState();
    renderClassSections();
  }
}

// 같은 차수·학기의 모든 그룹(학년)을 함께 푼다(classSectionsSolveAll). 그룹 순서는 화면 순서(학기·학년·그룹)로 고정이라
// 어느 그룹 화면에서 누르든 결과가 같다. 교사는 모든 그룹을 함께 배정한다.
async function classSectionsSolveSemesterCurrent() {
  const context = classSectionsCurrent();
  if (!context?.group || CLASS_SECTIONS_VIEW.running) return;
  const { round, source, group } = context;
  const groups = source.groups.filter((item) => item.semester === group.semester);
  const inputs = groups.map((item) => {
    const entry = classSectionsEntry(round, item.key, true);
    const previous = entry.sectionResult;
    return classSectionsBuildInput(round, item, entry, { noOccupied: true, ...(previous?.assign ? { baseline: { assign: previous.assign } } : {}) });
  });
  CLASS_SECTIONS_VIEW.running = true;
  classSectionsSetStatus(`${group.semester}학기 그룹 ${groups.length}개를 함께 계산하는 중…`);
  renderClassSections();
  try {
    const all = await classSectionsRunSolver({ kind: "solveAll", input: { groups: inputs, teachers: inputs[0]?.teachers || [], seed: inputs[0]?.seed || 1 } });
    let problems = 0;
    all.groups.forEach((item, index) => {
      const result = item.result;
      const prefix = `${inputs[index].groupId}::`;
      // 함께 배정한 교사 이슈: 이 그룹 분반('그룹id::분반id')·이 그룹이 나오는 학년 간 겹침·분반과 무관한 안내만 붙인다.
      const own = (all.issues || []).filter((issue) => (issue.type === "teacher-cross" ? String(issue.message).includes(inputs[index].label)
        : !issue.sectionId || String(issue.sectionId).startsWith(prefix)));
      result.issues = [...(result.issues || []), ...own];
      const hard = result.issues.filter((issue) => issue.severity === "error" && issue.type !== "unassigned");
      if (hard.length && result.explain?.feasible) {
        result.explain = { ...result.explain, feasible: false, summary: `${result.explain.summary} 오류 ${hard.length}건: ${hard.slice(0, 2).map((issue) => issue.message).join(" / ")}` };
      }
      if (!result.explain?.feasible) problems += 1;
      classSectionsSaveResult(classSectionsEntry(round, groups[index].key, true), result, inputs[index], groups[index], source);
    });
    classSectionsSetStatus(`${group.semester}학기 전 학년 ${groups.length}개 그룹을 함께 다시 계산했습니다${problems ? ` · 확인 필요 ${problems}개` : " · 모두 배정"}.`, problems > 0);
  } catch (error) {
    classSectionsSetStatus(`함께 계산 실패: ${error?.message || error}`, true);
  } finally {
    CLASS_SECTIONS_VIEW.running = false;
    if (typeof persistStateSoon === "function") persistStateSoon(); else if (typeof persistState === "function") persistState();
    renderClassSections();
  }
}

function classSectionsSaveResult(entry, result, input, group, source) {
  entry.sectionResult = classSectionsCompactResult(result, input, !source.locked);
  entry.inputStudents = Object.fromEntries(group.students.map((student) => [student.key, student.courses.slice()]));
}

function classSectionsSetStatus(text, error = false) {
  CLASS_SECTIONS_VIEW.status = { text, error };
  const box = document.getElementById("classSectionsStatus");
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
    const department = settings.courseDepartments[course.key] || course.department;
    const deptOptions = (typeof HOURS_DEPARTMENTS !== "undefined" ? HOURS_DEPARTMENTS : []).map((item) =>
      `<option value="${esc(item.id)}"${item.id === department ? " selected" : ""}>${esc(typeof hoursDepartmentName === "function" ? hoursDepartmentName(item.id) : item.id)}</option>`).join("");
    const key = esc(course.key);
    return `<tr${differs ? ' class="is-changed"' : ""}>
      <th scope="row">${esc(course.name)}${course.closed ? ' <span class="cs-tag">폐강</span>' : ""}</th>
      <td>${course.enrollment}</td>
      <td>${course.classCount}</td>
      <td><input class="cs-num" type="number" min="0" max="30" value="${sections}" data-cs-sections="${key}" data-focus-key="cs-sections-${key}" aria-label="${key} 6단계 분반 수">${differs ? `<span class="cs-diff" title="4단계 확정 ${course.classCount}개">4단계와 다름</span>` : ""}</td>
      <td><input class="cs-text" type="text" inputmode="numeric" value="${esc(entry.capacities[course.key] || "")}" placeholder="${base.capacity}" data-cs-capacities="${key}" data-focus-key="cs-cap-${key}" aria-label="${key} 분반별 정원(쉼표로 구분)"></td>
      <td><select data-cs-mode="${key}" data-focus-key="cs-mode-${key}" aria-label="${key} 운영 방식"><option value="move">이동</option><option value="class"${settings.courseModes[course.key] === "class" ? " selected" : ""}>학급 단위</option></select></td>
      <td><select data-cs-dept="${key}" data-focus-key="cs-dept-${key}" aria-label="${key} 담당 교과">${deptOptions}</select></td>
      <td><input class="cs-text" type="text" value="${esc(settings.courseRooms[course.key] || "")}" placeholder="없음" data-cs-room="${key}" data-focus-key="cs-room-${key}" aria-label="${key} 특별실"></td>
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
  const teacherNote = settings.teachers.length ? `교사 ${settings.teachers.length}명 입력됨`
    : settings.useHoursTeachers ? "교사 명단 없음 · 5단계 교과별 교사 수로 블록 제한" : "교사 제한 없음";
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
      <details class="cs-advanced"${Object.keys(entry.blockMax).length || Object.keys(entry.blockTimes).length ? " open" : ""}>
        <summary>블록별로 다르게 · 블록 시간(요일·교시)</summary>
        <p class="cs-note">블록 시간을 넣으면 교사 불가 시간·다른 학년 블록과의 겹침을 점검합니다. 블록 시수 = 과목 학점.</p>
        <table class="cs-table"><thead><tr><th>블록</th><th>최대 분반</th><th>요일·교시</th></tr></thead><tbody>${blockRows}</tbody></table>
      </details>
      <div class="cs-scroll" data-scroll-key="cs-courses"><table class="cs-table">
        <thead><tr><th>과목</th><th>신청</th><th>4단계 분반</th><th>6단계 분반</th><th>분반별 정원</th><th>운영</th><th>담당 교과</th><th>특별실</th></tr></thead>
        <tbody>${courseRows}</tbody></table></div>
      <div class="cs-actions">
        <button class="button button-primary" id="classSectionsSolve" type="button"${CLASS_SECTIONS_VIEW.running ? " disabled" : ""}>편성 계산</button>
        <button class="button" id="classSectionsCompare" type="button"${CLASS_SECTIONS_VIEW.running ? " disabled" : ""}>방식 비교·추천</button>
        ${source.groups.filter((item) => item.semester === group.semester).length > 1 ? `<button class="button" id="classSectionsSolveSemester" type="button" title="${group.semester}학기 그룹 ${source.groups.filter((item) => item.semester === group.semester).length}개를 함께 풀어 학년 간 교사 겹침이 편성 순서에 따라 달라지지 않게 합니다"${CLASS_SECTIONS_VIEW.running ? " disabled" : ""}>전 학년 함께 다시 계산</button>` : ""}
        ${result ? `<button class="button" id="classSectionsPartial" type="button"${CLASS_SECTIONS_VIEW.running ? " disabled" : ""}>바뀐 학생만 다시 계산</button>` : ""}
        <span class="cs-status" id="classSectionsStatus" role="status" aria-live="polite" data-state="${CLASS_SECTIONS_VIEW.status?.error ? "error" : "ok"}">${esc(CLASS_SECTIONS_VIEW.status?.text || "")}</span>
      </div>
    </section>
    ${classSectionsCompareHtml(group, entry)}
    ${result ? classSectionsResultHtml(round, group, entry, result, settings) : '<p class="cs-empty">아직 편성하지 않았습니다. 기준을 확인하고 ‘편성 계산’을 누르세요.</p>'}
    ${classSectionsClassUnitHtml(group, entry, settings)}`;
}

function classSectionsCompareHtml(group, entry) {
  const compare = CLASS_SECTIONS_VIEW.compare;
  if (!compare || compare.groupKey !== group.key || compare.round !== CLASS_SECTIONS_VIEW.round) return "";
  const esc = classSectionsEsc;
  const rows = compare.rows.map((row) => `<tr${row.mode === compare.recommended ? ' class="is-recommended"' : ""}>
    <th scope="row">${esc(row.label)}${row.mode === compare.recommended ? ' <span class="cs-tag">추천</span>' : ""}</th>
    <td>${row.unassigned}</td><td>${row.maxSpread}명 (평균 ${row.avgSpread})</td><td>${Math.round(row.sameHomeroomRatio * 100)}%</td><td>${row.moved === null || row.moved === undefined ? '<span title="앞 편성 결과가 없어 비교하지 않았습니다">–</span>' : row.moved}</td>
    <td><button class="button" type="button" data-cs-use-mode="${esc(row.mode)}"${(entry.mode || "move") === row.mode ? ' aria-pressed="true"' : ""}>이 방식으로 편성</button></td></tr>`).join("");
  return `<section class="cs-card" aria-label="편성 방식 비교"><h4>편성 방식 비교</h4>
    <p class="cs-note">${esc(compare.reason)}</p>
    <table class="cs-table"><thead><tr><th>방식</th><th>미배정</th><th>분반 인원 차이(최대)</th><th>같은 반끼리 비율</th><th>앞 편성 대비 이동</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <p class="cs-note">${compare.baselineAt ? `앞 편성 대비 이동 = ${esc(new Date(compare.baselineAt).toLocaleString("ko-KR"))}에 저장한 편성 결과에서 분반이 바뀐 학생·과목 수.` : "앞 편성 결과가 없어 이동 수는 ‘–’로 표시합니다."}</p></section>`;
}

function classSectionsResultHtml(round, group, entry, result, settings) {
  const esc = classSectionsEsc;
  const explain = result.explain || {};
  const teachers = classSectionsTeacherList(settings);
  const issues = (result.issues || []).filter((issue) => issue.type !== "unassigned");
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity !== "error");
  const suggestions = (explain.suggestions || []).map((item, index) => `<li>${esc(item.message)}${item.verified ? ' <span class="cs-tag">확인됨</span>' : ""}
    ${["capacity", "sections", "block-limit"].includes(item.type) ? `<button class="button" type="button" data-cs-apply="${index}">제안 적용</button>` : ""}</li>`).join("");
  const causes = (explain.causes || []).map((item) => `<li>${esc(item.message)}</li>`).join("");
  const blocks = result.blocks.map((block) => {
    const cards = block.sectionIds.map((id) => {
      const section = result.sections.find((item) => item.id === id);
      if (!section) return "";
      const department = settings.courseDepartments[section.courseKey] || group.courses.find((course) => course.key === section.courseKey)?.department || "";
      const eligible = teachers.filter((teacher) => teacher.departments.includes(department) || teacher.courses.includes(section.courseName));
      const pinned = entry.pins.teachers[section.id] || "";
      const teacherSelect = teachers.length ? `<select data-cs-teacher="${esc(section.id)}" data-focus-key="cs-teacher-${esc(section.id)}" aria-label="${esc(section.roomName)} 담당 교사">
        <option value="">${section.teacherId ? `자동(${esc(teachers.find((teacher) => teacher.id === section.teacherId)?.name || section.teacherId)})` : "자동(없음)"}</option>
        ${(eligible.length ? eligible : teachers).map((teacher) => `<option value="${esc(teacher.id)}"${pinned === teacher.id ? " selected" : ""}>${esc(teacher.name)}</option>`).join("")}</select>` : "";
      const over = section.size > section.capacity;
      return `<li class="cs-section${over ? " is-over" : ""}" data-section-id="${esc(section.id)}">
        <strong title="${esc(section.roomName)}">${esc(section.roomName)}</strong>
        <span class="cs-size" aria-label="인원">${section.size}/${section.capacity}명</span>
        <span class="cs-course" title="${esc(section.courseName)}">${esc(section.courseName)}</span>
        <span class="cs-controls">${teacherSelect}<label class="cs-pin"><input type="checkbox" data-cs-pin="${esc(section.id)}" data-cs-pin-block="${esc(block.id)}"${entry.pins.sections[section.id] ? " checked" : ""} aria-label="${esc(section.roomName)} 블록 고정"> 고정</label></span></li>`;
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
    <h4>편성 결과 <span class="cs-note">${esc(CLASS_SECTIONS_MODE_LABELS?.[result.mode] || result.mode)} · ${result.draft ? "확정 전 시안" : "확정 결과 기준"} · ${esc(new Date(result.createdAt).toLocaleString("ko-KR"))}</span></h4>
    <p class="cs-summary" id="classSectionsSummary" data-feasible="${explain.feasible ? "true" : "false"}">${esc(explain.summary || "")}</p>
    <p class="cs-note">미배정 ${metrics.unassignedStudents || 0}명 · 분반 인원 차이 최대 ${metrics.maxSpread || 0}명 · 같은 반끼리 ${Math.round((metrics.sameHomeroomRatio || 0) * 100)}%${metrics.moved !== null && metrics.moved !== undefined ? ` · 앞 편성 대비 이동 ${metrics.moved}` : ""}</p>
    ${causes ? `<h5>원인</h5><ul class="cs-list">${causes}</ul>` : ""}
    ${suggestions ? `<h5>제안</h5><ul class="cs-list" id="classSectionsSuggestions">${suggestions}</ul>` : ""}
    ${errors.length ? `<h5>오류 ${errors.length}건</h5><ul class="cs-list is-error">${errors.slice(0, 30).map((issue) => `<li>${esc(issue.message)}</li>`).join("")}</ul>` : ""}
    ${warnings.length ? `<details><summary>확인 ${warnings.length}건</summary><ul class="cs-list">${warnings.slice(0, 50).map((issue) => `<li>${esc(issue.message)}</li>`).join("")}</ul></details>` : ""}
    <div class="cs-blocks" data-scroll-key="cs-blocks">${blocks}</div>
    ${unassigned ? `<details open><summary>미배정 ${result.unassigned.length}건</summary><table class="cs-table"><thead><tr><th>학생</th><th>과목</th><th>사유</th></tr></thead><tbody>${unassigned}</tbody></table></details>` : ""}
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
      <span class="cs-note">${CLASS_SECTIONS_VIEW.classMap ? `내년 반 배정표 ${Object.keys(CLASS_SECTIONS_VIEW.classMap).length}명 반영` : "내년 반이 없으면 나이스 파일의 반·번호는 비우고 참고 열(현 학년-반-번호)을 붙입니다."}</span>
    </div>
  </section>`;
}

function classSectionsClassUnitHtml(group, entry, settings) {
  const courses = group.courses.filter((course) => settings.courseModes[course.key] === "class");
  if (!courses.length) return "";
  const esc = classSectionsEsc;
  const homerooms = [...new Set(group.students.map((student) => student.homeroom))].sort((a, b) => Number(a) - Number(b));
  const split = classSectionsClassUnitPlan(group, entry, settings);
  const rows = homerooms.map((room) => `<tr><th scope="row">${esc(room)}반</th><td><select data-cs-unit-room="${esc(room)}" data-focus-key="cs-unit-${esc(room)}" aria-label="${esc(room)}반 학급 단위 과목">
    ${courses.map((course) => `<option value="${esc(course.key)}"${split.assign[room] === course.key ? " selected" : ""}>${esc(course.name)}</option>`).join("")}</select></td></tr>`).join("");
  return `<section class="cs-card" aria-label="학급 단위 과목"><h4>학급 단위 과목 · 담임반 배정 <span class="cs-note">추천 비율 ${esc(split.ratio)} · 희망과 다른 학생 ${split.mismatched}명</span></h4>
    <p class="cs-note">학급 단위 과목은 이동 블록에서 빠집니다. 담임반마다 과목을 정하세요(추천은 분반 수 비율과 학생 희망을 따름).</p>
    <button class="button" type="button" id="classSectionsClassUnitReset">추천으로 되돌리기</button>
    <table class="cs-table"><thead><tr><th>담임반</th><th>과목</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function classSectionsClassUnitPlan(group, entry, settings) {
  const courses = group.courses.filter((course) => settings.courseModes[course.key] === "class").map((course) => ({ key: course.key, name: course.name,
    sections: entry.classCounts[course.key] !== undefined ? Number(entry.classCounts[course.key]) || 0 : course.classCount }));
  const homerooms = [...new Set(group.students.map((student) => student.homeroom))].map((id) => ({ id }));
  const split = typeof classSectionsClassUnitSplit === "function" ? classSectionsClassUnitSplit({ courses, homerooms, students: group.students }) : { assign: {}, ratio: "", mismatched: 0 };
  const manual = classSectionsPlain(entry.classUnit.assign) ? entry.classUnit.assign : {};
  return { ...split, assign: { ...split.assign, ...manual } };
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
    </div></section>`;
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
  } else if (item.type === "block-limit") {
    entry.maxSectionsPerBlock = item.maxSectionsPerBlock;
  }
  classSectionsChanged(false);
  classSectionsSolveCurrent("solve");
}

function classSectionsHandleClick(event) {
  const target = event.target.closest("button, [data-cs-group]");
  if (!target) return;
  if (target.dataset.csGroup) { CLASS_SECTIONS_VIEW.group = target.dataset.csGroup; CLASS_SECTIONS_VIEW.search = ""; renderClassSections(); return; }
  if (target.id === "classSectionsSolve") return void classSectionsSolveCurrent("solve");
  if (target.id === "classSectionsCompare") return void classSectionsSolveCurrent("compare");
  if (target.id === "classSectionsPartial") return void classSectionsSolveCurrent("partial");
  if (target.id === "classSectionsSolveSemester") return void classSectionsSolveSemesterCurrent();
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
  else if (data.csMode !== undefined) settings.courseModes[data.csMode] = target.value === "class" ? "class" : "move";
  else if (data.csDept !== undefined) settings.courseDepartments[data.csDept] = target.value;
  else if (data.csRoom !== undefined) settings.courseRooms[data.csRoom] = target.value.trim();
  else if (data.csBlockMax !== undefined) entry.blockMax[data.csBlockMax] = target.value === "" ? undefined : Number(target.value);
  else if (data.csBlockTimes !== undefined) entry.blockTimes[data.csBlockTimes] = target.value.trim();
  else if (data.csTeacher !== undefined) { if (target.value) entry.pins.teachers[data.csTeacher] = target.value; else delete entry.pins.teachers[data.csTeacher]; }
  else if (data.csPin !== undefined) { if (target.checked) entry.pins.sections[data.csPin] = data.csPinBlock; else delete entry.pins.sections[data.csPin]; }
  else if (data.csUnitRoom !== undefined) { if (!classSectionsPlain(entry.classUnit.assign)) entry.classUnit.assign = {}; entry.classUnit.assign[data.csUnitRoom] = target.value; }
  else if (target.id === "classSectionsStudentSearch") { CLASS_SECTIONS_VIEW.search = target.value; return renderClassSections(); }
  else if (target.id === "classSectionsClassMap") return void classSectionsReadClassMap(target.files?.[0]);
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
          settings.teachers.push({ id: `t-${department}-${k + 1}`, name: `${label} ${k + 1}`, department, unavailable: [] });
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
    else return;
  }
  if (typeof persistStateSoon === "function") persistStateSoon(); else if (typeof persistState === "function") persistState();
  if (typeof preserveViewDuring === "function") preserveViewDuring(["#classSectionsTeacherDialog"], renderClassSectionsTeachers); else renderClassSectionsTeachers();
}

// ---- 내보내기 ----
function classSectionsStudentNames(round) {
  const data = typeof roundStatusData === "function" ? roundStatusData(round) : null;
  return new Map((data?.students || []).map((student) => [`${student.grade}-${student.classroom}-${student.number}`, String(student.name || "")]));
}

async function classSectionsReadClassMap(file) {
  if (!file) return;
  try {
    const sheets = await parseWorkbook(await file.arrayBuffer());
    const { map, errors } = classSectionsClassMapFromRows(sheets[0]?.rows || []);
    CLASS_SECTIONS_VIEW.classMap = map;
    classSectionsSetStatus(`내년 반 배정표: ${Object.keys(map).length}명 읽음${errors.length ? ` · 확인 ${errors.length}건(${errors.slice(0, 2).join(" ")})` : ""}`, errors.length > 0);
  } catch (error) {
    classSectionsSetStatus(`내년 반 배정표를 읽지 못했습니다: ${error?.message || error}`, true);
  }
  renderClassSections();
}

function classSectionsExport(kind) {
  const context = classSectionsCurrent();
  if (!context?.entry || typeof createWorkbookBlob !== "function" || typeof downloadBlob !== "function") return;
  const { round, group, entry } = context;
  const result = entry.sectionResult;
  const year = String((Number($("#schoolYear")?.value) || new Date().getFullYear()) + 1);
  const base = `${year}_${group.targetGrade}학년_${group.semester}학기_${String(group.category).replace(/[\\/:*?"<>|]/g, "")}`;
  if (kind === "classMapTemplate") {
    const rows = [["현 학년", "현 반", "현 번호", "새 반", "새 번호"],
      ...group.students.map((student) => [group.grade, student.homeroom, student.number, "", ""])];
    return downloadBlob(createWorkbookBlob([{ name: "내년 반 배정", rows, widths: [10, 10, 10, 10, 10], freeze: "A2", orientation: "portrait" }]), `${year}_현${group.grade}학년_내년반배정표.xlsx`);
  }
  if (!result) return;
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
    return downloadBlob(createWorkbookBlob([{ name: "블록표", rows, widths: [8, 16, 18, 22, 8, 8, 14], merges: ["A1:G1"], freeze: "A3", orientation: "portrait" }]), `${base}_블록표.xlsx`);
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
    return downloadBlob(createWorkbookBlob(sheets), `${base}_분반명렬표.xlsx`);
  }
  if (kind === "neis") {
    const settings = classSectionsSettings();
    const courses = Object.fromEntries(group.courses.map((course) => {
      const department = settings.courseDepartments[course.key] || course.department;
      return [course.key, { family: classSectionsNeisFamily(course.area, department), credits: course.credits }];
    }));
    const map = CLASS_SECTIONS_VIEW.classMap || {};
    const students = group.students.map((student) => ({ key: student.key, classroom: map[student.key]?.classroom || "", number: map[student.key]?.number || "", name: names.get(student.key) || "" }));
    const { rows, warnings } = classSectionsNeisExport(result, { year, semester: group.semester, targetGrade: group.targetGrade, courses, students });
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
