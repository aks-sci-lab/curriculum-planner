// 6단계 시간표 준비 화면 확인(사용자처럼 클릭): 하네스 백업(가상 학생) 복원 → 6단계
// ① 학급 단위로만 운영되는 그룹: 블록 시간 칸 대신 '반 수업(시간표에서 배치)', 블록 시간 추천에서 빠짐
// ② 학기마다 '전 학년 함께 다시 계산' → 공통 교과 분반 교사가 비지 않음('…-공통: 교사 명단에 담당 교사가 없어' 없음)
// ③ 결과 카드 '시간표 미리 점검'(블록 밖 빈 칸, 반 수업 시수 ÷ 교사 수)
// 사용: node e2e/run.cjs --seed 11 --out /tmp/e2e  →  node e2e/class-sections-timetable-prep-ui.cjs /tmp/cs-prep /tmp/e2e/downloads/workspace-backup.json.gz
const path = require("path"), fs = require("fs");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const { chromium } = require(path.join(globalRoot, "playwright"));
const { startStaticServer } = require(path.join(ROOT, "e2e/lib/static-server.cjs"));
const OUT = process.argv[2]; const BACKUP = process.argv[3];
if (!OUT || !BACKUP) { console.error("사용: node e2e/class-sections-timetable-prep-ui.cjs <출력 폴더> <백업 .json.gz>"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const report = { problems, checks: {} };
const check = (ok, message, detail) => { if (!ok) { problems.push({ message, detail }); console.log("  ✗", message, detail ? JSON.stringify(detail).slice(0, 400) : ""); } else console.log("  ✓", message); };

(async () => {
  const { server, url } = await startStaticServer(ROOT);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: "ko-KR", deviceScaleFactor: 1 });
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
  await page.getByRole("button", { name: /6\. 분반 편성/ }).click();
  await page.locator("#workflowStep8Panel").waitFor({ state: "visible" });
  await sleep(800);
  const openAdvanced = async () => {
    const details = page.locator("details.cs-advanced");
    if (await details.count() && !(await details.evaluate((el) => el.open))) { await details.locator("summary").click(); await sleep(300); }
  };
  const groups = await page.locator("[data-cs-group]").evaluateAll((els) => els.map((el) => ({ key: el.dataset.csGroup, text: el.textContent.replace(/\s+/g, " ").trim() })));
  report.checks.groups = groups.map((item) => item.key);

  // ① 학급 단위로만 운영되는 그룹
  console.log("▶ 학급 단위 그룹 = 반 수업");
  const unitOnly = [];
  for (const item of groups) {
    await page.locator(`[data-cs-group="${item.key}"]`).click(); await sleep(400);
    await openAdvanced();
    const note = page.locator("#classSectionsClassUnitOnly");
    if (await note.count()) unitOnly.push({ ...item, note: (await note.innerText()).replace(/\s+/g, " "), timeInputs: await page.locator("[data-cs-block-times]").count() });
  }
  report.checks.unitOnly = unitOnly;
  check(unitOnly.length >= 1, `학급 단위로만 운영되는 그룹 ${unitOnly.length}개(${unitOnly.map((item) => item.key).join(", ")})`, groups.map((item) => item.key));
  for (const item of unitOnly) {
    check(/^반 수업\(시간표에서 배치\)/.test(item.note) && item.timeInputs === 0, `${item.key}: 블록 시간 칸 대신 '반 수업(시간표에서 배치)'`, item);
  }
  if (unitOnly.length) {
    await page.locator(`[data-cs-group="${unitOnly[0].key}"]`).click(); await sleep(400); await openAdvanced();
    await page.locator('details.cs-advanced').screenshot({ path: path.join(OUT, "01-class-unit-only.png") });
  }
  // 블록 시간 추천(학급 단위 그룹이 있는 학기의 다른 그룹에서): 추천안 표에 학급 단위 그룹이 없음
  const unitSemester = unitOnly[0]?.key.split(":")[1];
  const mover = groups.find((item) => item.key.split(":")[1] === unitSemester && !unitOnly.some((unit) => unit.key === item.key));
  if (mover) {
    await page.locator(`[data-cs-group="${mover.key}"]`).click(); await sleep(400); await openAdvanced();
    await page.getByRole("button", { name: "블록 시간 추천" }).click();
    await page.locator("#classSectionsTimesProposal").waitFor({ state: "visible", timeout: 120000 }).catch(() => {});
    const rows = await page.locator("#classSectionsTimesProposal tbody tr").evaluateAll((els) => els.map((tr) => tr.textContent.replace(/\s+/g, " ").trim()));
    const unitLabels = unitOnly.map((item) => item.text.replace(/\s*\d+명.*$/, "").trim());
    report.checks.recommend = { rows: rows.length, sample: rows.slice(0, 3), unitLabels };
    const unitTag = unitOnly.map((item) => item.key.split(":").slice(2).join(":"));
    check(rows.length > 0 && !rows.some((row) => unitTag.some((tag) => row.includes(tag))), `블록 시간 추천안 ${rows.length}줄에 학급 단위 그룹(${unitTag.join(", ")})이 없음`, report.checks.recommend);
    await page.getByRole("button", { name: "추천 닫기" }).click().catch(() => {}); await sleep(300);
  } else check(false, "학급 단위 그룹과 같은 학기에 이동 그룹이 있음");

  // ② 학기마다 전 학년 함께 다시 계산 → 공통 교과 교사가 비지 않음
  // 재현: 그 학기 첫 그룹이 아닌 그룹(이동 분반 있는)의 과목 하나를 담당 교과 '사회-공통'으로(공통 교사 명단 없음 → 세부 교과 교사가 대체).
  // 예전 코드는 함께 계산에서 첫 그룹 교사 명단만 넘겨 이 분반 교사가 비고 '사회-공통: 교사 명단에 담당 교사가 없어 …'가 나왔다.
  console.log("▶ 전 학년 함께 다시 계산 · 공통 교과 교사");
  const semesters = [...new Set(groups.map((item) => item.key.split(":")[1]))];
  const commonTarget = [...groups].reverse().find((item) => item.key.split(":")[1] === "2" && !unitOnly.some((unit) => unit.key === item.key)
    && !/택1$/.test(item.key) && groups.find((other) => other.key.split(":")[1] === "2").key !== item.key);
  if (commonTarget) {
    await page.locator(`[data-cs-group="${commonTarget.key}"]`).click(); await sleep(400);
    const dept = page.locator("select[data-cs-dept]").first();
    const course = await dept.getAttribute("data-cs-dept");
    await dept.selectOption("사회-공통"); await sleep(600);
    report.checks.commonTarget = { group: commonTarget.key, course };
    check(await page.locator("select[data-cs-dept]").first().inputValue() === "사회-공통", `${commonTarget.key} ${course}: 담당 교과를 '사회-공통'으로(공통 교사 없음)`);
  } else check(false, "공통 과목으로 바꿀 2학기 그룹(첫 그룹이 아닌)");
  report.checks.joint = {};
  for (const semester of semesters) {
    const first = groups.find((item) => item.key.split(":")[1] === semester);
    await page.locator(`[data-cs-group="${first.key}"]`).click(); await sleep(400);
    const button = page.locator("#classSectionsSolveSemester");
    if (!(await button.count())) continue;
    await button.click();
    await page.waitForFunction(() => /함께 다시 계산했습니다|함께 계산 실패/.test(document.getElementById("classSectionsStatus")?.textContent || ""), null, { timeout: 600000 });
    const status = await page.locator("#classSectionsStatus").innerText();
    const empty = [];
    const precheck = [];
    for (const item of groups.filter((other) => other.key.split(":")[1] === semester)) {
      await page.locator(`[data-cs-group="${item.key}"]`).click(); await sleep(500);
      // 분반 카드의 담당 교사 칸: 자동 배정이 비면 첫 칸이 '자동(없음)'. 접힌 안내 문구도 textContent로 함께 본다.
      const cards = await page.locator("li.cs-section").evaluateAll((els) => els.map((li) => ({ course: li.dataset.course, teacher: li.querySelector("select[data-cs-teacher] option")?.textContent || "" })));
      const none = cards.filter((card) => card.teacher === "자동(없음)");
      const text = await page.locator("#workflowStep8Panel").evaluate((el) => el.textContent);
      const lines = (text.match(/[^.。]*교사 명단에 담당 교사가 없어[^.。]*/g) || []).map((line) => line.trim().slice(-120));
      if (item.key === report.checks.commonTarget?.group) {
        const name = report.checks.commonTarget.course.replace(/\s*\([12]학기\)$/, "");
        const mine = cards.filter((card) => card.course === name);
        report.checks.commonTarget.cards = mine.length;
        report.checks.commonTarget.teachers = mine.map((card) => card.teacher);
        check(mine.length > 0 && mine.every((card) => card.teacher !== "자동(없음)"), `공통 과목으로 바꾼 ${name} 분반 ${mine.length}개 모두 교사 배정(세부 교과 교사)`, mine.slice(0, 4));
      }
      // 버그 신호 = '교사 명단에 담당 교사가 없어'(명단에 맡을 교사가 아예 없음). 같은 시간 교사 수가 모자라 빈 분반('그 시간에 맡을 수 있는 교사가 없습니다')은 자료 문제라 따로 적는다.
      if (lines.length) empty.push({ key: item.key, none: none.length, courses: [...new Set(none.map((card) => card.course))].slice(0, 4), lines: lines.slice(0, 2) });
      else if (none.length) (report.checks.shortage ||= []).push({ key: item.key, none: none.length, courses: [...new Set(none.map((card) => card.course))] });
      const box = page.locator("#classSectionsTimetableCheck");
      if (await box.count()) precheck.push({ key: item.key, count: Number(await box.getAttribute("data-count")), text: (await box.innerText()).replace(/\s+/g, " ").slice(0, 220) });
    }
    report.checks.joint[semester] = { status: status.slice(0, 200), empty, precheck };
    check(!/함께 계산 실패/.test(status), `${semester}학기 전 학년 함께 다시 계산`, status.slice(0, 160));
    check(!empty.length, `${semester}학기: 담당 교사 비움 경고 없음(공통 교과 포함)`, empty);
    check(precheck.length === groups.filter((other) => other.key.split(":")[1] === semester).length && precheck.every((item) => /시간표 미리 점검\(\d학년 \d학기\): 주 \d+교시 − 블록 \d+ − 고정 \d+ = 블록 밖 빈 칸 \d+칸/.test(item.text)),
      `${semester}학기: 그룹마다 '시간표 미리 점검'(블록 밖 빈 칸)`, precheck);
  }
  const unitCheck = unitOnly.length ? report.checks.joint[unitSemester]?.precheck.find((item) => item.key === unitOnly[0].key) : null;
  if (unitCheck) {
    await page.locator(`[data-cs-group="${unitOnly[0].key}"]`).click(); await sleep(500);
    await page.locator("#classSectionsTimetableCheck").screenshot({ path: path.join(OUT, "02-timetable-precheck.png") });
    check(/반 수업 /.test(unitCheck.text), "학급 단위 그룹 점검에 반 수업 시수", unitCheck);
  }
  report.logs = logs;
  check(!logs.length, "콘솔 오류 없음", logs.slice(0, 5));
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(problems.length ? `문제 ${problems.length}건` : "모두 통과");
  await browser.close(); server.close();
  process.exit(problems.length ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
