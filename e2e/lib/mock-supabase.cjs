"use strict";
// 로컬 모의 Supabase 서버: supabase/*.sql 체인을 PGlite에 올리고, Playwright route로 가로챈 요청(RPC·REST·auth)을 처리한다.
// 실제 Supabase 서버에는 요청을 보내지 않는다(가로채지 못한 요청은 abort).
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const ROOT = path.join(__dirname, "..", "..");
const CHAIN = ["setup.sql", "upgrade-codes-history.sql", "upgrade-stable-student-ids.sql",
  "upgrade-selection-groups.sql", "upgrade-semester-groups.sql", "upgrade-application-rounds.sql",
  "upgrade-teacher-selections.sql", "upgrade-academic-year-access.sql", "upgrade-reselection.sql"];
const HARDENED = ["proposed/01-code-hardening.sql", "proposed/02-next-round-student-id.sql"];
const OWNER = "11111111-1111-1111-1111-111111111111";
const EMAIL = "teacher@example.test";

async function createMockSupabase({ hardened = true } = {}) {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as
      'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
    grant usage on schema auth to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;
    insert into auth.users values ('${OWNER}');
  `);
  for (const file of [...CHAIN, ...(hardened ? HARDENED : [])]) {
    await db.exec("reset role");
    await db.exec(fs.readFileSync(path.join(ROOT, "supabase", file), "utf8"));
  }
  // PGlite는 연결 하나: 역할·설정이 섞이지 않게 요청을 차례로 처리한다.
  let queue = Promise.resolve();
  const serial = (task) => { const next = queue.then(task, task); queue = next.catch(() => {}); return next; };
  const log = [];
  let tokenSerial = 0;
  const tokens = new Set();

  function newSession() {
    const access = `mock-access-${++tokenSerial}-${Date.now()}`;
    tokens.add(access);
    return { access_token: access, refresh_token: `mock-refresh-${tokenSerial}`, token_type: "bearer",
      expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: OWNER, email: EMAIL } };
  }

  async function asRole(role, fn) {
    return serial(async () => {
      await db.exec(`reset role; set role ${role}`);
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [role === "authenticated" ? OWNER : ""]);
      try { return await fn(); } finally { await db.exec("reset role"); }
    });
  }

  async function rpc(name, args, role) {
    if (!/^\w+$/.test(name)) throw Object.assign(new Error("bad name"), { status: 404 });
    const keys = Object.keys(args || {});
    if (keys.some((key) => !/^p_\w+$/.test(key))) throw Object.assign(new Error("bad arg"), { status: 400 });
    const sql = `select public.${name}(${keys.map((key, i) => `${key} => $${i + 1}`).join(", ")}) as r`;
    const values = keys.map((key) => args[key] !== null && typeof args[key] === "object" ? JSON.stringify(args[key]) : args[key]);
    return asRole(role, async () => (await db.query(sql, values)).rows[0].r);
  }

  async function listEvents() {
    return asRole("authenticated", async () => (await db.query(
      "select id, school_name, school_year, round, is_open, created_at, subjects, selection_groups as groups from public.course_events order by created_at desc")).rows);
  }

  // 관리자용(검증): 역할 없이 직접 조회.
  async function adminQuery(sql, params = []) {
    return serial(async () => { await db.exec("reset role"); return (await db.query(sql, params)).rows; });
  }

  async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    const auth = request.headers()["authorization"] || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    const role = tokens.has(token) ? "authenticated" : "anon";
    const started = Date.now();
    const entry = { at: new Date().toISOString(), method: request.method(), path: url.pathname, role };
    const reply = (status, body) => {
      entry.status = status; entry.ms = Date.now() - started;
      log.push(entry);
      return route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" },
        body: body === undefined ? "" : JSON.stringify(body) });
    };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*",
      "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS" } });
    try {
      if (url.pathname.startsWith("/rest/v1/rpc/")) {
        const name = url.pathname.slice("/rest/v1/rpc/".length);
        entry.rpc = name;
        const body = request.postData() ? JSON.parse(request.postData()) : {};
        try {
          const result = await rpc(name, body, role);
          return reply(200, result);
        } catch (error) {
          entry.error = error.message;
          if (/does not exist/.test(error.message) && /function/.test(error.message)) return reply(404, { code: "PGRST202", message: error.message });
          return reply(400, { code: "P0001", message: error.message });
        }
      }
      if (url.pathname === "/rest/v1/course_events" && request.method() === "GET") {
        if (role !== "authenticated") return reply(401, { message: "JWT required" });
        return reply(200, await listEvents());
      }
      if (url.pathname === "/auth/v1/token") {
        return reply(200, newSession());
      }
      if (url.pathname === "/auth/v1/logout") { tokens.delete(token); return reply(204); }
      if (url.pathname === "/auth/v1/settings") return reply(200, { external: { google: true } });
      if (url.pathname === "/auth/v1/authorize") {
        // 구글 로그인 흉내: 구글 화면 없이 바로 redirect_to?code=… 로 돌려보낸다(앱은 /auth/v1/token?grant_type=pkce 로 세션을 받음).
        const back = new URL(url.searchParams.get("redirect_to"));
        back.searchParams.set("code", `mock-code-${Date.now()}`);
        entry.status = 302; log.push(entry);
        return route.fulfill({ status: 302, headers: { location: back.href } });
      }
      entry.unhandled = true;
      return reply(404, { message: `모의 서버가 처리하지 않는 경로: ${url.pathname}` });
    } catch (error) {
      entry.error = error.message;
      return reply(500, { message: error.message });
    }
  }

  return { db, handle, log, rpc, adminQuery, newSession, OWNER, EMAIL };
}

// Playwright 컨텍스트에 연결: 설정 파일의 Supabase 주소로 가는 요청은 모두 모의 서버가, 그 밖의 외부 요청은 막는다.
async function attachMockSupabase(context, mock, { baseUrl }) {
  const config = fs.readFileSync(path.join(ROOT, "supabase-config.js"), "utf8");
  const projectUrl = config.match(/projectUrl:\s*"([^"]+)"/)[1];
  const blocked = [];
  await context.route((url) => url.href.startsWith(projectUrl) && !url.href.includes("/realtime/"), (route) => mock.handle(route));
  await context.route((url) => !url.href.startsWith(baseUrl) && !url.href.startsWith(projectUrl) && /^https?:/.test(url.protocol),
    (route) => { blocked.push(route.request().url()); return route.abort(); });
  // 실시간(websocket)은 모의하지 않는다: 앱은 30초 간격 동기화로 넘어간다.
  if (typeof context.routeWebSocket === "function") {
    await context.routeWebSocket(/realtime/, (ws) => ws.close());
  }
  return { projectUrl, blocked };
}

module.exports = { createMockSupabase, attachMockSupabase, OWNER, EMAIL };
