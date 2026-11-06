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
  const event = await call("create_course_event", { p_setup: { type: "course-application-setup", schoolName: "[테스트] 가상고",
    schoolYear: "2099", round: "1", subjects: { "1": [], "2": subjects, "3": [] }, groups, roster } }, "authenticated", owner);
  let codes = event;
  if (hardened) {
    await db.exec("reset role");
    await db.exec(sql("proposed", "01-code-hardening.sql"));
    codes = await call("manage_course_event", { p_event: event.id, p_action: "codes" }, "authenticated", owner);
  }
  const rpc = Core.createRpcClient({ projectUrl: "https://fake.supabase.co", publicKey: "k", fetchImpl });
  return { db, call, rpc, event, codes, groups };
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
});
