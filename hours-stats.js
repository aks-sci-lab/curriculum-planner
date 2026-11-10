"use strict";
// 내년도 교과별 시수 통계: 입학연도별 편제표와 확정된 수강신청 결과로 교과(담당 교과)별 학기 시수와
// 교사 1인당 평균 시수를 계산한다. 내년도 G학년은 (내년도 − G + 1)학년도 입학생 편제표를 쓴다.
// form: 원래 양식(학교 교과별 시수표)의 세부 칸 이름, staff: 메모 '○○학년도 ⇒ … 증/감'에 쓰는 이름.
var HOURS_DEPARTMENTS = [
  { id: "국어", group: "국어", label: "", staff: "국어과" },
  { id: "수학", group: "수학", label: "", staff: "수학과" },
  { id: "영어", group: "영어", label: "", staff: "영어과" },
  { id: "과학-공통", group: "과학", label: "공통", common: true, staff: "과학(공통)" },
  { id: "과학-물리", group: "과학", label: "물리", staff: "물리" },
  { id: "과학-화학", group: "과학", label: "화학", staff: "화학" },
  { id: "과학-생명", group: "과학", label: "생명", staff: "생명과학" },
  { id: "과학-지구", group: "과학", label: "지구", staff: "지구과학" },
  { id: "사회-공통", group: "사회", label: "공통", common: true, staff: "사회(공통)" },
  { id: "사회-한국사", group: "사회", label: "한국사·역사", form: "한국사", staff: "역사과" },
  { id: "사회-지리", group: "사회", label: "지리", staff: "지리" },
  { id: "사회-일사", group: "사회", label: "일반사회", form: "일사", staff: "일반사회" },
  { id: "사회-윤리", group: "사회", label: "윤리", staff: "윤리" },
  { id: "체육", group: "체육·예술", label: "체육", staff: "체육과" },
  { id: "음악", group: "체육·예술", label: "음악", staff: "음악과" },
  { id: "미술", group: "체육·예술", label: "미술", staff: "미술과" },
  { id: "정보", group: "생활·교양", label: "정보", staff: "정보과" },
  { id: "기술가정", group: "생활·교양", label: "기술·가정", form: "기술가정", staff: "기술가정과" },
  { id: "제2외국어", group: "생활·교양", label: "제2외국어", staff: "제2외국어과" },
  { id: "교양", group: "생활·교양", label: "교양", staff: "교양" },
  { id: "진로", group: "생활·교양", label: "진로", form: "교양", excluded: true, staff: "진로" },
  { id: "기타", group: "기타", label: "", staff: "기타" }
];
// 교과 외(비교과) 교사. 교과 평균 시수에는 넣지 않고, 맡은 수업(상세 표에서 과목 지정 또는 직접 입력)이 있으면 1인당 시수를 따로 보인다.
// 순서는 원래 양식 메모('비교과 교사 : 특수2, 영양1, 보건2, 사서1')를 따른다.
var HOURS_NON_TEACHING = [
  { id: "특수", label: "특수교사" },
  { id: "영양", label: "영양교사" },
  { id: "보건", label: "보건교사" },
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
    "nonTeaching", "nonTeachingHours", "teacherLocks", "allocationNotes", "previousTeachers", "creative"]) {
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

// 창체 학급당 학기 시수: 원래 양식처럼 자율·진로로 나눠 적는다(창체 행의 학점 칸). 예전 자료(창체 시수 하나)는 진로 1 + 나머지 자율로 본다.
var HOURS_CREATIVE_PARTS = ["자율", "진로"];
function hoursCreativeParts(settings) {
  const parts = hoursPlainObject(settings?.creative) ? settings.creative : {};
  const stored = HOURS_CREATIVE_PARTS.map((part) => hoursNumber(parts[part], { max: 10 }));
  if (stored.some((value) => value !== null)) return Object.fromEntries(HOURS_CREATIVE_PARTS.map((part, index) => [part, stored[index] ?? 0]));
  const total = hoursNumber(settings?.creativeHours, { max: 10 }) ?? 2;
  const career = Math.min(1, total);
  return { 자율: total - career, 진로: career };
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
  if (!department.label || department.label === department.group) return department.group;
  // '체육·예술', '생활·교양'은 여러 교과(군)을 묶은 이름이라 세부 교과 이름만 쓴다(체육·음악·정보·기술·가정 …).
  if (department.group.includes("·")) return department.label;
  return `${department.group}(${department.label})`;
}

// 원래 양식 세부 칸 이름: 한국사·일사·기술가정처럼 양식에 쓰는 이름, 제2외국어는 개설하는 과목이 한 언어뿐이면 그 언어(일본어).
var HOURS_LANGUAGE_PATTERN = /^(일본어|중국어|프랑스어|독일어|스페인어|러시아어|아랍어|베트남어|한문)/;
function hoursFormLabel(definition, items = []) {
  if (definition.id === "제2외국어") {
    const opened = items.filter((item) => item.classes > 0 || item.manual);
    const languages = new Set((opened.length ? opened : items).map((item) => String(item.subject).replace(/\s+/g, "").match(HOURS_LANGUAGE_PATTERN)?.[1] || "제2외국어"));
    return languages.size === 1 ? [...languages][0] : "제2외국어";
  }
  return definition.form ?? definition.label;
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
// 확정 전 차수는 지금 4단계 기준으로 집계한다(buildRoundSnapshot). 기준 비율 칸이 잘못되면 aggregateThresholds가 예외를 내므로
// 5단계 전체를 멈추지 않고 그 차수만 건너뛴다. failed: 건너뛴 차수 번호를 모으는 Set(선택).
function hoursRoundSnapshot(round, failed = null) {
  if (isRoundLocked(round) && state.roundStatuses?.[round]?.snapshot) return state.roundStatuses[round].snapshot;
  try {
    return buildRoundSnapshot(round);
  } catch (error) {
    failed?.add(String(round));
    return null;
  }
}

function hoursThresholdIssue(rounds, what) {
  const list = [...rounds].sort((a, b) => Number(a) - Number(b)).map((round) => `${round}차`).join("·");
  return { level: "warning", action: "4", thresholdRounds: [...rounds].join(","),
    text: `${list} 기준 설정 값이 올바르지 않아 ${what}를 읽지 못했습니다. 4단계 '기준 설정'에서 개설·분반 기준(%)을 고치세요.` };
}

function hoursSourceResult(currentGrade, settings, failed = null) {
  const rounds = applicationRoundNumbers().slice().reverse();
  const hasGrade = (round) => roundStatusData(round)?.students?.some((student) => String(student.grade) === currentGrade);
  const pinned = String(settings.sourceRounds?.[String(Number(currentGrade) + 1)] || "");
  const round = pinned && rounds.includes(pinned) && (hasGrade(pinned) || state.roundStatuses?.[pinned]?.snapshot)
    ? pinned
    : rounds.find((item) => isRoundLocked(item) &&
        state.roundStatuses[item]?.snapshot?.rows?.some((row) => row.grade === currentGrade)) ||
      rounds.find(hasGrade);
  if (!round) return null;
  const snapshot = hoursRoundSnapshot(round, failed?.source);
  const rows = (snapshot?.rows || []).filter((row) => row.grade === currentGrade);
  if (!rows.length) return null;
  return { round, confirmed: isRoundLocked(round), pinned: pinned === round, rows, earlierClosed: hoursEarlierClosed(currentGrade, round, failed?.closed) };
}

// 근거 차수보다 앞 차수에서 폐강한 과목(정규화 이름 → { round, semesters }). 2차 재신청 결과에는 1차에 폐강한 과목이
// 아예 없으므로, 이것이 없으면 '결과에 없음(과목명 불일치?)'으로 잘못 경고한다.
function hoursEarlierClosed(currentGrade, round, failed = null) {
  const closed = new Map();
  for (const earlier of applicationRoundNumbers()) {
    if (!(Number(earlier) < Number(round))) continue;
    const snapshot = (isRoundLocked(earlier) && state.roundStatuses?.[earlier]?.snapshot) || roundStatusData(earlier)?.students?.length
      ? hoursRoundSnapshot(earlier, failed) : null;
    for (const row of snapshot?.rows || []) {
      if (row.grade !== currentGrade || row.decision !== "closed") continue;
      const key = normalizeResultCourseName(row.name);
      const found = closed.get(key) || { round: earlier, semesters: new Set() };
      found.round = earlier;
      found.semesters.add(String(row.semester || ""));
      closed.set(key, found);
    }
  }
  return closed;
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

// 내년도 G학년 카드의 '현 G−1학년 명단 n반' 안내(근거 차수 명단의 반 수). 1학년(신입생)·결과 없음이면 null.
function hoursRosterClasses(info) {
  if (info?.grade === "1" || !info?.source || typeof roundStatusData !== "function") return null;
  const currentGrade = String(Number(info.grade) - 1);
  const students = roundStatusData(info.source.round)?.students || [];
  const count = new Set(students.filter((student) => String(student.grade) === currentGrade).map((student) => String(student.classroom))).size;
  return count || null;
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

// 배분 메모에 쓰는 줄인 과목명(원래 양식: 통과·과탐실·융과·기환·통사·사문탐·기후지속). 목록에 없으면 낱말 첫 글자로 줄인다.
var HOURS_SHORT_SUBJECTS = [
  [/^통합과학/, "통과"], [/^과학탐구실험/, "과탐실"], [/^융합과학/, "융과"], [/^기후변화와환경생태/, "기환"],
  [/^통합사회/, "통사"], [/^사회문제탐구/, "사문탐"], [/^기후변화와지속가능/, "기후지속"], [/^과학의역사/, "과역"], [/^과학과제/, "과과탐"]
];
function hoursShortSubject(subject) {
  const compact = String(subject ?? "").replace(/\s+/g, "");
  const known = HOURS_SHORT_SUBJECTS.find(([pattern]) => pattern.test(compact));
  if (known) return known[1];
  const words = String(subject ?? "").replace(/[0-9ⅠⅡⅢ]+$/u, "").trim().split(/\s+/).filter(Boolean);
  return words.length > 1 ? words.map((word) => word[0]).join("") : (words[0] || "").slice(0, 3);
}

// 메모 '◈ 2027학년도 ⇒ 국어과, 기술가정과 각1명 감, 영어과 2명 감, 물리, 일반사회 각1명 증'.
// rows: [{ name, previous, current }] (교과 순서). 전년도 교사 수가 하나도 없으면 빈 문자열.
function hoursTeacherChangeLine(year, rows) {
  const list = (rows || []).filter((row) => Number.isFinite(row.previous) || Number.isFinite(row.current));
  if (!list.some((row) => Number.isFinite(row.previous))) return "";
  const groups = [];
  for (const sign of [-1, 1]) {
    const changes = list.map((row) => ({ name: row.name, delta: Math.round(((Number(row.current) || 0) - (Number(row.previous) || 0)) * 100) / 100 }))
      .filter((row) => Math.sign(row.delta) === sign);
    const sizes = [...new Set(changes.map((row) => Math.abs(row.delta)))].sort((a, b) => a - b);
    for (const size of sizes) {
      const names = changes.filter((row) => Math.abs(row.delta) === size).map((row) => row.name);
      groups.push(`${names.join(", ")} ${names.length > 1 ? "각" : ""}${size}명 ${sign < 0 ? "감" : "증"}`);
    }
  }
  return `◈ ${year}학년도 ⇒ ${groups.length ? groups.join(", ") : "교과 교사 수 변동 없음"}`;
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
      const short = hoursShortSubject(chunk.subject);
      subjects.set(short, (subjects.get(short) || 0) + chunk.size);
    }
    // 원래 양식의 배분 메모처럼 '통과8 · 과탐실2'(줄인 과목명 + 시수)로 적는다.
    for (const [id, subjects] of given) notes[id][semester] = [...subjects].map(([subject, hours]) => `${subject}${hours}`).join(" · ");
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
  const creativeParts = hoursCreativeParts(settings);
  const creativeHours = creativeParts.자율 + creativeParts.진로;
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
      const failed = { source: new Set(), closed: new Set() };
      info.source = hoursSourceResult(currentGrade, settings, failed);
      for (const [rounds, what] of [[failed.source, "수강신청 결과"], [failed.closed, "폐강 정보"]]) {
        if (rounds.size && !issues.some((issue) => issue.thresholdRounds === [...rounds].join(",") && issue.text.includes(what))) issues.push(hoursThresholdIssue(rounds, what));
      }
      if (!info.source && failed.source.size) {
        // 결과는 있는데 기준 설정 때문에 읽지 못한 경우: '결과가 없다'고 하지 않는다(위 확인 항목으로 알림).
      } else if (!info.source) {
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
          const earlier = info.source?.earlierClosed?.get(normalizeResultCourseName(entry.subject));
          const closedBefore = earlier && (earlier.semesters.has(entry.semester) || earlier.semesters.has(""));
          item.basis = closedBefore ? `현 ${currentGrade}학년 ${earlier.round}차 폐강`
            : info.source ? "신청 결과에서 찾지 못함" : "신청 결과 없음";
          if (closedBefore) {
            issues.push({ level: "info", text: `${grade}학년 ${entry.semester}학기 ${entry.subject}: 현 ${currentGrade}학년 ${earlier.round}차에서 폐강해 개설반 0으로 계산했습니다.` });
          } else if (info.source) {
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
      previous: hoursNumber(settings.previousAverages[definition.id], { max: 100 }),
      previousTeachers: hoursNumber(settings.previousTeachers[definition.id], { max: 200 }),
      formLabel: hoursFormLabel(definition, own)
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
    // 원래 양식의 과학·사회 비고(1학기·2학기 교과군 평균)와 교과군 전년도 평균(교과군 이름으로 저장).
    common.groupTeachers = groupTeachers;
    common.groupSemester = groupTeachers > 0 ? Object.fromEntries(["1", "2"].map((semester) =>
      [semester, groupMembers.reduce((sum, department) => sum + department.hours[semester], 0) / groupTeachers])) : null;
    common.groupPrevious = hoursNumber(settings.previousAverages[common.group], { max: 100 });
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
  return { year, settings, classCounts, totalClasses, creativeHours, creativeParts, grades, items, departments, totals, nonTeaching, staff, recommendation, issues };
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
    stats = hoursStatsCached();
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

// 교과별 교사 수 추천(시수 균형, '교사 수 추천' 팝업): 추천만 보이고, '추천 적용'을 눌러야 교사 수가 바뀐다.
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
  return `<section class="hours-recommend">
    <p class="hours-staff-line"><b>${escapeHtml(headline)}</b></p>
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
    ${!rows && Object.keys(settings.teacherLocks || {}).length ? `<p class="hours-settings-row"><span class="hours-summary-label">고정한 교과</span>
      ${Object.keys(settings.teacherLocks).map((id) => `<label class="hours-zero-toggle"><input type="checkbox" checked data-hours-lock="${escapeHtml(id)}" data-focus-key="lock-${escapeHtml(id)}"> ${escapeHtml(hoursDepartmentName(id))}</label>`).join("")}
      <span class="hours-note">추천을 계산하지 못할 때도 여기서 고정을 풀 수 있습니다.</span></p>` : ""}
  </section>`;
}

// 같은 자료면 계산을 다시 하지 않는다: 화면 그리기와 상단 안내(hoursStatsReadiness)가 한 번의 변경에 같은 결과를 쓴다.
// 열쇠는 그 해 시수 설정 전체와 학교명이고, 다른 단계 자료(편제표·결과·확정)가 바뀌는 것은 다음 작업 차례에서 버려서 막는다.
var hoursStatsMemo = null;
function hoursStatsCached(year = hoursTargetYear()) {
  let key = "";
  try { key = `${year}|${JSON.stringify(state.hoursStats?.[year] ?? null)}|${$("#schoolName")?.value ?? ""}`; } catch { key = ""; }
  if (key && hoursStatsMemo?.key === key) return hoursStatsMemo.stats;
  const stats = computeHoursStats(year);
  let after = key;
  try { after = `${year}|${JSON.stringify(state.hoursStats?.[year] ?? null)}|${$("#schoolName")?.value ?? ""}`; } catch { after = ""; }
  hoursStatsMemo = after ? { key: after, stats } : null;
  setTimeout(() => { if (hoursStatsMemo?.stats === stats) hoursStatsMemo = null; }, 0);
  return stats;
}

// 5단계 시수 통계 그리기의 입구(하나). 화면 내용은 renderHoursStatsView가 그린다(화면을 다시 쓰더라도 이 입구는 그대로 둘 것).
// 값을 바꿔 다시 그려도 창·표(data-hours-scroll) 안 스크롤, 열린 팝업(설정·교사 수 추천·확인 항목)의 스크롤과
// 입력 포커스·커서를 그대로 둔다(view-keep.js preserveViewDuring — 공통 도우미 하나로 보존).
// 5단계가 숨겨져 있으면 renderHoursStatsView가 계산·그리기를 하지 않고, 단계를 열 때(renderWorkflowLayout) 그린다.
function renderHoursStats() {
  if (typeof preserveViewDuring === "function") {
    return preserveViewDuring(["#workflowStep7Panel", "#hoursSettingsBody", "#hoursRecommendBody", "#hoursIssuesBody"], renderHoursStatsView);
  }
  return renderHoursStatsView();
}

function renderHoursStatsView() {
  const content = document.getElementById("hoursStatsContent");
  if (!content) return;
  const panel = document.getElementById("workflowStep7Panel");
  if (panel?.classList?.contains("hidden")) return;
  const year = hoursTargetYear();
  document.getElementById("hoursTargetYear").textContent = year ? `${year}학년도` : "";
  syncNextYearClassInputs();
  const download = document.getElementById("downloadHoursStats");
  let stats;
  try {
    stats = hoursStatsCached(year);
  } catch (error) {
    content.innerHTML = `<p class="storage-warning">${escapeHtml(error.message)}</p>`;
    download.disabled = true;
    return;
  }
  download.disabled = !stats.items.length;
  ensureHoursFormStyles();
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
      ${(() => {
        // 지금 반 수와 내년 학급 수가 다를 수 있다(예: 현 1학년 10반 → 내년 2학년 11학급). 계산은 위에 넣은 내년 학급 수로 한다.
        const roster = hoursRosterClasses(info);
        if (!roster) return "";
        const differs = info.classes > 0 && info.classes !== roster;
        return `<p class="hours-roster-classes${differs ? " is-diff" : ""}">현 ${Number(info.grade) - 1}학년 명단 ${roster}반${differs ? ` → 내년 ${info.grade}학년 ${info.classes}학급으로 계산` : ""}</p>`;
      })()}
      <p class="hours-plan-file">${info.cohortYear}학년도 입학생 편제표 · ${info.hasLayout ? escapeHtml(info.fileName || "불러옴") : `<button class="button button-quiet" type="button" data-hours-cohort="${info.cohortYear}">미업로드 · 1단계에서 업로드</button>`}</p>
      ${sourceSelect}
    </article>`;
  }).join("");
  const model = hoursFormModel(stats, { schoolName: $("#schoolName")?.value || "" });
  const recommendation = stats.recommendation;
  const recommendLabel = recommendation.ok
    ? `교사 수 추천${recommendation.changed ? ` · 바뀌는 교과 ${recommendation.changed}개` : " · 지금과 같음"}`
    : "교사 수 추천";
  const allocateTools = stats.departments.filter((department) => department.common && department.items.length).map((department) =>
    `<button class="button button-quiet" type="button" data-hours-auto-allocate="${department.group}" title="세부 교과 교사 수를 기준으로 공통 과목을 반 단위로 나눠 세부 교과 1인당 시수가 비슷해지게 배분 칸(오른쪽 파란 칸)을 채웁니다.">${department.group} 공통 시수 자동 배분</button>`).join("");
  const tools = `<p class="hours-summary-line hours-table-tools">
    <button class="button" type="button" data-open-dialog="hoursRecommendDialog" aria-haspopup="dialog">${escapeHtml(recommendLabel)}</button>
    ${allocateTools}
    ${hoursPlainObject(settings.undo) ? `<button class="button button-quiet" type="button" data-hours-action="undo">되돌리기 (${escapeHtml(settings.undo.label)})</button>` : ""}
    <label class="hours-zero-toggle"><input type="checkbox" data-hours-show-zero="1" data-focus-key="show-zero"${settings.showZeroClasses ? " checked" : ""}> 개설반 0 과목도 보기</label>
    <span class="hours-note">흰 칸(개설반·교사수·전년도 평균·배분·창체 학점·메모)은 표에서 바로 고칩니다. <span class="hours-legend-red">빨간 개설반</span>은 신청 결과, 흐린 칸은 직접 입력입니다.</span>
  </p>`;
  const departmentOptions = (selected) => HOURS_DEPARTMENTS.map((department) =>
    `<option value="${department.id}"${department.id === selected ? " selected" : ""}>${escapeHtml(hoursDepartmentName(department.id))}</option>`).join("") +
    `<optgroup label="비교과 교사 (교과 평균에서 뺌)">${HOURS_NON_TEACHING.map((role) => {
      const value = HOURS_NON_TEACHING_PREFIX + role.id;
      return `<option value="${value}"${value === selected ? " selected" : ""}>${escapeHtml(hoursDepartmentName(value))}</option>`;
    }).join("")}</optgroup>`;
  // 과목별 상세는 펼쳤을 때만 그린다(과목마다 담당 교과 선택 상자가 있어 무겁다).
  const detailOpen = content.querySelector('details[data-hours-details="detail"]')?.open ?? stats.items.some((item) => item.department === "기타");
  const detailRows = !detailOpen ? "" : stats.items.slice().sort((a, b) => a.grade.localeCompare(b.grade) || a.semester.localeCompare(b.semester) ||
    hoursDepartmentOrder(a.department) - hoursDepartmentOrder(b.department) ||
    a.subject.localeCompare(b.subject, "ko")).map((item) => `<tr class="${item.classes === 0 ? "is-zero" : ""}${item.manual ? " is-manual" : ""}">
      <td>${item.grade}</td><td>${item.cohortYear}</td><td>${item.currentGrade ? `현 ${item.currentGrade}` : "신입"}</td><td>${item.semester}</td><th scope="row" class="closure-subject">${escapeHtml(item.subject)}</th>
      <td>${item.kind}</td>
      <td><select data-hours-department="${escapeHtml(normalizeResultCourseName(item.subject))}" data-default-department="${item.defaultDepartment}" data-focus-key="dept-${escapeHtml(item.key)}" aria-label="${escapeHtml(item.subject)} 담당 교과">${departmentOptions(item.department)}</select></td>
      <td>${hoursFormat(item.credit)}</td>
      <td>${item.enrollment ?? ""}</td>
      <td><input class="hours-small-input" data-hours-item-classes="${escapeHtml(item.key)}" data-hours-auto="${item.autoClasses}" data-focus-key="detail-item-${escapeHtml(item.key)}" type="number" min="0" max="99" step="1" value="${item.manual ? item.classes : ""}" placeholder="${item.autoClasses}" aria-label="${escapeHtml(item.subject)} 개설반"></td>
      <td>${item.hours}</td>
      <td>${escapeHtml(item.sourceRound)}</td>
      <td class="closure-subject hours-note">${escapeHtml(item.basis)}</td>
    </tr>`).join("");
  const detail = `<details class="hours-detail" data-hours-details="detail"${detailOpen ? " open" : ""}>
    <summary>과목별 상세 (${stats.items.length}개 항목) · 담당 교과(비교과 교사 포함)와 개설반 근거</summary>
    <p class="note">개설반 칸을 비워 두면 자동 값(흐린 숫자)을 씁니다. 담당 교과를 바꾸면 같은 이름의 과목 전체에 적용됩니다.</p>
    ${detailOpen ? "" : '<p class="note">펼치면 표를 그립니다.</p>'}
    <div class="aggregate-sheet-wrap${detailOpen ? "" : " hidden"}" data-hours-scroll="detail"><table class="closure-table hours-detail-table"><thead><tr><th scope="col">내년도<br>학년</th><th scope="col">입학<br>연도</th><th scope="col">신청<br>학년</th><th scope="col">학기</th><th scope="col">과목</th><th scope="col">구분</th><th scope="col">담당 교과</th><th scope="col">학점</th><th scope="col">신청</th><th scope="col">개설반</th><th scope="col">시수</th><th scope="col">근거 차수</th><th scope="col">근거</th></tr></thead>
    <tbody>${detailRows}</tbody></table></div>
  </details>`;
  // 설정 입력·교사 수 추천·확인 항목 전체는 팝업에 두고, 화면에는 한 줄 요약과 원래 양식 표를 둔다.
  const settingsBody = document.getElementById("hoursSettingsBody");
  if (settingsBody) {
    settingsBody.innerHTML = `<div class="hours-grade-cards">${gradeCards}</div>
    <p class="note">창체 시수(학급당 학기 자율·진로)는 시수표 맨 아래 창체 행의 학점 칸에서 고칩니다. 교과별 교사 수·전년도 평균·공통 과목 배분도 시수표 칸에서 바로 입력합니다(소수 0.5도 됨). 진로 교과(진로와 직업)는 합계와 평균에서 뺍니다.</p>
    ${hoursStaffSettings(stats)}
    ${hoursPreviousTeachersSettings(stats)}`;
  }
  const recommendBody = document.getElementById("hoursRecommendBody");
  if (recommendBody) recommendBody.innerHTML = hoursRecommendationSection(stats);
  const issuesBody = document.getElementById("hoursIssuesBody");
  if (issuesBody) issuesBody.innerHTML = hoursIssueList(stats.issues);
  const opened = new Map([...content.querySelectorAll("details[data-hours-details]")].map((element) => [element.dataset.hoursDetails, element.open]));
  content.innerHTML = `${hoursSettingsSummary(stats)}
    ${hoursIssueSummary(stats.issues)}
    ${tools}
    <div class="aggregate-sheet-wrap hours-form-wrap" data-hours-scroll="form">${hoursFormHtml(model)}</div>
    ${detail}`;
  for (const element of content.querySelectorAll("details[data-hours-details]")) {
    if (opened.has(element.dataset.hoursDetails)) element.open = opened.get(element.dataset.hoursDetails);
  }
  // 고정 머리글 둘째 줄(세부과목·학점…)은 첫째 줄 높이만큼 내려 붙인다.
  const form = content.querySelector(".hours-form");
  const headTop = form?.rows?.[2]?.offsetHeight;
  if (headTop) for (const cell of form.rows[3].cells) cell.style.top = `${headTop}px`;
}

// 전년도 교과별 교사 수: 메모 '○○학년도 ⇒ …과 n명 증/감'을 자동으로 쓰는 데만 쓴다. '전년도 설정 불러오기'가 채운다.
function hoursPreviousTeachersSettings(stats) {
  const rows = stats.departments.filter((department) => department.id !== "기타" && (department.items.length || department.teachers > 0 || department.previousTeachers !== null))
    .map((department) => {
      const delta = department.previousTeachers === null ? null : Math.round(((department.teachers || 0) - department.previousTeachers) * 100) / 100;
      return `<tr><th scope="row" class="closure-subject">${escapeHtml(hoursDepartmentName(department.id))}</th>
        <td><input class="hours-small-input" data-hours-previous-teachers="${department.id}" data-focus-key="previous-teachers-${department.id}" type="number" min="0" max="200" step="0.5" value="${department.previousTeachers ?? ""}" aria-label="${escapeHtml(hoursDepartmentName(department.id))} 전년도 교사 수"></td>
        <td>${department.teachers ?? "-"}</td>
        <td class="${delta > 0 ? "hours-up" : delta < 0 ? "hours-down" : ""}">${delta ? `${delta > 0 ? "+" : ""}${hoursFormat(delta, 1)}` : ""}</td></tr>`;
    }).join("");
  const memo = hoursFormMemo(stats);
  return `<section class="hours-staff-settings" aria-labelledby="hoursPreviousTeachersTitle">
    <h4 id="hoursPreviousTeachersTitle">전년도(${Number(stats.year) - 1}학년도) 교과별 교사 수</h4>
    <p class="note">시수표 아래 메모의 '◈ ${stats.year}학년도 ⇒ …과 n명 증/감' 줄을 자동으로 씁니다. 메모는 시수표에서 직접 고칠 수 있습니다.</p>
    <p class="hours-staff-line">${escapeHtml(memo.changeLine || "전년도 교사 수가 없어 증감 줄을 비워 둡니다.")}</p>
    ${rows ? `<div class="aggregate-sheet-wrap"><table class="closure-table hours-staff-table">
      <thead><tr><th scope="col">교과</th><th scope="col">전년도 교사 수</th><th scope="col">올해 교사 수</th><th scope="col">증감</th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : ""}
  </section>`;
}

function scheduleHoursRerender() {
  if (hoursRenderTimer !== null) clearTimeout(hoursRenderTimer);
  hoursRenderTimer = setTimeout(() => {
    hoursRenderTimer = null;
    // 스크롤·포커스 보존은 renderHoursStats(preserveViewDuring)가 한다.
    renderHoursStats();
    renderWorkspaceContext();
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
  else if (target.dataset.hoursCreativePart) {
    // 창체 행 학점 칸: 처음 고치면 지금 값(예전 '창체 시수' 포함)을 자율·진로로 옮겨 적고 고친 칸만 바꾼다.
    if (!Object.keys(settings.creative).length) Object.assign(settings.creative, hoursCreativeParts(settings));
    set(settings.creative, target.dataset.hoursCreativePart, hoursNumber(target.value, { max: 10 }) ?? 0);
    settings.creativeHours = HOURS_CREATIVE_PARTS.reduce((sum, part) => sum + (Number(settings.creative[part]) || 0), 0);
  } else if (target.dataset.hoursShowZero) set(settings, "showZeroClasses", target.checked ? true : null);
  else if (target.dataset.hoursStaffMemo) {
    // 자동 문구와 같으면 저장하지 않아 교사 수가 바뀔 때 자동 문구가 따라 바뀌게 한다.
    const value = String(target.value ?? "").replace(/\r\n/g, "\n");
    set(settings, "staffMemo", value.trim() === String(target.dataset.hoursAutoMemo ?? "").trim() ? null : value);
  } else if (target.dataset.hoursPreviousTeachers) set(settings.previousTeachers, target.dataset.hoursPreviousTeachers, hoursNumber(target.value, { max: 200 }));
  else if (target.dataset.hoursAllocationNote) {
    const [department, semester] = target.dataset.hoursAllocationNote.split("|");
    settings.allocationNotes[department] ||= {};
    const note = String(target.value ?? "").trim();
    set(settings.allocationNotes[department], semester, note || null);
  } else if (target.dataset.hoursTotalTeachers) set(settings, "totalTeachers", hoursNumber(target.value, { max: 500 }));
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
  else if (target.dataset.hoursItemClasses) {
    // 자동 값과 같게 적거나 비우면 직접 입력을 지운다(시수표 칸은 자동 값을 미리 채워 보인다).
    const value = hoursNumber(target.value, { integer: true, max: 99 });
    const auto = hoursNumber(target.dataset.hoursAuto, { integer: true, max: 99 });
    set(settings.classOverrides, target.dataset.hoursItemClasses, value !== null && value === auto ? null : value);
  }
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
  // 메모 '○○학년도 ⇒ … 증/감': 올해 줄은 전년도 교사 수와 비교해 자동으로 쓰고, 전년도 메모의 증감 줄은 앞줄로 이어 둔다.
  settings.previousTeachers = { ...source.teachers };
  if (Object.keys(source.creative || {}).length) settings.creative = { ...source.creative };
  const sourceLine = hoursTeacherChangeLine(previousYear, HOURS_DEPARTMENTS.map((department) => ({
    name: department.staff,
    previous: hoursNumber(source.previousTeachers?.[department.id], { max: 200 }) ?? NaN,
    current: hoursNumber(source.teachers?.[department.id], { max: 200 }) ?? NaN
  })));
  settings.memoHistory = typeof source.staffMemo === "string"
    ? source.staffMemo.split("\n").filter((line) => line.trim())
    : [...(Array.isArray(source.memoHistory) ? source.memoHistory : []), sourceLine].filter(Boolean);
  delete settings.staffMemo;
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

// ---- 원래 양식(학교 교과별 시수표) ----
// 화면 표와 엑셀 첫 시트가 같은 모델(hoursFormModel)에서 나온다. 행·열·병합·색·수식이 학교 교과별 시수표와 같다:
// A 교과군 · B 세부 · C 학기 · D~G/H~K/L~O 학년별(세부과목·학점·개설반·시수) · P~R 총시수(1학기·2학기·합계) · S 교사수 ·
// T 학기별 · U 1년 · V 비고 · W 전년도 평균 · X~AA 공통 과목 배분 메모 · AB 배분 합계, 맨 아래 창체 행과 요약 상자(교과·전체 평균·창체 포함 평균).
var HOURS_FORM_GROUPS = [
  { label: "국어", ids: ["국어"] },
  { label: "수학", ids: ["수학"] },
  { label: "영어", ids: ["영어"] },
  { label: "과학", ids: ["과학-공통", "과학-물리", "과학-화학", "과학-생명", "과학-지구"], pooled: true },
  { label: "사회", ids: ["사회-공통", "사회-한국사", "사회-지리", "사회-일사", "사회-윤리"], pooled: true },
  { label: "체육\n예술", ids: ["체육", "음악", "미술"] },
  { label: "생활\n교양", ids: ["정보", "기술가정", "제2외국어", "진로", "교양"] },
  { label: "기타", ids: ["기타"] }
];
var HOURS_FORM_COLUMNS = 28;
// 엑셀 열 너비(원래 양식 A~AB)와 화면 열 너비(px).
var HOURS_FORM_WIDTHS = [5.5, 7.5, 4.75, 14.75, 6.63, 4.88, 6.5, 15.63, 6.63, 4.88, 6.5, 15.38, 6.63, 4.88, 6.5, 7.63, 7.63, 7.63, 6.13, 9, 8.5, 6.5, 8.38, 8.5, 8.5, 8.5, 8.5, 7.5];
var HOURS_FORM_PIXELS = [38, 46, 30, 124, 32, 42, 36, 124, 32, 42, 36, 124, 32, 42, 36, 44, 44, 46, 50, 52, 52, 54, 56, 40, 40, 40, 40, 50];
// 칸 종류별 글꼴·채움(원래 양식의 색: 머리 연노랑, 학년 칸 연파랑, 1학기 연분홍, 2학기 분홍, 합계 노랑+빨간 글자, 창체 연초록, 요약 상자).
var HOURS_FORM_KINDS = {
  title: { sz: 20, b: true }, school: { sz: 11, b: true, h: "right" },
  head: { sz: 12, b: true, fill: "FFF2CC", wrap: true }, headSmall: { sz: 10, b: true, fill: "FFF2CC", wrap: true }, headClass: { sz: 9, b: true, fill: "FFF2CC" },
  headTiny: { sz: 9, b: true, fill: "FFF2CC", wrap: true }, headMemo: { sz: 10, b: true, fill: "DAE3F3", wrap: true },
  group: { sz: 11, b: true, wrap: true }, sub: { sz: 10, b: true, wrap: true },
  sem: { sz: 12, b: true, fill: "DEEBF7" },
  subject: { sz: 11, b: true, fill: "DEEBF7", wrap: true }, subjectSmall: { sz: 9, b: true, fill: "DEEBF7", wrap: true },
  cell: { sz: 12, b: true, fill: "DEEBF7" }, cellRed: { sz: 12, b: true, fill: "DEEBF7", red: true },
  p: { sz: 12, b: true, fill: "FBE5D6" }, q: { sz: 12, b: true, fill: "F8CBAD" }, r: { sz: 12, b: true, fill: "FFFF00", red: true },
  s: { sz: 14, b: true }, t: { sz: 12, b: true, fill: "FBE5D6", fmt: "0.00" }, u: { sz: 12, b: true, fmt: "0.00" },
  v: { sz: 10, wrap: true }, vLabel: { sz: 11 }, vNum: { sz: 12, b: true, fmt: "0.00" }, w: { sz: 11, b: true },
  memo: { sz: 10, fill: "DAE3F3" }, ab: { sz: 11, b: true, fill: "DAE3F3" },
  cGroup: { sz: 11, b: true, fill: "E2EFDA", wrap: true }, cCell: { sz: 12, b: true, fill: "E2EFDA" },
  cR: { sz: 12, b: true, fill: "E2EFDA", red: true }, cS: { sz: 14, fill: "E2EFDA" }, cT: { sz: 12, b: true, fill: "E2EFDA", fmt: "0.00" },
  box: { sz: 10, b: true, h: "left", wrap: true },
  sum1: { sz: 14, b: true, fill: "F1FD7B", wrap: true }, sum1Red: { sz: 14, b: true, fill: "F1FD7B", red: true }, sum1Teacher: { sz: 16, b: true, fill: "F1FD7B" },
  sum2: { sz: 12, b: true, fill: "FFFF00", wrap: true }, sum2Num: { sz: 14, b: true, fill: "FFFF00", fmt: "0.0" }, sum2Red: { sz: 14, b: true, fill: "FFFF00", red: true, fmt: "0.0" },
  sum3: { sz: 11, b: true, fill: "99FF33", wrap: true }, sum3Num: { sz: 14, b: true, fill: "99FF33", fmt: "0.0" }, sum3Red: { sz: 14, b: true, fill: "99FF33", red: true, fmt: "0.0" },
  noteRed: { sz: 10, b: true, red: true, h: "left", wrap: true }, note: { sz: 10, h: "left", wrap: true }, blank: { sz: 11 }
};
// 세로선 굵기(열 왼쪽): 학년 묶음·총시수·교사수·평균·전년도 칸 경계는 굵게, 학년 안쪽은 가는 점선.
var HOURS_FORM_COL_EDGES = (() => {
  const edges = Array(HOURS_FORM_COLUMNS + 1).fill("hair");
  for (const column of [0, 3, 7, 11, 15, 17, 18, 19, 20, 21, 22, 23]) edges[column] = "medium";
  for (const column of [1, 2, 16, 28]) edges[column] = "thin";
  for (const column of [24, 25, 26]) edges[column] = null;
  return edges;
})();

function hoursColumnLetter(index) {
  let name = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + ((value - 1) % 26)) + name;
  return name;
}

// 학년 머리글: 원래 양식의 'N학년'에 입학연도와 선택과목 근거(현 N−1학년 결과)를 덧붙인다(현 N학년 → N+1학년 과목).
function hoursFormGradeHead(info) {
  if (info.grade === "1") return `1학년 (${info.cohortYear} 입학 · 신입생)`;
  const current = `현 ${Number(info.grade) - 1}학년`;
  return `${info.grade}학년 (${info.cohortYear} 입학 · ${current}${info.source ? ` ${info.source.round}차 ${info.source.confirmed ? "확정" : "미확정"}` : " 결과 없음"})`;
}

function hoursStaffName(department) {
  if (department.id === "제2외국어" && department.formLabel && department.formLabel !== "제2외국어") return `${department.formLabel}과`;
  return department.staff || hoursDepartmentName(department.id);
}

// 요약 상자 왼쪽 메모: 비교과 교사·창체 포함 평균 계산법(자동)과 교사 증감(자동 문구, 교사가 고쳐 쓸 수 있음).
function hoursFormMemo(stats) {
  const settings = stats.settings || {};
  const count = (value) => hoursFormat(value || 0, 1);
  const roles = stats.nonTeaching.filter((row) => row.teachers > 0).map((row) => `${row.id}${count(row.teachers)}`);
  const fixed = [
    `◈ ${stats.year}학년도 비교과 교사 : ${roles.join(", ") || "없음"}`,
    "",
    "◈ 창체포함평균값",
    `   ⇒ (교과시간총합 + 창체${count(stats.totals.creative)}시간) / ${count(stats.totals.teachers)}명`
  ].join("\n");
  const changeRows = stats.departments.filter((department) => department.id !== "기타")
    .map((department) => ({ name: hoursStaffName(department), previous: department.previousTeachers ?? NaN, current: department.teachers ?? NaN }));
  const changeLine = hoursTeacherChangeLine(stats.year, changeRows);
  const history = Array.isArray(settings.memoHistory) ? settings.memoHistory.filter((line) => typeof line === "string" && line.trim()) : [];
  const auto = [...history, changeLine].filter(Boolean).join("\n");
  const edited = typeof settings.staffMemo === "string";
  const changes = edited ? settings.staffMemo : auto;
  return { fixed, changeLine, auto, changes, edited, text: [fixed, changes].filter(Boolean).join("\n\n") };
}

// 진로와 직업 시수 안내(요약 상자 오른쪽 빨간 글씨).
function hoursCareerNote(stats) {
  const hours = stats.staff.careerHours;
  if (!(hours["1"] || hours["2"] || stats.staff.career)) return " * 창체제외한 교과시수";
  const text = hours["1"] === hours["2"] ? String(hours["1"]) : `1학기 ${hours["1"]}·2학기 ${hours["2"]}`;
  return ` * 창체제외한 교과시수\n(진로와 직업 시수 ${text}, 진로교사 제외)`;
}

function hoursFormModel(stats, { schoolName = "", date = new Date() } = {}) {
  const L = hoursColumnLetter;
  const settings = stats.settings || {};
  const showZero = Boolean(settings.showZeroClasses);
  const cells = new Map();
  const merges = [];
  const rowEdges = new Map();
  const heights = { 1: 31.5, 2: 17.25, 3: 30, 4: 18 };
  const put = (row, column, cell) => { cells.set(`${row}:${column}`, cell); return cell; };
  const merge = (r1, c1, r2, c2) => { if (r2 > r1 || c2 > c1) merges.push([r1, c1, r2, c2]); };
  const weight = { hair: 1, thin: 2, medium: 3 };
  const edge = (row, value) => { if (!rowEdges.has(row) || weight[value] > weight[rowEdges.get(row)]) rowEdges.set(row, value); };
  const number = (value) => Number.isFinite(value) ? value : "";
  const year = stats.year;
  put(1, 0, { v: `${year}학년도 교과별 시수 통계 (총${stats.totalClasses}학급)`, k: "title" }); merge(1, 0, 1, 22);
  const stamp = `${String(date.getFullYear()).slice(2)}.${String(date.getMonth() + 1).padStart(2, "0")}.`;
  put(2, 0, { v: `${schoolName ? `${schoolName} ` : ""}(${stamp})`, k: "school" }); merge(2, 0, 2, 22);
  put(3, 0, { v: "교과군", k: "head" }); merge(3, 0, 4, 1);
  put(3, 2, { v: "학기", k: "head" }); merge(3, 2, 4, 2);
  stats.grades.forEach((info, index) => {
    const column = 3 + index * 4;
    put(3, column, { v: hoursFormGradeHead(info), k: "headSmall" }); merge(3, column, 3, column + 3);
    ["세부과목", "학점", "개설반", "시수"].forEach((label, offset) => put(4, column + offset, { v: label, k: offset === 2 ? "headClass" : "head" }));
  });
  put(3, 15, { v: "총시수", k: "head" }); merge(3, 15, 3, 17);
  ["1학기", "2학기", "합계"].forEach((label, offset) => put(4, 15 + offset, { v: label, k: "head" }));
  put(3, 18, { v: "교사수", k: "head" }); merge(3, 18, 4, 18);
  put(3, 19, { v: `평균시수(${year})`, k: "head" }); merge(3, 19, 3, 21);
  put(4, 19, { v: "학기별", k: "head" }); put(4, 20, { v: "1년", k: "head" }); put(4, 21, { v: "비고", k: "head" });
  put(3, 22, { v: `${Number(year) - 1}\n평균시수\n(1년)`, k: "headTiny" }); merge(3, 22, 4, 22);
  put(3, 23, { v: "공통 과목 배분", k: "headMemo" }); merge(3, 23, 3, 27);
  put(4, 23, { v: "메모", k: "headMemo" }); merge(4, 23, 4, 26); put(4, 27, { v: "합계", k: "headMemo" });
  edge(3, "medium"); edge(4, "thin"); edge(5, "medium");

  const shown = (item) => item.classes > 0 || item.manual || showZero;
  const byId = new Map(stats.departments.map((department) => [department.id, department]));
  const refs = { bodyStart: 5, bodyEnd: 4, career: null, creative: { "1": [], "2": [] }, departments: {}, groups: {} };
  let row = 5;
  for (const group of HOURS_FORM_GROUPS) {
    const departments = group.ids.map((id) => byId.get(id)).filter(Boolean)
      .filter((department) => department.items.some(shown) || department.teachers > 0 || (department.common && department.items.length));
    if (!departments.length) continue;
    const groupStart = row;
    edge(groupStart, "medium");
    const placed = [];
    for (const department of departments) {
      const start = row;
      edge(start, "thin");
      const blocks = {};
      for (const semester of ["1", "2"]) {
        const lists = ["1", "2", "3"].map((grade) => department.items.filter((item) => item.grade === grade && item.semester === semester && shown(item)));
        const height = Math.max(1, ...lists.map((list) => list.length));
        const blockStart = row;
        if (semester === "2") edge(blockStart, "thin");
        put(blockStart, 2, { v: Number(semester), k: "sem" }); merge(blockStart, 2, blockStart + height - 1, 2);
        for (let offset = 0; offset < height; offset++, row++) {
          let rowHours = 0;
          lists.forEach((list, gradeIndex) => {
            const item = list[offset];
            if (!item) return;
            const column = 3 + gradeIndex * 4;
            const credit = `${L(column + 1)}${row}`, classes = `${L(column + 2)}${row}`;
            put(row, column, { v: item.subject, k: String(item.subject).length > 9 ? "subjectSmall" : "subject" });
            put(row, column + 1, { v: item.credit, k: "cell" });
            put(row, column + 2, {
              v: item.classes, k: item.kind !== "지정" && item.grade !== "1" ? "cellRed" : "cell", item,
              input: { type: "number", value: item.classes, cls: `${item.manual ? " is-manual" : ""}${item.classes === 0 ? " is-zero" : ""}`, title: item.basis,
                attrs: { "data-hours-item-classes": item.key, "data-hours-auto": item.autoClasses, "data-focus-key": `item-${item.key}`, min: 0, max: 99, step: 1,
                  "aria-label": `${item.grade}학년 ${item.semester}학기 ${item.subject} 개설반` } }
            });
            put(row, column + 3, { v: item.hours || "", f: `IF(PRODUCT(${credit},${classes})=0,"",PRODUCT(${credit},${classes}))`, k: "cell" });
            rowHours += item.hours;
          });
          put(row, semester === "1" ? 15 : 16, { v: rowHours || "", f: `IF(SUM(G${row},K${row},O${row})=0,"",SUM(G${row},K${row},O${row}))`, k: semester === "1" ? "p" : "q" });
        }
        blocks[semester] = { start: blockStart, end: row - 1 };
      }
      placed.push({ department, start, end: row - 1, blocks });
      refs.departments[department.id] = { start, end: row - 1, blocks };
      if (department.excluded) refs.career = { start, end: row - 1 };
    }
    const groupEnd = row - 1;
    refs.groups[group.label] = { start: groupStart, end: groupEnd };
    // 교과군·세부 칸: 세부 이름이 없는 교과(국어·수학·영어)는 A:B를 합친다. 같은 세부 이름(교양: 진로와 직업 + 교양)은 하나로 합친다.
    const labeled = placed.some(({ department }) => department.formLabel);
    put(groupStart, 0, { v: group.label, k: "group" });
    merge(groupStart, 0, groupEnd, labeled ? 0 : 1);
    if (labeled) {
      for (let index = 0; index < placed.length;) {
        let last = index;
        while (last + 1 < placed.length && placed[last + 1].department.formLabel === placed[index].department.formLabel) last++;
        put(placed[index].start, 1, { v: placed[index].department.formLabel, k: "sub" });
        merge(placed[index].start, 1, placed[last].end, 1);
        index = last + 1;
      }
    }
    const memberAllocations = (semester) => placed.filter(({ department }) => group.pooled && !department.common)
      .map(({ blocks }) => `N(AB${blocks[semester].start})`);
    for (const { department, start, end, blocks } of placed) {
      for (const semester of ["1", "2"]) {
        const { start: blockStart, end: blockEnd } = blocks[semester];
        const sum = `SUM(P${blockStart}:Q${blockEnd})`;
        let formula = sum;
        if (group.pooled && department.common) {
          const others = memberAllocations(semester);
          const expression = others.length ? `${sum}-${others.join("-")}` : sum;
          formula = `IF(${expression}=0,"",${expression})`;
        } else if (group.pooled) formula = `${sum}+N(AB${blockStart})`;
        const total = department.totals[semester];
        put(blockStart, 17, { v: department.common && !total ? "" : total, f: formula, k: "r" }); merge(blockStart, 17, blockEnd, 17);
        put(blockStart, 19, { v: number(department.averages?.[semester]), f: `IF(N(S${start})>0,R${blockStart}/S${start},"")`, k: "t" });
        merge(blockStart, 19, blockEnd, 19);
        if (group.pooled && !department.common) {
          const note = settings.allocationNotes?.[department.id]?.[semester] ?? "";
          const allocation = settings.allocations?.[department.id]?.[semester];
          const firstMember = placed.find((item) => !item.department.common)?.department === department && semester === "1";
          put(blockStart, 23, { v: note, k: "memo", split: true, input: { type: "text", value: note,
            attrs: { "data-hours-allocation-note": `${department.id}|${semester}`, "data-focus-key": `alloc-note-${department.id}-${semester}`,
              "aria-label": `${hoursDepartmentName(department.id)} ${semester}학기 공통 과목 배분 메모`, placeholder: "통과10 · 과탐실3" } } });
          merge(blockStart, 23, blockEnd, 26);
          put(blockStart, 27, { v: number(hoursNumber(allocation)), k: "ab", input: { type: "number", value: allocation ?? "",
            attrs: { ...(firstMember ? { id: `hoursAllocation-${department.group}` } : {}), "data-hours-allocation": `${department.id}|${semester}`,
              "data-focus-key": `alloc-${department.id}-${semester}`, min: 0, max: 999, step: 1, placeholder: "0",
              "aria-label": `${hoursDepartmentName(department.id)} ${semester}학기 공통 과목 배분 시수` } } });
          merge(blockStart, 27, blockEnd, 27);
        }
      }
      put(start, 18, { v: number(department.teachers), k: "s", input: { type: "number", value: department.teachers ?? "",
        attrs: { id: `hoursTeachers-${department.id}`, "data-hours-teachers": department.id, "data-focus-key": `teachers-${department.id}`, min: 0, max: 200, step: 0.5,
          "aria-label": `${hoursDepartmentName(department.id)} 교사 수` } } });
      merge(start, 18, end, 18);
      if (!group.pooled) {
        put(start, 20, { v: number(department.yearAverage), f: `IF(N(S${start})>0,AVERAGE(T${blocks["1"].start},T${blocks["2"].start}),"")`, k: "u" });
        merge(start, 20, end, 20);
        put(start, 21, { v: department.excluded ? "합계·평균\n제외" : department.id === "기타" ? "담당 교과\n미정" : "", k: "v" });
        merge(start, 21, end, 21);
        put(start, 22, { v: number(department.previous), k: "w", input: previousInput(department.id, hoursDepartmentName(department.id), department.previous) });
        merge(start, 22, end, 22);
      }
    }
    if (group.pooled) {
      const common = placed.find(({ department }) => department.common)?.department || byId.get(group.ids[0]);
      const S = `SUM(S${groupStart}:S${groupEnd})`;
      put(groupStart, 20, { v: number(common.groupAverage), f: `IF(${S}>0,SUM(R${groupStart}:R${groupEnd})/${S}/2,"")`, k: "u" });
      merge(groupStart, 20, groupEnd, 20);
      const semesterValue = (semester, column) => ({ v: number(common.groupSemester?.[semester]), f: `IF(${S}>0,SUM(${column}${groupStart}:${column}${groupEnd})/${S},"")`, k: "vNum" });
      const size = groupEnd - groupStart + 1;
      if (size >= 4) {
        const half = Math.floor(size / 2);
        put(groupStart, 21, { v: "1학기", k: "vLabel" });
        put(groupStart + 1, 21, semesterValue("1", "P")); merge(groupStart + 1, 21, groupStart + half - 1, 21);
        put(groupStart + half, 21, { v: "2학기", k: "vLabel" });
        put(groupStart + half + 1, 21, semesterValue("2", "Q")); merge(groupStart + half + 1, 21, groupEnd, 21);
      } else {
        const pair = (semester) => common.groupSemester ? hoursFormat(common.groupSemester[semester]) : "-";
        put(groupStart, 21, { v: `1학기 ${pair("1")}\n2학기 ${pair("2")}`, k: "v" }); merge(groupStart, 21, groupEnd, 21);
      }
      put(groupStart, 22, { v: number(common.groupPrevious), k: "w", input: previousInput(group.label, `${group.label} 교과군`, common.groupPrevious) });
      merge(groupStart, 22, groupEnd, 22);
    }
  }
  refs.bodyEnd = row - 1;
  // 창체: 학기마다 자율·진로 한 줄씩, 개설반은 학년별 학급 수. 교과 합계·평균에는 넣지 않고 '창체 포함 평균'에만 더한다.
  const creativeStart = row;
  edge(creativeStart, "medium");
  put(creativeStart, 0, { v: "창체", k: "cGroup" });
  for (const semester of ["1", "2"]) {
    const blockStart = row;
    if (semester === "2") edge(blockStart, "thin");
    put(blockStart, 2, { v: Number(semester), k: "cCell" }); merge(blockStart, 2, blockStart + HOURS_CREATIVE_PARTS.length - 1, 2);
    for (const part of HOURS_CREATIVE_PARTS) {
      const credit = stats.creativeParts?.[part] ?? 0;
      let total = 0;
      ["1", "2", "3"].forEach((grade, index) => {
        const column = 3 + index * 4;
        const classes = stats.classCounts?.[grade] || 0;
        total += credit * classes;
        put(row, column, { v: part, k: "cCell" });
        put(row, column + 1, { v: credit, k: "cCell", input: index === 0 && semester === "1" ? { type: "number", value: credit,
          attrs: { "data-hours-creative-part": part, "data-focus-key": `creative-${part}`, min: 0, max: 10, step: 0.5, "aria-label": `창체 ${part} 학급당 학기 시수` } } : null });
        put(row, column + 2, { v: classes, k: "cCell" });
        put(row, column + 3, { v: credit * classes, f: `PRODUCT(${L(column + 1)}${row},${L(column + 2)}${row})`, k: "cCell" });
      });
      put(row, 15, { v: total, f: `SUM(G${row},K${row},O${row})`, k: "cCell" });
      put(row, 16, { v: total, f: `SUM(G${row},K${row},O${row})`, k: "cCell" });
      put(row, 17, { v: "", k: "cR" });
      put(row, 18, { v: 0, k: "cS" });
      put(row, 19, { v: total, f: `SUM(G${row},K${row},O${row})`, k: "cT" });
      refs.creative[semester].push(row);
      row++;
    }
  }
  const creativeEnd = row - 1;
  merge(creativeStart, 0, creativeEnd, 1);
  edge(row, "medium");
  // 요약 상자: 교과 합계(진로 제외) · 전체 평균(창체 제외) · 창체 포함 평균, 왼쪽은 메모.
  const [s1, s2, s3] = [row, row + 1, row + 2];
  for (const line of [s1, s2, s3]) heights[line] = 41.25;
  const memo = hoursFormMemo(stats);
  const medium = { l: "medium", r: "medium", t: "medium", b: "medium" };
  put(s1, 3, { v: memo.text, k: "box", memo, border: { t: "medium" } }); merge(s1, 3, s3, 12);
  const hasBody = refs.bodyEnd >= refs.bodyStart;
  const career = refs.career;
  const columnSum = (column) => hasBody ? `SUM(${column}${refs.bodyStart}:${column}${refs.bodyEnd})${career ? `-SUM(${column}${career.start}:${column}${career.end})` : ""}` : "0";
  const totals = stats.totals;
  const average = totals.average;
  put(s1, 13, { v: "교과", k: "sum1", border: medium }); merge(s1, 13, s1, 14);
  put(s1, 15, { v: totals["1"], f: columnSum("P"), k: "sum1", border: medium });
  put(s1, 16, { v: totals["2"], f: columnSum("Q"), k: "sum1", border: medium });
  put(s1, 17, { v: totals["1"] + totals["2"], f: columnSum("R"), k: "sum1Red", border: medium });
  put(s1, 18, { v: totals.teachers, f: hasBody ? `SUM(S${refs.bodyStart}:S${refs.bodyEnd})${career ? `-N(S${career.start})` : ""}` : "0", k: "sum1Teacher", border: medium });
  put(s1, 19, { v: hoursCareerNote(stats), k: "noteRed", border: { t: "medium", l: "medium" } }); merge(s1, 19, s1, 22);
  const guard = (expression) => `IF(N(S${s1})>0,${expression},"")`;
  const creative1 = refs.creative["1"].length ? `SUM(P${refs.creative["1"][0]}:P${refs.creative["1"].at(-1)})` : "0";
  const creative2 = refs.creative["2"].length ? `SUM(Q${refs.creative["2"][0]}:Q${refs.creative["2"].at(-1)})` : "0";
  put(s2, 13, { v: "전체\n평균", k: "sum2", border: medium }); merge(s2, 13, s2, 14);
  put(s2, 15, { v: number(average?.["1"]), f: guard(`P${s1}/S${s1}`), k: "sum2Num", border: medium });
  put(s2, 16, { v: number(average?.["2"]), f: guard(`Q${s1}/S${s1}`), k: "sum2Num", border: medium });
  put(s2, 17, { v: number(average?.year), f: guard(`R${s1}/S${s1}/2`), k: "sum2Red", border: medium });
  put(s2, 19, { v: "⇒ 창체제외 교과시수만 평균냄", k: "note", border: { l: "medium" } }); merge(s2, 19, s2, 22);
  put(s3, 13, { v: "창체 포함\n평균", k: "sum3", border: medium }); merge(s3, 13, s3, 14);
  put(s3, 15, { v: number(average?.creative1), f: guard(`(P${s1}+${creative1})/S${s1}`), k: "sum3Num", border: medium });
  put(s3, 16, { v: number(average?.creative2), f: guard(`(Q${s1}+${creative2})/S${s1}`), k: "sum3Num", border: medium });
  put(s3, 17, { v: number(average?.creativeYear), f: guard(`(R${s1}+${creative1}+${creative2})/S${s1}/2`), k: "sum3Red", border: medium });
  put(s3, 19, { v: "⇒ 창체포함 교과시수 평균냄", k: "note", border: { l: "medium" } }); merge(s3, 19, s3, 22);
  return { year, title: `${year}학년도 교과별 시수 통계`, lastRow: s3, tableEnd: creativeEnd, creativeStart, creativeEnd, summaryRows: [s1, s2, s3], cells, merges, rowEdges, heights, refs, memo, freeze: "D5" };

  function previousInput(key, label, value) {
    return { type: "number", value: value ?? "", attrs: { "data-hours-previous": key, "data-focus-key": `previous-${key}`, min: 0, max: 100, step: 0.01,
      "aria-label": `${label} ${Number(year) - 1}학년도 평균 시수` } };
  }
}

// 병합을 알고 칸마다 테두리를 정한다. 표 영역은 열·행 경계 규칙, 요약 상자는 칸에 적은 테두리를 쓴다.
function hoursFormLayout(model) {
  const owner = new Map();
  for (const merge of model.merges) {
    const [r1, c1, r2, c2] = merge;
    for (let row = r1; row <= r2; row++) for (let column = c1; column <= c2; column++) owner.set(`${row}:${column}`, merge);
  }
  const inTable = (row, column) => row >= 3 && row <= model.tableEnd && column <= 22;
  const blankKind = (row, column) => {
    if (row >= model.creativeStart && row <= model.creativeEnd && column <= 19) return column === 17 ? "cR" : "cCell";
    return ["group", "sub", "sem"][column] || (column <= 14 ? "cell" : { 15: "p", 16: "q", 17: "r", 18: "s", 19: "t", 20: "u", 21: "v", 22: "w" }[column] || "blank");
  };
  const rowEdge = (row) => model.rowEdges.get(row) || "hair";
  const border = (cell, [r1, c1, r2, c2], row, column) => {
    const explicit = cell?.border;
    const sides = explicit
      ? { l: explicit.l || null, r: explicit.r || null, t: explicit.t || null, b: explicit.b || null }
      : inTable(r1, c1) || (cell && r1 >= 3 && r1 <= model.tableEnd)
        ? { l: HOURS_FORM_COL_EDGES[c1], r: HOURS_FORM_COL_EDGES[c2 + 1], t: rowEdge(r1), b: rowEdge(r2 + 1) }
        : { l: null, r: null, t: null, b: null };
    return {
      l: column === c1 ? sides.l : null, r: column === c2 ? sides.r : null,
      t: row === r1 ? sides.t : null, b: row === r2 ? sides.b : null
    };
  };
  return { owner, inTable, blankKind, border };
}

function hoursFormDisplay(cell) {
  const value = cell?.v;
  if (value === "" || value === null || value === undefined) return "";
  if (typeof value === "number") {
    const format = HOURS_FORM_KINDS[cell.k]?.fmt;
    return format === "0.00" ? value.toFixed(2) : format === "0.0" ? value.toFixed(1) : hoursFormat(value);
  }
  return String(value);
}

// 화면 표: 같은 행·열·병합·색. 입력할 칸(개설반·교사수·전년도 평균·배분 메모·배분 합계·창체 학점·메모)은 그 칸 안에 입력 상자를 둔다.
function hoursFormHtml(model) {
  const layout = hoursFormLayout(model);
  const attrs = (map) => Object.entries(map || {}).map(([key, value]) => ` ${key}="${escapeHtml(String(value))}"`).join("");
  const input = (spec) => spec.type === "textarea"
    ? `<textarea class="hf-input hf-textarea${spec.cls || ""}"${attrs(spec.attrs)}>${escapeHtml(String(spec.value ?? ""))}</textarea>`
    : `<input class="hf-input${spec.cls || ""}" type="${spec.type}"${spec.type === "number" ? ' inputmode="decimal"' : ""} value="${escapeHtml(String(spec.value ?? ""))}"${spec.title ? ` title="${escapeHtml(spec.title)}"` : ""}${attrs(spec.attrs)}>`;
  const sideClass = (sides) => ["l", "r", "t", "b"].filter((side) => sides[side]).map((side) => `hb-${side}${sides[side][0]}`).join(" ");
  const lines = [`<colgroup>${HOURS_FORM_PIXELS.map((width) => `<col style="width:${width}px">`).join("")}</colgroup>`];
  for (let row = 1; row <= model.lastRow; row++) {
    let html = "";
    for (let column = 0; column < HOURS_FORM_COLUMNS; column++) {
      const merge = layout.owner.get(`${row}:${column}`);
      if (merge && (merge[0] !== row || merge[1] !== column)) continue;
      const cell = model.cells.get(`${row}:${column}`);
      if (!cell && !layout.inTable(row, column)) { html += "<td></td>"; continue; }
      const extent = merge || [row, column, row, column];
      const kind = cell?.k || layout.blankKind(row, column);
      const span = `${extent[2] > extent[0] ? ` rowspan="${extent[2] - extent[0] + 1}"` : ""}${extent[3] > extent[1] ? ` colspan="${extent[3] - extent[1] + 1}"` : ""}`;
      // 병합 칸의 테두리는 바깥 네 변만 필요하다(오른쪽 아래 끝 칸 기준으로 다시 계산).
      const outer = layout.border(cell, extent, row, column);
      const far = layout.border(cell, extent, extent[2], extent[3]);
      const sides = { l: outer.l, t: outer.t, r: far.r, b: far.b };
      let content;
      if (cell?.memo) {
        content = `<div class="hf-memo-fixed">${escapeHtml(cell.memo.fixed)}</div>
          <textarea class="hf-input hf-textarea" data-hours-staff-memo="1" data-hours-auto-memo="${escapeHtml(cell.memo.auto)}" data-focus-key="staff-memo" rows="3" aria-label="교사 증감 메모" placeholder="◈ ${escapeHtml(String(model.year || ""))}학년도 ⇒ 국어과 1명 감 (전년도 교사 수를 시수 설정에 넣으면 자동으로 적습니다)">${escapeHtml(cell.memo.changes)}</textarea>
          ${cell.memo.edited ? '<button class="button button-quiet hf-memo-reset" type="button" data-hours-action="reset-memo">자동 문구로</button>' : ""}`;
      } else if (cell?.input) content = input(cell.input);
      else content = escapeHtml(hoursFormDisplay(cell));
      html += `<td${span} class="hf-${kind}${sides.l || sides.r || sides.t || sides.b ? ` ${sideClass(sides)}` : ""}">${content}</td>`;
    }
    const rowClass = row <= 2 ? " hf-title-row" : row === 3 ? " hf-head-row hf-head-top" : row === 4 ? " hf-head-row hf-head-bottom" : model.summaryRows.includes(row) ? " hf-summary-row" : "";
    lines.push(`<tr class="hf-row${rowClass}">${html}</tr>`);
  }
  return `<table class="hours-form" aria-label="${escapeHtml(model.title || "교과별 시수")}">${lines.join("")}</table>`;
}

// 칸 종류별 글꼴·채움 CSS를 한 번 만든다(엑셀과 같은 HOURS_FORM_KINDS 기준).
function ensureHoursFormStyles() {
  if (typeof document === "undefined" || !document.head || document.head.querySelector("style[data-hours-form-styles]")) return;
  const style = document.createElement("style");
  style.dataset.hoursFormStyles = "1";
  style.textContent = Object.entries(HOURS_FORM_KINDS).map(([kind, spec]) =>
    `.hours-form .hf-${kind}{${spec.fill ? `background:#${spec.fill};` : ""}${spec.b ? "font-weight:700;" : ""}font-size:${Math.round(Math.max(9, spec.sz * (spec.sz >= 16 ? 0.9 : 1)))}px;${spec.red ? "color:#e00000;" : ""}${spec.h ? `text-align:${spec.h};` : ""}}`).join("\n");
  document.head.appendChild(style);
}

// 엑셀 스타일 목록: 앞 11개는 보고서 공통 스타일(createReportStylesXml과 같은 번호), 뒤는 시수표 양식 칸.
function hoursWorkbookStyles() {
  const fonts = [], fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'], borders = [], formats = [], xfs = [];
  const indexOf = (list, xml) => { let index = list.indexOf(xml); if (index < 0) { list.push(xml); index = list.length - 1; } return index; };
  const known = new Map();
  const add = (spec) => {
    const font = `<font>${spec.b ? "<b/>" : ""}<sz val="${spec.sz || 10}"/>${spec.color ? `<color rgb="${spec.color}"/>` : ""}<name val="맑은 고딕"/><family val="2"/></font>`;
    const fill = spec.fill ? `<fill><patternFill patternType="solid"><fgColor rgb="FF${spec.fill}"/><bgColor indexed="64"/></patternFill></fill>` : fills[0];
    const side = (name, value) => value ? `<${name} style="${value}"><color rgb="${spec.borderColor || "FF000000"}"/></${name}>` : `<${name}/>`;
    const sides = spec.border || {};
    const border = `<border>${side("left", sides.l)}${side("right", sides.r)}${side("top", sides.t)}${side("bottom", sides.b)}<diagonal/></border>`;
    const numFmtId = spec.fmt ? 164 + indexOf(formats, spec.fmt) : 0;
    const alignment = spec.h || spec.v || spec.wrap
      ? `<alignment${spec.h ? ` horizontal="${spec.h}"` : ""}${spec.v ? ` vertical="${spec.v}"` : ""}${spec.wrap ? ' wrapText="1"' : ""}/>` : "";
    const xf = `<xf numFmtId="${numFmtId}" fontId="${indexOf(fonts, font)}" fillId="${indexOf(fills, fill)}" borderId="${indexOf(borders, border)}" xfId="0"${numFmtId ? ' applyNumberFormat="1"' : ""}${alignment ? ` applyAlignment="1">${alignment}</xf>` : "/>"}`;
    if (!known.has(xf)) { known.set(xf, xfs.length); xfs.push(xf); }
    return known.get(xf);
  };
  const thin = { l: "thin", r: "thin", t: "thin", b: "thin" };
  const grey = "FF555555";
  [
    { sz: 10 }, { sz: 14, b: true, h: "center", v: "center" },
    { sz: 10, b: true, fill: "E9EEF6", border: thin, borderColor: grey, h: "center", v: "center", wrap: true },
    { sz: 10, border: thin, borderColor: grey, h: "left", v: "center", wrap: true },
    { sz: 10, border: thin, borderColor: grey, h: "center", v: "center", wrap: true },
    { sz: 10, fmt: "0.00", border: thin, borderColor: grey, h: "center", v: "center" },
    { sz: 10, b: true, fill: "F4F6F9", border: thin, borderColor: grey, h: "center", v: "center", wrap: true },
    { sz: 10, b: true, fmt: "0.00", fill: "F4F6F9", border: thin, borderColor: grey, h: "center", v: "center" },
    { sz: 9, color: "FF8A3B12", h: "left", v: "center", wrap: true },
    { sz: 10, b: true, fill: "FFF3B0", border: thin, borderColor: grey, h: "center", v: "center", wrap: true },
    { sz: 10, fmt: "0.0", border: thin, borderColor: grey, h: "center", v: "center" }
  ].forEach(add);
  const form = new Map();
  return {
    form(kind, sides) {
      const key = `${kind}|${sides.l || ""}|${sides.r || ""}|${sides.t || ""}|${sides.b || ""}`;
      if (!form.has(key)) {
        const spec = HOURS_FORM_KINDS[kind] || HOURS_FORM_KINDS.blank;
        form.set(key, add({ sz: spec.sz, b: spec.b, color: spec.red ? "FFFF0000" : "", fill: spec.fill, border: sides, h: spec.h || "center", v: "center", wrap: spec.wrap, fmt: spec.fmt }));
      }
      return form.get(key);
    },
    xml() {
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        (formats.length ? `<numFmts count="${formats.length}">${formats.map((code, index) => `<numFmt numFmtId="${164 + index}" formatCode="${code}"/>`).join("")}</numFmts>` : "") +
        `<fonts count="${fonts.length}">${fonts.join("")}</fonts><fills count="${fills.length}">${fills.join("")}</fills><borders count="${borders.length}">${borders.join("")}</borders>` +
        `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>` +
        `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
    }
  };
}

// 엑셀 첫 시트('2027 교사시수표'): 화면과 같은 모델, 수식은 원래 양식과 같은 꼴(PRODUCT·SUM·평균·창체 포함 평균).
function hoursFormSheet(model, styles, name) {
  const layout = hoursFormLayout(model);
  const rows = [];
  const merges = [];
  for (const merge of model.merges) {
    const cell = model.cells.get(`${merge[0]}:${merge[1]}`);
    if (cell?.split) continue;
    merges.push(`${hoursColumnLetter(merge[1])}${merge[0]}:${hoursColumnLetter(merge[3])}${merge[2]}`);
  }
  for (let row = 1; row <= model.lastRow; row++) {
    const line = [];
    for (let column = 0; column < HOURS_FORM_COLUMNS; column++) {
      const merge = layout.owner.get(`${row}:${column}`);
      const top = merge ? model.cells.get(`${merge[0]}:${merge[1]}`) : model.cells.get(`${row}:${column}`);
      if (!top && !layout.inTable(row, column)) { line.push(null); continue; }
      const extent = merge || [row, column, row, column];
      const s = styles.form(top?.k || layout.blankKind(row, column), layout.border(top, extent, row, column));
      if (top?.split) {
        // 배분 메모 '통과10 · 과탐실3 · 융과4'는 원래 양식처럼 X·Y·Z·AA 칸에 하나씩 나눠 적는다(넘치면 AA에 이어 적음).
        const parts = String(top.v || "").split(/\s*[·,]\s*|\s{2,}/).filter(Boolean);
        const index = column - merge[1];
        const value = row !== merge[0] ? "" : index < 3 ? parts[index] || "" : parts.slice(3).join(" · ");
        line.push({ v: value, s });
        continue;
      }
      if (merge && (merge[0] !== row || merge[1] !== column)) { line.push({ v: "", s }); continue; }
      line.push(top?.f ? { f: top.f, v: top.v, s } : { v: top?.v ?? "", s });
    }
    rows.push(line);
  }
  const heights = Object.fromEntries(Object.entries(model.heights).map(([row, height]) => [Number(row) - 1, height]));
  for (let row = 5; row <= model.tableEnd; row++) if (!(row - 1 in heights)) heights[row - 1] = 17.25;
  return { name, rows, merges, freeze: model.freeze, widths: HOURS_FORM_WIDTHS, heights, orientation: "portrait", fitToHeight: 1 };
}

// 엑셀: 1) 원래 양식 시트 '2027 교사시수표' 2) 과목별 상세 3) 교원 구성 4) 교사 수 추천 5) 확인 필요.
// 스타일 목록은 sheets.stylesXml에 실어 createWorkbookBlob(sheets, { stylesXml })로 넘긴다.
function buildHoursWorkbookSheets(stats, { schoolName = typeof $ === "function" ? $("#schoolName")?.value || "" : "", date = new Date() } = {}) {
  const styles = hoursWorkbookStyles();
  const model = hoursFormModel(stats, { schoolName, date });
  const form = hoursFormSheet(model, styles, `${stats.year} 교사시수표`);
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
  // 교원 구성(원래 양식에는 메모 한 줄뿐이라 따로 둔다): 총 교사 수 = 교과 + 진로 + 비교과 + 기타, 전체 교원 기준 평균(참고).
  const staff = stats.staff;
  const totals = stats.totals;
  const header = (value) => ({ v: value, s: 2 });
  const staffRows = [
    [{ v: `${stats.year}학년도 교원 구성`, s: 1 }],
    [header("구분"), header("교사 수"), header("1학기\n수업 시수"), header("2학기\n수업 시수"), header("1인당 시수\n(1년)"), header("비고")]
  ];
  const perYear = (row) => ({ f: `IF(B${row}>0,(C${row}+D${row})/B${row}/2,"")`, v: "", s: 5 });
  const line = (name, teachers, hours, note, style = 3) => {
    const row = staffRows.length + 1;
    staffRows.push([{ v: name, s: style }, teachers, hours[0], hours[1], perYear(row), { v: note, s: 3 }]);
    return row;
  };
  const totalRow = line("총 교사 수", { v: staff.total ?? 0, s: 6 }, [{ v: "", s: 4 }, { v: "", s: 4 }],
    staff.entered === null ? "제안값(교과 + 진로 + 비교과 합) · 시수 설정에서 총 교사 수를 입력하세요" : "직접 입력(학교 교원 정원)", 6);
  staffRows[totalRow - 1][4] = { v: "", s: 4 };
  const subjectRow = line("교과 교사 (진로 제외)", { v: totals.teachers, s: 4 }, [{ v: totals["1"], s: 4 }, { v: totals["2"], s: 4 }], "교과 평균 시수 = 교과 시수 ÷ 교과 교사 수 (시수표 '교과' 줄)");
  line("진로 (평균 제외)", { v: staff.career, s: 4 }, [{ v: staff.careerHours["1"], s: 4 }, { v: staff.careerHours["2"], s: 4 }], "진로와 직업 · 교과 합계·평균에서 뺌");
  let lastRole = subjectRow + 1;
  for (const role of stats.nonTeaching) {
    const subjects = role.items.map((item) => `${item.grade}-${item.semester} ${item.subject} ${item.hours}시간`);
    const extra = role.extra["1"] || role.extra["2"] ? `직접 입력 ${role.extra["1"]}/${role.extra["2"]}시간` : "";
    lastRole = line(`비교과 · ${role.label}`, { v: role.teachers ?? 0, s: 4 }, [{ v: role.hours["1"], s: 4 }, { v: role.hours["2"], s: 4 }],
      [subjects.length ? `맡은 과목: ${subjects.join(", ")}` : "", extra, "교과 평균에서 뺌"].filter(Boolean).join(" · "));
  }
  const otherRow = line("기타 (교과 미배정)", { f: `B${totalRow}-SUM(B${subjectRow}:B${lastRole})`, v: staff.other ?? 0, s: 4 }, [{ v: "", s: 4 }, { v: "", s: 4 }],
    staff.over ? `교과 + 진로 + 비교과가 총 교사 수보다 ${hoursFormat(-staff.other, 1)}명 많습니다` : "총 교사 수 − 교과 − 진로 − 비교과");
  staffRows[otherRow - 1][4] = { v: "", s: 4 };
  const all = `SUM(C${subjectRow}:C${lastRole})`, all2 = `SUM(D${subjectRow}:D${lastRole})`;
  staffRows.push([{ v: "전체 교원 기준 평균 (참고) = (교과 + 진로 + 비교과 수업 시수) ÷ 총 교사 수", s: 6 }, { v: "", s: 6 },
    { f: `IF(B${totalRow}>0,${all}/B${totalRow},"")`, v: staff.average ? staff.average["1"] : "", s: 7 },
    { f: `IF(B${totalRow}>0,${all2}/B${totalRow},"")`, v: staff.average ? staff.average["2"] : "", s: 7 },
    { f: `IF(B${totalRow}>0,(${all}+${all2})/B${totalRow}/2,"")`, v: staff.average ? staff.average.year : "", s: 7 }, { v: "참고 값(교과 평균은 시수표 '전체 평균' 줄)", s: 3 }]);
  const staffSheet = { name: "교원 구성", rows: staffRows, merges: ["A1:F1"], widths: [34, 9, 10, 10, 10, 60], freeze: "A3" };
  const sheets = [form, detail, staffSheet];
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
  sheets.stylesXml = styles.xml();
  sheets.model = model;
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
  // 다음 해 '전년도 평균'(W열)으로 쓸 값: 교과별 1년 평균, 과학·사회는 원래 양식처럼 교과군 평균(교과군 이름으로)도 둔다.
  settings.lastAverages = Object.fromEntries([
    ...stats.departments.filter((department) => department.yearAverage !== null)
      .map((department) => [department.id, Math.round(department.yearAverage * 100) / 100]),
    ...stats.departments.filter((department) => department.common && department.groupAverage !== null)
      .map((department) => [department.group, Math.round(department.groupAverage * 100) / 100])
  ]);
  settings.lastExportedAt = new Date().toISOString();
  persistState();
  const sheets = buildHoursWorkbookSheets(stats);
  downloadBlob(createWorkbookBlob(sheets, { stylesXml: sheets.stylesXml }), `${stats.year}학년도_교과별_시수통계.xlsx`);
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
    // 4MB 자료를 칸마다 바로 직렬화하지 않고 묶어서 저장(app.js persistStateSoon).
    if (typeof persistStateSoon === "function") persistStateSoon(); else persistState();
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
  const handleAction = (event) => {
    const button = event.target.closest("[data-hours-action], [data-hours-auto-allocate]");
    if (!button) return;
    if (button.dataset.hoursAutoAllocate) autoAllocateHoursCommon(button.dataset.hoursAutoAllocate);
    else if (button.dataset.hoursAction === "apply-recommendation") applyHoursRecommendation();
    else if (button.dataset.hoursAction === "undo") undoHoursChange();
    else if (button.dataset.hoursAction === "reset-memo") {
      const settings = hoursSettings(hoursTargetYear(), true);
      delete settings.staffMemo;
      hoursFinishChange("교사 증감 메모를 자동 문구로 되돌렸습니다.");
    }
  };
  content.addEventListener("change", handleChange);
  content.addEventListener("click", openCohort);
  content.addEventListener("toggle", (event) => {
    if (event.target.matches?.('details[data-hours-details="detail"]') && event.target.open && !event.target.querySelector("tbody tr")) scheduleHoursRerender();
  }, true);
  content.addEventListener("click", handleAction);
  // 학급 수·근거 차수·교원 구성·전년도 교사 수는 '시수 설정' 팝업, 교사 수 추천·고정은 '교사 수 추천' 팝업 안에 있다.
  const settingsBody = document.getElementById("hoursSettingsBody");
  settingsBody?.addEventListener("change", handleChange);
  settingsBody?.addEventListener("click", openCohort);
  const recommendBody = document.getElementById("hoursRecommendBody");
  recommendBody?.addEventListener("change", handleChange);
  recommendBody?.addEventListener("click", handleAction);
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
