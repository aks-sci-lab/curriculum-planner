"use strict";
var resultImportPending = null;

// 과목명 비교 키. 편제표에서 공식 과목명으로 자동 수정한 과목은 원래 이름도 같은 키로 본다(curriculum-data.js curriculumNameAlias).
function normalizeResultCourseName(name) {
  const key = normalizeResultCourseKey(name);
  const alias = typeof curriculumNameAlias === "function" ? curriculumNameAlias(key, normalizeResultCourseKey) : null;
  return alias || key;
}

function normalizeResultCourseKey(name) {
  const text = typeof normalizeRomanNumerals === "function" ? normalizeRomanNumerals(name) : String(name ?? "");
  return text
    .replace(/[*＊★☆■↔]/g, "")
    .replace(/[（(]\s*[12]\s*학기\s*[)）]/g, "")
    .replace(/[（(]\s*[123]\s*학년\s*[)）]/g, "")
    .replace(/[（(]\s*(?:일반|진로|융합)(?:선택)?\s*[)）]/g, "")
    .replace(/[·ㆍ•‧⋅]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function resultCourseSemester(course) {
  const key = String(course?.semesterKey || "");
  if (key === "1" || key === "2") return key;
  return String(course?.name || "").match(/([12])\s*학기/)?.[1] || "";
}

function resultCourseKey(course) {
  return `${normalizeResultCourseName(course?.name)}|${resultCourseSemester(course)}`;
}

function resultSeatKey(student) {
  const part = (value) => {
    const text = String(value ?? "").trim();
    return /^\d+$/.test(text) ? String(Number(text)) : text;
  };
  return `${part(student.classroom)}-${part(student.number)}`;
}

function resultExampleList(items, limit = 5) {
  const list = [...items];
  return list.slice(0, limit).join(", ") + (list.length > limit ? ` 외 ${list.length - limit}개` : "");
}

// 결과 파일의 학년 열은 현재 학년이다. 현 N학년 학생은 N+1학년 과목을 신청한다.
const RESULT_UPLOAD_GRADES = ["1", "2"];

function resultGradeText(grade) {
  const text = String(grade ?? "").trim();
  return /^\d+$/.test(text) ? String(Number(text)) : text;
}

function resultTargetLabel(grade) {
  return `${Number(grade) + 1}학년 과목(현 ${Number(grade)}학년 신청)`;
}

function resultCurrentLabel(grade) {
  return `현 ${Number(grade)}학년(${Number(grade) + 1}학년 과목 신청)`;
}

function resultGradeCounts(grades) {
  const counts = new Map();
  for (const value of grades) {
    const grade = resultGradeText(value);
    if (grade) counts.set(grade, (counts.get(grade) || 0) + 1);
  }
  return counts;
}

// 선택한 학년 탭의 학생이 하나도 없을 때, 파일 안의 실제 학년과 올려야 할 탭을 알려 준다.
function resultGradeMismatchMessage(grade, counts) {
  const selected = `지금 선택한 탭은 '현 ${grade}학년'입니다.`;
  const rule = `결과 파일의 학년 열은 현재 학년입니다(현 1학년 → 2학년 과목 신청, 현 2학년 → 3학년 과목 신청).`;
  if (!counts.size) return `학년이 적힌 학생 행이 없습니다. ${rule}`;
  const uploadable = [...counts.keys()].filter((value) => RESULT_UPLOAD_GRADES.includes(value) && value !== grade);
  const others = [...counts.keys()].filter((value) => !RESULT_UPLOAD_GRADES.includes(value));
  const parts = [];
  if (uploadable.length) {
    parts.push(`이 파일은 ${uploadable.map((value) => `${resultCurrentLabel(value)} ${counts.get(value)}명`).join(", ")} 결과입니다. ${selected} ${uploadable.map((value) => `'현 ${value}학년'`).join("·")} 탭에 올려 주세요.`);
  }
  if (others.length) {
    parts.push(`${uploadable.length ? "또 이 파일에는" : `${selected} 이 파일에는`} 학년이 ${others.map((value) => `'${value}'`).join(", ")}인 학생 ${others.reduce((sum, value) => sum + counts.get(value), 0)}명이 있습니다. 신청할 과목의 학년을 적었다면 현재 학년으로 고쳐 주세요.`);
  }
  parts.push(rule);
  return parts.join(" ");
}

function resultOtherGradeNote(counts) {
  return [...counts].map(([value, count]) => RESULT_UPLOAD_GRADES.includes(value)
    ? `${resultCurrentLabel(value)} ${count}명은 제외했습니다. '현 ${value}학년' 탭에서 따로 올려 주세요.`
    : `학년이 '${value}'인 학생 ${count}명은 제외했습니다. 결과 파일의 학년 열은 현재 학년이어야 합니다.`);
}

function sortResultStudents(students) {
  return students.sort((a, b) =>
    Number(a.grade) - Number(b.grade) || Number(a.classroom) - Number(b.classroom) ||
    Number(a.number) - Number(b.number) || String(a.name).localeCompare(String(b.name), "ko"));
}

// 시트 하나를 결과 자료로 변환한다. 실패해도 예외 대신 error를 담아 돌려준다.
function parseResultSheet(sheet, options) {
  const rows = sheet?.rows || [];
  const grade = String(options.grade);
  const base = { format: "", data: null, error: "", otherGradeCount: 0, otherGrades: [], skippedRows: [] };
  const firstRow = rows[0] || [];
  if (String(firstRow[0] ?? "").trim() === "차수" && String(firstRow[5] ?? "").trim() === "선택과목") {
    base.format = "form";
    const header = ["차수", "학년", "반", "번호", "성명", "선택과목"];
    if (header.some((name, index) => String(firstRow[index] ?? "").trim() !== name)) {
      return { ...base, error: "결과 엑셀의 머리글 형식(차수·학년·반·번호·성명·선택과목)을 확인하세요." };
    }
    const body = rows.slice(1).map((row, index) => ({ row: row || [], line: index + 2 }))
      .filter(({ row }) => row.some((value) => String(value ?? "").trim()));
    if (!body.length) return { ...base, error: "신청 결과가 비어 있습니다." };
    if (body.some(({ row }) => String(row[0] ?? "").trim() !== String(options.round))) {
      return { ...base, error: `업로드한 엑셀의 차수와 현재 선택한 ${options.round}차가 다릅니다. 차수를 확인하세요.` };
    }
    const gradeRows = body.filter(({ row }) => String(row[1] ?? "").trim() === grade);
    base.otherGradeCount = body.length - gradeRows.length;
    const otherCounts = resultGradeCounts(body.filter(({ row }) => String(row[1] ?? "").trim() !== grade).map(({ row }) => row[1]));
    base.otherGrades = resultOtherGradeNote(otherCounts);
    if (!gradeRows.length) return { ...base, error: resultGradeMismatchMessage(grade, otherCounts) };
    const items = options.subjects?.[String(Number(grade) + 1)] || [];
    const known = new Set([
      ...items.map((item) => item.subject),
      ...items.flatMap((item) => String(item.semester || "").includes("·")
        ? String(item.semester).split("·").map((semester) => `${item.subject} (${semester}학기)`)
        : [])
    ]);
    const entries = [];
    const empty = [];
    for (const { row, line } of gradeRows) {
      const entry = {
        grade,
        classroom: String(row[2] ?? "").trim(),
        number: String(row[3] ?? "").trim(),
        name: String(row[4] ?? "").trim()
      };
      if (!entry.classroom || !entry.number || !entry.name) {
        const missing = [["반", entry.classroom], ["번호", entry.number], ["성명", entry.name]]
          .filter(([, value]) => !value).map(([label]) => label);
        base.skippedRows.push({ row: line, reason: `${missing.join("·")} 없음`, name: entry.name });
        continue;
      }
      let selections;
      try {
        selections = splitGoogleFormSelections(row[5], known, true);
      } catch (error) {
        return { ...base, error: `${line}행 ${entry.name}: ${error instanceof Error ? error.message : "선택과목을 읽지 못했습니다."}` };
      }
      if (selections.length) entries.push({ ...entry, selections });
      else empty.push(entry);
    }
    const merged = mergeApplications(entries, options.subjects);
    if (merged.errors.length) return { ...base, error: merged.errors.join("\n") };
    for (const entry of empty) {
      merged.students.push({ id: `app-${grade}-${entry.classroom}-${entry.number}-${entry.name}`, ...entry, selections: [], totalCredits: 0 });
    }
    sortResultStudents(merged.students);
    return { ...base, data: { students: merged.students, courses: merged.courses } };
  }
  base.format = "wide";
  let data;
  try {
    data = createRecords(rows, { merges: sheet?.layout?.mergedRanges || sheet?.mergedRanges || [], sheetName: sheet?.name || "" });
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : "결과표 형식을 읽지 못했습니다." };
  }
  const students = data.students.filter((student) => String(student.grade) === grade);
  base.otherGradeCount = data.students.length - students.length;
  const otherCounts = resultGradeCounts(data.students.filter((student) => String(student.grade) !== grade).map((student) => student.grade));
  base.otherGrades = resultOtherGradeNote(otherCounts);
  base.skippedRows = data.skippedRows || [];
  if (!students.length) return { ...base, error: resultGradeMismatchMessage(grade, otherCounts) };
  return { ...base, data: { students, courses: data.courses } };
}

function countResultSelections(students, courses) {
  const counts = new Map();
  for (const course of courses) {
    const key = resultCourseKey(course);
    if (!counts.has(key)) counts.set(key, { name: course.name, semester: resultCourseSemester(course), count: 0 });
  }
  for (const student of students) {
    for (const selection of student.selections || []) {
      const key = resultCourseKey(selection);
      if (!counts.has(key)) counts.set(key, { name: selection.name, semester: resultCourseSemester(selection), count: 0 });
      counts.get(key).count++;
    }
  }
  return counts;
}

// 소인수·공동교육과정(1단계 편제표 학기 칸 메모·편성 영역 '소인수·공동')은 신청 과목이 아니므로 결과 파일에 있어도 조용히 뺀다.
// items = 그 학년 신청 과목 목록(collectApplicationSubjects includeExcluded, 해당 과목은 separate: true). 뺀 과목 이름을 돌려준다.
function stripSeparateResultCourses(data, items) {
  const separate = new Set((items || []).filter((item) => item.separate).map((item) => normalizeResultCourseName(item.subject)));
  if (!separate.size || !data?.courses?.length) return [];
  const removed = data.courses.filter((course) => separate.has(normalizeResultCourseName(course.name)));
  if (!removed.length) return [];
  const columns = new Set(removed.map((course) => String(course.column)));
  data.courses = data.courses.filter((course) => !columns.has(String(course.column)));
  for (const student of data.students || []) {
    if (!(student.selections || []).some((selection) => columns.has(String(selection.column)))) continue;
    student.selections = student.selections.filter((selection) => !columns.has(String(selection.column)));
    student.totalCredits = student.selections.reduce((total, selection) => total + (Number(selection.credits) || 0), 0);
  }
  return removed.map((course) => course.name);
}

function analyzeResultCandidate(candidate, options) {
  // errors: 빨간 오류지만 반영은 막지 않는다(반영 전에 앱 확인 창으로 한 번 더 묻는다).
  const issues = { blocking: [], errors: [], warnings: [], info: [], actions: [] };
  const addAction = (target, label) => {
    if (!issues.actions.some((action) => action.target === target)) issues.actions.push({ target, label });
  };
  if (candidate.error) {
    issues.blocking.push(candidate.error);
    return { ...candidate, issues, comparison: [], summary: null };
  }
  const grade = String(options.grade);
  const targetGrade = String(Number(grade) + 1);
  const target = resultTargetLabel(grade);
  // 소인수·공동교육과정 과목은 신청 과목이 아니므로 결과에 있어도 안내 없이 뺀다(편제표 작업에서만 다룸).
  stripSeparateResultCourses(candidate.data, options.subjects?.[targetGrade]);
  const plan = options.cohortYear ? `${options.cohortYear}학년도 입학생 편제표(${targetGrade}학년 열)` : `${targetGrade}학년 편제표`;
  const students = candidate.data.students;
  let courses = candidate.data.courses.filter((course) =>
    !course.applicationCurrentGrade || course.applicationCurrentGrade === grade);

  const seats = new Map();
  const duplicates = [];
  for (const student of students) {
    const key = resultSeatKey(student);
    if (seats.has(key)) duplicates.push(`${student.classroom}반 ${student.number}번`);
    else seats.set(key, student);
  }
  if (duplicates.length) {
    issues.warnings.push(`현 ${grade}학년 결과에 같은 반·번호가 두 번 이상 나옵니다(${duplicates.length}건: ${resultExampleList(duplicates)}). 학생 수와 과목 인원이 부풀려질 수 있으니 원본을 확인하세요.`);
  }
  const summaryRows = candidate.skippedRows.filter((row) => /학년·반·번호·성명/.test(row.reason));
  const brokenRows = candidate.skippedRows.filter((row) => !summaryRows.includes(row));
  if (brokenRows.length) {
    issues.warnings.push(`학생 정보가 빠져 제외한 행 ${brokenRows.length}개: ${resultExampleList(brokenRows.map((row) => `${row.row}행(${row.reason})`))}.`);
  }
  if (summaryRows.length) issues.info.push(`학생 정보가 없는 합계·빈 행 ${summaryRows.length}개는 제외했습니다.`);
  const empty = students.filter((student) => !student.selections.length);
  if (empty.length) {
    issues.warnings.push(`${target}을 하나도 고르지 않은 학생 ${empty.length}명: ${resultExampleList(empty.map((student) => `${student.classroom}-${student.number} ${student.name}`))}. 재적 학생 수에는 포함되지만 과목 인원에는 반영되지 않습니다.`);
  }

  const curriculum = options.subjects?.[targetGrade] || [];
  if (curriculum.length) {
    const curriculumNames = new Set(curriculum.map((item) => normalizeResultCourseName(item.subject)));
    const fileNames = new Set(courses.map((course) => normalizeResultCourseName(course.name)));
    const unknown = courses.filter((course) => !curriculumNames.has(normalizeResultCourseName(course.name)));
    if (unknown.length) {
      issues.warnings.push(`${target} 중 ${plan}에 없는 과목 ${unknown.length}개: ${resultExampleList(unknown.map((course) => course.name))}. 과목명이 편제표와 다르면 그룹 분류와 시수 통계 연결이 끊어지니 편제표 또는 파일의 과목명을 맞추세요.`);
      addAction("curriculum", "1단계 편제표 확인");
    }
    // 소인수·공동 과목은 신청 과목이 아니므로 '결과 파일에 없는 과목'으로 세지 않는다.
    const missing = curriculum.filter((item) => !item.separate && !fileNames.has(normalizeResultCourseName(item.subject)));
    if (missing.length) issues.info.push(`${plan}의 ${target} 중 결과 파일에 없는 과목 ${missing.length}개: ${resultExampleList(missing.map((item) => item.subject))}.`);
  } else {
    issues.info.push(`${plan}에서 ${target}을 찾지 못해 과목명 대조를 건너뛰었습니다. 1단계에서 해당 입학연도 편제표를 확인하세요.`);
  }

  let groups = options.groups;
  if (!groups) {
    try {
      groups = typeof getApplicationGroupSettings === "function" ? getApplicationGroupSettings() : [];
    } catch (error) {
      groups = [];
      issues.info.push(`선택 그룹 설정을 읽지 못해 그룹 검증을 건너뛰었습니다(${error instanceof Error ? error.message : "설정 확인 필요"}).`);
    }
  }
  let unclassified = [];
  let semesterPicks = [];
  let semesterNotes = [];
  try {
    unclassified = classifyApplicationRecords(candidate.data);
    // 두 학기 편성 과목이 결과에 한 번만 나오면 '한 학기만 개설': 교사가 학기를 고른다(차수마다, 추천값·근거와 함께).
    // 머리글 표시·같은 이름 두 열(위치)로 정한 과목은 묻지 않고 근거만 보여 준다.
    if (typeof twoSemesterPickCandidates === "function") semesterPicks = twoSemesterPickCandidates(unclassified.twoSemesterCourses, grade);
    if (typeof twoSemesterDecidedNotes === "function") {
      const onceNames = new Set((options.subjects?.[targetGrade] || []).filter((item) => item.sameCourseOnce)
        .map((item) => (typeof courseSemesterPickKey === "function" ? courseSemesterPickKey(item.subject) : item.subject)));
      semesterNotes = twoSemesterDecidedNotes(candidate.data.courses, grade, onceNames);
    }
    // 학기 표시 없는 두 학기 과목을 학생마다 'X (n학기)'로 나눴으면 과목 목록이 바뀌었으니 다시 읽는다.
    courses = candidate.data.courses.filter((course) => !course.applicationCurrentGrade || course.applicationCurrentGrade === grade);
  } catch (error) {
    issues.info.push(`과목 그룹 분류를 건너뛰었습니다(${error instanceof Error ? error.message : "설정 확인 필요"}).`);
  }
  const undecidedSemester = unclassified.undecidedSemester || [];
  if (undecidedSemester.length) {
    const students = new Map();
    for (const item of undecidedSemester) {
      const label = `${item.student.classroom}-${item.student.number} ${item.student.name || ""}`.trim();
      if (!students.has(label)) students.set(label, []);
      students.get(label).push(item.course);
    }
    issues.warnings.push(`학기를 정할 수 없는 선택 ${students.size}명: ${resultExampleList([...students].map(([label, names]) => `${label}(${names.join(", ")})`))}. 학기 표시 없는 두 학기 과목이라 택n 수로 학기를 정하지 못해 '학기 미정'으로 둡니다.`);
  }
  if (unclassified.length) {
    // 분류 경고는 "2학년 물리학"처럼 신청 학년을 앞에 붙여 오므로, 학년은 문장 앞에 한 번만 적는다.
    const names = unclassified.map((item) => String(item).replace(new RegExp(`^${targetGrade}학년\\s+`), ""));
    issues.warnings.push(`선택 그룹이 정해지지 않은 ${target} ${unclassified.length}개: ${resultExampleList(names)}. 2단계 과목·그룹 설정에서 그룹에 넣으면 집계표가 그룹별로 정리됩니다.`);
    addAction("groups", "과목·그룹 설정으로");
  }
  const groupOf = (selection) => {
    const course = courses.find((item) => item.column === selection.column) || selection;
    return course.applicationGroups?.[grade] || null;
  };
  for (const group of (groups || []).filter((item) => item.grade === targetGrade && Number.isInteger(item.count) && item.count > 0)) {
    const mismatched = students.filter((student) => student.selections.length).map((student) => ({
      student,
      picked: student.selections.filter((selection) => {
        const assigned = groupOf(selection);
        return assigned && assigned.name === group.name && String(assigned.semester) === String(group.semester);
      }).length
    })).filter(({ picked }) => picked !== group.count);
    if (mismatched.length) {
      const label = `${["1", "2"].includes(group.semester) ? `${group.semester}학기 ` : ""}${group.name}`;
      issues.warnings.push(`${target} ${label}: ${group.count}과목 선택 기준과 다른 학생 ${mismatched.length}명 (${resultExampleList(mismatched.map(({ student, picked }) => `${student.classroom}-${student.number} ${student.name} ${picked}과목`), 3)}).`);
      addAction("groups", "과목·그룹 설정으로");
    }
  }

  // 같은 과목 두 학기 신청(편제표 다른 행 · 한 학기만): 판별은 app.js applicationSameCourseTwice 하나.
  if (typeof applicationSameCourseTwice === "function") {
    const twice = students.map((student) => ({ student, items: applicationSameCourseTwice(student) })).filter((entry) => entry.items.length);
    if (twice.length) {
      issues.errors.push(`같은 과목을 두 학기에 신청한 학생 ${twice.length}명: ${resultExampleList(twice.map(({ student, items }) =>
        `${student.classroom}-${student.number} ${student.name}(${items.map((item) => item.name).join(", ")})`))}. 같은 과목은 한 학기에만 신청합니다. 반영하면 이 학생들은 재신청 대상(위계·학점 점검·확인서·4단계 재신청 명단)으로 표시됩니다.`);
      candidate.sameCourseTwice = twice.length;
    }
  }

  // 위계(선이수)·이수학점 점검(course-checks.js): 편제표 데이터 기준 학생별 경고와 목록.
  let courseChecks = null;
  if (typeof courseCheckResultIssues === "function") {
    try {
      courseChecks = courseCheckResultIssues(students, { grade });
      issues.warnings.push(...courseChecks.warnings);
      issues.info.push(...courseChecks.info);
    } catch (error) {
      issues.info.push(`위계·이수학점 점검을 건너뛰었습니다(${error?.message || "확인 필요"}).`);
    }
  }

  if (candidate.otherGrades?.length) issues.info.push(...candidate.otherGrades);
  else if (candidate.otherGradeCount) issues.info.push(`다른 학년 ${candidate.otherGradeCount}명은 제외했습니다. 해당 학년 탭에서 따로 올려 주세요.`);
  const classes = new Set(students.map((student) => String(student.classroom))).size;
  const enrolled = new Set(students.flatMap((student) => student.selections.map((selection) => String(selection.column))));
  const zero = courses.filter((course) => !enrolled.has(String(course.column)));
  if (zero.length) issues.info.push(`신청자가 없는 ${target} ${zero.length}개: ${resultExampleList(zero.map((course) => course.name))}.`);

  const previousStudents = (options.existingStudents || []).filter((student) => String(student.grade) === grade);
  const before = countResultSelections(previousStudents, []);
  const after = countResultSelections(students, courses);
  const comparison = [...new Set([...after.keys(), ...before.keys()])].map((key) => ({
    name: (after.get(key) || before.get(key)).name,
    semester: (after.get(key) || before.get(key)).semester,
    before: previousStudents.length ? (before.get(key)?.count || 0) : null,
    after: after.get(key)?.count || 0
  }));
  return {
    ...candidate, issues, comparison, unclassified, semesterPicks, semesterNotes, courseCheckHtml: courseChecks?.html || "",
    summary: { students: students.length, previousStudents: previousStudents.length, classes, courses: courses.length }
  };
}

function buildResultImportPreview(sheets, options) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error("엑셀에서 시트를 찾지 못했습니다.");
  const candidates = sheets.map((sheet, index) => analyzeResultCandidate({
    ...parseResultSheet(sheet, options),
    sheetIndex: index,
    sheetName: sheet?.name || `${index + 1}번째 시트`
  }, options));
  const selected = Math.max(0, candidates.findIndex((candidate) => !candidate.issues.blocking.length));
  return {
    fileName: options.fileName, round: String(options.round), grade: String(options.grade),
    revision: options.revision, candidates, selected, sheets,
    existingStudents: options.existingStudents || [], roundData: options.roundData || null, roundClosures: options.roundClosures || null,
    mode: options.mode === "partial" ? "partial" : "all"
  };
}

function resultImportElement() {
  return document.getElementById("resultImportPreview");
}

function clearResultImportPreview() {
  resultImportPending = null;
  const container = resultImportElement();
  if (!container) return;
  container.replaceChildren();
  container.classList.add("hidden");
}

function showResultImportPreview(preview) {
  resultImportPending = preview;
  renderResultImportPreview();
}

function renderResultImportPreview() {
  const container = resultImportElement();
  const preview = resultImportPending;
  if (!container || !preview) return;
  const candidate = preview.candidates[preview.selected];
  const esc = typeof escapeHtml === "function" ? escapeHtml : (value) => String(value ?? "");
  const formatLabel = candidate.format === "form" ? "차수·선택과목 목록 형식" : candidate.format === "wide" ? "학생별 과목 표시 형식" : "형식 확인 불가";
  const sheetPicker = preview.candidates.length > 1
    ? `<label class="result-import-sheet">시트 <select id="resultImportSheet">${preview.candidates.map((item, index) =>
      `<option value="${index}"${index === preview.selected ? " selected" : ""}>${esc(item.sheetName)}${item.issues.blocking.length ? " (읽을 수 없음)" : ""}</option>`).join("")}</select></label>`
    : "";
  const list = (items, className, title) => items.length
    ? `<div class="result-import-issues ${className}"><strong>${title} ${items.length}건</strong><ul>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div>`
    : "";
  const summary = candidate.summary
    ? `<p class="result-import-summary">${esc(resultCurrentLabel(preview.grade))} <b>${candidate.summary.previousStudents ? `${candidate.summary.previousStudents}명 → ` : ""}${candidate.summary.students}명</b> · 반 ${candidate.summary.classes}개 · 과목 ${candidate.summary.courses}개</p>`
    : "";
  const blocked = candidate.issues.blocking.length > 0;
  const changed = candidate.comparison.filter((row) => row.before === null || row.before !== row.after);
  const comparisonRows = candidate.comparison.map((row) => {
    const delta = row.before === null ? "" : row.after - row.before;
    const deltaText = delta === "" ? "신규" : delta > 0 ? `+${delta}` : delta < 0 ? String(delta) : "-";
    return `<tr${delta !== "" && delta !== 0 ? ' class="is-changed"' : ""}><th scope="row">${esc(row.name)}</th><td>${row.semester ? `${row.semester}학기` : ""}</td><td>${row.before === null ? "" : row.before}</td><td>${row.after}</td><td>${deltaText}</td></tr>`;
  }).join("");
  const comparison = candidate.comparison.length
    ? `<details class="result-import-compare"${candidate.summary?.previousStudents ? " open" : ""}><summary>과목별 신청 인원${candidate.summary?.previousStudents ? ` · 기존 결과 대비 변화 ${changed.length}과목` : ""}</summary>
      <div class="aggregate-sheet-wrap"><table class="result-import-table"><thead><tr><th scope="col">과목</th><th scope="col">학기</th><th scope="col">기존</th><th scope="col">새 결과</th><th scope="col">변화</th></tr></thead><tbody>${comparisonRows}</tbody></table></div></details>`
    : "";
  const warningCount = candidate.issues.warnings.length;
  const errorCount = (candidate.issues.errors || []).length;
  // 재신청 결과 올리기 방식(사용자 결정): '학년 전원 파일'(그 학년 통째로) / '재신청한 학생만 있는 파일'(파일 학생만 바꿈, 학년·반·번호로 맞춤).
  const existing = (preview.existingStudents || []).filter((student) => String(student.grade) === String(preview.grade));
  const partialCounts = !blocked && existing.length && preview.mode === "partial" && typeof roundMergeGradeStudents === "function" && preview.roundData
    ? roundMergeGradeStudents(preview.roundData, preview.roundClosures || {}, preview.grade, candidate.data).counts : null;
  const modeBox = !blocked && existing.length
    ? `<fieldset class="result-import-mode" id="resultImportMode"><legend>올리는 방식</legend>
        <label><input type="radio" name="resultImportMode" value="all"${preview.mode !== "partial" ? " checked" : ""}> 학년 전원 파일 <small>(${esc(resultCurrentLabel(preview.grade))} ${existing.length}명을 이 파일 ${candidate.summary?.students || 0}명으로 바꿈)</small></label>
        <label><input type="radio" name="resultImportMode" value="partial"${preview.mode === "partial" ? " checked" : ""}> 재신청한 학생만 있는 파일 <small>(파일에 있는 학생만 바꾸고 나머지는 그대로 · 학년·반·번호로 맞춤)</small></label>
        ${partialCounts ? `<p class="result-import-mode-counts" id="resultImportModeCounts">바뀌는 학생 ${partialCounts.changed}명 · 그대로 ${partialCounts.kept + partialCounts.same}명${partialCounts.same ? `(파일에 있으나 같음 ${partialCounts.same}명)` : ""}${partialCounts.added ? ` · 추가 ${partialCounts.added}명(전입 등)` : ""}</p>` : ""}
      </fieldset>` : "";
  container.innerHTML = `<div class="result-import-head">
      <div><strong>결과 파일 검증 · ${esc(preview.round)}차 ${esc(resultCurrentLabel(preview.grade))}</strong><span>${esc(preview.fileName)} · ${formatLabel}</span></div>
      ${sheetPicker}
    </div>
    ${summary}
    ${modeBox}
    ${!blocked && typeof twoSemesterPickMarkup === "function" ? twoSemesterPickMarkup(candidate.semesterPicks, preview.grade, candidate.semesterNotes) : ""}
    ${list(candidate.issues.blocking, "is-blocking", "반영할 수 없는 오류")}
    ${list(candidate.issues.errors || [], "is-blocking is-error", "오류 · 확인 후 반영할 수 있음")}
    ${list(candidate.issues.warnings, "is-warning", "확인이 필요한 경고")}
    ${list(candidate.issues.info, "is-info", "참고")}
    ${candidate.courseCheckHtml || ""}
    ${comparison}
    ${candidate.issues.actions?.length ? `<div class="result-import-fixes"><span>설정을 고친 뒤 파일을 다시 올리지 않고 아래 버튼으로 다시 검증할 수 있습니다.</span>${candidate.issues.actions.map((action) =>
      `<button class="button" type="button" data-result-import-fix="${esc(action.target)}">${esc(action.label)}</button>`).join("")}<button class="button" id="revalidateResultImport" type="button">다시 검증</button></div>` : ""}
    <div class="result-import-actions">
      <button class="button button-primary" id="confirmResultImport" type="button"${blocked ? " disabled" : ""}>${errorCount ? `오류 ${errorCount}건 확인 후 결과 반영` : warningCount ? `경고 ${warningCount}건 확인 후 결과 반영` : "결과 반영"}</button>
      <button class="button" id="cancelResultImport" type="button">취소</button>
    </div>`;
  container.classList.remove("hidden");
}

async function confirmResultImport() {
  const preview = resultImportPending;
  if (!preview) return;
  const candidate = preview.candidates[preview.selected];
  // 개설 학기를 고르지 않은 두 학기 편성 과목: 추정한 학기로 반영할지 묻고, 그 학기를 저장해 다시 검증한 뒤 반영한다.
  const unpicked = (candidate?.issues?.blocking?.length ? [] : candidate?.semesterPicks || []).filter((item) => !item.pick && item.estimate);
  // 고른 값은 차수마다 따로 저장한다(재신청 차수 파일은 동시 개설 과목도 한 학기분만 나올 수 있음).
  if (unpicked.length && typeof setCourseSemesterPick === "function") {
    const target = Number(preview.grade) + 1;
    const text = `개설 학기를 고르지 않은 두 학기 편성 과목 ${unpicked.length}개:\n` +
      unpicked.map((item) => `· ${item.name} → ${target}학년 ${item.estimate}학기(추천 · ${item.basis})`).join("\n") +
      `\n\n추천한 학기로 그 과목을 신청한 학생 전부를 넣어 반영할까요? 4단계 과목 메뉴 '개설 학기 바꾸기'에서 나중에 바꿀 수 있습니다.`;
    const ok = typeof appConfirm === "function"
      ? await appConfirm(text, { title: "개설 학기 확인", ok: "추천한 학기로 반영", cancel: "돌아가서 고르기" })
      : window.confirm(text);
    if (!ok || resultImportPending !== preview) return;
    for (const item of unpicked) setCourseSemesterPick(preview.grade, item.name, item.estimate, undefined, preview.round);
    revalidateResultImport();
    if (!resultImportPending || resultImportPending === preview) return;
    return confirmResultImport();
  }
  // 빨간 오류(같은 과목 두 학기 신청 등)는 자료를 버리지 않고, 앱 확인 창으로 한 번 더 묻고 반영한다.
  const errors = candidate?.issues?.errors || [];
  if (errors.length && !candidate.issues.blocking.length) {
    const text = `${errors.join("\n\n")}\n\n그대로 반영할까요? (자료는 버리지 않습니다.)`;
    const ok = typeof appConfirm === "function"
      ? await appConfirm(text, { title: "오류가 있는 결과 반영", ok: "반영", cancel: "취소" })
      : window.confirm(text);
    if (!ok || resultImportPending !== preview) return;
  }
  try {
    if (!candidate || candidate.issues.blocking.length) throw new Error("오류가 있는 시트는 반영할 수 없습니다.");
    if (state.currentRound !== preview.round) throw new Error("미리보기 이후 차수가 바뀌었습니다. 해당 차수에서 다시 업로드하세요.");
    if ((state.applicationMenuGrade || "1") !== preview.grade) throw new Error("미리보기 이후 학년 메뉴가 바뀌었습니다. 해당 학년에서 다시 업로드하세요.");
    if (state.applicationImportRevision !== preview.revision) throw new Error("미리보기 이후 차수 데이터가 삭제되었습니다. 다시 업로드하세요.");
    if (typeof isRoundLocked === "function" && isRoundLocked(preview.round)) throw new Error(`${preview.round}차는 확정된 차수입니다. 확정을 해제한 뒤 다시 업로드하세요.`);
  } catch (error) {
    clearResultImportPreview();
    status.style.color = "#a44939";
    status.textContent = error instanceof Error ? error.message : "결과를 반영하지 못했습니다.";
    return;
  }
  const unclassified = candidate.unclassified || [];
  let carry;
  try {
    carry = storeGradeResults(candidate.data, preview.fileName, preview.grade, { partial: preview.mode === "partial" }) || { kept: 0, dropped: 0 };
  } catch (error) {
    // 저장 공간 부족 같은 일시적 오류에서는 검증한 미리보기를 유지해 다시 시도할 수 있게 한다.
    status.style.color = "#a44939";
    status.textContent = error instanceof Error ? error.message : "결과를 반영하지 못했습니다.";
    return;
  }
  clearResultImportPreview();
  if (typeof renderWorkspaceContext === "function") renderWorkspaceContext();
  if (typeof suggestWorkspaceBackup === "function") suggestWorkspaceBackup("결과 반영");
  status.style.color = "#287956";
  status.textContent = (carry.partial
    ? `${preview.round}차 ${resultCurrentLabel(preview.grade)}: 재신청한 학생 ${carry.partial.changed}명을 반영했습니다(그대로 ${carry.partial.kept + carry.partial.same}명${carry.partial.added ? ` · 추가 ${carry.partial.added}명` : ""}). 다른 학년 결과는 유지됩니다.`
    : `${preview.round}차 ${resultCurrentLabel(preview.grade)} ${candidate.summary.students}명을 반영했습니다. 다른 학년 결과는 유지됩니다.`) +
    (carry.kept ? ` 기존 학급 수·개설 결정 등 ${carry.kept}건을 이어서 적용했습니다.` : "") +
    (carry.dropped ? ` 새 결과에 없는 과목의 설정 ${carry.dropped}건은 해제했습니다.` : "") +
    (unclassified.length ? ` 그룹 미확인 ${resultTargetLabel(preview.grade)} ${unclassified.length}개.` : "");
}

function revalidateResultImport() {
  const previous = resultImportPending;
  if (!previous?.sheets) return;
  if (state.currentRound !== previous.round || (state.applicationMenuGrade || "1") !== previous.grade ||
      state.applicationImportRevision !== previous.revision) {
    clearResultImportPreview();
    status.style.color = "#a44939";
    status.textContent = "차수·학년·결과 데이터가 바뀌어 다시 검증할 수 없습니다. 파일을 다시 업로드하세요.";
    return;
  }
  const preview = buildResultImportPreview(previous.sheets, {
    ...resultImportOptions(previous.grade),
    fileName: previous.fileName, round: previous.round, grade: previous.grade, revision: previous.revision
  });
  preview.mode = previous.mode;
  const keep = preview.candidates[previous.selected];
  if (keep && !keep.issues.blocking.length) preview.selected = previous.selected;
  showResultImportPreview(preview);
  const candidate = preview.candidates[preview.selected];
  status.style.color = "#596780";
  status.textContent = candidate.issues.blocking.length
    ? `다시 검증했지만 반영할 수 없습니다: ${candidate.issues.blocking[0]}`
    : `다시 검증했습니다. 경고 ${candidate.issues.warnings.length}건입니다.`;
}

function initResultImport() {
  const container = resultImportElement();
  if (!container) return;
  container.addEventListener("click", (event) => {
    const fix = event.target.closest("[data-result-import-fix]");
    if (fix) {
      if (fix.dataset.resultImportFix === "curriculum" && typeof switchWorkflowStep === "function") switchWorkflowStep(1);
      else if (typeof openApplicationWorkspaceTab === "function") openApplicationWorkspaceTab("groups");
      status.style.color = "#596780";
      status.textContent = "설정을 고친 뒤 2단계 '결과' 탭의 검증 화면에서 '다시 검증'을 누르세요. 업로드한 파일은 유지됩니다.";
      return;
    }
    if (event.target.closest("#revalidateResultImport")) revalidateResultImport();
    else if (event.target.closest("#confirmResultImport")) confirmResultImport();
    else if (event.target.closest("#cancelResultImport")) {
      clearResultImportPreview();
      status.style.color = "#596780";
      status.textContent = "결과 반영을 취소했습니다. 기존 결과는 그대로입니다.";
    }
  });
  container.addEventListener("change", (event) => {
    if (event.target.name === "resultImportMode" && resultImportPending) {
      resultImportPending.mode = event.target.value === "partial" ? "partial" : "all";
      renderResultImportPreview();
      resultImportElement()?.querySelector(`input[name="resultImportMode"][value="${resultImportPending.mode}"]`)?.focus({ preventScroll: true });
      return;
    }
    const pick = event.target.closest?.("[data-semester-pick]");
    if (pick && resultImportPending && typeof setCourseSemesterPick === "function") {
      setCourseSemesterPick(resultImportPending.grade, pick.dataset.semesterPickName || pick.dataset.semesterPick, pick.value, undefined, resultImportPending.round);
      revalidateResultImport();
      const name = pick.dataset.semesterPickName || "";
      status.style.color = "#596780";
      status.textContent = `${name}: ${Number(resultImportPending?.grade || 1) + 1}학년 ${pick.value}학기로 정하고 다시 검증했습니다.`;
      resultImportElement()?.querySelector(`[data-semester-pick="${CSS.escape(pick.dataset.semesterPick)}"][value="${pick.value}"]`)?.focus({ preventScroll: true });
      return;
    }
    if (event.target.id !== "resultImportSheet" || !resultImportPending) return;
    resultImportPending.selected = Math.max(0, Math.min(resultImportPending.candidates.length - 1, Number(event.target.value) || 0));
    renderResultImportPreview();
  });
}

if (typeof document !== "undefined" && document.getElementById) initResultImport();
