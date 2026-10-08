const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { randomUUID } = require("node:crypto");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((source) => source.trim());
const frontend = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const workbookParser = fs.readFileSync(path.join(__dirname, "..", "xlsx-parser.js"), "utf8");
function functionSource(start, end) {
  return frontend.slice(frontend.indexOf(start), frontend.indexOf(end));
}
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("closure defaults open eligible courses and leave at-risk courses undecided, preserving manual decisions", () => {
  const elements = new Map(["#closureTitle", "#closureDescription", "#closureContent", "#openingPercent", "#divisionPercent"]
    .map((id) => [id, { value: id === "#openingPercent" ? "90" : "110" }]));
  const ctx = vm.createContext({
    $: (id) => elements.get(id),
    state: { rounds: { "1": { students: [], courses: [] } }, roundClosures: { "1": { "1:3": "", "1:4": "closed", "1:5": "open" } } },
    escapeHtml: String,
    aggregateRecords: () => ({ reports: [{ summary: { grade: "1", students: 350, openingLimit: 31.5 },
      semesters: [{ name: "1", groups: [{ courses: [
        { column: 1, name: "개설기준 일치", enrollment: 31.5 },
        { column: 2, name: "미달", enrollment: 5 },
        { column: 3, name: "수동 미정", enrollment: 100 },
        { column: 4, name: "수동 폐강", enrollment: 100 },
        { column: 5, name: "수동 개설", enrollment: 5 }
      ] }] }] }] })
  });
  vm.runInContext(functionSource("function renderClosurePanel(", "function retakeTargets("), ctx);
  ctx.renderClosurePanel("1");
  const markup = elements.get("#closureContent").innerHTML;
  const selections = [...markup.matchAll(/data-closure-key="([^"]+)"[\s\S]*?<option value="([^"]*)" selected/g)];
  assert.deepEqual(selections.map((match) => [match[1], match[2]]),
    [["1:1", "open"], ["1:2", ""], ["1:3", ""], ["1:4", "closed"], ["1:5", "open"]]);
  assert.match(frontend, /state\.roundClosures\[round\]\[key\] = select\.value/);
});

class Sheet {
  constructor(name) { this.name = name; this.rows = []; }
  setName(name) { this.name = name; return this; }
  appendRow(row) { this.rows.push(row); return this; }
  getDataRange() {
    return {
      getValues: () => this.rows.map((r) => [...r]),
      getDisplayValues: () => this.rows.map((r) => r.map(String)),
    };
  }
  getRange(row, col) {
    const set = (values) => {
      values.forEach((r, i) => {
        this.rows[row - 1 + i] ??= [];
        r.forEach((value, j) => { this.rows[row - 1 + i][col - 1 + j] = value; });
      });
      return range;
    };
    const range = {
      setNumberFormat: () => range,
      setValues: set,
      setValue: (value) => set([[value]]),
      getValue: () => this.rows[row - 1]?.[col - 1],
    };
    return range;
  }
}

function server() {
  const properties = new Map();
  const books = new Map();
  let locks = 0;
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key) => properties.get(key),
      setProperty: (key, value) => properties.set(key, value),
    }) },
    Utilities: { getUuid: randomUUID },
    Logger: { log() {} },
    LockService: { getScriptLock: () => ({
      waitLock() { locks++; }, releaseLock() { locks--; },
    }) },
    SpreadsheetApp: {
      create() {
        const id = String(books.size);
        const sheets = [new Sheet("Sheet1")];
        const book = {
          getId: () => id, getUrl: () => "https://example.invalid/" + id,
          getSheets: () => sheets,
          getSheetByName: (name) => sheets.find((s) => s.name === name),
          insertSheet(name) { const s = new Sheet(name); sheets.push(s); return s; },
        };
        books.set(id, book);
        return book;
      },
      openById: (id) => books.get(id),
    },
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: "ALLOWALL" },
      createHtmlOutput: (content) => ({
        content, frameMode: "DEFAULT",
        setXFrameOptionsMode(mode) { this.frameMode = mode; return this; },
      }),
    },
  });
  vm.runInContext(scripts[0], context);
  context.initializeCourseServer();
  return { context, key: properties.get("ADMIN_KEY"), properties, books, locks: () => locks };
}
function setup() {
  return {
    type: "course-application-setup", round: "2", schoolName: "가상학교", schoolYear: "2026",
    roster: [
      { grade: "1", classroom: "1", number: "1", name: "가상학생1" },
      { grade: "2", classroom: "2", number: "2", name: "가상학생2" },
    ],
    subjects: {
      "1": [],
      "2": [{ subject: "수학", credit: 3, semester: "1" }],
      "3": [{ subject: "과학", credit: 3, semester: "2" }],
    },
  };
}

test("all embedded scripts parse", () => {
  scripts.forEach((source) => new vm.Script(source));
  new vm.Script(frontend);
  new vm.Script(workbookParser);
});

test("roster supports aliases, sheet grades and multiple sheets", () => {
  const ctx = vm.createContext({});
  vm.runInContext(functionSource("function parseApplicationRoster(", "function downloadTextFile("), ctx);
  const result = ctx.parseApplicationRoster([
    { name: "명렬", rows: [["학년", "반", "번호", "성명"], [1, 2, 3, "가상학생1"], []] },
    { name: "2학년", rows: [["반", "출석번호", "학생명"], [2, 4, "가상학생2"]] },
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(plain(result[1]), { grade: "2", classroom: "2", number: "4", name: "가상학생2" });
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

test("roster parser accepts ten synthetic classes of 35 students", () => {
  const ctx = vm.createContext({});
  vm.runInContext(functionSource("function parseApplicationRoster(", "function downloadTextFile("), ctx);
  const sheets = Array.from({ length: 10 }, (_, classIndex) => ({
    name: `${classIndex + 1}반`,
    rows: [
      ["학년", "반", "번호", "이름"],
      ...Array.from({ length: 35 }, (_, numberIndex) => [
        "1", String(classIndex + 1), String(numberIndex + 1),
        `테스트학생${String(classIndex + 1).padStart(2, "0")}-${String(numberIndex + 1).padStart(2, "0")}`,
      ]),
    ],
  }));
  const roster = ctx.parseApplicationRoster(sheets);
  assert.equal(roster.length, 350);
  assert.deepEqual([...new Set(roster.map((student) => student.classroom))],
    Array.from({ length: 10 }, (_, index) => String(index + 1)));
  for (let classroom = 1; classroom <= 10; classroom++) {
    assert.equal(roster.filter((student) => student.classroom === String(classroom)).length, 35);
  }
  assert.equal(new Set(roster.map((student) => `${student.grade}:${student.classroom}:${student.number}`)).size, 350);
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
    ],
    mergedRanges: ["A1:A2", "B1:B2", "C1:D2", "E1:E2", "F1:F2",
      "G1:H1", "I1:J1", "K1:L1", "A4:A8", "G7:L7"],
    cellFills: {"3:8":"#E2EFD9","4:8":"#E2EFD9","5:9":"#E2EFD9","6:6":"#D6DCE4"},
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
    ["세계사", "사회와 문화", "물리학", "화학", "미디어 영어", "세계 문화와 영어", "물리학 실험"]);
  assert.equal(subjects["2"].find((c) => c.subject === "물리학 실험").semester, "1·2");
  assert.deepEqual(subjects["3"].map((c) => c.subject), ["주제 탐구 독서"]);
  assert.equal(subjects["3"][0].semester, "2");
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
  vm.runInContext(functionSource("function mergeApplications(", "function downloadApplicationForm("),ctx);
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

test("Google Form classified labels map back to original course names and accept older results", () => {
  const ctx=vm.createContext({});
  vm.runInContext(functionSource("function curriculumSelectionType(", "function importedPlanCourseContexts("),ctx);
  vm.runInContext(functionSource("function applicationCourseLabel(", "function renderApplicationSubjects("),ctx);
  vm.runInContext(functionSource("function splitGoogleFormSelections(", "async function handleGoogleFormsFile("),ctx);
  const subjects={"2":[{subject:"물리학 실험",type:"융합선택"},{subject:"경제",type:"진로선택"}]};
  const result=ctx.parseGoogleFormsRows([
    ["현재 학년","반","번호","이름","2학년 1학기 선택과목"],
    ["1학년","1","1","가상1","물리학 실험(융합), 경제(진로)"],
    ["1학년","1","2","가상2","물리학 실험, 경제"],
  ],subjects);
  assert.deepEqual(plain(result.map((entry)=>entry.selections)),[
    ["물리학 실험","경제"],["물리학 실험","경제"]
  ]);
});

test("generated Google Form routes each current grade to only its promoted-grade section", () => {
  const generator=vm.createContext({$:(selector)=>({value:selector==="#schoolName"?"가상학교":"2026"})});
  vm.runInContext(functionSource("function buildAppsScriptCode(", "function splitGoogleFormSelections("),generator);
  for (const subjects of [setup().subjects,{"2":setup().subjects["2"],"3":[]}]) {
    const pages=[],items=[];
    const gradeItem={setTitle(){return this;},setRequired(){return this;},
      createChoice:(label,page)=>({label,page}),setChoices(choices){this.choices=choices;}};
    const form={
      setDescription(){},setLimitOneResponsePerUser(){},setDestination(){},
      addMultipleChoiceItem:()=>gradeItem,
      addTextItem:()=>({setTitle(){return this;},setRequired(){return this;}}),
      addPageBreakItem(){
        const page={setTitle(title){this.title=title;return this;},setGoToPage(target){this.navigation=target;return this;}};
        pages.push(page);return page;
      },
      addCheckboxItem(){
        const item={page:pages.at(-1),setTitle(){return this;},setChoiceValues(values){this.values=values;return this;},
          setHelpText(){return this;}};
        items.push(item);return item;
      },getPublishedUrl:()=>"https://example.invalid/form",
    };
    const ctx=vm.createContext({
      FormApp:{create:()=>form,PageNavigationType:{SUBMIT:"submit"},DestinationType:{SPREADSHEET:"sheet"}},
      SpreadsheetApp:{create:()=>({getId:()=>"sheet",getUrl:()=>"url"})},Logger:{log(){}},
    });

    vm.runInContext(generator.buildAppsScriptCode(subjects),ctx);
    ctx.createCourseApplicationForm();
    assert.equal(gradeItem.choices.length,pages.length);
    for (const choice of gradeItem.choices) {
      const target=String(Number(choice.label[0])+1);
      assert.equal(choice.page.title,`${target}학년 선택과목`);
      assert.deepEqual(plain(items.filter((item)=>item.page===choice.page).flatMap((item)=>item.values)),
        subjects[target].map((course)=>course.subject));
      const nextPage=pages[pages.indexOf(choice.page)+1];
      if (nextPage) assert.equal(nextPage.navigation,"submit");
    }
  }
});

test("generated offline student form shows total credits and the math, English, Korean credit share", () => {
  const source = functionSource("function buildApplicationPageHtml(", "// 학생 신청 파일(JSON)들을 명단");
  const context = vm.createContext({
    $: (selector) => ({ value: selector === "#schoolName" ? "가상학교" : "2026" }),
    xmlEscape: (value) => String(value),
  });
  vm.runInContext(source, context);
  const html = context.buildApplicationPageHtml({
    "2": [
      { subject: "수학", area: "수학", credit: 3, semester: "1" },
      { subject: "생명과학", area: "과학", credit: 3, semester: "1" },
    ],
    "3": [],
  });
  assert.match(html, /신청 학점 중 국어·영어·수학 과목 비율/);
  assert.match(html, /국·영·수/);
  assert.match(html, /summaryGauge/);
  assert.match(html, /position:sticky;bottom:0/);
  assert.match(html, /data-core=/);
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
  vm.runInContext(functionSource("function mergeApplications(","function downloadApplicationForm("),ctx);
  const common={grade:"1",classroom:"1",number:"1",name:"가상"};
  const result=ctx.mergeApplications([{...common,selections:["수학 (1학기)","수학 (2학기)"]}]);
  assert.deepEqual(plain(result.errors),[]);
  assert.deepEqual(plain(result.students[0].selections.map((c)=>c.semesterKey)),["1","2"]);
  assert.equal(result.students[0].totalCredits,6);
  const legacy=ctx.mergeApplications([{...common,selections:["수학"]}]);
  assert.equal(legacy.courses.length,1);
  assert.deepEqual(plain(legacy.errors),[]);
});

test("cloud aggregation updates its own round, clears rollback results and preserves overrides", () => {
  const state={currentRound:"2",rounds:{"1":{students:[],classOverrides:{"app0":2}},
    "2":{students:[{id:"existing"}],courses:[]}},students:[{id:"existing"}],courses:[]};
  let saves=0,renders=0;
  const elements=new Map();
  const ctx=vm.createContext({state,$:(id)=>{
    if(!elements.has(id)) elements.set(id,{textContent:"",disabled:false});
    return elements.get(id);
  },syncActiveRound(){},persistState(){saves++;},renderRoundStatus(){},
    applyClassFilterOptions(){},renderRoster(){renders++;},renderPreview(){},
    renderSemesterClassifier(){},renderAggregate(){},
  });

  vm.runInContext(functionSource("function mergeApplications(", "function downloadApplicationForm("),ctx);
  vm.runInContext(functionSource("function applyCloudApplicationResults(", "function applyMergedApplications("),ctx);
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
  assert.equal(ctx.courseGroupLabel({name:"실험 (2학기)",column:5},"1"),"2학기 2학기 선택");
  const course={name:"물리학",column:4};
  const data={courses:[course],students:[{grade:"1",selections:[{...course}]}]};
  assert.deepEqual([...ctx.classifyApplicationRecords(data)],[]);
  assert.equal(data.students[0].selections[0].applicationGroups["1"].name,"과학 선택");
  groups=[];
  assert.equal(ctx.courseGroupLabel(data.students[0].selections[0],"1"),"1학기 과학 선택");
  ctx.state.groupAssignments["4"]="manual";
  assert.equal(ctx.courseGroupLabel(course,"1"),"미분류");
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
  const ctx=vm.createContext({state,$:(id)=>{if(!elements.has(id))elements.set(id,{});return elements.get(id);},
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
  vm.runInContext(functionSource("function splitGoogleFormSelections(", "function parseGoogleFormsRows("),ctx);
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
    state,$:()=>({}),normalizeCourses:(courses)=>courses,
    applyClassFilterOptions(){},renderRoster(){},renderPreview(){},renderSemesterClassifier(){},renderAggregate(){},
    renderRoundStatus(){},
    persistState(){ctx.syncActiveRound();},
  });
  vm.runInContext(functionSource("function syncActiveRound(", "function persistState("),ctx);
  vm.runInContext(functionSource("function storeDeveloperGradeResults(", "async function handleApplicationFiles("),ctx);
  const data=(grade,name)=>({
    courses:[{column:4,name:"공통 이름",credits:3},{column:5,name:"미신청 과목",credits:3}],
    students:[{id:`${grade}-${name}`,grade,name,classroom:"1",number:"1",totalCredits:3,
      selections:[{column:4,name:"공통 이름",credits:3}]}]
  });
  ctx.storeDeveloperGradeResults(data("1","첫학생"),"1학년.xlsx","1");
  const firstColumn=state.students[0].selections[0].column;
  state.classOverrides[firstColumn]=2;
  state.semesterAssignments[firstColumn]="1";
  state.groupAssignments[firstColumn]="유지할 그룹";
  ctx.storeDeveloperGradeResults(data("2","둘째학생"),"2학년.xlsx","2");
  assert.deepEqual(plain(state.students.map((s)=>s.grade)),["1","2"]);
  assert.equal(state.courses.length,4); // Keep zero-enrollment courses in aggregate reports.
  assert.equal(new Set(state.courses.map((course)=>course.column)).size,4);
  assert.equal(state.classOverrides[firstColumn],2);
  assert.equal(state.groupAssignments[firstColumn],"유지할 그룹");
  const secondColumn=state.students[1].selections[0].column;
  state.classOverrides[secondColumn]=3;
  ctx.storeDeveloperGradeResults(data("1","새학생"),"1학년_수정.xlsx","1");
  assert.deepEqual(plain(state.students.map((s)=>s.name)),["새학생","둘째학생"]);
  assert.equal(state.classOverrides[firstColumn],undefined);
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
    persistState:()=>{saved++;}});
  vm.runInContext(functionSource("function renderWorkflowLayout(", "function switchRound("),ctx);
  ctx.renderWorkflowLayout();
  assert.equal(buttons.length,6);
  assert.equal(elements.get("#workflowStep1Panel").classList.states.hidden,false);
  ctx.switchWorkflowStep(3);
  assert.equal(elements.get("#certificatePanel").classList.states.hidden,false);
  ctx.switchWorkflowStep(4);
  assert.equal(elements.get("#aggregatePanel").classList.states.hidden,false);
  assert.equal(elements.get("#closurePanel").classList.states.hidden,false);
  assert.equal(elements.get("#retakePanel").classList.states.hidden,false);
  assert.equal(ctx.closureRound,"4");
  ctx.switchWorkflowStep(5);
  assert.equal(elements.get("#classifierPanel").classList.states.hidden,false);
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

test("roster upload exports selected subjects and round without overwriting application results", async () => {
  const subjects = setup().subjects;
  const existing = [{ name: "기존학생" }];
  const ctx = vm.createContext({
    state: { currentRound: "2", students: existing },
    status: { style: {}, textContent: "" },
    $: (selector) => ({ value: selector === "#schoolName" ? "가상학교" : "2026" }),
    selectedApplicationSubjects: () => subjects,
    parseWorkbook: async () => [
      { name: "명렬", rows: [["학년", "반", "번호", "성명"], [1, 1, 1, "가상학생1"]] },
    ],
    downloadTextFile(text, filename) { ctx.downloaded = { data: JSON.parse(text), filename }; },
  });
  vm.runInContext(functionSource("function parseApplicationRoster(", "function downloadTextFile("), ctx);
  vm.runInContext(functionSource("async function handleApplicationRoster(", "function applyMergedApplications("), ctx);
  const file = { name: "roster.xlsx", arrayBuffer: async () => new ArrayBuffer(0) };
  await ctx.handleApplicationRoster(file);
  assert.equal(ctx.downloaded.filename, "온라인_수강신청_설정.json");
  assert.equal(ctx.downloaded.data.type, "course-application-setup");
  assert.equal(ctx.downloaded.data.round, "2");
  assert.deepEqual(ctx.downloaded.data.subjects, subjects);
  assert.equal(ctx.downloaded.data.roster.length, 1);
  assert.equal(ctx.state.students, existing);
  ctx.downloaded = null;
  subjects["2"] = [];
  await ctx.handleApplicationRoster(file);
  assert.equal(ctx.downloaded, null);
  assert.match(ctx.status.textContent, /2학년 학생선택교육과정 과목이 없습니다/);
});

test("server setup requires admin and rejects invalid/duplicate roster", () => {
  const s = server(), c = s.context;
  assert.throws(() => c.uploadCourseSetup("wrong", JSON.stringify(setup())), /인증/);
  const duplicate = setup();
  duplicate.roster.push(duplicate.roster[0]);
  assert.throws(() => c.uploadCourseSetup(s.key, JSON.stringify(duplicate)), /중복/);
  assert.equal(s.books.size, 0);
  c.uploadCourseSetup(s.key, JSON.stringify(setup()));
  assert.throws(() => c.uploadCourseSetup(s.key, JSON.stringify(setup())), /이미 설정/);
  assert.equal(s.locks(), 0);
});

test("student reads only own grade, saves, updates, closes and exports into existing records", () => {
  const s = server(), c = s.context;
  c.uploadCourseSetup(s.key, JSON.stringify(setup()));
  const codes = JSON.parse(c.exportCourseData(s.key, "codes")).students;
  const first = codes[0].code, second = codes[1].code;
  assert.match(first, /^[a-f0-9]{32}$/);
  assert.notEqual(first, second);
  assert.throws(() => c.getStudentApplication("wrong"), /코드/);
  assert.throws(() => c.exportCourseData("wrong", "results"), /인증/);
  const data = plain(c.getStudentApplication(first));
  assert.equal(data.student.name, "가상학생1");
  assert.deepEqual(data.courses.map((course) => course.subject), ["수학"]);
  assert.equal("roster" in data, false);
  assert.throws(() => c.saveStudentApplication(first, ["과학"]), /가능한 과목/);
  assert.throws(() => c.saveStudentApplication(first, []), /가능한 과목/);
  assert.throws(() => c.saveStudentApplication(first, ["수학", "수학"]), /가능한 과목/);
  c.saveStudentApplication(first, ["수학"]);
  c.saveStudentApplication(first, ["수학"]);
  assert.equal(s.books.get("0").getSheetByName("신청").rows.length, 2);
  assert.deepEqual(plain(c.getStudentApplication(second)).selections, []);
  c.setApplicationOpen(s.key, false);
  assert.throws(() => c.saveStudentApplication(second, ["과학"]), /마감/);
  assert.equal(c.getStudentApplication(first).open, false);
  c.setApplicationOpen(s.key, true);
  c.saveStudentApplication(second, ["과학"]);
  const exported = JSON.parse(c.exportCourseData(s.key, "results"));
  assert.equal(exported.round, "2");
  assert.equal(exported.entries.length, 2);
  assert.equal("code" in exported.entries[0], false);
  const mergeCtx = vm.createContext({ collectApplicationSubjects: () => setup().subjects });
  vm.runInContext(functionSource("function mergeApplications(", "function downloadApplicationForm("), mergeCtx);
  const merged = plain(mergeCtx.mergeApplications(exported.entries));
  assert.equal(merged.errors.length, 0);
  assert.equal(merged.students.length, 2);
  assert.equal(merged.students[0].totalCredits, 3);
  assert.equal(s.locks(), 0);
});

test("student web HTML includes no administrator key or roster; invalid admin is rejected", () => {
  const s = server(), c = s.context;
  c.uploadCourseSetup(s.key, JSON.stringify(setup()));
  const output = c.doGet({ parameter: {} });
  const content = output.content;
  assert.equal(output.frameMode, "ALLOWALL");
  assert.ok(!content.includes(s.key));
  assert.ok(!content.includes("가상학생1"));
  const clientScript = content.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(clientScript);
  assert.throws(() => c.doGet({ parameter: { admin: "wrong" } }), /인증/);
  const admin = c.doGet({ parameter: { admin: s.key } });
  assert.ok(admin.content.includes(s.key));
  assert.equal(admin.frameMode, "DEFAULT");
});

test("school link carries only a validated server endpoint and rejects secrets or foreign hosts", () => {
  const ctx = vm.createContext({ URL, URLSearchParams });
  vm.runInContext(functionSource("function normalizeApplicationServerUrl(", "function showStudentApplicationEntry("), ctx);
  const endpoint = "https://script.google.com/macros/s/Abc_123-xyz/exec";
  const link = new URL(ctx.buildSchoolApplicationLink(endpoint, "https://school.example/app/?admin=secret#old"));
  assert.equal(link.origin, "https://school.example");
  assert.equal(link.search, "");
  assert.equal(new URLSearchParams(link.hash.slice(1)).get("apply"), endpoint);
  assert.ok(!link.href.includes("secret"));
  for (const bad of [
    endpoint + "?admin=secret", endpoint + "#key", endpoint.replace("/exec", "/dev"),
    endpoint.replace("https:", "http:"), endpoint.replace("script.google.com", "evil.example"),
    endpoint.replace("script.google.com", "script.google.com.evil.example"),
    endpoint.replace("script.google.com", "user@script.google.com"),
    "javascript:alert(1)", "not a url",
  ]) assert.throws(() => ctx.normalizeApplicationServerUrl(bad));
  assert.throws(() => ctx.buildSchoolApplicationLink(endpoint, "file:///C:/app/index.html"), /게시된 웹사이트/);
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
  vm.runInContext(functionSource("function normalizeApplicationServerUrl(", "async function handleApplicationRoster("), ctx);
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

test("result bundle import checks round and reports empty results without changing records", async () => {
  const ctx = vm.createContext({
    state: { currentRound: "2" }, status: { style: {}, textContent: "" },
    applyMergedApplications(entries) { ctx.merged = plain(entries); },
  });
  vm.runInContext(functionSource("async function handleApplicationFiles(", "function buildAppsScriptCode("), ctx);
  const file = (data) => ({ name: "results.json", text: async () => JSON.stringify(data) });
  await ctx.handleApplicationFiles([file({ type: "course-application-results", round: "1", entries: [{}] })]);
  assert.match(ctx.status.textContent, /차수로 전환/);
  assert.equal(ctx.merged, undefined);
  await ctx.handleApplicationFiles([file({ type: "course-application-results", round: "2", entries: [] })]);
  assert.match(ctx.status.textContent, /비어/);
  await ctx.handleApplicationFiles([file({ type: "course-application-results", round: "2", entries: setup().roster })]);
  assert.equal(ctx.merged.length, 2);
});
