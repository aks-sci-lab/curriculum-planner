// 7단계 시간표 앱 연결(timetable-view.js): 5·6단계 자료를 시간표 입력으로 모은다(읽기 전용, 같은 값을 다시 입력받지 않음).
// class-sections-view.js 뒤에 로드한다. 조건 설정·사전 점검·선택형 해결 화면과 시간표 계산(Worker 여럿)·결과 화면도 이 파일에 있다.
// 자료 출처: 과목·학점·반 수·공통 과목 반별 담당·창체 시수 = 5단계 computeHoursStats, 블록·분반·분반 교사·학급 단위 과목·교사 명단·격자 = 6단계 state.classSections.
// 시간표에만 있는 조건(요일별 교시 수, 점심, 창체 나눔, 담임, 규칙, 장소)은 state.timetable.settings — 없으면 기본값으로 계산하고 '가정' 목록에 적는다.

// 차례: 순수 도우미(저장 복원·반 일부만 듣는 과목의 반 배정·점검 비교) → 자료 모으기(timetableInput) → '// ---- 화면' 아래 조건 설정·사전 점검 화면.

// 저장 복원(예전 저장분·백업에는 없음 → 빈 객체). settings = 시간표 조건, 숫자 키 = 차수별 계산 결과 { at, seconds, tried, stopped, signature, validation, result }.
function timetableRestore(saved) {
  const plain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (!plain(saved)) return {};
  const result = {};
  for (const [key, value] of Object.entries(saved)) {
    if (key === "settings" && plain(value)) result.settings = value;
    else if (/^\d+$/.test(key) && plain(value)) result[key] = value;
  }
  return result;
}

// 반 일부만 듣는 학교 지정 과목(교차집중·분할 편성) 묶음: 5단계 항목의 item.split(같은 편제표 행)으로 묶는다.
// 돌려주는 값: [{ key: '학년|과목↔과목', grade, crossed, label, members: [{ subject, index, counts: { 1: 반 수, 2: 반 수 } }] }]
function timetableSplitGroups(items) {
  const groups = new Map();
  for (const item of items || []) {
    if (!item.split || !item.designated) continue;
    const id = `${item.grade}|${item.split.row}`;
    if (!groups.has(id)) groups.set(id, { grade: String(item.grade), crossed: Boolean(item.split.crossed), members: new Map() });
    const group = groups.get(id);
    if (!group.members.has(item.subject)) group.members.set(item.subject, { subject: item.subject, index: Number(item.split.index) || 0, counts: { 1: 0, 2: 0 } });
    group.members.get(item.subject).counts[String(item.semester)] = Number(item.autoClasses) || 0;
  }
  return [...groups.values()].map((group) => {
    const members = [...group.members.values()].sort((a, b) => a.index - b.index);
    const names = members.map((member) => member.subject);
    return { key: `${group.grade}|${names.join("↔")}`, grade: group.grade, crossed: group.crossed, members,
      label: `${group.grade}학년 ${names.join(group.crossed ? " ↔ " : " · ")}(${group.crossed ? "교차집중" : "분할 편성"})` };
  });
}

function timetableClassList(text, total) {
  const out = [];
  for (const token of String(text ?? "").split(/[,\s]+/).map((item) => item.trim().replace(/반$/, "")).filter(Boolean)) {
    const range = token.match(/^(\d+)\s*[-~]\s*(\d+)$/);
    if (range) { for (let n = Number(range[1]); n <= Number(range[2]) && n <= total; n += 1) out.push(String(n)); continue; }
    if (!/^\d+$/.test(token)) return null;
    out.push(String(Number(token)));
  }
  return out;
}

// 묶음의 반 배정: 기준 학기(1학기, 없으면 2학기)에 과목마다 듣는 반을 정하고, 교차집중이면 다른 학기는 서로 바꾼다.
// saved = { 과목: '1,2,3' }(기준 학기에 듣는 반, 한 과목을 비우면 남는 반). 반 수가 편제표 × 학급 수(1단계 교차집중 팝업의 1반 더 받을 과목 포함)와 다르면 쓰지 않고 errors에 적는다.
// 돌려주는 값: { base, classes: { 학기: { 과목: [반] } }, source: 'saved' | 'default', errors }
function timetableSplitPlan(group, total, saved = null) {
  const members = group.members;
  const base = members.some((member) => member.counts[1] > 0) ? "1" : "2";
  const other = base === "1" ? "2" : "1";
  const all = Array.from({ length: total }, (_, index) => String(index + 1));
  const rolling = (order, semester, pool = all) => {
    const out = {};
    let at = 0;
    for (const member of order) {
      const count = Math.min(member.counts[semester], pool.length);
      out[member.subject] = Array.from({ length: count }, (_, index) => pool[(at + index) % pool.length]).sort((x, y) => Number(x) - Number(y));
      at += count;
    }
    return out;
  };
  const errors = [];
  let assign = null;
  const given = members.filter((member) => String(saved?.[member.subject] ?? "").trim());
  if (given.length) {
    const picked = {};
    const used = new Set();
    let ok = true;
    for (const member of given) {
      const list = timetableClassList(saved[member.subject], total);
      if (!list || list.some((id) => !all.includes(id))) { errors.push(`${member.subject}: 반 번호를 1~${total} 사이 숫자로 적어 주세요(예: 1,2,3 또는 1-3).`); ok = false; continue; }
      const unique = [...new Set(list)];
      if (unique.some((id) => used.has(id))) { errors.push(`${member.subject}: 다른 과목과 겹치는 반이 있습니다.`); ok = false; continue; }
      if (unique.length !== member.counts[base]) { errors.push(`${member.subject}: ${base}학기 ${member.counts[base]}반이어야 합니다(지금 ${unique.length}반) — 편제표 × 학급 수.`); ok = false; continue; }
      unique.forEach((id) => used.add(id));
      picked[member.subject] = unique.sort((x, y) => Number(x) - Number(y));
    }
    if (ok) {
      const rest = members.filter((member) => !given.includes(member));
      Object.assign(picked, rolling(rest, base, all.filter((id) => !used.has(id))));
      assign = picked;
    }
  }
  const source = assign ? "saved" : "default";
  if (!assign) assign = rolling(members, base);
  const classes = { [base]: assign };
  if (members.some((member) => member.counts[other] > 0)) {
    const sameCounts = (map) => members.every((member) => (map[member.subject] || []).length === member.counts[other]);
    if (!group.crossed) classes[other] = sameCounts(assign) ? assign : rolling(members, other);
    else {
      // 교차집중: 한 학기에 이 과목을 들은 반은 다른 학기에 다른 과목을 듣는다(두 과목이면 맞바꿈).
      const swapped = members.length === 2 ? { [members[0].subject]: assign[members[1].subject] || [], [members[1].subject]: assign[members[0].subject] || [] } : null;
      classes[other] = swapped && sameCounts(swapped) ? swapped : rolling(members.slice().reverse(), other);
    }
  }
  return { base, classes, source, errors };
}

// 조건을 바꾸기 전·후 사전 점검 비교: 같은 항목(점검 번호 + 대상)끼리 맞춰 풀린 것·새로 생긴 것·달라진 것.
function timetableIssueChanges(before, after) {
  const keyOf = (issue) => `${issue.id}|${String(issue.cause).split(/[:(]/)[0].trim()}`;
  const serious = (issue) => issue.level !== "info";
  const index = (list) => { const map = new Map(); for (const issue of (list || []).filter(serious)) { const key = keyOf(issue); if (!map.has(key)) map.set(key, []); map.get(key).push(issue); } return map; };
  const old = index(before);
  const now = index(after);
  const resolved = [];
  const added = [];
  const changed = [];
  for (const [key, list] of old) {
    const next = now.get(key) || [];
    if (!next.length) resolved.push(...list);
    else if (list.map((issue) => issue.cause).join("\n") !== next.map((issue) => issue.cause).join("\n")) changed.push(...next.map((issue, order) => ({ before: list[order]?.cause || "", after: issue })));
  }
  for (const [key, list] of now) if (!old.has(key)) added.push(...list);
  return { resolved, added, changed };
}

// ---- 계산 결과(순수): 입력 서명·여러 답 중 고르기·반 표와 교사 표 ----

// 입력이 계산 때와 같은지 보는 짧은 서명(조건·자료가 바뀌면 결과에 '바뀌기 전 것' 표시).
function timetableSignature(inputs) {
  const text = JSON.stringify(inputs ?? null);
  let a = 5381;
  let b = 52711;
  for (let i = 0; i < text.length; i += 1) { const code = text.charCodeAt(i); a = (a * 33) ^ code; b = (b * 33) ^ code; a |= 0; b |= 0; }
  return `${text.length}.${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
}

// 여러 일꾼의 답 중 가장 좋은 것: 못 넣은 시간 → '반드시' 위반 → 담당 교사 없음 → 비용 → 씨앗 순.
function timetableBestResult(list) {
  const rank = (result) => [result?.metrics?.unplacedHours ?? Infinity, result?.metrics?.hard ?? Infinity, result?.metrics?.noTeacherHours ?? Infinity, result?.metrics?.cost ?? Infinity, result?.seed ?? Infinity];
  let best = null;
  for (const result of list || []) {
    if (!result || !result.layers) continue;
    if (!best) { best = result; continue; }
    const a = rank(result);
    const b = rank(best);
    for (let i = 0; i < a.length; i += 1) { if (a[i] !== b[i]) { if (a[i] < b[i]) best = result; break; } }
  }
  return best;
}

// 일꾼마다 다른 설정(씨앗을 달리하고, 흔들기 있는 것과 한 번 길게 식히는 것을 섞는다).
function timetableWorkerPlans(count, seed = 1) {
  const plans = [];
  for (let i = 0; i < Math.max(1, count); i += 1) plans.push(i % 3 === 2 ? { seed: seed + i, rounds: 0, long: true } : { seed: seed + i });
  return plans;
}

// 결과 한 학기 → 반 표·교사 표. input = 그 학기 시간표 입력, layer = result.layers[학기].
// 돌려주는 값: { days, classes: [{ id, grade, rows: [{ period, lunch }] , cells: { '월1': [{ kind, text, teacher, noTeacher }] } }],
//               teachers: [{ id, name, hours, cells: { 'd|pos': [{ text, where }] } }], teacherRows: [{ pos, label }] }
function timetableResultTables(input, layer) {
  const model = timetableModel(input);
  const nameOf = (id) => model.teacherOf.get(id)?.name || id;
  const classes = new Map();
  const maxPeriods = Math.max(0, ...Object.values(model.periodsOf));
  for (const grade of model.grades) {
    const rows = [];
    for (let period = 1; period <= maxPeriods; period += 1) { rows.push({ period }); if (period === grade.lunchAfter && period < maxPeriods) rows.push({ lunch: true }); }
    for (const id of grade.classes) classes.set(id, { id, grade: grade.grade, rows, cells: {} });
  }
  const teachers = new Map();
  const teacherCell = (id, abs, entry) => {
    if (!id) return;
    if (!teachers.has(id)) teachers.set(id, { id, name: nameOf(id), hours: 0, cells: {} });
    const row = teachers.get(id);
    const key = `${Math.floor(abs / model.positions)}|${abs % model.positions}`;
    (row.cells[key] || (row.cells[key] = [])).push(entry);
    row.hours += 1;
  };
  const classCell = (id, key, entry) => { const row = classes.get(id); if (row) (row.cells[key] || (row.cells[key] = [])).push(entry); };
  const absOf = new Map(model.grades.map((grade) => [grade.grade, new Map(grade.slots.map((slot) => [slot.key, slot.abs]))]));
  const result = layer || { lessons: {}, blocks: {}, creative: [] };
  for (const lesson of model.lessons) {
    const item = result.lessons?.[lesson.id];
    if (!item) continue;
    const bare = new Set(item.bareSlots || []);
    const otherOf = new Map(); // 나눠 맡긴 수업: 그 칸을 맡은 다른 교사
    for (const part of item.others || []) for (const key of part.slots || []) otherOf.set(key, part.teacherId);
    for (const key of item.slots || []) {
      if (!key) continue;
      const teacherId = otherOf.get(key) || item.teacherId;
      const none = !teacherId || bare.has(key);
      classCell(lesson.classId, key, { kind: "lesson", text: lesson.subject, teacher: none ? "" : nameOf(teacherId), noTeacher: none });
      if (!none) teacherCell(teacherId, absOf.get(lesson.grade).get(key), { text: lesson.subject, where: lesson.classId });
    }
  }
  for (const block of model.blocks) {
    const item = result.blocks?.[block.id];
    if (!item) continue;
    const bare = new Set(item.bareSlots || []);
    for (const key of item.slots || []) {
      if (!key) continue;
      for (const id of block.classIds) classCell(id, key, { kind: "block", text: block.label, teacher: "", noTeacher: false });
      if (bare.has(key)) continue;
      for (const section of block.sections) teacherCell(item.teachers?.[section.id], absOf.get(block.grade).get(key), { text: section.subject, where: block.label });
    }
  }
  for (const entry of result.creative || []) {
    const targets = entry.scope === "school" ? [...classes.keys()] : entry.scope === "grade" ? [...classes.values()].filter((row) => row.grade === String(entry.grade)).map((row) => row.id) : [entry.classId];
    for (const key of entry.slots || []) {
      if (!key) continue;
      for (const id of targets) classCell(id, key, { kind: "creative", text: "창체", teacher: entry.teacherId ? nameOf(entry.teacherId) : "", noTeacher: false });
      if (entry.scope === "class" && entry.teacherId && classes.has(entry.classId)) teacherCell(entry.teacherId, absOf.get(classes.get(entry.classId).grade).get(key), { text: "창체", where: entry.classId });
    }
  }
  // 교사 표의 줄 = 실제 시각 칸(학년마다 점심이 달라 같은 '4교시'가 다른 시각일 수 있다)
  const teacherRows = [];
  for (let pos = 0; pos < model.positions; pos += 1) {
    const byPeriod = new Map();
    for (const grade of model.grades) {
      const slot = grade.slots.find((item) => item.abs % model.positions === pos);
      if (slot) { if (!byPeriod.has(slot.period)) byPeriod.set(slot.period, []); byPeriod.get(slot.period).push(grade.grade); }
    }
    if (!byPeriod.size) continue;
    const all = [...byPeriod.values()].reduce((sum, list) => sum + list.length, 0) === model.grades.length && byPeriod.size === 1;
    teacherRows.push({ pos, label: [...byPeriod.entries()].map(([period, grades]) => `${period}교시${all ? "" : `(${grades.join("·")}학년)`}`).join(" / ") });
  }
  const order = model.teachers.map((teacher) => teacher.id);
  return { days: model.days.slice(), classes: [...classes.values()], teacherRows,
    teachers: [...teachers.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) };
}

// 결과 → 엑셀 시트(createWorkbookBlob 모양, 순수). 학기마다 '학급'(반 × 요일·교시)·'교사'(교사 × 요일·실제 시각) 전체 표 + '못 지킨 조건' + '담당 교사 없음'.
// inputs = { 학기: 시간표 입력 }, labels = { title: '2027학년도 2차' , rules: { 규칙: 이름 }, reasons: { 이유: 글 } }. 스타일 번호는 보고서 공통(1 제목, 2 머리글, 3 왼쪽, 4 가운데, 9 강조).
function timetableResultSheets(inputs, result, labels = {}) {
  const column = (index) => { let name = ""; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name; return name; };
  const sheets = [];
  const title = labels.title ? `${labels.title} ` : "";
  for (const semester of Object.keys(result?.layers || {}).sort()) {
    if (!inputs?.[semester]) continue;
    const tables = timetableResultTables(inputs[semester], result.layers[semester]);
    const periods = Math.max(0, ...tables.classes.flatMap((row) => row.rows.map((item) => item.period || 0)));
    const classHead = [{ v: "반", s: 2 }];
    const classSub = [{ v: "", s: 2 }];
    const classMerges = [`A1:${column(tables.days.length * periods)}1`, "A2:A3"];
    tables.days.forEach((day, d) => {
      for (let period = 1; period <= periods; period += 1) { classHead.push({ v: period === 1 ? day : "", s: 2 }); classSub.push({ v: period, s: 2 }); }
      if (periods > 1) classMerges.push(`${column(1 + d * periods)}2:${column(d * periods + periods)}2`);
    });
    const cellOf = (entries, sub) => {
      if (!entries || !entries.length) return { v: "", s: 4 };
      return { v: entries.map((entry) => [entry.text, sub(entry)].filter(Boolean).join("\n")).join(" / "), s: entries.some((entry) => entry.noTeacher) || entries.length > 1 ? 9 : 4 };
    };
    sheets.push({ name: `${semester}학기 학급`, freeze: "B4", widths: [7, ...tables.days.flatMap(() => Array.from({ length: periods }, () => 11))], merges: classMerges, heights: [28],
      rows: [[{ v: `${title}${semester}학기 학급별 시간표`, s: 1 }], classHead, classSub,
        ...tables.classes.map((row) => [{ v: row.id, s: 2 }, ...tables.days.flatMap((day) => Array.from({ length: periods }, (_, index) => cellOf(row.cells[`${day}${index + 1}`], (entry) => (entry.noTeacher ? "담당 교사 없음" : entry.teacher))))])] });
    const width = tables.teacherRows.length;
    const teacherHead = [{ v: "교사", s: 2 }, { v: "시수", s: 2 }];
    const teacherSub = [{ v: "", s: 2 }, { v: "", s: 2 }];
    const teacherMerges = [`A1:${column(1 + tables.days.length * width)}1`, "A2:A3", "B2:B3"];
    tables.days.forEach((day, d) => {
      tables.teacherRows.forEach((row, index) => { teacherHead.push({ v: index === 0 ? day : "", s: 2 }); teacherSub.push({ v: row.label.replace(/교시/g, "").replace(/학년/g, ""), s: 2 }); });
      if (width > 1) teacherMerges.push(`${column(2 + d * width)}2:${column(1 + d * width + width)}2`);
    });
    sheets.push({ name: `${semester}학기 교사`, freeze: "C4", widths: [12, 5, ...tables.days.flatMap(() => Array.from({ length: width }, () => 11))], merges: teacherMerges, heights: [28],
      rows: [[{ v: `${title}${semester}학기 교사별 시간표`, s: 1 }], teacherHead, teacherSub,
        ...tables.teachers.map((row) => [{ v: row.name, s: 2 }, { v: row.hours, s: 4 }, ...tables.days.flatMap((day, d) => tables.teacherRows.map((item) => cellOf(row.cells[`${d}|${item.pos}`], (entry) => entry.where)))])] });
  }
  const violations = result?.violations || [];
  sheets.push({ name: "못 지킨 조건", widths: [7, 9, 16, 90], rows: [[{ v: "학기", s: 2 }, { v: "구분", s: 2 }, { v: "조건", s: 2 }, { v: "내용", s: 2 }],
    ...violations.slice().sort((a, b) => (a.level === "hard" ? 0 : 1) - (b.level === "hard" ? 0 : 1) || String(a.semester).localeCompare(String(b.semester)))
      .map((item) => [{ v: `${item.semester}학기`, s: 4 }, { v: item.level === "hard" ? "반드시" : "최대한", s: item.level === "hard" ? 9 : 4 }, { v: labels.rules?.[item.rule] || item.rule, s: 4 }, { v: item.cause, s: 3 }])] });
  sheets.push({ name: "담당 교사 없음", widths: [7, 7, 24, 22, 7, 44], rows: [[{ v: "학기", s: 2 }, { v: "학년", s: 2 }, { v: "과목", s: 2 }, { v: "반·블록", s: 2 }, { v: "시간", s: 2 }, { v: "이유", s: 2 }],
    ...(result?.noTeacher || []).map((item) => [{ v: `${item.semester}학기`, s: 4 }, { v: item.grade, s: 4 }, { v: item.subject, s: 3 }, { v: item.classId, s: 3 }, { v: Number(item.hours) || 0, s: 4 }, { v: labels.reasons?.[item.reason] || item.reason, s: 3 }])] });
  return sheets;
}

// 직접 고치기(순수): 한 반 시간표의 두 칸 내용을 맞바꾼다. 반 수업과 빈칸만 — 블록·창체 칸은 학년(반 묶음) 전체가 함께 움직여야 해서 반 하나만 옮길 수 없다.
// 절대 조건(반·교사 겹침, 불가 시간, 장소, 시수)은 검증기로 다시 보고, 어기면 바꾸지 않고 이유를 돌려준다. 설정 조건 위반 목록은 검증기가 다시 센 것으로 바꾼다.
// 돌려주는 값: { ok: true, result, text } 또는 { ok: false, reason }
// 직접 고치기 공통(순수): 고친 결과 next를 검증기로 다시 보고, 새 절대 조건 오류가 있으면 { reason }, 없으면 next의 위반 목록·수('반드시'·'최대한' 모두)를
// 검증기가 다시 센 값으로 바꾸고 고치기 전과 견준 변화 { hard: 늘어난 '반드시' 위반 수(음수 = 줄어듦), soft, parts: ['공강 +1', …] }를 돌려준다.
// before = 고치기 전 결과의 검증 결과(여러 칸을 한꺼번에 살필 때 한 번만 계산해 넘긴다).
function timetableEditCheck(inputs, result, next, before) {
  const check = timetableValidate(inputs, next);
  const known = new Set(before.errors.map((item) => `${item.semester}|${item.text}`));
  const fresh = check.errors.filter((item) => !known.has(`${item.semester}|${item.text}`));
  if (fresh.length) return { reason: fresh.slice(0, 2).map((item) => item.text).join(" / ") };
  const amount = (list, level) => list.filter((item) => (level === "hard") === (item.level === "hard")).reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const byRule = (list) => { const out = {}; for (const item of list) if (item.level === "hard") out[item.rule] = (out[item.rule] || 0) + (Number(item.amount) || 0); return out; };
  const was = byRule(before.violations);
  const now = byRule(check.violations);
  const parts = [...new Set([...Object.keys(was), ...Object.keys(now)])].map((rule) => [rule, (now[rule] || 0) - (was[rule] || 0)]).filter(([, diff]) => diff)
    .map(([rule, diff]) => `${TIMETABLE_VIOLATION_LABELS[rule] || rule} ${diff > 0 ? "+" : "−"}${Math.abs(diff)}`);
  next.violations = check.violations; // 검증기가 '반드시'·'최대한' 조건을 모두 다시 센다(풀이기와 같은 셈)
  next.metrics = { ...next.metrics, hard: amount(check.violations, "hard"), gap: check.counts.gap, oncePerDay: check.counts.oncePerDay, run: check.counts.run, maxPerDay: check.counts.maxPerDay, lunch: check.counts.lunch };
  next.edits = (Number(result.edits) || 0) + 1;
  return { change: { hard: amount(check.violations, "hard") - amount(before.violations, "hard"), soft: amount(check.violations, "soft") - amount(before.violations, "soft"), parts } };
}

function timetableEditSwap(inputs, result, { semester, classId, a, b, before: given }) {
  const refuse = (reason) => ({ ok: false, reason });
  const input = inputs?.[semester];
  const layer = result?.layers?.[semester];
  if (!input || !layer) return refuse("이 학기의 계산 결과가 없습니다.");
  if (a === b) return refuse("같은 칸입니다.");
  const model = input.gradeOf instanceof Map ? input : timetableModel(input); // 이미 만든 모형을 넘겨도 된다(여러 칸을 한꺼번에 살필 때)
  const grade = model.grades.find((item) => item.classes.includes(classId));
  if (!grade || !grade.slotByKey.has(a) || !grade.slotByKey.has(b)) return refuse("이 반의 시간표에 없는 칸입니다.");
  const what = (key, room = classId) => {
    for (const block of model.blocks) if (block.classIds.includes(room) && (layer.blocks?.[block.id]?.slots || []).includes(key)) return { kind: "block", id: block.id, name: block.label };
    for (const item of layer.creative || []) {
      const mine = item.scope === "school" || (item.scope === "grade" && String(item.grade) === grade.grade) || item.classId === room;
      if (mine && (item.slots || []).includes(key)) return { kind: "creative", name: "창체" };
    }
    for (const lesson of model.lessons) if (lesson.classId === room && (layer.lessons?.[lesson.id]?.slots || []).includes(key)) return { kind: "lesson", id: lesson.id, name: lesson.subject };
    return { kind: "empty", name: "빈칸" };
  };
  const first = what(a);
  const second = what(b);
  for (const [key, cell] of [[a, first], [b, second]]) if (cell.kind === "creative") return refuse(`${key}은 창체 시간이라 옮길 수 없습니다(창체 시간은 조건 설정에서 정합니다).`);
  if (first.kind === "empty" && second.kind === "empty") return refuse("두 칸 모두 비어 있습니다.");
  if (first.kind === "lesson" && second.kind === "lesson" && first.id === second.id) return refuse("같은 수업의 두 시간입니다.");
  if (first.kind === "block" && second.kind === "block" && first.id === second.id) return refuse("같은 블록의 두 시간입니다.");
  // 블록 칸이 끼면 '블록 한 시간 옮기기': 그 블록을 듣는 모든 반에서 함께 옮긴다 — 옮겨 갈 칸의 반 수업들은 블록이 있던 칸으로, 같은 반들의 다른 블록이면 둘이 자리를 맞바꾼다.
  const blockMove = first.kind === "block" || second.kind === "block" ? (() => {
    const [from, to, moving, target] = first.kind === "block" ? [a, b, first, second] : [b, a, second, first];
    const block = model.blocks.find((item) => item.id === moving.id);
    const riders = []; // [수업 id] — 옮겨 갈 칸에 있던 반 수업(블록이 있던 칸으로 간다)
    let partner = null;
    for (const room of block.classIds) {
      const cell = what(to, room);
      if (cell.kind === "creative") return { reason: `${to}은 ${room}반의 창체 시간이라 ${block.label}을 옮길 수 없습니다.` };
      if (cell.kind === "block") { if (partner && partner !== cell.id) return { reason: `${to}에는 반마다 다른 블록이 있어 ${block.label}과 맞바꿀 수 없습니다.` }; partner = cell.id; }
      else if (cell.kind === "lesson") riders.push(cell.id);
    }
    if (partner) {
      const other = model.blocks.find((item) => item.id === partner);
      if (riders.length || other.classIds.join() !== block.classIds.join()) return { reason: `${to}의 ${other.label}은 듣는 반이 달라 ${block.label}과 맞바꿀 수 없습니다.` };
    }
    void target;
    return { from, to, block, riders, partner: partner ? model.blocks.find((item) => item.id === partner) : null };
  })() : null;
  if (blockMove && blockMove.reason) return refuse(blockMove.reason);
  const before = given || timetableValidate(inputs, result);
  const next = JSON.parse(JSON.stringify(result));
  let broken = 0;
  const move = (id, from, to) => {
    const item = next.layers[semester].lessons[id];
    if (item.frame) {
      // 두 학기 같은 자리에서 벗어난다: 다른 학기의 짝(같은 반·같은 칸·같은 교사)도 묶음 표시를 푼다
      const same = item.slots.slice().sort().join(",");
      for (const [other, otherLayer] of Object.entries(next.layers)) {
        if (other === semester) continue;
        const mate = Object.entries(otherLayer.lessons || {}).find(([key, value]) => value.frame && String(key.split("@")[1] || "").split("#")[0] === classId && value.teacherId === item.teacherId && value.slots.slice().sort().join(",") === same);
        if (mate) delete mate[1].frame;
      }
      broken += 1;
      delete item.frame;
    }
    item.slots = item.slots.map((key) => (key === from ? to : key));
    if (item.bareSlots) item.bareSlots = item.bareSlots.map((key) => (key === from ? to : key));
    for (const part of item.others || []) part.slots = part.slots.map((key) => (key === from ? to : key)); // 나눠 맡긴 수업: 그 칸을 맡은 교사가 함께 옮겨 간다
  };
  // 블록 한 시간을 옮긴다. 두 학기 같은 자리 묶음이면 다른 학기의 짝 블록(같은 반들·같은 칸)도 묶음 표시를 푼다.
  const moveBlock = (block, from, to) => {
    const item = next.layers[semester].blocks[block.id];
    if (item.frame) {
      const same = item.slots.slice().sort().join(",");
      for (const [other, otherLayer] of Object.entries(next.layers)) {
        if (other === semester || !inputs[other]) continue;
        const otherModel = inputs[other].gradeOf instanceof Map ? inputs[other] : timetableModel(inputs[other]);
        for (const mate of otherModel.blocks) {
          const value = otherLayer.blocks?.[mate.id];
          if (value && value.frame && mate.grade === block.grade && mate.classIds.join() === block.classIds.join() && value.slots.slice().sort().join(",") === same) { delete value.frame; break; }
        }
      }
      broken += 1;
      delete item.frame;
    }
    item.slots = item.slots.map((key) => (key === from ? to : key));
    if (item.bareSlots) item.bareSlots = item.bareSlots.map((key) => (key === from ? to : key));
  };
  if (blockMove) {
    for (const id of blockMove.riders) move(id, blockMove.to, blockMove.from);
    moveBlock(blockMove.block, blockMove.from, blockMove.to);
    if (blockMove.partner) moveBlock(blockMove.partner, blockMove.to, blockMove.from);
  } else {
    if (first.kind === "lesson") move(first.id, a, b);
    if (second.kind === "lesson") move(second.id, b, a);
  }
  const checked = timetableEditCheck(inputs, result, next, before);
  if (checked.reason) return refuse(checked.reason);
  next.metrics.frameBroken = (next.metrics.frameBroken || 0) + broken;
  if (blockMove) {
    const rooms = blockMove.block.classIds.length;
    return { ok: true, block: true, result: next, change: checked.change, text: blockMove.partner ? `${grade.grade}학년 ${blockMove.from} ${blockMove.block.label} ↔ ${blockMove.to} ${blockMove.partner.label}`
      : `${grade.grade}학년 ${blockMove.block.label} ${blockMove.from} → ${blockMove.to}(${rooms}개 반 함께${blockMove.riders.length ? `, 그 칸의 반 수업 ${blockMove.riders.length}개는 ${blockMove.from}으로` : ""})` };
  }
  return { ok: true, result: next, change: checked.change, text: `${classId}반 ${a} ${first.name} ↔ ${b} ${second.name}` };
}

// 칸 고정(순수): 고정한 칸이 결과에서 지켜지고 있는지. pins = { 학기: { 수업 id: ['월3', …] } }. 결과에 없는 수업·못 지켰다고 표시된 칸(pinMissed)은 따지지 않는다.
function timetablePinsHeld(result, pins, teacherPins) {
  for (const [semester, lessons] of Object.entries(pins || {})) for (const [id, keys] of Object.entries(lessons || {})) {
    const item = result?.layers?.[semester]?.lessons?.[id];
    if (!item) continue;
    for (const key of keys || []) if (!item.slots.includes(key) && !(item.pinMissed || []).includes(key)) return false;
  }
  // 고정한 담당 교사(teacherPins = { 학기: { 수업 id: 교사 id } })도 결과와 같아야 한다
  for (const [semester, lessons] of Object.entries(teacherPins || {})) for (const [id, teacherId] of Object.entries(lessons || {})) {
    const item = result?.layers?.[semester]?.lessons?.[id];
    if (item && teacherId && item.teacherId !== teacherId) return false;
  }
  return true;
}

// 그 학기 결과에서 교사가 서는 시간 수(반 수업 + 블록 분반 + 담임 창체, 교사 없이 놓은 시간 제외)
function timetableTeacherHours(layer, teacherId) {
  let hours = 0;
  const taught = (item) => (item.slots || []).filter(Boolean).length - (item.bareSlots || []).length;
  for (const item of Object.values(layer?.lessons || {})) {
    const shared = (item.others || []).reduce((sum, part) => sum + part.slots.length, 0); // 나눠 맡긴 수업: 다른 교사가 맡은 시간
    if (item.teacherId === teacherId) hours += taught(item) - shared;
    for (const part of item.others || []) if (part.teacherId === teacherId) hours += part.slots.length;
  }
  for (const item of Object.values(layer?.blocks || {})) hours += Object.values(item.teachers || {}).filter((id) => id === teacherId).length * taught(item);
  for (const item of layer?.creative || []) if (item.teacherId === teacherId && item.scope === "class") hours += (item.slots || []).filter(Boolean).length;
  return hours;
}

// 직접 고치기(순수): 반 수업 하나(그 반·그 과목의 모든 시간)의 담당 교사를 바꾼다. teacherId = 새 교사 id, "" = 담당 교사 없음.
// 새 교사는 그 수업의 후보(전공 일치)여야 하고, 그 수업의 모든 시간에 설 수 있어야 한다(겹침·불가 시간은 검증기가 보고 이유와 함께 거절), 필수 시수 상한도 넘지 않아야 한다.
// 두 학기 같은 자리 묶음 수업은 두 학기 함께 바꾼다(다른 학기에서 안 되면 거절). 6단계가 정한 교사·고정한 교사가 있는 수업은 검증기가 거절한다.
// 돌려주는 값: { ok: true, result, text } 또는 { ok: false, reason }.
function timetableEditTeacher(inputs, result, { semester, lessonId, teacherId, before: given }) {
  const refuse = (reason) => ({ ok: false, reason });
  const modelOf = (key) => (inputs?.[key] ? (inputs[key].gradeOf instanceof Map ? inputs[key] : timetableModel(inputs[key])) : null);
  const model = modelOf(semester);
  const item = result?.layers?.[semester]?.lessons?.[lessonId];
  const lesson = model?.lessons.find((entry) => entry.id === lessonId);
  if (!model || !item || !lesson) return refuse("이 학기의 계산 결과에 없는 수업입니다.");
  const wanted = teacherId ? String(teacherId) : null;
  const nameOf = (id) => (id ? model.teacherOf.get(id)?.name || id : "담당 교사 없음");
  if ((item.teacherId || null) === wanted && !(item.bareSlots || []).length && !(item.others || []).length) return refuse("지금 담당 교사와 같습니다.");
  if (lesson.fixedTeacher && wanted !== lesson.fixedTeacher) return refuse(lesson.teacherPinned ? `${lesson.classId}반 ${lesson.subject} 수업은 담당 교사를 고정해 두었습니다 — 교사 고정을 푼 뒤 바꾸세요.` : `${lesson.classId}반 ${lesson.subject} 수업은 담당 교사가 정해져 있습니다(${nameOf(lesson.fixedTeacher)} — 6단계·5단계에서 정한 교사).`);
  if (wanted && !lesson.candidates.includes(wanted)) return refuse(`${nameOf(wanted)} 교사는 ${lesson.subject}의 담당 후보(전공 일치)가 아닙니다.`);
  const before = given || timetableValidate(inputs, result);
  const next = JSON.parse(JSON.stringify(result));
  // 바꿀 수업: 이 학기의 그 수업 + 두 학기 묶음이면 다른 학기의 짝(같은 반·같은 칸·같은 교사)
  const targets = [[semester, lessonId, lesson]];
  if (item.frame) {
    const same = item.slots.slice().sort().join(",");
    for (const [other, otherLayer] of Object.entries(next.layers)) {
      if (other === semester) continue;
      const mate = Object.entries(otherLayer.lessons || {}).find(([key, value]) => value.frame && String(key.split("@")[1] || "").split("#")[0] === lesson.classId && value.teacherId === item.teacherId && value.slots.slice().sort().join(",") === same);
      const mateLesson = mate && modelOf(other)?.lessons.find((entry) => entry.id === mate[0]);
      if (mate && mateLesson) targets.push([other, mate[0], mateLesson]);
    }
  }
  for (const [key, id, entry] of targets) {
    const value = next.layers[key].lessons[id];
    if (wanted && !entry.candidates.includes(wanted)) return refuse(`${key}학기 ${entry.classId} ${entry.subject}: ${nameOf(wanted)} 교사는 담당 후보(전공 일치)가 아닙니다(두 학기 묶음 수업은 함께 바꿉니다).`);
    if (wanted) {
      const cap = model.teacherOf.get(wanted)?.maxHours;
      const now = timetableTeacherHours(next.layers[key], wanted);
      const already = timetableTeacherHours({ lessons: { [id]: value } }, wanted); // 이 수업에서 이미 맡고 있는 시간(나눠 맡긴 수업·교사 없이 놓은 시간이 있을 때)
      const more = entry.hours - already;
      if (Number.isFinite(cap) && now + more > cap) return refuse(`${nameOf(wanted)} 교사는 ${key}학기 주 ${now}시간 — ${more}시간을 더하면 필수 상한 ${cap}시간을 넘습니다.`);
    }
    value.teacherId = wanted;
    delete value.bareSlots; // 새 교사가 모든 시간에 선다(못 서는 시간이 있으면 검증기가 거절)
    delete value.others; // 나눠 맡긴 수업도 한 교사로`
    next.noTeacher = (next.noTeacher || []).filter((row) => !(String(row.semester) === key && row.kind === "lesson" && row.classId === entry.classId && row.subject === entry.subject && (lesson.part ? Number(row.hours) <= entry.hours : true)));
    if (!wanted) next.noTeacher.push({ semester: key, kind: "lesson", grade: entry.grade, classId: entry.classId, subject: entry.subject, hours: entry.hours, reason: "manual" });
  }
  const checked = timetableEditCheck(inputs, result, next, before);
  if (checked.reason) return refuse(checked.reason);
  next.metrics.noTeacherHours = next.noTeacher.reduce((sum, row) => sum + (Number(row.hours) || 0), 0);
  return { ok: true, teacher: true, result: next, change: checked.change, semesters: targets.map(([key]) => key), text: `${lesson.classId}반 ${lesson.subject} 담당 교사 ${nameOf(item.teacherId)} → ${nameOf(wanted)}${targets.length > 1 ? "(두 학기 함께)" : ""}` };
}

// 그 반 그 칸에 놓인 반 수업의 id(없으면 ""). 블록·창체·빈칸은 ""
function timetableLessonAt(layer, classId, key) {
  return Object.keys(layer?.lessons || {}).find((id) => String(id.split("@")[1] || "").split("#")[0] === classId && (layer.lessons[id].slots || []).includes(key)) || "";
}

// 낱장 인쇄(순수): 반 시간표·교사 시간표를 한 장에 perPage개씩. tables = timetableResultTables 결과, kind = "class" | "teacher", only = 그 반/교사만(없으면 전체).
// 돌려주는 값: { html, cards, pages } — html은 #printBatch에 넣는 .print-page 묶음.
function timetablePrintHtml(tables, kind, options = {}) {
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const perPage = Math.max(1, Math.min(4, Number(options.perPage) || 2));
  const list = (kind === "teacher" ? tables.teachers : tables.classes).filter((row) => !options.only || row.id === options.only);
  const head = `<thead><tr><th></th>${tables.days.map((day) => `<th>${esc(day)}</th>`).join("")}</tr></thead>`;
  const cell = (entries, sub) => (entries || []).map((entry) => `<strong>${esc(entry.text)}</strong>${sub(entry) ? `<small>${esc(sub(entry))}</small>` : ""}`).join("<hr>");
  const cards = list.map((row) => {
    const body = kind === "teacher"
      ? tables.teacherRows.map((slot) => `<tr><th>${esc(slot.label)}</th>${tables.days.map((day, d) => `<td>${cell(row.cells[`${d}|${slot.pos}`], (entry) => entry.where)}</td>`).join("")}</tr>`).join("")
      : row.rows.map((slot) => (slot.lunch ? `<tr class="tt-print-lunch"><th>점심</th><td colspan="${tables.days.length}"></td></tr>`
        : `<tr><th>${slot.period}</th>${tables.days.map((day) => `<td>${cell(row.cells[`${day}${slot.period}`], (entry) => (entry.noTeacher ? "담당 교사 없음" : entry.teacher))}</td>`).join("")}</tr>`)).join("");
    const name = kind === "teacher" ? `${row.name} 선생님 시간표` : `${row.id}반 시간표`;
    return `<section class="tt-print-card" data-kind="${kind}" data-id="${esc(row.id)}"><h3>${esc(options.title || "")} ${esc(name)}${kind === "teacher" ? ` <small>주 ${row.hours}시간</small>` : ""}</h3><table class="tt-print-table">${head}<tbody>${body}</tbody></table></section>`;
  });
  const pages = [];
  for (let at = 0; at < cards.length; at += perPage) pages.push(`<div class="print-page tt-print-page" data-per="${perPage}">${cards.slice(at, at + perPage).join("")}</div>`);
  return { html: pages.join(""), cards: cards.length, pages: pages.length };
}

// 저장된 시간표 조건(없으면 빈 객체). 여기서는 읽기만 한다.
function timetableSettings() {
  const store = typeof state !== "undefined" && state && state.timetable && typeof state.timetable === "object" ? state.timetable : null;
  return store && store.settings && typeof store.settings === "object" ? store.settings : {};
}

var TIMETABLE_STAGGER_SMALL = 10; // 반군 엇갈림 견적에서 '소인수 분반'으로 세는 기준(이 인원 미만 — 막지 않고 수로만 보여 준다)
var TIMETABLE_CREATIVE_FROM = 5; // 시간을 정하지 않은 창체(학년별·반군별·전교 동시)는 기본 5교시 이후에만 놓는다(낮 시간에 창체가 끼지 않게)
var TIMETABLE_DEFAULT_LUNCH = { 1: 4, 2: 4, 3: 3 }; // 사용자 학교: 3학년은 3교시 뒤, 1·2학년은 4교시 뒤
// 한 주에 블록을 놓을 수 있는 칸 수(사전 점검 P5의 '주 n칸'과 같은 규칙): 요일별 교시 합 − 전 교사가 묶이는 칸(전교 고정 시간·전교 동시 창체 시간).
// 6단계 '전 학년 함께 다시 계산'이 학년 간 겹치는 블록 쌍이 필요한지 볼 때 읽는다.
function timetableWeekCells() {
  const cs = classSectionsSettings();
  const tt = timetableSettings();
  const days = String(cs.gridDays || "").split(/[,\s]+/).filter(Boolean);
  const periodsOf = (day) => Math.min(12, Number(tt.periodsByDay?.[day]) > 0 ? Math.floor(Number(tt.periodsByDay[day])) : Number(cs.gridPeriods) || 7);
  const creativeSlots = (cs.fixedSlots || []).filter((slot) => TIMETABLE_CREATIVE_LABEL.test(String(slot.label || "")));
  const busy = new Set();
  const add = (times) => { for (const time of timetableTimes(times)) if (days.includes(time.day) && time.period >= 1 && time.period <= periodsOf(time.day)) busy.add(`${time.day}${time.period}`); };
  for (const slot of cs.fixedSlots || []) if (!creativeSlots.includes(slot) && slot.allTeachers !== false) add(slot.times);
  if (tt.creative && typeof tt.creative === "object") add(tt.creative.schoolTimes || []);
  else for (const slot of creativeSlots) add(slot.times);
  return days.reduce((sum, day) => sum + periodsOf(day), 0) - busy.size;
}

// 지금 쓰는 학년별 점심(몇 교시 뒤). 6단계가 학년을 적은 교사 불가 시간('월4(3학년)')이 어느 학년 블록에 걸리는지 볼 때도 읽는다.
function timetableLunchSetting() {
  return { ...TIMETABLE_DEFAULT_LUNCH, ...(timetableSettings().lunchAfter || {}) };
}
var TIMETABLE_CREATIVE_LABEL = /창체|창의적|동아리|자율|진로/;

// 반 일부만 듣는 학교 지정 과목(교차집중·분할 편성)의 반: 같은 학년·학기 안에서 앞 반부터 차례로(가정).
function timetableRollingClasses(count, total, cursor) {
  const list = [];
  for (let index = 0; index < Math.min(count, total); index += 1) list.push(String(((cursor.at + index) % total) + 1));
  cursor.at = (cursor.at + count) % Math.max(1, total);
  return list;
}

// timetableInput(차수, 학기) → { input(timetableModel 입력), assumptions: [{ key, text, where }], year, round, semester }
// assumptions = 자료가 없어 기본값·어림으로 채운 것(화면의 '가정' 표시). 계산을 막아야 하는 누락은 input.missing(level block).
function timetableInput(round = typeof courseOpeningRound === "function" ? courseOpeningRound() : String(state.currentRound || "1"), semester = "1") {
  const year = typeof hoursTargetYear === "function" ? hoursTargetYear() : "";
  const compute = () => timetableInputCompute(String(round), String(semester), year);
  return typeof cachedByStateRevision === "function" ? cachedByStateRevision("timetableInput", `${round}|${semester}|${year}`, compute) : compute();
}

// settingsOverride: 저장하지 않고 '이 조건이면'을 미리 볼 때 쓰는 시간표 조건(선택지의 예상 효과).
function timetableInputCompute(round, semester, year, settingsOverride = null) {
  const assumptions = [];
  const missing = [];
  const notes = { undecided: [], staleSections: [], expandedClasses: false };
  const assume = (key, text, whereKey, target = "") => assumptions.push({ key, text, where: timetableWhere(whereKey, target) });
  const lack = (level, cause, whereKey, target = "") => { if (!missing.some((item) => item.cause === cause)) missing.push({ level, cause, where: [timetableWhere(whereKey, target)] }); };
  const tt = settingsOverride || timetableSettings();
  const cs = classSectionsSettings();

  let stats = null;
  try { stats = typeof hoursStatsCached === "function" ? hoursStatsCached(year) : computeHoursStats(year); } catch (error) { lack("block", error?.message || "5단계 시수 통계를 계산할 수 없습니다.", "hours"); }
  const classCounts = stats?.classCounts || {};
  const grades = ["1", "2", "3"].map((grade) => ({ grade, classes: Number(classCounts[grade]) || 0 }));
  for (const item of grades) if (!item.classes) lack("block", `${item.grade}학년 내년 학급 수가 없습니다.`, "aggregate", "내년 학급 수");

  // ---- 시간 구조 ----
  if (!tt.periodsByDay) assume("periods", `요일별 교시 수: ${cs.gridDays} 모두 ${cs.gridPeriods}교시(6단계 격자)로 계산`, "time", "요일별 교시 수");
  if (!tt.lunchAfter) assume("lunch", "점심: 3학년은 3교시 뒤, 1·2학년은 4교시 뒤로 계산", "time", "학년별 점심");
  const creativeTotal = Number(stats?.creativeHours) || 0;
  const creativeSlots = cs.fixedSlots.filter((slot) => TIMETABLE_CREATIVE_LABEL.test(String(slot.label || "")));
  const fixedSlots = cs.fixedSlots.filter((slot) => !creativeSlots.includes(slot)).map((slot) => ({ label: slot.label, times: slot.times, allTeachers: slot.allTeachers !== false }));
  let creative;
  if (tt.creative && typeof tt.creative === "object") {
    creative = { school: Number(tt.creative.school) || 0, schoolTimes: tt.creative.schoolTimes || [], grade: tt.creative.grade ?? 0, gradeTimes: tt.creative.gradeTimes || {}, byGroup: Boolean(tt.creative.byGroup) };
  } else if (creativeSlots.length) {
    const times = creativeSlots.flatMap((slot) => timetableTimes(slot.times)).map((time) => `${time.day}${time.period}`);
    creative = { school: times.length, schoolTimes: times, grade: Math.max(0, creativeTotal - times.length), gradeTimes: {}, byGroup: false };
    assume("creative", `창체 ${creativeTotal}시간: 6단계 고정 시간 '${creativeSlots.map((slot) => slot.label).join(", ")}'(${times.join(",")})을 전교 동시로 계산${creative.grade ? ` + 학년별 ${creative.grade}시간` : ""}`, "time", "창체");
  } else {
    const school = Math.min(1, creativeTotal);
    creative = { school, schoolTimes: [], grade: creativeTotal - school, gradeTimes: {}, byGroup: false };
    if (creativeTotal) assume("creative", `창체 ${creativeTotal}시간: 전교 동시 ${school}시간(동아리) + 학년별 ${creativeTotal - school}시간으로 나누고 시간은 정하지 않음`, "time", "창체");
  }
  creative.expected = Object.fromEntries(grades.map((item) => [item.grade, creativeTotal]));
  creative.fromPeriod = Number(tt.creativeFrom) >= 1 ? Math.floor(Number(tt.creativeFrom)) : TIMETABLE_CREATIVE_FROM; // 시간이 정해지지 않은 창체를 놓을 수 있는 첫 교시

  // ---- 교사 ----
  const departmentName = (id) => (typeof hoursDepartmentName === "function" ? hoursDepartmentName(id) : id);
  const rawOf = new Map(cs.teachers.filter(Boolean).map((teacher) => [String(teacher.id), teacher]));
  // 담임: 6단계 교사 명단의 '담임'(내년 학년-반 '2-3') 한 곳. 그 학년·반이 없으면 쓰지 않는다.
  const homeroomValue = (value) => {
    const match = String(value || "").match(/^([1-3])-(\d{1,2})$/);
    return match && Number(match[2]) >= 1 && Number(match[2]) <= (Number(classCounts[match[1]]) || 0) ? `${match[1]}-${Number(match[2])}` : "";
  };
  let teachers = classSectionsTeacherList(cs).map((teacher) => {
    const raw = rawOf.get(teacher.id) || {};
    return { id: teacher.id, name: teacher.name, departments: teacher.departments, courses: teacher.courses,
      unavailable: teacher.unavailable.map((slot) => ({ day: slot.day, period: slot.period, ...(slot.grades ? { grades: slot.grades } : {}) })), maxHours: Number(raw.maxHours) > 0 ? Number(raw.maxHours) : undefined,
      days: Array.isArray(raw.days) && raw.days.length ? raw.days : undefined, homeroom: homeroomValue(raw.homeroom),
      placeholder: Boolean(teacher.assumed) || (typeof classSectionsTeacherPlaceholder === "function" && classSectionsTeacherPlaceholder(raw, departmentName)), ...(teacher.assumed ? { assumed: true } : {}) };
  });
  const timetableCounts = typeof hoursTimetableTeacherCounts === "function" ? hoursTimetableTeacherCounts(year) : { counts: stats?.settings?.teachers || {}, assumed: (stats?.assumedTeachers || []).map((item) => item.id) };
  if (!teachers.length) {
    const counts = timetableCounts.counts;
    for (const [department, value] of Object.entries(counts)) {
      for (let n = 1; n <= Math.floor(Number(value) || 0); n += 1) teachers.push({ id: `t-${department}-${n}`, name: `${departmentName(department)} ${n}`, departments: [department], courses: [], unavailable: [], homeroom: "", placeholder: true });
    }
    if (teachers.length) assume("teachers", `교사 명단 없음 → 5단계 교과별 교사 수(${teachers.length}명)로 자리 교사를 만들어 계산(불가 시간·출근 요일 모름)`, "teachers", "교사 명단");
  }
  const homeroomCount = teachers.filter((teacher) => teacher.homeroom).length;
  if (!homeroomCount) assume("homeroom", "담임 명단 없음 → 담임 규칙(담임반 배정, 학년별 창체 시간 담임 비움)은 쓰지 않음", "teachers", "담임");
  else {
    const taken = new Set(teachers.map((teacher) => teacher.homeroom).filter(Boolean));
    const open = grades.flatMap((item) => Array.from({ length: item.classes }, (_, index) => `${item.grade}-${index + 1}`)).filter((room) => !taken.has(room));
    if (open.length) notes.homerooms = [`담임이 정해지지 않은 반 ${open.length}개(${open.slice(0, 6).join(", ")}${open.length > 6 ? " …" : ""}) — 그 반은 담임 규칙을 적용하지 않습니다.`];
  }
  // 5단계 교과별 교사 수와 6단계 명단이 다르면 알림만(시간표는 명단으로 계산)
  if (teachers.length && !teachers.every((teacher) => teacher.placeholder) && stats?.settings?.teachers) {
    const listed = {};
    for (const teacher of teachers) if (!teacher.assumed) for (const department of teacher.departments) listed[department] = (listed[department] || 0) + 1;
    const differ = [...new Set([...Object.keys(listed), ...Object.keys(stats.settings.teachers)])]
      .map((department) => [department, Math.floor(Number(stats.settings.teachers[department]) || 0), listed[department] || 0]).filter(([, planned, actual]) => planned !== actual);
    if (differ.length) notes.teacherCounts = [`5단계 교사 수와 6단계 교사 명단이 다른 교과: ${differ.map(([department, planned, actual]) => `${departmentName(department)} ${planned} → ${actual}명`).join(", ")} — 시간표는 6단계 명단으로 계산합니다.`];
  }
  // 전공 일치(절대): 교사 후보 = 6단계 명단의 담당 교과가 그 과목의 담당 교과이거나, 담당 과목에 그 과목이 있는 교사만.
  // 공통 교과(과학-공통·사회-공통)에 따로 정한 교사가 없으면 그 교과군 세부 교과 교사 모두(5단계 배분대로 맡는 운영).
  // 다른 교과 교사가 맡는 것은 교양 과목만(5단계 '담당 교과' 지정으로 정한다).
  const courseKey = (name) => (typeof normalizeResultCourseName === "function" ? normalizeResultCourseName(name) : String(name ?? "").replace(/\s+/g, ""));
  const coursesOf = new Map(teachers.map((teacher) => [teacher.id, new Set(teacher.courses.map(courseKey))]));
  const openDepartments = new Set(Array.isArray(tt.openDepartments) ? tt.openDepartments : ["교양"]);
  const commonFallback = new Set();
  const commonGroup = (department) => {
    const match = String(department || "").match(/^(.+)-공통$/);
    return match && !teachers.some((teacher) => teacher.departments.includes(department)) ? match[1] : "";
  };
  const qualified = (teacher, department, subject) => {
    if (teacher.departments.includes(department) || coursesOf.get(teacher.id)?.has(courseKey(subject))) return true;
    const group = commonGroup(department);
    return Boolean(group) && teacher.departments.some((own) => own.startsWith(`${group}-`));
  };
  const candidateIds = (department, subject = "") => {
    if (commonGroup(department)) commonFallback.add(commonGroup(department));
    return teachers.filter((teacher) => qualified(teacher, department, subject)).map((teacher) => teacher.id);
  };
  // 교사 0명인데 수업이 있는 교과(5단계 assumedTeachers, 교양·공통 제외): 그 교과 과목을 맡을 교사가 명단에 없을 때만 자리 교사 1명을 둔다(사용자 결정).
  // 자리 이름은 6단계 '5단계 교사 수로 명단 만들기'와 같은 t-교과-1 — 전공은 그 교과뿐이다.
  for (const department of timetableCounts.assumed) {
    const id = `t-${department}-1`;
    if (teachers.some((teacher) => teacher.id === id)) {
      assume(`assumed:${department}`, `${departmentName(department)}: 교사 0명 → 1명 배치로 계산(5단계 교사 수에 넣으면 사라짐)`, "hours", "교사 수");
      continue;
    }
    const subjectsOf = [...new Set((stats?.items || []).filter((item) => item.department === department && Number(item.hours) > 0).map((item) => item.subject))];
    if (!subjectsOf.some((subject) => !teachers.some((teacher) => qualified(teacher, department, subject)))) continue;
    teachers.push({ id, name: `${departmentName(department)} 1`, departments: [department], courses: [], unavailable: [], homeroom: "", placeholder: true });
    coursesOf.set(id, new Set());
    assume(`assumed:${department}`, `${departmentName(department)}: 교사 0명 → 1명 배치로 계산(5단계 교사 수에 넣으면 사라짐, 6단계 '5단계 교사 수로 명단 만들기'를 누르면 명단에도 생깁니다)`, "hours", "교사 수");
  }
  const teacherById = new Map(teachers.map((teacher) => [teacher.id, teacher]));
  const mismatchOf = (teacherId, department, subject) => {
    const teacher = teacherById.get(String(teacherId));
    return Boolean(teacher) && !openDepartments.has(department) && !qualified(teacher, department, subject);
  };

  // 장소: 체육 교과 수업은 체육 장소 수를 넣었을 때만 장소 겹침을 점검한다.
  const venueOf = (department) => (department === "체육" && Number(tt.venues?.체육) > 0 ? "체육" : "");

  // ---- 반 수업(학교 지정 과목 등) ----
  const lessons = [];
  const selectHours = {}; // 5단계 선택과목 시수(6단계 분반 시수와 대조)
  const cursors = {};
  // 반 일부만 듣는 지정 과목(교차집중·분할 편성)의 반: 시간표 조건에서 받은 값, 없으면 앞 반부터 차례로(가정)
  const splits = timetableSplitGroups(stats?.items).map((group) => {
    const plan = timetableSplitPlan(group, Number(classCounts[group.grade]) || 0, tt.splitClasses?.[group.key]);
    for (const text of plan.errors) lack("warn", `${group.label} 반 배정: ${text} 앞 반부터 차례로 계산했습니다.`, "time", "반 일부만 듣는 과목");
    return { ...group, ...plan };
  });
  const splitOf = new Map(splits.flatMap((group) => group.members.map((member) => [`${group.grade}|${member.subject}`, group])));
  const lessonFor = (grade, subject, department, hours, count, extra = {}) => {
    const total = Number(classCounts[grade]) || 0;
    if (!total || !(count > 0) || !(hours > 0)) return;
    let classes;
    const split = splitOf.get(`${grade}|${subject}`);
    if (split && split.classes[semester]?.[subject]) {
      classes = split.classes[semester][subject];
      if (split.source === "default") extra.partial = true;
    } else if (count < total) {
      cursors[grade] ||= { at: 0 };
      classes = timetableRollingClasses(count, total, cursors[grade]);
      extra.partial = true;
    }
    const { partial, byClass, ...rest } = extra;
    if (!rest.venue && venueOf(department)) rest.venue = venueOf(department);
    if (partial && !assumptions.some((item) => item.key === `partial:${grade}`)) {
      assume(`partial:${grade}`, `${grade}학년: 반 일부만 듣는 학교 지정 과목(교차집중·분할 편성)은 앞 반부터 차례로 맡긴 것으로 계산(실제 반 배정과 다를 수 있음)`, "time", "반 일부만 듣는 과목");
    }
    if (byClass) {
      for (const classNo of classes || Array.from({ length: total }, (_, index) => String(index + 1))) {
        const share = byClass[classNo];
        if (!share) { lessons.push({ id: `${grade}|${subject}|${classNo}`, grade, classes: [classNo], subject, department, hours, teacherIds: candidateIds(department, subject), ...rest }); continue; }
        const parts = Object.entries(share).filter(([, value]) => Number(value) > 0).map(([id, value]) => ({ department: id, hours: Number(value), teacherIds: candidateIds(id, subject) }));
        lessons.push({ id: `${grade}|${subject}|${classNo}`, grade, classes: [classNo], subject, department, hours, parts, ...rest });
      }
      return;
    }
    lessons.push({ id: `${grade}|${subject}`, grade, classes, subject, department, hours, teacherIds: candidateIds(department, subject), ...rest });
  };
  const commonOf = {};
  const commonFor = (grade) => {
    if (!(grade in commonOf)) {
      try { commonOf[grade] = typeof hoursCommonClassAssignment === "function" ? hoursCommonClassAssignment(grade, semester, year) : {}; } catch { commonOf[grade] = {}; }
      if (commonOf[grade].matchesSaved === false && Object.keys(commonOf[grade]).length && !assumptions.some((item) => item.key === "common")) {
        assume("common", "공통 과목(통합과학·통합사회 등) 반별 담당은 5단계 자동 배분 값으로 계산(시수표 배분 칸을 직접 고친 값과 다름)", "hours", "공통 시수 배분");
      }
    }
    return commonOf[grade];
  };
  const gradesWithItems = new Set();
  for (const item of stats?.items || []) {
    gradesWithItems.add(item.grade);
    if (String(item.semester) !== semester) continue;
    if (item.expanded) notes.expandedClasses = true;
    if (/학기 미정/.test(item.basis || "")) notes.undecided.push(`${item.grade}학년 ${item.subject}`);
    const selective = item.kind !== "지정" && item.grade !== "1";
    if (selective && !item.missingStage4) { selectHours[item.grade] = (selectHours[item.grade] || 0) + (Number(item.hours) || 0); continue; } // 6단계 분반에서
    const count = item.designated ? Number(item.autoClasses) || 0 : Number(item.classes) || 0;
    if (!count) continue;
    if (!item.designated) assume(`manual:${item.key}`, `${item.grade}학년 ${item.subject}: 5단계 직접 입력 ${count}반을 앞 반부터 반 수업으로 계산`, "hours", item.subject);
    lessonFor(item.grade, item.subject, item.department, Number(item.credit) || 0, count, { byClass: commonFor(item.grade)[item.subject] });
  }
  // 신입생(내년 1학년) 편제표가 없으면 올해 1학년 편제표의 1학년 과목으로(가정)
  const fallbackGrades = new Set();
  if (stats && !gradesWithItems.has("1") && Number(classCounts["1"]) > 0 && typeof curriculumCohortLayout === "function" && typeof curriculumPlanEntries === "function") {
    const cohortYear = String(Number(year) - 1);
    const layout = curriculumCohortLayout(cohortYear);
    if (layout) {
      const separate = layout.planData && typeof curriculumSeparateApplicationRows === "function" ? curriculumSeparateApplicationRows(layout.planData) : null;
      const entries = curriculumPlanEntries(layout).entries.filter((entry) => entry.grade === "1" && String(entry.semester) === semester && entry.kind === "지정" && !separate?.has(entry.rowIndex));
      const seen = new Set();
      for (const entry of entries) {
        if (seen.has(entry.subject)) continue;
        seen.add(entry.subject);
        const total = Number(classCounts["1"]);
        const count = typeof hoursDesignatedShare === "function" ? hoursDesignatedShare(total, entry) : total;
        lessonFor("1", entry.subject, typeof hoursDefaultDepartment === "function" ? hoursDefaultDepartment(entry.subject, entry.area) : entry.area, Number(entry.credit) || 0, count);
      }
      if (entries.length) {
        fallbackGrades.add("1");
        assume("plan1", `1학년: ${year}학년도 입학생 편제표가 없어 ${cohortYear}학년도 입학생 편제표의 1학년 과목으로 계산(공통 과목 반별 담당은 교과군 교사 모두를 후보로)`, "plan", `${year}학년도 입학생 편제표`);
      }
    }
  }
  for (const issue of stats?.issues || []) {
    if (issue.level !== "error") continue;
    if (fallbackGrades.has("1") && /^1학년: .*편제표가 없습니다/.test(issue.text)) continue;
    const action = String(issue.action || "");
    lack("block", issue.text, action.startsWith("cohort:") ? "plan" : action === "results" ? "aggregate" : "hours");
  }

  // ---- 6단계: 이동수업 블록과 학급 단위 과목 ----
  const blocks = [];
  const sectionHours = {};
  const source = typeof classSectionsSource === "function" ? classSectionsSource(round) : { groups: [] };
  for (const group of source.groups.filter((item) => String(item.semester) === semester)) {
    const grade = String(group.targetGrade);
    const entry = classSectionsEntry(round, group.key, false);
    const modes = classSectionsCourseModes(cs, group);
    const departments = classSectionsCourseConf(cs, "courseDepartments", group.grade);
    const rooms = classSectionsCourseConf(cs, "courseRooms", group.grade);
    const courseOf = new Map(group.courses.map((course) => [course.key, course]));
    const countOf = (course) => (entry?.classCounts?.[course.key] !== undefined ? Number(entry.classCounts[course.key]) || 0 : Number(course.classCount) || 0);
    const unitCourses = group.courses.filter((course) => modes[course.key] === "class" && !course.closed && countOf(course) > 0);
    if (unitCourses.length) {
      // 학급 단위 과목: 반 → 과목(6단계 배정)을 반 수업으로
      const plan = classSectionsClassUnitPlan(group, entry || { classCounts: {}, classUnit: {} }, cs);
      if (!plan.mapped) assume(`classUnit:${group.key}`, `${group.label}: 내년 반 배정표가 없어 학급 단위 과목의 반 배정은 6단계 자동 배정(학생 희망 미반영)으로 계산`, "sections", "내년 반 배정표");
      for (const [room, key] of Object.entries(plan.assign || {})) {
        const course = courseOf.get(key);
        if (!course) continue;
        const department = departments[key] || course.department;
        const hours = Number(course.credits) || Number(course.planCredits) || 0;
        lessons.push({ id: `${group.key}|${key}|${room}`, grade, classes: [room], subject: course.name, department, hours, teacherIds: candidateIds(department, course.name), venue: rooms[key] || venueOf(department) });
        sectionHours[grade] = (sectionHours[grade] || 0) + hours;
      }
    }
    if (typeof classSectionsClassUnitOnly === "function" && classSectionsClassUnitOnly(group, entry, cs)) continue;
    if (unitCourses.length) lack("warn", `${group.label}: 일부 과목만 학급 단위입니다 — 학급 단위 반이 빠지는 블록을 아직 구분하지 못해 그 반의 주간 수업 수가 실제보다 많게 잡힐 수 있습니다.`, "sections", "학급 단위 과목");
    const result = entry?.sectionResult;
    if (!result?.sections?.length || !result?.blocks?.length) { lack("block", `${group.label}: 분반 편성 결과가 없습니다.`, "sections", group.label); continue; }
    try {
      if (typeof classSectionsSignature === "function" && result.signature !== classSectionsSignature(classSectionsBuildInput(round, group, entry))) notes.staleSections.push(group.label);
    } catch { /* 서명을 못 만들면 넘어간다 */ }
    const sectionOf = new Map(result.sections.map((section) => [section.id, section]));
    for (const block of result.blocks) {
      const letter = block.letter || block.id;
      const sections = [];
      for (const id of block.sectionIds || result.sections.filter((section) => section.blockId === block.id).map((section) => section.id)) {
        const section = sectionOf.get(id);
        const course = section && courseOf.get(section.courseKey);
        if (!section || !course) continue;
        const department = departments[section.courseKey] || course.department;
        const credits = Number(course.credits) || Number(course.planCredits) || 0;
        const teacherId = section.teacherId || result.teacherOf?.[id] || "";
        sections.push({ id: `${group.key}|${id}`, subject: course.name, department, credits, teacherId: teacherId || undefined, teacherIds: teacherId ? undefined : candidateIds(department, course.name), teacherMismatch: teacherId && mismatchOf(teacherId, department, course.name) ? true : undefined,
          venue: rooms[section.courseKey] || venueOf(department) });
        sectionHours[grade] = (sectionHours[grade] || 0) + credits;
      }
      if (!sections.length) continue;
      // 블록 시간: 기본은 시간표가 정한다(비워서 넘김 — 6단계 블록 시간은 공강을 모르고 정한 값이라 그대로 쓰면 공강이 생기기 쉽다).
      // '6단계 블록 시간 그대로'를 켰을 때만 지금 6단계 입력 칸(없으면 결과)을 고정 시간으로 넘긴다.
      const times = !tt.keepBlockTimes ? "" : entry.blockTimes?.[letter] !== undefined ? entry.blockTimes[letter] : (block.times || []);
      blocks.push({ id: `${group.key}|${letter}`, grade, label: `${group.category} ${letter}블록`, times: typeof times === "string" ? times.replace(/\//g, ",") : times, sections });
    }
  }
  for (const grade of Object.keys({ ...selectHours, ...sectionHours })) {
    const planned = selectHours[grade] || 0;
    const made = sectionHours[grade] || 0;
    if (planned !== made) lack("warn", `${grade}학년 ${semester}학기 선택과목: 5단계 시수 ${planned}시간 ≠ 6단계 분반 ${made}시간(분반 수·학점·학급 단위 과목을 확인하세요).`, "sections", "분반 수");
  }
  if (commonFallback.size) assume("commonTeachers", `${[...commonFallback].join("·")} 공통 과목에 따로 정한 교사가 없어 세부 교과 교사 모두를 후보로 계산`, "teachers", "담당 과목");
  notes.undecided = [...new Set(notes.undecided)];

  // '2시간 연속 수업 허용' 과목: 같은 교사가 그 반에 하루 2시간이어도 이어져 있으면 '하루 한 번' 위반이 아니다(3시간 이상·떨어진 2시간은 위반)
  const doubles = new Set((Array.isArray(tt.doubleSubjects) ? tt.doubleSubjects : []).map(courseKey));
  if (doubles.size) for (const lesson of lessons) if (doubles.has(courseKey(lesson.subject))) lesson.double = true;
  const venues = Object.fromEntries(Object.entries({ ...(cs.rooms || {}), ...(tt.venues || {}) }).map(([key, value]) => [key, Number(value) || 0]));
  const plainOf = (value) => JSON.parse(JSON.stringify(value, typeof stateJsonReplacer === "function" ? stateJsonReplacer : undefined));
  const pinnedSlots = tt.pins?.[semester] && Object.keys(tt.pins[semester]).length ? plainOf(tt.pins[semester]) : null;
  const pinnedTeachers = tt.teacherPins?.[semester] && Object.keys(tt.teacherPins[semester]).length ? plainOf(tt.teacherPins[semester]) : null; // 고정한 담당 교사 { 수업 id: 교사 id }
  const pinned = pinnedSlots || pinnedTeachers ? { ...(pinnedSlots ? { lessons: pinnedSlots } : {}), ...(pinnedTeachers ? { teachers: pinnedTeachers } : {}) } : null;
  const input = {
    ...(pinned ? { pins: pinned } : {}), // 교사가 고정한 반 수업 칸(없으면 넣지 않는다 — 입력 서명이 그대로)
    semester, days: cs.gridDays, periods: Number(cs.gridPeriods) || 7, periodsByDay: tt.periodsByDay || {}, lunchAfter: tt.lunchAfter || TIMETABLE_DEFAULT_LUNCH,
    // 담임 규칙: 직접 고르지 않았으면 담임 명단이 있을 때 '최대한', 없으면 끔
    grades, creative, fixedSlots, teachers, lessons, blocks, venues, rules: { ...(tt.rules || {}), homeroom: tt.rules?.homeroom ?? (homeroomCount ? "soft" : "off") }, missing, notes
  };
  return { input, assumptions, year, round, semester, creativeTotal, homeroomCount, openDepartments: [...openDepartments],
    splits: splits.map((group) => ({ key: group.key, label: group.label, grade: group.grade, crossed: group.crossed, base: group.base, source: group.source, errors: group.errors,
      members: group.members.map((member) => ({ subject: member.subject, count: member.counts[group.base], classes: group.classes[group.base]?.[member.subject] || [], here: group.classes[semester]?.[member.subject] || [] })) })) };
}

// 지금 자료로 사전 점검: timetablePrecheck 결과 + 가정 목록.
function timetablePrecheckFor(round, semester = "1") {
  const prepared = timetableInput(round, semester);
  return { ...timetablePrecheck(prepared.input), assumptions: prepared.assumptions, year: prepared.year, round: prepared.round, semester: prepared.semester };
}

// ---- 화면: 조건 설정 + 사전 점검 결과 + 시간표 계산·결과 ----
// 메뉴 '7. 시간표' = 내부 단계 6. 그리기 입구는 renderTimetable 하나(보이지 않으면 미루고, 다시 그릴 때 스크롤·포커스를 지킨다).
var TIMETABLE_VIEW = { semester: "1", open: { time: true }, prepared: null, result: null, change: "", before: null, changeInfo: null, status: "", statusError: false, runStatus: "", runError: false, grid: "class", pick: { class: "", teacher: "" }, editPick: "", editTargets: null, editStatus: "", editError: false, undo: [] }
var TIMETABLE_RUN = null; // 계산 중: { round, signature, workers, plans, progress, results, startedAt, timer, stopping }
var TIMETABLE_SOLVE_SECONDS = 180; // 기본 계산 시간 상한(초). 넘으면 그때까지 가장 좋은 답을 쓴다. settings.solveSeconds로 바꿈.
var TIMETABLE_VIOLATION_LABELS = { gap: "공강", oncePerDay: "하루 두 번", run: "연강", maxPerDay: "하루 최대", lunch: "점심", lunchSide: "점심 앞뒤", sameSubjectDay: "같은 날 같은 과목", homeroom: "담임", frame: "두 학기 뼈대", shortDay: "하루 최소 교시" };
var TIMETABLE_NO_TEACHER_REASONS = { manual: "직접 비움", none: "맡을 수 있는 교사가 명단에 없음", capacity: "맡을 수 있는 교사의 시간이 모자람", clash: "맡을 교사가 그 시간에 다른 수업", released: "공강·하루 두 번을 없애려고 비움('공강 먼저')" };
// 계산 뒤 남은 '반드시' 위반 → 고를 수 있는 선택지(양보가 작은 것부터). 고르면 조건이 바뀌고 바로 다시 계산한다.
var TIMETABLE_RESULT_CHOICES = { gap: ["releaseTeacher", "blockTimes", "creativeFree", "creativeGroup", "gaps"], oncePerDay: ["releaseTeacher", "oncePerDay"], run: ["teacherRules", "frameOrder"], maxPerDay: ["teacherRules"], lunch: ["frameOrder"] };;
var TIMETABLE_LEVELS = [["hard", "반드시"], ["soft", "최대한"], ["off", "끔"]];
var TIMETABLE_RULE_FIELDS = [
  { key: "maxHours", label: "교사 주당 시수 참고 상한(넘어도 편성 · 알림만)", min: 1, max: 40, unit: "시간" },
  { key: "departmentMax.진로", label: "진로 교사 주당 시수 상한", min: 1, max: 40, unit: "시간(반드시)" },
  { key: "run", label: "교사 연강 상한", min: 1, max: 8, unit: "시간 연속" },
  { key: "maxPerDay", label: "교사 하루 최대 수업", min: 1, max: 9, unit: "시간" },
  { key: "gap", label: "반 공강 금지(하루 안 빈칸은 뒤쪽만)", level: true },
  { key: "oncePerDay", label: "같은 교사가 같은 반에 하루 한 번만(과목이 달라도)", level: true },
  { key: "lunch", label: "교사 점심(학년별 점심 칸 가운데 하나는 비움)", level: true },
  { key: "lunchSide", label: "교사 점심 앞뒤 한 시간씩 공강", level: true, later: true },
  { key: "sameSubjectDay", label: "교사 같은 날 같은 과목 줄이기", level: true, later: true },
  { key: "homeroom", label: "담임이 그 학년 반 수업을 맡으면 담임반 포함", level: true, later: true },
  { key: "minPerDay", label: "반 하루 최소 교시(수업이 있는 날)", min: 1, max: 9, unit: "교시" },
  { key: "shortDay", label: "반 하루 최소 교시 지키기(반마다 끝나는 시간이 들쭉날쭉하지 않게)", level: true, later: true },
  { key: "semesterFrame", label: "2학기는 1학기와 같은 뼈대(블록 자리 · 교사–반 짝 · 요일·교시)", level: true, later: true,
    levels: [["hard", "같은 칸(블록·이어지는 수업 모두)"], ["order", "블록은 같은 시간대만(순서는 학기마다 달라도 됨)"], ["soft", "최대한(학기마다 따로)"], ["off", "끔"]] },
  { key: "cover", label: "교사를 세우면 공강·하루 두 번이 생길 때", level: true, levels: [["hard", "교사 먼저(위반이 남을 수 있음)"], ["soft", "공강 먼저(그 수업은 담당 교사 없음)"]], later: true },
  { key: "splitLesson", label: "한 교사가 한 반의 과목을 모두 맡을 시간이 없을 때", level: true, levels: [["allow", "같은 전공 교사 3명까지 나눠서 모두 맡을 수 있으면 나눠 맡음(2명 먼저)"], ["two", "2명까지만 나눠 맡음"], ["off", "나누지 않음(그 수업은 담당 교사 없음)"]], later: true }
];
var TIMETABLE_ISSUE_LABELS = { block: "계산 불가", fail: "조건 위반", warn: "확인", info: "참고" };

// 규칙 값 읽기·쓰기('departmentMax.진로'처럼 점으로 이어진 이름은 한 단계 안쪽 값)
function timetableRuleValue(rules, key) {
  const [head, tail] = key.split(".");
  return tail ? rules[head]?.[tail] : rules[head];
}
function timetableRuleDefault(key) {
  return timetableRuleValue(TIMETABLE_DEFAULT_RULES, key);
}

// ---- 선택형 해결: 조건을 다 지키지 못할 때 '무엇을 양보할지' 교사가 고른다(자동으로 풀지 않음) ----
// 선택지 = 시간표 조건을 바꾸는 것(patch) 또는 다른 단계에서 고칠 것(안내). 교사 수를 늘리는 선택지는 없다(주어진 명단 안에서만 편성).
// 사전 점검 항목의 relax 이름 → 선택지. 순서가 추천 순서(양보가 작은 것부터).
var TIMETABLE_CHOICES = {
  blockTimes: { label: "6단계 블록 시간을 시간표가 다시 놓기", gives: "6단계에서 정한 블록 요일·교시가 바뀝니다(분반·학생 배정은 그대로).",
    skip: (tt, prepared) => !tt.keepBlockTimes || !prepared.input.blocks.some((block) => String(block.times || "").length),
    patch: (tt) => ({ ...tt, keepBlockTimes: null }) },
  creativeFree: { label: "창체 시간을 고정하지 않기(학년별로 놓고 계산이 정함)", gives: "창체가 지금 고정 시간(예: 금 6·7)이 아닐 수 있습니다. 동아리(전교 같은 시간)는 그대로 둡니다.",
    skip: (tt, prepared) => { const creative = prepared.input.creative; return !timetableTimes(creative.schoolTimes).length && !Object.values(creative.gradeTimes || {}).some((list) => timetableTimes(list).length); },
    patch: (tt, prepared) => { const total = Number(prepared.creativeTotal) || 0; const club = Math.min(1, total); return { ...tt, creative: { school: club, schoolTimes: [], grade: total - club, gradeTimes: {}, byGroup: Boolean(prepared.input.creative.byGroup) } }; } },
  creativeGroup: { label: "같은 학년 안에서 반 묶음마다 창체 시간을 다르게(반군별)", gives: "학년 전체가 한 시간에 모이는 창체가 없어집니다(동아리 제외). 그 시간에 다른 반은 반 수업을 할 수 있습니다.",
    skip: (tt, prepared) => Boolean(prepared.input.creative.byGroup),
    patch: (tt, prepared) => { const total = Number(prepared.creativeTotal) || 0; const club = Math.min(1, total); return { ...tt, creative: { school: club, schoolTimes: [], grade: total - club, gradeTimes: {}, byGroup: true } }; } },
  oncePerDay: { label: "같은 교사가 같은 반에 하루 두 번 들어가는 것을 허용(최대한 피함)", gives: "어떤 반은 같은 교사 수업이 하루에 두 번 있을 수 있습니다.",
    skip: (tt) => ({ ...TIMETABLE_DEFAULT_RULES, ...(tt.rules || {}) }).oncePerDay !== "hard",
    patch: (tt) => ({ ...tt, rules: { ...(tt.rules || {}), oncePerDay: "soft" } }) },
  teacherRules: { label: "교사 규칙 양보: 연강 4시간 · 하루 7시간까지", gives: "교사에 따라 4시간 연강, 하루 7시간 수업이 생길 수 있습니다.",
    skip: (tt) => { const rules = { ...TIMETABLE_DEFAULT_RULES, ...(tt.rules || {}) }; return rules.run >= 4 && rules.maxPerDay >= 7; },
    patch: (tt) => { const rules = { ...TIMETABLE_DEFAULT_RULES, ...(tt.rules || {}) }; return { ...tt, rules: { ...(tt.rules || {}), run: Math.max(4, rules.run), maxPerDay: Math.max(7, rules.maxPerDay) } }; } },
  gaps: { label: "반 공강 허용(최대한 줄이고 끝 교시 쪽으로)", gives: "어떤 반은 하루 가운데에 빈 시간이 생길 수 있습니다.",
    skip: (tt) => ({ ...TIMETABLE_DEFAULT_RULES, ...(tt.rules || {}) }).gap !== "hard",
    patch: (tt) => ({ ...tt, rules: { ...(tt.rules || {}), gap: "soft" } }) },
  frameOrder: { label: "블록 순서를 학기마다 다르게 허용(블록 시간대는 그대로)", gives: "블록이 놓이는 요일·교시 묶음은 두 학기 같고, 그 안에서 어느 블록이 어느 칸인지는 학기마다 달라질 수 있습니다. 이어지는 반 수업은 그대로 두 학기 같은 칸·같은 교사입니다.",
    skip: (tt) => ({ ...TIMETABLE_DEFAULT_RULES, ...(tt.rules || {}) }).semesterFrame !== "hard",
    patch: (tt) => ({ ...tt, rules: { ...(tt.rules || {}), semesterFrame: "order" } }) },
  releaseTeacher: { label: "공강·하루 두 번이 남으면 그 수업은 '담당 교사 없음'으로 두기(공강 먼저)", gives: "교사를 세우면 공강이나 하루 두 번이 생기는 반 수업은 담당 교사 칸을 비웁니다 — '담당 교사 없음' 시간이 늘어납니다.",
    skip: (tt) => ({ ...TIMETABLE_DEFAULT_RULES, ...(tt.rules || {}) }).cover === "soft",
    patch: (tt) => ({ ...tt, rules: { ...(tt.rules || {}), cover: "soft" } }) },
  otherDepartment: { label: "다른 교과 교사가 맡기(교양 과목만)", link: "hours", target: "과목별 상세 · 담당 교과", onlyOpen: true,
    gives: "교양 과목은 5단계 과목별 상세의 '담당 교과'에서 맡을 교과를 고르면 그 교과 교사가 후보가 됩니다. 교양이 아닌 과목은 다른 전공 교사가 맡을 수 없습니다." },
  sectionsMove: { label: "분반 구성·분반 교사 바꾸기", link: "sections", target: "분반·블록·분반 교사", gives: "6단계에서 분반을 다른 블록으로 옮기거나, 같은 전공 교사끼리 나눠 맡게 한 뒤 다시 계산합니다." },
  stagger: { label: "반 묶음을 나눠 블록 일부를 엇갈리게", link: "sections", target: "분반 편성", gives: "반 묶음마다 블록 시간이 달라져 반 수업 칸이 늘지만 분반 수가 늘고 6단계를 다시 편성해야 합니다(6단계 반 묶음 편성은 아직 준비 중 — 아래 숫자는 미리 보는 견적입니다)." },
  noTeacher: { label: "그대로 두기 — '담당 교사 없음'으로 표시하고 나머지를 편성", accept: true, link: "aggregate", target: "개설 학급 수·개설 학기",
    gives: "그 시수는 시간표에 '담당 교사 없음'으로 남습니다(해결할 문제 목록). 개설 학급 수·개설 학기를 줄이려면 4단계, 담당 교과·과목은 5단계·6단계 명단에서 고칩니다." }
};
var TIMETABLE_CHOICE_ORDER = ["blockTimes", "creativeFree", "creativeGroup", "teacherRules", "oncePerDay", "gaps", "otherDepartment", "sectionsMove", "stagger", "noTeacher"];

function timetableIssueKey(issue) {
  return `${issue.id}|${String(issue.cause).split(/[:(]/)[0].trim()}`;
}

// 항목마다 선택지와 예상 효과. preview(key) → 그 선택을 적용했을 때의 사전 점검 결과(없으면 null).
// 돌려주는 값: Map(항목 키 → [{ key, label, gives, kind: 'setting' | 'link' | 'accept', where, effect: { solved, failBefore, failAfter } }])
// 반 묶음 글('1-6/7-11') → { A: ['3-1', …], B: [...] }. 묶음이 둘 이상이고 겹치지 않아야 한다. 못 읽으면 null.
function timetableStaggerGroups(text, grade, total) {
  const parts = String(text ?? "").split("/").map((part) => timetableClassList(part, total));
  if (parts.length < 2 || parts.some((list) => !list || !list.length || list.some((n) => Number(n) < 1 || Number(n) > total))) return null;
  const all = parts.flat();
  if (new Set(all).size !== all.length) return null;
  return Object.fromEntries(parts.map((list, index) => [String.fromCharCode(65 + index), list.map((n) => `${grade}-${n}`)]));
}

// 반군 엇갈림 견적(T7a, 읽기 전용): 6단계 분반 결과에서 블록·과목·내년 반별 인원을 모아 학기마다 timetableStaggerEstimate를 돌리고,
// 엇갈릴 블록 수 k마다 두 학기 중 큰 쪽을 보여 준다(엇갈림 블록 수는 두 학기 같게 — 뼈대 유지). 6단계 자료는 바꾸지 않는다.
// 돌려주는 값: { label: '1~6반 / 7~11반', mapped: 내년 반을 아는지, plans: [{ k, extra, small, blocks: { 학기: [블록 이름] } }], semesters: { 학기: 견적 } } 또는 null(분반 결과 없음)
function timetableStaggerFor(round, grade, classCount, settings = timetableSettings()) {
  if (typeof classSectionsSource !== "function" || typeof classSectionsEntry !== "function") return null;
  const total = Math.max(0, Math.floor(Number(classCount) || 0));
  const classes = Array.from({ length: total }, (_, index) => `${grade}-${index + 1}`);
  const groups = timetableStaggerGroups(settings.staggerGroups?.[grade], grade, total) || undefined;
  const source = classSectionsSource(round);
  const semesters = {};
  let mapped = true;
  for (const semester of ["1", "2"]) {
    const blocks = [];
    for (const group of source.groups || []) {
      if (String(group.targetGrade) !== String(grade) || String(group.semester) !== semester) continue;
      const result = classSectionsEntry(round, group.key, false)?.sectionResult;
      if (!result?.sections?.length || !result.assign) continue;
      if (typeof classSectionsEffectiveClassMap === "function" && !classSectionsEffectiveClassMap(group).map) mapped = false;
      const students = typeof classSectionsHomeroomStudents === "function" ? classSectionsHomeroomStudents(group) : group.students || [];
      const roomOf = new Map(students.map((student) => [student.key, String(student.homeroom ?? "")]));
      const members = new Map(result.sections.map((section) => [section.id, {}]));
      for (const [key, ids] of Object.entries(result.assign)) {
        const room = roomOf.get(key);
        if (!room || room === "미정") continue;
        for (const id of ids || []) { const bag = members.get(id); if (bag) bag[`${grade}-${room}`] = (bag[`${grade}-${room}`] || 0) + 1; }
      }
      const nameOf = new Map((group.courses || []).map((course) => [course.key, course.name]));
      for (const block of result.blocks || []) {
        const courses = new Map();
        for (const section of result.sections) {
          if (section.blockId !== block.id) continue;
          const row = courses.get(section.courseKey) || { name: nameOf.get(section.courseKey) || section.courseKey, sections: 0, byClass: {} };
          row.sections += 1;
          for (const [classId, count] of Object.entries(members.get(section.id) || {})) row.byClass[classId] = (row.byClass[classId] || 0) + count;
          courses.set(section.courseKey, row);
        }
        if (courses.size) blocks.push({ id: `${group.key}|${block.letter || block.id}`, label: `${group.category} ${block.letter || block.id}블록`, courses: [...courses.values()] });
      }
    }
    if (blocks.length) semesters[semester] = timetableStaggerEstimate({ classes, groups, capacity: Number(source.maxClassSize) || 34, minSize: TIMETABLE_STAGGER_SMALL, blocks });
  }
  const keys = Object.keys(semesters);
  if (!keys.length) return null;
  const used = semesters[keys[0]].groups;
  const span = (list) => { const numbers = list.map((id) => Number(String(id).split("-")[1])).sort((a, b) => a - b); return numbers.length > 1 && numbers[numbers.length - 1] - numbers[0] === numbers.length - 1 ? `${numbers[0]}~${numbers[numbers.length - 1]}반` : `${numbers.join("·")}반`; };
  const plans = [];
  for (let k = 1; k <= Math.min(...keys.map((key) => semesters[key].plans.length)); k += 1) {
    const each = keys.map((key) => [key, semesters[key].plans[k - 1]]);
    plans.push({ k, extra: Math.max(...each.map(([, plan]) => plan.extra)), small: Math.max(...each.map(([, plan]) => plan.small)),
      blocks: Object.fromEntries(each.map(([key, plan]) => [key, plan.blocks.map((id) => semesters[key].blocks.find((block) => block.id === id)?.label || id)])) });
  }
  return { label: Object.values(used).map(span).join(" / "), spans: Object.fromEntries(Object.entries(used).map(([key, list]) => [key, span(list)])), mapped, plans, semesters };
}

// 엇갈림 견적의 예상 효과(T7a-2): 이 학기 입력에서 블록 k개를 반 묶음별 블록으로 나눈 구조(timetableStaggerInput)로 사전 점검을 다시 돌린다.
// 돌려주는 값: 사전 점검 결과(나눌 블록을 입력에서 못 찾으면 null). 실제 분반·배정은 바꾸지 않는다(어림).
function timetableStaggerPrecheck(input, estimate, grade, k) {
  const own = estimate?.semesters?.[String(input?.semester || "")];
  const plan = own?.plans?.[k - 1];
  if (!plan || typeof timetableStaggerInput !== "function") return null;
  const spec = { grade: String(grade), groups: own.groups, labels: estimate.spans,
    blocks: plan.blocks.map((id) => ({ id, courses: (own.blocks.find((block) => block.id === id)?.courses || []).map((course) => ({ name: course.name, parts: course.parts })) })) };
  const staggered = timetableStaggerInput(input, spec);
  return staggered === input ? null : timetablePrecheck(staggered);
}

function timetableChoicesFor(result, prepared, settings, preview) {
  const out = new Map();
  const failBefore = result.counts.fail + result.counts.block;
  const cache = new Map();
  const effectOf = (key) => {
    if (!cache.has(key)) cache.set(key, preview(key));
    return cache.get(key);
  };
  for (const issue of result.issues) {
    if (issue.level !== "fail" || !issue.relax?.length) continue;
    const openList = prepared.openDepartments || ["교양"];
    const open = openList.includes(String(issue.data?.department || "")) || (issue.data?.departments || []).some((department) => openList.includes(department));
    const list = [];
    for (const key of TIMETABLE_CHOICE_ORDER) {
      const choice = TIMETABLE_CHOICES[key];
      if (!issue.relax.includes(key) || (choice.onlyOpen && !open)) continue;
      if (choice.patch) {
        if (choice.skip?.(settings, prepared)) continue;
        const after = effectOf(key);
        if (!after) continue;
        const solved = !after.issues.some((other) => other.level === "fail" && timetableIssueKey(other) === timetableIssueKey(issue));
        list.push({ key, label: choice.label, gives: choice.gives, kind: "setting", effect: { solved, failBefore, failAfter: after.counts.fail + after.counts.block } });
      } else {
        const item = { key, label: choice.label, gives: choice.gives, kind: choice.accept ? "accept" : "link", where: timetableWhere(choice.link, choice.target) };
        // 반 묶음 엇갈림: 6단계 분반 결과로 어림한 숫자(늘어나는 분반 수·10명 미만 분반 수, 두 학기 중 큰 쪽)를 붙인다
        if (key === "stagger" && issue.data?.grade) {
          try {
            const gradeRow = (prepared.input?.grades || []).find((item) => String(item.grade) === String(issue.data.grade));
            const classCount = Number(issue.data.classes) || (Array.isArray(gradeRow?.classes) ? gradeRow.classes.length : Number(gradeRow?.classes) || 0);
            const estimate = timetableStaggerFor(prepared.round, issue.data.grade, classCount, settings);
            // 예상 효과: 엇갈린 구조로 이 학기 사전 점검을 다시 돌려, 이 항목이 풀리는지와 조건 위반 수를 본다(같은 학년·같은 k는 한 번만 계산)
            const effectOfPlan = (k) => {
              const cacheKey = `stagger|${issue.data.grade}|${k}`;
              if (!cache.has(cacheKey)) { let after = null; try { after = timetableStaggerPrecheck(prepared.input, estimate, issue.data.grade, k); } catch { after = null; } cache.set(cacheKey, after); }
              const after = cache.get(cacheKey);
              if (!after) return undefined;
              const same = (other) => other.level === "fail" && other.id === issue.id && String(other.data?.grade) === String(issue.data.grade)
                && (issue.id !== "P7" || (other.data?.teachers || []).some((id) => (issue.data.teachers || []).includes(id)));
              // 풀리지 않아도 얼마나 나아지는지: P7 = 넣을 수 없는 시간, P6 = 들어가는 반 수업 시간
              const rest = after.issues.find(same);
              const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
              const note = !rest ? "" : issue.id === "P7" && number(issue.data.shortage) !== null && number(rest.data?.shortage) !== null ? `넣을 수 없는 시간 ${issue.data.shortage} → ${rest.data.shortage}시간`
                : issue.id === "P6" && number(issue.data.capacity) !== null && number(rest.data?.capacity) !== null ? `들어가는 반 수업 ${issue.data.capacity} → ${rest.data.capacity}시간, 필요 ${rest.data.need}시간` : "";
              return { solved: !rest, note, failBefore, failAfter: after.counts.fail + after.counts.block };
            };
            if (estimate && estimate.plans.length) item.estimate = { grade: issue.data.grade, label: estimate.label, mapped: estimate.mapped, plans: estimate.plans.slice(0, 2).map((plan) => ({ k: plan.k, extra: plan.extra, small: plan.small, blocks: plan.blocks, effect: effectOfPlan(plan.k) })) };
          } catch { /* 견적을 못 내면 안내만 */ }
        }
        list.push(item);
      }
    }
    // 학년 반 수업 동시성(P6): 그 학년의 반 수업 과목을 '2시간 연속 수업 허용'으로 두면 한 반이 하루에 받을 수 있는 시간이 늘어난다
    // (예: 그룹을 합쳐 3학년 반 수업이 스포츠 생활 2시간만 남은 경우 — 같은 교사가 그 반에 하루 한 번이라 하루 끝 쪽 칸 × 교사 수만큼만 들어감).
    // 나아지는 과목만(이 항목이 풀리거나, 조건 위반이 줄거나, 들어가는 반 수업 시간이 늘어남) 시수가 많은 순으로 3개까지.
    if (issue.id === "P6" && issue.data?.grade && issue.relax.includes("oncePerDay")) {
      const hoursOf = new Map();
      for (const lesson of prepared.input?.lessons || []) {
        if (String(lesson.grade) !== String(issue.data.grade) || lesson.double || Array.isArray(lesson.parts) || !(Number(lesson.hours) >= 2)) continue;
        const classes = Array.isArray(lesson.classes) ? lesson.classes.length : Number(issue.data.classes) || 1;
        hoursOf.set(lesson.subject, (hoursOf.get(lesson.subject) || 0) + Number(lesson.hours) * classes);
      }
      const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
      let added = 0;
      for (const [subject] of [...hoursOf].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), "ko"))) {
        if (added >= 3) break;
        const key = `double:${subject}`;
        const choice = timetableChoiceOf(key);
        if (choice.skip?.(settings, prepared)) continue;
        const after = effectOf(key);
        if (!after) continue;
        const rest = after.issues.find((other) => other.level === "fail" && timetableIssueKey(other) === timetableIssueKey(issue))
          || after.issues.find((other) => other.level === "fail" && other.id === "P6" && String(other.data?.grade) === String(issue.data.grade));
        const failAfter = after.counts.fail + after.counts.block;
        const more = rest && number(issue.data.capacity) !== null && number(rest.data?.capacity) !== null && rest.data.capacity > issue.data.capacity;
        if (rest && failAfter >= failBefore && !more) continue;
        list.push({ key, label: choice.label, gives: choice.gives, kind: "setting",
          effect: { solved: !rest, failBefore, failAfter, ...(more ? { note: `들어가는 반 수업 ${issue.data.capacity} → ${rest.data.capacity}시간(필요 ${rest.data.need}시간)` } : {}) } });
        added += 1;
      }
    }
    if (list.length) out.set(timetableIssueKey(issue), list);
  }
  return out;
}

function timetableEsc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

// 고칠 수 있는 시간표 조건(없으면 만든다).
function timetableSettingsEdit() {
  if (!state.timetable || typeof state.timetable !== "object") state.timetable = {};
  if (!state.timetable.settings || typeof state.timetable.settings !== "object") state.timetable.settings = {};
  return state.timetable.settings;
}

function timetableRound() {
  return typeof courseOpeningRound === "function" ? courseOpeningRound() : String(state.currentRound || "1");
}

function renderTimetable() {
  if (typeof deferRenderUntilStepVisible === "function" && deferRenderUntilStepVisible(6, "renderTimetable", renderTimetable)) return;
  if (typeof preserveViewDuring === "function") return preserveViewDuring(["#workflowStep6Panel"], renderTimetableView);
  return renderTimetableView();
}

function timetableWhereButtons(list) {
  return (list || []).map((where) => `<button class="tt-goto" type="button" data-tt-goto="${timetableEsc(where.key || "")}" data-tt-step="${timetableEsc(where.step)}">${timetableEsc(where.label)}${where.target ? ` · ${timetableEsc(where.target)}` : ""}</button>`).join("");
}

function timetableVerdictHtml(result) {
  const { block, fail, warn } = result.counts;
  const state = block ? "block" : fail ? "fail" : "ok";
  const text = block ? `계산을 시작할 수 없습니다 — 없는 자료 ${block}건을 먼저 채워야 합니다.`
    : fail ? `이대로는 필수 조건을 모두 지키는 시간표가 없습니다 — ${fail}건(조건을 고치거나 완화가 필요합니다).`
      : "사전 점검 통과 — 계산 전에 걸리는 곳이 없습니다(통과해도 계산에서 막힐 수 있습니다).";
  return `<p class="tt-verdict" id="timetableVerdict" data-state="${state}" role="status"><strong>${timetableEsc(text)}</strong>
    <span class="cs-note">계산 불가 ${block} · 조건 위반 ${fail} · 확인 ${warn}</span></p>`;
}

function timetableChangeHtml(info) {
  if (!info) return "";
  const line = (issue) => `<li>${timetableEsc(issue.cause)}</li>`;
  const parts = [];
  if (info.resolved.length) parts.push(`<div data-kind="resolved"><strong>풀림 ${info.resolved.length}</strong><ul>${info.resolved.map(line).join("")}</ul></div>`);
  if (info.changed.length) parts.push(`<div data-kind="changed"><strong>달라짐 ${info.changed.length}</strong><ul>${info.changed.map((item) => `<li>${timetableEsc(item.after.cause)}<span class="cs-note"> ← ${timetableEsc(item.before)}</span></li>`).join("")}</ul></div>`);
  if (info.added.length) parts.push(`<div data-kind="added"><strong>새로 생김 ${info.added.length}</strong><ul>${info.added.map(line).join("")}</ul></div>`);
  return `<section class="tt-change" id="timetableChange" data-resolved="${info.resolved.length}" data-added="${info.added.length}" data-changed="${info.changed.length}" aria-live="polite">
    <h4>방금 바꾼 조건: ${timetableEsc(info.label)}</h4>
    ${parts.length ? parts.join("") : '<p class="cs-note">사전 점검 결과는 그대로입니다.</p>'}</section>`;
}

function timetableChoicesHtml(list) {
  if (!list?.length) return "";
  const row = (choice) => {
    const effect = choice.kind !== "setting" ? ""
      : `<span class="tt-effect" data-solved="${choice.effect.solved}">${choice.effect.solved ? "이 항목 풀림" : `이 항목은 그대로${choice.effect.note ? `(${timetableEsc(choice.effect.note)})` : ""}`} · 조건 위반 ${choice.effect.failBefore} → ${choice.effect.failAfter}건</span>`;
    const action = choice.kind === "setting" ? `<button class="button" type="button" data-tt-choice="${choice.key}">이 선택으로 다시 점검</button>` : timetableWhereButtons([choice.where]);
    const estimate = choice.estimate ? `<div class="tt-gives tt-estimate" data-tt-stagger="${timetableEsc(choice.estimate.grade)}">예상(${timetableEsc(choice.estimate.grade)}학년 반 묶음 ${timetableEsc(choice.estimate.label)}, 6단계 분반 결과로 어림 · 두 학기 중 큰 쪽)${choice.estimate.mapped ? "" : " — 내년 반 배정표가 없어 지금 반 기준입니다"}
      <ul class="tt-estimate-list">${choice.estimate.plans.map((plan) => `<li data-k="${plan.k}" data-extra="${plan.extra}" data-small="${plan.small}">블록 ${plan.k}개 엇갈림 → 분반 <strong>+${plan.extra}</strong>${plan.small ? ` · ${TIMETABLE_STAGGER_SMALL}명 미만 분반 ${plan.small}개` : ""} <span class="tt-estimate-blocks">(${timetableEsc(Object.entries(plan.blocks).map(([semester, labels]) => `${semester}학기 ${labels.join("·")}`).join(", "))})</span>${plan.effect ? ` <span class="tt-effect" data-tt-stagger-effect="${plan.k}" data-solved="${plan.effect.solved}" data-fail-after="${plan.effect.failAfter}">${plan.effect.solved ? "이 항목 풀림" : `이 항목은 그대로${plan.effect.note ? `(${timetableEsc(plan.effect.note)})` : ""}`} · 조건 위반 ${plan.effect.failBefore} → ${plan.effect.failAfter}건</span>` : ""}</li>`).join("")}</ul>
      ${choice.estimate.plans.some((plan) => plan.effect) ? "풀림·위반 수는 이 학기 사전 점검을 엇갈린 구조로 다시 돌린 어림입니다. " : ""}반 묶음은 조건 설정 › 규칙에서 바꿉니다.</div>` : "";
    return `<li data-tt-choice-row="${choice.key}" data-kind="${choice.kind}"><strong>${timetableEsc(choice.label)}</strong> ${effect} ${action}<span class="tt-gives">${timetableEsc(choice.gives)}</span>${estimate}</li>`;
  };
  return `<div class="tt-choices"><span class="tt-choices-title">선택지(무엇을 양보할지 고르세요)</span><ul>${list.map(row).join("")}</ul></div>`;
}

function timetableIssuesHtml(result, choices) {
  const shown = result.issues.filter((issue) => issue.level !== "info");
  const info = result.issues.filter((issue) => issue.level === "info");
  const item = (issue) => `<li class="tt-issue" data-tt-issue="${issue.id}" data-level="${issue.level}">
    <span class="tt-level" data-level="${issue.level}">${TIMETABLE_ISSUE_LABELS[issue.level] || issue.level}</span>
    <span class="tt-cause">${timetableEsc(issue.cause)}</span>
    ${issue.where?.length ? `<span class="tt-where">고칠 곳 ${timetableWhereButtons(issue.where)}</span>` : ""}
    ${issue.level === "fail" ? timetableChoicesHtml(choices?.get(timetableIssueKey(issue))) : ""}</li>`;
  return `<section class="cs-card" id="timetablePrecheck" data-count="${shown.length}">
    <h4>사전 점검 <span class="cs-note">계산 전에 1초 안에 도는 필요 조건 점검입니다. '조건 위반'은 지금 조건으로는 반드시 걸리는 곳이고, 항목마다 고를 수 있는 선택지와 예상 효과를 보여 줍니다(자동으로 풀지 않습니다).</span></h4>
    ${shown.length ? `<ul class="tt-issues">${shown.map(item).join("")}</ul>` : '<p class="cs-note">걸리는 곳이 없습니다.</p>'}
    ${info.length ? `<details class="tt-info"><summary>참고 ${info.length}건</summary><ul class="tt-issues">${info.map(item).join("")}</ul></details>` : ""}</section>`;
}

function timetableAssumptionsHtml(prepared) {
  if (!prepared.assumptions.length) return "";
  return `<section class="cs-card" id="timetableAssumptions" data-count="${prepared.assumptions.length}">
    <h4>가정 ${prepared.assumptions.length}건 <span class="cs-note">자료가 없어 기본값으로 채운 것입니다. 실제 값을 넣으면 사라집니다.</span></h4>
    <ul class="tt-issues">${prepared.assumptions.map((entry) => `<li class="tt-issue" data-tt-assumption="${timetableEsc(entry.key)}"><span class="tt-level" data-level="assume">가정</span>
      <span class="tt-cause">${timetableEsc(entry.text)}</span><span class="tt-where">넣는 곳 ${timetableWhereButtons([entry.where])}</span></li>`).join("")}</ul></section>`;
}

function timetableGradesHtml(result) {
  if (!result.grades.length) return "";
  const cell = (value) => (value === undefined || value === null ? "–" : timetableEsc(value));
  return `<section class="cs-card" id="timetableGrades"><h4>학년별 주간 칸 수 <span class="cs-note">반 수업 칸 = 주 칸 수 − 블록 − 창체. 같은 시간에 반 수업을 맡을 수 있는 교사가 반 수보다 적으면 반 수업은 하루 끝 쪽에만 놓을 수 있습니다.</span></h4>
    <div class="table-wrap"><table class="tt-table"><thead><tr><th>학년</th><th>반 수</th><th>주 칸 수</th><th>반 수업</th><th>블록</th><th>창체</th><th>합계</th><th>남는 칸(끝 교시)</th><th>반 수업 칸</th><th>같은 시간 반 수업 교사</th></tr></thead>
    <tbody>${result.grades.map((row) => `<tr data-tt-grade="${row.grade}"><th>${row.grade}학년</th><td>${cell(row.classes)}</td><td>${cell(row.slots)}</td><td>${cell(row.lessonHours)}</td><td>${cell(row.blockHours)}</td><td>${cell(row.creative)}</td>
      <td>${cell(row.total)}</td><td>${cell(row.spare)}</td><td>${cell(row.free)}</td><td>${row.simultaneous ? `${row.simultaneous}명` : "–"}</td></tr>`).join("")}</tbody></table></div></section>`;
}

function timetableSectionHtml(key, title, summary, body) {
  return `<details class="tt-section" data-tt-section="${key}"${TIMETABLE_VIEW.open[key] ? " open" : ""}><summary><strong>${timetableEsc(title)}</strong> <span class="cs-note">${timetableEsc(summary)}</span></summary><div class="tt-section-body">${body}</div></details>`;
}

function timetableConditionsHtml(prepared) {
  const tt = timetableSettings();
  const cs = classSectionsSettings();
  const input = prepared.input;
  const days = String(cs.gridDays || "").split(/[,\s]+/).filter(Boolean);
  const rules = { ...TIMETABLE_DEFAULT_RULES, ...(tt.rules || {}), departmentMax: { ...TIMETABLE_DEFAULT_RULES.departmentMax, ...(tt.rules?.departmentMax || {}) }, homeroom: input.rules.homeroom };
  const lunch = tt.lunchAfter || TIMETABLE_DEFAULT_LUNCH;
  const creative = input.creative;
  const timesText = (list) => (Array.isArray(list) ? list.map((time) => (typeof time === "string" ? time : `${time.day}${time.period}`)).join(",") : String(list || ""));
  const gradeHours = (grade) => (typeof creative.grade === "object" && creative.grade ? Number(creative.grade[grade]) || 0 : Number(creative.grade) || 0);
  const mode = !tt.creative ? "fixed" : creative.byGroup ? "group" : !creative.school ? "grade" : "custom";
  const preset = (key, label) => `<button class="button" type="button" data-tt-creative-preset="${key}" aria-pressed="${mode === key}">${label}</button>`;

  // 시간 구조
  const periodInputs = days.map((day) => `<label>${day} <input class="cs-num" type="number" min="1" max="12" value="${timetableEsc(tt.periodsByDay?.[day] ?? cs.gridPeriods)}" data-tt-field="period:${day}" data-focus-key="tt-period-${day}" aria-label="${day}요일 교시 수"></label>`).join("");
  const lunchInputs = ["1", "2", "3"].map((grade) => `<label>${grade}학년 <input class="cs-num" type="number" min="1" max="11" value="${timetableEsc(lunch[grade] ?? 4)}" data-tt-field="lunch:${grade}" data-focus-key="tt-lunch-${grade}" aria-label="${grade}학년 점심 앞 교시"> 교시 뒤</label>`).join("");
  const gradeTimeInputs = ["1", "2", "3"].map((grade) => `<label>${grade}학년 <input class="cs-text" type="text" value="${timetableEsc(timesText(creative.gradeTimes?.[grade]))}" placeholder="비우면 계산이 정함" data-tt-field="creative.gradeTimes:${grade}" data-focus-key="tt-creative-times-${grade}" aria-label="${grade}학년 창체 시간"></label>`).join("");
  const fixedText = input.fixedSlots.length ? input.fixedSlots.map((slot) => `${slot.label || "고정"} ${timesText(slot.times)}`).join(" · ") : "없음";
  const roomsText = Object.entries(cs.rooms || {}).filter(([, value]) => Number(value) > 0).map(([name, value]) => `${name} ${value}`).join(" · ") || "없음";
  const time = `
    <div class="tt-row"><span class="tt-label">요일별 교시 수</span><span class="tt-fields">${periodInputs}</span><span class="cs-note">요일은 6단계 격자(${timetableEsc(cs.gridDays)})를 씁니다.</span></div>
    <div class="tt-row"><span class="tt-label">학년별 점심</span><span class="tt-fields">${lunchInputs}</span><span class="cs-note">점심이 다른 학년의 같은 교시는 실제 시각이 다릅니다.</span></div>
    <div class="tt-row" id="timetableCreative"><span class="tt-label">창체 ${prepared.creativeTotal}시간<br><span class="cs-note">시수는 5단계</span></span><span class="tt-fields">
      <span class="tt-presets" role="group" aria-label="창체 놓는 방식">${preset("fixed", "전교 동시(6단계 고정 시간)")}${preset("grade", "학년별로 놓기")}${preset("group", "학년별 + 반군별 허용")}</span>
      <label>전교 동시(동아리 등) <input class="cs-num" type="number" min="0" max="9" value="${timetableEsc(creative.school)}" data-tt-field="creative.school" data-focus-key="tt-creative-school" aria-label="전교 동시 창체 시수"> 시간</label>
      <label>전교 동시 시간 <input class="cs-text" type="text" value="${timetableEsc(timesText(creative.schoolTimes))}" placeholder="예: 금7 (비우면 계산이 정함)" data-tt-field="creative.schoolTimes" data-focus-key="tt-creative-school-times" aria-label="전교 동시 창체 시간"></label>
      <span>학년별 <strong id="timetableCreativeGrade">${["1", "2", "3"].map((grade) => gradeHours(grade)).join("·")}</strong>시간(1·2·3학년)</span>
      <span class="tt-sub">학년별 창체 시간 ${gradeTimeInputs}</span>
      <label><input type="checkbox" data-tt-field="creative.byGroup" ${creative.byGroup ? "checked" : ""}> 같은 학년 안에서 반 묶음마다 다른 시간 허용(반군별)</label>
      <label>시간을 정하지 않은 창체는 <input class="cs-num" type="number" min="1" max="12" value="${timetableEsc(creative.fromPeriod ?? TIMETABLE_CREATIVE_FROM)}" data-tt-field="creativeFrom" data-focus-key="tt-creative-from" aria-label="시간을 정하지 않은 창체를 놓을 수 있는 첫 교시"> 교시 이후에만(1 = 제한 없음)</label>
    </span></div>
    <div class="tt-row"><span class="tt-label">장소</span><span class="tt-fields">
      <label>체육 동시 수업 <input class="cs-num" type="number" min="0" max="20" value="${timetableEsc(tt.venues?.체육 ?? "")}" data-tt-field="venue:체육" data-focus-key="tt-venue-pe" aria-label="체육 동시 수업 가능 반 수"> 반(비우면 점검 안 함)</label>
      <span>특별실: ${timetableEsc(roomsText)} ${timetableWhereButtons([timetableWhere("teachers", "특별실")])}</span></span></div>
    <div class="tt-row"><span class="tt-label">전교 고정 시간</span><span class="tt-fields"><span>${timetableEsc(fixedText)}</span> ${timetableWhereButtons([timetableWhere("teachers", "고정 시간")])}</span></div>`;

  // 규칙
  const ruleRows = TIMETABLE_RULE_FIELDS.map((field) => {
    const value = timetableRuleValue(rules, field.key);
    const fallback = field.key === "homeroom" ? (prepared.homeroomCount ? "soft" : "off") : timetableRuleDefault(field.key);
    const control = field.level
      ? `<select data-tt-field="rules.${field.key}" data-focus-key="tt-rule-${field.key}" aria-label="${timetableEsc(field.label)}">${(field.levels || TIMETABLE_LEVELS).map(([level, label]) => `<option value="${level}"${value === level ? " selected" : ""}>${label}</option>`).join("")}</select>`
      : `<input class="cs-num" type="number" min="${field.min}" max="${field.max}" value="${timetableEsc(value)}" data-tt-field="rules.${field.key}" data-focus-key="tt-rule-${field.key}" aria-label="${timetableEsc(field.label)}"> ${field.unit}`;
    return `<div class="tt-row" data-tt-rule="${field.key}"><span class="tt-label">${timetableEsc(field.label)}</span><span class="tt-fields">${control}
      ${value !== fallback ? `<span class="cs-badge" data-state="draft">기본값 ${timetableEsc(field.level ? (field.levels || TIMETABLE_LEVELS).find(([level]) => level === fallback)?.[1] : fallback)}에서 바꿈</span>` : ""}
      ${field.later ? '<span class="cs-note">시간표 계산에서 씁니다(사전 점검에는 영향 없음).</span>' : ""}</span></div>`;
  }).join("");
  const doubleNow = new Set(Array.isArray(tt.doubleSubjects) ? tt.doubleSubjects : []);
  const doubleOptions = new Map(); // 과목 → 학년(반 수업으로 주 2시간 이상인 과목만)
  for (const lesson of prepared.input.lessons || []) if (Number(lesson.hours) >= 2 || doubleNow.has(lesson.subject)) doubleOptions.set(lesson.subject, lesson.grade);
  for (const subject of doubleNow) if (!doubleOptions.has(subject)) doubleOptions.set(subject, "");
  const doubleRow = `<div class="tt-row" data-tt-rule="doubleSubjects"><span class="tt-label">2시간 연속 수업을 허용할 과목</span><span class="tt-fields">
    <details class="tt-double"${doubleNow.size ? " open" : ""}><summary>${doubleNow.size ? `${doubleNow.size}과목: ${timetableEsc([...doubleNow].join(", "))}` : "없음 — 과목 고르기"}</summary><span class="tt-double-list" id="timetableDoubleSubjects">
      ${[...doubleOptions.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])) || a[0].localeCompare(b[0], "ko")).map(([subject, grade]) => `<label><input type="checkbox" data-tt-field="double:${timetableEsc(subject)}" ${doubleNow.has(subject) ? "checked" : ""}> ${grade ? `${timetableEsc(grade)}학년 ` : ""}${timetableEsc(subject)}</label>`).join("")}</span></details>
    <span class="cs-note">고른 과목은 같은 교사가 그 반에 하루 2시간이어도 이어져 있으면 '하루 한 번' 위반으로 보지 않습니다(3시간 이상·떨어진 2시간은 위반).</span></span></div>`;
  const blockGrades = [...new Set((prepared.input.blocks || []).map((block) => String(block.grade)))].sort();
  const staggerRow = blockGrades.length ? `<div class="tt-row" data-tt-rule="staggerGroups"><span class="tt-label">반 묶음(엇갈림 견적용)</span><span class="tt-fields">
    ${blockGrades.map((grade) => { const total = (prepared.input.grades || []).find((item) => String(item.grade) === grade)?.classes || 0; const half = Math.ceil(total / 2);
      return `<label>${grade}학년 <input class="cs-text" type="text" value="${timetableEsc(tt.staggerGroups?.[grade] || "")}" placeholder="${total > 1 ? `1-${half}/${half + 1}-${total}` : ""}" data-tt-field="stagger:${grade}" data-focus-key="tt-stagger-${grade}" aria-label="${grade}학년 반 묶음"></label>`; }).join("")}
    <span class="cs-note">비우면 앞·뒤 절반. '1-6/7-11'처럼 묶음을 /로 나눠 적습니다. 사전 점검의 '반 묶음을 나눠 블록 일부를 엇갈리게' 선택지에 보이는 예상 분반 수에만 쓰입니다(6단계 편성은 바꾸지 않음).</span></span></div>` : "";
  const rulesBody = `${ruleRows}${doubleRow}${staggerRow}<div class="tt-row"><span class="tt-label"></span><span class="tt-fields"><button class="button" type="button" id="timetableRulesReset">규칙을 기본값으로</button>
    <span class="cs-note">'반드시'인 조건을 다 지킬 수 없으면 자동으로 풀지 않고, 아래 사전 점검의 선택지에서 무엇을 양보할지 고릅니다.</span></span></div>`;

  // 교사: 주어진 명단 안에서만 편성한다(교사를 늘리는 입력은 없다). 후보 = 6단계 명단의 담당 교과·담당 과목.
  const listed = classSectionsTeacherList(cs).filter((teacher) => !teacher.assumed).length;
  const counts = [...(prepared.input.notes.teacherCounts || []), ...(prepared.input.notes.homerooms || [])];
  const departmentIds = typeof HOURS_DEPARTMENTS !== "undefined" ? HOURS_DEPARTMENTS.filter((department) => !department.common).map((department) => department.id) : prepared.openDepartments;
  const departmentName = (id) => (typeof hoursDepartmentName === "function" ? hoursDepartmentName(id) : id);
  const teachersBody = `
    <p class="cs-note">시간표는 <strong>주어진 교사 명단 안에서만</strong> 편성합니다. 한 과목을 맡을 수 있는 교사는 6단계 교사 명단에서 <strong>담당 교과</strong>가 그 과목의 담당 교과이거나 <strong>담당 과목</strong>에 그 과목이 적힌 교사뿐입니다(전공 일치).
      한 교사가 두 교과를 함께 맡으면(예: 정보 교사가 기술·가정 과목도 담당) 명단의 '담당 과목'에 그 과목 이름을 적으세요. 다른 교과 교사가 맡을 수 있는 것은 교양 과목뿐이고, 5단계 과목별 상세의 '담당 교과'에서 정합니다.</p>
    <div class="tt-row"><span class="tt-label">교사 명단</span><span class="tt-fields"><span id="timetableTeacherCount">${listed ? `6단계 명단 ${listed}명` : `6단계 명단 없음 — 5단계 교과별 교사 수로 만든 자리 교사 ${input.teachers.length}명으로 계산`}</span>
      ${timetableWhereButtons([timetableWhere("teachers", "교사 명단"), timetableWhere("hours", "과목별 상세 · 담당 교과")])}</span></div>
    <div class="tt-row"><span class="tt-label">담임</span><span class="tt-fields"><span id="timetableHomeroomCount">${prepared.homeroomCount ? `담임 ${prepared.homeroomCount}명(6단계 교사 명단의 '담임' 칸)` : "담임 명단 없음 — 6단계 교사 명단의 '담임' 칸에 내년 학년-반(예: 2-3)을 적으면 담임 규칙을 씁니다"}</span>
      ${timetableWhereButtons([timetableWhere("teachers", "담임")])}</span></div>
    <div class="tt-row" id="timetableOpenDepartments"><span class="tt-label">다른 교과 교사가<br>맡을 수 있는 교과</span><span class="tt-fields">
      ${departmentIds.map((id) => `<label><input type="checkbox" data-tt-field="open:${timetableEsc(id)}" data-focus-key="tt-open-${timetableEsc(id)}"${prepared.openDepartments.includes(id) ? " checked" : ""}> ${timetableEsc(departmentName(id))}</label>`).join("")}
      <span class="cs-note" style="flex-basis:100%">기본은 교양뿐입니다. 고른 교과의 과목만 5단계 '담당 교과' 지정으로 다른 교과 교사가 맡을 수 있고, 그 밖의 과목은 전공이 다른 교사가 맡으면 조건 위반입니다.</span></span></div>
    ${counts.map((text) => `<p class="cs-note is-warn">${timetableEsc(text)}</p>`).join("")}`;

  // 반 일부만 듣는 과목(교차집중·분할 편성) 반 배정
  const saved = tt.splitClasses || {};
  const splitBody = prepared.splits.length ? prepared.splits.map((group) => {
    const editable = group.members.length === 2 ? group.members.slice(0, 1) : group.members;
    const inputs = editable.map((member) => `<label>${timetableEsc(member.subject)} <input class="cs-text" type="text" value="${timetableEsc(saved[group.key]?.[member.subject] ?? "")}" placeholder="${timetableEsc(member.classes.join(","))}"
      data-tt-field="split:${timetableEsc(group.key)}:${timetableEsc(member.subject)}" data-focus-key="tt-split-${timetableEsc(group.key)}-${timetableEsc(member.subject)}" aria-label="${timetableEsc(`${group.label} ${member.subject} ${group.base}학기 반`)}"> (${member.count}반)</label>`).join("");
    const now = group.members.map((member) => `${member.subject} ${member.here.length ? `${member.here.join(",")}반` : "없음"}`).join(" / ");
    return `<div class="tt-row" data-tt-split="${timetableEsc(group.key)}" data-source="${group.source}"><span class="tt-label">${timetableEsc(group.label)}<br><span class="cs-note">${group.base}학기에 듣는 반</span></span><span class="tt-fields">${inputs}
      <span class="tt-sub">이번 학기(${prepared.semester}학기): ${timetableEsc(now)}${group.source === "default" ? ' <span class="cs-badge" data-state="draft">가정: 앞 반부터</span>' : ""}</span>
      ${group.errors.map((text) => `<span class="cs-note is-warn">${timetableEsc(text)}</span>`).join("")}</span></div>`;
  }).join("") + `<p class="cs-note">과목마다 반 수는 편제표 × 학급 수(1단계 교차집중 팝업에서 고른 '1반 더 받을 과목' 포함)로 정해져 있어 여기서는 어느 반인지만 고릅니다. 교차집중은 다른 학기에 서로 맞바꿉니다.</p>`
    : '<p class="cs-note">반 일부만 듣는 학교 지정 과목(교차집중·분할 편성)이 없습니다.</p>';

  const blockRow = `<div class="tt-row"><span class="tt-label">블록 시간</span><span class="tt-fields"><label><input type="checkbox" data-tt-field="blocks.keep" ${tt.keepBlockTimes ? "checked" : ""}> 6단계 블록 시간 그대로 지키기</label>
    <span class="cs-note">끄면(기본) 블록 요일·교시를 시간표가 공강이 생기지 않게 정합니다 — 분반·학생 배정은 그대로이고, 계산 뒤 결과에서 6단계에 적어 넣을 수 있습니다.</span></span></div>`;
  const chosen = Array.isArray(tt.choices) ? tt.choices : [];
  const chosenHtml = chosen.length ? `<div class="tt-chosen" id="timetableChosen" data-count="${chosen.length}"><strong>고른 선택 ${chosen.length}개</strong>
    <ol>${chosen.map((entry) => `<li>${timetableEsc(entry.label)}</li>`).join("")}</ol><button class="button" type="button" id="timetableChoiceUndo">마지막 선택 되돌리기</button></div>` : "";
  const timeSummary = `${days.map((day) => tt.periodsByDay?.[day] ?? cs.gridPeriods).join("·")}교시 · 창체 전교 ${creative.school} + 학년별 ${gradeHours("1")}${creative.byGroup ? " · 반군별 허용" : ""}`;
  const rulesSummary = `참고 상한 ${rules.maxHours} · 진로 ${rules.departmentMax.진로} · 연강 ${rules.run} · 하루 ${rules.maxPerDay} · 공강 ${TIMETABLE_LEVELS.find(([value]) => value === rules.gap)?.[1] || ""}`;
  return `<section class="cs-card" id="timetableConditions"><h4>조건 설정 <span class="cs-note">바꾸면 사전 점검이 바로 다시 돕니다. 5·6단계에서 온 값은 그 단계에서 고칩니다.</span></h4>
    <p class="tt-status${TIMETABLE_VIEW.statusError ? " is-error" : ""}" id="timetableStatus" role="status" aria-live="polite">${timetableEsc(TIMETABLE_VIEW.status)}</p>
    ${chosenHtml}
    ${timetableSectionHtml("time", "시간 구조 · 창체 · 블록 · 장소", timeSummary, time + blockRow)}
    ${timetableSectionHtml("rules", "규칙", rulesSummary, rulesBody)}
    ${timetableSectionHtml("teachers", "교사(주어진 명단 · 전공 일치)", `${input.teachers.length}명${counts.length ? " · 5단계 교사 수와 다름" : ""}`, teachersBody)}
    ${timetableSectionHtml("split", "반 일부만 듣는 과목의 반", prepared.splits.length ? `${prepared.splits.length}묶음${prepared.splits.some((group) => group.source === "default") ? " · 가정 있음" : ""}` : "없음", splitBody)}
  </section>`;
}

// ---- 시간표 계산: 일꾼(Worker) 여럿이 다른 씨앗으로 함께 풀고 가장 좋은 답을 쓴다 ----

// 두 학기 입력을 함께 모은다(풀이기는 두 학기를 한 번에 푼다). blocked = 계산을 막는 없는 자료(P0).
function timetableSolveInputs(round = timetableRound(), check = true) {
  const inputs = {};
  const blocked = [];
  for (const semester of ["1", "2"]) {
    const prepared = timetableInput(round, semester);
    inputs[semester] = JSON.parse(JSON.stringify(prepared.input, typeof stateJsonReplacer === "function" ? stateJsonReplacer : undefined));
    if (check) for (const issue of timetablePrecheck(prepared.input).issues) if (issue.level === "block") blocked.push({ semester, cause: issue.cause });
  }
  // 서명에는 고정한 칸을 넣지 않는다: 이미 그 자리에 있는 칸을 고정했다고 결과가 '바뀌기 전 것'이 되지 않게(고정이 지켜지는지는 timetablePinsHeld로 따로 본다)
  const bare = Object.fromEntries(Object.entries(inputs).map(([key, input]) => { const copy = { ...input }; delete copy.pins; return [key, copy]; }));
  return { inputs, blocked, signature: timetableSignature(bare) };
}

// 지금 조건·자료의 서명(저장된 결과가 바뀌기 전 것인지 볼 때).
function timetableCurrentSignature(round = timetableRound()) {
  const compute = () => timetableSolveInputs(round, false).signature;
  return typeof cachedByStateRevision === "function" ? cachedByStateRevision("timetableSignature", String(round), compute) : compute();
}

function timetableWorkerCount() {
  const cores = typeof navigator !== "undefined" && Number(navigator.hardwareConcurrency) > 0 ? Number(navigator.hardwareConcurrency) : 2;
  return Math.max(1, Math.min(6, cores - 1));
}

function timetableRunProgressText(run) {
  const parts = run.progress.filter(Boolean);
  const ratio = parts.length ? Math.max(...parts.map((item) => (item.total ? Math.min(1, item.iteration / item.total) : 0))) : 0;
  const seconds = Math.round((Date.now() - run.startedAt) / 1000);
  const done = run.results.filter(Boolean).length;
  return { ratio, text: run.stopping ? "멈추는 중 — 지금까지 가장 좋은 답을 모읍니다." : `계산 중 ${Math.round(ratio * 100)}% · ${seconds}초 · ${run.plans.length}개 동시에${done ? ` (${done}개 끝남)` : ""} — 중단해도 그때까지 가장 좋은 답을 씁니다.` };
}

function timetableRunPaint() {
  const run = TIMETABLE_RUN;
  const box = document.getElementById("timetableRunProgress");
  if (!run || !box) return;
  const { ratio, text } = timetableRunProgressText(run);
  const bar = box.querySelector("progress");
  const label = box.querySelector("[data-tt-run-text]");
  if (bar) bar.value = ratio;
  if (label) label.textContent = text;
}

// options.more = '더 오래 계산': 지금 결과는 그대로 두고 아직 안 쓴 씨앗으로 한 번 더 — 끝나면 더 나은 답일 때만 바꾼다(timetableRunFinish).
function timetableRunStart(choiceLabel = "", options = {}) {
  if (TIMETABLE_RUN) return;
  let prepared;
  try { prepared = timetableSolveInputs(); } catch (error) { TIMETABLE_VIEW.runStatus = `시간표 자료를 모으지 못했습니다: ${error?.message || error}`; TIMETABLE_VIEW.runError = true; renderTimetable(); return; }
  if (prepared.blocked.length) { TIMETABLE_VIEW.runStatus = `계산을 시작할 수 없습니다 — ${prepared.blocked[0].semester}학기: ${prepared.blocked[0].cause}`; TIMETABLE_VIEW.runError = true; renderTimetable(); return; }
  const settings = timetableSettings();
  const current = options.more ? timetableSaved(timetableRound()) : null;
  const more = Boolean(current && current.signature === prepared.signature);
  const usedSeeds = more ? [Number(current.result?.seed) || 0, ...(current.tries || []).map((item) => Number(item.seed) || 0)] : [];
  const firstSeed = more ? Math.max(0, ...usedSeeds) + 1 : Number(settings.seed) > 0 ? Math.floor(Number(settings.seed)) : 1;
  const plans = timetableWorkerPlans(timetableWorkerCount(), firstSeed);
  const run = { round: timetableRound(), signature: prepared.signature, inputs: prepared.inputs, plans, workers: [], progress: plans.map(() => null), results: plans.map(() => null), failed: 0, startedAt: Date.now(), stopping: false, timer: 0, choice: choiceLabel || "", more };
  TIMETABLE_RUN = run;
  TIMETABLE_VIEW.runStatus = "";
  TIMETABLE_VIEW.runError = false;
  const optionsOf = (plan) => (plan.long ? { seed: plan.seed, rounds: 0, iterations: TIMETABLE_DEFAULT_ITERATIONS * 2 * 4 } : { seed: plan.seed });
  const settle = (index, value) => {
    if (TIMETABLE_RUN !== run || run.results[index]) return;
    run.results[index] = value || { failed: true };
    if (!value) run.failed += 1;
    if (run.results.every(Boolean)) timetableRunFinish(run);
    else timetableRunPaint();
  };
  // Worker를 못 쓰는 브라우저: 이 창에서 조각으로 나눠 한 개만 푼다.
  const inline = (index) => {
    let solve;
    try { solve = timetableSolveStart(run.inputs, optionsOf(plans[index])); } catch (error) { run.error = error?.message || String(error); settle(index, null); return; }
    const tick = () => {
      if (TIMETABLE_RUN !== run) return;
      try {
        const progress = timetableSolveStep(solve, 20000);
        if (progress.done || run.stopping) { settle(index, JSON.parse(JSON.stringify(timetableSolveFinish(solve)))); return; }
        run.progress[index] = progress;
        timetableRunPaint();
        setTimeout(tick, 0);
      } catch (error) { run.error = error?.message || String(error); settle(index, null); }
    };
    setTimeout(tick, 0);
  };
  let url = "";
  try { url = URL.createObjectURL(new Blob([timetableWorkerSource()], { type: "text/javascript" })); } catch { url = ""; }
  plans.forEach((plan, index) => {
    let worker = null;
    try { worker = url ? new Worker(url) : null; } catch { worker = null; }
    if (!worker) { if (index === 0) inline(0); else settle(index, null); return; }
    run.workers[index] = worker;
    worker.onmessage = (event) => {
      const data = event.data || {};
      if (!data.ok) { run.error = data.error; worker.terminate(); settle(index, null); return; }
      if (data.done) { worker.terminate(); settle(index, data.value); return; }
      run.progress[index] = data.progress;
      timetableRunPaint();
    };
    worker.onerror = () => { worker.terminate(); run.workers[index] = null; if (index === 0 && !run.results[0]) inline(0); else settle(index, null); };
    worker.postMessage({ id: String(index), inputs: run.inputs, options: optionsOf(plan), chunk: 20000 });
  });
  if (url) setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* 이미 지워짐 */ } }, 5000);
  const seconds = Number(settings.solveSeconds) > 0 ? Number(settings.solveSeconds) : TIMETABLE_SOLVE_SECONDS;
  run.timer = setTimeout(() => timetableRunStop(), seconds * 1000);
  renderTimetable();
}

// 중단: 일꾼마다 그때까지 가장 좋은 답을 돌려준다.
function timetableRunStop() {
  const run = TIMETABLE_RUN;
  if (!run || run.stopping) return;
  run.stopping = true;
  run.workers.forEach((worker, index) => { if (worker && !run.results[index]) worker.postMessage({ type: "stop", id: String(index) }); });
  timetableRunPaint();
}

function timetableRunFinish(run) {
  clearTimeout(run.timer);
  TIMETABLE_RUN = null;
  const best = timetableBestResult(run.results.filter((item) => item && !item.failed));
  if (!best) {
    TIMETABLE_VIEW.runStatus = `시간표를 계산하지 못했습니다${run.error ? `: ${run.error}` : "."}`;
    TIMETABLE_VIEW.runError = true;
    renderTimetable();
    return;
  }
  let validation = { ok: true, errors: [] };
  try { const check = timetableValidate(run.inputs, best); validation = { ok: check.ok, errors: check.errors.slice(0, 30).map((item) => ({ semester: item.semester, text: item.text })) }; }
  catch (error) { validation = { ok: false, errors: [{ semester: "", text: `검증하지 못했습니다: ${error?.message || error}` }] }; }
  if (!state.timetable || typeof state.timetable !== "object") state.timetable = {};
  const before = timetableSaved(run.round);
  if (run.more && before && before.signature === run.signature) {
    // '더 오래 계산': 지금 결과와 견줘 더 나은 답(못 넣은 시간 → '반드시' 위반 → 담당 교사 없음 → 비용 순)일 때만 바꾼다
    const kept = timetableBestResult([before.result, best]) !== best;
    const seeds = run.plans.map((plan) => plan.seed);
    const moreTries = run.results.map((item, index) => (item && !item.failed ? { seed: item.seed, hard: item.metrics?.hard ?? null, noTeacherHours: item.metrics?.noTeacherHours ?? null, long: Boolean(run.plans[index].long), more: true } : { seed: run.plans[index].seed, failed: true, more: true }));
    const info = { at: new Date().toISOString(), seeds: [Math.min(...seeds), Math.max(...seeds)], tried: moreTries.filter((item) => !item.failed).length, hard: best.metrics?.hard ?? null, noTeacherHours: best.metrics?.noTeacherHours ?? null,
      from: { hard: before.result?.metrics?.hard ?? null, noTeacherHours: before.result?.metrics?.noTeacherHours ?? null }, replaced: !kept, seconds: Math.round((Date.now() - run.startedAt) / 100) / 10, stopped: run.stopping };
    const allTries = [...(Array.isArray(before.tries) ? JSON.parse(JSON.stringify(before.tries, typeof stateJsonReplacer === "function" ? stateJsonReplacer : undefined)) : []), ...moreTries];
    if (kept) {
      state.timetable[run.round].tries = allTries;
      state.timetable[run.round].more = info;
      state.timetable[run.round].tried = allTries.filter((item) => !item.failed).length;
      if (typeof persistStateSoon === "function") persistStateSoon();
      TIMETABLE_VIEW.runStatus = "";
      TIMETABLE_VIEW.runError = false;
      renderTimetable();
      return;
    }
    run.moreInfo = info;
    run.moreTries = allTries;
  }
  const previous = before?.result?.metrics ? { hard: before.result.metrics.hard, noTeacherHours: before.result.metrics.noTeacherHours, at: before.at } : undefined;
  // 일꾼마다의 답(씨앗별 '반드시' 위반·담당 교사 없음) — 여러 씨앗 가운데 고른 효과를 화면에서 볼 수 있게
  const tries = run.results.map((item, index) => (item && !item.failed ? { seed: item.seed, hard: item.metrics?.hard ?? null, noTeacherHours: item.metrics?.noTeacherHours ?? null, long: Boolean(run.plans[index].long) } : { seed: run.plans[index].seed, failed: true }));
  state.timetable[run.round] = { at: new Date().toISOString(), tries: run.moreTries || tries, ...(previous ? { previous } : {}), ...(run.choice ? { choice: run.choice } : {}), ...(run.moreInfo ? { more: run.moreInfo } : {}), seconds: Math.round((Date.now() - run.startedAt) / 100) / 10,
    tried: (run.moreTries || tries).filter((item) => !item.failed).length, stopped: run.stopping, signature: run.signature, validation, result: best };
  TIMETABLE_VIEW.undo = []; // 새로 계산하면 직접 고친 것의 되돌리기 기록은 비운다
  TIMETABLE_VIEW.editPick = "";
  TIMETABLE_VIEW.editTargets = null;
  TIMETABLE_VIEW.editStatus = "";
  if (typeof persistStateSoon === "function") persistStateSoon();
  TIMETABLE_VIEW.runStatus = "";
  TIMETABLE_VIEW.runError = false;
  renderTimetable();
}

// 낱장 인쇄: 지금 보는 학기의 반(또는 교사) 시간표를 한 장에 2개씩 #printBatch에 넣고 인쇄한다. all = 전체, 아니면 지금 고른 반·교사만.
function timetablePrint(all) {
  const round = timetableRound();
  const saved = timetableSaved(round);
  const target = document.getElementById("printBatch");
  const semester = TIMETABLE_VIEW.semester;
  if (!saved || !target || !saved.result.layers?.[semester]) return;
  const prepared = timetableInput(round, semester);
  const kind = TIMETABLE_VIEW.grid === "teacher" ? "teacher" : "class";
  const tables = timetableResultTables(prepared.input, saved.result.layers[semester]);
  const printed = timetablePrintHtml(tables, kind, { title: `${prepared.year}학년도 ${semester}학기`, perPage: 2, only: all ? "" : TIMETABLE_VIEW.pick[kind] });
  if (!printed.cards) return;
  target.innerHTML = printed.html;
  TIMETABLE_VIEW.runStatus = `${kind === "teacher" ? "교사" : "반"} 시간표 ${printed.cards}개(${printed.pages}장)를 인쇄합니다.`;
  TIMETABLE_VIEW.runError = false;
  renderTimetable();
  if (typeof window !== "undefined" && typeof window.print === "function") window.print();
}

// 계산 결과를 엑셀로: 학기마다 학급별·교사별 전체 시간표 + 못 지킨 조건 + 담당 교사 없음.
function timetableDownload() {
  const round = timetableRound();
  const saved = timetableSaved(round);
  if (!saved || typeof createWorkbookBlob !== "function" || typeof downloadBlob !== "function") return;
  const inputs = {};
  let year = "";
  for (const semester of Object.keys(saved.result.layers || {})) { const prepared = timetableInput(round, semester); inputs[semester] = prepared.input; year = prepared.year; }
  const sheets = timetableResultSheets(inputs, saved.result, { title: `${year}학년도 ${round}차`, rules: TIMETABLE_VIOLATION_LABELS, reasons: TIMETABLE_NO_TEACHER_REASONS });
  downloadBlob(createWorkbookBlob(sheets), `${year}_${round}차_시간표.xlsx`);
}

// 직접 고치기: 반 시간표에서 칸 둘을 차례로 누르면 맞바꾼다. 되돌리기는 이 창에서 고친 것만(새로 계산하면 비움).
// 고친 뒤 상태 줄에 붙이는 글: '반드시' 위반 수가 어떻게 바뀌었는지(두 학기 합계)와 규칙별 내역, '최대한' 조건 수의 변화
function timetableChangeText(before, outcome) {
  const change = outcome?.change;
  if (!change) return "";
  const hard = Number(before?.metrics?.hard) || 0;
  const softNow = (outcome.result.violations || []).filter((item) => item.level !== "hard").reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
  const head = change.hard ? ` · '반드시' 위반 ${hard} → ${outcome.result.metrics.hard}건(${change.parts.join(", ")})` : " · '반드시' 위반 수는 그대로";
  return `${head}${change.soft ? `, '최대한' 조건 ${softNow - change.soft} → ${softNow}건` : ""}`;
}

function timetableEditClick(slot) {
  const round = timetableRound();
  const saved = timetableSaved(round);
  if (!saved || TIMETABLE_RUN) return;
  const semester = TIMETABLE_VIEW.semester;
  const inputs = {};
  for (const key of Object.keys(saved.result.layers || {})) inputs[key] = timetableModel(timetableInput(round, key).input);
  const plainResult = JSON.parse(JSON.stringify(saved.result, typeof stateJsonReplacer === "function" ? stateJsonReplacer : undefined));
  if (!TIMETABLE_VIEW.editPick) {
    // 첫 칸을 고르면 맞바꿀 수 있는 칸을 미리 살펴 표에 표시한다(안 되는 칸은 이유를 칸 설명으로)
    const targets = {}; // 칸 → { hard: 늘어나는 '반드시' 위반 수(음수 = 줄어듦), parts } (옮길 수 있음) 또는 이유 글(안 됨)
    const grade = inputs[semester].grades.find((item) => item.classes.includes(TIMETABLE_VIEW.pick.class));
    const before = timetableValidate(inputs, plainResult); // 고치기 전 검증은 한 번만
    for (const other of grade ? grade.slots : []) {
      if (other.key === slot) continue;
      let outcome;
      try { outcome = timetableEditSwap(inputs, plainResult, { semester, classId: TIMETABLE_VIEW.pick.class, a: slot, b: other.key, before }); } catch (error) { outcome = { ok: false, reason: error?.message || String(error) }; }
      targets[other.key] = outcome.ok ? { hard: outcome.change.hard, parts: outcome.change.parts } : outcome.reason;
    }
    TIMETABLE_VIEW.editPick = slot;
    TIMETABLE_VIEW.editTargets = targets;
    // 반 수업 칸이면 담당 교사를 바꿀 수 있는 후보(전공 일치 교사)마다 그 수업의 모든 시간에 설 수 있는지 미리 본다
    TIMETABLE_VIEW.teacherOptions = null;
    const pickedId = timetableLessonAt(plainResult.layers?.[semester], TIMETABLE_VIEW.pick.class, slot);
    const pickedModel = pickedId ? inputs[semester].lessons.find((lesson) => lesson.id === pickedId) : null;
    if (pickedModel) {
      const item = plainResult.layers[semester].lessons[pickedId];
      const options = [...new Set([item.teacherId, ...pickedModel.candidates].filter(Boolean))].map((id) => {
        const current = id === item.teacherId;
        let outcome = { ok: true };
        if (!current) { try { outcome = timetableEditTeacher(inputs, plainResult, { semester, lessonId: pickedId, teacherId: id, before }); } catch (error) { outcome = { ok: false, reason: error?.message || String(error) }; } }
        return { id, name: inputs[semester].teacherOf.get(id)?.name || id, hours: timetableTeacherHours(plainResult.layers[semester], id), current, ok: current || outcome.ok, reason: outcome.ok ? "" : outcome.reason, more: outcome.ok && outcome.change ? outcome.change.hard : 0 };
      }).sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || (b.ok ? 1 : 0) - (a.ok ? 1 : 0) || a.hours - b.hours || a.name.localeCompare(b.name));
      TIMETABLE_VIEW.teacherOptions = { slot, lessonId: pickedId, classId: TIMETABLE_VIEW.pick.class, subject: pickedModel.subject, current: item.teacherId || "", fixed: Boolean(pickedModel.fixedTeacher) && !pickedModel.teacherPinned, options };
    }
    const able = Object.values(targets).filter((value) => value && typeof value === "object").length;
    const clean = Object.values(targets).filter((value) => value && typeof value === "object" && value.hard <= 0).length; // '반드시' 위반이 늘지 않는 칸
    const hint = able ? ` 초록 = '반드시' 위반이 늘지 않는 칸 ${clean}곳${able > clean ? `, 노랑 = 위반이 늘어나는 칸 ${able - clean}곳(칸에 늘어나는 수, 마우스를 올리면 내역)` : ""}.` : "";
    const pickedBlock = inputs[semester].blocks.find((block) => block.classIds.includes(TIMETABLE_VIEW.pick.class) && (plainResult.layers?.[semester]?.blocks?.[block.id]?.slots || []).includes(slot));
    TIMETABLE_VIEW.editStatus = pickedBlock
      ? (able ? `${slot} ${pickedBlock.label}을 옮길 수 있는 칸 ${able}곳을 표시했습니다. 옮길 칸을 누르세요 — 이 블록을 듣는 ${pickedBlock.classIds.length}개 반이 함께 옮겨지고, 그 칸의 반 수업은 ${slot}으로 옵니다(같은 칸을 다시 누르면 취소).${hint}`
        : `${slot} ${pickedBlock.label}은 지금 옮길 수 있는 칸이 없습니다(칸마다 이유는 마우스를 올리면 보입니다).`)
      : able ? `${slot}과 맞바꿀 수 있는 칸 ${able}곳을 표시했습니다. 바꿀 칸을 누르세요(같은 칸을 다시 누르면 취소).${hint}` : `${slot}은 지금 맞바꿀 수 있는 칸이 없습니다(칸마다 이유는 마우스를 올리면 보입니다).`;
    TIMETABLE_VIEW.editError = !able;
    renderTimetable();
    return;
  }
  const first = TIMETABLE_VIEW.editPick;
  TIMETABLE_VIEW.editPick = "";
  TIMETABLE_VIEW.editTargets = null;
  if (first === slot) { TIMETABLE_VIEW.editStatus = ""; renderTimetable(); return; }
  let outcome;
  try { outcome = timetableEditSwap(inputs, plainResult, { semester, classId: TIMETABLE_VIEW.pick.class, a: first, b: slot }); } catch (error) { outcome = { ok: false, reason: error?.message || String(error) }; }
  if (!outcome.ok) { TIMETABLE_VIEW.editStatus = `바꾸지 않았습니다 — ${outcome.reason}`; TIMETABLE_VIEW.editError = true; renderTimetable(); return; }
  TIMETABLE_VIEW.undo.push({ round, result: plainResult, text: outcome.text });
  if (TIMETABLE_VIEW.undo.length > 30) TIMETABLE_VIEW.undo.shift();
  state.timetable[round].result = outcome.result;
  TIMETABLE_VIEW.editStatus = `${outcome.block ? "블록을 옮겼습니다" : "맞바꿨습니다"} — ${outcome.text}${timetableChangeText(plainResult, outcome)}`;
  TIMETABLE_VIEW.editError = false;
  if (typeof persistStateSoon === "function") persistStateSoon();
  renderTimetable();
}

// 고른 칸의 반 수업을 그 칸에 고정하거나 고정을 푼다(다시 계산해도 그 자리에 둔다). settings.pins[학기][수업 id] = ['월3', …]
function timetablePinToggle() {
  const round = timetableRound();
  const saved = timetableSaved(round);
  const slot = TIMETABLE_VIEW.editPick;
  const semester = TIMETABLE_VIEW.semester;
  const classId = TIMETABLE_VIEW.pick.class;
  const id = saved && slot ? timetableLessonAt(saved.result.layers?.[semester], classId, slot) : "";
  if (!id) return;
  const settings = timetableSettingsEdit();
  const pins = JSON.parse(JSON.stringify(settings.pins || {}, typeof stateJsonReplacer === "function" ? stateJsonReplacer : undefined));
  const list = (pins[semester]?.[id] || []).slice();
  const had = list.includes(slot);
  const next = had ? list.filter((key) => key !== slot) : [...list, slot];
  if (!pins[semester]) pins[semester] = {};
  if (next.length) pins[semester][id] = next; else delete pins[semester][id];
  if (!Object.keys(pins[semester]).length) delete pins[semester];
  if (Object.keys(pins).length) settings.pins = pins; else delete settings.pins;
  TIMETABLE_VIEW.editPick = "";
  TIMETABLE_VIEW.editTargets = null;
  TIMETABLE_VIEW.editStatus = had ? `${classId}반 ${slot} 고정을 풀었습니다.` : `${classId}반 ${slot}을 고정했습니다 — 다시 계산해도 이 수업은 이 칸에 둡니다(담당 교사는 다시 정해질 수 있습니다).`;
  TIMETABLE_VIEW.editError = false;
  if (typeof persistStateSoon === "function") persistStateSoon();
  renderTimetable();
}

// 고른 반 수업의 담당 교사를 고른 교사로 바꾼다(그 반·그 과목의 모든 시간). 고른 값은 #timetableTeacherPick.
function timetableTeacherChange() {
  const round = timetableRound();
  const saved = timetableSaved(round);
  const box = TIMETABLE_VIEW.teacherOptions;
  const select = document.querySelector("#timetableTeacherPick");
  if (!saved || !box || !select || TIMETABLE_RUN) return;
  const semester = TIMETABLE_VIEW.semester;
  const inputs = {};
  for (const key of Object.keys(saved.result.layers || {})) inputs[key] = timetableModel(timetableInput(round, key).input);
  const plainResult = JSON.parse(JSON.stringify(saved.result, typeof stateJsonReplacer === "function" ? stateJsonReplacer : undefined));
  let outcome;
  try { outcome = timetableEditTeacher(inputs, plainResult, { semester, lessonId: box.lessonId, teacherId: select.value }); } catch (error) { outcome = { ok: false, reason: error?.message || String(error) }; }
  TIMETABLE_VIEW.editPick = "";
  TIMETABLE_VIEW.editTargets = null;
  TIMETABLE_VIEW.teacherOptions = null;
  if (!outcome.ok) { TIMETABLE_VIEW.editStatus = `바꾸지 않았습니다 — ${outcome.reason}`; TIMETABLE_VIEW.editError = true; renderTimetable(); return; }
  TIMETABLE_VIEW.undo.push({ round, result: plainResult, text: outcome.text });
  if (TIMETABLE_VIEW.undo.length > 30) TIMETABLE_VIEW.undo.shift();
  state.timetable[round].result = outcome.result;
  TIMETABLE_VIEW.editStatus = `담당 교사를 바꿨습니다 — ${outcome.text}${timetableChangeText(plainResult, outcome)}`;
  TIMETABLE_VIEW.editError = false;
  if (typeof persistStateSoon === "function") persistStateSoon();
  renderTimetable();
}

// 고른 반 수업의 지금 담당 교사를 고정하거나 고정을 푼다(다시 계산해도 그 반 그 과목은 그 교사). settings.teacherPins[학기][수업 id] = 교사 id
function timetableTeacherPinToggle() {
  const box = TIMETABLE_VIEW.teacherOptions;
  if (!box || !timetableSaved(timetableRound())) return;
  const semester = TIMETABLE_VIEW.semester;
  const settings = timetableSettingsEdit();
  const pins = JSON.parse(JSON.stringify(settings.teacherPins || {}, typeof stateJsonReplacer === "function" ? stateJsonReplacer : undefined));
  const had = Boolean(pins[semester]?.[box.lessonId]);
  if (!had && !box.current) return;
  if (had) delete pins[semester][box.lessonId];
  else { if (!pins[semester]) pins[semester] = {}; pins[semester][box.lessonId] = box.current; }
  if (pins[semester] && !Object.keys(pins[semester]).length) delete pins[semester];
  if (Object.keys(pins).length) settings.teacherPins = pins; else delete settings.teacherPins;
  const name = box.options.find((option) => option.id === box.current)?.name || box.current;
  TIMETABLE_VIEW.editPick = "";
  TIMETABLE_VIEW.editTargets = null;
  TIMETABLE_VIEW.teacherOptions = null;
  TIMETABLE_VIEW.editStatus = had ? `${box.classId}반 ${box.subject} 담당 교사 고정을 풀었습니다.` : `${box.classId}반 ${box.subject} 담당 교사를 ${name} 교사로 고정했습니다 — 다시 계산해도 이 반 이 과목은 이 교사가 맡습니다.`;
  TIMETABLE_VIEW.editError = false;
  if (typeof persistStateSoon === "function") persistStateSoon();
  renderTimetable();
}

function timetableEditUndo() {
  const last = TIMETABLE_VIEW.undo.pop();
  const round = timetableRound();
  if (!last || last.round !== round || !timetableSaved(round)) { TIMETABLE_VIEW.undo = []; renderTimetable(); return; }
  state.timetable[round].result = last.result;
  TIMETABLE_VIEW.editPick = "";
  TIMETABLE_VIEW.editTargets = null;
  TIMETABLE_VIEW.editStatus = `되돌렸습니다 — ${last.text}`;
  TIMETABLE_VIEW.editError = false;
  if (typeof persistStateSoon === "function") persistStateSoon();
  renderTimetable();
}

// 6단계 학생 시간표용: 내년 그 학년의 반마다 반 수업 칸 { 반 번호: { '월3': { text, teacher } } }.
// 시간표 결과가 없거나 바뀌기 전 것이거나, 그 학기 블록 자리가 6단계 블록 시간과 다르면(아직 적어 넣지 않음) null — 6단계는 지금처럼 빈칸으로 둔다.
function timetableStudentLessons(round, grade, semester) {
  const compute = () => {
    const saved = timetableSaved(round);
    const layer = saved?.result?.layers?.[String(semester)];
    if (!layer) return null;
    if (timetableCurrentSignature(round) !== saved.signature || !timetablePinsHeld(saved.result, timetableSettings().pins, timetableSettings().teacherPins)) return null;
    if (timetableBlockTimeChanges(round).some((change) => String(change.semester) === String(semester))) return null;
    const tables = timetableResultTables(timetableInput(round, String(semester)).input, layer);
    const out = {};
    for (const row of tables.classes) {
      if (String(row.grade) !== String(grade)) continue;
      const cells = {};
      for (const [key, entries] of Object.entries(row.cells)) {
        const lesson = entries.find((entry) => entry.kind === "lesson" || entry.kind === "creative");
        if (lesson) cells[key] = { text: lesson.text, teacher: lesson.noTeacher ? "" : lesson.teacher || "" };
      }
      out[String(row.id).split("-")[1]] = cells;
    }
    return out;
  };
  return typeof cachedByStateRevision === "function" ? cachedByStateRevision("timetableStudentLessons", `${round}|${grade}|${semester}`, compute) : compute();
}

// 저장된 계산 결과(차수). 없으면 null.
function timetableSaved(round = timetableRound()) {
  const saved = state.timetable?.[round];
  return saved && saved.result && saved.result.layers ? saved : null;
}

// 시간표 결과의 블록 자리와 6단계 블록 시간이 다른 블록(두 학기). 돌려주는 값: [{ semester, groupKey, letter, before, after }] (시간 글자 '월1,수2')
function timetableBlockTimeChanges(round = timetableRound()) {
  const saved = timetableSaved(round);
  if (!saved || typeof classSectionsEntry !== "function") return [];
  const order = (key) => "월화수목금토일".indexOf(key[0]) * 100 + Number(key.slice(1));
  const text = (list) => list.map((key) => String(key).replace(/[:\s]/g, "")).filter(Boolean).sort((a, b) => order(a) - order(b)).join(",");
  const changes = [];
  for (const [semester, layer] of Object.entries(saved.result.layers || {})) for (const [id, item] of Object.entries(layer.blocks || {})) {
    const cut = id.lastIndexOf("|");
    if (cut < 0) continue;
    const groupKey = id.slice(0, cut);
    const letter = id.slice(cut + 1);
    const entry = classSectionsEntry(round, groupKey, false);
    const block = entry?.sectionResult?.blocks?.find((row) => (row.letter || row.id) === letter);
    if (!block) continue;
    const after = text(item.slots || []);
    const typed = entry.blockTimes?.[letter];
    const before = text(typed !== undefined && typed !== "" ? String(typed).split(/[,\s/]+/) : (block.times || []).map((time) => (typeof time === "string" ? time : `${time.day}${time.period}`)));
    if (after && before !== after) changes.push({ semester, groupKey, letter, before, after });
  }
  return changes;
}

// 시간표가 정한 블록 자리를 6단계에 적어 넣는다: 블록 시간 입력 칸 + 저장된 분반 결과의 블록 시간 + (지금 결과가 최신이면) 결과 서명.
// 분반·학생 배정·분반 교사는 건드리지 않는다. 돌려주는 값: 바꾼 블록 수.
function timetableWriteBlockTimes(round = timetableRound()) {
  const changes = timetableBlockTimeChanges(round);
  const groups = typeof classSectionsSource === "function" ? classSectionsSource(round).groups || [] : [];
  const sign = (group, entry) => (group && typeof classSectionsSignature === "function" && typeof classSectionsBuildInput === "function" ? classSectionsSignature(classSectionsBuildInput(round, group, entry)) : null);
  const touched = new Map();
  for (const change of changes) {
    const entry = classSectionsEntry(round, change.groupKey, false);
    if (!touched.has(change.groupKey)) {
      const group = groups.find((item) => item.key === change.groupKey);
      let fresh = false;
      try { fresh = Boolean(group) && entry.sectionResult.signature === sign(group, entry); } catch { fresh = false; }
      touched.set(change.groupKey, { entry, group, fresh });
    }
    if (!entry.blockTimes || typeof entry.blockTimes !== "object") entry.blockTimes = {};
    entry.blockTimes[change.letter] = change.after;
    const block = entry.sectionResult.blocks.find((row) => (row.letter || row.id) === change.letter);
    block.times = change.after.split(",").filter(Boolean).map((key) => `${key[0]}:${key.slice(1)}`);
  }
  // 적기 전에 6단계 결과가 최신이었으면 적은 뒤에도 최신으로 둔다(블록 시간만 바뀌었고 그 자리는 시간표 검증을 통과한 값)
  for (const { entry, group, fresh } of touched.values()) if (fresh) { try { entry.sectionResult.signature = sign(group, entry); } catch { /* 서명을 못 만들면 6단계가 '입력 변경됨'으로 알린다 */ } }
  if (changes.length && typeof persistStateSoon === "function") persistStateSoon();
  return changes.length;
}

function timetableRunBarHtml(result, saved, stale) {
  const run = TIMETABLE_RUN;
  const blocked = result.counts.block > 0;
  if (run) {
    const { ratio, text } = timetableRunProgressText(run);
    return `<section class="tt-run" id="timetableRunBar" data-state="running"><div class="tt-run-progress" id="timetableRunProgress" role="status"><progress max="1" value="${ratio}"></progress> <span data-tt-run-text>${timetableEsc(text)}</span></div>
      <button class="button" type="button" id="timetableStop"${run.stopping ? " disabled" : ""}>중단하고 지금까지의 답 쓰기</button></section>`;
  }
  const note = blocked ? "없는 자료를 먼저 채워야 계산할 수 있습니다(아래 '계산 불가' 항목)."
    : saved ? (stale ? "조건이나 자료가 바뀌었습니다 — 아래 결과는 바뀌기 전 것입니다." : "아래 결과는 지금 조건·자료로 계산한 것입니다.")
      : result.counts.fail ? "조건을 다 지킬 수 없어도 계산은 됩니다 — 못 지킨 조건은 결과에 목록으로 나옵니다." : "두 학기를 함께 계산합니다(보통 1분 안, 길어도 3분).";
  return `<section class="tt-run" id="timetableRunBar" data-state="${blocked ? "blocked" : saved ? (stale ? "stale" : "done") : "idle"}">
    <button class="button primary" type="button" id="timetableRun"${blocked ? " disabled" : ""}>${saved ? "시간표 다시 계산" : "시간표 계산"}</button>
    ${saved && !stale && !blocked ? '<button class="button" type="button" id="timetableRunMore" title="지금 결과는 그대로 두고 다른 씨앗으로 한 번 더 계산합니다. 더 나은 답이 나올 때만 바꿉니다.">더 오래 계산(나아질 때만 바꿈)</button>' : ""}
    <span class="cs-note${stale ? " is-warn" : ""}" id="timetableRunNote">${timetableEsc(note)}</span></section>`;
}

function timetableGridHtml(tables, stale = false) {
  const view = TIMETABLE_VIEW.grid === "teacher" ? "teacher" : "class";
  const list = view === "teacher" ? tables.teachers : tables.classes;
  if (!list.length) return `<p class="cs-note" id="timetableGrid">표로 보여 줄 ${view === "teacher" ? "교사" : "반"}이 없습니다.</p>`;
  let picked = list.find((row) => row.id === TIMETABLE_VIEW.pick[view]) || list[0];
  TIMETABLE_VIEW.pick[view] = picked.id;
  const options = list.map((row) => `<option value="${timetableEsc(row.id)}"${row.id === picked.id ? " selected" : ""}>${timetableEsc(view === "teacher" ? `${row.name} (${row.hours}시간)` : `${row.id}반`)}</option>`).join("");
  const head = `<thead><tr><th></th>${tables.days.map((day) => `<th>${timetableEsc(day)}</th>`).join("")}</tr></thead>`;
  // 이 반에서 고정한 칸
  const pinsNow = timetableSettings().pins?.[TIMETABLE_VIEW.semester] || {};
  const pinnedSlots = new Set(view === "class" ? Object.entries(pinsNow).filter(([id]) => String(id.split("@")[1] || "").split("#")[0] === picked.id).flatMap(([, keys]) => keys) : []);
  const pinTotal = Object.values(timetableSettings().pins || {}).reduce((sum, lessons) => sum + Object.values(lessons || {}).reduce((count, keys) => count + keys.length, 0), 0);
  const pickedLesson = view === "class" && TIMETABLE_VIEW.editPick ? (picked.cells[TIMETABLE_VIEW.editPick] || []).find((entry) => entry.kind === "lesson") : null;
  // 고른 반 수업의 담당 교사 바꾸기·고정(후보 = 전공 일치 교사, 설 수 없는 교사는 이유와 함께 흐리게)
  const teacherPinsNow = timetableSettings().teacherPins || {};
  const teacherPinTotal = Object.values(teacherPinsNow).reduce((sum, lessons) => sum + Object.keys(lessons || {}).length, 0);
  const box = pickedLesson && !stale && TIMETABLE_VIEW.teacherOptions && TIMETABLE_VIEW.teacherOptions.slot === TIMETABLE_VIEW.editPick && TIMETABLE_VIEW.teacherOptions.classId === picked.id ? TIMETABLE_VIEW.teacherOptions : null;
  const boxPinned = box ? Boolean(teacherPinsNow[TIMETABLE_VIEW.semester]?.[box.lessonId]) : false;
  const short = (text) => (String(text).length > 46 ? `${String(text).slice(0, 45)}…` : String(text));
  const teacherBox = box ? `<span class="tt-teacher-box" id="timetableTeacherBox" data-lesson="${timetableEsc(box.lessonId)}" data-pinned="${boxPinned ? "1" : "0"}"><label>${timetableEsc(box.subject)} 담당 교사
      <select id="timetableTeacherPick" aria-label="${timetableEsc(`${picked.id}반 ${box.subject} 담당 교사`)}"${box.fixed || boxPinned ? " disabled" : ""}>${box.options.map((option) => `<option value="${timetableEsc(option.id)}"${option.current ? " selected" : ""}${option.ok ? "" : " disabled"} data-ok="${option.ok ? "1" : "0"}" title="${timetableEsc(option.reason)}">${timetableEsc(`${option.name} · 주 ${option.hours}시간${option.current ? "(지금)" : option.ok ? (option.more > 0 ? ` — '반드시' 위반 +${option.more}` : option.more < 0 ? ` — '반드시' 위반 −${-option.more}` : "") : ` — ${short(option.reason)}`}`)}</option>`).join("")}<option value=""${box.current ? "" : " selected"}>담당 교사 없음</option></select></label>
      <button class="button" type="button" id="timetableTeacherChange"${box.fixed || boxPinned ? ` disabled title="${box.fixed ? "6단계·5단계에서 정한 교사입니다" : "교사 고정을 푼 뒤 바꾸세요"}"` : ""}>담당 교사 바꾸기</button>
      <button class="button" type="button" id="timetableTeacherPin" data-pinned="${boxPinned ? "1" : "0"}"${box.fixed || (!box.current && !boxPinned) ? " disabled" : ""}>${boxPinned ? "교사 고정 풀기" : "이 교사로 고정"}</button></span>` : "";
  // 고칠 칸을 고른 뒤: 옮길 수 있는 칸(초록 = '반드시' 위반이 늘지 않음, 노랑 = n건 늘어남 + 칸에 '+n')과 안 되는 칸(이유)
  const targetAttrs = (target) => {
    if (!target || typeof target !== "object") return ` data-tt-can="0" title="${timetableEsc(target || "")}"`;
    const parts = target.parts.length ? `(${target.parts.join(", ")})` : "";
    const title = target.hard > 0 ? `여기로 옮기면 '반드시' 위반이 ${target.hard}건 늘어납니다${parts}` : target.hard < 0 ? `여기로 옮기면 '반드시' 위반이 ${-target.hard}건 줄어듭니다${parts}` : `여기로 옮겨도 '반드시' 위반 수는 그대로입니다${parts}`;
    return ` data-tt-can="1" data-tt-change="${target.hard}"${target.hard > 0 ? ' data-tt-more="1"' : ""} title="${timetableEsc(title)}"`;
  };
  const targetBadge = (target) => (target && typeof target === "object" && target.hard ? `<span class="tt-change-badge" data-sign="${target.hard > 0 ? "more" : "less"}">${target.hard > 0 ? "+" : "−"}${Math.abs(target.hard)}</span>` : "");
  const cellHtml = (entries, sub) => (entries || []).map((entry) => `<span class="tt-cell-entry" data-kind="${timetableEsc(entry.kind || "lesson")}"${entry.noTeacher ? ' data-no-teacher="1"' : ""}><strong>${timetableEsc(entry.text)}</strong>${sub(entry) ? `<small>${timetableEsc(sub(entry))}</small>` : ""}</span>`).join("");
  let body = "";
  if (view === "class") {
    body = picked.rows.map((row) => (row.lunch ? `<tr class="tt-lunch"><th>점심</th><td colspan="${tables.days.length}"></td></tr>`
      : `<tr><th>${row.period}</th>${tables.days.map((day) => { const entries = picked.cells[`${day}${row.period}`]; const key = `${day}${row.period}`; return `<td data-tt-slot="${timetableEsc(key)}"${entries && entries.length > 1 ? ' data-clash="1"' : ""}${stale ? "" : ` data-tt-edit="${timetableEsc(key)}"${TIMETABLE_VIEW.editPick && TIMETABLE_VIEW.editTargets && key !== TIMETABLE_VIEW.editPick ? targetAttrs(TIMETABLE_VIEW.editTargets[key]) : ""} role="button" tabindex="0"${pinnedSlots.has(key) ? ' data-tt-pinned="1"' : ""} aria-pressed="${TIMETABLE_VIEW.editPick === key}" aria-label="${timetableEsc(`${day}요일 ${row.period}교시 ${(entries || []).map((entry) => entry.text).join(", ") || "빈칸"}`)}"`}>${cellHtml(entries, (entry) => (entry.noTeacher ? "담당 교사 없음" : entry.teacher))}${pinnedSlots.has(key) ? '<span class="tt-pin">고정</span>' : ""}${TIMETABLE_VIEW.editPick && TIMETABLE_VIEW.editTargets && key !== TIMETABLE_VIEW.editPick ? targetBadge(TIMETABLE_VIEW.editTargets[key]) : ""}</td>`; }).join("")}</tr>`)).join("");
  } else {
    body = tables.teacherRows.map((row) => `<tr><th>${timetableEsc(row.label)}</th>${tables.days.map((day, d) => `<td data-tt-slot="${d}|${row.pos}">${cellHtml(picked.cells[`${d}|${row.pos}`], (entry) => entry.where)}</td>`).join("")}</tr>`).join("");
  }
  return `<div class="tt-grid-tools"><span class="tt-presets" id="timetableGridTabs"><button class="button" type="button" data-tt-view="class" aria-pressed="${view === "class"}">반 시간표</button><button class="button" type="button" data-tt-view="teacher" aria-pressed="${view === "teacher"}">교사 시간표</button></span>
    <label>${view === "teacher" ? "교사" : "반"} <select id="timetableGridPick" data-tt-pick="${view}" data-focus-key="tt-grid-pick">${options}</select></label>
    <button class="button" type="button" id="timetablePrintOne"${stale ? " disabled" : ""}>이 ${view === "teacher" ? "교사" : "반"} 인쇄</button>
    <button class="button" type="button" id="timetablePrintAll"${stale ? " disabled" : ""}>${view === "teacher" ? "교사" : "반"} 전체 인쇄(${list.length}${view === "teacher" ? "명" : "개 반"})</button>
    <button class="button" type="button" id="timetableDownload"${stale ? ' disabled title="다시 계산한 뒤 내려받으세요"' : ""}>엑셀로 내려받기(학급·교사 전체 시간표)</button></div>
    ${view === "class" && !stale ? `<p class="cs-note" id="timetableEditHelp">직접 고치기: 칸을 누르면 맞바꿀 수 있는 칸이 초록으로 표시됩니다 — 그 칸을 누르면 두 칸을 맞바꿉니다. 블록 칸을 누르면 그 블록 한 시간을 옮길 수 있는 칸이 표시되고, 옮기면 그 블록을 듣는 모든 반이 함께 옮겨집니다(그 칸의 반 수업은 블록 자리로, 같은 반들의 다른 블록과는 자리 맞바꿈). 창체 칸, 교사가 그 시간에 다른 반에 있는 칸은 안 되고 이유는 칸에 마우스를 올리면 보입니다. 반 수업 칸을 고르면 그 수업의 담당 교사를 전공이 맞는 다른 교사로 바꾸거나 지금 교사로 고정할 수 있습니다.
      <button class="button" type="button" id="timetableEditUndo"${TIMETABLE_VIEW.undo.length ? "" : " disabled"}>고친 것 되돌리기${TIMETABLE_VIEW.undo.length ? `(${TIMETABLE_VIEW.undo.length})` : ""}</button>
      ${pickedLesson ? `<button class="button" type="button" id="timetablePin" data-pinned="${pinnedSlots.has(TIMETABLE_VIEW.editPick) ? "1" : "0"}">${pinnedSlots.has(TIMETABLE_VIEW.editPick) ? `${timetableEsc(TIMETABLE_VIEW.editPick)} 고정 풀기` : `${timetableEsc(TIMETABLE_VIEW.editPick)} ${timetableEsc(pickedLesson.text)} 이 칸에 고정`}</button>` : ""}
      ${teacherBox}
      ${pinTotal ? `<span id="timetablePinCount" data-count="${pinTotal}">고정 ${pinTotal}칸(다시 계산해도 그 자리)</span>` : ""}${teacherPinTotal ? ` <span id="timetableTeacherPinCount" data-count="${teacherPinTotal}">교사 고정 ${teacherPinTotal}개(다시 계산해도 그 교사)</span>` : ""}
      ${pinTotal || teacherPinTotal ? ` <button class="button" type="button" id="timetablePinsClear">고정 모두 풀기</button>` : ""}</p>` : ""}
    ${TIMETABLE_VIEW.editStatus ? `<p class="tt-status${TIMETABLE_VIEW.editError ? " is-error" : ""}" id="timetableEditStatus" role="status">${timetableEsc(TIMETABLE_VIEW.editStatus)}</p>` : ""}
    <div class="table-wrap"><table class="tt-table tt-grid" id="timetableGrid" data-view="${view}" data-id="${timetableEsc(picked.id)}">${head}<tbody>${body}</tbody></table></div>`;
}

// 계산 결과 영역: 요약 → 남은 위반 → 담당 교사 없음 → 알림 → 반·교사 표. 고른 학기 것만 보여 준다.
// 결과 요약에 붙이는 '구조상 하한' 줄(순수): 사전 점검이 계산한 '피할 수 없는 수'(timetableLowerBounds)를 이 학기 결과의 실제 수와 나란히.
// 돌려주는 값: [{ kind: 'noTeacher' | 'gap' | 'squeeze', grade?, actual, min, text }] — 하한이 0이거나 실제 수가 0인 줄은 내지 않는다.
function timetableBoundLines(bounds, result, semester) {
  if (!bounds || !result) return [];
  const mine = (item) => String(item.semester) === String(semester);
  const amount = (list) => list.reduce((sum, item) => sum + (Number(item.amount ?? item.hours) || 0), 0);
  const violations = (result.violations || []).filter(mine);
  const noTeacher = (result.noTeacher || []).filter(mine);
  const lines = [];
  const rest = (actual, min) => (min >= actual ? "모두" : `그중 ${min}`);
  const noTeacherHours = amount(noTeacher);
  if (bounds.noTeacher > 0 && noTeacherHours > 0) {
    const min = Math.min(bounds.noTeacher, noTeacherHours);
    lines.push({ kind: "noTeacher", actual: noTeacherHours, min, text: `담당 교사 없음 ${noTeacherHours}시간 — ${rest(noTeacherHours, min)}${min >= noTeacherHours ? "" : "시간은"} 지금 명단·조건에서 피할 수 없습니다(맡을 교사가 명단에 없거나, 교사가 설 수 있는 시간·칸이 모자람).` });
  }
  const gaps = amount(violations.filter((item) => item.rule === "gap"));
  if (bounds.gap > 0 && gaps > 0) {
    const min = Math.min(bounds.gap, gaps);
    lines.push({ kind: "gap", actual: gaps, min, text: `공강 ${gaps}칸 — ${rest(gaps, min)}${min >= gaps ? "" : "칸은"} 정해진 블록·창체 시간 사이에 낀 칸이라 피할 수 없습니다.` });
  }
  for (const item of bounds.squeeze || []) {
    const inGrade = (id) => String(id).startsWith(`${item.grade}-`);
    const none = amount(noTeacher.filter((row) => row.kind === "lesson" && String(row.grade) === item.grade));
    const gap = amount(violations.filter((row) => row.rule === "gap" && inGrade(row.id)));
    const twice = amount(violations.filter((row) => row.rule === "oncePerDay" && inGrade(row.id)));
    const actual = none + gap + twice;
    if (!actual) continue;
    const min = Math.min(item.short, actual);
    lines.push({ kind: "squeeze", grade: item.grade, actual, min, text: `${item.grade}학년 반 수업 ${item.need}시간 가운데 공강 없이·하루 한 번을 지키며 넣을 수 있는 것은 ${item.capacity}시간 — 나머지 ${item.short}시간은 담당 교사 없음·공강·하루 두 번 가운데 하나가 될 수밖에 없습니다(지금 ${actual}: 담당 교사 없음 ${none} + 공강 ${gap} + 하루 두 번 ${twice} — ${rest(actual, min)}${min >= actual ? "" : "은"} 피할 수 없음).` });
  }
  return lines;
}

// 계산 뒤 선택지 목록(순수): 남은 '반드시' 위반의 규칙 → 선택지 이름(조건이 이미 그 값이면 뺌) + 과목별 '2시간 연속 수업 허용'.
// 두 학기 같은 칸(뼈대 hard) 결과에 교사 점심·연강이 남아 있으면 '블록 순서를 학기마다 다르게 허용'을 맨 앞에 추천으로 둔다
// (학기마다 블록 분반 교사가 달라 같은 칸에서는 남기 쉬운 위반 — 실제 자료에서 이 선택으로 풀렸다).
// 돌려주는 값: { keys: [선택지 이름…], recommended: 추천 선택지 이름 | "", lunch: 점심 위반 수, run: 연강 위반 수 }
function timetableResultChoiceKeys(result, settings, prepared) {
  const keys = [];
  const hard = (result?.violations || []).filter((entry) => entry.level === "hard");
  for (const item of hard) for (const key of TIMETABLE_RESULT_CHOICES[item.rule] || []) {
    const choice = TIMETABLE_CHOICES[key];
    if (choice?.patch && !keys.includes(key) && !(choice.skip && choice.skip(settings, prepared))) keys.push(key);
  }
  // 같은 수업이 하루 두 번인 과목, 교사 시간이 모자라 담당 교사가 없는 반 수업 과목 → '그 과목 2시간 연속 수업 허용'
  const doubleSubjects = new Set();
  for (const item of hard) if (item.rule === "oncePerDay") for (const subject of item.subjects || []) doubleSubjects.add(subject);
  for (const item of (result?.noTeacher || [])) if (item.kind === "lesson" && item.reason === "capacity") doubleSubjects.add(item.subject);
  for (const subject of doubleSubjects) { const key = `double:${subject}`; if (!timetableChoiceOf(key).skip(settings) && keys.length < 12) keys.push(key); }
  const amount = (rule) => hard.filter((item) => item.rule === rule).reduce((sum, item) => sum + (Number(item.amount) || 1), 0);
  const lunch = amount("lunch");
  const run = amount("run");
  let recommended = "";
  if (keys.includes("frameOrder") && result?.metrics?.frameMode === "hard" && lunch + run > 0) {
    keys.splice(keys.indexOf("frameOrder"), 1);
    keys.unshift("frameOrder");
    recommended = "frameOrder";
  }
  return { keys, recommended, lunch, run };
}

function timetableResultHtml(saved, stale, semester, prepared, precheck) {
  if (!saved) return "";
  const result = saved.result;
  const metrics = result.metrics || {};
  const layer = result.layers?.[semester];
  const violations = (result.violations || []).filter((item) => String(item.semester) === semester);
  const hard = violations.filter((item) => item.level === "hard");
  const soft = violations.filter((item) => item.level !== "hard");
  const count = (list) => list.reduce((sum, item) => sum + (Number(item.amount) || 1), 0);
  const noTeacher = (result.noTeacher || []).filter((item) => String(item.semester) === semester);
  const noTeacherHours = noTeacher.reduce((sum, item) => sum + (Number(item.hours) || 0), 0);
  const when = new Date(saved.at);
  const time = Number.isNaN(when.getTime()) ? "" : `${when.getMonth() + 1}월 ${when.getDate()}일 ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  const summary = `<p class="tt-verdict" id="timetableResultSummary" data-state="${count(hard) || noTeacherHours ? "fail" : "ok"}" data-hard="${count(hard)}" data-no-teacher="${noTeacherHours}" role="status">
    <strong>${semester}학기 — ${count(hard) ? `'반드시' 조건을 못 지킨 곳 ${count(hard)}건` : "'반드시' 조건을 모두 지켰습니다"} · 담당 교사 없음 ${noTeacherHours}시간</strong>
    <span class="cs-note">'최대한' 조건 ${count(soft)}건${metrics.frame ? ` · 두 학기 같은 자리 ${metrics.frameActs}묶음${metrics.frameBroken ? `(벗어난 칸 ${metrics.frameBroken})` : ""}` : ""}${metrics.blockTimesChanged ? ` · 6단계 블록 시간과 다른 블록 ${metrics.blockTimesChanged}개` : ""}
      · ${timetableEsc(time)} 계산(${saved.seconds}초, ${saved.tried}개 중 가장 좋은 답${saved.stopped ? ", 중단함" : ""})${result.edits ? ` · <span id="timetableEdits" data-count="${result.edits}">직접 고침 ${result.edits}번</span>` : ""}</span></p>`;
  // 구조상 하한: 사전 점검이 계산한 '지금 조건에서 피할 수 없는 수'를 실제 수와 나란히(바뀌기 전 결과에는 붙이지 않는다)
  let boundLines = [];
  if (!stale && precheck && typeof timetableLowerBounds === "function") { try { boundLines = timetableBoundLines(timetableLowerBounds(precheck), result, semester); } catch { boundLines = []; } }
  const boundsHtml = boundLines.length ? `<ul class="tt-bounds" id="timetableBounds">${boundLines.map((line) => `<li data-bound="${line.kind}"${line.grade ? ` data-grade="${timetableEsc(line.grade)}"` : ""} data-actual="${line.actual}" data-min="${line.min}">${timetableEsc(line.text)}</li>`).join("")}</ul>` : "";
  const previous = saved.previous;
  const compare = previous ? `<p class="cs-note" id="timetableResultCompare" data-hard-before="${previous.hard}" data-hard-after="${metrics.hard}">앞 결과와 견줌(두 학기 합계): '반드시' 조건 ${previous.hard} → ${metrics.hard}건 · 담당 교사 없음 ${previous.noTeacherHours} → ${metrics.noTeacherHours}시간${saved.choice ? ` — 고른 선택: ${timetableEsc(saved.choice)}` : ""}</p>` : "";
  // '더 오래 계산'의 결과 한 줄: 바꿨는지, 그대로 뒀는지
  const more = saved.more;
  const moreHtml = more ? `<p class="cs-note" id="timetableMore" data-replaced="${more.replaced ? "1" : "0"}" data-tried="${more.tried}">더 오래 계산(씨앗 ${more.seeds[0]}~${more.seeds[1]}, ${more.tried}개, ${more.seconds}초${more.stopped ? ", 중단함" : ""}): ${more.replaced
    ? `더 나은 답으로 바꿨습니다 — '반드시' ${more.from.hard} → ${more.hard}건 · 담당 교사 없음 ${more.from.noTeacherHours} → ${more.noTeacherHours}시간(두 학기 합계)`
    : `더 나은 답이 없어 지금 결과를 그대로 뒀습니다(새로 나온 가장 좋은 답: '반드시' ${more.hard}건 · 담당 교사 없음 ${more.noTeacherHours}시간)`}</p>` : "";
  const tries = Array.isArray(saved.tries) ? saved.tries.filter((item) => !item.failed) : [];
  const triesHtml = tries.length > 1 ? `<p class="cs-note" id="timetableTries" data-best="${result.seed}">함께 푼 ${tries.length}개의 '반드시' 위반(두 학기 합계): ${tries.map((item) => `<span data-seed="${item.seed}" data-hard="${item.hard}"${item.seed === result.seed ? ' data-picked="1"' : ""}>${item.seed === result.seed ? "<strong>" : ""}씨앗 ${item.seed}${item.long ? "(길게)" : ""} ${item.hard}건${item.seed === result.seed ? " ← 고른 답</strong>" : ""}</span>`).join(" · ")}</p>` : "";
  const invalid = saved.validation && !saved.validation.ok ? `<div class="cs-note is-warn" id="timetableValidation">결과 검증에서 오류 ${saved.validation.errors.length}건 — 이 결과는 쓰지 말고 다시 계산하세요: ${timetableEsc(saved.validation.errors.slice(0, 3).map((item) => item.text).join(" / "))}</div>` : "";
  const violationList = (list, limit) => list.slice(0, limit).map((item) => `<li class="tt-issue" data-tt-violation="${timetableEsc(item.rule)}" data-level="${timetableEsc(item.level)}"><span class="tt-level" data-level="${item.level === "hard" ? "fail" : "warn"}">${timetableEsc(TIMETABLE_VIOLATION_LABELS[item.rule] || item.rule)}</span>
    <span class="tt-cause">${timetableEsc(item.cause)}</span></li>`).join("");
  // 남은 '반드시' 위반(두 학기 모두)에 맞는 선택지 — 고르면 조건을 바꾸고 바로 다시 계산
  const settings = timetableSettings();
  const picks = timetableResultChoiceKeys(result, settings, prepared);
  const choiceKeys = picks.keys;
  const recommendNote = picks.recommended ? `두 학기 같은 칸에서는 ${[picks.lunch ? `교사 점심 ${picks.lunch}건` : "", picks.run ? `연강 ${picks.run}건` : ""].filter(Boolean).join("·")}이 남았습니다 — 학기마다 블록 분반 교사가 달라 같은 칸에서는 남기 쉬운 위반이고, 블록 순서만 학기마다 다르게 두면 풀리는 경우가 많습니다. ` : "";
  const choicesHtml = choiceKeys.length && !stale ? `<div class="tt-choices" id="timetableResultChoices"${picks.recommended ? ` data-recommended="${timetableEsc(picks.recommended)}"` : ""}><span class="tt-choices-title">선택지(무엇을 양보할지 고르세요 — 고르면 그 조건으로 다시 계산합니다)</span><ul>${choiceKeys.map((key) => `<li data-tt-choice-row="${timetableEsc(key)}" data-kind="setting"${key === picks.recommended ? ' data-recommended="1"' : ""}>
    ${key === picks.recommended ? '<span class="tt-level tt-recommend" data-level="info">추천</span> ' : ""}<strong>${timetableEsc(timetableChoiceOf(key).label)}</strong> <button class="button" type="button" data-tt-choice-solve="${timetableEsc(key)}">이 선택으로 다시 계산</button><span class="tt-gives">${key === picks.recommended ? timetableEsc(recommendNote) : ""}${timetableEsc(timetableChoiceOf(key).gives)}</span></li>`).join("")}</ul></div>` : "";
  const violationHtml = violations.length || choicesHtml ? `<section class="cs-card" id="timetableViolations" data-hard="${count(hard)}" data-soft="${count(soft)}"><h4>못 지킨 조건 <span class="cs-note">'반드시' ${count(hard)}건 · '최대한' ${count(soft)}건 — 조건을 바꾸려면 ${timetableWhereButtons([{ key: "rules", step: 6, label: "7단계 규칙" }])}</span></h4>
    <ul class="tt-issues">${violationList(hard, 60)}</ul>${choicesHtml}${soft.length ? `<details class="tt-section" data-tt-section="soft"${TIMETABLE_VIEW.open.soft ? " open" : ""}><summary><strong>'최대한' 조건 ${count(soft)}건</strong></summary><ul class="tt-issues">${violationList(soft, 80)}</ul></details>` : ""}</section>` : "";
  // 다른 교과 교사가 맡을 수 있는 교과(교양)의 수업이면 5단계 '담당 교과'로 바로 가는 단추
  const departmentOf = new Map();
  for (const lesson of prepared.input.lessons || []) departmentOf.set(lesson.subject, lesson.department || "");
  for (const block of prepared.input.blocks || []) for (const section of block.sections || []) if (!departmentOf.has(section.subject)) departmentOf.set(section.subject, section.department || "");
  const openDepartments = new Set(prepared.openDepartments || []);
  const groups = new Map();
  for (const item of noTeacher) {
    const key = `${item.grade}|${item.subject}|${item.reason}`;
    if (!groups.has(key)) groups.set(key, { grade: item.grade, subject: item.subject, reason: item.reason, hours: 0, where: [] });
    const group = groups.get(key);
    group.hours += Number(item.hours) || 0;
    if (item.classId && !group.where.includes(item.classId)) group.where.push(item.classId);
  }
  const noTeacherHtml = noTeacher.length ? `<section class="cs-card" id="timetableNoTeacher" data-hours="${noTeacherHours}"><h4>담당 교사 없음 ${noTeacherHours}시간 <span class="cs-note">반 시간표에는 자리가 잡혀 있고, 맡을 교사만 비어 있습니다.</span></h4>
    <ul class="tt-issues">${[...groups.values()].map((group) => `<li class="tt-issue" data-tt-no-teacher="${timetableEsc(group.subject)}"><span class="tt-level" data-level="fail">${group.hours}시간</span>
      <span class="tt-cause">${timetableEsc(group.grade)}학년 ${timetableEsc(group.subject)} — ${timetableEsc(group.where.join(", "))} (${timetableEsc(TIMETABLE_NO_TEACHER_REASONS[group.reason] || group.reason)})</span>
      ${openDepartments.has(departmentOf.get(group.subject)) ? `<span class="tt-where" data-tt-open-department="${timetableEsc(departmentOf.get(group.subject))}">${timetableEsc(departmentOf.get(group.subject))} 과목은 다른 교과 교사가 맡을 수 있습니다 — 맡을 교과 고르기 ${timetableWhereButtons([timetableWhere("hours", "과목별 상세 · 담당 교과")])}</span>` : ""}</li>`).join("")}</ul></section>` : "";
  const notes = (result.notes || []).filter((note) => !/^[12]학기/.test(note) || note.startsWith(`${semester}학기`));
  const notesHtml = notes.length ? `<section class="cs-card" id="timetableNotes"><h4>알림 ${notes.length}건</h4><ul class="tt-issues">${notes.slice(0, 30).map((note) => `<li class="tt-issue"><span class="tt-level" data-level="info">알림</span><span class="tt-cause">${timetableEsc(note)}</span></li>`).join("")}</ul></section>` : "";
  let grid = "";
  try { grid = layer ? timetableGridHtml(timetableResultTables(prepared.input, layer), stale) : ""; } catch (error) { grid = `<p class="cs-note is-warn">표를 그리지 못했습니다: ${timetableEsc(error?.message || error)}</p>`; }
  let blockChanges = [];
  try { blockChanges = timetableBlockTimeChanges(); } catch { blockChanges = []; }
  const hasBlocks = Object.values(result.layers || {}).some((item) => Object.keys(item.blocks || {}).length);
  const blockNote = !hasBlocks ? "" : blockChanges.length
    ? `<p class="cs-note" id="timetableBlockNote" data-count="${blockChanges.length}">시간표가 정한 블록 자리가 6단계 블록 시간과 다른 블록 ${blockChanges.length}개(두 학기).
      <button class="button" type="button" id="timetableWriteBlockTimes"${stale ? " disabled" : ""}>6단계 블록 시간에 적어 넣기</button> 분반·학생 배정·분반 교사는 그대로이고, 6단계 블록 시간 칸과 출력물(교실 카드·학생 시간표)의 요일·교시만 바뀝니다.</p>`
    : '<p class="cs-note" id="timetableBlockNote" data-count="0">6단계 블록 시간과 시간표의 블록 자리가 같습니다.</p>';
  return `<section class="cs-card tt-result" id="timetableResult" data-stale="${stale ? "1" : "0"}"><h4>계산 결과${stale ? ' <span class="cs-note is-warn" id="timetableResultStale">조건·자료가 바뀌기 전 결과</span>' : ""}</h4>${summary}${boundsHtml}${compare}${moreHtml}${triesHtml}${invalid}${grid}${blockNote}</section>${violationHtml}${noTeacherHtml}${notesHtml}`;
}

function renderTimetableView() {
  const body = document.getElementById("timetableBody");
  if (!body) return;
  const round = timetableRound();
  const semester = TIMETABLE_VIEW.semester;
  for (const button of document.querySelectorAll("#timetableSemesterTabs [data-tt-semester]")) button.setAttribute("aria-pressed", String(button.dataset.ttSemester === semester));
  let prepared;
  let result;
  try {
    prepared = timetableInput(round, semester);
    result = timetablePrecheck(prepared.input);
  } catch (error) {
    body.innerHTML = `<p class="cs-note is-warn" id="timetableError">시간표 자료를 모으지 못했습니다: ${timetableEsc(error?.message || error)}</p>`;
    return;
  }
  const badge = document.getElementById("timetableRoundBadge");
  if (badge) badge.textContent = `${round}차 · ${prepared.year}학년도 ${semester}학기`;
  if (TIMETABLE_VIEW.change && TIMETABLE_VIEW.before && TIMETABLE_VIEW.before.semester === semester) {
    TIMETABLE_VIEW.changeInfo = { label: TIMETABLE_VIEW.change, ...timetableIssueChanges(TIMETABLE_VIEW.before.issues, result.issues) };
  }
  TIMETABLE_VIEW.change = "";
  TIMETABLE_VIEW.before = null;
  TIMETABLE_VIEW.prepared = prepared;
  TIMETABLE_VIEW.result = result;
  const settings = timetableSettings();
  const preview = (key) => {
    try { return timetablePrecheck(timetableInputCompute(String(round), semester, prepared.year, timetableChoiceOf(key).patch(settings, prepared)).input); } catch { return null; }
  };
  const choices = timetableChoicesFor(result, prepared, settings, preview);
  const saved = timetableSaved(round);
  let stale = false;
  if (saved && !TIMETABLE_RUN) { try { stale = timetableCurrentSignature(round) !== saved.signature || !timetablePinsHeld(saved.result, settings.pins, settings.teacherPins); } catch { stale = true; } }
  const status = TIMETABLE_VIEW.runStatus ? `<p class="tt-status${TIMETABLE_VIEW.runError ? " is-error" : ""}" id="timetableRunStatus" role="status">${timetableEsc(TIMETABLE_VIEW.runStatus)}</p>` : "";
  body.innerHTML = `${timetableVerdictHtml(result)}${timetableRunBarHtml(result, saved, stale)}${status}${timetableChangeHtml(TIMETABLE_VIEW.changeInfo)}${timetableResultHtml(saved, stale, semester, prepared, result)}${timetableConditionsHtml(prepared)}${timetableIssuesHtml(result, choices)}${timetableAssumptionsHtml(prepared)}${timetableGradesHtml(result)}`;
}

// 조건 한 칸을 저장한다. 돌려주는 값: 바꾼 것 이름(화면의 '방금 바꾼 조건'), 못 쓰는 값이면 ""(상태 줄에 이유).
function timetableApplyField(field, target) {
  const settings = timetableSettingsEdit();
  const fail = (text) => { TIMETABLE_VIEW.status = text; TIMETABLE_VIEW.statusError = true; return ""; };
  const whole = (min, max) => { const value = Math.floor(Number(target.value)); return String(target.value).trim() !== "" && Number.isFinite(value) && value >= min && value <= max ? value : null; };
  const [name, ...rest] = field.split(":");
  const key = rest.join(":");
  if (name === "period") {
    const value = whole(1, 12);
    if (value === null) return fail("교시 수는 1~12 사이 숫자로 넣어 주세요.");
    settings.periodsByDay = { ...(settings.periodsByDay || {}), [key]: value };
    return `${key}요일 ${value}교시`;
  }
  if (name === "lunch") {
    const value = whole(1, 11);
    if (value === null) return fail("점심은 몇 교시 뒤인지 숫자로 넣어 주세요.");
    settings.lunchAfter = { ...TIMETABLE_DEFAULT_LUNCH, ...(settings.lunchAfter || {}), [key]: value };
    return `${key}학년 점심 ${value}교시 뒤`;
  }
  if (name === "venue") {
    const venues = { ...(settings.venues || {}) };
    if (String(target.value).trim() === "") delete venues[key];
    else { const value = whole(0, 20); if (value === null) return fail("동시에 수업할 수 있는 반 수를 숫자로 넣어 주세요."); venues[key] = value; }
    settings.venues = venues;
    return `${key} 장소 ${venues[key] ?? "점검 안 함"}`;
  }
  if (name === "open") {
    const current = Array.isArray(settings.openDepartments) ? settings.openDepartments.map(String) : ["교양"];
    const next = target.checked ? [...new Set([...current, key])] : current.filter((id) => id !== key);
    if (next.length === 1 && next[0] === "교양") delete settings.openDepartments; else settings.openDepartments = next;
    return `다른 교과 교사가 맡을 수 있는 교과: ${next.length ? next.join(", ") : "없음"}`;
  }
  if (name === "stagger") {
    const text = String(target.value ?? "").trim();
    const total = (TIMETABLE_VIEW.prepared?.input.grades || []).find((item) => String(item.grade) === key)?.classes || 0;
    const groups = { ...(settings.staggerGroups || {}) };
    if (!text) delete groups[key];
    else if (!timetableStaggerGroups(text, key, total)) return fail(`${key}학년 반 묶음은 '1-6/7-11'처럼 겹치지 않는 묶음 둘 이상으로 적어 주세요(1~${total}반).`);
    else groups[key] = text;
    if (Object.keys(groups).length) settings.staggerGroups = groups; else delete settings.staggerGroups;
    return `${key}학년 반 묶음 → ${text || "앞·뒤 절반"}`;
  }
  if (name === "double") {
    const subject = key;
    const list = (Array.isArray(settings.doubleSubjects) ? settings.doubleSubjects : []).filter((item) => item !== subject);
    if (target.checked) list.push(subject);
    if (list.length) settings.doubleSubjects = list; else delete settings.doubleSubjects;
    return `'${subject}' 2시간 연속 수업 ${target.checked ? "허용" : "허용 안 함"}`;
  }
  if (name === "blocks.keep") {
    if (target.checked) settings.keepBlockTimes = true; else delete settings.keepBlockTimes;
    return target.checked ? "6단계 블록 시간 그대로 지키기" : "블록 시간을 시간표가 정하기";
  }
  if (name.startsWith("rules.")) {
    const rule = name.slice(6);
    const spec = TIMETABLE_RULE_FIELDS.find((item) => item.key === rule);
    if (!spec) return "";
    let value;
    if (spec.level) value = (spec.levels || TIMETABLE_LEVELS).some(([level]) => level === target.value) ? target.value : null;
    else value = whole(spec.min, spec.max);
    if (value === null) return fail(`${spec.label}: ${spec.min}~${spec.max} 사이 숫자로 넣어 주세요.`);
    const rules = { ...(settings.rules || {}) };
    const [head, tail] = rule.split(".");
    if (tail) {
      const inner = { ...(rules[head] || {}), [tail]: value };
      if (value === timetableRuleDefault(rule)) delete inner[tail];
      if (Object.keys(inner).length) rules[head] = inner; else delete rules[head];
    } else if (value === timetableRuleDefault(rule)) delete rules[rule];
    else rules[rule] = value;
    settings.rules = rules;
    return `${spec.label} → ${spec.level ? (spec.levels || TIMETABLE_LEVELS).find(([level]) => level === value)[1] : value}`;
  }
  if (name === "creativeFrom") {
    const value = whole(1, 12);
    if (value === null) return fail("창체를 놓을 수 있는 첫 교시는 1~12 사이 숫자로 넣어 주세요.");
    if (value === TIMETABLE_CREATIVE_FROM) delete settings.creativeFrom; else settings.creativeFrom = value;
    return `시간을 정하지 않은 창체는 ${value}교시 이후에만`;
  }
  if (name.startsWith("creative.")) {
    const current = TIMETABLE_VIEW.prepared?.input.creative || { school: 0, schoolTimes: [], grade: 0, gradeTimes: {}, byGroup: false };
    const total = Number(TIMETABLE_VIEW.prepared?.creativeTotal) || 0;
    const keys = (list) => timetableTimes(list).map((time) => `${time.day}${time.period}`);
    const next = { school: Number(current.school) || 0, schoolTimes: keys(current.schoolTimes), grade: current.grade, byGroup: Boolean(current.byGroup),
      gradeTimes: Object.fromEntries(Object.entries(current.gradeTimes || {}).map(([grade, list]) => [grade, keys(list)])) };
    const part = name.slice(9);
    if (part === "school") {
      const value = whole(0, 9);
      if (value === null) return fail("전교 동시 창체 시수를 숫자로 넣어 주세요.");
      next.school = value;
      next.grade = Math.max(0, total - value);
      if (next.schoolTimes.length > value) next.schoolTimes = next.schoolTimes.slice(0, value);
    } else if (part === "schoolTimes") next.schoolTimes = keys(target.value);
    else if (part === "gradeTimes") next.gradeTimes = { ...next.gradeTimes, [key]: keys(target.value) };
    else if (part === "byGroup") next.byGroup = Boolean(target.checked);
    settings.creative = next;
    return part === "byGroup" ? `창체 반군별 ${next.byGroup ? "허용" : "허용 안 함"}` : `창체 전교 동시 ${next.school}시간${next.schoolTimes.length ? `(${next.schoolTimes.join(",")})` : ""} + 학년별 ${typeof next.grade === "object" ? "" : next.grade}시간`;
  }
  if (name === "split") {
    const cut = key.lastIndexOf(":");
    const groupKey = key.slice(0, cut);
    const subject = key.slice(cut + 1);
    const all = { ...(settings.splitClasses || {}) };
    const group = { ...(all[groupKey] || {}) };
    if (String(target.value).trim() === "") delete group[subject];
    else group[subject] = String(target.value).trim();
    if (Object.keys(group).length) all[groupKey] = group; else delete all[groupKey];
    settings.splitClasses = all;
    return `${subject} 반 배정`;
  }
  return "";
}

function timetableCreativePreset(kind) {
  const settings = timetableSettingsEdit();
  const total = Number(TIMETABLE_VIEW.prepared?.creativeTotal) || 0;
  if (kind === "fixed") { delete settings.creative; return "창체: 전교 동시(6단계 고정 시간)"; }
  settings.creative = { school: 0, schoolTimes: [], grade: total, gradeTimes: {}, byGroup: kind === "group" };
  return kind === "group" ? "창체: 학년별 + 반군별 허용" : "창체: 학년별로 놓기";
}

// 선택지 적용: 시간표 조건을 바꾸고 고른 내역(되돌릴 값 포함)을 남긴다.
// 과목을 붙여 쓰는 선택지('double:과목' = 그 과목 2시간 연속 수업 허용)
function timetableChoiceOf(key) {
  if (String(key).startsWith("double:")) {
    const subject = String(key).slice(7);
    return { label: `'${subject}' 2시간 연속 수업 허용`, gives: "그 과목은 같은 교사가 그 반에 하루 2시간을 이어서 할 수 있습니다(3시간 이상·떨어진 2시간은 여전히 위반).",
      skip: (tt) => (Array.isArray(tt.doubleSubjects) ? tt.doubleSubjects : []).includes(subject),
      patch: (tt) => ({ ...tt, doubleSubjects: [...(Array.isArray(tt.doubleSubjects) ? tt.doubleSubjects : []).filter((item) => item !== subject), subject] }) };
  }
  return TIMETABLE_CHOICES[key];
}

function timetableApplyChoice(key) {
  const choice = timetableChoiceOf(key);
  const prepared = TIMETABLE_VIEW.prepared;
  if (!choice?.patch || !prepared) return "";
  const settings = timetableSettingsEdit();
  const plain = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value, typeof stateJsonReplacer === "function" ? stateJsonReplacer : undefined)));
  const before = { rules: plain(settings.rules), creative: plain(settings.creative), keepBlockTimes: plain(settings.keepBlockTimes), doubleSubjects: plain(settings.doubleSubjects) };
  const next = choice.patch(plain(settings) || {}, prepared);
  for (const name of ["rules", "creative", "keepBlockTimes", "doubleSubjects"]) {
    if (next[name] === undefined || next[name] === null) delete settings[name]; else settings[name] = next[name];
  }
  settings.choices = [...(Array.isArray(settings.choices) ? plain(settings.choices) : []), { key, label: choice.label, at: new Date().toISOString(), before }];
  return `선택 — ${choice.label}`;
}

function timetableUndoChoice() {
  const settings = timetableSettingsEdit();
  const list = Array.isArray(settings.choices) ? JSON.parse(JSON.stringify(settings.choices, typeof stateJsonReplacer === "function" ? stateJsonReplacer : undefined)) : [];
  const last = list.pop();
  if (!last) return "";
  for (const name of ["rules", "creative", "keepBlockTimes", "doubleSubjects"]) {
    if (last.before?.[name] === undefined || last.before?.[name] === null) delete settings[name]; else settings[name] = last.before[name];
  }
  if (list.length) settings.choices = list; else delete settings.choices;
  return `되돌림 — ${last.label}`;
}

// 조건이 바뀐 뒤: 바꾸기 전 점검 결과를 기억해 두고(비교용) 저장 + 다시 그리기.
function timetableChanged(label) {
  if (label) {
    TIMETABLE_VIEW.status = "";
    TIMETABLE_VIEW.statusError = false;
    TIMETABLE_VIEW.change = label;
    TIMETABLE_VIEW.before = { semester: TIMETABLE_VIEW.semester, issues: TIMETABLE_VIEW.result?.issues || [] };
    if (typeof persistStateSoon === "function") persistStateSoon();
  }
  renderTimetable();
}

function timetableGoto(key, step) {
  if (Number(step) === 6) {
    const section = key === "rules" || key === "ladder" ? "rules" : "time";
    TIMETABLE_VIEW.open[section] = true;
    renderTimetable();
    const target = document.querySelector(`#workflowStep6Panel [data-tt-section="${section}"]`);
    target?.scrollIntoView?.({ block: "center" });
    target?.querySelector("input, select")?.focus?.();
    return;
  }
  if (typeof switchWorkflowStep === "function") switchWorkflowStep(Number(step));
  if (key === "teachers") document.getElementById("classSectionsTeachersOpen")?.click();
}

function timetableHandleClick(event) {
  const target = event.target;
  const tab = target.closest?.("[data-tt-semester]");
  if (tab) { TIMETABLE_VIEW.editPick = ""; TIMETABLE_VIEW.editTargets = null; TIMETABLE_VIEW.editStatus = ""; TIMETABLE_VIEW.semester = tab.dataset.ttSemester === "2" ? "2" : "1"; TIMETABLE_VIEW.changeInfo = null; TIMETABLE_VIEW.status = ""; renderTimetable(); return; }
  if (target.closest?.("#timetableRunMore")) {
    const edits = Number(timetableSaved(timetableRound())?.result?.edits) || 0;
    if (!edits || typeof appConfirm !== "function") { timetableRunStart("", { more: true }); return; }
    appConfirm(`더 나은 답을 찾으면 직접 고친 ${edits}곳이 사라집니다(더 나은 답이 없으면 그대로 둡니다). 계속할까요?`, { title: "더 오래 계산", ok: "계산" }).then((ok) => { if (ok) timetableRunStart("", { more: true }); });
    return;
  }
  if (target.closest?.("#timetableRun")) {
    const edits = Number(timetableSaved()?.result?.edits) || 0;
    if (!edits || typeof appConfirm !== "function") { timetableRunStart(); return; }
    appConfirm(`다시 계산하면 직접 고친 ${edits}곳이 사라집니다. 계속할까요?`, { title: "시간표 다시 계산", ok: "다시 계산" }).then((ok) => { if (ok) timetableRunStart(); });
    return;
  }
  const solveChoice = target.closest?.("[data-tt-choice-solve]");
  if (solveChoice) {
    const label = timetableApplyChoice(solveChoice.dataset.ttChoiceSolve);
    if (!label) return;
    if (typeof persistStateSoon === "function") persistStateSoon();
    timetableRunStart(timetableChoiceOf(solveChoice.dataset.ttChoiceSolve).label);
    return;
  }
  if (target.closest?.("#timetableStop")) { timetableRunStop(); return; }
  if (target.closest?.("#timetableDownload")) { timetableDownload(); return; }
  if (target.closest?.("#timetablePrintOne")) { timetablePrint(false); return; }
  if (target.closest?.("#timetablePrintAll")) { timetablePrint(true); return; }
  if (target.closest?.("#timetableEditUndo")) { timetableEditUndo(); return; }
  if (target.closest?.("#timetablePin")) { timetablePinToggle(); return; }
  if (target.closest?.("#timetableTeacherChange")) { timetableTeacherChange(); return; }
  if (target.closest?.("#timetableTeacherPin")) { timetableTeacherPinToggle(); return; }
  if (target.closest?.("#timetablePinsClear")) {
    const settings = timetableSettingsEdit();
    delete settings.pins;
    delete settings.teacherPins;
    TIMETABLE_VIEW.teacherOptions = null;
    TIMETABLE_VIEW.editPick = ""; TIMETABLE_VIEW.editTargets = null; TIMETABLE_VIEW.editStatus = "고정을 모두 풀었습니다."; TIMETABLE_VIEW.editError = false;
    if (typeof persistStateSoon === "function") persistStateSoon();
    renderTimetable();
    return;
  }
  const editCell = target.closest?.("[data-tt-edit]");
  if (editCell) { timetableEditClick(editCell.dataset.ttEdit); return; }
  if (target.closest?.("#timetableWriteBlockTimes")) {
    const count = timetableBlockTimeChanges().length;
    const ask = typeof appConfirm === "function" ? appConfirm(`시간표가 정한 블록 요일·교시 ${count}개를 6단계 블록 시간에 적어 넣을까요?\n분반·학생 배정·분반 교사는 바뀌지 않습니다.`, { title: "6단계 블록 시간에 적어 넣기", ok: "적어 넣기" }) : Promise.resolve(true);
    Promise.resolve(ask).then((ok) => {
      if (!ok) return;
      const written = timetableWriteBlockTimes();
      TIMETABLE_VIEW.runStatus = `6단계 블록 시간 ${written}개를 시간표의 블록 자리로 적어 넣었습니다.`;
      TIMETABLE_VIEW.runError = false;
      if (typeof renderClassSections === "function") renderClassSections();
      renderTimetable();
    });
    return;
  }
  const view = target.closest?.("[data-tt-view]");
  if (view) { TIMETABLE_VIEW.editPick = ""; TIMETABLE_VIEW.editTargets = null; TIMETABLE_VIEW.grid = view.dataset.ttView === "teacher" ? "teacher" : "class"; renderTimetable(); return; }
  const go = target.closest?.("[data-tt-goto]");
  if (go) { timetableGoto(go.dataset.ttGoto, go.dataset.ttStep); return; }
  const preset = target.closest?.("[data-tt-creative-preset]");
  if (preset) { timetableChanged(timetableCreativePreset(preset.dataset.ttCreativePreset)); return; }
  if (target.closest?.("#timetableRulesReset")) { const settings = timetableSettingsEdit(); if (settings.rules && Object.keys(settings.rules).length) { settings.rules = {}; timetableChanged("규칙을 기본값으로"); } return; }
  const choice = target.closest?.("[data-tt-choice]");
  if (choice) { timetableChanged(timetableApplyChoice(choice.dataset.ttChoice)); return; }
  if (target.closest?.("#timetableChoiceUndo")) timetableChanged(timetableUndoChoice());
}

function timetableHandleChange(event) {
  const pick = event.target?.dataset?.ttPick;
  if (pick) { TIMETABLE_VIEW.editPick = ""; TIMETABLE_VIEW.editTargets = null; TIMETABLE_VIEW.editStatus = ""; TIMETABLE_VIEW.pick[pick === "teacher" ? "teacher" : "class"] = event.target.value; renderTimetable(); return; }
  const field = event.target?.dataset?.ttField;
  if (field) timetableChanged(timetableApplyField(field, event.target));
}

function initTimetable() {
  const panel = document.getElementById("workflowStep6Panel");
  if (!panel || panel.dataset.ttBound) return;
  panel.dataset.ttBound = "1";
  panel.addEventListener("click", timetableHandleClick);
  panel.addEventListener("change", timetableHandleChange);
  panel.addEventListener("keydown", (event) => { const cell = event.target?.closest?.("[data-tt-edit]"); if (cell && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); timetableEditClick(cell.dataset.ttEdit); } });
  // 접는 영역을 연 상태를 기억한다(다시 그려도 그대로). toggle은 위로 올라오지 않아 잡는 단계에서 받는다.
  panel.addEventListener("toggle", (event) => { const key = event.target?.dataset?.ttSection; if (key) TIMETABLE_VIEW.open[key] = event.target.open; }, true);
}

if (typeof document !== "undefined" && document.getElementById) {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initTimetable);
  else initTimetable();
}
