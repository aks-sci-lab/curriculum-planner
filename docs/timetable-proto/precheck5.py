# 반군 G·엇갈림 k 조합 사전 추정(풀이 전): 분반 수·인원·블록 안 교사 매칭·교과 시수 용량
import json, sys, os, collections
D = "../cp/g"
combos = [f"{g}k{k}" for g in ["G3c","G4c","G5c","G3t","G4t","G5t"] for k in [2,3,4,5]]
def match(secs, pools):
    # 이분 매칭(분반 → 교사)
    own = {}
    def try_(s, seen):
        for t in pools[s]:
            if t in seen: continue
            seen.add(t)
            if t not in own or try_(own[t], seen): own[t] = s; return True
        return False
    return sum(1 for s in secs if try_(s, set()))
rows = []
for c in combos:
    S = json.load(open(f"{D}/struct-{c}.json"))
    for sem in S["semesters"]:
        semN = sem["semester"]; M = json.load(open(f"{D}/in-{c}-{semN}.json"))
        T = M["teachers"]
        st = sem["structure"]
        pools = {}; ent_secs = collections.defaultdict(list)
        for e in M["entities"]:
            for s in e["sections"]: pools[s["idx"]] = s["pool"]; ent_secs[e["idx"]].append(s["idx"])
        secsOut = sem["sections"]
        stagE = [e for e in M["entities"] if e["grade"] == "3" and any(ch in e["label"] for ch in "가나다라마")]
        deficit = 0; worst = []
        for e in M["entities"]:
            ss = ent_secs[e["idx"]]; m = match(ss, pools)
            if m < len(ss): deficit += len(ss) - m; worst.append(f'{e["label"]} {len(ss)}분반/매칭{m}')
        sizes = [len(s["students"]) for s in secsOut if s["grade"] == "3"]
        stagSizes = [len(s["students"]) for s in secsOut if s["grade"] == "3" and "(" in s["blockId"]]
        small = sum(1 for x in sizes if x < 10)
        # 블록 개체(반군)별 분반 수·과목 수
        perEnt = []
        for e in stagE:
            ss = [s for s in secsOut if s["entity"] == e["idx"]]
            perEnt.append((e["label"], len(e["classes"]), len(ss), len(set(s["course"] for s in ss)), round(sum(len(s["students"]) for s in ss)/max(1,len(ss)),1)))
        # 교과(군)별 시수 수요 vs 교사 × 22
        need = collections.Counter(); 
        fam = lambda d: d.split("-")[0] if d.startswith(("과학","사회")) else d
        for p in M["pieces"]: need[fam(p["dept"])] += p["hours"]
        for e in M["entities"]:
            for s in e["sections"]: need[fam(next((x["dept"] for x in secsOut if x["id"] == s["id"]), ""))] += e["credit"]
        capT = collections.Counter(fam(t["dept"]) for t in T if not t["id"].startswith("v-"))
        capT["기술가정"] += 1  # 증원 교사는 기술가정도 맡음(정보 수에도 들어 있음)
        over = {d: (h, capT[d]*22) for d, h in need.items() if capT[d] and h > capT[d]*22}
        rows.append(dict(combo=c, sem=semN, groups=st["spec"]["kind"], k=st["spec"]["k"], sections=f'{st["sectionsBefore"]}→{st["sectionsAfter"]}', added=st["sectionsAfter"]-st["sectionsBefore"],
            moved=st["studentsMoved"], small=small, minStag=min(stagSizes) if stagSizes else None, avgStag=round(sum(stagSizes)/max(1,len(stagSizes)),1),
            deficit=deficit, worst=worst[:3], over=over, perEnt=perEnt))
json.dump(rows, open(f"{D}/precheck.json","w"), ensure_ascii=False)
for r in rows:
    ok = r["deficit"] == 0 and not r["over"]
    print(f'{r["combo"]:7} s{r["sem"]} 분반 {r["sections"]:8} +{r["added"]:3} 이동 {r["moved"]:4} 10명미만 {r["small"]:3} 엇갈림분반 평균 {r["avgStag"]:5} 최소 {r["minStag"]} | 블록매칭부족 {r["deficit"]} {r["worst"][:2]} | 시수초과 {r["over"]} → {"통과" if ok else "걸러짐"}')
