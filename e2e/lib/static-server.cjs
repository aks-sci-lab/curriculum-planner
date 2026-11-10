"use strict";
// 저장소 폴더를 http://127.0.0.1:<port>/ 로 내보내는 정적 서버(웹 수강신청은 file://에서 오프라인으로 보므로 http가 필요).
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".png": "image/png", ".svg": "image/svg+xml" };

function startStaticServer(root, port = 0) {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(root, pathname === "/" ? "index.html" : pathname);
    if (!file.startsWith(root) || /[\\/](node_modules|\.git|e2e)[\\/]/.test(file)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}
module.exports = { startStaticServer };
