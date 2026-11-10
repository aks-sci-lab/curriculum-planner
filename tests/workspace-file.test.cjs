const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "workspace-file.js"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function functionSource(text, start, end) {
  const first = text.indexOf(start);
  const last = text.indexOf(end, first + start.length);
  assert.notEqual(first, -1, `missing marker ${start}`);
  assert.notEqual(last, -1, `missing marker ${end}`);
  return text.slice(first, last);
}

function memoryStorage(initial = []) {
  const map = new Map(initial);
  return {
    map,
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); }
  };
}

function backupText(workspace, createdAt) {
  return JSON.stringify({ type: "curriculum-workspace-backup", backupVersion: 1, createdAt, workspace }, null, 2);
}

function fakeHandle(name = "자료.json", { permission = "granted" } = {}) {
  const handle = {
    name, content: "", writes: 0, permission, modified: 1000,
    queryPermission: async () => handle.permission,
    requestPermission: async () => { handle.permission = "granted"; return "granted"; },
    createWritable: async () => ({ write: async (text) => { handle.pending = text; }, close: async () => { handle.content = handle.pending; handle.writes++; handle.modified++; } }),
    getFile: async () => ({ lastModified: handle.modified, text: async () => handle.content })
  };
  return handle;
}

function load({ handleStore = {}, storage = memoryStorage(), backup = () => ({ type: "curriculum-workspace-backup", backupVersion: 1, createdAt: new Date().toISOString(), workspace: { a: 1 } }) } = {}) {
  const elements = new Map();
  const toasts = [];
  const confirms = [];
  const stored = { handle: handleStore.handle || null };
  const ctx = vm.createContext({
    window: { confirm: (message) => { confirms.push(message); return ctx.confirmAnswer !== false; } },
    indexedDB: {}, document: { getElementById: () => null }, Date, setTimeout, clearTimeout, setInterval: () => 0,
    localStorage: storage, workspaceBrowserSavedAt: () => ctx.browserSavedAt || 0, workspaceHasWork: () => ctx.browserHasWork !== false,
    buildWorkspaceBackup: backup, isWorkspaceStorageProtected: () => false, markWorkspaceBackup() {},
    showAppToast: (message) => toasts.push(message),
    restoreWorkspaceBackup: async (file, afterWrite, options = {}) => {
      ctx.restored = await file.text();
      ctx.restoreOptions = options;
      if (ctx.confirmRestore === false) return false;
      await afterWrite();
      return true;
    },
    APP_VERSION: "1.0.0", APP_UPDATE_URL: ""
  });
  vm.runInContext(source, ctx);
  // 실제 IndexedDB 대신 메모리에 연결 정보를 둔다.
  ctx.workspaceFileStore = async (operation, handle) => {
    if (operation === "put") stored.handle = handle;
    else if (operation === "delete") stored.handle = null;
    return stored.handle;
  };
  return { ctx, stored, toasts, elements, confirms, storage };
}

// 시작할 때 연결된 파일이 있는 상태를 만든다(권한 허용, 파일 선택 기능 있음).
async function start({ fileText = "", browser = { a: 1 }, browserSavedAt = 0, browserHasWork = true, confirmAnswer = false, storage } = {}) {
  const handle = fakeHandle("학교자료.json");
  handle.content = fileText;
  const loaded = load({ handleStore: { handle }, storage, backup: () => ({ type: "curriculum-workspace-backup", backupVersion: 1, createdAt: new Date().toISOString(), workspace: browser }) });
  Object.assign(loaded.ctx, { browserSavedAt, browserHasWork, confirmAnswer });
  loaded.ctx.window.showSaveFilePicker = () => {};
  loaded.ctx.window.showOpenFilePicker = () => {};
  await loaded.ctx.initWorkspaceFile();
  return { ...loaded, handle };
}

test("the file is only offered where the browser can write to a chosen file", () => {
  const { ctx } = load();
  assert.equal(ctx.workspaceFileSupported(), false);
  ctx.window.showSaveFilePicker = () => {};
  ctx.window.showOpenFilePicker = () => {};
  assert.equal(ctx.workspaceFileSupported(), true);
});

test("connecting writes the current workspace and later saves skip unchanged content", async () => {
  const { ctx, stored } = load();
  const handle = fakeHandle();
  ctx.window.showSaveFilePicker = async () => handle;
  await ctx.connectWorkspaceFile();
  assert.equal(stored.handle, handle);
  assert.equal(handle.writes, 1);
  assert.equal(JSON.parse(handle.content).type, "curriculum-workspace-backup");
  assert.equal(await ctx.saveWorkspaceFileNow(), true);
  assert.equal(handle.writes, 1, "identical content is not rewritten even though createdAt changes");
  ctx.buildWorkspaceBackup = () => ({ type: "curriculum-workspace-backup", createdAt: "x", workspace: { a: 2 } });
  await ctx.saveWorkspaceFileNow();
  assert.equal(handle.writes, 2);
  assert.equal(ctx.workspaceFileState.status, "saved");
});

test("a revoked permission is reported instead of failing, and allowing it saves again", async () => {
  const { ctx, stored } = load({ handleStore: { handle: fakeHandle("a.json", { permission: "prompt" }) } });
  ctx.window.showSaveFilePicker = () => {};
  ctx.window.showOpenFilePicker = () => {};
  await ctx.initWorkspaceFile();
  assert.equal(ctx.workspaceFileState.status, "needs-permission");
  assert.equal(stored.handle.writes, 0);
  await ctx.allowWorkspaceFile();
  assert.equal(stored.handle.writes, 1);
  assert.equal(ctx.workspaceFileState.status, "saved");
});

test("a write failure keeps the app running and shows the reason", async () => {
  const { ctx } = load();
  const handle = fakeHandle();
  handle.createWritable = async () => { throw new Error("디스크 가득 참"); };
  ctx.window.showSaveFilePicker = async () => handle;
  await ctx.connectWorkspaceFile();
  assert.equal(ctx.workspaceFileState.status, "error");
  assert.match(ctx.workspaceFileState.message, /디스크 가득 참/);
});

test("opening a file links it only after the restore really replaced the workspace", async () => {
  const { ctx, stored } = load();
  const handle = fakeHandle("기존.json");
  handle.content = '{"type":"curriculum-workspace-backup"}';
  ctx.window.showOpenFilePicker = async () => [handle];
  ctx.confirmRestore = false;
  await ctx.openWorkspaceFile();
  assert.equal(stored.handle, null, "declining the restore must not link a file that auto-save would then overwrite");
  ctx.confirmRestore = true;
  await ctx.openWorkspaceFile();
  assert.equal(stored.handle, handle);
  assert.equal(ctx.restored, handle.content);
});

test("protected storage never writes the file, and disconnecting stops saving", async () => {
  const { ctx, stored } = load();
  const handle = fakeHandle();
  ctx.window.showSaveFilePicker = async () => handle;
  await ctx.connectWorkspaceFile();
  ctx.isWorkspaceStorageProtected = () => true;
  ctx.buildWorkspaceBackup = () => ({ type: "curriculum-workspace-backup", createdAt: "", workspace: { a: 3 } });
  assert.equal(await ctx.saveWorkspaceFileNow(), false);
  assert.equal(handle.writes, 1);
  await ctx.disconnectWorkspaceFile();
  assert.equal(stored.handle, null);
  ctx.isWorkspaceStorageProtected = () => false;
  assert.equal(await ctx.saveWorkspaceFileNow(), false);
});

test("the update check only runs with an update address and reports newer versions", async () => {
  const { ctx } = load();
  assert.equal(await ctx.checkForNewAppVersion(), null);
  const notice = { textContent: "", classList: { removed: false, remove() { this.removed = true; } } };
  ctx.document.getElementById = (id) => (id === "appUpdateNotice" ? notice : null);
  ctx.APP_UPDATE_URL = "https://example.test/version.json";
  ctx.fetch = async () => ({ ok: true, json: async () => ({ version: "1.1.0" }) });
  assert.equal(await ctx.checkForNewAppVersion(), "1.1.0");
  assert.match(notice.textContent, /1\.1\.0/);
  ctx.fetch = async () => ({ ok: true, json: async () => ({ version: "1.0.0" }) });
  assert.equal(await ctx.checkForNewAppVersion(), null);
  ctx.fetch = async () => { throw new Error("offline"); };
  assert.equal(await ctx.checkForNewAppVersion(), null, "offline use is never an error");
});

test("a PC file newer than the browser data is never overwritten at startup; declining stops saving to it", async () => {
  const fileTime = new Date(2026, 10, 6, 9, 30).getTime();
  const browserTime = new Date(2026, 10, 5, 17, 10).getTime();
  const fileText = backupText({ a: 9 }, new Date(fileTime).toISOString());
  const { ctx, handle, confirms } = await start({ fileText, browser: { a: 1 }, browserSavedAt: browserTime, confirmAnswer: false });
  assert.equal(confirms.length, 1);
  assert.match(confirms[0], /^PC 파일이 더 최신입니다\(파일: 2026-11-06 09:30, 브라우저: 2026-11-05 17:10\)\. 파일 내용을 불러올까요\?/);
  assert.equal(handle.writes, 0);
  assert.equal(handle.content, fileText, "the newer file keeps its content");
  assert.equal(ctx.workspaceFileState.status, "stale");
  assert.match(ctx.workspaceFileState.message, /PC 파일 저장 중지 — 파일이 더 최신/);
  assert.equal(await ctx.saveWorkspaceFileNow({ force: true }), false, "no save path writes while the file is newer");
  assert.equal(ctx.scheduleWorkspaceFileSave(), "", "edits do not schedule a write either");
  assert.equal(handle.writes, 0);
  assert.equal(ctx.restored, undefined, "declining keeps the browser data");
});

test("accepting the newer PC file loads it without a second confirmation and remembers it as in sync", async () => {
  const fileText = backupText({ a: 9 }, new Date(Date.now() + 60000).toISOString());
  const { ctx, handle, storage } = await start({ fileText, browserSavedAt: Date.now() - 3600000, confirmAnswer: true });
  assert.equal(ctx.restored, fileText);
  assert.equal(ctx.restoreOptions.confirmed, true);
  assert.equal(handle.writes, 0);
  const sync = JSON.parse(storage.getItem("course-certificate-studio-file-sync"));
  assert.equal(sync.hash, ctx.workspaceTextHash(JSON.stringify({ ...JSON.parse(fileText), createdAt: "" })));
});

test("an empty browser always asks before a linked file with data is replaced", async () => {
  const fileText = backupText({ a: 9 }, "2026-01-01T00:00:00.000Z");
  const { handle, confirms } = await start({ fileText, browser: {}, browserSavedAt: Date.now(), browserHasWork: false });
  assert.equal(confirms.length, 1, "even with a later browser save time, empty data never silently replaces the file");
  assert.equal(handle.writes, 0);
});

test("the browser data is written without asking when only the browser changed since the last file save", async () => {
  const storage = memoryStorage();
  const fileText = backupText({ a: 1 }, new Date().toISOString());
  const comparable = JSON.stringify({ ...JSON.parse(fileText), createdAt: "" });
  const probe = load({ storage });
  probe.ctx.rememberWorkspaceFileSync(comparable);
  const { ctx, handle, confirms } = await start({ fileText, browser: { a: 2 }, browserSavedAt: 0, storage });
  assert.equal(confirms.length, 0, "the file is exactly what this browser wrote last");
  assert.equal(handle.writes, 1);
  assert.deepEqual(JSON.parse(handle.content).workspace, { a: 2 });
  assert.equal(ctx.workspaceFileState.status, "saved");
});

test("identical content is not rewritten, and a changed file is never replaced just because the browser saved later", async () => {
  const same = await start({ fileText: backupText({ a: 1 }, "2026-01-01T00:00:00.000Z"), browser: { a: 1 } });
  assert.equal(same.confirms.length, 0);
  assert.equal(same.handle.writes, 0);
  assert.equal(same.ctx.workspaceFileState.status, "saved");
  const older = await start({ fileText: backupText({ a: 5 }, "2026-01-01T00:00:00.000Z"), browser: { a: 1 }, browserSavedAt: Date.now() });
  assert.equal(older.confirms.length, 1, "without a record of what this browser wrote, a different file is asked about");
  assert.match(older.confirms[0], /^PC 파일 내용이 이 브라우저 자료와 다릅니다\(파일: 2026-01-01 \d\d:\d\d, 브라우저: \d{4}-/);
  assert.equal(older.handle.writes, 0);
  assert.deepEqual(JSON.parse(older.handle.content).workspace, { a: 5 });
});

test("a file changed elsewhere after this browser's last save always asks, even when the browser saved later", async () => {
  const storage = memoryStorage();
  const written = backupText({ a: 1 }, "2026-11-01T00:00:00.000Z");
  load({ storage }).ctx.rememberWorkspaceFileSync(JSON.stringify({ ...JSON.parse(written), createdAt: "" }));
  const fileTime = new Date(2026, 10, 2, 8, 0).getTime();
  const browserTime = new Date(2026, 10, 3, 15, 45).getTime();
  const fileText = backupText({ a: 7 }, new Date(fileTime).toISOString());
  const { ctx, handle, confirms } = await start({ fileText, browser: { a: 2 }, browserSavedAt: browserTime, storage, confirmAnswer: false });
  assert.equal(confirms.length, 1);
  assert.match(confirms[0], /^PC 파일이 이 브라우저가 마지막으로 저장한 뒤 다른 곳\(다른 PC 등\)에서 바뀌었습니다\(파일: 2026-11-02 08:00, 브라우저: 2026-11-03 15:45\)\. 파일 내용을 불러올까요\?/);
  assert.equal(handle.writes, 0);
  assert.equal(handle.content, fileText);
  assert.equal(ctx.workspaceFileState.status, "stale");
  assert.match(ctx.workspaceFileState.message, /파일이 다른 곳에서 바뀜/);
  assert.equal(await ctx.saveWorkspaceFileNow({ force: true }), false);
  assert.equal(handle.writes, 0);
});

test("a file changed by another PC while the app is open is checked before the next save", async () => {
  const { ctx, confirms } = load();
  const handle = fakeHandle("학교자료.json");
  ctx.window.showSaveFilePicker = async () => handle;
  await ctx.connectWorkspaceFile();
  assert.equal(handle.writes, 1);
  const other = backupText({ a: 42 }, new Date().toISOString());
  handle.content = other;
  handle.modified += 50;
  ctx.confirmAnswer = false;
  ctx.browserSavedAt = Date.now() + 60000;
  ctx.buildWorkspaceBackup = () => ({ type: "curriculum-workspace-backup", backupVersion: 1, createdAt: "", workspace: { a: 2 } });
  assert.equal(await ctx.saveWorkspaceFileNow(), false);
  assert.equal(confirms.length, 1);
  assert.match(confirms[0], /다른 곳\(다른 PC 등\)에서 바뀌었습니다/);
  assert.equal(handle.writes, 1);
  assert.equal(handle.content, other, "the other PC's changes are kept");
  assert.equal(ctx.workspaceFileState.status, "stale");
});

test("a touched file whose content is still what this browser wrote keeps saving without asking", async () => {
  const { ctx, confirms } = load();
  const handle = fakeHandle("학교자료.json");
  ctx.window.showSaveFilePicker = async () => handle;
  await ctx.connectWorkspaceFile();
  handle.modified += 50;
  ctx.buildWorkspaceBackup = () => ({ type: "curriculum-workspace-backup", backupVersion: 1, createdAt: "", workspace: { a: 2 } });
  assert.equal(await ctx.saveWorkspaceFileNow(), true);
  assert.equal(confirms.length, 0);
  assert.equal(handle.writes, 2);
  assert.deepEqual(JSON.parse(handle.content).workspace, { a: 2 });
});

test("a file that is not workspace data is left alone", async () => {
  const { ctx, handle } = await start({ fileText: '{"hello":1}' });
  assert.equal(handle.writes, 0);
  assert.equal(ctx.workspaceFileState.status, "stale");
  assert.match(ctx.workspaceFileState.message, /작업 자료 파일이 아닙니다/);
});

test("after declining, overwriting with the browser data needs an explicit confirmation", async () => {
  const fileText = backupText({ a: 9 }, new Date(Date.now() + 60000).toISOString());
  const { ctx, handle, confirms } = await start({ fileText, browserSavedAt: 1, confirmAnswer: false });
  assert.equal(await ctx.allowWorkspaceFile(), false);
  assert.equal(handle.writes, 0);
  assert.match(confirms.at(-1), /덮어씁니다/);
  ctx.confirmAnswer = true;
  assert.equal(await ctx.allowWorkspaceFile(), true);
  assert.equal(handle.writes, 1);
  assert.deepEqual(JSON.parse(handle.content).workspace, { a: 1 });
});

test("granting a revoked permission checks the file first instead of overwriting it", async () => {
  const handle = fakeHandle("a.json", { permission: "prompt" });
  handle.content = backupText({ a: 9 }, new Date(Date.now() + 60000).toISOString());
  const { ctx, confirms } = load({ handleStore: { handle } });
  Object.assign(ctx, { browserSavedAt: 1, confirmAnswer: false });
  ctx.window.showSaveFilePicker = () => {};
  ctx.window.showOpenFilePicker = () => {};
  await ctx.initWorkspaceFile();
  assert.equal(ctx.workspaceFileState.status, "needs-permission");
  await ctx.allowWorkspaceFile();
  assert.equal(confirms.length, 1);
  assert.match(confirms[0], /PC 파일이 더 최신입니다/);
  assert.equal(handle.writes, 0);
});

test("full reset disconnects the PC file, says the file itself is kept, and never writes the emptied data to it", async () => {
  const storage = memoryStorage([["course-certificate-studio-v1", "{}"], ["course-certificate-studio-saved-at", "1"], ["curriculum-teacher-session-v1", "keep"]]);
  const { ctx, stored, confirms } = load({ storage });
  const handle = fakeHandle("학교자료.json");
  ctx.window.showSaveFilePicker = async () => handle;
  await ctx.connectWorkspaceFile();
  assert.equal(handle.writes, 1);
  const saved = handle.content;
  let reloaded = 0;
  const deleted = [];
  Object.assign(ctx, {
    requireLocalWorkspaceAccess: () => true, lastWorkspaceBackup: () => Date.now(), downloadWorkspaceBackup() {},
    indexedDB: { deleteDatabase: (name) => { deleted.push(name); const request = {}; setTimeout(() => request.onsuccess(), 0); return request; } }
  });
  ctx.window.prompt = () => "초기화";
  ctx.window.clearTimeout = () => {};
  ctx.window.location = { reload: () => { reloaded++; } };
  vm.runInContext("var statePersistenceBlocked = false, statePersistenceTimer = null;", ctx);
  vm.runInContext(functionSource(app, "const WORKSPACE_RESET_KEYS", "const WORKSPACE_BACKUP_VERSION"), ctx);
  ctx.scheduleWorkspaceFileSave();
  await ctx.resetWorkspaceAll();
  assert.match(confirms.at(-1), /'학교자료\.json' — 연결된 PC 파일은 지우지 않고 연결만 끊습니다/);
  assert.equal(reloaded, 1);
  assert.equal(stored.handle, null, "the saved link is forgotten");
  assert.equal(ctx.workspaceFileHandle, null);
  assert.deepEqual(deleted, ["curriculum-workspace-file", "curriculum-original-workbooks", "curriculum-workspace-db"]);
  assert.deepEqual([...storage.map.keys()], ["curriculum-teacher-session-v1"]);
  ctx.buildWorkspaceBackup = () => ({ type: "curriculum-workspace-backup", backupVersion: 1, createdAt: "", workspace: {} });
  assert.equal(await ctx.saveWorkspaceFileNow({ force: true }), false);
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal(handle.writes, 1, "a save scheduled before the reset does not write the emptied data");
  assert.equal(handle.content, saved);
});

test("if the link survives a reset, the emptied browser asks instead of saving over the file", async () => {
  const fileText = backupText({ a: 9 }, "2026-01-01T00:00:00.000Z");
  const { handle, confirms } = await start({ fileText, browser: {}, browserHasWork: false, browserSavedAt: 0, confirmAnswer: false });
  assert.equal(confirms.length, 1);
  assert.equal(handle.writes, 0);
  assert.equal(handle.content, fileText);
});

function persistContext({ failStorage }) {
  const storage = memoryStorage();
  const { ctx, toasts } = load({ storage, backup: () => ({ type: "curriculum-workspace-backup", backupVersion: 1, createdAt: "", workspace: ctx.payload }) });
  const timers = [];
  ctx.setTimeout = (callback) => { timers.push(callback); return timers.length; };
  ctx.clearTimeout = () => {};
  const statuses = [];
  Object.assign(ctx, {
    payload: { a: 1 },
    syncActiveRound() {}, syncActiveCurriculumCohort() {},
    $: () => ({ checkValidity: () => true }),
    workspacePayload: () => ctx.payload,
    updateWorkspaceSaveStatus: (message, failed = false) => statuses.push({ message, failed })
  });
  ctx.window.clearTimeout = () => {};
  storage.setItem = (key, value) => {
    if (failStorage && key === "course-certificate-studio-v1") {
      const error = new Error("Setting the value of 'course-certificate-studio-v1' exceeded the quota.");
      error.name = "QuotaExceededError";
      throw error;
    }
    storage.map.set(key, String(value));
  };
  vm.runInContext(`var STORAGE_KEY = "course-certificate-studio-v1", WORKSPACE_SAVED_AT_KEY = "course-certificate-studio-saved-at";
    var statePersistenceTimer = null, statePersistenceBlocked = false, statePersistenceSuppressed = 0, protectedStoredState = null;
    var lastSavedWorkspace = null, workspaceStartupFlush = false, workspaceStoreState = { active: false };`, ctx);
  vm.runInContext(functionSource(app, "function persistState(", "const BACKUP_TIME_KEY"), ctx);
  return { ctx, storage, statuses, timers, toasts };
}

test("when the browser storage is full the linked PC file is still saved and the failure is explained", async () => {
  const { ctx, storage, statuses, timers } = persistContext({ failStorage: true });
  const handle = fakeHandle("학교자료.json");
  ctx.window.showSaveFilePicker = async () => handle;
  await ctx.connectWorkspaceFile();
  assert.equal(handle.writes, 1);
  ctx.payload = { a: 2 };
  assert.equal(ctx.persistState(), false);
  assert.equal(storage.getItem("course-certificate-studio-v1"), null);
  assert.equal(statuses.at(-1).failed, true);
  assert.match(statuses.at(-1).message, /자동 저장 실패: 브라우저 저장 공간이 부족합니다\(용량 초과\) · PC 파일 '학교자료\.json'에는 저장을 시도합니다/);
  assert.equal(timers.length, 1, "a file save is scheduled even though the browser save failed");
  timers.shift()();
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handle.writes, 2);
  assert.deepEqual(JSON.parse(handle.content).workspace, { a: 2 });
  assert.equal(ctx.workspaceFileState.status, "saved");
  assert.equal(storage.getItem("course-certificate-studio-saved-at"), null, "the browser save time only moves when the browser really saved");
});

test("a failing PC file save after a browser storage failure is reported too", async () => {
  const { ctx, timers, toasts } = persistContext({ failStorage: true });
  const handle = fakeHandle("학교자료.json");
  ctx.window.showSaveFilePicker = async () => handle;
  await ctx.connectWorkspaceFile();
  handle.createWritable = async () => { throw new Error("디스크 가득 참"); };
  ctx.payload = { a: 3 };
  ctx.persistState();
  timers.shift()();
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.workspaceFileState.status, "error");
  assert.match(toasts.at(-1), /PC 파일 저장 실패: 디스크 가득 참/);
});

test("without a linked file a storage failure still explains itself and successful saves record the browser time", () => {
  const failing = persistContext({ failStorage: true });
  assert.equal(failing.ctx.persistState(), false);
  assert.equal(failing.statuses.at(-1).message, "자동 저장 실패: 브라우저 저장 공간이 부족합니다(용량 초과)");
  const ok = persistContext({ failStorage: false });
  assert.equal(ok.ctx.persistState(), true);
  assert.ok(Number(ok.storage.getItem("course-certificate-studio-saved-at")) > 0);
  ok.ctx.payload = { a: 4 };
  ok.storage.map.delete("course-certificate-studio-saved-at");
  vm.runInContext("workspaceStartupFlush = true", ok.ctx);
  ok.ctx.persistState();
  assert.equal(ok.storage.getItem("course-certificate-studio-saved-at"), null, "startup clean-up saves do not count as user edits");
});

test("after the switch to backup format 2 the first compare overwrites silently with a sync record and asks once without one; files are written without indentation", async () => {
  const students = [{ id: "s1", grade: "1" }];
  // 예전 앱(형식 1)이 들여써서 쓴 파일: workspace.students가 들어 있다.
  const oldBackup = { type: "curriculum-workspace-backup", backupVersion: 1, createdAt: "2026-11-01T00:00:00.000Z",
    workspace: { currentRound: "1", rounds: { "1": { students } }, students } };
  const fileText = JSON.stringify(oldBackup, null, 2);
  // 지금 앱(형식 2): 같은 자료지만 현재 차수와 같은 students를 빼고 omitted를 적는다.
  const browserBackup = () => ({ type: "curriculum-workspace-backup", backupVersion: 2, createdAt: new Date().toISOString(),
    workspace: { currentRound: "1", rounds: { "1": { students } } }, omitted: ["students"] });
  const begin = async (storage) => {
    const handle = fakeHandle("학교자료.json");
    handle.content = fileText;
    const loaded = load({ handleStore: { handle }, storage, backup: browserBackup });
    Object.assign(loaded.ctx, { browserSavedAt: Date.now(), browserHasWork: true, confirmAnswer: false });
    loaded.ctx.window.showSaveFilePicker = () => {};
    loaded.ctx.window.showOpenFilePicker = () => {};
    await loaded.ctx.initWorkspaceFile();
    return { ...loaded, handle };
  };
  // ① 이 브라우저가 예전에 그 파일을 썼다는 지문이 있으면: 바뀐 쪽은 브라우저(형식만 바뀜)이므로 묻지 않고 덮어쓴다.
  const storage = memoryStorage();
  load({ storage }).ctx.rememberWorkspaceFileSync(JSON.stringify({ ...oldBackup, createdAt: "" }));
  const synced = await begin(storage);
  assert.equal(synced.confirms.length, 0);
  assert.equal(synced.handle.writes, 1);
  assert.equal(synced.handle.content.includes("\n"), false, "written without indentation");
  const written = JSON.parse(synced.handle.content);
  assert.equal(written.backupVersion, 2);
  assert.deepEqual(written.omitted, ["students"]);
  // ② 지문이 없으면 한 번 묻고, 거절하면 파일을 그대로 둔다.
  const unsynced = await begin(memoryStorage());
  assert.equal(unsynced.confirms.length, 1);
  assert.equal(unsynced.handle.writes, 0);
  assert.equal(unsynced.handle.content, fileText);
});
