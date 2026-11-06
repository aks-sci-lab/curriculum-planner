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
    "curriculum-subject-list.js", "curriculum-annual.js", "workspace-file.js", "app-version.js", "course-checks.js"];
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
