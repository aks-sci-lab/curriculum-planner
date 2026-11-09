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

test("교사 수 추천: 1인당 시수가 학교 평균에서 가장 덜 벗어나게 정수로 나누고, 같으면 지금 교사 수에 가깝게", () => {
  const ctx = pureContext();
  const run = (units, options) => plain(ctx.hoursRecommendTeachers(units, options));
  const counts = (result) => result.rows.map((row) => row.recommended);
  // 평균 12.5: A3·B1(13.3/10, 최대 편차 2.5)이 A2·B2(20/2.5)보다 고르다.
  const basic = run([{ id: "A", hours: { 1: 40, 2: 40 }, current: 2 }, { id: "B", hours: { 1: 10, 2: 10 }, current: 2 }], { total: 4 });
  assert.equal(basic.ok, true);
  assert.deepEqual(counts(basic), [3, 1]);
  assert.deepEqual(basic.rows.map((row) => row.diff), [1, -1]);
  assert.deepEqual(basic.range, { current: [5, 20], recommended: [10, 40 / 3] });
  // 편차가 같으면 지금 교사 수와 차이가 적은 쪽.
  assert.deepEqual(counts(run([{ id: "A", hours: { 1: 12, 2: 12 }, current: 1 }, { id: "B", hours: { 1: 12, 2: 12 }, current: 2 }], { total: 3 })), [1, 2]);
  // 고정한 교과는 그대로, 나머지 교사로 나눈다.
  const locked = run([{ id: "A", hours: { 1: 40, 2: 40 }, current: 2 }, { id: "B", hours: { 1: 10, 2: 10 }, current: 2, locked: true }], { total: 4 });
  assert.deepEqual(counts(locked), [2, 2]);
  assert.equal(locked.rows[1].locked, true);
  // 두 학기를 함께 본다: 1학기만 많은 교과와 2학기만 많은 교과.
  const semesters = run([{ id: "A", hours: { 1: 30, 2: 10 }, current: 1 }, { id: "B", hours: { 1: 10, 2: 30 }, current: 3 }], { total: 4 });
  assert.deepEqual(counts(semesters), [2, 2]);
  // 혼자서는 고르게 할 수 없는 교과(시수 2시간도 최소 1명)가 최대 편차를 정해도 나머지는 다시 고르게 나눈다(B 2·C 4가 아니라 3·3).
  assert.deepEqual(counts(run([{ id: "A", hours: { 1: 2, 2: 2 }, current: 0 }, { id: "B", hours: { 1: 40, 2: 40 }, current: 1 }, { id: "C", hours: { 1: 40, 2: 40 }, current: 5 }], { total: 7 })), [1, 3, 3]);
  // 한도를 넘는 교과는 표시한다.
  assert.equal(run([{ id: "A", hours: { 1: 21, 2: 21 }, current: 1, locked: true }, { id: "B", hours: { 1: 10, 2: 10 }, current: 1 }], { total: 2 }).rows[0].overCap, true);
  // 시수가 있으면 최소 1명, 시수가 없으면 0명(감원 추천).
  assert.deepEqual(counts(run([{ id: "A", hours: { 1: 100, 2: 100 }, current: 4 }, { id: "B", hours: { 1: 2, 2: 2 }, current: 0 }, { id: "C", hours: { 1: 0, 2: 0 }, current: 1 }], { total: 6 })), [5, 1, 0]);
  // 한 학기 최대 시수: 42시간이면 20시간 한도로 3명 이상이어야 하니 3명으로는 둘 다 못 맞춘다.
  const capped = run([{ id: "A", hours: { 1: 42, 2: 42 }, current: 2 }, { id: "B", hours: { 1: 18, 2: 18 }, current: 1 }], { total: 3 });
  assert.equal(capped.ok, false);
  assert.match(capped.reason, /20시간을 넘지 않으려면 교과 교사가 최소 4명/);
  assert.deepEqual(counts(run([{ id: "A", hours: { 1: 42, 2: 42 }, current: 2 }, { id: "B", hours: { 1: 18, 2: 18 }, current: 1 }], { total: 3, maxHours: 25 })), [2, 1]);
  assert.match(run([{ id: "A", hours: { 1: 4, 2: 4 } }, { id: "B", hours: { 1: 4, 2: 4 } }, { id: "C", hours: { 1: 4, 2: 4 } }], { total: 2 }).reason, /최소 3명/);
  assert.match(run([{ id: "A", hours: { 1: 4, 2: 4 } }], { total: 0 }).reason, /교과 교사 수를 입력/);
});

test("교사 수 추천: 작은 경우를 모두 따져 본 최대 편차와 같고, 합은 기준 교사 수와 같다", () => {
  const ctx = pureContext();
  let seed = 7;
  const random = (max) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % max; };
  for (let trial = 0; trial < 150; trial++) {
    const size = 2 + random(3);
    const units = Array.from({ length: size }, (_, index) => ({ id: `U${index}`, hours: { 1: random(40), 2: random(40) }, current: random(4) }));
    if (units.every((unit) => !unit.hours["1"] && !unit.hours["2"])) units[0].hours["1"] = 8;
    const busy = units.filter((unit) => unit.hours["1"] || unit.hours["2"]).length;
    const total = busy + random(6);
    const result = ctx.hoursRecommendTeachers(units, { total, maxHours: 0 });
    assert.equal(result.ok, true);
    const counts = result.rows.map((row) => row.recommended);
    assert.equal(counts.reduce((a, b) => a + b, 0), total);
    const average = { 1: units.reduce((a, u) => a + u.hours["1"], 0) / total, 2: units.reduce((a, u) => a + u.hours["2"], 0) / total };
    const deviation = (list) => Math.max(...units.map((unit, index) => {
      const n = list[index];
      if (!n) return unit.hours["1"] || unit.hours["2"] ? Infinity : 0;
      return Math.max(Math.abs(unit.hours["1"] / n - average["1"]), Math.abs(unit.hours["2"] / n - average["2"]));
    }));
    let best = Infinity;
    const walk = (index, left, list) => {
      if (index === size) { if (!left) best = Math.min(best, deviation(list)); return; }
      for (let n = 0; n <= left; n++) walk(index + 1, left - n, [...list, n]);
    };
    walk(0, total, []);
    assert.ok(Math.abs(deviation(counts) - best) < 1e-6, `trial ${trial}: ${deviation(counts)} vs ${best}`);
  }
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
  assert.match(result.notes["과학-지구"]["1"], /통합과학1 \d반/);
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
  assert.match(ctx.hoursStaffFormula(before), /총 교사 수 <span class="hours-suggested"[^>]*>6 \(제안값\)<\/span> = 교과 5 \+ 진로 1\(평균 제외\) \+ 비교과 0\(보건 0·영양 0·사서 0·상담 0\)$/);
  const average = before.totals.average.year;

  settings["2027"].totalTeachers = 12;
  settings["2027"].nonTeaching = { "보건": 1, "영양": 1, "사서": 1, "상담": 1 };
  const after = ctx.computeHoursStats("2027");
  assert.equal(after.totals.average.year, average, "비교과 교사 수를 넣어도 교과 평균은 그대로");
  assert.deepEqual(plain([after.staff.total, after.staff.subject, after.staff.career, after.staff.nonTeaching, after.staff.other, after.staff.over]), [12, 5, 1, 4, 2, false]);
  assert.equal(ctx.hoursStaffFormula(after), "총 교사 수 <b>12</b> = 교과 5 + 진로 1(평균 제외) + 비교과 4(보건 1·영양 1·사서 1·상담 1) + 기타 2(교과 미배정)");
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

  // 엑셀 요약 시트: 교과 평균 줄과 전체 교원 기준 평균(참고) 줄, 교원 구성 표.
  settings["2027"].totalTeachers = 12;
  const stats = ctx.computeHoursStats("2027");
  const sheets = ctx.buildHoursWorkbookSheets(stats);
  const summary = sheets[0].rows;
  const labels = summary.map((row) => row[0]?.v);
  assert.ok(labels.includes("교과 교사 1인당 평균 (창체 제외)"));
  const reference = summary.find((row) => String(row[0]?.v).startsWith("전체 교원 기준 평균 (참고)"));
  assert.ok(reference && reference[15].f.includes("SUM(E"));
  const staffStart = labels.indexOf("교원 구성");
  assert.deepEqual(plain(labels.slice(staffStart, staffStart + 9)), ["교원 구성", "총 교사 수", "교과 교사 (진로 제외)", "진로 (평균 제외)",
    "비교과 · 보건교사", "비교과 · 영양교사", "비교과 · 사서교사", "비교과 · 전문상담교사", "기타 (교과 미배정)"]);
  assert.equal(summary[staffStart + 1][3].v, 12);
  assert.equal(summary[staffStart + 4][4].v, 10);
  assert.match(summary[staffStart + 4][7].v, /맡은 과목: 1-1 보건 10시간 · 직접 입력 0\/3시간/);
  assert.equal(summary[staffStart + 8][3].f, `D${staffStart + 2}-SUM(D${staffStart + 3}:D${staffStart + 8})`);
  assert.equal(summary[staffStart + 8][3].v, 2);
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
  assert.match(hoursStats, /\["creativeHours", "totalTeachers", "maxTeacherHours"\]/);
});
