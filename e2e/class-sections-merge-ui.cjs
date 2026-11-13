// 6단계 '이동수업 그룹 합치기' 화면 확인(사용자처럼 클릭): 하네스 백업 복원 → 6단계 → (자리 교사 보충 안내) → 합치기 켜기(현2 → 3학년 1학기 택5 + 택1) →
// 합친 그룹(블록 6개·과목 모두 이동) → 편성 계산 → 블록표·명렬·나이스 내보내기 → 전 학년 함께 다시 계산 → 학년 간 겹치는 블록 쌍(칸이 모자랄 때) →
// 2학기도 합침 → 7단계 사전 점검·시간표 계산(블록 6개) → 끄기 → 그룹마다 예전 결과 그대로 → 다시 켜면 합친 결과 그대로 → 새로고침.
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

  console.log("▶ 교사 0명인데 수업이 있는 교과: 명단에 없어도 자리 교사 1명을 두고 계산");
  {
    const note = async () => clean(await page.locator("#classSectionsTeacherNote").innerText().catch(() => ""));
    const noteBefore = await note();
    await page.locator("#classSectionsTeachersOpen").click();
    const dialog = page.locator("#classSectionsTeacherDialog");
    await dialog.waitFor({ state: "visible", timeout: 10000 });
    // 명단에서 자리 교사 '진로 1'(5단계 교사 수 0명 교과)을 지운다 = 그 규칙이 생기기 전에 만든 명단
    const names = await dialog.locator('input[data-cs-t$="|name"]').evaluateAll((els) => els.map((el) => el.value));
    const at = names.findIndex((name) => /^진로 1$/.test(name));
    if (at >= 0) {
      await dialog.locator(`[data-cs-t-remove="${at}"]`).click(); await sleep(300);
      await page.locator("#appConfirmDialog[open] #appConfirmOk").click({ timeout: 1500 }).catch(() => {});
      await page.locator("#classSectionsTeacherClose").click(); await sleep(500);
      const noteAfter = await note();
      check(!/자리 교사 1명을 두고 계산/.test(noteBefore) && /자리 교사 1명을 두고 계산: 진로 1\(교사 명단에 없고 5단계 교사 수 0명 — '5단계 교사 수로 명단 만들기'를 누르면 명단에 생깁니다\)/.test(noteAfter), "명단에서 빠진 0명 교과(진로)는 자리 교사 1명을 두고 계산한다고 알림", { noteBefore, noteAfter });
      await page.locator("#classSectionsTeachersOpen").click();
      await dialog.waitFor({ state: "visible", timeout: 10000 });
      await page.getByRole("button", { name: "5단계 교사 수로 명단 만들기" }).click(); await sleep(400);
      await page.locator("#classSectionsTeacherClose").click(); await sleep(500);
      check(!/자리 교사 1명을 두고 계산/.test(await note()), "'5단계 교사 수로 명단 만들기'를 누르면 명단에 생겨 알림이 사라짐", await note());
    } else {
      await page.locator("#classSectionsTeacherClose").click(); await sleep(300);
      console.log("     (이 백업의 명단에는 자리 교사 '진로 1'이 없어 건너뜀)", names.slice(0, 5));
    }
  }

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

  console.log("▶ 합친 그룹의 교실 배정·출력물·직접 고치기");
  {
    const save = async (action, name) => { const dl = page.waitForEvent("download", { timeout: 60000 }); await action(); await page.locator("#appConfirmDialog[open] #appConfirmOk").click({ timeout: 1500 }).catch(() => {}); const file = path.join(OUT, "downloads", name); await (await dl).saveAs(file); return file; };
    const sheetsOf = (file) => page.evaluate(async (bytes) => (await parseWorkbook(new Uint8Array(bytes).buffer)).map((sheet) => ({ name: sheet.name, rows: sheet.rows })), [...fs.readFileSync(file)]);
    // 교실: 분반마다 교실, 같은 블록에서 교실이 겹치지 않음
    const roomErrors = Number(await page.locator("#classSectionsRoomSummary").getAttribute("data-errors").catch(() => "-1"));
    check(roomErrors === 0, "교실 배정 오류 0", { roomErrors, text: clean(await page.locator("#classSectionsRoomSummary").innerText().catch(() => "")).slice(0, 160) });
    const blockRows = (await exportSheets("#classSectionsExportBlocks", "blocks-rooms"))[0].rows.slice(2).filter((row) => /^[a-f]블록$/.test(String(row[0] || "")));
    const roomUse = new Map();
    for (const row of blockRows) { const key = `${row[0]}|${row[7]}`; roomUse.set(key, (roomUse.get(key) || 0) + 1); }
    check(blockRows.length === 66 && blockRows.every((row) => String(row[7] || "").trim()) && [...roomUse.values()].every((count) => count === 1), "블록표: 분반 66개 모두 교실이 있고 같은 블록에서 겹치지 않음", [...roomUse].filter(([, count]) => count > 1).slice(0, 4));
    // 이동 출석부(이 그룹 파일): 분반마다 한 장
    const attendance = await sheetsOf(await save(() => page.getByRole("button", { name: "출석부 이 그룹 파일" }).click(), "attendance-merged.xlsx"));
    check(attendance.length === 66, `출석부 이 그룹 파일: 분반 ${attendance.length}장`, attendance.slice(0, 3).map((sheet) => sheet.name));
    check((await page.locator("#classSectionsAttendanceTable").count()) === 1, "출석부 미리 보기 표");
    // 담임반 현황·학생 배부용 쪽지(출석부 보기 범위 = 담임반별)
    await page.getByLabel("출석부 보기 범위").selectOption("homeroom"); await sleep(800);
    check((await page.locator("#classSectionsHomeroomTable").count()) === 1 && (await page.locator("#classSectionsHandoutPreview").count()) === 1, "담임반 현황 표·학생 배부용 쪽지 미리 보기");
    const slip = clean(await page.locator("#classSectionsHandoutPreview").innerText().catch(() => ""));
    check(new Set((slip.match(/[a-f]블록/g) || [])).size === 6, "배부용 쪽지에 블록 6개(a~f)", slip.slice(0, 200));
    await page.getByLabel("출석부 보기 범위").selectOption({ index: 0 }); await sleep(500);
    // 학생 시간표: 학생 찾기 → 미리 보기(1학기 칸에 이동 수업)
    await page.getByLabel("학생 찾기(현학년-반-번호)").fill("2-1-1"); await page.getByLabel("학생 찾기(현학년-반-번호)").press("Enter"); await sleep(700);
    const preview = page.locator("#classSectionsTimetablePreview");
    const previewText = clean(await preview.innerText().catch(() => ""));
    check((await preview.count()) === 1 && /현 2학년 → 3학년 이동수업 시간표/.test(previewText), "학생 시간표 미리 보기(현 2학년 → 3학년)", previewText.slice(0, 120));
    // 직접 고치기: 과목 × 블록 분반 수 표(과목 12 × 블록 6), 배정 결과 엑셀
    const place = await page.locator("#classSectionsPlacementTable").evaluate((table) => ({ rows: table.querySelectorAll("tbody tr").length, inputs: table.querySelectorAll("tbody tr:first-child input[data-cs-place-course]").length })).catch(() => null);
    check(place && place.rows === 12 && place.inputs === 6, "직접 고치기 표: 과목 12줄 × 블록 6칸", place);
    const assignSheets = await sheetsOf(await save(() => page.locator("#classSectionsAssignExport").click(), "assign-merged.xlsx"));
    const assignRows = assignSheets[0].rows.filter((row) => /^2-\d+-\d+$/.test(String(row[0] || "")) || row.some((cell) => /^2-\d+-\d+$/.test(String(cell || ""))));
    check(assignRows.length >= 300, `배정 결과 엑셀: 학생 ${assignRows.length}줄`, assignSheets.map((sheet) => [sheet.name, sheet.rows.length]));
    check(!logs.length, "출력물 확인까지 페이지 오류 없음", logs);
  }

  console.log("▶ 전 학년 함께 다시 계산");
  await solve("#classSectionsSolveSemester");
  const joint = await status();
  check(/1학기 전 학년 2개 그룹을 함께 다시 계산했습니다/.test(joint), `함께 다시 계산: ${joint.slice(0, 90)}`, joint);
  const jointSummary = await summary();
  check(/모든 학생 배정/.test(jointSummary.text), "함께 계산 뒤에도 합친 그룹 모든 학생 배정", jointSummary);

  console.log("▶ 학년 간 겹치는 블록 쌍(블록 칸 수 합 > 한 주 칸 수)");
  check((await page.locator("#classSectionsPairs").count()) === 0 && !/같은 시간에 열 블록 쌍/.test(joint), "칸이 모자라지 않으면 블록 쌍을 정하지 않음");
  // 전 교사 고정 시간을 10칸 더해 한 주에 블록을 놓을 칸을 줄인다(33 → 23칸) → 2학년 블록과 3학년 블록 일부는 같은 시간에 열려야 한다
  await page.locator("#classSectionsTeachersOpen").click();
  const dialog = page.locator("#classSectionsTeacherDialog");
  await dialog.waitFor({ state: "visible", timeout: 10000 });
  await dialog.locator("#classSectionsFixedAdd").click(); await sleep(300);
  const fixedRows = await dialog.locator('[data-cs-f$="|times"]').count();
  await dialog.locator(`[data-cs-f="${fixedRows - 1}|label"]`).fill("교직원 연수"); await dialog.locator(`[data-cs-f="${fixedRows - 1}|label"]`).press("Tab"); await sleep(200);
  await dialog.locator(`[data-cs-f="${fixedRows - 1}|times"]`).fill("월6,월7,화6,화7,수6,수7,목6,목7,금4,금5"); await dialog.locator(`[data-cs-f="${fixedRows - 1}|times"]`).press("Tab"); await sleep(300);
  await page.locator("#classSectionsTeacherClose").click(); await sleep(500);
  await solve("#classSectionsSolveSemester");
  const paired = await status();
  check(/같은 시간에 열 블록 쌍: 2학년 [a-f]블록 × 3학년 [a-f]블록(, 2학년 [a-f]블록 × 3학년 [a-f]블록)*\((교사 겹침 없음|분반 \d+개 담당 교사 비움)\)/.test(paired), `함께 계산이 블록 쌍을 정함: ${(paired.match(/같은 시간에 열 블록 쌍[^.]*/) || [""])[0].slice(0, 110)}`, paired);
  const pairNotes = await page.locator("#classSectionsPairs [data-cs-pair]").evaluateAll((els) => els.map((el) => ({ pair: el.dataset.csPair, shared: Number(el.dataset.shared), text: el.textContent.trim() })));
  check(pairNotes.length >= 1 && pairNotes.every((note) => /^2학년 [a-f]블록 × 3학년 [a-f]블록$/.test(note.pair)), "결과 화면에 '같은 시간에 열 블록 쌍' 줄", pairNotes);
  if (/교사 겹침 없음/.test(paired)) check(pairNotes.every((note) => note.shared === 0 && /교사가 겹치지 않습니다/.test(note.text)), "그 쌍의 두 블록에 같은 교사가 없음(저장된 결과에서 다시 확인)", pairNotes);
  // 블록표로 직접 확인: 쌍의 두 블록에 같은 담당 교사 이름이 없다
  const pairBlocks = await exportSheets("#classSectionsExportBlocks", "blocks-paired");
  const firstPair = pairNotes[0]?.pair.match(/^2학년 ([a-f])블록 × 3학년 ([a-f])블록$/);
  if (firstPair && /교사 겹침 없음/.test(paired)) {
    const mine = new Set(pairBlocks[0].rows.slice(2).filter((row) => String(row[0]) === `${firstPair[2]}블록`).map((row) => String(row[6] || "")).filter(Boolean));
    await page.locator('[data-cs-group="1:1:2-1 택3"]').click(); await sleep(500);
    const otherBlocks = await exportSheets("#classSectionsExportBlocks", "blocks-paired-grade2");
    const theirs = otherBlocks[0].rows.slice(2).filter((row) => String(row[0]) === `${firstPair[1]}블록`).map((row) => String(row[6] || "")).filter(Boolean);
    check(mine.size > 0 && theirs.length > 0 && !theirs.some((name) => mine.has(name)), `블록표: 2학년 ${firstPair[1]}블록과 3학년 ${firstPair[2]}블록의 담당 교사가 겹치지 않음(${theirs.length}명 · ${mine.size}명)`, { theirs, mine: [...mine] });
    check((await page.locator("#classSectionsPairs [data-cs-pair]").count()) >= 1, "2학년 그룹 화면에도 블록 쌍 줄");
    await page.locator(`[data-cs-group="${mergedKey}"]`).click(); await sleep(500);
  }
  await shot("03-paired.png");
  // 더한 고정 시간을 지우고(주 33칸) 다시 함께 계산 → 칸이 모자라지 않으면 쌍 줄은 사라진다
  await page.locator("#classSectionsTeachersOpen").click();
  await dialog.waitFor({ state: "visible", timeout: 10000 });
  await dialog.locator(`[data-cs-f-remove="${fixedRows - 1}"]`).click(); await sleep(300);
  await page.locator("#appConfirmDialog[open] #appConfirmOk").click({ timeout: 1500 }).catch(() => {});
  await page.locator("#classSectionsTeacherClose").click(); await sleep(500);
  await solve("#classSectionsSolveSemester");
  check((await page.locator("#classSectionsPairs").count()) === 0, "칸이 모자라지 않게 되면 블록 쌍 줄이 사라짐");

  console.log("▶ 2학기도 합쳐 편성 → 7단계 시간표가 합친 결과(블록 6개)로 계산");
  await page.locator('[data-cs-merge="2:2"]').check(); await sleep(800);
  await solve();
  await solve("#classSectionsSolveSemester");
  check(/2학기 전 학년 \d+개 그룹을 함께 다시 계산했습니다/.test(await status()), `2학기 함께 계산: ${(await status()).slice(0, 80)}`);
  await page.locator(`[data-cs-group="${mergedKey}"]`).click(); await sleep(500);
  const pairedSummary = await summary();
  await page.getByRole("button", { name: /7\. 시간표/ }).click(); await sleep(1500);
  const tt = page.locator("#workflowStep6Panel");
  const gradeRow = async () => tt.locator("#timetableGrades tbody tr").evaluateAll((rows) => rows.map((row) => [...row.children].map((cell) => cell.textContent.trim())).find((cells) => /^3학년/.test(cells[0])) || []);
  for (const semester of ["1", "2"]) {
    await tt.locator(`[data-tt-semester="${semester}"]`).click(); await sleep(900);
    const row = await gradeRow();
    const verdict = clean(await tt.locator("#timetableVerdict").innerText());
    check(!/계산 불가 [1-9]/.test(verdict) && row.length > 4, `7단계 ${semester}학기 사전 점검이 합친 결과를 읽음(계산을 막는 누락 없음) · 3학년 줄: ${row.slice(0, 6).join(" | ")}`, { verdict, row });
    const stale = clean(await tt.locator("#timetablePrecheck").innerText());
    check(!/분반 결과가 없|6단계 분반 편성 결과가 없/.test(stale), `7단계 ${semester}학기: '분반 결과 없음' 알림 없음`);
    const mismatch = await tt.locator("#timetablePrecheck li[data-tt-issue]").evaluateAll((els) => els.map((el) => el.textContent.replace(/\s+/g, " ")).filter((text) => /5단계 선택과목 시수/.test(text) && /3학년/.test(text)));
    check(mismatch.length === 0, `7단계 ${semester}학기: 3학년 5단계 선택과목 시수 = 6단계 분반 시수(어긋남 알림 없음)`, mismatch);
  }
  await tt.locator('[data-tt-semester="1"]').click(); await sleep(600);
  await tt.locator("#timetableRun").click();
  await tt.locator("#timetableRunProgress").waitFor({ timeout: 15000 });
  await sleep(12000);
  await tt.locator("#timetableStop").click().catch(() => {});
  await tt.locator("#timetableRunBar[data-state='done'], #timetableRunBar[data-state='stale']").waitFor({ timeout: 240000 }); await sleep(500);
  const ttSummary = clean(await tt.locator("#timetableResultSummary").innerText().catch(() => ""));
  check(/^1학기 — /.test(ttSummary) && (await tt.locator("#timetableValidation").count()) === 0, `7단계 계산 결과(검증 오류 없음): ${ttSummary.slice(0, 90)}`, ttSummary);
  // 3학년 반 시간표: 합친 블록 6개(a~f)가 모두 보인다
  await tt.locator('[data-tt-view="class"]').click().catch(() => {}); await sleep(300);
  const pick = tt.locator("#timetableGridPick");
  const third = await pick.locator("option").evaluateAll((els) => els.map((el) => el.value).find((value) => /^3-/.test(value)));
  await pick.selectOption(third); await sleep(500);
  const cellTexts = await tt.locator("#timetableGrid tbody td[data-tt-slot]").evaluateAll((els) => els.map((el) => el.textContent.replace(/\s+/g, " ").trim()));
  const blockLetters = new Set(cellTexts.map((text) => (text.match(/([a-f])블록/) || [])[1]).filter(Boolean));
  check(blockLetters.size === 6, `3학년 반 시간표에 합친 그룹의 블록 6개(${[...blockLetters].sort().join("")})`, cellTexts.filter(Boolean).slice(0, 8));
  await page.screenshot({ path: path.join(OUT, "04-timetable.png"), fullPage: true });
  await page.getByRole("button", { name: /6\. 분반 편성/ }).click(); await sleep(800);
  await page.locator(`[data-cs-group="${mergedKey}"]`).click(); await sleep(500);

  console.log("▶ 끄기 → 그룹마다 예전 결과 그대로, 다시 켜면 합친 결과 그대로");
  await page.locator('[data-cs-merge="2:1"]').uncheck(); await sleep(800);
  const off = await groups();
  check(off.filter((item) => item.key.startsWith("2:1:")).length === 2 && off.filter((item) => item.key.startsWith("2:1:")).every((item, index) => item.text === parts[index].text), "끄면 두 그룹이 예전 상태 그대로", off.filter((item) => item.key.startsWith("2:1:")).map((item) => item.text));
  check(/합치기를 껐습니다/.test(await status()), "상태 줄 안내(끔)");
  await page.locator('[data-cs-group="2:1:3-1 택5"]').click(); await sleep(500);
  const again = await summary();
  check(again.text === oldSummary.text && again.feasible === oldSummary.feasible, "택5 그룹의 예전 편성 결과 요약이 그대로", { again, oldSummary });
  await page.locator('[data-cs-merge="2:1"]').check(); await sleep(800);
  const back = await summary();
  check(back.text === pairedSummary.text && (await groups()).some((item) => item.key === mergedKey && /편성됨|확인 필요/.test(item.text)), "다시 켜면 합친 편성 결과가 그대로", back);

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
