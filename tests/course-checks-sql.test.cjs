// 위계 '저장 막기' 서버 검증 초안(supabase/proposed/04-prerequisite-check.sql)을 PGlite에서 기존 SQL 전체 체인 위에 올려 확인한다.
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
function setup(block, { withChecks = true } = {}) {
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
      const payload = checks.courseCheckEventPayload(model, rules, { targetGrade: grade, courses: list, block });
      for (const course of list) if (payload.requires.has(course.subject)) course.requires = payload.requires.get(course.subject);
      for (const group of groups) if (group.grade === grade) group.checks = payload.checks;
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

const ok = ["미적분Ⅰ", "미적분Ⅱ", "물리학", "화학", "생명과학", "역학과 에너지", "생물의 유전"];
const noCalculus = ["확률과 통계", "미적분Ⅱ", "물리학", "화학", "생명과학", "역학과 에너지", "생물의 유전"];
const noBiology = ["미적분Ⅰ", "기하", "물리학", "화학", "지구과학", "역학과 에너지", "생물의 유전"];

test("prerequisite SQL: event check data rides on existing jsonb, and blocking events refuse violations on the server", async () => {
  const { call, apply } = await server();
  const blocking = await call("create_course_event", { p_setup: setup(true) }, "authenticated");
  const warning = await call("create_course_event", { p_setup: setup(false) }, "authenticated");
  const legacy = await call("create_course_event", { p_setup: setup(true, { withChecks: false }) }, "authenticated");
  assert.ok(blocking.id && warning.id && legacy.id, JSON.stringify(blocking));
  const student = (event, index = 0) => event.students.filter((item) => String(item.grade) === "1")[index];
  // 서버 스키마 변경 없이(04 적용 전에도) 과목.requires·그룹.checks가 학생 응답에 그대로 온다.
  const before = await call("get_scoped_course_application", { p_event: blocking.id, p_code: student(blocking).code });
  const calculus = before.courses.find((course) => course.subject === "미적분Ⅱ");
  assert.deepEqual(calculus.requires.map((rule) => rule.name), ["대수", "미적분Ⅰ"]);
  assert.equal(calculus.requires[0].designatedSemester, "1", "같은 학년 지정 과목은 학기만 싣는다(2-1 대수 → 2-2 미적분Ⅱ 충족)");
  assert.deepEqual(calculus.requires[1].options, ["미적분Ⅰ"]);
  assert.ok(!before.courses.find((course) => course.subject === "미적분Ⅰ").requires, "1학년 지정 공통수학으로 이미 충족되는 조건은 싣지 않는다");
  assert.equal(before.groups[0].checks.blockPrerequisites, true);
  assert.equal(before.groups[0].checks.semesters["1"].target, 4 + 4 + 9);
  assert.equal(before.prerequisiteBlock, undefined, "04 적용 전에는 막기 지원 표시가 없다(학생 화면은 경고만)");
  // 04 적용 전: 위반도 저장된다.
  assert.match((await call("save_scoped_course_application", { p_event: blocking.id, p_code: student(blocking).code, p_selections: noCalculus })).message, /저장/);

  await apply("04-prerequisite-check.sql");
  const after = await call("get_scoped_course_application", { p_event: blocking.id, p_code: student(blocking, 1).code });
  assert.equal(after.prerequisiteBlock, true);
  assert.equal(after.courses.length, 11);
  assert.match((await call("save_scoped_course_application", { p_event: blocking.id, p_code: student(blocking, 1).code, p_selections: ok })).message, /저장/);
  assert.match((await call("save_scoped_course_application", { p_event: blocking.id, p_code: student(blocking, 2).code, p_selections: noCalculus })).error,
    /위계 미충족: 미적분Ⅱ은\(는\) 미적분Ⅰ을\(를\) 먼저 이수해야 합니다/);
  assert.match((await call("save_scoped_course_application", { p_event: blocking.id, p_code: student(blocking, 2).code, p_selections: noBiology })).error,
    /생물의 유전은\(는\) 생명과학/);
  // 막기를 끈 신청과 점검 정보가 없는 예전 신청은 그대로 저장된다.
  assert.match((await call("save_scoped_course_application", { p_event: warning.id, p_code: student(warning).code, p_selections: noCalculus })).message, /저장/);
  assert.match((await call("save_scoped_course_application", { p_event: legacy.id, p_code: student(legacy).code, p_selections: noCalculus })).message, /저장/);
  // 그룹 규칙 검증은 그대로 앞에서 동작한다.
  assert.match((await call("save_scoped_course_application", { p_event: blocking.id, p_code: student(blocking, 3).code, p_selections: ["미적분Ⅰ"] })).error, /정확히/);
  // 3학년 과목(현 2학년): 선이수가 이전 학년 선택 과목이면 서버는 판단하지 않는다(학생 화면의 '확인 불가').
  const senior = blocking.students.find((item) => String(item.grade) === "2");
  const seniorData = await call("get_scoped_course_application", { p_event: blocking.id, p_code: senior.code });
  assert.equal(seniorData.courses.find((course) => course.subject === "전자기와 양자").requires[0].prior, "elective");
  assert.match((await call("save_scoped_course_application", { p_event: blocking.id, p_code: senior.code, p_selections: ["전자기와 양자"] })).message, /저장/);

  // 학생 화면 계산과 서버 판정이 같다(무작위 선택 60개).
  const rng = Core.createRng(11);
  const groups = after.groups.map((group) => ({ ...group, count: Number(group.count) }));
  let refusedCount = 0;
  for (let i = 0; i < 60; i++) {
    const picks = Core.chooseSelections(groups, { rng });
    const client = checks.courseCheckApplicationState(after, picks).violations.length > 0;
    const result = await call("save_scoped_course_application", { p_event: blocking.id, p_code: student(blocking, 4).code, p_selections: picks });
    assert.equal(Boolean(result.error), client, `${picks.join(",")}: 서버 ${result.error || "저장"} / 화면 ${client}`);
    if (client) refusedCount++;
  }
  assert.ok(refusedCount > 0 && refusedCount < 60, `위반·정상이 모두 나와야 한다(${refusedCount})`);

  await apply("04-rollback.sql");
  const rolled = await call("get_scoped_course_application", { p_event: blocking.id, p_code: student(blocking, 5).code });
  assert.equal(rolled.prerequisiteBlock, undefined);
  assert.match((await call("save_scoped_course_application", { p_event: blocking.id, p_code: student(blocking, 5).code, p_selections: noCalculus })).message, /저장/);
});

test("prerequisite SQL on top of code hardening: the test bot keeps prerequisites and its violation attempts are refused", async () => {
  const { db, call, apply } = await server();
  const event = await call("create_course_event", { p_setup: setup(true) }, "authenticated");
  await apply("01-code-hardening.sql");
  await apply("04-prerequisite-check.sql");
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
    assert.equal(record.prerequisite.refused, true, record.prerequisite.message);
    assert.equal(record.prerequisite.expected, "거절");
    assert.match(record.prerequisite.message, /위계 미충족/);
  }
  const summary = Core.summarize(records);
  assert.equal(summary.prerequisiteRefused, tried.length);
  // 저장된 선택은 모두 위계를 지킨다.
  await db.exec("reset role");
  const data = await call("get_scoped_course_application_base", { p_event: event.id, p_code: "" });
  assert.ok(data.error, "내부 함수는 학생이 직접 부를 수 없다");
  for (const record of records) {
    const app = { courses: setup(true).subjects["2"], groups: setup(true).groups.filter((group) => group.grade === "2") };
    assert.equal(checks.courseCheckApplicationState(app, record.selections).violations.length, 0, record.selections.join(","));
  }
});
