"use strict";
// 하네스 순수 함수 자체 점검(브라우저 없이): node e2e/selftest.cjs
const assert = require("node:assert/strict");
const { checkTimetable, checkNeisExport, NEIS_COLUMNS } = require("./lib/timetable-checks.cjs");
const Expected = require("./lib/expected.cjs");

const selections = new Map([["2-1-1", [{ subject: "물리학", semester: "1" }, { subject: "화학", semester: "1" }]], ["2-1-2", [{ subject: "물리학", semester: "1" }]]]);
const good = { sections: [
  { id: "물리A", semester: "1", subject: "물리학", block: "A", teacher: "김", capacity: 2, students: ["2-1-1", "2-1-2"] },
  { id: "화학B", semester: "1", subject: "화학", block: "B", teacher: "이", capacity: 30, students: ["2-1-1"] }], selections, unavailable: { 이: ["C"] } };
assert.equal(checkTimetable(good).ok, true);
const bad = { ...good, sections: [{ ...good.sections[0], capacity: 1 }, { ...good.sections[1], block: "A", teacher: "김" }], unavailable: { 김: ["A"] } };
const r = checkTimetable(bad).problems;
assert.equal(r.overCapacity.length, 1); assert.equal(r.blockConflict.length, 1); assert.equal(r.teacherConflict.length, 1); assert.equal(r.teacherUnavailable.length, 2);
assert.deepEqual(checkTimetable({ ...good, sections: [good.sections[0]] }).problems.unassigned, ["2-1-1|1|화학"]);
const rows = [["개설 과목"], NEIS_COLUMNS, ["2027", "1", "2", "과학", "물리학(3)", "", "", "1", "1", "가"], ["2027", "1", "2", "과학", "화학(3)", "", "", "1", "1", "가"], ["2027", "1", "2", "과학", "물리학(3)", "", "", "1", "2", "나"]];
assert.equal(checkNeisExport(rows, { selections }).ok, true);
assert.equal(checkNeisExport([...rows, rows[2]], { selections }).duplicates.length, 1);
assert.equal(Expected.prerequisiteStatus(["역학과 에너지", "화학", "생명과학", "지구과학"], 2).violations.length, 1);
assert.equal(Expected.prerequisiteStatus(["역학과 에너지", "물리학"], 2).violations.length, 0);
assert.equal(Expected.prerequisiteStatus(["전자기와 양자"], 3).unknowns.length, 1);
assert.equal(Expected.prerequisiteStatus(["전자기와 양자"], 3, new Set(["물리학"])).violations.length, 0);
assert.equal(Expected.kemCredits([]), 64);
console.log("selftest ok");
