"use strict";
// 합성 편제표(2022 개정, 실제 학교 규모): 학교 지정 + 학생 선택(2학년 학기별 택3·택1, 3학년 학기별 택5·택1) + 교차집중(2학년 미술↔연극).
// 열: A 구분 · B 교과(군) · C 과목 구분 · D 과목 · E 기준학점 · F 운영학점 · G~L 1-1…3-2 · M 이수학점 · N 필수이수학점
const { writeXlsx, col } = require("./xlsx-write.cjs");
const SEM = { sem11: 6, sem12: 7, sem21: 8, sem22: 9, sem31: 10, sem32: 11 };

const SCHOOL = [
  ["국어", "공통", "공통국어1", 4, { sem11: 4 }], ["국어", "공통", "공통국어2", 4, { sem12: 4 }],
  ["수학", "공통", "공통수학1", 4, { sem11: 4 }], ["수학", "공통", "공통수학2", 4, { sem12: 4 }],
  ["영어", "공통", "공통영어1", 4, { sem11: 4 }], ["영어", "공통", "공통영어2", 4, { sem12: 4 }],
  ["사회(역사/도덕 포함)", "공통", "한국사1", 3, { sem11: 3 }], ["사회(역사/도덕 포함)", "공통", "한국사2", 3, { sem12: 3 }],
  ["사회(역사/도덕 포함)", "공통", "통합사회1", 4, { sem11: 4 }], ["사회(역사/도덕 포함)", "공통", "통합사회2", 4, { sem12: 4 }],
  ["과학", "공통", "통합과학1", 4, { sem11: 4 }], ["과학", "공통", "통합과학2", 4, { sem12: 4 }],
  ["과학", "공통", "과학탐구실험1", 1, { sem11: 1 }], ["과학", "공통", "과학탐구실험2", 1, { sem12: 1 }],
  ["체육", "일반", "체육1", 4, { sem11: 2, sem12: 2 }], ["예술", "일반", "음악", 4, { sem11: 3, sem12: 3 }],
  ["기술·가정/정보", "일반", "정보", 4, { sem11: 1, sem12: 1 }],
  ["국어", "일반", "문학", 4, { sem21: 4 }], ["국어", "일반", "독서와 작문", 4, { sem22: 4 }],
  ["수학", "일반", "대수", 4, { sem21: 4 }], ["영어", "일반", "영어Ⅰ", 4, { sem21: 4 }], ["영어", "일반", "영어Ⅱ", 4, { sem22: 4 }],
  ["체육", "일반", "체육2", 4, { sem21: 2, sem22: 2 }], ["기술·가정/정보", "일반", "기술⋅가정", 4, { sem21: 2, sem22: 2 }],
  ["국어", "일반", "화법과 언어", 4, { sem31: 4 }], ["국어", "진로", "주제 탐구 독서", 4, { sem31: 4 }],
  ["국어", "융합", "독서 토론과 글쓰기", 4, { sem32: 4 }], ["영어", "진로", "영어 독해와 작문", 4, { sem32: 4 }],
  ["교양", "일반", "생태와 환경", 4, { sem31: 3 }], ["교양", "일반", "진로와 직업", 4, { sem32: 3 }], ["체육", "진로", "운동과 건강", 4, { sem31: 2, sem32: 2 }],
];
// 교차집중(학교 지정 1·2학기 택1): 미술↔연극, 학기당 2학점
const CROSS = { fields: ["sem21", "sem22"], pick: 1, credit: 2, members: [["예술", "일반", "미술", 4], ["예술", "일반", "연극", 4]] };
const GROUPS = [
  { field: "sem21", pick: 3, credit: 3, members: [["과학", "일반", "물리학"], ["과학", "일반", "화학"], ["과학", "일반", "생명과학"], ["과학", "일반", "지구과학"],
    ["사회(역사/도덕 포함)", "일반", "세계시민과 지리"], ["사회(역사/도덕 포함)", "일반", "세계사"], ["사회(역사/도덕 포함)", "일반", "사회와 문화"], ["사회(역사/도덕 포함)", "일반", "현대사회와 윤리"]] },
  { field: "sem22", pick: 1, credit: 4, members: [["수학", "일반", "미적분Ⅰ"], ["수학", "일반", "확률과 통계"]] },
  { field: "sem22", pick: 3, credit: 3, members: [["과학", "진로", "역학과 에너지"], ["과학", "진로", "물질과 에너지"], ["과학", "진로", "생물의 유전"], ["과학", "진로", "지구시스템과학"],
    ["사회(역사/도덕 포함)", "진로", "한국지리 탐구"], ["사회(역사/도덕 포함)", "진로", "정치"], ["사회(역사/도덕 포함)", "진로", "윤리와 사상"], ["사회(역사/도덕 포함)", "융합", "동아시아 역사 기행"]] },
  { field: "sem31", pick: 5, credit: 3, members: [["수학", "진로", "미적분Ⅱ"], ["수학", "진로", "기하"], ["수학", "융합", "실용 통계"], ["과학", "진로", "화학 반응의 세계"],
    ["과학", "진로", "세포와 물질대사"], ["과학", "진로", "전자기와 양자"], ["사회(역사/도덕 포함)", "진로", "법과 사회"], ["사회(역사/도덕 포함)", "진로", "경제"],
    ["사회(역사/도덕 포함)", "융합", "사회문제 탐구"], ["영어", "진로", "심화 영어"]] },
  { field: "sem31", pick: 1, credit: 2, members: [["제2외국어/한문", "일반", "일본어"], ["제2외국어/한문", "일반", "중국어"]] },
  { field: "sem32", pick: 5, credit: 3, members: [["수학", "융합", "수학과제 탐구"], ["수학", "진로", "인공지능 수학"], ["과학", "진로", "행성우주과학"], ["과학", "융합", "기후변화와 환경생태"],
    ["사회(역사/도덕 포함)", "융합", "인문학과 윤리"], ["사회(역사/도덕 포함)", "진로", "국제 관계의 이해"], ["사회(역사/도덕 포함)", "융합", "여행지리"],
    ["영어", "진로", "영미 문학 읽기"], ["영어", "융합", "영어 발표와 토론"], ["국어", "융합", "언어생활 탐구"],
    // 두 학기 개설 과목(3-1·3-2 택5에 모두): 학생은 한 학기만 고른다 → '(1학기)/(2학기)' 꼬리표 검사용
    ["영어", "진로", "심화 영어"]] },
  { field: "sem32", pick: 1, credit: 2, members: [["제2외국어/한문", "진로", "일본어 회화"], ["제2외국어/한문", "진로", "중국어 회화"]] },
];

// options.smallClass: 학기 칸 메모(소인수) 과목 한 줄 — 따로 신청(2·4·5·6단계 모두에서 빠짐, 5단계 시수·확인 필요에도 없음)
const SMALL_CLASS = { area: "사회(역사/도덕 포함)", kind: "융합", name: "금융과 경제생활", base: 4, op: 3, note: "소인수/2학년/2학기/3학점(순증)" };
function planSheet(year, school = "가상고등학교", options = {}) {
  const W = 14;
  const blank = () => Array(W).fill("");
  const rows = []; const merges = [];
  const push = (values) => { const row = blank(); for (const [k, v] of Object.entries(values)) row[k] = v; rows.push(row); return rows.length - 1; };
  push({ 0: `${year}학년도 신입생 3개년 교육과정 편제표` }); merges.push("A1:N1");
  push({ 6: `[테스트] ${school}` }); merges.push("G2:N2");
  push({ 0: "구분", 1: "교과(군)", 2: "세부과목", 4: "기준학점", 5: "운영학점", 6: "1학년", 8: "2학년", 10: "3학년", 12: "이수학점", 13: "필수이수학점" });
  push({ 6: "1학기", 7: "2학기", 8: "1학기", 9: "2학기", 10: "1학기", 11: "2학기" });
  merges.push("A3:A4", "B3:B4", "C3:D4", "E3:E4", "F3:F4", "G3:H3", "I3:J3", "K3:L3", "M3:M4", "N3:N4");
  const totals = { sem11: 0, sem12: 0, sem21: 0, sem22: 0, sem31: 0, sem32: 0 };
  const schoolStart = rows.length;
  SCHOOL.forEach(([area, kind, name, base, credits], index) => {
    const values = { 1: area, 2: kind, 3: name, 4: base, 5: Object.values(credits).reduce((a, b) => a + b, 0) };
    if (index === 0) values[0] = "학교 지정 교육과정";
    for (const [field, value] of Object.entries(credits)) { values[SEM[field]] = value; totals[field] += value; }
    values[12] = values[5];
    push(values);
  });
  const crossStart = rows.length;
  CROSS.members.forEach(([area, kind, name, base], index) => {
    const values = { 1: area, 2: kind, 3: name, 4: base, 5: CROSS.credit * 2 };
    if (index === 0) { values[SEM[CROSS.fields[0]]] = `택${CROSS.pick}\n${CROSS.credit}학점`; values[12] = CROSS.credit * 2; }
    push(values);
  });
  merges.push(`${col(SEM.sem21)}${crossStart + 1}:${col(SEM.sem22)}${crossStart + CROSS.members.length}`, `M${crossStart + 1}:M${crossStart + CROSS.members.length}`);
  totals.sem21 += CROSS.credit; totals.sem22 += CROSS.credit;
  merges.push(`A${schoolStart + 1}:A${rows.length}`);
  const choiceStart = rows.length;
  for (const group of GROUPS) {
    const start = rows.length;
    group.members.forEach(([area, kind, name], index) => {
      const values = { 1: area, 2: kind, 3: name, 4: group.credit === 2 ? 2 : 4, 5: group.credit };
      if (index === 0) { values[SEM[group.field]] = `택${group.pick}\n${group.credit}학점`; values[12] = group.pick * group.credit; }
      if (index === 0 && start === choiceStart) values[0] = "학생 선택 교육과정";
      push(values);
    });
    merges.push(`${col(SEM[group.field])}${start + 1}:${col(SEM[group.field])}${rows.length}`, `M${start + 1}:M${rows.length}`);
    totals[group.field] += group.pick * group.credit;
  }
  if (options.smallClass) {
    const r = push({ 1: SMALL_CLASS.area, 2: SMALL_CLASS.kind, 3: SMALL_CLASS.name, 4: SMALL_CLASS.base, 5: SMALL_CLASS.op, 6: SMALL_CLASS.note, 12: SMALL_CLASS.op });
    merges.push(`G${r + 1}:L${r + 1}`);
  }
  merges.push(`A${choiceStart + 1}:A${rows.length}`);
  const sum = Object.values(totals).reduce((a, b) => a + b, 0);
  const footer = push({ 0: "이수학점 소계", 6: totals.sem11, 7: totals.sem12, 8: totals.sem21, 9: totals.sem22, 10: totals.sem31, 11: totals.sem32, 12: sum });
  merges.push(`A${footer + 1}:F${footer + 1}`);
  const creative = push({ 0: "창의적 체험활동", 6: 3, 7: 3, 8: 3, 9: 3, 10: 3, 11: 3, 12: 18 });
  merges.push(`A${creative + 1}:F${creative + 1}`);
  return { name: "편제표", rows, merges, widths: [10, 12, 6, 22, 6, 6, 6, 6, 6, 6, 6, 6, 8, 8], totals };
}

function planWorkbook(year, school, options = {}) { const sheet = planSheet(year, school, options); return { bytes: writeXlsx([sheet]), totals: sheet.totals }; }
// 학년별 학생 선택 묶음(검증 기준값): 학년 2 = Y 입학생의 2학년 열, 학년 3 = Y-1 입학생의 3학년 열.
function choiceGroups(targetGrade) {
  return GROUPS.filter((group) => group.field.startsWith(`sem${targetGrade}`))
    .map((group) => ({ field: group.field, semester: group.field.slice(-1), pick: group.pick, credit: group.credit, courses: group.members.map((m) => m[2]) }));
}
module.exports = { SMALL_CLASS, planWorkbook, planSheet, choiceGroups, GROUPS, SCHOOL, CROSS };
