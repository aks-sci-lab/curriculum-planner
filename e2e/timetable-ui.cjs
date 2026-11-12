// 7단계 시간표 화면 확인(사용자처럼 클릭): 하네스 백업(가상 학생) 복원 → 메뉴 '7. 시간표'
// ① 사전 점검 결과(판정·원인·고칠 곳 단추·가정 목록·학년 표) ② 조건을 바꾸면 바로 다시 점검하고 '풀림/달라짐/새로 생김'을 보여 줌(교사 상한·창체 방식)
// ③ 교사 추가(강사) → 6단계 교사 명단에도 보임 ④ 반 일부만 듣는 과목(교차집중)의 반 배정 → 2학기는 맞바꿈, 틀린 값은 안내
// ⑤ '고칠 곳' 단추로 다른 단계 이동 ⑥ 새로고침 뒤에도 조건 유지 ⑦ 콘솔 오류 없음
// 사용: node e2e/run.cjs --seed 11 --out /tmp/e2e  →  node e2e/timetable-ui.cjs /tmp/tt-ui /tmp/e2e/downloads/workspace-backup.json.gz
const path = require("path"), fs = require("fs");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const { chromium } = require(path.join(globalRoot, "playwright"));
const { startStaticServer } = require(path.join(ROOT, "e2e/lib/static-server.cjs"));
const OUT = process.argv[2]; const BACKUP = process.argv[3];
if (!OUT || !BACKUP) { console.error("사용: node e2e/timetable-ui.cjs <출력 폴더> <백업 .json.gz>"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const report = { problems, checks: {} };
const check = (ok, message, detail) => { if (!ok) { problems.push({ message, detail }); console.log("  ✗", message, detail ? JSON.stringify(detail).slice(0, 500) : ""); } else console.log("  ✓", message); };
const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();

(async () => {
  const { server, url } = await startStaticServer(ROOT);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 }, locale: "ko-KR", deviceScaleFactor: 2 });
  await context.route(/supabase\.co|googleapis|gstatic/, (route) => route.abort());
  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => { if (m.type() === "error") logs.push(`error: ${m.text()}`); });
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  await page.goto(url); await page.waitForLoadState("networkidle"); await sleep(1000);
  await page.locator("#workspaceDataMenu summary").click();
  const nav = page.waitForEvent("load", { timeout: 30000 }).catch(() => null);
  await page.locator("#restoreWorkspaceBackup").setInputFiles(BACKUP);
  await page.locator("#appConfirmDialog[open] #appConfirmOk").click({ timeout: 10000 }).catch(() => {});
  await nav; await sleep(2500);
  const panel = page.locator("#workflowStep6Panel");
  const openStep = async () => { await page.getByRole("button", { name: /7\. 시간표/ }).click(); await panel.waitFor({ state: "visible" }); await sleep(500); };
  const issues = async () => panel.locator("#timetablePrecheck > ul .tt-issue").evaluateAll((els) => els.map((el) => ({ id: el.dataset.ttIssue, level: el.dataset.level, text: el.querySelector(".tt-cause").textContent.trim() })));
  const openSection = async (key) => { const d = panel.locator(`[data-tt-section="${key}"]`); if (!(await d.evaluate((el) => el.open))) { await d.locator("summary").click(); await sleep(200); } };

  console.log("▶ 메뉴·사전 점검 결과");
  await openStep();
  check(/7단계 · 시간표/.test(clean(await panel.locator("#timetableTitle").innerText())), "제목 '7단계 · 시간표' + 차수·학기 배지", clean(await panel.locator("#timetableTitle").innerText()));
  const verdict = clean(await panel.locator("#timetableVerdict").innerText());
  const first = await issues();
  report.checks.first = { verdict, issues: first };
  check(/필수 조건을 모두 지키는 시간표가 없습니다|사전 점검 통과|계산을 시작할 수 없습니다/.test(verdict), `판정 줄: ${verdict.slice(0, 60)}`);
  check(first.length > 0 && first.every((item) => item.text.length > 10), `사전 점검 항목 ${first.length}건(원인 문장)`);
  const whereCount = await panel.locator("#timetablePrecheck .tt-goto").count();
  check(whereCount >= first.length, `항목마다 '고칠 곳' 단추(${whereCount}개)`);
  const assumptions = await panel.locator("#timetableAssumptions .tt-cause").allInnerTexts();
  check(assumptions.length >= 5 && assumptions.some((text) => /점심/.test(text)), `가정 목록 ${assumptions.length}건`, assumptions);
  const grades = await panel.locator("#timetableGrades tbody tr").evaluateAll((rows) => rows.map((row) => [...row.children].map((cell) => cell.textContent.trim())));
  check(grades.length === 3 && grades.every((row) => Number(row[2]) === 35), "학년 표 3줄(주 35칸)", grades);
  await page.screenshot({ path: path.join(OUT, "01-timetable-precheck.png"), fullPage: true });

  console.log("▶ 조건을 바꾸면 바로 다시 점검");
  const music = first.find((item) => /음악: 교사 2명 × 22 = 44시간 < 이번 학기 수업 45시간/.test(item.text));
  check(Boolean(music), "처음: 음악 44시간 < 45시간(교사 상한 22)", first.map((item) => item.text));
  await openSection("rules");
  const max = panel.locator('[data-tt-field="rules.maxHours"]');
  await max.fill("23"); await max.press("Tab"); await sleep(400);
  const change = panel.locator("#timetableChange");
  const changeText = clean(await change.innerText());
  check(/방금 바꾼 조건: 교사 주당 시수 상한\(학기별\) → 23/.test(changeText) && /풀림/.test(changeText) && /음악/.test(changeText), "상한 23 → '풀림'에 음악", changeText.slice(0, 300));
  check(!(await issues()).some((item) => /^음악:/.test(item.text)), "점검 목록에서 음악 항목이 사라짐");
  check(/기본값 22에서 바꿈/.test(clean(await panel.locator('[data-tt-rule="maxHours"]').innerText())), "규칙 줄에 '기본값 22에서 바꿈'");
  await page.screenshot({ path: path.join(OUT, "02-rule-change.png"), fullPage: true });
  await panel.locator("#timetableRulesReset").click(); await sleep(400);
  check((await issues()).some((item) => /^음악:/.test(item.text)) && /새로 생김/.test(clean(await change.innerText())), "규칙을 기본값으로 → 음악 항목이 다시 생김('새로 생김')");
  // 창체 방식
  await openSection("time");
  const creativeBefore = clean(await panel.locator("#timetableCreative").innerText());
  await panel.getByRole("button", { name: "학년별로 놓기" }).click(); await sleep(400);
  const creativeAfter = clean(await panel.locator("#timetableCreative").innerText());
  check(/학년별 2·2·2시간/.test(creativeAfter) && (await panel.locator('[data-tt-field="creative.school"]').inputValue()) === "0", "창체 '학년별로 놓기' → 전교 동시 0 · 학년별 2·2·2", { creativeBefore, creativeAfter });
  check(!(await panel.locator("#timetableAssumptions .tt-cause").allInnerTexts()).some((text) => /^창체/.test(text)), "창체 가정이 사라짐");
  await panel.locator('[data-tt-field="creative.byGroup"]').check(); await sleep(300);
  check((await panel.getByRole("button", { name: "학년별 + 반군별 허용" }).getAttribute("aria-pressed")) === "true", "반군별 허용 체크 → 방식 단추 '학년별 + 반군별 허용' 눌림");
  await panel.getByRole("button", { name: /전교 동시\(6단계 고정 시간\)/ }).click(); await sleep(300);
  check((await panel.locator('[data-tt-field="creative.schoolTimes"]').inputValue()) === "금6,금7", "창체 '전교 동시' → 6단계 고정 시간 금6,금7");

  console.log("▶ 교사 추가(강사) → 6단계 명단과 한 곳");
  const liberal = (await issues()).find((item) => /^교양: 교사 1명 × 22 = 22시간 < 이번 학기 수업 33시간/.test(item.text));
  check(Boolean(liberal), "처음: 교양 1명 22시간 < 33시간");
  await openSection("teachers");
  await panel.locator("#timetableTeacherAdd").click(); await sleep(300);
  check(/이름을 넣어 주세요/.test(clean(await panel.locator("#timetableStatus").innerText())), "이름 없이 추가 → 안내");
  await panel.locator("#timetableTeacherName").fill("환경 강사");
  await panel.locator("#timetableTeacherKind").selectOption("강사");
  await panel.locator("#timetableTeacherDepartment").selectOption("교양");
  await panel.locator("#timetableTeacherDays").fill("화,목");
  await panel.locator("#timetableTeacherMax").fill("12");
  await panel.locator("#timetableTeacherAdd").click(); await sleep(500);
  const addedText = clean(await panel.locator("#timetableAddedTeachers").innerText());
  check(/환경 강사 · 강사 · .*출근 화·목 · 상한 12시간/.test(addedText), `추가한 교사 목록: ${addedText.slice(0, 80)}`);
  const afterAdd = await issues();
  const liberalNow = afterAdd.find((item) => /^교양:/.test(item.text));
  check(/교양: 교사 2명 합 34시간 ≥|^$/.test(liberalNow?.text || "") || !liberalNow, "교양 시수 부족이 풀림(22 + 12 = 34 ≥ 33)", liberalNow);
  check(/풀림|달라짐/.test(clean(await change.innerText())), "변경 요약에 풀림·달라짐");
  await page.screenshot({ path: path.join(OUT, "03-teacher-added.png"), fullPage: true });
  await page.getByRole("button", { name: /6\. 분반 편성/ }).click(); await page.locator("#workflowStep8Panel").waitFor({ state: "visible" }); await sleep(500);
  await page.locator("#classSectionsTeachersOpen").click(); await sleep(500);
  const dialogText = await page.locator("#classSectionsTeacherDialog").evaluate((el) => [...el.querySelectorAll("input")].map((input) => input.value).join("|"));
  check(/환경 강사/.test(dialogText), "6단계 '교사·시간 설정' 명단에 환경 강사가 보임");
  await page.keyboard.press("Escape"); await sleep(300);
  await page.locator("#classSectionsTeacherDialog[open] button", { hasText: /닫기|완료/ }).first().click({ timeout: 1500 }).catch(() => {});

  console.log("▶ 반 일부만 듣는 과목(교차집중) 반 배정");
  await openStep();
  await openSection("split");
  const split = panel.locator("[data-tt-split]").first();
  const splitBefore = clean(await split.innerText());
  check(/미술 ↔ 연극\(교차집중\)/.test(splitBefore) && /가정: 앞 반부터/.test(splitBefore) && /미술 1,2,3,4,5반 \/ 연극 6,7,8,9,10,11반/.test(splitBefore), "처음: 미술 1~5반 / 연극 6~11반(가정: 앞 반부터)", splitBefore);
  const splitInput = split.locator("input").first();
  await splitInput.fill("7-11"); await splitInput.press("Tab"); await sleep(400);
  const splitAfter = clean(await panel.locator("[data-tt-split]").first().innerText());
  check(/미술 7,8,9,10,11반 \/ 연극 1,2,3,4,5,6반/.test(splitAfter) && !/가정: 앞 반부터/.test(splitAfter), "미술 7-11 → 미술 7~11반 / 연극 1~6반, 가정 표시 사라짐", splitAfter);
  await page.locator('[data-tt-semester="2"]').click(); await sleep(400);
  await openSection("split");
  const splitSecond = clean(await panel.locator("[data-tt-split]").first().innerText());
  check(/이번 학기\(2학기\): 미술 1,2,3,4,5,6반 \/ 연극 7,8,9,10,11반/.test(splitSecond), "2학기는 맞바꿈: 미술 1~6반 / 연극 7~11반", splitSecond);
  check(/2학기/.test(clean(await panel.locator("#timetableRoundBadge").innerText())), "배지에 2학기");
  await page.locator('[data-tt-semester="1"]').click(); await sleep(400);
  await openSection("split");
  const bad = panel.locator("[data-tt-split]").first().locator("input").first();
  await bad.fill("1,2"); await bad.press("Tab"); await sleep(400);
  const splitBad = clean(await panel.locator("[data-tt-split]").first().innerText());
  check(/미술: 1학기 5반이어야 합니다\(지금 2반\)/.test(splitBad) && /가정: 앞 반부터/.test(splitBad), "반 수가 편제표와 다르면 안내하고 쓰지 않음", splitBad);
  const fix = panel.locator("[data-tt-split]").first().locator("input").first();
  await fix.fill("7-11"); await fix.press("Tab"); await sleep(300);
  await page.screenshot({ path: path.join(OUT, "04-split.png"), fullPage: true });

  console.log("▶ 고칠 곳 단추·새로고침");
  const gotoHours = panel.locator('#timetablePrecheck .tt-goto[data-tt-step="7"]').first();
  if (await gotoHours.count()) {
    await gotoHours.click(); await sleep(500);
    check(await page.locator("#workflowStep7Panel").isVisible(), "'고칠 곳: 5단계 …' 단추 → 5단계 화면");
  } else check(false, "5단계로 가는 '고칠 곳' 단추가 없음");
  await openStep();
  const gotoOwn = panel.locator('.tt-goto[data-tt-step="6"][data-tt-goto="rules"]').first();
  if (await gotoOwn.count()) { await gotoOwn.click(); await sleep(300); check(await panel.locator('[data-tt-section="rules"]').evaluate((el) => el.open), "'고칠 곳: 시간표 조건 · 규칙' → 규칙 영역이 열림"); }
  await sleep(600);
  await page.reload(); await page.waitForLoadState("networkidle"); await sleep(2500);
  await openStep();
  await openSection("split"); await openSection("teachers");
  check((await panel.locator("[data-tt-split]").first().locator("input").first().inputValue()) === "7-11", "새로고침 뒤에도 반 배정(7-11) 유지");
  check(/환경 강사/.test(clean(await panel.locator("#timetableAddedTeachers").innerText())), "새로고침 뒤에도 추가한 교사 유지");
  await panel.locator("[data-tt-teacher-remove]").first().click(); await sleep(400);
  check((await panel.locator("#timetableAddedTeachers").count()) === 0 && (await issues()).some((item) => /^교양: 교사 1명/.test(item.text)), "교사 삭제 → 교양 시수 부족이 다시 나옴");

  console.log("▶ 백업 → 전체 초기화 → 복원");
  await openSection("rules");
  const keep = panel.locator('[data-tt-field="rules.run"]');
  await keep.fill("4"); await keep.press("Tab"); await sleep(600);
  if (!(await page.locator("#downloadWorkspaceBackup").isVisible())) await page.locator("#workspaceDataMenu summary").click();
  const backupDownload = page.waitForEvent("download");
  await page.locator("#downloadWorkspaceBackup").click();
  const backupFile = path.join(OUT, "timetable-backup.json.gz");
  await (await backupDownload).saveAs(backupFile);
  page.removeAllListeners("dialog");
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "prompt") return dialog.accept("초기화");
    if (/백업 파일로 내려받을까요/.test(dialog.message())) return dialog.dismiss();
    return dialog.accept();
  });
  if (!(await page.locator("#resetWorkspaceAll").isVisible())) await page.locator("#workspaceDataMenu summary").click();
  const resetNav = page.waitForEvent("load", { timeout: 30000 }).catch(() => null);
  await page.locator("#resetWorkspaceAll").click();
  await resetNav; await sleep(1500);
  await openStep();
  await openSection("rules");
  check((await panel.locator('[data-tt-field="rules.run"]').inputValue()) === "3", "전체 초기화 뒤 시간표 조건이 기본값(연강 3)");
  await page.locator("#workspaceDataMenu summary").click();
  const restoreNav = page.waitForEvent("load", { timeout: 30000 }).catch(() => null);
  await page.locator("#restoreWorkspaceBackup").setInputFiles(backupFile);
  await page.locator("#appConfirmDialog[open] #appConfirmOk").click({ timeout: 5000 }).catch(() => {});
  await restoreNav; await sleep(2500);
  await openStep();
  await openSection("rules"); await openSection("split");
  check((await panel.locator('[data-tt-field="rules.run"]').inputValue()) === "4" && (await panel.locator("[data-tt-split]").first().locator("input").first().inputValue()) === "7-11", "백업 복원 뒤 시간표 조건(연강 4, 반 배정 7-11) 그대로");

  check(logs.length === 0, "콘솔 오류 없음", logs);
  report.logs = logs;
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
  await browser.close(); server.close?.();
  console.log(problems.length ? `문제 ${problems.length}건` : "모두 통과");
  process.exit(problems.length ? 1 : 0);
})();
