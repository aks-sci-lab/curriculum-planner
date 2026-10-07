"use strict";
var renderCourseGroups;
var getCourseApplicationGroups;
var getGroupedApplicationSubjects;
var setApplicationTargetGrades;
var getApplicationGroupSettings;
var switchApplicationMenuGrade;
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
  const container = document.getElementById("courseGroupEditor");
  const message = document.getElementById("courseGroupMessage");
  let groups = [];
  let available = new Map();
  const selected = new Set();
  let query = "";
  let activeScope = "";
  let targetGrades = ["2"];
  setApplicationTargetGrades = (grades) => {
    targetGrades = [...new Set(grades.map(String))];
    selected.clear();
    renderCourseGroups();
  };
  let seeded = new Set();
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
    groups = JSON.parse(localStorage.getItem(key) || "[]");
    seeded = new Set(JSON.parse(localStorage.getItem(key+"-seeded") || "[]"));
    if (!Array.isArray(groups) || groups.some((g) => !g || !Array.isArray(g.courses) ||
      typeof g.name !== "string" || typeof g.id !== "string" || !["2", "3"].includes(g.grade) ||
      !["0", "1", "2"].includes(g.semester) || g.courses.some((name) => typeof name !== "string"))) {
      throw new Error("그룹 저장 형식이 잘못되었습니다.");
    }
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
    for (const id of selected) if (!available.has(id)) selected.delete(id);
  }
  function persist() {
    try { localStorage.setItem(key, JSON.stringify(groups)); localStorage.setItem(key+"-seeded",JSON.stringify([...seeded])); }
    catch (error) {
      message.textContent = `그룹 저장 실패: ${error.message}`;
    }
  }
  getApplicationGroupSettings = () => {
    sync();
    return JSON.parse(JSON.stringify(groups));
  };
  function button(text, action) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "button"; b.textContent = text; b.onclick = action;
    return b;
  }
  function move(grade, semester, targetId) {
    const prefix=`${grade}:${semester}:`;
    const names = [...selected].filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
    if (!names.length) { message.textContent = "이동할 과목을 체크하세요."; return; }
    const target = groups.find((g) => g.id === targetId);
    if (targetId && (!target || target.grade !== grade || target.semester !== semester)) {
      message.textContent = "같은 학년·학기의 그룹으로만 이동할 수 있습니다.";
      return;
    }
    for (const group of groups.filter((g) => g.grade === grade && g.semester === semester)) {
      group.courses = group.courses.filter((name) => !names.includes(name));
    }
    if (target) target.courses.push(...names);
    selected.clear(); persist(); renderCourseGroups();
    message.textContent = `${names.length}과목을 ${target ? target.name : "미분류"}로 이동했습니다. 그룹별 선택 수를 확인하세요.`;
  }
  function courseRow(course) {
    const label = document.createElement("label"); label.className = "application-subject";
    const box = document.createElement("input"); box.type = "checkbox";
    const id = `${course.grade}:${course.semester}:${course.subject}`; box.checked = selected.has(id);
    box.onchange = () => {
      if (box.checked) selected.add(id); else selected.delete(id);
      message.textContent = `${selected.size}과목 선택됨 · 위 이동 버튼으로 일괄 배치하세요.`;
    };
    label.append(box, document.createTextNode(`${course.subject} · ${course.semester || "미정"}학기 · ${course.area || "교과군 미정"}`));
    return label;
  }
  renderCourseGroups = () => {
    sync(); container.replaceChildren();
    persist();
    if (!available.size) { container.textContent = "편제표를 불러오면 과목이 미분류 목록에 표시됩니다."; return; }
    const search = document.createElement("input"); search.type = "search"; search.placeholder = "과목·교과군 검색";
    search.setAttribute("aria-label", "그룹 설정 과목 검색"); search.value = query;
    search.onchange = () => { query = search.value.trim(); renderCourseGroups(); };
    container.appendChild(search);
    container.appendChild(button("편제표 색상으로 다시 구성",()=>{
      if (!window.confirm(`${targetGrades.join("·")}학년 과목의 그룹 배치와 선택 수를 지우고 편제표 색상으로 다시 구성할까요? 다른 학년은 유지됩니다.`)) return;
      groups=groups.filter((group)=>!targetGrades.includes(group.grade));
      seeded=new Set([...seeded].filter((id)=>!targetGrades.includes(id.split(":")[0])));
      selected.clear();renderCourseGroups();
    }));
    const scopes=[...new Set([...available.values()].filter((c)=>targetGrades.includes(c.grade)).map((c)=>`${c.grade}:${c.semester}`))].sort();
    if (!scopes.includes(activeScope)) activeScope=scopes[0];
    const tabs=document.createElement("div");tabs.className="group-scope-tabs"; tabs.setAttribute("role","tablist");
    tabs.setAttribute("aria-label","학년·학기 선택");
    for (const [scopeIndex,scope] of scopes.entries()) {
      const [grade,semester]=scope.split(":");
      const tab=button(`${grade}학년 ${semester==="0"?"학기 미정":semester+"학기"}`,()=>{
        activeScope=scope;selected.clear();renderCourseGroups();
      });
      tab.setAttribute("role","tab");tab.setAttribute("aria-selected",String(activeScope===scope));tabs.appendChild(tab);
      tab.setAttribute("tabindex",activeScope===scope?"0":"-1");
      tab.onkeydown=(event)=>{
        const next=event.key==="ArrowRight"?(scopeIndex+1)%scopes.length:
          event.key==="ArrowLeft"?(scopeIndex+scopes.length-1)%scopes.length:
          event.key==="Home"?0:event.key==="End"?scopes.length-1:null;
        if (next===null) return;
        event.preventDefault();activeScope=scopes[next];selected.clear();renderCourseGroups();
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
      const name = document.createElement("input"); name.placeholder = "새 그룹명 (예: 사회·과학 선택)";
      name.setAttribute("aria-label", `${grade}학년 새 그룹명`); name.maxLength = 100;
      container.appendChild(name);
      container.appendChild(button("그룹 만들기", () => {
        if (!name.value.trim()) { message.textContent = "새 그룹명을 입력하세요."; name.focus(); return; }
        groups.push({ id: crypto.randomUUID(), grade, semester, name: name.value.trim(), count: null, courses: [] });
        persist(); renderCourseGroups();
      }));
      const target = document.createElement("select");
      target.setAttribute("aria-label", `${grade}학년 선택 과목 이동 대상`);
      const unassigned = document.createElement("option"); unassigned.value = ""; unassigned.textContent = "미분류";
      target.appendChild(unassigned);
      for (const g of gradeGroups) {
        const option = document.createElement("option"); option.value = g.id; option.textContent = g.name; target.appendChild(option);
      }
      container.appendChild(target);
      container.appendChild(button("선택 과목 일괄 이동", () => move(grade, semester, target.value)));
      const assigned = new Set(gradeGroups.flatMap((g) => g.courses));
      const buckets = [{ name: "미분류", courses: courses.filter((c) => !assigned.has(c.subject)).map((c) => c.subject) }, ...gradeGroups];
      const grid=document.createElement("div");grid.className="course-group-grid";container.appendChild(grid);
      for (const group of buckets) {
        const panel = document.createElement("fieldset");
        if (group.fill) panel.style.borderTop=`6px solid ${group.fill}`;
        const legend = document.createElement("legend");
        legend.textContent = `${group.name} (${group.courses.length}과목)`; panel.appendChild(legend);
        if (group.id) {
          const nameLabel = document.createElement("label"); nameLabel.textContent = "그룹명 ";
          const input = document.createElement("input"); input.value = group.name; input.maxLength = 100;
          input.onchange = () => { group.name = input.value.trim(); persist(); };
          nameLabel.appendChild(input); panel.appendChild(nameLabel);
          const countLabel = document.createElement("label"); countLabel.textContent = " 정확히 선택할 과목 수 ";
          const count = document.createElement("input"); count.type = "number"; count.min = "0"; count.max = String(group.courses.length);
          count.placeholder = "직접 지정"; count.value = group.count ?? "";
          count.onchange = () => { group.count = count.value === "" ? null : Number(count.value); persist(); };
          countLabel.appendChild(count); panel.appendChild(countLabel);
          grid.appendChild(panel);
          panel.appendChild(button("그룹 삭제 · 과목은 미분류로", () => {
            if (!window.confirm(`${group.name} 그룹을 삭제할까요? 과목은 미분류로 이동합니다.`)) return;
            groups = groups.filter((g) => g.id !== group.id); persist(); renderCourseGroups();
          }));
        } else grid.appendChild(panel);
        const visible = group.courses.map((subject) => available.get(`${grade}:${semester}:${subject}`))
          .filter((c) => !query || `${c.subject} ${c.area}`.includes(query));
        panel.appendChild(button("표시 과목 전체 선택", () => {
          for (const c of visible) selected.add(`${grade}:${semester}:${c.subject}`);
          renderCourseGroups(); message.textContent = `${selected.size}과목 선택됨`;
        }));
        for (const course of visible) panel.appendChild(courseRow(course));
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
    document.getElementById("applicationGradeDescription").textContent =
      `현재 ${grade}학년 학생의 ${Number(grade) + 1}학년 과목·그룹과 온라인 신청을 관리합니다.`;
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
