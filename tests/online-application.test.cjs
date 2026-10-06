const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((source) => source.trim());
const frontend = scripts[1];
function functionSource(start, end) {
  return frontend.slice(frontend.indexOf(start), frontend.indexOf(end));
}
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

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

test("all embedded scripts parse", () => {
  assert.equal(scripts.length, 2);
  scripts.forEach((source) => new vm.Script(source));
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

test("application subjects include every student-choice course in promoted grades, ignoring old exclusions", () => {
  const course = (subject, division, hours, grade = "") => ({
    subject, division, row: [3, ...hours], grade, area: "교과", selectionType: "일반선택",
  });
  const contexts = [
    course("학교지정", "학교 지정 교육과정", ["", "", 3, "", "", ""]),
    course("수학", "학생 선택 교육과정", ["", "", 3, 3, "", ""]),
    course("과학", "학생선택교육과정", ["", "", "", "", 3, ""]),
    course("현재학년", "학생 선택 교육과정", [3, "", "", "", "", ""]),
    course("미편제", "학생 선택 교육과정", ["", "", 0, "-", "", ""], "2"),
    course("구분없음", "", ["", "", 3, "", "", ""]),
  ];
  const ctx = vm.createContext({
    state: { curriculumImportedLayout: {}, applicationExcluded: { "2:수학": true } },
    importedPlanColumnMap: () => ({ subject: 0, opCredit: 0, baseCredit: -1, semesters: [1, 2, 3, 4, 5, 6] }),
    importedPlanCourseContexts: () => contexts,
  });
  vm.runInContext(functionSource("function collectApplicationSubjects(", "function renderApplicationSubjects("), ctx);
  const result = plain(ctx.selectedApplicationSubjects());
  assert.deepEqual(result["1"], []);
  assert.deepEqual(result["2"].map((c) => c.subject), ["수학"]);
  assert.equal(result["2"][0].semester, "1·2");
  assert.deepEqual(result["3"].map((c) => c.subject), ["과학"]);
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
