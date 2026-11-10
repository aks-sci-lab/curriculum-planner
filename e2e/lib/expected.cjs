"use strict";
// 하네스 자체 기대값 계산(앱 함수를 쓰지 않음): 합성 편제표 구조 + 2022 개정 기본 위계 중 이 편제표에 해당하는 규칙만.
// 판정: 뒤 과목을 고른 학생이 앞 과목을 ① 학교 지정(이전 학기) ② 같은 신청의 앞 학기 선택 ③ 이전 학년 이수 기록(나이스) 중 하나로
// 갖고 있으면 충족. 같은 학기 선택은 인정하지 않는다. 앞 과목이 이전 학년 선택 과목인데 이수 기록이 없으면 '확인 불가'.
const { SCHOOL, GROUPS } = require("./plan-fixture.cjs");

const RULES = [
  ["물리학", "역학과 에너지"], ["물리학", "전자기와 양자"], ["화학", "물질과 에너지"], ["화학", "화학 반응의 세계"],
  ["생명과학", "세포와 물질대사"], ["생명과학", "생물의 유전"], ["지구과학", "지구시스템과학"], ["지구과학", "행성우주과학"],
  ["대수", "미적분Ⅱ"], ["미적분Ⅰ", "미적분Ⅱ"], ["영어Ⅰ", "영어Ⅱ"],
  ["공통수학1", "미적분Ⅰ"], ["공통수학2", "미적분Ⅰ"], ["공통수학1", "확률과 통계"], ["공통수학2", "확률과 통계"], ["공통수학1", "기하"], ["공통수학2", "기하"],
  ["일본어", "일본어 회화"], ["중국어", "중국어 회화"],
];
const ORDER = ["sem11", "sem12", "sem21", "sem22", "sem31", "sem32"];
// 과목 → 편제표 학기 칸(학교 지정은 credits, 선택은 그룹 field)
const designated = new Map();
for (const [, , name, , credits] of SCHOOL) designated.set(name, Object.keys(credits));
const elective = new Map();
for (const group of GROUPS) for (const [, , name] of group.members) elective.set(name, group.field);

// selections: 학생이 고른 신청 학년 과목들, targetGrade: 2|3, prior: null(나이스 없음) 또는 Set(이전 학년 이수 과목명)
function prerequisiteStatus(selections, targetGrade, prior = null) {
  const picked = new Map(selections.map((name) => [name, elective.get(name)]));
  const violations = [];
  const unknowns = [];
  for (const [after, field] of picked) {
    for (const [before, rule] of RULES.filter(([, a]) => a === after).map((r) => [r[0], r])) {
      const at = ORDER.indexOf(field);
      const schoolFields = designated.get(before);
      if (schoolFields && schoolFields.some((f) => ORDER.indexOf(f) < at)) continue; // ① 학교 지정 이전 학기
      const beforeField = elective.get(before);
      if (beforeField && beforeField.startsWith(`sem${targetGrade}`)) { // ② 같은 신청 학년
        if (picked.has(before) && ORDER.indexOf(beforeField) < at) continue;
        violations.push(`${before}→${after}`);
        continue;
      }
      if (beforeField) { // ③ 이전 학년 선택 과목
        if (!prior) { unknowns.push(`${before}→${after}`); continue; }
        if (prior.has(before)) continue;
        violations.push(`${before}→${after}`);
        continue;
      }
      if (prior && prior.has(before)) continue;
      if (!schoolFields) unknowns.push(`${before}→${after}`);
    }
  }
  return { violations, unknowns };
}

// 국어·수학·영어 3년 누계(학교 지정 + 2학년 선택 수학 4 + 3학년 선택 중 국·수·영 과목 × 3). 현 2학년(3학년 신청)만.
const KEM_AREAS = new Set(["국어", "수학", "영어"]);
const areaOf = new Map([...SCHOOL.map((r) => [r[2], r[0]]), ...GROUPS.flatMap((g) => g.members.map((m) => [m[2], m[0]]))]);
const creditOf = new Map(GROUPS.flatMap((g) => g.members.map((m) => [m[2], g.credit])));
function kemCredits(selections3, priorElectives2 = ["미적분Ⅰ"]) {
  let total = 0;
  for (const [area, , , , credits] of SCHOOL) if (KEM_AREAS.has(area)) total += Object.values(credits).reduce((a, b) => a + b, 0);
  for (const name of priorElectives2) if (KEM_AREAS.has(areaOf.get(name))) total += creditOf.get(name);
  for (const name of selections3) if (KEM_AREAS.has(areaOf.get(name))) total += creditOf.get(name);
  return total;
}
function kemOver(selections3, priorElectives2, { limit = 81, totalCredits = 174, subjects = 174, ratio = 50 } = {}) {
  const allowed = limit + Math.max(0, totalCredits - subjects) * ratio / 100;
  return kemCredits(selections3, priorElectives2) > allowed;
}

module.exports = { RULES, prerequisiteStatus, kemCredits, kemOver, areaOf, creditOf };
