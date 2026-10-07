"use strict";
var renderPlanGroups;

function planGroupCellMap(layout, subjects) {
  const cells = new Map();
  if (!layout || !subjects) return cells;
  const columns = importedPlanColumnMap(layout);
  const eligible = new Map();
  for (const grade of ["2", "3"]) for (const course of subjects[grade] || []) {
    eligible.set(`${grade}:${course.semester}:${course.subject}`, course);
  }
  const merges = (layout.mergedRanges || []).map((reference) => {
    const [start, end = start] = reference.split(":");
    return {r1:Number(start.match(/\d+/)[0])-1, r2:Number(end.match(/\d+/)[0])-1,
      c1:columnIndex(start), c2:columnIndex(end)};
  });
  for (const context of importedPlanCourseContexts(layout, columns)) {
    if (!String(context.division || "").replace(/\s+/g, "").includes("학생선택교육과정")) continue;
    const rowText = [context.division, context.detail, context.subject, ...context.row]
      .map((value) => String(value ?? "").replace(/\s+/g, "")).join(" ");
    if (/공동교육과정|공동(?=[,，、/·;:()（）\s]|$)|소인수/.test(rowText)) continue;
    const names = context.subject.replace(/↔/g, " ").split(/[,，]/)
      .map((name) => name.replace(/^[*＊★☆■\s]+|[*＊★☆■\s]+$/g, "").trim());
    for (const grade of ["2", "3"]) for (const semester of ["1", "2"]) {
      const column = columns.semesters[(Number(grade)-1)*2+Number(semester)-1];
      if (column < 0) continue;
      const value = String(context.row[column] ?? "").trim();
      if (!value || /^[-–—]+$/.test(value) || /^0(?:\.0+)?$/.test(value)) continue;
      const courses = [];
      for (const name of names) {
        for (const subject of [name, `${name} (${semester}학기)`]) {
          if (eligible.has(`${grade}:${semester}:${subject}`)) courses.push(subject);
        }
      }
      if (!courses.length) continue;
      const merge = merges.find((m) => context.rowIndex >= m.r1 && context.rowIndex <= m.r2 &&
        column >= m.c1 && column <= m.c2);
      // A cell spanning two semester columns cannot represent a single-semester group.
      if (merge && columns.semesters.filter((c) => c >= merge.c1 && c <= merge.c2).length > 1) continue;
      const row = merge ? merge.r1 : context.rowIndex;
      const sourceColumn = merge ? merge.c1 : column;
      const id = `${row}:${sourceColumn}`;
      if (!cells.has(id)) cells.set(id, {row, column:sourceColumn, grade, semester, courses:[]});
      const cell = cells.get(id);
      cell.courses = [...new Set([...cell.courses, ...courses])];
    }
  }
  return cells;
}

(() => {
  const byId = (id) => document.getElementById(id);
  const wrap = byId("curriculumPlanWrap");
  const message = byId("planGroupSelectionStatus");
  const selected = new Set();
  let mode = false, anchor = null, cells = new Map();
  function selectedInfo() {
    const entries = [...selected].map((id) => cells.get(id)).filter(Boolean);
    if (!entries.length) throw new Error("신청 가능한 학기 셀을 먼저 선택하세요.");
    const {grade, semester} = entries[0];
    if (entries.some((entry) => entry.grade !== grade || entry.semester !== semester)) {
      throw new Error("같은 학년·학기의 셀만 한 그룹으로 묶을 수 있습니다.");
    }
    return {grade, semester, courses:[...new Set(entries.flatMap((entry) => entry.courses))]};
  }
  renderPlanGroups = () => {
    cells = planGroupCellMap(state.curriculumImportedLayout, getGroupedApplicationSubjects());
    for (const id of selected) if (!cells.has(id)) selected.delete(id);
    const groups = getPlanApplicationGroups();
    wrap.classList[mode ? "add" : "remove"]("group-selecting");
    for (const td of wrap.querySelectorAll("td[data-source-row][data-source-column]")) {
      td.querySelector(".plan-group-badge")?.remove();
      const id = `${td.dataset.sourceRow}:${td.dataset.sourceColumn}`;
      const info = cells.get(id);
      td.contentEditable = mode ? "false" : "true";
      td.classList.toggle("plan-group-cell", !!info);
      td.classList.toggle("plan-group-selected", mode && selected.has(id));
      td.removeAttribute("tabindex");
      td.removeAttribute("title");
      td.style.removeProperty("--group-color");
      if (!info) continue;
      const membership = groups.filter((g) => g.grade === info.grade && g.semester === info.semester &&
        g.courses.some((subject) => info.courses.includes(subject)));
      const label = membership.map((g) => `${g.name} · 택${g.count ?? "미지정"}`).join(" / ") || "미분류";
      td.title = `${info.grade}학년 ${info.semester}학기 · ${info.courses.join(", ")} · ${label}`;
      if (membership[0]?.fill) td.style.setProperty("--group-color", membership[0].fill);
      if (mode) {
        td.tabIndex = 0;
        const badge = document.createElement("span");
        badge.className = "plan-group-badge"; badge.textContent = label;
        td.appendChild(badge);
      }
    }
    byId("planGroupMode").setAttribute("aria-pressed", String(mode));
    byId("planGroupMode").textContent = mode ? "그룹 편성 완료 · 셀 수정으로" : "선택과목 그룹 편성";
    byId("planGroupActions").classList[mode ? "remove" : "add"]("hidden");
    const target = byId("planGroupTarget"), previous = target.value;
    target.replaceChildren();
    const empty = document.createElement("option");
    empty.value = ""; empty.textContent = "기존 그룹 선택"; target.appendChild(empty);
    if (selected.size) {
      const info = selectedInfo();
      for (const group of groups.filter((g) => g.grade === info.grade && g.semester === info.semester)) {
        const option = document.createElement("option");
        option.value = group.id; option.textContent = `${group.name} (${group.courses.length}과목)`;
        target.appendChild(option);
      }
      target.value = [...target.options].some((o) => o.value === previous) ? previous : "";
      message.textContent = `${info.grade}학년 ${info.semester}학기 · ${selected.size}셀 / ${info.courses.length}과목 선택`;
    } else message.textContent = mode
      ? "학생선택교육과정의 2·3학년 학기 셀을 클릭하세요. 여러 셀 클릭 또는 Shift+클릭으로 범위 선택합니다."
      : "그룹 편성 모드에서 같은 학기의 셀을 선택하세요. 기존 그룹은 셀 아래 색과 마우스 도움말로 확인할 수 있습니다.";
  };
  function selectCell(td, shift) {
    const id = `${td.dataset.sourceRow}:${td.dataset.sourceColumn}`, info = cells.get(id);
    if (!info) { message.textContent = "학교지정·공동교육과정·소인수·빈 학기 셀은 그룹으로 선택할 수 없습니다."; return; }
    const first = cells.get([...selected][0]);
    if (first && (first.grade !== info.grade || first.semester !== info.semester)) {
      message.textContent = "다른 학년·학기는 함께 선택할 수 없습니다. 선택 해제 후 새 학기를 선택하세요."; return;
    }
    if (shift && anchor && cells.has(anchor) && cells.get(anchor).grade === info.grade && cells.get(anchor).semester === info.semester) {
      const start = cells.get(anchor);
      const visible = new Set([...wrap.querySelectorAll("td[data-source-row][data-source-column]")]
        .map((cell) => `${cell.dataset.sourceRow}:${cell.dataset.sourceColumn}`));
      for (const [key, cell] of cells) {
        if (visible.has(key) && cell.grade === info.grade && cell.semester === info.semester &&
          cell.row >= Math.min(start.row, info.row) && cell.row <= Math.max(start.row, info.row)) selected.add(key);
      }
    } else {
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      anchor = id;
    }
    renderPlanGroups();
  }
  byId("planGroupMode").addEventListener("click", () => {
    mode = !mode; selected.clear(); anchor = null; renderPlanGroups();
  });
  wrap.addEventListener("click", (event) => {
    if (!mode) return;
    const td = event.target.closest("td[data-source-row][data-source-column]");
    if (td) { event.preventDefault(); selectCell(td, event.shiftKey); }
  });
  wrap.addEventListener("keydown", (event) => {
    if (!mode) return;
    if (event.key === "Escape") { selected.clear(); anchor = null; renderPlanGroups(); return; }
    const td = event.target.closest("td[data-source-row][data-source-column]");
    if (td && [" ", "Enter"].includes(event.key)) { event.preventDefault(); selectCell(td, event.shiftKey); }
  });
  byId("planGroupClear").addEventListener("click", () => { selected.clear(); anchor = null; renderPlanGroups(); });
  function apply(action) {
    try {
      if (typeof requireTeacherLogin !== "function" || !requireTeacherLogin()) return;
      const info = selectedInfo();
      const options = action === "create" ? {name:byId("planGroupName").value, count:
        byId("planGroupCount").value.trim() === "" ? null : Number(byId("planGroupCount").value)} :
        {targetId:action === "move" ? byId("planGroupTarget").value : ""};
      if (action === "move" && !options.targetId) throw new Error("추가할 기존 그룹을 선택하세요.");
      const name = assignPlanApplicationGroup({...info, ...options});
      selected.clear(); anchor = null; renderPlanGroups();
      message.textContent = `${info.courses.length}과목을 ${name}에 배치했습니다. 2단계 그룹 설정에도 반영됩니다.`;
    } catch (error) { message.textContent = error.message; }
  }
  byId("planGroupCreate").addEventListener("click", () => apply("create"));
  byId("planGroupMove").addEventListener("click", () => apply("move"));
  byId("planGroupUnassign").addEventListener("click", () => apply("unassign"));
  renderPlanGroups();
})();
