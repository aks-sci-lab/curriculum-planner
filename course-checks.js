"use strict";
// 위계(선이수)·이수학점 점검.
// 위쪽은 화면·저장과 무관한 순수 계산(테스트가 잘라 쓴다), '앱 연결' 아래는 2~4단계·웹 수강신청 화면 연결이다.
// 편제표는 1단계 데이터(planData: 과목·학기 학점·선택과목군·필수이수 열)를 쓴다. 현 N학년은 N+1학년 과목을 신청한다.

var COURSE_CHECK_FIELDS = ["sem11", "sem12", "sem21", "sem22", "sem31", "sem32"];
// 2022 개정 교육과정 대표 위계(앞 과목 → 뒤 과목). 과목명은 2022 개정 과목 목록에 있는 이름만 쓴다.
// 모든 위계는 학생 화면·결과 검증에서 경고만 한다(저장을 막지 않는다).
// 제2외국어·한문은 같은 언어 안의 일반선택 → 진로선택만 넣는다(예: 일본어 → 일본어 회화·심화 일본어, 한문 → 한문 고전 읽기).
// 문화·융합 과목(○○권 문화, 언어생활과 한자)은 선이수 관계가 확실하지 않아 넣지 않았다(교사가 팝업에서 추가).
var COURSE_CHECK_SECOND_LANGUAGES = ["독일어", "프랑스어", "스페인어", "중국어", "일본어", "러시아어", "아랍어", "베트남어"];
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
  ["지구과학", "지구시스템과학"], ["지구과학", "행성우주과학"],
  ...COURSE_CHECK_SECOND_LANGUAGES.flatMap((language) => [[language, `${language} 회화`], [language, `심화 ${language}`]]),
  ["한문", "한문 고전 읽기"]
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
  // '제2외국어'에 '국어'가 들어 있으므로 외국어·한문·기술·가정·정보·교양을 먼저 본다.
  const byText = /외국어|한문|기술|가정|정보|교양/.test(text) ? 7 : /국어/.test(text) ? 0 : /수학/.test(text) ? 1 : /영어/.test(text) ? 2
    : /한국사|사회|역사|도덕|윤리|지리/.test(text) ? 3 : /과학/.test(text) ? 4 : /체육/.test(text) ? 5
      : /예술|음악|미술|연극/.test(text) ? 6 : -1;
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

// 신청 학년이 아닌 선택과목군(뒤 학년, 그리고 결과가 없으면 이전 학년)의 교과(군) 학점. certain은 earned에 더하고 possible을 돌려준다.
function courseCheckOpenGroupFamilies(model, grade, priorKnown, certain) {
  const possible = {};
  for (const group of model.groups) {
    const fields = group.fields.filter((field) => field.slice(3, 4) !== String(grade) && (field.slice(3, 4) > String(grade) || !priorKnown));
    if (!fields.length) continue;
    const credits = group.pick * group.credit * fields.length;
    const families = [...new Set(group.families.values())];
    if (families.length === 1) certain[families[0]] = (certain[families[0]] || 0) + credits;
    else for (const family of families) possible[family] = (possible[family] || 0) + credits;
  }
  return possible;
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
  // 이번 학년과 뒤 학년의 지정 과목
  for (const field of COURSE_CHECK_FIELDS.filter((item) => item.slice(3, 4) >= grade)) {
    for (const id of model.fields[field].designatedRows) {
      const subject = model.subjects.find((item) => item.id === id);
      familyEarned[subject.family] += subject.designated[field];
    }
  }
  // 아직 모르는 선택(뒤 학년, 결과 없는 이전 학년): 구성 과목이 모두 같은 교과(군)이면 그 학점은 확실하고,
  // 섞여 있으면 그 교과(군)에 들어올 수도 있는 학점(possible)으로만 센다.
  const possible = courseCheckOpenGroupFamilies(model, grade, Boolean(priorKeys), familyEarned);
  const futureUnknown = model.groups.some((group) => group.fields.some((field) => field.slice(3, 4) > grade));
  const priorUnknown = !priorKeys && model.groups.some((group) => group.fields.some((field) => field.slice(3, 4) < grade));
  const families = COURSE_CHECK_FAMILIES.map((family) => {
    const need = Number(required?.[family]) > 0 ? Number(required[family])
      : Number(model.required?.[family]) > 0 ? Number(model.required[family]) : COURSE_CHECK_REQUIRED_DEFAULTS[family];
    const source = Number(required?.[family]) > 0 ? "custom" : Number(model.required?.[family]) > 0 ? "plan" : "default";
    const earned = familyEarned[family] || 0;
    const status = earned >= need ? "ok" : earned + (possible[family] || 0) >= need ? "pending" : "short";
    return { family, required: need, earned, possible: possible[family] || 0, ok: status !== "short", status, source };
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

// 웹 수강신청 이벤트에 싣는 점검 정보(서버 스키마 변경 없이 기존 jsonb에 담는다).
//  · 과목.requires: [{ name, designatedSemester?, options: [이 신청의 과목명], prior?: "elective" }]
//    편제표 이전 학년 지정 과목으로 이미 충족되는 조건은 싣지 않는다. 편제표에 없는 선이수 과목도 싣지 않는다.
//  · 그룹.checks: 학기별 지정·기준 학점, 교과(군) 기준(3년 지정 학점), 3년 누계(앞·뒤 학년 편제표 기준)
// 위계는 경고만 한다. 예전에 실었던 저장 막기 값(checks.blockPrerequisites)은 더 싣지 않고, 남아 있어도 무시한다.
function courseCheckEventPayload(model, rules, { targetGrade, courses = [], required = {} } = {}) {
  const grade = String(targetGrade);
  const baseKey = (course) => courseCheckKey(course.groupSubject || String(course.subject ?? "").replace(/\s*\([12]학기\)\s*$/, ""));
  const earliest = courseCheckFieldIndex(grade, 1);
  const requires = new Map();
  for (const course of courses) {
    const key = baseKey(course);
    const list = [];
    for (const rule of rules || []) {
      if (!rule || rule.off || courseCheckKey(rule.after) !== key) continue;
      const need = courseCheckKey(rule.before);
      const places = model.places.get(need) || [];
      if (places.some((place) => place.kind === "designated" && COURSE_CHECK_FIELDS.indexOf(place.field) < earliest)) continue;
      const designated = places.find((place) => place.kind === "designated" && place.field.slice(3, 4) === grade);
      const options = courses.filter((item) => baseKey(item) === need).map((item) => item.subject);
      const prior = places.some((place) => place.kind === "choice" && COURSE_CHECK_FIELDS.indexOf(place.field) < earliest);
      if (!designated && !options.length && !prior) continue;
      list.push({ name: rule.before, ...(designated ? { designatedSemester: designated.field.slice(4, 5) } : {}), options, ...(prior ? { prior: "elective" } : {}) });
    }
    if (list.length) requires.set(course.subject, list);
  }
  const semesters = {};
  for (const semester of ["1", "2"]) {
    const field = `sem${grade}${semester}`;
    semesters[semester] = { label: courseCheckFieldLabel(field), designated: model.fields[field].designated, target: model.fields[field].target };
  }
  const base = {};
  let before = 0, after = 0;
  for (const field of COURSE_CHECK_FIELDS) {
    for (const id of model.fields[field].designatedRows) {
      const subject = model.subjects.find((item) => item.id === id);
      base[subject.family] = (base[subject.family] || 0) + subject.designated[field];
    }
    if (field.slice(3, 4) < grade) before += model.fields[field].target;
    if (field.slice(3, 4) > grade) after += model.fields[field].target;
  }
  // 앞·뒤 학년 선택과목군: 같은 교과(군)끼리면 확실한 학점(base), 섞여 있으면 들어올 수도 있는 학점(possible).
  const possible = courseCheckOpenGroupFamilies(model, grade, false, base);
  const families = COURSE_CHECK_FAMILIES.map((family) => ({ family,
    required: Number(required?.[family]) > 0 ? Number(required[family]) : Number(model.required?.[family]) > 0 ? Number(model.required[family]) : COURSE_CHECK_REQUIRED_DEFAULTS[family],
    base: base[family] || 0, possible: possible[family] || 0 }));
  return { requires, checks: { v: 1, grade, semesters, families,
    cumulative: { before, after, target: COURSE_CHECK_TOTALS.subjects, creative: COURSE_CHECK_TOTALS.creative, total: COURSE_CHECK_TOTALS.total } } };
}

// 웹 수강신청 학생 화면의 점검(서버가 보낸 이벤트 자료와 지금 고른 과목으로 계산). 규칙·점검 정보가 없는 예전 이벤트는 null.
function courseCheckApplicationState(application, selected = []) {
  const courses = Array.isArray(application?.courses) ? application.courses : [];
  const groups = Array.isArray(application?.groups) ? application.groups : [];
  const checks = groups.find((group) => group?.checks?.v === 1)?.checks || null;
  if (!checks && !courses.some((course) => Array.isArray(course?.requires) && course.requires.length)) return null;
  const grade = String(checks?.grade || (Number(application?.student?.grade) + 1) || "");
  const chosenSet = new Set(selected);
  const chosen = courses.filter((course) => chosenSet.has(course.subject));
  const semesterOf = (course) => ["1", "2"].includes(String(course?.semester)) ? String(course.semester) : "";
  const label = (course) => course.groupSubject || String(course.subject).replace(/\s*\([12]학기\)\s*$/, "");
  const issues = [];
  for (const course of chosen) {
    const semester = semesterOf(course);
    for (const rule of Array.isArray(course.requires) ? course.requires : []) {
      const optionCourses = courses.filter((item) => (rule.options || []).includes(item.subject));
      const picked = optionCourses.filter((item) => chosenSet.has(item.subject));
      const earlierOption = optionCourses.find((item) => semester && semesterOf(item) && semesterOf(item) < semester);
      if (rule.designatedSemester && semester && String(rule.designatedSemester) < semester) continue;
      if (picked.some((item) => semester && semesterOf(item) && semesterOf(item) < semester)) continue;
      let status = "violation", reason = "missing";
      if (!semester) { status = "unknown"; reason = "semester"; }
      else if (picked.some((item) => semesterOf(item) === semester)) reason = "same";
      else if (picked.some((item) => semesterOf(item) > semester)) reason = `later:${grade}-${semesterOf(picked.find((item) => semesterOf(item) > semester))}`;
      else if (rule.designatedSemester) reason = `designated-later:${grade}-${rule.designatedSemester}`;
      else if (rule.prior) { status = "unknown"; reason = "prior"; }
      else if (picked.some((item) => !semesterOf(item))) { status = "unknown"; reason = "semester"; }
      issues.push({ course: label(course), courseSubject: course.subject, requires: rule.name, semester, status, reason,
        offeredEarlier: earlierOption ? `${grade}-${semesterOf(earlierOption)}` : "" });
    }
  }
  const credit = (course) => Number(course?.credit) || 0;
  const groupRows = groups.map((group) => {
    const members = courses.filter((course) => (group.courses || []).includes(course.subject));
    const count = members.filter((course) => chosenSet.has(course.subject)).length;
    const credits = members.map(credit);
    const typical = credits.sort((a, b) => credits.filter((value) => value === b).length - credits.filter((value) => value === a).length)[0] || 0;
    const semester = ["1", "2"].includes(String(group.semester)) ? String(group.semester) : "";
    return { id: group.id, name: group.name, semester, pick: Number(group.count) || 0, chosen: count, credit: typical,
      diff: (count - (Number(group.count) || 0)) * typical };
  });
  const semesters = checks ? ["1", "2"].map((semester) => {
    const plan = checks.semesters?.[semester] || { label: `${grade}-${semester}`, designated: 0, target: 0 };
    const earned = (Number(plan.designated) || 0) + chosen.filter((course) => semesterOf(course) === semester).reduce((sum, course) => sum + credit(course), 0);
    const rows = groupRows.filter((row) => row.semester === semester);
    return { semester, label: plan.label, designated: Number(plan.designated) || 0, target: Number(plan.target) || 0, earned,
      diff: earned - (Number(plan.target) || 0), groups: rows.map((row) => ({ ...row, label: row.name })) };
  }).filter((row) => row.target > 0 || row.earned > 0) : [];
  const unplaced = chosen.filter((course) => !semesterOf(course)).reduce((sum, course) => sum + credit(course), 0);
  const families = (checks?.families || []).map((family) => {
    const earned = (Number(family.base) || 0) + chosen.filter((course) => courseCheckFamily(course.area, label(course)) === family.family)
      .reduce((sum, course) => sum + credit(course), 0);
    const need = Number(family.required) || 0;
    const status = earned >= need ? "ok" : earned + (Number(family.possible) || 0) >= need ? "pending" : "short";
    return { family: family.family, required: need, earned, possible: Number(family.possible) || 0, ok: status !== "short", status };
  });
  const thisGrade = semesters.reduce((sum, row) => sum + row.earned, 0) + unplaced;
  const cumulative = checks ? { earned: (Number(checks.cumulative?.before) || 0) + thisGrade + (Number(checks.cumulative?.after) || 0),
    target: Number(checks.cumulative?.target) || COURSE_CHECK_TOTALS.subjects, creative: Number(checks.cumulative?.creative) || COURSE_CHECK_TOTALS.creative,
    total: Number(checks.cumulative?.total) || COURSE_CHECK_TOTALS.total } : null;
  return { grade, checks, issues, violations: issues.filter((issue) => issue.status === "violation"),
    unknowns: issues.filter((issue) => issue.status === "unknown"), semesters, groups: groupRows, unplaced, families, cumulative };
}

// ---- 앱 연결 (아래는 화면·저장에 연결한다)

// 설정(state.courseChecks): 기본 위계 중 삭제·끔, 추가 위계, 교과(군) 필수 학점 수정값, 입학연도별 이전 학년 이수 결과.
// 예전 저장분의 '저장 막기'(blockPrerequisites)는 버린다(위계는 경고만).
function courseCheckNormalizeSettings(value) {
  const object = (item) => Boolean(item) && typeof item === "object" && !Array.isArray(item);
  const source = object(value) ? value : {};
  const strings = (list) => Array.isArray(list) ? [...new Set(list.filter((item) => typeof item === "string" && item && item.length < 400))] : [];
  const text = (item) => String(item ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const custom = [];
  for (const rule of Array.isArray(source.custom) ? source.custom : []) {
    if (!object(rule) || !text(rule.before) || !text(rule.after)) continue;
    const key = courseCheckRuleKey(rule.before, rule.after);
    if (courseCheckKey(rule.before) === courseCheckKey(rule.after) || custom.some((item) => courseCheckRuleKey(item.before, item.after) === key)) continue;
    custom.push({ before: text(rule.before), after: text(rule.after) });
  }
  const required = {};
  for (const [family, number] of Object.entries(object(source.required) ? source.required : {})) {
    if (COURSE_CHECK_FAMILIES.includes(family) && number !== "" && number !== null && Number(number) >= 0 && Number(number) <= 200) required[family] = Number(number);
  }
  const prior = {};
  for (const [year, entry] of Object.entries(object(source.prior) ? source.prior : {})) {
    if (!/^\d{4}$/.test(year) || !object(entry) || !Array.isArray(entry.students)) continue;
    prior[year] = {
      fileName: text(entry.fileName), uploadedAt: text(entry.uploadedAt),
      students: entry.students.filter(object).map((student) => ({
        grade: text(student.grade), classroom: text(student.classroom), number: text(student.number), name: text(student.name),
        subjects: strings(student.subjects).map(text)
      }))
    };
  }
  return { removed: strings(source.removed), off: strings(source.off), custom, required, prior };
}

let courseCheckContextCache = null;
const courseCheckModelCache = new WeakMap();

function courseCheckLayout(year) {
  if (typeof state === "undefined") return null;
  const cohortLayout = state.curriculumCohorts?.[year]?.importedLayout;
  const layout = cohortLayout || (state.curriculumPlanType !== "annual" && String(state.curriculumCohortYear) === String(year) ? state.curriculumImportedLayout : null);
  if (!layout) return null;
  const data = typeof curriculumLayoutData === "function" ? curriculumLayoutData(layout) : layout;
  return data?.planData ? data : null;
}

function courseCheckModel(year) {
  const layout = courseCheckLayout(year);
  if (!layout) return null;
  const key = layout.planData;
  if (!courseCheckModelCache.has(key)) courseCheckModelCache.set(key, courseCheckPlanModel(key));
  return courseCheckModelCache.get(key);
}

function courseCheckCohortYear(currentGrade) {
  return typeof getApplicationCohortYear === "function" ? String(getApplicationCohortYear(String(currentGrade))) : "";
}

// 화면 한 번 그리는 동안 쓰는 점검 문맥(설정·규칙·편제표 모델). 설정 객체나 편제표가 바뀌면 다시 만든다.
function courseCheckContext() {
  const raw = typeof state !== "undefined" ? state.courseChecks : null;
  const years = typeof state !== "undefined" ? Object.keys(state.curriculumCohorts || {}).sort() : [];
  const models = years.map((year) => courseCheckModel(year));
  const students = typeof state !== "undefined" ? state.students : null;
  if (courseCheckContextCache && courseCheckContextCache.raw === raw && courseCheckContextCache.students === students &&
      courseCheckContextCache.schoolYear === courseCheckCohortYear("1") && courseCheckContextCache.models.length === models.length &&
      courseCheckContextCache.models.every((model, index) => model === models[index])) return courseCheckContextCache;
  const settings = courseCheckNormalizeSettings(raw);
  const defaults = courseCheckApplicableDefaults(models.filter(Boolean)).filter((rule) => !settings.removed.includes(rule.key));
  const rules = [...defaults];
  for (const rule of settings.custom) {
    const key = courseCheckRuleKey(rule.before, rule.after);
    if (!rules.some((item) => item.key === key)) rules.push({ key, before: rule.before, after: rule.after, source: "custom" });
  }
  for (const rule of rules) rule.off = settings.off.includes(rule.key);
  courseCheckContextCache = { raw, students, schoolYear: courseCheckCohortYear("1"), models, settings, rules,
    active: rules.filter((rule) => !rule.off), priorIndexes: new Map(), reports: new WeakMap() };
  return courseCheckContextCache;
}

function courseCheckSaveSettings(mutate) {
  const next = courseCheckNormalizeSettings(typeof state !== "undefined" ? JSON.parse(JSON.stringify(state.courseChecks || {})) : {});
  mutate(next);
  state.courseChecks = courseCheckNormalizeSettings(next);
  courseCheckContextCache = null;
}

// 이전 학년 이수 결과에서 학생 찾기: 파일의 학년이 현재 학년이면 반·번호(+이름), 지난해 학년이면 이름(동명이인 없을 때)으로 찾는다.
function courseCheckPriorIndex(context, year, currentGrade) {
  const cacheKey = `${year}:${currentGrade}`;
  if (context.priorIndexes.has(cacheKey)) return context.priorIndexes.get(cacheKey);
  const entry = context.settings.prior[year];
  let index = null;
  if (entry) {
    const seats = new Map(), names = new Map();
    const seat = (student) => `${Number(student.classroom) || student.classroom}-${Number(student.number) || student.number}`;
    for (const student of entry.students) {
      if (String(Number(student.grade)) === String(currentGrade)) seats.set(seat(student), student);
      const list = names.get(student.name) || [];
      list.push(student);
      names.set(student.name, list);
    }
    index = { entry, find(student) {
      const bySeat = seats.get(seat(student));
      if (bySeat && (!bySeat.name || bySeat.name === student.name)) return bySeat.subjects;
      const sameName = (names.get(student.name) || []).filter((item) => String(Number(item.grade)) !== String(currentGrade));
      return sameName.length === 1 ? sameName[0].subjects : null;
    } };
  }
  context.priorIndexes.set(cacheKey, index);
  return index;
}

// 결과 과목의 학기: 2단계 그룹 배정 → 과목명의 (n학기) → 편제표에서 그 학년에 한 학기만 있으면 그 학기.
function courseCheckSelectionSemester(selection, currentGrade, model) {
  const assigned = String(selection?.applicationGroups?.[currentGrade]?.semester ?? "");
  if (assigned === "1" || assigned === "2") return assigned;
  const named = typeof resultCourseSemester === "function" ? resultCourseSemester(selection) : String(selection?.name || "").match(/([12])\s*학기/)?.[1] || "";
  if (named) return named;
  const target = String(Number(currentGrade) + 1);
  const semesters = new Set((model?.places?.get(courseCheckKey(selection?.name)) || [])
    .filter((place) => place.field.slice(3, 4) === target).map((place) => place.field.slice(4, 5)));
  return semesters.size === 1 ? [...semesters][0] : "";
}

// 결과 학생 한 명의 점검. exclude: 빼고 볼 과목명(폐강 과목).
function courseCheckStudentReport(student, context = courseCheckContext(), { exclude = null } = {}) {
  if (!student) return null;
  if (!exclude && context.reports.has(student)) return context.reports.get(student);
  const grade = String(student.grade);
  const year = courseCheckCohortYear(grade);
  const model = year ? courseCheckModel(year) : null;
  let report = null;
  if (model && ["1", "2"].includes(grade)) {
    const targetGrade = String(Number(grade) + 1);
    const removed = exclude ? new Set(exclude.map(courseCheckKey)) : null;
    const selections = (student.selections || []).filter((item) => !removed || !removed.has(courseCheckKey(item.name)))
      .map((item) => ({ name: item.name, semester: courseCheckSelectionSemester(item, grade, model), credit: item.credits, area: item.applicationSubject?.area || "" }));
    const prior = courseCheckPriorIndex(context, year, grade)?.find(student) || null;
    report = {
      year, targetGrade, model, priorFound: Boolean(prior),
      prerequisites: courseCheckPrerequisites(model, context.active, { targetGrade, selections, prior }),
      credits: courseCheckCredits(model, { targetGrade, selections, prior, required: context.settings.required })
    };
  }
  if (!exclude) context.reports.set(student, report);
  return report;
}

function courseCheckSeat(student) {
  return `${student.classroom}-${student.number} ${student.name}`;
}

function courseCheckEscape(value) {
  return typeof escapeHtml === "function" ? escapeHtml(value) : String(value ?? "").replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function courseCheckCountText(map) {
  return [...map].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}명`).join(", ");
}

function courseCheckList(items, limit = 5) {
  return items.slice(0, limit).join(", ") + (items.length > limit ? ` 외 ${items.length - limit}명` : "");
}

// 학생 묶음 요약(2단계 결과 검증·대화상자·4단계 요약이 함께 쓴다).
function courseCheckSummary(students, context = courseCheckContext()) {
  const summary = { checked: 0, noPlan: 0, violators: [], unknowns: [], short: [], over: [], familyShort: [], byCourse: new Map(), unknownByCourse: new Map(), priorMissing: 0, priorAvailable: false };
  for (const student of students) {
    if (!(student.selections || []).length) continue;
    const report = courseCheckStudentReport(student, context);
    if (!report) { summary.noPlan++; continue; }
    summary.checked++;
    if (courseCheckPriorIndex(context, report.year, String(student.grade))) {
      summary.priorAvailable = true;
      if (!report.priorFound) summary.priorMissing++;
    }
    const { violations, unknowns } = report.prerequisites;
    if (violations.length) {
      summary.violators.push({ student, report });
      for (const course of new Set(violations.map((issue) => issue.course))) summary.byCourse.set(course, (summary.byCourse.get(course) || 0) + 1);
    }
    if (unknowns.length) {
      summary.unknowns.push({ student, report });
      for (const course of new Set(unknowns.map((issue) => issue.course))) summary.unknownByCourse.set(course, (summary.unknownByCourse.get(course) || 0) + 1);
    }
    if (report.credits.short.length) summary.short.push({ student, report });
    if (report.credits.over.length) summary.over.push({ student, report });
    if (report.credits.families.some((family) => !family.ok)) summary.familyShort.push({ student, report });
  }
  return summary;
}

function courseCheckViolationBrief(report) {
  return report.prerequisites.violations.map((issue) => `${issue.course}(${issue.requires} ${issue.reason === "same" ? "같은 학기" : issue.reason === "missing" ? "미이수" : "뒤 학기"})`).join("·");
}

function courseCheckCreditBrief(report) {
  return [...report.credits.short, ...report.credits.over].map((row) => courseCheckSemesterText(row, { short: true })).join("·");
}

// 2단계 결과 검증 미리보기에 붙이는 경고·참고와 학생 목록.
function courseCheckResultIssues(students, { grade } = {}) {
  const result = { warnings: [], info: [], html: "" };
  const context = courseCheckContext();
  const year = courseCheckCohortYear(grade);
  if (!courseCheckModel(year)) {
    result.info.push(`${year}학년도 입학생 편제표 데이터가 없어 위계·이수학점 점검을 건너뛰었습니다.`);
    return result;
  }
  const summary = courseCheckSummary(students, context);
  if (!summary.checked) return result;
  const target = `${Number(grade) + 1}학년 과목`;
  if (summary.violators.length) {
    result.warnings.push(`위계(선이수) 미충족 학생 ${summary.violators.length}명 · 과목별 ${courseCheckCountText(summary.byCourse)}: ${courseCheckList(summary.violators.map(({ student, report }) => `${courseCheckSeat(student)} ${courseCheckViolationBrief(report)}`), 3)}.`);
  }
  const credit = [...new Set([...summary.short, ...summary.over].map((item) => item.student))];
  if (credit.length) {
    const lookup = new Map([...summary.short, ...summary.over].map((item) => [item.student, item.report]));
    result.warnings.push(`${target} 학기 이수 학점이 편제표 기준(이수학점 소계)과 다른 학생 ${credit.length}명(부족 ${summary.short.length}명·초과 ${summary.over.length}명): ${courseCheckList(credit.map((student) => `${courseCheckSeat(student)} ${courseCheckCreditBrief(lookup.get(student))}`), 3)}.`);
  }
  if (summary.familyShort.length) {
    result.warnings.push(`교과(군) 필수 이수 학점 미달 학생 ${summary.familyShort.length}명: ${courseCheckList(summary.familyShort.map(({ student, report }) => `${courseCheckSeat(student)} ${report.credits.families.filter((family) => !family.ok).map((family) => `${family.family} ${family.earned}/${family.required}`).join("·")}`), 3)}.`);
  }
  if (summary.unknowns.length) {
    result.info.push(`위계 확인 불가 학생 ${summary.unknowns.length}명(이전 학년 이수 결과가 없어 판단하지 않음 · 과목별 ${courseCheckCountText(summary.unknownByCourse)}). '위계·학점 점검'에서 이전 학년 이수 결과를 올리면 판단합니다.`);
  }
  if (summary.priorAvailable && summary.priorMissing) result.info.push(`이전 학년 이수 결과에서 찾지 못한 학생 ${summary.priorMissing}명은 확인 불가로 둡니다.`);
  if (!summary.violators.length && !credit.length && !summary.familyShort.length) {
    result.info.push(`위계·이수학점 점검: ${summary.checked}명 모두 이상 없음${summary.unknowns.length ? "(확인 불가 제외)" : ""}.`);
  }
  result.html = courseCheckStudentTableHtml(summary, { grade });
  return result;
}

function courseCheckStudentTableHtml(summary, { grade = "", limit = 400 } = {}) {
  const rows = new Map();
  const add = (item) => { if (!rows.has(item.student)) rows.set(item.student, item); };
  [summary.violators, summary.short, summary.over, summary.familyShort, summary.unknowns].forEach((list) => list.forEach(add));
  if (!rows.size) return "";
  const list = [...rows.values()].sort((a, b) => Number(a.student.classroom) - Number(b.student.classroom) || Number(a.student.number) - Number(b.student.number));
  const esc = courseCheckEscape;
  const body = list.slice(0, limit).map(({ student, report }) => {
    const issues = [...report.prerequisites.violations, ...report.prerequisites.unknowns].map((issue) =>
      `<li class="${issue.status === "violation" ? "is-violation" : "is-unknown"}">${esc(issue.status === "violation" ? "" : "확인 불가 · ")}${esc(courseCheckIssueText(issue))}</li>`);
    const credits = [...report.credits.short, ...report.credits.over].map((row) => `<li class="is-credit">${esc(courseCheckSemesterText(row))}</li>`);
    const families = report.credits.families.filter((family) => !family.ok).map((family) => `<li class="is-credit">${esc(`${family.family} 필수 이수 ${family.earned}/${family.required}학점`)}</li>`);
    return `<tr><th scope="row">${esc(`현 ${student.grade}학년 ${courseCheckSeat(student)}`)}</th><td><ul>${[...issues, ...credits, ...families].join("")}</ul></td></tr>`;
  }).join("");
  return `<details class="course-check-details"${summary.violators.length ? " open" : ""}><summary>위계·이수학점 점검 학생 ${rows.size}명${grade ? ` (현 ${esc(grade)}학년 → ${Number(grade) + 1}학년 과목)` : ""} · 위계 미충족 ${summary.violators.length} · 학점 부족 ${summary.short.length} · 초과 ${summary.over.length} · 확인 불가 ${summary.unknowns.length}</summary>
    <div class="aggregate-sheet-wrap"><table class="course-check-table"><thead><tr><th scope="col">학생</th><th scope="col">점검 내용</th></tr></thead><tbody>${body}</tbody></table></div>
    ${list.length > limit ? `<p class="note">앞 ${limit}명만 표시했습니다.</p>` : ""}</details>`;
}

// 3단계 확인서 아래 점검란(두 줄, 인쇄 한 장 유지).
function courseCheckCertificateHtml(student, context = courseCheckContext()) {
  const report = courseCheckStudentReport(student, context);
  if (!report || !(student.selections || []).length) return "";
  const esc = courseCheckEscape;
  const credits = report.credits;
  const semesters = credits.semesters.map((row) => `${row.label} ${row.earned}/${row.target}`).join(" · ");
  const cumulative = `3년 누계 ${credits.cumulative.earned}/${credits.cumulative.target}${credits.cumulative.beforeEstimated || credits.cumulative.after ? "(편제표 기준 포함)" : ""}`;
  const creditNote = credits.short.length || credits.over.length ? ` — ${[...credits.short, ...credits.over].map((row) => `${row.label} ${Math.abs(row.diff)}학점 ${row.diff < 0 ? "부족" : "초과"}`).join(", ")}` : "";
  const { violations, unknowns } = report.prerequisites;
  const prereq = violations.length
    ? `확인 필요 — ${violations.map((issue) => `${issue.course}: ${issue.requires} ${issue.reason === "same" ? "같은 학기 선택" : issue.reason === "missing" ? "미이수" : "뒤 학기"}`).join(", ")}`
    : unknowns.length ? `이상 없음(이전 학년 이수 확인 필요: ${[...new Set(unknowns.map((issue) => issue.course))].join(", ")})` : "이상 없음";
  return `<div class="paper-checks${violations.length || creditNote ? " has-issue" : ""}"><p><b>이수 학점</b> ${esc(`학기별 ${semesters} · ${cumulative}${creditNote}`)}</p><p><b>위계 점검</b> ${esc(prereq)}</p></div>`;
}

// 4단계 재신청 대상자 엑셀의 '폐강 후 부족 학점'.
function courseCheckRetakeShortfall(student, closedCourses) {
  const report = courseCheckStudentReport(student, courseCheckContext(), { exclude: closedCourses });
  if (!report) return "";
  const short = report.credits.semesters.filter((row) => row.diff < 0);
  return short.length ? short.map((row) => `${row.label} ${-row.diff}학점(${row.earned}/${row.target})`).join(", ") : "없음";
}

// 4단계 학년 머리줄 요약.
function courseCheckAggregateNote(grade) {
  if (typeof state === "undefined") return "";
  const students = (state.students || []).filter((student) => String(student.grade) === String(grade));
  if (!students.length || !courseCheckModel(courseCheckCohortYear(grade))) return "";
  const summary = courseCheckSummary(students);
  if (!summary.checked) return "";
  const parts = [`위계 미충족 ${summary.violators.length}명`, `학기 학점 부족 ${summary.short.length}명`];
  if (summary.unknowns.length) parts.push(`위계 확인 불가 ${summary.unknowns.length}명`);
  return `<button type="button" class="aggregate-check-note${summary.violators.length || summary.short.length ? " has-issue" : ""}" data-open-dialog="courseCheckDialog" title="위계·이수학점 점검 결과 보기">${courseCheckEscape(parts.join(" · "))}</button>`;
}

// ---- 웹 수강신청 연결

// 수강신청 생성·학생 화면 미리보기: 신청 설정(subjects·groups)에 점검 정보를 싣는다.
function courseCheckAttachToSetup(setup) {
  if (!setup || typeof setup !== "object") return setup;
  const context = courseCheckContext();
  for (const [targetGrade, courses] of Object.entries(setup.subjects || {})) {
    if (!["2", "3"].includes(targetGrade) || !Array.isArray(courses) || !courses.length) continue;
    const model = courseCheckModel(courseCheckCohortYear(String(Number(targetGrade) - 1)));
    if (!model) continue;
    const payload = courseCheckEventPayload(model, context.active, { targetGrade, courses, required: context.settings.required });
    for (const course of courses) {
      const requires = payload.requires.get(course.subject);
      if (requires?.length) course.requires = requires;
      else delete course.requires;
    }
    for (const group of setup.groups || []) if (String(group.grade) === targetGrade) group.checks = payload.checks;
  }
  return setup;
}

let courseCheckStudentApp = null;

function courseCheckStudentSelected() {
  return [...document.querySelectorAll("#cloudStudentChoices input:checked")].map((box) => box.value);
}

// 학생 화면을 그린 뒤(renderStudentApplication) 한 번 부른다.
function courseCheckStudentRender(application, { preview = false } = {}) {
  courseCheckStudentApp = application ? { application, preview } : null;
  courseCheckStudentUpdate();
}

// 과목을 고를 때마다(updateSummary) 점검표와 과목 옆 경고를 다시 그린다.
function courseCheckStudentUpdate() {
  const panel = document.getElementById("courseCheckStudentPanel");
  if (!panel) return;
  document.querySelectorAll("#cloudStudentChoices .course-check-flag").forEach((flag) => flag.remove());
  const result = courseCheckStudentApp ? courseCheckApplicationState(courseCheckStudentApp.application, courseCheckStudentSelected()) : null;
  if (!result) {
    panel.replaceChildren();
    panel.classList.add("hidden");
    return;
  }
  const esc = courseCheckEscape;
  for (const issue of result.issues) {
    const box = [...document.querySelectorAll("#cloudStudentChoices input")].find((input) => input.value === issue.courseSubject);
    if (!box || box.closest("label")?.querySelector(`.course-check-flag[data-requires="${CSS.escape(issue.requires)}"]`)) continue;
    const flag = document.createElement("span");
    flag.className = `course-check-flag ${issue.status === "violation" ? "is-violation" : "is-unknown"}`;
    flag.dataset.requires = issue.requires;
    flag.textContent = issue.status === "violation" ? `선이수 필요: ${issue.requires}` : `확인: ${issue.requires} 이수`;
    box.closest("label")?.appendChild(flag);
  }
  const semesterRows = result.semesters.map((row) => {
    const percent = row.target ? Math.min(100, Math.round(row.earned / row.target * 100)) : 0;
    const state = row.diff === 0 ? "ok" : row.diff < 0 ? "short" : "over";
    return `<li class="course-check-semester" data-state="${state}"><div><strong>${esc(row.label)}</strong><span>${esc(courseCheckSemesterText(row).replace(/^\S+\s/, ""))}</span></div>
      <span class="student-summary-track" role="progressbar" aria-label="${esc(row.label)} 학기 이수 학점" aria-valuemin="0" aria-valuemax="${row.target}" aria-valuenow="${row.earned}"><span style="width:${percent}%"></span></span></li>`;
  }).join("");
  const groupRows = result.groups.filter((group) => group.pick > 0).map((group) => {
    const left = group.pick - group.chosen;
    return `<li data-state="${left === 0 ? "ok" : left > 0 ? "short" : "over"}">${esc(`${group.semester ? `${result.grade}-${group.semester} ` : ""}${group.name.replace(/^\d-\d\s*/, "")}`)} <b>${group.chosen}/${group.pick}</b>${left > 0 ? ` · ${left}개 더` : left < 0 ? ` · ${-left}개 초과` : " ✓"}</li>`;
  }).join("");
  const issueRows = [...result.violations, ...result.unknowns].map((issue) =>
    `<li class="${issue.status === "violation" ? "is-violation" : "is-unknown"}">${esc(courseCheckIssueText(issue, { student: true }))}</li>`).join("");
  const familyRows = result.families.map((family) => `<tr data-state="${family.status}"><th scope="row">${esc(family.family)}</th><td>${family.earned}/${family.required}</td><td>${family.status === "ok" ? "충족" : family.status === "pending" ? "다른 학년 선택에 따라 충족 가능" : "부족"}</td></tr>`).join("");
  const familyShort = result.families.filter((family) => !family.ok).length;
  panel.innerHTML = `<h3>이수 점검 <small>저장 전 확인</small></h3>
    ${semesterRows ? `<ul class="course-check-semesters">${semesterRows}</ul>` : ""}
    ${groupRows ? `<ul class="course-check-groups" aria-label="선택 그룹별 남은 선택 수">${groupRows}</ul>` : ""}
    ${issueRows ? `<ul class="course-check-issues" role="alert">${issueRows}</ul>` : `<p class="course-check-ok">위계(선이수) 점검: 이상 없음</p>`}
    ${result.violations.length ? `<p class="course-check-warn-note">위계(선이수) 경고는 확인용입니다. 그대로 저장할 수 있으니 담당 선생님과 상의하세요.</p>` : ""}
    ${result.cumulative ? `<p class="course-check-total">3년 누계(앞·뒤 학년은 편제표 기준) <b>${result.cumulative.earned}/${result.cumulative.target}학점</b> · 창의적 체험활동 ${result.cumulative.creative}학점 포함 총 ${result.cumulative.earned + result.cumulative.creative}/${result.cumulative.total}</p>` : ""}
    ${familyRows ? `<details class="course-check-families"${familyShort ? " open" : ""}><summary>교과(군) 필수 이수 학점 ${familyShort ? `· 부족 ${familyShort}개` : "· 모두 충족"}</summary>
      <table><thead><tr><th scope="col">교과(군)</th><th scope="col">이수/필수</th><th scope="col">상태</th></tr></thead><tbody>${familyRows}</tbody></table>
      <p class="note">3년 지정 과목, 같은 교과(군)끼리 묶인 다른 학년 선택과목군, 지금 고른 과목으로 계산합니다.</p></details>` : ""}`;
  panel.classList.remove("hidden");
}

// 신청 저장 뒤 안내에 덧붙일 위계 경고(저장은 막지 않는다). 예전 이벤트의 막기 값·서버 표시가 있어도 경고만 한다.
function courseCheckStudentSaveNote(selected) {
  if (!courseCheckStudentApp) return "";
  const result = courseCheckApplicationState(courseCheckStudentApp.application, selected);
  const count = result?.violations.length || 0;
  return count ? ` 위계(선이수) 경고 ${count}건이 있는 채로 저장했습니다(${courseCheckIssueText(result.violations[0], { student: true })}). 담당 선생님과 확인하세요.` : "";
}

// ---- 2단계 '위계·학점 점검' 팝업

function courseCheckSubjectOptions(context) {
  const names = new Map();
  for (const model of context.models.filter(Boolean)) {
    for (const [key, places] of model.places) {
      if (!names.has(key)) names.set(key, { key, name: places[0].name, family: places[0].family });
    }
  }
  return [...names.values()].sort((a, b) => COURSE_CHECK_FAMILIES.indexOf(a.family) - COURSE_CHECK_FAMILIES.indexOf(b.family) ||
    a.name.localeCompare(b.name, "ko"));
}

// 규칙 팝업의 묶음: 뒤 과목(없으면 앞 과목)의 교과로 나눈다. 제2외국어·한문은 따로 묶는다.
var COURSE_CHECK_RULE_GROUPS = ["수학", "영어", "과학", "제2외국어·한문", "기타"];
function courseCheckRuleGroup(rule) {
  for (const name of [rule?.after, rule?.before]) {
    const official = typeof findCurriculumOfficialSubject === "function" ? findCurriculumOfficialSubject(name) : null;
    const area = String(official?.area || "");
    if (/제2외국어|한문/.test(area)) return "제2외국어·한문";
    if (/정보/.test(area)) return "기타";
    if (/수학/.test(area)) return "수학";
    if (/영어/.test(area)) return "영어";
    if (/과학/.test(area)) return "과학";
  }
  return "기타";
}

function courseCheckRefreshViews() {
  courseCheckContextCache = null;
  if (typeof renderPreview === "function" && typeof state !== "undefined" && state.workflowStep === 3) renderPreview();
  if (typeof renderAggregate === "function" && typeof state !== "undefined" && state.workflowStep === 4) renderAggregate();
}

function courseCheckRenderDialog() {
  const body = document.getElementById("courseCheckDialogBody");
  if (!body || typeof state === "undefined") return;
  courseCheckContextCache = null;
  const context = courseCheckContext();
  const esc = courseCheckEscape;
  const options = courseCheckSubjectOptions(context);
  const optionHtml = options.map((item) => `<option value="${esc(item.name)}">${esc(item.name)} (${esc(item.family)})</option>`).join("");
  const ruleRow = (rule) => `<tr${rule.off ? ' class="is-off"' : ""}><td>${esc(rule.before)}</td><td aria-hidden="true">→</td><td>${esc(rule.after)}</td>
      <td>${rule.source === "default" ? "기본" : "추가"}</td>
      <td><label class="course-check-switch"><input type="checkbox" data-cc-rule-toggle="${esc(rule.key)}"${rule.off ? "" : " checked"}> 사용</label></td>
      <td><button class="button button-quiet" type="button" data-cc-rule-delete="${esc(rule.key)}" aria-label="${esc(`${rule.before} → ${rule.after} 위계 삭제`)}">삭제</button></td></tr>`;
  const ruleGroups = new Map(COURSE_CHECK_RULE_GROUPS.map((name) => [name, []]));
  for (const rule of context.rules) ruleGroups.get(courseCheckRuleGroup(rule)).push(rule);
  const ruleRows = [...ruleGroups].filter(([, rules]) => rules.length).map(([name, rules]) =>
    `<tr class="course-check-rule-group"><th scope="colgroup" colspan="6">${esc(name)} <small>${rules.length}개</small></th></tr>${rules.map(ruleRow).join("")}`).join("");
  const grade = String(state.applicationMenuGrade || "1");
  const year = courseCheckCohortYear(grade);
  const model = courseCheckModel(year);
  const prior = context.settings.prior[year];
  const requiredRows = COURSE_CHECK_FAMILIES.map((family) => {
    const plan = model?.required?.[family];
    const custom = context.settings.required[family];
    return `<tr><th scope="row">${esc(family)}</th><td>${plan ? `${plan}` : "—"}</td><td>${COURSE_CHECK_REQUIRED_DEFAULTS[family]}</td>
      <td><input type="number" min="0" max="200" step="1" data-cc-required="${esc(family)}" value="${custom ?? ""}" placeholder="${plan || COURSE_CHECK_REQUIRED_DEFAULTS[family]}" aria-label="${esc(family)} 필수 이수 학점"></td></tr>`;
  }).join("");
  const results = ["1", "2"].map((currentGrade) => {
    const students = (state.students || []).filter((student) => String(student.grade) === currentGrade);
    if (!students.length) return "";
    if (!courseCheckModel(courseCheckCohortYear(currentGrade))) return `<p class="note">현 ${currentGrade}학년: ${esc(courseCheckCohortYear(currentGrade))}학년도 입학생 편제표가 없어 점검할 수 없습니다.</p>`;
    const summary = courseCheckSummary(students, context);
    return `<p class="course-check-result-line"><b>현 ${currentGrade}학년 → ${Number(currentGrade) + 1}학년 과목</b> ${summary.checked}명 점검 · 위계 미충족 ${summary.violators.length}명 · 학기 학점 부족 ${summary.short.length}명 · 초과 ${summary.over.length}명 · 교과(군) 미달 ${summary.familyShort.length}명 · 확인 불가 ${summary.unknowns.length}명</p>
      ${courseCheckStudentTableHtml(summary, { grade: currentGrade })}`;
  }).join("");
  body.innerHTML = `
    <section class="course-check-section" aria-labelledby="courseCheckRulesTitle">
      <h3 id="courseCheckRulesTitle">위계(선이수) 규칙</h3>
      <p class="note">'앞 과목 → 뒤 과목': 뒤 과목을 들으려면 앞 과목을 이전 학기까지 이수해야 합니다. 기본 규칙은 2022 개정 교육과정 대표 위계 중 편제표에 있는 과목만 보입니다. 이수 근거: 편제표 이전 학기 지정 과목, 같은 신청의 앞 학기 선택(같은 학기 불인정), 이전 학년 이수 결과.</p>
      <div class="aggregate-sheet-wrap"><table class="course-check-rule-table"><thead><tr><th scope="col">앞 과목</th><th scope="col"><span class="sr-only">순서</span></th><th scope="col">뒤 과목</th><th scope="col">구분</th><th scope="col">사용</th><th scope="col">삭제</th></tr></thead>
        <tbody>${ruleRows || '<tr><td colspan="6">규칙이 없습니다. 아래에서 추가하세요.</td></tr>'}</tbody></table></div>
      <div class="course-check-add">
        <label>앞 과목 <select id="courseCheckRuleBefore"><option value="">선택</option>${optionHtml}</select></label>
        <span aria-hidden="true">→</span>
        <label>뒤 과목 <select id="courseCheckRuleAfter"><option value="">선택</option>${optionHtml}</select></label>
        <button class="button" type="button" id="courseCheckAddRule">규칙 추가</button>
        <button class="button button-quiet" type="button" id="courseCheckRestoreRules">기본 규칙 되돌리기</button>
      </div>
      ${options.length ? "" : '<p class="note">1단계에서 입학연도별 편제표를 먼저 올리면 과목을 고를 수 있습니다.</p>'}
    </section>
    <section class="course-check-section" aria-labelledby="courseCheckOnlineTitle">
      <h3 id="courseCheckOnlineTitle">웹 수강신청</h3>
      <p class="note">위계(선이수)는 모든 과목에서 <b>경고만</b> 합니다. 학생 화면에 점검표와 과목 옆 경고를 보여 주고, 위계를 지키지 않아도 신청은 저장됩니다. 서버는 위계를 검사하지 않습니다.</p>
    </section>
    <section class="course-check-section" aria-labelledby="courseCheckPriorTitle">
      <h3 id="courseCheckPriorTitle">이전 학년 이수 결과 (현 ${esc(grade)}학년 · ${esc(year)}학년도 입학생, 선택)</h3>
      <p class="note">이전 학년에 고른 선택 과목을 알아야 판단할 수 있는 위계(예: 3학년 물질과 에너지 ← 2학년 화학)는 이 자료가 없으면 '확인 불가'로 둡니다. 2단계 결과 엑셀과 같은 형식(학년·반·번호·성명 + 과목 열, 또는 차수·학년·반·번호·성명·선택과목)을 올리세요. 학년이 현재 학년이면 반·번호로, 지난해 학년이면 이름으로 학생을 찾습니다.</p>
      <p id="courseCheckPriorStatus" role="status">${prior ? esc(`${prior.fileName || "이전 학년 결과"} · ${prior.students.length}명${prior.uploadedAt ? ` · ${prior.uploadedAt}` : ""}`) : "올린 자료 없음"}</p>
      <label class="file-button" for="courseCheckPriorInput" tabindex="0" role="button">이전 학년 이수 결과 엑셀 선택</label>
      <input class="hidden" id="courseCheckPriorInput" type="file" accept=".xlsx">
      ${prior ? '<button class="button button-quiet" type="button" id="courseCheckPriorDelete">이전 학년 자료 삭제</button>' : ""}
    </section>
    <section class="course-check-section" aria-labelledby="courseCheckRequiredTitle">
      <h3 id="courseCheckRequiredTitle">교과(군) 필수 이수 학점 (현 ${esc(grade)}학년 · ${esc(year)}학년도 입학생 편제표)</h3>
      <p class="note">편제표 '필수이수' 열 값을 먼저 쓰고, 비어 있으면 2022 개정 기준을 씁니다. 다르게 볼 값만 입력하세요(비우면 원래 값). 총 이수 학점 기준: 교과 ${COURSE_CHECK_TOTALS.subjects} + 창의적 체험활동 ${COURSE_CHECK_TOTALS.creative} = ${COURSE_CHECK_TOTALS.total}학점.</p>
      <div class="aggregate-sheet-wrap"><table class="course-check-required-table"><thead><tr><th scope="col">교과(군)</th><th scope="col">편제표</th><th scope="col">2022 기준</th><th scope="col">직접 입력</th></tr></thead><tbody>${requiredRows}</tbody></table></div>
    </section>
    <section class="course-check-section" aria-labelledby="courseCheckResultTitle">
      <h3 id="courseCheckResultTitle">현재 차수 결과 점검</h3>
      ${results || '<p class="note">2단계에서 결과를 반영하면 학생별 점검 결과가 여기에 표시됩니다.</p>'}
    </section>
    <p id="courseCheckDialogMessage" role="status"></p>`;
}

function courseCheckDialogMessage(text, failed = false) {
  const message = document.getElementById("courseCheckDialogMessage");
  if (!message) return;
  message.textContent = text;
  message.style.color = failed ? "#a44939" : "";
}

function courseCheckSettingsChanged(message) {
  courseCheckRenderDialog();
  courseCheckDialogMessage(message);
  courseCheckRefreshViews();
  if (typeof resultImportPending !== "undefined" && resultImportPending && typeof revalidateResultImport === "function") revalidateResultImport();
}

// 이전 학년 이수 결과 엑셀 읽기(2단계 결과 형식 재사용). 과목명만 보관한다.
function courseCheckPriorStudents(sheets, currentGrade) {
  const grades = new Set([String(currentGrade), String(Number(currentGrade) - 1)]);
  for (const sheet of sheets || []) {
    const rows = sheet?.rows || [];
    const students = [];
    if (String(rows[0]?.[0] ?? "").trim() === "차수" && String(rows[0]?.[5] ?? "").trim() === "선택과목") {
      for (const row of rows.slice(1)) {
        const [grade, classroom, number, name] = [1, 2, 3, 4].map((index) => String(row?.[index] ?? "").trim());
        if (!grade || !name) continue;
        students.push({ grade, classroom, number, name, subjects: String(row[5] ?? "").split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean) });
      }
    } else if (typeof createRecords === "function") {
      try {
        for (const student of createRecords(rows).students) {
          students.push({ grade: student.grade, classroom: student.classroom, number: student.number, name: student.name,
            subjects: student.selections.map((course) => course.name) });
        }
      } catch { /* 이 시트는 결과 형식이 아니다 */ }
    }
    const matched = students.filter((student) => grades.has(String(Number(student.grade))));
    if (matched.length) return matched;
  }
  throw new Error(`현 ${currentGrade}학년(또는 지난해 ${Number(currentGrade) - 1}학년) 학생 결과를 찾지 못했습니다. 학년·반·번호·성명 열과 과목 열을 확인하세요.`);
}

async function courseCheckUploadPrior(file) {
  const grade = String(state.applicationMenuGrade || "1");
  const year = courseCheckCohortYear(grade);
  try {
    if (!file.name.toLowerCase().endsWith(".xlsx")) throw new Error(".xlsx 파일만 올릴 수 있습니다.");
    if (typeof parseWorkbook !== "function") throw new Error("엑셀 읽기 기능을 불러오지 못했습니다.");
    const students = courseCheckPriorStudents(await parseWorkbook(await file.arrayBuffer()), grade);
    courseCheckSaveSettings((settings) => {
      settings.prior[year] = { fileName: file.name, uploadedAt: new Date().toLocaleString("ko-KR"), students };
    });
    courseCheckContextCache = null;
    const current = (state.students || []).filter((student) => String(student.grade) === grade);
    const index = courseCheckPriorIndex(courseCheckContext(), year, grade);
    const found = current.filter((student) => index?.find(student)).length;
    courseCheckSettingsChanged(`이전 학년 이수 결과 ${students.length}명을 반영했습니다.${current.length ? ` 현재 결과 ${current.length}명 중 ${found}명과 연결했습니다.` : ""}`);
  } catch (error) {
    courseCheckDialogMessage(`이전 학년 결과를 읽지 못했습니다: ${error?.message || error}`, true);
  }
}

function initCourseChecks() {
  const dialog = document.getElementById("courseCheckDialog");
  const body = document.getElementById("courseCheckDialogBody");
  if (!dialog || !body) return;
  document.addEventListener("click", (event) => {
    if (event.target.closest?.('[data-open-dialog="courseCheckDialog"]')) courseCheckRenderDialog();
  });
  body.addEventListener("click", (event) => {
    const remove = event.target.closest("[data-cc-rule-delete]");
    if (remove) {
      const key = remove.dataset.ccRuleDelete;
      courseCheckSaveSettings((settings) => {
        const custom = settings.custom.filter((rule) => courseCheckRuleKey(rule.before, rule.after) !== key);
        if (custom.length === settings.custom.length) settings.removed.push(key);
        settings.custom = custom;
        settings.off = settings.off.filter((item) => item !== key);
      });
      courseCheckSettingsChanged("위계 규칙을 삭제했습니다.");
    } else if (event.target.closest("#courseCheckAddRule")) {
      const before = document.getElementById("courseCheckRuleBefore").value;
      const after = document.getElementById("courseCheckRuleAfter").value;
      if (!before || !after || courseCheckKey(before) === courseCheckKey(after)) {
        courseCheckDialogMessage("서로 다른 앞 과목과 뒤 과목을 고르세요.", true);
        return;
      }
      const key = courseCheckRuleKey(before, after);
      courseCheckSaveSettings((settings) => {
        settings.removed = settings.removed.filter((item) => item !== key);
        settings.off = settings.off.filter((item) => item !== key);
        if (!COURSE_CHECK_DEFAULT_RULES.some(([a, b]) => courseCheckRuleKey(a, b) === key)) settings.custom.push({ before, after });
      });
      courseCheckSettingsChanged(`${before} → ${after} 위계를 추가했습니다.`);
    } else if (event.target.closest("#courseCheckRestoreRules")) {
      courseCheckSaveSettings((settings) => { settings.removed = []; settings.off = []; });
      courseCheckSettingsChanged("기본 위계 규칙을 되돌렸습니다(추가한 규칙은 유지).");
    } else if (event.target.closest("#courseCheckPriorDelete")) {
      const year = courseCheckCohortYear(String(state.applicationMenuGrade || "1"));
      courseCheckSaveSettings((settings) => { delete settings.prior[year]; });
      courseCheckSettingsChanged("이전 학년 이수 결과를 삭제했습니다.");
    }
  });
  body.addEventListener("change", (event) => {
    const toggle = event.target.closest("[data-cc-rule-toggle]");
    if (toggle) {
      const key = toggle.dataset.ccRuleToggle;
      courseCheckSaveSettings((settings) => {
        settings.off = settings.off.filter((item) => item !== key);
        if (!toggle.checked) settings.off.push(key);
      });
      courseCheckSettingsChanged(toggle.checked ? "위계 규칙을 켰습니다." : "위계 규칙을 껐습니다.");
    } else if (event.target.matches("[data-cc-required]")) {
      const family = event.target.dataset.ccRequired;
      const value = event.target.value.trim();
      courseCheckSaveSettings((settings) => {
        if (value === "") delete settings.required[family];
        else settings.required[family] = Number(value);
      });
      courseCheckSettingsChanged(`${family} 필수 이수 학점을 ${value === "" ? "원래 값으로" : `${value}학점으로`} 정했습니다.`);
    } else if (event.target.id === "courseCheckPriorInput") {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) courseCheckUploadPrior(file);
    }
  });
}

if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initCourseChecks);
  else initCourseChecks();
}
