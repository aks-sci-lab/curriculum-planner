
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
