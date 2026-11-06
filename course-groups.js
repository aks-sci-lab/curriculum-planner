"use strict";
var renderCourseGroups;
var getCourseApplicationGroups;
var getGroupedApplicationSubjects;
var setApplicationTargetGrades;
var getApplicationGroupSettings;
var switchApplicationMenuGrade;
var switchApplicationGroupCohort;
var openApplicationWorkspaceTab;
var getApplicationGroupStorageIssue;
var getApplicationGroupBackup;
var getApplicationPreparationStatus;
function validateApplicationGroupData(groups, seeded) {
  if (!Array.isArray(groups) || groups.some((group) => !group || !Array.isArray(group.courses) ||
      typeof group.name !== "string" || typeof group.id !== "string" || !["2", "3"].includes(group.grade) ||
      !["0", "1", "2"].includes(group.semester) || group.courses.some((name) => typeof name !== "string") ||
      (group.count !== null && (!Number.isInteger(group.count) || group.count < 0 || group.count > group.courses.length))) ||
      new Set(groups.map((group) => group.id)).size !== groups.length ||
      !Array.isArray(seeded) || seeded.some((id) => typeof id !== "string")) {
    throw new Error("그룹 저장 형식이 잘못되었습니다.");
  }
}
(() => {
  const workspaceTabs = ["Groups", "Results", "Online"]
    .map((name) => document.getElementById(`application${name}Tab`));
  function openWorkspaceTab(index, focus = false) {
    if (typeof index === "string") index = Math.max(0, ["groups", "results", "online"].indexOf(index));
    if (!workspaceTabs[index] || workspaceTabs[index].classList.contains("hidden")) index = 0;
    workspaceTabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.setAttribute("tabindex", i === index ? "0" : "-1");
      const panel = document.getElementById(tab.getAttribute("aria-controls"));
      panel.classList[i === index ? "remove" : "add"]("hidden");
    });
    if (focus) workspaceTabs[index].focus();
  }
  openApplicationWorkspaceTab = openWorkspaceTab;
  workspaceTabs.forEach((tab, index) => {
    tab.addEventListener("click", () => openWorkspaceTab(index));
    tab.addEventListener("keydown", (event) => {
      const available = workspaceTabs.map((item, itemIndex) => item.classList.contains("hidden") ? -1 : itemIndex).filter((itemIndex) => itemIndex >= 0);
      const position = available.indexOf(index);
      const nextPosition = event.key === "ArrowRight" ? (position + 1) % available.length
        : event.key === "ArrowLeft" ? (position + available.length - 1) % available.length
          : event.key === "Home" ? 0
            : event.key === "End" ? available.length - 1 : -1;
      if (nextPosition < 0) return;
      event.preventDefault();
      openWorkspaceTab(available[nextPosition], true);
    });
  });
  openWorkspaceTab(0);
  const key = "curriculum-color-semester-groups-v3";
  function cohortYearForPlanGrade(grade) {
    const currentGrade = grade === "2" ? "1" : "2";
    return typeof getApplicationCohortYear === "function" ? getApplicationCohortYear(currentGrade) : "";
  }
  function cohortStorageKey(year) { return year ? `${key}:${year}` : key; }
  let activeCohortYear = cohortYearForPlanGrade("2");
  const container = document.getElementById("courseGroupEditor");
  const message = document.getElementById("courseGroupMessage");
  let groups = [];
  let available = new Map();
  let draggedCourse = null;
  let targetGrades = ["2"];
  let groupStorageError = "";
  let groupSaveError = "";
  let lastSavedGroups = "";
  getApplicationPreparationStatus = () => {
    const courses = [...available.values()].filter((course) => targetGrades.includes(course.grade));
    const activeGroups = groups.filter((group) => targetGrades.includes(group.grade));
    return {
      subjects: courses.length,
      unassigned: courses.filter((course) => !activeGroups.some((group) =>
        group.grade === course.grade && group.semester === course.semester && group.courses.includes(course.subject))).length,
      invalidGroups: activeGroups.filter((group) => !group.name || !group.courses.length ||
        !Number.isInteger(group.count) || group.count < 0 || group.count > group.courses.length).length,
      hasSelections: activeGroups.some((group) => group.count > 0),
      storageIssue: getApplicationGroupStorageIssue(),
    };
  };
  function refreshWorkspaceContext() {
    if (typeof renderWorkspaceContext === "function") renderWorkspaceContext();
  }
  function workspaceProtected() {
    return typeof isWorkspaceStorageProtected === "function" && isWorkspaceStorageProtected();
  }
  getApplicationGroupStorageIssue = () => groupStorageError || groupSaveError;
  getApplicationGroupBackup = () => ({
    key: cohortStorageKey(activeCohortYear),
    groups: JSON.parse(JSON.stringify(groups)),
    seeded: [...seeded],
    storageIssue: getApplicationGroupStorageIssue(),
    canRestore: !groupStorageError,
  });
  function publishStorageIssue() {
    if (typeof showWorkspaceGroupStorageIssue === "function") showWorkspaceGroupStorageIssue(getApplicationGroupStorageIssue());
  }
  setApplicationTargetGrades = (grades) => {
    targetGrades = [...new Set(grades.map(String))];
    renderCourseGroups();
  };
  let seeded = new Set();
  function readGroupData(year) {
    const groupKey = cohortStorageKey(year);
    const storedGroups = localStorage.getItem(groupKey) || "[]";
    const nextGroups = JSON.parse(storedGroups);
    const storedSeeded = localStorage.getItem(groupKey+"-seeded") || "[]";
    const nextSeeded = JSON.parse(storedSeeded);
    validateApplicationGroupData(nextGroups, nextSeeded);
    groups = nextGroups;
    seeded = new Set(nextSeeded);
    groupStorageError = "";
    groupSaveError = "";
    lastSavedGroups = JSON.stringify([storedGroups, storedSeeded]);
  }
  function migrateLegacyGroupData() {
    if (!activeCohortYear || ["2", "3"].some((grade) => localStorage.getItem(cohortStorageKey(cohortYearForPlanGrade(grade))))) return;
    const legacyGroups = JSON.parse(localStorage.getItem(key) || "[]");
    const legacySeeded = JSON.parse(localStorage.getItem(key+"-seeded") || "[]");
    if (!Array.isArray(legacyGroups) || !legacyGroups.length) return;
    for (const grade of ["2", "3"]) {
      const year = cohortYearForPlanGrade(grade);
      if (!year) continue;
      const groupKey = cohortStorageKey(year);
      localStorage.setItem(groupKey, JSON.stringify(legacyGroups.filter((group) => group.grade === grade)));
      localStorage.setItem(groupKey+"-seeded", JSON.stringify(legacySeeded.filter((id) => id.startsWith(`${grade}:`))));
    }
  }
  getGroupedApplicationSubjects = () => {
    const subjects = selectedApplicationSubjects();
    if (!subjects) return null;
    const result = { "1": [], "2": [], "3": [] };
    for (const grade of ["2","3"]) for (const course of subjects[grade] || []) {
      const semesters = course.semester?.split("·").filter(Boolean) || [];
      for (const semester of semesters.length ? semesters : ["0"]) {
        const selectionGroup = course.semesterGroups?.[semester];
        result[grade].push({ ...course, semester,
          subject: semesters.length > 1 ? `${course.subject} (${semester}학기)` : course.subject,
          groupSubject: course.subject,
          fill: course.semesterColors?.[semester] || "",
          groupName: selectionGroup?.groupName || "",
          groupPick: selectionGroup?.groupPick ?? 1,
          groupConfigured: Boolean(selectionGroup?.groupConfigured),
          groupLinked: Boolean(selectionGroup?.groupLinked)
        });
      }
    }
    return result;
  };
  try {
    if (!workspaceProtected()) migrateLegacyGroupData();
    readGroupData(activeCohortYear);
  } catch (error) {
    groupStorageError = `그룹 설정 읽기 실패 · 원본 보호 중: ${error.message}`;
    message.textContent = groupStorageError;
    groups = [];
  }
  function sync() {
    available = new Map();
    const subjects = getGroupedApplicationSubjects();
    for (const grade of ["2", "3"]) {
      for (const course of subjects?.[grade] || []) available.set(`${grade}:${course.semester}:${course.subject}`, { ...course, grade });
    }
    const scopes = new Set([...available.values()].map((c) => `${c.grade}:${c.semester}`));
    groups = groups.filter((g) => scopes.has(`${g.grade}:${g.semester}`));
    seeded = new Set([...seeded].filter((id) => available.has(id)));
    const assigned = new Set();
    const removedGroups = new Set();
    for (const group of groups) {
      const previousSize = group.courses.length;
      group.courses = group.courses.filter((name) => {
        const id = `${group.grade}:${group.semester}:${name}`;
        if (!available.has(id) || assigned.has(id)) return false;
        assigned.add(id);
        return true;
      });
      if (group.count > group.courses.length) {
        group.count = null;
        message.textContent = `${group.name}: 과목 구성이 바뀌어 선택 수를 다시 지정해야 합니다.`;
      }
      if (previousSize && !group.courses.length) removedGroups.add(group.id);
    }
    groups = groups.filter((group) => !removedGroups.has(group.id));
    const curriculumBundles = new Map();
    for (const [id, course] of available) {
      if (!course.groupConfigured) continue;
      assigned.add(id);
      for (const group of groups) {
        if (group.grade === course.grade && group.semester === course.semester) {
          group.courses = group.courses.filter((subject) => subject !== course.subject);
        }
      }
      if (!course.groupName) continue;
      const key = `${course.grade}:${course.semester}:${course.groupName}`;
      const bundle = curriculumBundles.get(key) || {
        grade: course.grade,
        semester: course.semester,
        name: course.groupName,
        count: course.groupPick,
        courses: []
      };
      bundle.count = course.groupPick;
      bundle.linked = Boolean(bundle.linked || course.groupLinked);
      bundle.courses.push(course.subject);
      curriculumBundles.set(key, bundle);
    }
    for (const group of groups) delete group.linked;
    for (const bundle of curriculumBundles.values()) {
      let group = groups.find((candidate) =>
        candidate.grade === bundle.grade && candidate.semester === bundle.semester && candidate.name === bundle.name);
      if (!group) {
        group = { id: crypto.randomUUID(), grade: bundle.grade, semester: bundle.semester,
          name: bundle.name, count: bundle.count, courses: [], source: "curriculum" };
        groups.push(group);
      }
      group.source = "curriculum";
      group.count = bundle.count;
      if (bundle.linked) group.linked = true;
      for (const subject of bundle.courses) {
        const id = `${bundle.grade}:${bundle.semester}:${subject}`;
        for (const previous of groups) {
          if (previous !== group && previous.grade === bundle.grade && previous.semester === bundle.semester) {
            previous.courses = previous.courses.filter((name) => name !== subject);
          }
        }
        if (!group.courses.includes(subject)) group.courses.push(subject);
        assigned.add(id);
      }
    }
    groups = groups.filter((group) => group.source !== "curriculum" || group.courses.length > 0);
    for (const [id,course] of available) {
      if (assigned.has(id) || course.groupConfigured || !course.fill || seeded.has(id)) continue;
      let group = groups.find((g) => g.grade===course.grade && g.semester===course.semester && g.fill===course.fill);
      if (!group) {
        group={id:crypto.randomUUID(),grade:course.grade,semester:course.semester,fill:course.fill,
          name:`색상 그룹 ${groups.filter((g)=>g.grade===course.grade && g.semester===course.semester).length+1}`,
          count:null,courses:[]};
        groups.push(group);
      }
      group.courses.push(course.subject); assigned.add(id);
    }
    for (const id of available.keys()) seeded.add(id);
  }
  function persist() {
    if (workspaceProtected()) {
      message.textContent = "편제표 저장 원본을 먼저 복원하세요. 선택 그룹 원본도 보호 중입니다.";
      return false;
    }
    if (groupStorageError) { publishStorageIssue(); return false; }
    const previous = new Map();
    const written = [];
    try {
      const groupKey = cohortStorageKey(activeCohortYear);
      const serialized = JSON.stringify(groups);
      const serializedSeeded = JSON.stringify([...seeded]);
      const snapshot = JSON.stringify([serialized, serializedSeeded]);
      const stored = JSON.stringify([localStorage.getItem(groupKey) || "[]", localStorage.getItem(groupKey + "-seeded") || "[]"]);
      if (lastSavedGroups && stored !== lastSavedGroups) {
        groupStorageError = "다른 창에서 그룹 설정이 변경되어 원본을 보호합니다.";
        throw new Error(groupStorageError);
      }
      if (snapshot === lastSavedGroups) {
        groupSaveError = "";
        publishStorageIssue();
        return true;
      }
      const entries = [[groupKey, serialized], [groupKey + "-seeded", serializedSeeded]];
      if (groupKey !== key) entries.push([key, serialized], [key + "-seeded", serializedSeeded]);
      for (const [storageKey] of entries) previous.set(storageKey, localStorage.getItem(storageKey));
      for (const [storageKey, value] of entries) {
        localStorage.setItem(storageKey, value);
        written.push(storageKey);
      }
      lastSavedGroups = snapshot;
      groupSaveError = "";
      publishStorageIssue();
      message.textContent = "그룹 설정 저장 완료";
      return true;
    }
    catch (error) {
      const rollbackErrors = [];
      for (const storageKey of written.reverse()) {
        try {
          if (previous.get(storageKey) === null) localStorage.removeItem(storageKey);
          else localStorage.setItem(storageKey, previous.get(storageKey));
        } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
      }
      if (rollbackErrors.length) groupStorageError = `기존 그룹 자료 되돌리기 실패: ${rollbackErrors.join(", ")}`;
      groupSaveError = `그룹 저장 실패: ${error.message}`;
      message.textContent = groupSaveError;
      publishStorageIssue();
      return false;
    }
  }
  switchApplicationGroupCohort = (year) => {
    year = String(year || "");
    if (year === activeCohortYear) return;
    persist();
    activeCohortYear = year;
    lastSavedGroups = "";
    try {
      readGroupData(activeCohortYear);
      renderCourseGroups();
    } catch (error) {
      groupStorageError = `그룹 설정 읽기 실패 · 원본 보호 중: ${error.message}`;
      message.textContent = groupStorageError;
      groups = [];
      seeded = new Set();
      renderCourseGroups();
    }
  };
  getApplicationGroupSettings = () => {
    if (workspaceProtected()) throw new Error("편제표 저장 원본을 먼저 복원하세요.");
    if (groupStorageError) throw new Error(groupStorageError);
    sync();
    return JSON.parse(JSON.stringify(groups));
  };
  function button(text, action) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "button"; b.textContent = text; b.onclick = action;
    return b;
  }
  function makeDraggableCourse(course) {
    const chip = document.createElement("span");
    chip.className = "course-group-course-chip";
    chip.textContent = course.subject;
    if (course.groupLinked) {
      chip.classList.add("is-linked");
      chip.title = "편제표 택n 묶음 과목입니다. 1단계 편제표의 묶음 칸에서 변경하세요.";
      return chip;
    }
    chip.draggable = true;
    chip.setAttribute("aria-label", `그룹 변경을 위해 끌기: ${course.subject}`);
    chip.addEventListener("dragstart", (event) => {
      draggedCourse = { grade: course.grade, semester: course.semester, subject: course.subject };
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", course.subject);
      }
    });
    chip.addEventListener("dragend", () => { draggedCourse = null; });
    return chip;
  }
  function planSubjectsForGroup(group) {
    return group.courses.map((subject) =>
      available.get(`${group.grade}:${group.semester}:${subject}`)?.groupSubject || subject);
  }
  function moveCourseToGroup(course, targetGroup) {
    if (!course || !targetGrades.includes(course.grade) ||
        !available.has(`${course.grade}:${course.semester}:${course.subject}`)) return;
    const sourceGroups = groups.filter((group) =>
      group.grade === course.grade && group.semester === course.semester && group.courses.includes(course.subject));
    if (targetGroup && sourceGroups.length === 1 && sourceGroups[0].id === targetGroup.id) return;
    for (const group of sourceGroups) {
      group.courses = group.courses.filter((subject) => subject !== course.subject);
    }
    if (targetGroup && !targetGroup.courses.includes(course.subject)) targetGroup.courses.push(course.subject);
    const invalidated = sourceGroups.filter((group) => group.count > group.courses.length);
    for (const group of invalidated) group.count = null;
    if (typeof window.updateCurriculumSelectionGroup === "function") {
      const subjects = [...new Set([course.groupSubject || course.subject,
        ...(targetGroup ? planSubjectsForGroup(targetGroup) : [])])];
      window.updateCurriculumSelectionGroup(activeCohortYear, course.grade, course.semester, subjects,
        targetGroup?.name || "", targetGroup?.count ?? 1);
    }
    const saved = persist();
    renderCourseGroups();
    if (saved) {
      message.textContent = targetGroup
        ? `${course.subject} 과목을 ${targetGroup.name}에 배치했습니다.${invalidated.length ? " 선택 수를 다시 지정하세요." : " 그룹별 선택 수를 확인하세요."}`
        : `${course.subject} 과목을 미분류로 이동했습니다.${invalidated.length ? " 기존 그룹의 선택 수를 다시 지정하세요." : ""}`;
    }
  }
  renderCourseGroups = () => {
    if (workspaceProtected()) {
      container.replaceChildren();
      container.textContent = "편제표 저장 원본을 먼저 복원하세요. 선택 그룹 원본도 보호 중입니다.";
      refreshWorkspaceContext();
      return;
    }
    if (groupStorageError) {
      publishStorageIssue();
      container.replaceChildren();
      message.textContent = `${groupStorageError}. 상단에서 작업 자료를 백업한 뒤 기존 백업을 복원하거나 읽기를 재시도하세요.`;
      container.appendChild(button("그룹 설정 읽기 재시도", () => {
        try {
          readGroupData(activeCohortYear);
          renderCourseGroups();
        } catch (error) {
          groupStorageError = `그룹 설정 읽기 실패 · 원본 보호 중: ${error.message}`;
          message.textContent = groupStorageError;
        }
      }));
      refreshWorkspaceContext();
      return;
    }
    sync(); container.replaceChildren();
    persist();
    if (!available.size) { container.textContent = "편제표를 불러오면 과목이 미분류 목록에 표시됩니다."; refreshWorkspaceContext(); return; }
    const scopes=[...new Set([...available.values()].filter((c)=>targetGrades.includes(c.grade)).map((c)=>`${c.grade}:${c.semester}`))].sort();
    if (!scopes.length) { container.textContent = "현재 학년의 편제표 과목이 없습니다."; refreshWorkspaceContext(); return; }
    const semesterColumns = document.createElement("div");
    semesterColumns.className = "course-group-semester-columns";
    container.appendChild(semesterColumns);
    for (const scope of scopes) {
      const [grade,semester]=scope.split(":");
      const scopePanel = document.createElement("section");
      scopePanel.className = "course-group-semester";
      scopePanel.dataset.grade = grade;
      scopePanel.dataset.semester = semester;
      semesterColumns.appendChild(scopePanel);
      const courses = [...available.values()].filter((c) => c.grade === grade && c.semester === semester);
      if (!courses.length) continue;
      const gradeGroups = groups.filter((g) => g.grade === grade && g.semester === semester);
      const assigned = new Set(gradeGroups.flatMap((g) => g.courses));
      const unassigned = courses.filter((course) => !assigned.has(course.subject));
      const heading = document.createElement("h4");
      heading.textContent = `${semester==="0"?"학기 미정":semester+"학기"} · ${courses.length}과목 · ${gradeGroups.length}그룹 · 미분류 ${unassigned.length}`;
      scopePanel.appendChild(heading);
      scopePanel.appendChild(button("새 선택 그룹 추가", () => {
        groups.push({ id: crypto.randomUUID(), grade, semester, name: `선택 그룹 ${gradeGroups.length + 1}`, count: null, courses: [] });
        persist();
        renderCourseGroups();
      }));
      const grid=document.createElement("div");grid.className="course-group-grid";scopePanel.appendChild(grid);
      for (const group of gradeGroups) {
        const panel = document.createElement("fieldset");
        panel.className = "course-group-card";
        if (group.linked) panel.classList.add("is-linked");
        panel.addEventListener("dragover", (event) => {
          if (group.linked || !draggedCourse || draggedCourse.grade !== grade || draggedCourse.semester !== semester) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
          panel.classList.add("is-drag-over");
        });
        panel.addEventListener("dragleave", () => panel.classList.remove("is-drag-over"));
        panel.addEventListener("drop", (event) => {
          if (group.linked || !draggedCourse || draggedCourse.grade !== grade || draggedCourse.semester !== semester) return;
          event.preventDefault();
          panel.classList.remove("is-drag-over");
          moveCourseToGroup(draggedCourse, group);
          draggedCourse = null;
        });
        if (group.fill) panel.style.borderTop=`6px solid ${group.fill}`;
        const legend = document.createElement("legend");
        legend.textContent = `${group.name} (${group.courses.length}과목)${group.linked ? " · 편제표 택n 연동" : ""}`; panel.appendChild(legend);
        const nameLabel = document.createElement("label"); nameLabel.textContent = "그룹명 ";
        nameLabel.className = "course-group-name";
        const input = document.createElement("input"); input.value = group.name; input.maxLength = 100;
        input.onchange = () => {
          group.name = input.value.trim();
          if (typeof window.updateCurriculumSelectionGroup === "function") {
            window.updateCurriculumSelectionGroup(activeCohortYear, group.grade, group.semester, planSubjectsForGroup(group), group.name, group.count ?? 1);
          }
          persist();
          renderCourseGroups();
        };
        nameLabel.appendChild(input); panel.appendChild(nameLabel);
        const countLabel = document.createElement("label"); countLabel.textContent = "선택 수";
        countLabel.className = "course-group-count";
        const count = document.createElement("input"); count.type = "number"; count.min = "0"; count.max = String(group.courses.length);
        count.placeholder = "미지정"; count.value = group.count ?? "";
        count.setAttribute("aria-label", `${group.name}: 정확히 선택할 과목 수 (0~${group.courses.length})`);
        count.setAttribute("aria-invalid", String(group.count === null));
        count.onchange = () => {
          const value = count.value === "" ? null : Number(count.value);
          if (value !== null && (!Number.isInteger(value) || value < 0 || value > group.courses.length)) {
            count.setCustomValidity(`0~${group.courses.length} 사이의 정수를 입력하세요.`);
            count.reportValidity();
            count.setCustomValidity("");
            count.value = group.count ?? "";
            return;
          }
          group.count = value;
          if (typeof window.updateCurriculumSelectionGroup === "function") {
            window.updateCurriculumSelectionGroup(activeCohortYear, group.grade, group.semester, planSubjectsForGroup(group), group.name, value ?? 1);
          }
          persist(); renderCourseGroups();
        };
        countLabel.appendChild(count); panel.appendChild(countLabel);
        if (group.linked) {
          input.disabled = true;
          count.disabled = true;
          const linkedNote = document.createElement("p");
          linkedNote.className = "note course-group-linked-note";
          linkedNote.textContent = `편제표 택${group.count} 묶음과 연결된 그룹입니다. 과목·선택 수는 1단계 편제표 묶음 칸에서 수정하세요.`;
          panel.appendChild(linkedNote);
        }
        const subjectList = document.createElement("p");
        subjectList.className = "course-group-subject-summary";
        if (!group.courses.length) subjectList.textContent = "과목을 여기에 끌어 놓으세요.";
        group.courses.forEach((subject, index) => {
          if (index) subjectList.appendChild(document.createTextNode(" · "));
          const course = available.get(`${grade}:${semester}:${subject}`);
          if (course) subjectList.appendChild(makeDraggableCourse(course));
        });
        panel.appendChild(subjectList);
        const deleteButton = button("그룹 삭제", () => {
          if (!window.confirm(`${group.name} 그룹을 삭제할까요? 소속 과목은 미분류로 돌아가며, 편제표에서 다시 배치할 수 있습니다.`)) return;
          if (typeof window.updateCurriculumSelectionGroup === "function") {
            window.updateCurriculumSelectionGroup(activeCohortYear, group.grade, group.semester, planSubjectsForGroup(group), "", 1);
          }
          groups = groups.filter((g) => g.id !== group.id); persist(); renderCourseGroups();
        });
        deleteButton.className = "button button-danger";
        if (!group.linked) panel.appendChild(deleteButton);
        grid.appendChild(panel);
      }
      const unassignedPanel = document.createElement("section");
      unassignedPanel.className = "course-group-unassigned";
      const unassignedTitle = document.createElement("strong");
      unassignedTitle.textContent = unassigned.length
        ? `과목군 미지정 ${unassigned.length}과목`
        : "과목군 미지정 없음 · 그룹에서 해제하려면 여기에 놓으세요";
      const unassignedList = document.createElement("p");
      unassigned.forEach((course, index) => {
        if (index) unassignedList.appendChild(document.createTextNode(" · "));
        unassignedList.appendChild(makeDraggableCourse(course));
      });
      unassignedPanel.addEventListener("dragover", (event) => {
        if (!draggedCourse || draggedCourse.grade !== grade || draggedCourse.semester !== semester) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        unassignedPanel.classList.add("is-drag-over");
      });
      unassignedPanel.addEventListener("dragleave", () => unassignedPanel.classList.remove("is-drag-over"));
      unassignedPanel.addEventListener("drop", (event) => {
        if (!draggedCourse || draggedCourse.grade !== grade || draggedCourse.semester !== semester) return;
        event.preventDefault();
        unassignedPanel.classList.remove("is-drag-over");
        moveCourseToGroup(draggedCourse, null);
        draggedCourse = null;
      });
      unassignedPanel.append(unassignedTitle, unassignedList);
      scopePanel.appendChild(unassignedPanel);
    }
    refreshWorkspaceContext();
  };
  getCourseApplicationGroups = (grades = targetGrades) => {
    if (workspaceProtected()) throw new Error("편제표 저장 원본을 먼저 복원하세요.");
    if (groupStorageError) throw new Error(groupStorageError);
    sync();
    if (!persist()) throw new Error(getApplicationGroupStorageIssue());
    const relevantGroups = groups.filter((g) => grades.includes(g.grade));
    for (const [id, course] of available) {
      if (!grades.includes(course.grade)) continue;
      if (!groups.some((g) => g.grade === course.grade && g.semester===course.semester && g.courses.includes(course.subject))) {
        throw new Error(`${course.grade}학년 ${course.semester==="0"?"학기 미정":course.semester+"학기"} ${course.subject}: 미분류 과목을 그룹에 배치하세요.`);
      }
    }
    for (const group of relevantGroups) {
      if (!group.courses.length) throw new Error(`${group.name}: 빈 그룹에 과목을 배치하거나 그룹을 삭제하세요.`);
      if (!group.name || !Number.isInteger(group.count) || group.count < 0 || group.count > group.courses.length) {
        throw new Error(`${group.grade}학년 ${group.name}: 선택 수를 0~${group.courses.length} 정수로 직접 지정하세요.`);
      }
    }
    for (const grade of grades) {
      const active = relevantGroups.filter((g) => g.grade === grade);
      if (active.length && !active.some((g) => g.count > 0)) throw new Error(`${grade}학년은 최소 1과목 이상 선택하도록 지정하세요.`);
    }
    return JSON.parse(JSON.stringify(relevantGroups));
  };
  const gradeTabs = ["1", "2"].map((grade) => document.getElementById(`applicationGrade${grade}Tab`));
  switchApplicationMenuGrade = (grade, focus = false) => {
    grade = String(grade);
    const index = ["1", "2"].indexOf(grade);
    if (index < 0 || gradeTabs[index].disabled) return;
    state.applicationMenuGrade = grade;
    gradeTabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.setAttribute("tabindex", i === index ? "0" : "-1");
    });
    document.getElementById("applicationGradeWorkspace").setAttribute("aria-labelledby", `applicationGrade${grade}Tab`);
    if (typeof switchApplicationGroupCohort === "function") {
      switchApplicationGroupCohort(cohortYearForPlanGrade(String(Number(grade) + 1)));
    }
    const cohortYear = typeof getApplicationCohortYear === "function" ? getApplicationCohortYear(grade) : "";
    document.getElementById("applicationGradeDescription").textContent =
      `현재 ${grade}학년 학생(${cohortYear}학년도 신입생)의 해당 3개년 편제표에서 ${Number(grade) + 1}학년 과목을 확인합니다. 올해 전학년 편제표는 수강신청 과목 기준으로 사용하지 않습니다.`;
    setApplicationTargetGrades([String(Number(grade) + 1)]);
    renderApplicationSubjects();
    renderRoundStatus();
    if (typeof updateApplicationGradeControls === "function") updateApplicationGradeControls();
    if (focus) gradeTabs[index].focus();
  };
  gradeTabs.forEach((tab, index) => {
    tab.addEventListener("click", () => switchApplicationMenuGrade(String(index + 1)));
    tab.addEventListener("keydown", (event) => {
      const next = event.key === "ArrowRight" || event.key === "ArrowLeft" ? 1 - index :
        event.key === "Home" ? 0 : event.key === "End" ? 1 : null;
      if (next === null) return;
      event.preventDefault();
      switchApplicationMenuGrade(String(next + 1), true);
    });
  });
  switchApplicationMenuGrade(state.applicationMenuGrade || "1");
})();
