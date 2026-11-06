const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "curriculum-annual.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function load(extra = {}) {
  const ctx = vm.createContext(extra);
  vm.runInContext(source, ctx);
  return ctx;
}

const row = (subject, grade, credits, extra = {}) => ({
  division: "학생 선택 교육과정", area: "수학", detail: "일반선택", subject, baseCredit: 4, opCredit: 4,
  sem11: "", sem12: "", sem21: "", sem22: "", sem31: "", sem32: "",
  ...Object.fromEntries(credits.map((credit, index) => [`sem${grade}${index + 1}`, String(credit)])), ...extra
});

function cohorts() {
  return {
    "2026": { fileName: "2026.xlsx", plan: [row("공통수학1", 1, [4, 0], { division: "학교 지정 교육과정", detail: "공통" }), row("과학탐구", 2, [3, 3])] },
    "2025": { fileName: "2025.xlsx", plan: [row("미적분", 2, [4, 4]), row("과학탐구", 1, [3, 3])] },
    "2024": { fileName: "2024.xlsx", plan: [row("세계사", 3, [0, 3], { area: "사회" })] },
  };
}

test("each grade column comes from the cohort admitted that many years ago", () => {
  const ctx = load();
  assert.deepEqual(plain(ctx.annualCohortYears(2026)), { 1: "2026", 2: "2025", 3: "2024" });
  const layout = ctx.buildAnnualCurriculumLayout(cohorts(), 2026);
  const byName = Object.fromEntries(layout.rows.slice(3, -1).map((r) => [r[3], r]));
  // 1학년 열(6,7)은 2026학년도 입학생, 2학년 열(8,9)은 2025, 3학년 열(10,11)은 2024의 3개년 편제표에서 가져온다.
  assert.deepEqual(plain(byName["공통수학1"].slice(6, 12)), ["4", "", "", "", "", ""]);
  assert.deepEqual(plain(byName["미적분"].slice(6, 12)), ["", "", "4", "4", "", ""]);
  assert.deepEqual(plain(byName["세계사"].slice(6, 12)), ["", "", "", "", "", "3"]);
  // 2026의 2학년 열(과학탐구 3·3)은 쓰지 않고, 2025의 2학년 열만 쓴다. 과학탐구는 2026 입학생의 1학년과 합쳐지지 않는다.
  assert.equal(byName["과학탐구"], undefined, "a subject that is not in the grade's own cohort column is not invented");
});

test("a subject taught in several grades becomes one row with all grade columns and totals", () => {
  const ctx = load();
  const data = cohorts();
  data["2025"].plan.push(row("공통수학1", 2, [2, 2], { division: "학교 지정 교육과정", detail: "공통" }));
  data["2024"].plan.push(row("공통수학1", 3, [1, 0], { division: "학교 지정 교육과정", detail: "공통" }));
  const layout = ctx.buildAnnualCurriculumLayout(data, 2026);
  const rows = layout.rows.slice(3, -1).filter((r) => r[3] === "공통수학1");
  assert.equal(rows.length, 1);
  assert.deepEqual(plain(rows[0].slice(6, 13)), ["4", "", "2", "2", "1", "", "9"]);
  const subtotal = layout.rows.at(-1);
  assert.equal(subtotal[2], "소계");
  assert.equal(subtotal[6], "4");
  assert.equal(subtotal[8], "6", "2학년 1학기: 공통수학1 2 + 미적분 4");
  assert.equal(subtotal[12], "20", "9 + 8 + 3");
});

test("division and area labels appear once per group and the header keeps the plan column layout", () => {
  const ctx = load();
  const layout = ctx.buildAnnualCurriculumLayout(cohorts(), 2026);
  assert.equal(layout.derived, true);
  assert.equal(layout.rows[1][2], "세부과목");
  assert.equal(layout.rows[1][12], "이수 학점");
  assert.equal(layout.rows[2][6], "1학기");
  assert.ok(layout.mergedRanges.includes("G2:H2") && layout.mergedRanges.includes("K2:L2"));
  assert.ok(layout.mergedRanges.includes("A1:M1"), "the title spans the whole table");
  const divisions = layout.rows.slice(3, -1).map((r) => r[0]).filter(Boolean);
  assert.deepEqual(plain(divisions), ["학교 지정 교육과정", "학생 선택 교육과정"]);
});

test("source status and signature report missing cohorts and changes in the used columns only", () => {
  const ctx = load();
  const data = cohorts();
  assert.deepEqual(plain(ctx.annualSourceStatus(data, 2026).map((s) => [s.grade, s.year, s.rows])),
    [[1, "2026", 1], [2, "2025", 1], [3, "2024", 1]]);
  delete data["2024"];
  assert.equal(ctx.annualSourceStatus(data, 2026)[2].rows, 0);
  const before = ctx.annualCurriculumSignature(cohorts(), 2026);
  const changed = cohorts();
  changed["2026"].plan[1].sem21 = "9"; // 2026 입학생의 2학년 열은 올해 전학년 편제표에 쓰이지 않는다.
  assert.equal(ctx.annualCurriculumSignature(changed, 2026), before);
  changed["2025"].plan[0].sem21 = "5";
  assert.notEqual(ctx.annualCurriculumSignature(changed, 2026), before);
});

test("the annual card builds from cohort plans and no longer offers an upload", () => {
  assert.ok(html.indexOf('src="curriculum-annual.js') < html.indexOf('src="app.js'), "app.js draws the cards on start-up and needs the module first");
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert.ok(!app.includes("data-annual-upload"));
  assert.match(app, /state\.curriculumPlanType === "annual"\) \{[\s\S]{0,200}업로드하지 않고/);
});
