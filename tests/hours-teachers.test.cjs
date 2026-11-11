const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const hoursStats = fs.readFileSync(path.join(root, "hours-stats.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function pureContext() {
  const ctx = vm.createContext({});
  const start = hoursStats.indexOf("var HOURS_NON_TEACHING");
  vm.runInContext(hoursStats.slice(start, hoursStats.indexOf("var hoursRenderTimer", start)), ctx);
  const pure = hoursStats.indexOf("// ---- 교사 수 추천·공통 시수 배분 (순수 계산) ----");
  vm.runInContext(hoursStats.slice(pure, hoursStats.indexOf("function computeHoursStats(", pure)), ctx);
  return ctx;
}

// workflow-modules 시수 통계 테스트와 같은 방식: 편제표 항목과 확정 결과를 주고 hours-stats.js 전체를 올린다.
function statsContext(settings, planByCohort) {
  const snapshot = { rows: [] };
  const layouts = Object.fromEntries(Object.keys(planByCohort).map((year) => [year, { rows: [] }]));
  const ctx = vm.createContext({
    document: { getElementById: () => null },
    state: { curriculumCohortYear: "", curriculumCohorts: {}, hoursStats: settings, roundStatuses: { "1": { status: "confirmed", snapshot } } },
    $: (selector) => selector === "#schoolYear" ? { value: "2026" } : { value: "고등학교" },
    curriculumCohortLayout: (year) => layouts[year] || null,
    curriculumPlanEntries: (layout) => ({ entries: planByCohort[Object.keys(layouts).find((year) => layouts[year] === layout)] || [], issues: [] }),
    applicationRoundNumbers: () => ["1"],
    roundStatusData: () => ({ students: [{ grade: "1" }, { grade: "2" }] }),
    isRoundLocked: () => true,
    buildRoundSnapshot: () => snapshot,
    roundSnapshotDrift: () => [],
    normalizeResultCourseName: (name) => String(name).replace(/[()]/g, "").replace(/\s+/g, "").toLowerCase(),
    resultExampleList: (items) => items.join(", "),
    columnName: (index) => String.fromCharCode(65 + index),
    escapeHtml: String
  });
  vm.runInContext(hoursStats, ctx);
  return ctx;
}

const designated = (subject, area, credit, semester = "1", grade = "1") => ({ grade, semester, subject, area, credit, kind: "지정", names: 1, nameIndex: 0 });
const plan = {
  "2027": [
    designated("국어", "국어", 4), designated("국어", "국어", 4, "2"),
    designated("통합과학1", "과학", 4), designated("통합과학2", "과학", 4, "2"),
    designated("물리학", "과학", 2), designated("화학", "과학", 2, "2"),
    designated("보건", "교양", 1), designated("진로와 직업", "교양", 1, "2")
  ],
  "2026": [], "2025": []
};

// 학교 규칙(사용자 결정): 총 교원 수 확정 → 1인당 시수(두 학기 중 큰 값) 비교 → 19 초과면 증(증해서 13 이하면 순회교사 지원)
// → 증할 사람은 1인당 시수가 가장 작은 교과에서 감(1명이거나 감하면 19 초과면 다음 교과).
const SCHOOL_2027 = [["국어", 132, 128, 8], ["수학", 120, 152, 10], ["영어", 112, 116, 7], ["물리", 45, 42, 3], ["화학", 46, 42, 3], ["생명", 46, 42, 3],
  ["지구", 33, 28, 2], ["한국사·역사", 50, 46, 3], ["지리", 35, 32, 2], ["일반사회", 52, 48, 3], ["윤리", 53, 48, 3], ["체육", 53, 53, 3],
  ["음악", 25, 28, 2], ["미술", 28, 25, 2], ["정보", 40, 36, 2], ["기술·가정", 16, 20, 0], ["제2외국어", 21, 21, 1]]
  .map(([id, h1, h2, current]) => ({ id, hours: { 1: h1, 2: h2 }, current }));
const changes = (result) => result.rows.filter((row) => row.diff).map((row) => `${row.id} ${row.current}→${row.recommended}`);

test("교사 수 추천(학교 2027 3차 자료): 기준은 학기 평균, 0명 교과(기술·가정)도 증 대상, 단계 기록 고정", () => {
  const ctx = pureContext();
  const result = plain(ctx.hoursRecommendTeachers(SCHOOL_2027, { total: 57 }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps, [
    "1. 기술·가정 +1 (교사 0명 → 18.0 (16 / 20)) ← 수학 −1 (13.6 (12 / 15.2) → 15.1 (13.3 / 16.9)) · 건너뜀: 음악(감하면 26.5 (25 / 28)), 미술(감하면 26.5 (28 / 25))",
    "제2외국어: 순회교사 지원(지금 21.0 (21 / 21) · 증하면 10.5 (10.5 / 10.5) · 13 이하)"
  ]);
  assert.deepEqual(changes(result), ["수학 10→9", "기술·가정 0→1"]);
  assert.equal(result.assigned, 57, "총 교원 수는 그대로");
  assert.deepEqual(result.roaming, ["제2외국어"]);
  const row = (id) => result.rows.find((item) => item.id === id);
  assert.equal(row("정보").recommended, 2, "정보는 학기 평균 19.0(20 / 18)이라 19 초과가 아님");
  assert.equal(row("정보").recommendedOverUp, false);
  assert.ok(result.rows.every((item) => item.roaming || !item.recommendedOverUp), "순회교사 지원 교과 말고는 학기 평균 19시간 이하");
});

test("교사 수 추천 규칙: 19 초과 증·13 이하 순회·감 건너뛰기·고정·감할 교과 없음·총 교원 수 맞춤·기준값 설정", () => {
  const ctx = pureContext();
  const run = (units, options) => plain(ctx.hoursRecommendTeachers(units, options));
  const unit = (id, h, current, extra = {}) => ({ id, hours: { 1: h, 2: h }, current, ...extra });
  // 19 초과 → 감은 1인당 시수가 가장 작은 교과에서.
  let result = run([unit("A", 40, 2), unit("B", 30, 3), unit("C", 36, 3)], { total: 8 });
  assert.deepEqual(changes(result), ["A 2→3", "B 3→2"]);
  // 가장 작은 교과가 1명이면 건너뜀, 감하면 19 초과여도 건너뜀.
  result = run([unit("A", 40, 2), unit("B", 5, 1), unit("C", 20, 2), unit("D", 45, 4)], { total: 9 });
  assert.deepEqual(changes(result), ["A 2→3", "D 4→3"]);
  assert.match(result.steps[0], /건너뜀: B\(1명\), C\(감하면 20\.0 \(20 \/ 20\)\)/);
  // 증해서 13 이하면 순회교사 지원(교사 수 그대로, 총수에서 빼지 않음).
  result = run([unit("A", 21, 1), unit("B", 30, 3)], { total: 4 });
  assert.deepEqual(changes(result), []);
  assert.deepEqual(result.roaming, ["A"]);
  assert.equal(result.rows[0].roaming, true);
  // 감할 교과가 없으면 표시.
  result = run([unit("A", 40, 2), unit("B", 19, 1)], { total: 3 });
  assert.deepEqual(result.unresolved, ["A"]);
  assert.match(result.steps.join("\n"), /A: 감할 교과 없음 — 총 교원 수 늘리기 검토/);
  // 고정한 교과는 증·감하지 않는다.
  result = run([unit("A", 40, 2, { locked: true }), unit("B", 30, 3)], { total: 5 });
  assert.deepEqual(changes(result), []);
  assert.match(result.steps.join("\n"), /A: 고정이라 증하지 않음/);
  result = run([unit("A", 40, 2), unit("B", 10, 2, { locked: true }), unit("C", 30, 3)], { total: 7 });
  assert.deepEqual(changes(result), ["A 2→3", "C 3→2"], "1인당 가장 작은 B는 고정이라 건너뜀");
  // 증한 교과는 다시 감하지 않는다(늘렸다 줄였다 없음): 19 초과 교과가 여럿이면 시수가 큰 교과부터.
  result = run([unit("A", 44, 2), unit("B", 42, 2), unit("C", 30, 4)], { total: 8 });
  assert.deepEqual(changes(result), ["A 2→3", "B 2→3", "C 4→2"]);
  assert.match(result.steps[0], /^1\. A \+1/);
  // 1인당 시수가 같은 감 후보는 학교 평균과의 편차가 작아지는 쪽.
  result = run([unit("A", 40, 2), unit("B", 24, 2), unit("C", 36, 3)], { total: 7 });
  assert.deepEqual(changes(result), ["A 2→3", "C 3→2"], "B(12)·C(12) 중 감한 뒤 편차가 작은 C(18)");
  // 총 교원 수가 지금 합과 다르면 먼저 맞춘다.
  result = run([unit("A", 18, 1), unit("B", 10, 2)], { total: 4 });
  assert.equal(result.assigned, 4);
  assert.match(result.steps[0], /기준 교원 수에 맞춤/);
  result = run([unit("A", 18, 2), unit("B", 10, 3)], { total: 4 });
  assert.deepEqual(changes(result), ["B 3→2"]);
  // 시수가 있는데 0명이면 무한대(19 초과)로 보아 같은 규칙: +1 해서 13 초과면 증, 13 이하면 순회교사 지원.
  result = run([unit("A", 16, 0), unit("B", 30, 3)], { total: 3 });
  assert.deepEqual(changes(result), ["A 0→1", "B 3→2"]);
  assert.match(result.steps[0], /^1\. A \+1 \(교사 0명 → 16\.0 \(16 \/ 16\)\)/);
  result = run([unit("A", 10, 0), unit("B", 30, 3)], { total: 3 });
  assert.deepEqual(changes(result), []);
  assert.deepEqual(result.roaming, ["A"]);
  // 0명 교과도 감 규칙은 같다(1명·19 초과가 되는 교과에서는 데려오지 않음).
  result = run([unit("A", 16, 0), unit("B", 19, 1)], { total: 1 });
  assert.deepEqual(result.unresolved, ["A"]);
  // 학기 평균 기준: 1학기 24·2학기 14면 평균 19라 19 초과가 아니다.
  result = run([{ id: "A", hours: { 1: 24, 2: 14 }, current: 1 }, unit("B", 30, 3)], { total: 4 });
  assert.deepEqual(changes(result), []);
  // 기준값은 설정으로(19·13 대신 20·12).
  result = run([unit("A", 20, 1), unit("B", 30, 3)], { total: 4, upHours: 20 });
  assert.deepEqual(changes(result), []);
  result = run([unit("A", 26, 1), unit("B", 30, 3)], { total: 4, roamingHours: 12 });
  assert.deepEqual(changes(result), ["A 1→2", "B 3→2"]);
  // 계산할 수 없는 경우.
  assert.match(run([unit("A", 40, 3, { locked: true }), unit("B", 4, 1)], { total: 2 }).reason, /고정한 교과 교사 3명이 기준 교과 교사 수 2명보다 많습니다/);
  assert.match(run([unit("A", 4, 0)], { total: 0 }).reason, /교과 교사 수를 입력/);
});

test("교사 수 추천: 합은 늘 기준 교원 수, 순회·감할 교과 없음이 아니면 학기 평균 19시간 이하(0명 교과 포함)", () => {
  const ctx = pureContext();
  let seed = 7;
  const random = (max) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % max; };
  for (let trial = 0; trial < 300; trial++) {
    const size = 2 + random(6);
    const units = Array.from({ length: size }, (_, index) => ({ id: `U${index}`, hours: { 1: random(80), 2: random(80) }, current: random(5) }));
    const busy = units.filter((unit) => unit.hours["1"] || unit.hours["2"]).length;
    const total = Math.max(1, busy + random(8));
    const result = ctx.hoursRecommendTeachers(units, { total });
    assert.equal(result.ok, true, `trial ${trial}`);
    assert.equal(result.rows.reduce((sum, row) => sum + row.recommended, 0), total, `trial ${trial}`);
    for (const row of result.rows) {
      if (row.recommendedOverUp) assert.ok(row.roaming || row.unresolved, `trial ${trial} ${row.id}: 19 초과면 순회 또는 감할 교과 없음으로 표시`);
    }
  }
});

test("전년도 대비 증감 순위: 많이 늘어난 순, 과학·사회는 교과군, 교사 수 전년 → 올해, 자료 없으면 hasPrevious false", () => {
  const ctx = pureContext();
  const dep = (id, group, yearAverage, previous, teachers, previousTeachers, extra = {}) => ({ id, group, hours: { 1: 10, 2: 10 }, teachers, previousTeachers,
    averages: { 1: yearAverage, 2: yearAverage }, yearAverage, previous, ...extra });
  const result = plain(ctx.hoursYearChange([
    dep("국어", "국어", 16.5, 15, 8, 8), dep("수학", "수학", 15, 16, 10, 9), dep("정보", "생활·교양", 20, 17, 2, 2),
    dep("과학-공통", "과학", 0, null, 0, null, { common: true, groupAverage: 15.2, groupPrevious: 14, groupSemester: { 1: 15, 2: 15.4 }, groupTeachers: 11 }),
    dep("과학-물리", "과학", 15, null, 3, 3), dep("과학-화학", "과학", 15, null, 3, 4),
    dep("교양", "생활·교양", null, null, null, null, { otherTeachers: true }),
    dep("진로", "생활·교양", 10, 10, 1, 1, { excluded: true }),
    dep("미술", "체육·예술", 14, null, 2, null)
  ]));
  assert.equal(result.hasPrevious, true);
  assert.deepEqual(result.rows.map((row) => [row.label, row.change, row.rank]), [["정보", 3, 1], ["국어", 1.5, 2], ["과학(교과군)", 1.2, 3], ["수학", -1, 4], ["미술", null, null]]);
  const science = result.rows.find((row) => row.group);
  assert.deepEqual([science.teachers, science.previousTeachers], [11, 7]);
  assert.equal(plain(ctx.hoursYearChange([dep("국어", "국어", 16, null, 8, null)])).hasPrevious, false);
});

const SCIENCE = [
  { id: "과학-물리", hours: { 1: 28, 2: 12 }, teachers: 3 },
  { id: "과학-화학", hours: { 1: 36, 2: 20 }, teachers: 3 },
  { id: "과학-생명", hours: { 1: 36, 2: 16 }, teachers: 3 },
  { id: "과학-지구", hours: { 1: 16, 2: 0 }, teachers: 2 },
  { id: "과학-공통 교사 없음", hours: { 1: 0, 2: 0 }, teachers: 0 }
];

test("공통 과목 나누기: 통합과학은 반마다 물리·화학·생명·지구 1시간씩(반 수만큼), 반마다 교사 4명", () => {
  const ctx = pureContext();
  for (const classes of [10, 11, 9]) {
    const result = plain(ctx.hoursBalanceCommonAllocation(SCIENCE, [{ subject: "통합과학1", semester: "1", credit: 4, classes, grade: "1" }]));
    assert.equal(result.ok, true);
    for (const id of ["과학-물리", "과학-화학", "과학-생명", "과학-지구"]) assert.equal(result.allocations[id]["1"], classes, `${classes}반 ${id}`);
    assert.deepEqual(result.allocations["과학-공통 교사 없음"], { 1: 0, 2: 0 });
    const entry = result.plan.find((item) => item.subject === "통합과학1");
    assert.equal(entry.mode, "equal");
    assert.equal(Object.keys(entry.byClass).length, classes);
    assert.ok(Object.values(entry.byClass).every((byDepartment) => Object.keys(byDepartment).length === 4 && Object.values(byDepartment).every((hours) => hours === 1)), "반마다 교사 4명 × 1시간");
    assert.equal(result.notes["과학-물리"]["1"], `통과${classes}`);
  }
  // 학점이 4가 아니면 고르게 나누고 나머지는 1인당 시수가 낮은 교과부터 1시간씩.
  // 5학점: 1시간씩 나눈 뒤(물리 38/3≈12.7 · 지구 26/2=13 · 화학·생명 46/3≈15.3) 남는 1시간은 물리.
  let result = plain(ctx.hoursBalanceCommonAllocation(SCIENCE, [{ subject: "통합과학1", semester: "1", credit: 5, classes: 10 }]));
  assert.deepEqual(result.plan[0].byClass["1"], { "과학-물리": 2, "과학-화학": 1, "과학-생명": 1, "과학-지구": 1 });
  // 3학점: 지구 8 → 물리 9.3 → 화학 12(생명과 같으면 앞 교과).
  result = plain(ctx.hoursBalanceCommonAllocation(SCIENCE, [{ subject: "통합과학1", semester: "1", credit: 3, classes: 10 }]));
  assert.deepEqual(result.plan[0].byClass["1"], { "과학-물리": 1, "과학-화학": 1, "과학-지구": 1 });
  assert.equal(ctx.hoursBalanceCommonAllocation(SCIENCE.map((member) => ({ ...member, teachers: 0 })), [{ subject: "통합과학1", semester: "1", credit: 4, classes: 10 }]).ok, false);
});

test("공통 과목 나누기: 통합과학 고정 뒤 과학탐구실험은 반 단위 균형, 설정으로 방식·교과별 시간을 바꿈", () => {
  const ctx = pureContext();
  const items = [
    { subject: "통합과학1", semester: "1", credit: 4, classes: 10, grade: "1" },
    { subject: "과학탐구실험1", semester: "1", credit: 1, classes: 10, grade: "1" },
    { subject: "통합과학2", semester: "2", credit: 4, classes: 10, grade: "1" },
    { subject: "융합과학 탐구", semester: "2", credit: 4, classes: 7, grade: "2" }
  ];
  let result = plain(ctx.hoursBalanceCommonAllocation(SCIENCE, items));
  const sum = (semester) => Object.values(result.allocations).reduce((acc, value) => acc + value[semester], 0);
  assert.equal(sum("1"), 50, "1학기 공통 시수 전부(40 + 10)");
  assert.equal(sum("2"), 68);
  const lab = result.plan.find((item) => item.subject === "과학탐구실험1");
  assert.equal(lab.mode, "class");
  assert.ok(Object.values(lab.byClass).every((byDepartment) => Object.keys(byDepartment).length === 1), "과탐실은 반 하나를 한 교과가");
  // 통합과학을 먼저 고정한 뒤 과탐실을 나누므로, 과탐실은 통합과학까지 더한 1인당 시수가 가장 낮은 교과(지구: 16 + 10 = 26/2 = 13)부터.
  assert.ok(result.allocations["과학-지구"]["1"] > 10, "지구가 과탐실 반을 먼저 받음");
  for (const member of SCIENCE) assert.equal(result.allocations[member.id]["1"] % 1, 0);
  const hours = (note) => [...note.matchAll(/\d+/g)].reduce((acc, match) => acc + Number(match[0]), 0);
  for (const member of SCIENCE) assert.equal(hours(result.notes[member.id]["1"] || ""), result.allocations[member.id]["1"]);
  assert.match(result.notes["과학-지구"]["1"], /^통과10 · 과탐실\d+$/);
  // 과탐실을 '시간 분배'로: 반마다 1시간을 한 교과에(1학점이라 반 단위와 같지만 반마다 같은 교과).
  result = plain(ctx.hoursBalanceCommonAllocation(SCIENCE, items, { modes: { "과학탐구실험1": "time" } }));
  const timed = result.plan.find((item) => item.subject === "과학탐구실험1");
  assert.equal(timed.mode, "time");
  assert.equal(new Set(Object.values(timed.byClass).map((value) => JSON.stringify(value))).size, 1);
  // 통합사회: 시간 균형 분배가 기본, 교과별 시간을 설정하면 그대로(합 = 학점 × 반 수).
  const social = [
    { id: "사회-한국사", hours: { 1: 40, 2: 40 }, teachers: 3 }, { id: "사회-지리", hours: { 1: 20, 2: 20 }, teachers: 2 },
    { id: "사회-일사", hours: { 1: 30, 2: 30 }, teachers: 3 }, { id: "사회-윤리", hours: { 1: 30, 2: 30 }, teachers: 3 }
  ];
  const integrated = [{ subject: "통합사회1", semester: "1", credit: 4, classes: 10, grade: "1" }];
  result = plain(ctx.hoursBalanceCommonAllocation(social, integrated));
  assert.equal(result.plan[0].mode, "time");
  assert.equal(Object.values(result.allocations).reduce((acc, value) => acc + value["1"], 0), 40, "분배 합 = 학점 × 반 수");
  assert.equal(Object.values(result.plan[0].byClass["1"]).reduce((acc, value) => acc + value, 0), 4);
  result = plain(ctx.hoursBalanceCommonAllocation(social, integrated, { shares: { "통합사회1": { "사회-지리": 1, "사회-일사": 2, "사회-윤리": 1 } } }));
  assert.deepEqual(result.plan[0].byClass["7"], { "사회-지리": 1, "사회-일사": 2, "사회-윤리": 1 });
  assert.deepEqual([result.allocations["사회-지리"]["1"], result.allocations["사회-일사"]["1"], result.allocations["사회-윤리"]["1"], result.allocations["사회-한국사"]["1"]], [10, 20, 10, 0]);
  // 합이 학점과 다른 설정은 쓰지 않는다(자동 나눔).
  result = plain(ctx.hoursBalanceCommonAllocation(social, integrated, { shares: { "통합사회1": { "사회-지리": 3 } } }));
  assert.equal(result.plan[0].mode, "time");
});

test("hoursCommonClassAssignment(학년, 학기): { 과목: { 반: { 교과 id: 주당 시간 } } } — 6단계·시간표용", () => {
  const settings = { "2027": { classCounts: { "1": 10, "2": 0, "3": 0 }, creativeHours: 2, teachers: { "국어": 2, "과학-물리": 1, "과학-화학": 1, "진로": 1 } } };
  const ctx = statsContext(settings, plan);
  ctx.setTimeout = setTimeout;
  const assignment = plain(ctx.hoursCommonClassAssignment("1", "1", "2027"));
  assert.deepEqual(Object.keys(assignment), ["통합과학1"]);
  assert.equal(Object.keys(assignment["통합과학1"]).length, 10);
  assert.deepEqual(assignment["통합과학1"]["3"], { "과학-물리": 2, "과학-화학": 2 }, "교사 있는 교과(물리·화학)에 4시간을 똑같이");
  assert.deepEqual(plain(ctx.hoursCommonClassAssignment("1", "2", "2027")), { "통합과학2": plain(ctx.hoursCommonClassAssignment("1", "2", "2027"))["통합과학2"] });
  assert.equal(ctx.hoursCommonClassAssignment("2", "1", "2027")["통합과학1"], undefined, "다른 학년 과목은 없음");
  // 시수 설정 팝업에 과목별 방식·교과별 시간 칸.
  const html = ctx.hoursCommonSettings(ctx.computeHoursStats("2027"));
  assert.match(html, /data-hours-common-mode="통합과학1"/);
  assert.match(html, /교과별 같은 시간 \(기본\)/);
  assert.match(html, /data-hours-common-share="통합과학1" data-hours-common-member="과학-물리"/);
});

test("교원 구성: 총 교사 수 직접 입력, 비교과는 교과 평균에서 빼고 맡은 수업은 따로", () => {
  const teachers = { "국어": 2, "과학-공통": 0, "과학-물리": 1, "과학-화학": 1, "교양": 1, "진로": 1 };
  const settings = { "2027": { classCounts: { "1": 10, "2": 0, "3": 0 }, creativeHours: 2, teachers } };
  const ctx = statsContext(settings, plan);
  const before = ctx.computeHoursStats("2027");
  // 예전 자료: 총 교사 수·비교과가 없으면 교과 + 진로 합을 제안값으로.
  assert.equal(before.staff.entered, null);
  assert.equal(before.staff.suggested, 6);
  assert.equal(before.staff.total, 6);
  assert.equal(before.staff.other, null);
  assert.match(ctx.hoursStaffFormula(before), /총 교사 수 <span class="hours-suggested"[^>]*>6 \(제안값\)<\/span> = 교과 5 \+ 진로 1\(평균 제외\) \+ 비교과 0\(특수 0·영양 0·보건 0·사서 0·상담 0\)$/);
  const average = before.totals.average.year;

  settings["2027"].totalTeachers = 12;
  settings["2027"].nonTeaching = { "보건": 1, "영양": 1, "사서": 1, "상담": 1 };
  const after = ctx.computeHoursStats("2027");
  assert.equal(after.totals.average.year, average, "비교과 교사 수를 넣어도 교과 평균은 그대로");
  assert.deepEqual(plain([after.staff.total, after.staff.subject, after.staff.career, after.staff.nonTeaching, after.staff.other, after.staff.over]), [12, 5, 1, 4, 2, false]);
  assert.equal(ctx.hoursStaffFormula(after), "총 교사 수 <b>12</b> = 교과 5 + 진로 1(평균 제외) + 비교과 4(특수 0·영양 1·보건 1·사서 1·상담 1) + 기타 2(교과 미배정)");
  // 전체 교원 기준 평균(참고) = (교과 + 진로 + 비교과 수업) ÷ 총 교사 수.
  assert.equal(after.staff.allHours["1"], after.totals["1"]);
  assert.equal(after.staff.average["2"], (after.totals["2"] + 10) / 12);
  assert.ok(after.issues.some((issue) => issue.level === "info" && issue.text.includes("'보건' 과목을 보건교사가 맡으면")));

  // 보건 과목을 보건교사가 맡으면 교과 시수에서 빠지고 보건교사 1인당 시수로 따로 보인다.
  settings["2027"].departmentOverrides = { "보건": "비교과:보건" };
  settings["2027"].nonTeachingHours = { "보건": { "2": 3 } };
  const assigned = ctx.computeHoursStats("2027");
  const health = assigned.nonTeaching.find((row) => row.id === "보건");
  assert.equal(assigned.totals["1"], after.totals["1"] - 10);
  assert.equal(assigned.totals.average["1"], assigned.totals["1"] / 5);
  assert.deepEqual(plain([health.subjectHours, health.hours, health.averages]), [{ 1: 10, 2: 0 }, { 1: 10, 2: 3 }, { 1: 10, 2: 3 }]);
  assert.equal(assigned.items.find((item) => item.subject === "보건").department, "비교과:보건");
  assert.equal(ctx.hoursDepartmentName("비교과:보건"), "보건교사(비교과)");
  assert.equal(assigned.staff.allHours["1"], after.staff.allHours["1"], "전체 수업 시수는 담당만 바뀌고 그대로");

  // 합이 총 교사 수보다 많으면 경고.
  settings["2027"].totalTeachers = 9;
  const over = ctx.computeHoursStats("2027");
  assert.equal(over.staff.over, true);
  assert.ok(over.issues.some((issue) => issue.level === "warning" && issue.action === "focus:hoursTotalTeachers" && issue.text.includes("1명 많습니다")));

  // 엑셀: 첫 시트는 원래 양식(교사시수표), 교원 구성은 따로 시트(전체 교원 기준 평균은 참고 줄).
  settings["2027"].totalTeachers = 12;
  const stats = ctx.computeHoursStats("2027");
  const sheets = ctx.buildHoursWorkbookSheets(stats, { schoolName: "천상고등학교", date: new Date(2026, 9, 1) });
  assert.deepEqual(plain(sheets.map((sheet) => sheet.name)).slice(0, 3), ["2027 교사시수표", "과목별 상세", "교원 구성"]);
  const staffSheet = sheets[2].rows;
  const labels = staffSheet.map((row) => row[0]?.v);
  assert.deepEqual(plain(labels.slice(2, 12)), ["총 교사 수", "교과 교사 (진로 제외)", "진로 (평균 제외)",
    "비교과 · 특수교사", "비교과 · 영양교사", "비교과 · 보건교사", "비교과 · 사서교사", "비교과 · 전문상담교사", "기타 (교과 미배정)",
    "전체 교원 기준 평균 (참고) = (교과 + 진로 + 비교과 수업 시수) ÷ 총 교사 수"]);
  assert.equal(staffSheet[2][1].v, 12);
  assert.equal(staffSheet[7][2].v, 10, "보건교사가 맡은 보건 1학기 10시간");
  assert.match(staffSheet[7][5].v, /맡은 과목: 1-1 보건 10시간 · 직접 입력 0\/3시간/);
  assert.equal(staffSheet[10][1].f, "B3-SUM(B4:B10)");
  assert.equal(staffSheet[10][1].v, 2);
  assert.ok(staffSheet[11][2].f.startsWith("IF(B3>0,SUM(C4:C10)/B3"));
  assert.equal(sheets[1].rows.find((row) => row[4]?.v === "보건")[6].v, "보건교사(비교과)");
  const recommendSheet = sheets.find((sheet) => sheet.name === "교사 수 추천");
  assert.ok(recommendSheet);
  assert.equal(recommendSheet.rows[2][5].v, "추천");
});

test("교사 수 추천 연결: 기준은 총 교사 − 진로 − 비교과, 진로·기타는 빼고 공통 행은 교사가 있을 때만", () => {
  const teachers = { "국어": 1, "과학-물리": 1, "과학-화학": 3, "교양": 1, "진로": 1 };
  const settings = { "2027": { classCounts: { "1": 10, "2": 0, "3": 0 }, creativeHours: 2, teachers, totalTeachers: 12,
    nonTeaching: { "보건": 1, "영양": 1 }, teacherLocks: { "교양": true } } };
  const ctx = statsContext(settings, plan);
  const stats = ctx.computeHoursStats("2027");
  const recommendation = stats.recommendation;
  assert.equal(recommendation.basis, 9);
  assert.equal(recommendation.target, 9);
  assert.match(recommendation.basisText, /총 12 − 진로 1 − 비교과 2/);
  const ids = recommendation.rows.map((row) => row.id);
  assert.ok(!ids.includes("진로") && !ids.includes("과학-공통") && !ids.includes("기타"));
  // 교사 없는 공통 행 시수는 세부 교과 비율로 나눠 계산하고 안내한다.
  assert.ok(recommendation.notes.some((note) => note.includes("과학 공통 과목 시수 중")));
  const row = (id) => recommendation.rows.find((item) => item.id === id);
  assert.equal(row("교양").recommended, 1, "고정");
  assert.equal(recommendation.rows.reduce((sum, item) => sum + item.recommended, 0), 9);
  assert.ok(row("국어").recommended > 1, "국어 시수가 가장 많아 충원 추천");
  settings["2027"].recommendTeachers = 6;
  assert.equal(ctx.computeHoursStats("2027").recommendation.target, 6);
  assert.equal(ctx.computeHoursStats("2027").recommendation.basisText, "직접 입력");
});

test("시수 화면: 교원 구성 줄·추천 칸·비교과 담당 선택·되돌리기 연결", () => {
  assert.match(hoursStats, /data-hours-total-teachers="1"/);
  assert.match(hoursStats, /data-hours-non-teaching="\$\{row\.id\}"/);
  assert.match(hoursStats, /<optgroup label="비교과 교사 \(교과 평균에서 뺌\)">/);
  assert.match(hoursStats, /data-hours-action="apply-recommendation"/);
  assert.match(hoursStats, /data-hours-auto-allocate="\$\{department\.group\}"/);
  assert.match(hoursStats, /function undoHoursChange\(\)/);
  // 다시 그려도 펼친 추천·상세 칸을 유지한다.
  assert.match(hoursStats, /details\[data-hours-details\]/);
  // 전년도 설정 불러오기는 총 교사 수·비교과·고정도 가져온다.
  assert.match(hoursStats, /settings\.nonTeaching = \{ \.\.\.source\.nonTeaching \}/);
  assert.match(hoursStats, /\["creativeHours", "totalTeachers", "maxTeacherHours", "roamingTeacherHours"\]/);
});

test("교양은 다른 교과 교사가 맡음: 0명이 기본, '타교과 담당(미지정)' 표시, 평균·추천·교사 수 경고에서 뺌, 담당 교과를 고르면 그 교과 시수", () => {
  const teachers = { "국어": 2, "과학-물리": 1, "과학-화학": 1, "진로": 1 };
  const settings = { "2027": { classCounts: { "1": 10, "2": 0, "3": 0 }, creativeHours: 2, teachers } };
  const ctx = statsContext(settings, plan);
  const stats = ctx.computeHoursStats("2027");
  const culture = stats.departments.find((department) => department.id === "교양");
  assert.equal(culture.otherUnassigned, true);
  assert.equal(culture.averages, null);
  assert.ok(!stats.issues.some((issue) => issue.level === "warning" && /교사 수가 비어 있는 교과: .*교양/.test(issue.text)), "교양은 교사 수 경고 없음");
  assert.ok(stats.issues.some((issue) => issue.level === "info" && issue.text.includes("타교과 담당(미지정)")));
  assert.ok(!stats.recommendation.rows.some((row) => row.id === "교양"), "추천에서 뺌(최소 1명 규칙 없음)");
  assert.ok(stats.recommendation.notes.some((note) => note.includes("타교과 담당(미지정)")));
  const model = ctx.hoursFormModel(stats, { schoolName: "천상고등학교", date: new Date(2026, 9, 1) });
  const cells = [...model.cells.values()];
  assert.ok(cells.some((cell) => cell.v === "타교과 담당\n(미지정)"), "시수표 비고");
  assert.ok(!cells.some((cell) => typeof cell.v === "number" && !Number.isFinite(cell.v)), "NaN·Infinity 칸 없음");
  assert.ok(cells.every((cell) => !cell.f || /IF\(N\(S\d+\)>0|IF\(.*>0|SUM|PRODUCT|AVERAGE|^[A-Z]+\d+[-+]/.test(cell.f) || !/\//.test(cell.f)), "나눗셈 수식은 0 교사 가드");
  // 과목별 상세에서 담당 교과를 고르면 그 교과 시수에 더해진다.
  settings["2027"].departmentOverrides = { "보건": "국어" };
  const assigned = ctx.computeHoursStats("2027");
  const korean = assigned.departments.find((department) => department.id === "국어");
  assert.equal(korean.hours["1"], stats.departments.find((department) => department.id === "국어").hours["1"] + 10);
  assert.equal(assigned.departments.find((department) => department.id === "교양").otherUnassigned, false);
  // 엑셀 '교사 수 추천' 시트: 규칙·단계 기록·증감 순위(전년 자료 없으면 안내).
  const sheet = ctx.buildHoursWorkbookSheets(stats, { schoolName: "천상고등학교", date: new Date(2026, 9, 1) }).find((item) => item.name === "교사 수 추천");
  const texts = sheet.rows.flat().map((cell) => cell?.v);
  assert.match(texts[0], /19시간 초과면 증, 증해서 13시간 이하면 순회교사 지원/);
  assert.ok(texts.includes("추천 단계 기록"));
  assert.ok(texts.some((value) => /^전년도 자료 없음/.test(value)));
  settings["2027"].previousAverages = { "국어": 10 };
  settings["2027"].previousTeachers = { "국어": 1 };
  const withPrevious = ctx.computeHoursStats("2027");
  assert.equal(withPrevious.yearChange.hasPrevious, true);
  const rows = ctx.buildHoursWorkbookSheets(withPrevious, { schoolName: "천상고등학교", date: new Date(2026, 9, 1) }).find((item) => item.name === "교사 수 추천").rows;
  const header = rows.findIndex((row) => row[0]?.v === "교과" && row[1]?.v === "전년 1인당(1년)");
  assert.ok(header > 0);
  assert.equal(rows[header + 1][0].v, "국어");
  assert.equal(rows[header + 1][6].v, 1, "순위");
  assert.deepEqual([rows[header + 1][7].v, rows[header + 1][8].v], [1, 2], "교사 수 전년 → 올해");
});

// ---- 전년도 교사시수표 올리기 ----
// 학교 양식(가상 학교): A 교과군 · B 세부 · C 학기 · P/Q 행 시수 · R 학기 합계 · S 교사수 · T 학기별 평균 · U 1년 · W 전년.
// parseWorkbook(…, { expandMergedCells: true })처럼 병합 칸은 아래 줄에도 같은 값이 들어 있다고 본다.
function schoolSheet(name, year, { stamp = "(25.10.)", blocks, summaryAt = 0, memo = true } = {}) {
  const rows = [];
  const set = (r, c, v) => { (rows[r] ||= [])[c] = v; };
  set(0, 0, `${year}학년도 교과별 시수 통계 (총32학급)`);
  set(1, 0, `가상고등학교 ${stamp}`);
  set(2, 0, "교과군"); set(2, 2, "학기"); set(2, 15, "총시수"); set(2, 18, "교사수"); set(2, 19, "평균시수"); set(2, 22, "전년 평균시수\n(1년)");
  set(3, 15, "1학기"); set(3, 16, "2학기"); set(3, 17, "합계"); set(3, 19, "학기별"); set(3, 20, "1년");
  let r = 4;
  for (const block of blocks) {
    const start = r;
    for (const semester of ["1", "2"]) {
      const lines = block.lines?.[semester] || 1;
      const semesterStart = r;
      for (let line = 0; line < lines; line++) {
        set(r, 0, block.group); set(r, 1, block.detail ?? block.group); set(r, 2, Number(semester));
        set(r, semester === "1" ? 15 : 16, line === 0 ? block.hours[semester] : "");
        r++;
      }
      for (let rr = semesterStart; rr < r; rr++) {
        set(rr, 17, block.hours[semester]);
        set(rr, 19, block.teachers > 0 ? block.hours[semester] / block.teachers : "#DIV/0!");
      }
    }
    for (let rr = start; rr < r; rr++) {
      set(rr, 18, block.teachers);
      if (block.u !== undefined) set(rr, 20, block.u);
      if (block.w !== undefined) set(rr, 22, block.w);
    }
  }
  set(r, 0, "창체"); set(r, 2, 1); r++;
  r += summaryAt;
  set(r, 13, "교과"); set(r, 15, 930); set(r, 16, 930); set(r, 17, 1860); set(r, 18, 59);
  if (memo) set(r, 3, "◈ 2025학년도 비교과 교사 : 특수2, 영양1, 보건2(1명만 수업참여), 사서1\n◈ 2025학년도 ⇒ 기술과, 정보과, 역사과 각1명 감, 미술과, 수학과 각1명 증");
  set(r + 1, 13, "전체\n평균"); set(r + 2, 13, "창체 포함\n평균");
  return { name, rows };
}
const SCHOOL_BLOCKS = [
  { group: "국어", hours: { 1: 128, 2: 120 }, teachers: 8, u: 15.5, w: "18\n4", lines: { 1: 3, 2: 3 } },
  { group: "수학", hours: { 1: 148, 2: 148 }, teachers: 11, u: 13.45 },
  { group: "과학", detail: "물리", hours: { 1: 45, 2: 42 }, teachers: 3, u: 14.8 },
  { group: "과학", detail: "생명과학", hours: { 1: 46, 2: 42 }, teachers: 3, u: 14.8 },
  { group: "생활·교양", detail: "정보", hours: { 1: 40, 2: 36 }, teachers: 2, u: 19 },
  { group: "생활·교양", detail: "기술가정", hours: { 1: 16, 2: 20 }, teachers: 0 },
  { group: "생활·교양", detail: "일본어", hours: { 1: 21, 2: 21 }, teachers: 1, u: 21 },
  { group: "생활·교양", detail: "진로와 직업", hours: { 1: 10, 2: 10 }, teachers: 1, u: 10 },
  { group: "생활·교양", detail: "생태와환경", hours: { 1: 10, 2: 10 }, teachers: 0 },
  { group: "생활·교양", detail: "무용", hours: { 1: 4, 2: 4 }, teachers: 1, u: 4 }
];

test("전년도 교사시수표: 학교 양식 시트를 읽고(교과 맞춤·교사 수·학기 평균·1년·요약·비교과 메모), 앱 학년도 − 1 시트를 고른다", () => {
  const ctx = pureContext();
  const sheets = [
    schoolSheet("(1) 25교과시수(24.9월)", 2025, { stamp: "(24.09.)", blocks: SCHOOL_BLOCKS }),
    schoolSheet("2026 교과별 시수표 (최종)", 2026, { stamp: "(25.10.)", blocks: SCHOOL_BLOCKS }),
    schoolSheet("2026 교과별 시수표 (수정)", 2026, { stamp: "(25.11.)", blocks: SCHOOL_BLOCKS }),
    schoolSheet("(3) 2024 교과시수", 2024, { stamp: "(23.12.)", blocks: SCHOOL_BLOCKS.slice(0, 3), summaryAt: 3, memo: false }),
    { name: "26 창체 및 교양시수", rows: [["2025학년도 교과 시수 배정표"], ["교과군", "1학기"], ["국어", "128", "0", "10", "8", "1"]] },
    { name: "(7) 조정1", rows: [["조정"], ["교사수"]] }
  ];
  const picked = plain(ctx.hoursPreviousPickSheets(sheets, "2026"));
  assert.equal(picked.stats.length, 4, "교과별 시수표 시트만");
  assert.equal(picked.total, 6);
  assert.equal(picked.chosen, "2026 교과별 시수표 (최종)", "같은 학년도가 여럿이면 '최종'");
  assert.equal(picked.allocation, "26 창체 및 교양시수", "배정표는 시트 이름의 학년도(26)");
  assert.equal(plain(ctx.hoursPreviousPickSheets(sheets.filter((sheet) => !/최종/.test(sheet.name)), "2026")).chosen, "2026 교과별 시수표 (수정)", "최종이 없으면 A2 날짜가 늦은 것");
  const parsed = picked.stats.find((item) => item.name === picked.chosen);
  const byLabel = Object.fromEntries(parsed.departments.map((item) => [item.label, item]));
  assert.deepEqual(parsed.departments.map((item) => item.id), ["국어", "수학", "과학-물리", "과학-생명", "정보", "기술가정", "제2외국어", "진로", "교양", null]);
  assert.deepEqual([byLabel["국어"].teachers, byLabel["국어"].hours, byLabel["국어"].averages["1"], byLabel["국어"].year], [8, { 1: 128, 2: 120 }, 16, 15.5]);
  assert.equal(byLabel["생활·교양 · 기술가정"].teachers, 0);
  assert.deepEqual(byLabel["생활·교양 · 기술가정"].averages, { 1: null, 2: null }, "#DIV/0!은 빈 값");
  assert.equal(byLabel["과학 · 물리"].year, 14.5, "과학·사회 세부는 자기 학기 평균((45+42)/2/3)");
  assert.equal(byLabel["과학 · 물리"].groupYear, 14.8, "U는 교과군 평균");
  assert.deepEqual(plain(parsed.summary.subject), { 1: 930, 2: 930, total: 1860, teachers: 59 });
  assert.equal(parsed.subjectTeachers, 59);
  assert.deepEqual(plain(parsed.nonTeaching), { 특수: 2, 영양: 1, 보건: 2, 사서: 1 });
  assert.ok(parsed.memo.some((line) => line.includes("각1명 감")));
  // 요약 행 위치가 달라도 N열 글자로 찾는다(2024 시트).
  assert.equal(picked.stats.find((item) => item.year === 2024).subjectTeachers, 59);
  // 맞추지 못한 줄('무용')은 고른 교과로, 안 고르면 빼고 저장한다. 같은 교과로 맞춘 줄은 더한다.
  const record = plain(ctx.hoursPreviousUploadRecord(parsed, { 9: "체육" }, { fileName: "school.xlsx" }));
  assert.deepEqual(Object.keys(record.departments), ["국어", "수학", "과학-물리", "과학-생명", "정보", "기술가정", "제2외국어", "진로", "교양", "체육"]);
  assert.equal(record.groups["과학"], 14.8);
  assert.equal(record.departments["국어"].year, 15.5);
  assert.equal(plain(ctx.hoursPreviousUploadRecord(parsed, {}, {})).departments["체육"], undefined);
});

test("전년도 값: 앱에 이관된 자료가 먼저, 빈 교과는 올린 파일, 다르면 안내, '올린 파일로 바꾸기'", () => {
  const settings = { "2027": { classCounts: { "1": 10, "2": 0, "3": 0 }, creativeHours: 2, teachers: { "국어": 2, "과학-물리": 1, "과학-화학": 1, "진로": 1 } } };
  const ctx = statsContext(settings, plan);
  const parsed = ctx.hoursPreviousParseSheet(schoolSheet("2026 교과별 시수표 (최종)", 2026, { blocks: SCHOOL_BLOCKS }));
  settings["2027"].previousUpload = ctx.hoursPreviousUploadRecord(parsed, {}, { fileName: "school.xlsx" });
  let stats = ctx.computeHoursStats("2027");
  const korean = () => stats.departments.find((department) => department.id === "국어");
  assert.deepEqual([korean().previous, korean().previousTeachers], [15.5, 8], "이관 자료가 없으면 올린 파일");
  assert.equal(stats.yearChange.sourceLabel, "전년도: 올린 파일(2026 교과별 시수표 (최종) · school.xlsx)");
  assert.equal(stats.yearChange.hasPrevious, true);
  // 앱에 이관된 전년도(2026) 자료: 교사 수·내려받을 때 남긴 평균.
  settings["2026"] = { teachers: { "국어": 7 }, lastAverages: { "국어": 17 } };
  stats = ctx.computeHoursStats("2027");
  assert.deepEqual([korean().previous, korean().previousTeachers], [17, 7], "이관 자료가 먼저");
  assert.equal(stats.departments.find((department) => department.id === "정보").previousTeachers, 2, "이관 자료에 없는 교과는 올린 파일로 채움");
  assert.match(stats.yearChange.sourceLabel, /^전년도: 앱에 이관된 2026학년도 자료 \+ 빈 교과는 올린 파일/);
  assert.deepEqual(plain(stats.yearChange.differences.map((item) => [item.name, item.kind, item.migrated, item.upload])), [["국어", "average", 17, 15.5], ["국어", "teachers", 7, 8]]);
  settings["2027"].previousPrefer = "upload";
  stats = ctx.computeHoursStats("2027");
  assert.deepEqual([korean().previous, korean().previousTeachers], [15.5, 8], "'올린 파일로 바꾸기'");
  // 화면: 근거 줄·다른 교과 안내·바꾸기 단추, 메모 증감 줄도 전년도 교사 수를 쓴다.
  const html = ctx.hoursYearChangeSection(stats);
  assert.match(html, /id="hoursPreviousSource"/);
  assert.match(html, /이관 자료와 올린 파일 값이 다른 교과\(지금 쓰는 값: 올린 파일\): 국어 1인당 17 \/ 파일 15\.5, 국어 교사 수 7 \/ 파일 8/);
  assert.match(html, /data-hours-action="prefer-migrated"/);
  assert.match(html, /전년도 교사시수표 올리기/);
  assert.match(ctx.hoursFormMemo(stats).changeLine, /◈ 2027학년도 ⇒ .*국어과 6명 감/);
});

test("전년도 교사시수표 왕복: 앱이 내보낸 교사시수표(병합·수식 캐시 값)를 다시 올리면 같은 교사 수·평균으로 읽힌다", () => {
  const teachers = { "국어": 2, "과학-물리": 1, "과학-화학": 1, "교양": 1, "진로": 1 };
  const settings = { "2026": { classCounts: { "1": 10, "2": 0, "3": 0 }, creativeHours: 2, teachers } };
  const ctx = statsContext(settings, { "2026": plan["2027"], "2025": [], "2024": [] });
  const stats = ctx.computeHoursStats("2026");
  const model = ctx.hoursFormModel(stats, { schoolName: "천상고등학교", date: new Date(2025, 9, 1) });
  // 모델 칸(1부터 센 행) → 시트 행(0부터), 병합은 아래·옆 칸에 같은 값(expandMergedCells).
  const rows = [];
  for (const [key, cell] of model.cells) { const [r, c] = key.split(":").map(Number); (rows[r - 1] ||= [])[c] = cell.v ?? ""; }
  for (const [r1, c1, r2, c2] of model.merges) for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
    (rows[r - 1] ||= []); if (rows[r - 1][c] === undefined || rows[r - 1][c] === "") rows[r - 1][c] = rows[r1 - 1]?.[c1] ?? "";
  }
  const picked = plain(ctx.hoursPreviousPickSheets([{ name: "2026 교사시수표", rows }], "2026"));
  assert.equal(picked.chosen, "2026 교사시수표");
  const parsed = picked.stats[0];
  const byId = Object.fromEntries(parsed.departments.filter((item) => item.id).map((item) => [item.id, item]));
  for (const department of stats.departments.filter((item) => item.teachers > 0 && !item.excluded && byId[item.id])) {
    assert.equal(byId[department.id].teachers, department.teachers, `${department.id} 교사 수`);
    assert.ok(Math.abs(byId[department.id].hours["1"] - department.totals["1"]) < 1e-6, `${department.id} 1학기 시수`);
  }
  assert.equal(byId["국어"].year, stats.departments.find((item) => item.id === "국어").yearAverage);
  assert.deepEqual(parsed.departments.filter((item) => ["진로", "교양"].includes(item.id)).map((item) => [item.id, item.teachers]).sort(), [["교양", 1], ["진로", 1]],
    "교양 칸을 함께 쓰는 진로와 직업은 비고 '합계·평균 제외'로 진로");
  assert.equal(parsed.subjectTeachers, stats.totals.teachers, "요약 상자 교과 교사 수");
});

test("전년도 값 보완: 교과군 평균도 같은 우선 규칙(파일 값 그대로), 0명 교과는 '-'(다른 출처로 안 채움), 채우는 출처는 교사 수가 있을 때만", () => {
  const settings = { "2027": { classCounts: { "1": 10, "2": 0, "3": 0 }, creativeHours: 2, teachers: { "국어": 2, "과학-물리": 1, "과학-화학": 1, "진로": 1, "기술가정": 1 } } };
  const ctx = statsContext(settings, plan);
  const blocks = SCHOOL_BLOCKS.map((block) => block.group === "과학" ? { ...block, u: 16.545 } : block);
  settings["2027"].previousUpload = ctx.hoursPreviousUploadRecord(ctx.hoursPreviousParseSheet(schoolSheet("2026 교과별 시수표 (최종)", 2026, { blocks })), {}, { fileName: "school.xlsx" });
  settings["2026"] = { teachers: { "국어": 7, "과학-물리": 3, "과학-생명": 3 }, lastAverages: { "국어": 17, "과학": 16.55, "기술가정": 6 } };
  let stats = ctx.computeHoursStats("2027");
  const science = () => stats.departments.find((department) => department.common && department.group === "과학");
  const tech = () => stats.departments.find((department) => department.id === "기술가정");
  assert.equal(science().groupPrevious, 16.55, "이관 자료 먼저");
  assert.equal(tech().previous, null, "파일이 0명이라고 하면 이관 자료 값(6)이 있어도 비움");
  assert.ok(!stats.yearChange.rows.some((row) => row.id === "기술가정" && row.rank !== null), "순위에서 뺌");
  settings["2027"].previousPrefer = "upload";
  stats = ctx.computeHoursStats("2027");
  assert.equal(science().groupPrevious, 16.545, "'올린 파일로 바꾸기' 뒤에는 교과군 평균도 파일 값(반올림하지 않음)");
  assert.equal(ctx.hoursFormat(science().groupPrevious, 1), "16.5");
  // 채우는 출처(두 번째)는 교사 수가 있을 때만: 파일에 없는 교과를 이관 자료로 채우려면 이관 자료에 교사 수가 있어야 한다.
  settings["2026"].lastAverages["미술"] = 12;
  stats = ctx.computeHoursStats("2027");
  assert.equal(stats.departments.find((department) => department.id === "미술").previous, null, "이관 자료에 미술 교사 수가 없어 채우지 않음");
  settings["2026"].teachers["미술"] = 2;
  stats = ctx.computeHoursStats("2027");
  assert.equal(stats.departments.find((department) => department.id === "미술").previous, 12);
});

test("전년도 교사시수표 시트 학년도: 시트명의 4자리·2자리 연도가 먼저, 없으면 A1 제목 — 배정표도 같은 규칙, 배정표는 따로 셈", () => {
  const ctx = pureContext();
  const year = (name, title) => plain(ctx.hoursPreviousSheetYear(name, title));
  assert.deepEqual(year("2026 교과별 시수표 (최종)", "2025학년도 …"), { year: 2026, basis: "시트명" });
  assert.deepEqual(year("(1) 25교과시수(24.9월)", "2025학년도 교과별 시수 통계"), { year: 2025, basis: "시트명" }, "괄호 번호·'24.9'는 연도로 보지 않음");
  assert.deepEqual(year("26 창체 및 교양시수 (2)", "2025학년도 교과 시수 배정표"), { year: 2026, basis: "시트명" });
  assert.deepEqual(year("(3) 2024 교과시수", ""), { year: 2024, basis: "시트명" });
  assert.deepEqual(year("교과시수", "2023학년도 교과별 시수 통계"), { year: 2023, basis: "제목" });
  assert.deepEqual(year("(7) 조정1", ""), { year: null, basis: "" });
  // 배정표도 머리글 '교과군'·'교사수'가 있지만 교과별 시수표 후보로 세지 않는다.
  const allocation = (name) => ({ name, rows: [["2025학년도 교과 시수 배정표"], ["교과군", "1학기", "", "", "교사수"], ["국어", "128", "10", "8", "8"]] });
  const sheets = [schoolSheet("2026 교과별 시수표 (최종)", 2026, { blocks: SCHOOL_BLOCKS }), schoolSheet("(1) 25교과시수(24.9월)", 2025, { blocks: SCHOOL_BLOCKS }),
    allocation("26 창체 및 교양시수"), allocation("26 창체 및 교양시수 (2)"), allocation("(5) 25 창체 및 교양시수(1)")];
  sheets[2].rows.push(["", "", "1", "", "3"]);
  const picked = plain(ctx.hoursPreviousPickSheets(sheets, "2026"));
  assert.deepEqual(picked.stats.map((item) => [item.name, item.year, item.yearBasis]), [["2026 교과별 시수표 (최종)", 2026, "시트명"], ["(1) 25교과시수(24.9월)", 2025, "시트명"]]);
  assert.deepEqual(picked.allocations.map((item) => [item.name, item.year]), [["26 창체 및 교양시수", 2026], ["26 창체 및 교양시수 (2)", 2026], ["(5) 25 창체 및 교양시수(1)", 2025]]);
  assert.equal(picked.allocation, "26 창체 및 교양시수");
  assert.match(hoursStats, /교과별 시수표 \$\{picked\.stats\.length\}개\$\{picked\.allocations\.length \? ` · 교과 시수 배정표 \$\{picked\.allocations\.length\}개`/);
});
