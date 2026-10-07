const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");

test("Supabase schema validates settings, isolates teachers and supports code-only student submissions", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql as
        'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
      grant usage on schema auth to authenticated, anon;
      grant execute on function auth.uid() to authenticated, anon;
      insert into auth.users values ('11111111-1111-1111-1111-111111111111'),
        ('22222222-2222-2222-2222-222222222222');
    `);
    await db.exec(fs.readFileSync(path.join(__dirname, "..", "supabase", "setup.sql"), "utf8"));
    const teacher1 = "11111111-1111-1111-1111-111111111111";
    const teacher2 = "22222222-2222-2222-2222-222222222222";
    async function as(role, user = "") {
      await db.exec(`reset role; set role ${role};`);
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user]);
    }
    const setup = {
      type: "course-application-setup", schoolName: "가상학교", schoolYear: "2026", round: "1",
      subjects: {
        "2": [{ subject: "수학", credit: 3 }, { subject: "국어", credit: 4 }],
        "3": [{ subject: "과학", credit: 3 }],
      },
      roster: [
        { grade: "1", classroom: "1", number: "1", name: "가상학생1" },
        { grade: "2", classroom: "1", number: "2", name: "가상학생2" },
      ],
    };
    const create = (data) => db.query("select public.create_course_event($1::jsonb) as result", [JSON.stringify(data)]);
    const manage = (id, action) => db.query("select public.manage_course_event($1::uuid, $2) as result", [id, action]);
    const get = (code) => db.query("select public.get_course_application($1) as result", [code]);
    const save = (code, selections) => db.query("select public.save_course_application($1, $2::jsonb) as result", [code, JSON.stringify(selections)]);
    const resultRevision = async () => {
      await db.exec("reset role");
      const value = (await db.query("select result_revision from public.course_events where id = $1", [event.id])).rows[0].result_revision;
      await as("anon");
      return value;
    };
    await as("authenticated", teacher1);
    const malformed = [
      { ...setup, roster: [] }, { ...setup, roster: null }, { ...setup, round: null },
      { ...setup, subjects: { "2": null, "3": [] } },
      { ...setup, subjects: { "2": [{ subject: "수학", credit: null }], "3": [] } },
      { ...setup, roster: [setup.roster[0], setup.roster[0]] },
      { ...setup, roster: [{ ...setup.roster[0], grade: "3" }] },
    ];
    for (const invalid of malformed) await assert.rejects(() => create(invalid));
    assert.equal((await db.query("select * from public.course_events")).rows.length, 0);
    const event = (await create(setup)).rows[0].result;
    const code = event.students[0].code;
    assert.match(code, /^[a-f0-9]{32}$/);
    assert.notEqual(code, event.students[1].code);
    assert.equal((await db.query("select * from public.course_events")).rows.length, 1);
    await assert.rejects(() => db.query("select * from public.course_students"), /permission denied/);
    await as("authenticated", teacher2);
    assert.equal((await db.query("select * from public.course_events")).rows.length, 0);
    for (const action of ["export", "open", "close", "delete", "codes"]) {
      await assert.rejects(() => manage(event.id, action), /본인이 만든/);
    }
    await as("anon");
    await assert.rejects(() => db.query("select * from public.course_students"), /permission denied/);
    await assert.rejects(() => db.query("select * from public.course_events"), /permission denied/);
    await assert.rejects(() => create(setup), /permission denied/);
    await assert.rejects(() => manage(event.id, "export"), /permission denied/);
    await assert.rejects(() => get(null), /신청 코드/);
    await assert.rejects(() => get("f".repeat(32)), /신청 코드/);
    const student = (await get(code)).rows[0].result;
    assert.equal(student.student.name, "가상학생1");
    assert.deepEqual(student.courses.map((c) => c.subject), ["수학", "국어"]);
    assert.ok(!("students" in student));
    for (const selections of [null, [], ["과학"], ["수학", "수학"], [42], { subject: "수학" }]) {
      await assert.rejects(() => save(code, selections));
    }
    await save(code, ["수학"]);
    assert.equal(await resultRevision(), 1);
    await save(code, ["국어"]);
    assert.equal(await resultRevision(), 2);
    await save(code, ["국어"]);
    assert.equal(await resultRevision(), 2);
    assert.deepEqual((await get(code)).rows[0].result.selections, ["국어"]);
    assert.deepEqual((await get(event.students[1].code)).rows[0].result.selections, []);
    await as("authenticated", teacher1);
    const results = (await manage(event.id, "export")).rows[0].result;
    assert.equal(results.type, "course-application-results");
    assert.equal(results.entries.length, 1);
    assert.deepEqual(results.entries[0].selections, ["국어"]);
    assert.ok(!("code" in results.entries[0]));
    await manage(event.id, "close");
    await as("anon");
    assert.equal((await get(code)).rows[0].result.open, false);
    await assert.rejects(() => save(code, ["수학"]), /마감/);
    await as("authenticated", teacher1);
    await manage(event.id, "open");
    await as("anon");
    await save(code, ["국어", "수학"]);
    await as("authenticated", teacher1);
    const renewed = (await manage(event.id, "codes")).rows[0].result;
    assert.equal(renewed.students.length, 2);
    await as("anon");
    await assert.rejects(() => get(code), /신청 코드/);
    const newCode = renewed.students.find((s) => s.name === "가상학생1").code;
    assert.deepEqual((await get(newCode)).rows[0].result.selections, ["국어", "수학"]);
    await as("authenticated", teacher1);
    await manage(event.id, "delete");
    await as("anon");
    await assert.rejects(() => get(newCode), /신청 코드/);
    await db.exec("reset role");
    assert.equal((await db.query("select * from public.course_students")).rows.length, 0);
  } finally {
    await db.close();
  }
});
