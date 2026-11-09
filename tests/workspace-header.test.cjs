const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("머리 줄: 경계선 손잡이(1단계 위쪽 접기와 같은 모양), 스크롤하면 얇은 띠, 직접 접은 상태 기억, 저장 상태 요소 id는 그대로", () => {
  const html = read("index.html");
  const start = html.indexOf('<section class="workspace-context"');
  const header = html.slice(start, html.indexOf("</section>", start));
  assert.match(header, /class="collapse-divider workspace-context-divider" id="workspaceContextDivider"/);
  assert.match(header, /<button class="collapse-handle" id="workspaceContextToggle" type="button" aria-expanded="true"/);
  for (const id of ["workspaceSaveStatus", "workspaceBackupStatus", "retryWorkspaceSave", "resumeWorkspaceSave", "workspaceRound", "openWorkspaceSettings", "workspaceDataMenu"]) {
    assert.match(header, new RegExp(`id="${id}"`), id);
  }
  assert.ok(html.indexOf('src="workspace-header.js') > html.indexOf('src="app.js'), "app.js 다음에 로드");
  const js = read("workspace-header.js");
  assert.match(js, /document\.addEventListener\("scroll", onScroll, \{ capture: true, passive: true \}\)/, "안쪽 스크롤(편제표 표)도 본다");
  assert.match(js, /localStorage\.setItem\(PREFERENCE_KEY/);
  assert.match(js, /catch \{ return false; \}/, "저장소를 못 써도 동작");
  assert.match(js, /header\.dataset\.saveState = state/);
  assert.doesNotMatch(js, /function updateWorkspaceSaveStatus/, "app.js 저장 상태 함수는 바꾸지 않는다");
  const css = read("src/legacy.css");
  assert.match(css, /\.workspace-context\[data-save-state="ok"\] #workspaceSaveStatus::before \{ content: "● 저장됨"/);
  assert.match(css, /#workspaceBackupStatus:not\(\.is-stale\) \{ display: none; \}/, "백업 시각은 오래됐을 때만");
  assert.match(css, /\.workspace-context\.is-compact \.workspace-settings-button::before \{ content: "⚙"/);
  assert.match(css, /\.workspace-context\.is-compact \.workspace-data-menu > summary::before \{ content: "☰"/);
});
