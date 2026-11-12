// 7단계 시간표 앱 연결(timetable-view.js): 5·6단계 자료를 시간표 입력으로 모은다(읽기 전용, 같은 값을 다시 입력받지 않음).
// class-sections-view.js 뒤에 로드한다. 화면은 아직 없다(docs/timetable-design.md 5.7의 T3에서 이 파일에 더한다).
// 자료 출처: 과목·학점·반 수·공통 과목 반별 담당·창체 시수 = 5단계 computeHoursStats, 블록·분반·분반 교사·학급 단위 과목·교사 명단·격자 = 6단계 state.classSections.
// 시간표에만 있는 조건(요일별 교시 수, 점심, 창체 나눔, 담임, 규칙, 장소)은 state.timetable.settings — 없으면 기본값으로 계산하고 '가정' 목록에 적는다.

// 저장된 시간표 조건(없으면 빈 객체). 여기서는 읽기만 한다.
function timetableSettings() {
  const store = typeof state !== "undefined" && state && state.timetable && typeof state.timetable === "object" ? state.timetable : null;
  return store && store.settings && typeof store.settings === "object" ? store.settings : {};
}

var TIMETABLE_DEFAULT_LUNCH = { 1: 4, 2: 4, 3: 3 }; // 사용자 학교: 3학년은 3교시 뒤, 1·2학년은 4교시 뒤
var TIMETABLE_CREATIVE_LABEL = /창체|창의적|동아리|자율|진로/;

// 반 일부만 듣는 학교 지정 과목(교차집중·분할 편성)의 반: 같은 학년·학기 안에서 앞 반부터 차례로(가정).
function timetableRollingClasses(count, total, cursor) {
  const list = [];
  for (let index = 0; index < Math.min(count, total); index += 1) list.push(String(((cursor.at + index) % total) + 1));
  cursor.at = (cursor.at + count) % Math.max(1, total);
  return list;
}

// timetableInput(차수, 학기) → { input(timetableModel 입력), assumptions: [{ key, text, where }], year, round, semester }
// assumptions = 자료가 없어 기본값·어림으로 채운 것(화면의 '가정' 표시). 계산을 막아야 하는 누락은 input.missing(level block).
function timetableInput(round = typeof courseOpeningRound === "function" ? courseOpeningRound() : String(state.currentRound || "1"), semester = "1") {
  const year = typeof hoursTargetYear === "function" ? hoursTargetYear() : "";
  const compute = () => timetableInputCompute(String(round), String(semester), year);
  return typeof cachedByStateRevision === "function" ? cachedByStateRevision("timetableInput", `${round}|${semester}|${year}`, compute) : compute();
}

function timetableInputCompute(round, semester, year) {
  const assumptions = [];
  const missing = [];
  const notes = { undecided: [], staleSections: [], expandedClasses: false };
  const assume = (key, text, whereKey, target = "") => assumptions.push({ key, text, where: timetableWhere(whereKey, target) });
  const lack = (level, cause, whereKey, target = "") => { if (!missing.some((item) => item.cause === cause)) missing.push({ level, cause, where: [timetableWhere(whereKey, target)] }); };
  const tt = timetableSettings();
  const cs = classSectionsSettings();

  let stats = null;
  try { stats = typeof hoursStatsCached === "function" ? hoursStatsCached(year) : computeHoursStats(year); } catch (error) { lack("block", error?.message || "5단계 시수 통계를 계산할 수 없습니다.", "hours"); }
  const classCounts = stats?.classCounts || {};
  const grades = ["1", "2", "3"].map((grade) => ({ grade, classes: Number(classCounts[grade]) || 0 }));
  for (const item of grades) if (!item.classes) lack("block", `${item.grade}학년 내년 학급 수가 없습니다.`, "aggregate", "내년 학급 수");

  // ---- 시간 구조 ----
  if (!tt.periodsByDay) assume("periods", `요일별 교시 수: ${cs.gridDays} 모두 ${cs.gridPeriods}교시(6단계 격자)로 계산`, "time", "요일별 교시 수");
  if (!tt.lunchAfter) assume("lunch", "점심: 3학년은 3교시 뒤, 1·2학년은 4교시 뒤로 계산", "time", "학년별 점심");
  const creativeTotal = Number(stats?.creativeHours) || 0;
  const creativeSlots = cs.fixedSlots.filter((slot) => TIMETABLE_CREATIVE_LABEL.test(String(slot.label || "")));
  const fixedSlots = cs.fixedSlots.filter((slot) => !creativeSlots.includes(slot)).map((slot) => ({ label: slot.label, times: slot.times, allTeachers: slot.allTeachers !== false }));
  let creative;
  if (tt.creative && typeof tt.creative === "object") {
    creative = { school: Number(tt.creative.school) || 0, schoolTimes: tt.creative.schoolTimes || [], grade: tt.creative.grade ?? 0, gradeTimes: tt.creative.gradeTimes || {}, byGroup: Boolean(tt.creative.byGroup) };
  } else if (creativeSlots.length) {
    const times = creativeSlots.flatMap((slot) => timetableTimes(slot.times)).map((time) => `${time.day}${time.period}`);
    creative = { school: times.length, schoolTimes: times, grade: Math.max(0, creativeTotal - times.length), gradeTimes: {}, byGroup: false };
    assume("creative", `창체 ${creativeTotal}시간: 6단계 고정 시간 '${creativeSlots.map((slot) => slot.label).join(", ")}'(${times.join(",")})을 전교 동시로 계산${creative.grade ? ` + 학년별 ${creative.grade}시간` : ""}`, "time", "창체");
  } else {
    const school = Math.min(1, creativeTotal);
    creative = { school, schoolTimes: [], grade: creativeTotal - school, gradeTimes: {}, byGroup: false };
    if (creativeTotal) assume("creative", `창체 ${creativeTotal}시간: 전교 동시 ${school}시간(동아리) + 학년별 ${creativeTotal - school}시간으로 나누고 시간은 정하지 않음`, "time", "창체");
  }
  creative.expected = Object.fromEntries(grades.map((item) => [item.grade, creativeTotal]));

  // ---- 교사 ----
  const departmentName = (id) => (typeof hoursDepartmentName === "function" ? hoursDepartmentName(id) : id);
  const homeroomOf = new Map(Object.entries(tt.homerooms || {}).map(([room, id]) => [String(id), room]));
  if (!homeroomOf.size) assume("homeroom", "담임 명단 없음 → 담임 규칙(담임반 배정, 학년별 창체 시간 담임 비움)은 쓰지 않음", "teachers", "담임");
  const rawOf = new Map(cs.teachers.filter(Boolean).map((teacher) => [String(teacher.id), teacher]));
  let teachers = classSectionsTeacherList(cs).map((teacher) => {
    const raw = rawOf.get(teacher.id) || {};
    return { id: teacher.id, name: teacher.name, departments: teacher.departments, courses: teacher.courses,
      unavailable: teacher.unavailable.map((slot) => ({ day: slot.day, period: slot.period })), maxHours: Number(raw.maxHours) > 0 ? Number(raw.maxHours) : undefined,
      days: Array.isArray(raw.days) && raw.days.length ? raw.days : undefined, homeroom: homeroomOf.get(teacher.id) || "",
      placeholder: typeof classSectionsTeacherPlaceholder === "function" && classSectionsTeacherPlaceholder(raw, departmentName) };
  });
  if (!teachers.length) {
    const counts = stats?.settings?.teachers || {};
    for (const [department, value] of Object.entries(counts)) {
      for (let n = 1; n <= Math.floor(Number(value) || 0); n += 1) teachers.push({ id: `t-${department}-${n}`, name: `${departmentName(department)} ${n}`, departments: [department], courses: [], unavailable: [], homeroom: "", placeholder: true });
    }
    if (teachers.length) assume("teachers", `교사 명단 없음 → 5단계 교과별 교사 수(${teachers.length}명)로 자리 교사를 만들어 계산(불가 시간·출근 요일 모름)`, "teachers", "교사 명단");
  }
  if (!(Number(tt.rules?.maxHours) > 0)) assume("maxHours", `교사 주당 시수 상한 ${TIMETABLE_DEFAULT_RULES.maxHours}시간(학기별, 교사별 상한이 없으면)`, "rules", "교사 시수 상한");
  // 공통 교과(과학-공통·사회-공통)에 따로 정한 교사가 없으면 그 교과군 세부 교과 교사 모두가 후보
  const commonFallback = new Set();
  const candidateIds = (department) => {
    const match = String(department || "").match(/^(.+)-공통$/);
    if (!match || teachers.some((teacher) => teacher.departments.includes(department))) return undefined;
    commonFallback.add(match[1]);
    return teachers.filter((teacher) => teacher.departments.some((own) => own.startsWith(`${match[1]}-`))).map((teacher) => teacher.id);
  };

  // ---- 반 수업(학교 지정 과목 등) ----
  const lessons = [];
  const selectHours = {}; // 5단계 선택과목 시수(6단계 분반 시수와 대조)
  const cursors = {};
  const lessonFor = (grade, subject, department, hours, count, extra = {}) => {
    const total = Number(classCounts[grade]) || 0;
    if (!total || !(count > 0) || !(hours > 0)) return;
    let classes;
    if (count < total) {
      cursors[grade] ||= { at: 0 };
      classes = timetableRollingClasses(count, total, cursors[grade]);
      extra.partial = true;
    }
    const { partial, byClass, ...rest } = extra;
    if (partial && !assumptions.some((item) => item.key === `partial:${grade}`)) {
      assume(`partial:${grade}`, `${grade}학년: 반 일부만 듣는 학교 지정 과목(교차집중·분할 편성)은 앞 반부터 차례로 맡긴 것으로 계산(실제 반 배정과 다를 수 있음)`, "plan", "교차집중");
    }
    if (byClass) {
      for (const classNo of classes || Array.from({ length: total }, (_, index) => String(index + 1))) {
        const share = byClass[classNo];
        if (!share) { lessons.push({ id: `${grade}|${subject}|${classNo}`, grade, classes: [classNo], subject, department, hours, teacherIds: candidateIds(department), ...rest }); continue; }
        const parts = Object.entries(share).filter(([, value]) => Number(value) > 0).map(([id, value]) => ({ department: id, hours: Number(value) }));
        lessons.push({ id: `${grade}|${subject}|${classNo}`, grade, classes: [classNo], subject, department, hours, parts, ...rest });
      }
      return;
    }
    lessons.push({ id: `${grade}|${subject}`, grade, classes, subject, department, hours, teacherIds: candidateIds(department), ...rest });
  };
  const commonOf = {};
  const commonFor = (grade) => {
    if (!(grade in commonOf)) {
      try { commonOf[grade] = typeof hoursCommonClassAssignment === "function" ? hoursCommonClassAssignment(grade, semester, year) : {}; } catch { commonOf[grade] = {}; }
      if (commonOf[grade].matchesSaved === false && Object.keys(commonOf[grade]).length && !assumptions.some((item) => item.key === "common")) {
        assume("common", "공통 과목(통합과학·통합사회 등) 반별 담당은 5단계 자동 배분 값으로 계산(시수표 배분 칸을 직접 고친 값과 다름)", "hours", "공통 시수 배분");
      }
    }
    return commonOf[grade];
  };
  const gradesWithItems = new Set();
  for (const item of stats?.items || []) {
    gradesWithItems.add(item.grade);
    if (String(item.semester) !== semester) continue;
    if (item.expanded) notes.expandedClasses = true;
    if (/학기 미정/.test(item.basis || "")) notes.undecided.push(`${item.grade}학년 ${item.subject}`);
    const selective = item.kind !== "지정" && item.grade !== "1";
    if (selective && !item.missingStage4) { selectHours[item.grade] = (selectHours[item.grade] || 0) + (Number(item.hours) || 0); continue; } // 6단계 분반에서
    const count = item.designated ? Number(item.autoClasses) || 0 : Number(item.classes) || 0;
    if (!count) continue;
    if (!item.designated) assume(`manual:${item.key}`, `${item.grade}학년 ${item.subject}: 5단계 직접 입력 ${count}반을 앞 반부터 반 수업으로 계산`, "hours", item.subject);
    lessonFor(item.grade, item.subject, item.department, Number(item.credit) || 0, count, { byClass: commonFor(item.grade)[item.subject] });
  }
  // 신입생(내년 1학년) 편제표가 없으면 올해 1학년 편제표의 1학년 과목으로(가정)
  const fallbackGrades = new Set();
  if (stats && !gradesWithItems.has("1") && Number(classCounts["1"]) > 0 && typeof curriculumCohortLayout === "function" && typeof curriculumPlanEntries === "function") {
    const cohortYear = String(Number(year) - 1);
    const layout = curriculumCohortLayout(cohortYear);
    if (layout) {
      const separate = layout.planData && typeof curriculumSeparateApplicationRows === "function" ? curriculumSeparateApplicationRows(layout.planData) : null;
      const entries = curriculumPlanEntries(layout).entries.filter((entry) => entry.grade === "1" && String(entry.semester) === semester && entry.kind === "지정" && !separate?.has(entry.rowIndex));
      const seen = new Set();
      for (const entry of entries) {
        if (seen.has(entry.subject)) continue;
        seen.add(entry.subject);
        const total = Number(classCounts["1"]);
        const count = typeof hoursDesignatedShare === "function" ? hoursDesignatedShare(total, entry) : total;
        lessonFor("1", entry.subject, typeof hoursDefaultDepartment === "function" ? hoursDefaultDepartment(entry.subject, entry.area) : entry.area, Number(entry.credit) || 0, count);
      }
      if (entries.length) {
        fallbackGrades.add("1");
        assume("plan1", `1학년: ${year}학년도 입학생 편제표가 없어 ${cohortYear}학년도 입학생 편제표의 1학년 과목으로 계산(공통 과목 반별 담당은 교과군 교사 모두를 후보로)`, "plan", `${year}학년도 입학생 편제표`);
      }
    }
  }
  for (const issue of stats?.issues || []) {
    if (issue.level !== "error") continue;
    if (fallbackGrades.has("1") && /^1학년: .*편제표가 없습니다/.test(issue.text)) continue;
    const action = String(issue.action || "");
    lack("block", issue.text, action.startsWith("cohort:") ? "plan" : action === "results" ? "aggregate" : "hours");
  }

  // ---- 6단계: 이동수업 블록과 학급 단위 과목 ----
  const blocks = [];
  const sectionHours = {};
  const source = typeof classSectionsSource === "function" ? classSectionsSource(round) : { groups: [] };
  for (const group of source.groups.filter((item) => String(item.semester) === semester)) {
    const grade = String(group.targetGrade);
    const entry = classSectionsEntry(round, group.key, false);
    const modes = classSectionsCourseConf(cs, "courseModes", group.grade);
    const departments = classSectionsCourseConf(cs, "courseDepartments", group.grade);
    const rooms = classSectionsCourseConf(cs, "courseRooms", group.grade);
    const courseOf = new Map(group.courses.map((course) => [course.key, course]));
    const countOf = (course) => (entry?.classCounts?.[course.key] !== undefined ? Number(entry.classCounts[course.key]) || 0 : Number(course.classCount) || 0);
    const unitCourses = group.courses.filter((course) => modes[course.key] === "class" && !course.closed && countOf(course) > 0);
    if (unitCourses.length) {
      // 학급 단위 과목: 반 → 과목(6단계 배정)을 반 수업으로
      const plan = classSectionsClassUnitPlan(group, entry || { classCounts: {}, classUnit: {} }, cs);
      if (!plan.mapped) assume(`classUnit:${group.key}`, `${group.label}: 내년 반 배정표가 없어 학급 단위 과목의 반 배정은 6단계 자동 배정(학생 희망 미반영)으로 계산`, "sections", "내년 반 배정표");
      for (const [room, key] of Object.entries(plan.assign || {})) {
        const course = courseOf.get(key);
        if (!course) continue;
        const department = departments[key] || course.department;
        const hours = Number(course.credits) || Number(course.planCredits) || 0;
        lessons.push({ id: `${group.key}|${key}|${room}`, grade, classes: [room], subject: course.name, department, hours, teacherIds: candidateIds(department), venue: rooms[key] || "" });
        sectionHours[grade] = (sectionHours[grade] || 0) + hours;
      }
    }
    if (typeof classSectionsClassUnitOnly === "function" && classSectionsClassUnitOnly(group, entry, cs)) continue;
    if (unitCourses.length) lack("warn", `${group.label}: 일부 과목만 학급 단위입니다 — 학급 단위 반이 빠지는 블록을 아직 구분하지 못해 그 반의 주간 수업 수가 실제보다 많게 잡힐 수 있습니다.`, "sections", "학급 단위 과목");
    const result = entry?.sectionResult;
    if (!result?.sections?.length || !result?.blocks?.length) { lack("block", `${group.label}: 분반 편성 결과가 없습니다.`, "sections", group.label); continue; }
    try {
      if (typeof classSectionsSignature === "function" && result.signature !== classSectionsSignature(classSectionsBuildInput(round, group, entry))) notes.staleSections.push(group.label);
    } catch { /* 서명을 못 만들면 넘어간다 */ }
    const sectionOf = new Map(result.sections.map((section) => [section.id, section]));
    for (const block of result.blocks) {
      const letter = block.letter || block.id;
      const sections = [];
      for (const id of block.sectionIds || result.sections.filter((section) => section.blockId === block.id).map((section) => section.id)) {
        const section = sectionOf.get(id);
        const course = section && courseOf.get(section.courseKey);
        if (!section || !course) continue;
        const department = departments[section.courseKey] || course.department;
        const credits = Number(course.credits) || Number(course.planCredits) || 0;
        const teacherId = section.teacherId || result.teacherOf?.[id] || "";
        sections.push({ id: `${group.key}|${id}`, subject: course.name, department, credits, teacherId: teacherId || undefined, teacherIds: teacherId ? undefined : candidateIds(department), venue: rooms[section.courseKey] || "" });
        sectionHours[grade] = (sectionHours[grade] || 0) + credits;
      }
      if (!sections.length) continue;
      const times = entry.blockTimes?.[letter] !== undefined ? entry.blockTimes[letter] : (block.times || []);
      blocks.push({ id: `${group.key}|${letter}`, grade, label: `${group.category} ${letter}블록`, times: typeof times === "string" ? times.replace(/\//g, ",") : times, sections });
    }
  }
  for (const grade of Object.keys({ ...selectHours, ...sectionHours })) {
    const planned = selectHours[grade] || 0;
    const made = sectionHours[grade] || 0;
    if (planned !== made) lack("warn", `${grade}학년 ${semester}학기 선택과목: 5단계 시수 ${planned}시간 ≠ 6단계 분반 ${made}시간(분반 수·학점·학급 단위 과목을 확인하세요).`, "sections", "분반 수");
  }
  if (commonFallback.size) assume("commonTeachers", `${[...commonFallback].join("·")} 공통 과목에 따로 정한 교사가 없어 세부 교과 교사 모두를 후보로 계산`, "teachers", "담당 과목");
  notes.undecided = [...new Set(notes.undecided)];

  const venues = Object.fromEntries(Object.entries({ ...(cs.rooms || {}), ...(tt.venues || {}) }).map(([key, value]) => [key, Number(value) || 0]));
  const input = {
    semester, days: cs.gridDays, periods: Number(cs.gridPeriods) || 7, periodsByDay: tt.periodsByDay || {}, lunchAfter: tt.lunchAfter || TIMETABLE_DEFAULT_LUNCH,
    grades, creative, fixedSlots, teachers, lessons, blocks, venues, rules: tt.rules || {}, missing, notes
  };
  return { input, assumptions, year, round, semester };
}

// 지금 자료로 사전 점검: timetablePrecheck 결과 + 가정 목록.
function timetablePrecheckFor(round, semester = "1") {
  const prepared = timetableInput(round, semester);
  return { ...timetablePrecheck(prepared.input), assumptions: prepared.assumptions, year: prepared.year, round: prepared.round, semester: prepared.semester };
}
