// 7단계 시간표 화면 확인(사용자처럼 클릭): 순회교사·학년별 교시 수·학년별 창체 운영 방식이 계산 결과에 반영되는지
// ① 6단계 교사 명단 '순회' 칸: 오는 교사(주당 시수·오는 요일), 나가는 교사(나가는 시수) ② 3학년 금요일 6교시, 3학년 창체만 일반 수업처럼
// ③ 시간표 계산 → 순회교사는 주당 시수 이하·오는 요일에만, 나가는 교사는 '+ 순회 n' 표시, 3학년 반은 금7 빈칸·창체가 반마다 다른 칸 ④ 콘솔 오류 없음
// 사용: node e2e/run.cjs --seed 1 --out /tmp/e2e  →  node e2e/timetable-roaming-ui.cjs /tmp/tt-roam /tmp/e2e/downloads/workspace-backup.json.gz
const path = require("path"), fs = require("fs");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const { chromium } = require(path.join(globalRoot, "playwright"));
const { startStaticServer } = require(path.join(ROOT, "e2e/lib/static-server.cjs"));
const OUT = process.argv[2]; const BACKUP = process.argv[3];
if (!OUT || !BACKUP) { console.error("사용: node e2e/timetable-roaming-ui.cjs <출력 폴더> <백업 .json.gz>"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (ok, message, detail) => { if (!ok) { problems.push({ message, detail }); console.log("  ✗", message, detail ? JSON.stringify(detail).slice(0, 600) : ""); } else console.log("  ✓", message); };
const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();

(async () => {
  const { server, url } = await startStaticServer(ROOT);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1100 }, locale: "ko-KR", deviceScaleFactor: 2 });
  await context.route(/supabase\.co|googleapis|gstatic/, (route) => route.abort());
  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => { if (m.type() === "error") logs.push(`error: ${m.text()}`); });
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => d.accept());
  await page.goto(url); await page.waitForLoadState("networkidle"); await sleep(1000);
  await page.locator("#workspaceDataMenu summary").click();
  const nav = page.waitForEvent("load", { timeout: 30000 }).catch(() => null);
  await page.locator("#restoreWorkspaceBackup").setInputFiles(BACKUP);
  await page.locator("#appConfirmDialog[open] #appConfirmOk").click({ timeout: 10000 }).catch(() => {});
  await nav; await sleep(2500);
  const panel = page.locator("#workflowStep6Panel");
  await page.getByRole("button", { name: /7\. 시간표/ }).click(); await panel.waitFor({ state: "visible" }); await sleep(500);
  const openSection = async (key) => { const d = panel.locator(`[data-tt-section="${key}"]`); if (!(await d.evaluate((el) => el.open))) { await d.locator(":scope > summary").click(); await sleep(200); } };

  console.log("▶ 6단계 교사 명단 '순회' 칸");
  await openSection("teachers");
  await panel.locator('[data-tt-section="teachers"] .tt-goto[data-tt-goto="teachers"]').first().click(); await sleep(700);
  const dialog = page.locator("#classSectionsTeacherDialog");
  check(await dialog.evaluate((el) => el.open), "6단계 교사·시간 설정 창이 열림");
  const names = await dialog.locator('[data-cs-t$="|name"]').evaluateAll((els) => els.map((el) => el.value));
  const depts = await dialog.locator('[data-cs-t$="|department"]').evaluateAll((els) => els.map((el) => el.value));
  // 같은 교과 교사가 2명 이상인 교과의 둘째 교사를 오는 순회교사로, 다른 교과의 첫 교사를 나가는 교사로
  const counts = {}; depts.forEach((id) => { counts[id] = (counts[id] || 0) + 1; });
  const inAt = depts.findIndex((id, index) => counts[id] >= 3 && depts.indexOf(id) !== index);
  const outAt = depts.findIndex((id, index) => counts[id] >= 3 && id !== depts[inAt] && depts.indexOf(id) === index);
  check(inAt >= 0 && outAt >= 0, `순회로 적을 교사: 오는 ${names[inAt]}(${depts[inAt]}), 나가는 ${names[outAt]}(${depts[outAt]})`);
  check((await dialog.locator(`[data-cs-t="${inAt}|roamHours"]`).count()) === 0, "순회가 아닌 교사는 시수·요일 칸이 없음");
  await dialog.locator(`[data-cs-t="${inAt}|roam"]`).selectOption("in"); await sleep(300);
  await dialog.locator(`[data-cs-t="${inAt}|roamHours"]`).fill("6"); await dialog.locator(`[data-cs-t="${inAt}|roamHours"]`).press("Tab"); await sleep(300);
  await dialog.locator(`[data-cs-t="${inAt}|roamDays"]`).fill("금요일"); await dialog.locator(`[data-cs-t="${inAt}|roamDays"]`).press("Tab"); await sleep(300);
  check(/오는 요일 '금요일'/.test(clean(await dialog.locator("#classSectionsTeacherMessage").innerText().catch(() => ""))) === false && (await dialog.locator(`[data-cs-t="${inAt}|roamDays"]`).inputValue()) === "금", "오는 요일 '금요일' → '금'으로 맞춰 저장");
  await dialog.locator(`[data-cs-t="${inAt}|roamDays"]`).fill("월, 수"); await dialog.locator(`[data-cs-t="${inAt}|roamDays"]`).press("Tab"); await sleep(300);
  check((await dialog.locator(`[data-cs-t="${inAt}|roamDays"]`).inputValue()) === "월,수" && (await dialog.locator(`[data-cs-t="${inAt}|roamHours"]`).inputValue()) === "6", "오는 순회교사: 주 6시간 · 월,수");
  await dialog.locator(`[data-cs-t="${outAt}|roam"]`).selectOption("out"); await sleep(300);
  await dialog.locator(`[data-cs-t="${outAt}|roamHours"]`).fill("4"); await dialog.locator(`[data-cs-t="${outAt}|roamHours"]`).press("Tab"); await sleep(300);
  check((await dialog.locator(`[data-cs-t="${outAt}|roamDays"]`).count()) === 0 && (await dialog.locator(`[data-cs-t="${outAt}|roamHours"]`).inputValue()) === "4", "나가는 교사: 주 4시간(오는 요일 칸 없음)");
  await dialog.screenshot({ path: path.join(OUT, "01-roaming-roster.png") });
  await dialog.locator("#classSectionsTeacherClose").click(); await sleep(500);
  await page.getByRole("button", { name: /7\. 시간표/ }).click(); await panel.waitFor({ state: "visible" }); await sleep(600);

  console.log("▶ 학년별 교시 수·창체 운영 방식");
  await openSection("time");
  await panel.getByRole("button", { name: "학년별로 놓기" }).click(); await sleep(400);
  await panel.locator('[data-tt-field="creative.mode:3"]').selectOption("class"); await sleep(400);
  await panel.locator('[data-tt-field="gperiod:3:금"]').fill("6"); await panel.locator('[data-tt-field="gperiod:3:금"]').press("Tab"); await sleep(500);
  const grades = await panel.locator("#timetableGrades tbody tr").evaluateAll((rows) => rows.map((row) => [...row.children].map((cell) => cell.textContent.trim())));
  check(Number(grades[0][2]) === 35 && Number(grades[2][2]) === 34, "주 칸 수: 1학년 35 · 3학년 34", grades.map((row) => row.slice(0, 3)));
  await openSection("time");
  await panel.locator("#timetableConditions").screenshot({ path: path.join(OUT, "02-conditions.png") });

  console.log("▶ 시간표 계산");
  const bar = panel.locator("#timetableRunBar");
  await panel.locator("#timetableRun").click();
  await sleep(45000);
  await panel.locator("#timetableStop").click().catch(() => {});
  await panel.locator("#timetableRunBar[data-state='done'], #timetableRunBar[data-state='stale']").waitFor({ timeout: 240000 }); await sleep(500);
  check((await bar.getAttribute("data-state")) === "done" && (await panel.locator("#timetableValidation").count()) === 0, "계산 끝 · 검증 오류 없음", clean(await panel.locator("#timetableResultSummary").innerText()).slice(0, 200));
  // 3학년 반: 금7은 빈칸, 창체는 반마다 따로
  const classOptions = await panel.locator("#timetableGridPick option").evaluateAll((els) => els.map((el) => el.value));
  const creativeOf = async (room) => { await panel.locator("#timetableGridPick").selectOption(room); await sleep(250); return panel.locator("#timetableGrid td[data-tt-slot]").evaluateAll((cells) => cells.filter((cell) => /창체/.test(cell.textContent)).map((cell) => cell.dataset.ttSlot)); };
  const third = classOptions.filter((id) => id.startsWith("3-"));
  const creative3 = [];
  for (const room of third.slice(0, 4)) creative3.push((await creativeOf(room)).join(","));
  const fri7 = clean(await panel.locator('#timetableGrid td[data-tt-slot="금7"]').innerText().catch(() => "없음"));
  check(new Set(creative3).size > 1 && creative3.every((text) => text.split(",").length === 2), "3학년 창체 2시간이 반마다 다른 칸(일반 수업처럼)", creative3);
  check(fri7 === "" || fri7 === "없음", "3학년 반의 금7은 빈칸", fri7);
  const creative1 = [];
  for (const room of classOptions.filter((id) => id.startsWith("1-")).slice(0, 3)) creative1.push((await creativeOf(room)).join(","));
  check(new Set(creative1).size === 1, "1학년 창체는 학년 전체가 같은 칸", creative1);
  await panel.locator("#timetableGrid").screenshot({ path: path.join(OUT, "03-class-3.png") });
  // 교사 표: 순회교사
  await panel.locator('[data-tt-view="teacher"]').click(); await sleep(300);
  const teacherOptions = await panel.locator("#timetableGridPick option").evaluateAll((els) => els.map((el) => ({ value: el.value, text: el.textContent.trim() })));
  const roamIn = teacherOptions.find((item) => item.text.startsWith(`${names[inAt]}(순회)`));
  const roamOut = teacherOptions.find((item) => item.text.startsWith(names[outAt]));
  check(Boolean(roamIn) && Number((roamIn.text.match(/\((\d+)시간/) || [])[1]) <= 6 && Number((roamIn.text.match(/\((\d+)시간/) || [])[1]) > 0, `오는 순회교사 이름에 '(순회)' · 주 6시간 이하: ${roamIn?.text}`, teacherOptions.slice(0, 8));
  check(Boolean(roamOut) && /\+ 순회 4\)/.test(roamOut.text), `나가는 교사 시수에 '+ 순회 4': ${roamOut?.text}`);
  if (roamIn) {
    await panel.locator("#timetableGridPick").selectOption(roamIn.value); await sleep(300);
    const used = await panel.locator("#timetableGrid td[data-tt-slot]").evaluateAll((cells) => cells.filter((cell) => cell.textContent.trim()).map((cell) => cell.dataset.ttSlot.split("|")[0]));
    check(used.length > 0 && used.every((d) => d === "0" || d === "2"), "오는 순회교사 수업은 월·수에만", used);
    await panel.locator("#timetableGrid").screenshot({ path: path.join(OUT, "04-roaming-teacher.png") });
  }
  const notes = clean(await panel.locator("#timetableNotes").innerText().catch(() => ""));
  console.log("  알림:", notes.slice(0, 700));
  check(logs.length === 0, "콘솔 오류 없음", logs.slice(0, 5));
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ problems, notes }, null, 2));
  await browser.close(); server.close();
  console.log(problems.length ? `문제 ${problems.length}건` : "모두 통과");
  process.exit(problems.length ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
