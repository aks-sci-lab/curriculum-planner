"use strict";
// 작업 자료 저장소. 큰 자료(편제표·변경 이력·차수 결과·확정 스냅샷·점검 자료 등)는 IndexedDB(curriculum-workspace-db)에
// 조각별로 나눠 저장하고, localStorage에는 작은 설정과 IndexedDB 참조(본문 core)만 둔다. app.js보다 먼저 로드한다.
// 위쪽은 순수 계산(나누기·합치기·해시) → `// ---- 브라우저 저장소` 아래 IndexedDB 읽기·쓰기.
//
// 나누는 규칙(큰 항목을 새로 추가할 때 여기만 보면 된다):
// · 작업 자료(workspacePayload)의 2단계 경로까지는 모두 항목별로 나눈다. 예: rounds.1 → students·courses…,
//   curriculumCohorts.2026 → importedLayout·plan…, courseChecks → prior·neis…, roundStatuses.1 → snapshot…,
//   classSections.1 → 그룹('현학년:학기:그룹')마다 한 조각, 그 안의 분반 편성 결과(sectionResult)는 따로
// · 그 아래는 WORKSPACE_STORE_SPLIT_KEYS 이름의 객체, 편제표 표(rows 배열이 있는 객체), WORKSPACE_STORE_SPLIT_ARRAYS 배열의 항목만 더 나눈다.
// · 나눈 결과 중 WORKSPACE_STORE_BLOB_MIN 글자 이상인 값은 내용 해시를 이름으로 한 조각(blob)이 된다. 같은 내용(예: 변경 이력 시점의
//   편제표와 지금 편제표, 활성 차수 학생과 차수 자료 학생, 표의 서식 표와 양식의 서식 표)은 한 번만 저장한다.
var WORKSPACE_DB_NAME = "curriculum-workspace-db";
var WORKSPACE_STORE_FORMAT = 1;
var WORKSPACE_STORE_BLOB_MIN = 2048;
var WORKSPACE_STORE_SPLIT_DEPTH = 2;
var WORKSPACE_STORE_SPLIT_KEYS = ["importedLayout", "changeBaseline", "planTemplate", "format", "snapshot", "layout", "neis", "prior", "sectionResult"];
var WORKSPACE_STORE_SPLIT_ARRAYS = [/^curriculumVersions\.[^.]+$/];
// 조각 참조 표시. JSON 글자 안에서는 {"\u0000b":"해시"} 로 보인다(실제 자료의 글자 값 안에는 따옴표가 이스케이프되므로 생길 수 없다).
var WORKSPACE_STORE_REF = "\u0000b";
var WORKSPACE_STORE_REF_PATTERN = /\{"\\u0000b":"([0-9a-z-]+)"\}/g;
// localStorage(약 5백만 글자) 한도. 사용량 표시와 80% 경고에 쓴다.
var WORKSPACE_LOCAL_LIMIT = 5000000;

// 내용 지문. 두 가지 32비트 해시와 길이를 함께 써서 서로 다른 내용이 같은 이름이 될 가능성을 없앤다.
function workspaceStoreHash(text) {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return `${text.length.toString(36)}-${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}`;
}

function workspaceStoreShouldSplit(value, key, path, depth, inSplitArray) {
  if (!value || typeof value !== "object" || typeof value.toJSON === "function") return false;
  if (Array.isArray(value)) return WORKSPACE_STORE_SPLIT_ARRAYS.some((pattern) => pattern.test(path));
  return depth <= WORKSPACE_STORE_SPLIT_DEPTH || inSplitArray || WORKSPACE_STORE_SPLIT_KEYS.includes(key) || Array.isArray(value.rows);
}

// 작업 자료를 본문(core: 작은 설정 + 조각 참조)과 조각(blobs: 해시 → JSON 글자)으로 나눈다.
// 조각을 모두 본문에 다시 끼우면 JSON.stringify(payload)와 글자 하나까지 같다(workspaceStoreExpand).
// cache: 지난번 나눈 결과(경로 → 글자·해시). 바뀌지 않은 조각은 해시를 다시 계산하지 않는다.
// replacer: JSON.stringify의 두 번째 인자와 같다(저장에서 뺄 화면 전용 값 등). 주면 JSON.stringify(payload, replacer)와 같은 글자가 된다.
function workspaceStoreSplit(payload, cache = new Map(), replacer = undefined) {
  const blobs = new Map();
  const nextCache = new Map();
  const seen = new Map();
  const reference = (text, path) => {
    const previous = cache.get(path);
    const hash = previous && previous.text === text ? previous.hash : workspaceStoreHash(text);
    nextCache.set(path, { text, hash });
    blobs.set(hash, text);
    return `{"\\u0000b":"${hash}"}`;
  };
  const child = (value, key, path, depth, inSplitArray) => {
    const childPath = path ? `${path}.${key}` : String(key);
    const text = encode(value, key, childPath, depth, inSplitArray);
    return value && typeof value === "object" && text.length >= WORKSPACE_STORE_BLOB_MIN ? reference(text, childPath) : text;
  };
  const encode = (value, key, path, depth, inSplitArray) => {
    if (!value || typeof value !== "object") return JSON.stringify(value, replacer);
    if (seen.has(value)) return seen.get(value);
    let text;
    if (!workspaceStoreShouldSplit(value, key, path, depth, inSplitArray)) {
      text = JSON.stringify(value, replacer);
    } else if (Array.isArray(value)) {
      text = `[${value.map((raw, index) => {
        const item = replacer ? replacer.call(value, String(index), raw) : raw;
        return item === undefined || typeof item === "function" || typeof item === "symbol"
          ? "null" : child(item, String(index), path, depth + 1, true);
      }).join(",")}]`;
    } else {
      const fields = [];
      for (const field of Object.keys(value)) {
        const item = replacer ? replacer.call(value, field, value[field]) : value[field];
        if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
        fields.push(`${JSON.stringify(field)}:${child(item, field, path, depth + 1, false)}`);
      }
      text = `{${fields.join(",")}}`;
    }
    seen.set(value, text);
    return text;
  };
  const root = replacer ? replacer.call({ "": payload }, "", payload) : payload;
  const core = encode(root, "", "", 0, false);
  return { core, blobs, cache: nextCache };
}

// 본문의 조각 참조를 조각 글자로 바꿔 원래 JSON 글자를 만든다. 조각이 없으면 오류(자료 손상)로 본다.
function workspaceStoreExpand(text, getBlob, depth = 0) {
  if (depth > 40) throw new Error("저장 조각이 서로를 참조합니다.");
  return text.replace(WORKSPACE_STORE_REF_PATTERN, (match, hash) => {
    const blob = getBlob(hash);
    if (typeof blob !== "string") throw new Error(`저장 조각(${hash})을 찾지 못했습니다.`);
    return workspaceStoreExpand(blob, getBlob, depth + 1);
  });
}

// 본문이 참조하는 조각 해시(조각 안의 참조까지). 지울 조각을 고를 때 쓴다.
function workspaceStoreReferences(core, blobs) {
  const result = new Set();
  const visit = (text) => {
    for (const match of text.matchAll(WORKSPACE_STORE_REF_PATTERN)) {
      if (result.has(match[1])) continue;
      result.add(match[1]);
      const blob = blobs.get(match[1]);
      if (typeof blob === "string") visit(blob);
    }
  };
  visit(core);
  return result;
}

// localStorage에 두는 작은 기록: IndexedDB 참조(저장 번호)와 본문. 본문은 다른 창의 변경 감지·상태 표시용이고,
// 읽을 때는 IndexedDB에 함께 저장된 본문을 쓴다(한 번에 저장되므로 조각과 항상 맞다).
function workspaceStoreRecord(core, rev, savedAt) {
  return JSON.stringify({ workspaceStore: { db: WORKSPACE_DB_NAME, format: WORKSPACE_STORE_FORMAT, rev, savedAt }, core });
}

function workspaceStoreParseRecord(raw) {
  if (typeof raw !== "string" || !raw.startsWith('{"workspaceStore":')) return null;
  try {
    const record = JSON.parse(raw);
    return record?.workspaceStore && typeof record.workspaceStore.rev === "string" ? record : null;
  } catch {
    return null;
  }
}

// IndexedDB를 읽기 전에 화면을 먼저 맞출 작은 설정만 남긴 작업 자료(학년도·단계·차수 등). 조각 참조가 든 항목은 뺀다.
function workspaceStoreSettingsRaw(core) {
  const parsed = JSON.parse(core);
  const settings = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null || typeof value !== "object") settings[key] = value;
  }
  return JSON.stringify({ ...settings, students: [], courses: [], rounds: { [String(settings.currentRound || "1")]: null } });
}

// ---- 브라우저 저장소(IndexedDB) ----
var workspaceStoreConnection = null;

function workspaceStoreSupported() {
  try { return typeof indexedDB !== "undefined" && Boolean(indexedDB) && typeof indexedDB.open === "function"; } catch { return false; }
}

function workspaceStoreOpen() {
  if (workspaceStoreConnection) return workspaceStoreConnection;
  workspaceStoreConnection = new Promise((resolve, reject) => {
    let request;
    try { request = indexedDB.open(WORKSPACE_DB_NAME, 1); } catch (error) { reject(error); return; }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
    };
    request.onsuccess = () => {
      const db = request.result;
      // 전체 초기화(다른 창 포함)가 저장소를 지울 수 있게 연결을 닫는다.
      db.onversionchange = () => { db.close(); workspaceStoreConnection = null; };
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error("브라우저 저장소(IndexedDB)를 열지 못했습니다."));
    request.onblocked = () => reject(new Error("다른 창이 브라우저 저장소를 쓰고 있어 열지 못했습니다."));
  });
  workspaceStoreConnection.catch(() => { workspaceStoreConnection = null; });
  return workspaceStoreConnection;
}

async function workspaceStoreClose() {
  const connection = workspaceStoreConnection;
  workspaceStoreConnection = null;
  try { (await connection)?.close(); } catch { /* 이미 닫혔다. */ }
}

// 큰 조각은 gzip으로 줄여 저장한다(CompressionStream이 없는 브라우저는 글자 그대로).
async function workspaceStorePack(text) {
  if (text.length < 4096 || typeof CompressionStream !== "function" || typeof Blob !== "function" || typeof Response !== "function") return { t: text };
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
    return { z: await new Response(stream).arrayBuffer() };
  } catch {
    return { t: text };
  }
}

async function workspaceStoreUnpack(entry) {
  if (typeof entry?.t === "string") return entry.t;
  if (entry?.z && typeof DecompressionStream === "function") {
    const stream = new Blob([entry.z]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  throw new Error("저장 조각을 읽지 못했습니다(압축을 풀 수 없음).");
}

function workspaceStoreConflictError() {
  const error = new Error("다른 창의 저장 자료가 변경되어 덮어쓰기를 중지했습니다.");
  error.name = "WorkspaceStoreConflict";
  return error;
}

function workspaceStoreNewRev() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 나눈 작업 자료를 한 번에(트랜잭션 하나로) 저장한다. expectedRev와 저장소의 지금 번호가 다르면(다른 창이 저장함) 쓰지 않고 오류.
// known: 저장소에 이미 있는 조각(지난 저장·읽기 기준). force면 번호를 확인하지 않고 모든 조각을 다시 쓴다(백업 불러오기·저장 재개).
async function workspaceStoreWrite(split, { expectedRev = "", known = new Set(), force = false } = {}) {
  const db = await workspaceStoreOpen();
  const fresh = [...split.blobs].filter(([hash]) => force || !known.has(hash));
  const packed = await Promise.all(fresh.map(async ([hash, text]) => [hash, await workspaceStorePack(text)]));
  const rev = workspaceStoreNewRev();
  const savedAt = Date.now();
  const referenced = [...split.blobs.keys()];
  await new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(["meta", "blobs"], "readwrite"); } catch (error) { reject(error); return; }
    const metaStore = tx.objectStore("meta");
    const blobStore = tx.objectStore("blobs");
    let conflict = false;
    const current = metaStore.get("workspace");
    current.onsuccess = () => {
      const meta = current.result;
      if (!force && String(meta?.rev || "") !== String(expectedRev || "")) {
        conflict = true;
        tx.abort();
        return;
      }
      const keep = new Set(referenced);
      for (const hash of Array.isArray(meta?.blobs) ? meta.blobs : []) if (!keep.has(hash)) blobStore.delete(hash);
      for (const [hash, entry] of packed) blobStore.put(entry, hash);
      metaStore.put({ format: WORKSPACE_STORE_FORMAT, rev, savedAt, core: split.core, blobs: referenced }, "workspace");
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = (event) => {
      event?.preventDefault?.();
      reject(conflict ? workspaceStoreConflictError() : tx.error || current.error || new Error("브라우저 저장소에 쓰지 못했습니다."));
    };
  });
  return { rev, savedAt, known: new Set(referenced) };
}

// 저장소의 작업 자료를 읽어 원래 JSON 글자(raw)로 되돌린다. 저장한 적이 없으면 null.
async function workspaceStoreRead() {
  const db = await workspaceStoreOpen();
  const { meta, entries } = await new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(["meta", "blobs"], "readonly"); } catch (error) { reject(error); return; }
    const metaRequest = tx.objectStore("meta").get("workspace");
    const keysRequest = tx.objectStore("blobs").getAllKeys();
    const valuesRequest = tx.objectStore("blobs").getAll();
    tx.oncomplete = () => resolve({
      meta: metaRequest.result || null,
      entries: (keysRequest.result || []).map((key, index) => [key, valuesRequest.result?.[index]])
    });
    tx.onerror = tx.onabort = () => reject(tx.error || new Error("브라우저 저장소를 읽지 못했습니다."));
  });
  if (!meta || typeof meta.core !== "string") return null;
  if (Number(meta.format) > WORKSPACE_STORE_FORMAT) throw new Error("더 새로운 버전의 프로그램이 저장한 자료입니다. 프로그램을 최신 버전으로 업데이트하세요.");
  const needed = new Set(Array.isArray(meta.blobs) ? meta.blobs : []);
  const blobs = new Map();
  let packedSize = 0;
  for (const [hash, entry] of entries) {
    if (!needed.has(hash)) continue;
    packedSize += entry?.z ? entry.z.byteLength : (entry?.t?.length || 0) * 2;
    blobs.set(hash, await workspaceStoreUnpack(entry));
  }
  const raw = workspaceStoreExpand(meta.core, (hash) => blobs.get(hash));
  return { raw, core: meta.core, rev: String(meta.rev || ""), savedAt: Number(meta.savedAt) || 0,
    known: new Set(blobs.keys()), blobCount: blobs.size, packedSize };
}

function workspaceStoreDelete() {
  return new Promise((resolve) => {
    if (!workspaceStoreSupported()) { resolve(); return; }
    workspaceStoreClose().finally(() => {
      const request = indexedDB.deleteDatabase(WORKSPACE_DB_NAME);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  });
}

// 이 브라우저 저장 공간 사용량. usage·quota는 바이트(대략), local은 localStorage 글자 수.
async function workspaceStorageEstimate() {
  let local = 0;
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      local += key.length + (localStorage.getItem(key)?.length || 0);
    }
  } catch { /* 읽지 못하면 0으로 둔다. */ }
  let usage = 0;
  let quota = 0;
  try {
    const estimate = await navigator.storage?.estimate?.();
    usage = Number(estimate?.usage) || 0;
    quota = Number(estimate?.quota) || 0;
  } catch { /* 지원하지 않는 브라우저 */ }
  return { usage, quota, local, localLimit: WORKSPACE_LOCAL_LIMIT };
}

function workspaceStorageUsageText({ usage, quota, local, localLimit }) {
  const mb = (bytes) => bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  const localRatio = localLimit ? local / localLimit : 0;
  const ratio = quota ? usage / quota : 0;
  const warn = ratio >= 0.8 || localRatio >= 0.8;
  const parts = [];
  if (quota) parts.push(`저장 공간 약 ${mb(usage)} 사용 / ${mb(quota)} 중 ${Math.round(ratio * 1000) / 10}%`);
  else if (usage) parts.push(`저장 공간 약 ${mb(usage)} 사용`);
  parts.push(`기본 저장소 ${Math.round(localRatio * 100)}%`);
  return { text: parts.join(" · "), warn, ratio, localRatio };
}
