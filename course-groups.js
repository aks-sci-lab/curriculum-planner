"use strict";
var renderCourseGroups;
var getCourseApplicationGroups;
(() => {
  const key = "curriculum-application-groups-v1";
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(saved) || saved.some((g) => !g || !Array.isArray(g.courses) ||
      typeof g.name !== "string" || typeof g.id !== "string" || !["2","3"].includes(g.grade))) {
      throw new Error("그룹 저장 형식이 잘못되었습니다.");
    }
  } catch (error) {
    document.getElementById("courseGroupMessage").textContent = `그룹 설정 읽기 실패: ${error.message}`;
    saved = [];
  }
  let groups = [];
  const container = document.getElementById("courseGroupEditor");
  function sync() {
    const subjects = selectedApplicationSubjects();
    const available = new Map();
    for (const grade of ["2", "3"]) {
      for (const course of subjects?.[grade] || []) available.set(`${grade}:${course.subject}`, { ...course, grade });
    }
    const assigned = new Set();
    groups = saved.map((group) => {
      group.courses = (group.courses || []).filter((name) => {
      const id = `${group.grade}:${name}`;
      if (!available.has(id) || assigned.has(id)) return false;
      assigned.add(id); return true;
      });
      return group;
    }).filter((group) => group.courses.length);
    for (const [id, course] of available) {
      if (assigned.has(id)) continue;
      const name = `${course.semester || "미정"}학기 · ${course.area || "선택과목"}`;
      let group = groups.find((g) => g.grade === course.grade && g.name === name);
      if (!group) {
        group = { id: crypto.randomUUID(), grade: course.grade, name, count: 1, courses: [] };
        groups.push(group);
      }
      group.courses.push(course.subject);
    }
    saved = groups;
  }
  function persist() {
    saved = groups;
    try { localStorage.setItem(key, JSON.stringify(groups)); }
    catch (error) { document.getElementById("courseGroupMessage").textContent = `그룹 저장 실패: ${error.message}`; }
  }
  renderCourseGroups = () => {
    sync();
    container.replaceChildren();
    if (!groups.length) { container.textContent = "편제표를 불러오면 그룹이 자동 생성됩니다."; return; }
    for (const grade of ["2", "3"]) {
      const gradeGroups = groups.filter((g) => g.grade === grade);
      if (!gradeGroups.length) continue;
      const heading = document.createElement("h4");
      heading.textContent = `${grade}학년 과목 · 현재 ${Number(grade)-1}학년 신청`;
      container.appendChild(heading);
      const add = document.createElement("button"); add.type = "button"; add.className = "button"; add.textContent = "새 그룹 추가";
      add.onclick = () => {
        const first = gradeGroups.find((g) => g.courses.length > 1);
        if (!first) { document.getElementById("courseGroupMessage").textContent = "분리할 과목이 2개 이상인 그룹이 필요합니다."; return; }
        groups.push({ id: crypto.randomUUID(), grade, name: "새 선택 그룹", count: 1, courses: [first.courses.pop()] });
        persist(); renderCourseGroups();
      };
      container.appendChild(add);
      for (const group of gradeGroups) {
        const panel = document.createElement("fieldset");
        const legend = document.createElement("legend"); legend.textContent = `${group.name} (${group.courses.length}과목)`; panel.appendChild(legend);
        const nameLabel = document.createElement("label"); nameLabel.textContent = "그룹명 ";
        const name = document.createElement("input"); name.value = group.name; name.maxLength = 100;
        name.onchange = () => { group.name = name.value.trim(); persist(); renderCourseGroups(); };
        nameLabel.appendChild(name); panel.appendChild(nameLabel);
        const countLabel = document.createElement("label"); countLabel.textContent = " 정확히 선택할 과목 수 ";
        const count = document.createElement("input"); count.type = "number"; count.min = "0"; count.max = String(group.courses.length); count.value = group.count;
        count.onchange = () => { group.count = Number(count.value); persist(); };
        countLabel.appendChild(count); panel.appendChild(countLabel);
        for (const subject of group.courses) {
          const row = document.createElement("label"); row.className = "application-subject"; row.textContent = subject + " ";
          const select = document.createElement("select"); select.setAttribute("aria-label", `${subject} 이동할 그룹`);
          for (const target of gradeGroups) {
            const option = document.createElement("option"); option.value = target.id; option.textContent = target.name; select.appendChild(option);
          }
          select.value = group.id;
          select.onchange = () => {
            const target = groups.find((g) => g.id === select.value);
            group.courses = group.courses.filter((c) => c !== subject); target.courses.push(subject);
            persist(); renderCourseGroups();
          };
          row.appendChild(select); panel.appendChild(row);
        }
        container.appendChild(panel);
      }
    }
  };
  getCourseApplicationGroups = () => {
    sync();
    for (const group of groups) {
      if (!group.name || !Number.isInteger(group.count) || group.count < 0 || group.count > group.courses.length) {
        throw new Error(`${group.grade}학년 ${group.name || "이름 없는 그룹"}: 선택 수는 0~${group.courses.length} 정수여야 합니다.`);
      }
    }
    for (const grade of ["2", "3"]) {
      const active = groups.filter((g) => g.grade === grade);
      if (active.length && !active.some((g) => g.count > 0)) throw new Error(`${grade}학년은 최소 한 그룹에서 1과목 이상 선택하도록 지정하세요.`);
    }
    return JSON.parse(JSON.stringify(groups));
  };
  renderCourseGroups();
})();
