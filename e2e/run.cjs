"use strict";
// 전과정 자동 테스트: 모의 서버 + 테스트봇 웹 수강신청 → 1~5단계를 사용자처럼 클릭해 진행하고 결과를 점검한다.
// 실행: NODE_PATH=$(npm root -g) node e2e/run.cjs --seed 1 --out <폴더>   (자세한 옵션은 e2e/README.md)
const fs = require("node:fs");
const path = require("node:path");
const { startHarness, openDialogs } = require("./lib/harness.cjs");
const { planWorkbook, choiceGroups } = require("./lib/plan-fixture.cjs");
const { writeXlsx } = require("./lib/xlsx-write.cjs");
const Core = require("../test-bot-core.js");

const args = Object.fromEntries(process.argv.slice(2).join(" ").split(/\s*--/).filter(Boolean).map((part) => {
  const [key, ...rest] = part.split(/\s+/); return [key, rest.join(" ") || "1"];
}));
const SEED = Number(args.seed || 1);
const OUT = path.resolve(args.out || path.join(process.env.TMPDIR || "/tmp", `e2e-seed${SEED}`));
const CLASSES = Number(args.classes || 11);
const PER_CLASS = Number(args.perClass || 30);
const CONCURRENCY = Number(args.concurrency || 1);
const STOP_AFTER = args.stopAfter || "";
const YEAR = 2026;
const SCHOOL = "[테스트] 가상고등학교";

const text = (page, selector) => page.locator(selector).innerText().catch(() => "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitText(page, selector, pattern, timeout = 30000) {
  const end = Date.now() + timeout;
  let last = "";
  while (Date.now() < end) {
    last = await text(page, selector);
    if (pattern.test(last)) return last;
    await sleep(250);
  }
  throw new Error(`${selector} 글자가 ${pattern}와 맞지 않음(마지막: ${last.slice(0, 300)})`);
}
// 학년 탭: 교사 작업(동기화 등) 중에는 탭이 잠시 비활성이라 누른 것이 무시될 수 있다 → 선택됐는지 확인하고 다시 누른다.
const tabRetries = [];
async function selectGradeTab(page, grade) {
  for (let attempt = 0; attempt < 10; attempt++) {
    await selectGradeTab(page, grade);
    await sleep(150);
    if (await page.locator(`#applicationGrade${grade}Tab`).getAttribute("aria-selected") === "true") {
      if (attempt) tabRetries.push({ grade, attempts: attempt + 1, at: new Date().toISOString() });
      return;
    }
    await sleep(500);
  }
  throw new Error(`현 ${grade}학년 탭이 선택되지 않음`);
}
async function upload(page, trigger, file) {
  const chooser = page.waitForEvent("filechooser");
  await trigger.click();
  await (await chooser).setFiles(file);
}
// 화면 번호(1~5) → 앱 내부 단계 번호·패널. 5단계(시수 통계)는 내부 7번이다.
const STEP = { 1: [1, "#workflowStep1Panel"], 2: [2, "#workflowStep2Panel"], 3: [3, "#certificatePanel"], 4: [4, "#aggregatePanel"], 5: [7, "#workflowStep7Panel"], 6: [6, "#workflowStep6Panel"] };
async function gotoStep(page, n) {
  const [internal, panel] = STEP[n];
  const started = Date.now();
  await page.locator(`[data-workflow-step="${internal}"]`).first().click();
  await page.locator(panel).waitFor({ state: "visible", timeout: 30000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return Date.now() - started;
}


const courseName = (label) => String(label || "").replace(/\((일반|진로|융합|공통)\)$/, "").trim();
async function serverSelections(h, eventId) {
  return h.mock.adminQuery("select grade, classroom, number, name, selections, submitted_at from public.course_students where event_id=$1 order by grade, classroom::int, number::int", [eventId]);
}
function countSelections(rows) {
  const counts = {};
  for (const row of rows) if (row.submitted_at) for (const name of row.selections || []) counts[name] = (counts[name] || 0) + 1;
  return counts;
}
function shuffleSeeded(items, seed) { return Core.shuffle(items.slice(), Core.createRng(seed)); }

// 화면 확인서: 학생 목록에서 고른 학생을 눌러 미리보기 표의 과목이 서버 저장값과 같은지 본다.
async function stepCertificates({ page, h, report, roster }, round) {
  return h.step(`3. 확인서(${round}차) 학생 수·과목·학년 표기`, async () => {
    report.timings.step3Enter = await gotoStep(page, 3);
    const result = { samples: [] };
    const rows = {};
    const events = round === 1 ? report.data.events : report.data.retakeEvents;
    for (const grade of ["1", "2"]) rows[grade] = events[grade] ? (await serverSelections(h, events[grade])).filter((row) => row.submitted_at) : [];
    const submitted = rows["1"].length + rows["2"].length;
    const count = await text(page, "#studentCount");
    result.studentCount = count;
    h.check(new RegExp(`(^|\\D)${submitted}\\s*명`).test(count) || count.includes(`${submitted} / ${submitted}`), "중요", "3단계",
      "확인서 학생 수가 서버 제출 학생 수와 다름", { expected: `${submitted}명`, actual: count });
    for (const grade of ["1", "2"]) {
      const picks = shuffleSeeded(rows[grade], SEED * 31 + Number(grade)).slice(0, 8);
      for (const row of picks) {
        const id = `app-${grade}-${row.classroom}-${row.number}-${row.name}`;
        const item = page.locator(`[data-student-id="${id}"]`);
        if (!(await item.count())) { h.issue("중요", "3단계", `학생 목록에 없음: 현 ${grade}학년 ${row.classroom}반 ${row.number}번`, { expected: id }); continue; }
        await item.click();
        await page.locator("#preview table.certificate-table").waitFor({ timeout: 10000 });
        const shown = await page.locator("#preview .course-cell").allInnerTexts();
        const names = shown.filter((t) => t !== "과목명").map(courseName);
        const preview = await text(page, "#preview");
        const header = `현 ${grade}학년 ${row.classroom}반 ${row.number}번 · ${Number(grade) + 1}학년`;
        const same = names.length === row.selections.length && row.selections.every((n) => names.includes(n));
        h.check(same, "중요", "3단계", `확인서 과목이 서버 저장값과 다름(현 ${grade}학년 ${row.classroom}-${row.number})`, { expected: row.selections, actual: names });
        h.check(preview.includes(header), "중요", "3단계", `확인서 학년 표기 누락(현 ${grade}학년 → ${Number(grade) + 1}학년)`, { expected: header, actual: preview.slice(0, 200) });
        result.samples.push({ grade, seat: `${row.classroom}-${row.number}`, ok: same });
      }
    }
    result.prereqFilterCount = await text(page, "#prereqFilterCount");
    report.data[`prereq3_${round}`] = Number(result.prereqFilterCount);
    if (report.data[`prereq4_${round}`] !== undefined) h.check(Number(result.prereqFilterCount) === report.data[`prereq4_${round}`], "중요", "3·4단계", `${round}차 위계 경고 학생 수가 3단계(필터)와 4단계(머리줄)에서 다름`, { expected: report.data[`prereq4_${round}`], actual: result.prereqFilterCount });
    await h.screenshot(page, `certificate-r${round}`);
    return result;
  });
}

// 4단계 집계표(화면)에서 과목별 인원 수를 읽는다: 과목명 단추와 바로 아래 '인원 수' 행의 같은 가로 위치 칸.
async function readAggregate(page) {
  return page.evaluate(() => {
    const out = [];
    for (const button of document.querySelectorAll("#aggregatePanel [data-aggregate-course]")) {
      const cell = button.closest("td,th");
      const row = cell.closest("tr");
      const box = cell.getBoundingClientRect();
      const center = box.left + box.width / 2;
      const find = (tr) => tr && [...tr.cells].find((c) => { const b = c.getBoundingClientRect(); return b.left <= center && b.right >= center; });
      const countCell = find(row.nextElementSibling);
      let classCell = null;
      for (let tr = row.nextElementSibling, i = 0; tr && i < 5; tr = tr.nextElementSibling, i++) {
        if (/개설 학급수/.test(tr.cells[0]?.innerText || "")) { classCell = find(tr); break; }
      }
      const bare = countCell ? countCell.cloneNode(true) : null;
      bare?.querySelectorAll(".af-corner, button, .af-tag").forEach((el) => el.remove());
      const countText = countCell?.innerText || "";
      const countValue = Number((bare?.textContent || "").replace(/[^\d]/g, "") || NaN);
      out.push({ key: button.dataset.aggregateCourse, label: button.dataset.courseLabel, group: button.dataset.groupLabel,
        decision: button.dataset.decision || "", status: button.dataset.courseStatus || "", prereq: Number(button.dataset.prereqCount || 0),
        count: countValue, corner: countCell ? [...countCell.querySelectorAll(".af-corner")].map((el) => el.innerText.trim()).join(" ") : "", risk: /미달/.test(countText),
        classes: classCell ? Number(classCell.querySelector("input")?.value || classCell.innerText.replace(/[^\d]/g, "") || 0) : null,
        closed: /폐강/.test(cell.innerText + (countCell?.innerText || "")) });
    }
    return out;
  });
}

async function setCriteria(page) {
  await page.locator("#openAggregateSettings").click();
  await page.locator("#aggregateSettingsDialog[open]").waitFor();
  await page.locator("#nextYearClasses2").fill(String(CLASSES));
  await page.locator("#nextYearClasses3").fill(String(CLASSES));
  await page.locator("#maxClassSize").fill("34");
  await page.locator("#maxClassSize").press("Tab");
  await page.locator("#closeAggregateSettings").click();
  return text(page, "#aggregateSettingsSummary");
}

async function decide(page, key, choice) {
  await page.locator(`#aggregatePanel [data-aggregate-course="${key}"]`).click();
  await page.locator("#aggregateCourseMenu").waitFor({ state: "visible", timeout: 10000 });
  await page.locator(`#aggregateCourseMenu [data-closure-choice="${choice}"]`).click();
  await page.locator("#aggregateCourseMenu").waitFor({ state: "hidden", timeout: 5000 }).catch(async () => {
    await page.locator("#aggregateCourseMenu [data-aggregate-menu-close]").click().catch(() => {});
  });
}

async function stepAggregate({ page, h, report }, round) {
  return h.step(`4. 집계·개설/폐강·자동 조정·확정(${round}차)`, async () => {
    const result = {};
    if (round > 1) {
      const t0 = Date.now();
      await page.locator("#workspaceRound").selectOption(String(round));
      report.timings[`roundSwitch${round}`] = Date.now() - t0;
    }
    report.timings[`step4Enter${round}`] = await gotoStep(page, 4);
    if (round === 1) result.criteria = await setCriteria(page);
    const events = round === 1 ? report.data.events : report.data.retakeEvents;
    const serverCounts = {};
    const totals = {};
    for (const grade of ["1", "2"]) {
      if (!events[grade]) continue;
      const rows = await serverSelections(h, events[grade]);
      serverCounts[grade] = countSelections(rows);
      totals[grade] = rows.filter((row) => row.submitted_at).length;
    }
    let courses = await readAggregate(page);
    result.before = courses.map((c) => [c.key, c.label, c.count, c.decision, c.risk]);
    // 신청 인원 = 서버 자료 = 집계표
    for (const grade of Object.keys(serverCounts)) {
      const shown = courses.filter((c) => c.key.startsWith(`${grade}:`));
      const shownMap = Object.fromEntries(shown.map((c) => [courseName(c.label), c.count]));
      const diff = [];
      for (const [name, n] of Object.entries(serverCounts[grade])) if (shownMap[name] !== n) diff.push({ name, server: n, aggregate: shownMap[name] });
      for (const [name, n] of Object.entries(shownMap)) if (!(name in serverCounts[grade]) && n > 0) diff.push({ name, server: 0, aggregate: n });
      h.check(!diff.length, "치명", "4단계", `${round}차 현 ${grade}학년 집계표 인원이 서버 자료와 다름(${diff.length}과목)`, { expected: "서버 과목별 인원", actual: diff.slice(0, 10) });
    }
    const panelText = await text(page, "#aggregatePanel");
    for (const grade of Object.keys(serverCounts)) {
      const re = new RegExp(`현 ${grade}학년 → ${Number(grade) + 1}학년 · (\\d+)명`);
      const m = panelText.match(re);
      h.check(m && Number(m[1]) === totals[grade], "중요", "4단계", `${round}차 학년 머리줄(현 ${grade}학년 → ${Number(grade) + 1}학년 · n명) 표기·인원 이상`, { expected: `${totals[grade]}명`, actual: m?.[0] || "없음" });
    }
    for (const grade of Object.keys(serverCounts)) {
      const label = `${Number(grade) + 1}학년(현${grade}학년) 수강신청결과(${round}차)`;
      h.check(panelText.includes(label), "중요", "4단계", `집계표 양식 제목에 학년 표기 없음: ${label}`, { expected: label });
    }
    result.headline = panelText.split("\n").filter((line) => /^(현 [12]학년 → [23]학년 · |합계 )/.test(line)).join(" / ");
    // 화면 튐: 아래쪽 개설 학급수 칸에 값을 넣었다 지우는 동안 창 스크롤 위치가 유지되는지.
    const input = page.locator("#aggregatePanel .aggregate-class-input").nth(8);
    if (await input.count()) {
      await input.scrollIntoViewIfNeeded();
      const before = await page.evaluate(() => ({ y: window.scrollY }));
      const original = await input.inputValue();
      await input.fill(String((Number(original) || 1) + 1));
      await input.press("Tab");
      await sleep(400);
      const mid = await page.evaluate(() => window.scrollY);
      await page.locator("#aggregatePanel .aggregate-class-input").nth(8).fill(original);
      await page.locator("#aggregatePanel .aggregate-class-input").nth(8).press("Tab");
      await sleep(400);
      const after = await page.evaluate(() => ({ y: window.scrollY, focus: document.activeElement?.className || document.activeElement?.tagName }));
      result.scroll = { start: before.y, mid, after: after.y, focus: after.focus };
      h.check(Math.abs(mid - before.y) < 40 && Math.abs(after.y - before.y) < 40, "중요", "4단계", "개설 학급수 입력 후 화면 스크롤 위치가 튐", { expected: before.y, actual: [mid, after.y] });
    }
    // 개설/폐강: 그룹마다 (과목 수 − 택n − 1)개까지, 개설기준(학급당 인원 × 90%) 미만인 과목부터 폐강, 나머지 위험 과목은 개설.
    const perClass = (grade) => totals[grade] / CLASSES;
    const decisions = [];
    const byGroup = new Map();
    for (const c of courses) {
      const key = `${c.key.split(":")[0]}|${c.group}`;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(c);
    }
    for (const [key, list] of byGroup) {
      const [grade, group] = key.split("|");
      const pick = Number((group.match(/택(\d+)/) || [])[1] || 1);
      let closable = Math.max(0, list.length - pick - 1);
      for (const c of list.slice().sort((a, b) => a.count - b.count)) {
        if (!c.risk && c.decision) continue;
        const close = round === 1 && closable > 0 && c.count < perClass(grade) * 0.9;
        if (close) closable--;
        decisions.push({ key: c.key, label: c.label, grade, group, count: c.count, choice: close ? "closed" : "open" });
      }
    }
    // 학년에 기준 미달 과목이 없으면(재신청 경로를 시험하려고) 가장 큰 택n 그룹의 최소 인원 과목을 협의회 결정으로 폐강한다.
    if (round === 1) for (const grade of ["1", "2"]) {
      if (decisions.some((d) => d.grade === grade && d.choice === "closed")) continue;
      const list = courses.filter((c) => c.key.startsWith(`${grade}:`));
      const groupsOf = [...new Set(list.map((c) => c.group))].map((g) => ({ g, members: list.filter((c) => c.group === g) }))
        .sort((a, b) => b.members.length - a.members.length);
      const target = groupsOf[0]?.members.slice().sort((a, b) => a.count - b.count)[0];
      if (target) decisions.push({ key: target.key, label: target.label, grade, group: target.group, count: target.count, choice: "closed", reason: "기준 미달 없음 → 협의회 결정(최소 인원 과목)" });
    }
    const t1 = Date.now();
    for (const d of decisions) await decide(page, d.key, d.choice);
    report.timings[`decisions${round}`] = { count: decisions.length, ms: Date.now() - t1 };
    result.decisions = decisions;
    report.data[`closed${round}`] = decisions.filter((d) => d.choice === "closed").map((d) => ({ grade: d.grade, name: courseName(d.label) }));
    // 학급수 자동 조정(학년 전체)
    const t2 = Date.now();
    const adjust = page.getByRole("button", { name: "학급수 자동 조정(학년 전체)" });
    const n = await adjust.count();
    for (let i = 0; i < n; i++) { await adjust.nth(i).click(); await sleep(300); }
    report.timings[`autoAdjust${round}`] = Date.now() - t2;
    courses = await readAggregate(page);
    const after = await text(page, "#aggregatePanel");
    result.headlineAfter = after.split("\n").filter((line) => /^(현 [12]학년 → [23]학년 · |합계 )/.test(line)).join(" / ");
    const mismatch = [...after.matchAll(/목표 불일치 (\d+)/g)].map((m) => Number(m[1]));
    result.mismatch = mismatch;
    h.check(mismatch.every((v) => v === 0), "경미", "4단계", `${round}차 자동 조정 뒤에도 목표 학급수 불일치 그룹이 남음`, { expected: 0, actual: mismatch, note: "34명 이하로는 맞출 수 없음 — 협의회 결정 필요 안내가 뜨는 그룹 포함" });
    const overMax = courses.filter((c) => c.classes > 0 && c.count / c.classes > 34);
    h.check(!overMax.length, "중요", "4단계", `${round}차 자동 조정 뒤 학급당 34명 초과 과목`, { actual: overMax.map((c) => `${c.label} ${c.count}명/${c.classes}학급`) });
    const closedShown = courses.filter((c) => c.decision === "closed").length;
    h.check(closedShown === decisions.filter((d) => d.choice === "closed").length, "중요", "4단계", `${round}차 폐강 결정 수가 화면 표시와 다름`, { expected: decisions.filter((d) => d.choice === "closed").length, actual: closedShown });
    result.prereq = [...after.matchAll(/위계 경고 (\d+)명/g)].map((m) => Number(m[1]));
    const headPrereq = [...(result.headlineAfter || "").matchAll(/위계 경고 (\d+)명/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    report.data[`prereq4_${round}`] = headPrereq;
    if (report.data[`prereq3_${round}`] !== undefined) h.check(Number(report.data[`prereq3_${round}`]) === headPrereq, "중요", "3·4단계", `${round}차 위계 경고 학생 수가 3단계(필터)와 4단계(머리줄)에서 다름`, { expected: report.data[`prereq3_${round}`], actual: headPrereq });
    result.after = courses.map((c) => [c.label, c.count, c.classes, c.decision]);
    await h.screenshot(page, `aggregate-r${round}`);
    // 집계표 엑셀
    const download = page.waitForEvent("download");
    await page.locator("#downloadAggregate").click();
    const file = await (await download).path();
    result.excel = await inspectXlsx(await savedCopy(file, `aggregate-r${round}.xlsx`));
    h.check(result.excel.ok, "중요", "4단계", `${round}차 집계표 엑셀이 열리지 않음`, { actual: result.excel.error });
    // 차수 확정
    const t3 = Date.now();
    await page.locator("#roundConfirm").click();
    await sleep(800);
    const open = await openDialogs(page);
    if (open.length) {
      result.confirmDialogs = open;
      const confirmButton = page.locator("dialog[open]").getByRole("button", { name: /확정/ }).first();
      if (await confirmButton.count()) await confirmButton.click();
      await sleep(500);
    }
    report.timings[`confirm${round}`] = Date.now() - t3;
    const stateText = await text(page, "#roundConfirmState");
    result.roundState = stateText;
    h.check(/확정/.test(stateText), "중요", "4단계", `${round}차 결과 확정이 되지 않음`, { actual: stateText, dialogs: open.map((d) => d.text.slice(0, 300)) });
    return result;
  });
}

async function savedCopy(file, name) {
  const target = path.join(OUT, "downloads", name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target);
  return target;
}
// 내려받은 xlsx가 열리는지(python openpyxl), 시트 이름·크기
async function inspectXlsx(file) {
  const { execFileSync } = require("node:child_process");
  try {
    const out = execFileSync("python3", ["-I", "-c", `import json,sys,openpyxl
wb=openpyxl.load_workbook(sys.argv[1]); print(json.dumps([{"name":ws.title,"rows":ws.max_row,"cols":ws.max_column,"head":[[str(c.value) if c.value is not None else "" for c in r] for r in ws.iter_rows(min_row=1,max_row=3,max_col=12)]} for ws in wb.worksheets], ensure_ascii=False))`, file], { encoding: "utf8" });
    return { ok: true, file, sheets: JSON.parse(out) };
  } catch (error) { return { ok: false, file, error: String(error.stderr || error.message).slice(-500) }; }
}

// 재신청: 폐강 신청 학생만 대체 선택(2차) → 테스트봇
async function stepRetake({ page, h, report, roster }) {
  report.data.retakeEvents = {};
  for (const grade of ["1", "2"]) {
    await h.step(`2-4. 현 ${grade}학년 재신청(2차, 폐강 신청 학생만)·테스트봇`, async () => {
      const closed = (report.data.closed1 || []).filter((c) => c.grade === grade).map((c) => c.name);
      const before = await serverSelections(h, report.data.events[grade]);
      const expectedAffected = before.filter((row) => row.submitted_at && row.selections.some((n) => closed.includes(n))).length;
      await gotoStep(page, 2);
      await selectGradeTab(page, grade);
      await page.locator("#applicationOnlineTab").click();
      await page.locator("#cloudRefreshEvents").click();
      await page.waitForLoadState("networkidle");
      await sleep(500);
      const sourceId = report.data.events[grade];
      const appeared = await page.waitForFunction((id) => [...document.querySelectorAll("#cloudRetakeSource option")].some((o) => o.value === id), sourceId, { timeout: 15000 }).then(() => true).catch(() => false);
      if (!appeared) {
        h.issue("중요", "2단계·웹", `현 ${grade}학년 '이전 차수 신청' 목록에 1차 신청이 없음(새로고침 뒤에도)`, {
          expected: sourceId, actual: { options: await page.locator("#cloudRetakeSource option").allInnerTexts(), tab: await page.locator("#applicationGrade2Tab").getAttribute("aria-selected"),
            list: (await text(page, "#cloudEventList")).slice(0, 500), message: await text(page, "#cloudTeacherMessage") } });
        await h.screenshot(page, `retake-source-missing-grade${grade}`);
        await page.locator("#cloudRefreshEvents").click();
        await sleep(1500);
        if (!(await page.locator(`#cloudRetakeSource option[value="${sourceId}"]`).count())) return { missing: true };
      }
      await page.locator("#cloudRetakeSource").selectOption(sourceId);
      await page.locator("#cloudRetakeMode").selectOption("affected");
      await sleep(300);
      const readiness = await text(page, "#cloudRetakeReadiness");
      if (await page.locator("#cloudCreateRetake").isDisabled()) {
        h.issue("치명", "2단계·웹", `현 ${grade}학년 '다음 차수 수강신청 생성' 단추가 비활성`, { actual: readiness, source: await page.locator("#cloudRetakeSource option").allInnerTexts() });
        await h.screenshot(page, `retake-disabled-grade${grade}`);
        return { readiness };
      }
      await page.locator("#cloudCreateRetake").click();
      const message = await waitText(page, "#cloudTeacherMessage", /2차 신청 생성 완료|실패|오류|확정하세요|마감하세요|선택하세요/, 60000);
      const ok = h.check(/2차 신청 생성 완료/.test(message), "치명", "2단계·웹", `현 ${grade}학년 2차(재신청) 생성 실패`, { actual: message, readiness });
      if (!ok) return { message, readiness };
      const affected = Number((message.match(/폐강 신청 학생 (\d+)명/) || [])[1]);
      h.check(affected === expectedAffected, "중요", "2단계·웹", `현 ${grade}학년 재신청 대상 학생 수가 1차 자료와 다름`, { expected: expectedAffected, actual: affected });
      const events = await h.mock.adminQuery("select id, round from public.course_events order by created_at");
      const event = events[events.length - 1];
      report.data.retakeEvents[grade] = event.id;
      const popupPromise = h.context.waitForEvent("page");
      await page.locator("#cloudSendTestBot").click();
      const bot = await popupPromise;
      await waitText(bot, "#botBridgeStatus", /받았|명/, 20000);
      await bot.locator("#botConcurrency").fill(String(CONCURRENCY));
      await bot.locator("#botPopularity").selectOption("uniform");
      for (const id of ["#botWrongPercent", "#botViolationPercent"]) await bot.locator(id).fill("0");
      await bot.locator("#botResubmitPercent").fill("5");
      await bot.locator("#botCleanup").selectOption("keep");
      await bot.locator("#botRun").click();
      await bot.locator("#botConfirmDialog[open]").waitFor({ timeout: 20000 });
      await bot.locator("#botConfirmInput").fill("테스트");
      await bot.locator("#botConfirmRun").click();
      const t1 = Date.now();
      await bot.waitForFunction(() => !document.getElementById("botRun").disabled && !document.getElementById("botDownload").disabled, null, { timeout: 30 * 60 * 1000, polling: 1000 });
      report.timings[`retakeBot${grade}`] = Date.now() - t1;
      const stats = (await text(bot, "#botStats")).replace(/\s+/g, " ");
      const reasons = (await text(bot, "#botReasons")).replace(/\s+/g, " ");
      await h.screenshot(bot, `retake-bot-grade${grade}`);
      await bot.close();
      // 2차 서버 자료: 대상 아닌 학생은 1차 선택이 그대로, 폐강 과목은 아무도 갖지 않는다.
      const after = await serverSelections(h, event.id);
      const stillClosed = after.filter((row) => row.selections.some((n) => closed.includes(n)));
      h.check(!stillClosed.length, "중요", "2단계·웹", `현 ${grade}학년 2차 자료에 폐강 과목 선택이 남음`, { actual: stillClosed.slice(0, 5).map((r) => `${r.classroom}-${r.number}: ${r.selections.join(",")}`) });
      const keep = new Map(before.map((row) => [`${row.classroom}-${row.number}`, row]));
      const changedUnaffected = after.filter((row) => {
        const prev = keep.get(`${row.classroom}-${row.number}`);
        return prev && prev.submitted_at && !prev.selections.some((n) => closed.includes(n)) && JSON.stringify([...prev.selections].sort()) !== JSON.stringify([...row.selections].sort());
      });
      h.check(!changedUnaffected.length, "중요", "2단계·웹", `현 ${grade}학년 재신청 대상이 아닌 학생의 선택이 바뀜`, { actual: changedUnaffected.length });
      // 마감
      await page.locator("#cloudRefreshEvents").click();
      await page.waitForLoadState("networkidle");
      await sleep(500);
      const section = page.locator("#cloudEventList > section").filter({ hasText: "2차" }).first();
      await section.getByRole("button", { name: "신청 마감" }).click();
      await page.waitForLoadState("networkidle");
      await sleep(800);
      const [state] = await h.mock.adminQuery("select is_open from public.course_events where id=$1", [event.id]);
      h.check(state.is_open === false, "중요", "2단계·웹", `현 ${grade}학년 2차 신청 마감 실패`);
      return { affected, expectedAffected, stats, reasons, closed };
    });
  }
}

async function stepHours({ page, h, report }) {
  return h.step("5. 시수 통계: 시수 설정 입력·표·엑셀", async () => {
    const result = {};
    report.timings.step5Enter = await gotoStep(page, 5);
    await page.getByRole("button", { name: "시수 설정" }).click();
    await page.locator("#hoursSettingsDialog[open]").waitFor();
    for (const grade of [1, 2, 3]) { await page.locator(`#hoursClasses${grade}`).fill(String(CLASSES)); await page.locator(`#hoursClasses${grade}`).press("Tab"); }
    await page.locator("#hoursTotalTeachers").fill("62");
    await page.locator("#hoursTotalTeachers").press("Tab");
    await page.locator("#hoursNonTeaching-보건").fill("1");
    await page.locator("#hoursNonTeaching-상담").fill("1");
    await page.locator("#hoursNonTeaching-상담").press("Tab");
    await sleep(300);
    await h.screenshot(page, "hours-settings");
    await page.locator("#hoursSettingsDialog").getByRole("button", { name: /닫기|확인/ }).last().click().catch(() => page.keyboard.press("Escape"));
    await sleep(500);
    const panel = await text(page, "#workflowStep7Panel");
    result.title = (panel.match(/\d{4}학년도 교과별 시수 통계 \(총\d+학급\)/) || [""])[0];
    h.check(result.title.includes(`총${CLASSES * 3}학급`), "중요", "5단계", "시수 통계 총 학급 수가 설정과 다름", { expected: `총${CLASSES * 3}학급`, actual: result.title });
    // 학교 지정 과목(학급 수만큼)이 표에 있는지
    const schoolSubjects = ["문학", "대수", "영어Ⅰ", "독서와 작문", "화법과 언어"];
    const missing = schoolSubjects.filter((name) => !panel.includes(name));
    h.check(!missing.length, "중요", "5단계", "학교 지정 과목이 시수표에 없음", { expected: schoolSubjects, actual: { missing } });
    // 폐강 과목이 개설반으로 남지 않는지(2차 확정 결과 근거)
    result.issues = (await text(page, "#hoursIssuesBody")).slice(0, 1500);
    result.summary = (panel.match(/교과\t[^\n]*/) || [""])[0];
    result.header = panel.slice(0, 600);
    await h.screenshot(page, "hours");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "시수 통계 엑셀 다운로드" }).click();
    const file = await (await download).path();
    result.excel = await inspectXlsx(await savedCopy(file, "hours.xlsx"));
    h.check(result.excel.ok, "중요", "5단계", "시수 통계 엑셀이 열리지 않음", { actual: result.excel.error });
    const names = (result.excel.sheets || []).map((s) => s.name);
    h.check(/교사시수표/.test(names[0] || ""), "경미", "5단계", "시수 엑셀 첫 시트가 교사시수표가 아님", { actual: names });
    return result;
  });
}

async function snapshot(page) {
  const snap = {};
  await gotoStep(page, 3); snap.students = await text(page, "#studentCount");
  await gotoStep(page, 4);
  const a = await text(page, "#aggregatePanel");
  snap.aggregate = a.split("\n").filter((line) => /^(현 [12]학년 → [23]학년 · |합계 )/.test(line)).join(" / ");
  snap.round = await text(page, "#roundConfirmState");
  await gotoStep(page, 5);
  const hTxt = await text(page, "#workflowStep7Panel");
  snap.hours = (hTxt.match(/\d{4}학년도 교과별 시수 통계 \(총\d+학급\)/) || [""])[0] + " | " + (hTxt.match(/교과\t[^\n]*/) || [""])[0];
  snap.rounds = await page.locator("#workspaceRound option").allInnerTexts();
  return snap;
}

async function stepPersistence({ page, h, report, dialogs }) {
  await h.step("저장: 새로고침·백업→초기화→복원 뒤 같음, 저장 용량", async () => {
    const result = {};
    result.before = await snapshot(page);
    const t0 = Date.now();
    await page.reload();
    await page.locator("#workspaceSaveStatus").waitFor();
    await page.waitForLoadState("networkidle");
    await sleep(1500);
    report.timings.reload = Date.now() - t0;
    result.reloaded = await snapshot(page);
    h.check(JSON.stringify(result.reloaded) === JSON.stringify(result.before), "치명", "저장", "새로고침 뒤 화면 자료가 달라짐", { expected: result.before, actual: result.reloaded });
    await page.locator("#workspaceDataMenu summary").click();
    await sleep(800);
    result.usage = await text(page, "#workspaceStorageUsage");
    result.estimate = await page.evaluate(async () => { const e = await navigator.storage.estimate(); return { usage: e.usage, quota: e.quota, localStorage: JSON.stringify(localStorage).length }; });
    const backupDownload = page.waitForEvent("download");
    await page.locator("#downloadWorkspaceBackup").click();
    const backupFile = await savedCopy(await (await backupDownload).path(), "workspace-backup.json");
    result.backupBytes = fs.statSync(backupFile).size;
    // 전체 초기화(확인 창: 백업 권유 → 거절, 삭제 확인 → 수락, '초기화' 입력)
    page.removeAllListeners("dialog");
    page.on("dialog", async (dialog) => {
      dialogs.push({ type: dialog.type(), message: dialog.message() });
      if (dialog.type() === "prompt") return dialog.accept("초기화");
      if (/백업 파일로 내려받을까요/.test(dialog.message())) return dialog.dismiss();
      return dialog.accept();
    });
    if (!(await page.locator("#resetWorkspaceAll").isVisible())) await page.locator("#workspaceDataMenu summary").click();
    const navigation = page.waitForEvent("load", { timeout: 30000 }).catch(() => null);
    await page.locator("#resetWorkspaceAll").click();
    await navigation;
    await sleep(1500);
    result.afterReset = await snapshot(page);
    h.check(!/\d/.test(result.afterReset.students.replace(/^0.*$/, "")) || /^0/.test(result.afterReset.students), "중요", "저장", "전체 초기화 뒤에도 학생 자료가 남음", { actual: result.afterReset.students });
    // 복원
    await page.locator("#workspaceDataMenu summary").click();
    const navigation2 = page.waitForEvent("load", { timeout: 30000 }).catch(() => null);
    await page.locator("#restoreWorkspaceBackup").setInputFiles(backupFile);
    await navigation2;
    await sleep(2000);
    result.restored = await snapshot(page);
    h.check(JSON.stringify(result.restored) === JSON.stringify(result.before), "치명", "저장", "백업 복원 뒤 화면 자료가 원래와 다름", { expected: result.before, actual: result.restored });
    return result;
  });
}

function classifyConsole(h) {
  const appErrors = h.report.console.filter((c) => c.page !== "bot" && (c.type === "pageerror" || c.type === "error"));
  const pageErrors = appErrors.filter((c) => c.type === "pageerror");
  if (pageErrors.length) h.issue("중요", "콘솔", `앱 화면 예외 ${pageErrors.length}건`, { actual: pageErrors.slice(0, 10).map((c) => c.text) });
  const other = appErrors.filter((c) => c.type === "error" && !/status of 400/.test(c.text));
  if (other.length) h.issue("경미", "콘솔", `앱 화면 콘솔 오류 ${other.length}건`, { actual: [...new Set(other.map((c) => c.text))].slice(0, 10) });
  const botErrors = h.report.console.filter((c) => c.page === "bot" && (c.type === "pageerror" || (c.type === "error" && !/status of 400/.test(c.text))));
  if (botErrors.length) h.issue("경미", "테스트봇", `봇 화면 콘솔 오류·예외 ${botErrors.length}건`, { actual: [...new Set(botErrors.map((c) => c.text))].slice(0, 10) });
}

async function main() {
  const h = await startHarness({ outDir: OUT, seed: SEED, headless: !args.headed });
  const { report } = h;
  report.config = { seed: SEED, classes: CLASSES, perClass: PER_CLASS, concurrency: CONCURRENCY, year: YEAR };
  const page = await h.context.newPage();
  const dialogs = [];
  page.on("dialog", async (dialog) => { dialogs.push({ type: dialog.type(), message: dialog.message() }); await dialog.accept(dialog.type() === "prompt" ? dialog.defaultValue() : undefined); });
  const downloads = [];
  page.on("download", async (download) => {
    const file = path.join(OUT, "downloads", `${downloads.length + 1}-${download.suggestedFilename()}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await download.saveAs(file).catch(() => {});
    downloads.push({ name: download.suggestedFilename(), file });
  });
  report.data.downloads = downloads;
  report.data.dialogs = dialogs;
  try {
    await h.step("0. 앱 열기·교사 로그인(모의 구글)", async () => {
      const t0 = Date.now();
      await page.goto(h.url + "index.html");
      await page.locator("#curriculumGoogleLogin").waitFor({ state: "visible" });
      report.timings.firstLoad = Date.now() - t0;
      await page.locator("#curriculumGoogleLogin").click();
      await waitText(page, "#curriculumLoginStatus", /로그인 중/);
      await page.waitForLoadState("networkidle");
      // 학교·학년도
      await page.getByRole("button", { name: /학교·학년도 설정/ }).first().click();
      await page.locator("#schoolName").fill(SCHOOL);
      await page.locator("#schoolYear").fill(String(YEAR));
      await page.locator("#workspaceSettingsDialog button[type=submit]").click();
      await h.screenshot(page, "login");
      return { status: await text(page, "#curriculumLoginStatus") };
    });

    await h.step("1. 편제표 업로드(2026·2025 입학생)", async () => {
      await gotoStep(page, 1);
      const toggle = page.getByRole("button", { name: /학교·학년도·편제표 카드 펼치기/ });
      if (await toggle.isVisible().catch(() => false)) await toggle.click();
      const result = {};
      for (const year of [YEAR, YEAR - 1]) {
        const file = path.join(OUT, `plan-${year}.xlsx`);
        fs.writeFileSync(file, planWorkbook(year).bytes);
        const t0 = Date.now();
        await upload(page, page.getByRole("button", { name: `${year}학년도 신입생 3개년 편제표 업로드` }), file);
        await page.getByText(`plan-${year}.xlsx`).first().waitFor({ timeout: 20000 });
        report.timings[`upload${year}`] = Date.now() - t0;
        const open = await openDialogs(page);
        if (open.length) result[`dialogs${year}`] = open;
        const body = await text(page, "#workflowStep1Panel");
        result[year] = { groups: body.match(/선택 묶음 (\d+)개/)?.[1], cross: (body.match(/교차집중/g) || []).length, subjects: body.match(/(\d+)개 과목 표시/)?.[1] };
        h.check(result[year].groups === "7", "중요", "1단계", `${year} 편제표 선택 묶음 수가 7이 아님`, { expected: 7, actual: result[year].groups });
        h.check(result[year].cross > 0, "중요", "1단계", `${year} 편제표에 교차집중 표시 없음`, { expected: "미술↔연극 교차집중", actual: "없음" });
        await h.screenshot(page, `plan-${year}`);
      }
      return result;
    });
    if (STOP_AFTER === "1") return;

    await h.step("2-1. 웹 수강신청 방식·그룹 확인", async () => {
      await gotoStep(page, 2);
      await page.locator("#workflowStep2Panel summary").first().click();
      await page.locator("#applicationModeWeb").click();
      const result = {};
      for (const grade of ["1", "2"]) {
        await selectGradeTab(page, grade);
        await page.locator("#applicationGroupsTab").click();
        await sleep(500);
        result[grade] = (await text(page, "#courseGroupEditor")).slice(0, 3000);
        await h.screenshot(page, `groups-grade${grade}`);
      }
      return result;
    });

    const roster = {};
    for (const grade of ["1", "2"]) {
      roster[grade] = Core.generateRoster({ grade, classes: CLASSES, perClass: PER_CLASS });
      const file = path.join(OUT, `roster-grade${grade}.xlsx`);
      fs.writeFileSync(file, writeXlsx([{ name: `${grade}학년`, rows: [["학년", "반", "번호", "성명"], ...roster[grade].map((s) => [Number(s.grade), Number(s.classroom), Number(s.number), s.name])] }]));
    }
    report.data.events = {};
    report.data.bot = {};
    for (const grade of ["1", "2"]) {
      await h.step(`2-2. 현 ${grade}학년 웹 수강신청 생성·테스트봇 신청`, async () => {
        await selectGradeTab(page, grade);
        await page.locator("#applicationOnlineTab").click();
        await page.locator("#cloudTeacherControls").waitFor({ state: "visible" });
        await upload(page, page.locator('label[for="cloudRosterInput"]'), path.join(OUT, `roster-grade${grade}.xlsx`));
        const summary = await waitText(page, "#cloudRosterSummary", /신청 대상/);
        h.check(summary.includes(`현재 ${grade}학년 ${roster[grade].length}명`) && summary.includes(`${Number(grade) + 1}학년`), "중요", "2단계",
          `명렬 요약 표기(현 ${grade}학년 → ${Number(grade) + 1}학년) 이상`, { expected: `현재 ${grade}학년 ${roster[grade].length}명 · 신청 대상: ${Number(grade) + 1}학년만`, actual: summary });
        await page.locator("#applicationOnlineTab").click();
        const t0 = Date.now();
        await page.locator("#cloudCreateEvent").click();
        const message = await waitText(page, "#cloudTeacherMessage", /신청을 생성했습니다|실패|오류|확인하세요/, 60000);
        report.timings[`createEvent${grade}`] = Date.now() - t0;
        h.check(/신청을 생성했습니다/.test(message), "치명", "2단계·웹", `현 ${grade}학년 수강신청 생성 실패`, { actual: message });
        const events = await h.mock.adminQuery("select id, round, is_open, subjects, selection_groups from public.course_events order by created_at");
        const event = events[events.length - 1];
        report.data.events[grade] = event.id;
        const groups = event.selection_groups.filter((g) => g.grade === String(Number(grade) + 1));
        const expected = choiceGroups(Number(grade) + 1);
        h.check(groups.length === expected.length && expected.every((e) => groups.some((g) => Number(g.count) === e.pick && g.semester === e.semester && e.courses.every((c) => g.courses.includes(c)))),
          "중요", "2단계·웹", `서버에 저장된 ${Number(grade) + 1}학년 선택 그룹이 편제표와 다름`, { expected, actual: groups.map((g) => ({ name: g.name, count: g.count, semester: g.semester, courses: g.courses })) });
        const students = await h.mock.adminQuery("select count(*)::int as n from public.course_students where event_id=$1", [event.id]);
        h.check(students[0].n === roster[grade].length, "중요", "2단계·웹", "서버 학생 수가 명렬과 다름", { expected: roster[grade].length, actual: students[0].n });
        await sleep(800);
        const linked = await text(page, "#cloudEventList");
        h.check(/집계표 연동 해제/.test(linked), "중요", "2단계·웹", "생성한 신청이 집계표에 자동 연동되지 않음", { actual: linked.slice(0, 400) });
        await h.screenshot(page, `event-grade${grade}`);
        // 테스트봇으로 보내기 → 봇 창
        const popupPromise = h.context.waitForEvent("page");
        await page.locator("#cloudSendTestBot").click();
        const bot = await popupPromise;
        await bot.waitForLoadState("domcontentloaded");
        await waitText(bot, "#botBridgeStatus", /받았|명/, 20000);
        await bot.locator("#botScope").selectOption("all").catch(() => {});
        await bot.locator("#botConcurrency").fill(String(CONCURRENCY));
        await bot.locator("#botPopularity").selectOption("skewed");
        await bot.locator("#botWrongPercent").fill("4");
        await bot.locator("#botWrongTimes").fill("2");
        await bot.locator("#botViolationPercent").fill("10");
        await bot.locator("#botResubmitPercent").fill("10");
        await bot.locator("#botCleanup").selectOption("keep");
        await bot.locator("#botRepeat").fill("1");
        await bot.locator("#botRun").click();
        await bot.locator("#botConfirmDialog[open]").waitFor({ timeout: 20000 });
        await bot.locator("#botConfirmInput").fill("테스트");
        await bot.locator("#botConfirmRun").click();
        const t1 = Date.now();
        await bot.waitForFunction(() => !document.getElementById("botRun").disabled && !document.getElementById("botDownload").disabled, null, { timeout: 30 * 60 * 1000, polling: 1000 });
        report.timings[`bot${grade}`] = Date.now() - t1;
        const cleanup = await bot.locator("#botCleanupDialog[open]").count();
        if (cleanup) await bot.locator("#botCleanupDialog button").first().click().catch(() => {});
        const stats = await text(bot, "#botStats");
        const steps = await text(bot, "#botSteps, .bot-checklist").catch(() => "");
        const progress = await text(bot, "#botProgressText");
        const botDownload = bot.waitForEvent("download");
        await bot.locator("#botDownload").click();
        const botFile = path.join(OUT, "downloads", `bot-grade${grade}.xlsx`);
        fs.mkdirSync(path.dirname(botFile), { recursive: true });
        await (await botDownload).saveAs(botFile);
        await h.screenshot(bot, `bot-grade${grade}`);
        // 서버 자료(검증 기준)
        const rows = await h.mock.adminQuery("select grade, classroom, number, selections, submitted_at from public.course_students where event_id=$1", [event.id]);
        const submitted = rows.filter((row) => row.submitted_at && row.selections.length);
        const counts = {};
        for (const row of submitted) for (const name of row.selections) counts[name] = (counts[name] || 0) + 1;
        report.data.bot[grade] = { stats, steps: steps.slice(0, 3000), progress, submitted: submitted.length, total: rows.length, counts };
        await bot.close();
        return { event: event.id, submitted: submitted.length, total: rows.length, stats: stats.replace(/\s+/g, " ") };
      });
    }
    await h.step("2-3. 신청 마감·집계표 반영 확인", async () => {
      const result = {};
      for (const grade of ["1", "2"]) {
        await selectGradeTab(page, grade);
        await page.locator("#applicationOnlineTab").click();
        await page.locator("#cloudRefreshEvents").click();
        await page.waitForLoadState("networkidle");
        await sleep(500);
        const section = page.locator("#cloudEventList section").filter({ hasText: "접수 중" }).first();
        const closeButton = page.locator("#cloudEventList").getByRole("button", { name: "신청 마감" }).first();
        await closeButton.click();
        await page.waitForLoadState("networkidle");
        await sleep(800);
        const id = report.data.events[grade];
        const [event] = await h.mock.adminQuery("select is_open from public.course_events where id=$1", [id]);
        h.check(event && event.is_open === false, "중요", "2단계·웹", `현 ${grade}학년 신청 마감이 서버에 반영되지 않음`, { actual: event });
        result[grade] = (await text(page, "#cloudEventList")).slice(0, 600);
        await h.screenshot(page, `closed-grade${grade}`);
      }
      result.syncStatus = await text(page, "#cloudSyncStatus");
      return result;
    });
    if (args.explore) { await require(path.resolve(args.explore))({ page, h, text, sleep, gotoStep, upload, waitText, report, OUT }); return; }
    const ctx = { page, h, report, roster, dialogs, downloads };
    await stepCertificates(ctx, 1);
    if (STOP_AFTER === "3") return;
    await stepAggregate(ctx, 1);
    await stepRetake(ctx);
    await stepAggregate(ctx, 2);
    await stepCertificates(ctx, 2);
    if (STOP_AFTER === "4") return;
    await stepHours(ctx);
    await stepPersistence(ctx);
    if (args.explore2) await require(path.resolve(args.explore2))({ page, h, text, sleep, gotoStep, upload, waitText, report, OUT });
  } finally {
    report.data.tabRetries = tabRetries;
    if (tabRetries.length) h.issue("경미", "2단계·웹", `학년 탭을 눌러도 바뀌지 않아 다시 누름 ${tabRetries.length}번(교사 작업 중 탭 비활성)`, { actual: tabRetries });
    classifyConsole(h);
    await h.close();
    console.log(`보고서: ${path.join(OUT, "report.json")}`);
  }
}
main().catch((error) => { console.error(error); process.exit(1); });
