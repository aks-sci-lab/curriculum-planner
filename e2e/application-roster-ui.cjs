// 웹 신청 명렬 로컬 저장 화면 확인(사용자처럼 클릭): 하네스 실행(모의 서버로 웹 신청 생성)이 남긴 백업을 복원 →
// 2단계 웹 신청 화면에 '이 PC에 저장한 명렬 n명' → 새로 고침 뒤에도 남음 → '명렬 다시 올리기'(서버 요청 없이)로 바꿈.
// 사용: node e2e/run.cjs --seed 10 --out /tmp/e2e  →  node e2e/application-roster-ui.cjs /tmp/roster-ui /tmp/e2e
const path = require("path"), fs = require("fs");
const ROOT = path.join(__dirname, "..");
const globalRoot = require("child_process").execSync("npm root -g", { encoding: "utf8" }).trim();
const { chromium } = require(path.join(globalRoot, "playwright"));
const { startStaticServer } = require(path.join(ROOT, "e2e/lib/static-server.cjs"));
const OUT = process.argv[2]; const RUN = process.argv[3];
const BACKUP = path.join(RUN, "downloads", "workspace-backup.json.gz");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, text, actual) => { console.log(`${ok ? "ok  " : "FAIL"} ${text}${ok ? "" : ` → ${JSON.stringify(actual)}`}`); if (!ok) failures.push(text); };
(async () => {
  const { server, url } = await startStaticServer(ROOT);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, locale: "ko-KR" });
  const outside = [];
  await context.route(/supabase\.co|googleapis|gstatic/, (route) => { outside.push(route.request().url()); route.abort(); });
  const page = await context.newPage();
  const logs = [];
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => d.type() === "prompt" ? d.accept("초기화") : d.accept());
  await page.goto(url); await page.waitForLoadState("networkidle"); await sleep(1000);
  await page.locator("#workspaceDataMenu summary").click();
  const nav = page.waitForEvent("load", { timeout: 30000 }).catch(() => null);
  await page.locator("#restoreWorkspaceBackup").setInputFiles(BACKUP);
  await page.locator("#appConfirmDialog[open] #appConfirmOk").click({ timeout: 10000 }).catch(() => {}); // 백업 복원은 앱 확인 창으로 묻는다
  await nav; await sleep(2500);
  const open2 = async (grade) => {
    await page.getByRole("button", { name: /^2\. 수강신청/ }).first().click(); await sleep(500);
    await page.locator(`#applicationGrade${grade}Tab`).click(); await sleep(400);
    await page.locator("#applicationOnlineTab").click().catch(() => {}); await sleep(300);
  };
  const summary = () => page.evaluate(() => document.getElementById("cloudRosterLocalSummary")?.textContent || "");
  const counts = await page.evaluate(() => ({ "1": applicationRosterFor("1")?.students.length || 0, "2": applicationRosterFor("2")?.students.length || 0 }));
  console.log("saved rosters:", counts);
  check(counts["1"] > 0 && counts["2"] > 0, "웹 신청을 만들 때 올린 명렬이 학년별로 이 PC에 저장됨(백업에 포함)", counts);
  await open2("2");
  const text2 = await summary();
  console.log("summary:", text2);
  check(new RegExp(`이 PC에 저장한 현 2학년 명렬: ${counts["2"]}명`).test(text2), "2단계 웹 신청 화면에 저장한 명렬 인원", text2);
  await page.screenshot({ path: path.join(OUT, "01-roster-saved.png"), fullPage: false });
  // 새로 고침 뒤에도 남음
  await page.reload(); await page.waitForLoadState("networkidle"); await sleep(2500);
  const after = await page.evaluate(() => applicationRosterFor("2")?.students.length || 0);
  check(after === counts["2"], "새로 고침 뒤에도 명렬이 남음", after);
  // 다시 올리기(로그인 없이, 서버 요청 없이): 하네스가 만든 현 1학년 명렬 파일
  await open2("1");
  const before = outside.length;
  const file = path.join(RUN, "roster-grade1.xlsx");
  await page.locator("#cloudRosterLocalInput").setInputFiles(file); await sleep(1200);
  const text1 = await summary();
  console.log("re-upload:", text1);
  check(/^현 1학년 명렬 \d+명을 이 PC에 저장했습니다\(서버 변경 없음\)/.test(text1), "명렬 다시 올리기 → 저장 안내", text1);
  check(outside.length === before, "다시 올리기는 서버 요청 없음", outside.slice(before));
  const source = await page.evaluate(() => applicationRosterFor("1")?.source || "");
  check(/다시 올림/.test(source), "다시 올린 명렬로 바뀜", source);
  await page.screenshot({ path: path.join(OUT, "02-roster-reuploaded.png"), fullPage: false });
  check(!logs.length, "페이지 오류 없음", logs);
  await browser.close(); server.close();
  console.log(failures.length ? `실패 ${failures.length}건` : "모두 통과");
  process.exit(failures.length ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
