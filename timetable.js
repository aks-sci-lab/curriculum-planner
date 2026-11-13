// 7단계 시간표 편성 순수 계산(timetable.js): 입력 모형과 사전 점검. DOM·state 없음(app.js보다 먼저 로드, Worker에서도 그대로 동작).
// 설계: docs/timetable-design.md. 조건(rules)은 모두 설정값이고 기본값은 TIMETABLE_DEFAULT_RULES 한 곳.
// 차례: 기본값·고칠 곳 → 작은 도우미(시간·매칭·유량) → timetableModel(입력 정리) → 사전 점검 P0~P11 → 6단계 미리 점검 규칙.

// "hard" = 반드시(해가 없을 때만 완화 사다리에서 풂), "soft" = 최대한, "off" = 끔.
const TIMETABLE_DEFAULT_RULES = {
  maxHours: 22,        // 교사 주당 시수 '참고' 상한(학기별): 넘어도 편성하고 알림만(5단계 교사 수가 두 학기 평균 기준이라 필수가 아님)
  departmentMax: { 진로: 10 }, // 교과별 필수 상한(진로 교사 10시간). 교사 명단에 교사별 상한이 있으면 그 값이 먼저
  run: 3,              // 연강 상한(실제 시각 축에서 연속 수업 수)
  maxPerDay: 6,        // 교사 하루 최대 수업 수
  gap: "hard",         // 반 공강 금지(하루 안 빈칸은 뒤쪽만)
  oncePerDay: "hard",  // 같은 교사가 같은 반(분반)에 하루 두 번 들어가지 않음(과목이 달라도, 교사가 다른 조각은 같은 날 가능)
  lunch: "hard",       // 교사 점심(학년별 점심 칸 중 하나는 비움)
  lunchSide: "soft",   // 점심 앞뒤 한 시간씩 공강
  sameSubjectDay: "soft", // 교사 기준 같은 날 같은 과목 최소화
  homeroom: "off",     // 담임이 그 학년 반 수업을 맡으면 담임반 포함(담임 명단이 있을 때만)
  semesterFrame: "hard", // 2학기는 1학기와 같은 뼈대(블록 자리, 이어지는 과목의 교사–반 짝과 요일·교시)
  minPerDay: 4, // 반 하루 최소 교시(수업이 있는 날) — shortDay 규칙의 기준
  shortDay: "soft", // 하루 최소 교시를 지킬지(반마다 하루 길이가 들쭉날쭉하지 않게)
  cover: "hard", // 교사를 세우는 것과 공강·하루 두 번 없애기가 부딪칠 때: hard = 교사 먼저(위반이 남을 수 있음), soft = 공강 먼저(그 수업은 담당 교사 없음으로)
  splitLesson: "allow" // 한 반의 한 과목을 한 교사가 통째로 맡을 수 없을 때(남은 시간이 모자람): allow = 같은 전공 교사 둘이 나눠서 모두 맡을 수 있으면 나눠 맡음, off = 나누지 않음(그 수업은 담당 교사 없음)
};

// 고칠 곳: step = 내부 단계 번호(1 편제표, 4 집계, 7 = 5단계 시수, 8 = 6단계 분반, 6 = 7단계 시간표).
const TIMETABLE_WHERE = {
  plan: { step: 1, label: "1단계 편제표" },
  aggregate: { step: 4, label: "4단계 집계·개설 확정" },
  hours: { step: 7, label: "5단계 시수 통계(교사 수·공통 과목 배분)" },
  sections: { step: 8, label: "6단계 분반 편성(분반·블록·분반 교사)" },
  teachers: { step: 8, label: "6단계 교사·시간 설정(교사 명단)" },
  time: { step: 6, label: "시간표 조건 · 시간 구조" },
  rules: { step: 6, label: "시간표 조건 · 규칙" },
  ladder: { step: 6, label: "시간표 조건 · 완화 순서" },
  venues: { step: 6, label: "시간표 조건 · 장소" }
};
function timetableWhere(key, target = "") {
  const base = TIMETABLE_WHERE[key] || { step: 6, label: String(key) };
  return target ? { key, ...base, target } : { key, ...base };
}

// ---- 작은 도우미 ----
function timetableParseTime(value) {
  if (value && typeof value === "object") return value.day && Number(value.period) > 0 ? { day: String(value.day), period: Number(value.period) } : null;
  const match = String(value ?? "").trim().match(/^([월화수목금토일])\s*:?\s*(\d{1,2})$/);
  return match ? { day: match[1], period: Number(match[2]) } : null;
}
function timetableTimes(list) {
  const items = Array.isArray(list) ? list : String(list ?? "").split(/[,\s]+/);
  return items.map(timetableParseTime).filter(Boolean);
}
function timetableNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

// 이분 매칭(왼쪽 i → 오른쪽 후보 목록). 돌려주는 값: { size, matchOfLeft: [오른쪽 | undefined] }
function timetableMatch(adjacency) {
  const owner = new Map();
  const matchOfLeft = new Array(adjacency.length).fill(undefined);
  const attempt = (left, seen) => {
    for (const right of adjacency[left]) {
      if (seen.has(right)) continue;
      seen.add(right);
      if (!owner.has(right) || attempt(owner.get(right), seen)) {
        owner.set(right, left);
        matchOfLeft[left] = right;
        return true;
      }
    }
    return false;
  };
  let size = 0;
  for (let left = 0; left < adjacency.length; left += 1) if (attempt(left, new Set())) size += 1;
  return { size, matchOfLeft };
}

// 수요 묶음(시수, 맡을 수 있는 교사들) ↔ 교사 용량의 최대 유량. 모자라면 모자란 묶음끼리(같은 교사로 이어진 것끼리) 뭉쳐 돌려준다.
// groups: [{ hours, candidates: [교사 id], ... }], capacityOf(id) → 시수. 돌려주는 값: { total, flow, clusters: [{ groups, teachers, demand, capacity, shortage }] }
function timetableCoverage(groups, capacityOf) {
  const teacherIds = [...new Set(groups.flatMap((group) => group.candidates))];
  const teacherAt = new Map(teacherIds.map((id, index) => [id, index]));
  const G = groups.length;
  const T = teacherIds.length;
  const source = G + T;
  const sink = G + T + 1;
  const head = new Array(G + T + 2).fill(-1);
  const to = [];
  const cap = [];
  const next = [];
  const edge = (from, target, capacity) => {
    to.push(target); cap.push(capacity); next.push(head[from]); head[from] = to.length - 1;
    to.push(from); cap.push(0); next.push(head[target]); head[target] = to.length - 1;
  };
  let total = 0;
  groups.forEach((group, index) => {
    total += group.hours;
    edge(source, index, group.hours);
    for (const id of group.candidates) edge(index, G + teacherAt.get(id), Infinity);
  });
  teacherIds.forEach((id, index) => edge(G + index, sink, Math.max(0, Number(capacityOf(id)) || 0)));
  let flow = 0;
  const level = new Array(G + T + 2);
  const bfs = () => {
    level.fill(-1);
    level[source] = 0;
    const queue = [source];
    for (let at = 0; at < queue.length; at += 1) {
      for (let e = head[queue[at]]; e !== -1; e = next[e]) {
        if (cap[e] > 0 && level[to[e]] < 0) { level[to[e]] = level[queue[at]] + 1; queue.push(to[e]); }
      }
    }
    return level[sink] >= 0;
  };
  const cursor = new Array(G + T + 2);
  const dfs = (node, pushed) => {
    if (node === sink) return pushed;
    for (; cursor[node] !== -1; cursor[node] = next[cursor[node]]) {
      const e = cursor[node];
      if (cap[e] > 0 && level[to[e]] === level[node] + 1) {
        const got = dfs(to[e], Math.min(pushed, cap[e]));
        if (got > 0) { cap[e] -= got; cap[e ^ 1] += got; return got; }
      }
    }
    return 0;
  };
  while (bfs()) {
    for (let node = 0; node < head.length; node += 1) cursor[node] = head[node];
    for (let got = dfs(source, Infinity); got > 0; got = dfs(source, Infinity)) flow += got;
  }
  const clusters = [];
  if (flow < total - 1e-9) {
    bfs(); // level >= 0 = 남은 그래프에서 출발점에서 닿는 곳(최소 절단의 출발 쪽)
    const short = groups.map((_, index) => index).filter((index) => level[index] >= 0);
    const seen = new Set();
    for (const start of short) {
      if (seen.has(start)) continue;
      const members = [];
      const teachers = new Set();
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const index = stack.pop();
        members.push(index);
        for (const id of groups[index].candidates) {
          if (teachers.has(id)) continue;
          teachers.add(id);
          for (const other of short) {
            if (!seen.has(other) && groups[other].candidates.includes(id)) { seen.add(other); stack.push(other); }
          }
        }
      }
      const demand = members.reduce((sum, index) => sum + groups[index].hours, 0);
      const capacity = [...teachers].reduce((sum, id) => sum + Math.max(0, Number(capacityOf(id)) || 0), 0);
      if (demand > capacity) clusters.push({ groups: members.sort((a, b) => a - b).map((index) => groups[index]), teachers: [...teachers], demand, capacity, shortage: demand - capacity });
    }
  }
  return { total, flow, clusters };
}

// 교사 하루 최대 수업 수: 쓸 수 있는 실제 시각 칸(비트) 안에서 연강 상한·점심(점심 칸 중 하나는 비움)·하루 최대를 지키는 가장 큰 수.
function timetableDayCapacity(available, positions, rules, lunchPositions) {
  if (!available) return 0;
  const run = timetableNumber(rules.run, 0);
  const lunchHard = rules.lunch === "hard" && lunchPositions.length > 0;
  let best = 0;
  for (let mask = available; ; mask = (mask - 1) & available) {
    let count = 0;
    let streak = 0;
    let ok = true;
    for (let pos = 0; pos < positions && ok; pos += 1) {
      if (mask & (1 << pos)) { count += 1; streak += 1; if (run && streak > run) ok = false; } else streak = 0;
    }
    if (ok && lunchHard && lunchPositions.every((pos) => mask & (1 << pos))) ok = false;
    if (ok && count > best) best = count;
    if (!mask) break;
  }
  return Math.min(best, timetableNumber(rules.maxPerDay, Infinity));
}

// ---- 입력 정리 ----
// input = {
//   semester, days: ["월",…] | "월,화,…", periods: 7, periodsByDay: { 수: 6 }, lunchAfter: { "3": 3 }(기본 4),
//   grades: [{ grade: "1", classes: 10 | ["1-1", …] }],
//   creative: { school: 전교 동시 시수, schoolTimes: ["금7"], grade: 학년별 시수(숫자 | { 학년: n }), gradeTimes: { 학년: [..] }, byGroup: 반군별 허용, expected: { 학년: 5단계 창체 시수 } },
//   fixedSlots: [{ label, times, allTeachers }],
//   teachers: [{ id, name, departments, courses, maxHours, unavailable: ["월4" | { day, period } | { day, pos }], days: 출근 요일, placeholder, homeroom: "2-3" }],
//   lessons: [{ id, grade, classes: 생략 = 학년 전체 | ["1", "3-2"], subject, department, hours, teacherId, teacherIds, teacherByClass, venue, double,
//               parts: [{ department, hours, teacherId, teacherIds }] }],          // 반 수업(parts = 통합과학처럼 교사 여럿이 나눠 맡는 수업)
//   blocks: [{ id, grade, label, hours, classes, times, sections: [{ id, subject, department, credits, teacherId, teacherIds, venue }] }],
//   pins: { lessons: { 수업 id: ['월3', …] }, teachers: { 수업 id: 교사 id } }(교사가 고정한 칸·담당 교사 — 수업 id = '과목 id@반'),
//   venues: { 체육: 3 }, rules, missing: [{ level, cause, where }], notes: { expandedClasses, undecided: [..], staleSections: [..] }
// }
function timetableModel(input = {}) {
  const rules = { ...TIMETABLE_DEFAULT_RULES, ...(input.rules || {}) };
  rules.departmentMax = { ...TIMETABLE_DEFAULT_RULES.departmentMax, ...(input.rules?.departmentMax || {}) };
  const days = (Array.isArray(input.days) ? input.days : String(input.days || "월,화,수,목,금").split(/[,\s]+/)).map(String).filter(Boolean);
  const basePeriods = Math.min(12, timetableNumber(input.periods, 7));
  const periodsOf = Object.fromEntries(days.map((day) => [day, Math.min(12, timetableNumber(input.periodsByDay?.[day], basePeriods))]));
  const maxPeriods = Math.max(0, ...Object.values(periodsOf));
  const positions = maxPeriods + 1; // 실제 시각 축: 교시 + 점심 한 칸
  const dayAt = new Map(days.map((day, index) => [day, index]));
  const lunchOf = (grade) => Math.min(maxPeriods, timetableNumber(input.lunchAfter?.[grade], 4));
  const posOf = (grade, period) => (period <= lunchOf(grade) ? period - 1 : period);

  const grades = (input.grades || []).map((item) => {
    const grade = String(item.grade);
    const classes = Array.isArray(item.classes) ? item.classes.map((id) => (String(id).includes("-") ? String(id) : `${grade}-${id}`))
      : Array.from({ length: Math.max(0, Math.floor(Number(item.classes) || 0)) }, (_, index) => `${grade}-${index + 1}`);
    const slots = [];
    days.forEach((day, d) => {
      for (let period = 1; period <= periodsOf[day]; period += 1) slots.push({ key: `${day}${period}`, day, d, period, abs: d * positions + posOf(grade, period) });
    });
    return { grade, classes, slots, slotCount: slots.length, lunchAfter: lunchOf(grade), slotByKey: new Map(slots.map((slot) => [slot.key, slot])) };
  });
  const gradeOf = new Map(grades.map((item) => [item.grade, item]));
  const lunchPositions = [...new Set(grades.map((item) => item.lunchAfter))].sort((a, b) => a - b);
  // 교시로 적힌 시간은 학년마다 실제 시각이 다를 수 있다(점심이 다른 학년) → 가능한 실제 시각 칸 모두.
  const absOfTime = (time) => {
    const d = dayAt.get(time.day);
    if (d === undefined || !(time.period >= 1) || time.period > periodsOf[time.day]) return [];
    const list = grades.length ? grades.map((item) => posOf(item.grade, time.period)) : [time.period - 1];
    return [...new Set(list)].map((pos) => d * positions + pos);
  };

  const creativeInput = input.creative || {};
  const schoolTimes = timetableTimes(creativeInput.schoolTimes);
  const creative = {
    school: timetableNumber(creativeInput.school, 0), schoolTimes, byGroup: Boolean(creativeInput.byGroup), byGrade: {},
    fromPeriod: Math.max(1, timetableNumber(creativeInput.fromPeriod, 1)) // 시간이 정해지지 않은 창체를 놓을 수 있는 첫 교시(1 = 제한 없음)
  };
  for (const item of grades) {
    const own = typeof creativeInput.grade === "object" && creativeInput.grade ? timetableNumber(creativeInput.grade[item.grade], 0) : timetableNumber(creativeInput.grade, 0);
    const expected = creativeInput.expected && creativeInput.expected[item.grade] !== undefined ? Number(creativeInput.expected[item.grade]) || 0 : null;
    creative.byGrade[item.grade] = { school: creative.school, grade: own, total: creative.school + own, expected, times: timetableTimes(creativeInput.gradeTimes?.[item.grade]) };
  }

  const fixed = (input.fixedSlots || []).map((slot) => ({ label: String(slot.label || ""), times: timetableTimes(slot.times), allTeachers: slot.allTeachers !== false }));
  const busyList = [...fixed.filter((slot) => slot.allTeachers).flatMap((slot) => slot.times), ...schoolTimes];
  const everyoneBusy = new Set(busyList.flatMap(absOfTime));
  const busyTimes = new Set(busyList.map((time) => `${time.day}${time.period}`)); // 전 교사가 묶이는 칸(교시 기준)

  const teachers = (input.teachers || []).map((teacher) => {
    const blocked = new Set(everyoneBusy);
    for (const entry of teacher.unavailable || []) {
      if (entry && typeof entry === "object" && entry.pos !== undefined && dayAt.has(String(entry.day))) blocked.add(dayAt.get(String(entry.day)) * positions + Number(entry.pos));
      else for (const time of timetableTimes([entry])) for (const abs of absOfTime(time)) blocked.add(abs);
    }
    const attend = Array.isArray(teacher.days) && teacher.days.length ? new Set(teacher.days.map(String)) : null;
    if (attend) days.forEach((day, d) => { if (!attend.has(day)) for (let pos = 0; pos < positions; pos += 1) blocked.add(d * positions + pos); });
    return { id: String(teacher.id), name: String(teacher.name || teacher.id), departments: (teacher.departments || []).map(String), courses: (teacher.courses || []).map(String),
      maxHours: timetableNumber(teacher.maxHours, 0) || Math.min(Infinity, ...(teacher.departments || []).map((department) => timetableNumber(rules.departmentMax?.[department], Infinity))), // 필수 상한(없으면 Infinity)
      softHours: timetableNumber(rules.maxHours, Infinity), ownMax: timetableNumber(teacher.maxHours, 0) > 0, blocked, placeholder: Boolean(teacher.placeholder), homeroom: teacher.homeroom ? String(teacher.homeroom) : "" };
  });
  const teacherOf = new Map(teachers.map((teacher) => [teacher.id, teacher]));
  const candidatesFor = (item, fixedId) => {
    const one = fixedId || item.teacherId;
    if (one) return teacherOf.has(String(one)) ? [String(one)] : [];
    if (Array.isArray(item.teacherIds) && item.teacherIds.length) return item.teacherIds.map(String).filter((id) => teacherOf.has(id));
    return teachers.filter((teacher) => teacher.courses.includes(String(item.subject || "")) || teacher.departments.includes(String(item.department || ""))).map((teacher) => teacher.id);
  };

  const lessons = [];
  (input.lessons || []).forEach((lesson, index) => {
    const grade = gradeOf.get(String(lesson.grade));
    if (!grade) return;
    const classIds = Array.isArray(lesson.classes) ? lesson.classes.map((id) => (String(id).includes("-") ? String(id) : `${grade.grade}-${id}`)).filter((id) => grade.classes.includes(id)) : grade.classes;
    const parts = Array.isArray(lesson.parts) && lesson.parts.length ? lesson.parts : [null];
    for (const classId of classIds) {
      parts.forEach((part, partIndex) => {
        const hours = timetableNumber(part ? part.hours : lesson.hours, 0);
        if (!hours) return;
        const merged = part ? { subject: lesson.subject, department: part.department ?? lesson.department, teacherId: part.teacherId, teacherIds: part.teacherIds } : lesson;
        const fixedId = part ? part.teacherId : lesson.teacherByClass?.[classId] || lesson.teacherByClass?.[classId.split("-")[1]] || lesson.teacherId;
        let candidates = candidatesFor(merged, fixedId);
        const lessonId = `${lesson.id || `L${index + 1}`}@${classId}${part ? `#${partIndex + 1}` : ""}`;
        // 고정한 담당 교사(input.pins.teachers[수업 id] = 교사 id): 그 교사가 이 수업의 후보(전공 일치)일 때만 — 그 수업은 그 교사만 맡는다
        const pinnedTeacher = String(input.pins?.teachers?.[lessonId] || "");
        const teacherPinned = Boolean(pinnedTeacher) && !(fixedId && candidates.length === 1) && candidates.includes(pinnedTeacher);
        if (teacherPinned) candidates = [pinnedTeacher];
        // 고정한 칸(input.pins.lessons[수업 id] = ['월3', …]): 그 수업의 시간 가운데 그만큼은 그 칸에 둔다(격자에 없는 칸·시수보다 많은 것은 버림)
        const pins = [...new Set((input.pins?.lessons?.[lessonId] || []).map(String))].filter((key) => grade.slotByKey.has(key)).slice(0, hours);
        lessons.push({ id: lessonId, pins, grade: grade.grade, classId, subject: String(lesson.subject || ""),
          department: String(merged.department || ""), hours, candidates, fixedTeacher: (fixedId || teacherPinned) && candidates.length === 1 ? candidates[0] : "", teacherPinned, unknownTeacher: Boolean(fixedId) && !candidates.length,
          venue: String(lesson.venue || ""), double: Boolean(lesson.double), part: part ? partIndex + 1 : 0, mismatch: Boolean(lesson.teacherMismatch) && Boolean(fixedId) });
      });
    }
  });

  const blocks = [];
  (input.blocks || []).forEach((block, index) => {
    const grade = gradeOf.get(String(block.grade));
    if (!grade) return;
    const classIds = Array.isArray(block.classes) && block.classes.length ? block.classes.map((id) => (String(id).includes("-") ? String(id) : `${grade.grade}-${id}`)).filter((id) => grade.classes.includes(id)) : grade.classes;
    const times = timetableTimes(block.times);
    const sections = (block.sections || []).map((section, order) => {
      const candidates = candidatesFor(section);
      return { id: String(section.id || `${block.id || index + 1}-${order + 1}`), subject: String(section.subject || ""), department: String(section.department || ""),
        credits: timetableNumber(section.credits, 0), candidates, fixedTeacher: section.teacherId && candidates.length === 1 ? candidates[0] : "", unknownTeacher: Boolean(section.teacherId) && !candidates.length, venue: String(section.venue || ""), mismatch: Boolean(section.teacherMismatch) && Boolean(section.teacherId) };
    });
    const hours = timetableNumber(block.hours, Math.max(0, ...sections.map((section) => section.credits)) || times.length);
    for (const section of sections) section.hours = section.credits || hours;
    blocks.push({ id: String(block.id || `B${index + 1}`), grade: grade.grade, label: String(block.label || block.id || `블록 ${index + 1}`), hours, classIds, times, sections });
  });

  return { semester: String(input.semester || ""), days, periodsOf, positions, grades, gradeOf, lunchPositions, absOfTime, creative, fixed, everyoneBusy, busyTimes, teachers, teacherOf, lessons, blocks,
    venues: { ...(input.venues || {}) }, rules, missing: Array.isArray(input.missing) ? input.missing : [], notes: input.notes || {} };
}

// ---- 사전 점검(필요 조건, 1초 안) ----
// 돌려주는 값: { ok, counts: { block, fail, warn, info }, issues: [{ id: "P6", level: "block" | "fail" | "warn" | "info", cause, where: [고칠 곳], relax: [완화 이름], data }], grades: [학년 요약], teachers: [교사 요약] }
// block = 계산을 시작할 수 없음, fail = 이대로는 필수 조건을 모두 지키는 시간표가 없음(완화가 필요), warn = 알림, info = 참고.
function timetablePrecheck(source) {
  const model = source && source.gradeOf instanceof Map ? source : timetableModel(source);
  const { rules, days, positions } = model;
  const issues = [];
  const add = (id, level, cause, where = [], extra = {}) => issues.push({ id, level, cause, where: Array.isArray(where) ? where : [where], ...extra });
  const nameOf = (id) => model.teacherOf.get(id)?.name || id;
  const round1 = (value) => Math.round(value * 10) / 10;
  const joinNames = (list, limit = 4) => (list.length > limit ? `${list.slice(0, limit).join(", ")} 외 ${list.length - limit}` : list.join(", "));

  // P0 자료
  for (const item of model.missing) add("P0", item.level || "block", String(item.cause || ""), item.where || [], item.data ? { data: item.data } : {});
  if (!model.grades.length || !model.grades.some((grade) => grade.classes.length)) add("P0", "block", "학년·학급 수가 없습니다.", timetableWhere("aggregate", "내년 학급 수"));
  if (!days.length || !model.grades.some((grade) => grade.slotCount)) add("P0", "block", "요일·교시 격자가 없습니다.", timetableWhere("time"));
  if (!model.teachers.length) add("P0", "block", "교사 명단(또는 교과별 교사 수)이 없습니다.", [timetableWhere("teachers"), timetableWhere("hours", "교사 수")]);
  for (const grade of model.grades) {
    if (grade.classes.length && !model.lessons.some((lesson) => lesson.grade === grade.grade) && !model.blocks.some((block) => block.grade === grade.grade)) {
      add("P0", "block", `${grade.grade}학년 수업 목록이 없습니다(편제표·분반 편성 결과 확인).`, [timetableWhere("plan"), timetableWhere("sections")]);
    }
  }
  const unknown = [...model.lessons, ...model.blocks.flatMap((block) => block.sections)].filter((item) => item.unknownTeacher);
  if (unknown.length) add("P0", "warn", `교사 명단에 없는 교사가 배정된 수업 ${unknown.length}개(교사를 다시 고릅니다).`, timetableWhere("teachers"));

  // 반마다 수업 수
  const lessonsOfClass = new Map();
  for (const lesson of model.lessons) {
    if (!lessonsOfClass.has(lesson.classId)) lessonsOfClass.set(lesson.classId, []);
    lessonsOfClass.get(lesson.classId).push(lesson);
  }
  const blocksOfClass = new Map();
  for (const block of model.blocks) for (const classId of block.classIds) {
    if (!blocksOfClass.has(classId)) blocksOfClass.set(classId, []);
    blocksOfClass.get(classId).push(block);
  }
  const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);

  // P1 반 주간 칸 수
  const gradeRows = [];
  for (const grade of model.grades) {
    if (!grade.classes.length) continue;
    const creative = model.creative.byGrade[grade.grade]?.total || 0;
    const totals = grade.classes.map((classId) => {
      const lessonHours = sum(lessonsOfClass.get(classId) || [], (lesson) => lesson.hours);
      const blockHours = sum(blocksOfClass.get(classId) || [], (block) => block.hours);
      return { classId, lessonHours, blockHours, total: lessonHours + blockHours + creative };
    });
    const most = Math.max(...totals.map((row) => row.total));
    const least = Math.min(...totals.map((row) => row.total));
    const row = { grade: grade.grade, classes: grade.classes.length, slots: grade.slotCount, creative, lessonHours: totals[0].lessonHours, blockHours: totals[0].blockHours, total: most, spare: grade.slotCount - most };
    gradeRows.push(row);
    if (most > grade.slotCount) {
      const over = totals.filter((item) => item.total > grade.slotCount);
      add("P1", "fail", `${grade.grade}학년: 주간 수업 ${most}시간(반 수업 ${over[0].lessonHours} + 블록 ${over[0].blockHours} + 창체 ${creative}) > 주 ${grade.slotCount}칸 — ${most - grade.slotCount}시간은 넣을 자리가 없습니다(${over.length}개 반).`,
        [timetableWhere("time", "요일별 교시 수"), timetableWhere("plan", `${grade.grade}학년 학점`)], { data: { grade: grade.grade, total: most, slots: grade.slotCount }, relax: ["unplaced"] });
    } else if (most < grade.slotCount) {
      add("P1", "info", `${grade.grade}학년: 주간 수업 ${most}시간 < 주 ${grade.slotCount}칸 — ${grade.slotCount - most}칸은 요일 끝 교시를 비웁니다(일찍 마침).`, timetableWhere("time", "요일별 교시 수"), { data: { grade: grade.grade, spare: grade.slotCount - most } });
    }
    if (most !== least) add("P1", "warn", `${grade.grade}학년: 반마다 주간 수업 수가 다릅니다(${least}~${most}시간). 편제표·학급 단위 과목 배정을 확인하세요.`, [timetableWhere("plan"), timetableWhere("sections", "학급 단위 과목")]);
  }

  // 교사 쓸 수 있는 칸(P3)과 용량
  const gradesOfTeacher = new Map();
  const touch = (id, grade) => { if (!gradesOfTeacher.has(id)) gradesOfTeacher.set(id, new Set()); gradesOfTeacher.get(id).add(grade); };
  for (const lesson of model.lessons) for (const id of lesson.candidates) touch(id, lesson.grade);
  for (const block of model.blocks) for (const section of block.sections) for (const id of section.candidates) touch(id, block.grade);
  const fixedHours = new Map();
  const fixedLabels = new Map();
  const addFixed = (id, hours, label) => {
    fixedHours.set(id, (fixedHours.get(id) || 0) + hours);
    if (!fixedLabels.has(id)) fixedLabels.set(id, new Map());
    fixedLabels.get(id).set(label, (fixedLabels.get(id).get(label) || 0) + hours);
  };
  for (const lesson of model.lessons) if (lesson.fixedTeacher) addFixed(lesson.fixedTeacher, lesson.hours, `${lesson.grade}학년 ${lesson.subject}`);
  for (const block of model.blocks) for (const section of block.sections) if (section.fixedTeacher) addFixed(section.fixedTeacher, section.hours, `${block.grade}학년 ${section.subject}(${block.label})`);
  const homeroomDuty = (teacher) => {
    const grade = teacher.homeroom ? teacher.homeroom.split("-")[0] : "";
    return grade && model.creative.byGrade[grade] ? model.creative.byGrade[grade].grade : 0; // 학년별 창체 시간에는 그 학년 담임이 비어 있어야 한다
  };
  const dayCache = new Map();
  const teacherRows = [];
  const capacityOf = new Map();
  for (const teacher of model.teachers) {
    const mine = gradesOfTeacher.get(teacher.id);
    let slotCapacity = 0;
    if (mine && mine.size) {
      days.forEach((_, d) => {
        let available = 0;
        for (const gradeId of mine) for (const slot of model.gradeOf.get(gradeId).slots) {
          if (slot.d === d && !teacher.blocked.has(slot.abs)) available |= 1 << (slot.abs - d * positions);
        }
        if (!dayCache.has(available)) dayCache.set(available, timetableDayCapacity(available, positions, rules, model.lunchPositions));
        slotCapacity += dayCache.get(available);
      });
      slotCapacity = Math.max(0, slotCapacity - homeroomDuty(teacher));
    }
    // 필수 한계 = 그 교사가 설 수 있는 칸 수(불가 시간·점심·연강)와 필수 상한(진로 교사 등). 참고 상한(22)은 넘어도 알림만.
    const capacity = Math.min(teacher.maxHours, slotCapacity);
    capacityOf.set(teacher.id, capacity);
    const fixed = fixedHours.get(teacher.id) || 0;
    teacherRows.push({ id: teacher.id, name: teacher.name, maxHours: Number.isFinite(teacher.maxHours) ? teacher.maxHours : null, softHours: Number.isFinite(teacher.softHours) ? teacher.softHours : null, slotCapacity, capacity, fixedHours: fixed });
    const labels = () => [...(fixedLabels.get(teacher.id) || new Map()).entries()].map(([label, hours]) => `${label} ${hours}`);
    if (fixed > capacity) {
      const byTime = slotCapacity <= teacher.maxHours;
      add("P3", "fail", byTime ? `${teacher.name} 교사: 배정 ${fixed}시간(${joinNames(labels())})인데 불가 시간·출근 요일·점심·연강을 빼면 주 ${slotCapacity}시간까지만 수업할 수 있습니다.`
        : `${teacher.name} 교사: 배정 ${fixed}시간(${joinNames(labels())})이 필수 상한 ${teacher.maxHours}시간을 넘습니다.`,
      [timetableWhere("sections", "분반 교사"), byTime ? timetableWhere("teachers", "불가 시간") : timetableWhere("rules", "교과별 필수 상한")], { data: { teacher: teacher.id, fixed, capacity }, relax: byTime ? ["teacherRules", "noTeacher"] : ["noTeacher"] });
    } else if (fixed > teacher.softHours) {
      add("P3", "warn", `${teacher.name} 교사: 배정 ${fixed}시간(${joinNames(labels())})이 참고 상한 ${teacher.softHours}시간을 넘습니다(필수 조건은 아니어서 편성은 됩니다).`,
        [timetableWhere("sections", "분반 교사"), timetableWhere("rules", "참고 상한")], { data: { teacher: teacher.id, fixed, soft: teacher.softHours } });
    }
  }

  // P2 학기 교사 시수(교사 후보가 겹치므로 최대 유량으로 한 번에)
  const demandGroups = new Map();
  const noTeacher = new Map();
  const demand = (item, hours, label, department) => {
    if (!item.candidates.length) {
      const key = department || label;
      const entry = noTeacher.get(key) || { hours: 0, labels: new Set() };
      entry.hours += hours; entry.labels.add(label); noTeacher.set(key, entry);
      return;
    }
    const key = item.candidates.slice().sort().join("|");
    const group = demandGroups.get(key) || { hours: 0, candidates: item.candidates.slice(), labels: new Map(), departments: new Set(), fixed: item.candidates.length === 1 };
    group.hours += hours;
    group.labels.set(label, (group.labels.get(label) || 0) + hours);
    if (department) group.departments.add(department);
    demandGroups.set(key, group);
  };
  for (const lesson of model.lessons) demand(lesson, lesson.hours, `${lesson.grade}학년 ${lesson.subject}`, lesson.department);
  for (const block of model.blocks) for (const section of block.sections) demand(section, section.hours, `${block.grade}학년 ${section.subject}`, section.department);
  for (const [key, entry] of noTeacher) {
    add("P2", "fail", `${key}: ${joinNames([...entry.labels])} ${entry.hours}시간을 맡을 수 있는 교사가 명단에 없습니다 → '담당 교사 없음' ${entry.hours}시간(교사 명단의 담당 교과·담당 과목, 5단계 담당 교과를 확인하세요).`,
      [timetableWhere("teachers", "담당 교과·과목"), timetableWhere("hours", "담당 교과")], { data: { department: key, hours: entry.hours }, relax: ["otherDepartment", "noTeacher"] });
  }
  // 전공 일치(절대): 담당 교과·담당 과목에 없는 수업을 맡은 교사(교양 과목만 다른 교과 교사가 맡을 수 있다)
  const mismatched = new Map();
  const noteMismatch = (item, label) => { if (item.mismatch && item.fixedTeacher) { const key = `${item.fixedTeacher}|${label}`; mismatched.set(key, { teacher: item.fixedTeacher, label, hours: (mismatched.get(key)?.hours || 0) + item.hours }); } };
  for (const lesson of model.lessons) noteMismatch(lesson, `${lesson.grade}학년 ${lesson.subject}`);
  for (const block of model.blocks) for (const section of block.sections) noteMismatch(section, `${block.grade}학년 ${section.subject}(${block.label})`);
  for (const entry of mismatched.values()) {
    add("P2", "fail", `${nameOf(entry.teacher)} 교사: ${entry.label} ${entry.hours}시간은 이 교사의 담당 교과·담당 과목에 없는 수업입니다(교양 과목만 다른 교과 교사가 맡을 수 있습니다).`,
      [timetableWhere("sections", "분반 교사"), timetableWhere("teachers", "담당 과목")], { data: { teacher: entry.teacher, hours: entry.hours }, relax: ["noTeacher"] });
  }
  const supplyText = (cluster, capacityFor) => {
    const capacities = cluster.teachers.map(capacityFor);
    const same = capacities.every((value) => value === capacities[0]);
    return same ? `${cluster.teachers.length}명 × ${capacities[0]} = ${cluster.capacity}시간` : `${cluster.teachers.length}명 합 ${cluster.capacity}시간`;
  };
  const departmentsOf = (cluster) => [...new Set(cluster.groups.flatMap((group) => [...group.departments]))];
  const groupsList = [...demandGroups.values()];
  const hardKeys = new Set();
  const coverage = timetableCoverage(groupsList, (id) => capacityOf.get(id));
  const overloaded = new Set(issues.filter((issue) => issue.id === "P3" && issue.level === "fail").map((issue) => issue.data.teacher));
  for (const cluster of coverage.clusters) {
    cluster.teachers.forEach((id) => hardKeys.add(id));
    if (cluster.teachers.length === 1 && overloaded.has(cluster.teachers[0])) continue; // P3에서 이미 알림
    const departments = departmentsOf(cluster);
    add("P2", "fail", `${joinNames(departments.length ? departments : ["교과 미정"])}: 맡을 수 있는 교사가 설 수 있는 시간 ${supplyText(cluster, (id) => capacityOf.get(id))} < 이번 학기 수업 ${cluster.demand}시간(${cluster.shortage}시간은 넣을 수 없음).`,
      [timetableWhere("teachers", "담당 교과·과목·불가 시간"), timetableWhere("hours", "담당 교과"), timetableWhere("rules", "교사 규칙")],
      { data: { departments, teachers: cluster.teachers, demand: cluster.demand, capacity: cluster.capacity, shortage: cluster.shortage }, relax: ["teacherRules", "otherDepartment", "noTeacher"] });
  }
  // 참고 상한(기본 22시간): 넘어도 편성은 하지만 어느 교과가 얼마나 넘는지 알린다.
  const softOf = (id) => Math.min(capacityOf.get(id), model.teacherOf.get(id)?.softHours ?? Infinity);
  for (const cluster of timetableCoverage(groupsList, softOf).clusters) {
    if (cluster.teachers.some((id) => hardKeys.has(id))) continue;
    if (cluster.teachers.length === 1 && issues.some((issue) => issue.id === "P3" && issue.data?.teacher === cluster.teachers[0])) continue; // P3에서 이미 알림
    const departments = departmentsOf(cluster);
    add("P2", "warn", `${joinNames(departments.length ? departments : ["교과 미정"])}: 교사 ${supplyText(cluster, softOf)} < 이번 학기 수업 ${cluster.demand}시간 — 참고 상한을 ${cluster.shortage}시간 넘습니다(1인당 약 ${round1(cluster.demand / cluster.teachers.length)}시간, 필수 조건은 아니어서 편성은 됩니다).`,
      [timetableWhere("hours", "교사 수·담당 교과"), timetableWhere("rules", "참고 상한")],
      { data: { departments, teachers: cluster.teachers, demand: cluster.demand, capacity: cluster.capacity, shortage: cluster.shortage } });
  }

  // P4 블록 안 동시 분반 ≤ 맡을 수 있는 교사(이분 매칭), 같은 시각에 놓인 다른 학년 블록까지
  const blockShort = new Map();
  for (const block of model.blocks) {
    const result = timetableMatch(block.sections.map((section) => section.candidates));
    const short = block.sections.length - result.size;
    blockShort.set(block.id, short);
    if (!short) continue;
    const bySubject = new Map();
    for (const section of block.sections) {
      const entry = bySubject.get(section.subject) || { count: 0, teachers: new Set() };
      entry.count += 1; section.candidates.forEach((id) => entry.teachers.add(id)); bySubject.set(section.subject, entry);
    }
    const detail = [...bySubject.entries()].filter(([, entry]) => entry.count > entry.teachers.size).map(([subject, entry]) => `${subject} ${entry.count}분반인데 맡을 수 있는 교사 ${entry.teachers.size}명`);
    add("P4", "fail", `${block.grade}학년 ${block.label}: ${detail.length ? detail.join(", ") : `분반 ${block.sections.length}개 가운데 ${result.size}개만 서로 다른 교사를 붙일 수 있습니다`} — 같은 시간에 열 수 없습니다.`,
      [timetableWhere("sections", "분반을 다른 블록으로"), timetableWhere("teachers", "담당 과목")], { data: { block: block.id, short }, relax: ["sectionsMove", "noTeacher"] });
  }
  const blocksAt = new Map();
  for (const block of model.blocks) {
    const grade = model.gradeOf.get(block.grade);
    for (const time of block.times) {
      const slot = grade.slotByKey.get(`${time.day}${time.period}`);
      if (!slot) continue;
      if (!blocksAt.has(slot.abs)) blocksAt.set(slot.abs, []);
      blocksAt.get(slot.abs).push({ block, time });
    }
  }
  const overlapSeen = new Set();
  for (const list of blocksAt.values()) {
    const unique = [...new Map(list.map((item) => [item.block.id, item])).values()];
    if (unique.length < 2) continue;
    const key = unique.map((item) => item.block.id).sort().join("|");
    if (overlapSeen.has(key)) continue;
    overlapSeen.add(key);
    const sections = unique.flatMap((item) => item.block.sections);
    const short = sections.length - timetableMatch(sections.map((section) => section.candidates)).size;
    const alone = sum(unique, (item) => blockShort.get(item.block.id) || 0);
    if (short > alone) {
      add("P4", "fail", `${unique.map((item) => `${item.block.grade}학년 ${item.block.label}(${item.time.day}${item.time.period})`).join(" · ")}이 같은 시각인데 교사가 ${short - alone}명 모자랍니다(같은 교사가 두 블록에 필요).`,
        [timetableWhere("sections", "블록 시간"), timetableWhere("sections", "분반 교사")], { data: { blocks: unique.map((item) => item.block.id), short: short - alone }, relax: ["blockTimes"] });
    }
  }

  // P5 블록 놓기
  const onceHard = rules.oncePerDay === "hard";
  for (const block of model.blocks) {
    const grade = model.gradeOf.get(block.grade);
    if (onceHard && block.hours > days.length) add("P5", "fail", `${block.grade}학년 ${block.label}: 주 ${block.hours}시간인데 요일은 ${days.length}일 — 같은 교사가 같은 분반에 하루 두 번 들어갈 수밖에 없습니다.`, timetableWhere("rules", "같은 교사 하루 한 번"), { relax: ["oncePerDay"] });
    if (!block.times.length) continue;
    if (block.times.length !== block.hours) add("P5", "warn", `${block.grade}학년 ${block.label}: 블록 시간 ${block.times.length}칸 ≠ 시수 ${block.hours}시간(시간표에서 다시 놓습니다).`, timetableWhere("sections", "블록 시간"));
    const outside = block.times.filter((time) => !grade.slotByKey.has(`${time.day}${time.period}`));
    if (outside.length) add("P5", "fail", `${block.grade}학년 ${block.label}: ${outside.map((time) => `${time.day}${time.period}`).join(", ")}은 시간 격자에 없는 칸입니다.`, [timetableWhere("sections", "블록 시간"), timetableWhere("time")], { relax: ["blockTimes"] });
    const busy = block.times.filter((time) => grade.slotByKey.has(`${time.day}${time.period}`) && model.everyoneBusy.has(grade.slotByKey.get(`${time.day}${time.period}`).abs));
    if (busy.length) add("P5", "fail", `${block.grade}학년 ${block.label}: ${busy.map((time) => `${time.day}${time.period}`).join(", ")}은 전교 고정 시간(창체·회의)과 겹칩니다.`, [timetableWhere("sections", "블록 시간"), timetableWhere("time", "창체·고정 시간")], { relax: ["blockTimes"] });
    const perDay = new Map();
    for (const time of block.times) perDay.set(time.day, (perDay.get(time.day) || 0) + 1);
    if (onceHard && [...perDay.values()].some((count) => count > 1)) add("P5", "warn", `${block.grade}학년 ${block.label}: 같은 날 두 번 들어 있습니다(같은 교사 하루 한 번 규칙).`, timetableWhere("sections", "블록 시간"), { relax: ["blockTimes"] });
  }
  for (const grade of model.grades) {
    const taken = new Map();
    for (const block of model.blocks.filter((item) => item.grade === grade.grade)) for (const time of block.times) {
      const key = `${time.day}${time.period}`;
      const other = taken.get(key);
      if (other && other.classIds.some((id) => block.classIds.includes(id))) add("P5", "fail", `${grade.grade}학년 ${other.label}과 ${block.label}이 같은 시간(${key})입니다.`, timetableWhere("sections", "블록 시간"), { relax: ["blockTimes"] });
      else taken.set(key, block);
    }
  }
  { // 서로 같은 시간에 둘 수 없는 블록(같은 반 또는 같은 확정 교사) 묶음의 시수 합 ≤ 한 주 칸 수
    const fixedOf = (block) => new Set(block.sections.map((section) => section.fixedTeacher).filter(Boolean));
    const info = model.blocks.map((block) => ({ block, teachers: fixedOf(block) }));
    const clash = (a, b) => (a.block.grade === b.block.grade && a.block.classIds.some((id) => b.block.classIds.includes(id))) || [...a.teachers].some((id) => b.teachers.has(id));
    const week = Math.max(0, ...model.grades.map((grade) => grade.slotCount)) - model.busyTimes.size;
    let worst = null;
    for (const start of info) {
      const clique = [start];
      for (const other of info.slice().sort((a, b) => b.block.hours - a.block.hours)) if (other !== start && clique.every((member) => clash(member, other))) clique.push(other);
      const hours = sum(clique, (item) => item.block.hours);
      if (!worst || hours > worst.hours) worst = { clique, hours };
    }
    if (worst && worst.clique.length > 1 && worst.hours > week && new Set(worst.clique.map((item) => item.block.grade)).size > 1) {
      add("P5", "fail", `블록 ${worst.clique.length}개(${joinNames(worst.clique.map((item) => `${item.block.grade}학년 ${item.block.label}`))})가 같은 교사를 써서 서로 다른 시간이어야 하는데, 모두 ${worst.hours}칸이 필요합니다(주 ${week}칸).`,
        [timetableWhere("sections", "분반 교사")], { data: { hours: worst.hours, week }, relax: ["sectionsMove", "noTeacher"] });
    }
  }

  // 같은 교사가 같은 반에 들어가는 수업끼리 묶는다(교사가 정해진 수업은 그 교사로, 아니면 수업 하나씩).
  const pairsOfClass = (classId) => {
    const pairs = new Map();
    for (const lesson of lessonsOfClass.get(classId) || []) {
      const key = lesson.fixedTeacher ? `t:${lesson.fixedTeacher}` : `l:${lesson.id}`;
      const entry = pairs.get(key) || { teacher: lesson.fixedTeacher, hours: 0, double: false, subjects: new Set() };
      entry.hours += lesson.hours; entry.double = entry.double || lesson.double; entry.subjects.add(lesson.subject);
      pairs.set(key, entry);
    }
    return [...pairs.values()];
  };

  // P11 정해진 블록·창체 시간 때문에 피할 수 없는 공강: 그날 뒤쪽에 정해진 수업이 있는 빈칸(낀 칸)은 모두 채워야 하는데,
  // 채울 수업(시간이 정해지지 않은 반 수업·블록·창체)이 그보다 적으면 모자란 만큼은 반드시 공강이 된다.
  if (rules.gap !== "off") {
    for (const grade of model.grades) {
      if (!grade.classes.length) continue;
      const creative = model.creative.byGrade[grade.grade] || { school: 0, grade: 0, total: 0, times: [] };
      const creativeFixed = [...model.creative.schoolTimes.slice(0, creative.school), ...(model.creative.byGroup ? [] : creative.times.slice(0, creative.grade))]
        .map((time) => `${time.day}${time.period}`).filter((key) => grade.slotByKey.has(key));
      const hit = [];
      for (const classId of grade.classes) {
        const fixedKeys = new Set(creativeFixed);
        let fixedBlockHours = 0;
        for (const block of blocksOfClass.get(classId) || []) {
          const keys = block.times.slice(0, block.hours).map((time) => `${time.day}${time.period}`).filter((key) => grade.slotByKey.has(key));
          if (keys.length < block.hours) continue; // 시간이 덜 적혔거나 격자 밖이면 시간표가 놓는다
          for (const key of keys) fixedKeys.add(key);
          fixedBlockHours += block.hours;
        }
        if (!fixedKeys.size) continue;
        const lastOfDay = new Map();
        for (const key of fixedKeys) { const slot = grade.slotByKey.get(key); lastOfDay.set(slot.d, Math.max(lastOfDay.get(slot.d) || 0, slot.period)); }
        const between = grade.slots.filter((slot) => !fixedKeys.has(slot.key) && slot.period < (lastOfDay.get(slot.d) || 0));
        const movable = sum(lessonsOfClass.get(classId) || [], (lesson) => lesson.hours) + sum(blocksOfClass.get(classId) || [], (block) => block.hours) - fixedBlockHours + Math.max(0, creative.total - creativeFixed.length);
        if (between.length > movable) hit.push({ classId, between: between.map((slot) => slot.key), movable, gaps: between.length - movable });
      }
      if (!hit.length) continue;
      const total = sum(hit, (row) => row.gaps);
      const worst = hit.reduce((a, b) => (b.gaps > a.gaps ? b : a));
      const blockFixed = (blocksOfClass.get(worst.classId) || []).some((block) => block.times.length >= block.hours);
      add("P11", rules.gap === "hard" ? "fail" : "warn",
        `${grade.grade}학년: 정해진 ${blockFixed ? "블록" : ""}${blockFixed && creativeFixed.length ? "·" : ""}${creativeFixed.length ? "창체" : ""} 시간 사이에 낀 칸이 반마다 ${worst.between.length}칸(${joinNames(worst.between, 13)})인데 그 칸에 넣을 수업은 ${worst.movable}시간뿐입니다 → 반마다 최소 ${worst.gaps}칸, ${hit.length}개 반 모두 ${total}칸이 공강이 됩니다(${blockFixed ? "블록 시간을 시간표가 정하게 하면 없앨 수 있습니다" : "창체 시간을 풀면 줄일 수 있습니다"}).`,
        blockFixed ? [timetableWhere("time", "블록 시간"), timetableWhere("sections", "블록 시간")] : [timetableWhere("time", "창체")],
        { data: { grade: grade.grade, gaps: total, classes: hit.length, between: worst.between.length, movable: worst.movable }, relax: blockFixed ? ["blockTimes", "creativeFree", "gaps"] : ["creativeFree", "creativeGroup", "gaps"] });
    }
  }

  // P6·P7 학년(반군) 반 수업 동시성, 교사 한 명에 몰린 반 수업
  const gapHard = rules.gap === "hard";
  for (const grade of model.grades) {
    if (!grade.classes.length) continue;
    const creative = model.creative.byGrade[grade.grade] || { total: 0, grade: 0, school: 0, times: [] };
    const groups = new Map(); // 같은 블록을 듣는 반끼리(반군)
    for (const classId of grade.classes) {
      const key = (blocksOfClass.get(classId) || []).map((block) => block.id).sort().join("|");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(classId);
    }
    let widest = 0;
    for (const classIds of groups.values()) {
      const blocks = blocksOfClass.get(classIds[0]) || [];
      const blockHours = sum(blocks, (block) => block.hours);
      const free = grade.slotCount - blockHours - creative.total; // 반 수업 칸(블록·창체를 뺀 칸)
      widest = Math.max(widest, free);
      const lessons = classIds.flatMap((classId) => lessonsOfClass.get(classId) || []);
      const need = sum(lessons, (lesson) => lesson.hours);
      if (!need) continue;
      const label = groups.size > 1 ? `${grade.grade}학년 ${classIds.length}개 반(${classIds[0].split("-")[1]}~${classIds[classIds.length - 1].split("-")[1]}반)` : `${grade.grade}학년`;
      const teacherSet = new Set(lessons.flatMap((lesson) => lesson.candidates));
      const reach = classIds.map((classId) => [...new Set((lessonsOfClass.get(classId) || []).flatMap((lesson) => lesson.candidates))]);
      const simultaneous = lessons.every((lesson) => lesson.candidates.length) ? timetableMatch(reach).size : 0; // 교사를 모르는 수업이 있으면 P2가 알린다
      const row = gradeRows.find((item) => item.grade === grade.grade);
      if (row && row.free === undefined) Object.assign(row, { free, classTeachers: teacherSet.size, simultaneous });
      if (!simultaneous || simultaneous >= classIds.length) continue;
      // 한 반이 하루에 받을 수 있는 반 수업 수(같은 교사가 같은 반에 하루 한 번이면 교사 수만큼 — 교사가 정해지지 않은 수업은 서로 다른 교사로 본다)
      let perDay = Infinity;
      if (onceHard) {
        perDay = 0;
        for (const classId of classIds) {
          perDay = Math.max(perDay, sum(pairsOfClass(classId), (item) => Math.max(item.double ? 2 : 1, Math.ceil(item.hours / days.length))));
        }
      }
      // 반군별 창체가 허용돼 있으면 학년별 창체는 반마다 다른 시간에 둘 수 있다 → 동시 활동(블록·전교 창체)에서 빼고 반 수업 칸에 넣는다.
      const loose = model.creative.byGroup ? creative.grade : 0;
      const syncCreative = creative.total - loose;
      const dayValue = (tail) => (loose ? Math.min(simultaneous * tail, classIds.length * perDay) : simultaneous * Math.min(tail, perDay));
      // 같은 시간에 가르칠 교사가 반 수보다 적으면 반 수업은 '하루 끝 쪽'에만 올 수 있다(가운데 빈칸 = 공강).
      // 요일마다 끝 쪽 칸 수 t를 정해(그 앞은 모두 블록·창체, 시간이 정해진 것 뒤만) 받을 수 있는 수업 Σ dayValue(t)가 가장 큰 배치를 찾는다.
      const tailPlan = (useBlockTimes) => {
        const fixedByDay = days.map(() => new Set());
        const mark = (time) => { const slot = grade.slotByKey.get(`${time.day}${time.period}`); if (slot) fixedByDay[slot.d].add(slot.period); };
        let flexHours = 0;
        let flexBlocks = 0;
        for (const block of blocks) {
          const placed = useBlockTimes ? block.times.filter((time) => grade.slotByKey.has(`${time.day}${time.period}`)).slice(0, block.hours) : [];
          placed.forEach(mark);
          if (placed.length < block.hours) { flexHours += block.hours - placed.length; flexBlocks += 1; }
        }
        const creativeTimes = [...model.creative.schoolTimes.slice(0, creative.school), ...(loose ? [] : creative.times.slice(0, creative.grade))];
        creativeTimes.forEach(mark);
        const creativeFlex = Math.max(0, syncCreative - creativeTimes.length);
        flexHours += creativeFlex;
        const dayFlexCap = (onceHard ? flexBlocks : Infinity) + creativeFlex;
        let states = new Map([[0, 0]]); // 쓴 유동 시수 → 받을 수 있는 수업 최대
        days.forEach((day, d) => {
          const periods = model.periodsOf[day];
          const fixedCount = fixedByDay[d].size;
          const lastFixed = Math.max(0, ...fixedByDay[d]);
          const nextStates = new Map();
          for (let tail = 0; tail <= periods - lastFixed; tail += 1) {
            const flex = periods - tail - fixedCount;
            if (flex < 0 || flex > dayFlexCap) continue;
            for (const [used, value] of states) {
              if (used + flex > flexHours) continue;
              const total = value + dayValue(tail);
              if (!(nextStates.get(used + flex) >= total)) nextStates.set(used + flex, total);
            }
          }
          states = nextStates;
        });
        return states.has(flexHours) ? { possible: true, capacity: states.get(flexHours) } : { possible: false, capacity: 0 };
      };
      const lessonFree = free + loose;
      const hasTimes = blocks.some((block) => block.times.length);
      const plan = gapHard ? tailPlan(true) : { possible: true, capacity: loose ? Math.min(simultaneous * lessonFree, classIds.length * days.length * perDay) : simultaneous * Math.min(lessonFree, days.length * perDay) };
      if (plan.capacity < need) {
        const moved = gapHard && hasTimes ? tailPlan(false) : null; // 블록 시간을 다시 놓으면 되는가
        const movable = Boolean(moved && moved.capacity >= need);
        const each = round1(need / classIds.length);
        const span = `반 수업 칸 ${lessonFree}개(주 ${grade.slotCount}칸 − 블록 ${blockHours} − 창체 ${syncCreative})`;
        const tail = Number.isFinite(perDay) && gapHard && !loose ? Math.round(plan.capacity / simultaneous) : null;
        const cause = (!plan.possible
          ? `${label}: ${span}가 하루 가운데에 생길 수밖에 없는데, 그 칸에 ${classIds.length}반을 동시에 가르칠 교사는 ${simultaneous}명뿐입니다 → 공강이 생깁니다.`
          : `${label}: ${span}에 ${classIds.length}반이 ${each}시간씩(모두 ${need}시간) 들어가야 하는데, 같은 시간에 가르칠 수 있는 교사는 ${simultaneous}명뿐이라 최대 ${plan.capacity}시간만 들어갑니다`
            + `${tail !== null ? `(한 반은 하루 ${perDay}시간까지 — 같은 교사는 하루 한 번, 하루 끝 쪽 ${tail}칸 × ${simultaneous}명)` : ""}.`)
          + (movable ? " 블록 시간을 다시 놓으면 이 점검은 통과합니다." : "");
        add("P6", "fail", cause, movable ? [timetableWhere("sections", "블록 시간"), timetableWhere("time", "블록 시간 다시 놓기")]
          : [timetableWhere("time", "창체 시간"), timetableWhere("rules", "공강·하루 한 번"), timetableWhere("teachers", "반 수업 과목의 담당 교과·과목")],
        { data: { grade: grade.grade, classes: classIds.length, free: lessonFree, need, simultaneous, perDay: Number.isFinite(perDay) ? perDay : null, tailTotal: tail, capacity: plan.capacity },
          relax: movable ? ["blockTimes"] : ["creativeFree", "creativeGroup", "blockTimes", "oncePerDay", "gaps", "stagger"] });
      }
    }
    // P6(반 묶음이 여럿일 때 — 반 일부만 듣는 블록, 엇갈림): 묶음마다는 교사가 충분해도 학년 전체로는 모자랄 수 있다.
    // 들어갈 수 있는 반 수업 = (한 묶음이 자기 블록일 때 다른 묶음이 받는 수업) + (모든 반이 블록이 아닌 칸 — 교사가 반 수보다 적으니 하루 끝 쪽만).
    // 묶음별 블록이 차지하는 서로 다른 칸 수 D(가장 긴 묶음 ~ 모두 다른 시간)를 바꿔 가며 가장 큰 값을 본다. 묶음별 블록에 정해진 시간이 있으면 하지 않는다.
    if (groups.size > 1 && !issues.some((issue) => issue.id === "P6" && String(issue.data?.grade) === grade.grade)) {
      const lessonsAll = grade.classes.flatMap((classId) => lessonsOfClass.get(classId) || []);
      const needAll = sum(lessonsAll, (lesson) => lesson.hours);
      const reachAll = grade.classes.map((classId) => [...new Set((lessonsOfClass.get(classId) || []).flatMap((lesson) => lesson.candidates))]);
      const simultaneous = needAll && lessonsAll.every((lesson) => lesson.candidates.length) ? timetableMatch(reachAll).size : 0;
      const gradeBlocks = model.blocks.filter((block) => block.grade === grade.grade);
      const common = gradeBlocks.filter((block) => block.classIds.length === grade.classes.length);
      const own = gradeBlocks.filter((block) => block.classIds.length !== grade.classes.length);
      if (simultaneous && simultaneous < grade.classes.length && !own.some((block) => block.times.length)) {
        let perDay = Infinity;
        if (onceHard) { perDay = 0; for (const classId of grade.classes) perDay = Math.max(perDay, sum(pairsOfClass(classId), (item) => Math.max(item.double ? 2 : 1, Math.ceil(item.hours / days.length)))); }
        const loose = model.creative.byGroup ? creative.grade : 0;
        const syncCreative = creative.total - loose;
        const classCount = grade.classes.length;
        const dayValue = (tail) => (loose ? Math.min(simultaneous * tail, classCount * perDay) : simultaneous * Math.min(tail, perDay));
        const parts = [...groups.values()].map((classIds) => {
          const mine = sum(own.filter((block) => block.classIds.includes(classIds[0])), (block) => block.hours);
          const lessons = classIds.flatMap((classId) => lessonsOfClass.get(classId) || []);
          const reach = classIds.map((classId) => [...new Set((lessonsOfClass.get(classId) || []).flatMap((lesson) => lesson.candidates))]);
          return { count: classIds.length, mine, need: sum(lessons, (lesson) => lesson.hours), full: timetableMatch(reach).size >= classIds.length };
        });
        const commonHours = sum(common, (block) => block.hours);
        const fixedCommon = [];
        let flexCommon = 0;
        for (const block of common) { const placed = gapHard ? block.times.filter((time) => grade.slotByKey.has(`${time.day}${time.period}`)).slice(0, block.hours) : []; fixedCommon.push(...placed); flexCommon += block.hours - placed.length; }
        const creativeTimes = [...model.creative.schoolTimes.slice(0, creative.school), ...(loose ? [] : creative.times.slice(0, creative.grade))];
        const creativeFlex = Math.max(0, syncCreative - creativeTimes.length);
        const tailOf = (distinct) => { // 묶음별 블록이 서로 다른 칸 distinct개를 쓸 때, 모든 반이 블록이 아닌 칸에 들어가는 반 수업 최대
          const lessonFree = grade.slotCount - syncCreative - commonHours - distinct;
          if (lessonFree < 0) return -1;
          if (!gapHard) return loose ? Math.min(simultaneous * lessonFree, classCount * days.length * perDay) : simultaneous * Math.min(lessonFree, days.length * perDay);
          const fixedByDay = days.map(() => new Set());
          for (const time of [...fixedCommon, ...creativeTimes]) { const slot = grade.slotByKey.get(`${time.day}${time.period}`); if (slot) fixedByDay[slot.d].add(slot.period); }
          const flexHours = flexCommon + distinct + creativeFlex;
          const dayFlexCap = (onceHard ? gradeBlocks.length : Infinity) + creativeFlex;
          let states = new Map([[0, 0]]);
          days.forEach((day, d) => {
            const periods = model.periodsOf[day];
            const fixedCount = fixedByDay[d].size;
            const lastFixed = Math.max(0, ...fixedByDay[d]);
            const nextStates = new Map();
            for (let tail = 0; tail <= periods - lastFixed; tail += 1) {
              const flex = periods - tail - fixedCount;
              if (flex < 0 || flex > dayFlexCap) continue;
              for (const [used, value] of states) {
                if (used + flex > flexHours) continue;
                const total = value + dayValue(tail);
                if (!(nextStates.get(used + flex) >= total)) nextStates.set(used + flex, total);
              }
            }
            states = nextStates;
          });
          return states.has(flexHours) ? states.get(flexHours) : -1;
        };
        let best = null;
        const longest = Math.max(0, ...parts.map((part) => part.mine));
        const allApart = sum(parts, (part) => part.mine);
        for (let distinct = longest; distinct <= allApart; distinct += 1) {
          const tail = tailOf(distinct);
          if (tail < 0) continue;
          // 묶음 g가 블록이 아닌 '묶음별 블록 칸'은 distinct − 자기 블록 시수개. 그 칸마다 그 묶음 모든 반이 수업(교사가 묶음 반 수 이상일 때), 한 칸에 교사 수까지.
          const apart = Math.min(simultaneous * distinct, sum(parts, (part) => Math.min(part.need, part.full ? part.count * (distinct - part.mine) : 0)));
          if (!best || apart + tail > best.apart + best.tail) best = { distinct, apart, tail };
        }
        const capacity = best ? Math.min(needAll, best.apart) + best.tail : 0;
        if (capacity < needAll) {
          add("P6", "fail", `${grade.grade}학년(반 묶음 ${groups.size}개): 반 수업 ${needAll}시간이 들어가야 하는데, 한 묶음이 자기 블록일 때 다른 묶음이 받는 수업 ${best ? best.apart : 0}시간 + 모든 반이 블록이 아닌 칸(같은 시간에 가르칠 수 있는 교사 ${simultaneous}명 < ${classCount}반이라 하루 끝 쪽만) ${best ? best.tail : 0}시간 = 최대 ${capacity}시간만 들어갑니다.`,
            [timetableWhere("time", "창체 시간"), timetableWhere("rules", "공강·하루 한 번"), timetableWhere("teachers", "반 수업 과목의 담당 교과·과목")],
            { data: { grade: grade.grade, classes: classCount, groups: groups.size, need: needAll, simultaneous, perDay: Number.isFinite(perDay) ? perDay : null, apart: best ? best.apart : 0, tail: best ? best.tail : 0, capacity },
              relax: ["creativeFree", "creativeGroup", "oncePerDay", "gaps", "stagger"] });
        }
      }
    }
    // 반군이 여럿이면 교사는 다른 반군이 블록일 때도 반 수업을 할 수 있다 → 모든 반이 함께 듣는 블록만 뺀다.
    if (groups.size > 1) widest = grade.slotCount - creative.total - sum(model.blocks.filter((block) => block.grade === grade.grade && block.classIds.length === grade.classes.length), (block) => block.hours);
    if (model.creative.byGroup) widest += creative.grade;
    // 이 학년에서 한 교사가 반 수업으로 설 수 있는 칸 수(한 칸에 한 반) — 풀이기가 교사를 정할 때 쓰는 한계(반군별 창체·반 묶음별 블록이면 늘어난다)
    { const row = gradeRows.find((item) => item.grade === grade.grade); if (row) row.lessonCells = widest; }
    // P7: 교사 한 사람이 이 학년 반 수업으로 가르칠 수 있는 시간 ≤ 반 수업 칸 수(한 칸에 한 반)
    const lessonGroups = new Map();
    for (const lesson of model.lessons) {
      if (lesson.grade !== grade.grade || !lesson.candidates.length) continue;
      const key = lesson.candidates.slice().sort().join("|");
      const group = lessonGroups.get(key) || { hours: 0, candidates: lesson.candidates.slice(), labels: new Map(), departments: new Set() };
      group.hours += lesson.hours;
      group.labels.set(lesson.subject, (group.labels.get(lesson.subject) || 0) + lesson.hours);
      if (lesson.department) group.departments.add(lesson.department);
      lessonGroups.set(key, group);
    }
    if (lessonGroups.size && widest > 0) {
      for (const cluster of timetableCoverage([...lessonGroups.values()], () => widest).clusters) {
        const subjects = [...new Set(cluster.groups.flatMap((group) => [...group.labels.keys()]))];
        const count = cluster.teachers.length;
        const cause = count === 1
          ? `${nameOf(cluster.teachers[0])} 교사: ${grade.grade}학년 반 수업 ${joinNames(subjects)} ${cluster.demand}시간인데 ${grade.grade}학년 반 수업 칸은 ${widest}개입니다(한 칸에 한 반만 가르칠 수 있음) → ${cluster.shortage}시간은 넣을 수 없습니다.`
          : `${grade.grade}학년 ${joinNames([...new Set(cluster.groups.flatMap((group) => [...group.departments]))])}: 교사 ${count}명으로는 반 수업 칸 ${widest}개에 ${joinNames(subjects)} ${cluster.demand}시간을 넣을 수 없습니다(한 칸에 한 반, ${count}명 × ${widest}칸 = ${count * widest}시간) → ${cluster.shortage}시간이 남습니다.`;
        add("P7", "fail", cause, [timetableWhere("time", "창체·블록 시간(반 수업 칸 늘리기)"), timetableWhere("sections", "같은 전공 교사끼리 나눠 맡기"), timetableWhere("aggregate", "개설 학급 수·개설 학기")],
          { data: { grade: grade.grade, teachers: cluster.teachers, demand: cluster.demand, free: widest, shortage: cluster.shortage, capacity: count * widest }, relax: ["creativeGroup", "stagger", "sectionsMove", "noTeacher"] });
      }
    }
    if (onceHard) {
      // 같은 교사가 한 반에 주 (요일 수)시간보다 많이 들어가면 같은 날 두 번이 불가피하다.
      const long = new Map();
      for (const classId of grade.classes) for (const pair of pairsOfClass(classId)) {
        if (pair.double || pair.hours <= days.length) continue;
        const label = `${pair.teacher ? `${nameOf(pair.teacher)} 교사 ` : ""}${[...pair.subjects].join("·")}`;
        long.set(label, pair.hours);
      }
      for (const [label, hours] of long) add("P7", "fail", `${grade.grade}학년 ${label}: 한 반에 주 ${hours}시간이라 같은 교사가 같은 날 두 번 들어갈 수밖에 없습니다(요일 ${days.length}일).`,
        [timetableWhere("rules", "같은 교사 하루 한 번"), timetableWhere("sections", "교사 나눠 맡기")], { data: { grade: grade.grade, hours }, relax: ["oncePerDay"] });
    }
  }

  // P8 장소(특별실·체육)
  const venueHours = new Map();
  for (const lesson of model.lessons) if (lesson.venue) venueHours.set(lesson.venue, (venueHours.get(lesson.venue) || 0) + lesson.hours);
  for (const block of model.blocks) {
    const inBlock = new Map();
    for (const section of block.sections) if (section.venue) {
      venueHours.set(section.venue, (venueHours.get(section.venue) || 0) + section.hours);
      inBlock.set(section.venue, (inBlock.get(section.venue) || 0) + 1);
    }
    for (const [venue, count] of inBlock) {
      const rooms = Number(model.venues[venue]);
      if (Number.isFinite(rooms) && count > rooms) add("P8", "fail", `${block.grade}학년 ${block.label}: ${venue}을(를) 쓰는 분반이 ${count}개인데 ${venue}은(는) ${rooms}곳입니다.`, [timetableWhere("sections", "분반을 다른 블록으로"), timetableWhere("venues", venue)], { data: { venue, count, rooms } });
    }
  }
  const weekSlots = Math.max(0, ...model.grades.map((grade) => grade.slotCount));
  for (const [venue, hours] of venueHours) {
    const rooms = Number(model.venues[venue]);
    if (!Number.isFinite(rooms)) { add("P8", "warn", `${venue}: 동시에 쓸 수 있는 곳 수가 없어 겹침을 점검하지 않습니다.`, timetableWhere("venues", venue)); continue; }
    if (hours > rooms * weekSlots) add("P8", "fail", `${venue}: 수업 ${hours}시간 > ${rooms}곳 × 주 ${weekSlots}칸 = ${rooms * weekSlots}시간.`, timetableWhere("venues", venue), { data: { venue, hours, rooms } });
  }

  // P9 창체 시수와 칸
  for (const grade of model.grades) {
    const creative = model.creative.byGrade[grade.grade];
    if (!creative || !grade.classes.length) continue;
    if (creative.expected !== null && creative.expected !== creative.total) {
      add("P9", "warn", `${grade.grade}학년 창체: 5단계 시수 ${creative.expected}시간 ≠ 시간표 설정 ${creative.total}시간(전교 동시 ${creative.school} + 학년별 ${creative.grade}).`, [timetableWhere("time", "창체"), timetableWhere("hours", "창체")]);
    }
    if (creative.times.length > creative.grade) add("P9", "warn", `${grade.grade}학년 창체: 학년별 ${creative.grade}시간인데 시간은 ${creative.times.length}칸 적혀 있습니다.`, timetableWhere("time", "창체"));
  }
  if (model.creative.schoolTimes.length > model.creative.school) add("P9", "warn", `전교 동시 창체 ${model.creative.school}시간인데 시간은 ${model.creative.schoolTimes.length}칸 적혀 있습니다.`, timetableWhere("time", "창체"));
  for (const time of model.creative.schoolTimes) {
    if (!model.grades.every((grade) => !grade.classes.length || grade.slotByKey.has(`${time.day}${time.period}`))) add("P9", "fail", `전교 동시 창체 ${time.day}${time.period}: 그 칸이 없는 학년이 있습니다.`, timetableWhere("time", "창체"));
    else if (model.absOfTime(time).length > 1) add("P9", "warn", `전교 동시 창체 ${time.day}${time.period}: 점심이 다른 학년은 실제 시각이 달라 같은 시간이 아닙니다.`, timetableWhere("time", "창체"));
  }

  // P10 알림
  for (const block of model.blocks) {
    const low = block.sections.filter((section) => section.credits && section.credits < block.hours);
    if (low.length) add("P10", "warn", `${block.grade}학년 ${block.label}: 학점이 다른 과목이 섞여 있어(${joinNames([...new Set(low.map((section) => `${section.subject} ${section.credits}`))])} < 블록 ${block.hours}시간) 그 과목 학생은 개인 공강이 생깁니다.`, timetableWhere("sections", "블록 구성"));
  }
  const placeholders = model.teachers.filter((teacher) => teacher.placeholder).length;
  if (placeholders) add("P10", "warn", `실제 이름이 아닌 교사 ${placeholders}명(5단계 교사 수로 만든 자리) — 불가 시간·출근 요일을 모릅니다.`, timetableWhere("teachers", "교사 명단"));
  for (const item of model.notes.teacherCounts || []) add("P10", "warn", `${item}`, [timetableWhere("teachers", "교사 명단"), timetableWhere("hours", "교사 수")]);
  for (const item of model.notes.homerooms || []) add("P10", "warn", `${item}`, timetableWhere("teachers", "담임"));
  if (model.notes.expandedClasses) add("P10", "warn", "5단계 확대학급(수준별 이동수업)이 켜져 있습니다 — 시간표에는 아직 반영하지 않습니다(5단계 시수와 어긋날 수 있음).", timetableWhere("hours", "확대학급"));
  for (const item of model.notes.undecided || []) add("P10", "warn", `${item}: 개설 학기가 정해지지 않아 시간표에 넣지 않았습니다.`, timetableWhere("aggregate", "개설 학기"));
  for (const item of model.notes.staleSections || []) add("P10", "warn", `${item}: 분반 편성 입력이 바뀌었습니다(6단계에서 다시 계산).`, timetableWhere("sections"));

  const counts = { block: 0, fail: 0, warn: 0, info: 0 };
  for (const issue of issues) counts[issue.level] = (counts[issue.level] || 0) + 1;
  const order = { block: 0, fail: 1, warn: 2, info: 3 };
  issues.sort((a, b) => order[a.level] - order[b.level] || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  return { ok: !counts.block && !counts.fail, counts, issues, relax: [...new Set(issues.flatMap((issue) => issue.relax || []))], grades: gradeRows, teachers: teacherRows };
}

// ---- 6단계 '시간표 미리 점검' 규칙(class-sections-view.js classSectionsTimetablePrecheck가 부른다) ----
// 학년·학기마다 블록 밖 빈 칸 = 주 교시 − 블록 시수 − 고정 시간. 교과마다 그 학년 반 수업 시수(학급 단위 과목: 반 수 × 학점)를
// 교사 수 × 빈 칸보다 많으면 경고(교사 한 사람이 같은 시간에 두 반을 못 맡음) — P7을 교과 단위로 본 것. 교사를 늘리라는 문구는 쓰지 않는다.
// spec: { slots: 주 교시 수, fixed: 고정 시간 수, blockHours, lessons: [{ department, label, hours }], teachers: { 교과: 명 } | null }
function timetablePrecheckDepartments(spec) {
  const free = Math.max(0, (Number(spec.slots) || 0) - (Number(spec.blockHours) || 0) - (Number(spec.fixed) || 0));
  const byDepartment = new Map();
  for (const lesson of spec.lessons || []) {
    if (!(Number(lesson.hours) > 0)) continue;
    const item = byDepartment.get(lesson.department) || { department: lesson.department, hours: 0, labels: [] };
    item.hours += Number(lesson.hours);
    item.labels.push(lesson.label);
    byDepartment.set(lesson.department, item);
  }
  const rows = [];
  const issues = [];
  for (const item of byDepartment.values()) {
    const teachers = spec.teachers ? Number(spec.teachers[item.department]) || 0 : null;
    // capacity = 그 교과 교사들이 블록 밖 빈 칸에 넣을 수 있는 시간(한 칸에 한 반). 교사 수를 모르면 null.
    const capacity = teachers === null ? null : teachers * free;
    const row = { ...item, teachers, capacity, perTeacher: teachers ? Math.round((item.hours / teachers) * 10) / 10 : null };
    rows.push(row);
    if (teachers === null) continue;
    if (item.hours > capacity) {
      issues.push({ type: "timetable-precheck", severity: "warn", department: item.department, hours: item.hours, teachers, free, capacity, shortage: item.hours - capacity,
        message: teachers === 0 && free > 0 ? `${spec.label || ""} ${item.department}: 반 수업 ${item.labels.join(", ")} ${item.hours}시간을 맡을 수 있는 교사가 명단에 없습니다(담당 교사 없음 — 교사 명단의 담당 교과·담당 과목을 확인하세요).`.trim()
          : free <= 0 ? `${spec.label || ""} 블록 밖 빈 칸이 없어(주 ${spec.slots}교시 − 블록 ${spec.blockHours} − 고정 ${spec.fixed}) ${item.department} 반 수업 ${item.hours}시간을 둘 곳이 없습니다.`.trim()
          : `${spec.label || ""} ${item.department}: 교사 ${teachers}명으로는 블록 밖 빈 칸 ${free}칸에 반 수업 ${item.labels.join(", ")} ${item.hours}시간을 넣을 수 없습니다(한 칸에 한 반, ${teachers}명 × ${free}칸 = ${capacity}시간) → ${item.hours - capacity}시간이 남습니다(블록 밖 빈 칸을 늘리거나 블록 수·학급 단위 운영을 바꾸기).`.trim() });
    }
  }
  return { slots: Number(spec.slots) || 0, fixed: Number(spec.fixed) || 0, blockHours: Number(spec.blockHours) || 0, free, rows, issues, teachersKnown: Boolean(spec.teachers) };
}

// ---- 반군 엇갈림 견적(순수, 설계 7절 T7a) ----
// 학년을 반 묶음(반군)으로 나누고 블록 k개를 묶음마다 따로 분반하면(엇갈림) 분반이 얼마나 늘어나는지 어림한다. 6단계 편성을 바꾸지 않고 읽기만 한다.
// spec = { groups: { A: ['3-1', …], B: [...] } (없으면 classes를 앞·뒤 절반으로), classes: [반…], capacity: 분반 정원(기본), minSize: 이보다 적으면 소인수 분반,
//          blocks: [{ id, label, courses: [{ name, sections: 지금 분반 수, capacity?: 과목 정원, byClass: { 반: 그 블록에서 이 과목을 듣는 학생 수 } }] }] }
// 돌려주는 값: { groups, blocks: [{ id, label, now, next, extra, small, courses: [{ name, now, next, extra, sizes: { 묶음: 인원 }, parts: { 묶음: 분반 수 }, small }] }](늘어나는 분반이 적은 순),
//               plans: [{ k, blocks: [id…], extra, small }] (k = 1 … 블록 수: 늘어나는 분반이 적은 블록부터 k개를 엇갈릴 때) }
function timetableStaggerEstimate(spec = {}) {
  const classes = (spec.classes || []).map(String);
  let groups = spec.groups && Object.keys(spec.groups).length ? Object.fromEntries(Object.entries(spec.groups).map(([key, list]) => [key, (list || []).map(String)])) : null;
  if (!groups) { const half = Math.ceil(classes.length / 2); groups = { A: classes.slice(0, half), B: classes.slice(half) }; }
  const groupOf = new Map();
  for (const [key, list] of Object.entries(groups)) for (const classId of list) groupOf.set(classId, key);
  const capacity = Number(spec.capacity) > 0 ? Number(spec.capacity) : 30;
  const minSize = Number(spec.minSize) > 0 ? Number(spec.minSize) : 0;
  const blocks = (spec.blocks || []).map((block) => {
    const courses = (block.courses || []).map((course) => {
      const cap = Number(course.capacity) > 0 ? Number(course.capacity) : capacity;
      const sizes = Object.fromEntries(Object.keys(groups).map((key) => [key, 0]));
      let outside = 0;
      for (const [classId, count] of Object.entries(course.byClass || {})) { const key = groupOf.get(String(classId)); if (key === undefined) outside += Number(count) || 0; else sizes[key] += Number(count) || 0; }
      const now = Math.max(0, Math.floor(Number(course.sections) || 0));
      // 묶음마다 따로 분반: 학생이 있는 묶음은 최소 1개. 묶음에 넣지 못한 반의 학생(자료 누락)은 가장 큰 묶음에 더해 어림한다.
      if (outside) { const biggest = Object.keys(sizes).reduce((a, b) => (sizes[b] > sizes[a] ? b : a)); sizes[biggest] += outside; }
      const parts = Object.fromEntries(Object.entries(sizes).map(([key, count]) => [key, count > 0 ? Math.ceil(count / cap) : 0]));
      const small = minSize ? Object.entries(parts).filter(([key, sections]) => sections > 0 && Math.floor(sizes[key] / sections) < minSize).length : 0;
      let total = Object.values(parts).reduce((sum, sections) => sum + sections, 0);
      // 지금 분반이 정원으로 어림한 것보다 많으면(교사·균형 때문에 더 나눈 과목) 그만큼은 유지한다: 한 분반이 가장 큰 묶음부터 하나씩 더
      while (total > 0 && total < now) { const key = Object.keys(parts).filter((item) => sizes[item] > 0).reduce((a, b) => (sizes[b] / parts[b] > sizes[a] / parts[a] ? b : a)); parts[key] += 1; total += 1; }
      const next = Math.max(now, total);
      return { name: String(course.name || ""), now, next, extra: next - now, sizes, parts, small };
    });
    const total = (pick) => courses.reduce((sum, course) => sum + pick(course), 0);
    return { id: String(block.id ?? ""), label: String(block.label || block.id || ""), now: total((course) => course.now), next: total((course) => course.next), extra: total((course) => course.extra), small: total((course) => course.small), courses };
  }).sort((a, b) => a.extra - b.extra || a.small - b.small || a.id.localeCompare(b.id));
  const plans = blocks.map((_, index) => {
    const picked = blocks.slice(0, index + 1);
    return { k: index + 1, blocks: picked.map((block) => block.id), extra: picked.reduce((sum, block) => sum + block.extra, 0), small: picked.reduce((sum, block) => sum + block.small, 0) };
  });
  return { groups, blocks, plans };
}

// 엇갈린 구조의 입력(T7a-2, 순수): 고른 블록을 반 묶음마다 따로 여는 블록으로 나눈 시간표 입력을 돌려준다(원래 입력은 바꾸지 않는다).
// 이 입력으로 timetablePrecheck를 다시 돌리면 엇갈렸을 때 어떤 점검이 풀리고 무엇이 새로 걸리는지 미리 볼 수 있다(견적용 — 실제 분반·학생 배정은 6단계가 정한다).
// spec = { grade, groups: { A: [반…], B: [...] }, labels: { A: '1~6반' }, blocks: [{ id, courses: [{ name, parts: { A: 분반 수, B: … } }] }] }
// 나눈 블록: id '원래 id#A', 반 = 그 묶음, 시간 없음(다시 놓아야 하므로), 분반 = 과목마다 parts[묶음]개.
//   분반 담당 후보 = 그 과목 원래 분반의 교사(정해진 교사·후보) + 명단에서 그 과목·담당 교과를 맡는 교사. 견적에 없는 과목의 분반은 묶음마다 그대로 둔다(넉넉하게 어림).
function timetableStaggerInput(input = {}, spec = {}) {
  const picked = new Map((spec.blocks || []).map((block) => [String(block.id), block]));
  const groups = Object.entries(spec.groups || {});
  if (!picked.size || groups.length < 2) return input;
  const blocks = [];
  let replaced = 0;
  for (const block of input.blocks || []) {
    const plan = String(block.grade) === String(spec.grade) ? picked.get(String(block.id)) : null;
    if (!plan) { blocks.push(block); continue; }
    replaced += 1;
    const bySubject = new Map();
    for (const section of block.sections || []) { const key = String(section.subject || ""); if (!bySubject.has(key)) bySubject.set(key, []); bySubject.get(key).push(section); }
    const partsOf = new Map((plan.courses || []).map((course) => [String(course.name || ""), course.parts || {}]));
    for (const [key, classIds] of groups) {
      const sections = [];
      for (const [subject, list] of bySubject) {
        const parts = partsOf.get(subject);
        const count = parts ? Math.max(0, Math.floor(Number(parts[key]) || 0)) : list.length;
        const department = String(list[0].department || "");
        const teacherIds = [...new Set([
          ...list.flatMap((section) => [section.teacherId, ...(Array.isArray(section.teacherIds) ? section.teacherIds : [])]),
          ...(input.teachers || []).filter((teacher) => (teacher.courses || []).includes(subject) || (department && (teacher.departments || []).includes(department))).map((teacher) => teacher.id)
        ].filter(Boolean).map(String))];
        for (let n = 0; n < count; n += 1) {
          const from = list[n % list.length];
          sections.push({ id: `${from.id || `${block.id}-${subject}`}#${key}${n + 1}`, subject: from.subject, department: from.department, credits: from.credits, teacherIds: teacherIds.length ? teacherIds : undefined, venue: from.venue });
        }
      }
      if (sections.length) blocks.push({ ...block, id: `${block.id}#${key}`, label: `${block.label || block.id}(${spec.labels?.[key] || key})`, classes: (classIds || []).map(String), times: "", sections });
    }
  }
  return replaced ? { ...input, blocks } : input; // 고른 블록이 입력에 없으면 입력 그대로
}

if (typeof module !== "undefined" && module.exports) {
  Object.assign(module.exports, { timetableStaggerInput });
  Object.assign(module.exports, { TIMETABLE_DEFAULT_RULES, TIMETABLE_WHERE, timetableWhere, timetableParseTime, timetableTimes, timetableMatch, timetableCoverage, timetableDayCapacity, timetableModel, timetablePrecheck, timetablePrecheckDepartments, timetableStaggerEstimate });
}
