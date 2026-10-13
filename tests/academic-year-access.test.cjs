const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { PGlite } = require("@electric-sql/pglite");

test("academic-year expiry blocks every server entry point and RLS without deleting records", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as
        'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
      grant usage on schema auth to anon,authenticated;
      grant execute on function auth.uid() to anon,authenticated;
      insert into auth.users values ('11111111-1111-1111-1111-111111111111');
    `);
    for (const file of ["setup.sql", "upgrade-codes-history.sql", "upgrade-realtime-sync.sql",
      "upgrade-stable-student-ids.sql", "upgrade-selection-groups.sql", "upgrade-semester-groups.sql",
      "upgrade-application-rounds.sql", "upgrade-teacher-selections.sql", "upgrade-academic-year-access.sql"]) {
      await db.exec(fs.readFileSync(path.join(__dirname, "..", "supabase", file), "utf8"));
    }
    for (const year of [2026, 2027, 2028]) {
      const deadline = (await db.query("select public.course_school_year_expires_at($1) as at", [String(year)])).rows[0].at;
      assert.equal(new Date(deadline).getTime(), Date.UTC(year + 1, 2, 1) - 9 * 60 * 60 * 1000);
    }
    const originalActive = (await db.query(
      "select pg_get_functiondef('public.course_school_year_active(text)'::regprocedure) as definition")).rows[0].definition;
    for (const [time, expected] of [
      ["2027-02-28T14:59:59.999Z", true],
      ["2027-02-28T15:00:00.000Z", false],
      ["2027-02-28T15:00:00.001Z", false],
    ]) {
      await db.exec(`create or replace function public.course_school_year_active(p_year text)
        returns boolean language sql volatile set search_path='' as $$
        select coalesce('${time}'::timestamptz < public.course_school_year_expires_at(p_year),false);
        $$`);
      assert.equal((await db.query("select public.course_school_year_active('2026') as active")).rows[0].active, expected);
    }
    await db.exec(originalActive);
    assert.equal((await db.query("select public.course_school_year_active('invalid') as active")).rows[0].active, false);
    const as = async (role) => {
      await db.exec(`reset role; set role ${role}`);
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",
        [role === "authenticated" ? "11111111-1111-1111-1111-111111111111" : ""]);
    };
    const setup = {
      type: "course-application-setup", schoolName: "테스트", schoolYear: "2099", round: "1",
      subjects: { "2": [{ subject: "A", credit: 3, semester: "1" }], "3": [] },
      roster: [{ grade: "1", classroom: "1", number: "1", name: "학생" }],
      groups: [{ id: "g", grade: "2", semester: "1", name: "선택", count: 1, courses: ["A"] }],
    };
    await as("authenticated");
    await assert.rejects(() => db.query("select public.create_course_event($1::jsonb)",
      [JSON.stringify({ ...setup, schoolYear: "2000" })]), /이용 기간이 종료/);
    const event = (await db.query("select public.create_course_event($1::jsonb) as data", [JSON.stringify(setup)])).rows[0].data;
    await as("anon");
    await db.query("select public.get_scoped_course_application($1,$2)", [event.id, event.students[0].code]);
    await db.query("select public.save_scoped_course_application($1,$2,$3::jsonb)",
      [event.id, event.students[0].code, '["A"]']);
    await db.exec("reset role");
    const legacyCode = "a".repeat(32);
    await db.query("update public.course_students set code_hash=encode(sha256(convert_to($1,'UTF8')),'hex') where event_id=$2",
      [legacyCode, event.id]);
    await db.query("update public.course_events set school_year='2000' where id=$1", [event.id]);
    const before = (await db.query("select selections,submitted_at from public.course_students where event_id=$1", [event.id])).rows;
    await as("authenticated");
    assert.equal((await db.query("select id from public.course_events")).rows.length, 0);
    for (const action of ["export", "codes", "open", "close", "delete"]) {
      await assert.rejects(() => db.query("select public.manage_course_event($1,$2)", [event.id, action]), /이용 기간이 종료/);
    }
    await assert.rejects(() => db.query("select public.course_event_history($1)", [event.id]), /이용 기간이 종료/);
    await assert.rejects(() => db.query("select public.rollback_course_event($1,clock_timestamp())", [event.id]), /이용 기간이 종료/);
    await assert.rejects(() => db.query("select public.get_teacher_course_applications($1)", [event.id]), /이용 기간이 종료/);
    await assert.rejects(() => db.query("select public.save_teacher_course_application($1,$2,$3::jsonb,$4::jsonb,null)",
      [event.id, event.students[0].id, '["A"]', '[]']), /이용 기간이 종료/);
    for (const role of ["anon", "authenticated"]) {
      await as(role);
      await assert.rejects(() => db.query("select public.get_scoped_course_application($1,$2)", [event.id, legacyCode]), /이용 기간이 종료/);
      await assert.rejects(() => db.query("select public.save_scoped_course_application($1,$2,$3::jsonb)",
        [event.id, legacyCode, '["A"]']), /이용 기간이 종료/);
      await assert.rejects(() => db.query("select public.get_course_application($1)", [legacyCode]), /이용 기간이 종료/);
      await assert.rejects(() => db.query("select public.save_course_application($1,$2::jsonb)", [legacyCode, '["A"]']), /이용 기간이 종료/);
      await assert.rejects(() => db.query("select public.get_scoped_course_application_year_base($1,$2)",
        [event.id, legacyCode]), /permission denied/);
    }
    await as("authenticated");
    const nextEvent = (await db.query("select public.create_course_event($1::jsonb) as data",
      [JSON.stringify({ ...setup, schoolYear: "2100" })])).rows[0].data;
    assert.notEqual(nextEvent.id, event.id);
    assert.equal((await db.query("select id from public.course_events")).rows.length, 1);
    await db.exec("reset role");
    assert.equal((await db.query("select id from public.course_events")).rows.length, 2);
    assert.deepEqual((await db.query("select selections,submitted_at from public.course_students where event_id=$1", [event.id])).rows, before);
  } finally {
    await db.close();
  }
});
