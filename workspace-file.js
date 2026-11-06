"use strict";
// 작업 자료를 내 PC의 파일 하나에 자동 저장한다(Chrome·Edge의 파일 접근 기능). 브라우저 저장소가 지워져도 파일에서 복구할 수 있다.
var WORKSPACE_FILE_DB = "curriculum-workspace-file";
var workspaceFileHandle = null;
var workspaceFileState = { status: "none", name: "", savedAt: 0, message: "" };
var workspaceFileLastText = "";
var workspaceFileTimer = null;
var workspaceFileBusy = false;

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
  for (const element of [connect, open, label]) element?.classList.toggle("hidden", !supported);
  if (!supported) return;
  const { status, name, savedAt, message } = workspaceFileState;
  const linked = status !== "none";
  connect.textContent = linked ? "저장 파일 바꾸기" : "자동 저장 파일 연결";
  allow.classList.toggle("hidden", status !== "needs-permission");
  disconnect.classList.toggle("hidden", !linked);
  label.classList.toggle("is-warning", status === "needs-permission" || status === "error");
  label.textContent = status === "none" ? "PC 파일 자동 저장 안 함"
    : status === "needs-permission" ? `${name} · 저장하려면 '저장 허용'을 누르세요`
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

async function saveWorkspaceFileNow({ force = false } = {}) {
  if (!workspaceFileHandle || workspaceFileBusy) return false;
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
    if (typeof markWorkspaceBackup === "function") markWorkspaceBackup();
    setWorkspaceFileState({ status: "saved", savedAt: Date.now(), message: "" });
    return true;
  } catch (error) {
    setWorkspaceFileState({ status: "error", message: `파일 저장 실패: ${error?.message || "알 수 없는 오류"}` });
    return false;
  } finally {
    workspaceFileBusy = false;
  }
}

function scheduleWorkspaceFileSave() {
  if (!workspaceFileHandle) return;
  if (workspaceFileTimer !== null) clearTimeout(workspaceFileTimer);
  workspaceFileTimer = setTimeout(() => { workspaceFileTimer = null; saveWorkspaceFileNow(); }, 1500);
}

async function linkWorkspaceFile(handle, { writeNow }) {
  workspaceFileHandle = handle;
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
    await restoreWorkspaceBackup(await handle.getFile(), async () => {
      await workspaceFileStore("put", handle);
    });
  } catch (error) {
    if (error?.name === "AbortError") return;
    if (typeof showAppToast === "function") showAppToast(`자료 파일을 열지 못했습니다: ${error.message}`, "error");
  }
}

async function allowWorkspaceFile() {
  if (!workspaceFileHandle) return;
  if (await workspaceFilePermission(workspaceFileHandle, true)) await saveWorkspaceFileNow({ force: true });
}

async function disconnectWorkspaceFile() {
  workspaceFileHandle = null;
  workspaceFileLastText = "";
  try { await workspaceFileStore("delete"); } catch { /* 연결 정보만 남을 뿐 저장은 이미 멈췄다. */ }
  setWorkspaceFileState({ status: "none", name: "", savedAt: 0, message: "" });
}

// 시작할 때 연결된 파일이 있으면 이어서 쓴다. 권한이 풀렸으면 버튼으로 다시 허용받는다.
async function initWorkspaceFile() {
  renderWorkspaceFileStatus();
  if (!workspaceFileSupported()) return;
  try {
    const handle = await workspaceFileStore("get");
    if (!handle) return;
    workspaceFileHandle = handle;
    setWorkspaceFileState({ status: "saved", name: handle.name });
    if (await workspaceFilePermission(handle)) saveWorkspaceFileNow({ force: true });
    else setWorkspaceFileState({ status: "needs-permission" });
  } catch {
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
