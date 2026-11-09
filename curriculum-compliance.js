"use strict";
// 1단계 편제 점검표·편성 영역·교과(군) 편성 통계.
// 울산광역시교육청 「2022 개정 고등학교 교육과정 편제 점검 프로그램(2026)」의 '점검표'(자동 점검 20개 + 자체 점검 4개)와
// '과목편성 통계'를 편제표 데이터(planData: 과목·학기 학점·선택과목군·학기 칸 메모)로 계산한다.
// 위쪽은 화면·저장과 무관한 순수 계산(테스트가 '앱 연결' 줄 앞까지 잘라 쓴다), 아래는 1단계 화면 연결이다.
// 과목 정보(공식 과목명·학점 범위)는 curriculum-subject-list.js, 위계 규칙은 course-checks.js(있으면)를 쓴다.

var PLAN_COMPLIANCE_FIELDS = ["sem11", "sem12", "sem21", "sem22", "sem31", "sem32"];
var PLAN_COMPLIANCE_ETC = "기술·가정/정보/제2외국어/한문/교양";
var PLAN_COMPLIANCE_FAMILIES = ["국어", "수학", "영어", "한국사", "사회", "과학", "체육", "예술", PLAN_COMPLIANCE_ETC];
var PLAN_COMPLIANCE_KEM = ["국어", "수학", "영어"];
// 편성 영역: 학교지정 / 학생선택(택n) / 교차집중(↔) / 소인수·공동교육과정(학기 칸 메모, 순증)
var PLAN_COMPLIANCE_DOMAINS = ["학교지정", "학생선택", "교차집중", "소인수·공동"];
var PLAN_COMPLIANCE_DOMAIN_SHORT = { "학교지정": "지정", "학생선택": "선택", "교차집중": "교차", "소인수·공동": "공동" };
// 과목 데이터에 저장하는 코드(subject.planSection, 교사가 정하면 subject.planSectionManual = true). 교육청 양식 내보내기도 같은 코드를 쓴다.
var PLAN_SECTION_CODES = { school: "학교지정", choice: "학생선택", cross: "교차집중", extra: "소인수·공동" };
var PLAN_SECTION_BY_LABEL = { "학교지정": "school", "학생선택": "choice", "교차집중": "cross", "소인수·공동": "extra" };
var PLAN_COMPLIANCE_SUNEUNG = ["화법과 언어", "독서와 작문", "문학", "대수", "미적분Ⅰ", "확률과 통계", "영어Ⅰ", "영어Ⅱ",
  "한국사1", "한국사2", "통합사회1", "통합사회2", "통합과학1", "통합과학2"];
var PLAN_COMPLIANCE_HISTORY = ["세계사", "동아시아 역사 기행", "역사로 탐구하는 현대 세계"];
// 기준값(교육청마다 다를 수 있어 설정 팝업에서 고친다). 울산 '지침' 시트 기준.
var PLAN_COMPLIANCE_DEFAULTS = {
  subjects: 174, creative: 18,
  required: { "국어": 8, "수학": 8, "영어": 8, "한국사": 6, "사회": 8, "과학": 10, "체육": 10, "예술": 10, [PLAN_COMPLIANCE_ETC]: 16 },
  kemLimit: 81, kemExtraRatio: 50, semesterGap: 5, peTotal: 10, peEverySemester: true, specialization: 27,
  suneung: PLAN_COMPLIANCE_SUNEUNG
};
// 7번(국수영 81학점) 인정 오류 사유 제안 문구. 편성 단계 최대는 선택 조합에 따른 값이라, 학생별 실제 선택은 2단계 이수학점 점검에서 본다.
var PLAN_COMPLIANCE_KEM_SUGGESTION = "선택과목 조합에 따라 초과 가능 — 학생별 점검으로 관리";
// 울산 점검표 문구(연번·영역·점검 내용). kind: auto(자동) / self(자체 점검)
var PLAN_COMPLIANCE_ITEMS = [
  { no: 1, id: "a1", area: "이수학점", text: "교과와 창의적 체험활동의 총 이수 학점 수가 교육과정 편성 기준에 맞게 편성하였는가?", hint: "창의적 체험활동 교육과정은 18학점(288시간) 이상의 시수를 편성･운영하되, 특정 학년이나 학기에 편중하여 편성하지 않아야 함." },
  { no: 2, id: "a2", area: "이수학점", text: "교과(군)별 필수 이수학점은 준수하였는가?" },
  { no: 3, id: "a3", area: "이수학점", text: "각 교과목별 학점수가 기준 학점과 증감 범위를 준수하였는가?" },
  { no: 4, id: "a4", area: "이수학점", text: "공통과목을 ‘감’했을 경우 1학점을 초과하지 않았는가?" },
  { no: 5, id: "a5", area: "이수학점", text: "과학탐구실험 이수학점 증감 없이 편성하였는가?" },
  { no: 6, id: "a6", area: "이수학점", text: "학기 간 학점의 격차가 5학점을 초과하여 차이나지 않도록 편성하였는가?" },
  { no: 7, id: "a7", area: "이수학점", text: "국어, 수학, 영어의 편성 비율을 준수하였는가?", hint: "81학점을 초과하지 않고, 총 이수학점이 174학점을 초과하는 경우 초과 이수 학점의 50%를 넘지 않도록 한다." },
  { no: 8, id: "a8", area: "교과목", text: "과목 개설 시 2022 개정 교육과정 적용 교과목으로 편성하였는가?" },
  { no: 9, id: "a9", area: "교과목", text: "2022 개정 교육과정에 명기된 교과목 명을 정확히 사용하였는가?(띄어쓰기, 오탈자 등)" },
  { no: 10, id: "a10", area: "이수시기", text: "공통 과목은 해당 교과(군)의 선택 과목 이수 전에 이수 가능하도록 편성하였는가?" },
  { no: 11, id: "a11", area: "이수시기", text: "한국사1(3학점), 한국사2(3학점)을 역사 교과 선택과목 보다 먼저 편성하였는가?" },
  { no: 12, id: "a12", area: "이수시기", text: "체육은 10학점 이상, 매 학기에 편성하였는가?" },
  { no: 13, id: "a13", area: "이수시기", text: "수능 전 학습 진도 종료가 가능한가?(3학년 2학기 수능 교과 편성 시)" },
  { no: 14, id: "a14", area: "이수시기", text: "동일학년, 동일과목은 이수학점을 동일하게 편성(입학년도가 다른 경우는 가능)하였는가?" },
  { no: 15, id: "a15", area: "위계성", text: "선택과목 중 위계성이 있는 과목의 경우 계열적 학습이 가능하도록 편성하였는가?", hint: "특히 수학, 영어, 과학 교과와 실무과목 등 위계성을 확인하여 편성" },
  { no: 16, id: "a16", area: "과목선택", text: "제2외국어 교과 개설 시 학생들의 선택권을 고려하여 개설하였는가?" },
  { no: 17, id: "a17", area: "과목선택", text: "학교 지정 교육과정(선택권 미부여) 과목과 학생선택교육과정 과목 재편성(중복 편성) 여부" },
  { no: 18, id: "a18", area: "과목선택", text: "종교 과목은 교양 교과군의 다른 과목과 복수로 편성하여 학생의 실질적인 선택권을 보장하였는가?" },
  { no: 19, id: "a19", area: "기타", text: "학생 희망과 진로를 반영한 교육과정이 될 수 있도록 학생의 과목 선택권 보장" },
  { no: 20, id: "a20", area: "기타", text: "대학수학능력시험 출제 범위에 해당하는 과목을 공통(필수), 또는 선택 이수하도록 모두 편성하여 학생의 선택권을 보장" }
];
var PLAN_COMPLIANCE_SELF_ITEMS = [
  { no: 1, id: "s1", area: "교과목", text: "전문교과 개설 시 진로 선택 과목으로 편성하였는가?" },
  { no: 2, id: "s2", area: "과목선택", text: "소속학교의 과목 개설이 어려울 경우 타학교와 공동 교육과정을 운영하여 이수하는가?" },
  { no: 3, id: "s3", area: "기타", text: "3년간 이수할 과목 학년별, 학기별 편성, 학생과 학부모 안내" },
  { no: 4, id: "s4", area: "교과특성화", text: "교과특성화 과정 교과(군) 관련 과목 기준을 준수하여 편성하였는가?", hint: "자율 이수 학점의 30%(27학점) 이상을 해당 교과(군)의 과목으로 편성" }
];
// 전학년 편제표(학년마다 입학연도가 다름)에서 계산하는 항목. 나머지는 입학생 편제표에서 점검한다.
var PLAN_COMPLIANCE_ANNUAL_ITEMS = ["a3", "a4", "a5", "a8", "a9", "a12", "a13"];

function planComplianceObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function planComplianceNumber(value) {
  const number = Number(String(value ?? "").replace(/,/g, "").trim());
  return String(value ?? "").trim() !== "" && Number.isFinite(number) ? number : null;
}

function planComplianceRound(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function planComplianceFieldLabel(field, short = false) {
  const grade = String(field).slice(3, 4), semester = String(field).slice(4, 5);
  return short ? `${grade}-${semester}` : `${grade}학년 ${semester}학기`;
}

// 과목명 비교 키: 표기 기호·가운뎃점·띄어쓰기를 빼고 로마숫자를 숫자로 맞춘다(공식 목록과 같은 규칙).
function planComplianceNameKey(name) {
  if (typeof curriculumOfficialSubjectKey === "function") return curriculumOfficialSubjectKey(name);
  return String(name ?? "").replace(/[ⅠⅡⅢⅣⅤ]/g, (char) => String("ⅠⅡⅢⅣⅤ".indexOf(char) + 1)).normalize("NFKC")
    .replace(/[*＊★☆■↔]/g, "").replace(/[⋅·•ㆍ∙‧]/g, "").replace(/\s+/g, "").toLowerCase();
}

// 표기만 비교(가운뎃점 모양·별표는 같게 본다). 띄어쓰기·로마숫자·오탈자 차이는 다르게 본다.
function planComplianceSpelling(name) {
  return String(name ?? "").normalize("NFC").replace(/[*＊★☆■]/g, "").replace(/[⋅·•ㆍ∙‧]/g, "·").replace(/\s+/g, " ").trim();
}

// 편제표 과목 칸(쉼표로 여러 과목)을 나눈다. 표기 기호는 따로 기억한다(*: 특목고 과목, ★: 전문교과, ☆: 고시 외, ■: 교과특성화).
function planComplianceSplitNames(raw) {
  return String(raw ?? "").split(/[,，、]/).map((part) => {
    const text = part.replace(/↔/g, " ");
    const name = text.replace(/[*＊★☆■]/g, "").replace(/\s+/g, " ").trim();
    return { raw: part.trim(), name, key: planComplianceNameKey(name),
      marks: { special: /[*＊]/.test(text), vocational: /★/.test(text), unlisted: /☆/.test(text), specialization: /■/.test(text) } };
  }).filter((item) => item.name && !/소계|합계|총이수|이수학점|창의적체험|과목명|세부과목|교육과정|표기방법/.test(item.key) &&
    !["공통", "일반", "진로", "융합"].includes(item.name));
}

function planComplianceOfficial(name) {
  return typeof findCurriculumOfficialSubject === "function" ? findCurriculumOfficialSubject(name) : null;
}

function planComplianceDistance(a, b) {
  if (a === b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return previous[b.length];
}

// 목록에 없는 과목명에 가장 가까운 공식 과목명(오탈자 제안). 짧은 이름은 한 글자, 긴 이름은 두 글자까지 다른 것만 본다.
let planComplianceOfficialNames = null;
function planComplianceSuggest(name) {
  const key = planComplianceNameKey(name);
  if (key.length < 2 || typeof CURRICULUM_OFFICIAL_SUBJECT_ROWS === "undefined") return null;
  if (!planComplianceOfficialNames) {
    const seen = new Map();
    for (const [official] of CURRICULUM_OFFICIAL_SUBJECT_ROWS) {
      const officialKey = planComplianceNameKey(official);
      if (!seen.has(officialKey)) seen.set(officialKey, planComplianceSpelling(official));
    }
    planComplianceOfficialNames = [...seen];
  }
  const limit = key.length <= 4 ? 1 : 2;
  let best = null;
  for (const [officialKey, official] of planComplianceOfficialNames) {
    if (Math.abs(officialKey.length - key.length) > limit) continue;
    const distance = planComplianceDistance(key, officialKey);
    if (distance <= limit && (!best || distance < best.distance)) best = { name: official, distance };
  }
  return best ? best.name : null;
}

// 교과(군): 울산 점검표의 9개(한국사는 사회와 따로, 기술·가정/정보/제2외국어/한문/교양은 하나로).
function planComplianceFamily(area, name = "") {
  const key = planComplianceNameKey(name);
  if (/^한국사[12]?$/.test(key)) return "한국사";
  const text = String(area ?? "").replace(/\s+/g, "");
  if (/한국사/.test(text)) return "한국사";
  if (/외국어|한문|기술|가정|정보|교양/.test(text)) return PLAN_COMPLIANCE_ETC;
  if (/국어/.test(text)) return "국어";
  if (/수학/.test(text)) return "수학";
  if (/영어/.test(text)) return "영어";
  if (/사회|역사|도덕|윤리|지리/.test(text)) return "사회";
  if (/과학/.test(text)) return "과학";
  if (/체육/.test(text)) return "체육";
  if (/예술|음악|미술|연극/.test(text)) return "예술";
  const official = planComplianceOfficial(name);
  const area2 = String(official?.area || "");
  if (/외국어‧국제계열\(영어\)/.test(area2)) return "영어";
  if (/외국어|한문|기술|정보|교양/.test(area2)) return PLAN_COMPLIANCE_ETC;
  if (/수학/.test(area2)) return "수학";
  if (/과학/.test(area2)) return "과학";
  if (/국어/.test(area2)) return "국어";
  if (/영어/.test(area2)) return "영어";
  if (/사회/.test(area2)) return "사회";
  if (/체육/.test(area2)) return "체육";
  if (/예술/.test(area2)) return "예술";
  return "기타";
}

// 학기 칸 메모('소인수/2학년/1학기/3학점(순증)', '공동,소인수/2학년/1,2학기/3학점')를 읽는다.
function planComplianceParseNote(note) {
  const text = String(note ?? "").trim();
  if (!text) return null;
  const grade = text.match(/([123])\s*학년/)?.[1] || "";
  const semesters = (text.match(/([12](?:\s*[,·]\s*[12])*)\s*학기/)?.[1] || "").split(/[,·]/).map((part) => part.trim()).filter(Boolean);
  const credit = Number(text.match(/(\d+(?:\.\d+)?)\s*학점/)?.[1]) || 0;
  return { text, kind: /공동/.test(text) ? "공동" : /소인수/.test(text) ? "소인수" : "", grade, semesters,
    fields: grade ? semesters.map((semester) => `sem${grade}${semester}`).filter((field) => PLAN_COMPLIANCE_FIELDS.includes(field)) : [], credit };
}

// 행 단위 편성 영역 키(과목명 칸 전체). 교사가 바꾼 영역을 이 키로 저장한다.
function planComplianceRowKey(name) {
  return planComplianceSplitNames(name).map((item) => item.key).join(",");
}

// 편성 영역 자동 추정: 학기 칸 메모(소인수·공동) → 소인수·공동, 선택과목군(택n) → 학생선택, 교차(↔) → 교차집중,
// 구분 칸이 '공동·소인수'/'학생 선택'이면 그 영역, 나머지는 학교지정.
function planSectionAuto(subject, plan) {
  const text = (value) => String(value ?? "");
  if (text(subject?.note).trim()) return "extra";
  const inGroup = (plan?.groups || []).some((group) => (group.members || []).includes(subject?.id));
  if (inGroup) return "choice";
  if (subject?.cross?.length || /↔/.test(text(subject?.name))) return "cross";
  const category = text(subject?.category).replace(/\s+/g, "");
  if (/공동|소인수/.test(category)) return "extra";
  if (/학생선택|^학생/.test(category)) return "choice";
  return "school";
}

// 과목 하나의 편성 영역 코드(school/choice/cross/extra). 교사가 정한 값(planSectionManual)이 있으면 그 값, 없으면 자동 추정.
function curriculumPlanSection(subject, plan) {
  if (subject?.planSectionManual && Object.hasOwn(PLAN_SECTION_CODES, subject.planSection)) return subject.planSection;
  return planSectionAuto(subject, plan);
}

function planComplianceNormalizeSettings(value) {
  const source = planComplianceObject(value) ? value : {};
  const number = (item, fallback, max = 400) => {
    const parsed = planComplianceNumber(item);
    return parsed !== null && parsed >= 0 && parsed <= max ? parsed : fallback;
  };
  const required = {};
  const savedRequired = planComplianceObject(source.required) ? source.required : {};
  for (const family of PLAN_COMPLIANCE_FAMILIES) required[family] = number(savedRequired[family], PLAN_COMPLIANCE_DEFAULTS.required[family], 200);
  const suneung = Array.isArray(source.suneung)
    ? [...new Set(source.suneung.map((item) => String(item ?? "").replace(/\s+/g, " ").trim()).filter((item) => item && item.length < 60))].slice(0, 60)
    : PLAN_COMPLIANCE_DEFAULTS.suneung.slice();
  return {
    subjects: number(source.subjects, PLAN_COMPLIANCE_DEFAULTS.subjects), creative: number(source.creative, PLAN_COMPLIANCE_DEFAULTS.creative),
    required, kemLimit: number(source.kemLimit, PLAN_COMPLIANCE_DEFAULTS.kemLimit), kemExtraRatio: number(source.kemExtraRatio, PLAN_COMPLIANCE_DEFAULTS.kemExtraRatio, 100),
    semesterGap: number(source.semesterGap, PLAN_COMPLIANCE_DEFAULTS.semesterGap, 60), peTotal: number(source.peTotal, PLAN_COMPLIANCE_DEFAULTS.peTotal, 100),
    peEverySemester: source.peEverySemester === undefined ? true : Boolean(source.peEverySemester),
    specialization: number(source.specialization, PLAN_COMPLIANCE_DEFAULTS.specialization), suneung
  };
}

// 저장 자료(state.curriculumCompliance): 기준값 + 편제표별(cohort:연도 / annual:연도) 인정 오류·자체 점검.
// 편성 영역은 과목 데이터(subject.planSection·planSectionManual)에 저장한다.
function planComplianceNormalizeState(value) {
  const source = planComplianceObject(value) ? value : {};
  const text = (item, max = 300) => String(item ?? "").replace(/\r\n?/g, "\n").slice(0, max);
  const itemIds = new Set(PLAN_COMPLIANCE_ITEMS.map((item) => item.id));
  const selfIds = new Set(PLAN_COMPLIANCE_SELF_ITEMS.map((item) => item.id));
  const plans = {};
  for (const [key, plan] of Object.entries(planComplianceObject(source.plans) ? source.plans : {})) {
    if (!/^(?:cohort|annual):\d{4}$/.test(key) || !planComplianceObject(plan)) continue;
    const ack = {}, self = {};
    for (const [id, entry] of Object.entries(planComplianceObject(plan.ack) ? plan.ack : {})) {
      if (itemIds.has(id) && planComplianceObject(entry) && (entry.on || String(entry.reason ?? "").trim())) ack[id] = { on: Boolean(entry.on), reason: text(entry.reason) };
    }
    for (const [id, entry] of Object.entries(planComplianceObject(plan.self) ? plan.self : {})) {
      if (selfIds.has(id) && planComplianceObject(entry) && (entry.checked || String(entry.memo ?? "").trim())) self[id] = { checked: Boolean(entry.checked), memo: text(entry.memo) };
    }
    if (Object.keys(ack).length || Object.keys(self).length) plans[key] = { ack, self };
  }
  const result = { plans };
  if (planComplianceObject(source.settings)) result.settings = planComplianceNormalizeSettings(source.settings);
  return result;
}

// 편제표 제목(머리글)의 학년도와 교육과정 개정을 판별한다. 2025학년도 입학생부터 2022 개정 교육과정이다.
function planComplianceRevision(layout, cohortYear) {
  const header = (layout?.planTemplate?.header?.rows || layout?.rows?.slice(0, 3) || [])
    .map((row) => (row || []).find((value) => String(value ?? "").trim()) || "").join(" ");
  const titleYear = header.match(/(20\d{2})\s*학년도/)?.[1] || "";
  const explicit = header.match(/(2015|2022)\s*개정/)?.[1] || "";
  const year = Number(titleYear || cohortYear) || 0;
  const revision = explicit || (year ? (year >= 2025 ? "2022" : "2015") : "2022");
  return { revision, titleYear, cohortYear: String(cohortYear || ""),
    mismatch: Boolean(titleYear && cohortYear && !layout?.derived && titleYear !== String(cohortYear)) };
}

// 점검 모델: 행(과목)·선택과목군·학기 학점.
//  · 학교지정·교차집중 행: 학기 칸 학점이 모든 학생의 이수 학점(한 행에 과목이 여럿이면 학기 학점은 한 번만 센다)
//  · 선택과목군: 학기(들) × 택 수 × 과목당 학점. 학생별 최소·최대는 교과(군)별 선택지 수로 계산한다.
//  · 학생선택(묶음 없음) 행: 고를 수도 안 고를 수도 있는 과목(최소 0)
//  · 소인수·공동 행(학기 칸 메모): 순증 과목이라 학기 합계·총 이수 학점에서 뺀다.
// options.sections: { 행 키: 영역 코드 } (전학년 편제표가 원본 입학생 편제표에서 물려받는 교사 지정값), options.grades: 계산할 학년(전학년 편제표의 2022 개정 학년만)
function planComplianceModel(planData, options = {}) {
  const sections = planComplianceObject(options.sections) ? options.sections : {};
  const gradeAllowed = (field) => !options.grades || options.grades.includes(String(field).slice(3, 4));
  const rawGroups = Array.isArray(planData?.groups) ? planData.groups : [];
  const rows = [];
  const byId = new Map();
  for (const subject of planData?.subjects || []) {
    if (!subject || subject.fixed) continue;
    const names = planComplianceSplitNames(subject.name).map((item) => {
      const official = planComplianceOfficial(item.name);
      const type = official ? (official.category === "전문교과" ? "진로선택" : official.type) : String(subject.kind || "");
      return { ...item, official, type };
    });
    if (!names.length) continue;
    const memberships = rawGroups.filter((group) => (group.members || []).includes(subject.id));
    const groupFields = new Set(memberships.flatMap((group) => group.fields || []));
    const designated = {};
    for (const field of PLAN_COMPLIANCE_FIELDS) {
      if (groupFields.has(field) || !gradeAllowed(field)) continue;
      const credit = Number(subject.credits?.[field]);
      if (credit > 0) designated[field] = credit;
    }
    const note = planComplianceParseNote(subject.note);
    if (note) note.fields = note.fields.filter(gradeAllowed);
    const rowKey = planComplianceRowKey(subject.name);
    const auto = PLAN_SECTION_CODES[planSectionAuto(subject, planData)];
    const inherited = !subject.planSectionManual && Object.hasOwn(PLAN_SECTION_CODES, sections[rowKey]) ? sections[rowKey] : "";
    const domain = PLAN_SECTION_CODES[inherited || curriculumPlanSection(subject, planData)];
    const crossed = Boolean(subject.cross?.length) || /↔/.test(String(subject.name ?? ""));
    const total = Object.values(designated).reduce((sum, credit) => sum + credit, 0);
    const role = note || domain === "소인수·공동" ? "extra" : domain === "학생선택" && !memberships.length ? "optional" : "required";
    const row = {
      id: subject.id, rawName: String(subject.name ?? ""), names, rowKey, area: String(subject.area ?? "").replace(/\s+/g, " ").trim(),
      family: planComplianceFamily(subject.area, names[0].name), kind: String(subject.kind || ""), category: String(subject.category ?? "").replace(/\s+/g, " ").trim(),
      domain, domainAuto: auto, overridden: Boolean(subject.planSectionManual || inherited) && domain !== auto, manual: Boolean(subject.planSectionManual), crossed, designated, total, groups: memberships.map((group) => group.id), note, role,
      base: planComplianceNumber(subject.base), op: planComplianceNumber(subject.op),
      // 과목 하나의 학점: 교차집중(과목 여럿이 학기를 나눔)은 학기 학점 합 ÷ 과목 수
      unitCredit: crossed && names.length > 1 ? total / names.length : total
    };
    rows.push(row);
    byId.set(subject.id, row);
  }
  const groups = rawGroups.map((group, index) => {
    const fields = (group.fields || []).filter((field) => PLAN_COMPLIANCE_FIELDS.includes(field) && gradeAllowed(field)).sort();
    const optionMap = new Map();
    for (const id of group.members || []) {
      const row = byId.get(id);
      if (!row) continue;
      for (const name of row.names) if (!optionMap.has(name.key)) optionMap.set(name.key, { ...name, family: row.family, rowId: row.id });
    }
    const pick = Math.max(1, Number(group.pick) || 1);
    const label = `${fields.map((field) => planComplianceFieldLabel(field, true)).join("·")} 택${pick}`;
    // 학점을 학기 칸에서 읽지 못한 묶음(0)은 구성 과목 운영학점을 쓴다(curriculum-data.js와 같은 규칙).
    const credit = Number(group.credit) > 0 ? Number(group.credit)
      : typeof planDataGroupCredit === "function" ? planDataGroupCredit(planData, group) : 0;
    return { id: group.id || `g${index}`, fields, pick, credit, options: [...optionMap.values()], label };
  }).filter((group) => group.fields.length && group.options.length);
  const labelCounts = new Map();
  for (const group of groups) labelCounts.set(group.label, (labelCounts.get(group.label) || 0) + 1);
  const labelOrder = new Map();
  for (const group of groups) {
    if (labelCounts.get(group.label) < 2) continue;
    const order = (labelOrder.get(group.label) || 0) + 1;
    labelOrder.set(group.label, order);
    group.label = `${group.label}-${order}`;
  }
  // 과목이 놓인 자리(이수 순서·학년별 학점·수능 과목 점검에 쓴다)
  const placements = [];
  for (const row of rows) {
    for (const [field, credit] of Object.entries(row.designated)) {
      for (const name of row.names) placements.push({ ...name, field, credit, unit: row.unitCredit, family: row.family, rowId: row.id, source: row.role === "required" ? "designated" : row.role });
    }
    if (row.note) {
      for (const field of row.note.fields) for (const name of row.names) {
        placements.push({ ...name, field, credit: row.note.credit, unit: row.note.credit * row.note.fields.length, family: row.family, rowId: row.id, source: "extra" });
      }
    }
  }
  for (const group of groups) {
    for (const field of group.fields) for (const option of group.options) {
      placements.push({ ...option, field, credit: group.credit, unit: group.credit * group.fields.length, groupId: group.id, source: "group" });
    }
  }
  return { rows, groups, placements };
}

function planComplianceFamilyRange(group, families) {
  const inside = group.options.filter((option) => families.includes(option.family)).length;
  const outside = group.options.length - inside;
  return { min: Math.max(0, group.pick - outside) * group.credit, max: Math.min(group.pick, inside) * group.credit };
}

// 선택과목군 전체에서 한 학생이 이수할 수 있는 해당 교과(군) 학점 최소~최대(같은 과목은 묶음이 달라도 한 번만 고른다).
// 묶음마다 택 수를 모두 채우고 과목마다 한 번만 쓰는 배정을 최소 비용 유량(묶음 → 과목)으로 풀어 정확히 구한다.
// 묶음 수·과목 수가 수십 개라 금방 끝나 근사가 필요 없다. 같은 과목을 여러 묶음에서 이어 들어야 택 수를 채울 수 있는 편제표(배정 불가)면
// 예전처럼 묶음마다 따로 센다(repeats: true).
// inside(option): 그 선택지가 셀 교과(군)인지.
function planComplianceGroupsRange(groups, inside) {
  const list = (groups || []).filter((group) => group.options.length && group.pick > 0);
  const separate = { min: 0, max: 0 };
  for (const group of list) {
    const count = group.options.filter(inside).length;
    const weight = group.credit * group.fields.length;
    separate.min += Math.max(0, group.pick - (group.options.length - count)) * weight;
    separate.max += Math.min(group.pick, count) * weight;
  }
  const keys = [...new Set(list.flatMap((group) => group.options.map((option) => option.key)))];
  const demand = list.reduce((sum, group) => sum + group.pick, 0);
  const solve = (sign) => {
    // 노드: 0 출발, 1..G 묶음, G+1..G+K 과목, G+K+1 도착
    const G = list.length, K = keys.length, sink = G + K + 1;
    const edges = [];
    const graph = Array.from({ length: sink + 1 }, () => []);
    const add = (from, to, cap, cost) => {
      graph[from].push(edges.length); edges.push({ to, cap, cost });
      graph[to].push(edges.length); edges.push({ to: from, cap: 0, cost: -cost });
    };
    list.forEach((group, index) => {
      add(0, index + 1, group.pick, 0);
      const weight = group.credit * group.fields.length;
      for (const option of group.options) add(index + 1, G + 1 + keys.indexOf(option.key), 1, inside(option) ? sign * weight : 0);
    });
    keys.forEach((key, index) => add(G + 1 + index, sink, 1, 0));
    let flow = 0, cost = 0;
    while (flow < demand) {
      const dist = Array(sink + 1).fill(Infinity), back = Array(sink + 1).fill(-1);
      dist[0] = 0;
      for (let round = 0; round <= sink; round++) {
        let changed = false;
        for (let node = 0; node <= sink; node++) {
          if (dist[node] === Infinity) continue;
          for (const id of graph[node]) {
            const edge = edges[id];
            if (edge.cap > 0 && dist[node] + edge.cost < dist[edge.to] - 1e-9) { dist[edge.to] = dist[node] + edge.cost; back[edge.to] = id; changed = true; }
          }
        }
        if (!changed) break;
      }
      if (dist[sink] === Infinity) break;
      for (let node = sink; node !== 0; node = edges[back[node] ^ 1].to) { edges[back[node]].cap -= 1; edges[back[node] ^ 1].cap += 1; }
      flow += 1;
      cost += dist[sink];
    }
    return flow < demand ? null : sign * cost;
  };
  const max = solve(-1), min = solve(1);
  if (max === null || min === null) return { ...separate, separate, repeats: true };
  return { min, max, separate, repeats: false };
}

// 교과(군) 편성 통계: 학기별 지정 학점·선택 최소~최대, 학생별 이수 최소~최대, 필수 이수 학점 대비 여유.
function planComplianceStats(model, settings = PLAN_COMPLIANCE_DEFAULTS) {
  const empty = () => Object.fromEntries(PLAN_COMPLIANCE_FIELDS.map((field) => [field, 0]));
  const families = [...PLAN_COMPLIANCE_FAMILIES, "기타"].map((family) => ({
    family, required: settings.required?.[family] ?? null, designated: empty(), choiceMin: empty(), choiceMax: empty(), extra: empty()
  }));
  const familyRow = new Map(families.map((row) => [row.family, row]));
  const semester = Object.fromEntries(PLAN_COMPLIANCE_FIELDS.map((field) => [field, { designated: 0, choice: 0, optional: 0, extra: 0, total: 0 }]));
  const domains = Object.fromEntries(PLAN_COMPLIANCE_DOMAINS.map((domain) => [domain, { credits: empty(), subjects: 0 }]));
  for (const row of model.rows) {
    const target = familyRow.get(row.family) || familyRow.get("기타");
    domains[row.domain].subjects += row.names.length;
    for (const [field, credit] of Object.entries(row.designated)) {
      if (row.role === "required") { target.designated[field] += credit; semester[field].designated += credit; }
      else if (row.role === "optional") { target.choiceMax[field] += credit; semester[field].optional += credit; }
      else { target.extra[field] += credit; semester[field].extra += credit; }
      domains[row.domain].credits[field] += credit;
    }
    if (row.note) {
      for (const field of row.note.fields) { target.extra[field] += row.note.credit; semester[field].extra += row.note.credit; domains[row.domain].credits[field] += row.note.credit; }
    }
  }
  for (const group of model.groups) {
    for (const field of group.fields) {
      semester[field].choice += group.pick * group.credit;
      domains["학생선택"].credits[field] += group.pick * group.credit;
      for (const row of families) {
        const range = planComplianceFamilyRange(group, [row.family]);
        row.choiceMin[field] += range.min;
        row.choiceMax[field] += range.max;
      }
    }
  }
  const sum = (values) => PLAN_COMPLIANCE_FIELDS.reduce((total, field) => total + (values[field] || 0), 0);
  for (const row of families) {
    row.designatedTotal = sum(row.designated);
    // 학기 칸의 '선택 a~b'는 그 학기 묶음만 본 값, 학생 합계는 같은 과목을 한 번만 고르게 묶음 전체로 계산한다.
    const range = planComplianceGroupsRange(model.groups, (option) => option.family === row.family);
    const optional = sum(row.choiceMax) - range.separate.max;
    row.choiceMinTotal = range.min;
    row.choiceMaxTotal = range.max + optional;
    row.sharedReduction = range.separate.max - range.max;
    row.extraTotal = sum(row.extra);
    row.min = row.designatedTotal + row.choiceMinTotal;
    row.max = row.designatedTotal + row.choiceMaxTotal;
    row.margin = row.required === null || row.required === undefined ? null : row.min - row.required;
  }
  for (const field of PLAN_COMPLIANCE_FIELDS) semester[field].total = semester[field].designated + semester[field].choice;
  // 국어·수학·영어 합: 한 묶음에서 세 교과를 함께 고르는 경우를 합쳐서 센다(교과별 최대의 단순 합이 아니다).
  const kem = { designated: 0, choiceMin: 0, choiceMax: 0, extra: 0 };
  for (const family of PLAN_COMPLIANCE_KEM) { kem.designated += familyRow.get(family).designatedTotal; kem.extra += familyRow.get(family).extraTotal; }
  for (const row of model.rows) {
    if (row.role === "optional" && PLAN_COMPLIANCE_KEM.includes(row.family)) kem.choiceMax += row.total;
  }
  {
    const range = planComplianceGroupsRange(model.groups, (option) => PLAN_COMPLIANCE_KEM.includes(option.family));
    kem.choiceMin += range.min;
    kem.choiceMax += range.max;
    kem.sharedReduction = range.separate.max - range.max;
  }
  kem.min = kem.designated + kem.choiceMin;
  kem.max = kem.designated + kem.choiceMax;
  const optionalTotal = sum(Object.fromEntries(PLAN_COMPLIANCE_FIELDS.map((field) => [field, semester[field].optional])));
  const totalMin = PLAN_COMPLIANCE_FIELDS.reduce((total, field) => total + semester[field].total, 0);
  return { families, semester, domains, kem, totalMin, totalMax: totalMin + optionalTotal,
    extraTotal: PLAN_COMPLIANCE_FIELDS.reduce((total, field) => total + semester[field].extra, 0) };
}

// 편제표 아래쪽 '창의적 체험활동' 행의 학기 학점.
function planComplianceCreative(layout) {
  const template = layout?.planTemplate;
  const semesters = template?.columns?.semesters || [];
  for (const row of template?.footer?.rows || []) {
    const label = row.slice(0, Math.max(1, Math.min(...semesters.filter((column) => column >= 0)))).join("").replace(/\s+/g, "");
    if (!/창의적체험/.test(label)) continue;
    const values = Object.fromEntries(PLAN_COMPLIANCE_FIELDS.map((field, index) => [field, semesters[index] >= 0 ? planComplianceNumber(row[semesters[index]]) || 0 : 0]));
    return { values, total: Object.values(values).reduce((sum, value) => sum + value, 0) };
  }
  return null;
}

function planComplianceJoin(list, limit = 12) {
  const items = [...new Set(list)];
  return items.length > limit ? `${items.slice(0, limit).join(", ")} 외 ${items.length - limit}개` : items.join(", ");
}

// 위계 규칙: course-checks.js 설정(끈 규칙·추가 규칙 반영)이 있으면 그것을, 없으면 기본 위계를 쓴다.
function planComplianceRules(rules) {
  if (Array.isArray(rules)) return rules;
  if (typeof COURSE_CHECK_DEFAULT_RULES !== "undefined") return COURSE_CHECK_DEFAULT_RULES.map(([before, after]) => ({ before, after }));
  return [{ before: "미적분Ⅰ", after: "미적분Ⅱ" }, { before: "영어Ⅰ", after: "영어Ⅱ" }];
}

// 편제 점검 결과. status: O / 확인필요 / 자체 확인 / 해당 없음
// options: { settings, sections, cohortYear, annual: { grades: ["1","2"] } | null, rules: [{before, after}] }
function planComplianceReport(layout, options = {}) {
  const settings = planComplianceNormalizeSettings(options.settings);
  const planData = layout?.planData;
  const revision = planComplianceRevision(layout, options.cohortYear);
  const annual = options.annual || null;
  const model = planComplianceModel(planData, { sections: options.sections, grades: annual?.grades || null });
  const stats = planComplianceStats(model, settings);
  const items = [];
  const subjectIssues = new Map();
  const flag = (rowId, issue) => { if (!subjectIssues.has(rowId)) subjectIssues.set(rowId, []); subjectIssues.get(rowId).push(issue); };
  const add = (id, status, note = "", details = []) => {
    const meta = PLAN_COMPLIANCE_ITEMS.find((item) => item.id === id);
    items.push({ ...meta, status, note, details });
  };
  const fieldIndex = (field) => PLAN_COMPLIANCE_FIELDS.indexOf(field);
  const label = (field) => planComplianceFieldLabel(field);
  const placements = model.placements;
  const has = (name) => placements.some((placement) => placement.key === planComplianceNameKey(name));
  const fam = stats.families;
  const famOf = (family) => fam.find((row) => row.family === family);

  // 1. 총 이수 학점(교과 174 이상, 창체 18 이상·편중 없음)
  const creative = annual ? null : planComplianceCreative(layout);
  {
    const notes = [];
    let ok = true;
    if (stats.totalMin < settings.subjects) { ok = false; notes.push(`교과 ${planComplianceRound(settings.subjects - stats.totalMin)}학점 부족(${planComplianceRound(stats.totalMin)}학점)`); }
    else notes.push(`교과 ${planComplianceRound(stats.totalMin)}${stats.totalMax > stats.totalMin ? `~${planComplianceRound(stats.totalMax)}` : ""}학점`);
    if (creative && !(creative.total > 0)) notes.push("창체 학점이 비어 있어 별도 확인필요");
    else if (creative) {
      const zero = PLAN_COMPLIANCE_FIELDS.filter((field) => !(creative.values[field] > 0));
      if (creative.total < settings.creative) { ok = false; notes.push(`창체 ${planComplianceRound(settings.creative - creative.total)}학점 부족(${planComplianceRound(creative.total)}학점)`); }
      else notes.push(`창체 ${planComplianceRound(creative.total)}학점(${PLAN_COMPLIANCE_FIELDS.map((field) => planComplianceRound(creative.values[field])).join("·")})`);
      if (zero.length) { ok = false; notes.push(`창체 미편성 학기: ${zero.map((field) => planComplianceFieldLabel(field, true)).join(", ")}(편중 확인)`); }
    } else notes.push("창체는 별도 확인필요");
    if (stats.extraTotal) notes.push(`소인수·공동 순증 ${planComplianceRound(stats.extraTotal)}학점 제외`);
    add("a1", ok ? "O" : "확인필요", notes.join(", "));
  }
  // 2. 교과(군)별 필수 이수 학점(지정 + 선택 최소)
  {
    const short = fam.filter((row) => row.required > 0 && row.min < row.required);
    add("a2", short.length ? "확인필요" : "O",
      short.map((row) => `${row.family} ${planComplianceRound(row.required - row.min)}학점부족`).join(", "));
  }
  // 3·4. 과목별 기준 학점·증감 범위, 공통과목 감 1학점 초과
  {
    const out = [], noRange = [], common = [];
    const units = [];
    for (const row of model.rows) {
      for (const name of row.names) {
        if (Object.keys(row.designated).length) {
          if (annual) {
            // 전학년 편제표: 학년마다 다른 입학생 편제표에서 왔으므로 학년별로 본다.
            for (const grade of ["1", "2", "3"]) {
              const credits = Object.entries(row.designated).filter(([field]) => field.slice(3, 4) === grade).map(([, credit]) => credit);
              if (!credits.length) continue;
              const total = credits.reduce((sum, credit) => sum + credit, 0);
              const split = row.crossed && row.names.length > 1;
              units.push({ row, name, credit: split ? total / row.names.length : total, each: credits, where: `${grade}학년`,
                how: split ? `교차집중 ${grade}학년 학기 학점 합 ${planComplianceRound(total)} ÷ ${row.names.length}과목` : `${grade}학년 학기 학점 ${credits.map(planComplianceRound).join("+")}` });
            }
          } else {
            const where = Object.keys(row.designated).map((field) => planComplianceFieldLabel(field, true)).join("·");
            const values = Object.values(row.designated).map(planComplianceRound);
            const how = row.crossed && row.names.length > 1 ? `교차집중 ${where} 학기 학점 합 ${planComplianceRound(row.total)} ÷ ${row.names.length}과목`
              : values.length > 1 ? `${where} 학기 학점 ${values.join("+")}` : `${where} 학기 학점`;
            units.push({ row, name, credit: row.unitCredit, each: [], where, how });
          }
        }
        if (row.note && row.note.credit) units.push({ row, name, credit: row.note.credit, each: [], where: "학기 칸 메모", how: `학기 칸 메모 ${planComplianceRound(row.note.credit)}학점` });
      }
    }
    for (const group of model.groups) {
      for (const option of group.options) {
        const row = model.rows.find((item) => item.id === option.rowId);
        units.push({ row, name: option, credit: group.credit * group.fields.length, each: [], where: group.label,
          how: `${group.label} 묶음 과목당 ${planComplianceRound(group.credit)}학점${group.fields.length > 1 ? ` × ${group.fields.length}학기` : ""}` });
      }
    }
    const seenOut = new Set();
    for (const unit of units) {
      const range = unit.name.official?.credit;
      if (!range) { if (!unit.name.marks.unlisted) noRange.push(unit.name.name); continue; }
      const inRange = (value) => value >= range.min && value <= range.max;
      if (inRange(unit.credit) || (unit.each.length > 1 && unit.each.every(inRange))) continue;
      const key = `${unit.name.key}|${unit.credit}`;
      if (seenOut.has(key)) continue;
      seenOut.add(key);
      const text = `${unit.name.name} ${planComplianceRound(unit.credit)}학점(기준 ${range.base}, ${range.min}~${range.max})`;
      out.push(text);
      const reason = `${unit.name.name}: ${unit.how || unit.where} → ${planComplianceRound(unit.credit)}학점, 2022 개정 기준 ${range.base}학점의 증감 범위 ${range.min}~${range.max}학점 밖`;
      flag(unit.row.id, { kind: "range", name: unit.name.name, credit: unit.credit, min: range.min, max: range.max, base: range.base, where: unit.where, text, reason });
      if (unit.name.type === "공통" && unit.credit < range.min) common.push(`${unit.name.name} ${planComplianceRound(unit.credit)}학점(기준 ${range.base})`);
    }
    const noRangeText = noRange.length ? `범위 정보 없음: ${planComplianceJoin(noRange, 8)}` : "";
    add("a3", out.length ? "확인필요" : "O", [out.length ? `${out.length}과목 확인필요: ${planComplianceJoin(out, 8)}` : "", noRangeText].filter(Boolean).join(" · "));
    add("a4", common.length ? "확인필요" : "O", common.length ? `${common.length}과목 확인필요: ${common.join(", ")}` : "");
  }
  // 5. 과학탐구실험1·2 각 1학점
  if (annual && !annual.grades.includes("1")) add("a5", "해당 없음", "1학년이 2022 개정 대상이 아닙니다.");
  else {
    const units = (name) => {
      const key = planComplianceNameKey(name);
      const credits = [];
      for (const row of model.rows) if (row.names.some((item) => item.key === key) && Object.keys(row.designated).length) credits.push(row.unitCredit);
      for (const group of model.groups) if (group.options.some((option) => option.key === key)) credits.push(group.credit * group.fields.length);
      return credits;
    };
    const one = units("과학탐구실험1"), two = units("과학탐구실험2");
    let note = "";
    if (!one.length && !two.length) note = "과학탐구실험1, 2 미편성";
    else if (!one.length) note = "과학탐구실험1 미편성";
    else if (!two.length) note = "과학탐구실험2 미편성";
    else {
      const bad = [["과학탐구실험1", one], ["과학탐구실험2", two]].filter(([, credits]) => credits.some((credit) => credit !== 1)).map(([name]) => name);
      if (bad.length) note = `${bad.join(", ")} 시수조정필요(1학점)`;
    }
    add("a5", note ? "확인필요" : "O", note);
  }
  // 6. 학기 간 학점 격차
  {
    const totals = PLAN_COMPLIANCE_FIELDS.map((field) => ({ field, total: stats.semester[field].total }));
    const high = totals.reduce((best, item) => item.total > best.total ? item : best, totals[0]);
    const low = totals.reduce((best, item) => item.total < best.total ? item : best, totals[0]);
    const gap = high.total - low.total;
    const text = totals.map((item) => planComplianceRound(item.total)).join("·");
    add("a6", gap > settings.semesterGap ? "확인필요" : "O", gap > settings.semesterGap
      ? `${label(high.field)}(${planComplianceRound(high.total)}학점), ${label(low.field)}(${planComplianceRound(low.total)}학점) 확인필요 · 격차 ${planComplianceRound(gap)}학점(기준 ${settings.semesterGap})`
      : `학기별 ${text} · 격차 ${planComplianceRound(gap)}학점`);
  }
  // 7. 국어·수학·영어 합(81학점, 174 초과분의 50%)
  {
    const kem = stats.kem;
    const limit = settings.kemLimit + Math.max(0, stats.totalMax - settings.subjects) * settings.kemExtraRatio / 100;
    const over = kem.max - limit;
    const tail = over > 0 ? `${planComplianceRound(over)}학점 만큼 초과할 수 있습니다.` : `${planComplianceRound(-over)}학점 만큼 여유가 있습니다.`;
    add("a7", over > 0 ? "확인필요" : "O",
      `국어, 수학, 영어가 지정과목에서 ${planComplianceRound(kem.designated)}학점 배당, 선택과목에서 해당 교과군을 학생별 최대 ${planComplianceRound(kem.choiceMax)}학점(최소 ${planComplianceRound(kem.choiceMin)}학점)만큼 이수할 수 있어, 총 ${planComplianceRound(kem.max)}학점 이수가 가능하므로 기준 ${planComplianceRound(limit)}학점보다 ${tail}` +
      (kem.extra ? ` (소인수·공동 순증 국수영 ${planComplianceRound(kem.extra)}학점 별도)` : ""));
  }
  // 8·9. 2022 개정 교과목, 교과목명 표기
  {
    const notListed = [], spelled = [];
    const seen = new Set();
    for (const row of model.rows) {
      // 전학년 편제표: 2022 개정 학년에 편성된 과목만 본다(2015 개정 학년 과목은 제외).
      if (annual && !row.total && !row.note?.fields?.length) continue;
      for (const name of row.names) {
        const id = `${row.id}|${name.key}`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (name.official) {
          const officialName = planComplianceSpelling(name.official.name);
          if (planComplianceSpelling(name.name) !== officialName) {
            spelled.push(`${name.name} → ${officialName}`);
            flag(row.id, { kind: "spelling", name: name.name, suggestion: officialName, text: `공식 과목명은 '${officialName}'입니다.` });
          }
          continue;
        }
        if (name.marks.unlisted) continue;
        const suggestion = planComplianceSuggest(name.name);
        if (suggestion) {
          spelled.push(`${name.name} → ${suggestion}`);
          flag(row.id, { kind: "spelling", name: name.name, suggestion, text: `목록에 없는 이름입니다. '${suggestion}'의 오탈자인지 확인하세요.` });
        } else {
          notListed.push(name.name);
          flag(row.id, { kind: "unlisted", name: name.name, text: "2022 개정 교육과정 과목 목록에 없는 과목명입니다(고시 외 과목이면 ☆ 표기)." });
        }
      }
    }
    add("a8", notListed.length ? "확인필요" : "O", notListed.length ? `${new Set(notListed).size}개 확인필요: ${planComplianceJoin(notListed)}` : "");
    // 업로드·원본 재변환 때 공식 과목명으로 자동 수정한 곳(subject.originalName)은 비고에만 남긴다.
    const autoFixed = (planData?.subjects || []).filter((subject) => !subject.fixed && subject.originalName !== undefined && subject.originalName !== subject.name);
    const autoText = autoFixed.length ? `자동 수정 ${autoFixed.length}곳(${planComplianceJoin(autoFixed.map((subject) => `${subject.originalName} → ${subject.name}`), 6)})` : "";
    add("a9", spelled.length ? "확인필요" : "O", [spelled.length ? `${new Set(spelled).size}개 확인필요: ${planComplianceJoin(spelled)}` : "", autoText].filter(Boolean).join(" · "));
  }
  if (!annual) {
    // 10. 공통 과목 → 같은 교과(군) 선택 과목
    const issues = [];
    for (const family of ["국어", "수학", "영어", "사회", "과학"]) {
      const inFamily = placements.filter((placement) => placement.family === family);
      const common = inFamily.filter((placement) => placement.type === "공통").map((placement) => fieldIndex(placement.field));
      const choice = inFamily.filter((placement) => /선택/.test(placement.type)).map((placement) => fieldIndex(placement.field));
      if (!common.length || !choice.length) continue;
      const lastCommon = Math.max(...common), firstChoice = Math.min(...choice);
      if (lastCommon >= firstChoice) issues.push(`${family}교과 공통 과목: ${label(PLAN_COMPLIANCE_FIELDS[lastCommon])}, 선택 과목: ${label(PLAN_COMPLIANCE_FIELDS[firstChoice])}에 편성함`);
    }
    add("a10", issues.length ? "확인필요" : "O", issues.join(" · "));
    // 11. 한국사1·2 → 역사 선택 과목
    const history = PLAN_COMPLIANCE_HISTORY.map(planComplianceNameKey);
    const korean = placements.filter((placement) => /^한국사[12]$/.test(placement.key)).map((placement) => fieldIndex(placement.field));
    const later = placements.filter((placement) => history.includes(placement.key)).map((placement) => fieldIndex(placement.field));
    if (!korean.length) add("a11", "확인필요", "한국사1, 2 미편성");
    else if (later.length && Math.max(...korean) >= Math.min(...later)) {
      add("a11", "확인필요", `공통 과목: ${label(PLAN_COMPLIANCE_FIELDS[Math.max(...korean)])}, 선택 과목: ${label(PLAN_COMPLIANCE_FIELDS[Math.min(...later)])}에 편성함`);
    } else add("a11", "O", later.length ? "" : "역사 선택 과목 없음");
  } else {
    add("a10", "해당 없음", "입학생 편제표에서 점검");
    add("a11", "해당 없음", "입학생 편제표에서 점검");
  }
  // 12. 체육 10학점 이상·매 학기
  {
    const offered = new Set(placements.filter((placement) => placement.family === "체육" && placement.source !== "extra").map((placement) => placement.field));
    const fields = annual ? PLAN_COMPLIANCE_FIELDS.filter((field) => annual.grades.includes(field.slice(3, 4))) : PLAN_COMPLIANCE_FIELDS;
    const missing = settings.peEverySemester ? fields.filter((field) => !offered.has(field)) : [];
    const pe = famOf("체육");
    const short = !annual && pe.min < settings.peTotal ? `총 ${planComplianceRound(settings.peTotal - pe.min)}학점 부족` : "";
    const notes = [short, missing.length ? `${missing.map((field) => label(field)).join(", ")} 확인필요` : ""].filter(Boolean);
    add("a12", notes.length ? "확인필요" : "O", notes.length ? notes.join(", ") : annual ? `매 학기 편성` : `체육 ${planComplianceRound(pe.min)}${pe.max > pe.min ? `~${planComplianceRound(pe.max)}` : ""}학점, 매 학기 편성`);
  }
  // 13. 3학년 2학기 수능 과목(진도 종료는 학교가 확인)
  {
    const keys = settings.suneung.map(planComplianceNameKey);
    const late = placements.filter((placement) => placement.field === "sem32" && keys.includes(placement.key)).map((placement) => placement.name);
    add("a13", late.length ? "자체 확인" : "O", late.length ? `${planComplianceJoin(late)} 3학년 2학기에 편성됨 → 수능 전 학습 진도 종료 가능 확인 필요` : "");
  }
  if (!annual) {
    // 14. 같은 학년 같은 과목은 같은 학점
    const units = new Map();
    for (const placement of placements) {
      const key = `${placement.key}|${placement.field.slice(3, 4)}`;
      if (!units.has(key)) units.set(key, { name: placement.name, grade: placement.field.slice(3, 4), credits: new Set() });
      units.get(key).credits.add(planComplianceRound(placement.unit));
    }
    const mixed = [...units.values()].filter((unit) => unit.credits.size > 1)
      .map((unit) => `${unit.name}(${unit.grade}학년 ${[...unit.credits].sort((a, b) => a - b).join("·")}학점)`);
    add("a14", mixed.length ? "확인필요" : "O", mixed.length ? `${mixed.join(", ")} 확인필요` : "");
    // 15. 위계(선이수 → 후속 과목)
    const earliest = new Map();
    for (const placement of placements) {
      const index = fieldIndex(placement.field);
      if (!earliest.has(placement.key) || index < earliest.get(placement.key).index) earliest.set(placement.key, { index, name: placement.name });
    }
    const checked = [], wrong = [];
    for (const rule of planComplianceRules(options.rules)) {
      if (!rule || rule.off) continue;
      const before = earliest.get(planComplianceNameKey(rule.before)), after = earliest.get(planComplianceNameKey(rule.after));
      if (!before || !after) continue;
      checked.push(`${before.name}→${after.name}`);
      if (before.index >= after.index) wrong.push(`${before.name}(${label(PLAN_COMPLIANCE_FIELDS[before.index])}) → ${after.name}(${label(PLAN_COMPLIANCE_FIELDS[after.index])})`);
    }
    add("a15", wrong.length ? "확인필요" : "O", wrong.length ? `${wrong.join(", ")} 확인필요` : checked.length ? `${checked.length}개 위계 확인: ${planComplianceJoin(checked, 6)}` : "편성된 위계 과목 없음");
    // 16. 제2외국어 선택권
    const isLanguage = (name, family, area) => family === PLAN_COMPLIANCE_ETC && !/한문|한자/.test(name.key) &&
      (/외국어/.test(area || "") || /제2외국어/.test(name.official?.area || "") || /독일|프랑스|스페인|중국|일본|러시아|아랍|베트남/.test(name.name));
    const designatedLanguages = model.rows.filter((row) => row.role === "required" && row.total > 0).flatMap((row) => row.names.filter((name) => isLanguage(name, row.family, row.area)).map((name) => name.name));
    const lonely = model.groups.map((group) => ({ group, languages: group.options.filter((option) => isLanguage(option, option.family, model.rows.find((row) => row.id === option.rowId)?.area)) }))
      .filter((item) => item.languages.length === 1).map((item) => `${item.group.label} 그룹에 제2외국어 1과목(${item.languages[0].name})`);
    const notes16 = [designatedLanguages.length ? `지정 편성: ${planComplianceJoin(designatedLanguages)}` : "", ...lonely].filter(Boolean);
    add("a16", notes16.length ? "확인필요" : "O", notes16.join(" · "));
    // 17. 지정 과목과 선택 과목 중복 편성
    const designatedKeys = new Map();
    for (const row of model.rows) if (row.role === "required" && row.total > 0) for (const name of row.names) designatedKeys.set(name.key, name.name);
    const duplicated = new Set();
    for (const group of model.groups) for (const option of group.options) if (designatedKeys.has(option.key)) duplicated.add(designatedKeys.get(option.key));
    for (const row of model.rows) if (row.role === "optional") for (const name of row.names) if (designatedKeys.has(name.key)) duplicated.add(name.name);
    add("a17", duplicated.size ? "확인필요" : "O", duplicated.size ? `${[...duplicated].join(", ")} 중복편성` : "");
    // 18. 종교 과목
    const religionKey = planComplianceNameKey("삶과 종교");
    const religion = placements.filter((placement) => placement.key === religionKey || /종교/.test(placement.name));
    const religionIssues = [];
    for (const placement of religion) {
      if (placement.source !== "group") { religionIssues.push(`${placement.name}: 지정 편성`); continue; }
      const group = model.groups.find((item) => item.id === placement.groupId);
      const others = group.options.filter((option) => option.key !== placement.key && option.family === PLAN_COMPLIANCE_ETC);
      if (!others.length) religionIssues.push(`${placement.name}: ${group.label} 그룹에 다른 교양 과목 없음`);
    }
    add("a18", religionIssues.length ? "확인필요" : "O", [...new Set(religionIssues), "\"삶과 종교\" 이외의 종교 과목을 편성할 경우, 추가 확인 필요"].join(" · "));
    // 19. 학생 선택권
    const choiceCredits = model.groups.reduce((sum, group) => sum + group.pick * group.credit * group.fields.length, 0);
    const optionalRows = model.rows.filter((row) => row.role === "optional").length;
    add("a19", model.groups.length || optionalRows ? "O" : "확인필요", model.groups.length || optionalRows
      ? `선택과목군 ${model.groups.length}개(학생 선택 ${planComplianceRound(choiceCredits)}학점)${optionalRows ? ` · 묶음 없는 선택 과목 ${optionalRows}행` : ""}`
      : "학생선택교육과정 없음");
    // 20. 수능 출제 과목 편성
    const missing = settings.suneung.filter((name) => !has(name));
    add("a20", missing.length ? "확인필요" : "O", missing.length ? `${missing.join(", ")} 미편성` : "");
  } else {
    for (const id of ["a14", "a15", "a16", "a17", "a18", "a19", "a20"]) add(id, "해당 없음", "입학생 편제표에서 점검");
    for (const item of items) if (item.id === "a1" || item.id === "a2" || item.id === "a6" || item.id === "a7") { item.status = "해당 없음"; item.note = "입학생 편제표에서 점검"; }
  }
  items.sort((a, b) => a.no - b.no);
  // 자체 점검 도움말(자료에서 찾은 근거)
  const vocational = [];
  for (const row of model.rows) for (const name of row.names) {
    if (!(name.marks.vocational || name.official?.category === "전문교과")) continue;
    const kind = row.kind || "";
    vocational.push(`${name.name}${kind && kind !== "진로선택" ? `(${kind} → 확인)` : ""}`);
  }
  const shared = model.rows.filter((row) => row.domain === "소인수·공동").flatMap((row) => row.names.map((name) => `${name.name}${row.note?.kind ? `(${row.note.kind})` : ""}`));
  const specialRows = model.rows.filter((row) => row.names.some((name) => name.marks.specialization));
  let specialMin = 0, specialMax = 0;
  for (const row of specialRows) if (row.role === "required") { specialMin += row.total; specialMax += row.total; }
  {
    const range = planComplianceGroupsRange(model.groups, (option) => option.marks.specialization);
    specialMin += range.min;
    specialMax += range.max;
  }
  const self = PLAN_COMPLIANCE_SELF_ITEMS.map((item) => ({ ...item, hint: {
    s1: vocational.length ? `전문교과: ${planComplianceJoin(vocational)}` : "전문교과 과목 없음",
    s2: shared.length ? `소인수·공동: ${planComplianceJoin(shared)}` : "소인수·공동 교육과정 과목 없음",
    s3: "",
    s4: specialRows.length || specialMax
      ? `■ 표시 과목 학생별 ${planComplianceRound(specialMin)}~${planComplianceRound(specialMax)}학점(기준 ${settings.specialization}학점)`
      : `현재 선택과목 포함 학생별 최소 이수학점은 ${fam.filter((row) => row.family !== "기타").map((row) => `${row.family} ${planComplianceRound(row.min)}학점`).join(", ")} 입니다. (교과특성화 기준 ${settings.specialization}학점, ■ 표시 과목 없음)`
  }[item.id] || item.hint || "" }));
  return { revision, settings, model, stats, items, self, subjectIssues, annual: Boolean(annual), creative };
}

// 인정 오류를 반영한 표시 상태(울산 점검표처럼 인정오류 'O'면 점검 결과도 'O').
function planComplianceDisplayStatus(item, saved) {
  const ack = saved?.ack?.[item.id];
  if (ack?.on && item.status !== "O" && item.status !== "해당 없음") return { status: "O", acknowledged: true };
  return { status: item.status, acknowledged: false };
}

function planComplianceCounts(report, saved) {
  const counts = { "O": 0, "확인필요": 0, "자체 확인": 0, "해당 없음": 0, acknowledged: 0 };
  for (const item of report.items) {
    const display = planComplianceDisplayStatus(item, saved);
    counts[display.status] += 1;
    if (display.acknowledged) counts.acknowledged += 1;
  }
  return counts;
}

// 점검표 엑셀 행(울산 점검표 열 구성: 연번·영역·점검 내용·점검 결과·비고·인정오류·인정오류 사유).
// extras: { 항목 id: 비고에 덧붙일 글 } (앱이 학생 결과로 만든 7번 안내 등)
function planComplianceSheetRows(report, saved, title, extras = {}) {
  const rows = [[{ v: title, s: 1 }, null, null, null, null, null, null], [],
    ["연번", "영역", "점검 내용", "점검 결과", "비고", "인정오류", "인정오류 사유"].map((v) => ({ v, s: 2 })),
    [{ v: "편성과목 기반 자동점검", s: 6 }, null, null, null, null, null, null]];
  for (const item of report.items) {
    const display = planComplianceDisplayStatus(item, saved);
    const ack = saved?.ack?.[item.id];
    rows.push([{ v: item.no, s: 4 }, { v: item.area, s: 4 }, { v: item.hint ? `${item.text}\n※ ${item.hint}` : item.text, s: 3 },
      { v: display.status, s: display.status === "확인필요" ? 9 : 4 },
      { v: [display.acknowledged ? `(원래 결과: ${item.status})` : "", item.note, extras?.[item.id] || ""].filter(Boolean).join(" "), s: 3 },
      { v: ack?.on ? "O" : "", s: 4 }, { v: ack?.reason || "", s: 3 }]);
  }
  rows.push([{ v: "자체점검", s: 6 }, null, null, null, null, null, null]);
  for (const item of report.self) {
    const entry = saved?.self?.[item.id];
    rows.push([{ v: item.no, s: 4 }, { v: item.area, s: 4 }, { v: item.hint && item.id === "s4" ? `${item.text}\n※ 자율 이수 학점의 30%(${report.settings.specialization}학점) 이상을 해당 교과(군)의 과목으로 편성` : item.text, s: 3 },
      { v: entry?.checked ? "확인" : "", s: 4 }, { v: [entry?.memo || "", item.hint && item.id !== "s4" ? `(${item.hint})` : item.id === "s4" ? item.hint : ""].filter(Boolean).join(" "), s: 3 }, { v: "", s: 4 }, { v: "", s: 3 }]);
  }
  const merges = ["A1:G1", "A4:G4", `A${report.items.length + 5}:G${report.items.length + 5}`];
  return { rows, merges, widths: [6, 10, 52, 11, 52, 9, 28] };
}

// 교과(군) 통계 엑셀 행
function planComplianceStatsRows(report, title) {
  const stats = report.stats;
  const head = ["교과(군)", "필수 이수", ...PLAN_COMPLIANCE_FIELDS.map((field) => `${planComplianceFieldLabel(field, true)} 지정`),
    "지정 합", "선택 최소", "선택 최대", "학생 최소", "학생 최대", "필수 대비 여유", "소인수·공동(순증)"];
  const rows = [[{ v: title, s: 1 }], [], head.map((v) => ({ v, s: 2 }))];
  for (const row of stats.families) {
    if (row.family === "기타" && !row.max && !row.extraTotal) continue;
    rows.push([{ v: row.family, s: 3 }, { v: row.required ?? "", s: 4 }, ...PLAN_COMPLIANCE_FIELDS.map((field) => {
      const extra = row.choiceMax[field] ? ` (+선택 ${planComplianceRound(row.choiceMin[field])}~${planComplianceRound(row.choiceMax[field])})` : "";
      return { v: extra ? `${planComplianceRound(row.designated[field])}${extra}` : planComplianceRound(row.designated[field]), s: 4 };
    }), ...[row.designatedTotal, row.choiceMinTotal, row.choiceMaxTotal, row.min, row.max].map((v) => ({ v: planComplianceRound(v), s: 4 })),
    { v: row.margin === null ? "" : planComplianceRound(row.margin), s: row.margin !== null && row.margin < 0 ? 9 : 4 }, { v: planComplianceRound(row.extraTotal) || "", s: 4 }]);
  }
  const kem = stats.kem;
  const limit = report.settings.kemLimit + Math.max(0, stats.totalMax - report.settings.subjects) * report.settings.kemExtraRatio / 100;
  rows.push([{ v: "국어·수학·영어 합", s: 6 }, { v: `≤ ${planComplianceRound(limit)}`, s: 6 }, ...PLAN_COMPLIANCE_FIELDS.map(() => ({ v: "", s: 6 })),
    ...[kem.designated, kem.choiceMin, kem.choiceMax, kem.min, kem.max].map((v) => ({ v: planComplianceRound(v), s: 7 })),
    { v: planComplianceRound(limit - kem.max), s: limit - kem.max < 0 ? 9 : 7 }, { v: planComplianceRound(kem.extra) || "", s: 6 }]);
  rows.push([{ v: "학기 합계", s: 6 }, { v: report.settings.subjects, s: 6 }, ...PLAN_COMPLIANCE_FIELDS.map((field) => ({ v: planComplianceRound(stats.semester[field].total), s: 7 })),
    { v: "", s: 6 }, { v: "", s: 6 }, { v: "", s: 6 }, { v: planComplianceRound(stats.totalMin), s: 7 }, { v: planComplianceRound(stats.totalMax), s: 7 }, { v: planComplianceRound(stats.totalMin - report.settings.subjects), s: 7 }, { v: planComplianceRound(stats.extraTotal) || "", s: 6 }]);
  rows.push([]);
  rows.push(["편성 영역", "과목 수", ...PLAN_COMPLIANCE_FIELDS.map((field) => planComplianceFieldLabel(field, true)), "합계"].map((v) => ({ v, s: 2 })));
  for (const domain of PLAN_COMPLIANCE_DOMAINS) {
    const entry = stats.domains[domain];
    const total = PLAN_COMPLIANCE_FIELDS.reduce((sum, field) => sum + entry.credits[field], 0);
    rows.push([{ v: domain, s: 3 }, { v: entry.subjects, s: 4 }, ...PLAN_COMPLIANCE_FIELDS.map((field) => ({ v: planComplianceRound(entry.credits[field]), s: 4 })), { v: planComplianceRound(total), s: 4 }]);
  }
  rows.push([{ v: "학생선택 학점은 선택과목군의 '택 수 × 과목당 학점'(학생 1명 기준), 학교지정·교차집중은 학기 칸 학점, 소인수·공동은 순증 학점입니다.", s: 8 }]);
  return { rows, widths: [26, 9, ...PLAN_COMPLIANCE_FIELDS.map(() => 13), 8, 8, 8, 8, 8, 11, 12] };
}

// 과목명 칸에서 한 과목 이름만 공식 이름으로 바꾼다(표기 기호 *★☆■는 그대로 둔다).
function planComplianceReplaceName(rowName, from, to) {
  let changed = false;
  const name = String(rowName).split(/([,，、])/).map((part) => {
    if (changed || /^[,，、]$/.test(part)) return part;
    const clean = part.replace(/↔/g, " ").replace(/[*＊★☆■]/g, "").replace(/\s+/g, " ").trim();
    if (clean !== from) return part;
    changed = true;
    return `${part.match(/^\s*/)[0]}${to}${(part.match(/[*＊★☆■]/g) || []).join("")}`;
  }).join("");
  return changed ? name : null;
}

// '확인필요' 항목 → 편제표에서 보여 줄 과목 행(학점 범위·과목명은 과목별 경고, 그 밖은 비고에 적힌 과목명, 합계 항목은 소계 행)
var PLAN_COMPLIANCE_ITEM_KINDS = { a3: ["range"], a8: ["unlisted"], a9: ["spelling"] };
function planComplianceItemTargets(report, item) {
  const kinds = PLAN_COMPLIANCE_ITEM_KINDS[item?.id];
  const rows = [];
  if (kinds) {
    for (const [id, issues] of report.subjectIssues || []) if (issues.some((issue) => kinds.includes(issue.kind))) rows.push(id);
  }
  if (!rows.length && item?.note) {
    for (const row of report.model?.rows || []) {
      if (row.names.some((name) => name.name.length >= 2 && String(item.note).includes(name.name))) rows.push(row.id);
    }
  }
  if (rows.length) return { rows, footer: false, label: rows.length === 1 ? "해당 과목 행" : `해당 과목 ${rows.length}행` };
  if (["a1", "a2", "a6", "a7"].includes(item?.id)) return { rows: [], footer: true, label: "소계 행" };
  return null;
}

// ---- 앱 연결 (아래는 1단계 화면·저장에 연결한다)

function planComplianceEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function planComplianceStore() {
  if (typeof state === "undefined") return { plans: {} };
  if (!planComplianceObject(state.curriculumCompliance)) state.curriculumCompliance = { plans: {} };
  if (!planComplianceObject(state.curriculumCompliance.plans)) state.curriculumCompliance.plans = {};
  return state.curriculumCompliance;
}

function planComplianceCurrentSettings() {
  return planComplianceNormalizeSettings(planComplianceStore().settings);
}

function planComplianceSaved(key) {
  return planComplianceStore().plans[key] || { ack: {}, self: {} };
}

function planComplianceSave(key, mutate) {
  const store = planComplianceStore();
  const plan = store.plans[key] || { ack: {}, self: {} };
  plan.ack ||= {};
  plan.self ||= {};
  mutate(plan);
  store.plans[key] = plan;
  state.curriculumCompliance = planComplianceNormalizeState(store);
  return typeof persistState === "function" ? persistState() : true;
}

function planComplianceActiveKey() {
  if (typeof state === "undefined" || !state.curriculumImportedLayout) return "";
  return `${state.curriculumPlanType === "annual" ? "annual" : "cohort"}:${state.curriculumCohortYear}`;
}

// 편제표 키(cohort:2026 / annual:2026) → 표·파일 이름. 지금 화면에서 고치고 있는 편제표는 화면의 최신 자료를 쓴다.
function planCompliancePlan(key) {
  const [type, year] = String(key).split(":");
  if (typeof state === "undefined" || !/^\d{4}$/.test(year || "")) return null;
  const active = planComplianceActiveKey() === key;
  const stored = (type === "annual" ? state.curriculumAnnualPlans : state.curriculumCohorts)?.[year];
  const raw = active ? state.curriculumImportedLayout : stored?.importedLayout;
  if (!raw) return null;
  const layout = raw.planData ? raw : typeof curriculumLayoutData === "function" ? curriculumLayoutData(raw) : null;
  const schoolYear = typeof document !== "undefined" ? Number(document.getElementById("schoolYear")?.value) || 0 : 0;
  const grade = schoolYear ? schoolYear - Number(year) + 1 : -1;
  const who = type === "annual" ? "전학년" : grade === 0 ? "입학생(내년도 신입생)" : grade >= 1 && grade <= 3 ? `입학생(현 ${grade}학년)` : "입학생";
  return { key, type, year, layout, fileName: active ? state.curriculumPlanFileName : stored?.fileName || "", label: `${year}학년도 ${who} 편제표` };
}

function planComplianceAppRules() {
  try {
    if (typeof courseCheckContext === "function") return courseCheckContext().rules.filter((rule) => !rule.off).map(({ before, after }) => ({ before, after }));
  } catch { /* 위계 설정을 못 읽으면 기본 위계를 쓴다. */ }
  return undefined;
}

const planComplianceCache = new WeakMap();
// 편제표별 점검 결과(편제표 데이터·기준값·위계 규칙이 같으면 다시 계산하지 않는다). fresh: 캐시를 버리고 지금 데이터로 다시 계산(다시 점검·내보내기).
function planComplianceFor(key, { fresh = false } = {}) {
  const plan = planCompliancePlan(key);
  if (fresh && plan?.layout?.planData) planComplianceCache.delete(plan.layout.planData);
  if (!plan?.layout?.planData) return null;
  const settings = planComplianceCurrentSettings();
  const rules = planComplianceAppRules();
  let annual = null, sections = null, sources = null;
  if (plan.type === "annual") {
    sources = [1, 2, 3].map((grade) => {
      const year = String(Number(plan.year) - grade + 1);
      const source = planCompliancePlan(`cohort:${year}`);
      return { grade: String(grade), year, key: `cohort:${year}`, layout: source?.layout || null,
        available: Boolean(source?.layout?.planData), revision: source?.layout ? planComplianceRevision(source.layout, year).revision : Number(year) >= 2025 ? "2022" : "2015" };
    });
    annual = { grades: sources.filter((source) => source.revision === "2022").map((source) => source.grade) };
    sections = {};
    for (const source of sources) {
      for (const subject of source.layout?.planData?.subjects || []) {
        if (subject?.planSectionManual) sections[planComplianceRowKey(subject.name)] = subject.planSection;
      }
    }
  }
  const signature = JSON.stringify([settings, rules, annual, sections, plan.year, plan.type]);
  const cached = planComplianceCache.get(plan.layout.planData);
  let report;
  if (cached && cached.signature === signature) report = cached.report;
  else {
    report = planComplianceReport(plan.layout, { settings, rules, annual, sections, cohortYear: plan.type === "annual" ? "" : plan.year });
    if (plan.type === "annual") {
      report.revision = { revision: annual.grades.length === 3 ? "2022" : annual.grades.length ? "mixed" : "2015", titleYear: plan.year, cohortYear: plan.year, mismatch: false };
    }
    planComplianceCache.set(plan.layout.planData, { signature, report });
  }
  if (plan.type === "annual") {
    report.sources = sources.map(({ layout, ...source }) => {
      const sourceResult = source.available && source.revision === "2022" ? planComplianceFor(source.key) : null;
      return { ...source, counts: sourceResult ? planComplianceCounts(sourceResult.report, planComplianceSaved(source.key)) : null };
    });
  }
  return { report, plan };
}

// 점검표 비고에 덧붙이는 앱 자료 안내(7번: 학생별 실제 선택은 2단계 이수학점 점검에서 본다 · 현재 경고 학생 수).
function planComplianceItemExtras(result) {
  const { report, plan } = result;
  const item = report.items.find((entry) => entry.id === "a7");
  if (plan.type === "annual" || !item || item.status === "해당 없음") return {};
  let count = null;
  try { count = typeof courseCheckKemOverCount === "function" ? courseCheckKemOverCount(plan.year) : null; } catch { count = null; }
  const where = count ? `현재 경고 ${count.over}명 · 현 ${count.grade}학년 ${count.checked}명 점검` : "이 입학생의 수강신청 결과 없음";
  return { a7: `학생별 실제 선택은 2단계 이수학점 점검에서 확인(${where})` };
}

function planComplianceStatusClass(status) {
  return status === "O" ? "is-ok" : status === "확인필요" ? "is-check" : status === "자체 확인" ? "is-self" : "is-na";
}

// 1단계 편제표 카드의 '편제 점검' 단추(app.js renderCurriculumCohortUploads에서 부른다).
function planComplianceCardButton(type, year, available) {
  const key = `${type}:${year}`;
  if (!available) return "";
  let badge = "";
  try {
    const result = planComplianceFor(key);
    if (result && result.plan.type !== "annual" && result.report.revision.revision === "2015") badge = '<span class="plan-compliance-badge is-na">2015</span>';
    else if (result) {
      const counts = planComplianceCounts(result.report, planComplianceSaved(key));
      badge = counts["확인필요"] ? `<span class="plan-compliance-badge is-check">확인 ${counts["확인필요"]}</span>` : '<span class="plan-compliance-badge is-ok">O</span>';
    }
  } catch { badge = ""; }
  return `<button class="button plan-compliance-open" type="button" data-plan-compliance="${planComplianceEscape(key)}" aria-label="${planComplianceEscape(year)}학년도 ${type === "annual" ? "전학년" : "입학생"} 편제 점검표 열기">편제 점검${badge}</button>`;
}

let planComplianceDialogKey = "";

function planComplianceDialogs() {
  if (document.getElementById("planComplianceDialog")) return;
  document.body.insertAdjacentHTML("beforeend", `
  <dialog class="curriculum-subject-dialog plan-compliance-dialog" id="planComplianceDialog" aria-labelledby="planComplianceTitle">
    <form method="dialog">
      <h2 id="planComplianceTitle">교육과정 편제 점검표</h2>
      <p class="plan-compliance-recheck"><button class="button" type="button" data-pc-action="recheck" title="지금 편제표 데이터로 바로 다시 계산합니다">다시 점검</button> <span id="planComplianceLastRun" role="status" aria-live="polite"></span></p>
      <div id="planComplianceBody"></div>
      <div class="curriculum-version-dialog-actions">
        <button class="button" type="button" data-pc-action="settings">점검 기준 설정</button>
        <button class="button" type="button" data-pc-action="stats">교과(군) 편성 통계</button>
        <button class="button" type="button" data-pc-action="export">엑셀로 내보내기</button>
        <button class="button" type="button" data-pc-action="print">인쇄</button>
        <button class="button button-primary" type="submit" formnovalidate>닫기</button>
      </div>
    </form>
  </dialog>
  <dialog class="curriculum-subject-dialog plan-compliance-settings-dialog" id="planComplianceSettingsDialog" aria-labelledby="planComplianceSettingsTitle">
    <form method="dialog" id="planComplianceSettingsForm">
      <h2 id="planComplianceSettingsTitle">편제 점검 기준 설정</h2>
      <p class="note">울산광역시교육청 편제 점검 프로그램(2026) 지침의 기준값입니다. 교육청 기준이 다르면 고치세요. 입력하면 바로 저장되고 모든 편제표 점검에 반영됩니다.</p>
      <p class="note plan-compliance-shared-note">교과(군)별 필수 이수 학점·교과 총 이수 학점·창의적 체험활동·국어·수학·영어 상한은 <b>2단계 학생 위계·이수학점 점검</b>(결과 검증·확인서 점검란·4단계 요약)도 같은 값을 씁니다. 여기 한 곳에서만 고칩니다.</p>
      <div id="planComplianceSettingsBody"></div>
      <div class="curriculum-version-dialog-actions">
        <button class="button" type="button" data-pc-action="reset-settings">기본값으로</button>
        <button class="button button-primary" type="submit" formnovalidate>닫기</button>
      </div>
    </form>
  </dialog>
  <dialog class="curriculum-subject-dialog plan-compliance-stats-dialog" id="planComplianceStatsDialog" aria-labelledby="planComplianceStatsTitle">
    <form method="dialog">
      <h2 id="planComplianceStatsTitle">교과(군) 편성 통계</h2>
      <div id="planComplianceStatsBody"></div>
      <div class="curriculum-version-dialog-actions">
        <button class="button button-primary" type="submit" formnovalidate>닫기</button>
      </div>
    </form>
  </dialog>
  <dialog class="curriculum-subject-dialog plan-autoname-dialog" id="planAutoNameDialog" aria-labelledby="planAutoNameTitle">
    <form method="dialog">
      <h2 id="planAutoNameTitle">공식 과목명 자동 수정</h2>
      <p class="note">업로드·원본 재변환 때 2022 개정 교육과정 과목 목록과 띄어쓰기·Ⅰ/1 표기·가운뎃점·괄호만 다르거나 오탈자 후보가 하나뿐인 과목명을 공식명으로 고쳤습니다. 수강신청 결과·선택 그룹이 원래 이름을 써도 같은 과목으로 연결됩니다.</p>
      <label class="plan-autoname-toggle"><input type="checkbox" id="planAutoNameEnabled"> 이 편제표에서 공식 과목명 자동 수정</label>
      <div id="planAutoNameList"></div>
      <div class="curriculum-subject-actions">
        <button class="button button-primary" type="submit" formnovalidate>닫기</button>
      </div>
    </form>
  </dialog>
  <dialog class="curriculum-subject-dialog plan-section-dialog" id="planSectionDialog" aria-labelledby="planSectionTitle">
    <form method="dialog" id="planSectionForm">
      <h2 id="planSectionTitle">편성 영역</h2>
      <p class="note" id="planSectionSubject"></p>
      <div id="planSectionOptions" class="plan-section-options"></div>
      <p class="note">점검표(지정·선택 중복 편성, 선택권 보장)와 교과(군) 통계에 씁니다. 편제표 내보내기 양식은 바뀌지 않습니다.</p>
      <div class="curriculum-subject-actions">
        <button class="button" type="button" data-pc-action="section-cancel">취소</button>
        <button class="button button-primary" type="submit">적용</button>
      </div>
    </form>
  </dialog>`);
}

function planComplianceRevisionNote(result) {
  const { report, plan } = result;
  const notes = [];
  if (plan.type === "annual") {
    notes.push("전학년 편제표는 학년마다 입학연도가 달라, 총 이수 학점·필수 이수·학기 격차·이수 순서·위계 등 3개년 기준은 아래 입학생 편제표에서 점검합니다. 여기서는 학점 범위·과목명·체육 매 학기·3학년 2학기 수능 과목만 봅니다(2022 개정 학년만).");
  } else if (report.revision.mismatch) {
    notes.push(`편제표 제목은 ${report.revision.titleYear}학년도인데 ${plan.year}학년도 카드에 올라와 있습니다. 파일이 맞는지 확인하세요.`);
  }
  return notes.map((text) => `<p class="plan-compliance-notice">${planComplianceEscape(text)}</p>`).join("");
}

function planComplianceSourcesHtml(report) {
  if (!report.sources) return "";
  const rows = report.sources.map((source) => {
    const status = !source.available ? "편제표 없음" : source.revision !== "2022" ? "2015 개정 · 2022 개정 기준 점검 대상 아님"
      : `확인필요 ${source.counts["확인필요"]} · 자체 확인 ${source.counts["자체 확인"]} · 인정 ${source.counts.acknowledged}`;
    return `<tr><th scope="row">${source.grade}학년</th><td>${source.year}학년도 입학생</td><td>${planComplianceEscape(status)}</td>
      <td>${source.available && source.revision === "2022" ? `<button class="button button-quiet" type="button" data-pc-open="${source.key}">점검표 열기</button>` : ""}</td></tr>`;
  }).join("");
  return `<table class="plan-compliance-sources"><caption>학년별 입학생 편제표 점검</caption><tbody>${rows}</tbody></table>`;
}

// 다시 점검(단추·자동): 직전 결과와 비교해 바뀐 항목을 잠깐 강조하고 "마지막 점검: 14:32 · 확인필요 2 → 1"을 보여 준다.
let planComplianceLastRun = null;
let planComplianceHighlight = { key: "", ids: new Set(), until: 0 };

function planComplianceRunState(result) {
  const saved = planComplianceSaved(result.plan.key);
  const statuses = Object.fromEntries(result.report.items.map((item) => [item.id, `${planComplianceDisplayStatus(item, saved).status}|${item.note}`]));
  return { key: result.plan.key, at: new Date(), counts: planComplianceCounts(result.report, saved), statuses };
}

function planComplianceTimeText(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function renderPlanComplianceDialog({ fresh = false, compare = false } = {}) {
  const body = document.getElementById("planComplianceBody");
  if (!body) return;
  const dialog = document.getElementById("planComplianceDialog");
  const result = planComplianceFor(planComplianceDialogKey, { fresh });
  const lastRun = document.getElementById("planComplianceLastRun");
  if (result && lastRun) {
    const next = planComplianceRunState(result);
    const previous = planComplianceLastRun?.key === next.key ? planComplianceLastRun : null;
    if (compare && previous) {
      const changed = Object.keys(next.statuses).filter((id) => previous.statuses[id] !== next.statuses[id]);
      if (changed.length) planComplianceHighlight = { key: next.key, ids: new Set(changed), until: Date.now() + 2500 };
      const before = previous.counts["확인필요"], after = next.counts["확인필요"];
      lastRun.textContent = `마지막 점검: ${planComplianceTimeText(next.at)} · 확인필요 ${before} → ${after}${changed.length ? ` · 바뀐 항목 ${changed.length}` : " · 바뀐 항목 없음"}`;
    } else if (!compare || !previous) {
      lastRun.textContent = `마지막 점검: ${planComplianceTimeText(next.at)} · 확인필요 ${next.counts["확인필요"]}`;
    }
    planComplianceLastRun = next;
  }
  const buttons = (selector, disabled) => dialog.querySelectorAll(selector).forEach((button) => { button.disabled = disabled; });
  if (!result) {
    body.innerHTML = '<p class="plan-compliance-notice">편제표 데이터가 없습니다. 편제표를 먼저 업로드하세요.</p>';
    buttons("[data-pc-action='export'], [data-pc-action='print'], [data-pc-action='stats']", true);
    return;
  }
  const { report, plan } = result;
  const saved = planComplianceSaved(plan.key);
  document.getElementById("planComplianceTitle").textContent = `${plan.label} 편제 점검표`;
  const skipped = plan.type !== "annual" && report.revision.revision === "2015";
  buttons("[data-pc-action='export'], [data-pc-action='print']", skipped);
  buttons("[data-pc-action='stats']", false);
  const revisionText = report.revision.revision === "mixed" ? "2022·2015 개정 혼합" : `${report.revision.revision} 개정 교육과정`;
  const source = `<p class="note plan-compliance-file">${planComplianceEscape(plan.fileName || "")} · ${revisionText}</p>`;
  if (skipped) {
    body.innerHTML = `${source}<p class="plan-compliance-notice is-strong">${planComplianceEscape(`${report.revision.titleYear || plan.year}학년도 입학생 편제표는 2015 개정 교육과정입니다. 2022 개정 기준 점검 대상이 아닙니다.`)}</p>`;
    return;
  }
  const counts = planComplianceCounts(report, saved);
  const extras = planComplianceItemExtras(result);
  const summary = `<p class="plan-compliance-summary" role="status"><span class="plan-compliance-chip is-ok">O ${counts["O"]}</span><span class="plan-compliance-chip is-check">확인필요 ${counts["확인필요"]}</span><span class="plan-compliance-chip is-self">자체 확인 ${counts["자체 확인"]}</span>${counts["해당 없음"] ? `<span class="plan-compliance-chip is-na">해당 없음 ${counts["해당 없음"]}</span>` : ""}${counts.acknowledged ? `<span class="plan-compliance-chip">인정 오류 ${counts.acknowledged}</span>` : ""}</p>`;
  const autoRows = report.items.map((item) => {
    const display = planComplianceDisplayStatus(item, saved);
    const ack = saved.ack?.[item.id] || {};
    const canAck = item.status !== "해당 없음";
    const flash = planComplianceHighlight.key === plan.key && planComplianceHighlight.until > Date.now() && planComplianceHighlight.ids.has(item.id) ? " is-recheck-changed" : "";
    const targets = display.status === "확인필요" ? planComplianceItemTargets(report, item) : null;
    const goto = targets ? `<button class="button button-quiet plan-compliance-goto" type="button" data-pc-goto="${item.id}" title="팝업을 닫고 편제표에서 ${planComplianceEscape(targets.label)}을(를) 보여 줍니다">해당 위치로</button>` : "";
    return `<tr class="${planComplianceStatusClass(display.status)}${flash}" data-pc-item="${item.id}">
      <td class="plan-compliance-no">${item.no}</td><td class="plan-compliance-area">${planComplianceEscape(item.area)}</td>
      <td>${planComplianceEscape(item.text)}${item.hint ? `<small>※ ${planComplianceEscape(item.hint)}</small>` : ""}</td>
      <td class="plan-compliance-result"><b>${planComplianceEscape(display.status)}</b>${display.acknowledged ? `<small>인정(원래 ${planComplianceEscape(item.status)})</small>` : ""}${goto}</td>
      <td class="plan-compliance-note">${planComplianceEscape(item.note)}${extras[item.id] ? `<small class="plan-compliance-extra">${planComplianceEscape(extras[item.id])}</small>` : ""}</td>
      <td class="plan-compliance-ack">${canAck ? `<label><input type="checkbox" data-pc-ack="${item.id}"${ack.on ? " checked" : ""} aria-label="${item.no}번 인정 오류"> 인정</label>` : ""}</td>
      <td class="plan-compliance-reason">${canAck ? `<input type="text" maxlength="300" data-pc-ack-reason="${item.id}" value="${planComplianceEscape(ack.reason || "")}" placeholder="의도한 편성 사유" aria-label="${item.no}번 인정 오류 사유">` : ""}${canAck && item.id === "a7" ? `<button class="button button-quiet plan-compliance-suggest" type="button" data-pc-suggest="${item.id}" title="${planComplianceEscape(PLAN_COMPLIANCE_KEM_SUGGESTION)}">제안 문구 넣기</button>` : ""}</td>
    </tr>`;
  }).join("");
  const selfRows = report.self.map((item) => {
    const entry = saved.self?.[item.id] || {};
    return `<tr data-pc-self-item="${item.id}" class="${entry.checked ? "is-ok" : ""}"><td class="plan-compliance-no">${item.no}</td><td class="plan-compliance-area">${planComplianceEscape(item.area)}</td>
      <td>${planComplianceEscape(item.text)}${item.id === "s4" ? `<small>※ 자율 이수 학점의 30%(${report.settings.specialization}학점) 이상을 해당 교과(군)의 과목으로 편성</small>` : ""}</td>
      <td class="plan-compliance-result"><label><input type="checkbox" data-pc-self="${item.id}"${entry.checked ? " checked" : ""} aria-label="자체 점검 ${item.no}번 확인"> 확인</label></td>
      <td class="plan-compliance-note">${planComplianceEscape(item.hint || "")}</td>
      <td colspan="2"><input type="text" maxlength="300" data-pc-self-memo="${item.id}" value="${planComplianceEscape(entry.memo || "")}" placeholder="메모" aria-label="자체 점검 ${item.no}번 메모"></td></tr>`;
  }).join("");
  body.innerHTML = `${source}${planComplianceRevisionNote(result)}${planComplianceSourcesHtml(report)}${summary}
    <div class="plan-compliance-table-wrap"><table class="plan-compliance-table">
      <thead><tr><th>연번</th><th>영역</th><th>점검 내용</th><th>점검 결과</th><th>비고</th><th>인정오류</th><th>인정오류 사유</th></tr></thead>
      <tbody><tr class="plan-compliance-section"><th colspan="7">편성과목 기반 자동점검</th></tr>${autoRows}
      <tr class="plan-compliance-section"><th colspan="7">자체점검</th></tr>${selfRows}</tbody></table></div>
    <p class="note">인정오류: 의도한 편성이면 '인정'에 표시하고 사유를 적으세요. 점검 결과가 O로 바뀌고 원래 결과는 함께 남습니다. 입력하면 바로 저장됩니다.</p>`;
}

function openPlanComplianceDialog(key, { compare = false } = {}) {
  planComplianceDialogs();
  planComplianceDialogKey = key;
  renderPlanComplianceDialog({ fresh: true, compare });
  const dialog = document.getElementById("planComplianceDialog");
  if (!dialog.open) dialog.showModal();
}

// 점검표·통계 팝업과 카드 배지를 다시 그린다. sheet: 기준값이 바뀌어 편제표 표의 경고도 다시 그릴 때.
function planComplianceRefresh(sheet = false) {
  if (document.getElementById("planComplianceDialog")?.open) renderPlanComplianceDialog({ compare: true });
  if (document.getElementById("planComplianceStatsDialog")?.open) renderPlanComplianceStats();
  if (sheet && Number(state.workflowStep) === 1 && state.curriculumImportedLayout && typeof renderCurriculumDataKeepingScroll === "function") renderCurriculumDataKeepingScroll();
  else if (typeof renderCurriculumCohortUploads === "function") renderCurriculumCohortUploads();
}

function renderPlanComplianceSettings() {
  const body = document.getElementById("planComplianceSettingsBody");
  if (!body) return;
  const settings = planComplianceCurrentSettings();
  const field = (name, label, value, attrs = "") => `<label class="plan-compliance-setting">${planComplianceEscape(label)}<input type="number" min="0" step="any" data-pc-setting="${planComplianceEscape(name)}" value="${planComplianceEscape(value)}"${attrs}></label>`;
  body.innerHTML = `<div class="plan-compliance-settings-grid">
      ${field("subjects", "교과 총 이수 학점(이상)", settings.subjects)}
      ${field("creative", "창의적 체험활동(이상)", settings.creative)}
      ${field("kemLimit", "국어·수학·영어 합 상한", settings.kemLimit)}
      ${field("kemExtraRatio", "174 초과분 중 국수영 허용(%)", settings.kemExtraRatio, ' max="100"')}
      ${field("semesterGap", "학기 간 격차 상한", settings.semesterGap)}
      ${field("peTotal", "체육 최소 학점", settings.peTotal)}
      ${field("specialization", "교과특성화 기준 학점", settings.specialization)}
      <label class="plan-compliance-setting plan-compliance-check"><input type="checkbox" data-pc-setting="peEverySemester"${settings.peEverySemester ? " checked" : ""}> 체육 매 학기 편성</label>
    </div>
    <h3>교과(군)별 필수 이수 학점 <small>(한국사 6과 사회(역사/도덕 포함) 8은 따로)</small></h3>
    <div class="plan-compliance-settings-grid">${PLAN_COMPLIANCE_FAMILIES.map((family) => field(`required:${family}`, family, settings.required[family])).join("")}</div>
    <label class="plan-compliance-setting plan-compliance-wide">수능 출제 과목(쉼표로 구분 · 3학년 2학기 편성·미편성 점검)<textarea rows="2" data-pc-setting="suneung">${planComplianceEscape(settings.suneung.join(", "))}</textarea></label>
    <p class="note">위계(선이수) 규칙은 2단계 '위계·학점 점검 설정'과 같은 규칙을 씁니다.</p>`;
}

function planComplianceUpdateSetting(input) {
  const store = planComplianceStore();
  const settings = planComplianceNormalizeSettings(store.settings);
  const name = input.dataset.pcSetting;
  if (name === "peEverySemester") settings.peEverySemester = input.checked;
  else if (name === "suneung") settings.suneung = input.value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
  else if (name.startsWith("required:")) settings.required[name.slice(9)] = input.value;
  else settings[name] = input.value;
  store.settings = planComplianceNormalizeSettings(settings);
  if (typeof persistState === "function") persistState();
  planComplianceRefresh(true);
  if (typeof courseCheckSharedSettingsChanged === "function") courseCheckSharedSettingsChanged();
}

// 기준 설정 팝업 열기(2단계 '위계·학점 점검' 팝업의 "편제 점검 기준 설정에서 바꿉니다" 단추도 이것을 부른다).
function openPlanComplianceSettings() {
  planComplianceDialogs();
  renderPlanComplianceSettings();
  const dialog = document.getElementById("planComplianceSettingsDialog");
  if (!dialog.open) dialog.showModal();
  dialog.querySelector("[data-pc-setting]")?.focus();
}

function renderPlanComplianceStats() {
  const body = document.getElementById("planComplianceStatsBody");
  if (!body) return;
  const result = planComplianceFor(planComplianceDialogKey);
  if (!result) { body.innerHTML = '<p class="plan-compliance-notice">편제표 데이터가 없습니다.</p>'; return; }
  const { report, plan } = result;
  const stats = report.stats;
  const r = planComplianceRound;
  document.getElementById("planComplianceStatsTitle").textContent = `${plan.label} · 교과(군) 편성 통계`;
  const cell = (row, field) => {
    const designated = row.designated[field], min = row.choiceMin[field], max = row.choiceMax[field];
    if (!designated && !max && !row.extra[field]) return '<td class="is-empty">·</td>';
    return `<td>${designated ? `<b>${r(designated)}</b>` : ""}${max ? `<small class="is-choice">선택 ${r(min)}~${r(max)}</small>` : ""}${row.extra[field] ? `<small class="is-extra">순증 ${r(row.extra[field])}</small>` : ""}</td>`;
  };
  const familyRows = stats.families.filter((row) => row.family !== "기타" || row.max || row.extraTotal).map((row) => `<tr${row.margin !== null && row.margin < 0 ? ' class="is-check"' : ""}>
      <th scope="row">${planComplianceEscape(row.family)}</th><td>${row.required ?? ""}</td>${PLAN_COMPLIANCE_FIELDS.map((field) => cell(row, field)).join("")}
      <td>${r(row.designatedTotal)}</td><td>${r(row.choiceMinTotal)}~${r(row.choiceMaxTotal)}${row.sharedReduction > 0 ? `<small class="plan-compliance-shared" title="같은 과목이 여러 선택과목군에 있어 한 번만 고를 수 있게 계산했습니다">같은 과목 중복 −${r(row.sharedReduction)}</small>` : ""}</td><td><b>${r(row.min)}~${r(row.max)}</b></td>
      <td>${row.margin === null ? "" : `${row.margin >= 0 ? "+" : ""}${r(row.margin)}`}</td></tr>`).join("");
  const kem = stats.kem;
  const limit = report.settings.kemLimit + Math.max(0, stats.totalMax - report.settings.subjects) * report.settings.kemExtraRatio / 100;
  const kemRow = `<tr class="plan-compliance-kem${kem.max > limit ? " is-check" : ""}"><th scope="row">국어·수학·영어 합</th><td>≤ ${r(limit)}</td><td colspan="6" class="plan-compliance-kem-note">한 묶음에서 세 교과를 함께 고르는 경우를 합쳐 계산(교과별 최대의 단순 합이 아님)${kem.extra ? ` · 순증 ${r(kem.extra)}학점 별도` : ""}</td>
    <td>${r(kem.designated)}</td><td>${r(kem.choiceMin)}~${r(kem.choiceMax)}${kem.sharedReduction > 0 ? `<small class="plan-compliance-shared">같은 과목 중복 −${r(kem.sharedReduction)}</small>` : ""}</td><td><b>${r(kem.min)}~${r(kem.max)}</b></td><td>${limit - kem.max >= 0 ? "+" : ""}${r(limit - kem.max)}</td></tr>`;
  const totalRow = `<tr class="plan-compliance-total"><th scope="row">학기 합계</th><td>${report.settings.subjects}</td>${PLAN_COMPLIANCE_FIELDS.map((field) => `<td><b>${r(stats.semester[field].total)}</b></td>`).join("")}<td></td><td></td><td><b>${r(stats.totalMin)}${stats.totalMax > stats.totalMin ? `~${r(stats.totalMax)}` : ""}</b></td><td>${stats.totalMin - report.settings.subjects >= 0 ? "+" : ""}${r(stats.totalMin - report.settings.subjects)}</td></tr>`;
  const domainRows = PLAN_COMPLIANCE_DOMAINS.map((domain) => {
    const entry = stats.domains[domain];
    const total = PLAN_COMPLIANCE_FIELDS.reduce((sum, field) => sum + entry.credits[field], 0);
    return `<tr><th scope="row"><span class="plan-section-tag is-${PLAN_SECTION_BY_LABEL[domain]}">${PLAN_COMPLIANCE_DOMAIN_SHORT[domain]}</span> ${domain}</th><td>${entry.subjects}</td>${PLAN_COMPLIANCE_FIELDS.map((field) => `<td>${entry.credits[field] ? r(entry.credits[field]) : "·"}</td>`).join("")}<td><b>${r(total)}</b></td></tr>`;
  }).join("");
  const heads = PLAN_COMPLIANCE_FIELDS.map((field) => `<th>${planComplianceFieldLabel(field, true)}</th>`).join("");
  body.innerHTML = `${plan.type !== "annual" && report.revision.revision === "2015" ? '<p class="plan-compliance-notice">2015 개정 편제표입니다. 필수 이수 학점은 2022 개정 기준으로 비교했으니 참고만 하세요.</p>' : ""}
    ${plan.type === "annual" ? '<p class="plan-compliance-notice">전학년 편제표는 선택과목군(택n) 정보가 없어 모든 과목을 편성된 학점으로 셉니다. 학생별 이수 범위는 입학생 편제표 통계를 보세요.</p>' : ""}
    <div class="plan-compliance-table-wrap"><table class="plan-compliance-stats">
      <caption>교과(군)별 학기 학점 · 굵은 숫자는 학교지정·교차집중(모든 학생), '선택 a~b'는 선택과목군에서 학생이 이수할 수 있는 최소~최대</caption>
      <thead><tr><th>교과(군)</th><th>필수</th>${heads}<th>지정 합</th><th>선택</th><th>학생 이수</th><th>필수 대비 여유</th></tr></thead>
      <tbody>${familyRows}${kemRow}${totalRow}</tbody></table></div>
    <div class="plan-compliance-table-wrap"><table class="plan-compliance-stats">
      <caption>편성 영역별 학점(학생 1명 기준 · 학생선택은 택 수 × 과목당 학점, 소인수·공동은 순증)</caption>
      <thead><tr><th>편성 영역</th><th>과목 수</th>${heads}<th>합계</th></tr></thead><tbody>${domainRows}</tbody></table></div>
    <p class="note">학생 이수 최소~최대는 모든 선택과목군(택n)의 택 수를 채우면서 <b>같은 과목은 한 번만</b> 고르는 경우로 정확히 계산합니다(같은 과목이 1·2학기 묶음에 모두 있어도 두 번 세지 않음). 학기 칸의 '선택 a~b'는 그 학기 묶음만 본 값입니다. 소인수·공동(학기 칸 메모, 순증) 과목은 합계에 넣지 않습니다. 국어·수학·영어 81학점은 편성 단계 최대로 보며, 학생이 실제로 고른 과목 기준은 2단계 이수학점 점검에서 경고합니다.</p>`;
}

function planComplianceFileName(plan) {
  return `${plan.label.replace(/[()]/g, "").replace(/\s+/g, "_")}_편제점검표.xlsx`;
}

function exportPlanCompliance() {
  const result = planComplianceFor(planComplianceDialogKey, { fresh: true });
  if (!result || typeof createWorkbookBlob !== "function" || typeof downloadBlob !== "function") return;
  const { report, plan } = result;
  const sheet = planComplianceSheetRows(report, planComplianceSaved(plan.key), `${plan.label} 교육과정 편제 점검표`, planComplianceItemExtras(result));
  const statsSheet = planComplianceStatsRows(report, `${plan.label} 교과(군) 편성 통계`);
  downloadBlob(createWorkbookBlob([
    { name: "점검표", rows: sheet.rows, merges: sheet.merges, widths: sheet.widths, freeze: "A4" },
    { name: "교과(군) 통계", rows: statsSheet.rows, widths: statsSheet.widths, merges: ["A1:P1"], freeze: "B4" }
  ]), planComplianceFileName(plan));
  if (typeof showAppToast === "function") showAppToast("편제 점검표를 엑셀로 내려받았습니다.");
}

function printPlanCompliance() {
  const result = planComplianceFor(planComplianceDialogKey, { fresh: true });
  const target = document.getElementById("printBatch");
  if (!result || !target) return;
  const { report, plan } = result;
  const saved = planComplianceSaved(plan.key);
  const extras = planComplianceItemExtras(result);
  const rows = report.items.map((item) => {
    const display = planComplianceDisplayStatus(item, saved);
    const ack = saved.ack?.[item.id];
    return `<tr><td>${item.no}</td><td>${planComplianceEscape(item.area)}</td><td>${planComplianceEscape(item.text)}</td><td><b>${planComplianceEscape(display.status)}</b></td>
      <td>${planComplianceEscape([display.acknowledged ? `(원래 결과: ${item.status})` : "", item.note, extras[item.id] || ""].filter(Boolean).join(" "))}</td><td>${ack?.on ? "O" : ""}</td><td>${planComplianceEscape(ack?.reason || "")}</td></tr>`;
  }).join("");
  const selfRows = report.self.map((item) => {
    const entry = saved.self?.[item.id];
    return `<tr><td>${item.no}</td><td>${planComplianceEscape(item.area)}</td><td>${planComplianceEscape(item.text)}</td><td>${entry?.checked ? "확인" : ""}</td><td>${planComplianceEscape([entry?.memo || "", item.hint].filter(Boolean).join(" · "))}</td><td></td><td></td></tr>`;
  }).join("");
  target.innerHTML = `<div class="print-page plan-compliance-print"><h1>${planComplianceEscape(plan.label)} 교육과정 편제 점검표</h1>
    <table><thead><tr><th>연번</th><th>영역</th><th>점검 내용</th><th>점검 결과</th><th>비고</th><th>인정오류</th><th>인정오류 사유</th></tr></thead>
    <tbody><tr><th colspan="7">편성과목 기반 자동점검</th></tr>${rows}<tr><th colspan="7">자체점검</th></tr>${selfRows}</tbody></table></div>`;
  window.print();
}

// 편제표가 바뀌면(편집·실행취소·업로드·원본 재변환·자동 수정 되돌리기) 부른다. 팝업이 열려 있으면 바로 다시 점검한다.
// 카드 배지·표의 주황 경고·범례는 renderCurriculumStep이 다시 그린다(planComplianceFor는 바뀐 데이터로 새로 계산).
function planComplianceChanged() {
  if (typeof document === "undefined") return;
  if (document.getElementById("planComplianceDialog")?.open) renderPlanComplianceDialog({ compare: true });
  if (document.getElementById("planComplianceStatsDialog")?.open) renderPlanComplianceStats();
}

// 다시 점검 뒤 화면(카드 배지·표 경고)도 같은 결과로 맞춘다.
function planComplianceSyncScreen() {
  if (typeof renderCurriculumCohortUploads === "function") renderCurriculumCohortUploads();
  if (typeof state !== "undefined" && Number(state.workflowStep) === 1) decoratePlanComplianceSheet();
}

// '해당 위치로': 팝업을 닫고 편제표에서 그 과목 행(또는 소계 행)으로 스크롤·강조. 표 위에 '편제 점검으로 돌아가기' 단추를 잠시 둔다.
function planComplianceGoto(key, itemId) {
  const result = planComplianceFor(key);
  const item = result?.report.items.find((entry) => entry.id === itemId);
  const targets = item ? planComplianceItemTargets(result.report, item) : null;
  if (!targets) return;
  document.getElementById("planComplianceDialog")?.close();
  if (planComplianceActiveKey() !== key) {
    const [type, year] = key.split(":");
    document.querySelector(type === "annual" ? `[data-annual-view="${year}"]` : `[data-cohort-view="${year}"]`)?.click();
  }
  const wrap = document.getElementById("curriculumPlanWrap");
  if (!wrap) return;
  const find = () => targets.footer ? [...wrap.querySelectorAll("tr.curriculum-footer-row")].slice(0, 1)
    : targets.rows.map((id) => wrap.querySelector(`tr[data-plan-row="${CSS.escape(id)}"]`)).filter(Boolean);
  let found = find();
  if (found.length < Math.max(1, targets.rows.length) && Object.values(state.curriculumPlanFilters || {}).some(Boolean)) {
    state.curriculumPlanFilters = { grade: "", division: "", area: "", detail: "", query: "" };
    if (typeof renderCurriculumStep === "function") renderCurriculumStep();
    found = find();
  }
  wrap.querySelectorAll(".is-plan-focus").forEach((row) => row.classList.remove("is-plan-focus"));
  found.forEach((row) => row.classList.add("is-plan-focus"));
  found[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
  window.setTimeout(() => found.forEach((row) => row.classList.remove("is-plan-focus")), 4000);
  planComplianceShowReturn(key, `${item.no}번 ${targets.label}`);
}

let planComplianceReturnTimer = null;
function planComplianceShowReturn(key, label) {
  let bar = document.getElementById("planComplianceReturn");
  if (!bar) {
    document.getElementById("planWarnLegend")?.insertAdjacentHTML("afterend", '<span id="planComplianceReturn" class="plan-compliance-return hidden"><span id="planComplianceReturnText"></span> <button class="button button-primary" type="button" id="planComplianceReturnButton">편제 점검으로 돌아가기(다시 점검)</button></span>');
    bar = document.getElementById("planComplianceReturn");
    if (!bar) return;
    document.getElementById("planComplianceReturnButton").addEventListener("click", () => {
      bar.classList.add("hidden");
      openPlanComplianceDialog(bar.dataset.key, { compare: true });
    });
  }
  bar.dataset.key = key;
  document.getElementById("planComplianceReturnText").textContent = `편제 점검 ${label}을(를) 보는 중 · 고친 뒤`;
  bar.classList.remove("hidden");
  if (planComplianceReturnTimer) window.clearTimeout(planComplianceReturnTimer);
  planComplianceReturnTimer = window.setTimeout(() => bar.classList.add("hidden"), 120000);
}

// ---- 편성 영역(행 메뉴)
let planSectionTarget = null;
function openPlanSectionDialog(id) {
  const layout = state.curriculumImportedLayout;
  const subject = layout?.planData?.subjects?.find((item) => item.id === id);
  if (!subject || layout.derived) return;
  planComplianceDialogs();
  planSectionTarget = id;
  const auto = planSectionAuto(subject, layout.planData);
  const current = subject.planSectionManual ? subject.planSection : "";
  document.getElementById("planSectionSubject").textContent = `${subject.name} · 자동 추정: ${PLAN_SECTION_CODES[auto]}`;
  document.getElementById("planSectionOptions").innerHTML = [["", `자동(${PLAN_SECTION_CODES[auto]})`], ...Object.entries(PLAN_SECTION_CODES)]
    .map(([code, label]) => `<label><input type="radio" name="planSection" value="${code}"${code === current ? " checked" : ""}> ${planComplianceEscape(label)}</label>`).join("");
  document.getElementById("planSectionDialog").showModal();
}

function applyPlanSectionDialog() {
  const id = planSectionTarget;
  const code = document.querySelector("#planSectionOptions input[name='planSection']:checked")?.value ?? "";
  document.getElementById("planSectionDialog").close();
  planSectionTarget = null;
  if (!id || typeof commitCurriculumDataEdit !== "function") return;
  const subject = state.curriculumImportedLayout?.planData?.subjects?.find((item) => item.id === id);
  if (!subject || (subject.planSectionManual ? subject.planSection : "") === code) return;
  commitCurriculumDataEdit((current) => curriculumDataEdit(current, (data) => {
    const target = data.subjects.find((item) => item.id === id);
    if (!target) throw new Error("과목 행을 찾지 못했습니다.");
    if (code) { target.planSection = code; target.planSectionManual = true; }
    else { delete target.planSection; delete target.planSectionManual; }
  }), code ? `'${subject.name}' 편성 영역을 ${PLAN_SECTION_CODES[code]}(으)로 정했습니다.` : `'${subject.name}' 편성 영역을 자동 추정으로 되돌렸습니다.`);
}

// ---- 편제표 표에 영역 표시·학점/과목명 경고(app.js renderCurriculumStep에서 표를 그린 뒤 부른다)
// ---- 공식 과목명 자동 수정 표시·되돌리기(curriculum-data.js curriculumDataAutoNames)
function planAutoNameDecorate(wrap) {
  const layout = typeof state !== "undefined" ? state.curriculumImportedLayout : null;
  const notice = document.getElementById("planAutoNameNotice");
  const list = typeof curriculumAutoNameList === "function" ? curriculumAutoNameList(layout) : [];
  if (notice) {
    const off = Boolean(layout?.autoNameOff) && !layout?.derived;
    notice.classList.toggle("hidden", !list.length && !off);
    document.getElementById("planAutoNameNoticeText").textContent = list.length ? `공식 과목명으로 ${list.length}곳 자동 수정` : off ? "공식 과목명 자동 수정 꺼짐" : "";
  }
  for (const item of list) {
    const cell = wrap.querySelector(`tr[data-plan-row="${CSS.escape(item.id)}"] .curriculum-subject-cell`);
    if (!cell || cell.querySelector(".plan-autoname-mark")) continue;
    cell.insertAdjacentHTML("beforeend", ` <span class="plan-autoname-mark" title="자동 수정 · 원래: ${planComplianceEscape(item.from)}">자동 수정</span>`);
  }
}

function renderPlanAutoNameDialog() {
  const layout = state.curriculumImportedLayout;
  const list = typeof curriculumAutoNameList === "function" ? curriculumAutoNameList(layout) : [];
  const enabled = document.getElementById("planAutoNameEnabled");
  enabled.checked = !layout?.autoNameOff;
  enabled.disabled = !layout?.planData || Boolean(layout.derived);
  document.getElementById("planAutoNameList").innerHTML = list.length
    ? `<table class="plan-compliance-sources"><thead><tr><th>원래 이름</th><th>공식 과목명</th><th></th></tr></thead><tbody>${list.map((item) => `<tr><td>${planComplianceEscape(item.from)}</td><td>${planComplianceEscape(item.to)}</td><td><button class="button button-quiet" type="button" data-autoname-revert="${planComplianceEscape(item.id)}">되돌리기</button></td></tr>`).join("")}</tbody></table>`
    : `<p class="note">${layout?.autoNameOff ? "자동 수정이 꺼져 있습니다. 켜면 지금 과목명을 다시 고칩니다." : "자동으로 고친 과목명이 없습니다."}</p>`;
}

function openPlanAutoNameDialog() {
  planComplianceDialogs();
  renderPlanAutoNameDialog();
  const dialog = document.getElementById("planAutoNameDialog");
  if (!dialog.open) dialog.showModal();
}

function decoratePlanComplianceSheet() {
  const wrap = document.getElementById("curriculumPlanWrap");
  const legend = document.getElementById("planWarnLegend");
  legend?.classList.add("hidden");
  if (wrap) planAutoNameDecorate(wrap);
  const key = planComplianceActiveKey();
  if (!wrap || !key) return;
  let result = null;
  try { result = planComplianceFor(key); } catch { result = null; }
  if (!result) return;
  try { planComplianceDecorateRows(wrap, result); } finally {
    // 범례: 주황 테두리의 뜻(편제 점검 3번 학점 범위 확인)을 표 위에 알린다.
    const count = wrap.querySelectorAll("tr[data-plan-row] .curriculum-subject-cell.is-plan-warn-row").length;
    if (legend && count) {
      legend.classList.remove("hidden");
      document.getElementById("planWarnLegendText").textContent = `주황 테두리 = 학점 범위 확인 ${count}과목(편제 점검 3번 · 칸에 마우스를 올리면 이유)`;
    }
  }
}

function planComplianceDecorateRows(wrap, result) {
  const { report, plan } = result;
  const columns = plan.layout.planTemplate?.columns || {};
  const warn = report.revision.revision !== "2015";
  const readOnly = Boolean(plan.layout.derived);
  const rows = new Map(report.model.rows.map((row) => [row.id, row]));
  for (const tr of wrap.querySelectorAll("tr[data-plan-row]")) {
    const row = rows.get(tr.dataset.planRow);
    if (!row) continue;
    const nameCell = tr.querySelector(".curriculum-subject-cell");
    if (nameCell && !nameCell.querySelector(".plan-section-tag")) {
      const code = PLAN_SECTION_BY_LABEL[row.domain];
      nameCell.insertAdjacentHTML("beforeend", ` <span class="plan-section-tag is-${code}${row.overridden ? " is-manual" : ""}" title="편성 영역: ${planComplianceEscape(row.domain)}${row.overridden ? "(교사 지정)" : "(자동 추정)"}${readOnly ? "" : " · 행 메뉴(⋯)에서 바꿀 수 있습니다"}">${PLAN_COMPLIANCE_DOMAIN_SHORT[row.domain]}</span>`);
    }
    if (!warn) continue;
    const issues = report.subjectIssues.get(row.id) || [];
    const range = issues.filter((issue) => issue.kind === "range");
    if (range.length) {
      const message = `학점 범위 확인(편제 점검 3번) — ${range.map((issue) => issue.reason || `${issue.text} · ${issue.where}`).join(" / ")}. 학기 학점·운영학점·묶음(택n)·교차집중 설정을 확인하세요.`;
      const creditColumn = columns.op >= 0 ? columns.op : columns.base;
      const cells = [...tr.querySelectorAll(`td[data-source-column="${creditColumn}"]`)];
      for (const field of Object.keys(row.designated)) {
        const column = columns.semesters?.[PLAN_COMPLIANCE_FIELDS.indexOf(field)];
        if (column >= 0) cells.push(...tr.querySelectorAll(`td[data-source-column="${column}"]`));
      }
      for (const cell of cells) { cell.classList.add("is-plan-warn"); cell.title = message; }
      if (nameCell) { nameCell.classList.add("is-plan-warn-row"); nameCell.title = message; }
    }
    for (const issue of issues.filter((item) => item.kind === "spelling" || item.kind === "unlisted")) {
      const button = [...(nameCell?.querySelectorAll(".curriculum-subject-name") || [])]
        .find((item) => planComplianceNameKey(item.dataset.curriculumSubject) === planComplianceNameKey(issue.name));
      if (!button || button.dataset.planWarned) continue;
      button.dataset.planWarned = "1";
      button.classList.add("is-plan-name-warn");
      button.title = issue.text;
      if (issue.kind === "spelling" && !readOnly) {
        button.insertAdjacentHTML("afterend", `<button type="button" class="plan-rename-button" data-pc-rename="${planComplianceEscape(row.id)}" data-pc-from="${planComplianceEscape(issue.name)}" data-pc-to="${planComplianceEscape(issue.suggestion)}" title="과목명을 '${planComplianceEscape(issue.suggestion)}'(으)로 바꾸기">바꾸기 → ${planComplianceEscape(issue.suggestion)}</button>`);
      }
    }
  }
}

function renamePlanSubject(id, from, to) {
  const subject = state.curriculumImportedLayout?.planData?.subjects?.find((item) => item.id === id);
  if (!subject || typeof commitCurriculumDataEdit !== "function") return;
  if (!window.confirm(`'${from}'을(를) 공식 과목명 '${to}'(으)로 바꿀까요?\n2단계 선택 그룹·수강신청 결과의 과목명과 다르면 함께 맞춰야 합니다. 실행취소로 되돌릴 수 있습니다.`)) return;
  commitCurriculumDataEdit((current) => curriculumDataEdit(current, (data) => {
    const target = data.subjects.find((item) => item.id === id);
    const name = target ? planComplianceReplaceName(target.name, from, to) : null;
    if (!name) throw new Error(`'${from}' 과목명을 찾지 못했습니다.`);
    target.name = name;
  }), `'${from}' 과목명을 '${to}'(으)로 바꿨습니다.`);
}

function initPlanCompliance() {
  if (!document.getElementById("curriculumCohortUploads")) return;
  planComplianceDialogs();
  document.getElementById("curriculumCohortUploads").addEventListener("click", (event) => {
    const button = event.target.closest("[data-plan-compliance]");
    if (button) openPlanComplianceDialog(button.dataset.planCompliance);
  });
  const dialog = document.getElementById("planComplianceDialog");
  dialog.addEventListener("click", (event) => {
    const open = event.target.closest("[data-pc-open]");
    if (open) { planComplianceDialogKey = open.dataset.pcOpen; renderPlanComplianceDialog(); return; }
    const action = event.target.closest("[data-pc-action]")?.dataset.pcAction;
    if (action === "settings") openPlanComplianceSettings();
    if (action === "recheck") { renderPlanComplianceDialog({ fresh: true, compare: true }); planComplianceSyncScreen(); }
    const goto = event.target.closest("[data-pc-goto]");
    if (goto) { planComplianceGoto(planComplianceDialogKey, goto.dataset.pcGoto); return; }
    const suggest = event.target.closest("[data-pc-suggest]");
    if (suggest) {
      const id = suggest.dataset.pcSuggest;
      const input = dialog.querySelector(`[data-pc-ack-reason="${id}"]`);
      const current = String(input?.value || "").trim();
      if (current && current !== PLAN_COMPLIANCE_KEM_SUGGESTION && !window.confirm(`적어 둔 사유를 제안 문구로 바꿀까요?\n지금: ${current}`)) return;
      planComplianceSave(planComplianceDialogKey, (plan) => { plan.ack[id] = { ...(plan.ack[id] || {}), reason: PLAN_COMPLIANCE_KEM_SUGGESTION }; });
      planComplianceRefresh();
      dialog.querySelector(`[data-pc-ack="${id}"]`)?.focus();
    }
    if (action === "stats") { renderPlanComplianceStats(); document.getElementById("planComplianceStatsDialog").showModal(); }
    if (action === "export") exportPlanCompliance();
    if (action === "print") printPlanCompliance();
  });
  dialog.addEventListener("change", (event) => {
    const target = event.target;
    const key = planComplianceDialogKey;
    const update = (bucket, id, patch) => planComplianceSave(key, (plan) => { plan[bucket][id] = { ...(plan[bucket][id] || {}), ...patch }; });
    if (target.dataset.pcAck) {
      update("ack", target.dataset.pcAck, { on: target.checked });
      planComplianceRefresh();
      if (target.checked) dialog.querySelector(`[data-pc-ack-reason="${target.dataset.pcAck}"]`)?.focus();
    } else if (target.dataset.pcAckReason) update("ack", target.dataset.pcAckReason, { reason: target.value });
    else if (target.dataset.pcSelf) {
      update("self", target.dataset.pcSelf, { checked: target.checked });
      target.closest("tr")?.classList.toggle("is-ok", target.checked);
    } else if (target.dataset.pcSelfMemo) update("self", target.dataset.pcSelfMemo, { memo: target.value });
  });
  const settingsDialog = document.getElementById("planComplianceSettingsDialog");
  settingsDialog.addEventListener("change", (event) => { if (event.target.dataset.pcSetting) planComplianceUpdateSetting(event.target); });
  settingsDialog.addEventListener("click", (event) => {
    if (!event.target.closest("[data-pc-action='reset-settings']")) return;
    delete planComplianceStore().settings;
    if (typeof persistState === "function") persistState();
    renderPlanComplianceSettings();
    planComplianceRefresh(true);
    if (typeof courseCheckSharedSettingsChanged === "function") courseCheckSharedSettingsChanged();
  });
  document.getElementById("planAutoNameOpen")?.addEventListener("click", openPlanAutoNameDialog);
  const autoDialog = document.getElementById("planAutoNameDialog");
  autoDialog.addEventListener("click", (event) => {
    const revert = event.target.closest("[data-autoname-revert]");
    if (!revert || typeof commitCurriculumDataEdit !== "function") return;
    const item = curriculumAutoNameList(state.curriculumImportedLayout).find((entry) => entry.id === revert.dataset.autonameRevert);
    if (!item) return;
    commitCurriculumDataEdit((current) => curriculumDataRevertAutoName(current, item.id), `'${item.to}'을(를) 원래 이름 '${item.from}'(으)로 되돌렸습니다.`);
    renderPlanAutoNameDialog();
  });
  autoDialog.addEventListener("change", (event) => {
    if (event.target.id !== "planAutoNameEnabled" || typeof commitCurriculumDataEdit !== "function") return;
    const on = event.target.checked;
    commitCurriculumDataEdit((current) => curriculumDataSetAutoNames(current, on, state.curriculumCohortYear),
      on ? "이 편제표의 공식 과목명 자동 수정을 켰습니다." : "이 편제표의 공식 과목명 자동 수정을 끄고 원래 이름으로 되돌렸습니다.");
    renderPlanAutoNameDialog();
  });
  const sectionForm = document.getElementById("planSectionForm");
  sectionForm.addEventListener("submit", (event) => { event.preventDefault(); applyPlanSectionDialog(); });
  sectionForm.querySelector("[data-pc-action='section-cancel']").addEventListener("click", () => { document.getElementById("planSectionDialog").close(); planSectionTarget = null; });
  // 행 메뉴(curriculum-data-view.js)에 '편성 영역' 항목을 더한다.
  const menu = document.getElementById("curriculumRowMenu");
  if (menu && !menu.querySelector("[data-pc-section-menu]")) {
    menu.insertAdjacentHTML("beforeend", '<button type="button" role="menuitem" data-pc-section-menu>편성 영역 바꾸기…</button>');
    menu.addEventListener("click", (event) => {
      if (!event.target.closest("[data-pc-section-menu]")) return;
      const id = typeof curriculumRowMenuTarget !== "undefined" ? curriculumRowMenuTarget : null;
      if (typeof closeCurriculumRowMenu === "function") closeCurriculumRowMenu();
      if (id) openPlanSectionDialog(id);
    });
  }
  document.getElementById("curriculumPlanWrap")?.addEventListener("click", (event) => {
    const rename = event.target.closest("[data-pc-rename]");
    if (!rename) return;
    event.preventDefault();
    event.stopPropagation();
    renamePlanSubject(rename.dataset.pcRename, rename.dataset.pcFrom, rename.dataset.pcTo);
  }, true);
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initPlanCompliance, { once: true });
  else initPlanCompliance();
}
