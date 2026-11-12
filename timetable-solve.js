// 7단계 시간표 풀이기(timetable-solve.js): 순수 계산(DOM·state 없음, timetable.js 다음에 로드, Worker에서도 그대로 동작).
// 설계: docs/timetable-design.md 3·4절. 입력은 학기별 timetableModel 입력({ "1": 입력, "2": 입력 } — 한 학기만 줘도 된다).
// 절대 조건(탐색 중에도 깨지 않음): 한 반·한 교사는 한 시간에 하나, 교사 불가 시간, 장소 수용, 전공 일치(교사 후보 안에서만).
// 설정 조건(반드시/최대한/끔): 반 공강, 같은 교사 같은 반 하루 한 번, 연강, 하루 최대, 교사 점심 — 남으면 '위반 목록'으로 돌려준다(자동으로 풀지 않음).
// 항상 결과: 교사를 붙일 수 없는 수업은 '담당 교사 없음'으로 반 시간표에 넣는다.
// 두 학기 뼈대(rules.semesterFrame = hard): 이어지는 수업(같은 반·같은 교과·같은 시수)·블록·창체를 '두 학기 묶음'으로 만들어 같은 칸에 놓는다.
// 차례: 문제 만들기(timetableProblem) → 상태·놓기·비용 → 구성 → 탐색(Start/Step/Finish) → 결과 → 검증기(timetableValidate, 풀이기와 따로 계산) → Worker.

var TIMETABLE_SOLVE_VERSION = 1;
// 비용: 반드시 = 1000 이상, 최대한 = 규칙별 작은 값, 끔 = 0. 못 넣은 수업 1시간 = 20000.
// '반드시' 조건끼리 부딪칠 때의 순서: 반 공강(3000) > 같은 교사 하루 두 번(2000) > 교사 연강·하루 최대·점심(1000).
// (블록을 빈틈없이 붙이면 블록 교사의 연강이 늘고, 연강을 줄이려 블록을 흩으면 그 칸은 반 전체의 공강이 된다 — 학생 공강을 먼저 막는다.)
var TIMETABLE_HARD_WEIGHTS = { gap: 3000, oncePerDay: 2000 };
var TIMETABLE_SOFT_WEIGHTS = { gap: 30, oncePerDay: 20, run: 12, maxPerDay: 12, lunch: 25, lunchSide: 2, sameSubjectDay: 1 };
var TIMETABLE_UNPLACED_WEIGHT = 20000;
var TIMETABLE_DEFAULT_ROUNDS = 12; // 흔들기 최대 횟수(한 번 = 기본 횟수의 절반)
var TIMETABLE_DEFAULT_ITERATIONS = 600000; // 학기 층마다(두 학기 함께면 2배). 실제 크기 학교에서 한 학기 약 3초·두 학기 약 10초

function timetableRng(seed) {
  let a = (Number(seed) || 1) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function timetableRuleWeight(rules, name) {
  const level = rules[name];
  return level === "hard" ? TIMETABLE_HARD_WEIGHTS[name] || 1000 : level === "soft" ? TIMETABLE_SOFT_WEIGHTS[name] || 1 : 0;
}

// ---- 문제 만들기 ----
// 활동(act) 종류: 0 = 반 수업(한 반, 교사 0~1명), 1 = 블록(학년·반군 전체, 분반 교사 여럿), 2 = 창체(전교·학년).
// act.layers = 이 활동이 들어가는 학기 층 번호들. 두 층이면 '두 학기 묶음'(같은 칸).
function timetableProblem(inputs) {
  const keys = Object.keys(inputs || {}).filter((key) => inputs[key]).sort();
  if (!keys.length) throw new Error("시간표 입력이 없습니다.");
  const models = keys.map((key) => (inputs[key].gradeOf instanceof Map ? inputs[key] : timetableModel(inputs[key])));
  const base = models[0];
  const rules = base.rules;
  const days = base.days;
  const D = days.length;
  const positions = base.positions;
  const ABS = D * positions;
  const grid = base.grades[0] ? base.grades[0].slots : [];
  const S = grid.length;
  const slotKey = grid.map((slot) => slot.key);
  const slotDay = grid.map((slot) => slot.d);
  const slotPeriod = grid.map((slot) => slot.period);
  const slotIndex = new Map(slotKey.map((key, index) => [key, index]));
  const slotsByDay = days.map((_, d) => grid.map((slot, index) => (slot.d === d ? index : -1)).filter((index) => index >= 0));
  const grades = base.grades.map((grade) => grade.grade);
  const gradeIndex = new Map(grades.map((grade, index) => [grade, index]));
  const absOf = base.grades.map((grade) => Int16Array.from(grade.slots.map((slot) => slot.abs)));
  const classIds = base.grades.flatMap((grade) => grade.classes);
  const classIndex = new Map(classIds.map((id, index) => [id, index]));
  const classGrade = base.grades.flatMap((grade, gi) => grade.classes.map(() => gi));
  const teacherIds = [...new Set(models.flatMap((model) => model.teachers.map((teacher) => teacher.id)))];
  const teacherIndex = new Map(teacherIds.map((id, index) => [id, index]));
  const T = teacherIds.length;
  const L = keys.length;
  const blocked = models.map((model) => {
    const table = new Uint8Array(T * ABS);
    for (const teacher of model.teachers) { const ti = teacherIndex.get(teacher.id); for (const abs of teacher.blocked) if (abs >= 0 && abs < ABS) table[ti * ABS + abs] = 1; }
    return table;
  });
  const prechecks = models.map((model) => timetablePrecheck(model));
  const capacity = prechecks.map((check) => { const table = new Float64Array(T).fill(0); for (const row of check.teachers) table[teacherIndex.get(row.id)] = row.capacity; return table; });
  // 학년마다 반 수업 칸 수(주 칸 − 블록 − 창체): 한 교사가 그 학년 반 수업으로 설 수 있는 시간의 한계(한 칸에 한 반)
  const gradeFree = prechecks.map((check) => grades.map((grade) => { const row = check.grades.find((item) => item.grade === grade); return row && Number.isFinite(row.free) ? row.free + (models[0].creative.byGroup ? row.creative : 0) : Infinity; }));
  const gradeLoad = models.map(() => new Map()); // 교사|학년 → 그 학년 반 수업 시수
  const softHours = Number(rules.maxHours) > 0 ? Number(rules.maxHours) : 22;
  const teacherName = teacherIds.map((id) => models.map((model) => model.teacherOf.get(id)).find(Boolean)?.name || id);
  const homeroomOf = new Map(); // 반 → 담임 교사
  for (const teacher of base.teachers) if (teacher.homeroom && classIndex.has(teacher.homeroom)) homeroomOf.set(classIndex.get(teacher.homeroom), teacherIndex.get(teacher.id));
  const venueNames = [...new Set(models.flatMap((model) => Object.keys(model.venues)))];
  const venueIndex = new Map(venueNames.map((name, index) => [name, index]));
  const venueCap = venueNames.map((name) => Math.min(...models.map((model) => (Number.isFinite(Number(model.venues[name])) ? Number(model.venues[name]) : Infinity))));
  const frame = L > 1 && rules.semesterFrame === "hard";
  const subjects = [];
  const subjectIndex = new Map();
  const subjectOf = (name) => { if (!subjectIndex.has(name)) { subjectIndex.set(name, subjects.length); subjects.push(name); } return subjectIndex.get(name); };
  const teachersOf = (list) => list.map((id) => teacherIndex.get(id)).filter((ti) => ti !== undefined);
  const acts = [];
  const notes = [];
  const load = models.map(() => new Float64Array(T));

  // 반 수업: 층마다 모으고, 뼈대가 '반드시'면 같은 반의 이어지는 수업을 한 활동으로 묶는다.
  const rawLessons = models.map((model, layer) => model.lessons.map((lesson) => ({ layer, id: lesson.id, ci: classIndex.get(lesson.classId), gi: gradeIndex.get(lesson.grade), subject: lesson.subject, department: lesson.department,
    hours: lesson.hours, cands: teachersOf(lesson.candidates), fixed: lesson.fixedTeacher ? teacherIndex.get(lesson.fixedTeacher) : -1, venue: lesson.venue, double: lesson.double, part: lesson.part })).filter((lesson) => lesson.ci !== undefined));
  const lessonAct = (items) => {
    const first = items[0];
    const cands = items.length > 1 ? first.cands.filter((ti) => items[1].cands.includes(ti)) : first.cands.slice();
    const fixed = items.map((item) => item.fixed).find((ti) => ti >= 0) ?? -1;
    return { kind: 0, layers: items.map((item) => item.layer), classes: [first.ci], gi: first.gi, hours: first.hours, ids: items.map((item) => item.id), subject: items.map((item) => subjectOf(item.subject)),
      subjectName: items.map((item) => item.subject), department: first.department, cands, fixed, teacher: -1, venue: items.map((item) => (item.venue && venueIndex.has(item.venue) ? venueIndex.get(item.venue) : -1)), double: items.some((item) => item.double) };
  };
  if (frame) {
    const left = rawLessons[1].slice();
    const take = (lesson, same) => {
      const at = left.findIndex((other) => other.ci === lesson.ci && other.hours === lesson.hours && same(other) && (lesson.fixed < 0 || other.fixed < 0 || lesson.fixed === other.fixed)
        && (lesson.cands.some((ti) => other.cands.includes(ti)) || (!lesson.cands.length && !other.cands.length)));
      return at >= 0 ? left.splice(at, 1)[0] : null;
    };
    const pairs = new Map();
    for (const lesson of rawLessons[0]) { const mate = take(lesson, (other) => other.subject === lesson.subject && other.department === lesson.department && other.part === lesson.part); if (mate) pairs.set(lesson, mate); }
    for (const lesson of rawLessons[0]) { if (pairs.has(lesson)) continue; const mate = take(lesson, (other) => other.department === lesson.department); if (mate) pairs.set(lesson, mate); }
    for (const lesson of rawLessons[0]) acts.push(lessonAct(pairs.has(lesson) ? [lesson, pairs.get(lesson)] : [lesson]));
    for (const lesson of left) acts.push(lessonAct([lesson]));
  } else {
    for (const list of rawLessons) for (const lesson of list) acts.push(lessonAct([lesson]));
  }

  // 블록: 분반 교사는 6단계 값(확정), 없으면 후보 안에서 서로 다른 교사로 맞춘다. 맡을 교사가 없는 분반은 담당 교사 없음.
  const rawBlocks = models.map((model, layer) => model.blocks.map((block) => {
    const times = [...new Set(block.times.map((time) => slotIndex.get(`${time.day}${time.period}`)).filter((index) => index !== undefined))];
    const seen = new Set();
    const sections = block.sections.map((section) => {
      let teacher = section.fixedTeacher ? teacherIndex.get(section.fixedTeacher) : -1;
      if (teacher >= 0 && seen.has(teacher)) { notes.push(`${keys[layer]}학기 ${block.grade}학년 ${block.label}: ${teacherName[teacher]} 교사가 두 분반에 배정돼 있어 한 분반은 담당 교사 없음으로 두었습니다.`); teacher = -1; }
      if (teacher >= 0) seen.add(teacher);
      return { id: section.id, subject: section.subject, cands: teachersOf(section.candidates), teacher, hours: section.hours, venue: section.venue && venueIndex.has(section.venue) ? venueIndex.get(section.venue) : -1, fixed: teacher >= 0 };
    });
    // 한 블록 안에서 같은 특별실을 쓰는 분반이 실 수보다 많으면(6단계 자료 문제, 사전 점검 P8) 실 수만큼만 장소를 잡는다.
    const venueUse = new Map();
    for (const section of sections) {
      if (section.venue < 0) continue;
      venueUse.set(section.venue, (venueUse.get(section.venue) || 0) + 1);
      if (venueUse.get(section.venue) > venueCap[section.venue]) section.venue = -1;
    }
    const open = sections.filter((section) => section.teacher < 0);
    const adjacency = open.map((section) => section.cands.filter((ti) => !seen.has(ti)).sort((a, b) => load[layer][a] - load[layer][b] || a - b));
    const matched = timetableMatch(adjacency).matchOfLeft;
    open.forEach((section, index) => { if (matched[index] !== undefined) section.teacher = matched[index]; });
    for (const section of sections) if (section.teacher >= 0) load[layer][section.teacher] += block.hours;
    return { layer, id: block.id, gi: gradeIndex.get(block.grade), label: block.label, hours: block.hours, classes: block.classIds.map((id) => classIndex.get(id)).filter((ci) => ci !== undefined), sections,
      fixedSlots: times.length >= block.hours ? times.slice(0, block.hours) : null };
  }));
  // 두 학기 묶음 블록: 정해진 블록 시간이 학기마다 다르면 앞 학기 자리를 따른다(뼈대가 먼저) — 바뀐 학기는 overridden으로 표시.
  const blockAct = (items) => {
    const fixedSlots = items.map((item) => item.fixedSlots).find(Boolean) || null;
    const overridden = items.map((item) => Boolean(item.fixedSlots && fixedSlots && item.fixedSlots.slice().sort().join(",") !== fixedSlots.slice().sort().join(",")));
    items.forEach((item, at) => { if (overridden[at]) notes.push(`${keys[item.layer]}학기 ${grades[item.gi]}학년 ${item.label}: 두 학기 뼈대를 맞추려고 6단계 블록 시간 대신 ${keys[items[0].layer]}학기 자리를 씁니다.`); });
    return { kind: 1, layers: items.map((item) => item.layer), classes: items[0].classes, gi: items[0].gi, hours: items[0].hours, ids: items.map((item) => item.id), labels: items.map((item) => item.label),
      sections: items.map((item) => item.sections), fixedSlots, overridden, ownFixed: items.map((item) => item.fixedSlots) };
  };
  if (frame) {
    // 짝 = 같은 학년·같은 반·같은 시간 수. 정해진 블록 시간이 많이 겹치는 것끼리 먼저 짝지어 6단계 시간을 최대한 지킨다.
    const left = rawBlocks[1].slice().sort((a, b) => String(a.label).localeCompare(String(b.label), "ko"));
    const overlap = (a, b) => (a.fixedSlots && b.fixedSlots ? a.fixedSlots.filter((slot) => b.fixedSlots.includes(slot)).length : 0);
    for (const block of rawBlocks[0].slice().sort((a, b) => String(a.label).localeCompare(String(b.label), "ko"))) {
      let at = -1;
      left.forEach((other, index) => {
        if (other.gi !== block.gi || other.hours !== block.hours || other.classes.join(",") !== block.classes.join(",")) return;
        if (at < 0 || overlap(block, other) > overlap(block, left[at])) at = index;
      });
      acts.push(blockAct(at >= 0 ? [block, left.splice(at, 1)[0]] : [block]));
    }
    for (const block of left) acts.push(blockAct([block]));
  } else for (const list of rawBlocks) for (const block of list) acts.push(blockAct([block]));

  // 창체: 전교 동시(모든 반·모든 교사), 학년별(그 학년 모든 반·담임), 반군별 허용이면 반마다 따로(담임).
  const creativeLayers = frame ? [keys.map((_, layer) => layer)] : keys.map((_, layer) => [layer]);
  for (const layers of creativeLayers) {
    const creative = models[layers[0]].creative;
    const toSlots = (times, hours) => { const list = [...new Set(times.map((time) => slotIndex.get(`${time.day}${time.period}`)).filter((index) => index !== undefined))]; return hours > 0 && list.length >= hours ? list.slice(0, hours) : null; };
    if (creative.school > 0) {
      const fixedSlots = toSlots(creative.schoolTimes, creative.school);
      acts.push({ kind: 2, layers, classes: classIds.map((_, ci) => ci), gi: -1, hours: creative.school, scope: "school", fixedSlots, everyone: true, premarked: Boolean(fixedSlots) });
    }
    base.grades.forEach((grade, gi) => {
      const own = creative.byGrade[grade.grade];
      if (!own || !(own.grade > 0) || !grade.classes.length) return;
      const classes = grade.classes.map((id) => classIndex.get(id));
      if (creative.byGroup) {
        for (const ci of classes) acts.push({ kind: 0, creative: true, layers, classes: [ci], gi, hours: own.grade, ids: layers.map(() => `창체@${classIds[ci]}`), subject: layers.map(() => subjectOf("창체")), subjectName: layers.map(() => "창체"),
          department: "창체", cands: [], fixed: -1, teacher: homeroomOf.has(ci) ? homeroomOf.get(ci) : -1, venue: layers.map(() => -1), double: false });
      } else {
        acts.push({ kind: 2, layers, classes, gi, hours: own.grade, scope: "grade", fixedSlots: toSlots(own.times, own.grade), homerooms: classes.map((ci) => homeroomOf.get(ci)).filter((ti) => ti !== undefined) });
      }
    });
  }

  // 반 수업 교사 정하기: 후보(전공 일치) 안에서 시수가 고르게, 설 수 있는 시간 안에서. 맡을 교사가 없으면 담당 교사 없음.
  const pairHours = new Map(); // 층|반|교사 → 그 반에 들어가는 주당 시수
  const lessonActs = acts.filter((act) => act.kind === 0 && !act.creative);
  const noTeacher = [];
  const order = lessonActs.slice().sort((a, b) => (a.fixed >= 0 ? -1 : 0) - (b.fixed >= 0 ? -1 : 0) || a.cands.length - b.cands.length || b.hours - a.hours || acts.indexOf(a) - acts.indexOf(b));
  for (const act of order) {
    const options = act.fixed >= 0 ? [act.fixed] : act.cands;
    let best = -1;
    let bestScore = Infinity;
    for (const ti of options) {
      if (act.layers.some((layer) => load[layer][ti] + act.hours > capacity[layer][ti] || (gradeLoad[layer].get(`${ti}|${act.gi}`) || 0) + act.hours > gradeFree[layer][act.gi])) continue;
      let score = Math.max(...act.layers.map((layer) => (load[layer][ti] + act.hours) / softHours));
      const together = Math.max(...act.layers.map((layer) => pairHours.get(`${layer}|${act.classes[0]}|${ti}`) || 0)) + act.hours;
      if (together > D && rules.oncePerDay !== "off") score += 5;
      if (rules.homeroom !== "off" && homeroomOf.get(act.classes[0]) === ti) score -= 0.5;
      if (score < bestScore) { bestScore = score; best = ti; }
    }
    act.teacher = best;
    if (best >= 0) for (const layer of act.layers) { load[layer][best] += act.hours; gradeLoad[layer].set(`${best}|${act.gi}`, (gradeLoad[layer].get(`${best}|${act.gi}`) || 0) + act.hours); pairHours.set(`${layer}|${act.classes[0]}|${best}`, (pairHours.get(`${layer}|${act.classes[0]}|${best}`) || 0) + act.hours); }
    else act.layers.forEach((layer, at) => noTeacher.push({ layer, kind: "lesson", grade: grades[act.gi], classId: classIds[act.classes[0]], subject: act.subjectName[at], hours: act.hours, reason: options.length ? "capacity" : "none" }));
  }
  for (const list of rawBlocks) for (const block of list) for (const section of block.sections) {
    if (section.teacher < 0) noTeacher.push({ layer: block.layer, kind: "section", grade: grades[block.gi], classId: block.label, subject: section.subject, hours: block.hours, reason: section.cands.length ? "clash" : "none" });
  }

  // 활동마다 층별 교사 목록·같은 교사 같은 반 판정 키·장소
  acts.forEach((act, index) => {
    act.index = index;
    if (act.kind === 0) {
      act.teachers = act.layers.map(() => (act.teacher >= 0 ? [act.teacher] : []));
      act.pairFree = T + index;
      act.pair = act.creative ? -1 : act.teacher >= 0 ? act.teacher : act.pairFree;
      act.venues = act.venue.map((v) => (v >= 0 ? [v] : []));
    } else if (act.kind === 1) {
      act.teachers = act.sections.map((sections) => sections.map((section) => section.teacher).filter((ti) => ti >= 0));
      act.pair = T + index;
      act.venues = act.sections.map((sections) => sections.map((section) => section.venue).filter((v) => v >= 0));
    } else {
      act.teachers = act.layers.map(() => (act.homerooms || []).slice());
      act.pair = -1;
      act.venues = act.layers.map(() => []);
    }
  });
  return { version: TIMETABLE_SOLVE_VERSION, keys, models, rules, days, D, positions, ABS, S, L, T, C: classIds.length, slotKey, slotDay, slotPeriod, slotsByDay, slotIndex, grades, absOf, classIds, classGrade,
    teacherIds, teacherName, blocked, capacity, venueNames, venueCap, frame, subjects, acts, notes, noTeacher, lunchPositions: base.lunchPositions.slice(),
    weights: { gap: timetableRuleWeight(rules, "gap"), once: timetableRuleWeight(rules, "oncePerDay"), run: timetableRuleWeight(rules, "run") || (rules.run ? 1000 : 0), maxPerDay: timetableRuleWeight(rules, "maxPerDay") || (rules.maxPerDay ? 1000 : 0),
      lunch: timetableRuleWeight(rules, "lunch"), lunchSide: timetableRuleWeight(rules, "lunchSide"), sameSubject: timetableRuleWeight(rules, "sameSubjectDay") },
    runLimit: Number(rules.run) > 0 ? Number(rules.run) : 99, dayLimit: Number(rules.maxPerDay) > 0 ? Number(rules.maxPerDay) : 99 };
}

// ---- 상태: 놓기·빼기·비용 ----
function timetableState(P) {
  const { L, C, S, T, ABS, D } = P;
  return { P, grid: Array.from({ length: L }, () => new Int32Array(C * S).fill(-1)), tAt: Array.from({ length: L }, () => new Int32Array(T * ABS).fill(-1)),
    absLoad: Array.from({ length: L }, () => new Int16Array(ABS)), everyone: Array.from({ length: L }, () => new Uint8Array(ABS)),
    venueLoad: Array.from({ length: L }, () => new Int16Array(P.venueNames.length * ABS)), slotOf: P.acts.map((act) => new Int16Array(act.hours).fill(-1)),
    bare: P.acts.map((act) => new Uint8Array(act.hours)), // 1 = 그 시간은 담당 교사 없이 반 칸만 차지(마지막 수단)
    extra: Array.from({ length: L }, () => new Map()), // 두 학기 묶음인데 같은 칸에 못 넣은 시간: 층마다 따로 놓은 칸(활동 번호 → [칸])
    classCost: Array.from({ length: L }, () => new Float64Array(C * D)), teacherCost: Array.from({ length: L }, () => new Float64Array(T * D)), cost: 0, unplaced: 0 };
}

// 활동 a를 칸 s에 놓을 수 있는가(절대 조건). bare = 교사·장소 없이 반 칸만.
function timetableCanPlace(state, act, s, bare) {
  const P = state.P;
  for (let at = 0; at < act.layers.length; at += 1) {
    const layer = act.layers[at];
    const grid = state.grid[layer];
    for (const ci of act.classes) if (grid[ci * P.S + s] !== -1) return false;
    if (bare) continue;
    if (act.everyone && !act.premarked) {
      for (let gi = 0; gi < P.absOf.length; gi += 1) { const abs = P.absOf[gi][s]; if (state.absLoad[layer][abs] > 0 || state.everyone[layer][abs]) return false; }
      continue;
    }
    if (act.gi < 0) continue;
    const abs = P.absOf[act.gi][s];
    const teachers = act.teachers[at];
    if (teachers.length) {
      if (state.everyone[layer][abs]) return false;
      const busy = state.tAt[layer];
      const blocked = P.blocked[layer];
      for (const ti of teachers) if (blocked[ti * P.ABS + abs] || busy[ti * P.ABS + abs] !== -1) return false;
    }
    const venues = act.venues[at];
    for (let v = 0; v < venues.length; v += 1) {
      const venue = venues[v];
      let need = 1;
      for (let w = 0; w < v; w += 1) if (venues[w] === venue) need += 1;
      if (state.venueLoad[layer][venue * P.ABS + abs] + need > P.venueCap[venue]) return false;
    }
  }
  return true;
}

function timetableMark(state, act, k, s, sign, bare) {
  const P = state.P;
  for (let at = 0; at < act.layers.length; at += 1) {
    const layer = act.layers[at];
    const grid = state.grid[layer];
    for (const ci of act.classes) grid[ci * P.S + s] = sign > 0 ? act.index : -1;
    if (bare) continue;
    if (act.everyone && !act.premarked) { for (let gi = 0; gi < P.absOf.length; gi += 1) state.everyone[layer][P.absOf[gi][s]] = sign > 0 ? 1 : 0; continue; }
    if (act.gi < 0) continue;
    const abs = P.absOf[act.gi][s];
    for (const ti of act.teachers[at]) { state.tAt[layer][ti * P.ABS + abs] = sign > 0 ? act.index : -1; state.absLoad[layer][abs] += sign; }
    for (const venue of act.venues[at]) state.venueLoad[layer][venue * P.ABS + abs] += sign;
  }
  state.slotOf[act.index][k] = sign > 0 ? s : -1;
  state.bare[act.index][k] = sign > 0 && bare ? 1 : 0;
}

// 반 하루 비용: 공강(뒤에 수업이 있는 빈칸) + 같은 교사(같은 블록)가 그 반에 하루 두 번.
function timetableClassDayCost(state, layer, ci, d) {
  const P = state.P;
  const slots = P.slotsByDay[d];
  const grid = state.grid[layer];
  let last = -1;
  for (let i = slots.length - 1; i >= 0; i -= 1) if (grid[ci * P.S + slots[i]] !== -1) { last = i; break; }
  if (last < 0) return 0;
  let gaps = 0;
  let twice = 0;
  for (let i = 0; i <= last; i += 1) {
    const a = grid[ci * P.S + slots[i]];
    if (a === -1) { gaps += 1; continue; }
    const act = P.acts[a];
    if (act.pair < 0) continue;
    for (let j = 0; j < i; j += 1) {
      const b = grid[ci * P.S + slots[j]];
      if (b === -1 || P.acts[b].pair !== act.pair) continue;
      if (act.double && b === a && j === i - 1) continue; // 연속 2시간이 필요한 과목
      twice += 1;
      break;
    }
  }
  return gaps * P.weights.gap + twice * P.weights.once;
}

// 교사 하루 비용: 연강 초과, 하루 최대 초과, 점심 칸을 모두 수업, 점심 앞뒤 공강, 같은 날 같은 과목.
function timetableTeacherDayCost(state, layer, ti, d) {
  const P = state.P;
  const busy = state.tAt[layer];
  const base = ti * P.ABS + d * P.positions;
  let count = 0;
  let streak = 0;
  let over = 0;
  for (let pos = 0; pos < P.positions; pos += 1) {
    if (busy[base + pos] !== -1) { count += 1; streak += 1; if (streak > P.runLimit) over += 1; } else streak = 0;
  }
  if (!count) return 0;
  let cost = over * P.weights.run + Math.max(0, count - P.dayLimit) * P.weights.maxPerDay;
  const lunch = P.lunchPositions;
  if (lunch.length) {
    let free = -1;
    let side = 99;
    for (const pos of lunch) {
      if (busy[base + pos] !== -1) continue;
      const near = (pos > 0 && busy[base + pos - 1] !== -1 ? 1 : 0) + (pos + 1 < P.positions && busy[base + pos + 1] !== -1 ? 1 : 0);
      if (near < side) { side = near; free = pos; }
    }
    if (free < 0) cost += P.weights.lunch;
    else cost += side * P.weights.lunchSide;
  }
  if (P.weights.sameSubject) {
    for (let pos = 1; pos < P.positions; pos += 1) {
      const a = busy[base + pos];
      if (a === -1 || P.acts[a].kind !== 0) continue;
      const subject = P.acts[a].subject[P.acts[a].layers.indexOf(layer)];
      for (let prev = 0; prev < pos; prev += 1) {
        const b = busy[base + prev];
        if (b !== -1 && b !== a && P.acts[b].kind === 0 && P.acts[b].subject[P.acts[b].layers.indexOf(layer)] === subject) { cost += P.weights.sameSubject; break; }
      }
    }
  }
  return cost;
}

function timetableRecount(state) {
  const P = state.P;
  let cost = 0;
  let unplaced = 0;
  for (let layer = 0; layer < P.L; layer += 1) {
    for (let ci = 0; ci < P.C; ci += 1) for (let d = 0; d < P.D; d += 1) { const value = timetableClassDayCost(state, layer, ci, d); state.classCost[layer][ci * P.D + d] = value; cost += value; }
    for (let ti = 0; ti < P.T; ti += 1) for (let d = 0; d < P.D; d += 1) { const value = timetableTeacherDayCost(state, layer, ti, d); state.teacherCost[layer][ti * P.D + d] = value; cost += value; }
  }
  for (const slots of state.slotOf) for (const s of slots) if (s < 0) unplaced += 1;
  state.unplaced = unplaced;
  state.cost = cost + unplaced * TIMETABLE_UNPLACED_WEIGHT;
  return state.cost;
}

// 바뀐 활동들이 닿는 반·교사의 하루 비용만 다시 센다. touched = [act, 옛 칸, 새 칸] 목록.
function timetableDelta(state, touched, commit) {
  const P = state.P;
  const seenC = state.seenC || (state.seenC = new Map());
  const seenT = state.seenT || (state.seenT = new Map());
  seenC.clear(); seenT.clear();
  for (const [act, from, to] of touched) {
    for (const s of [from, to]) {
      if (s < 0) continue;
      const d = P.slotDay[s];
      for (const layer of act.layers) {
        for (const ci of act.classes) seenC.set((layer * P.C + ci) * P.D + d, 1);
        const at = act.layers.indexOf(layer);
        if (act.everyone) continue;
        for (const ti of act.teachers[at]) seenT.set((layer * P.T + ti) * P.D + d, 1);
      }
    }
  }
  let delta = 0;
  const changes = [];
  for (const key of seenC.keys()) {
    const d = key % P.D; const rest = (key - d) / P.D; const ci = rest % P.C; const layer = (rest - ci) / P.C;
    const value = timetableClassDayCost(state, layer, ci, d);
    delta += value - state.classCost[layer][ci * P.D + d];
    changes.push(0, layer, ci * P.D + d, value);
  }
  for (const key of seenT.keys()) {
    const d = key % P.D; const rest = (key - d) / P.D; const ti = rest % P.T; const layer = (rest - ti) / P.T;
    const value = timetableTeacherDayCost(state, layer, ti, d);
    delta += value - state.teacherCost[layer][ti * P.D + d];
    changes.push(1, layer, ti * P.D + d, value);
  }
  if (commit) for (let i = 0; i < changes.length; i += 4) (changes[i] ? state.teacherCost : state.classCost)[changes[i + 1]][changes[i + 2]] = changes[i + 3];
  return { delta, changes };
}

function timetableCommit(state, changes) {
  for (let i = 0; i < changes.length; i += 4) (changes[i] ? state.teacherCost : state.classCost)[changes[i + 1]][changes[i + 2]] = changes[i + 3];
}

// ---- 구성: 블록·창체 → 반 수업(어려운 것부터) ----
function timetableConstruct(state, rng) {
  const P = state.P;
  const dropTeachers = (act, s) => {
    // 정해진 시간에 교사가 겹치거나 불가면 그 분반(담임)은 이 활동에서 교사를 뺀다 → 담당 교사 없음.
    for (let at = 0; at < act.layers.length; at += 1) {
      const layer = act.layers[at];
      if (act.gi < 0) continue;
      const abs = P.absOf[act.gi][s];
      const kept = [];
      for (const ti of act.teachers[at]) {
        if (P.blocked[layer][ti * P.ABS + abs] || state.tAt[layer][ti * P.ABS + abs] !== -1 || state.everyone[layer][abs]) {
          if (act.kind === 1) { const section = act.sections[at].find((item) => item.teacher === ti); if (section) { section.teacher = -1; P.noTeacher.push({ layer, kind: "section", grade: P.grades[act.gi], classId: act.labels[at], subject: section.subject, hours: act.hours, reason: "clash" }); } }
        } else kept.push(ti);
      }
      act.teachers[at] = kept;
      if (act.kind === 1) act.venues[at] = [];
    }
  };
  const syncActs = P.acts.filter((act) => act.kind !== 0).sort((a, b) => (a.fixedSlots ? 0 : 1) - (b.fixedSlots ? 0 : 1) || b.classes.length - a.classes.length || b.hours - a.hours || a.index - b.index);
  const syncPerDay = new Map(); // 학년|요일 → 동시 활동 수(하루 앞쪽부터 쌓는다)
  const dayKey = (act, d) => `${act.gi}|${d}`;
  const placeSync = (act) => {
    const usedDays = new Set();
    for (const s of state.slotOf[act.index]) if (s >= 0) usedDays.add(P.slotDay[s]);
    for (let k = 0; k < act.hours; k += 1) {
      if (state.slotOf[act.index][k] >= 0) continue;
      let chosen = -1;
      if (act.fixedSlots) {
        const s = act.fixedSlots[k];
        if (timetableCanPlace(state, act, s, false)) chosen = s;
        else if (timetableCanPlace(state, act, s, true)) { dropTeachers(act, s); if (timetableCanPlace(state, act, s, false)) chosen = s; }
      }
      if (chosen < 0) {
        let bestScore = Infinity;
        for (let s = 0; s < P.S; s += 1) {
          if (!timetableCanPlace(state, act, s, false)) continue;
          const d = P.slotDay[s];
          const score = (usedDays.has(d) ? 1000 : 0) + (syncPerDay.get(dayKey(act, d)) || 0) * 10 + P.slotPeriod[s] + rng();
          if (score < bestScore) { bestScore = score; chosen = s; }
        }
        if (chosen < 0) {
          for (let s = 0; s < P.S && chosen < 0; s += 1) if (timetableCanPlace(state, act, s, true)) { dropTeachers(act, s); if (timetableCanPlace(state, act, s, false)) chosen = s; }
        }
      }
      if (chosen >= 0) {
        timetableMark(state, act, k, chosen, 1, false);
        usedDays.add(P.slotDay[chosen]);
        syncPerDay.set(dayKey(act, P.slotDay[chosen]), (syncPerDay.get(dayKey(act, P.slotDay[chosen])) || 0) + 1);
      }
    }
  };
  // 1) 시간이 정해진 블록·창체
  for (const act of syncActs) if (act.fixedSlots) placeSync(act);
  // 2) 반 수업을 같은 시간에 맡을 교사가 반 수보다 적은 학년(반 수업이 하루 끝 쪽에만 올 수 있다 — 블록 사이에 낀 칸은 곧 공강):
  //    그 학년 블록을 먼저, 1교시부터 빈틈없이 놓는다. 정해진 창체가 있는 요일은 그 앞을 블록으로 채우고, 나머지는 요일마다 고르게. 한 블록은 요일마다 한 번.
  for (let gi = 0; gi < P.grades.length; gi += 1) {
    const classes = [];
    for (let ci = 0; ci < P.C; ci += 1) if (P.classGrade[ci] === gi) classes.push(ci);
    const blocks = P.acts.filter((act) => act.kind === 1 && act.gi === gi && !act.fixedSlots && act.classes.length === classes.length);
    if (!classes.length || !blocks.length || blocks.some((act) => act.layers.join() !== blocks[0].layers.join())) continue;
    const tight = P.keys.some((_, layer) => new Set(P.acts.filter((act) => act.kind === 0 && !act.creative && act.gi === gi && act.teacher >= 0 && act.layers.includes(layer)).map((act) => act.teacher)).size < classes.length);
    if (!tight) continue;
    const need = P.slotsByDay.map((slots) => { // 그날 정해진 활동(창체 등) 앞에 채워야 하는 칸 수, 없으면 -1
      let first = -1;
      for (let i = 0; i < slots.length && first < 0; i += 1) if (blocks[0].layers.some((layer) => state.grid[layer][classes[0] * P.S + slots[i]] !== -1)) first = i;
      return first;
    });
    let left = blocks.reduce((sum, act) => sum + act.hours, 0);
    const counts = need.map((value) => { const take = value > 0 ? Math.min(value, blocks.length, left) : 0; left -= take; return take; });
    const open = need.map((value, d) => (value < 0 ? d : -1)).filter((d) => d >= 0);
    for (let round = 0; left > 0 && open.length && round < blocks.length; round += 1) for (const d of open) { if (left > 0 && counts[d] < Math.min(blocks.length, P.slotsByDay[d].length)) { counts[d] += 1; left -= 1; } }
    const remaining = new Map(blocks.map((act) => [act, act.hours]));
    for (const d of counts.map((_, index) => index).sort((a, b) => counts[b] - counts[a] || a - b)) {
      const picked = blocks.filter((act) => remaining.get(act) > 0).map((act) => [act, remaining.get(act) + rng()]).sort((a, b) => b[1] - a[1]).slice(0, counts[d]).map(([act]) => act);
      for (let i = picked.length - 1; i > 0; i -= 1) { const j = Math.floor(rng() * (i + 1)); [picked[i], picked[j]] = [picked[j], picked[i]]; }
      picked.forEach((act, index) => {
        const slot = P.slotsByDay[d][index];
        const k = state.slotOf[act.index].indexOf(-1);
        if (k < 0 || !timetableCanPlace(state, act, slot, false)) return;
        timetableMark(state, act, k, slot, 1, false);
        remaining.set(act, remaining.get(act) - 1);
        syncPerDay.set(dayKey(act, d), (syncPerDay.get(dayKey(act, d)) || 0) + 1);
      });
    }
  }
  // 3) 나머지 블록·창체
  for (const act of syncActs) if (!act.fixedSlots) placeSync(act);
  const teacherLoad = new Float64Array(P.T);
  for (const act of P.acts) if (act.kind === 0 && act.teacher >= 0) teacherLoad[act.teacher] += act.hours * act.layers.length;
  const lessons = P.acts.filter((act) => act.kind === 0).sort((a, b) => b.layers.length - a.layers.length || (b.teacher >= 0 ? teacherLoad[b.teacher] : 0) - (a.teacher >= 0 ? teacherLoad[a.teacher] : 0) || b.hours - a.hours || a.index - b.index);
  for (const act of lessons) {
    const ci = act.classes[0];
    const usedDays = new Set();
    for (let k = 0; k < act.hours; k += 1) {
      let chosen = -1;
      let bestScore = Infinity;
      for (let s = 0; s < P.S; s += 1) {
        if (!timetableCanPlace(state, act, s, false)) continue;
        const d = P.slotDay[s];
        let before = 0;
        for (const other of P.slotsByDay[d]) { if (other === s) break; for (const layer of act.layers) if (state.grid[layer][ci * P.S + other] === -1) before += 1; }
        const score = (usedDays.has(d) ? 400 : 0) + before * 25 + P.slotPeriod[s] + rng() * 3;
        if (score < bestScore) { bestScore = score; chosen = s; }
      }
      if (chosen >= 0) { timetableMark(state, act, k, chosen, 1, false); usedDays.add(P.slotDay[chosen]); }
    }
  }
  timetableRecount(state);
}

// ---- 탐색(담금질): 절대 조건을 지키는 이동만 한다 ----
// 이동 1: 한 반의 두 칸 내용 맞바꾸기(모든 층 — 두 학기 묶음이 같은 칸에 남는다). 이동 2: 한 층만 맞바꾸기(그 층에만 있는 수업끼리).
// 이동 3: 블록·창체 한 시간을 다른 칸으로(그 칸의 반 수업들과 자리 바꿈). 이동 4: 못 넣은 수업 넣기(빈 칸, 또는 그 칸 수업을 밀어내고).
function timetableTryMove(state, rng, temperature) {
  const P = state.P;
  const ops = []; // [act, k, 옛 칸, 새 칸]
  const undo = () => { for (let i = ops.length - 1; i >= 0; i -= 1) { const [act, k, from, to] = ops[i]; if (to >= 0) timetableMark(state, act, k, to, -1, false); if (from >= 0) timetableMark(state, act, k, from, 1, false); } };
  const lift = (act, s) => { const k = state.slotOf[act.index].indexOf(s); timetableMark(state, act, k, s, -1, state.bare[act.index][k] === 1); ops.push([act, k, s, -1]); return k; };
  const drop = (act, k, s) => { if (!timetableCanPlace(state, act, s, false)) return false; timetableMark(state, act, k, s, 1, false); ops.push([act, k, -1, s]); return true; };
  // '반드시' 위반이 있는 반·요일, 교사·요일 목록(1000번 움직일 때마다 다시 만든다) — 겨냥 이동이 여기서 고른다
  state.moves = (state.moves || 0) + 1;
  if (!state.hot || state.moves - state.hot.at >= 1000) {
    const hotC = [];
    const hotT = [];
    for (let layer = 0; layer < P.L; layer += 1) {
      const classCost = state.classCost[layer];
      const teacherCost = state.teacherCost[layer];
      for (let i = 0; i < P.C * P.D; i += 1) if (classCost[i] >= 1000) hotC.push(layer, (i - (i % P.D)) / P.D, i % P.D);
      for (let i = 0; i < P.T * P.D; i += 1) if (teacherCost[i] >= 1000) hotT.push(layer, (i - (i % P.D)) / P.D, i % P.D);
    }
    state.hot = { at: state.moves, hotC, hotT };
  }
  const hot = state.hot;
  const pickHot = (list) => { const i = 3 * Math.floor(rng() * (list.length / 3)); return [list[i], list[i + 1], list[i + 2]]; };
  const roll = rng();
  let unplacedDelta = 0;
  if (roll >= 0.94) return timetableTrySwapTeachers(state, rng, temperature);
  if (state.unplaced > 0 && roll < 0.25) {
    // 이동 4
    const pool = [];
    for (const act of P.acts) { const slots = state.slotOf[act.index]; for (let k = 0; k < slots.length; k += 1) if (slots[k] < 0) pool.push([act, k]); }
    const [act, k] = pool[Math.floor(rng() * pool.length)];
    const s = Math.floor(rng() * P.S);
    if (timetableCanPlace(state, act, s, false)) { timetableMark(state, act, k, s, 1, false); ops.push([act, k, -1, s]); unplacedDelta = -1; }
    else if (act.kind === 0) {
      const out = new Set();
      for (let layer = 0; layer < P.L; layer += 1) { const a = state.grid[layer][act.classes[0] * P.S + s]; if (a !== -1) out.add(a); }
      for (const a of out) if (P.acts[a].kind !== 0) return false;
      for (const a of out) lift(P.acts[a], s);
      if (!timetableCanPlace(state, act, s, false)) { undo(); return false; }
      timetableMark(state, act, k, s, 1, false); ops.push([act, k, -1, s]);
      unplacedDelta = out.size - 1;
    } else return false;
  } else if (roll < 0.33) {
    // 이동 3
    const sync = P.syncMovable || (P.syncMovable = P.acts.filter((act) => act.kind !== 0 && !act.fixedSlots));
    if (!sync.length) return false;
    let act = sync[Math.floor(rng() * sync.length)];
    let k = Math.floor(rng() * act.hours);
    if (hot.hotT.length && rng() < 0.5) {
      // 교사 위반(점심·연강·하루 최대)을 겨냥: 그 교사가 그날 들어가는 블록 한 시간(점심 칸 쪽을 먼저)
      const [layer, ti, d] = pickHot(hot.hotT);
      const pos = P.lunchPositions.length && rng() < 0.6 ? P.lunchPositions[Math.floor(rng() * P.lunchPositions.length)] : Math.floor(rng() * P.positions);
      const abs = d * P.positions + pos;
      const a = state.tAt[layer][ti * P.ABS + abs];
      if (a !== -1 && P.acts[a].kind === 1 && !P.acts[a].fixedSlots) {
        const found = P.acts[a];
        const slots = state.slotOf[a];
        for (let i = 0; i < slots.length; i += 1) if (slots[i] >= 0 && P.absOf[found.gi][slots[i]] === abs) { act = found; k = i; break; }
      }
    }
    const from = state.slotOf[act.index][k];
    if (from < 0) return false;
    // 절반은 같은 날 안에서 옮긴다(빈틈없이 놓인 블록을 흩지 않고 순서만 바꿔 교사 연강·점심을 고친다)
    const sameDay = P.slotsByDay[P.slotDay[from]];
    const to = rng() < 0.5 ? sameDay[Math.floor(rng() * sameDay.length)] : Math.floor(rng() * P.S);
    if (from === to) return false;
    const riders = new Set();
    let partner = -1; // 그 칸에 같은 반들의 다른 블록·창체가 있으면 둘이 자리를 맞바꾼다
    for (let layer = 0; layer < P.L; layer += 1) for (const ci of act.classes) {
      const a = state.grid[layer][ci * P.S + to];
      if (a === -1) continue;
      if (P.acts[a].kind === 0) riders.add(a);
      else if (partner === -1 || partner === a) partner = a;
      else return false;
    }
    if (partner !== -1) {
      const other = P.acts[partner];
      if (other === act || other.fixedSlots || riders.size || other.classes.join() !== act.classes.join() || other.layers.join() !== act.layers.join()) return false;
      timetableMark(state, act, k, from, -1, false); ops.push([act, k, from, -1]);
      const ok = lift(other, to);
      if (!drop(act, k, to) || !drop(other, ok, from)) { undo(); return false; }
    } else {
    timetableMark(state, act, k, from, -1, false); ops.push([act, k, from, -1]);
    const moved = [];
    for (const a of riders) moved.push([P.acts[a], lift(P.acts[a], to)]);
    if (!drop(act, k, to)) { undo(); return false; }
    for (const [rider, rk] of moved) if (!drop(rider, rk, from)) { undo(); return false; }
    }
  } else {
    // 이동 1·2. 절반쯤은 위반을 겨냥한다: 공강이 있는 반은 그 빈칸에 다른 날 수업을 끌어오고, 하루 두 번인 수업·교사 위반 수업은 다른 칸으로.
    let ci = Math.floor(rng() * P.C);
    let s1 = Math.floor(rng() * P.S);
    let s2 = -1;
    if (rng() < 0.5) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        let layer = Math.floor(rng() * P.L);
        let d = Math.floor(rng() * P.D);
        const classSide = hot.hotC.length ? !hot.hotT.length || rng() < 0.6 : hot.hotT.length ? false : rng() < 0.75;
        if (classSide) {
          let c = Math.floor(rng() * P.C);
          if (hot.hotC.length) [layer, c, d] = pickHot(hot.hotC);
          if (!state.classCost[layer][c * P.D + d]) continue;
          const slots = P.slotsByDay[d];
          const grid = state.grid[layer];
          let last = -1;
          for (let i = slots.length - 1; i >= 0; i -= 1) if (grid[c * P.S + slots[i]] !== -1) { last = i; break; }
          let gap = -1;
          for (let i = 0; i < last; i += 1) if (grid[c * P.S + slots[i]] === -1 && (gap < 0 || rng() < 0.5)) gap = slots[i];
          ci = c;
          if (gap >= 0) {
            s1 = gap;
            // 끌어올 수업: 그 반의 아무 요일 마지막 수업(반 수업일 때)
            const other = P.slotsByDay[Math.floor(rng() * P.D)];
            for (let i = other.length - 1; i >= 0; i -= 1) { const a = grid[c * P.S + other[i]]; if (a !== -1) { if (P.acts[a].kind === 0 && other[i] !== gap) s2 = other[i]; break; } }
          } else s1 = slots[Math.floor(rng() * slots.length)];
          break;
        }
        let ti = Math.floor(rng() * P.T);
        if (hot.hotT.length) [layer, ti, d] = pickHot(hot.hotT);
        if (!state.teacherCost[layer][ti * P.D + d]) continue;
        // 그 교사가 그날 맡은 반 수업 하나(점심 칸 쪽을 먼저) → 다른 칸으로
        const pos = P.lunchPositions.length && rng() < 0.5 ? P.lunchPositions[Math.floor(rng() * P.lunchPositions.length)] : Math.floor(rng() * P.positions);
        const abs = d * P.positions + pos;
        const a = state.tAt[layer][ti * P.ABS + abs];
        if (a === -1 || P.acts[a].kind !== 0) continue;
        let s = -1;
        for (const slot of state.slotOf[a]) if (slot >= 0 && P.absOf[P.acts[a].gi][slot] === abs) s = slot;
        if (s < 0) continue;
        ci = P.acts[a].classes[0]; s1 = s;
        break;
      }
    }
    if (s2 < 0 || s2 === s1) { s2 = Math.floor(rng() * (P.S - 1)); if (s2 >= s1) s2 += 1; }
    const single = P.L > 1 && rng() < 0.5 ? Math.floor(rng() * P.L) : -1;
    // 사슬(켐페): 옮겨 갈 칸에 그 교사의 다른 반 수업이 있으면 그 반도 같은 두 칸을 맞바꾼다(최대 6반).
    const chain = [ci];
    const pending = []; // [act, k, 옮겨 갈 칸]
    const collect = (c) => {
      const at1 = new Set();
      const at2 = new Set();
      for (let layer = 0; layer < P.L; layer += 1) {
        if (single >= 0 && layer !== single) continue;
        const a = state.grid[layer][c * P.S + s1];
        const b = state.grid[layer][c * P.S + s2];
        if (a !== -1) at1.add(a);
        if (b !== -1) at2.add(b);
      }
      if (!at1.size && !at2.size) return false;
      for (const a of at1) if (P.acts[a].kind !== 0 || (single >= 0 && P.acts[a].layers.length > 1) || at2.has(a)) return false;
      for (const b of at2) if (P.acts[b].kind !== 0 || (single >= 0 && P.acts[b].layers.length > 1)) return false;
      for (const a of at1) pending.push([P.acts[a], lift(P.acts[a], s1), s2]);
      for (const b of at2) pending.push([P.acts[b], lift(P.acts[b], s2), s1]);
      return true;
    };
    // 그 칸에서 이 수업의 교사를 잡고 있는 다른 반(같은 칸 번호의 반 수업일 때만), 없으면 -1
    const blocker = (act, to) => {
      for (let at = 0; at < act.layers.length; at += 1) {
        const layer = act.layers[at];
        const abs = P.absOf[act.gi][to];
        for (const ti of act.teachers[at]) {
          const b = state.tAt[layer][ti * P.ABS + abs];
          if (b === -1) continue;
          const other = P.acts[b];
          if (other.kind !== 0 || state.grid[layer][other.classes[0] * P.S + to] !== b) return -1;
          return other.classes[0];
        }
      }
      return -1;
    };
    if (!collect(ci)) { undo(); return false; }
    for (let i = 0; i < pending.length; i += 1) {
      const [act, , to] = pending[i];
      if (timetableCanPlace(state, act, to, false)) continue;
      const other = blocker(act, to);
      if (other < 0 || chain.includes(other) || chain.length >= 6) { undo(); return false; }
      chain.push(other);
      if (!collect(other)) { undo(); return false; }
    }
    for (const [act, k, to] of pending) if (!drop(act, k, to)) { undo(); return false; }
  }
  const touched = ops.map(([act, , from, to]) => [act, from, to]);
  const { delta, changes } = timetableDelta(state, touched, false);
  const total = delta + unplacedDelta * TIMETABLE_UNPLACED_WEIGHT;
  if (total <= 0 || rng() < Math.exp(-total / temperature)) {
    timetableCommit(state, changes);
    state.cost += total;
    state.unplaced += unplacedDelta;
    return true;
  }
  undo();
  return false;
}

// '공강 먼저'(rules.cover = "soft")일 때만: 남은 공강·하루 두 번이 있는 반·요일에서, 교사가 붙은 반 수업 가운데 그날 가장 뒤 교시에 놓인 것을
// 담당 교사 없음으로 돌린다(교사 때문에 그 칸에 묶여 있던 수업이 어느 칸에나 놓일 수 있게 됨). 한 번에 최대 4개. 돌려주는 값: 돌린 수업 수.
function timetableRelease(run) {
  const { P, state } = run;
  const picked = [];
  for (const item of timetableViolations(state)) {
    if (item.level !== "hard" || item.kind !== "class" || (item.rule !== "gap" && item.rule !== "oncePerDay")) continue;
    const layer = P.keys.indexOf(item.semester);
    const ci = P.classIds.indexOf(item.id);
    const d = P.days.indexOf(item.day);
    if (layer < 0 || ci < 0 || d < 0) continue;
    const slots = P.slotsByDay[d];
    let found = null;
    for (let i = slots.length - 1; i >= 0 && !found; i -= 1) {
      const a = state.grid[layer][ci * P.S + slots[i]];
      const act = a === -1 ? null : P.acts[a];
      if (act && act.kind === 0 && !act.creative && act.teacher >= 0 && act.fixed < 0 && !picked.includes(act)) found = act;
    }
    if (found) picked.push(found);
    if (picked.length >= 4) break;
  }
  for (const act of picked) {
    const placed = [];
    state.slotOf[act.index].forEach((s, k) => { if (s >= 0) placed.push([k, s, state.bare[act.index][k] === 1]); });
    for (const [k, s, bare] of placed) timetableMark(state, act, k, s, -1, bare);
    timetableSetTeacher(act, -1);
    for (const [k, s] of placed) timetableMark(state, act, k, s, 1, false);
    act.layers.forEach((layer, at) => P.noTeacher.push({ layer, kind: "lesson", grade: P.grades[act.gi], classId: P.classIds[act.classes[0]], subject: act.subjectName[at], hours: act.hours, reason: "released" }));
  }
  if (picked.length) { timetableRecount(state); run.best = timetableSnapshot(state); }
  return picked.length;
}

// 이동 5: 같은 학년·같은 시수의 두 반 수업이 교사를 맞바꾼다(둘 다 서로의 후보일 때 — 전공 일치·교사별 시수는 그대로).
function timetableSetTeacher(act, teacher) {
  act.teacher = teacher;
  act.teachers = act.layers.map(() => (teacher >= 0 ? [teacher] : []));
  act.pair = teacher >= 0 ? teacher : act.pairFree;
}

function timetableTrySwapTeachers(state, rng, temperature) {
  const P = state.P;
  if (!P.swapMates) {
    const movable = P.acts.filter((act) => act.kind === 0 && !act.creative && act.fixed < 0 && act.cands.length > 1);
    P.swapMates = P.acts.map((act) => (movable.includes(act) ? movable.filter((other) => other !== act && other.gi === act.gi && other.hours === act.hours && other.layers.join() === act.layers.join()).map((other) => other.index) : []));
    P.swapPool = movable.filter((act) => P.swapMates[act.index].length).map((act) => act.index);
  }
  if (!P.swapPool.length) return false;
  const a = P.acts[P.swapPool[Math.floor(rng() * P.swapPool.length)]];
  const mates = P.swapMates[a.index];
  const b = P.acts[mates[Math.floor(rng() * mates.length)]];
  const ta = a.teacher;
  const tb = b.teacher;
  if (ta < 0 || tb < 0 || ta === tb || !a.cands.includes(tb) || !b.cands.includes(ta)) return false;
  const placed = [];
  for (const act of [a, b]) state.slotOf[act.index].forEach((s, k) => { if (s >= 0 && state.bare[act.index][k] !== 1) placed.push([act, k, s]); });
  for (const [act, k, s] of placed) timetableMark(state, act, k, s, -1, false);
  const back = (done) => {
    for (let i = done - 1; i >= 0; i -= 1) timetableMark(state, placed[i][0], placed[i][1], placed[i][2], -1, false);
    timetableSetTeacher(a, ta); timetableSetTeacher(b, tb);
    for (const [act, k, s] of placed) timetableMark(state, act, k, s, 1, false);
    return false;
  };
  timetableSetTeacher(a, tb); timetableSetTeacher(b, ta);
  for (let i = 0; i < placed.length; i += 1) {
    const [act, k, s] = placed[i];
    if (!timetableCanPlace(state, act, s, false)) return back(i);
    timetableMark(state, act, k, s, 1, false);
  }
  const both = { layers: a.layers, classes: [], teachers: a.layers.map(() => [ta, tb]), everyone: false };
  const touched = placed.flatMap(([act, , s]) => [[act, s, -1], [both, s, -1]]);
  const { delta, changes } = timetableDelta(state, touched, false);
  if (delta <= 0 || rng() < Math.exp(-delta / temperature)) { timetableCommit(state, changes); state.cost += delta; return true; }
  return back(placed.length);
}

function timetableSnapshot(state) {
  return { cost: state.cost, slots: state.slotOf.map((slots) => Int16Array.from(slots)), teachers: state.P.acts.map((act) => (act.kind === 0 ? act.teacher : -1)) };
}

function timetableRestoreSnapshot(state, snapshot) {
  const P = state.P;
  for (const table of state.grid) table.fill(-1);
  for (const table of state.tAt) table.fill(-1);
  for (const table of state.absLoad) table.fill(0);
  for (const table of state.everyone) table.fill(0);
  for (const table of state.venueLoad) table.fill(0);
  P.acts.forEach((act, index) => { state.slotOf[index].fill(-1); state.bare[index].fill(0); if (act.kind === 0 && !act.creative && snapshot.teachers && act.teacher !== snapshot.teachers[index]) timetableSetTeacher(act, snapshot.teachers[index]); });
  P.acts.forEach((act, index) => { snapshot.slots[index].forEach((s, k) => { if (s >= 0) timetableMark(state, act, k, s, 1, false); }); });
  timetableRecount(state);
}

// 풀이 시작: 문제를 만들고 구성까지. options = { seed, iterations }
function timetableSolveStart(inputs, options = {}) {
  const P = timetableProblem(inputs);
  const state = timetableState(P);
  const seed = Number(options.seed) || 1;
  const rng = timetableRng(seed);
  timetableConstruct(state, rng);
  const total = Math.max(0, Math.floor(Number(options.iterations ?? TIMETABLE_DEFAULT_ITERATIONS * P.L)));
  // rounds = 첫 담금질 뒤 '흔들기'(가장 좋은 상태에서 다시 데워 돌기)를 몇 번까지 할지. 횟수 기준이라 같은 씨앗 = 같은 결과.
  const rounds = Math.max(0, Math.floor(Number(options.rounds ?? TIMETABLE_DEFAULT_ROUNDS)));
  return { P, state, rng, seed, iteration: 0, total, base: total, phaseStart: 0, phaseEnd: total, hot: 40, extensions: 0, rounds, stale: 0, roundCost: Infinity, best: timetableSnapshot(state), startCost: state.cost, accepted: 0 };
}

// 탐색을 count번 더 한다(Worker가 조각으로 불러 중단 요청을 받을 수 있게). 돌려주는 값: 진행 상황.
// 한 판(정해진 횟수)을 돌 때마다 가장 좋은 상태로 돌아가 살핀다:
//   '반드시' 위반·못 넣은 수업이 없고 이번 판에 나아진 것이 거의 없으면 끝(일찍 끝내기),
//   위반이 남았어도 세 판 내리 나아지지 않으면 끝(자료상 풀리지 않는 위반), 아니면 다시 데워(흔들기) 한 판 더 — 최대 rounds 판.
function timetableSolveStep(run, count = 5000) {
  const { state } = run;
  const cold = 0.4;
  let left = count;
  while (left > 0) {
    if (run.iteration >= run.phaseEnd) {
      if (run.finished || !run.base) { run.finished = true; break; }
      timetableRestoreSnapshot(state, run.best);
      const hardLeft = state.unplaced > 0 || timetableViolations(state).some((item) => item.level === "hard");
      const improved = run.roundCost - run.best.cost;
      run.stale = improved > Math.max(0.5, run.best.cost * 0.005) ? 0 : run.stale + 1;
      run.roundCost = run.best.cost;
      run.hardLeft = hardLeft;
      if (run.extensions >= run.rounds || (!hardLeft && run.stale >= 1)) { run.finished = true; break; }
      if (run.stale >= 3 || (hardLeft && run.stale >= 1 && run.P.rules.cover === "soft")) {
        // 더 나아지지 않는다: '공강 먼저'면 걸리는 수업의 교사를 비우고 한 판 더, 아니면 끝
        if (run.P.rules.cover !== "soft" || !timetableRelease(run)) { run.finished = true; break; }
        run.stale = 0;
        run.roundCost = run.best.cost;
      }
      run.extensions += 1;
      run.phaseStart = run.iteration;
      run.phaseEnd = run.iteration + Math.max(1, Math.floor(run.base / 2));
      run.total = run.phaseEnd;
      run.hot = run.extensions % 2 ? 6 : 15;
    }
    const end = Math.min(run.phaseEnd, run.iteration + left);
    const span = Math.max(1, run.phaseEnd - run.phaseStart);
    left -= end - run.iteration;
    for (; run.iteration < end; run.iteration += 1) {
      const temperature = run.hot * Math.pow(cold / run.hot, (run.iteration - run.phaseStart) / span);
      if (timetableTryMove(state, run.rng, temperature)) {
        run.accepted += 1;
        if (state.cost < run.best.cost - 1e-9) run.best = timetableSnapshot(state);
      }
    }
  }
  const done = Boolean(run.finished) || !run.base;
  return { done, iteration: run.iteration, total: run.total, cost: state.cost, best: run.best.cost, unplaced: state.unplaced, extensions: run.extensions, rounds: run.rounds, hardLeft: run.hardLeft };
}

// ---- 결과 ----
function timetableSolveFinish(run) {
  const { P, state } = run;
  timetableRestoreSnapshot(state, run.best);
  // 끝까지 못 넣은 수업: 교사 없이 반의 빈 칸에(담당 교사 없음). 블록·창체는 반이 모두 비는 칸에.
  // 두 학기 묶음인데 두 학기 모두 비는 칸이 없으면 학기마다 따로 놓는다(뼈대에서 벗어난 칸으로 센다).
  const unplaced = [];
  let frameBroken = 0;
  const emptyBefore = (layersOf, classes, s) => {
    let before = 0;
    for (const other of P.slotsByDay[P.slotDay[s]]) { if (other === s) break; for (const layer of layersOf) for (const ci of classes) if (state.grid[layer][ci * P.S + other] === -1) before += 1; }
    return before;
  };
  for (const act of P.acts) {
    const slots = state.slotOf[act.index];
    for (let k = 0; k < slots.length; k += 1) {
      if (slots[k] >= 0) continue;
      let chosen = -1;
      let bestScore = Infinity;
      for (let s = 0; s < P.S; s += 1) {
        if (!timetableCanPlace(state, act, s, true)) continue;
        const score = emptyBefore(act.layers, act.classes, s) * 10 + (slots.some((other) => other >= 0 && P.slotDay[other] === P.slotDay[s]) ? 50 : 0) + P.slotPeriod[s];
        if (score < bestScore) { bestScore = score; chosen = s; }
      }
      if (chosen >= 0) { timetableMark(state, act, k, chosen, 1, true); continue; }
      let missing = 0;
      for (const layer of act.layers) {
        let own = -1;
        let ownScore = Infinity;
        for (let s = 0; s < P.S; s += 1) {
          if (act.classes.some((ci) => state.grid[layer][ci * P.S + s] !== -1)) continue;
          const score = emptyBefore([layer], act.classes, s) * 10 + P.slotPeriod[s];
          if (score < ownScore) { ownScore = score; own = s; }
        }
        if (own < 0) { missing += 1; continue; }
        for (const ci of act.classes) state.grid[layer][ci * P.S + own] = act.index;
        if (!state.extra[layer].has(act.index)) state.extra[layer].set(act.index, []);
        state.extra[layer].get(act.index).push(own);
        if (act.layers.length > 1) frameBroken += 1;
      }
      if (missing) unplaced.push({ act: act.index, hour: k });
    }
  }
  timetableRecount(state);
  const layers = {};
  const noTeacher = P.noTeacher.map((item) => ({ semester: P.keys[item.layer], kind: item.kind, grade: item.grade, classId: item.classId, subject: item.subject, hours: item.hours, reason: item.reason }));
  let blockTimesChanged = 0;
  const notes = P.notes.slice();
  P.keys.forEach((key, layer) => {
    const lessons = {};
    const blocks = {};
    const creative = [];
    for (const act of P.acts) {
      const at = act.layers.indexOf(layer);
      if (at < 0) continue;
      const apart = (state.extra[layer].get(act.index) || []).map((s) => P.slotKey[s]); // 이 학기에만 따로 놓은 칸(교사 없이)
      const slots = [...[...state.slotOf[act.index]].filter((s) => s >= 0).map((s) => P.slotKey[s]), ...apart];
      while (slots.length < act.hours) slots.push("");
      const framed = act.layers.length > 1 && !apart.length;
      if (act.kind === 0 && act.creative) creative.push({ scope: "class", classId: P.classIds[act.classes[0]], slots, teacherId: act.teacher >= 0 ? P.teacherIds[act.teacher] : null });
      else if (act.kind === 0) {
        const bare = [...[...state.slotOf[act.index]].filter((s, k) => s >= 0 && state.bare[act.index][k] === 1).map((s) => P.slotKey[s]), ...apart];
        lessons[act.ids[at]] = { slots, teacherId: act.teacher >= 0 ? P.teacherIds[act.teacher] : null, ...(bare.length ? { bareSlots: bare } : {}), ...(framed ? { frame: true } : {}) };
        if (bare.length && act.teacher >= 0) noTeacher.push({ semester: key, kind: "lesson", grade: P.grades[act.gi], classId: P.classIds[act.classes[0]], subject: act.subjectName[at], hours: bare.length, reason: "clash" });
      } else if (act.kind === 1) {
        const bare = [...[...state.slotOf[act.index]].filter((s, k) => s >= 0 && state.bare[act.index][k] === 1).map((s) => P.slotKey[s]), ...apart];
        // 6단계가 정한 블록 시간과 다른 자리에 놓였는지(두 학기 뼈대를 맞추거나, 정한 시간이 다른 블록과 겹칠 때)
        const own = act.ownFixed && act.ownFixed[at];
        const moved = Boolean(own && (apart.length || [...state.slotOf[act.index]].some((s) => s >= 0 && !own.includes(s))));
        if (moved) { blockTimesChanged += 1; if (!(act.overridden && act.overridden[at])) notes.push(`${key}학기 ${P.grades[act.gi]}학년 ${act.labels[at]}: 6단계 블록 시간에 놓을 수 없어 다른 자리에 놓았습니다.`); }
        blocks[act.ids[at]] = { slots, teachers: Object.fromEntries(act.sections[at].map((section) => [section.id, section.teacher >= 0 ? P.teacherIds[section.teacher] : null])), ...(bare.length ? { bareSlots: bare } : {}), ...(framed ? { frame: true } : {}),
          ...(moved ? { timesOverridden: true } : {}) };
        if (bare.length) for (const section of act.sections[at]) if (section.teacher >= 0) noTeacher.push({ semester: key, kind: "section", grade: P.grades[act.gi], classId: act.labels[at], subject: section.subject, hours: bare.length, reason: "clash" });
      } else creative.push({ scope: act.scope, grade: act.gi >= 0 ? P.grades[act.gi] : "", slots });
    }
    layers[key] = { lessons, blocks, creative };
  });
  const violations = timetableViolations(state);
  const count = (rule) => violations.filter((item) => item.rule === rule).reduce((sum, item) => sum + item.amount, 0);
  const hard = violations.filter((item) => item.level === "hard").reduce((sum, item) => sum + item.amount, 0);
  const metrics = { cost: Math.round(state.cost), hard, gap: count("gap"), oncePerDay: count("oncePerDay"), run: count("run"), maxPerDay: count("maxPerDay"), lunch: count("lunch"),
    noTeacherHours: noTeacher.reduce((sum, item) => sum + item.hours, 0), unplacedHours: unplaced.length, frame: P.frame, frameActs: P.acts.filter((act) => act.layers.length > 1).length, frameBroken,
    blockTimesChanged };
  return { version: TIMETABLE_SOLVE_VERSION, seed: run.seed, iterations: run.iteration, total: run.total, semesters: P.keys.slice(), layers, violations, noTeacher,
    unplaced: unplaced.map((item) => ({ subject: P.acts[item.act].kind === 0 ? P.acts[item.act].subjectName[0] : P.acts[item.act].kind === 1 ? P.acts[item.act].labels[0] : "창체", grade: P.acts[item.act].gi >= 0 ? P.grades[P.acts[item.act].gi] : "" })),
    notes, metrics };
}

// 남은 설정 조건 위반(반·교사·요일마다 한 줄).
function timetableViolations(state) {
  const P = state.P;
  const rules = P.rules;
  const out = [];
  const levelOf = (name) => rules[name];
  P.keys.forEach((semester, layer) => {
    for (let ci = 0; ci < P.C; ci += 1) for (let d = 0; d < P.D; d += 1) {
      if (!state.classCost[layer][ci * P.D + d]) continue;
      const slots = P.slotsByDay[d];
      const grid = state.grid[layer];
      let last = -1;
      for (let i = slots.length - 1; i >= 0; i -= 1) if (grid[ci * P.S + slots[i]] !== -1) { last = i; break; }
      const empty = [];
      const twice = [];
      const twiceSubjects = [];
      for (let i = 0; i <= last; i += 1) {
        const a = grid[ci * P.S + slots[i]];
        if (a === -1) { empty.push(P.slotPeriod[slots[i]]); continue; }
        const act = P.acts[a];
        if (act.pair < 0) continue;
        for (let j = 0; j < i; j += 1) {
          const b = grid[ci * P.S + slots[j]];
          if (b === -1 || P.acts[b].pair !== act.pair || (act.double && b === a && j === i - 1)) continue;
          twice.push(act.kind === 1 ? act.labels[act.layers.indexOf(layer)] : `${act.teacher >= 0 ? `${P.teacherName[act.teacher]} 교사 ` : ""}${act.subjectName[act.layers.indexOf(layer)]}`);
          if (act.kind === 0 && b === a) twiceSubjects.push(act.subjectName[act.layers.indexOf(layer)]); // 같은 수업이 하루 두 번 → '2시간 연속 수업 허용' 선택지의 과목
          break;
        }
      }
      if (empty.length && levelOf("gap") !== "off") out.push({ semester, rule: "gap", level: levelOf("gap"), kind: "class", id: P.classIds[ci], day: P.days[d], amount: empty.length,
        cause: `${P.classIds[ci]}반 ${P.days[d]}요일 ${empty.join("·")}교시가 비었습니다(공강 ${empty.length}칸).` });
      if (twice.length && levelOf("oncePerDay") !== "off") out.push({ semester, rule: "oncePerDay", level: levelOf("oncePerDay"), kind: "class", id: P.classIds[ci], day: P.days[d], amount: twice.length,
        ...(twiceSubjects.length ? { subjects: [...new Set(twiceSubjects)] } : {}), cause: `${P.classIds[ci]}반 ${P.days[d]}요일: ${[...new Set(twice)].join(", ")} 수업이 하루에 두 번 있습니다.` });
    }
    for (let ti = 0; ti < P.T; ti += 1) {
      const sideDays = []; // '최대한' 조건은 교사마다 한 줄로 모은다(점심 앞뒤 수업, 같은 날 같은 과목)
      const sameDays = [];
      const name = P.teacherName[ti];
      for (let d = 0; d < P.D; d += 1) {
      const base = ti * P.ABS + d * P.positions;
      const busy = state.tAt[layer];
      let count = 0; let streak = 0; let over = 0; let longest = 0;
      for (let pos = 0; pos < P.positions; pos += 1) { if (busy[base + pos] !== -1) { count += 1; streak += 1; longest = Math.max(longest, streak); if (streak > P.runLimit) over += 1; } else streak = 0; }
      if (!count) continue;
      if (P.weights.lunchSide && P.lunchPositions.length) {
        let side = 99;
        for (const pos of P.lunchPositions) { if (busy[base + pos] !== -1) continue; side = Math.min(side, (pos > 0 && busy[base + pos - 1] !== -1 ? 1 : 0) + (pos + 1 < P.positions && busy[base + pos + 1] !== -1 ? 1 : 0)); }
        if (side === 2) sideDays.push(P.days[d]);
      }
      if (P.weights.sameSubject) {
        const seen = new Set();
        let same = false;
        for (let pos = 0; pos < P.positions; pos += 1) {
          const a = busy[base + pos];
          if (a === -1 || P.acts[a].kind !== 0) continue;
          const key = P.acts[a].subject[P.acts[a].layers.indexOf(layer)];
          if (seen.has(key) && busy[base + pos - 1] !== a) same = true;
          seen.add(key);
        }
        if (same) sameDays.push(P.days[d]);
      }
      if (over) out.push({ semester, rule: "run", level: "hard", kind: "teacher", id: P.teacherIds[ti], day: P.days[d], amount: over, cause: `${name} 교사 ${P.days[d]}요일 ${longest}시간 연강(상한 ${P.runLimit}).` });
      if (count > P.dayLimit) out.push({ semester, rule: "maxPerDay", level: "hard", kind: "teacher", id: P.teacherIds[ti], day: P.days[d], amount: count - P.dayLimit, cause: `${name} 교사 ${P.days[d]}요일 ${count}시간(하루 최대 ${P.dayLimit}).` });
      if (P.lunchPositions.length && P.lunchPositions.every((pos) => busy[base + pos] !== -1) && levelOf("lunch") !== "off") {
        out.push({ semester, rule: "lunch", level: levelOf("lunch"), kind: "teacher", id: P.teacherIds[ti], day: P.days[d], amount: 1, cause: `${name} 교사 ${P.days[d]}요일 점심 시간이 없습니다(학년별 점심 칸에 모두 수업).` });
      }
      }
      if (sideDays.length) out.push({ semester, rule: "lunchSide", level: levelOf("lunchSide") === "hard" ? "hard" : "soft", kind: "teacher", id: P.teacherIds[ti], day: sideDays.join("·"), amount: sideDays.length, cause: `${name} 교사 ${sideDays.join("·")}요일: 점심 바로 앞뒤로 모두 수업이 있습니다.` });
      if (sameDays.length) out.push({ semester, rule: "sameSubjectDay", level: levelOf("sameSubjectDay") === "hard" ? "hard" : "soft", kind: "teacher", id: P.teacherIds[ti], day: sameDays.join("·"), amount: sameDays.length, cause: `${name} 교사 ${sameDays.join("·")}요일: 같은 과목 수업이 하루에 여러 번 있습니다.` });
    }
  });
  return out;
}

// 한 번에 끝까지: options = { seed, iterations, chunk, onProgress(진행), shouldStop() }
function timetableSolve(inputs, options = {}) {
  const run = timetableSolveStart(inputs, options);
  let progress = { done: run.total === 0, iteration: 0, total: run.total, cost: run.state.cost, best: run.best.cost, unplaced: run.state.unplaced, extensions: 0 };
  while (!progress.done) {
    progress = timetableSolveStep(run, Number(options.chunk) || 20000);
    if (typeof options.onProgress === "function") options.onProgress(progress);
    if (typeof options.shouldStop === "function" && options.shouldStop()) break;
  }
  return timetableSolveFinish(run);
}

// ---- 검증기: 결과만 보고 다시 센다(풀이기의 상태·비용 코드를 쓰지 않는다) ----
// 돌려주는 값: { ok(절대 조건 위반 없음), errors: [{ type, semester, text }], counts: { gap, oncePerDay, run, maxPerDay, lunch }, hours: { 학기: 놓인 시수 } }
function timetableValidate(inputs, result) {
  const errors = [];
  const counts = { gap: 0, oncePerDay: 0, run: 0, maxPerDay: 0, lunch: 0 };
  const hours = {};
  const frames = [];
  const violations = []; // 설정 조건 위반(공강·하루 두 번·연강·하루 최대·점심)을 결과의 violations와 같은 모양으로 — 직접 고친 뒤 다시 셀 때 쓴다
  for (const semester of Object.keys(inputs || {}).filter((key) => inputs[key]).sort()) {
    const model = inputs[semester].gradeOf instanceof Map ? inputs[semester] : timetableModel(inputs[semester]);
    const layer = result.layers?.[semester];
    const fail = (type, text) => errors.push({ type, semester, text });
    if (!layer) { fail("missing", `${semester}학기 결과가 없습니다.`); continue; }
    const rules = model.rules;
    const classCells = new Map(); // 반|칸 → 이름
    const teacherCells = new Map(); // 교사|실제 시각 → 이름
    const venueCells = new Map();
    const pairs = new Map(); // 반|요일 → [{ key, period, double, id }]
    let placed = 0;
    const occupy = (classId, grade, key, name) => {
      const slot = model.gradeOf.get(grade)?.slotByKey.get(key);
      if (!slot) { fail("slot", `${name}: ${key}은 ${grade}학년 격자에 없는 칸입니다.`); return null; }
      const cell = `${classId}|${key}`;
      if (classCells.has(cell)) fail("class", `${classId}반 ${key}: ${classCells.get(cell)}와 ${name}이 겹칩니다.`);
      classCells.set(cell, name);
      return slot;
    };
    const teach = (teacherId, slot, name, key) => {
      const teacher = model.teacherOf.get(teacherId);
      if (!teacher) { fail("teacher", `${name}: 명단에 없는 교사 ${teacherId}.`); return; }
      if (teacher.blocked.has(slot.abs)) fail("blocked", `${teacher.name} 교사 ${key}(${name})는 불가 시간입니다.`);
      const cell = `${teacherId}|${slot.abs}`;
      if (teacherCells.has(cell)) fail("teacherClash", `${teacher.name} 교사 ${key}: ${teacherCells.get(cell)}와 ${name}이 겹칩니다.`);
      teacherCells.set(cell, name);
    };
    const useVenue = (venue, slot, name) => {
      if (!venue) return;
      const cell = `${venue}|${slot.abs}`;
      venueCells.set(cell, (venueCells.get(cell) || 0) + 1);
      const cap = Number(model.venues[venue]);
      if (Number.isFinite(cap) && venueCells.get(cell) > cap) fail("venue", `${venue} ${slot.key}: ${venueCells.get(cell)}개 수업이 겹칩니다(${cap}곳) — ${name}.`);
    };
    const notePair = (classId, slot, key, double, id) => {
      const cell = `${classId}|${slot.d}`;
      if (!pairs.has(cell)) pairs.set(cell, []);
      pairs.get(cell).push({ key, period: slot.period, double, id });
    };
    for (const lesson of model.lessons) {
      const item = layer.lessons[lesson.id];
      const name = `${lesson.classId} ${lesson.subject}`;
      if (!item) { fail("hours", `${name}: 결과에 없습니다.`); continue; }
      if (item.slots.length !== lesson.hours || item.slots.some((key) => !key)) fail("hours", `${name}: ${lesson.hours}시간인데 ${item.slots.filter(Boolean).length}칸만 놓였습니다.`);
      if (item.teacherId && !lesson.candidates.includes(item.teacherId)) fail("qualification", `${name}: ${item.teacherId} 교사는 이 수업의 후보(전공 일치)가 아닙니다.`);
      if (lesson.fixedTeacher && item.teacherId && item.teacherId !== lesson.fixedTeacher) fail("fixedTeacher", `${name}: 정해진 교사와 다른 교사가 배정됐습니다.`);
      const bare = new Set(item.bareSlots || []);
      if (item.frame) frames.push({ kind: "lesson", semester, classId: lesson.classId, department: lesson.department, hours: lesson.hours, slots: item.slots.slice().sort().join(","), teacherId: item.teacherId });
      for (const key of item.slots.filter(Boolean)) {
        const slot = occupy(lesson.classId, lesson.grade, key, name);
        if (!slot) continue;
        placed += 1;
        const taught = item.teacherId && !bare.has(key);
        if (taught) { teach(item.teacherId, slot, name, key); useVenue(lesson.venue, slot, name); }
        notePair(lesson.classId, slot, taught ? `t:${item.teacherId}` : `l:${lesson.id}`, lesson.double, lesson.id);
      }
    }
    for (const block of model.blocks) {
      const item = layer.blocks[block.id];
      const name = `${block.grade}학년 ${block.label}`;
      if (!item) { fail("hours", `${name}: 결과에 없습니다.`); continue; }
      if (item.slots.length !== block.hours || item.slots.some((key) => !key)) fail("hours", `${name}: ${block.hours}시간인데 ${item.slots.filter(Boolean).length}칸만 놓였습니다.`);
      const given = block.times.map((time) => `${time.day}${time.period}`);
      if (!item.timesOverridden && given.length >= block.hours && new Set(given).size >= block.hours && item.slots.some((key) => !given.includes(key))) fail("blockTime", `${name}: 정해진 블록 시간(${given.join(",")})과 다릅니다.`);
      const bare = new Set(item.bareSlots || []);
      if (item.frame) frames.push({ kind: "block", semester, classId: `${block.grade}|${block.classIds.join(",")}`, department: "", hours: block.hours, slots: item.slots.slice().sort().join(","), teacherId: "" });
      const used = new Set();
      for (const section of block.sections) {
        const teacherId = item.teachers?.[section.id] || null;
        if (!teacherId) continue;
        if (!section.candidates.includes(teacherId)) fail("qualification", `${name} ${section.subject}: ${teacherId} 교사는 후보(전공 일치)가 아닙니다.`);
        if (used.has(teacherId)) fail("teacherClash", `${name}: ${teacherId} 교사가 두 분반에 있습니다.`);
        used.add(teacherId);
      }
      for (const key of item.slots.filter(Boolean)) {
        let slot = null;
        for (const classId of block.classIds) { slot = occupy(classId, block.grade, key, name) || slot; placed += 1; }
        if (!slot) continue;
        for (const classId of block.classIds) notePair(classId, slot, `b:${block.id}`, false, block.id);
        if (bare.has(key)) continue;
        const inBlock = new Map(); // 블록 안에서 실 수를 넘는 분반(입력 자료 문제)은 장소를 세지 않는다
        for (const section of block.sections) {
          const teacherId = item.teachers?.[section.id];
          if (teacherId) teach(teacherId, slot, `${name} ${section.subject}`, key);
          if (!section.venue) continue;
          inBlock.set(section.venue, (inBlock.get(section.venue) || 0) + 1);
          const cap = Number(model.venues[section.venue]);
          if (!Number.isFinite(cap) || inBlock.get(section.venue) <= cap) useVenue(section.venue, slot, name);
        }
      }
    }
    const creativeHours = new Map();
    for (const item of layer.creative || []) {
      const targets = item.scope === "class" ? [[item.classId, item.classId.split("-")[0]]] : model.grades.filter((grade) => item.scope === "school" || grade.grade === item.grade).flatMap((grade) => grade.classes.map((classId) => [classId, grade.grade]));
      for (const key of item.slots.filter(Boolean)) for (const [classId, grade] of targets) {
        const slot = occupy(classId, grade, key, "창체");
        if (!slot) continue;
        placed += 1;
        creativeHours.set(classId, (creativeHours.get(classId) || 0) + 1);
        if (item.scope === "class" && item.teacherId) teach(item.teacherId, slot, `${classId} 창체`, key);
      }
    }
    for (const grade of model.grades) for (const classId of grade.classes) {
      const need = model.creative.byGrade[grade.grade]?.total || 0;
      if ((creativeHours.get(classId) || 0) !== need) fail("hours", `${classId}반 창체: ${need}시간인데 ${creativeHours.get(classId) || 0}칸 놓였습니다.`);
    }
    hours[semester] = placed;
    // 설정 조건 다시 세기
    for (const grade of model.grades) for (const classId of grade.classes) {
      for (let d = 0; d < model.days.length; d += 1) {
        const periods = grade.slots.filter((slot) => slot.d === d);
        const filled = periods.map((slot) => classCells.has(`${classId}|${slot.key}`));
        const last = filled.lastIndexOf(true);
        if (last >= 0 && rules.gap !== "off") {
          const empty = periods.slice(0, last).filter((slot, index) => !filled[index]).map((slot) => slot.period);
          counts.gap += empty.length;
          if (empty.length) violations.push({ semester, rule: "gap", level: rules.gap, kind: "class", id: classId, day: model.days[d], amount: empty.length, cause: `${classId}반 ${model.days[d]}요일 ${empty.join("·")}교시가 비었습니다(공강 ${empty.length}칸).` });
        }
        if (rules.oncePerDay === "off") continue;
        const list = (pairs.get(`${classId}|${d}`) || []).sort((a, b) => a.period - b.period);
        const seen = [];
        const twice = [];
        for (const entry of list) {
          const prior = seen.filter((other) => other.key === entry.key);
          if (prior.length && !(entry.double && prior.length === 1 && prior[0].id === entry.id && prior[0].period === entry.period - 1)) { counts.oncePerDay += 1; twice.push(classCells.get(`${classId}|${model.days[d]}${entry.period}`) || entry.id); }
          seen.push(entry);
        }
        if (twice.length) violations.push({ semester, rule: "oncePerDay", level: rules.oncePerDay, kind: "class", id: classId, day: model.days[d], amount: twice.length, cause: `${classId}반 ${model.days[d]}요일: ${[...new Set(twice)].join(", ")} 수업이 하루에 두 번 있습니다(같은 교사).` });
      }
    }
    const lunch = model.lunchPositions;
    for (const teacher of model.teachers) for (let d = 0; d < model.days.length; d += 1) {
      const busy = Array.from({ length: model.positions }, (_, pos) => teacherCells.has(`${teacher.id}|${d * model.positions + pos}`));
      const total = busy.filter(Boolean).length;
      if (!total) continue;
      let streak = 0;
      let over = 0;
      let longest = 0;
      for (const value of busy) { if (value) { streak += 1; longest = Math.max(longest, streak); if (Number(rules.run) > 0 && streak > Number(rules.run)) over += 1; } else streak = 0; }
      counts.run += over;
      const day = model.days[d];
      if (over) violations.push({ semester, rule: "run", level: "hard", kind: "teacher", id: teacher.id, day, amount: over, cause: `${teacher.name} 교사 ${day}요일 ${longest}시간 연강(상한 ${Number(rules.run)}).` });
      if (Number(rules.maxPerDay) > 0 && total > Number(rules.maxPerDay)) {
        counts.maxPerDay += total - Number(rules.maxPerDay);
        violations.push({ semester, rule: "maxPerDay", level: "hard", kind: "teacher", id: teacher.id, day, amount: total - Number(rules.maxPerDay), cause: `${teacher.name} 교사 ${day}요일 ${total}시간(하루 최대 ${Number(rules.maxPerDay)}).` });
      }
      if (rules.lunch !== "off" && lunch.length && lunch.every((pos) => busy[pos])) {
        counts.lunch += 1;
        violations.push({ semester, rule: "lunch", level: rules.lunch, kind: "teacher", id: teacher.id, day, amount: 1, cause: `${teacher.name} 교사 ${day}요일 점심 시간이 없습니다(학년별 점심 칸에 모두 수업).` });
      }
    }
  }
  // 두 학기 뼈대: 묶음으로 표시된 수업·블록은 다른 학기에 같은 반·같은 칸(수업은 같은 교사)의 짝이 있어야 한다.
  const semesters = [...new Set(frames.map((item) => item.semester))];
  if (semesters.length > 1) {
    const keyOf = (item) => `${item.kind}|${item.classId}|${item.hours}|${item.slots}|${item.teacherId || ""}`;
    const bag = new Map();
    for (const item of frames) { const key = keyOf(item); if (!bag.has(key)) bag.set(key, {}); bag.get(key)[item.semester] = (bag.get(key)[item.semester] || 0) + 1; }
    for (const [key, entry] of bag) if (semesters.some((semester) => (entry[semester] || 0) !== (entry[semesters[0]] || 0))) errors.push({ type: "frame", semester: "", text: `두 학기 묶음이 같은 칸에 있지 않습니다: ${key}` });
  }
  return { ok: errors.length === 0, errors, counts, hours, violations };
}

// ---- Worker: 조각으로 돌려 진행 상황을 보내고 중단 요청을 받는다 ----
function TIMETABLE_FUNCTIONS_FOR_WORKER() {
  return [timetableWhere, timetableParseTime, timetableTimes, timetableNumber, timetableMatch, timetableCoverage, timetableDayCapacity, timetableModel, timetablePrecheck,
    timetableRng, timetableRuleWeight, timetableProblem, timetableState, timetableCanPlace, timetableMark, timetableClassDayCost, timetableTeacherDayCost, timetableRecount, timetableDelta, timetableCommit,
    timetableConstruct, timetableTryMove, timetableSetTeacher, timetableRelease, timetableTrySwapTeachers, timetableSnapshot, timetableRestoreSnapshot, timetableSolveStart, timetableSolveStep, timetableSolveFinish, timetableViolations, timetableSolve];
}

function timetableWorkerSource() {
  const constants = { TIMETABLE_DEFAULT_RULES, TIMETABLE_WHERE, TIMETABLE_SOLVE_VERSION, TIMETABLE_HARD_WEIGHTS, TIMETABLE_SOFT_WEIGHTS, TIMETABLE_UNPLACED_WEIGHT, TIMETABLE_DEFAULT_ITERATIONS, TIMETABLE_DEFAULT_ROUNDS };
  const lines = Object.entries(constants).map(([name, value]) => `var ${name} = ${JSON.stringify(value)};`);
  return `"use strict";\n${lines.join("\n")}\n${TIMETABLE_FUNCTIONS_FOR_WORKER().map((fn) => fn.toString()).join("\n")}
var timetableRun = null;
function timetableTick() {
  if (!timetableRun) return;
  var run = timetableRun;
  try {
    var progress = timetableSolveStep(run.solve, run.chunk);
    if (progress.done || run.stop) { timetableRun = null; self.postMessage({ id: run.id, ok: true, done: true, stopped: Boolean(run.stop) && !progress.done, value: timetableSolveFinish(run.solve) }); return; }
    self.postMessage({ id: run.id, ok: true, done: false, progress: progress });
    setTimeout(timetableTick, 0);
  } catch (error) { timetableRun = null; self.postMessage({ id: run.id, ok: false, error: String(error && error.message || error) }); }
}
self.onmessage = function (event) {
  var data = event.data || {};
  if (data.type === "stop") { if (timetableRun && timetableRun.id === data.id) timetableRun.stop = true; return; }
  try { timetableRun = { id: data.id, chunk: Number(data.chunk) || 10000, stop: false, solve: timetableSolveStart(data.inputs, data.options || {}) }; setTimeout(timetableTick, 0); }
  catch (error) { self.postMessage({ id: data.id, ok: false, error: String(error && error.message || error) }); }
};`;
}

if (typeof module !== "undefined" && module.exports) {
  Object.assign(module.exports, { timetableProblem, timetableSolveStart, timetableSolveStep, timetableSolveFinish, timetableSolve, timetableValidate, timetableWorkerSource });
}
