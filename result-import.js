"use strict";
var resultImportPending = null;

function normalizeResultCourseName(name) {
  return String(name ?? "")
    .replace(/[*＊★☆■↔]/g, "")
    .replace(/[（(]\s*[12]\s*학기\s*[)）]/g, "")
    .replace(/[（(]\s*[123]\s*학년\s*[)）]/g, "")
    .replace(/[（(]\s*(?:일반|진로|융합)(?:선택)?\s*[)）]/g, "")
    .replace(/[·ㆍ•‧]/g, "")
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

function sortResultStudents(students) {
  return students.sort((a, b) =>
    Number(a.grade) - Number(b.grade) || Number(a.classroom) - Number(b.classroom) ||
    Number(a.number) - Number(b.number) || String(a.name).localeCompare(String(b.name), "ko"));
}

// 시트 하나를 결과 자료로 변환한다. 실패해도 예외 대신 error를 담아 돌려준다.
function parseResultSheet(sheet, options) {
  const rows = sheet?.rows || [];
  const grade = String(options.grade);
  const base = { format: "", data: null, error: "", otherGradeCount: 0, skippedRows: [] };
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
    if (!gradeRows.length) return { ...base, error: `현재 ${grade}학년 학생이 없는 결과 파일입니다. 해당 학년 메뉴에서 업로드하세요.` };
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
    data = createRecords(rows);
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : "결과표 형식을 읽지 못했습니다." };
  }
  const students = data.students.filter((student) => String(student.grade) === grade);
  base.otherGradeCount = data.students.length - students.length;
  base.skippedRows = data.skippedRows || [];
  if (!students.length) return { ...base, error: `현재 ${grade}학년 학생이 없는 결과 파일입니다. 해당 학년 메뉴에서 업로드하세요.` };
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

function analyzeResultCandidate(candidate, options) {
  const issues = { blocking: [], warnings: [], info: [], actions: [] };
  const addAction = (target, label) => {
    if (!issues.actions.some((action) => action.target === target)) issues.actions.push({ target, label });
  };
  if (candidate.error) {
    issues.blocking.push(candidate.error);
    return { ...candidate, issues, comparison: [], summary: null };
  }
  const grade = String(options.grade);
  const targetGrade = String(Number(grade) + 1);
  const students = candidate.data.students;
  const courses = candidate.data.courses.filter((course) =>
    !course.applicationCurrentGrade || course.applicationCurrentGrade === grade);

  const seats = new Map();
  const duplicates = [];
  for (const student of students) {
    const key = resultSeatKey(student);
    if (seats.has(key)) duplicates.push(`${student.classroom}반 ${student.number}번`);
    else seats.set(key, student);
  }
  if (duplicates.length) {
    issues.warnings.push(`같은 반·번호가 두 번 이상 나옵니다(${duplicates.length}건: ${resultExampleList(duplicates)}). 학생 수와 과목 인원이 부풀려질 수 있으니 원본을 확인하세요.`);
  }
  const summaryRows = candidate.skippedRows.filter((row) => /학년·반·번호·성명/.test(row.reason));
  const brokenRows = candidate.skippedRows.filter((row) => !summaryRows.includes(row));
  if (brokenRows.length) {
    issues.warnings.push(`학생 정보가 빠져 제외한 행 ${brokenRows.length}개: ${resultExampleList(brokenRows.map((row) => `${row.row}행(${row.reason})`))}.`);
  }
  if (summaryRows.length) issues.info.push(`학생 정보가 없는 합계·빈 행 ${summaryRows.length}개는 제외했습니다.`);
  const empty = students.filter((student) => !student.selections.length);
  if (empty.length) {
    issues.warnings.push(`선택 과목이 없는 학생 ${empty.length}명: ${resultExampleList(empty.map((student) => `${student.classroom}-${student.number} ${student.name}`))}. 재적 학생 수에는 포함되지만 과목 인원에는 반영되지 않습니다.`);
  }

  const curriculum = options.subjects?.[targetGrade] || [];
  if (curriculum.length) {
    const curriculumNames = new Set(curriculum.map((item) => normalizeResultCourseName(item.subject)));
    const fileNames = new Set(courses.map((course) => normalizeResultCourseName(course.name)));
    const unknown = courses.filter((course) => !curriculumNames.has(normalizeResultCourseName(course.name)));
    if (unknown.length) {
      issues.warnings.push(`${targetGrade}학년 편제표에 없는 과목 ${unknown.length}개: ${resultExampleList(unknown.map((course) => course.name))}. 과목명이 편제표와 다르면 그룹 분류와 시수 통계 연결이 끊어지니 편제표 또는 파일의 과목명을 맞추세요.`);
      addAction("curriculum", "1단계 편제표 확인");
    }
    const missing = curriculum.filter((item) => !fileNames.has(normalizeResultCourseName(item.subject)));
    if (missing.length) issues.info.push(`편제표의 ${targetGrade}학년 선택 과목 중 결과 파일에 없는 과목 ${missing.length}개: ${resultExampleList(missing.map((item) => item.subject))}.`);
  } else {
    issues.info.push(`${targetGrade}학년 편제표 과목을 찾지 못해 과목명 대조를 건너뛰었습니다. 1단계에서 해당 입학연도 편제표를 확인하세요.`);
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
  try {
    unclassified = classifyApplicationRecords(candidate.data);
  } catch (error) {
    issues.info.push(`과목 그룹 분류를 건너뛰었습니다(${error instanceof Error ? error.message : "설정 확인 필요"}).`);
  }
  if (unclassified.length) {
    issues.warnings.push(`선택 그룹이 정해지지 않은 과목 ${unclassified.length}개: ${resultExampleList(unclassified)}. 2단계 과목·그룹 설정에서 그룹에 넣으면 집계표가 그룹별로 정리됩니다.`);
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
      issues.warnings.push(`${label}: ${group.count}과목 선택 기준과 다른 학생 ${mismatched.length}명 (${resultExampleList(mismatched.map(({ student, picked }) => `${student.classroom}-${student.number} ${student.name} ${picked}과목`), 3)}).`);
      addAction("groups", "과목·그룹 설정으로");
    }
  }

  if (candidate.otherGradeCount) issues.info.push(`다른 학년 ${candidate.otherGradeCount}명은 제외했습니다. 해당 학년 메뉴에서 따로 업로드하세요.`);
  const classes = new Set(students.map((student) => String(student.classroom))).size;
  const enrolled = new Set(students.flatMap((student) => student.selections.map((selection) => String(selection.column))));
  const zero = courses.filter((course) => !enrolled.has(String(course.column)));
  if (zero.length) issues.info.push(`신청자가 없는 과목 ${zero.length}개: ${resultExampleList(zero.map((course) => course.name))}.`);

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
    ...candidate, issues, comparison, unclassified,
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
    revision: options.revision, candidates, selected, sheets
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
    ? `<p class="result-import-summary">현재 ${preview.grade}학년 <b>${candidate.summary.previousStudents ? `${candidate.summary.previousStudents}명 → ` : ""}${candidate.summary.students}명</b> · 반 ${candidate.summary.classes}개 · 과목 ${candidate.summary.courses}개</p>`
    : "";
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
  const blocked = candidate.issues.blocking.length > 0;
  const warningCount = candidate.issues.warnings.length;
  container.innerHTML = `<div class="result-import-head">
      <div><strong>결과 파일 검증 · ${esc(preview.round)}차 현재 ${esc(preview.grade)}학년</strong><span>${esc(preview.fileName)} · ${formatLabel}</span></div>
      ${sheetPicker}
    </div>
    ${summary}
    ${list(candidate.issues.blocking, "is-blocking", "반영할 수 없는 오류")}
    ${list(candidate.issues.warnings, "is-warning", "확인이 필요한 경고")}
    ${list(candidate.issues.info, "is-info", "참고")}
    ${comparison}
    ${candidate.issues.actions?.length ? `<div class="result-import-fixes"><span>설정을 고친 뒤 파일을 다시 올리지 않고 아래 버튼으로 다시 검증할 수 있습니다.</span>${candidate.issues.actions.map((action) =>
      `<button class="button" type="button" data-result-import-fix="${esc(action.target)}">${esc(action.label)}</button>`).join("")}<button class="button" id="revalidateResultImport" type="button">다시 검증</button></div>` : ""}
    <div class="result-import-actions">
      <button class="button button-primary" id="confirmResultImport" type="button"${blocked ? " disabled" : ""}>${warningCount ? `경고 ${warningCount}건 확인 후 결과 반영` : "결과 반영"}</button>
      <button class="button" id="cancelResultImport" type="button">취소</button>
    </div>`;
  container.classList.remove("hidden");
}

function confirmResultImport() {
  const preview = resultImportPending;
  if (!preview) return;
  const candidate = preview.candidates[preview.selected];
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
    carry = storeGradeResults(candidate.data, preview.fileName, preview.grade) || { kept: 0, dropped: 0 };
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
  status.textContent = `${preview.round}차 현재 ${preview.grade}학년 ${candidate.summary.students}명을 반영했습니다. 다른 학년 결과는 유지됩니다.` +
    (carry.kept ? ` 기존 학급 수·개설 결정 등 ${carry.kept}건을 이어서 적용했습니다.` : "") +
    (carry.dropped ? ` 새 결과에 없는 과목의 설정 ${carry.dropped}건은 해제했습니다.` : "") +
    (unclassified.length ? ` 그룹 미확인 ${unclassified.length}개.` : "");
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
    if (event.target.id !== "resultImportSheet" || !resultImportPending) return;
    resultImportPending.selected = Math.max(0, Math.min(resultImportPending.candidates.length - 1, Number(event.target.value) || 0));
    renderResultImportPreview();
  });
}

if (typeof document !== "undefined" && document.getElementById) initResultImport();
