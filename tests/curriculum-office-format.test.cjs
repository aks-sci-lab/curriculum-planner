const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// 교육청(울산 편제 점검 프로그램) 양식 내보내기·불러오기. 실제 학교·울산 파일 대신 같은 모양의 합성 자료를 쓴다.
const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const office = fs.readFileSync(path.join(root, "curriculum-office-format.js"), "utf8");
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
    TextDecoder, ...extra
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
  for (const file of ["curriculum-subject-list.js", "curriculum-choice-blocks.js", "curriculum-data.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), ctx);
  }
  vm.runInContext(office.slice(0, office.indexOf("\n// ---- 앱 연결 ----")), ctx);
  return ctx;
}

const subject = (id, name, values = {}) => ({
  id, name, category: "학교 지정 교육과정", area: "국어", kindText: "공통", kind: "공통", base: "4", op: "4",
  credits: {}, texts: {}, cross: null, note: "", extra: {}, span: 1, ...values
});

// 3개년 편제표 데이터: 학교지정 3과목, 교차집중(음악, 미술), 2-1 택2·3-2 택1 선택과목군, 소인수 메모 과목
function planData() {
  return {
    version: 1, nextId: 20, groups: [
      { id: "g1", fields: ["sem21"], pick: 2, credit: 4, members: ["s5", "s6", "s7"] },
      { id: "g2", fields: ["sem32"], pick: 1, credit: 3, members: ["s8", "s9"] }
    ],
    subjects: [
      subject("s1", "공통국어1", { credits: { sem11: 4 } }),
      subject("s2", "한국사1", { area: "한국사", base: "3", op: "3", credits: { sem11: 3 } }),
      subject("s3", "문학", { kindText: "일반", kind: "일반선택", credits: { sem21: 4 } }),
      subject("s4", "음악, 미술", { area: "예술", kindText: "일반", kind: "일반선택", base: "3", op: "2", credits: { sem11: 2, sem12: 2 }, cross: ["sem11", "sem12"] }),
      subject("s5", "물리학, 화학", { category: "학생 선택 교육과정", area: "과학", kindText: "일반", kind: "일반선택" }),
      subject("s6", "세계사", { category: "학생 선택 교육과정", area: "사회", kindText: "일반", kind: "일반선택" }),
      subject("s7", "중국어, 일본어", { category: "학생 선택 교육과정", area: "제2외국어", kindText: "일반", kind: "일반선택" }),
      subject("s8", "인공지능 기초", { category: "학생 선택 교육과정", area: "정보", kindText: "진로", kind: "진로선택", op: "3" }),
      subject("s9", "데이터 과학", { category: "학생 선택 교육과정", area: "정보", kindText: "진로", kind: "진로선택", op: "3" }),
      subject("s10", "경제", { category: "학생 선택 교육과정", area: "사회", kindText: "진로", kind: "진로선택", op: "3", note: "소인수/2학년/1학기/3학점(순증)" })
    ]
  };
}

const cellValues = (sheet, row) => (sheet.cells[row] || []).map((cell) => cell?.v ?? "");

test("구분은 편성 영역 데이터를 먼저 쓰고, 없으면 메모·교차·선택과목군·구분 열로 추정한다", () => {
  const ctx = context();
  assert.equal(ctx.curriculumOfficeDivision({ note: "공동/2학년/1,2학기/3학점" }), "공동");
  assert.equal(ctx.curriculumOfficeDivision({ name: "세계사" }, { inGroup: true }), "학생선택");
  assert.equal(ctx.curriculumOfficeDivision({ name: "문학" }), "학교지정");
  assert.equal(ctx.curriculumOfficeDivision({ name: "문학", category: "학생 선택 교육과정" }), "학생선택");
  assert.equal(ctx.curriculumOfficeDivision({ name: "문학", planSection: "choice" }), "학생선택");
  assert.equal(ctx.curriculumOfficeSection({ name: "음악, 미술", cross: ["sem11", "sem12"] }), "cross");
  assert.equal(ctx.curriculumOfficeDivision({ name: "음악", planSection: "cross" }), "학교지정");
  // 편성 영역 함수(다른 작업의 curriculumPlanSection)가 있으면 그 판단이 우선한다.
  const hooked = context({ curriculumPlanSection: (item) => item.name === "문학" ? "extra" : "" });
  assert.equal(hooked.curriculumOfficeSection({ name: "문학" }), "extra");
  assert.equal(hooked.curriculumOfficeDivision({ name: "문학" }), "그 외");
  assert.deepEqual(plain(ctx.curriculumOfficeNoteInfo("소인수/2학년/1,2학기/3학점(순증)")),
    { label: "소인수", fields: ["sem21", "sem22"], credit: 3, text: "소인수/2학년/1,2학기/3학점(순증)" });
  assert.equal(ctx.curriculumOfficeArea({ name: "한국사1", area: "한국사" }), "사회(역사/도덕포함)");
  assert.equal(ctx.curriculumOfficeArea({ name: "인공지능 기초", area: "정보" }), "기술⋅가정/정보");
  assert.equal(ctx.curriculumOfficeKind({ name: "문학", kindText: "", kind: "일반선택" }), "일반");
});

test("입학생 편제표는 울산 N학년_편제표 열·순서·선택군 병합·소계 수식으로 나간다", () => {
  const ctx = context();
  const sheet = ctx.curriculumOfficeCohortSheet({ planData: planData() }, { year: 2026, grade: 2, school: "천상고등학교" });
  assert.equal(sheet.name, "2학년_편제표");
  assert.equal(sheet.cells[0][0].v, "2026학년도 입학생 교육과정 편제표(안)");
  assert.equal(sheet.cells[0][0].style.h, "centerContinuous");
  assert.equal(sheet.cells[1][14].v, "(천상고등학교)");
  assert.deepEqual(plain(cellValues(sheet, 2)), ["구분", "교과(군)", "과목유형", "세부교과목", "기준학점", "운영학점", "1학년", "", "2학년", "", "3학년", "", "선택군", "선택수", "비  고"]);
  assert.deepEqual(plain(cellValues(sheet, 3).slice(6, 12)), ["1학기", "2학기", "1학기", "2학기", "1학기", "2학기"]);
  const body = sheet.cells.slice(4, sheet.footer).map((row) => [row[0].v, row[1].v, row[2].v, row[3].v, ...row.slice(6, 15).map((cell) => cell.v)]);
  assert.deepEqual(plain(body), [
    ["학교지정", "국어", "공통", "공통국어1", 4, "", "", "", "", "", "", "", ""],
    ["학교지정", "사회(역사/도덕포함)", "공통", "한국사1", 3, "", "", "", "", "", "", "", ""],
    ["학교지정", "국어", "일반", "문학", "", "", 4, "", "", "", "", "", ""],
    // 교차집중: 과목마다 한 줄, 두 학기 같은 학점, 선택군 '가'
    ["학교지정", "예술", "일반", "음악", 2, 2, "", "", "", "", "가", "", "교차집중"],
    ["학교지정", "예술", "일반", "미술", 2, 2, "", "", "", "", "", "", "교차집중"],
    // 선택군 구성 과목: 세부교과목 한 칸에 한 과목(편제표의 '물리학, 화학' 한 행 → 두 줄)
    ["학생선택", "과학", "일반", "물리학", "", "", 4, "", "", "", "A", "택2", ""],
    ["학생선택", "과학", "일반", "화학", "", "", 4, "", "", "", "", "", ""],
    ["학생선택", "사회(역사/도덕포함)", "일반", "세계사", "", "", 4, "", "", "", "", "", ""],
    ["학생선택", "제2외국어/한문", "일반", "중국어", "", "", 4, "", "", "", "", "", ""],
    ["학생선택", "제2외국어/한문", "일반", "일본어", "", "", 4, "", "", "", "", "", ""],
    ["학생선택", "기술⋅가정/정보", "진로", "인공지능 기초", "", "", "", "", "", 3, "B", "택1", ""],
    ["학생선택", "기술⋅가정/정보", "진로", "데이터 과학", "", "", "", "", "", 3, "", "", ""],
    // 그 외(소인수)는 메모의 학년·학기에 학점, 소계에는 넣지 않는다.
    ["소인수", "사회(역사/도덕포함)", "진로", "경제", "", "", 3, "", "", "", "", "", ""]
  ]);
  assert.ok(sheet.merges.includes("M8:M9") && sheet.merges.includes("M10:M14") && sheet.merges.includes("N15:N16"));
  assert.ok(sheet.merges.includes("A3:A4") && sheet.merges.includes("O3:O4") && !sheet.merges.includes("G3:H3"));
  const footer = sheet.cells[sheet.footer];
  assert.equal(footer[0].v, "이수학점 소계");
  // 1학기: 공통국어1 4 + 한국사1 3 + 교차집중은 음악만 2 = 9 (미술 줄은 빼고 센다)
  assert.equal(footer[6].f, "SUM(G5:G8)");
  assert.equal(footer[6].v, 9);
  // 2-1: 문학 4 + 택2 × 4. 소인수 경제 3은 넣지 않는다.
  assert.equal(footer[8].f, "SUM(I5:I9)+2*I10");
  assert.equal(footer[8].v, 12);
  assert.equal(footer[11].f, "1*L15");
  // 학점이 하나도 없는 학기(3-1)는 과목 영역 전체 SUM으로 둔다.
  assert.equal(footer[10].f, "SUM(K5:K17)");
  assert.equal(footer[11].v, 3);
  assert.equal(footer[14].f, `SUM(G${sheet.footer + 1}:L${sheet.footer + 1})`);
  assert.equal(sheet.cells[sheet.footer + 2][6].f, `G${sheet.footer + 1}+G${sheet.footer + 2}`);
  // 구분 칸 색: 학교지정 파랑, 학생선택 노랑. 선택군 학점 칸은 묶음 색.
  assert.equal(sheet.cells[4][0].style.fill, "BFDFFF");
  assert.equal(sheet.cells[9][0].style.fill, "FFFFCC");
  assert.equal(sheet.cells[9][8].style.fill, "F4B084");
  assert.equal(sheet.cells[7][6].style.fill, "FFC7CE");
});

test("전학년 편제표는 학년마다 해당 입학생 편제표의 그 학년 열만 모아 편제표통합 모양으로 만든다", () => {
  const ctx = context();
  const older = planData();
  older.subjects[0] = subject("s1", "공통국어1", { credits: { sem11: 4, sem21: 9 } });
  const sheet = ctx.curriculumOfficeAnnualSheet({ 1: { planData: planData() }, 2: { planData: older }, 3: { planData: planData() } }, { year: 2026, school: "" });
  assert.equal(sheet.name, "편제표통합");
  assert.equal(sheet.cells[0][0].v, "2026학년도 전학년 교육과정 편제표(안)");
  assert.deepEqual(plain(cellValues(sheet, 2).slice(6, 12)), ["1학년(26)", "", "2학년(25)", "", "3학년(24)", ""]);
  const names = sheet.cells.slice(4, sheet.footer).map((row) => `${row[3].v}:${row.slice(6, 12).map((cell) => cell.v).join(",")}`);
  // 1학년 열은 1학년 입학생(2026)에서만, 2학년 열은 2025 입학생에서만 온다(2025의 1학년 학점 4는 쓰지 않는다).
  assert.ok(names.includes("공통국어1:4,,,,,"));
  assert.ok(names.includes("공통국어1:,,9,,,"));
  // 선택군 구성 과목은 한 칸에 한 과목
  assert.equal(names.filter((name) => name.startsWith("물리학:")).length, 1);
  assert.equal(names.filter((name) => name.startsWith("물리학, 화학")).length, 0);
  // 1학년 1학기 = 4+3+교차 2, 2학년 1학기 = 2025 입학생의 공통국어1 9 + 문학 4 + 택2×4, 3학년은 3학년 학점이 없는 편제표라 0
  assert.deepEqual(plain(sheet.cells[sheet.footer].slice(6, 12).map((cell) => cell.v)), [9, 2, 21, 0, 0, 3]);
});

test("엑셀 파일 목록에는 선택 영역 가운데 맞춤·병합·인쇄 제목·숨긴 오른쪽 열이 들어간다", () => {
  const ctx = context();
  const sheet = ctx.curriculumOfficeCohortSheet({ planData: planData() }, { year: 2026, grade: 2, school: "천상고등학교" });
  const files = ctx.curriculumOfficeWorkbookFiles([sheet]);
  const xml = files["xl/worksheets/sheet1.xml"];
  assert.match(xml, /<mergeCell ref="M8:M9"\/>/);
  assert.match(xml, /<pane ySplit="4" topLeftCell="A5"/);
  assert.match(xml, /<col min="18" max="16384" width="8.74" hidden="1"/);
  assert.match(xml, /<f>SUM\(I5:I9\)\+2\*I10<\/f><v>12<\/v>/);
  assert.match(files["xl/styles.xml"], /horizontal="centerContinuous"/);
  assert.match(files["xl/styles.xml"], /<fgColor rgb="FFBFDFFF"\/>/);
  assert.match(files["xl/workbook.xml"], /_xlnm\.Print_Titles" localSheetId="0">&apos;2학년_편제표&apos;!\$3:\$4/);
  const styleCount = Number(files["xl/styles.xml"].match(/<cellXfs count="(\d+)"/)[1]);
  const used = Math.max(...[...xml.matchAll(/ s="(\d+)"/g)].map((match) => Number(match[1])));
  assert.ok(used < styleCount);
});

// 울산 「N학년_편성과목」 입력 영역(8행부터): 학교지정 B~K, 교차집중 S~AC(그룹), 학생선택 AL~AW(그룹·선택 수), 그 외 BF~BP(구분)
function programSheets() {
  const rows = [];
  const put = (row, start, values) => {
    rows[row - 1] ||= [];
    let column = 0;
    for (const letter of start) column = column * 26 + letter.charCodeAt(0) - 64;
    values.forEach((value, index) => { rows[row - 1][column - 1 + index] = value === null ? "" : String(value); });
  };
  put(8, "C", ["국어", "공통", "공통국어1", 4]);
  put(9, "C", ["수학", "일반선택", "대수", "", "", 4]);
  put(8, "T", ["가", "예술", "일반선택", "음악", 2, 2]);
  put(9, "T", ["가", "예술", "일반선택", "미술", 2, 2]);
  put(8, "AM", ["A", 2, "과학", "일반선택", "물리학", "", "", 4]);
  put(9, "AM", ["A", "", "과학", "일반선택", "화학", "", "", 4]);
  put(10, "AM", ["A", "", "사회(역사/도덕포함)", "일반선택", "세계사", "", "", 4]);
  put(11, "AM", ["B", "택1", "기술⋅가정/정보", "진로선택", "인공지능 기초", "", "", "", "", "", 3]);
  put(12, "AM", ["B", "", "기술⋅가정/정보", "진로선택", "데이터 과학", "", "", "", "", "", 3]);
  put(8, "BG", ["소인수", "수학", "융합선택", "수학과 문명의 발달", "", "", "", 4]);
  const info = [];
  info[4] = ["", "학교명", "천상고등학교"];
  info[7] = ["", "3학년 학년도", "25"];
  info[8] = ["", "2학년 학년도", "26"];
  info[9] = ["", "1학년 학년도", "27"];
  const catalog = [[], [], [], ["1", "국어", "국어", "공통", "공통국어1", "4"], ["2", "수학", "수학", "일반선택", "대수", "4"], ["3", "예술", "예술", "일반선택", "음악", "3"],
    ["4", "과학", "과학", "일반선택", "물리학", "4"]];
  return [
    { name: "학교정보", rows: info }, { name: "과목목록", rows: catalog },
    { name: "3학년_편성과목", rows: [] }, { name: "2학년_편성과목", rows }, { name: "1학년_편성과목", rows: [] }
  ];
}

test("울산 프로그램 파일은 학교정보의 입학연도로 카드와 맞는 학년 시트를 고른다", () => {
  const ctx = context();
  const sheets = programSheets();
  assert.equal(ctx.isCurriculumOfficeProgram(sheets), true);
  assert.equal(ctx.isCurriculumOfficeProgram([{ name: "편제표" }]), false);
  const years = ctx.curriculumOfficeProgramYears(sheets);
  assert.deepEqual(plain(years), { 1: 2027, 2: 2026, 3: 2025, school: "천상고등학교" });
  const options = [1, 2, 3].map((grade) => ({ grade, year: years[grade], count: grade === 2 ? 10 : 0 }));
  assert.equal(ctx.curriculumOfficeChooseGrade(options, { cohortYear: "2026", schoolYear: "2026" }), 2);
  assert.equal(ctx.curriculumOfficeChooseGrade(options, { cohortYear: "2027", schoolYear: "2026" }), 1);
  // 입학연도가 맞는 시트가 없으면 과목이 있는 시트
  assert.equal(ctx.curriculumOfficeChooseGrade(options, { cohortYear: "2023", schoolYear: "2026" }), 2);
});

test("편성과목 입력 영역은 과목·학점·선택과목군·교차집중·그 외 메모로 바뀌고 다시 내보내면 같은 내용이다", () => {
  const ctx = context();
  const sheets = programSheets();
  const inputs = ctx.curriculumOfficeReadInputs(sheets[3]);
  assert.deepEqual(Object.fromEntries(Object.entries(plain(inputs)).map(([key, rows]) => [key, rows.length])), { school: 2, cross: 2, choice: 5, other: 1 });
  assert.equal(ctx.curriculumOfficeInputCount(ctx.curriculumOfficeReadInputs(sheets[2])), 0);
  const data = ctx.curriculumOfficeDataFromInputs(inputs, ctx.curriculumOfficeCatalog(sheets));
  const byName = Object.fromEntries(data.subjects.map((item) => [item.name, item]));
  assert.deepEqual(plain(byName["공통국어1"].credits), { sem11: 4 });
  assert.equal(byName["공통국어1"].base, "4");
  assert.equal(byName["공통국어1"].planSection, "school");
  assert.equal(byName["공통국어1"].planSectionManual, true);
  assert.deepEqual(plain(byName["음악, 미술"].cross), ["sem11", "sem12"]);
  assert.equal(byName["음악, 미술"].planSection, "cross");
  // 같은 교과(군)·유형·학점의 이어진 줄은 한 과목(이름 나열)
  assert.ok(byName["물리학, 화학"] && byName["세계사"]);
  assert.deepEqual(plain(data.groups.map(({ fields, pick, credit, members }) => ({ fields, pick, credit, members: members.map((id) => data.subjects.find((item) => item.id === id).name) }))), [
    { fields: ["sem21"], pick: 2, credit: 4, members: ["물리학, 화학", "세계사"] },
    { fields: ["sem32"], pick: 1, credit: 3, members: ["인공지능 기초, 데이터 과학"] }
  ]);
  assert.equal(byName["수학과 문명의 발달"].note, "소인수/2학년/2학기/4학점");
  assert.equal(byName["수학과 문명의 발달"].planSection, "extra");
  assert.equal(byName["수학과 문명의 발달"].op, "4");

  // 앱 표(머리글·소계 행)로 만들고 3개년 과목 목록으로 읽힌다.
  const template = ctx.curriculumOfficeTemplate({ year: "2026", school: "천상고등학교", activity: ["3", "3", "3", "3", "3", "3"] });
  const layout = { sheetName: "2학년_편성과목", sourceRowOffset: 0, sourceColumnOffset: 0, rowInsertions: [], rows: [], mergedRanges: [], formulas: {}, cellFills: {}, rowHeights: {}, hiddenRows: [], officeImport: {} };
  ctx.applyCurriculumData(layout, data, template);
  const plan = ctx.curriculumPlanFromLayout(layout, "울산");
  const planNames = plan.map((row) => row.subject);
  for (const name of ["공통국어1", "대수", "물리학", "화학", "세계사", "인공지능 기초", "데이터 과학"]) assert.ok(planNames.includes(name), name);
  // 과목 목록(plan)의 학기 칸은 편성 표시(●)만 남는다.
  assert.deepEqual(plain(["sem11", "sem21", "sem22"].map((field) => plan.find((row) => row.subject === "대수")[field])), ["", "●", ""]);

  // 다시 교육청 양식으로: 선택군·선택 수·소계가 원래 입력과 같다.
  const sheet = ctx.curriculumOfficeCohortSheet(layout, { year: 2026, grade: 2, school: "천상고등학교" });
  const rows = sheet.cells.slice(4, sheet.footer).map((row) => [row[0].v, row[3].v, row[12].v, row[13].v]);
  assert.deepEqual(plain(rows), [["학교지정", "공통국어1", "", ""], ["학교지정", "대수", "", ""], ["학교지정", "음악", "가", ""], ["학교지정", "미술", "", ""],
    // 원래 울산 입력처럼 세부교과목 한 칸에 한 과목
    ["학생선택", "물리학", "A", "택2"], ["학생선택", "화학", "", ""], ["학생선택", "세계사", "", ""], ["학생선택", "인공지능 기초", "B", "택1"], ["학생선택", "데이터 과학", "", ""], ["소인수", "수학과 문명의 발달", "", ""]]);
  assert.deepEqual(plain(sheet.cells[sheet.footer].slice(6, 12).map((cell) => cell.v)), [6, 2, 12, 0, 0, 3]);
  assert.deepEqual(plain(sheet.cells[sheet.footer + 1].slice(6, 12).map((cell) => cell.v)), [3, 3, 3, 3, 3, 3]);
});

// xlsb 레코드: 번호(가변 1~2바이트) + 길이(가변) + 내용
function record(id, body) {
  const head = id < 0x80 ? [id] : [(id & 0x7f) | 0x80, id >> 7];
  const size = [];
  let length = body.length;
  do { let byte = length & 0x7f; length >>= 7; if (length) byte |= 0x80; size.push(byte); } while (length);
  return Buffer.concat([Buffer.from(head), Buffer.from(size), body]);
}
const wide = (text) => { const buffer = Buffer.alloc(4 + text.length * 2); buffer.writeUInt32LE(text.length, 0); for (let i = 0; i < text.length; i++) buffer.writeUInt16LE(text.charCodeAt(i), 4 + i * 2); return buffer; };
const u32 = (...values) => { const buffer = Buffer.alloc(values.length * 4); values.forEach((value, index) => buffer.writeUInt32LE(value, index * 4)); return buffer; };

test("xlsb 리더는 시트 이름·공유 문자열·숫자(RK·실수)·문자열 칸을 읽는다", () => {
  const ctx = context();
  const bundle = (name, rel) => record(156, Buffer.concat([u32(0, 1), wide(rel), wide(name)]));
  const rk = (value) => (value << 2) | 2;
  const real = Buffer.alloc(8); real.writeDoubleLE(2.5);
  const entries = {
    "xl/workbook.bin": Buffer.concat([bundle("학교정보", "rId1"), bundle("2학년_편성과목", "rId2")]),
    "xl/_rels/workbook.bin.rels": Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.bin"/><Relationship Id="rId2" Target="worksheets/sheet2.bin"/></Relationships>'),
    "xl/sharedStrings.bin": Buffer.concat([record(19, Buffer.concat([Buffer.from([0]), wide("국어")])), record(19, Buffer.concat([Buffer.from([0]), wide("공통국어1")]))]),
    "xl/worksheets/sheet1.bin": Buffer.concat([record(0, u32(7, 0, 0)), record(2, Buffer.concat([u32(2, 0), u32(rk(25))]))]),
    "xl/worksheets/sheet2.bin": Buffer.concat([record(0, u32(7, 0, 0)), record(7, Buffer.concat([u32(2, 0), u32(0)])), record(7, Buffer.concat([u32(4, 0), u32(1)])),
      record(5, Buffer.concat([u32(5, 0), real])), record(6, Buffer.concat([u32(3, 0), wide("공통")]))])
  };
  const sheets = ctx.curriculumOfficeXlsbSheets(Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, new Uint8Array(value)])));
  assert.deepEqual(plain(sheets.map((sheet) => sheet.name)), ["학교정보", "2학년_편성과목"]);
  assert.equal(sheets[0].rows[7][2], "25");
  assert.deepEqual(plain(sheets[1].rows[7].slice(2, 6)), ["국어", "공통", "공통국어1", "2.5"]);
  assert.equal(ctx.curriculumOfficeProgramYears(sheets)[3], 2025);
});

test("교육청 양식 단추·불러오기 확인 창이 화면에 있고 새 파일을 불러온다", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(html, /id="exportCurriculumOfficePlan"[^>]*>교육청 양식으로 내보내기</);
  assert.match(html, /id="curriculumPlanInput" type="file" accept="\.xlsx,\.xlsb"/);
  assert.match(html, /id="curriculumOfficeImportDialog"/);
  assert.ok(html.indexOf("curriculum-office-format.js") > html.indexOf("curriculum-data-export.js"));
  assert.match(app, /isCurriculumOfficeProgram\(sheets\)/);
});

test("xlsb 읽기는 단계마다 진행 문구(1/3~3/3·경과 초)를 상태 줄에 보이고, 끝나거나 실패하면 읽는 중 표시를 끈다", async () => {
  const status = { style: {}, textContent: "", attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
  const seen = [];
  const ctx = vm.createContext({
    TextDecoder, setTimeout: (resolve) => { seen.push(status.textContent); resolve(); },
    document: { getElementById: (id) => id === "status" ? status : null, addEventListener() {} },
    state: { curriculumCohortYear: "2026", curriculumPlanType: "cohort", curriculumMutationRevision: 0 },
    readZipDirectory: () => new Map(), readZipEntry: async () => new Uint8Array()
  });
  const appLink = office.slice(office.indexOf("\n// ---- 앱 연결 ----"));
  vm.runInContext(office.slice(0, office.indexOf("\n// ---- 앱 연결 ----")), ctx);
  vm.runInContext(appLink.slice(appLink.indexOf("function curriculumOfficeStatus("), appLink.indexOf("// 학년 시트 선택 확인 창.")), ctx);
  const start = appLink.indexOf("async function importCurriculumOfficeXlsbFile(");
  vm.runInContext(appLink.slice(start, appLink.indexOf("\nif (typeof document", start)), ctx);
  const result = await ctx.importCurriculumOfficeXlsbFile({ arrayBuffer: async () => new ArrayBuffer(0) });
  assert.equal(result, false, "빈 파일은 거절");
  assert.deepEqual(seen.map((text) => text.match(/\((\d)\/3\)/)?.[1]), ["1", "2", "3"]);
  assert.match(seen[0], /큰 파일은 30초쯤 걸립니다/);
  assert.equal(status.attributes["aria-busy"], "false");
  assert.match(status.textContent, /xlsb 파일을 읽지 못했습니다/, "실패하면 진행 문구 대신 오류");
});
