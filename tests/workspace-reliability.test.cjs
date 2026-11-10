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
    downloadTextFile: (text) => { context.downloadedText = text; context.downloaded = JSON.parse(text); },
  });
  vm.runInContext(app.slice(0, app.indexOf("function escapeHtml(")), context);
  for (const name of [
    "syncActiveRound", "syncActiveCurriculumCohort", "applicationRoundNumbers",
    "updateWorkspaceSaveStatus", "isWorkspaceStorageProtected", "workspacePayload", "persistState", "validateWorkspaceData",
    "loadCurriculumPlanData", "restorePersistedState", "workspaceBackupCompact", "workspaceBackupExpand", "readWorkspaceBackupText", "workspaceBackupGzip",
    "buildWorkspaceBackup", "workspaceBackupFileName", "downloadWorkspaceBackup", "restoreWorkspaceBackup",
  ]) vm.runInContext(source(name), context);
  vm.runInContext("var WORKSPACE_BACKUP_VERSION = 2, APP_VERSION = 'test'; function markWorkspaceBackup() {}", context);
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

test("workspace backups include groups and protected originals but never login tokens", async () => {
  const f = fixture("{broken");
  f.storage.set(groupKey, "[]");
  f.storage.set("curriculum-teacher-session-v1", "private-session");
  f.context.restorePersistedState();
  await f.context.downloadWorkspaceBackup();
  assert.equal(f.context.downloaded.protectedStoredState, "{broken");
  assert.equal(f.context.downloaded.groups[groupKey], "[]");
  assert.ok(!JSON.stringify(f.context.downloaded).includes("private-session"));
  // 크기를 줄이려고 들여쓰기 없이 쓴다(읽기는 JSON.parse라 예전 들여쓴 백업도 그대로 읽힌다).
  assert.equal(f.context.downloadedText.includes("\n"), false);
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
  for (const name of ["aggregateThresholds", "aggregateThresholdFieldError", "aggregateThresholdStoredValue"]) vm.runInContext(source(name), context);
  // 저장된 값이 잘못된 경우(적용된 값 없음): 예전처럼 오류.
  for (const invalid of ["", "0", "-1", "201", "90.5", "Infinity"]) {
    values["#openingPercent"] = invalid;
    assert.throws(() => context.aggregateThresholds(), /정수/);
    assert.match(context.aggregateThresholdFieldError("#openingPercent"), /개설 기준은 1~200 사이의 정수/);
  }
  values["#openingPercent"] = "90";
  values["#divisionPercent"] = "301";
  assert.throws(() => context.aggregateThresholds(), /정수/);
  // 올바른 값이 한 번 적용되면, 칸에 잘못된 값을 넣어도 적용하지 않고(그 값으로 계산·저장하지 않고) 적용된 값을 쓴다.
  values["#divisionPercent"] = "110";
  assert.deepEqual({ ...context.aggregateThresholds() }, { openingPercent: 90, divisionPercent: 110 });
  values["#openingPercent"] = "0";
  assert.deepEqual({ ...context.aggregateThresholds() }, { openingPercent: 90, divisionPercent: 110 });
  assert.equal(context.aggregateThresholdStoredValue("#openingPercent"), "90", "잘못된 값은 저장하지 않는다");
  values["#openingPercent"] = "85";
  assert.equal(context.aggregateThresholds().openingPercent, 85);
  assert.equal(context.aggregateThresholdStoredValue("#openingPercent"), "85");
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
  vm.runInContext("var curriculumUploadReturn = null;", f.context);
  vm.runInContext(source("restoreCurriculumUploadCard"), f.context);
  vm.runInContext(source("handleCurriculumPlanWorkbook"), f.context);
  f.context.handleCurriculumPlanWorkbook({ name: "이전.xlsx" });
  f.context.handleCurriculumPlanWorkbook({ name: "최신.xlsx" });
  await readers[1].onload();
  assert.equal(vm.runInContext("state.curriculumPlanFileName", f.context), "최신.xlsx");
  await readers[0].onload();
  assert.equal(vm.runInContext("state.curriculumPlanFileName", f.context), "최신.xlsx");
  assert.match(f.element("#status").textContent, /새 업로드/);
});

test("the per-class maximum defaults to 34 for older saved data and is saved with the workspace", async () => {
  const older = fixture(JSON.stringify(valid()));
  older.context.restorePersistedState();
  assert.equal(older.element("#maxClassSize").value, "34", "data saved before the setting existed uses 34");
  const saved = fixture(JSON.stringify(valid({ maxClassSize: "30" })));
  saved.context.restorePersistedState();
  assert.equal(saved.element("#maxClassSize").value, "30");
  assert.equal(saved.context.workspacePayload().maxClassSize, "30");
  await saved.context.downloadWorkspaceBackup();
  assert.equal(saved.context.downloaded.workspace.maxClassSize, "30");
});

test("backup format 2 leaves out the duplicate current-round students, is gzipped, and old indented, new gzip and format-2 json backups all restore the same", async () => {
  const students = [{ id: "1-1-1-가상", grade: "1", classroom: "1", number: "1", name: "가상", selections: [] }];
  const workspace = valid({ students, courses: [], fileName: "결과.xlsx", schoolName: "가나고",
    rounds: { "1": { fileName: "결과.xlsx", students, courses: [], classOverrides: {}, semesterAssignments: {}, groupAssignments: {}, customGroupNames: [] } } });
  const saved = fixture(JSON.stringify(workspace));
  saved.context.restorePersistedState();
  Object.assign(saved.context, { CompressionStream, DecompressionStream, Blob, Response, TextDecoder, Uint8Array });
  let packed = null;
  saved.context.downloadTextFile = (data, name) => { packed = { data, name }; };
  await saved.context.downloadWorkspaceBackup();
  assert.match(packed.name, /^교육과정_작업자료_백업_\d{8}-\d{4}\.json\.gz$/, "백업 파일 이름에 날짜·시각");
  const bytes = new Uint8Array(await packed.data.arrayBuffer());
  assert.deepEqual([bytes[0], bytes[1]], [0x1f, 0x8b], "gzip magic bytes");
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  const backup = JSON.parse(text);
  assert.equal(backup.backupVersion, 2);
  assert.deepEqual(backup.omitted, ["students"]);
  assert.equal(Object.hasOwn(backup.workspace, "students"), false, "current-round students are not stored twice");
  assert.equal(backup.workspace.rounds["1"].students.length, 1);
  // CompressionStream이 없는 브라우저는 예전처럼 .json으로 내려받는다.
  delete saved.context.CompressionStream;
  await saved.context.downloadWorkspaceBackup();
  assert.match(packed.name, /^교육과정_작업자료_백업_\d{8}-\d{4}\.json$/);
  assert.equal(saved.context.workspaceBackupFileName(".json.gz", new Date(2026, 10, 10, 9, 5)), "교육과정_작업자료_백업_20261110-0905.json.gz");
  assert.deepEqual(JSON.parse(packed.data).omitted, ["students"]);

  const restored = async (file) => {
    const f = fixture(JSON.stringify(valid({ schoolName: "원래" })));
    Object.assign(f.context, { DecompressionStream, Blob, Response, TextDecoder, Uint8Array });
    f.context.window.location.reload = () => { f.context.reloaded = true; };
    assert.equal(await f.context.restoreWorkspaceBackup(file), true, f.notices.at(-1));
    return JSON.parse(f.storage.get(key));
  };
  const asFile = (data) => ({ arrayBuffer: async () => (typeof data === "string" ? new TextEncoder().encode(data) : data).buffer });
  const fromGzip = await restored(asFile(bytes));
  const fromJson = await restored(asFile(packed.data));
  // 예전(형식 1) 들여쓴 백업: workspace.students가 들어 있다.
  const legacy = JSON.stringify({ type: "curriculum-workspace-backup", backupVersion: 1, workspace, groups: {} }, null, 2);
  const fromLegacy = await restored(asFile(legacy));
  const fromLegacyText = await restored({ text: async () => legacy }); // PC 파일 경로(text만 있음)
  for (const result of [fromGzip, fromJson, fromLegacy, fromLegacyText]) {
    assert.equal(result.schoolName, "가나고");
    assert.deepEqual(result.students, students, "students are filled from the current round");
    assert.deepEqual(result.rounds["1"].students, students);
  }
  // 형식 2인데 현재 차수 학생이 없으면 빈 학생으로 읽지 않고 거절한다.
  const broken = JSON.stringify({ ...backup, workspace: { ...backup.workspace, rounds: { "1": null } } });
  const f = fixture(JSON.stringify(valid({ schoolName: "원래" })));
  assert.equal(await f.context.restoreWorkspaceBackup({ text: async () => broken }), false);
  assert.match(f.notices.at(-1), /현재 차수 학생 자료를 찾지 못했습니다/);
});

test("6단계 분반 편성 결과(classSections)는 형식 2 백업·PC 파일 경로로 복원되고, 예전 백업(없음)은 빈 값으로 시작한다", async () => {
  const students = [{ id: "1-1-1-가상", grade: "1", classroom: "1", number: "1", name: "가상", selections: [] }];
  const classSections = { settings: { teachers: [], spreadWarn: 3 },
    "2": { "1:1:2-1 택3": { mode: "move", classCounts: {}, sectionResult: { signature: "abc", sections: [{ id: "a-물리학-1", students: ["1-1-1"] }], explain: { feasible: true } } } } };
  const workspace = valid({ students, courses: [], fileName: "결과.xlsx", schoolName: "가나고", classSections,
    rounds: { "1": { fileName: "결과.xlsx", students, courses: [], classOverrides: {}, semesterAssignments: {}, groupAssignments: {}, customGroupNames: [] } } });
  const saved = fixture(JSON.stringify(workspace));
  saved.context.restorePersistedState();
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext("state.classSections", saved.context))), classSections, "새로고침(저장 자료 다시 읽기) 뒤 그대로");
  await saved.context.downloadWorkspaceBackup();
  const backup = saved.context.downloaded;
  assert.deepEqual(backup.workspace.classSections, classSections, "백업(형식 2)에 들어감");
  const restoreInto = async (text) => {
    const f = fixture(JSON.stringify(valid({ schoolName: "원래" })));
    f.context.window.location.reload = () => { f.context.reloaded = true; };
    assert.equal(await f.context.restoreWorkspaceBackup({ text: async () => text }), true, f.notices.at(-1));
    const after = fixture(f.storage.get(key));
    after.context.restorePersistedState();
    return JSON.parse(JSON.stringify(vm.runInContext("state.classSections", after.context)));
  };
  // 백업 파일·PC 파일(같은 buildWorkspaceBackup 글자, text()만 넘김) 모두 같은 경로로 복원된다.
  assert.deepEqual(await restoreInto(saved.context.downloadedText), classSections);
  const legacy = { ...backup, backupVersion: 1, workspace: { ...backup.workspace, students } };
  delete legacy.omitted;
  delete legacy.workspace.classSections;
  assert.deepEqual(await restoreInto(JSON.stringify(legacy, null, 2)), {}, "예전 백업은 빈 분반 편성으로 시작");
});
