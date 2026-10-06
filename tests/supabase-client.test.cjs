const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { webcrypto } = require("node:crypto");

class Element {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.value = "";
    this.disabled = false;
    this.textContent = "";
    const classes = new Set();
    this.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) };
  }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  appendChild(child) { child.parent = this; this.children.push(child); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  querySelector(selector) {
    return this.children.find((child) => selector === ".course-history" && child.className === "course-history") || null;
  }
  remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
  querySelectorAll(selector) {
    const result = [];
    const visit = (element) => {
      if (selector === "button" && element.tag === "button" ||
          selector === "input:checked" && element.tag === "input" && element.checked) result.push(element);
      element.children.forEach(visit);
    };
    this.children.forEach(visit);
    return result;
  }
}

function fixture({ href = "https://school.example/app/", storage = new Map(), respond } = {}) {
  const elements = {};
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) elements[match[2]] = new Element(match[1]);
  const requests = [];
  const downloads = [];
  const redirects = [];
  const history = [];
  const context = vm.createContext({
    document: {
      getElementById: (id) => {
        assert.ok(elements[id], `Missing HTML element ${id}`);
        return elements[id];
      },
      createElement: (tag) => new Element(tag),
      createTextNode: (text) => Object.assign(new Element("#text"), { textContent: text }),
    },
    URL, URLSearchParams, crypto: webcrypto, TextEncoder,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    window: {
      location: { href, assign: (url) => redirects.push(url) },
      history: { replaceState: (state, title, url) => history.push(url) },
      confirm: () => true,
      print: () => { fixtureData.printed = true; },
    },
    switchWorkflowStep: (step) => { fixtureData.step = step; },
    state: { currentRound: "2" },
    selectedApplicationSubjects: () => ({ "2": [{ subject: "수학", credit: 3 }], "3": [] }),
    parseWorkbook: async () => [],
    parseApplicationRoster: () => [{ grade: "1", classroom: "1", number: "1", name: "가상학생" }],
    downloadTextFile: (text, name) => downloads.push({ data: JSON.parse(text), name }),
    escapeHtml: (value) => String(value).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]),
    fetch: async (url, options) => {
      const request = { url, options, body: options.body && JSON.parse(options.body) };
      requests.push(request);
      const response = await fixtureData.respond(request);
      return { ok: response.ok !== false, text: async () => JSON.stringify(response.data) };
    },
  });
  const fixtureData = {
    elements, requests, downloads, storage, redirects, history,
    respond: respond || (async () => ({ data: [] })),
    async settle() {
      for (let i = 0; i < 20; i++) await new Promise(setImmediate);
    },
    async fire(id, type) {
      elements[id].listeners[type]({ preventDefault() {}, target: elements[id] });
      for (let i = 0; i < 10; i++) await new Promise(setImmediate);
    },
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "supabase-client.js"), "utf8"), context);
  return fixtureData;
}

test("student flow uses public RPC only, displays own data and submits selections", async () => {
  const f = fixture();
  const data = {
    student: { grade: "1", classroom: "2", number: "3", name: "가상학생" },
    schoolName: "가상학교", schoolYear: "2026", round: "2", open: true,
    courses: [{ subject: "수학", credit: 3 }], selections: [], submittedAt: null,
  };
  f.respond = async (request) => ({ data: request.url.endsWith("get_course_application") ? data : { message: "저장 완료" } });
  f.elements.cloudStudentCode.value = "a".repeat(32);
  await f.fire("cloudStudentLogin", "submit");
  assert.match(f.elements.cloudStudentTitle.textContent, /가상학교 2차/);
  assert.match(f.elements.cloudStudentIdentity.textContent, /가상학생/);
  const box = f.elements.cloudStudentChoices.children[0].children[1].children[0];
  box.checked = true;
  await f.fire("cloudStudentChoices", "change");
  assert.match(f.elements.cloudStudentSummary.textContent, /1개 · 3학점/);
  await f.fire("cloudStudentApplication", "submit");
  assert.equal(f.elements.cloudStudentMessage.textContent, "저장 완료");
  assert.deepEqual(f.requests[1].body.p_selections, ["수학"]);
  assert.ok(f.requests.every((r) => !r.options.headers.Authorization));
  assert.ok(f.requests.every((r) => r.options.credentials === "omit"));
  await f.fire("cloudStudentCode", "input");
  assert.equal(f.elements.cloudStudentChoices.children.length, 0);
  await f.fire("cloudStudentApplication", "submit");
  assert.match(f.elements.cloudStudentMessage.textContent, /본인 확인/);
  assert.equal(f.requests.length, 2);
});

test("closed applications disable submission and setup errors are explicit", async () => {
  const f = fixture();
  f.elements.cloudStudentCode.value = "a".repeat(32);
  f.respond = async () => ({ ok: false, data: { code: "PGRST202" } });
  await f.fire("cloudStudentLogin", "submit");
  assert.match(f.elements.cloudStudentMessage.textContent, /supabase\/setup.sql/);
  f.respond = async () => ({ data: {
    student: { grade: "1", classroom: "1", number: "1", name: "가상학생" },
    schoolName: "가상학교", schoolYear: "2026", round: "1", open: false,
    courses: [{ subject: "수학", credit: 3 }], selections: ["수학"],
  } });
  await f.fire("cloudStudentLogin", "submit");
  assert.equal(f.elements.cloudStudentSave.disabled, true);
  assert.match(f.elements.cloudStudentMessage.textContent, /마감/);
});

test("teacher Google PKCE login, roster creation and logout do not persist credentials", async () => {
  const start = fixture();
  start.respond = async () => ({ data: { external: { google: true } } });
  await start.fire("cloudTeacherGoogleLogin", "click");
  await start.settle();
  assert.equal(start.redirects.length, 1);
  const authorize = new URL(start.redirects[0]);
  assert.equal(authorize.searchParams.get("provider"), "google");
  assert.equal(authorize.searchParams.get("redirect_to"), "https://school.example/app/");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "s256");
  const pending = JSON.parse(start.storage.get("curriculum-google-pkce"));
  assert.match(pending.verifier, /^[A-Za-z0-9_-]{43}$/);
  const challenge = Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.verifier))).toString("base64url");
  assert.equal(authorize.searchParams.get("code_challenge"), challenge);
  const respond = async (r) => {
    if (r.url.endsWith("grant_type=pkce")) return { data: {
      access_token: "test-token", refresh_token: "test-refresh", expires_in: 3600, user: { email: "teacher@example.invalid" },
    } };
    if (r.url.endsWith("create_course_event")) return { data: {
      id: "event-id", students: [{ grade: "1", classroom: "1", number: "1", name: "가상학생", code: "b".repeat(32) }],
    } };
    return { data: [] };
  };
  const f = fixture({ href: "https://school.example/app/?code=test-code", storage: start.storage, respond });
  await f.settle();
  assert.equal(f.requests[0].body.auth_code, "test-code");
  assert.equal(f.requests[0].body.code_verifier, pending.verifier);
  assert.equal(f.requests[1].options.headers.Authorization, "Bearer test-token");
  assert.equal(f.storage.size, 0);
  assert.equal(f.history[0], "https://school.example/app/");
  assert.equal(f.step, 2);
  f.elements.schoolName.value = "가상학교";
  f.elements.schoolYear.value = "2026";
  f.elements.cloudRosterInput.files = [{ name: "roster.xlsx", arrayBuffer: async () => new ArrayBuffer(0) }];
  await f.fire("cloudRosterInput", "change");
  assert.equal(f.downloads.length, 1);
  assert.equal(f.downloads[0].data.students[0].code, "b".repeat(32));
  assert.equal(f.elements.cloudDownloadCodes.disabled, false);
  assert.match(f.elements.cloudTeacherMessage.textContent, /신청을 생성/);
  await f.fire("cloudTeacherLogout", "click");
  assert.equal(f.elements.cloudDownloadCodes.disabled, true);
  assert.match(f.elements.cloudTeacherMessage.textContent, /로그아웃/);
});

test("Google login reports missing provider, missing verifier, expired verifier and denial", async () => {
  const disabled = fixture();
  disabled.respond = async () => ({ data: { external: { google: false } } });
  await disabled.fire("cloudTeacherGoogleLogin", "click");
  assert.equal(disabled.redirects.length, 0);
  assert.match(disabled.elements.cloudTeacherMessage.textContent, /활성화/);
  for (const [href, pending, message] of [
    ["?code=test", null, /확인 정보가 없습니다/],
    ["?code=test", { verifier: "a".repeat(43), createdAt: 0 }, /만료/],
    ["?error=access_denied&error_description=cancelled", null, /cancelled/],
  ]) {
    const storage = new Map(pending ? [["curriculum-google-pkce", JSON.stringify(pending)]] : []);
    const f = fixture({ href: "https://school.example/app/" + href, storage });
    await f.settle();
    assert.match(f.elements.cloudTeacherMessage.textContent, message);
    assert.equal(f.requests.length, 0);
    assert.equal(f.storage.size, 0);
    assert.equal(f.history[0], "https://school.example/app/");
  }
});

test("six-digit codes preserve leading zeroes and always use the scoped school event", async () => {
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const f = fixture({ href: `https://school.example/app/#event=${id}` });
  f.respond = async (request) => ({ data: request.url.endsWith("get_scoped_course_application") ? {
    student: { grade: "1", classroom: "1", number: "1", name: "가상" },
    schoolName: "학교", schoolYear: "2026", round: "1", open: true,
    courses: [{ subject: "수학", credit: 3 }], selections: ["수학"],
  } : { message: "저장 완료" } });
  f.elements.cloudStudentCode.value = "001234";
  await f.fire("cloudStudentLogin", "submit");
  assert.equal(f.requests[0].body.p_code, "001234");
  assert.equal(f.requests[0].body.p_event, id);
  await f.fire("cloudStudentApplication", "submit");
  assert.ok(f.requests[1].url.endsWith("save_scoped_course_application"));
  assert.equal(f.requests[1].body.p_event, id);
  const common = fixture();
  common.elements.cloudStudentCode.value = "001234";
  await common.fire("cloudStudentLogin", "submit");
  assert.equal(common.requests.length, 0);
  assert.match(common.elements.cloudStudentMessage.textContent, /학교·차수별/);
});

test("saved codes open mail merge preview, filter by class, escape names and print each student", async () => {
  const f = fixture();
  const codes = {
    id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    students: [
      { grade: "1", classroom: "1", number: "1", name: "<script>가상</script>", code: "000123" },
      { grade: "1", classroom: "2", number: "2", name: "가상2", code: "456789" },
    ],
  };
  f.elements.cloudCodeFile.files = [{ text: async () => JSON.stringify(codes) }];
  await f.fire("cloudCodeFile", "change");
  assert.equal(f.elements.cloudCodeDialog.open, true);
  const preview = f.elements.cloudCodePreview.innerHTML;
  assert.ok(preview.includes("000123"));
  assert.ok(preview.includes("#event="));
  assert.ok(!preview.includes("<script>"));
  f.elements.cloudPrintClass.value = "1:2";
  await f.fire("cloudPrintClass", "change");
  assert.ok(!f.elements.cloudCodePreview.innerHTML.includes("000123"));
  assert.ok(f.elements.cloudCodePreview.innerHTML.includes("456789"));
  await f.fire("cloudCodePrint", "click");
  assert.equal(f.printed, true);
  assert.equal(f.elements.cloudCodeDialog.open, false);
  assert.equal((f.elements.printBatch.innerHTML.match(/class="print-page"/g) || []).length, 1);
});

test("teacher log controls send the exact server cutoff and optional student id", async () => {
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const studentId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const cutoff = "2026-10-06T08:30:00.123456+00:00";
  const f = fixture({
    href: "https://school.example/app/?code=callback",
    storage: new Map([["curriculum-google-pkce", JSON.stringify({ verifier: "a".repeat(43), createdAt: Date.now() })]]),
    respond: async (request) => {
      if (request.url.endsWith("grant_type=pkce")) return { data: {
        access_token: "test", refresh_token: "test-refresh", expires_in: 3600, user: { email: "teacher@example.invalid" },
      } };
      if (request.url.includes("/course_events?")) return { data: [{
        id, school_name: "학교", school_year: "2026", round: "1", is_open: true, created_at: cutoff,
      }] };
      if (request.url.endsWith("course_event_history")) return { data: {
        startedAt: "2026-10-06T08:00:00Z",
        entries: [{ id: 1, studentId, grade: "1", classroom: "1", number: "1",
          name: "가상", at: cutoff, action: "submit", selections: ["수학"], submittedAt: cutoff }],
      } };
      return { data: { message: "복원 완료" } };
    },
  });
  await f.settle();
  const event = f.elements.cloudEventList.children[0];
  assert.ok(event.children.find((e) => e.tag === "a").href.includes("#event="));
  event.children.find((e) => e.textContent === "신청 로그 · 롤백").listeners.click();
  await f.settle();
  let panel = event.querySelector(".course-history");
  let row = panel.children.find((e) => e.textContent.includes(" · submit"));
  row.children.find((e) => e.textContent.includes("학생 롤백")).listeners.click();
  await f.settle();
  let rollback = f.requests.find((r) => r.url.endsWith("rollback_course_event"));
  assert.equal(rollback.body.p_student, studentId);
  assert.equal(rollback.body.p_before, cutoff);
  panel = event.querySelector(".course-history");
  row = panel.children.find((e) => e.textContent.includes(" · submit"));
  row.children.find((e) => e.textContent.includes("전체 롤백")).listeners.click();
  await f.settle();
  rollback = f.requests.filter((r) => r.url.endsWith("rollback_course_event")).at(-1);
  assert.equal(rollback.body.p_student, null);
  assert.equal(rollback.body.p_before, cutoff);
});
