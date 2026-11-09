const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// 선택과목군 학점(학기 칸에 없으면 운영학점)과 교차집중(음악↔미술: 반마다 1·2학기를 엇갈려 이수) 인식·계산·점검·내보내기·시수.
// 실제 학교 파일 대신 같은 모양의 합성 편제표를 쓴다.
const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const appFunction = (name) => {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf("\n    function ", start + 1);
  assert.ok(start >= 0 && end > start, name);
  return app.slice(start, end);
};
const pure = (file, marker = "\n// ---- 앱 연결") => {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const index = source.indexOf(marker);
  return index >= 0 ? source.slice(0, index) : source;
};

function context() {
  const ctx = vm.createContext({
    CURRICULUM_DETAIL_OPTIONS: ["공통", "일반선택", "진로선택", "융합선택"],
    CURRICULUM_SEMESTER_FIELDS: ["sem11", "sem12", "sem21", "sem22", "sem31", "sem32"],
    escapeHtml: (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  });
  for (const name of ["columnIndex", "columnName", "curriculumCellFill", "normalizeCurriculumDetail",
    "curriculumSelectionType", "normalizeCurriculumDivision", "normalizeCurriculumAreaName", "isSelectableDetail",
    "normalizeCurriculumPlanRow", "planSubjectKey", "sheetMergeReferenceSet", "importedPlanCoveredCells", "importedPlanCourseContexts",
    "curriculumSubjectNames", "importedPlanColumnMap", "expandCurriculumLayoutRows", "insertImportedPlanLayoutRow",
    "createCurriculumPlanRecords", "curriculumPlanFromLayout", "planRowsFromImportedLayout", "curriculumChangeAttributes"]) {
    vm.runInContext(appFunction(name), ctx);
  }
  const workbook = fs.readFileSync(path.join(root, "curriculum-workbook.js"), "utf8");
  vm.runInContext(workbook.slice(0, workbook.indexOf('document.getElementById("exportCurriculumPlan")')), ctx);
  const versions = fs.readFileSync(path.join(root, "curriculum-versions.js"), "utf8");
  vm.runInContext(versions.slice(0, versions.indexOf("function initCurriculumVersions(")), ctx);
  for (const file of ["curriculum-subject-list.js", "curriculum-choice-blocks.js", "curriculum-data.js", "curriculum-data-view.js", "curriculum-annual.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), ctx);
  }
  vm.runInContext(pure("course-checks.js"), ctx);
  vm.runInContext(pure("curriculum-compliance.js"), ctx);
  vm.runInContext(pure("curriculum-office-format.js", "\n// ---- 앱 연결 ----"), ctx);
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

// 원본 양식: 학교 지정 예술 교차집중(윗줄 '교차집중(↔)', 아랫줄 2·2), 3-2 '택2' 아래 학점 칸이 비어 있는 묶음(운영학점 4·4·5).
function fixture({ creditCells = ["", "", ""], formulas = {} } = {}) {
  return {
    sheetName: "편제표", sourceRowOffset: 0, sourceColumnOffset: 0, rowInsertions: [], originalRowCount: 13,
    rows: [
      ...header(),
      row({ 0: "학교 지정 교육과정", 1: "국어", 2: "공통", 3: "공통국어1", 4: "4", 5: "4", 6: "4", 12: "4" }),
      row({ 1: "예술", 2: "일반", 3: "음악, 미술", 4: "3", 5: "2", 6: "교차집중(↔)", 12: "4" }),
      row({ 6: "2", 7: "2" }),
      row({ 0: "학생 선택 교육과정", 1: "국어", 2: "진로", 3: "주제 탐구 독서", 4: "4", 5: "4", 11: "택2", 12: "8" }),
      row({ 1: "국어", 2: "융합", 3: "독서 토론과 글쓰기", 4: "4", 5: "4", 11: creditCells[0] }),
      row({ 1: "수학", 2: "융합", 3: "수학과제 탐구", 4: "4", 5: creditCells[2] === "mixed" ? "5" : "4", 11: creditCells[1] }),
      row({ 0: "이수학점 소계", 6: "6", 7: "2", 8: "0", 9: "0", 10: "0", 11: "8", 12: "16" }),
      row({ 0: "창의적 체험활동", 6: "3", 7: "3", 8: "3", 9: "3", 10: "3", 11: "3", 12: "18" }),
      row({}),
    ],
    mergedRanges: [...headerMerges, "A5:A7", "G6:H6", "D6:D7", "E6:E7", "F6:F7", "M6:M7", "A8:A10", "M8:M10", "A11:F11", "A12:F12"],
    formulas: { "4:12": "SUM(G5:L5)", "5:12": "SUM(G6:L7)", "7:12": "SUM(G8:L10)",
      "10:6": "SUM(G5:G10)", "10:7": "SUM(H5:H10)", "10:8": "SUM(I5:I10)", "10:9": "SUM(J5:J10)", "10:10": "SUM(K5:K10)", "10:11": "SUM(L5:L10)", ...formulas },
    cellFills: {}, rowHeights: {}, hiddenRows: [], columnWidths: [10, 10, 6, 24, 6, 6, 6, 6, 6, 6, 6, 6, 8, 8],
  };
}

function converted(ctx, options) {
  const layout = plain(fixture(options));
  assert.equal(ctx.ensureCurriculumPlanData(layout), true, layout.planDataError);
  return layout;
}
const byName = (layout, name) => layout.planData.subjects.find((item) => item.name === name);

test("택n 아래 학점 칸이 비어 있으면 구성 과목 운영학점을 묶음 학점으로 쓰고 띠·이수학점·소계가 같은 값을 쓴다", () => {
  const ctx = context();
  const layout = converted(ctx);
  const group = layout.planData.groups.find((item) => item.fields.join() === "sem32");
  // 저장 데이터는 읽은 그대로(0) 두고, 계산할 때만 구성 과목 운영학점을 쓴다.
  assert.deepEqual(plain({ pick: group.pick, credit: group.credit, from: group.creditFrom }), { pick: 2, credit: 0 });
  assert.deepEqual(plain(ctx.planDataGroupCreditInfo(layout.planData, group)), { credit: 4, from: "op", note: "" });
  assert.match(ctx.curriculumDataRepairNotes(layout).join(" "), /3-2 택2: 학기 칸에 학점이 없어 계산에는 구성 과목 운영학점 4학점을 씁니다/);
  // 다시 만든 표: 학점 칸 2개(4, 첫 칸 수식), 이수학점 = 학기 합 수식, 소계 3-2 = 8
  const first = byName(layout, "주제 탐구 독서");
  assert.equal(layout.rows[first.row + 1][11], "4");
  assert.equal(layout.formulas[`${first.row + 2}:11`], `L${first.row + 2}`);
  assert.equal(layout.formulas[`${first.row}:12`], `SUM(G${first.row + 1}:L${byName(layout, "수학과제 탐구").rowEnd + 1})`);
  const footer = layout.planRowMeta.findIndex((item) => item.type === "footer");
  assert.equal(layout.rows[footer][11], "8");
  const html = ctx.curriculumDataSheetHtml(layout);
  assert.match(html, /택2 · 4학점/);
  assert.match(html, /구성 과목 운영학점 4을\(를\) 씁니다/);
  // 묶음 블록(수강신청 과목·시수 통계 입력)도 4학점
  assert.equal(ctx.curriculumDataChoiceBlocks(layout).find((block) => block.field === "sem32").credit, 4);
  assert.equal(ctx.curriculumDataPlanEntries(layout).entries.find((entry) => entry.subject === "수학과제 탐구").credit, 4);
});

test("구성 과목 운영학점이 서로 다르면 가장 큰 값을 쓰고 확인 표시를 남긴다", () => {
  const ctx = context();
  const layout = converted(ctx, { creditCells: ["", "", "mixed"] });
  const group = layout.planData.groups.find((item) => item.fields.join() === "sem32");
  assert.equal(group.credit, 0);
  const info = ctx.planDataGroupCreditInfo(layout.planData, group);
  assert.equal(info.credit, 5);
  assert.match(info.note, /운영학점\(4·5\)이 서로 달라 가장 큰 5학점/);
  assert.match(ctx.curriculumDataSheetHtml(layout), /is-credit-check/);
  // 교사가 띠에서 학점을 정하면 확인 표시는 사라진다
  const { layout: next } = ctx.curriculumDataUpdateGroup(layout, group.id, { pick: "2", credit: "4" });
  const updated = next.planData.groups.find((item) => item.id === group.id);
  assert.equal(updated.credit, 4);
  assert.equal("creditFrom" in updated || "creditNote" in updated, false);
  assert.doesNotMatch(ctx.curriculumDataSheetHtml(next), /is-credit-check/);
});

test("학점 칸이 '4학점' 글자이거나 저장값 없이 다른 칸을 가리키는 수식(=F9)만 있어도 학점을 읽는다", () => {
  const ctx = context();
  const text = converted(ctx, { creditCells: ["4학점", ""] });
  assert.equal(text.planData.groups[0].credit, 4);
  assert.equal(text.planData.groups[0].creditFrom, undefined);
  const formula = converted(ctx, { creditCells: ["", ""], formulas: { "8:11": "F9", "9:11": "L9" } });
  assert.equal(formula.planData.groups[0].credit, 4);
  assert.equal(formula.planData.groups[0].creditFrom, undefined);
});

test("원본의 '교차집중(↔)' 표기는 교차집중 과목 한 행이 되고 띠 하나(두 학기)로 보인다", () => {
  const ctx = context();
  const layout = converted(ctx);
  const art = byName(layout, "음악, 미술");
  assert.deepEqual(plain([art.cross, art.credits]), [["sem11", "sem12"], { sem11: 2, sem12: 2 }]);
  assert.equal(layout.planData.groups.length, 1, "교차집중은 선택과목군이 아니다");
  assert.equal(ctx.curriculumPlanSection(art, layout.planData), "cross");
  const html = ctx.curriculumDataSheetHtml(layout);
  assert.match(html, /colspan="2"[^>]*><button type="button" class="curriculum-cross-band" data-plan-cross="[^"]+"[^>]*>교차집중 · 음악↔미술 · 학기당 2학점<\/button>/);
  assert.doesNotMatch(html, /택1 · 2학점/);
  // 학기 합계·이수학점은 학기당 한 번(2 + 2)
  const footer = layout.planRowMeta.findIndex((item) => item.type === "footer");
  assert.deepEqual(plain(layout.rows[footer].slice(6, 8)), ["6", "2"]);
  assert.equal(layout.rows[art.row][12], "4");
  // 원래 양식 내보내기 표: 윗줄 '교차집중(↔)'(병합), 아랫줄 학기 학점 2·2
  assert.equal(layout.rows[art.row][6], "교차집중(↔)");
  assert.ok(layout.mergedRanges.includes(`G${art.row + 1}:H${art.row + 1}`));
  assert.deepEqual(plain(layout.rows[art.row + 1].slice(6, 8)), ["2", "2"]);
});

test("예전 앱의 '교차집중과목군' 병합은 1·2학기 택1 묶음이 아니라 교차집중 과목으로 바꾼다", () => {
  const ctx = context();
  const legacy = plain(fixture());
  legacy.rows[5][6] = "교차집중과목군 택1 · 2학점";
  legacy.rows[6][6] = "";
  legacy.rows[6][7] = "";
  legacy.mergedRanges = legacy.mergedRanges.filter((reference) => reference !== "G6:H6");
  legacy.sheetMerges = [{ reference: "G6:H7", kind: "cross", pick: 1, credit: 2 }];
  assert.equal(ctx.ensureCurriculumPlanData(legacy), true, legacy.planDataError);
  const art = byName(legacy, "음악, 미술");
  assert.deepEqual(plain([art.cross, art.credits]), [["sem11", "sem12"], { sem11: 2, sem12: 2 }]);
  assert.equal(legacy.planData.groups.some((group) => group.members.includes(art.id)), false);
});

test("업로드 변환 단계: 학교 지정 1·2학기 택1 → 교차집중, 학생 선택 1년 택1은 그대로, 학점 0 묶음은 저장값을 바꾸지 않는다", () => {
  const ctx = context();
  const layout = converted(ctx);
  const data = plain(layout.planData);
  const art = data.subjects.find((item) => item.name === "음악, 미술");
  data.groups.find((group) => group.fields.join() === "sem32").credit = 0;
  art.cross = null; art.credits = {};
  data.groups.push({ id: "g90", fields: ["sem11", "sem12"], pick: 1, credit: 2, members: [art.id] });
  data.subjects.push({ id: "s90", name: "일본어Ⅰ, 중국어Ⅰ", category: "학생 선택 교육과정", area: "제2외국어", kind: "일반선택",
    base: "5", op: "4", credits: {}, texts: {}, cross: null, note: "", extra: {}, span: 1, fills: [{}], heights: [null], styleRows: [null] });
  data.groups.push({ id: "g91", fields: ["sem21", "sem22"], pick: 1, credit: 0, members: ["s90"] });
  const changes = ctx.curriculumDataRepair(data);
  assert.ok(changes.some((text) => /교차집중으로 인식: 음악↔미술\(1-1·2\)/.test(text)), changes.join(" / "));
  const repaired = data.subjects.find((item) => item.name === "음악, 미술");
  assert.deepEqual(plain([repaired.cross, repaired.credits]), [["sem11", "sem12"], { sem11: 2, sem12: 2 }]);
  assert.equal(data.groups.find((group) => group.fields.join() === "sem32").credit, 0, "저장값은 그대로");
  const year = data.groups.find((group) => group.members.includes("s90"));
  assert.deepEqual(plain([year.fields, year.pick, year.credit]), [["sem21", "sem22"], 1, 0]);
  assert.equal(ctx.planDataGroupCredit(data, year), 2, "계산할 때는 운영학점 4 ÷ 2학기");
  // 1학기·2학기 택1 묶음이 따로 있는 모양도 교차집중으로 인식한다
  const split = plain(converted(ctx).planData);
  const splitArt = split.subjects.find((item) => item.name === "음악, 미술");
  splitArt.cross = null; splitArt.credits = {};
  split.groups.push({ id: "g92", fields: ["sem11"], pick: 1, credit: 2, members: [splitArt.id] },
    { id: "g93", fields: ["sem12"], pick: 1, credit: 2, members: [splitArt.id] });
  ctx.curriculumDataRepair(split);
  assert.deepEqual(plain(split.subjects.find((item) => item.name === "음악, 미술").cross), ["sem11", "sem12"]);
});

test("띠 메뉴: 선택과목군 ↔ 교차집중으로 바꾸고 교차집중 학기당 학점을 고친다", () => {
  const ctx = context();
  const layout = converted(ctx);
  const art = byName(layout, "음악, 미술");
  const { layout: grouped, result: group } = ctx.curriculumDataCrossToGroup(layout, art.id);
  assert.deepEqual(plain([group.fields, group.pick, group.credit]), [["sem11", "sem12"], 1, 2]);
  assert.equal(byName(grouped, "음악, 미술").cross, null);
  assert.ok(ctx.planDataCrossCandidates(grouped.planData, grouped.planData.groups.find((item) => item.id === group.id)));
  const { layout: back, result: subject } = ctx.curriculumDataGroupToCross(grouped, group.id);
  assert.deepEqual(plain([subject.cross, subject.credits]), [["sem11", "sem12"], { sem11: 2, sem12: 2 }]);
  const { layout: three } = ctx.curriculumDataSetCrossCredit(back, subject.id, "3");
  assert.deepEqual(plain(byName(three, "음악, 미술").credits), { sem11: 3, sem12: 3 });
  assert.equal(ctx.planDataCrossLabel(byName(three, "음악, 미술")), "교차집중 · 음악↔미술 · 학기당 3학점");
  // 한 학기 묶음(3-2 택2)은 교차집중으로 바꿀 수 없다
  const single = layout.planData.groups.find((item) => item.fields.join() === "sem32");
  assert.throws(() => ctx.curriculumDataGroupToCross(layout, single.id), /같은 학년 1·2학기/);
  // 여러 행 묶음을 교차집중으로 바꾸면 첫 행에 과목명을 모은다
  const rows = converted(ctx);
  const music = byName(rows, "음악, 미술");
  music.name = "음악"; music.cross = null; music.credits = {};
  const index = rows.planData.subjects.indexOf(music);
  rows.planData.subjects.splice(index + 1, 0, { ...plain(music), id: "s95", name: "미술" });
  rows.planData.groups.push({ id: "g95", fields: ["sem11", "sem12"], pick: 1, credit: 2, members: [music.id, "s95"] });
  ctx.applyCurriculumData(rows);
  const merged = ctx.curriculumDataGroupToCross(rows, "g95").layout;
  assert.equal(merged.planData.subjects.some((item) => item.id === "s95"), false);
  assert.deepEqual(plain(byName(merged, "음악, 미술").cross), ["sem11", "sem12"]);
});

// 점검용 2022 개정 편제표(교차집중 예술 + 3-2 택2)
function compliancePlan(ctx, { asGroups = false, zeroCredit = false } = {}) {
  const layout = converted(ctx);
  const data = plain(layout.planData);
  const appreciation = { id: "s80", name: "음악 감상과 비평, 미술 감상과 비평", category: "학교 지정 교육과정", area: "예술", kind: "진로선택", kindText: "진로",
    base: "3", op: "3", credits: { sem21: 3, sem22: 3 }, texts: {}, cross: ["sem21", "sem22"], note: "", extra: {}, span: 1, fills: [{}], heights: [null], styleRows: [null] };
  data.subjects.splice(3, 0, appreciation);
  if (asGroups) {
    appreciation.cross = null; appreciation.credits = {};
    data.groups.push({ id: "g80", fields: ["sem21", "sem22"], pick: 1, credit: 3, members: ["s80"] });
  }
  if (zeroCredit) data.groups.find((group) => group.fields.join() === "sem32").credit = 0;
  return { planData: data, planTemplate: layout.planTemplate };
}

test("편제 점검: 교차집중 과목 학점은 운영학점 1회(감상과 비평 3)라 범위 경고가 없고, 학기별 택1로 처리하면 6학점 경고와 이유가 나온다", () => {
  const ctx = context();
  const ok = ctx.planComplianceReport(compliancePlan(ctx), { cohortYear: "2026" });
  const a3 = ok.items.find((item) => item.no === 3);
  assert.doesNotMatch(a3.note, /감상과 비평/);
  const art = ok.model.rows.find((row) => row.rawName.startsWith("음악 감상과"));
  assert.equal(art.unitCredit, 3);
  assert.equal(art.domain, "교차집중");
  const wrong = ctx.planComplianceReport(compliancePlan(ctx, { asGroups: true }), { cohortYear: "2026" });
  const issue = wrong.subjectIssues.get("s80").find((item) => item.kind === "range");
  assert.equal(issue.credit, 6);
  assert.match(issue.reason, /음악 감상과 비평: 2-1·2-2 택1 묶음 과목당 3학점 × 2학기 → 6학점, 2022 개정 기준 3학점의 증감 범위 2~4학점 밖/);
  // 예술 교과(군) 학점: 교차집중은 학기당 한 번(3 + 3 = 6, 음악·미술 1학년 2 + 2 = 4)
  assert.equal(ok.stats.families.find((row) => row.family === "예술").min, 10);
});

test("편제 점검: 학점 0으로 저장된 묶음도 운영학점으로 계산해 0학점 경고를 내지 않는다", () => {
  const ctx = context();
  const report = ctx.planComplianceReport(compliancePlan(ctx, { zeroCredit: true }), { cohortYear: "2026" });
  assert.equal(report.model.groups.find((group) => group.fields.join() === "sem32").credit, 4);
  assert.equal([...report.subjectIssues.values()].flat().some((issue) => issue.kind === "range" && issue.credit === 0), false);
});

test("교육청 양식: 교차집중은 과목마다 한 줄·첫 줄만 소계, 학점 0 묶음은 운영학점으로 내보낸다", () => {
  const ctx = context();
  const layout = converted(ctx);
  const data = plain(layout.planData);
  data.groups.find((group) => group.fields.join() === "sem32").credit = 0;
  const parts = ctx.curriculumOfficeEntries(data);
  assert.deepEqual(plain(parts.cross.map((row) => [row.name, row.values.slice(0, 2)])), [["음악", [2, 2]], ["미술", [2, 2]]]);
  const rows = ctx.curriculumOfficeOrderRows([parts]);
  const sheet = ctx.buildCurriculumOfficeSheet({ name: "1학년_편제표", title: "t", school: "s", rows });
  const subtotal = sheet.cells[sheet.footer];
  assert.equal(subtotal[6].v, 6, "1-1: 공통국어1 4 + 음악(첫 줄) 2");
  assert.equal(subtotal[11].v, 8, "3-2: 택2 × 운영학점 4");
  assert.match(subtotal[11].f, /2\*L\d+/);
  assert.deepEqual(plain(rows.filter((row) => row.groupKey && row.pick === "택2").map((row) => row.values[5])), [4, 4, 4]);
});

test("전학년 편제표: 교차집중 과목은 한 행(교차집중 표시)으로 묶어 학기 학점을 한 번만 센다", () => {
  const ctx = context();
  const layout = converted(ctx);
  const credits = ctx.curriculumDataSubjectCredits(layout);
  assert.deepEqual(plain(credits.get("음악").crossNames), ["음악", "미술"]);
  const plan = (grade) => [
    { division: "학교 지정 교육과정", area: "예술", detail: "일반선택", subject: "음악", baseCredit: 3, opCredit: 2,
      [`sem${grade}1`]: "2", [`sem${grade}2`]: "2", crossNames: ["음악", "미술"], crossFields: [`sem${grade}1`, `sem${grade}2`] },
    { division: "학교 지정 교육과정", area: "예술", detail: "일반선택", subject: "미술", baseCredit: 3, opCredit: 2,
      [`sem${grade}1`]: "2", [`sem${grade}2`]: "2", crossNames: ["음악", "미술"], crossFields: [`sem${grade}1`, `sem${grade}2`] },
    { division: "학교 지정 교육과정", area: "국어", detail: "공통", subject: `국어${grade}`, baseCredit: 4, opCredit: 4, [`sem${grade}1`]: "4" }
  ];
  const cohorts = { "2027": { plan: plan(1) }, "2026": { plan: plan(2).slice(2) }, "2025": { plan: plan(3).slice(2) } };
  const annual = ctx.buildAnnualCurriculumLayout(cohorts, "2027");
  assert.equal(ctx.ensureCurriculumPlanData(annual), true, annual.planDataError);
  const art = annual.planData.subjects.find((item) => item.name === "음악, 미술");
  assert.deepEqual(plain([art.cross, art.credits]), [["sem11", "sem12"], { sem11: 2, sem12: 2 }]);
  const footer = annual.planRowMeta.findIndex((item) => item.type === "footer");
  assert.deepEqual(plain(annual.rows[footer].slice(6, 8)), ["6", "2"]);
});

test("시수 통계: 1·2학기 교차집중은 학기마다 학급을 엇갈려 나눈다(11학급: 1학기 5·6, 2학기 6·5), 분할 편성은 그대로", () => {
  const source = fs.readFileSync(path.join(root, "hours-stats.js"), "utf8");
  const start = source.indexOf("function hoursDesignatedShare(");
  const ctx = vm.createContext({});
  vm.runInContext(source.slice(start, source.indexOf("function computeHoursStats(", start)), ctx);
  const share = (total, semester, nameIndex, extra = {}) => ctx.hoursDesignatedShare(total, { names: 2, nameIndex, semester, crossed: true, crossSemesters: 2, ...extra });
  assert.deepEqual([share(11, "1", 0), share(11, "1", 1), share(11, "2", 0), share(11, "2", 1)], [5, 6, 6, 5]);
  assert.deepEqual([share(10, "1", 0), share(10, "1", 1), share(10, "2", 0), share(10, "2", 1)], [5, 5, 5, 5]);
  assert.deepEqual([share(11, "1", 0, { crossSemesters: 0 }), share(11, "1", 1, { crossSemesters: 0 })], [6, 5], "한 학기 표시(↔)는 앞 과목부터");
  assert.equal(ctx.hoursDesignatedShare(11, { names: 1, nameIndex: 0, semester: "1" }), 11);
  // 데이터 편제표의 학기 항목은 교차집중 학기 수를 함께 준다
  const data = context();
  const layout = converted(data);
  const entries = data.curriculumDataPlanEntries(layout).entries.filter((entry) => entry.crossed);
  assert.deepEqual(plain(entries.map((entry) => [entry.subject, entry.semester, entry.nameIndex, entry.crossSemesters, entry.kind])),
    [["음악", "1", 0, 2, "지정"], ["미술", "1", 1, 2, "지정"], ["음악", "2", 0, 2, "지정"], ["미술", "2", 1, 2, "지정"]]);
});

test("앱 연결: 열 때 원본 재변환 호출, 수강신청 과목에서 교차집중 제외, 띠 팝업·범례 화면 요소", () => {
  assert.doesNotMatch(app, /repairCurriculumLayoutData/, "저장 자료를 열 때 추정으로 고치지 않는다");
  assert.match(app, /reconvertCurriculumOriginals\(\{ startup: true \}\)/);
  assert.match(app, /crossRows\.has\(context\.rowIndex\)/);
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  for (const id of ["curriculumCrossDialog", "curriculumCrossCredit", "curriculumCrossToGroup", "curriculumGroupCross", "planWarnLegend"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /주황 테두리 = 학점 범위 확인\(칸에 마우스를 올리면 이유\)/);
  const compliance = fs.readFileSync(path.join(root, "curriculum-compliance.js"), "utf8");
  assert.match(compliance, /학점 범위 확인\(편제 점검 3번\)/);
});
