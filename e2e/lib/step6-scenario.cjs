"use strict";
// 6단계 시나리오 조각(run.cjs와 개발용 스크립트가 함께 씀). 모두 화면 클릭·입력으로 한다.
const S6 = require("./step6.cjs");
const { GROUPS } = require("./plan-fixture.cjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TEACHER_COUNTS = { "국어": 8, "수학": 10, "영어": 7, "과학-물리": 3, "과학-화학": 3, "과학-생명": 3, "과학-지구": 2, "사회-한국사": 3, "사회-지리": 2,
  "사회-일사": 3, "사회-윤리": 3, "기술가정": 1, "제2외국어": 2, "체육": 5, "음악": 2, "미술": 2, "정보": 2, "교양": 1 };
// 가상 교사: 육아시간(매일 7교시), 순회(목요일 전체)
const SPECIAL_TEACHERS = [
  { name: "육아화학", department: "과학-화학", slots: ["월7", "화7", "수7", "목7", "금7"], reason: "육아시간" },
  { name: "순회일사", department: "사회-일사", slots: ["목1", "목2", "목3", "목4", "목5", "목6", "목7"], reason: "순회" },
];
const FIXED = ["금6", "금7"];

async function setTeacherCounts(page) {
  const done = {};
  for (const [id, n] of Object.entries(TEACHER_COUNTS)) {
    const input = page.locator(`[data-hours-teachers="${id}"]`).first();
    if (!(await input.count())) continue;
    await input.fill(String(n)); await input.press("Tab"); await sleep(60);
    done[id] = n;
  }
  return done;
}

async function setupTeachers(page) {
  await page.locator("#classSectionsTeachersOpen").click();
  await page.locator("#classSectionsTeacherDialog[open]").waitFor();
  await page.getByRole("button", { name: "5단계 교사 수로 명단 만들기" }).click(); await sleep(300);
  // 만들기 → 두 명 삭제 → 다시 만들기: 교사 id·이름이 겹치지 않아야 한다
  const first = await page.locator("[data-cs-t$='|name']").count();
  for (let k = 0; k < 2; k++) { await page.locator("[data-cs-t-remove]").first().click(); await sleep(200); }
  await page.getByRole("button", { name: "5단계 교사 수로 명단 만들기" }).click(); await sleep(400);
  const names = await page.locator("[data-cs-t$='|name']").evaluateAll((els) => els.map((e) => e.value));
  const idWarning = await page.locator("#classSectionsTeacherIdWarning").innerText().catch(() => "");
  const rebuild = { first, afterRebuild: names.length, duplicateNames: names.filter((n, i) => n && names.indexOf(n) !== i), idWarning };
  let count = names.length;
  const fromHours = count;
  for (const t of SPECIAL_TEACHERS) {
    await page.getByRole("button", { name: "교사 추가" }).click(); await sleep(200);
    const i = count + 1;
    await page.getByLabel(`교사 ${i} 이름`, { exact: true }).fill(t.name); await page.getByLabel(`교사 ${i} 이름`, { exact: true }).press("Tab"); await sleep(120);
    await page.getByLabel(`교사 ${i} 담당 교과`, { exact: true }).selectOption(t.department); await sleep(150);
    await page.locator(`[data-cs-t-grid="${i - 1}"]`).click(); await sleep(200);
    for (const slot of t.slots) { await page.getByLabel(`${t.name} ${slot[0]}요일 ${slot.slice(1)}교시 불가`).check(); await sleep(60); }
    await page.getByLabel(`교사 ${i} 불가 사유`, { exact: true }).fill(t.reason); await page.getByLabel(`교사 ${i} 불가 사유`, { exact: true }).press("Tab"); await sleep(120);
    count++;
  }
  await page.getByRole("button", { name: "창체·진로 금 6·7교시 넣기" }).click(); await sleep(300);
  const dialogText = await page.locator("#classSectionsTeacherDialog").innerText();
  await page.locator("#classSectionsTeacherDialog").getByRole("button", { name: "닫기" }).first().click(); await sleep(300);
  return { rebuild, fromHours, total: await page.locator("[data-cs-t$='|name']").count().catch(() => count), dialogHasFixed: /금6|금 6/.test(dialogText) };
}

// 그룹 키 '현학년:학기:그룹명' → 편제표 묶음(학점)
function groupCredit(key) {
  const [grade, semester, name] = key.split(":");
  const pick = Number((name.match(/택(\d+)/) || [])[1]);
  const g = GROUPS.find((x) => x.field === `sem${Number(grade) + 1}${semester}` && x.pick === pick);
  return g ? g.credit : 3;
}

async function setBlockTimes(page, times) {
  const inputs = page.locator("[data-cs-block-times]");
  if (!(await inputs.first().isVisible().catch(() => false))) { await page.getByText("블록별로 다르게 · 블록 시간(요일·교시)").click(); await sleep(250); }
  const n = await inputs.count();
  for (let i = 0; i < n; i++) { await inputs.nth(i).fill(times[i] || ""); await inputs.nth(i).press("Tab"); await sleep(80); }
  return n;
}

module.exports = { TEACHER_COUNTS, SPECIAL_TEACHERS, FIXED, setTeacherCounts, setupTeachers, groupCredit, setBlockTimes };
