const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const viewKeep = fs.readFileSync(path.join(root, "view-keep.js"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");

// ---- 아주 작은 가짜 DOM: view-keep.js가 쓰는 만큼만(선택자: 태그·.class·[속성]·[속성="값"]·:not(...)·쉼표) ----
function matchesCompound(element, compound) {
  let rest = compound.trim();
  const tag = rest.match(/^[a-zA-Z][\w-]*/)?.[0];
  if (tag) {
    if (element.tagName !== tag.toUpperCase()) return false;
    rest = rest.slice(tag.length);
  }
  for (const token of rest.match(/\.[\w-]+|\[[^\]]+\]|:not\([^)]*\)/g) || []) {
    if (token.startsWith(".")) {
      if (!element.classList.includes(token.slice(1))) return false;
    } else if (token.startsWith("[")) {
      const [, name, value] = token.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (!element.hasAttribute(name)) return false;
      if (value !== undefined && element.getAttribute(name) !== value) return false;
    } else if (matchesCompound(element, token.slice(5, -1))) return false;
  }
  return true;
}

function matchesSelector(element, selector) {
  return selector.split(/,(?![^[]*\])/).some((part) => matchesCompound(element, part));
}

function makeDom() {
  const listeners = new Map();
  const timers = [];
  const frames = [];
  class Element {
    constructor(tag, attributes = {}) {
      this.tagName = tag.toUpperCase();
      this.nodeType = 1;
      this.attrs = new Map(Object.entries(attributes));
      this.children = [];
      this.parentElement = null;
      this.scrollTop = 0;
      this.scrollLeft = 0;
      this.style = { minHeight: "" };
      this.offsetHeight = 500;
      this.value = attributes.value || "";
      this.selectionStart = 0;
      this.selectionEnd = 0;
      this.selectionDirection = "none";
    }
    get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
    hasAttribute(name) { return this.attrs.has(name); }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    get id() { return this.getAttribute("id") || ""; }
    get dataset() {
      const result = {};
      for (const [name, value] of this.attrs) if (name.startsWith("data-")) result[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
      return result;
    }
    get classList() { return String(this.getAttribute("class") || "").split(/\s+/).filter(Boolean); }
    get tabIndex() { return this.getAttribute("tabindex") === "-1" ? -1 : 0; }
    get isConnected() {
      let node = this;
      while (node.parentElement) node = node.parentElement;
      return node === document.documentElement;
    }
    append(...children) {
      for (const child of children) { child.parentElement = this; this.children.push(child); }
      return this;
    }
    replaceChildren(...children) {
      for (const child of this.children) child.parentElement = null;
      this.children = [];
      this.append(...children);
    }
    contains(other) {
      for (let node = other; node; node = node.parentElement) if (node === this) return true;
      return false;
    }
    descendants() { return this.children.flatMap((child) => [child, ...child.descendants()]); }
    querySelectorAll(selector) { return this.descendants().filter((element) => matchesSelector(element, selector)); }
    matches(selector) { return matchesSelector(this, selector); }
    getClientRects() { return this.hasAttribute("hidden") ? [] : [{}]; }
    focus() { if (this.isConnected) document.activeElement = this; }
    setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  }
  const html = new Element("html");
  const body = new Element("body");
  html.append(body);
  const document = {
    documentElement: html,
    body,
    activeElement: body,
    getElementById: (id) => html.descendants().find((element) => element.id === id) || null,
    querySelectorAll: (selector) => html.querySelectorAll(selector),
    addEventListener: (type, listener) => { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(listener); },
    removeEventListener() {},
  };
  const window = { scrollX: 0, scrollY: 0, scrollTo(x, y) { this.scrollX = x; this.scrollY = y; } };
  const ctx = vm.createContext({
    document, window, Date,
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
  });
  vm.runInContext(viewKeep, ctx);
  const el = (tag, attributes, ...children) => new Element(tag, attributes).append(...children);
  const fire = (type, event) => { for (const listener of listeners.get(type) || []) listener(event); };
  const runTimers = () => { while (timers.length) timers.shift()(); };
  const runFrames = () => { while (frames.length) frames.shift()(); };
  return { ctx, document, window, body, el, fire, runTimers, runFrames };
}

// 4·5단계처럼 값을 바꾸면 표(스크롤 상자 포함)를 통째로 새로 만든다.
function buildTable(dom, values) {
  return dom.el("div", { class: "aggregate-sheet-wrap" },
    ...values.map((value, index) => dom.el("input", { "data-focus-key": `classes-${index}`, value: String(value) })));
}

test("preserveViewDuring keeps the window, the inner table scroll and the focused input with its cursor", () => {
  const dom = makeDom();
  const panel = dom.el("section", { id: "aggregatePanel" });
  dom.body.append(panel);
  panel.append(buildTable(dom, [1, 2, 3, 4]));
  const box = panel.children[0];
  box.scrollTop = 640; box.scrollLeft = 120;
  const input = box.children[2];
  input.value = "12"; input.focus(); input.setSelectionRange(1, 1, "none");
  dom.window.scrollY = 900;
  let heightDuringRender = null;
  dom.ctx.preserveViewDuring("#aggregatePanel", () => {
    heightDuringRender = panel.style.minHeight;
    panel.replaceChildren(buildTable(dom, [1, 2, 12, 4]));
    // 새 내용이 그려지는 동안 문서가 짧아져 창이 위로 튄 상황
    dom.window.scrollY = 0;
    dom.document.activeElement = dom.body;
  });
  const next = panel.children[0];
  assert.notEqual(next, box, "the table was really rebuilt");
  assert.equal(next.scrollTop, 640);
  assert.equal(next.scrollLeft, 120);
  assert.equal(dom.window.scrollY, 900, "the window goes back to where the user was");
  assert.equal(dom.document.activeElement, next.children[2], "focus returns to the same input (data-focus-key)");
  assert.equal(next.children[2].selectionStart, 1, "the cursor position comes back when the value is unchanged");
  assert.equal(heightDuringRender, "500px", "the panel keeps its height while it is redrawn");
  assert.equal(panel.style.minHeight, "500px", "the panel height is held until the next frame");
  dom.runFrames();
  assert.equal(panel.style.minHeight, "", "and then released");
});

test("an input without data-focus-key is found again by its data-* attributes (4단계 개설 학급수·폐강 선택)", () => {
  const dom = makeDom();
  const panel = dom.el("div", { id: "aggregateContent" });
  dom.body.append(panel);
  const make = () => dom.el("div", { class: "aggregate-sheet-wrap" },
    dom.el("select", { "data-closure-key": "1:c1", "data-closure-round": "1" }),
    dom.el("select", { "data-closure-key": "1:c2", "data-closure-round": "1" }));
  panel.append(make());
  panel.children[0].scrollTop = 300;
  panel.children[0].children[1].focus();
  dom.ctx.preserveViewDuring(panel, () => panel.replaceChildren(make()));
  assert.equal(dom.document.activeElement.getAttribute("data-closure-key"), "1:c2");
  assert.equal(panel.children[0].scrollTop, 300);
});

test("leaving a cell with Tab while the change handler redraws moves focus to the next cell of the new table", () => {
  const dom = makeDom();
  const panel = dom.el("div", { id: "aggregateContent" });
  dom.body.append(panel);
  const make = () => dom.el("div", { class: "aggregate-sheet-wrap" },
    dom.el("input", { "data-grade": "1", "data-course-column": "c1" }),
    dom.el("input", { "data-grade": "1", "data-course-column": "c2" }));
  panel.append(make());
  const first = panel.children[0].children[0];
  first.focus();
  dom.fire("focusin", { target: first });
  dom.fire("keydown", { key: "Tab", shiftKey: false, target: first });
  // 브라우저는 change를 보낼 때 이미 포커스를 내려놓았다(activeElement = body).
  dom.document.activeElement = dom.body;
  dom.ctx.preserveViewDuring(panel, () => panel.replaceChildren(make()));
  dom.runTimers();
  assert.equal(dom.document.activeElement.getAttribute("data-course-column"), "c2");
  assert.ok(dom.document.activeElement.isConnected);
});

test("focus the user moved elsewhere is left alone", () => {
  const dom = makeDom();
  const panel = dom.el("div", { id: "hoursStatsContent" }, buildTable(dom, [1, 2]));
  const outside = dom.el("input", { id: "schoolYear" });
  dom.body.append(panel, outside);
  outside.focus();
  dom.ctx.preserveViewDuring(panel, () => panel.replaceChildren(buildTable(dom, [3, 4])));
  dom.runTimers();
  assert.equal(dom.document.activeElement, outside);
});

test("withoutViewKeep skips the work when entering a step (nothing to keep)", () => {
  const dom = makeDom();
  const panel = dom.el("div", { id: "p" }, buildTable(dom, [1]));
  dom.body.append(panel);
  panel.children[0].scrollTop = 200;
  dom.ctx.withoutViewKeep(() => dom.ctx.preserveViewDuring(panel, () => panel.replaceChildren(buildTable(dom, [1]))));
  assert.equal(panel.children[0].scrollTop, 0);
  assert.equal(dom.ctx.workflowStepEntering(4), true);
  assert.equal(dom.ctx.workflowStepEntering(4), false, "the same step again is a redraw, not a step change");
});

test("renders of a hidden step wait until that step is opened, and run once", () => {
  const dom = makeDom();
  vm.runInContext("var state = { workflowStep: 7 };", dom.ctx);
  let renders = 0;
  const render = () => { renders++; };
  assert.equal(dom.ctx.deferRenderUntilStepVisible(4, "aggregate", render), true);
  assert.equal(dom.ctx.deferRenderUntilStepVisible(4, "aggregate", render), true);
  assert.equal(renders, 0);
  assert.equal(dom.ctx.flushDeferredStepRenders(3), 0, "other steps do not run it");
  vm.runInContext("state.workflowStep = 4;", dom.ctx);
  assert.equal(dom.ctx.flushDeferredStepRenders(4), 1);
  assert.equal(renders, 1, "two requests while hidden become one render");
  assert.equal(dom.ctx.flushDeferredStepRenders(4), 0);
  // 보이는 단계에서 직접 그리면 미뤄 둔 것이 지워져 단계를 열 때 두 번 그리지 않는다.
  vm.runInContext("state.workflowStep = 1;", dom.ctx);
  dom.ctx.deferRenderUntilStepVisible(4, "aggregate", render);
  vm.runInContext("state.workflowStep = 4;", dom.ctx);
  assert.equal(dom.ctx.deferRenderUntilStepVisible(4, "aggregate", render), false);
  assert.equal(dom.ctx.hasDeferredStepRender(4, "aggregate"), false);
  // 시작할 때 복원 중에는 보이는 단계도 미룬다(다른 모듈이 읽힌 뒤 한 번만).
  assert.equal(dom.ctx.holdStepRenders(() => dom.ctx.deferRenderUntilStepVisible(4, "aggregate", render)), true);
  assert.equal(dom.ctx.hasDeferredStepRender(4, "aggregate"), true);
  // state가 없는 곳(테스트용 잘라 쓴 코드 등)에서는 미루지 않는다.
  vm.runInContext("state = undefined;", dom.ctx);
  assert.equal(dom.ctx.deferRenderUntilStepVisible(4, "other", render), false);
});

// ---- 자료가 바뀔 때만 다시 계산하는 캐시 ----
function stateContext() {
  const start = app.indexOf("const rawState = {");
  const end = app.indexOf("const STORAGE_KEY", start);
  const context = vm.createContext({ window: { setTimeout: () => 1, clearTimeout() {} }, persistState() {} });
  vm.runInContext(app.slice(start, end), context);
  vm.runInContext("statePersistenceReady = true;", context);
  return context;
}

test("cachedByStateRevision reuses a result until the state really changes", () => {
  const ctx = stateContext();
  let runs = 0;
  const compute = () => { runs++; return { value: runs }; };
  const read = (key = "a") => ctx.cachedByStateRevision("test", key, compute);
  assert.equal(read().value, 1);
  assert.equal(read().value, 1, "same state, same key: cached");
  assert.equal(read("b").value, 2, "another key is computed separately");
  vm.runInContext(`state.workflowStep = 4; state.selectedId = "s1"; state.applicationMenuGrade = "2";`, ctx);
  assert.equal(read().value, 1, "moving between steps or picking a student does not throw the cache away");
  vm.runInContext(`state.curriculumCohorts["2026"] = { plan: [] };`, ctx);
  assert.equal(read().value, 3, "a data change recomputes");
  vm.runInContext(`state.curriculumCohorts["2026"].plan.push({ subject: "물리학" });`, ctx);
  assert.equal(read().value, 4, "nested array changes count too");
  vm.runInContext(`delete state.curriculumCohorts["2026"];`, ctx);
  assert.equal(read().value, 5, "deleting counts too");
  ctx.invalidateStateCaches();
  assert.equal(read().value, 6);
  // 계산하는 동안 자료를 고친 결과는 저장하지 않는다(바뀐 자료로 다시 계산).
  let sideEffects = 0;
  const writes = () => { sideEffects++; vm.runInContext(`state.hoursStats = { n: ${sideEffects} };`, ctx); return sideEffects; };
  ctx.cachedByStateRevision("writer", "", writes);
  ctx.cachedByStateRevision("writer", "", writes);
  assert.equal(sideEffects, 2);
});

test("view-only changes do not trigger a 4MB save, data changes still do", () => {
  const start = app.indexOf("const rawState = {");
  const end = app.indexOf("const STORAGE_KEY", start);
  let scheduled = 0;
  const ctx = vm.createContext({ window: { setTimeout: () => ++scheduled, clearTimeout() {} }, persistState() {} });
  vm.runInContext(app.slice(start, end), ctx);
  vm.runInContext("statePersistenceReady = true;", ctx);
  vm.runInContext(`state.workflowStep = 3; state.selectedId = "x";`, ctx);
  assert.equal(scheduled, 0);
  assert.equal(vm.runInContext("stateViewOnlyDirty", ctx), true, "kept for the next save or when the window is hidden/closed");
  vm.runInContext(`state.roundClosures["1"] = { "1:c1": "closed" };`, ctx);
  assert.equal(scheduled, 1);
});

test("saving serializes the raw objects behind the proxies with the same JSON", () => {
  const ctx = stateContext();
  vm.runInContext(`
    state.students.push({ id: "a", grade: "1", selections: [{ name: "물리학" }] });
    state.rounds["1"] = { students: state.students, courses: state.courses };
    state.curriculumCohorts["2026"] = { importedLayout: { rows: [["a", "b"]], mergedRanges: ["A1:B1"] } };
  `, ctx);
  const payload = vm.runInContext("({ rounds: state.rounds, students: state.students, curriculumCohorts: state.curriculumCohorts })", ctx);
  assert.equal(JSON.stringify(payload, ctx.stateJsonReplacer), JSON.stringify(payload));
  assert.equal(ctx.stateRawValue(vm.runInContext("state.students", ctx)), vm.runInContext("rawState.students", ctx));
});

test("merged-cell colours are looked up from an index that follows state changes", () => {
  const ctx = stateContext();
  vm.runInContext(functionSource("function columnIndex(", "function isSelected("), ctx);
  vm.runInContext(`state.curriculumCohorts["2026"] = { importedLayout: { rows: [], mergedRanges: ["B2:B4"], cellFills: { "1:1": "FFAA00" } } };`, ctx);
  const layout = () => vm.runInContext(`state.curriculumCohorts["2026"].importedLayout`, ctx);
  assert.equal(ctx.curriculumCellFill(layout(), 3, 1), "FFAA00", "inside the merge → the top-left colour");
  assert.equal(ctx.curriculumCellFill(layout(), 4, 1), "");
  vm.runInContext(`state.curriculumCohorts["2026"].importedLayout.mergedRanges.push("B5:B6");
    state.curriculumCohorts["2026"].importedLayout.cellFills["4:1"] = "00FF00";`, ctx);
  assert.equal(ctx.curriculumCellFill(layout(), 5, 1), "00FF00", "a new merge is seen at once");
  // 프록시를 거치지 않은 편제표(업로드 변환 중)는 예전처럼 병합 목록을 훑는다.
  assert.equal(ctx.curriculumCellFill({ mergedRanges: ["A1:A3"], cellFills: { "0:0": "123456" } }, 2, 0), "123456");
});

function functionSource(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from + 1);
  assert.ok(from >= 0 && to > from, `${start} … ${end}`);
  return app.slice(from, to);
}

test("the application subject list is cached by state revision and every caller gets its own copy", () => {
  const ctx = stateContext();
  let runs = 0;
  vm.runInContext(`var $ = () => ({ value: "2026" });`, ctx);
  ctx.syncActiveCurriculumCohort = () => {};
  ctx.__fresh = () => { runs++; return { "1": [], "2": [{ subject: "물리학", semesterColors: { "1": "FF0000" }, semesterGroups: { "1": { groupName: "2-1 택3" } } }], "3": [] }; };
  const source = functionSource("function collectApplicationSubjects(", "function selectedApplicationSubjects(")
    .replace(/const \{ includeExcluded = false[\s\S]*?\n    \}\n\n    function cloneApplicationSubjects/, "return __fresh();\n    }\n\n    function cloneApplicationSubjects");
  vm.runInContext(source, ctx);
  const first = ctx.collectApplicationSubjects();
  first["2"][0].semesterGroups["1"].groupName = "바뀜";
  first["2"][0].semesterColors["1"] = "000000";
  first["2"].push({ subject: "추가" });
  const second = ctx.collectApplicationSubjects();
  assert.equal(runs, 1, "the second call is served from the cache");
  assert.equal(second["2"].length, 1);
  assert.equal(second["2"][0].semesterGroups["1"].groupName, "2-1 택3", "a caller's edit does not leak into the cache");
  assert.equal(second["2"][0].semesterColors["1"], "FF0000");
  ctx.collectApplicationSubjects({ includeExcluded: true });
  assert.equal(runs, 2, "different options are cached separately");
  vm.runInContext(`state.curriculumCohorts["2026"] = { plan: [] };`, ctx);
  ctx.collectApplicationSubjects();
  assert.equal(runs, 3, "a plan change recomputes");
});

test("app wiring: hidden steps are deferred, renders of steps 4·5 are wrapped, saves from UI handlers are batched", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(html.indexOf('src="view-keep.js') >= 0 && html.indexOf('src="view-keep.js') < html.indexOf('src="app.js'), "view-keep.js loads before app.js");
  const aggregate = functionSource("function renderAggregate(", "function renderAggregateView(");
  assert.match(aggregate, /deferRenderUntilStepVisible\(4, "renderAggregate", renderAggregate\)/);
  assert.match(aggregate, /preserveViewDuring\(\["#aggregatePanel", "#retakePanel"\], renderAggregateView\)/);
  const hours = fs.readFileSync(path.join(root, "hours-stats.js"), "utf8");
  assert.match(hours.slice(hours.indexOf("function renderHoursStats("), hours.indexOf("function renderHoursStatsView(")), /preserveViewDuring\(\[[^\]]*"#workflowStep7Panel"/);
  const layout = functionSource("function renderWorkflowLayoutSteps(", "function workflowStepLabel(");
  assert.match(layout, /flushDeferredStepRenders\(step\)/);
  assert.match(functionSource("function switchWorkflowStep(", "function renderWorkspaceContext("), /persistStateSoon\(\{ viewOnly: true \}\)/);
  assert.match(app, /holdStepRenders\(restorePersistedState\)/);
});
