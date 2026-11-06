"use strict";
// 위계(선이수)·이수학점 점검.
// 위쪽은 화면·저장과 무관한 순수 계산(테스트가 잘라 쓴다), '앱 연결' 아래는 2~4단계·웹 수강신청 화면 연결이다.
// 편제표는 1단계 데이터(planData: 과목·학기 학점·선택과목군·필수이수 열)를 쓴다. 현 N학년은 N+1학년 과목을 신청한다.

var COURSE_CHECK_FIELDS = ["sem11", "sem12", "sem21", "sem22", "sem31", "sem32"];
// 2022 개정 교육과정 대표 위계(앞 과목 → 뒤 과목). 과목명은 2022 개정 과목 목록에 있는 이름만 쓴다.
// 제2외국어 '○○어 → ○○어 회화' 같은 관계는 근거가 확실하지 않아 넣지 않았다(교사가 팝업에서 추가).
var COURSE_CHECK_DEFAULT_RULES = [
  ["공통수학1", "대수"], ["공통수학2", "대수"],
  ["공통수학1", "미적분Ⅰ"], ["공통수학2", "미적분Ⅰ"],
  ["공통수학1", "확률과 통계"], ["공통수학2", "확률과 통계"],
  ["공통수학1", "기하"], ["공통수학2", "기하"],
  ["대수", "미적분Ⅱ"], ["미적분Ⅰ", "미적분Ⅱ"],
  ["영어Ⅰ", "영어Ⅱ"],
  ["물리학", "역학과 에너지"], ["물리학", "전자기와 양자"],
  ["화학", "물질과 에너지"], ["화학", "화학 반응의 세계"],
  ["생명과학", "세포와 물질대사"], ["생명과학", "생물의 유전"],
  ["지구과학", "지구시스템과학"], ["지구과학", "행성우주과학"]
];
// 2022 개정 총론 고등학교 교과(군)별 필수 이수 학점(편제표 '필수이수' 열이 비었을 때의 기본값).
var COURSE_CHECK_FAMILIES = ["국어", "수학", "영어", "사회(역사/도덕 포함)", "과학", "체육", "예술", "기술·가정/정보/제2외국어/한문/교양"];
var COURSE_CHECK_REQUIRED_DEFAULTS = { "국어": 8, "수학": 8, "영어": 8, "사회(역사/도덕 포함)": 14, "과학": 10, "체육": 10, "예술": 10, "기술·가정/정보/제2외국어/한문/교양": 16 };
var COURSE_CHECK_TOTALS = { subjects: 174, creative: 18, total: 192 };

function courseCheckKey(name) {
  const text = typeof normalizeResultCourseName === "function" ? normalizeResultCourseName(name)
    : String(name ?? "").replace(/[ⅠⅡⅢⅣⅤ]/g, (char) => String("ⅠⅡⅢⅣⅤ".indexOf(char) + 1))
      .replace(/[*＊★☆■↔]/g, "").replace(/[（(]\s*[12]\s*학기\s*[)）]/g, "").replace(/[·ㆍ•‧]/g, "").replace(/\s+/g, "");
  return text.toLowerCase();
}

// 편제표 한 칸의 과목명(쉼표로 여러 과목)을 나눈다. 표기 기호와 교차 표시는 뺀다.
function courseCheckSplitNames(name) {
  return String(name ?? "").split(/[,，、]/)
    .map((part) => part.replace(/↔/g, " ").replace(/[*＊★☆■]/g, "").replace(/\s+/g, " ").trim())
    .filter((part) => part && !/소계|합계|총이수|창의적|과목명|세부과목/.test(part.replace(/\s+/g, "")));
}

function courseCheckFieldLabel(field) {
  return `${field.slice(3, 4)}-${field.slice(4, 5)}`;
}

function courseCheckFieldIndex(grade, semester) {
  const g = Number(grade), s = Number(semester);
  return g >= 1 && g <= 3 && (s === 1 || s === 2) ? (g - 1) * 2 + s - 1 : -1;
}

// 받침에 따라 을/를, 은/는, 이/가를 고른다(Ⅰ=일, Ⅱ=이처럼 읽는다).
function courseCheckJosa(word, pair) {
  const [withFinal, withoutFinal] = pair.split("/");
  const last = String(word ?? "").trim().slice(-1);
  const reading = { "Ⅰ": "일", "Ⅱ": "이", "Ⅲ": "삼", "Ⅳ": "사", "Ⅴ": "오", "1": "일", "2": "이", "3": "삼", "4": "사", "5": "오",
    "6": "육", "7": "칠", "8": "팔", "9": "구", "0": "영" }[last] || last;
  const code = reading.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return `${word}${withFinal}`;
  const final = code % 28;
  if (withFinal === "으로") return `${word}${final === 0 || final === 8 ? "로" : "으로"}`;
  return `${word}${final ? withFinal : withoutFinal}`;
}

// 교과(군): 편제표 교과 칸을 먼저 보고, 없으면 2022 개정 과목 목록의 교과(군)을 쓴다.
function courseCheckFamily(area, name = "") {
  const text = String(area ?? "").replace(/\s+/g, "");
  const byText = /국어/.test(text) ? 0 : /수학/.test(text) ? 1 : /영어/.test(text) ? 2
    : /한국사|사회|역사|도덕|윤리|지리/.test(text) ? 3 : /과학/.test(text) ? 4 : /체육/.test(text) ? 5
      : /예술|음악|미술|연극/.test(text) ? 6 : /기술|가정|정보|외국어|한문|교양/.test(text) ? 7 : -1;
  if (byText >= 0) return COURSE_CHECK_FAMILIES[byText];
  const official = typeof findCurriculumOfficialSubject === "function" ? findCurriculumOfficialSubject(name) : null;
  const areas = { "국어": 0, "수학": 1, "영어": 2, "사회(역사/도덕 포함)": 3, "과학": 4, "체육": 5, "예술": 6,
    "기술⋅가정/정보": 7, "제2외국어/한문": 7, "교양": 7, "과학 계열(수학)": 1, "과학 계열(과학)": 4, "과학 계열(정보)": 7,
    "체육 계열(체육)": 5, "예술 계열(예술)": 6, "외국어‧국제계열(영어)": 2, "외국어‧국제계열(사회(역사/도덕 포함)": 3,
    "외국어‧국제계열(제2외국어)": 7 };
  const index = official ? areas[official.area] : undefined;
  return index === undefined ? "기타" : COURSE_CHECK_FAMILIES[index];
}

// 편제표 데이터에서 점검 모델을 만든다.
//  · 지정 과목: 선택과목군에 들지 않은 학기 학점(한 행에 과목이 여럿이면 학점은 한 번만 센다)
//  · 선택과목군: 학기(들)·택 수·학점·구성 과목
//  · 학기 기준 학점 = 지정 학점 + Σ(택 수 × 학점) — 편제표 '이수학점 소계'와 같은 계산
//  · 공동교육과정·소인수처럼 학기 칸 메모로 적은 순증 과목은 소계에 들지 않으므로 뺀다.
function courseCheckPlanModel(planData) {
  const rawGroups = Array.isArray(planData?.groups) ? planData.groups : [];
  const subjects = [];
  const byId = new Map();
  for (const item of planData?.subjects || []) {
    if (!item || item.fixed || String(item.note || "").trim()) continue;
    const names = courseCheckSplitNames(item.name);
    if (!names.length) continue;
    const memberships = rawGroups.filter((group) => (group.members || []).includes(item.id));
    const designated = {};
    for (const field of COURSE_CHECK_FIELDS) {
      if (memberships.some((group) => (group.fields || []).includes(field))) continue;
      const credit = Number(item.credits?.[field]);
      if (credit > 0) designated[field] = credit;
    }
    const subject = {
      id: item.id, names, keys: names.map(courseCheckKey), area: String(item.area ?? "").replace(/\s+/g, " ").trim(),
      family: courseCheckFamily(item.area, names[0]), designated, groups: memberships.map((group) => group.id),
      required: item.required && typeof item.required === "object" ? item.required : null
    };
    subjects.push(subject);
    byId.set(item.id, subject);
  }
  const groups = rawGroups.map((group, index) => {
    const members = (group.members || []).map((id) => byId.get(id)).filter(Boolean);
    const fields = (group.fields || []).filter((field) => COURSE_CHECK_FIELDS.includes(field)).sort();
    const families = new Map();
    for (const member of members) member.keys.forEach((key) => families.set(key, member.family));
    return {
      id: group.id || `g${index}`, fields, pick: Math.max(1, Number(group.pick) || 1), credit: Number(group.credit) || 0,
      keys: [...new Set(members.flatMap((member) => member.keys))], names: [...new Set(members.flatMap((member) => member.names))],
      families, label: `${fields.map(courseCheckFieldLabel).join("·")} 택${Math.max(1, Number(group.pick) || 1)}`
    };
  }).filter((group) => group.fields.length && group.keys.length);
  const counts = new Map();
  for (const group of groups) counts.set(group.label, (counts.get(group.label) || 0) + 1);
  const seen = new Map();
  for (const group of groups) {
    if (counts.get(group.label) < 2) continue;
    const order = (seen.get(group.label) || 0) + 1;
    seen.set(group.label, order);
    group.label = `${group.label}-${order}`;
  }
  const fields = {};
  for (const field of COURSE_CHECK_FIELDS) {
    const designatedRows = subjects.filter((subject) => subject.designated[field] > 0);
    const designatedCredits = designatedRows.reduce((sum, subject) => sum + subject.designated[field], 0);
    const fieldGroups = groups.filter((group) => group.fields.includes(field));
    fields[field] = {
      designated: designatedCredits, designatedRows: designatedRows.map((subject) => subject.id),
      groups: fieldGroups.map((group) => group.id),
      target: designatedCredits + fieldGroups.reduce((sum, group) => sum + group.pick * group.credit, 0)
    };
  }
  // 필수이수 열: 병합 칸(세그먼트)마다 값 하나. 같은 교과(군)의 서로 다른 칸은 더한다(예: 한국사 6 + 사회 8 = 14).
  const required = {};
  const segments = new Set();
  for (const subject of subjects) {
    const value = Number(String(subject.required?.text ?? "").replace(/[^\d.]/g, ""));
    const segment = subject.required?.seg || subject.id;
    if (!(value > 0) || segments.has(segment)) continue;
    segments.add(segment);
    required[subject.family] = (required[subject.family] || 0) + value;
  }
  // 과목명 → 편제표에서 나오는 자리(지정 단독 과목인지, 고르는 과목인지).
  const places = new Map();
  const place = (key, entry) => { if (!places.has(key)) places.set(key, []); places.get(key).push(entry); };
  for (const subject of subjects) {
    for (const [field, credit] of Object.entries(subject.designated)) {
      subject.keys.forEach((key, index) => place(key, { field, kind: subject.names.length === 1 ? "designated" : "choice",
        name: subject.names[index], credit, family: subject.family }));
    }
  }
  for (const group of groups) {
    for (const field of group.fields) {
      group.keys.forEach((key, index) => place(key, { field, kind: "choice", group: group.id, name: group.names[index] || key,
        credit: group.credit, family: group.families.get(key) || "기타" }));
    }
  }
  return { subjects, groups, fields, required, places };
}

function courseCheckRuleKey(before, after) {
  return `${courseCheckKey(before)}>${courseCheckKey(after)}`;
}

// 편제표(여러 입학연도)에 실제로 있는 과목끼리의 기본 위계만 고른다.
function courseCheckApplicableDefaults(models) {
  const keys = new Set();
  for (const model of models) for (const key of model?.places?.keys() || []) keys.add(key);
  return COURSE_CHECK_DEFAULT_RULES.filter(([before, after]) => keys.has(courseCheckKey(before)) && keys.has(courseCheckKey(after)))
    .map(([before, after]) => ({ key: courseCheckRuleKey(before, after), before, after, source: "default" }));
}

// 학생 한 명의 위계 점검.
// selections: [{ name, semester: "1"|"2"|"" }] (신청 학년 targetGrade의 과목), prior: 이전 학년 이수 과목명 배열 또는 null(자료 없음)
// 근거: ① 편제표 이전 학기 지정(단독) 과목 ② 같은 신청의 앞 학기 선택 ③ 이전 학년 이수 결과. 같은 학기 선택은 인정하지 않는다.
// 판단할 근거가 없으면 'unknown'(확인 불가)으로 두고 위반으로 세지 않는다.
function courseCheckPrerequisites(model, rules, { targetGrade, selections = [], prior = null } = {}) {
  const grade = String(targetGrade);
  const picked = selections.map((item) => ({ ...item, key: courseCheckKey(item.name), semester: ["1", "2"].includes(String(item.semester)) ? String(item.semester) : "" }));
  const priorKeys = Array.isArray(prior) ? new Set(prior.map(courseCheckKey)) : null;
  const byAfter = new Map();
  for (const rule of rules || []) {
    if (!rule || rule.off) continue;
    const key = courseCheckKey(rule.after);
    if (!byAfter.has(key)) byAfter.set(key, []);
    byAfter.get(key).push(rule);
  }
  const issues = [];
  for (const course of picked) {
    for (const rule of byAfter.get(course.key) || []) {
      const needKey = courseCheckKey(rule.before);
      const at = course.semester ? courseCheckFieldIndex(grade, course.semester) : -1;
      const places = model?.places?.get(needKey) || [];
      const base = { course: course.name, semester: course.semester, requires: rule.before, rule: rule.key || courseCheckRuleKey(rule.before, rule.after) };
      const earliestThisGrade = courseCheckFieldIndex(grade, 1);
      let status = "", evidence = "";
      // ① 편제표 지정 과목
      for (const placement of places.filter((item) => item.kind === "designated")) {
        const index = COURSE_CHECK_FIELDS.indexOf(placement.field);
        if (at >= 0 ? index < at : index < earliestThisGrade) { status = "met"; evidence = `편제표 지정 ${courseCheckFieldLabel(placement.field)}`; break; }
      }
      // ② 같은 신청 안의 앞 학기 선택
      const sameApp = picked.filter((item) => item.key === needKey && item !== course);
      if (!status) {
        const earlier = sameApp.find((item) => item.semester && at >= 0 && courseCheckFieldIndex(grade, item.semester) < at);
        if (earlier) { status = "met"; evidence = `${grade}-${earlier.semester} 선택`; }
      }
      // ③ 이전 학년 이수 결과
      if (!status && priorKeys?.has(needKey)) { status = "met"; evidence = "이전 학년 이수 결과"; }
      if (!status) {
        const same = sameApp.find((item) => item.semester && item.semester === course.semester);
        const later = sameApp.find((item) => item.semester && at >= 0 && courseCheckFieldIndex(grade, item.semester) > at);
        const designatedLater = places.find((item) => item.kind === "designated" && at >= 0 && COURSE_CHECK_FIELDS.indexOf(item.field) >= at);
        const priorChoice = places.some((item) => item.kind === "choice" && COURSE_CHECK_FIELDS.indexOf(item.field) < earliestThisGrade);
        const designatedThisGrade = places.some((item) => item.kind === "designated" && item.field.slice(3, 4) === grade);
        if (same) { status = "violation"; evidence = "same"; }
        else if (later) { status = "violation"; evidence = `later:${grade}-${later.semester}`; }
        else if (designatedLater) { status = "violation"; evidence = `designated-later:${courseCheckFieldLabel(designatedLater.field)}`; }
        else if (priorChoice && !priorKeys) { status = "unknown"; evidence = "prior"; }
        else if (!course.semester && (designatedThisGrade || sameApp.length)) { status = "unknown"; evidence = "semester"; }
        else if (sameApp.length && sameApp.some((item) => !item.semester)) { status = "unknown"; evidence = "semester"; }
        else { status = "violation"; evidence = "missing"; }
      }
      if (status === "met") continue;
      const offered = [...(model?.places?.get(needKey) || [])].filter((item) => item.kind === "choice" &&
        item.field.slice(3, 4) === grade && at >= 0 && COURSE_CHECK_FIELDS.indexOf(item.field) < at);
      issues.push({ ...base, status, reason: evidence, offeredEarlier: offered.map((item) => courseCheckFieldLabel(item.field))[0] || "" });
    }
  }
  return {
    issues, violations: issues.filter((issue) => issue.status === "violation"), unknowns: issues.filter((issue) => issue.status === "unknown")
  };
}

function courseCheckIssueText(issue, { student = false } = {}) {
  const course = issue.course, need = issue.requires;
  const head = `${courseCheckJosa(course, "은/는")} ${courseCheckJosa(need, "을/를")} 먼저 이수해야 합니다`;
  if (issue.status === "unknown") {
    return issue.reason === "semester"
      ? `${head} — 학기를 알 수 없어 확인 불가`
      : `${head} — 이전 학년 이수 결과가 없어 확인 불가${student ? "(이전 학년에 이수하지 않았다면 담당 선생님과 상의하세요)" : ""}`;
  }
  const why = issue.reason === "same" ? `같은 학기(${issue.semester}학기)에 함께 고른 ${courseCheckJosa(need, "은/는")} 선이수로 인정되지 않습니다`
    : issue.reason.startsWith("later:") ? `${courseCheckJosa(need, "을/를")} 더 뒤 학기(${issue.reason.slice(6)})에 골랐습니다`
      : issue.reason.startsWith("designated-later:") ? `${courseCheckJosa(need, "은/는")} 편제표에서 ${issue.reason.slice(17)} 지정 과목입니다`
        : `${courseCheckJosa(need, "을/를")} 이수한 근거가 없습니다`;
  const advice = issue.offeredEarlier ? `${issue.offeredEarlier}에 ${courseCheckJosa(need, "을/를")} 고르거나 담당 선생님과 상의하세요` : "담당 선생님과 상의하세요";
  return `${head} — ${why}. ${advice}.`;
}

// 학생 한 명의 이수 학점 점검(신청 학년 targetGrade 기준).
// selections: [{ name, semester, credit }], prior: 이전 학년 이수 과목명 배열 또는 null, required: 교과(군)별 필수 학점 덮어쓰기
function courseCheckCredits(model, { targetGrade, selections = [], prior = null, required = {} } = {}) {
  const grade = String(targetGrade);
  const fieldsOf = (g) => [`sem${g}1`, `sem${g}2`];
  const gradeFields = fieldsOf(grade);
  const gradeGroups = model.groups.filter((group) => group.fields.some((field) => gradeFields.includes(field)));
  const chosen = new Map(gradeGroups.map((group) => [group.id, new Set()]));
  const extras = [];
  const familyEarned = Object.fromEntries(COURSE_CHECK_FAMILIES.map((family) => [family, 0]));
  familyEarned["기타"] = 0;
  const seenKeys = new Set();
  for (const item of selections) {
    const key = courseCheckKey(item.name);
    if (!key || seenKeys.has(`${key}|${item.semester || ""}`)) continue;
    seenKeys.add(`${key}|${item.semester || ""}`);
    const semester = ["1", "2"].includes(String(item.semester)) ? String(item.semester) : "";
    const candidates = gradeGroups.filter((group) => group.keys.includes(key));
    const group = (semester && candidates.find((candidate) => candidate.fields.includes(`sem${grade}${semester}`))) ||
      candidates.find((candidate) => !chosen.get(candidate.id).has(key)) || candidates[0];
    if (group) chosen.get(group.id).add(key);
    else extras.push({ name: item.name, key, semester, credit: Number(item.credit) || 0, family: courseCheckFamily(item.area, item.name) });
  }
  const groupRows = gradeGroups.map((group) => {
    const count = chosen.get(group.id).size;
    return { id: group.id, label: group.label, fields: group.fields, pick: group.pick, credit: group.credit, chosen: count,
      diff: (count - group.pick) * group.credit };
  });
  for (const group of gradeGroups) {
    for (const key of chosen.get(group.id)) familyEarned[group.families.get(key) || "기타"] += group.credit * group.fields.length;
  }
  for (const extra of extras) familyEarned[extra.family] = (familyEarned[extra.family] || 0) + extra.credit;
  const semesters = gradeFields.map((field) => {
    const plan = model.fields[field];
    const rows = groupRows.filter((row) => row.fields.includes(field));
    const extraCredits = extras.filter((extra) => extra.semester === field.slice(4, 5)).reduce((sum, extra) => sum + extra.credit, 0);
    const earned = plan.designated + rows.reduce((sum, row) => sum + row.chosen * row.credit, 0) + extraCredits;
    return { field, label: courseCheckFieldLabel(field), designated: plan.designated, target: plan.target, earned,
      diff: earned - plan.target, groups: rows, extraCredits };
  });
  const unplaced = extras.filter((extra) => !extra.semester).reduce((sum, extra) => sum + extra.credit, 0);
  // 3년 누계: 이전 학년은 지정 + (이전 학년 결과가 있으면 그 선택, 없으면 편제표 기준 가정), 뒤 학년은 편제표 기준(예정).
  const priorKeys = Array.isArray(prior) ? new Set(prior.map(courseCheckKey)) : null;
  let before = 0, beforeEstimated = false, after = 0;
  for (const field of COURSE_CHECK_FIELDS) {
    const g = field.slice(3, 4);
    if (g === grade) continue;
    const plan = model.fields[field];
    if (g > grade) { after += plan.target; continue; }
    for (const id of plan.designatedRows) {
      const subject = model.subjects.find((item) => item.id === id);
      familyEarned[subject.family] += subject.designated[field];
    }
    if (!priorKeys) {
      before += plan.target;
      if (plan.target > plan.designated) beforeEstimated = true;
      continue;
    }
    let earned = plan.designated;
    for (const group of model.groups.filter((item) => item.fields.includes(field))) {
      const taken = group.keys.filter((key) => priorKeys.has(key));
      earned += taken.length * group.credit;
      for (const key of taken) familyEarned[group.families.get(key) || "기타"] += group.credit;
    }
    before += earned;
  }
  // 이번 학년과 뒤 학년의 지정 과목(뒤 학년 선택 과목은 아직 모르므로 넣지 않는다)
  for (const field of COURSE_CHECK_FIELDS.filter((item) => item.slice(3, 4) >= grade)) {
    for (const id of model.fields[field].designatedRows) {
      const subject = model.subjects.find((item) => item.id === id);
      familyEarned[subject.family] += subject.designated[field];
    }
  }
  const futureUnknown = model.groups.some((group) => group.fields.some((field) => field.slice(3, 4) > grade));
  const priorUnknown = !priorKeys && model.groups.some((group) => group.fields.some((field) => field.slice(3, 4) < grade));
  const families = COURSE_CHECK_FAMILIES.map((family) => {
    const need = Number(required?.[family]) > 0 ? Number(required[family])
      : Number(model.required?.[family]) > 0 ? Number(model.required[family]) : COURSE_CHECK_REQUIRED_DEFAULTS[family];
    const source = Number(required?.[family]) > 0 ? "custom" : Number(model.required?.[family]) > 0 ? "plan" : "default";
    return { family, required: need, earned: familyEarned[family] || 0, ok: (familyEarned[family] || 0) >= need, source };
  });
  const gradeEarned = semesters.reduce((sum, row) => sum + row.earned, 0) + unplaced;
  const gradeTarget = semesters.reduce((sum, row) => sum + row.target, 0);
  return {
    targetGrade: grade, semesters, groups: groupRows, extras, unplaced,
    grade: { earned: gradeEarned, target: gradeTarget, diff: gradeEarned - gradeTarget },
    cumulative: { before, beforeEstimated, after, earned: before + gradeEarned + after, target: COURSE_CHECK_TOTALS.subjects,
      creative: COURSE_CHECK_TOTALS.creative, total: COURSE_CHECK_TOTALS.total },
    families, futureUnknown, priorUnknown,
    short: semesters.filter((row) => row.diff < 0), over: semesters.filter((row) => row.diff > 0)
  };
}

// "2-1 학기 이수 학점 28/31 (택3 중 2개 선택, 4학점 부족)"
function courseCheckSemesterText(row, { short = false } = {}) {
  const groups = row.groups.filter((group) => group.diff !== 0)
    .map((group) => `${group.label.replace(/^[\d·-]+\s*/, "")} 중 ${group.chosen}개 선택, ${Math.abs(group.diff)}학점 ${group.diff < 0 ? "부족" : "초과"}`);
  const detail = groups.length ? ` (${groups.join(" / ")})` : row.diff ? ` (${Math.abs(row.diff)}학점 ${row.diff < 0 ? "부족" : "초과"})` : "";
  return short ? `${row.label} ${row.earned}/${row.target}${row.diff ? `(${row.diff > 0 ? "+" : ""}${row.diff})` : ""}`
    : `${row.label} 학기 이수 학점 ${row.earned}/${row.target}${detail}`;
}

// ---- 앱 연결 (아래는 화면·저장에 연결한다)
