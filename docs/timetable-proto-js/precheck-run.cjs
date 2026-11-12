"use strict";
// 사전 점검 실행: node precheck-run.cjs <입력.json>... (걸린 시간·걸린 항목)
const fs = require("fs");
const { precheck } = require("./timetable-solver.js");
for (const f of process.argv.slice(2)) {
  const M = JSON.parse(fs.readFileSync(f, "utf8"));
  const t = process.hrtime.bigint();
  const r = precheck(M, process.env.MAXLOAD ? { maxLoad: Number(process.env.MAXLOAD) } : {});
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`${f.split("/").pop()}: ${ms.toFixed(1)}ms ${r.ok ? "통과" : "걸림 " + r.issues.length}`);
  for (const x of r.issues.slice(0, 12)) console.log("  -", x.code, x.message);
}
