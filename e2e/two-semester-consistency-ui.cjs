// 두 학기 편성 과목 한 열 결과 → 단계 간 일치 확인(사용자처럼 클릭, 가상 학생).
// 사용: node e2e/run.cjs --seed 10 --out /tmp/e2e10  →  node e2e/two-semester-consistency-ui.cjs /tmp/ts-ui /tmp/e2e10/downloads/workspace-backup.json.gz [--diagnose]
// 흐름: 백업 복원 → 2단계 외부 결과 방식 · 현 2학년 새 차수에 가로형 결과(심화 영어 한 열) 올림 → 미리보기 '개설 학기 선택'에서 2학기 고름 → 반영
//   → 4단계: 3학년 2학기 구역에만 심화 영어 · 개설 학급수 → 5단계 시수표 3학년 2학기 심화 영어 개설반이 같음 · 1학기 줄 없음
//   → 4단계 과목 메뉴 '개설 학기 바꾸기' → 1학기 → 5단계가 따라감. 화면 글자로 확인한다.
const path = require("path"), fs = require("fs");
const ROOT = path.join(__dirname, "..");
const globalRoot = require("child_process").execSync("npm root -g", { encoding: "utf8" }).trim();
const { chromium } = require(path.join(globalRoot, "playwright"));
const { startStaticServer } = require(path.join(ROOT, "e2e/lib/static-server.cjs"));
const { twoSemesterScenario } = require(path.join(ROOT, "e2e/lib/two-semester-scenario.cjs"));
const OUT = process.argv[2]; const BACKUP = process.argv[3]; const DIAGNOSE = process.argv.includes("--diagnose");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COURSE = "심화 영어";
const results = []; const check = (ok, what, detail = "") => { results.push({ ok: Boolean(ok), what, detail: String(detail).slice(0, 500) }); console.log(`${ok ? "✔" : "✘"} ${what}${ok ? "" : ` — ${String(detail).slice(0, 500)}`}`); };

(async () => {
  const { server, url } = await startStaticServer(ROOT);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: "ko-KR", acceptDownloads: true });
  await context.route(/supabase\.co|googleapis|gstatic/, (route) => route.abort());
  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => { if (["error"].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => d.type() === "prompt" ? d.accept("초기화") : d.accept());
  const shot = async (name) => page.screenshot({ path: path.join(OUT, name), fullPage: false });
  const text = (selector) => page.locator(selector).innerText().catch(() => "");
  const appOk = async () => { const ok = page.locator("#appConfirmDialog[open] #appConfirmOk"); if (await ok.count()) { const message = await text("#appConfirmDialog[open]"); await ok.click(); await sleep(400); return message; } return ""; };
  const gotoStep = async (internal, panel) => { await page.locator(`[data-workflow-step="${internal}"]`).first().click(); await page.locator(panel).waitFor({ state: "visible", timeout: 30000 }); await sleep(500); };
  await page.goto(url); await page.waitForLoadState("networkidle"); await sleep(1000);
  await page.locator("#workspaceDataMenu summary").click();
  const nav = page.waitForEvent("load", { timeout: 30000 }).catch(() => null);
  await page.locator("#restoreWorkspaceBackup").setInputFiles(BACKUP);
  await page.locator("#appConfirmDialog[open]").waitFor({ timeout: 15000 }).catch(() => {});
  console.log("복원 확인 창:", (await appOk()).replace(/\s+/g, " ").slice(0, 120));
  await nav; await sleep(2500);
  for (let i = 0; i < 3 && await page.locator("#appConfirmDialog[open]").count(); i++) console.log("시작 확인 창:", (await appOk()).replace(/\s+/g, " ").slice(0, 160));

  await twoSemesterScenario(page, { OUT, check, DIAGNOSE });
  check(!logs.some((line) => line.startsWith("pageerror")), "페이지 오류 없음", logs.join("\n"));
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ results, logs }, null, 1));
  console.log(`\n결과: ${results.filter((r) => r.ok).length}/${results.length} 통과`);
  await browser.close(); server.close();
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
})().catch((error) => { console.error(error); process.exit(2); });
