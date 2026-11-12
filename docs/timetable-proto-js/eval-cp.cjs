"use strict";
// CP-SAT 풀이 파일을 같은 점검기(evaluate)로 셈: node eval-cp.cjs <입력.json> <풀이.json>...
const fs = require("fs");
const { evaluate } = require("./timetable-solver.js");
const [inp, ...sols] = process.argv.slice(2);
const M = JSON.parse(fs.readFileSync(inp, "utf8"));
for (const f of sols) {
  const S = JSON.parse(fs.readFileSync(f, "utf8"));
  if (!S.x) { console.log(JSON.stringify({ file: f, status: S.status, seconds: S.seconds })); continue; }
  const e = evaluate(M, S); delete e.classHoleList;
  console.log(JSON.stringify({ file: f.split("/").slice(-2).join("/"), status: S.status, seconds: S.seconds, objective: S.objective, eval: e }));
}
