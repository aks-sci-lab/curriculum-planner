const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((source) => source.trim());
const frontend = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const workbookParser = fs.readFileSync(path.join(__dirname, "..", "xlsx-parser.js"), "utf8");
function functionSource(start, end) {
  return frontend.slice(frontend.indexOf(start), frontend.indexOf(end));
}
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("closure defaults open eligible courses and leave at-risk courses undecided, preserving manual decisions", () => {
  // 개설/폐강 결정은 학교 양식 집계표의 과목명 메뉴에 있다(별도 개설/폐강 검토 표 없음). 과목 머리 칸이 지금 결정을 들고 있다.
  const ctx = vm.createContext({ $: () => ({ value: "" }), state: {}, escapeHtml: String });
  vm.runInContext(functionSource("function aggregateThresholds(", "function renderAggregate("), ctx);
  vm.runInContext(functionSource("function xmlEscape(", "function createStylesXml("), ctx);
  const course = (column, name, enrollment, atRisk, classCount = 1) => ({ column, name, enrollment, atRisk, closed: false, classCount,
    enrollmentPerDivision: 1, averageClassSize: classCount ? enrollment / classCount : 0 });
  const report = { summary: { grade: "1", students: 350, classes: 10, classSource: "roster", averageClassSize: 35, openingLimit: 31.5, divisionLimit: 38.5 },
    semesters: [{ name: "2학년 1학기", groups: [{ category: "2-1 택1", choiceCount: 1, totalClasses: 5, courses: [
      course(1, "개설기준 일치", 31.5, false),
      course(2, "미달", 5, true),
      course(3, "수동 미정", 100, false, 3),
      course(4, "수동 폐강", 100, false, 3),
      course(5, "수동 개설", 5, true)
    ] }] }] };
  const closures = { "1:3": "", "1:4": "closed", "1:5": "open" };
  const options = { closures, round: "1", locked: false, maxClassSize: 34, attentionOnly: false, canUndo: false, openingPercent: 90, divisionPercent: 110 };
  const decisions = (markup) => [...markup.matchAll(/data-aggregate-course="([^"]+)" data-closure-round="1" data-decision="([^"]*)"/g)]
    .map((match) => [match[1], match[2]]);
  // '처리할 것만'에서 강조하는 과목(과목 머리 칸에 is-attention)
  const focused = (markup) => [...markup.matchAll(/<td class="[^"]*\bis-attention\b[^"]*"[^>]*><button type="button" class="af-course" data-aggregate-course="([^"]+)"/g)]
    .map((match) => match[1]);
  const markup = ctx.aggregateGradeSectionMarkup(report, options);
  assert.deepEqual(decisions(markup), [["1:1", "open"], ["1:2", ""], ["1:3", ""], ["1:4", "closed"], ["1:5", "open"]]);
  // 미정인 과목은 과목명이 빨간 글자(is-undecided), 기준 미달은 인원 수 칸 모서리에 '미달' 표시(누르면 설명 메뉴).
  assert.match(markup, /<td class="[^"]*\bis-undecided\b[^"]*"[^>]*><button type="button" class="af-course" data-aggregate-course="1:2"/);
  assert.match(markup, /data-aggregate-course-info="1:2" title="기준 미달: 신청 5명이 개설기준 31\.50명보다 적습니다/);
  assert.doesNotMatch(markup, /<td class="[^"]*\bis-undecided\b[^"]*"[^>]*><button type="button" class="af-course" data-aggregate-course="1:5"/);
  // 미달이어도 '개설'로 정한 과목은 빨간 '미달' 대신 결정 표시(파란 '미달·개설'), 빨간 글자(is-risk)도 없음.
  assert.match(markup, /class="af-tag is-decided" data-aggregate-course-info="1:5"[^>]*>미달·개설</);
  assert.match(markup, /class="af-tag is-risk" data-aggregate-course-info="1:2"[^>]*>미달</);
  assert.doesNotMatch(markup, /<td class="[^"]*\bis-risk\b[^"]*"[^>]*><button type="button" class="af-course" data-aggregate-course="1:5"/);
  assert.equal(focused(markup).length, 0, "attention marks only in 'attention only' mode");
  // 처리할 것만 보기: 결정이 미정인 기준 미달 과목만 강조되고, 이미 개설/폐강을 정한 과목과 기준을 충족한 과목은 흐리게 남는다.
  // 목표(택1 × 10학급 = 10)와 맞지 않는 그룹의 총 학급수 칸은 연한 주황 + 목표와 차이 + 강조 + 자동 조정 단추.
  // 총 학급수는 엑셀과 같이 과목 개설 학급수의 합(1+1+3+3+1 = 9)이다.
  const attention = ctx.aggregateGradeSectionMarkup(report, { ...options, attentionOnly: true });
  assert.deepEqual(focused(attention), ["1:2"]);
  assert.match(attention, /<td class="[^"]*\baf-off\b[^"]*\bis-attention\b[^"]*"[^>]*data-af-role="total"><span class="af-total-value">9<\/span><span class="af-total-target">목표 10 \(-1\)<\/span><button type="button" class="af-mini-button" data-aggregate-adjust="group" data-grade="1" data-semester="2학년 1학기" data-group="2-1 택1" aria-label="2-1 택1 학급수 자동 조정">/);
  assert.match(attention, /<td class="[^"]*\bis-dimmed\b[^"]*"[^>]*><button type="button" class="af-course" data-aggregate-course="1:1"/, "settled courses stay, dimmed");
  assert.match(attention, />2-1 택1</);
  assert.equal(ctx.aggregateAttention(report, closures, 34).count, 2, "one undecided at-risk course and one group off target");
  // 학급수를 직접 줄여 학급당 인원이 최대 인원·분반 기준을 넘으면 그 과목도 처리할 것에 들어가고 학급당 칸 모서리에 경고가 붙는다.
  report.semesters[0].groups[0].courses[2] = course(3, "수동 미정", 100, false, 2);
  const crowded = ctx.aggregateGradeSectionMarkup(report, { ...options, attentionOnly: true });
  assert.deepEqual(focused(crowded), ["1:2", "1:3"]);
  assert.match(crowded, /data-aggregate-course-info="1:3" title="[^"]*34명 초과: 학급당 50\.0명[^"]*분반기준 초과[^"]*">34명 초과<\/button>/);
  // 목표와 맞고 처리할 과목이 없는 그룹은 통째로 사라지고 빈 안내가 나온다.
  const settled = { summary: report.summary, semesters: [{ name: "2학년 1학기", groups: [{ category: "2-1 택1", choiceCount: 1, totalClasses: 10, courses: [
    course(1, "충족", 40, false, 10)] }] }] };
  const settledMarkup = ctx.aggregateGradeSectionMarkup(settled, { ...options, attentionOnly: true });
  assert.match(settledMarkup, /처리할 과목이 없습니다/);
  assert.doesNotMatch(settledMarkup, /data-aggregate-course=/);
  // 확정된 차수는 개설 학급수 칸과 결정 메뉴(과목 머리 칸의 data-locked)가 잠긴다.
  const lockedMarkup = ctx.aggregateGradeSectionMarkup(report, { ...options, locked: true });
  assert.equal(lockedMarkup.match(/<input class="aggregate-class-input[^>]* disabled/g).length, 5);
  assert.equal(lockedMarkup.match(/data-aggregate-course="[^"]+"[^>]* data-locked/g).length, 5);
  assert.doesNotMatch(markup, /data-locked/);
  assert.match(frontend, /state\.roundClosures\[round\]\[key\] = value/);
});

test("closure menu saves the teacher decision, refuses a confirmed round and keeps focus on the course", () => {
  let locked = false;
  const calls = [];
  const focused = [];
  const state = { roundClosures: {}, workflowStep: 4 };
  const ctx = vm.createContext({
    state, isRoundLocked: () => locked, persistStateSoon: () => calls.push("persist"), renderAggregate: () => calls.push("render"),
    renderRetakePanel: () => calls.push("retake"), updateRetakeReadiness: () => calls.push("ready"),
    document: { querySelectorAll: () => [{ dataset: { aggregateCourse: "2:b" }, focus: () => focused.push("2:b") }] }
  });
  vm.runInContext(functionSource("function setAggregateClosure(", "function renderRoundStatus("), ctx);
  assert.equal(ctx.setAggregateClosure("1", "2:b", "closed"), true);
  assert.deepEqual(plain(state.roundClosures), { "1": { "2:b": "closed" } });
  assert.deepEqual(calls, ["persist", "render", "retake", "ready"]);
  assert.deepEqual(focused, ["2:b"]);
  assert.equal(ctx.setAggregateClosure("1", "2:b", ""), true, "미정으로 되돌릴 수 있다");
  assert.equal(state.roundClosures["1"]["2:b"], "");
  assert.equal(ctx.setAggregateClosure("1", "2:b", "maybe"), false, "알 수 없는 값은 무시");
  locked = true;
  calls.length = 0;
  assert.equal(ctx.setAggregateClosure("1", "2:b", "open"), false);
  assert.equal(state.roundClosures["1"]["2:b"], "", "확정된 차수는 바꾸지 않는다");
  assert.deepEqual(calls, ["render"]);
});

class Sheet {
  constructor(name) { this.name = name; this.rows = []; }
  setName(name) { this.name = name; return this; }
  appendRow(row) { this.rows.push(row); return this; }
  getDataRange() {
    return {
      getValues: () => this.rows.map((r) => [...r]),
      getDisplayValues: () => this.rows.map((r) => r.map(String)),
    };
  }
  getRange(row, col) {
    const set = (values) => {
      values.forEach((r, i) => {
        this.rows[row - 1 + i] ??= [];
        r.forEach((value, j) => { this.rows[row - 1 + i][col - 1 + j] = value; });
      });
      return range;
    };
    const range = {
      setNumberFormat: () => range,
      setValues: set,
      setValue: (value) => set([[value]]),
      getValue: () => this.rows[row - 1]?.[col - 1],
    };
    return range;
  }
}

function server() {
  const properties = new Map();
  const books = new Map();
  let locks = 0;
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key) => properties.get(key),
      setProperty: (key, value) => properties.set(key, value),
    }) },
    Utilities: { getUuid: randomUUID },
    Logger: { log() {} },
    LockService: { getScriptLock: () => ({
      waitLock() { locks++; }, releaseLock() { locks--; },
    }) },
    SpreadsheetApp: {
      create() {
        const id = String(books.size);
        const sheets = [new Sheet("Sheet1")];
        const book = {
          getId: () => id, getUrl: () => "https://example.invalid/" + id,
          getSheets: () => sheets,
          getSheetByName: (name) => sheets.find((s) => s.name === name),
          insertSheet(name) { const s = new Sheet(name); sheets.push(s); return s; },
        };
        books.set(id, book);
        return book;
      },
      openById: (id) => books.get(id),
    },
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: "ALLOWALL" },
      createHtmlOutput: (content) => ({
        content, frameMode: "DEFAULT",
        setXFrameOptionsMode(mode) { this.frameMode = mode; return this; },
      }),
    },
  });
  vm.runInContext(scripts[0], context);
  context.initializeCourseServer();
  return { context, key: properties.get("ADMIN_KEY"), properties, books, locks: () => locks };
}
function setup() {
  return {
    type: "course-application-setup", round: "2", schoolName: "가상학교", schoolYear: "2026",
    roster: [
      { grade: "1", classroom: "1", number: "1", name: "가상학생1" },
      { grade: "2", classroom: "2", number: "2", name: "가상학생2" },
    ],
    subjects: {
      "1": [],
      "2": [{ subject: "수학", credit: 3, semester: "1" }],
      "3": [{ subject: "과학", credit: 3, semester: "2" }],
    },
  };
}

test("cohort cards remain while curriculum table has no 택n group creation controls", () => {
  assert.match(html, /id="curriculumCohortUploads"/);
  assert.doesNotMatch(html, /id="curriculumCohortYear"|id="curriculumGroupCreator"/);
  assert.match(frontend, /const cells = \[\]/);
  assert.doesNotMatch(frontend, /curriculumColorGroupsForAllSemesters|data-curriculum-color-group|createApplicationGroupFromCurriculum|선택과목군 이름을 입력하세요/);
  assert.doesNotMatch(frontend, /curriculumGroupCreator|curriculumSelectionGroupDraft|curriculumGroupCourseOptions/);
});

test("all embedded scripts parse", () => {
  scripts.forEach((source) => new vm.Script(source));
  new vm.Script(frontend);
  new vm.Script(workbookParser);
});

test("roster supports aliases, sheet grades and multiple sheets", () => {
  const ctx = vm.createContext({});
  vm.runInContext(functionSource("function parseApplicationRoster(", "function downloadTextFile("), ctx);
  const result = ctx.parseApplicationRoster([
    { name: "명렬", rows: [["학년", "반", "번호", "성명"], [1, 2, 3, "가상학생1"], []] },
    { name: "2학년", rows: [["반", "출석번호", "학생명"], [2, 4, "가상학생2"]] },
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(plain(result[1]), { grade: "2", classroom: "2", number: "4", name: "가상학생2" });
  assert.throws(() => ctx.parseApplicationRoster([
    { name: "명렬", rows: [["학년", "반", "번호", "이름"], [1, 1, 1, "A"], [1, 1, 1, "B"]] },
  ]), /중복/);
  for (const grade of ["", "3", "잘못된값"]) {
    assert.throws(() => ctx.parseApplicationRoster([
      { name: "명렬", rows: [["학년", "반", "번호", "이름"], [grade, 1, 1, "A"]] },
    ]), /현재 학년/);
  }
  assert.throws(() => ctx.parseApplicationRoster([
    { name: "명렬", rows: [["학년", "반", "번호", "성명"], []] },
  ]), /찾지 못/);
});

test("roster parser accepts ten synthetic classes of 35 students", () => {
  const ctx = vm.createContext({});
  vm.runInContext(functionSource("function parseApplicationRoster(", "function downloadTextFile("), ctx);
  const sheets = Array.from({ length: 10 }, (_, classIndex) => ({
    name: `${classIndex + 1}반`,
    rows: [
      ["학년", "반", "번호", "이름"],
      ...Array.from({ length: 35 }, (_, numberIndex) => [
        "1", String(classIndex + 1), String(numberIndex + 1),
        `테스트학생${String(classIndex + 1).padStart(2, "0")}-${String(numberIndex + 1).padStart(2, "0")}`,
      ]),
    ],
  }));
  const roster = ctx.parseApplicationRoster(sheets);
  assert.equal(roster.length, 350);
  assert.deepEqual([...new Set(roster.map((student) => student.classroom))],
    Array.from({ length: 10 }, (_, index) => String(index + 1)));
  for (let classroom = 1; classroom <= 10; classroom++) {
    assert.equal(roster.filter((student) => student.classroom === String(classroom)).length, 35);
  }
  assert.equal(new Set(roster.map((student) => `${student.grade}:${student.classroom}:${student.number}`)).size, 350);
});

test("application roster validation rejects wrong or mixed current grades", () => {
  const ctx = vm.createContext({});
  vm.runInContext(functionSource("function validateApplicationRosterGrade(", "function downloadTextFile("), ctx);
  const first = [{ grade: "1" }];
  const second = [{ grade: "2" }];
  assert.equal(ctx.validateApplicationRosterGrade(first, "1"), first);
  assert.equal(ctx.validateApplicationRosterGrade(second, "2"), second);
  assert.throws(() => ctx.validateApplicationRosterGrade(second, "1"), /2학년 수강신청에는 현재 1학년 명렬만/);
  assert.throws(() => ctx.validateApplicationRosterGrade(first, "2"), /3학년 수강신청에는 현재 2학년 명렬만/);
  assert.throws(() => ctx.validateApplicationRosterGrade([...first, ...second], "1"), /포함되어/);
  assert.throws(() => ctx.validateApplicationRosterGrade([], "1"), /비어/);
});

test("curriculum management shows three cohort plans and a separate annual whole-school plan", () => {
  const elements = {
    "#schoolYear": { value: "2026" },
    "#curriculumCohortUploads": {},
  };
  const ctx = vm.createContext({
    $: (id) => elements[id], escapeHtml: String,
    CURRICULUM_COHORT_GRADES: ["0", "1", "2", "3"],
    state: { curriculumCohortYear: "2026", curriculumPlanType: "cohort", curriculumPlanFileName: "2026.xlsx",
      curriculumPlan: [],
      curriculumCohorts: { "2025": { fileName: "2025.xlsx" } },
      curriculumAnnualPlans: { "2026": { fileName: "전학년.xlsx" } } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "curriculum-annual.js"), "utf8"), ctx);
  vm.runInContext(functionSource("const annualResolvedCache", "function isDerivedAnnualPlan("), ctx);
  vm.runInContext(functionSource("function renderCurriculumCohortUploads(", "function syncActiveCurriculumCohort("), ctx);
  ctx.renderCurriculumCohortUploads();
  const markup = elements["#curriculumCohortUploads"].innerHTML;
  assert.deepEqual([...markup.matchAll(/data-cohort-upload="(\d+)"/g)].map((match) => match[1]), ["2027", "2026", "2025", "2024"]);
  assert.deepEqual([...markup.matchAll(/data-annual-build="(\d+)"/g)].map((match) => match[1]), ["2026"]);
  assert.doesNotMatch(markup, /data-annual-upload/, "the annual plan is built, never uploaded");
  assert.match(markup, /2024학년도 입학생 · 현 3학년/);
  assert.match(markup, /3개년 편제표에서 자동 생성/);
  assert.match(markup, /2027학년도 입학생 · 내년도 신입생/);
  assert.match(markup, /내년도 1학년 시수 통계용/);
  assert.match(markup, /현 1학년은 이 편제표의 2학년 과목으로 신청/);
  assert.match(markup, /현 2학년은 이 편제표의 3학년 과목으로 신청/);
  assert.match(markup, /2026.xlsx/);
  assert.match(markup, /2025.xlsx/);
  assert.match(markup, /3학년 2024 미업로드/);
  assert.match(markup, /data-annual-build="2026" disabled/, "building needs all three cohort plans");
  // 좁은 카드에서도 읽히게 짧게: '3학년(2024) 편제표 필요'(여러 개면 '2·3학년(2025·2024) …')
  assert.match(markup, />1·2·3학년\(2026·2025·2024\) 편제표 필요</);
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "legacy.css"), "utf8");
  assert.match(css, /\.curriculum-cohort-card p \{ white-space: normal; display: -webkit-box; -webkit-line-clamp: 2;/);
  assert.match(css, /\.curriculum-cohort-card > p:not\(\.curriculum-cohort-file\) \{ -webkit-line-clamp: 3; \}/, "편제 점검 단추 옆 부제는 세 줄까지");
  assert.match(css, /\.curriculum-cohort-card > \.curriculum-cohort-file \{ overflow-wrap: anywhere; word-break: break-all;/, "파일 이름은 글자 단위로 줄바꿈");
  assert.match(markup, /<p title="수강신청: 3학년 과목 기준 · 현 2학년은 이 편제표의 3학년 과목으로 신청">수강신청: 3학년 과목 기준<\/p>/, "부제 title에 보이는 글자도");
  elements["#schoolYear"].value = "2027";
  ctx.renderCurriculumCohortUploads();
  assert.deepEqual([...elements["#curriculumCohortUploads"].innerHTML.matchAll(/data-cohort-upload="(\d+)"/g)]
    .map((match) => match[1]), ["2028", "2027", "2026", "2025"]);
  assert.match(elements["#curriculumCohortUploads"].innerHTML, /2027학년도 전학년 편제표/);
});

test("application cohort lookup is exposed for semester-group storage", () => {
  const ctx=vm.createContext({
    state:{applicationMenuGrade:"1",curriculumCohortYear:"2026"},
    $:(selector)=>({value:selector==="#schoolYear"?"2027":""})
  });

  test("curriculum hour summaries omit unassigned semesters but retain assigned zero-credit warnings", () => {
    const ctx = vm.createContext({
      CURRICULUM_SEMESTER_FIELDS: ["sem11", "sem12", "sem21", "sem22", "sem31", "sem32"],
      escapeHtml: String
    });
    vm.runInContext(functionSource("function curriculumSemesterHoursSummaryHtml(", "function importedPlanCoveredCells("), ctx);
    const markup = ctx.curriculumSemesterHoursSummaryHtml([
      { item: { sem11: "●", opCredit: 3 } },
      { item: { sem12: "●", opCredit: 0 } }
    ], "1");
    assert.match(markup, /1-1 · 3시간/);
    assert.match(markup, /1-2 · 0시간/);
    assert.doesNotMatch(markup, /2-1|2-2|3-1|3-2/);
    assert.equal((markup.match(/class="curriculum-hours-item"/g) || []).length, 2);
  });
  const source=functionSource("function applicationCohortYear(", "function renderCurriculumCohortUploads(");
  assert.match(source,/getApplicationCohortYear = applicationCohortYear;/);
  vm.runInContext(`var getApplicationCohortYear; ${source}`,ctx);
  assert.equal(ctx.getApplicationCohortYear("1"),"2027");
  assert.equal(ctx.getApplicationCohortYear("2"),"2026");
});

test("switching cohort and annual plans keeps their records separate", () => {
  let schoolYear = "2026";
  const state = {
    curriculumCohortYear: "2026", curriculumPlanType: "cohort", curriculumPlanFileName: "2026.xlsx",
    curriculumImportedLayout: { year: "2026" }, curriculumPlan: [{ subject: "2026 과목" }],
    curriculumTemplateRows: [], curriculumMutationRevision: 0, curriculumCohorts: {},
    curriculumAnnualPlans: {},
  };
  const ctx = vm.createContext({
    state, status: { style: {} }, $: (selector) => selector === "#schoolYear" ? { value: schoolYear } : {},
    CURRICULUM_COHORT_GRADES: ["0", "1", "2", "3"],
    renderCurriculumStep() {}, renderApplicationSubjects() {}, renderWorkspaceContext() {}, persistState() {}, curriculumSearchTimer: null,
  });
  vm.runInContext(functionSource("function syncActiveCurriculumCohort(", "function collectApplicationSubjects("), ctx);
  for (const year of ["2027", "2025"]) {
    ctx.switchCurriculumCohort(year);
    assert.equal(state.curriculumImportedLayout, null);
    state.curriculumPlanFileName = `${year}.xlsx`;
    state.curriculumImportedLayout = { year };
    state.curriculumPlan = [{ subject: `${year} 과목` }];
  }
  ctx.switchCurriculumCohort("2026");
  ctx.switchCurriculumAnnualPlan("2026");
  assert.equal(state.curriculumPlanType, "cohort", "an annual plan that was never built cannot be opened");
  assert.match(ctx.status.textContent, /먼저 만드세요/);
  state.curriculumAnnualPlans["2026"] = { fileName: "2026 전학년.xlsx", importedLayout: { year: "2026", scope: "annual" },
    templateRows: [], plan: [{ subject: "전학년 과목" }] };
  ctx.switchCurriculumAnnualPlan("2026");
  assert.equal(state.curriculumPlanType, "annual");
  ctx.switchCurriculumCohort("2025");
  assert.deepEqual(Object.keys(state.curriculumCohorts).sort(), ["2025", "2026", "2027"]);
  assert.equal(state.curriculumAnnualPlans["2026"].fileName, "2026 전학년.xlsx");
  for (const year of ["2026", "2025", "2027"]) {
    ctx.switchCurriculumCohort(year);
    assert.equal(state.curriculumPlanFileName, `${year}.xlsx`);
    assert.equal(state.curriculumImportedLayout.year, year);
    assert.equal(state.curriculumPlan[0].subject, `${year} 과목`);
  }
  ctx.switchCurriculumAnnualPlan("2026");
  assert.equal(state.curriculumPlanType, "annual");
  assert.equal(state.curriculumImportedLayout.scope, "annual");
  assert.equal(state.curriculumPlan[0].subject, "전학년 과목");
  schoolYear = "2027";
  ctx.switchCurriculumAnnualPlan("2027");
  assert.equal(state.curriculumAnnualPlans["2026"].plan[0].subject, "전학년 과목");
  assert.equal(state.curriculumAnnualPlans["2027"], undefined, "a new school year starts without a built annual plan");
});

test("application subjects include student-choice courses in promoted grades and color-tagged courses without hours", () => {
  const course = (subject, division, hours, grade = "", rowIndex = -1) => ({
    subject, division, row: [3, ...hours], grade, area: "교과", selectionType: "일반선택", rowIndex,
  });
  const contexts = [
    course("학교지정", "학교 지정 교육과정", ["", "", 3, "", "", ""]),
    course("수학", "학생 선택 교육과정", ["", "", 3, 3, "", ""]),
    course("과학", "학생선택교육과정", ["", "", "", "", 3, ""]),
    course("색상과목", "학생 선택 교육과정", ["", "", "", "", "", ""], "", 7),
    course("현재학년", "학생 선택 교육과정", [3, "", "", "", "", ""]),
    course("미편제", "학생 선택 교육과정", ["", "", 0, "-", "", ""], "2"),
    course("구분없음", "", ["", "", 3, "", "", ""]),
    // 교차집중(학급마다 학기를 엇갈려 이수)은 학생이 고르는 과목이 아니므로 신청 과목에서 뺀다.
    course("음악 연주, 미술 창작", "학생 선택 교육과정", ["", "", 3, 3, "", ""], "", 9),
  ];
  const ctx = vm.createContext({
    state: { curriculumCohortYear: "2026", curriculumImportedLayout: { planData: { subjects: [{ id: "s9", row: 9, cross: ["sem21", "sem22"] }] } },
      applicationExcluded: { "2:수학": true } },
    importedPlanColumnMap: () => ({ subject: 0, opCredit: 0, baseCredit: -1, semesters: [1, 2, 3, 4, 5, 6] }),
    importedPlanCourseContexts: () => contexts,
    curriculumCellFill: (_layout, rowIndex, column) => rowIndex === 7 && column === 3 ? "#FFFF00" : "",
    curriculumColorGroupOptions: (_layout, grade, semester) =>
      grade === "2" && semester === "1" ? [{ fill: "#FFFF00", courses: ["색상과목"] }] : [],
  });
  vm.runInContext(functionSource("function collectApplicationSubjects(", "function renderApplicationSubjects("), ctx);
  const result = plain(ctx.selectedApplicationSubjects());
  assert.deepEqual(result["1"], []);
  assert.deepEqual(result["2"].map((c) => c.subject), ["수학", "색상과목"]);
  assert.equal(result["2"][0].semester, "1·2");
  assert.equal(result["2"][1].semester, "1");
  assert.equal(result["2"][1].semesterColors["1"], "#FFFF00");
  assert.deepEqual(result["3"].map((c) => c.subject), ["과학"]);
});

test("application subjects are read from the curriculum cohort matching the current student grade", () => {
  const contexts = {
    2026: [{ subject:"2026코호트 2학년 과목", division:"학생 선택 교육과정",
      row:[3,"", "",3,"","",""], grade:"2", area:"과학", selectionType:"일반선택" }],
    2025: [{ subject:"2025코호트 3학년 과목", division:"학생 선택 교육과정",
      row:[3,"","","","","",3], grade:"3", area:"과학", selectionType:"일반선택" }],
  };
  const state = { curriculumCohortYear:"2026", curriculumCohorts:{
    2026:{importedLayout:{year:"2026"}}, 2025:{importedLayout:{year:"2025"}}
  }, curriculumImportedLayout:{year:"2026"}, applicationMenuGrade:"1" };
  const ctx = vm.createContext({
    state, $:()=>({value:"2026"}),
    importedPlanColumnMap:()=>({subject:0,opCredit:0,baseCredit:-1,semesters:[1,2,3,4,5,6]}),
    importedPlanCourseContexts:(layout)=>contexts[layout.year],
    curriculumCellFill:()=>""
  });
  vm.runInContext(functionSource("function collectApplicationSubjects(", "function renderApplicationSubjects("),ctx);
  assert.deepEqual(plain(ctx.collectApplicationSubjects())["2"].map((item)=>item.subject),["2026코호트 2학년 과목"]);
  state.curriculumPlanType = "annual";
  state.curriculumImportedLayout = { year:"2026", scope:"annual" };
  assert.deepEqual(plain(ctx.collectApplicationSubjects())["2"].map((item)=>item.subject),["2026코호트 2학년 과목"]);
  state.applicationMenuGrade="2";
  assert.deepEqual(plain(ctx.collectApplicationSubjects())["3"].map((item)=>item.subject),["2025코호트 3학년 과목"]);
  delete state.curriculumCohorts["2025"];
  assert.equal(ctx.collectApplicationSubjects(), null, "A missing incoming cohort must not use the visible 2026 plan");
  state.curriculumCohorts = {};
  assert.equal(ctx.collectApplicationSubjects(), null, "An empty cohort collection must not bypass the incoming year");
});

test("2027 and 2028 applications use their incoming cohort's promoted-grade courses", () => {
  for (const year of [2027, 2028]) {
    const state = { curriculumCohortYear: String(year), curriculumImportedLayout: { year },
      curriculumCohorts: Object.fromEntries([year, year - 1, year - 2].map((incoming) =>
        [incoming, { importedLayout: { year: incoming } }])), applicationMenuGrade: "1" };
    const ctx = vm.createContext({
      state, $: () => ({ value: String(year) }),
      importedPlanColumnMap: () => ({subject:0,opCredit:0,semesters:[1,2,3,4,5,6]}),
      importedPlanCourseContexts: (layout) => [2,3].map((grade) => ({
        subject: `${layout.year} 입학생 ${grade}학년 과목`, division: "학생 선택 교육과정",
        grade:String(grade),area:"과학",selectionType:"일반선택",
        row:[3,...Array.from({length:6},(_,index)=>index===(grade-1)*2?3:"")],
      })), curriculumCellFill: () => "",
    });
    vm.runInContext(functionSource("function collectApplicationSubjects(", "function renderApplicationSubjects("), ctx);
    assert.equal(ctx.collectApplicationSubjects()["2"][0].subject, `${year} 입학생 2학년 과목`);
    state.applicationMenuGrade = "2";
    assert.equal(ctx.collectApplicationSubjects()["3"][0].subject, `${year-1} 입학생 3학년 과목`);
  }
});
test("color-tag semester detection remains scoped to each of the four selectable grade semesters", () => {
  const rows = [
    ["", "", "택2", "", "", ""], ["", "", "", "", "", ""],
    ["", "", "", "택2", "", ""], ["", "", "", "", "", ""],
    ["", "", "", "", "택2", ""], ["", "", "", "", "", ""],
    ["", "", "", "", "", "택2"], ["", "", "", "", "", ""],
  ];
  const fills = { "0:2": "#111111", "1:2": "#111111", "2:3": "#222222", "3:3": "#222222",
    "4:4": "#333333", "5:4": "#333333", "6:5": "#444444", "7:5": "#444444" };
  const subjects = ["2-1과목", "2-2과목", "3-1과목", "3-2과목"];
  const contextRows = subjects.map((subject, index) => ({
    subject, division: "학생 선택 교육과정", selectionType: "일반선택",
    rowIndex: index * 2 + 1, row: [],
  }));
  const ctx = vm.createContext({
    importedPlanColumnMap: () => ({ semesters: [-1, -1, 2, 3, 4, 5] }),
    expandCurriculumLayoutRows: (layout) => layout.rows,
    curriculumCellFill: (layout, rowIndex, columnIndex) => layout.fills[`${rowIndex}:${columnIndex}`] || "",
    importedPlanCourseContexts: () => contextRows,
    normalizeCurriculumDivision: (value) => value,
    isSelectableDetail: () => true,
  });
  vm.runInContext(functionSource("function curriculumColorGroupOptions(", "function aggregateRecords("), ctx);
  const layout = { rows, fills };
  const groups = [
    ["2", "1"], ["2", "2"], ["3", "1"], ["3", "2"],
  ].map(([grade, semester]) => ({
    grade, semester,
    courses: plain(ctx.curriculumColorGroupOptions(layout, grade, semester)).flatMap(({ courses }) => courses),
  }));
  assert.deepEqual(groups, [
    { grade: "2", semester: "1", courses: ["2-1과목"] },
    { grade: "2", semester: "2", courses: ["2-2과목"] },
    { grade: "3", semester: "1", courses: ["3-1과목"] },
    { grade: "3", semester: "2", courses: ["3-2과목"] },
  ]);
});

test("merged subject header uses actual course names and splits course lists by promoted semester", () => {
  const layout = {
    rows: [
      ["구분", "교과(군)", "세부과목", "", "기준학점", "운영학점", "1학년", "", "2학년", "", "3학년", ""],
      ["", "", "", "", "", "", "1학기", "2학기", "1학기", "2학기", "1학기", "2학기"],
      ["학교 지정 교육과정", "국어", "일반", "문학", 4, 4, "", "", 4],
      ["학생 선택\n교육과정", "사회", "일반", "세계사, 사회와 문화", 4, 4, "", "", "택3"],
      ["", "과학", "일반", "물리학, 화학", 4, 4, "", "", 4],
      ["", "영어", "융합", "미디어 영어, 세계 문화와 영어", 4, 4, "", "", "", 4],
      ["", "과학", "융합", "물리학 실험＊", 4, 3, "2학년/1,2학기/3학점"],
      ["", "국어", "진로", "주제 탐구 독서", 4, 4, "", "", "", "", "", 4],
    ],
    mergedRanges: ["A1:A2", "B1:B2", "C1:D2", "E1:E2", "F1:F2",
      "G1:H1", "I1:J1", "K1:L1", "A4:A8", "G7:L7"],
    cellFills: {"3:8":"#E2EFD9","4:8":"#E2EFD9","5:9":"#E2EFD9","6:6":"#D6DCE4"},
  };
  const ctx = vm.createContext({
    CURRICULUM_SEMESTER_FIELDS: ["sem11", "sem12", "sem21", "sem22", "sem31", "sem32"],
    normalizeCurriculumPlanRow: (row) => row,
    normalizeCurriculumDivision: () => "학생 선택 교육과정",
    isSelectableDetail: () => true,
    state: {
      curriculumCohortYear: "2026", curriculumPlanType: "cohort", curriculumImportedLayout: layout,
      curriculumPlan: [
        { grade: "2", division: "학생 선택 교육과정", detail: "일반선택", subject: "세계사", sem21: "●",
          semesterGroups: { sem21: { name: "사회 선택", pick: 1 } } },
        { grade: "2", division: "학생 선택 교육과정", detail: "일반선택", subject: "사회와 문화", sem21: "●",
          semesterGroups: { sem21: { name: "사회 선택", pick: 1 } } },
        { grade: "2", division: "학생 선택 교육과정", detail: "융합선택", subject: "물리학 실험",
          sem21: "●", sem22: "●", semesterGroups: { sem22: { name: "실험 선택", pick: 1 } } }
      ]
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "curriculum-choice-blocks.js"), "utf8"), ctx);
  for (const name of ["columnIndex", "expandCurriculumLayoutRows", "importedPlanColumnMap",
    "sheetMergeReferenceSet", "importedPlanCoveredCells", "curriculumSelectionType", "importedPlanCourseContexts", "curriculumSubjectNames", "curriculumCellFill", "collectApplicationSubjects"]) {
    if (name === "collectApplicationSubjects") {
      vm.runInContext(functionSource("function curriculumPlanGroupAssignments(", "if (typeof window !== \"undefined\") window.updateCurriculumSelectionGroup ="), ctx);
    }
    const start = frontend.indexOf(`function ${name}(`);
    const next = frontend.indexOf("\n    function ", start + 1);
    vm.runInContext(frontend.slice(start, next), ctx);
  }
  const columns = plain(ctx.importedPlanColumnMap(layout));
  assert.equal(columns.subject, 3);
  assert.equal(columns.division, 0);
  assert.deepEqual(columns.semesters, [6, 7, 8, 9, 10, 11]);
  const subjects = plain(ctx.collectApplicationSubjects());
  assert.deepEqual(subjects["2"].map((c) => c.subject),
    ["세계사", "사회와 문화", "물리학", "화학", "미디어 영어", "세계 문화와 영어", "물리학 실험"]);
  assert.equal(subjects["2"].find((c) => c.subject === "물리학 실험").semester, "1·2");
  assert.deepEqual(plain(subjects["2"].find((c)=>c.subject==="세계사").semesterGroups["1"]),
    { groupName: "사회 선택", groupPick: 1, groupConfigured: true, groupLinked: false });
  assert.equal(subjects["2"].find((c)=>c.subject==="물리학 실험").semesterGroups["1"], undefined);
  assert.deepEqual(plain(subjects["2"].find((c)=>c.subject==="물리학 실험").semesterGroups["2"]),
    { groupName: "실험 선택", groupPick: 1, groupConfigured: true, groupLinked: false });
  assert.deepEqual(subjects["3"].map((c) => c.subject), ["주제 탐구 독서"]);
  assert.equal(subjects["3"][0].semester, "2");
  assert.equal(subjects["2"].find((c)=>c.subject==="세계사").semesterColors["1"],"#E2EFD9");
  assert.equal(subjects["2"].find((c)=>c.subject==="물리학").semesterColors["1"],"#E2EFD9");
  assert.equal(subjects["2"].find((c)=>c.subject==="물리학 실험").semesterColors["2"],"#D6DCE4");
  ctx.normalizeCurriculumDivision=(value)=>String(value).includes("학생")?"학생 선택 교육과정":"학교 지정 교육과정";
  ctx.isSelectableDetail=(value)=>["일반선택","진로선택","융합선택"].includes(value);
  vm.runInContext(functionSource("function curriculumColorGroupOptions(", "function aggregateRecords("),ctx);
  layout.rows[3][8]="택3";
  layout.cellFills["3:8"]="#E2EFD9";
  layout.cellFills["4:8"]="#E2EFD9";
  layout.cellFills["5:9"]="#E2EFD9";
  assert.deepEqual(plain(ctx.curriculumColorGroupOptions(layout,"2","1")).map((group)=>({
    name:group.name,count:group.count,grade:group.grade,semester:group.semester,courses:group.courses
  })),[{
    name:"택3",count:3,grade:"2",semester:"1",courses:["세계사","사회와 문화","물리학","화학"]
  }]);
  assert.deepEqual(plain(ctx.curriculumColorGroupOptions(layout,"2","2")),[]);
});

test("joint and small-enrollment courses are applied for separately: excluded from applications and dropped from imported results", () => {
  const contexts = [
    {subject:"일반 과목",division:"학생선택교육과정",detail:"융합",selectionType:"융합선택",
      row:[3,3,""],grade:"2",area:"과학"},
    {subject:"공동체와 인간",division:"학생선택교육과정",detail:"일반",selectionType:"일반선택",
      row:[3,3,""],grade:"2",area:"사회"},
    {subject:"공동 과목",division:"학생선택교육과정",detail:"진로",selectionType:"진로선택",
      row:[3,3,"공 동 교육과정"],grade:"2",area:"과학"},
    {subject:"소인수 과목",division:"학생선택교육과정",detail:"진로",selectionType:"진로선택",
      row:[3,"소인수/2학년/1학기/3학점",""],grade:"2",area:"과학"},
    {subject:"공동 과목 2",division:"학생선택교육과정",detail:"일반",selectionType:"일반선택",
      row:[3,"공동/2학년/1학기/3학점",""],grade:"2",area:"과학"},
  ];
  const ctx = vm.createContext({
    state:{curriculumCohortYear:"2026",curriculumImportedLayout:{}},
    importedPlanColumnMap:()=>({subject:0,opCredit:0,semesters:[-1,-1,1,-1,-1,-1]}),
    importedPlanCourseContexts:()=>contexts,curriculumCellFill:()=>"",
  });
  vm.runInContext(functionSource("function collectApplicationSubjects(", "function renderApplicationSubjects("),ctx);
  assert.deepEqual(plain(ctx.selectedApplicationSubjects()["2"].map((c)=>c.subject)),["일반 과목","공동체와 인간"]);
  const all=ctx.collectApplicationSubjects({includeExcluded:true})["2"];
  assert.equal(all.length,5);
  // 결과 취합은 이름을 알아보되 따로 신청 표시(separate)로 빼낸다.
  assert.deepEqual(plain(all.filter((c)=>c.separate).map((c)=>c.subject)),["공동 과목","소인수 과목","공동 과목 2"]);
  vm.runInContext(functionSource("function mergeApplications(", "function downloadApplicationForm("),ctx);
  const historical=ctx.mergeApplications([
    {grade:"1",classroom:"1",number:"1",name:"가상",selections:["소인수 과목"]},
    {grade:"1",classroom:"1",number:"2",name:"가상2",selections:["일반 과목","공동 과목 2"]}
  ]);
  assert.deepEqual(plain(historical.errors),[]);
  assert.deepEqual(plain(historical.separated),["소인수 과목","공동 과목 2"]);
  assert.ok(!historical.courses.some((course)=>/소인수|공동 과목/.test(course.name)),"따로 신청 과목은 집계 과목에 없다");
  assert.equal(historical.students[0].selections.length,0,"따로 신청 과목만 고른 학생은 명단에 남고 과목은 비움");
  assert.deepEqual(plain(historical.students[1].selections.map((course)=>course.name)),["일반 과목"]);
});

test("separate (소인수·공동) courses use one rule from plan data: note or plan section 'extra'", () => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "curriculum-compliance.js"), "utf8"), ctx);
  const plan = { subjects: [
    { id: "a", row: 3, name: "물리학", category: "학생 선택 교육과정" },
    { id: "b", row: 4, name: "경제", category: "학생 선택 교육과정", note: "소인수/2학년/1학기/3학점(순증)" },
    { id: "c", row: 5, name: "고급 화학", category: "학생 선택 교육과정", planSection: "extra", planSectionManual: true },
    { id: "d", row: 6, name: "공동 운영", category: "공동·소인수 교육과정" },
    { id: "e", row: 7, name: "헤더", fixed: true, note: "소인수" }
  ], groups: [] };
  assert.deepEqual([...ctx.curriculumSeparateApplicationRows(plan)], [4, 5, 6]);
});

test("result import drops separate (소인수·공동) course columns and tells the teacher", () => {
  const ctx = vm.createContext({});
  const importer = fs.readFileSync(path.join(__dirname, "..", "result-import.js"), "utf8");
  const slice = (start, end) => importer.slice(importer.indexOf(start), importer.indexOf(end));
  vm.runInContext(slice("function normalizeResultCourseName(", "function resultCourseSemester("), ctx);
  vm.runInContext(slice("function stripSeparateResultCourses(", "function analyzeResultCandidate("), ctx);
  const data = {
    courses: [{ column: 1, name: "물리학", credits: 3 }, { column: 2, name: "경제 (1학기)", credits: 3 }],
    students: [{ selections: [{ column: 1, name: "물리학", credits: 3 }, { column: 2, name: "경제 (1학기)", credits: 3 }], totalCredits: 6 }]
  };
  const removed = ctx.stripSeparateResultCourses(data, [{ subject: "물리학" }, { subject: "경제", separate: true }]);
  assert.deepEqual(plain(removed), ["경제 (1학기)"]);
  assert.deepEqual(plain(data.courses.map((course) => course.name)), ["물리학"]);
  assert.equal(data.students[0].totalCredits, 3);
  assert.equal(data.students[0].selections.length, 1);
});

test("student course classification labels leave selection identities unchanged", () => {
  const ctx=vm.createContext({});
  vm.runInContext(functionSource("function curriculumSelectionType(", "function importedPlanCourseContexts("),ctx);
  vm.runInContext(functionSource("function applicationCourseLabel(", "function renderApplicationSubjects("),ctx);
  for (const [type,label] of [["융합선택","융합"],["진로선택","진로"],["일반선택","일반"]]) {
    const course={subject:"물리학 실험",type};
    assert.equal(ctx.applicationCourseLabel(course),`물리학 실험(${label})`);
    assert.equal(course.subject,"물리학 실험");
  }
  assert.equal(ctx.applicationCourseLabel({subject:"수학"}),"수학");
});

test("aggregate course labels and groups follow the application menu classification and semester", () => {
  const ctx=vm.createContext({
    curriculumSelectionType:(value)=>String(value||""),
    parseSemesterFromCourseName:(name)=>String(name).match(/([12])학기/)?.[1]||"",
  });
  vm.runInContext(functionSource("function applicationCourseLabel(", "function renderApplicationSubjects("),ctx);
  vm.runInContext(functionSource("function aggregateApplicationSubject(", "function currentStudent("),ctx);
  const menuSubjects={"2":[
    {subject:"물리학 실험",type:"융합선택",semester:"1"},
    {subject:"물리학 실험",type:"진로선택",semester:"2"},
  ]};
  const match=ctx.aggregateApplicationSubject({name:"물리학 실험",semesterKey:"1"}, "1", menuSubjects);
  assert.equal(match.type,"융합선택");
  assert.equal(ctx.applicationCourseLabel(match),"물리학 실험(융합)");
  assert.equal(ctx.aggregateApplicationSubject({name:"물리학 실험 (2학기)"}, "1", menuSubjects).type,"진로선택");
  assert.equal(ctx.aggregateApplicationSubject({name:"없는 과목"}, "1", menuSubjects),null);
});

test("Google Form classified labels map back to original course names and accept older results", () => {
  const ctx=vm.createContext({});
  vm.runInContext(functionSource("function curriculumSelectionType(", "function importedPlanCourseContexts("),ctx);
  vm.runInContext(functionSource("function applicationCourseLabel(", "function renderApplicationSubjects("),ctx);
  vm.runInContext(functionSource("const COURSE_NAME_EQUIVALENTS", "async function handleGoogleFormsFile("),ctx);
  const subjects={"2":[{subject:"물리학 실험",type:"융합선택"},{subject:"경제",type:"진로선택"}]};
  const result=ctx.parseGoogleFormsRows([
    ["현재 학년","반","번호","이름","2학년 1학기 선택과목"],
    ["1학년","1","1","가상1","물리학 실험(융합), 경제(진로)"],
    ["1학년","1","2","가상2","물리학 실험, 경제"],
  ],subjects);
  assert.deepEqual(plain(result.map((entry)=>entry.selections)),[
    ["물리학 실험","경제"],["물리학 실험","경제"]
  ]);
});

test("generated Google Form routes each current grade to only its promoted-grade section", () => {
  const generator=vm.createContext({$:(selector)=>({value:selector==="#schoolName"?"가상학교":"2026"})});
  vm.runInContext(functionSource("function buildAppsScriptCode(", "function splitGoogleFormSelections("),generator);
  for (const subjects of [setup().subjects,{"2":setup().subjects["2"],"3":[]}]) {
    const pages=[],items=[];
    const gradeItem={setTitle(){return this;},setRequired(){return this;},
      createChoice:(label,page)=>({label,page}),setChoices(choices){this.choices=choices;}};
    const form={
      setDescription(){},setLimitOneResponsePerUser(){},setDestination(){},
      addMultipleChoiceItem:()=>gradeItem,
      addTextItem:()=>({setTitle(){return this;},setRequired(){return this;}}),
      addPageBreakItem(){
        const page={setTitle(title){this.title=title;return this;},setGoToPage(target){this.navigation=target;return this;}};
        pages.push(page);return page;
      },
      addCheckboxItem(){
        const item={page:pages.at(-1),setTitle(){return this;},setChoiceValues(values){this.values=values;return this;},
          setHelpText(){return this;}};
        items.push(item);return item;
      },getPublishedUrl:()=>"https://example.invalid/form",
    };
    const ctx=vm.createContext({
      FormApp:{create:()=>form,PageNavigationType:{SUBMIT:"submit"},DestinationType:{SPREADSHEET:"sheet"}},
      SpreadsheetApp:{create:()=>({getId:()=>"sheet",getUrl:()=>"url"})},Logger:{log(){}},
    });

    vm.runInContext(generator.buildAppsScriptCode(subjects),ctx);
    ctx.createCourseApplicationForm();
    assert.equal(gradeItem.choices.length,pages.length);
    for (const choice of gradeItem.choices) {
      const target=String(Number(choice.label[0])+1);
      assert.equal(choice.page.title,`${target}학년 선택과목`);
      assert.deepEqual(plain(items.filter((item)=>item.page===choice.page).flatMap((item)=>item.values)),
        subjects[target].map((course)=>course.subject));
      const nextPage=pages[pages.indexOf(choice.page)+1];
      if (nextPage) assert.equal(nextPage.navigation,"submit");
    }
  }
});

test("generated offline student form shows total credits and the math, English, Korean credit share", () => {
  const source = functionSource("function buildApplicationPageHtml(", "function mergeApplications(");
  const context = vm.createContext({
    $: (selector) => ({ value: selector === "#schoolName" ? "가상학교" : "2026" }),
    xmlEscape: (value) => String(value),
  });
  vm.runInContext(source, context);
  const html = context.buildApplicationPageHtml({
    "2": [
      { subject: "수학", area: "수학", credit: 3, semester: "1" },
      { subject: "생명과학", area: "과학", credit: 3, semester: "1" },
    ],
    "3": [],
  });
  assert.match(html, /신청 학점 중 국어·영어·수학 과목 비율/);
  assert.match(html, /국·영·수/);
  assert.match(html, /summaryGauge/);
  assert.match(html, /position:sticky;bottom:0/);
  assert.match(html, /data-core=/);
});

test("Excel style fills resolve RGB, theme, tint, indexed and uncolored cells", async () => {
  function node(tag,attributes={},children=[]) {
    return {children,textContent:"",
      getAttribute:(name)=>attributes[name] ?? null,hasAttribute:(name)=>name in attributes,
      getElementsByTagNameNS(ns,name) {
        return children.flatMap((c)=>[...(c.tag===name?[c]:[]),...c.getElementsByTagNameNS(ns,name)]);
      },tag};
  }
  const fill=(attributes,type="solid")=>node("fill",{},[node("patternFill",{patternType:type},[node("fgColor",attributes)])]);
  const styles=node("styleSheet",{},[
    node("fills",{},[fill({},"none"),fill({rgb:"FFE2EFD9"}),fill({theme:"4"}),
      fill({indexed:"42"}),fill({theme:"0"}),fill({theme:"4",tint:"0.5"})]),
    node("cellXfs",{},Array.from({length:6},(_,fillId)=>node("xf",{fillId:String(fillId)})))
  ]);
  const theme=node("theme",{},[node("clrScheme",{},[
    node("dk1",{},[node("sysClr",{lastClr:"000000"})]),
    node("lt1",{},[node("srgbClr",{val:"FFFFFF"})]),
    node("dk2",{},[node("srgbClr",{val:"445566"})]),
    node("lt2",{},[node("srgbClr",{val:"EEEEEE"})]),
    node("accent1",{},[node("srgbClr",{val:"E2EFD9"})])
  ])]);
  const ctx=vm.createContext({NS_MAIN:"m",readZipEntry:async(b,d,p)=>p.includes("styles")?styles:theme,parseXml:(n)=>n});
  vm.runInContext(workbookParser.slice(
    workbookParser.indexOf("async function readWorkbookFillStyles("),
    workbookParser.indexOf("\n    }", workbookParser.indexOf("async function readWorkbookFillStyles(")) + 6
  ),ctx);
  assert.deepEqual(plain(await ctx.readWorkbookFillStyles(null,null)),["","#E2EFD9","#E2EFD9","#CCFFCC","","#F1F7EC"]);
});

test("cell fill positions survive layout cropping and inserted rows", () => {
  const ctx=vm.createContext({});
  for (const name of ["columnIndex","cropCurriculumSheet","insertImportedPlanLayoutRow","curriculumCellFill"]) {
    const start=frontend.indexOf(`function ${name}(`),next=frontend.indexOf("\n    function ",start+1);
    vm.runInContext(frontend.slice(start,next),ctx);
  }
  const cropped=ctx.cropCurriculumSheet({name:"표",rows:[[],["","과목","학기"],["","A",3],["","B",""]],
    layout:{cellFills:{"2:2":"#E2EFD9"},mergedRanges:["C3:C4"],columnWidths:[],rowHeights:{}}});
  assert.equal(cropped.cellFills["1:1"],"#E2EFD9");
  assert.equal(ctx.curriculumCellFill(cropped,2,1),"#E2EFD9");
  const inserted=ctx.insertImportedPlanLayoutRow(cropped,1,["",""]);
  assert.equal(inserted.cellFills["2:1"],"#E2EFD9");
  assert.equal(ctx.curriculumCellFill(inserted,3,1),"#E2EFD9");
});

test("semester-qualified result imports retain separate courses, credits and semester keys", () => {
  const ctx=vm.createContext({collectApplicationSubjects:()=>({"2":[{subject:"수학",semester:"1·2",credit:3,area:"수학"}],"3":[]})});
  vm.runInContext(functionSource("function mergeApplications(","function downloadApplicationForm("),ctx);
  const common={grade:"1",classroom:"1",number:"1",name:"가상"};
  const result=ctx.mergeApplications([{...common,selections:["수학 (1학기)","수학 (2학기)"]}]);
  assert.deepEqual(plain(result.errors),[]);
  assert.deepEqual(plain(result.students[0].selections.map((c)=>c.semesterKey)),["1","2"]);
  assert.equal(result.students[0].totalCredits,6);
  const legacy=ctx.mergeApplications([{...common,selections:["수학"]}]);
  assert.equal(legacy.courses.length,1);
  assert.deepEqual(plain(legacy.errors),[]);
});

test("cloud aggregation updates its own round, clears rollback results and preserves overrides", () => {
  const state={currentRound:"2",rounds:{"1":{students:[],classOverrides:{"app0":2}},
    "2":{students:[{id:"existing"}],courses:[]}},students:[{id:"existing"}],courses:[]};
  let saves=0,renders=0;
  const elements=new Map();
  const ctx=vm.createContext({state,$:(id)=>{
    if(!elements.has(id)) elements.set(id,{textContent:"",disabled:false});
    return elements.get(id);
  },syncActiveRound(){},persistState(){saves++;},renderRoundStatus(){},
    parseSemesterFromCourseName:()=>"",
    applyClassFilterOptions(){},renderRoster(){renders++;},renderPreview(){},
    renderSemesterClassifier(){},renderAggregate(){},
  });

  vm.runInContext(functionSource("function mergeApplications(", "function downloadApplicationForm("),ctx);
  vm.runInContext(functionSource("function applicationGroupForCourse(", "function courseIndexByColumn("),ctx);
  vm.runInContext(functionSource("function applyCloudApplicationResults(", "function applyMergedApplications("),ctx);
  const subjects={"2":[{subject:"A",semester:"1",credit:3}],"3":[]};
  const entries=[{grade:"1",classroom:"1",number:"1",name:"가상",selections:["A"]}];
  ctx.applyCloudApplicationResults("1",entries,subjects);
  assert.equal(state.currentRound,"2");
  assert.equal(state.students[0].id,"existing");
  assert.equal(state.rounds["1"].students[0].totalCredits,3);
  assert.equal(state.rounds["1"].classOverrides.app0,2);
  state.currentRound="1";
  ctx.applyCloudApplicationResults("1",[],subjects);
  assert.equal(state.students.length,0);
  assert.equal(state.rounds["1"].students.length,0);
  assert.equal(renders,1);
  assert.equal(saves,2);
  assert.throws(()=>ctx.applyCloudApplicationResults("1",[{...entries[0],selections:["unknown"]}],subjects),/연동 실패/);
  assert.equal(saves,2);
});

test("Excel data export uses text cells for codes and formula-like input", () => {
  let files,download;
  const ctx=vm.createContext({
    xmlEscape:(value)=>String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"),
    columnName:(index)=>String.fromCharCode(65+index),
    createXlsxBlob:(value)=>{files=value;return {};},
    URL:{createObjectURL:()=>"blob",revokeObjectURL(){}},
    document:{createElement:()=>({click(){download=this.download;}})},setTimeout(){},
  });
  vm.runInContext(functionSource("function downloadRowsXlsx(", "function normalizeApplicationServerUrl("),ctx);
  ctx.downloadRowsXlsx([["신청코드","성명"],["001234","=HYPERLINK(\"bad\")"]],"codes.xlsx");
  assert.equal(download,"codes.xlsx");
  assert.match(files["xl/worksheets/sheet1.xml"],/t="inlineStr".*001234/s);
  assert.ok(!files["xl/worksheets/sheet1.xml"].includes("<f>"));
});

test("online result groups and types remain authoritative across grades, local settings and reloads", () => {
  const state={currentRound:"1",rounds:{},roundClosures:{},students:[],courses:[]};
  const ctx=vm.createContext({
    state,$:()=>({value:"",textContent:""}),
    syncActiveRound(){},persistState(){},renderRoundStatus(){},applyClassFilterOptions(){},
    renderRoster(){},renderPreview(){},renderSemesterClassifier(){},renderAggregate(){},
    collectApplicationSubjects:()=>{throw new Error("Online results must not read the active local curriculum");},
    getApplicationGroupSettings:()=>[{grade:"2",semester:"1",name:"잘못된 로컬 그룹",courses:["수학"]}],
    curriculumSelectionType:(value)=>String(value||""),
  });
  vm.runInContext(functionSource("function parseCourseGroup(", "function courseIndexByColumn("),ctx);
  vm.runInContext(functionSource("function aggregateRecords(", "function currentStudent("),ctx);
  vm.runInContext(functionSource("function applicationCourseLabel(", "function renderApplicationSubjects("),ctx);
  vm.runInContext(functionSource("function mergeApplications(", "function downloadApplicationForm("),ctx);
  vm.runInContext(functionSource("function applyCloudApplicationResults(", "function applyMergedApplications("),ctx);
  vm.runInContext(functionSource("function xmlEscape(", "function createStylesXml("),ctx);
  const subjects={"2":[{subject:"수학",type:"진로선택",semester:"1",credit:3}],
    "3":[{subject:"수학",type:"융합선택",semester:"2",credit:4}]};
  const groups=[
    {grade:"2",semester:"1",name:"국영수과",courses:["수학"]},
    {grade:"3",semester:"2",name:"외국어 정보",courses:["수학"]},
  ];
  const entries=["1","2"].map((grade)=>({grade,classroom:"1",number:"1",name:`가상${grade}`,selections:["수학"]}));
  ctx.applyCloudApplicationResults("1",entries,subjects,groups);
  const persisted=plain(state.rounds["1"]);
  const aggregate=ctx.aggregateRecords(persisted.students,persisted.courses,90,110,{},{"app0":"2"},{"app0":"과거 그룹"});
  for (const [index,report] of aggregate.reports.entries()) {
    assert.equal(report.semesters.length,1);
    const semester=report.semesters[0];
    assert.equal(semester.name,`${index+2}학년 ${index+1}학기`);
    assert.equal(semester.groups[0].category,groups[index].name);
    assert.equal(semester.groups[0].courses.length,1);
    const course=semester.groups[0].courses[0];
    assert.equal(course.displayName,index===0?"수학(진로)":"수학(융합)");
    assert.equal(course.enrollment,1);
    assert.equal(course.name,`수학(${index+2}학년)`);
    assert.match(ctx.createWorksheetXml(report,90,110),new RegExp(course.displayName.replace(/[()]/g,"\\$&")));
    assert.equal(ctx.courseGroupLabel(persisted.students[index].selections[0],String(index+1)),`${index+1}학기 ${groups[index].name}`);
    assert.equal(ctx.resolveCourseCategory(persisted.courses[index]),`${index+2}학년 ${index+1}학기 ${groups[index].name}`);
    assert.equal(ctx.resolveCourseCategoryForOutput(persisted.courses[index]),groups[index].name);
    assert.equal(ctx.resolveSemesterKey(persisted.courses[index]),String(index+1));
  }
});

test("uploaded courses resolve application groups by promoted grade and explicit semester without guessing", () => {
  let groups=[
    {grade:"2",semester:"1",name:"과학 선택",courses:["물리학","실험 (1학기)"]},
    {grade:"2",semester:"2",name:"2학기 선택",courses:["실험 (2학기)"]},
    {grade:"3",semester:"2",name:"3학년 선택",courses:["물리학"]},
  ];
  const ctx=vm.createContext({getApplicationGroupSettings:()=>groups,
    parseSemesterFromCourseName:(name)=>String(name).match(/([12])학기/)?.[1]||"",
    state:{groupAssignments:{},semesterAssignments:{}},
    resolveSemesterKey:(c)=>c.semesterKey||"",
    resolveCourseCategoryForOutput:()=>"미분류"});
  vm.runInContext(functionSource("function applicationGroupForCourse(", "function courseIndexByColumn("),ctx);
  assert.equal(ctx.courseGroupLabel({name:"물리학(진로)",column:4},"1"),"1학기 과학 선택");
  assert.equal(ctx.courseGroupLabel({name:"물리학",column:4},"2"),"2학기 3학년 선택");
  assert.equal(ctx.applicationGroupForCourse({name:"실험"},"1"),null);
  assert.equal(ctx.applicationGroupForCourse({name:"없는 과목"},"1"),null);
  assert.equal(ctx.applicationGroupForCourse({name:"물리학(3학년)"},"1"),null);
  assert.equal(ctx.courseGroupLabel({name:"실험 (2학기)",column:5},"1"),"2학기 2학기 선택");
  assert.equal(ctx.applicationGroupForCourse({name:"실험"},"1",groups,"2").name,"2학기 선택");
  const course={name:"물리학",column:4};
  const data={courses:[course],students:[{grade:"1",selections:[{...course}]}]};
  assert.deepEqual([...ctx.classifyApplicationRecords(data)],[]);
  assert.equal(data.students[0].selections[0].applicationGroups["1"].name,"과학 선택");
  groups=[];
  assert.equal(ctx.courseGroupLabel(data.students[0].selections[0],"1"),"1학기 과학 선택");
  ctx.state.groupAssignments["4"]="manual";
  assert.equal(ctx.courseGroupLabel(course,"1"),"1학기 과학 선택");
  ctx.state.groupAssignments["5"]="manual";
  assert.equal(ctx.courseGroupLabel({name:"다른 과목",column:5,semesterKey:"1"},"1"),"1학기 미분류");
});

test("round deletion retains curriculum, other rounds and their classification settings", () => {
  const other={students:[{id:"other"}],courses:[{column:3}],fileName:"other.xlsx",classOverrides:{3:2},
    semesterAssignments:{3:"2"},groupAssignments:{3:"2학기 보존"},customGroupNames:["보존"]};
  const plan=[{subject:"보존할 편제표"}],layout={rows:[["보존"]]};
  const state={currentRound:"1",rounds:{"1":{students:[{id:"delete"}]},"2":other,"3":null},
    roundClosures:{"1":{closed:"closed"},"2":{keep:"open"}},students:[{id:"delete"}],courses:[],
    fileName:"delete.xlsx",classOverrides:{},semesterAssignments:{},groupAssignments:{},customGroupNames:[],
    curriculumPlan:plan,curriculumImportedLayout:layout,applicationImportRevision:0};
  const elements=new Map();let saves=0;
  const ctx=vm.createContext({state,$:(id)=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);},
    applyClassFilterOptions(){},renderRoster(){},renderPreview(){},renderSemesterClassifier(){},
    renderAggregate(){},renderRoundStatus(){},renderWorkflowLayout(){},persistState(){saves++;}});
  vm.runInContext(functionSource("function syncActiveRound(", "function persistState("),ctx);
  vm.runInContext(functionSource("function switchRound(", "function resetWorkspace("),ctx);
  ctx.clearApplicationRound();
  assert.equal(state.rounds["1"],null);
  assert.equal(state.rounds["2"],other);
  assert.equal(state.curriculumPlan,plan);
  assert.equal(state.curriculumImportedLayout,layout);
  assert.deepEqual(state.roundClosures["2"],{keep:"open"});
  assert.equal(state.currentRound,"1");
  assert.equal(state.students.length,0);
  ctx.switchRound("2");
  assert.equal(state.students[0].id,"other");
  assert.equal(state.groupAssignments["3"],"2학기 보존");
  assert.equal(state.semesterAssignments["3"],"2");
  assert.equal(saves,2);
});

test("result Excel upload opens a validated preview and never replaces data while the round, grade or data changes", async () => {
  let completion, previewed = null, built = null, locked = false;
  const existing = [{id:"existing",grade:"1"}];
  const state = {currentRound:"2", applicationMenuGrade:"1", applicationImportRevision:0, students:existing};
  const status = {style:{}};
  const ctx = vm.createContext({
    state,status,
    isRoundLocked:()=>locked,
    FileReader:class { readAsArrayBuffer(){completion=this.onload();} },
    parseWorkbook:async()=>[{name:"결과",rows:[]}],
    collectApplicationSubjects:(options)=>({options}),
    buildResultImportPreview:(sheets,options)=>{built=options;return {candidates:[{issues:{blocking:[]}}],selected:0};},
    showResultImportPreview:(preview)=>{previewed=preview;},
  });
  vm.runInContext(functionSource("function resultImportOptions(", "function importedPlanColumnMap("),ctx);
  ctx.handleWorkbook({name:"results.csv"});
  assert.match(status.textContent,/xlsx/);
  locked = true;
  ctx.handleWorkbook({name:"results.xlsx"});
  assert.match(status.textContent,/확정된 차수/);
  assert.equal(completion,undefined, "a confirmed round must not even read the file");
  locked = false;
  ctx.handleWorkbook({name:"results.xlsx"}); await completion;
  assert.equal(built.round,"2");
  assert.equal(built.grade,"1");
  assert.equal(built.fileName,"results.xlsx");
  assert.equal(built.subjects.options.currentGrade,"1");
  assert.equal(built.subjects.options.includeExcluded,true);
  assert.equal(built.existingStudents,existing);
  assert.ok(previewed);
  assert.match(status.textContent,/결과 반영/);
  assert.equal(state.students,existing, "previewing never replaces the stored results");
  for (const [change, message] of [
    [()=>{state.applicationMenuGrade="2";}, /학년 메뉴가 바뀌었/],
    [()=>{state.currentRound="3";}, /차수가 바뀌었/],
    [()=>{state.applicationImportRevision++;}, /데이터가 삭제/],
  ]) {
    previewed = null;
    state.applicationMenuGrade = "1";
    state.currentRound = "2";
    const revision = state.applicationImportRevision;
    ctx.parseWorkbook = async()=>{change();return [];};
    ctx.handleWorkbook({name:"changed.xlsx"}); await completion;
    assert.match(status.textContent,message);
    assert.equal(previewed,null);
    state.applicationImportRevision = revision;
  }
  state.applicationMenuGrade = "1";
  state.currentRound = "2";
  ctx.parseWorkbook = async()=>[{rows:[]}];
  ctx.buildResultImportPreview = ()=>({candidates:[{issues:{blocking:["차수가 다릅니다"]}}],selected:0});
  ctx.handleWorkbook({name:"wrong.xlsx"}); await completion;
  assert.match(status.textContent,/반영할 수 없습니다: 차수가 다릅니다/);
});

test("a new round inherits class counts and groups from the previous round but not open/close decisions", () => {
  const state={currentRound:"2",students:[],courses:[],classOverrides:{},semesterAssignments:{},groupAssignments:{},roundClosures:{"1":{},"2":{}},
    rounds:{"1":{
      students:[{id:"s"}],
      courses:[{column:"result-1-0",name:"공통 이름",semesterKey:"1",applicationCurrentGrade:"1"}],
      classOverrides:{"1:result-1-0":2},semesterAssignments:{"result-1-0":"1"},groupAssignments:{"result-1-0":"유지할 그룹"}
    },"2":null}};
  const ctx=vm.createContext({
    state,$:()=>({}),normalizeCourses:(courses)=>courses,
    applyClassFilterOptions(){},renderRoster(){},renderPreview(){},renderSemesterClassifier(){},renderAggregate(){},renderRoundStatus(){},
    applicationRoundNumbers:()=>Object.keys(state.rounds).sort((a,b)=>Number(a)-Number(b)),
    persistState(){ctx.syncActiveRound();},
  });
  vm.runInContext(functionSource("function syncActiveRound(", "function persistState("),ctx);
  vm.runInContext(functionSource("function priorRoundSettings(", "async function handleApplicationFiles("),ctx);
  state.roundClosures["1"]={"1:result-1-0":"closed"};
  const carry=ctx.storeGradeResults({
    courses:[{column:7,name:"새 과목",semesterKey:"1"},{column:4,name:"공통 이름",semesterKey:"1"}],
    students:[{id:"n",grade:"1",name:"학생",classroom:"1",number:"1",selections:[{column:4,name:"공통 이름",semesterKey:"1"}]}]
  },"2차.xlsx","1");
  const column=state.students[0].selections[0].column;
  assert.equal(state.classOverrides[`1:${column}`],2);
  assert.equal(state.semesterAssignments[column],"1");
  assert.equal(state.groupAssignments[column],"유지할 그룹");
  assert.equal(carry.inheritedFrom,"1");
  assert.equal(carry.inherited,3);
  assert.deepEqual(plain(state.roundClosures["2"]),{}, "closure decisions are never inherited");
});

test("grade results replace only the chosen grade and carry settings to re-imported courses by name and semester", () => {
  const state={currentRound:"1",students:[],courses:[],rounds:{"1":null,"2":{students:[{id:"other-round"}]}}};
  const ctx=vm.createContext({
    state,$:()=>({}),normalizeCourses:(courses)=>courses,
    applyClassFilterOptions(){},renderRoster(){},renderPreview(){},renderSemesterClassifier(){},renderAggregate(){},
    renderRoundStatus(){},
    applicationRoundNumbers:()=>Object.keys(state.rounds).sort((a,b)=>Number(a)-Number(b)),
    persistState(){ctx.syncActiveRound();},
  });
  vm.runInContext(functionSource("function syncActiveRound(", "function persistState("),ctx);
  vm.runInContext(functionSource("function priorRoundSettings(", "async function handleApplicationFiles("),ctx);
  const defaultCourses=[{column:4,name:"공통 이름",credits:3,semesterKey:"1"},{column:5,name:"미신청 과목",credits:3,semesterKey:"2"}];
  const data=(grade,name,courses=defaultCourses)=>({
    courses,
    students:[{id:`${grade}-${name}`,grade,name,classroom:"1",number:"1",totalCredits:3,
      selections:[{column:4,name:"공통 이름",credits:3,semesterKey:"1"}]}]
  });
  ctx.storeGradeResults(data("1","첫학생"),"1학년.xlsx","1");
  const firstColumn=state.students[0].selections[0].column;
  const unusedColumn=state.courses.find((course)=>course.name==="미신청 과목").column;
  state.classOverrides[`1:${firstColumn}`]=2;
  state.roundClosures["1"]={[`1:${firstColumn}`]:"open"};
  state.semesterAssignments[firstColumn]="1";
  state.semesterAssignments[unusedColumn]="2";
  state.groupAssignments[firstColumn]="유지할 그룹";
  ctx.storeGradeResults(data("2","둘째학생"),"2학년.xlsx","2");
  assert.deepEqual(plain(state.students.map((s)=>s.grade)),["1","2"]);
  assert.equal(state.courses.length,4); // Keep zero-enrollment courses in aggregate reports.
  assert.equal(new Set(state.courses.map((course)=>course.column)).size,4);
  assert.equal(state.classOverrides[`1:${firstColumn}`],2, "another grade's upload keeps grade:column overrides");
  assert.equal(state.roundClosures["1"][`1:${firstColumn}`],"open");
  assert.equal(state.groupAssignments[firstColumn],"유지할 그룹");
  const secondColumn=state.students[1].selections[0].column;
  state.classOverrides[`2:${secondColumn}`]=3;
  // 같은 학년을 다시 올리면 과목 순서가 바뀌어도 과목명·학기가 같은 과목의 설정을 이어받는다.
  const carry=ctx.storeGradeResults(data("1","새학생",[
    {column:9,name:"새 과목",credits:2,semesterKey:"1"},
    {column:4,name:"공통 이름",credits:3,semesterKey:"1"},
  ]),"1학년_수정.xlsx","1");
  assert.deepEqual(plain(state.students.map((s)=>s.name)),["새학생","둘째학생"]);
  const movedColumn=state.students[0].selections[0].column;
  assert.notEqual(movedColumn,firstColumn);
  assert.equal(state.classOverrides[`1:${movedColumn}`],2);
  assert.equal(state.classOverrides[`1:${firstColumn}`],undefined);
  assert.equal(state.roundClosures["1"][`1:${movedColumn}`],"open");
  assert.equal(state.semesterAssignments[movedColumn],"1");
  assert.equal(state.groupAssignments[movedColumn],"유지할 그룹");
  assert.equal(state.classOverrides[`2:${secondColumn}`],3);
  assert.deepEqual(plain(carry),{kept:4,dropped:1,inheritedFrom:null,inherited:0});
  assert.equal(state.courses.length,4);
  assert.deepEqual(plain(state.rounds["1"].gradeFiles),{"1":"1학년_수정.xlsx","2":"2학년.xlsx"});
  const restored=plain(state.rounds["1"]);
  assert.deepEqual(restored.students.map((s)=>s.grade),["1","2"]);
  assert.equal(state.rounds["2"].students[0].id,"other-round");
  const previous=plain(state);
  assert.throws(()=>ctx.storeGradeResults(data("2","잘못된학년"),"wrong.xlsx","1"),/학생이 없는/);
  assert.deepEqual(plain(state),previous);
});

test("workflow menus reveal their matching panels without changing the selected round", () => {
  const elements=new Map();
  const element=()=>({attributes:{},dataset:{},hidden:false,textContent:"",
    setAttribute(name,value){this.attributes[name]=value;},
    classList:{states:{},toggle(name,value){this.states[name]=value;}},querySelector(){return element();}});
  const buttons=[...html.matchAll(/<button[^>]*data-workflow-step="(\d+)"([^>]*)>/g)].map((match)=>({
    ...element(),dataset:{workflowStep:match[1]}
  }));
  for (const button of buttons) button.classList.toggle=(name,value)=>{button.hidden=value;};
  const workflowSteps={...element(),querySelectorAll:()=>buttons};
  const state={workflowStep:1,currentRound:"4",curriculumPlan:[],students:[],rounds:{"4":null}};
  let saved=0;
  const ctx=vm.createContext({state,workflowSteps,
    $:(id)=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);},
    renderCurriculumStep(){},renderRoundStatus(){},renderApplicationSubjects(){},
    renderApplicationMode(){},
    renderAggregate:()=>{ctx.aggregateRendered=(ctx.aggregateRendered||0)+1;},renderRetakePanel(){},
    renderHoursStats:()=>{ctx.hoursRendered=(ctx.hoursRendered||0)+1;},
    renderRoundCompare:()=>{ctx.compareRendered=true;},
    persistState:()=>{saved++;}});
  vm.runInContext(functionSource("function renderWorkflowLayout(", "function switchRound("),ctx);
  ctx.renderWorkspaceContext=()=>{};
  ctx.renderWorkflowLayout();
  // 편제표·수강신청·확인서·집계·시수 통계·분반 편성 6개 업무 메뉴와 보류 중인 이동수업·시간표 메뉴
  assert.deepEqual(buttons.map((button)=>button.dataset.workflowStep),["1","2","3","4","7","8","5","6"]);
  assert.equal(elements.get("#workflowStep1Panel").classList.states.hidden,false);
  ctx.switchWorkflowStep(3);
  assert.equal(elements.get("#certificatePanel").classList.states.hidden,false);
  ctx.switchWorkflowStep(4);
  assert.equal(elements.get("#aggregatePanel").classList.states.hidden,false);
  assert.equal(elements.get("#retakePanel").classList.states.hidden,false);
  assert.equal(elements.get("#roundComparePanel").classList.states.hidden,false);
  assert.equal(ctx.compareRendered,true);
  // 개설/폐강 결정은 집계표 안에 있으므로 4단계로 오면 집계표를 다시 그린다(별도 폐강 검토 패널 없음).
  assert.ok(ctx.aggregateRendered>0);
  assert.doesNotMatch(html,/id="closurePanel"/);
  ctx.switchWorkflowStep(7);
  assert.equal(elements.get("#workflowStep7Panel").classList.states.hidden,false);
  assert.equal(elements.get("#aggregatePanel").classList.states.hidden,true);
  assert.equal(ctx.hoursRendered,1);
  assert.equal(elements.get("#workflowMenuToggle").textContent,"단계 선택 · 5단계");
  ctx.renderClassSections=()=>{ctx.classSectionsRendered=(ctx.classSectionsRendered||0)+1;};
  ctx.switchWorkflowStep(8);
  assert.equal(elements.get("#workflowStep8Panel").classList.states.hidden,false);
  assert.equal(elements.get("#workflowStep7Panel").classList.states.hidden,true);
  assert.equal(ctx.classSectionsRendered,1);
  assert.equal(elements.get("#workflowMenuToggle").textContent,"단계 선택 · 6단계");
  ctx.switchWorkflowStep(5);
  assert.equal(elements.get("#classifierPanel").classList.states.hidden,false);
  ctx.switchWorkflowStep(6);
  assert.equal(elements.get("#workflowStep6Panel").classList.states.hidden,false);
  assert.equal(state.currentRound,"4");
  assert.ok(saved>0);
  assert.match(html,/data-workflow-step="5"[^>]*>[\s\S]*?보류/);
  assert.match(html,/data-workflow-step="6"[^>]*>[\s\S]*?보류/);
});

test("application rounds start at one and can be added sequentially beyond three", () => {
  const state={rounds:{"1":null,"3":{students:[{id:"preserved"}]}},roundClosures:{"1":{}},currentRound:"1"};
  const ctx=vm.createContext({state,switchRound:(round)=>{state.currentRound=round;}});
  vm.runInContext(functionSource("function applicationRoundNumbers(", "function switchRound("),ctx);
  assert.deepEqual(Array.from(ctx.applicationRoundNumbers()),["1","3"]);
  ctx.addApplicationRound();
  assert.deepEqual(Array.from(ctx.applicationRoundNumbers()),["1","3","4"]);
  assert.equal(state.currentRound,"4");
  assert.deepEqual(plain(state.roundClosures["4"]),{});
  assert.equal(state.rounds["3"].students[0].id,"preserved");
});

test("retake decisions follow course names when column IDs change between rounds", () => {
  const state={
    rounds:{
      "1":{courses:[{column:"old-a",name:"미적분",applicationCurrentGrade:"1"}]},
      "2":{courses:[
        {column:"new-a",name:"미적분",applicationCurrentGrade:"1"},
        {column:"new-b",name:"기하",applicationCurrentGrade:"1"}
      ],students:[{grade:"1",selections:[
        {column:"new-a",name:"미적분"},{column:"new-b",name:"기하"}
      ]}]}
    },
    roundClosures:{
      "1":{"1:old-a":"closed"},
      "2":{"1:new-a":"open","1:new-b":"closed"}
    }
  };
  const ctx=vm.createContext({state,applicationRoundNumbers:()=>["1","2"]});
  vm.runInContext(functionSource("function retakeTargets(", "function renderRetakePanel("),ctx);
  const result=ctx.retakeTargets();
  assert.equal(result.sourceRound,"2");
  assert.equal(result.rows.length,1);
  assert.deepEqual(Array.from(result.rows[0].courses),["기하"]);
});

test("roster upload exports selected subjects and round without overwriting application results", async () => {
  const subjects = setup().subjects;
  const existing = [{ name: "기존학생" }];
  const ctx = vm.createContext({
    state: { currentRound: "2", students: existing },
    status: { style: {}, textContent: "" },
    $: (selector) => ({ value: selector === "#schoolName" ? "가상학교" : "2026" }),
    selectedApplicationSubjects: () => subjects,
    parseWorkbook: async () => [
      { name: "명렬", rows: [["학년", "반", "번호", "성명"], [1, 1, 1, "가상학생1"]] },
    ],
    downloadTextFile(text, filename) { ctx.downloaded = { data: JSON.parse(text), filename }; },
  });
  vm.runInContext(functionSource("function parseApplicationRoster(", "function downloadTextFile("), ctx);
  vm.runInContext(functionSource("async function handleApplicationRoster(", "function applyMergedApplications("), ctx);
  const file = { name: "roster.xlsx", arrayBuffer: async () => new ArrayBuffer(0) };
  await ctx.handleApplicationRoster(file);
  assert.equal(ctx.downloaded.filename, "온라인_수강신청_설정.json");
  assert.equal(ctx.downloaded.data.type, "course-application-setup");
  assert.equal(ctx.downloaded.data.round, "2");
  assert.deepEqual(ctx.downloaded.data.subjects, subjects);
  assert.equal(ctx.downloaded.data.roster.length, 1);
  assert.equal(ctx.state.students, existing);
  ctx.downloaded = null;
  subjects["2"] = [];
  await ctx.handleApplicationRoster(file);
  assert.equal(ctx.downloaded, null);
  assert.match(ctx.status.textContent, /2학년 학생선택교육과정 과목이 없습니다/);
});

test("server setup requires admin and rejects invalid/duplicate roster", () => {
  const s = server(), c = s.context;
  assert.throws(() => c.uploadCourseSetup("wrong", JSON.stringify(setup())), /인증/);
  const duplicate = setup();
  duplicate.roster.push(duplicate.roster[0]);
  assert.throws(() => c.uploadCourseSetup(s.key, JSON.stringify(duplicate)), /중복/);
  assert.equal(s.books.size, 0);
  c.uploadCourseSetup(s.key, JSON.stringify(setup()));
  assert.throws(() => c.uploadCourseSetup(s.key, JSON.stringify(setup())), /이미 설정/);
  assert.equal(s.locks(), 0);
});

test("student reads only own grade, saves, updates, closes and exports into existing records", () => {
  const s = server(), c = s.context;
  c.uploadCourseSetup(s.key, JSON.stringify(setup()));
  const codes = JSON.parse(c.exportCourseData(s.key, "codes")).students;
  const first = codes[0].code, second = codes[1].code;
  assert.match(first, /^[a-f0-9]{32}$/);
  assert.notEqual(first, second);
  assert.throws(() => c.getStudentApplication("wrong"), /코드/);
  assert.throws(() => c.exportCourseData("wrong", "results"), /인증/);
  const data = plain(c.getStudentApplication(first));
  assert.equal(data.student.name, "가상학생1");
  assert.deepEqual(data.courses.map((course) => course.subject), ["수학"]);
  assert.equal("roster" in data, false);
  assert.throws(() => c.saveStudentApplication(first, ["과학"]), /가능한 과목/);
  assert.throws(() => c.saveStudentApplication(first, []), /가능한 과목/);
  assert.throws(() => c.saveStudentApplication(first, ["수학", "수학"]), /가능한 과목/);
  c.saveStudentApplication(first, ["수학"]);
  c.saveStudentApplication(first, ["수학"]);
  assert.equal(s.books.get("0").getSheetByName("신청").rows.length, 2);
  assert.deepEqual(plain(c.getStudentApplication(second)).selections, []);
  c.setApplicationOpen(s.key, false);
  assert.throws(() => c.saveStudentApplication(second, ["과학"]), /마감/);
  assert.equal(c.getStudentApplication(first).open, false);
  c.setApplicationOpen(s.key, true);
  c.saveStudentApplication(second, ["과학"]);
  const exported = JSON.parse(c.exportCourseData(s.key, "results"));
  assert.equal(exported.round, "2");
  assert.equal(exported.entries.length, 2);
  assert.equal("code" in exported.entries[0], false);
  const mergeCtx = vm.createContext({ collectApplicationSubjects: () => setup().subjects });
  vm.runInContext(functionSource("function mergeApplications(", "function downloadApplicationForm("), mergeCtx);
  const merged = plain(mergeCtx.mergeApplications(exported.entries));
  assert.equal(merged.errors.length, 0);
  assert.equal(merged.students.length, 2);
  assert.equal(merged.students[0].totalCredits, 3);
  assert.equal(s.locks(), 0);
});

test("student web HTML includes no administrator key or roster; invalid admin is rejected", () => {
  const s = server(), c = s.context;
  c.uploadCourseSetup(s.key, JSON.stringify(setup()));
  const output = c.doGet({ parameter: {} });
  const content = output.content;
  assert.equal(output.frameMode, "ALLOWALL");
  assert.ok(!content.includes(s.key));
  assert.ok(!content.includes("가상학생1"));
  const clientScript = content.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(clientScript);
  assert.throws(() => c.doGet({ parameter: { admin: "wrong" } }), /인증/);
  const admin = c.doGet({ parameter: { admin: s.key } });
  assert.ok(admin.content.includes(s.key));
  assert.equal(admin.frameMode, "DEFAULT");
});

test("school link carries only a validated server endpoint and rejects secrets or foreign hosts", () => {
  const ctx = vm.createContext({ URL, URLSearchParams });
  vm.runInContext(functionSource("function normalizeApplicationServerUrl(", "function showStudentApplicationEntry("), ctx);
  const endpoint = "https://script.google.com/macros/s/Abc_123-xyz/exec";
  const link = new URL(ctx.buildSchoolApplicationLink(endpoint, "https://school.example/app/?admin=secret#old"));
  assert.equal(link.origin, "https://school.example");
  assert.equal(link.search, "");
  assert.equal(new URLSearchParams(link.hash.slice(1)).get("apply"), endpoint);
  assert.ok(!link.href.includes("secret"));
  for (const bad of [
    endpoint + "?admin=secret", endpoint + "#key", endpoint.replace("/exec", "/dev"),
    endpoint.replace("https:", "http:"), endpoint.replace("script.google.com", "evil.example"),
    endpoint.replace("script.google.com", "script.google.com.evil.example"),
    endpoint.replace("script.google.com", "user@script.google.com"),
    "javascript:alert(1)", "not a url",
  ]) assert.throws(() => ctx.normalizeApplicationServerUrl(bad));
  assert.throws(() => ctx.buildSchoolApplicationLink(endpoint, "file:///C:/app/index.html"), /게시된 웹사이트/);
});

test("student entry hides administrator workspace and invalid link never loads a frame", () => {
  const endpoint = "https://script.google.com/macros/s/Abc123/exec";
  const elements = {};
  function element(selector) {
    if (!elements[selector]) {
      const classes = new Set(selector === ".workspace" ? [] : ["hidden"]);
      elements[selector] = {
        classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
      };
    }
    return elements[selector];
  }
  const ctx = vm.createContext({
    URL, URLSearchParams, document: { title: "" }, $: element,
    window: { location: { hash: "" } },
  });
  vm.runInContext(functionSource("function normalizeApplicationServerUrl(", "async function handleApplicationRoster("), ctx);
  assert.equal(ctx.showStudentApplicationEntry(), false);
  ctx.window.location.hash = "#" + new URLSearchParams({ apply: endpoint });
  assert.equal(ctx.showStudentApplicationEntry(), true);
  assert.equal(element(".workspace").classList.contains("hidden"), true);
  assert.equal(element("#studentApplicationFrame").src, endpoint);
  assert.equal(element("#studentApplicationFallback").href, endpoint);
  delete elements["#studentApplicationFrame"];
  ctx.window.location.hash = "#apply=https%3A%2F%2Fevil.example";
  assert.equal(ctx.showStudentApplicationEntry(), true);
  assert.equal(element("#studentApplicationFrame").src, undefined);
  assert.match(element("#studentEntryError").textContent, /Apps Script|管理者|관리자/);
});

test("result bundle import checks round and reports empty results without changing records", async () => {
  const ctx = vm.createContext({
    state: { currentRound: "2" }, status: { style: {}, textContent: "" },
    applyMergedApplications(entries) { ctx.merged = plain(entries); },
  });
  vm.runInContext(functionSource("async function handleApplicationFiles(", "function buildAppsScriptCode("), ctx);
  const file = (data) => ({ name: "results.json", text: async () => JSON.stringify(data) });
  await ctx.handleApplicationFiles([file({ type: "course-application-results", round: "1", entries: [{}] })]);
  assert.match(ctx.status.textContent, /차수로 전환/);
  assert.equal(ctx.merged, undefined);
  await ctx.handleApplicationFiles([file({ type: "course-application-results", round: "2", entries: [] })]);
  assert.match(ctx.status.textContent, /비어/);
  await ctx.handleApplicationFiles([file({ type: "course-application-results", round: "2", entries: setup().roster })]);
  assert.equal(ctx.merged.length, 2);
});

function aggregateSheetFixture() {
  const ctx = vm.createContext({ $: (selector) => ({ value: { "#confirmDate": "2026. 11. 6.", "#round": "1차" }[selector] || "" }) });
  vm.runInContext(functionSource("function xmlEscape(", "function createStylesXml("), ctx);
  vm.runInContext(functionSource("function createStylesXml(", "function crc32("), ctx);
  const course = (column, name, enrollment, classCount, closed = false) => ({ column, name, displayName: name, enrollment, classCount, closed,
    enrollmentPerDivision: enrollment / 16.5, averageClassSize: classCount ? enrollment / classCount : 0 });
  // 30명 2학급: 학급당 15, 개설기준 13.5, 분반기준 16.5
  const report = { summary: { grade: "1", students: 30, classes: 2, averageClassSize: 15, openingLimit: 13.5, divisionLimit: 16.5 },
    semesters: [{ name: "2학년 1학기", groups: [
      { category: "2-1 택3", choiceCount: 3, courses: [
        course(1, "과목1", 30, 2), course(2, "과목2", 30, 2), course(3, "과목3", 20, 2), course(4, "과목4", 5, 0, true),
        course(5, "과목5", 5, 1), course(6, "과목6", 0, 0), course(7, "과목7", 0, 0)] },
      { category: "2-1 택1", choiceCount: 1, courses: [course(8, "일본어", 20, 1), course(9, "기후변화와 지속가능한 세계(융합)", 10, 1)] }
    ] }] };
  const xml = ctx.createWorksheetXml(report, 90, 110);
  const cells = new Map([...xml.matchAll(/<c r="([A-Z]+\d+)" s="(\d+)"(?: t="inlineStr")?(?:\/>|>(?:<f>([^<]*)<\/f>)?(?:<v>([^<]*)<\/v>|<is><t[^>]*>([^<]*)<\/t><\/is>)<\/c>)/g)]
    .map((match) => [match[1], { style: Number(match[2]), formula: match[3], value: match[4] ?? match[5] }]));
  const merges = [...xml.matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map((match) => match[1]);
  return { ctx, xml, cells, merges };
}

test("the aggregate sheet follows the school template: title, formula criteria and 5-row blocks under one group heading", () => {
  const { xml, cells } = aggregateSheetFixture();
  const value = (reference) => cells.get(reference)?.value;
  const formula = (reference) => cells.get(reference)?.formula;
  assert.deepEqual([...xml.matchAll(/<col [^>]*width="([\d.]+)"/g)].map((match) => Number(match[1])),
    [6.375, 14.75, 16.375, 14.375, 15.75, 16.375, 16.75, 17.625, 10.25, 12], "the template column widths");
  assert.equal(value("B1"), "2학년(현1학년) 수강신청결과(1차)");
  assert.equal(value("J1"), "2026.11.");
  assert.equal(value("C2"), "30");
  assert.equal(formula("E2"), "C2/2", "students per class from the class count");
  assert.equal(formula("H2"), "C2/2*0.9", "opening criterion uses the set percent");
  assert.equal(formula("H3"), "C2/2*1.1", "division criterion uses the set percent");
  assert.equal(value("H3"), "16.5");
  assert.equal(value("B4"), "2학년 1학기");
  // 그룹 이름은 블록 위 소제목 줄에 한 번만, 두 묶음(7과목 → 4+3)의 머리 칸은 모두 '과목'.
  assert.equal(value("B5"), "2-1 택3");
  assert.equal([...cells.values()].filter((cell) => cell.value === "2-1 택3").length, 1);
  assert.equal(value("B6"), "과목");
  assert.deepEqual(["B7", "B8", "B9", "B10"].map(value), ["인원 수", "인원수/분반기준", "개설 학급수", "학급당 학생수"]);
  assert.equal(value("B11"), "과목");
  assert.deepEqual(["C6", "D6", "E6", "F6", "C11", "D11", "E11"].map(value), ["과목1", "과목2", "과목3", "과목4", "과목5", "과목6", "과목7"]);
  assert.equal(formula("C8"), "C7/$H$3", "enrollment per division points at the division criterion cell");
  assert.equal(formula("C10"), "C7/C9");
  assert.equal(value("C9"), "2", "class counts are the app values");
  assert.equal(value("F8"), "폐강");
  assert.equal(value("F9"), "0", "a closed course has 0 classes");
  assert.equal(value("F10"), undefined, "no division by zero for a closed course");
  assert.ok(cells.has("F10") && cells.has("F11") && cells.has("F15"), "empty block cells still carry the bordered style");
  assert.equal(value("G6"), "총 학급수");
  assert.equal(formula("G7"), "SUM(C9:F9,C14:F14)");
  assert.equal(value("G7"), "7");
  assert.equal(value("H6"), "신청 합÷택3");
  assert.equal(formula("H7"), "SUM(C7:F7,C12:F12)/3");
  assert.equal(value("H7"), "30");
  // 블록 사이 빈 행은 모두 같은 높이.
  assert.match(xml, /<row r="16" ht="18" customHeight="1"><\/row>/);
  assert.equal(value("B17"), "2-1 택1");
  assert.equal(formula("E19"), "SUM(C21:D21)");
  assert.equal(formula("F19"), "SUM(C19:D19)/1");
  const rowHeight = (row) => Number(xml.match(new RegExp(`<row r="${row}" ht="([\\d.]+)"`))[1]);
  assert.equal(rowHeight(6), 18.75, "short subject names keep the template header height");
  assert.ok(rowHeight(18) >= 37.5, "a long subject name gets a taller header row");
  assert.match(xml, /<cfRule type="cellIs" dxfId="0" priority="1" operator="notEqual"><formula>6<\/formula>/, "total ≠ 택3 × 2학급 is highlighted");
  assert.match(xml, /orientation="portrait" fitToWidth="1" fitToHeight="0"/);
});

test("aggregate sheet merges line up with every block row and never overlap, and every style exists", () => {
  const { ctx, xml, cells, merges } = aggregateSheetFixture();
  for (const reference of ["B1:G1", "F2:G2", "F3:G3", "I2:J3", "B4:C4", "G7:G15", "H7:H15", "E19:E22", "F19:F22"]) {
    assert.ok(merges.includes(reference), `${reference} is merged`);
  }
  const decode = (reference) => {
    const [, letters, row] = reference.match(/([A-Z]+)(\d+)/);
    return [[...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0), Number(row)];
  };
  const covered = new Map();
  for (const range of merges) {
    const [from, to] = range.split(":").map(decode);
    for (let column = from[0]; column <= to[0]; column++) {
      for (let row = from[1]; row <= to[1]; row++) {
        assert.ok(!covered.has(`${column}:${row}`), `${range} overlaps ${covered.get(`${column}:${row}`)}`);
        covered.set(`${column}:${row}`, range);
        assert.ok(cells.has(`${ctx.columnName(column - 1)}${row}`), `merged cell ${column}:${row} keeps its border style`);
      }
    }
  }
  const styles = ctx.createStylesXml();
  const xfCount = Number(styles.match(/<cellXfs count="(\d+)"/)[1]);
  assert.equal((styles.match(/<cellXfs[\s\S]*<\/cellXfs>/)[0].match(/<xf /g) || []).length, xfCount);
  assert.ok(Math.max(...[...cells.values()].map((cell) => cell.style)) < xfCount, "every cell style is defined");
  assert.match(styles, /<dxfs count="1">/);
  // 다른 내려받기가 쓰는 앞쪽 서식 번호(2: 굵은 머리글, 7: 본문)는 그대로다.
  assert.match(styles, /<cellXfs count="\d+">\s*<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"\/>/);
  const extras = ctx.aggregateWorkbookExtrasXml([{ name: "2학년", printTitles: "$1:$3", xml }, { name: "다른 시트", xml: "" }]);
  assert.match(extras, /<definedName name="_xlnm.Print_Area" localSheetId="0">'2학년'!\$B\$1:\$J\$22<\/definedName>/);
  assert.match(extras, /<definedName name="_xlnm.Print_Titles" localSheetId="0">'2학년'!\$1:\$3<\/definedName>/);
  assert.doesNotMatch(extras, /localSheetId="1"/, "sheets without print titles are left alone");
  assert.match(extras, /fullCalcOnLoad="1"/);
  assert.equal(ctx.aggregateSheetName({ summary: { grade: "2" } }), "3학년");
});

test("the step-4 screen draws the same school sheet as the Excel file: cells, merges, yellow closed cells and the off-target fill", () => {
  const { ctx, merges } = aggregateSheetFixture();
  vm.runInContext(functionSource("function aggregateThresholds(", "function renderAggregate("), ctx);
  ctx.escapeHtml = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // 같은 보고서로 모델 → 엑셀(XML)과 화면(HTML)을 만든다.
  const source = ctx.createWorksheetXml.toString();
  assert.match(source, /aggregateSheetModel\(report, openingPercent, divisionPercent\)/, "Excel uses the shared sheet model");
  const sample = { summary: { grade: "1", students: 30, classes: 2, averageClassSize: 15, openingLimit: 13.5, divisionLimit: 16.5, classSource: "roster" },
    semesters: [{ name: "2학년 1학기", groups: [
      { category: "2-1 택3", choiceCount: 3, courses: [
        ["과목1", 30, 2], ["과목2", 30, 2], ["과목3", 20, 2], ["과목4", 5, 0, true], ["과목5", 5, 1], ["과목6", 0, 0], ["과목7", 0, 0]]
        .map(([name, enrollment, classCount, closed = false], index) => ({ column: index + 1, name, displayName: name, enrollment, classCount, closed,
          atRisk: enrollment < 13.5, enrollmentPerDivision: enrollment / 16.5, averageClassSize: classCount ? enrollment / classCount : 0 })) },
      { category: "2-1 택1", choiceCount: 1, courses: [["일본어", 20, 1], ["기후변화와 지속가능한 세계(융합)", 10, 1]]
        .map(([name, enrollment, classCount], index) => ({ column: index + 8, name, displayName: name, enrollment, classCount, closed: false,
          atRisk: enrollment < 13.5, enrollmentPerDivision: enrollment / 16.5, averageClassSize: enrollment / classCount })) }
    ] }] };
  const xml = ctx.createWorksheetXml(sample, 90, 110);
  assert.equal(xml, ctx.createWorksheetXml(sample, 90, 110));
  const html = ctx.aggregateSheetHtml(ctx.aggregateSheetModel(sample, 90, 110), { grade: "1", closures: { "1:4": "closed" }, round: "1", maxClassSize: 34 });
  // HTML 표를 칸 좌표(엑셀 열·행)로 펼친다. A열(여백)은 화면에 그리지 않으므로 B열부터.
  const grid = new Map();
  const spans = [];
  const taken = new Set();
  [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].forEach((rowMatch, rowIndex) => {
    let column = 1;
    for (const cell of rowMatch[1].matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)) {
      while (taken.has(`${rowIndex + 1}:${column}`)) column++;
      const colspan = Number(cell[1].match(/colspan="(\d+)"/)?.[1] || 1);
      const rowspan = Number(cell[1].match(/rowspan="(\d+)"/)?.[1] || 1);
      for (let r = 0; r < rowspan; r++) for (let c = 0; c < colspan; c++) taken.add(`${rowIndex + 1 + r}:${column + c}`);
      if (colspan > 1 || rowspan > 1) spans.push(`${ctx.columnName(column)}${rowIndex + 1}:${ctx.columnName(column + colspan - 1)}${rowIndex + rowspan}`);
      const input = cell[2].match(/<input[^>]*value="([^"]*)"/);
      // 칸 글자: 모서리 표시·단추·목표 안내를 빼고 엑셀 칸 값만 본다.
      const value = input ? input[1] : cell[2].replace(/<span class="af-corner[\s\S]*?<\/span><\/span>|<span class="af-corner[\s\S]*?<\/span>/g, "")
        .replace(/<span class="af-total-target">[\s\S]*?<\/span>|<button type="button" class="af-mini-button"[\s\S]*?<\/button>|<span class="af-group-(?:diff|ok)">[\s\S]*?<\/span>/g, "")
        .replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
      grid.set(`${ctx.columnName(column)}${rowIndex + 1}`, { value, attrs: cell[1] });
      column += colspan;
    }
  });
  // 병합: 화면의 colspan/rowspan = 엑셀 mergeCells
  const xmlMerges = [...xml.matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map((match) => match[1]).sort();
  assert.deepEqual(spans.sort(), xmlMerges);
  assert.ok(merges.length > 0 && xmlMerges.includes("G7:G15"));
  // 값: 엑셀의 모든 글자·숫자 칸이 화면 같은 자리에 같은 표시 형식으로 있다.
  const xmlCells = new Map([...xml.matchAll(/<c r="([A-Z]+\d+)" s="(\d+)"(?: t="inlineStr")?(?:\/>|>(?:<f>([^<]*)<\/f>)?(?:<v>([^<]*)<\/v>|<is><t[^>]*>([^<]*)<\/t><\/is>)<\/c>)/g)]
    .map((match) => [match[1], { style: Number(match[2]), number: match[4], text: match[5] }]));
  const styles = ctx.aggregateSheetStyles().list;
  let compared = 0;
  for (const [reference, cell] of xmlCells) {
    if (reference.startsWith("A")) continue;
    const shown = grid.get(reference);
    if (cell.text === undefined && cell.number === undefined) continue;
    assert.ok(shown, `${reference} is on screen`);
    const [, format] = styles[cell.style - 11].split("|");
    const expected = cell.text !== undefined ? cell.text.replace(/&amp;/g, "&")
      : format === "two" ? Number(cell.number).toFixed(2) : format === "one" ? Number(cell.number).toFixed(1) : String(Number(cell.number));
    assert.equal(shown.value, expected, `${reference}`);
    // 노란 칸(개설기준·폐강 과목의 인원 수·분반기준 칸)도 같은 자리에 있다.
    assert.equal(/\baf-yellow\b/.test(shown.attrs), styles[cell.style - 11].split("|")[2] === "yellow", `${reference} fill`);
    compared++;
  }
  assert.ok(compared >= 60, `compared ${compared} cells`);
  assert.equal(grid.get("F8").value, "폐강");
  assert.match(grid.get("F9").attrs, /data-af-role="classes"/);
  assert.match(html, /<input class="aggregate-class-input af-class-input" type="number" min="0" step="1" value="0" aria-label="2학년 1학기 과목4 개설 학급수 \(폐강\)"[^>]* disabled/, "a closed course keeps 0 classes, locked");
  assert.match(html, /value="2" aria-label="2학년 1학기 과목1 개설 학급수" data-grade="1" data-course-column="1" data-focus-key="aggregate-class:1:1">/, "open courses are editable in place (focus key keeps focus across redraws)");
  // 엑셀 조건부 서식(총 학급수 ≠ 택n × 학급 수, 신청 합÷택n ≠ 총학생수)과 같은 칸이 연한 주황.
  assert.match(grid.get("G7").attrs, /\baf-off\b/, "7 classes ≠ 택3 × 2");
  assert.doesNotMatch(grid.get("E19").attrs, /\baf-off\b/, "2 classes = 택1 × 2");
  assert.doesNotMatch(grid.get("F19").attrs, /\baf-off\b/, "택1 신청 합 30 = 총학생수 30");
  assert.doesNotMatch(grid.get("H7").attrs, /\baf-off\b/, "택3 신청 합 90 ÷ 3 = 30");
  // 열 너비는 엑셀과 같은 비율, 행 높이는 엑셀 높이 비례.
  const widths = [...html.matchAll(/<col style="width:([\d.]+)%">/g)].map((match) => Number(match[1]));
  assert.equal(widths.length, 9);
  assert.ok(Math.abs(widths[0] / widths[6] - Math.floor(14.75 * 8 + 5) / Math.floor(17.625 * 8 + 5)) < 0.001);
  assert.match(html, /<tr style="height:66px">/, "title row 54.6pt");
});

test("aggregate sheet splits large groups evenly, six subjects at most per row", () => {
  const ctx = vm.createContext({ $: () => ({ value: "" }) });
  vm.runInContext(functionSource("function xmlEscape(", "function createStylesXml("), ctx);
  const courses = Array.from({ length: 16 }, (_, index) => ({ column: index, name: `과목${index + 1}`, enrollment: 10, classCount: 1, closed: false }));
  const report = { summary: { grade: "2", students: 32, classes: 1, openingLimit: 28.8, divisionLimit: 35.2 },
    semesters: [{ name: "3학년 1학기", groups: [{ category: "3-1 택5", choiceCount: 5, courses }] }] };
  const xml = ctx.createWorksheetXml(report, 90, 110);
  const text = (reference) => xml.match(new RegExp(`<c r="${reference}"[^>]*><is><t[^>]*>([^<]*)</t>`))?.[1];
  // 16과목 → 6 + 5 + 5, 총 학급수는 I열(과목 6열 오른쪽), 세 묶음 15행에 걸쳐 병합
  assert.equal(text("H6"), "과목6");
  assert.equal(text("C11"), "과목7");
  assert.equal(text("G11"), "과목11");
  assert.equal(text("H11"), undefined);
  assert.equal(text("C16"), "과목12");
  assert.equal(text("I6"), "총 학급수");
  assert.match(xml, /<mergeCell ref="I7:I20"\/>/);
  assert.match(xml, /<mergeCell ref="J7:J20"\/>/);
  assert.match(xml, /<f>SUM\(C9:H9,C14:H14,C19:H19\)<\/f><v>16<\/v>/);
  assert.match(xml, /<f>SUM\(C7:H7,C12:H12,C17:H17\)\/5<\/f><v>32<\/v>/);
  assert.equal(ctx.aggregateTextLines("과목1", 16.375), 1);
  assert.equal(ctx.aggregateTextLines("세계시민과 지리(일반)", 16.375, 12, true), 2);
});

test("4단계 집계표 과목명은 괄호를 한 번만: 두 학기 과목은 '(1학기)' 하나만(학기 구분), 그 밖은 '(융합)' 그대로", () => {
  const ctx = vm.createContext({ curriculumSelectionType: (type) => String(type || "") });
  vm.runInContext(functionSource("function applicationCourseLabel(", "function renderApplicationSubjects("), ctx);
  vm.runInContext(functionSource("function aggregateCourseDisplayName(", "function currentStudent("), ctx);
  const subject = { subject: "과학의 역사와 문화 (1학기)", type: "융합선택" };
  assert.equal(ctx.applicationCourseLabel(subject), "과학의 역사와 문화 (1학기)(융합)", "예전 표기(괄호 두 번)");
  assert.equal(ctx.aggregateCourseDisplayName(subject, "1"), "과학의 역사와 문화 (1학기)", "같은 이름 두 학기 행을 구분");
  assert.equal(ctx.aggregateCourseDisplayName({ ...subject, subject: "과학의 역사와 문화 (2학기)" }, "2"), "과학의 역사와 문화 (2학기)");
  assert.equal(ctx.aggregateCourseDisplayName(subject, ""), "과학의 역사와 문화 (1학기)");
  assert.equal(ctx.aggregateCourseDisplayName({ subject: "법과 사회", type: "진로선택" }, "2"), "법과 사회(진로)", "꼬리표 없는 과목은 그대로");
  assert.match(functionSource("function aggregateRecords(", "function currentStudent("), /aggregateCourseDisplayName\(applicationSubject, semesterKey\)/,
    "화면·엑셀 집계표(aggregateSheetModel)가 함께 쓰는 displayName");
});

test("aggregate skips separate (소인수·공동) course columns left in older results, by name too", () => {
  const ctx=vm.createContext({
    collectApplicationSubjects:()=>({"1":[],"2":[{subject:"물리학",semester:"1"},{subject:"고급 물리학",semester:"1",separate:true}],"3":[]}),
    getApplicationGroupSettings:()=>[], UNASSIGNED_GROUP:"미분류"
  });
  vm.runInContext(functionSource("function applicationSeparateNames(", "function aggregateCourseDisplayName("),ctx);
  // 예전 결과: 과목 열에 applicationSubject가 없고 이름만 있다.
  assert.equal(ctx.isApplicationSeparateCourse({name:"고급 물리학(진로)"},"1"),true);
  assert.equal(ctx.isApplicationSeparateCourse({name:"물리학"},"1"),false);
  assert.equal(ctx.isApplicationSeparateCourse({name:"고급 물리학"},"2"),false,"현 2학년(3학년 과목)에는 없는 과목");
  assert.equal(ctx.isApplicationSeparateCourse({name:"고급 물리학",applicationGroupSource:"online"},"1"),false,"웹 결과는 편제표를 다시 읽지 않음");
  vm.runInContext(functionSource("function parseCourseGroup(", "function courseIndexByColumn("),ctx);
  vm.runInContext(functionSource("function aggregateRecords(", "function currentStudent("),ctx);
  vm.runInContext(functionSource("function applicationCourseLabel(", "function renderApplicationSubjects("),ctx);
  ctx.curriculumSelectionType=(value)=>String(value||"");
  const courses=[{column:1,name:"물리학",credits:3,semesterKey:"1"},{column:2,name:"고급 물리학",credits:3,semesterKey:"1"}];
  const students=[1,2,3].map((number)=>({grade:"1",classroom:"1",number:String(number),name:`가상${number}`,selections:courses.slice(),totalCredits:6}));
  const aggregate=ctx.aggregateRecords(students,courses,90,110);
  const names=aggregate.reports.flatMap((report)=>report.semesters.flatMap((semester)=>semester.groups.flatMap((group)=>group.courses.map((course)=>course.name))));
  assert.deepEqual(plain(names),["물리학"]);
});

test("step 2 subject list shows a two-semester course once per semester, like the selection groups", () => {
  const container = { innerHTML: "" };
  const ctx = vm.createContext({
    state: { applicationMenuGrade: "2" },
    $: (selector) => selector === "#applicationSubjectList" ? container : { value: "2026" },
    escapeHtml: (value) => String(value), applicationCohortYear: () => "2025",
    collectApplicationSubjects: () => ({ "1": [], "2": [], "3": [
      { subject: "기하", semester: "1", type: "진로선택", area: "수학", credit: 3 },
      { subject: "융합과학 탐구", semester: "1·2", type: "융합선택", area: "과학", credit: 3 },
      { subject: "여행지리", semester: "2", type: "융합선택", area: "사회", credit: 3 }
    ] })
  });
  vm.runInContext(functionSource("function renderApplicationSubjects(", "function buildApplicationPageHtml("), ctx);
  ctx.renderApplicationSubjects();
  const columns = container.innerHTML.split('<section class="application-semester-column">').slice(1);
  assert.match(columns[0], /1학기 <span>2과목<\/span>/);
  assert.match(columns[0], /융합과학 탐구 \(1학기\)/);
  assert.match(columns[1], /2학기 <span>2과목<\/span>/);
  assert.match(columns[1], /융합과학 탐구 \(2학기\)/);
  assert.doesNotMatch(container.innerHTML, /1·2/);
});

test("result validation drops 소인수·공동 courses silently: no notice, not 'missing', not 'unclassified'", () => {
  const importer = fs.readFileSync(path.join(__dirname, "..", "result-import.js"), "utf8");
  const ctx = vm.createContext({ classifyApplicationRecords: () => [], getApplicationGroupSettings: () => [] });
  vm.runInContext(importer.slice(importer.indexOf("function normalizeResultCourseName("), importer.indexOf("function buildResultImportPreview(")), ctx);
  ctx.resultExampleList = (items) => items.join(", ");
  const course = (column, name) => ({ column, name, credits: 3 });
  const candidate = { skippedRows: [], data: {
    courses: [course(1, "물리학"), course(2, "경제")],
    students: [{ grade: "1", classroom: "1", number: "1", name: "가상", selections: [course(1, "물리학"), course(2, "경제")], totalCredits: 6 }]
  } };
  const subjects = { "2": [{ subject: "물리학" }, { subject: "경제", separate: true }, { subject: "보건", separate: true }] };
  const result = ctx.analyzeResultCandidate(candidate, { grade: "1", subjects, cohortYear: "2026" });
  const text = [...result.issues.warnings, ...result.issues.info].join("\n");
  assert.doesNotMatch(text, /소인수|공동|따로 신청|경제|보건/, "소인수·공동은 안내 없이 조용히 뺀다");
  assert.doesNotMatch(text, /결과 파일에 없는 과목/, "소인수·공동 과목만 없으면 '없는 과목' 줄은 없다");
  assert.deepEqual(plain(result.data.courses.map((course) => course.name)), ["물리학"]);
});

// 같은 과목 한 학기만(학기제): 같은 과목이 1·2학기에 모두 나오면 편제표 다른 행이든 한 행이 두 학기에 걸치든 sameCourseOnce.
function sameCourseContext() {
  const contexts = [
    { subject: "융합과학 탐구", division: "학생선택교육과정", detail: "융합", selectionType: "융합선택", row: [3, 3, ""], grade: "3", area: "과학", rowIndex: 5 },
    { subject: "기하", division: "학생선택교육과정", detail: "진로", selectionType: "진로선택", row: [3, 3, ""], grade: "3", area: "수학", rowIndex: 6 },
    { subject: "융합과학 탐구", division: "학생선택교육과정", detail: "융합", selectionType: "융합선택", row: [3, "", 3], grade: "3", area: "과학", rowIndex: 9 },
    { subject: "한 행 두 학기", division: "학생선택교육과정", detail: "일반", selectionType: "일반선택", row: [6, 3, 3], grade: "3", area: "과학", rowIndex: 12 }
  ];
  const ctx = vm.createContext({
    state: { curriculumCohortYear: "2025", curriculumImportedLayout: {}, applicationMenuGrade: "2" },
    importedPlanColumnMap: () => ({ subject: 0, opCredit: 0, semesters: [-1, -1, -1, -1, 1, 2] }),
    importedPlanCourseContexts: () => contexts, curriculumCellFill: () => ""
  });
  vm.runInContext(functionSource("function collectApplicationSubjects(", "function renderApplicationSubjects("), ctx);
  return ctx;
}

test("a course offered in both semesters is once-only, whether from two plan rows or one row spanning both semesters", () => {
  const ctx = sameCourseContext();
  const items = ctx.collectApplicationSubjects({ currentGrade: "2" })["3"];
  const byName = Object.fromEntries(items.map((item) => [item.subject, item]));
  assert.equal(byName["융합과학 탐구"].semester, "1·2");
  assert.equal(byName["융합과학 탐구"].sameCourseOnce, true);
  assert.equal(byName["한 행 두 학기"].semester, "1·2");
  assert.equal(byName["한 행 두 학기"].sameCourseOnce, true, "한 행이 두 학기로 나뉘어도 한 학기만(학기제)");
  assert.equal(byName["기하"].sameCourseOnce, undefined);
});

test("results: a student who picked a once-only course in both semesters is found (wide results by name, merged results by flag)", () => {
  const ctx = sameCourseContext();
  vm.runInContext(functionSource("function applicationSeparateNames(", "function aggregateCourseDisplayName("), ctx);
  vm.runInContext(functionSource("function mergeApplications(", "function downloadApplicationForm("), ctx);
  const course = (column, name, semesterKey = "") => ({ column, name, semesterKey, credits: 3 });
  const twice = { grade: "2", classroom: "1", number: "1", name: "가상", selections: [course(1, "융합과학 탐구 (1학기)", "1"), course(2, "융합과학 탐구(2학기)"), course(3, "기하")] };
  assert.deepEqual(plain(ctx.applicationSameCourseTwice(twice)), [{ name: "융합과학 탐구", semesters: ["1", "2"] }]);
  const once = { grade: "2", classroom: "1", number: "2", name: "가상", selections: [course(1, "융합과학 탐구 (1학기)", "1"), course(3, "기하")] };
  assert.deepEqual(plain(ctx.applicationSameCourseTwice(once)), []);
  const single = { grade: "2", classroom: "1", number: "3", name: "가상", selections: [course(4, "한 행 두 학기 (1학기)", "1"), course(5, "한 행 두 학기 (2학기)", "2")] };
  assert.deepEqual(plain(ctx.applicationSameCourseTwice(single)), [{ name: "한 행 두 학기", semesters: ["1", "2"] }], "한 행이 두 학기로 나뉜 과목도 두 학기 신청이면 찾는다");
  // 웹 결과(online)는 지금 편제표를 다시 읽지 않고 서버 과목 목록의 표시만 본다.
  const online = { grade: "2", selections: [{ ...course(1, "융합과학 탐구 (1학기)", "1"), applicationGroupSource: "online" }, { ...course(2, "융합과학 탐구 (2학기)", "2"), applicationGroupSource: "online" }] };
  assert.deepEqual(plain(ctx.applicationSameCourseTwice(online)), []);
  online.selections[0].applicationSubject = { subject: "융합과학 탐구 (1학기)", sameCourseOnce: true };
  online.selections[1].applicationSubject = { subject: "융합과학 탐구 (2학기)", sameCourseOnce: true };
  assert.equal(ctx.applicationSameCourseTwice(online).length, 1);
  // 오프라인·구글폼 취합(mergeApplications): 과목 객체에 sameCourseOnce가 실린다.
  const merged = ctx.mergeApplications([{ grade: "2", classroom: "1", number: "1", name: "가상", selections: ["융합과학 탐구 (1학기)", "융합과학 탐구 (2학기)", "기하"] }],
    ctx.collectApplicationSubjects({ includeExcluded: true, currentGrade: "2" }));
  assert.deepEqual(plain(merged.errors), []);
  assert.equal(ctx.applicationSameCourseTwice(merged.students[0]).length, 1);
});

// 학기제: 편제표 한 행에 학기 칸 3·3(운영학점 6)으로 적힌 묶음 밖 과목을 학기로 나눠 신청하면 그 줄의 학점은 학기 칸 값(3).
test("a one-row two-semester course carries per-semester credits; split lines and merged results use the semester cell value", () => {
  const ctx = sameCourseContext();
  vm.runInContext(functionSource("function applicationSeparateNames(", "function aggregateCourseDisplayName("), ctx);
  vm.runInContext(functionSource("function mergeApplications(", "function downloadApplicationForm("), ctx);
  const subjects = ctx.collectApplicationSubjects({ includeExcluded: true, currentGrade: "2" });
  const byName = Object.fromEntries(subjects["3"].map((item) => [item.subject, item]));
  assert.equal(byName["한 행 두 학기"].credit, 6, "행 학점(운영학점)은 그대로 둔다");
  assert.deepEqual(plain(byName["한 행 두 학기"].semesterCredits), { "1": 3, "2": 3 });
  assert.equal(byName["한 행 두 학기"].onceCredit, 3);
  assert.equal(byName["기하"].credit, 3, "학기 하나인 과목은 그대로");
  assert.equal(byName["기하"].onceCredit, undefined);
  const merged = ctx.mergeApplications([
    { grade: "2", classroom: "1", number: "1", name: "가상", selections: ["한 행 두 학기 (1학기)", "기하"] },
    { grade: "2", classroom: "1", number: "2", name: "가상둘", selections: ["한 행 두 학기"] }
  ], subjects);
  assert.deepEqual(plain(merged.errors), []);
  const first = merged.students.find((student) => student.number === "1");
  const picked = Object.fromEntries(first.selections.map((course) => [course.name, course]));
  assert.equal(picked["한 행 두 학기 (1학기)"].credits, 3, "학기로 나눈 줄 = 학기 칸 학점");
  assert.equal(picked["한 행 두 학기 (1학기)"].applicationSubject.credit, 3);
  assert.equal(picked["기하"].credits, 3);
  assert.equal(first.totalCredits, 6);
  const second = merged.students.find((student) => student.number === "2");
  assert.equal(second.selections[0].credits, 3, "학기 없이 고른 경우도 학기 칸 값이 같으면 그 값(한 학기만 듣는다)");
  // 두 학기 과목을 아무도 고르지 않으면 학기 없는 0명 과목(4단계 '미분류')을 남기지 않는다.
  const nobody = ctx.mergeApplications([{ grade: "2", classroom: "1", number: "3", name: "가상셋", selections: ["기하"] }], subjects);
  assert.ok(!nobody.courses.some((course) => /^한 행 두 학기/.test(course.name)), plain(nobody.courses.map((course) => course.name)).join(","));
  assert.ok(!nobody.courses.some((course) => course.name === "융합과학 탐구"));
});

test("choice-block (택n) semesters keep the row credit; only free semesters take the semester cell value", () => {
  const ctx = sameCourseContext();
  ctx.curriculumChoiceBlocks = () => [{ startRow: 12, endRow: 12, grade: "3", semester: "1", credit: 4 }];
  vm.runInContext(functionSource("function mergeApplications(", "function downloadApplicationForm("), ctx);
  const subjects = ctx.collectApplicationSubjects({ includeExcluded: true, currentGrade: "2" });
  const item = subjects["3"].find((entry) => entry.subject === "한 행 두 학기");
  assert.deepEqual(plain(item.semesterCredits), { "2": 3 }, "묶음 학기는 학기 칸 학점을 쓰지 않는다");
  assert.equal(item.onceCredit, undefined);
  const merged = ctx.mergeApplications([{ grade: "2", classroom: "1", number: "1", name: "가상", selections: ["한 행 두 학기 (1학기)", "한 행 두 학기 (2학기)"] }], subjects);
  const picked = Object.fromEntries(merged.students[0].selections.map((course) => [course.name, course.credits]));
  assert.deepEqual(plain(picked), { "한 행 두 학기 (1학기)": 6, "한 행 두 학기 (2학기)": 3 });
});

test("selection groups and the step-2 list split two-semester courses with the semester credit", () => {
  const groups = fs.readFileSync(path.join(__dirname, "..", "course-groups.js"), "utf8");
  assert.match(groups, /credit: semesters\.length > 1 \? \(course\.semesterCredits\?\.\[semester\] \|\| course\.credit\) : course\.credit/);
  assert.match(frontend, /subject: `\$\{item\.subject\} \(\$\{key\}학기\)`, credit: item\.semesterCredits\?\.\[key\] \|\| item\.credit/);
});

test("result validation shows a red (non-blocking) error for same course in two semesters and asks with the app dialog before importing", async () => {
  const importer = fs.readFileSync(path.join(__dirname, "..", "result-import.js"), "utf8");
  const ctx = vm.createContext({ classifyApplicationRecords: () => [], getApplicationGroupSettings: () => [],
    applicationSameCourseTwice: (student) => student.name === "가상둘" ? [{ name: "융합과학 탐구", semesters: ["1", "2"] }] : [] });
  vm.runInContext(importer.slice(importer.indexOf("function normalizeResultCourseName("), importer.indexOf("function buildResultImportPreview(")), ctx);
  ctx.resultExampleList = (items) => items.join(", ");
  const course = (column, name) => ({ column, name, credits: 3 });
  const candidate = { skippedRows: [], data: { courses: [course(1, "융합과학 탐구 (1학기)"), course(2, "융합과학 탐구 (2학기)")], students: [
    { grade: "2", classroom: "1", number: "1", name: "가상하나", selections: [course(1, "융합과학 탐구 (1학기)")], totalCredits: 3 },
    { grade: "2", classroom: "1", number: "2", name: "가상둘", selections: [course(1, "융합과학 탐구 (1학기)"), course(2, "융합과학 탐구 (2학기)")], totalCredits: 6 }] } };
  const result = ctx.analyzeResultCandidate(candidate, { grade: "2", subjects: { "3": [] }, cohortYear: "2025" });
  assert.equal(result.issues.blocking.length, 0, "반영은 막지 않는다");
  assert.equal(result.issues.errors.length, 1);
  assert.match(result.issues.errors[0], /^같은 과목을 두 학기에 신청한 학생 1명: 1-2 가상둘\(융합과학 탐구\)/);
  // 반영 단추: 앱 확인 창으로 한 번 더 묻는다(취소하면 반영하지 않음).
  const source = importer.slice(importer.indexOf("async function confirmResultImport("), importer.indexOf("function revalidateResultImport("));
  assert.match(source, /appConfirm\(text, \{ title: "오류가 있는 결과 반영", ok: "반영", cancel: "취소" \}\)/);
  const asked = [];
  const run = vm.createContext({ resultImportPending: { candidates: [result], selected: 0 },
    appConfirm: async (text, options) => { asked.push({ text, options }); return false; }, window: {} });
  vm.runInContext(source.replace("async function confirmResultImport(", "var confirmResultImport = async function("), run);
  await run.confirmResultImport();
  assert.equal(asked.length, 1);
  assert.match(asked[0].text, /같은 과목을 두 학기에 신청한 학생 1명[\s\S]*그대로 반영할까요\?/);
});

test("offline application page notes once-only courses", () => {
  const ctx = vm.createContext({ $: () => ({ value: "" }) });
  vm.runInContext(functionSource("function xmlEscape(", "function createStylesXml("), ctx);
  vm.runInContext(functionSource("function buildApplicationPageHtml(", "function downloadApplicationForm("), ctx);
  const html = ctx.buildApplicationPageHtml({ "1": [], "2": [], "3": [{ subject: "융합과학 탐구", semester: "1·2", credit: 3, sameCourseOnce: true }] });
  assert.match(html, /c\.sameCourseOnce\?'1·2학기 중 한 학기만 · ':''/);
  assert.match(html, /"sameCourseOnce":true/);
});

test("adding a round says 'n차를 추가했습니다.' (차 is not dropped)", () => {
  assert.match(frontend, /status\.textContent = `\$\{state\.currentRound\}차를 추가했습니다\.`/);
  assert.doesNotMatch(frontend, /\$\{[^}]*[Rr]ound[^}]*\}(를|을) /, "차수 숫자 뒤에 '차' 없이 조사가 붙은 문구 없음");
});
