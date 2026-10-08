const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((source) => source.trim());
const frontend = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const workbookParser = fs.readFileSync(path.join(__dirname, "..", "xlsx-parser.js"), "utf8");
const curriculumWorkbook = fs.readFileSync(path.join(__dirname, "..", "curriculum-workbook.js"), "utf8");
function functionSource(start, end) {
  const startIndex = frontend.indexOf(start);
  const endIndex = frontend.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `Missing source boundaries: ${start} → ${end}`);
  return frontend.slice(startIndex, endIndex);
}
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
function normalizeGradeGroupNamesForTest(value, legacyNames = []) {
  const normalize = (names) => Array.isArray(names)
    ? [...new Set(names.map((name) => String(name ?? "").replace(/\s+/g, " ").trim()).filter(Boolean))]
    : [];
  return value
    ? { "2": normalize(value["2"]), "3": normalize(value["3"]) }
    : { "2": normalize(legacyNames), "3": normalize(legacyNames) };
}

test("all embedded scripts parse", () => {
  scripts.forEach((source) => new vm.Script(source));
  new vm.Script(frontend);
  new vm.Script(workbookParser);
});

test("large imported curriculum layouts persist in IndexedDB and restore by archive ID", () => {
  assert.match(curriculumWorkbook,/async function storeCurriculumLayout\(layout\)[\s\S]*curriculumArchiveStore\("put",`layout:\$\{layout\.archiveId\}`,layout\)/);
  assert.match(curriculumWorkbook,/async function loadCurriculumLayout\(id\)[\s\S]*curriculumArchiveStore\("get",`layout:\$\{id\}`\)/);
  assert.match(frontend,/curriculumLayoutArchiveId:\s*state\.curriculumImportedLayout\?\.archiveId\s*\|\|\s*curriculumLayoutStoredId\s*\|\|\s*""/);
  assert.match(frontend,/loadCurriculumLayout\(persistedLayoutId\)\.then/);
  assert.match(frontend,/curriculumLayoutArchiveId:[\s\S]*?curriculumLayoutStoredId \|\| ""/);
  assert.match(frontend,/curriculumLayoutStoredId = persistedLayoutId;\s*renderCurriculumStep\(\);\s*renderApplicationSubjects\(\);\s*renderPreview\(\);\s*renderSemesterClassifier\(\);\s*renderAggregate\(\);/);
  assert.match(frontend,/await storeCurriculumLayout\(importedLayout\)/);
  assert.match(frontend,/function scheduleCurriculumLayoutPersistence\(\)/);
  assert.match(frontend,/브라우저 저장 공간이 부족해 변경 내용을 저장하지 못했습니다/);
  assert.match(frontend,/function persistState\(\) \{[\s\S]*?if \(!statePersistenceReady\) return false;/);
  assert.match(frontend,/function restorePersistedState\(\) \{[\s\S]*?resetWorkspace\(false\);\s*statePersistenceReady = true;/);
  assert.match(frontend,/catch \(error\) \{\s*console\.error\("복원한 자료 표시 실패", error\);/);
});

test("roster supports aliases, sheet grades and multiple sheets", () => {
  const ctx = vm.createContext({});
  vm.runInContext(functionSource("function parseApplicationRoster(", "function downloadRowsXlsx("), ctx);
  const result = ctx.parseApplicationRoster([
    { name: "명렬", rows: [["학년", "반", "번호", "성명"], [1, 2, 3, "가상학생1"], []] },
    { name: "2학년", rows: [["반", "출석번호", "학생명", "학번"], [2, 4, "가상학생2", "20260004"]] },
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(plain(result[1]), {
    studentId: "20260004", grade: "2", classroom: "2", number: "4", name: "가상학생2"
  });
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

test("result workbook preserves the stable student ID column", () => {
  const ctx = vm.createContext({
    parseCourseGroup: () => ({}),
    parseSemesterFromCourseName: () => "",
    isSelected: (value) => value === "O",
  });
  vm.runInContext(functionSource("function createRecords(", "function createCurriculumRecords("), ctx);
  const parsed = ctx.createRecords([
    ["", "", "", "", "", "수학"],
    ["학년", "반", "번호", "성명", "학번", 3],
    ["1", "2", "4", "가상학생", "20260024", "O"],
  ]);
  assert.equal(parsed.students[0].studentId, "20260024");
  assert.equal(parsed.students[0].selections[0].name, "수학");
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
    curriculumCellFill: () => "",
  });
  vm.runInContext(functionSource("function collectApplicationSubjects(", "function renderApplicationSubjects("), ctx);
  const result = plain(ctx.selectedApplicationSubjects());
  assert.deepEqual(result["1"], []);
  assert.deepEqual(result["2"].map((c) => c.subject), ["수학"]);
  assert.equal(result["2"][0].semester, "1·2");
  assert.deepEqual(result["3"].map((c) => c.subject), ["과학"]);
});

test("merged subject header uses actual course names and splits course lists by promoted semester", () => {
  const layout = {
    rows: [
      ["구분", "교과(군)", "세부과목", "", "기준학점", "운영학점", "1학년", "", "2학년", "", "3학년", ""],
      ["", "", "", "", "", "", "1학기", "2학기", "1학기", "2학기", "1학기", "2학기"],
      ["학교 지정 교육과정", "국어", "일반", "문학", 4, 4, "", "", 4],
      ["학생 선택\n교육과정", "사회", "일반", "세계사, 사회와 문화", 4, 4, "", "", "택3"],
      ["", "과학", "일반", "물리학, 화학", 4, 4, "", "", 4],
      ["", "영어", "융합", "미디어 영어, 세계 문화와 영어", 4, 4, "", "", "", 4],
      ["", "과학", "융합", "물리학 실험＊", 4, 3, "2학년/1,2학기/3학점"],
      ["", "국어", "진로", "주제 탐구 독서", 4, 4, "", "", "", "", "", 4],
      ["", "과학", "융합", "기후변화와 환경생태", 3, 3, "", "", "", "", "", ""],
      ["", "과학", "진로", "행 강조 과목", 3, 3, "", "", 3, "", "", ""],
    ],
    mergedRanges: ["A1:A2", "B1:B2", "C1:D2", "E1:E2", "F1:F2",
      "G1:H1", "I1:J1", "K1:L1", "A4:A8", "G7:L7"],
    cellFills: {"3:8":"#E2EFD9","4:8":"#E2EFD9","5:9":"#E2EFD9","6:6":"#D6DCE4",
      "8:10":"#FCE4D6","9:3":"#FFFF00","9:8":"#FFFF00","9:9":"#FFFF00"},
  };
  const ctx = vm.createContext({ state: { curriculumImportedLayout: layout } });
  for (const name of ["columnIndex", "expandCurriculumLayoutRows", "importedPlanColumnMap",
    "importedPlanCoveredCells", "curriculumSelectionType", "importedPlanCourseContexts", "curriculumCellFill", "collectApplicationSubjects"]) {
    const start = frontend.indexOf(`function ${name}(`);
    const next = frontend.indexOf("\n    function ", start + 1);
    vm.runInContext(frontend.slice(start, next), ctx);
  }
  const columns = plain(ctx.importedPlanColumnMap(layout));
  assert.equal(columns.subject, 3);
  assert.equal(columns.division, 0);
  assert.deepEqual(columns.semesters, [6, 7, 8, 9, 10, 11]);
  const subjects = plain(ctx.collectApplicationSubjects());
  assert.deepEqual(subjects["2"].map((c) => c.subject),
    ["세계사", "사회와 문화", "물리학", "화학", "미디어 영어", "세계 문화와 영어", "물리학 실험", "행 강조 과목"]);
  assert.equal(subjects["2"].find((c) => c.subject === "물리학 실험").semester, "1·2");
  // Row-wide highlighting (same color as the subject cell) does not add an empty semester.
  assert.equal(subjects["2"].find((c) => c.subject === "행 강조 과목").semester, "1");
  assert.deepEqual(subjects["3"].map((c) => c.subject), ["주제 탐구 독서", "기후변화와 환경생태"]);
  assert.equal(subjects["3"][0].semester, "2");
  // An empty semester cell with its own fill color counts as that semester for color grouping.
  assert.equal(subjects["3"][1].semester, "1");
  assert.equal(subjects["3"][1].semesterColors["1"], "#FCE4D6");
  assert.equal(subjects["3"][1].hours, "");
  assert.equal(subjects["2"].find((c)=>c.subject==="세계사").semesterColors["1"],"#E2EFD9");
  assert.equal(subjects["2"].find((c)=>c.subject==="물리학").semesterColors["1"],"#E2EFD9");
  assert.equal(subjects["2"].find((c)=>c.subject==="물리학 실험").semesterColors["2"],"#D6DCE4");
});

test("joint and small-enrollment courses are excluded from new applications, not historical imports", () => {
  const contexts = [
    {subject:"일반 과목",division:"학생선택교육과정",detail:"융합",selectionType:"융합선택",
      row:[3,3,""],grade:"2",area:"과학"},
    {subject:"공동체와 인간",division:"학생선택교육과정",detail:"일반",selectionType:"일반선택",
      row:[3,3,""],grade:"2",area:"사회"},
    {subject:"공동 과목",division:"학생선택교육과정",detail:"진로",selectionType:"진로선택",
      row:[3,3,"공 동 교육과정"],grade:"2",area:"과학"},
    {subject:"소인수 과목",division:"학생선택교육과정",detail:"진로",selectionType:"진로선택",
      row:[3,"소인수/2학년/1학기/3학점",""],grade:"2",area:"과학"},
    {subject:"공동 과목 2",division:"학생선택교육과정",detail:"일반",selectionType:"일반선택",
      row:[3,"공동/2학년/1학기/3학점",""],grade:"2",area:"과학"},
  ];
  const ctx = vm.createContext({
    state:{curriculumImportedLayout:{}},
    importedPlanColumnMap:()=>({subject:0,opCredit:0,semesters:[-1,-1,1,-1,-1,-1]}),
    importedPlanCourseContexts:()=>contexts,curriculumCellFill:()=>"",
  });
  vm.runInContext(functionSource("function collectApplicationSubjects(", "function renderApplicationSubjects("),ctx);
  assert.deepEqual(plain(ctx.selectedApplicationSubjects()["2"].map((c)=>c.subject)),["일반 과목","공동체와 인간"]);
  assert.equal(ctx.collectApplicationSubjects({includeExcluded:true})["2"].length,5);
  vm.runInContext(functionSource("function mergeApplications(", "function parseApplicationRoster("),ctx);
  const historical=ctx.mergeApplications([{grade:"1",classroom:"1",number:"1",name:"가상",selections:["소인수 과목"]}]);
  assert.deepEqual(plain(historical.errors),[]);
  assert.equal(historical.students[0].selections[0].name,"소인수 과목");
});

test("student course classification labels leave selection identities unchanged", () => {
  const ctx=vm.createContext({});
  vm.runInContext(functionSource("function curriculumSelectionType(", "function importedPlanCourseContexts("),ctx);
  vm.runInContext(functionSource("function applicationCourseLabel(", "function renderApplicationSubjects("),ctx);
  for (const [type,label] of [["융합선택","융합"],["진로선택","진로"],["일반선택","일반"]]) {
    const course={subject:"물리학 실험",type};
    assert.equal(ctx.applicationCourseLabel(course),`물리학 실험(${label})`);
    assert.equal(course.subject,"물리학 실험");
  }
  assert.equal(ctx.applicationCourseLabel({subject:"수학"}),"수학");
});

test("Excel style fills resolve RGB, theme, tint, indexed and uncolored cells", async () => {
  function node(tag,attributes={},children=[]) {
    return {children,textContent:"",
      getAttribute:(name)=>attributes[name] ?? null,hasAttribute:(name)=>name in attributes,
      getElementsByTagNameNS(ns,name) {
        return children.flatMap((c)=>[...(c.tag===name?[c]:[]),...c.getElementsByTagNameNS(ns,name)]);
      },tag};
  }
  const fill=(attributes,type="solid")=>node("fill",{},[node("patternFill",{patternType:type},[node("fgColor",attributes)])]);
  const styles=node("styleSheet",{},[
    node("fills",{},[fill({},"none"),fill({rgb:"FFE2EFD9"}),fill({theme:"4"}),
      fill({indexed:"42"}),fill({theme:"0"}),fill({theme:"4",tint:"0.5"})]),
    node("cellXfs",{},Array.from({length:6},(_,fillId)=>node("xf",{fillId:String(fillId)})))
  ]);
  const theme=node("theme",{},[node("clrScheme",{},[
    node("dk1",{},[node("sysClr",{lastClr:"000000"})]),
    node("lt1",{},[node("srgbClr",{val:"FFFFFF"})]),
    node("dk2",{},[node("srgbClr",{val:"445566"})]),
    node("lt2",{},[node("srgbClr",{val:"EEEEEE"})]),
    node("accent1",{},[node("srgbClr",{val:"E2EFD9"})])
  ])]);
  const ctx=vm.createContext({NS_MAIN:"m",readZipEntry:async(b,d,p)=>p.includes("styles")?styles:theme,parseXml:(n)=>n});
  vm.runInContext(workbookParser.slice(
    workbookParser.indexOf("async function readWorkbookFillStyles("),
    workbookParser.indexOf("\n    }", workbookParser.indexOf("async function readWorkbookFillStyles(")) + 6
  ),ctx);
  assert.deepEqual(plain(await ctx.readWorkbookFillStyles(null,null)),["","#E2EFD9","#E2EFD9","#CCFFCC","","#F1F7EC"]);
});

test("cell fill positions survive layout cropping and inserted rows", () => {
  const ctx=vm.createContext({});
  for (const name of ["columnIndex","cropCurriculumSheet","insertImportedPlanLayoutRow","curriculumCellFill"]) {
    const start=frontend.indexOf(`function ${name}(`),next=frontend.indexOf("\n    function ",start+1);
    vm.runInContext(frontend.slice(start,next),ctx);
  }
  const cropped=ctx.cropCurriculumSheet({name:"표",rows:[[],["","과목","학기"],["","A",3],["","B",""]],
    layout:{cellFills:{"2:2":"#E2EFD9"},mergedRanges:["C3:C4"],columnWidths:[],rowHeights:{}}});
  assert.equal(cropped.cellFills["1:1"],"#E2EFD9");
  assert.equal(ctx.curriculumCellFill(cropped,2,1),"#E2EFD9");
  const inserted=ctx.insertImportedPlanLayoutRow(cropped,1,["",""]);
  assert.equal(inserted.cellFills["2:1"],"#E2EFD9");
  assert.equal(ctx.curriculumCellFill(inserted,3,1),"#E2EFD9");
});

test("semester-qualified result imports retain separate courses, credits and semester keys", () => {
  const ctx=vm.createContext({collectApplicationSubjects:()=>({"2":[{subject:"수학",semester:"1·2",credit:3,area:"수학"}],"3":[]})});
  vm.runInContext(functionSource("function mergeApplications(","function parseApplicationRoster("),ctx);
  const common={grade:"1",classroom:"1",number:"1",name:"가상",studentId:"20260001"};
  const result=ctx.mergeApplications([{...common,selections:["수학 (1학기)","수학 (2학기)"]}]);
  assert.deepEqual(plain(result.errors),[]);
  assert.deepEqual(plain(result.students[0].selections.map((c)=>c.semesterKey)),["1","2"]);
  assert.equal(result.students[0].totalCredits,6);
  assert.equal(result.students[0].studentId,"20260001");
  const legacy=ctx.mergeApplications([{...common,selections:["수학"]}]);
  assert.equal(legacy.courses.length,1);
  assert.deepEqual(plain(legacy.errors),[]);
});

test("year rollover archives student selections and school-designated courses once by student ID", () => {
  const start = frontend.indexOf("function historyRecordKey(");
  const end = frontend.indexOf("\n    function certificateMarkup(", start);
  const ctx = vm.createContext({
    state: {
      priorCourseHistory: [],
      historyArchivedYears: {},
      students: [
        { studentId: "20260001", grade: "1", selections: [
          { name: "선택 수학", credits: 3, category: "수학", semesterKey: "1" }
        ] },
        { grade: "1", selections: [] },
      ],
      curriculumPlanAcademicYear: "2027",
      curriculumPlan: [{
        grade: "2", division: "학교 지정 교육과정", subject: "다음 연도 과목",
        area: "영어", sem11: 3,
      }],
      curriculumPlansByYear: {
        "2026": [{
          grade: "2", division: "학교 지정 교육과정", subject: "학교 영어",
          area: "영어", sem11: 3,
        }]
      },
    },
    CURRICULUM_SEMESTER_FIELDS: ["sem11", "sem12", "sem21", "sem22", "sem31", "sem32"],
    normalizeCurriculumDivision: (value) => value,
  });
  vm.runInContext(frontend.slice(start, end), ctx);
  const archived = ctx.archiveCurrentAcademicYear("2026", "2027");
  assert.deepEqual(plain(archived), { archived: 2, skipped: 1 });
  assert.deepEqual(plain(ctx.state.priorCourseHistory.map((record) => [
    record.studentId, record.schoolYear, record.grade, record.courseName, record.credit
  ])), [
    ["20260001", "2026", "2", "선택 수학", 3],
    ["20260001", "2026", "2", "학교 영어", 3],
  ]);
  assert.deepEqual(plain(ctx.archiveCurrentAcademicYear("2026", "2027")), { archived: 0, skipped: 0 });
});

test("cloud aggregation updates its own round, clears rollback results and preserves overrides", () => {
  const state={currentRound:"2",rounds:{"1":{students:[],classOverrides:{"app0":2}},
    "2":{students:[{id:"existing"}],courses:[]}},students:[{id:"existing"}],courses:[]};
  let saves=0,renders=0;
  const elements=new Map();
  const ctx=vm.createContext({state,normalizeGradeGroupNames:normalizeGradeGroupNamesForTest,$:(id)=>{
    if(!elements.has(id)) elements.set(id,{textContent:"",disabled:false});
    return elements.get(id);
  },prepareAcademicYearImport(){},syncActiveRound(){},persistState(){saves++;},renderRoundStatus(){},
    applyClassFilterOptions(){},renderRoster(){renders++;},renderPreview(){},
    renderSemesterClassifier(){},renderAggregate(){},
  });

  vm.runInContext(functionSource("function mergeApplications(", "function parseApplicationRoster("),ctx);
  vm.runInContext(functionSource("function applyCloudApplicationResults(", "function storeDeveloperGradeResults("),ctx);
  const subjects={"2":[{subject:"A",semester:"1",credit:3}],"3":[]};
  const entries=[{grade:"1",classroom:"1",number:"1",name:"가상",selections:["A"]}];
  ctx.applyCloudApplicationResults("1",entries,subjects);
  assert.equal(state.currentRound,"2");
  assert.equal(state.students[0].id,"existing");
  assert.equal(state.rounds["1"].students[0].totalCredits,3);
  assert.equal(state.rounds["1"].classOverrides.app0,2);
  state.currentRound="1";
  ctx.applyCloudApplicationResults("1",[],subjects);
  assert.equal(state.students.length,0);
  assert.equal(state.rounds["1"].students.length,0);
  assert.equal(renders,1);
  assert.equal(saves,2);
  assert.throws(()=>ctx.applyCloudApplicationResults("1",[{...entries[0],selections:["unknown"]}],subjects),/연동 실패/);
  assert.equal(saves,2);
});

test("Excel data export uses text cells for codes and formula-like input", () => {
  let files,download;
  const ctx=vm.createContext({
    xmlEscape:(value)=>String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"),
    columnName:(index)=>String.fromCharCode(65+index),
    createXlsxBlob:(value)=>{files=value;return {};},
    URL:{createObjectURL:()=>"blob",revokeObjectURL(){}},
    document:{createElement:()=>({click(){download=this.download;}})},setTimeout(){},
  });
  vm.runInContext(functionSource("function downloadRowsXlsx(", "function normalizeApplicationServerUrl("),ctx);
  ctx.downloadRowsXlsx([["신청코드","성명"],["001234","=HYPERLINK(\"bad\")"]],"codes.xlsx");
  assert.equal(download,"codes.xlsx");
  assert.match(files["xl/worksheets/sheet1.xml"],/t="inlineStr".*001234/s);
  assert.ok(!files["xl/worksheets/sheet1.xml"].includes("<f>"));
});

test("uploaded courses resolve application groups by promoted grade and explicit semester without guessing", () => {
  let groups=[
    {grade:"2",semester:"1",name:"과학 선택",courses:["물리학","실험 (1학기)"]},
    {grade:"2",semester:"2",name:"2학기 선택",courses:["실험 (2학기)"]},
    {grade:"3",semester:"2",name:"3학년 선택",courses:["물리학"]},
  ];
  const ctx=vm.createContext({getApplicationGroupSettings:()=>groups,
    parseSemesterFromCourseName:(name)=>String(name).match(/([12])학기/)?.[1]||"",
    state:{groupAssignments:{},semesterAssignments:{}},
    resolveSemesterKey:(c)=>c.semesterKey||"",
    resolveCourseCategoryForOutput:()=>"미분류"});
  vm.runInContext(functionSource("function applicationGroupForCourse(", "function courseIndexByColumn("),ctx);
  assert.equal(ctx.courseGroupLabel({name:"물리학(진로)",column:4},"1"),"1학기 과학 선택");
  assert.equal(ctx.courseGroupLabel({name:"물리학",column:4},"2"),"2학기 3학년 선택");
  assert.equal(ctx.applicationGroupForCourse({name:"실험"},"1"),null);
  assert.equal(ctx.applicationGroupForCourse({name:"없는 과목"},"1"),null);
  assert.equal(ctx.applicationGroupForCourse({name:"물리학(3학년)"},"1"),null);
  assert.deepEqual(plain(ctx.applicationGroupForCourse({
    name:"물리학", applicationGroups:{"1":{name:"저장된 이전 그룹",semester:"2"}}
  },"1")), {name:"과학 선택",semester:"1"});
  groups=[{grade:"2",semester:"2",name:"2학기 선택",courses:["물리학"]}];
  assert.deepEqual(plain(ctx.applicationGroupForCourse({
    name:"물리학",semesterKey:"1",applicationGroups:{"1":{name:"저장된 이전 그룹",semester:"1"}}
  },"1")), {name:"2학기 선택",semester:"2"});
  groups=[
    {grade:"2",semester:"1",name:"과학 선택",courses:["물리학"]},
    {grade:"2",semester:"2",name:"2학기 선택",courses:["물리학"]},
  ];
  assert.deepEqual(plain(ctx.applicationGroupForCourse({name:"물리학",semesterKey:"2"},"1")),
    {name:"2학기 선택",semester:"2"});
  assert.equal(ctx.applicationGroupForCourse({name:"물리학"},"1"),null);
  groups=[
    {grade:"2",semester:"1",name:"과학 선택",courses:["물리학","실험 (1학기)"]},
    {grade:"2",semester:"2",name:"2학기 선택",courses:["실험 (2학기)"]},
    {grade:"3",semester:"2",name:"3학년 선택",courses:["물리학"]},
  ];
  assert.equal(ctx.courseGroupLabel({name:"실험 (2학기)",column:5},"1"),"2학기 2학기 선택");
  const course={name:"물리학",column:4};
  const data={courses:[course],students:[{grade:"1",selections:[{...course}]}]};
  assert.deepEqual([...ctx.classifyApplicationRecords(data)],[]);
  assert.equal(data.students[0].selections[0].applicationGroups["1"].name,"과학 선택");
  groups=[];
  assert.equal(ctx.courseGroupLabel(data.students[0].selections[0],"1"),"1학기 과학 선택");
  groups=[{grade:"2",semester:"1",name:"과학 선택",courses:["다른 과목"]}];
  assert.equal(ctx.applicationGroupForCourse({
    name:"물리학",applicationGroups:{"1":{name:"오래된 그룹",semester:"1"}}
  },"1"),null);
  groups=[];
  assert.deepEqual(plain(ctx.applicationGroupForCourse({
    name:"물리학",applicationGroups:{"1":{name:"저장된 그룹",semester:"2"}}
  },"1")),{name:"저장된 그룹",semester:"2"});
  ctx.state.groupAssignments["4"]="manual";
  assert.equal(ctx.courseGroupLabel(course,"1"),"미분류");
});

test("certificate preview uses the saved grade-specific application group before an unassigned fallback", () => {
  const ctx=vm.createContext({
    state:{groupAssignments:{},semesterAssignments:{}},
    getApplicationGroupSettings:()=>[],
    resolveSemesterKey:()=>"",
    resolveCourseCategoryForOutput:()=>"미분류",
    applicationGroupForCourse:()=>({name:"융합탐구군",semester:"1"}),
  });
  vm.runInContext(functionSource("function courseGroupLabel(", "function courseBelongsToCurrentGrade("),ctx);
  assert.equal(ctx.courseGroupLabel({
    name:"물리학 실험",column:7,applicationGroups:{"1":{name:"융합탐구군",semester:"1"}}
  },"1"),"1학기 융합탐구군");
});

test("certificate preview and print show both semester groups without duplicating selections or credits", () => {
  const ctx=vm.createContext({
    state:{curriculumPlan:[],groupAssignments:{},semesterAssignments:{}},
    getApplicationGroupSettings:()=>[
      {grade:"3",semester:"2",name:"과학 B",courses:["기후변화와 환경생태(2학기)"]},
      {grade:"3",semester:"1",name:"과학 A",courses:["기후변화와 환경생태(1학기)"]},
    ],
    parseSemesterFromCourseName:(name)=>String(name).match(/([12])학기/)?.[1]||"",
    resolveSemesterKey:(course)=>ctx.state.semesterAssignments[course.column] || course.semesterKey || "",
    resolveCourseCategoryForOutput:()=>"미분류",
    studentHistory:()=>[],
    isCoreCourse:()=>false,
    escapeHtml:(value)=>String(value),
    $:()=>({value:""}),
  });
  vm.runInContext(functionSource("function applicationGroupForCourse(", "function courseIndexByColumn("),ctx);
  vm.runInContext(functionSource("function certificateMarkup(", "function renderPreview("),ctx);
  const course={column:"climate",name:"기후변화와 환경생태",credits:3};
  const student={grade:"2",classroom:"1",number:"1",name:"가상학생",selections:[course],totalCredits:3};
  for (const printMode of [false,true]) {
    const markup=ctx.certificateMarkup(student,printMode);
    assert.match(markup,/1학기 과학 A \/ 2학기 과학 B/);
    assert.doesNotMatch(markup,/미분류/);
    assert.equal((markup.match(/class="course-cell">기후변화와 환경생태/g)||[]).length,1);
    assert.match(markup,/총 1과목\(3학점\)/);
  }
  assert.equal(ctx.courseGroupLabel({...course,semesterKey:"2"},"2"),"2학기 과학 B");
  assert.deepEqual(plain(ctx.applicationGroupForCourse({
    ...course,name:"기후변화와 환경생태(2학기)",semesterKey:"1·2",
  },"2")),{name:"과학 B",semester:"2"});
  ctx.state.semesterAssignments.climate="1";
  assert.equal(ctx.courseGroupLabel(course,"2"),"1학기 과학 A");
  delete ctx.state.semesterAssignments.climate;
  ctx.state.curriculumPlan=[{grade:"3",subject:course.name,sem31:"",sem32:3}];
  assert.equal(ctx.courseGroupLabel(course,"2"),"2학기 과학 B");
  assert.equal(ctx.courseGroupLabel({...course,semesterKey:"1·2"},"2"),"2학기 과학 B");
  ctx.state.groupAssignments.climate="직접 지정";
  ctx.resolveCourseCategoryForOutput=()=>"직접 지정";
  assert.equal(ctx.courseGroupLabel(course,"2"),"직접 지정");
  assert.equal(student.selections.length,1);
  assert.equal(student.totalCredits,3);
});

test("round deletion retains curriculum, other rounds and their classification settings", () => {
  const other={students:[{id:"other"}],courses:[{column:3}],fileName:"other.xlsx",classOverrides:{3:2},
    semesterAssignments:{3:"2"},groupAssignments:{3:"2학기 보존"},customGroupNames:["보존"]};
  const plan=[{subject:"보존할 편제표"}],layout={rows:[["보존"]]};
  const state={currentRound:"1",rounds:{"1":{students:[{id:"delete"}]},"2":other,"3":null},
    roundClosures:{"1":{closed:"closed"},"2":{keep:"open"}},students:[{id:"delete"}],courses:[],
    fileName:"delete.xlsx",classOverrides:{},semesterAssignments:{},groupAssignments:{},customGroupNames:[],
    curriculumPlan:plan,curriculumImportedLayout:layout,applicationImportRevision:0};
  const elements=new Map();let saves=0;
  const ctx=vm.createContext({state,normalizeGradeGroupNames:normalizeGradeGroupNamesForTest,
    targetGradeCurrentGrade:(grade)=>String(Number(grade)-1),
    $:(id)=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);},
    applyClassFilterOptions(){},renderRoster(){},renderPreview(){},renderSemesterClassifier(){},
    renderAggregate(){},renderRoundStatus(){},renderWorkflowLayout(){},persistState(){saves++;}});
  vm.runInContext(functionSource("function syncActiveRound(", "function persistState("),ctx);
  vm.runInContext(functionSource("function switchRound(", "function resetWorkspace("),ctx);
  ctx.clearApplicationRound();
  assert.equal(state.rounds["1"],null);
  assert.equal(state.rounds["2"],other);
  assert.equal(state.curriculumPlan,plan);
  assert.equal(state.curriculumImportedLayout,layout);
  assert.deepEqual(state.roundClosures["2"],{keep:"open"});
  assert.equal(state.currentRound,"1");
  assert.equal(state.students.length,0);
  ctx.switchRound("2");
  assert.equal(state.students[0].id,"other");
  assert.equal(state.groupAssignments["3"],"2학기 보존");
  assert.equal(state.semesterAssignments["3"],"2");
  assert.equal(saves,2);
});

test("developer result Excel imports both layouts and rejects invalid or expired uploads without clearing data", async () => {
  let developer = true, completion, workbook, imported, persisted = 0;
  const existing = [{id:"existing"}];
  const state = {currentRound:"2", students:existing};
  const elements = new Map(), status = {style:{}};
  const ctx = vm.createContext({
    state,status, isDeveloperAccount:()=>developer,
    $:(id)=>{if(!elements.has(id)) elements.set(id,{});return elements.get(id);},
    FileReader:class { readAsArrayBuffer(){completion=this.onload();} },
    parseWorkbook:async()=>workbook,
    collectApplicationSubjects:()=>({"2":[{subject:"수학",semester:"1",credit:3}],"3":[]}),
    mergeApplications:(entries)=>{imported=plain(entries);return {errors:[],students:entries,courses:[]};},
    storeDeveloperGradeResults:(data)=>{state.students=data.students;persisted++;},
    createRecords:()=>({students:[{id:"wide",grade:"1"}],courses:[]}),
    classifyApplicationRecords:()=>[],
    normalizeCourses:(courses)=>courses,
    applyClassFilterOptions(){}, renderRoster(){},renderPreview(){},renderSemesterClassifier(){},
    renderAggregate(){},renderRoundStatus(){},persistState(){persisted++;},
  });
  vm.runInContext(functionSource("function splitGoogleFormSelections(", "function xmlEscape("),ctx);
  vm.runInContext(functionSource("function handleWorkbook(", "function handleCurriculumWorkbook("),ctx);
  workbook=[{rows:[["차수","학년","반","번호","성명","선택과목"],["2","1","1","1","가상","수학"]]}];
  ctx.handleWorkbook({name:"results.xlsx"}); await completion;
  assert.deepEqual(imported[0].selections,["수학"]);
  state.students=existing;
  imported=null;
  workbook[0].rows[1][5]="수학, 알 수 없는 과목";
  ctx.handleWorkbook({name:"results.xlsx"}); await completion;
  assert.match(status.textContent,/편제표에 없는/);
  assert.equal(imported,null);
  assert.equal(state.students,existing);
  workbook=[{rows:[["과목별 결과"]]}];
  ctx.handleWorkbook({name:"wide.xlsx"}); await completion;
  assert.equal(state.students[0].id,"wide");
  assert.equal(persisted,2);
  state.applicationMenuGrade="2";
  ctx.handleWorkbook({name:"wrong-grade.xlsx"}); await completion;
  assert.match(status.textContent,/현재 2학년 학생이 없는/);
  assert.equal(persisted,2);
  state.applicationMenuGrade="1";
  workbook=[{rows:[["차수","학년","반","번호","성명","선택과목"],
    ["2","1","1","1","가상","수학"],["2","2","1","1","다른 학년","다른 과목"]]}];
  ctx.handleWorkbook({name:"mixed.xlsx"}); await completion;
  assert.equal(imported.length,1);
  assert.equal(imported[0].grade,"1");
  assert.equal(persisted,3);
  ctx.parseWorkbook=async()=>{state.applicationMenuGrade="2";return workbook;};
  ctx.handleWorkbook({name:"changed-grade.xlsx"}); await completion;
  assert.match(status.textContent,/학년 메뉴가 바뀌었/);
  assert.equal(persisted,3);
  state.applicationMenuGrade="1";
  developer=false;
  ctx.handleWorkbook({name:"forbidden.xlsx"});
  assert.match(status.textContent,/개발자 계정/);
  assert.equal(persisted,3);
  developer=true;
  ctx.parseWorkbook=async()=>{developer=false;return workbook;};
  ctx.handleWorkbook({name:"expired.xlsx"}); await completion;
  assert.match(status.textContent,/다시 로그인/);
  assert.equal(persisted,3);
});

test("developer results replace only the chosen grade and retain courses, settings and round storage", () => {
  const state={currentRound:"1",students:[],courses:[],rounds:{"1":null,"2":{students:[{id:"other-round"}]}}};
  const ctx=vm.createContext({
    normalizeGradeGroupNames:normalizeGradeGroupNamesForTest,
    prepareAcademicYearImport(){},
    state,$:()=>({}),normalizeCourses:(courses)=>courses,
    applyClassFilterOptions(){},renderRoster(){},renderPreview(){},renderSemesterClassifier(){},renderAggregate(){},
    renderRoundStatus(){},
    persistState(){ctx.syncActiveRound();},
  });
  vm.runInContext(functionSource("function syncActiveRound(", "function persistState("),ctx);
  vm.runInContext(functionSource("function storeDeveloperGradeResults(", "function splitGoogleFormSelections("),ctx);
  const data=(grade,name)=>({
    courses:[{column:4,name:"공통 이름",credits:3},{column:5,name:"미신청 과목",credits:3}],
    students:[{id:`${grade}-${name}`,grade,name,classroom:"1",number:"1",totalCredits:3,
      selections:[{column:4,name:"공통 이름",credits:3}]}]
  });
  ctx.storeDeveloperGradeResults(data("1","첫학생"),"1학년.xlsx","1");
  const firstColumn=state.students[0].selections[0].column;
  state.classOverrides[firstColumn]=2;
  state.classOverrides[`1:${firstColumn}`]=4;
  state.semesterAssignments[firstColumn]="1";
  state.groupAssignments[firstColumn]="유지할 그룹";
  ctx.storeDeveloperGradeResults(data("2","둘째학생"),"2학년.xlsx","2");
  assert.deepEqual(plain(state.students.map((s)=>s.grade)),["1","2"]);
  assert.equal(state.courses.length,4); // Keep zero-enrollment courses in aggregate reports.
  assert.equal(new Set(state.courses.map((course)=>course.column)).size,4);
  assert.equal(state.classOverrides[firstColumn],2);
  assert.equal(state.classOverrides[`1:${firstColumn}`],4);
  assert.equal(state.groupAssignments[firstColumn],"유지할 그룹");
  const secondColumn=state.students[1].selections[0].column;
  state.classOverrides[secondColumn]=3;
  ctx.storeDeveloperGradeResults(data("1","새학생"),"1학년_수정.xlsx","1");
  assert.deepEqual(plain(state.students.map((s)=>s.name)),["새학생","둘째학생"]);
  assert.equal(state.classOverrides[firstColumn],undefined);
  assert.equal(state.classOverrides[`1:${firstColumn}`],undefined);
  assert.equal(state.classOverrides[secondColumn],3);
  assert.equal(state.courses.length,4);
  assert.deepEqual(plain(state.rounds["1"].gradeFiles),{"1":"1학년_수정.xlsx","2":"2학년.xlsx"});
  const restored=plain(state.rounds["1"]);
  assert.deepEqual(restored.students.map((s)=>s.grade),["1","2"]);
  assert.equal(state.rounds["2"].students[0].id,"other-round");
  const previous=plain(state);
  assert.throws(()=>ctx.storeDeveloperGradeResults(data("2","잘못된학년"),"wrong.xlsx","1"),/학생이 없는/);
  assert.deepEqual(plain(state),previous);
});

test("aggregate reports and course boards isolate second- and third-year data", () => {
  const ctx=vm.createContext({
    state:{
      customGroupNames:[],
      customGroupNamesByGrade:{"2":["2학년 반 A"],"3":["3학년 반 B"]},
      activeDataSchoolYear:"2026",
      curriculumPlanAcademicYear:"2026",
      curriculumPlan:[
        {grade:"2",subject:"2학년 과목"},
        {grade:"3",subject:"3학년 과목"},
      ],
    },
    normalizeGroupName:(value)=>String(value??"").trim(),
    UNASSIGNED_GROUP:"미분류",
    applicationGroupForCourse:()=>null,
    parseAssignedGroupLabel:()=>({semesterKey:"",category:""}),
  });
  vm.runInContext(functionSource("function normalizeRomanNumerals(", "function courseIndexByColumn("),ctx);
  vm.runInContext(functionSource("function aggregateRecords(", "function currentStudent("),ctx);
  const students=[
    {grade:"1",classroom:"1",selections:[{column:"second"}]},
    {grade:"2",classroom:"1",selections:[{column:"third"}]},
  ];
  const courses=[
    {column:"second",name:"2학년 과목",applicationCurrentGrade:"1"},
    {column:"third",name:"3학년 과목",applicationCurrentGrade:"1"},
  ];
  const result=ctx.aggregateRecords(students,courses,90,110,{},{},{});
  assert.deepEqual(plain(result.reports.map(({summary,semesters})=>({
    grade:summary.grade,
    courses:semesters.flatMap((semester)=>semester.groups.flatMap((group)=>group.courses.map((course)=>course.name)))
  }))),[
    {grade:"1",courses:["2학년 과목"]},
    {grade:"2",courses:["3학년 과목"]},
  ]);
  assert.deepEqual(plain(ctx.coursesForCurrentGrade("1",courses,students).map((course)=>course.name)),["2학년 과목"]);
  assert.deepEqual(plain(ctx.coursesForCurrentGrade("2",courses,students).map((course)=>course.name)),["3학년 과목"]);
  assert.deepEqual(plain(ctx.gradeGroupNames("2")),["2학년 반 A"]);
  assert.deepEqual(plain(ctx.gradeGroupNames("3")),["3학년 반 B"]);
  const namedGradeCourse={column:"named",name:"학년 표시 과목(3학년)",applicationCurrentGrade:"1"};
  assert.deepEqual(plain(ctx.coursesForCurrentGrade("1",[namedGradeCourse],students)),[]);
  assert.deepEqual(plain(ctx.coursesForCurrentGrade("2",[namedGradeCourse],students)),[namedGradeCourse]);
  assert.equal(ctx.curriculumCourseNameKey("선택 과목 2"),ctx.curriculumCourseNameKey(" 선택   과목 Ⅱ "));
  assert.equal(ctx.curriculumCourseNameKey("선택 과목 (Ⅲ 학년)"),ctx.curriculumCourseNameKey("선택 과목 (3학년)"));
  assert.equal(ctx.normalizeRomanNumerals("BIO CIVIC"),"BIO CIVIC");
  const romanGradeCourse={column:"roman",name:"학년 표시 과목(Ⅲ학년)",applicationCurrentGrade:"1"};
  assert.deepEqual(plain(ctx.coursesForCurrentGrade("1",[romanGradeCourse],students)),[]);
  assert.deepEqual(plain(ctx.coursesForCurrentGrade("2",[romanGradeCourse],students)),[romanGradeCourse]);
});

test("aggregate uses grade-specific application groups despite numeral and spacing differences", () => {
  const ctx=vm.createContext({
    state:{activeDataSchoolYear:"2026",curriculumPlan:[],groupAssignments:{},semesterAssignments:{}},
    getApplicationGroupSettings:()=>[
      {grade:"2",semester:"1",name:"수학 선택군",courses:["심화 과목 Ⅱ"]},
    ],
    parseSemesterFromCourseName:()=>"",
    normalizeGroupName:(value)=>String(value??"").trim(),
    UNASSIGNED_GROUP:"미분류",
    parseAssignedGroupLabel:()=>({semesterKey:"",category:""}),
  });
  vm.runInContext(functionSource("function applicationGroupForCourse(", "function courseIndexByColumn("),ctx);
  vm.runInContext(functionSource("function aggregateRecords(", "function currentStudent("),ctx);
  const course={column:"c1",name:"심화 과목 2",applicationCurrentGrade:"1"};
  const students=[{grade:"1",classroom:"1",selections:[{column:"c1"}]}];
  const result=ctx.aggregateRecords(students,[course],90,110,{},{},{});
  assert.deepEqual(plain(result.reports[0].semesters.map((semester)=>({
    name:semester.name,
    categories:semester.groups.map((group)=>group.category),
  }))),[{name:"2학년 1학기",categories:["수학 선택군"]}]);
});

test("aggregate restores after group scripts load and uses the curriculum semester for semester-zero groups", () => {
  assert.match(frontend,/document\.addEventListener\("DOMContentLoaded",\s*\(\) => \{\s*if \(!showStudentApplicationEntry\(\)\) restorePersistedState\(\);\s*\}, \{ once: true \}\);/);
  const ctx=vm.createContext({
    state:{
      activeDataSchoolYear:"2026",curriculumPlanAcademicYear:"2026",
      curriculumPlan:[{
        grade:"3",subject:"기후변화와 환경생태",sem31:3,sem32:"",
      }],
      groupAssignments:{},semesterAssignments:{},
    },
    getApplicationGroupSettings:()=>[
      {grade:"3",semester:"0",name:"과학 선택군",courses:["기후변화와 환경생태"]},
    ],
    curriculumCourseNameKey:(value)=>String(value??"").replace(/\s+/g,""),
    parseSemesterFromCourseName:()=>"",
    normalizeGroupName:(value)=>String(value??"").trim(),
    UNASSIGNED_GROUP:"미분류",
    parseAssignedGroupLabel:()=>({semesterKey:"",category:""}),
  });
  vm.runInContext(functionSource("function curriculumSemesterForCourse(", "function courseBelongsToCurrentGrade("),ctx);
  vm.runInContext(functionSource("function applicationGroupForCourse(", "function courseIndexByColumn("),ctx);
  vm.runInContext(functionSource("function aggregateRecords(", "function currentStudent("),ctx);
  const course={column:"climate",name:"기후변화와 환경생태",applicationCurrentGrade:"2"};
  const result=ctx.aggregateRecords(
    [{grade:"2",classroom:"1",selections:[{column:"climate"}]}],[course],90,110,{},{},{});
  assert.deepEqual(plain(result.reports[0].semesters.map((semester)=>({
    name:semester.name,
    categories:semester.groups.map((group)=>group.category),
  }))),[{name:"3학년 1학기",categories:["과학 선택군"]}]);
});

test("aggregate separates semester-specific groups sharing an unsuffixed course name and multiplies planned classes by choice count", () => {
  const ctx=vm.createContext({
    state:{
      activeDataSchoolYear:"2026",curriculumPlanAcademicYear:"2026",curriculumPlan:[],
      groupAssignments:{},semesterAssignments:{},
    },
    getApplicationGroupSettings:()=>[
      {grade:"3",semester:"1",name:"1학기 과학군",count:2,courses:["기후변화와 환경생태 (1학기)"]},
      {grade:"3",semester:"2",name:"2학기 과학군",count:1,courses:["기후변화와 환경생태 (2학기)"]},
    ],
    parseSemesterFromCourseName:(name)=>String(name).match(/([12])학기/)?.[1]||"",
    normalizeGroupName:(value)=>String(value??"").trim(),
    UNASSIGNED_GROUP:"미분류",
    parseAssignedGroupLabel:()=>({semesterKey:"",category:""}),
  });
  vm.runInContext(functionSource("function curriculumSemesterForCourse(", "function courseBelongsToCurrentGrade("),ctx);
  vm.runInContext(functionSource("function courseBelongsToCurrentGrade(", "function coursesForCurrentGrade("),ctx);
  vm.runInContext(functionSource("function applicationGroupForCourse(", "function courseIndexByColumn("),ctx);
  vm.runInContext(functionSource("function aggregateRecords(", "function currentStudent("),ctx);
  const course={column:"climate",name:"기후변화와 환경생태",applicationCurrentGrade:"2"};
  const students=[{grade:"2",classroom:"1",selections:[{column:"climate"}]}];
  const result=ctx.aggregateRecords(students,[course],90,110,{},{},{},{"3":4});
  assert.deepEqual(plain(result.reports[0].semesters.map((semester)=>({
    name:semester.name,
    groups:semester.groups.map((group)=>({
      category:group.category,
      totalClasses:group.totalClasses,
      courses:group.courses.map((item)=>item.name),
    })),
  }))),[
    {name:"3학년 1학기",groups:[{category:"1학기 과학군",totalClasses:8,courses:["기후변화와 환경생태"]}]},
    {name:"3학년 2학기",groups:[{category:"2학기 과학군",totalClasses:4,courses:["기후변화와 환경생태"]}]},
  ]);
});

test("aggregate and class-assignment views provide separate grade tabs", () => {
  assert.match(html,/id="certificateGradeTabs"[\s\S]*data-certificate-grade="2"[\s\S]*data-certificate-grade="3"/);
  assert.match(html,/id="aggregateGradeTabs"[\s\S]*data-aggregate-grade="2"[\s\S]*data-aggregate-grade="3"/);
  assert.match(html,/id="classifierGradeTabs"[\s\S]*data-classifier-grade="2"[\s\S]*data-classifier-grade="3"/);
});

test("aggregation keeps same-name groups independent and exports planned totals rather than course override sums", () => {
  const settings=[
    {id:"a",grade:"2",semester:"1",name:"선택군",count:1,courses:["A"]},
    {id:"b",grade:"2",semester:"1",name:"선택군",count:2,courses:["B","C"]},
    {id:"third",grade:"3",semester:"2",name:"선택군",count:1,courses:["D"]},
  ];
  const ctx=vm.createContext({
    state:{curriculumPlan:[],groupAssignments:{},semesterAssignments:{}},
    getApplicationGroupSettings:()=>settings,
    parseSemesterFromCourseName:()=>"",
    normalizeGroupName:(value)=>String(value??"").trim(),
    UNASSIGNED_GROUP:"미분류",
    parseAssignedGroupLabel:()=>({semesterKey:"",category:""}),
    $:()=>({value:""}),
  });
  vm.runInContext(functionSource("function applicationGroupForCourse(", "function courseIndexByColumn("),ctx);
  vm.runInContext(functionSource("function aggregateRecords(", "function currentStudent("),ctx);
  vm.runInContext(functionSource("function xmlEscape(", "function createStylesXml("),ctx);
  const students=[
    {grade:"1",classroom:"1",selections:[{column:"a"},{column:"b"}]},
    {grade:"2",classroom:"1",selections:[{column:"d"}]},
  ];
  const courses=[
    {column:"a",name:"A",applicationCurrentGrade:"1"},
    {column:"b",name:"B",applicationCurrentGrade:"1"},
    {column:"d",name:"D",applicationCurrentGrade:"2"},
  ];
  const result=ctx.aggregateRecords(students,courses,90,110,{"1:a":9},{},{},{"2":4,"3":5});
  assert.deepEqual(plain(result.reports.map((report)=>report.semesters.flatMap((semester)=>
    semester.groups.map((group)=>group.totalClasses)))),[[4,8],[5]]);
  assert.equal(result.reports[0].semesters[0].groups[0].courses[0].classCount,9);
  const xml=ctx.createWorksheetXml(result.reports[0],90,110);
  assert.match(xml,/<c r="H8" s="9"><v>12<\/v><\/c>/);
});

test("six workflow menus reveal their matching panels without changing the selected round", () => {
  const elements=new Map();
  const element=()=>({attributes:{},hidden:false,textContent:"",
    setAttribute(name,value){this.attributes[name]=value;},
    classList:{states:{},toggle(name,value){this.states[name]=value;}},querySelector(){return element();}});
  const buttons=[...html.matchAll(/<button[^>]*data-workflow-step="(\d+)"([^>]*)>/g)].map((match)=>({
    ...element(),dataset:{workflowStep:match[1]}
  }));
  for (const button of buttons) button.classList.toggle=(name,value)=>{button.hidden=value;};
  const workflowSteps={...element(),querySelectorAll:()=>buttons};
  const state={workflowStep:1,currentRound:"4"};
  let saved=0;
  const ctx=vm.createContext({state,workflowSteps,
    $:(id)=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);},
    renderCurriculumStep(){},renderRoundStatus(){},renderApplicationSubjects(){},
    renderClosurePanel:(round)=>{ctx.closureRound=round;},renderRetakePanel(){},
    renderPreview:()=>{ctx.previewRefreshed=true;},
    renderAggregate:()=>{ctx.aggregateRefreshed=true;},
    renderSemesterClassifier:()=>{ctx.classifierRefreshed=true;},
    persistState:()=>{saved++;}});
  vm.runInContext(functionSource("function renderWorkflowLayout(", "function switchRound("),ctx);
  ctx.renderWorkflowLayout();
  assert.equal(buttons.length,6);
  assert.equal(elements.get("#workflowStep1Panel").classList.states.hidden,false);
  ctx.switchWorkflowStep(3);
  assert.equal(elements.get("#certificatePanel").classList.states.hidden,false);
  assert.equal(ctx.previewRefreshed,true);
  ctx.switchWorkflowStep(4);
  assert.equal(elements.get("#aggregatePanel").classList.states.hidden,false);
  assert.equal(elements.get("#closurePanel").classList.states.hidden,false);
  assert.equal(elements.get("#retakePanel").classList.states.hidden,false);
  assert.equal(ctx.closureRound,"4");
  assert.equal(ctx.aggregateRefreshed,true);
  ctx.switchWorkflowStep(5);
  assert.equal(elements.get("#classifierPanel").classList.states.hidden,false);
  assert.equal(ctx.classifierRefreshed,true);
  ctx.switchWorkflowStep(6);
  assert.equal(elements.get("#workflowStep6Panel").classList.states.hidden,false);
  assert.equal(state.currentRound,"4");
  assert.ok(saved>0);
});

test("application rounds start at one and can be added sequentially beyond three", () => {
  const state={rounds:{"1":null,"3":{students:[{id:"preserved"}]}},roundClosures:{"1":{}},currentRound:"1"};
  const ctx=vm.createContext({state,switchRound:(round)=>{state.currentRound=round;}});
  vm.runInContext(functionSource("function applicationRoundNumbers(", "function switchRound("),ctx);
  assert.deepEqual(Array.from(ctx.applicationRoundNumbers()),["1","3"]);
  ctx.addApplicationRound();
  assert.deepEqual(Array.from(ctx.applicationRoundNumbers()),["1","3","4"]);
  assert.equal(state.currentRound,"4");
  assert.deepEqual(plain(state.roundClosures["4"]),{});
  assert.equal(state.rounds["3"].students[0].id,"preserved");
});

test("retake decisions follow course names when column IDs change between rounds", () => {
  const state={
    rounds:{
      "1":{courses:[{column:"old-a",name:"미적분",applicationCurrentGrade:"1"}]},
      "2":{courses:[
        {column:"new-a",name:"미적분",applicationCurrentGrade:"1"},
        {column:"new-b",name:"기하",applicationCurrentGrade:"1"}
      ],students:[{grade:"1",selections:[
        {column:"new-a",name:"미적분"},{column:"new-b",name:"기하"}
      ]}]}
    },
    roundClosures:{
      "1":{"1:old-a":"closed"},
      "2":{"1:new-a":"open","1:new-b":"closed"}
    }
  };
  const ctx=vm.createContext({state,applicationRoundNumbers:()=>["1","2"]});
  vm.runInContext(functionSource("function retakeTargets(", "function renderRetakePanel("),ctx);
  const result=ctx.retakeTargets();
  assert.equal(result.sourceRound,"2");
  assert.equal(result.rows.length,1);
  assert.deepEqual(Array.from(result.rows[0].courses),["기하"]);
});

test("retake workbook names its next round and escapes student data", () => {
  let files,filename;
  const ctx=vm.createContext({
    retakeTargets:()=>({sourceRound:"4",rows:[{
      student:{grade:"1",classroom:"1",number:"1",name:"가상 & 학생"},courses:["기하"],
    }]}),
    createXlsxBlob:(data)=>{files=data;return {};},
    createStylesXml:()=>"<styles/>",
    URL:{createObjectURL:()=>"blob:test",revokeObjectURL(){}},
    document:{createElement:()=>({click(){filename=this.download;}})},
    setTimeout:(callback)=>callback(),
  });
  vm.runInContext(functionSource("function xmlEscape(", "function createWorksheetXml("),ctx);
  vm.runInContext(functionSource("function downloadRetakeList(", "function collectApplicationSubjects("),ctx);
  ctx.downloadRetakeList();
  assert.equal(filename,"5차_수강신청_대상자(4차_기준).xlsx");
  assert.match(files["xl/workbook.xml"],/name="5차 대상자"/);
  assert.match(files["xl/worksheets/sheet1.xml"],/가상 &amp; 학생/);
});

test("removed legacy generators and templates cannot be accidentally shipped again", () => {
  assert.doesNotMatch(html,/driveServerTemplate/);
  assert.doesNotMatch(frontend,/function (?:buildApplicationPageHtml|buildAppsScriptCode|curriculumPlanTableHtml|handleApplicationFiles)\(/);
  for (const file of ["app.js","xlsx-parser.js","course-groups.js","curriculum-workbook.js","supabase-client.js"]) {
    new vm.Script(fs.readFileSync(path.join(__dirname,"..",file),"utf8"));
  }
});

test("existing school links accept only validated server endpoints without credentials", () => {
  const ctx = vm.createContext({ URL, URLSearchParams });
  vm.runInContext(functionSource("function normalizeApplicationServerUrl(", "function showStudentApplicationEntry("), ctx);
  const endpoint = "https://script.google.com/macros/s/Abc_123-xyz/exec";
  assert.equal(ctx.normalizeApplicationServerUrl(endpoint),endpoint);
  for (const bad of [
    endpoint + "?admin=secret", endpoint + "#key", endpoint.replace("/exec", "/dev"),
    endpoint.replace("https:", "http:"), endpoint.replace("script.google.com", "evil.example"),
    endpoint.replace("script.google.com", "script.google.com.evil.example"),
    endpoint.replace("script.google.com", "user@script.google.com"),
    "javascript:alert(1)", "not a url",
  ]) assert.throws(() => ctx.normalizeApplicationServerUrl(bad));
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
  vm.runInContext(functionSource("function normalizeApplicationServerUrl(", "function applyCloudApplicationResults("), ctx);
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
