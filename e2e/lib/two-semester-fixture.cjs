"use strict";
// 두 학기 편성 과목 한 열 결과(가로형, 가상 학생 · 성명은 '학생n'): 현 2학년 11학급 × 28명.
// 합성 편제표(plan-fixture.cjs)의 3학년 3-1 택5·3-2 택5에 모두 있는 '심화 영어'를 결과표에 한 열로만 적는다.
// 열 순서: 3-1 택5(심화 영어 뺀 9과목) · 3-1 택1 · [심화 영어] · 3-2 택5(10과목) · 3-2 택1 → 심화 영어는 학기 경계(이웃 열 학기가 다름).
// 신청 학생 대부분은 3-1에서 5과목 + 3-2에서 4과목 + 심화 영어(= 실제로 2학기 신청), 일부(fewFirst명)는 3-1에서 4과목 + 심화 영어(= 1학기).
const { GROUPS } = require("./plan-fixture.cjs");

function rng(seed) {
  let value = seed >>> 0 || 1;
  return () => { value = (value * 1664525 + 1013904223) >>> 0; return value / 2 ** 32; };
}

function pick(list, count, random) {
  const copy = [...list];
  const out = [];
  while (out.length < count && copy.length) out.push(copy.splice(Math.floor(random() * copy.length), 1)[0]);
  return out;
}

function twoSemesterWideRows({ classes = 11, perClass = 28, seed = 7, twiceShare = 0.55, fewFirst = 12, course = "심화 영어" } = {}) {
  const random = rng(seed);
  const names = (field, pickCount) => GROUPS.find((group) => group.field === field && group.pick === pickCount).members.map((member) => member[2]).filter((name) => name !== course);
  const first5 = names("sem31", 5), first1 = names("sem31", 1), second5 = names("sem32", 5), second1 = names("sem32", 1);
  const columns = [...first5, ...first1, course, ...second5, ...second1];
  const credits = Object.fromEntries([...first5, ...second5, course].map((name) => [name, 3]).concat([...first1, ...second1].map((name) => [name, 2])));
  const head = ["", "", "", "", ...columns];
  const creditRow = ["학년", "반", "번호", "성명", ...columns.map((name) => credits[name])];
  const rows = [["선택과목 수강신청 결과(가상)"], head, creditRow];
  let firstCount = 0, secondCount = 0, index = 0;
  for (let classroom = 1; classroom <= classes; classroom++) {
    for (let number = 1; number <= perClass; number++, index++) {
      const twice = random() < twiceShare;
      const inFirst = twice && firstCount < fewFirst && random() < 0.12;
      const picked = new Set([...pick(first5, inFirst ? 4 : 5, random), ...pick(first1, 1, random), ...pick(second5, twice && !inFirst ? 4 : 5, random), ...pick(second1, 1, random)]);
      if (twice) { picked.add(course); if (inFirst) firstCount++; else secondCount++; }
      rows.push([2, classroom, number, `학생${index + 1}`, ...columns.map((name) => (picked.has(name) ? 1 : ""))]);
    }
  }
  return { rows, columns, firstCount, secondCount, students: classes * perClass };
}

module.exports = { twoSemesterWideRows };
