"use strict";
// 1단계 편제표 화면(데이터 기반).
// 표는 과목·선택과목군 데이터에서 그린다. 과목 하나가 화면의 한 행이고, 선택과목군은 병합 대신 묶음 띠·테두리로 보인다.
// 머리글·소계 행은 내보내기 양식(planTemplate)에서 가져와 그대로 보여 준다. 원본 양식 서식은 엑셀 내보내기에서 쓴다.
// 이 파일의 화면 함수는 app.js의 렌더링에서 실행 시점에 불리므로 app.js보다 먼저 로드해도 된다.

function planViewEscape(value) {
  return typeof escapeHtml === "function" ? escapeHtml(value)
    : String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function planViewFillStyle(layout, row, column) {
  const fill = layout.cellFills?.[`${row}:${column}`];
  return /^#[0-9A-F]{6}$/i.test(String(fill || "")) ? `background-color:${fill}` : "";
}

function planViewStyleAttribute(...parts) {
  const style = parts.filter(Boolean).join(";");
  return style ? ` style="${style}"` : "";
}

// 표의 병합 목록에서 열마다 세로 병합 구간(시작 행 → 끝 행)을 만든다.
function planViewVerticalSegments(layout) {
  const byColumn = new Map();
  for (const reference of layout.mergedRanges || []) {
    const range = planDataRange(reference);
    if (!range || range.startColumn !== range.endColumn || range.endRow <= range.startRow) continue;
    if (!byColumn.has(range.startColumn)) byColumn.set(range.startColumn, []);
    byColumn.get(range.startColumn).push(range);
  }
  return {
    at(row, column) {
      const found = (byColumn.get(column) || []).find((range) => range.startRow <= row && range.endRow >= row);
      return found ? { start: found.startRow, end: found.endRow } : { start: row, end: row };
    }
  };
}

// 머리글·소계처럼 양식에서 온 행을 그린다. 보이는 행만 남기고 병합은 남은 행 기준으로 다시 맞춘다.
function planViewStaticRows(layout, rowIndexes, width, options = {}) {
  const visible = new Set(rowIndexes);
  const ranges = (layout.mergedRanges || []).map(planDataRange).filter(Boolean)
    .filter((range) => rowIndexes.some((row) => row >= range.startRow && row <= range.endRow));
  const anchor = new Map();
  const covered = new Set();
  for (const range of ranges) {
    const rows = rowIndexes.filter((row) => row >= range.startRow && row <= range.endRow);
    for (const row of rows) for (let column = range.startColumn; column <= range.endColumn; column++) covered.add(`${row}:${column}`);
    if (!rows.length) continue;
    covered.delete(`${rows[0]}:${range.startColumn}`);
    anchor.set(`${rows[0]}:${range.startColumn}`, { rowSpan: rows.length, colSpan: range.endColumn - range.startColumn + 1, source: range.startRow });
  }
  return rowIndexes.filter((row) => visible.has(row)).map((row) => {
    const cells = [];
    for (let column = 0; column < width; column++) {
      const merge = anchor.get(`${row}:${column}`);
      if (!merge && covered.has(`${row}:${column}`)) continue;
      const source = merge ? merge.source : row;
      const value = String(layout.rows[source]?.[column] ?? "");
      const span = merge ? `${merge.rowSpan > 1 ? ` rowspan="${merge.rowSpan}"` : ""}${merge.colSpan > 1 ? ` colspan="${merge.colSpan}"` : ""}` : "";
      const fill = planViewFillStyle(layout, source, column);
      const editable = options.editable?.(source, column);
      if (editable) {
        cells.push(`<td contenteditable="true" spellcheck="false" data-source-row="${source}" data-source-column="${column}" data-plan-footer="${editable}"${span}${planViewStyleAttribute(fill)}>${planViewEscape(value)}</td>`);
      } else {
        cells.push(`<td aria-readonly="true" data-source-row="${source}" data-source-column="${column}"${span}${planViewStyleAttribute(fill)}>${planViewEscape(value)}</td>`);
      }
    }
    const tools = options.tools ? '<td class="curriculum-row-tools" aria-hidden="true"></td>' : "";
    return `<tr class="${options.className || ""}">${cells.join("")}${tools}</tr>`;
  }).join("");
}

function planViewMatchesFilter(subject, layout, filters, entriesById) {
  const entries = entriesById.get(subject.id) || [];
  if (filters.grade && !entries.some((entry) => entry.grade === filters.grade)) return false;
  if (filters.division) {
    const division = typeof normalizeCurriculumDivision === "function"
      ? normalizeCurriculumDivision(String(subject.category || "").replace(/↔/g, " ").trim()) : planDataDivision(subject.category);
    if (division !== filters.division) return false;
  }
  if (filters.area && String(subject.area || "").replace(/↔/g, " ").trim() !== filters.area) return false;
  if (filters.detail && (subject.kind || "") !== filters.detail) return false;
  const query = String(filters.query || "").replace(/↔/g, " ").trim().toLocaleLowerCase();
  if (query) {
    const text = [subject.category, subject.domain, subject.area, subject.kindText, subject.kind, subject.name, subject.note,
      ...Object.values(subject.texts || {})].join(" ").replace(/↔/g, " ").toLocaleLowerCase();
    if (!text.includes(query)) return false;
  }
  return true;
}

// 점검 표시(편성 영역 태그·자동 수정·학점 범위 경고·과목명 확인 필요)를 표에 덧그릴지. 기본은 원본 양식만(꺼짐).
function planViewShowMarks() {
  return typeof state !== "undefined" && Boolean(state.curriculumShowMarks);
}

// 과목명 칸: 과목명 글자(표기 기호 *·★·☆·■, 쉼표·띄어쓰기)를 그대로 보이고, 과목마다 누르면 편성 변경 팝업이 열리는 단추로 감싼다.
function planViewSubjectNamesHtml(subject, changes) {
  const raw = String(subject.name ?? "");
  const marks = planViewShowMarks();
  return raw.split(/([,，、])/).map((part, index) => {
    if (index % 2) return planViewEscape(part);
    const lead = part.match(/^\s*/)[0], tail = part.slice(lead.length).match(/\s*$/)[0];
    const core = part.trim();
    if (!core) return planViewEscape(part);
    const name = planDataSubjectNames(core)[0] || core;
    const key = typeof curriculumChoiceSubjectKey === "function" ? curriculumChoiceSubjectKey(name) : planDataNameKey(name);
    const change = changes?.get?.(key);
    const changeAttributes = change && typeof curriculumChangeAttributes === "function" ? curriculumChangeAttributes([change]) : "";
    const check = marks && typeof curriculumOfficialTypeCheck === "function" ? curriculumOfficialTypeCheck(name, subject.kind || "") : { ok: true };
    const flag = check.ok ? "" : " is-unverified";
    const title = check.ok ? "" : ` title="확인 필요: ${planViewEscape(check.reason)}"`;
    return `${planViewEscape(lead)}<button class="curriculum-subject-name${flag}" ${changeAttributes}${title} type="button" data-curriculum-subject="${planViewEscape(name)}" aria-label="${planViewEscape(name)} 편성 변경${check.ok ? "" : ` (확인 필요: ${planViewEscape(check.reason)})`}">${planViewEscape(core)}</button>${planViewEscape(tail)}`;
  }).join("");
}

// 데이터 기반 편제표 표 HTML. app.js의 curriculumImportedSheetHtml이 데이터가 있는 편제표에서 부른다.
// 웹 화면은 과목 하나가 한 행이고, 선택과목군은 첫 과목 칸의 띠 '택n · m학점'(묶음 테두리), 교차집중은 두 학기에 걸친 띠
// '교차집중 · 음악↔미술 · 학기당 2학점'으로 보인다(구성 과목의 학기 칸은 비움). 원본 양식(서식·'택n' 칸)은 엑셀 내보내기에서만 쓴다.
// 과목명은 표기 기호(* ★ ☆ ■)를 그대로 보이고, 행 메뉴(⋯)는 과목명 칸에 마우스를 올리거나 우클릭할 때 보인다.
function curriculumDataSheetHtml(layout, filters = {}, selectionMode = false, compactView = false, changes = new Map()) {
  const data = layout.planData;
  const template = layout.planTemplate;
  if (!data || !template) return "";
  const columns = template.columns;
  const width = template.width;
  const meta = layout.planRowMeta || [];
  const readOnly = Boolean(layout.derived);
  const semesterColumns = columns.semesters;
  const usedSemesters = semesterColumns.filter((column) => column >= 0);
  const firstSemester = Math.min(...usedSemesters), lastSemester = Math.max(...usedSemesters);
  const semestersContiguous = lastSemester - firstSemester + 1 === usedSemesters.length;
  const hiddenRows = new Set(layout.hiddenRows || []);
  const segments = planViewVerticalSegments(layout);
  const entries = curriculumDataPlanEntries(layout).entries;
  const entriesById = new Map();
  const subjects = planDataSubjects(data);
  const idByRow = new Map(subjects.map((subject) => [subject.row, subject.id]));
  for (const entry of entries) {
    const id = idByRow.get(entry.rowIndex);
    if (!id) continue;
    if (!entriesById.has(id)) entriesById.set(id, []);
    entriesById.get(id).push(entry);
  }
  const activeFilter = Boolean(filters.grade || filters.division || filters.area || filters.detail ||
    String(filters.query || "").replace(/↔/g, " ").trim());
  const visibleItems = data.subjects.filter((item) => !item.hidden &&
    (item.fixed ? !activeFilter : planViewMatchesFilter(item, layout, filters, entriesById)));
  if (typeof document !== "undefined") {
    const count = document.getElementById("curriculumFilterCount");
    if (count) count.textContent = `${visibleItems.filter((item) => !item.fixed).length}개 과목 표시`;
  }
  const headerRows = meta.flatMap((item, index) => item.type === "header" && !hiddenRows.has(index) ? [index] : []);
  const footerRows = meta.flatMap((item, index) => item.type === "footer" && !hiddenRows.has(index) ? [index] : []);
  const headerStart = compactView ? Math.max(0, headerRows.findIndex((row) =>
    (layout.rows[row] || []).some((value) => /세부과목|과목명/.test(String(value))))) : 0;
  const shownHeader = headerRows.slice(headerStart);
  const groups = data.groups || [];
  const groupCell = new Map();
  for (const group of groups) {
    const members = group.members.map((id) => data.subjects.find((item) => item.id === id)).filter(Boolean);
    const visibleMembers = members.filter((member) => visibleItems.includes(member));
    group.fields.forEach((field) => {
      visibleMembers.forEach((member, index) => groupCell.set(`${member.id}:${field}`, {
        group, first: index === 0, last: index === visibleMembers.length - 1, members
      }));
    });
  }
  const blocks = typeof curriculumDataChoiceBlocks === "function" ? curriculumDataChoiceBlocks(layout) : [];
  const blockKey = new Map(blocks.map((block) => [`${block.groupId}:${block.field}`, block.key]));
  const verticalColumns = [];
  for (let column = 0; column < width; column++) {
    if (semesterColumns.includes(column) || column === columns.name || column === columns.base || column === columns.op) continue;
    verticalColumns.push(column);
  }
  const editableColumn = (column) => {
    if (column === columns.required) return "required";
    if ([columns.category, columns.domain, columns.area, columns.kind, columns.completion].includes(column)) return "";
    return `extra:${column}`;
  };
  // 세로로 이어진 칸(구분·교과(군)·과목 종류·이수학점 등)은 보이는 과목 행만으로 rowspan을 다시 센다.
  const segmentCells = new Map();
  for (const column of verticalColumns) {
    let current = null;
    for (const item of visibleItems) {
      if (item.fixed) { current = null; continue; }
      const segment = segments.at(item.row, column);
      if (current && current.start === segment.start && current.end === segment.end) {
        current.count += 1;
        segmentCells.set(`${item.id}:${column}`, null);
        continue;
      }
      current = { ...segment, count: 1, item };
      segmentCells.set(`${item.id}:${column}`, current);
    }
  }
  const colGroup = Array.from({ length: width }, (_, column) => {
    const excelWidth = Number(layout.columnWidths?.[column]);
    const pixels = Number.isFinite(excelWidth) && excelWidth > 0 ? `${Math.max(44, Math.min(360, Math.round(excelWidth * 7 + 12)))}px` : "100px";
    return `<col style="width:${pixels}">`;
  }).join("");
  const bodyRows = visibleItems.map((item) => {
    if (item.fixed) {
      const cells = Array.from({ length: width }, (_, column) =>
        `<td aria-readonly="true"${planViewStyleAttribute(planViewFillStyle(layout, item.row, column))}>${planViewEscape(layout.rows[item.row]?.[column] ?? "")}</td>`).join("");
      return `<tr class="curriculum-fixed-row">${cells}</tr>`;
    }
    const cells = [];
    const rowAttributes = `data-source-row="${item.row}" data-plan-id="${planViewEscape(item.id)}"`;
    const editableCell = (column, field, value, extraClass = "", extraAttributes = "") => {
      const fill = planViewFillStyle(layout, item.row, column);
      const classes = extraClass ? ` class="${extraClass}"` : "";
      if (readOnly) return `<td aria-readonly="true"${classes} data-source-row="${item.row}" data-source-column="${column}"${extraAttributes}${planViewStyleAttribute(fill)}>${planViewEscape(value)}</td>`;
      return `<td contenteditable="true" spellcheck="false"${classes} data-source-row="${item.row}" data-source-column="${column}" data-plan-id="${planViewEscape(item.id)}" data-plan-field="${field}"${extraAttributes}${planViewStyleAttribute(fill)}>${planViewEscape(value)}</td>`;
    };
    for (let column = 0; column < width; column++) {
      if (column === columns.name) {
        const menu = readOnly ? "" : `<button type="button" class="curriculum-row-menu-button" data-plan-row-menu="${planViewEscape(item.id)}" aria-haspopup="menu" title="위에 과목 추가 · 위/아래로 이동 · 삭제 · 편성 영역(행에서 우클릭해도 열립니다)" aria-label="${planViewEscape(item.name)} 행 메뉴">⋯</button>`;
        cells.push(`<td class="curriculum-subject-cell" ${rowAttributes} data-source-column="${column}"${planViewStyleAttribute(planViewFillStyle(layout, item.row, column))}>${planViewSubjectNamesHtml(item, changes)}${menu}</td>`);
        continue;
      }
      if (column === columns.base || column === columns.op) {
        const value = column === columns.op && item.opFormula ? layout.rows[item.row]?.[column] ?? "" : item[column === columns.base ? "base" : "op"];
        cells.push(editableCell(column, column === columns.base ? "base" : "op", value));
        continue;
      }
      if (semesterColumns.includes(column)) {
        const field = PLAN_DATA_FIELDS[semesterColumns.indexOf(column)];
        if (item.note && semestersContiguous) {
          if (column !== firstSemester) continue;
          const span = lastSemester - firstSemester + 1;
          const cell = editableCell(column, "note", item.note, "curriculum-note-cell", ` colspan="${span}"`);
          cells.push(cell);
          continue;
        }
        const group = groupCell.get(`${item.id}:${field}`);
        const selectable = !readOnly
          ? ` data-choice-column="${column}" data-choice-start="${item.row}" data-choice-end="${item.rowEnd}" data-choice-end-column="${column}" data-display-row="${item.row}"`
          : "";
        if (selectionMode && !readOnly) {
          const label = group ? (group.first ? `택${group.group.pick} · ${planDataNumberText(planDataGroupCredit(data, group.group))}학점` : "")
            : Object.hasOwn(item.credits || {}, field) ? planDataNumberText(item.credits[field]) : item.texts?.[field] || "";
          const groupClass = group ? ` curriculum-group-cell${group.first ? " is-group-first" : ""}${group.last ? " is-group-last" : ""}` : "";
          cells.push(`<td tabindex="0" role="button" aria-pressed="false" class="curriculum-selectable-cell${groupClass}" data-choice-selectable data-source-row="${item.row}" data-source-column="${column}"${selectable} aria-label="${planViewEscape(item.name)} ${field.slice(3, 4)}-${field.slice(4, 5)} 칸 선택">${planViewEscape(label) || "&nbsp;"}</td>`);
          continue;
        }
        if (group) {
          const classes = `curriculum-group-cell${group.first ? " is-group-first" : ""}${group.last ? " is-group-last" : ""}`;
          const info = planDataGroupCreditInfo(data, group.group);
          const label = `${planDataFieldLabel(group.group.fields)} 택${group.group.pick} · ${planDataNumberText(info.credit)}학점`;
          const key = blockKey.get(`${group.group.id}:${field}`) || "";
          const creditHint = info.from === "op"
            ? ` · 학기 칸에 학점이 없어 계산에는 구성 과목 운영학점 ${planDataNumberText(info.credit)}을(를) 씁니다${info.note ? `(${info.note})` : ""}` : "";
          const check = info.note ? ' <span class="curriculum-group-check" aria-label="학점 확인 필요">확인</span>' : "";
          const band = group.first
            ? `<button type="button" class="curriculum-group-band${info.note ? " is-credit-check" : ""}${info.from === "op" ? " is-credit-fallback" : ""}" data-plan-group="${planViewEscape(group.group.id)}" title="${planViewEscape(label)}: ${planViewEscape(group.members.map((member) => member.name).join(" / "))}${planViewEscape(creditHint)} · 누르면 택 수·학점 변경·교차집중으로 바꾸기·묶음 풀기"${readOnly ? " disabled" : ""}>택${group.group.pick} · ${planViewEscape(planDataNumberText(info.credit))}학점${check}</button>`
            : "";
          // 띠의 위·아래 끝 손잡이: 끌어서 묶음 범위(구성 과목)를 늘리거나 줄인다.
          const handle = (edge) => readOnly ? "" : `<span class="curriculum-group-handle is-${edge}" data-group-handle="${edge}" data-group-id="${planViewEscape(group.group.id)}" title="${edge === "top" ? "위" : "아래"} 끝을 끌어 묶음 범위 늘리기·줄이기"></span>`;
          cells.push(`<td class="${classes}" data-source-row="${item.row}" data-source-column="${column}"${selectable} data-plan-group-cell="${planViewEscape(group.group.id)}"${group.first ? ` data-choice-block="${planViewEscape(key)}"` : ""} title="${planViewEscape(label)}">${group.first ? handle("top") : ""}${band}${group.last ? handle("bottom") : ""}</td>`);
          continue;
        }
        const crossFields = PLAN_DATA_FIELDS.filter((item2) => item.cross?.includes(item2));
        if (crossFields.includes(field)) {
          // 교차집중: 두 학기에 걸친 띠 하나(학생이 고르는 묶음이 아니라 반마다 학기를 엇갈려 이수).
          const crossColumns = crossFields.map((item2) => semesterColumns[PLAN_DATA_FIELDS.indexOf(item2)]);
          const adjacent = crossColumns.every((item2, index) => index === 0 || item2 === crossColumns[index - 1] + 1) &&
            crossColumns.every((item2) => !groupCell.has(`${item.id}:${PLAN_DATA_FIELDS[semesterColumns.indexOf(item2)]}`));
          if (adjacent && column !== crossColumns[0]) continue;
          const label = planDataCrossLabel(item);
          const names = planDataSubjectNames(item.name);
          const title = `${label}: 학생이 고르는 과목이 아니라 반마다 한 학기는 ${names[0] || ""}, 다른 학기는 ${names.slice(1).join("·")}을(를) 이수합니다. 과목당 ${planDataNumberText(item.credits?.[crossFields[0]] || 0)}학점(학기당 한 번만 셉니다).${readOnly ? "" : " 누르면 학기당 학점 변경·선택과목군으로 바꾸기"}`;
          const span = adjacent && crossColumns.length > 1 ? ` colspan="${crossColumns.length}"` : "";
          const band = `<button type="button" class="curriculum-cross-band" data-plan-cross="${planViewEscape(item.id)}" title="${planViewEscape(title)}"${readOnly ? " disabled" : ""}>${planViewEscape(label)}</button>`;
          cells.push(`<td class="curriculum-cross-cell is-cross" data-source-row="${item.row}" data-source-column="${column}"${span}${selectable} title="${planViewEscape(title)}">${band}</td>`);
          continue;
        }
        const value = Object.hasOwn(item.credits || {}, field) ? planDataNumberText(item.credits[field]) : item.texts?.[field] || "";
        cells.push(editableCell(column, field, value, "", selectable));
        continue;
      }
      const segment = segmentCells.get(`${item.id}:${column}`);
      if (segment === null) continue;
      const span = segment && segment.count > 1 ? ` rowspan="${segment.count}"` : "";
      const sourceRow = segment ? segment.start : item.row;
      const value = layout.rows[sourceRow]?.[column] ?? "";
      const field = editableColumn(column);
      const formula = Object.hasOwn(layout.formulas || {}, `${sourceRow}:${column}`);
      if (field && !formula && !readOnly) {
        cells.push(`<td contenteditable="true" spellcheck="false" data-source-row="${item.row}" data-source-column="${column}" data-plan-id="${planViewEscape(item.id)}" data-plan-field="${field}"${span}${planViewStyleAttribute(planViewFillStyle(layout, sourceRow, column))}>${planViewEscape(value)}</td>`);
      } else {
        const hint = column === columns.kind ? ' title="과목 종류는 2022 개정 교육과정 과목 목록의 고정 분류이므로 수정할 수 없습니다."'
          : column === columns.completion ? ' title="이수학점은 학기 학점 합계 수식입니다."'
            : [columns.category, columns.domain, columns.area].includes(column) ? ' title="구분·교과(군)은 과목명을 눌러 바꿀 수 있습니다."' : "";
        cells.push(`<td aria-readonly="true" data-source-row="${sourceRow}" data-source-column="${column}"${span}${hint}${planViewStyleAttribute(planViewFillStyle(layout, sourceRow, column))}>${planViewEscape(value)}</td>`);
      }
    }
    return `<tr class="curriculum-data-row${item.added ? " is-added" : ""}" data-plan-row="${planViewEscape(item.id)}">${cells.join("")}</tr>`;
  }).join("");
  if (typeof renderWorkspaceContext === "function") renderWorkspaceContext();
  const footerEditable = readOnly ? null : (row, column) => {
    if (Object.hasOwn(layout.formulas || {}, `${row}:${column}`)) return "";
    const first = meta.findIndex((item) => item.type === "footer");
    return first >= 0 ? `${row - first}:${column}` : "";
  };
  const header = planViewStaticRows(layout, shownHeader, width, { className: "curriculum-data-header" });
  const footer = planViewStaticRows(layout, footerRows, width, { className: "curriculum-footer-row", editable: footerEditable });
  const classes = ["curriculum-source-table", "is-band-form", planViewShowMarks() ? "show-plan-marks" : ""].filter(Boolean).join(" ");
  return `<div class="curriculum-imported-sheet curriculum-data-sheet" aria-label="${planViewEscape(layout.sheetName || "불러온 편제표")}"><table class="${classes}"><colgroup>${colGroup}</colgroup><thead class="curriculum-data-head">${header}</thead><tbody>${bodyRows}${footer}</tbody></table></div>`;
}

// ---- 편집 동작: 모든 편집은 데이터를 바꾸고 표를 다시 그린다. 실행취소·자동 저장·변경 음영은 기존 흐름을 그대로 쓴다.

// build(layout)는 { layout } 을 돌려준다. 성공하면 상태에 반영하고 다시 그린다.
function commitCurriculumDataEdit(build, message, options = {}) {
  try {
    if (typeof isWorkspaceStorageProtected === "function" && isWorkspaceStorageProtected()) throw new Error("저장 원본을 먼저 복원하세요.");
    const current = state.curriculumImportedLayout;
    if (!current?.planData) throw new Error("편제표를 먼저 업로드하세요.");
    const before = options.before || curriculumSnapshot();
    const { layout } = build(current);
    const plan = curriculumPlanFromLayout(layout, `${state.curriculumPlanFileName} ${layout.sheetName || ""}`, state.curriculumPlan);
    if (!options.undoRecorded) recordCurriculumUndo(before);
    else state.curriculumMutationRevision = (Number(state.curriculumMutationRevision) || 0) + 1;
    state.curriculumImportedLayout = layout;
    state.curriculumPlan = plan;
    syncCurriculumTemplateRows();
    state.curriculumEditBefore = null;
    state.curriculumEditUndoRecorded = false;
    renderCurriculumDataKeepingScroll(options.focus);
    if (typeof planComplianceChanged === "function") planComplianceChanged();
    if (Number(state.workflowStep) === 2 && typeof renderApplicationSubjects === "function") renderApplicationSubjects();
    const saved = persistState();
    status.style.color = saved ? "#287956" : "#a44939";
    status.textContent = saved ? message : `${message} 다만 저장하지 못했습니다. 상단 저장 경고를 확인하세요.`;
    if (options.toast !== false && typeof showAppToast === "function") showAppToast(saved ? message : status.textContent, saved ? "success" : "error");
    return true;
  } catch (error) {
    const text = error?.message || String(error);
    status.style.color = "#a44939";
    status.textContent = text;
    if (typeof showAppToast === "function") showAppToast(text, "error");
    if (options.rerenderOnError) renderCurriculumDataKeepingScroll();
    return false;
  }
}

function renderCurriculumDataKeepingScroll(focus = null) {
  const wrap = document.getElementById("curriculumPlanWrap");
  const sheet = wrap?.querySelector(".curriculum-imported-sheet");
  const scroll = wrap ? [wrap.scrollTop, wrap.scrollLeft, sheet?.scrollTop || 0, sheet?.scrollLeft || 0] : null;
  renderCurriculumStep();
  if (!wrap || !scroll) return;
  const nextSheet = wrap.querySelector(".curriculum-imported-sheet");
  [wrap.scrollTop, wrap.scrollLeft] = scroll;
  if (nextSheet) [nextSheet.scrollTop, nextSheet.scrollLeft] = scroll.slice(2);
  if (focus) wrap.querySelector(focus)?.focus({ preventScroll: true });
}

// app.js의 칸 편집(focusout)에서 부른다. 학점·메모·기준/운영학점·필수이수·소계 아래 칸을 데이터로 고친다.
function applyCurriculumDataCellEdit(cell, nextCell = null) {
  const layout = state.curriculumImportedLayout;
  if (!layout?.planData || !cell) return false;
  const text = cell.innerText.replace(/\r\n?/g, "\n").trim();
  const focus = nextCell && nextCell !== cell
    ? `[contenteditable='true'][data-source-row="${nextCell.dataset.sourceRow}"][data-source-column="${nextCell.dataset.sourceColumn}"]` : null;
  // 원본 양식의 학점 숫자 칸: 선택과목군(택n 아래 학점) → 묶음 학점, 교차집중(↔ 아래 학점) → 학기당 학점.
  if (cell.dataset.planGroupCredit) {
    const group = layout.planData.groups.find((item) => item.id === cell.dataset.planGroupCredit);
    if (!group) return false;
    commitCurriculumDataEdit((current) => curriculumDataUpdateGroup(current, group.id, { pick: group.pick, credit: text }),
      `${planDataFieldLabel(group.fields)} 택${group.pick} 묶음 학점을 ${text}학점으로 바꿨습니다.`, { undoRecorded: true, rerenderOnError: true, focus, toast: false });
    return true;
  }
  if (cell.dataset.planCrossCredit) {
    commitCurriculumDataEdit((current) => curriculumDataSetCrossCredit(current, cell.dataset.planCrossCredit, text),
      `교차집중 학기당 학점을 ${text}학점으로 바꿨습니다.`, { undoRecorded: true, rerenderOnError: true, focus, toast: false });
    return true;
  }
  const target = cell.dataset.planFooter ? { footer: cell.dataset.planFooter } : { id: cell.dataset.planId, field: cell.dataset.planField };
  if (!target.footer && (!target.id || !target.field)) return false;
  commitCurriculumDataEdit((current) => curriculumDataSetCell(current, target, text),
    "편제표 수정 내용과 소계를 반영해 저장했습니다.", { undoRecorded: true, rerenderOnError: true, focus, toast: false });
  return true;
}

let curriculumGroupDialogContext = null;

function curriculumGroupMembersText(layout, ids) {
  const byId = new Map(layout.planData.subjects.map((item) => [item.id, item]));
  return ids.map((id) => byId.get(id)?.name).filter(Boolean).join(" / ");
}

// 묶기(선택 범위) 또는 기존 묶음 변경 팝업을 연다.
function openCurriculumGroupDialog(context) {
  const layout = state.curriculumImportedLayout;
  if (!layout?.planData) return;
  const dialog = document.getElementById("curriculumGroupDialog");
  const field = (name) => document.getElementById(`curriculumGroup${name}`);
  let fields, members, pick, credit;
  if (context.groupId) {
    const group = layout.planData.groups.find((item) => item.id === context.groupId);
    if (!group) return;
    fields = group.fields; members = group.members; pick = group.pick; credit = planDataGroupCredit(layout.planData, group);
    field("Title").textContent = `선택과목군 ${planDataGroupLabel(group)}`;
    field("Release").classList.remove("hidden");
    field("Cross").classList.toggle("hidden", !planDataCrossCandidates(layout.planData, group) || planDataNamesCount(layout.planData, group.members) < 2);
    field("Apply").textContent = "적용";
  } else {
    fields = planDataSelectionFields(layout.planTemplate, context.selection);
    members = planDataSelectionSubjects(layout.planData, context.selection).map((item) => item.id);
    if (!fields.length || !members.length) {
      if (typeof showAppToast === "function") showAppToast("학기 열(1-1 ~ 3-2)에서 과목 칸을 드래그해 고르세요.", "error");
      return;
    }
    const existing = layout.planData.groups.find((group) => group.fields.some((item) => fields.includes(item)) &&
      group.members.some((id) => members.includes(id)));
    const credits = members.flatMap((id) => fields.map((item) => layout.planData.subjects.find((subject) => subject.id === id)?.credits?.[item]))
      .filter((value) => Number(value) > 0);
    // 새 묶음 기본값: 택 수 = 고른 과목 수 − 1(최소 1), 학점 = 칸의 학점 → 구성 과목 운영학점(여러 학기면 학기 수로 나눔)
    const names = planDataNamesCount(layout.planData, members);
    const first = layout.planData.subjects.find((item) => item.id === members[0]);
    const op = (planDataNumber(first?.op) || planDataNumber(first?.base) || 0) / Math.max(1, fields.length);
    pick = existing?.pick || Math.max(1, names - 1);
    credit = (existing ? planDataGroupCredit(layout.planData, existing) : 0) || credits[0] || op || 4;
    field("Title").textContent = `선택과목군으로 묶기 · ${planDataFieldLabel(fields)}`;
    field("Release").classList.add("hidden");
    field("Cross").classList.add("hidden");
    field("Apply").textContent = "묶기";
  }
  curriculumGroupDialogContext = { ...context, fields, members };
  const group = context.groupId ? layout.planData.groups.find((item) => item.id === context.groupId) : null;
  const info = group ? planDataGroupCreditInfo(layout.planData, group) : null;
  const creditHint = info?.from === "op" ? ` · 학기 칸에 학점이 없어 계산에는 구성 과목 운영학점을 씁니다.${info.note ? ` ${info.note}` : ""} 맞는지 확인하고 적용하세요(적용하면 이 학점이 저장됩니다).` : "";
  field("Members").textContent = `${planDataFieldLabel(fields)} · 구성 과목 ${planDataNamesCount(layout.planData, members)}개: ${curriculumGroupMembersText(layout, members)}${creditHint}`;
  field("Pick").value = String(pick);
  field("Credit").value = String(credit);
  field("Error").textContent = "";
  refreshCurriculumGroupPreview();
  dialog.showModal();
  field("Pick").focus();
  field("Pick").select?.();
}

function refreshCurriculumGroupPreview() {
  const context = curriculumGroupDialogContext;
  if (!context) return;
  const pick = Number(document.getElementById("curriculumGroupPick").value);
  const credit = Number(document.getElementById("curriculumGroupCredit").value);
  const label = planDataFieldLabel(context.fields);
  document.getElementById("curriculumGroupPreview").textContent = Number.isFinite(pick) && Number.isFinite(credit)
    ? `${label} 택${pick} · ${planDataNumberText(credit)}학점 → 학기 이수 ${planDataNumberText(pick * credit)}학점(엑셀 수식으로 연결)` : "";
}

function applyCurriculumGroupDialog(release = false) {
  const context = curriculumGroupDialogContext;
  if (!context) return;
  const values = { pick: document.getElementById("curriculumGroupPick").value, credit: document.getElementById("curriculumGroupCredit").value };
  const error = document.getElementById("curriculumGroupError");
  const build = release ? (layout) => curriculumDataUpdateGroup(layout, context.groupId, { remove: true })
    : context.groupId ? (layout) => curriculumDataUpdateGroup(layout, context.groupId, values)
      : (layout) => curriculumDataGroupSelection(layout, context.selection, values);
  try {
    build(state.curriculumImportedLayout);
  } catch (problem) {
    error.textContent = problem?.message || String(problem);
    return;
  }
  document.getElementById("curriculumGroupDialog").close();
  curriculumGroupDialogContext = null;
  const label = `${planDataFieldLabel(context.fields)} 택${values.pick} · ${values.credit}학점`;
  const message = release ? `${planDataFieldLabel(context.fields)} 선택과목군을 풀었습니다. 구성 과목은 각자 묶음 학점으로 편성됩니다.`
    : context.groupId ? `선택과목군을 ${label}으로 바꿨습니다.` : `선택과목군 ${label}으로 묶었습니다.`;
  if (commitCurriculumDataEdit(build, message) && !context.groupId) leaveCurriculumSelectionMode();
}

// 선택과목군 → 교차집중
function convertCurriculumGroupToCross() {
  const context = curriculumGroupDialogContext;
  if (!context?.groupId) return;
  const layout = state.curriculumImportedLayout;
  const group = layout?.planData?.groups.find((item) => item.id === context.groupId);
  if (!group) return;
  const error = document.getElementById("curriculumGroupError");
  const build = (current) => curriculumDataGroupToCross(current, context.groupId);
  let subject = null;
  try { subject = build(layout).result; } catch (problem) { error.textContent = problem?.message || String(problem); return; }
  document.getElementById("curriculumGroupDialog").close();
  curriculumGroupDialogContext = null;
  commitCurriculumDataEdit(build, `${planDataFieldLabel(subject.cross)} ${planDataSubjectNames(subject.name).join("↔")}을(를) 교차집중으로 바꿨습니다. 학생이 고르는 과목이 아니므로 2단계 선택 그룹에서 빠집니다.`);
}

let curriculumCrossDialogTarget = null;

// 교차집중 띠를 누르면 여는 팝업: 학기당 학점 변경, 선택과목군(택1)으로 바꾸기.
function openCurriculumCrossDialog(id) {
  const layout = state.curriculumImportedLayout;
  const subject = layout?.planData?.subjects.find((item) => item.id === id);
  if (!subject?.cross?.length || layout.derived) return;
  curriculumCrossDialogTarget = id;
  const field = (name) => document.getElementById(`curriculumCross${name}`);
  const names = planDataSubjectNames(subject.name);
  field("Title").textContent = `교차집중 · ${planDataFieldLabel(PLAN_DATA_FIELDS.filter((item) => subject.cross.includes(item)))}`;
  field("Members").textContent = `${names.join(" ↔ ")}: 학생이 고르는 과목이 아니라 반마다 한 학기는 ${names[0] || ""}, 다른 학기는 ${names.slice(1).join("·")}을(를) 이수합니다. 과목당 학점은 학기당 학점 한 번이고, 학기 합계에도 한 번만 셉니다.`;
  field("Credit").value = String(Math.max(0, ...subject.cross.map((item) => Number(subject.credits?.[item]) || 0)) || planDataNumber(subject.op) || "");
  field("Error").textContent = "";
  renderCurriculumCrossSplit(subject);
  refreshCurriculumCrossPreview();
  document.getElementById("curriculumCrossDialog").showModal();
  field("Credit").focus();
}

// 교차집중 학년의 학급 수(5단계 시수 설정의 그 학년도 학급 수). 모르면 null.
function curriculumCrossClassTotal(subject) {
  const grade = Number(planDataGrade(subject?.cross?.[0] || "")) || 0;
  const cohort = Number(state.curriculumCohortYear) || 0;
  if (!grade || !cohort || state.curriculumPlanType === "annual") return null;
  const year = String(cohort + grade - 1);
  const value = Number(state.hoursStats?.[year]?.classCounts?.[String(grade)]);
  return Number.isInteger(value) && value > 0 ? { total: value, year, grade } : { total: null, year, grade };
}

// 학급 수가 홀수(또는 아직 모름)이면 첫 학기에 1반 더 받을 과목을 고르게 한다. 짝수면 숨긴다.
function renderCurriculumCrossSplit(subject) {
  const fieldset = document.getElementById("curriculumCrossSplitField");
  if (!fieldset) return;
  const names = planDataSubjectNames(subject.name);
  const info = curriculumCrossClassTotal(subject);
  const fields = PLAN_DATA_FIELDS.filter((item) => subject.cross.includes(item));
  const even = info?.total && info.total % names.length === 0;
  fieldset.classList.toggle("hidden", names.length < 2 || fields.length < 2 || Boolean(even));
  if (names.length < 2 || fields.length < 2) return;
  const [first, second] = fields.map((item) => `${planDataGrade(item)}-${planDataSemester(item)}`);
  const current = planDataCrossSplitIndex(subject);
  document.getElementById("curriculumCrossSplitLegend").textContent = `학급 수가 홀수일 때 ${first}에 1반 더 받는 과목(${second}는 반대)`;
  document.getElementById("curriculumCrossSplitOptions").innerHTML = names.map((name, index) =>
    `<label><input type="radio" name="curriculumCrossSplit" value="${planViewEscape(name)}"${index === current ? " checked" : ""}> ${planViewEscape(name)}${index === names.length - 1 ? " <small>(기본 · 시수표와 같음)</small>" : ""}</label>`).join("");
  fieldset.dataset.total = info?.total || "";
  fieldset.dataset.first = first;
  fieldset.dataset.second = second;
}

function curriculumCrossSplitChoice() {
  const field = document.getElementById("curriculumCrossSplitField");
  if (!field || field.classList.contains("hidden")) return undefined;
  return document.querySelector("#curriculumCrossSplitOptions input[name='curriculumCrossSplit']:checked")?.value;
}

function refreshCurriculumCrossPreview() {
  const layout = state.curriculumImportedLayout;
  const subject = layout?.planData?.subjects.find((item) => item.id === curriculumCrossDialogTarget);
  const credit = Number(document.getElementById("curriculumCrossCredit").value);
  document.getElementById("curriculumCrossPreview").textContent = subject && Number.isFinite(credit) && credit > 0
    ? `과목마다 ${planDataNumberText(credit)}학점 · 학기마다 ${planDataNumberText(credit)}학점(두 학기 이수 ${planDataNumberText(credit * subject.cross.length)}학점)` : "";
  const fieldset = document.getElementById("curriculumCrossSplitField");
  const note = document.getElementById("curriculumCrossSplitNote");
  if (!subject || !fieldset || !note || fieldset.classList.contains("hidden")) return;
  const names = planDataSubjectNames(subject.name);
  const choice = curriculumCrossSplitChoice();
  const total = Number(fieldset.dataset.total) || 0;
  if (!total) { note.textContent = "5단계 시수 설정에 이 학년 학급 수를 아직 입력하지 않았습니다. 학급 수가 홀수이면 이 선택으로 반을 나눕니다."; return; }
  const trial = { ...subject, ...(choice ? { crossSplit: choice } : {}) };
  const [first, second] = planDataCrossClasses(trial, total);
  const text = (counts) => names.map((name, index) => `${name} ${counts[index]}반`).join(" · ");
  note.textContent = `${total}학급 → ${fieldset.dataset.first}: ${text(first)} / ${fieldset.dataset.second}: ${text(second)} (5단계 개설반 직접 입력이 있으면 그 값 우선)`;
}

function applyCurriculumCrossDialog(toGroup = false) {
  const id = curriculumCrossDialogTarget;
  if (!id) return;
  const value = document.getElementById("curriculumCrossCredit").value;
  const split = curriculumCrossSplitChoice();
  const build = toGroup ? (layout) => curriculumDataCrossToGroup(layout, id) : (layout) => curriculumDataSetCrossCredit(layout, id, value, split);
  try { build(state.curriculumImportedLayout); } catch (problem) {
    document.getElementById("curriculumCrossError").textContent = problem?.message || String(problem);
    return;
  }
  document.getElementById("curriculumCrossDialog").close();
  curriculumCrossDialogTarget = null;
  commitCurriculumDataEdit(build, toGroup ? "교차집중을 1·2학기 택1 선택과목군으로 바꿨습니다. 학생이 고르는 과목으로 2단계 선택 그룹에 들어갑니다."
    : `교차집중 학기당 학점을 ${value}학점으로 바꿨습니다.${split ? ` 학급 수가 홀수이면 첫 학기에 ${split}이(가) 1반 더 받습니다(5단계 시수 통계에 반영).` : ""}`);
}

function leaveCurriculumSelectionMode() {
  if (!curriculumCellSelectionMode) return;
  curriculumCellSelectionMode = false;
  curriculumSelectionAnchor = null;
  document.getElementById("curriculumMergeToggle").setAttribute("aria-pressed", "false");
  document.getElementById("curriculumMergeControls").classList.add("hidden");
  renderCurriculumDataKeepingScroll();
}

// app.js의 '선택과목군으로 묶기'/'묶음 풀기' 단추가 데이터 편제표에서 부른다.
function applyCurriculumDataSelection(selection, release) {
  if (!selection) throw new Error("학기 칸을 먼저 드래그해 고르세요.");
  if (!release) { openCurriculumGroupDialog({ selection }); return; }
  if (commitCurriculumDataEdit((layout) => curriculumDataUngroupSelection(layout, selection),
    "선택과목군을 풀었습니다. 구성 과목은 각자 묶음 학점으로 편성됩니다.")) leaveCurriculumSelectionMode();
}

let curriculumRowMenuTarget = null;
let curriculumRowMenuOpenedAt = 0;

function openCurriculumRowMenu(id, anchor) {
  const menu = document.getElementById("curriculumRowMenu");
  const layout = state.curriculumImportedLayout;
  if (!menu || !layout?.planData || layout.derived) return;
  const item = layout.planData.subjects.find((subject) => subject.id === id);
  if (!item) return;
  curriculumRowMenuTarget = id;
  curriculumRowMenuOpenedAt = Date.now();
  const index = layout.planData.subjects.indexOf(item);
  const sameCategory = (other) => other && !other.fixed && planDataKey(other.category) === planDataKey(item.category);
  menu.querySelector('[data-row-action="up"]').disabled = !sameCategory(layout.planData.subjects[index - 1]);
  menu.querySelector('[data-row-action="down"]').disabled = !sameCategory(layout.planData.subjects[index + 1]);
  menu.querySelector("[data-row-label]").textContent = item.name;
  menu.classList.remove("hidden");
  const width = menu.offsetWidth || 180;
  const height = menu.offsetHeight || 160;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, anchor.right - width));
  const top = Math.max(8, Math.min(window.innerHeight - height - 8, anchor.bottom + 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelector("button:not([disabled])")?.focus();
}

function closeCurriculumRowMenu() {
  document.getElementById("curriculumRowMenu")?.classList.add("hidden");
  curriculumRowMenuTarget = null;
}

function runCurriculumRowAction(action, id) {
  const layout = state.curriculumImportedLayout;
  const item = layout?.planData?.subjects.find((subject) => subject.id === id);
  if (!item) return;
  if (action === "insert") {
    if (typeof openCurriculumAddSubjectDialog === "function") {
      openCurriculumAddSubjectDialog({ before: id, division: planDataDivision(item.category) || "학생 선택 교육과정" });
    }
    return;
  }
  if (action === "delete") {
    const groups = planDataGroupsOf(layout.planData, id);
    const note = groups.length ? `\n선택과목군 ${groups.map(planDataGroupLabel).join(", ")}에서도 빠집니다.` : "";
    if (!window.confirm(`'${item.name}' 행을 삭제할까요?${note}\n실행취소로 되돌릴 수 있습니다.`)) return;
    commitCurriculumDataEdit((current) => curriculumDataDeleteRow(current, id), `'${item.name}' 행을 삭제했습니다. 구분·교과(군) 병합과 소계를 다시 맞췄습니다.`);
    return;
  }
  const direction = action === "up" ? -1 : 1;
  commitCurriculumDataEdit((current) => curriculumDataMoveRow(current, id, direction),
    `'${item.name}' 행을 ${direction < 0 ? "위" : "아래"}로 옮겼습니다.`, { focus: `[data-plan-row-menu="${CSS.escape(id)}"]` });
}

// 데이터 편제표에서는 자유 셀 병합·행/셀 삽입 대신 선택과목군 묶기·풀기와 행 메뉴를 쓴다.
function syncCurriculumDataControls(layout) {
  const dataMode = Boolean(layout?.planData);
  const set = (id, text) => {
    const element = document.getElementById(id);
    if (!element) return;
    if (element.dataset.legacyText === undefined) element.dataset.legacyText = element.textContent;
    element.textContent = dataMode ? text : element.dataset.legacyText;
  };
  // 데이터 편제표는 학기 칸을 마우스로 바로 끌어 고르므로 칸 고르기 모드 단추를 두지 않는다(묶기는 떠 있는 단추·Ctrl+M).
  document.getElementById("curriculumMergeToggle")?.classList.toggle("hidden", dataMode);
  set("curriculumMergeApply", "선택과목군으로 묶기");
  set("curriculumMergeRelease", "묶음 풀기");
  for (const id of ["curriculumSplitMerged", "addCurriculumPlanRow", "curriculumInsertSelectionRow", "curriculumInsertSelectionCells"]) {
    document.getElementById(id)?.classList.toggle("hidden", dataMode);
  }
  for (const id of ["curriculumMergePick", "curriculumMergeCredit"]) {
    document.getElementById(id)?.closest("label")?.classList.toggle("hidden", dataMode);
  }
  if (dataMode) {
    document.getElementById("curriculumMergeSelection").textContent = "학기 칸을 바로 끌거나 Shift+클릭으로 고르면 옆에 '선택과목군으로 묶기' 단추가 나옵니다(Ctrl+M) · 묶음 띠 위·아래 끝을 끌어 범위 조정";
  }
}

// ---- 드래그로 고른 칸 옆에 뜨는 작은 단추(선택과목군으로 묶기 / 교차집중으로 묶기 / 묶음 풀기)
function curriculumSelectionActionsBox() {
  let box = document.getElementById("curriculumSelectionActions");
  if (!box) {
    document.body.insertAdjacentHTML("beforeend", '<div id="curriculumSelectionActions" class="curriculum-selection-actions hidden" role="toolbar" aria-label="고른 칸으로 할 일"></div>');
    box = document.getElementById("curriculumSelectionActions");
  }
  return box;
}

function hideCurriculumSelectionActions(leave = false) {
  document.getElementById("curriculumSelectionActions")?.classList.add("hidden");
  if (leave && typeof leaveCurriculumSelectionMode === "function") leaveCurriculumSelectionMode();
}

// 고른 칸으로 할 수 있는 일과 Ctrl+M 기본 동작: 이미 묶음 칸이면 묶음 풀기, 한 학기 열이면 선택과목군,
// 같은 학년 1·2학기 두 칸에 과목이 둘이면 교차집중, 셋 이상이라 둘 다 가능하면 선택과목군(1·2학기 묶음).
function curriculumSelectionOptions(layout, selection) {
  if (!layout?.planData || layout.derived || !selection) return null;
  const fields = planDataSelectionFields(layout.planTemplate, selection);
  const members = planDataSelectionSubjects(layout.planData, selection);
  if (!fields.length || !members.length) return null;
  const ids = members.map((item) => item.id);
  const names = planDataNamesCount(layout.planData, ids);
  const grouped = layout.planData.groups.some((group) => group.fields.some((field) => fields.includes(field)) && group.members.some((id) => ids.includes(id)));
  const pair = planDataIsGradePair(fields);
  const actions = [];
  if (fields.length === 1 || pair) actions.push("group");
  if (pair && names >= 2) actions.push("cross");
  if (grouped) actions.push("release");
  const primary = grouped ? "release" : pair && names === 2 ? "cross" : actions[0] || null;
  return { fields, names, actions, primary };
}

// app.js가 드래그·Shift+클릭으로 칸을 고른 뒤(놓을 때) 부른다.
function showCurriculumSelectionActions(selection) {
  const layout = state.curriculumImportedLayout;
  if (!layout?.planData || layout.derived || !selection) return;
  const options = curriculumSelectionOptions(layout, selection);
  const box = curriculumSelectionActionsBox();
  if (!options) { box.classList.add("hidden"); return; }
  const { fields, names, actions, primary } = options;
  const labels = { group: "선택과목군으로 묶기", cross: "교차집중으로 묶기", release: "묶음 풀기" };
  const buttons = actions.map((action) => `<button class="button${action === primary ? " button-primary" : ""}" type="button" data-selection-action="${action}"${action === primary ? ' aria-keyshortcuts="Control+M" title="단축키 Ctrl+M"' : ""}>${labels[action]}${action === primary ? ' <kbd class="curriculum-shortcut">Ctrl+M</kbd>' : ""}</button>`);
  buttons.push('<button class="button button-quiet" type="button" data-selection-action="cancel" aria-label="고르기 취소" title="취소(Esc)">×</button>');
  box.innerHTML = `<span class="curriculum-selection-actions-label">${planViewEscape(planDataFieldLabel(fields))} · ${names}과목</span>${buttons.join("")}`;
  box.classList.remove("hidden");
  const rects = [...document.querySelectorAll("#curriculumPlanWrap .curriculum-cell-selected")].map((cell) => cell.getBoundingClientRect()).filter((rect) => rect.width);
  if (rects.length) {
    const right = Math.max(...rects.map((rect) => rect.right)), bottom = Math.max(...rects.map((rect) => rect.bottom));
    const top = Math.min(...rects.map((rect) => rect.top));
    const width = box.offsetWidth || 320, height = box.offsetHeight || 34;
    const x = Math.min(window.innerWidth - width - 8, right + 6);
    const y = bottom + 4 + height > window.innerHeight ? Math.max(8, top - height - 4) : bottom + 4;
    box.style.left = `${Math.max(8, x)}px`;
    box.style.top = `${Math.max(8, y)}px`;
  }
  box.querySelector("button")?.focus({ preventScroll: true });
}

function runCurriculumSelectionAction(action) {
  const selection = typeof curriculumCellSelection !== "undefined" ? curriculumCellSelection : null;
  hideCurriculumSelectionActions();
  if (action === "cancel" || !selection) { hideCurriculumSelectionActions(true); return; }
  if (action === "group") { openCurriculumGroupDialog({ selection }); return; }
  if (action === "release") {
    try { applyCurriculumDataSelection(selection, true); } catch (error) { status.textContent = error?.message || String(error); }
    return;
  }
  if (action === "cross") {
    let result = null;
    const build = (layout) => { const edit = curriculumDataSelectionToCross(layout, selection); result = edit.result; return edit; };
    if (commitCurriculumDataEdit(build, "고른 두 학기 칸을 교차집중으로 묶었습니다. 학기당 학점과 학급 배분을 확인하세요.")) {
      leaveCurriculumSelectionMode();
      if (result?.id) openCurriculumCrossDialog(result.id);
    }
  }
}

// Ctrl/⌘ + 글자(대소문자·한글 자판 무시: event.code로도 본다)
function curriculumShortcutKey(event, letter) {
  if (!(event.ctrlKey || event.metaKey)) return false;
  return String(event.key || "").toLowerCase() === letter || event.code === `Key${letter.toUpperCase()}`;
}

function runCurriculumMergeShortcut() {
  const layout = state.curriculumImportedLayout;
  const selection = typeof curriculumCellSelection !== "undefined" ? curriculumCellSelection : null;
  const say = (text) => {
    if (typeof status !== "undefined") { status.style.color = "#596780"; status.textContent = text; }
    if (typeof showAppToast === "function") showAppToast(text);
  };
  if (!layout?.planData) { say("편제표를 먼저 불러오세요."); return; }
  if (layout.derived) { say("전학년 편제표는 3개년 편제표에서 자동으로 만들어 묶을 수 없습니다."); return; }
  const options = curriculumSelectionOptions(layout, selection);
  if (!selection || !options) { say("먼저 학기 칸을 끌어 고르세요. 고른 뒤 Ctrl+M을 누르면 선택과목군으로 묶습니다."); return; }
  if (!options.primary) { say("고른 칸으로는 묶을 수 없습니다. 한 학기 열이나 같은 학년 1·2학기 칸을 고르세요."); return; }
  runCurriculumSelectionAction(options.primary);
}

// 묶음 띠 위·아래 끝 손잡이 끌기: 놓은 행까지 묶음 범위를 바꾼다.
let curriculumGroupResize = null;
function startCurriculumGroupResize(event, handle) {
  event.preventDefault();
  event.stopPropagation();
  curriculumGroupResize = { groupId: handle.dataset.groupId, edge: handle.dataset.groupHandle, pointerId: event.pointerId, target: null };
  document.body.classList.add("is-group-resizing");
}

function moveCurriculumGroupResize(event) {
  const drag = curriculumGroupResize;
  if (!drag || event.pointerId !== drag.pointerId) return;
  event.preventDefault();
  const row = document.elementFromPoint(event.clientX, event.clientY)?.closest("#curriculumPlanWrap tr[data-plan-row]");
  document.querySelectorAll("#curriculumPlanWrap tr.is-group-resize-target").forEach((item) => item.classList.remove("is-group-resize-target"));
  if (row) { row.classList.add("is-group-resize-target"); drag.target = row.dataset.planRow; }
}

function endCurriculumGroupResize(event) {
  const drag = curriculumGroupResize;
  if (!drag || (event.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
  curriculumGroupResize = null;
  document.body.classList.remove("is-group-resizing");
  document.querySelectorAll("#curriculumPlanWrap tr.is-group-resize-target").forEach((item) => item.classList.remove("is-group-resize-target"));
  if (event.type !== "pointerup" || !drag.target) return;
  const group = state.curriculumImportedLayout?.planData?.groups.find((item) => item.id === drag.groupId);
  if (!group) return;
  const edgeId = drag.edge === "top" ? group.members[0] : group.members.at(-1);
  if (edgeId === drag.target) return;
  commitCurriculumDataEdit((layout) => curriculumDataResizeGroup(layout, drag.groupId, drag.edge, drag.target),
    `${planDataFieldLabel(group.fields)} 택${group.pick} 묶음 범위를 바꿨습니다. 빠진 과목은 묶음 학점으로 각자 편성됩니다.`);
}

// 2단계 선택 그룹 편집기(course-groups.js)에서 편제표 연동 과목 칩을 다른 그룹으로 끌었을 때 편제표 묶음을 바꾼다(편제표가 기준).
// targetName: 목표 그룹 이름(편제표 묶음 이름, 예: '2-1 택3'). 연동되지 않은 그룹·미분류면 빈 값 → 편제표 묶음에서 뺀다.
function moveCurriculumGroupSubject(year, grade, semester, subject, targetName) {
  const field = `sem${grade}${semester}`;
  const active = state.curriculumPlanType !== "annual" && String(state.curriculumCohortYear) === String(year);
  const layout = active ? state.curriculumImportedLayout : state.curriculumCohorts?.[year]?.importedLayout;
  if (!layout?.planData) throw new Error(`${year}학년도 입학생 편제표 데이터가 없습니다.`);
  if (layout.derived) throw new Error("전학년 편제표는 바꿀 수 없습니다.");
  const blocks = typeof curriculumDataChoiceBlocks === "function" ? curriculumDataChoiceBlocks(layout) : [];
  const target = targetName ? blocks.find((block) => block.field === field && block.name === targetName) : null;
  const build = (current) => curriculumDataMoveSubjectToGroup(current, subject, field, target?.groupId || null);
  const message = target ? `${subject}을(를) 편제표 ${target.name} 묶음으로 옮겼습니다(1단계 편제표에 반영).` : `${subject}을(를) 편제표 묶음에서 뺐습니다(1단계 편제표에 반영).`;
  if (active) return commitCurriculumDataEdit(build, message);
  const { layout: next } = build(layout);
  const item = state.curriculumCohorts[year];
  item.importedLayout = next;
  item.plan = curriculumPlanFromLayout(next, item.fileName, item.plan);
  item.templateRows = item.plan.map((row) => normalizeCurriculumPlanRow(row));
  const saved = persistState();
  status.style.color = saved ? "#287956" : "#a44939";
  status.textContent = saved ? message : `${message} 다만 저장하지 못했습니다.`;
  return true;
}
if (typeof window !== "undefined") window.moveCurriculumGroupSubject = moveCurriculumGroupSubject;

function initCurriculumDataView() {
  const wrap = document.getElementById("curriculumPlanWrap");
  const dialog = document.getElementById("curriculumGroupDialog");
  const menu = document.getElementById("curriculumRowMenu");
  if (!wrap || !dialog || !menu) return;
  wrap.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest("[data-group-handle]");
    if (handle && event.button === 0 && !state.curriculumImportedLayout?.derived) startCurriculumGroupResize(event, handle);
  }, true);
  document.addEventListener("pointermove", moveCurriculumGroupResize, { passive: false });
  document.addEventListener("pointerup", endCurriculumGroupResize);
  document.addEventListener("pointercancel", endCurriculumGroupResize);
  const actions = curriculumSelectionActionsBox();
  actions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-selection-action]");
    if (button) runCurriculumSelectionAction(button.dataset.selectionAction);
  });
  document.addEventListener("pointerdown", (event) => {
    if (actions.classList.contains("hidden") || actions.contains(event.target)) return;
    hideCurriculumSelectionActions(!event.target.closest("#curriculumPlanWrap"));
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !actions.classList.contains("hidden") && !document.querySelector("dialog[open]")) hideCurriculumSelectionActions(true);
  });
  // Ctrl+M(맥 ⌘+M): 고른 칸을 떠 있는 단추의 기본 동작으로 묶기·풀기. 편제표(또는 떠 있는 단추)에 포커스가 있을 때만 브라우저 기본 동작을 막는다.
  document.addEventListener("keydown", (event) => {
    if (!curriculumShortcutKey(event, "m") || event.shiftKey || event.altKey) return;
    if (!event.target?.closest?.("#curriculumPlanWrap, #curriculumSelectionActions") || document.querySelector("dialog[open]")) return;
    event.preventDefault();
    runCurriculumMergeShortcut();
  });
  wrap.addEventListener("click", (event) => {
    const band = event.target.closest("[data-plan-group]");
    if (band && !state.curriculumImportedLayout?.derived) {
      openCurriculumGroupDialog({ groupId: band.dataset.planGroup });
      return;
    }
    const crossBand = event.target.closest("[data-plan-cross]");
    if (crossBand && !state.curriculumImportedLayout?.derived) {
      openCurriculumCrossDialog(crossBand.dataset.planCross);
      return;
    }
    const menuButton = event.target.closest("[data-plan-row-menu]");
    if (menuButton) {
      event.stopPropagation();
      if (curriculumRowMenuTarget === menuButton.dataset.planRowMenu && !menu.classList.contains("hidden")) closeCurriculumRowMenu();
      else openCurriculumRowMenu(menuButton.dataset.planRowMenu, menuButton.getBoundingClientRect());
    }
  });
  wrap.addEventListener("contextmenu", (event) => {
    const row = event.target.closest("[data-plan-row]");
    if (!row || !state.curriculumImportedLayout?.planData || state.curriculumImportedLayout.derived) return;
    event.preventDefault();
    openCurriculumRowMenu(row.dataset.planRow, { right: event.clientX + 180, bottom: event.clientY });
  });
  menu.addEventListener("click", (event) => {
    const button = event.target.closest("[data-row-action]");
    if (!button || button.disabled) return;
    const id = curriculumRowMenuTarget;
    closeCurriculumRowMenu();
    runCurriculumRowAction(button.dataset.rowAction, id);
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { closeCurriculumRowMenu(); return; }
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    const items = [...menu.querySelectorAll("button:not([disabled])")];
    const index = items.indexOf(document.activeElement);
    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.classList.contains("hidden") && !menu.contains(event.target) && !event.target.closest("[data-plan-row-menu]")) closeCurriculumRowMenu();
  });
  // 메뉴를 연 직후의 스크롤(우클릭한 칸을 화면 안으로 맞추는 스크롤)로는 닫지 않는다.
  wrap.addEventListener("scroll", () => { if (Date.now() - curriculumRowMenuOpenedAt > 300) closeCurriculumRowMenu(); }, true);
  const form = document.getElementById("curriculumGroupForm");
  form.addEventListener("input", refreshCurriculumGroupPreview);
  form.addEventListener("submit", (event) => { event.preventDefault(); applyCurriculumGroupDialog(false); });
  document.getElementById("curriculumGroupRelease").addEventListener("click", () => applyCurriculumGroupDialog(true));
  document.getElementById("curriculumGroupCross")?.addEventListener("click", convertCurriculumGroupToCross);
  const crossForm = document.getElementById("curriculumCrossForm");
  if (crossForm) {
    crossForm.addEventListener("input", refreshCurriculumCrossPreview);
    crossForm.addEventListener("submit", (event) => { event.preventDefault(); applyCurriculumCrossDialog(false); });
    document.getElementById("curriculumCrossToGroup").addEventListener("click", () => applyCurriculumCrossDialog(true));
    document.getElementById("curriculumCrossCancel").addEventListener("click", () => { document.getElementById("curriculumCrossDialog").close(); curriculumCrossDialogTarget = null; });
  }
  document.getElementById("curriculumGroupCancel").addEventListener("click", () => { dialog.close(); curriculumGroupDialogContext = null; });
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initCurriculumDataView, { once: true });
  else initCurriculumDataView();
}

// 칸 선택 상태 표시: '3-1 · 2과목 선택' 처럼 학기와 과목 수로 보여 준다.
function curriculumDataSelectionLabel(layout, selection) {
  const fields = planDataSelectionFields(layout.planTemplate, selection);
  const members = planDataSelectionSubjects(layout.planData, selection);
  if (!fields.length) return "학기 열(1-1 ~ 3-2)의 과목 칸을 고르세요.";
  const names = members.map((item) => item.name).join(" / ");
  return `${planDataFieldLabel(fields)} · ${members.length}과목 선택${names ? `: ${names}` : ""}`;
}
