"use strict";
var renderCourseGroups;
var getCourseApplicationGroups;
(() => {
  const key = "curriculum-manual-application-groups-v2";
  const container = document.getElementById("courseGroupEditor");
  const message = document.getElementById("courseGroupMessage");
  let groups = [];
  let available = new Map();
  const selected = new Set();
  let query = "";
  try {
    groups = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(groups) || groups.some((g) => !g || !Array.isArray(g.courses) ||
      typeof g.name !== "string" || typeof g.id !== "string" || !["2", "3"].includes(g.grade))) {
      throw new Error("그룹 저장 형식이 잘못되었습니다.");
    }
  } catch (error) {
    message.textContent = `그룹 설정 읽기 실패: ${error.message}`;
    groups = [];
  }
  function sync() {
    available = new Map();
    const subjects = selectedApplicationSubjects();
    for (const grade of ["2", "3"]) {
      for (const course of subjects?.[grade] || []) available.set(`${grade}:${course.subject}`, { ...course, grade });
    }
    const assigned = new Set();
    for (const group of groups) {
      group.courses = group.courses.filter((name) => {
        const id = `${group.grade}:${name}`;
        if (!available.has(id) || assigned.has(id)) return false;
        assigned.add(id);
        return true;
      });
    }
    for (const id of selected) if (!available.has(id)) selected.delete(id);
  }
  function persist() {
    try { localStorage.setItem(key, JSON.stringify(groups)); }
    catch (error) { message.textContent = `그룹 저장 실패: ${error.message}`; }
  }
  function button(text, action) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "button"; b.textContent = text; b.onclick = action;
    return b;
  }
  function move(grade, targetId) {
    const names = [...selected].filter((id) => id.startsWith(`${grade}:`)).map((id) => id.slice(2));
    if (!names.length) { message.textContent = "이동할 과목을 체크하세요."; return; }
    for (const group of groups.filter((g) => g.grade === grade)) {
      group.courses = group.courses.filter((name) => !names.includes(name));
    }
    const target = groups.find((g) => g.id === targetId);
    if (target) target.courses.push(...names);
    selected.clear(); persist(); renderCourseGroups();
    message.textContent = `${names.length}과목을 ${target ? target.name : "미분류"}로 이동했습니다. 그룹별 선택 수를 확인하세요.`;
  }
  function courseRow(course) {
    const label = document.createElement("label"); label.className = "application-subject";
    const box = document.createElement("input"); box.type = "checkbox";
    const id = `${course.grade}:${course.subject}`; box.checked = selected.has(id);
    box.onchange = () => {
      if (box.checked) selected.add(id); else selected.delete(id);
      message.textContent = `${selected.size}과목 선택됨 · 위 이동 버튼으로 일괄 배치하세요.`;
    };
    label.append(box, document.createTextNode(`${course.subject} · ${course.semester || "미정"}학기 · ${course.area || "교과군 미정"}`));
    return label;
  }
  renderCourseGroups = () => {
    sync(); container.replaceChildren();
    if (!available.size) { container.textContent = "편제표를 불러오면 과목이 미분류 목록에 표시됩니다."; return; }
    const search = document.createElement("input"); search.type = "search"; search.placeholder = "과목·교과군 검색";
    search.setAttribute("aria-label", "그룹 설정 과목 검색"); search.value = query;
    search.onchange = () => { query = search.value.trim(); renderCourseGroups(); };
    container.appendChild(search);
    for (const grade of ["2", "3"]) {
      const courses = [...available.values()].filter((c) => c.grade === grade);
      if (!courses.length) continue;
      const gradeGroups = groups.filter((g) => g.grade === grade);
      const heading = document.createElement("h4");
      heading.textContent = `${grade}학년 과목 · 현재 ${Number(grade)-1}학년 신청`;
      container.appendChild(heading);
      const name = document.createElement("input"); name.placeholder = "새 그룹명 (예: 사회·과학 선택)";
      name.setAttribute("aria-label", `${grade}학년 새 그룹명`); name.maxLength = 100;
      container.appendChild(name);
      container.appendChild(button("그룹 만들기", () => {
        if (!name.value.trim()) { message.textContent = "새 그룹명을 입력하세요."; name.focus(); return; }
        groups.push({ id: crypto.randomUUID(), grade, name: name.value.trim(), count: null, courses: [] });
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
      container.appendChild(button("선택 과목 일괄 이동", () => move(grade, target.value)));
      const assigned = new Set(gradeGroups.flatMap((g) => g.courses));
      const buckets = [{ name: "미분류", courses: courses.filter((c) => !assigned.has(c.subject)).map((c) => c.subject) }, ...gradeGroups];
      for (const group of buckets) {
        const panel = document.createElement("fieldset");
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
          container.appendChild(panel);
          panel.appendChild(button("그룹 삭제 · 과목은 미분류로", () => {
            if (!window.confirm(`${group.name} 그룹을 삭제할까요? 과목은 미분류로 이동합니다.`)) return;
            groups = groups.filter((g) => g.id !== group.id); persist(); renderCourseGroups();
          }));
        } else container.appendChild(panel);
        const visible = group.courses.map((subject) => available.get(`${grade}:${subject}`))
          .filter((c) => !query || `${c.subject} ${c.area}`.includes(query));
        panel.appendChild(button("표시 과목 전체 선택", () => {
          for (const c of visible) selected.add(`${grade}:${c.subject}`);
          renderCourseGroups(); message.textContent = `${selected.size}과목 선택됨`;
        }));
        for (const course of visible) panel.appendChild(courseRow(course));
      }
    }
  };
  getCourseApplicationGroups = () => {
    sync();
    for (const [id, course] of available) {
      if (!groups.some((g) => g.grade === course.grade && g.courses.includes(course.subject))) {
        throw new Error(`${id}: 미분류 과목을 그룹에 배치하세요.`);
      }
    }
    for (const group of groups) {
      if (!group.courses.length) throw new Error(`${group.name}: 빈 그룹에 과목을 배치하거나 그룹을 삭제하세요.`);
      if (!group.name || !Number.isInteger(group.count) || group.count < 0 || group.count > group.courses.length) {
        throw new Error(`${group.grade}학년 ${group.name}: 선택 수를 0~${group.courses.length} 정수로 직접 지정하세요.`);
      }
    }
    for (const grade of ["2", "3"]) {
      const active = groups.filter((g) => g.grade === grade);
      if (active.length && !active.some((g) => g.count > 0)) throw new Error(`${grade}학년은 최소 1과목 이상 선택하도록 지정하세요.`);
    }
    return JSON.parse(JSON.stringify(groups));
  };
  renderCourseGroups();
})();
