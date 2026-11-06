const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const key = "course-certificate-studio-v1";
const groupKey = "curriculum-color-semester-groups-v3:2026";

function source(name) {
  const start = app.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const tail = app.slice(start + 1);
  const next = tail.search(/\n    (?:async )?function /);
  return app.slice(start, start + 1 + next);
}

function fixture(saved) {
  const storage = new Map(saved === undefined ? [] : [[key, saved]]);
  const elements = new Map();
  const timers = new Map();
  const notices = [];
  let writes = 0;
  const defaults = {
    "#schoolYear": "2026", "#schoolName": "학교", "#round": "1차",
    "#openingPercent": "90", "#divisionPercent": "110", "#confirmDate": "2026. 11. 4.",
  };
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: defaults[id] || "", textContent: "", innerHTML: "", style: {}, dataset: {},
      classList: { toggle() {} }, checkValidity() { return /^(?:20\d{2}|2100)$/.test(this.value); },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { querySelector: element },
    window: {
      setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
      confirm: () => true,
      location: { reload() { context.reloaded = true; } },
    },
    localStorage: {
      get length() { return storage.size; },
      key: (index) => [...storage.keys()][index],
      getItem(name) { if (context.readError) throw new Error("storage denied"); return storage.get(name) ?? null; },
      setItem(name, value) {
        if (context.writeError || context.failKey === name) {
          context.failKey = null;
          throw new Error("quota exceeded");
        }
        writes++;
        storage.set(name, value);
      },
      removeItem: (name) => storage.delete(name),
    },
    normalizeCourses: (courses) => courses,
    normalizeCurriculumPlanRow: (row) => row,
    normalizeCurriculumDivisionFilter: (value) => value,
    normalizeCurriculumDetailFilter: (value) => value,
    resetWorkspace: () => {},
    renderRoster() {}, renderPreview() {}, renderCurriculumStep() {},
    renderSemesterClassifier() {}, renderAggregate() {}, renderWorkflowLayout() {},
    applyClassFilterOptions() {},
    showAppToast: (message) => notices.push(message),
    downloadTextFile: (text) => { context.downloaded = JSON.parse(text); },
  });
  vm.runInContext(app.slice(0, app.indexOf("function escapeHtml(")), context);
  for (const name of [
    "syncActiveRound", "syncActiveCurriculumCohort", "applicationRoundNumbers",
    "updateWorkspaceSaveStatus", "isWorkspaceStorageProtected", "workspacePayload", "persistState", "validateWorkspaceData",
    "loadCurriculumPlanData", "restorePersistedState", "downloadWorkspaceBackup", "restoreWorkspaceBackup",
  ]) vm.runInContext(source(name), context);
  const groups = fs.readFileSync(path.join(root, "course-groups.js"), "utf8");
  vm.runInContext(groups.slice(groups.indexOf("function validateApplicationGroupData("), groups.indexOf("(() => {")), context);
  return { context, storage, elements, element, timers, notices, writes: () => writes };
}

function valid(overrides = {}) {
  return { students: [], courses: [], rounds: { "1": null }, currentRound: "1",
    schoolYear: "2026", schemaVersion: 2, workflowStep: 1, ...overrides };
}

test("save failures remain visible, keep the previous data and can be retried", () => {
  const f = fixture();
  f.context.writeError = true;
  assert.equal(f.context.persistState(), false);
  assert.match(f.element("#workspaceSaveStatus").textContent, /저장 실패/);
  assert.equal(f.storage.has(key), false);
  f.context.writeError = false;
  assert.equal(f.context.persistState(), true);
  assert.equal(JSON.parse(f.storage.get(key)).schemaVersion, 2);
  assert.equal(vm.runInContext("statePersistenceSuppressed", f.context), 0);
  assert.match(f.element("#workspaceSaveStatus").textContent, /저장 완료/);
  const before = f.writes();
  assert.equal(f.context.persistState(), true);
  assert.equal(f.writes(), before, "unchanged state must not rewrite localStorage");
});

test("corrupt or unsupported data is preserved and cannot be overwritten by autosave", () => {
  for (const raw of ["{broken", JSON.stringify(valid({ schemaVersion: 99 })),
    JSON.stringify(valid({ rounds: { "1": { students: "broken", courses: [] } } }))]) {
    const f = fixture(raw);
    f.context.restorePersistedState();
    assert.match(f.element("#workspaceSaveStatus").textContent, /원본 보호/);
    assert.equal(f.context.persistState(), false);
    assert.equal(f.storage.get(key), raw);
    assert.equal(vm.runInContext("protectedStoredState", f.context), raw);
  }
});

test("storage access denial is surfaced instead of deleting the saved workspace", () => {
  const raw = JSON.stringify(valid());
  const f = fixture(raw);
  f.context.readError = true;
  f.context.restorePersistedState();
  assert.match(f.element("#workspaceSaveStatus").textContent, /storage denied/);
  assert.equal(f.context.persistState(), false);
  assert.equal(f.storage.get(key), raw);
});

test("student routes and incomplete restoration protect teacher group storage", () => {
  const f = fixture();
  assert.equal(f.context.isWorkspaceStorageProtected(), true);
  vm.runInContext("statePersistenceReady = true;", f.context);
  assert.equal(f.context.isWorkspaceStorageProtected(), false);
  vm.runInContext("statePersistenceBlocked = true;", f.context);
  assert.equal(f.context.isWorkspaceStorageProtected(), true);
});

test("current six-step navigation, application grade and empty online rounds survive restore", () => {
  for (const workflowStep of [1, 2, 3, 4, 5, 6]) {
    const f = fixture(JSON.stringify(valid({
      workflowStep, applicationMenuGrade: "2",
      rounds: { "1": { students: [], courses: [], fileName: "온라인 자동 연동" } },
    })));
    f.context.restorePersistedState();
    assert.equal(vm.runInContext("state.workflowStep", f.context), workflowStep);
    assert.equal(vm.runInContext("state.applicationMenuGrade", f.context), "2");
    assert.equal(vm.runInContext('state.rounds["1"].fileName', f.context), "온라인 자동 연동");
    assert.equal(f.context.persistState(), true);
  }
});

test("another window's saved changes are never silently overwritten", () => {
  const original = JSON.stringify(valid());
  const f = fixture(original);
  f.context.restorePersistedState();
  const other = JSON.stringify(valid({ schoolName: "다른 창" }));
  f.storage.set(key, other);
  assert.equal(f.context.persistState(), false);
  assert.equal(f.storage.get(key), other);
  assert.match(f.element("#workspaceSaveStatus").textContent, /다른 창/);
});

test("reading unchanged active round and cohort does not schedule unnecessary saves", () => {
  const f = fixture();
  vm.runInContext(`
    state.fileName = "온라인 자동 연동";
    syncActiveRound();
    syncActiveCurriculumCohort();
    statePersistenceReady = true;
    syncActiveRound();
    syncActiveCurriculumCohort();
  `, f.context);
  assert.equal(f.timers.size, 0);
});

test("workspace backups include groups and protected originals but never login tokens", () => {
  const f = fixture("{broken");
  f.storage.set(groupKey, "[]");
  f.storage.set("curriculum-teacher-session-v1", "private-session");
  f.context.restorePersistedState();
  f.context.downloadWorkspaceBackup();
  assert.equal(f.context.downloaded.protectedStoredState, "{broken");
  assert.equal(f.context.downloaded.groups[groupKey], "[]");
  assert.ok(!JSON.stringify(f.context.downloaded).includes("private-session"));
});

test("backup restore validates before writing and rolls back a partially failed import", async () => {
  const raw = JSON.stringify(valid({ schoolName: "원본" }));
  const f = fixture(raw);
  const backup = { type: "curriculum-workspace-backup", workspace: valid({ schoolName: "백업" }),
    groups: { [groupKey]: "[]", [groupKey + "-seeded"]: "[]" } };
  f.context.failKey = groupKey + "-seeded";
  await f.context.restoreWorkspaceBackup({ text: async () => JSON.stringify(backup) });
  assert.equal(f.storage.get(key), raw);
  assert.equal(f.storage.has(groupKey), false);
  assert.ok(!f.context.reloaded);
  assert.match(f.notices.at(-1), /복원 실패/);
  backup.groups[groupKey] = "{broken";
  const before = f.writes();
  await f.context.restoreWorkspaceBackup({ text: async () => JSON.stringify(backup) });
  assert.equal(f.writes(), before);
  backup.groups[groupKey] = "[]";
  await f.context.restoreWorkspaceBackup({ text: async () => JSON.stringify(backup) });
  assert.equal(JSON.parse(f.storage.get(key)).schoolName, "백업");
  assert.equal(f.context.reloaded, true);
});

test("backup restore uses valid pending group settings instead of older stored groups", async () => {
  const f = fixture();
  const pending = [{ id: "g1", grade: "2", semester: "1", name: "미저장 수정",
    count: 1, courses: ["수학"] }];
  const backup = { type: "curriculum-workspace-backup", workspace: valid(), groups: { [groupKey]: "[]" },
    pendingGroupSettings: { key: groupKey, groups: pending, seeded: ["2:1:수학"], canRestore: true } };
  await f.context.restoreWorkspaceBackup({ text: async () => JSON.stringify(backup) });
  assert.equal(JSON.parse(f.storage.get(groupKey))[0].name, "미저장 수정");
  assert.equal(f.context.reloaded, true);
});

test("local file and offline work never require teacher login; student routes stay blocked", () => {
  let loginChecks = 0;
  const context = vm.createContext({
    URL, URLSearchParams, navigator: { onLine: true },
    window: { location: { href: "file:///C:/test/index.html" } },
    requireTeacherLogin: () => { loginChecks++; return false; },
    showAppToast() {},
  });
  vm.runInContext(source("requireLocalWorkspaceAccess"), context);
  assert.equal(context.requireLocalWorkspaceAccess(), true);
  context.window.location.href = "https://school.example/";
  assert.equal(context.requireLocalWorkspaceAccess(), true, "online hosting does not gate local uploads");
  context.navigator.onLine = false;
  assert.equal(context.requireLocalWorkspaceAccess(), true);
  assert.equal(loginChecks, 0);
  context.window.location.href = "https://school.example/#student";
  assert.equal(context.requireLocalWorkspaceAccess(), false);
});

test("aggregate thresholds reject invalid values instead of using different closure defaults", () => {
  const values = { "#openingPercent": "90", "#divisionPercent": "110" };
  const context = vm.createContext({ $: (id) => ({ value: values[id] }) });
  vm.runInContext(source("aggregateThresholds"), context);
  assert.equal(context.aggregateThresholds().openingPercent, 90);
  for (const invalid of ["", "0", "-1", "201", "90.5", "Infinity"]) {
    values["#openingPercent"] = invalid;
    assert.throws(() => context.aggregateThresholds(), /정수/);
  }
  values["#openingPercent"] = "90";
  values["#divisionPercent"] = "301";
  assert.throws(() => context.aggregateThresholds(), /정수/);
});

test("a slower earlier curriculum upload cannot replace the newer uploaded plan", async () => {
  const f = fixture();
  const readers = [];
  f.context.FileReader = class {
    readAsArrayBuffer(file) { this.result = file.name; readers.push(this); }
  };
  Object.assign(f.context, {
    requireLocalWorkspaceAccess: () => true,
    curriculumPlanVersionKey: () => "2026",
    parseWorkbook: async (name) => [{ name: "표", rows: [[name]] }],
    cropCurriculumSheet: (sheet) => ({ rows: sheet.rows }),
    curriculumPlanFromLayout: (layout) => [{ subject: layout.rows[0][0] }],
    storeCurriculumArchive: async () => "archive",
    recordCurriculumUndo() {},
  });
  vm.runInContext(source("handleCurriculumPlanWorkbook"), f.context);
  f.context.handleCurriculumPlanWorkbook({ name: "이전.xlsx" });
  f.context.handleCurriculumPlanWorkbook({ name: "최신.xlsx" });
  await readers[1].onload();
  assert.equal(vm.runInContext("state.curriculumPlanFileName", f.context), "최신.xlsx");
  await readers[0].onload();
  assert.equal(vm.runInContext("state.curriculumPlanFileName", f.context), "최신.xlsx");
  assert.match(f.element("#status").textContent, /새 업로드/);
});
