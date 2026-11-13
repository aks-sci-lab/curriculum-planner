const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// 다른 학교용 안내(school-guide.js): 예시·빈 양식이 앱 변환기로 읽히는지, 읽지 못한 이유 안내, 학년도 기본값.
const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const appFunction = (name) => {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf("\n    function ", start + 1);
  assert.ok(start >= 0 && end > start, name);
  return app.slice(start, end);
};

function context() {
  const ctx = vm.createContext({
    CURRICULUM_DETAIL_OPTIONS: ["공통", "일반선택", "진로선택", "융합선택"],
    CURRICULUM_SEMESTER_FIELDS: ["sem11", "sem12", "sem21", "sem22", "sem31", "sem32"],
    escapeHtml: (value) => String(value ?? ""),
  });
  for (const name of ["columnIndex", "columnName", "curriculumCellFill", "normalizeCurriculumDetail",
    "curriculumSelectionType", "normalizeCurriculumDivision", "normalizeCurriculumAreaName", "isSelectableDetail",
    "normalizeCurriculumPlanRow", "planSubjectKey", "sheetMergeReferenceSet", "importedPlanCoveredCells", "importedPlanCourseContexts",
    "curriculumSubjectNames", "importedPlanColumnMap", "expandCurriculumLayoutRows", "insertImportedPlanLayoutRow",
    "createCurriculumPlanRecords", "curriculumPlanFromLayout", "planRowsFromImportedLayout"]) {
    vm.runInContext(appFunction(name), ctx);
  }
  const workbook = fs.readFileSync(path.join(root, "curriculum-workbook.js"), "utf8");
  vm.runInContext(workbook.slice(0, workbook.indexOf('document.getElementById("exportCurriculumPlan")')), ctx);
  for (const file of ["curriculum-subject-list.js", "curriculum-choice-blocks.js", "curriculum-data.js", "school-guide.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), ctx);
  }
  return ctx;
}

test("학년도 기본값은 오늘 날짜 기준(3월에 새 학년도)", () => {
  const ctx = context();
  assert.equal(ctx.schoolGuideDefaultYear(new Date(2026, 10, 13)), "2026");
  assert.equal(ctx.schoolGuideDefaultYear(new Date(2027, 1, 20)), "2026");
  assert.equal(ctx.schoolGuideDefaultYear(new Date(2027, 2, 2)), "2027");
});

test("예시 양식은 앱 변환기가 과목·선택과목군으로 읽는다", () => {
  const ctx = context();
  const sheet = plain(ctx.curriculumSamplePlanSheet({ year: "2026" }));
  const layout = ctx.curriculumSamplePlanLayout(sheet);
  assert.equal(ctx.ensureCurriculumPlanData(layout), true, layout.planDataError);
  assert.equal(layout.planDataError, undefined);
  const data = plain(layout.planData);
  const names = data.subjects.filter((item) => !item.fixed).map((item) => item.name);
  assert.equal(names.length, 32);
  assert.ok(names.includes("공통국어1") && names.includes("인공지능 기초"));
  const groups = data.groups.map((group) => ({ pick: group.pick, credit: group.credit, field: group.field || group.fields?.[0], size: (group.subjects || group.members || group.ids || []).length }));
  assert.deepEqual(groups.map((group) => [group.pick, group.credit]), [[2, 4], [2, 4], [1, 4], [1, 4]], JSON.stringify(data.groups));
  // 학교 지정 20과목은 신청 과목이 아니고 선택과목군 12과목만 학생 선택.
  const school = data.subjects.filter((item) => !item.fixed && ctx.planDataSchoolDesignated(item, data));
  assert.equal(school.length, 20);
  // 공식 과목명과 다른 이름이 없다(자동 수정 대상 0).
  ctx.curriculumApplyAutoNames(layout, "2026");
  assert.equal(ctx.curriculumAutoNameList(layout).length, 0);
});

test("빈 양식은 머리글은 모두 찾고 '과목 행 없음'으로 안내한다", () => {
  const ctx = context();
  const layout = ctx.curriculumSamplePlanLayout(plain(ctx.curriculumSamplePlanSheet({ blank: true })));
  assert.equal(ctx.ensureCurriculumPlanData(layout), false);
  const guide = plain(ctx.curriculumPlanErrorGuide(layout));
  assert.match(guide.reason, /과목 행을 찾지 못했습니다/);
  assert.ok(guide.found.some((line) => /과목명: D열/.test(line)));
  assert.ok(guide.found.some((line) => /1-1\(G열\).*3-2\(L열\)/.test(line)));
  assert.ok(!guide.missing.some((line) => /과목명 열|학기 열/.test(line)));
  assert.match(guide.steps[0], /울산 편제 점검 프로그램/);
});

test("머리글이 다른 표는 무엇을 못 찾았는지 알려 준다", () => {
  const ctx = context();
  const layout = {
    sheetName: "편제", rows: [
      ["교과", "과목", "단위", "1학년", "2학년", "3학년"],
      ["국어", "국어", "8", "8", "", ""],
      ["수학", "수학", "8", "8", "", ""],
    ], mergedRanges: [], formulas: {}, cellFills: {}, rowHeights: {}, hiddenRows: [], columnWidths: [8, 8, 8, 8, 8, 8],
  };
  assert.equal(ctx.ensureCurriculumPlanData(layout), false);
  assert.ok(layout.planDataError);
  const guide = plain(ctx.curriculumPlanErrorGuide(layout));
  assert.ok(guide.missing.some((line) => /과목명 열/.test(line)), JSON.stringify(guide));
  assert.ok(guide.missing.some((line) => /학기 열 1-1, 1-2, 2-1, 2-2, 3-1, 3-2/.test(line)));
  // 다시 읽기에 성공하면 오류 기록을 지운다.
  const good = ctx.curriculumSamplePlanLayout(plain(ctx.curriculumSamplePlanSheet({ year: "2026" })));
  good.planDataError = "예전 오류";
  assert.equal(ctx.ensureCurriculumPlanData(good), true);
  assert.equal(good.planDataError, undefined);
});

test("첫 실행 안내 단계", () => {
  const ctx = context();
  const steps = plain(ctx.schoolGuideSteps({ schoolName: "", schoolYear: "2026", cohortsNeeded: ["2027", "2026", "2025"], cohortsLoaded: ["2026"] }));
  assert.deepEqual(steps.map((step) => step.done), [false, false, false]);
  assert.match(steps[1].detail, /2027학년도 입학생, 2025학년도 입학생/);
  const done = plain(ctx.schoolGuideSteps({ schoolName: "가상고", schoolYear: "2026", cohortsNeeded: ["2026"], cohortsLoaded: [2026], hasResults: true }));
  assert.deepEqual(done.map((step) => step.done), [true, true, true]);
});
