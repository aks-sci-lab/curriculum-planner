// 위계(선이수)는 경고만 한다(서버는 검사·저장 막기를 하지 않는다). 학생 화면 경고에 쓰는 점검 정보(과목.requires, 그룹.checks)가
// 서버 스키마·SQL 변경 없이 기존 jsonb에 실려 보존되는지, 위계 위반 선택도 저장되는지를 PGlite에서 기존 SQL 전체 체인 위에 올려 확인한다.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { PGlite } = require("@electric-sql/pglite");
const Core = require("../test-bot-core.js");

const root = path.join(__dirname, "..");
const sql = (...parts) => fs.readFileSync(path.join(root, "supabase", ...parts), "utf8");
const chain = ["setup.sql", "upgrade-codes-history.sql", "upgrade-stable-student-ids.sql",
  "upgrade-selection-groups.sql", "upgrade-semester-groups.sql", "upgrade-application-rounds.sql",
  "upgrade-teacher-selections.sql", "upgrade-academic-year-access.sql", "upgrade-reselection.sql"];
const owner = "11111111-1111-1111-1111-111111111111";

// 앱과 같은 계산(course-checks.js 순수 부분). 테스트봇도 전역 courseCheckApplicationState를 쓴다.
const checks = vm.createContext({});
const source = fs.readFileSync(path.join(root, "course-checks.js"), "utf8");
vm.runInContext(fs.readFileSync(path.join(root, "curriculum-subject-list.js"), "utf8"), checks);
vm.runInContext(source.slice(0, source.indexOf("// ---- 앱 연결")), checks);
globalThis.courseCheckApplicationState = checks.courseCheckApplicationState;

function plan() {
  let id = 0;
  const subject = (area, name, credits = {}) => ({ id: `s${++id}`, area, name, credits, texts: {} });
  return {
    subjects: [
      subject("수학", "공통수학1", { sem11: 4 }), subject("수학", "공통수학2", { sem12: 4 }), subject("수학", "대수", { sem21: 4 }),
      subject("수학", "미적분Ⅰ, 확률과 통계"), subject("수학", "미적분Ⅱ, 기하"),
      subject("과학", "물리학, 화학, 생명과학, 지구과학"), subject("과학", "역학과 에너지, 생물의 유전, 물질과 에너지"),
      subject("과학", "전자기와 양자, 세포와 물질대사")
    ],
    groups: [
      { id: "p1", fields: ["sem21"], pick: 1, credit: 4, members: ["s4"] },
      { id: "p2", fields: ["sem22"], pick: 1, credit: 4, members: ["s5"] },
      { id: "p3", fields: ["sem21"], pick: 3, credit: 3, members: ["s6"] },
      { id: "p4", fields: ["sem22"], pick: 2, credit: 3, members: ["s7"] },
      { id: "p5", fields: ["sem31"], pick: 2, credit: 4, members: ["s8"] }
    ]
  };
}

// 앱이 만드는 수강신청 생성 자료와 같은 모양(과목.requires, 그룹.checks)을 순수 함수로 만든다.
// legacyBlock: 예전 앱이 '저장 막기'를 켜고 만든 신청처럼 checks.blockPrerequisites=true를 남긴다.
function setup({ withChecks = true, legacyBlock = false } = {}) {
  const model = checks.courseCheckPlanModel(plan());
  const rules = checks.courseCheckApplicableDefaults([model]);
  const semesterOf = { "미적분Ⅰ": "1", "확률과 통계": "1", "물리학": "1", "화학": "1", "생명과학": "1", "지구과학": "1" };
  const names = ["미적분Ⅰ", "확률과 통계", "미적분Ⅱ", "기하", "물리학", "화학", "생명과학", "지구과학", "역학과 에너지", "생물의 유전", "물질과 에너지"];
  const courses = names.map((subject) => ({ subject, credit: semesterOf[subject] && /학|과학/.test(subject) && !/미적분|확률/.test(subject) ? 3 : 4, semester: semesterOf[subject] || "2", area: /미적분|확률|기하/.test(subject) ? "수학" : "과학" }));
  for (const course of courses) if (!/미적분|확률|기하/.test(course.subject)) course.credit = 3;
  const grade3 = ["전자기와 양자", "세포와 물질대사"].map((subject) => ({ subject, credit: 4, semester: "1", area: "과학" }));
  const groups = [
    { id: "g1", grade: "2", semester: "1", name: "2-1 택1", count: 1, courses: ["미적분Ⅰ", "확률과 통계"] },
    { id: "g2", grade: "2", semester: "2", name: "2-2 택1", count: 1, courses: ["미적분Ⅱ", "기하"] },
    { id: "g3", grade: "2", semester: "1", name: "2-1 택3", count: 3, courses: ["물리학", "화학", "생명과학", "지구과학"] },
    { id: "g4", grade: "2", semester: "2", name: "2-2 택2", count: 2, courses: ["역학과 에너지", "생물의 유전", "물질과 에너지"] },
    { id: "g5", grade: "3", semester: "1", name: "3-1 택1", count: 1, courses: ["전자기와 양자", "세포와 물질대사"] }
  ];
  if (withChecks) {
    for (const [grade, list] of [["2", courses], ["3", grade3]]) {
      const payload = checks.courseCheckEventPayload(model, rules, { targetGrade: grade, courses: list, block: true });
      for (const course of list) if (payload.requires.has(course.subject)) course.requires = payload.requires.get(course.subject);
      for (const group of groups) if (group.grade === grade) group.checks = legacyBlock ? { ...payload.checks, blockPrerequisites: true } : payload.checks;
    }
  }
  const roster = [1, 2, 3, 4, 5, 6].map((n) => ({ grade: "1", classroom: "1", number: String(n), name: `학생${n}`, studentId: `10${n}` }))
    .concat([1, 2].map((n) => ({ grade: "2", classroom: "1", number: String(n), name: `선배${n}`, studentId: `20${n}` })));
  return { type: "course-application-setup", schoolName: "[테스트] 가상고", schoolYear: "2099", round: "1",
    subjects: { "1": [], "2": courses, "3": grade3 }, groups, roster };
}

async function server() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as
      'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
    grant usage on schema auth to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;
    insert into auth.users values ('${owner}');
  `);
  for (const file of chain) await db.exec(sql(file));
  const call = async (name, args, role = "anon") => {
    await db.exec(`reset role; set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [role === "authenticated" ? owner : ""]);
    const keys = Object.keys(args);
    const query = `select public.${name}(${keys.map((key, index) => `${key} => $${index + 1}`).join(", ")}) as r`;
    try {
      return (await db.query(query, keys.map((key) => typeof args[key] === "object" ? JSON.stringify(args[key]) : args[key]))).rows[0].r;
    } catch (error) {
      return { error: error.message };
    }
  };
  const apply = async (file) => { await db.exec("reset role"); await db.exec(sql("proposed", file)); };
  return { db, call, apply };
}

// 서버에 위계 검사 함수가 없다(04 초안은 쓰지 않기로 했다).
async function prerequisiteFunctions(db) {
  await db.exec("reset role");
  return (await db.query("select proname from pg_proc where proname ilike '%prereq%'")).rows.map((row) => row.proname);
}

const ok = ["미적분Ⅰ", "미적분Ⅱ", "물리학", "화학", "생명과학", "역학과 에너지", "생물의 유전"];
const noCalculus = ["확률과 통계", "미적분Ⅱ", "물리학", "화학", "생명과학", "역학과 에너지", "생물의 유전"];
const noBiology = ["미적분Ⅰ", "기하", "물리학", "화학", "지구과학", "역학과 에너지", "생물의 유전"];

test("prerequisite checks: event check data rides on existing jsonb with no server change, and violations are saved (warning only)", async () => {
  const { db, call } = await server();
  const event = await call("create_course_event", { p_setup: setup() }, "authenticated");
  const legacy = await call("create_course_event", { p_setup: setup({ legacyBlock: true }) }, "authenticated");
  const plain = await call("create_course_event", { p_setup: setup({ withChecks: false }) }, "authenticated");
  assert.ok(event.id && legacy.id && plain.id, JSON.stringify(event));
  assert.deepEqual(await prerequisiteFunctions(db), [], "서버에는 위계 검사 함수가 없다");
  const student = (target, index = 0) => target.students.filter((item) => String(item.grade) === "1")[index];
  // 서버 스키마 변경 없이 과목.requires·그룹.checks가 학생 응답에 그대로 온다.
  const data = await call("get_scoped_course_application", { p_event: event.id, p_code: student(event).code });
  const calculus = data.courses.find((course) => course.subject === "미적분Ⅱ");
  assert.deepEqual(calculus.requires.map((rule) => rule.name), ["대수", "미적분Ⅰ"]);
  assert.equal(calculus.requires[0].designatedSemester, "1", "같은 학년 지정 과목은 학기만 싣는다(2-1 대수 → 2-2 미적분Ⅱ 충족)");
  assert.deepEqual(calculus.requires[1].options, ["미적분Ⅰ"]);
  assert.ok(!data.courses.find((course) => course.subject === "미적분Ⅰ").requires, "1학년 지정 공통수학으로 이미 충족되는 조건은 싣지 않는다");
  assert.equal(data.groups[0].checks.v, 1);
  assert.equal(data.groups[0].checks.semesters["1"].target, 4 + 4 + 9);
  assert.equal("blockPrerequisites" in data.groups[0].checks, false, "막기 값은 더 싣지 않는다(예전 block 인자를 넘겨도)");
  assert.equal(data.prerequisiteBlock, undefined);
  // 학생 화면 계산은 위반을 찾지만(경고) 서버는 그대로 저장한다.
  assert.ok(checks.courseCheckApplicationState(data, noCalculus).violations.length > 0);
  for (const [target, index, picks] of [[event, 0, noCalculus], [event, 1, noBiology], [event, 2, ok], [legacy, 0, noCalculus], [plain, 0, noCalculus]]) {
    const code = student(target, index).code;
    assert.match((await call("save_scoped_course_application", { p_event: target.id, p_code: code, p_selections: picks })).message, /저장/, picks.join(","));
    const again = await call("get_scoped_course_application", { p_event: target.id, p_code: code });
    assert.deepEqual([...again.selections].sort(), [...picks].sort());
  }
  // 예전에 막기를 켜고 만든 신청: 값이 남아 있어도 학생 화면은 경고만 계산한다(막기 표시 없음).
  const legacyData = await call("get_scoped_course_application", { p_event: legacy.id, p_code: student(legacy, 1).code });
  assert.equal(legacyData.groups[0].checks.blockPrerequisites, true);
  const legacyState = checks.courseCheckApplicationState(legacyData, noCalculus);
  assert.ok(legacyState.violations.length > 0);
  assert.equal("blockConfigured" in legacyState, false);
  // 그룹 규칙 검증은 그대로 서버에서 동작한다.
  assert.match((await call("save_scoped_course_application", { p_event: event.id, p_code: student(event, 3).code, p_selections: ["미적분Ⅰ"] })).error, /정확히/);
  // 3학년 과목(현 2학년): 선이수가 이전 학년 선택 과목이면 '확인 불가'(prior)로 싣는다.
  const senior = event.students.find((item) => String(item.grade) === "2");
  const seniorData = await call("get_scoped_course_application", { p_event: event.id, p_code: senior.code });
  assert.equal(seniorData.courses.find((course) => course.subject === "전자기와 양자").requires[0].prior, "elective");
  assert.match((await call("save_scoped_course_application", { p_event: event.id, p_code: senior.code, p_selections: ["전자기와 양자"] })).message, /저장/);
  // 무작위 선택 40개: 위반 여부와 관계없이 모두 저장된다.
  const rng = Core.createRng(11);
  const groups = data.groups.map((group) => ({ ...group, count: Number(group.count) }));
  let warned = 0;
  for (let i = 0; i < 40; i++) {
    const picks = Core.chooseSelections(groups, { rng });
    if (checks.courseCheckApplicationState(data, picks).violations.length) warned++;
    const result = await call("save_scoped_course_application", { p_event: event.id, p_code: student(event, 4).code, p_selections: picks });
    assert.match(result.message || "", /저장/, `${picks.join(",")}: ${result.error}`);
  }
  assert.ok(warned > 0 && warned < 40, `경고·정상이 모두 나와야 한다(${warned})`);
  // 다음 차수 생성에서도 과목.requires·그룹.checks가 복사된다.
  await call("manage_course_event", { p_event: event.id, p_action: "close" }, "authenticated");
  const next = await call("create_next_course_event", { p_source: event.id, p_closed: [{ grade: "2", subject: "기하" }], p_mode: "all" }, "authenticated");
  assert.ok(next.id, JSON.stringify(next));
  const nextData = await call("get_scoped_course_application", { p_event: next.id, p_code: next.students.find((item) => String(item.grade) === "1").code });
  assert.deepEqual(nextData.courses.find((course) => course.subject === "미적분Ⅱ").requires.map((rule) => rule.name), ["대수", "미적분Ⅰ"]);
  assert.equal(nextData.groups[0].checks.semesters["1"].target, 4 + 4 + 9);
});

test("prerequisite checks on top of code hardening: the test bot's violation attempts are saved with a warning", async () => {
  const { db, call, apply } = await server();
  const event = await call("create_course_event", { p_setup: setup() }, "authenticated");
  await apply("01-code-hardening.sql");
  assert.deepEqual(await prerequisiteFunctions(db), []);
  const codes = await call("manage_course_event", { p_event: event.id, p_action: "codes" }, "authenticated");
  const fetchImpl = async (url, options) => {
    const name = url.match(/\/rest\/v1\/rpc\/(\w+)$/)[1];
    const result = await call(name, JSON.parse(options.body));
    const reply = (status, data) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
    return result?.error && !result.message && typeof result.error === "string" && !/코드|반·번호/.test(result.error)
      ? reply(400, { message: result.error }) : reply(200, result);
  };
  const rpc = Core.createRpcClient({ projectUrl: "https://fake.supabase.co", publicKey: "k", fetchImpl });
  const detected = await Core.detectServerMode(rpc, event.id);
  assert.equal(detected.mode, "hardened");
  const students = codes.students.filter((student) => String(student.grade) === "1")
    .map((student, index) => ({ ...student, grade: "1", plan: { violate: index < 3 } }));
  const shared = { rpc, eventId: event.id, mode: detected.mode, gradeRequired: detected.gradeRequired, rng: Core.createRng(7), weights: new Map() };
  const records = await Core.runPool(students, 2, (student) => Core.runVirtualStudent(student, shared));
  for (const record of records) assert.equal(record.ok, true, `${record.name}: ${record.status} ${record.failure}`);
  const tried = records.filter((record) => record.prerequisite);
  assert.ok(tried.length >= 1, "위반 시도 학생이 있어야 한다");
  for (const record of tried) {
    assert.equal(record.prerequisite.saved, true, record.prerequisite.message);
    assert.ok(record.notes.some((note) => /위계 경고 과목 저장됨/.test(note)), record.notes.join(" / "));
  }
  const summary = Core.summarize(records);
  assert.equal(summary.prerequisiteSaved, tried.length);
  assert.equal(summary.prerequisiteRefused, 0);
  const info = Core.resultSheets(records).find((sheet) => sheet.name === "요약").rows;
  assert.deepEqual(info.find((row) => row[0] === "위계 경고 과목 저장됨"), ["위계 경고 과목 저장됨", tried.length]);
  assert.ok(!info.some((row) => /위계 위반 거절/.test(String(row[0]))));
  // 마지막에 저장한 정상 선택은 위계를 지킨다(위반 시도 뒤 정상 학생처럼 다시 저장).
  for (const record of records) {
    const app = { courses: setup().subjects["2"], groups: setup().groups.filter((group) => group.grade === "2") };
    assert.equal(checks.courseCheckApplicationState(app, record.selections).violations.length, 0, record.selections.join(","));
  }
});

test("teacher application status: warnings are computed on screen from get_teacher_course_applications (no server change)", async () => {
  const { db, call } = await server();
  const event = await call("create_course_event", { p_setup: setup() }, "authenticated");
  const juniors = event.students.filter((item) => String(item.grade) === "1");
  const senior = event.students.find((item) => String(item.grade) === "2");
  for (const [code, picks] of [[juniors[0].code, noCalculus], [juniors[1].code, ok], [juniors[2].code, noBiology], [senior.code, ["전자기와 양자"]]]) {
    assert.match((await call("save_scoped_course_application", { p_event: event.id, p_code: code, p_selections: picks })).message, /저장/);
  }
  const data = await call("get_teacher_course_applications", { p_event: event.id }, "authenticated");
  assert.ok(Array.isArray(data.entries), JSON.stringify(data).slice(0, 200));
  const review = checks.courseCheckTeacherReview(data, "1");
  assert.equal(review.available, true, "이벤트 과목에 실린 requires로 계산한다");
  assert.equal(review.entries, 6);
  assert.equal(review.submitted, 3);
  assert.equal(review.violators, 2, "미적분Ⅰ 없이 미적분Ⅱ, 생명과학 없이 생물의 유전");
  const byName = new Map(review.rows.map((row) => [row.entry.name, row]));
  assert.equal(byName.get(juniors[0].name).violations[0].brief, "미적분Ⅰ 미이수(2-1에 미적분Ⅰ 없음)");
  assert.equal(byName.get(juniors[2].name).violations[0].course, "생물의 유전");
  assert.equal(byName.get(juniors[1].name).violations.length, 0);
  const seniors = checks.courseCheckTeacherReview(data, "2");
  assert.equal(seniors.violators, 0);
  assert.equal(seniors.unknowns, 1, "이전 학년 근거가 없으면 확인 불가");
  assert.deepEqual(await prerequisiteFunctions(db), [], "서버에는 위계 검사 함수가 없다");
});
