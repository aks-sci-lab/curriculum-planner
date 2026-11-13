// 5단계 확대학급 운영 교과 설정 확인(사용자처럼 클릭): 하네스 백업(가상 학생) 복원 → 5단계 → 시수 설정
// ① '확대학급 운영'을 켜면 운영 교과 체크 목록(학교 지정 과목이 있는 교과, 처음은 모두 체크)
// ② 과목별 상세: 운영 교과의 학교 지정 과목에만 '확대학급' 입력 칸 → 값을 넣으면 개설반·시수가 바뀜
// ③ 그 교과를 끄면 입력 칸이 사라지고 '값 (운영 교과 아님)' + 안내, 개설반은 편제표 값으로. 다시 켜면 되돌아옴 ④ 새로고침 뒤 유지 ⑤ 콘솔 오류 없음
// 사용: node e2e/run.cjs --seed 11 --out /tmp/e2e  →  node e2e/hours-expanded-ui.cjs /tmp/hx /tmp/e2e/downloads/workspace-backup.json.gz
const path = require("path"), fs = require("fs");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const { chromium } = require(path.join(globalRoot, "playwright"));
const { startStaticServer } = require(path.join(ROOT, "e2e/lib/static-server.cjs"));
const OUT = process.argv[2]; const BACKUP = process.argv[3];
if (!OUT || !BACKUP) { console.error("사용: node e2e/hours-expanded-ui.cjs <출력 폴더> <백업 .json.gz>"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (ok, message, detail) => { if (!ok) { problems.push({ message, detail }); console.log("  ✗", message, detail ? JSON.stringify(detail).slice(0, 500) : ""); } else console.log("  ✓", message); };
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
  const panel = page.locator("#workflowStep7Panel");
  const dialog = page.locator("#hoursSettingsDialog");
  const openStep = async () => { await page.getByRole("button", { name: /5\. 교과별 시수 통계/ }).click(); await panel.waitFor({ state: "visible" }); await sleep(600); };
  const openSettings = async () => { if (!(await dialog.evaluate((el) => el.open))) { await page.locator("#openHoursSettings").click(); await sleep(400); } };
  const closeSettings = async () => { if (await dialog.evaluate((el) => el.open)) { await dialog.evaluate((el) => el.close()); await sleep(300); } };
  const openDetail = async () => { const d = panel.locator('details[data-hours-details="detail"]'); if (!(await d.evaluate((el) => el.open))) { await d.locator("summary").click(); await sleep(400); } };

  console.log("▶ 확대학급 운영 → 운영 교과 체크 목록");
  await openStep();
  await openSettings();
  check((await dialog.locator("#hoursExpandedDepartments").count()) === 0, "운영을 켜기 전에는 운영 교과 목록이 없음");
  await dialog.locator("#hoursExpandedOn").check(); await sleep(500);
  const boxes = dialog.locator("#hoursExpandedDepartments input[data-hours-expanded-department]");
  const names = await boxes.evaluateAll((els) => els.map((el) => ({ id: el.dataset.hoursExpandedDepartment, checked: el.checked })));
  check(names.length >= 3 && names.every((item) => item.checked), `운영 교과 목록 ${names.length}개, 처음은 모두 체크(고르지 않음 = 모든 교과)`, names);
  check(/고르지 않음 = 모든 교과/.test(clean(await dialog.locator("#hoursExpandedDepartments").innerText())), "안내: 고르지 않음 = 모든 교과");
  await dialog.screenshot({ path: path.join(OUT, "01-expanded-departments.png") });
  await closeSettings();

  console.log("▶ 과목별 상세: 운영 교과의 학교 지정 과목에만 확대 칸");
  await openDetail();
  const inputs = panel.locator("input[data-hours-expanded]");
  const first = inputs.first();
  const key = await first.getAttribute("data-hours-expanded");
  const plan = Number(await first.getAttribute("data-hours-plan"));
  check((await inputs.count()) > 0 && plan > 0, `확대학급 입력 칸 ${await inputs.count()}개(첫 과목 ${key}, 편제표 ${plan}반)`);
  const rowOf = () => panel.locator(`tr:has([data-hours-expanded="${key}"]), tr:has-text("운영 교과 아님")`).first();
  await first.fill(String(plan + 2)); await first.press("Tab"); await sleep(600);
  await openDetail();
  const rowText = clean(await panel.locator(`tr:has([data-hours-expanded="${key}"])`).innerText());
  check(new RegExp(`확대학급 ${plan + 2}반\\(편제표 ${plan}반\\)`).test(rowText), `확대 ${plan + 2}반 반영: ${rowText.slice(0, 120)}`);
  // 그 과목의 담당 교과를 운영 교과에서 끈다
  const department = await page.evaluate((itemKey) => hoursStatsCached(hoursTargetYear()).items.find((item) => item.key === itemKey).department, key);
  await openSettings();
  await dialog.locator(`input[data-hours-expanded-department="${department}"]`).uncheck(); await sleep(500);
  check(new RegExp(`${names.length - 1}개 교과`).test(clean(await dialog.locator("#hoursExpandedDepartments").innerText())), `'${department}'을 끄면 ${names.length - 1}개 교과`);
  await closeSettings();
  await openDetail();
  check((await panel.locator(`input[data-hours-expanded="${key}"]`).count()) === 0, "그 교과 과목의 확대 입력 칸이 사라짐");
  const offText = clean(await panel.locator('details[data-hours-details="detail"]').innerText());
  check(new RegExp(`${plan + 2} \\(운영 교과 아님\\)`).test(offText), `'${plan + 2} (운영 교과 아님)'으로 표시(값은 지우지 않음)`);
  const stats = await page.evaluate((itemKey) => { const s = hoursStatsCached(hoursTargetYear()); const item = s.items.find((row) => row.key === itemKey); return { classes: item.classes, auto: item.autoClasses, issue: s.issues.find((issue) => /^확대학급 운영 교과가 아닌 과목/.test(issue.text))?.text || "" }; }, key);
  check(stats.classes === stats.auto && /확대 값 1개는 쓰지 않음/.test(stats.issue), `개설반은 편제표 값(${stats.auto}반), 확인 항목에 안내: ${stats.issue.slice(0, 80)}`);
  await page.screenshot({ path: path.join(OUT, "02-department-off.png"), fullPage: true });
  await openSettings();
  await dialog.locator(`input[data-hours-expanded-department="${department}"]`).check(); await sleep(500);
  await closeSettings();
  await openDetail();
  check((await panel.locator(`input[data-hours-expanded="${key}"]`).inputValue()) === String(plan + 2), "다시 켜면 입력 칸과 값이 되돌아옴");

  console.log("▶ 새로고침·7단계 알림");
  await sleep(600);
  await page.reload(); await page.waitForLoadState("networkidle"); await sleep(2500);
  await openStep(); await openSettings();
  const after = await dialog.locator("#hoursExpandedDepartments input[data-hours-expanded-department]").evaluateAll((els) => els.filter((el) => el.checked).length);
  check(after === names.length, `새로고침 뒤에도 운영 교과 ${after}개 유지`);
  await closeSettings();
  await page.getByRole("button", { name: /7\. 시간표/ }).click(); await page.locator("#workflowStep6Panel").waitFor({ state: "visible" }); await sleep(600);
  check(/5단계 확대학급\(수준별 이동수업\)이 켜져 있습니다/.test(clean(await page.locator("#timetablePrecheck").innerText())), "7단계 사전 점검에 확대학급 알림(시간표에는 아직 미반영)");
  check(logs.length === 0, "콘솔 오류 없음", logs);
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ problems, logs }, null, 1));
  await browser.close(); server.close?.();
  console.log(problems.length ? `문제 ${problems.length}건` : "모두 통과");
  process.exit(problems.length ? 1 : 0);
})();
