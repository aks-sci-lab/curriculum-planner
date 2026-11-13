const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// 학교 설정(school-settings.js) 순수 계산: 지금 값 모으기, 내보내기 파일에 이름이 없는지, 가져오기 검증·바뀌는 목록.
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "school-settings.js"), "utf8"), ctx);
const plain = (value) => JSON.parse(JSON.stringify(value));

test("값을 정한 적 없는 예전 자료는 예전 기본값 그대로(3학년 점심 3교시 뒤)", () => {
  const values = plain(ctx.schoolSettingsEffective({ aggregate: { openingPercent: "90", divisionPercent: "110", maxClassSize: "34" }, hours: {}, hoursCreative: { 자율: 1, 진로: 1 }, timetable: {} }));
  assert.equal(values["timetable.lunchAfter.3"].value, 3);
  assert.equal(values["timetable.lunchAfter.3"].explicit, false);
  assert.equal(values["timetable.lunchAfter.1"].value, 4);
  assert.equal(values["hours.maxTeacherHours"].value, 19);
  assert.equal(values["hours.roamingTeacherHours"].value, 13);
  assert.equal(values["timetable.rules.departmentMax.진로"].value, 10);
  assert.equal(values["aggregate.openingPercent"].explicit, true);
  // 새로 시작하는 학교는 모든 학년 4교시 뒤.
  const fresh = plain(ctx.schoolSettingsEffective({ timetable: ctx.schoolSettingsNeutralTimetable() }));
  assert.deepEqual(["1", "2", "3"].map((grade) => fresh[`timetable.lunchAfter.${grade}`].value), [4, 4, 4]);
  assert.equal(fresh["timetable.lunchAfter.3"].explicit, true);
});

test("내보내기 파일에는 기준값만 들어간다(교사·고정·반 배정 없음), 다시 읽으면 같은 값", () => {
  const sources = {
    aggregate: { openingPercent: "80", divisionPercent: "120", maxClassSize: "30" },
    hours: { maxTeacherHours: 18, creative: { 자율: 2, 진로: 1 }, teachers: { 국어: 5 }, classCounts: { 1: 10 } },
    hoursCreative: { 자율: 2, 진로: 1 },
    timetable: { lunchAfter: { 1: 4, 2: 4, 3: 4 }, rules: { maxHours: 20, departmentMax: { 진로: 12 } }, periodsByDay: { 수: 6 },
      pins: { 1: { "수업@1": ["월1"] } }, teacherPins: { 1: { "수업@1": "t-김교사" } }, homerooms: { "1-1": "김교사" }, choices: [{ key: "x" }] },
    compliance: { subjects: 174, required: { 국어: 8 } },
  };
  const file = plain(ctx.schoolSettingsExport(sources, { exportedAt: "2026-11-13T00:00:00Z", schoolName: "가상고" }));
  assert.equal(file.type, "curriculum-school-settings");
  const text = JSON.stringify(file);
  for (const word of ["김교사", "pins", "homerooms", "choices", "teachers", "classCounts"]) assert.ok(!text.includes(word), word);
  assert.equal(file.values["aggregate.openingPercent"], 80);
  assert.equal(file.values["timetable.rules.departmentMax.진로"], 12);
  assert.deepEqual(file.timetable.periodsByDay, { 수: 6 });
  const parsed = plain(ctx.schoolSettingsParse(text));
  assert.deepEqual(plain(ctx.schoolSettingsImportChanges(parsed, sources)), []);
  // 다른 학교(기본값)에서 가져오면 바뀌는 것만 나온다.
  const changes = plain(ctx.schoolSettingsImportChanges(parsed, { aggregate: { openingPercent: "90", divisionPercent: "110", maxClassSize: "34" }, hours: {}, hoursCreative: { 자율: 1, 진로: 1 }, timetable: {} }));
  const keys = changes.map((change) => change.key);
  assert.ok(keys.includes("aggregate.openingPercent") && keys.includes("timetable.lunchAfter.3") && keys.includes("compliance") && keys.includes("timetable"));
  assert.ok(!keys.includes("hours.roamingTeacherHours"));
  assert.deepEqual(changes.find((change) => change.key === "timetable.lunchAfter.3"), { key: "timetable.lunchAfter.3", label: "3학년 점심 (몇 교시 뒤)", from: 3, to: 4 });
});

test("잘못된 파일은 이유를 알려 준다", () => {
  const message = (text) => { try { ctx.schoolSettingsParse(text); return ""; } catch (error) { return error?.message || ""; } };
  assert.match(message("abc"), /JSON/);
  assert.match(message(JSON.stringify({ type: "curriculum-workspace-backup" })), /작업 자료 백업/);
  assert.match(message(JSON.stringify({ type: "curriculum-school-settings", version: 9 })), /더 새 버전/);
  assert.match(message(JSON.stringify({ type: "curriculum-school-settings", version: 1, values: { "aggregate.maxClassSize": 500 } })), /반별 최대 인원/);
  // 모르는 항목·이름이 든 항목은 버린다.
  const parsed = plain(ctx.schoolSettingsParse(JSON.stringify({ type: "curriculum-school-settings", version: 1, values: { "x.y": 1, "aggregate.maxClassSize": 30 }, timetable: { pins: { a: 1 }, venues: { 체육: 2 } }, teachers: ["김교사"] })));
  assert.deepEqual(parsed.values, { "aggregate.maxClassSize": 30 });
  assert.deepEqual(parsed.timetable, { venues: { 체육: 2 } });
});

test("숫자 한 칸 넣기는 원래 객체를 바꾸지 않는다", () => {
  const before = { rules: { run: 3, departmentMax: { 진로: 10 } }, pins: { a: 1 } };
  const after = plain(ctx.schoolSettingsWithPath(before, ["rules", "departmentMax", "진로"], 12));
  assert.equal(before.rules.departmentMax.진로, 10);
  assert.deepEqual(after, { rules: { run: 3, departmentMax: { 진로: 12 } }, pins: { a: 1 } });
});
