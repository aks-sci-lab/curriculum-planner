"use strict";
// 화면 공통 도우미 (app.js보다 먼저 로드, 전역 함수)
// 1) preserveViewDuring(대상, 그리기): innerHTML 등으로 다시 그려도 창 스크롤·표 안 스크롤 상자 위치·입력 포커스와 커서를 그대로 둔다.
//    4단계 집계·5단계 시수처럼 값을 바꿀 때마다 표 전체를 다시 그리는 곳은 그리는 호출을 이 함수로 감싼다.
// 2) deferRenderUntilStepVisible(단계, 이름, 그리기): 보이지 않는 단계의 화면은 그리지 않고 미뤘다가 그 단계를 열 때 그린다.

// 스크롤을 기억할 안쪽 상자. 새 상자는 data-scroll-key를 붙이면 된다.
// 열린 팝업(dialog)과 그 안의 form도 넣는다: 팝업 안 내용을 다시 그려도(예: 5단계 시수 설정·교사 수 추천) 팝업 스크롤이 그대로.
const VIEW_KEEP_SCROLL_SELECTOR = "[data-scroll-key], .aggregate-sheet-wrap, .curriculum-table-wrap, .student-list, .curriculum-data-sheet-scroll, dialog[open], dialog[open] > form";

function viewKeepTargets(target) {
  if (!target || typeof document === "undefined") return [];
  const list = typeof target === "string" ? [...document.querySelectorAll(target)]
    : Array.isArray(target) ? target.flatMap((item) => viewKeepTargets(item))
      : [target];
  return list.filter((element) => element && element.nodeType === 1);
}

// 다시 그린 뒤 같은 요소를 찾기 위한 열쇠: data-focus-key > id > (태그 + name·aria-label·data-* 값)
function viewKeepElementKey(element) {
  if (!element || element.nodeType !== 1) return null;
  if (element.dataset?.focusKey) return { focusKey: element.dataset.focusKey };
  if (element.id) return { id: element.id };
  const attributes = [];
  for (const attribute of element.attributes || []) {
    if (attribute.name === "name" || attribute.name === "aria-label" || attribute.name.startsWith("data-")) attributes.push([attribute.name, attribute.value]);
  }
  if (!attributes.length) return null;
  return { tag: element.tagName, attributes };
}

function viewKeepMatches(element, key) {
  if (!element || !key) return false;
  if (key.focusKey !== undefined) return element.dataset?.focusKey === key.focusKey;
  if (key.id !== undefined) return element.id === key.id;
  return element.tagName === key.tag && key.attributes.every(([name, value]) => element.getAttribute(name) === value);
}

function viewKeepFind(roots, key, index = 0) {
  if (!key) return null;
  if (key.id !== undefined) return document.getElementById(key.id);
  const found = [];
  for (const root of roots) {
    if (viewKeepMatches(root, key)) found.push(root);
    const selector = key.focusKey !== undefined ? "[data-focus-key]" : key.tag.toLowerCase();
    for (const element of root.querySelectorAll(selector)) if (viewKeepMatches(element, key)) found.push(element);
  }
  return found[index] || found[0] || null;
}

function viewKeepIndex(roots, element, key) {
  if (!key || key.id !== undefined) return 0;
  let index = 0;
  for (const root of roots) {
    const selector = key.focusKey !== undefined ? "[data-focus-key]" : key.tag.toLowerCase();
    const all = [...(viewKeepMatches(root, key) ? [root] : []), ...root.querySelectorAll(selector)].filter((item) => viewKeepMatches(item, key));
    const position = all.indexOf(element);
    if (position >= 0) return index + position;
    index += all.length;
  }
  return 0;
}

function captureViewState(target) {
  const roots = viewKeepTargets(target);
  const snapshot = { roots, windowX: 0, windowY: 0, boxes: [], focus: null, tabbing: null, heights: [] };
  if (typeof window === "undefined" || typeof document === "undefined") return snapshot;
  snapshot.windowX = window.scrollX || 0;
  snapshot.windowY = window.scrollY || 0;
  const seen = new Set();
  const counts = new Map();
  const addBox = (box) => {
    if (seen.has(box)) return;
    seen.add(box);
    const key = viewKeepBoxKey(box);
    const label = JSON.stringify(key);
    const nth = counts.get(label) || 0;
    counts.set(label, nth + 1);
    if (box.scrollTop || box.scrollLeft) snapshot.boxes.push({ key, nth, top: box.scrollTop, left: box.scrollLeft });
  };
  for (const root of roots) {
    // 대상 자신과 그 바깥 상자(대상이 스크롤 상자 안에 있을 때), 안쪽 상자
    for (let parent = root; parent && parent !== document.body; parent = parent.parentElement) {
      if (parent.matches?.(VIEW_KEEP_SCROLL_SELECTOR)) addBox(parent);
    }
    for (const box of root.querySelectorAll(VIEW_KEEP_SCROLL_SELECTOR)) addBox(box);
    // 다시 그리는 동안 높이를 붙잡아 문서가 잠깐 짧아져 창이 위로 튀지 않게 한다(다음 프레임에 풀어 줌).
    const height = root.offsetHeight;
    snapshot.heights.push([root, root.style.minHeight]);
    if (height) root.style.minHeight = `${height}px`;
  }
  const active = document.activeElement;
  if (active && active !== document.body && roots.some((root) => root.contains(active))) {
    const key = viewKeepElementKey(active);
    if (key) {
      let selection = null;
      try {
        if (typeof active.selectionStart === "number") selection = [active.selectionStart, active.selectionEnd, active.selectionDirection];
      } catch { selection = null; }
      snapshot.focus = { element: active, key, index: viewKeepIndex(roots, active, key), selection, value: active.value };
    }
  } else {
    snapshot.tabbing = viewKeepTabbingFrom(roots);
  }
  return snapshot;
}

function viewKeepFocus(element, focus) {
  if (!element || typeof element.focus !== "function") return false;
  try { element.focus({ preventScroll: true }); } catch { element.focus(); }
  if (document.activeElement !== element) return false;
  // 사용자가 입력하던 값이 그대로면 커서 위치도 되돌린다(숫자 칸은 커서 위치가 없어 건너뜀).
  if (focus?.selection && element.value === focus.value) {
    try { element.setSelectionRange(focus.selection[0], focus.selection[1], focus.selection[2] || "none"); } catch { /* 커서를 둘 수 없는 칸 */ }
  }
  return true;
}

function restoreViewState(snapshot) {
  if (!snapshot || typeof document === "undefined") return;
  const roots = snapshot.roots.filter((root) => root.isConnected);
  for (const box of snapshot.boxes) {
    const element = viewKeepFindBox(roots, box);
    if (!element) continue;
    if (element.scrollTop !== box.top) element.scrollTop = box.top;
    if (element.scrollLeft !== box.left) element.scrollLeft = box.left;
  }
  const focus = snapshot.focus;
  if (focus && !focus.element.isConnected && (document.activeElement === document.body || !document.activeElement || !document.activeElement.isConnected)) {
    viewKeepFocus(viewKeepFind(roots, focus.key, focus.index), focus);
  }
  if (typeof window !== "undefined" && (window.scrollX !== snapshot.windowX || window.scrollY !== snapshot.windowY)) {
    window.scrollTo(snapshot.windowX, snapshot.windowY);
  }
  const release = () => {
    for (const [root, previous] of snapshot.heights) root.style.minHeight = previous;
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(release); else release();
  viewKeepWatchFocusMove(snapshot, roots);
}

// 스크롤 상자 열쇠: data-scroll-key·id·data-* 가 없으면 태그 + 첫 class(스크롤하면 붙는 is-scrolled-* 같은 상태 class는 빼고)
function viewKeepBoxKey(box) {
  if (box.dataset?.scrollKey) return { tag: box.tagName, attributes: [["data-scroll-key", box.dataset.scrollKey]] };
  const key = viewKeepElementKey(box);
  if (key) return key;
  return { tag: box.tagName, className: String(box.classList?.[0] || "") };
}

function viewKeepFindBox(roots, box) {
  if (box.key.id !== undefined) return document.getElementById(box.key.id);
  const label = JSON.stringify(box.key);
  let nth = 0;
  const check = (element) => {
    const key = viewKeepBoxKey(element);
    if (JSON.stringify(key) !== label) return false;
    return nth++ === box.nth;
  };
  const visited = new Set();
  for (const root of roots) {
    const outer = [];
    for (let parent = root; parent && parent !== document.body; parent = parent.parentElement) if (parent.matches?.(VIEW_KEEP_SCROLL_SELECTOR)) outer.push(parent);
    for (const element of [...outer, ...root.querySelectorAll(VIEW_KEEP_SCROLL_SELECTOR)]) {
      if (visited.has(element)) continue;
      visited.add(element);
      if (check(element)) return element;
    }
  }
  return null;
}

// Tab·Shift+Tab으로 칸을 떠날 때 change 처리기가 표를 다시 그리면, 브라우저가 옮기려던 다음 칸(옛 요소)이 사라져 포커스가 없어진다.
// 마지막 Tab 키를 기억해 두었다가, 다시 그린 표에서 떠난 칸의 다음(이전) 칸으로 포커스를 옮긴다.
let viewKeepLastTab = null;
let viewKeepLastFocused = null;
if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("keydown", (event) => {
    if (event.key === "Tab") viewKeepLastTab = { from: event.target, shift: event.shiftKey, time: Date.now() };
  }, true);
  document.addEventListener("focusin", (event) => { viewKeepLastFocused = event.target; }, true);
}

const VIEW_KEEP_FOCUSABLE = 'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function viewKeepTabNeighbor(element, backwards) {
  const all = [...document.querySelectorAll(VIEW_KEEP_FOCUSABLE)]
    .filter((item) => item === element || (item.tabIndex >= 0 && item.getClientRects().length));
  const index = all.indexOf(element);
  if (index < 0) return null;
  return all[index + (backwards ? -1 : 1)] || null;
}

// Tab으로 떠나는 중이던 칸(change 이벤트 때 activeElement는 이미 body)
function viewKeepTabbingFrom(roots) {
  const tab = viewKeepLastTab;
  if (!tab || Date.now() - tab.time > 1000 || tab.from !== viewKeepLastFocused) return null;
  const active = document.activeElement;
  if (active && active !== document.body && active !== tab.from) return null;
  if (!tab.from?.isConnected || !roots.some((root) => root.contains(tab.from))) return null;
  const key = viewKeepElementKey(tab.from);
  return key ? { element: tab.from, key, index: viewKeepIndex(roots, tab.from, key), shift: tab.shift } : null;
}

function viewKeepWatchFocusMove(snapshot, roots) {
  if ((!snapshot.focus && !snapshot.tabbing) || typeof setTimeout !== "function") return;
  setTimeout(() => {
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected;
    if (!lost) return;
    const liveRoots = roots.filter((root) => root.isConnected);
    if (snapshot.tabbing) {
      const left = viewKeepFind(liveRoots, snapshot.tabbing.key, snapshot.tabbing.index);
      const next = left && viewKeepTabNeighbor(left, snapshot.tabbing.shift);
      if (next) {
        // Tab으로 옮겨 간 것처럼: 다음 칸이 상자 밖이면 보이도록 조금만 스크롤된다.
        next.focus();
        if (document.activeElement === next) return;
      }
      if (left && viewKeepFocus(left, null)) return;
    }
    if (snapshot.focus) viewKeepFocus(viewKeepFind(liveRoots, snapshot.focus.key, snapshot.focus.index), snapshot.focus);
  }, 0);
}

// 다시 그리기(render)를 감싸 창·표 스크롤과 포커스·커서를 보존한다. render의 반환값을 그대로 돌려준다.
// target: 다시 그려지는 요소(또는 선택자 문자열·요소 배열). 예: preserveViewDuring("#aggregateContent", () => renderAggregateInner())
function preserveViewDuring(target, render) {
  // 다른 단계에서 막 들어올 때·첫 화면에는 지킬 위치가 없으므로 건너뛴다(스크롤 값을 읽으면 레이아웃을 한 번 더 계산해 느려짐).
  if (viewKeepPausedDepth > 0) return render();
  const snapshot = captureViewState(target);
  try {
    return render();
  } finally {
    restoreViewState(snapshot);
  }
}

let viewKeepPausedDepth = 0;
// fn 안에서는 preserveViewDuring이 보존 없이 바로 그린다.
function withoutViewKeep(fn) {
  viewKeepPausedDepth++;
  try { return fn(); } finally { viewKeepPausedDepth--; }
}

let viewKeepLastLayoutStep = null;
// renderWorkflowLayout이 부른다: 지난번과 다른 단계를 그리면 true(단계 이동).
function workflowStepEntering(step) {
  const entering = viewKeepLastLayoutStep !== Number(step);
  viewKeepLastLayoutStep = Number(step);
  return entering;
}

// ---- 보이지 않는 단계는 열 때 그리기 ----
const deferredStepRenders = new Map();

function currentWorkflowStepForRender() {
  try {
    // eslint-disable-next-line no-undef
    return typeof state !== "undefined" && state ? Number(state.workflowStep) : NaN;
  } catch { return NaN; }
}

// 지금 단계가 step이 아니면 render를 미뤄 두고 true를 돌려준다(호출한 쪽은 바로 return). 보이는 단계면 미뤄 둔 것을 지우고 false.
function deferRenderUntilStepVisible(step, name, render) {
  const current = currentWorkflowStepForRender();
  const steps = (Array.isArray(step) ? step : [step]).map(Number);
  if (!stepRendersHeld && (!Number.isFinite(current) || steps.includes(current))) {
    for (const value of steps) deferredStepRenders.get(value)?.delete(name);
    return false;
  }
  for (const value of steps) {
    if (!deferredStepRenders.has(value)) deferredStepRenders.set(value, new Map());
    deferredStepRenders.get(value).set(name, render);
  }
  return true;
}

let stepRendersHeld = 0;
// fn 안에서는 보이는 단계의 그리기도 미룬다(시작할 때 복원 중: 다른 모듈이 읽힌 뒤 한 번만 그리게).
function holdStepRenders(fn) {
  stepRendersHeld++;
  try { return fn(); } finally { stepRendersHeld--; }
}

// 단계를 열 때(renderWorkflowLayout) 미뤄 둔 그리기를 실행한다.
function flushDeferredStepRenders(step) {
  if (stepRendersHeld) return 0;
  const pending = deferredStepRenders.get(Number(step));
  if (!pending?.size) return 0;
  const renders = [...pending.entries()];
  pending.clear();
  for (const [name, render] of renders) {
    for (const other of deferredStepRenders.values()) other.delete(name);
    render();
  }
  return renders.length;
}

function hasDeferredStepRender(step, name) {
  return Boolean(deferredStepRenders.get(Number(step))?.has(name));
}
