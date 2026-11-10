// 6단계 담임반 '명렬 올리기' 클릭 확인: 하네스 백업에서 현2 명렬만 지운 사본을 복원 → 담임반별 '미제출 확인 불가'
// → '명렬 올리기(이 PC에만 저장)'로 하네스 합성 명렬(roster-grade2.xlsx, 영문 파일명) → 현2 담임반 합 305 → 308.
// 사용: node e2e/run.cjs --seed 10 --out /tmp/e2e → node e2e/class-sections-roster-ui.cjs <폴더> /tmp/e2e/downloads/workspace-backup.json.gz /tmp/e2e/roster-grade2.xlsx
const path = require("path"), fs = require("fs");
const ROOT = path.join(__dirname, "..");
const globalRoot = require("child_process").execSync("npm root -g", { encoding: "utf8" }).trim();
const { chromium } = require(path.join(globalRoot, "playwright"));
const { startStaticServer } = require(path.join(ROOT, "e2e/lib/static-server.cjs"));
const [OUT, SOURCE, ROSTER] = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
// 현2 명렬을 지운 백업 사본(가상 학생, OUT에만 둠)
const raw = fs.readFileSync(SOURCE);
const backup = JSON.parse((raw[0] === 0x1f && raw[1] === 0x8b ? require("zlib").gunzipSync(raw) : raw).toString());
for (const year of Object.keys(backup.workspace.applicationRosters || {})) delete backup.workspace.applicationRosters[year]["2"];
const BACKUP = path.join(OUT, "backup-without-grade2-roster.json");
fs.writeFileSync(BACKUP, JSON.stringify(backup));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const { server, url } = await startStaticServer(ROOT);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: "ko-KR" });
  await context.route(/supabase\.co|googleapis|gstatic/, (route) => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(url); await page.waitForLoadState("networkidle"); await sleep(1000);
  await page.locator("#workspaceDataMenu summary").click();
  const nav = page.waitForEvent("load", { timeout: 30000 }).catch(() => null);
  await page.locator("#restoreWorkspaceBackup").setInputFiles(BACKUP);
  await sleep(800);
  const ok = page.locator("#appConfirmDialog button", { hasText: /복원|확인|불러오기/ });
  if (await ok.count()) await ok.first().click().catch(() => {});
  await nav; await sleep(2500);
  await page.getByRole("button", { name: /6\. 분반 편성/ }).click(); await sleep(800);
  await page.getByLabel("출석부 보기 범위").selectOption("homeroom"); await sleep(600);
  const options = await page.getByLabel("담임반 고르기").locator("option").allInnerTexts();
  const idx = options.findIndex((text) => /내년 3학년|현 2학년/.test(text));
  await page.getByLabel("담임반 고르기").selectOption({ index: idx }); await sleep(600);
  const before = await page.locator("#classSectionsHomeroomUnsubmitted").innerText();
  const total = async () => (await page.getByLabel("담임반 고르기").locator("option").allInnerTexts())
    .filter((text) => /내년 3학년|현 2학년/.test(text)).reduce((n, text) => n + Number(text.match(/\((\d+)명/)?.[1] || 0), 0);
  const sumBefore = await total();
  const hasInput = await page.locator("#classSectionsRosterInput").count();
  await page.locator("#classSectionsAttendanceView").screenshot({ path: path.join(OUT, "roster-before.png") });
  if (hasInput) await page.locator("#classSectionsRosterInput").setInputFiles(ROSTER);
  await sleep(1500);
  const after = await page.locator("#classSectionsHomeroomUnsubmitted").innerText();
  const status = await page.locator("#classSectionsStatus").innerText().catch(() => "");
  const sumAfter = await total();
  await page.locator("#classSectionsAttendanceView").screenshot({ path: path.join(OUT, "roster-after.png") });
  const result = { before: before.slice(0, 160), hasInput, sumBefore, after, status, sumAfter, errors };
  console.log(JSON.stringify(result, null, 1));
  const pass = /미제출 확인 불가/.test(before) && hasInput === 1 && sumBefore === 305 && sumAfter === 308 && /명렬 .*기준/.test(after) && /저장했습니다/.test(status) && !errors.length;
  console.log(pass ? "PASS" : "FAIL");
  await browser.close(); server.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
