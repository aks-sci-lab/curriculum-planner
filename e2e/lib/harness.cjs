"use strict";
// 하네스 공통: 브라우저·모의 서버·정적 서버 시작, 기록(단계·문제·콘솔), 스크린샷, 시간 측정.
const fs = require("node:fs");
const path = require("node:path");
// Playwright는 이 환경에 전역 설치돼 있다(npm root -g). 저장소 node_modules에 없으면 전역에서 찾는다.
function loadPlaywright() {
  try { return require("playwright"); } catch {
    const globalRoot = require("node:child_process").execSync("npm root -g", { encoding: "utf8" }).trim();
    return require(path.join(globalRoot, "playwright"));
  }
}
const { chromium } = loadPlaywright();
const { createMockSupabase, attachMockSupabase } = require("./mock-supabase.cjs");
const { startStaticServer } = require("./static-server.cjs");

const ROOT = path.join(__dirname, "..", "..");

async function startHarness({ outDir, seed, headless = true, hardened = true }) {
  fs.mkdirSync(outDir, { recursive: true });
  // 같은 폴더로 다시 돌릴 때 예전 스크린샷·내려받기가 섞이지 않게 지운다.
  for (const name of fs.readdirSync(outDir)) if (/\.png$|^report\.json$/.test(name)) fs.rmSync(path.join(outDir, name));
  fs.rmSync(path.join(outDir, "downloads"), { recursive: true, force: true });
  const mock = await createMockSupabase({ hardened });
  const { server, url } = await startStaticServer(ROOT);
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "ko-KR", timezoneId: "Asia/Seoul", acceptDownloads: true });
  const net = await attachMockSupabase(context, mock, { baseUrl: url });
  // 테스트봇의 난수 시드를 고정한다(봇은 Date.now()로 시드를 정하므로 하네스가 createRng를 감싼다: 앱 코드는 그대로).
  await context.addInitScript((botSeed) => {
    let value;
    let serial = 0;
    Object.defineProperty(window, "TestBotCore", {
      configurable: true,
      get() { return value; },
      set(core) {
        if (core && typeof core.createRng === "function" && !core.__seeded) {
          const original = core.createRng;
          core.createRng = (_ignored) => original(botSeed * 1000 + (++serial));
          core.__seeded = true;
        }
        value = core;
      },
    });
  }, seed);
  const report = { seed, startedAt: new Date().toISOString(), steps: [], issues: [], console: [], timings: {}, data: {} };
  const watch = (page, label) => {
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) report.console.push({ page: label, type: message.type(), text: message.text().slice(0, 500), at: Date.now() });
    });
    page.on("pageerror", (error) => report.console.push({ page: label, type: "pageerror", text: String(error?.message || error).slice(0, 800), at: Date.now() }));
  };
  context.on("page", (page) => watch(page, page.url().includes("test-bot") ? "bot" : "page"));
  let shot = 0;
  const h = {
    mock, url, browser, context, report, outDir, net,
    async screenshot(page, name) {
      const file = path.join(outDir, `${String(++shot).padStart(2, "0")}-${name}.png`);
      await page.screenshot({ path: file, fullPage: false }).catch(() => {});
      return file;
    },
    issue(severity, area, title, detail = {}) {
      report.issues.push({ no: report.issues.length + 1, severity, area, title, ...detail });
      console.log(`  ! [${severity}] ${area} · ${title}`);
    },
    check(condition, severity, area, title, detail) {
      if (!condition) h.issue(severity, area, title, detail);
      return !!condition;
    },
    async step(name, fn) {
      const started = Date.now();
      const record = { name, status: "running" };
      report.steps.push(record);
      console.log(`▶ ${name}`);
      const issuesBefore = report.issues.length;
      try {
        record.result = await fn();
        record.status = report.issues.slice(issuesBefore).some((item) => item.severity !== "경미") ? "fail" : "pass";
      } catch (error) {
        record.status = "error";
        record.error = String(error?.stack || error?.message || error).slice(0, 2000);
        h.issue("치명", name, `단계 실행 중 예외: ${String(error?.message || error).split("\n")[0]}`);
      }
      record.ms = Date.now() - started;
      console.log(`  ${record.status} (${(record.ms / 1000).toFixed(1)}s)`);
      return record.result;
    },
    async close() {
      report.finishedAt = new Date().toISOString();
      report.mockLog = { total: mock.log.length, unhandled: mock.log.filter((e) => e.unhandled), errors: mock.log.filter((e) => e.status >= 400).slice(0, 50),
        byRpc: mock.log.reduce((acc, e) => { const k = e.rpc || e.path; acc[k] = (acc[k] || 0) + 1; return acc; }, {}) };
      report.blockedRequests = net.blocked;
      fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
      await browser.close().catch(() => {});
      server.close();
    },
  };
  return h;
}

// 화면에서 보이는 열린 대화상자 글자
async function openDialogs(page) {
  return page.evaluate(() => [...document.querySelectorAll("dialog[open]")].map((d) => ({ id: d.id, text: d.innerText.slice(0, 1500) })));
}

module.exports = { startHarness, openDialogs, ROOT };
