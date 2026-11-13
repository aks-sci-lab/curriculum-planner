// 7단계 시간표 자료 모으기 확인: 하네스 백업(가상 학생)을 사용자처럼 복원한 뒤, 5·6단계 자료로 만든 시간표 입력과 사전 점검 결과를 읽는다.
// 시간표 화면이 아직 없어(설계 T3) 복원한 앱 안에서 timetablePrecheckFor를 불러 확인한다 — 화면이 생기면 클릭 확인으로 바꾼다.
// 확인: ① 두 학기 모두 계산을 막는 누락 없음 ② 1초 안 ③ 5단계 시수 합 = 7단계 시수 합(가정으로 채운 학년 제외, 어긋나면 그 사유가 경고로 나옴) ④ 가정 목록 ⑤ 콘솔 오류 없음
// 사용: node e2e/run.cjs --seed 11 --out /tmp/e2e  →  node e2e/timetable-input-check.cjs /tmp/tt-input /tmp/e2e/downloads/workspace-backup.json.gz
const path = require("path"), fs = require("fs");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const { chromium } = require(path.join(globalRoot, "playwright"));
const { startStaticServer } = require(path.join(ROOT, "e2e/lib/static-server.cjs"));
const OUT = process.argv[2]; const BACKUP = process.argv[3];
if (!OUT || !BACKUP) { console.error("사용: node e2e/timetable-input-check.cjs <출력 폴더> <백업 .json.gz>"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (ok, message, detail) => { if (!ok) { problems.push({ message, detail }); console.log("  ✗", message, detail ? JSON.stringify(detail).slice(0, 600) : ""); } else console.log("  ✓", message); };

(async () => {
  const { server, url } = await startStaticServer(ROOT);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: "ko-KR" });
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

  const report = await page.evaluate(() => {
    const round = String(state.currentRound);
    const out = { round, semesters: {} };
    for (const semester of ["1", "2"]) {
      const started = performance.now();
      const prepared = timetableInput(round, semester);
      const result = timetablePrecheck(prepared.input);
      const ms = Math.round(performance.now() - started);
      const model = timetableModel(prepared.input);
      const assumed = new Set(prepared.assumptions.filter((entry) => entry.key === "plan1").map(() => "1")); // 가정으로 채운 학년(5단계에 없는 자료)
      const stats = hoursStatsCached(hoursTargetYear());
      const hours5 = stats.items.filter((item) => item.semester === semester).reduce((sum, item) => sum + item.hours, 0);
      const hours7 = model.lessons.filter((lesson) => !assumed.has(lesson.grade)).reduce((sum, lesson) => sum + lesson.hours, 0)
        + model.blocks.reduce((sum, block) => sum + block.sections.reduce((total, section) => total + section.hours, 0), 0);
      out.semesters[semester] = { ms, counts: result.counts, hours5, hours7, grades: result.grades, assumptions: prepared.assumptions.map((entry) => entry.text),
        issues: result.issues.map((issue) => ({ id: issue.id, level: issue.level, cause: issue.cause, where: issue.where.map((where) => where.label) })),
        lessons: prepared.input.lessons.length, blocks: prepared.input.blocks.map((block) => `${block.grade}학년 ${block.label} [${block.times}] 분반 ${block.sections.length}`), teachers: prepared.input.teachers.length };
    }
    return out;
  });
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ ...report, logs }, null, 1));
  for (const [semester, item] of Object.entries(report.semesters)) {
    console.log(`▶ ${report.round}차 ${semester}학기: 반 수업 ${item.lessons}줄 · 블록 ${item.blocks.length}개 · 교사 ${item.teachers}명 · ${item.ms}ms`);
    check(item.counts.block === 0, "계산을 막는 누락 없음", item.issues.filter((issue) => issue.level === "block"));
    check(item.ms < 1000, `자료 모으기 + 사전 점검 1초 안(${item.ms}ms)`);
    const explained = item.issues.some((issue) => issue.id === "P0" && /5단계 시수 .*≠ 6단계 분반/.test(issue.cause));
    check(item.hours5 === item.hours7 || explained, item.hours5 === item.hours7 ? `5단계 시수 ${item.hours5}시간 = 7단계 시수 ${item.hours7}시간` : `5단계 ${item.hours5}시간 ≠ 7단계 ${item.hours7}시간 — 사유가 경고로 나옴`, item.issues.filter((issue) => issue.id === "P0"));
    check(item.assumptions.length > 0 && item.grades.length === 3, `가정 ${item.assumptions.length}건, 학년 요약 3줄`);
    for (const text of item.assumptions) console.log("    가정:", text);
    for (const issue of item.issues) console.log(`    ${issue.id} ${issue.level}: ${issue.cause}`);
  }
  check(logs.length === 0, "콘솔 오류 없음", logs);
  await browser.close(); server.close?.();
  console.log(problems.length ? `문제 ${problems.length}건` : "모두 통과");
  process.exit(problems.length ? 1 : 0);
})();
