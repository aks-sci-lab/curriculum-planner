"use strict";
// Node 실행기: node run.cjs <입력.json> <초> <씨앗> [출력.json]
// 진행(초마다 최선 점수)을 stderr로, 결과 요약을 stdout JSON 한 줄로.
const fs = require("fs");
const { solve, evaluate } = require("./timetable-solver.js");
const [inp, secs = "60", seed = "1", outp] = process.argv.slice(2);
const M = JSON.parse(fs.readFileSync(inp, "utf8"));
let peakRss = 0, peakHeap = 0;
const memTick = () => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed); };
const res = solve(M, {
  ...(process.env.OPT ? JSON.parse(process.env.OPT) : {}), timeLimitMs: Number(secs) * 1000, seed: Number(seed), verify: true,
  onProgress: (r) => { memTick(); if (process.env.QUIET !== "1") process.stderr.write(`${(r.ms / 1000).toFixed(0)}s p${r.phase} it ${r.iters} best hard ${r.best.hard} holes ${r.best.holeRuns}/${r.best.holeCells} obj ${r.best.obj} | cur ${r.cur.hard} ${r.cur.holeRuns} ${r.cur.obj}\n`); },
});
memTick();
const ev = evaluate(M, res);
const okVerify = res.verify ? res.verify.incremental.every((v, i) => Math.abs(v - res.verify.fresh[i]) < 1e-6) : null;
const summary = { input: inp.split("/").pop(), opt: process.env.OPT || "", secs: Number(secs), seed: Number(seed), stats: res.stats, verifyOk: okVerify, verify: okVerify ? undefined : res.verify, eval: ev, peakRssMB: Math.round(peakRss / 1048576), peakHeapMB: Math.round(peakHeap / 1048576) };
if (outp) fs.writeFileSync(outp, JSON.stringify({ ...summary, x: res.x, y: res.y, a: res.a, b: res.b, history: res.history }));
console.log(JSON.stringify(summary));
