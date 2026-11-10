// 6단계 분반 편성 화면 확인(사용자처럼 클릭): 하네스 전체 실행이 남긴 백업(가상 학생)을 복원 → 6단계 편성·비교·교사·블록 시간·내보내기·새로고침.
// 사용: node e2e/run.cjs --seed 1 --out /tmp/e2e  →  node e2e/class-sections-ui.cjs /tmp/cs-ui /tmp/e2e/downloads/workspace-backup.json
const path = require("path"), fs = require("fs");
const ROOT = path.join(__dirname, "..");
const globalRoot = require("child_process").execSync("npm root -g", { encoding: "utf8" }).trim();
const { chromium } = require(path.join(globalRoot, "playwright"));
const { startStaticServer } = require(path.join(ROOT, "e2e/lib/static-server.cjs"));
const OUT = process.argv[2]; const BACKUP = process.argv[3];
fs.mkdirSync(path.join(OUT, "downloads"), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const { server, url } = await startStaticServer(ROOT);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: "ko-KR", acceptDownloads: true });
  await context.route(/supabase\.co|googleapis|gstatic/, (route) => route.abort());
  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => d.type() === "prompt" ? d.accept("초기화") : d.accept());
  const shot = async (name) => page.screenshot({ path: path.join(OUT, name), fullPage: true });
  const save = async (trigger, name) => { const dl = page.waitForEvent("download"); await trigger(); const file = path.join(OUT, "downloads", name); await (await dl).saveAs(file); return file; };
  await page.goto(url); await page.waitForLoadState("networkidle"); await sleep(1000);
  // 백업 복원
  await page.locator("#workspaceDataMenu summary").click();
  const nav = page.waitForEvent("load", { timeout: 30000 }).catch(() => null);
  await page.locator("#restoreWorkspaceBackup").setInputFiles(BACKUP);
  await nav; await sleep(2500);
  // 6단계
  await page.getByRole("button", { name: /6\. 분반 편성/ }).click();
  await sleep(800);
  const groups = await page.locator("[data-cs-group]").allInnerTexts();
  console.log("groups:", groups.map((t) => t.replace(/\s+/g, " ")));
  await shot("01-step6-start.png");
  // 담당 교과 기본값(편제표 교과군): 사회와 문화가 '기타'가 아닌지
  const deptOf = async (name) => page.getByLabel(`${name} 담당 교과`).evaluate((el) => el.options[el.selectedIndex]?.textContent || "");
  console.log("dept 사회와 문화:", await deptOf("사회와 문화").catch(() => "(없음)"));
  // 앞 편성이 없는 그룹에서 먼저 방식 비교 → 이동 수 '–'
  const fresh = page.locator("[data-cs-group]").filter({ hasText: "2-2 택3" }).first();
  if (await fresh.count()) {
    await fresh.click(); await sleep(300);
    await page.getByRole("button", { name: "방식 비교·추천" }).click();
    await page.getByText("편성 방식 비교", { exact: true }).waitFor({ timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector("#classSectionsSolve")?.disabled, null, { timeout: 60000 });
    console.log("fresh compare moved:", (await page.locator('section[aria-label="편성 방식 비교"] tbody td:nth-child(5)').allInnerTexts()).join(","),
      "|", await page.locator('section[aria-label="편성 방식 비교"] p.cs-note').last().innerText());
    await page.locator("[data-cs-group]").first().click(); await sleep(300);
  }
  // 기본 편성
  await page.getByRole("button", { name: "편성 계산" }).click();
  await page.locator("#classSectionsSummary").waitFor({ timeout: 60000 });
  console.log("summary1:", await page.locator("#classSectionsSummary").innerText());
  await shot("02-solved.png");
  // 방식 비교
  await page.getByRole("button", { name: "방식 비교·추천" }).click();
  await page.getByText("편성 방식 비교", { exact: true }).waitFor({ timeout: 60000 });
  await sleep(300);
  console.log("compare:", (await page.locator('section[aria-label="편성 방식 비교"]').innerText()).replace(/\s+/g, " ").slice(0, 400));
  await shot("03-compare.png");
  // 교사·시간 설정: 5단계 교사 수로 명단, 한 교사 불가 시간, 창체 고정
  await page.getByRole("button", { name: "교사·시간 설정" }).click();
  await page.getByRole("button", { name: "5단계 교사 수로 명단 만들기" }).click();
  await sleep(300);
  console.log("teachers from hours:", await page.locator("[data-cs-t$='|name']").count());
  // 물리 교사 3명(1명은 월1 육아시간) 직접 입력
  for (let i = 1; i <= 3; i++) {
    await page.getByRole("button", { name: "교사 추가" }).click(); await sleep(150);
    await page.getByLabel(`교사 ${i} 이름`).fill(`물리${i}`); await page.getByLabel(`교사 ${i} 이름`).press("Tab"); await sleep(100);
    await page.getByLabel(`교사 ${i} 담당 교과`).selectOption("과학-물리"); await sleep(150);
  }
  await page.locator("[data-cs-t-grid]").first().click(); await sleep(150);
  await page.getByLabel("물리1 월요일 1교시 불가").check(); await sleep(150);
  await page.getByLabel("교사 1 불가 사유").fill("육아시간"); await page.getByLabel("교사 1 불가 사유").press("Tab");
  console.log("teachers:", await page.locator("[data-cs-t$='|name']").count());
  await page.getByRole("button", { name: "창체·진로 금 6·7교시 넣기" }).click();
  await sleep(300);
  await page.locator("#classSectionsTeacherDialog").screenshot({ path: path.join(OUT, "04-teachers.png") });
  await page.getByRole("button", { name: "닫기" }).first().click();
  // 블록 시간 입력
  await page.getByText("블록별로 다르게 · 블록 시간(요일·교시)").click();
  const times = ["월1,수2,금3", "화1,목2,금4", "월3,수4,목5", "화3,목4,수5", "월5,화5,목6"];
  const blockInputs = page.locator("[data-cs-block-times]");
  for (let i = 0; i < await blockInputs.count(); i++) { await blockInputs.nth(i).fill(times[i] || ""); await blockInputs.nth(i).press("Tab"); }
  await sleep(300);
  console.log("stale badge:", await page.locator("#classSectionsStale").count());
  await page.getByRole("button", { name: "편성 계산" }).click();
  await sleep(500);
  await page.waitForFunction(() => !document.querySelector("#classSectionsSolve")?.disabled, null, { timeout: 60000 });
  console.log("summary2:", await page.locator("#classSectionsSummary").innerText());
  console.log("physics teachers:", await page.locator('[data-cs-teacher^="물리학"]').evaluateAll((els) => els.map((el) => el.closest("li").querySelector("strong").textContent + "=" + el.options[0].textContent)));
  await shot("05-solved-with-teachers.png");
  // 다른 그룹(현2 3학년 1학기)도 편성
  const groupButtons = page.locator("[data-cs-group]");
  for (let i = 1; i < await groupButtons.count(); i++) {
    await groupButtons.nth(i).click(); await sleep(300);
    await page.getByRole("button", { name: "편성 계산" }).click(); await sleep(500);
    await page.waitForFunction(() => !document.querySelector("#classSectionsSolve")?.disabled, null, { timeout: 60000 });
    console.log(`group ${i}:`, (await groupButtons.nth(i).innerText()).replace(/\s+/g, " "), "|", await page.locator("#classSectionsSummary").innerText());
  }
  await shot("06-other-group.png");
  // 전 학년 함께 다시 계산(1학기 그룹 3개)
  await groupButtons.first().click(); await sleep(300);
  await page.getByRole("button", { name: "전 학년 함께 다시 계산" }).click(); await sleep(500);
  await page.waitForFunction(() => !document.querySelector("#classSectionsSolve")?.disabled, null, { timeout: 120000 });
  console.log("solve semester:", await page.locator("#classSectionsStatus").innerText(), "|", await page.locator("#classSectionsSummary").innerText());
  // 학급 단위로 바꾸면 블록 수 제안
  const five = page.locator("[data-cs-group]").filter({ hasText: "3-1 택5" }).first();
  await five.click(); await sleep(300);
  const firstCourse = await page.locator("[data-cs-mode]").first().getAttribute("data-cs-mode");
  await page.getByLabel(`${firstCourse} 운영 방식`).selectOption("class"); await sleep(400);
  console.log("blocks hint:", await page.locator("#classSectionsBlocksHint").innerText().catch(() => "(없음)"), "| blocks =", await page.getByLabel("블록 수").inputValue());
  await page.locator("#workflowStep8Panel").screenshot({ path: path.join(OUT, "08-class-unit-hint.png") });
  await page.getByLabel(`${firstCourse} 운영 방식`).selectOption("move"); await sleep(300);
  await groupButtons.first().click(); await sleep(300);
  // 학생 찾기
  await groupButtons.first().click(); await sleep(300);
  await page.getByLabel("학생 찾기(현학년-반-번호)").fill("1-1-1"); await page.getByLabel("학생 찾기(현학년-반-번호)").press("Enter");
  await sleep(300);
  console.log("lookup:", (await page.locator(".cs-lookup").innerText().catch(() => "")).replace(/\s+/g, " "));
  // 내보내기
  const files = [];
  files.push(await save(() => page.getByRole("button", { name: "블록표 엑셀" }).click(), "blocks.xlsx"));
  files.push(await save(() => page.getByRole("button", { name: "분반 명렬표 엑셀" }).click(), "rosters.xlsx"));
  files.push(await save(() => page.getByRole("button", { name: "나이스 편성 엑셀" }).click(), "neis.xlsx"));
  files.push(await save(() => page.getByRole("button", { name: "내년 반 배정표 양식" }).click(), "classmap-template.xlsx"));
  // 내년 반 배정표(가상: 현 반 그대로, 번호 +100) 올린 뒤 나이스 다시
  const { writeXlsx } = require(path.join(ROOT, "e2e/lib/xlsx-write.cjs"));
  const mapRows = [["현 학년", "현 반", "현 번호", "새 반", "새 번호"]];
  for (let c = 1; c <= 11; c++) for (let n = 1; n <= 30; n++) mapRows.push(["1", String(c), String(n), String(((c % 11) + 1)), String(n)]);
  const mapFile = path.join(OUT, "classmap.xlsx");
  const written = writeXlsx([{ name: "내년 반 배정", rows: mapRows }]);
  if (written) fs.writeFileSync(mapFile, written);
  await page.locator("#classSectionsClassMap").setInputFiles(mapFile); await sleep(800);
  console.log("classmap status:", await page.locator("#classSectionsStatus").innerText());
  files.push(await save(() => page.getByRole("button", { name: "나이스 편성 엑셀" }).click(), "neis-mapped.xlsx"));
  console.log("downloads:", files.map((f) => `${path.basename(f)} ${fs.statSync(f).size}B`));
  // 새로고침 뒤 결과 유지
  await page.reload(); await page.waitForLoadState("networkidle"); await sleep(2500);
  const step6Visible = await page.locator("#workflowStep8Panel").isVisible();
  console.log("after reload step6 visible:", step6Visible, "summary:", await page.locator("#classSectionsSummary").innerText().catch(() => "(none)"));
  await shot("07-after-reload.png");
  console.log("console:", logs.slice(0, 20));
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
