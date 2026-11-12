const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 5단계 시수표를 학교 교과별 시수표(원래 양식)와 같게 그리는지: 행·열·병합·창체 행·요약 상자·수식·메모.
const root = path.resolve(__dirname, "..");
const hoursStats = fs.readFileSync(path.join(root, "hours-stats.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function statsContext(settings, planByCohort, snapshotRows = []) {
  const snapshot = { rows: snapshotRows };
  const layouts = Object.fromEntries(Object.keys(planByCohort).map((year) => [year, { rows: [] }]));
  const ctx = vm.createContext({
    document: { getElementById: () => null },
    state: { curriculumCohortYear: "", curriculumCohorts: {}, hoursStats: settings, roundStatuses: { "1": { status: "confirmed", snapshot } } },
    $: (selector) => selector === "#schoolYear" ? { value: "2026" } : { value: "천상고등학교" },
    curriculumCohortLayout: (year) => layouts[year] || null,
    curriculumPlanEntries: (layout) => ({ entries: planByCohort[Object.keys(layouts).find((year) => layouts[year] === layout)] || [], issues: [] }),
    applicationRoundNumbers: () => ["1"],
    roundStatusData: () => ({ students: [{ grade: "1" }, { grade: "2" }] }),
    isRoundLocked: () => true,
    buildRoundSnapshot: () => snapshot,
    roundSnapshotDrift: () => [],
    normalizeResultCourseName: (name) => String(name).replace(/[()]/g, "").replace(/\s+/g, "").toLowerCase(),
    resultExampleList: (items) => items.join(", "),
    escapeHtml: (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  });
  vm.runInContext(hoursStats, ctx);
  return ctx;
}

const entry = (grade, semester, subject, area, credit, kind = "지정") => ({ grade, semester, subject, area, credit, kind, names: 1, nameIndex: 0 });
const plan = {
  "2027": [
    entry("1", "1", "공통국어1", "국어", 4), entry("1", "2", "공통국어2", "국어", 4),
    entry("1", "1", "통합과학1", "과학", 4), entry("1", "2", "통합과학2", "과학", 4),
    entry("1", "1", "진로와 직업", "교양", 2), entry("1", "2", "진로와 직업", "교양", 2)
  ],
  "2026": [
    entry("2", "1", "문학", "국어", 4), entry("2", "1", "물리학", "과학", 4, "선택"), entry("2", "2", "일본어", "제2외국어", 3, "선택")
  ],
  "2025": [entry("3", "1", "화법과 언어", "국어", 4, "선택")]
};
const results = [
  { grade: "1", name: "물리학", semester: "1", classCount: 4, enrollment: 100, decision: "open" },
  { grade: "1", name: "일본어", semester: "2", classCount: 7, enrollment: 170, decision: "open" }
];
const baseSettings = () => ({ "2027": {
  classCounts: { "1": 10, "2": 11, "3": 11 },
  teachers: { "국어": 2, "과학-물리": 1, "제2외국어": 1, "진로": 1 },
  previousAverages: { "국어": 15.5, "과학": 16.55 },
  allocations: { "과학-물리": { "1": 40, "2": 40 } },
  allocationNotes: { "과학-물리": { "1": "통과40" } },
  nonTeaching: { "특수": 2, "영양": 1, "보건": 2, "사서": 1 },
  previousTeachers: { "국어": 3, "과학-물리": 0, "제2외국어": 1, "진로": 1 }
} });

const cellAt = (model, row, column) => model.cells.get(`${row}:${column}`);
const findRow = (model, column, value) => {
  for (let row = 1; row <= model.lastRow; row++) if (cellAt(model, row, column)?.v === value) return row;
  return -1;
};
const merged = (model, r1, c1, r2, c2) => model.merges.some((merge) => merge.join(",") === [r1, c1, r2, c2].join(","));

test("시수표 양식: 머리 3~4행, 교과군 행, 빨간 개설반(2·3학년 선택), 교사수·평균·전년도 칸", () => {
  const ctx = statsContext(baseSettings(), plan, results);
  const stats = ctx.computeHoursStats("2027");
  const model = ctx.hoursFormModel(stats, { schoolName: "천상고등학교", date: new Date(2026, 9, 5) });
  assert.equal(cellAt(model, 1, 0).v, "2027학년도 교과별 시수 통계 (총32학급)");
  assert.equal(cellAt(model, 2, 0).v, "천상고등학교 (26.10.)");
  assert.deepEqual(plain([3, 4].map((row) => Array.from({ length: 23 }, (_, column) => cellAt(model, row, column)?.v ?? null))), [
    ["교과군", null, "학기", "1학년 (2027 입학 · 신입생)", null, null, null, "2학년 (2026 입학 · 현 1학년 1차 확정)", null, null, null,
      "3학년 (2025 입학 · 현 2학년 결과 없음)", null, null, null, "총시수", null, null, "교사수", "평균시수(2027)", null, null, "2026\n평균시수\n(1년)"],
    [null, null, null, "세부과목", "학점", "개설반", "시수", "세부과목", "학점", "개설반", "시수", "세부과목", "학점", "개설반", "시수",
      "1학기", "2학기", "합계", null, "학기별", "1년", "비고", null]
  ]);
  for (const merge of [[3, 0, 4, 1], [3, 2, 4, 2], [3, 3, 3, 6], [3, 7, 3, 10], [3, 11, 3, 14], [3, 15, 3, 17], [3, 18, 4, 18], [3, 19, 3, 21], [3, 22, 4, 22]]) {
    assert.ok(merged(model, ...merge), `병합 ${merge}`);
  }
  // 국어: 학기 1·2 행, 1학기 공통국어1·문학(2학년 11반)·화법과 언어(3학년, 결과 없음 → 0반이라 숨김).
  const korean = findRow(model, 0, "국어");
  assert.equal(korean, 5);
  assert.ok(merged(model, 5, 0, 6, 1), "세부 이름이 없는 교과는 A:B 병합");
  assert.deepEqual(plain([3, 4, 5, 6, 7, 8, 9, 10, 15].map((column) => cellAt(model, 5, column)?.v)), ["공통국어1", 4, 10, 40, "문학", 4, 11, 44, 84]);
  assert.equal(cellAt(model, 5, 6).f, 'IF(PRODUCT(E5,F5)=0,"",PRODUCT(E5,F5))');
  assert.equal(cellAt(model, 5, 15).f, 'IF(SUM(G5,K5,O5)=0,"",SUM(G5,K5,O5))');
  assert.equal(cellAt(model, 6, 16).v, 40, "2학기 행 시수는 Q열");
  assert.deepEqual(plain([cellAt(model, 5, 17).f, cellAt(model, 5, 19).f, cellAt(model, 5, 20).f]),
    ["SUM(P5:Q5)", 'IF(N(S5)>0,R5/S5,"")', 'IF(N(S5)>0,AVERAGE(T5,T6),"")']);
  assert.deepEqual(plain([cellAt(model, 5, 18).v, cellAt(model, 5, 19).v, cellAt(model, 6, 19).v, cellAt(model, 5, 20).v, cellAt(model, 5, 22).v]), [2, 42, 20, 31, 15.5]);
  assert.equal(cellAt(model, 5, 18).input.attrs.id, "hoursTeachers-국어", "교사수 칸에서 바로 입력");
  assert.equal(cellAt(model, 5, 22).input.attrs["data-hours-previous"], "국어");
  // 개설반: 학교 지정은 검은 글씨, 2·3학년 선택(신청 결과)은 빨간 글씨.
  assert.equal(cellAt(model, 5, 5).k, "cell");
  const physics = findRow(model, 7, "물리학");
  assert.equal(cellAt(model, physics, 9).k, "cellRed");
  // 2·3학년 선택과목 개설반은 4단계 연동(입력 상자가 아니라 누르면 4단계로 가는 값 단추), 학교 지정은 편제표 × 학급 수 연동.
  assert.equal(cellAt(model, physics, 9).input, null);
  assert.deepEqual(plain([cellAt(model, physics, 9).link.grade, cellAt(model, physics, 9).link.semester, cellAt(model, physics, 9).link.subject]), ["1", "1", "물리학"]);
  assert.match(ctx.hoursFormHtml(model), /<button class="hf-link" type="button" data-hours-goto4="1\|1\|물리학"/);
  assert.equal(cellAt(model, 5, 5).input, null, "학교 지정 과목은 입력 상자가 아니라 편제표 연동 값 단추");
  assert.deepEqual(plain(cellAt(model, 5, 5).link.attrs), { "data-hours-goto-classes": "1" });
  assert.match(cellAt(model, 5, 5).link.title, /^편제표 연동 · 학교 지정 · 전체 학급 10학급 · /);
  // 과학: 세부(공통·물리), 공통 배분은 오른쪽 메모(X~AA)와 합계(AB), 합계 R = P:Q + AB, 공통 행 R은 배분하고 남은 시수.
  const science = findRow(model, 0, "과학");
  assert.equal(cellAt(model, science, 1).v, "공통");
  assert.equal(cellAt(model, physics, 1).v, "물리");
  assert.equal(cellAt(model, physics, 17).f, `SUM(P${physics}:Q${physics})+N(AB${physics})`);
  assert.equal(cellAt(model, physics, 17).v, 56);
  assert.equal(cellAt(model, physics, 23).v, "통과40");
  assert.equal(cellAt(model, physics, 27).v, 40);
  assert.equal(cellAt(model, science, 17).f, `IF(SUM(P${science}:Q${science})-N(AB${physics})=0,"",SUM(P${science}:Q${science})-N(AB${physics}))`);
  assert.equal(cellAt(model, science, 17).v, "", "공통 과목 1학기 40시간을 모두 물리에 배분");
  // 과학 1년 평균·비고(학기별 교과군 평균)·전년도 평균은 교과군 전체 칸.
  const scienceEnd = model.refs.groups["과학"].end;
  assert.ok(merged(model, science, 20, scienceEnd, 20) && merged(model, science, 22, scienceEnd, 22));
  assert.equal(cellAt(model, science, 22).v, 16.55);
  assert.equal(cellAt(model, science, 22).input.attrs["data-hours-previous"], "과학");
  // 생활 교양: 제2외국어 칸 이름은 개설 과목 언어(일본어), 진로와 직업은 교양 칸에 두고 합계·평균에서 뺀다.
  const living = findRow(model, 0, "생활\n교양");
  assert.equal(cellAt(model, living, 1).v, "일본어");
  const career = model.refs.career;
  assert.equal(cellAt(model, career.start, 1).v, "교양");
  assert.equal(cellAt(model, career.start, 21).v, "합계·평균\n제외");
});

test("학교 지정 과목 개설반 = 편제표 × 학급 수(연동): 예전 직접 입력은 지우지 않고 무시 + 확인 항목, 교차집중 홀수는 1단계 편제표로", () => {
  const crossEntry = (semester, subject, nameIndex, crossExtra) => ({ ...entry("1", semester, subject, "예술", 2), names: 2, nameIndex, crossed: true, crossSemesters: 2, crossExtra });
  const crossPlan = { ...plan, "2027": [...plan["2027"], crossEntry("1", "음악", 0, 1), crossEntry("1", "미술", 1, 1), crossEntry("2", "음악", 0, 1), crossEntry("2", "미술", 1, 1)] };
  const settings = baseSettings();
  settings["2027"].classCounts["1"] = 11;
  settings["2027"].classOverrides = { "1|1|공통국어1": 9, "1|2|통합과학2": 11, "2|1|문학": 3 };
  const ctx = statsContext(settings, crossPlan, results);
  const stats = ctx.computeHoursStats("2027");
  const item = (grade, semester, subject) => stats.items.find((row) => row.grade === grade && row.semester === semester && row.subject === subject);
  const korean = item("1", "1", "공통국어1");
  assert.deepEqual(plain([korean.classes, korean.autoClasses, korean.manual, korean.linked, korean.designated]), [11, 11, false, true, true]);
  assert.equal(korean.basis, "학교 지정 · 전체 학급 11학급");
  assert.equal(item("2", "1", "문학").classes, 11);
  assert.deepEqual(plain(settings["2027"].classOverrides), { "1|1|공통국어1": 9, "1|2|통합과학2": 11, "2|1|문학": 3 }, "저장 자료는 그대로");
  const notice = stats.issues.find((issue) => /^편제표와 다른 직접 입력 2개를 편제표 값으로 바꿨습니다/.test(issue.text));
  assert.ok(notice && notice.level === "info", stats.issues.map((issue) => issue.text).join("\n"));
  assert.match(notice.text, /1학년 1학기 공통국어1 9 → 11, 2학년 1학기 문학 3 → 11/);
  assert.doesNotMatch(notice.text, /통합과학2/, "편제표 값과 같은 직접 입력은 세지 않음");
  assert.ok(!stats.issues.some((issue) => /^4단계와 다른 직접 입력/.test(issue.text)));
  // 교차집중 11학급: 1반 더 받을 과목(crossExtra = 미술)이 1학기 6반·2학기 5반, 누르면 1단계 편제표(그 입학생 편제표)로.
  assert.deepEqual(plain(["1", "2"].flatMap((semester) => ["음악", "미술"].map((subject) => item("1", semester, subject).classes))), [5, 6, 6, 5]);
  const art = item("1", "1", "미술");
  assert.ok(art.crossPick && art.linked);
  const model = ctx.hoursFormModel(stats, { schoolName: "천상고등학교" });
  const artCell = [...model.cells.values()].find((cell) => cell.item === art);
  assert.equal(artCell.input, null);
  assert.deepEqual(plain(artCell.link.attrs), { "data-hours-cohort": "2027", "data-hours-cross": "1" });
  assert.match(artCell.link.title, /교차집중 11학급/);
  const html = ctx.hoursFormHtml(model);
  assert.match(html, /<button class="hf-link" type="button" data-hours-goto-classes="1" title="편제표 연동 · 학교 지정 · 전체 학급 11학급 · [^"]*" aria-label="1학년 1학기 공통국어1 개설반 11 — 학급 수 고치기">11<\/button>/);
  assert.match(html, /data-hours-cohort="2027" data-hours-cross="1"/);
  assert.doesNotMatch(html, /data-hours-item-classes="1\|1\|공통국어1"/);
  // 학급 수(4단계 기준 설정과 같은 값)를 바꾸면 따라 바뀐다. 엑셀 첫 시트 값도 같은 모델.
  settings["2027"].classCounts["1"] = 12;
  const next = ctx.computeHoursStats("2027");
  assert.equal(next.items.find((row) => row.key === korean.key).classes, 12);
  const sheets = ctx.buildHoursWorkbookSheets(next, { schoolName: "천상고등학교" });
  const row = findRow(sheets.model, 3, "공통국어1");
  assert.equal(sheets[0].rows[row - 1][5].v, 12);
  assert.equal(sheets[0].rows[row - 1][5].s, sheets[0].rows[row - 1][4].s, "개설반 칸 서식 = 같은 줄 학점 칸(검은 글씨)");
  // 1학년 선택과목은 그대로 직접 입력.
  const electivePlan = { ...plan, "2027": [...plan["2027"], entry("1", "2", "정보", "정보", 2, "선택")] };
  const electiveSettings = baseSettings();
  electiveSettings["2027"].classOverrides = { "1|2|정보": 3 };
  const elective = statsContext(electiveSettings, electivePlan, results);
  const electiveStats = elective.computeHoursStats("2027");
  const info = electiveStats.items.find((row) => row.subject === "정보");
  assert.deepEqual(plain([info.classes, info.manual, info.linked || false]), [3, true, false]);
  const infoCell = [...elective.hoursFormModel(electiveStats, {}).cells.values()].find((cell) => cell.item === info);
  assert.equal(infoCell.link, undefined);
  assert.equal(infoCell.input.attrs["data-hours-item-classes"], "1|2|정보", "1학년 선택과목은 직접 입력 그대로");
});

test("확대학급(수준별 이동수업): 꺼짐이면 완전 연동, 켜면 확대 값, 작은 값 거절, 학급 수가 바뀌면 무효, 끄면 보존, 엑셀 = 화면", () => {
  const englishPlan = { ...plan, "2026": [...plan["2026"], entry("2", "1", "영어독해", "영어", 4)] };
  const settings = baseSettings();
  settings["2027"].expandedClasses = { "2|1|영어독해": 13 };
  const ctx = statsContext(settings, englishPlan, results);
  const english = (stats) => stats.items.find((row) => row.key === "2|1|영어독해");
  const issue = (stats, pattern) => stats.issues.find((entry) => pattern.test(entry.text));
  // 1) 꺼짐(기본): 편제표 × 학급 수 11, 저장된 확대 값은 쓰지 않고 참고 한 줄.
  let stats = ctx.computeHoursStats("2027");
  assert.deepEqual(plain([english(stats).classes, english(stats).expanded ?? null]), [11, null]);
  assert.equal(issue(stats, /^확대학급 운영 꺼짐/).text, "확대학급 운영 꺼짐 · 저장된 확대 값 1개는 쓰지 않음(시수 설정에서 켜면 다시 씁니다).");
  assert.ok(!issue(stats, /6단계 분반·시간표에는 아직 반영되지 않습니다/));
  // 2) 켜기(시수 설정 체크 상자): 확대 13 → 시수 52, 값 단추에 '확대' 표시와 근거.
  const target = (dataset, value, checked = false) => ({ dataset, value, checked });
  assert.equal(ctx.updateHoursSetting(target({ hoursExpandedOn: "1" }, "on", true)), true);
  assert.equal(settings["2027"].expandedClassesOn, true);
  stats = ctx.computeHoursStats("2027");
  const item = english(stats);
  assert.deepEqual(plain([item.classes, item.autoClasses, item.expanded, item.hours]), [13, 11, 13, 52]);
  assert.match(item.basis, /확대학급 13반\(편제표 11반\)$/);
  assert.match(issue(stats, /^확대학급 1과목은 5단계 시수에만 반영됩니다\. 6단계 분반·시간표에는 아직 반영되지 않습니다/).text, /2학년 1학기 영어독해 11 → 13반/);
  assert.ok(!issue(stats, /^확대학급 운영 꺼짐/));
  const model = ctx.hoursFormModel(stats, { schoolName: "천상고등학교" });
  const cell = [...model.cells.values()].find((entry) => entry.item === item);
  assert.equal(cell.v, 13);
  assert.equal(cell.input, null, "시수표 칸은 그대로 값 단추");
  assert.equal(cell.link.cls, "is-expanded");
  assert.match(cell.link.title, /^확대학급 · 편제표 11반 → 확대 13반/);
  assert.match(ctx.hoursFormHtml(model), /<button class="hf-link is-expanded" type="button" data-hours-goto-classes="2"/);
  const sheets = ctx.buildHoursWorkbookSheets(stats, { schoolName: "천상고등학교" });
  const row = findRow(sheets.model, 7, "영어독해");
  assert.deepEqual(plain([sheets[0].rows[row - 1][9].v, sheets[0].rows[row - 1][10].v]), [13, 52], "엑셀 개설반·시수 = 화면");
  // 3) 칸 입력: 작은 값은 받지 않음(저장 그대로 + 안내), 같은 값은 지움, 큰 값은 저장.
  const input = (value) => target({ hoursExpanded: "2|1|영어독해", hoursPlan: "11", hoursPlanClasses: "11" }, value);
  ctx.updateHoursSetting(input("10"));
  assert.equal(settings["2027"].expandedClasses["2|1|영어독해"], 13, "작은 값은 받지 않음");
  assert.equal(ctx.hoursExpandedRejected.text, "확대학급은 학급 수(11)보다 커야 합니다");
  ctx.updateHoursSetting(input("14"));
  assert.equal(settings["2027"].expandedClasses["2|1|영어독해"], 14);
  assert.equal(ctx.hoursExpandedRejected, null);
  ctx.updateHoursSetting(input("11"));
  assert.equal(settings["2027"].expandedClasses["2|1|영어독해"], undefined, "학급 수와 같으면 지움");
  ctx.updateHoursSetting(input("13"));
  // 4) 학급 수가 나중에 13 이상으로 바뀌면 확대 값은 쓰지 않고 경고.
  settings["2027"].classCounts["2"] = 13;
  stats = ctx.computeHoursStats("2027");
  assert.deepEqual(plain([english(stats).classes, english(stats).expanded ?? null]), [13, null]);
  assert.match(issue(stats, /^확대학급 값 1개를 쓰지 않았습니다/).text, /2학년 1학기 영어독해 13 — 확대학급은 학급 수\(13\)보다 커야 합니다/);
  assert.equal(issue(stats, /^확대학급 값/).level, "warning");
  settings["2027"].classCounts["2"] = 11;
  // 선택과목(4단계 연동)은 확대 값이 있어도 읽지 않는다.
  settings["2027"].expandedClasses["2|1|물리학"] = 9;
  assert.equal(ctx.computeHoursStats("2027").items.find((row) => row.key === "2|1|물리학").classes, 4);
  delete settings["2027"].expandedClasses["2|1|물리학"];
  // 5) 끄면 저장된 값은 그대로, 계산은 11, 다시 켜면 13.
  ctx.updateHoursSetting(target({ hoursExpandedOn: "1" }, "on", false));
  assert.equal(settings["2027"].expandedClassesOn, undefined);
  assert.equal(settings["2027"].expandedClasses["2|1|영어독해"], 13);
  assert.equal(english(ctx.computeHoursStats("2027")).classes, 11);
  ctx.updateHoursSetting(target({ hoursExpandedOn: "1" }, "on", true));
  assert.equal(english(ctx.computeHoursStats("2027")).classes, 13);
  // 분할·교차집중 과목의 하한 문구는 그 과목의 편제표 값.
  assert.equal(ctx.hoursExpandedMinimumText({ autoClasses: 5, planClasses: 11 }), "확대학급은 편제표 값(5반, 학급 수 11)보다 커야 합니다");
});

test("시수표 양식: 창체 행(자율·진로 × 학년별 학급 수)과 요약 상자(교과·전체 평균·창체 포함 평균) 수식", () => {
  const settings = baseSettings();
  const ctx = statsContext(settings, plan, results);
  const stats = ctx.computeHoursStats("2027");
  const model = ctx.hoursFormModel(stats, { schoolName: "천상고등학교" });
  const creative = model.creativeStart;
  assert.equal(cellAt(model, creative, 0).v, "창체");
  assert.ok(merged(model, creative, 0, creative + 3, 1));
  const line = (row) => plain([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19].map((column) => cellAt(model, row, column)?.v));
  assert.deepEqual(line(creative), ["자율", 1, 10, 10, "자율", 1, 11, 11, "자율", 1, 11, 11, 32, 32, 0, 32]);
  assert.deepEqual(line(creative + 1), ["진로", 1, 10, 10, "진로", 1, 11, 11, "진로", 1, 11, 11, 32, 32, 0, 32]);
  assert.equal(cellAt(model, creative + 2, 2).v, 2);
  assert.equal(cellAt(model, creative, 6).f, "PRODUCT(E" + creative + ",F" + creative + ")");
  assert.equal(cellAt(model, creative, 4).input.attrs["data-hours-creative-part"], "자율", "창체 학점은 1학년 1학기 칸에서 입력");
  // 요약 상자
  const [s1, s2, s3] = model.summaryRows;
  assert.equal(s1, model.creativeEnd + 1);
  const { bodyStart, bodyEnd } = model.refs;
  assert.equal(cellAt(model, s1, 13).v, "교과");
  assert.equal(cellAt(model, s1, 15).f, `SUM(P${bodyStart}:P${bodyEnd})-SUM(P${model.refs.career.start}:P${model.refs.career.end})`);
  assert.equal(cellAt(model, s1, 17).f, `SUM(R${bodyStart}:R${bodyEnd})-SUM(R${model.refs.career.start}:R${model.refs.career.end})`);
  assert.equal(cellAt(model, s1, 18).f, `SUM(S${bodyStart}:S${bodyEnd})-N(S${model.refs.career.start})`);
  const totals = stats.totals;
  assert.deepEqual(plain([cellAt(model, s1, 15).v, cellAt(model, s1, 16).v, cellAt(model, s1, 17).v, cellAt(model, s1, 18).v]),
    [totals["1"], totals["2"], totals["1"] + totals["2"], 4]);
  assert.equal(totals.teachers, 4, "진로 교사는 교사 수 합계에서 뺀다");
  assert.equal(cellAt(model, s2, 13).v, "전체\n평균");
  assert.equal(cellAt(model, s2, 15).f, `IF(N(S${s1})>0,P${s1}/S${s1},"")`);
  assert.equal(cellAt(model, s2, 17).f, `IF(N(S${s1})>0,R${s1}/S${s1}/2,"")`);
  assert.equal(cellAt(model, s2, 15).v, totals["1"] / 4);
  assert.equal(cellAt(model, s3, 13).v, "창체 포함\n평균");
  assert.equal(cellAt(model, s3, 15).f, `IF(N(S${s1})>0,(P${s1}+SUM(P${creative}:P${creative + 1}))/S${s1},"")`);
  assert.equal(cellAt(model, s3, 17).f, `IF(N(S${s1})>0,(R${s1}+SUM(P${creative}:P${creative + 1})+SUM(Q${creative + 2}:Q${creative + 3}))/S${s1}/2,"")`);
  assert.equal(cellAt(model, s3, 15).v, (totals["1"] + 64) / 4, "창체 64시간 = (1+1) × 32학급");
  assert.equal(stats.totals.creative, 64);
  assert.equal(cellAt(model, s1, 19).v, " * 창체제외한 교과시수\n(진로와 직업 시수 20, 진로교사 제외)");
  assert.equal(cellAt(model, s2, 19).v, "⇒ 창체제외 교과시수만 평균냄");
  assert.equal(cellAt(model, s3, 19).v, "⇒ 창체포함 교과시수 평균냄");
  // 메모: 비교과(특수 포함)·창체 포함 평균 계산법·교사 증감(전년도 교사 수와 비교).
  assert.equal(model.memo.fixed, "◈ 2027학년도 비교과 교사 : 특수2, 영양1, 보건2, 사서1\n\n◈ 창체포함평균값\n   ⇒ (교과시간총합 + 창체64시간) / 4명");
  assert.equal(model.memo.changes, "◈ 2027학년도 ⇒ 국어과 1명 감, 물리 1명 증");
  assert.equal(cellAt(model, s1, 3).v, `${model.memo.fixed}\n\n${model.memo.changes}`);
  // 직접 고친 메모를 쓰고, 전년도 메모의 줄은 앞에 이어 둔다.
  settings["2027"].memoHistory = ["◈ 2026학년도 ⇒ 영어과 2명 감"];
  assert.equal(ctx.hoursFormModel(ctx.computeHoursStats("2027")).memo.changes, "◈ 2026학년도 ⇒ 영어과 2명 감\n◈ 2027학년도 ⇒ 국어과 1명 감, 물리 1명 증");
  settings["2027"].staffMemo = "직접 쓴 메모";
  assert.equal(ctx.hoursFormModel(ctx.computeHoursStats("2027")).memo.changes, "직접 쓴 메모");
  // 교과 교사 수가 하나도 없으면 '/ 0명' 대신 미입력 안내, 빈칸과 0명은 확인 필요 문구가 다르다.
  const keepTeachers = settings["2027"].teachers;
  settings["2027"].teachers = {};
  assert.match(ctx.hoursFormModel(ctx.computeHoursStats("2027")).memo.fixed, /\/ 교과 교사 수\(미입력\)$/);
  const blankIssues = ctx.computeHoursStats("2027").issues.map((issue) => issue.text).join("\n");
  assert.match(blankIssues, /교사 수가 비어 있는 교과/);
  assert.doesNotMatch(blankIssues, /0명으로 넣은 교과/);
  settings["2027"].teachers = Object.fromEntries(Object.keys(keepTeachers).map((key) => [key, 0]));
  const zeroIssues = ctx.computeHoursStats("2027").issues.map((issue) => issue.text).join("\n");
  assert.match(zeroIssues, /교사 수를 0명으로 넣은 교과/);
  settings["2027"].teachers = keepTeachers;
  // 창체 시수 설정: 자율·진로 따로, 예전 '창체 시수' 하나는 진로 1 + 나머지 자율.
  assert.deepEqual(plain(ctx.hoursCreativeParts({ creativeHours: 3 })), { 자율: 2, 진로: 1 });
  assert.deepEqual(plain(ctx.hoursCreativeParts({})), { 자율: 1, 진로: 1 });
  assert.deepEqual(plain(ctx.hoursCreativeParts({ creative: { 자율: 2 } })), { 자율: 2, 진로: 0 });
});

test("교사 증감 메모 문구와 배분 메모 줄임말은 원래 양식과 같다", () => {
  const ctx = statsContext(baseSettings(), plan);
  const rows = [
    { name: "국어과", previous: 9, current: 8 }, { name: "수학과", previous: 10, current: 10 }, { name: "영어과", previous: 9, current: 7 },
    { name: "물리", previous: 2, current: 3 }, { name: "일반사회", previous: 2, current: 3 }, { name: "기술가정과", previous: 1, current: 0 }
  ];
  assert.equal(ctx.hoursTeacherChangeLine("2026", rows), "◈ 2026학년도 ⇒ 국어과, 기술가정과 각1명 감, 영어과 2명 감, 물리, 일반사회 각1명 증");
  // 올해 교사 수가 빈칸(아직 입력 전)인 교과는 비교하지 않는다(0명으로 입력하면 '감'). 하나도 없으면 증감 줄 없음.
  assert.equal(ctx.hoursTeacherChangeLine("2026", rows.map((row) => row.name === "기술가정과" ? { ...row, current: NaN } : row)),
    "◈ 2026학년도 ⇒ 국어과 1명 감, 영어과 2명 감, 물리, 일반사회 각1명 증");
  assert.equal(ctx.hoursTeacherChangeLine("2026", rows.map((row) => ({ ...row, current: NaN }))), "", "올해 교사 수가 비어 있으면 증감 줄 없음");
  assert.equal(ctx.hoursTeacherChangeLine("2026", rows.map((row) => ({ ...row, previous: NaN }))), "", "전년도 값이 없으면 빈 줄");
  assert.equal(ctx.hoursTeacherChangeLine("2026", [{ name: "국어과", previous: 8, current: 8 }]), "◈ 2026학년도 ⇒ 교과 교사 수 변동 없음");
  assert.deepEqual(plain(["통합과학1", "과학탐구실험2", "융합과학 탐구", "기후변화와 환경생태", "통합사회2", "사회문제 탐구", "기후변화와 지속가능한 세계", "역사로 탐구하는 현대세계"]
    .map((name) => ctx.hoursShortSubject(name))), ["통과", "과탐실", "융과", "기환", "통사", "사문탐", "기후지속", "역탐현"]);
  assert.equal(ctx.hoursShortSubject("과학과제 연구"), "과제연구", "'과과탐' 같은 알아보기 어려운 줄임말 대신");
});

test("엑셀 첫 시트는 같은 모델: 시트명·병합·틀 고정 D5·세로 인쇄, 배분 메모는 X~AA 칸에 나눠 적고 스타일 번호는 목록 안", () => {
  const ctx = statsContext(baseSettings(), plan, results);
  const stats = ctx.computeHoursStats("2027");
  const sheets = ctx.buildHoursWorkbookSheets(stats, { schoolName: "천상고등학교", date: new Date(2026, 9, 5) });
  const sheet = sheets[0];
  assert.equal(sheet.name, "2027 교사시수표");
  assert.equal(sheet.freeze, "D5");
  assert.equal(sheet.orientation, "portrait");
  assert.equal(sheet.widths.length, 28);
  assert.ok(sheet.merges.includes("A1:W1") && sheet.merges.includes("A3:B4") && sheet.merges.includes("D3:G3"));
  const model = sheets.model;
  const physics = findRow(model, 7, "물리학");
  assert.ok(!sheet.merges.some((merge) => merge.startsWith(`X${physics}:`)), "배분 메모는 병합하지 않고 칸마다");
  assert.equal(sheet.rows[physics - 1][23].v, "통과40");
  assert.equal(sheet.rows[physics - 1][27].v, 40);
  const [s1] = model.summaryRows;
  assert.equal(sheet.rows[s1 - 1][15].f, model.cells.get(`${s1}:15`).f);
  const xml = sheets.stylesXml;
  const count = Number(xml.match(/<cellXfs count="(\d+)"/)[1]);
  const used = sheets.flatMap((item) => item.rows.flat()).filter((cell) => cell && Number.isInteger(cell.s)).map((cell) => cell.s);
  assert.ok(Math.max(...used) < count);
  // 보고서 공통 스타일 번호(2 머리글 · 5 0.00 · 10 0.0)는 그대로다.
  const xfs = [...xml.matchAll(/<xf numFmtId="(\d+)" fontId="\d+" fillId="(\d+)"/g)].slice(1).map((match) => [Number(match[1]), Number(match[2])]);
  assert.deepEqual(plain([xfs[2], xfs[5], xfs[10]]), [[0, 2], [164, 0], [165, 0]]);
  assert.match(xml, /<numFmt numFmtId="164" formatCode="0.00"\/><numFmt numFmtId="165" formatCode="0.0"\/>/);
  assert.match(xml, /<fgColor rgb="FFFFFF00"\/>/);
  assert.match(xml, /<color rgb="FFFF0000"\/>/);
  assert.match(xml, /<fgColor rgb="FFE2EFDA"\/>/, "창체 연초록");
  // 화면 표도 같은 모델: 병합 칸·입력 칸·창체·요약 상자.
  const html = ctx.hoursFormHtml(model);
  assert.match(html, /<td rowspan="2" colspan="2" class="hf-head [^"]*">교과군<\/td>/);
  assert.match(html, /id="hoursTeachers-국어"/);
  assert.match(html, /data-hours-allocation-note="과학-물리\|1"/);
  assert.match(html, /data-hours-creative-part="자율"/);
  assert.match(html, /data-hours-staff-memo="1"/);
  // 회색 예시는 실제 값처럼 보이지 않게 '예:'·'예시)'로 시작하고, 배분 시수 칸에는 0 예시를 두지 않는다.
  assert.match(html, /placeholder="예: 통과10 · 과탐실3"/);
  assert.match(html, /data-hours-staff-memo="1"[^>]*placeholder="예시\) ◈/);
  assert.doesNotMatch(html, /data-hours-allocation="[^"]*"[^>]*placeholder="0"/);
  assert.match(html, /class="hf-sum2Num[^"]*">/);
});

test("시수표 칸 입력: 개설반을 자동 값과 같게 쓰면 직접 입력을 지우고, 창체 학점·메모·전년도 교사 수를 저장한다", () => {
  const settings = baseSettings();
  const ctx = statsContext(settings, plan, results);
  const target = (dataset, value, checked = false) => ({ dataset, value, checked });
  assert.equal(ctx.updateHoursSetting(target({ hoursItemClasses: "2|1|물리학", hoursAuto: "4" }, "5")), true);
  assert.equal(settings["2027"].classOverrides["2|1|물리학"], 5);
  ctx.updateHoursSetting(target({ hoursItemClasses: "2|1|물리학", hoursAuto: "4" }, "4"));
  assert.equal(settings["2027"].classOverrides["2|1|물리학"], undefined);
  settings["2027"].creativeHours = 3;
  ctx.updateHoursSetting(target({ hoursCreativePart: "진로" }, "2"));
  assert.deepEqual(plain(settings["2027"].creative), { 자율: 2, 진로: 2 });
  assert.equal(settings["2027"].creativeHours, 4);
  assert.equal(ctx.computeHoursStats("2027").totals.creative, 4 * 32);
  ctx.updateHoursSetting(target({ hoursStaffMemo: "1", hoursAutoMemo: "자동" }, "자동"));
  assert.equal(settings["2027"].staffMemo, undefined, "자동 문구와 같으면 저장하지 않는다");
  ctx.updateHoursSetting(target({ hoursStaffMemo: "1", hoursAutoMemo: "자동" }, "고친 메모"));
  assert.equal(settings["2027"].staffMemo, "고친 메모");
  ctx.updateHoursSetting(target({ hoursPreviousTeachers: "국어" }, "4"));
  assert.equal(settings["2027"].previousTeachers["국어"], 4);
  ctx.updateHoursSetting(target({ hoursAllocationNote: "과학-물리|2" }, " 통과40 "));
  assert.equal(settings["2027"].allocationNotes["과학-물리"]["2"], "통과40");
  ctx.updateHoursSetting(target({ hoursShowZero: "1" }, "", true));
  assert.equal(settings["2027"].showZeroClasses, true);
  const shown = ctx.hoursFormModel(ctx.computeHoursStats("2027"));
  assert.ok(findRow(shown, 11, "화법과 언어") > 0, "개설반 0 과목도 보기");
});

test("5단계 화면은 숨겨져 있으면 그리지 않고, 다시 그릴 때 창·표 스크롤과 입력 칸을 되살린다", () => {
  assert.match(hoursStats, /function renderHoursStatsView\(\) \{[\s\S]*?workflowStep7Panel[\s\S]*?contains\("hidden"\)\) return;/);
  // 스크롤·포커스·팝업 스크롤 보존은 공통 도우미(view-keep.js preserveViewDuring) 하나로 한다.
  const entry = hoursStats.slice(hoursStats.indexOf("function renderHoursStats("), hoursStats.indexOf("function renderHoursStatsView("));
  assert.match(entry, /preserveViewDuring\(\["#workflowStep7Panel", "#hoursSettingsBody", "#hoursRecommendBody", "#hoursIssuesBody"\], renderHoursStatsView\)/);
  assert.doesNotMatch(hoursStats, /hoursCaptureView|hoursRestoreView/);
  assert.match(hoursStats, /data-hours-scroll="form"/);
  assert.match(hoursStats, /data-focus-key="classes-/);
  const viewKeep = fs.readFileSync(path.join(root, "view-keep.js"), "utf8");
  assert.match(viewKeep, /VIEW_KEEP_SCROLL_SELECTOR = "[^"]*dialog\[open\], dialog\[open\] > form"/);
  assert.match(hoursStats, /function hoursStatsCached\(/);
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(html, /id="hoursRecommendDialog"[\s\S]*id="hoursRecommendBody"/);
});

test("createWorkbookBlob: 틀 고정 D5는 위 4행·왼쪽 3열, 세로 인쇄·한 쪽 맞춤, stylesXml을 넘기면 그 스타일 목록", () => {
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const start = app.indexOf("    function createWorkbookBlob(");
  const source = app.slice(start, app.indexOf("    function downloadBlob(", start));
  const ctx = vm.createContext({
    createXlsxBlob: (files) => files, createReportStylesXml: () => "REPORT",
    xmlEscape: (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    columnName: (index) => String.fromCharCode(65 + index)
  });
  vm.runInContext(`${source}; this.createWorkbookBlob = createWorkbookBlob;`, ctx);
  const files = ctx.createWorkbookBlob([
    { name: "2027 교사시수표", rows: [["a"]], freeze: "D5", orientation: "portrait", fitToHeight: 1 },
    { name: "상세", rows: [["b"]], freeze: "A2" }
  ], { stylesXml: "FORM" });
  assert.equal(files["xl/styles.xml"], "FORM");
  assert.match(files["xl/worksheets/sheet1.xml"], /<pane xSplit="3" ySplit="4" topLeftCell="D5" activePane="bottomRight" state="frozen"\/>/);
  assert.match(files["xl/worksheets/sheet1.xml"], /orientation="portrait" fitToWidth="1" fitToHeight="1"/);
  assert.match(files["xl/worksheets/sheet2.xml"], /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(files["xl/worksheets/sheet2.xml"], /orientation="landscape" fitToWidth="1" fitToHeight="0"/);
  assert.equal(ctx.createWorkbookBlob([{ name: "x", rows: [] }])["xl/styles.xml"], "REPORT");
});

test("5단계 '전년도 설정 불러오기' 등 결과 안내는 앱 알림·상태 줄로 보인다(선언 안 된 status → window.status로 사라지지 않게)", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "hours-stats.js"), "utf8");
  assert.doesNotMatch(source, /(^|[^.\w])status\.(style|textContent)/m, "hours-stats.js는 전역 status를 쓰지 않는다");
  const toasts = [];
  const node = { style: {}, textContent: "" }, panelNode = { style: {}, textContent: "" };
  const ctx = vm.createContext({
    state: { hoursStats: {} }, document: { getElementById: (id) => id === "status" ? node : id === "hoursStatus" ? panelNode : null },
    showAppToast: (message, kind) => toasts.push([message, kind]), hoursTargetYear: () => "2027", hoursPlainObject: (value) => !!value && typeof value === "object"
  });
  vm.runInContext(source.slice(source.indexOf("function hoursNotify("), source.indexOf("// '추천 적용'")), ctx);
  ctx.loadPreviousHoursSettings();
  assert.equal(toasts.length, 1);
  assert.match(toasts[0][0], /2026학년도 시수 통계 자료가 없습니다/);
  assert.equal(toasts[0][1], "error");
  assert.equal(node.textContent, toasts[0][0]);
  assert.equal(panelNode.textContent, toasts[0][0], "5단계 화면 안 상태 줄에도 보인다");
  assert.match(require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "index.html"), "utf8"), /id="workflowStep7Panel"[\s\S]*?id="hoursStatus" role="status"[\s\S]*?id="hoursStatsContent"/);
});

test("5단계 증감 안내: 빈 이유(전년도/올해 교사 수)를 바로 말하고, 올해 교사 수가 빈칸이면 증감 열을 비우며, 추천은 '빈칸→n'", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "hours-stats.js"), "utf8");
  const ctx = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf("function hoursChangeLineMissingText("), source.indexOf("// 전년도 교과별 교사 수: 메모")), ctx);
  const stats = (rows) => ({ departments: rows.map(([previousTeachers, teachers], index) => ({ id: `d${index}`, previousTeachers, teachers })) });
  assert.match(ctx.hoursChangeLineMissingText(stats([[8, null], [10, null]])), /^올해 교사 수가 없어/, "전년도는 있고 올해가 빈칸");
  assert.match(ctx.hoursChangeLineMissingText(stats([[null, 8]])), /^전년도 교사 수가 없어/);
  assert.match(ctx.hoursChangeLineMissingText(stats([[null, null]])), /^전년도·올해 교사 수가 없어/);
  // 표의 증감 칸: 올해 교사 수가 빈칸이면 계산하지 않는다(-8, -11처럼 보이지 않게).
  const table = source.slice(source.indexOf("function hoursPreviousTeachersSettings("), source.indexOf("function scheduleHoursRerender("));
  assert.match(table, /department\.previousTeachers === null \|\| department\.teachers === null \|\| department\.teachers === undefined\n\s*\? null/);
  assert.match(source, /`빈칸→\$\{hoursFormat\(row\.recommended, 1\)\}`/);
  assert.match(source, /\$\{row\.current \?\? "빈칸"\}→\$\{row\.recommended\}/);
});
