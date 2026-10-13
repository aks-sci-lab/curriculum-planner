const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { PGlite } = require("@electric-sql/pglite");

test("teacher edits enforce ownership, grade, groups and optimistic concurrency, including closed events", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as
        'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
      grant usage on schema auth to anon,authenticated;
      grant execute on function auth.uid() to anon,authenticated;
      insert into auth.users values ('11111111-1111-1111-1111-111111111111'),
        ('22222222-2222-2222-2222-222222222222');
    `);
    for (const file of ["setup.sql", "upgrade-codes-history.sql", "upgrade-selection-groups.sql",
      "upgrade-teacher-selections.sql"]) {
      await db.exec(fs.readFileSync(path.join(__dirname, "..", "supabase", file), "utf8"));
    }
    const owner = "11111111-1111-1111-1111-111111111111";
    const as = async (role, user = "") => {
      await db.exec(`reset role; set role ${role}`);
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
    };
    await as("authenticated", owner);
    const setup = {
      type: "course-application-setup", schoolName: "테스트", schoolYear: "2026", round: "1",
      subjects: { "2": [{ subject: "A", credit: 3 }, { subject: "B", credit: 3 }],
        "3": [{ subject: "C", credit: 3 }] },
      roster: [{ grade: "1", classroom: "1", number: "1", name: "학생1" },
        { grade: "2", classroom: "1", number: "2", name: "학생2" }],
      groups: [{ id: "g2", grade: "2", name: "선택", count: 1, courses: ["A", "B"] },
        { id: "g3", grade: "3", name: "선택", count: 1, courses: ["C"] }]
    };
    const event = (await db.query("select public.create_course_event($1::jsonb) r", [JSON.stringify(setup)])).rows[0].r;
    const get = async () => (await db.query("select public.get_teacher_course_applications($1) r", [event.id])).rows[0].r;
    const data = await get();
    assert.equal(data.entries.length, 2);
    assert.equal(data.entries[0].submittedAt, null);
    assert.equal("code" in data.entries[0], false);
    const first = data.entries[0];
    const save = (selections, previous = first, student = first.id) => db.query(
      "select public.save_teacher_course_application($1,$2,$3::jsonb,$4::jsonb,$5::timestamptz) r",
      [event.id, student, JSON.stringify(selections), JSON.stringify(previous.selections), previous.submittedAt]);
    await assert.rejects(() => save(["C"]), /가능한 과목/);
    await assert.rejects(() => save(["A", "A"]), /중복/);
    await assert.rejects(() => save(["A", "B"]), /정확히 1/);
    await assert.rejects(() => save([]), /가능한 과목/);
    await assert.rejects(() => save(["A"], first, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), /학생/);
    await db.query("select public.manage_course_event($1,'close')", [event.id]);
    await save(["A"]);
    const after = (await get()).entries[0];
    assert.deepEqual(after.selections, ["A"]);
    assert.ok(after.submittedAt);
    await assert.rejects(() => save(["B"]), /변경되었습니다/);
    await save(["B"], after);
    const log = (await db.query("select public.course_event_history($1) r", [event.id])).rows[0].r;
    assert.equal(log.entries[0].action, "teacher_edit");
    await db.exec("reset role");
    const revision = (await db.query("select result_revision from public.course_events where id=$1", [event.id])).rows[0];
    assert.equal(Number(revision.result_revision), 2);
    await as("authenticated", "22222222-2222-2222-2222-222222222222");
    await assert.rejects(get, /본인이 만든/);
    await assert.rejects(() => save(["A"], after), /본인이 만든/);
    await as("anon");
    await assert.rejects(get, /permission denied/);
    await assert.rejects(() => save(["A"], after), /permission denied/);
    await as("authenticated", owner);
    await db.query("select public.manage_course_event($1,'open')", [event.id]);
    const current = (await get()).entries[0];
    await as("anon");
    await db.query("select public.save_scoped_course_application($1,$2,$3::jsonb)", [event.id, event.students[0].code, '["A"]']);
    await as("authenticated", owner);
    await assert.rejects(() => save(["B"], current), /변경되었습니다/);
  } finally {
    await db.close();
  }
});
