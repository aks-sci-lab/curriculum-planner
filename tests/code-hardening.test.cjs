const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { PGlite } = require("@electric-sql/pglite");

const sql = (...parts) => fs.readFileSync(path.join(__dirname, "..", "supabase", ...parts), "utf8");
const chain = ["setup.sql", "upgrade-codes-history.sql", "upgrade-stable-student-ids.sql",
  "upgrade-selection-groups.sql", "upgrade-semester-groups.sql", "upgrade-application-rounds.sql",
  "upgrade-teacher-selections.sql", "upgrade-academic-year-access.sql", "upgrade-reselection.sql"];
const owner = "11111111-1111-1111-1111-111111111111";
const other = "22222222-2222-2222-2222-222222222222";
const WRONG = "반·번호 또는 코드가 맞지 않습니다.";

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as
      'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
    grant usage on schema auth to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;
    insert into auth.users values ('${owner}'),('${other}');
  `);
  for (const file of chain) await db.exec(sql(file));
  const as = async (role, user = "", ip = "10.0.0.1") => {
    await db.exec(`reset role; set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
    await db.query("select set_config('request.headers',$1,false)", [JSON.stringify({ "x-real-ip": ip })]);
  };
  const call = async (query, params) => Object.values((await db.query(query, params)).rows[0])[0];
  const login = (event, s, code, grade = "") => call("select public.get_student_course_application($1,$2,$3,$4,$5)",
    [event, grade, String(s.classroom), String(s.number), code]);
  const save = (event, s, code, picks) => call("select public.save_student_course_application($1,'',$2,$3,$4,$5::jsonb)",
    [event, String(s.classroom), String(s.number), code, JSON.stringify(picks)]);
  const change = (event, s, code, next, grade = "") => call("select public.change_course_code($1,$2,$3,$4,$5,$6)",
    [event, grade, String(s.classroom), String(s.number), code, next]);
  const expire = async (studentId) => {
    await db.exec("reset role");
    await db.query("update public.course_code_locks set locked_until = clock_timestamp() - interval '1 second' where student_id=$1", [studentId]);
    await as("anon");
  };
  return { db, as, call, login, save, change, expire };
}

async function createEvent({ call, as }, roster) {
  await as("authenticated", owner);
  const subjects = ["A", "B", "C"].map((subject) => ({ subject, credit: 3, semester: "1" }));
  const setupJson = {
    type: "course-application-setup", schoolName: "학교", schoolYear: "2099", round: "1",
    subjects: { "2": subjects, "3": subjects },
    groups: ["2", "3"].map((grade) => ({ id: `g${grade}`, grade, semester: "1", name: "선택", count: 1, courses: ["A", "B", "C"] })),
    roster: roster || [1, 2, 3].map((n) => ({ grade: "1", classroom: "1", number: String(n), name: `학생${n}`, studentId: `10${n}` })),
  };
  return call("select public.create_course_event($1::jsonb)", [JSON.stringify(setupJson)]);
}

async function hardened(ctx, roster) {
  const event = await createEvent(ctx, roster);
  await ctx.db.exec("reset role"); await ctx.db.exec(sql("proposed", "01-code-hardening.sql"));
  await ctx.as("authenticated", owner);
  const issued = await ctx.call("select public.manage_course_event($1,'codes')", [event.id]);
  await ctx.as("anon");
  return { event, issued };
}

// 학생이 받은 코드를 첫 접속에서 바꿔 둔 상태로 만든다.
async function changed(ctx, event, student, next) {
  assert.match((await ctx.change(event.id, student, student.code, next)).message, /변경했습니다/);
  return { ...student, code: next };
}

test("hardening: 반·번호+코드로 접속하고 첫 접속에서 코드를 바꾸며 해시는 학생별로 다르다", async () => {
  const ctx = await setup();
  const { db, as, call, login, save, change } = ctx;
  try {
    const { event, issued } = await hardened(ctx);
    assert.equal(issued.students.length, 3);
    const [first, second] = issued.students;
    assert.match(first.code, /^\d{6}$/);

    await db.exec("reset role");
    const stored = (await db.query("select code_hash, code_hmac from public.course_students where id=$1", [first.id])).rows[0];
    const plain = crypto.createHash("sha256").update(first.code).digest("hex");
    assert.notEqual(stored.code_hash, plain);
    assert.notEqual(stored.code_hmac, plain);
    const unsalted = (await db.query("select count(*)::int n from public.course_students where code_hash = any($1)", [
      issued.students.map((s) => crypto.createHash("sha256").update(s.code).digest("hex"))])).rows[0].n;
    assert.equal(unsalted, 0);
    const leftovers = (await db.query("select to_regclass('public.course_code_failures') t, to_regprocedure('public.course_client_key()') f")).rows[0];
    assert.equal(leftovers.t, null, "접속지(IP) 기준 테이블은 만들지 않는다");
    assert.equal(leftovers.f, null);

    await as("anon");
    // 코드만 넣는 예전 입구로는 6자리 코드를 확인할 수 없다.
    assert.match((await call("select public.get_scoped_course_application($1,$2)", [event.id, first.code])).error, /반·번호/);
    assert.match((await call("select public.save_scoped_course_application($1,$2,'[\"A\"]')", [event.id, first.code])).error, /반·번호/);

    const form = await call("select public.get_course_login_form($1)", [event.id]);
    assert.deepEqual(form.grades, ["1"]);
    assert.equal(form.schoolName, "학교");
    assert.equal(form.student, undefined);

    const firstLogin = await login(event.id, { classroom: "01", number: " 1 " }, first.code);
    assert.equal(firstLogin.mustChangeCode, true);
    assert.equal(firstLogin.student.name, first.name);
    assert.equal(firstLogin.courses, undefined);
    assert.match((await save(event.id, first, first.code, ["A"])).error, /변경/);

    assert.match((await change(event.id, first, first.code, "12345")).error, /6자리/);
    assert.match((await change(event.id, first, first.code, "111111")).error, /쉬운/);
    assert.match((await change(event.id, first, first.code, first.code)).error, /다른 새 코드/);
    const a = await changed(ctx, event, first, "482915");
    // 반·번호로 학생을 구분하므로 다른 학생과 같은 코드를 골라도 된다.
    const b = await changed(ctx, event, second, "482915");

    assert.equal((await login(event.id, first, first.code)).error, WRONG);
    const opened = await login(event.id, a, a.code);
    assert.equal(opened.mustChangeCode, undefined);
    assert.equal(opened.student.name, first.name);
    assert.equal(opened.courses.length, 3);
    assert.equal((await login(event.id, b, b.code)).student.name, second.name);
    assert.match((await save(event.id, a, a.code, ["B"])).message, /저장/);
    assert.match((await change(event.id, a, a.code, "739204")).error, /이미 코드를 변경/);
    await db.exec("reset role");
    const kept = (await db.query("select selections from public.course_students where id=$1", [first.id])).rows[0].selections;
    assert.deepEqual(kept, ["B"]);
    const hashes = (await db.query("select code_hmac from public.course_students where id = any($1)", [[first.id, second.id]])).rows;
    assert.notEqual(hashes[0].code_hmac, hashes[1].code_hmac, "같은 코드도 학생마다 해시가 다르다");
  } finally { await db.close(); }
});

test("hardening: 학생 단위 잠금 — 5회 → 10분, 시간 경과 후 해제, 누적 10회 뒤 실패 → 교사 해제", async () => {
  const ctx = await setup();
  const { db, as, call, login, expire } = ctx;
  try {
    const { event, issued } = await hardened(ctx);
    const first = await changed(ctx, event, issued.students[0], "482915");
    const second = await changed(ctx, event, issued.students[1], "739204");

    // 없는 반·번호와 틀린 코드는 같은 문구, 없는 학생의 실패는 기록하지 않는다.
    const ghost = await login(event.id, { classroom: "9", number: "40" }, "000009");
    assert.deepEqual(ghost, { error: WRONG });
    for (let i = 0; i < 9; i++) assert.deepEqual(await login(event.id, { classroom: "9", number: "40" }, "000009"), { error: WRONG });

    for (let i = 0; i < 4; i++) assert.deepEqual(await login(event.id, first, "000009"), { error: WRONG });
    const fifth = await login(event.id, first, "000009");
    assert.equal(fifth.locked, true);
    assert.match(fifth.error, /5회 연속 실패해 10분간 잠겼습니다/);
    assert.match(fifth.error, /약 10분 뒤/);
    // 잠긴 동안에는 올바른 코드도 거부(대입 계속 차단).
    assert.match((await login(event.id, first, first.code)).error, /잠겼/);
    // 다른 학생은 같은 접속지라도 영향 없음.
    assert.equal((await login(event.id, second, second.code)).student.name, second.name);

    await db.exec("reset role");
    const rows = (await db.query("select s.classroom, s.number, l.fail_total from public.course_code_locks l join public.course_students s on s.id=l.student_id")).rows;
    assert.deepEqual(rows, [{ classroom: "1", number: "1", fail_total: 5 }], "실패 기록은 실제 학생에게만 남는다");

    // 교사 화면: 남은 시간 표시.
    await as("authenticated", owner);
    let locks = await call("select public.get_course_code_locks($1)", [event.id]);
    assert.equal(locks.students.length, 1);
    assert.equal(locks.students[0].name, first.name);
    assert.ok(locks.students[0].lockedSeconds > 500 && locks.students[0].lockedSeconds <= 600);
    assert.equal(locks.students[0].teacherLock, false);

    // 10분 경과 → 자동 해제, 성공하면 연속 실패 수 초기화.
    await expire(first.id);
    assert.equal((await login(event.id, first, first.code)).student.name, first.name);

    // 두 번째 10분 잠금(누적 10회): 다음 실패는 교사 해제 필요라고 안내.
    for (let i = 0; i < 4; i++) assert.deepEqual(await login(event.id, first, "000009"), { error: WRONG });
    const second10 = await login(event.id, first, "000009");
    assert.match(second10.error, /10분간 잠겼습니다/);
    assert.match(second10.error, /선생님이 풀어 주실 때까지/);
    await expire(first.id);
    const final = await login(event.id, first, "000009");
    assert.equal(final.locked, true);
    assert.match(final.error, /선생님께 잠금 해제를 요청하세요/);
    assert.doesNotMatch(final.error, /분 뒤/);
    await expire(first.id);
    assert.match((await login(event.id, first, first.code)).error, /선생님께 잠금 해제/, "시간이 지나도 풀리지 않는다");

    await as("authenticated", owner);
    locks = await call("select public.get_course_code_locks($1)", [event.id]);
    assert.equal(locks.students[0].teacherLock, true);
    assert.equal(locks.students[0].failTotal, 11);
    assert.equal(locks.students[0].lockCount, 2);

    // 교사 해제는 소유자만.
    await as("authenticated", other);
    await assert.rejects(() => db.query("select public.unlock_course_student($1,$2)", [event.id, first.id]), /본인이 만든/);
    await assert.rejects(() => db.query("select public.get_course_code_locks($1)", [event.id]), /본인이 만든/);
    await assert.rejects(() => db.query("select public.unlock_course_event($1)", [event.id]), /본인이 만든/);
    await as("anon");
    await assert.rejects(() => db.query("select public.unlock_course_student($1,$2)", [event.id, first.id]), /permission denied/);

    await as("authenticated", owner);
    assert.match((await call("select public.unlock_course_student($1,$2)", [event.id, first.id])).message, /1반 1번 .* 잠금을 해제/);
    assert.deepEqual((await call("select public.get_course_code_locks($1)", [event.id])).students, []);
    await as("anon");
    assert.equal((await login(event.id, first, first.code)).student.name, first.name);
    // 해제 후에는 다시 5회 → 10분부터 시작.
    for (let i = 0; i < 4; i++) assert.deepEqual(await login(event.id, first, "000009"), { error: WRONG });
    assert.match((await login(event.id, first, "000009")).error, /10분간 잠겼습니다/);
  } finally { await db.close(); }
});

test("hardening: 중간에 성공해도 누적 실패 10회를 넘으면 교사 해제가 필요하다(학생당 대입 상한)", async () => {
  const ctx = await setup();
  const { db, login } = ctx;
  try {
    const { event, issued } = await hardened(ctx);
    const first = await changed(ctx, event, issued.students[0], "482915");
    for (const fails of [4, 4]) {
      for (let i = 0; i < fails; i++) assert.deepEqual(await login(event.id, first, "000009"), { error: WRONG });
      assert.equal((await login(event.id, first, first.code)).student.name, first.name);
    }
    for (let i = 0; i < 2; i++) assert.deepEqual(await login(event.id, first, "000009"), { error: WRONG });
    assert.match((await login(event.id, first, "000009")).error, /선생님께 잠금 해제/);
  } finally { await db.close(); }
});

test("hardening: 전체 해제와 학생별 코드 재발급은 잠금을 초기화하고, 코드 변경 실패도 잠금에 포함된다", async () => {
  const ctx = await setup();
  const { db, as, call, login, change, expire } = ctx;
  try {
    const { event, issued } = await hardened(ctx);
    const [s1, s2, s3] = issued.students;
    // 첫 접속 코드 변경도 현재 코드가 틀리면 실패로 센다.
    for (let i = 0; i < 4; i++) assert.equal((await change(event.id, s1, "000009", "482915")).error, WRONG);
    assert.equal((await change(event.id, s1, "000009", "482915")).locked, true);
    for (let i = 0; i < 5; i++) await login(event.id, s2, "000009");
    assert.match((await login(event.id, s2, s2.code)).error, /잠겼/);

    await as("authenticated", owner);
    assert.match((await call("select public.unlock_course_event($1)", [event.id])).message, /2명/);
    await as("anon");
    assert.equal((await login(event.id, s1, s1.code)).mustChangeCode, true);
    assert.equal((await login(event.id, s2, s2.code)).mustChangeCode, true);

    // 교사 해제가 필요한 학생도 코드 재발급으로 풀린다. 다른 학생 코드는 유지.
    for (let i = 0; i < 11; i++) { await login(event.id, s3, "000009"); await expire(s3.id); }
    assert.match((await login(event.id, s3, s3.code)).error, /선생님께 잠금 해제/);
    await as("authenticated", owner);
    const reissued = await call("select public.reissue_course_code($1,$2)", [event.id, s3.id]);
    assert.equal(reissued.students.length, 1);
    assert.deepEqual((await call("select public.get_course_code_locks($1)", [event.id])).students, []);
    await as("anon");
    assert.equal((await login(event.id, s3, reissued.students[0].code)).mustChangeCode, true);
    assert.equal((await login(event.id, s1, s1.code)).mustChangeCode, true);
    await as("authenticated", other);
    await assert.rejects(() => db.query("select public.reissue_course_code($1,$2)", [event.id, s1.id]), /본인이 만든/);
  } finally { await db.close(); }
});

test("hardening: 학년이 둘인 신청은 학년까지 입력해야 학생을 찾는다", async () => {
  const ctx = await setup();
  const { db, call, login } = ctx;
  try {
    const roster = [
      { grade: "1", classroom: "2", number: "5", name: "일학년" },
      { grade: "2", classroom: "2", number: "5", name: "이학년" },
    ];
    const { event, issued } = await hardened(ctx, roster);
    const [one, two] = issued.students;
    assert.deepEqual((await call("select public.get_course_login_form($1)", [event.id])).grades, ["1", "2"]);
    const ambiguous = await login(event.id, one, one.code);
    assert.equal(ambiguous.needGrade, true);
    assert.match(ambiguous.error, /학년을 선택/);
    assert.equal((await login(event.id, one, one.code, "1")).student.name, "일학년");
    assert.equal((await login(event.id, two, two.code, "2")).student.name, "이학년");
    // 학년을 틀리게 고르면 다른 학생의 코드 실패로 센다(문구는 같음).
    assert.deepEqual(await login(event.id, one, one.code, "2"), { error: WRONG });
    assert.deepEqual(await login(event.id, one, one.code, "3"), { error: "학년·반·번호를 숫자로 입력하세요." });
  } finally { await db.close(); }
});

test("hardening: 기존 6자리 코드는 변환되어 반·번호와 함께 첫 접속에서 변경 대상이 된다", async () => {
  const ctx = await setup();
  const { db, as, login } = ctx;
  try {
    const event = await createEvent(ctx);
    const legacy = event.students[0];
    await db.exec("reset role"); await db.exec(sql("proposed", "01-code-hardening.sql"));
    await as("anon");
    assert.equal((await login(event.id, legacy, legacy.code)).mustChangeCode, true);
  } finally { await db.close(); }
});

test("hardening: 다음 차수에 학번이 이어지고 되돌리기 스크립트가 동작한다", async () => {
  const ctx = await setup();
  const { db, as, call, login } = ctx;
  try {
    const event = await createEvent(ctx);
    await db.exec("reset role"); await db.exec(sql("proposed", "02-next-round-student-id.sql"));
    await db.exec("reset role"); await db.exec(sql("proposed", "01-code-hardening.sql"));
    await as("authenticated", owner);
    const codes = await call("select public.manage_course_event($1,'codes')", [event.id]);
    await as("anon");
    await login(event.id, codes.students[0], "000009");
    await as("authenticated", owner);
    await call("select public.manage_course_event($1,'close')", [event.id]);
    const next = await call("select public.create_next_course_event($1,$2::jsonb,'all')", [event.id, JSON.stringify([{ grade: "2", subject: "A" }])]);
    await db.exec("reset role");
    const ids = (await db.query("select school_student_id from public.course_students where event_id=$1 order by number::int", [next.id])).rows.map((r) => r.school_student_id);
    assert.deepEqual(ids, ["101", "102", "103"]);
    assert.equal(next.students.length, 3);

    await db.exec("reset role"); await db.exec(sql("proposed", "01-rollback.sql"));
    await as("authenticated", owner);
    const restored = await call("select public.manage_course_event($1,'codes')", [next.id]);
    assert.equal(restored.students.length, 3);
    await as("anon");
    assert.equal((await call("select public.get_scoped_course_application($1,$2)", [next.id, restored.students[0].code])).student.number, "1");
    await db.exec("reset role");
    assert.equal((await db.query("select to_regclass('public.course_code_locks') t")).rows[0].t, null);
  } finally { await db.close(); }
});

test("hardening: 클라이언트가 호출하는 새 RPC는 제안 SQL에 정의되고 올바른 역할에만 허용된다", () => {
  const client = fs.readFileSync(path.join(__dirname, "..", "supabase-client.js"), "utf8");
  const migration = sql("proposed", "01-code-hardening.sql");
  const rollback = sql("proposed", "01-rollback.sql");
  const student = ["get_course_login_form", "get_student_course_application", "save_student_course_application", "change_course_code"];
  const teacher = ["reissue_course_code", "get_course_code_locks", "unlock_course_student", "unlock_course_event"];
  for (const name of [...student, ...teacher]) {
    assert.ok(client.includes(`"${name}"`), `${name} 호출이 클라이언트에 없습니다.`);
    assert.match(migration, new RegExp(`create function public\\.${name}\\(`));
    assert.match(rollback, new RegExp(`public\\.${name}\\(`), `${name} 되돌리기가 없습니다.`);
  }
  const grants = [...migration.matchAll(/grant execute on function ([\s\S]*?) to ([a-z, ]+);/g)];
  const granted = (name) => grants.filter(([, list]) => list.includes(`public.${name}(`)).map(([, , roles]) => roles.trim());
  for (const name of student) assert.deepEqual(granted(name), ["anon, authenticated"], name);
  for (const name of teacher) assert.deepEqual(granted(name), ["authenticated"], name);
  assert.doesNotMatch(migration, /course_client_key|x-forwarded-for|course_code_failures/);
});
