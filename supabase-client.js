"use strict";

(() => {
  const PROJECT_URL = "https://hapfkdkbhnqpfjdepozv.supabase.co";
  const PUBLIC_KEY = "sb_publishable_HCUWUrxTxaDVtwv4KvPj4A_4RKnLD-p";
  const byId = (id) => document.getElementById(id);
  let session = null;
  const PKCE_STORAGE_KEY = "curriculum-google-pkce";
  let latestCodes = null;
  let activeCode = "";
  let application = null;
  let teacherBusy = false;
  let studentBusy = false;
  let printingCodes = null;
  const eventId = new URLSearchParams(new URL(window.location.href).hash.slice(1)).get("event");
  const validEvent = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

  function eventLink(id) {
    if (!validEvent.test(id)) throw new Error("수강신청 식별자가 잘못되었습니다.");
    const url = new URL(window.location.href);
    url.search = "";
    url.hash = new URLSearchParams({ event: id }).toString();
    return url.href;
  }

  async function request(path, { method = "POST", body, authenticated = false } = {}) {
    if (authenticated && !session) throw new Error("교사 로그인이 필요합니다.");
    if (authenticated && session.expires_at <= Date.now() / 1000 + 30) {
      const refreshed = await request("/auth/v1/token?grant_type=refresh_token", {
        body: { refresh_token: session.refresh_token },
      });
      setSession(refreshed);
    }
    const headers = { apikey: PUBLIC_KEY, "Content-Type": "application/json" };
    if (authenticated) headers.Authorization = `Bearer ${session.access_token}`;
    let response;
    try {
      response = await fetch(PROJECT_URL + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "omit", cache: "no-store",
      });
    } catch (error) {
      throw new Error("Supabase 서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.");
    }
    const text = await response.text();
    let result;
    try {
      result = text ? JSON.parse(text) : null;
    } catch (error) {
      throw new Error("서버 응답을 읽지 못했습니다.");
    }
    if (!response.ok) {
      if (result?.code === "PGRST202" || result?.code === "42P01") {
        throw new Error("Supabase 설정이 필요합니다. 최초 설치: setup.sql → upgrade-codes-history.sql → upgrade-selection-groups.sql 순서로 SQL Editor에서 실행하세요. 기존 설치는 아직 실행하지 않은 업데이트만 실행하세요.");
      }
      throw new Error(result?.message || result?.msg || result?.error_description || "서버 요청에 실패했습니다.");
    }
    return result;
  }

  function rpc(name, args, authenticated = false) {
    return request(`/rest/v1/rpc/${name}`, { body: args, authenticated });
  }

  function setSession(value) {
    if (!value?.access_token || !value?.refresh_token || !value?.user?.email) {
      throw new Error("로그인 정보를 확인하지 못했습니다.");
    }
    session = { ...value, expires_at: value.expires_at || Date.now() / 1000 + value.expires_in };
    byId("cloudTeacherAccount").textContent = `${value.user.email} · 이 탭을 닫으면 로그아웃됩니다.`;
    byId("cloudTeacherLogin").classList.add("hidden");
    byId("cloudTeacherControls").classList.remove("hidden");
  }

  async function teacherAction(action) {
    if (teacherBusy) return;
    teacherBusy = true;
    const buttons = [...byId("supabaseTeacherPanel").querySelectorAll("button")];
    const previous = buttons.map((button) => button.disabled);
    buttons.forEach((button) => { button.disabled = true; });
    byId("cloudRosterInput").disabled = true;
    byId("cloudTeacherMessage").textContent = "처리 중…";
    try {
      await action();
    } catch (error) {
      byId("cloudTeacherMessage").textContent = error.message;
    } finally {
      teacherBusy = false;
      buttons.forEach((button, index) => { button.disabled = previous[index]; });
      byId("cloudRosterInput").disabled = false;
      byId("cloudDownloadCodes").disabled = !latestCodes;
      byId("cloudPrintCodes").disabled = false;
    }
  }

  function button(text, action) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "button";
    element.textContent = text;
    element.addEventListener("click", action);
    return element;
  }

  async function refreshEvents() {
    const events = await request("/rest/v1/course_events?select=id,school_name,school_year,round,is_open,created_at&order=created_at.desc", {
      method: "GET", authenticated: true,
    });
    const list = byId("cloudEventList");
    list.replaceChildren();
    if (!events.length) list.textContent = "생성한 수강신청이 없습니다.";
    for (const event of events) {
      const section = document.createElement("section");
      const title = document.createElement("p");
      title.textContent = `${event.school_year} ${event.school_name} ${event.round}차 · ${event.is_open ? "접수 중" : "마감"} · ${new Date(event.created_at).toLocaleString("ko-KR")}`;
      section.appendChild(title);
      const link = document.createElement("a");
      link.href = eventLink(event.id);
      link.textContent = "이 학교·차수 학생 신청 링크";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      section.appendChild(link);
      section.appendChild(button("신청 로그 · 롤백", () => teacherAction(async () => {
        await showHistory(event, section);
        byId("cloudTeacherMessage").textContent = "이력의 복원 버튼은 해당 기록 시각 직전 상태로 되돌립니다.";
      })));
      section.appendChild(button(event.is_open ? "신청 마감" : "다시 열기", () => teacherAction(async () => {
        const result = await rpc("manage_course_event", { p_event: event.id, p_action: event.is_open ? "close" : "open" }, true);
        await refreshEvents();
        byId("cloudTeacherMessage").textContent = result.message;
      })));
      section.appendChild(button("신청 결과 저장", () => teacherAction(async () => {
        const result = await rpc("manage_course_event", { p_event: event.id, p_action: "export" }, true);
        downloadTextFile(JSON.stringify(result, null, 2), `온라인_수강신청_결과_${event.round}차.json`, "application/json");
        byId("cloudTeacherMessage").textContent = `${result.entries.length}명 결과를 저장했습니다. 같은 차수의 신청 파일 취합하기로 불러오세요.`;
      })));
      section.appendChild(button("전체 학생 코드 재발급", () => teacherAction(async () => {
        if (!window.confirm("모든 학생의 기존 코드가 무효화됩니다. 신청 결과는 유지됩니다. 전체 코드를 재발급할까요?")) {
          byId("cloudTeacherMessage").textContent = "재발급을 취소했습니다.";
          return;
        }
        latestCodes = await rpc("manage_course_event", { p_event: event.id, p_action: "codes" }, true);
        downloadTextFile(JSON.stringify(latestCodes, null, 2), "학생별_신청코드.json", "application/json");
        byId("cloudTeacherMessage").textContent = "전체 코드를 재발급했습니다. 새 코드를 저장하고 각 학생에게 다시 전달하세요. 기존 코드는 사용할 수 없습니다.";
      })));
      section.appendChild(button("명렬·결과 영구 삭제", () => teacherAction(async () => {
        if (!window.confirm(`${event.school_name} ${event.round}차의 모든 명렬과 신청을 영구 삭제할까요? 복구할 수 없습니다.`)) {
          byId("cloudTeacherMessage").textContent = "삭제를 취소했습니다.";
          return;
        }
        const result = await rpc("manage_course_event", { p_event: event.id, p_action: "delete" }, true);
        if (latestCodes?.id === event.id) latestCodes = null;
        await refreshEvents();
        byId("cloudTeacherMessage").textContent = result.message;
      })));
      list.appendChild(section);
    }
  }

  function base64Url(bytes) {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  byId("cloudTeacherGoogleLogin").addEventListener("click", () => {
    teacherAction(async () => {
      const redirect = new URL(window.location.href);
      if (redirect.protocol !== "https:" && redirect.hostname !== "localhost" && redirect.hostname !== "127.0.0.1") {
        throw new Error("구글 로그인은 게시된 HTTPS 웹사이트에서 사용하세요.");
      }
      redirect.search = "";
      redirect.hash = "";
      const settings = await request("/auth/v1/settings", { method: "GET" });
      if (!settings?.external?.google) throw new Error("운영자가 Supabase Authentication에서 Google 로그인을 먼저 활성화해야 합니다.");
      const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      sessionStorage.setItem(PKCE_STORAGE_KEY, JSON.stringify({ verifier, createdAt: Date.now() }));
      const authorize = new URL(`${PROJECT_URL}/auth/v1/authorize`);
      authorize.search = new URLSearchParams({
        provider: "google", redirect_to: redirect.href, code_challenge: challenge,
        code_challenge_method: "s256", prompt: "select_account",
      }).toString();
      window.location.assign(authorize.href);
    });
  });

  async function completeGoogleLogin() {
    const callback = new URL(window.location.href);
    if (callback.hash === "#student" || new URLSearchParams(callback.hash.slice(1)).has("apply") ||
        new URLSearchParams(callback.hash.slice(1)).has("event")) return;
    if (!callback.searchParams.has("code") && !callback.searchParams.has("error")) return;
    const code = callback.searchParams.get("code");
    const error = callback.searchParams.get("error_description") || callback.searchParams.get("error");
    callback.searchParams.delete("code");
    callback.searchParams.delete("error");
    callback.searchParams.delete("error_description");
    callback.searchParams.delete("error_code");
    window.history.replaceState(null, "", callback.href);
    switchWorkflowStep(2);
    await teacherAction(async () => {
      const saved = sessionStorage.getItem(PKCE_STORAGE_KEY);
      sessionStorage.removeItem(PKCE_STORAGE_KEY);
      if (error) throw new Error(`구글 로그인 실패: ${error}`);
      if (!saved) throw new Error("로그인을 시작한 탭에서 다시 시도하세요. 로그인 확인 정보가 없습니다.");
      let pending;
      try {
        pending = JSON.parse(saved);
      } catch (error) {
        throw new Error("로그인 확인 정보가 잘못되었습니다. 다시 로그인하세요.");
      }
      if (!/^[A-Za-z0-9_-]{43}$/.test(pending.verifier) || !Number.isFinite(pending.createdAt) ||
          Date.now() - pending.createdAt > 15 * 60 * 1000 || pending.createdAt > Date.now()) {
        throw new Error("로그인 확인 정보가 만료되었습니다. 다시 로그인하세요.");
      }
      setSession(await request("/auth/v1/token?grant_type=pkce", {
        body: { auth_code: code, code_verifier: pending.verifier },
      }));
      await refreshEvents();
      byId("cloudTeacherMessage").textContent = "구글 계정으로 로그인했습니다.";
    });
  }
  byId("cloudTeacherLogout").addEventListener("click", () => teacherAction(async () => {
    await request("/auth/v1/logout", { authenticated: true });
    session = null;
    latestCodes = null;
    byId("cloudEventList").replaceChildren();
    byId("cloudTeacherControls").classList.add("hidden");
    byId("cloudTeacherLogin").classList.remove("hidden");
    byId("cloudTeacherMessage").textContent = "로그아웃했습니다.";
  }));
  byId("cloudRefreshEvents").addEventListener("click", () => teacherAction(async () => {
    await refreshEvents();
    byId("cloudTeacherMessage").textContent = "수강신청 목록을 새로 불러왔습니다.";
  }));
  byId("cloudRosterInput").addEventListener("change", (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    teacherAction(async () => {
      if (!session) throw new Error("교사 로그인이 필요합니다.");
      if (latestCodes && !window.confirm("이전에 생성한 학생 코드를 저장했나요? 새 신청을 생성하면 이전 코드 다운로드 버튼은 대체됩니다.")) {
        byId("cloudTeacherMessage").textContent = "생성을 취소했습니다. 이전 코드를 먼저 저장하세요.";
        return;
      }
      if (!file.name.toLowerCase().endsWith(".xlsx")) throw new Error("학생 명렬은 .xlsx 형식이어야 합니다.");
      const subjects = getGroupedApplicationSubjects();
      if (!subjects) throw new Error("1단계에서 편제표를 먼저 불러오세요.");
      const setup = {
        type: "course-application-setup",
        schoolName: byId("schoolName").value.trim(), schoolYear: byId("schoolYear").value.trim(),
        round: state.currentRound, subjects,
        groups: getCourseApplicationGroups(),
        roster: parseApplicationRoster(await parseWorkbook(await file.arrayBuffer())),
      };
      for (const student of setup.roster) {
        const targetGrade = String(Number(student.grade) + 1);
        if (!subjects[targetGrade]?.length) {
          throw new Error(`현재 ${student.grade}학년이 신청할 ${targetGrade}학년 학생선택교육과정 과목을 찾지 못했습니다. 1단계 편제표의 교육과정 구분과 ${targetGrade}학년 학기 시수를 확인하세요.`);
        }
      }
      latestCodes = await rpc("create_course_event", { p_setup: setup }, true);
      downloadTextFile(JSON.stringify(latestCodes, null, 2), "학생별_신청코드.json", "application/json");
      byId("cloudTeacherMessage").textContent = `${setup.round}차 신청을 생성했습니다 (${latestCodes.students.length}명). 학생 코드를 반드시 저장하고 개별 전달하세요.`;
      // Keep the successful creation and its codes visible even if refreshing the list fails.
      try {
        await refreshEvents();
      } catch (error) {
        byId("cloudTeacherMessage").textContent += ` 목록 갱신 실패: ${error.message}. 신청은 생성되었으므로 재업로드하지 말고 새로고침을 누르세요.`;
      }
    });
  });
  byId("cloudDownloadCodes").addEventListener("click", () => {
    if (latestCodes) downloadTextFile(JSON.stringify(latestCodes, null, 2), "학생별_신청코드.json", "application/json");
  });

  const studentLink = new URL(window.location.href);
  studentLink.search = "";
  studentLink.hash = "student";
  byId("cloudStudentLink").href = studentLink.href;

  async function studentAction(action) {
    if (studentBusy) return;
    studentBusy = true;
    byId("supabaseStudentEntry").querySelectorAll("button").forEach((b) => { b.disabled = true; });
    byId("cloudStudentMessage").textContent = "처리 중…";
    try {
      await action();
    } catch (error) {
      byId("cloudStudentMessage").textContent = error.message;
    } finally {
      studentBusy = false;
      byId("supabaseStudentEntry").querySelectorAll("button").forEach((b) => { b.disabled = false; });
      byId("cloudStudentSave").disabled = !application?.open;
    }
  }

  function renderStudentApplication(data) {
    byId("cloudStudentCourses").classList.remove("hidden");
    byId("cloudStudentTitle").textContent = `${data.schoolYear}학년도 ${data.schoolName} ${data.round}차 수강신청`;
    const s = data.student;
    byId("cloudStudentIdentity").textContent = `${s.grade}학년 ${s.classroom}반 ${s.number}번 ${s.name} · 신청 대상: ${Number(s.grade) + 1}학년`;
    const choices = byId("cloudStudentChoices");
    choices.replaceChildren();
    if (data.groups?.length) {
      for (const group of data.groups) {
        const fieldset = document.createElement("fieldset");
        fieldset.dataset.group = group.id;
        fieldset.dataset.count = group.count;
        const legend = document.createElement("legend");
        const semester = group.semester ? (group.semester==="0"?"학기 미정":`${group.semester}학기`) : "";
        legend.textContent = `${semester ? semester+" · " : ""}${group.name} · 정확히 ${group.count}과목 선택`;
        fieldset.appendChild(legend);
        for (const subject of group.courses) {
          const course = data.courses.find((c) => c.subject === subject);
          if (!course) throw new Error("그룹 과목 설정이 잘못되었습니다.");
          const label = document.createElement("label"); label.className = "application-subject";
          const box = document.createElement("input"); box.type = "checkbox"; box.value = subject;
          box.dataset.credit = course.credit; box.checked = data.selections.includes(subject); box.disabled = !data.open;
          label.append(box, document.createTextNode(`${applicationCourseLabel(course)} · ${course.credit}학점`)); fieldset.appendChild(label);
        }
        choices.appendChild(fieldset);
      }
    } else {
    const semesters = new Map();
    for (const course of data.courses) {
      const semester = course.semester || "학기 미정";
      if (!semesters.has(semester)) {
        const group = document.createElement("fieldset");
        const legend = document.createElement("legend");
        legend.textContent = semester === "학기 미정" ? semester : `${semester}학기`;
        group.appendChild(legend);
        choices.appendChild(group);
        semesters.set(semester, group);
      }
      const label = document.createElement("label");
      label.className = "application-subject";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = course.subject;
      box.dataset.credit = course.credit;
      box.checked = data.selections.includes(course.subject);
      box.disabled = !data.open;
      label.append(box, document.createTextNode(`${applicationCourseLabel(course)} · ${course.credit}학점`));
      semesters.get(semester).appendChild(label);
    }
    }
    updateSummary();
    byId("cloudStudentMessage").textContent = !data.open ? "접수가 마감되었습니다. 기존 신청만 확인할 수 있습니다."
      : data.submittedAt ? "기존 신청을 불러왔습니다. 수정 후 저장할 수 있습니다." : "과목을 선택하고 신청 저장을 누르세요.";
  }
  function updateSummary() {
    const selected = [...byId("cloudStudentChoices").querySelectorAll("input:checked")];
    byId("cloudStudentSummary").textContent = `선택 ${selected.length}개 · ${selected.reduce((total, b) => total + Number(b.dataset.credit), 0)}학점`;
    for (const fieldset of byId("cloudStudentChoices").querySelectorAll("fieldset[data-group]")) {
      const count = fieldset.querySelectorAll("input:checked").length;
      const group = application.groups.find((g) => g.id === fieldset.dataset.group);
      fieldset.querySelector("legend").textContent = `${group.name} · ${count}/${group.count}과목 선택`;
    }
  }
  byId("cloudStudentChoices").addEventListener("change", updateSummary);
  byId("cloudStudentCode").addEventListener("input", () => {
    activeCode = "";
    application = null;
    byId("cloudStudentChoices").replaceChildren();
    byId("cloudStudentCourses").classList.add("hidden");
  });
  byId("cloudStudentLogin").addEventListener("submit", (event) => {
    event.preventDefault();
    studentAction(async () => {
      activeCode = "";
      application = null;
      byId("cloudStudentChoices").replaceChildren();
      byId("cloudStudentCourses").classList.add("hidden");
      const code = byId("cloudStudentCode").value.trim().toLowerCase();
      if (eventId && !validEvent.test(eventId)) throw new Error("학교 신청 링크가 잘못되었습니다.");
      if (eventId ? !/^(\d{6}|[a-f0-9]{32})$/.test(code) : !/^[a-f0-9]{32}$/.test(code)) {
        throw new Error(eventId ? "학교에서 받은 6자리 숫자 코드를 확인하세요." : "6자리 코드는 학교·차수별 신청 링크에서 입력하세요. 기존 긴 코드는 이 입구에서도 사용할 수 있습니다.");
      }
      const data = eventId
        ? await rpc("get_scoped_course_application", { p_event: eventId, p_code: code })
        : await rpc("get_course_application", { p_code: code });
      if (byId("cloudStudentCode").value.trim().toLowerCase() !== code) {
        throw new Error("코드가 변경되었습니다. 다시 본인 확인을 해주세요.");
      }
      application = data;
      activeCode = code;
      renderStudentApplication(data);
    });
  });
  byId("cloudStudentApplication").addEventListener("submit", (event) => {
    event.preventDefault();
    studentAction(async () => {
      if (!activeCode || !application?.open) throw new Error("본인 확인 및 접수 상태를 확인하세요.");
      const code = activeCode;
      const selected = [...byId("cloudStudentChoices").querySelectorAll("input:checked")].map((box) => box.value);
      if (!selected.length) throw new Error("과목을 1개 이상 선택하세요.");
      for (const group of application.groups || []) {
        const count = selected.filter((name) => group.courses.includes(name)).length;
        if (count !== group.count) throw new Error(`${group.name}: 정확히 ${group.count}과목을 선택하세요 (현재 ${count}개).`);
      }
      const result = eventId
        ? await rpc("save_scoped_course_application", { p_event: eventId, p_code: code, p_selections: selected })
        : await rpc("save_course_application", { p_code: code, p_selections: selected });
      if (activeCode === code) byId("cloudStudentMessage").textContent = result.message;
    });
  });
    async function showHistory(event, parent) {
      const data = await rpc("course_event_history", { p_event: event.id }, true);
      const old = parent.querySelector(".course-history");
      if (old) old.remove();
      const panel = document.createElement("section");
      panel.className = "course-history";
      const heading = document.createElement("p");
      heading.textContent = `신청 이력 ${data.entries.length}건 · 기록 시작 ${new Date(data.startedAt).toLocaleString("ko-KR")}`;
      panel.appendChild(heading);
      const time = document.createElement("input");
      time.type = "datetime-local";
      time.step = "1";
      time.setAttribute("aria-label", "전체 롤백 기준 시각");
      panel.appendChild(time);
      async function restore(before, student = null) {
        if (!before || Number.isNaN(new Date(before).getTime())) throw new Error("복원할 시각을 선택하세요.");
        if (!window.confirm(`${student ? "해당 학생" : "전체 학생"}을 ${new Date(before).toLocaleString("ko-KR")} 직전 상태로 복원할까요? 코드와 접수 마감 상태는 변경하지 않습니다.`)) {
          byId("cloudTeacherMessage").textContent = "롤백을 취소했습니다.";
          return;
        }
        const result = await rpc("rollback_course_event", { p_event: event.id, p_before: before, p_student: student }, true);
        await showHistory(event, parent);
        byId("cloudTeacherMessage").textContent = result.message;
      }
      panel.appendChild(button("입력 시각 직전으로 전체 롤백", () => teacherAction(() =>
        restore(time.value ? new Date(time.value).toISOString() : ""))));
      const studentSelect = document.createElement("select");
      studentSelect.setAttribute("aria-label", "개별 롤백 학생");
      const students = new Map(data.entries.map((entry) => [entry.studentId, entry]));
      for (const [id, s] of students) {
        const option = document.createElement("option"); option.value = id;
        option.textContent = `${s.grade}학년 ${s.classroom}반 ${s.number}번 ${s.name}`;
        studentSelect.appendChild(option);
      }
      panel.appendChild(studentSelect);
      panel.appendChild(button("입력 시각 직전으로 학생 롤백", () => teacherAction(async () => {
        if (!studentSelect.value) throw new Error("복원할 학생을 선택하세요.");
        await restore(time.value ? new Date(time.value).toISOString() : "", studentSelect.value);
      })));
      panel.appendChild(button("로그 JSON 저장", () =>
        downloadTextFile(JSON.stringify(data, null, 2), "수강신청_로그.json", "application/json")));
      for (const entry of data.entries) {
        const row = document.createElement("p");
        row.textContent = `${new Date(entry.at).toLocaleString("ko-KR")} · ${entry.grade}학년 ${entry.classroom}반 ${entry.number}번 ${entry.name} · ${entry.action} · ${entry.submittedAt ? entry.selections.join(", ") : "미신청"}` +
          (entry.rollbackBefore ? ` · 복원 기준 ${new Date(entry.rollbackBefore).toLocaleString("ko-KR")}` : "");
        row.appendChild(button("이 시각 직전 · 학생 롤백", () => teacherAction(() => restore(entry.at, entry.studentId))));
        row.appendChild(button("이 시각 직전 · 전체 롤백", () => teacherAction(() => restore(entry.at))));
        panel.appendChild(row);
      }
      parent.appendChild(panel);
    }

    function filteredPrintStudents() {
      const classroom = byId("cloudPrintClass").value;
      return printingCodes.students.filter((s) => !classroom || `${s.grade}:${s.classroom}` === classroom);
    }
    function codeMarkup(students) {
      const link = eventLink(printingCodes.id);
      return students.map((s) => `<section class="print-page"><h2>수강신청 안내</h2>
        <p>${escapeHtml(s.grade)}학년 ${escapeHtml(s.classroom)}반 ${escapeHtml(s.number)}번 <strong>${escapeHtml(s.name)}</strong></p>
        <p>아래 학교·차수 신청 주소로 접속하여 본인 코드를 입력하세요.</p>
        <p style="overflow-wrap:anywhere">${escapeHtml(link)}</p>
        <p style="font-size:28px">개인 신청 코드: <strong>${escapeHtml(s.code)}</strong></p>
        <p>학교·차수와 본인 정보를 확인한 뒤 과목을 선택하고 신청 저장을 누르세요.</p>
        <p>이 코드는 본인만 사용하세요. 재접속하여 신청 내용을 수정할 수 있습니다.</p></section>`).join("");
    }
    function previewCodes() {
      byId("cloudCodePreview").innerHTML = codeMarkup(filteredPrintStudents());
    }
    function openCodes(data) {
      if (!validEvent.test(data?.id) || !Array.isArray(data.students) || !data.students.length ||
          data.students.some((s) => !/^(?:\d{6}|[a-f0-9]{32})$/.test(s.code) ||
            !/^[12]$/.test(String(s.grade)) || !s.classroom || !s.number || typeof s.name !== "string")) {
        throw new Error("학생별 신청 코드 JSON 형식을 확인하세요. 이전 Apps Script 코드 파일은 지원하지 않습니다.");
      }
      printingCodes = data;
      const filter = byId("cloudPrintClass");
      filter.replaceChildren();
      const all = document.createElement("option"); all.value = ""; all.textContent = "전체";
      filter.appendChild(all);
      const groups = [...new Set(data.students.map((s) => `${s.grade}:${s.classroom}`))].sort((a,b) =>
        Number(a.split(":")[0])-Number(b.split(":")[0]) || Number(a.split(":")[1])-Number(b.split(":")[1]));
      for (const group of groups) {
        const option = document.createElement("option"); option.value = group;
        option.textContent = group.replace(":", "학년 ") + "반"; filter.appendChild(option);
      }
      filter.value = "";
      previewCodes();
      byId("cloudCodeDialog").showModal();
    }
    byId("cloudPrintCodes").addEventListener("click", () => teacherAction(async () => {
      if (!latestCodes) {
        byId("cloudTeacherMessage").textContent = "이전 로그인에서 저장한 학생별 코드 JSON을 선택하세요. 재발급 없이 기존 코드로 출력합니다.";
        byId("cloudCodeFile").click();
        return;
      }
      openCodes(latestCodes);
      byId("cloudTeacherMessage").textContent = "메일머지 출력창을 열었습니다.";
    }));
    byId("cloudCodeFile").addEventListener("change", (event) => {
      const file = event.target.files[0]; event.target.value = "";
      if (file) teacherAction(async () => {
        const data = JSON.parse(await file.text());
        openCodes(data);
        latestCodes = data;
        byId("cloudTeacherMessage").textContent = "저장한 코드 파일의 출력창을 열었습니다.";
      });
    });
    byId("cloudPrintClass").addEventListener("change", previewCodes);
    byId("cloudCodeClose").addEventListener("click", () => byId("cloudCodeDialog").close());
    byId("cloudCodePrint").addEventListener("click", () => {
      byId("printBatch").innerHTML = codeMarkup(filteredPrintStudents());
      // Keep the preview open so another print can rebuild the batch after afterprint clears it.
      window.print();
    });
  completeGoogleLogin().catch((error) => {
    byId("cloudTeacherMessage").textContent = `로그인 처리 실패: ${error.message}`;
  });
})();
