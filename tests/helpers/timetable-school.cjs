// 시간표 테스트용 가상 학교(실제 학교와 같은 크기, 합성 자료). tests/timetable-precheck.test.cjs의 school()과 같은 모양.
// 가상 학교: 1학년 10반(반 수업 30 + 창체 2), 2학년 11반(반 수업 19 + 택3 블록 12 + 창체 2), 3학년 11반(택5 블록 20 + 반 수업 6 + 창체 2), 주 35칸.
// 3학년 반 수업(스포츠 생활 2 + 인공지능 기초 4)을 맡는 교사 수 = options.pe3 + options.info3 (기본 6 + 6 = 12 ≥ 11반).
// options.blockTeachers = 블록 과목마다 교사 수(기본 2 — 1이면 어떤 두 블록도 같은 시간에 둘 수 없다), options.sharedPe = 아래 설명.
const BLOCK_DEPARTMENTS = ["지리", "역사", "윤리", "일반사회", "물리", "화학", "생명", "지구", "일본어", "중국어", "경제"];
function school(options = {}) {
  const teachers = [];
  const staff = (department, count, extra = {}) => {
    for (let n = 1; n <= count; n += 1) teachers.push({ id: `t-${department}-${n}`, name: `${department} ${n}`, departments: [department], ...extra });
  };
  for (const [department, count] of Object.entries({ 국어: 5, 수학: 5, 영어: 5, 한국사: 2, 통합사회: 2, 음악: 1, 미술: 3, 한문: 2, 체육1: 3, ...(options.staff || {}) })) staff(department, count);
  for (const department of BLOCK_DEPARTMENTS) staff(department, options.blockTeachers ?? 2);
  teachers.push({ id: "t-물리-과탐", name: "물리 과탐", departments: ["물리"] }); // 물리는 통합과학·과학탐구실험까지 맡는다
  staff("체육3", options.pe3 ?? 6);
  staff("정보3", options.info3 ?? 6);
  const sections = (prefix) => BLOCK_DEPARTMENTS.map((department, index) => ({ id: `${prefix}-${index + 1}`, subject: `${department} 선택`, department, credits: 4 }));
  const input = {
    semester: "1", days: "월,화,수,목,금", periods: 7, lunchAfter: { 3: 3 },
    grades: [{ grade: "1", classes: 10 }, { grade: "2", classes: 11 }, { grade: "3", classes: 11 }],
    creative: { school: 2, schoolTimes: ["금6", "금7"], expected: { 1: 2, 2: 2, 3: 2 } },
    teachers,
    lessons: [
      { id: "1국어", grade: "1", subject: "공통국어", department: "국어", hours: 4 },
      { id: "1수학", grade: "1", subject: "공통수학", department: "수학", hours: 4 },
      { id: "1영어", grade: "1", subject: "공통영어", department: "영어", hours: 4 },
      { id: "1한국사", grade: "1", subject: "한국사", department: "한국사", hours: 3 },
      { id: "1통사", grade: "1", subject: "통합사회", department: "통합사회", hours: 4 },
      { id: "1통과", grade: "1", subject: "통합과학", hours: 4, parts: ["물리", "화학", "생명", "지구"].map((department) => ({ department, hours: 1 })) },
      { id: "1과탐", grade: "1", subject: "과학탐구실험", department: "물리", hours: 1 },
      { id: "1체육", grade: "1", subject: "체육", department: "체육1", hours: 2 },
      { id: "1음악", grade: "1", subject: "음악", department: "음악", hours: 2 },
      { id: "1미술", grade: "1", subject: "미술", department: "미술", hours: 2 },
      { id: "2문학", grade: "2", subject: "문학", department: "국어", hours: 4 },
      { id: "2대수", grade: "2", subject: "대수", department: "수학", hours: 4 },
      { id: "2영어", grade: "2", subject: "영어Ⅰ", department: "영어", hours: 4 },
      { id: "2체육", grade: "2", subject: "체육", department: "체육1", hours: 2 },
      { id: "2한문", grade: "2", subject: "한문", department: "한문", hours: 3 },
      { id: "2미술", grade: "2", subject: "미술 창작", department: "미술", hours: 2 },
      { id: "3스포츠", grade: "3", subject: "스포츠 생활", department: "체육3", hours: 2 },
      { id: "3인공", grade: "3", subject: "인공지능 기초", department: "정보3", hours: 4 }
    ],
    blocks: [
      ...["a", "b", "c"].map((id) => ({ id: `2${id}`, grade: "2", label: `${id}블록`, sections: sections(`2${id}`) })),
      ...["a", "b", "c", "d", "e"].map((id) => ({ id: `3${id}`, grade: "3", label: `${id}블록`, sections: sections(`3${id}`) }))
    ],
    rules: options.rules || {}
  };
  // sharedPe: 3학년 스포츠 생활도 1·2학년 체육 교사(3명)가 맡는다 — 실제 학교 모양(3학년 반 수업 교사 = 체육 3 + 정보 options.info3명 < 11반, 체육 교사는 전 학년 수업으로 꽉 참)
  if (options.sharedPe) input.lessons.find((lesson) => lesson.id === "3스포츠").department = "체육1";
  return input;
}

module.exports = { school, BLOCK_DEPARTMENTS };
