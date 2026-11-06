// 위계(선이수) 경고를 교사가 일하는 표에 보이기: 4단계 집계표 과목별 배지·팝업·'처리할 것만'·엑셀 시트,
// 3단계 학생 목록 표시·필터, 재신청 명단 열, 웹 신청 현황 계산. 위계는 경고만 한다(저장 막기·서버 검사 없음).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "course-checks.js"), "utf8");
const resultImport = fs.readFileSync(path.join(root, "result-import.js"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");

function functionSource(text, start, end) {
  const first = text.indexOf(start);
  const last = text.indexOf(end, first + start.length);
  assert.notEqual(first, -1, `missing marker ${start}`);
  assert.notEqual(last, -1, `missing marker ${end}`);
  return text.slice(first, last);
}

const plain = (value) => JSON.parse(JSON.stringify(value));

// 합성 편제표(course-checks.test.cjs와 같은 모양): 2-1 택1(미적분Ⅰ·확률과 통계), 2-2 택1(미적분Ⅱ·기하),
// 2-1 택3(물리학·화학·생명과학·지구과학), 2-2 택2(역학과 에너지·생물의 유전·물질과 에너지), 3-1 택2(전자기와 양자·화학 반응의 세계·세포와 물질대사).
function syntheticPlan() {
  let id = 0;
  const subject = (area, name, credits = {}) => ({ id: `s${++id}`, area, name, credits, texts: {} });
  return {
    version: 1,
    subjects: [
      subject("수학", "공통수학1", { sem11: 4 }), subject("수학", "공통수학2", { sem12: 4 }), subject("수학", "대수", { sem21: 4 }),
      subject("수학", "미적분Ⅰ, 확률과 통계"), subject("수학", "미적분Ⅱ, 기하"),
      subject("과학", "물리학, 화학, 생명과학, 지구과학"), subject("과학", "역학과 에너지, 생물의 유전, 물질과 에너지"),
      subject("과학", "전자기와 양자, 화학 반응의 세계, 세포와 물질대사")
    ],
    groups: [
      { id: "g1", fields: ["sem21"], pick: 1, credit: 4, members: ["s4"] },
      { id: "g2", fields: ["sem22"], pick: 1, credit: 4, members: ["s5"] },
      { id: "g3", fields: ["sem21"], pick: 3, credit: 3, members: ["s6"] },
      { id: "g4", fields: ["sem22"], pick: 2, credit: 3, members: ["s7"] },
      { id: "g5", fields: ["sem31"], pick: 2, credit: 4, members: ["s8"] }
    ]
  };
}

const COLUMNS = { "미적분Ⅰ": "c1", "확률과 통계": "c2", "미적분Ⅱ": "c3", "기하": "c4", "물리학": "c5", "화학": "c6", "생명과학": "c7",
  "지구과학": "c8", "역학과 에너지": "c9", "생물의 유전": "c10", "물질과 에너지": "c11", "전자기와 양자": "d1", "화학 반응의 세계": "d2", "세포와 물질대사": "d3" };

function student(grade, classroom, number, name, courses) {
  return { id: `${grade}-${classroom}-${number}`, grade, classroom, number, name,
    selections: courses.map((course) => ({ name: course, column: COLUMNS[course], credits: 3 })) };
}

function students() {
  return [
    // 현 1학년(2학년 과목): 미적분Ⅰ 없이 미적분Ⅱ → 경고
    student("1", "2", "34", "진가람", ["확률과 통계", "미적분Ⅱ", "물리학", "화학", "지구과학", "역학과 에너지", "물질과 에너지"]),
    student("1", "1", "1", "가나다", ["미적분Ⅰ", "미적분Ⅱ", "물리학", "화학", "생명과학", "역학과 에너지", "생물의 유전"]),
    // 미적분Ⅱ·생물의 유전 둘 다 경고(두 과목)
    student("1", "9", "35", "허다솜", ["확률과 통계", "미적분Ⅱ", "물리학", "화학", "지구과학", "역학과 에너지", "생물의 유전"]),
    // 현 2학년(3학년 과목): 2학년 선택 과목(화학·물리학)이 필요하지만 이전 학년 결과가 없으면 '확인 불가'
    student("2", "1", "1", "선배일", ["화학 반응의 세계", "전자기와 양자"]),
    student("2", "1", "2", "선배이", ["세포와 물질대사"])
  ];
}

function checksContext(state = { students: students(), courseChecks: {} }) {
  const planData = syntheticPlan();
  state.curriculumCohorts = { "2025": { importedLayout: { planData } }, "2026": { importedLayout: { planData } } };
  const ctx = vm.createContext({ state, getApplicationCohortYear: (grade) => String(grade) === "1" ? 2026 : 2025 });
  vm.runInContext(functionSource(app, "function normalizeRomanNumerals(", "function classifyApplicationRecords("), ctx);
  vm.runInContext(functionSource(resultImport, "function normalizeResultCourseName(", "function resultCourseSemester("), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, "curriculum-subject-list.js"), "utf8"), ctx);
  vm.runInContext(source, ctx);
  return ctx;
}

test("prereq flags: per-course warning counts, unknowns kept apart, one pass reused from the cache", () => {
  const ctx = checksContext();
  const flags = ctx.courseCheckFlags(ctx.state.students);
  assert.equal(flags.courses.get("1:c3").violators.size, 2, "미적분Ⅱ 신청자 중 경고 2명");
  assert.equal(flags.courses.get("1:c10").violators.size, 1, "생물의 유전 경고 1명");
  assert.equal(flags.courses.has("1:c1"), false, "선이수 과목 자체에는 배지가 없다");
  assert.equal(flags.grades.get("1").violators.length, 2);
  assert.equal(flags.grades.get("1").checked, 3);
  // 확인 불가는 위반과 섞지 않는다.
  assert.equal(flags.grades.get("2").violators.length, 0);
  assert.equal(flags.grades.get("2").unknowns.length, 2);
  assert.equal(flags.courses.get("2:d2").violators.size, 0);
  assert.equal(flags.courses.get("2:d2").unknownStudents.size, 1);
  assert.equal(flags.courses.get("2:d3").unknownStudents.size, 1, "세포와 물질대사 ← 생명과학(2학년 선택 과목)도 확인 불가");
  // 같은 자료면 다시 계산하지 않는다(집계 한 번에 학생 전체 한 번).
  assert.equal(ctx.courseCheckFlags(ctx.state.students), flags);
  // 짧은 근거: 신청 학년에서 선이수 과목이 나오는 학기를 함께 적는다.
  const jin = flags.students.get(ctx.state.students[0]);
  assert.equal(jin.violations[0].brief, "미적분Ⅰ 미이수(2-1에 미적분Ⅰ 없음)");
  const html = ctx.courseCheckStudentsDialogHtml(flags.courses.get("1:c3").violations, flags.courses.get("1:c3").unknowns, { title: "미적분Ⅱ" });
  assert.match(html, /현 1학년 2반 34번 진가람 · 미적분Ⅱ: 미적분Ⅰ 미이수\(2-1에 미적분Ⅰ 없음\)/);
  assert.match(html, /위계 경고 2명/);
  assert.doesNotMatch(html, /확인 불가/);
  // 배지: 경고 수만 과목 행에 둔다. 확인 불가는 과목 행에 두지 않는다(학년 머리줄·팝업에만).
  assert.match(ctx.courseCheckCourseBadges(flags, "1:c3", "미적분Ⅱ"), /class="at-risk-badge prereq-badge"[^>]*data-prereq-course="1:c3"[^>]*>위계 경고 2</);
  const unknownBadge = ctx.courseCheckCourseBadges(flags, "2:d2", "화학 반응의 세계");
  assert.equal(unknownBadge, "", "확인 불가만 있는 과목 행에는 배지가 없다");
  // 확인 불가 학생은 그 과목 팝업 안 접힌 칸에는 남는다.
  const unknownHtml = ctx.courseCheckStudentsDialogHtml(flags.courses.get("2:d2").violations, flags.courses.get("2:d2").unknowns, { title: "화학 반응의 세계" });
  assert.match(unknownHtml, /<details class="prereq-unknown-details"><summary>확인 불가 1명/);
  assert.equal(ctx.courseCheckCourseBadges(flags, "1:c5", "물리학"), "");
  // 학년 머리줄: 위계 경고·확인 불가(따로)는 학생 팝업, 학점은 점검 팝업.
  const note1 = ctx.courseCheckAggregateNote("1", flags);
  assert.match(note1, /data-open-dialog="prereqStudentsDialog" data-prereq-grade="1"[^>]*>위계 경고 2명</);
  assert.doesNotMatch(note1, /확인 불가/);
  const note2 = ctx.courseCheckAggregateNote("2", flags);
  assert.match(note2, />위계 경고 0명</);
  assert.match(note2, /class="aggregate-check-note is-muted"[^>]*data-prereq-unknown[^>]*>확인 불가 2명</);
  // 이전 학년 이수 결과를 올리면 확인 불가가 판단된다(화학 없음 → 경고).
  ctx.state.courseChecks = { prior: { "2025": { fileName: "x", students: [{ grade: "2", classroom: "1", number: "1", name: "선배일", subjects: ["물리학"] }] } } };
  const settled = ctx.courseCheckFlags(ctx.state.students);
  assert.notEqual(settled, flags, "설정이 바뀌면 다시 계산한다");
  assert.equal(settled.courses.get("2:d2").violators.size, 1);
  assert.equal(settled.students.get(ctx.state.students[3]).violations[0].brief, "화학 미이수(이수 근거 없음)");
});

test("prereq sheet rows: grade filter, header columns, a single 'none' row and the unknown note", () => {
  const ctx = checksContext();
  const rows = plain(ctx.courseCheckAggregateSheetRows(ctx.state.students, "1"));
  assert.deepEqual(rows[0], ["현 학년", "반", "번호", "이름", "신청 학년", "과목", "필요한 선이수", "근거"]);
  assert.deepEqual(rows[1], ["현 1학년", "2", "34", "진가람", "2학년", "미적분Ⅱ", "미적분Ⅰ", "미적분Ⅰ 미이수(2-1에 미적분Ⅰ 없음)"]);
  assert.equal(rows.length, 4, "진가람 1건 + 허다솜 2건");
  assert.deepEqual(rows.slice(2).map((row) => row[5]), ["미적분Ⅱ", "생물의 유전"]);
  const senior = plain(ctx.courseCheckAggregateSheetRows(ctx.state.students, "2"));
  assert.deepEqual(senior[1], ["위계 경고 학생 없음"]);
  assert.match(senior.at(-1)[0], /확인 불가 2명/);
  const both = ctx.courseCheckAggregateSheetRows(ctx.state.students, "");
  assert.equal(both.filter((row) => row[0] === "현 1학년").length, 3);
  // 점검할 편제표가 없으면 시트를 만들지 않는다.
  const none = checksContext();
  none.state.curriculumCohorts = {};
  assert.equal(none.courseCheckAggregateSheetRows(none.state.students, ""), null);
});

test("aggregate table: the course row shows the warning badge and 'attention only' keeps it (count included)", () => {
  const checks = checksContext();
  const ctx = vm.createContext({ $: () => ({ value: "" }), state: {}, escapeHtml: String,
    courseCheckCourseBadges: checks.courseCheckCourseBadges, courseCheckAggregateNote: () => "" });
  vm.runInContext(functionSource(app, "function aggregateThresholds(", "function renderAggregate("), ctx);
  const course = (column, name, enrollment, classCount) => ({ column, name, enrollment, atRisk: false, closed: false, classCount,
    enrollmentPerDivision: 1, averageClassSize: enrollment / classCount });
  const report = { summary: { grade: "1", students: 60, classes: 2, classSource: "roster", averageClassSize: 30, openingLimit: 27, divisionLimit: 33 },
    semesters: [{ name: "2학년 2학기", groups: [{ category: "2-2 택1", choiceCount: 1, totalClasses: 2, courses: [
      course("c3", "미적분Ⅱ", 30, 1), course("c4", "기하", 30, 1)] }] }] };
  const prereq = checks.courseCheckFlags(checks.state.students);
  const options = { closures: { "1:c3": "open", "1:c4": "open" }, round: "1", locked: false, maxClassSize: 34, attentionOnly: false, canUndo: false, prereq };
  const markup = ctx.aggregateGradeSectionMarkup(report, options);
  assert.match(markup, /data-course-key="1:c3"[\s\S]*?<td class="aggregate-status"><span class="aggregate-ok">충족<\/span><button type="button" class="at-risk-badge prereq-badge"[^>]*>위계 경고 2<\/button>/);
  assert.doesNotMatch(markup.slice(markup.indexOf('data-course-key="1:c4"')), /위계 경고/);
  // 처리할 것만: 결정·인원·목표가 모두 정상이어도 위계 경고가 있는 과목은 남는다.
  assert.equal(ctx.aggregateAttention(report, options.closures, 34).count, 0, "위계 정보 없이 부르면 예전과 같다");
  assert.equal(ctx.aggregateAttention(report, options.closures, 34, prereq).count, 1);
  const attention = ctx.aggregateGradeSectionMarkup(report, { ...options, attentionOnly: true });
  assert.deepEqual([...attention.matchAll(/data-course-key="([^"]+)"/g)].map((match) => match[1]), ["1:c3"]);
  // 위계 정보를 넘기지 않으면 배지가 없다(이전 호출 그대로).
  assert.doesNotMatch(ctx.aggregateGradeSectionMarkup(report, { ...options, prereq: null }), /prereq-badge/);
});

test("aggregate workbook: the school sheets stay as they are and a '위계 경고 학생' sheet is added for the chosen grade", () => {
  const checks = checksContext();
  let grade = "1";
  const ctx = vm.createContext({
    state: checks.state, aggregateThresholds: () => ({ openingPercent: 90, divisionPercent: 110 }),
    aggregateRecords: () => ({ reports: [{ summary: { grade: "1" } }, { summary: { grade: "2" } }] }),
    nextYearClassBases: () => ({}), activeAggregateGrade: () => grade,
    createWorksheetXml: (report) => `<worksheet school="${report.summary.grade}"/>`, createStylesXml: () => "<styleSheet/>",
    courseCheckAggregateSheetRows: checks.courseCheckAggregateSheetRows,
    aggregateSheetName: (report) => `${Number(report.summary.grade) + 1}학년`, aggregateWorkbookExtrasXml: () => ""
  });
  vm.runInContext(functionSource(app, "function xmlEscape(", "function createWorksheetXml("), ctx);
  vm.runInContext(functionSource(app, "function aggregatePrereqSheetXml(", "function downloadAggregate("), ctx);
  const files = ctx.buildAggregateXlsxFiles();
  assert.match(files["xl/workbook.xml"], /<sheet name="2학년" sheetId="1" r:id="rId1"\/><sheet name="위계 경고 학생" sheetId="2" r:id="rId2"\/>/);
  assert.equal(files["xl/worksheets/sheet1.xml"], '<worksheet school="1"/>', "학교 서식 시트는 그대로");
  const sheet = files["xl/worksheets/sheet2.xml"];
  assert.match(sheet, /필요한 선이수/);
  assert.match(sheet, />진가람</);
  assert.match(sheet, />미적분Ⅰ 미이수\(2-1에 미적분Ⅰ 없음\)</);
  assert.doesNotMatch(sheet, />선배일</, "다른 학년은 넣지 않는다");
  assert.match(files["[Content_Types].xml"], /sheet2\.xml/);
  assert.match(files["xl/_rels/workbook.xml.rels"], /rId3"[^>]*styles/);
  grade = "2";
  const senior = ctx.buildAggregateXlsxFiles();
  assert.match(senior["xl/worksheets/sheet2.xml"], />위계 경고 학생 없음</);
  assert.match(senior["xl/worksheets/sheet2.xml"], /확인 불가 2명/);
});

test("step 3 roster: '위계 경고만' keeps only warned students and the list marks them", () => {
  const checks = checksContext();
  const values = { "#searchInput": "", "#classFilter": "", "#gradeFilter": "" };
  let prereqOnly = false;
  const ctx = vm.createContext({ state: checks.state, courseCheckFlags: checks.courseCheckFlags,
    $: (selector) => selector === "#prereqFilter" ? { checked: prereqOnly } : { value: values[selector] } });
  vm.runInContext(functionSource(app, "function visibleStudents(", "function renderRoster("), ctx);
  assert.equal(ctx.visibleStudents().length, 5);
  prereqOnly = true;
  assert.deepEqual(plain(ctx.visibleStudents().map((item) => item.name)), ["진가람", "허다솜"]);
  values["#gradeFilter"] = "2";
  assert.equal(ctx.visibleStudents().length, 0, "확인 불가 학생은 위계 경고에 들지 않는다");
  // 목록 이름 옆 표시(⚠ 위계)와 필터 개수는 renderRoster가 같은 계산 결과로 그린다.
  const roster = functionSource(app, "function renderRoster(", "function certificateGroupSettings(");
  assert.match(roster, /courseCheckFlags\(state\.students\)/);
  assert.match(roster, /⚠ 위계/);
  assert.match(fs.readFileSync(path.join(root, "index.html"), "utf8"), /id="prereqFilter"[^>]*> 위계 경고만/);
});

test("retake list: a prerequisite warning column after closures (a closed prerequisite shows up)", () => {
  const checks = checksContext();
  const warned = checks.state.students[1];
  // 가나다: 미적분Ⅰ이 폐강되면 미적분Ⅱ가 선이수 없이 남는다.
  assert.equal(checks.courseCheckPrereqText(warned), "");
  assert.equal(checks.courseCheckPrereqText(warned, { exclude: ["미적분Ⅰ"] }), "미적분Ⅱ: 선이수 과목(미적분Ⅰ) 폐강");
  // 원래부터 이수하지 않은 경고는 폐강과 섞지 않는다: 진가람(미적분Ⅰ 없이 미적분Ⅱ)은 화학이 폐강되면
  // 물질과 에너지는 '선이수 과목(화학) 폐강', 미적분Ⅱ는 그대로 '미적분Ⅰ 미이수'.
  const jin = checks.state.students[0];
  assert.equal(checks.courseCheckPrereqText(jin, { exclude: ["화학"] }),
    "미적분Ⅱ: 미적분Ⅰ 미이수(2-1에 미적분Ⅰ 없음) / 물질과 에너지: 선이수 과목(화학) 폐강");
  // 학생이 고르지 않은 선이수 과목이 폐강 목록에 있어도 '폐강'으로 쓰지 않는다.
  assert.equal(checks.courseCheckPrereqText(jin, { exclude: ["미적분Ⅰ"] }), "미적분Ⅱ: 미적분Ⅰ 미이수(2-1에 미적분Ⅰ 없음)");
  let files = null;
  const ctx = vm.createContext({
    retakeTargets: () => ({ sourceRound: "1", rows: [{ student: warned, courses: ["미적분Ⅰ"] }] }),
    courseCheckPrereqText: checks.courseCheckPrereqText, courseCheckRetakeShortfall: () => "없음",
    columnName: (index) => "ABCDEFGH"[index], xmlEscape: String, createStylesXml: () => "<styleSheet/>",
    createXlsxBlob: (parts) => { files = parts; return {}; },
    document: { createElement: () => ({ click() {} }) },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} }, setTimeout: () => 0
  });
  vm.runInContext(functionSource(app, "function downloadRetakeList(", "function applicationCohortYear("), ctx);
  ctx.downloadRetakeList();
  assert.match(files["xl/worksheets/sheet1.xml"], /위계 경고\(폐강 후\)/);
  assert.match(files["xl/worksheets/sheet1.xml"], /미적분Ⅱ: 선이수 과목\(미적분Ⅰ\) 폐강/);
  assert.match(functionSource(app, "function renderRetakePanel(", "function downloadRetakeList("), /<th>위계 경고\(폐강 후\)<\/th>/);
});

test("web application status: teacher review is computed on screen from student picks and the event's requires", () => {
  const ctx = checksContext();
  const model = ctx.courseCheckPlanModel(syntheticPlan());
  const rules = ctx.courseCheckApplicableDefaults([model]);
  const semesterOf = { "미적분Ⅰ": "1", "확률과 통계": "1", "물리학": "1", "화학": "1", "생명과학": "1", "지구과학": "1" };
  const names = ["미적분Ⅰ", "확률과 통계", "미적분Ⅱ", "기하", "물리학", "화학", "생명과학", "지구과학", "역학과 에너지", "생물의 유전"];
  const courses = names.map((subject) => ({ subject, credit: 3, semester: semesterOf[subject] || "2" }));
  const seniors = ["전자기와 양자", "세포와 물질대사"].map((subject) => ({ subject, credit: 4, semester: "1" }));
  const payload = ctx.courseCheckEventPayload(model, rules, { targetGrade: "2", courses });
  for (const course of courses) if (payload.requires.has(course.subject)) course.requires = payload.requires.get(course.subject);
  const seniorPayload = ctx.courseCheckEventPayload(model, rules, { targetGrade: "3", courses: seniors });
  for (const course of seniors) if (seniorPayload.requires.has(course.subject)) course.requires = seniorPayload.requires.get(course.subject);
  const groups = [{ grade: "2", semester: "1", name: "2-1 택1", count: 1, courses: ["미적분Ⅰ", "확률과 통계"], checks: payload.checks },
    { grade: "3", semester: "1", name: "3-1 택1", count: 1, courses: ["전자기와 양자", "세포와 물질대사"], checks: seniorPayload.checks }];
  const entry = (id, grade, selections, submittedAt = "2026-11-06") => ({ id, grade, classroom: "1", number: id, name: `학생${id}`, selections, submittedAt });
  const data = { subjects: { "2": courses, "3": seniors }, groups, entries: [
    entry("1", "1", ["확률과 통계", "미적분Ⅱ"]), entry("2", "1", ["미적분Ⅰ", "미적분Ⅱ"]), entry("3", "1", [], null),
    entry("4", "2", ["전자기와 양자"])] };
  const review = ctx.courseCheckTeacherReview(data, "1");
  assert.equal(review.available, true);
  assert.equal(review.entries, 3);
  assert.equal(review.submitted, 2);
  assert.equal(review.violators, 1);
  assert.equal(review.rows[0].violations[0].brief, "미적분Ⅰ 미이수(2-1에 미적분Ⅰ 없음)");
  assert.equal(review.rows[1].violations.length, 0);
  assert.equal(review.rows[2].violations.length, 0, "미제출 학생은 점검하지 않는다");
  // 현 2학년: 이전 학년 선택 과목(물리학) 근거가 없으면 '확인 불가'(위반 아님).
  const senior = ctx.courseCheckTeacherReview(data, "2");
  assert.equal(senior.violators, 0);
  assert.equal(senior.unknowns, 1);
  assert.equal(senior.rows[0].unknowns[0].brief, "물리학 이수 확인 불가(이전 학년 이수 결과 없음)");
  // 점검 정보 없이 만든 예전 이벤트: 계산하지 않는다.
  const legacy = ctx.courseCheckTeacherReview({ subjects: { "2": names.map((subject) => ({ subject })) }, groups: [], entries: data.entries }, "1");
  assert.equal(legacy.available, false);
  assert.equal(legacy.violators, 0);
  // 화면 연결: 신청 현황 패널(위계 경고만 필터·요약), 과목 변경 목록 표시. 서버 함수는 새로 부르지 않는다.
  const client = fs.readFileSync(path.join(root, "supabase-client.js"), "utf8");
  const panel = functionSource(client, "async function showApplicationStatusPanel(", "function codeLockStatus(");
  assert.match(panel, /rpc\("get_teacher_course_applications"/);
  assert.match(panel, /courseCheckTeacherReview\(data, grade\)/);
  assert.match(panel, / 위계 경고만/);
  assert.match(panel, /위계 경고 \$\{review\.violators\}명/);
  assert.doesNotMatch(panel, /rpc\("(?!get_teacher_course_applications)/);
  assert.match(client, /⚠ 위계 경고/);
});
