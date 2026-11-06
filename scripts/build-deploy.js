"use strict";
// 배포용 저장소에 올릴 파일만 dist/ 에 모은다. index.html이 불러오는 파일과 vendor 폴더만 복사하므로
// 테스트·SQL·개발 문서는 배포에 들어가지 않는다. 화면에서 링크한 예시 엑셀(개인정보 없음)은 함께 들어간다.
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const out = path.join(root, "dist");

function referencedFiles(html) {
  const files = new Set(["index.html"]);
  for (const match of html.matchAll(/\b(?:src|href)="([^"#]+)"/g)) {
    const target = match[1].split("?")[0];
    if (/^(?:[a-z]+:)?\/\//i.test(target) || target.startsWith("data:") || target.startsWith("#") || target.startsWith("mailto:")) continue;
    if (fs.existsSync(path.join(root, target)) && fs.statSync(path.join(root, target)).isFile()) files.add(target);
  }
  return [...files];
}

function buildDeploy() {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const version = fs.readFileSync(path.join(root, "app-version.js"), "utf8").match(/APP_VERSION\s*=\s*"([^"]+)"/)?.[1];
  if (!version) throw new Error("app-version.js에서 APP_VERSION을 찾지 못했습니다.");
  fs.rmSync(out, { recursive: true, force: true });
  const copied = [];
  for (const file of referencedFiles(html)) {
    fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(out, file));
    copied.push(file);
  }
  fs.writeFileSync(path.join(out, "version.json"), JSON.stringify({ version, builtAt: new Date().toISOString() }, null, 2) + "\n");
  fs.writeFileSync(path.join(out, ".nojekyll"), "");
  fs.writeFileSync(path.join(out, "README.md"),
    `# 교육과정 관리 (배포용)\n\n자동으로 만들어진 배포용 파일입니다. 직접 수정하지 마세요. 버전 ${version}\n`);
  return { version, files: [...copied, "version.json"] };
}

if (require.main === module) {
  const result = buildDeploy();
  console.log(`배포용 파일 ${result.files.length}개를 dist/에 만들었습니다 (버전 ${result.version}).`);
}

module.exports = { buildDeploy, referencedFiles };
