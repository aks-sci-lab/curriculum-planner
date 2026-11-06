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
  return { db, as, call };
}

async function createEvent({ call, as }) {
  await as("authenticated", owner);
  const subjects = ["A", "B", "C"].map((subject) => ({ subject, credit: 3, semester: "1" }));
  const setupJson = {
    type: "course-application-setup", schoolName: "학교", schoolYear: "2099", round: "1",
    subjects: { "2": subjects, "3": [] },
    groups: [{ id: "g", grade: "2", semester: "1", name: "선택", count: 1, courses: ["A", "B", "C"] }],
    roster: [1, 2, 3].map((n) => ({ grade: "1", classroom: "1", number: String(n), name: `학생${n}`, studentId: `10${n}` })),
  };
  return call("select public.create_course_event($1::jsonb)", [JSON.stringify(setupJson)]);
}

test("hardening: first login code change, salted hashes, lockout and reissue", async () => {
  const ctx = await setup();
  const { db, as, call } = ctx;
  try {
    const event = await createEvent(ctx);
    await db.exec("reset role"); await db.exec(sql("proposed", "01-code-hardening.sql"));
    await as("authenticated", owner);
    const issued = await call("select public.manage_course_event($1,'codes')", [event.id]);
    assert.equal(issued.students.length, 3);
    const [first, second] = issued.students;
    assert.match(first.code, /^\d{6}$/);

    await db.exec("reset role");
    const stored = (await db.query("select code_hash, code_hmac from public.course_students where id=$1", [first.id])).rows[0];
    const plain = crypto.createHash("sha256").update(first.code).digest("hex");
    assert.notEqual(stored.code_hash, plain);
    assert.notEqual(stored.code_hmac, plain);
    const salted = (await db.query("select count(*)::int n from public.course_students where code_hash = any($1)", [
      [plain, ...[0, 1].map((i) => crypto.createHash("sha256").update(issued.students[i].code).digest("hex"))]])).rows[0].n;
    assert.equal(salted, 0);

    await as("anon");
    const login = await call("select public.get_scoped_course_application($1,$2)", [event.id, first.code]);
    assert.equal(login.mustChangeCode, true);
    assert.equal(login.student.name, first.name);
    assert.equal(login.courses, undefined);
    const blocked = await call("select public.save_scoped_course_application($1,$2,'[\"A\"]')", [event.id, first.code]);
    assert.match(blocked.error, /변경/);

    const change = (code, next) => call("select public.change_course_code($1,$2,$3)", [event.id, code, next]);
    assert.match((await change(first.code, "12345")).error, /6자리/);
    assert.match((await change(first.code, "111111")).error, /쉬운/);
    assert.match((await change(first.code, first.code)).error, /다른 새 코드/);
    assert.match((await change(first.code, second.code)).error, /사용할 수 없는/);
    assert.match((await change(first.code, "482915")).message, /변경했습니다/);

    assert.match((await call("select public.get_scoped_course_application($1,$2)", [event.id, first.code])).error, /개인 코드/);
    const opened = await call("select public.get_scoped_course_application($1,$2)", [event.id, "482915"]);
    assert.equal(opened.mustChangeCode, undefined);
    assert.equal(opened.student.name, first.name);
    assert.equal(opened.courses.length, 3);
    assert.match((await call("select public.save_scoped_course_application($1,$2,'[\"B\"]')", [event.id, "482915"])).message, /저장/);
    assert.match((await change("482915", "739204")).error, /이미 코드를 변경/);

    // 실패 5회 → 같은 접속지 잠금, 다른 접속지는 영향 없음, 올바른 코드도 잠금 중에는 거부.
    await as("anon", "", "9.9.9.9");
    let last;
    for (let i = 0; i < 5; i++) last = await call("select public.get_scoped_course_application($1,$2)", [event.id, "000009"]);
    assert.equal(last.locked, true);
    assert.match(last.error, /잠겼/);
    assert.match((await call("select public.get_scoped_course_application($1,$2)", [event.id, "482915"])).error, /잠겼/);
    await as("anon", "", "8.8.8.8");
    assert.equal((await call("select public.get_scoped_course_application($1,$2)", [event.id, "482915"])).student.name, first.name);

    // 교사 해제는 소유자만.
    await as("authenticated", other);
    await assert.rejects(() => db.query("select public.unlock_course_event($1)", [event.id]), /본인이 만든/);
    await assert.rejects(() => db.query("select public.reissue_course_code($1,$2)", [event.id, first.id]), /본인이 만든/);
    await as("authenticated", owner);
    await call("select public.unlock_course_event($1)", [event.id]);
    await as("anon", "", "9.9.9.9");
    assert.equal((await call("select public.get_scoped_course_application($1,$2)", [event.id, "482915"])).student.name, first.name);

    // 학생별 재발급: 그 학생만 새 코드(다시 변경 필요), 다른 학생은 유지.
    await as("authenticated", owner);
    const reissued = await call("select public.reissue_course_code($1,$2)", [event.id, first.id]);
    assert.equal(reissued.students.length, 1);
    await as("anon");
    assert.match((await call("select public.get_scoped_course_application($1,$2)", [event.id, "482915"])).error, /개인 코드/);
    assert.equal((await call("select public.get_scoped_course_application($1,$2)", [event.id, reissued.students[0].code])).mustChangeCode, true);
    assert.equal((await call("select public.get_scoped_course_application($1,$2)", [event.id, second.code])).mustChangeCode, true);
    // 신청 내용은 재발급 후에도 유지.
    await db.exec("reset role");
    const kept = (await db.query("select selections from public.course_students where id=$1", [first.id])).rows[0].selections;
    assert.deepEqual(kept, ["B"]);
  } finally { await db.close(); }
});

test("hardening: 이벤트 전체 실패 100회 합산이면 모든 접속지를 제한", async () => {
  const ctx = await setup();
  const { db, as, call } = ctx;
  try {
    const event = await createEvent(ctx);
    await db.exec("reset role"); await db.exec(sql("proposed", "01-code-hardening.sql"));
    await db.exec("reset role");
    for (let i = 0; i < 25; i++) {
      await db.query("insert into public.course_code_failures(event_id,client_key,fail_count) values ($1,$2,4)", [event.id, `k${i}`]);
    }
    await as("anon", "", "7.7.7.7");
    assert.match((await call("select public.get_scoped_course_application($1,$2)", [event.id, "123450"])).error, /제한/);
  } finally { await db.close(); }
});

test("hardening: 기존 6자리 코드는 변환되어 첫 접속에서 변경 대상이 된다", async () => {
  const ctx = await setup();
  const { db, as, call } = ctx;
  try {
    const event = await createEvent(ctx);
    await db.exec("reset role");
    const legacy = event.students[0].code;
    await db.exec("reset role"); await db.exec(sql("proposed", "01-code-hardening.sql"));
    await as("anon");
    assert.equal((await call("select public.get_scoped_course_application($1,$2)", [event.id, legacy])).mustChangeCode, true);
  } finally { await db.close(); }
});

test("hardening: 다음 차수에 학번이 이어지고 되돌리기 스크립트가 동작한다", async () => {
  const ctx = await setup();
  const { db, as, call } = ctx;
  try {
    const event = await createEvent(ctx);
    await db.exec("reset role"); await db.exec(sql("proposed", "02-next-round-student-id.sql"));
    await db.exec("reset role"); await db.exec(sql("proposed", "01-code-hardening.sql"));
    await as("authenticated", owner);
    const codes = await call("select public.manage_course_event($1,'codes')", [event.id]);
    await as("anon");
    await call("select public.get_scoped_course_application($1,$2)", [event.id, codes.students[0].code]);
    await as("authenticated", owner);
    await call("select public.manage_course_event($1,'close')", [event.id]);
    const next = await call("select public.create_next_course_event($1,$2::jsonb,'all')", [event.id, JSON.stringify([{ grade: "2", subject: "A" }])]);
    await db.exec("reset role");
    const ids = (await db.query("select school_student_id from public.course_students where event_id=$1 order by number::int", [next.id])).rows.map((r) => r.school_student_id);
    assert.deepEqual(ids, ["101", "102", "103"]);
    assert.equal(next.students.length, 3);

    await db.exec("reset role"); await db.exec(sql("proposed", "01-rollback.sql"));
    await as("authenticated", owner);
    assert.equal((await call("select public.manage_course_event($1,'codes')", [event.id])).students.length, 3);
  } finally { await db.close(); }
});

test("hardening: 클라이언트가 호출하는 새 RPC는 제안 SQL에 정의되고 올바른 역할에만 허용된다", () => {
  const client = fs.readFileSync(path.join(__dirname, "..", "supabase-client.js"), "utf8");
  const migration = sql("proposed", "01-code-hardening.sql");
  for (const name of ["change_course_code", "reissue_course_code", "unlock_course_event"]) {
    assert.ok(client.includes(`"${name}"`), `${name} 호출이 클라이언트에 없습니다.`);
    assert.match(migration, new RegExp(`create function public\\.${name}\\(`));
  }
  assert.match(migration, /change_course_code\(uuid,text,text\)[\s\S]*to anon, authenticated/);
  assert.match(migration, /reissue_course_code\(uuid,uuid\), public\.unlock_course_event\(uuid\) to authenticated;/);
});
