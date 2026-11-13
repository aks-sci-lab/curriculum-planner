// 6단계 '이동수업 그룹 합치기' 화면 확인(사용자처럼 클릭): 하네스 백업 복원 → 6단계 → 합치기 켜기(현2 → 3학년 1학기 택5 + 택1) →
// 합친 그룹(블록 6개·과목 모두 이동) → 편성 계산 → 블록표·명렬·나이스 내보내기 → 전 학년 함께 다시 계산 → 끄기 → 그룹마다 예전 결과 그대로 → 다시 켜면 합친 결과 그대로.
// 사용: node e2e/run.cjs --seed 11 --out /tmp/e2e  →  node e2e/class-sections-merge-ui.cjs /tmp/cs-merge /tmp/e2e/downloads/workspace-backup.json.gz
const path = require("path"), fs = require("fs");
const ROOT = path.join(__dirname, "..");
const globalRoot = require("child_process").execSync("npm root -g", { encoding: "utf8" }).trim();
const { chromium } = require(path.join(globalRoot, "playwright"));
const { startStaticServer } = require(path.join(ROOT, "e2e/lib/static-server.cjs"));
const OUT = process.argv[2]; const BACKUP = process.argv[3];
fs.mkdirSync(path.join(OUT, "downloads"), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, text, actual) => { console.log(`${ok ? "ok  " : "FAIL"} ${text}${ok ? "" : ` → ${JSON.stringify(actual)}`}`); if (!ok) failures.push(text); };
const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
(async () => {
  const { server, url } = await startStaticServer(ROOT);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: "ko-KR", acceptDownloads: true });
  await context.route(/supabase\.co|googleapis|gstatic/, (route) => route.abort());
  const page = await context.newPage();
  const logs = [];
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") logs.push(`console: ${m.text().slice(0, 200)}`); });
  const shot = async (name) => page.screenshot({ path: path.join(OUT, name), fullPage: true });
  const status = async () => clean(await page.locator("#classSectionsStatus").innerText().catch(() => ""));
  const groups = () => page.locator("[data-cs-group]").evaluateAll((els) => els.map((e) => ({ key: e.dataset.csGroup, text: e.innerText.replace(/\s+/g, " ").trim(), active: e.getAttribute("aria-pressed") === "true" })));
  const summary = async () => ({ feasible: await page.locator("#classSectionsSummary").getAttribute("data-feasible").catch(() => null), text: clean(await page.locator("#classSectionsSummary").innerText().catch(() => "")) });
  const solve = async (button = "#classSectionsSolve") => {
    await page.locator(button).click(); await sleep(300);
    await page.waitForFunction(() => !document.querySelector("#classSectionsSolve")?.disabled, null, { timeout: 300000, polling: 300 });
    await sleep(500);
  };
  const exportSheets = async (id, name) => {
    const dl = page.waitForEvent("download", { timeout: 30000 });
    await page.locator(id).click();
    await page.locator("#appConfirmDialog[open] #appConfirmOk").click({ timeout: 1500 }).catch(() => {});
    const file = path.join(OUT, "downloads", `${name}.xlsx`);
    await (await dl).saveAs(file);
    return page.evaluate(async (bytes) => (await parseWorkbook(new Uint8Array(bytes).buffer)).map((sheet) => ({ name: sheet.name, rows: sheet.rows })), [...fs.readFileSync(file)]);
  };

  await page.goto(url); await page.waitForLoadState("networkidle"); await sleep(1000);
  await page.locator("#workspaceDataMenu summary").click();
  const nav = page.waitForEvent("load", { timeout: 30000 }).catch(() => null);
  await page.locator("#restoreWorkspaceBackup").setInputFiles(BACKUP);
  await page.locator("#appConfirmDialog[open] #appConfirmOk").click({ timeout: 10000 }).catch(() => {});
  await nav; await sleep(2500);
  await page.getByRole("button", { name: /6\. 분반 편성/ }).click(); await sleep(800);
  await page.locator("#workspaceRound").selectOption("2").catch(() => {}); await sleep(600);

  console.log("▶ 합치기 줄(기본 꺼짐)");
  const before = await groups();
  const ids = await page.locator("[data-cs-merge]").evaluateAll((els) => els.map((e) => ({ id: e.dataset.csMerge, on: e.checked, text: e.parentElement.innerText.replace(/\s+/g, " ").trim() })));
  check(ids.some((item) => item.id === "2:1" && !item.on && /현2 → 3학년 1학기 \(3-1 택5 \+ 3-1 택1\)/.test(item.text)) && ids.every((item) => !item.on), "그룹이 둘 이상인 학기마다 합치기 체크(기본 꺼짐)", ids);
  check(/편제표·4단계 집계는 바뀌지 않고/.test(clean(await page.locator("#classSectionsMerge").innerText())), "합치기 안내: 편제표·4단계 집계는 그대로");
  const parts = before.filter((item) => item.key.startsWith("2:1:"));
  check(parts.length === 2 && parts.every((item) => /편성됨|확인 필요/.test(item.text)), "합치기 전: 3학년 1학기 그룹 2개(택5·택1) 편성 결과 있음", parts);
  // 예전 결과(끈 뒤에 그대로인지 견줄 값)
  await page.locator('[data-cs-group="2:1:3-1 택5"]').click(); await sleep(500);
  const oldSummary = await summary();

  console.log("▶ 합치기 켜기 → 합친 그룹");
  await page.locator('[data-cs-merge="2:1"]').check(); await sleep(800);
  const after = await groups();
  const mergedKey = "2:1:3-1 택5+3-1 택1";
  const merged = after.find((item) => item.key === mergedKey);
  check(Boolean(merged) && merged.active && /3-1 택5 \+ 3-1 택1\(합침\) .*택6 미편성/.test(merged.text) && !after.some((item) => item.key === "2:1:3-1 택5" || item.key === "2:1:3-1 택1") && after.length === before.length - 1,
    "두 그룹 대신 합친 그룹 하나(택6, 미편성)가 골라짐", after.map((item) => item.text));
  check(/그룹을 합쳤습니다/.test(await status()), "상태 줄 안내", await status());
  const courseCount = await page.locator("[data-cs-sections]").count();
  check((await page.locator("[data-cs-block-times]").count()) === 6 && (await page.locator("[data-cs-merged-mode]").count()) === courseCount && courseCount === 12 && (await page.locator("[data-cs-mode]").count()) === 0,
    "블록 6개 · 과목 12개 모두 '이동'(운영 방식 고르기 없음)", { blocks: await page.locator("[data-cs-block-times]").count(), courseCount });
  const fewer = await page.locator("[data-cs-fewer]").evaluateAll((els) => els.map((e) => `${e.dataset.csFewer}:${e.textContent.trim()}`));
  check(fewer.every((text) => /^(일본어|중국어)[^:]*:정원으로 보면 \d+분반이면 됩니다$/.test(text)), "분반 수는 4단계 값 그대로 — 학급 단위로 운영하던 과목만 '정원으로 보면 n분반' 안내", fewer);
  await shot("01-merged.png");

  console.log("▶ 편성 계산");
  await solve();
  const solved = await summary();
  check(solved.feasible === "true" && /모든 학생 배정\(분반 \d+개, 블록별 \d+(·\d+){5}개\)/.test(solved.text), `합친 그룹 편성: ${solved.text.slice(0, 80)}`, solved);
  check((await page.locator("[data-cs-apply]").evaluateAll((els) => els.filter((e) => /학급 단위/.test(e.parentElement.innerText)).length)) === 0, "'학급 단위로 운영하면' 제안 없음");
  check((await page.locator('section[aria-label="학급 단위 과목"]').count()) === 0, "학급 단위 과목 카드 없음");
  await shot("02-solved.png");

  console.log("▶ 내보내기(블록표·명렬·나이스)");
  const blocks = await exportSheets("#classSectionsExportBlocks", "blocks");
  const letters = new Set(blocks[0].rows.slice(2).map((row) => String(row[0] || "")).filter((text) => /^[a-z]블록$/.test(text)));
  check(/3-1 택5 \+ 3-1 택1\(합침\) 블록표/.test(String(blocks[0].rows[0][0])) && letters.size === 6, "블록표: 제목에 합친 그룹, 블록 6개", [...letters]);
  const subjects = new Set(blocks[0].rows.slice(2).map((row) => String(row[3] || "")).filter(Boolean));
  check(subjects.has("일본어") || subjects.has("중국어") || subjects.size >= 11, "블록표에 택1 과목(이동 분반)도 있음", [...subjects]);
  const rosters = await exportSheets("#classSectionsExportRosters", "rosters");
  check(rosters.length >= 60 && !rosters.some((sheet) => /학급 단위/.test(sheet.name)), `분반 명렬 ${rosters.length}개 시트(학급 단위 시트 없음)`);
  const neis = await exportSheets("#classSectionsExportNeis", "neis");
  const rows = neis[0].rows.slice(2).filter((row) => row[9]);
  const perStudent = new Map();
  for (const row of rows) perStudent.set(String(row[10]), (perStudent.get(String(row[10])) || 0) + 1);
  const counts = [...new Set(perStudent.values())].sort();
  check(perStudent.size >= 300 && counts.length === 1 && counts[0] === 6, `나이스: 학생 ${perStudent.size}명 모두 6과목(택5 + 택1)`, counts);
  const roomOf = new Map();
  let clash = 0;
  for (const row of rows) { const key = `${row[10]}|${String(row[5]).charAt(0)}`; if (roomOf.has(key)) clash += 1; roomOf.set(key, row[5]); }
  check(clash === 0, "나이스: 한 학생이 같은 블록에 두 과목 없음(강의실 첫 글자 = 블록)", clash);

  console.log("▶ 전 학년 함께 다시 계산");
  await solve("#classSectionsSolveSemester");
  const joint = await status();
  check(/1학기 전 학년 2개 그룹을 함께 다시 계산했습니다/.test(joint), `함께 다시 계산: ${joint.slice(0, 90)}`, joint);
  const jointSummary = await summary();
  check(/모든 학생 배정/.test(jointSummary.text), "함께 계산 뒤에도 합친 그룹 모든 학생 배정", jointSummary);

  console.log("▶ 끄기 → 그룹마다 예전 결과 그대로, 다시 켜면 합친 결과 그대로");
  await page.locator('[data-cs-merge="2:1"]').uncheck(); await sleep(800);
  const off = await groups();
  check(off.length === before.length && off.filter((item) => item.key.startsWith("2:1:")).every((item, index) => item.text === parts[index].text), "끄면 두 그룹이 예전 상태 그대로", off.filter((item) => item.key.startsWith("2:1:")).map((item) => item.text));
  check(/합치기를 껐습니다/.test(await status()), "상태 줄 안내(끔)");
  await page.locator('[data-cs-group="2:1:3-1 택5"]').click(); await sleep(500);
  const again = await summary();
  check(again.text === oldSummary.text && again.feasible === oldSummary.feasible, "택5 그룹의 예전 편성 결과 요약이 그대로", { again, oldSummary });
  await page.locator('[data-cs-merge="2:1"]').check(); await sleep(800);
  const back = await summary();
  check(back.text === jointSummary.text && (await groups()).some((item) => item.key === mergedKey && /편성됨|확인 필요/.test(item.text)), "다시 켜면 합친 편성 결과가 그대로", back);

  console.log("▶ 새로고침 뒤에도 유지");
  await sleep(1200);
  await page.reload(); await page.waitForLoadState("networkidle"); await sleep(2000);
  await page.getByRole("button", { name: /6\. 분반 편성/ }).click(); await sleep(800);
  check(await page.locator('[data-cs-merge="2:1"]').isChecked() && (await groups()).some((item) => item.key === mergedKey), "새로고침 뒤 합치기 설정·합친 그룹 유지");
  check(!logs.length, "페이지 오류 없음", logs);
  await browser.close(); server.close();
  console.log(failures.length ? `실패 ${failures.length}건` : "모두 통과");
  process.exit(failures.length ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
