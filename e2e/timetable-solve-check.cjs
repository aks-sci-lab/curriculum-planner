// 7단계 시간표 풀이기 확인: 백업을 사용자처럼 복원한 앱에서 시간표 입력(5·6단계 자료)을 꺼낸 뒤, Node에서 풀이기(timetable-solve.js)를 돌려
// 학기별 '반드시' 조건 위반·공강·규칙 지표·담당 교사 없음·걸린 시간과 검증기 결과를 적는다(화면이 아니라 계산 품질을 보는 스크립트).
// 사용: node e2e/timetable-solve-check.cjs <출력 폴더> <백업 .json.gz> [--seeds 1,2,3] [--iterations 600000] [--modes each,frame] [--inputs <저장해 둔 inputs.json>]
//   --modes each  = 학기마다 따로, frame = 두 학기 함께(뼈대: 이어지는 수업·블록·창체는 같은 칸). 기본 둘 다.
//   --inputs      = 앞서 이 스크립트가 <출력 폴더>/inputs.json 에 적어 둔 입력으로 다시 계산(브라우저를 열지 않음).
// 출력 폴더의 inputs.json·report.json 에는 교사 이름이 들어 있을 수 있으니 저장소에 커밋하지 않는다(학생 자료는 들어가지 않는다).
const path = require("path"), fs = require("fs"), vm = require("vm");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
const positional = args.filter((value, index) => !value.startsWith("--") && !(index > 0 && args[index - 1].startsWith("--")));
const OUT = positional[0]; const BACKUP = positional[1];
const INPUTS = flag("inputs", "");
if (!OUT || (!BACKUP && !INPUTS)) { console.error("사용: node e2e/timetable-solve-check.cjs <출력 폴더> <백업 .json.gz> [--seeds 1,2,3] [--iterations n] [--modes each,frame] [--inputs inputs.json]"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const seeds = String(flag("seeds", "1")).split(",").map(Number).filter((value) => value > 0);
const iterations = flag("iterations", "") ? Number(flag("iterations")) : undefined;
const modes = String(flag("modes", "each,frame")).split(",");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readInputs() {
  if (INPUTS) return JSON.parse(fs.readFileSync(INPUTS, "utf8"));
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const { chromium } = require(path.join(globalRoot, "playwright"));
  const { startStaticServer } = require(path.join(ROOT, "e2e/lib/static-server.cjs"));
  const { server, url } = await startStaticServer(ROOT);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: "ko-KR" });
  await context.route(/supabase\.co|googleapis|gstatic/, (route) => route.abort());
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(url); await page.waitForLoadState("networkidle"); await sleep(1000);
  await page.locator("#workspaceDataMenu summary").click();
  const nav = page.waitForEvent("load", { timeout: 30000 }).catch(() => null);
  await page.locator("#restoreWorkspaceBackup").setInputFiles(BACKUP);
  await page.locator("#appConfirmDialog[open] #appConfirmOk").click({ timeout: 10000 }).catch(() => {});
  await nav; await sleep(2500);
  const data = await page.evaluate(() => {
    const round = String(state.currentRound);
    const out = { round, semesters: {}, assumptions: {} };
    for (const semester of ["1", "2"]) {
      const prepared = timetableInput(round, semester);
      out.semesters[semester] = JSON.parse(JSON.stringify(prepared.input));
      out.assumptions[semester] = prepared.assumptions.map((entry) => entry.text);
    }
    return out;
  });
  await browser.close(); server.close?.();
  fs.writeFileSync(path.join(OUT, "inputs.json"), JSON.stringify(data));
  return data;
}

(async () => {
  const data = await readInputs();
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(ROOT, "timetable.js"), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "timetable-solve.js"), "utf8"), ctx);
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const report = { round: data.round, precheck: {}, runs: [] };
  for (const semester of Object.keys(data.semesters)) {
    const check = plain(ctx.timetablePrecheck(data.semesters[semester]));
    report.precheck[semester] = { counts: check.counts, fail: check.issues.filter((issue) => issue.level === "fail" || issue.level === "block").map((issue) => `${issue.id} ${issue.cause}`) };
    console.log(`▶ ${data.round}차 ${semester}학기 사전 점검: 계산 불가 ${check.counts.block} · 조건 위반 ${check.counts.fail} · 확인 ${check.counts.warn}`);
    for (const line of report.precheck[semester].fail) console.log(`    ${line}`);
  }
  const jobs = [];
  if (modes.includes("each")) for (const semester of Object.keys(data.semesters)) jobs.push({ name: `${semester}학기만`, inputs: { [semester]: data.semesters[semester] } });
  if (modes.includes("frame") && Object.keys(data.semesters).length > 1) jobs.push({ name: "두 학기 함께(뼈대)", inputs: data.semesters });
  let failed = 0;
  for (const job of jobs) {
    for (const seed of seeds) {
      if (Object.values(job.inputs).some((input) => (input.missing || []).some((item) => item.level === "block"))) { console.log(`▶ ${job.name}: 계산을 막는 누락이 있어 건너뜀`); continue; }
      const started = Date.now();
      const result = plain(ctx.timetableSolve(job.inputs, { seed, ...(iterations ? { iterations } : {}) }));
      const ms = Date.now() - started;
      const valid = plain(ctx.timetableValidate(job.inputs, result));
      const m = result.metrics;
      const bySemester = {};
      for (const item of result.violations) {
        const row = bySemester[item.semester] || (bySemester[item.semester] = { hard: 0, gapPlaces: 0, gapCells: 0, oncePerDay: 0, run: 0, maxPerDay: 0, lunch: 0 });
        if (item.level === "hard") row.hard += item.amount;
        if (item.rule === "gap") { row.gapPlaces += 1; row.gapCells += item.amount; } else row[item.rule] += item.amount;
      }
      const noTeacher = {};
      for (const item of result.noTeacher) noTeacher[item.semester] = (noTeacher[item.semester] || 0) + item.hours;
      console.log(`▶ ${job.name} · 씨앗 ${seed}: ${(ms / 1000).toFixed(1)}초 · 반복 ${result.iterations} · 반드시 위반 ${m.hard} · 공강 ${m.gap}칸 · 하루 두 번 ${m.oncePerDay} · 연강 ${m.run} · 하루 최대 ${m.maxPerDay} · 점심 ${m.lunch} · 담당 교사 없음 ${m.noTeacherHours}시간 · 못 넣음 ${m.unplacedHours} · 묶음 ${m.frameActs} · 검증 ${valid.ok ? "통과" : `실패 ${valid.errors.length}건`}`);
      for (const semester of result.semesters) {
        const row = bySemester[semester] || { hard: 0, gapPlaces: 0, gapCells: 0, oncePerDay: 0, run: 0, maxPerDay: 0, lunch: 0 };
        console.log(`    ${semester}학기: 반드시 위반 ${row.hard} · 공강 ${row.gapPlaces}곳 ${row.gapCells}칸 · 하루 두 번 ${row.oncePerDay} · 연강 ${row.run} · 하루 최대 ${row.maxPerDay} · 점심 ${row.lunch} · 담당 교사 없음 ${noTeacher[semester] || 0}시간`);
      }
      for (const error of valid.errors.slice(0, 5)) console.log(`    검증 오류(${error.type}): ${error.text}`);
      for (const item of result.violations.filter((entry) => entry.level === "hard").slice(0, 6)) console.log(`    위반: ${item.semester}학기 ${item.cause}`);
      for (const item of result.noTeacher.slice(0, 6)) console.log(`    담당 교사 없음: ${item.semester}학기 ${item.grade}학년 ${item.classId} ${item.subject} ${item.hours}시간(${item.reason})`);
      if (!valid.ok) failed += 1;
      report.runs.push({ name: job.name, seed, ms, iterations: result.iterations, metrics: m, bySemester, noTeacher, valid: valid.ok, errors: valid.errors.slice(0, 20), violations: result.violations.filter((entry) => entry.level === "hard").slice(0, 50), notes: result.notes });
    }
  }
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
  console.log(failed ? `검증 실패 ${failed}건` : "검증 모두 통과(절대 조건: 반·교사 겹침, 불가 시간, 장소, 전공 일치, 시수)");
  process.exit(failed ? 1 : 0);
})();
