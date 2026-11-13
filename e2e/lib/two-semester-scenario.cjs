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
    // 추천 = 앞 차수 4단계 결과(그 학년 결과가 있는 가장 가까운 확정·집계 차수)가 먼저, 없으면 이웃 열·학생별 추정.
    check(/추천 [12]학기 · 아직 고르지 않음/.test(boxText) && /추천 근거: (앞 차수\(\d+차\) [12]학기(만 개설| 폐강)|학생별 추정 1학기 \d+명 · 2학기 \d+명)/.test(boxText), "추천값과 추천 근거를 함께 보여 줌", boxText);
  }
  // 고르지 않고 '결과 반영' → '개설 학기 확인' 창 → '돌아가서 고르기'(반영 안 함)
  await page.locator("#confirmResultImport").click(); await sleep(500);
  const askTitle = await text("#appConfirmDialog[open] #appConfirmTitle");
  const askText = await text("#appConfirmDialog[open] #appConfirmText");
  check(askTitle === "개설 학기 확인" && new RegExp(`${COURSE} → 3학년 [12]학기\\(추천 · `).test(askText), "학기를 고르지 않고 반영하면 '개설 학기 확인' 창이 묻는다", `${askTitle} | ${askText}`);
  await shot("01b-ask.png");
  if (await page.locator("#appConfirmDialog[open] #appConfirmCancel").count()) await page.locator("#appConfirmDialog[open] #appConfirmCancel").click();
  await sleep(500);
  check(await page.locator("#resultImportPreview:not(.hidden) #resultSemesterPicks").count() === 1 && !/반영했습니다/.test(await text("#status")), "'돌아가서 고르기'면 반영하지 않고 미리보기에 남음", await text("#status"));
  // 고르기: 1학기 → 2학기(바꿀 때마다 저장하고 다시 검증)
  await page.getByRole("radio", { name: `${COURSE} 1학기` }).check(); await sleep(700);
  await page.getByRole("radio", { name: `${COURSE} 2학기` }).check(); await sleep(700);
  const picked = await text("#resultSemesterPicks");
  check(/고름/.test(picked) && await page.getByRole("radio", { name: `${COURSE} 2학기` }).isChecked(), "고른 학기가 표시됨(고름)", picked);
  // 섞지 않음: 과목별 신청 인원 표에 심화 영어는 2학기 한 줄, 신청 학생 전부.
  await page.locator("#resultImportPreview details.result-import-compare").evaluate((details) => { details.open = true; }).catch(() => {});
  await sleep(200);
  const compareRows = (await page.locator("#resultImportPreview .result-import-table tbody tr").allInnerTexts()).map((row) => row.replace(/\s+/g, " ").trim()).filter((row) => row.startsWith(COURSE));
  // 표: 과목 · 학기 · 기존(복사해 온 앞 차수) · 새 결과 · 변화 — 새 결과가 있는 줄만 본다.
  const filled = compareRows.filter((row) => Number(row.split(" ").at(-2)) > 0);
  check(filled.length === 1 && /2학기/.test(filled[0]) && filled[0].includes(String(fixture.firstCount + fixture.secondCount)), `한 번만 나온 과목은 학생별로 섞지 않고 2학기 한 줄(${fixture.firstCount + fixture.secondCount}명)`, JSON.stringify(compareRows));
  await page.locator("#confirmResultImport").click(); await sleep(500);
  const confirmText = await appOk();
  check(!/개설 학기 확인/.test(confirmText), "고른 뒤에는 '개설 학기 확인' 창 없이 반영", confirmText);
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
  // 5단계 2·3학년 선택과목 개설반 = 4단계 연동 값 단추(입력 상자 아님, 이름표 '3학년 2학기 심화 영어 개설반 6 — 4단계에서 고치기').
  const hoursCell = (semester) => page.locator(`#workflowStep7Panel .hours-form [aria-label^="3학년 ${semester}학기 ${COURSE} 개설반"]`).first();
  const read5 = async () => {
    await gotoStep(7, "#workflowStep7Panel"); await sleep(900);
    const out = {};
    for (const semester of ["1", "2"]) {
      const cell = hoursCell(semester);
      if (!(await cell.count())) { out[semester] = null; continue; }
      const tag = await cell.evaluate((element) => element.tagName);
      out[semester] = { classes: Number(tag === "INPUT" ? await cell.inputValue() : (await cell.innerText()).trim()), tag, title: await cell.getAttribute("title") };
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
    check(five[semester]?.tag === "BUTTON" && /4단계 연동/.test(five[semester]?.title || ""), `[${tag}] 5단계 선택과목 개설반은 입력 상자가 아니라 4단계 연동 값`, JSON.stringify(five));
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
  // 차수별 흐름 분리: 5·6단계도 맨 위 차수(지금 이 차수)를 읽는다. 확정 전이면 맨 위 '근거' 줄에 '미확정'만 보인다.
  const viewRound = (await text("#roundConfirmState")).match(/(\d+)차/)?.[1] || "";
  check(!(await text("#aggregateOpeningSourceNote")), "4단계: '다른 차수를 읽는다' 안내 없음(5·6단계도 같은 차수)", await text("#aggregateOpeningSourceNote"));
  if (before[0]?.closed) await decide("개설");
  {
    const draft4 = (await read4())[0]?.classes;
    const draft5 = await read5();
    const basis5 = await text("#workflowStep7Panel .round-basis-line");
    check(new RegExp(`^근거: ${viewRound}차 · .*현2: ${viewRound}차 결과\\(미확정\\)`).test(basis5.replace(/\s+/g, " ")), `5단계 맨 위 근거 줄이 '${viewRound}차 · 현2: ${viewRound}차 결과(미확정)'`, basis5);
    check(draft5["2"]?.classes === draft4 && draft4 > 0, `확정 전에도 5단계 3학년 2학기 ${COURSE} 개설반 = 4단계 ${draft4}(그 차수 값)`, JSON.stringify(draft5));
    await shot("02b-hours-draft.png");
    await gotoStep(8, "#workflowStep8Panel"); await sleep(700);
    const basis6 = await text("#workflowStep8Panel .round-basis-line");
    check(basis6.replace(/\s+/g, " ") === basis5.replace(/\s+/g, " "), "6단계 맨 위 근거 줄도 같은 차수", `${basis6} | ${basis5}`);
    await open4();
  }  // 새 차수는 직전 차수(2차)를 복사하므로 그 차수에서 폐강한 2학기 과목 결정도 복사돼 있음 → 교사가 개설로 바꿈
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

  // 5단계에서 선택과목 칸을 누르면 4단계 그 과목 칸으로 · 학교 지정 과목은 직접 입력 ----------------------------------
  {
    await read5();
    // 학교 지정 과목 개설반은 편제표 × 학급 수 연동(읽기 전용 값 단추 → 학급 수 칸 또는 1단계 편제표), 입력 상자가 아니다.
    const designated = page.locator('#workflowStep7Panel .hours-form button.hf-link[data-hours-goto-classes="2"], #workflowStep7Panel .hours-form button.hf-link[data-hours-cross]').first();
    const designatedLabel = (await designated.count()) ? await designated.getAttribute("aria-label") : "";
    const designatedInputs = await page.locator('#workflowStep7Panel .hours-form input[aria-label^="2학년 1학기 "][aria-label$=" 개설반"]').count();
    check(/^2학년 \d학기 .+ 개설반 \d+ — /.test(designatedLabel) && designatedInputs === 0, `학교 지정 과목 개설반은 편제표 연동 값 단추(${designatedLabel})`, `${designatedLabel} · 입력 상자 ${designatedInputs}개`);
    await hoursCell("2").click(); await sleep(900);
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") || "");
    // 확정된 차수는 개설 학급수 칸이 잠겨 있어 그 과목 이름 단추(개설/폐강 메뉴)에 초점이 간다.
    check(await page.locator("#aggregatePanel").isVisible() && (new RegExp(`^3학년 2학기 ${COURSE}.* 개설 학급수`).test(focused) || new RegExp(`^${COURSE}.* — 개설/폐강/미정 결정`).test(focused)),
      "5단계 선택과목 칸을 누르면 4단계 그 과목 칸으로 감", focused);
    await shot("05b-goto4.png");
  }

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

  // 다음 차수에 같은 파일(한 열): 앞 차수(지금 확정한 차수) 4단계 결과로 추천 — 1학기만 개설 ------------------------
  const addRoundAndUpload = async (uploadFile) => {
    await gotoStep(2, "#workflowStep2Panel");
    await page.locator("#applicationGrade2Tab").click(); await sleep(300);
    await page.locator("#applicationResultsTab").click();
    await page.locator("#addApplicationRound").click(); await sleep(500);
    const added = await text("#status");
    await page.locator("#rosterInput").setInputFiles(uploadFile);
    await page.locator("#resultImportPreview:not(.hidden)").waitFor({ timeout: 30000 });
    await sleep(300);
    return added;
  };
  const added = await addRoundAndUpload(file);
  const previousRound = added.match(/(\d+)차를 추가/)?.[1] ? String(Number(added.match(/(\d+)차를 추가/)[1]) - 1) : "";
  const nextBox = await text("#resultSemesterPicks");
  console.log("다음 차수 개설 학기 선택:", nextBox.replace(/\s+/g, " "));
  check(new RegExp(`추천 1학기 · 아직 고르지 않음`).test(nextBox) && nextBox.includes(`앞 차수(${previousRound}차) 1학기만 개설`), `다음 차수 파일에 한 열만 나오면 앞 차수(${previousRound}차) 4단계 결과를 추천(앞 차수 고른 값을 그대로 쓰지 않음)`, nextBox);
  await shot("07-next-round.png");
  await page.locator("#cancelResultImport").click(); await sleep(300);

  // 머리글 '3-2 택5'(병합 머리글)가 있는 파일: 묻지 않고 2학기 + 근거 ------------------------------------
  const at = fixture.rows[1].indexOf(COURSE);
  const groupRow = fixture.rows[1].map(() => "");
  groupRow[4] = "3-1 택5"; groupRow[at] = "3-2 택5";
  const letter = (index) => String.fromCharCode(65 + index);
  const headerFile = path.join(OUT, "result-two-semester-header.xlsx");
  fs.writeFileSync(headerFile, writeXlsx([{ name: "결과", rows: [fixture.rows[0], groupRow, ...fixture.rows.slice(1)], merges: [`${letter(4)}2:${letter(at - 1)}2`, `${letter(at)}2:${letter(at + 10)}2`] }]));
  await page.locator("#rosterInput").setInputFiles(headerFile);
  await page.locator("#resultImportPreview:not(.hidden)").waitFor({ timeout: 30000 });
  await sleep(300);
  const headerBox = await text("#resultSemesterPicks");
  console.log("머리글 표시 파일:", headerBox.replace(/\s+/g, " "));
  check(!(await page.locator(`#resultSemesterPicks input[data-semester-pick]`).count()) && headerBox.includes(`머리글 표시 '3-2 택5' → 2학기`), "머리글 학기·그룹 표시가 있으면 묻지 않고 근거만 보여 줌", headerBox);
  await shot("08-header.png");
  await page.locator("#confirmResultImport").click(); await sleep(500);
  const headerAsk = await text("#appConfirmDialog[open] #appConfirmTitle");
  check(headerAsk !== "개설 학기 확인", "머리글 표시 파일은 반영할 때도 '개설 학기 확인' 창 없음", headerAsk);
  if (headerAsk) await page.locator("#appConfirmDialog[open] #appConfirmCancel").click();
  else await sleep(800);

  // 맨 위 '결과 차수'를 바꾸면 4·5단계가 함께 그 차수를 따른다(차수별 흐름 분리) ------------------------------------------
  {
    const options = await page.locator("#workspaceRound option").evaluateAll((list) => list.map((option) => option.value));
    for (const round of options.slice(-3)) {
      await page.locator("#workspaceRound").selectOption(round); await sleep(900);
      await open4();
      const four = await read4();
      const five = await read5();
      const basis = (await text("#workflowStep7Panel .round-basis-line")).replace(/\s+/g, " ");
      const same = ["1", "2"].every((semester) => (four.find((item) => item.head === `3학년 ${semester}학기`)?.classes || 0) === (five[semester]?.classes || 0));
      check(basis.startsWith(`근거: ${round}차`) && same, `맨 위 차수 ${round}차: 5단계 근거 줄·${COURSE} 개설반 = 4단계`, `${basis} | 4단계 ${JSON.stringify(four)} | 5단계 ${JSON.stringify(five)}`);
    }
  }
  return { fixture };
}

module.exports = { twoSemesterScenario, COURSE };
