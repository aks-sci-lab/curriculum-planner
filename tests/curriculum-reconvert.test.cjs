const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// 원본 재변환(예전 변환기 자료 → 보관 원본을 새 변환기로 다시 읽기, 편집 재적용·충돌 확인·원본 없음),
// 공식 과목명 자동 수정, 교차집중 홀수 학급 배분, 편제 점검 '해당 위치로', 드래그 묶기 데이터 편집.
// 실제 학교 파일 대신 같은 모양의 합성 편제표를 쓴다.
const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const app = read("app.js");
const plain = (value) => JSON.parse(JSON.stringify(value));
const appFunction = (name) => {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf("\n    function ", start + 1);
  assert.ok(start >= 0 && end > start, name);
  return app.slice(start, end);
};
const pure = (file, marker = "\n// ---- 앱 연결") => {
  const source = read(file);
  const index = source.indexOf(marker);
  return index >= 0 ? source.slice(0, index) : source;
};

function context(extra = {}) {
  const ctx = vm.createContext({
    CURRICULUM_DETAIL_OPTIONS: ["공통", "일반선택", "진로선택", "융합선택"],
    CURRICULUM_SEMESTER_FIELDS: ["sem11", "sem12", "sem21", "sem22", "sem31", "sem32"],
    escapeHtml: (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    ...extra
  });
  for (const name of ["columnIndex", "columnName", "curriculumCellFill", "normalizeCurriculumDetail",
    "curriculumSelectionType", "normalizeCurriculumDivision", "normalizeCurriculumAreaName", "isSelectableDetail",
    "normalizeCurriculumPlanRow", "planSubjectKey", "sheetMergeReferenceSet", "importedPlanCoveredCells", "importedPlanCourseContexts",
    "curriculumSubjectNames", "importedPlanColumnMap", "expandCurriculumLayoutRows", "insertImportedPlanLayoutRow",
    "createCurriculumPlanRecords", "curriculumPlanFromLayout", "planRowsFromImportedLayout", "normalizeRomanNumerals"]) {
    vm.runInContext(appFunction(name), ctx);
  }
  const workbook = read("curriculum-workbook.js");
  vm.runInContext(workbook.slice(0, workbook.indexOf('document.getElementById("exportCurriculumPlan")')), ctx);
  const versions = read("curriculum-versions.js");
  vm.runInContext(versions.slice(0, versions.indexOf("function initCurriculumVersions(")), ctx);
  for (const file of ["curriculum-subject-list.js", "curriculum-choice-blocks.js", "curriculum-data.js", "curriculum-data-view.js", "curriculum-annual.js"]) {
    vm.runInContext(read(file), ctx);
  }
  vm.runInContext(pure("course-checks.js"), ctx);
  vm.runInContext(pure("curriculum-compliance.js"), ctx);
  vm.runInContext(read("curriculum-reconvert.js"), ctx);
  const result = read("result-import.js");
  vm.runInContext(result.slice(result.indexOf("function normalizeResultCourseName("), result.indexOf("function resultCourseSemester(")), ctx);
  return ctx;
}

const blank = () => Array(14).fill("");
const row = (values) => Object.assign(blank(), values);
const header = () => [
  row({ 0: "2026학년도 신입생 3개년 교육과정 편제표" }),
  row({ 6: "○○고등학교" }),
  row({ 0: "구분", 1: "교과(군)", 2: "세부과목", 4: "기준학점", 5: "운영학점", 6: "1학년", 8: "2학년", 10: "3학년", 12: "이수학점", 13: "필수이수학점" }),
  row({ 6: "1학기", 7: "2학기", 8: "1학기", 9: "2학기", 10: "1학기", 11: "2학기" }),
];
const headerMerges = ["A1:N1", "G2:N2", "A3:A4", "B3:B4", "C3:D4", "E3:E4", "F3:F4", "G3:H3", "I3:J3", "K3:L3", "M3:M4", "N3:N4"];

// 원본: 공통국어1(지정), 예술 교차집중(음악, 미술 · '교차집중(↔)'), 지구시스템 과학(띄어쓰기 오류, 지정 2-1),
// 3-2 '택2' 묶음 학점 칸은 첫 칸을 가리키는 수식만(예전 변환기는 0으로 읽음).
function original() {
  return {
    sheetName: "편제표", sheetPath: "xl/worksheets/sheet1.xml", sourceRowOffset: 0, sourceColumnOffset: 0, rowInsertions: [], originalRowCount: 14,
    rows: [
      ...header(),
      row({ 0: "학교 지정 교육과정", 1: "국어", 2: "공통", 3: "공통국어1", 4: "4", 5: "4", 6: "4", 12: "4" }),
      row({ 1: "예술", 2: "일반", 3: "음악, 미술", 4: "3", 5: "2", 6: "교차집중(↔)", 12: "4" }),
      row({ 6: "2", 7: "2" }),
      row({ 1: "과학", 2: "일반", 3: "지구시스템 과학", 4: "4", 5: "4", 8: "4", 12: "4" }),
      row({ 0: "학생 선택 교육과정", 1: "국어", 2: "진로", 3: "주제 탐구 독서", 4: "4", 5: "4", 11: "택2", 12: "8" }),
      row({ 1: "국어", 2: "융합", 3: "독서 토론과 글쓰기", 4: "4", 5: "4", 11: "" }),
      row({ 1: "수학", 2: "융합", 3: "수학과제 탐구", 4: "4", 5: "4", 11: "" }),
      row({ 0: "이수학점 소계", 6: "6", 7: "2", 8: "4", 9: "0", 10: "0", 11: "8", 12: "20" }),
      row({ 0: "창의적 체험활동", 6: "3", 7: "3", 8: "3", 9: "3", 10: "3", 11: "3", 12: "18" }),
      row({}),
    ],
    mergedRanges: [...headerMerges, "A5:A8", "G6:H6", "D6:D7", "E6:E7", "F6:F7", "M6:M7", "A9:A11", "M9:M11", "A12:F12", "A13:F13"],
    formulas: { "4:12": "SUM(G5:L5)", "5:12": "SUM(G6:L7)", "7:12": "SUM(G8:L8)", "8:12": "SUM(G9:L11)", "9:11": "L10", "10:11": "L10",
      "11:6": "SUM(G5:G11)", "11:7": "SUM(H5:H11)", "11:8": "SUM(I5:I11)", "11:9": "SUM(J5:J11)", "11:10": "SUM(K5:K11)", "11:11": "SUM(L5:L11)" },
    cellFills: {}, rowHeights: {}, hiddenRows: [], columnWidths: [10, 10, 6, 24, 6, 6, 6, 6, 6, 6, 6, 6, 8, 8],
  };
}
// 3-2 학점 칸 하나에 4를 적은 원본(수식 칸은 이 칸을 가리킨다)
function originalWithCredit() {
  const layout = original();
  layout.rows[9][11] = "4";
  delete layout.formulas["9:11"];
  return layout;
}

// 업로드와 같은 단계: 변환 → 공식 과목명 자동 수정
function upload(ctx, layout = originalWithCredit(), year = "2026") {
  const copy = plain(layout);
  assert.equal(ctx.ensureCurriculumPlanData(copy), true, copy.planDataError);
  copy.archiveId = "a1";
  ctx.curriculumApplyAutoNames(copy, year);
  return copy;
}

// 예전 변환기 결과(이 브랜치 이전): 교차집중이 1·2학기 택1 묶음, 3-2 묶음 학점 0, 과목명 그대로, 변환기 표시 없음
function legacy(ctx) {
  const layout = upload(ctx);
  const data = layout.planData;
  delete data.converter;
  for (const subject of data.subjects) {
    if (subject.originalName !== undefined) { subject.name = subject.originalName; delete subject.originalName; }
    if (subject.cross) {
      const fields = subject.cross, credit = subject.credits[fields[0]];
      subject.cross = null;
      for (const field of fields) delete subject.credits[field];
      data.groups.push({ id: "g90", fields, pick: 1, credit, members: [subject.id] });
    }
  }
  data.groups.find((group) => group.fields.join() === "sem32").credit = 0;
  ctx.applyCurriculumData(layout);
  return layout;
}
const byName = (layout, name) => layout.planData.subjects.find((item) => item.name === name);
const comparable = (data) => plain(data.subjects.filter((item) => !item.fixed).map((item) => ({
  name: item.name, originalName: item.originalName, credits: item.credits, cross: item.cross, op: item.op })))
  .concat(plain((data.groups || []).map((group) => ({ fields: group.fields, pick: group.pick, credit: group.credit }))));

test("새 변환기: 수식만 있는 묶음 학점 칸을 읽고, 교차집중·공식 과목명 자동 수정, 변환기 표시를 남긴다", () => {
  const ctx = context();
  const layout = upload(ctx, original());
  assert.equal(layout.planData.converter, vm.runInContext("PLAN_DATA_CONVERTER", ctx));
  assert.deepEqual(plain(byName(layout, "음악, 미술").cross), ["sem11", "sem12"]);
  const earth = byName(layout, "지구시스템과학");
  assert.equal(earth.originalName, "지구시스템 과학");
  // 학점 칸에 숫자가 없으면 저장값은 0, 계산할 때만 운영학점
  const group = layout.planData.groups.find((item) => item.fields.join() === "sem32");
  assert.equal(group.credit, 0);
  assert.equal(ctx.planDataGroupCredit(layout.planData, group), 4);
  assert.equal(upload(ctx).planData.groups.find((item) => item.fields.join() === "sem32").credit, 4, "칸에 숫자가 있으면 그 값");
});

test("원본 재변환: 업로드 뒤 고친 곳이 없으면 새로 올린 것과 같은 데이터가 된다", () => {
  const ctx = context();
  const old = legacy(ctx);
  const fresh = upload(ctx);
  const base = { data: plain(old.planData), template: plain(old.planTemplate) };
  const current = { data: plain(old.planData), template: plain(old.planTemplate) };
  const edits = ctx.planReconvertEdits(base, current);
  assert.deepEqual(plain(edits), []);
  const result = ctx.planReconvertApply(base, { data: fresh.planData, template: fresh.planTemplate }, edits);
  assert.deepEqual(comparable(result.data), comparable(fresh.planData));
  const summary = ctx.planReconvertSummary(base, { data: fresh.planData, template: fresh.planTemplate });
  assert.equal(ctx.planReconvertSummaryText(summary), "교차집중 1곳, 묶음 학점 1곳 갱신 · 공식 과목명 1곳 자동 수정");
});

test("원본 재변환: 업로드 뒤 고친 학점·행 삭제·행 이동은 새 데이터에 다시 적용한다", () => {
  const ctx = context();
  const old = legacy(ctx);
  const base = { data: plain(old.planData), template: plain(old.planTemplate) };
  let edited = ctx.curriculumDataSetCell(old, { id: byName(old, "공통국어1").id, field: "sem11" }, "5").layout;
  edited = ctx.curriculumDataDeleteRow(edited, byName(edited, "지구시스템 과학").id).layout;
  edited = ctx.curriculumDataEdit(edited, (data) => {
    const first = data.subjects.findIndex((item) => item.name === "공통국어1");
    [data.subjects[first], data.subjects[first + 1]] = [data.subjects[first + 1], data.subjects[first]];
  }).layout;
  const current = { data: edited.planData, template: edited.planTemplate };
  const edits = ctx.planReconvertEdits(base, current);
  assert.deepEqual(plain(edits.map((edit) => edit.type)).sort(), ["field", "move", "remove"]);
  const fresh = upload(ctx);
  const result = ctx.planReconvertApply(base, { data: fresh.planData, template: fresh.planTemplate }, edits);
  assert.deepEqual(plain(result.conflicts), []);
  const names = result.data.subjects.filter((item) => !item.fixed).map((item) => item.name);
  assert.deepEqual(plain(names.slice(0, 2)), ["음악, 미술", "공통국어1"]);
  assert.equal(names.includes("지구시스템과학"), false);
  assert.equal(result.data.subjects.find((item) => item.name === "공통국어1").credits.sem11, 5);
  assert.deepEqual(plain(result.data.subjects.find((item) => item.name === "음악, 미술").cross), ["sem11", "sem12"]);
  assert.equal(result.data.groups.find((group) => group.fields.join() === "sem32").credit, 4, "새 원본에서 읽은 묶음 학점");
  assert.match(ctx.planReconvertEditText(edits.find((edit) => edit.type === "field"), base, current), /공통국어1 · 학점 1-1: 4 → 5/);
  assert.match(ctx.planReconvertEditText(edits.find((edit) => edit.type === "remove"), base, current), /과목 삭제: 지구시스템 과학/);
});

test("원본 재변환: 새 원본에 없는 묶음을 고쳤으면 충돌로 돌려준다", () => {
  const ctx = context();
  const old = legacy(ctx);
  const base = { data: plain(old.planData), template: plain(old.planTemplate) };
  const edited = ctx.curriculumDataUpdateGroup(old, "g90", { pick: "1", credit: "3" }).layout;
  const current = { data: edited.planData, template: edited.planTemplate };
  const edits = ctx.planReconvertEdits(base, current);
  const fresh = upload(ctx);
  const result = ctx.planReconvertApply(base, { data: fresh.planData, template: fresh.planTemplate }, edits);
  assert.equal(result.conflicts.length, 1);
  assert.match(ctx.planReconvertEditText(result.conflicts[0], base, current), /선택과목군 1-1·2 택1 · 학점: 2 → 3/);
  assert.match(result.conflicts[0].reason, /같은 선택과목군을 찾지 못했습니다/);
});

// 앱 연결 부분: 저장된 편제표 하나(2026 입학생)를 state에 두고 원본 재변환을 실행한다.
function appContext({ buffer = true, origin = null, versions = [], answer = false } = {}) {
  const asked = [];
  const ctx = context({
    state: { curriculumPlanType: "cohort", curriculumCohortYear: "2027", curriculumCohorts: {}, curriculumVersions: {}, curriculumMutationRevision: 0, curriculumUndoStack: [] },
    document: undefined
  });
  vm.runInContext(`var recorded = []; function recordCurriculumVersion(year, layout, options) { recorded.push({ year, reason: options.reason, basis: options.basis }); }
    function syncActiveCurriculumCohort() {}`, ctx);
  ctx.curriculumArchiveStore = async (operation, key) => key.startsWith("origin:") ? origin : buffer ? "buffer" : null;
  ctx.curriculumReconvertAsk = async (info) => { asked.push(info); return answer; };
  return { ctx, asked };
}

test("앱: 원본이 없으면 데이터를 바꾸지 않고 '원본 파일을 다시 올리면' 안내·카드 표시만 한다", async () => {
  const { ctx } = appContext({ buffer: false });
  const old = legacy(ctx);
  const before = JSON.stringify(old.planData);
  ctx.state.curriculumCohorts["2026"] = { fileName: "f.xlsx", importedLayout: old, plan: [] };
  const target = ctx.curriculumReconvertTargets()[0];
  const result = await ctx.reconvertCurriculumLayout(target);
  assert.equal(result.status, "no-original");
  assert.match(result.text, /원본 파일을 다시 올리면 정확히 갱신됩니다/);
  assert.equal(JSON.stringify(ctx.state.curriculumCohorts["2026"].importedLayout.planData), before);
  assert.match(ctx.curriculumReconvertCardHtml("2026", old), /원본 다시 올리기 권장/);
});

test("앱: 원본이 있고 고친 곳이 없으면 자동으로 다시 읽어 바꾸고 이력에 남긴다(교차집중·묶음 학점 안내)", async () => {
  const { ctx, asked } = appContext();
  const old = legacy(ctx);
  ctx.state.curriculumVersions["2026"] = [{ id: "v1", snapshot: { layout: plain(old) } }];
  ctx.state.curriculumCohorts["2026"] = { fileName: "f.xlsx", importedLayout: old, plan: [] };
  const fresh = upload(ctx);
  ctx.curriculumReconvertFresh = async () => ({ data: plain(fresh.planData), template: plain(fresh.planTemplate) });
  const result = await ctx.reconvertCurriculumLayout(ctx.curriculumReconvertTargets()[0]);
  assert.equal(result.status, "done");
  assert.equal(asked.length, 0, "확인 창 없음");
  assert.match(result.text, /2026학년도 입학생 편제표를 원본으로 다시 읽었습니다\(교차집중 1곳, 묶음 학점 1곳 갱신 · 공식 과목명 1곳 자동 수정\)/);
  const next = ctx.state.curriculumCohorts["2026"].importedLayout;
  assert.notEqual(next, old);
  assert.equal(next.planData.converter, vm.runInContext("PLAN_DATA_CONVERTER", ctx));
  assert.deepEqual(comparable(next.planData), comparable(fresh.planData));
  assert.equal(vm.runInContext("recorded[0].reason", ctx), "원본 다시 읽기(변환기 갱신)");
  assert.equal(ctx.curriculumReconvertNeeded(next), false);
});

test("앱: 충돌하는 편집이 있으면 확인 창을 띄우고, 거절하면 그대로 두고 '원본 갱신 필요' 단추를 단다", async () => {
  const { ctx, asked } = appContext({ answer: false });
  const old = legacy(ctx);
  ctx.state.curriculumVersions["2026"] = [{ id: "v1", snapshot: { layout: plain(old) } }];
  const edited = ctx.curriculumDataUpdateGroup(old, "g90", { pick: "1", credit: "3" }).layout;
  edited.archiveId = "a1";
  ctx.state.curriculumCohorts["2026"] = { fileName: "f.xlsx", importedLayout: edited, plan: [] };
  const before = JSON.stringify(edited.planData);
  const fresh = upload(ctx);
  ctx.curriculumReconvertFresh = async () => ({ data: plain(fresh.planData), template: plain(fresh.planTemplate) });
  const result = await ctx.reconvertCurriculumLayout(ctx.curriculumReconvertTargets()[0]);
  assert.equal(result.status, "declined");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].lost.length, 1);
  assert.match(asked[0].lost[0], /학점: 2 → 3/);
  assert.equal(JSON.stringify(ctx.state.curriculumCohorts["2026"].importedLayout.planData), before);
  assert.match(ctx.curriculumReconvertCardHtml("2026", edited), /data-reconvert-cohort="2026"[^>]*>원본 갱신 필요/);
  // 다시 열 때(startup)는 묻지 않는다
  const again = await ctx.reconvertCurriculumOriginals({ startup: true });
  assert.equal(again.length, 0);
});

test("앱: 업로드 시점 기록이 없으면 지금 편제표와 원본이 다른 곳을 보여 주고 승인하면 원본 기준으로 바꾼다", async () => {
  const { ctx, asked } = appContext({ answer: true });
  const old = legacy(ctx);
  ctx.state.curriculumCohorts["2026"] = { fileName: "f.xlsx", importedLayout: old, plan: [] };
  const fresh = upload(ctx);
  ctx.curriculumReconvertFresh = async () => ({ data: plain(fresh.planData), template: plain(fresh.planTemplate) });
  const result = await ctx.reconvertCurriculumLayout(ctx.curriculumReconvertTargets()[0]);
  assert.equal(asked[0].unknown, true);
  assert.ok(asked[0].lost.some((text) => /과목명: 지구시스템 과학 → 지구시스템과학/.test(text)), asked[0].lost.join(" / "));
  assert.equal(result.status, "done");
  assert.deepEqual(comparable(ctx.state.curriculumCohorts["2026"].importedLayout.planData), comparable(fresh.planData));
});

test("공식 과목명 자동 수정: 확실한 경우만 고치고 원래 이름을 남기며, 되돌리기·끄기·2015 개정 제외", () => {
  const ctx = context();
  const fix = (name) => plain(ctx.curriculumOfficialAutoName(name));
  assert.deepEqual(fix("지구시스템 과학"), { name: "지구시스템과학", kind: "notation" });
  assert.deepEqual(fix("고급물리학"), { name: "고급 물리학", kind: "notation" });
  assert.deepEqual(fix("미적분1"), { name: "미적분Ⅰ", kind: "notation" });
  assert.deepEqual(fix("확률과통계"), { name: "확률과 통계", kind: "notation" });
  for (const name of ["물리학 실험", "프로그래밍", "음악", "미적분Ⅱ", "영어3", "☆독서 토론 캠프"]) assert.equal(fix(name), null, name);
  const typo = fix("확률과 통게");
  assert.deepEqual(typo, { name: "확률과 통계", kind: "typo" }, "편집 거리 1, 후보 하나");
  const layout = upload(ctx);
  const earth = byName(layout, "지구시스템과학");
  assert.deepEqual(plain(ctx.curriculumAutoNameList(layout).map((item) => [item.from, item.to])), [["지구시스템 과학", "지구시스템과학"]]);
  const reverted = ctx.curriculumDataRevertAutoName(layout, earth.id).layout;
  assert.equal(byName(reverted, "지구시스템 과학").originalName, undefined);
  const off = ctx.curriculumDataSetAutoNames(layout, false, "2026").layout;
  assert.equal(off.autoNameOff, true);
  assert.ok(byName(off, "지구시스템 과학"));
  const on = ctx.curriculumDataSetAutoNames(off, true, "2026").layout;
  assert.ok(byName(on, "지구시스템과학"));
  // 2015 개정(2024 입학생) 편제표는 고치지 않는다
  const old = plain(originalWithCredit());
  old.rows[0][0] = "2024학년도 신입생 3개년 교육과정 편제표";
  const legacyPlan = upload(ctx, old, "2024");
  assert.ok(byName(legacyPlan, "지구시스템 과학"));
  // 여러 과목 칸은 바뀐 과목만 고치고 쉼표·별표를 지킨다
  assert.equal(ctx.planDataAutoName("역학과 에너지, 지구시스템 과학, 고급물리학*").name, "역학과 에너지, 지구시스템과학, 고급 물리학*");
});

test("공식 과목명 자동 수정: 원래 이름도 같은 과목으로 연결하고 편제 점검 9번은 O + '자동 수정 n곳'", () => {
  const ctx = context();
  const layout = upload(ctx);
  ctx.state = { curriculumImportedLayout: layout, curriculumCohorts: {} };
  assert.equal(ctx.normalizeResultCourseName("지구시스템 과학"), ctx.normalizeResultCourseName("지구시스템과학"));
  const typo = upload(ctx, (() => { const plan = originalWithCredit(); plan.rows[7][3] = "확률과 통게"; plan.rows[7][1] = "수학"; return plan; })());
  ctx.state = { curriculumImportedLayout: typo, curriculumCohorts: {} };
  assert.ok(byName(typo, "확률과 통계"));
  assert.equal(ctx.normalizeResultCourseName("확률과 통게"), "확률과통계", "결과 파일이 예전 이름(오탈자)을 써도 연결");
  const report = ctx.planComplianceReport(layout, { cohortYear: "2026" });
  const a9 = report.items.find((item) => item.id === "a9");
  assert.equal(a9.status, "O");
  assert.match(a9.note, /자동 수정 1곳\(지구시스템 과학 → 지구시스템과학\)/);
});

test("교차집중 홀수 학급: 첫 학기에 1반 더 받을 과목을 고르고 둘째 학기는 반대, 시수·전학년이 그 값을 따른다", () => {
  const ctx = context();
  const layout = upload(ctx);
  const art = byName(layout, "음악, 미술");
  assert.deepEqual(plain(ctx.planDataCrossClasses(art, 11)), [[5, 6], [6, 5]], "기본: 1학기 미술 6");
  const chosen = ctx.curriculumDataSetCrossCredit(layout, art.id, "2", "음악").layout;
  const music = byName(chosen, "음악, 미술");
  assert.equal(music.crossSplit, "음악");
  assert.deepEqual(plain(ctx.planDataCrossClasses(music, 11)), [[6, 5], [5, 6]]);
  assert.deepEqual(plain(ctx.planDataCrossClasses(music, 10)), [[5, 5], [5, 5]]);
  assert.equal(byName(ctx.curriculumDataSetCrossCredit(chosen, art.id, "2", "미술").layout, "음악, 미술").crossSplit, undefined, "기본값으로 돌리면 지운다");
  const entries = ctx.curriculumDataPlanEntries(chosen).entries.filter((entry) => entry.crossed);
  assert.deepEqual(plain([...new Set(entries.map((entry) => entry.crossExtra))]), [0]);
  const hours = read("hours-stats.js");
  const start = hours.indexOf("function hoursDesignatedShare(");
  const hctx = vm.createContext({});
  vm.runInContext(hours.slice(start, hours.indexOf("function computeHoursStats(", start)), hctx);
  const share = (entry) => hctx.hoursDesignatedShare(11, entry);
  assert.deepEqual(plain(entries.map((entry) => share(entry))), [6, 5, 5, 6], "1학기 음악 6·미술 5, 2학기 음악 5·미술 6");
  // 전학년 편제표는 원본 입학생 편제표의 배분을 물려받는다
  assert.equal(ctx.curriculumDataSubjectCredits(chosen).get("음악").crossSplit, "음악");
  const plan = [
    { division: "학교 지정 교육과정", area: "예술", detail: "일반선택", subject: "음악", baseCredit: 3, opCredit: 2, sem11: "2", sem12: "2", crossNames: ["음악", "미술"], crossFields: ["sem11", "sem12"], crossSplit: "음악" },
    { division: "학교 지정 교육과정", area: "국어", detail: "공통", subject: "국어1", baseCredit: 4, opCredit: 4, sem11: "4" }
  ];
  const annual = ctx.buildAnnualCurriculumLayout({ "2027": { plan }, "2026": { plan: [] }, "2025": { plan: [] } }, "2027");
  assert.equal(ctx.ensureCurriculumPlanData(annual), true, annual.planDataError);
  ctx.curriculumDataApplyCrossSplits(annual);
  assert.equal(annual.planData.subjects.find((item) => item.name === "음악, 미술").crossSplit, "음악");
});

test("편제 점검 '해당 위치로': 학점 범위·과목명 항목은 과목 행, 합계 항목은 소계 행", () => {
  const ctx = context();
  const layout = upload(ctx);
  const data = layout.planData;
  data.subjects.find((item) => item.name === "공통국어1").credits.sem11 = 9;
  const report = ctx.planComplianceReport({ planData: data, planTemplate: layout.planTemplate }, { cohortYear: "2026" });
  const a3 = report.items.find((item) => item.id === "a3");
  const target = ctx.planComplianceItemTargets(report, a3);
  assert.deepEqual(plain(target.rows), [data.subjects.find((item) => item.name === "공통국어1").id]);
  assert.deepEqual(plain(ctx.planComplianceItemTargets(report, { id: "a1", note: "" })), { rows: [], footer: true, label: "소계 행" });
  const compliance = read("curriculum-compliance.js");
  assert.match(compliance, /function planComplianceFor\(key, \{ fresh = false \} = \{\}\)/);
  assert.match(compliance, /function exportPlanCompliance\(\) \{\n  const result = planComplianceFor\(planComplianceDialogKey, \{ fresh: true \}\);/);
  assert.match(compliance, /function printPlanCompliance\(\) \{\n  const result = planComplianceFor\(planComplianceDialogKey, \{ fresh: true \}\);/);
  assert.match(compliance, /확인필요 \$\{before\} → \$\{after\}/);
  assert.match(read("curriculum-data-view.js"), /planComplianceChanged\(\)/);
});

test("드래그 묶기 데이터: 두 학기 칸 → 교차집중, 묶음 띠 끝 끌기로 범위 늘리기·줄이기", () => {
  const ctx = context();
  const layout = upload(ctx);
  // 3-2 택2 묶음 아래 끝을 끌어 한 과목 줄이기 → 빠진 과목은 묶음 학점(계산값 4)을 자기 학점으로
  const group = layout.planData.groups.find((item) => item.fields.join() === "sem32");
  const middle = byName(layout, "독서 토론과 글쓰기");
  const shrunk = ctx.curriculumDataResizeGroup(layout, group.id, "bottom", middle.id).layout;
  const after = shrunk.planData.groups.find((item) => item.id === group.id);
  assert.deepEqual(plain(after.members), [byName(layout, "주제 탐구 독서").id, middle.id]);
  assert.equal(byName(shrunk, "수학과제 탐구").credits.sem32, 4);
  assert.throws(() => ctx.curriculumDataResizeGroup(layout, group.id, "bottom", byName(layout, "주제 탐구 독서").id), /택2을 유지할 수 없습니다/);
  // 다시 늘리기
  const grown = ctx.curriculumDataResizeGroup(shrunk, group.id, "bottom", byName(shrunk, "수학과제 탐구").id).layout;
  assert.equal(grown.planData.groups.find((item) => item.id === group.id).members.length, 3);
  assert.equal(byName(grown, "수학과제 탐구").credits.sem32, undefined);
  // 두 학기(2-1·2-2) × 두 과목 칸을 교차집중으로
  const pair = plain(layout);
  const columns = pair.planTemplate.columns.semesters;
  const a = byName(pair, "공통국어1"), b = byName(pair, "지구시스템과학");
  const selection = { column: columns[2], endColumn: columns[3], startRow: b.row, endRow: b.row };
  assert.throws(() => ctx.curriculumDataSelectionToCross(pair, selection), /두 개 이상/);
  const two = { column: columns[0], endColumn: columns[1], startRow: a.row, endRow: byName(pair, "음악, 미술").rowEnd };
  const crossed = ctx.curriculumDataSelectionToCross(pair, two);
  assert.equal(crossed.result.name, "공통국어1, 음악, 미술");
  assert.deepEqual(plain(crossed.result.cross), ["sem11", "sem12"]);
});

test("2단계 연동 칩 끌기: 편제표 묶음 사이로 과목 행을 옮기고, 다른 학기 묶음까지 바뀌면 막는다", () => {
  const ctx = context();
  const layout = upload(ctx);
  // 3-2 택2(3과목) 옆에 3-1 택1(2과목) 묶음을 새로 만든다
  const data = plain(layout.planData);
  const make = (id, name) => ({ ...plain(data.subjects.find((item) => item.name === "주제 탐구 독서")), id, name, styleRows: [null] });
  data.subjects.push(make("s80", "문학과 영상"), make("s81", "매체 의사소통"));
  data.groups.push({ id: "g80", fields: ["sem31"], pick: 1, credit: 4, members: ["s80", "s81"] });
  ctx.applyCurriculumData(layout, data, layout.planTemplate);
  const moved = ctx.curriculumDataMoveSubjectToGroup(layout, "문학과 영상", "sem31", null).layout;
  assert.equal(moved.planData.groups.find((item) => item.id === "g80")?.members.includes("s80") ?? false, false);
  assert.equal(byName(moved, "문학과 영상").credits.sem31, 4, "묶음 밖으로 나오면 묶음 학점을 자기 학점으로");
  // 3-2 묶음 과목을 3-1 묶음으로: 3-2 칸 묶음은 행 위치를 따르므로 그 자리에 다른 학기 묶음이 없어야 한다
  const into = ctx.curriculumDataMoveSubjectToGroup(layout, "수학과제 탐구", "sem32", null).layout;
  assert.equal(byName(into, "수학과제 탐구").credits.sem32, 4);
  assert.throws(() => ctx.curriculumDataMoveSubjectToGroup(layout, "문학과 영상", "sem31", "g999"), /찾지 못했습니다/);
  const groups = read("course-groups.js");
  assert.match(groups, /if \(course\.linked \|\| group\.linked\) moveLinkedCourse\(course, group\);/);
  assert.match(groups, /편제표의 선택과목군을 바꿉니다\(1단계 편제표에 반영\)/);
});

test("앱 연결: 모드 없이 끌기, 놓으면 떠 있는 단추, 터치 길게 누르기, 원본 재변환 스크립트 순서·카드 단추", () => {
  assert.match(app, /const band = event\.target\.closest\("\.curriculum-group-band, \.curriculum-cross-band"\);/);
  assert.match(app, /showCurriculumSelectionActions\(curriculumCellSelection\)/);
  assert.match(app, /gesture\.timer = window\.setTimeout\(/);
  assert.match(app, /curriculumReconvertCardHtml\(year,/);
  const html = read("index.html");
  assert.ok(html.indexOf('src="curriculum-versions.js') < html.indexOf('src="curriculum-reconvert.js'));
  assert.ok(html.indexOf('src="app.js') < html.indexOf('src="curriculum-reconvert.js'));
  for (const id of ["curriculumCrossSplitField", "curriculumCrossSplitOptions", "planAutoNameNotice", "planAutoNameOpen"]) assert.match(html, new RegExp(`id="${id}"`), id);
  const view = read("curriculum-data-view.js");
  // 키보드로 칸 고르기 모드는 없앴다(데이터 편제표에서는 단추를 숨기고, 묶기는 떠 있는 단추·Ctrl+M)
  assert.doesNotMatch(view + app, /키보드로 칸 고르기/);
  assert.match(view, /getElementById\("curriculumMergeToggle"\)\?\.classList\.toggle\("hidden", dataMode\)/);
  assert.match(view, /cross: "교차집중으로 묶기"/);
  assert.match(view, /data-group-handle="\$\{edge\}"/);
});

// 원본 재변환 뒤 1단계 표 위 '변경 표시'의 비교 기준(마지막 저장 시점)
function changeContext() {
  const ctx = context({
    state: { curriculumPlanType: "cohort", curriculumCohortYear: "2026", curriculumCohorts: {}, curriculumVersions: {}, curriculumMutationRevision: 0,
      curriculumUndoStack: [], curriculumPlan: [], curriculumTemplateRows: [], curriculumPlanFileName: "2026.xlsx" },
    document: undefined
  });
  vm.runInContext("function syncActiveCurriculumCohort() {} function persistState() { return true; }", ctx);
  for (const name of ["curriculumSubjectSignatures", "curriculumTableChanges"]) vm.runInContext(appFunction(name), ctx);
  vm.runInContext(`async ${appFunction("ensureCurriculumChangeBaseline")}`, ctx);
  return ctx;
}

test("변경 표시: 예전 변환기로 저장한 시점도 원본 재변환 때 같은 변환기로 맞춰 '0과목', 학점 하나 고치면 1과목", async () => {
  const ctx = changeContext();
  const old = legacy(ctx);
  ctx.state.curriculumImportedLayout = old;
  const saved = ctx.recordCurriculumVersion("2026", old, { reason: "2026 확정" });
  const legacySnapshot = plain(saved.snapshot);
  await ctx.ensureCurriculumChangeBaseline(old);
  assert.equal(ctx.curriculumTableChanges(old).size, 0, "재변환 전: 저장 시점과 같다");
  const fresh = upload(ctx);
  ctx.curriculumArchiveStore = async (operation, key) => key.startsWith("origin:") ? null : "buffer";
  ctx.curriculumReconvertFresh = async () => ({ data: plain(fresh.planData), template: plain(fresh.planTemplate) });
  ctx.curriculumReconvertAsk = async () => true;
  const result = await ctx.reconvertCurriculumLayout(ctx.curriculumReconvertTargets()[0]);
  assert.equal(result.status, "done");
  const versions = ctx.state.curriculumVersions["2026"];
  assert.equal(versions.length, 2);
  assert.equal(versions[1].reconvert, true, "재변환 기록은 교사의 저장 시점이 아니다");
  assert.equal(versions[0].normalized.converter, vm.runInContext("PLAN_DATA_CONVERTER", ctx), "예전 저장 시점도 새 변환기로 정규화");
  assert.equal(versions[0].snapshot.layout.planData.converter, vm.runInContext("PLAN_DATA_CONVERTER", ctx));
  assert.equal(ctx.curriculumComparisonVersion().id, saved.id, "비교 기준은 교사가 저장한 마지막 시점");
  const layout = ctx.state.curriculumImportedLayout;
  await ctx.ensureCurriculumChangeBaseline(layout);
  assert.equal(layout.changeBaseline.versionId, saved.id);
  assert.deepEqual([...ctx.curriculumTableChanges(layout).keys()], [], "재변환 직후 변경 0과목");
  // 정규화하지 않은 예전 저장본과 그대로 비교하면 교차집중 표기·묶음 학점 차이가 변경으로 잡힌다(고치기 전 현상)
  const raw = { ...layout, changeBaseline: ctx.curriculumSavedBaseline(legacySnapshot, saved.id, saved.savedAt) };
  assert.ok(ctx.curriculumTableChanges(raw).size > 0, "예전 변환기 저장본과 그대로 비교하면 변경으로 보인다");
  // 학점 하나를 고치면 1과목
  const edited = ctx.curriculumDataSetCell(layout, { id: byName(layout, "공통국어1").id, field: "sem11" }, "5").layout;
  edited.changeBaseline = layout.changeBaseline;
  ctx.state.curriculumImportedLayout = edited;
  assert.deepEqual([...ctx.curriculumTableChanges(edited).entries()].map(([key, change]) => `${change.kind}:${key}`), ["changed:공통국어1"]);
  // 다시 새 시점으로 저장하면 그 시점이 기준
  const next = ctx.saveCurriculumDraftVersion({ reason: "학점 수정" });
  await ctx.ensureCurriculumChangeBaseline(edited);
  assert.equal(edited.changeBaseline.versionId, next.id);
  assert.equal(ctx.curriculumTableChanges(edited).size, 0);
});

test("변경 표시: 정규화하지 못한 예전 시점 뒤의 재변환 기록은 그 기록을 기준으로, 자동 수정 전 이름은 같은 과목으로 본다", () => {
  const ctx = changeContext();
  const version = (id, reason, converter) => ({ id, reason, plan: [], snapshot: { layout: { rows: [[]], planData: { converter, subjects: [], groups: [] } } } });
  ctx.state.curriculumVersions["2026"] = [version("p", "2026 확정", 2), version("r", "원본 다시 읽기(변환기 갱신)", 3)];
  assert.equal(ctx.curriculumComparisonVersion().id, "r", "예전 기록(reconvert 표시 없음)도 이름으로 재변환 기록을 알아본다");
  ctx.state.curriculumVersions["2026"][0].snapshot.layout.planData.converter = 3;
  assert.equal(ctx.curriculumComparisonVersion().id, "p");
  ctx.state.curriculumVersions["2026"].push(version("u", "학점 수정", 3));
  assert.equal(ctx.curriculumComparisonVersion().id, "u", "교사가 저장한 시점이 맨 뒤면 그 시점");
  const key = ctx.curriculumDataCompareNameKey({ planData: { subjects: [{ id: "s1", name: "미적분Ⅱ, 기하", originalName: "미적분2, 기하" }] } });
  assert.equal(key("미적분2"), key("미적분Ⅱ"));
  assert.equal(key("기하"), "기하");
  assert.notEqual(key("미적분1"), key("미적분Ⅱ"));
  assert.equal(ctx.curriculumBaselineLabel({ versionId: "u" }, "2026").name, "학점 수정");
});

test("Ctrl+M 기본 동작: 한 학기 → 선택과목군, 같은 학년 두 학기·두 과목 → 교차집중(셋 이상은 선택과목군), 이미 묶음 칸 → 풀기", () => {
  const ctx = context();
  const layout = upload(ctx);
  const columns = layout.planTemplate.columns.semesters;
  const a = byName(layout, "공통국어1"), b = byName(layout, "지구시스템과학");
  const grouped = byName(layout, "주제 탐구 독서");
  const one = ctx.curriculumSelectionOptions(layout, { column: columns[2], startRow: b.row, endRow: b.row });
  assert.equal(one.primary, "group");
  const pair = ctx.curriculumSelectionOptions(layout, { column: columns[0], endColumn: columns[1], startRow: a.row, endRow: byName(layout, "음악, 미술").rowEnd });
  assert.deepEqual(plain(pair.actions), ["group", "cross"]);
  assert.equal(pair.primary, "group", "세 과목(공통국어1, 음악, 미술)은 둘 다 가능 → 선택과목군");
  const two = ctx.curriculumSelectionOptions(layout, { column: columns[2], endColumn: columns[3], startRow: grouped.row, endRow: byName(layout, "독서 토론과 글쓰기").rowEnd });
  assert.equal(two.names, 2);
  assert.equal(two.primary, "cross", "같은 학년 두 학기·두 과목이면 교차집중");
  const release = ctx.curriculumSelectionOptions(layout, { column: columns[5], startRow: grouped.row, endRow: byName(layout, "수학과제 탐구").rowEnd });
  assert.equal(release.primary, "release");
  assert.equal(ctx.curriculumSelectionOptions(layout, null), null);
  assert.equal(ctx.curriculumSelectionOptions({ ...layout, derived: true }, { column: columns[2], startRow: b.row, endRow: b.row }), null);
  const view = read("curriculum-data-view.js");
  assert.match(view, /curriculumShortcutKey\(event, "m"\)/);
  assert.match(view, /closest\?\.\("#curriculumPlanWrap, #curriculumSelectionActions"\)/, "편제표에 포커스가 있을 때만 막는다");
  assert.match(view, /먼저 학기 칸을 끌어 고르세요/);
  assert.match(view, /<kbd class="curriculum-shortcut">Ctrl\+M<\/kbd>/);
  assert.equal(ctx.curriculumShortcutKey({ ctrlKey: true, key: "M" }, "m"), true);
  assert.equal(ctx.curriculumShortcutKey({ metaKey: true, key: "ㅡ", code: "KeyM" }, "m"), true, "한글 자판·⌘");
  assert.equal(ctx.curriculumShortcutKey({ key: "m" }, "m"), false);
});

test("Ctrl+Z: 편제표 칸 밖이면 편제표 실행취소, 칸에 글자를 입력하는 중이면 브라우저 글자 되돌리기, 다른 단계·입력칸은 가로채지 않음", () => {
  const panel = { classList: { contains: () => false } };
  const ctx = vm.createContext({
    state: { workflowStep: 1, curriculumImportedLayout: {}, curriculumEditUndoRecorded: false },
    $: (selector) => selector === "#workflowStep1Panel" ? panel : null,
    document: { querySelector: () => null }
  });
  vm.runInContext(appFunction("curriculumUndoShortcutApplies"), ctx);
  const element = ({ editable = false, inWrap = false, contentEditable = false } = {}) => ({
    closest: (selector) => {
      if (selector === "#curriculumPlanWrap") return inWrap ? {} : null;
      return editable ? element({ inWrap, contentEditable }) : null;
    },
    matches: () => contentEditable
  });
  const key = (target, extra = {}) => ({ ctrlKey: true, key: "z", code: "KeyZ", target, ...extra });
  assert.equal(ctx.curriculumUndoShortcutApplies(key(element())), true, "포커스 없음·고른 상태");
  assert.equal(ctx.curriculumUndoShortcutApplies(key(element(), { metaKey: true, ctrlKey: false })), true, "맥 ⌘+Z");
  assert.equal(ctx.curriculumUndoShortcutApplies(key(element(), { shiftKey: true })), false, "Ctrl+Shift+Z는 다시 실행(없음)");
  const cell = element({ editable: true, inWrap: true, contentEditable: true });
  assert.equal(ctx.curriculumUndoShortcutApplies(key(cell)), true, "칸에 커서만 있고 입력 전");
  ctx.state.curriculumEditUndoRecorded = true;
  assert.equal(ctx.curriculumUndoShortcutApplies(key(cell)), false, "칸에 입력 중이면 글자 되돌리기");
  ctx.state.curriculumEditUndoRecorded = false;
  assert.equal(ctx.curriculumUndoShortcutApplies(key(element({ editable: true }))), false, "편제표 밖 입력칸(검색 등)");
  ctx.state.workflowStep = 2;
  assert.equal(ctx.curriculumUndoShortcutApplies(key(element())), false, "다른 단계");
  ctx.state.workflowStep = 1;
  ctx.document.querySelector = () => ({});
  assert.equal(ctx.curriculumUndoShortcutApplies(key(element())), false, "열린 대화 상자");
  assert.match(read("index.html"), /id="undoCurriculumEdit"[^>]*aria-keyshortcuts="Control\+Z"[^>]*>실행취소 <kbd class="curriculum-shortcut">Ctrl\+Z<\/kbd>/);
});

test("상단 접기 손잡이: 경계선 가운데 단추(▼ 펼치기/▲ 접기), 경계선 클릭, aria-expanded, 예전 이름(상단 펼치기) 유지", () => {
  const html = read("index.html");
  const divider = html.indexOf('id="curriculumTopDivider"');
  assert.ok(divider > html.indexOf('id="curriculumMetaRow"') && divider < html.indexOf('id="curriculumPlanDropZone"'), "위쪽 영역과 편제표 표 사이");
  assert.match(html, /<button class="collapse-handle" id="curriculumTopToggle" type="button" aria-expanded="false" aria-controls="curriculumCohortUploads curriculumMetaRow" aria-label="[^"]*상단 펼치기[^"]*">/);
  const sync = appFunction("syncCurriculumTopToggle");
  assert.match(sync, /"학교·학년도·편제표 카드 펼치기 \(상단 펼치기\)"/);
  assert.match(sync, /"접기 · 학교·학년도·편제표 카드 접기 \(상단 접기\)"/);
  assert.match(sync, /collapsed \? "▼" : "▲"/);
  assert.match(app, /\$\("#curriculumTopDivider"\)\?\.addEventListener\("click"/);
  const css = read("src/legacy.css");
  assert.match(css, /\.collapse-divider:hover \.collapse-handle/);
});

test("변경 표시: 전학년 편제표(자동 생성)는 예전 전학년 이력과 비교하지 않고, 문구는 기준 시점을 보여 준다", async () => {
  const ctx = changeContext();
  const derived = { derived: true, rows: [[]], changeBaseline: { version: 2, source: "saved", versionId: "old" } };
  ctx.state.curriculumPlanType = "annual";
  ctx.state.curriculumImportedLayout = derived;
  ctx.state.curriculumVersions["annual:2026"] = [{ id: "old", reason: "편제표 업로드", plan: [], snapshot: { layout: { rows: [[]] } } }];
  await ctx.ensureCurriculumChangeBaseline(derived);
  assert.equal(derived.changeBaseline, undefined);
  assert.equal(ctx.curriculumTableChanges(derived).size, 0);
  const summary = appFunction("renderCurriculumChangeSummary");
  assert.match(summary, /마지막 저장 시점\$\{detail \? `\(\$\{detail\}\)` : ""\}/);
  assert.match(summary, /과 같습니다/);
  assert.match(summary, /바뀐 과목 \$\{changed\}개/);
  assert.match(summary, /바뀐 과목명은 음영/);
  assert.match(summary, /삭제 \$\{removed\}개/);
  assert.match(summary, /data-change-history=/);
  assert.match(summary, /서식·공식 과목명 자동 수정·원본 다시 읽기\(변환기 갱신\)는 바뀐 것으로 세지 않습니다/);
});
