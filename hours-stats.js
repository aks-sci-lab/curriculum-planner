"use strict";
// 내년도 교과별 시수 통계: 입학연도별 편제표와 확정된 수강신청 결과로 교과(담당 교과)별 학기 시수와
// 교사 1인당 평균 시수를 계산한다. 내년도 G학년은 (내년도 − G + 1)학년도 입학생 편제표를 쓴다.
var HOURS_DEPARTMENTS = [
  { id: "국어", group: "국어", label: "" },
  { id: "수학", group: "수학", label: "" },
  { id: "영어", group: "영어", label: "" },
  { id: "과학-공통", group: "과학", label: "공통", common: true },
  { id: "과학-물리", group: "과학", label: "물리" },
  { id: "과학-화학", group: "과학", label: "화학" },
  { id: "과학-생명", group: "과학", label: "생명" },
  { id: "과학-지구", group: "과학", label: "지구" },
  { id: "사회-공통", group: "사회", label: "공통", common: true },
  { id: "사회-한국사", group: "사회", label: "한국사·역사" },
  { id: "사회-지리", group: "사회", label: "지리" },
  { id: "사회-일사", group: "사회", label: "일반사회" },
  { id: "사회-윤리", group: "사회", label: "윤리" },
  { id: "체육", group: "체육·예술", label: "체육" },
  { id: "음악", group: "체육·예술", label: "음악" },
  { id: "미술", group: "체육·예술", label: "미술" },
  { id: "정보", group: "생활·교양", label: "정보" },
  { id: "기술가정", group: "생활·교양", label: "기술·가정" },
  { id: "제2외국어", group: "생활·교양", label: "제2외국어" },
  { id: "교양", group: "생활·교양", label: "교양" },
  { id: "진로", group: "생활·교양", label: "진로", excluded: true },
  { id: "기타", group: "기타", label: "" }
];
// 교과 외(비교과) 교사. 교과 평균 시수에는 넣지 않고, 맡은 수업(상세 표에서 과목 지정 또는 직접 입력)이 있으면 1인당 시수를 따로 보인다.
var HOURS_NON_TEACHING = [
  { id: "보건", label: "보건교사" },
  { id: "영양", label: "영양교사" },
  { id: "사서", label: "사서교사" },
  { id: "상담", label: "전문상담교사" }
];
var HOURS_NON_TEACHING_PREFIX = "비교과:";
var HOURS_DEFAULT_MAX_TEACHER_HOURS = 20;
var hoursRenderTimer = null;

function hoursTargetYear() {
  const year = Number($("#schoolYear").value);
  return Number.isInteger(year) ? String(year + 1) : "";
}

function hoursPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hoursSettings(year = hoursTargetYear(), create = false) {
  state.hoursStats ||= {};
  let entry = state.hoursStats[year];
  if (!hoursPlainObject(entry)) {
    entry = {};
    if (create && /^\d{4}$/.test(year)) state.hoursStats[year] = entry;
  }
  for (const key of ["classCounts", "teachers", "departmentOverrides", "classOverrides", "allocations", "previousAverages", "sourceRounds", "lastAverages",
    "nonTeaching", "nonTeachingHours", "teacherLocks", "allocationNotes"]) {
    if (!hoursPlainObject(entry[key])) entry[key] = {};
  }
  return entry;
}

function hoursNumber(value, { integer = false, max = 1000 } = {}) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max) return null;
  if (integer && !Number.isInteger(number)) return null;
  return number;
}

function nextYearClassBases() {
  const counts = state.hoursStats?.[hoursTargetYear()]?.classCounts || {};
  return Object.fromEntries(["1", "2", "3"].map((grade) => [grade, hoursNumber(counts[grade], { integer: true, max: 99 })])
    .filter(([, count]) => count > 0));
}

function hoursDepartment(id) {
  return HOURS_DEPARTMENTS.find((department) => department.id === id) || HOURS_DEPARTMENTS.at(-1);
}

function hoursNonTeachingId(id) {
  const value = String(id ?? "");
  if (!value.startsWith(HOURS_NON_TEACHING_PREFIX)) return "";
  const role = value.slice(HOURS_NON_TEACHING_PREFIX.length);
  return HOURS_NON_TEACHING.some((item) => item.id === role) ? role : "";
}

function hoursDepartmentOrder(id) {
  const role = hoursNonTeachingId(id);
  return role ? HOURS_DEPARTMENTS.length + HOURS_NON_TEACHING.findIndex((item) => item.id === role) : HOURS_DEPARTMENTS.findIndex((item) => item.id === id);
}

function hoursDepartmentName(id) {
  const role = hoursNonTeachingId(id);
  if (role) return `${HOURS_NON_TEACHING.find((item) => item.id === role).label}(비교과)`;
  const department = hoursDepartment(id);
  return department.label && department.label !== department.group ? `${department.group}·${department.label}` : department.group;
}

function hoursDefaultDepartment(subject, area = "") {
  const name = String(subject ?? "").replace(/\s+/g, "");
  const field = String(area ?? "").replace(/\s+/g, "");
  if (/진로와직업/.test(name)) return "진로";
  if (/^통합과학|과학탐구실험|융합과학|기후변화와환경생태|과학의역사|과학과제/.test(name)) return "과학-공통";
  if (/물리|역학과에너지|전자기와양자/.test(name)) return "과학-물리";
  if (/화학|물질과에너지/.test(name)) return "과학-화학";
  if (/생명|생물|세포와물질대사/.test(name)) return "과학-생명";
  if (/지구|행성우주/.test(name)) return "과학-지구";
  if (/^통합사회|사회문제탐구|기후변화와지속가능/.test(name)) return "사회-공통";
  if (/한국사|세계사|동아시아|역사|국제관계/.test(name)) return "사회-한국사";
  if (/지리|도시의미래/.test(name)) return "사회-지리";
  if (/윤리|인문학/.test(name)) return "사회-윤리";
  if (/음악/.test(name)) return "음악";
  if (/미술/.test(name)) return "미술";
  if (/일본어|중국어|프랑스어|독일어|스페인어|러시아어|아랍어|베트남어|한문/.test(name)) return "제2외국어";
  if (/국어/.test(field)) return "국어";
  if (/수학/.test(field)) return "수학";
  if (/영어/.test(field)) return "영어";
  if (/한국사/.test(field)) return "사회-한국사";
  if (/사회/.test(field)) return "사회-일사";
  if (/과학/.test(field)) return "과학-공통";
  if (/체육/.test(field)) return "체육";
  if (/예술/.test(field)) return /미술/.test(name) ? "미술" : "음악";
  if (/정보/.test(field)) return "정보";
  if (/기술/.test(field)) return "기술가정";
  if (/외국어|한문/.test(field)) return "제2외국어";
  if (/교양/.test(field)) return "교양";
  return "기타";
}

// 현 학년(내년도 학년 − 1)의 수강신청 결과 중 시수 통계 근거로 쓸 차수를 고른다.
// 지정 차수 → 가장 최근에 확정된 차수 → 결과가 있는 가장 최근 차수(미확정) 순서다.
function hoursSourceResult(currentGrade, settings) {
  const rounds = applicationRoundNumbers().slice().reverse();
  const hasGrade = (round) => roundStatusData(round)?.students?.some((student) => String(student.grade) === currentGrade);
  const pinned = String(settings.sourceRounds?.[String(Number(currentGrade) + 1)] || "");
  const round = pinned && rounds.includes(pinned) && (hasGrade(pinned) || state.roundStatuses?.[pinned]?.snapshot)
    ? pinned
    : rounds.find((item) => isRoundLocked(item) &&
        state.roundStatuses[item]?.snapshot?.rows?.some((row) => row.grade === currentGrade)) ||
      rounds.find(hasGrade);
  if (!round) return null;
  const snapshot = isRoundLocked(round) && state.roundStatuses[round]?.snapshot
    ? state.roundStatuses[round].snapshot
    : buildRoundSnapshot(round);
  const rows = (snapshot?.rows || []).filter((row) => row.grade === currentGrade);
  if (!rows.length) return null;
  return { round, confirmed: isRoundLocked(round), pinned: pinned === round, rows };
}

// 내년도 G학년 한 줄 설명: 입학연도 편제표와 선택과목 근거(현 G−1학년 결과)를 함께 보여 준다.
function hoursGradeLabel(info) {
  const head = `${info.grade}학년(${info.cohortYear} 입학`;
  if (info.grade === "1") return `${head} · 신입생)`;
  const current = `현 ${Number(info.grade) - 1}학년`;
  return info.source
    ? `${head} · ${current} ${info.source.round}차 ${info.source.confirmed ? "확정" : "미확정"})`
    : `${head} · ${current} 결과 없음)`;
}

function hoursItemKey(item) {
  return `${item.grade}|${item.semester}|${normalizeResultCourseName(item.subject)}`;
}

// 학교 지정 과목의 개설반 수. 한 칸에 과목이 여럿이면 학급을 나눈다.
// 1·2학기에 걸친 교차집중(음악↔미술)은 반마다 한 학기씩 이수하므로 학기마다 엇갈려 나눈다: 11학급이면 1학기 음악 5·미술 6, 2학기 음악 6·미술 5
// (과목마다 두 학기 합이 전체 학급 수). 분할 편성은 두 학기 모두 앞 과목부터 1반씩 더 준다.
function hoursDesignatedShare(total, entry) {
  const names = Math.max(1, Number(entry.names) || 1);
  const base = Math.floor(total / names), extra = total % names;
  const index = Number(entry.nameIndex) || 0;
  const alternate = entry.crossed && names > 1 && Number(entry.crossSemesters) > 1;
  if (alternate && Number.isInteger(entry.crossExtra) && entry.crossExtra >= 0) {
    // 1단계 교차집중 팝업에서 고른 과목(crossExtra)이 첫 학기에 1반 더, 둘째 학기는 반대로.
    const split = entry.crossExtra;
    const position = String(entry.semester) === "1" ? (index - split + names) % names : (split - 1 - index + 2 * names) % names;
    return base + (position < extra ? 1 : 0);
  }
  const position = alternate && String(entry.semester) === "1" ? names - 1 - index : index;
  return base + (position < extra ? 1 : 0);
}

// ---- 교사 수 추천·공통 시수 배분 (순수 계산) ----
// 교과(세부 교과)별 학기 시수로 교과 교사 total명을 정수로 나눠, 1인당 시수가 학교 평균(학기별 전체 시수 ÷ total)에서
// 가장 덜 벗어나게 한다(두 학기 중 더 많이 벗어난 쪽의 최댓값을 최소화). 동률이면 현재 교사 수와 차이가 적은 쪽을 고른다.
// 시수가 있는 교과는 최소 1명, 한 학기 1인당 maxHours를 넘지 않게 한다. 고정(locked)한 교과는 현재 교사 수 그대로다.
function hoursRecommendTeachers(units, { total, maxHours = HOURS_DEFAULT_MAX_TEACHER_HOURS } = {}) {
  const round = (value) => Math.round(value * 1000) / 1000;
  const list = (units || []).map((unit) => {
    const current = Number.isFinite(unit.current) && unit.current >= 0 ? unit.current : null;
    return {
      id: unit.id, h1: Math.max(0, Number(unit.hours?.["1"]) || 0), h2: Math.max(0, Number(unit.hours?.["2"]) || 0),
      current, locked: Boolean(unit.locked) && current !== null
    };
  });
  const totalTeachers = Number(total);
  const result = { ok: false, reason: "", total: totalTeachers, rows: [], average: null, cap: maxHours > 0 ? maxHours : null };
  if (!(totalTeachers > 0)) return { ...result, reason: "교과 교사 수를 입력하세요." };
  const sum = { "1": list.reduce((acc, unit) => acc + unit.h1, 0), "2": list.reduce((acc, unit) => acc + unit.h2, 0) };
  const average = { "1": sum["1"] / totalTeachers, "2": sum["2"] / totalTeachers };
  result.average = average;
  const lockedTeachers = list.filter((unit) => unit.locked).reduce((acc, unit) => acc + unit.current, 0);
  const free = list.filter((unit) => !unit.locked);
  const remaining = Math.round(totalTeachers - lockedTeachers);
  result.remaining = remaining;
  const cap = result.cap ?? Infinity;
  const deviation = (unit, count) => count === 0
    ? (unit.h1 || unit.h2 ? Infinity : 0)
    : Math.max(Math.abs(unit.h1 / count - average["1"]), Math.abs(unit.h2 / count - average["2"]));
  for (const unit of free) {
    const busy = unit.h1 > 0 || unit.h2 > 0;
    unit.lo = busy ? Math.max(1, Math.ceil(Math.max(unit.h1, unit.h2) / cap - 1e-9)) : 0;
    unit.hi = busy ? Math.max(unit.lo, remaining) : 0;
  }
  const needed = free.reduce((acc, unit) => acc + unit.lo, 0);
  if (remaining < 0 || needed > remaining) {
    const minimum = free.reduce((acc, unit) => acc + (unit.h1 || unit.h2 ? 1 : 0), 0);
    return {
      ...result, needed: needed + lockedTeachers,
      reason: minimum > remaining
        ? `시수가 있는 교과가 ${minimum}개라 고정하지 않은 교과에 최소 ${minimum}명이 필요한데 ${Math.max(0, remaining)}명뿐입니다.`
        : `한 학기 1인당 ${maxHours}시간을 넘지 않으려면 교과 교사가 최소 ${needed + lockedTeachers}명 필요합니다(지금 ${totalTeachers}명).`
    };
  }
  // 편차 기준값 후보(교과·교사 수마다 나오는 편차) 중, 모든 교과가 그 안에 들면서 합이 맞는 가장 작은 값을 찾는다.
  const windowOf = (unit, limit) => {
    let low = null, high = null;
    for (let count = unit.lo; count <= unit.hi; count++) {
      if (round(deviation(unit, count)) <= limit) {
        if (low === null) low = count;
        high = count;
      }
    }
    return low === null ? null : [low, high];
  };
  const minimax = (active, left) => {
    const ranges = (limit) => {
      const bounds = active.map((unit) => windowOf(unit, limit));
      if (bounds.some((bound) => !bound)) return null;
      const min = bounds.reduce((acc, [low]) => acc + low, 0), max = bounds.reduce((acc, [, high]) => acc + high, 0);
      return min <= left && left <= max ? bounds : null;
    };
    const candidates = [...new Set(active.flatMap((unit) => {
      const values = [];
      for (let count = unit.lo; count <= unit.hi; count++) values.push(round(deviation(unit, count)));
      return values;
    }))].filter(Number.isFinite).sort((a, b) => a - b);
    if (!candidates.length || !ranges(candidates.at(-1))) return null;
    let lowIndex = 0, highIndex = candidates.length - 1, limit = candidates.at(-1);
    while (lowIndex <= highIndex) {
      const middle = Math.floor((lowIndex + highIndex) / 2);
      if (ranges(candidates[middle])) { limit = candidates[middle]; highIndex = middle - 1; } else lowIndex = middle + 1;
    }
    return { limit, bounds: ranges(limit) };
  };
  // 혼자서는 더 고르게 할 수 없는 교과(예: 시수가 적어도 최소 1명, 한도 때문에 2명)가 최대 편차를 정하면 나머지는 그 큰 편차 안에서
  // 아무렇게나 남는다. 그런 교과는 가장 나은 교사 수로 정해 두고 나머지로 다시 최대 편차를 줄인다(차례로 고르게).
  const pinned = new Map();
  let active = free.slice(), left = remaining;
  let solved = minimax(active, left);
  let limit = solved?.limit ?? 0;
  while (solved && active.length > 1) {
    const bestOf = (unit) => {
      let best = null;
      for (let count = unit.lo; count <= unit.hi; count++) {
        const value = round(deviation(unit, count));
        const distance = Math.abs(count - (unit.current ?? 0));
        if (!best || value < best.value || (value === best.value && distance < best.distance)) best = { count, value, distance };
      }
      return best;
    };
    const stuck = active.map((unit) => [unit, bestOf(unit)]).filter(([, best]) => best && best.value >= solved.limit && solved.limit > 0);
    if (!stuck.length || stuck.length === active.length) break;
    const rest = active.filter((unit) => !stuck.some(([item]) => item === unit));
    const restLeft = left - stuck.reduce((acc, [, best]) => acc + best.count, 0);
    const next = minimax(rest, restLeft);
    if (!next) break;
    for (const [unit, best] of stuck) pinned.set(unit.id, best.count);
    active = rest;
    left = restLeft;
    solved = next;
  }
  const chosen = solved ? solved.bounds : active.map((unit) => [unit.lo, unit.hi]);
  // 범위 안에서 현재 교사 수에 가장 가깝게 두고, 합이 맞을 때까지 현재와의 차이가 가장 적게 느는 교과를 한 명씩 옮긴다
  // (차이가 같으면 옮긴 뒤 편차가 작은 교과).
  const counts = active.map((unit, index) => Math.min(chosen[index][1], Math.max(chosen[index][0], Math.round(unit.current ?? 0))));
  const cost = (unit, count) => Math.abs(count - (unit.current ?? 0));
  let assigned = counts.reduce((acc, count) => acc + count, 0);
  while (assigned !== left) {
    const step = assigned > left ? -1 : 1;
    let best = -1, bestKey = null;
    active.forEach((unit, index) => {
      const next = counts[index] + step;
      if (next < chosen[index][0] || next > chosen[index][1]) return;
      const key = [round(cost(unit, next) - cost(unit, counts[index])), round(deviation(unit, next))];
      if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) { best = index; bestKey = key; }
    });
    if (best < 0) break;
    counts[best] += step;
    assigned += step;
  }
  const recommended = new Map([...pinned, ...active.map((unit, index) => [unit.id, counts[index]])]);
  assigned += remaining - left;
  const perTeacher = (unit, count) => count > 0 ? { "1": unit.h1 / count, "2": unit.h2 / count } : null;
  result.rows = list.map((unit) => {
    const count = unit.locked ? unit.current : recommended.get(unit.id);
    return {
      id: unit.id, hours: { "1": unit.h1, "2": unit.h2 }, current: unit.current, locked: unit.locked, recommended: count,
      diff: unit.current === null ? count : round(count - unit.current),
      currentPerTeacher: unit.current > 0 ? perTeacher(unit, unit.current) : null,
      recommendedPerTeacher: perTeacher(unit, count),
      overCap: unit.current > 0 && Math.max(unit.h1, unit.h2) / unit.current > cap
    };
  });
  result.ok = true;
  result.assigned = assigned + lockedTeachers;
  result.maxDeviation = limit;
  result.range = {
    current: hoursPerTeacherRange(result.rows.map((row) => row.currentPerTeacher)),
    recommended: hoursPerTeacherRange(result.rows.map((row) => row.recommendedPerTeacher))
  };
  result.changed = result.rows.filter((row) => row.diff !== 0).length;
  return result;
}

// 1인당 시수 목록(학기별)에서 가장 적은 값과 가장 많은 값.
function hoursPerTeacherRange(list) {
  const values = list.filter(Boolean).flatMap((item) => [item["1"], item["2"]]).filter((value) => Number.isFinite(value) && value > 0);
  return values.length ? [Math.min(...values), Math.max(...values)] : null;
}

// 과학·사회 공통 과목 시수를 세부 교과에 반 단위(한 반 = 그 과목 학점만큼)로 나눈다.
// 큰 덩어리부터, 맡은 뒤 1인당 시수가 가장 적은 세부 교과에 준다(교사 수가 있는 세부 교과만). 학기마다 따로 나눈다.
function hoursBalanceCommonAllocation(members, items) {
  const usable = (members || []).filter((member) => member.teachers > 0);
  const allocations = Object.fromEntries((members || []).map((member) => [member.id, { "1": 0, "2": 0 }]));
  const notes = Object.fromEntries((members || []).map((member) => [member.id, { "1": "", "2": "" }]));
  if (!usable.length) return { ok: false, reason: "세부 교과 교사 수를 먼저 입력하세요.", allocations, notes };
  for (const semester of ["1", "2"]) {
    const chunks = (items || []).filter((item) => String(item.semester) === semester && item.credit > 0 && item.classes > 0)
      .flatMap((item) => Array.from({ length: item.classes }, () => ({ subject: item.subject, size: item.credit })))
      .sort((a, b) => b.size - a.size || a.subject.localeCompare(b.subject, "ko"));
    const load = new Map(usable.map((member) => [member.id, Number(member.hours?.[semester]) || 0]));
    const given = new Map(usable.map((member) => [member.id, new Map()]));
    for (const chunk of chunks) {
      let best = null;
      for (const member of usable) {
        const after = (load.get(member.id) + chunk.size) / member.teachers;
        if (!best || after < best.after - 1e-9) best = { member, after };
      }
      load.set(best.member.id, load.get(best.member.id) + chunk.size);
      allocations[best.member.id][semester] += chunk.size;
      const subjects = given.get(best.member.id);
      subjects.set(chunk.subject, (subjects.get(chunk.subject) || 0) + 1);
    }
    for (const [id, subjects] of given) notes[id][semester] = [...subjects].map(([subject, count]) => `${subject} ${count}반`).join(" · ");
  }
  return { ok: true, allocations, notes };
}

function computeHoursStats(year = hoursTargetYear()) {
  if (!/^\d{4}$/.test(year)) throw new Error("학년도를 먼저 올바르게 입력하세요.");
  if (typeof syncActiveCurriculumCohort === "function") syncActiveCurriculumCohort();
  const settings = hoursSettings(year);
  const issues = [];
  const classCounts = Object.fromEntries(["1", "2", "3"].map((grade) =>
    [grade, hoursNumber(settings.classCounts[grade], { integer: true, max: 99 })]));
  const creativeHours = hoursNumber(settings.creativeHours, { max: 10 }) ?? 2;
  const grades = [];
  const items = [];
  const seen = new Set();
  for (const grade of ["1", "2", "3"]) {
    const cohortYear = String(Number(year) - Number(grade) + 1);
    const layout = curriculumCohortLayout(cohortYear);
    const fileName = String(state.curriculumCohortYear) === cohortYear
      ? state.curriculumPlanFileName
      : state.curriculumCohorts?.[cohortYear]?.fileName || "";
    const info = { grade, cohortYear, fileName, hasLayout: Boolean(layout), source: null, classes: classCounts[grade] };
    grades.push(info);
    if (!layout) {
      issues.push({ level: "error", text: `${grade}학년: ${cohortYear}학년도 입학생 편제표가 없습니다. 1단계에서 업로드하세요.`, action: `cohort:${cohortYear}` });
      continue;
    }
    if (!(classCounts[grade] > 0)) {
      issues.push({ level: "error", text: `${grade}학년 학급 수를 입력하세요. 학교 지정 과목의 개설반 수로 쓰입니다.`, action: `focus:hoursClasses${grade}` });
    }
    const parsed = curriculumPlanEntries(layout);
    for (const text of parsed.issues) issues.push({ level: "warning", text: `${cohortYear}학년도 입학생 편제표: ${text}` });
    const entries = parsed.entries.filter((entry) => entry.grade === grade);
    if (!entries.length) {
      issues.push({ level: "error", text: `${cohortYear}학년도 입학생 편제표에서 ${grade}학년 과목을 찾지 못했습니다.` });
      continue;
    }
    const currentGrade = String(Number(grade) - 1);
    const needsResults = entries.some((entry) => entry.kind === "선택" || entry.kind === "소인수");
    if (needsResults && grade !== "1") {
      info.source = hoursSourceResult(currentGrade, settings);
      if (!info.source) {
        issues.push({ level: "error", text: `${grade}학년 선택과목: 현 ${currentGrade}학년 수강신청 결과가 없어 개설반을 0으로 계산했습니다. 2단계에서 결과를 반영하세요.`, action: "results" });
      } else if (info.source.confirmed && typeof roundSnapshotDrift === "function") {
        // 확정 뒤 학급 수·기준 비율이 바뀌면 선택과목은 확정 시점 값, 지정 과목은 현재 학급 수로 계산돼 서로 어긋난다.
        const drift = roundSnapshotDrift(info.source.round);
        if (drift.length && !issues.some((issue) => issue.drift === info.source.round)) {
          issues.push({ level: "warning", drift: info.source.round, text: `${info.source.round}차 확정 이후 ${drift.join(", ")}이(가) 바뀌었습니다. 선택과목 개설반은 확정 시점 결과이고 학교 지정 과목은 현재 학급 수로 계산해 서로 맞지 않을 수 있습니다. 4단계에서 확정을 해제하고 다시 확정하세요.`, action: "4" });
        }
      } else if (!info.source.confirmed) {
        issues.push({ level: "warning", text: `${grade}학년 선택과목: 현 ${currentGrade}학년 ${info.source.round}차 결과가 확정되지 않아 현재 집계로 임시 계산했습니다. 4단계에서 확정하면 그 시점 결과로 고정됩니다.`, action: "4" });
      }
    }
    const resultIndex = new Map();
    for (const row of info.source?.rows || []) {
      const key = normalizeResultCourseName(row.name);
      if (!resultIndex.has(key)) resultIndex.set(key, []);
      resultIndex.get(key).push(row);
    }
    const usedResults = new Set();
    const shared = [];
    for (const entry of entries) {
      if (entry.kind === "공동") {
        shared.push(`${entry.subject}(${entry.grade}-${entry.semester})`);
        continue;
      }
      const item = {
        grade, semester: entry.semester, subject: entry.subject, area: entry.area, credit: entry.credit,
        kind: entry.kind, creditSource: entry.creditSource, cohortYear, enrollment: null, basis: "",
        currentGrade: grade === "1" ? "" : currentGrade,
        sourceRound: needsResults && grade !== "1" && entry.kind !== "지정" && info.source
          ? `${info.source.round}차 ${info.source.confirmed ? "확정" : "미확정"}` : ""
      };
      item.key = hoursItemKey(item);
      if (seen.has(item.key)) {
        issues.push({ level: "info", text: `${grade}학년 ${entry.semester}학기 ${entry.subject}가 편제표에 두 번 있어 한 번만 계산했습니다.` });
        continue;
      }
      seen.add(item.key);
      if (entry.kind === "지정") {
        const total = classCounts[grade] || 0;
        item.autoClasses = hoursDesignatedShare(total, entry);
        item.basis = entry.names > 1
          ? entry.crossed
            ? `학교 지정 · 교차집중 ${total}학급이 학기마다 ${entry.names}과목을 엇갈려 이수(${entry.semester}학기 ${item.autoClasses}반${total % entry.names ? " · 1단계 교차집중 팝업에서 1반 더 받을 과목을 고릅니다" : ""})`
            : `학교 지정 · 분할 편성 ${total}학급을 ${entry.names}과목에 나눔`
          : "학교 지정 · 전체 학급";
      } else if (grade === "1") {
        item.autoClasses = 0;
        item.basis = "1학년 선택과목 · 개설반 직접 입력";
        issues.push({ level: "warning", text: `1학년 ${entry.semester}학기 ${entry.subject}는 선택과목이라 신청 결과가 없습니다. 상세 표에서 개설반을 입력하세요.` });
      } else {
        const candidates = resultIndex.get(normalizeResultCourseName(entry.subject)) || [];
        const exact = candidates.filter((row) => row.semester === entry.semester);
        const semesterless = !exact.length && candidates.length === 1 && !candidates[0].semester;
        // 학기 표시가 없는 결과 한 칸이 편제표의 두 학기와 모두 맞으면 이중 계산하지 않고 앞 학기에만 반영한다.
        const alreadyUsed = semesterless && usedResults.has(candidates[0]);
        const matched = exact.length ? exact : semesterless && !alreadyUsed ? candidates : [];
        if (alreadyUsed) {
          item.autoClasses = 0;
          item.basis = "학기 표시 없는 결과 · 앞 학기에만 반영";
          issues.push({ level: "warning", text: `${grade}학년 ${entry.semester}학기 ${entry.subject}: 신청 결과에 학기 표시가 없어 앞 학기에만 반영했습니다. 이 학기에도 개설하면 상세 표에서 개설반을 입력하세요.` });
        } else if (matched.length) {
          matched.forEach((row) => usedResults.add(row));
          item.autoClasses = matched.reduce((sum, row) => sum + (Number(row.classCount) || 0), 0);
          item.enrollment = matched.reduce((sum, row) => sum + (Number(row.enrollment) || 0), 0);
          const closed = matched.every((row) => row.decision === "closed");
          item.basis = `현 ${currentGrade}학년 ${info.source.round}차${info.source.confirmed ? " 확정" : " 미확정"} 결과${closed ? " · 폐강" : ""}`;
        } else {
          item.autoClasses = 0;
          item.basis = info.source ? "신청 결과에서 찾지 못함" : "신청 결과 없음";
          if (info.source) {
            issues.push({ level: entry.kind === "소인수" ? "info" : "warning", text: `${grade}학년 ${entry.semester}학기 ${entry.subject}${entry.kind === "소인수" ? "(소인수)" : ""}: 현 ${currentGrade}학년 ${info.source.round}차 결과에 없어 개설반 0으로 계산했습니다. 과목명이 다르면 상세 표에서 개설반을 입력하세요.` });
          }
        }
      }
      if (entry.creditSource === "credit" && entry.kind === "지정") {
        issues.push({ level: "info", text: `${grade}학년 ${entry.semester}학기 ${entry.subject}: 학기 칸에 숫자가 없어 운영학점 ${entry.credit}을(를) 학기 시수로 썼습니다.` });
      }
      const override = hoursNumber(settings.classOverrides[item.key], { integer: true, max: 99 });
      item.classes = override ?? item.autoClasses;
      item.manual = override !== null;
      if (item.manual) item.basis = `직접 입력 (자동 ${item.autoClasses})`;
      const departmentOverride = settings.departmentOverrides[normalizeResultCourseName(item.subject)];
      item.defaultDepartment = hoursDefaultDepartment(item.subject, item.area);
      item.department = HOURS_DEPARTMENTS.some((department) => department.id === departmentOverride) || hoursNonTeachingId(departmentOverride)
        ? departmentOverride : item.defaultDepartment;
      item.hours = item.credit * item.classes;
      items.push(item);
    }
    if (shared.length) issues.push({ level: "info", text: `${grade}학년 공동교육과정 ${shared.length}과목은 다른 학교에서 운영해 시수에서 뺐습니다: ${resultExampleList(shared)}` });
    const unused = (info.source?.rows || []).filter((row) => !usedResults.has(row) && row.classCount > 0);
    if (unused.length) {
      issues.push({ level: "warning", text: `현 ${currentGrade}학년 ${info.source.round}차 결과 중 ${cohortYear}학년도 입학생 편제표의 ${grade}학년 과목과 맞지 않는 과목이 있습니다(시수 미반영): ${resultExampleList(unused.map((row) => `${row.displayName || row.name}${row.semester ? `(${row.semester}학기)` : ""}`))}` });
    }
  }
  for (const info of grades) info.label = hoursGradeLabel(info);
  for (const item of items) {
    if (item.department === "기타") issues.push({ level: "warning", text: `${item.grade}학년 ${item.semester}학기 ${item.subject}의 담당 교과를 정하지 못했습니다. 상세 표에서 교과를 고르세요.` });
  }

  const departments = HOURS_DEPARTMENTS.map((definition) => {
    const own = items.filter((item) => item.department === definition.id);
    const hours = { "1": 0, "2": 0 };
    for (const item of own) hours[item.semester] += item.hours;
    const allocation = definition.common || !["과학", "사회"].includes(definition.group) ? { "1": 0, "2": 0 } : {
      "1": hoursNumber(settings.allocations[definition.id]?.["1"]) || 0,
      "2": hoursNumber(settings.allocations[definition.id]?.["2"]) || 0
    };
    const teachers = hoursNumber(settings.teachers[definition.id], { max: 200 });
    const totals = { "1": hours["1"] + allocation["1"], "2": hours["2"] + allocation["2"] };
    const averages = teachers > 0 ? { "1": totals["1"] / teachers, "2": totals["2"] / teachers } : null;
    return {
      ...definition, items: own, hours, allocation, totals, teachers, averages,
      yearAverage: averages ? (averages["1"] + averages["2"]) / 2 : null,
      previous: hoursNumber(settings.previousAverages[definition.id], { max: 100 })
    };
  });
  for (const common of departments.filter((department) => department.common)) {
    const members = departments.filter((department) => department.group === common.group && !department.common);
    const allocated = { "1": 0, "2": 0 };
    for (const member of members) for (const semester of ["1", "2"]) allocated[semester] += member.allocation[semester];
    common.unallocated = { "1": common.hours["1"] - allocated["1"], "2": common.hours["2"] - allocated["2"] };
    // 세부 교과로 넘긴 시수는 공통 행에서 빼야 공통 교사 수를 함께 입력해도 두 번 세지 않는다.
    common.allocation = { "1": -allocated["1"], "2": -allocated["2"] };
    common.totals = { ...common.unallocated };
    common.averages = common.teachers > 0 ? { "1": common.totals["1"] / common.teachers, "2": common.totals["2"] / common.teachers } : null;
    common.yearAverage = common.averages ? (common.averages["1"] + common.averages["2"]) / 2 : null;
    const groupMembers = [common, ...members];
    const groupTeachers = groupMembers.reduce((sum, department) => sum + (department.teachers || 0), 0);
    const groupHours = groupMembers.reduce((sum, department) => sum + department.hours["1"] + department.hours["2"], 0);
    common.groupAverage = groupTeachers > 0 ? groupHours / groupTeachers / 2 : null;
  }
  const included = departments.filter((department) => !department.excluded);
  const totalClasses = ["1", "2", "3"].reduce((sum, grade) => sum + (classCounts[grade] || 0), 0);
  const totals = {
    "1": included.reduce((sum, department) => sum + department.hours["1"], 0),
    "2": included.reduce((sum, department) => sum + department.hours["2"], 0),
    teachers: included.reduce((sum, department) => sum + (department.teachers || 0), 0),
    excludedHours: departments.filter((department) => department.excluded)
      .reduce((sum, department) => sum + department.hours["1"] + department.hours["2"], 0),
    creative: creativeHours * totalClasses
  };
  totals.average = totals.teachers > 0 ? {
    "1": totals["1"] / totals.teachers,
    "2": totals["2"] / totals.teachers,
    year: (totals["1"] + totals["2"]) / totals.teachers / 2,
    creative1: (totals["1"] + totals.creative) / totals.teachers,
    creative2: (totals["2"] + totals.creative) / totals.teachers,
    creativeYear: (totals["1"] + totals["2"] + 2 * totals.creative) / totals.teachers / 2
  } : null;
  const missingTeachers = included.filter((department) => department.items.length && !department.common && !(department.teachers > 0));
  if (missingTeachers.length) {
    issues.push({ level: "warning", text: `시수가 있는데 교사 수가 비어 있는 교과: ${missingTeachers.map((department) => hoursDepartmentName(department.id)).join(", ")}`, action: "focus:hoursTeachers-" + missingTeachers[0].id });
  }
  for (const common of departments.filter((department) => department.common)) {
    const over = ["1", "2"].filter((semester) => common.unallocated[semester] < 0);
    if (over.length) {
      issues.push({ level: "error", text: `${common.group} 세부 교과에 배분한 공통 과목 시수가 공통 과목 시수보다 많습니다(${over.map((semester) => `${semester}학기 ${-common.unallocated[semester]}시간 초과`).join(", ")}). 공통 과목 배분 칸을 고치세요.`, action: `focus:hoursAllocation-${common.group}` });
    }
  }
  for (const common of departments.filter((department) => department.common && department.items.length)) {
    const left = common.unallocated["1"] + common.unallocated["2"];
    if (left > 0 &&  departments.some((department) => department.group === common.group && !department.common && (department.allocation["1"] || department.allocation["2"]))) {
      issues.push({ level: "info", text: `${common.group} 공통 과목 시수 중 1학기 ${common.unallocated["1"]}시간, 2학기 ${common.unallocated["2"]}시간이 세부 교과에 배분되지 않았습니다.` });
    }
  }
  const nonTeaching = hoursNonTeachingStats(items, settings, issues);
  const staff = hoursStaffStats(departments, totals, nonTeaching, settings, issues);
  const recommendation = hoursTeacherRecommendation(departments, staff, settings);
  return { year, settings, classCounts, totalClasses, creativeHours, grades, items, departments, totals, nonTeaching, staff, recommendation, issues };
}

// 비교과 교사(보건·영양·사서·상담): 교사 수, 맡은 수업 시수(상세 표에서 담당을 비교과로 지정한 과목 + 직접 입력), 1인당 시수.
function hoursNonTeachingStats(items, settings, issues = []) {
  const rows = HOURS_NON_TEACHING.map((definition) => {
    const key = HOURS_NON_TEACHING_PREFIX + definition.id;
    const own = items.filter((item) => item.department === key);
    const subjectHours = { "1": 0, "2": 0 };
    for (const item of own) subjectHours[item.semester] += item.hours;
    const extra = {
      "1": hoursNumber(settings.nonTeachingHours?.[definition.id]?.["1"], { max: 999 }) || 0,
      "2": hoursNumber(settings.nonTeachingHours?.[definition.id]?.["2"], { max: 999 }) || 0
    };
    const hours = { "1": subjectHours["1"] + extra["1"], "2": subjectHours["2"] + extra["2"] };
    const teachers = hoursNumber(settings.nonTeaching?.[definition.id], { max: 50 });
    const teaching = hours["1"] > 0 || hours["2"] > 0;
    const averages = teachers > 0 && teaching ? { "1": hours["1"] / teachers, "2": hours["2"] / teachers } : null;
    if (teaching && !(teachers > 0)) {
      issues.push({ level: "warning", text: `${definition.label}가 맡은 수업이 ${hours["1"] + hours["2"]}시간 있는데 ${definition.label} 수가 비어 있습니다. 시수 설정에서 입력하세요.`, action: `focus:hoursNonTeaching-${definition.id}` });
    }
    return { ...definition, key, items: own, subjectHours, extra, hours, teachers, averages, yearAverage: averages ? (averages["1"] + averages["2"]) / 2 : null };
  });
  const health = rows.find((row) => row.id === "보건");
  const healthSubjects = items.filter((item) => /^보건/.test(String(item.subject).replace(/\s+/g, "")) && !hoursNonTeachingId(item.department));
  if (health.teachers > 0 && healthSubjects.length) {
    issues.push({ level: "info", text: `'${healthSubjects[0].subject}' 과목을 보건교사가 맡으면 과목별 상세에서 담당 교과를 '보건교사(비교과)'로 고르세요. 그 시수는 교과 평균에서 빠지고 보건교사 1인당 시수로 따로 보입니다.` });
  }
  return rows;
}

// 교원 구성: 총 교사 수(직접 입력, 비면 교과 + 진로 + 비교과 합을 제안값으로) = 교과 + 진로 + 비교과 + 기타(교과 미배정).
// 교과 평균 시수는 지금처럼 교과 시수 ÷ 교과 교사 수이고, 전체 교원 기준 평균은 참고 값이다.
function hoursStaffStats(departments, totals, nonTeaching, settings, issues = []) {
  const round = (value) => Math.round(value * 100) / 100;
  const career = departments.filter((department) => department.excluded);
  const careerTeachers = career.reduce((sum, department) => sum + (department.teachers || 0), 0);
  const careerHours = {
    "1": career.reduce((sum, department) => sum + department.hours["1"], 0),
    "2": career.reduce((sum, department) => sum + department.hours["2"], 0)
  };
  const nonTeachingTeachers = nonTeaching.reduce((sum, row) => sum + (row.teachers || 0), 0);
  const nonTeachingHours = {
    "1": nonTeaching.reduce((sum, row) => sum + row.hours["1"], 0),
    "2": nonTeaching.reduce((sum, row) => sum + row.hours["2"], 0)
  };
  const known = round(totals.teachers + careerTeachers + nonTeachingTeachers);
  const entered = hoursNumber(settings.totalTeachers, { max: 500 });
  const total = entered ?? (known > 0 ? known : null);
  const other = entered === null ? null : round(entered - known);
  const staff = {
    entered, suggested: known, total, subject: totals.teachers, career: careerTeachers, careerHours,
    nonTeaching: nonTeachingTeachers, nonTeachingHours, other, over: other !== null && other < 0
  };
  if (staff.over) {
    issues.push({ level: "warning", text: `교과 ${hoursFormat(totals.teachers, 1)}명${careerTeachers ? ` + 진로 ${hoursFormat(careerTeachers, 1)}명` : ""} + 비교과 ${hoursFormat(nonTeachingTeachers, 1)}명 = ${hoursFormat(known, 1)}명이 총 교사 수 ${hoursFormat(entered, 1)}명보다 ${hoursFormat(-other, 1)}명 많습니다. 총 교사 수나 교과별 교사 수를 확인하세요.`, action: "focus:hoursTotalTeachers" });
  }
  const allHours = {
    "1": totals["1"] + careerHours["1"] + nonTeachingHours["1"],
    "2": totals["2"] + careerHours["2"] + nonTeachingHours["2"]
  };
  staff.allHours = allHours;
  staff.average = total > 0 ? { "1": allHours["1"] / total, "2": allHours["2"] / total, year: (allHours["1"] + allHours["2"]) / total / 2 } : null;
  return staff;
}

// 교과별 교사 수 추천에 넣을 단위: 진로(합계 제외)·기타를 뺀 교과. 세부 교과는 공통 과목 배분까지 더한 시수다.
// 교사가 없는 공통 행에 배분되지 않은 시수가 남으면 같은 교과군 세부 교과에 시수 비율대로 나눠 본다(추천 계산에만).
function hoursTeacherRecommendation(departments, staff, settings) {
  const locks = settings.teacherLocks || {};
  const spread = new Map();
  const notes = [];
  for (const common of departments.filter((department) => department.common)) {
    const left = { "1": Math.max(0, common.totals["1"]), "2": Math.max(0, common.totals["2"]) };
    if (common.teachers > 0 || !(left["1"] || left["2"])) continue;
    const members = departments.filter((department) => department.group === common.group && !department.common);
    const weight = (member) => member.totals["1"] + member.totals["2"];
    const totalWeight = members.reduce((sum, member) => sum + weight(member), 0);
    for (const member of members) {
      const share = totalWeight > 0 ? weight(member) / totalWeight : 1 / members.length;
      spread.set(member.id, { "1": left["1"] * share, "2": left["2"] * share });
    }
    notes.push(`${common.group} 공통 과목 시수 중 세부 교과에 배분하지 않은 ${left["1"]}/${left["2"]}시간은 세부 교과 시수 비율대로 나눠 계산했습니다. '${common.group} 공통 시수 자동 배분'으로 반 단위로 나누면 더 정확합니다.`);
  }
  const units = departments.filter((department) => !department.excluded && department.id !== "기타")
    .filter((department) => !(department.common && !(department.teachers > 0)))
    .map((department) => {
      const extra = spread.get(department.id) || { "1": 0, "2": 0 };
      return {
        id: department.id,
        hours: { "1": Math.max(0, department.totals["1"]) + extra["1"], "2": Math.max(0, department.totals["2"]) + extra["2"] },
        current: department.teachers, locked: Boolean(locks[department.id])
      };
    })
    .filter((unit) => unit.hours["1"] > 0 || unit.hours["2"] > 0 || unit.current > 0);
  const entered = hoursNumber(settings.recommendTeachers, { max: 500 });
  const basis = staff.entered !== null ? Math.max(0, Math.round((staff.entered - staff.career - staff.nonTeaching) * 100) / 100) : staff.subject;
  const target = entered ?? basis;
  const maxHours = hoursNumber(settings.maxTeacherHours, { max: 40 }) || HOURS_DEFAULT_MAX_TEACHER_HOURS;
  const result = hoursRecommendTeachers(units, { total: target, maxHours });
  return {
    ...result, target, entered, basis, maxHours, notes,
    basisText: entered !== null ? "직접 입력"
      : staff.entered !== null ? `총 ${hoursFormat(staff.entered, 1)}${staff.career ? ` − 진로 ${hoursFormat(staff.career, 1)}` : ""} − 비교과 ${hoursFormat(staff.nonTeaching, 1)}`
        : "지금 교과 교사 수 합"
  };
}

function hoursFormat(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function hoursStatsReadiness() {
  let stats;
  try {
    stats = computeHoursStats();
  } catch (error) {
    return { message: error.message, actionLabel: "1단계로", nextStep: "1" };
  }
  const error = stats.issues.find((issue) => issue.level === "error");
  if (error) {
    const actionLabel = error.action?.startsWith("cohort:") ? "편제표 업로드로"
      : error.action?.startsWith("focus:hoursAllocation") ? "배분 시수 고치기"
        : error.action?.startsWith("focus:") ? "학급 수 입력"
          : error.action === "results" ? "결과 업로드로" : "집계·개설 확정으로";
    return { message: error.text, actionLabel, nextStep: error.action || "4" };
  }
  const unconfirmed = stats.issues.find((issue) => issue.action === "4");
  if (unconfirmed) return { message: unconfirmed.text, actionLabel: "집계·개설 확정으로", nextStep: "4" };
  if (!stats.totals.average) {
    return { message: "교과별 교사 수를 입력하면 교사 1인당 평균 시수를 계산합니다.", actionLabel: "교사 수 입력", nextStep: "focus:hoursTeachers-국어" };
  }
  return {
    message: `${stats.year}학년도 교과 시수 1학기 ${stats.totals["1"]}시간 · 2학기 ${stats.totals["2"]}시간, 교과 교사 1인당 평균 ${hoursFormat(stats.totals.average.year)}시간(창체 포함 ${hoursFormat(stats.totals.average.creativeYear)}시간)입니다.`,
    actionLabel: "엑셀 다운로드로",
    nextStep: "focus:downloadHoursStats"
  };
}

function syncNextYearClassInputs() {
  const counts = state.hoursStats?.[hoursTargetYear()]?.classCounts || {};
  for (const input of document.querySelectorAll?.(".next-year-class-input") || []) {
    const value = counts[input.dataset.nextGrade];
    if (document.activeElement !== input) input.value = value === undefined || value === null ? "" : String(value);
  }
}

const HOURS_ISSUE_LABELS = { error: "필수", warning: "확인", info: "참고" };

function hoursIssueList(issues) {
  if (!issues.length) return '<p class="hours-ok">확인할 문제가 없습니다.</p>';
  const order = { error: 0, warning: 1, info: 2 };
  return `<ul class="hours-issues">${issues.slice().sort((a, b) => order[a.level] - order[b.level]).map((issue) =>
    `<li class="hours-issue is-${issue.level}"><b>${HOURS_ISSUE_LABELS[issue.level]}</b> ${escapeHtml(issue.text)}</li>`).join("")}</ul>`;
}

// 화면에는 확인 항목 개수와 가장 급한 항목 하나만 한 줄로 보이고, 전체 목록은 팝업에서 본다.
function hoursIssueSummary(issues) {
  if (!issues.length) return '<p class="hours-summary-line hours-ok">확인할 문제가 없습니다.</p>';
  const counts = ["error", "warning", "info"].map((level) => [level, issues.filter((issue) => issue.level === level).length])
    .filter(([, count]) => count);
  const first = issues.find((issue) => issue.level === "error") || issues.find((issue) => issue.level === "warning");
  return `<p class="hours-summary-line hours-issue-summary">
    <span class="hours-summary-label">확인 항목</span>
    ${counts.map(([level, count]) => `<span class="hours-issue-count is-${level}">${HOURS_ISSUE_LABELS[level]} ${count}</span>`).join("")}
    ${first ? `<span class="hours-summary-text">${escapeHtml(first.text)}</span>` : ""}
    <button class="button button-quiet" type="button" data-open-dialog="hoursIssuesDialog" aria-haspopup="dialog">확인 항목 보기 (${issues.length})</button>
  </p>`;
}

// 학급 수·선택과목 근거·창체 시수의 현재 값을 한 줄로 보여 준다. 고치는 곳은 '시수 설정' 팝업이다.
function hoursSettingsSummary(stats) {
  const grades = stats.grades.map((info) => {
    const classes = info.classes > 0 ? `${info.classes}학급` : '<span class="is-missing">학급 수 미입력</span>';
    const plan = info.hasLayout ? ""
      : ` <button class="button button-quiet" type="button" data-hours-cohort="${info.cohortYear}">${info.cohortYear} 편제표 미업로드 · 1단계에서 업로드</button>`;
    const source = info.grade === "1" ? ""
      : info.source ? ` (현${Number(info.grade) - 1} ${info.source.round}차${info.source.confirmed ? " 확정" : " 임시"})` : ` (현${Number(info.grade) - 1} 결과 없음)`;
    return `<span class="hours-summary-item"><b>${info.grade}학년</b> ${classes}${source}${plan}</span>`;
  }).join("");
  return `<p class="hours-summary-line hours-settings-summary">
    <span class="hours-summary-label">내년도</span>${grades}
    <span class="hours-summary-item">창체 ${hoursFormat(stats.creativeHours)}시간</span>
    <button class="button" type="button" id="openHoursSettings" data-open-dialog="hoursSettingsDialog" aria-haspopup="dialog">시수 설정</button>
  </p>`;
}

// 교원 구성 한 줄: "총 교사 수 62 = 교과 57 + 진로 1 + 비교과 4(보건 1·영양 1·사서 1·상담 1) + 기타 0(교과 미배정)".
function hoursStaffFormula(stats) {
  const staff = stats.staff;
  const count = (value) => hoursFormat(value || 0, 1);
  const roles = stats.nonTeaching.map((row) => `${row.id} ${count(row.teachers)}`).join("·");
  const parts = [`교과 ${count(staff.subject)}`];
  if (staff.career) parts.push(`진로 ${count(staff.career)}(평균 제외)`);
  parts.push(`비교과 ${count(staff.nonTeaching)}(${roles})`);
  if (staff.entered !== null) parts.push(`기타 ${count(staff.other)}(교과 미배정)`);
  const head = staff.entered !== null
    ? `총 교사 수 <b>${count(staff.entered)}</b>`
    : `총 교사 수 <span class="hours-suggested" title="총 교사 수를 입력하지 않아 교과 + 진로 + 비교과 합을 제안값으로 보입니다.">${count(staff.suggested)} (제안값)</span>`;
  return `${head} = ${parts.join(" + ")}${staff.over ? ` <span class="hours-staff-over">합이 총 교사 수보다 ${count(-staff.other)}명 많음</span>` : ""}`;
}

function hoursStaffSummary(stats) {
  return `<p class="hours-summary-line hours-staff-summary">
    <span class="hours-summary-label">교원 구성</span>
    <span class="hours-staff-formula">${hoursStaffFormula(stats)}</span>
    <button class="button button-quiet" type="button" data-open-dialog="hoursSettingsDialog" aria-haspopup="dialog">교원 구성 입력</button>
  </p>`;
}

// 시수 설정 팝업의 교원 구성 입력: 총 교사 수와 비교과 교사(교사 수·맡은 수업 시수).
function hoursStaffSettings(stats) {
  const settings = stats.settings;
  const rows = stats.nonTeaching.map((row) => {
    const subjects = row.items.map((item) => `${item.grade}-${item.semester} ${item.subject} ${item.hours}시간`);
    return `<tr>
      <th scope="row">${escapeHtml(row.label)}</th>
      <td><input class="hours-small-input" id="hoursNonTeaching-${row.id}" data-hours-non-teaching="${row.id}" data-focus-key="nonteaching-${row.id}" type="number" min="0" max="50" step="0.5" value="${row.teachers ?? ""}" aria-label="${escapeHtml(row.label)} 수"></td>
      ${["1", "2"].map((semester) => `<td><input class="hours-small-input" data-hours-non-teaching-hours="${row.id}|${semester}" data-focus-key="nonteaching-hours-${row.id}-${semester}" type="number" min="0" max="999" step="1" value="${settings.nonTeachingHours[row.id]?.[semester] ?? ""}" placeholder="0" aria-label="${escapeHtml(row.label)} ${semester}학기 직접 입력 수업 시수"></td>`).join("")}
      <td class="closure-subject"><span class="hours-note">${subjects.length ? escapeHtml(subjects.join(", ")) : "-"}</span></td>
      <td>${row.averages ? `${hoursFormat(row.averages["1"])} / ${hoursFormat(row.averages["2"])}` : "-"}</td>
    </tr>`;
  }).join("");
  return `<section class="hours-staff-settings" aria-labelledby="hoursStaffTitle">
    <h4 id="hoursStaffTitle">교원 구성</h4>
    <div class="hours-settings-row">
      <label class="hours-classes">총 교사 수 (학교 교원 정원) <input id="hoursTotalTeachers" data-hours-total-teachers="1" data-focus-key="total-teachers" type="number" min="0" max="500" step="0.5" value="${settings.totalTeachers ?? ""}" placeholder="${hoursFormat(stats.staff.suggested, 1)}"></label>
      <span class="hours-note">비워 두면 교과 + 진로 + 비교과 합(흐린 숫자)을 씁니다.</span>
    </div>
    <div class="aggregate-sheet-wrap"><table class="closure-table hours-staff-table">
      <thead><tr><th scope="col">비교과 교사</th><th scope="col">교사 수</th><th scope="col">직접 입력 수업 시수<br>1학기</th><th scope="col">직접 입력 수업 시수<br>2학기</th><th scope="col">맡은 과목<br>(과목별 상세에서 지정)</th><th scope="col">1인당 시수<br>(1학기 / 2학기)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="hours-staff-line">${hoursStaffFormula(stats)}</p>
    <p class="note">비교과 교사는 교과 평균 시수 계산에서 뺍니다. 보건교사가 교양 '보건'을 맡는 것처럼 비교과 교사가 수업을 맡으면 과목별 상세에서 그 과목의 담당 교과를 비교과 교사로 고르세요. 그 시수는 교과 쪽에서 빠지고 위 표의 1인당 시수로 따로 보입니다. 편제표에 없는 수업은 '직접 입력 수업 시수'에 적습니다(교과 시수에서 빼지 않음).</p>
  </section>`;
}

// 교과별 교사 수 추천(시수 균형): 추천만 보이고, '추천 적용'을 눌러야 교사 수가 바뀐다.
function hoursRecommendationSection(stats) {
  const recommendation = stats.recommendation;
  const settings = stats.settings;
  const range = (value) => value ? `${hoursFormat(value[0], 1)}~${hoursFormat(value[1], 1)}` : "-";
  const pair = (value) => value ? `${hoursFormat(value["1"], 1)} / ${hoursFormat(value["2"], 1)}` : "-";
  const headline = recommendation.ok
    ? `추천대로 하면 1인당 시수 범위 ${range(recommendation.range.current)} → ${range(recommendation.range.recommended)}${recommendation.changed ? ` · 바뀌는 교과 ${recommendation.changed}개` : " · 지금과 같음"}`
    : recommendation.reason;
  const rows = recommendation.rows.map((row) => {
    const diff = row.diff;
    const diffText = !diff ? "" : diff > 0 ? `+${hoursFormat(diff, 1)} 충원` : `${hoursFormat(diff, 1)} 감원`;
    return `<tr class="${row.locked ? "is-locked" : ""}${diff ? " is-changed" : ""}">
      <th scope="row" class="closure-subject">${escapeHtml(hoursDepartmentName(row.id))}</th>
      <td>${hoursFormat(row.hours["1"], 1)}</td><td>${hoursFormat(row.hours["2"], 1)}</td>
      <td><input type="checkbox" data-hours-lock="${row.id}" data-focus-key="lock-${row.id}"${row.locked ? " checked" : ""}${row.current === null ? " disabled" : ""} aria-label="${escapeHtml(hoursDepartmentName(row.id))} 교사 수 고정"></td>
      <td>${row.current === null ? "-" : hoursFormat(row.current, 1)}</td>
      <td><b>${row.recommended}</b></td>
      <td class="${diff > 0 ? "hours-up" : diff < 0 ? "hours-down" : ""}">${diffText}${row.overCap ? `${diffText ? "<br>" : ""}<span class="hours-note">지금 한 학기 ${recommendation.maxHours}시간 초과${row.locked ? "(고정)" : ""}</span>` : ""}</td>
      <td>${pair(row.currentPerTeacher)}</td>
      <td>${pair(row.recommendedPerTeacher)}</td>
    </tr>`;
  }).join("");
  const undo = hoursPlainObject(settings.undo) ? settings.undo : null;
  return `<details class="hours-detail hours-recommend" data-hours-details="recommend">
    <summary>교과별 교사 수 추천 (시수 균형) · ${escapeHtml(headline)}</summary>
    <div class="hours-settings-row hours-recommend-tools">
      <label class="hours-classes">기준 교과 교사 수 <input id="hoursRecommendTotal" data-hours-recommend-total="1" data-focus-key="recommend-total" type="number" min="0" max="500" step="1" value="${settings.recommendTeachers ?? ""}" placeholder="${hoursFormat(recommendation.basis, 1)}"></label>
      <span class="hours-note">비우면 ${escapeHtml(recommendation.basisText)} = ${hoursFormat(recommendation.basis, 1)}명</span>
      <label class="hours-classes">한 학기 1인당 최대 <input id="hoursMaxHours" data-hours-max-hours="1" data-focus-key="max-hours" type="number" min="1" max="40" step="1" value="${settings.maxTeacherHours ?? ""}" placeholder="${HOURS_DEFAULT_MAX_TEACHER_HOURS}">시간</label>
      <button class="button" type="button" data-hours-action="apply-recommendation"${recommendation.ok && recommendation.changed ? "" : " disabled"}>추천 적용</button>
      ${undo ? `<button class="button button-quiet" type="button" data-hours-action="undo">되돌리기 (${escapeHtml(undo.label)})</button>` : ""}
    </div>
    <p class="note">교사 수는 정원·표시과목에 따라 학교가 정하므로 <b>추천만</b> 합니다. 1인당 시수가 학교 평균(1학기 ${recommendation.average ? hoursFormat(recommendation.average["1"], 1) : "-"} · 2학기 ${recommendation.average ? hoursFormat(recommendation.average["2"], 1) : "-"}시간)에서 가장 덜 벗어나도록 두 학기를 함께 보고 나누며, 같으면 지금 교사 수와 차이가 적은 쪽을 고릅니다. 시수가 있는 교과는 최소 1명입니다. '고정'한 교과는 바꾸지 않고 나머지 교사로 나눕니다. 진로(합계 제외) 교사는 추천에서 뺍니다.</p>
    ${recommendation.notes.map((note) => `<p class="note">${escapeHtml(note)}</p>`).join("")}
    ${rows ? `<div class="aggregate-sheet-wrap"><table class="closure-table hours-recommend-table">
      <thead><tr><th scope="col">교과</th><th scope="col">1학기 시수</th><th scope="col">2학기 시수</th><th scope="col">고정</th><th scope="col">현재 교사 수</th><th scope="col">추천</th><th scope="col">차이</th><th scope="col">현재 1인당<br>(1학기 / 2학기)</th><th scope="col">추천 시 1인당<br>(1학기 / 2학기)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>` : ""}
  </details>`;
}

function renderHoursStats() {
  const content = document.getElementById("hoursStatsContent");
  if (!content) return;
  const year = hoursTargetYear();
  document.getElementById("hoursTargetYear").textContent = year ? `${year}학년도` : "";
  syncNextYearClassInputs();
  const download = document.getElementById("downloadHoursStats");
  let stats;
  try {
    stats = computeHoursStats(year);
  } catch (error) {
    content.innerHTML = `<p class="storage-warning">${escapeHtml(error.message)}</p>`;
    download.disabled = true;
    return;
  }
  download.disabled = !stats.items.length;
  const settings = stats.settings;
  const rounds = applicationRoundNumbers().filter((round) => roundStatusData(round)?.students?.length || state.roundStatuses?.[round]?.snapshot);
  const gradeCards = stats.grades.map((info) => {
    const sourceSelect = info.grade === "1" ? "" : `<label class="hours-source">선택과목 근거
      <select data-hours-source="${info.grade}" data-focus-key="source-${info.grade}">
        <option value="">자동 (최근 확정 차수)</option>
        ${rounds.map((round) => `<option value="${round}"${settings.sourceRounds[info.grade] === round ? " selected" : ""}>${round}차 · ${escapeHtml(roundStatusLabel(round))}</option>`).join("")}
      </select></label>
      <span class="hours-source-state">${info.source ? `현 ${Number(info.grade) - 1}학년 ${info.source.round}차 ${info.source.confirmed ? "확정 결과" : "미확정 결과(임시)"}` : `현 ${Number(info.grade) - 1}학년 결과 없음`}</span>`;
    return `<article class="hours-grade-card${info.hasLayout ? "" : " is-missing"}">
      <h4>내년도 ${info.grade}학년</h4>
      <label class="hours-classes">학급 수 <input id="hoursClasses${info.grade}" data-hours-classes="${info.grade}" data-focus-key="classes-${info.grade}" type="number" min="0" max="99" step="1" value="${info.classes ?? ""}" placeholder="입력"></label>
      <p class="hours-plan-file">${info.cohortYear}학년도 입학생 편제표 · ${info.hasLayout ? escapeHtml(info.fileName || "불러옴") : `<button class="button button-quiet" type="button" data-hours-cohort="${info.cohortYear}">미업로드 · 1단계에서 업로드</button>`}</p>
      ${sourceSelect}
    </article>`;
  }).join("");
  const average = stats.totals.average;
  const overview = `<div class="aggregate-overview" aria-label="시수 통계 요약">
    <div class="aggregate-overview-card"><span>총 학급</span><strong>${stats.totalClasses}학급</strong></div>
    <div class="aggregate-overview-card"><span>교과 시수 (1학기 / 2학기)</span><strong>${stats.totals["1"]} / ${stats.totals["2"]}</strong></div>
    <div class="aggregate-overview-card"><span>총 교사 수${stats.staff.entered === null ? " (제안값)" : ""}</span><strong>${stats.staff.total === null ? "입력" : `${hoursFormat(stats.staff.total, 1)}명`}</strong></div>
    <div class="aggregate-overview-card"><span>교과 교사 수 (진로 제외)</span><strong>${hoursFormat(stats.totals.teachers, 1)}명</strong></div>
    <div class="aggregate-overview-card"><span>교과 1인당 평균 (창체 포함)</span><strong>${average ? `${hoursFormat(average.year)} (${hoursFormat(average.creativeYear)})` : "교사 수 입력"}</strong></div>
  </div>`;
  const departmentRows = stats.departments.filter((department) => department.id !== "기타" || department.items.length).map((department) => {
    const groupStart = stats.departments.find((item) => item.group === department.group) === department;
    const allocation = ["과학", "사회"].includes(department.group) && !department.common
      ? ["1", "2"].map((semester) => `<input class="hours-small-input"${semester === "1" && stats.departments.find((item) => item.group === department.group && !item.common) === department ? ` id="hoursAllocation-${department.group}"` : ""} data-hours-allocation="${department.id}|${semester}" data-focus-key="alloc-${department.id}-${semester}" type="number" min="0" max="999" step="1" value="${settings.allocations[department.id]?.[semester] ?? ""}" aria-label="${escapeHtml(hoursDepartmentName(department.id))} ${semester}학기 공통 과목 배분 시수" placeholder="0">`).join(" ")
      : department.common && department.items.length
        ? `<span class="hours-note">미배분 ${department.unallocated["1"]} / ${department.unallocated["2"]}</span>`
        : "";
    const allocationNote = ["1", "2"].map((semester) => settings.allocationNotes[department.id]?.[semester] ? `${semester}학기 ${settings.allocationNotes[department.id][semester]}` : "")
      .filter(Boolean).join(" / ");
    const delta = department.yearAverage !== null && department.previous !== null ? department.yearAverage - department.previous : null;
    return `<tr class="${groupStart ? "hours-group-start" : ""}${department.excluded ? " is-excluded" : ""}">
      <th scope="row" class="closure-subject">${escapeHtml(hoursDepartmentName(department.id))}${department.excluded ? ' <span class="hours-note">합계 제외</span>' : ""}</th>
      <td>${department.hours["1"] || ""}</td><td>${department.hours["2"] || ""}</td>
      <td class="hours-allocation">${allocation}${allocationNote ? `<br><span class="hours-note">${escapeHtml(allocationNote)}</span>` : ""}</td>
      <td><input class="hours-small-input" id="hoursTeachers-${department.id}" data-hours-teachers="${department.id}" data-focus-key="teachers-${department.id}" type="number" min="0" max="200" step="0.5" value="${department.teachers ?? ""}" aria-label="${escapeHtml(hoursDepartmentName(department.id))} 교사 수"${department.common ? ' placeholder="배분"' : ""}></td>
      <td>${department.averages ? hoursFormat(department.averages["1"]) : "-"}</td>
      <td>${department.averages ? hoursFormat(department.averages["2"]) : "-"}</td>
      <td><b>${hoursFormat(department.yearAverage)}</b>${department.common && department.groupAverage !== null ? `<br><span class="hours-note">${department.group} 전체 ${hoursFormat(department.groupAverage)}</span>` : ""}</td>
      <td><input class="hours-small-input" data-hours-previous="${department.id}" data-focus-key="previous-${department.id}" type="number" min="0" max="100" step="0.01" value="${settings.previousAverages[department.id] ?? ""}" aria-label="${escapeHtml(hoursDepartmentName(department.id))} 전년도 평균 시수"></td>
      <td class="${delta > 0 ? "hours-up" : delta < 0 ? "hours-down" : ""}">${delta === null ? "" : `${delta > 0 ? "+" : ""}${hoursFormat(delta)}`}</td>
    </tr>`;
  }).join("");
  const gradeMap = `<p class="note hours-grade-map">${stats.grades.map((info) => `내년도 ${escapeHtml(info.label)}`).join(" · ")}</p>`;
  const summaryTable = `<div class="aggregate-sheet-wrap"><table class="closure-table hours-summary-table">
    <thead><tr><th scope="col">교과</th><th scope="col">1학기 시수</th><th scope="col">2학기 시수</th><th scope="col">공통 과목 배분<br>(1학기 / 2학기)</th><th scope="col">교사 수</th><th scope="col">평균<br>1학기</th><th scope="col">평균<br>2학기</th><th scope="col">평균<br>1년</th><th scope="col">전년도<br>평균</th><th scope="col">증감</th></tr></thead>
    <tbody>${departmentRows}</tbody>
    <tfoot><tr><th scope="row">교과 합계 · 교과 교사 평균 (진로 제외)</th><td>${stats.totals["1"]}</td><td>${stats.totals["2"]}</td><td></td><td>${hoursFormat(stats.totals.teachers, 1)}</td>
      <td>${average ? hoursFormat(average["1"]) : "-"}</td><td>${average ? hoursFormat(average["2"]) : "-"}</td><td><b>${average ? hoursFormat(average.year) : "-"}</b></td><td></td><td></td></tr>
      <tr><th scope="row">창체 포함 평균</th><td colspan="3" class="hours-note">창체 ${stats.creativeHours}시간 × ${stats.totalClasses}학급 = 학기당 ${stats.totals.creative}시간</td><td></td>
      <td>${average ? hoursFormat(average.creative1) : "-"}</td><td>${average ? hoursFormat(average.creative2) : "-"}</td><td><b>${average ? hoursFormat(average.creativeYear) : "-"}</b></td><td></td><td></td></tr>
      <tr class="hours-reference-row"><th scope="row">전체 교원 기준 평균 (참고)</th><td>${stats.staff.allHours["1"]}</td><td>${stats.staff.allHours["2"]}</td><td class="hours-note">교과 + 진로 + 비교과 수업 시수 ÷ 총 교사 수</td><td>${stats.staff.total === null ? "-" : hoursFormat(stats.staff.total, 1)}</td>
      <td>${stats.staff.average ? hoursFormat(stats.staff.average["1"]) : "-"}</td><td>${stats.staff.average ? hoursFormat(stats.staff.average["2"]) : "-"}</td><td>${stats.staff.average ? hoursFormat(stats.staff.average.year) : "-"}</td><td></td><td></td></tr></tfoot>
  </table></div>`;
  const allocateTools = stats.departments.filter((department) => department.common && department.items.length).map((department) =>
    `<button class="button button-quiet" type="button" data-hours-auto-allocate="${department.group}">${department.group} 공통 시수 자동 배분</button>`).join("");
  const tableTools = allocateTools ? `<p class="hours-summary-line hours-table-tools"><span class="hours-summary-label">공통 과목</span>${allocateTools}
    <span class="hours-note">세부 교과 교사 수를 기준으로 공통 과목을 반 단위로 나눠 세부 교과 1인당 시수가 비슷해지게 배분 칸을 채웁니다.</span>
    ${hoursPlainObject(settings.undo) ? `<button class="button button-quiet" type="button" data-hours-action="undo">되돌리기 (${escapeHtml(settings.undo.label)})</button>` : ""}</p>` : "";
  const departmentOptions = (selected) => HOURS_DEPARTMENTS.map((department) =>
    `<option value="${department.id}"${department.id === selected ? " selected" : ""}>${escapeHtml(hoursDepartmentName(department.id))}</option>`).join("") +
    `<optgroup label="비교과 교사 (교과 평균에서 뺌)">${HOURS_NON_TEACHING.map((role) => {
      const value = HOURS_NON_TEACHING_PREFIX + role.id;
      return `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(hoursDepartmentName(value))}</option>`;
    }).join("")}</optgroup>`;
  const detailRows = stats.items.slice().sort((a, b) => a.grade.localeCompare(b.grade) || a.semester.localeCompare(b.semester) ||
    hoursDepartmentOrder(a.department) - hoursDepartmentOrder(b.department) ||
    a.subject.localeCompare(b.subject, "ko")).map((item) => `<tr class="${item.classes === 0 ? "is-zero" : ""}${item.manual ? " is-manual" : ""}">
      <td>${item.grade}</td><td>${item.cohortYear}</td><td>${item.currentGrade ? `현 ${item.currentGrade}` : "신입"}</td><td>${item.semester}</td><th scope="row" class="closure-subject">${escapeHtml(item.subject)}</th>
      <td>${item.kind}</td>
      <td><select data-hours-department="${escapeHtml(normalizeResultCourseName(item.subject))}" data-default-department="${item.defaultDepartment}" data-focus-key="dept-${escapeHtml(item.key)}" aria-label="${escapeHtml(item.subject)} 담당 교과">${departmentOptions(item.department)}</select></td>
      <td>${hoursFormat(item.credit)}</td>
      <td>${item.enrollment ?? ""}</td>
      <td><input class="hours-small-input" data-hours-item-classes="${escapeHtml(item.key)}" data-focus-key="item-${escapeHtml(item.key)}" type="number" min="0" max="99" step="1" value="${item.manual ? item.classes : ""}" placeholder="${item.autoClasses}" aria-label="${escapeHtml(item.subject)} 개설반"></td>
      <td>${item.hours}</td>
      <td>${escapeHtml(item.sourceRound)}</td>
      <td class="closure-subject hours-note">${escapeHtml(item.basis)}</td>
    </tr>`).join("");
  const detail = `<details class="hours-detail" data-hours-details="detail"${stats.items.some((item) => item.department === "기타") ? " open" : ""}>
    <summary>과목별 상세 (${stats.items.length}개 항목) · 담당 교과와 개설반 수정</summary>
    <p class="note">개설반 칸을 비워 두면 자동 값(흐린 숫자)을 씁니다. 담당 교과를 바꾸면 같은 이름의 과목 전체에 적용됩니다.</p>
    <div class="aggregate-sheet-wrap"><table class="closure-table hours-detail-table"><thead><tr><th scope="col">내년도<br>학년</th><th scope="col">입학<br>연도</th><th scope="col">신청<br>학년</th><th scope="col">학기</th><th scope="col">과목</th><th scope="col">구분</th><th scope="col">담당 교과</th><th scope="col">학점</th><th scope="col">신청</th><th scope="col">개설반</th><th scope="col">시수</th><th scope="col">근거 차수</th><th scope="col">근거</th></tr></thead>
    <tbody>${detailRows}</tbody></table></div>
  </details>`;
  // 설정 입력과 확인 항목 전체는 팝업에 두고, 화면에는 한 줄 요약과 버튼만 남겨 표가 위에서 바로 보이게 한다.
  const settingsBody = document.getElementById("hoursSettingsBody");
  if (settingsBody) {
    settingsBody.innerHTML = `<div class="hours-grade-cards">${gradeCards}</div>
    <div class="hours-settings-row">
      <label class="hours-classes">창체 시수 (학급당·학기) <input id="hoursCreative" data-hours-creative="1" data-focus-key="creative" type="number" min="0" max="10" step="0.5" value="${settings.creativeHours ?? ""}" placeholder="2"></label>
      <span class="hours-note">교과별 교사 수는 표에서 입력하며 소수(0.5 등)도 됩니다. 진로 교과(진로와 직업)는 합계와 평균에서 뺍니다.</span>
    </div>
    ${hoursStaffSettings(stats)}`;
  }
  const issuesBody = document.getElementById("hoursIssuesBody");
  if (issuesBody) issuesBody.innerHTML = hoursIssueList(stats.issues);
  // 다시 그려도 사용자가 펼친 상세·추천 칸은 펼친 채로 둔다.
  const opened = new Map([...content.querySelectorAll("details[data-hours-details]")].map((element) => [element.dataset.hoursDetails, element.open]));
  content.innerHTML = `${hoursSettingsSummary(stats)}
    ${hoursStaffSummary(stats)}
    ${hoursIssueSummary(stats.issues)}
    ${overview}
    ${gradeMap}
    ${tableTools}
    ${summaryTable}
    ${hoursRecommendationSection(stats)}
    ${detail}`;
  for (const element of content.querySelectorAll("details[data-hours-details]")) {
    if (opened.has(element.dataset.hoursDetails)) element.open = opened.get(element.dataset.hoursDetails);
  }
}

function scheduleHoursRerender() {
  if (hoursRenderTimer !== null) clearTimeout(hoursRenderTimer);
  hoursRenderTimer = setTimeout(() => {
    hoursRenderTimer = null;
    const focusKey = document.activeElement?.dataset?.focusKey;
    renderHoursStats();
    renderWorkspaceContext();
    if (focusKey) {
      const target = [...document.querySelectorAll("[data-focus-key]")].find((element) => element.dataset.focusKey === focusKey);
      target?.focus();
    }
  }, 0);
}

function updateHoursSetting(target) {
  const year = hoursTargetYear();
  if (!/^\d{4}$/.test(year)) return false;
  const settings = hoursSettings(year, true);
  const set = (object, key, value) => {
    if (value === null) delete object[key];
    else object[key] = value;
  };
  if (target.dataset.hoursClasses || target.dataset.nextGrade) {
    const grade = target.dataset.hoursClasses || target.dataset.nextGrade;
    set(settings.classCounts, grade, hoursNumber(target.value, { integer: true, max: 99 }));
    return "classes";
  }
  if (target.dataset.hoursCreative) set(settings, "creativeHours", hoursNumber(target.value, { max: 10 }));
  else if (target.dataset.hoursTotalTeachers) set(settings, "totalTeachers", hoursNumber(target.value, { max: 500 }));
  else if (target.dataset.hoursNonTeaching) set(settings.nonTeaching, target.dataset.hoursNonTeaching, hoursNumber(target.value, { max: 50 }));
  else if (target.dataset.hoursNonTeachingHours) {
    const [role, semester] = target.dataset.hoursNonTeachingHours.split("|");
    settings.nonTeachingHours[role] ||= {};
    set(settings.nonTeachingHours[role], semester, hoursNumber(target.value, { max: 999 }));
  } else if (target.dataset.hoursLock) set(settings.teacherLocks, target.dataset.hoursLock, target.checked ? true : null);
  else if (target.dataset.hoursRecommendTotal) set(settings, "recommendTeachers", hoursNumber(target.value, { max: 500 }));
  else if (target.dataset.hoursMaxHours) set(settings, "maxTeacherHours", hoursNumber(target.value, { max: 40 }));
  else if (target.dataset.hoursSource) set(settings.sourceRounds, target.dataset.hoursSource, target.value || null);
  else if (target.dataset.hoursTeachers) set(settings.teachers, target.dataset.hoursTeachers, hoursNumber(target.value, { max: 200 }));
  else if (target.dataset.hoursPrevious) set(settings.previousAverages, target.dataset.hoursPrevious, hoursNumber(target.value, { max: 100 }));
  else if (target.dataset.hoursItemClasses) set(settings.classOverrides, target.dataset.hoursItemClasses, hoursNumber(target.value, { integer: true, max: 99 }));
  else if (target.dataset.hoursDepartment) {
    set(settings.departmentOverrides, target.dataset.hoursDepartment,
      target.value === target.dataset.defaultDepartment ? null : target.value);
  } else if (target.dataset.hoursAllocation) {
    const [department, semester] = target.dataset.hoursAllocation.split("|");
    settings.allocations[department] ||= {};
    set(settings.allocations[department], semester, hoursNumber(target.value, { max: 999 }));
    // 직접 고치면 자동 배분 때 적어 둔 반 구성은 맞지 않으니 지운다.
    if (settings.allocationNotes[department]) delete settings.allocationNotes[department][semester];
  } else return false;
  return true;
}

function loadPreviousHoursSettings() {
  const year = hoursTargetYear();
  const previousYear = String(Number(year) - 1);
  const previous = state.hoursStats?.[previousYear];
  if (!hoursPlainObject(previous)) {
    status.style.color = "#a44939";
    status.textContent = `${previousYear}학년도 시수 통계 자료가 없습니다. 교사 수와 전년도 평균은 직접 입력하세요.`;
    return;
  }
  const settings = hoursSettings(year, true);
  if (Object.keys(settings.teachers).length &&
      !window.confirm(`${year}학년도에 입력한 교사 수·담당 교과 설정을 ${previousYear}학년도 값으로 덮어쓸까요?`)) return;
  const source = hoursSettings(previousYear);
  settings.teachers = { ...source.teachers };
  settings.departmentOverrides = { ...source.departmentOverrides };
  settings.nonTeaching = { ...source.nonTeaching };
  settings.teacherLocks = { ...source.teacherLocks };
  for (const key of ["creativeHours", "totalTeachers", "maxTeacherHours"]) {
    if (source[key] !== undefined) settings[key] = source[key];
  }
  settings.previousAverages = { ...source.lastAverages };
  persistState();
  renderHoursStats();
  renderWorkspaceContext();
  status.style.color = "#287956";
  status.textContent = Object.keys(source.lastAverages).length
    ? `${previousYear}학년도 교사 수·담당 교과와 평균 시수(전년도 값)를 불러왔습니다.`
    : `${previousYear}학년도 교사 수·담당 교과를 불러왔습니다. 전년도 평균은 그 해 엑셀을 내려받은 기록이 없어 직접 입력하세요.`;
}

// '추천 적용'·'공통 시수 자동 배분' 직전 값을 한 단계 기억해 '되돌리기'로 돌린다.
function hoursRememberUndo(settings, label, keys) {
  settings.undo = { label, at: new Date().toISOString(), values: Object.fromEntries(keys.map((key) => [key, JSON.parse(JSON.stringify(settings[key] || {}))])) };
}

function hoursFinishChange(message) {
  persistState();
  renderHoursStats();
  renderWorkspaceContext();
  status.style.color = "#287956";
  status.textContent = message;
}

function applyHoursRecommendation() {
  const stats = computeHoursStats();
  const recommendation = stats.recommendation;
  if (!recommendation?.ok) {
    status.style.color = "#a44939";
    status.textContent = recommendation?.reason || "교사 수 추천을 계산하지 못했습니다.";
    return;
  }
  const changes = recommendation.rows.filter((row) => !row.locked && row.recommended !== row.current);
  if (!changes.length) {
    hoursFinishChange("지금 교사 수가 추천과 같습니다.");
    return;
  }
  const list = changes.map((row) => `${hoursDepartmentName(row.id)} ${row.current ?? 0}→${row.recommended}`).join(", ");
  if (!window.confirm(`교과별 교사 수를 추천값으로 바꿀까요? (${list})\n교사 수는 정원·표시과목에 따라 학교가 정하는 값입니다. '되돌리기'로 이전 값으로 돌릴 수 있습니다.`)) return;
  const settings = hoursSettings(stats.year, true);
  hoursRememberUndo(settings, "추천 적용", ["teachers"]);
  for (const row of changes) settings.teachers[row.id] = row.recommended;
  hoursFinishChange(`교과별 교사 수를 추천값으로 바꿨습니다(${changes.length}개 교과). 되돌리려면 '되돌리기'를 누르세요.`);
}

function autoAllocateHoursCommon(group) {
  const stats = computeHoursStats();
  const common = stats.departments.find((department) => department.common && department.group === group);
  if (!common?.items.length) return;
  const members = stats.departments.filter((department) => department.group === group && !department.common);
  const result = hoursBalanceCommonAllocation(
    members.map((member) => ({ id: member.id, hours: member.hours, teachers: member.teachers || 0 })),
    common.items.map((item) => ({ subject: item.subject, semester: item.semester, credit: item.credit, classes: item.classes })));
  if (!result.ok) {
    status.style.color = "#a44939";
    status.textContent = `${group} 공통 시수 자동 배분: ${result.reason}`;
    return;
  }
  const settings = hoursSettings(stats.year, true);
  const hasValues = members.some((member) => member.allocation["1"] || member.allocation["2"]);
  if (hasValues && !window.confirm(`${group} 세부 교과에 입력한 공통 과목 배분 시수를 자동 배분 결과로 바꿀까요? '되돌리기'로 이전 값으로 돌릴 수 있습니다.`)) return;
  hoursRememberUndo(settings, `${group} 공통 시수 자동 배분`, ["allocations", "allocationNotes"]);
  for (const member of members) {
    settings.allocations[member.id] = {};
    settings.allocationNotes[member.id] = {};
    for (const semester of ["1", "2"]) {
      if (result.allocations[member.id][semester]) settings.allocations[member.id][semester] = result.allocations[member.id][semester];
      if (result.notes[member.id][semester]) settings.allocationNotes[member.id][semester] = result.notes[member.id][semester];
    }
  }
  hoursFinishChange(`${group} 공통 과목 시수를 세부 교과 교사 수에 맞춰 반 단위로 나눴습니다. 되돌리려면 '되돌리기'를 누르세요.`);
}

function undoHoursChange() {
  const settings = hoursSettings(hoursTargetYear(), true);
  const undo = settings.undo;
  if (!hoursPlainObject(undo) || !hoursPlainObject(undo.values)) return;
  for (const [key, value] of Object.entries(undo.values)) settings[key] = hoursPlainObject(value) ? value : {};
  delete settings.undo;
  hoursFinishChange(`'${undo.label}' 이전 값으로 되돌렸습니다.`);
}

function buildHoursWorkbookSheets(stats) {
  const rows = [];
  const merges = [];
  const title = `${stats.year}학년도 교과별 시수 통계 (총${stats.totalClasses}학급)`;
  const now = new Date();
  const schoolName = $("#schoolName")?.value || "";
  rows.push([{ v: title, s: 1 }]);
  rows.push([{ v: `${schoolName} (${String(now.getFullYear()).slice(2)}.${String(now.getMonth() + 1).padStart(2, "0")}.)`, s: 0 }]);
  merges.push("A1:X1", "A2:X2");
  const header = (value) => ({ v: value, s: 2 });
  rows.push([header("교과군"), header(""), header("학기"), ...stats.grades.flatMap((info) => [header(`${info.grade}학년\n(${info.cohortYear} 입학${info.grade === "1" ? " · 신입생" : ` · 현 ${Number(info.grade) - 1}학년${info.source ? ` ${info.source.round}차 ${info.source.confirmed ? "확정" : "미확정"}` : " 결과 없음"}`})`), header(""), header(""), header("")]),
    header("총시수"), header(""), header(""), header("교사 수"), header(`평균시수(${stats.year})`), header(""), header("비고"), header(`${Number(stats.year) - 1}\n평균시수(1년)`), header("공통 배분")]);
  rows.push([header(""), header(""), header(""), ...["세부과목", "학점", "개설반", "시수", "세부과목", "학점", "개설반", "시수", "세부과목", "학점", "개설반", "시수"].map(header),
    header("1학기"), header("2학기"), header("합계"), header(""), header("학기별"), header("1년"), header(""), header(""), header("")]);
  merges.push("A3:B4", "C3:C4", "D3:G3", "H3:K3", "L3:O3", "P3:R3", "S3:S4", "T3:U3", "V3:V4", "W3:W4", "X3:X4");
  const firstSemesterRows = [];
  const blockFirstRows = { "1": [], "2": [] };
  const visible = stats.departments.filter((department) => department.items.length || department.teachers > 0);
  let groupStart = null;
  visible.forEach((department, index) => {
    const departmentStart = rows.length + 1;
    if (groupStart === null) groupStart = departmentStart;
    const firstInGroup = groupStart === departmentStart;
    const blockStarts = {};
    for (const semester of ["1", "2"]) {
      const byGrade = ["1", "2", "3"].map((grade) => department.items
        .filter((item) => item.grade === grade && item.semester === semester)
        .sort((a, b) => a.subject.localeCompare(b.subject, "ko")));
      const height = Math.max(1, ...byGrade.map((list) => list.length));
      const start = rows.length + 1;
      blockStarts[semester] = start;
      const end = start + height - 1;
      for (let offset = 0; offset < height; offset++) {
        const rowNumber = start + offset;
        const row = [{ v: "", s: 4 }, { v: "", s: 4 }, { v: offset === 0 ? Number(semester) : "", s: 4 }];
        byGrade.forEach((list, gradeIndex) => {
          const item = list[offset];
          const creditColumn = columnName(4 + gradeIndex * 4);
          const classColumn = columnName(5 + gradeIndex * 4);
          row.push(item ? { v: item.subject, s: 3 } : { v: "", s: 3 });
          row.push(item ? { v: item.credit, s: 4 } : { v: "", s: 4 });
          row.push(item ? { v: item.classes, s: 4 } : { v: "", s: 4 });
          row.push(item ? { f: `${creditColumn}${rowNumber}*${classColumn}${rowNumber}`, v: item.hours, s: 4 } : { v: "", s: 4 });
        });
        rows.push(row);
      }
      const sumFormula = `SUM(G${start}:G${end},K${start}:K${end},O${start}:O${end})`;
      const semesterHours = department.hours[semester];
      const first = rows[start - 1];
      first[15] = semester === "1" ? { f: sumFormula, v: semesterHours, s: 4 } : { v: "", s: 4 };
      first[16] = semester === "2" ? { f: sumFormula, v: semesterHours, s: 4 } : { v: "", s: 4 };
      first[17] = { f: `SUM(P${start}:Q${start})+X${start}`, v: department.totals[semester], s: 4 };
      first[23] = { v: department.allocation[semester] || "", s: 4 };
      for (let column = 15; column < 24; column++) {
        for (let rowNumber = start + 1; rowNumber <= end; rowNumber++) rows[rowNumber - 1][column] = { v: "", s: 4 };
      }
      for (const column of ["C", "P", "Q", "R", "T", "X"]) if (end > start) merges.push(`${column}${start}:${column}${end}`);
      blockFirstRows[semester].push({ row: start, department });
    }
    const departmentEnd = rows.length;
    const teacherRow = rows[departmentStart - 1];
    const notes = [];
    if (department.excluded) notes.push("합계 제외");
    if (department.common && department.items.length) notes.push(`미배분 ${department.unallocated["1"]}/${department.unallocated["2"]}`);
    if (department.common && department.groupAverage !== null) notes.push(`${department.group} 전체 평균 ${hoursFormat(department.groupAverage)}`);
    for (const semester of ["1", "2"]) {
      const allocationNote = stats.settings?.allocationNotes?.[department.id]?.[semester];
      if (allocationNote) notes.push(`공통 배분 ${semester}학기: ${allocationNote}`);
    }
    teacherRow[0] = { v: firstInGroup ? department.group : "", s: 6 };
    teacherRow[1] = { v: department.label === department.group ? "" : department.label, s: 6 };
    teacherRow[18] = department.teachers === null ? { v: "", s: 4 } : { v: department.teachers, s: 4 };
    for (const semester of ["1", "2"]) {
      const start = blockStarts[semester];
      rows[start - 1][19] = { f: `IF(S${departmentStart}>0,R${start}/S${departmentStart},"")`, v: department.averages ? department.averages[semester] : "", s: 5 };
    }
    teacherRow[20] = { f: `IF(S${departmentStart}>0,AVERAGE(T${blockStarts["1"]},T${blockStarts["2"]}),"")`, v: department.yearAverage ?? "", s: 5 };
    teacherRow[21] = { v: notes.join("\n"), s: 3 };
    teacherRow[22] = department.previous === null ? { v: "", s: 4 } : { v: department.previous, s: 5 };
    for (const column of ["B", "S", "U", "V", "W"]) if (departmentEnd > departmentStart) merges.push(`${column}${departmentStart}:${column}${departmentEnd}`);
    if (!department.excluded) firstSemesterRows.push(departmentStart);
    const next = visible[index + 1];
    if (!next || next.group !== department.group) {
      if (departmentEnd > groupStart) merges.push(`A${groupStart}:A${departmentEnd}`);
      groupStart = null;
    }
  });
  const includedBlocks = (semester) => blockFirstRows[semester].filter(({ department }) => !department.excluded).map(({ row }) => `${semester === "1" ? "P" : "Q"}${row}`);
  const totalRow = rows.length + 1;
  const averageRow = totalRow + 1;
  const creativeRow = totalRow + 2;
  const totals = stats.totals;
  const average = totals.average;
  const label = (value) => ({ v: value, s: 6 });
  const blankLabels = () => Array.from({ length: 14 }, () => label(""));
  rows.push([label(`교과 합계 (진로 제외${totals.excludedHours ? ` · 진로 ${totals.excludedHours}시간` : ""})`), ...blankLabels(),
    { f: `SUM(${includedBlocks("1").join(",") || 0})`, v: totals["1"], s: 6 },
    { f: `SUM(${includedBlocks("2").join(",") || 0})`, v: totals["2"], s: 6 },
    { f: `P${totalRow}+Q${totalRow}`, v: totals["1"] + totals["2"], s: 6 },
    { f: `SUM(${firstSemesterRows.map((row) => `S${row}`).join(",") || 0})`, v: totals.teachers, s: 6 }]);
  rows.push([label("교과 교사 1인당 평균 (창체 제외)"), ...blankLabels(),
    { f: `IF(S${totalRow}>0,P${totalRow}/S${totalRow},"")`, v: average ? average["1"] : "", s: 7 },
    { f: `IF(S${totalRow}>0,Q${totalRow}/S${totalRow},"")`, v: average ? average["2"] : "", s: 7 },
    { f: `IF(S${totalRow}>0,R${totalRow}/S${totalRow}/2,"")`, v: average ? average.year : "", s: 7 }]);
  rows.push([label(`창체 포함 평균 (창체 ${stats.creativeHours}시간 × ${stats.totalClasses}학급 = 학기당 ${totals.creative}시간)`), ...blankLabels(),
    { f: `IF(S${totalRow}>0,(P${totalRow}+${totals.creative})/S${totalRow},"")`, v: average ? average.creative1 : "", s: 7 },
    { f: `IF(S${totalRow}>0,(Q${totalRow}+${totals.creative})/S${totalRow},"")`, v: average ? average.creative2 : "", s: 7 },
    { f: `IF(S${totalRow}>0,(R${totalRow}+${totals.creative * 2})/S${totalRow}/2,"")`, v: average ? average.creativeYear : "", s: 7 }]);
  merges.push(`A${totalRow}:O${totalRow}`, `A${averageRow}:O${averageRow}`, `A${creativeRow}:O${creativeRow}`);
  // 전체 교원 기준 평균(참고)과 교원 구성 표. 교과 평균은 위 줄(교과 시수 ÷ 교과 교사)이고 이 값은 참고용이다.
  const staff = stats.staff;
  const referenceRow = creativeRow + 1;
  const staffHead = referenceRow + 2;
  const staffRows = {
    total: staffHead + 1, subject: staffHead + 2, career: staffHead + 3,
    firstRole: staffHead + 4, lastRole: staffHead + 3 + stats.nonTeaching.length, other: staffHead + 4 + stats.nonTeaching.length
  };
  const staffTotal = staff.total ?? 0;
  rows.push([label(`전체 교원 기준 평균 (참고) = (교과 + 진로 + 비교과 수업 시수) ÷ 총 교사 ${hoursFormat(staffTotal, 1)}명`), ...blankLabels(),
    { f: `IF(D${staffRows.total}>0,SUM(E${staffRows.subject}:E${staffRows.lastRole})/D${staffRows.total},"")`, v: staff.average ? staff.average["1"] : "", s: 7 },
    { f: `IF(D${staffRows.total}>0,SUM(F${staffRows.subject}:F${staffRows.lastRole})/D${staffRows.total},"")`, v: staff.average ? staff.average["2"] : "", s: 7 },
    { f: `IF(D${staffRows.total}>0,(SUM(E${staffRows.subject}:E${staffRows.lastRole})+SUM(F${staffRows.subject}:F${staffRows.lastRole}))/D${staffRows.total}/2,"")`, v: staff.average ? staff.average.year : "", s: 7 }]);
  merges.push(`A${referenceRow}:O${referenceRow}`);
  rows.push([]);
  const perYear = (row) => ({ f: `IF(D${row}>0,(E${row}+F${row})/D${row}/2,"")`, v: "", s: 5 });
  const staffLine = (name, teachers, hours, note, style = 3) => [{ v: name, s: style }, { v: "", s: style }, { v: "", s: style }, teachers, hours[0], hours[1], null, { v: note, s: 3 }];
  rows.push([header("교원 구성"), header(""), header(""), header("교사 수"), header("1학기\n수업 시수"), header("2학기\n수업 시수"), header("1인당 시수\n(1년)"), header("비고")]);
  rows.push(staffLine("총 교사 수", { v: staffTotal, s: 6 }, [{ v: "", s: 4 }, { v: "", s: 4 }],
    staff.entered === null ? "제안값(교과 + 진로 + 비교과 합) · 시수 설정에서 총 교사 수를 입력하세요" : "직접 입력(학교 교원 정원)", 6));
  rows.push(staffLine("교과 교사 (진로 제외)", { f: `S${totalRow}`, v: totals.teachers, s: 4 }, [{ f: `P${totalRow}`, v: totals["1"], s: 4 }, { f: `Q${totalRow}`, v: totals["2"], s: 4 }],
    "교과 평균 시수 = 교과 시수 ÷ 교과 교사 수"));
  rows.push(staffLine("진로 (평균 제외)", { v: staff.career, s: 4 }, [{ v: staff.careerHours["1"], s: 4 }, { v: staff.careerHours["2"], s: 4 }], "진로와 직업 · 교과 합계·평균에서 뺌"));
  for (const role of stats.nonTeaching) {
    const subjects = role.items.map((item) => `${item.grade}-${item.semester} ${item.subject} ${item.hours}시간`);
    const extra = role.extra["1"] || role.extra["2"] ? `직접 입력 ${role.extra["1"]}/${role.extra["2"]}시간` : "";
    rows.push(staffLine(`비교과 · ${role.label}`, { v: role.teachers ?? 0, s: 4 }, [{ v: role.hours["1"], s: 4 }, { v: role.hours["2"], s: 4 }],
      [subjects.length ? `맡은 과목: ${subjects.join(", ")}` : "", extra, "교과 평균에서 뺌"].filter(Boolean).join(" · ")));
  }
  rows.push(staffLine("기타 (교과 미배정)", { f: `D${staffRows.total}-SUM(D${staffRows.subject}:D${staffRows.lastRole})`, v: staff.other ?? 0, s: 4 }, [{ v: "", s: 4 }, { v: "", s: 4 }],
    staff.over ? `교과 + 진로 + 비교과가 총 교사 수보다 ${hoursFormat(-staff.other, 1)}명 많습니다` : "총 교사 수 − 교과 − 진로 − 비교과"));
  for (let row = staffRows.total; row <= staffRows.other; row++) {
    merges.push(`A${row}:C${row}`);
    rows[row - 1][6] = row === staffRows.total || row === staffRows.other ? { v: "", s: 4 } : perYear(row);
  }
  merges.push(`A${staffHead}:C${staffHead}`);
  const summary = {
    name: "시수 통계",
    rows,
    merges,
    freeze: "A5",
    widths: [8, 9, 5, 16, 5, 6, 6, 16, 5, 6, 6, 16, 5, 6, 6, 7, 7, 7, 6, 7, 7, 16, 9, 8],
    heights: { 2: 30, 3: 44 }
  };
  const detail = {
    name: "과목별 상세",
    freeze: "A2",
    widths: [8, 8, 8, 6, 26, 8, 14, 6, 8, 8, 8, 12, 40],
    rows: [
      ["내년도 학년", "입학연도", "신청 학년", "학기", "과목", "구분", "담당 교과", "학점", "신청 인원", "개설반", "시수", "근거 차수", "근거"].map((value) => ({ v: value, s: 2 })),
      ...stats.items.slice().sort((a, b) => a.grade.localeCompare(b.grade) || a.semester.localeCompare(b.semester) || a.subject.localeCompare(b.subject, "ko"))
        .map((item, index) => [
          { v: Number(item.grade), s: 4 }, { v: Number(item.cohortYear), s: 4 }, { v: item.currentGrade ? `현 ${item.currentGrade}학년` : "신입생", s: 4 },
          { v: Number(item.semester), s: 4 }, { v: item.subject, s: 3 }, { v: item.kind, s: 4 },
          { v: hoursDepartmentName(item.department), s: 4 }, { v: item.credit, s: 4 }, { v: item.enrollment ?? "", s: 4 },
          { v: item.classes, s: 4 }, { f: `H${index + 2}*J${index + 2}`, v: item.hours, s: 4 }, { v: item.sourceRound, s: 4 }, { v: item.basis, s: 3 }
        ])
    ]
  };
  const sheets = [summary, detail];
  const recommendation = stats.recommendation;
  if (recommendation?.ok && recommendation.rows.length) {
    const range = (value) => value ? `${hoursFormat(value[0], 1)}~${hoursFormat(value[1], 1)}` : "-";
    sheets.push({
      name: "교사 수 추천",
      freeze: "A4",
      widths: [18, 9, 9, 6, 10, 8, 10, 10, 10, 10, 10],
      merges: ["A1:K1", "A2:K2"],
      rows: [
        [{ v: `교과별 교사 수 추천 (시수 균형) · 기준 교과 교사 ${hoursFormat(recommendation.target, 1)}명(${recommendation.basisText}) · 한 학기 1인당 최대 ${recommendation.maxHours}시간`, s: 6 }],
        [{ v: `추천만 합니다(교사 수는 정원·표시과목에 따라 학교가 정함). 1인당 시수 범위 ${range(recommendation.range.current)} → ${range(recommendation.range.recommended)} · 학교 평균 1학기 ${hoursFormat(recommendation.average["1"], 1)} · 2학기 ${hoursFormat(recommendation.average["2"], 1)}시간`, s: 8 }],
        ["교과", "1학기 시수", "2학기 시수", "고정", "현재 교사 수", "추천", "차이", "현재 1인당\n1학기", "현재 1인당\n2학기", "추천 1인당\n1학기", "추천 1인당\n2학기"].map((value) => ({ v: value, s: 2 })),
        ...recommendation.rows.map((row, index) => {
          const line = index + 4;
          return [
            { v: hoursDepartmentName(row.id), s: 3 }, { v: Math.round(row.hours["1"] * 100) / 100, s: 4 }, { v: Math.round(row.hours["2"] * 100) / 100, s: 4 },
            { v: row.locked ? "고정" : "", s: 4 }, { v: row.current ?? "", s: 4 }, { v: row.recommended, s: 9 },
            { f: `F${line}-E${line}`, v: row.current === null ? row.recommended : row.recommended - row.current, s: 4 },
            { f: `IF(E${line}>0,B${line}/E${line},"")`, v: row.currentPerTeacher ? row.currentPerTeacher["1"] : "", s: 10 },
            { f: `IF(E${line}>0,C${line}/E${line},"")`, v: row.currentPerTeacher ? row.currentPerTeacher["2"] : "", s: 10 },
            { f: `IF(F${line}>0,B${line}/F${line},"")`, v: row.recommendedPerTeacher ? row.recommendedPerTeacher["1"] : "", s: 10 },
            { f: `IF(F${line}>0,C${line}/F${line},"")`, v: row.recommendedPerTeacher ? row.recommendedPerTeacher["2"] : "", s: 10 }
          ];
        })
      ]
    });
  }
  if (stats.issues.length) {
    const labels = { error: "필수", warning: "확인", info: "참고" };
    sheets.push({
      name: "확인 필요",
      widths: [8, 110],
      rows: [[{ v: "구분", s: 2 }, { v: "내용", s: 2 }], ...stats.issues.map((issue) => [{ v: labels[issue.level], s: 4 }, { v: issue.text, s: 3 }])]
    });
  }
  return sheets;
}

function downloadHoursStats() {
  let stats;
  try {
    stats = computeHoursStats();
  } catch (error) {
    status.style.color = "#a44939";
    status.textContent = error.message;
    return;
  }
  if (!stats.items.length) return;
  const errors = stats.issues.filter((issue) => issue.level === "error");
  if (errors.length && !window.confirm(`필수 확인 항목이 ${errors.length}개 있습니다(예: ${errors[0].text}). 그래도 엑셀을 내려받을까요?`)) return;
  const settings = hoursSettings(stats.year, true);
  settings.lastAverages = Object.fromEntries(stats.departments
    .filter((department) => department.yearAverage !== null)
    .map((department) => [department.id, Math.round(department.yearAverage * 100) / 100]));
  settings.lastExportedAt = new Date().toISOString();
  persistState();
  downloadBlob(createWorkbookBlob(buildHoursWorkbookSheets(stats)), `${stats.year}학년도_교과별_시수통계.xlsx`);
  status.style.color = "#287956";
  status.textContent = `${stats.year}학년도 교과별 시수 통계를 내려받았습니다. 교과별 평균은 다음 해 '전년도 평균'으로 불러올 수 있습니다.`;
}

function initHoursStats() {
  const content = document.getElementById("hoursStatsContent");
  if (!content) return;
  const handleChange = (event) => {
    const target = event.target;
    const changed = updateHoursSetting(target);
    if (!changed) return;
    persistState();
    if (changed === "classes") {
      syncNextYearClassInputs();
      renderAggregate();
      renderRoundStatusControls();
    }
    if (Number(state.workflowStep) === 7) scheduleHoursRerender();
    else renderWorkspaceContext();
  };
  const openCohort = (event) => {
    const cohort = event.target.closest("[data-hours-cohort]");
    if (!cohort) return;
    cohort.closest("dialog")?.close?.();
    switchWorkflowStep("1");
    switchCurriculumCohort(cohort.dataset.hoursCohort);
  };
  content.addEventListener("change", handleChange);
  content.addEventListener("click", openCohort);
  content.addEventListener("click", (event) => {
    const button = event.target.closest("[data-hours-action], [data-hours-auto-allocate]");
    if (!button) return;
    if (button.dataset.hoursAutoAllocate) autoAllocateHoursCommon(button.dataset.hoursAutoAllocate);
    else if (button.dataset.hoursAction === "apply-recommendation") applyHoursRecommendation();
    else if (button.dataset.hoursAction === "undo") undoHoursChange();
  });
  // 학급 수·근거 차수·창체 시수는 '시수 설정' 팝업 안에 있다.
  const settingsBody = document.getElementById("hoursSettingsBody");
  settingsBody?.addEventListener("change", handleChange);
  settingsBody?.addEventListener("click", openCohort);
  for (const input of document.querySelectorAll(".next-year-class-input")) input.addEventListener("change", handleChange);
  document.getElementById("downloadHoursStats").addEventListener("click", downloadHoursStats);
  document.getElementById("hoursLoadPrevious").addEventListener("click", loadPreviousHoursSettings);
  document.getElementById("schoolYear").addEventListener("change", () => {
    syncNextYearClassInputs();
    if (Number(state.workflowStep) === 7) renderHoursStats();
  });
  syncNextYearClassInputs();
}

if (typeof document !== "undefined" && document.getElementById) initHoursStats();
