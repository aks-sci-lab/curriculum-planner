"use strict";
var renderCourseGroups;
var getCourseApplicationGroups;
var getGroupedApplicationSubjects;
var setApplicationTargetGrades;
var getApplicationGroupSettings;
var switchApplicationMenuGrade;
var switchApplicationGroupCohort;
var createApplicationGroupFromCurriculum;
(() => {
  const workspaceTabs = ["Groups", "Online", "Results"]
    .map((name) => document.getElementById(`application${name}Tab`));
  function openWorkspaceTab(index, focus = false) {
    workspaceTabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.setAttribute("tabindex", i === index ? "0" : "-1");
      const panel = document.getElementById(tab.getAttribute("aria-controls"));
      panel.classList[i === index ? "remove" : "add"]("hidden");
    });
    if (focus) workspaceTabs[index].focus();
  }
  workspaceTabs.forEach((tab, index) => {
    tab.addEventListener("click", () => openWorkspaceTab(index));
    tab.addEventListener("keydown", (event) => {
      const next = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 :
        event.key === "Home" ? 0 : event.key === "End" ? 2 : null;
      if (next === null) return;
      event.preventDefault();
      openWorkspaceTab(next, true);
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
  let activeScope = "";
  let targetGrades = ["2"];
  setApplicationTargetGrades = (grades) => {
    targetGrades = [...new Set(grades.map(String))];
    renderCourseGroups();
  };
  let seeded = new Set();
  function readGroupData(year) {
    const groupKey = cohortStorageKey(year);
    groups = JSON.parse(localStorage.getItem(groupKey) || "[]");
    seeded = new Set(JSON.parse(localStorage.getItem(groupKey+"-seeded") || "[]"));
    if (!Array.isArray(groups) || groups.some((g) => !g || !Array.isArray(g.courses) ||
      typeof g.name !== "string" || typeof g.id !== "string" || !["2", "3"].includes(g.grade) ||
      !["0", "1", "2"].includes(g.semester) || g.courses.some((name) => typeof name !== "string"))) {
      throw new Error("그룹 저장 형식이 잘못되었습니다.");
    }
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
        result[grade].push({ ...course, semester,
          subject: semesters.length > 1 ? `${course.subject} (${semester}학기)` : course.subject,
          fill: course.semesterColors?.[semester] || "" });
      }
    }
    return result;
  };
  try {
    migrateLegacyGroupData();
    readGroupData(activeCohortYear);
  } catch (error) {
    message.textContent = `그룹 설정 읽기 실패: ${error.message}`;
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
      if (previousSize && !group.courses.length) removedGroups.add(group.id);
    }
    groups = groups.filter((group) => !removedGroups.has(group.id));
    for (const [id,course] of available) {
      if (assigned.has(id) || !course.fill || seeded.has(id)) continue;
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
    try {
      const groupKey = cohortStorageKey(activeCohortYear);
      localStorage.setItem(groupKey, JSON.stringify(groups));
      localStorage.setItem(groupKey+"-seeded",JSON.stringify([...seeded]));
      localStorage.setItem(key, JSON.stringify(groups));
      localStorage.setItem(key+"-seeded",JSON.stringify([...seeded]));
    }
    catch (error) {
      message.textContent = `그룹 저장 실패: ${error.message}`;
    }
  }
  switchApplicationGroupCohort = (year) => {
    year = String(year || "");
    if (year === activeCohortYear) return;
    persist();
    activeCohortYear = year;
    try {
      readGroupData(activeCohortYear);
      renderCourseGroups();
    } catch (error) {
      message.textContent = `그룹 설정 읽기 실패: ${error.message}`;
      groups = [];
      seeded = new Set();
      renderCourseGroups();
    }
  };
  getApplicationGroupSettings = () => {
    sync();
    return JSON.parse(JSON.stringify(groups));
  };
  createApplicationGroupFromCurriculum = ({ year, grade, semester, name, courses }) => {
    year = String(year || "").trim();
    grade = String(grade || "");
    semester = String(semester || "");
    name = String(name || "").trim();
    courses = [...new Set((Array.isArray(courses) ? courses : []).map((course) => String(course || "").trim()).filter(Boolean))];
    if (!/^\d{4}$/.test(year)) throw new Error("선택과목군의 신입생 학년도를 확인하세요.");
    if (!["2", "3"].includes(grade) || !["1", "2"].includes(semester)) {
      throw new Error("선택과목군의 학년과 학기를 확인하세요.");
    }
    if (!name || name === "미분류" || name.length > 100) throw new Error("선택과목군 이름을 1~100자로 입력하세요.");
    if (!courses.length) throw new Error("선택과목군에 넣을 과목을 하나 이상 클릭하세요.");

    const groupKey = cohortStorageKey(year);
    let cohortGroups;
    try {
      cohortGroups = JSON.parse(localStorage.getItem(groupKey) || "[]");
    } catch (error) {
      throw new Error(`기존 선택과목군을 읽지 못했습니다: ${error.message}`);
    }
    if (!Array.isArray(cohortGroups) || cohortGroups.some((group) => !group || !Array.isArray(group.courses) ||
      typeof group.name !== "string" || typeof group.id !== "string" || !["2", "3"].includes(group.grade) ||
      !["0", "1", "2"].includes(group.semester) || group.courses.some((course) => typeof course !== "string"))) {
      throw new Error("저장된 선택과목군 형식이 잘못되었습니다.");
    }
    if (cohortGroups.some((group) => group.grade === grade && group.semester === semester &&
      group.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new Error(`${grade}학년 ${semester}학기에 같은 이름의 선택과목군이 이미 있습니다.`);
    }
    const selectedCourses = new Set(courses);
    let movedCount = 0;
    for (const existing of cohortGroups.filter((group) => group.grade === grade && group.semester === semester)) {
      const before = existing.courses.length;
      existing.courses = existing.courses.filter((course) => !selectedCourses.has(course));
      movedCount += before - existing.courses.length;
      if (existing.count > existing.courses.length) existing.count = null;
    }
    cohortGroups = cohortGroups.filter((existing) => existing.courses.length || existing.grade !== grade || existing.semester !== semester);
    const group = { id: crypto.randomUUID(), grade, semester, name, count: null, courses };
    cohortGroups.push(group);
    localStorage.setItem(groupKey, JSON.stringify(cohortGroups));
    if (year === activeCohortYear) {
      groups = cohortGroups;
      renderCourseGroups();
    }
    return { ...group, year, movedCount };
  };
  function button(text, action) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "button"; b.textContent = text; b.onclick = action;
    return b;
  }
  renderCourseGroups = () => {
    sync(); container.replaceChildren();
    persist();
    if (!available.size) { container.textContent = "편제표를 불러오면 과목이 미분류 목록에 표시됩니다."; return; }
    const scopes=[...new Set([...available.values()].filter((c)=>targetGrades.includes(c.grade)).map((c)=>`${c.grade}:${c.semester}`))].sort();
    if (!scopes.includes(activeScope)) activeScope=scopes[0];
    if (!activeScope) { container.textContent = "현재 학년의 편제표 과목이 없습니다."; return; }
    const tabs=document.createElement("div");tabs.className="group-scope-tabs"; tabs.setAttribute("role","tablist");
    tabs.setAttribute("aria-label","학년·학기 선택");
    for (const [scopeIndex,scope] of scopes.entries()) {
      const [grade,semester]=scope.split(":");
      const tab=button(`${grade}학년 ${semester==="0"?"학기 미정":semester+"학기"}`,()=>{
        activeScope=scope;renderCourseGroups();
      });
      tab.setAttribute("role","tab");tab.setAttribute("aria-selected",String(activeScope===scope));tabs.appendChild(tab);
      tab.setAttribute("tabindex",activeScope===scope?"0":"-1");
      tab.onkeydown=(event)=>{
        const next=event.key==="ArrowRight"?(scopeIndex+1)%scopes.length:
          event.key==="ArrowLeft"?(scopeIndex+scopes.length-1)%scopes.length:
          event.key==="Home"?0:event.key==="End"?scopes.length-1:null;
        if (next===null) return;
        event.preventDefault();activeScope=scopes[next];renderCourseGroups();
        [...container.children].find((child) => child.className === "group-scope-tabs").children[next].focus();
      };
    }
    container.appendChild(tabs);
    for (const scope of scopes.filter((s)=>s===activeScope)) {
      const [grade,semester]=scope.split(":");
      const courses = [...available.values()].filter((c) => c.grade === grade && c.semester === semester);
      if (!courses.length) continue;
      const gradeGroups = groups.filter((g) => g.grade === grade && g.semester === semester);
      const heading = document.createElement("h4");
      heading.textContent = `${grade}학년 ${semester==="0"?"학기 미정":semester+"학기"} · 현재 ${Number(grade)-1}학년 신청`;
      container.appendChild(heading);
      const assigned = new Set(gradeGroups.flatMap((g) => g.courses));
      const unassigned = courses.filter((course) => !assigned.has(course.subject));
      const grid=document.createElement("div");grid.className="course-group-grid";container.appendChild(grid);
      for (const group of gradeGroups) {
        const panel = document.createElement("fieldset");
        panel.className = "course-group-card";
        if (group.fill) panel.style.borderTop=`6px solid ${group.fill}`;
        const legend = document.createElement("legend");
        legend.textContent = `${group.name} (${group.courses.length}과목)`; panel.appendChild(legend);
        const nameLabel = document.createElement("label"); nameLabel.textContent = "그룹명 ";
        nameLabel.className = "course-group-name";
        const input = document.createElement("input"); input.value = group.name; input.maxLength = 100;
        input.onchange = () => { group.name = input.value.trim(); persist(); renderCourseGroups(); };
        nameLabel.appendChild(input); panel.appendChild(nameLabel);
        const countLabel = document.createElement("label"); countLabel.textContent = "선택할 과목 수 (정확히)";
        countLabel.className = "course-group-count";
        const count = document.createElement("input"); count.type = "number"; count.min = "0"; count.max = String(group.courses.length);
        count.placeholder = "직접 지정"; count.value = group.count ?? "";
        count.onchange = () => {
          const value = count.value === "" ? null : Number(count.value);
          if (value !== null && (!Number.isInteger(value) || value < 0 || value > group.courses.length)) {
            count.setCustomValidity(`0~${group.courses.length} 사이의 정수를 입력하세요.`);
            count.reportValidity();
            count.setCustomValidity("");
            count.value = group.count ?? "";
            return;
          }
          group.count = value; persist(); renderCourseGroups();
        };
        countLabel.appendChild(count); panel.appendChild(countLabel);
        const subjectList = document.createElement("p");
        subjectList.className = "course-group-subject-summary";
        subjectList.textContent = group.courses.join(" · ");
        panel.appendChild(subjectList);
        panel.appendChild(button("그룹 삭제", () => {
          if (!window.confirm(`${group.name} 그룹을 삭제할까요? 소속 과목은 미분류로 돌아가며, 편제표에서 다시 배치할 수 있습니다.`)) return;
          groups = groups.filter((g) => g.id !== group.id); persist(); renderCourseGroups();
        }));
        grid.appendChild(panel);
      }
      if (unassigned.length) {
        const panel = document.createElement("section");
        panel.className = "course-group-unassigned";
        const title = document.createElement("strong");
        title.textContent = `과목군 미지정 ${unassigned.length}과목`;
        const list = document.createElement("p");
        list.textContent = unassigned.map((course) => course.subject).join(" · ");
        const edit = button("편제표에서 과목군 편성", () =>
          document.querySelector('[data-workflow-step="1"]')?.click());
        panel.append(title, list, edit);
        container.appendChild(panel);
      }
    }
  };
  getCourseApplicationGroups = (grades = targetGrades) => {
    sync();
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
      `현재 ${grade}학년 학생(${cohortYear}학년도 신입생)의 ${Number(grade) + 1}학년 과목·그룹과 온라인 신청을 관리합니다.`;
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
