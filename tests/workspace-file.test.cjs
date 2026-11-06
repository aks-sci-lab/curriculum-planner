const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "workspace-file.js"), "utf8");

function fakeHandle(name = "자료.json", { permission = "granted" } = {}) {
  const handle = {
    name, content: "", writes: 0, permission,
    queryPermission: async () => handle.permission,
    requestPermission: async () => { handle.permission = "granted"; return "granted"; },
    createWritable: async () => ({ write: async (text) => { handle.pending = text; }, close: async () => { handle.content = handle.pending; handle.writes++; } }),
    getFile: async () => ({ text: async () => handle.content })
  };
  return handle;
}

function load({ handleStore = {}, backup = () => ({ type: "curriculum-workspace-backup", createdAt: new Date().toISOString(), workspace: { a: 1 } }) } = {}) {
  const elements = new Map();
  const toasts = [];
  const stored = { handle: handleStore.handle || null };
  const ctx = vm.createContext({
    window: {}, indexedDB: {}, document: { getElementById: () => null }, Date, setTimeout, clearTimeout, setInterval: () => 0,
    buildWorkspaceBackup: backup, isWorkspaceStorageProtected: () => false, markWorkspaceBackup() {},
    showAppToast: (message) => toasts.push(message), restoreWorkspaceBackup: async (file, afterWrite) => { ctx.restored = await file.text(); if (ctx.confirmRestore !== false) await afterWrite(); },
    APP_VERSION: "1.0.0", APP_UPDATE_URL: ""
  });
  vm.runInContext(source, ctx);
  // 실제 IndexedDB 대신 메모리에 연결 정보를 둔다.
  ctx.workspaceFileStore = async (operation, handle) => {
    if (operation === "put") stored.handle = handle;
    else if (operation === "delete") stored.handle = null;
    return stored.handle;
  };
  return { ctx, stored, toasts, elements };
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
