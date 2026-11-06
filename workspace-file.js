"use strict";
// 작업 자료를 내 PC의 파일 하나에 자동 저장한다(Chrome·Edge의 파일 접근 기능). 브라우저 저장소가 지워져도 파일에서 복구할 수 있다.
var WORKSPACE_FILE_DB = "curriculum-workspace-file";
var workspaceFileHandle = null;
var workspaceFileState = { status: "none", name: "", savedAt: 0, message: "" };
var workspaceFileLastText = "";
var workspaceFileTimer = null;
var workspaceFileBusy = false;
// 시작 확인 중이거나 파일이 브라우저 자료보다 최신이라 저장을 멈춘 동안 true. 이때는 어떤 경로로도 파일에 쓰지 않는다.
var workspaceFileHold = false;
// 이 브라우저가 마지막으로 파일에 쓴 내용의 지문. 파일이 그 뒤 다른 곳에서 바뀌었는지 알아보는 데 쓴다(전체 초기화 때 함께 지워진다).
var WORKSPACE_FILE_SYNC_KEY = "course-certificate-studio-file-sync";

function workspaceFileSupported() {
  return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function" &&
    typeof window.showOpenFilePicker === "function" && typeof indexedDB !== "undefined";
}

function workspaceFileStore(operation, handle) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(WORKSPACE_FILE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("handles");
    request.onerror = () => reject(new Error("자동 저장 파일 정보를 열지 못했습니다."));
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("handles", operation === "get" ? "readonly" : "readwrite");
      const store = tx.objectStore("handles");
      const action = operation === "get" ? store.get("handle") : operation === "put" ? store.put(handle, "handle") : store.delete("handle");
      tx.oncomplete = () => { db.close(); resolve(action.result); };
      tx.onerror = () => { db.close(); reject(new Error("자동 저장 파일 정보를 저장하지 못했습니다.")); };
    };
  });
}

function setWorkspaceFileState(patch) {
  workspaceFileState = { ...workspaceFileState, ...patch };
  renderWorkspaceFileStatus();
}

function workspaceFileAgeLabel(time) {
  if (!time) return "";
  const minutes = Math.floor((Date.now() - time) / 60000);
  return minutes < 1 ? "방금 저장" : minutes < 60 ? `${minutes}분 전 저장` : `${Math.floor(minutes / 60)}시간 전 저장`;
}

function renderWorkspaceFileStatus() {
  const label = document.getElementById("workspaceFileStatus");
  if (!label) return;
  const supported = workspaceFileSupported();
  const connect = document.getElementById("connectWorkspaceFile");
  const open = document.getElementById("openWorkspaceFile");
  const allow = document.getElementById("allowWorkspaceFile");
  const disconnect = document.getElementById("disconnectWorkspaceFile");
  for (const element of [connect, open]) element?.classList.toggle("hidden", !supported);
  label.classList.toggle("hidden", !supported || workspaceFileState.status === "none");
  if (!supported) return;
  const { status, name, savedAt, message } = workspaceFileState;
  const linked = status !== "none";
  connect.textContent = linked ? "저장 파일 바꾸기" : "자동 저장 파일 연결";
  disconnect.classList.toggle("hidden", !linked);
  allow.textContent = status === "stale" ? "브라우저 자료로 덮어쓰기" : "저장 허용";
  allow.classList.toggle("hidden", status !== "needs-permission" && status !== "stale");
  label.classList.toggle("is-warning", ["needs-permission", "error", "stale"].includes(status));
  label.textContent = status === "none" ? "PC 파일 자동 저장 안 함"
    : status === "needs-permission" ? `${name} · 저장하려면 '저장 허용'을 누르세요`
      : status === "checking" ? `${name} · 파일 확인 중`
        : status === "stale" ? `${name} · ${message || "PC 파일 저장 중지 — 파일이 더 최신"}`
          : status === "error" ? `${name} · ${message}`
            : `${name} · ${workspaceFileAgeLabel(savedAt) || "연결됨"}`;
}

async function workspaceFilePermission(handle, request = false) {
  const options = { mode: "readwrite" };
  if ((await handle.queryPermission?.(options)) === "granted") return true;
  return request && (await handle.requestPermission?.(options)) === "granted";
}

// 저장 시각만 다른 내용은 다시 쓰지 않도록 createdAt을 뺀 본문으로 비교한다.
function workspaceFileText() {
  const backup = buildWorkspaceBackup();
  const comparable = JSON.stringify({ ...backup, createdAt: "" });
  return { comparable, text: JSON.stringify(backup, null, 2) };
}

// 내용 비교용 짧은 지문(FNV-1a). 큰 자료를 localStorage에 두 번 저장하지 않으려고 쓴다.
function workspaceTextHash(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length}:${hash.toString(16)}`;
}

function readWorkspaceFileSync() {
  try { return JSON.parse(localStorage.getItem(WORKSPACE_FILE_SYNC_KEY) || "{}") || {}; } catch { return {}; }
}

function rememberWorkspaceFileSync(comparable) {
  try {
    localStorage.setItem(WORKSPACE_FILE_SYNC_KEY, JSON.stringify({ hash: workspaceTextHash(comparable), at: Date.now() }));
  } catch { /* 기록하지 못하면 다음 시작 때 저장 시각으로 비교한다. */ }
}

function workspaceFileTimeLabel(time) {
  if (!time) return "기록 없음";
  const date = new Date(time);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 연결된 파일과 지금 브라우저 자료 중 어느 쪽이 최신인지 판단한다.
// same: 내용이 같음 · browser: 브라우저가 최신(파일에 써도 됨) · file: 파일이 최신(묻기 전에는 쓰지 않음) · invalid: 작업 자료 파일이 아님
function compareWorkspaceFile({ fileText, fileModified = 0, browserComparable, browserSavedAt = 0, browserHasWork = true, syncHash = "" }) {
  if (!String(fileText || "").trim()) return { newer: "browser", fileTime: 0, browserTime: browserSavedAt };
  let backup;
  try { backup = JSON.parse(fileText); } catch { return { newer: "invalid" }; }
  if (backup?.type !== "curriculum-workspace-backup") return { newer: "invalid" };
  const fileComparable = JSON.stringify({ ...backup, createdAt: "" });
  const created = Date.parse(backup.createdAt);
  const fileTime = Number.isFinite(created) ? created : Number(fileModified) || 0;
  const result = { fileComparable, fileTime, browserTime: browserSavedAt };
  if (fileComparable === browserComparable) return { ...result, newer: "same" };
  // 파일이 이 브라우저가 마지막으로 쓴 그대로라면 바뀐 쪽은 브라우저뿐이다.
  if (syncHash && workspaceTextHash(fileComparable) === syncHash) return { ...result, newer: "browser" };
  if (!browserHasWork || fileTime > browserSavedAt) return { ...result, newer: "file" };
  return { ...result, newer: "browser" };
}

// 시작할 때(또는 권한을 다시 받았을 때) 파일을 먼저 읽어 보고, 파일이 더 최신이면 덮어쓰지 않고 불러올지 묻는다.
async function verifyWorkspaceFile(handle) {
  workspaceFileHold = true;
  setWorkspaceFileState({ status: "checking", name: handle.name, message: "" });
  let file;
  let fileText;
  try {
    file = await handle.getFile();
    fileText = await file.text();
  } catch (error) {
    setWorkspaceFileState({ status: "stale", message: `PC 파일 저장 중지 — 파일을 읽지 못했습니다(${error?.message || "알 수 없는 오류"})` });
    return false;
  }
  const { comparable } = workspaceFileText();
  const browserSavedAt = typeof workspaceBrowserSavedAt === "function" ? workspaceBrowserSavedAt() : 0;
  const browserHasWork = typeof workspaceHasWork === "function" ? workspaceHasWork() : true;
  const result = compareWorkspaceFile({
    fileText, fileModified: file?.lastModified, browserComparable: comparable, browserSavedAt, browserHasWork,
    syncHash: readWorkspaceFileSync().hash || ""
  });
  if (result.newer === "same") {
    workspaceFileHold = false;
    workspaceFileLastText = comparable;
    rememberWorkspaceFileSync(comparable);
    setWorkspaceFileState({ status: "saved", savedAt: result.fileTime, message: "" });
    return true;
  }
  if (result.newer === "browser") {
    workspaceFileHold = false;
    return saveWorkspaceFileNow({ force: true });
  }
  if (result.newer === "invalid") {
    setWorkspaceFileState({ status: "stale", message: "PC 파일 저장 중지 — 교육과정 작업 자료 파일이 아닙니다" });
    return false;
  }
  const load = window.confirm(
    `PC 파일이 더 최신입니다(파일: ${workspaceFileTimeLabel(result.fileTime)}, 브라우저: ${workspaceFileTimeLabel(result.browserTime)}). 파일 내용을 불러올까요?\n\n` +
    `· 확인: 이 브라우저의 자료를 '${handle.name}' 내용으로 바꿉니다.\n` +
    "· 취소: 브라우저 자료는 그대로 두고, 덮어쓰지 않도록 이 파일에는 저장하지 않습니다."
  );
  if (load && typeof restoreWorkspaceBackup === "function") {
    const restored = await restoreWorkspaceBackup({ name: handle.name, text: async () => fileText },
      async () => rememberWorkspaceFileSync(result.fileComparable), { confirmed: true });
    if (restored) return true;
  }
  setWorkspaceFileState({ status: "stale", message: "PC 파일 저장 중지 — 파일이 더 최신" });
  return false;
}

async function saveWorkspaceFileNow({ force = false } = {}) {
  if (!workspaceFileHandle || workspaceFileBusy || workspaceFileHold) return false;
  if (typeof isWorkspaceStorageProtected === "function" && isWorkspaceStorageProtected()) return false;
  workspaceFileBusy = true;
  try {
    if (!(await workspaceFilePermission(workspaceFileHandle))) {
      setWorkspaceFileState({ status: "needs-permission" });
      return false;
    }
    const { comparable, text } = workspaceFileText();
    if (!force && comparable === workspaceFileLastText) return true;
    const writable = await workspaceFileHandle.createWritable();
    await writable.write(text);
    await writable.close();
    workspaceFileLastText = comparable;
    rememberWorkspaceFileSync(comparable);
    if (typeof markWorkspaceBackup === "function") markWorkspaceBackup();
    setWorkspaceFileState({ status: "saved", savedAt: Date.now(), message: "" });
    return true;
  } catch (error) {
    const message = `파일 저장 실패: ${error?.message || "알 수 없는 오류"}`;
    if (workspaceFileState.status !== "error" && typeof showAppToast === "function") showAppToast(`PC ${message}`, "error");
    setWorkspaceFileState({ status: "error", message });
    return false;
  } finally {
    workspaceFileBusy = false;
  }
}

// 파일 저장을 예약하고, 예약했으면 파일 이름을 돌려준다(브라우저 저장이 실패했을 때 안내에 쓴다).
function scheduleWorkspaceFileSave() {
  if (!workspaceFileHandle || workspaceFileHold) return "";
  if (workspaceFileTimer !== null) clearTimeout(workspaceFileTimer);
  workspaceFileTimer = setTimeout(() => { workspaceFileTimer = null; saveWorkspaceFileNow(); }, 1500);
  return workspaceFileHandle.name || "PC 파일";
}

async function linkWorkspaceFile(handle, { writeNow }) {
  workspaceFileHandle = handle;
  workspaceFileHold = false;
  workspaceFileLastText = "";
  await workspaceFileStore("put", handle);
  setWorkspaceFileState({ status: "saved", name: handle.name, savedAt: 0, message: "" });
  if (writeNow) return saveWorkspaceFileNow({ force: true });
  return true;
}

const WORKSPACE_FILE_TYPES = [{ description: "교육과정 작업 자료", accept: { "application/json": [".json"] } }];

// 새 파일을 만들어 연결하고 지금 자료를 바로 저장한다.
async function connectWorkspaceFile() {
  try {
    const school = (document.getElementById("schoolName")?.value || "학교").trim();
    const handle = await window.showSaveFilePicker({ suggestedName: `교육과정_자료_${school}.json`, types: WORKSPACE_FILE_TYPES });
    if (!(await workspaceFilePermission(handle, true))) throw new Error("파일 쓰기를 허용하지 않았습니다.");
    await linkWorkspaceFile(handle, { writeNow: true });
    if (typeof showAppToast === "function") showAppToast(`'${handle.name}' 파일에 자동 저장합니다.`);
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (typeof showAppToast === "function") showAppToast(`자동 저장 파일을 연결하지 못했습니다: ${error.message}`, "error");
  }
}

// 이미 있는 자료 파일을 열어 복원한다. 복원이 실제로 끝난 뒤에만 그 파일에 자동 저장을 연결해 현재 자료로 덮어쓰지 않는다.
async function openWorkspaceFile() {
  try {
    const [handle] = await window.showOpenFilePicker({ types: WORKSPACE_FILE_TYPES, multiple: false });
    const file = await handle.getFile();
    const text = await file.text();
    await restoreWorkspaceBackup({ name: file.name || handle.name, text: async () => text }, async () => {
      await workspaceFileStore("put", handle);
      const opened = compareWorkspaceFile({ fileText: text, browserComparable: "" });
      if (opened.fileComparable) rememberWorkspaceFileSync(opened.fileComparable);
    });
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (typeof showAppToast === "function") showAppToast(`자료 파일을 열지 못했습니다: ${error.message}`, "error");
  }
}

// 권한을 다시 받으면 바로 쓰지 않고 파일이 더 최신인지 먼저 확인한다.
// 파일이 더 최신이라 저장을 멈춘 상태에서는 확인을 받은 뒤에만 브라우저 자료로 덮어쓴다.
async function allowWorkspaceFile() {
  if (!workspaceFileHandle) return false;
  const handle = workspaceFileHandle;
  if (workspaceFileState.status === "stale") {
    if (!window.confirm(`'${handle.name}' 파일을 이 브라우저의 자료로 덮어씁니다. 파일에만 있는 자료는 사라집니다. 계속할까요?`)) return false;
    if (!(await workspaceFilePermission(handle, true))) return false;
    workspaceFileHold = false;
    return saveWorkspaceFileNow({ force: true });
  }
  if (!(await workspaceFilePermission(handle, true))) return false;
  return verifyWorkspaceFile(handle);
}

async function disconnectWorkspaceFile() {
  workspaceFileHandle = null;
  workspaceFileHold = false;
  workspaceFileLastText = "";
  if (workspaceFileTimer !== null) { clearTimeout(workspaceFileTimer); workspaceFileTimer = null; }
  try { localStorage.removeItem(WORKSPACE_FILE_SYNC_KEY); } catch { /* 지문이 남아도 다른 파일 내용과는 맞지 않는다. */ }
  try { await workspaceFileStore("delete"); } catch { /* 연결 정보만 남을 뿐 저장은 이미 멈췄다. */ }
  setWorkspaceFileState({ status: "none", name: "", savedAt: 0, message: "" });
}

// 시작할 때 연결된 파일이 있으면 파일이 더 최신인지 확인한 뒤 이어서 쓴다. 권한이 풀렸으면 버튼으로 다시 허용받는다.
async function initWorkspaceFile() {
  renderWorkspaceFileStatus();
  if (!workspaceFileSupported()) return;
  try {
    const handle = await workspaceFileStore("get");
    if (!handle) return;
    workspaceFileHandle = handle;
    workspaceFileHold = true;
    setWorkspaceFileState({ status: "checking", name: handle.name });
    if (await workspaceFilePermission(handle)) await verifyWorkspaceFile(handle);
    else setWorkspaceFileState({ status: "needs-permission" });
  } catch {
    workspaceFileHandle = null;
    workspaceFileHold = false;
    setWorkspaceFileState({ status: "none" });
  }
}

// 허용된 위치에서 새 버전이 나왔는지 확인한다(APP_UPDATE_URL이 있을 때만).
async function checkForNewAppVersion() {
  if (typeof APP_UPDATE_URL !== "string" || !APP_UPDATE_URL || typeof fetch !== "function") return null;
  try {
    const response = await fetch(`${APP_UPDATE_URL}?_=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return null;
    const latest = String((await response.json())?.version || "");
    if (!latest || latest === APP_VERSION) return null;
    const notice = document.getElementById("appUpdateNotice");
    if (notice) {
      notice.textContent = `새 버전 ${latest}이 있습니다(현재 ${APP_VERSION}). 최신 파일을 내려받아 교체하세요. 작업 자료는 그대로 유지됩니다.`;
      notice.classList.remove("hidden");
    }
    return latest;
  } catch {
    return null;
  }
}

if (typeof document !== "undefined" && document.getElementById) {
  document.getElementById("connectWorkspaceFile")?.addEventListener("click", connectWorkspaceFile);
  document.getElementById("openWorkspaceFile")?.addEventListener("click", openWorkspaceFile);
  document.getElementById("allowWorkspaceFile")?.addEventListener("click", allowWorkspaceFile);
  document.getElementById("disconnectWorkspaceFile")?.addEventListener("click", disconnectWorkspaceFile);
  const version = document.getElementById("appVersion");
  if (version && typeof APP_VERSION === "string") version.textContent = `v${APP_VERSION}`;
  initWorkspaceFile();
  checkForNewAppVersion();
  setInterval(() => { saveWorkspaceFileNow(); renderWorkspaceFileStatus(); }, 30000);
}
