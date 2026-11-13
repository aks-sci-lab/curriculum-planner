const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { PGlite } = require("@electric-sql/pglite");

// supabase/proposed/04-multi-school-limits.sql(서버 미적용 초안)을 기존 체인 위에서 PGlite로 확인한다. 실제 서버 요청 없음.
const sql = (...parts) => fs.readFileSync(path.join(__dirname, "..", "supabase", ...parts), "utf8");
const chain = ["setup.sql", "upgrade-codes-history.sql", "upgrade-stable-student-ids.sql",
  "upgrade-selection-groups.sql", "upgrade-semester-groups.sql", "upgrade-application-rounds.sql",
  "upgrade-teacher-selections.sql", "upgrade-academic-year-access.sql", "upgrade-reselection.sql"];
const owner = "11111111-1111-1111-1111-111111111111";
const other = "22222222-2222-2222-2222-222222222222";

async function setup(extra = []) {
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
  for (const file of extra) await db.exec(sql("proposed", file));
  await db.exec(sql("proposed", "04-multi-school-limits.sql"));
  const as = async (role, user = "") => {
    await db.exec(`reset role; set role ${role}`);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  };
  const call = async (query, params) => Object.values((await db.query(query, params)).rows[0])[0];
  const create = async (user, { schoolName = "가상고등학교", schoolYear = "2099", round = "1", count = 3 } = {}) => {
    await as("authenticated", user);
    const subjects = ["A", "B", "C"].map((subject) => ({ subject, credit: 3, semester: "1" }));
    return call("select public.create_course_event($1::jsonb)", [JSON.stringify({
      type: "course-application-setup", schoolName, schoolYear, round,
      subjects: { "2": subjects, "3": subjects },
      groups: ["2", "3"].map((grade) => ({ id: `g${grade}`, grade, semester: "1", name: "선택", count: 1, courses: ["A", "B", "C"] })),
      roster: Array.from({ length: count }, (_, index) => ({ grade: "1", classroom: "1", number: String(index + 1), name: `학생${index + 1}` })),
    })]);
  };
  return { db, as, call, create };
}

test("학교 이름은 2~60자, 계정당 신청 수 제한은 계정마다 따로", async () => {
  const ctx = await setup();
  await assert.rejects(ctx.create(owner, { schoolName: " 고 " }), /학교 이름을 2~60자/);
  await ctx.db.exec("reset role; update public.course_limits set max_events_per_owner = 2");
  const first = await ctx.create(owner, { round: "1" });
  assert.ok(first.id);
  await ctx.create(owner, { round: "2" });
  await assert.rejects(ctx.create(owner, { round: "3" }), /2개까지입니다/);
  // 다른 계정은 영향을 받지 않는다.
  assert.ok((await ctx.create(other, { round: "1" })).id);
  // 지우면 다시 만들 수 있다(기존 삭제 입구).
  await ctx.as("authenticated", owner);
  await ctx.call("select public.manage_course_event($1,'delete')", [first.id]);
  assert.ok((await ctx.create(owner, { round: "3" })).id);
});

test("계정당 학생 수 합계 제한", async () => {
  const ctx = await setup();
  await ctx.db.exec("reset role; update public.course_limits set max_students_per_owner = 5");
  await ctx.create(owner, { count: 3 });
  await assert.rejects(ctx.create(owner, { round: "2", count: 3 }), /모두 5명까지/);
  // 실패한 신청은 남지 않는다(한 트랜잭션).
  await ctx.as("authenticated", owner);
  const list = await ctx.call("select public.list_own_course_events()");
  assert.equal(list.length, 1);
  assert.equal(list[0].students, 3);
  assert.ok((await ctx.create(other, { count: 5 })).id);
});

test("학년도가 끝난 신청도 만든 교사가 보고 지울 수 있다(다른 교사는 불가)", async () => {
  const ctx = await setup();
  const event = await ctx.create(owner);
  await ctx.create(other);
  // 학년도를 지난 해로 돌려 '끝난 신청'으로 만든다.
  await ctx.db.exec("reset role");
  await ctx.db.query("update public.course_events set school_year='2020' where id=$1", [event.id]);
  await ctx.as("authenticated", owner);
  // 기존 입구는 막힌다.
  await assert.rejects(ctx.call("select public.manage_course_event($1,'delete')", [event.id]));
  const visible = await ctx.db.query("select id from public.course_events");
  assert.equal(visible.rows.length, 0, "행 보안: 끝난 신청은 목록에 없다");
  const list = await ctx.call("select public.list_own_course_events()");
  assert.deepEqual(list.map((item) => [item.schoolYear, item.active, item.students]), [["2020", false, 3]]);
  assert.ok(!JSON.stringify(list).includes("학생1"), "목록에 학생 이름이 없다");
  await ctx.as("authenticated", other);
  await assert.rejects(ctx.call("select public.delete_own_course_event($1)", [event.id]), /본인이 만든/);
  await ctx.as("authenticated", owner);
  const result = await ctx.call("select public.delete_own_course_event($1)", [event.id]);
  assert.equal(result.students, 3);
  await ctx.db.exec("reset role");
  assert.equal((await ctx.db.query("select count(*)::int n from public.course_students")).rows[0].n, 3, "다른 교사 자료는 그대로");
  await ctx.as("anon");
  await assert.rejects(ctx.call("select public.list_own_course_events()"));
});

test("내 계정의 모든 신청 지우기, 01·03 초안 위에서도 실행된다", async () => {
  const ctx = await setup(["01-code-hardening.sql", "02-next-round-student-id.sql", "03-retention-purge.sql"]);
  await ctx.create(owner, { round: "1" });
  await ctx.create(owner, { round: "2" });
  await ctx.create(other);
  await ctx.as("authenticated", owner);
  const result = await ctx.call("select public.delete_all_own_course_events()");
  assert.equal(result.events, 2);
  await ctx.db.exec("reset role");
  assert.equal((await ctx.db.query("select count(*)::int n from public.course_events")).rows[0].n, 1);
});
