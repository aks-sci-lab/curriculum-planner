const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("application branding uses the same name across shipped surfaces", () => {
  assert.match(html, /<title>교육과정 관리<\/title>/);
  assert.match(html, /id="teacherHeader">\s*<strong>교육과정 관리<\/strong>/);
  assert.doesNotMatch(html, /id="teacherLoginGate"/, "local work must not sit behind a login gate");
  assert.match(html, /class="brand">[^\n]*<span>교육과정 관리<\/span>/);
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(readme, /^# 교육과정 관리\r?\n/);
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.ok(app.includes("// 이 코드는 '교육과정 관리'에서 생성했습니다."));
});

test("all shipped scripts, styles and local download links exist", () => {
  const references = [...html.matchAll(/<(?:script|link|a)\b[^>]*\b(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((value) => !/^(?:#|[a-z]+:|\/\/)/i.test(value));
  assert.ok(references.length > 0);
  for (const reference of references) {
    const filename = decodeURIComponent(reference.split(/[?#]/)[0]).replaceAll("/", path.sep);
    const file = path.resolve(root, filename);
    assert.ok(file.startsWith(root + path.sep), `Local reference escapes project: ${reference}`);
    assert.ok(fs.statSync(file).isFile(), `Missing local resource: ${reference}`);
  }
});

test("static UI bindings refer to unique shipped or dynamically generated IDs", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "HTML IDs must be unique");
  const filenames = ["app.js", "course-groups.js", "supabase-client.js", "result-import.js", "round-status.js",
    "curriculum-versions.js", "hours-stats.js", "curriculum-subject-actions.js", "curriculum-choice-blocks.js", "curriculum-data.js", "curriculum-data-view.js",
    "curriculum-subject-list.js", "curriculum-annual.js", "workspace-file.js", "app-version.js", "course-checks.js", "curriculum-compliance.js",
    "workspace-store.js", "view-keep.js", "workspace-header.js", "neis-enrollment.js", "curriculum-reconvert.js", "curriculum-office-format.js", "course-semester-picks.js", "round-copy.js",
    "curriculum-data-export.js", "curriculum-workbook.js", "class-sections.js", "class-sections-view.js", "class-sections-edit.js", "class-sections-print.js", "class-sections-teachers.js"];
  const sources = filenames.map((file) => fs.readFileSync(path.join(root, file), "utf8"));
  const declared = new Set([...ids, ...sources.flatMap((source) =>
    [...source.matchAll(/\bid="([^"$]+)"/g)].map((match) => match[1]))]);
  for (const [index, source] of sources.entries()) {
    for (const match of source.matchAll(/(?:\$\("#([^"\s]+)"\)|getElementById\("([^"\s]+)"\))/g)) {
      const id = match[1] || match[2];
      assert.ok(declared.has(id), `${filenames[index]} binds a missing control: ${id}`);
    }
  }
});

test("index.html loads every app script once, the shared helpers before app.js, with one cache version", () => {
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"?]+)(?:\?v=([^"]+))?"/g)].map((match) => ({ file: match[1], version: match[2] || "" }));
  const files = scripts.map((item) => item.file);
  assert.equal(new Set(files).size, files.length, "each script once");
  const at = (file) => files.indexOf(file);
  for (const file of ["view-keep.js", "workspace-store.js", "neis-enrollment.js", "workspace-header.js"]) assert.ok(at(file) >= 0, `${file} is loaded`);
  // 순수 모듈·공통 도우미는 app.js보다 먼저, 나이스 파서는 course-checks.js보다 먼저.
  for (const file of ["view-keep.js", "workspace-store.js", "course-checks.js", "curriculum-annual.js"]) assert.ok(at(file) < at("app.js"), `${file} before app.js`);
  assert.ok(at("neis-enrollment.js") < at("course-checks.js"), "neis-enrollment.js before course-checks.js");
  assert.ok(at("workspace-header.js") > at("app.js"), "workspace-header.js after app.js");
  // 6단계 분반 편성: 순수 계산은 app.js 앞, 화면 연결은 app.js·hours-stats.js 뒤.
  assert.ok(at("class-sections.js") >= 0 && at("class-sections.js") < at("app.js"), "class-sections.js before app.js");
  assert.ok(at("class-sections-view.js") > at("hours-stats.js"), "class-sections-view.js after hours-stats.js");
  assert.ok(at("class-sections-print.js") > at("class-sections-view.js"), "class-sections-print.js after class-sections-view.js");
  const versions = new Set(scripts.filter((item) => item.version).map((item) => item.version));
  assert.equal(versions.size, 1, `one cache version: ${[...versions].join(", ")}`);
  const testBot = fs.readFileSync(path.join(root, "test-bot.html"), "utf8");
  for (const match of testBot.matchAll(/\?v=([^"]+)"/g)) assert.ok(versions.has(match[1]), `test-bot.html uses the same cache version (${match[1]})`);
});
