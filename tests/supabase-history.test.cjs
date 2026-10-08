const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");

test("six-digit scoped codes, immutable history, individual and full point-in-time rollback", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql as
        'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
      grant usage on schema auth to anon,authenticated;
      grant execute on function auth.uid() to anon,authenticated;
      insert into auth.users values('11111111-1111-1111-1111-111111111111'),
        ('22222222-2222-2222-2222-222222222222');
    `);
    const legacySetup = fs.readFileSync(path.join(__dirname, "..", "supabase", "setup.sql"), "utf8")
      .replaceAll("round ~ '^[1-9][0-9]{0,8}$'", "round in ('1', '2', '3')")
      .replaceAll("coalesce(p_setup->>'round', '') !~ '^[1-9][0-9]{0,8}$'",
        "coalesce(p_setup->>'round', '') not in ('1', '2', '3')");
    await db.exec(legacySetup);
    const owner = "11111111-1111-1111-1111-111111111111";
    async function as(role, user = "") {
      await db.exec(`reset role; set role ${role}`);
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
    }
    const setup = {
      type: "course-application-setup", schoolName: "가상학교", schoolYear: "2026", round: "1",
      subjects: { "2": [{ subject: "A", credit: 3 }, { subject: "B", credit: 4 }], "3": [] },
      roster: [
        { grade: "1", classroom: "1", number: "1", name: "가상1", studentId: "20260001" },
        { grade: "1", classroom: "2", number: "2", name: "가상2", studentId: "20260002" },
      ],
    };
    const create = async () => (await db.query("select public.create_course_event($1::jsonb) r", [JSON.stringify(setup)])).rows[0].r;
    await as("authenticated", owner);
    const legacy = await create();
    await db.query("select public.save_course_application($1,$2::jsonb)", [legacy.students[0].code, '["A"]']);
    await db.exec("reset role");
    await db.exec(fs.readFileSync(path.join(__dirname, "..", "supabase", "upgrade-codes-history.sql"), "utf8"));
    await db.exec(fs.readFileSync(path.join(__dirname, "..", "supabase", "upgrade-stable-student-ids.sql"), "utf8"));
    await as("authenticated", owner);
    const event = await create();
    assert.equal(new Set(event.students.map((s) => s.code)).size, 2);
    assert.ok(event.students.every((s) => /^\d{6}$/.test(s.code)));
    const [first, second] = event.students;
    const get = async (id, code) => (await db.query(
      "select public.get_scoped_course_application($1::uuid,$2) r", [id, code])).rows[0].r;
    const save = (s, selections) => db.query("select public.save_scoped_course_application($1::uuid,$2,$3::jsonb)",
      [event.id, s.code, JSON.stringify(selections)]);
    const history = async (id = event.id) => (await db.query("select public.course_event_history($1::uuid) r", [id])).rows[0].r;
    const rollback = (before, student = null, id = event.id) => db.query(
      "select public.rollback_course_event($1::uuid,$2::timestamptz,$3::uuid)", [id, before, student]);
    await as("anon");
    assert.deepEqual((await get(legacy.id, legacy.students[0].code)).selections, ["A"]);
    await assert.rejects(() => get(legacy.id, first.code), /개인 코드/);
    await assert.rejects(() => get(event.id, "bad"), /신청 코드/);
    await assert.rejects(() => save(first, ["unknown"]), /가능한 과목/);
    await save(first, ["A"]);
    await save(second, ["A"]);
    await save(first, ["B"]);
    await as("authenticated", owner);
    const exported = (await db.query("select public.manage_course_event($1::uuid,'export') r", [event.id])).rows[0].r;
    assert.equal(exported.entries.find((entry) => entry.number === "1").studentId, "20260001");
    assert.equal(exported.entries.find((entry) => entry.number === "2").studentId, "20260002");
    let log = await history();
    const cutoff = log.entries.find((r) => r.studentId === first.id && r.action === "submit" && r.selections[0] === "B").at;
    await rollback(cutoff, first.id);
    await as("anon");
    assert.deepEqual((await get(event.id, first.code)).selections, ["A"]);
    assert.deepEqual((await get(event.id, second.code)).selections, ["A"]);
    await as("authenticated", owner);
    log = await history();
    assert.equal(log.entries[0].action, "rollback");
    assert.equal(new Date(log.entries[0].rollbackBefore).getTime(), new Date(cutoff).getTime());
    const firstSubmit = log.entries.filter((r) => r.action === "submit").sort((a,b) => a.at.localeCompare(b.at))[0].at;
    await rollback(firstSubmit);
    await as("anon");
    assert.deepEqual((await get(event.id, first.code)).selections, []);
    assert.equal((await get(event.id, first.code)).submittedAt, null);
    assert.deepEqual((await get(event.id, second.code)).selections, []);
    await assert.rejects(() => history(), /permission denied/);
    await assert.rejects(() => rollback(cutoff), /permission denied/);
    await assert.rejects(() => db.query("select * from public.course_application_history"), /permission denied/);
    await as("authenticated", "22222222-2222-2222-2222-222222222222");
    await assert.rejects(() => history(), /본인이 만든/);
    await assert.rejects(() => rollback(cutoff), /본인이 만든/);
    await as("authenticated", owner);
    await assert.rejects(() => rollback("2000-01-01T00:00:00Z"), /기록 시작/);
    await assert.rejects(() => rollback("2999-01-01T00:00:00Z"), /기록 시작/);
    await assert.rejects(() => rollback(cutoff, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), /학생/);
    const issued = (await db.query("select public.manage_course_event($1::uuid,'codes') r", [legacy.id])).rows[0].r;
    assert.ok(issued.students.every((s) => /^\d{6}$/.test(s.code)));
    await as("anon");
    await assert.rejects(() => get(legacy.id, legacy.students[0].code), /개인 코드/);
    assert.deepEqual((await get(legacy.id, issued.students[0].code)).selections, ["A"]);
    await as("authenticated", owner);
    await db.query("select public.manage_course_event($1::uuid,'close')", [event.id]);
    await as("anon");
    await assert.rejects(() => save(first, ["A"]), /마감/);
    await as("authenticated", owner);
    await rollback(cutoff); // Teacher may restore closed events without reopening.
    await db.query("select public.manage_course_event($1::uuid,'delete')", [event.id]);
    await db.exec("reset role");
    assert.equal((await db.query("select * from public.course_application_history where event_id=$1::uuid", [event.id])).rows.length, 0);
    await db.exec(fs.readFileSync(path.join(__dirname, "..", "supabase", "upgrade-selection-groups.sql"), "utf8"));
    await as("authenticated", owner);
    setup.groups = [{id:"g1", grade:"2",name:"교과",count:1,courses:["A","B"]}];
    const grouped = await create();
    await as("anon");
    const groupedData = await get(grouped.id, grouped.students[0].code);
    assert.equal(groupedData.groups[0].count, 1);
    await assert.rejects(() => db.query("select public.save_scoped_course_application($1::uuid,$2,$3::jsonb)",
      [grouped.id,grouped.students[0].code,'["A","B"]']), /정확히 1/);
    await db.query("select public.save_scoped_course_application($1::uuid,$2,$3::jsonb)",
      [grouped.id,grouped.students[0].code,'["B"]']);
    await as("authenticated",owner);
    setup.groups[0].courses=["A"];
    await assert.rejects(() => create(), /모든 과목/);
    setup.groups[0].courses=["A","B"];
    setup.groups[0].count=3;
    await assert.rejects(() => create(), /선택 수/);
    await db.exec("reset role");
    await db.exec(fs.readFileSync(path.join(__dirname, "..", "supabase", "upgrade-semester-groups.sql"), "utf8"));
    await db.exec(fs.readFileSync(path.join(__dirname, "..", "supabase", "upgrade-application-rounds.sql"), "utf8"));
    await as("authenticated",owner);
    setup.round="4";
    setup.subjects["2"]=[
      {subject:"수학 (1학기)",semester:"1",credit:3},
      {subject:"수학 (2학기)",semester:"2",credit:3}
    ];
    setup.groups=[
      {id:"s1",grade:"2",semester:"1",name:"수학",count:1,courses:["수학 (1학기)"]},
      {id:"s2",grade:"2",semester:"2",name:"수학",count:1,courses:["수학 (2학기)"]}
    ];
    const semesters=await create();
    assert.equal((await db.query("select round from public.course_events where id=$1::uuid",[semesters.id])).rows[0].round,"4");
    setup.round="1000000000";
    await assert.rejects(()=>create(),/round|차수|신청 설정/i);
    setup.round="4";
    setup.groups[0].courses.push("수학 (2학기)");
    await assert.rejects(()=>create(),/다른 학기/);
    await as("anon");
    const semesterSave=(choices)=>db.query("select public.save_scoped_course_application($1::uuid,$2,$3::jsonb)",
      [semesters.id,semesters.students[0].code,JSON.stringify(choices)]);
    await assert.rejects(()=>semesterSave(["수학 (1학기)"]),/정확히 1/);
    await semesterSave(["수학 (1학기)","수학 (2학기)"]);
    // Existing events retain their original group schema and saved selections.
    assert.deepEqual((await get(grouped.id,grouped.students[0].code)).selections,["B"]);
    await as("authenticated",owner);
    const results=(await db.query("select public.manage_course_event($1::uuid,'export') r",[semesters.id])).rows[0].r;
    assert.deepEqual(results.entries[0].selections,["수학 (1학기)","수학 (2학기)"]);
    setup.subjects["3"]=[{subject:"3학년 과학",semester:"1",credit:3}];
    setup.groups.push({id:"grade3",grade:"3",semester:"1",name:"과학",count:1,courses:["3학년 과학"]});
    setup.groups[0].courses=["수학 (1학기)"];
    setup.roster[1].grade="2";
    const gradeScoped=await create();
    await as("anon");
    for (const [index,names] of [[0,["수학 (1학기)","수학 (2학기)"]],[1,["3학년 과학"]]]) {
      const student=gradeScoped.students[index];
      const data=await get(gradeScoped.id,student.code);
      assert.deepEqual(data.courses.map((course)=>course.subject),names);
      assert.ok(data.groups.every((group)=>group.grade===String(Number(student.grade)+1)));
      const submit=(choices)=>db.query("select public.save_scoped_course_application($1::uuid,$2,$3::jsonb)",
        [gradeScoped.id,student.code,JSON.stringify(choices)]);
      await submit(names);
      await assert.rejects(()=>submit([...names,index===0?"3학년 과학":"수학 (1학기)"]),/신청 가능한 과목/);
    }
  } finally { await db.close(); }
});
