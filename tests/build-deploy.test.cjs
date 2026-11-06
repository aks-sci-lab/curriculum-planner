const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { buildDeploy, referencedFiles } = require("../scripts/build-deploy.js");

const root = path.join(__dirname, "..");

test("the deploy folder holds only what index.html loads plus version info", () => {
  const { version, files } = buildDeploy();
  const dist = path.join(root, "dist");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  for (const file of referencedFiles(html)) assert.ok(fs.existsSync(path.join(dist, file)), `${file} is deployed`);
  const all = fs.readdirSync(dist, { recursive: true, withFileTypes: false }).map(String);
  assert.ok(!all.some((name) => /^(tests|supabase|node_modules|scripts|src)[\\/]/.test(name) || name === "package.json"),
    "no tests, SQL or build sources are published");
  const spreadsheets = all.filter((name) => /\.xlsx$/i.test(name));
  assert.deepEqual(spreadsheets, ["선택과목 수강신청결과 예시.xlsx"], "only the sample linked from the page is published");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dist, "version.json"), "utf8")).version, version);
  assert.match(fs.readFileSync(path.join(root, "app-version.js"), "utf8"), new RegExp(`APP_VERSION = "${version}"`));
  assert.ok(files.includes("app.js") && files.includes("workspace-file.js") && files.includes("app-version.js"));
});
