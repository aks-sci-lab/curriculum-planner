# 시간표 CP-SAT 모형: 블록 시간·반 수업 시간·교사(후보 안에서)를 함께 정한다.
# 입력: build3.cjs EXPORT 파일, 출력: SOLUTION 파일(x: 수업→칸, y: 블록 개체→칸, a: 수업 교사, b: 분반 교사)
# 필수: 반 칸 하나, 반 공강 없음(하루 안 빈칸은 뒤쪽만), 교사 겹침·불가·창체, 연강 ≤3(절대 시간, 창체 제외), 점심(A·B 하나 비움), 같은 수업·분반 하루 1회
# 소프트: 점심 앞뒤 공강, 교사 같은 날 같은 과목 몰기, 담임반, 교사 부담 균형
import json, sys, time, os
RELAX = set(filter(None, os.environ.get("RELAX", "").split(",")))  # 진단용: hole, run, lunch, r4, load
from ortools.sat.python import cp_model

inp, outp = sys.argv[1], sys.argv[2]
TL = float(sys.argv[3]) if len(sys.argv) > 3 else 300
M = json.load(open(inp))
NS, P, AP = M["NSLOT"], M["P"], M["AP"]
ND = len(M["days"])
fixed = set(M["fixed"])
absMap = M["absMap"]
C = M["classes"]; T = M["teachers"]; E = M["entities"]; PC = M["pieces"]
# 단계 나눔: PHASE=A → 3학년 반 수업 + 모든 블록 개체·분반 교사만(1·2학년 반 수업은 뒤로), PHASE=B → 전체(FIX 파일의 A 결과를 고정)
PHASE = os.environ.get("PHASE", "")
FIX = json.load(open(os.environ["FIX"])) if os.environ.get("FIX") else None
NOOBJ = os.environ.get("NOOBJ") == "1"
ALLPC = PC
A_GRADES = set(os.environ.get("A_GRADES", "2,3").split(","))
if PHASE == "A": PC = [p for p in PC if C[p["ci"]]["grade"] in A_GRADES]
strict = (lambda ci: C[ci]["grade"] in A_GRADES) if PHASE == "A" else (lambda ci: True)
m = cp_model.CpModel()
free = [s for s in range(NS) if s not in fixed]
day = lambda s: s // P

# 변수
x = {}  # (piece, slot)
for p in PC:
    for s in free: x[p["idx"], s] = m.NewBoolVar("")
y = {}
for e in E:
    for s in free: y[e["idx"], s] = m.NewBoolVar("")
emp = {}
for ci in range(len(C)):
    for s in free: emp[ci, s] = m.NewBoolVar("")
# 반 칸: 블록 개체 + 수업 + 빈칸 = 1
holes = []
entOf = {ci: [] for ci in range(len(C))}
for e in E:
    for ci in e["classes"]: entOf[ci].append(e["idx"])
piecesOf = {ci: [] for ci in range(len(C))}
emp = {k: v for k, v in emp.items()}
for p in PC: piecesOf[p["ci"]].append(p["idx"])
for ci in range(len(C)):
    if not strict(ci):
        for s in free: m.Add(sum(y[e, s] for e in entOf[ci]) <= 1)
        continue
    for s in free:
        m.Add(sum(y[e, s] for e in entOf[ci]) + sum(x[p, s] for p in piecesOf[ci]) + emp[ci, s] == 1)
    # 공강 없음: 빈칸 다음 칸도 빈칸(창체 앞 칸은 빈칸 금지)
    for s in free:
        if not strict(ci): break
        if 'hole' in RELAX: break
        if s % P == P - 1: continue
        nxt = s + 1
        if 'softhole' in RELAX:
            hv = m.NewBoolVar(""); holes.append(hv)
            if nxt in fixed: m.Add(emp[ci, s] <= hv)
            else: m.Add(emp[ci, s] <= emp[ci, nxt] + hv)
        elif nxt in fixed: m.Add(emp[ci, s] == 0)
        else: m.AddImplication(emp[ci, s], emp[ci, nxt])
# 시수·같은 날 1회
for p in PC:
    m.Add(sum(x[p["idx"], s] for s in free) == p["hours"])
    if 'r4' not in RELAX:
        lim = 2 if ('r4tech' in RELAX and p["dept"] == "기술가정") else 1
        for d in range(ND): m.Add(sum(x[p["idx"], s] for s in free if day(s) == d) <= lim)
for e in E:
    m.Add(sum(y[e["idx"], s] for s in free) == e["credit"])
    for d in range(ND): m.Add(sum(y[e["idx"], s] for s in free if day(s) == d) <= 1)
# 교사 선택과 교사 칸 사용
occ = {(t, a): [] for t in range(len(T)) for a in range(ND * AP)}
tsub = {}  # (t, subject, day) → terms
load = {t: [] for t in range(len(T))}
hrBonus = []
gradeOfClass = [c["grade"] for c in C]
choose = {}
for p in PC:
    g = gradeOfClass[p["ci"]]
    pool = p["pool"]
    if len(pool) == 1:
        t = pool[0]
        for s in free:
            a = absMap[g][s]; occ[t, a].append(x[p["idx"], s]); tsub.setdefault((t, p["subject"], day(s)), []).append(x[p["idx"], s])
        load[t].append(p["hours"])
        if p["hr"] == t: hrBonus.append(1)
    else:
        av = {t: m.NewBoolVar("") for t in pool}
        choose["p", p["idx"]] = av
        m.AddExactlyOne(av.values())
        m.AddHint(av[p["init"]], 1) if p["init"] in av else None
        for t in pool: load[t].append(p["hours"] * av[t])
        if p["hr"] in av: hrBonus.append(av[p["hr"]])
        for s in free:
            vs = []
            for t in pool:
                v = m.NewBoolVar(""); m.AddImplication(v, av[t]); vs.append(v)
                a = absMap[g][s]; occ[t, a].append(v); tsub.setdefault((t, p["subject"], day(s)), []).append(v)
            m.Add(sum(vs) == x[p["idx"], s])
for e in E:
    g = e["grade"]
    for sec in e["sections"]:
        pool = sec["pool"]
        if len(pool) == 1:
            t = pool[0]
            for s in free: occ[t, absMap[g][s]].append(y[e["idx"], s])
            load[t].append(e["credit"])
        else:
            bv = {t: m.NewBoolVar("") for t in pool}
            choose["s", sec["idx"]] = bv
            m.AddExactlyOne(bv.values())
            if sec["init"] in bv: m.AddHint(bv[sec["init"]], 1)
            for t in pool: load[t].append(e["credit"] * bv[t])
            for s in free:
                vs = []
                for t in pool:
                    v = m.NewBoolVar(""); m.AddImplication(v, bv[t]); vs.append(v)
                    occ[t, absMap[g][s]].append(v)
                m.Add(sum(vs) == y[e["idx"], s])
# 같은 반·같은 과목을 여러 교사가 나눠 맡는 조각(통합사회 등)은 서로 다른 교사
from collections import defaultdict
same = defaultdict(list)
for p in PC:
    if ("p", p["idx"]) in choose and p.get("sameKey"): same[p["sameKey"]].append(choose["p", p["idx"]])
for key, lst in same.items():
    if len(lst) < 2: continue
    for t in set().union(*[set(d.keys()) for d in lst]): m.Add(sum(d[t] for d in lst if t in d) <= 1)
# 교사 겹침·불가·연강·점심
o = {}
lunchPen = []
for t in range(len(T)):
    blocked = set(T[t]["blocked"])
    for a in range(ND * AP):
        terms = occ[t, a]
        if not terms: o[t, a] = 0; continue
        if a in blocked: m.Add(sum(terms) == 0); o[t, a] = 0; continue
        m.Add(sum(terms) <= 1)
        o[t, a] = sum(terms)
    for d in range(ND):
        base = d * AP
        for k in range(AP - 3):
            win = [o[t, base + k + j] for j in range(4)]
            if 'run' not in RELAX and any(not isinstance(w, int) for w in win): m.Add(sum(win) <= 3)
        A, B = o[t, base + 3], o[t, base + 4]
        if 'lunch' not in RELAX and (not isinstance(A, int) or not isinstance(B, int)): m.Add(A + B <= 1)
        # 점심 앞뒤 공강(소프트): 점심 A면 3·B, 점심 B면 A·5
        la = m.NewBoolVar("")
        if not isinstance(A, int): m.Add(A == 0).OnlyEnforceIf(la)
        if not isinstance(B, int): m.Add(B == 0).OnlyEnforceIf(la.Not())
        pen = m.NewIntVar(0, 2, "")
        m.Add(pen >= o[t, base + 2] + o[t, base + 4] - 2 * (1 - la)) if not all(isinstance(v, int) for v in (o[t, base + 2], o[t, base + 4])) else None
        m.Add(pen >= o[t, base + 3] + o[t, base + 5] - 2 * la) if not all(isinstance(v, int) for v in (o[t, base + 3], o[t, base + 5])) else None
        lunchPen.append(pen)
# 규칙 3(교사 기준): 같은 날 같은 과목 2회 이상이면 초과분
r3 = []
for (t, subj, d), terms in tsub.items():
    if len(terms) < 2: continue
    ex = m.NewIntVar(0, len(terms), "")
    m.Add(ex >= sum(terms) - 1)
    r3.append(ex)
# 부담 균형: 교과 평균에서 벗어난 만큼
dev = []
avg = M["deptAvg"]
for t in range(len(T)):
    if not load[t]: continue
    L = m.NewIntVar(0, 40, ""); m.Add(L == sum(load[t]))
    a0 = int(round(avg.get(T[t]["dept"], 16)))
    dv = m.NewIntVar(0, 40, ""); m.AddAbsEquality(dv, L - a0); dev.append(dv)
    if 'load' not in RELAX: m.Add(L <= 22)
W_LUNCH, W_R3, W_DEV, W_HR = 3, 2, 2, 3
# A 결과 고정
if FIX:
    for e in E:
        for s in free: m.Add(y[e["idx"], s] == (1 if s in FIX["y"][e["idx"]] else 0))
    secs0 = sorted([sec for e in E for sec in e["sections"]], key=lambda q: q["idx"])
    for sec in secs0:
        if FIX.get("b") and ("s", sec["idx"]) in choose: m.Add(choose["s", sec["idx"]][FIX["b"][sec["idx"]]] == 1)
    fx = {pid: (sl, t) for pid, sl, t in FIX.get("pieces", [])}
    for p in PC:
        if p["idx"] in fx:
            sl, t = fx[p["idx"]]
            for s in free: m.Add(x[p["idx"], s] == (1 if s in sl else 0))
            if ("p", p["idx"]) in choose: m.Add(choose["p", p["idx"]][t] == 1)
if NOOBJ and holes: m.Minimize(sum(holes))
if not NOOBJ: m.Minimize(1000 * sum(holes) + W_LUNCH * sum(lunchPen) + W_R3 * sum(r3) + W_DEV * sum(dev) - W_HR * sum(hrBonus))
# 처음 값 힌트: 블록 시간
for e in E:
    for s in free: m.AddHint(y[e["idx"], s], 1 if s in e["init"] else 0)
sv = cp_model.CpSolver()
sv.parameters.max_time_in_seconds = TL
sv.parameters.num_workers = 8
t0 = time.time()
st = sv.Solve(m)
res = {"status": sv.StatusName(st), "seconds": round(time.time() - t0, 1), "objective": sv.ObjectiveValue() if st in (cp_model.OPTIMAL, cp_model.FEASIBLE) else None,
       "bound": sv.BestObjectiveBound() if st in (cp_model.OPTIMAL, cp_model.FEASIBLE) else None, "vars": len(m.Proto().variables), "constraints": len(m.Proto().constraints)}
if st in (cp_model.OPTIMAL, cp_model.FEASIBLE):
    res["pieces"] = [[p["idx"], [s for s in free if sv.Value(x[p["idx"], s])], (next((t for t, v in choose["p", p["idx"]].items() if sv.Value(v)), None) if ("p", p["idx"]) in choose else p["pool"][0])] for p in PC]
    res["x"] = [[s for s in free if sv.Value(x[p["idx"], s])] for p in PC] if PHASE != "A" else None
    res["y"] = [[s for s in free if sv.Value(y[e["idx"], s])] for e in E]
    res["a"] = None if PHASE == "A" else [next((t for t, v in choose["p", p["idx"]].items() if sv.Value(v)), None) if ("p", p["idx"]) in choose else p["pool"][0] for p in PC]
    secs = sorted([sec for e in E for sec in e["sections"]], key=lambda s: s["idx"])
    res["b"] = [next((t for t, v in choose["s", s["idx"]].items() if sv.Value(v)), None) if ("s", s["idx"]) in choose else s["pool"][0] for s in secs]
    if NOOBJ: pass
    res["holes"] = sum(sv.Value(v) for v in holes)
    res["lunchPen"] = sum(sv.Value(v) for v in lunchPen); res["r3"] = sum(sv.Value(v) for v in r3); res["dev"] = sum(sv.Value(v) for v in dev); res["hr"] = sum(sv.Value(v) if not isinstance(v, int) else v for v in hrBonus)
json.dump(res, open(outp, "w"))
print(json.dumps({k: v for k, v in res.items() if k not in ("x", "y", "a", "b")}))
