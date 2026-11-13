# 교사 후보 묶음 기준 시수 점검: 후보가 P의 부분집합인 수업·분반 시수 합 ≤ 22 × |P|
import json, collections
D = "../cp/g"
combos = [f"{g}k{k}" for g in ["G3c","G4c","G5c","G3t","G4t","G5t"] for k in [2,3,4,5]] + [f"C2k{k}" for k in [2,3,4,5]]
out = {}
for c in combos:
    for s in ["1","2"]:
        M = json.load(open(f"{D}/in-{c}-{s}.json")); T = M["teachers"]
        items = [(frozenset(p["pool"]), p["hours"]) for p in M["pieces"]] + [(frozenset(x["pool"]), e["credit"]) for e in M["entities"] for x in e["sections"]]
        pools = set(p for p, _ in items)
        bad = []
        for P in pools:
            h = sum(hh for q, hh in items if q <= P)
            if h > 22 * len(P): bad.append((", ".join(sorted(set(T[t]["dept"] for t in P))), len(P), h, 22 * len(P)))
        out[f"{c}-{s}"] = sorted(set(bad), key=lambda x: -(x[2] - x[3]))
for k, v in out.items(): print(k, "통과" if not v else "걸러짐 " + "; ".join(f"{d} 교사{n}명 {h}>{cap}" for d, n, h, cap in v[:3]))
json.dump({k: v for k, v in out.items()}, open(f"{D}/precheck-b.json", "w"), ensure_ascii=False)
