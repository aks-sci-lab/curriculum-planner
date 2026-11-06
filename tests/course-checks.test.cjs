const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "course-checks.js"), "utf8");
const resultImport = fs.readFileSync(path.join(root, "result-import.js"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");

function functionSource(text, start, end) {
  const first = text.indexOf(start);
  const last = text.indexOf(end, first + start.length);
  assert.notEqual(first, -1, `missing marker ${start}`);
  assert.notEqual(last, -1, `missing marker ${end}`);
  return text.slice(first, last);
}

function pureContext() {
  const ctx = vm.createContext({});
  vm.runInContext(functionSource(app, "function normalizeRomanNumerals(", "function classifyApplicationRecords("), ctx);
  vm.runInContext(functionSource(resultImport, "function normalizeResultCourseName(", "function resultCourseSemester("), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, "curriculum-subject-list.js"), "utf8"), ctx);
  vm.runInContext(source.slice(0, source.indexOf("// ---- 앱 연결")), ctx);
  return ctx;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

// 합성 편제표: 1학년 공통수학1·2(지정), 2-1 대수(지정), 2-1 택1(미적분Ⅰ·확률과 통계, 4학점),
// 2-2 택1(미적분Ⅱ·기하, 4학점), 2-1 택3(물리학·화학·생명과학·지구과학, 3학점), 2-2 택2(역학과 에너지·생물의 유전·물질과 에너지),
// 3-1 택2(전자기와 양자·화학 반응의 세계·세포와 물질대사), 지정 과학 1학년.
function syntheticPlan() {
  let id = 0;
  const subject = (area, name, credits = {}, required = null) => ({ id: `s${++id}`, category: "학교 지정 교육과정", area, kind: "", name, credits, texts: {}, required });
  const subjects = [
    subject("수학", "공통수학1", { sem11: 4 }, { seg: "q1", text: "8" }),
    subject("수학", "공통수학2", { sem12: 4 }, { seg: "q1", text: "8" }),
    subject("과학", "통합과학1", { sem11: 4 }, { seg: "q2", text: "" }),
    subject("과학", "통합과학2", { sem12: 4 }, { seg: "q2", text: "" }),
    subject("수학", "대수", { sem21: 4 }),
    subject("수학", "미적분Ⅰ, 확률과 통계"),
    subject("수학", "미적분Ⅱ, 기하"),
    subject("과학", "물리학, 화학, 생명과학, 지구과학"),
    subject("과학", "역학과 에너지, 생물의 유전, 물질과 에너지"),
    subject("과학", "전자기와 양자, 화학 반응의 세계, 세포와 물질대사"),
    { id: `s${++id}`, area: "과학", name: "물리학 실험", credits: {}, texts: {}, note: "공동/2학년/2학기/3학점(순증)" },
    { id: `s${++id}`, fixed: true, values: ["이수학점 소계"] }
  ];
  const groups = [
    { id: "g1", fields: ["sem21"], pick: 1, credit: 4, members: ["s6"] },
    { id: "g2", fields: ["sem22"], pick: 1, credit: 4, members: ["s7"] },
    { id: "g3", fields: ["sem21"], pick: 3, credit: 3, members: ["s8"] },
    { id: "g4", fields: ["sem22"], pick: 2, credit: 3, members: ["s9"] },
    { id: "g5", fields: ["sem31"], pick: 2, credit: 4, members: ["s10"] }
  ];
  return { version: 1, subjects, groups };
}

test("plan model: semester targets equal designated + pick × credit, notes and fixed rows are left out", () => {
  const ctx = pureContext();
  const model = ctx.courseCheckPlanModel(syntheticPlan());
  assert.equal(model.fields.sem11.target, 8);
  assert.equal(model.fields.sem21.designated, 4);
  assert.equal(model.fields.sem21.target, 4 + 4 + 9);
  assert.equal(model.fields.sem22.target, 4 + 6);
  assert.equal(model.fields.sem31.target, 8);
  assert.equal(model.required["수학"], 8, "필수이수 열의 같은 칸(세그먼트)은 한 번만 센다");
  assert.equal(model.required["과학"], undefined, "빈 칸이면 기본값을 쓴다");
  assert.ok(!model.places.has("물리학실험"), "순증(메모) 과목은 소계에 들지 않으므로 뺀다");
  assert.deepEqual(plain(model.groups.map((group) => group.label)), ["2-1 택1", "2-2 택1", "2-1 택3", "2-2 택2", "3-1 택2"]);
  const defaults = ctx.courseCheckApplicableDefaults([model]).map((rule) => `${rule.before}>${rule.after}`);
  assert.ok(defaults.includes("미적분Ⅰ>미적분Ⅱ"));
  assert.ok(defaults.includes("생명과학>생물의 유전"));
  assert.ok(!defaults.includes("지구과학>지구시스템과학"), "편제표에 없는 과목의 기본 위계는 넣지 않는다");
});

test("prerequisites: designated earlier subject and earlier-semester choice count, the same semester does not", () => {
  const ctx = pureContext();
  const model = ctx.courseCheckPlanModel(syntheticPlan());
  const rules = ctx.courseCheckApplicableDefaults([model]);
  const check = (selections, prior = null) => ctx.courseCheckPrerequisites(model, rules, { targetGrade: "2", selections, prior });
  // 공통수학(1학년 지정) → 미적분Ⅰ(2-1) → 미적분Ⅱ(2-2): 모두 인정
  const ok = check([{ name: "미적분1", semester: "1" }, { name: "미적분Ⅱ", semester: "2" }, { name: "물리학", semester: "1" }, { name: "역학과 에너지", semester: "2" }]);
  assert.equal(ok.issues.length, 0, JSON.stringify(plain(ok.issues)));
  // 미적분Ⅰ을 고르지 않으면 위반(앞 학기에 개설되어 있으므로 안내도 함께)
  const missing = check([{ name: "확률과 통계", semester: "1" }, { name: "미적분2", semester: "2" }]);
  assert.equal(missing.violations.length, 1);
  assert.equal(missing.violations[0].requires, "미적분Ⅰ");
  assert.equal(missing.violations[0].offeredEarlier, "2-1");
  assert.match(ctx.courseCheckIssueText(missing.violations[0]), /^미적분2는 미적분Ⅰ을 먼저 이수해야 합니다 — 미적분Ⅰ을 이수한 근거가 없습니다\. 2-1에 미적분Ⅰ을 고르거나 담당 선생님과 상의하세요\.$/);
  // 미적분1 ≠ 미적분2: 이름 정규화가 숫자를 지우지 않는다
  assert.equal(ctx.courseCheckKey("미적분Ⅱ"), ctx.courseCheckKey("미적분 2"));
  assert.notEqual(ctx.courseCheckKey("미적분1"), ctx.courseCheckKey("미적분2"));
  // 같은 학기에 함께 고른 선이수 과목은 인정하지 않는다
  const same = check([{ name: "물리학", semester: "2" }, { name: "역학과 에너지", semester: "2" }]);
  assert.equal(same.violations.length, 1);
  assert.equal(same.violations[0].reason, "same");
  assert.match(ctx.courseCheckIssueText(same.violations[0]), /같은 학기\(2학기\)에 함께 고른 물리학은 선이수로 인정되지 않습니다/);
});

test("prerequisites: an earlier-grade choice without results is 'unknown', and prior results settle it", () => {
  const ctx = pureContext();
  const model = ctx.courseCheckPlanModel(syntheticPlan());
  const rules = ctx.courseCheckApplicableDefaults([model]);
  // 현 2학년이 3학년 과목 신청: 화학 반응의 세계는 2학년 선택 과목 화학이 필요하다.
  const unknown = ctx.courseCheckPrerequisites(model, rules, { targetGrade: "3", selections: [{ name: "화학 반응의 세계", semester: "1" }] });
  assert.equal(unknown.violations.length, 0, "근거가 없으면 위반으로 세지 않는다");
  assert.equal(unknown.unknowns.length, 1);
  assert.match(ctx.courseCheckIssueText(unknown.unknowns[0]), /이전 학년 이수 결과가 없어 확인 불가/);
  const done = ctx.courseCheckPrerequisites(model, rules, { targetGrade: "3", selections: [{ name: "화학 반응의 세계", semester: "1" }], prior: ["화학", "대수"] });
  assert.equal(done.issues.length, 0);
  const notDone = ctx.courseCheckPrerequisites(model, rules, { targetGrade: "3", selections: [{ name: "화학 반응의 세계", semester: "1" }], prior: ["물리학"] });
  assert.equal(notDone.violations.length, 1);
  // 꺼 둔 규칙은 보지 않는다
  const off = rules.map((rule) => rule.after === "화학 반응의 세계" ? { ...rule, off: true } : rule);
  assert.equal(ctx.courseCheckPrerequisites(model, off, { targetGrade: "3", selections: [{ name: "화학 반응의 세계", semester: "1" }], prior: [] }).issues.length, 0);
});

test("credits: a 택3 group with two picks is 3 credits short and the text names the group", () => {
  const ctx = pureContext();
  const model = ctx.courseCheckPlanModel(syntheticPlan());
  const report = ctx.courseCheckCredits(model, { targetGrade: "2", selections: [
    { name: "미적분Ⅰ", semester: "1" }, { name: "물리학", semester: "1" }, { name: "화학", semester: "1" },
    { name: "미적분Ⅱ", semester: "2" }, { name: "역학과 에너지", semester: "2" }, { name: "생물의 유전", semester: "2" }
  ] });
  const first = report.semesters[0];
  assert.equal(first.target, 17);
  assert.equal(first.earned, 14);
  assert.equal(ctx.courseCheckSemesterText(first), "2-1 학기 이수 학점 14/17 (택3 중 2개 선택, 3학점 부족)");
  assert.equal(report.semesters[1].diff, 0);
  assert.equal(report.short.length, 1);
  assert.equal(report.grade.earned, 24);
  assert.equal(report.grade.target, 27);
  // 3년 누계: 1학년 지정 16 + 이번 24 + 3학년 편제표 8(예정)
  assert.equal(report.cumulative.earned, 16 + 24 + 8);
  assert.equal(report.cumulative.target, 174);
  // 초과 선택
  const over = ctx.courseCheckCredits(model, { targetGrade: "2", selections: [
    { name: "미적분Ⅰ", semester: "1" }, { name: "확률과 통계", semester: "1" }, { name: "물리학", semester: "1" }, { name: "화학", semester: "1" }, { name: "생명과학", semester: "1" }
  ] });
  assert.equal(over.semesters[0].diff, 4);
  assert.match(ctx.courseCheckSemesterText(over.semesters[0]), /택1 중 2개 선택, 4학점 초과/);
});

test("credits: required credits per subject family use the plan column, then the 2022 defaults, then teacher edits", () => {
  const ctx = pureContext();
  const model = ctx.courseCheckPlanModel(syntheticPlan());
  const report = ctx.courseCheckCredits(model, { targetGrade: "2", selections: [{ name: "미적분Ⅰ", semester: "1" }] });
  const family = (name, value = report) => value.families.find((item) => item.family === name);
  assert.deepEqual(plain(family("수학")), { family: "수학", required: 8, earned: 16, possible: 0, ok: true, status: "ok", source: "plan" });
  assert.equal(family("과학").required, 10, "필수이수 열이 비면 2022 개정 기준 10학점");
  assert.equal(family("과학").source, "default");
  assert.equal(family("과학").earned, 16, "1학년 지정 통합과학 8 + 3학년 과학만 있는 택2 묶음 8(무엇을 골라도 과학)");
  assert.equal(family("과학").ok, true);
  assert.equal(family("사회(역사/도덕 포함)").required, 14);
  const edited = ctx.courseCheckCredits(model, { targetGrade: "2", selections: [], required: { "과학": 30 } });
  assert.equal(family("과학", edited).status, "short", "교사가 입력한 기준보다 적으면 미달");
  assert.equal(family("과학", edited).source, "custom");
  // 여러 교과(군)가 섞인 다른 학년 묶음은 '충족 가능'(pending)으로만 센다.
  const certain = {};
  const possible = ctx.courseCheckOpenGroupFamilies({ groups: [
    { fields: ["sem31"], pick: 2, credit: 4, families: new Map([["a", "과학"], ["b", "사회(역사/도덕 포함)"]]) },
    { fields: ["sem32"], pick: 1, credit: 3, families: new Map([["c", "기술·가정/정보/제2외국어/한문/교양"], ["d", "기술·가정/정보/제2외국어/한문/교양"]]) },
    { fields: ["sem21"], pick: 1, credit: 4, families: new Map([["e", "과학"]]) }
  ] }, "2", false, certain);
  assert.deepEqual(plain(certain), { "기술·가정/정보/제2외국어/한문/교양": 3 });
  assert.deepEqual(plain(possible), { "과학": 8, "사회(역사/도덕 포함)": 8 });
  assert.equal(ctx.courseCheckFamily("제2외국어"), "기술·가정/정보/제2외국어/한문/교양", "'제2외국어'의 '국어'에 걸리지 않는다");
  assert.equal(ctx.courseCheckFamily("기술·가정\n/교양"), "기술·가정/정보/제2외국어/한문/교양");
  assert.equal(ctx.courseCheckFamily("한국사"), "사회(역사/도덕 포함)");
  assert.equal(ctx.courseCheckFamily("", "일본어 회화"), "기술·가정/정보/제2외국어/한문/교양");
});

test("korean particles follow the final consonant, roman numerals read as numbers", () => {
  const ctx = pureContext();
  assert.equal(ctx.courseCheckJosa("미적분Ⅰ", "을/를"), "미적분Ⅰ을");
  assert.equal(ctx.courseCheckJosa("미적분Ⅱ", "은/는"), "미적분Ⅱ는");
  assert.equal(ctx.courseCheckJosa("화학", "을/를"), "화학을");
  assert.equal(ctx.courseCheckJosa("지구과학", "을/를"), "지구과학을");
});
