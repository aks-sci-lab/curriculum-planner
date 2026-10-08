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
    this.style = {};
    this.value = "";
    this.disabled = false;
    this.textContent = "";
    const classes = new Set();
    this.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) };
  }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  appendChild(child) { child.parent = this; this.children.push(child); }
  append(...children) { children.forEach((child)=>this.appendChild(child)); }
  closest(selector) {
    for (let element=this;element;element=element.parent) {
      if (selector==="fieldset[data-group]" && element.tag==="fieldset" && element.dataset.group) return element;
    }
    return null;
  }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  getAttribute(name) { return this[name]; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { this.clicked = true; }
  focus() { this.focused = true; }
  querySelector(selector) {
    return this.children.find((child) => selector === ".course-history" && child.className === "course-history" ||
      selector === "legend" && child.tag === "legend") || null;
  }
  remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
  querySelectorAll(selector) {
    const result = [];
    const visit = (element) => {
      if (selector === "input" && element.tag === "input" ||
          selector === "button" && element.tag === "button" ||
          selector === "fieldset[data-group]" && element.tag === "fieldset" && element.dataset.group ||
          selector === "input:checked" && element.tag === "input" && element.checked) result.push(element);
      element.children.forEach(visit);
    };
    this.children.forEach(visit);
    return result;
  }
}

function fixture({ href = "https://school.example/app/", storage = new Map(), respond, menus = false, subjects, WebSocketClass } = {}) {
  const elements = {};
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) elements[match[2]] = new Element(match[1]);
  for (const [name,panel] of [["Groups","applicationGroupsPanel"],["Online","supabaseTeacherPanel"],
    ["Results","applicationResultsPanel"]]) {
    elements[`application${name}Tab`].setAttribute("aria-controls",panel);
  }
  const requests = [];
  const downloads = [];
  const redirects = [];
  const history = [];
  const sockets = [];
  const context = vm.createContext({
    document: {
      body: new Element("body"),
      getElementById: (id) => {
        assert.ok(elements[id], `Missing HTML element ${id}`);
        return elements[id];
      },
      createElement: (tag) => new Element(tag),
      createTextNode: (text) => Object.assign(new Element("#text"), { textContent: text }),
    },
    URL, URLSearchParams, crypto: webcrypto, TextEncoder,
    Date: class extends Date {
      static now() { return fixtureData.now ?? Date.now(); }
    },
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    window: {
      location: { href, assign: (url) => redirects.push(url) },
      history: { replaceState: (state, title, url) => history.push(url) },
      confirm: () => true,
      print: () => { fixtureData.printed = true; },
      addEventListener: (name, callback) => { fixtureData.activity[name] = callback; },
      setInterval: (callback, delay) => {
        if (delay === 30000) fixtureData.poll = callback;
        else if (delay === 25000) fixtureData.heartbeat = callback;
        else fixtureData.idle = callback;
        return delay;
      },
      clearInterval: (id) => {
        if (id===30000) fixtureData.poll = null;
        else if (id===25000) fixtureData.heartbeat = null;
        else fixtureData.idle = null;
      },
      setTimeout: (callback, delay) => { fixtureData.reconnect = {callback,delay}; return delay; },
      clearTimeout: (id) => { if (fixtureData.reconnect?.delay===id) fixtureData.reconnect = null; },
    },
    switchWorkflowStep: (step) => { fixtureData.step = step; },
    state: { currentRound: "2" },
    selectedApplicationSubjects: () => fixtureData.subjects,
    renderApplicationSubjects: () => { fixtureData.renderedGrade = context.state.applicationMenuGrade; },
    renderRoundStatus: () => {},
    renderAggregate: () => { fixtureData.aggregateRenders = (fixtureData.aggregateRenders || 0) + 1; },
    renderClosurePanel: () => {},
    renderRetakePanel: () => {},
    getCourseApplicationGroups: () => [{id:"g1",grade:"2",name:"수학",count:1,courses:["수학"]}],
    setApplicationTargetGrades: (grades) => { fixtureData.targetGrades = grades; },
    getGroupedApplicationSubjects: () => fixtureData.subjects,
    applicationCourseLabel: (course) => `${course.subject}${course.type ? `(${course.type.replace(/선택$/,"")})` : ""}`,
    applyCloudApplicationResults: (round,entries,subjects) => {
      fixtureData.synced = {round,entries,subjects};
      fixtureData.syncCalls.push(fixtureData.synced);
    },
    parseWorkbook: async () => fixtureData.workbook || [],
    parseApplicationRoster: () => fixtureData.roster,
    downloadTextFile: (text, name) => downloads.push({ data: JSON.parse(text), name }),
    downloadRowsXlsx: (rows,name) => downloads.push({rows:JSON.parse(JSON.stringify(rows)),name}),
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
  if (WebSocketClass) {
    context.WebSocket = class extends WebSocketClass {
      constructor(url) { super(url); sockets.push(this); }
    };
    context.WebSocket.OPEN = WebSocketClass.OPEN;
  }
  const fixtureData = {
    elements, requests, downloads, storage, redirects, history, syncCalls: [], activity:{}, qrLinks:[], sockets, poll:null,
    subjects: subjects || { "2": [{subject:"수학",credit:3,semester:"1"}], "3": [] },
    roster: [{ grade: "1", classroom: "1", number: "1", name: "가상학생" }],
    respond: respond || (async () => ({ data: [] })),
    async settle() {
      for (let i = 0; i < 20; i++) await new Promise(setImmediate);
    },
    async fire(id, type) {
      elements[id].listeners[type]({ preventDefault() {}, target: elements[id] });
      for (let i = 0; i < 10; i++) await new Promise(setImmediate);
    },
    openRealtime() { sockets[sockets.length-1]?.open(); },
    notifyRealtime(id) { sockets[sockets.length-1]?.notify(id); },
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "vendor", "qrcode.js"), "utf8"), context);
  const generateQR=context.qrcode;
  context.qrcode=(...args)=>{
    const qr=generateQR(...args),addData=qr.addData;
    qr.addData=(text,...options)=>{fixtureData.qrLinks.push(text);return addData(text,...options);};
    return qr;
  };
  if (menus) vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "course-groups.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "supabase-client.js"), "utf8"), context);
  fixtureData.unlinkRound=(round)=>context.unlinkApplicationRound(round);
  fixtureData.setGrade=(grade)=>{
    if (menus) context.switchApplicationMenuGrade(grade);
    else { context.state.applicationMenuGrade=grade; context.updateApplicationGradeControls(); }
  };
  fixtureData.groupSettings=()=>context.getApplicationGroupSettings();
  return fixtureData;
}

test("grade menus scope groups and rebuild colors without removing the other grade", async () => {
  const key = "curriculum-color-semester-groups-v3";
  const storage = new Map([[key, JSON.stringify([
    {id:"g2",grade:"2",semester:"1",name:"2학년 보관",count:1,courses:["수학"]},
    {id:"g3",grade:"3",semester:"1",name:"3학년 보관",count:1,courses:["영어"]}
  ])]]);
  const f=fixture({storage,menus:true,subjects:{
    "2":[{subject:"수학",semester:"1",credit:3}], "3":[{subject:"영어",semester:"1",credit:3}]
  }});
  assert.equal(f.renderedGrade,"1");
  assert.equal(f.elements.applicationGrade1Tab["aria-selected"],"true");
  const grid=f.elements.courseGroupEditor.children.find((child)=>child.className==="course-group-grid");
  assert.equal(grid.children[0].className,"course-group-empty");
  assert.equal(grid.children[0].children.find((child)=>child.textContent==="표시 과목 전체 선택").disabled,true);
  assert.equal(grid.children[1].children[1].className,"course-group-name");
  assert.equal(grid.children[1].children[2].className,"course-group-count");
  const tabs=f.elements.courseGroupEditor.children.find((child)=>child.className==="group-scope-tabs");
  assert.ok(tabs.children.every((tab)=>tab.textContent.startsWith("2학년")));
  f.elements.courseGroupEditor.children.find((child)=>child.textContent==="편제표 색상으로 다시 구성").onclick();
  assert.ok(f.groupSettings().some((group)=>group.grade==="3" && group.name==="3학년 보관"));
  await f.fire("applicationGrade2Tab","click");
  assert.equal(f.renderedGrade,"2");
  assert.equal(f.elements.applicationGrade2Tab["aria-selected"],"true");
  assert.equal(f.elements.applicationGrade1Tab["aria-selected"],"false");
  await f.fire("applicationGrade1Tab","click");
  assert.equal(f.renderedGrade,"1");
  f.elements.applicationGrade1Tab.listeners.keydown({key:"ArrowRight",preventDefault(){}});
  assert.equal(f.elements.applicationGrade2Tab.focused,true);
  assert.equal(f.elements.applicationGradeWorkspace["aria-labelledby"],"applicationGrade2Tab");
});

test("grade menu deployment loads versioned application scripts to bypass stale caches", () => {
  const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
  const versions=["app","xlsx-parser","course-groups","curriculum-workbook","supabase-client"].map((name)=>{
    const match=html.match(new RegExp(`src="${name}\\.js\\?v=([^"]+)"`));
    assert.ok(match,`${name} must have a deployment version`);
    return match[1];
  });
  assert.equal(new Set(versions).size,1);
});

test("teacher student preview uses real selection flow without submitting to server and restores on close", async () => {
  const f=fixture();
  await f.fire("cloudPreviewStudent","click");
  assert.equal(f.elements.cloudStudentPreviewDialog.open,true);
  assert.match(f.elements.cloudStudentIdentity.textContent,/미리보기 학생/);
  const box=f.elements.cloudStudentChoices.children[0].children[1].children[0];
  box.checked=true;
  await f.fire("cloudStudentChoices","change");
  await f.fire("cloudStudentApplication","submit");
  assert.match(f.elements.cloudStudentMessage.textContent,/실제 신청은 저장되지/);
  assert.equal(f.requests.length,0);
  await f.fire("cloudStudentPreviewClose","click");
  await f.fire("cloudStudentPreviewDialog","close");
  assert.equal(f.elements.supabaseStudentEntry.classList.contains("hidden"),true);
  assert.equal(f.elements.cloudStudentLogin.classList.contains("hidden"),false);
  assert.equal(f.elements.cloudStudentChoices.children.length,0);
});

test("grade menus filter online events, roster uploads and preserve each grade's draft", async () => {
  const storage=new Map([["curriculum-teacher-session-v1",JSON.stringify({lastActivity:Date.now(),session:{
    access_token:"token",refresh_token:"refresh",expires_at:Date.now()/1000+3600,user:{email:"teacher@example.invalid"}
  }})]]);
  const events=["2","3"].map((grade,index)=>({
    id:`aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa${index}`,school_name:"학교",school_year:"2026",
    round:"1",created_at:"2026-01-01",subjects:{[grade]:[{subject:"수학",credit:3}]}
  }));
  const f=fixture({storage,respond:async(request)=>({data:request.url.includes("/course_events?")?events:[]})});
  await f.settle();
  assert.equal(f.elements.cloudEventList.children.length,1);
  assert.match(f.elements.cloudEventList.children[0].children[0].textContent,/현재 1학년/);
  f.subjects["3"]=[{subject:"영어",credit:3,semester:"1"}];
  f.roster.push({grade:"2",classroom:"1",number:"1",name:"2학년 학생"});
  const upload=()=>{f.elements.cloudRosterInput.files=[{name:"명렬.xlsx",arrayBuffer:async()=>new ArrayBuffer(0)}];return f.fire("cloudRosterInput","change");};
  await upload();
  assert.match(f.elements.cloudRosterSummary.textContent,/현재 1학년 1명.*다른 학년 1명 제외/);
  const first=f.elements.cloudRosterSummary.textContent;
  f.setGrade("2");
  assert.equal(f.elements.cloudCreateEvent.disabled,true);
  assert.equal(f.elements.cloudEventList.children.length,1);
  assert.match(f.elements.cloudEventList.children[0].children[0].textContent,/현재 2학년/);
  await upload();
  assert.match(f.elements.cloudRosterSummary.textContent,/현재 2학년 1명/);
  f.setGrade("1");
  assert.equal(f.elements.cloudRosterSummary.textContent,first);
  assert.equal(f.elements.cloudCreateEvent.disabled,false);
  f.roster=[{grade:"2",classroom:"1",number:"1",name:"다른 학년"}];
  await upload();
  assert.match(f.elements.cloudTeacherMessage.textContent,/현재 1학년 학생이 없는 명렬/);
  assert.equal(f.elements.cloudCreateEvent.disabled,true);
});

test("student flow uses public RPC only, displays own data and submits selections", async () => {
  const f = fixture();
  const data = {
    student: { grade: "1", classroom: "2", number: "3", name: "가상학생" },
    schoolName: "가상학교", schoolYear: "2026", round: "2", open: true,
    courses: [
      { subject: "수학", credit: 3, type: "일반선택" },
      { subject: "과학", credit: 3, type: "일반선택" },
    ], selections: [], submittedAt: null,
  };
  f.respond = async (request) => ({ data: request.url.endsWith("get_course_application") ? data : { message: "저장 완료" } });
  f.elements.cloudStudentCode.value = "a".repeat(32);
  await f.fire("cloudStudentLogin", "submit");
  assert.match(f.elements.cloudStudentTitle.textContent, /가상학교 2차 · 2학년 수강신청/);
  assert.match(f.elements.cloudStudentIdentity.textContent, /가상학생/);
  const box = f.elements.cloudStudentChoices.children[0].children[1].children[0];
  assert.equal(f.elements.cloudStudentChoices.children[0].children[1].children[1].textContent,"수학(일반) · 3학점");
  box.checked = true;
  await f.fire("cloudStudentChoices", "change");
  assert.match(f.elements.cloudStudentTotal.textContent, /1개 · 신청 3학점/);
  assert.equal(f.elements.cloudStudentCore.textContent, "국·영·수 3학점 · 100%");
  assert.equal(f.elements.cloudStudentCoreFill.style.width, "100%");
  const scienceBox = f.elements.cloudStudentChoices.children[0].children[2].children[0];
  scienceBox.checked = true;
  await f.fire("cloudStudentChoices", "change");
  assert.equal(f.elements.cloudStudentCore.textContent, "국·영·수 3학점 · 50%");
  assert.equal(f.elements.cloudStudentCoreFill.style.width, "50%");
  scienceBox.checked = false;
  await f.fire("cloudStudentChoices", "change");
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
  assert.match(f.elements.cloudStudentMessage.textContent, /운영자/);
  f.respond = async () => ({ data: {
    student: { grade: "1", classroom: "1", number: "1", name: "가상학생" },
    schoolName: "가상학교", schoolYear: "2026", round: "1", open: false,
    courses: [{ subject: "수학", credit: 3 }], selections: ["수학"],
  } });
  await f.fire("cloudStudentLogin", "submit");
  assert.equal(f.elements.cloudStudentSave.disabled, true);
  assert.match(f.elements.cloudStudentMessage.textContent, /마감/);
});

test("code login fixes promoted grade from roster and does not expose a grade switch", async () => {
  for (const grade of ["1","2"]) {
    const targetGrade=String(Number(grade)+1);
    const f=fixture({href:"https://school.example/app/#event=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"});
    f.respond=async()=>({data:{
      student:{grade,classroom:"1",number:"1",name:"가상"},
      schoolName:"학교",schoolYear:"2026",round:"1",open:true,
      courses:[{subject:`${targetGrade}학년 과목`,credit:3}],selections:[],
      groups:[{id:"group",grade:targetGrade,name:"그룹",count:1,courses:[`${targetGrade}학년 과목`]}],
    }});
    f.elements.cloudStudentCode.value="123456";
    await f.fire("cloudStudentLogin","submit");
    assert.match(f.elements.cloudStudentTitle.textContent,new RegExp(`${targetGrade}학년 수강신청`));
    assert.match(f.elements.cloudStudentIdentity.textContent,new RegExp(`신청 대상: ${targetGrade}학년`));
    const boxes=f.elements.cloudStudentChoices.children[0].children.filter((item)=>item.tag==="label");
    assert.deepEqual(boxes.map((item)=>item.children[0].value),[`${targetGrade}학년 과목`]);
  }
});

test("teacher Google PKCE login persists session, exports Excel and clears it on logout", async () => {
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
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", students: [{ grade: "1", classroom: "1", number: "1", name: "가상학생", code: "b".repeat(32) }],
    } };
    if (r.url.includes("/course_events?")) return {data:[{
      id:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",round:"2",school_name:"가상학교",school_year:"2026",created_at:"2026-01-01",
      subjects:{"2":[{subject:"수학",credit:3,semester:"1"}],"3":[]}
    }]};
    if (r.body?.p_action==="export") return {data:{entries:[]}};
    return { data: [] };
  };
  const f = fixture({ href: "https://school.example/app/?code=test-code", storage: start.storage, respond });
  await f.settle();
  const eventListRequest = f.requests.find((request) => request.url.includes("/course_events?"));
  assert.ok(eventListRequest.url.includes("groups:selection_groups"));
  assert.equal(f.requests[0].body.auth_code, "test-code");
  assert.equal(f.requests[0].body.code_verifier, pending.verifier);
  assert.equal(f.requests[1].options.headers.Authorization, "Bearer test-token");
  assert.ok(f.storage.has("curriculum-teacher-session-v1"));
  assert.equal(f.history[0], "https://school.example/app/");
  assert.equal(f.step, 2);
  f.elements.schoolName.value = "가상학교";
  f.elements.schoolYear.value = "2026";
  f.elements.cloudRosterInput.files = [{ name: "roster.xlsx", arrayBuffer: async () => new ArrayBuffer(0) }];
  await f.fire("cloudRosterInput", "change");
  assert.equal(f.downloads.length, 0);
  assert.deepEqual([...f.targetGrades], ["2"]);
  assert.equal(f.elements.cloudCreateEvent.disabled, false);
  await f.fire("cloudCreateEvent", "click");
  assert.equal(f.downloads.length, 1);
  assert.equal(f.downloads[0].rows[1][5], "b".repeat(32));
  assert.equal(f.downloads[0].name,"학생별_신청코드.xlsx");
  assert.equal(f.elements.cloudDownloadCodes.disabled, false);
  assert.match(f.elements.cloudTeacherMessage.textContent, /신청을 생성/);
  const created=f.requests.find((request)=>request.url.endsWith("create_course_event"));
  assert.deepEqual(created.body.p_setup.subjects["3"],[]);
  assert.equal(f.synced,undefined);
  await f.fire("refreshAggregate","click");
  assert.equal(f.synced.round,"2");
  assert.equal(f.synced.entries.length,0);
  await f.fire("cloudTeacherLogout", "click");
  assert.equal(f.elements.cloudDownloadCodes.disabled, true);
  assert.match(f.elements.cloudTeacherMessage.textContent, /로그아웃/);
});

test("teacher session survives reload, gates uploads and expires after five idle minutes", async () => {
  const key="curriculum-teacher-session-v1";
  const initial=Date.now();
  const session={access_token:"token",refresh_token:"refresh",expires_at:initial/1000+3600,
    user:{email:"lany0665@gmail.com"}};
  const storage=new Map([[key,JSON.stringify({session,lastActivity:initial})]]);
  const f=fixture({storage});
  await f.settle();
  assert.equal(f.elements.curriculumGoogleLogin.disabled,true);
  assert.equal(f.elements.developerResultUpload.classList.contains("hidden"),false);
  f.now=initial+10000;
  f.activity.pointerdown({isTrusted:true});
  assert.equal(JSON.parse(storage.get(key)).lastActivity,f.now);
  f.now+=5*60*1000;
  f.idle();
  await f.settle();
  assert.equal(storage.has(key),false);
  assert.match(f.elements.cloudTeacherMessage.textContent,/5분간 활동/);
  assert.equal(f.elements.developerResultUpload.classList.contains("hidden"),true);
  assert.equal(f.poll,null);
  const expired=fixture({storage:new Map([[key,JSON.stringify({session,lastActivity:initial-300001})]])});
  await expired.settle();
  assert.equal(expired.elements.curriculumGoogleLogin.disabled,false);
  assert.equal(expired.requests.length,0);
});

test("list refresh failure preserves the restored login across reloads and allows retry", async () => {
  const key = "curriculum-teacher-session-v1";
  const storage = new Map([[key, JSON.stringify({
    lastActivity: Date.now(),
    session: {access_token:"token",refresh_token:"refresh",expires_at:Date.now()/1000+3600,
      user:{email:"teacher@example.invalid"}}
  })]]);
  const respond = async () => ({ok:false,data:{message:"column course_events.groups does not exist"}});
  const first = fixture({storage,respond});
  await first.settle();
  assert.equal(storage.has(key), true);
  assert.equal(first.elements.teacherWorkspace.classList.contains("hidden"), false);
  assert.match(first.elements.cloudTeacherMessage.textContent, /목록 갱신 실패/);
  const reloaded = fixture({storage,respond});
  await reloaded.settle();
  assert.equal(storage.has(key), true);
  assert.equal(reloaded.elements.curriculumGoogleLogin.disabled, true);
  assert.equal(reloaded.elements.teacherLoginGate.classList.contains("hidden"), true);
  reloaded.respond = async () => ({data:[]});
  await reloaded.fire("cloudRefreshEvents", "click");
  assert.match(reloaded.elements.cloudTeacherMessage.textContent, /목록을 새로 불러왔습니다/);
  assert.equal(storage.has(key), true);
});

test("normal teacher does not get developer Excel upload controls", async () => {
  const storage=new Map([["curriculum-teacher-session-v1",JSON.stringify({
    lastActivity:Date.now(),session:{access_token:"token",refresh_token:"refresh",expires_in:3600,user:{email:"teacher@example.invalid"}}
  })]]);
  const f=fixture({storage});
  await f.settle();
  assert.equal(f.elements.developerResultUpload.classList.contains("hidden"),true);
  assert.equal(f.elements.curriculumGoogleLogin.disabled,true);
  assert.equal(f.elements.teacherWorkspace.classList.contains("hidden"),false);
  assert.equal(f.elements.teacherLoginGate.classList.contains("hidden"),true);
  assert.equal(f.elements.curriculumGoogleLogin.classList.contains("hidden"),true);
  assert.equal(f.elements.headerTeacherLogout.classList.contains("hidden"),false);
});

test("logged-out teacher content is hidden and student routes do not display the teacher login gate", async () => {
  const f=fixture();
  await f.settle();
  assert.equal(f.elements.teacherWorkspace.classList.contains("hidden"),true);
  assert.equal(f.elements.teacherLoginGate.classList.contains("hidden"),false);
  assert.equal(f.elements.teacherHeader.classList.contains("hidden"),false);
  for (const hash of ["#student","#event=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","#apply=https%3A%2F%2Fscript.google.com"]) {
    const student=fixture({href:"https://school.example/app/"+hash});
    await student.settle();
    assert.equal(student.elements.teacherHeader.classList.contains("hidden"),true);
    assert.equal(student.elements.teacherLoginGate.classList.contains("hidden"),true);
    assert.equal(student.elements.teacherWorkspace.classList.contains("hidden"),true);
  }
});

test("an in-flight token refresh cannot restore a session after idle logout", async () => {
  const initial=Date.now(),key="curriculum-teacher-session-v1";
  const session={access_token:"old",refresh_token:"refresh",expires_at:initial/1000-1,user:{email:"lany0665@gmail.com"}};
  const storage=new Map([[key,JSON.stringify({session,lastActivity:initial})]]);
  let finishRefresh;
  const f=fixture({storage,respond:async(request)=>{
    if(request.url.includes("grant_type=refresh_token")) return new Promise((resolve)=>{finishRefresh=resolve;});
    return {data:[]};
  }});
  await f.settle();
  assert.equal(typeof finishRefresh,"function");
  f.now=initial+300000;
  f.idle();
  finishRefresh({data:{...session,access_token:"new",expires_at:initial/1000+3600}});
  await f.settle();
  assert.equal(storage.has(key),false);
  assert.equal(f.elements.curriculumGoogleLogin.disabled,false);
  assert.equal(f.elements.cloudTeacherControls.classList.contains("hidden"),true);
  assert.equal(f.elements.teacherWorkspace.classList.contains("hidden"),true);
  assert.equal(f.elements.teacherLoginGate.classList.contains("hidden"),false);
  assert.equal(f.requests.filter((r)=>r.url.includes("course_events")).length,0);
});

test("an authenticated response arriving after idle logout does not restore teacher controls", async () => {
  const initial=Date.now(),key="curriculum-teacher-session-v1";
  const session={access_token:"token",refresh_token:"refresh",expires_in:3600,user:{email:"lany0665@gmail.com"}};
  let finish;
  const f=fixture({storage:new Map([[key,JSON.stringify({session,lastActivity:initial})]]),
    respond:async(request)=>request.url.includes("course_events")
      ?new Promise((resolve)=>{finish=resolve;}):{data:[]}});
  await f.settle();
  assert.equal(typeof finish,"function");
  f.now=initial+300000;
  f.idle();
  finish({data:[]});
  await f.settle();
  assert.equal(f.elements.cloudTeacherControls.classList.contains("hidden"),true);
  assert.equal(f.storage.has(key),false);
  assert.equal(f.elements.cloudEventList.children.length,0);
});

test("saved Excel code files preserve leading zeroes and can be used for mail merge repeatedly", async () => {
  const f=fixture();
  f.workbook=[{rows:[
    ["신청ID","현재학년","반","번호","이름","신청코드","학생링크"],
    ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","1","1","1","가상","001234","link"],
  ]}];
  f.elements.cloudCodeFile.files=[{name:"codes.xlsx",arrayBuffer:async()=>new ArrayBuffer(0)}];
  await f.fire("cloudCodeFile","change");
  assert.equal(f.elements.cloudCodeDialog.open,true);
  assert.match(f.elements.cloudCodePreview.innerHTML,/001234/);
  await f.fire("cloudDownloadCodes","click");
  assert.equal(f.downloads[0].rows[1][5],"001234");
  assert.equal(f.downloads[0].name,"학생별_신청코드.xlsx");
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
  assert.equal((preview.match(/class="code-qr"/g) || []).length,2);
  assert.equal((preview.match(/<svg /g) || []).length,2);
  assert.ok(!preview.includes("<img"));
  f.elements.cloudPrintClass.value = "1:2";
  await f.fire("cloudPrintClass", "change");
  assert.ok(!f.elements.cloudCodePreview.innerHTML.includes("000123"));
  assert.ok(f.elements.cloudCodePreview.innerHTML.includes("456789"));
  await f.fire("cloudCodePrint", "click");
  assert.equal(f.printed, true);
  assert.equal(f.elements.cloudCodeDialog.open, true);
  assert.equal((f.elements.printBatch.innerHTML.match(/class="print-page"/g) || []).length, 1);
  assert.equal((f.elements.printBatch.innerHTML.match(/<svg /g) || []).length,1);
  f.elements.printBatch.innerHTML = "";
  await f.fire("cloudCodePrint", "click");
  assert.ok(f.elements.printBatch.innerHTML.includes("456789"));
  assert.ok(f.qrLinks.length>=4);
  assert.ok(f.qrLinks.every((link)=>link==="https://school.example/app/#event="+codes.id));
  assert.equal(f.requests.length,0);
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
        subjects: {"2":[{subject:"수학",credit:3}],"3":[]},
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

  test("student group counters and exact counts prevent incomplete or excess submissions", async () => {
    const id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const f=fixture({href:`https://school.example/app/#event=${id}`});
    f.respond=async(r)=>({data:r.url.endsWith("get_scoped_course_application")?{
      student:{grade:"1",classroom:"1",number:"1",name:"가상"},schoolName:"학교",schoolYear:"2026",round:"1",open:true,
      courses:[{subject:"A",credit:3,type:"융합선택"},{subject:"B",credit:4,type:"진로선택"}],selections:[],
      groups:[{id:"g",name:"교과",count:1,courses:["A","B"]}],
    }:{message:"저장"}});
    f.elements.cloudStudentCode.value="123456";
    await f.fire("cloudStudentLogin","submit");
    const fieldset=f.elements.cloudStudentChoices.children[0];
    assert.equal(fieldset.children[1].children[1].textContent,"A(융합) · 3학점");
    assert.equal(fieldset.children[2].children[1].textContent,"B(진로) · 4학점");
    assert.match(fieldset.children[0].textContent,/0\/1/);
    fieldset.children[1].children[0].checked=true;
    fieldset.children[2].children[0].checked=true;
    await f.fire("cloudStudentApplication","submit");
    assert.match(f.elements.cloudStudentMessage.textContent,/정확히 1/);
    assert.equal(f.requests.length,1);
    fieldset.children[2].children[0].checked=false;
    await f.fire("cloudStudentChoices","change");
    assert.match(fieldset.children[0].textContent,/1\/1/);
    await f.fire("cloudStudentApplication","submit");
    assert.equal(f.requests.length,2);
  });

  test("group editor starts unassigned and requires manual groups and counts", () => {
    const f=fixture();
    const storage=new Map();
    const subjects={"2":[{subject:"A",semester:"1",area:"사회"},{subject:"B",semester:"1",area:"사회"},
      {subject:"C",semester:"1",area:"과학"}],"3":[{subject:"3학년 과목",semester:"1"}]};
    const ctx=vm.createContext({
      document:{getElementById:(id)=>f.elements[id],createElement:(tag)=>new Element(tag),
        createTextNode:(text)=>Object.assign(new Element("#text"),{textContent:text})},
      window:{confirm:()=>true},
      localStorage:{getItem:(k)=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},
      crypto:webcrypto,selectedApplicationSubjects:()=>subjects,
      state:{},renderApplicationSubjects:()=>{},renderRoundStatus:()=>{},
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname,"..","course-groups.js"),"utf8"),ctx);
    ctx.setApplicationTargetGrades(["2"]);
    assert.throws(()=>ctx.getCourseApplicationGroups(),/미분류/);
    const editor=f.elements.courseGroupEditor;
    const grid=()=>editor.children.find((e)=>e.className==="course-group-grid");
    assert.equal(grid().children.filter((e)=>e.tag==="fieldset").length,1);
    editor.children.find((e)=>e.placeholder?.startsWith("새 그룹명")).value="사회·과학";
    editor.children.find((e)=>e.textContent==="그룹 만들기").onclick();
    let panels=grid().children.filter((e)=>e.tag==="fieldset");
    panels[0].children.find((e)=>e.textContent==="표시 과목 전체 선택").onclick();
    const destination=editor.children.find((e)=>e.tag==="select");
    destination.value=destination.children[1].value;
    editor.children.find((e)=>e.textContent==="선택 과목 일괄 이동").onclick();
    assert.throws(()=>ctx.getCourseApplicationGroups(),/직접 지정/);
    panels=grid().children.filter((e)=>e.tag==="fieldset");
    const count=panels[1].children[2].children[0];
    count.value="2";count.onchange();
    const groups=JSON.parse(JSON.stringify(ctx.getCourseApplicationGroups()));
    assert.equal(groups[0].count,2);
    assert.deepEqual(groups[0].courses,["A","B","C"]);
    assert.equal(editor.children.find((e)=>e.className==="group-scope-tabs").children.length,1);
    assert.throws(()=>ctx.getCourseApplicationGroups(["2","3"]),/미분류/);
    count.value="4";count.onchange();
    assert.throws(()=>ctx.getCourseApplicationGroups(),/選択|선택 수/);
    assert.ok(storage.size);
  });

test("print button stays available on later visits and loads saved codes without reissuing", async () => {
  const f=fixture();
  await f.fire("cloudPrintCodes","click");
  assert.equal(f.elements.cloudCodeFile.clicked,true);
  assert.equal(f.elements.cloudPrintCodes.disabled,false);
  f.elements.cloudCodeFile.files=[{text:async()=>JSON.stringify({
    id:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    students:[{grade:"1",classroom:"1",number:"1",name:"가상",code:"123456"}],
  })}];
  await f.fire("cloudCodeFile","change");
  await f.fire("cloudCodeClose","click");
  await f.fire("cloudPrintCodes","click");
  assert.equal(f.elements.cloudCodeDialog.open,true);
  assert.equal(f.requests.length,0);
});

test("student group limit disables unchecked choices and re-enables them after deselection", async () => {
  const f=fixture({href:"https://school.example/app/#event=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"});
  f.respond=async()=>({data:{
    student:{grade:"1",classroom:"1",number:"1",name:"가상"},open:true,schoolName:"학교",
    courses:[{subject:"A",credit:3},{subject:"B",credit:3},{subject:"C",credit:3}],
    selections:[],groups:[{id:"g",name:"그룹",count:1,courses:["A","B"]},
      {id:"zero",name:"선택 안 함",count:0,courses:["C"]}],
  }});
  f.elements.cloudStudentCode.value="123456";
  await f.fire("cloudStudentLogin","submit");
  const [a,b,c]=f.elements.cloudStudentChoices.querySelectorAll("input");
  assert.equal(c.disabled,true);
  a.checked=true;
  f.elements.cloudStudentChoices.listeners.change({target:a});
  assert.equal(a.disabled,false);
  assert.equal(b.disabled,true);
  b.checked=true; // Also reject programmatic over-selection at the change handler.
  f.elements.cloudStudentChoices.listeners.change({target:b});
  assert.equal(b.checked,false);
  assert.match(f.elements.cloudStudentMessage.textContent,/최대 1/);
  a.checked=false;
  f.elements.cloudStudentChoices.listeners.change({target:a});
  assert.equal(b.disabled,false);
});

test("linked results never start Realtime or polling and refresh only on the aggregate button", async () => {
  const ownerId="cccccccc-cccc-cccc-cccc-cccccccccccc";
  const eventId="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const otherEventId="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const storage=new Map([
    ["curriculum-teacher-session-v1",JSON.stringify({lastActivity:Date.now(),session:{
      access_token:"token",refresh_token:"refresh",expires_at:Date.now()/1000+3600,
      user:{id:ownerId,email:"teacher@example.invalid"}
    }})],
    [`curriculum-cloud-links:${ownerId}`,JSON.stringify([eventId])]
  ]);
  class MockWebSocket {
    static OPEN=1;
    constructor(url) { this.url=url; this.readyState=0; this.sent=[]; }
    open() { this.readyState=MockWebSocket.OPEN; this.onopen?.(); }
    send(message) {
      const frame=JSON.parse(message);
      this.sent.push(frame);
      if(frame[3]==="phx_join") this.onmessage?.({data:JSON.stringify([
        frame[0],frame[1],frame[2],"phx_reply",{status:"ok",response:{}}
      ])});
    }
    notify(id) {
      this.onmessage?.({data:JSON.stringify([null,null,"realtime:public:course_events","postgres_changes",{
        data:{record:{id}}
      }])});
    }
    close() { this.readyState=3; this.onclose?.(); }
  }
  let exportCount=0;
  const f=fixture({storage,WebSocketClass:MockWebSocket,respond:async(request)=>{
    if(request.url.includes("/course_events?")) return {data:[{
      id:eventId,round:"1",school_name:"학교",school_year:"2026",created_at:"2026-01-01",
      subjects:{"2":[{subject:"수학",credit:3}],"3":[]}
    }]};
    if(request.body?.p_action==="export") {
      exportCount++;
      return {data:{entries:[{grade:"1",classroom:"1",number:"1",name:"가상학생",selections:["수학"]}]}};
    }
    return {data:[]};
  }});
  await f.settle();
  assert.equal(f.sockets.length,0);
  assert.equal(f.poll,null);
  assert.equal(exportCount,0);
  await f.fire("cloudRefreshEvents","click");
  assert.equal(exportCount,0);
  await f.fire("refreshAggregate","click");
  assert.equal(exportCount,1);
  assert.equal(f.aggregateRenders,1);
  assert.match(f.elements.aggregateRefreshStatus.textContent,/최근 갱신/);
  assert.equal(f.sockets.length,0);
  await f.fire("cloudTeacherLogout","click");
  await f.fire("refreshAggregate","click");
  assert.equal(exportCount,1);
  assert.equal(f.poll,null);
});

test("linked online results sync without files, include both grades and stop on logout", async () => {
  const ids=["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"];
  const storage=new Map([
    ["curriculum-google-pkce",JSON.stringify({verifier:"a".repeat(43),createdAt:Date.now()})],
    ["curriculum-cloud-links:teacher@example.invalid",JSON.stringify(ids)],
  ]);
  const subjects=[{"2":[{subject:"A",semester:"1",credit:3}],"3":[]},
    {"2":[],"3":[{subject:"B",semester:"2",credit:4}]}];
  let entries=[
    [{grade:"1",classroom:"1",number:"1",name:"가상1",selections:["A"]}],
    [{grade:"2",classroom:"1",number:"1",name:"가상2",selections:["B"]}],
  ];
  let fail=false;
  const f=fixture({href:"https://school.example/app/?code=code",storage,respond:async(r)=>{
    if(r.url.endsWith("grant_type=pkce")) return {data:{
      access_token:"token",refresh_token:"refresh",expires_in:3600,user:{email:"teacher@example.invalid"}
    }};
    if(r.url.includes("/course_events?")) return {data:ids.map((id,index)=>({
      id,round:"1",school_name:"학교",school_year:"2026",created_at:"2026-01-01",subjects:subjects[index]
    }))};
    if(r.body?.p_action==="export") return fail?{ok:false,data:{message:"연결 실패"}}:
      {data:{entries:entries[ids.indexOf(r.body.p_event)]}};
    return {data:{message:"완료"}};
  }});
  await f.settle();
  assert.equal(f.synced,undefined);
  await f.fire("refreshAggregate","click");
  assert.equal(f.synced.round,"1");
  assert.equal(f.synced.entries.length,2);
  assert.equal(f.synced.subjects["3"][0].subject,"B");
  assert.equal(f.downloads.length,0);
  const before=f.syncCalls.length;
  await f.fire("refreshAggregate","click");
  assert.equal(f.syncCalls.length,before); // Unchanged snapshots don't repaint the page.
  entries[0]=[];
  await f.fire("refreshAggregate","click");
  assert.equal(f.synced.entries.length,1);
  fail=true;
  await f.fire("refreshAggregate","click");
  assert.match(f.elements.aggregateRefreshStatus.textContent,/갱신 실패.*연결 실패/);
  assert.equal(f.synced.entries.length,1);
  fail=false;
  entries[0]=[{...entries[1][0],name:"중복"}];
  await f.fire("refreshAggregate","click");
  assert.match(f.elements.aggregateRefreshStatus.textContent,/동일 학생/);
  assert.equal(f.synced.entries.length,1);
  await f.fire("cloudTeacherLogout","click");
  assert.equal(f.poll,null);
});

test("manual aggregate refresh disables repeat clicks and reports no linked applications without exporting", async () => {
  const storage=new Map([["curriculum-teacher-session-v1",JSON.stringify({
    lastActivity:Date.now(),session:{access_token:"token",refresh_token:"refresh",expires_at:Date.now()/1000+3600,
      user:{email:"teacher@example.invalid"}}
  })]]);
  const f=fixture({storage});
  await f.settle();
  let finish;
  f.respond=async()=>new Promise((resolve)=>{finish=resolve;});
  const before=f.requests.length;
  await f.fire("refreshAggregate","click");
  assert.equal(f.elements.refreshAggregate.disabled,true);
  assert.match(f.elements.aggregateRefreshStatus.textContent,/가져오는 중/);
  await f.fire("refreshAggregate","click");
  assert.equal(f.requests.length,before+1);
  finish({data:[]});
  await f.settle();
  assert.equal(f.elements.refreshAggregate.disabled,false);
  assert.equal(f.aggregateRenders,1);
  assert.match(f.elements.aggregateRefreshStatus.textContent,/연동 신청 없음/);
  assert.equal(f.requests.some((request)=>request.body?.p_action==="export"),false);
});

test("color groups are semester scoped, editable and retain unassigned courses after reload", () => {
  const f=fixture(), storage=new Map();
  const subjects={"2":[
    {subject:"A",semester:"1·2",semesterColors:{"1":"#E2EFD9","2":"#E2EFD9"}},
    {subject:"B",semester:"1",semesterColors:{"1":"#E2EFD9"}},
    {subject:"C",semester:"2",semesterColors:{}}
  ],"3":[{subject:"D",semester:"1",semesterColors:{"1":"#E2EFD9"}}]};
  let currentSubjects=subjects;
  function load() {
    const ctx=vm.createContext({
      document:{getElementById:(id)=>f.elements[id],createElement:(tag)=>new Element(tag),
        createTextNode:(text)=>Object.assign(new Element("#text"),{textContent:text})},
      window:{confirm:()=>true},crypto:webcrypto,
      selectedApplicationSubjects:()=>currentSubjects,
      state:{},renderApplicationSubjects:()=>{},renderRoundStatus:()=>{},
      localStorage:{getItem:(k)=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)}});
    vm.runInContext(fs.readFileSync(path.join(__dirname,"..","course-groups.js"),"utf8"),ctx);
    return ctx;
  }
  let ctx=load();
  const all=JSON.parse(JSON.stringify(ctx.getGroupedApplicationSubjects()));
  assert.deepEqual(all["2"].map((c)=>[c.subject,c.semester]),[["A (1학기)","1"],["A (2학기)","2"],["B","1"],["C","2"]]);
  let groups=JSON.parse(storage.get("curriculum-color-semester-groups-v3"));
  assert.equal(groups.length,3);
  assert.deepEqual(groups[0].courses,["A (1학기)","B"]);
  assert.deepEqual(groups[1].courses,["A (2학기)"]);
  assert.ok(groups.every((g)=>g.count===null));
  const savedGroups=JSON.parse(JSON.stringify(groups));
  currentSubjects=null;
  ctx=load();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.getApplicationGroupSettings())),savedGroups);
  assert.deepEqual(JSON.parse(storage.get("curriculum-color-semester-groups-v3")),savedGroups);
  currentSubjects=subjects;
  ctx.renderCourseGroups();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.getApplicationGroupSettings())),savedGroups);
  assert.throws(()=>ctx.getCourseApplicationGroups(),/미분류/);
  const editor=f.elements.courseGroupEditor;
  const targets=editor.children.find((e)=>e.tag==="select");
  assert.equal(targets.children.length,2); // Only unassigned and the current semester's group.
  const grid=editor.children.find((e)=>e.className==="course-group-grid");
  grid.children[1].children.find((e)=>e.textContent==="표시 과목 전체 선택").onclick();
  const invalidTarget=editor.children.find((e)=>e.tag==="select");
  invalidTarget.value=groups[1].id;
  editor.children.find((e)=>e.textContent==="선택 과목 일괄 이동").onclick();
  assert.match(f.elements.courseGroupMessage.textContent,/같은 학년·학기/);
  const currentGrid=editor.children.find((e)=>e.className==="course-group-grid");
  currentGrid.children[1].children.find((e)=>e.textContent==="그룹 삭제 · 과목은 미분류로").onclick();
  ctx=load();
  groups=JSON.parse(storage.get("curriculum-color-semester-groups-v3"));
  assert.equal(groups.length,2);
  assert.equal(groups[0].semester,"2");
  const tabs=editor.children.find((e)=>e.className==="group-scope-tabs");
  tabs.children[1].onclick();
  assert.match(editor.children.find((e)=>e.tag==="h4").textContent,/2학기/);
  assert.equal(editor.children.find((e)=>e.tag==="select").children.length,2);
  f.elements.applicationResultsTab.listeners.click();
  assert.equal(f.elements.applicationGroupsPanel.classList.contains("hidden"),true);
  assert.equal(f.elements.applicationResultsPanel.classList.contains("hidden"),false);
  subjects["2"]=[{subject:"C",semester:"2",semesterColors:{}}];
  ctx.renderCourseGroups();
  groups=JSON.parse(storage.get("curriculum-color-semester-groups-v3"));
  assert.equal(groups.length,1);
  assert.equal(groups[0].grade,"3");
  ctx.setApplicationTargetGrades(["3"]);
  const scopedTabs=editor.children.find((e)=>e.className==="group-scope-tabs");
  assert.equal(scopedTabs.children.length,1);
  assert.match(scopedTabs.children[0].textContent,/3학년/);
  assert.throws(()=>ctx.getCourseApplicationGroups(),/직접 지정/);
  const scopedGrid=editor.children.find((e)=>e.className==="course-group-grid");
  const count=scopedGrid.children[1].children[2].children[0];
  count.value="1";count.onchange();
  assert.equal(ctx.getCourseApplicationGroups().length,1);
  assert.equal(ctx.getCourseApplicationGroups()[0].grade,"3");
});

test("student chooses first semester before second and saves both selections together", async () => {
  const f=fixture();
  const data={student:{grade:"1",classroom:"1",number:"1",name:"가상"},schoolName:"학교",schoolYear:"2026",round:"1",
    open:true,selections:[],courses:[{subject:"B",semester:"2",credit:3},{subject:"A",semester:"1",credit:3}],
    groups:[{id:"g2",grade:"2",semester:"2",name:"2학기 선택",count:1,courses:["B"]},
      {id:"g1",grade:"2",semester:"1",name:"1학기 선택",count:1,courses:["A"]}]};
  f.respond=async(r)=>({data:r.url.includes("get_course_application")?data:{message:"저장 완료"}});
  f.elements.cloudStudentCode.value="a".repeat(32);
  await f.fire("cloudStudentLogin","submit");
  const [second,first]=f.elements.cloudStudentChoices.children;
  assert.equal(first.classList.contains("hidden"),false);
  assert.equal(second.classList.contains("hidden"),true);
  await f.fire("cloudStudentNext","click");
  assert.match(f.elements.cloudStudentMessage.textContent,/선택 수/);
  await f.fire("cloudStudentApplication","submit");
  assert.equal(f.requests.length,1);
  first.querySelectorAll("input")[0].checked=true;
  await f.fire("cloudStudentNext","click");
  assert.equal(second.classList.contains("hidden"),false);
  assert.equal(first.classList.contains("hidden"),true);
  second.querySelectorAll("input")[0].checked=true;
  await f.fire("cloudStudentPrevious","click");
  assert.equal(first.querySelectorAll("input")[0].checked,true);
  await f.fire("cloudStudentNext","click");
  await f.fire("cloudStudentApplication","submit");
  assert.deepEqual(f.requests[1].body.p_selections,["B","A"]);
});

test("deleting a round unlinks only its online events and prevents an in-flight result from restoring it", async () => {
  const ids=["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"];
  const key="curriculum-cloud-links:teacher@example.invalid";
  const storage=new Map([[key,JSON.stringify(ids)],["curriculum-teacher-session-v1",JSON.stringify({
    lastActivity:Date.now(),session:{access_token:"token",refresh_token:"refresh",expires_in:3600,user:{email:"teacher@example.invalid"}}
  })]]);
  let finish;
  const f=fixture({storage,respond:async(r)=>{
    if(r.url.includes("/course_events?"))return {data:ids.map((id,i)=>({id,round:String(i+1),
      school_name:"학교",school_year:"2026",subjects:{"2":[],"3":[]}}))};
    if(r.body?.p_action==="export")return new Promise((resolve)=>{finish=resolve;});
    return {data:[]};
  }});
  await f.settle();
  await f.fire("refreshAggregate","click");
  // The exposed round unlink helper is the one used by the local reset button.
  f.unlinkRound("1");
  finish({data:{entries:[]}});
  await f.settle();
  assert.deepEqual(JSON.parse(storage.get(key)),[ids[1]]);
  assert.equal(f.syncCalls.length,0);
  assert.ok(!f.requests.some((r)=>r.body?.p_action==="delete"));
});
