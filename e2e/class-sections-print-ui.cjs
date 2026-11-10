// 6단계 출력물 화면 확인(사용자처럼 클릭): 하네스 전체 실행이 남긴 백업(가상 학생)을 복원 → 6단계 교실 배정·직접 바꾸기·겹침 경고 →
// 교사·시간 설정의 교실 칸(특별실 이름) → 출석부(그룹·교사별 zip·전체 zip)·학생 시간표(미리 보기·인쇄·엑셀)·블록표 교실 열.
// 사용: node e2e/run.cjs --seed 10 --out /tmp/e2e  →  node e2e/class-sections-print-ui.cjs /tmp/cs-print /tmp/e2e/downloads/workspace-backup.json.gz
// 내려받은 파일은 openpyxl로 직접 읽어 확인한다(앱 함수 미사용). 결과는 OUT/report.json, 문제는 problems 목록.
const path = require("path"), fs = require("fs");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const { chromium } = require(path.join(globalRoot, "playwright"));
const { startStaticServer } = require(path.join(ROOT, "e2e/lib/static-server.cjs"));
const { readXlsxAll } = require(path.join(ROOT, "e2e/lib/step6.cjs"));
const OUT = process.argv[2]; const BACKUP = process.argv[3];
if (!OUT || !BACKUP) { console.error("사용: node e2e/class-sections-print-ui.cjs <출력 폴더> <백업 .json.gz>"); process.exit(2); }
fs.mkdirSync(path.join(OUT, "downloads"), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const report = { problems, checks: {} };
const check = (ok, message, detail) => { if (!ok) { problems.push({ message, detail }); console.log("  ✗", message, detail ? JSON.stringify(detail).slice(0, 300) : ""); } else console.log("  ✓", message); };

function unzipNames(file) {
  return JSON.parse(execFileSync("python3", ["-I", "-c", "import zipfile,sys,json; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist(), ensure_ascii=False))", file], { encoding: "utf8" }));
}
function unzipTo(file, dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("python3", ["-I", "-c", "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", file, dir]);
}
// 출석부 시트 읽기: 머리글 줄('순서') 아래가 학생.
function attendanceInfo(sheet) {
  const headerIndex = sheet.rows.findIndex((row) => row[0] === "순서");
  const header = sheet.rows[headerIndex] || [];
  return { title: sheet.rows[0]?.[0] || "", times: sheet.rows[1]?.[2] || "", room: sheet.rows[2]?.[2] || "", teacher: sheet.rows[3]?.[2] || "",
    header, dateCols: header.filter((v) => /^월\s+일$/.test(v)).length, students: sheet.rows.slice(headerIndex + 1).filter((row) => row.some((v) => v !== "")).map((row) => row.slice(0, 5)) };
}

(async () => {
  const { server, url } = await startStaticServer(ROOT);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: "ko-KR", acceptDownloads: true, deviceScaleFactor: 2 });
  await context.route(/supabase\.co|googleapis|gstatic/, (route) => route.abort());
  // 내려받기 이름은 앱이 붙인 a.download로 확인(Playwright는 blob 이름을 'download'로만 줌). 인쇄 창은 열지 않고 횟수만 센다.
  await context.addInitScript(() => {
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { window.__lastDownloadName = this.download; return click.call(this); };
    window.__prints = 0;
    window.print = () => { window.__prints += 1; };
  });
  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => { if (["error"].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => d.type() === "prompt" ? d.accept("초기화") : d.accept());
  const shot = async (name, locator) => (locator ? locator.screenshot({ path: path.join(OUT, name) }) : page.screenshot({ path: path.join(OUT, name), fullPage: true }));
  const save = async (trigger, name) => {
    const dl = page.waitForEvent("download", { timeout: 60000 });
    await trigger();
    const file = path.join(OUT, "downloads", name);
    await (await dl).saveAs(file);
    return { file, appName: await page.evaluate(() => window.__lastDownloadName || "") };
  };
  await page.goto(url); await page.waitForLoadState("networkidle"); await sleep(1000);
  await page.locator("#workspaceDataMenu summary").click();
  const nav = page.waitForEvent("load", { timeout: 30000 }).catch(() => null);
  await page.locator("#restoreWorkspaceBackup").setInputFiles(BACKUP);
  await nav; await sleep(2500);
  await page.getByRole("button", { name: /6\. 분반 편성/ }).click();
  await page.locator("#workflowStep8Panel").waitFor({ state: "visible" });
  await sleep(800);

  // ① 그룹마다 교실 배정: 카드마다 교실, 블록 안 겹침 없음, 교실 배정 오류 0
  console.log("▶ 교실 배정(그룹마다)");
  const groupKeys = await page.locator("[data-cs-group]").evaluateAll((els) => els.map((el) => el.dataset.csGroup));
  report.checks.groups = [];
  for (const key of groupKeys) {
    await page.locator(`[data-cs-group="${key}"]`).click(); await sleep(400);
    if (!(await page.locator("li.cs-section").count())) { report.checks.groups.push({ key, sections: 0 }); continue; }
    const blocks = await page.locator(".cs-blocks .cs-block").evaluateAll((els) => els.map((block) => ({
      letter: block.querySelector("h5")?.childNodes[0]?.textContent.trim(),
      rooms: [...block.querySelectorAll("li.cs-section")].map((li) => ({ neis: li.dataset.room, room: li.querySelector(".cs-room")?.dataset.roomId || "", label: li.querySelector(".cs-room select")?.options[0]?.textContent || "" })) })));
    const missing = blocks.flatMap((block) => block.rooms.filter((item) => !item.room));
    const doubled = blocks.filter((block) => new Set(block.rooms.map((item) => item.room)).size !== block.rooms.length).map((block) => block.letter);
    const errors = Number(await page.locator("#classSectionsRoomSummary").getAttribute("data-errors"));
    report.checks.groups.push({ key, sections: blocks.reduce((n, block) => n + block.rooms.length, 0), missing: missing.length, doubled, errors, summary: (await page.locator("#classSectionsRoomSummary p").innerText()).replace(/\s+/g, " ") });
    check(!missing.length && !doubled.length && errors === 0, `${key}: 분반마다 교실, 블록 안 겹침 없음, 교실 오류 0`, { missing: missing.length, doubled, errors });
  }
  await page.locator(`[data-cs-group="${groupKeys[0]}"]`).click(); await sleep(400);
  await shot("01-rooms.png", page.locator('section[aria-label="편성 결과"]'));

  // ② 직접 바꾸기: 첫 블록 첫 카드를 둘째 카드 교실로 → 겹침 경고 → 되돌리기
  console.log("▶ 교실 직접 바꾸기·겹침");
  const firstBlock = page.locator(".cs-blocks .cs-block").first();
  const cards = firstBlock.locator("li.cs-section");
  if (await cards.count() >= 2) {
    const otherRoom = await cards.nth(1).locator(".cs-room").getAttribute("data-room-id");
    const neis0 = await cards.nth(0).getAttribute("data-room");
    const neis1 = await cards.nth(1).getAttribute("data-room");
    await page.getByLabel(`${neis0} 교실`, { exact: true }).selectOption(otherRoom); await sleep(600);
    const movedStatus = await page.locator("#classSectionsStatus").innerText();
    check(new RegExp(`함께 옮긴 분반: ${neis1} `).test(movedStatus) && (await cards.nth(1).locator(".cs-room").getAttribute("data-room-id")) !== otherRoom,
      "다른 분반이 쓰던 교실을 고르면 그 분반은 자동으로 다른 교실로(상태에 '함께 옮긴 분반')", movedStatus);
    // 두 분반을 같은 교실로 직접 고정하면 겹침
    await page.getByLabel(`${neis1} 교실`, { exact: true }).selectOption(otherRoom); await sleep(600);
    const status = await page.locator("#classSectionsStatus").innerText();
    const errorsShown = await page.locator("#classSectionsRoomErrors li").count();
    check(/교실 겹침/.test(status) && errorsShown > 0, "같은 블록 같은 교실을 고르면 '교실 겹침' 상태·오류 목록", { status, errorsShown });
    check(await page.locator(".cs-room.is-clash").count() >= 2, "겹친 두 카드가 빨간 표시");
    await shot("02-room-clash.png", page.locator('section[aria-label="편성 결과"]'));
    await page.getByRole("button", { name: "교실 자동으로 되돌리기" }).click(); await sleep(500);
    check(await page.locator("#classSectionsRoomErrors").count() === 0, "자동으로 되돌리면 오류 없음");
    // 겹치지 않는 교실로 바꾸면 저장되고 새로고침 뒤에도 남는다.
    const free = await cards.nth(0).locator(".cs-room select").evaluate((select, used) => [...select.options].map((o) => o.value).find((v) => v && !used.includes(v)) || "",
      await firstBlock.locator(".cs-room").evaluateAll((els) => els.map((el) => el.dataset.roomId)));
    if (free) {
      await page.getByLabel(`${neis0} 교실`, { exact: true }).selectOption(free); await sleep(800);
      await page.reload(); await page.waitForLoadState("networkidle"); await sleep(2000);
      if (!(await page.locator("#workflowStep8Panel").isVisible())) { await page.getByRole("button", { name: /6\. 분반 편성/ }).click(); await sleep(800); }
      await page.locator(`[data-cs-group="${groupKeys[0]}"]`).click(); await sleep(400);
      const kept = await page.getByLabel(`${neis0} 교실`, { exact: true }).inputValue();
      check(kept === free, "직접 고른 교실이 새로고침 뒤에도 남음", { kept, free });
      await page.getByRole("button", { name: "교실 자동으로 되돌리기" }).click(); await sleep(400);
    }
  }

  // ③ 교사·시간 설정: 교실 칸, 특별실(과학실=2, 이름 '물리실, 화학실') → 과목 특별실 지정 → 특별실 배정
  console.log("▶ 교실 설정·특별실");
  await page.getByRole("button", { name: "교사·시간 설정" }).click(); await sleep(300);
  check(await page.locator("#classSectionsRoomSettings").count() === 1, "교사·시간 설정에 '교실' 칸");
  const classroomRows = await page.locator("#classSectionsRoomSettings tbody tr").allInnerTexts();
  report.checks.classroomRows = classroomRows;
  await page.getByLabel("특별실 수(이름=수)").fill("과학실=2"); await page.getByLabel("특별실 수(이름=수)").press("Tab"); await sleep(400);
  await page.getByLabel("과학실 이름(쉼표로 구분)").fill("물리실, 화학실"); await page.getByLabel("과학실 이름(쉼표로 구분)").press("Tab"); await sleep(400);
  check((await page.getByLabel("특별실 수(이름=수)").inputValue()).includes("과학실=2"), "특별실 이름 2개 = 특별실 수 2");
  await shot("03-room-settings.png", page.locator("#classSectionsRoomSettings"));
  await page.getByRole("button", { name: "닫기" }).first().click(); await sleep(400);
  // 과학 과목 하나에 특별실 지정(입력이 바뀌므로 '입력 변경됨'이 뜨는 것이 맞음)
  const scienceCourse = await page.locator("[data-cs-room]").evaluateAll((els) => els.map((el) => el.dataset.csRoom).find((name) => /물리|화학|생명|지구|과학/.test(name)) || els[0]?.dataset.csRoom);
  if (scienceCourse) {
    await page.getByLabel(`${scienceCourse} 특별실`).fill("과학실"); await page.getByLabel(`${scienceCourse} 특별실`).press("Tab"); await sleep(600);
    const rooms = await page.locator("li.cs-section").evaluateAll((els, course) => els.filter((li) => li.dataset.course === course.replace(/\s*\([12]학기\)$/, "")).map((li) => li.querySelector(".cs-room")?.dataset.roomId || ""), scienceCourse);
    report.checks.specialRooms = { course: scienceCourse, rooms };
    const perBlock = await page.locator(".cs-blocks .cs-block").evaluateAll((els, course) => els.map((block) => [...block.querySelectorAll("li.cs-section")].filter((li) => li.dataset.course === course).length), scienceCourse);
    const fits = perBlock.every((n) => n <= 2);
    check(!fits || rooms.every((room) => /^(물리실|화학실)$/.test(room)), `${scienceCourse} 분반이 과학실(물리실·화학실)에 배정(블록당 2개 이하일 때)`, { rooms, perBlock });
    check(Number(await page.locator("#classSectionsRoomSummary").getAttribute("data-errors")) === 0, "특별실 지정 뒤 교실 오류 0(같은 시간 다른 학년 겹침 없음)",
      await page.locator("#classSectionsRoomSummary").innerText());
  }

  // ④ 블록표 엑셀 교실 열
  console.log("▶ 블록표 엑셀");
  const blocksFile = await save(() => page.getByRole("button", { name: "블록표 엑셀" }).first().click(), "blocks.xlsx");
  const blockSheet = readXlsxAll(blocksFile.file)[0];
  check(blockSheet.rows[1]?.[7] === "교실", "블록표 머리글 끝 '교실'", blockSheet.rows[1]);
  check(blockSheet.rows.slice(2).filter((row) => /블록$/.test(row[0] || "")).every((row) => row[7]), "블록표 모든 분반 행에 교실");

  // ⑤ 출석부(이 그룹): 분반마다 시트, 위 3줄, 날짜 17칸, 인원 = 카드 인원
  console.log("▶ 출석부");
  const cardInfo = await page.locator("li.cs-section").evaluateAll((els) => els.map((li) => ({ neis: li.dataset.room, size: Number(li.dataset.size), course: li.dataset.course, room: li.querySelector(".cs-room select")?.selectedOptions[0]?.textContent.replace(/^자동\((.*)\)$/, "$1") })));
  const att = await save(() => page.getByRole("button", { name: "출석부 엑셀(이 그룹)" }).click(), "attendance-group.xlsx");
  report.checks.attendanceName = att.appName;
  const attSheets = readXlsxAll(att.file);
  check(attSheets.length === cardInfo.length, `출석부 시트 수 = 분반 수(${cardInfo.length})`, { sheets: attSheets.length });
  for (const sheet of attSheets) {
    const info = attendanceInfo(sheet);
    const card = cardInfo.find((item) => item.neis === sheet.name);
    if (!card) { check(false, `출석부 시트 '${sheet.name}'에 맞는 분반 카드`); continue; }
    const ok = info.title === `${card.course}(${card.neis}) 출석부` && info.dateCols === 17 && info.students.length === card.size && info.room === card.room && /블록/.test(info.times) && info.header.at(-1) === "비고";
    if (!ok) check(false, `출석부 '${sheet.name}' 구조·인원`, { title: info.title, dateCols: info.dateCols, students: info.students.length, size: card.size, room: info.room, cardRoom: card.room, times: info.times });
  }
  check(true, `출석부 ${attSheets.length}개 시트 구조·인원 확인(문제는 위에)`);
  report.checks.attendanceSample = attendanceInfo(attSheets[0]);
  // 날짜 칸 수 설정
  await page.getByLabel("출석부 날짜 칸 수").fill("12"); await page.getByLabel("출석부 날짜 칸 수").press("Tab"); await sleep(500);
  const att12 = readXlsxAll((await save(() => page.getByRole("button", { name: "출석부 엑셀(이 그룹)" }).click(), "attendance-12.xlsx")).file);
  check(attendanceInfo(att12[0]).dateCols === 12, "날짜 칸 12로 바꾸면 12칸");
  await page.getByLabel("출석부 날짜 칸 수").fill("17"); await page.getByLabel("출석부 날짜 칸 수").press("Tab"); await sleep(400);
  // 교사별 zip·전체 zip
  const teacherZip = await save(() => page.getByRole("button", { name: "출석부 교사별 zip" }).click(), "attendance-teacher.zip");
  const teacherFiles = unzipNames(teacherZip.file);
  report.checks.teacherZip = { name: teacherZip.appName, files: teacherFiles.length, sample: teacherFiles.slice(0, 5) };
  check(teacherFiles.length > 0 && teacherFiles.every((name) => /^\d{4}_[12]학기_출석부_.+\.xlsx$/.test(name)), "교사별 zip: 교사마다 xlsx", report.checks.teacherZip);
  const allZip = await save(() => page.getByRole("button", { name: "출석부 전체 zip" }).click(), "attendance-all.zip");
  const allFiles = unzipNames(allZip.file);
  report.checks.allZip = { name: allZip.appName, files: allFiles.length, sample: allFiles.slice(0, 5) };
  check(allFiles.length >= cardInfo.length && allFiles.every((name) => /^\d{4}_[12]학기_.+\(.+\)_.+_.+\.xlsx$/.test(name)), "전체 zip: 분반마다 '2027_1학기_과목(강의실)_교실_교사.xlsx'", report.checks.allZip);
  // zip 안 파일도 열리는지(첫 파일)
  unzipTo(allZip.file, path.join(OUT, "downloads", "all"));
  const firstInner = readXlsxAll(path.join(OUT, "downloads", "all", allFiles[0]));
  check(/출석부$/.test(firstInner[0].rows[0][0]), "전체 zip 안 엑셀이 열리고 제목이 '… 출석부'");
  // 교사별 분반 수 합 = 전체 분반 수
  unzipTo(teacherZip.file, path.join(OUT, "downloads", "teacher"));
  const teacherSheets = teacherFiles.reduce((n, name) => n + readXlsxAll(path.join(OUT, "downloads", "teacher", name)).length, 0);
  check(teacherSheets === allFiles.length, `교사별 시트 합(${teacherSheets}) = 전체 분반 수(${allFiles.length})`);

  // ⑥ 학생 시간표: 학생 찾기 → 미리 보기, 반별 인쇄, 엑셀
  console.log("▶ 학생 시간표");
  const grade = (await page.locator(`[data-cs-group="${groupKeys[0]}"]`).innerText()).match(/현(\d)/)?.[1] || "1";
  await page.getByLabel("학생 찾기(현학년-반-번호)").fill(`${grade}-1-1`); await page.getByLabel("학생 찾기(현학년-반-번호)").press("Enter"); await sleep(600);
  const preview = page.locator("#classSectionsTimetablePreview");
  check(await preview.count() === 1, `학생 찾기 '${grade}-1-1' → 시간표 미리 보기`);
  if (await preview.count()) {
    const text = await preview.innerText();
    report.checks.preview = text.slice(0, 400);
    check(new RegExp(`학년도 [12]학기 · 현 ${grade}학년 → ${Number(grade) + 1}학년`).test(text), "미리 보기 제목에 '현 N학년 → N+1학년'", text.slice(0, 120));
    check((await preview.locator("td[data-kind=move]").count()) > 0 || /블록:/.test(text), "이동 수업 칸(또는 목록)이 있음");
    await shot("04-timetable-preview.png", preview);
  }
  await page.getByLabel("학생 시간표 인쇄할 반(현 반)").selectOption("1"); await sleep(200);
  await page.getByLabel("한 장에 학생 수").selectOption("2"); await sleep(500);
  await page.getByRole("button", { name: "학생 시간표 인쇄" }).click(); await sleep(800);
  const printed = await page.evaluate(() => ({ prints: window.__prints, pages: document.querySelectorAll("#printBatch .cs-tt-page").length, students: document.querySelectorAll("#printBatch .cs-tt").length,
    keys: [...document.querySelectorAll("#printBatch .cs-tt")].map((el) => el.dataset.student) }));
  report.checks.print = printed;
  check(printed.prints === 1 && printed.students > 0 && printed.pages === Math.ceil(printed.students / 2) && printed.keys.every((key) => key.startsWith(`${grade}-1-`)), "1반 인쇄: 한 장에 2명, 1반 학생만", printed);
  // 인쇄 모양: A4 PDF로 만들어 쪽 수 = 장 수(한 장에 2명)인지 본다.
  const pdf = await page.pdf({ path: path.join(OUT, "05-timetable-print.pdf"), format: "A4", preferCSSPageSize: true });
  const pdfPages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  report.checks.printPdfPages = pdfPages;
  check(pdfPages === printed.pages, `인쇄 PDF 쪽 수(${pdfPages}) = 장 수(${printed.pages})`);
  await sleep(400);
  const ttFile = await save(() => page.getByRole("button", { name: "학생 시간표 엑셀" }).click(), "timetable.xlsx");
  const ttSheets = readXlsxAll(ttFile.file);
  report.checks.timetableExcel = { name: ttFile.appName, sheets: ttSheets.map((sheet) => sheet.name) };
  check(ttSheets.length === 1 && ttSheets[0].rows.filter((row) => /이동수업 시간표$/.test(row[0] || "")).length === printed.students, "시간표 엑셀: 반 시트 1개, 학생 수 = 인쇄 학생 수", report.checks.timetableExcel);
  await shot("06-print-buttons.png", page.locator("section.cs-print"));

  report.logs = logs;
  check(!logs.length, "콘솔 오류 없음", logs.slice(0, 5));
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(problems.length ? `문제 ${problems.length}건` : "모두 통과");
  await browser.close(); server.close();
  process.exit(problems.length ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(1); });
