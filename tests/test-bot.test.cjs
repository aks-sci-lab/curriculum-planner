const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { PGlite } = require("@electric-sql/pglite");
const Core = require("../test-bot-core.js");
const Bridge = require("../test-bot-bridge.js");

const root = path.join(__dirname, "..");
const GROUPS = [
  { name: "2-1 택2", semester: "1", count: 2, courses: ["물리학", "화학", "생명과학", "융합과학 탐구 (1학기)"] },
  { name: "2-1 택1", semester: "1", count: 1, courses: ["일본어", "중국어"] },
  { name: "2-2 택1", semester: "2", count: 1, courses: ["미적분Ⅱ", "기하", "융합과학 탐구 (2학기)"] },
];

test("test bot: 무작위 선택은 그룹마다 정확히 n과목이고 1·2학기 같은 과목을 겹치지 않는다", () => {
  const rng = Core.createRng(7);
  for (let i = 0; i < 400; i++) {
    const picks = Core.chooseSelections(GROUPS, { rng });
    assert.deepEqual(Core.checkSelections(GROUPS, picks), [], picks.join(","));
    assert.equal(picks.length, 4);
  }
  // 고정 과목(재선택에서 유지되는 과목)은 그대로 두고 나머지만 채운다.
  const locked = Core.chooseSelections(GROUPS, { rng, locked: ["융합과학 탐구 (1학기)"] });
  assert.ok(locked.includes("융합과학 탐구 (1학기)"));
  assert.ok(!locked.includes("융합과학 탐구 (2학기)"));
  assert.deepEqual(Core.checkSelections(GROUPS, locked), []);
  assert.throws(() => Core.chooseSelections([{ name: "불가", count: 3, courses: ["가", "나"] }], { rng }), /찾지 못했습니다/);
});

test("test bot: 인기도 몰림은 일부 과목에 신청이 쏠리고 일부는 거의 비게 만든다", () => {
  const groups = [{ name: "택3", semester: "1", count: 3, courses: Array.from({ length: 10 }, (_, i) => `과목${i}`) }];
  const rng = Core.createRng(11);
  const count = (mode) => {
    const weights = Core.buildPopularityWeights(groups, mode, rng);
    const tally = new Map(groups[0].courses.map((name) => [name, 0]));
    for (let i = 0; i < 600; i++) for (const name of Core.chooseSelections(groups, { rng, weights })) tally.set(name, tally.get(name) + 1);
    return [...tally.values()].sort((a, b) => b - a);
  };
  const uniform = count("uniform");
  const skewed = count("skewed");
  assert.ok(uniform[0] < uniform[9] * 1.6, `균등: ${uniform}`);
  assert.ok(skewed[0] > skewed[9] * 10, `몰림: ${skewed}`);
  assert.ok(skewed[9] < 60, "인기 없는 과목은 폐강 기준 아래로 떨어진다");
});

test("test bot: 규칙 위반 선택과 결과 파일 오류 주입", () => {
  const rng = Core.createRng(3);
  const picks = Core.chooseSelections(GROUPS, { rng });
  const broken = Core.violateSelections(GROUPS, picks, rng);
  assert.ok(broken && Core.checkSelections(GROUPS, broken.selections).length > 0);
  assert.match(broken.description, /과목 선택\(기준 \d\)/);

  const students = Core.generateRoster({ grade: "1", classes: 3, perClass: 10 });
  assert.equal(students.length, 30);
  assert.match(students[0].name, /^.가상01$/);
  const { entries } = Core.buildResultEntries(students, GROUPS, { rng, emptyCount: 2, violationCount: 3, unknownCount: 1 });
  assert.equal(entries.filter((entry) => entry.injected.includes("미선택")).length, 2);
  assert.equal(entries.filter((entry) => !entry.selections.length).length, 2);
  assert.equal(entries.filter((entry) => entry.injected.some((item) => item.startsWith("택 수 위반"))).length, 3);
  assert.equal(entries.filter((entry) => entry.selections.includes(Core.UNKNOWN_COURSE)).length, 1);
  const clean = entries.filter((entry) => !entry.injected.length);
  assert.ok(clean.every((entry) => Core.checkSelections(GROUPS, entry.selections).length === 0));

  // 학생별 과목 표시 형식: 실제 결과 파일과 같은 머리글 두 줄, 학년 열은 현재 학년, 두 학기 과목은 "(n학기)"
  const credits = new Map([["물리학", 4], ["미적분2", 4], ["융합과학탐구", 2]]);
  const wide = Core.buildWideRows(entries, GROUPS, { grade: "1", credits, romanDigits: true });
  assert.deepEqual(wide[0].slice(0, 5), ["", "", "", "과목", "물리학"]);
  assert.deepEqual(wide[1].slice(0, 5), ["학년", "반", "번호", "성명/학점", 4]);
  assert.ok(wide[0].includes("미적분2") && !wide[0].includes("미적분Ⅱ"));
  assert.ok(wide[0].includes("융합과학 탐구(1학기)") && wide[0].includes("융합과학 탐구(2학기)"));
  assert.equal(wide[1][wide[0].indexOf("융합과학 탐구(2학기)")], 2);
  assert.ok(wide.slice(2).every((row) => row[0] === 1));
  assert.equal(wide.length, 32);
  const form = Core.buildFormRows(entries, { round: "2", grade: "1" });
  assert.deepEqual(form[0], ["차수", "학년", "반", "번호", "성명", "선택과목"]);
  assert.equal(form[1][0], "2");
  assert.equal(form[1][1], "1");
  assert.match(Core.resultFileName("1", "wide", new Date(2026, 10, 6)), /^테스트봇_수강신청결과\(현1학년\)_2026-11-06\.xlsx$/);

  const bytes = Buffer.from(Core.createXlsxBytes([{ name: "수강신청결과", rows: wide }]));
  assert.equal(bytes.subarray(0, 2).toString(), "PK");
  const text = bytes.toString("utf8");
  assert.ok(text.includes("xl/worksheets/sheet1.xml") && text.includes("성명/학점") && text.includes("<v>4</v>"));
});

test("test bot: 앱 저장 자료는 읽기만 하고 입학연도별 그룹·학점을 고른다", () => {
  const store = new Map([
    ["course-certificate-studio-v1", JSON.stringify({ schoolYear: "2026", currentRound: "2", schoolName: "가상고",
      curriculumCohorts: { 2026: { plan: [{ grade: "2", subject: "물리학", opCredit: 4 }, { grade: "2", subject: "미적분Ⅱ", baseCredit: 3, opCredit: 0 }] } } })],
    ["curriculum-color-semester-groups-v3:2026", JSON.stringify([...GROUPS.map((group, index) => ({ ...group, id: `g${index}`, grade: "2" })),
      { id: "x", grade: "3", semester: "1", name: "3학년", count: 1, courses: ["가"] }])],
    ["curriculum-color-semester-groups-v3:2025", JSON.stringify([{ id: "y", grade: "3", semester: "1", name: "3-1 택1", count: 1, courses: ["가", "나"] }])],
  ]);
  const reads = [];
  const getItem = (key) => { reads.push(key); return store.get(key) ?? null; };
  const one = Core.readWorkspaceSettings(getItem, "1");
  assert.equal(one.cohortYear, "2026");
  assert.equal(one.targetGrade, "2");
  assert.equal(one.round, "2");
  assert.equal(one.groups.length, 3);
  assert.equal(one.credits.get("물리학"), 4);
  assert.equal(one.credits.get("미적분2"), 3);
  const two = Core.readWorkspaceSettings(getItem, "2");
  assert.deepEqual(two.groups.map((group) => group.name), ["3-1 택1"]);
  store.set("curriculum-color-semester-groups-v3:2025", JSON.stringify([{ id: "y", grade: "3", semester: "1", name: "미정", count: null, courses: ["가"] }]));
  assert.throws(() => Core.readWorkspaceSettings(getItem, "2"), /선택 수가 정해지지 않은/);
  assert.throws(() => Core.readWorkspaceSettings(() => null, "1"), /저장된 앱 자료가 없습니다/);
  assert.ok(reads.every((key) => key.startsWith("course-certificate-studio-v1") || key.startsWith("curriculum-color-semester-groups-v3")));
});

test("test bot: 학생 신청 링크·코드 엑셀·명렬 읽기", () => {
  const id = "0b0c6c0e-4a8e-4f1f-9a51-2b1c3d4e5f60";
  assert.equal(Core.parseEventInput(`https://aks-sci-lab.github.io/curriculum-planner/#event=${id}`), id);
  assert.equal(Core.parseEventInput(id.toUpperCase()), id);
  assert.throws(() => Core.parseEventInput("https://example.com/"), /링크/);
  const codes = Core.parseCodeSheets([{ rows: [
    ["신청ID", "현재학년", "반", "번호", "이름", "신청코드", "학생링크"],
    [id, "1", "1", "1", "김가상01", "012345", "x"],
    [id, 1, 1, 2, "이가상02", 12346, "x"],
  ] }]);
  assert.equal(codes.eventId, id);
  assert.deepEqual(codes.students.map((student) => student.code), ["012345", "012346"]);
  assert.throws(() => Core.parseCodeSheets([{ rows: [["학년", "반"]] }]), /양식/);
  const roster = Core.parseRosterSheets([{ name: "명렬", rows: [["학년", "반", "번호", "성명", "비고"], [1, 2, 1, "가"], [2, 1, 1, "나"], [1, 1, 3, "다"]] }], "1");
  assert.deepEqual(roster.students.map((student) => student.name), ["다", "가"]);
  assert.equal(roster.otherGrade, 1);
  const picked = Core.selectStudents(Core.generateRoster({ grade: "1", classes: 3, perClass: 4 }), { scope: "class", classes: "1, 3" });
  assert.deepEqual([...new Set(picked.map((student) => student.classroom))], ["1", "3"]);
  assert.equal(Core.selectStudents(picked, { scope: "first", count: 3 }).length, 3);
  assert.ok(Core.isWeakCode("123456") && Core.isWeakCode("777777") && !Core.isWeakCode("482915"));
});

test("test bot bridge: 내가 연 창·같은 nonce·허용된 출처의 메시지만 받는다", () => {
  const nonce = Bridge.createNonce(require("node:crypto").webcrypto);
  assert.match(nonce, /^[a-f0-9]{32}$/);
  assert.equal(Bridge.nonceFromHash(`#bridge=${nonce}`), nonce);
  assert.equal(Bridge.nonceFromHash("#bridge=nope"), "");
  const bot = {};
  const stranger = {};
  const file = { protocol: "file:", origin: "null" };
  const https = { protocol: "https:", origin: "https://aks-sci-lab.github.io" };
  const ready = (overrides = {}) => ({ source: bot, origin: "null", data: { type: Bridge.READY, nonce }, ...overrides });
  assert.equal(Bridge.acceptReady(ready(), { expectedSource: bot, nonce, location: file }), true);
  assert.equal(Bridge.acceptReady(ready({ origin: "file://" }), { expectedSource: bot, nonce, location: file }), true);
  assert.equal(Bridge.acceptReady(ready({ source: stranger }), { expectedSource: bot, nonce, location: file }), false, "다른 창");
  assert.equal(Bridge.acceptReady(ready({ data: { type: Bridge.READY, nonce: "0".repeat(32) } }), { expectedSource: bot, nonce, location: file }), false, "잘못된 nonce");
  assert.equal(Bridge.acceptReady(ready(), { expectedSource: bot, nonce, location: https }), false, "배포 주소에서 null 출처");
  assert.equal(Bridge.acceptReady(ready({ origin: "https://evil.example" }), { expectedSource: bot, nonce, location: https }), false);
  assert.equal(Bridge.acceptReady(ready({ origin: https.origin }), { expectedSource: bot, nonce, location: https }), true);
  assert.equal(Bridge.targetOrigin(file), "*");
  assert.equal(Bridge.targetOrigin(https), https.origin);

  const eventId = "0b0c6c0e-4a8e-4f1f-9a51-2b1c3d4e5f60";
  const payload = Bridge.buildPayload({ id: eventId, students: [
    { id: "s1", grade: "1", classroom: "1", number: "1", name: "김가상01", code: "482915" },
    { id: "s2", grade: "1", classroom: "1", number: "2", name: "이가상02", code: "582915" }] },
  { schoolName: "[테스트] 가상고", schoolYear: "2026", round: "1" }, "link");
  const codes = { source: bot, origin: "null", data: { type: Bridge.CODES, nonce, payload: { ...payload, autoRun: true } } };
  const accepted = Bridge.acceptCodes(codes, { expectedSource: bot, nonce, location: file });
  assert.equal(accepted.students.length, 2);
  assert.equal(accepted.autoRun, true);
  assert.equal(Bridge.acceptCodes({ ...codes, source: stranger }, { expectedSource: bot, nonce, location: file }), null);
  assert.equal(Bridge.acceptCodes({ ...codes, data: { ...codes.data, payload: { ...payload, students: [{ grade: "1", classroom: "1", number: "1", code: "12" }] } } },
    { expectedSource: bot, nonce, location: file }), null, "형식이 잘못된 코드");
  // 재발급: 그 학생 코드만 바뀐다.
  const update = Bridge.validatePayload(Bridge.buildPayload({ id: eventId, students: [{ id: "s2", grade: "1", classroom: "1", number: "2", name: "이가상02", code: "999111" }] }, accepted, "link", true));
  const merged = Bridge.mergePayload(accepted, update);
  assert.deepEqual(merged.students.map((student) => student.code), ["482915", "999111"]);
  assert.equal(merged.autoRun, false);

  const request = (data) => ({ source: bot, origin: "null", data: { type: Bridge.TEACHER_REQUEST, nonce, id: "r1", action: "applications", eventId, ...data } });
  const options = { expectedSource: bot, nonce, location: file, eventId };
  assert.deepEqual(Bridge.acceptTeacherRequest(request(), options), { id: "r1", action: "applications", eventId });
  assert.equal(Bridge.acceptTeacherRequest(request({ action: "drop_everything" }), options), null);
  assert.equal(Bridge.acceptTeacherRequest(request({ eventId: "1b0c6c0e-4a8e-4f1f-9a51-2b1c3d4e5f60" }), options), null, "연결된 신청만");
});

// ---------- PGlite 위 실제 SQL로 봇의 서버 호출부 확인 ----------
const sql = (...parts) => fs.readFileSync(path.join(root, "supabase", ...parts), "utf8");
const chain = ["setup.sql", "upgrade-codes-history.sql", "upgrade-stable-student-ids.sql",
  "upgrade-selection-groups.sql", "upgrade-semester-groups.sql", "upgrade-application-rounds.sql",
  "upgrade-teacher-selections.sql", "upgrade-academic-year-access.sql", "upgrade-reselection.sql"];
const owner = "11111111-1111-1111-1111-111111111111";

async function server({ hardened }) {
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
  const as = async (role, user = "") => {
    await db.exec(`reset role; set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  };
  const call = async (name, args, role = "anon", user = "") => {
    await as(role, user);
    const keys = Object.keys(args);
    const query = `select public.${name}(${keys.map((key, index) => `${key} => $${index + 1}`).join(", ")}) as r`;
    return (await db.query(query, keys.map((key) => typeof args[key] === "object" ? JSON.stringify(args[key]) : args[key]))).rows[0].r;
  };
  // 브라우저 fetch 흉내: PostgREST처럼 함수가 없으면 404 PGRST202, 예외는 400 {message}.
  const fetchImpl = async (url, options) => {
    const name = url.match(/\/rest\/v1\/rpc\/(\w+)$/)[1];
    const body = JSON.parse(options.body);
    await db.exec("reset role");
    const found = (await db.query("select count(*)::int n from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='public' and p.proname=$1", [name])).rows[0].n;
    const reply = (status, data) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
    if (!found) return reply(404, { code: "PGRST202", message: `Could not find the function public.${name}` });
    try { return reply(200, await call(name, body)); } catch (error) { return reply(400, { code: error.code, message: error.message }); }
  };
  const subjects = ["물리학", "화학", "생명과학"].map((subject) => ({ subject, credit: 4, semester: "1" }))
    .concat(["미적분Ⅱ", "기하"].map((subject) => ({ subject, credit: 4, semester: "2" })))
    .concat([{ subject: "융합과학 탐구 (1학기)", credit: 2, semester: "1" }, { subject: "융합과학 탐구 (2학기)", credit: 2, semester: "2" }]);
  const groups = [
    { id: "g1", grade: "2", semester: "1", name: "2-1 택2", count: 2, courses: ["물리학", "화학", "생명과학", "융합과학 탐구 (1학기)"] },
    { id: "g2", grade: "2", semester: "2", name: "2-2 택1", count: 1, courses: ["미적분Ⅱ", "기하", "융합과학 탐구 (2학기)"] },
  ];
  const roster = Core.generateRoster({ grade: "1", classes: 2, perClass: 6 });
  const setup = { type: "course-application-setup", schoolName: "[테스트] 가상고",
    schoolYear: "2099", round: "1", subjects: { "1": [], "2": subjects, "3": [] }, groups, roster };
  const event = await call("create_course_event", { p_setup: setup }, "authenticated", owner);
  let codes = event;
  if (hardened) {
    await db.exec("reset role");
    await db.exec(sql("proposed", "01-code-hardening.sql"));
    codes = await call("manage_course_event", { p_event: event.id, p_action: "codes" }, "authenticated", owner);
  }
  const rpc = Core.createRpcClient({ projectUrl: "https://fake.supabase.co", publicKey: "k", fetchImpl });
  return { db, call, rpc, event, codes, groups, setup };
}

async function runBot(ctx, plans, concurrency = 4) {
  const detected = await Core.detectServerMode(ctx.rpc, ctx.event.id);
  const students = ctx.codes.students.map((student, index) => ({ ...student, grade: String(student.grade), plan: plans(index) }));
  const shared = { rpc: ctx.rpc, eventId: ctx.event.id, mode: detected.mode, gradeRequired: detected.gradeRequired,
    rng: Core.createRng(5), weights: new Map(), popularity: "skewed" };
  const records = await Core.runPool(students, concurrency, (student) => Core.runVirtualStudent(student, shared));
  return { detected, records };
}

test("test bot × 실제 SQL(새 방식): 첫 접속 코드 변경, 택n 검증, 잠금, 재신청이 서버 규칙과 맞는다", async () => {
  const ctx = await server({ hardened: true });
  try {
    const { detected, records } = await runBot(ctx, (index) => ({
      wrongCodes: index === 0 ? 5 : index === 1 ? 2 : 0, violate: index === 2 || index === 3, resubmit: index === 4,
    }));
    assert.equal(detected.mode, "hardened");
    assert.equal(detected.form.schoolName, "[테스트] 가상고");
    const [locked, retried, violated, , resubmitted] = records;
    assert.equal(locked.status, "잠김 확인", locked.failure);
    assert.equal(locked.wrongCode.lockedAfter, 5);
    assert.match(locked.failure, /10분간 잠겼습니다/);
    assert.equal(retried.ok, true);
    assert.equal(retried.wrongCode.attempts, 2);
    assert.equal(violated.violation.refused, true, "서버가 택 수 위반을 거절");
    assert.match(violated.violation.message, /정확히/);
    assert.equal(resubmitted.resubmitted, true);
    const okRecords = records.filter((record) => record.ok);
    assert.equal(okRecords.length, records.length - 1);
    assert.ok(okRecords.every((record) => /^\d{6}$/.test(record.newCode) && record.verified));
    assert.ok(okRecords.every((record) => Core.checkSelections(ctx.groups, record.selections).length === 0));

    // 교사 화면 경로로 대조: 저장한 선택이 그대로 있고, 잠금 현황이 오류 주입과 맞는다.
    const teacher = await ctx.call("get_teacher_course_applications", { p_event: ctx.event.id }, "authenticated", owner);
    for (const record of okRecords) {
      const entry = teacher.entries.find((item) => item.classroom === record.classroom && item.number === record.number);
      assert.ok(entry.submittedAt);
      assert.deepEqual([...entry.selections].sort(), [...record.selections].sort());
    }
    assert.equal(teacher.entries.filter((entry) => entry.submittedAt).length, okRecords.length);
    const locks = await ctx.call("get_course_code_locks", { p_event: ctx.event.id }, "authenticated", owner);
    assert.deepEqual(locks.students.map((student) => `${student.classroom}-${student.number}`).sort(),
      [locked, retried].map((record) => `${record.classroom}-${record.number}`).sort());
    assert.ok(locks.students.find((student) => student.number === locked.number && student.classroom === locked.classroom).lockedSeconds > 0);

    // 같은 학생을 바뀐 코드로 다시 돌리면 코드 변경 없이 재신청만 한다.
    const again = await Core.runVirtualStudent({ ...ctx.codes.students[5], grade: "1", code: records[5].newCode, plan: {} },
      { rpc: ctx.rpc, eventId: ctx.event.id, mode: "hardened", rng: Core.createRng(9), weights: new Map() });
    assert.equal(again.ok, true);
    assert.equal(again.newCode, "");
    const summary = Core.summarize(records);
    assert.equal(summary.locked, 1);
    assert.equal(summary.violationsRefused, 2);
    assert.ok(summary.requests > records.length * 4);
    const sheets = Core.resultSheets(records, { mode: "hardened" });
    assert.equal(sheets[0].rows.length, records.length + 1);
  } finally { await ctx.db.close(); }
});

test("test bot × 실제 SQL(예전 방식): 코드만으로 접속하고 규칙 위반은 예외로 거절된다", async () => {
  const ctx = await server({ hardened: false });
  try {
    const { detected, records } = await runBot(ctx, (index) => ({ wrongCodes: index === 0 ? 3 : 0, violate: index === 1 }), 3);
    assert.equal(detected.mode, "legacy");
    assert.ok(records.every((record) => record.ok), records.map((record) => record.failure).join(" | "));
    assert.ok(records.every((record) => !record.newCode));
    assert.equal(records[0].wrongCode.attempts, 3);
    assert.equal(records[0].wrongCode.lockedAfter, 0);
    assert.equal(records[1].violation.refused, true);
    const teacher = await ctx.call("get_teacher_course_applications", { p_event: ctx.event.id }, "authenticated", owner);
    assert.equal(teacher.entries.filter((entry) => entry.submittedAt).length, records.length);
  } finally { await ctx.db.close(); }
});

test("test bot: 배포본과 앱 화면에 연결되어 있고 학생 코드를 저장소에 남기지 않는다", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.match(html, /<a [^>]*href="test-bot\.html"[^>]*>수강신청 테스트봇<\/a>/);
  assert.match(html, /id="cloudSendTestBot"/);
  assert.match(html, /id="cloudAutoTest"/);
  assert.ok(html.indexOf('src="supabase-config.js') < html.indexOf('src="supabase-client.js'));
  const bot = fs.readFileSync(path.join(root, "test-bot.js"), "utf8");
  assert.match(bot, /^function columnIndex\(/m, "xlsx-parser.js가 쓰는 columnIndex를 봇 화면에서도 정의");
  const setItems = [...bot.matchAll(/localStorage\.setItem\(([^,]+),/g)].map((match) => match[1].trim());
  assert.deepEqual(setItems, ["OPTIONS_KEY"], "봇은 실행 설정만 저장한다");
  assert.doesNotMatch(bot, /indexedDB|sessionStorage/);
  const client = fs.readFileSync(path.join(root, "supabase-client.js"), "utf8");
  assert.doesNotMatch(client, /hapfkdkbhnqpfjdepozv/, "서버 주소는 supabase-config.js 한 곳에만");
  const { referencedFiles } = require("../scripts/build-deploy.js");
  const files = referencedFiles(html);
  for (const file of ["test-bot.html", "test-bot.js", "test-bot-core.js", "test-bot-bridge.js", "supabase-config.js"]) {
    assert.ok(files.includes(file), `${file} 배포 포함`);
  }
  // 앱이 다시 연결용으로 탭 sessionStorage에 두는 값에는 학생 코드가 없다.
  const link = client.slice(client.indexOf("function saveTestBotLink"), client.indexOf("const savedTestBotLink"));
  assert.match(link, /sessionStorage\.setItem\(TEST_BOT_LINK_KEY/);
  assert.doesNotMatch(link, /students|code:|payload/);
  assert.match(html, /id="testBotAutoRepeat"[^>]*min="1"[^>]*max="20"[^>]*value="1"/);
  assert.match(html, /id="testBotAutoFresh" type="checkbox">/);
  const botHtml = fs.readFileSync(path.join(root, "test-bot.html"), "utf8");
  assert.match(botHtml, /id="botRepeat"[^>]*min="1"[^>]*max="20"[^>]*value="1"/);
  assert.match(botHtml, /id="botRepeatFresh" type="checkbox">/);
});

// ---------- 반복 실행(회차) ----------
test("test bot 반복: 회차 계획·코드 이어받기·회차별 오류 주입·반복 설정 전달", () => {
  assert.deepEqual(Core.normalizeRepeat({ count: 0 }), { count: 1, freshEvent: false });
  assert.deepEqual(Core.normalizeRepeat({ count: "99", freshEvent: true }), { count: 20, freshEvent: true });
  assert.deepEqual(Core.normalizeRepeat({ count: "abc" }), { count: 1, freshEvent: false });

  const same = Core.repeatPlan({ count: 3 }, "ask");
  assert.deepEqual(same.map((plan) => [plan.round, plan.createEvent, plan.firstLogin, plan.injectWrongCodes, plan.unlockBefore, plan.cleanup]), [
    [1, false, true, true, false, "none"],
    [2, false, false, false, true, "none"],
    [3, false, false, false, true, "ask"],
  ], "같은 신청: 1회차만 첫 접속·틀린 코드, 2회차부터 잠금 해제 후 재신청, 정리는 마지막 회차 뒤 한 번");
  const fresh = Core.repeatPlan({ count: 3, freshEvent: true }, "keep");
  assert.deepEqual(fresh.map((plan) => [plan.createEvent, plan.firstLogin, plan.injectWrongCodes, plan.unlockBefore, plan.cleanup]), [
    [false, true, true, false, "delete"], [true, true, true, false, "delete"], [true, true, true, false, "delete"],
  ], "새 신청: 2회차부터 새로 만들고, 정리 설정과 관계없이 회차마다 닫고 삭제");

  const students = Core.generateRoster({ grade: "1", classes: 2, perClass: 5 }).map((student, index) => ({ ...student, code: String(100000 + index) }));
  const records = [{ grade: "1", classroom: "1", number: "2", newCode: "482915" }, { grade: 1, classroom: 2, number: 1, newCode: "" }];
  const carried = Core.carryCodes(students, records);
  assert.equal(carried.find((student) => student.classroom === "1" && student.number === "2").code, "482915");
  assert.equal(carried.find((student) => student.classroom === "2" && student.number === "1").code, students[5].code, "바뀌지 않은 학생은 그대로");
  assert.equal(students[1].code, "100001", "원래 목록은 바꾸지 않는다");

  const opts = { wrongCodePercent: 100, wrongCodeTimes: 5, violationPercent: 50, resubmitPercent: 0 };
  const first = Core.roundTargets(carried, same[0], opts, Core.createRng(1));
  assert.ok(first.every((student) => student.plan.wrongCodes === 5));
  const second = Core.roundTargets(carried, same[1], opts, Core.createRng(1), new Set(["1-1-1"]));
  assert.equal(second.length, 9, "해제하지 못한 잠긴 학생은 뺀다");
  assert.ok(second.every((student) => student.plan.wrongCodes === 0), "틀린 코드는 첫 회차에만");
  assert.equal(second.filter((student) => student.plan.violate).length, 5, "규칙 위반은 회차마다 다시 고른다");
  assert.equal(second.find((student) => student.number === "2" && student.classroom === "1").code, "482915", "2회차는 바뀐 코드로 접속");

  // 교사 화면 대조: 이전 회차 저장분은 유지, 불확실한 학생은 뺀다.
  const expected = new Map();
  const uncertain = new Set();
  Core.updateExpected(expected, uncertain, [
    { grade: "1", classroom: "1", number: "1", name: "가", verified: true, selections: ["물리학", "기하"], status: "완료" },
    { grade: "1", classroom: "1", number: "2", name: "나", verified: false, selections: [], status: "확인 실패" },
  ]);
  const entries = [
    { grade: "1", classroom: "1", number: "1", name: "가", submittedAt: "t", selections: ["기하", "물리학"] },
    { grade: "1", classroom: "1", number: "2", name: "나", submittedAt: "t", selections: ["화학"] },
  ];
  const keys = new Set(["1-1-1", "1-1-2"]);
  assert.equal(Core.compareTeacherApplications({ entries, expected, uncertain, targetKeys: keys }).problems, 0);
  const wrong = Core.compareTeacherApplications({ entries: [{ ...entries[0], selections: ["화학", "기하"] }], expected, uncertain, targetKeys: keys });
  assert.deepEqual(wrong.mismatched, ["1-1 가"]);
  assert.deepEqual(wrong.courseDiff.sort(), ["물리학", "화학"]);
  // '폐강 신청 학생만' 재신청: 대상이 아닌 학생의 기존 결과는 '예상 밖 신청'(실패)이 아니라 '유지(대상 아님)'.
  const others = [...entries, { grade: "1", classroom: "1", number: "3", name: "다", submittedAt: "t", selections: ["지구과학"] }];
  const scope = new Set([...keys, "1-1-3"]);
  const wrongly = Core.compareTeacherApplications({ entries: others, expected, uncertain, targetKeys: scope });
  assert.equal(wrongly.extra.length, 1, "예전 판정: 대상 아닌 학생을 예상 밖으로 셌다");
  const kept = Core.compareTeacherApplications({ entries: others, expected, uncertain, targetKeys: scope, keptKeys: new Set(["1-1-3"]) });
  assert.equal(kept.problems, 0);
  assert.equal(kept.kept, 1);
  assert.deepEqual(kept.extra, []);
  assert.deepEqual(kept.courseDiff, [], "유지 학생 과목은 과목별 인원 대조에서도 뺀다");

  // 회차 사이 변화
  const rows = [1, 2, 3].map((round) => ({ round, averageMs: round < 3 ? 20 : 80, maxMs: 50, failed: round === 2 ? 1 : 0, mismatches: 0 }));
  const notes = Core.compareRounds(rows);
  assert.match(notes[0], /^3회차부터 평균 응답 시간 증가\(1회차 20ms → 3회차 80ms\)/);
  assert.ok(notes.some((note) => /2회차부터 실패 발생/.test(note)));
  assert.ok(notes.some((note) => /대조한 3개 회차 모두 일치/.test(note)));

  // 앱 설정 창의 반복 설정이 봇으로 전달된다.
  const eventId = "0b0c6c0e-4a8e-4f1f-9a51-2b1c3d4e5f60";
  const one = { id: eventId, students: [{ grade: "1", classroom: "1", number: "1", code: "482915" }] };
  const payload = Bridge.validatePayload({ ...Bridge.buildPayload(one), autoRun: true, repeat: { count: 50, freshEvent: true } });
  assert.deepEqual(payload.repeat, { count: 20, freshEvent: true });
  assert.equal(Bridge.validatePayload(Bridge.buildPayload(one)).repeat, null);
  for (const action of ["session", "unlock", "create"]) assert.ok(Bridge.TEACHER_ACTIONS.includes(action));
});

function stepStatus(round, key) {
  return round.steps.find((step) => step.key === key).status;
}

// 앱 창 역할(교사 화면 요청)을 PGlite 실제 SQL로 흉내 낸다.
function teacherWindow(ctx, { expireAt = new Set() } = {}) {
  const calls = [];
  const created = [];
  let sessionChecks = 0;
  const teacher = async (action, { eventId }) => {
    calls.push(`${action}:${eventId.slice(0, 8)}`);
    if (action === "session") return { loggedIn: !expireAt.has(++sessionChecks) };
    if (action === "applications") return ctx.call("get_teacher_course_applications", { p_event: eventId }, "authenticated", owner);
    if (action === "locks") return ctx.call("get_course_code_locks", { p_event: eventId }, "authenticated", owner);
    if (action === "unlock") return ctx.call("unlock_course_event", { p_event: eventId }, "authenticated", owner);
    if (action === "close" || action === "delete") return ctx.call("manage_course_event", { p_event: eventId, p_action: action }, "authenticated", owner);
    if (action === "create") {
      const event = await ctx.call("create_course_event", { p_setup: ctx.setup }, "authenticated", owner);
      created.push(event.id);
      return { ...Bridge.buildPayload(event, { schoolName: ctx.setup.schoolName, schoolYear: "2099", round: "1" }, ""), testEvent: true };
    }
    throw new Error(`처리하지 않는 요청 ${action}`);
  };
  return { teacher, calls, created };
}
const freshStudents = (ctx) => ctx.codes.students.map((student) => ({ ...student, grade: String(student.grade) }));

test("test bot 반복 × 실제 SQL(새 방식): 같은 신청 3회 — 바뀐 코드로 재접속·재신청, 잠긴 학생 교사 해제, 회차마다 교사 화면 대조 일치", async () => {
  const ctx = await server({ hardened: true });
  try {
    // 두 번째 세션 확인에서 로그인이 끝난 것으로 답한다 → 봇은 다시 로그인할 때까지 기다렸다가 이어서 진행해야 한다.
    const window = teacherWindow(ctx, { expireAt: new Set([2]) });
    const waits = [];
    const roundsEnded = [];
    const report = await Core.runRepeatedTest({
      source: { eventId: ctx.event.id, students: freshStudents(ctx), testEvent: true },
      opts: { scope: "all", concurrency: 4, wrongCodePercent: 20, wrongCodeTimes: 5, violationPercent: 20, resubmitPercent: 20,
        teacherCheck: true, cleanup: "close", popularity: "skewed" },
      repeat: { count: 3 }, auto: true, connected: true,
    }, {
      rpc: ctx.rpc, rng: Core.createRng(21), teacher: window.teacher,
      waitForTeacher: async (reason) => { waits.push(reason); return true; },
      onRoundEnd: (round) => roundsEnded.push(round.round),
    });
    assert.equal(report.error, "");
    assert.deepEqual(roundsEnded, [1, 2, 3]);
    assert.equal(waits.length, 1, "로그인이 끝나면 기다렸다가 이어서 진행");
    const [one, two, three] = report.rounds;
    for (const round of report.rounds) {
      assert.equal(round.status, "done", `${round.round}회차: ${round.steps.filter((step) => step.status === "fail").map((step) => `${step.name} ${step.actual}`).join(" | ")}`);
      assert.equal(round.eventId, ctx.event.id, "테스트 수강신청은 하나");
      assert.equal(round.teacher.problems, 0, `${round.round}회차 교사 화면 대조`);
    }
    const lockedKeys = one.records.filter((record) => record.status === "잠김 확인").map((record) => `${record.classroom}-${record.number}`);
    assert.equal(lockedKeys.length, 2, "12명 중 20% → 2명 잠김 확인");
    assert.equal(one.records.filter((record) => record.newCode).length, 10, "1회차: 잠기지 않은 학생 모두 첫 접속 코드 변경");
    assert.equal(stepStatus(one, "locks"), "pass");
    // 2회차: 잠긴 학생은 교사 해제 → 첫 접속(코드 변경)부터, 나머지는 바뀐 코드로 재접속(코드 변경 없음)
    assert.equal(stepStatus(two, "unlock"), "pass");
    assert.match(two.steps.find((step) => step.key === "unlock").actual, /2명/);
    assert.equal(stepStatus(two, "locks"), "pass", "해제 뒤 잠김·실패 기록 0명");
    assert.equal(two.records.length, 12);
    assert.deepEqual(two.records.filter((record) => record.newCode).map((record) => `${record.classroom}-${record.number}`).sort(), lockedKeys.sort());
    assert.ok(two.records.every((record) => record.ok && !record.wrongCode));
    assert.equal(stepStatus(three, "unlock"), "skip");
    assert.ok(three.records.every((record) => record.ok && !record.newCode), "3회차: 모두 바뀐 코드로 재접속");
    const changed = three.records.filter((record) => {
      const before = two.records.find((item) => item.classroom === record.classroom && item.number === record.number);
      return before.selections.slice().sort().join() !== record.selections.slice().sort().join();
    });
    assert.ok(changed.length > 0, "새 무작위 선택으로 재신청");
    // 정리는 마지막 회차 뒤 한 번(닫기)
    assert.deepEqual(report.rounds.map((round) => stepStatus(round, "cleanup")), ["skip", "skip", "pass"]);
    assert.equal(window.calls.filter((call) => call.startsWith("close:")).length, 1);
    assert.equal(window.calls.filter((call) => call.startsWith("unlock:")).length, 1);
    // 서버에 남은 신청 = 3회차 선택
    const teacher = await ctx.call("get_teacher_course_applications", { p_event: ctx.event.id }, "authenticated", owner);
    for (const record of three.records) {
      const entry = teacher.entries.find((item) => item.classroom === record.classroom && item.number === record.number);
      assert.deepEqual([...entry.selections].sort(), [...record.selections].sort());
    }
    // 보고서: 회차별 표·합계·변화, 엑셀 시트
    const summary = Core.repeatSummary(report);
    assert.deepEqual(summary.rows.map((row) => [row.round, row.status, row.ok, row.locked, row.mismatches]), [
      [1, "통과", 10, 2, 0], [2, "통과", 12, 0, 0], [3, "통과", 12, 0, 0]]);
    assert.equal(summary.totals.ok, 34);
    assert.ok(summary.trends.some((note) => /대조한 3개 회차 모두 일치/.test(note)));
    const sheets = Core.repeatReportSheets(report);
    assert.deepEqual(sheets.map((sheet) => sheet.name), ["회차별 요약", "단계별 결과", "학생별 결과", "요약"]);
    assert.equal(sheets[0].rows[4][0], "합계(끝난 3회차)");
    assert.equal(sheets[2].rows.length, 1 + 12 * 3);
    assert.equal(sheets[2].rows[0][0], "회차");
    assert.ok(sheets[3].rows.some((row) => row[0] === "반복" && /3회/.test(row[1])));
    assert.equal(Buffer.from(Core.createXlsxBytes(sheets)).subarray(0, 2).toString(), "PK");
  } finally { await ctx.db.close(); }
});

test("test bot 반복 × 실제 SQL: 회차마다 새 수강신청 — 회차마다 만들고 닫고 삭제해 테스트 신청이 쌓이지 않는다", async () => {
  const ctx = await server({ hardened: true });
  try {
    const window = teacherWindow(ctx);
    const events = [];
    const report = await Core.runRepeatedTest({
      source: { eventId: ctx.event.id, students: freshStudents(ctx), testEvent: true },
      opts: { scope: "all", concurrency: 3, wrongCodePercent: 10, wrongCodeTimes: 5, teacherCheck: true, cleanup: "keep", popularity: "uniform" },
      repeat: { count: 3, freshEvent: true }, auto: true, connected: true, canCreate: true,
    }, {
      rpc: ctx.rpc, rng: Core.createRng(4), teacher: window.teacher,
      acceptCreated: (data) => Bridge.validatePayload(data),
      onEvent: (created) => events.push(created.eventId),
    });
    assert.equal(report.repeat.freshEvent, true);
    assert.equal(window.created.length, 2, "2회차부터 회차마다 새 신청");
    assert.deepEqual(events, window.created);
    const ids = report.rounds.map((round) => round.eventId);
    assert.equal(new Set(ids).size, 3);
    for (const round of report.rounds) {
      assert.equal(round.status, "done", `${round.round}회차: ${round.steps.filter((step) => step.status === "fail").map((step) => `${step.name} ${step.actual}`).join(" | ")}`);
      assert.equal(round.records.filter((record) => record.newCode).length, round.records.filter((record) => record.ok).length, "새 신청마다 첫 접속 코드 변경");
      assert.equal(round.teacher.problems, 0);
      assert.equal(stepStatus(round, "locks"), "pass", "새 신청마다 틀린 코드·잠금 확인");
      assert.match(round.steps.find((step) => step.key === "cleanup").actual, /삭제/, "정리 설정(그대로 두기)과 관계없이 삭제");
    }
    assert.deepEqual(window.calls.filter((call) => /^(close|delete):/.test(call)), ids.flatMap((id) => [`close:${id.slice(0, 8)}`, `delete:${id.slice(0, 8)}`]));
    await ctx.db.exec("reset role");
    assert.equal((await ctx.db.query("select count(*)::int n from public.course_events")).rows[0].n, 0, "테스트 신청이 남지 않음");
    const sheets = Core.repeatReportSheets(report);
    assert.ok(sheets[3].rows.some((row) => row[0] === "반복" && /회차마다 새 수강신청/.test(row[1])));

    // 앱 연결이 없거나 앱 자동 테스트가 아니면 새 신청 방식은 쓰지 않고 같은 신청으로 반복한다(보고서에 알림).
    const fallback = await Core.runRepeatedTest({ source: { eventId: ctx.event.id, students: [], testEvent: false }, opts: {}, repeat: { count: 2, freshEvent: true } }, { rpc: ctx.rpc });
    assert.equal(fallback.repeat.freshEvent, false);
    assert.match(fallback.notes[0], /같은 수강신청으로 반복/);
  } finally { await ctx.db.close(); }
});

test("test bot 반복: 중지하면 끝난 회차까지 보고서를 만들고, 새 신청 방식은 그 회차 신청도 지운다", async () => {
  const ctx = await server({ hardened: true });
  try {
    const window = teacherWindow(ctx);
    const controller = new AbortController();
    let processed = 0;
    const report = await Core.runRepeatedTest({
      source: { eventId: ctx.event.id, students: freshStudents(ctx), testEvent: true },
      opts: { scope: "all", concurrency: 1, teacherCheck: true, cleanup: "close" },
      repeat: { count: 3, freshEvent: true }, auto: true, connected: true, canCreate: true,
    }, {
      rpc: ctx.rpc, rng: Core.createRng(8), teacher: window.teacher, signal: controller.signal,
      acceptCreated: (data) => Bridge.validatePayload(data),
      onRecord: (record, round) => { if (round.round === 2 && ++processed === 3) controller.abort(); },
    });
    assert.equal(report.stopped, true);
    assert.deepEqual(report.rounds.map((round) => round.status), ["done", "stopped"]);
    const summary = Core.repeatSummary(report);
    assert.equal(summary.totals.rounds, 1, "합계는 끝난 회차만");
    assert.match(summary.rows[1].status, /^중지됨\(끝나지 않음 · 처리 \d+\/12명\)$/);
    assert.equal(summary.rows[1].failed, 0, "중지로 끊긴 학생은 실패로 세지 않는다");
    assert.ok(report.rounds[1].records.length < 12);
    assert.match(report.rounds[1].steps.find((step) => step.key === "cleanup").actual, /중지했지만 이 회차 신청을 정리/);
    await ctx.db.exec("reset role");
    assert.equal((await ctx.db.query("select count(*)::int n from public.course_events")).rows[0].n, 0);
  } finally { await ctx.db.close(); }
});

test("test bot 정리: 끝나면 묻기 — 앱이 만든 [테스트] 신청은 확인 창 기본 선택이 '닫고 삭제'(창에 N차 테스트 표시)", async () => {
  const ctx = await server({ hardened: true });
  try {
    const window = teacherWindow(ctx);
    const asked = [];
    const report = await Core.runRepeatedTest({
      source: { eventId: ctx.event.id, students: freshStudents(ctx), testEvent: true },
      opts: { scope: "all", concurrency: 3, teacherCheck: true, cleanup: "ask" },
      repeat: { count: 1 }, auto: true, connected: true,
    }, {
      rpc: ctx.rpc, rng: Core.createRng(5), teacher: window.teacher,
      askCleanup: async (info) => { asked.push(info); return info.testEvent ? "delete" : "close"; },
    });
    assert.equal(report.rounds[0].status, "done");
    assert.equal(asked.length, 1, "확인 창은 그대로 묻는다");
    assert.equal(asked[0].testEvent, true);
    assert.match(String(asked[0].round), /^\d+$/, "확인 창에 몇 차 테스트인지 넘긴다");
    assert.deepEqual(window.calls.filter((call) => /^(close|delete):/.test(call)), [`close:${ctx.event.id.slice(0, 8)}`, `delete:${ctx.event.id.slice(0, 8)}`]);
  } finally { await ctx.db.close(); }
  // 화면: 앱 [테스트] 신청이면 '닫고 삭제(기본)'에 초점, 그 밖의 신청이면 '닫기만(기본)'. Esc는 지우지 않는 '닫기만'.
  const html = fs.readFileSync(path.join(root, "test-bot.html"), "utf8");
  assert.match(html, /id="botCleanupDelete" type="button" autofocus>닫고 삭제\(기본\)</);
  const js = fs.readFileSync(path.join(root, "test-bot.js"), "utf8");
  assert.match(js, /const preferred = testEvent \? "delete" : "close";/);
  assert.match(js, /addEventListener\("cancel", \(\) => finish\("close"\)/);
});

test("test bot: 폐강 학생만 재신청에서 대상 아닌 학생은 실패가 아니라 '대상 아님'으로 따로 센다", async () => {
  const replies = {
    target: { open: true, reselectionAllowed: true, courses: [{ subject: "물리학" }, { subject: "화학" }],
      groups: [{ name: "택1", semester: "1", count: 1, courses: ["물리학", "화학"] }], selections: [] },
    other: { open: false, reselectionAllowed: false, courses: [], groups: [], selections: ["물리학"] },
    closed: { open: false, courses: [], groups: [], selections: [] },
  };
  const make = (kind, number) => {
    const saved = { selections: [] };
    const rpc = async (name, args) => {
      if (name === "save_course_selection" || /save/.test(name)) { saved.selections = args.p_selections || []; return { data: { ok: true }, ms: 1 }; }
      return { data: { ...replies[kind], selections: kind === "target" ? saved.selections : replies[kind].selections }, ms: 1 };
    };
    return Core.runVirtualStudent({ grade: "1", classroom: "1", number: String(number), name: `가상${number}`, code: "123456", plan: {} },
      { rpc, eventId: "e", mode: "hardened", rng: Core.createRng(1) });
  };
  const records = [await make("target", 1), await make("other", 2), await make("other", 3), await make("closed", 4)];
  assert.equal(records[0].ok, true, records[0].failure);
  assert.equal(records[1].status, "대상 아님");
  assert.equal(records[1].ok, false);
  assert.equal(records[3].status, "접수 마감", "대상 표시 없이 닫힌 신청은 여전히 실패");
  const summary = Core.summarize(records);
  assert.equal(summary.skipped, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.reasons.some(([reason]) => reason.includes("재선택 대상")), false);
  const info = Core.resultSheets(records).find((sheet) => sheet.name === "요약").rows;
  assert.deepEqual(info.find((row) => row[0] === "대상 아님(건너뜀)"), ["대상 아님(건너뜀)", 2]);
});

test("test bot: 대상 범위 한 줄(반 번호는 이어지면 1~10으로 줄이고 인원 표시)", () => {
  const students = Array.from({ length: 12 }, (_, index) => ({ grade: "1", classroom: String(index + 1), number: "1" }));
  assert.deepEqual(Core.scopeSummary({ scope: "class", classes: "1,2,3,4,5,6,7,8,9,10" }, students), { limited: true, text: "대상: 1~10반 · 10명(전체 12명 중)" });
  assert.deepEqual(Core.scopeSummary({ scope: "class", classes: "3, 1 2, 7" }), { limited: true, text: "대상: 1~3, 7반" });
  assert.deepEqual(Core.scopeSummary({ scope: "first", count: 10 }, students), { limited: true, text: "대상: 처음 10명 · 10명(전체 12명 중)" });
  assert.deepEqual(Core.scopeSummary({ scope: "all" }, students), { limited: false, text: "대상: 전체 · 12명" });
  assert.deepEqual(Core.scopeSummary({}), { limited: false, text: "대상: 전체" });
  assert.deepEqual(Core.scopeSummary({ scope: "class", classes: "" }, students), { limited: true, text: "대상: 반 지정 없음 · 0명(전체 12명 중)" });
});

test("회차별 결과: '실패 단계 n개'에는 실패한 단계 이름과 사유(실제값)를 함께 적고, 사유가 비면 그렇다고 적는다", () => {
  const step = (key, name, status, actual = "") => ({ key, name, status, expected: "", actual, ms: 0 });
  const round = (number, steps) => ({ round: number, eventId: "e", status: "failed", steps, records: [], targets: [{}, {}] });
  const report = { meta: {}, repeat: { count: 2, freshEvent: false }, notes: [], rounds: [
    round(1, [step("students", "재신청", "pass", "성공 2명"), step("teacher", "교사 화면 대조", "fail", "학생 불일치 1명 (2-1-3)")]),
    round(2, [step("students", "재신청", "fail", "")])
  ] };
  const { rows } = Core.repeatSummary(report);
  assert.match(rows[0].status, /^실패 단계 1개 — 교사 화면 대조: 학생 불일치 1명 \(2-1-3\)$/);
  assert.match(rows[1].status, /^실패 단계 1개 — 재신청: 실패 사유가 기록되지 않았습니다/);
  assert.equal(rows[0].failures.length, 1);
});

test("테스트봇 화면: 회차별 결과 칸과 진행 문구는 길면 줄바꿈(잘리지 않게)", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "test-bot.html"), "utf8");
  assert.match(html, /\.bot-round-table td:nth-child\(2\) \{ white-space:normal;/);
  assert.match(html, /#botProgressText \{ overflow-wrap:anywhere; \}/);
});
