const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// 1단계 편제표 = 원본 양식 그대로: 원본 서식(글꼴·글자색·테두리·정렬·서식 있는 글자)을 읽어 데이터와 함께 두고,
// 화면·내보내기·전학년 편제표가 같은 양식으로 그린다. 표기 기호(*·★)·빨간 글씨는 자동 수정 뒤에도 남는다.
const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const parser = fs.readFileSync(path.join(root, "xlsx-parser.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const appFunction = (name) => {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf("\n    function ", start + 1);
  assert.ok(start >= 0 && end > start, name);
  return app.slice(start, end);
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
    "createCurriculumPlanRecords", "curriculumPlanFromLayout", "planRowsFromImportedLayout", "curriculumChangeAttributes",
    "cropCurriculumSheet", "cropCurriculumSheetFormats"]) {
    vm.runInContext(appFunction(name), ctx);
  }
  const workbook = fs.readFileSync(path.join(root, "curriculum-workbook.js"), "utf8");
  vm.runInContext(workbook.slice(0, workbook.indexOf('document.getElementById("exportCurriculumPlan")')), ctx);
  for (const file of ["curriculum-subject-list.js", "curriculum-choice-blocks.js", "curriculum-data.js", "curriculum-data-view.js", "curriculum-annual.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), ctx);
  }
  return ctx;
}

// 서식 번호: 0 기본(테두리·가운데), 1 과목명(왼쪽·굵게), 2 빨간 글씨 과목명, 3 '택n' 칸, 4 제목(크게)
const styleTable = [
  { bd: { l: "thin", r: "thin", t: "thin", b: "thin" }, h: "center", v: "center", b: 1, sz: 14 },
  { bd: { l: "thin", r: "thin", t: "thin", b: "thin" }, h: "left", v: "center", b: 1, sz: 14 },
  { bd: { l: "thin", r: "thin", t: "thin", b: "thin" }, h: "left", v: "center", b: 1, sz: 14, fc: "#FF0000" },
  { bd: { l: "medium", r: "medium", t: "medium", b: "thin" }, h: "center", v: "center", b: 1, sz: 16 },
  { h: "center", v: "center", b: 1, sz: 20 }
];

function fixture(year = 2026, overrides = {}) {
  const blank = () => Array(14).fill("");
  const row = (values) => Object.assign(blank(), values);
  const rows = [
    row({ 0: `${year}학년도 신입생 3개년 교육과정 편제표` }),
    row({ 6: "○○고등학교" }),
    row({ 0: "구분", 1: "교과(군)", 2: "세부과목", 4: "기준학점", 5: "운영학점", 6: "1학년", 8: "2학년", 10: "3학년", 12: "이수학점", 13: "필수이수학점" }),
    row({ 6: "1학기", 7: "2학기", 8: "1학기", 9: "2학기", 10: "1학기", 11: "2학기" }),
    row({ 0: "학교 지정 교육과정", 1: "국어", 2: "공통", 3: "공통국어1", 4: "4", 5: "4", 6: "4", 12: "8", 13: "8" }),
    row({ 3: "화법과 언어", 4: "4", 5: "4", 9: "4" }),
    row({ 1: "음악", 2: "일반", 3: "음악, 미술", 4: "3", 5: "2", 6: "교차집중(↔)", 12: "4" }),
    row({ 6: "2", 7: "2" }),
    row({ 0: "학생 선택 교육과정", 1: "과학", 2: "진로", 3: "역학과 에너지, 지구시스템 과학", 4: "4", 5: "4", 10: "택1", 12: "8" }),
    row({ 1: "정보", 2: "진로", 3: "프로그래밍★", 4: "4", 5: "4", 10: "4" }),
    row({ 1: "과학", 2: "진로", 3: "고급물리학* ", 4: "4", 5: "3", 8: "공동/2학년/1학기/3학점(순증)", 12: "3" }),
    row({ 0: "이수학점 소계", 6: "6", 7: "2", 8: "0", 9: "4", 10: "4", 11: "0", 12: "16" }),
    row({ 0: "창의적 체험활동", 6: "3", 7: "3", 8: "3", 9: "3", 10: "3", 11: "3", 12: "18" }),
    row({ 0: "☞ 표기방법 안내 ◦ 특목고 과목 * 표기 ◦ 전문교과 ★ 표기" })
  ];
  const cellStyles = {};
  rows.forEach((values, r) => values.forEach((_, c) => { cellStyles[`${r}:${c}`] = 0; }));
  for (let r = 4; r <= 10; r++) cellStyles[`${r}:3`] = 1;
  cellStyles["5:3"] = 2; // 화법과 언어: 칸 전체 빨간 글씨
  cellStyles["10:3"] = 2; // 고급물리학*: 빨간 글씨
  cellStyles["8:10"] = 3;
  cellStyles["0:0"] = 4;
  return {
    sheetName: "편제표", sourceRowOffset: 0, sourceColumnOffset: 0, rowInsertions: [], originalRowCount: rows.length,
    rows,
    mergedRanges: ["A1:N1", "G2:N2", "A3:A4", "B3:B4", "C3:D4", "E3:E4", "F3:F4", "G3:H3", "I3:J3", "K3:L3", "M3:M4", "N3:N4",
      "A5:A8", "B5:B6", "M5:M6", "N5:N6", "D7:D8", "E7:E8", "F7:F8", "B7:B8", "C7:C8", "M7:M8", "G7:H7", "A9:A11", "M9:M10", "I11:L11",
      "A12:F12", "A13:F13", "A14:N14"],
    formulas: { "4:12": "SUM(G5:L6)", "6:12": "SUM(G7:L8)", "8:12": "SUM(G9:L10)",
      "11:6": "SUM(G5:G11)", "11:7": "SUM(H5:H11)", "11:8": "SUM(I5:I11)", "11:9": "SUM(J5:J11)", "11:10": "SUM(K5:K11)",
      "11:11": "SUM(L5:L11)", "11:12": "SUM(G12:L12)" },
    cellFills: { "8:10": "#E2EFD9", "6:6": "#E2EFD9" }, rowHeights: { 0: 30 }, hiddenRows: [],
    columnWidths: [10, 10, 6, 40, 6, 6, 6, 6, 6, 6, 6, 6, 8, 8],
    cellStyles, styleTable, baseFont: { sz: 11, fn: "맑은 고딕" }, sheetZoom: 70, defaultColumnWidth: 8.43, defaultRowHeight: 26.25,
    // 한 칸 안에서 '지구시스템 과학'만 빨간 글씨(서식 있는 글자)
    cellRich: { "8:3": [{ t: "역학과 에너지, ", inherit: 1 }, { t: "지구시스템 과학", fc: "#FF0000", b: 1, sz: 14 }] },
    ...overrides
  };
}

function converted(ctx = context(), raw = fixture(), year = 2026) {
  const layout = plain(raw);
  assert.equal(ctx.ensureCurriculumPlanData(layout), true, layout.planDataError);
  ctx.curriculumApplyAutoNames(layout, year);
  return plain(layout);
}

const subject = (layout, name) => layout.planData.subjects.find((item) => !item.fixed && item.name.includes(name));
const rowHtml = (html, name) => html.split("<tr").find((part) => part.includes(`data-curriculum-subject="${name}"`));

test("xlsx 서식 읽기: 글꼴 색(테마·RGB)·굵기·크기·정렬·테두리, 같은 모양 서식은 한 번호, 서식 있는 글자는 조각마다", async () => {
  function node(localName, attributes = {}, children = []) {
    return { localName, children, textContent: children.length ? "" : attributes.text || "",
      getAttribute: (name) => attributes[name] ?? null, hasAttribute: (name) => name in attributes,
      getElementsByTagNameNS(ns, name) { return children.flatMap((child) => [...(child.localName === name ? [child] : []), ...child.getElementsByTagNameNS(ns, name)]); } };
  }
  const font = (props) => node("font", {}, props);
  const styles = node("styleSheet", {}, [
    node("fonts", {}, [
      font([node("sz", { val: "11" }), node("color", { theme: "1" }), node("name", { val: "맑은 고딕" })]),
      font([node("b"), node("sz", { val: "14" }), node("color", { rgb: "FFFF0000" }), node("name", { val: "맑은 고딕" })])
    ]),
    node("borders", {}, [node("border", {}, []), node("border", {}, [node("left", { style: "thin" }, [node("color", { indexed: "64" })]), node("bottom", { style: "medium" })])]),
    node("cellXfs", {}, [
      node("xf", { fontId: "0", borderId: "0" }),
      node("xf", { fontId: "1", borderId: "1" }, [node("alignment", { horizontal: "left", vertical: "center", wrapText: "1" })]),
      node("xf", { fontId: "1", borderId: "1" }, [node("alignment", { horizontal: "left", vertical: "center", wrapText: "1" })])
    ])
  ]);
  const theme = node("theme", {}, [node("clrScheme", {}, [node("dk1", {}, [node("sysClr", { lastClr: "000000" })]), node("lt1", {}, [node("srgbClr", { val: "FFFFFF" })])])]);
  const start = parser.indexOf("    async function readWorkbookCellFormats(");
  const end = parser.indexOf("\n    }\n", parser.indexOf("    function workbookRichRuns(")) + 6;
  const ctx = vm.createContext({ NS_MAIN: "m", parseXml: (value) => value });
  vm.runInContext(parser.slice(start, end), ctx);
  const formats = await ctx.readWorkbookCellFormats(async (name) => name.includes("styles") ? styles : theme);
  assert.equal(formats.index(0), 0);
  assert.equal(formats.index(1), 1);
  assert.equal(formats.index(2), 1, "모양이 같은 서식은 같은 번호");
  assert.deepEqual(plain(formats.table), [
    { sz: 11, fn: "맑은 고딕", v: "bottom" },
    { fc: "#FF0000", b: 1, sz: 14, fn: "맑은 고딕", bd: { l: "thin", b: "medium" }, h: "left", v: "center", w: 1 }
  ]);
  const run = (text, props) => node("r", {}, [...(props ? [node("rPr", {}, props)] : []), node("t", { text })]);
  const si = node("si", {}, [run("물리학, ", null), run("지구시스템 과학", [node("b"), node("color", { rgb: "FFFF0000" }), node("sz", { val: "14" })])]);
  assert.deepEqual(plain(ctx.workbookRichRuns(si, formats)), [{ t: "물리학, ", inherit: 1 }, { t: "지구시스템 과학", fc: "#FF0000", b: 1, sz: 14 }]);
  assert.equal(ctx.workbookRichRuns(node("si", {}, [node("t", { text: "일반 글자" })]), formats), null);
});

test("시트 자르기는 서식 번호·서식 있는 글자를 함께 옮기고, 칸이 없으면 행·열 서식을 쓴다", () => {
  const ctx = context();
  const cropped = ctx.cropCurriculumSheet({ name: "표", rows: [[], ["", "과목", "학기"], ["", "A", "3"]],
    layout: { mergedRanges: [], columnWidths: [], rowHeights: {}, styleTable: [{ v: "bottom" }, { b: 1, v: "center" }],
      cellStyles: { "1:1": 1, "2:1": 1 }, columnStyles: [0, 0, 1], cellRich: { "2:1": [{ t: "A", fc: "#FF0000" }] }, sheetZoom: 70 } });
  assert.deepEqual(plain(cropped.cellStyles), { "0:0": 1, "0:1": 1, "1:0": 1, "1:1": 1 });
  assert.deepEqual(plain(cropped.cellRich), { "1:0": [{ t: "A", fc: "#FF0000" }] });
  assert.equal(cropped.sheetZoom, 70);
});

test("기본 화면은 원본 양식: 표기 기호·빨간 글씨·서식 있는 글자·테두리·정렬을 그대로, 앱 태그는 없다", () => {
  const ctx = context();
  const layout = converted(ctx);
  const html = ctx.curriculumDataSheetHtml(layout, {}, false, false, new Map());
  // 표기 기호: 화면 글자는 원본 그대로(자동 수정은 이름 본문만: '고급물리학*' → '고급 물리학*')
  assert.match(rowHtml(html, "프로그래밍"), />프로그래밍★<\/button>/);
  assert.equal(subject(layout, "물리학").name, "고급 물리학* ");
  assert.equal(subject(layout, "물리학").originalName, "고급물리학* ");
  assert.match(rowHtml(html, "고급 물리학"), />고급 물리학\*<\/button>/, "자동 수정해도 * 기호가 남는다");
  // 빨간 글씨: 칸 전체(화법과 언어, 자동 수정된 고급 물리학*)와 칸 일부(지구시스템 과학)
  assert.match(rowHtml(html, "화법과 언어"), /class="curriculum-subject-cell"[^>]*style="[^"]*color:#FF0000/);
  assert.match(rowHtml(html, "고급 물리학"), /class="curriculum-subject-cell"[^>]*style="[^"]*color:#FF0000/, "자동 수정된 이름도 원본 빨간 글씨");
  const science = rowHtml(html, "역학과 에너지");
  assert.match(science, /data-curriculum-subject="지구시스템과학" style="[^"]*color:#FF0000[^"]*"[^>]*>지구시스템과학<\/button>/, "자동 수정된 과목도 원래 조각의 빨간 글씨");
  assert.doesNotMatch(science.match(/data-curriculum-subject="역학과 에너지"[^>]*>/)[0], /color:/);
  // 테두리·정렬·확대 비율(70%)
  assert.match(rowHtml(html, "공통국어1"), /class="curriculum-subject-cell"[^>]*style="[^"]*text-align:left[^"]*border-left:1px solid #000/);
  assert.match(html, /<col style="width:\d+px">/);
  assert.match(html, /font-size:13\.1px/, "14pt × 70% 확대");
  // 원본 양식만: 태그·자동 수정 표시·행 메뉴 열·띠 없음, 택n·교차집중은 원본 글자
  assert.doesNotMatch(html, /plan-section-tag|plan-autoname-mark|curriculum-row-tools|is-unverified/);
  assert.match(rowHtml(html, "역학과 에너지"), /class="curriculum-group-band"[^>]*>택1<\/button>/);
  assert.match(rowHtml(html, "음악"), /class="curriculum-cross-band"[^>]*>교차집중\(↔\)<\/button>/);
  assert.match(html, /☞ 표기방법 안내/);
  assert.match(html, /2026학년도 신입생 3개년 교육과정 편제표/);
});

test("원본 서식이 없는 편제표(울산 파일·예전 자료)도 같은 규칙(가는 테두리·굵은 머리글·과목명 왼쪽)으로 그린다", () => {
  const ctx = context();
  const raw = fixture();
  for (const key of ["cellStyles", "styleTable", "cellRich", "baseFont", "sheetZoom"]) delete raw[key];
  const layout = converted(ctx, raw);
  assert.equal(layout.planTemplate.format, undefined);
  const html = ctx.curriculumDataSheetHtml(layout, {}, false, false, new Map());
  assert.match(html, /is-basic-format/);
  assert.match(rowHtml(html, "공통국어1"), /class="curriculum-subject-cell"[^>]*style="[^"]*text-align:left[^"]*border-left:1px solid #000/);
  assert.match(html.split("<tr")[3], /font-weight:700/, "머리글은 굵게");
});

test("새로 넣은 과목 행은 이웃 행 서식을 쓰되 빨간 글씨는 물려받지 않는다", () => {
  const ctx = context();
  const layout = converted(ctx);
  const before = subject(layout, "화법과 언어");
  // '화법과 언어'(빨간 글씨) 바로 아래(음악, 미술 위)에 같은 국어 과목을 넣으면 이웃 행 = 화법과 언어
  const { layout: next } = ctx.curriculumDataInsertSubject(layout, { category: before.category, area: before.area, name: "독서 토론", base: 4, op: 4, kind: "일반선택" }, subject(layout, "음악").id);
  const added = subject(next, "독서 토론");
  assert.equal(added.plainFont, true);
  assert.deepEqual(plain(added.styles[0]), plain(before.styles[0]), "이웃 행 칸 서식(테두리·정렬)");
  const html = ctx.curriculumDataSheetHtml(next, {}, false, false, new Map());
  assert.doesNotMatch(rowHtml(html, "독서 토론").match(/class="curriculum-subject-cell"[^>]*>/)[0], /color:#FF0000/);
});

test("과목명 글자 조각: 이름이 바뀌어도(자동 수정) 과목마다 원래 글꼴, 엑셀 내보내기용 조각은 지금 이름과 같다", () => {
  const ctx = context();
  const layout = converted(ctx);
  const item = subject(layout, "역학과 에너지");
  const runs = plain(ctx.planDataNameRuns(item));
  assert.equal(runs.map((run) => run.t).join(""), item.name);
  assert.deepEqual(runs.at(-1), { t: "지구시스템과학", fc: "#FF0000", b: 1, sz: 14 });
  assert.equal(ctx.planDataNameRuns(subject(layout, "프로그래밍")), null, "서식 있는 글자가 없으면 칸 서식");
});

test("전학년 편제표는 입학생 편제표 양식(제목·머리글·소계·표기방법)으로, 학년 열은 그 학년 입학생 편제표에서", () => {
  const ctx = context();
  const y2026 = converted(ctx, fixture(2026), 2026);
  // 2025 입학생: 2학년 열에 '화법과 언어'(2-1 3학점), 2024 입학생: 3학년 열 '택1'과 다른 과목(고급화학*)
  const raw2025 = fixture(2025);
  raw2025.rows[5][8] = "3"; raw2025.rows[5][9] = "";
  const y2025 = converted(ctx, raw2025, 2025);
  const raw2024 = fixture(2024);
  raw2024.rows[9][3] = "고급화학*";
  const y2024 = converted(ctx, raw2024, 2024);
  const cohorts = { 2026: { plan: [], layout: y2026 }, 2025: { plan: [], layout: y2025 }, 2024: { plan: [], layout: y2024 } };
  const layout = ctx.buildAnnualCurriculumLayout(cohorts, 2026);
  assert.equal(layout.derived, true);
  assert.equal(layout.annualForm, true);
  assert.equal(layout.rows[0][0], "2026학년도 전학년 교육과정 편제표");
  assert.equal(layout.rows[2][6], "1학년(2026)");
  assert.equal(layout.rows[2][13], "필수이수학점", "같은 열 구성");
  const names = ctx.planDataSubjects(layout.planData).map((item) => item.name.trim());
  assert.ok(names.includes("고급화학*"), "Y에 없는 과목은 같은 묶음(학기 열) 옆에 들어간다");
  const speech = ctx.planDataSubjects(layout.planData).find((item) => item.name === "화법과 언어");
  assert.deepEqual(plain(speech.credits), { sem21: 3 }, "2학년 열은 2025 입학생 편제표");
  // 소계: 1학년 = 2026의 1학년, 2학년 = 2025의 2학년, 3학년 = 2024의 3학년(교차집중은 학기마다 한 번)
  const footer = layout.planRowMeta.findIndex((item) => item.type === "footer");
  const subtotal = layout.rows[footer].slice(6, 12);
  const cohortSubtotal = (cohort, grade) => {
    const index = cohort.planRowMeta.findIndex((item) => item.type === "footer");
    return cohort.rows[index].slice(6 + (grade - 1) * 2, 8 + (grade - 1) * 2);
  };
  assert.deepEqual(plain(subtotal), plain([...cohortSubtotal(y2026, 1), ...cohortSubtotal(y2025, 2), ...cohortSubtotal(y2024, 3)]));
  // 원본 양식 서식(빨간 글씨·택n 칸)이 그대로
  const html = ctx.curriculumDataSheetHtml(layout, {}, false, false, new Map());
  assert.match(html, /class="curriculum-group-band"[^>]*disabled>택1<\/button>/);
  assert.match(html, /교차집중\(↔\)/);
  assert.match(html, /☞ 표기방법 안내/);
  assert.doesNotMatch(html, /contenteditable="true"/, "전학년 편제표는 읽기 전용");
});

test("원본 양식 데이터가 없으면 전학년 편제표는 기본 양식(같은 열 구성)", () => {
  const ctx = context();
  const row = (subject, grade, credits) => ({ division: "학생 선택 교육과정", area: "수학", detail: "일반선택", subject, baseCredit: 4, opCredit: 4,
    ...Object.fromEntries(credits.map((credit, index) => [`sem${grade}${index + 1}`, String(credit)])) });
  const layout = ctx.buildAnnualCurriculumLayout({ 2026: { plan: [row("대수", 1, [4, 0])] }, 2025: { plan: [row("미적분", 2, [4, 4])] }, 2024: { plan: [] } }, 2026);
  assert.equal(layout.annualForm, undefined);
  assert.equal(layout.rows[1][13], "필수이수 학점");
});
