"use strict";
// 전과정 자동 테스트: 모의 서버 + 테스트봇 웹 수강신청 → 1~5단계를 사용자처럼 클릭해 진행하고 결과를 점검한다.
// 실행: NODE_PATH=$(npm root -g) node e2e/run.cjs --seed 1 --out <폴더>   (자세한 옵션은 e2e/README.md)
const fs = require("node:fs");
const path = require("node:path");
const { startHarness, openDialogs } = require("./lib/harness.cjs");
const { planWorkbook, choiceGroups } = require("./lib/plan-fixture.cjs");
const { writeXlsx } = require("./lib/xlsx-write.cjs");
const Core = require("../test-bot-core.js");
const Expected = require("./lib/expected.cjs");
const { buildNeis } = require("./lib/neis-fixture.cjs");
const { GROUPS } = require("./lib/plan-fixture.cjs");
const Timetable = require("./lib/timetable-checks.cjs");
const S6 = require("./lib/step6.cjs");
const SC = require("./lib/step6-scenario.cjs");

const args = Object.fromEntries(process.argv.slice(2).join(" ").split(/\s*--/).filter(Boolean).map((part) => {
  const [key, ...rest] = part.split(/\s+/); return [key, rest.join(" ") || "1"];
}));
const SEED = Number(args.seed || 1);
const OUT = path.resolve(args.out || path.join(process.env.TMPDIR || "/tmp", `e2e-seed${SEED}`));
// 학년별 명단(사용자 학교: 현1 10학급 → 내년 2학년 11학급, 현2 11학급 그대로). --classes/--perClass는 두 학년에 같이 쓴다.
const CLASSES_BY = { "1": Number(args.classes1 || args.classes || 10), "2": Number(args.classes2 || args.classes || 11) };
const PER_BY = { "1": Number(args.perClass1 || args.perClass || 34), "2": Number(args.perClass2 || args.perClass || 28) };
const NEXT_CLASSES = Number(args.nextClasses || 11);
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
    await page.locator(`#applicationGrade${grade}Tab`).click();
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


// 화면 과목명 → 비교 키: 분류 꼬리 '(일반)' 등을 떼고, 두 학기 꼬리표는 '심화 영어 (1학기)' 모양으로 맞춘다.
const courseName = (label) => String(label || "").replace(/\s*\((일반|진로|융합|공통)\)/, "").replace(/\s*[(（]\s*([12])\s*학기\s*[)）]\s*$/, " ($1학기)").trim();
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
        const same = names.length === row.selections.length && row.selections.every((n) => names.map(Expected.bare).includes(Expected.bare(n)));
        const tagged = shown.filter((t) => Expected.TERM_TAG.test(t.replace(/\s*\((일반|진로|융합|공통)\)\s*$/, "")) || /\([12]학기\)/.test(t));
        if (tagged.length && !(report.data.certTagReported ||= new Set()).has(grade) && report.data.certTagReported.add(grade)) h.issue("중요", "3단계", `확인서 과목명에 학기 꼬리표가 보임(현 ${grade}학년 ${row.classroom}-${row.number}): ${tagged.join(", ")} [수정 대기]`, { actual: tagged, pending: true });
        h.check(same, "중요", "3단계", `확인서 과목이 서버 저장값과 다름(현 ${grade}학년 ${row.classroom}-${row.number})`, { expected: row.selections, actual: names });
        h.check(preview.includes(header), "중요", "3단계", `확인서 학년 표기 누락(현 ${grade}학년 → ${Number(grade) + 1}학년)`, { expected: header, actual: preview.slice(0, 200) });
        result.samples.push({ grade, seat: `${row.classroom}-${row.number}`, ok: same });
      }
    }
    // 확인서 선택군 순서 = 학기 → 편제표 순서
    {
      const orderIssues = [];
      for (const grade of ["1", "2"]) {
        const row = rows[grade][0];
        if (!row) continue;
        await page.locator(`[data-student-id="app-${grade}-${row.classroom}-${row.number}-${row.name}"]`).click();
        await page.locator("#preview table.certificate-table").waitFor({ timeout: 10000 });
        const shownOrder = (await page.locator("#preview .group-cell").allInnerTexts()).filter((t) => t !== "선택군").map((t) => (t.match(/(\d-\d 택\d+)/) || [])[1]);
        const expectedOrder = groupsForTarget(Number(grade) + 1).map((g) => `${g.field.slice(3, 4)}-${g.field.slice(4)} 택${g.pick}`).sort((a, b) => a.slice(2, 3).localeCompare(b.slice(2, 3)));
        const stableExpected = groupsForTarget(Number(grade) + 1).map((g, i) => ({ k: `${g.field.slice(3, 4)}-${g.field.slice(4)} 택${g.pick}`, s: g.field.slice(-1), i })).sort((a, b) => a.s.localeCompare(b.s) || a.i - b.i).map((x) => x.k);
        if (JSON.stringify(shownOrder) !== JSON.stringify(stableExpected)) orderIssues.push({ grade, shown: shownOrder, expected: stableExpected });
      }
      result.groupOrder = orderIssues;
      h.check(!orderIssues.length, "중요", "3단계", `${round}차 확인서 선택군 순서가 학기 → 편제표 순서가 아님 [수정 대기]`, { actual: orderIssues, pending: true });
    }
    result.prereqFilterCount = await text(page, "#prereqFilterCount");
    report.data[`prereq3_${round}`] = Number(result.prereqFilterCount);
    {
      const expected = expectedChecks(rows, report.data.neisPrior || null);
      const total = Object.values(expected).reduce((sum, e) => sum + e.warn, 0);
      h.check(Number(result.prereqFilterCount) === total, "중요", "3단계·위계", `${round}차 확인서 '위계 경고만' 학생 수가 하네스 기대값과 다름`, { expected: total, actual: result.prereqFilterCount });
      // 위반 학생 확인서 점검란
      const violator = (report.data.studentScreen?.[round === 1 ? "1" : "1"] || []).find((r) => r.kind === "violate");
      if (round === 1 && violator) {
        const [classroom, number] = violator.seat.split("-");
        const row = rows["1"].find((x) => x.classroom === classroom && x.number === number);
        if (row) {
          await page.locator(`[data-student-id="app-1-${classroom}-${number}-${row.name}"]`).click();
          const preview = await text(page, "#preview");
          result.violatorCertificate = preview.slice(0, 800);
          h.check(/위계/.test(preview) && !/위계 점검 이상 없음/.test(preview), "중요", "3단계·위계", "위계 위반 학생 확인서 점검란에 경고가 없음", { actual: preview.slice(0, 400) });
        }
      }
    }
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
  await page.locator("#nextYearClasses2").fill(String(NEXT_CLASSES));
  await page.locator("#nextYearClasses3").fill(String(NEXT_CLASSES));
  await page.locator("#maxClassSize").fill("34");
  await page.locator("#maxClassSize").press("Tab");
  // 잘못된 기준(%)은 적용·저장하지 않고 칸 옆에 오류(수정 8차)
  const invalid = {};
  for (const [selector, bad] of [["#openingPercent", "0"], ["#openingPercent", "500"], ["#divisionPercent", "0"]]) {
    const good = await page.locator(selector).inputValue();
    await page.locator(selector).fill(bad); await page.locator(selector).press("Tab"); await sleep(250);
    const dialogText = await text(page, "#aggregateSettingsDialog");
    invalid[`${selector}=${bad}`] = { summary: await text(page, "#aggregateSettingsSummary"), error: (dialogText.match(/[^\n]*1~[23]00[^\n]*/) || [""])[0] };
    await page.locator(selector).fill(good); await page.locator(selector).press("Tab"); await sleep(200);
  }
  await page.locator("#closeAggregateSettings").click();
  const summary = await text(page, "#aggregateSettingsSummary");
  return { summary, invalid };
}

async function setOpening(page, value) {
  await page.locator("#openAggregateSettings").click();
  await page.locator("#aggregateSettingsDialog[open]").waitFor();
  await page.locator("#openingPercent").fill(String(value)); await page.locator("#openingPercent").press("Tab"); await sleep(250);
  await page.locator("#closeAggregateSettings").click(); await sleep(400);
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
    if (round === 1) {
      result.criteria = await setCriteria(page);
      for (const [key, v] of Object.entries(result.criteria.invalid)) {
        h.check(/개설 90% · 분반 110%/.test(v.summary) && v.error, "중요", "4단계", `기준(%) 잘못된 값(${key})이 적용되거나 오류 안내가 없음`, { actual: v });
      }
      h.check(/개설 90% · 분반 110% · 최대 34명/.test(result.criteria.summary), "중요", "4단계", "기준 설정 요약이 되돌린 값과 다름", { actual: result.criteria.summary });
    }
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
    if (round > 1 && report.data.opened1?.length) {
      await setOpening(page, 130);
      courses = await readAggregate(page);
      // 1차에서 '개설'로 정한 미달 과목이 2차 집계에서도 '개설'로 이어지는지
      const lost = report.data.opened1.filter((o) => { const c = courses.find((x) => x.key.startsWith(`${o.grade}:`) && courseName(x.label) === o.name); return c && c.decision !== "open"; })
        .map((o) => `${o.grade}:${o.name}=${courses.find((x) => x.key.startsWith(`${o.grade}:`) && courseName(x.label) === o.name)?.decision || "(없음)"}`);
      result.openedCarry = { opened1: report.data.opened1.length, lost };
      h.check(!lost.length, "중요", "4단계", `1차에서 '개설'로 정한 미달 과목 ${lost.length}개가 2차 집계에서 개설 결정으로 이어지지 않음 [수정 대기]`, { actual: lost.slice(0, 8), pending: true });
      await setOpening(page, 90);
      courses = await readAggregate(page);
    }
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
    {
      const expectedRows = {};
      for (const grade of Object.keys(serverCounts)) expectedRows[grade] = await serverSelections(h, events[grade]);
      const expected = expectedChecks(expectedRows, report.data.neisPrior || null);
      report.data[`expected${round}`] = expected;
      const chips = sectionChips(panelText);
      result.chips = chips;
      Object.keys(serverCounts).forEach((grade, index) => {
        const chip = chips[index];
        h.check(chip && chip.warn === expected[grade].warn, "중요", "4단계·위계", `${round}차 현 ${grade}학년 '위계 경고 n명'이 하네스 기대값과 다름`, { expected: expected[grade].warn, actual: chip?.warn, sample: expected[grade].warned });
        h.check(chip && chip.unknown === expected[grade].unknown, "중요", "4단계·위계", `${round}차 현 ${grade}학년 '확인 불가 n명'이 하네스 기대값과 다름`, { expected: expected[grade].unknown, actual: chip?.unknown });
        h.check(chip && chip.short === expected[grade].short, "중요", "4단계·학점", `${round}차 현 ${grade}학년 '학기 학점 부족 n명'이 하네스 기대값과 다름`, { expected: expected[grade].short, actual: chip?.short });
        if (grade === "2") h.check(chip && chip.kem === expected[grade].kem, "중요", "4단계·국수영", `${round}차 현 2학년 '국수영 기준 초과 n명'이 하네스 기대값과 다름`, { expected: expected[grade].kem, actual: chip?.kem });
      });
    }
    for (const grade of Object.keys(serverCounts)) {
      if (CLASSES_BY[grade] === NEXT_CLASSES) continue;
      const label = `현 ${grade}학년 명단 ${CLASSES_BY[grade]}반 → 내년 ${Number(grade) + 1}학년 ${NEXT_CLASSES}학급`;
      h.check(panelText.includes(label), "중요", "4단계", `진급 때 학급 수 변화 표기가 없음: '${label}'`, { expected: label });
    }
    {
      const m = panelText.match(/2학년\(현1학년\) 수강신청결과[\s\S]{0,200}?학급당 학생수\t([\d.]+)/);
      const want = (totals["1"] / NEXT_CLASSES).toFixed(2);
      if (m && totals["1"]) h.check(m[1] === want, "중요", "4단계", `현1 학급당 학생수가 내년 ${NEXT_CLASSES}학급 기준이 아님`, { expected: want, actual: m[1] });
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
    const perClass = (grade) => totals[grade] / NEXT_CLASSES;
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
        decisions.push({ key: c.key, label: c.label, grade, group, count: c.count, risk: c.risk, choice: close ? "closed" : "open" });
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
    // 1차: 미달인데 '개설'로 남기는 과목을 학년마다 하나 둔다(폐강 후보 2개 이상이면 인원이 가장 많은 것) → 2차에 결정이 이어지는지 본다
    if (round === 1) for (const grade of ["1", "2"]) {
      const closedG = decisions.filter((d) => d.grade === grade && d.choice === "closed" && !d.reason);
      if (closedG.length >= 2) { const keep = closedG.sort((a, b) => b.count - a.count)[0]; keep.choice = "open"; keep.reason = "미달이지만 개설(협의회 결정)"; }
    }
    const t1 = Date.now();
    for (const d of decisions) await decide(page, d.key, d.choice);
    report.timings[`decisions${round}`] = { count: decisions.length, ms: Date.now() - t1 };
    result.decisions = decisions;
    report.data[`closed${round}`] = decisions.filter((d) => d.choice === "closed").map((d) => ({ grade: d.grade, name: courseName(d.label) }));
    if (round === 1) {
      // 개설 기준을 잠깐 130%로 올려 '미달'이 된 과목 2개를 '개설'로 정하고 90%로 되돌린다 → 2차에서 같은 결정이 이어지는지 본다
      await setOpening(page, 130);
      const risky = (await readAggregate(page)).filter((c) => c.risk && c.decision !== "closed" && !decisions.some((d) => d.key === c.key && d.choice === "closed"));
      const pickOpen = [...new Map(risky.map((c) => [c.key.split(":")[0], c])).values()].slice(0, 2);
      for (const c of pickOpen) await decide(page, c.key, "open");
      report.data.opened1 = pickOpen.map((c) => ({ grade: c.key.split(":")[0], name: courseName(c.label) }));
      await setOpening(page, 90);
    }
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
    if (round > 1) {
      const closed1 = new Set((report.data.closed1 || []).map((c) => `${c.grade}:${c.name}`));
      const wrong = courses.filter((c) => c.decision === "closed" && !decisions.some((d) => d.key === c.key && d.choice === "closed") && !closed1.has(`${c.key.split(":")[0]}:${courseName(c.label)}`));
      h.check(!wrong.length, "치명", "4단계", `${round}차: 앞 차수에서 폐강하지 않은 과목이 폐강으로 이어짐(이름만 같은 두 학기 과목) ${wrong.length}개`, { actual: wrong.map((c) => `${c.label} ${c.count}명 · 개설 ${c.classes}`), closed1: [...closed1] });
    }
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
    // 6단계 확정 전 시안(1차): 확정 전에 한 번 편성해 보고, 확정 뒤 '재계산 필요' 표시를 본다.
    if (round === 1) result.step6Draft = await step6Draft(page, h, report);
    await gotoStep(page, 4);
    // 차수 확정
    const t3 = Date.now();
    await page.locator("#roundConfirm").click();
    await sleep(800);
    const open = await openDialogs(page);
    if (open.length) {
      result.confirmDialogs = open;
      const confirmButton = (await page.locator("#roundConfirmDialog[open]").count()) ? page.locator("#roundConfirmOk") : page.locator("dialog[open]").getByRole("button", { name: /확정/ }).first();
      if (await confirmButton.count()) await confirmButton.click();
      await sleep(500);
    }
    report.timings[`confirm${round}`] = Date.now() - t3;
    const stateText = await text(page, "#roundConfirmState");
    result.roundState = stateText;
    h.check(/확정/.test(stateText), "중요", "4단계", `${round}차 결과 확정이 되지 않음`, { actual: stateText, dialogs: open.map((d) => d.text.slice(0, 300)) });
    if (round === 1 && result.step6Draft?.group) {
      await S6.open6(page);
      await page.locator("#classSectionsRound").selectOption("1").catch(() => {});
      await S6.selectGroup(page, result.step6Draft.group);
      const scr = await S6.readScreen(page);
      result.step6AfterConfirm = { badge: scr.badge, stale: scr.stale, header: scr.header };
      h.check(/1차 확정 결과/.test(scr.badge), "중요", "6단계", "1차 확정 뒤 6단계 배지가 '1차 확정 결과'가 아님", { actual: scr.badge });
      // 입력(학생·분반 수)이 같으면 재계산 표시가 안 뜨는 설계일 수 있다 → 결과 머리글이 아직 '확정 전 시안'인지 함께 본다.
      h.check(scr.stale || !/확정 전 시안/.test(scr.header), "경미", "6단계", "1차 확정 뒤에도 6단계 결과가 '확정 전 시안'으로 남고 '재계산 필요' 표시도 없음(입력 같음)", { actual: { badge: scr.badge, header: scr.header, stale: scr.stale } });
      await h.screenshot(page, "step6-stale-after-confirm");
      await gotoStep(page, 4);
    }
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
      // 봇은 지난 실행 설정(반 지정)을 기억하므로 재신청은 전체로 되돌린다.
      await bot.locator("#botScope").selectOption("all");
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
      // '신청 마감'은 앱 대화상자(#appConfirmDialog)로 묻는다.
      await page.locator("#appConfirmDialog[open] #appConfirmOk").click({ timeout: 3000 }).catch(() => {});
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
    for (const grade of [1, 2, 3]) { await page.locator(`#hoursClasses${grade}`).fill(String(NEXT_CLASSES)); await page.locator(`#hoursClasses${grade}`).press("Tab"); }
    await page.locator("#hoursTotalTeachers").fill("62");
    await page.locator("#hoursTotalTeachers").press("Tab");
    await page.locator("#hoursNonTeaching-보건").fill("1");
    await page.locator("#hoursNonTeaching-상담").fill("1");
    await page.locator("#hoursNonTeaching-상담").press("Tab");
    await sleep(300);
    {
      const dialogText = await text(page, "#hoursSettingsDialog");
      if (CLASSES_BY["1"] !== NEXT_CLASSES) {
        const label = `현 1학년 명단 ${CLASSES_BY["1"]}반 → 내년 2학년 ${NEXT_CLASSES}학급으로 계산`;
        h.check(dialogText.includes(label), "중요", "5단계", `시수 설정에 학급 수 변화 표기가 없음: '${label}'`, { actual: (dialogText.match(/현 1학년 명단[^\n]*/) || [""])[0] });
      }
    }
    await h.screenshot(page, "hours-settings");
    await page.locator("#hoursSettingsDialog").getByRole("button", { name: /닫기|확인/ }).last().click().catch(() => page.keyboard.press("Escape"));
    await sleep(500);
    // 전년도 설정 불러오기 경로: 학교 학년도를 한 해 앞(2025 → 2026학년도 시수)으로 바꿔 교사 수를 넣고, 되돌린 뒤 '전년도 설정 불러오기' →
    // 올해 교사 수 칸을 비운 상태에서 '○○과 n명 감' 증감 메모가 저절로 작성되면 안 됨(실제 점검 재현 조건)
    {
      const setYear = async (y) => {
        await page.getByRole("button", { name: /학교·학년도 설정/ }).first().click();
        await page.locator("#schoolYear").fill(String(y)); await page.locator("#schoolYear").press("Tab");
        await page.locator("#workspaceSettingsDialog button[type=submit]").click(); await sleep(800);
      };
      await setYear(YEAR - 1);
      await gotoStep(page, 5);
      result.previousYearCounts = await SC.setTeacherCounts(page);
      await setYear(YEAR);
      await gotoStep(page, 5);
      await page.locator("#hoursLoadPrevious").click(); await sleep(800);
      const loadStatus = await page.locator("#workflowStep7Panel").innerText().then((t) => (t.match(/[^\n]*학년도 (교사 수|시수 통계)[^\n]*(불러왔습니다|없습니다)[^\n]*/) || [""])[0]);
      const loadedValues = {};
      for (const id of Object.keys(SC.TEACHER_COUNTS)) loadedValues[id] = await page.locator(`[data-hours-teachers="${id}"]`).first().inputValue().catch(() => "");
      const loaded = Object.entries(SC.TEACHER_COUNTS).filter(([id, n]) => loadedValues[id] !== "").every(([id, n]) => Number(loadedValues[id]) === n) && Object.values(loadedValues).some((v) => v !== "");
      result.previousLoad = { loaded, loadStatus, sample: Object.fromEntries(Object.entries(loadedValues).slice(0, 4)) };
      h.check(loaded, "중요", "5단계", "'전년도 설정 불러오기'가 전년도 교사 수를 불러오지 못함", { actual: result.previousLoad });
      h.check(!!loadStatus, "경미", "5단계", "'전년도 설정 불러오기' 결과 안내(불러왔습니다/자료가 없습니다)가 화면에 안 나옴 — loadPreviousHoursSettings가 선언 안 된 status(=window.status)에 씀(hours-stats.js:1231·1262)", { actual: result.previousLoad });
      for (const id of Object.keys(SC.TEACHER_COUNTS)) {
        const input = page.locator(`[data-hours-teachers="${id}"]`).first();
        if (await input.count()) { await input.fill(""); await input.press("Tab"); await sleep(50); }
      }
      await sleep(300);
      const panelNow = await text(page, "#workflowStep7Panel");
      result.memoBeforeCounts = { loadStatus, memo: (panelNow.match(/[^\n]*명 (감|증)[^\n]*/) || [""])[0] };
      h.check(!/명 (감|증)/.test(result.memoBeforeCounts.memo), "중요", "5단계", "올해 교사 수가 빈 상태에서 '○○과 n명 감' 증감 메모가 저절로 작성됨 [수정 대기]", { actual: result.memoBeforeCounts, pending: true });
    }
    result.teacherCounts = await SC.setTeacherCounts(page);
    await sleep(300);
    // 교사 수 추천: 기준 교과 교사 57명·한 학기 최대 20시간(정원 모자람)에도 표가 나와야 함('최소 n명 필요'만 나오면 안 됨)
    {
      const rec = page.getByRole("button", { name: /교사 수 추천/ }).first();
      if (await rec.count()) {
        await rec.click(); await sleep(500);
        const dialog = page.locator("#hoursRecommendDialog");
        await dialog.locator("#hoursRecommendTotal").fill("57"); await dialog.locator("#hoursRecommendTotal").press("Tab"); await sleep(300);
        await dialog.locator("#hoursMaxHours").fill("20"); await dialog.locator("#hoursMaxHours").press("Tab"); await sleep(400);
        const rowsShown = await dialog.locator("table tbody tr").count().catch(() => 0);
        result.recommend = { inputs: [await dialog.locator("#hoursRecommendTotal").inputValue().catch(() => ""), await dialog.locator("#hoursMaxHours").inputValue().catch(() => "")], needed: ((await dialog.innerText().catch(() => "")).match(/최소 [\d.]+명[^.\n]*/) || [""])[0], rows: rowsShown, text: (await dialog.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 400) };
        h.check(rowsShown > 0, "중요", "5단계", "교사 수 추천(기준 57명·최대 20시간): 표 없이 '최소 n명 필요'만 나옴 [수정 대기]", { actual: result.recommend, pending: true });
        await dialog.locator("#hoursRecommendTotal").fill(""); await dialog.locator("#hoursRecommendTotal").press("Tab");
        await dialog.locator("#hoursMaxHours").fill(""); await dialog.locator("#hoursMaxHours").press("Tab"); await sleep(300);
        await dialog.getByRole("button", { name: /닫기/ }).last().click().catch(() => page.keyboard.press("Escape"));
        await sleep(300);
      }
    }
    const panel = await text(page, "#workflowStep7Panel");
    result.title = (panel.match(/\d{4}학년도 교과별 시수 통계 \(총\d+학급\)/) || [""])[0];
    h.check(result.title.includes(`총${NEXT_CLASSES * 3}학급`), "중요", "5단계", "시수 통계 총 학급 수가 설정과 다름", { expected: `총${NEXT_CLASSES * 3}학급`, actual: result.title });
    // 학교 지정 과목(학급 수만큼)이 표에 있는지
    const schoolSubjects = ["문학", "대수", "영어Ⅰ", "독서와 작문", "화법과 언어"];
    const missing = schoolSubjects.filter((name) => !panel.includes(name));
    h.check(!missing.length, "중요", "5단계", "학교 지정 과목이 시수표에 없음", { expected: schoolSubjects, actual: { missing } });
    // 폐강 과목이 개설반으로 남지 않는지(2차 확정 결과 근거)
    result.issues = (await text(page, "#hoursIssuesBody")).slice(0, 1500);
    result.summary = (panel.match(/교과\t[^\n]*/) || [""])[0];
    const closedNames = (report.data.closed1 || []).map((c) => c.name);
    const misworded = closedNames.filter((name) => new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: 현 [12]학년 2차 결과에 없어`).test(result.issues));
    h.check(!misworded.length, "경미", "5단계", "1차에서 폐강한 과목을 '결과에 없어 개설반 0 · 과목명이 다르면 입력' 확인 항목으로 안내함(폐강으로 보지 않음)", { actual: misworded });
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
  const nav6 = page.locator('[data-workflow-step="8"]');
  if (await nav6.count()) {
    await S6.open6(page);
    await page.locator("#classSectionsRound").selectOption("2").catch(() => {});
    await sleep(300);
    const gs = await S6.groups(page);
    snap.step6 = gs.map((g) => g.text).join(" | ");
    if (gs[0]) { await S6.selectGroup(page, gs[0].key); snap.step6First = (await S6.readScreen(page)).sections.map((x) => `${x.room}:${x.size}`).join(" "); }
  }
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
    // 이 환경의 Playwright는 blob 링크 내려받기 이름을 'download'로만 알려 주므로, 앱이 붙인 파일 이름(a.download)을 지켜본다(동작은 그대로).
    await page.evaluate(() => {
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { window.__lastDownloadName = this.download; return click.call(this); };
    });
    const backupDownload = page.waitForEvent("download");
    await page.locator("#downloadWorkspaceBackup").click();
    const backupEvent = await backupDownload;
    // 백업은 gzip(.json.gz)으로 내려받는다(CompressionStream 지원 브라우저). 내려받은 이름 그대로 저장해 복원에 쓴다.
    result.backupName = await page.evaluate(() => window.__lastDownloadName || "") || backupEvent.suggestedFilename();
    const backupFile = await savedCopy(await backupEvent.path(), /\.gz$/.test(result.backupName) ? "workspace-backup.json.gz" : "workspace-backup.json");
    result.backupBytes = fs.statSync(backupFile).size;
    const head = fs.readFileSync(backupFile).subarray(0, 2);
    result.backupGzip = head[0] === 0x1f && head[1] === 0x8b;
    h.check(/\.json\.gz$/.test(result.backupName) && result.backupGzip, "중요", "저장", "백업 파일이 gzip(.json.gz)으로 내려받아지지 않음", { actual: { name: result.backupName, gzip: result.backupGzip } });
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


// ---- 학생 화면 직접 신청(위계 위반·국수영 초과 시나리오) ----
// 이 환경(Playwright + route)에서는 내려받기 이름이 'download'로 와서, 최근 파일부터 열어 '신청코드' 머리글이 있는 엑셀을 찾는다.
async function readCodes(downloads, after) {
  const { execFileSync } = require("node:child_process");
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    for (const item of downloads.slice(after).reverse()) {
      if (!item.file || !fs.existsSync(item.file) || !fs.statSync(item.file).size) continue;
      try {
        const out = execFileSync("python3", ["-I", "-c", `import json,sys,openpyxl
ws=openpyxl.load_workbook(sys.argv[1]).active
print(json.dumps([[str(c.value) if c.value is not None else "" for c in r] for r in ws.iter_rows()], ensure_ascii=False))`, item.file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        const rows = JSON.parse(out);
        const head = rows[0] || [];
        if (!head.includes("신청코드")) continue;
        item.kind = "codes";
        const col = (name) => head.indexOf(name);
        return rows.slice(1).map((r) => ({ grade: r[col("현재학년")], classroom: r[col("반")], number: r[col("번호")], name: r[col("이름")], code: r[col("신청코드")] }));
      } catch { /* xlsx가 아님 */ }
    }
    await sleep(300);
  }
  throw new Error("학생 코드 엑셀을 내려받지 못함");
}

function groupsForTarget(targetGrade) { return GROUPS.filter((g) => g.field.startsWith(`sem${targetGrade}`)); }
// 같은 학년 두 학기 그룹에 다 있는 과목은 앱·서버에서 '이름 (n학기)'로 쓴다. 학생은 한 학기만 고른다.
function termName(targetGrade, name, field) {
  const fields = groupsForTarget(targetGrade).filter((g) => g.members.some((m) => m[2] === name)).map((g) => g.field);
  return new Set(fields.map((f) => f.slice(-1))).size > 1 ? `${name} (${field.slice(-1)}학기)` : name;
}
function randomValid(targetGrade, rng) {
  const picks = []; const used = new Set();
  for (const g of groupsForTarget(targetGrade)) {
    const names = Core.shuffle(g.members.map((m) => m[2]).filter((n) => !used.has(n)), rng).slice(0, g.pick);
    names.forEach((n) => used.add(n));
    picks.push(...names.map((n) => termName(targetGrade, n, g.field)));
  }
  return picks;
}
// 위반 선택: 현1 → 2-2 '역학과 에너지'를 2-1 '물리학' 없이(+ 다른 2-2 과목), 현2 → 3-1 중국어 + 3-2 일본어 회화(위계), 국·수·영 과목을 최대로(국수영 초과).
function violatingPicks(targetGrade, rng) {
  const by = (field, pick) => groupsForTarget(targetGrade).find((g) => g.field === field && g.pick === pick).members.map((m) => m[2]);
  if (targetGrade === 2) {
    const s21 = Core.shuffle(by("sem21", 3).filter((n) => n !== "물리학"), rng).slice(0, 3);
    const s22 = ["역학과 에너지", ...Core.shuffle(by("sem22", 3).filter((n) => n !== "역학과 에너지"), rng).slice(0, 2)];
    return [...s21, Core.shuffle(by("sem22", 1), rng)[0], ...s22];
  }
  const kem = new Set(["미적분Ⅱ", "기하", "실용 통계", "심화 영어", "수학과제 탐구", "인공지능 수학", "영미 문학 읽기", "영어 발표와 토론", "언어생활 탐구"]);
  const used = new Set();
  const fill = (field, n) => {
    const names = by(field, 5).filter((x) => !used.has(x));
    const a = names.filter((x) => kem.has(x)).slice(0, n);
    for (const x of Core.shuffle(names.filter((y) => !kem.has(y)), rng)) if (a.length < n) a.push(x);
    a.forEach((x) => used.add(x));
    return a.map((x) => termName(3, x, field));
  };
  return [...fill("sem31", 5), "중국어", ...fill("sem32", 5), "일본어 회화"];
}

async function studentApply(studentPage, h, eventId, student, picks) {
  await studentPage.goto(`${h.url}index.html#event=${eventId}`);
  await studentPage.locator("#cloudStudentClassroom").waitFor({ state: "visible" });
  await studentPage.locator("#cloudStudentClassroom").fill(student.classroom);
  await studentPage.locator("#cloudStudentNumber").fill(student.number);
  await studentPage.locator("#cloudStudentCode").fill(student.code);
  await studentPage.locator("#cloudStudentLogin button[type=submit]").click();
  await studentPage.locator("#cloudStudentChangeCode:not(.hidden), #cloudStudentCourses:not(.hidden)").first().waitFor({ timeout: 15000 });
  if (await studentPage.locator("#cloudStudentChangeCode:not(.hidden)").count()) {
    const next = String(100000 + ((Number(student.classroom) * 7919 + Number(student.number) * 104729) % 899999));
    await studentPage.locator("#cloudStudentNewCode").fill(next);
    await studentPage.locator("#cloudStudentNewCodeConfirm").fill(next);
    await studentPage.locator("#cloudStudentChangeCode button[type=submit]").click();
    await studentPage.locator("#cloudStudentCourses:not(.hidden)").waitFor({ timeout: 15000 });
  }
  const warnings = [];
  for (let page = 0; page < 4; page++) {
    for (const name of picks) {
      const box = studentPage.locator(`#cloudStudentChoices input[type=checkbox][value="${name}"]`);
      if (await box.count() && await box.isVisible() && !(await box.isChecked())) await box.check();
    }
    warnings.push((await studentPage.locator("#courseCheckStudentPanel").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300));
    if (await studentPage.locator("#cloudStudentNext").isVisible()) { await studentPage.locator("#cloudStudentNext").click(); await sleep(150); continue; }
    break;
  }
  await studentPage.locator("#cloudStudentSave").click();
  const message = await waitText(studentPage, "#cloudStudentMessage", /저장|제출|선택하세요|오류|실패/, 15000);
  return { message, warnings };
}

async function stepStudentScreen({ page, h, report, roster, downloads }, grade) {
  return h.step(`2-2b. 현 ${grade}학년 학생 화면 직접 신청(위계 위반·국수영 초과 5%, 정상, 미제출)`, async () => {
    const eventId = report.data.events[grade];
    const codes = (await readCodes(downloads, 0)).filter((c) => c.grade === grade);
    const last = codes.filter((c) => c.classroom === String(CLASSES_BY[grade]));
    const rng = Core.createRng(SEED * 131 + Number(grade));
    const violators = Math.min(last.length - 3, Math.ceil(roster[grade].length * 0.05));
    const plan = last.map((student, index) => ({ student, kind: index < violators ? "violate" : index < last.length - 3 ? "normal" : "skip" }));
    const context = await h.newStudentContext();
    const studentPage = await context.newPage();
    const results = [];
    const t0 = Date.now();
    for (const item of plan) {
      if (item.kind === "skip") { results.push({ seat: `${item.student.classroom}-${item.student.number}`, kind: "skip" }); continue; }
      const targetGrade = Number(grade) + 1;
      const picks = item.kind === "violate" ? violatingPicks(targetGrade, rng) : randomValid(targetGrade, rng);
      const r = await studentApply(studentPage, h, eventId, item.student, picks);
      const saved = /저장/.test(r.message) && !/선택하세요|실패/.test(r.message);
      h.check(saved, "중요", "웹·학생 화면", `현 ${grade}학년 ${item.student.classroom}-${item.student.number} 학생 화면 저장 실패`, { actual: r.message, picks });
      if (item.kind === "violate") h.check(/위계|경고|선이수/.test(r.message + r.warnings.join(" ")), "중요", "웹·학생 화면", `위계 위반 저장인데 학생 화면에 경고가 없음(현 ${grade}학년 ${item.student.classroom}-${item.student.number})`, { actual: { message: r.message, panel: r.warnings } });
      results.push({ seat: `${item.student.classroom}-${item.student.number}`, kind: item.kind, picks, message: r.message.slice(0, 200) });
    }
    report.timings[`studentScreen${grade}`] = { students: results.filter((r) => r.kind !== "skip").length, ms: Date.now() - t0 };
    await h.screenshot(studentPage, `student-screen-grade${grade}`);
    await context.close();
    const rows = await serverSelections(h, eventId);
    for (const r of results.filter((x) => x.picks)) {
      const row = rows.find((x) => `${x.classroom}-${x.number}` === r.seat);
      h.check(row && row.submitted_at && JSON.stringify([...row.selections].sort()) === JSON.stringify([...r.picks].sort()), "중요", "웹·학생 화면", `학생 화면 저장값이 서버와 다름(${r.seat})`, { expected: r.picks, actual: row?.selections });
    }
    report.data.studentScreen = report.data.studentScreen || {};
    report.data.studentScreen[grade] = results;
    return { violators, normal: results.filter((r) => r.kind === "normal").length, skipped: results.filter((r) => r.kind === "skip").length };
  });
}

// ---- 위계·국수영 기대값(하네스 계산) ----
function expectedChecks(rowsByGrade, prior) {
  const out = {};
  for (const [grade, rows] of Object.entries(rowsByGrade)) {
    const target = Number(grade) + 1;
    let warn = 0, unknown = 0, unknownOnly = 0, kem = 0, short = 0;
    const need = GROUPS.filter((g) => g.field.startsWith(`sem${target}`)).reduce((sum, g) => sum + g.pick, 0);
    const warned = [];
    for (const row of rows.filter((r) => r.submitted_at)) {
      const seat = `${row.classroom}-${row.number}`;
      const p = grade === "2" && prior ? prior.get(seat) || null : null;
      const st = Expected.prerequisiteStatus(row.selections, target, p);
      if (st.violations.length) { warn++; warned.push(seat); }
      if (row.selections.length < need) short++;
      if (st.unknowns.length) { unknown++; if (!st.violations.length) unknownOnly++; }
      if (grade === "2") {
        const g2 = p ? [...p].filter((n) => ["미적분Ⅰ", "확률과 통계"].includes(n)) : ["미적분Ⅰ"];
        if (Expected.kemOver(row.selections, g2)) kem++;
      }
    }
    out[grade] = { warn, unknown, unknownOnly, short, kem: grade === "2" ? kem : undefined, warned: warned.slice(0, 20) };
  }
  return out;
}

async function openCourseCheck(page, grade) {
  await gotoStep(page, 2);
  await selectGradeTab(page, grade);
  await page.locator("#applicationGroupsTab").click();
  await page.locator("#courseCheckOpenGroups").click();
  await page.locator("#courseCheckDialog[open]").waitFor();
  await sleep(300);
}
async function readCourseCheck(page) {
  const body = await text(page, "#courseCheckDialogBody");
  const at = body.indexOf("현재 차수 결과 점검");
  return { results: at >= 0 ? body.slice(at) : "", neis: await text(page, "#courseCheckNeisStatus").catch(() => ""), prior: await text(page, "#courseCheckPriorStatus").catch(() => "") };
}
// 점검 팝업 '현재 차수 결과 점검': "현 N학년 → M학년 과목 n명 점검 · 위계 미충족 a명 · … · 국수영 기준 초과 c명 · 확인 불가 d명"
function dialogSection(results, grade) {
  const line = String(results).split("\n").find((l) => l.startsWith(`현 ${grade}학년 → ${Number(grade) + 1}학년 과목`) && /점검 ·/.test(l)) || "";
  const n = (re) => { const m = line.match(re); return m ? Number(m[1]) : null; };
  return { line, warn: n(/위계 미충족 (\d+)명/), unknown: n(/확인 불가 (\d+)명/), kem: n(/국수영 기준 초과 (\d+)명/), short: n(/학기 학점 부족 (\d+)명/) };
}
const pickNumber = (textValue, pattern) => { const m = String(textValue).match(pattern); return m ? Number(m[1]) : null; };

async function stepPrerequisites({ page, h, report, roster }) {
  return h.step("2-5. 위계·국수영 점검: 하네스 기대값 대조(나이스 자료 전·후)", async () => {
    const rows = {};
    for (const grade of ["1", "2"]) rows[grade] = await serverSelections(h, report.data.events[grade]);
    const before = expectedChecks(rows, null);
    const result = { expectedBefore: before, dialog: {} };
    for (const grade of ["1", "2"]) {
      await openCourseCheck(page, grade);
      const r = await readCourseCheck(page);
      result.dialog[`before${grade}`] = r.results;
      const sec = dialogSection(r.results, grade);
      const warn = sec.warn;
      result.dialog[`unknownBefore${grade}`] = sec.unknown;
      h.check(sec.unknown === before[grade].unknown, "중요", "2단계·위계", `현 ${grade}학년 '확인 불가' 학생 수(점검 팝업, 나이스 전)가 기대값과 다름`, { expected: before[grade].unknown, actual: sec.unknown });
      if (grade === "2") h.check(sec.kem === before[grade].kem, "중요", "2단계·국수영", "현 2학년 '국수영 기준 초과' 학생 수(점검 팝업)가 기대값과 다름", { expected: before[grade].kem, actual: sec.kem });
      h.check(warn === before[grade].warn, "중요", "2단계·위계", `현 ${grade}학년 위계 경고 학생 수(점검 팝업, 나이스 전)가 기대값과 다름`, { expected: before[grade].warn, actual: warn, text: r.results.slice(0, 600) });
      await page.locator("#courseCheckDialog").getByRole("button", { name: "닫기" }).last().click();
    }
    // 나이스 자료(현 2학년)
    const chosen3 = new Map(rows["2"].filter((r) => r.submitted_at).map((r) => [`${r.classroom}-${r.number}`, r.selections]));
    const neis = buildNeis({ roster: roster["2"], chosen3, seed: SEED });
    // 이 환경의 Chromium은 한글 파일 이름을 고르면 'cancel'로 끝내므로(파일이 안 들어감) 영문 이름으로 저장한다.
    const files = neis.files.map((f) => { const file = path.join(OUT, `neis-${f.name.match(/\d{4}_\d/)[0]}.xlsx`); fs.writeFileSync(file, f.bytes); return file; });
    await openCourseCheck(page, "2");
    const t0 = Date.now();
    await upload(page, page.locator('label[for="courseCheckPriorInput"]'), files);
    await page.locator("#courseCheckNeisStatus").waitFor({ timeout: 30000 }).catch(() => {});
    await sleep(800);
    report.timings.neisUpload = Date.now() - t0;
    const open = await openDialogs(page);
    result.neisDialogs = open.filter((d) => d.id !== "courseCheckDialog").map((d) => d.text.slice(0, 500));
    const r = await readCourseCheck(page);
    result.neisStatus = r.neis || r.prior;
    h.check(/연결 330명|연결 \d+명/.test(result.neisStatus) && pickNumber(result.neisStatus, /연결 (\d+)명/) === roster["2"].length, "중요", "2단계·나이스",
      "나이스 자료 연결 학생 수가 현 2학년 명렬과 다름", { expected: roster["2"].length, actual: result.neisStatus });
    const after = expectedChecks(rows, neis.prior);
    result.expectedAfter = after;
    result.dialog.after2 = r.results;
    const sec2 = dialogSection(r.results, "2");
    const warn = sec2.warn;
    h.check(sec2.kem === after["2"].kem, "중요", "2단계·나이스", "현 2학년 '국수영 기준 초과'(나이스 후)가 기대값과 다름", { expected: after["2"].kem, actual: sec2.kem });
    h.check(warn === after["2"].warn, "중요", "2단계·나이스", "현 2학년 위계 경고 학생 수(나이스 후)가 기대값과 다름", { expected: after["2"].warn, actual: warn, text: r.results.slice(0, 600) });
    const unknown = sec2.unknown;
    h.check(unknown === after["2"].unknown, "중요", "2단계·나이스", "나이스 자료를 올린 뒤에도 '확인 불가' 학생이 남음(기대 0)", { expected: after["2"].unknown, actual: unknown, before: before["2"].unknown });
    await h.screenshot(page, "course-check-neis");
    await page.locator("#courseCheckDialog").getByRole("button", { name: "닫기" }).last().click();
    report.data.expected1 = after;
    report.data.neisPrior = neis.prior;
    return { ...result, neisRows: neis.rows };
  });
}

// 4단계 학년별 점검 칩: '위계 경고 n명 · 확인 불가 n명 · 학기 학점 부족 n명 · 국수영 기준 초과 n명'
function sectionChips(panelText) {
  return [...panelText.matchAll(/위계 경고 (\d+)명\n(?:확인 불가 (\d+)명\n)?학기 학점 부족 (\d+)명(?:\n국수영 기준 초과 (\d+)명)?/g)]
    .map((m) => ({ warn: Number(m[1]), unknown: Number(m[2] || 0), short: Number(m[3]), kem: Number(m[4] || 0) }));
}



// ---- 6단계 실제 시나리오 ----
async function step6Draft(page, h, report) {
  const out = {};
  report.timings.step6EnterDraft = await S6.open6(page);
  await page.locator("#classSectionsRound").selectOption("1").catch(() => {});
  await sleep(300);
  const gs = await S6.groups(page);
  out.groups = gs.length;
  const scr0 = await S6.readScreen(page);
  out.badge = scr0.badge;
  h.check(/1차 · 확정 전 시안/.test(scr0.badge), "중요", "6단계", "1차 확정 전인데 배지가 '1차 · 확정 전 시안'이 아님", { actual: scr0.badge });
  if (!gs.length) { h.issue("중요", "6단계", "확정 전 1차 결과에서 편성 그룹이 없음"); return out; }
  out.group = gs[0].key;
  await S6.selectGroup(page, out.group);
  const r = await S6.solve(page);
  out.solve = { ms: r.ms, feasible: r.feasible, summary: r.summary.slice(0, 200), header: (await S6.readScreen(page)).header };
  // 1차에는 폐강 과목 신청 학생(재신청 대상)이 남아 있어 그만큼 미배정이 정상이다.
  const closed = (report.data[`closed1`] || []).filter((c) => c.grade === out.group[0]).map((c) => c.name);
  const rows = await serverSelections(h, report.data.events[out.group[0]]);
  const groupCourses = GROUPS.find((g) => g.field === `sem${Number(out.group[0]) + 1}${out.group.split(":")[1]}` && g.pick === Number((out.group.match(/택(\d+)/) || [])[1]))?.members.map((m) => m[2]) || [];
  const closedHere = closed.filter((n) => groupCourses.includes(n));
  const expectedUnassigned = rows.filter((x) => x.submitted_at && x.selections.some((n) => closedHere.includes(n))).length;
  const shown = Number((r.summary.match(/미배정 (\d+)명/) || [])[1] || 0);
  out.expectedUnassigned = expectedUnassigned;
  // 7차 뒤: 폐강 과목 학생을 '재신청 대상 n명'으로 따로 셀 것으로 기대
  out.retakeSeparated = /재신청 대상\s*\d+명/.test(r.summary + " " + (await page.locator('section[aria-label="편성 결과"]').innerText().catch(() => "")));
  const retakeCount = Number(((r.summary + " " + (await page.locator('section[aria-label="편성 결과"]').innerText().catch(() => ""))).match(/재신청 대상\s*(\d+)명/) || [])[1] || NaN);
  out.retakeCount = retakeCount;
  if (expectedUnassigned) h.check(retakeCount === expectedUnassigned && r.feasible === true, "중요", "6단계", `1차 시안: 폐강 과목 학생을 '재신청 대상 n명'으로 따로 세고 편성 가능으로 보지 않음`, { expected: expectedUnassigned, actual: { retakeCount, feasible: r.feasible, summary: r.summary.slice(0, 200) } });
  h.check(r.feasible === true || shown === expectedUnassigned, "중요", "6단계", `확정 전 시안 편성 불가(${out.group}): 미배정 ${shown}명(폐강 과목 신청 ${expectedUnassigned}명)`, { actual: r.summary.slice(0, 300) });
  if (false && r.feasible === false && expectedUnassigned && shown === expectedUnassigned) h.issue("경미", "6단계", `1차 시안: 폐강 과목 신청 학생(재신청 대상) ${expectedUnassigned}명 때문에 '모두 배정하는 편성을 찾지 못했습니다'(불가)로 나옴 — 폐강 미배정은 따로 안내하는 편이 맞아 보임 [6단계 7차 대기]`, { actual: r.summary.slice(0, 200) });
  await h.screenshot(page, "step6-draft");
  return out;
}

async function stepClassSections({ page, h, report, roster }) {
  return h.step("6. 분반 편성: 교사·시간·전 그룹 편성·학급 단위·재신청 부분 재계산·엑셀 검증", async () => {
    const result = { groups: {}, solves: [] };
    report.timings.step6Enter = await S6.open6(page);
    const rounds = await page.locator("#classSectionsRound option").allInnerTexts();
    await page.locator("#classSectionsRound").selectOption("2").catch(() => {});
    await sleep(300);
    result.rounds = rounds;
    result.badge = (await S6.readScreen(page)).badge;
    h.check(/2차 확정 결과/.test(result.badge), "중요", "6단계", "2차 확정 뒤 6단계 배지가 '2차 확정 결과'가 아님", { actual: result.badge });
    const t0 = Date.now();
    result.teachers = await SC.setupTeachers(page);
    report.timings.step6Teachers = Date.now() - t0;
    h.check(!result.teachers.rebuild.duplicateNames.length && result.teachers.rebuild.afterRebuild >= result.teachers.rebuild.first - 2, "중요", "6단계", "교사 명단 만들기 → 삭제 → 다시 만들기 뒤 교사 이름·id가 겹침", { actual: result.teachers.rebuild });
    h.check(result.teachers.fromHours >= Object.values(SC.TEACHER_COUNTS).reduce((a, b) => a + b, 0) - 5, "중요", "6단계", "'5단계 교사 수로 명단 만들기' 교사 수가 5단계 입력과 다름", { expected: Object.values(SC.TEACHER_COUNTS).reduce((a, b) => a + b, 0), actual: result.teachers.fromHours });
    const gs = await S6.groups(page);
    const info = [];
    for (const g of gs) {
      await S6.selectGroup(page, g.key);
      info.push({ key: g.key, grade: String(Number(g.key[0]) + 1), semester: g.key.split(":")[1], blocks: Number(await page.getByLabel("블록 수", { exact: true }).inputValue()), credit: SC.groupCredit(g.key) });
    }
    // 첫 그룹: 방식 비교·추천 → 추천 방식으로 편성(내년 반 배정표 전: '같은 담임반끼리 묶기'는 추천에서 빠져야 함)
    {
      const g = info[0];
      await S6.selectGroup(page, g.key);
      const scr = await S6.readScreen(page);
      result.classesLine = scr.classesLine; result.classMapLineBefore = scr.classMapLine; result.homeroomWarnBefore = scr.homeroomWarn; result.blockMax = scr.blockMax;
      const nextOf = (key) => NEXT_CLASSES, rosterOf = (key) => CLASSES_BY[key[0]];
      h.check(new RegExp(`${rosterOf(g.key)}학급 → 내년 ${g.grade}학년 ${nextOf(g.key)}학급`).test(scr.classesLine), "중요", "6단계", `학급 수 안내가 '현 ${g.key[0]}학년 ${rosterOf(g.key)}학급 → 내년 ${g.grade}학년 ${nextOf(g.key)}학급'이 아님`, { actual: scr.classesLine });
      h.check(String(scr.blockMax) === String(NEXT_CLASSES), "중요", "6단계", `블록당 최대 분반 기본값이 내년 학급 수(${NEXT_CLASSES})가 아님`, { actual: scr.blockMax });
      const tc = Date.now();
      await page.locator("#classSectionsCompare").click();
      await page.locator('section[aria-label="편성 방식 비교"]').waitFor({ timeout: 120000 });
      await page.waitForFunction(() => !document.querySelector("#classSectionsSolve")?.disabled, null, { timeout: 120000 });
      report.timings.step6Compare = Date.now() - tc;
      const compare = await page.locator('section[aria-label="편성 방식 비교"]').innerText();
      result.compare = compare.replace(/\s+/g, " ").slice(0, 500);
      const rec = page.locator('section[aria-label="편성 방식 비교"] tr.is-recommended [data-cs-use-mode]');
      h.check(await rec.count() === 1, "중요", "6단계", "방식 비교에서 추천 방식이 하나가 아님", { actual: result.compare });
      const recommended = await rec.first().getAttribute("data-cs-use-mode").catch(() => "");
      if (CLASSES_BY[g.key[0]] !== NEXT_CLASSES) h.check(scr.homeroomWarn || /추천 제외/.test(result.compare), "중요", "6단계", "진급 때 학급 수가 바뀌는데(내년 반 배정표 없음) '같은 담임반끼리 묶기'에 지금 반 기준 경고·추천 제외 표시가 없음", { actual: { line: scr.classMapLine, compare: result.compare } });
      if (CLASSES_BY[g.key[0]] !== NEXT_CLASSES) h.check(recommended !== "homeroom", "중요", "6단계", "내년 반 배정표가 없는데 '같은 담임반끼리 묶기'가 추천됨", { actual: result.compare });
      const r = await S6.solve(page, 'section[aria-label="편성 방식 비교"] tr.is-recommended [data-cs-use-mode]');
      result.recommendedMode = await page.getByLabel("편성 방식", { exact: true }).inputValue();
      result.solves.push({ group: g.key, ms: r.ms, feasible: r.feasible, applied: [], summary: r.summary.slice(0, 300), via: "비교·추천" });
    }
    // 진급 때 반 편성: 현1(10→11) = '새로 편성' 고정(다른 값 선택 불가), 현2(11→11) = '그대로 올라감'으로 고름
    result.promotion = {};
    for (const grade of ["1", "2"]) {
      const g = info.find((x) => x.key.startsWith(`${grade}:`));
      if (!g) continue;
      await S6.selectGroup(page, g.key);
      const select = page.locator(`[data-cs-promotion="${grade}"]`);
      if (!(await select.count())) { result.promotion[grade] = "대기(설정 없음)"; continue; }
      const state = await select.evaluate((el) => ({ value: el.value, disabled: [...el.options].filter((o) => o.disabled).map((o) => o.value) }));
      const reason = await page.locator("#classSectionsPromotionReason").innerText().catch(() => "");
      if (CLASSES_BY[grade] !== NEXT_CLASSES) {
        h.check(state.value === "new" && state.disabled.includes("same") && /새로 편성/.test(reason), "중요", "6단계", `현 ${grade}학년(${CLASSES_BY[grade]}→${NEXT_CLASSES}학급) 진급 때 반 편성이 '새로 편성' 고정이 아님`, { actual: { state, reason } });
      } else {
        await select.selectOption("same"); await sleep(400);
        const line = await page.locator("#classSectionsClassMapLine").innerText().catch(() => "");
        h.check(/그대로 올라감/.test(line), "중요", "6단계", `현 ${grade}학년 '그대로 올라감'을 골랐는데 배정 기준 안내가 바뀌지 않음`, { actual: line });
        state.after = await select.inputValue(); state.line = line;
      }
      result.promotion[grade] = { ...state, reason };
    }
    // '그대로 올라감'인 현2는 배정표 없이 담임반 묶기가 추천 대상이어야 함
    {
      const g2 = info.find((x) => x.key.startsWith("2:") && /택5/.test(x.key)) || info.find((x) => x.key.startsWith("2:"));
      if (g2 && CLASSES_BY["2"] === NEXT_CLASSES) {
        await S6.selectGroup(page, g2.key);
        await page.locator("#classSectionsCompare").click();
        await page.locator('section[aria-label="편성 방식 비교"]').waitFor({ timeout: 120000 });
        await page.waitForFunction(() => !document.querySelector("#classSectionsSolve")?.disabled, null, { timeout: 120000 });
        const cmp = (await page.locator('section[aria-label="편성 방식 비교"]').innerText()).replace(/\s+/g, " ");
        result.compareSame = cmp.slice(0, 400);
        h.check(!/추천 제외/.test(cmp), "중요", "6단계", "현2 '그대로 올라감'인데 '같은 담임반끼리 묶기'가 추천 제외로 남음", { actual: cmp.slice(0, 300) });
      }
    }
    // 학기마다: 블록 시간 추천 → 적용 → 전 학년 함께 다시 계산
    result.semesters = {};
    for (const semester of ["1", "2"]) {
      const g = info.find((x) => x.semester === semester);
      if (!g) continue;
      await S6.selectGroup(page, g.key);
      const r = await S6.recommendAndSolveSemester(page);
      result.semesters[semester] = r;
      h.check(/함께 다시 계산했습니다/.test(r.status), "중요", "6단계", `${semester}학기 '전 학년 함께 다시 계산'이 끝나지 않음`, { actual: r.status });
      h.check((r.solveMs || 0) < 60000, "경미", "6단계", `${semester}학기 전 학년 함께 계산이 오래 걸림 ${((r.solveMs || 0) / 1000).toFixed(1)}초`, { actual: r.solveMs });
    }
    const times = {};
    // 그룹별 상태, 불가면 '제안 적용'(최대 3번) 뒤 다시 계산
    for (const g of info) {
      await S6.selectGroup(page, g.key);
      times[g.key] = await page.locator("[data-cs-block-times]").evaluateAll((els) => els.map((e) => e.value));
      const staleNow = (await S6.readScreen(page)).stale;
      h.check(!staleNow, "중요", "6단계", `${g.key}: '전 학년 함께 다시 계산' 직후인데 '입력 변경됨, 재계산 필요'가 뜸`, { actual: staleNow });
      let feasible = (await page.locator("#classSectionsSummary").getAttribute("data-feasible").catch(() => null)) === "true";
      let summary = await page.locator("#classSectionsSummary").innerText().catch(() => "");
      const log = { group: g.key, feasible, applied: [], summary: summary.slice(0, 300), times: times[g.key] };
      for (let tries = 0; !feasible && tries < 3; tries++) {
        // 시드 짝수: '과목 하나만 학급 단위' 제안을 먼저, 홀수: '모두 학급 단위'(교과 전체) 제안을 먼저(없으면 첫 제안)
        const options = await page.locator("[data-cs-apply]").evaluateAll((els) => els.map((e, i) => ({ i, text: e.parentElement.innerText.replace(/\s+/g, " ") })));
        const want = SEED % 2 === 0 ? /을\(를\) 학급 단위로 운영하면\(이동/ : /모두 학급 단위로 운영/;
        const chosen = options.find((o) => want.test(o.text)) || options[0];
        const apply = page.locator("[data-cs-apply]").nth(chosen ? chosen.i : 0);
        if (!(await apply.count())) break;
        if (chosen && /학급 단위/.test(chosen.text)) log.classUnitPath = SEED % 2 === 0 && want.test(chosen.text) ? "단일 과목" : /모두/.test(chosen.text) ? "모두" : "기타";
        log.applied.push((await apply.locator("xpath=..").innerText()).replace(/\s+/g, " ").slice(0, 160));
        await apply.click(); await sleep(300);
        const r = await S6.solve(page);
        feasible = r.feasible; summary = r.summary;
        log.feasibleAfter = feasible;
      }
      log.summary = summary.slice(0, 300);
      log.foreign = !feasible && /^모든 학생 배정/.test(summary) && /오류 \d+건: .*\((현\d → \d학년 \d학기 · [^)]*)/.test(summary) && !summary.includes(g.key.split(":")[2]) ? summary.match(/\((현\d → \d학년 \d학기 · [^ )]*[^)]*)/)?.[1] : "";
      log.teacherNote = await page.locator('section[aria-label="편성 결과"]').innerText().then((t) => (t.match(/교사 부족[^\n]*/) || [""])[0]).catch(() => "");
      result.solves.push(log);
      if (!feasible) h.issue(log.applied.length ? "중요" : "경미", "6단계", `${g.key}: 편성 불가${log.applied.length ? "(제안 적용 뒤에도)" : "(적용할 제안 없음)"}`, { actual: { summary: log.summary, applied: log.applied, teacherNote: log.teacherNote } });
      {
        // 다른 그룹(교사 부족 원인 그룹)의 오류가 이 그룹에 붙었는지: 오류 문장 속 그룹 표시가 이 그룹이 아닌 경우
        const label = g.key.split(":")[2];
        // 오류 부분만 본다(다른 그룹은 '참고: 같은 시간 다른 그룹 — …' 정보로 붙는 것이 정상)
        const errorPart = (summary.match(/오류 \d+건:[\s\S]*?(?=참고:|$)/) || [""])[0];
        const others = [...errorPart.matchAll(/\((현\d → \d학년 \d학기 · ([^ )]+ ?[^ )]*)[^)]*)\)/g)].map((m) => m[1]).filter((t) => !t.includes(label));
        if (others.length) h.issue("중요", "6단계", `${g.key}: 다른 그룹(${others[0]})의 오류가 이 그룹 결과에 붙음`, { actual: summary.slice(0, 300) });
      }
    }
    // 내년 반 배정표(현1 10반 → 새 11반으로 섞음, 고정 양식: 현 학년·현 반·현 번호·새 반·새 번호)
    const classMap = new Map();
    result.classMap = {};
    for (const grade of ["1", "2"]) {
      const g1 = info.find((g) => g.key.startsWith(`${grade}:`));
      if (!g1) continue;
      // 현1: 10반 → 새 11반으로 섞은 배정표를 올림 / 현2: 11 → 11은 배정표 없이 '그대로 올라감'(지금 반 = 내년 반, 번호 빈칸)
      const same = CLASSES_BY[grade] === NEXT_CLASSES;
      if (same) {
        for (const st of roster[grade]) classMap.set(`${grade}-${st.classroom}-${st.number}`, { classroom: String(st.classroom), number: "" });
        continue;
      }
      const rng = Core.createRng(SEED * 4243);
      const students = same ? roster[grade].slice() : Core.shuffle(roster[grade].slice(), rng);
      const counters = {};
      const mine = [];
      students.forEach((st, i) => {
        const nc = same ? String(st.classroom) : String((i % NEXT_CLASSES) + 1);
        counters[nc] = (counters[nc] || 0) + 1;
        const value = { classroom: nc, number: same ? String(st.number) : String(counters[nc]) };
        classMap.set(`${grade}-${st.classroom}-${st.number}`, value);
        // 일부 학생은 '01'처럼 앞자리 0을 붙여 적는다(실제 엑셀에서 흔함) → 같은 학생으로 읽혀야 함
        const pad = (v) => (i % 7 === 0 ? String(v).padStart(2, "0") : String(v));
        mine.push([grade, pad(st.classroom), pad(st.number), pad(value.classroom), pad(value.number)]);
      });
      const rows = [["현 학년", "현 반", "현 번호", "새 반", "새 번호"], ...mine];
      const file = path.join(OUT, `classmap-grade${grade}.xlsx`);
      fs.writeFileSync(file, writeXlsx([{ name: "내년 반 배정", rows }]));
      await S6.selectGroup(page, g1.key);
      await page.locator("#classSectionsClassMap").setInputFiles(file);
      await sleep(800);
      const scr = await S6.readScreen(page);
      const cm = { line: scr.classMapLine, warn: scr.homeroomWarn, status: await page.locator("#classSectionsStatus").innerText().catch(() => "") };
      result.classMap[grade] = cm;
      const m = cm.line.match(/(\d+)\/(\d+)명/);
      const submittedCount = Number(m?.[2]);
      h.check(m && m[1] === m[2] && (new RegExp(`${roster[grade].length}명 읽음`).test(cm.status) || new RegExp(`갱신 ${submittedCount}명`).test(cm.status)), "중요", "6단계", `현 ${grade}학년 내년 반 배정표를 올렸는데 반영 인원이 맞지 않음(앞자리 0 '01' 표기 학생 포함)`, { expected: `그룹 학생 ${submittedCount}명 전부`, actual: cm });
      const missing = Number((cm.status.match(/(?:명단|이 차수 결과)에 없는 학생 (\d+)명/) || [])[1] || 0);
      const unsubmitted = roster[grade].length - submittedCount;
      if (missing && missing === unsubmitted && /명단에 없는 학생/.test(cm.status)) h.issue("경미", "6단계", `현 ${grade}학년 배정표 읽기: 미제출 학생 ${missing}명을 '명단에 없는 학생(반·번호 표기 확인)'으로 안내(표기 오류처럼 보임)`, { actual: cm.status });
      else if (missing !== unsubmitted) h.issue("중요", "6단계", `현 ${grade}학년 배정표 읽기: 결과에 없는 학생 ${missing}명(미제출 ${unsubmitted}명과 다름)`, { actual: cm.status });
      h.check(!scr.homeroomWarn, "경미", "6단계", "내년 반 배정표를 올린 뒤에도 '담임반 묶기: 지금 반 기준' 경고가 남음", { actual: cm });
      if (grade !== "1") continue;
      await page.locator("#classSectionsCompare").click();
      await page.locator('section[aria-label="편성 방식 비교"]').waitFor({ timeout: 120000 });
      await page.waitForFunction(() => !document.querySelector("#classSectionsSolve")?.disabled, null, { timeout: 120000 });
      result.compareWithMap = (await page.locator('section[aria-label="편성 방식 비교"]').innerText()).replace(/\s+/g, " ").slice(0, 400);
    }
    // 학급 단위 과목: 3학년 택1(일본어/중국어)
    const unitGroup = info.find((g) => /택1/.test(g.key) && g.grade === "3");
    if (unitGroup) {
      await S6.selectGroup(page, unitGroup.key);
      for (const name of ["일본어", "중국어", "일본어 회화", "중국어 회화"]) {
        const select = page.getByLabel(`${name} 운영 방식`, { exact: true });
        if (await select.count()) { await select.selectOption("class"); await sleep(200); }
      }
      const r = await S6.solve(page);
      const unit = await page.locator('section[aria-label="학급 단위 과목"]').innerText().catch(() => "");
      result.classUnit = { group: unitGroup.key, feasible: r.feasible, summary: r.summary.slice(0, 200), card: unit.replace(/\s+/g, " ").slice(0, 500) };
      const rooms = await page.locator("[data-cs-unit-room]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-cs-unit-room"), e.options[e.selectedIndex]?.textContent]));
      result.classUnit.rooms = rooms;
      h.check(rooms.length === NEXT_CLASSES && rooms.every(([, v]) => v), "중요", "6단계", "학급 단위 과목: 담임반마다 과목이 배분되지 않음", { expected: `내년 ${NEXT_CLASSES}개 반`, actual: rooms });
      // 내년 반을 모를 때('아직 모름', 배정표 없음): 나이스에는 행 대신 '확인 필요' 안내, 명렬표에는 '학급 단위 과목' 시트
      const promo = page.locator(`[data-cs-promotion="${unitGroup.key[0]}"]`);
      const promoValue = await promo.inputValue().catch(() => "");
      if (await promo.count() && promoValue === "same" && !result.classMap?.[unitGroup.key[0]]) {
        const before = await promo.inputValue();
        await promo.selectOption("unknown"); await sleep(400);
        const files = await S6.exportGroup(page, path.join(OUT, "downloads", "step6"), "unit-unknown");
        const confirm = files.neis.find((sheet) => sheet.name === "확인 필요")?.rows.map((r) => r.join(" ")).join(" / ") || "";
        const unitRows = files.neis[0].rows.slice(2).filter((r) => S6.CLASS_UNIT_ROOM.test(String(r[5]))).length;
        const unitSheet = files.rosters.find((sheet) => sheet.name === "학급 단위 과목");
        result.classUnit.unknown = { unitRows, confirm: confirm.slice(0, 300), unitSheet: unitSheet ? unitSheet.rows.slice(0, 3) : null };
        h.check(!unitRows && /학급 단위 과목: .*\d+명분 행은 반 배정표를 올린 뒤 생성/.test(confirm), "중요", "6단계", "내년 반을 모를 때 학급 단위 과목 나이스 '확인 필요' 안내가 없거나 행이 생김", { actual: result.classUnit.unknown });
        h.check(!!unitSheet, "중요", "6단계", "분반 명렬표에 '학급 단위 과목' 시트가 없음", { actual: files.rosters.map((x) => x.name).slice(-3) });
        await promo.selectOption(before); await sleep(400);
      }
      await h.screenshot(page, "step6-class-unit");
    }
    // 그룹별 엑셀 검증 + 그룹 간 시간 검증
    const selections = await finalSelections(h, report);
    const sectionsByGroup = {};
    const dir = path.join(OUT, "downloads", "step6");
    for (const g of info) {
      await S6.selectGroup(page, g.key);
      const screen = await S6.readScreen(page);
      const files = await S6.exportGroup(page, dir, g.key.replace(/[:\s]/g, "_"));
      const courseNames = [...new Set(screen.sections.map((x) => x.course))];
      const groupCourses = GROUPS.find((x) => x.field === `sem${g.grade}${g.semester}` && x.pick === Number((g.key.match(/택(\d+)/) || [])[1]))?.members.map((m) => m[2]) || courseNames;
      const sel = new Map([...selections].filter(([key]) => key.startsWith(`${g.key[0]}-`)));
      const classUnitCourses = screen.classUnit.length ? [...new Set(screen.classUnit.map(([, v]) => v))] : [];
      const { result: check, sections } = S6.checkGroup({ h, label: g.key, files, screen, selections: sel, semester: g.semester, courseNames: groupCourses, classUnitCourses });
      // 나이스 반·번호: 배정표가 있는 현1은 새 반·번호, 없으면 비우고 참고 열(현 학년-반-번호)
      {
        const neisRows = files.neis[0].rows.slice(2).filter((r) => r.some(Boolean));
        const wrong = [];
        for (const r of neisRows) {
          const want = classMap.get(r[10]);
          const gotClass = String(r[7] || "").replace(/반$/, ""), gotNo = String(r[8] || "");
          if (!(want && gotClass === want.classroom && gotNo === want.number)) wrong.push({ ref: r[10], class: r[7], no: r[8], want });
        }
        check.neisClassWrong = wrong.length;
        h.check(!wrong.length, "중요", "6단계", `${g.key}: 나이스 반·번호가 내년 반 배정표(새 반·번호)와 다름 ${wrong.length}줄`, { actual: wrong.slice(0, 5) });
      }
      if (classUnitCourses.length) {
        check.classUnit = screen.classUnit;
        // 나이스: 학급 단위 행 = 그룹 학생 수, 과목 = 그 학생의 내년 반에 배정된 과목
        const unitOf = new Map(screen.classUnit);
        const unitRows = files.neis[0].rows.slice(2).filter((r) => S6.CLASS_UNIT_ROOM.test(String(r[5])));
        const wrongUnit = unitRows.filter((r) => unitOf.get(String(r[7]).replace(/반$/, "")) !== String(r[4]).replace(/\(\d+(?:\.\d+)?\)$/, ""));
        const groupStudents = [...sel.keys()].length;
        check.classUnitNeis = { rows: unitRows.length, students: groupStudents, wrong: wrongUnit.length, rosterSheets: files.rosters.length };
        h.check(unitRows.length === groupStudents && !wrongUnit.length, "중요", "6단계", `${g.key}: 학급 단위 과목 나이스 행이 담임반(내년 반) 배정과 다름(행 ${unitRows.length}/${groupStudents}명, 반·과목 불일치 ${wrongUnit.length})`, { actual: wrongUnit.slice(0, 5) });
        const unitSheet = files.rosters.find((sheet) => sheet.name === "학급 단위 과목");
        check.classUnitNeis.unitSheet = unitSheet ? unitSheet.rows.length - 2 : 0;
        h.check(unitSheet && unitSheet.rows.length - 2 === NEXT_CLASSES, "중요", "6단계", `${g.key}: 분반 명렬표 '학급 단위 과목' 시트가 없거나 내년 반 수와 다름`, { actual: unitSheet ? unitSheet.rows.slice(0, 4) : files.rosters.map((x) => x.name) });
      }
      sectionsByGroup[g.key] = sections;
      {
        // 학생별 그룹 과목 수 = 택n(나이스 이동 행 + 학급 단위 행). 한 그룹에서 택n보다 많으면 이중 배정(치명)
        const pick = Number((g.key.match(/택(\d+)/) || [])[1]);
        const rows = files.neis[0].rows.slice(2).filter((r) => r.some(Boolean));
        const bareSubject = (r) => Expected.bare(String(r[4]).replace(/\(\d+(?:\.\d+)?\)$/, "").replace(/^\([^)]*\)/, ""));
        const per = new Map();
        for (const r of rows) if (groupCourses.includes(bareSubject(r))) per.set(r[10], (per.get(r[10]) || 0) + 1);
        const unitWaiting = screen.classUnit.length && !rows.some((r) => S6.CLASS_UNIT_ROOM.test(String(r[5])));
        const over = [...per].filter(([, n]) => n > pick);
        const under = unitWaiting ? [] : [...sel.keys()].filter((k) => (per.get(k) || 0) < pick && !screen.unassignedRows);
        check.perStudent = { pick, students: per.size, over: over.length, under: under.length };
        h.check(!over.length, "치명", "6단계", `${g.key}: 한 학생이 그룹에서 택${pick}보다 많은 과목에 배정(이중 배정) ${over.length}명 [수정 대기]`, { actual: over.slice(0, 5), path: result.solves.find((v) => v.group === g.key)?.classUnitPath || "", pending: true });
        h.check(!under.length, "중요", "6단계", `${g.key}: 택${pick}보다 적게 배정된 학생 ${under.length}명(미배정 표 없음)`, { actual: under.slice(0, 5) });
        // '희망과 다른 학생 n명' = 학급 단위 행 과목이 학생 신청과 다른 학생 수
        if (screen.classUnit.length && !unitWaiting) {
          const card = await page.locator('section[aria-label="학급 단위 과목"]').innerText().catch(() => "");
          const shownMismatch = Number((card.match(/희망과 다른 학생 (\d+)명/) || [])[1] ?? NaN);
          const mine = new Map([...selections].filter(([k]) => k.startsWith(`${g.key[0]}-`)));
          const mismatch = new Set();
          for (const r of rows) if (S6.CLASS_UNIT_ROOM.test(String(r[5]))) { const want = (mine.get(r[10]) || []).map((x) => x.subject); if (!want.includes(bareSubject(r))) mismatch.add(r[10]); }
          check.classUnitMismatch = { shown: shownMismatch, computed: mismatch.size };
          h.check(shownMismatch === mismatch.size, "중요", "6단계", `${g.key}: 학급 단위 '희망과 다른 학생 n명'이 나이스 행으로 센 수와 다름`, { expected: mismatch.size, actual: shownMismatch });
        }
      }
      result.groups[g.key] = check;
    }
    const unavailable = Object.fromEntries(SC.SPECIAL_TEACHERS.map((t) => [t.name, t.slots]));
    result.across = S6.checkAcross({ h, sectionsByGroup, unavailable, fixed: SC.FIXED });
    const special = Object.values(sectionsByGroup).flat().filter((x) => unavailable[x.teacher]).map((x) => `${x.teacher}:${x.room}:${x.times.join(",")}`);
    result.specialTeacherSections = special.slice(0, 20);
    await h.screenshot(page, "step6-solved");
    // 같은 학년·학기 두 그룹의 블록을 일부러 같은 시간으로 두면(학생 시간 겹침) 앱이 알려 주는지 본다 → 원래대로 되돌림.
    const same = info.filter((g) => g.grade === "2" && g.semester === "2");
    if (same.length >= 2) {
      const [a, b] = same;
      await S6.selectGroup(page, a.key);
      const overlap = times[b.key][0].split(",").slice(0, a.credit);
      while (overlap.length < a.credit) overlap.push(times[a.key][0].split(",")[overlap.length]);
      await SC.setBlockTimes(page, [overlap.join(","), ...times[a.key].slice(1)]);
      const r = await S6.solve(page);
      const body = await text(page, 'section[aria-label="편성 결과"]');
      result.overlapProbe = { group: a.key, with: b.key, times: overlap.join(","), feasible: r.feasible, warned: r.feasible === false && /겹|같은 시간|충돌|같은 학생/.test(body + r.summary + r.status), summary: r.summary.slice(0, 200) };
      h.check(result.overlapProbe.warned, "중요", "6단계", `같은 학년·학기 두 그룹(${a.key}·${b.key})의 블록이 같은 시간인데 오류(같은 학생 시간 겹침·불가)로 나오지 않음`, { actual: result.overlapProbe });
      await SC.setBlockTimes(page, times[a.key]);
      if (await page.locator("#classSectionsSolveSemester").count()) await S6.solve(page, "#classSectionsSolveSemester"); else await S6.solve(page);
    }
    report.data.step6Snapshot = await step6Snapshot(page, info.map((g) => g.key));
    // 재신청 시뮬레이션: 2차 확정 해제 → 학생 3명 선택 변경(교사 화면) → 재확정 → '바뀐 학생만 다시 계산'
    result.partial = await step6Partial({ page, h, report, groupKey: info[0].key, before: sectionsByGroup[info[0].key] });
    report.data.step6Snapshot = await step6Snapshot(page, info.map((g) => g.key));
    return result;
  });
}

async function step6Snapshot(page, keys) {
  await S6.open6(page);
  const snap = { groups: (await S6.groups(page)).map((g) => g.text) };
  for (const key of keys.slice(0, 3)) {
    await S6.selectGroup(page, key);
    const scr = await S6.readScreen(page);
    snap[key] = scr.sections.map((x) => `${x.room}:${x.size}`).join(" ");
  }
  return snap;
}

async function step6Partial({ page, h, report, groupKey, before }) {
  const out = {};
  const grade = groupKey[0];
  await gotoStep(page, 4);
  await page.locator("#workspaceRound").selectOption("2");
  await sleep(300);
  await page.locator("#roundUnlock").click();
  await sleep(300);
  // 확정·해제는 앱 대화상자(#roundConfirmDialog)로 묻는다.
  if (await page.locator("#roundConfirmDialog[open]").count()) await page.locator("#roundConfirmOk").click();
  await sleep(800);
  out.unlocked = await text(page, "#roundConfirmState");
  // 교사 화면: 학생 선택 과목 변경(2차 신청)
  await gotoStep(page, 2);
  await selectGradeTab(page, grade);
  await page.locator("#applicationOnlineTab").click();
  await page.locator("#cloudRefreshEvents").click();
  await page.waitForLoadState("networkidle"); await sleep(500);
  const section = page.locator("#cloudEventList > section").filter({ hasText: "2차" }).first();
  await section.getByRole("button", { name: "학생 선택 과목 변경" }).click();
  await page.locator("#cloudTeacherEditDialog[open]").waitFor({ timeout: 20000 });
  const options = await page.locator("#cloudTeacherEditStudent option").evaluateAll((els) => els.map((o) => ({ value: o.value, text: o.textContent })));
  const rng = Core.createRng(SEED * 977);
  // 2차(폐강 신청 학생만)는 대상이 아닌 학생·유지 과목 칸이 잠겨 있다 → 이 그룹에서 고칠 수 있는 칸이 있는 학생을 찾아 3명까지 바꾼다.
  const candidates = Core.shuffle(options.filter((o) => o.value && !/미제출/.test(o.text)), rng);
  const [, semester, groupName] = groupKey.split(":");
  out.changed = [];
  out.tried = 0;
  for (const option of candidates) {
    if (out.changed.length >= 3 || out.tried >= 120) break;
    out.tried++;
    if (!(await page.locator("#cloudTeacherEditDialog[open]").count())) {
      await section.getByRole("button", { name: "학생 선택 과목 변경" }).click();
      await page.locator("#cloudTeacherEditDialog[open]").waitFor({ timeout: 20000 });
    }
    await page.locator("#cloudTeacherEditStudent").selectOption(option.value);
    await sleep(200);
    const fieldset = page.locator("#cloudTeacherEditChoices fieldset").filter({ hasText: groupName }).first();
    const state = await fieldset.locator("input[type=checkbox]").evaluateAll((els) => els.map((e) => ({ value: e.value, checked: e.checked, disabled: e.disabled })));
    const fromBox = state.find((b) => b.checked && !b.disabled);
    const toBox = state.find((b) => !b.checked && !b.disabled);
    if (!fromBox || !toBox) continue;
    await fieldset.locator(`input[value="${fromBox.value}"]`).uncheck();
    await fieldset.locator(`input[value="${toBox.value}"]`).check();
    await page.locator("#cloudTeacherEditSave").click();
    let msg = "";
    for (let i = 0; i < 80 && !/변경했습니다|실패|정확히|오류|없습니다|할 수 없/.test(msg); i++) {
      await sleep(250);
      msg = `${await text(page, "#cloudTeacherEditMessage")} ${await text(page, "#cloudTeacherMessage")}`;
    }
    const m = option.text.match(/(\d)학년 (\d+)반 (\d+)번/);
    out.changed.push({ student: m ? `${m[1]}-${m[2]}-${m[3]}` : option.text, from: fromBox.value, to: toBox.value, message: msg.trim().slice(0, 120) });
  }
  h.check(out.changed.filter((c) => /변경했습니다/.test(c.message)).length >= 1, "중요", "2단계·웹", "교사 화면 '학생 선택 과목 변경'으로 2차 학생 선택을 바꾸지 못함", { actual: { tried: out.tried, changed: out.changed } });
  if (await page.locator("#cloudTeacherEditDialog[open]").count()) await page.locator("#cloudTeacherEditClose").click();
  await sleep(1500);
  // 재확정
  await gotoStep(page, 4);
  await page.locator("#roundConfirm").click(); await sleep(300);
  if (await page.locator("#roundConfirmDialog[open]").count()) await page.locator("#roundConfirmOk").click();
  await sleep(800);
  out.reconfirmed = await text(page, "#roundConfirmState");
  h.check(/2차 · 확정/.test(out.reconfirmed), "중요", "4단계", "확정 해제 → 재확정이 되지 않음", { actual: out.reconfirmed });
  // 6단계: 재계산 필요 → 바뀐 학생만 다시 계산
  await S6.open6(page);
  await page.locator("#classSectionsRound").selectOption("2").catch(() => {});
  await S6.selectGroup(page, groupKey);
  const scr = await S6.readScreen(page);
  out.staleBefore = scr.stale;
  h.check(scr.stale, "중요", "6단계", "학생 선택을 바꾸고 재확정했는데 '입력 변경됨, 재계산 필요'가 없음", { actual: scr.badge });
  const r = await S6.solve(page, "#classSectionsPartial");
  out.solve = { ms: r.ms, feasible: r.feasible, note: r.note, summary: r.summary.slice(0, 200) };
  const files = await S6.exportGroup(page, path.join(OUT, "downloads", "step6"), `${groupKey.replace(/[:\s]/g, "_")}-partial`);
  const after = S6.modelFromExports(files, { semester }).sections;
  const roomOf = (sections) => { const m = new Map(); for (const x of sections) for (const st of x.students) m.set(`${st}|${x.subject}`, x.room); return m; };
  const b = roomOf(before), a = roomOf(after);
  const changedKeys = new Set(out.changed.map((c) => c.student));
  const moved = [...b].filter(([k, room]) => !changedKeys.has(k.split("|")[0]) && a.has(k) && a.get(k) !== room).map(([k, room]) => `${k}: ${room}→${a.get(k)}`);
  const changedOk = out.changed.filter((c) => c.message.includes("변경")).every((c) => a.has(`${c.student}|${c.to}`) && !a.has(`${c.student}|${c.from}`));
  out.moved = moved.length; out.movedSample = moved.slice(0, 8); out.changedOk = changedOk;
  h.check(!moved.length, "중요", "6단계", `'바뀐 학생만 다시 계산' 뒤 바뀌지 않은 학생 ${moved.length}명의 분반이 달라짐`, { actual: moved.slice(0, 8) });
  h.check(changedOk, "중요", "6단계", "'바뀐 학생만 다시 계산' 뒤 바뀐 학생의 새 과목이 배정되지 않음", { actual: out.changed });
  return out;
}

// ---- 6단계(분반·시간표 편성) · 예전 자리 ----
// 6단계가 통합 브랜치에 들어오면 STEP6 단추 이름·패널·읽기(adapter)만 맞추면 된다. 지금은 '보류' 자리면 건너뛴다.
const STEP6 = {
  nav: '[data-workflow-step="6"]',
  panel: "#workflowStep6Panel",
  run: [/자동 편성|편성 실행|분반 편성|블록 생성/],   // 누를 단추 이름 후보(들어온 뒤 맞춤)
  exportNeis: /나이스.*(내보내기|엑셀|저장)/,
};
async function finalSelections(h, report) {
  // 학년별 마지막 확정 차수(2차 있으면 2차) 서버 자료 → 학생키(현학년-반-번호) → [{subject, semester}]
  const semesterOf = new Map(GROUPS.flatMap((g) => g.members.map((m) => [m[2], g.field.slice(-1)])));
  const map = new Map();
  for (const grade of ["1", "2"]) {
    const id = report.data.retakeEvents?.[grade] || report.data.events?.[grade];
    if (!id) continue;
    for (const row of await serverSelections(h, id)) {
      if (!row.submitted_at) continue;
      map.set(`${grade}-${Number(row.classroom)}-${Number(row.number)}`, row.selections.map((raw) => ({ subject: Expected.bare(raw), semester: Expected.tagOf(raw) || semesterOf.get(Expected.bare(raw)) || "" })));
    }
  }
  return map;
}
async function stepTimetable({ page, h, report }) {
  return h.step("6. 분반·시간표 편성(블록·충돌·정원·교사 불가·나이스 내보내기)", async () => {
    const nav = page.locator(STEP6.nav).first();
    const label = (await nav.count()) ? String(await nav.textContent()).trim() : "";
    if (!label || /보류/.test(label)) return { skipped: true, reason: `6단계 미연결(메뉴: ${label || "없음"})` };
    report.timings.step6Enter = await gotoStep(page, 6);
    const panelText = await text(page, STEP6.panel);
    if (/준비 중/.test(panelText)) return { skipped: true, reason: "6단계 화면이 '준비 중'" };
    const result = { label };
    for (const name of STEP6.run) {
      const button = page.locator(STEP6.panel).getByRole("button", { name }).first();
      if (await button.count()) { const t0 = Date.now(); await button.click(); await page.waitForLoadState("networkidle").catch(() => {}); await sleep(1500); report.timings.step6Run = Date.now() - t0; break; }
    }
    await h.screenshot(page, "step6");
    result.panel = (await text(page, STEP6.panel)).slice(0, 3000);
    const selections = await finalSelections(h, report);
    // 화면 모델 읽기: 6단계가 들어오면 여기서 sections·unavailable을 화면/엑셀에서 읽는다(adapter).
    const model = typeof globalThis.__step6Adapter === "function" ? await globalThis.__step6Adapter(page) : null;
    if (model) {
      const check = Timetable.checkTimetable({ ...model, selections });
      result.check = check;
      const p = check.problems;
      h.check(!p.unassigned.length, "중요", "6단계", `미배정 ${p.unassigned.length}건(설명 없음)`, { actual: p.unassigned.slice(0, 10) });
      h.check(!p.blockConflict.length, "치명", "6단계", `학생 블록 충돌 ${p.blockConflict.length}건`, { actual: p.blockConflict.slice(0, 10) });
      h.check(!p.overCapacity.length, "중요", "6단계", `분반 정원 초과 ${p.overCapacity.length}건`, { actual: p.overCapacity.slice(0, 10) });
      h.check(!p.teacherUnavailable.length && !p.teacherConflict.length, "중요", "6단계", `교사 불가 시간·중복 배정 ${p.teacherUnavailable.length + p.teacherConflict.length}건`, { actual: [...p.teacherUnavailable, ...p.teacherConflict].slice(0, 10) });
      h.check(!p.duplicate.length, "중요", "6단계", `한 학생이 같은 과목 분반 여러 개 ${p.duplicate.length}건`, { actual: p.duplicate.slice(0, 10) });
    } else {
      result.note = "6단계 화면 읽기(adapter) 미작성 — 단추·표 구조가 들어오면 맞춤";
    }
    const exportButton = page.locator(STEP6.panel).getByRole("button", { name: STEP6.exportNeis }).first();
    if (await exportButton.count()) {
      const download = page.waitForEvent("download");
      await exportButton.click();
      const file = await savedCopy(await (await download).path(), "step6-neis.xlsx");
      result.neisExport = await inspectXlsx(file);
      h.check(result.neisExport.ok, "중요", "6단계", "나이스 내보내기 파일이 열리지 않음", { actual: result.neisExport.error });
      if (result.neisExport.ok) {
        const { execFileSync } = require("node:child_process");
        const rows = JSON.parse(execFileSync("python3", ["-I", "-c", `import json,sys,openpyxl
ws=openpyxl.load_workbook(sys.argv[1]).worksheets[0]
print(json.dumps([[str(c.value) if c.value is not None else "" for c in r] for r in ws.iter_rows()], ensure_ascii=False))`, file], { encoding: "utf8" }));
        const neis = Timetable.checkNeisExport(rows, { selections });
        result.neisCheck = neis;
        h.check(!neis.error && !neis.missing.length, "중요", "6단계", "나이스 내보내기 열 구성이 수강학생 편성 형식과 다름", { expected: Timetable.NEIS_COLUMNS, actual: neis.error || neis.missing });
        h.check(!neis.duplicates?.length, "중요", "6단계", `나이스 내보내기: 한 학생·과목이 여러 줄 ${neis.duplicates?.length}건`, { actual: neis.duplicates?.slice(0, 10) });
        h.check(!neis.mismatchCount, "중요", "6단계", `나이스 내보내기 과목이 최종 수강신청과 다른 학생 ${neis.mismatchCount}명`, { actual: neis.mismatch?.slice(0, 5) });
      }
    } else result.neisExportNote = "나이스 내보내기 단추를 찾지 못함";
    return result;
  });
}

async function main() {
  const h = await startHarness({ outDir: OUT, seed: SEED, headless: !args.headed });
  const { report } = h;
  report.config = { seed: SEED, classes: CLASSES_BY, perClass: PER_BY, nextClasses: NEXT_CLASSES, concurrency: CONCURRENCY, year: YEAR };
  const page = await h.context.newPage();
  const dialogs = [];
  page.on("dialog", async (dialog) => { dialogs.push({ type: dialog.type(), message: dialog.message() }); await dialog.accept(dialog.type() === "prompt" ? dialog.defaultValue() : undefined); });
  const downloads = [];
  page.on("download", async (download) => {
    // 이 환경에서는 이름이 'download'로 오기도 한다 → 엑셀(zip)이면 .xlsx를 붙여 저장(openpyxl은 확장자를 본다).
    const index = downloads.push({ name: download.suggestedFilename(), file: "" }) - 1;
    let file = path.join(OUT, "downloads", `${index + 1}-${download.suggestedFilename()}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await download.saveAs(file).catch(() => {});
    try {
      const head = fs.readFileSync(file).subarray(0, 2).toString("latin1");
      if (!path.extname(file) && head === "PK") { fs.renameSync(file, `${file}.xlsx`); file = `${file}.xlsx`; }
      else if (!path.extname(file) && head.startsWith("{")) { fs.renameSync(file, `${file}.json`); file = `${file}.json`; }
    } catch { /* 저장 실패 */ }
    downloads[index].file = file;
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
      // 결과가 없을 때는 방식·안내 상자가 이미 펼쳐져 있다(펼쳐져 있으면 누르지 않음).
      if (!(await page.locator("#applicationModeWeb").isVisible())) await page.locator("#workflowStep2Panel summary").first().click();
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
      roster[grade] = Core.generateRoster({ grade, classes: CLASSES_BY[grade], perClass: PER_BY[grade] });
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
        // 명렬 업로드 뒤 그룹 탭으로 넘어가므로: 그룹명 칸 폭, 온라인 탭에서 '수강신청 생성' 단추가 보이는지
        await page.locator("#applicationGroupsTab").click(); await sleep(300);
        const nameWidths = await page.locator("#courseGroupEditor .course-group-name input").evaluateAll((els) => els.filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().width)));
        h.check(nameWidths.length && nameWidths.every((w) => w > 40), "중요", "2단계", `그룹명 칸이 너무 좁음(폭 ${Math.min(...nameWidths)}px ≤ 40px)`, { actual: nameWidths });
        await page.locator("#applicationOnlineTab").click();
        await sleep(300);
        const createVisible = await page.locator("#cloudCreateEvent").isVisible();
        const box = await page.locator("#cloudCreateEvent").boundingBox();
        h.check(createVisible && box && box.width > 0, "중요", "2단계", "명렬 업로드 뒤 '수강신청 생성' 단추가 보이지 않음", { actual: { createVisible, box } });
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
        h.check(groups.length === expected.length && expected.every((e) => groups.some((g) => Number(g.count) === e.pick && g.semester === e.semester && e.courses.every((c) => g.courses.map(Expected.bare).includes(c)))),
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
        // 마지막 반은 하네스가 학생 화면으로 직접 신청한다(위계 위반·국수영 초과 5%, 정상, 미제출).
        await bot.locator("#botScope").selectOption("class");
        await bot.locator("#botScopeClasses").fill(Array.from({ length: CLASSES_BY[grade] - 1 }, (_, i) => i + 1).join(","));
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
      await stepStudentScreen({ page, h, report, roster, downloads }, grade);
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
        await page.locator("#appConfirmDialog[open] #appConfirmOk").click({ timeout: 3000 }).catch(() => {});
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
    if (args.explore) { await require(path.resolve(args.explore))({ page, h, text, sleep, gotoStep, upload, waitText, report, OUT, roster, selectGradeTab }); return; }
    await stepPrerequisites({ page, h, report, roster });
    const ctx = { page, h, report, roster, dialogs, downloads };
    await stepCertificates(ctx, 1);
    if (STOP_AFTER === "3") return;
    await stepAggregate(ctx, 1);
    await stepRetake(ctx);
    await stepAggregate(ctx, 2);
    await stepCertificates(ctx, 2);
    if (STOP_AFTER === "4") return;
    await stepHours(ctx);
    await stepClassSections(ctx);
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
