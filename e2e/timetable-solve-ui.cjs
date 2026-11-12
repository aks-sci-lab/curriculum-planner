// 7단계 시간표 계산 화면 확인(사용자처럼 클릭): 하네스 백업(가상 학생) 복원 → 메뉴 '7. 시간표'
// ① '시간표 계산' → 진행 표시 → 결과 요약(반드시 위반·담당 교사 없음)·반 시간표·교사 시간표 ② 반·교사 고르기, 학기 탭
// ③ 조건을 바꾸면 '바뀌기 전 결과' 표시 → 다시 계산하면 사라짐 ④ 계산 중 '중단' → 그때까지 가장 좋은 답
// ④-2 시간표가 정한 블록 자리를 6단계 블록 시간에 적어 넣기(6단계 결과는 '입력 변경됨'이 되지 않음)
// ⑤ 계산 뒤 선택지: 남은 '반드시' 위반에 '공강 먼저' 등을 고르면 그 조건으로 다시 계산, 앞 결과와 견줌, 고른 내역·되돌리기 ⑥ 새로고침·백업 복원 뒤에도 결과 유지 ⑦ 콘솔 오류 없음
// 사용: node e2e/run.cjs --seed 11 --out /tmp/e2e  →  node e2e/timetable-solve-ui.cjs /tmp/tt-solve-ui /tmp/e2e/downloads/workspace-backup.json.gz
const path = require("path"), fs = require("fs");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const { chromium } = require(path.join(globalRoot, "playwright"));
const { startStaticServer } = require(path.join(ROOT, "e2e/lib/static-server.cjs"));
const OUT = process.argv[2]; const BACKUP = process.argv[3];
if (!OUT || !BACKUP) { console.error("사용: node e2e/timetable-solve-ui.cjs <출력 폴더> <백업 .json.gz>"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const report = { problems, checks: {} };
const check = (ok, message, detail) => { if (!ok) { problems.push({ message, detail }); console.log("  ✗", message, detail ? JSON.stringify(detail).slice(0, 500) : ""); } else console.log("  ✓", message); };
const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();

(async () => {
  const { server, url } = await startStaticServer(ROOT);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 }, locale: "ko-KR", deviceScaleFactor: 2, acceptDownloads: true });
  await context.route(/supabase\.co|googleapis|gstatic/, (route) => route.abort());
  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => { if (m.type() === "error") logs.push(`error: ${m.text()}`); });
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  const restore = async (file) => {
    await page.locator("#workspaceDataMenu summary").click();
    const nav = page.waitForEvent("load", { timeout: 30000 }).catch(() => null);
    await page.locator("#restoreWorkspaceBackup").setInputFiles(file);
    await page.locator("#appConfirmDialog[open] #appConfirmOk").click({ timeout: 10000 }).catch(() => {});
    await nav; await sleep(2500);
  };
  await page.goto(url); await page.waitForLoadState("networkidle"); await sleep(1000);
  await restore(BACKUP);
  const panel = page.locator("#workflowStep6Panel");
  const openStep = async () => { await page.getByRole("button", { name: /7\. 시간표/ }).click(); await panel.waitFor({ state: "visible" }); await sleep(500); };
  const summaryOf = async () => panel.locator("#timetableResultSummary").evaluate((el) => ({ text: el.textContent.replace(/\s+/g, " ").trim(), hard: Number(el.dataset.hard), noTeacher: Number(el.dataset.noTeacher), state: el.dataset.state }));
  const gridOf = async () => panel.locator("#timetableGrid").evaluate((table) => ({ view: table.dataset.view, id: table.dataset.id,
    cells: [...table.querySelectorAll("tbody td[data-tt-slot]")].map((td) => ({ slot: td.dataset.ttSlot, clash: td.dataset.clash === "1", text: td.textContent.replace(/\s+/g, " ").trim() })) }));
  const waitResult = async (timeout) => { await panel.locator("#timetableRunBar[data-state='done'], #timetableRunBar[data-state='stale']").waitFor({ timeout }); await sleep(300); };

  console.log("▶ 시간표 계산");
  await openStep();
  const bar = panel.locator("#timetableRunBar");
  check((await bar.getAttribute("data-state")) === "idle" && /시간표 계산/.test(clean(await panel.locator("#timetableRun").innerText())), "처음: '시간표 계산' 단추(결과 없음)", clean(await bar.innerText()));
  check((await panel.locator("#timetableResult").count()) === 0, "계산 전에는 결과 영역이 없음");
  const started = Date.now();
  await panel.locator("#timetableRun").click();
  await panel.locator("#timetableRunProgress").waitFor({ timeout: 10000 });
  await sleep(2500);
  const progress = clean(await panel.locator("#timetableRunProgress").innerText());
  check(/계산 중 \d+% · \d+초 · \d+개 동시에/.test(progress) && /중단해도 그때까지 가장 좋은 답/.test(progress), `진행 표시: ${progress.slice(0, 70)}`);
  check(await panel.locator("#timetableStop").isEnabled(), "계산 중에는 '중단' 단추");
  await page.screenshot({ path: path.join(OUT, "01-running.png") });
  await waitResult(240000);
  const seconds = Math.round((Date.now() - started) / 1000);
  const first = await summaryOf();
  report.checks.first = { seconds, summary: first };
  check(/1학기 — /.test(first.text) && /담당 교사 없음 \d+시간/.test(first.text) && /개 중 가장 좋은 답/.test(first.text), `결과 요약(${seconds}초): ${first.text.slice(0, 150)}`);
  check((await panel.locator("#timetableValidation").count()) === 0, "결과 검증 오류 없음(반·교사 겹침, 불가 시간, 전공 일치, 시수)");
  check((await bar.getAttribute("data-state")) === "done" && /다시 계산/.test(clean(await panel.locator("#timetableRun").innerText())), "계산 뒤: '시간표 다시 계산' + 지금 조건으로 계산한 결과");

  console.log("▶ 반 시간표·교사 시간표");
  const classGrid = await gridOf();
  const filled = classGrid.cells.filter((cell) => cell.text);
  check(classGrid.view === "class" && classGrid.cells.length === 35 && filled.length >= 30 && !classGrid.cells.some((cell) => cell.clash), `반 시간표 ${classGrid.id}반: 35칸 중 ${filled.length}칸, 겹친 칸 없음`, classGrid.cells.slice(0, 8));
  check(classGrid.cells.some((cell) => /창체/.test(cell.text)), "반 시간표에 창체");
  check((await panel.locator("#timetableGrid .tt-lunch").count()) === 1, "반 시간표에 점심 줄");
  const classOptions = await panel.locator("#timetableGridPick option").evaluateAll((els) => els.map((el) => el.value));
  check(classOptions.length >= 30, `반 고르기 ${classOptions.length}개`);
  const third = classOptions.find((id) => id.startsWith("3-"));
  await panel.locator("#timetableGridPick").selectOption(third); await sleep(300);
  const thirdGrid = await gridOf();
  check(thirdGrid.id === third && thirdGrid.cells.some((cell) => /블록/.test(cell.text)), `${third}반: 블록 칸이 보임`, thirdGrid.cells.filter((cell) => cell.text).slice(0, 6));
  await page.screenshot({ path: path.join(OUT, "02-class-grid.png"), fullPage: true });
  await panel.locator('[data-tt-view="teacher"]').click(); await sleep(300);
  const teacherGrid = await gridOf();
  const teacherFilled = teacherGrid.cells.filter((cell) => cell.text);
  check(teacherGrid.view === "teacher" && teacherFilled.length > 0 && teacherGrid.cells.length === 40, `교사 시간표(${teacherGrid.id}): 실제 시각 8줄 × 5일, ${teacherFilled.length}시간`, teacherGrid.cells.length);
  const rows = await panel.locator("#timetableGrid tbody th").allInnerTexts();
  check(rows.some((text) => /4교시\(1·2학년\)/.test(text)) && rows.some((text) => /4교시\(3학년\)/.test(text)), "교사 표의 줄: 점심이 다른 학년은 '4교시(1·2학년)'·'4교시(3학년)'로 나뉨", rows);
  const picked = clean(await panel.locator("#timetableGridPick option:checked").innerText());
  check(new RegExp(`\\(${teacherFilled.length}시간\\)`).test(picked), `교사 고르기의 시수 = 표의 칸 수(${picked})`);
  await page.screenshot({ path: path.join(OUT, "03-teacher-grid.png"), fullPage: true });
  await panel.locator('[data-tt-view="class"]').click(); await sleep(200);
  // 엑셀 내려받기: 앱이 붙인 파일 이름(a.download)과 내용(시트 이름)
  await page.evaluate(() => { window.__ttNames = []; const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) window.__ttNames.push(this.download); return click.call(this); }; });
  const [excel] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), panel.locator("#timetableDownload").click()]);
  const excelPath = path.join(OUT, "timetable.xlsx");
  await excel.saveAs(excelPath);
  const excelBytes = fs.readFileSync(excelPath);
  const excelNames = await page.evaluate(() => window.__ttNames);
  check(excelNames.length === 1 && /^\d{4}_\d+차_시간표\.xlsx$/.test(excelNames[0]), `엑셀 파일 이름: ${excelNames[0]}`);
  check(excelBytes.slice(0, 2).toString() === "PK" && excelBytes.length > 20000 && ["1학기 학급", "1학기 교사", "2학기 학급", "2학기 교사", "못 지킨 조건", "담당 교사 없음"].every((name) => excelBytes.includes(Buffer.from(name))),
    `엑셀 내용: ${Math.round(excelBytes.length / 1024)}KB, 시트 6개(학기별 학급·교사 + 못 지킨 조건 + 담당 교사 없음)`);

  console.log("▶ 시간표가 정한 블록 자리를 6단계 블록 시간에 적어 넣기");
  const staleSections = async () => page.evaluate(() => {
    const round = String(state.currentRound);
    return classSectionsSource(round).groups.filter((group) => { const entry = classSectionsEntry(round, group.key, false); return entry?.sectionResult && entry.sectionResult.signature !== classSectionsSignature(classSectionsBuildInput(round, group, entry)); }).map((group) => group.key);
  });
  const staleBefore = await staleSections();
  const blockNote = panel.locator("#timetableBlockNote");
  const differ = Number(await blockNote.getAttribute("data-count"));
  check(differ > 0 && /6단계 블록 시간과 다른 블록 \d+개/.test(clean(await blockNote.innerText())), `블록 자리가 6단계 블록 시간과 다른 블록 ${differ}개 + '적어 넣기' 단추`, clean(await blockNote.innerText()));
  await panel.locator("#timetableWriteBlockTimes").click();
  await page.locator("#appConfirmDialog[open] #appConfirmOk").click({ timeout: 10000 });
  await sleep(600);
  check(new RegExp(`6단계 블록 시간 ${differ}개를 시간표의 블록 자리로 적어 넣었습니다`).test(clean(await panel.locator("#timetableRunStatus").innerText())), "적어 넣은 뒤 안내 문구");
  check((await blockNote.getAttribute("data-count")) === "0" && /같습니다/.test(clean(await blockNote.innerText())), "적어 넣은 뒤: 6단계 블록 시간 = 시간표 블록 자리");
  check((await bar.getAttribute("data-state")) === "done", "시간표 결과는 그대로 지금 조건의 결과(바뀌기 전 표시 없음)");
  const staleAfter = await staleSections();
  check(staleAfter.length === staleBefore.length, "6단계 분반 결과가 '입력 변경됨'이 되지 않음(서명 함께 갱신)", { staleBefore, staleAfter });
  await page.getByRole("button", { name: /6\. 분반 편성/ }).click(); await sleep(1200);
  const sixTimes = await page.locator("#workflowStep8Panel [data-cs-block-times]").evaluateAll((els) => els.map((el) => el.value));
  check(sixTimes.length > 0 && sixTimes.every((value) => /^[월화수목금]\d(,[월화수목금]\d)*$/.test(value)), `6단계 화면의 블록 시간 칸에 시간표 값(${sixTimes.slice(0, 3).join(" / ")})`, sixTimes);
  await page.screenshot({ path: path.join(OUT, "03b-six-block-times.png") });
  await openStep();

  console.log("▶ 못 지킨 조건·담당 교사 없음·학기 탭");
  const noTeacher = await panel.locator("#timetableNoTeacher").count() ? await panel.locator("#timetableNoTeacher").evaluate((el) => ({ hours: Number(el.dataset.hours), items: [...el.querySelectorAll(".tt-cause")].map((n) => n.textContent.trim()) })) : { hours: 0, items: [] };
  check(noTeacher.hours === first.noTeacher, `담당 교사 없음 목록 합계 = 요약(${noTeacher.hours}시간)`, noTeacher.items.slice(0, 4));
  const violations = await panel.locator("#timetableViolations").count() ? await panel.locator("#timetableViolations").evaluate((el) => ({ hard: Number(el.dataset.hard), soft: Number(el.dataset.soft), items: [...el.querySelectorAll("li[data-level='hard'] .tt-cause")].map((n) => n.textContent.trim()) })) : { hard: 0, soft: 0, items: [] };
  check(violations.hard === first.hard, `못 지킨 '반드시' 조건 목록 = 요약(${violations.hard}건)`, violations.items.slice(0, 4));
  report.checks.semester1 = { noTeacher, violations };
  const bodyText = clean(await panel.innerText()).replace(/순회일사/g, ""); // 하네스 교사 이름(순회일사)은 문구가 아님
  check(!/증원|순회|강사|교사를 늘|명 더 필요/.test(bodyText), "교사를 늘리라는 문구 없음");
  await panel.locator('[data-tt-semester="2"]').click(); await sleep(500);
  const second = await summaryOf();
  report.checks.second = second;
  check(/^2학기 — /.test(second.text), `2학기 탭: ${second.text.slice(0, 110)}`);
  check((await gridOf()).cells.filter((cell) => cell.text).length >= 30, "2학기 반 시간표도 채워짐");
  await page.screenshot({ path: path.join(OUT, "04-semester2.png"), fullPage: true });
  await panel.locator('[data-tt-semester="1"]').click(); await sleep(400);

  console.log("▶ 새로고침 뒤에도 결과 유지");
  await sleep(1200);
  await page.reload(); await page.waitForLoadState("networkidle"); await sleep(2000);
  await openStep();
  const reloaded = await summaryOf();
  check(reloaded.text === first.text && (await bar.getAttribute("data-state")) === "done", "새로고침 뒤 같은 결과 요약(바뀌기 전 표시 없음)", { reloaded: reloaded.text.slice(0, 120) });

  console.log("▶ 조건을 바꾸면 '바뀌기 전 결과' → 중단으로 다시 계산");
  const section = panel.locator('[data-tt-section="rules"]');
  if (!(await section.evaluate((el) => el.open))) { await section.locator("summary").click(); await sleep(200); }
  const run = panel.locator('[data-tt-field="rules.run"]');
  const before = await run.inputValue();
  await run.fill(String(Number(before) + 1)); await run.press("Tab"); await sleep(600);
  check((await bar.getAttribute("data-state")) === "stale" && (await panel.locator("#timetableResultStale").count()) === 1 && /바뀌기 전/.test(clean(await panel.locator("#timetableRunNote").innerText())),
    "규칙(연강 상한)을 바꾸면 결과에 '조건·자료가 바뀌기 전 결과'", clean(await bar.innerText()));
  await page.screenshot({ path: path.join(OUT, "05-stale.png") });
  await panel.locator("#timetableRun").click();
  await panel.locator("#timetableStop").waitFor({ timeout: 10000 });
  await sleep(3000);
  const stopAt = Date.now();
  await panel.locator("#timetableStop").click();
  await waitResult(60000);
  const stopSeconds = Math.round((Date.now() - stopAt) / 100) / 10;
  const stopped = await summaryOf();
  report.checks.stopped = { stopSeconds, summary: stopped };
  check(/중단함/.test(stopped.text) && stopSeconds < 20, `중단 → ${stopSeconds}초 만에 그때까지 가장 좋은 답: ${stopped.text.slice(-60)}`);
  check((await bar.getAttribute("data-state")) === "done" && (await panel.locator("#timetableResultStale").count()) === 0 && (await panel.locator("#timetableValidation").count()) === 0, "다시 계산한 결과는 지금 조건의 것(검증 오류 없음)");
  check((await gridOf()).cells.filter((cell) => cell.text).length >= 30, "중단한 결과도 반 시간표가 빠짐없이 참");

  console.log("▶ 계산 뒤 선택지: 고르면 그 조건으로 다시 계산");
  const total = async () => page.evaluate(() => { const saved = state.timetable[String(state.currentRound)]; return { hard: saved.result.metrics.hard, noTeacher: saved.result.metrics.noTeacherHours, cover: (state.timetable.settings.rules || {}).cover || "hard" }; });
  const beforeChoice = await total();
  const choiceRows = await panel.locator("#timetableResultChoices [data-tt-choice-row]").evaluateAll((els) => els.map((el) => ({ key: el.dataset.ttChoiceRow, text: el.textContent.replace(/\s+/g, " ").trim() })));
  report.checks.choices = { beforeChoice, choiceRows };
  check(beforeChoice.hard > 0 && choiceRows.some((row) => row.key === "releaseTeacher" && /담당 교사 없음/.test(row.text) && /이 선택으로 다시 계산/.test(row.text)),
    `'반드시' 위반 ${beforeChoice.hard}건이 남은 결과에 선택지(${choiceRows.map((row) => row.key).join(", ")})`, choiceRows);
  check(!choiceRows.some((row) => /증원|순회|강사|교사를 늘/.test(row.text)), "선택지에 교사를 늘리는 문구 없음");
  await panel.locator('[data-tt-choice-solve="releaseTeacher"]').click();
  await panel.locator("#timetableRunProgress").waitFor({ timeout: 10000 });
  await waitResult(240000);
  const afterChoice = await total();
  const compareText = clean(await panel.locator("#timetableResultCompare").innerText());
  report.checks.choices.afterChoice = afterChoice; report.checks.choices.compareText = compareText;
  check(afterChoice.cover === "soft" && afterChoice.hard < beforeChoice.hard && afterChoice.noTeacher >= beforeChoice.noTeacher,
    `'공강 먼저'로 다시 계산: '반드시' ${beforeChoice.hard} → ${afterChoice.hard}건, 담당 교사 없음 ${beforeChoice.noTeacher} → ${afterChoice.noTeacher}시간`, afterChoice);
  check(new RegExp(`'반드시' 조건 ${beforeChoice.hard} → ${afterChoice.hard}건 · 담당 교사 없음 ${beforeChoice.noTeacher} → ${afterChoice.noTeacher}시간 — 고른 선택: 공강·하루 두 번이 남으면`).test(compareText), `앞 결과와 견줌: ${compareText.slice(0, 110)}`);
  check((await panel.locator("#timetableValidation").count()) === 0 && (await bar.getAttribute("data-state")) === "done", "선택 뒤 결과도 검증 오류 없음·지금 조건의 결과");
  const chosen = clean(await panel.locator("#timetableChosen").innerText());
  check(/고른 선택 1개/.test(chosen) && /공강 먼저/.test(chosen), `고른 내역: ${chosen.slice(0, 80)}`);
  if (afterChoice.noTeacher > beforeChoice.noTeacher) {
    const reasons = await panel.locator("#timetableNoTeacher .tt-cause").allInnerTexts();
    const other = clean(await panel.locator('[data-tt-semester="2"]').innerText()) && reasons;
    await panel.locator('[data-tt-semester="2"]').click(); await sleep(300);
    const reasons2 = await panel.locator("#timetableNoTeacher .tt-cause").allInnerTexts();
    await panel.locator('[data-tt-semester="1"]').click(); await sleep(300);
    check([...other, ...reasons2].some((text) => /공강·하루 두 번을 없애려고 비움\('공강 먼저'\)/.test(text)), "담당 교사 없음 목록에 이유 '공강·하루 두 번을 없애려고 비움'", [...reasons, ...reasons2].slice(0, 6));
  }
  await page.screenshot({ path: path.join(OUT, "06-after-choice.png"), fullPage: true });
  await panel.locator("#timetableChoiceUndo").click(); await sleep(600);
  check((await total()).cover === "hard" && (await bar.getAttribute("data-state")) === "stale", "마지막 선택 되돌리기 → 규칙이 돌아가고 결과는 '바뀌기 전 결과'");
  await panel.locator("#timetableRun").click();
  await waitResult(240000);
  const latest = await summaryOf();

  console.log("▶ 백업 내려받기 → 복원 뒤에도 결과 유지");
  await sleep(1200);
  await page.locator("#workspaceDataMenu summary").click();
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.locator("#downloadWorkspaceBackup").click()]);
  const saved = path.join(OUT, "with-timetable.json.gz");
  await download.saveAs(saved);
  await restore(saved);
  await openStep();
  const restored = await summaryOf();
  check(restored.text === latest.text, "백업 복원 뒤 같은 결과 요약", restored.text.slice(0, 120));

  check(logs.length === 0, "콘솔 오류 없음", logs.slice(0, 5));
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
  await browser.close(); server.close();
  console.log(problems.length ? `\n문제 ${problems.length}건` : "\n모두 통과");
  process.exit(problems.length ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
