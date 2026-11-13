"use strict";
// 시간표 시제품: 앱의 5단계·6단계 결과(plan-input.json)로 반별·교사별 주간 시간표를 만든다(앱 코드와 무관한 독립 스크립트).
// 1) 반별 주간 수업 목록  2) 교사 배정  3) 담금질(SA) 배치  4) 점검  →  out/timetable.json
const fs = require("fs");
const path = require("path");
const IN = require("./plan-input.json");
const OUT_DIR = path.resolve(__dirname, "../out");
const VIRTUAL_NAMES = { "기술가정": "순회·강사" }; // 사용자 규칙: 교사 0명 교과는 가상 순회·강사
fs.mkdirSync(OUT_DIR, { recursive: true });

const SEED = Number(process.env.SEED || 7);
const REMEDY = false; // (v1의 가상 교사 보완안은 버림)
const STAFF = Number(process.env.STAFF ?? 1); // 1 = 정보·기술 증원 1명, 2 = 증원 1명 + 기술·가정 순회강사 1명(최소 보완 확인용)
let rngState = SEED >>> 0 || 1;
function rand() { rngState ^= rngState << 13; rngState >>>= 0; rngState ^= rngState >>> 17; rngState ^= rngState << 5; rngState >>>= 0; return rngState / 4294967296; }
const randInt = (n) => Math.floor(rand() * n);
const HOMEROOM = new Map(); // 반 → 가상 담임 교사 id

const S = IN.settings;
const DAYS = String(S.gridDays || "월,화,수,목,금").split(",").map((x) => x.trim()).filter(Boolean);
const P = Number(S.gridPeriods) || 7;
const NSLOT = DAYS.length * P;
const slotOf = (day, period) => DAYS.indexOf(day) * P + (Number(period) - 1);
const slotName = (slot) => `${DAYS[Math.floor(slot / P)]}${(slot % P) + 1}`;
const parseTimes = (text) => String(text || "").split(/[,\s]+/).map((t) => t.trim()).filter(Boolean)
  .map((t) => { const m = t.match(/^(.)[:]?(\d+)$/); return m && DAYS.includes(m[1]) ? slotOf(m[1], m[2]) : null; }).filter((x) => x !== null);
const blockSlots = (block) => (block.times || []).map((t) => (typeof t === "string" ? parseTimes(t)[0] : slotOf(t.day, t.period))).filter((x) => x !== undefined);

const FIXED = (S.fixedSlots || []).map((f) => ({ label: f.label, slots: parseTimes(f.times), allTeachers: Boolean(f.allTeachers) }));
const FIXED_SLOTS = new Set(FIXED.flatMap((f) => f.slots));
const FIXED_TEACHER_SLOTS = new Set(FIXED.filter((f) => f.allTeachers).flatMap((f) => f.slots));
// 절대 시간 축(하루 8칸): 1, 2, 3, A, B, 5, 6, 7. 3학년은 3교시 뒤 점심(A = 점심, B = 4교시), 1·2학년은 4교시 뒤 점심(A = 4교시, B = 점심).
const ABS_LABELS = ["1", "2", "3", "A", "B", "5", "6", "7"];
const AP = ABS_LABELS.length;
const NABS = DAYS.length * AP;
const LUNCH_ABS = { "1": 4, "2": 4, "3": 3 }; // 하루 안 절대 칸 번호
const absOf = (grade, slot) => { const d = Math.floor(slot / P); const p = (slot % P) + 1; return d * AP + (p <= 3 ? p - 1 : p === 4 ? (grade === "3" ? 4 : 3) : p); };
const ABS_MAP = Object.fromEntries(["1", "2", "3"].map((g) => [g, Array.from({ length: NSLOT }, (_, slot) => absOf(g, slot))]));
const absName = (a) => `${DAYS[Math.floor(a / AP)]}${ABS_LABELS[a % AP]}`;
// 교사 불가 시간은 교시로 적혀 있다: 4교시는 학년마다 A·B가 달라 둘 다 막는다.
const unavailAbs = (slot) => ((slot % P) + 1 === 4 ? [absOf("1", slot), absOf("3", slot)] : [absOf("1", slot)]);
const FIXED_TEACHER_ABS = new Set([...FIXED_TEACHER_SLOTS].map((slot) => absOf("1", slot)));
const DEPT_NAME = (id) => IN.departmentNames[id] || id;
const CLASS_COUNTS = IN.classCounts; // 내년 학급 수(5단계 = 4단계 기준)
const ROOM_LIMITS = { "과학탐구실험": 2 }; // 가정: 과학실 2곳(settings.rooms가 비어 있어 시제품 가정값)

// ---------- 교사 ----------
const teachers = S.teachers.map((t) => ({ id: t.id, name: t.name, dept: t.department, extra: [], unavailable: new Set((t.unavailable || []).flatMap(parseTimes).flatMap(unavailAbs)), reason: t.reason || "", virtual: false }));
if (STAFF >= 1) teachers.push({ id: "t-정보기술-증원", name: "정보·기술 증원", dept: "정보", extra: ["기술가정"], unavailable: new Set(), reason: "", virtual: false, added: true });
if (STAFF >= 2) teachers.push({ id: "t-기술-순회", name: "기술·가정 순회강사", dept: "기술가정", extra: [], unavailable: new Set(), reason: "", virtual: false, added: true });
const teacherById = new Map(teachers.map((t) => [t.id, t]));
function virtualTeacher(dept, why) {
  const id = `v-${dept}`;
  if (!teacherById.has(id)) {
    const t = { id, name: `${DEPT_NAME(dept)}(${why})`, dept, extra: [], unavailable: new Set(), reason: "", virtual: true };
    teachers.push(t); teacherById.set(id, t);
  }
  return teacherById.get(id);
}

// 교과(세부) 이름 → 교사 목록. 공통(과학-공통·사회-공통)은 5단계 배분 메모로 세부 교과에 나눈다.
const poolOf = (dept) => teachers.filter((t) => (t.dept === dept || t.extra.includes(dept)) && !t.virtual);
const familyOf = (dept) => dept.replace(/-.*$/, "");

// 5단계 배분 메모 '통과10 · 과탐실3 · 융과4' → { 세부교과: { 줄임말: 시수 } }
function allocationQuota(semester) {
  const notes = IN.hoursSettings.allocationNotes || {};
  const quota = {}; // 줄임말 → [{ dept, hours }]
  for (const [dept, bySem] of Object.entries(notes)) {
    for (const token of String(bySem?.[semester] || "").split("·").map((x) => x.trim()).filter(Boolean)) {
      const m = token.match(/^(.+?)(\d+)$/);
      if (!m) continue;
      (quota[m[1]] ||= []).push({ dept, hours: Number(m[2]) });
    }
  }
  return quota;
}

// 교사 하루(절대 칸 8개 비트) 평가: 연강·점심·점심 앞뒤 공강·하루 시수.
function dayMaskInfo(m) {
  let run = 0; let longest = 0; let excess = 0; let count = 0;
  for (let k = 0; k < AP; k += 1) { if (m & (1 << k)) { run += 1; count += 1; longest = Math.max(longest, run); } else { if (run > 3) excess += run - 3; run = 0; } }
  if (run > 3) excess += run - 3;
  const A = 3, B = 4; const on = (k) => (m >> k) & 1;
  const noLunch = on(A) && on(B);
  let nb = Infinity; let lunch = -1;
  for (const L of [A, B]) { if (on(L)) continue; const n = L === A ? on(2) + on(B) : on(A) + on(5); if (n < nb) { nb = n; lunch = L; } }
  return { count, longest, excess, noLunch, nb: nb === Infinity ? 2 : nb, lunch };
}
function dayMaskCost(m, W) {
  if (!m) return 0;
  const x = dayMaskInfo(m);
  return x.excess * W.run + (x.noLunch ? W.lunch : x.nb * W.nb) + Math.max(0, x.count - 6) * W.tday;
}

// ---------- 한 학기 만들기 ----------
function buildSemester(semester) {
  const issues = [];
  const quota = allocationQuota(semester);
  const takeQuota = (subject, hours) => {
    // 공통 과목 시수를 배분 메모 순서대로 세부 교과에 떼어 준다. 남는 몫이 없으면 null.
    const list = quota[IN.shortNames[subject] || subject];
    if (!list) return null;
    const pick = list.find((q) => q.hours >= hours) || list.find((q) => q.hours > 0);
    if (!pick) return null;
    const used = Math.min(hours, pick.hours);
    pick.hours -= used;
    return { dept: pick.dept, hours: used };
  };

  // 반
  const classes = [];
  for (const grade of ["1", "2", "3"]) {
    for (let c = 1; c <= (CLASS_COUNTS[grade] || 0); c += 1) {
      classes.push({ id: `${grade}-${c}`, grade, no: c, cells: Array(NSLOT).fill(null), lessons: [], planned: { 지정: 0, 학급단위: 0, 이동: 0, 창체: 0 } });
    }
  }
  const classById = new Map(classes.map((c) => [c.id, c]));
  const classesOf = (grade) => classes.filter((c) => c.grade === grade);

  // 창체(고정)
  for (const c of classes) for (const f of FIXED) for (const slot of f.slots) { c.cells[slot] = { kind: "fixed", label: f.label }; c.planned.창체 += 1; }

  // 이동수업 블록(6단계, 블록 시간 고정)
  const sections = []; // { id, groupKey, grade(내년), category, blockId, slots, course, credit, teacherId, size, dept }
  const blockCells = []; // 학년별 블록 시간
  const groups = IN.groups.filter((g) => g.semester === semester);
  for (const g of groups) {
    const r = g.result;
    if (!r) { issues.push({ level: "error", text: `${g.key}: 6단계 결과 없음` }); continue; }
    const courseByKey = new Map(g.courses.map((c) => [c.key, c]));
    for (const block of r.blocks || []) {
      if (!(block.sectionIds || []).length) continue; // 학급 단위만 있는 그룹(택1)은 블록 없음
      const slots = blockSlots(block);
      const credits = new Set();
      for (const id of block.sectionIds) {
        const s = r.sections.find((x) => x.id === id);
        const course = courseByKey.get(s.courseKey) || {};
        credits.add(course.credits);
        sections.push({ id: `${g.key}|${s.id}`, sid: s.id, groupKey: g.key, grade: g.targetGrade, category: g.category, blockId: block.id, slots,
          abs: slots.map((sl) => absOf(g.targetGrade, sl)), course: s.courseName, courseKey: s.courseKey, credit: course.credits, teacherId: s.teacherId || r.teacherOf?.[s.id] || "", teacherFilled: false, size: s.size,
          dept: course.department || "", room: s.roomName || "" });
      }
      if (credits.size > 1 || [...credits][0] !== slots.length) issues.push({ level: "warning", text: `${g.category} ${block.letter}블록: 블록 시간 ${slots.length}칸 ≠ 과목 학점 ${[...credits].join("/")}` });
      blockCells.push({ grade: g.targetGrade, groupKey: g.key, category: g.category, blockId: block.id, slots, sectionCount: block.sectionIds.length });
      for (const c of classesOf(g.targetGrade)) {
        for (const slot of slots) {
          if (c.cells[slot]) { issues.push({ level: "error", text: `${c.id} ${slotName(slot)}: 블록 시간이 ${c.cells[slot].label}과 겹침` }); continue; }
          c.cells[slot] = { kind: "block", label: `${g.category.replace(/^\d-\d\s*/, "")} ${block.id}블록`, category: g.category, blockId: block.id, groupKey: g.key };
          c.planned.이동 += 1;
        }
      }
    }
  }

  // 학교지정 과목(교차집중은 학급 배분대로: 1학기 앞 과목 = 앞 반들, 2학기는 서로 바꿈)
  const items = IN.items.filter((i) => i.semester === semester);
  const entriesOf = (grade) => IN.entries[grade]?.list || [];
  const crossInfo = (item) => entriesOf(item.grade).find((e) => e.semester === item.semester && e.subject === item.subject && e.kind === "지정");
  const firstSemClasses = (item) => IN.items.find((x) => x.grade === item.grade && x.semester === "1" && x.subject === item.subject)?.classes;
  const designatedPieces = [];
  for (const item of items.filter((i) => i.kind === "지정" && i.classes > 0)) {
    const list = classesOf(item.grade);
    let targets = list;
    const entry = crossInfo(item);
    if (entry && entry.names > 1) {
      // 같은 행(rowIndex)의 과목 순서: nameIndex 0 = 1학기에 앞 반들
      const n = list.length;
      const partner = entriesOf(item.grade).find((e) => e.rowIndex === entry.rowIndex && e.semester === "1" && e.nameIndex === 0);
      const k0 = IN.items.find((x) => x.grade === item.grade && x.semester === "1" && x.subject === partner?.subject)?.classes ?? Math.ceil(n / 2);
      const front = list.slice(0, k0); const back = list.slice(k0);
      const firstHalf = entry.nameIndex === 0;
      targets = (semester === "1") === firstHalf ? front : back;
      if (targets.length !== item.classes) issues.push({ level: "warning", text: `${item.grade}학년 ${item.subject}: 교차집중 배분 ${targets.length}반 ≠ 5단계 개설반 ${item.classes}` });
    } else if (item.classes !== list.length) {
      issues.push({ level: "warning", text: `${item.grade}학년 ${item.subject}: 개설반 ${item.classes} ≠ 학급 수 ${list.length} → 앞 반부터 ${item.classes}반` });
      targets = list.slice(0, item.classes);
    }
    for (const c of targets) designatedPieces.push({ classId: c.id, grade: item.grade, subject: item.subject, hours: item.credit, dept: item.department, kind: "지정" });
  }
  // 학급 단위 과목(6단계 class-unit: 내년 반마다 한 과목)
  for (const g of groups) {
    for (const [room, courseKey] of Object.entries(g.unitAssign || {})) {
      if (!courseKey) continue;
      const course = g.courses.find((c) => c.key === courseKey);
      const c = classById.get(`${g.targetGrade}-${room}`);
      if (!c || !course) { issues.push({ level: "error", text: `${g.key} 내년 ${room}반 학급 단위 과목 ${courseKey}: 반/과목을 찾지 못함` }); continue; }
      designatedPieces.push({ classId: c.id, grade: g.targetGrade, subject: course.name, hours: course.credits, dept: course.department, kind: "학급단위", category: g.category });
    }
  }
  // 5단계 선택과목 개설반과 6단계(블록 분반 + 학급 단위 반) 비교
  for (const item of items.filter((i) => i.kind === "선택" && i.classes > 0)) {
    const nm = (x) => String(x).replace(/\s+/g, "").replace(/Ⅰ/g, "1").replace(/Ⅱ/g, "2").replace(/\(\d학기\)$/, "");
    const inBlocks = sections.filter((s) => s.grade === item.grade && nm(s.course) === nm(item.subject)).length;
    const inUnits = designatedPieces.filter((p) => p.kind === "학급단위" && p.grade === item.grade && p.subject === item.subject).length;
    if (inBlocks + inUnits !== item.classes) issues.push({ level: "warning", text: `${item.grade}학년 ${item.subject}: 5단계 개설반 ${item.classes} ≠ 6단계 분반 ${inBlocks} + 학급 단위 ${inUnits}` });
  }

  // 공통 교과 지정 과목 → 세부 교과로 나눔(반 순서대로 채우고, 경계 반은 시수를 쪼갬)
  const pieces = [];
  const deferred = [];
  for (const piece of designatedPieces) {
    if (!/-공통$/.test(piece.dept)) { pieces.push(piece); continue; }
    if (!quota[IN.shortNames[piece.subject] || piece.subject]) { deferred.push(piece); continue; } // 배분 메모 없음 → 아래 사용자 규칙
    let left = piece.hours;
    while (left > 0) {
      const got = takeQuota(piece.subject, left);
      if (!got) { pieces.push({ ...piece, hours: left, dept: piece.dept, unallocated: true }); break; }
      pieces.push({ ...piece, hours: got.hours, dept: got.dept, commonFrom: piece.dept });
      left -= got.hours;
    }
  }

  // ---------- 교사 배정 ----------
  const load = new Map(teachers.map((t) => [t.id, 0]));
  const preps = new Map(teachers.map((t) => [t.id, new Set()]));
  const busy = new Map(teachers.map((t) => [t.id, new Set()])); // 블록 시간
  const ensureT = (t) => { if (!load.has(t.id)) { load.set(t.id, 0); preps.set(t.id, new Set()); busy.set(t.id, new Set()); } };
  for (const s of sections) {
    if (!s.teacherId) continue;
    load.set(s.teacherId, (load.get(s.teacherId) || 0) + s.credit);
    preps.get(s.teacherId)?.add(`${s.grade}|${s.course}`);
    for (const slot of s.abs) busy.get(s.teacherId)?.add(slot);
  }
  // 6단계에서 교사가 비어 있던 분반(공통 교과 등): 5단계 배분 메모에 몫이 남은 세부 교과 중 블록 시간에 빈 교사(시제품 보충).
  // 그런 교사가 없으면 같은 교과군의 빈 교사, 그래도 없으면 가상 교사(= 그 시간에 교사가 모자람).
  for (const s of sections.filter((x) => !x.teacherId)) {
    const short = IN.shortNames[s.course.replace(/\s*\(\d학기\)$/, "")] || s.course;
    const qlist = /-공통$/.test(s.dept) ? (quota[short] || []) : [];
    const fam = familyOf(s.dept);
    const free = (t) => s.abs.every((slot) => !busy.get(t.id).has(slot) && !t.unavailable.has(slot) && !FIXED_TEACHER_ABS.has(slot));
    const quotaDepts = qlist.filter((q) => q.hours >= s.credit).map((q) => q.dept);
    let how = "5단계 배분 메모 기준";
    let cands = teachers.filter((t) => !t.virtual && (qlist.length ? quotaDepts.includes(t.dept) : t.dept === s.dept) && free(t));
    if (!cands.length) { how = qlist.length ? "같은 교과군(배분 메모 세부 교과는 그 시간에 모두 수업 중)" : "배분 메모 없음 → 같은 교과군 중 그 블록 시간에 비고 예상 시수가 적은 교사"; cands = teachers.filter((t) => !t.virtual && familyOf(t.dept) === fam && free(t)); }
    const share = (t) => designatedPieces.filter((p) => p.dept === t.dept).reduce((a, p) => a + p.hours, 0) / Math.max(1, poolOf(t.dept).length);
    cands.sort((a, b) => (load.get(a.id) + share(a)) - (load.get(b.id) + share(b)));
    let t = cands[0];
    if (!t) {
      // 맞바꿈: 교과군 교사 X가 이 블록 시간에 맡은 분반(막는 분반)을 같은 교과의 다른 빈 교사에게 넘길 수 있으면 X가 이 분반을 맡는다.
      const freeFor = (y, sec, except) => y.id !== except && sec.abs.every((slot) => !busy.get(y.id).has(slot) && !y.unavailable.has(slot) && !FIXED_TEACHER_ABS.has(slot));
      const move = (sec, from, to) => {
        for (const slot of sec.abs) { busy.get(from.id).delete(slot); busy.get(to.id).add(slot); }
        load.set(from.id, load.get(from.id) - sec.credit); load.set(to.id, load.get(to.id) + sec.credit);
        preps.get(to.id).add(`${sec.grade}|${sec.course}`); sec.teacherId = to.id; sec.teacherSwapped = true;
      };
      outer: for (const x of teachers.filter((t2) => !t2.virtual && familyOf(t2.dept) === fam).sort((a, b) => load.get(a.id) - load.get(b.id))) {
        const blockers = sections.filter((o) => o !== s && o.teacherId === x.id && o.abs.some((slot) => s.abs.includes(slot)));
        if (!blockers.length || x.unavailable.size && s.abs.some((slot) => x.unavailable.has(slot))) continue;
        const plan = [];
        for (const b of blockers) {
          for (const slot of b.abs) busy.get(x.id).delete(slot);
          const y = teachers.filter((t2) => !t2.virtual && t2.dept === x.dept && freeFor(t2, b, x.id) && !plan.some((pl) => pl.to === t2 && pl.b.abs.some((sl) => b.abs.includes(sl)))).sort((a, b2) => load.get(a.id) - load.get(b2.id))[0];
          for (const slot of b.abs) busy.get(x.id).add(slot);
          if (!y) continue outer;
          plan.push({ b, to: y });
        }
        for (const pl of plan) { move(pl.b, x, pl.to); issues.push({ level: "info", text: `교사 맞바꿈: ${pl.b.category} ${pl.b.blockId}블록 ${pl.b.course} ${x.name} → ${pl.to.name}(${x.name}이 ${s.category} ${s.blockId}블록 ${s.course}을 맡도록)` }); }
        t = x; how = `교사 맞바꿈(${plan.map((pl) => pl.b.category + " " + pl.b.blockId + "블록 " + pl.b.course + " → " + pl.to.name).join(", ")})`;
        break;
      }
    }
    if (!t) {
      how = "그 블록 시간에 같은 교과군 교사가 모두 수업 중";
      for (let k = 1; ; k += 1) { t = virtualTeacher(`${fam}-추가${k}`, `블록 시간 교사 부족 ${k}`); ensureT(t); if (free(t)) break; }
    }
    const q = qlist.find((x) => x.dept === t.dept && x.hours >= s.credit);
    if (q) q.hours -= s.credit;
    s.teacherId = t.id; s.teacherFilled = true;
    load.set(t.id, load.get(t.id) + s.credit); preps.get(t.id).add(`${s.grade}|${s.course}`);
    for (const slot of s.abs) busy.get(t.id).add(slot);
    issues.push({ level: t.virtual ? "warning" : "info", text: `${s.category} ${s.blockId}블록 ${s.sid}: 6단계에서 교사가 비어 있어 ${t.virtual ? "" : DEPT_NAME(t.dept) + " "}${t.name}에게 보충 배정(${how})` });
  }
  // 배분 메모가 없는 공통 과목(사용자 규칙): 통합과학은 세부 전공(교사 있는 교과)에 반 수를 똑같이, 나머지 반은 1인당 시수가 낮은 전공부터.
  // 과학탐구실험은 그 반 통합과학과 같은 전공. 그 밖(통합사회 등)은 반마다 1인당 예상 시수가 가장 낮은 세부 교과.
  const projected = new Map();
  const deptTeachers = (dept) => poolOf(dept).length;
  const addProj = (dept, h) => projected.set(dept, (projected.get(dept) || 0) + h);
  for (const t of teachers) if (load.get(t.id)) addProj(t.dept, load.get(t.id));
  for (const p of pieces) addProj(p.dept, p.hours);
  const perTeacher = (dept) => (projected.get(dept) || 0) / Math.max(1, deptTeachers(dept));
  const subDepts = (dept) => [...new Set(teachers.filter((t) => !t.virtual && familyOf(t.dept) === familyOf(dept) && !/-공통$/.test(t.dept)).map((t) => t.dept))];
  const deptOfClass = new Map();
  const commonSplits = {};
  const bySubject = new Map();
  for (const p of deferred) { const k = p.grade + "|" + p.subject; if (!bySubject.has(k)) bySubject.set(k, []); bySubject.get(k).push(p); }
  const ordered = [...bySubject.entries()].sort((a, b) => (/^통합과학/.test(b[1][0].subject) ? 1 : 0) - (/^통합과학/.test(a[1][0].subject) ? 1 : 0));
  for (const [, list] of ordered) {
    const subj = list[0].subject; const subs = subDepts(list[0].dept);
    if (/^통합과학/.test(subj) || /^통합사회/.test(subj)) {
      // 정정된 사용자 규칙: 반마다 주당 시수를 세부 교과에 1시간 단위로 나눔.
      // 통합과학 = 물리·화학·생명·지구 각 1시간(시수가 교과 수와 다르면 1인당 시수 낮은 교과부터 돌려 가며),
      // 통합사회 = 시간마다 1인당 예상 시수가 가장 낮은 세부 교과.
      const science = /^통합과학/.test(subj);
      const patterns = new Map();
      for (const p of list) {
        const share = {};
        for (let h = 0; h < p.hours; h += 1) {
          const ordered = [...subs].sort((x, y) => (science ? (share[x] || 0) - (share[y] || 0) : 0) || perTeacher(x) - perTeacher(y));
          const d = ordered[0];
          share[d] = (share[d] || 0) + 1; addProj(d, 1);
        }
        for (const [d, h] of Object.entries(share)) pieces.push({ ...p, hours: h, dept: d, commonFrom: p.dept, rule: science ? "통합과학 반마다 전공별 1시간" : "통합사회 반마다 1인당 시수 균형" });
        const key = subs.filter((d) => share[d]).map((d) => DEPT_NAME(d).replace(/^사회\(|^과학\(|\)$/g, "") + " " + share[d]).join("·");
        patterns.set(key, (patterns.get(key) || 0) + 1);
      }
      (commonSplits[list[0].grade + "|" + subj] = [...patterns.entries()].map(([pattern, classes]) => ({ pattern, classes })));
      issues.push({ level: "info", text: `${list[0].grade}학년 ${subj}(주 ${list[0].hours}시간): 배분 메모 없음 → 반마다 ${[...patterns.entries()].map(([k, n]) => `${k}(${n}반)`).join(", ")}` });
    } else {
      // 과학탐구실험 등: 반 단위로 1인당 예상 시수가 가장 낮은 세부 교과
      const got = {};
      for (const p of list) {
        const d = [...subs].sort((a2, b2) => perTeacher(a2) - perTeacher(b2))[0];
        pieces.push({ ...p, dept: d, commonFrom: p.dept, rule: "반 단위 1인당 시수 균형" }); addProj(d, p.hours); got[d] = (got[d] || 0) + 1;
      }
      commonSplits[list[0].grade + "|" + subj] = Object.entries(got).map(([d, n]) => ({ pattern: `${DEPT_NAME(d)} 반 전체`, classes: n }));
      issues.push({ level: "info", text: `${list[0].grade}학년 ${subj}: 배분 메모가 없어 ${Object.entries(got).map(([d, n]) => DEPT_NAME(d) + " " + n + "반").join(", ")}(반 단위, 1인당 시수 균형)` });
    }
  }
  const capacity = (t) => NABS - [...new Set([...t.unavailable, ...FIXED_TEACHER_ABS])].length - DAYS.length; // 날마다 점심 한 칸
  // 학년마다 반 빈 칸(블록·창체 아닌 칸)은 그 학년 모든 반이 같다 → 교사가 그 학년 수업에 쓸 수 있는 칸 수
  const gradeFree = {};
  for (const grade of ["1", "2", "3"]) { const c = classesOf(grade)[0]; gradeFree[grade] = c ? c.cells.map((cell, slot) => (cell ? -1 : slot)).filter((x) => x >= 0) : []; }
  const gradeCap = (t, grade) => gradeFree[grade].map((slot) => absOf(grade, slot)).filter((a) => !t.unavailable.has(a) && !busy.get(t.id).has(a)).length;
  const gLoad = new Map();
  const gl = (t, g) => gLoad.get(`${t.id}|${g}`) || 0;
  const unionCap = (t, grades) => [...new Set(grades.flatMap((g) => gradeFree[g].map((slot) => absOf(g, slot))))].filter((a) => !t.unavailable.has(a) && !busy.get(t.id).has(a)).length;
  const remedies = [];
  // 같은 교과 안에서: 시수 큰 과목부터, 반마다 '배정 뒤 시수 + 새 과목 준비 3'이 가장 작은 교사.
  // 그 학년 빈 칸 수를 넘기면 큰 벌점(한 교사가 같은 학년 수업을 그 학년 빈 칸보다 많이 맡으면 시간표가 나올 수 없음).
  // 규칙 5(가상 담임): 담임 명단이 없어 반마다 그 학년 반 수업 교과 교사 한 명을 돌려 가며 정한다(1학기에 정하고 2학기에도 그대로).
  if (!HOMEROOM.size) {
    const usedT = new Set();
    for (const grade of ["1", "2", "3"]) {
      const hoursBy = new Map();
      for (const p of pieces.filter((x) => x.grade === grade)) hoursBy.set(p.dept, (hoursBy.get(p.dept) || 0) + p.hours);
      const depts = [...hoursBy.keys()].filter((d) => poolOf(d).some((t) => !t.added)).sort((x, y) => hoursBy.get(y) - hoursBy.get(x));
      let k = 0;
      for (const c of classesOf(grade)) {
        let t = null;
        for (let tries = 0; tries < depts.length && !t; tries += 1) { const d = depts[(k + tries) % depts.length]; t = poolOf(d).find((x) => !usedT.has(x.id) && !x.added) || null; if (t) k = (k + tries + 1) % depts.length; }
        if (!t) t = teachers.find((x) => !x.virtual && !x.added && !usedT.has(x.id) && sections.some((sec) => sec.grade === grade && sec.teacherId === x.id)) || teachers.find((x) => !x.virtual && !x.added && !usedT.has(x.id));
        if (t) { usedT.add(t.id); HOMEROOM.set(c.id, t.id); }
      }
    }
  }
  const byDept = new Map();
  for (const p of pieces) { if (!byDept.has(p.dept)) byDept.set(p.dept, []); byDept.get(p.dept).push(p); }
  // 교사가 적은 교과(증원 교사를 함께 쓰는 기술·가정 등)부터 배정
  const deptOrder = [...byDept.entries()].sort((x, y) => (poolOf(x[0]).length || 99) - (poolOf(y[0]).length || 99));
  for (const [dept, list] of deptOrder) {
    let pool = poolOf(dept);
    if (!pool.length) {
      const why = VIRTUAL_NAMES[dept] || (dept === "교양" ? "타교과 미지정" : "교사 없음");
      pool = [virtualTeacher(dept, why)]; ensureT(pool[0]);
      issues.push({ level: "warning", text: `${DEPT_NAME(dept)}: 교사 명단에 교사가 없어 '${pool[0].name}' 가상 교사로 둠(${list.reduce((a, p) => a + p.hours, 0)}시간)` });
    }
    const totals = new Map();
    for (const p of list) totals.set(`${p.grade}|${p.subject}`, (totals.get(`${p.grade}|${p.subject}`) || 0) + p.hours);
    // 빈 칸이 적은 학년(3학년)부터 → 큰 과목부터
    list.sort((a, b) => gradeFree[a.grade].length - gradeFree[b.grade].length || totals.get(`${b.grade}|${b.subject}`) - totals.get(`${a.grade}|${a.subject}`) || a.classId.localeCompare(b.classId, "ko", { numeric: true }));
    for (const p of list) {
      const key = `${p.grade}|${p.subject}`;
      const scoreOf = (t) => {
        const after = load.get(t.id) + p.hours;
        const grades = [...new Set([...["1", "2", "3"].filter((g) => gl(t, g) > 0), p.grade])];
        const over = (gl(t, p.grade) + p.hours > gradeCap(t, p.grade)) || (grades.reduce((a, g) => a + gl(t, g), 0) + p.hours > unionCap(t, grades)) || after > capacity(t) - 2;
        return after + (preps.get(t.id).has(key) ? 0 : 3) + (over ? 1000 : 0) + (t.unavailable.size ? 0.5 : 0) + (HOMEROOM.get(p.classId) === t.id ? -30 : 0);
      };
      let best = null; let bestScore = Infinity;
      for (const t of pool) { const sc = scoreOf(t); if (sc < bestScore) { bestScore = sc; best = t; } }
      if (bestScore >= 1000) {
        if (REMEDY) {
          const n = remedies.filter((r) => r.dept === dept).length + 1;
          const t = virtualTeacher(`${dept}#추가${n}`, `${VIRTUAL_NAMES[dept] || "보완 가정"} ${n + (VIRTUAL_NAMES[dept] ? 1 : 0)}`); t.dept = dept; ensureT(t); pool.push(t);
          remedies.push({ dept, teacher: t.name, reason: `${p.grade}학년 ${p.subject}: 기존 교사가 ${p.grade}학년 빈 칸(${gradeFree[p.grade].length}칸) 안에서 더 맡을 수 없음` });
          best = t;
        } else {
          issues.push({ level: "error", text: `${DEPT_NAME(dept)} ${p.classId} ${p.subject}(${p.hours}시간): 교사마다 ${p.grade}학년 빈 칸(${gradeFree[p.grade].length}칸)·가능 시간을 넘겨 배정 — 시간표에서 교사 겹침이 남음` });
        }
      }
      p.teacherId = best.id;
      load.set(best.id, load.get(best.id) + p.hours); preps.get(best.id).add(key);
      gLoad.set(`${best.id}|${p.grade}`, gl(best, p.grade) + p.hours);
    }
  }
  // 진단: 교사별 학년 빈 칸 대비 그 학년 수업
  const diagnosis = [];
  for (const t of teachers) {
    if (!load.has(t.id)) continue;
    for (const g of ["1", "2", "3"]) { const h = gl(t, g); if (h > gradeCap(t, g)) diagnosis.push({ teacher: t.name, dept: t.dept, grade: g, hours: h, cap: gradeCap(t, g), gradeFree: gradeFree[g].length }); }
  }
  for (const p of pieces) classById.get(p.classId).lessons.push(p);
  for (const c of classes) for (const p of c.lessons) c.planned[p.kind === "학급단위" ? "학급단위" : "지정"] += p.hours;


  // =====================================================================
  // v3: 분반·블록 시간·반 수업·교사 배정을 함께 푸는 단계
  //  1) 구조(STRUCT): 학년 공통 블록 / 반군 엇갈림(블록 k개를 반군마다 다른 시간에) → 엇갈린 블록은 반군 안에서 분반을 다시 나눔
  //  2) 용량 사전 점검(계약 형태)
  //  3) 담금질: 반 칸 맞바꿈, 학년(반군) 열 맞바꿈(= 블록 시간 이동), 같은 교사 두 반 맞바꿈, 반 수업 교사 바꿈, 분반 교사 바꿈
  // =====================================================================
  const t0 = Date.now();
  const spec = STRUCT_SPEC(semester);
  const classIndex = new Map(classes.map((c, i) => [c.id, i]));
  // 학생 → 내년 반, 분반 → 학생
  const studentClass = new Map();
  const sectionStudents = new Map();
  for (const g of groups) {
    for (const [key, v] of Object.entries(g.map || {})) studentClass.set(key, `${g.targetGrade}-${v.classroom}`);
    for (const [key, ids] of Object.entries(g.result?.assign || {})) for (const id of ids) { const k = `${g.key}|${id}`; if (!sectionStudents.has(k)) sectionStudents.set(k, []); sectionStudents.get(k).push(key); }
  }
  const capOf = new Map();
  for (const g of groups) for (const s of g.result?.sections || []) capOf.set(`${g.key}|${s.id}`, Number(s.capacity) || 34);
  // 블록 개체(학년 공통)
  let entities = [];
  for (const b of blockCells) {
    const secs = sections.filter((s) => s.groupKey === b.groupKey && s.blockId === b.blockId);
    entities.push({ grade: b.grade, groupKey: b.groupKey, category: b.category, blockId: b.blockId, tag: "", classes: classesOf(b.grade).map((c) => classIndex.get(c.id)), slots: [...b.slots], credit: secs[0]?.credit || b.slots.length,
      sections: secs.map((s) => ({ id: s.id, sid: s.sid, course: s.course, courseKey: s.courseKey, credit: s.credit, dept: s.dept, teacherId: s.teacherId, room: s.room, students: [...(sectionStudents.get(s.id) || [])], origin: s.id, capacity: capOf.get(s.id) || 34 })) });
  }
  const before = { sections: entities.reduce((a, e) => a + e.sections.length, 0) };
  // 반군 엇갈림: 엇갈린 블록은 반군마다 개체를 따로 두고 그 반군 학생만으로 분반을 다시 나눈다(과목·블록은 그대로, 분반만 다시).
  const staggerReport = [];
  let studentsMoved = 0;
  if (spec && spec.k > 0) {
    const groupOf = (classNo) => spec.groups.findIndex((list) => list.includes(classNo));
    const cand = entities.filter((e) => e.grade === spec.grade && e.sections.length);
    const splitCost = (e) => {
      let add = 0; let moved = 0;
      const byCourse = new Map();
      for (const s of e.sections) { if (!byCourse.has(s.courseKey)) byCourse.set(s.courseKey, []); byCourse.get(s.courseKey).push(s); }
      for (const [, list] of byCourse) {
        const cap = list[0].capacity;
        let need = 0;
        for (let gi = 0; gi < spec.groups.length; gi += 1) {
          const n = list.reduce((a, s) => a + s.students.filter((k) => groupOf(Number((studentClass.get(k) || "-").split("-")[1])) === gi).length, 0);
          need += Math.ceil(n / cap);
        }
        add += need - list.length;
      }
      return add;
    };
    const ranked = cand.map((e) => ({ e, add: splitCost(e) })).sort((a, b) => a.add - b.add || a.e.blockId.localeCompare(b.e.blockId));
    const chosen = ranked.slice(0, spec.k).map((x) => x.e);
    for (const e of chosen) {
      const parts = spec.groups.map((list, gi) => ({ gi, classes: list.map((no) => classIndex.get(`${spec.grade}-${no}`)).filter((x) => x !== undefined) }));
      const newEntities = [];
      let moved = 0; let added = 0;
      for (const part of parts) {
        const ne = { ...e, tag: spec.names[part.gi], classes: part.classes, slots: part.gi === 0 ? [...e.slots] : null, sections: [] };
        const byCourse = new Map();
        for (const s of e.sections) { if (!byCourse.has(s.courseKey)) byCourse.set(s.courseKey, []); byCourse.get(s.courseKey).push(s); }
        for (const [, list] of byCourse) {
          const cap = list[0].capacity;
          const mine = list.map((s) => ({ s, st: s.students.filter((k) => groupOf(Number((studentClass.get(k) || "-").split("-")[1])) === part.gi) }));
          const total = mine.reduce((a, x) => a + x.st.length, 0);
          if (!total) continue;
          const n = Math.ceil(total / cap);
          // 그 반군 학생이 많은 원래 분반 n개를 남기고(같은 분반 이름), 나머지 분반 학생은 남은 분반에 고르게
          const keep = [...mine].sort((a, b) => b.st.length - a.st.length).slice(0, n);
          const out = keep.map((x) => ({ id: `${x.s.id}@${spec.names[part.gi]}`, sid: `${x.s.sid}${spec.names[part.gi]}`, course: x.s.course, courseKey: x.s.courseKey, credit: x.s.credit, dept: x.s.dept, teacherId: x.s.teacherId, room: x.s.room, students: [...x.st], origin: x.s.id, capacity: cap }));
          for (const x of mine) {
            if (keep.includes(x)) continue;
            for (const k of x.st) { out.sort((a, b) => a.students.length - b.students.length)[0].students.push(k); moved += 1; }
          }
          // 정원 넘으면(반올림 때문에 생길 수 없음) 표시만
          ne.sections.push(...out);
        }
        newEntities.push(ne);
        added += ne.sections.length;
      }
      added -= e.sections.length;
      studentsMoved += moved;
      staggerReport.push({ block: `${e.category} ${e.blockId}`, groups: spec.groups.map((l, gi) => `${spec.names[gi]}(${l.join(",")}반)`).join(" / "), sectionsBefore: e.sections.length, sectionsAfter: e.sections.length + added, studentsMoved: moved });
      entities = entities.filter((x) => x !== e).concat(newEntities);
    }
  }
  const after = { sections: entities.reduce((a, e) => a + e.sections.length, 0) };
  const E = entities.length;
  entities.forEach((e, i) => { e.index = i; e.classSet = new Set(e.classes); });
  // 반 칸 다시 만들기: 창체 → 블록 개체 → 남은 칸
  const CT_EMPTY = 0, CT_FIXED = 1, CT_LESSON = 2, CT_BLOCK = 3;
  const NC = classes.length;
  const cType = new Int8Array(NC * NSLOT);
  const cRef = new Int32Array(NC * NSLOT).fill(-1);
  for (let ci = 0; ci < NC; ci += 1) for (const f of FIXED) for (const slot of f.slots) cType[ci * NSLOT + slot] = CT_FIXED;
  for (const e of entities) {
    if (!e.slots) continue;
    for (const ci of e.classes) e.slots.forEach((slot, k) => { cType[ci * NSLOT + slot] = CT_BLOCK; cRef[ci * NSLOT + slot] = e.index * 8 + k; });
  }
  // 반군 엇갈림 블록의 다른 반군 시간: 그 반군 반들이 모두 비는 칸 중 서로 다른 요일, 이른 교시부터
  for (const e of entities.filter((x) => !x.slots)) {
    const free = [];
    for (let slot = 0; slot < NSLOT; slot += 1) if (e.classes.every((ci) => cType[ci * NSLOT + slot] === CT_EMPTY)) free.push(slot);
    const sib = entities.find((x) => x !== e && x.groupKey === e.groupKey && x.blockId === e.blockId && x.slots);
    const picked = [];
    const days = new Set();
    for (const slot of free.sort((a, b) => (a % P) - (b % P) || a - b)) { const d = Math.floor(slot / P); if (days.has(d) || sib.slots.includes(slot)) continue; picked.push(slot); days.add(d); if (picked.length === e.credit) break; }
    e.slots = picked;
    for (const ci of e.classes) e.slots.forEach((slot, k) => { cType[ci * NSLOT + slot] = CT_BLOCK; cRef[ci * NSLOT + slot] = e.index * 8 + k; });
  }
  // 반 수업 한 시간 항목
  const HI = [];
  const piecesList = [];
  for (const [ci, c] of classes.entries()) for (const p of c.lessons) {
    const pi = piecesList.length; piecesList.push({ ...p, ci, items: [] });
    for (let h = 0; h < p.hours; h += 1) { piecesList[pi].items.push(HI.length); HI.push({ ci, pi, subject: p.subject, kind: p.kind }); }
  }
  const tIndex = new Map(teachers.map((t, i) => [t.id, i]));
  const NT = teachers.length;
  const pieceT = new Int32Array(piecesList.length);
  piecesList.forEach((p, i) => { pieceT[i] = tIndex.get(p.teacherId); });
  const secList = [];
  for (const e of entities) for (const s of e.sections) { s.e = e.index; s.idx = secList.length; secList.push(s); }
  const secT = new Int32Array(secList.length);
  secList.forEach((s, i) => { secT[i] = tIndex.get(s.teacherId); });
  // 자격(교사 후보)
  const qualified = (dept) => {
    const own = teachers.filter((t) => !t.virtual && (t.dept === dept || t.extra.includes(dept)));
    if (own.length) return own.map((t) => tIndex.get(t.id));
    if (/-공통$/.test(dept)) return teachers.filter((t) => !t.virtual && familyOf(t.dept) === familyOf(dept)).map((t) => tIndex.get(t.id));
    return teachers.filter((t) => t.dept === dept || t.id === `v-${dept}`).map((t) => tIndex.get(t.id));
  };
  const piecePool = piecesList.map((p) => { const q = qualified(p.dept); return q.length ? q : [pieceT[piecesList.indexOf(p)]]; });
  // 완화안: FAMILY_COURSES에 적은 과목은 같은 교과군 교사 누구나(예: 기후변화와 환경생태 → 과학 교사)
  const FAMILY_COURSES = new Set((process.env.FAMILY_COURSES || "").split(",").filter(Boolean));
  const secPool = secList.map((s, i) => { const fam = FAMILY_COURSES.has(String(s.course).replace(/\s*\(\d학기\)$/, "")); const q = qualified(fam ? `${familyOf(s.dept)}-공통` : s.dept); return q.includes(secT[i]) ? q : [secT[i], ...q]; });
  const hrOf = new Int32Array(NC).fill(-1);
  classes.forEach((c, ci) => { const t = HOMEROOM.get(c.id); if (t !== undefined) hrOf[ci] = tIndex.get(t); });
  // ---- 비용 ----
  const W = { teacher: 1000, block: 1000, run: 500, lunch: 500, lesson2: 400, hole: 400, nb: 6, tday: 15, ts: 3, prep: 2, over: 40, bal: 0.15, hr: 4 };
  const D5 = DAYS.length;
  const tCnt = new Int16Array(NT * NABS);
  const tBlk = new Int8Array(NT * NABS);
  for (const t of teachers) { const i = tIndex.get(t.id); for (const a of t.unavailable) tBlk[i * NABS + a] = 1; for (const a of FIXED_TEACHER_ABS) tBlk[i * NABS + a] = 1; }
  const DAYC = new Float64Array(1 << AP);
  for (let m = 0; m < (1 << AP); m += 1) DAYC[m] = dayMaskCost(m, W);
  const HOLE = new Int8Array(1 << P);
  for (let m = 0; m < (1 << P); m += 1) { let top = -1; for (let k = 0; k < P; k += 1) if (m & (1 << k)) top = k; let h = 0; for (let k = 0; k < top; k += 1) if (!(m & (1 << k))) h += 1; HOLE[m] = h; }
  const keyMap = new Map();
  const keyId = (k) => { let v = keyMap.get(k); if (v === undefined) { v = keyMap.size; keyMap.set(k, v); } return v; };
  const dayCnt = new Map(); // keyId*8+d → count (rule 4)
  const tsCnt = new Map(); // (교사|과목) keyId*8+d → count (rule 3)
  const tload = new Float64Array(NT);
  const prepCnt = new Map();
  const deptAvg = new Map();
  let cost = 0;
  const tMask = (ti, d) => { let m = 0; const b = ti * NABS + d * AP; for (let k = 0; k < AP; k += 1) if (tCnt[b + k] > 0) m |= 1 << k; return m; };
  const penT = (blk, n) => (blk + n > 1 ? (blk + n - 1) * W.teacher : 0);
  function bump(map, key, sign, pen) { const v = (map.get(key) || 0); cost -= pen(v); const nv = v + sign; if (nv) map.set(key, nv); else map.delete(key); cost += pen(nv); }
  const pen4 = (n) => (n >= 2 ? (n - 1) * W.lesson2 : 0);
  const pen3 = (n) => (n >= 2 ? (n * (n - 1)) / 2 * W.ts : 0);
  // 교사 한 시간 사건(반 수업 또는 분반): 겹침·하루 칸·규칙 4·규칙 3
  function tEvent(ti, a, sign, r4, subj) {
    const d = Math.floor(a / AP);
    cost -= DAYC[tMask(ti, d)];
    const x = ti * NABS + a;
    cost -= penT(tBlk[x], tCnt[x]); tCnt[x] += sign; cost += penT(tBlk[x], tCnt[x]);
    cost += DAYC[tMask(ti, d)];
    bump(dayCnt, r4 * 8 + d, sign, pen4);
    bump(tsCnt, keyId(`${ti}|${subj}`) * 8 + d, sign, pen3);
  }
  const absAt = (ci, slot) => ABS_MAP[classes[ci].grade][slot];
  const lessonKey = (it) => keyId(`L${it.ci}|${it.subject}|${pieceT[it.pi]}`);
  // 교사 부담(교과 평균 둘레)·준비 과목·담임
  const loadPen = (ti, l) => { const avg = deptAvg.get(teachers[ti].dept) ?? l; return W.bal * (l - avg) * (l - avg) + (l > 21 ? (l - 21) * W.over : 0); };
  function loadAdd(ti, h) { cost -= loadPen(ti, tload[ti]); tload[ti] += h; cost += loadPen(ti, tload[ti]); }
  function prepAdd(ti, key, sign) { const k = `${ti}|${key}`; const v = prepCnt.get(k) || 0; if (v === 0 && sign > 0) cost += W.prep; if (v === 1 && sign < 0) cost -= W.prep; if (v + sign) prepCnt.set(k, v + sign); else prepCnt.delete(k); }
  const classDayCost = (ci, d) => { let m = 0; const b = ci * NSLOT + d * P; for (let k = 0; k < P; k += 1) if (cType[b + k] !== CT_EMPTY) m |= 1 << k; return HOLE[m] * W.hole; };
  // 처음 상태: 분반 사건
  for (const s of secList) { const e = entities[s.e]; e.slots.forEach((slot, k) => tEvent(secT[s.idx], absOf(e.grade, slot), 1, keyId(`S${s.id}`), s.course)); }
  // 교과 평균(처음 배정 기준)
  { const byD = new Map(); for (const [i, p] of piecesList.entries()) { const t = teachers[pieceT[i]]; byD.set(t.dept, (byD.get(t.dept) || 0) + p.hours); } for (const s of secList) { const t = teachers[secT[s.idx]]; byD.set(t.dept, (byD.get(t.dept) || 0) + s.credit); }
    for (const [d, h] of byD) deptAvg.set(d, h / Math.max(1, teachers.filter((t) => t.dept === d).length)); }
  for (const [i, p] of piecesList.entries()) { loadAdd(pieceT[i], p.hours); prepAdd(pieceT[i], `${p.grade}|${p.subject}`, 1); if (hrOf[p.ci] === pieceT[i]) cost -= W.hr; }
  for (const s of secList) { loadAdd(secT[s.idx], s.credit); prepAdd(secT[s.idx], `${entities[s.e].grade}|${s.course}`, 1); }
  for (let ci = 0; ci < NC; ci += 1) for (let d = 0; d < D5; d += 1) cost += classDayCost(ci, d);
  // 반 수업 놓기/빼기
  function putItem(hi, ci, slot, sign) {
    const it = HI[hi];
    const d = Math.floor(slot / P);
    cost -= classDayCost(ci, d);
    if (sign > 0) { cType[ci * NSLOT + slot] = CT_LESSON; cRef[ci * NSLOT + slot] = hi; } else { cType[ci * NSLOT + slot] = CT_EMPTY; cRef[ci * NSLOT + slot] = -1; }
    cost += classDayCost(ci, d);
    tEvent(pieceT[it.pi], absAt(ci, slot), sign, lessonKey(it), it.subject);
  }
  // ---- CP-SAT 연동: EXPORT면 모형 입력을 쓰고, SOLUTION이면 풀이를 읽어 담금질 대신 씀 ----
  const SOLFILE = process.env.SOLUTION ? process.env.SOLUTION.replace("{sem}", semester) : "";
  if (process.env.EXPORT) {
    const FIX_DEPTS = new Set((process.env.FIX_DEPTS || "국어,수학,영어").split(","));
    const model = { semester, NSLOT, P, days: DAYS, AP, absMap: ABS_MAP, fixed: [...FIXED_SLOTS],
      classes: classes.map((c) => ({ id: c.id, grade: c.grade })),
      teachers: teachers.map((t) => ({ id: t.id, name: t.name, dept: t.dept, blocked: [...new Set([...t.unavailable, ...FIXED_TEACHER_ABS])] })),
      entities: entities.map((e) => ({ idx: e.index, grade: e.grade, classes: e.classes, credit: e.credit, init: e.slots, label: `${e.category} ${e.blockId}${e.tag}`, sections: e.sections.map((x) => ({ idx: x.idx, id: x.id, course: x.course, pool: secPool[x.idx], init: secT[x.idx] })) })),
      pieces: piecesList.map((p, i) => ({ idx: i, ci: p.ci, grade: p.grade, subject: p.subject, hours: p.hours, dept: p.dept, pool: FIX_DEPTS.has(p.dept) ? [pieceT[i]] : (p.commonFrom && !/^통합과학/.test(p.subject) && process.env.FAMILY_POOL !== "0" ? [...new Set([pieceT[i], ...qualified(p.commonFrom)])] : piecePool[i]), sameKey: `${p.ci}|${p.subject}`, init: pieceT[i], hr: hrOf[p.ci] })),
      deptAvg: Object.fromEntries(deptAvg) };
    fs.writeFileSync(process.env.EXPORT.replace("{sem}", semester), JSON.stringify(model));
  }
  let SOL = null;
  if (SOLFILE && fs.existsSync(SOLFILE)) SOL = JSON.parse(fs.readFileSync(SOLFILE, "utf8"));
  if (SOL) {
    // 풀이 적용: 반 칸 비우고 블록·수업을 풀이대로
    for (let ci = 0; ci < NC; ci += 1) for (let slot = 0; slot < NSLOT; slot += 1) { const x = ci * NSLOT + slot; if (cType[x] !== CT_FIXED) { cType[x] = CT_EMPTY; cRef[x] = -1; } }
    for (const e of entities) { e.slots = SOL.y[e.index]; for (const ci of e.classes) e.slots.forEach((slot, k) => { cType[ci * NSLOT + slot] = CT_BLOCK; cRef[ci * NSLOT + slot] = e.index * 8 + k; }); }
    piecesList.forEach((p, i) => { pieceT[i] = SOL.a[i]; SOL.x[i].forEach((slot, k) => { cType[p.ci * NSLOT + slot] = CT_LESSON; cRef[p.ci * NSLOT + slot] = p.items[k]; }); });
    secList.forEach((x, i) => { secT[i] = SOL.b[i]; });
  }
  // 처음 배치: 시간 제약 많은 교사부터, 비용이 가장 적게 느는 칸
  if (!SOL) {
  const order = HI.map((_, i) => i).sort((a, b) => tload[pieceT[HI[b].pi]] - tload[pieceT[HI[a].pi]] || rand() - 0.5);
  for (const hi of order) {
    const ci = HI[hi].ci; let best = -1; let bc = Infinity;
    for (let slot = 0; slot < NSLOT; slot += 1) {
      if (cType[ci * NSLOT + slot] !== CT_EMPTY) continue;
      const b = cost; putItem(hi, ci, slot, 1); const dl = cost - b; putItem(hi, ci, slot, -1);
      if (dl < bc - 1e-9 || (Math.abs(dl - bc) < 1e-9 && rand() < 0.3)) { bc = dl; best = slot; }
    }
    if (best >= 0) putItem(hi, ci, best, 1); else issues.push({ level: "error", text: `${classes[ci].id}: 반 수업을 놓을 칸이 없음` });
  }
  }
  const initialCost = cost;
  // ---- 움직임 ----
  function swapInClass(ci, p, q) {
    const tp = cType[ci * NSLOT + p], tq = cType[ci * NSLOT + q];
    const rp = cRef[ci * NSLOT + p], rq = cRef[ci * NSLOT + q];
    if (tp === CT_LESSON) putItem(rp, ci, p, -1);
    if (tq === CT_LESSON) putItem(rq, ci, q, -1);
    if (tp === CT_LESSON) putItem(rp, ci, q, 1);
    if (tq === CT_LESSON) putItem(rq, ci, p, 1);
  }
  // 학년(반군) 열 맞바꿈: p·q 칸을 그 칸에 걸린 블록 개체의 반 전부에서 함께 바꾼다(= 블록 시간 이동)
  function closureOf(ci0, p, q) {
    const set = new Set([ci0]); const stack = [ci0];
    while (stack.length) {
      const ci = stack.pop();
      for (const slot of [p, q]) {
        const x = ci * NSLOT + slot;
        if (cType[x] === CT_FIXED) return null;
        if (cType[x] === CT_BLOCK) for (const cj of entities[cRef[x] >> 3].classes) if (!set.has(cj)) { set.add(cj); stack.push(cj); }
      }
    }
    return [...set];
  }
  function columnSwap(cls, p, q) {
    // 블록 개체 칸 옮기기(분반 사건)
    const moved = new Map();
    for (const ci of cls) for (const [from, to] of [[p, q], [q, p]]) { const x = ci * NSLOT + from; if (cType[x] === CT_BLOCK && !moved.has(cRef[x])) moved.set(cRef[x], to); }
    for (const [ref] of moved) { const e = entities[ref >> 3]; const k = ref & 7; for (const s of e.sections) tEvent(secT[s.idx], absOf(e.grade, e.slots[k]), -1, keyId(`S${s.id}`), s.course); }
    for (const ci of cls) {
      const d1 = Math.floor(p / P), d2 = Math.floor(q / P);
      cost -= classDayCost(ci, d1); if (d2 !== d1) cost -= classDayCost(ci, d2);
      const xp = ci * NSLOT + p, xq = ci * NSLOT + q;
      const tp = cType[xp], tq = cType[xq], rp = cRef[xp], rq = cRef[xq];
      if (tp === CT_LESSON) tEvent(pieceT[HI[rp].pi], absAt(ci, p), -1, lessonKey(HI[rp]), HI[rp].subject);
      if (tq === CT_LESSON) tEvent(pieceT[HI[rq].pi], absAt(ci, q), -1, lessonKey(HI[rq]), HI[rq].subject);
      cType[xp] = tq; cRef[xp] = rq; cType[xq] = tp; cRef[xq] = rp;
      if (tp === CT_LESSON) tEvent(pieceT[HI[rp].pi], absAt(ci, q), 1, lessonKey(HI[rp]), HI[rp].subject);
      if (tq === CT_LESSON) tEvent(pieceT[HI[rq].pi], absAt(ci, p), 1, lessonKey(HI[rq]), HI[rq].subject);
      cost += classDayCost(ci, d1); if (d2 !== d1) cost += classDayCost(ci, d2);
    }
    for (const [ref, to] of moved) { const e = entities[ref >> 3]; const k = ref & 7; e.slots[k] = to; for (const s of e.sections) tEvent(secT[s.idx], absOf(e.grade, to), 1, keyId(`S${s.id}`), s.course); }
  }
  function setPieceTeacher(pi, ti) {
    const p = piecesList[pi]; const old = pieceT[pi];
    const placed = p.items.map((hi) => { for (let slot = 0; slot < NSLOT; slot += 1) if (cType[p.ci * NSLOT + slot] === CT_LESSON && cRef[p.ci * NSLOT + slot] === hi) return slot; return -1; });
    p.items.forEach((hi, k) => { if (placed[k] >= 0) tEvent(old, absAt(p.ci, placed[k]), -1, lessonKey(HI[hi]), HI[hi].subject); });
    loadAdd(old, -p.hours); prepAdd(old, `${p.grade}|${p.subject}`, -1); if (hrOf[p.ci] === old) cost += W.hr;
    pieceT[pi] = ti;
    loadAdd(ti, p.hours); prepAdd(ti, `${p.grade}|${p.subject}`, 1); if (hrOf[p.ci] === ti) cost -= W.hr;
    p.items.forEach((hi, k) => { if (placed[k] >= 0) tEvent(ti, absAt(p.ci, placed[k]), 1, lessonKey(HI[hi]), HI[hi].subject); });
  }
  function setSecTeacher(si, ti) {
    const s = secList[si]; const e = entities[s.e]; const old = secT[si];
    for (const slot of e.slots) tEvent(old, absOf(e.grade, slot), -1, keyId(`S${s.id}`), s.course);
    loadAdd(old, -s.credit); prepAdd(old, `${e.grade}|${s.course}`, -1);
    secT[si] = ti;
    loadAdd(ti, s.credit); prepAdd(ti, `${e.grade}|${s.course}`, 1);
    for (const slot of e.slots) tEvent(ti, absOf(e.grade, slot), 1, keyId(`S${s.id}`), s.course);
  }
  const ITER = SOL || process.env.EXPORT ? 0 : Number(process.env.ITER || 8000000);
  const TLIM = Number(process.env.TLIM || 240000);
  let T = 60; const Tend = 0.05; const alpha = Math.pow(Tend / T, 1 / ITER);
  let bestCost = cost; let bestSnap = null;
  const snap = () => ({ cType: Int8Array.from(cType), cRef: Int32Array.from(cRef), pieceT: Int32Array.from(pieceT), secT: Int32Array.from(secT), slots: entities.map((e) => [...e.slots]) });
  bestSnap = snap(); let snapCost = cost;
  const gradesCls = { "1": [], "2": [], "3": [] }; classes.forEach((c, ci) => gradesCls[c.grade].push(ci));
  const accept = (delta) => delta <= 0 || rand() < Math.exp(-delta / T);
  let it = 0;
  for (; it < ITER; it += 1) {
    if ((it & 65535) === 0 && Date.now() - t0 > TLIM) break;
    const r = rand();
    const b = cost;
    if (r < 0.55) {
      const ci = randInt(NC); const p = randInt(NSLOT), q = randInt(NSLOT);
      const tp = cType[ci * NSLOT + p], tq = cType[ci * NSLOT + q];
      if (p === q || (tp !== CT_EMPTY && tp !== CT_LESSON) || (tq !== CT_EMPTY && tq !== CT_LESSON) || (tp === CT_EMPTY && tq === CT_EMPTY)) { T *= alpha; continue; }
      swapInClass(ci, p, q);
      if (!accept(cost - b)) swapInClass(ci, p, q);
    } else if (r < 0.70) {
      const ci = randInt(NC); const p = randInt(NSLOT), q = randInt(NSLOT);
      if (p === q) { T *= alpha; continue; }
      const cls = closureOf(ci, p, q);
      if (!cls || cls.length < 2) { T *= alpha; continue; }
      columnSwap(cls, p, q);
      if (!accept(cost - b)) columnSwap(cls, p, q);
    } else if (r < 0.85) {
      // 같은 교사 두 반 맞바꿈(같은 학년)
      const ci = randInt(NC); const p = randInt(NSLOT), q = randInt(NSLOT);
      if (p === q || cType[ci * NSLOT + p] !== CT_LESSON) { T *= alpha; continue; }
      const tq = cType[ci * NSLOT + q]; if (tq !== CT_EMPTY && tq !== CT_LESSON) { T *= alpha; continue; }
      const ti = pieceT[HI[cRef[ci * NSLOT + p]].pi];
      const cands = gradesCls[classes[ci].grade].filter((cj) => cj !== ci && cType[cj * NSLOT + q] === CT_LESSON && pieceT[HI[cRef[cj * NSLOT + q]].pi] === ti && (cType[cj * NSLOT + p] === CT_EMPTY || cType[cj * NSLOT + p] === CT_LESSON));
      if (!cands.length) { T *= alpha; continue; }
      const cj = cands[randInt(cands.length)];
      swapInClass(ci, p, q); swapInClass(cj, q, p);
      if (!accept(cost - b)) { swapInClass(cj, q, p); swapInClass(ci, p, q); }
    } else if (r < 0.93) {
      const pi = randInt(piecesList.length); const pool = piecePool[pi]; if (pool.length < 2) { T *= alpha; continue; }
      const ti = pool[randInt(pool.length)]; const old = pieceT[pi]; if (ti === old) { T *= alpha; continue; }
      setPieceTeacher(pi, ti);
      if (!accept(cost - b)) setPieceTeacher(pi, old);
    } else {
      if (!secList.length) { T *= alpha; continue; }
      const si = randInt(secList.length); const pool = secPool[si]; if (pool.length < 2) { T *= alpha; continue; }
      const ti = pool[randInt(pool.length)]; const old = secT[si]; if (ti === old) { T *= alpha; continue; }
      setSecTeacher(si, ti);
      if (!accept(cost - b)) setSecTeacher(si, old);
    }
    if (cost < bestCost - 1e-9) { bestCost = cost; if ((it & 255) === 0 || cost < 3000) { bestSnap = snap(); snapCost = cost; } }
    T *= alpha;
  }
  // 최선 상태로(교사 사건은 결과 점검에서 다시 셈)
  if (!SOL && cost > snapCost) { const S0 = bestSnap; cType.set(S0.cType); cRef.set(S0.cRef); pieceT.set(S0.pieceT); secT.set(S0.secT); entities.forEach((e, i) => { e.slots = S0.slots[i]; }); }
  // 결과를 반 칸·분반으로 되돌려 쓰기
  for (const [ci, c] of classes.entries()) {
    for (let slot = 0; slot < NSLOT; slot += 1) {
      const x = ci * NSLOT + slot;
      if (cType[x] === CT_FIXED) continue;
      if (cType[x] === CT_BLOCK) { const e = entities[cRef[x] >> 3]; c.cells[slot] = { kind: "block", label: `${e.category.replace(/^\d-\d\s*/, "")} ${e.blockId}블록${e.tag ? "(" + e.tag + ")" : ""}`, category: e.category, blockId: e.blockId, groupKey: e.groupKey, entity: e.index }; continue; }
      if (cType[x] === CT_LESSON) { const itm = HI[cRef[x]]; c.cells[slot] = { kind: itm.kind === "학급단위" ? "unit" : "lesson", label: itm.subject, teacherId: teachers[pieceT[itm.pi]].id }; continue; }
      c.cells[slot] = { kind: "empty", label: "" };
    }
  }
  piecesList.forEach((p, i) => { p.teacherId = teachers[pieceT[i]].id; });
  const outSections = [];
  for (const s of secList) { const e = entities[s.e]; outSections.push({ id: s.id, sid: s.sid, groupKey: e.groupKey, grade: e.grade, category: e.category, blockId: e.blockId + (e.tag ? `(${e.tag})` : ""), entity: e.index, slots: [...e.slots], abs: e.slots.map((sl) => absOf(e.grade, sl)), course: s.course, credit: s.credit, teacherId: teachers[secT[s.idx]].id, room: s.room, dept: s.dept, students: s.students, origin: s.origin, changedTeacher: s.teacherId !== teachers[secT[s.idx]].id }); }
  const teacherLoad = {};
  for (const [i, p] of piecesList.entries()) teacherLoad[teachers[pieceT[i]].id] = (teacherLoad[teachers[pieceT[i]].id] || 0) + p.hours;
  for (const s of outSections) teacherLoad[s.teacherId] = (teacherLoad[s.teacherId] || 0) + s.credit;
  const blockTimes = entities.map((e) => ({ grade: e.grade, category: e.category, blockId: e.blockId, tag: e.tag, classes: e.classes.map((ci) => classes[ci].id), times: e.slots.map(slotName), sections: e.sections.length }));
  const origTimes = new Map(blockCells.map((b) => [`${b.groupKey}|${b.blockId}`, b.slots]));
  const timesMoved = entities.reduce((a, e) => a + e.slots.filter((sl) => !(origTimes.get(`${e.groupKey}|${e.blockId}`) || []).includes(sl)).length, 0);
  return { semester, classes, sections: outSections, entities: blockTimes, pieces: piecesList.map(({ items: _, ...p }) => p), teacherLoad, issues, commonSplits, remedies, diagnosis,
    gradeFree: Object.fromEntries(Object.entries(gradeFree).map(([g, v]) => [g, v.length])),
    structure: { name: STRUCT, spec, stagger: staggerReport, sectionsBefore: before.sections, sectionsAfter: after.sections, studentsMoved, blockSlotsMoved: timesMoved,
      sectionTeacherChanged: outSections.filter((s) => s.changedTeacher).length },
    solver: { initialCost, finalCost: bestCost, iterations: it, hourItems: HI.length, seed: SEED, ms: Date.now() - t0 } };
}

// ---------- 점검 v3(결과만 보고 다시 셈) ----------
function check3(sem) {
  const { classes, sections, semester } = sem;
  const out = { classConflicts: [], teacherConflicts: [], unavailable: [], subjectPerDay: [], subjectPerDay2: 0, hoursPlan: [], teacherHours: [], deptCompare: [], students: null, room: [], teacherDayOver: [], classHoles: [] };
  for (const c of classes) {
    const counts = { 지정: 0, 학급단위: 0, 이동: 0, 창체: 0, 빈칸: 0 };
    for (const cell of c.cells) {
      if (cell.kind === "fixed") counts.창체 += 1; else if (cell.kind === "block") counts.이동 += 1;
      else if (cell.kind === "lesson") counts.지정 += 1; else if (cell.kind === "unit") counts.학급단위 += 1; else counts.빈칸 += 1;
    }
    const total = counts.지정 + counts.학급단위 + counts.이동 + counts.창체;
    const plan = c.planned.지정 + c.planned.학급단위 + c.planned.이동 + c.planned.창체;
    out.hoursPlan.push({ classId: c.id, grade: c.grade, ...counts, total, plan, ok: total === plan && counts.지정 === c.planned.지정 && counts.학급단위 === c.planned.학급단위 });
    for (let d = 0; d < DAYS.length; d += 1) {
      let top = -1; for (let p = 0; p < P; p += 1) if (c.cells[d * P + p].kind !== "empty") top = p;
      for (let p = 0; p < top; p += 1) if (c.cells[d * P + p].kind === "empty") out.classHoles.push(`${c.id} ${DAYS[d]}${p + 1}`);
      const per = new Map();
      for (let p = 0; p < P; p += 1) { const cell = c.cells[d * P + p]; if (cell.kind === "lesson" || cell.kind === "unit") per.set(cell.label, (per.get(cell.label) || 0) + 1); }
      for (const [subject, n] of per) { if (n > 2) out.subjectPerDay.push(`${c.id} ${DAYS[d]} ${subject} ${n}시간`); else if (n === 2) out.subjectPerDay2 += 1; }
    }
  }
  const tSlots = new Map(teachers.map((t) => [t.id, Array.from({ length: NABS }, () => [])]));
  for (const c of classes) c.cells.forEach((cell, slot) => { if (cell.teacherId) tSlots.get(cell.teacherId)[absOf(c.grade, slot)].push({ what: `${c.id} ${cell.label}`, kind: cell.kind, classId: c.id, subject: cell.label, key: `${c.id}|${cell.label}` }); });
  for (const s of sections) for (const a of s.abs) tSlots.get(s.teacherId)[a].push({ what: `${s.category} ${s.blockId}블록 ${s.course}`, kind: "block", subject: s.course, key: `S${s.id}` });
  const R = out.rules = { runOver: [], noLunch: [], lunchDays: 0, lunchGood: 0, lunchHalf: 0, fixedRunOver: 0, fixedNoLunch: 0, lesson2: [], classSubj2: 0, teacherSubjExcess: 0, homeroom: null };
  for (const t of teachers) {
    const slots = tSlots.get(t.id);
    let n = 0;
    slots.forEach((list, a) => {
      n += list.length;
      if (list.length > 1) out.teacherConflicts.push(`${t.name}(${DEPT_NAME(t.dept)}) ${absName(a)}: ${list.map((x) => x.what).join(" / ")}`);
      if (list.length && t.unavailable.has(a)) out.unavailable.push(`${t.name} ${absName(a)}(${t.reason}): ${list.map((x) => x.what).join(" / ")}`);
      if (list.length && FIXED_TEACHER_ABS.has(a)) out.unavailable.push(`${t.name} ${absName(a)}(창체 고정): ${list.map((x) => x.what).join(" / ")}`);
    });
    for (let d = 0; d < DAYS.length; d += 1) {
      let m = 0; let fm = 0;
      for (let k = 0; k < AP; k += 1) { const a = d * AP + k; if (slots[a].length) m |= 1 << k; if (slots[a].some((x) => x.kind === "block")) fm |= 1 << k; }
      if (!m) continue;
      const info = dayMaskInfo(m); const finfo = dayMaskInfo(fm);
      if (info.excess) R.runOver.push(`${t.name} ${DAYS[d]} 연속 ${info.longest}시간`);
      if (info.noLunch) R.noLunch.push(`${t.name} ${DAYS[d]} A·B 모두 수업`);
      if (finfo.excess) R.fixedRunOver += 1;
      if (finfo.noLunch) R.fixedNoLunch += 1;
      R.lunchDays += 1;
      if (!info.noLunch && info.nb === 0) R.lunchGood += 1; else if (!info.noLunch && info.nb === 1) R.lunchHalf += 1;
      if (info.count > 6) out.teacherDayOver.push(`${t.name} ${DAYS[d]} ${info.count}시간`);
      const per = new Map(); const perKey = new Map();
      for (let k = 0; k < AP; k += 1) for (const x of slots[d * AP + k]) { per.set(x.subject, (per.get(x.subject) || 0) + 1); perKey.set(x.key, (perKey.get(x.key) || 0) + 1); }
      for (const [subject, cnt] of per) { const total = slots.flat().filter((x) => x.subject === subject).length; R.teacherSubjExcess += Math.max(0, cnt - Math.ceil(total / DAYS.length)); }
      for (const [key, cnt] of perKey) if (cnt >= 2) R.lesson2.push(`${t.name} ${DAYS[d]} ${key.replace(/^S.*\|/, "분반 ")} ${cnt}회`);
    }
    const assigned = sem.teacherLoad[t.id] || 0;
    out.teacherHours.push({ id: t.id, name: t.name, dept: t.dept, extra: t.extra, added: Boolean(t.added), virtual: t.virtual, timetable: n, assigned, ok: n === assigned, unavailable: t.unavailable.size, reason: t.reason });
  }
  const hr = { classes: 0, applies: 0, ok: 0, notApplies: 0, list: [] };
  for (const c of classes) {
    const tid = HOMEROOM.get(c.id); if (!tid) continue; hr.classes += 1;
    if (!classes.some((x) => x.grade === c.grade && x.cells.some((cell) => cell.teacherId === tid))) { hr.notApplies += 1; continue; }
    hr.applies += 1;
    const own = c.cells.some((cell) => cell.teacherId === tid);
    if (own) hr.ok += 1;
    hr.list.push({ classId: c.id, teacher: teacherById.get(tid)?.name, own });
  }
  R.homeroom = hr;
  // 5단계 비교(교과군)
  const deptTimetable = new Map();
  for (const p of sem.pieces) deptTimetable.set(p.dept, (deptTimetable.get(p.dept) || 0) + p.hours);
  for (const s of sections) deptTimetable.set(s.dept, (deptTimetable.get(s.dept) || 0) + s.credit);
  for (const d of IN.departments) {
    const five = d.totals?.[semester] ?? 0; const tt = deptTimetable.get(d.id) || 0;
    if (!five && !tt) continue;
    out.deptCompare.push({ dept: d.id, name: DEPT_NAME(d.id), hours5: five, timetable: tt, teachers5: d.teachers, teachersList: teachers.filter((t) => t.dept === d.id && !t.virtual).length, avg5: d.averages ? Math.round(d.averages[semester] * 100) / 100 : null, ok: five === tt, common: Boolean(d.common) });
  }
  for (const fam of ["과학", "사회"]) {
    const rows = out.deptCompare.filter((d) => d.dept.startsWith(fam + "-"));
    const five = rows.reduce((a, d) => a + (d.hours5 || 0), 0);
    const tt = [...deptTimetable.entries()].filter(([d]) => d.startsWith(fam + "-")).reduce((a, [, h]) => a + h, 0);
    for (const d of rows) d.ok = d.ok || five === tt;
    out.deptCompare.push({ dept: fam, name: fam + " 교과군 합계", hours5: five, timetable: tt, teachers5: rows.reduce((a, d) => a + (d.teachers5 || 0), 0), teachersList: rows.reduce((a, d) => a + d.teachersList, 0), avg5: null, ok: five === tt, family: true });
  }
  // 학생: 반 수업 + 그 반이 든 블록 개체마다 내 분반 하나(엇갈림 블록은 반군 분반)
  const st = { checked: 0, overlaps: [], missingBlock: 0, missingBlockStudents: 0, holes: 0, noClass: 0, overCapacity: 0, samples: [] };
  const secOfStudent = new Map();
  for (const s of sections) for (const k of s.students) { if (!secOfStudent.has(k)) secOfStudent.set(k, []); secOfStudent.get(k).push(s); }
  for (const s of sections) if (s.students.length > 34) st.overCapacity += 1;
  for (const grade of ["2", "3"]) {
    const gs = IN.groups.filter((g) => g.semester === semester && g.targetGrade === grade);
    if (!gs.length) continue;
    const map = gs[0].map || {};
    for (const { key } of gs[0].gradeStudents) {
      const room = map[key]?.classroom; const c = classes.find((x) => x.id === `${grade}-${room}`);
      if (!c) { st.noClass += 1; continue; }
      st.checked += 1;
      const cells = Array.from({ length: NSLOT }, () => []);
      c.cells.forEach((cell, slot) => { if (cell.kind !== "block" && cell.kind !== "empty") cells[slot].push(cell.kind === "fixed" ? { label: cell.label } : { label: cell.label, teacherId: cell.teacherId }); });
      for (const s of secOfStudent.get(key) || []) { if (!c.cells[s.slots[0]] || c.cells[s.slots[0]].kind !== "block" || c.cells[s.slots[0]].entity !== s.entity) { st.overlaps.push(`${key}: 분반 ${s.id}가 반 블록과 안 맞음`); continue; } for (const slot of s.slots) cells[slot].push({ label: s.course, teacherId: s.teacherId, block: `${s.category.replace(/^\d-\d\s*/, "")} ${s.blockId}`, room: s.room }); }
      let missing = 0;
      c.cells.forEach((cell, slot) => { if (cell.kind === "block" && !cells[slot].length) missing += 1; });
      cells.forEach((list, slot) => { if (list.length > 1) st.overlaps.push(`${key} ${slotName(slot)}: ${list.map((x) => x.label).join(" / ")}`); });
      // 학생 공강: 하루 안에서 수업 없는 칸 뒤에 수업이 있으면
      for (let d = 0; d < DAYS.length; d += 1) { let top = -1; for (let p = 0; p < P; p += 1) if (cells[d * P + p].length) top = p; for (let p = 0; p < top; p += 1) if (!cells[d * P + p].length) st.holes += 1; }
      if (missing) { st.missingBlock += missing; st.missingBlockStudents += 1; }
      if (["2-1", "2-7", "3-1", "3-8"].includes(c.id) && !st.samples.some((x) => x.classId === c.id)) st.samples.push({ key: `예시 학생 ${st.samples.length + 1}`, classId: c.id, cells: cells.map((list) => list[0] || null), missing });
    }
  }
  out.students = st;
  out.scienceTeachers = classes.filter((c) => c.grade === "1").map((c) => {
    const ts = new Set(c.cells.filter((cell) => /^통합과학/.test(cell.label || "")).map((cell) => cell.teacherId));
    return { classId: c.id, teachers: ts.size, ok: ts.size === 4 && new Set([...ts].map((id) => teacherById.get(id)?.dept)).size === 4 };
  });
  return out;
}

// ---------- 용량 사전 점검(계약 형태: 앱 5·6단계 경고로 옮길 것) ----------
function precheck(sem) {
  const out = [];
  const { classes } = sem;
  for (const grade of ["1", "2", "3"]) {
    const cls = classes.filter((c) => c.grade === grade);
    // 반마다 반 수업 칸(블록·창체 아닌 칸) — 같은 반군이면 같음
    const freeSets = cls.map((c) => c.cells.map((cell, slot) => (cell.kind === "block" || cell.kind === "fixed" ? -1 : absOf(grade, slot))).filter((x) => x >= 0));
    const union = new Set(freeSets.flat());
    const byDept = new Map();
    for (const p of sem.pieces.filter((x) => x.grade === grade)) byDept.set(p.dept, (byDept.get(p.dept) || 0) + p.hours);
    for (const [dept, need] of byDept) {
      const pool = teachers.filter((t) => !t.virtual && (t.dept === dept || t.extra.includes(dept)));
      const n = pool.length || 0;
      // 교사 한 명이 이 학년 반 수업에 쓸 수 있는 칸 = 반 수업 칸의 합집합(점심 한 칸/일 빼기 전)
      const capOne = union.size;
      const cap = n * capOne;
      if (!n) out.push({ code: "no-teacher", grade, semester: sem.semester, dept, need, capacity: 0, message: `${grade}학년 ${DEPT_NAME(dept)} 반 수업 ${need}시간: 맡을 교사 없음`, fix: "교사 배정(순회·강사·겸임) 필요" });
      else if (need > cap) out.push({ code: "grade-capacity", grade, semester: sem.semester, dept, need, capacity: cap, perTeacher: capOne, teachers: n, message: `${grade}학년 ${DEPT_NAME(dept)} 반 수업 ${need}시간 > 교사 ${n}명 × 반 수업 칸 ${capOne}`, fix: `교사 ${Math.ceil(need / capOne) - n}명 더 또는 반군 엇갈림으로 반 수업 칸 늘리기(블록 1개 엇갈리면 +4칸)` });
      else if (pool.length === 1 && need > capOne - 0) out.push({ code: "single-teacher", grade, semester: sem.semester, dept, need, capacity: capOne, message: `${grade}학년 ${DEPT_NAME(dept)} 교사 1명이 ${need}시간 > 반 수업 칸 ${capOne}`, fix: "엇갈림 블록 추가" });
    }
  }
  // 블록 시간마다 분반 수 ≤ 가능 교사 수(같은 학기 다른 학년 블록과 겹치는 칸 포함)
  const byTime = new Map();
  for (const s of sem.sections) for (const a of s.abs) { const fam = /-공통$/.test(s.dept) ? familyOf(s.dept) : s.dept; const k = `${a}|${fam}`; byTime.set(k, (byTime.get(k) || 0) + 1); }
  for (const [k, n] of byTime) {
    const [a, fam] = k.split("|");
    const pool = teachers.filter((t) => !t.virtual && (t.dept === fam || t.extra.includes(fam) || familyOf(t.dept) === fam && !fam.includes("-")));
    if (n > pool.length) out.push({ code: "block-teachers", semester: sem.semester, time: absName(Number(a)), dept: fam, need: n, capacity: pool.length, message: `${absName(Number(a))} ${DEPT_NAME(fam)} 분반 ${n}개 > 교사 ${pool.length}명`, fix: "블록 시간 옮기기 또는 분반 줄이기" });
  }
  return out;
}

// ---------- 실행 ----------
const STRUCT = process.env.STRUCT || "C0";
function STRUCT_SPEC() {
  if (STRUCT === "C0") return null;
  if (STRUCT.startsWith("C1")) return { grade: "3", groups: [[2, 4, 8, 10], [1, 3, 5, 7, 9, 11], [6]], names: ["가", "나", "다"], k: Number(STRUCT.slice(3) || 1), kind: "반편성 형별(지식/발명 4 · 인공/소프트 6 · 인공/발명 1)" };
  if (STRUCT.startsWith("C2")) return { grade: "3", groups: [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11]], names: ["가", "나"], k: Number(STRUCT.slice(3) || 1), kind: "형을 섞은 반군(1~6반 / 7~11반)" };
  if (STRUCT.startsWith("C3")) return { grade: "3", groups: [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11]], names: ["가", "나", "다"], k: Number(STRUCT.slice(3) || 1), kind: "형을 섞은 반군 3개(1~4 / 5~8 / 9~11반)" };
  if (STRUCT.startsWith("G")) {
    // 일반: GROUPS="1-4|5-8|9-11" 또는 "2,4,8,10|1,3,5|..." , STRUCT 끝 k
    const groups = String(process.env.TGROUPS).split("|").map((part) => part.split(",").flatMap((x) => { const m = x.match(/^(\d+)-(\d+)$/); if (m) { const out = []; for (let i = Number(m[1]); i <= Number(m[2]); i += 1) out.push(i); return out; } return [Number(x)]; }));
    const names = "가나다라마바사".split("").slice(0, groups.length);
    return { grade: "3", groups, names, k: Number(STRUCT.match(/k(\d+)/)?.[1] || 1), kind: `반군 ${groups.length}개(${groups.map((g) => g.join(",")).join(" / ")})` };
  }
  throw new Error("STRUCT?");
}
const result = { generatedAt: new Date().toISOString(), year: IN.year, days: DAYS, periods: P, roomLimits: ROOM_LIMITS, schoolName: IN.schoolName, teachers: null, semesters: [], struct: STRUCT };
const SEMS = (process.env.SEMS || "1,2").split(",");
for (const semester of SEMS) {
  const sem = buildSemester(semester);
  const chk = check3(sem);
  const pre = precheck(sem);
  result.semesters.push({ ...sem, checks: chk, precheck: pre });
  const R = chk.rules; const st = chk.students;
  const hard = chk.classConflicts.length + chk.teacherConflicts.length + chk.unavailable.length + R.runOver.length + R.noLunch.length + R.lesson2.length + chk.classHoles.length + st.overlaps.length + st.missingBlock + st.holes;
  console.log(`[${STRUCT}] ${semester}학기 필수위반 ${hard}: 교사겹침 ${chk.teacherConflicts.length} 반공강 ${chk.classHoles.length} 학생공강 ${st.holes} 학생겹침 ${st.overlaps.length} 블록빠짐 ${st.missingBlock} 규칙1 ${R.runOver.length} 규칙2 ${R.noLunch.length} 규칙4 ${R.lesson2.length} 불가 ${chk.unavailable.length} | 공강충족 ${R.lunchGood}/${R.lunchDays} 규칙3 ${R.teacherSubjExcess} 규칙5 ${R.homeroom.ok}/${R.homeroom.applies} | 분반 ${sem.structure.sectionsBefore}→${sem.structure.sectionsAfter} 학생이동 ${sem.structure.studentsMoved} 블록칸이동 ${sem.structure.blockSlotsMoved} 분반교사변경 ${sem.structure.sectionTeacherChanged} | ${sem.solver.ms}ms it ${sem.solver.iterations} cost ${Math.round(sem.solver.initialCost)}→${Math.round(sem.solver.finalCost)} | 사전점검 ${pre.map((x) => x.code + ":" + (x.dept || "") + x.grade).join(",")}`);
  result.semesters[result.semesters.length - 1].hard = hard;
}
result.teachers = teachers.map((t) => ({ id: t.id, name: t.name, dept: t.dept, deptName: DEPT_NAME(t.dept) + (t.extra?.length ? "·" + t.extra.map(DEPT_NAME).join("·") : ""), unavailable: [...t.unavailable].map(absName), reason: t.reason, virtual: t.virtual, added: Boolean(t.added) }));
result.staff = STAFF; result.abs = { labels: ABS_LABELS, lunch: LUNCH_ABS, map: ABS_MAP }; result.homeroom = Object.fromEntries(HOMEROOM);
const outName = `v3-${STRUCT}${STAFF !== 1 ? "-staff" + STAFF : ""}${process.env.RELAXTAG ? "-" + process.env.RELAXTAG : ""}${process.env.SEMS ? "-sem" + process.env.SEMS.replace(",", "") : ""}.json`;
fs.mkdirSync(path.join(OUT_DIR, "v3"), { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "v3", outName), JSON.stringify(result));
console.log("saved", outName);
