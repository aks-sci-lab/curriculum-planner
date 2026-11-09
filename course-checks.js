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
// 교과(군)별 필수 이수 학점·총 이수 학점·국어·수학·영어 상한의 기본값(울산 편제 점검 프로그램 '지침' = 2022 개정 총론).
// 앱에서는 1단계 '편제 점검 기준 설정'(state.curriculumCompliance.settings) 한 곳의 값을 읽어 넘긴다(courseCheckLimits).
// 교과(군)은 편제 점검표와 같은 9개: 한국사 6과 사회(역사/도덕 포함) 8을 따로 본다.
var COURSE_CHECK_FAMILIES = ["국어", "수학", "영어", "한국사", "사회", "과학", "체육", "예술", "기술·가정/정보/제2외국어/한문/교양"];
var COURSE_CHECK_KEM = ["국어", "수학", "영어"];
var COURSE_CHECK_REQUIRED_DEFAULTS = { "국어": 8, "수학": 8, "영어": 8, "한국사": 6, "사회": 8, "과학": 10, "체육": 10, "예술": 10, "기술·가정/정보/제2외국어/한문/교양": 16 };
var COURSE_CHECK_TOTALS = { subjects: 174, creative: 18, total: 192 };
var COURSE_CHECK_LIMIT_DEFAULTS = { subjects: 174, creative: 18, kemLimit: 81, kemExtraRatio: 50 };
// 예전(학생 점검 쪽 설정) 교과(군) 이름 → 지금 이름. 사회는 한국사와 합쳐 14로 보던 값이다.
var COURSE_CHECK_LEGACY_FAMILIES = { "사회(역사/도덕 포함)": "사회" };

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

// 교과(군): 편제표 교과 칸을 먼저 보고, 없으면 2022 개정 과목 목록의 교과(군)을 쓴다. 한국사1·2는 사회와 따로 센다(편제 점검표와 같다).
function courseCheckFamily(area, name = "") {
  const text = String(area ?? "").replace(/\s+/g, "");
  if (/^한국사[12]?$/.test(courseCheckKey(name)) || /한국사/.test(text)) return "한국사";
  // '제2외국어'에 '국어'가 들어 있으므로 외국어·한문·기술·가정·정보·교양을 먼저 본다.
  const byText = /외국어|한문|기술|가정|정보|교양/.test(text) ? 8 : /국어/.test(text) ? 0 : /수학/.test(text) ? 1 : /영어/.test(text) ? 2
    : /사회|역사|도덕|윤리|지리/.test(text) ? 4 : /과학/.test(text) ? 5 : /체육/.test(text) ? 6
      : /예술|음악|미술|연극/.test(text) ? 7 : -1;
  if (byText >= 0) return COURSE_CHECK_FAMILIES[byText];
  const official = typeof findCurriculumOfficialSubject === "function" ? findCurriculumOfficialSubject(name) : null;
  const areas = { "국어": 0, "수학": 1, "영어": 2, "사회(역사/도덕 포함)": 4, "과학": 5, "체육": 6, "예술": 7,
    "기술⋅가정/정보": 8, "제2외국어/한문": 8, "교양": 8, "과학 계열(수학)": 1, "과학 계열(과학)": 5, "과학 계열(정보)": 8,
    "체육 계열(체육)": 6, "예술 계열(예술)": 7, "외국어‧국제계열(영어)": 2, "외국어‧국제계열(사회(역사/도덕 포함)": 4,
    "외국어‧국제계열(제2외국어)": 8 };
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
      id: group.id || `g${index}`, fields, pick: Math.max(1, Number(group.pick) || 1),
      // 학점을 읽지 못한 묶음(0)은 구성 과목 운영학점(curriculum-data.js planDataGroupCredit)
      credit: Number(group.credit) > 0 ? Number(group.credit) : typeof planDataGroupCredit === "function" ? planDataGroupCredit(planData, group) : 0,
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
  // 필수이수 열: 병합 칸(세그먼트)마다 값 하나. 같은 교과(군)의 서로 다른 칸은 더한다(한국사·사회는 다른 교과(군)이라 따로 둔다).
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
// 나이스 수강학생 편성 자료(priorSource "neis"): priorMissing은 이 학생 기록이 없는 학기 칸(전입생, ["sem21", …]).
// 선이수 과목이 편제표에서 나오는 학기에 이 학교 기록이 없으면 위반 대신 'unknown'(reason "transfer", 이전 학교 기록 확인)으로 둔다.
function courseCheckPrerequisites(model, rules, { targetGrade, selections = [], prior = null, priorMissing = null, priorSource = "" } = {}) {
  const grade = String(targetGrade);
  const picked = selections.map((item) => ({ ...item, key: courseCheckKey(item.name), semester: ["1", "2"].includes(String(item.semester)) ? String(item.semester) : "" }));
  const priorKeys = Array.isArray(prior) ? new Set(prior.map(courseCheckKey)) : null;
  const absent = new Set(Array.isArray(priorMissing) ? priorMissing : []);
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
      const base = { course: course.name, semester: course.semester, requires: rule.before, rule: rule.key || courseCheckRuleKey(rule.before, rule.after),
        ...(priorSource ? { priorSource } : {}) };
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
        else if (absent.size && places.some((item) => absent.has(item.field))) { status = "unknown"; evidence = "transfer"; }
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
    if (issue.reason === "transfer") return `${head} — 전입생이라 이 학교 기록이 없는 학기가 있어 확인 불가(이전 학교 이수 기록을 확인하세요)`;
    return issue.reason === "semester"
      ? `${head} — 학기를 알 수 없어 확인 불가`
      : `${head} — 이전 학년 이수 결과가 없어 확인 불가${student ? "(이전 학년에 이수하지 않았다면 담당 선생님과 상의하세요)" : ""}`;
  }
  const why = issue.reason === "same" ? `같은 학기(${issue.semester}학기)에 함께 고른 ${courseCheckJosa(need, "은/는")} 선이수로 인정되지 않습니다`
    : issue.reason.startsWith("later:") ? `${courseCheckJosa(need, "을/를")} 더 뒤 학기(${issue.reason.slice(6)})에 골랐습니다`
      : issue.reason.startsWith("designated-later:") ? `${courseCheckJosa(need, "은/는")} 편제표에서 ${issue.reason.slice(17)} 지정 과목입니다`
        : issue.priorSource === "neis" ? `나이스 이수 기록에 ${courseCheckJosa(need, "이/가")} 없습니다` : `${courseCheckJosa(need, "을/를")} 이수한 근거가 없습니다`;
  const advice = issue.offeredEarlier ? `${issue.offeredEarlier}에 ${courseCheckJosa(need, "을/를")} 고르거나 담당 선생님과 상의하세요` : "담당 선생님과 상의하세요";
  return `${head} — ${why}. ${advice}.`;
}

// 신청 학년이 아닌 선택과목군(뒤 학년, 그리고 결과가 없으면 이전 학년)의 교과(군) 학점. certain은 earned에 더하고 possible을 돌려준다.
// priorKnown: 이전 학년 선택을 아는지(true/false, 또는 학기 칸마다 판단하는 함수).
function courseCheckOpenGroupFamilies(model, grade, priorKnown, certain) {
  const known = typeof priorKnown === "function" ? priorKnown : () => Boolean(priorKnown);
  const possible = {};
  for (const group of model.groups) {
    const fields = group.fields.filter((field) => field.slice(3, 4) !== String(grade) && (field.slice(3, 4) > String(grade) || !known(field)));
    if (!fields.length) continue;
    const credits = group.pick * group.credit * fields.length;
    const families = [...new Set(group.families.values())];
    if (families.length === 1) certain[families[0]] = (certain[families[0]] || 0) + credits;
    else for (const family of families) possible[family] = (possible[family] || 0) + credits;
  }
  return possible;
}

// 기준값 정리: 교과(군) 필수 학점(값이 있는 것만, 0 이상)·총 이수 학점·창체·국수영 상한·174 초과분 비율.
function courseCheckNormalizeLimits(limits) {
  const source = limits && typeof limits === "object" ? limits : {};
  const number = (value, fallback, max = 400) => {
    const parsed = value === "" || value === null || value === undefined ? NaN : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= max ? parsed : fallback;
  };
  return { subjects: number(source.subjects, COURSE_CHECK_LIMIT_DEFAULTS.subjects), creative: number(source.creative, COURSE_CHECK_LIMIT_DEFAULTS.creative),
    kemLimit: number(source.kemLimit, COURSE_CHECK_LIMIT_DEFAULTS.kemLimit), kemExtraRatio: number(source.kemExtraRatio, COURSE_CHECK_LIMIT_DEFAULTS.kemExtraRatio, 100) };
}

// 국어·수학·영어 상한: 81학점, 교과 총 이수 학점이 174를 넘으면 초과분의 50%만큼 늘린다(울산 지침 · 편제 점검표 7번과 같은 식).
function courseCheckKemLimit(limits, total) {
  const value = courseCheckNormalizeLimits(limits);
  return value.kemLimit + Math.max(0, Number(total) - value.subjects) * value.kemExtraRatio / 100;
}

function courseCheckRequiredValue(required, family) {
  const value = required && typeof required === "object" && Object.hasOwn(required, family) ? required[family] : undefined;
  const number = value === "" || value === null || value === undefined ? NaN : Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 200 ? number : null;
}

// 학생 한 명의 이수 학점 점검(신청 학년 targetGrade 기준).
// selections: [{ name, semester, credit }], prior: 이전 학년 이수 과목명 배열 또는 null,
// required: 교과(군)별 필수 학점(앱은 편제 점검 기준 설정의 표 전체를 넘긴다. 없는 교과(군)은 편제표 '필수이수' 열 → 기본값),
// limits: { subjects, creative, kemLimit, kemExtraRatio } (편제 점검 기준 설정과 같은 값)
// kem: 국어·수학·영어 3년 누계(이전 학년 지정 + 이전 학년 결과(있으면) + 이번 신청 + 지정·같은 교과(군)만 있는 뒤 학년 묶음).
//      상한을 넘으면 경고만 한다(웹 학생 화면에는 보이지 않는다).
// priorRecords: 나이스 실제 이수 기록 [{ grade, semester, family(편제명), name, credit }]. 기록이 있는 이전 학년 학기 칸은
//      편제표 대신 기록의 학점·교과(군)(편제명으로 판단)을 쓴다. 기록이 없는 학기 칸(전입생)은 편제표 기준으로 둔다.
function courseCheckCredits(model, { targetGrade, selections = [], prior = null, priorRecords = null, required = {}, limits = null } = {}) {
  const limit = courseCheckNormalizeLimits(limits);
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
  const recordFields = new Map();
  for (const record of Array.isArray(priorRecords) ? priorRecords : []) {
    const field = `sem${Number(record?.grade)}${Number(record?.semester)}`;
    if (!COURSE_CHECK_FIELDS.includes(field) || field.slice(3, 4) >= grade) continue;
    if (!recordFields.has(field)) recordFields.set(field, []);
    recordFields.get(field).push(record);
  }
  const fieldKnown = (field) => recordFields.size ? recordFields.has(field) : Boolean(priorKeys);
  let before = 0, beforeEstimated = false, after = 0;
  const actual = [];
  for (const field of COURSE_CHECK_FIELDS) {
    const g = field.slice(3, 4);
    if (g === grade) continue;
    const plan = model.fields[field];
    if (g > grade) { after += plan.target; continue; }
    if (recordFields.has(field)) {
      // 실제 이수 기록(학점을 못 읽은 과목은 편제표 같은 학기 학점)
      let earned = 0;
      for (const record of recordFields.get(field)) {
        const key = courseCheckKey(record.name);
        const credit = Number(record.credit) > 0 ? Number(record.credit)
          : Number((model.places.get(key) || []).find((place) => place.field === field)?.credit) || 0;
        const family = courseCheckFamily(record.family, record.name);
        familyEarned[family] = (familyEarned[family] || 0) + credit;
        earned += credit;
      }
      before += earned;
      actual.push({ field, label: courseCheckFieldLabel(field), earned, target: plan.target });
      continue;
    }
    for (const id of plan.designatedRows) {
      const subject = model.subjects.find((item) => item.id === id);
      familyEarned[subject.family] += subject.designated[field];
    }
    if (!fieldKnown(field)) {
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
  const possible = courseCheckOpenGroupFamilies(model, grade, fieldKnown, familyEarned);
  const futureUnknown = model.groups.some((group) => group.fields.some((field) => field.slice(3, 4) > grade));
  const priorUnknown = model.groups.some((group) => group.fields.some((field) => field.slice(3, 4) < grade && !fieldKnown(field)));
  const families = COURSE_CHECK_FAMILIES.map((family) => {
    const custom = courseCheckRequiredValue(required, family);
    const need = custom !== null ? custom : Number(model.required?.[family]) > 0 ? Number(model.required[family]) : COURSE_CHECK_REQUIRED_DEFAULTS[family];
    const source = custom !== null ? "custom" : Number(model.required?.[family]) > 0 ? "plan" : "default";
    const earned = familyEarned[family] || 0;
    const status = earned >= need ? "ok" : earned + (possible[family] || 0) >= need ? "pending" : "short";
    return { family, required: need, earned, possible: possible[family] || 0, ok: status !== "short", status, source };
  });
  const gradeEarned = semesters.reduce((sum, row) => sum + row.earned, 0) + unplaced;
  const gradeTarget = semesters.reduce((sum, row) => sum + row.target, 0);
  const total = before + gradeEarned + after;
  // 아직 모르는 선택(뒤 학년, 결과 없는 이전 학년) 중 교과(군)이 섞인 묶음: 국수영 아닌 선택지가 모자라 꼭 고르게 되는 학점만 더하고,
  // 더 고를 수 있는 국수영 학점은 kemPossible(참고)로 둔다. 한 교과(군)만 있는 묶음은 familyEarned에 이미 들어 있다.
  let kemForced = 0, kemPossible = 0;
  for (const group of model.groups) {
    const open = group.fields.filter((field) => field.slice(3, 4) !== grade && (field.slice(3, 4) > grade || !fieldKnown(field)));
    if (!open.length || new Set(group.families.values()).size < 2) continue;
    const inside = [...group.families.values()].filter((family) => COURSE_CHECK_KEM.includes(family)).length;
    const forced = Math.max(0, group.pick - (group.families.size - inside));
    kemForced += forced * group.credit * open.length;
    kemPossible += (Math.min(group.pick, inside) - forced) * group.credit * open.length;
  }
  const kemEarned = COURSE_CHECK_KEM.reduce((sum, family) => sum + (familyEarned[family] || 0), 0) + kemForced;
  const kemLimit = courseCheckKemLimit(limit, total);
  const kem = { earned: kemEarned, possible: kemPossible,
    limit: kemLimit, base: limit.kemLimit, total, over: Math.max(0, kemEarned - kemLimit), status: kemEarned > kemLimit ? "over" : "ok",
    families: Object.fromEntries(COURSE_CHECK_KEM.map((family) => [family, familyEarned[family] || 0])) };
  return {
    targetGrade: grade, semesters, groups: groupRows, extras, unplaced,
    grade: { earned: gradeEarned, target: gradeTarget, diff: gradeEarned - gradeTarget },
    cumulative: { before, beforeEstimated, after, earned: total, target: limit.subjects,
      creative: limit.creative, total: limit.subjects + limit.creative, ...(actual.length ? { actual } : {}) },
    families, kem, futureUnknown, priorUnknown,
    short: semesters.filter((row) => row.diff < 0), over: semesters.filter((row) => row.diff > 0)
  };
}

// "국어·수학·영어 3년 누계 84/81학점(3학점 초과)". 174를 넘으면 늘어난 상한을 함께 적는다.
function courseCheckKemText(kem, { short = false } = {}) {
  const round = (value) => Math.round(Number(value || 0) * 100) / 100;
  const raised = kem.limit > kem.base ? `, 총 ${round(kem.total)}학점이라 ${round(kem.base)}+초과분 ${round(kem.limit - kem.base)}` : "";
  return short ? `국수영 ${round(kem.earned)}/${round(kem.limit)}`
    : `국어·수학·영어 3년 누계 ${round(kem.earned)}/${round(kem.limit)}학점(${round(kem.over)}학점 초과${raised})`;
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
function courseCheckEventPayload(model, rules, { targetGrade, courses = [], required = {}, limits = null } = {}) {
  const grade = String(targetGrade);
  const limit = courseCheckNormalizeLimits(limits);
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
    required: courseCheckRequiredValue(required, family) ?? (Number(model.required?.[family]) > 0 ? Number(model.required[family]) : COURSE_CHECK_REQUIRED_DEFAULTS[family]),
    base: base[family] || 0, possible: possible[family] || 0 }));
  // 국어·수학·영어 상한(81) 점검은 교사 화면에서만 한다(학생 화면에는 싣지 않는다).
  return { requires, checks: { v: 1, grade, semesters, families,
    cumulative: { before, after, target: limit.subjects, creative: limit.creative, total: limit.subjects + limit.creative } } };
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

// 집계표·학생 목록·엑셀에 쓰는 짧은 근거. 예: "화학 미이수(2-1·2-2에 화학 없음)".
// grade: 신청 학년(현 N학년이면 N+1), offered: 그 학년에서 선이수 과목을 고를 수 있는 학기 라벨(["2-1", "2-2"]).
function courseCheckIssueBrief(issue, { grade = "", offered = [] } = {}) {
  const need = issue.requires;
  if (issue.status === "unknown") {
    if (issue.reason === "transfer") return `${need} 이수 확인 불가(전입생 · 이전 학교 기록 확인)`;
    return issue.reason === "semester" ? `${need} 이수 확인 불가(학기를 알 수 없음)` : `${need} 이수 확인 불가(이전 학년 이수 결과 없음)`;
  }
  if (issue.reason === "same") return `${need} 같은 학기 선택(${grade ? `${grade}-` : ""}${issue.semester}학기, 선이수 불인정)`;
  if (String(issue.reason).startsWith("later:")) return `${need} 뒤 학기(${issue.reason.slice(6)})에 선택`;
  if (String(issue.reason).startsWith("designated-later:")) return `${courseCheckJosa(need, "은/는")} ${issue.reason.slice(17)} 지정 과목(뒤 학기)`;
  const labels = [...new Set(offered)].sort();
  if (issue.priorSource === "neis" && !labels.length) return `${need} 미이수(나이스 이수 기록에 없음)`;
  return `${need} 미이수(${labels.length ? `${labels.join("·")}에 ${need} 없음` : "이수 근거 없음"})`;
}

// 편제표 모델에서 신청 학년에 선이수 과목이 나오는 학기 라벨.
function courseCheckOfferedLabels(model, need, grade) {
  return [...new Set((model?.places?.get(courseCheckKey(need)) || []).filter((place) => place.field.slice(3, 4) === String(grade))
    .map((place) => courseCheckFieldLabel(place.field)))].sort();
}

// 웹 수강신청 교사 화면(신청 현황): 서버가 준 학생 선택(get_teacher_course_applications)과 이벤트에 실린 requires로 화면에서 계산한다.
// 서버는 위계를 검사하지 않는다. 점검 정보가 없는 예전 이벤트면 available=false.
function courseCheckTeacherReview(data, currentGrade) {
  const grade = String(currentGrade);
  const target = String(Number(grade) + 1);
  const courses = Array.isArray(data?.subjects?.[target]) ? data.subjects[target] : [];
  const groups = (Array.isArray(data?.groups) ? data.groups : []).filter((group) => String(group.grade) === target);
  const application = { courses, groups, student: { grade } };
  const semesterOf = (course) => ["1", "2"].includes(String(course?.semester)) ? String(course.semester) : "";
  const baseKey = (course) => courseCheckKey(course.groupSubject || String(course.subject ?? "").replace(/\s*\([12]학기\)\s*$/, ""));
  const offered = (need) => [...new Set(courses.filter((course) => baseKey(course) === courseCheckKey(need) && semesterOf(course))
    .map((course) => `${target}-${semesterOf(course)}`))].sort();
  const rows = [];
  const review = { grade, target, available: courseCheckApplicationState(application, []) !== null, rows,
    entries: 0, submitted: 0, violators: 0, unknowns: 0 };
  for (const entry of Array.isArray(data?.entries) ? data.entries : []) {
    if (String(entry?.grade) !== grade) continue;
    review.entries++;
    const selections = Array.isArray(entry.selections) ? entry.selections : [];
    if (entry.submittedAt || selections.length) review.submitted++;
    const result = review.available && selections.length ? courseCheckApplicationState(application, selections) : null;
    const brief = (issue) => ({ ...issue, brief: courseCheckIssueBrief(issue, { grade: target, offered: offered(issue.requires) }) });
    const violations = (result?.violations || []).map(brief);
    const unknowns = (result?.unknowns || []).map(brief);
    if (violations.length) review.violators++;
    if (unknowns.length) review.unknowns++;
    rows.push({ entry, violations, unknowns });
  }
  return review;
}

// 예전 저장분 이전(한 번): 학생 위계·학점 점검 설정(state.courseChecks.required, 교과(군) 8개·사회 14)에 교사가 고친 값이 있으면
// 편제 점검 기준 설정(state.curriculumCompliance.settings.required)으로 옮기고 학생 점검 쪽 값은 지운다.
//  · 편제 점검 기준 설정에서 이미 기본값과 다르게 고친 교과(군)은 그 값을 둔다(나중에 한 곳에서 고친 값이 우선).
//  · '사회(역사/도덕 포함)'(한국사 포함 합계)는 한국사 학점을 뺀 값을 사회로 옮긴다(예: 16 → 한국사 6 + 사회 10).
// 입력을 바꾸지 않고 { courseChecks, compliance, moved: [교과(군)] }를 돌려준다. 옮길 값이 없으면 moved는 빈 배열.
function courseCheckMigrateRequired(courseChecks, compliance) {
  const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const checks = object(courseChecks) ? { ...courseChecks } : courseChecks;
  const store = object(compliance) ? { ...compliance } : {};
  const old = object(checks) && object(checks.required) ? checks.required : null;
  if (object(checks)) delete checks.required;
  const moved = [];
  if (!old) return { courseChecks: checks, compliance: object(compliance) ? compliance : store, moved };
  const settings = object(store.settings) ? { ...store.settings } : {};
  const current = object(settings.required) ? { ...settings.required } : {};
  const edited = (family) => {
    const value = courseCheckRequiredValue(current, family);
    return value !== null && value !== COURSE_CHECK_REQUIRED_DEFAULTS[family];
  };
  for (const name of Object.keys(old)) {
    const value = courseCheckRequiredValue(old, name);
    const family = COURSE_CHECK_LEGACY_FAMILIES[name] || name;
    if (value === null || !COURSE_CHECK_FAMILIES.includes(family) || edited(family)) continue;
    const history = courseCheckRequiredValue(current, "한국사") ?? COURSE_CHECK_REQUIRED_DEFAULTS["한국사"];
    const next = name in COURSE_CHECK_LEGACY_FAMILIES ? Math.max(0, value - history) : value;
    current[family] = next;
    moved.push(family);
  }
  if (!moved.length) return { courseChecks: checks, compliance: object(compliance) ? compliance : store, moved };
  settings.required = current;
  store.settings = settings;
  return { courseChecks: checks, compliance: store, moved };
}

// ---- 앱 연결 (아래는 화면·저장에 연결한다)

// 설정(state.courseChecks): 기본 위계 중 삭제·끔, 추가 위계, 입학연도별 이전 학년 이수 결과.
// 교과(군) 필수 학점·총 이수 학점·국수영 상한은 편제 점검 기준 설정(state.curriculumCompliance.settings) 한 곳에 둔다
// (예전 저장분의 required는 열 때 courseCheckMigrateRequired로 옮기고, 여기서는 버린다).
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
  // 나이스 수강학생 편성 자료(학생 키·학년도·학기·편제명·과목명·학점만, neis-enrollment.js)
  const neis = typeof neisEnrollmentNormalize === "function" ? neisEnrollmentNormalize(source.neis) : null;
  return { removed: strings(source.removed), off: strings(source.off), custom, prior, ...(neis ? { neis } : {}) };
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

// 기준값(교과(군) 필수 학점·총 이수 학점·창체·국수영 상한): 1단계 '편제 점검 기준 설정'과 같은 값을 읽는다.
function courseCheckLimits() {
  const settings = typeof planComplianceCurrentSettings === "function" ? planComplianceCurrentSettings() : null;
  const required = { ...COURSE_CHECK_REQUIRED_DEFAULTS };
  for (const family of COURSE_CHECK_FAMILIES) {
    const value = courseCheckRequiredValue(settings?.required, family);
    if (value !== null) required[family] = value;
  }
  return { ...courseCheckNormalizeLimits(settings || {}), required };
}

// 화면 한 번 그리는 동안 쓰는 점검 문맥(설정·규칙·편제표 모델·기준값). 설정 객체나 편제표가 바뀌면 다시 만든다.
function courseCheckContext() {
  const raw = typeof state !== "undefined" ? state.courseChecks : null;
  const shared = typeof state !== "undefined" ? state.curriculumCompliance?.settings : null;
  const years = typeof state !== "undefined" ? Object.keys(state.curriculumCohorts || {}).sort() : [];
  const models = years.map((year) => courseCheckModel(year));
  const students = typeof state !== "undefined" ? state.students : null;
  if (courseCheckContextCache && courseCheckContextCache.raw === raw && courseCheckContextCache.shared === shared && courseCheckContextCache.students === students &&
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
  courseCheckContextCache = { raw, shared, limits: courseCheckLimits(), students, schoolYear: courseCheckCohortYear("1"), models, settings, rules,
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

// 나이스 수강학생 편성 저장분(이 학년도 자료만 쓴다. 학년도가 바뀌면 학생 자리(학년-반-번호)가 달라지므로 쓰지 않는다).
function courseCheckNeisStore(context = courseCheckContext()) {
  if (!("neisStore" in context)) {
    const store = context.settings.neis || null;
    context.neisStore = store && store.currentYear === context.schoolYear ? store : null;
  }
  return context.neisStore;
}

// 학생 한 명의 나이스 기록({ records, missing, terms }) 또는 null(자료 없음·찾지 못함).
function courseCheckNeisFor(student, context = courseCheckContext()) {
  const store = courseCheckNeisStore(context);
  if (!store || !student || typeof neisEnrollmentStudent !== "function") return null;
  return neisEnrollmentStudent(store, student.grade, student.classroom, student.number);
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
    // 나이스 수강학생 편성 자료가 있으면 실제 이수 기록을 먼저 쓰고, 없으면 예전 '이전 학년 이수 결과' 엑셀.
    const neis = courseCheckNeisFor(student, context);
    const prior = neis ? neis.records.map((record) => record.name) : courseCheckPriorIndex(context, year, grade)?.find(student) || null;
    report = {
      year, targetGrade, model, priorFound: Boolean(prior), neis: neis ? { terms: neis.terms, missing: neis.missing } : null,
      prerequisites: courseCheckPrerequisites(model, context.active, { targetGrade, selections, prior,
        ...(neis ? { priorMissing: neis.missing, priorSource: "neis" } : {}) }),
      credits: courseCheckCredits(model, { targetGrade, selections, prior, priorRecords: neis ? neis.records : null,
        required: context.limits.required, limits: context.limits })
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
  const summary = { checked: 0, noPlan: 0, violators: [], unknowns: [], short: [], over: [], familyShort: [], kemOver: [], byCourse: new Map(), unknownByCourse: new Map(),
    priorMissing: 0, priorAvailable: false, neis: Boolean(courseCheckNeisStore(context)), neisFound: 0, transfers: 0 };
  for (const student of students) {
    if (!(student.selections || []).length) continue;
    const report = courseCheckStudentReport(student, context);
    if (!report) { summary.noPlan++; continue; }
    summary.checked++;
    if (summary.neis || courseCheckPriorIndex(context, report.year, String(student.grade))) {
      summary.priorAvailable = true;
      if (!report.priorFound) summary.priorMissing++;
    }
    if (report.neis) {
      summary.neisFound++;
      if (report.neis.missing.length) summary.transfers++;
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
    if (report.credits.kem?.status === "over") summary.kemOver.push({ student, report });
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
  if (summary.kemOver.length) {
    const limits = courseCheckContext().limits;
    result.warnings.push(`국어·수학·영어 3년 누계가 기준(${limits.kemLimit}학점${limits.kemExtraRatio ? `, 총 이수 ${limits.subjects}학점 초과 시 초과분의 ${limits.kemExtraRatio}%까지` : ""})을 넘는 학생 ${summary.kemOver.length}명(이전 학년 지정${summary.priorAvailable ? "·이수 결과" : ""} + 이번 신청 선택 기준, 경고만): ${courseCheckList(summary.kemOver.map(({ student, report }) => `${courseCheckSeat(student)} ${courseCheckKemText(report.credits.kem, { short: true })}`), 3)}.`);
  }
  if (summary.familyShort.length) {
    result.warnings.push(`교과(군) 필수 이수 학점 미달 학생 ${summary.familyShort.length}명: ${courseCheckList(summary.familyShort.map(({ student, report }) => `${courseCheckSeat(student)} ${report.credits.families.filter((family) => !family.ok).map((family) => `${family.family} ${family.earned}/${family.required}`).join("·")}`), 3)}.`);
  }
  if (summary.unknowns.length) {
    result.info.push(summary.neis
      ? `위계 확인 불가 학생 ${summary.unknowns.length}명(전입생 ${summary.transfers}명 · 나이스 자료에서 찾지 못한 학생 ${summary.priorMissing}명 중 해당 학생 · 과목별 ${courseCheckCountText(summary.unknownByCourse)}).`
      : `위계 확인 불가 학생 ${summary.unknowns.length}명(이전 학년 이수 결과가 없어 판단하지 않음 · 과목별 ${courseCheckCountText(summary.unknownByCourse)}). '위계·학점 점검'에서 이전 학년 이수 결과(나이스 수강학생 편성 엑셀 그대로)를 올리면 판단합니다.`);
  }
  if (summary.priorAvailable && summary.priorMissing) result.info.push(`${summary.neis ? "나이스 수강학생 편성 자료" : "이전 학년 이수 결과"}에서 찾지 못한 학생 ${summary.priorMissing}명은 확인 불가로 둡니다.`);
  if (!summary.violators.length && !credit.length && !summary.familyShort.length && !summary.kemOver.length) {
    result.info.push(`위계·이수학점 점검: ${summary.checked}명 모두 이상 없음${summary.unknowns.length ? "(확인 불가 제외)" : ""}.`);
  }
  result.html = courseCheckStudentTableHtml(summary, { grade });
  return result;
}

function courseCheckStudentTableHtml(summary, { grade = "", limit = 400 } = {}) {
  const rows = new Map();
  const add = (item) => { if (!rows.has(item.student)) rows.set(item.student, item); };
  [summary.violators, summary.short, summary.over, summary.familyShort, summary.kemOver, summary.unknowns].forEach((list) => list.forEach(add));
  if (!rows.size) return "";
  const list = [...rows.values()].sort((a, b) => Number(a.student.classroom) - Number(b.student.classroom) || Number(a.student.number) - Number(b.student.number));
  const esc = courseCheckEscape;
  const body = list.slice(0, limit).map(({ student, report }) => {
    const issues = [...report.prerequisites.violations, ...report.prerequisites.unknowns].map((issue) =>
      `<li class="${issue.status === "violation" ? "is-violation" : "is-unknown"}">${esc(issue.status === "violation" ? "" : "확인 불가 · ")}${esc(courseCheckIssueText(issue))}</li>`);
    const credits = [...report.credits.short, ...report.credits.over].map((row) => `<li class="is-credit">${esc(courseCheckSemesterText(row))}</li>`);
    const families = report.credits.families.filter((family) => !family.ok).map((family) => `<li class="is-credit">${esc(`${family.family} 필수 이수 ${family.earned}/${family.required}학점`)}</li>`);
    const kem = report.credits.kem?.status === "over" ? [`<li class="is-credit is-kem">${esc(courseCheckKemText(report.credits.kem))}</li>`] : [];
    return `<tr><th scope="row">${esc(`현 ${student.grade}학년 ${courseCheckSeat(student)}`)}</th><td><ul>${[...issues, ...credits, ...families, ...kem].join("")}</ul></td></tr>`;
  }).join("");
  return `<details class="course-check-details"${summary.violators.length ? " open" : ""}><summary>위계·이수학점 점검 학생 ${rows.size}명${grade ? ` (현 ${esc(grade)}학년 → ${Number(grade) + 1}학년 과목)` : ""} · 위계 미충족 ${summary.violators.length} · 학점 부족 ${summary.short.length} · 초과 ${summary.over.length}${summary.kemOver.length ? ` · 국수영 기준 초과 ${summary.kemOver.length}` : ""} · 확인 불가 ${summary.unknowns.length}</summary>
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
  const notes = [...credits.short, ...credits.over].map((row) => `${row.label} ${Math.abs(row.diff)}학점 ${row.diff < 0 ? "부족" : "초과"}`);
  // 국어·수학·영어 3년 누계가 기준을 넘을 때만 같은 줄에 덧붙인다(줄 수가 늘지 않게 · 인쇄 1장 유지).
  if (credits.kem?.status === "over") notes.push(`국수영 ${credits.kem.earned}/${Math.round(credits.kem.limit * 100) / 100}학점 기준 초과`);
  const creditNote = notes.length ? ` — ${notes.join(", ")}` : "";
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

// 학생 묶음의 위계 경고를 한 번 계산해 학생·과목(학년:열)·학년별 Map으로 묶는다.
// 4단계 집계표 배지·팝업·'처리할 것만'·엑셀 시트, 3단계 학생 목록 표시·필터가 함께 쓴다.
// 같은 학생 배열·설정·편제표면 다시 계산하지 않는다(문맥 캐시가 바뀌면 새로 만든다). 위계는 경고만 한다.
function courseCheckFlags(students = typeof state !== "undefined" ? state.students : [], context = courseCheckContext()) {
  if (!context.flags) context.flags = new WeakMap();
  const list = Array.isArray(students) ? students : [];
  if (context.flags.has(list)) return context.flags.get(list);
  const flags = { students: new Map(), courses: new Map(), grades: new Map() };
  const bucket = (key) => {
    if (!flags.courses.has(key)) flags.courses.set(key, { violations: [], unknowns: [], violators: new Set(), unknownStudents: new Set() });
    return flags.courses.get(key);
  };
  for (const student of list) {
    if (!(student?.selections || []).length) continue;
    const report = courseCheckStudentReport(student, context);
    if (!report) continue;
    const grade = String(student.grade);
    if (!flags.grades.has(grade)) flags.grades.set(grade, { checked: 0, violators: [], unknowns: [] });
    const gradeFlags = flags.grades.get(grade);
    gradeFlags.checked++;
    const { violations, unknowns } = report.prerequisites;
    if (!violations.length && !unknowns.length) continue;
    const brief = (issue) => ({ issue, brief: courseCheckIssueBrief(issue, { grade: report.targetGrade,
      offered: courseCheckOfferedLabels(report.model, issue.requires, report.targetGrade) }) });
    const entry = { student, report, violations: violations.map(brief), unknowns: unknowns.map(brief) };
    flags.students.set(student, entry);
    if (entry.violations.length) gradeFlags.violators.push(entry);
    if (entry.unknowns.length) gradeFlags.unknowns.push(entry);
    const columns = new Map();
    for (const selection of student.selections) {
      if (!columns.has(selection.name)) columns.set(selection.name, []);
      columns.get(selection.name).push(selection.column);
    }
    for (const item of entry.violations) {
      for (const column of columns.get(item.issue.course) || []) {
        const target = bucket(`${grade}:${column}`);
        target.violations.push({ student, ...item });
        target.violators.add(student);
      }
    }
    for (const item of entry.unknowns) {
      for (const column of columns.get(item.issue.course) || []) {
        const target = bucket(`${grade}:${column}`);
        target.unknowns.push({ student, ...item });
        target.unknownStudents.add(student);
      }
    }
  }
  context.flags.set(list, flags);
  return flags;
}

function courseCheckStudentLine(student) {
  return `현 ${student.grade}학년 ${student.classroom}반 ${student.number}번 ${student.name}`;
}

function courseCheckSortItems(items) {
  return [...items].sort((a, b) => Number(a.student.grade) - Number(b.student.grade) || Number(a.student.classroom) - Number(b.student.classroom) ||
    Number(a.student.number) - Number(b.student.number) || String(a.issue.course).localeCompare(String(b.issue.course), "ko"));
}

// 집계표 과목 행의 배지(위계 경고 수). 누르면 그 과목의 학생 목록 팝업이 열린다.
// 확인 불가는 과목 행에 두지 않고 학년 머리줄 단추와 팝업 안(접힌 칸)에만 둔다.
function courseCheckCourseBadges(flags, key, label = "") {
  const flag = flags?.courses?.get(key);
  if (!flag) return "";
  const esc = courseCheckEscape;
  const attrs = `data-open-dialog="prereqStudentsDialog" data-prereq-course="${esc(key)}" data-prereq-label="${esc(label)}"`;
  return flag.violators.size ? `<button type="button" class="at-risk-badge prereq-badge" ${attrs} title="${esc(`${label} 신청자 중 위계(선이수) 경고 ${flag.violators.size}명 — 눌러서 학생 보기`)}">위계 경고 ${flag.violators.size}</button>` : "";
}

// 팝업 본문: 위계 경고 학생 목록(+ 확인 불가는 접어서 따로).
function courseCheckStudentsDialogHtml(violations, unknowns, { title = "", limit = 500 } = {}) {
  const esc = courseCheckEscape;
  const line = (item) => `<li>${esc(`${courseCheckStudentLine(item.student)} · ${item.issue.course}: ${item.brief}`)}</li>`;
  const sortedViolations = courseCheckSortItems(violations);
  const sortedUnknowns = courseCheckSortItems(unknowns);
  const count = (items) => new Set(items.map((item) => item.student)).size;
  return `<p class="prereq-dialog-scope">${esc(title)}</p>
    <h3 class="prereq-dialog-heading">위계 경고 ${count(sortedViolations)}명</h3>
    ${sortedViolations.length ? `<ul class="prereq-student-list">${sortedViolations.slice(0, limit).map(line).join("")}</ul>${sortedViolations.length > limit ? `<p class="note">앞 ${limit}건만 표시했습니다.</p>` : ""}`
      : '<p class="note">위계(선이수) 경고 학생이 없습니다.</p>'}
    <p class="note">위계는 경고만 합니다(신청은 그대로 유지됩니다). 학생과 상담해 과목을 바꿀지 정하세요.</p>
    ${sortedUnknowns.length ? `<details class="prereq-unknown-details"><summary>확인 불가 ${count(sortedUnknowns)}명 — 위반이 아니라 판단할 근거가 없는 학생</summary>
      <p class="note">판단할 근거가 없는 학생입니다. 이전 학년 이수 결과가 없으면 2단계 '위계·학점 점검'에서 나이스 수강학생 편성 엑셀을 올리면 판단하고, 전입생(이 학교 기록이 없는 학기가 있는 학생)은 이전 학교 이수 기록을 확인하세요.</p>
      <ul class="prereq-student-list is-unknown">${sortedUnknowns.slice(0, limit).map(line).join("")}</ul>${sortedUnknowns.length > limit ? `<p class="note">앞 ${limit}건만 표시했습니다.</p>` : ""}</details>` : ""}`;
}

function courseCheckOpenStudentsDialog(opener) {
  const body = document.getElementById("prereqStudentsBody");
  if (!body || typeof state === "undefined") return;
  const flags = courseCheckFlags(state.students);
  const courseKey = opener.dataset.prereqCourse;
  if (courseKey) {
    const flag = flags.courses.get(courseKey) || { violations: [], unknowns: [] };
    const grade = courseKey.slice(0, courseKey.indexOf(":"));
    body.innerHTML = courseCheckStudentsDialogHtml(flag.violations, flag.unknowns,
      { title: `현 ${grade}학년 → ${Number(grade) + 1}학년 과목 · ${opener.dataset.prereqLabel || ""} 신청 학생` });
  } else {
    const grade = String(opener.dataset.prereqGrade || "");
    const gradeFlags = flags.grades.get(grade) || { violators: [], unknowns: [] };
    body.innerHTML = courseCheckStudentsDialogHtml(gradeFlags.violators.flatMap((entry) => entry.violations.map((item) => ({ student: entry.student, ...item }))),
      gradeFlags.unknowns.flatMap((entry) => entry.unknowns.map((item) => ({ student: entry.student, ...item }))),
      { title: `현 ${grade}학년 → ${Number(grade) + 1}학년 과목 · 학년 전체` });
  }
  if (opener.dataset.prereqUnknown !== undefined) {
    body.querySelector(".prereq-unknown-details")?.setAttribute("open", "");
  }
}

// 4단계 학년 머리줄 요약: 위계 경고·확인 불가(따로, 흐리게)는 학생 목록 팝업, 학점은 점검 팝업을 연다.
function courseCheckAggregateNote(grade, flags = null) {
  if (typeof state === "undefined") return "";
  const students = (state.students || []).filter((student) => String(student.grade) === String(grade));
  if (!students.length || !courseCheckModel(courseCheckCohortYear(grade))) return "";
  const summary = courseCheckSummary(students);
  if (!summary.checked) return "";
  const gradeFlags = (flags || courseCheckFlags(state.students)).grades.get(String(grade)) || { violators: [], unknowns: [] };
  const esc = courseCheckEscape;
  const violators = gradeFlags.violators.length;
  const unknowns = gradeFlags.unknowns.length;
  return `<span class="aggregate-check-notes">
    <button type="button" class="aggregate-check-note${violators ? " has-issue" : ""}" data-open-dialog="prereqStudentsDialog" data-prereq-grade="${esc(grade)}" title="위계(선이수) 경고 학생 보기">위계 경고 ${violators}명</button>
    ${unknowns ? `<button type="button" class="aggregate-check-note is-muted" data-open-dialog="prereqStudentsDialog" data-prereq-grade="${esc(grade)}" data-prereq-unknown title="이전 학년 이수 결과가 없어 판단하지 못한 학생(위반 아님)">확인 불가 ${unknowns}명</button>` : ""}
    <button type="button" class="aggregate-check-note${summary.short.length ? " has-issue" : ""}" data-open-dialog="courseCheckDialog" title="위계·이수학점 점검 결과 보기">학기 학점 부족 ${summary.short.length}명</button>
    ${summary.kemOver.length ? `<button type="button" class="aggregate-check-note has-issue" data-open-dialog="courseCheckDialog" title="국어·수학·영어 3년 누계가 기준을 넘는 학생(경고만) — 위계·이수학점 점검 결과 보기">국수영 기준 초과 ${summary.kemOver.length}명</button>` : ""}
  </span>`;
}

// 4단계 집계표 엑셀의 '위계 경고 학생' 시트 행. grade를 주면 그 학년만. 점검할 수 없으면 null(시트를 만들지 않는다).
function courseCheckAggregateSheetRows(students, grade = "") {
  const flags = courseCheckFlags(students);
  const grades = [...flags.grades].filter(([value]) => !grade || value === String(grade));
  if (!grades.some(([, item]) => item.checked)) return null;
  const header = ["현 학년", "반", "번호", "이름", "신청 학년", "과목", "필요한 선이수", "근거"];
  const items = courseCheckSortItems(grades.flatMap(([, item]) => item.violators.flatMap((entry) =>
    entry.violations.map((issue) => ({ student: entry.student, ...issue })))));
  const rows = [header, ...items.map(({ student, issue, brief }) => [`현 ${student.grade}학년`, student.classroom, student.number, student.name,
    `${Number(student.grade) + 1}학년`, issue.course, issue.requires, brief])];
  if (!items.length) rows.push(["위계 경고 학생 없음"]);
  const unknowns = grades.reduce((sum, [, item]) => sum + item.unknowns.length, 0);
  if (unknowns) rows.push([], [`확인 불가 ${unknowns}명(이전 학년 이수 결과가 없어 판단하지 않음)은 이 시트에 넣지 않았습니다.`]);
  return rows;
}

// 재신청 명단: 학생 한 명의 위계 경고 과목. exclude(폐강 과목)를 주면 그 과목을 뺀 뒤 다시 점검한다.
// 학생이 고른 선이수 과목이 폐강돼 생긴 경고는 "선이수 과목(화학) 폐강", 원래 이수하지 않은 경우는 "화학 미이수"로 구분한다.
function courseCheckPrereqText(student, { exclude = null } = {}) {
  const report = courseCheckStudentReport(student, courseCheckContext(), exclude ? { exclude } : {});
  if (!report) return "";
  const picked = new Set((student.selections || []).map((item) => courseCheckKey(item.name)));
  const closed = new Set((exclude || []).map(courseCheckKey).filter((key) => picked.has(key)));
  return report.prerequisites.violations.map((issue) => `${issue.course}: ${closed.has(courseCheckKey(issue.requires))
    ? `선이수 과목(${issue.requires}) 폐강`
    : courseCheckIssueBrief(issue, { grade: report.targetGrade, offered: courseCheckOfferedLabels(report.model, issue.requires, report.targetGrade) })}`).join(" / ");
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
    const payload = courseCheckEventPayload(model, context.active, { targetGrade, courses, required: context.limits.required, limits: context.limits });
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
  return count ? ` 위계(선이수) 경고 ${count}건이 있는 채로 저장했습니다. ${courseCheckIssueText(result.violations[0], { student: true })}${count > 1 ? ` (외 ${count - 1}건)` : ""}` : "";
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
  const limits = context.limits;
  const requiredRows = COURSE_CHECK_FAMILIES.map((family) => {
    const plan = model?.required?.[family];
    const value = limits.required[family];
    return `<tr><th scope="row">${esc(family)}</th><td><b>${esc(value)}</b></td><td>${plan ? `${esc(plan)}${Number(plan) !== Number(value) ? ' <small class="course-check-differs">기준과 다름</small>' : ""}` : "—"}</td></tr>`;
  }).join("");
  const results = ["1", "2"].map((currentGrade) => {
    const students = (state.students || []).filter((student) => String(student.grade) === currentGrade);
    if (!students.length) return "";
    if (!courseCheckModel(courseCheckCohortYear(currentGrade))) return `<p class="note">현 ${currentGrade}학년: ${esc(courseCheckCohortYear(currentGrade))}학년도 입학생 편제표가 없어 점검할 수 없습니다.</p>`;
    const summary = courseCheckSummary(students, context);
    const neisLine = summary.neis ? ` · 나이스 기록 연결 ${summary.neisFound}/${summary.checked}명${summary.transfers ? `(전입 ${summary.transfers}명)` : ""}` : "";
    return `<p class="course-check-result-line"><b>현 ${currentGrade}학년 → ${Number(currentGrade) + 1}학년 과목</b> ${summary.checked}명 점검 · 위계 미충족 ${summary.violators.length}명 · 학기 학점 부족 ${summary.short.length}명 · 초과 ${summary.over.length}명 · 교과(군) 미달 ${summary.familyShort.length}명 · 국수영 기준 초과 ${summary.kemOver.length}명 · 확인 불가 ${summary.unknowns.length}명${neisLine}</p>
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
      <p class="note">이전 학년에 고른 선택 과목을 알아야 판단할 수 있는 위계(예: 3학년 물질과 에너지 ← 2학년 화학)는 이 자료가 없으면 '확인 불가'로 둡니다.
        <b>나이스 '수강학생 편성' 엑셀을 내려받은 그대로</b> 올리면 됩니다(지난 학년도·이번 학년도 파일을 함께 골라도 되고, 겹치는 행은 한 번만 셉니다). 이번 학년도 행은 학년·반·번호로, 지난 학년도 행은 성명으로 지금 학생을 찾습니다.
        성명은 연결에만 쓰고 저장하지 않습니다(학생 자리·학년도·학기·편제명·과목명·학점만 이 PC에 저장). 2단계 결과 엑셀과 같은 형식(학년·반·번호·성명 + 과목 열)도 올릴 수 있습니다.</p>
      ${courseCheckNeisSectionHtml(context)}
      <p id="courseCheckPriorStatus" role="status">${prior ? esc(`${prior.fileName || "이전 학년 결과"} · ${prior.students.length}명${prior.uploadedAt ? ` · ${prior.uploadedAt}` : ""}`) : context.settings.neis ? "" : "올린 자료 없음"}</p>
      <label class="file-button" for="courseCheckPriorInput" tabindex="0" role="button">이전 학년 이수 결과 선택(나이스 엑셀 가능)</label>
      <input class="hidden" id="courseCheckPriorInput" type="file" accept=".xlsx,.csv" multiple>
      ${prior ? '<button class="button button-quiet" type="button" id="courseCheckPriorDelete">이전 학년 자료 삭제</button>' : ""}
    </section>
    <section class="course-check-section" aria-labelledby="courseCheckRequiredTitle">
      <h3 id="courseCheckRequiredTitle">교과(군) 필수 이수 학점·총 이수 학점·국어·수학·영어 기준</h3>
      <p class="note">1단계 편제 점검표와 <b>같은 기준값</b>을 씁니다. <button class="button button-quiet course-check-settings-link" type="button" data-cc-open-settings>편제 점검 기준 설정에서 바꿉니다</button></p>
      <p class="course-check-limits">교과 ${esc(limits.subjects)} + 창의적 체험활동 ${esc(limits.creative)} = ${esc(limits.subjects + limits.creative)}학점 · 국어·수학·영어 3년 누계 ${esc(limits.kemLimit)}학점 이하(교과 ${esc(limits.subjects)}학점 초과분의 ${esc(limits.kemExtraRatio)}%까지 더 허용) — 학생별 경고만</p>
      <div class="aggregate-sheet-wrap"><table class="course-check-required-table"><caption>현 ${esc(grade)}학년 · ${esc(year)}학년도 입학생 편제표</caption><thead><tr><th scope="col">교과(군)</th><th scope="col">필수 이수(기준)</th><th scope="col">편제표 '필수이수' 열(참고)</th></tr></thead><tbody>${requiredRows}</tbody></table></div>
    </section>
    <section class="course-check-section" aria-labelledby="courseCheckResultTitle">
      <h3 id="courseCheckResultTitle">현재 차수 결과 점검</h3>
      ${results || '<p class="note">2단계에서 결과를 반영하면 학생별 점검 결과가 여기에 표시됩니다.</p>'}
    </section>
    <p id="courseCheckDialogMessage" role="status"></p>`;
}

// 편제 점검 기준 설정(교과(군) 필수 학점·총 이수 학점·국수영 상한)이 바뀌면 curriculum-compliance.js가 부른다.
function courseCheckSharedSettingsChanged() {
  courseCheckContextCache = null;
  if (document.getElementById("courseCheckDialog")?.open) courseCheckRenderDialog();
  courseCheckRefreshViews();
  if (typeof resultImportPending !== "undefined" && resultImportPending && typeof revalidateResultImport === "function") revalidateResultImport();
}

// 편제 점검표 7번(국수영) 비고: 이 입학생 편제표로 신청한 학생(현 1·2학년) 중 국수영 기준을 넘는 학생 수. 결과가 없으면 null.
function courseCheckKemOverCount(cohortYear) {
  if (typeof state === "undefined") return null;
  const grade = ["1", "2"].find((item) => courseCheckCohortYear(item) === String(cohortYear));
  if (!grade || !courseCheckModel(String(cohortYear))) return null;
  const students = (state.students || []).filter((student) => String(student.grade) === grade && (student.selections || []).length);
  if (!students.length) return null;
  const summary = courseCheckSummary(students);
  return { grade, checked: summary.checked, over: summary.kemOver.length };
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

// ---- 나이스 수강학생 편성 자료(neis-enrollment.js) 연결
// 올린 행(성명 포함)은 페이지를 새로 고치기 전까지만 메모리에 둔다(여러 파일 누적·동명이인 고르기).
// 저장은 neisEnrollmentStore의 최소 형식(학생 자리·학년도·학기·학년·편제명·과목명·학점)만 한다.
let courseCheckNeisSession = null;

function courseCheckNeisKeepGrade(person, currentYear) {
  const now = Number(person.grade) + Number(currentYear) - Number(person.year);
  return now === 1 || now === 2;
}

// "2025-1·2025-2·2026-1·2026-2(이수 중)": 이번 학년도 마지막 학기가 지금 학기면 이수 중으로 적는다.
function courseCheckNeisTermsText(store, today = new Date()) {
  const latest = store.terms.at(-1) || "";
  const [year, semester] = latest.split("-");
  const month = today.getMonth() + 1;
  const inProgress = year === store.currentYear && (semester === "2" ? month >= 8 || month <= 2 : month >= 3 && month <= 7);
  return store.terms.map((term) => `${term}${inProgress && term === latest ? "(이수 중)" : ""}`).join("·");
}

// 팝업 '이전 학년 이수 결과' 칸의 나이스 요약·동명이인 고르기·안내.
function courseCheckNeisSectionHtml(context) {
  const raw = context.settings.neis;
  if (!raw) return "";
  const esc = courseCheckEscape;
  const counts = raw.counts;
  const unlinked = counts.unlinked + counts.masked + counts.ambiguous;
  const lines = [`<p class="course-check-neis-status" id="courseCheckNeisStatus" role="status"><b>나이스 자료: ${esc(courseCheckNeisTermsText(raw))}</b> · 연결 ${esc(counts.linked)}명 · 미재학 ${esc(counts.withdrawn)}명 · 전입 ${esc(counts.transfers)}명 · 연결 안 됨 ${esc(unlinked)}명
    <button class="button button-quiet" type="button" id="courseCheckNeisDelete">나이스 자료 삭제</button></p>`];
  if (raw.currentYear !== context.schoolYear) {
    lines.push(`<p class="note course-check-differs">나이스 자료는 ${esc(raw.currentYear)}학년도 기준이라 지금 학년도(${esc(context.schoolYear)})에는 쓰지 않습니다. ${esc(context.schoolYear)}학년도 파일을 다시 올리세요.</p>`);
  }
  if (counts.masked) lines.push(`<p class="note">성명이 가려진 자료(예: 김00)라 지난 학년도 기록 ${esc(counts.masked)}명은 이름으로 잇지 않았습니다. 나이스에서 성명이 보이게 내려받은 파일을 올리면 연결됩니다.</p>`);
  if (raw.kept?.length) lines.push(`<p class="note">${esc(raw.kept.join("·"))} 기록은 예전에 올린 자료입니다(성명을 저장하지 않아 이번에 다시 잇지 않았습니다).</p>`);
  const link = courseCheckNeisSession?.link;
  if (link) {
    const ambiguous = link.ambiguous.filter((item) => courseCheckNeisKeepGrade(item.person, link.currentYear));
    if (ambiguous.length) {
      const seatText = (seat) => {
        const [g, c, n] = seat.split("-");
        const student = (state.students || []).find((item) => String(item.grade) === g && String(Number(item.classroom)) === c && String(Number(item.number)) === n);
        return `현 ${g}학년 ${c}반 ${n}번${student ? ` ${student.name}` : ""}`;
      };
      lines.push(`<details class="course-check-neis-choices" open><summary>동명이인 ${ambiguous.length}명 — 지금 학생을 직접 고르세요</summary>
        <ul>${ambiguous.map((item) => {
          const person = item.person;
          const terms = [...new Set(person.records.map((record) => `${record.year}-${record.semester}`))].sort().join("·");
          return `<li><label>${esc(`${person.year}학년도 ${person.grade}학년 ${person.classroom}반 ${person.number}번 ${person.name} (${terms}, ${person.records.length}과목)`)}
            <select data-cc-neis-choice="${esc(item.id)}"><option value="">고르세요</option>${item.candidates.map((seat) => `<option value="${esc(seat)}">${esc(seatText(seat))}</option>`).join("")}<option value="none">연결 안 함</option></select></label></li>`;
        }).join("")}</ul></details>`);
    }
    const others = link.unlinked.filter((item) => item.reason === "no-match" && courseCheckNeisKeepGrade(item.person, link.currentYear));
    const withdrawn = link.withdrawn.filter((person) => courseCheckNeisKeepGrade(person, link.currentYear));
    if (others.length || withdrawn.length) {
      const label = (person) => `${person.year}학년도 ${person.grade}학년 ${person.classroom}반 ${person.number}번 ${person.name}`;
      lines.push(`<details class="course-check-neis-unlinked"><summary>연결하지 않은 기록 보기(미재학 ${withdrawn.length}건 · 지금 학생을 찾지 못함 ${others.length}건)</summary>
        ${withdrawn.length ? `<p class="note">미재학(학적 변동) — 점검에서 뺍니다: ${esc(withdrawn.slice(0, 30).map(label).join(", "))}${withdrawn.length > 30 ? ` 외 ${withdrawn.length - 30}건` : ""}</p>` : ""}
        ${others.length ? `<p class="note">지난 학년도 기록과 같은 이름의 지금 학생이 없음(이름 변경·전출 등): ${esc(others.slice(0, 30).map((item) => label(item.person)).join(", "))}${others.length > 30 ? ` 외 ${others.length - 30}건` : ""}</p>` : ""}
      </details>`);
    }
  } else if (counts.ambiguous) {
    lines.push(`<p class="note">동명이인 ${esc(counts.ambiguous)}명은 아직 연결하지 않았습니다. 같은 파일들을 다시 올리면 직접 고를 수 있습니다(성명은 저장하지 않습니다).</p>`);
  }
  if (!raw.terms.some((term) => term.startsWith(`${raw.currentYear}-`))) {
    lines.push(`<p class="note">${esc(raw.currentYear)}학년도 파일이 없어 지난 학년도 기록을 지금 학생에게 잇지 못했습니다. 두 학년도 파일을 함께 올리세요.</p>`);
  }
  return lines.join("");
}

// 세션에 쌓인 나이스 행으로 다시 연결해 저장한다.
function courseCheckNeisRelink(files = []) {
  const session = courseCheckNeisSession;
  const context = courseCheckContext();
  const link = neisEnrollmentLink(session.records, { currentYear: context.schoolYear, keyOf: courseCheckKey, rules: context.active, choices: session.choices });
  session.link = link;
  const store = neisEnrollmentStore(link, { files, previous: context.settings.neis || null });
  courseCheckSaveSettings((settings) => { settings.neis = store; });
  return { link, store };
}

function courseCheckApplyNeis(items) {
  if (typeof neisEnrollmentLink !== "function") throw new Error("나이스 자료 읽기 기능을 불러오지 못했습니다.");
  // 저장분이 없으면(전체 초기화·삭제 뒤) 메모리의 예전 행도 버린다.
  if (!courseCheckContext().settings.neis || !courseCheckNeisSession) courseCheckNeisSession = { records: [], choices: {}, link: null };
  const session = courseCheckNeisSession;
  const uploadedAt = new Date().toLocaleString("ko-KR");
  for (const { parsed } of items) session.records.push(...parsed.records);
  session.records = neisEnrollmentDedupe(session.records, courseCheckKey);
  const { link, store } = courseCheckNeisRelink(items.map(({ file, parsed }) => ({ name: file.name, uploadedAt, terms: parsed.terms })));
  const rows = items.reduce((sum, { parsed }) => sum + parsed.records.length, 0);
  const counts = store.counts;
  const notes = [];
  if (!link.students.size) notes.push(`${link.currentYear}학년도 행이 없어 학생과 잇지 못했습니다. ${link.currentYear}학년도 파일도 함께 올리세요.`);
  if (counts.masked) notes.push(`성명이 가려져 지난 학년도 기록 ${counts.masked}명은 잇지 않았습니다.`);
  if (counts.ambiguous) notes.push(`동명이인 ${counts.ambiguous}명은 아래에서 직접 고르세요.`);
  return `나이스 수강학생 편성 ${items.length}개 파일(${rows}행, ${store.terms.join("·")})을 반영했습니다. 현 1·2학년 연결 ${counts.linked}명 · 미재학 ${counts.withdrawn}명 · 전입 ${counts.transfers}명.${notes.length ? ` ${notes.join(" ")}` : ""}`;
}

async function courseCheckReadUpload(file) {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".csv")) {
    if (typeof neisEnrollmentCsvRows !== "function") throw new Error("CSV 읽기 기능을 불러오지 못했습니다.");
    return [{ name: file.name, rows: neisEnrollmentCsvRows(neisEnrollmentDecode(await file.arrayBuffer())) }];
  }
  if (!lower.endsWith(".xlsx")) throw new Error(`${file.name}: .xlsx 또는 .csv 파일만 올릴 수 있습니다.`);
  if (typeof parseWorkbook !== "function") throw new Error("엑셀 읽기 기능을 불러오지 못했습니다.");
  return parseWorkbook(await file.arrayBuffer());
}

// 이전 학년 이수 결과 올리기: 나이스 수강학생 편성 파일은 자동으로 알아보고(여러 개 누적), 그 밖의 파일은 2단계 결과 형식으로 읽는다.
async function courseCheckUploadPrior(fileList) {
  const files = [...(fileList || [])];
  const grade = String(state.applicationMenuGrade || "1");
  const year = courseCheckCohortYear(grade);
  try {
    const neis = [], others = [];
    for (const file of files) {
      const sheets = await courseCheckReadUpload(file);
      const parsed = typeof neisEnrollmentParse === "function" ? neisEnrollmentParse(sheets) : null;
      if (parsed?.records.length) neis.push({ file, parsed });
      else others.push({ file, sheets });
    }
    const messages = [];
    if (neis.length) messages.push(courseCheckApplyNeis(neis));
    if (others.length) {
      const { file, sheets } = others[0];
      let students;
      try { students = courseCheckPriorStudents(sheets, grade); }
      catch (error) {
        if (!messages.length) throw error;
        courseCheckSettingsChanged(`${messages.join(" ")} ${file.name}: ${error?.message || error}`);
        return;
      }
      courseCheckSaveSettings((settings) => {
        settings.prior[year] = { fileName: file.name, uploadedAt: new Date().toLocaleString("ko-KR"), students };
      });
      courseCheckContextCache = null;
      const current = (state.students || []).filter((student) => String(student.grade) === grade);
      const index = courseCheckPriorIndex(courseCheckContext(), year, grade);
      const found = current.filter((student) => index?.find(student)).length;
      messages.push(`이전 학년 이수 결과 ${students.length}명을 반영했습니다.${current.length ? ` 현재 결과 ${current.length}명 중 ${found}명과 연결했습니다.` : ""}${others.length > 1 ? ` (결과 형식 파일은 첫 파일 ${file.name}만 읽었습니다.)` : ""}`);
    }
    courseCheckSettingsChanged(messages.join(" "));
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
    const prereq = event.target.closest?.('[data-open-dialog="prereqStudentsDialog"]');
    if (prereq) courseCheckOpenStudentsDialog(prereq);
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
    } else if (event.target.closest("[data-cc-open-settings]")) {
      // 기준값은 1단계 '편제 점검 기준 설정' 한 곳에서 고친다(이 팝업 위에 그 설정 팝업을 연다).
      if (typeof openPlanComplianceSettings === "function") openPlanComplianceSettings();
    } else if (event.target.closest("#courseCheckNeisDelete")) {
      courseCheckNeisSession = null;
      courseCheckSaveSettings((settings) => { delete settings.neis; });
      courseCheckSettingsChanged("나이스 수강학생 편성 자료를 삭제했습니다.");
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
    } else if (event.target.id === "courseCheckPriorInput") {
      const files = [...(event.target.files || [])];
      event.target.value = "";
      if (files.length) courseCheckUploadPrior(files);
    } else if (event.target.closest("[data-cc-neis-choice]")) {
      const select = event.target.closest("[data-cc-neis-choice]");
      if (!courseCheckNeisSession || !select.value) return;
      courseCheckNeisSession.choices[select.dataset.ccNeisChoice] = select.value;
      const { store } = courseCheckNeisRelink();
      courseCheckSettingsChanged(`동명이인 연결을 반영했습니다. 남은 동명이인 ${store.counts.ambiguous}명.`);
    }
  });
}

if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initCourseChecks);
  else initCourseChecks();
}
