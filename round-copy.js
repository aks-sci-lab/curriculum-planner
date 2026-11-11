"use strict";
// 차수별 흐름 분리(사용자 결정 2026-11): 맨 위에서 고른 차수 하나가 2~6단계 모든 화면의 기준이다. 숨은 차수 고르기 규칙은 없다.
// - 차수마다 따로: 신청 결과(학년별), 4단계 개설·폐강·학급 수, 확정·스냅샷, 6단계 분반 결과·고정, 고른 개설 학기.
// - 새 차수 = 직전 차수 복사(확정 제외). 결과를 올린 학년만 바뀐다. 재신청 결과는 '학년 전원' 또는 '재신청한 학생만'으로 올린다.
// - 학년마다 어디서 온 결과인지는 rounds[r].gradeSources[현학년] = { kind: "upload"|"partial"|"online"|"copy", round, at, from? }.
//   copy면 from = { round, signature }(복사할 때 앞 차수 그 학년 자료의 서명) → 앞 차수가 바뀌면 근거 줄에 '복사 뒤 바뀜 · 다시 복사'.
// 이 파일 위쪽은 순수 계산(state·DOM 없음, app.js보다 먼저 로드). 자료 모양: data = rounds[r] = { students, courses, classOverrides,
// semesterAssignments, groupAssignments, … }, closures = roundClosures[r] = { "현학년:열": "open"|"closed"|"" }.

function roundCopyClone(value) {
  return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
}

function roundCopyGradeKey(key) {
  const separator = String(key).indexOf(":");
  return separator < 0 ? { grade: "", column: String(key) } : { grade: String(key).slice(0, separator), column: String(key).slice(separator + 1) };
}

function roundCopySeat(student) {
  const part = (value) => {
    const text = String(value ?? "").trim();
    return /^\d+$/.test(text) ? String(Number(text)) : text;
  };
  return `${part(student?.grade)}-${part(student?.classroom)}-${part(student?.number)}`;
}

// 현 grade학년 몫: 그 학년 학생·과목 열·학급수 입력·학기/그룹 지정·개설 결정.
function roundGradeSlice(data, closures, grade) {
  grade = String(grade);
  const students = (data?.students || []).filter((student) => String(student.grade) === grade);
  const chosen = new Set(students.flatMap((student) => (student.selections || []).map((selection) => String(selection.column))));
  const courses = (data?.courses || []).filter((course) => course.applicationCurrentGrade
    ? String(course.applicationCurrentGrade) === grade : chosen.has(String(course.column)));
  const columns = new Set(courses.map((course) => String(course.column)));
  const pick = (source, test) => Object.fromEntries(Object.entries(source || {}).filter(([key]) => test(key)));
  const prefixed = (key) => { const { grade: owner, column } = roundCopyGradeKey(key); return owner === grade && columns.has(column); };
  return {
    students, courses,
    classOverrides: pick(data?.classOverrides, prefixed),
    semesterAssignments: pick(data?.semesterAssignments, (key) => columns.has(String(key))),
    groupAssignments: pick(data?.groupAssignments, (key) => columns.has(String(key))),
    closures: pick(closures, prefixed)
  };
}

// 학년 몫의 서명(앞 차수가 복사 뒤 바뀌었는지 비교용): 학생 자리·선택 과목 이름·학기 + 개설 결정 + 학급수 입력.
function roundGradeSignature(data, closures, grade) {
  const slice = roundGradeSlice(data, closures, grade);
  const nameOf = new Map(slice.courses.map((course) => [String(course.column), `${course.name}|${course.semesterKey || ""}`]));
  const parts = [
    ...slice.students.map((student) => `${roundCopySeat(student)}=${(student.selections || []).map((selection) => nameOf.get(String(selection.column)) || selection.name).sort().join(",")}`).sort(),
    ...Object.entries(slice.closures).map(([key, value]) => `c${nameOf.get(roundCopyGradeKey(key).column)}=${value}`).sort(),
    ...Object.entries(slice.classOverrides).map(([key, value]) => `o${nameOf.get(roundCopyGradeKey(key).column)}=${value}`).sort()
  ];
  let hash = 2166136261;
  const text = parts.join("\n");
  for (let index = 0; index < text.length; index++) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
  return `${slice.students.length}:${(hash >>> 0).toString(16)}`;
}

// data(차수 자료)의 현 grade학년 몫을 slice로 바꾼다. 다른 학년 열과 겹치는 열 이름은 바꿔 넣는다(웹 결과 'app3' 등).
// 돌려주는 값: { data, closures } — 새 객체(원본은 건드리지 않음).
function roundReplaceGrade(data, closures, grade, slice) {
  grade = String(grade);
  const base = roundCopyClone(data) || { students: [], courses: [], classOverrides: {}, semesterAssignments: {}, groupAssignments: {}, customGroupNames: [], fileName: "", gradeFiles: {} };
  const own = roundGradeSlice(base, closures, grade);
  const ownColumns = new Set(own.courses.map((course) => String(course.column)));
  const next = roundCopyClone(slice);
  base.students = (base.students || []).filter((student) => String(student.grade) !== grade);
  base.courses = (base.courses || []).filter((course) => !ownColumns.has(String(course.column)));
  const occupied = new Set(base.courses.map((course) => String(course.column)));
  const rename = new Map();
  for (const course of next.courses) {
    let column = String(course.column);
    if (occupied.has(column)) {
      let suffix = 1;
      while (occupied.has(`${course.column}~${suffix}`)) suffix++;
      column = `${course.column}~${suffix}`;
    }
    rename.set(String(course.column), column);
    occupied.add(column);
  }
  const col = (value) => rename.get(String(value)) ?? String(value);
  for (const course of next.courses) course.column = col(course.column);
  for (const student of next.students) for (const selection of student.selections || []) selection.column = col(selection.column);
  base.courses.push(...next.courses);
  base.students.push(...next.students);
  base.students.sort((a, b) => Number(a.grade) - Number(b.grade) || Number(a.classroom) - Number(b.classroom) || Number(a.number) - Number(b.number));
  const strip = (source, prefixed) => Object.fromEntries(Object.entries(source || {}).filter(([key]) =>
    prefixed ? !(roundCopyGradeKey(key).grade === grade && ownColumns.has(roundCopyGradeKey(key).column)) : !ownColumns.has(String(key))));
  const renameKeys = (source, prefixed) => Object.fromEntries(Object.entries(source || {}).map(([key, value]) =>
    [prefixed ? `${grade}:${col(roundCopyGradeKey(key).column)}` : col(key), value]));
  base.classOverrides = { ...strip(base.classOverrides, true), ...renameKeys(next.classOverrides, true) };
  base.semesterAssignments = { ...strip(base.semesterAssignments, false), ...renameKeys(next.semesterAssignments, false) };
  base.groupAssignments = { ...strip(base.groupAssignments, false), ...renameKeys(next.groupAssignments, false) };
  const nextClosures = { ...strip(closures, true), ...renameKeys(next.closures, true) };
  return { data: base, closures: nextClosures };
}

// 재신청한 학생만 있는 결과(overlay = { students, courses }, 그 학년만)를 차수 자료의 그 학년에 합친다: 파일에 있는 학생(학년·반·번호)은
// 선택을 바꾸고, 없던 학생은 더하고(전입 등), 나머지는 그대로. 과목 열은 같은 이름·학기의 기존 열을 쓰고, 없으면 새 열.
// 돌려주는 값: { slice, counts: { changed, same, added, kept } } — slice는 roundReplaceGrade에 넣을 그 학년 몫.
function roundMergeGradeStudents(data, closures, grade, overlay) {
  grade = String(grade);
  const slice = roundCopyClone(roundGradeSlice(data, closures, grade));
  const compact = (text) => String(text || "").replace(/\s+/g, "");
  const courseId = (course) => `${compact(course.name)}|${course.semesterKey || ""}`;
  const byId = new Map(slice.courses.map((course) => [courseId(course), course]));
  // 학기 표시가 한쪽에만 있으면(예전 결과 열은 semesterKey 없이 그룹으로 학기를 정함) 이름이 하나뿐일 때 이름으로 맞춘다.
  const byName = new Map();
  for (const course of slice.courses) {
    const name = compact(String(course.name).replace(/\s*[（(]\s*[12]\s*학기\s*[)）]/g, ""));
    byName.set(name, byName.has(name) ? null : course);
  }
  const occupied = new Set([...(data?.courses || []).map((course) => String(course.column))]);
  const columnOf = new Map();
  for (const course of overlay.courses || []) {
    const existing = byId.get(courseId(course)) || byName.get(compact(String(course.name).replace(/\s*[（(]\s*[12]\s*학기\s*[)）]/g, ""))) || null;
    if (existing) { columnOf.set(String(course.column), existing); continue; }
    let column = `result-${grade}-${slice.courses.length}`;
    while (occupied.has(column)) column += "+";
    occupied.add(column);
    const added = { ...roundCopyClone(course), column, applicationCurrentGrade: grade };
    slice.courses.push(added);
    byId.set(courseId(added), added);
    columnOf.set(String(course.column), added);
  }
  const counts = { changed: 0, same: 0, added: 0, kept: 0 };
  const seats = new Map(slice.students.map((student, index) => [roundCopySeat(student), index]));
  const touched = new Set();
  for (const student of overlay.students || []) {
    if (String(student.grade) !== grade) continue;
    const selections = (student.selections || []).map((selection) => {
      const course = columnOf.get(String(selection.column));
      return course ? { ...roundCopyClone(selection), ...roundCopyClone(course), column: course.column } : roundCopyClone(selection);
    });
    const next = { ...roundCopyClone(student), selections, totalCredits: selections.reduce((sum, item) => sum + (Number(item.credits) || 0), 0) };
    const seat = roundCopySeat(student);
    touched.add(seat);
    if (seats.has(seat)) {
      const before = slice.students[seats.get(seat)];
      const key = (list) => (list || []).map((item) => `${compact(item.name)}|${item.semesterKey || ""}`).sort().join(",");
      if (key(before.selections) === key(selections)) counts.same++;
      else counts.changed++;
      slice.students[seats.get(seat)] = { ...next, id: before.id || next.id };
    } else {
      counts.added++;
      seats.set(seat, slice.students.length);
      slice.students.push(next);
    }
  }
  counts.kept = slice.students.length - touched.size;
  return { slice, counts };
}

// 예전 자료 옮기기 계획(열 때 한 번): 차수 r(>1)에서 학년이 비어 있으면 직전 차수에서 복사, 일부 학생만 있으면(직전 차수 학생의
// 절반 미만이고 모두 직전 차수에 있는 학생) '합칠까요?' 물을 대상. 확정된 차수·이미 정한 학년(gradeSources.decided)은 건너뛴다.
// rounds: { r: data }, locked(r) → bool. 돌려주는 값: [{ round, grade, from, action: "copy"|"ask", count, previous }]
function roundMigrationPlan(rounds, locked) {
  const order = Object.keys(rounds || {}).filter((round) => /^[1-9]\d{0,8}$/.test(round)).sort((a, b) => Number(a) - Number(b));
  const plan = [];
  for (let index = 1; index < order.length; index++) {
    const round = order[index], from = order[index - 1];
    if (locked(round)) continue;
    const data = rounds[round], previous = rounds[from];
    for (const grade of ["1", "2"]) {
      if (data?.gradeSources?.[grade]?.decided) continue;
      const mine = (data?.students || []).filter((student) => String(student.grade) === grade);
      const before = (previous?.students || []).filter((student) => String(student.grade) === grade);
      if (!before.length) continue;
      if (!mine.length) { plan.push({ round, grade, from, action: "copy", count: 0, previous: before.length }); continue; }
      const seats = new Set(before.map(roundCopySeat));
      if (mine.length * 2 < before.length && mine.every((student) => seats.has(roundCopySeat(student)))) {
        plan.push({ round, grade, from, action: "ask", count: mine.length, previous: before.length });
      }
    }
  }
  return plan;
}

// 같은 학년의 과목 열이 차수마다 다를 때(웹 재신청은 폐강 과목을 빼서 열 번호가 밀림) 개설 결정·학급수 입력을 이름·학기로 옮긴다.
// 같은 이름·학기 과목이 한쪽에 여럿이면 옮기지 않는다. source = { "현학년:열": 값 } → 그 학년 키만 새 열로.
function roundRemapKeysByName(fromCourses, toCourses, source, grade) {
  grade = String(grade);
  const compact = (course) => `${String(course.applicationSubject?.subject || course.name || "").replace(/\s*[（(]\s*[12]\s*학기\s*[)）]/g, "").replace(/\s+/g, "")}|${course.semesterKey || String(course.name || "").match(/([12])\s*학기/)?.[1] || ""}`;
  const index = (courses) => {
    const map = new Map();
    for (const course of courses || []) {
      if (course.applicationCurrentGrade && String(course.applicationCurrentGrade) !== grade) continue;
      const key = compact(course);
      map.set(key, map.has(key) ? null : course);
    }
    return map;
  };
  const before = index(fromCourses), after = index(toCourses);
  const byColumn = new Map([...before].filter(([, course]) => course).map(([key, course]) => [String(course.column), key]));
  const result = {};
  for (const [key, value] of Object.entries(source || {})) {
    const { grade: owner, column } = roundCopyGradeKey(key);
    if (owner !== grade) continue;
    const target = after.get(byColumn.get(column));
    if (target) result[`${grade}:${target.column}`] = value;
  }
  return result;
}
