"use strict";
// 주간 시간표 풀이기(순수 JavaScript, 외부 라이브러리 없음, DOM·fs 없음 → Web Worker에 그대로 올릴 수 있음).
// 입력 = build3.cjs EXPORT 모형(cpsat.py와 같은 JSON), 출력 = cpsat.py SOLUTION과 같은 꼴 { x, y, a, b }.
// 필수: 반 칸 하나, 반 공강 없음(하루 안 빈칸은 뒤쪽만, 창체 앞 칸 빈칸 금지), 교사 겹침·불가·창체, 연강 ≤3(절대 시간),
//       점심(A·B 하나 비움), 같은 수업·블록 하루 1회, 같은 반 같은 과목 나눠 맡기는 서로 다른 교사, 교사 시수 ≤22.
// 소프트(cpsat.py 목적 함수와 같은 가중치): 1000·공강 + 3·점심 앞뒤 + 2·같은 날 같은 과목 + 2·부담 편차 − 3·담임반.
// 방법: 블록 처음 시간(init) + 탐욕 배치 → 담금질 1단계(필수 위반 줄이기) → 2단계(필수 위반 늘리지 않으며 소프트 줄이기).
// 움직임: 반 안 두 칸 맞바꿈, 블록 묶음 열 맞바꿈, Kempe 사슬(교사 겹침을 따라 반을 넓혀 열 맞바꿈), 수업·분반 교사 바꾸기.
// 브라우저: <script>로 읽으면 전역 함수 timetableSolverFactory·timetableWorkerSource. Node: module.exports = 공장 결과.
function timetableSolverFactory() {
  "use strict";
  const EMPTY = -1, FIXED = -2, ENT0 = -10; // 칸 값: 수업 항목 번호(≥0) · 빈칸 · 창체 · 블록 개체(ENT0 − e)
  // 성분 번호
  const C_CONF = 0, C_RUN = 1, C_LUNCH = 2, C_DAY = 3, C_SAME = 4, C_OVER = 5, C_HCELL = 6, C_HRUN = 7, C_NB = 8, C_R3 = 9, C_DEV = 10, C_HR = 11, NCOMP = 12;
  const COMP_NAMES = ["conf", "run", "noLunch", "dayDup", "sameKey", "overload", "holeCells", "holeRuns", "lunchPen", "r3", "dev", "hr"];

  function makeRng(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    return function rand() { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  }
  const pyRound = (x) => { const f = Math.floor(x); const d = x - f; if (d > 0.5) return f + 1; if (d < 0.5) return f; return f % 2 === 0 ? f : f + 1; };

  // 교사 하루 8칸 비트 → 연강 초과·점심 없음·점심 앞뒤 수업 수(dayMaskInfo와 같음)
  function dayMaskInfo(m, AP) {
    let run = 0, longest = 0, excess = 0, count = 0;
    for (let k = 0; k < AP; k += 1) { if (m & (1 << k)) { run += 1; count += 1; if (run > longest) longest = run; } else { if (run > 3) excess += run - 3; run = 0; } }
    if (run > 3) excess += run - 3;
    const on = (k) => (m >> k) & 1;
    const noLunch = on(3) && on(4) ? 1 : 0;
    let nb = Infinity;
    if (!on(3)) nb = Math.min(nb, on(2) + on(4));
    if (!on(4)) nb = Math.min(nb, on(3) + on(5));
    return { count, longest, excess, noLunch, nb: nb === Infinity ? 2 : nb };
  }
  // cpsat.py의 연강 제약은 '4칸 창마다 합 ≤3'(위반 창 수로 셈)
  function runWindows(m, AP) { let v = 0; for (let k = 0; k + 3 < AP; k += 1) if (((m >> k) & 15) === 15) v += 1; return v; }

  // ---------- 모형 준비(정적 구조) ----------
  function prepare(M, opt) {
    const NS = M.NSLOT, P = M.P, ND = M.days.length, AP = M.AP, NABS = ND * AP;
    const fixed = new Uint8Array(NS); for (const s of M.fixed) fixed[s] = 1;
    const freeSlots = []; for (let s = 0; s < NS; s += 1) if (!fixed[s]) freeSlots.push(s);
    const NC = M.classes.length, NT = M.teachers.length, NE = M.entities.length, NP = M.pieces.length;
    const gradeKeys = Object.keys(M.absMap);
    const classAbs = new Int16Array(NC * NS);
    const classGrade = M.classes.map((c) => c.grade);
    M.classes.forEach((c, ci) => { for (let s = 0; s < NS; s += 1) classAbs[ci * NS + s] = M.absMap[c.grade][s]; });
    const blocked = new Uint8Array(NT * NABS);
    M.teachers.forEach((t, ti) => { for (const a of t.blocked) blocked[ti * NABS + a] = 1; });
    // 수업 조각 → 한 시간 항목
    const itemPiece = []; const pieceItems = [];
    for (const p of M.pieces) { const list = []; for (let h = 0; h < p.hours; h += 1) { list.push(itemPiece.length); itemPiece.push(p.idx); } pieceItems.push(list); }
    const NI = itemPiece.length;
    const subjIds = new Map(); const pieceSubj = new Int32Array(NP);
    M.pieces.forEach((p, i) => { if (!subjIds.has(p.subject)) subjIds.set(p.subject, subjIds.size); pieceSubj[i] = subjIds.get(p.subject); });
    const NSUBJ = subjIds.size;
    // 같은 반·같은 과목 나눠 맡기 묶음
    const sameGroups = new Map();
    for (const p of M.pieces) if (p.sameKey && p.pool.length > 1) { if (!sameGroups.has(p.sameKey)) sameGroups.set(p.sameKey, []); sameGroups.get(p.sameKey).push(p.idx); }
    const pieceSame = new Int32Array(NP).fill(-1); const sameList = [];
    for (const list of sameGroups.values()) if (list.length > 1) { for (const pi of list) pieceSame[pi] = sameList.length; sameList.push(list); }
    // 분반(전체 번호 = sec.idx)
    const secs = []; for (const e of M.entities) for (const s of e.sections) secs.push({ idx: s.idx, e: e.idx, pool: s.pool, init: s.init, course: s.course });
    secs.sort((a, b) => a.idx - b.idx);
    const NSEC = secs.length;
    const entClasses = M.entities.map((e) => e.classes);
    const entSecs = M.entities.map((e) => e.sections.map((s) => s.idx));
    const entCredit = M.entities.map((e) => e.credit);
    const entGrade = M.entities.map((e) => e.grade);
    const entAbs = M.entities.map((e) => M.absMap[e.grade]);
    const classPieces = Array.from({ length: NC }, () => []);
    M.pieces.forEach((p) => classPieces[p.ci].push(p.idx));
    const classEnts = Array.from({ length: NC }, () => []);
    M.entities.forEach((e) => { for (const ci of e.classes) classEnts[ci].push(e.idx); });
    // 부담 편차 기준(cpsat.py: 후보에 한 번이라도 든 교사만, round(교과 평균, 기본 16))
    const inPool = new Uint8Array(NT);
    for (const p of M.pieces) for (const t of p.pool) inPool[t] = 1;
    for (const s of secs) for (const t of s.pool) inPool[t] = 1;
    const avgT = new Int16Array(NT);
    M.teachers.forEach((t, ti) => { const v = M.deptAvg[t.dept]; avgT[ti] = pyRound(v === undefined ? 16 : v); });
    const maxLoad = opt.maxLoad ?? 22;
    // 하루 비트 표
    const DAY_RUN = new Int8Array(1 << AP), DAY_NOL = new Int8Array(1 << AP), DAY_NB = new Int8Array(1 << AP);
    for (let m = 0; m < (1 << AP); m += 1) { const x = dayMaskInfo(m, AP); DAY_RUN[m] = runWindows(m, AP); DAY_NOL[m] = x.noLunch; DAY_NB[m] = m ? x.nb : 0; }
    // 반 하루 비트(차 있음) → 공강 칸·공강 덩어리(빈칸 뒤에 수업이 있는 빈칸 덩어리 수 = cpsat softhole 수)
    const HOLE_CELLS = new Int8Array(1 << P), HOLE_RUNS = new Int8Array(1 << P);
    for (let m = 0; m < (1 << P); m += 1) {
      let top = -1; for (let k = 0; k < P; k += 1) if (m & (1 << k)) top = k;
      let c = 0, r = 0; for (let k = 0; k < top; k += 1) if (!(m & (1 << k))) { c += 1; if (m & (1 << (k + 1))) r += 1; }
      HOLE_CELLS[m] = c; HOLE_RUNS[m] = r;
    }
    return { M, NS, P, ND, AP, NABS, fixed, freeSlots, NC, NT, NE, NP, NI, NSEC, NSUBJ, classAbs, classGrade, blocked, itemPiece: Int32Array.from(itemPiece), pieceItems, pieceSubj, pieceSame, sameList, secs, entClasses, entSecs, entCredit, entGrade, entAbs, classPieces, classEnts, inPool, avgT, maxLoad, DAY_RUN, DAY_NOL, DAY_NB, HOLE_CELLS, HOLE_RUNS, gradeKeys };
  }

  // ---------- 상태(증분 비용) ----------
  function createState(S) {
    const { NS, P, ND, AP, NABS, NC, NT, NE, NP, NI, NSEC, NSUBJ } = S;
    const st = {
      cell: new Int32Array(NC * NS).fill(EMPTY),
      itemSlot: new Int16Array(NI).fill(-1),
      eSlot: new Int16Array(NE * 8).fill(-1),
      pT: new Int16Array(NP), sT: new Int16Array(NSEC),
      tCnt: new Int16Array(NT * NABS), tMask: new Uint8Array(NT * ND),
      pDay: new Int8Array(NP * ND), eDay: new Int8Array(NE * ND),
      tsCnt: new Int16Array(NT * NSUBJ * ND),
      load: new Int16Array(NT),
      cMask: new Uint8Array(NC * ND),
      comp: new Float64Array(NCOMP),
    };
    for (let ci = 0; ci < NC; ci += 1) for (let s = 0; s < NS; s += 1) if (S.fixed[s]) st.cell[ci * NS + s] = FIXED;
    return st;
  }

  function makeOps(S, st) {
    const { NS, P, ND, AP, NABS, NSUBJ, classAbs, blocked, itemPiece, pieceSubj, DAY_RUN, DAY_NOL, DAY_NB, HOLE_CELLS, HOLE_RUNS, entClasses, entSecs, entAbs, avgT, inPool, maxLoad } = S;
    const pieces = S.M.pieces;
    const { cell, itemSlot, eSlot, pT, sT, tCnt, tMask, pDay, eDay, tsCnt, load, cMask, comp } = st;
    // 교사 한 칸 사건
    function tEvent(t, a, sign) {
      const x = t * NABS + a;
      const c0 = tCnt[x];
      const bl = blocked[x];
      comp[C_CONF] -= bl ? c0 : (c0 > 1 ? c0 - 1 : 0);
      const c1 = c0 + sign; tCnt[x] = c1;
      comp[C_CONF] += bl ? c1 : (c1 > 1 ? c1 - 1 : 0);
      if ((c0 === 0) !== (c1 === 0)) {
        const d = (a / AP) | 0; const k = a - d * AP; const y = t * ND + d;
        const m0 = tMask[y]; const m1 = c1 ? (m0 | (1 << k)) : (m0 & ~(1 << k));
        tMask[y] = m1;
        comp[C_RUN] += DAY_RUN[m1] - DAY_RUN[m0];
        comp[C_LUNCH] += DAY_NOL[m1] - DAY_NOL[m0];
        comp[C_NB] += DAY_NB[m1] - DAY_NB[m0];
      }
    }
    function dayDup(arr, i, sign) { const c0 = arr[i]; const c1 = c0 + sign; arr[i] = c1; comp[C_DAY] += (c1 > 1 ? c1 - 1 : 0) - (c0 > 1 ? c0 - 1 : 0); }
    function tsAdd(t, subj, d, sign) { const i = (t * NSUBJ + subj) * ND + d; const c0 = tsCnt[i]; const c1 = c0 + sign; tsCnt[i] = c1; comp[C_R3] += (c1 > 1 ? c1 - 1 : 0) - (c0 > 1 ? c0 - 1 : 0); }
    function loadAdd(t, h) {
      const l0 = load[t]; const l1 = l0 + h; load[t] = l1;
      if (inPool[t]) comp[C_DEV] += Math.abs(l1 - avgT[t]) - Math.abs(l0 - avgT[t]);
      comp[C_OVER] += (l1 > maxLoad ? l1 - maxLoad : 0) - (l0 > maxLoad ? l0 - maxLoad : 0);
    }
    // 반 칸의 차 있음 비트(창체 포함)
    function classDayRefresh(ci, d) {
      const y = ci * ND + d; const b = ci * NS + d * P; let m = 0;
      for (let k = 0; k < P; k += 1) if (cell[b + k] !== EMPTY) m |= 1 << k;
      const m0 = cMask[y]; if (m === m0) return;
      comp[C_HCELL] += HOLE_CELLS[m] - HOLE_CELLS[m0]; comp[C_HRUN] += HOLE_RUNS[m] - HOLE_RUNS[m0]; cMask[y] = m;
    }
    // 수업 항목 사건(교사·하루 중복·같은 과목)
    function itemEvents(it, ci, s, sign) {
      const pi = itemPiece[it]; const t = pT[pi]; const d = (s / P) | 0;
      tEvent(t, classAbs[ci * NS + s], sign);
      dayDup(pDay, pi * ND + d, sign);
      tsAdd(t, pieceSubj[pi], d, sign);
    }
    function entEvents(e, s, sign) {
      const a = entAbs[e][s]; const d = (s / P) | 0;
      const ss = entSecs[e];
      for (let i = 0; i < ss.length; i += 1) tEvent(sT[ss[i]], a, sign);
      dayDup(eDay, e * ND + d, sign);
    }
    // 열 맞바꿈: 반 목록 cls(길이 n)에서 칸 p·q를 바꾼다(블록 개체는 cls에 그 반이 모두 들어 있어야 함). 두 번 하면 원래대로.
    const entSeen = new Int32Array(S.NE); let entStamp = 1;
    const entMoveE = new Int32Array(S.NE), entMoveFrom = new Int32Array(S.NE), entSide = new Int8Array(S.NE);
    function swapCols(cls, n, p, q) {
      entStamp += 1; let ne = 0;
      const dp = (p / P) | 0, dq = (q / P) | 0;
      for (let i = 0; i < n; i += 1) {
        const ci = cls[i];
        for (let side = 0; side < 2; side += 1) {
          const s = side ? q : p; const v = cell[ci * NS + s];
          if (v <= ENT0) { const e = ENT0 - v; if (entSeen[e] !== entStamp) { entSeen[e] = entStamp; entSide[e] = side; entMoveE[ne] = e; entMoveFrom[ne] = s; ne += 1; } else if (entSide[e] !== side) entSide[e] = 2; }
        }
      }
      // 같은 블록이 p·q 둘 다에 있으면 그 블록은 그대로(빼기)
      { let k = 0; for (let j = 0; j < ne; j += 1) if (entSide[entMoveE[j]] !== 2) { entMoveE[k] = entMoveE[j]; entMoveFrom[k] = entMoveFrom[j]; k += 1; } ne = k; }
      for (let j = 0; j < ne; j += 1) entEvents(entMoveE[j], entMoveFrom[j], -1);
      for (let i = 0; i < n; i += 1) {
        const ci = cls[i]; const xp = ci * NS + p, xq = ci * NS + q;
        const vp = cell[xp], vq = cell[xq];
        if (vp >= 0) itemEvents(vp, ci, p, -1);
        if (vq >= 0) itemEvents(vq, ci, q, -1);
        cell[xp] = vq; cell[xq] = vp;
        if (vp >= 0) { itemSlot[vp] = q; itemEvents(vp, ci, q, 1); }
        if (vq >= 0) { itemSlot[vq] = p; itemEvents(vq, ci, p, 1); }
        classDayRefresh(ci, dp); if (dq !== dp) classDayRefresh(ci, dq);
      }
      for (let j = 0; j < ne; j += 1) {
        const e = entMoveE[j]; const from = entMoveFrom[j]; const to = from === p ? q : p;
        const base = e * 8; for (let k = 0; k < 8; k += 1) if (eSlot[base + k] === from) { eSlot[base + k] = to; break; }
        entEvents(e, to, 1);
      }
    }
    function setPieceTeacher(pi, t) {
      const old = pT[pi]; if (old === t) return;
      const items = S.pieceItems[pi]; const ci = pieces[pi].ci;
      for (let k = 0; k < items.length; k += 1) { const s = itemSlot[items[k]]; if (s >= 0) { tEvent(old, classAbs[ci * NS + s], -1); tsAdd(old, pieceSubj[pi], (s / P) | 0, -1); } }
      loadAdd(old, -pieces[pi].hours);
      const g = S.pieceSame[pi];
      if (g >= 0) for (const pj of S.sameList[g]) if (pj !== pi) { if (pT[pj] === old) comp[C_SAME] -= 1; if (pT[pj] === t) comp[C_SAME] += 1; }
      if (pieces[pi].hr === old) comp[C_HR] -= 1; if (pieces[pi].hr === t) comp[C_HR] += 1;
      pT[pi] = t;
      loadAdd(t, pieces[pi].hours);
      for (let k = 0; k < items.length; k += 1) { const s = itemSlot[items[k]]; if (s >= 0) { tEvent(t, classAbs[ci * NS + s], 1); tsAdd(t, pieceSubj[pi], (s / P) | 0, 1); } }
    }
    function setSecTeacher(si, t) {
      const old = sT[si]; if (old === t) return;
      const e = S.secs[si].e; const cr = S.entCredit[e];
      for (let k = 0; k < cr; k += 1) { const s = eSlot[e * 8 + k]; if (s >= 0) tEvent(old, entAbs[e][s], -1); }
      loadAdd(old, -cr); sT[si] = t; loadAdd(t, cr);
      for (let k = 0; k < cr; k += 1) { const s = eSlot[e * 8 + k]; if (s >= 0) tEvent(t, entAbs[e][s], 1); }
    }
    // 처음 놓기
    function placeItem(it, ci, s) { cell[ci * NS + s] = it; itemSlot[it] = s; itemEvents(it, ci, s, 1); classDayRefresh(ci, (s / P) | 0); }
    function unplaceItem(it, ci, s) { itemEvents(it, ci, s, -1); cell[ci * NS + s] = EMPTY; itemSlot[it] = -1; classDayRefresh(ci, (s / P) | 0); }
    function placeEntity(e, slots) {
      slots.forEach((s, k) => { eSlot[e * 8 + k] = s; for (const ci of entClasses[e]) { cell[ci * NS + s] = ENT0 - e; classDayRefresh(ci, (s / P) | 0); } entEvents(e, s, 1); });
    }
    return { tEvent, swapCols, setPieceTeacher, setSecTeacher, placeItem, unplaceItem, placeEntity, classDayRefresh, loadAdd };
  }

  // ---------- 처음 상태 ----------
  function initialState(S, rand, opt) {
    const st = createState(S); const ops = makeOps(S, st);
    const M = S.M; const { NS, P, ND, NC } = S;
    // 교사: init, 같은 반 같은 과목 묶음은 서로 다르게
    M.pieces.forEach((p, i) => { st.pT[i] = p.pool.includes(p.init) ? p.init : p.pool[0]; });
    S.secs.forEach((s, i) => { st.sT[i] = s.pool.includes(s.init) ? s.init : s.pool[0]; });
    // 부담·담임·같은 과목 묶음 성분 계산
    for (let t = 0; t < S.NT; t += 1) if (S.inPool[t]) st.comp[C_DEV] += Math.abs(0 - S.avgT[t]);
    M.pieces.forEach((p, i) => { ops.loadAdd(st.pT[i], p.hours); if (p.hr === st.pT[i]) st.comp[C_HR] += 1; });
    S.secs.forEach((s, i) => ops.loadAdd(st.sT[i], S.entCredit[s.e]));
    for (const list of S.sameList) for (let a = 0; a < list.length; a += 1) for (let b = a + 1; b < list.length; b += 1) if (st.pT[list[a]] === st.pT[list[b]]) st.comp[C_SAME] += 1;
    for (let ci = 0; ci < NC; ci += 1) for (let d = 0; d < ND; d += 1) ops.classDayRefresh(ci, d);
    // 블록 개체: 처음 시간(init, 6단계 블록 시간) — 반 칸이 겹치면 빈 칸으로 옮김
    for (let e = 0; e < S.NE; e += 1) {
      const want = opt.entitySlots ? opt.entitySlots[e] : M.entities[e].init;
      const slots = [];
      for (const s of want) if (!S.fixed[s] && S.entClasses[e].every((ci) => st.cell[ci * NS + s] === EMPTY) && !slots.includes(s)) slots.push(s);
      const cand = S.freeSlots.filter((s) => !slots.includes(s) && S.entClasses[e].every((ci) => st.cell[ci * NS + s] === EMPTY));
      while (slots.length < S.entCredit[e] && cand.length) {
        const usedDays = new Set(slots.map((s) => (s / P) | 0));
        let k = cand.findIndex((s) => !usedDays.has((s / P) | 0)); if (k < 0) k = 0;
        slots.push(cand.splice(k, 1)[0]);
      }
      ops.placeEntity(e, slots);
    }
    // 반 수업: 빈칸(뒤쪽) 정하고 남은 칸에 탐욕 배치
    const order = [];
    for (let ci = 0; ci < NC; ci += 1) {
      const items = []; for (const pi of S.classPieces[ci]) for (const it of S.pieceItems[pi]) items.push(it);
      const free = []; for (let s = 0; s < NS; s += 1) if (st.cell[ci * NS + s] === EMPTY) free.push(s);
      let nEmpty = free.length - items.length;
      const empty = new Set();
      // 날마다 뒤쪽 빈 칸 덩어리에서 끝부터 빈칸으로(창체 앞은 제외)
      let guard = 0;
      while (nEmpty > 0 && guard < 100) {
        guard += 1; let best = -1, bestLen = -1;
        for (let d = 0; d < ND; d += 1) {
          let len = 0; for (let k = P - 1; k >= 0; k -= 1) { const s = d * P + k; if (S.fixed[s]) { len = -1; break; } if (empty.has(s)) continue; if (st.cell[ci * NS + s] !== EMPTY) break; len += 1; if (len) break; }
          if (len <= 0) continue;
          // 그 날 이미 비운 칸 수가 적은 날 우선
          let have = 0; for (let k = 0; k < P; k += 1) if (empty.has(d * P + k)) have += 1;
          const score = 10 - have + rand() * 0.5; if (score > bestLen) { bestLen = score; best = d; }
        }
        if (best < 0) break;
        for (let k = P - 1; k >= 0; k -= 1) { const s = best * P + k; if (empty.has(s)) continue; if (st.cell[ci * NS + s] === EMPTY) { empty.add(s); nEmpty -= 1; } break; }
      }
      for (const it of items) order.push([it, ci, free.filter((s) => !empty.has(s))]);
    }
    // 교사 시간 제약이 많은 수업부터(후보 1명·부담 큰 교사)
    order.sort((A, B) => (S.M.pieces[S.itemPiece[A[0]]].pool.length - S.M.pieces[S.itemPiece[B[0]]].pool.length) || (st.load[st.pT[S.itemPiece[B[0]]]] - st.load[st.pT[S.itemPiece[A[0]]]]) || (rand() - 0.5));
    const W = weightsFeasible();
    for (const [it, ci, cells] of order) {
      let best = -1, bc = Infinity;
      for (const s of cells) {
        if (st.cell[ci * NS + s] !== EMPTY) continue;
        const b = costOf(st.comp, W); ops.placeItem(it, ci, s); const dl = costOf(st.comp, W) - b; ops.unplaceItem(it, ci, s);
        if (dl < bc - 1e-9 || (Math.abs(dl - bc) < 1e-9 && rand() < 0.3)) { bc = dl; best = s; }
      }
      if (best < 0) for (const s of S.freeSlots) if (st.cell[ci * NS + s] === EMPTY) { best = s; break; }
      if (best >= 0) ops.placeItem(it, ci, best);
    }
    return { st, ops };
  }

  function costOf(comp, W) { let c = 0; for (let i = 0; i < NCOMP; i += 1) c += comp[i] * W[i]; return c; }
  function weightsFeasible(hw) { const h = hw || [0.5, 0.5]; return Float64Array.from([1, 1, 1, 1, 1, 1, h[0], h[1], 0.002, 0.001, 0.001, -0.002]); }
  function weightsSoft(hardW) { return Float64Array.from([hardW, hardW, hardW, hardW, hardW, hardW, 300, 1000, 3, 2, 2, -3]); }
  const hardOf = (c) => c[C_CONF] + c[C_RUN] + c[C_LUNCH] + c[C_DAY] + c[C_SAME] + c[C_OVER];
  const objOf = (c) => 1000 * c[C_HRUN] + 3 * c[C_NB] + 2 * c[C_R3] + 2 * c[C_DEV] - 3 * c[C_HR];

  // ---------- 풀이 ----------
  function solve(M, options) {
    const opt = Object.assign({ timeLimitMs: 60000, seed: 1, onProgress: null, progressMs: 1000, phase1Share: 0.6, T1hi: 0.6, T1lo: 0.03, cycle1: 400000, T2hi: 6, T2lo: 0.15, cycle2: 600000, probs: [0.40, 0.08, 0.25, 0.10, 0.07, 0.05, 0.05], restart: 1, holeW1: [0.15, 0.15], holeW2: [0.5, 0.5], hardW2: 3, share1: 0.3, share2: 0.7, kick: 0 }, options || {});
    const now = opt.now || (() => Date.now());
    const t0 = now();
    const S = prepare(M, opt);
    const rand = makeRng(opt.seed);
    const randInt = (n) => (rand() * n) | 0;
    const { st, ops } = initialState(S, rand, opt);
    const { NS, P, NC, NT, NE, NP, NSEC } = S;
    const cell = st.cell, comp = st.comp;
    const free = S.freeSlots; const NF = free.length;
    const piecesMulti = []; for (let i = 0; i < NP; i += 1) if (M.pieces[i].pool.length > 1) piecesMulti.push(i);
    const secsMulti = []; for (let i = 0; i < NSEC; i += 1) if (S.secs[i].pool.length > 1) secsMulti.push(i);
    const cls = new Int32Array(NC); const inC = new Int32Array(NC); let cStamp = 1;
    const markP = new Int32Array(NT), markQ = new Int32Array(NT);
    // 닫힘: ci0에서 시작해 블록 개체(같은 블록의 반 전부)와 kempe면 교사 겹침으로 반을 넓힘. 창체 칸이면 -1.
    function closure(ci0, p, q, kempe) {
      cStamp += 1; let n = 0; cls[n++] = ci0; inC[ci0] = cStamp;
      let i = 0;
      for (;;) {
        for (; i < n; i += 1) {
          const ci = cls[i];
          for (let side = 0; side < 2; side += 1) {
            const s = side ? q : p; const v = cell[ci * NS + s];
            if (v === FIXED) return -1;
            if (v <= ENT0) {
              const e = ENT0 - v; const ec = S.entClasses[e];
              for (let j = 0; j < ec.length; j += 1) if (inC[ec[j]] !== cStamp) { inC[ec[j]] = cStamp; cls[n++] = ec[j]; }
              if (kempe) { const ss = S.entSecs[e]; for (let j = 0; j < ss.length; j += 1) (side ? markQ : markP)[st.sT[ss[j]]] = cStamp; }
            } else if (v >= 0 && kempe) (side ? markQ : markP)[st.pT[S.itemPiece[v]]] = cStamp;
          }
        }
        if (!kempe) return n;
        let added = false;
        for (let cj = 0; cj < NC; cj += 1) {
          if (inC[cj] === cStamp) continue;
          let hit = false;
          for (let side = 0; side < 2 && !hit; side += 1) {
            const s = side ? q : p; const v = cell[cj * NS + s]; const mk = side ? markP : markQ; // q 칸의 교사가 p에서 오는 교사와 겹치면
            if (v >= 0) { if (mk[st.pT[S.itemPiece[v]]] === cStamp) hit = true; }
            else if (v <= ENT0) { const ss = S.entSecs[ENT0 - v]; for (let j = 0; j < ss.length; j += 1) if (mk[st.sT[ss[j]]] === cStamp) { hit = true; break; } }
          }
          if (hit) { inC[cj] = cStamp; cls[n++] = cj; added = true; }
        }
        if (!added) return n;
      }
    }
    // 같은 날 다른 칸 고르기 쉽게: 반의 수업/빈칸 칸
    let best = null; let bestHard = Infinity, bestHoleRuns = Infinity, bestHoleCells = Infinity, bestObj = Infinity;
    const snapshot = () => ({ cell: Int32Array.from(st.cell), itemSlot: Int16Array.from(st.itemSlot), eSlot: Int16Array.from(st.eSlot), pT: Int16Array.from(st.pT), sT: Int16Array.from(st.sT) });
    const better = (h, hr, hc, o) => (h !== bestHard ? h < bestHard : hr !== bestHoleRuns ? hr < bestHoleRuns : hc !== bestHoleCells ? hc < bestHoleCells : o < bestObj - 1e-9);
    function considerBest(force) {
      const h = hardOf(comp), hr = comp[C_HRUN], hc = comp[C_HCELL], o = objOf(comp);
      if (force || better(h, hr, hc, o)) { bestHard = h; bestHoleRuns = hr; bestHoleCells = hc; bestObj = o; best = { snap: snapshot(), comp: Float64Array.from(comp) }; return true; }
      return false;
    }
    considerBest(true);
    const history = [];
    let lastProg = t0; let iters = 0; let firstFeasibleMs = null; let firstHardZeroMs = null;
    const report = (phase) => {
      const tt = now();
      const rec = { ms: tt - t0, phase, iters, cur: { hard: hardOf(comp), holeRuns: comp[C_HRUN], holeCells: comp[C_HCELL], obj: objOf(comp) }, best: { hard: bestHard, holeRuns: bestHoleRuns, holeCells: bestHoleCells, obj: bestObj } };
      history.push(rec); if (opt.onProgress) opt.onProgress(rec); lastProg = tt;
    };
    // 한 움직임(되돌리기 위해 기록)
    let mvType = 0, mvN = 0, mvP = 0, mvQ = 0, mvI = 0, mvOld = 0;
    function propose(kind) {
      // kind: 0 반 안 맞바꿈, 1 블록 열(닫힘), 2 Kempe, 3 수업 교사, 4 분반 교사
      if (kind === 3) {
        if (!piecesMulti.length) return false;
        const pi = piecesMulti[randInt(piecesMulti.length)]; const pool = M.pieces[pi].pool; const t = pool[randInt(pool.length)];
        if (t === st.pT[pi]) return false;
        mvType = 3; mvI = pi; mvOld = st.pT[pi]; ops.setPieceTeacher(pi, t); return true;
      }
      if (kind === 4) {
        if (!secsMulti.length) return false;
        const si = secsMulti[randInt(secsMulti.length)]; const pool = S.secs[si].pool; const t = pool[randInt(pool.length)];
        if (t === st.sT[si]) return false;
        mvType = 4; mvI = si; mvOld = st.sT[si]; ops.setSecTeacher(si, t); return true;
      }
      if (kind === 5 || kind === 6) return proposeTargeted(kind);
      const ci = randInt(NC); const p = free[randInt(NF)]; let q = free[randInt(NF)];
      if (p === q) return false;
      const vp = cell[ci * NS + p], vq = cell[ci * NS + q];
      if (kind === 0) {
        if (vp <= ENT0 || vq <= ENT0 || (vp === EMPTY && vq === EMPTY)) return false;
        cls[0] = ci; mvN = 1;
      } else {
        if (kind === 1 && vp > ENT0 && vq > ENT0) return false;
        if (vp === EMPTY && vq === EMPTY) return false;
        const n = closure(ci, p, q, kind === 2);
        if (n < 0 || (kind === 2 && n < 2)) return false;
        mvN = n;
      }
      mvType = 0; mvP = p; mvQ = q; ops.swapCols(cls, mvN, p, q); return true;
    }
    // 겨냥 움직임: 5 = 공강 있는 반·날의 빈칸을 다른 칸과(Kempe), 6 = 위반 있는 교사·날의 수업 하나를 다른 칸과(Kempe)
    const cellTeacherIs = (v, t) => { if (v >= 0) return st.pT[S.itemPiece[v]] === t; if (v <= ENT0) { const ss = S.entSecs[ENT0 - v]; for (let j = 0; j < ss.length; j += 1) if (st.sT[ss[j]] === t) return true; } return false; };
    const candC = new Int32Array(NC * P); 
    function proposeTargeted(kind) {
      let ci = -1, p = -1;
      if (kind === 5) {
        if (comp[C_HCELL] <= 0) return false;
        const N = NC * S.ND; const off = randInt(N); let y = -1;
        for (let k = 0; k < N; k += 1) { const z = (off + k) % N; if (S.HOLE_CELLS[st.cMask[z]]) { y = z; break; } }
        if (y < 0) return false;
        ci = (y / S.ND) | 0; const d = y - ci * S.ND; const m = st.cMask[y];
        let top = -1; for (let k = 0; k < P; k += 1) if (m & (1 << k)) top = k;
        let nh = 0; for (let k = 0; k < top; k += 1) if (!(m & (1 << k))) candC[nh++] = d * P + k;
        p = candC[randInt(nh)];
        if (rand() < 0.5 && !S.fixed[d * P + top]) { const q = d * P + top; return doKempe(ci, p, q); }
      } else {
        if (comp[C_CONF] + comp[C_RUN] + comp[C_LUNCH] <= 0) return false;
        const N = NT * S.ND; const off = randInt(N); let y = -1;
        for (let k = 0; k < N && y < 0; k += 1) {
          const z = (off + k) % N; const m = st.tMask[z]; if (!m) continue;
          if (S.DAY_RUN[m] || S.DAY_NOL[m]) { y = z; break; }
          const t = (z / S.ND) | 0; const b = t * S.NABS + (z - t * S.ND) * S.AP;
          for (let j = 0; j < S.AP; j += 1) { const c = st.tCnt[b + j]; if (c > 1 || (c > 0 && S.blocked[b + j])) { y = z; break; } }
        }
        if (y < 0) return false;
        const t = (y / S.ND) | 0; const d = y - t * S.ND;
        let n = 0; for (let c = 0; c < NC; c += 1) for (let k = 0; k < P; k += 1) { const s = d * P + k; if (cellTeacherIs(cell[c * NS + s], t)) candC[n++] = c * NS + s; }
        if (!n) return false;
        const z = candC[randInt(n)]; ci = (z / NS) | 0; p = z - ci * NS;
      }
      const q = free[randInt(NF)];
      return doKempe(ci, p, q);
    }
    function doKempe(ci, p, q) {
      if (p === q || S.fixed[p] || S.fixed[q]) return false;
      if (cell[ci * NS + p] === EMPTY && cell[ci * NS + q] === EMPTY) return false;
      const n = closure(ci, p, q, true); if (n < 0) return false;
      mvN = n; mvType = 0; mvP = p; mvQ = q; ops.swapCols(cls, mvN, p, q); return true;
    }
    const clsUndo = new Int32Array(NC);
    function undo() {
      if (mvType === 3) ops.setPieceTeacher(mvI, mvOld);
      else if (mvType === 4) ops.setSecTeacher(mvI, mvOld);
      else ops.swapCols(clsUndo, mvN, mvP, mvQ);
    }
    // 담금질
    const deadline = t0 + opt.timeLimitMs;
    let phase = 1;
    let W = null;
    let T = opt.T1hi; const T1hi = opt.T1hi, T1lo = opt.T1lo;
    let cycleLen = opt.cycle1; let cycleIt = 0;
    const probs = opt.probs;
    const cum = []; probs.reduce((a, x, i) => (cum[i] = a + x), 0);
    const pickKind = () => { const r = rand(); for (let i = 0; i < cum.length; i += 1) if (r < cum[i]) return i; return 0; };
    let cur = 0;
    let sinceImprove = 0;
    const loadSnap = (b) => {
      // 상태를 최선 스냅숏으로: 새 상태를 만들고 같은 배치를 다시 놓는다
      const st2 = createState(S); const ops2 = makeOps(S, st2);
      st2.pT.set(b.snap.pT); st2.sT.set(b.snap.sT);
      for (let t = 0; t < NT; t += 1) if (S.inPool[t]) st2.comp[C_DEV] += Math.abs(0 - S.avgT[t]);
      M.pieces.forEach((p, i) => { ops2.loadAdd(st2.pT[i], p.hours); if (p.hr === st2.pT[i]) st2.comp[C_HR] += 1; });
      S.secs.forEach((s, i) => ops2.loadAdd(st2.sT[i], S.entCredit[s.e]));
      for (const list of S.sameList) for (let a = 0; a < list.length; a += 1) for (let c = a + 1; c < list.length; c += 1) if (st2.pT[list[a]] === st2.pT[list[c]]) st2.comp[C_SAME] += 1;
      for (let ci = 0; ci < NC; ci += 1) for (let d = 0; d < S.ND; d += 1) ops2.classDayRefresh(ci, d);
      for (let e = 0; e < NE; e += 1) { const sl = []; for (let k = 0; k < S.entCredit[e]; k += 1) sl.push(b.snap.eSlot[e * 8 + k]); ops2.placeEntity(e, sl); }
      for (let ci = 0; ci < NC; ci += 1) for (let s = 0; s < NS; s += 1) { const v = b.snap.cell[ci * NS + s]; if (v >= 0) ops2.placeItem(v, ci, s); }
      // 같은 배열 객체를 유지(ops가 참조)하도록 내용 복사
      for (const k of Object.keys(st2)) st[k].set(st2[k]);
    };
    // 단계 표: 1 = 필수 위반 0 찾기(공강 가중치 작게), 2 = 필수 위반을 거의 막고 공강 줄이기, 3 = 필수·공강 늘리지 않고 소프트 줄이기
    const PH = [null,
      { W: weightsFeasible(opt.holeW1), Thi: opt.T1hi, Tlo: opt.T1lo, cycle: opt.cycle1 },
      { W: (() => { const w = weightsFeasible(opt.holeW2); for (let k = 0; k < 6; k += 1) w[k] = opt.hardW2; return w; })(), Thi: opt.T1hi, Tlo: opt.T1lo, cycle: opt.cycle1 },
      { W: weightsSoft(1e6), Thi: opt.T2hi, Tlo: opt.T2lo, cycle: opt.cycle2 }];
    const share1 = t0 + opt.timeLimitMs * opt.share1, share2 = t0 + opt.timeLimitMs * opt.share2;
    const enterPhase = (k) => { if (k > 1) loadSnap(best); phase = k; W = PH[k].W; cur = costOf(comp, W); cycleIt = 0; cycleLen = PH[k].cycle; sinceImprove = 0; };
    enterPhase(1);
    for (;;) {
      iters += 1; cycleIt += 1;
      if ((iters & 1023) === 0) {
        const tt = now();
        if (tt - lastProg >= opt.progressMs) report(phase);
        if (tt >= deadline) break;
        if (phase === 1 && (bestHard === 0 || tt >= share1)) enterPhase(bestHard === 0 && bestHoleRuns === 0 ? 3 : 2);
        else if (phase === 2 && ((bestHard === 0 && bestHoleRuns === 0) || tt >= share2)) enterPhase(3);
        // 온도: 주기마다 위→아래(재가열), 주기 동안 최선이 안 나아지면 최선에서 다시
        const P0 = PH[phase]; const frac = Math.min(1, cycleIt / cycleLen);
        T = P0.Thi * Math.pow(P0.Tlo / P0.Thi, frac);
        if (cycleIt >= cycleLen) {
          cycleIt = 0;
          if (opt.restart && sinceImprove > 0) {
            loadSnap(best);
            // 흔들기(반복 지역 탐색): 공강 줄이기 단계에서 최선 상태를 Kempe·블록 움직임 몇 개로 강제로 흔든 뒤 다시 식힘
            if (phase === 2 && opt.kick > 0) for (let k = 0, tries = 0; k < opt.kick && tries < opt.kick * 50; tries += 1) if (propose(rand() < 0.5 ? 1 : 2)) k += 1;
            cur = costOf(comp, W);
          }
          sinceImprove = 1;
        }
      }
      const kind = pickKind();
      if (!propose(kind)) continue;
      if (mvType === 0) clsUndo.set(cls.subarray(0, mvN));
      const nc = costOf(comp, W); const dl = nc - cur;
      if (dl <= 0 || rand() < Math.exp(-dl / T)) {
        cur = nc;
        if (dl < 0 && considerBest(false)) {
          sinceImprove = 0;
          if (firstHardZeroMs === null && bestHard === 0) firstHardZeroMs = now() - t0;
          if (firstFeasibleMs === null && bestHard === 0 && bestHoleRuns === 0) firstFeasibleMs = now() - t0;
        }
      } else undo();
    }
    report(phase);
    let verify = null;
    if (opt.verify) { loadSnap(best); verify = { incremental: Array.from(best.comp), fresh: Array.from(comp) }; }
    // 결과
    const b = best.snap;
    const x = M.pieces.map((p, i) => S.pieceItems[i].map((it) => b.itemSlot[it]).sort((u, v) => u - v));
    const y = M.entities.map((e, i) => { const sl = []; for (let k = 0; k < S.entCredit[i]; k += 1) sl.push(b.eSlot[i * 8 + k]); return sl.sort((u, v) => u - v); });
    const comps = {}; COMP_NAMES.forEach((n, i) => { comps[n] = best.comp[i]; });
    return { x, y, a: Array.from(b.pT), b: Array.from(b.sT), pieces: M.pieces.map((p, i) => [i, x[i], b.pT[i]]), stats: { ms: now() - t0, iterations: iters, firstHardZeroMs, firstFeasibleMs, comps, hard: bestHard, holeRuns: bestHoleRuns, holeCells: bestHoleCells, objective: bestObj }, history, verify };
  }

  // ---------- 점검(풀이와 무관하게 결과만 보고 다시 셈: build3-check.cjs와 같은 방식) ----------
  function evaluate(M, sol) {
    const S = prepare(M, {});
    const { NS, P, ND, AP, NABS, NC, NT } = S;
    const DAYS = M.days;
    const out = { classOverlap: 0, fixedUsed: 0, hoursWrong: 0, teacherConflicts: 0, unavailable: 0, notInPool: 0, runOver: 0, noLunch: 0, lesson2: 0, entityDay2: 0, sameKey: 0, overload: 0, classHoles: 0, classHoleRuns: 0, classHoleList: [],
      lunchGood: 0, lunchHalf: 0, lunchDays: 0, lunchPen: 0, r3cp: 0, r3check: 0, dev: 0, hr: 0, homeroom: { applies: 0, ok: 0 }, subjectPerDay3: 0, subjectPerDay2: 0, teacherDayOver: 0 };
    const occ = Array.from({ length: NC * NS }, () => []);
    const tSlots = Array.from({ length: NT * NABS }, () => []);
    const load = new Int32Array(NT);
    M.pieces.forEach((p, i) => {
      const slots = sol.x[i]; const t = sol.a[i];
      if (!p.pool.includes(t)) out.notInPool += 1;
      if (slots.length !== p.hours) out.hoursWrong += 1;
      load[t] += p.hours;
      for (const s of slots) { occ[p.ci * NS + s].push({ kind: "lesson", label: p.subject, t }); tSlots[t * NABS + M.absMap[p.grade][s]].push({ subject: p.subject, key: `${p.ci}|${p.subject}`, ci: p.ci }); if (S.fixed[s]) out.fixedUsed += 1; }
    });
    M.entities.forEach((e, i) => {
      const slots = sol.y[i];
      if (slots.length !== e.credit) out.hoursWrong += 1;
      const days = new Set(slots.map((s) => (s / P) | 0)); if (days.size < slots.length) out.entityDay2 += slots.length - days.size;
      for (const s of slots) { if (S.fixed[s]) out.fixedUsed += 1; for (const ci of e.classes) occ[ci * NS + s].push({ kind: "block" }); }
      for (const sec of e.sections) {
        const t = sol.b[sec.idx]; if (!sec.pool.includes(t)) out.notInPool += 1; load[t] += e.credit;
        for (const s of slots) tSlots[t * NABS + M.absMap[e.grade][s]].push({ subject: sec.course, key: `S${sec.idx}` });
      }
    });
    // 같은 반 같은 과목 나눠 맡기
    const sk = new Map(); M.pieces.forEach((p, i) => { if (!p.sameKey || p.pool.length < 2) return; if (!sk.has(p.sameKey)) sk.set(p.sameKey, []); sk.get(p.sameKey).push(sol.a[i]); });
    for (const list of sk.values()) { const seen = new Map(); for (const t of list) seen.set(t, (seen.get(t) || 0) + 1); for (const n of seen.values()) if (n > 1) out.sameKey += n - 1; }
    // 반
    for (let ci = 0; ci < NC; ci += 1) {
      for (let s = 0; s < NS; s += 1) if (occ[ci * NS + s].length > 1 || (S.fixed[s] && occ[ci * NS + s].length)) out.classOverlap += 1;
      for (let d = 0; d < ND; d += 1) {
        let m = 0; for (let k = 0; k < P; k += 1) { const s = d * P + k; if (S.fixed[s] || occ[ci * NS + s].length) m |= 1 << k; }
        out.classHoles += S.HOLE_CELLS[m]; out.classHoleRuns += S.HOLE_RUNS[m];
        if (S.HOLE_CELLS[m]) for (let k = 0; k < P; k += 1) { let top = -1; for (let j = 0; j < P; j += 1) if (m & (1 << j)) top = j; if (k < top && !(m & (1 << k))) out.classHoleList.push(`${M.classes[ci].id} ${DAYS[d]}${k + 1}`); }
        const per = new Map(); for (let k = 0; k < P; k += 1) for (const x of occ[ci * NS + d * P + k]) if (x.kind === "lesson") per.set(x.label, (per.get(x.label) || 0) + 1);
        for (const n of per.values()) { if (n > 2) out.subjectPerDay3 += 1; else if (n === 2) out.subjectPerDay2 += 1; }
      }
    }
    // 교사
    for (let t = 0; t < NT; t += 1) {
      if (S.inPool[t]) out.dev += Math.abs(load[t] - S.avgT[t]);
      if (load[t] > S.maxLoad) out.overload += load[t] - S.maxLoad;
      const subjTotal = new Map();
      for (let a = 0; a < NABS; a += 1) for (const x of tSlots[t * NABS + a]) subjTotal.set(x.subject, (subjTotal.get(x.subject) || 0) + 1);
      for (let d = 0; d < ND; d += 1) {
        let m = 0;
        const per = new Map(), perKey = new Map(), perCp = new Map();
        for (let k = 0; k < AP; k += 1) {
          const a = d * AP + k; const list = tSlots[t * NABS + a];
          if (list.length) m |= 1 << k;
          if (list.length > 1) out.teacherConflicts += list.length - 1;
          if (list.length && S.blocked[t * NABS + a]) out.unavailable += list.length;
          for (const x of list) { per.set(x.subject, (per.get(x.subject) || 0) + 1); perKey.set(x.key, (perKey.get(x.key) || 0) + 1); if (!x.key.startsWith("S")) perCp.set(x.subject, (perCp.get(x.subject) || 0) + 1); }
        }
        if (!m) continue;
        const info = dayMaskInfo(m, AP);
        if (info.excess) out.runOver += 1;
        if (info.noLunch) out.noLunch += 1;
        out.lunchDays += 1;
        if (!info.noLunch && info.nb === 0) out.lunchGood += 1; else if (!info.noLunch && info.nb === 1) out.lunchHalf += 1;
        out.lunchPen += info.nb;
        if (info.count > 6) out.teacherDayOver += 1;
        for (const [subject, cnt] of per) out.r3check += Math.max(0, cnt - Math.ceil(subjTotal.get(subject) / ND));
        for (const cnt of perKey.values()) if (cnt >= 2) out.lesson2 += 1;
        for (const cnt of perCp.values()) if (cnt >= 2) out.r3cp += cnt - 1;
      }
    }
    // 담임반(build3-check: 담임이 그 학년 반 수업을 맡을 때만 적용, 자기 반 수업이 있으면 충족)
    M.pieces.forEach((p, i) => { if (p.hr === sol.a[i]) out.hr += 1; });
    const hrOf = new Map(); M.pieces.forEach((p) => hrOf.set(p.ci, p.hr));
    for (let ci = 0; ci < NC; ci += 1) {
      const t = hrOf.get(ci); if (t === undefined || t < 0) continue;
      const g = M.classes[ci].grade;
      const teachesGrade = M.pieces.some((p, i) => sol.a[i] === t && M.classes[p.ci].grade === g);
      if (!teachesGrade) continue;
      out.homeroom.applies += 1;
      if (M.pieces.some((p, i) => p.ci === ci && sol.a[i] === t)) out.homeroom.ok += 1;
    }
    out.hard = out.classOverlap + out.fixedUsed + out.hoursWrong + out.teacherConflicts + out.unavailable + out.notInPool + out.runOver + out.noLunch + out.lesson2 + out.entityDay2 + out.sameKey + out.overload;
    out.cpObjective = 1000 * out.classHoleRuns + 3 * out.lunchPen + 2 * out.r3cp + 2 * out.dev - 3 * out.hr;
    return out;
  }

  // ---------- 빠른 사전 점검(필요조건만: 걸리면 '불가능', 통과해도 가능하다는 보장은 없음) ----------
  function precheck(M, opt) {
    const o = Object.assign({ maxLoad: 22 }, opt || {});
    const S = prepare(M, o);
    const { NS, P, ND, AP, NABS, NC, NT } = S;
    const T = M.teachers; const issues = [];
    const nFree = S.freeSlots.length;
    // 1) 반마다 주당 칸: 수업 + 블록 ≤ 쓸 수 있는 칸, 블록 학점 ≤ 요일 수
    for (let ci = 0; ci < NC; ci += 1) {
      const lesson = S.classPieces[ci].reduce((a, pi) => a + M.pieces[pi].hours, 0);
      const block = S.classEnts[ci].reduce((a, e) => a + S.entCredit[e], 0);
      if (lesson + block > nFree) issues.push({ code: "class-hours", target: M.classes[ci].id, need: lesson + block, capacity: nFree, message: `${M.classes[ci].id}: 수업 ${lesson} + 블록 ${block} = ${lesson + block}시간 > 쓸 수 있는 칸 ${nFree}` });
    }
    for (const p of M.pieces) if (p.hours > ND) issues.push({ code: "piece-days", target: M.classes[p.ci].id, message: `${M.classes[p.ci].id} ${p.subject} ${p.hours}시간 > 요일 ${ND}(같은 수업 하루 1회)` });
    for (const e of M.entities) if (e.credit > ND) issues.push({ code: "block-days", target: e.label, message: `${e.label} ${e.credit}학점 > 요일 ${ND}` });
    // 2) 블록 안 분반 → 교사 이분 매칭(같은 시간에 서로 다른 교사)
    for (const e of M.entities) {
      const own = new Map();
      const tryAug = (si, seen) => { for (const t of e.sections[si].pool) { if (seen.has(t)) continue; seen.add(t); if (!own.has(t) || tryAug(own.get(t), seen)) { own.set(t, si); return true; } } return false; };
      let m = 0; for (let si = 0; si < e.sections.length; si += 1) if (tryAug(si, new Set())) m += 1;
      if (m < e.sections.length) issues.push({ code: "block-match", target: e.label, need: e.sections.length, capacity: m, message: `${e.label}: 분반 ${e.sections.length}개를 동시에 맡을 서로 다른 교사가 ${m}명뿐` });
    }
    // 3) 교사 한 명 용량: 하루 쓸 수 있는 칸(불가·창체 빼고, 점심 1칸·연강 규칙 반영) 합 ≥ 그 교사만 맡을 수 있는 시수
    const dayCap = (t, d) => {
      // 그날 비어 있는 칸 중 연강 ≤3·점심 규칙을 지키는 최대 수업 수(8칸 비트 전수)
      let allowed = 0; for (let k = 0; k < AP; k += 1) if (!S.blocked[t * NABS + d * AP + k]) allowed |= 1 << k;
      let best = 0; for (let m = allowed; ; m = (m - 1) & allowed) { if (!S.DAY_RUN[m] && !S.DAY_NOL[m]) { const c = popcount(m); if (c > best) best = c; } if (m === 0) break; }
      return best;
    };
    const cap = new Int32Array(NT); for (let t = 0; t < NT; t += 1) { let c = 0; for (let d = 0; d < ND; d += 1) c += dayCap(t, d); cap[t] = Math.min(c, o.maxLoad); }
    // 4) 후보 묶음 Hall 조건: 후보가 P의 부분집합인 수업·분반 시수 합 ≤ Σ 용량(P)  (precheck5b와 같은 꼴, 22 대신 실제 용량)
    const items = []; for (const p of M.pieces) items.push({ pool: p.pool, h: p.hours, what: `${M.classes[p.ci].id} ${p.subject}` });
    for (const e of M.entities) for (const s of e.sections) items.push({ pool: s.pool, h: e.credit, what: `${e.label} ${s.course}` });
    const poolKeys = new Map(); for (const it of items) { const k = [...it.pool].sort((a, b) => a - b).join(","); if (!poolKeys.has(k)) poolKeys.set(k, it.pool); }
    // 교과별 합집합도 검사(후보 묶음 합치기)
    const pools = [...poolKeys.values()].map((p) => new Set(p));
    const unionKeys = new Map(); for (const p of pools) unionKeys.set([...p].sort((a, b) => a - b).join(","), p);
    for (let i = 0; i < pools.length; i += 1) for (let j = i + 1; j < pools.length; j += 1) { const u = new Set([...pools[i], ...pools[j]]); if (u.size <= 12) unionKeys.set([...u].sort((a, b) => a - b).join(","), u); }
    const reported = [];
    for (const P0 of [...unionKeys.values()].sort((a, b) => a.size - b.size)) {
      let need = 0; for (const it of items) if (it.pool.every((t) => P0.has(t))) need += it.h;
      let capSum = 0; for (const t of P0) capSum += cap[t];
      if (need > capSum && !reported.some((R) => [...R].every((t) => P0.has(t)))) { reported.push(P0); const names = [...new Set([...P0].map((t) => T[t].dept))].join("·"); issues.push({ code: "teacher-capacity", target: names, need, capacity: capSum, teachers: P0.size, message: `${names} 교사 ${P0.size}명: 맡아야 할 시수 ${need} > 쓸 수 있는 칸 ${capSum}` }); }
    }
    // 5) 학년 반 수업 칸: 한 학년의 블록이 차지하는 시간에는 그 학년 반 수업 교사가 다른 학년만 가르칠 수 있음 → 교사 1명(후보 1명) 수업 시수 ≤ 그 교사 용량
    for (let t = 0; t < NT; t += 1) {
      let need = 0; for (const it of items) if (it.pool.length === 1 && it.pool[0] === t) need += it.h;
      if (need > cap[t]) issues.push({ code: "single-teacher", target: T[t].name, need, capacity: cap[t], message: `${T[t].name}: 혼자 맡는 시수 ${need} > 쓸 수 있는 칸 ${cap[t]}` });
    }
    // 6) 같은 시간 수요: 한 학년이 모든 반에서 같은 블록을 들으면, 그 블록 시간에 블록 분반 교사 + (다른 학년 반 수업) — 요일별 칸 수 점검
    // 블록 개체가 반에 남기는 반 수업 칸: 블록이 반 칸을 차지하므로 학년 반 수업 교사(후보 1명)의 시수 ≤ 그 학년 반 수업 칸 × 맡는 반 수가 아니라,
    // 반마다: 같은 교사(후보 1명) 수업 시수의 합 ≤ 그 반 반수업 칸(= 쓸 칸 − 블록) — 교사가 여러 반을 맡으면 교사 기준으로 묶음
    for (let t = 0; t < NT; t += 1) {
      const byGrade = new Map();
      for (const p of M.pieces) if (p.pool.length === 1 && p.pool[0] === t) byGrade.set(p.grade, (byGrade.get(p.grade) || 0) + p.hours);
      const secHours = M.entities.reduce((a, e) => a + e.sections.filter((s) => s.pool.length === 1 && s.pool[0] === t).length * e.credit, 0);
      // 학년 반 수업은 그 학년의 블록 시간에 못 들어감: 학년 반 수업 칸 = 쓸 칸 − (그 학년 모든 반이 함께 듣는 블록 학점)
      for (const [g, h] of byGrade) {
        const gCls = M.classes.map((c, ci) => (c.grade === g ? ci : -1)).filter((x) => x >= 0);
        const common = M.entities.filter((e) => e.grade === g && gCls.every((ci) => e.classes.includes(ci))).reduce((a, e) => a + e.credit, 0);
        const slotsG = nFree - common; // 대략(점심·연강 무시)
        if (h > slotsG) issues.push({ code: "grade-slots", target: T[t].name, need: h, capacity: slotsG, message: `${T[t].name}: ${g}학년 반 수업 ${h}시간 > 그 학년 반 수업 칸 ${slotsG}` });
        void secHours;
      }
    }
    return { ok: issues.length === 0, issues, capacity: Array.from(cap) };
  }
  function popcount(m) { let c = 0; while (m) { m &= m - 1; c += 1; } return c; }

  return { solve, evaluate, precheck, prepare, dayMaskInfo, COMP_NAMES };
}
// Worker 소스(앱은 file://로 열리므로 파일 Worker 대신 Blob Worker: class-sections.js의 classSectionsWorkerSource와 같은 방식)
function timetableWorkerSource() {
  return `"use strict";
const api = (${timetableSolverFactory.toString()})();
self.onmessage = function (ev) {
  const m = ev.data || {};
  try {
    if (m.type === "precheck") { const t = performance.now(); const result = api.precheck(m.model, m.options); self.postMessage({ type: "precheck", result, ms: performance.now() - t }); return; }
    if (m.type === "solve") {
      const opts = Object.assign({}, m.options, { onProgress: function (r) { self.postMessage({ type: "progress", progress: r }); } });
      const res = api.solve(m.model, opts);
      self.postMessage({ type: "done", result: res, check: api.evaluate(m.model, res) });
    }
  } catch (e) { self.postMessage({ type: "error", error: String((e && e.message) || e) }); }
};`;
}
if (typeof module === "object" && module.exports) module.exports = Object.assign(timetableSolverFactory(), { timetableSolverFactory, timetableWorkerSource });
