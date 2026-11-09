const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const storeSource = fs.readFileSync(path.join(root, "workspace-store.js"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const key = "course-certificate-studio-v1";

// 메모리 IndexedDB: 트랜잭션 안의 쓰기는 끝날 때 한 번에 반영하고, abort하면 버린다(실제 IndexedDB처럼 원자적).
function fakeIndexedDB({ failWrite = () => null } = {}) {
  const databases = new Map();
  const later = (fn) => setTimeout(fn, 0);
  const factory = {
    databases,
    open(name) {
      const request = {};
      later(() => {
        let db = databases.get(name);
        const fresh = !db;
        if (!db) { db = { stores: new Map() }; databases.set(name, db); }
        const handle = {
          objectStoreNames: { contains: (store) => db.stores.has(store) },
          createObjectStore: (store) => db.stores.set(store, new Map()),
          close() {},
          transaction(names, mode) {
            const error = mode === "readwrite" ? failWrite() : null;
            if (error) throw error;
            const writes = [];
            let pending = 0;
            let aborted = false;
            const tx = {};
            const finish = () => later(() => {
              if (aborted || pending) return;
              for (const [store, op, value, id] of writes) {
                if (op === "put") db.stores.get(store).set(id, value);
                else db.stores.get(store).delete(id);
              }
              tx.oncomplete?.();
            });
            const req = (compute) => {
              const r = {};
              pending++;
              later(() => {
                if (aborted) return;
                r.result = compute();
                pending--;
                r.onsuccess?.();
                finish();
              });
              return r;
            };
            tx.abort = () => { aborted = true; later(() => tx.onabort?.({ preventDefault() {} })); };
            tx.objectStore = (store) => ({
              get: (id) => req(() => db.stores.get(store).get(id)),
              getAll: () => req(() => [...db.stores.get(store).values()]),
              getAllKeys: () => req(() => [...db.stores.get(store).keys()]),
              put: (value, id) => { writes.push([store, "put", value, id]); return {}; },
              delete: (id) => { writes.push([store, "delete", null, id]); return {}; }
            });
            finish();
            return tx;
          }
        };
        request.result = handle;
        if (fresh) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
    deleteDatabase(name) {
      const request = {};
      later(() => { databases.delete(name); request.onsuccess?.(); });
      return request;
    }
  };
  return factory;
}

function storeContext(extra = {}) {
  const context = vm.createContext({ Blob, Response, CompressionStream, DecompressionStream, setTimeout, ...extra });
  vm.runInContext(storeSource, context);
  return context;
}

function layout(seed) {
  const rows = Array.from({ length: 60 }, (_, row) => Array.from({ length: 12 }, (_, column) => `${seed}-${row}-${column}`));
  const styleTable = Array.from({ length: 80 }, (_, index) => ({ font: { bold: index % 2 === 0, color: "FFFF0000" }, border: "thin" }));
  const planData = { subjects: rows.map((row, index) => ({ id: `s${index}`, name: row[1], styles: [{ 0: index % 80 }] })) };
  return { rows, styleTable, planData, planTemplate: { header: { rows: rows.slice(0, 3) }, format: { styleTable } }, cellStyles: { "0:0": 1 } };
}

function payload() {
  const plan = layout("p");
  const students = Array.from({ length: 120 }, (_, index) => ({
    id: `s${index}`, grade: "1", classroom: "1", number: String(index), name: "학생",
    selections: [{ column: "c1", name: "물리학", credits: 4 }, { column: "c2", name: "화학", credits: 4 }], missing: undefined
  }));
  const round = { fileName: "결과.xlsx", students, courses: [{ column: "c1" }], classOverrides: {} };
  return {
    schemaVersion: 2, currentRound: "1", workflowStep: 4, schoolYear: "2026", schoolName: "가나고",
    rounds: { "1": round, "2": null }, students, courses: round.courses,
    roundStatuses: { "1": { status: "confirmed", snapshot: { rows: students.map((student) => [student.id, 1]) } } },
    courseChecks: { neis: { "2025": students.map((student) => ({ id: student.id, credits: [1, 2, 3] })) }, rules: [] },
    curriculumCohorts: { "2026": { fileName: "편제표.xlsx", importedLayout: plan, plan: [{ subject: "국어" }], templateRows: [{ subject: "국어" }] } },
    curriculumImportedLayout: plan,
    curriculumVersions: { "2026": [{ id: "v1", snapshot: { layout: layout("p"), plan: [{ subject: "국어" }] } }, { id: "v2", snapshot: { layout: layout("q") } }] },
    holes: [1, undefined, () => 1, 3]
  };
}

test("splitting the workspace keeps the exact JSON and stores identical parts only once", () => {
  const ctx = storeContext();
  const data = payload();
  const split = ctx.workspaceStoreSplit(data);
  const expanded = ctx.workspaceStoreExpand(split.core, (hash) => split.blobs.get(hash));
  assert.equal(expanded, JSON.stringify(data), "expanding the parts rebuilds the same JSON text");
  assert.ok(split.core.length < 6000, `the localStorage part stays small (${split.core.length})`);
  const plain = [...split.blobs.values()].reduce((sum, text) => sum + text.length, 0);
  assert.ok(plain < JSON.stringify(data).length * 0.6, "the active round, the plan copy and the unchanged history snapshot are shared");
  // 같은 학생 목록·같은 편제표 표(서식 표 포함)는 하나의 조각
  const studentsText = JSON.stringify(data.students);
  assert.equal([...split.blobs.values()].filter((text) => text === studentsText).length, 1);
  assert.equal([...split.blobs.values()].filter((text) => text === JSON.stringify(data.curriculumCohorts["2026"].importedLayout.styleTable)).length, 1);
  // 나이스 자료(courseChecks.neis)도 큰 조각으로 빠진다.
  assert.ok(!split.core.includes("credits"));
  assert.ok([...split.blobs.values()].some((text) => text === JSON.stringify(data.courseChecks.neis["2025"])));
});

test("a JSON replacer (values left out of saving) gives the same text as JSON.stringify with it", () => {
  const ctx = storeContext();
  const data = payload();
  data.rounds["1"].viewOnly = { scroll: 120 };
  const replacer = function (field, value) { return field === "viewOnly" || field === "missing" ? undefined : value; };
  const split = ctx.workspaceStoreSplit(data, new Map(), replacer);
  assert.equal(ctx.workspaceStoreExpand(split.core, (hash) => split.blobs.get(hash)), JSON.stringify(data, replacer));
});

test("an unchanged split reuses hashes and a changed field only changes its own parts", () => {
  const ctx = storeContext();
  const data = payload();
  const first = ctx.workspaceStoreSplit(data);
  const again = ctx.workspaceStoreSplit(data, first.cache);
  assert.equal(again.core, first.core);
  data.rounds["1"].students[0].name = "바뀐 이름";
  const changed = ctx.workspaceStoreSplit(data, again.cache);
  assert.notEqual(changed.core, first.core);
  const fresh = [...changed.blobs.keys()].filter((hash) => !first.blobs.has(hash));
  assert.ok(fresh.length >= 1 && fresh.length <= 3, `only the student list and its parents change (${fresh.length})`);
  assert.equal(ctx.workspaceStoreExpand(changed.core, (hash) => changed.blobs.get(hash)), JSON.stringify(data));
});

test("the startup settings keep only small values and form a valid empty workspace", () => {
  const ctx = storeContext();
  const split = ctx.workspaceStoreSplit(payload());
  const settings = JSON.parse(ctx.workspaceStoreSettingsRaw(split.core));
  assert.equal(settings.schoolYear, "2026");
  assert.equal(settings.workflowStep, 4);
  assert.deepEqual(settings.students, []);
  assert.deepEqual(settings.rounds, { "1": null });
  assert.equal(settings.curriculumCohorts, undefined);
  const record = ctx.workspaceStoreRecord(split.core, "r1", 5);
  assert.equal(ctx.workspaceStoreParseRecord(record).workspaceStore.rev, "r1");
  assert.equal(ctx.workspaceStoreParseRecord(JSON.stringify(payload())), null, "the old full workspace is not a store record");
});

test("IndexedDB writes are atomic, compressed, garbage-collected and refuse another window's newer save", async () => {
  const idb = fakeIndexedDB();
  const ctx = storeContext({ indexedDB: idb });
  const data = payload();
  const split = ctx.workspaceStoreSplit(data);
  const first = await ctx.workspaceStoreWrite(split, { force: true });
  const read = await ctx.workspaceStoreRead();
  assert.equal(read.raw, JSON.stringify(data));
  assert.equal(read.rev, first.rev);
  const stored = idb.databases.get("curriculum-workspace-db").stores.get("blobs");
  assert.ok([...stored.values()].some((entry) => entry.z instanceof ArrayBuffer), "large parts are gzip-compressed");
  // 학생 목록을 바꾸면 예전 조각은 지워진다.
  data.rounds["1"].students = data.rounds["1"].students.slice(0, 3);
  data.students = data.rounds["1"].students;
  const second = await ctx.workspaceStoreWrite(ctx.workspaceStoreSplit(data, split.cache), { expectedRev: first.rev, known: first.known });
  assert.equal((await ctx.workspaceStoreRead()).raw, JSON.stringify(data));
  assert.equal(stored.size, second.known.size, "unreferenced parts are deleted in the same transaction");
  // 다른 창이 그 사이에 저장했으면(번호가 다르면) 쓰지 않는다.
  data.schoolName = "다른 창보다 오래된 화면";
  await assert.rejects(ctx.workspaceStoreWrite(ctx.workspaceStoreSplit(data), { expectedRev: first.rev, known: second.known }),
    (error) => error?.name === "WorkspaceStoreConflict");
  assert.equal(JSON.parse((await ctx.workspaceStoreRead()).raw).schoolName, "가나고");
  // 조각이 없어진 자료는 읽지 않고 오류로 알린다.
  stored.delete([...stored.keys()][0]);
  await assert.rejects(ctx.workspaceStoreRead(), (error) => /찾지 못했습니다|조각/.test(error?.message));
});

test("storage usage text warns at 80 percent", () => {
  const ctx = storeContext();
  const low = ctx.workspaceStorageUsageText({ usage: 10 * 1024 * 1024, quota: 1000 * 1024 * 1024, local: 10000, localLimit: 5000000 });
  assert.equal(low.warn, false);
  assert.match(low.text, /10\.0MB 사용/);
  assert.equal(ctx.workspaceStorageUsageText({ usage: 81, quota: 100, local: 0, localLimit: 5000000 }).warn, true);
  assert.equal(ctx.workspaceStorageUsageText({ usage: 0, quota: 0, local: 4100000, localLimit: 5000000 }).warn, true);
});

// ---- app.js 연결: 예전 자료 옮기기, 저장, 시작할 때 읽기, 다른 창 충돌, 용량 초과 ----
function functionNamed(name) {
  const start = app.search(new RegExp(`\\n    (?:async )?function ${name}\\(`)) + 1;
  assert.ok(start > 0, name);
  const next = app.slice(start + 1).search(/\n    (?:async )?function /);
  return app.slice(start, start + 1 + next);
}

function appFixture({ local = new Map(), idb = fakeIndexedDB() } = {}) {
  const elements = new Map();
  const toasts = [];
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: id === "#schoolYear" ? "2026" : "", textContent: "", style: {}, dataset: {}, inert: false,
      classList: { toggle() {}, contains: () => false }, checkValidity: () => true, setAttribute() {}, removeAttribute() {}
    });
    return elements.get(id);
  };
  let fileSaves = 0;
  const context = vm.createContext({
    Blob, Response, CompressionStream, DecompressionStream, setTimeout, clearTimeout, indexedDB: idb,
    document: { querySelector: element, getElementById: (id) => element(`#${id}`) },
    window: { setTimeout, clearTimeout, confirm: () => true, location: { reload() {} } },
    navigator: {},
    localStorage: {
      get length() { return local.size; }, key: (index) => [...local.keys()][index],
      getItem: (name) => local.get(name) ?? null, setItem: (name, value) => local.set(name, String(value)), removeItem: (name) => local.delete(name)
    },
    normalizeCourses: (courses) => courses, normalizeCurriculumPlanRow: (row) => row,
    normalizeCurriculumDivisionFilter: (value) => value, normalizeCurriculumDetailFilter: (value) => value,
    resetWorkspace() {}, renderRoster() {}, renderPreview() {}, renderCurriculumStep() {}, renderSemesterClassifier() {},
    renderAggregate() {}, renderWorkflowLayout() {}, applyClassFilterOptions() {}, refreshCurriculumDerivedPlans() {},
    showAppToast: (message) => toasts.push(message),
    scheduleWorkspaceFileSave: () => { fileSaves++; return "학교자료.json"; }
  });
  vm.runInContext(storeSource, context);
  vm.runInContext(app.slice(0, app.indexOf("function escapeHtml(")), context);
  for (const name of ["syncActiveRound", "updateWorkspaceSaveStatus", "isWorkspaceStorageProtected", "workspacePayload", "persistState",
    "validateWorkspaceData", "loadCurriculumPlanData", "restorePersistedState", "applicationRoundNumbers", "syncActiveCurriculumCohort"]) {
    vm.runInContext(functionNamed(name), context);
  }
  vm.runInContext(app.slice(app.indexOf("    function readWorkspaceRecord("), app.indexOf("    const BACKUP_TIME_KEY")), context);
  vm.runInContext("statePersistenceReady = true;", context);
  const settle = async () => { for (let turn = 0; turn < 30; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); };
  return { context, local, idb, element, toasts, settle, fileSaves: () => fileSaves };
}

function legacyWorkspace(overrides = {}) {
  const students = Array.from({ length: 300 }, (_, index) => ({ id: `1-1-${index}-학생`, grade: "1", classroom: "1", number: String(index), name: "학생",
    selections: [{ column: "c1", name: "물리학", credits: 4 }] }));
  return { schemaVersion: 2, students, courses: [{ column: "c1", name: "물리학" }], currentRound: "1", workflowStep: 3, schoolYear: "2026", schoolName: "가나고",
    rounds: { "1": { fileName: "결과.xlsx", students, courses: [{ column: "c1", name: "물리학" }], classOverrides: {} } }, ...overrides };
}

test("old localStorage data moves into IndexedDB only after it reads back the same, then saves go there", async () => {
  const legacy = JSON.stringify(legacyWorkspace());
  const f = appFixture({ local: new Map([[key, legacy]]) });
  const { context } = f;
  assert.equal(context.beginWorkspaceStoreBoot(), null, "old data is read synchronously as before");
  context.restorePersistedState();
  assert.equal(vm.runInContext("state.students.length", context), 300);
  assert.equal(await context.migrateLegacyWorkspace(), true);
  await f.settle();
  const record = context.workspaceStoreParseRecord(f.local.get(key));
  assert.ok(record, "localStorage now holds only the small record");
  assert.ok(f.local.get(key).length < 2000);
  const stored = await context.workspaceStoreRead();
  assert.equal(JSON.parse(stored.raw).rounds["1"].students.length, 300);
  assert.equal(stored.rev, record.workspaceStore.rev);
  // 이후 저장은 IndexedDB로 간다.
  vm.runInContext('state.rounds["1"].fileName = "바뀐 결과.xlsx"; state.fileName = "바뀐 결과.xlsx";', context);
  assert.equal(context.persistState(), true);
  await f.settle();
  assert.equal(JSON.parse((await context.workspaceStoreRead()).raw).rounds["1"].fileName, "바뀐 결과.xlsx");
  assert.match(f.element("#workspaceSaveStatus").textContent, /저장 완료/);
  assert.ok(Number(f.local.get("course-certificate-studio-saved-at")) > 0);
});

test("a failed migration keeps the old localStorage data untouched", async () => {
  const legacy = JSON.stringify(legacyWorkspace());
  const idb = fakeIndexedDB({ failWrite: () => Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" }) });
  const f = appFixture({ local: new Map([[key, legacy]]), idb });
  f.context.beginWorkspaceStoreBoot();
  f.context.restorePersistedState();
  assert.equal(await f.context.migrateLegacyWorkspace(), false);
  assert.equal(f.local.get(key), legacy);
  assert.match(f.toasts.at(-1), /옮기지 못했습니다\(브라우저 저장 공간이 부족합니다\(용량 초과\)\)/);
  assert.equal(vm.runInContext("workspaceStoreState.active", f.context), false);
});

test("startup reads the store, a newer save from another window blocks overwriting, and a full store explains itself", async () => {
  let fail = null;
  const idb = fakeIndexedDB({ failWrite: () => fail });
  const seed = appFixture({ idb });
  const data = legacyWorkspace({ schoolName: "저장본" });
  const split = seed.context.workspaceStoreSplit(data);
  const written = await seed.context.workspaceStoreWrite(split, { force: true });
  const local = new Map([[key, seed.context.workspaceStoreRecord(split.core, written.rev, written.savedAt)]]);
  const f = appFixture({ local, idb });
  const { context } = f;
  vm.runInContext("statePersistenceReady = false;", context);
  const boot = context.beginWorkspaceStoreBoot();
  assert.ok(boot);
  context.restorePersistedState(boot.settingsRaw);
  assert.equal(f.element("#schoolName").value, "저장본", "small settings are restored before IndexedDB answers");
  assert.equal(vm.runInContext("state.students.length", context), 0);
  await context.completeWorkspaceStoreBoot(boot);
  assert.equal(vm.runInContext("state.students.length", context), 300);
  assert.equal(vm.runInContext("workspaceStoreState.rev", context), written.rev);
  // 다른 창이 저장(번호 변경)한 뒤 이 창이 저장하면 덮어쓰지 않는다.
  data.schoolName = "다른 창";
  await seed.context.workspaceStoreWrite(seed.context.workspaceStoreSplit(data), { force: true });
  f.element("#schoolName").value = "이 창";
  assert.equal(context.persistState(), true);
  await f.settle();
  assert.match(f.element("#workspaceSaveStatus").textContent, /다른 창의 저장 자료가 변경되어 덮어쓰기를 중지했습니다/);
  assert.equal(vm.runInContext("statePersistenceBlocked", context), true);
  assert.equal(JSON.parse((await context.workspaceStoreRead()).raw).schoolName, "다른 창");
  // 저장 재개(강제) 후 용량 초과: 안내하고 PC 파일 저장을 예약한다.
  vm.runInContext("statePersistenceBlocked = false; workspaceStoreState.force = true; workspaceStoreState.lastCore = null; lastSavedWorkspace = localStorage.getItem(STORAGE_KEY);", context);
  fail = Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" });
  const before = f.fileSaves();
  context.persistState();
  await f.settle();
  assert.equal(f.element("#workspaceSaveStatus").textContent, "자동 저장 실패: 브라우저 저장 공간이 부족합니다(용량 초과) · PC 파일 '학교자료.json'에는 저장을 시도합니다");
  assert.ok(f.fileSaves() > before);
  assert.equal(context.workspaceStoreBusy(), false);
  // 공간이 생기면 다시 저장된다.
  fail = null;
  context.persistState();
  await f.settle();
  assert.match(f.element("#workspaceSaveStatus").textContent, /저장 완료/);
  assert.equal(JSON.parse((await context.workspaceStoreRead()).raw).schoolName, "이 창");
});

test("a store record without its IndexedDB data is protected instead of starting empty", async () => {
  const f = appFixture({ local: new Map([[key, '{"workspaceStore":{"db":"curriculum-workspace-db","format":1,"rev":"x","savedAt":1},"core":"{\\"schoolYear\\":\\"2026\\"}"}']]) });
  vm.runInContext("statePersistenceReady = false;", f.context);
  const boot = f.context.beginWorkspaceStoreBoot();
  f.context.restorePersistedState(boot.settingsRaw);
  await f.context.completeWorkspaceStoreBoot(boot);
  assert.equal(vm.runInContext("statePersistenceBlocked", f.context), true);
  assert.match(f.element("#workspaceSaveStatus").textContent, /복원 실패 · 기존 저장 원본 보호 중: 새 저장소\(IndexedDB\)에서 작업 자료를 찾지 못했습니다/);
});
