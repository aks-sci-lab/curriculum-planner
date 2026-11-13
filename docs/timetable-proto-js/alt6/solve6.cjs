// 실험(alt6): 3학년 택5 + 학급 단위 택1 → 한 그룹(블록 6개)으로 합쳐 6단계 순수 함수로 분반 편성하고, 그 결과로 7단계 시간표 입력(조건별 inputs.json)을 만든다.
// 사용: node solve6.cjs <wt-tt> <alt6 폴더> [블록당 최대 분반=11] [꼬리표=""]
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = process.argv[2], OUT = process.argv[3], MAXB = Number(process.argv[4]) || 11, TAG = process.argv[5] || "";
const d = JSON.parse(fs.readFileSync(path.join(OUT, "dump.json"), "utf8"));
const ctx = vm.createContext({ console });
vm.runInContext(fs.readFileSync(path.join(ROOT, "class-sections.js"), "utf8"), ctx);
const plain = (value) => JSON.parse(JSON.stringify(value));
const CAP = d.maxClassSize || 34;
const TECH = { id: "t-기술가정-1", name: "기술·가정 1", departments: ["기술가정"], courses: [], unavailable: [] };
const summary = { maxSectionsPerBlock: MAXB, semesters: {} };
const merged = {};

for (const semester of ["1", "2"]) {
  const g5 = d.groups.find((g) => g.grade === "2" && g.semester === semester && g.choice === 5);
  const g1 = d.groups.find((g) => g.grade === "2" && g.semester === semester && g.choice === 1);
  const g2 = d.groups.filter((g) => g.grade === "1" && g.semester === semester && g.result?.sections?.length);
  const pick = new Map(g1.rawStudents.map((s) => [s.key, s.courses]));
  const extraCourses = g1.input.courses.map((course) => {
    const enrollment = g1.courses.find((item) => item.key === course.key).enrollment;
    return { ...course, mode: "move", sections: Math.ceil(enrollment / CAP), capacity: CAP, capacities: [], wasClassUnit: course.sections, enrollment };
  });
  const teachers = [...plain(g5.input.teachers), ...(g5.input.teachers.some((t) => t.id === TECH.id) ? [] : [plain(TECH)])];
  const input = {
    ...plain(g5.input), label: `${g5.label} + 택1(블록 6)`,
    blocks: Array.from({ length: 6 }, (_, index) => ({ id: "abcdef"[index], maxSections: MAXB, times: [] })), maxSectionsPerBlock: MAXB,
    courses: [...plain(g5.input.courses), ...extraCourses.map(({ wasClassUnit, enrollment, ...course }) => course)],
    students: g5.input.students.map((student) => ({ ...student, courses: [...student.courses, ...(pick.get(student.key) || [])] })),
    choose: 6, cohortTimes: [], occupied: [], teachers, timeLimitMs: 120000, seed: 1,
    pins: { sections: {}, students: {}, teachers: {} }
  };
  delete input.classUnit; delete input.baseline; delete input.previous;
  const started = Date.now();
  const result = plain(ctx.classSectionsSolve(input));
  const ms = Date.now() - started;
  // 교사: 같은 학기 2학년 그룹의 저장된 배정(고정)과 함께 다시 배정(앱의 '전 학년 함께'와 같은 함수, 블록 시간 없음 → 같은 블록 겹침·시수 균형만)
  const courseOf = new Map(input.courses.map((course) => [course.key, course]));
  const own = result.sections.map((section) => ({ id: `${input.groupId}::${section.id}`, courseKey: section.courseKey, courseName: section.courseName, department: courseOf.get(section.courseKey)?.department || "",
    credits: courseOf.get(section.courseKey)?.credits || 0, blockKey: `${input.groupId}:${section.blockId}`, times: [], label: `${section.blockLetter}블록 ${section.ord}반` }));
  const others = []; const pins = {};
  for (const g of g2) {
    const cOf = new Map(g.input.courses.map((course) => [course.key, course]));
    for (const section of g.result.sections) {
      const id = `${g.input.groupId}::${section.id}`;
      others.push({ id, courseKey: section.courseKey, courseName: section.courseName, department: cOf.get(section.courseKey)?.department || "", credits: cOf.get(section.courseKey)?.credits || 0, blockKey: `${g.input.groupId}:${section.blockId}`, times: [] });
      const teacherId = section.teacherId || g.result.teacherOf?.[section.id];
      if (teacherId) pins[id] = teacherId;
    }
  }
  // 그 2학년 그룹 교사 명단에서 더한 담당 과목(공통 과목 배분)도 합친다
  const joint = new Map(teachers.map((t) => [t.id, plain(t)]));
  for (const g of g2) for (const t of g.input.teachers) { const have = joint.get(t.id); if (!have) { joint.set(t.id, plain(t)); continue; } for (const x of t.departments) if (!have.departments.includes(x)) have.departments.push(x); for (const x of t.courses) if (!have.courses.includes(x)) have.courses.push(x); }
  let assigned = plain(ctx.classSectionsAssignTeachers({ teachers: [...joint.values()], sections: [...others.filter((s) => pins[s.id]), ...own], fixedSlots: [], pins, previous: {} }));
  // 2학년 블록 3 + 3학년 블록 6 = 36칸 > 주 33칸: 2학년 블록 하나와 3학년 블록 하나는 같은 시간에 열려야 하므로 그 두 블록은 교사가 겹치지 않아야 한다.
  const sharedPairs = (teacherOf) => { const of = {}; for (const s of [...others, ...own]) { const t = teacherOf[s.id]; if (t) (of[s.blockKey] ||= new Set()).add(t); }
    const mine = [...new Set(own.map((s) => s.blockKey))], theirs = [...new Set(others.map((s) => s.blockKey))]; const free = [];
    for (const x of theirs) for (const y of mine) if (![...(of[x] || [])].some((t) => of[y]?.has(t))) free.push(`${x} × ${y}`);
    return { pairs: theirs.length * mine.length, free }; };
  let disjoint = { before: sharedPairs(assigned.teacherOf).free.length, tried: 0, chosen: "" };
  const FORCE = process.argv[7] || ""; // "a:a" = 두 학기 모두 2학년 a블록 × 3학년 a블록을 교사가 겹치지 않게(두 학기 뼈대용)
  if (process.argv[6] === "disjoint" && (FORCE ? !sharedPairs(assigned.teacherOf).free.some((pair) => pair.split(" × ").map((key) => key.slice(-1)).join(":") === FORCE) : !disjoint.before)) {
    const pseudo = [{ day: "월", period: 1 }];
    let best = null;
    for (const x of [...new Set(others.map((s) => s.blockKey))]) for (const y of [...new Set(own.map((s) => s.blockKey))]) {
      if (FORCE && `${x.slice(-1)}:${y.slice(-1)}` !== FORCE) continue;
      const withTimes = (list) => list.map((s) => ({ ...s, times: s.blockKey === x || s.blockKey === y ? pseudo : [] }));
      const trial = plain(ctx.classSectionsAssignTeachers({ teachers: [...joint.values()], sections: [...withTimes(others.filter((s) => pins[s.id])), ...withTimes(own)], fixedSlots: [], pins, previous: {} }));
      const missing = own.filter((s) => !trial.teacherOf[s.id]).length; const hard = trial.issues.filter((issue) => issue.severity === "error").length;
      disjoint.tried += 1;
      const loads = Object.values(trial.load); const spread = Math.max(...loads) - Math.min(...loads.filter((v) => v > 0));
      if (!best || missing + hard < best.missing + best.hard || (missing + hard === best.missing + best.hard && spread < best.spread)) best = { trial, missing, hard, spread, pair: `${x} × ${y}` };
    }
    if (best) { assigned = best.trial; disjoint.chosen = best.pair; disjoint.missing = best.missing; disjoint.hard = best.hard; disjoint.after = sharedPairs(assigned.teacherOf).free.length; }
  }
  for (const section of result.sections) section.teacherId = assigned.teacherOf[`${input.groupId}::${section.id}`] || "";
  result.teacherOf = Object.fromEntries(result.sections.filter((s) => s.teacherId).map((s) => [s.id, s.teacherId]));

  // ---- 6단계 요약(숫자만) ----
  const sizeOf = {}; // 분반 인원
  for (const list of Object.values(result.assign || {})) for (const id of list) sizeOf[id] = (sizeOf[id] || 0) + 1;
  const byCourse = {};
  for (const section of result.sections) {
    const row = byCourse[section.courseKey] || (byCourse[section.courseKey] = { sections: 0, sizes: [], blocks: [], noTeacher: 0, department: courseOf.get(section.courseKey)?.department });
    row.sections += 1; row.sizes.push(sizeOf[section.id] ?? section.size ?? 0); row.blocks.push(section.blockLetter); if (!section.teacherId) row.noTeacher += 1;
  }
  const blockCounts = Object.fromEntries(result.blocks.map((block) => [block.letter, block.sectionIds.length]));
  const deptPerBlock = {};
  for (const section of result.sections) { const dep = courseOf.get(section.courseKey)?.department; if (!/정보|기술가정/.test(dep)) continue; (deptPerBlock[dep] ||= {})[section.blockLetter] = ((deptPerBlock[dep] || {})[section.blockLetter] || 0) + 1; }
  const before = g5.result;
  const loadOf = (dep) => Object.fromEntries([...joint.values()].filter((t) => t.departments.includes(dep)).map((t) => [t.id, assigned.load[t.id] || 0]));
  summary.semesters[semester] = {
    ms, students: input.students.length, unassigned: result.unassigned.length, unassignedStudents: new Set(result.unassigned.map((u) => u.studentKey)).size,
    sectionsBefore: { move: before.sections.length, classUnit: g1.input.courses.reduce((sum, c) => sum + c.sections, 0) }, sectionsAfter: result.sections.length,
    extra: extraCourses.map((c) => ({ course: c.key, enrollment: c.enrollment, classUnitBefore: c.wasClassUnit, sectionsAfter: c.sections, sizes: byCourse[c.key]?.sizes, blocks: byCourse[c.key]?.blocks.join(""), noTeacher: byCourse[c.key]?.noTeacher })),
    blockCounts, blockCountsBefore: Object.fromEntries(before.blocks.map((b) => [b.letter, b.sectionIds.length])),
    noTeacherSections: result.sections.filter((s) => !s.teacherId).length, noTeacherBefore: before.sections.filter((s) => !s.teacherId).length,
    noTeacherByCourse: Object.fromEntries(Object.entries(byCourse).filter(([, row]) => row.noTeacher).map(([key, row]) => [key, `${row.noTeacher}/${row.sections} (${row.department})`])),
    disjoint, deptPerBlock, teacherIssues: assigned.issues.map((issue) => `${issue.type}/${issue.severity}: ${issue.message}`),
    load: { 정보: loadOf("정보"), 기술가정: loadOf("기술가정") },
    sizes: { min: Math.min(...Object.values(byCourse).flatMap((row) => row.sizes)), max: Math.max(...Object.values(byCourse).flatMap((row) => row.sizes)), small: Object.entries(byCourse).flatMap(([key, row]) => row.sizes.filter((n) => n < 15).map((n) => `${key} ${n}`)) },
    metrics: result.metrics, metricsBefore: before.metrics, hardIssues: (result.issues || []).filter((issue) => issue.severity === "error").map((issue) => `${issue.type}: ${String(issue.message).slice(0, 160)}`),
    issueTypes: (result.issues || []).reduce((acc, issue) => { acc[`${issue.type}/${issue.severity}`] = (acc[`${issue.type}/${issue.severity}`] || 0) + 1; return acc; }, {}),
    explain: result.explain ? { feasible: result.explain.feasible, summary: result.explain.summary } : null, stats: result.stats
  };
  merged[semester] = { g5, g1, input, result };
  fs.writeFileSync(path.join(OUT, `six-result${TAG}-${semester}.json`), JSON.stringify({ input, result }));
}
fs.writeFileSync(path.join(OUT, `six-summary${TAG}.json`), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));

// ---- 7단계 입력 만들기: 3학년 블록을 6개로 바꾸고 택1 반 수업을 뺀다 ----
for (const [name, variant] of Object.entries(d.variants)) {
  const next = plain(variant);
  next.set = { ...next.set, alt: "block6", maxSectionsPerBlock: MAXB };
  for (const semester of ["1", "2"]) {
    const { g5, g1, input, result } = merged[semester];
    const tt = next.semesters[semester];
    const oldSections = tt.blocks.filter((block) => block.id.startsWith(`${g5.key}|`)).flatMap((block) => block.sections);
    const removedLessons = tt.lessons.filter((lesson) => lesson.id.startsWith(`${g1.key}|`));
    const candidates = new Map(); // 교과 → 교사 후보(앱이 만든 값 그대로)
    for (const section of oldSections) if (section.teacherIds) candidates.set(section.department, section.teacherIds);
    for (const lesson of removedLessons) candidates.set(lesson.department, lesson.teacherIds);
    const freeDepartments = new Set(oldSections.filter((section) => !section.teacherId).map((section) => section.department)); // 기준 입력에서 교사를 정하지 않고 후보로 넘긴 교과(공통 과목)는 그대로 후보로
    const courseOf = new Map(input.courses.map((course) => [course.key, course]));
    tt.lessons = tt.lessons.filter((lesson) => !lesson.id.startsWith(`${g1.key}|`));
    const blocks = result.blocks.map((block) => ({ id: `${g5.key}|${block.letter}`, grade: "3", label: `택6 ${block.letter}블록`, times: "",
      sections: block.sectionIds.map((id) => {
        const section = result.sections.find((item) => item.id === id); const course = courseOf.get(section.courseKey);
        const out = { id: `${g5.key}|${id}`, subject: course.name, department: course.department, credits: course.credits, venue: "" };
        if (section.teacherId && !freeDepartments.has(course.department)) out.teacherId = section.teacherId; else out.teacherIds = candidates.get(course.department) || tt.teachers.filter((t) => t.departments.includes(course.department)).map((t) => t.id);
        return out;
      }) }));
    const at = tt.blocks.findIndex((block) => block.id.startsWith(`${g5.key}|`));
    tt.blocks = [...tt.blocks.slice(0, at), ...blocks, ...tt.blocks.slice(at).filter((block) => !block.id.startsWith(`${g5.key}|`))];
    if (tt.notes?.staleSections) tt.notes.staleSections = tt.notes.staleSections.filter((label) => label !== g5.label);
  }
  const dir = path.join(OUT, `alt${TAG}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "inputs.json"), JSON.stringify(next));
}
console.log("inputs written");
