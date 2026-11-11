"use strict";
// 두 학기 편성 과목 한 열 결과 → 개설 학기 선택 → 단계 간 일치(4단계 = 5단계 = 6단계) 클릭 시나리오. 화면 글자로만 확인한다.
// 쓰는 곳: e2e/two-semester-consistency-ui.cjs(백업 복원 뒤 단독 실행) · e2e/run.cjs 2-7 단계.
// check(ok, what, detail): 결과 기록 함수. 앱이 이미 열려 있고 현 2학년(→ 3학년) 편제표·선택 그룹·확정 차수가 있어야 한다.
const path = require("path"), fs = require("fs");
const { writeXlsx } = require("./xlsx-write.cjs");
const { twoSemesterWideRows } = require("./two-semester-fixture.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COURSE = "심화 영어";

async function twoSemesterScenario(page, { OUT, check, DIAGNOSE = false, log = console.log }) {
  const console = { log };
  const fixture = twoSemesterWideRows({});
  const file = path.join(OUT, "result-two-semester.xlsx");
  fs.writeFileSync(file, writeXlsx([{ name: "결과", rows: fixture.rows }]));
  log(`가상 결과: ${fixture.students}명 · ${COURSE} 1학기 의도 ${fixture.firstCount}명 · 2학기 의도 ${fixture.secondCount}명`);
  const shot = async (name) => page.screenshot({ path: path.join(OUT, `two-semester-${name}`), fullPage: false });
  const text = (selector) => page.locator(selector).innerText().catch(() => "");
  const appOk = async () => { const ok = page.locator("#appConfirmDialog[open] #appConfirmOk"); if (await ok.count()) { const message = await text("#appConfirmDialog[open]"); await ok.click(); await sleep(400); return message; } return ""; };
  const gotoStep = async (internal, panel) => { await page.locator(`[data-workflow-step="${internal}"]`).first().click(); await page.locator(panel).waitFor({ state: "visible", timeout: 30000 }); await sleep(500); };
  // 2단계: 현 2학년 · 외부 결과 방식 · 새 차수
  await gotoStep(2, "#workflowStep2Panel");
  await page.locator("#applicationGrade2Tab").click(); await sleep(300);
  if (!(await page.locator("#applicationModeExternal").isVisible())) await page.locator("#applicationModeSettings summary").click();
  await page.locator("#applicationModeExternal").click(); await sleep(300);
  await page.locator("#applicationResultsTab").click();
  await page.locator("#addApplicationRound").click(); await sleep(500);
  console.log("차수:", await text("#status"));
  await page.locator("#rosterInput").setInputFiles(file);
  await page.locator("#resultImportPreview:not(.hidden)").waitFor({ timeout: 30000 });
  await sleep(300);
  await shot("01-preview.png");
  const pickBox = page.locator("#resultSemesterPicks");
  const hasPicker = await pickBox.count() > 0;
  check(hasPicker, "결과 검증 미리보기에 '두 학기 편성 과목 — 개설 학기 선택'이 있음", (await text("#resultImportPreview")).slice(0, 800));
  if (hasPicker) {
    const boxText = await pickBox.innerText();
    console.log("개설 학기 선택:", boxText.replace(/\s+/g, " "));
    check(boxText.includes(COURSE), `개설 학기 선택에 ${COURSE}가 있음`, boxText);
    check(/근거|이웃|학생|추정/.test(boxText), "추정 근거를 함께 보여 줌", boxText);
    await page.getByRole("radio", { name: new RegExp(`${COURSE}.*2학기`) }).check(); await sleep(600);
  }
  if (DIAGNOSE) {
    // 반영하기 전 고르지 않음 확인 창은 따로 본다(클릭 확인 2부).
  }
  await page.locator("#confirmResultImport").click(); await sleep(500);
  const confirmText = await appOk();
  if (confirmText) console.log("반영 확인 창:", confirmText.replace(/\s+/g, " ").slice(0, 200));
  await sleep(1200);
  console.log("반영:", await text("#status"));

  // 화면 글자 읽기 도우미 ------------------------------------------------------
  // 4단계: 개설 학급수 칸의 접근성 이름('3학년 2학기 심화 영어 (2학기) 개설 학급수')과 값.
  const read4 = async () => page.evaluate((course) => [...document.querySelectorAll("#aggregatePanel .aggregate-class-input")]
    .map((input) => ({ label: input.getAttribute("aria-label") || "", classes: input.value }))
    .map((item) => ({ ...item, match: item.label.match(new RegExp(`^(.+?) ${course}(?:\\([^)]*\\))?(?: \\([12]학기\\))? 개설 학급수( \\(폐강\\))?$`)) }))
    .filter((item) => item.match).map((item) => ({ head: item.match[1], classes: Number(item.classes), closed: Boolean(item.match[2]) })), COURSE);
  const open4 = async () => {
    await gotoStep(4, "#aggregatePanel");
    const tab = page.locator('#aggregateGradeBar [data-aggregate-grade="2"]');
    if (await tab.count()) { await tab.click(); await sleep(500); }
  };
  const courseButton = () => page.locator("#aggregatePanel [data-aggregate-course]", { hasText: COURSE }).first();
  const decide = async (label) => { await courseButton().click(); await sleep(300); await page.locator("#aggregateCourseMenu").getByRole("button", { name: label, exact: true }).click(); await sleep(800); };
  const confirmRound = async () => {
    await page.locator("#roundConfirm").click(); await sleep(600);
    const ok = page.locator("dialog[open]").getByRole("button", { name: /확정/ }).first();
    if (await ok.count()) await ok.click();
    await sleep(800);
    return text("#roundConfirmState");
  };
  const unlockRound = async () => {
    await page.locator("#roundUnlock").click(); await sleep(500);
    const ok = page.locator("dialog[open]").getByRole("button", { name: /확정 해제/ }).first();
    if (await ok.count()) await ok.click();
    await sleep(800);
    return text("#roundConfirmState");
  };
  const hoursCell = (semester) => page.locator(`#workflowStep7Panel input[aria-label="3학년 ${semester}학기 ${COURSE} 개설반"]`).first();
  const read5 = async () => {
    await gotoStep(7, "#workflowStep7Panel"); await sleep(900);
    const out = {};
    for (const semester of ["1", "2"]) {
      const cell = hoursCell(semester);
      out[semester] = (await cell.count()) ? { classes: Number(await cell.inputValue()), title: await cell.getAttribute("title") } : null;
    }
    return out;
  };
  const read6 = async () => {
    await gotoStep(8, "#workflowStep8Panel"); await sleep(900);
    const groups = (await page.locator("[data-cs-group]").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
    const out = {};
    for (const semester of ["1", "2"]) {
      const button = page.locator("[data-cs-group]", { hasText: new RegExp(`현2 → 3학년 ${semester}학기 · 3-${semester} 택5`) }).first();
      if (!(await button.count())) { out[semester] = null; continue; }
      await button.click(); await sleep(700);
      const input = page.locator(`input[aria-label^="${COURSE}"][aria-label$="6단계 분반 수"]`).first();
      out[semester] = (await input.count()) ? Number(await input.inputValue()) : null;
    }
    return { groups: groups.filter((t) => t.startsWith("현2")), ...out };
  };
  const compare = async (semester, tag) => {
    const other = semester === "1" ? "2" : "1";
    await open4();
    const four = await read4();
    console.log(`[${tag}] 4단계:`, JSON.stringify(four), "|", (await text("#aggregateOpeningSourceNote")) || "(안내 없음)");
    check(four.length === 1 && four[0].head === `3학년 ${semester}학기`, `[${tag}] 4단계: 3학년 ${semester}학기 구역에만 있음`, JSON.stringify(four));
    const classes = four[0]?.classes;
    const five = await read5();
    console.log(`[${tag}] 5단계:`, JSON.stringify(five));
    check(classes > 0 && five[semester]?.classes === classes, `[${tag}] 5단계 3학년 ${semester}학기 ${COURSE} 개설반 = 4단계 ${classes}`, JSON.stringify(five));
    check(!five[other] || five[other].classes === 0, `[${tag}] 5단계 3학년 ${other}학기 ${COURSE}는 0(줄 없음)`, JSON.stringify(five));
    await shot(`${tag}-hours.png`);
    const six = await read6();
    console.log(`[${tag}] 6단계:`, JSON.stringify(six));
    check(six[semester] === classes, `[${tag}] 6단계 3학년 ${semester}학기 ${COURSE} 분반 수 = 4단계 ${classes}`, JSON.stringify(six));
    check(six[other] === null, `[${tag}] 6단계 3학년 ${other}학기 그룹에 ${COURSE} 없음`, JSON.stringify(six));
    await shot(`${tag}-sections.png`);
    return classes;
  };

  // 4단계: 고른 학기 구역 · 5·6단계가 읽는 차수 안내 ---------------------------------------
  await open4();
  await shot("02-aggregate.png");
  const before = await read4();
  console.log("반영 뒤 4단계:", JSON.stringify(before), "|", (await text("#aggregateOpeningSourceNote")) || "(안내 없음)");
  check(before.length === 1 && before[0].head === "3학년 2학기", "4단계: 고른 학기(3학년 2학기) 구역에만 있음", JSON.stringify(before));
  check(/5·6단계는 현 2학년 \d+차 확정 결과/.test(await text("#aggregateOpeningSourceNote")), "4단계: 5·6단계가 다른 차수(최근 확정 차수)를 읽는다고 안내", await text("#aggregateOpeningSourceNote"));
  if (before[0]?.closed) await decide("개설");  // 앞 차수(2차)에서 폐강한 2학기 과목이라 결정을 이어받음 → 교사가 개설로 바꿈
  console.log("3차 확정:", await confirmRound());
  if (DIAGNOSE) {
    const diag = await page.evaluate((course) => {
      const round = String(state.currentRound);
      const key = (name) => normalizeResultCourseName(name);
      const rows = (courseOpeningSnapshot(round)?.rows || []).filter((row) => row.grade === "2" && key(row.name) === key(course));
      return { round, source: courseOpeningRound("2"), rows };
    }, COURSE);
    console.log("진단:", JSON.stringify(diag));
  }
  await compare("2", "A");

  // 4단계에서 학기 바꾸기 ------------------------------------------------------------
  await open4();
  console.log("3차 확정 해제:", await unlockRound());
  await courseButton().click(); await sleep(300);
  const menu = page.locator("#aggregateCourseMenu");
  await shot("04-menu.png");
  const change = menu.getByRole("button", { name: "3학년 1학기로" });
  check(await change.count() > 0, "4단계 과목 메뉴에 '개설 학기 바꾸기 · 3학년 1학기로'가 있음", await menu.innerText().catch(() => ""));
  await change.click(); await sleep(400);
  console.log("학기 바꾸기 확인 창:", (await appOk()).replace(/\s+/g, " ").slice(0, 160));
  await sleep(1000);
  const moved = await read4();
  if (moved[0]?.closed) await decide("개설");
  console.log("3차 다시 확정:", await confirmRound());
  await compare("1", "B");
  return { fixture };
}

module.exports = { twoSemesterScenario, COURSE };
