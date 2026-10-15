const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { PGlite } = require("@electric-sql/pglite");

for (const academicYearGuard of [false,true]) {
test(`reselection modes preserve choices and enforce rules (academic-year guard: ${academicYearGuard})`, async () => {
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
    for (const file of ["setup.sql","upgrade-codes-history.sql","upgrade-stable-student-ids.sql",
      "upgrade-selection-groups.sql","upgrade-semester-groups.sql","upgrade-application-rounds.sql",
      "upgrade-teacher-selections.sql",...(academicYearGuard ? ["upgrade-academic-year-access.sql"] : []),"upgrade-reselection.sql"]) {
      await db.exec(fs.readFileSync(path.join(__dirname,"..","supabase",file),"utf8"));
    }
    const owner="11111111-1111-1111-1111-111111111111";
    const as=async(role,user="")=>{
      await db.exec(`reset role; set role ${role}`);
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
    };
    await as("authenticated",owner);
    const subjects=["A (1학기)","B","C","A (2학기)","D"].map((subject,index)=>({
      subject,credit:3,semester:index<3?"1":"2",
    }));
    const setup={type:"course-application-setup",schoolName:"학교",schoolYear:"2099",round:"1",
      subjects:{"2":subjects,"3":[]},
      groups:[{id:"s1",grade:"2",semester:"1",name:"1학기 선택",count:1,courses:subjects.slice(0,3).map((c)=>c.subject)},
        {id:"s2",grade:"2",semester:"2",name:"2학기 선택",count:1,courses:subjects.slice(3).map((c)=>c.subject)}],
      roster:[1,2,3].map((number)=>({grade:"1",classroom:"1",number:String(number),name:`학생${number}`}))};
    const event=(await db.query("select public.create_course_event($1::jsonb) r",[JSON.stringify(setup)])).rows[0].r;
    const save=(event,student,picks)=>db.query("select public.save_scoped_course_application($1,$2,$3::jsonb)",
      [event.id,event.students[student].code,JSON.stringify(picks)]);
    await as("anon");
    await assert.rejects(()=>save(event,0,["A (1학기)","A (2학기)"]),/중복 신청/);
    await save(event,0,["B","D"]);
    await save(event,1,["C","A (2학기)"]);
    await as("authenticated",owner);
    const closed=[{grade:"2",subject:"B"}];
    const next=(mode,closures=closed)=>db.query("select public.create_next_course_event($1,$2::jsonb,$3) r",
      [event.id,JSON.stringify(closures),mode]);
    await assert.rejects(()=>next("affected"),/마감/);
    await db.query("select public.manage_course_event($1,'close')",[event.id]);
    await assert.rejects(()=>next("bad"),/방식/);
    await assert.rejects(()=>next("all",[{grade:"2",subject:"없는 과목"}]),/학년·과목명/);
    const affected=(await next("affected")).rows[0].r;
    assert.equal(affected.affectedCount,1);
    const teacher=async(id)=>(await db.query("select public.get_teacher_course_applications($1) r",[id])).rows[0].r;
    const data=await teacher(affected.id);
    assert.deepEqual(data.subjects["2"].map((c)=>c.subject),["A (1학기)","C","A (2학기)","D"]);
    assert.deepEqual(data.entries[0].lockedSelections,["D"]);
    assert.deepEqual(data.entries[1].selections,["C","A (2학기)"]);
    assert.equal(data.entries[1].reselectionAllowed,false);
    assert.equal(data.entries[2].reselectionAllowed,false);
    assert.equal(data.entries[2].submittedAt,null);
    await as("anon");
    const view=(await db.query("select public.get_scoped_course_application($1,$2) r",
      [affected.id,affected.students[1].code])).rows[0].r;
    assert.equal(view.open,false);
    assert.equal(view.reselectionAllowed,false);
    await assert.rejects(()=>save(affected,1,["A (1학기)","D"]),/재선택/);
    await assert.rejects(()=>save(affected,0,["C","A (2학기)"]),/기존 선택/);
    await assert.rejects(()=>save(affected,0,["B","D"]),/정확히 1|가능한 과목/);
    await save(affected,0,["C","D"]);
    await as("authenticated",owner);
    const updated=await teacher(affected.id);
    const s=updated.entries[0];
    await assert.rejects(()=>db.query("select public.save_teacher_course_application($1,$2,$3,$4,$5)",
      [affected.id,s.id,JSON.stringify(["C","A (2학기)"]),JSON.stringify(s.selections),s.submittedAt]),/기존 선택/);
    const exported=(await db.query("select public.manage_course_event($1,'export') r",[affected.id])).rows[0].r;
    assert.equal(exported.entries.length,2);
    const all=(await next("all")).rows[0].r;
    const allData=await teacher(all.id);
    assert.ok(allData.entries.every((s)=>s.reselectionAllowed && !s.lockedSelections.length && !s.selections.length));
    await as("anon");
    await save(all,0,["C","D"]);
    await save(all,2,["C","D"]);
    await as("authenticated","22222222-2222-2222-2222-222222222222");
    await assert.rejects(()=>next("all"),/본인이 만든/);
    await as("anon");
    await assert.rejects(()=>next("all"),/permission denied/);
  } finally {
    await db.close();
  }
});
}
