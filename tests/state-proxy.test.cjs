const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

test("nested state and array mutations schedule one persistence pass", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const start = app.indexOf("const rawState = {");
  const end = app.indexOf("const STORAGE_KEY", start);
  assert.ok(start >= 0 && end > start, "reactive application state should be present");

  let timerCallback;
  let scheduled = 0;
  let persisted = 0;
  const context = vm.createContext({
    window: {
      setTimeout(callback) { timerCallback = callback; scheduled++; return scheduled; },
      clearTimeout() {},
    },
    persistState() { persisted++; },
  });
  vm.runInContext(app.slice(start, end), context);
  vm.runInContext(`state.students.push({ name: "복원 전" });`, context);
  assert.equal(scheduled, 0, "restoration must finish before automatic saves can overwrite stored data");
  vm.runInContext(`statePersistenceReady = true;`, context);
  vm.runInContext(`
    state.students.push({ name: "학생" });
    state.curriculumPlanFilters.query = "수학";
    state.rounds["2"] = { students: state.students };
  `, context);

  assert.equal(scheduled, 1);
  assert.equal(persisted, 0);
  timerCallback();
  assert.equal(persisted, 1);
});
