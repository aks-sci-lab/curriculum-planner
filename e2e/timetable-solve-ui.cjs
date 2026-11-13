// 7단계 시간표 계산 화면 확인(사용자처럼 클릭): 하네스 백업(가상 학생) 복원 → 메뉴 '7. 시간표'
// ① '시간표 계산' → 진행 표시 → 결과 요약(반드시 위반·담당 교사 없음)·반 시간표·교사 시간표 ② 반·교사 고르기, 학기 탭
// ③ 조건을 바꾸면 '바뀌기 전 결과' 표시 → 다시 계산하면 사라짐 ④ 계산 중 '중단' → 그때까지 가장 좋은 답
// ④-1 직접 고치기: 블록 한 시간 옮기기(그 블록을 듣는 모든 반 함께), 반 시간표의 두 칸 맞바꾸기(창체 칸·교사 겹침은 이유와 함께 거절), 되돌리기
// ④-1b 칸 고정 · 담당 교사 바꾸기 → 교사 고정 → 고정을 지키며 다시 계산(고정한 칸은 맞바꿀 수 없음, 고정한 교사는 바꿀 수 없음), 고정 모두 풀기
// ④-2 시간표가 정한 블록 자리를 6단계 블록 시간에 적어 넣기(6단계 결과는 '입력 변경됨'이 되지 않음)
// ①-2 구조상 하한 줄(실제 수 — 그중 피할 수 없는 수), 더 오래 계산(다른 씨앗으로 한 번 더, 나아질 때만 바꿈)
// ⑤ 계산 뒤 선택지: 남은 '반드시' 위반에 '교사 규칙 양보' 등을 고르면 그 조건으로 다시 계산, 앞 결과와 견줌, 고른 내역·되돌리기 ⑥ 새로고침·백업 복원 뒤에도 결과 유지 ⑦ 콘솔 오류 없음
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

  // 여러 씨앗으로 함께 푼 효과: 일꾼마다의 '반드시' 위반 수와 고른 답
  const tries = await panel.locator("#timetableTries span[data-seed]").evaluateAll((els) => els.map((el) => ({ seed: Number(el.dataset.seed), hard: Number(el.dataset.hard), picked: el.dataset.picked === "1" })));
  report.checks.tries = tries;
  const pickedTry = tries.find((item) => item.picked);
  check(tries.length >= 2 && Boolean(pickedTry) && pickedTry.hard === Math.min(...tries.map((item) => item.hard)), `일꾼별 '반드시' 위반: ${tries.map((item) => `씨앗 ${item.seed} ${item.hard}건${item.picked ? "(고름)" : ""}`).join(" · ")} — 가장 적은 답을 고름`, tries);
  const openGoto = await panel.locator("#timetableNoTeacher [data-tt-open-department] .tt-goto").count();
  check(openGoto >= 1, `담당 교사 없음 목록의 교양 과목에 '5단계 담당 교과' 바로가기(${openGoto}개)`);

  // 구조상 하한: 결과 요약 아래에 '실제 수 — 그중 피할 수 없는 수'(사전 점검이 계산한 값)
  const bounds = await panel.locator("#timetableBounds li").evaluateAll((els) => els.map((el) => ({ kind: el.dataset.bound, actual: Number(el.dataset.actual), min: Number(el.dataset.min), text: el.textContent.replace(/\s+/g, " ").trim() })));
  report.checks.bounds = bounds;
  const noTeacherBound = bounds.find((line) => line.kind === "noTeacher");
  check(Boolean(noTeacherBound) && noTeacherBound.actual === first.noTeacher && noTeacherBound.min >= 1 && noTeacherBound.min <= noTeacherBound.actual && /담당 교사 없음 \d+시간 — (모두|그중 \d+시간은) 지금 명단·조건에서 피할 수 없습니다/.test(noTeacherBound.text),
    `구조상 하한: ${noTeacherBound?.text.slice(0, 70)}`, bounds);

  console.log("▶ 더 오래 계산(다른 씨앗으로 한 번 더 — 나아질 때만 바꿈)");
  await panel.locator("#timetableRunMore").click();
  await panel.locator("#timetableRunProgress").waitFor({ timeout: 10000 });
  await sleep(4000);
  await panel.locator("#timetableStop").click().catch(() => {}); // 오래 기다리지 않게 중단(그때까지 가장 좋은 답으로 견줌)
  await waitResult(120000);
  const more = await panel.locator("#timetableMore").evaluate((el) => ({ replaced: el.dataset.replaced === "1", tried: Number(el.dataset.tried), text: el.textContent.replace(/\s+/g, " ").trim() }));
  const afterMore = await summaryOf();
  const moreTries = await panel.locator("#timetableTries span[data-seed]").evaluateAll((els) => els.map((el) => Number(el.dataset.seed)));
  report.checks.more = { more, afterMore, moreTries };
  check(more.tried >= 1 && /^더 오래 계산\(씨앗 \d+~\d+, \d+개/.test(more.text) && (more.replaced ? /더 나은 답으로 바꿨습니다/.test(more.text) : /더 나은 답이 없어 지금 결과를 그대로 뒀습니다/.test(more.text)), `더 오래 계산: ${more.text.slice(0, 120)}`);
  check(moreTries.length === tries.length + more.tried && new Set(moreTries).size === moreTries.length && Math.min(...moreTries.slice(tries.length)) > Math.max(...tries.map((item) => item.seed)), `씨앗이 겹치지 않게 이어서 계산(${tries.length}개 → ${moreTries.length}개)`, moreTries);
  check((more.replaced || afterMore.text.replace(/ · \d+월.*$/, "") === first.text.replace(/ · \d+월.*$/, "")) && (await bar.getAttribute("data-state")) === "done" && (await panel.locator("#timetableValidation").count()) === 0,
    more.replaced ? "더 나은 답으로 바뀜(검증 오류 없음)" : "더 나은 답이 없으면 결과는 그대로(검증 오류 없음)");

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
  console.log("▶ 직접 고치기: 두 칸 맞바꾸기·거절 이유·되돌리기");
  const editStatus = async () => ((await panel.locator("#timetableEditStatus").count()) ? clean(await panel.locator("#timetableEditStatus").innerText()) : "");
  const cellAt = (slot) => panel.locator(`#timetableGrid td[data-tt-edit="${slot}"]`);
  // 블록 한 시간 옮기기(3학년 반): 블록 칸을 누르면 옮길 수 있는 칸이 표시되고, 옮기면 그 블록을 듣는 모든 반에서 함께 옮겨진다
  const thirdClass = await panel.locator("#timetableGridPick").inputValue();
  const thirdCells = (await gridOf()).cells;
  const blockCells = thirdCells.filter((cell) => /블록/.test(cell.text));
  await cellAt(blockCells[0].slot).click(); await sleep(500);
  check((await cellAt(blockCells[0].slot).getAttribute("aria-pressed")) === "true" && /블록(을 옮길 수 있는 칸 \d+곳을 표시했습니다|은 지금 옮길 수 있는 칸이 없습니다)/.test(await editStatus()), `블록 칸을 누르면 고른 표시 + 안내: ${(await editStatus()).slice(0, 110)}`);
  await cellAt(blockCells[0].slot).click(); await sleep(200);
  let blockMoved = null; const blockTried = [];
  for (const cell of blockCells.slice(0, 12)) {
    await cellAt(cell.slot).click(); await sleep(500);
    const marks = await panel.locator("#timetableGrid td[data-tt-can]").evaluateAll((els) => els.map((el) => { const copy = el.cloneNode(true); copy.querySelectorAll(".tt-change-badge").forEach((node) => node.remove());
      return { slot: el.dataset.ttEdit, can: el.dataset.ttCan === "1", change: el.dataset.ttChange === undefined ? null : Number(el.dataset.ttChange), more: el.dataset.ttMore === "1", badge: el.querySelector(".tt-change-badge")?.textContent || "", title: el.title, text: copy.textContent.replace(/\s+/g, " ").trim() }; }));
    const able = marks.filter((mark) => mark.can);
    blockTried.push({ slot: cell.slot, able: able.length, reasons: [...new Set(marks.filter((mark) => !mark.can).map((mark) => mark.title.slice(0, 60)))].slice(0, 3) });
    if (!able.length) { await cellAt(cell.slot).click(); await sleep(150); continue; }
    const target = able.find((mark) => !/블록/.test(mark.text)) || able[0];
    await cellAt(target.slot).click(); await sleep(500);
    blockMoved = { from: cell, to: target, status: await editStatus() };
    break;
  }
  report.checks.blockMove = { moved: blockMoved, tried: blockTried };
  check(blockTried.every((item) => item.able > 0 || item.reasons.length > 0), `옮길 수 없는 칸에는 이유(예: ${blockTried.find((item) => item.reasons.length)?.reasons[0] || "없음"})`);
  if (blockMoved) {
    check(/^블록을 옮겼습니다 — 3학년 .+(→|↔)/.test(blockMoved.status), `블록 한 시간 옮기기: ${blockMoved.status.slice(0, 140)}`);
    const nowThird = (await gridOf()).cells;
    const at = (cells, slot) => cells.find((cell) => cell.slot === slot)?.text || "";
    check(at(nowThird, blockMoved.to.slot) === blockMoved.from.text && at(nowThird, blockMoved.from.slot) === blockMoved.to.text, `이 반 표: ${blockMoved.to.slot}에 ${blockMoved.from.text.slice(0, 14)}, ${blockMoved.from.slot}에 ${blockMoved.to.text.slice(0, 14) || "빈칸"}`);
    // 같은 학년 다른 반에서도 그 블록이 같은 칸으로 옮겨졌다
    const sibling = classOptions.filter((id) => id.startsWith("3-") && id !== thirdClass).pop();
    await panel.locator("#timetableGridPick").selectOption(sibling); await sleep(300);
    check(at((await gridOf()).cells, blockMoved.to.slot) === blockMoved.from.text, `${sibling}반 표에서도 ${blockMoved.to.slot}에 ${blockMoved.from.text.slice(0, 14)}`);
    check((await panel.locator("#timetableEdits").getAttribute("data-count")) === "1" && (await panel.locator("#timetableValidation").count()) === 0 && (await bar.getAttribute("data-state")) === "done", "블록을 옮긴 뒤에도 검증 오류 없음·'직접 고침 1번'");
    await page.screenshot({ path: path.join(OUT, "03b-block-move.png"), fullPage: true });
    await panel.locator("#timetableEditUndo").click(); await sleep(300);
    await panel.locator("#timetableGridPick").selectOption(thirdClass); await sleep(300);
    check(JSON.stringify((await gridOf()).cells.map((cell) => cell.text)) === JSON.stringify(thirdCells.map((cell) => cell.text)) && (await panel.locator("#timetableEdits").count()) === 0, "되돌리기 → 블록이 제자리로");
  } else console.log(`  (이 자료에서는 살펴본 블록 칸 ${blockTried.length}곳 모두 옮길 수 있는 칸이 없음)`);
  // 창체 칸은 옮길 수 없다
  const creativeCell = thirdCells.find((cell) => /창체/.test(cell.text));
  const lessonCell = thirdCells.find((cell) => cell.text && !/블록|창체/.test(cell.text));
  if (creativeCell && lessonCell) {
    await cellAt(lessonCell.slot).click(); await sleep(500);
    await cellAt(creativeCell.slot).click(); await sleep(300);
    check(/바꾸지 않았습니다 — .*창체 시간이라 옮길 수 없습니다/.test(await editStatus()), `창체 칸은 거절 + 이유: ${(await editStatus()).slice(0, 80)}`);
  }
  // 1학년 반: 반 수업 칸을 누르면 맞바꿀 수 있는 칸이 표시된다 → 표시된 칸을 눌러 맞바꾸기, 표시 안 된 칸은 이유와 함께 거절
  await panel.locator("#timetableGridPick").selectOption(classOptions[0]); await sleep(300);
  const original = (await gridOf()).cells;
  const lessons = original.filter((cell) => cell.text && !/블록|창체/.test(cell.text));
  let swapped = null; const refusals = [];
  for (const lesson of lessons) {
    await cellAt(lesson.slot).click(); await sleep(400);
    const marks = await panel.locator("#timetableGrid td[data-tt-can]").evaluateAll((els) => els.map((el) => { const copy = el.cloneNode(true); copy.querySelectorAll(".tt-change-badge").forEach((node) => node.remove());
      return { slot: el.dataset.ttEdit, can: el.dataset.ttCan === "1", change: el.dataset.ttChange === undefined ? null : Number(el.dataset.ttChange), more: el.dataset.ttMore === "1", badge: el.querySelector(".tt-change-badge")?.textContent || "", title: el.title, text: copy.textContent.replace(/\s+/g, " ").trim() }; }));
    const able = marks.filter((mark) => mark.can && mark.text && mark.text !== lesson.text);
    const blocked = marks.find((mark) => !mark.can && mark.text && !/블록|창체/.test(mark.text) && /겹칩니다|불가 시간/.test(mark.title));
    if (!able.length) { await cellAt(lesson.slot).click(); await sleep(150); continue; } // 취소하고 다음 칸
    report.checks.editMarks = { picked: lesson.slot, able: marks.filter((mark) => mark.can).length, blocked: marks.filter((mark) => !mark.can).length, status: await editStatus() };
    check(/맞바꿀 수 있는 칸 \d+곳을 표시했습니다/.test(await editStatus()) && marks.length === 34, `${lesson.slot}(${lesson.text.slice(0, 12)})을 누르면 맞바꿀 수 있는 칸 ${marks.filter((mark) => mark.can).length}곳 표시(나머지 ${marks.filter((mark) => !mark.can).length}곳은 흐리게)`);
    if (blocked) {
      await cellAt(blocked.slot).click(); await sleep(300);
      refusals.push(await editStatus());
      check(/^바꾸지 않았습니다 — .+(겹칩니다|불가 시간)/.test(refusals[0]) && blocked.title.length > 5, `표시 안 된 칸을 누르면 거절 + 이유: ${refusals[0].slice(0, 90)}`);
      await cellAt(lesson.slot).click(); await sleep(400);
    }
    // 위반 미리보기: 옮길 수 있는 칸마다 '반드시' 위반이 몇 건 늘거나 주는지(늘지 않음 = 초록, 늘어남 = 노랑 + '+n' + 설명)
    const canMarks = marks.filter((mark) => mark.can);
    const moreMarks = canMarks.filter((mark) => mark.change > 0);
    report.checks.editPreview = { able: canMarks.length, clean: canMarks.filter((mark) => mark.change <= 0).length, more: moreMarks.length, example: moreMarks[0] ? { badge: moreMarks[0].badge, title: moreMarks[0].title } : null };
    check(canMarks.every((mark) => Number.isFinite(mark.change) && mark.more === (mark.change > 0) && /'반드시' 위반/.test(mark.title))
      && moreMarks.every((mark) => mark.badge === `+${mark.change}` && new RegExp(`'반드시' 위반이 ${mark.change}건 늘어납니다`).test(mark.title))
      && /초록 = '반드시' 위반이 늘지 않는 칸 \d+곳/.test(await editStatus()),
    `위반 미리보기: 늘지 않는 칸 ${canMarks.length - moreMarks.length}곳(초록) · 늘어나는 칸 ${moreMarks.length}곳(노랑${moreMarks[0] ? `, 예: ${moreMarks[0].slot} ${moreMarks[0].badge} — ${moreMarks[0].title.slice(0, 60)}` : ""})`);
    const hardBefore = (await summaryOf()).hard;
    const pickedTarget = able.find((mark) => mark.change <= 0) || able[0];
    await cellAt(pickedTarget.slot).click(); await sleep(300);
    const text = await editStatus();
    if (/^맞바꿨습니다/.test(text)) swapped = { a: lesson, b: { slot: pickedTarget.slot, text: pickedTarget.text }, text };
    // 미리 본 수만큼 실제 요약이 바뀐다(이 학기 요약은 그 학기 위반만 세므로 두 학기 합계 변화 이하), 상태 줄에 변화가 적힌다
    const hardAfter = (await summaryOf()).hard;
    check(/'반드시' 위반 (수는 그대로|\d+ → \d+건)/.test(text) && (pickedTarget.change === 0 ? hardAfter === hardBefore : Math.abs(hardAfter - hardBefore) <= Math.abs(pickedTarget.change)),
      `고친 뒤 상태 줄에 위반 변화: ${text.slice(text.indexOf(" · ") + 3, text.indexOf(" · ") + 70)} (요약 ${hardBefore} → ${hardAfter}건, 미리보기 ${pickedTarget.change >= 0 ? "+" : ""}${pickedTarget.change})`);
    break;
  }
  report.checks.edit = { swapped, refusals };
  check(Boolean(swapped), `표시된 칸을 눌러 두 칸 맞바꾸기: ${swapped?.text}`, refusals.slice(0, 3));
  if (swapped) {
    const now = (await gridOf()).cells;
    const textAt = (cells, slot) => cells.find((cell) => cell.slot === slot).text;
    check(textAt(now, swapped.a.slot) === swapped.b.text && textAt(now, swapped.b.slot) === swapped.a.text, "표에서 두 칸의 내용이 서로 바뀜");
    check((await panel.locator("#timetableEdits").getAttribute("data-count")) === "1" && /되돌리기\(1\)/.test(clean(await panel.locator("#timetableEditUndo").innerText())), "요약에 '직접 고침 1번', 되돌리기(1)");
    check((await panel.locator("#timetableValidation").count()) === 0 && (await bar.getAttribute("data-state")) === "done", "고친 뒤에도 검증 오류 없음·지금 조건의 결과");
    await page.screenshot({ path: path.join(OUT, "03c-edit.png"), fullPage: true });
    await panel.locator("#timetableEditUndo").click(); await sleep(300);
    const back = (await gridOf()).cells;
    check(/^되돌렸습니다/.test(await editStatus()) && JSON.stringify(back.map((cell) => cell.text)) === JSON.stringify(original.map((cell) => cell.text)) && (await panel.locator("#timetableEdits").count()) === 0, "되돌리기 → 표가 처음과 같고 '직접 고침' 표시 없음");
  }

  // 낱장 인쇄: 인쇄 창을 띄우지 않고(window.print 대신 기록) 인쇄 영역의 내용을 본다
  await page.evaluate(() => { window.__ttPrints = 0; window.print = () => { window.__ttPrints += 1; }; });
  await panel.locator("#timetablePrintOne").click(); await sleep(300);
  const printOne = await page.evaluate(() => ({ prints: window.__ttPrints, cards: [...document.querySelectorAll("#printBatch .tt-print-card")].map((el) => el.querySelector("h3").textContent.trim()), pages: document.querySelectorAll("#printBatch .print-page").length }));
  check(printOne.prints === 1 && printOne.cards.length === 1 && /^\d{4}학년도 1학기 \d-\d+반 시간표$/.test(printOne.cards[0]), `이 반 인쇄: ${printOne.cards[0]}`, printOne);
  await panel.locator("#timetablePrintAll").click(); await sleep(500);
  const printAll = await page.evaluate(() => ({ prints: window.__ttPrints, cards: document.querySelectorAll("#printBatch .tt-print-card").length, pages: document.querySelectorAll("#printBatch .print-page").length,
    cells: document.querySelectorAll("#printBatch .tt-print-card:first-child td strong").length }));
  check(printAll.prints === 2 && printAll.cards === classOptions.length && printAll.pages === Math.ceil(classOptions.length / 2) && printAll.cells >= 30, `반 전체 인쇄: ${printAll.cards}개 반 · ${printAll.pages}장(한 장에 2개)`, printAll);
  await panel.locator('[data-tt-view="teacher"]').click(); await sleep(200);
  await panel.locator("#timetablePrintOne").click(); await sleep(300);
  const printTeacher = await page.evaluate(() => [...document.querySelectorAll("#printBatch .tt-print-card h3")].map((el) => el.textContent.replace(/\s+/g, " ").trim()));
  check(printTeacher.length === 1 && /선생님 시간표 주 \d+시간$/.test(printTeacher[0]), `이 교사 인쇄: ${printTeacher[0]}`);
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
  // 6단계 학생 이동수업 시간표: 블록 시간을 적어 넣은 뒤에는 빈칸에 7단계 시간표의 반 수업(과목·교사)이 채워진다(내년 반을 아는 학생만)
  if (await page.locator("#classSectionsTimetablePrint").count()) {
    await page.locator("#classSectionsTimetablePrint").click(); await sleep(1500);
    const sixPrint = await page.evaluate(() => { const cards = [...document.querySelectorAll("#printBatch .cs-tt")];
      return { cards: cards.length, mapped: cards.filter((el) => /내년 \d학년 \d+반/.test(el.querySelector("header p")?.textContent || "")).length,
        lessonCells: document.querySelectorAll('#printBatch .cs-tt td[data-kind="lesson"]').length, moveCells: document.querySelectorAll('#printBatch .cs-tt td[data-kind="move"]').length,
        sample: [...document.querySelectorAll('#printBatch .cs-tt td[data-kind="lesson"]')].slice(0, 3).map((td) => td.textContent.trim()) }; });
    report.checks.sixStudentTimetable = sixPrint;
    check(sixPrint.cards > 0 && sixPrint.moveCells > 0 && (sixPrint.mapped === 0 || sixPrint.lessonCells > 0), `6단계 학생 시간표 ${sixPrint.cards}명: 이동수업 칸 ${sixPrint.moveCells}개, 반 수업 칸 ${sixPrint.lessonCells}개(내년 반을 아는 학생 ${sixPrint.mapped}명)${sixPrint.sample.length ? ` 예: ${sixPrint.sample[0]}` : ""}`, sixPrint);
  }
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
  check(reloaded.text === afterMore.text && (await bar.getAttribute("data-state")) === "done" && (await panel.locator("#timetableMore").count()) === 1, "새로고침 뒤 같은 결과 요약(바뀌기 전 표시 없음, 더 오래 계산 기록 유지)", { reloaded: reloaded.text.slice(0, 120) });

  console.log("▶ 조건을 바꾸면 '바뀌기 전 결과' → 중단으로 다시 계산");
  const section = panel.locator('[data-tt-section="rules"]');
  if (!(await section.evaluate((el) => el.open))) { await section.locator(":scope > summary").click(); await sleep(200); }
  const run = panel.locator('[data-tt-field="rules.run"]');
  const before = await run.inputValue();
  await run.fill("2"); await run.press("Tab"); await sleep(600); // 연강 상한을 2로 조여 '반드시' 위반이 남게 한다(뒤의 선택지 확인용)
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
  const total = async () => page.evaluate(() => { const saved = state.timetable[String(state.currentRound)]; return { hard: saved.result.metrics.hard, noTeacher: saved.result.metrics.noTeacherHours, run: (state.timetable.settings.rules || {}).run, cover: (state.timetable.settings.rules || {}).cover || "hard" }; });
  const beforeChoice = await total();
  const choiceRows = await panel.locator("#timetableResultChoices [data-tt-choice-row]").evaluateAll((els) => els.map((el) => ({ key: el.dataset.ttChoiceRow, recommended: el.dataset.recommended === "1", text: el.textContent.replace(/\s+/g, " ").trim() })));
  report.checks.choices = { beforeChoice, choiceRows };
  check(beforeChoice.hard > 0 && choiceRows.some((row) => row.key === "teacherRules" && /연강 4시간/.test(row.text) && /이 선택으로 다시 계산/.test(row.text)),
    `'반드시' 위반 ${beforeChoice.hard}건이 남은 결과에 선택지(${choiceRows.map((row) => row.key).join(", ")})`, choiceRows);
  check(!choiceRows.some((row) => /증원|순회|강사|교사를 늘/.test(row.text)), "선택지에 교사를 늘리는 문구 없음");
  // 두 학기 같은 칸 결과에 교사 점심·연강이 남아 있으면 '블록 순서를 학기마다 다르게 허용'이 맨 위에 추천으로 나온다
  const teacherLeft = await page.evaluate(() => { const saved = state.timetable[String(state.currentRound)]; const m = saved.result.metrics; return { mode: m.frameMode, lunch: m.lunch, run: m.run }; });
  if (teacherLeft.mode === "hard" && teacherLeft.lunch + teacherLeft.run > 0 && choiceRows.some((row) => row.key === "frameOrder")) {
    check(choiceRows[0].key === "frameOrder" && choiceRows[0].recommended && /^추천 블록 순서를 학기마다 다르게 허용/.test(choiceRows[0].text) && /두 학기 같은 칸에서는 .*(점심|연강) \d+건이 남았습니다/.test(choiceRows[0].text)
      && choiceRows.filter((row) => row.recommended).length === 1, `같은 칸 결과에 점심 ${teacherLeft.lunch}·연강 ${teacherLeft.run}건 → 맨 위 추천: ${choiceRows[0].text.slice(0, 120)}`);
  } else console.log(`  (추천 선택지 확인 건너뜀: 뼈대 ${teacherLeft.mode}, 점심 ${teacherLeft.lunch}, 연강 ${teacherLeft.run})`);
  await panel.locator('[data-tt-choice-solve="teacherRules"]').click();
  await panel.locator("#timetableRunProgress").waitFor({ timeout: 10000 });
  await waitResult(240000);
  const afterChoice = await total();
  const compareText = clean(await panel.locator("#timetableResultCompare").innerText());
  report.checks.choices.afterChoice = afterChoice; report.checks.choices.compareText = compareText;
  check(afterChoice.run === 4 && afterChoice.hard < beforeChoice.hard,
    `'교사 규칙 양보'로 다시 계산: 연강 상한 2 → 4, '반드시' ${beforeChoice.hard} → ${afterChoice.hard}건`, afterChoice);
  check(new RegExp(`'반드시' 조건 ${beforeChoice.hard} → ${afterChoice.hard}건 · 담당 교사 없음 ${beforeChoice.noTeacher} → ${afterChoice.noTeacher}시간 — 고른 선택: 교사 규칙 양보`).test(compareText), `앞 결과와 견줌: ${compareText.slice(0, 110)}`);
  check((await panel.locator("#timetableValidation").count()) === 0 && (await bar.getAttribute("data-state")) === "done", "선택 뒤 결과도 검증 오류 없음·지금 조건의 결과");
  const chosen = clean(await panel.locator("#timetableChosen").innerText());
  check(/고른 선택 1개/.test(chosen) && /교사 규칙 양보/.test(chosen), `고른 내역: ${chosen.slice(0, 80)}`);
  await page.screenshot({ path: path.join(OUT, "06-after-choice.png"), fullPage: true });
  await panel.locator("#timetableChoiceUndo").click(); await sleep(600);
  check((await total()).run === 2 && (await bar.getAttribute("data-state")) === "stale", "마지막 선택 되돌리기 → 규칙이 돌아가고(연강 상한 2) 결과는 '바뀌기 전 결과'");
  await panel.locator("#timetableRun").click();
  await waitResult(240000);
  console.log("▶ 칸 고정 → 고정을 지키며 다시 계산");
  if (!(await panel.locator('[data-tt-view="class"]').getAttribute("aria-pressed")) || (await panel.locator('[data-tt-view="class"]').getAttribute("aria-pressed")) !== "true") { await panel.locator('[data-tt-view="class"]').click(); await sleep(200); }
  await panel.locator("#timetableGridPick").selectOption(classOptions[0]); await sleep(300);
  const pinCells = (await gridOf()).cells.filter((cell) => cell.text && !/블록|창체/.test(cell.text));
  const pinTarget = pinCells[Math.floor(pinCells.length / 2)];
  await cellAt(pinTarget.slot).click(); await sleep(400);
  const pinButton = clean(await panel.locator("#timetablePin").innerText());
  await panel.locator("#timetablePin").click(); await sleep(400);
  check(/이 칸에 고정/.test(pinButton) && /고정했습니다 — 다시 계산해도 이 수업은 이 칸에 둡니다/.test(await editStatus()), `칸 고정: ${pinButton} → ${(await editStatus()).slice(0, 60)}`);
  check((await cellAt(pinTarget.slot).getAttribute("data-tt-pinned")) === "1" && /고정$/.test(clean(await cellAt(pinTarget.slot).innerText())) && (await panel.locator("#timetablePinCount").getAttribute("data-count")) === "1", "고정한 칸에 '고정' 표시, '고정 1칸'");
  check((await bar.getAttribute("data-state")) === "done", "이미 그 자리에 있는 칸을 고정해도 결과는 '바뀌기 전 결과'가 되지 않음");
  // 고정한 칸은 맞바꿀 수 없다(이유: 고정한 칸)
  await cellAt(pinTarget.slot).click(); await sleep(400);
  const pinMarks = await panel.locator("#timetableGrid td[data-tt-can]").evaluateAll((els) => els.map((el) => ({ can: el.dataset.ttCan === "1", title: el.title })));
  check(pinMarks.length > 0 && pinMarks.every((mark) => !mark.can) && pinMarks.some((mark) => /고정한 칸/.test(mark.title)), "고정한 칸을 누르면 맞바꿀 수 있는 칸이 없고 이유는 '고정한 칸'", pinMarks.slice(0, 2));
  await cellAt(pinTarget.slot).click(); await sleep(200);
  // 담당 교사 바꾸기·교사 고정: 반 수업 칸을 고르면 후보(전공 일치 교사)가 나오고, 설 수 있는 교사로 바꾼 뒤 그 교사로 고정
  console.log("▶ 담당 교사 바꾸기 → 교사 고정");
  const partsAt = async (slot) => cellAt(slot).evaluate((td) => ({ subject: td.querySelector("strong")?.textContent.trim() || "", teacher: td.querySelector("small")?.textContent.trim() || "" }));
  const lessonParts = async () => panel.locator("#timetableGrid tbody td[data-tt-slot]").evaluateAll((els) => els.map((td) => ({ slot: td.dataset.ttSlot, subject: td.querySelector("strong")?.textContent.trim() || "", teacher: td.querySelector("small")?.textContent.trim() || "" })));
  const teacherOptions = async () => panel.locator("#timetableTeacherPick option").evaluateAll((els) => els.map((el) => ({ value: el.value, ok: el.dataset.ok === "1", selected: el.selected, disabled: el.disabled, text: el.textContent.trim(), title: el.title })));
  let teacherChange = null; const teacherSeen = [];
  for (const cell of pinCells.filter((item) => item.slot !== pinTarget.slot)) {
    await cellAt(cell.slot).click(); await sleep(500);
    if (!(await panel.locator("#timetableTeacherBox").count())) { await cellAt(cell.slot).click(); await sleep(150); continue; }
    const options = await teacherOptions();
    teacherSeen.push({ slot: cell.slot, options: options.length, able: options.filter((option) => option.ok && !option.selected && option.value).length, refused: options.filter((option) => option.disabled).map((option) => option.title.slice(0, 50))[0] || "" });
    const able = options.find((option) => option.ok && !option.selected && option.value);
    if (!able || (await panel.locator("#timetableTeacherChange").isDisabled())) { await cellAt(cell.slot).click(); await sleep(150); continue; }
    const before = await partsAt(cell.slot);
    await panel.locator("#timetableTeacherPick").selectOption(able.value);
    await panel.locator("#timetableTeacherChange").click(); await sleep(500);
    teacherChange = { slot: cell.slot, before, able, status: await editStatus(), after: await partsAt(cell.slot) };
    break;
  }
  report.checks.teacherChange = { change: teacherChange, seen: teacherSeen.slice(0, 8) };
  check(teacherSeen.length > 0 && teacherSeen.every((item) => item.options >= 2), `반 수업 칸을 고르면 담당 교사 후보 목록(예: ${teacherSeen[0]?.slot} 후보 ${teacherSeen[0]?.options}개, 바꿀 수 있는 교사 ${teacherSeen[0]?.able}명${teacherSeen.find((item) => item.refused) ? `, 안 되는 이유 예: ${teacherSeen.find((item) => item.refused).refused}` : ""})`);
  check(Boolean(teacherChange) && /^담당 교사를 바꿨습니다 — .+반 .+ 담당 교사 .+ → .+/.test(teacherChange.status) && teacherChange.after.subject === teacherChange.before.subject && teacherChange.after.teacher !== teacherChange.before.teacher
    && teacherChange.able.text.startsWith(teacherChange.after.teacher), `담당 교사 바꾸기: ${teacherChange?.status.slice(0, 110)}`, teacherChange);
  let teacherPinned = null;
  if (teacherChange) {
    check((await panel.locator("#timetableValidation").count()) === 0 && (await bar.getAttribute("data-state")) === "done" && Number(await panel.locator("#timetableEdits").getAttribute("data-count")) >= 1, "교사를 바꾼 뒤에도 검증 오류 없음·지금 조건의 결과·'직접 고침' 표시");
    // 같은 과목의 다른 시간도 같은 교사로 바뀌었다(그 반·그 과목 전체)
    const sameSubject = (await lessonParts()).filter((cell) => cell.subject === teacherChange.after.subject);
    check(sameSubject.length >= 1 && sameSubject.every((cell) => cell.teacher === teacherChange.after.teacher), `그 반 ${teacherChange.after.subject} ${sameSubject.length}시간 모두 ${teacherChange.after.teacher}`);
    await cellAt(teacherChange.slot).click(); await sleep(500);
    await panel.locator("#timetableTeacherPin").click(); await sleep(400);
    teacherPinned = { subject: teacherChange.after.subject, teacher: teacherChange.after.teacher };
    check(/담당 교사를 .+ 교사로 고정했습니다 — 다시 계산해도 이 반 이 과목은 이 교사가 맡습니다/.test(await editStatus()) && (await panel.locator("#timetableTeacherPinCount").getAttribute("data-count")) === "1" && (await bar.getAttribute("data-state")) === "done",
      `교사 고정: ${(await editStatus()).slice(0, 90)} — 결과는 '바뀌기 전 결과'가 되지 않음`);
    await cellAt(teacherChange.slot).click(); await sleep(500);
    check((await panel.locator("#timetableTeacherPick").isDisabled()) && (await panel.locator("#timetableTeacherChange").isDisabled()) && /교사 고정 풀기/.test(clean(await panel.locator("#timetableTeacherPin").innerText())), "교사를 고정한 수업은 고정을 풀기 전에는 바꿀 수 없음");
    await cellAt(teacherChange.slot).click(); await sleep(200);
    await page.screenshot({ path: path.join(OUT, "03d-teacher-pin.png"), fullPage: true });
  }
  // 다시 계산해도 그 수업은 그 칸에
  await panel.locator("#timetableRun").click();
  await page.locator("#appConfirmDialog[open] #appConfirmOk").click({ timeout: 1500 }).catch(() => {});
  await waitResult(240000);
  const afterPin = (await gridOf()).cells.find((cell) => cell.slot === pinTarget.slot);
  const pinSubject = (pinButton.match(/^\S+ (.+) 이 칸에 고정$/) || [])[1] || "";
  const afterSubject = clean(await cellAt(pinTarget.slot).locator("strong").first().innerText());
  check(pinSubject.length > 0 && afterSubject === pinSubject && (await cellAt(pinTarget.slot).getAttribute("data-tt-pinned")) === "1" && (await panel.locator("#timetableValidation").count()) === 0,
    `다시 계산해도 ${pinTarget.slot}에 ${pinSubject} 그대로(담당 교사는 다시 정해질 수 있음): ${afterPin.text.slice(0, 30)}`, { before: pinTarget.text, after: afterPin.text });
  if (teacherPinned) {
    const kept = (await lessonParts()).filter((cell) => cell.subject === teacherPinned.subject);
    check(kept.length >= 1 && kept.every((cell) => cell.teacher === teacherPinned.teacher) && (await panel.locator("#timetableTeacherPinCount").getAttribute("data-count")) === "1",
      `다시 계산해도 ${teacherPinned.subject}은 고정한 ${teacherPinned.teacher} 교사(${kept.length}시간)`, kept);
  }
  await panel.locator("#timetablePinsClear").click(); await sleep(400);
  check((await panel.locator("#timetablePinCount").count()) === 0 && (await panel.locator("#timetableTeacherPinCount").count()) === 0 && (await cellAt(pinTarget.slot).getAttribute("data-tt-pinned")) === null && (await bar.getAttribute("data-state")) === "done", "고정 모두 풀기 → 칸·교사 고정 표시 사라짐(결과는 그대로)");
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
