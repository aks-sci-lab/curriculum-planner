// 나이스(NEIS) '수강학생 편성' 자료: 파서(머리 행 탐지·열 이름·학점·반·미재학), 학생 연결(자리·이름·동명이인·마스킹·전입·중복),
// 최소 저장(성명 없음), 위계·학점 점검 반영. 모든 학생 자료는 합성(가명)이다.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const neisSource = fs.readFileSync(path.join(root, "neis-enrollment.js"), "utf8");
const checks = fs.readFileSync(path.join(root, "course-checks.js"), "utf8");
const resultImport = fs.readFileSync(path.join(root, "result-import.js"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");

function functionSource(text, start, end) {
  const first = text.indexOf(start);
  const last = text.indexOf(end, first + start.length);
  assert.notEqual(first, -1, `missing marker ${start}`);
  assert.notEqual(last, -1, `missing marker ${end}`);
  return text.slice(first, last);
}

const plain = (value) => JSON.parse(JSON.stringify(value));

function neisContext() {
  const ctx = vm.createContext({ TextDecoder });
  vm.runInContext(neisSource, ctx);
  return ctx;
}

const HEAD = [["개설 과목", "", "", "", "", "", "편성 학생", "", "", ""],
  ["학년도", "학기", "학년", "편제명", "개설과목(학점)", "개설강의실", "계열/학년/학과", "반", "번호", "성명"]];
const row = (year, semester, grade, family, subject, classroom, number, name) =>
  [year, semester, grade, family, subject, `${classroom}(${grade}학년 ${classroom}반)`, `${grade}학년`, `${classroom}반`, number, name];

test("neis parser: header found under the merged title row, columns by name, credits, classes, text numbers and status", () => {
  const ctx = neisContext();
  const rows = [...HEAD,
    row(2026, "2", 1, "국어", "공통국어2(4)", 9, 1, "홍길동"),
    row("2026", 2, "1", "과학", "과학탐구실험2(1)", "9", "2", "(미재학) 김철수"),
    [],
    row("2026", "1", "2", "과학", "융합과학 탐구(1학기)(3)", 3, "07", "이영희"),
    row("2026", "1", "2", "사회(역사/도덕포함)", "한국사2(3)", 3, 8, "박민수"),
    row("2026", "1", "2", "교양", "진로와 직업", 3, 9, "최지우"),
    row("2026", "1", "2", "창의적 체험활동", "동아리활동(2)", 3, 9, "최지우"),
    HEAD[1],
    ["2026", "", "", "", "", "", "", "", "", ""]];
  const parsed = plain(ctx.neisEnrollmentParse([{ name: "Sheet1", rows }]));
  assert.deepEqual(parsed.terms, ["2026-1", "2026-2"]);
  assert.equal(parsed.records.length, 5);
  assert.deepEqual(parsed.records[0], { year: "2026", semester: "2", grade: "1", classroom: "9", number: "1", name: "홍길동", enrolled: true,
    status: "", masked: false, family: "국어", subject: "공통국어2", credit: 4 });
  assert.equal(parsed.records[1].enrolled, false, "(미재학) 표시는 재학 아님");
  assert.equal(parsed.records[1].name, "김철수");
  assert.equal(parsed.records[1].status, "미재학");
  assert.deepEqual([parsed.records[2].subject, parsed.records[2].credit, parsed.records[2].number], ["융합과학 탐구(1학기)", 3, "7"], "과목명 안 괄호는 두고 끝 괄호 숫자만 학점");
  assert.equal(parsed.records[3].family, "사회(역사/도덕포함)");
  assert.deepEqual([parsed.records[4].subject, parsed.records[4].credit], ["진로와 직업", null], "학점 괄호가 없으면 학점 없음");
  assert.equal(parsed.skipped.creative, 1, "창의적 체험활동은 교과 학점에 넣지 않는다");
  assert.equal(parsed.skipped.header, 1, "중간에 다시 나온 머리 행은 건너뛴다");
  assert.equal(parsed.skipped.empty, 1);
  assert.equal(parsed.skipped.invalid, 1);
  // 열 순서가 달라도 이름으로 찾는다.
  const swapped = ctx.neisEnrollmentParse([{ rows: [["성명", "번호", "반", "학년", "학기", "학년도", "개설과목(학점)", "편제명"], ["가나", "3", "2반", "1", "1", "2026", "수학Ⅰ(4)", "수학"]] }]);
  assert.deepEqual([swapped.records[0].classroom, swapped.records[0].subject, swapped.records[0].credit], ["2", "수학Ⅰ", 4]);
  // 나이스 형식이 아니면 null(기존 결과 양식으로 넘어간다).
  assert.equal(ctx.neisEnrollmentParse([{ rows: [["학년", "반", "번호", "성명", "미적분Ⅱ"], ["2", "1", "1", "가", "1"]] }]), null);
  assert.equal(ctx.neisEnrollmentNumber("9반"), "9");
  assert.equal(ctx.neisEnrollmentNumber(" 2학기 "), "2");
});

test("neis parser: masked names and CSV input", () => {
  const ctx = neisContext();
  for (const name of ["김00", "rkd00", "김OO", "김○○", "홍*동", "이**"]) assert.equal(ctx.neisEnrollmentMasked(name), true, name);
  for (const name of ["홍길동", "가람0305", "Kim Minsu", "남궁민"]) assert.equal(ctx.neisEnrollmentMasked(name), false, name);
  const csv = "﻿학년도,학기,학년,편제명,개설과목(학점),개설강의실,계열/학년/학과,반,번호,성명\r\n2026,1,2,과학,\"화학(4)\",\"과학실, 2층\",2학년,3반,4,가람0304\r\n";
  const rows = plain(ctx.neisEnrollmentCsvRows(csv));
  assert.equal(rows[0][0], "학년도", "BOM 제거");
  assert.equal(rows[1][5], "과학실, 2층", "따옴표 안 쉼표");
  const parsed = ctx.neisEnrollmentParse([{ rows }]);
  assert.deepEqual([parsed.records[0].subject, parsed.records[0].credit, parsed.records[0].classroom], ["화학", 4, "3"]);
  const bytes = new TextEncoder().encode(csv);
  assert.ok(ctx.neisEnrollmentDecode(bytes).replace(/^\uFEFF/, "").startsWith("학년도,학기"));
});

// 합성 자료: 2026년 현 2학년 3명(1-1 가람, 1-2 나래, 2-1 동명), 현 2학년 2-2 동명(동명이인), 현 3학년 1-1 다솜(이름이 같은 지난해 2학년),
// 2025년 1학년 기록, 미재학 1명, 전입생 1명(2-3 새봄: 2025 기록 없음).
function sampleRecords() {
  const records = [];
  const add = (year, semester, grade, classroom, number, name, subject, family = "과학", credit = 4, enrolled = true) =>
    records.push({ year, semester, grade, classroom, number, name, enrolled, status: enrolled ? "" : "미재학", masked: false, family, subject, credit });
  for (const semester of ["1", "2"]) {
    add("2026", semester, "2", "1", "1", "가람", semester === "1" ? "화학" : "화학 반응의 세계");
    add("2026", semester, "2", "1", "2", "나래", semester === "1" ? "물리학" : "역학과 에너지");
    add("2026", semester, "2", "2", "1", "동명", semester === "1" ? "생명과학" : "생물의 유전");
    add("2026", semester, "2", "2", "2", "동명", semester === "1" ? "지구과학" : "행성우주과학");
    add("2026", semester, "2", "2", "3", "새봄", semester === "1" ? "화학" : "화학 반응의 세계");
    add("2026", semester, "3", "1", "1", "다솜", "물질과 에너지");
    add("2025", semester, "1", "5", "1", "가람", `통합과학${semester}`);
    add("2025", semester, "1", "6", "1", "나래", `통합과학${semester}`);
    add("2025", semester, "1", "7", "1", "동명", `통합과학${semester}`);
    add("2025", semester, "1", "8", "1", "동명", `통합과학${semester}`);
    add("2025", semester, "1", "9", "1", "다솜", `통합과학${semester}`, "과학", 4);
    add("2025", semester, "2", "3", "3", "다솜", "화학");
    add("2025", semester, "1", "9", "9", "떠남", `통합과학${semester}`, "과학", 4, false);
  }
  return records;
}

test("neis link: current year by seat, last year by name (grade-checked), withdrawn, twins, transfers, duplicates", () => {
  const ctx = neisContext();
  const records = sampleRecords();
  // 같은 파일을 두 번 올려도(겹친 행) 한 번만 센다.
  const link = ctx.neisEnrollmentLink([...records, ...records.slice(0, 6)], { currentYear: "2026" });
  assert.equal(link.currentYear, "2026");
  assert.deepEqual([...link.terms], ["2025-1", "2025-2", "2026-1", "2026-2"]);
  const garam = link.students.get("2-1-1");
  assert.equal(garam.records.length, 4, "2026 두 학기 + 2025 두 학기, 중복 없음");
  assert.deepEqual([...garam.terms].sort(), ["2025-1", "2025-2", "2026-1", "2026-2"]);
  // 지난해 1학년 '다솜'(9-1)은 지금 2학년이어야 하는데 지금 다솜은 3학년뿐 → 연결 안 됨. 지난해 2학년 다솜(3-3)은 지금 3학년 다솜으로.
  assert.equal(link.students.get("3-1-1").records.length, 4);
  assert.ok(link.unlinked.some((item) => item.person.name === "다솜" && item.person.grade === "1" && item.reason === "no-match"));
  // 미재학은 연결하지 않고 센다.
  assert.equal(link.counts.withdrawn, 1);
  assert.ok(![...link.students.values()].some((student) => student.records.some((record) => record.subject === "통합과학1" && student.key === "1-9-9")));
  // 동명이인 2명(2025 기록이 똑같아 가릴 수 없음) → 화면에서 고르기. 고르기 전에는 전입으로 보지 않는다.
  assert.equal(link.ambiguous.length, 2);
  assert.deepEqual(plain(link.ambiguous[0].candidates).sort(), ["2-2-1", "2-2-2"]);
  assert.equal(link.missing.has("2-2-1"), false);
  // 전입생: 2025 1학년 기록이 있는 학기인데 새봄 기록은 없음.
  assert.deepEqual(plain(link.missing.get("2-2-3")), ["2025-1-1", "2025-2-1"]);
  assert.equal(link.counts.transfers, 1);
  // 하나를 고르면 남은 한 명은 저절로 이어진다.
  const chosen = ctx.neisEnrollmentLink(records, { currentYear: "2026", choices: { [link.ambiguous[0].id]: "2-2-2" } });
  assert.equal(chosen.ambiguous.length, 0);
  assert.ok(chosen.students.get("2-2-2").sources.includes(link.ambiguous[0].id));
  assert.equal(chosen.students.get("2-2-1").records.length, 4);
  // '연결 안 함'을 고르면 그 기록은 연결 안 됨으로 두고, 남은 한 명은 여전히 두 후보 중에서 고른다.
  const none = ctx.neisEnrollmentLink(records, { currentYear: "2026", choices: { [link.ambiguous[0].id]: "none" } });
  assert.ok(none.unlinked.some((item) => item.reason === "chosen-none" && item.person.id === link.ambiguous[0].id));
  assert.equal(none.ambiguous.length, 1);
  assert.equal(none.ambiguous[0].id, link.ambiguous[1].id);
});

test("neis link: twins narrowed by course continuity (prerequisite rules) and masked files are never name-linked", () => {
  const ctx = neisContext();
  const records = [];
  const add = (year, semester, grade, classroom, number, name, subject) =>
    records.push({ year, semester, grade, classroom, number, name, enrolled: true, status: "", masked: ctx.neisEnrollmentMasked(name), family: "", subject, credit: 3 });
  add("2026", "1", "2", "1", "1", "한결", "일본어 회화");
  add("2026", "1", "2", "1", "2", "한결", "중국어 회화");
  add("2025", "2", "1", "4", "4", "한결", "일본어");
  add("2025", "2", "1", "5", "5", "한결", "중국어");
  const rules = [{ before: "일본어", after: "일본어 회화" }, { before: "중국어", after: "중국어 회화" }];
  const link = ctx.neisEnrollmentLink(records, { currentYear: "2026", rules });
  assert.equal(link.ambiguous.length, 0, "이어 듣기 과목으로 가려진다");
  assert.ok(link.students.get("2-1-1").records.some((record) => record.subject === "일본어"));
  assert.ok(link.students.get("2-1-2").records.some((record) => record.subject === "중국어"));
  // 이름이 가려진 자료(김00): 지난해 기록은 잇지 않고, 그 학기 때문에 전입생으로 세지도 않는다.
  const masked = [];
  const addMasked = (year, grade, classroom, number, name, subject) =>
    masked.push({ year, semester: "1", grade, classroom, number, name, enrolled: true, status: "", masked: ctx.neisEnrollmentMasked(name), family: "", subject, credit: 3 });
  addMasked("2026", "2", "1", "1", "김00", "화학");
  addMasked("2025", "1", "3", "3", "김00", "통합과학1");
  const maskedLink = ctx.neisEnrollmentLink(masked, { currentYear: "2026" });
  assert.equal(maskedLink.students.get("2-1-1").records.length, 1, "지금 학년도 행은 자리로 잇는다");
  assert.equal(maskedLink.counts.masked, 1);
  assert.equal(maskedLink.counts.transfers, 0);
  const store = ctx.neisEnrollmentStore(maskedLink, {});
  assert.deepEqual(plain(store.missing), {});
  assert.equal(store.counts.masked, 1);
});

test("neis store: minimal fields only (no names), normalize round trip, per-student lookup and keeping older terms", () => {
  const ctx = neisContext();
  const link = ctx.neisEnrollmentLink(sampleRecords(), { currentYear: "2026" });
  const store = ctx.neisEnrollmentStore(link, { files: [{ name: "수강학생편성_2026.xlsx", uploadedAt: "2026. 11. 9." }] });
  const json = JSON.stringify(store);
  for (const name of ["가람", "나래", "동명", "새봄", "다솜", "떠남"]) assert.equal(json.includes(name), false, `저장분에 성명(${name})이 없다`);
  assert.equal(json.includes("학년 1반"), false, "강의실 정보 없음");
  assert.deepEqual(Object.keys(store.students).sort(), ["2-1-1", "2-1-2", "2-2-1", "2-2-2", "2-2-3"], "점검 대상(현 1·2학년)만 저장");
  assert.equal(store.counts.withdrawn, 1);
  assert.equal(store.counts.ambiguous, 2);
  const normalized = ctx.neisEnrollmentNormalize(JSON.parse(json));
  assert.deepEqual(plain(normalized.students), plain(store.students));
  assert.equal(ctx.neisEnrollmentNormalize({ v: 2 }), null);
  assert.equal(ctx.neisEnrollmentNormalize(null), null);
  const garam = plain(ctx.neisEnrollmentStudent(normalized, "2", "01", "1"));
  assert.deepEqual(garam.terms, ["2025-1", "2025-2", "2026-1", "2026-2"]);
  assert.ok(garam.records.some((record) => record.name === "화학" && record.grade === "2" && record.semester === "1" && record.credit === 4 && record.family === "과학"));
  assert.deepEqual(garam.missing, []);
  assert.deepEqual(plain(ctx.neisEnrollmentStudent(normalized, "2", "2", "3").missing), ["sem11", "sem12"], "전입생의 빈 학기 칸");
  assert.equal(ctx.neisEnrollmentStudent(normalized, "2", "9", "9"), null);
  // 새로 고친 뒤 2026 파일만 다시 올리면(2025 행 없음) 예전 2025 기록은 그대로 둔다.
  const only2026 = sampleRecords().filter((record) => record.year === "2026");
  const merged = ctx.neisEnrollmentStore(ctx.neisEnrollmentLink(only2026, { currentYear: "2026" }), { previous: normalized });
  assert.deepEqual(plain(merged.kept), ["2025-1", "2025-2"]);
  assert.equal(ctx.neisEnrollmentStudent(merged, "2", "1", "1").records.length, 4);
  assert.deepEqual(plain(ctx.neisEnrollmentStudent(merged, "2", "2", "3").missing), ["sem11", "sem12"]);
});

// ---- 점검 반영(course-checks.js)

function syntheticPlan() {
  let id = 0;
  const subject = (area, name, credits = {}) => ({ id: `s${++id}`, area, name, credits, texts: {} });
  return {
    version: 1,
    subjects: [
      subject("국어", "공통국어1", { sem11: 4 }), subject("국어", "공통국어2", { sem12: 4 }),
      subject("수학", "공통수학1", { sem11: 4 }), subject("수학", "공통수학2", { sem12: 4 }), subject("수학", "대수", { sem21: 4 }),
      subject("과학", "물리학, 화학, 생명과학, 지구과학"),
      subject("수학", "확률과 통계, 미디어 영어, 윤리와 사상"),
      subject("과학", "전자기와 양자, 물질과 에너지, 세포와 물질대사")
    ],
    groups: [
      { id: "g1", fields: ["sem21"], pick: 2, credit: 4, members: ["s6"] },
      { id: "g2", fields: ["sem22"], pick: 2, credit: 4, members: ["s7"] },
      { id: "g3", fields: ["sem31"], pick: 2, credit: 4, members: ["s8"] }
    ]
  };
}

function checksContext(state) {
  const planData = syntheticPlan();
  state.curriculumCohorts = { "2025": { importedLayout: { planData } }, "2026": { importedLayout: { planData } } };
  const ctx = vm.createContext({ state, TextDecoder, getApplicationCohortYear: (grade) => String(2026 - Number(grade) + 1) });
  vm.runInContext(functionSource(app, "function normalizeRomanNumerals(", "function classifyApplicationRecords("), ctx);
  vm.runInContext(functionSource(resultImport, "function normalizeResultCourseName(", "function resultCourseSemester("), ctx);
  vm.runInContext(fs.readFileSync(path.join(root, "curriculum-subject-list.js"), "utf8"), ctx);
  vm.runInContext(neisSource, ctx);
  vm.runInContext(checks, ctx);
  return ctx;
}

test("neis checks: prerequisites use real records, transfers stay 'unknown' only where the prerequisite was offered", () => {
  const ctx = checksContext({ students: [] });
  const model = ctx.courseCheckPlanModel(syntheticPlan());
  const rules = ctx.courseCheckApplicableDefaults([model]);
  const pick = (name) => [{ name, semester: "1" }];
  const met = ctx.courseCheckPrerequisites(model, rules, { targetGrade: "3", selections: pick("물질과 에너지"), prior: ["화학", "대수"], priorSource: "neis" });
  assert.equal(met.issues.length, 0);
  const missing = ctx.courseCheckPrerequisites(model, rules, { targetGrade: "3", selections: pick("물질과 에너지"), prior: ["물리학"], priorSource: "neis" });
  assert.equal(missing.violations.length, 1);
  assert.equal(missing.violations[0].priorSource, "neis");
  assert.equal(ctx.courseCheckIssueBrief(missing.violations[0], { grade: "3", offered: [] }), "화학 미이수(나이스 이수 기록에 없음)");
  assert.match(ctx.courseCheckIssueText(missing.violations[0]), /나이스 이수 기록에 화학이 없습니다/);
  // 2-1 기록이 없는 전입생: 화학이 2-1에 나오므로 확인 불가. 1학년 기록만 없는 전입생은 2-1에 있었으니 위반.
  const transfer = ctx.courseCheckPrerequisites(model, rules, { targetGrade: "3", selections: pick("물질과 에너지"), prior: ["확률과 통계"],
    priorMissing: ["sem11", "sem12", "sem21"], priorSource: "neis" });
  assert.equal(transfer.unknowns[0].reason, "transfer");
  assert.equal(ctx.courseCheckIssueBrief(transfer.unknowns[0]), "화학 이수 확인 불가(전입생 · 이전 학교 기록 확인)");
  const lateTransfer = ctx.courseCheckPrerequisites(model, rules, { targetGrade: "3", selections: pick("물질과 에너지"), prior: ["물리학"],
    priorMissing: ["sem11", "sem12"], priorSource: "neis" });
  assert.equal(lateTransfer.violations.length, 1);
});

test("neis checks: credits use the records (편제명 decides the family, current semester included)", () => {
  const ctx = checksContext({ students: [] });
  const model = ctx.courseCheckPlanModel(syntheticPlan());
  const record = (grade, semester, family, name, credit) => ({ grade, semester, family, name, credit });
  const records = [
    record("1", "1", "국어", "공통국어1", 4), record("1", "1", "수학", "공통수학1", 4),
    record("1", "2", "국어", "공통국어2", 4), record("1", "2", "수학", "공통수학2", 4), record("1", "2", "교양", "진로와 직업", 2),
    record("2", "1", "수학", "대수", 4), record("2", "1", "과학", "화학", 4), record("2", "1", "과학", "물리학", 4),
    record("2", "2", "수학", "확률과 통계", 4), record("2", "2", "영어", "미디어 영어", 4)
  ];
  const report = ctx.courseCheckCredits(model, { targetGrade: "3", selections: [{ name: "물질과 에너지", semester: "1", credit: 4 }, { name: "전자기와 양자", semester: "1", credit: 4 }],
    prior: records.map((item) => item.name), priorRecords: records, limits: { kemLimit: 20 } });
  assert.equal(report.cumulative.before, 38, "1·2학년은 실제 기록 학점(2-2는 이수 중)");
  assert.equal(report.cumulative.beforeEstimated, false);
  assert.equal(report.priorUnknown, false);
  assert.deepEqual(plain(report.cumulative.actual.map((row) => row.label)), ["1-1", "1-2", "2-1", "2-2"]);
  const family = (name) => report.families.find((item) => item.family === name).earned;
  assert.equal(family("영어"), 4, "편제명 '영어'(미디어 영어)");
  assert.equal(family("기술·가정/정보/제2외국어/한문/교양"), 2);
  assert.equal(report.kem.earned, 28, "국수영 = 국4+4 · 수4+4+4+4 · 영4");
  assert.equal(report.kem.status, "over");
  // 기록이 없는 학기(전입생)는 편제표 기준으로 둔다.
  const partial = ctx.courseCheckCredits(model, { targetGrade: "3", selections: [], prior: ["대수"], priorRecords: records.filter((item) => item.grade === "2") });
  assert.equal(partial.cumulative.beforeEstimated, false, "1학년은 지정 과목뿐이라 추정 없음");
  assert.equal(partial.cumulative.before, 16 + 20, "1학년 편제표 16 + 2학년 기록 20");
});

test("neis checks: the app reads the stored data for its school year only and keeps it through settings normalization", () => {
  const neis = neisContext();
  const records = [];
  const add = (year, semester, grade, classroom, number, name, subject, family = "과학") =>
    records.push({ year, semester, grade, classroom, number, name, enrolled: true, status: "", masked: false, family, subject, credit: 4 });
  add("2026", "1", "2", "1", "1", "가람", "화학"); add("2026", "1", "2", "1", "1", "가람", "대수", "수학");
  add("2026", "1", "2", "1", "2", "나래", "물리학"); add("2026", "1", "2", "1", "2", "나래", "대수", "수학");
  add("2025", "1", "1", "4", "4", "가람", "공통수학1", "수학"); add("2025", "1", "1", "5", "5", "나래", "공통수학1", "수학");
  const store = JSON.parse(JSON.stringify(neis.neisEnrollmentStore(neis.neisEnrollmentLink(records, { currentYear: "2026" }), {})));
  const student = (classroom, number, courses) => ({ id: `2-${classroom}-${number}`, grade: "2", classroom, number, name: "김00",
    selections: courses.map((name, index) => ({ name, column: `c${index}`, credits: 4, applicationGroups: { 2: { semester: "1" } } })) });
  const state = { students: [student("1", "1", ["물질과 에너지", "전자기와 양자"]), student("1", "2", ["전자기와 양자"]), student("1", "3", ["세포와 물질대사"])],
    courseChecks: { neis: store } };
  const ctx = checksContext(state);
  // 저장분 정리(복원·백업 읽기)에서 나이스 자료가 유지된다.
  assert.deepEqual(plain(ctx.courseCheckNormalizeSettings(state.courseChecks).neis.students), store.students);
  const flags = ctx.courseCheckFlags(state.students);
  const entry = (index) => flags.students.get(state.students[index]);
  assert.equal(entry(0).violations.length, 1, "가람: 전자기와 양자 ← 물리학 미이수");
  assert.equal(entry(0).violations[0].brief, "물리학 미이수(나이스 이수 기록에 없음)");
  assert.equal(entry(1), undefined, "나래: 물리학 이수");
  assert.equal(entry(2).unknowns[0].issue.reason, "prior", "나이스 자료에 없는 학생은 확인 불가");
  const summary = ctx.courseCheckSummary(state.students);
  assert.equal(summary.neis, true);
  assert.equal(summary.neisFound, 2);
  assert.equal(summary.priorMissing, 1);
  // 학년도가 다른 저장분(작년 자료)은 쓰지 않는다(자리가 달라짐).
  const old = checksContext({ students: state.students, courseChecks: { neis: { ...store, currentYear: "2025" } } });
  assert.equal(old.courseCheckFlags(state.students).students.get(state.students[0]).unknowns.length, 2);
  // 요약 문구: 학기 목록·이수 중
  assert.equal(ctx.courseCheckNeisTermsText({ currentYear: "2026", terms: ["2025-1", "2026-1", "2026-2"] }, new Date(2026, 10, 9)), "2025-1·2026-1·2026-2(이수 중)");
  assert.equal(ctx.courseCheckNeisTermsText({ currentYear: "2026", terms: ["2026-1"] }, new Date(2026, 10, 9)), "2026-1");
});

test("neis script is loaded before course-checks.js and the upload accepts several .xlsx/.csv files", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(html.indexOf("neis-enrollment.js") > 0 && html.indexOf("neis-enrollment.js") < html.indexOf("course-checks.js"));
  assert.match(checks, /id="courseCheckPriorInput" type="file" accept="\.xlsx,\.csv" multiple/);
});
