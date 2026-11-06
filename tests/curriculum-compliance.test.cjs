const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// 1단계 편제 점검표(울산 편제 점검 프로그램 점검표 20+4개)·편성 영역·교과(군) 통계의 순수 계산.
// 실제 학교 파일 대신 같은 모양(planData: 과목·학기 학점·선택과목군·학기 칸 메모)의 합성 편제표를 쓴다.
const root = path.join(__dirname, "..");
const plain = (value) => JSON.parse(JSON.stringify(value));
const pure = (file) => {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const marker = source.indexOf("\n// ---- 앱 연결");
  return marker >= 0 ? source.slice(0, marker) : source;
};

function context() {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, "curriculum-subject-list.js"), "utf8"), ctx);
  vm.runInContext(pure("course-checks.js"), ctx);
  vm.runInContext(pure("curriculum-compliance.js"), ctx);
  return ctx;
}

let nextId = 1;
const subject = (name, area, kind, credits = {}, extra = {}) => ({ id: `s${nextId++}`, category: extra.category || "학교 지정 교육과정", area, kind,
  name, base: extra.base ?? "4", op: extra.op ?? "4", credits, texts: {}, cross: extra.cross || null, note: extra.note || "", ...extra.fields });

// 2022 개정 3개년 편제표(교과 174 = 30·30·31·31·26·26, 창체 3×6). 선택: 2-1 택3(사회·과학), 3-1·3-2 택4.
function compliantPlan() {
  nextId = 1;
  const S = (...args) => subject(...args);
  const designated = [
    S("공통국어1", "국어", "공통", { sem11: 4 }), S("공통국어2", "국어", "공통", { sem12: 4 }),
    S("문학", "국어", "일반선택", { sem21: 4 }), S("화법과 언어", "국어", "일반선택", { sem22: 4 }),
    S("공통수학1", "수학", "공통", { sem11: 4 }), S("공통수학2", "수학", "공통", { sem12: 4 }),
    S("대수", "수학", "일반선택", { sem21: 4 }), S("미적분Ⅰ", "수학", "일반선택", { sem22: 4 }),
    S("공통영어1", "영어", "공통", { sem11: 4 }), S("공통영어2", "영어", "공통", { sem12: 4 }),
    S("영어Ⅰ", "영어", "일반선택", { sem21: 4 }), S("영어Ⅱ", "영어", "일반선택", { sem22: 4 }),
    S("한국사1", "한국사", "공통", { sem11: 3 }, { base: "3", op: "3" }), S("한국사2", "한국사", "공통", { sem12: 3 }, { base: "3", op: "3" }),
    S("통합사회1", "사회", "공통", { sem11: 4 }), S("통합사회2", "사회", "공통", { sem12: 4 }),
    S("통합과학1", "과학", "공통", { sem11: 4 }), S("통합과학2", "과학", "공통", { sem12: 4 }),
    S("과학탐구실험1", "과학", "공통", { sem11: 1 }, { base: "1", op: "1" }), S("과학탐구실험2", "과학", "공통", { sem12: 1 }, { base: "1", op: "1" }),
    S("체육1", "체육", "일반선택", { sem11: 2 }, { base: "3", op: "2" }), S("체육2", "체육", "일반선택", { sem12: 2 }, { base: "3", op: "2" }),
    S("스포츠 문화", "체육", "진로선택", { sem21: 1 }, { base: "2", op: "1" }), S("스포츠 과학", "체육", "진로선택", { sem22: 1 }, { base: "2", op: "1" }),
    S("스포츠 생활1", "체육", "융합선택", { sem31: 2 }, { base: "3", op: "2" }), S("스포츠 생활2", "체육", "융합선택", { sem32: 2 }, { base: "3", op: "2" }),
    S("음악, 미술", "예술", "일반선택", { sem11: 2, sem12: 2 }, { base: "3", op: "2", cross: ["sem11", "sem12"] }),
    S("음악 감상과 비평, 미술 감상과 비평", "예술", "진로선택", { sem21: 3, sem22: 3 }, { base: "3", op: "3", cross: ["sem21", "sem22"] }),
    S("진로와 직업, 생태와 환경", "교양", "일반선택", { sem11: 2, sem12: 2 }, { base: "3", op: "2", cross: ["sem11", "sem12"] }),
    S("기술·가정", "기술·가정", "일반선택", { sem31: 4 }), S("한문", "한문", "일반선택", { sem32: 4 })
  ];
  const choice = (name, area, kind, op = "4") => S(name, area, kind, {}, { category: "학생 선택 교육과정", op });
  const g5 = [choice("일본어, 중국어", "제2외국어", "일반선택", "3")];
  const g6 = [choice("일본어 회화, 중국어 회화", "제2외국어", "진로선택", "3")];
  const g21 = [choice("세계시민과 지리, 세계사, 사회와 문화", "사회", "일반선택"), choice("물리학, 화학, 생명과학", "과학", "일반선택")];
  const g22 = [choice("언어생활 탐구", "국어", "융합선택"), choice("확률과 통계", "수학", "일반선택"), choice("현대사회와 윤리", "사회", "일반선택"), choice("지구과학", "과학", "일반선택")];
  const g31 = [choice("독서와 작문", "국어", "일반선택"), choice("미적분Ⅱ, 기하", "수학", "진로선택"), choice("영미 문학 읽기", "영어", "진로선택"),
    choice("정치, 법과 사회", "사회", "진로선택"), choice("역학과 에너지, 세포와 물질대사", "과학", "진로선택"), choice("정보 처리와 관리", "정보", "진로선택")];
  const g32 = [choice("주제 탐구 독서", "국어", "진로선택"), choice("수학과제 탐구", "수학", "융합선택"),
    choice("여행지리, 사회문제 탐구", "사회", "융합선택"), choice("기후변화와 환경생태", "과학", "융합선택"), choice("인공지능 기초", "정보", "진로선택")];
  const extra = S("경제", "사회", "진로선택", {}, { category: "학생 선택 교육과정", op: "3", note: "소인수/2학년/1학기/3학점(순증)" });
  const subjects = [...designated, ...g21, ...g5, ...g22, ...g6, ...g31, ...g32, extra];
  const ids = (list) => list.map((item) => item.id);
  const groups = [
    { id: "g1", fields: ["sem21"], pick: 3, credit: 4, members: ids(g21) },
    { id: "g2", fields: ["sem22"], pick: 3, credit: 4, members: ids(g22) },
    { id: "g3", fields: ["sem31"], pick: 5, credit: 4, members: ids(g31) },
    { id: "g4", fields: ["sem32"], pick: 5, credit: 4, members: ids(g32) },
    { id: "g5", fields: ["sem21"], pick: 1, credit: 3, members: ids(g5) },
    { id: "g6", fields: ["sem22"], pick: 1, credit: 3, members: ids(g6) }
  ];
  const footer = { rows: [Array(14).fill(""), ["창의적 체험활동", "", "", "", "", "", "3", "3", "3", "3", "3", "3", "18", ""]] };
  return {
    planData: { version: 1, nextId, subjects, groups },
    planTemplate: { columns: { category: 0, area: 1, kind: 2, name: 3, base: 4, op: 5, semesters: [6, 7, 8, 9, 10, 11], completion: 12, required: 13 },
      header: { rows: [["2026학년도 신입생 3개년 교육과정 편제표"]] }, footer }
  };
}

const byName = (layout, name) => layout.planData.subjects.find((item) => item.name === name);
const item = (report, no) => report.items.find((entry) => entry.no === no);

test("과목 목록에 울산 과목목록의 기준 학점·증감 범위·성취도·석차등급이 붙고, 로마숫자·띄어쓰기를 맞춰 찾는다", () => {
  const ctx = context();
  assert.equal(ctx.CURRICULUM_OFFICIAL_CREDIT_ROWS.length, 154);
  assert.deepEqual(plain(ctx.findCurriculumOfficialSubject("미적분2").credit), { base: 4, min: 3, max: 5, achievement: "5단계", rank: true });
  assert.equal(ctx.findCurriculumOfficialSubject("미적분2").name, "미적분Ⅱ");
  assert.deepEqual(plain(ctx.findCurriculumOfficialSubject("과학탐구실험1").credit), { base: 1, min: 1, max: 1, achievement: "3단계", rank: false });
  assert.equal(ctx.findCurriculumOfficialSubject("삶과종교").credit.achievement, "P");
  assert.equal(ctx.findCurriculumOfficialSubject("사회문제 탐구").credit.rank, false, "융합선택 사회는 석차등급 없음");
  // 울산 목록에 없는 과목(전문교과 등)은 범위 정보 없음
  assert.equal(ctx.findCurriculumOfficialSubject("프로그래밍").credit, null);
});

test("기준을 지킨 2022 개정 편제표는 자동 점검 20개가 O·자체 확인이고, 소인수 순증·창체·교차집중을 계산에 맞게 넣는다", () => {
  const ctx = context();
  const report = ctx.planComplianceReport(compliantPlan(), { cohortYear: "2026" });
  assert.equal(report.revision.revision, "2022");
  assert.equal(report.items.length, 20);
  assert.equal(report.self.length, 4);
  const bad = report.items.filter((entry) => entry.status !== "O").map((entry) => `${entry.no}:${entry.status}:${entry.note}`);
  assert.deepEqual(plain(bad), []);
  assert.equal(report.stats.totalMin, 174);
  assert.deepEqual(plain(ctx.PLAN_COMPLIANCE_FIELDS.map((field) => report.stats.semester[field].total)), [30, 30, 31, 31, 26, 26]);
  assert.match(item(report, 1).note, /창체 18학점\(3·3·3·3·3·3\)/);
  assert.match(item(report, 1).note, /순증 3학점 제외/);
  // 교차집중(음악↔미술)은 학기 학점을 한 번만 세고, 과목 하나의 학점은 합 ÷ 과목 수(2학점)
  const art = report.stats.families.find((row) => row.family === "예술");
  assert.equal(art.min, 10);
  assert.equal(report.subjectIssues.size, 0);
  // 창체 행이 비어 있으면(울산 프로그램에서 불러온 편제표 등) 부족으로 보지 않고 별도 확인을 안내한다
  const empty = compliantPlan();
  empty.planTemplate.footer.rows[1] = ["창의적 체험활동", "", "", "", "", "", "", "", "", "", "", "", "", ""];
  const emptyReport = ctx.planComplianceReport(empty, {});
  assert.equal(item(emptyReport, 1).status, "O");
  assert.match(item(emptyReport, 1).note, /창체 학점이 비어 있어 별도 확인필요/);
});

test("교과(군)별 학생 최소~최대: 택n 묶음의 선택지 수로 계산하고, 국수영 합은 한 묶음에서 함께 고르는 경우를 합친다", () => {
  const ctx = context();
  const report = ctx.planComplianceReport(compliantPlan(), {});
  const family = (name) => report.stats.families.find((row) => row.family === name);
  // 3-1 택5: 국어 1·수학 2·영어 1·사회 2·과학 2·정보 1 → 국어 최소 0(다른 선택지 8개 ≥ 5), 최대 4
  assert.equal(family("국어").min, 16);
  assert.equal(family("국어").max, 16 + 4 + 4 + 4);
  assert.equal(family("수학").max, 16 + 4 + 8 + 4);
  assert.equal(family("사회").min, 12, "2-1 택3(사회 3·과학 3)은 최소 0, 3-2 택5(선택지 6개 중 사회 2개)는 최소 1과목");
  assert.equal(family("사회").max, 8 + 12 + 4 + 8 + 8);
  assert.equal(family("기술·가정/정보/제2외국어/한문/교양").min, 4 + 3 + 3 + 4 + 4, "제2외국어 택1 묶음은 선택지가 모두 같은 교과(군)이라 최소에 든다");
  // 국수영: 지정 48 + 2-2(언어생활·확통 2개) 8 + 3-1(4개) 16 + 3-2(2개) 8 = 80
  assert.equal(report.stats.kem.designated, 48);
  assert.equal(report.stats.kem.max, 80);
  assert.equal(item(report, 7).status, "O");
  assert.match(item(report, 7).note, /총 80학점 이수가 가능하므로 기준 81학점보다 1학점 만큼 여유/);
  // 교과(군) 통계 엑셀 행에 국수영 합과 학기 합계가 들어간다
  const rows = ctx.planComplianceStatsRows(report, "통계").rows.map((row) => row.map((cell) => cell?.v ?? cell ?? ""));
  assert.ok(rows.some((row) => row[0] === "국어·수학·영어 합" && row[12] === 80));
  assert.ok(rows.some((row) => row[0] === "학기 합계" && row.slice(2, 8).join(",") === "30,30,31,31,26,26"));
});

test("국수영 81학점: 174를 넘으면 초과 학점의 50%까지 늘리고, 그래도 넘으면 확인필요", () => {
  const ctx = context();
  const layout = compliantPlan();
  // 3-2 택5 → 국수영 선택지 하나 더(실용 통계): 최대 84. 총 이수 학점은 그대로 174 → 확인필요
  const added = subject("실용 통계", "수학", "융합선택", {}, { category: "학생 선택 교육과정" });
  layout.planData.subjects.push(added);
  layout.planData.groups[3].members.push(added.id);
  let report = ctx.planComplianceReport(layout, {});
  assert.equal(report.stats.kem.max, 84);
  assert.equal(item(report, 7).status, "확인필요");
  assert.match(item(report, 7).note, /3학점 만큼 초과할 수 있습니다/);
  // 지정 과목 6학점 추가(총 180): 상한 81 + 6×50% = 84 → O
  layout.planData.subjects.push(subject("기하", "수학", "진로선택", { sem31: 3, sem32: 3 }));
  report = ctx.planComplianceReport(layout, {});
  assert.equal(report.stats.totalMin, 180);
  assert.equal(report.stats.kem.max, 90);
  assert.match(item(report, 7).note, /기준 84학점/);
  // 기준값(설정 팝업)으로 상한을 바꿀 수 있다
  report = ctx.planComplianceReport(layout, { settings: { kemLimit: 90, kemExtraRatio: 0 } });
  assert.equal(item(report, 7).status, "O");
});

test("필수 이수·학점 범위·공통 감·과학탐구실험·학기 격차·체육 매 학기를 사유와 함께 확인필요로 보여 준다", () => {
  const ctx = context();
  const layout = compliantPlan();
  byName(layout, "공통국어1").credits.sem11 = 2;              // 공통 4학점 → 2학점(감 2)
  byName(layout, "문학").credits.sem21 = 6;                    // 범위 3~5 밖, 2-1 33학점
  byName(layout, "과학탐구실험2").credits.sem12 = 2;          // 1학점 고정
  byName(layout, "스포츠 과학").credits = {};                  // 2-2 체육 없음
  byName(layout, "한국사2").credits = {};                      // 한국사 3학점
  const report = ctx.planComplianceReport(layout, {});
  assert.equal(item(report, 2).status, "확인필요");
  assert.match(item(report, 2).note, /한국사 3학점부족/);
  assert.equal(item(report, 3).status, "확인필요");
  assert.match(item(report, 3).note, /공통국어1 2학점\(기준 4, 3~4\)/);
  assert.match(item(report, 3).note, /과학탐구실험2 2학점\(기준 1, 1~1\)/);
  assert.equal(item(report, 4).status, "확인필요");
  assert.match(item(report, 4).note, /공통국어1 2학점/);
  assert.equal(item(report, 5).status, "확인필요");
  assert.equal(item(report, 5).note, "과학탐구실험2 시수조정필요(1학점)");
  assert.match(item(report, 3).note, /문학 6학점\(기준 4, 3~5\)/);
  assert.equal(item(report, 6).status, "확인필요");
  assert.match(item(report, 6).note, /^2학년 1학기\(33학점\), 3학년 1학기\(26학점\) 확인필요 · 격차 7학점\(기준 5\)$/);
  assert.equal(item(report, 12).status, "확인필요");
  assert.match(item(report, 12).note, /총 1학점 부족, 2학년 2학기 확인필요/);
  assert.equal(item(report, 11).status, "O");
  // 학점 칸 경고용: 행마다 범위 밖 정보
  const rangeIssue = report.subjectIssues.get(byName(layout, "공통국어1").id).find((issue) => issue.kind === "range");
  assert.equal(rangeIssue.min, 3);
});

test("과목명: 2022 목록에 없는 과목, 띄어쓰기·로마숫자 차이·오탈자는 공식 이름을 제안한다(바꾸기 단추 자료)", () => {
  const ctx = context();
  const layout = compliantPlan();
  byName(layout, "역학과 에너지, 세포와 물질대사").name = "역학과에너지, 세포와 물질대사";
  byName(layout, "미적분Ⅱ, 기하").name = "미적분2, 기하";
  byName(layout, "영미 문학 읽기").name = "영미 문학 읽기*";     // 표기 기호는 그대로 인정
  byName(layout, "주제 탐구 독서").name = "주제 탐구 독사";    // 오탈자
  byName(layout, "수학과제 탐구").name = "수학Ⅰ";              // 2015 개정 과목
  byName(layout, "인공지능 기초").name = "학교 자율 과목☆";    // 고시 외 표기는 제외
  const report = ctx.planComplianceReport(layout, {});
  assert.equal(item(report, 8).status, "확인필요");
  assert.match(item(report, 8).note, /^1개 확인필요: 수학Ⅰ$/);
  assert.equal(item(report, 9).status, "확인필요");
  assert.match(item(report, 9).note, /역학과에너지 → 역학과 에너지/);
  assert.match(item(report, 9).note, /미적분2 → 미적분Ⅱ/);
  assert.match(item(report, 9).note, /주제 탐구 독사 → 주제 탐구 독서/);
  assert.doesNotMatch(item(report, 9).note, /영미 문학/);
  const spelling = report.subjectIssues.get(byName(layout, "미적분2, 기하").id).find((issue) => issue.kind === "spelling");
  assert.equal(spelling.suggestion, "미적분Ⅱ");
  // 바꾸기: 한 과목 이름만, 표기 기호는 남긴다
  assert.equal(ctx.planComplianceReplaceName("미적분2, 기하", "미적분2", "미적분Ⅱ"), "미적분Ⅱ, 기하");
  assert.equal(ctx.planComplianceReplaceName("고급물리학*", "고급물리학", "고급 물리학"), "고급 물리학*");
  assert.equal(ctx.planComplianceReplaceName("물리학", "화학", "생명과학"), null);
});

test("이수 시기·위계: 공통→선택 순서, 한국사→역사 선택, 3-2 수능 과목(자체 확인), 같은 학년 같은 과목 학점, 미적분Ⅰ→Ⅱ", () => {
  const ctx = context();
  const layout = compliantPlan();
  byName(layout, "통합사회2").credits = { sem21: 4 };           // 공통이 선택(2-1 세계사 등)과 같은 학기
  byName(layout, "한국사2").credits = { sem21: 3 };             // 세계사(2-1 선택)와 같은 학기
  byName(layout, "독서와 작문").name = "독서와 작문, 미적분Ⅰ"; // 3-1에도 미적분Ⅰ(2-2 지정과 같은 이름)
  layout.planData.groups[3].credit = 4;
  const sociology = byName(layout, "현대사회와 윤리");
  sociology.name = "현대사회와 윤리, 문학";                     // 2-2 선택에 문학(2-1 지정) → 17번 중복
  layout.planData.subjects.push(subject("화법과 언어", "국어", "일반선택", { sem32: 2 }, { op: "2" })); // 2학년 4학점·3학년 2학점, 3-2 수능 과목
  const rules = [{ before: "미적분Ⅰ", after: "미적분Ⅱ" }, { before: "영어Ⅱ", after: "영어Ⅰ" }];
  const report = ctx.planComplianceReport(layout, { rules });
  assert.equal(item(report, 10).status, "확인필요");
  assert.match(item(report, 10).note, /사회교과 공통 과목: 2학년 1학기, 선택 과목: 2학년 1학기에 편성함/);
  assert.equal(item(report, 11).status, "확인필요");
  assert.match(item(report, 11).note, /공통 과목: 2학년 1학기, 선택 과목: 2학년 1학기/);
  assert.equal(item(report, 13).status, "자체 확인");
  assert.match(item(report, 13).note, /화법과 언어 3학년 2학기에 편성됨/);
  assert.equal(item(report, 14).status, "O", "학년이 다르면 학점이 달라도 된다");
  assert.equal(item(report, 15).status, "확인필요");
  assert.match(item(report, 15).note, /영어Ⅱ\(2학년 2학기\) → 영어Ⅰ\(2학년 1학기\)/);
  assert.doesNotMatch(item(report, 15).note, /미적분Ⅰ\(/);
  assert.equal(item(report, 17).status, "확인필요");
  assert.match(item(report, 17).note, /문학/);
  assert.match(item(report, 17).note, /미적분Ⅰ/);
  // 같은 학년에 학점이 다르게 편성되면 14번
  layout.planData.subjects.push(subject("주제 탐구 독서", "국어", "진로선택", { sem31: 2 }, { op: "2" }));
  assert.equal(item(ctx.planComplianceReport(layout, { rules }), 14).status, "확인필요");
  assert.match(item(ctx.planComplianceReport(layout, { rules }), 14).note, /주제 탐구 독서\(3학년 2·4학점\)/);
});

test("과목 선택: 제2외국어 지정·1과목 묶음, 종교 과목 단독, 학생 선택 없음, 수능 과목 미편성", () => {
  const ctx = context();
  const layout = compliantPlan();
  // 일본어·중국어는 '학생 선택' 구분이지만 묶음이 없어 고를 수 있는 과목(최소 0)으로 본다 → 지정 편성 아님
  assert.equal(item(ctx.planComplianceReport(layout, {}), 16).status, "O");
  layout.planData.subjects.push(subject("독일어", "제2외국어", "일반선택", { sem31: 4 }));
  const religion = subject("삶과 종교", "교양", "진로선택", { sem31: 2 }, { base: "3", op: "2" });
  layout.planData.subjects.push(religion);
  let report = ctx.planComplianceReport(layout, {});
  assert.equal(item(report, 16).status, "확인필요");
  assert.match(item(report, 16).note, /지정 편성: 독일어/);
  assert.equal(item(report, 18).status, "확인필요");
  assert.match(item(report, 18).note, /삶과 종교: 지정 편성/);
  // 삶과 종교를 다른 교양 과목과 같은 묶음에 넣으면 O
  religion.credits = {};
  const other = subject("논술", "교양", "융합선택", {}, { category: "학생 선택 교육과정" });
  layout.planData.subjects.push(other);
  layout.planData.groups.push({ id: "g9", fields: ["sem31"], pick: 1, credit: 2, members: [religion.id, other.id] });
  report = ctx.planComplianceReport(layout, {});
  assert.equal(item(report, 18).status, "O");
  // 제2외국어가 하나뿐인 묶음
  const spanish = subject("스페인어", "제2외국어", "일반선택", {}, { category: "학생 선택 교육과정" });
  const psychology = subject("심리학", "교양", "진로선택", {}, { category: "학생 선택 교육과정" });
  layout.planData.subjects.push(spanish, psychology);
  layout.planData.groups.push({ id: "g10", fields: ["sem32"], pick: 1, credit: 2, members: [spanish.id, psychology.id] });
  report = ctx.planComplianceReport(layout, {});
  assert.match(item(report, 16).note, /3-2 택1 그룹에 제2외국어 1과목\(스페인어\)/);
  // 학생 선택이 없고 수능 과목이 빠진 편제표
  const bare = compliantPlan();
  bare.planData.groups = [];
  bare.planData.subjects = bare.planData.subjects.filter((entry) => entry.credits && Object.keys(entry.credits).length);
  report = ctx.planComplianceReport(bare, {});
  assert.equal(item(report, 19).status, "확인필요");
  assert.equal(item(report, 19).note, "학생선택교육과정 없음");
  assert.equal(item(report, 20).status, "확인필요");
  assert.match(item(report, 20).note, /독서와 작문, 확률과 통계 미편성/);
});

test("편성 영역: curriculumPlanSection은 교사 지정값(planSectionManual)을 먼저, 없으면 택n·메모·교차·구분 칸으로 추정한다", () => {
  const ctx = context();
  const layout = compliantPlan();
  const data = layout.planData;
  const section = (name) => ctx.curriculumPlanSection(byName(layout, name), data);
  assert.equal(section("공통국어1"), "school");
  assert.equal(section("확률과 통계"), "choice");
  assert.equal(section("음악, 미술"), "cross");
  assert.equal(section("경제"), "extra");
  assert.equal(section("일본어, 중국어"), "choice");
  assert.equal(ctx.curriculumPlanSection({ id: "x", name: "공동 과목", category: "공동 교육과정" }, data), "extra");
  // 교사가 정한 값(저장값이 코드가 아니면 무시)
  Object.assign(byName(layout, "경제"), { planSection: "choice", planSectionManual: true });
  Object.assign(byName(layout, "공통국어1"), { planSection: "아무값", planSectionManual: true });
  assert.equal(section("경제"), "choice");
  assert.equal(section("공통국어1"), "school");
  // 학생선택(묶음 없음)으로 바꾼 지정 과목은 학생별 최소 이수에서 빠진다 → 필수 이수 학점 부족
  Object.assign(byName(layout, "한국사2"), { planSection: "choice", planSectionManual: true });
  const report = ctx.planComplianceReport(layout, {});
  const row = report.model.rows.find((entry) => entry.names[0].name === "한국사2");
  assert.equal(row.domain, "학생선택");
  assert.equal(row.overridden, true);
  assert.equal(row.role, "optional");
  assert.match(item(report, 2).note, /한국사 3학점부족/);
  assert.equal(report.stats.domains["학생선택"].credits.sem12, 3);
  // 경제(메모 과목)를 학생선택으로 정해도 학기 칸 메모 학점은 순증으로 둔다
  assert.equal(report.model.rows.find((entry) => entry.names[0].name === "경제").role, "extra");
});

test("개정 판별: 2025학년도 입학생부터 2022 개정, 제목 학년도와 카드 학년도가 다르면 알린다", () => {
  const ctx = context();
  const layout = compliantPlan();
  assert.deepEqual(plain(ctx.planComplianceRevision(layout, "2026")), { revision: "2022", titleYear: "2026", cohortYear: "2026", mismatch: false });
  assert.equal(ctx.planComplianceRevision(layout, "2027").mismatch, true);
  layout.planTemplate.header.rows = [["2024학년도 신입생 3개년 교육과정 편제표"]];
  assert.equal(ctx.planComplianceRevision(layout, "2024").revision, "2015");
  layout.planTemplate.header.rows = [["교육과정 편제표"]];
  assert.equal(ctx.planComplianceRevision(layout, "2024").revision, "2015");
  assert.equal(ctx.planComplianceRevision(layout, "2025").revision, "2022");
});

test("전학년 편제표: 2022 개정 학년만, 학년별 학점으로 범위·과목명·체육·3-2 수능 과목만 보고 나머지는 해당 없음", () => {
  const ctx = context();
  nextId = 100;
  const annualLayout = { derived: true, planData: { subjects: [
    subject("공통국어1", "국어", "공통", { sem11: 4 }), subject("공통수학1", "수학", "공통", { sem11: 6 }), subject("체육1", "체육", "일반선택", { sem11: 2, sem12: 2 }, { op: "2" }),
    subject("기후변화와 환경생태", "과학", "융합선택", { sem21: 4, sem22: 4 }), // 2학년 두 학기 따로 개설 → 학기마다 범위 안이면 O
    subject("물리학Ⅱ", "과학", "진로선택", { sem31: 4 }),                 // 3학년(2015 개정)은 제외
    subject("체육2", "체육", "일반선택", { sem21: 2, sem22: 2 }, { op: "2" })
  ], groups: [] }, planTemplate: { columns: {}, header: { rows: [["2026학년도 전학년 편제표"]] }, footer: { rows: [] } } };
  const report = ctx.planComplianceReport(annualLayout, { annual: { grades: ["1", "2"] } });
  const statuses = Object.fromEntries(report.items.map((entry) => [entry.no, entry.status]));
  for (const no of [1, 2, 6, 7, 10, 11, 14, 15, 16, 17, 18, 19, 20]) assert.equal(statuses[no], "해당 없음", String(no));
  assert.equal(statuses[3], "확인필요");
  assert.match(item(report, 3).note, /^1과목 확인필요: 공통수학1 6학점\(기준 4, 3~4\)/, "체육1·체육2(학년 4학점)·기후변화(학기마다 4)는 범위 안");
  assert.equal(statuses[8], "O", "물리학Ⅱ(3학년 2015 개정)는 보지 않는다");
  assert.equal(statuses[12], "O");
});

test("인정 오류: 표시 상태는 O(원래 결과 보존), 저장 자료는 편제표별로 정리되고 예전 백업(값 없음)도 읽는다", () => {
  const ctx = context();
  const layout = compliantPlan();
  byName(layout, "과학탐구실험2").credits.sem12 = 2;
  const report = ctx.planComplianceReport(layout, {});
  const saved = ctx.planComplianceNormalizeState({ plans: {
    "cohort:2026": { ack: { a5: { on: true, reason: "과학중점 학급 운영" }, zz: { on: true } }, self: { s3: { checked: true, memo: "설명회" }, s9: { checked: true } } },
    "nope": { ack: { a1: { on: true } } }, "annual:2026": { ack: {}, self: {} }
  }, settings: { kemLimit: "90", required: { "국어": "10" }, suneung: ["문학", "", "문학"] } });
  assert.deepEqual(Object.keys(saved.plans), ["cohort:2026"]);
  assert.deepEqual(Object.keys(saved.plans["cohort:2026"].ack), ["a5"]);
  assert.deepEqual(Object.keys(saved.plans["cohort:2026"].self), ["s3"]);
  assert.equal(saved.settings.kemLimit, 90);
  assert.equal(saved.settings.required["국어"], 10);
  assert.equal(saved.settings.required["과학"], 10);
  assert.deepEqual(plain(saved.settings.suneung), ["문학"]);
  assert.deepEqual(plain(ctx.planComplianceNormalizeState(undefined)), { plans: {} });
  const plan = saved.plans["cohort:2026"];
  const a5 = item(report, 5);
  assert.deepEqual(plain(ctx.planComplianceDisplayStatus(a5, plan)), { status: "O", acknowledged: true });
  const counts = ctx.planComplianceCounts(report, plan);
  assert.equal(counts["확인필요"], 1, "3번(과학탐구실험2 2학점)은 인정하지 않아 그대로");
  assert.equal(counts.acknowledged, 1);
  // 점검표 엑셀: 울산 열 구성, 인정오류 O·사유, 원래 결과, 자체 점검 확인·메모
  const sheet = ctx.planComplianceSheetRows(report, plan, "점검표");
  const values = plain(sheet.rows.map((row) => (row || []).map((cell) => cell?.v ?? cell ?? "")));
  assert.deepEqual(values[2], ["연번", "영역", "점검 내용", "점검 결과", "비고", "인정오류", "인정오류 사유"]);
  const row5 = values.find((row) => row[0] === 5);
  assert.equal(row5[3], "O");
  assert.match(row5[4], /원래 결과: 확인필요/);
  assert.deepEqual(row5.slice(5), ["O", "과학중점 학급 운영"]);
  assert.equal(values.filter((row) => row[0] === "자체점검").length, 1);
  const self3 = values.slice(values.findIndex((row) => row[0] === "자체점검")).find((row) => row[0] === 3);
  assert.equal(self3[3], "확인");
  assert.match(self3[4], /설명회/);
});

test("앱 연결: 저장·백업·초기화에 점검 자료를 넣고, 1단계 카드·표에서 점검 모듈을 부른다", () => {
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.match(app, /curriculumCompliance: \{\},/);
  assert.match(app, /curriculumCompliance: state\.curriculumCompliance,/);
  assert.match(app, /state\.curriculumCompliance = \{\};/);
  assert.match(app, /planComplianceNormalizeState\(saved\.curriculumCompliance\)/);
  assert.match(app, /planComplianceCardButton\("cohort", year/);
  assert.match(app, /planComplianceCardButton\("annual", annualYear/);
  assert.match(app, /decoratePlanComplianceSheet\(\)/);
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(html.indexOf("curriculum-compliance.js") > html.indexOf("course-checks.js") && html.indexOf("curriculum-compliance.js") < html.indexOf("app.js?"),
    "점검 모듈은 위계 모듈 뒤, app.js 앞에서 로드한다");
});
