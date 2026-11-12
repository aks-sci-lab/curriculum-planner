// 6단계 교사 명단 화면 확인(사용자처럼 클릭): 하네스 백업 복원 → 교사·시간 설정 → 자리 이름 안내 → 교사 명단 양식 내려받기 →
// (엑셀에서 이름을 실제 이름으로 고친 파일) 올리기 → 앱 확인 창 → 이름이 바뀌고 배정·블록표가 새 이름으로.
// 사용: node e2e/run.cjs --seed 10 --out /tmp/e2e  →  node e2e/class-sections-teachers-ui.cjs /tmp/cs-t /tmp/e2e/downloads/workspace-backup.json.gz
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
(async () => {
  const { server, url } = await startStaticServer(ROOT);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: "ko-KR", acceptDownloads: true });
  await context.route(/supabase\.co|googleapis|gstatic/, (route) => route.abort());
  const page = await context.newPage();
  const logs = [];
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => d.type() === "prompt" ? d.accept("초기화") : d.accept());
  const shot = async (name) => page.screenshot({ path: path.join(OUT, name), fullPage: true });
  const status = () => page.locator("#classSectionsStatus").innerText().catch(() => "");
  await page.goto(url); await page.waitForLoadState("networkidle"); await sleep(1000);
  await page.locator("#workspaceDataMenu summary").click();
  const nav = page.waitForEvent("load", { timeout: 30000 }).catch(() => null);
  await page.locator("#restoreWorkspaceBackup").setInputFiles(BACKUP);
  await page.locator("#appConfirmDialog[open] #appConfirmOk").click({ timeout: 10000 }).catch(() => {}); // 백업 복원은 앱 확인 창으로 묻는다
  await nav; await sleep(2500);
  await page.getByRole("button", { name: /6\. 분반 편성/ }).click(); await sleep(800);
  await page.locator("#workspaceRound").selectOption("2").catch(() => {});
  await page.locator("[data-cs-group]").filter({ hasText: "2-2 택3" }).first().click(); await sleep(400);
  await page.locator("#classSectionsTeachersOpen").click();
  await page.locator("#classSectionsTeacherDialog[open]").waitFor({ timeout: 10000 });
  // 자리 이름이 하나도 없으면 5단계 교사 수로 하나 만든다(첫 교과의 이름 칸을 자리 이름으로 되돌리는 대신 새로 만들기)
  let warn = await page.locator("#classSectionsTeacherNameWarning").innerText().catch(() => "");
  if (!warn) { await page.getByRole("button", { name: "5단계 교사 수로 명단 만들기" }).click(); await sleep(400); warn = await page.locator("#classSectionsTeacherNameWarning").innerText().catch(() => ""); }
  console.log("warning:", warn);
  check(/^실제 이름이 없는 교사 \d+명\(.+\) — 교사 명단에서 이름을 넣으세요/.test(warn), "자리 이름 교사가 있으면 창에 안내", warn);
  const count = Number(warn.match(/교사 (\d+)명/)?.[1] || 0);
  await shot("01-teachers.png");
  // 양식 내려받기
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "교사 명단 양식 내려받기" }).click();
  const file = path.join(OUT, "downloads", "teachers.xlsx");
  await (await dl).saveAs(file);
  // 사용자가 엑셀에서 자리 이름을 실제(가명) 이름으로 고친 파일: 같은 양식으로 브라우저 안에서 만든다
  const edited = await page.evaluate(async (bytes) => {
    const sheets = await parseWorkbook(new Uint8Array(bytes).buffer);
    const rows = sheets[0].rows.map((row) => row.slice());
    const changed = [];
    rows.forEach((row, index) => { if (index && /\s\d+$/.test(String(row[0])) && /^t-/.test(String(row[6]))) { changed.push([row[0], `가상교사${index}`, row[6]]); row[0] = `가상교사${index}`; } });
    const blob = createWorkbookBlob([{ name: "교사 명단", rows }]);
    return { header: rows[0], changed, bytes: [...new Uint8Array(await blob.arrayBuffer())] };
  }, [...fs.readFileSync(file)]);
  check(edited.header.join("|") === "이름|담당 교과|담당 과목|불가 시간|사유|비고|번호(고치지 마세요)|담임(내년 학년-반)", "양식 머리글", edited.header);
  check(edited.changed.length === count, `자리 이름 ${count}명을 실제 이름으로 고침`, edited.changed.length);
  const editedFile = path.join(OUT, "downloads", "teachers-edited.xlsx");
  fs.writeFileSync(editedFile, Buffer.from(edited.bytes));
  await page.locator("#classSectionsTeacherImport").setInputFiles(editedFile);
  await page.locator("#appConfirmDialog[open]").waitFor({ timeout: 10000 });
  const text = await page.locator("#appConfirmText").innerText();
  check(new RegExp(`교사 명단: 추가 0·갱신 ${count}·유지 \\d+`).test(text), "확인 창: 추가 0·갱신 n·유지 k", text);
  await page.locator("#appConfirmOk").click(); await sleep(600);
  check(!(await page.locator("#classSectionsTeacherNameWarning").count()), "이름을 넣으면 안내가 사라짐");
  const names = await page.locator('#classSectionsTeacherDialog input[data-cs-t$="|name"]').evaluateAll((els) => els.map((e) => e.value));
  check(edited.changed.every(([, name]) => names.includes(name)), "창의 이름 칸이 새 이름", names.slice(0, 5));
  await shot("02-teachers-renamed.png");
  await page.locator("#classSectionsTeacherClose").click(); await sleep(400);
  // 배정은 id 그대로 → 결과 화면 담당 교사·블록표가 새 이름
  const renamedIds = new Set(edited.changed.map(([, , id]) => id));
  const shown = await page.locator("select[data-cs-teacher]").evaluateAll((els) => els.map((e) => e.options[0].textContent));
  const oldNames = edited.changed.map(([old]) => old);
  check(!shown.some((text) => oldNames.some((old) => text.includes(`(${old})`))), "결과 화면 담당 교사에 옛 자리 이름이 없음", shown.filter((text) => oldNames.some((old) => text.includes(old))).slice(0, 3));
  const dl2 = page.waitForEvent("download");
  await page.locator("#classSectionsExportBlocks").click();
  const blocksFile = path.join(OUT, "downloads", "blocks.xlsx");
  await (await dl2).saveAs(blocksFile);
  const blockRows = await page.evaluate(async (bytes) => (await parseWorkbook(new Uint8Array(bytes).buffer))[0].rows, [...fs.readFileSync(blocksFile)]);
  check(!/실제 이름이 없는 교사/.test(String(blockRows[0][0])), "블록표 제목에 안내 없음(모두 실제 이름)", blockRows[0][0]);
  check(!blockRows.slice(2).some((row) => oldNames.includes(String(row[6]))), "블록표 담당 교사에 옛 자리 이름 없음");
  console.log("renamed ids:", renamedIds.size, "status:", await status());
  check(!logs.length, "페이지 오류 없음", logs);
  await browser.close(); server.close();
  console.log(failures.length ? `실패 ${failures.length}건` : "모두 통과");
  process.exit(failures.length ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
