"use strict";
var curriculumVersionView = null;

function curriculumCellNumber(value) {
  const text = String(value ?? "").replace(/\s+/g, "");
  return /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : 0;
}

function cleanCurriculumSubjectName(name) {
  return String(name ?? "").replace(/↔/g, " ").replace(/^[*＊★☆■\s]+|[*＊★☆■\s]+$/g, "").replace(/\s+/g, " ").trim();
}

function curriculumCohortLayout(year) {
  year = String(year);
  const annualYear = year.match(/^annual:(\d{4})$/)?.[1];
  if (annualYear) {
    if (state.curriculumPlanType === "annual" && String(state.curriculumCohortYear) === annualYear) {
      return state.curriculumImportedLayout || null;
    }
    return state.curriculumAnnualPlans?.[annualYear]?.importedLayout || null;
  }
  if (state.curriculumPlanType !== "annual" &&
      String(state.curriculumCohortYear) === year && state.curriculumImportedLayout) return state.curriculumImportedLayout;
  return state.curriculumCohorts?.[year]?.importedLayout || null;
}

function activeCurriculumVersionKey() {
  return typeof curriculumPlanVersionKey === "function"
    ? curriculumPlanVersionKey()
    : state.curriculumPlanType === "annual"
      ? `annual:${state.curriculumCohortYear}`
      : String(state.curriculumCohortYear);
}

function curriculumVersionScopeLabel(key) {
  const annualYear = String(key).match(/^annual:(\d{4})$/)?.[1];
  return annualYear
    ? `${annualYear}학년도 전학년 편제표`
    : `${key}학년도 신입생 3개년 편제표`;
}

// 편제표 레이아웃에서 학년·학기별 과목 항목을 읽는다. 병합된 과목 행(택n·교차집중 아래 숫자 행)과
// 학기 칸 메모(소인수/공동 ○학년 ○학기 ○학점)를 해석하고, 소계·창체 행은 제외한다.
function curriculumPlanEntries(layout) {
  const result = { entries: [], issues: [] };
  if (!layout || !Array.isArray(layout.rows) || !layout.rows.length) return result;
  const columns = importedPlanColumnMap(layout);
  if (columns.subject < 0) {
    result.issues.push("편제표에서 과목명 열을 찾지 못했습니다.");
    return result;
  }
  if (!columns.semesters.some((column) => column >= 0)) {
    result.issues.push("편제표에서 학년·학기 열(1학년 1학기 ~ 3학년 2학기)을 찾지 못했습니다.");
    return result;
  }
  const rows = expandCurriculumLayoutRows(layout);
  const compact = (value) => String(value ?? "").replace(/\s+/g, "");
  const creditOf = (row, column) => column >= 0 ? curriculumCellNumber(row[column]) : 0;
  const contexts = importedPlanCourseContexts(layout, columns);
  const choiceSheetMerges = typeof curriculumSheetMerges === "function"
    ? curriculumSheetMerges(layout).filter((merge) => merge.kind !== "plain") : [];
  // 원본 양식의 '택n' 묶음 안에는 자기 학점 칸이 비어 있는 과목 행이 있다. 묶음 학점으로 그 학기에 편성된 것으로 본다.
  const choiceBlocks = typeof curriculumChoiceBlocks === "function" ? curriculumChoiceBlocks(layout, columns) : [];
  const contextRows = new Set(contexts.map((context) => context.rowIndex));
  const firstSemesterColumn = Math.min(...columns.semesters.filter((column) => column >= 0));
  // 과목명 칸이 비어 있고 앞쪽 열에 자기 값이 없는 바로 아래 행(택n·교차집중 아래 숫자 행)은 같은 과목으로 본다.
  const hasOwnLabel = (row) => {
    for (let column = 0; column < firstSemesterColumn; column++) {
      if (String(row?.[column] ?? "").trim() && !row?._mergedFillColumns?.has(column)) return true;
    }
    return false;
  };
  for (const context of contexts) {
    const subjectText = compact(context.subject);
    if (/소계|창의적체험|총이수|이수학점|합계|과목명|세부과목|교육과정|표기방법/.test(subjectText)) continue;
    if (["공통", "일반", "진로", "융합"].includes(subjectText)) continue;
    const names = context.subject.split(/[,，、]/).map(cleanCurriculumSubjectName).filter(Boolean);
    if (!names.length) continue;
    let endRow = context.rowIndex;
    while (endRow - context.rowIndex < 3 && endRow + 1 < rows.length && !contextRows.has(endRow + 1) &&
      !hasOwnLabel(rows[endRow + 1])) endRow++;
    const spanRows = [];
    for (let rowIndex = context.rowIndex; rowIndex <= endRow; rowIndex++) spanRows.push(rows[rowIndex] || []);
    const valuesAt = (column) => column < 0 ? [] : spanRows.map((row) => String(row[column] ?? "").trim()).filter(Boolean);
    const credit = creditOf(context.row, columns.opCredit) || creditOf(context.row, columns.baseCredit) ||
      creditOf(context.row, columns.genericCredit);
    const divisionText = compact(context.division);
    const division = divisionText.includes("학생선택") ? "학생선택" : divisionText.includes("학교지정") ? "학교지정" : "";
    const semesterTexts = columns.semesters.flatMap((column) => valuesAt(column));
    const choiceTag = semesterTexts.join(" ").match(/택\s*\d+/)?.[0]?.replace(/\s+/g, "") || "";
    const crossed = /교차/.test(semesterTexts.join(" ")) || context.subject.includes("↔");
    const area = String(context.area || "").replace(/↔/g, " ").replace(/\s+/g, " ").trim();
    const base = { area, division, detail: context.selectionType || "", names: names.length, crossed, choiceTag, rowIndex: context.rowIndex };
    const note = semesterTexts.find((value) => /[123]\s*학년/.test(value) && /학기/.test(value));
    if (note) {
      const kind = /공동/.test(note) ? "공동" : /소인수/.test(note) ? "소인수" : "";
      const grade = note.match(/([123])\s*학년/)?.[1] || "";
      const semesters = (note.match(/([12](?:\s*[,·]\s*[12])*)\s*학기/)?.[1] || "").split(/[,·]/).map((part) => part.trim()).filter(Boolean);
      const noteCredit = Number(note.match(/(\d+(?:\.\d+)?)\s*학점/)?.[1]) || credit;
      if (!grade || !semesters.length) {
        result.issues.push(`${names.join(", ")}: 학기 칸 메모 '${note}'의 학년·학기를 읽지 못했습니다.`);
        continue;
      }
      for (const semester of semesters) {
        names.forEach((subject, nameIndex) => result.entries.push({
          ...base, grade, semester, subject, nameIndex, credit: noteCredit, creditSource: "note", note,
          kind: kind || (division === "학생선택" || choiceTag ? "선택" : "지정")
        }));
      }
      continue;
    }
    columns.semesters.forEach((column, index) => {
      const values = valuesAt(column);
      const sheetMerge = choiceSheetMerges.find((merge) =>
        column >= merge.startColumn && column <= merge.endColumn &&
        context.rowIndex >= merge.startRow && context.rowIndex <= merge.endRow);
      const block = sheetMerge ? null : choiceBlocks.find((item) => item.column === column &&
        context.rowIndex >= item.startRow && context.rowIndex <= item.endRow && Number(item.credit) > 0);
      if (!sheetMerge && !block && (!values.length || values.every((value) => /^[-–—]+$/.test(value) || /^0(?:\.0+)?$/.test(value)))) return;
      const numeric = values.map(curriculumCellNumber).find((value) => value > 0);
      const readable = values.every((value) => curriculumCellNumber(value) > 0 || /택\s*\d+|교차|[-–—]/.test(value));
      if (!sheetMerge && !block && !numeric && !readable) {
        result.issues.push(`${names.join(", ")} ${Math.floor(index / 2) + 1}학년 ${(index % 2) + 1}학기 칸 '${values[0]}'을(를) 숫자로 읽지 못해 운영학점 ${credit}을(를) 사용했습니다.`);
      }
      names.forEach((subject, nameIndex) => result.entries.push({
        ...base,
        crossed: sheetMerge ? sheetMerge.kind === "cross" : /교차/.test(values.join(" ")) || context.subject.includes("↔"),
        grade: String(Math.floor(index / 2) + 1),
        semester: String((index % 2) + 1),
        subject,
        nameIndex,
        credit: sheetMerge?.credit || numeric || (!values.length && block ? block.credit : credit),
        creditSource: numeric ? "semester" : !values.length && block ? "block" : "credit",
        kind: sheetMerge || block || division === "학생선택" || choiceTag ? "선택" : "지정"
      }));
    });
  }
  return result;
}

function curriculumVersionPlanRows(year) {
  year = String(year);
  const annualYear = year.match(/^annual:(\d{4})$/)?.[1];
  if (annualYear) {
    return state.curriculumPlanType === "annual" && String(state.curriculumCohortYear) === annualYear
      ? state.curriculumPlan
      : state.curriculumAnnualPlans?.[annualYear]?.plan || [];
  }
  return state.curriculumPlanType !== "annual" && String(state.curriculumCohortYear) === year
    ? state.curriculumPlan
    : state.curriculumCohorts?.[year]?.plan || [];
}

function compactCurriculumEntries(layout, planRows = []) {
  const semesterFields = ["sem11", "sem12", "sem21", "sem22", "sem31", "sem32"];
  const groupAssignments = new Map();
  for (const row of planRows) {
    const subject = normalizeResultCourseName(row.subject);
    if (!subject) continue;
    for (const [index, field] of semesterFields.entries()) {
      if (!String(row[field] || "").trim()) continue;
      const explicit = row.semesterGroups && Object.prototype.hasOwnProperty.call(row.semesterGroups, field);
      const group = explicit ? row.semesterGroups[field] : row.bundleName
        ? { name: row.bundleName, pick: row.bundlePick }
        : null;
      if (!group) continue;
      const semester = String((index % 2) + 1);
      groupAssignments.set(`${row.grade}|${semester}|${subject}`, {
        group: String(group.name || ""),
        pick: Math.max(0, Number(group.pick) || 0)
      });
    }
  }
  return curriculumPlanEntries(layout).entries.map((entry) => ({
    g: entry.grade, s: entry.semester, n: entry.subject, c: entry.credit, k: entry.kind, a: entry.area, t: entry.detail, crossed: entry.crossed,
    ...(groupAssignments.get(`${entry.grade}|${entry.semester}|${normalizeResultCourseName(entry.subject)}`) || {})
  }));
}

function curriculumVersionSnapshot(layout, plan, fileName, templateRows = plan) {
  const copy = JSON.parse(JSON.stringify(layout));
  delete copy.changeBaseline;
  delete copy.changeBaselineError;
  return { layout: copy, plan: JSON.parse(JSON.stringify(plan)),
    templateRows: JSON.parse(JSON.stringify(templateRows)), fileName: String(fileName || "") };
}

function latestCurriculumSavedVersion(year = activeCurriculumVersionKey()) {
  return (state.curriculumVersions?.[year] || []).filter((version) => version.snapshot?.layout?.rows).at(-1) || null;
}

function curriculumSavedBaseline(snapshot, id, savedAt) {
  return {
    version: 2, rows: JSON.parse(JSON.stringify(snapshot.layout.rows)),
    mergedRanges: [...(snapshot.layout.mergedRanges || [])],
    choiceBlockRanges: JSON.parse(JSON.stringify(snapshot.layout.choiceBlockRanges || [])),
    sheetMerges: JSON.parse(JSON.stringify(snapshot.layout.sheetMerges || [])),
    plan: JSON.parse(JSON.stringify(snapshot.plan)),
    source: "saved", versionId: id, savedAt
  };
}

function recordCurriculumVersion(year, layout, { reason = "", basis = "", fileName = "", auto = false, rollbackOf = "" } = {}) {
  year = String(year);
  if (!/^(?:\d{4}|annual:\d{4})$/.test(year) || !layout) return null;
  const planRows = curriculumVersionPlanRows(year);
  const plan = compactCurriculumEntries(layout, planRows);
  if (!plan.length) return null;
  state.curriculumVersions ||= {};
  const versions = Array.isArray(state.curriculumVersions[year]) ? state.curriculumVersions[year] : [];
  const latest = versions.at(-1);
  const active = year === activeCurriculumVersionKey();
  const data = year.startsWith("annual:")
    ? state.curriculumAnnualPlans?.[year.slice(7)] : state.curriculumCohorts?.[year];
  const snapshot = curriculumVersionSnapshot(layout, planRows, fileName,
    active ? state.curriculumTemplateRows || [] : data?.templateRows || []);
  if (auto && latest?.snapshot && JSON.stringify(latest.snapshot) === JSON.stringify(snapshot)) return null;
  const now = new Date();
  const version = {
    id: `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    savedAt: now.toISOString(),
    reason: String(reason).trim().slice(0, 200),
    basis: String(basis).trim().slice(0, 200),
    fileName: String(fileName || "").slice(0, 200),
    auto: Boolean(auto),
    plan, snapshot, ...(rollbackOf ? { rollbackOf } : {})
  };
  versions.push(version);
  state.curriculumVersions[year] = versions;
  return version;
}

function saveCurriculumDraftVersion({ reason, basis = "" }) {
  if (typeof isWorkspaceStorageProtected === "function" && isWorkspaceStorageProtected()) throw new Error("저장 원본을 먼저 복원하세요.");
  if (!String(reason || "").trim()) throw new Error("변경 사유를 입력하세요.");
  const year = activeCurriculumVersionKey();
  const layout = state.curriculumImportedLayout;
  if (!layout) throw new Error("저장할 편제표가 없습니다.");
  const before = layout.changeBaseline;
  const versions = [...(state.curriculumVersions?.[year] || [])];
  const version = recordCurriculumVersion(year, layout, { reason, basis, fileName: state.curriculumPlanFileName });
  if (!version) throw new Error("편제표의 과목 항목을 읽지 못했습니다.");
  layout.changeBaseline = curriculumSavedBaseline(version.snapshot, version.id, version.savedAt);
  if (!persistState()) {
    state.curriculumVersions[year] = versions;
    if (before) layout.changeBaseline = before;
    else delete layout.changeBaseline;
    throw new Error("새 시점을 저장하지 못했습니다. 초안은 유지됩니다. 저장 경고를 확인하고 다시 시도하세요.");
  }
  return version;
}

function rollbackCurriculumVersion(id) {
  if (typeof isWorkspaceStorageProtected === "function" && isWorkspaceStorageProtected()) throw new Error("저장 원본을 먼저 복원하세요.");
  const year = activeCurriculumVersionKey();
  const versions = [...(state.curriculumVersions?.[year] || [])];
  const source = versions.find((version) => version.id === id);
  if (!source?.snapshot?.layout?.rows) throw new Error("이전 요약 이력에는 전체 편제표가 없어 롤백할 수 없습니다.");
  const before = {
    layout: state.curriculumImportedLayout, plan: state.curriculumPlan,
    templateRows: state.curriculumTemplateRows, fileName: state.curriculumPlanFileName
  };
  const restored = JSON.parse(JSON.stringify(source.snapshot));
  state.curriculumImportedLayout = restored.layout;
  state.curriculumPlan = restored.plan;
  state.curriculumTemplateRows = restored.templateRows || JSON.parse(JSON.stringify(restored.plan));
  state.curriculumPlanFileName = restored.fileName;
  try {
    const version = recordCurriculumVersion(year, restored.layout, {
      reason: `${curriculumVersionLabel(source)} 시점으로 롤백`,
      fileName: restored.fileName, rollbackOf: source.id
    });
    if (!version) throw new Error("롤백할 편제표를 읽지 못했습니다.");
    restored.layout.changeBaseline = curriculumSavedBaseline(version.snapshot, version.id, version.savedAt);
    if (!persistState()) throw new Error("롤백 시점을 저장하지 못했습니다. 기존 초안과 확정본을 유지합니다.");
    state.curriculumMutationRevision += 1;
    state.curriculumUndoStack = [];
    return version;
  } catch (error) {
    state.curriculumVersions[year] = versions;
    state.curriculumImportedLayout = before.layout;
    state.curriculumPlan = before.plan;
    state.curriculumTemplateRows = before.templateRows;
    state.curriculumPlanFileName = before.fileName;
    if (typeof syncActiveCurriculumCohort === "function") syncActiveCurriculumCohort();
    throw error;
  }
}

function curriculumEntryKey(entry) {
  return `${entry.g}|${entry.s}|${normalizeResultCourseName(entry.n)}`;
}

function diffCurriculumPlans(before, after) {
  const beforeMap = new Map(before.map((entry) => [curriculumEntryKey(entry), entry]));
  const afterMap = new Map(after.map((entry) => [curriculumEntryKey(entry), entry]));
  let added = [];
  let removed = [];
  const changed = [];
  for (const [key, entry] of afterMap) {
    const previous = beforeMap.get(key);
    if (!previous) {
      added.push(entry);
      continue;
    }
    const details = [];
    if (previous.c !== entry.c) details.push(`학점 ${previous.c} → ${entry.c}`);
    if (previous.k !== entry.k) details.push(`${previous.k || "구분 없음"} → ${entry.k || "구분 없음"}`);
    if (previous.a !== entry.a) details.push(`교과군 ${previous.a || "미지정"} → ${entry.a || "미지정"}`);
    if (previous.t !== undefined && previous.t !== entry.t) details.push(`과목 종류 ${previous.t || "미지정"} → ${entry.t || "미지정"}`);
    if (Boolean(previous.crossed) !== Boolean(entry.crossed)) details.push(entry.crossed ? "교차집중 추가" : "교차집중 제거");
    if ((previous.group || "") !== (entry.group || "")) {
      details.push(`선택 그룹 ${previous.group || "미지정"} → ${entry.group || "미지정"}`);
    }
    if ((previous.pick ?? null) !== (entry.pick ?? null)) {
      details.push(`선택 수 ${previous.pick ?? "미지정"} → ${entry.pick ?? "미지정"}`);
    }
    if (details.length) changed.push({ entry, details });
  }
  for (const [key, entry] of beforeMap) if (!afterMap.has(key)) removed.push(entry);
  const moved = [];
  for (const from of removed) {
    const to = added.find((entry) => entry.g === from.g && normalizeResultCourseName(entry.n) === normalizeResultCourseName(from.n));
    if (!to) continue;
    moved.push({ from, to });
    added = added.filter((entry) => entry !== to);
  }
  removed = removed.filter((entry) => !moved.some((move) => move.from === entry));
  return { added, removed, changed, moved };
}

function curriculumChangeImpact(year, diff) {
  if (String(year).startsWith("annual:")) return null;
  const currentGrade = String(Number($("#schoolYear").value) - Number(year) + 1);
  if (currentGrade !== "1" && currentGrade !== "2") return null;
  const targetGrade = String(Number(currentGrade) + 1);
  const affected = [...diff.removed, ...diff.moved.map((move) => move.from)].filter((entry) => entry.g === targetGrade);
  if (!affected.length) return { currentGrade, round: "", count: 0, subjects: [] };
  const rounds = applicationRoundNumbers().slice().reverse();
  const round = rounds.find((item) => roundStatusData(item)?.students?.some((student) => String(student.grade) === currentGrade));
  if (!round) return { currentGrade, round: "", count: 0, subjects: affected.map((entry) => entry.n) };
  const targets = affected.map((entry) => ({ name: normalizeResultCourseName(entry.n), semester: entry.s }));
  const count = roundStatusData(round).students.filter((student) => String(student.grade) === currentGrade &&
    (student.selections || []).some((selection) => {
      const name = normalizeResultCourseName(selection.applicationSubject?.subject || selection.name);
      const semester = resultCourseSemester(selection);
      return targets.some((target) => target.name === name && (!semester || semester === target.semester));
    })).length;
  return { currentGrade, round, count, subjects: affected.map((entry) => entry.n) };
}

function curriculumDiffRows(diff) {
  const label = (entry) => `${entry.g}학년 ${entry.s}학기`;
  return [
    ...diff.added.map((entry) => ["추가", label(entry), entry.n, `${entry.k || ""} ${entry.c}학점`.trim()]),
    ...diff.removed.map((entry) => ["삭제", label(entry), entry.n, `${entry.k || ""} ${entry.c}학점`.trim()]),
    ...diff.moved.map(({ from, to }) => ["학기 이동", `${label(from)} → ${label(to)}`, to.n, from.c !== to.c ? `학점 ${from.c} → ${to.c}` : ""]),
    ...diff.changed.map(({ entry, details }) => ["변경", label(entry), entry.n, details.join(", ")])
  ];
}

function curriculumVersionLabel(version) {
  const date = new Date(version.savedAt);
  return Number.isNaN(date.getTime()) ? "저장 시각 미상" : date.toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

function resolveCurriculumComparison(year) {
  if (!curriculumVersionView || curriculumVersionView.year !== year) return null;
  const versions = state.curriculumVersions?.[year] || [];
  const index = versions.findIndex((version) => version.id === curriculumVersionView.id);
  if (index < 0) return null;
  const version = versions[index];
  if (curriculumVersionView.mode === "previous") {
    const previous = versions[index - 1];
    if (!previous) return null;
    return { title: `${curriculumVersionLabel(previous)} 이력 → ${curriculumVersionLabel(version)} 이력`, diff: diffCurriculumPlans(previous.plan, version.plan) };
  }
  const layout = curriculumCohortLayout(year);
  if (!layout) return null;
  return { title: `${curriculumVersionLabel(version)} 이력 → 현재 편제표`,
    diff: diffCurriculumPlans(version.plan, compactCurriculumEntries(layout, curriculumVersionPlanRows(year))) };
}

function renderCurriculumVersions() {
  const list = document.getElementById("curriculumVersionsList");
  if (!list) return;
  const year = activeCurriculumVersionKey();
  const versions = Array.isArray(state.curriculumVersions?.[year]) ? state.curriculumVersions[year] : [];
  const scopeLabel = curriculumVersionScopeLabel(year);
  document.getElementById("curriculumVersionsCount").textContent = versions.length
    ? `${scopeLabel} · ${versions.length}개`
    : `${scopeLabel} · 저장된 이력 없음`;
  document.getElementById("saveCurriculumVersion").disabled = !state.curriculumImportedLayout;
  list.innerHTML = versions.length
    ? `<div class="aggregate-sheet-wrap"><table class="closure-table curriculum-versions-table"><thead><tr><th scope="col">저장 시각</th><th scope="col">변경 사유</th><th scope="col">근거</th><th scope="col">파일</th><th scope="col">과목 항목</th><th scope="col">비교</th></tr></thead><tbody>${
      versions.map((version, index) => ({ version, index })).reverse().map(({ version, index }) => `<tr>
        <td>${escapeHtml(curriculumVersionLabel(version))}</td>
        <td class="closure-subject">${escapeHtml(version.reason || "-")}${version.auto ? ' <span class="count-pill">자동</span>' : ""}</td>
        <td class="closure-subject">${escapeHtml(version.basis || "-")}</td>
        <td class="closure-subject">${escapeHtml(version.fileName || "-")}</td>
        <td>${version.plan.length}</td>
        <td class="curriculum-version-actions"><button class="button button-quiet" type="button" data-version-compare="${escapeHtml(version.id)}" data-version-mode="current">현재와 비교</button>${
          index > 0 ? `<button class="button button-quiet" type="button" data-version-compare="${escapeHtml(version.id)}" data-version-mode="previous">직전 이력과 비교</button>` : ""
        }${version.snapshot?.layout ? `<button class="button button-quiet" type="button" data-version-rollback="${escapeHtml(version.id)}">이 시점으로 롤백</button>` : '<span class="note">이전 요약 이력 · 롤백 불가</span>'}</td>
      </tr>`).join("")
    }</tbody></table></div>`
    : '<p class="note">아직 저장된 이력이 없습니다. 편제표를 업로드하면 자동으로 저장됩니다.</p>';
  const diffPanel = document.getElementById("curriculumVersionsDiff");
  const comparison = resolveCurriculumComparison(year);
  if (!comparison) {
    diffPanel.innerHTML = "";
    return;
  }
  const { diff } = comparison;
  const rows = curriculumDiffRows(diff);
  const impact = curriculumChangeImpact(year, diff);
  const impactText = !impact
    ? ""
    : impact.count
      ? `<p class="storage-warning">현 ${impact.currentGrade}학년 ${impact.round}차 신청 결과 중 삭제·학기 이동 과목을 신청한 학생이 ${impact.count}명 있습니다. 재신청 또는 변경 안내가 필요한지 확인하세요.</p>`
      : impact.subjects.length && !impact.round
        ? `<p class="note">현 ${impact.currentGrade}학년 신청 결과가 없어 학생 영향은 계산하지 않았습니다.</p>`
        : "";
  diffPanel.innerHTML = `<div class="curriculum-diff-head"><h5>${escapeHtml(comparison.title)}</h5>
      <span>추가 ${diff.added.length} · 삭제 ${diff.removed.length} · 학기 이동 ${diff.moved.length} · 변경 ${diff.changed.length}</span>
      <button class="button" type="button" data-version-export="1"${rows.length ? "" : " disabled"}>변경 내역 엑셀</button></div>
    ${impactText}
    ${rows.length
      ? `<div class="aggregate-sheet-wrap"><table class="closure-table"><thead><tr><th scope="col">구분</th><th scope="col">학년·학기</th><th scope="col">과목</th><th scope="col">내용</th></tr></thead><tbody>${
        rows.map((row) => `<tr class="curriculum-diff-${row[0] === "추가" ? "added" : row[0] === "삭제" ? "removed" : "changed"}">${
          row.map((cell, index) => `<td${index === 2 ? ' class="closure-subject"' : ""}>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")
      }</tbody></table></div>`
      : '<p class="note">과목·학기·학점 변경이 없습니다.</p>'}`;
}

function exportCurriculumVersionDiff() {
  const year = activeCurriculumVersionKey();
  const scopeLabel = curriculumVersionScopeLabel(year);
  const comparison = resolveCurriculumComparison(year);
  if (!comparison) return;
  const rows = curriculumDiffRows(comparison.diff);
  downloadBlob(createWorkbookBlob([{
    name: "변경 내역",
    widths: [12, 22, 34, 30],
    merges: ["A1:D1", "A2:D2"],
    rows: [
      [{ v: `${scopeLabel} 변경 내역`, s: 1 }],
      [{ v: comparison.title, s: 8 }],
      [{ v: "구분", s: 2 }, { v: "학년·학기", s: 2 }, { v: "과목", s: 2 }, { v: "내용", s: 2 }],
      ...rows.map((row) => row.map((value, index) => ({ v: value, s: index === 2 || index === 3 ? 3 : 4 })))
    ]
  }]), `${year.replace(":", "-")}_편제표_변경내역.xlsx`);
}

function initCurriculumVersions() {
  const panel = document.getElementById("curriculumVersionsPanel");
  if (!panel) return;
  document.getElementById("saveCurriculumVersion").addEventListener("click", () => {
    const reasonInput = document.getElementById("curriculumVersionReason");
    const basisInput = document.getElementById("curriculumVersionBasis");
    const year = activeCurriculumVersionKey();
    const scopeLabel = curriculumVersionScopeLabel(year);
    if (!state.curriculumImportedLayout) return;
    if (!reasonInput.value.trim()) {
      status.style.color = "#a44939";
      status.textContent = "변경 사유를 입력한 뒤 이력에 저장하세요.";
      reasonInput.focus();
      return;
    }
    try {
      saveCurriculumDraftVersion({ reason: reasonInput.value, basis: basisInput.value });
    } catch (error) {
      status.style.color = "#a44939";
      status.textContent = `시점 저장 실패: ${error.message}`;
      return;
    }
    reasonInput.value = "";
    basisInput.value = "";
    renderCurriculumStep();
    status.style.color = "#287956";
    status.textContent = `${scopeLabel}의 새 시점을 저장했습니다. 이전 확정본은 보존되며 비교 기준이 마지막 저장본으로 바뀌었습니다.`;
  });
  panel.addEventListener("click", (event) => {
    const compare = event.target.closest("[data-version-compare]");
    if (compare) {
      curriculumVersionView = { year: activeCurriculumVersionKey(), id: compare.dataset.versionCompare, mode: compare.dataset.versionMode };
      renderCurriculumVersions();
      return;
    }
    if (event.target.closest("[data-version-export]")) {
      exportCurriculumVersionDiff();
      return;
    }
    const rollback = event.target.closest("[data-version-rollback]");
    if (rollback) {
      if (!window.confirm("이 시점의 편제표를 복사해 새로운 최신 확정본으로 저장할까요? 현재 초안은 교체되며, 기존 확정본들은 모두 보존됩니다.")) return;
      try {
        rollbackCurriculumVersion(rollback.dataset.versionRollback);
        renderCurriculumStep();
        renderWorkspaceContext();
        status.style.color = "#287956";
        status.textContent = "과거 편제표를 복사해 새 롤백 시점으로 저장했습니다. 기존 시점은 모두 보존됩니다.";
      } catch (error) {
        status.style.color = "#a44939";
        status.textContent = `롤백 실패: ${error.message}`;
      }
    }
  });
  document.getElementById("openCurriculumVersionSave").addEventListener("click", () => {
    state.curriculumTopCollapsed = false;
    renderCurriculumStep();
    panel.open = true;
    document.getElementById("curriculumVersionReason").focus();
    scheduleCurriculumTableSize();
  });
  renderCurriculumVersions();
}

if (typeof document !== "undefined" && document.getElementById) initCurriculumVersions();
