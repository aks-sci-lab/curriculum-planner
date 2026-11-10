"use strict";
// 6단계(분반·시간표 편성) 결과 검증(순수 함수). 화면·엑셀에서 읽은 결과를 아래 모델로 바꿔 넘긴다.
// model = {
//   sections: [{ id, grade, semester, subject, block, teacher, capacity, students: ["현학년-반-번호", …] }],
//   selections: Map(학생키 → [{ subject, semester }])   // 최종 확정 수강신청(서버 자료)
//   unavailable: { 교사: ["블록" …] },                    // 교사 불가 시간
//   unassignedExplained: Set(학생키|과목)                   // 화면이 '미배정 사유'를 보여 준 항목
// }
function checkTimetable(model) {
  const problems = { unassigned: [], duplicate: [], blockConflict: [], overCapacity: [], teacherConflict: [], teacherUnavailable: [], unknownSection: [] };
  const assigned = new Map(); // 학생|학기|과목 → 분반들
  const byBlock = new Map();  // 학생|학기|블록 → 분반들
  const teacherBlock = new Map();
  for (const section of model.sections || []) {
    if (Number.isFinite(section.capacity) && section.students.length > section.capacity) problems.overCapacity.push({ section: section.id, size: section.students.length, capacity: section.capacity });
    if (section.teacher) {
      const key = `${section.teacher}|${section.semester}|${section.block}`;
      if (!teacherBlock.has(key)) teacherBlock.set(key, []);
      teacherBlock.get(key).push(section.id);
      if ((model.unavailable?.[section.teacher] || []).includes(section.block)) problems.teacherUnavailable.push({ teacher: section.teacher, block: section.block, section: section.id });
    }
    for (const student of section.students) {
      const a = `${student}|${section.semester}|${section.subject}`;
      if (!assigned.has(a)) assigned.set(a, []);
      assigned.get(a).push(section.id);
      const b = `${student}|${section.semester}|${section.block}`;
      if (!byBlock.has(b)) byBlock.set(b, []);
      byBlock.get(b).push(section.id);
    }
  }
  for (const [key, ids] of assigned) if (ids.length > 1) problems.duplicate.push({ key, sections: ids });
  for (const [key, ids] of byBlock) if (ids.length > 1) problems.blockConflict.push({ key, sections: ids });
  for (const [key, ids] of teacherBlock) if (ids.length > 1) problems.teacherConflict.push({ key, sections: ids });
  for (const [student, list] of model.selections || new Map()) {
    for (const item of list) {
      const key = `${student}|${item.semester}|${item.subject}`;
      if (!assigned.has(key) && !model.unassignedExplained?.has(`${student}|${item.subject}`)) problems.unassigned.push(key);
    }
  }
  const selected = new Set([...(model.selections || new Map())].flatMap(([student, list]) => list.map((item) => `${student}|${item.semester}|${item.subject}`)));
  for (const key of assigned.keys()) if (model.selections && !selected.has(key)) problems.unknownSection.push(key);
  return { ok: Object.values(problems).every((list) => !list.length), problems };
}

// 나이스 '수강학생 편성' 업로드용 내보내기: 열 구성, 학생·과목당 한 줄, 최종 선택과 같은지.
const NEIS_COLUMNS = ["학년도", "학기", "학년", "편제명", "개설과목(학점)", "개설강의실", "계열/학년/학과", "반", "번호", "성명"];
function checkNeisExport(rows, { selections = null, required = ["학년도", "학기", "학년", "개설과목(학점)", "반", "번호"] } = {}) {
  const compact = (v) => String(v ?? "").replace(/\s+/g, "");
  const headerIndex = rows.findIndex((row) => required.every((name) => (row || []).map(compact).includes(compact(name))));
  if (headerIndex < 0) return { ok: false, error: `머리 행(${required.join("·")})을 찾지 못함`, header: rows.slice(0, 3) };
  const header = rows[headerIndex].map(compact);
  const col = (name) => header.indexOf(compact(name));
  const missing = NEIS_COLUMNS.filter((name) => col(name) < 0);
  const seen = new Map();
  const duplicates = [];
  const exported = new Map();
  for (const row of rows.slice(headerIndex + 1)) {
    if (!row || row.every((v) => !compact(v))) continue;
    const subject = String(row[col("개설과목(학점)")] ?? "").replace(/\(\d+(?:\.\d+)?\)\s*$/, "").trim();
    const student = `${compact(row[col("학년")])}-${Number(row[col("반")])}-${Number(row[col("번호")])}`;
    const key = `${compact(row[col("학기")])}|${student}|${subject}`;
    if (seen.has(key)) duplicates.push(key); else seen.set(key, true);
    if (!exported.has(student)) exported.set(student, []);
    exported.get(student).push({ subject, semester: compact(row[col("학기")]) });
  }
  const mismatch = [];
  if (selections) {
    for (const [student, list] of selections) {
      const got = (exported.get(student) || []).map((x) => `${x.semester}|${x.subject}`).sort();
      const want = list.map((x) => `${x.semester}|${x.subject}`).sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) mismatch.push({ student, want, got });
    }
  }
  return { ok: !missing.length && !duplicates.length && !mismatch.length, headerRow: headerIndex, missing, duplicates, mismatch: mismatch.slice(0, 20), mismatchCount: mismatch.length, rows: seen.size };
}
module.exports = { checkTimetable, checkNeisExport, NEIS_COLUMNS };
