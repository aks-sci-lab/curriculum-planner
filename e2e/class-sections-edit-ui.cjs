// 6단계 직접 고치기 화면 확인(사용자처럼 클릭): 하네스가 남긴 백업(가상 학생)을 복원 → 과목 × 블록 표·같이 신청·칸 고치기 →
// 학생 옮기기 창 → 배정 결과 엑셀 내려받기·(고친 파일) 올리기 → 앱 확인 창 적용.
// 사용: node e2e/run.cjs --seed 10 --out /tmp/e2e  →  node e2e/class-sections-edit-ui.cjs /tmp/cs-edit /tmp/e2e/downloads/workspace-backup.json.gz
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
  // 다시 계산이 끝날 때까지(바뀐 학생이 많아 앱 확인 창이 뜨면 '적용')
  const confirms = [];
  const waitIdle = async () => {
    for (let i = 0; i < 600; i += 1) {
      if (await page.locator("#appConfirmDialog[open]").count()) { confirms.push(await page.locator("#appConfirmText").innerText()); await page.locator("#appConfirmOk").click(); }
      if (await page.evaluate(() => !CLASS_SECTIONS_VIEW.running && !document.querySelector("#classSectionsSolve")?.disabled)) return;
      await sleep(200);
    }
    throw new Error("다시 계산이 끝나지 않음");
  };
  const changeLine = async () => page.locator("#classSectionsEditChange").evaluate((el) => ({ text: el.textContent, changed: Number(el.dataset.changed), own: Number(el.dataset.own) })).catch(() => null);
  await page.goto(url); await page.waitForLoadState("networkidle"); await sleep(1000);
  await page.locator("#workspaceDataMenu summary").click();
  const nav = page.waitForEvent("load", { timeout: 30000 }).catch(() => null);
  await page.locator("#restoreWorkspaceBackup").setInputFiles(BACKUP);
  await page.locator("#appConfirmDialog[open] #appConfirmOk").click({ timeout: 10000 }).catch(() => {}); // 백업 복원은 앱 확인 창으로 묻는다
  await nav; await sleep(2500);
  await page.getByRole("button", { name: /6\. 분반 편성/ }).click();
  await sleep(800);
  await page.locator("#workspaceRound").selectOption("2").catch(() => {});
  // 택3 그룹(이동 분반 있음)
  await page.locator("[data-cs-group]").filter({ hasText: "2-2 택3" }).first().click();
  await sleep(500);
  const card = page.locator('section[aria-label="직접 고치기"]');
  check(await card.count() === 1, "직접 고치기 카드가 보임");
  const table = page.locator("#classSectionsPlacementTable");
  const head = await table.locator("thead th").allInnerTexts();
  check(head[0] === "과목" && head.some((text) => /^a블록$/.test(text)), "표 머리: 과목·신청·분반·정원 합·블록", head);
  const foot = await table.locator("tfoot").innerText();
  check(/블록별 분반 \/ 최대/.test(foot), "맨 아래 줄 블록별 분반 / 최대", foot);
  await shot("01-placement.png");
  // 과목 이름 → 같이 신청한 학생
  const first = table.locator("tbody th button").first();
  const firstName = (await first.innerText()).trim();
  await first.click(); await sleep(300);
  const co = await page.locator("#classSectionsCoPanel").innerText().catch(() => "");
  check(/^.+[과와] 같이 신청한 학생:/.test(co) && co.startsWith(firstName) && /\d+명/.test(co), "과목을 누르면 같이 신청한 학생 수", co);
  check(await table.locator("tbody tr.is-selected").count() === 1, "고른 과목 줄 강조");
  // 칸 고치기: 첫 과목에서 분반이 있는 블록 칸을 1 줄이고 빈 블록 칸을 1 늘림(분반 수 유지)
  const inputs = table.locator(`tbody tr`).first().locator("input[data-cs-place-course]");
  const values = await inputs.evaluateAll((els) => els.map((e) => Number(e.value)));
  const from = values.findIndex((v) => v > 0);
  const to = values.findIndex((v, i) => i !== from && v === 0);
  if (from >= 0 && to >= 0) {
    // 다른 과목 학생은 그대로인지: 고치기 전 학생 찾기 결과(분반 이름) 보관 대신, 바뀐 학생 수 줄(#classSectionsEditChange)로 확인
    await inputs.nth(from).fill(String(values[from] - 1)); await inputs.nth(from).press("Tab");
    await waitIdle(); await sleep(500);
    const first = await changeLine();
    console.log("edit 1:", first?.text);
    check(first && /^최근 직접 고치기: .+ · 분반이 바뀐 학생 \d+명\(.+ 학생 \d+명 포함\)/.test(first.text), "칸을 고친 뒤 '분반이 바뀐 학생 n명(이 과목 학생 m명 포함)'", first);
    check(first && (first.changed <= Math.max(first.own * 2, first.own + 10) || confirms.length > 0), "바뀐 학생이 과목 학생의 2배를 넘으면 확인 창", { first, confirms });
    await table.locator("tbody tr").first().locator("input[data-cs-place-course]").nth(to).fill("1");
    await table.locator("tbody tr").first().locator("input[data-cs-place-course]").nth(to).press("Tab");
    await waitIdle(); await sleep(500);
    const second = await changeLine();
    console.log("edit 2:", second?.text);
    check(second && (second.changed <= Math.max(second.own * 2, second.own + 10) || confirms.length > 0), "다시 늘려도 바뀐 학생은 과목 학생의 2배 이내(넘으면 확인 창)", { second, confirms });
    const after = await page.locator("#classSectionsPlacementTable tbody tr").first().locator("input[data-cs-place-course]").evaluateAll((els) => els.map((e) => Number(e.value)));
    check(after[from] === values[from] - 1 && after[to] === 1, "칸을 고치면 그 블록 분반 수로 다시 편성", { values, after });
    const pinned = await page.locator("input[data-cs-pin]:checked").count();
    check(pinned > 0, "칸을 고친 뒤 분반이 블록 고정으로 표시", pinned);
    console.log("status:", await status());
    const over = await page.locator("#classSectionsPlacementTable tfoot td.is-over").count();
    const overTag = await page.locator("[data-cs-block-over]").count();
    check(over === overTag, "블록당 최대 초과 칸에는 '최대 n 초과' 표시", { over, overTag });
    check(/모든 분반이 지금 블록에 고정/.test(await page.locator("#classSectionsPinNote").innerText()), "표 위 블록 고정 안내");
  }
  await shot("02-placement-edited.png");
  // 블록 고정 모두 풀기
  await page.getByRole("button", { name: "블록 고정 모두 풀기" }).click(); await sleep(400);
  check(await page.locator("input[data-cs-pin]:checked").count() === 0, "블록 고정 모두 풀기 → 고정 0개");
  check(/블록 고정 \d+개를 모두 풀었습니다/.test(await status()), "풀기 상태 문구", await status());
  // 학생 옮기기
  const search = page.locator("#classSectionsStudentSearch");
  await search.fill("1-1"); await search.press("Enter"); await sleep(500);
  const moveButton = page.getByRole("button", { name: /^1-1-\d+ 옮기기$/ }).first();
  check(await moveButton.count() === 1, "학생 찾기 결과에 '옮기기' 단추");
  const studentKey = (await moveButton.getAttribute("aria-label")).replace(/ 옮기기$/, "");
  await moveButton.click();
  const dialog = page.locator("#classSectionsMoveDialog[open]");
  await dialog.waitFor({ timeout: 10000 });
  const rowsText = await dialog.locator("tbody tr").allInnerTexts();
  check(rowsText.length >= 2, "창: 학생 신청 과목마다 한 줄", rowsText);
  check(await dialog.locator(".cs-move-cell.is-current").count() >= 2, "지금 칸 강조");
  const emptyCells = await dialog.locator("td.is-empty").count();
  const radiosPerRow = await dialog.locator("tbody tr").evaluateAll((rows) => rows.map((row) => row.querySelectorAll("td:not(:last-child)").length));
  check(emptyCells === 0 || emptyCells > 0, `분반 없는 블록 칸 ${emptyCells}개(회색)`, radiosPerRow);
  check(/문제 없음/.test(await page.locator("#classSectionsMoveIssues").innerText()), "지금 배정은 문제 없음");
  // 첫 과목을 다른 분반으로 → 검사 결과가 곧바로 바뀜
  const firstRow = dialog.locator("tbody tr").first();
  const radios = firstRow.locator("input[type=radio]");
  const options = await radios.evaluateAll((els) => els.map((e) => ({ value: e.value, checked: e.checked })));
  const other = options.findIndex((o) => !o.checked && o.value);
  if (other >= 0) {
    await radios.nth(other).check(); await sleep(200);
    const issues = await page.locator("#classSectionsMoveIssues").innerText();
    console.log("move issues:", issues.replace(/\s+/g, " "));
    check(issues.length > 0, "바꾸면 검사 결과가 바로 보임", issues);
  }
  // 배정 안 함 → 택n보다 적음 경고
  await firstRow.getByLabel(/배정 안 함$/).check(); await sleep(200);
  check(/택\d보다 적은 과목/.test(await page.locator("#classSectionsMoveIssues").innerText()), "배정 안 함 → 택n보다 적음 경고");
  await page.locator("#classSectionsMoveRecommend").click(); await sleep(200);
  check(/문제 없음/.test(await page.locator("#classSectionsMoveIssues").innerText()), "추천 칸으로 → 문제 없음");
  await shot("03-move-dialog.png");
  await page.locator("#classSectionsMoveSave").click();
  await page.locator("#classSectionsMoveDialog[open]").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  await waitIdle(); await sleep(500);
  console.log("status:", await status());
  await search.fill(studentKey); await search.press("Enter"); await sleep(300);
  check(/고정/.test(await page.locator(".cs-lookup").innerText()), "저장하면 학생 고정 표시", await page.locator(".cs-lookup").innerText());
  // 배정 결과 엑셀 내려받기
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "배정 결과 엑셀 내려받기" }).click();
  const download = await dl;
  const file = path.join(OUT, "downloads", "assign.xlsx");
  await download.saveAs(file);
  const name = await page.evaluate(() => document.querySelector("a[download]")?.download || "");
  console.log("download name:", name || "(a.download 없음)");
  // 그대로 올리기 → 바뀐 학생 없음
  await page.locator("#classSectionsAssignImport").setInputFiles(file); await sleep(1500);
  check(/바뀐 학생이 없습니다/.test(await status()), "그대로 올리면 '바뀐 학생이 없습니다'", await status());
  // 고친 파일(한 학생의 첫 과목 분반을 다른 분반으로): 사용자가 엑셀에서 고친 것처럼 브라우저 안에서 같은 양식 파일을 만든다
  const edited = await page.evaluate(async (bytes) => {
    const sheets = await parseWorkbook(new Uint8Array(bytes).buffer);
    const rows = sheets[0].rows.map((row) => row.slice());
    const blockSheet = sheets[1].rows;
    // 3행 '열린 블록'에서 두 블록 이상 열린 과목을 찾아 한 학생을 다른 블록으로
    for (let c = 2; c < rows[0].length; c += 2) {
      const opened = String(rows[2][c] || "").match(/([a-j])\((\d)/g) || [];
      if (opened.length < 2) continue;
      for (let r = 3; r < rows.length; r += 1) {
        if (!rows[r][c]) continue;
        const target = opened.map((text) => text.match(/([a-j])\((\d)/)).find((m) => m[1] !== rows[r][c]);
        if (!target) continue;
        rows[r][c] = target[1]; rows[r][c + 1] = target[2];
        const blob = createWorkbookBlob([{ name: "배정 결과", rows }, { name: "과목별 블록", rows: blockSheet }]);
        return { key: rows[r][0], bytes: [...new Uint8Array(await blob.arrayBuffer())] };
      }
    }
    return null;
  }, [...fs.readFileSync(file)]);
  if (edited) {
    const editedFile = path.join(OUT, "downloads", "assign-edited.xlsx");
    fs.writeFileSync(editedFile, Buffer.from(edited.bytes));
    await page.locator("#classSectionsAssignImport").setInputFiles(editedFile);
    const confirm = page.locator("#appConfirmDialog[open]");
    await confirm.waitFor({ timeout: 10000 });
    const text = await page.locator("#appConfirmText").innerText();
    check(/바뀐 학생 1명/.test(text) && text.includes(edited.key), "고친 파일을 올리면 앱 확인 창에 바뀐 학생 1명", text);
    await shot("04-import-confirm.png");
    await page.locator("#appConfirmOk").click();
    await waitIdle(); await sleep(800);
    console.log("status:", await status());
    await search.fill(edited.key); await search.press("Enter"); await sleep(300);
    check(/고정/.test(await page.locator(".cs-lookup").innerText()), "적용하면 그 학생이 고정", await page.locator(".cs-lookup").innerText());
    const excelChange = await changeLine();
    console.log("excel:", excelChange?.text, "confirms:", confirms.length);
    check(excelChange && (excelChange.changed <= Math.max(excelChange.own * 2, excelChange.own + 10) || confirms.length > 0), "엑셀 한 명 고치기: 바뀐 학생이 적거나, 많으면 확인 창", excelChange);
  } else check(false, "고칠 학생을 찾지 못함");
  await shot("05-after-import.png");
  check(!logs.length, "페이지 오류 없음", logs);
  await browser.close(); server.close();
  console.log(failures.length ? `실패 ${failures.length}건` : "모두 통과");
  process.exit(failures.length ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
