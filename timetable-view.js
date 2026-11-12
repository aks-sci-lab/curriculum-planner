// 7단계 시간표 앱 연결(timetable-view.js): 5·6단계 자료를 시간표 입력으로 모은다(읽기 전용, 같은 값을 다시 입력받지 않음).
// class-sections-view.js 뒤에 로드한다. 화면은 아직 없다(docs/timetable-design.md 5.7의 T3에서 이 파일에 더한다).
// 자료 출처: 과목·학점·반 수·공통 과목 반별 담당·창체 시수 = 5단계 computeHoursStats, 블록·분반·분반 교사·학급 단위 과목·교사 명단·격자 = 6단계 state.classSections.
// 시간표에만 있는 조건(요일별 교시 수, 점심, 창체 나눔, 담임, 규칙, 장소)은 state.timetable.settings — 없으면 기본값으로 계산하고 '가정' 목록에 적는다.

// 차례: 순수 도우미(저장 복원·반 일부만 듣는 과목의 반 배정·점검 비교) → 자료 모으기(timetableInput) → '// ---- 화면' 아래 조건 설정·사전 점검 화면.

// 저장 복원(예전 저장분·백업에는 없음 → 빈 객체). settings = 시간표 조건, 숫자 키 = 차수별 결과(다음 걸음).
function timetableRestore(saved) {
  const plain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (!plain(saved)) return {};
  const result = {};
  for (const [key, value] of Object.entries(saved)) {
    if (key === "settings" && plain(value)) result.settings = value;
    else if (/^\d+$/.test(key) && plain(value)) result[key] = value;
  }
  return result;
}

// 반 일부만 듣는 학교 지정 과목(교차집중·분할 편성) 묶음: 5단계 항목의 item.split(같은 편제표 행)으로 묶는다.
// 돌려주는 값: [{ key: '학년|과목↔과목', grade, crossed, label, members: [{ subject, index, counts: { 1: 반 수, 2: 반 수 } }] }]
function timetableSplitGroups(items) {
  const groups = new Map();
  for (const item of items || []) {
    if (!item.split || !item.designated) continue;
    const id = `${item.grade}|${item.split.row}`;
    if (!groups.has(id)) groups.set(id, { grade: String(item.grade), crossed: Boolean(item.split.crossed), members: new Map() });
    const group = groups.get(id);
    if (!group.members.has(item.subject)) group.members.set(item.subject, { subject: item.subject, index: Number(item.split.index) || 0, counts: { 1: 0, 2: 0 } });
    group.members.get(item.subject).counts[String(item.semester)] = Number(item.autoClasses) || 0;
  }
  return [...groups.values()].map((group) => {
    const members = [...group.members.values()].sort((a, b) => a.index - b.index);
    const names = members.map((member) => member.subject);
    return { key: `${group.grade}|${names.join("↔")}`, grade: group.grade, crossed: group.crossed, members,
      label: `${group.grade}학년 ${names.join(group.crossed ? " ↔ " : " · ")}(${group.crossed ? "교차집중" : "분할 편성"})` };
  });
}

function timetableClassList(text, total) {
  const out = [];
  for (const token of String(text ?? "").split(/[,\s]+/).map((item) => item.trim().replace(/반$/, "")).filter(Boolean)) {
    const range = token.match(/^(\d+)\s*[-~]\s*(\d+)$/);
    if (range) { for (let n = Number(range[1]); n <= Number(range[2]) && n <= total; n += 1) out.push(String(n)); continue; }
    if (!/^\d+$/.test(token)) return null;
    out.push(String(Number(token)));
  }
  return out;
}

// 묶음의 반 배정: 기준 학기(1학기, 없으면 2학기)에 과목마다 듣는 반을 정하고, 교차집중이면 다른 학기는 서로 바꾼다.
// saved = { 과목: '1,2,3' }(기준 학기에 듣는 반, 한 과목을 비우면 남는 반). 반 수가 편제표 × 학급 수(1단계 교차집중 팝업의 1반 더 받을 과목 포함)와 다르면 쓰지 않고 errors에 적는다.
// 돌려주는 값: { base, classes: { 학기: { 과목: [반] } }, source: 'saved' | 'default', errors }
function timetableSplitPlan(group, total, saved = null) {
  const members = group.members;
  const base = members.some((member) => member.counts[1] > 0) ? "1" : "2";
  const other = base === "1" ? "2" : "1";
  const all = Array.from({ length: total }, (_, index) => String(index + 1));
  const rolling = (order, semester, pool = all) => {
    const out = {};
    let at = 0;
    for (const member of order) {
      const count = Math.min(member.counts[semester], pool.length);
      out[member.subject] = Array.from({ length: count }, (_, index) => pool[(at + index) % pool.length]).sort((x, y) => Number(x) - Number(y));
      at += count;
    }
    return out;
  };
  const errors = [];
  let assign = null;
  const given = members.filter((member) => String(saved?.[member.subject] ?? "").trim());
  if (given.length) {
    const picked = {};
    const used = new Set();
    let ok = true;
    for (const member of given) {
      const list = timetableClassList(saved[member.subject], total);
      if (!list || list.some((id) => !all.includes(id))) { errors.push(`${member.subject}: 반 번호를 1~${total} 사이 숫자로 적어 주세요(예: 1,2,3 또는 1-3).`); ok = false; continue; }
      const unique = [...new Set(list)];
      if (unique.some((id) => used.has(id))) { errors.push(`${member.subject}: 다른 과목과 겹치는 반이 있습니다.`); ok = false; continue; }
      if (unique.length !== member.counts[base]) { errors.push(`${member.subject}: ${base}학기 ${member.counts[base]}반이어야 합니다(지금 ${unique.length}반) — 편제표 × 학급 수.`); ok = false; continue; }
      unique.forEach((id) => used.add(id));
      picked[member.subject] = unique.sort((x, y) => Number(x) - Number(y));
    }
    if (ok) {
      const rest = members.filter((member) => !given.includes(member));
      Object.assign(picked, rolling(rest, base, all.filter((id) => !used.has(id))));
      assign = picked;
    }
  }
  const source = assign ? "saved" : "default";
  if (!assign) assign = rolling(members, base);
  const classes = { [base]: assign };
  if (members.some((member) => member.counts[other] > 0)) {
    const sameCounts = (map) => members.every((member) => (map[member.subject] || []).length === member.counts[other]);
    if (!group.crossed) classes[other] = sameCounts(assign) ? assign : rolling(members, other);
    else {
      // 교차집중: 한 학기에 이 과목을 들은 반은 다른 학기에 다른 과목을 듣는다(두 과목이면 맞바꿈).
      const swapped = members.length === 2 ? { [members[0].subject]: assign[members[1].subject] || [], [members[1].subject]: assign[members[0].subject] || [] } : null;
      classes[other] = swapped && sameCounts(swapped) ? swapped : rolling(members.slice().reverse(), other);
    }
  }
  return { base, classes, source, errors };
}

// 조건을 바꾸기 전·후 사전 점검 비교: 같은 항목(점검 번호 + 대상)끼리 맞춰 풀린 것·새로 생긴 것·달라진 것.
function timetableIssueChanges(before, after) {
  const keyOf = (issue) => `${issue.id}|${String(issue.cause).split(/[:(]/)[0].trim()}`;
  const serious = (issue) => issue.level !== "info";
  const index = (list) => { const map = new Map(); for (const issue of (list || []).filter(serious)) { const key = keyOf(issue); if (!map.has(key)) map.set(key, []); map.get(key).push(issue); } return map; };
  const old = index(before);
  const now = index(after);
  const resolved = [];
  const added = [];
  const changed = [];
  for (const [key, list] of old) {
    const next = now.get(key) || [];
    if (!next.length) resolved.push(...list);
    else if (list.map((issue) => issue.cause).join("\n") !== next.map((issue) => issue.cause).join("\n")) changed.push(...next.map((issue, order) => ({ before: list[order]?.cause || "", after: issue })));
  }
  for (const [key, list] of now) if (!old.has(key)) added.push(...list);
  return { resolved, added, changed };
}

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

  // 장소: 체육 교과 수업은 체육 장소 수를 넣었을 때만 장소 겹침을 점검한다.
  const venueOf = (department) => (department === "체육" && Number(tt.venues?.체육) > 0 ? "체육" : "");

  // ---- 반 수업(학교 지정 과목 등) ----
  const lessons = [];
  const selectHours = {}; // 5단계 선택과목 시수(6단계 분반 시수와 대조)
  const cursors = {};
  // 반 일부만 듣는 지정 과목(교차집중·분할 편성)의 반: 시간표 조건에서 받은 값, 없으면 앞 반부터 차례로(가정)
  const splits = timetableSplitGroups(stats?.items).map((group) => {
    const plan = timetableSplitPlan(group, Number(classCounts[group.grade]) || 0, tt.splitClasses?.[group.key]);
    for (const text of plan.errors) lack("warn", `${group.label} 반 배정: ${text} 앞 반부터 차례로 계산했습니다.`, "time", "반 일부만 듣는 과목");
    return { ...group, ...plan };
  });
  const splitOf = new Map(splits.flatMap((group) => group.members.map((member) => [`${group.grade}|${member.subject}`, group])));
  const lessonFor = (grade, subject, department, hours, count, extra = {}) => {
    const total = Number(classCounts[grade]) || 0;
    if (!total || !(count > 0) || !(hours > 0)) return;
    let classes;
    const split = splitOf.get(`${grade}|${subject}`);
    if (split && split.classes[semester]?.[subject]) {
      classes = split.classes[semester][subject];
      if (split.source === "default") extra.partial = true;
    } else if (count < total) {
      cursors[grade] ||= { at: 0 };
      classes = timetableRollingClasses(count, total, cursors[grade]);
      extra.partial = true;
    }
    const { partial, byClass, ...rest } = extra;
    if (!rest.venue && venueOf(department)) rest.venue = venueOf(department);
    if (partial && !assumptions.some((item) => item.key === `partial:${grade}`)) {
      assume(`partial:${grade}`, `${grade}학년: 반 일부만 듣는 학교 지정 과목(교차집중·분할 편성)은 앞 반부터 차례로 맡긴 것으로 계산(실제 반 배정과 다를 수 있음)`, "time", "반 일부만 듣는 과목");
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
        lessons.push({ id: `${group.key}|${key}|${room}`, grade, classes: [room], subject: course.name, department, hours, teacherIds: candidateIds(department), venue: rooms[key] || venueOf(department) });
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
        sections.push({ id: `${group.key}|${id}`, subject: course.name, department, credits, teacherId: teacherId || undefined, teacherIds: teacherId ? undefined : candidateIds(department), venue: rooms[section.courseKey] || venueOf(department) });
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
  return { input, assumptions, year, round, semester, creativeTotal,
    splits: splits.map((group) => ({ key: group.key, label: group.label, grade: group.grade, crossed: group.crossed, base: group.base, source: group.source, errors: group.errors,
      members: group.members.map((member) => ({ subject: member.subject, count: member.counts[group.base], classes: group.classes[group.base]?.[member.subject] || [], here: group.classes[semester]?.[member.subject] || [] })) })) };
}

// 지금 자료로 사전 점검: timetablePrecheck 결과 + 가정 목록.
function timetablePrecheckFor(round, semester = "1") {
  const prepared = timetableInput(round, semester);
  return { ...timetablePrecheck(prepared.input), assumptions: prepared.assumptions, year: prepared.year, round: prepared.round, semester: prepared.semester };
}

// ---- 화면: 조건 설정 + 사전 점검 결과(시간표 계산은 다음 걸음) ----
// 메뉴 '7. 시간표' = 내부 단계 6. 그리기 입구는 renderTimetable 하나(보이지 않으면 미루고, 다시 그릴 때 스크롤·포커스를 지킨다).
var TIMETABLE_VIEW = { semester: "1", open: { time: true }, prepared: null, result: null, change: "", before: null, changeInfo: null, status: "", statusError: false };
var TIMETABLE_LEVELS = [["hard", "반드시"], ["soft", "최대한"], ["off", "끔"]];
var TIMETABLE_RULE_FIELDS = [
  { key: "maxHours", label: "교사 주당 시수 상한(학기별)", min: 1, max: 40, unit: "시간" },
  { key: "run", label: "교사 연강 상한", min: 1, max: 8, unit: "시간 연속" },
  { key: "maxPerDay", label: "교사 하루 최대 수업", min: 1, max: 9, unit: "시간" },
  { key: "gap", label: "반 공강 금지(하루 안 빈칸은 뒤쪽만)", level: true },
  { key: "oncePerDay", label: "한 반의 한 과목은 하루 1번", level: true },
  { key: "lunch", label: "교사 점심(학년별 점심 칸 가운데 하나는 비움)", level: true },
  { key: "lunchSide", label: "교사 점심 앞뒤 한 시간씩 공강", level: true, later: true },
  { key: "sameSubjectDay", label: "교사 같은 날 같은 과목 줄이기", level: true, later: true },
  { key: "homeroom", label: "담임이 그 학년 반 수업을 맡으면 담임반 포함", level: true, later: true }
];
var TIMETABLE_ISSUE_LABELS = { block: "계산 불가", fail: "조건 위반", warn: "확인", info: "참고" };
var TIMETABLE_TEACHER_KINDS = ["증원", "순회", "강사", "겸임"];

function timetableEsc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

// 고칠 수 있는 시간표 조건(없으면 만든다).
function timetableSettingsEdit() {
  if (!state.timetable || typeof state.timetable !== "object") state.timetable = {};
  if (!state.timetable.settings || typeof state.timetable.settings !== "object") state.timetable.settings = {};
  return state.timetable.settings;
}

function timetableRound() {
  return typeof courseOpeningRound === "function" ? courseOpeningRound() : String(state.currentRound || "1");
}

function renderTimetable() {
  if (typeof deferRenderUntilStepVisible === "function" && deferRenderUntilStepVisible(6, "renderTimetable", renderTimetable)) return;
  if (typeof preserveViewDuring === "function") return preserveViewDuring(["#workflowStep6Panel"], renderTimetableView);
  return renderTimetableView();
}

function timetableWhereButtons(list) {
  return (list || []).map((where) => `<button class="tt-goto" type="button" data-tt-goto="${timetableEsc(where.key || "")}" data-tt-step="${timetableEsc(where.step)}">${timetableEsc(where.label)}${where.target ? ` · ${timetableEsc(where.target)}` : ""}</button>`).join("");
}

function timetableVerdictHtml(result) {
  const { block, fail, warn } = result.counts;
  const state = block ? "block" : fail ? "fail" : "ok";
  const text = block ? `계산을 시작할 수 없습니다 — 없는 자료 ${block}건을 먼저 채워야 합니다.`
    : fail ? `이대로는 필수 조건을 모두 지키는 시간표가 없습니다 — ${fail}건(조건을 고치거나 완화가 필요합니다).`
      : "사전 점검 통과 — 계산 전에 걸리는 곳이 없습니다(통과해도 계산에서 막힐 수 있습니다).";
  return `<p class="tt-verdict" id="timetableVerdict" data-state="${state}" role="status"><strong>${timetableEsc(text)}</strong>
    <span class="cs-note">계산 불가 ${block} · 조건 위반 ${fail} · 확인 ${warn}</span></p>`;
}

function timetableChangeHtml(info) {
  if (!info) return "";
  const line = (issue) => `<li>${timetableEsc(issue.cause)}</li>`;
  const parts = [];
  if (info.resolved.length) parts.push(`<div data-kind="resolved"><strong>풀림 ${info.resolved.length}</strong><ul>${info.resolved.map(line).join("")}</ul></div>`);
  if (info.changed.length) parts.push(`<div data-kind="changed"><strong>달라짐 ${info.changed.length}</strong><ul>${info.changed.map((item) => `<li>${timetableEsc(item.after.cause)}<span class="cs-note"> ← ${timetableEsc(item.before)}</span></li>`).join("")}</ul></div>`);
  if (info.added.length) parts.push(`<div data-kind="added"><strong>새로 생김 ${info.added.length}</strong><ul>${info.added.map(line).join("")}</ul></div>`);
  return `<section class="tt-change" id="timetableChange" data-resolved="${info.resolved.length}" data-added="${info.added.length}" data-changed="${info.changed.length}" aria-live="polite">
    <h4>방금 바꾼 조건: ${timetableEsc(info.label)}</h4>
    ${parts.length ? parts.join("") : '<p class="cs-note">사전 점검 결과는 그대로입니다.</p>'}</section>`;
}

function timetableIssuesHtml(result) {
  const shown = result.issues.filter((issue) => issue.level !== "info");
  const info = result.issues.filter((issue) => issue.level === "info");
  const item = (issue) => `<li class="tt-issue" data-tt-issue="${issue.id}" data-level="${issue.level}">
    <span class="tt-level" data-level="${issue.level}">${TIMETABLE_ISSUE_LABELS[issue.level] || issue.level}</span>
    <span class="tt-cause">${timetableEsc(issue.cause)}</span>
    ${issue.where?.length ? `<span class="tt-where">고칠 곳 ${timetableWhereButtons(issue.where)}</span>` : ""}</li>`;
  return `<section class="cs-card" id="timetablePrecheck" data-count="${shown.length}">
    <h4>사전 점검 <span class="cs-note">계산 전에 1초 안에 도는 필요 조건 점검입니다. '조건 위반'은 지금 조건으로는 반드시 걸리는 곳입니다.</span></h4>
    ${shown.length ? `<ul class="tt-issues">${shown.map(item).join("")}</ul>` : '<p class="cs-note">걸리는 곳이 없습니다.</p>'}
    ${info.length ? `<details class="tt-info"><summary>참고 ${info.length}건</summary><ul class="tt-issues">${info.map(item).join("")}</ul></details>` : ""}</section>`;
}

function timetableAssumptionsHtml(prepared) {
  if (!prepared.assumptions.length) return "";
  return `<section class="cs-card" id="timetableAssumptions" data-count="${prepared.assumptions.length}">
    <h4>가정 ${prepared.assumptions.length}건 <span class="cs-note">자료가 없어 기본값으로 채운 것입니다. 실제 값을 넣으면 사라집니다.</span></h4>
    <ul class="tt-issues">${prepared.assumptions.map((entry) => `<li class="tt-issue" data-tt-assumption="${timetableEsc(entry.key)}"><span class="tt-level" data-level="assume">가정</span>
      <span class="tt-cause">${timetableEsc(entry.text)}</span><span class="tt-where">넣는 곳 ${timetableWhereButtons([entry.where])}</span></li>`).join("")}</ul></section>`;
}

function timetableGradesHtml(result) {
  if (!result.grades.length) return "";
  const cell = (value) => (value === undefined || value === null ? "–" : timetableEsc(value));
  return `<section class="cs-card" id="timetableGrades"><h4>학년별 주간 칸 수 <span class="cs-note">반 수업 칸 = 주 칸 수 − 블록 − 창체. 같은 시간에 반 수업을 맡을 수 있는 교사가 반 수보다 적으면 반 수업은 하루 끝 쪽에만 놓을 수 있습니다.</span></h4>
    <div class="table-wrap"><table class="tt-table"><thead><tr><th>학년</th><th>반 수</th><th>주 칸 수</th><th>반 수업</th><th>블록</th><th>창체</th><th>합계</th><th>남는 칸(끝 교시)</th><th>반 수업 칸</th><th>같은 시간 반 수업 교사</th></tr></thead>
    <tbody>${result.grades.map((row) => `<tr data-tt-grade="${row.grade}"><th>${row.grade}학년</th><td>${cell(row.classes)}</td><td>${cell(row.slots)}</td><td>${cell(row.lessonHours)}</td><td>${cell(row.blockHours)}</td><td>${cell(row.creative)}</td>
      <td>${cell(row.total)}</td><td>${cell(row.spare)}</td><td>${cell(row.free)}</td><td>${row.simultaneous ? `${row.simultaneous}명` : "–"}</td></tr>`).join("")}</tbody></table></div></section>`;
}

function timetableSectionHtml(key, title, summary, body) {
  return `<details class="tt-section" data-tt-section="${key}"${TIMETABLE_VIEW.open[key] ? " open" : ""}><summary><strong>${timetableEsc(title)}</strong> <span class="cs-note">${timetableEsc(summary)}</span></summary><div class="tt-section-body">${body}</div></details>`;
}

function timetableConditionsHtml(prepared) {
  const tt = timetableSettings();
  const cs = classSectionsSettings();
  const input = prepared.input;
  const days = String(cs.gridDays || "").split(/[,\s]+/).filter(Boolean);
  const rules = { ...TIMETABLE_DEFAULT_RULES, ...(tt.rules || {}) };
  const lunch = tt.lunchAfter || TIMETABLE_DEFAULT_LUNCH;
  const creative = input.creative;
  const timesText = (list) => (Array.isArray(list) ? list.map((time) => (typeof time === "string" ? time : `${time.day}${time.period}`)).join(",") : String(list || ""));
  const gradeHours = (grade) => (typeof creative.grade === "object" && creative.grade ? Number(creative.grade[grade]) || 0 : Number(creative.grade) || 0);
  const mode = !tt.creative ? "fixed" : creative.byGroup ? "group" : !creative.school ? "grade" : "custom";
  const preset = (key, label) => `<button class="button" type="button" data-tt-creative-preset="${key}" aria-pressed="${mode === key}">${label}</button>`;

  // 시간 구조
  const periodInputs = days.map((day) => `<label>${day} <input class="cs-num" type="number" min="1" max="12" value="${timetableEsc(tt.periodsByDay?.[day] ?? cs.gridPeriods)}" data-tt-field="period:${day}" data-focus-key="tt-period-${day}" aria-label="${day}요일 교시 수"></label>`).join("");
  const lunchInputs = ["1", "2", "3"].map((grade) => `<label>${grade}학년 <input class="cs-num" type="number" min="1" max="11" value="${timetableEsc(lunch[grade] ?? 4)}" data-tt-field="lunch:${grade}" data-focus-key="tt-lunch-${grade}" aria-label="${grade}학년 점심 앞 교시"> 교시 뒤</label>`).join("");
  const gradeTimeInputs = ["1", "2", "3"].map((grade) => `<label>${grade}학년 <input class="cs-text" type="text" value="${timetableEsc(timesText(creative.gradeTimes?.[grade]))}" placeholder="비우면 계산이 정함" data-tt-field="creative.gradeTimes:${grade}" data-focus-key="tt-creative-times-${grade}" aria-label="${grade}학년 창체 시간"></label>`).join("");
  const fixedText = input.fixedSlots.length ? input.fixedSlots.map((slot) => `${slot.label || "고정"} ${timesText(slot.times)}`).join(" · ") : "없음";
  const roomsText = Object.entries(cs.rooms || {}).filter(([, value]) => Number(value) > 0).map(([name, value]) => `${name} ${value}`).join(" · ") || "없음";
  const time = `
    <div class="tt-row"><span class="tt-label">요일별 교시 수</span><span class="tt-fields">${periodInputs}</span><span class="cs-note">요일은 6단계 격자(${timetableEsc(cs.gridDays)})를 씁니다.</span></div>
    <div class="tt-row"><span class="tt-label">학년별 점심</span><span class="tt-fields">${lunchInputs}</span><span class="cs-note">점심이 다른 학년의 같은 교시는 실제 시각이 다릅니다.</span></div>
    <div class="tt-row" id="timetableCreative"><span class="tt-label">창체 ${prepared.creativeTotal}시간<br><span class="cs-note">시수는 5단계</span></span><span class="tt-fields">
      <span class="tt-presets" role="group" aria-label="창체 놓는 방식">${preset("fixed", "전교 동시(6단계 고정 시간)")}${preset("grade", "학년별로 놓기")}${preset("group", "학년별 + 반군별 허용")}</span>
      <label>전교 동시 <input class="cs-num" type="number" min="0" max="9" value="${timetableEsc(creative.school)}" data-tt-field="creative.school" data-focus-key="tt-creative-school" aria-label="전교 동시 창체 시수"> 시간</label>
      <label>전교 동시 시간 <input class="cs-text" type="text" value="${timetableEsc(timesText(creative.schoolTimes))}" placeholder="예: 금7 (비우면 계산이 정함)" data-tt-field="creative.schoolTimes" data-focus-key="tt-creative-school-times" aria-label="전교 동시 창체 시간"></label>
      <span>학년별 <strong id="timetableCreativeGrade">${["1", "2", "3"].map((grade) => gradeHours(grade)).join("·")}</strong>시간(1·2·3학년)</span>
      <span class="tt-sub">학년별 창체 시간 ${gradeTimeInputs}</span>
      <label><input type="checkbox" data-tt-field="creative.byGroup" ${creative.byGroup ? "checked" : ""}> 같은 학년 안에서 반 묶음마다 다른 시간 허용(반군별)</label>
    </span></div>
    <div class="tt-row"><span class="tt-label">장소</span><span class="tt-fields">
      <label>체육 동시 수업 <input class="cs-num" type="number" min="0" max="20" value="${timetableEsc(tt.venues?.체육 ?? "")}" data-tt-field="venue:체육" data-focus-key="tt-venue-pe" aria-label="체육 동시 수업 가능 반 수"> 반(비우면 점검 안 함)</label>
      <span>특별실: ${timetableEsc(roomsText)} ${timetableWhereButtons([timetableWhere("teachers", "특별실")])}</span></span></div>
    <div class="tt-row"><span class="tt-label">전교 고정 시간</span><span class="tt-fields"><span>${timetableEsc(fixedText)}</span> ${timetableWhereButtons([timetableWhere("teachers", "고정 시간")])}</span></div>`;

  // 규칙
  const ruleRows = TIMETABLE_RULE_FIELDS.map((field) => {
    const control = field.level
      ? `<select data-tt-field="rules.${field.key}" data-focus-key="tt-rule-${field.key}" aria-label="${timetableEsc(field.label)}">${TIMETABLE_LEVELS.map(([value, label]) => `<option value="${value}"${rules[field.key] === value ? " selected" : ""}>${label}</option>`).join("")}</select>`
      : `<input class="cs-num" type="number" min="${field.min}" max="${field.max}" value="${timetableEsc(rules[field.key])}" data-tt-field="rules.${field.key}" data-focus-key="tt-rule-${field.key}" aria-label="${timetableEsc(field.label)}"> ${field.unit}`;
    const changed = tt.rules && tt.rules[field.key] !== undefined && tt.rules[field.key] !== TIMETABLE_DEFAULT_RULES[field.key];
    return `<div class="tt-row" data-tt-rule="${field.key}"><span class="tt-label">${timetableEsc(field.label)}</span><span class="tt-fields">${control}
      ${changed ? `<span class="cs-badge" data-state="draft">기본값 ${timetableEsc(field.level ? TIMETABLE_LEVELS.find(([value]) => value === TIMETABLE_DEFAULT_RULES[field.key])?.[1] : TIMETABLE_DEFAULT_RULES[field.key])}에서 바꿈</span>` : ""}
      ${field.later ? '<span class="cs-note">시간표 계산에서 씁니다(사전 점검에는 영향 없음).</span>' : ""}</span></div>`;
  }).join("");
  const rulesBody = `${ruleRows}<div class="tt-row"><span class="tt-label"></span><span class="tt-fields"><button class="button" type="button" id="timetableRulesReset">규칙을 기본값으로</button>
    <span class="cs-note">'반드시'는 해가 없을 때만 완화 순서대로 풉니다(완화 순서 설정은 시간표 계산과 함께 들어옵니다).</span></span></div>`;

  // 교사 추가(증원·순회·강사): 6단계 교사 명단 한 곳에 더한다
  const listed = classSectionsTeacherList(cs).length;
  const added = cs.teachers.filter((teacher) => teacher && teacher.addedIn === "timetable");
  const departments = typeof HOURS_DEPARTMENTS !== "undefined" ? HOURS_DEPARTMENTS.map((department) => department.id) : [];
  const departmentName = (id) => (typeof hoursDepartmentName === "function" ? hoursDepartmentName(id) : id);
  const addedRows = added.map((teacher) => `<li data-tt-teacher="${timetableEsc(teacher.id)}"><strong>${timetableEsc(teacher.name)}</strong> · ${timetableEsc(teacher.kind || "추가")} · ${timetableEsc(teacher.department ? departmentName(teacher.department) : "교과 없음")}
    ${teacher.courses ? ` · 과목 ${timetableEsc(teacher.courses)}` : ""}${Array.isArray(teacher.days) && teacher.days.length ? ` · 출근 ${timetableEsc(teacher.days.join("·"))}` : ""}${Number(teacher.maxHours) > 0 ? ` · 상한 ${Number(teacher.maxHours)}시간` : ""}
    <button class="button" type="button" data-tt-teacher-remove="${timetableEsc(teacher.id)}">삭제</button></li>`).join("");
  const teachersBody = listed ? `
    <p class="cs-note">여기서 넣은 교사는 <strong>6단계 교사 명단</strong>에 더해집니다(명단은 한 곳). 6단계 분반 교사 배정에도 쓰이려면 6단계에서 다시 계산하세요. 5단계 교과별 교사 수는 바뀌지 않습니다.</p>
    ${added.length ? `<ul class="tt-teachers" id="timetableAddedTeachers">${addedRows}</ul>` : ""}
    <div class="tt-row"><span class="tt-label">교사 추가</span><span class="tt-fields">
      <label>이름 <input class="cs-text" type="text" id="timetableTeacherName" data-focus-key="tt-teacher-name" placeholder="예: 기술 강사"></label>
      <label>구분 <select id="timetableTeacherKind" data-focus-key="tt-teacher-kind">${TIMETABLE_TEACHER_KINDS.map((kind) => `<option>${kind}</option>`).join("")}</select></label>
      <label>담당 교과 <select id="timetableTeacherDepartment" data-focus-key="tt-teacher-department"><option value="">(고르기)</option>${departments.map((id) => `<option value="${timetableEsc(id)}">${timetableEsc(departmentName(id))}</option>`).join("")}</select></label>
      <label>담당 과목 <input class="cs-text" type="text" id="timetableTeacherCourses" data-focus-key="tt-teacher-courses" placeholder="쉼표로 구분(교과 대신·추가)"></label>
      <label>출근 요일 <input class="cs-text" type="text" id="timetableTeacherDays" data-focus-key="tt-teacher-days" placeholder="예: 화,목 (비우면 매일)"></label>
      <label>상한 <input class="cs-num" type="number" min="1" max="40" id="timetableTeacherMax" data-focus-key="tt-teacher-max" placeholder="${rules.maxHours}"> 시간</label>
      <button class="button primary" type="button" id="timetableTeacherAdd">교사 추가</button></span></div>`
    : `<p class="cs-note is-warn">6단계 교사 명단이 비어 있습니다. 먼저 6단계 '교사·시간 설정'에서 명단을 만드세요(5단계 교사 수로 명단 만들기). ${timetableWhereButtons([timetableWhere("teachers", "교사 명단")])}</p>`;

  // 반 일부만 듣는 과목(교차집중·분할 편성) 반 배정
  const saved = tt.splitClasses || {};
  const splitBody = prepared.splits.length ? prepared.splits.map((group) => {
    const editable = group.members.length === 2 ? group.members.slice(0, 1) : group.members;
    const inputs = editable.map((member) => `<label>${timetableEsc(member.subject)} <input class="cs-text" type="text" value="${timetableEsc(saved[group.key]?.[member.subject] ?? "")}" placeholder="${timetableEsc(member.classes.join(","))}"
      data-tt-field="split:${timetableEsc(group.key)}:${timetableEsc(member.subject)}" data-focus-key="tt-split-${timetableEsc(group.key)}-${timetableEsc(member.subject)}" aria-label="${timetableEsc(`${group.label} ${member.subject} ${group.base}학기 반`)}"> (${member.count}반)</label>`).join("");
    const now = group.members.map((member) => `${member.subject} ${member.here.length ? `${member.here.join(",")}반` : "없음"}`).join(" / ");
    return `<div class="tt-row" data-tt-split="${timetableEsc(group.key)}" data-source="${group.source}"><span class="tt-label">${timetableEsc(group.label)}<br><span class="cs-note">${group.base}학기에 듣는 반</span></span><span class="tt-fields">${inputs}
      <span class="tt-sub">이번 학기(${prepared.semester}학기): ${timetableEsc(now)}${group.source === "default" ? ' <span class="cs-badge" data-state="draft">가정: 앞 반부터</span>' : ""}</span>
      ${group.errors.map((text) => `<span class="cs-note is-warn">${timetableEsc(text)}</span>`).join("")}</span></div>`;
  }).join("") + `<p class="cs-note">과목마다 반 수는 편제표 × 학급 수(1단계 교차집중 팝업에서 고른 '1반 더 받을 과목' 포함)로 정해져 있어 여기서는 어느 반인지만 고릅니다. 교차집중은 다른 학기에 서로 맞바꿉니다.</p>`
    : '<p class="cs-note">반 일부만 듣는 학교 지정 과목(교차집중·분할 편성)이 없습니다.</p>';

  const timeSummary = `${days.map((day) => tt.periodsByDay?.[day] ?? cs.gridPeriods).join("·")}교시 · 창체 전교 ${creative.school} + 학년별 ${gradeHours("1")}${creative.byGroup ? " · 반군별 허용" : ""}`;
  const rulesSummary = `상한 ${rules.maxHours} · 연강 ${rules.run} · 하루 ${rules.maxPerDay} · 공강 ${TIMETABLE_LEVELS.find(([value]) => value === rules.gap)?.[1] || ""}`;
  return `<section class="cs-card" id="timetableConditions"><h4>조건 설정 <span class="cs-note">바꾸면 사전 점검이 바로 다시 돕니다. 5·6단계에서 온 값은 그 단계에서 고칩니다.</span></h4>
    <p class="tt-status${TIMETABLE_VIEW.statusError ? " is-error" : ""}" id="timetableStatus" role="status" aria-live="polite">${timetableEsc(TIMETABLE_VIEW.status)}</p>
    ${timetableSectionHtml("time", "시간 구조 · 창체 · 장소", timeSummary, time)}
    ${timetableSectionHtml("rules", "규칙", rulesSummary, rulesBody)}
    ${timetableSectionHtml("teachers", "교사 추가(증원·순회·강사)", added.length ? `추가한 교사 ${added.length}명` : "추가한 교사 없음", teachersBody)}
    ${timetableSectionHtml("split", "반 일부만 듣는 과목의 반", prepared.splits.length ? `${prepared.splits.length}묶음${prepared.splits.some((group) => group.source === "default") ? " · 가정 있음" : ""}` : "없음", splitBody)}
  </section>`;
}

function renderTimetableView() {
  const body = document.getElementById("timetableBody");
  if (!body) return;
  const round = timetableRound();
  const semester = TIMETABLE_VIEW.semester;
  for (const button of document.querySelectorAll("#timetableSemesterTabs [data-tt-semester]")) button.setAttribute("aria-pressed", String(button.dataset.ttSemester === semester));
  let prepared;
  let result;
  try {
    prepared = timetableInput(round, semester);
    result = timetablePrecheck(prepared.input);
  } catch (error) {
    body.innerHTML = `<p class="cs-note is-warn" id="timetableError">시간표 자료를 모으지 못했습니다: ${timetableEsc(error?.message || error)}</p>`;
    return;
  }
  const badge = document.getElementById("timetableRoundBadge");
  if (badge) badge.textContent = `${round}차 · ${prepared.year}학년도 ${semester}학기`;
  if (TIMETABLE_VIEW.change && TIMETABLE_VIEW.before && TIMETABLE_VIEW.before.semester === semester) {
    TIMETABLE_VIEW.changeInfo = { label: TIMETABLE_VIEW.change, ...timetableIssueChanges(TIMETABLE_VIEW.before.issues, result.issues) };
  }
  TIMETABLE_VIEW.change = "";
  TIMETABLE_VIEW.before = null;
  TIMETABLE_VIEW.prepared = prepared;
  TIMETABLE_VIEW.result = result;
  body.innerHTML = `${timetableVerdictHtml(result)}${timetableChangeHtml(TIMETABLE_VIEW.changeInfo)}${timetableConditionsHtml(prepared)}${timetableIssuesHtml(result)}${timetableAssumptionsHtml(prepared)}${timetableGradesHtml(result)}`;
}

// 조건 한 칸을 저장한다. 돌려주는 값: 바꾼 것 이름(화면의 '방금 바꾼 조건'), 못 쓰는 값이면 ""(상태 줄에 이유).
function timetableApplyField(field, target) {
  const settings = timetableSettingsEdit();
  const fail = (text) => { TIMETABLE_VIEW.status = text; TIMETABLE_VIEW.statusError = true; return ""; };
  const whole = (min, max) => { const value = Math.floor(Number(target.value)); return String(target.value).trim() !== "" && Number.isFinite(value) && value >= min && value <= max ? value : null; };
  const [name, ...rest] = field.split(":");
  const key = rest.join(":");
  if (name === "period") {
    const value = whole(1, 12);
    if (value === null) return fail("교시 수는 1~12 사이 숫자로 넣어 주세요.");
    settings.periodsByDay = { ...(settings.periodsByDay || {}), [key]: value };
    return `${key}요일 ${value}교시`;
  }
  if (name === "lunch") {
    const value = whole(1, 11);
    if (value === null) return fail("점심은 몇 교시 뒤인지 숫자로 넣어 주세요.");
    settings.lunchAfter = { ...TIMETABLE_DEFAULT_LUNCH, ...(settings.lunchAfter || {}), [key]: value };
    return `${key}학년 점심 ${value}교시 뒤`;
  }
  if (name === "venue") {
    const venues = { ...(settings.venues || {}) };
    if (String(target.value).trim() === "") delete venues[key];
    else { const value = whole(0, 20); if (value === null) return fail("동시에 수업할 수 있는 반 수를 숫자로 넣어 주세요."); venues[key] = value; }
    settings.venues = venues;
    return `${key} 장소 ${venues[key] ?? "점검 안 함"}`;
  }
  if (name.startsWith("rules.")) {
    const rule = name.slice(6);
    const spec = TIMETABLE_RULE_FIELDS.find((item) => item.key === rule);
    if (!spec) return "";
    let value;
    if (spec.level) value = TIMETABLE_LEVELS.some(([level]) => level === target.value) ? target.value : null;
    else value = whole(spec.min, spec.max);
    if (value === null) return fail(`${spec.label}: ${spec.min}~${spec.max} 사이 숫자로 넣어 주세요.`);
    const rules = { ...(settings.rules || {}), [rule]: value };
    if (value === TIMETABLE_DEFAULT_RULES[rule]) delete rules[rule];
    settings.rules = rules;
    return `${spec.label} → ${spec.level ? TIMETABLE_LEVELS.find(([level]) => level === value)[1] : value}`;
  }
  if (name.startsWith("creative.")) {
    const current = TIMETABLE_VIEW.prepared?.input.creative || { school: 0, schoolTimes: [], grade: 0, gradeTimes: {}, byGroup: false };
    const total = Number(TIMETABLE_VIEW.prepared?.creativeTotal) || 0;
    const keys = (list) => timetableTimes(list).map((time) => `${time.day}${time.period}`);
    const next = { school: Number(current.school) || 0, schoolTimes: keys(current.schoolTimes), grade: current.grade, byGroup: Boolean(current.byGroup),
      gradeTimes: Object.fromEntries(Object.entries(current.gradeTimes || {}).map(([grade, list]) => [grade, keys(list)])) };
    const part = name.slice(9);
    if (part === "school") {
      const value = whole(0, 9);
      if (value === null) return fail("전교 동시 창체 시수를 숫자로 넣어 주세요.");
      next.school = value;
      next.grade = Math.max(0, total - value);
      if (next.schoolTimes.length > value) next.schoolTimes = next.schoolTimes.slice(0, value);
    } else if (part === "schoolTimes") next.schoolTimes = keys(target.value);
    else if (part === "gradeTimes") next.gradeTimes = { ...next.gradeTimes, [key]: keys(target.value) };
    else if (part === "byGroup") next.byGroup = Boolean(target.checked);
    settings.creative = next;
    return part === "byGroup" ? `창체 반군별 ${next.byGroup ? "허용" : "허용 안 함"}` : `창체 전교 동시 ${next.school}시간${next.schoolTimes.length ? `(${next.schoolTimes.join(",")})` : ""} + 학년별 ${typeof next.grade === "object" ? "" : next.grade}시간`;
  }
  if (name === "split") {
    const cut = key.lastIndexOf(":");
    const groupKey = key.slice(0, cut);
    const subject = key.slice(cut + 1);
    const all = { ...(settings.splitClasses || {}) };
    const group = { ...(all[groupKey] || {}) };
    if (String(target.value).trim() === "") delete group[subject];
    else group[subject] = String(target.value).trim();
    if (Object.keys(group).length) all[groupKey] = group; else delete all[groupKey];
    settings.splitClasses = all;
    return `${subject} 반 배정`;
  }
  return "";
}

function timetableCreativePreset(kind) {
  const settings = timetableSettingsEdit();
  const total = Number(TIMETABLE_VIEW.prepared?.creativeTotal) || 0;
  if (kind === "fixed") { delete settings.creative; return "창체: 전교 동시(6단계 고정 시간)"; }
  settings.creative = { school: 0, schoolTimes: [], grade: total, gradeTimes: {}, byGroup: kind === "group" };
  return kind === "group" ? "창체: 학년별 + 반군별 허용" : "창체: 학년별로 놓기";
}

function timetableAddTeacher() {
  const cs = classSectionsSettings();
  const value = (id) => String(document.getElementById(id)?.value ?? "").trim();
  const fail = (text) => { TIMETABLE_VIEW.status = text; TIMETABLE_VIEW.statusError = true; return ""; };
  if (!classSectionsTeacherList(cs).length) return fail("먼저 6단계에서 교사 명단을 만드세요.");
  const name = value("timetableTeacherName");
  const department = value("timetableTeacherDepartment");
  const courses = value("timetableTeacherCourses");
  if (!name) return fail("추가할 교사의 이름을 넣어 주세요(예: 기술 강사).");
  if (!department && !courses) return fail("담당 교과를 고르거나 담당 과목을 적어 주세요.");
  if (cs.teachers.some((teacher) => teacher && String(teacher.name || "").trim() === name)) return fail(`'${name}' 교사가 이미 명단에 있습니다.`);
  const gridDays = String(cs.gridDays || "").split(/[,\s]+/).filter(Boolean);
  const days = gridDays.filter((day) => value("timetableTeacherDays").includes(day));
  const max = Math.floor(Number(value("timetableTeacherMax")));
  let serial = 1;
  while (cs.teachers.some((teacher) => teacher && String(teacher.id) === `t-add-${serial}`)) serial += 1;
  const teacher = { id: `t-add-${serial}`, name, department, courses, unavailable: [], kind: value("timetableTeacherKind") || TIMETABLE_TEACHER_KINDS[0], addedIn: "timetable" };
  if (days.length && days.length < gridDays.length) teacher.days = days;
  if (max > 0) teacher.maxHours = Math.min(40, max);
  cs.teachers.push(teacher);
  return `교사 추가 — ${name}(${teacher.kind})`;
}

function timetableRemoveTeacher(id) {
  const cs = classSectionsSettings();
  const teacher = cs.teachers.find((item) => item && String(item.id) === String(id) && item.addedIn === "timetable");
  if (!teacher) return "";
  for (const [round, groups] of Object.entries(state.classSections || {})) {
    if (!/^\d+$/.test(round) || !groups || typeof groups !== "object") continue;
    for (const entry of Object.values(groups)) {
      const result = entry?.sectionResult;
      if (result && ((result.sections || []).some((section) => String(section.teacherId || "") === String(id)) || Object.values(result.teacherOf || {}).some((value) => String(value) === String(id)))) {
        TIMETABLE_VIEW.status = `${teacher.name} 교사는 ${round}차 분반에 배정돼 있어 여기서 지울 수 없습니다(6단계에서 분반 교사를 바꾼 뒤 지우세요).`;
        TIMETABLE_VIEW.statusError = true;
        return "";
      }
    }
  }
  cs.teachers.splice(cs.teachers.indexOf(teacher), 1);
  return `교사 삭제 — ${teacher.name}`;
}

// 조건이 바뀐 뒤: 바꾸기 전 점검 결과를 기억해 두고(비교용) 저장 + 다시 그리기.
function timetableChanged(label) {
  if (label) {
    TIMETABLE_VIEW.status = "";
    TIMETABLE_VIEW.statusError = false;
    TIMETABLE_VIEW.change = label;
    TIMETABLE_VIEW.before = { semester: TIMETABLE_VIEW.semester, issues: TIMETABLE_VIEW.result?.issues || [] };
    if (typeof persistStateSoon === "function") persistStateSoon();
  }
  renderTimetable();
}

function timetableGoto(key, step) {
  if (Number(step) === 6) {
    const section = key === "rules" || key === "ladder" ? "rules" : "time";
    TIMETABLE_VIEW.open[section] = true;
    renderTimetable();
    const target = document.querySelector(`#workflowStep6Panel [data-tt-section="${section}"]`);
    target?.scrollIntoView?.({ block: "center" });
    target?.querySelector("input, select")?.focus?.();
    return;
  }
  if (typeof switchWorkflowStep === "function") switchWorkflowStep(Number(step));
  if (key === "teachers") document.getElementById("classSectionsTeachersOpen")?.click();
}

function timetableHandleClick(event) {
  const target = event.target;
  const tab = target.closest?.("[data-tt-semester]");
  if (tab) { TIMETABLE_VIEW.semester = tab.dataset.ttSemester === "2" ? "2" : "1"; TIMETABLE_VIEW.changeInfo = null; TIMETABLE_VIEW.status = ""; renderTimetable(); return; }
  const go = target.closest?.("[data-tt-goto]");
  if (go) { timetableGoto(go.dataset.ttGoto, go.dataset.ttStep); return; }
  const preset = target.closest?.("[data-tt-creative-preset]");
  if (preset) { timetableChanged(timetableCreativePreset(preset.dataset.ttCreativePreset)); return; }
  if (target.closest?.("#timetableRulesReset")) { const settings = timetableSettingsEdit(); if (settings.rules && Object.keys(settings.rules).length) { settings.rules = {}; timetableChanged("규칙을 기본값으로"); } return; }
  if (target.closest?.("#timetableTeacherAdd")) { timetableChanged(timetableAddTeacher()); return; }
  const remove = target.closest?.("[data-tt-teacher-remove]");
  if (remove) timetableChanged(timetableRemoveTeacher(remove.dataset.ttTeacherRemove));
}

function timetableHandleChange(event) {
  const field = event.target?.dataset?.ttField;
  if (field) timetableChanged(timetableApplyField(field, event.target));
}

function initTimetable() {
  const panel = document.getElementById("workflowStep6Panel");
  if (!panel || panel.dataset.ttBound) return;
  panel.dataset.ttBound = "1";
  panel.addEventListener("click", timetableHandleClick);
  panel.addEventListener("change", timetableHandleChange);
  // 접는 영역을 연 상태를 기억한다(다시 그려도 그대로). toggle은 위로 올라오지 않아 잡는 단계에서 받는다.
  panel.addEventListener("toggle", (event) => { const key = event.target?.dataset?.ttSection; if (key) TIMETABLE_VIEW.open[key] = event.target.open; }, true);
}

if (typeof document !== "undefined" && document.getElementById) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initTimetable);
  else initTimetable();
}
