// 출력물 일치·차수 전환 경계(사용자처럼 클릭, 가상 학생). 같은 차수에서 4단계 집계표(화면·엑셀) = 5단계 시수표(화면 개설반 단추·엑셀
// '과목별 상세'·교사시수표) = 6단계(화면 '4단계' 열·분반 수·나이스 편성 엑셀 강의실 수)를 과목·학기·학급 수로 대조하고, 5·6단계 근거 줄이 같은 차수인지 본다.
// 사용: node e2e/run.cjs --seed 10 --out /tmp/e2e10  →  node e2e/output-consistency-ui.cjs /tmp/oc /tmp/e2e10/downloads/workspace-backup.json.gz
// 흐름: 백업 복원 → 맨 위 차수 1 → 2 마다 대조 → 2단계 '차수 추가'(3차 = 2차 복사) 대조 → 현2 '재신청한 학생만 있는 파일' 미리보기·반영 → 대조
//   → 2차 확정 해제·학급수 바꾸기 → 3차 근거 줄 '복사 뒤 바뀜' · 3차 값은 그대로 → '이 학년 다시 복사' → 대조 → 2차 다시 확정 → 대조
//   → 백업 내려받기 → 새 브라우저(새 PC)에서 복원 → 차수마다 대조 → 전체 초기화 → 4·5·6단계에 앞 자료가 남지 않음.
// 화면 글자·내려받은 파일(openpyxl로 읽음)로만 확인한다(앱 내부 함수를 부르지 않음).
const path = require("path"), fs = require("fs");
const ROOT = path.join(__dirname, "..");
const globalRoot = require("child_process").execSync("npm root -g", { encoding: "utf8" }).trim();
const { chromium } = require(path.join(globalRoot, "playwright"));
const { startStaticServer } = require(path.join(ROOT, "e2e/lib/static-server.cjs"));
const { readXlsxAll } = require(path.join(ROOT, "e2e/lib/step6.cjs"));
const { writeXlsx } = require(path.join(ROOT, "e2e/lib/xlsx-write.cjs"));
const { twoSemesterWideRows } = require(path.join(ROOT, "e2e/lib/two-semester-fixture.cjs"));
const OUT = process.argv[2]; const BACKUP = process.argv[3];
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (ok, what, detail = "") => { results.push({ ok: Boolean(ok), what, detail: String(detail).slice(0, 800) }); console.log(`${ok ? "✔" : "✘"} ${what}${ok ? "" : ` — ${String(detail).slice(0, 800)}`}`); };
// 과목 이름 맞추기(표기만 다른 것): 띄어쓰기·괄호 꼬리표((2학기)·(일반) 등)·가운뎃점·로마 숫자.
const norm = (name) => String(name || "").replace(/[(（][^)）]*[)）]/g, "").replace(/[\s·ㆍ]/g, "").replace(/Ⅰ/g, "1").replace(/Ⅱ/g, "2").replace(/Ⅲ/g, "3");
const addTo = (map, key, value) => map.set(key, (map.get(key) || 0) + value);
const diff = (a, b, { onlyA = false } = {}) => {
  const out = [];
  for (const [key, value] of a) if ((b.get(key) || 0) !== value) out.push(`${key}: ${value} ≠ ${b.get(key) || 0}`);
  if (!onlyA) for (const [key, value] of b) if (!a.has(key) && value) out.push(`${key}: (없음) ≠ ${value}`);
  return out;
};

async function openApp(context, url) {
  const page = await context.newPage();
  page.logs = [];
  page.on("console", (m) => { if (m.type() === "error") page.logs.push(`error: ${m.text()}`); });
  page.on("pageerror", (e) => page.logs.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => d.type() === "prompt" ? d.accept("초기화") : /백업 파일로 내려받을까요/.test(d.message()) ? d.dismiss() : d.accept());
  await page.goto(url); await page.waitForLoadState("networkidle"); await sleep(1000);
  // 이 환경의 Playwright는 blob 내려받기 이름을 'download'로만 알려 주므로 앱이 붙인 이름(a.download)을 기록한다.
  await page.addInitScript(() => {
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { window.__lastDownloadName = this.download; return click.call(this); };
  });
  return page;
}

function helpers(page) {
  const text = (selector) => page.locator(selector).first().innerText().catch(() => "");
  const appOk = async () => {
    for (const selector of ["#appConfirmDialog[open] #appConfirmOk", "#roundConfirmDialog[open] #roundConfirmOk"]) {
      const ok = page.locator(selector);
      if (await ok.count()) { const message = await page.locator(selector.split(" ")[0]).innerText(); await ok.click(); await sleep(500); return message; }
    }
    return "";
  };
  const gotoStep = async (internal, panel) => { await page.locator(`[data-workflow-step="${internal}"]`).first().click(); await page.locator(panel).waitFor({ state: "visible", timeout: 30000 }); await sleep(600); };
  const download = async (click, name) => {
    const event = page.waitForEvent("download", { timeout: 60000 });
    await click();
    const file = path.join(OUT, name);
    fs.copyFileSync(await (await event).path(), file);
    return file;
  };
  const selectRound = async (round) => {
    await page.locator("#workspaceRound").selectOption(String(round)); await sleep(1200);
    for (let i = 0; i < 3 && await appOk(); i++);
  };
  return { text, appOk, gotoStep, download, selectRound };
}

// ---- 단계별 읽기 ---------------------------------------------------------------
// 4단계 화면: 개설 학급수 칸(접근성 이름 '3학년 2학기 과목 개설 학급수').
async function read4(page, H, tag) {
  await H.gotoStep(4, "#aggregatePanel");
  const all = page.locator('#aggregateGradeBar [data-aggregate-grade=""]');
  if (await all.count()) { await all.click(); await sleep(600); }
  const cells = await page.evaluate(() => [...document.querySelectorAll("#aggregatePanel .aggregate-class-input")]
    .map((input) => ({ label: input.getAttribute("aria-label") || "", value: Number(input.value) || 0 })));
  const screen = new Map();
  for (const cell of cells) {
    const match = cell.label.match(/^(\d)학년 (?:(\d)학기|학기 미정) (.+?) 개설 학급수(?: \(폐강\))?$/);
    if (match) addTo(screen, `${match[1]}|${match[2] || ""}|${norm(match[3])}`, cell.value);
  }
  // 4단계 엑셀(학교 양식): 그룹 이름 줄('3-2 택5' 또는 '3학년 2학기 · …') → '과목' 줄 → 3줄 아래 '개설 학급수' 줄.
  const file = await H.download(() => page.locator("#downloadAggregate").click(), `${tag}-aggregate.xlsx`);
  const excel = new Map();
  for (const sheet of readXlsxAll(file)) {
    if (!/^\d학년$/.test(sheet.name)) continue;
    let semester = null;
    sheet.rows.forEach((row, index) => {
      const label = String(row[1] || "");
      const head = label.match(/^(\d)-(\d)\b/) || label.match(/^(\d)학년 (\d)학기/) || (/^\d학년 학기 미정/.test(label) ? [label, label[0], ""] : null);
      if (head && row.slice(2).every((cell, at) => !cell || /목표 총 학급수/.test(cell) || at > 0)) semester = { grade: head[1], semester: head[2] };
      if (label !== "과목" || !semester) return;
      const classesRow = sheet.rows[index + 3] || [];
      if (String(classesRow[1]) !== "개설 학급수") return;
      for (let column = 2; column < row.length; column++) {
        const name = String(row[column] || "");
        if (!name || /총 학급수|신청 합/.test(name)) continue;
        addTo(excel, `${semester.grade}|${semester.semester}|${norm(name)}`, Number(classesRow[column]) || 0);
      }
    });
  }
  return { screen, excel, file };
}

// 5단계: 근거 줄 · 시수표 개설반 단추(4단계 연동, data-hours-goto4 = '현학년|학기|과목') · 엑셀 '과목별 상세'(개설반·근거) · 교사시수표(학년별 세부과목·개설반 칸).
async function read5(page, H, tag) {
  await H.gotoStep(7, "#workflowStep7Panel");
  const basis = (await H.text("#workflowStep7Panel .round-basis-line")).replace(/\s+/g, " ").trim();
  const buttons = await page.evaluate(() => [...document.querySelectorAll("#workflowStep7Panel [data-hours-goto4]")].map((button) => ({ key: button.dataset.hoursGoto4, value: Number(button.textContent.trim()) || 0 })));
  const screen = new Map();
  for (const { key, value } of buttons) { const [current, semester, subject] = key.split("|"); screen.set(`${Number(current) + 1}|${semester}|${norm(subject)}`, value); }
  const file = await H.download(() => page.locator("#downloadHoursStats").click(), `${tag}-hours.xlsx`);
  const sheets = readXlsxAll(file);
  const detail = new Map(); const linked = new Map(); const typed = [];
  const detailSheet = sheets.find((sheet) => sheet.name === "과목별 상세");
  for (const row of detailSheet?.rows.slice(1) || []) {
    const key = `${row[0]}|${row[3]}|${norm(row[4])}`;
    addTo(detail, key, Number(row[9]) || 0);
    if (/^4단계/.test(String(row[12] || "")) || /현 \d학년 \d+차/.test(String(row[12] || ""))) addTo(linked, key, Number(row[9]) || 0);
    if (/4단계에 없는 과목/.test(String(row[12] || ""))) typed.push(key);
  }
  // 교사시수표: C열 학기(병합이면 위 칸 값), 학년 g의 세부과목 = D + 4(g−1), 개설반 = F + 4(g−1).
  const form = sheets[0]; const formMap = new Map();
  let semester = "";
  for (const row of form?.rows || []) {
    const c = String(row[2] || "").match(/^([12])/);
    if (c) semester = c[1];
    if (!semester) continue;
    for (let grade = 1; grade <= 3; grade++) {
      const subject = String(row[3 + 4 * (grade - 1)] || ""), classes = row[5 + 4 * (grade - 1)];
      if (subject && classes !== "" && classes !== undefined && /^\d+$/.test(String(classes))) addTo(formMap, `${grade}|${semester}|${norm(subject)}`, Number(classes));
    }
  }
  return { basis, screen, detail, linked, typed, form: formMap, formName: form?.name || "", file };
}

// 6단계: 근거 줄 · 그룹마다 과목 표('4단계' 열 · 6단계 분반 수) · 결과가 있고 '재계산 필요'가 아니면 나이스 편성 엑셀의 과목별 개설강의실 수.
async function read6(page, H, tag, { neis = true } = {}) {
  await H.gotoStep(8, "#workflowStep8Panel"); await sleep(600);
  const basis = (await H.text("#workflowStep8Panel .round-basis-line")).replace(/\s+/g, " ").trim();
  const groups = await page.locator("[data-cs-group]").evaluateAll((els) => els.map((e) => ({ key: e.dataset.csGroup, state: e.querySelector("em")?.dataset.state || "" })));
  const four = new Map(), sections = new Map(), rooms = new Map(), stale = [];
  for (const group of groups) {
    await page.locator(`[data-cs-group="${group.key}"]`).click(); await sleep(500);
    const [current, semester] = group.key.split(":");
    const target = Number(current) + 1;
    const rows = await page.evaluate(() => [...document.querySelectorAll("[data-cs-sections]")].map((input) => {
      const row = input.closest("tr");
      return { key: input.dataset.csSections, four: Number(row.cells[2]?.textContent.trim()) || 0, sections: Number(input.value) || 0 };
    }));
    for (const row of rows) { addTo(four, `${target}|${semester}|${norm(row.key)}`, row.four); addTo(sections, `${target}|${semester}|${norm(row.key)}`, row.sections); }
    if (!neis || group.state === "wait") continue;
    if (await page.locator("#classSectionsStale").count()) { stale.push(group.key); continue; }
    const button = page.getByRole("button", { name: "나이스 편성 엑셀", exact: true });
    if (!(await button.count()) || await button.isDisabled()) continue;
    const file = await H.download(() => button.click(), `${tag}-neis-${group.key.replace(/[^\w가-힣]/g, "_")}.xlsx`);
    const sheet = readXlsxAll(file)[0];
    const seen = new Set();
    for (const row of sheet.rows.slice(2)) {
      if (!row[4] || !row[5]) continue;
      const subject = String(row[4]).replace(/\(\d+(?:\.\d+)?\)$/, "");
      const id = `${row[2]}|${row[1]}|${norm(subject)}|${row[5]}`;
      if (seen.has(id)) continue; seen.add(id);
      addTo(rooms, `${row[2]}|${row[1]}|${norm(subject)}`, 1);
    }
  }
  return { basis, four, sections, rooms, stale, groups: groups.length };
}

// 같은 차수 대조. label = 화면에 남길 이름.
async function compareRound(page, H, label, { neis = true } = {}) {
  const round = await page.locator("#workspaceRound").inputValue();
  const tag = `${label.replace(/[^\w가-힣]/g, "_")}`;
  const s4 = await read4(page, H, tag);
  const s5 = await read5(page, H, tag);
  const s6 = await read6(page, H, tag, { neis });
  const only23 = (map) => new Map([...map].filter(([key]) => /^[23]\|/.test(key)));
  check(!diff(s4.screen, s4.excel).length && s4.screen.size > 0, `${label}: 4단계 화면 개설 학급수 = 4단계 엑셀(${s4.screen.size}과목)`, diff(s4.screen, s4.excel).join(" / "));
  check(new RegExp(`^근거: ${round}차 ·`).test(s5.basis) && s5.basis === s6.basis, `${label}: 5·6단계 근거 줄이 같은 차수(${round}차)`, `${s5.basis} | ${s6.basis}`);
  // 5단계 4단계 연동 칸(화면 단추) = 4단계, 엑셀 '과목별 상세' 같은 과목 = 화면 단추, 교사시수표 칸 = '과목별 상세'.
  check(s5.screen.size > 0 && !diff(s5.screen, s4.screen, { onlyA: true }).length, `${label}: 5단계 시수표 4단계 연동 개설반(${s5.screen.size}칸) = 4단계`, diff(s5.screen, s4.screen, { onlyA: true }).join(" / "));
  check(!diff(s5.screen, s5.detail, { onlyA: true }).length, `${label}: 5단계 엑셀 '과목별 상세' 개설반 = 5단계 화면`, diff(s5.screen, s5.detail, { onlyA: true }).join(" / "));
  const formShared = new Map([...s5.form].filter(([key]) => s5.detail.has(key)));
  check(formShared.size > 0 && !diff(formShared, s5.detail, { onlyA: true }).length, `${label}: 5단계 엑셀 '${s5.formName}' 개설반 칸 = '과목별 상세'(${formShared.size}칸)`, diff(formShared, s5.detail, { onlyA: true }).join(" / "));
  // 4단계에서 학급을 연 2·3학년 과목은 5단계에 빠짐없이(편제표에 있는 과목만 · 학기 미정 구역 제외)
  const missing = [...only23(s4.screen)].filter(([key, value]) => value > 0 && !/\|\|/.test(key) && s5.detail.has(key) === false && [...s5.detail.keys()].some((k) => k.endsWith(`|${key.split("|")[2]}`)));
  check(!missing.length, `${label}: 4단계에서 개설한 과목이 5단계 그 학기에 있음`, missing.map(([key, value]) => `${key}=${value}`).join(" / "));
  // 6단계 '4단계' 열 = 4단계(확정 차수는 확정 스냅샷 = 확정 때 4단계), 분반 수 = '4단계' 열(직접 고친 곳은 '4단계와 다름'), 나이스 강의실 수 = 분반 수.
  check(s6.groups > 0 && !diff(s6.four, only23(s4.screen), { onlyA: true }).length, `${label}: 6단계 '4단계' 열 = 4단계(${s6.four.size}과목)`, diff(s6.four, only23(s4.screen), { onlyA: true }).join(" / "));
  check(!diff(s6.sections, s6.four, { onlyA: true }).length, `${label}: 6단계 분반 수 = 4단계 열`, diff(s6.sections, s6.four, { onlyA: true }).join(" / "));
  if (neis) check(!diff(s6.rooms, s6.sections, { onlyA: true }).length, `${label}: 6단계 나이스 편성 엑셀 과목별 강의실 수 = 분반 수(${s6.rooms.size}과목, 재계산 필요 ${s6.stale.length}그룹 제외)`, diff(s6.rooms, s6.sections, { onlyA: true }).join(" / "));
  return { round, s4, s5, s6 };
}

async function restore(page, H, file) {
  await page.locator("#workspaceDataMenu summary").click();
  const nav = page.waitForEvent("load", { timeout: 60000 }).catch(() => null);
  await page.locator("#restoreWorkspaceBackup").setInputFiles(file);
  await page.locator("#appConfirmDialog[open]").waitFor({ timeout: 15000 }).catch(() => {});
  await H.appOk();
  await nav; await sleep(2500);
  for (let i = 0; i < 3 && await H.appOk(); i++);
}

(async () => {
  const { server, url } = await startStaticServer(ROOT);
  const browser = await chromium.launch();
  const route = (context) => context.route(/supabase\.co|googleapis|gstatic/, (r) => r.abort());
  let context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: "ko-KR", acceptDownloads: true });
  await route(context);
  let page = await openApp(context, url);
  let H = helpers(page);
  await restore(page, H, BACKUP);
  const rounds = await page.locator("#workspaceRound option").evaluateAll((options) => options.map((o) => o.value));
  console.log("차수:", rounds.join(", "));
  const before = {};
  for (const round of rounds) {
    await H.selectRound(round);
    before[round] = await compareRound(page, H, `${round}차`);
  }
  // 차수를 바꾼 직후: 1 → 2 → 1로 되돌아와도 같은 값(앞에 본 차수 값이 남지 않음)
  if (rounds.length > 1) {
    await H.selectRound(rounds[0]);
    const again = await compareRound(page, H, `${rounds[0]}차 다시`, { neis: false });
    check(!diff(again.s5.screen, before[rounds[0]].s5.screen).length && !diff(again.s6.sections, before[rounds[0]].s6.sections).length, `차수를 바꿨다 돌아와도 ${rounds[0]}차 5·6단계 값 그대로`, diff(again.s5.screen, before[rounds[0]].s5.screen).join(" / "));
    const last = before[rounds.at(-1)], first = before[rounds[0]];
    check(diff(last.s4.screen, first.s4.screen).length > 0, `${rounds[0]}차와 ${rounds.at(-1)}차의 4단계 값이 실제로 다름(차수마다 다른 자료를 읽음)`, "두 차수 값이 같음");
  }
  const lastRound = rounds.at(-1);
  await H.selectRound(lastRound);

  // 새 차수(직전 차수 복사) → 같은 값 · 근거 줄 '복사'
  await H.gotoStep(2, "#workflowStep2Panel");
  await page.locator("#applicationGrade2Tab").click(); await sleep(300);
  if (!(await page.locator("#applicationModeExternal").isVisible())) await page.locator("#applicationModeSettings summary").click();
  await page.locator("#applicationModeExternal").click(); await sleep(300);
  await page.locator("#applicationResultsTab").click();
  await page.locator("#addApplicationRound").click(); await sleep(800);
  for (let i = 0; i < 3 && await H.appOk(); i++);
  const copyRound = await page.locator("#workspaceRound").inputValue();
  check(Number(copyRound) === Number(lastRound) + 1, `차수 추가 → ${copyRound}차`, copyRound);
  const copied = await compareRound(page, H, `${copyRound}차(복사)`);
  check(/현1: \d+차에서 복사\(미확정\)/.test(copied.s5.basis) && /현2: \d+차에서 복사\(미확정\)/.test(copied.s5.basis), `${copyRound}차 근거 줄에 '${lastRound}차에서 복사'`, copied.s5.basis);
  check(!diff(copied.s4.screen, before[lastRound].s4.screen).length, `${copyRound}차(복사) 4단계 = ${lastRound}차 4단계`, diff(copied.s4.screen, before[lastRound].s4.screen).join(" / "));
  // 차수 비교 머리글에 '복사' 표시
  await H.gotoStep(4, "#aggregatePanel");
  await page.locator("#roundComparePanel details, #roundComparePanel summary").first().click().catch(() => {});
  await sleep(500);
  const compareHead = await H.text("#roundCompareContent thead");
  check(new RegExp(`${copyRound}차\\s*${lastRound}차에서 복사`).test(compareHead.replace(/\n/g, " ")), `4단계 차수 비교 머리글: ${copyRound}차 '${lastRound}차에서 복사'`, compareHead);

  // '재신청한 학생만 있는 파일'(현2 4명) 미리보기·반영
  const fixture = twoSemesterWideRows({});
  const partialRows = [...fixture.rows.slice(0, 3), ...fixture.rows.slice(3, 7)];
  const partialFile = path.join(OUT, "partial-grade2.xlsx");
  fs.writeFileSync(partialFile, writeXlsx([{ name: "결과", rows: partialRows }]));
  await H.gotoStep(2, "#workflowStep2Panel");
  await page.locator("#applicationGrade2Tab").click(); await sleep(300);
  await page.locator("#applicationResultsTab").click(); await sleep(300);
  await page.locator("#rosterInput").setInputFiles(partialFile);
  await page.locator("#resultImportPreview:not(.hidden)").waitFor({ timeout: 30000 }); await sleep(500);
  await page.locator('input[name="resultImportMode"][value="partial"]').check(); await sleep(800);
  const counts = await H.text("#resultImportModeCounts");
  check(/바뀌는 학생 \d+명 · 그대로 \d+명/.test(counts) && Number(counts.match(/바뀌는 학생 (\d+)명/)?.[1]) + Number(counts.match(/그대로 (\d+)명/)?.[1]) >= 4, "'재신청한 학생만' 미리보기 '바뀌는 학생 n명 · 그대로 m명'", counts);
  await page.screenshot({ path: path.join(OUT, "partial-preview.png") });
  const pick = page.getByRole("radio", { name: "심화 영어 2학기" });
  if (await pick.count()) { await pick.check(); await sleep(800); }
  await page.locator("#confirmResultImport").click(); await sleep(800);
  for (let i = 0; i < 3 && await H.appOk(); i++);
  await sleep(1200);
  const statusText = await H.text("#status");
  check(/반영/.test(statusText), "'재신청한 학생만' 결과 반영", statusText);
  const partial = await compareRound(page, H, `${copyRound}차(재신청 학생만 반영)`);
  check(/현2: \d+차 결과\(재신청 학생만 바꿈\)/.test(partial.s5.basis), `${copyRound}차 근거 줄 현2 '재신청 학생만 바꿈'`, partial.s5.basis);
  const students4 = async () => page.evaluate(() => document.querySelector("#aggregatePanel")?.innerText.match(/총학생수\s*(\d+)/g) || []);
  await H.gotoStep(4, "#aggregatePanel");
  const totals = await students4();
  check(totals.length >= 2, `${copyRound}차 4단계 두 학년 학생 수가 그대로 보임(재신청 학생만 바꿈 · 다른 학생·학년 유지)`, JSON.stringify(totals));

  // 앞 차수(lastRound)를 복사 뒤 고치면: 근거 줄 '복사 뒤 바뀜', 이 차수 값은 그대로, '이 학년 다시 복사' → 다시 같음
  await H.selectRound(lastRound);
  await H.gotoStep(4, "#aggregatePanel");
  if (await page.locator("#roundUnlock:not(.hidden)").count()) { await page.locator("#roundUnlock").click(); await sleep(400); await H.appOk(); await sleep(800); }
  const unlocked = await compareRound(page, H, `${lastRound}차 확정 해제`, { neis: false });
  check(/\(협의회 검토\)|\(미확정\)/.test(unlocked.s5.basis), `${lastRound}차 확정 해제 뒤 근거 줄 미확정`, unlocked.s5.basis);
  // 현1 첫 입력 칸을 +1 (4단계 직접 입력)
  await H.gotoStep(4, "#aggregatePanel");
  const grade1 = page.locator('#aggregateGradeBar [data-aggregate-grade="1"]');
  if (await grade1.count()) { await grade1.click(); await sleep(500); }
  const input = page.locator("#aggregatePanel .aggregate-class-input:not([disabled])").first();
  const changedLabel = await input.getAttribute("aria-label");
  const oldValue = Number(await input.inputValue());
  await input.fill(String(oldValue + 1)); await input.press("Tab"); await sleep(1000);
  const edited = await compareRound(page, H, `${lastRound}차 학급수 고침`, { neis: false });
  const changedKey = (() => { const m = changedLabel.match(/^(\d)학년 (?:(\d)학기|학기 미정) (.+?) 개설 학급수/); return `${m[1]}|${m[2] || ""}|${norm(m[3])}`; })();
  check(edited.s4.screen.get(changedKey) === oldValue + 1, `${lastRound}차 4단계 '${changedLabel}' ${oldValue} → ${oldValue + 1}`, edited.s4.screen.get(changedKey));
  await H.selectRound(copyRound);
  const afterEdit = await compareRound(page, H, `${copyRound}차(앞 차수 고친 뒤)`, { neis: false });
  check(/현1: \d+차에서 복사\(미확정\) · \d+차가 복사 뒤 바뀜/.test(afterEdit.s5.basis), `${copyRound}차 근거 줄 현1 '${lastRound}차가 복사 뒤 바뀜'`, afterEdit.s5.basis);
  check(afterEdit.s4.screen.get(changedKey) === oldValue, `${copyRound}차 값은 저절로 바뀌지 않음(${oldValue})`, afterEdit.s4.screen.get(changedKey));
  await H.gotoStep(7, "#workflowStep7Panel");
  await page.locator('#workflowStep7Panel [data-round-recopy="1"]').click(); await sleep(500);
  await H.appOk(); await sleep(1200);
  const recopied = await compareRound(page, H, `${copyRound}차(다시 복사)`, { neis: false });
  check(recopied.s4.screen.get(changedKey) === oldValue + 1 && !/복사 뒤 바뀜/.test(recopied.s5.basis), `'이 학년 다시 복사' → ${copyRound}차 4·5·6단계가 ${oldValue + 1}로 따라감`, `${recopied.s4.screen.get(changedKey)} | ${recopied.s5.basis}`);
  // 앞 차수 되돌리고 다시 확정
  await H.selectRound(lastRound);
  await H.gotoStep(4, "#aggregatePanel");
  if (await grade1.count()) { await grade1.click(); await sleep(500); }
  const again = page.locator(`#aggregatePanel .aggregate-class-input[aria-label="${changedLabel}"]`);
  await again.fill(String(oldValue)); await again.press("Tab"); await sleep(800);
  await page.locator("#roundConfirm").click(); await sleep(500);
  await H.appOk(); await sleep(1500);
  const reconfirmed = await compareRound(page, H, `${lastRound}차 다시 확정`);
  check(new RegExp(`^근거: ${lastRound}차 · .*\\(확정\\)`).test(reconfirmed.s5.basis), `${lastRound}차 다시 확정 뒤 근거 줄 '(확정)'`, reconfirmed.s5.basis);

  // 백업 → 새 PC(새 브라우저 저장소)에서 복원 → 차수마다 같음
  await page.locator("#workspaceDataMenu summary").click(); await sleep(400);
  const backupFile = await H.download(() => page.locator("#downloadWorkspaceBackup").click(), "consistency-backup.json.gz");
  const saved = {};
  for (const round of [...rounds, copyRound]) { await H.selectRound(round); saved[round] = await compareRound(page, H, `${round}차 백업 전`, { neis: false }); }
  const oldLogs = page.logs;
  await context.close();
  context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: "ko-KR", acceptDownloads: true });
  await route(context);
  page = await openApp(context, url); page.logs.push(...oldLogs);
  H = helpers(page);
  await restore(page, H, backupFile);
  for (const round of [...rounds, copyRound]) {
    await H.selectRound(round);
    const restored = await compareRound(page, H, `${round}차 새 PC 복원`, { neis: false });
    check(!diff(restored.s4.screen, saved[round].s4.screen).length && !diff(restored.s5.screen, saved[round].s5.screen).length && !diff(restored.s6.sections, saved[round].s6.sections).length && restored.s5.basis === saved[round].s5.basis,
      `${round}차 새 PC 복원 뒤 4·5·6단계 값·근거 줄 = 백업 전`, [diff(restored.s4.screen, saved[round].s4.screen).join(" / "), restored.s5.basis, saved[round].s5.basis].join(" | "));
  }

  // 전체 초기화 → 4·5·6단계에 앞 자료가 남지 않음
  if (!(await page.locator("#resetWorkspaceAll").isVisible())) await page.locator("#workspaceDataMenu summary").click();
  const nav = page.waitForEvent("load", { timeout: 60000 }).catch(() => null);
  await page.locator("#resetWorkspaceAll").click(); await sleep(500);
  for (let i = 0; i < 3 && await H.appOk(); i++) await sleep(300);
  await nav; await sleep(2000);
  await H.gotoStep(4, "#aggregatePanel");
  const left4 = await page.locator("#aggregatePanel .aggregate-class-input").count();
  await H.gotoStep(7, "#workflowStep7Panel");
  const left5 = await page.locator("#workflowStep7Panel [data-hours-goto4]").count();
  await H.gotoStep(8, "#workflowStep8Panel");
  const left6 = await page.locator("[data-cs-group]").count();
  const roundsAfter = await page.locator("#workspaceRound option").evaluateAll((options) => options.map((o) => o.value));
  check(!left4 && !left5 && !left6 && roundsAfter.join() === "1", "전체 초기화 뒤 4·5·6단계에 앞 자료 없음 · 차수 1개", JSON.stringify({ left4, left5, left6, roundsAfter }));

  check(!page.logs.some((line) => line.startsWith("pageerror")), "페이지 오류 없음", page.logs.join("\n"));
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ results, logs: page.logs }, null, 1));
  console.log(`\n결과: ${results.filter((r) => r.ok).length}/${results.length} 통과`);
  await browser.close(); server.close();
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
})().catch((error) => { console.error(error); process.exit(2); });
