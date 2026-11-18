"use strict";
// 내년도 전학년 편제표 클릭 확인: node e2e/annual-next-year-ui.cjs <폴더>
// 학년도 2026에서 2027(내년도 신입생)·2026(현 1학년)·2025(현 2학년) 입학생 편제표를 올리고
// '2027학년도 전학년 편제표' 카드의 '만들기'로 만든 표를 화면 글자로 확인한다. 새로고침 뒤에도 그 편제표를 보는지 확인.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { planWorkbook } = require("./lib/plan-fixture.cjs");

const OUT = path.resolve(process.argv[2] || "annual-next-year-out");
fs.mkdirSync(OUT, { recursive: true });
const failures = [];
const check = (ok, message, detail) => { if (!ok) failures.push({ message, detail }); console.log(`${ok ? "✓" : "✗"} ${message}`); };

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("file://" + path.resolve(__dirname, "..", "index.html"));
  await page.locator("#curriculumCohortUploads").waitFor({ state: "attached" });
  await page.waitForFunction(() => !document.body.inert && document.querySelector("[data-annual-build]"));
  const toggle = page.getByRole("button", { name: /학교·학년도·편제표 카드 펼치기/ });
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  for (const year of [2027, 2026, 2025]) {
    const file = path.join(OUT, `plan-${year}.xlsx`);
    fs.writeFileSync(file, planWorkbook(year).bytes);
    const label = `${year}학년도 신입생 3개년 편제표 업로드`;
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: label }).click();
    await (await chooser).setFiles(file);
    await page.locator("#curriculumCohortUploads").getByText(`plan-${year}.xlsx`).first().waitFor({ timeout: 30000 });
  }
  const card = page.locator(".curriculum-annual-card", { hasText: "2027학년도 전학년 편제표" });
  check(await card.count() === 1, "2027학년도(내년도) 전학년 편제표 카드가 있음");
  check(/만들 준비 완료/.test(await card.innerText()), "내년도 카드: 세 입학생 편제표가 있어 만들 준비 완료", await card.innerText());
  const current = page.locator(".curriculum-annual-card", { hasText: "2026학년도 전학년 편제표" });
  check(/3학년\(2024\) 편제표 필요/.test(await current.innerText()), "올해 카드: 2024 입학생 편제표가 없어 만들 수 없음", await current.innerText());
  await page.getByRole("button", { name: "2027학년도 전학년 편제표 만들기" }).click();
  await page.getByRole("button", { name: "2027학년도 전학년 편제표 보기" }).filter({ hasText: "보는 중" }).waitFor({ timeout: 30000 });
  const panel = await page.locator("#workflowStep1Panel").innerText();
  check(/2027학년도 전학년 교육과정 편제표/.test(panel), "표 제목: 2027학년도 전학년 교육과정 편제표");
  for (const header of ["1학년(2027)", "2학년(2026)", "3학년(2025)"]) check(panel.includes(header), `학년 머리글 ${header}`);
  check(/생성됨 · 원본과 일치/.test(await card.innerText()), "내년도 카드: 생성됨 · 원본과 일치");
  check(/2027학년도 전학년 편제표를 3개년 편제표에서 다시 만들었습니다/.test(await page.locator("body").innerText()), "상태 문구");
  await page.screenshot({ path: path.join(OUT, "annual-2027.png"), fullPage: false });
  for (const name of ["엑셀 내보내기", "교육청 양식으로 내보내기"]) {
    const names = [];
    await page.evaluate(() => { window.__downloads = []; const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (this.download) window.__downloads.push(this.download); return click.call(this); }; });
    const download = page.waitForEvent("download", { timeout: 20000 }).catch(() => null);
    await page.getByRole("button", { name, exact: true }).first().click();
    const file = await download;
    if (file) await file.saveAs(path.join(OUT, `${name}.xlsx`));
    names.push(...await page.evaluate(() => window.__downloads));
    check(names.some((fileName) => fileName.includes("2027")), `${name}: 2027학년도 파일`, names);
  }
  await page.waitForTimeout(1500);
  await page.reload();
  await page.waitForFunction(() => !document.body.inert && document.querySelector("[data-annual-build]"));
  const reloaded = await page.getByRole("button", { name: "2027학년도 전학년 편제표 보기" }).innerText();
  check(reloaded.includes("보는 중"), "새로고침 뒤에도 2027학년도 전학년 편제표를 봄", reloaded);
  check(/2027학년도 전학년 교육과정 편제표/.test(await page.locator("#workflowStep1Panel").innerText()), "새로고침 뒤 표 제목");
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ failures }, null, 2));
  await browser.close();
  console.log(failures.length ? `실패 ${failures.length}` : "모두 통과");
  process.exitCode = failures.length ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
