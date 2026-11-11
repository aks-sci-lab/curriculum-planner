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

test("교사 수 추천(학교 2027 3차 자료): 단계 기록·결과 고정 — 기술·가정 0명은 지금 규칙(최소 1명)으로 1명 받은 뒤 순회교사", () => {
  const ctx = pureContext();
  const result = plain(ctx.hoursRecommendTeachers(SCHOOL_2027, { total: 57 }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps, [
    "1. 기술·가정 +1 (교사 0명 → 20) ← 수학 −1 (15.2 → 16.9) · 건너뜀: 음악(감하면 28시간), 미술(감하면 28시간), 물리(감하면 22.5시간)",
    "제2외국어: 순회교사 지원(증하면 10.5시간 · 13 이하)",
    "2. 정보 +1 (20 → 13.3) ← 국어 −1 (16.5 → 18.9) · 건너뜀: 음악(감하면 28시간), 미술(감하면 28시간), 물리(감하면 22.5시간), 화학(감하면 23시간), 생명(감하면 23시간), 지구(감하면 33시간)",
    "기술·가정: 순회교사 지원(증하면 10시간 · 13 이하)"
  ]);
  assert.deepEqual(changes(result), ["국어 8→7", "수학 10→9", "정보 2→3", "기술·가정 0→1"]);
  assert.equal(result.assigned, 57, "총 교원 수는 그대로");
  assert.deepEqual(result.roaming, ["제2외국어", "기술·가정"]);
  assert.ok(result.rows.every((row) => row.roaming || !row.recommendedOverUp), "순회교사 지원 교과 말고는 19시간 이하");
  // 기술·가정도 교양처럼 타교과 담당(추천에서 뺌)이면: 정보만 수학에서 1명.
  const other = plain(ctx.hoursRecommendTeachers(SCHOOL_2027.filter((unit) => unit.id !== "기술·가정"), { total: 57 }));
  assert.deepEqual(other.steps, [
    "제2외국어: 순회교사 지원(증하면 10.5시간 · 13 이하)",
    "1. 정보 +1 (20 → 13.3) ← 수학 −1 (15.2 → 16.9) · 건너뜀: 음악(감하면 28시간), 미술(감하면 28시간), 물리(감하면 22.5시간)"
  ]);
  assert.deepEqual(changes(other), ["수학 10→9", "정보 2→3"]);
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
  assert.match(result.steps[0], /건너뜀: B\(1명\), C\(감하면 20시간\)/);
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
  // 시수가 있는데 0명이면 먼저 1명(최소 1명 규칙).
  result = run([unit("A", 10, 0), unit("B", 30, 3)], { total: 3 });
  assert.deepEqual(changes(result), ["A 0→1", "B 3→2"]);
  // 기준값은 설정으로(19·13 대신 20·12).
  result = run([unit("A", 20, 1), unit("B", 30, 3)], { total: 4, upHours: 20 });
  assert.deepEqual(changes(result), []);
  result = run([unit("A", 26, 1), unit("B", 30, 3)], { total: 4, roamingHours: 12 });
  assert.deepEqual(changes(result), ["A 1→2", "B 3→2"]);
  // 계산할 수 없는 경우.
  assert.match(run([unit("A", 4, 0), unit("B", 4, 0), unit("C", 4, 0)], { total: 2 }).reason, /최소 3명/);
  assert.match(run([unit("A", 4, 0)], { total: 0 }).reason, /교과 교사 수를 입력/);
});

test("교사 수 추천: 합은 늘 기준 교원 수, 순회·감할 교과 없음이 아니면 19시간 이하", () => {
  const ctx = pureContext();
  let seed = 7;
  const random = (max) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % max; };
  for (let trial = 0; trial < 300; trial++) {
    const size = 2 + random(6);
    const units = Array.from({ length: size }, (_, index) => ({ id: `U${index}`, hours: { 1: random(80), 2: random(80) }, current: random(5) }));
    const busy = units.filter((unit) => unit.hours["1"] || unit.hours["2"]).length;
    const total = Math.max(1, busy + random(8));
    const result = ctx.hoursRecommendTeachers(units, { total });
    if (!result.ok) { assert.ok(busy > total); continue; }
    assert.equal(result.rows.reduce((sum, row) => sum + row.recommended, 0), total, `trial ${trial}`);
    for (const row of result.rows) {
      if (row.hours["1"] || row.hours["2"]) assert.ok(row.recommended >= 1, `trial ${trial} 최소 1명`);
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

test("공통 시수 자동 배분: 반 단위로 나눠 세부 교과 1인당 시수를 맞춘다", () => {
  const ctx = pureContext();
  const members = [
    { id: "과학-물리", hours: { 1: 28, 2: 12 }, teachers: 3 },
    { id: "과학-화학", hours: { 1: 36, 2: 20 }, teachers: 3 },
    { id: "과학-생명", hours: { 1: 36, 2: 16 }, teachers: 3 },
    { id: "과학-지구", hours: { 1: 16, 2: 0 }, teachers: 2 },
    { id: "과학-공통 교사 없음", hours: { 1: 0, 2: 0 }, teachers: 0 }
  ];
  const items = [
    { subject: "통합과학1", semester: "1", credit: 4, classes: 10 },
    { subject: "과학탐구실험1", semester: "1", credit: 1, classes: 10 },
    { subject: "통합과학2", semester: "2", credit: 4, classes: 10 },
    { subject: "융합과학 탐구", semester: "2", credit: 4, classes: 7 }
  ];
  const result = plain(ctx.hoursBalanceCommonAllocation(members, items));
  assert.equal(result.ok, true);
  const sum = (semester) => Object.values(result.allocations).reduce((acc, value) => acc + value[semester], 0);
  assert.equal(sum("1"), 50, "1학기 공통 시수 전부(40 + 10)");
  assert.equal(sum("2"), 68);
  assert.deepEqual(result.allocations["과학-공통 교사 없음"], { 1: 0, 2: 0 });
  for (const semester of ["1", "2"]) {
    const loads = members.filter((member) => member.teachers > 0)
      .map((member) => (member.hours[semester] + result.allocations[member.id][semester]) / member.teachers);
    assert.ok(Math.max(...loads) - Math.min(...loads) <= 4 / 2 + 1e-9, `${semester}학기 1인당 시수 차이는 한 반(4시간) 이내: ${loads}`);
    for (const member of members) assert.equal(result.allocations[member.id][semester] % 1, 0);
  }
  // 배분 메모는 원래 양식처럼 줄인 과목명 + 시수('통과8 · 과탐실2').
  assert.match(result.notes["과학-지구"]["1"], /^(통과|과탐실)\d+( · (통과|과탐실)\d+)?$/);
  const hours = (note) => [...note.matchAll(/\d+/g)].reduce((acc, match) => acc + Number(match[0]), 0);
  for (const member of members) assert.equal(hours(result.notes[member.id]["1"] || ""), result.allocations[member.id]["1"]);
  assert.equal(ctx.hoursBalanceCommonAllocation(members.map((member) => ({ ...member, teachers: 0 })), items).ok, false);
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
