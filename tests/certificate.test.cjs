const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "src", "legacy.css"), "utf8");

function functionSource(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.notEqual(first, -1, `missing function marker ${start}`);
  assert.notEqual(last, -1, `missing function marker ${end}`);
  return source.slice(first, last);
}

function markupContext(values) {
  const ctx = vm.createContext({
    getApplicationGroupSettings: () => [],
    applicationGroupForCourse: () => null,
    resolveSemesterKey: () => "", resolveCourseCategoryForOutput: () => "과목",
    escapeHtml: (value) => String(value), applicationCourseLabel: String, isCoreCourse: () => false,
    $: (selector) => ({ value: values[selector] ?? "" })
  });
  vm.runInContext(functionSource(app, "function courseGroupLabel(", "function courseIndexByColumn("), ctx);
  vm.runInContext(functionSource(app, "function certificateGroupSettings(", "function renderPreview("), ctx);
  return ctx;
}

function student(count) {
  return { grade: "2", classroom: "3", number: "4", name: "홍길동", totalCredits: count * 4,
    selections: Array.from({ length: count }, (_, index) => ({ name: `과목${index + 1}`, credits: 4 })) };
}

test("the school name and confirmation date are not hard-coded", () => {
  assert.doesNotMatch(html, /천상고등학교/);
  assert.doesNotMatch(html, /value="\d{4}\. \d{1,2}\. \d{1,2}\."/);
  assert.match(html, /<input id="schoolName" type="text" value=""/);
  assert.match(html, /<input id="confirmDate" type="text" value=""/);
  assert.doesNotMatch(app, /천상고등학교/);
});

test("an empty school name prints a blank, not the word 학교명", () => {
  const ctx = markupContext({ "#schoolYear": "2026", "#round": "1차", "#confirmDate": "", "#schoolName": "  " });
  const markup = ctx.certificateMarkup(student(3), true, []);
  assert.doesNotMatch(markup, /학교명/);
  assert.match(markup, /<p class="paper-school">　+&nbsp; 귀하<\/p>/);
  assert.match(markup, /　　　년　　월　　일/);
  const named = markupContext({ "#schoolYear": "2026", "#round": "1차", "#confirmDate": "2026. 11. 6.", "#schoolName": "가나고등학교" })
    .certificateMarkup(student(3), true, []);
  assert.match(named, /가나고등학교&nbsp; 귀하/);
  assert.match(named, /2026\. 11\. 6\./);
});

test("the certificate shows the current grade and the applied grade on one line", () => {
  const ctx = markupContext({ "#schoolYear": "2026", "#round": "1차", "#confirmDate": "", "#schoolName": "학교" });
  const markup = ctx.certificateMarkup(student(3), true, []);
  assert.match(markup, /<span class="paper-student-grade">현 2학년 3반 4번 · 3학년 선택과목 신청<\/span>&nbsp;&nbsp; <span class="paper-student-name">홍길동<\/span>/);
  assert.doesNotMatch(markup, /2 학년&nbsp;/, "the old split label is gone");
  assert.equal((markup.match(/3학년 선택과목 신청/g) || []).length, 1, "the applied grade is written once");
  assert.equal(ctx.studentGradeLabel({ grade: "1", classroom: "10", number: "7" }), "현 1학년 10반 7번");
});

test("the closing lines stay together and long course lists print in a denser layout", () => {
  const ctx = markupContext({ "#schoolYear": "2026", "#round": "1차", "#confirmDate": "2026. 11. 6.", "#schoolName": "학교" });
  const closing = ctx.certificateMarkup(student(3), true, []);
  assert.match(closing, /<div class="paper-closing">[\s\S]*paper-total[\s\S]*paper-signature[\s\S]*paper-school[\s\S]*<\/div>\s*<\/div>\s*<\/article>/);
  assert.match(ctx.certificateMarkup(student(12), true, []), /class="print-page">/);
  assert.match(ctx.certificateMarkup(student(18), true, []), /class="print-page paper-compact"/);
  assert.match(ctx.certificateMarkup(student(30), true, []), /class="print-page paper-dense"/);
  assert.match(css, /\.print-page \.paper-closing \{ break-inside: avoid; page-break-inside: avoid; \}/);
  assert.match(css, /\.print-page\.paper-dense \.certificate-table td \{ height: 5\.4mm;/);
  assert.match(css, /@page \{ size: A4 portrait;/);
});

test("screen-only parts such as the toast and dialogs are hidden when printing", () => {
  const printBlock = css.slice(css.indexOf("@page { size: A4 portrait;"));
  assert.match(printBlock, /@media print \{[\s\S]*\.app-toast, dialog, dialog::backdrop \{ display: none !important; \}/);
  assert.doesNotMatch(printBlock.slice(0, printBlock.indexOf(".print-page {")), /min-height: 269mm/);
});

test("printing asks before printing a certificate without a school name or date", () => {
  const values = { "#schoolName": "", "#confirmDate": "2026. 11. 6." };
  const questions = [];
  let answer = false, prints = 0, opened = 0;
  const batch = { innerHTML: "" };
  const ctx = vm.createContext({
    $: (selector) => selector === "#printBatch" ? batch : { value: values[selector] },
    window: { confirm: (message) => { questions.push(message); return answer; }, print: () => { prints++; } },
    certificateGroupSettings: () => [],
    certificateMarkup: (item) => `<article>${item.name}</article>`,
    openCertificateInfoDialog: () => { opened++; }
  });
  vm.runInContext(functionSource(app, "function certificateTodayLabel(", "rosterInput.addEventListener("), ctx);
  assert.equal(ctx.certificateTodayLabel(new Date(2026, 8, 28)), "2026. 9. 28.");
  assert.deepEqual([...ctx.certificateMissingInfo(" ", "")], ["학교명", "확인 날짜"]);
  assert.deepEqual([...ctx.certificateMissingInfo("학교", "2026. 1. 2.")], []);

  ctx.printStudents([{ name: "가" }]);
  assert.equal(questions.length, 1);
  assert.match(questions[0], /학교명이 비어 있습니다/);
  assert.equal(prints, 0, "cancel stops printing");
  assert.equal(opened, 1, "cancel opens the basic info dialog");

  answer = true;
  ctx.printStudents([{ name: "가" }, { name: "나" }]);
  assert.equal(prints, 1, "confirm prints anyway");
  assert.equal(batch.innerHTML, "<article>가</article><article>나</article>");

  values["#schoolName"] = "가나고등학교";
  values["#confirmDate"] = "";
  ctx.printStudents([{ name: "가" }]);
  assert.match(questions.at(-1), /확인 날짜가 비어 있습니다/);

  values["#confirmDate"] = "2026. 11. 6.";
  const asked = questions.length;
  ctx.printStudents([{ name: "가" }]);
  assert.equal(questions.length, asked, "no question when both are filled");
  assert.equal(prints, 3);
});

test("an empty confirmation date is filled with today's date at start-up", () => {
  // 새 저장소(IndexedDB) 확인 뒤, 단계 그리기를 미룬 채(holdStepRenders) 복원한다. 날짜를 먼저 채우고 복원이 저장값으로 덮어쓰는 순서는 그대로.
  assert.match(app, /if \(!String\(\$\("#confirmDate"\)\.value \|\| ""\)\.trim\(\)\) \$\("#confirmDate"\)\.value = certificateTodayLabel\(\);\n(?:\s+\/\/[^\n]*\n)?\s+workspaceStartupBoot = beginWorkspaceStoreBoot\(\);\n(?:\s+\/\/[^\n]*\n)?\s+const restoreStartup = \(\) => restorePersistedState\(workspaceStartupBoot\?\.settingsRaw\);\n\s+if \(typeof holdStepRenders === "function"\) holdStepRenders\(restoreStartup\);\n\s+else restoreStartup\(\);/);
});

test("opening step 3 selects the first student in the list", () => {
  const values = { "#searchInput": "", "#classFilter": "", "#gradeFilter": "" };
  const students = [
    { id: "a", grade: "1", classroom: "1", number: "1", name: "가" },
    { id: "b", grade: "2", classroom: "1", number: "1", name: "나" }
  ];
  const ctx = vm.createContext({ state: { students, selectedId: null }, $: (selector) => ({ value: values[selector] }),
    renderRoster: () => {}, renderPreview: () => {} });
  vm.runInContext(functionSource(app, "function visibleStudents(", "function renderRoster("), ctx);
  vm.runInContext(functionSource(app, "function showFirstVisibleStudent(", "$(\"#gradeFilter\").addEventListener("), ctx);
  ctx.showFirstVisibleStudent();
  assert.equal(ctx.state.selectedId, "a");
  ctx.state.selectedId = "b";
  ctx.showFirstVisibleStudent();
  assert.equal(ctx.state.selectedId, "b", "a student the teacher picked stays selected");
  values["#gradeFilter"] = "1";
  ctx.showFirstVisibleStudent();
  assert.equal(ctx.state.selectedId, "a", "a filtered-out student is replaced by the first visible one");

  let shown = 0;
  const element = () => ({ classList: { toggle() {} }, setAttribute() {}, textContent: "" });
  const layout = vm.createContext({
    state: { workflowStep: 3 }, workflowSteps: { querySelectorAll: () => [] },
    renderCurriculumStep() {}, renderRoundStatus() {}, renderApplicationSubjects() {}, renderApplicationMode() {},
    renderWorkspaceContext() {}, workflowStepLabel: () => "3단계", $: element,
    showFirstVisibleStudent: () => { shown++; }
  });
  vm.runInContext(functionSource(app, "function renderWorkflowLayout(", "function workflowStepLabel("), layout);
  layout.renderWorkflowLayout();
  assert.equal(shown, 1);
  layout.state.workflowStep = 4;
  layout.renderClosurePanel = () => {}; layout.renderRetakePanel = () => {}; layout.renderAggregate = () => {};
  layout.renderWorkflowLayout();
  assert.equal(shown, 1, "other steps leave the selection alone");
  assert.match(app, /state\.selectedId = state\.students\[0\]\?\.id \|\| nextStudents\[0\]\.id;/,
    "a result import selects the first student of the sorted list");
});

test("the certificate basic info lives in a dialog with a one-line summary", () => {
  assert.match(html, /<button class="button certificate-info-button" id="openCertificateInfo" type="button" aria-haspopup="dialog"/);
  assert.match(html, /<span class="certificate-info-summary" id="certificateInfoSummary">/);
  const dialog = html.slice(html.indexOf('<dialog class="curriculum-subject-dialog certificate-info-dialog" id="certificateInfoDialog"'));
  assert.ok(dialog.length < html.length, "dialog exists");
  const body = dialog.slice(0, dialog.indexOf("</dialog>"));
  for (const id of ["certificateSchoolName", "confirmDate", "round", "certificateDateToday", "closeCertificateInfo"]) {
    assert.match(body, new RegExp(`id="${id}"`), id);
  }
  assert.doesNotMatch(html, /<h2 class="panel-heading">확인서 기본 정보<\/h2>/, "the old panel is gone");

  const summary = { children: [], replaceChildren(...items) { this.children = items; } };
  const values = { "#confirmDate": "2026. 11. 6.", "#schoolName": "" };
  const ctx = vm.createContext({
    $: (selector) => ({ value: values[selector] }),
    document: {
      getElementById: (id) => id === "certificateInfoSummary" ? summary : null,
      createElement: () => ({ className: "", textContent: "" })
    }
  });
  vm.runInContext(functionSource(app, "function renderCertificateInfoSummary(", "function syncPrintAllButton("), ctx);
  ctx.renderCertificateInfoSummary();
  const text = summary.children.map((item) => typeof item === "string" ? item : item.textContent).join("");
  assert.equal(text, "확인 날짜 2026. 11. 6. · 학교명 미입력");
  assert.match(summary.children[2].className, /is-missing/);
});

test("the student search understands 2학년, 3반, 1-3 and names", () => {
  const values = { "#searchInput": "", "#classFilter": "", "#gradeFilter": "" };
  const students = [
    { id: "a", grade: "1", classroom: "3", number: "5", name: "홍길동" },
    { id: "b", grade: "2", classroom: "13", number: "3", name: "김철수" },
    { id: "c", grade: "2", classroom: "3", number: "12", name: "이영희" }
  ];
  const ctx = vm.createContext({ state: { students }, $: (selector) => ({ value: values[selector] }) });
  vm.runInContext(functionSource(app, "function visibleStudents(", "function renderRoster("), ctx);
  const ids = (query) => { values["#searchInput"] = query; return ctx.visibleStudents().map((s) => s.id).join(","); };
  assert.equal(ids("2학년"), "b,c");
  assert.equal(ids("3반"), "a,c", "3반 does not match 13반");
  assert.equal(ids("1-3"), "a");
  assert.equal(ids("2-3-12"), "c");
  assert.equal(ids("2학년 3반"), "c");
  assert.equal(ids("길동"), "a");
  assert.equal(ids("3"), "a,b,c", "a bare number matches grade, class or number");
  assert.equal(ids("5번"), "a");
  assert.equal(ids(""), "a,b,c");
});

test("certificate groups follow semester → group order → plan order, not the order the student picked", () => {
  const ctx = markupContext({ "#schoolYear": "2026", "#round": "1차", "#confirmDate": "", "#schoolName": "학교" });
  const groups = [
    { grade: "3", semester: "1", name: "3-1 택1", courses: ["미적분Ⅱ", "기하"] },
    { grade: "3", semester: "1", name: "3-1 택5", courses: ["물리학", "화학", "생명과학", "지구과학", "세계사", "경제"] },
    { grade: "3", semester: "2", name: "3-2 택1", courses: ["확률과 통계", "인공지능 수학"] },
    { grade: "3", semester: "2", name: "3-2 택5", courses: ["정치", "법과 사회", "윤리와 사상"] }
  ];
  const groupOf = (name) => groups.find((group) => group.courses.includes(name));
  ctx.applicationGroupForCourse = (course) => { const group = groupOf(course.name); return group ? { name: group.name, semester: group.semester } : null; };
  ctx.courseGroupLabel = (course) => { const group = groupOf(course.name); return `${group.semester}학기 ${group.name}`; };
  // 웹 신청 순서: 2학기 택1 → 1학기 택1 → 2학기 택5 → 1학기 택5, 묶음 안도 뒤섞임
  const picked = ["인공지능 수학", "기하", "윤리와 사상", "정치", "경제", "물리학", "세계사", "화학", "지구과학"];
  const student = { grade: "2", classroom: "1", number: "1", name: "가명", totalCredits: 30, selections: picked.map((name) => ({ name, credits: 3 })) };
  const ordered = JSON.parse(JSON.stringify(ctx.certificateGroupedSelections(student, groups)));
  assert.deepEqual(ordered.map((group) => group.name), ["1학기 3-1 택1", "1학기 3-1 택5", "2학기 3-2 택1", "2학기 3-2 택5"]);
  assert.deepEqual(ordered[1].courses.map((course) => course.name), ["물리학", "화학", "지구과학", "세계사", "경제"]);
  assert.deepEqual(ordered[3].courses.map((course) => course.name), ["정치", "윤리와 사상"]);
  const markup = ctx.certificateMarkup(student, true, groups);
  assert.ok(markup.indexOf("기하") < markup.indexOf("물리학") && markup.indexOf("물리학") < markup.indexOf("인공지능 수학"));
});

test("certificate course names drop the two-semester tag because the group column already shows the semester", () => {
  const ctx = markupContext({ "#schoolYear": "2026", "#round": "1차", "#confirmDate": "", "#schoolName": "학교" });
  ctx.applicationCourseLabel = (subject) => `${subject.subject}(${subject.kind})`;
  assert.equal(ctx.certificateCourseName({ applicationSubject: { subject: "과학의 역사와 문화 (2학기)", kind: "융합" } }), "과학의 역사와 문화(융합)");
  assert.equal(ctx.certificateCourseName({ name: "물리학" }), "물리학");
});
