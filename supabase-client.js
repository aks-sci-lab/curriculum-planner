"use strict";
var requireTeacherLogin;
var isDeveloperAccount;
var unlinkApplicationRound;
var updateApplicationGradeControls;

(() => {
  const PROJECT_URL = "https://hapfkdkbhnqpfjdepozv.supabase.co";
  const PUBLIC_KEY = "sb_publishable_HCUWUrxTxaDVtwv4KvPj4A_4RKnLD-p";
  const byId = (id) => document.getElementById(id);
  let session = null;
  let sessionRevision = 0;
  const SESSION_KEY = "curriculum-teacher-session-v1";
  const IDLE_MS = 5 * 60 * 1000;
  let lastActivity = 0;
  let idleTimer = null;
  let pendingRoster = null;
  const gradeDrafts = new Map();
  let controlsGrade = state.applicationMenuGrade || "1";
  isDeveloperAccount = () => !!session && session.user.email.toLowerCase() === "lany0665@gmail.com" && Date.now() - lastActivity < IDLE_MS;
  requireTeacherLogin = () => {
    if (session && Date.now() - lastActivity < IDLE_MS) return true;
    byId("cloudTeacherMessage").textContent = "편제표 업로드 전에 구글 로그인을 해주세요.";
    updateAccountControls();
    byId("teacherLoginMessage").textContent = "오른쪽 위의 구글 로그인 후 이용하세요.";
    byId("curriculumGoogleLogin").focus();
    return false;
  };
  function saveSession() {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ session, lastActivity }));
  }
  function updateAccountControls() {
    const studentRoute = !!eventId || new URL(window.location.href).hash === "#student" || new URL(window.location.href).hash.startsWith("#apply=");
    const loggedIn = !!session && Date.now() - lastActivity < IDLE_MS && !studentRoute;
    byId("teacherHeader").classList[studentRoute ? "add" : "remove"]("hidden");
    byId("teacherWorkspace").classList[loggedIn ? "remove" : "add"]("hidden");
    byId("teacherLoginGate").classList[loggedIn || studentRoute ? "add" : "remove"]("hidden");
    byId("headerTeacherLogout").classList[loggedIn ? "remove" : "add"]("hidden");
    byId("curriculumGoogleLogin").classList[loggedIn ? "add" : "remove"]("hidden");
    byId("developerResultUpload").classList[isDeveloperAccount() ? "remove" : "add"]("hidden");
    byId("curriculumGoogleLogin").disabled = !!session;
    byId("curriculumLoginStatus").textContent = session ? `${session.user.email} · 로그인 중` : "편제표 업로드 전에 로그인하세요.";
  }
  function clearTeacherSession(message) {
    sessionRevision++;
    session = null;
    localStorage.removeItem(SESSION_KEY);
    latestCodes = null;
    printingCodes = null;
    byId("cloudCodeDialog").close();
    byId("cloudStudentPreviewDialog").close();
    closeStudentPreview();
    byId("cloudCodePreview").replaceChildren();
    byId("printBatch").replaceChildren();
    pendingRoster = null;
    gradeDrafts.clear();
    if (syncTimer !== null) window.clearInterval(syncTimer);
    if (idleTimer !== null) window.clearInterval(idleTimer);
    idleTimer = syncTimer = null;
    stopRealtimeSubscription();
    linkedEvents.clear();
    syncRevision++;
    knownEvents = [];
    eventsLoaded = false;
    syncSnapshots.clear();
    updateAccountControls();
    setApplicationTargetGrades([String(Number(state.applicationMenuGrade || "1") + 1)]);
    byId("cloudRosterSummary").textContent = `현재 ${state.applicationMenuGrade || "1"}학년 명렬을 업로드하세요.`;
    byId("cloudEventList").replaceChildren();
    byId("cloudTeacherControls").classList.add("hidden");
    byId("cloudTeacherLogin").classList.remove("hidden");
    byId("cloudTeacherMessage").textContent = message;
    byId("teacherLoginMessage").textContent = message;
    byId("cloudSyncStatus").textContent = "로그인하면 집계표 자동 연동을 재개합니다.";
  }
  function expireIfIdle() {
    if (!session || Date.now() - lastActivity < IDLE_MS) return false;
    const token = session.access_token;
    clearTeacherSession("5분간 활동이 없어 자동 로그아웃했습니다.");
    fetch(PROJECT_URL + "/auth/v1/logout", {
      method:"POST", headers:{apikey:PUBLIC_KEY, Authorization:`Bearer ${token}`}, credentials:"omit"
    }).then((response) => {
      if (!response.ok) throw new Error("서버 로그아웃 요청이 실패했습니다.");
    }).catch((error) => { byId("cloudTeacherMessage").textContent += ` 서버 세션 해제 실패: ${error.message}`; });
    return true;
  }
  for (const name of ["pointerdown", "keydown", "scroll", "touchstart"]) {
    window.addEventListener(name, (event) => {
      if (!event.isTrusted || !session || expireIfIdle()) return;
      if (Date.now() - lastActivity < 1000) return;
      lastActivity = Date.now();
      saveSession();
    }, { passive: true, capture: true });
  }
  window.addEventListener("storage", (event) => {
    if (event.key !== SESSION_KEY || !session) return;
    if (!event.newValue) { clearTeacherSession("다른 탭에서 로그아웃했습니다."); return; }
    try {
      const saved = JSON.parse(event.newValue);
      if (saved.session?.user?.email !== session.user.email) {
        clearTeacherSession("다른 계정으로 로그인되어 이 탭은 로그아웃했습니다.");
      } else if (Number.isFinite(saved.lastActivity) && saved.lastActivity <= Date.now()) {
        if (!saved.session?.access_token || !saved.session?.refresh_token) throw new Error("저장된 로그인 정보가 잘못되었습니다.");
        session = saved.session;
        lastActivity = saved.lastActivity;
      }
    } catch (error) { clearTeacherSession(`로그인 상태 읽기 실패: ${error.message}`); }
  });
  const PKCE_STORAGE_KEY = "curriculum-google-pkce";
  let latestCodes = null;
  let activeCode = "";
  let application = null;
  let previewMode = false;
  let studentSemesters = [];
  let studentSemesterIndex = 0;
  let teacherBusy = false;
  let studentBusy = false;
  let printingCodes = null;
  let linkedEvents = new Set();
  let knownEvents = [];
  let eventsLoaded = false;
  let syncTimer = null;
  let syncTask = null;
  let syncRevision = 0;
  let realtimeSocket = null;
  let realtimeHeartbeatTimer = null;
  let realtimeReconnectTimer = null;
  let realtimeReconnectAttempt = 0;
  let realtimeRef = 0;
  let realtimeHeartbeatRef = null;
  let realtimeConnected = false;
  let realtimeSessionToken = "";
  const syncSnapshots = new Map();
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
    if (authenticated && (expireIfIdle() || !session)) throw new Error("교사 로그인이 필요합니다.");
    const revision = sessionRevision;
    if (authenticated && session.expires_at <= Date.now() / 1000 + 30) {
      const refreshed = await request("/auth/v1/token?grant_type=refresh_token", {
        body: { refresh_token: session.refresh_token },
      });
      if (expireIfIdle() || !session || revision !== sessionRevision) throw new Error("로그인이 만료되었습니다. 다시 로그인하세요.");
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
      throw new Error("신청 서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.");
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
        throw new Error("신청 서버 설정이 필요합니다. 운영자에게 문의하세요.");
      }
      throw new Error(result?.message || result?.msg || result?.error_description || "서버 요청에 실패했습니다.");
    }
    if (authenticated && (expireIfIdle() || !session || revision !== sessionRevision)) {
      throw new Error("로그인이 만료되었습니다. 다시 로그인하세요.");
    }
    return result;
  }

  function rpc(name, args, authenticated = false) {
    return request(`/rest/v1/rpc/${name}`, { body: args, authenticated });
  }

  function downloadDataWorkbook(data, kind, filename) {
    let rows;
    if (kind === "codes") rows = [
      ["신청ID", "현재학년", "반", "번호", "이름", "신청코드", "학생링크"],
      ...data.students.map((student) => [data.id, student.grade, student.classroom, student.number, student.name, student.code, eventLink(data.id)])
    ];
    else if (kind === "results") rows = [
      ["차수", "학년", "반", "번호", "성명", "선택과목"],
      ...data.entries.map((entry) => [data.round, entry.grade, entry.classroom, entry.number, entry.name, entry.selections.join(", ")])
    ];
    else rows = [
      ["기록시각", "현재학년", "반", "번호", "성명", "작업", "선택과목", "제출시각", "학생ID", "롤백기준"],
      ...data.entries.map((entry) => [entry.at, entry.grade, entry.classroom, entry.number, entry.name, entry.action, entry.selections.join(", "), entry.submittedAt || "", entry.studentId, entry.rollbackBefore || ""])
    ];
    downloadRowsXlsx(rows, filename);
  }

  function setSession(value, activity = lastActivity || Date.now()) {
    if (!value?.access_token || !value?.refresh_token || !value?.user?.email) {
      throw new Error("로그인 정보를 확인하지 못했습니다.");
    }
    if (!session || session.user.email !== value.user.email) sessionRevision++;
    session = { ...value, expires_at: value.expires_at || Date.now() / 1000 + value.expires_in };
    lastActivity = activity;
    saveSession();
    updateAccountControls();
    if (idleTimer === null) idleTimer = window.setInterval(expireIfIdle, 1000);
    byId("cloudTeacherAccount").textContent = `${value.user.email} · 새로고침 후 유지 · 5분 무활동 시 로그아웃`;
    byId("cloudTeacherLogin").classList.add("hidden");
    byId("cloudTeacherControls").classList.remove("hidden");
    const saved = localStorage.getItem(`curriculum-cloud-links:${value.user.id || value.user.email}`);
    const ids = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(ids) || ids.some((id) => !validEvent.test(id))) throw new Error("저장된 집계표 연동 설정 형식이 잘못되었습니다.");
    linkedEvents = new Set(ids);
    startRealtimeSubscription();
    if (syncTimer === null) syncTimer = window.setInterval(() => {
      if (!teacherBusy && session && linkedEvents.size && !realtimeConnected) {
        syncLinkedResults().catch((error) => { byId("cloudSyncStatus").textContent = `자동 연동 실패: ${error.message}`; });
      }
    }, 30000);
  }

  function saveLinkedEvents() {
    syncRevision++;
    localStorage.setItem(`curriculum-cloud-links:${session.user.id || session.user.email}`, JSON.stringify([...linkedEvents]));
    startRealtimeSubscription();
  }
  unlinkApplicationRound = (round) => {
    if (!session || expireIfIdle()) throw new Error("교사 로그인이 필요합니다.");
    if (linkedEvents.size && !eventsLoaded) throw new Error("자동 연동 신청 목록을 읽는 중입니다. 목록 새로고침 후 다시 삭제하세요.");
    const previous = new Set(linkedEvents);
    for (const event of knownEvents) if (String(event.round) === String(round)) linkedEvents.delete(event.id);
    try { saveLinkedEvents(); }
    catch (error) { linkedEvents = previous; throw error; }
    syncSnapshots.delete(String(round));
    byId("cloudSyncStatus").textContent = `${round}차 자동 연동을 해제했습니다. 서버 신청은 유지됩니다.`;
  };

  function openStudentPreview(event = null) {
    const currentGrade = state.applicationMenuGrade || "1";
    const grade = String(Number(currentGrade) + 1);
    const subjects = event?.subjects || getGroupedApplicationSubjects();
    const courses = subjects?.[grade];
    if (!courses?.length) throw new Error(`${grade}학년 신청 과목이 없습니다. 편제표를 확인하세요.`);
    const groups = (event ? event.groups : getCourseApplicationGroups([grade]))?.filter((group) => group.grade === grade) || [];
    application = {
      student: {grade:currentGrade,classroom:"1",number:"1",name:"미리보기 학생"},
      schoolName:event?.school_name || byId("schoolName").value,
      schoolYear:event?.school_year || byId("schoolYear").value,
      round:event?.round || state.currentRound,open:true,courses,groups,selections:[],submittedAt:null
    };
    previewMode = true;
    activeCode = "preview";
    const panel = byId("supabaseStudentEntry");
    byId("cloudStudentPreviewContent").appendChild(panel);
    panel.classList.remove("hidden");
    byId("cloudStudentLogin").classList.add("hidden");
    renderStudentApplication(application);
    byId("cloudStudentPreviewDialog").showModal();
  }
  function closeStudentPreview() {
    if (!previewMode) return;
    previewMode = false;
    application = null;
    activeCode = "";
    const panel = byId("supabaseStudentEntry");
    byId("cloudStudentChoices").replaceChildren();
    panel.classList.add("hidden");
    byId("cloudStudentLogin").classList.remove("hidden");
    document.body.appendChild(panel);
  }
  byId("cloudPreviewStudent").addEventListener("click", () => teacherAction(async () => openStudentPreview()));
  byId("cloudStudentPreviewClose").addEventListener("click", () => byId("cloudStudentPreviewDialog").close());
  byId("cloudStudentPreviewDialog").addEventListener("close", closeStudentPreview);

  function syncLinkedResults() {
    if (syncTask) return syncTask.then(() => syncLinkedResults());
    syncTask = updateLinkedResults().finally(() => { syncTask = null; });
    return syncTask;
  }

  function stopRealtimeSubscription() {
    realtimeConnected = false;
    realtimeSessionToken = "";
    realtimeReconnectAttempt = 0;
    realtimeHeartbeatRef = null;
    if (realtimeHeartbeatTimer !== null) window.clearInterval(realtimeHeartbeatTimer);
    if (realtimeReconnectTimer !== null) window.clearTimeout(realtimeReconnectTimer);
    realtimeHeartbeatTimer = realtimeReconnectTimer = null;
    const socket = realtimeSocket;
    realtimeSocket = null;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.onopen = null;
      socket.close();
    }
  }

  function scheduleRealtimeReconnect() {
    if (realtimeReconnectTimer !== null || !session || !linkedEvents.size) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(realtimeReconnectAttempt++, 5));
    realtimeReconnectTimer = window.setTimeout(() => {
      realtimeReconnectTimer = null;
      startRealtimeSubscription();
    }, delay);
  }

  function startRealtimeSubscription() {
    if (!session || !linkedEvents.size) {
      stopRealtimeSubscription();
      return;
    }
    if (!session.user.id || typeof WebSocket === "undefined") return;
    if (realtimeSocket && realtimeSessionToken === session.access_token) return;
    if (realtimeSessionToken && realtimeSessionToken !== session.access_token) stopRealtimeSubscription();
    const ownerId = session.user.id;
    const accessToken = session.access_token;
    const topic = "realtime:public:course_events";
    const url = PROJECT_URL.replace(/^http/, "ws") +
      `/realtime/v1/websocket?apikey=${encodeURIComponent(PUBLIC_KEY)}&vsn=1.0.0`;
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      scheduleRealtimeReconnect();
      return;
    }
    realtimeSocket = socket;
    realtimeSessionToken = accessToken;
    socket.onopen = () => {
      if (realtimeSocket !== socket || !session || session.access_token !== accessToken) {
        socket.close();
        return;
      }
      const ref = String(++realtimeRef);
      socket.joinRef = ref;
      socket.send(JSON.stringify([ref, ref, topic, "phx_join", {
        config: {
          broadcast: { ack: false, self: false },
          presence: { key: "", enabled: false },
          postgres_changes: [{
            event: "UPDATE", schema: "public", table: "course_events",
            filter: `owner_id=eq.${ownerId}`
          }],
          private: false
        },
        access_token: accessToken
      }]));
    };
    socket.onmessage = (message) => {
      let decoded;
      try {
        decoded = JSON.parse(message.data);
      } catch (error) {
        byId("cloudSyncStatus").textContent = "실시간 연동 서버 응답을 읽지 못했습니다.";
        socket.close();
        return;
      }
      if (!Array.isArray(decoded) || decoded.length < 5) {
        byId("cloudSyncStatus").textContent = "실시간 연동 서버 응답 형식이 올바르지 않습니다.";
        socket.close();
        return;
      }
      const [joinRef, ref, messageTopic, event, payload] = decoded;
      if (messageTopic === "phoenix" && event === "phx_reply" && ref === realtimeHeartbeatRef) {
        realtimeHeartbeatRef = null;
        return;
      }
      if (messageTopic !== topic) return;
      if (event === "phx_reply" && ref === socket.joinRef) {
        if (payload?.status !== "ok") {
          byId("cloudSyncStatus").textContent = "실시간 연동 구독에 실패해 자동 재연결을 시도합니다.";
          socket.close();
          return;
        }
        realtimeConnected = true;
        realtimeReconnectAttempt = 0;
        realtimeHeartbeatTimer = window.setInterval(() => {
          if (realtimeSocket !== socket || socket.readyState !== WebSocket.OPEN) return;
          if (realtimeHeartbeatRef) {
            socket.close();
            return;
          }
          const heartbeatRef = String(++realtimeRef);
          realtimeHeartbeatRef = heartbeatRef;
          socket.send(JSON.stringify([null, heartbeatRef, "phoenix", "heartbeat", {}]));
        }, 25000);
        byId("cloudSyncStatus").textContent = "실시간 연동 연결됨 · 신청 변경을 기다리는 중";
        syncLinkedResults().catch((error) => {
          byId("cloudSyncStatus").textContent = `자동 연동 실패: ${error.message}`;
        });
      } else if (event === "postgres_changes") {
        const changedEventId = payload?.data?.record?.id || payload?.data?.new?.id;
        if (!changedEventId || linkedEvents.has(changedEventId)) {
          syncLinkedResults().catch((error) => {
            byId("cloudSyncStatus").textContent = `자동 연동 실패: ${error.message}`;
          });
        }
      } else if (event === "phx_error" || event === "phx_close") {
        realtimeConnected = false;
        socket.close();
      }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (realtimeSocket !== socket) return;
      realtimeSocket = null;
      realtimeConnected = false;
      realtimeHeartbeatRef = null;
      if (realtimeHeartbeatTimer !== null) window.clearInterval(realtimeHeartbeatTimer);
      realtimeHeartbeatTimer = null;
      if (session && linkedEvents.size) {
        byId("cloudSyncStatus").textContent = "실시간 연동이 끊겨 자동 재연결 중입니다.";
        scheduleRealtimeReconnect();
      }
    };
  }

  async function updateLinkedResults() {
    if (!session) return;
    const owner = session.user.id || session.user.email;
    const revision = syncRevision;
    const linked = knownEvents.filter((event) => linkedEvents.has(event.id));
    const rounds = [...new Set(linked.map((event) => String(event.round)))];
    for (const round of rounds) {
      const events = linked.filter((event) => String(event.round) === round);
      if (events.some((event) => event.school_name !== events[0].school_name || event.school_year !== events[0].school_year)) {
        throw new Error(`${round}차에 다른 학교·학년도의 신청이 연동되어 있습니다. 연동을 해제하세요.`);
      }
      const subjects = { "1": [], "2": [], "3": [] };
      const entries = [];
      const identities = new Set();
      for (const event of events) {
        const result = await rpc("manage_course_event", { p_event: event.id, p_action: "export" }, true);
        for (const grade of ["2", "3"]) {
          for (const course of event.subjects[grade] || []) {
            const existing = subjects[grade].find((item) => item.subject === course.subject);
            if (existing && JSON.stringify(existing) !== JSON.stringify(course)) throw new Error(`${round}차 ${course.subject}: 연동 신청의 편제표가 다릅니다.`);
            if (!existing) subjects[grade].push(course);
          }
        }
        for (const entry of result.entries) {
          const identity = `${entry.grade}:${entry.classroom}:${entry.number}`;
          if (identities.has(identity)) throw new Error(`${round}차 ${identity}: 여러 신청에 동일 학생이 있습니다. 중복 신청의 연동을 해제하세요.`);
          identities.add(identity);
          entries.push(entry);
        }
      }
      if (!session || (session.user.id || session.user.email) !== owner || revision !== syncRevision) return;
      const snapshot = JSON.stringify({ entries, subjects });
      if (syncSnapshots.get(round) !== snapshot) {
        applyCloudApplicationResults(round, entries, subjects);
        syncSnapshots.set(round, snapshot);
      }
    }
    byId("cloudSyncStatus").textContent = linked.length
      ? `집계표 자동 연동 ${linked.length}개 신청 · 최근 갱신 ${new Date().toLocaleTimeString("ko-KR")} · ${realtimeConnected ? "실시간" : "연결 전 30초 간격"}`
      : "집계표 연동 신청 없음";
  }

  async function linkEvent(event) {
    const sameRound = knownEvents.filter((item) => linkedEvents.has(item.id) && String(item.round) === String(event.round));
    if (sameRound.some((item) => item.school_name !== event.school_name || item.school_year !== event.school_year)) {
      throw new Error("같은 차수에는 같은 학교·학년도의 신청만 연동할 수 있습니다. 기존 연동을 먼저 해제하세요.");
    }
    if (!sameRound.length && state.rounds?.[event.round]?.students?.length &&
      !window.confirm(`${event.round}차의 기존 로컬 명단을 온라인 신청 결과로 대체할까요?`)) return;
    linkedEvents.add(event.id);
    saveLinkedEvents();
    syncSnapshots.delete(String(event.round));
    await syncLinkedResults();
  }

  async function teacherAction(action) {
    if (teacherBusy) return;
    teacherBusy = true;
    const buttons = [...byId("supabaseTeacherPanel").querySelectorAll("button"),
      byId("applicationGrade1Tab"), byId("applicationGrade2Tab")];
    const previous = buttons.map((button) => button.disabled);
    buttons.forEach((button) => { button.disabled = true; });
    byId("cloudRosterInput").disabled = true;
    byId("cloudTeacherMessage").textContent = "처리 중…";
    byId("teacherLoginMessage").textContent = "로그인 처리 중…";
    try {
      await action();
    } catch (error) {
      byId("cloudTeacherMessage").textContent = error.message;
      byId("teacherLoginMessage").textContent = error.message;
    } finally {
      teacherBusy = false;
      buttons.forEach((button, index) => { button.disabled = previous[index]; });
      byId("cloudRosterInput").disabled = false;
      byId("cloudDownloadCodes").disabled = !latestCodes;
      byId("cloudPrintCodes").disabled = false;
      byId("cloudCreateEvent").disabled = !pendingRoster || !session;
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
    const events = await request("/rest/v1/course_events?select=id,school_name,school_year,round,is_open,created_at,subjects,groups:selection_groups&order=created_at.desc", {
      method: "GET", authenticated: true,
    });
    knownEvents = events;
    eventsLoaded = true;
    renderGradeEvents();
    await syncLinkedResults();
  }

  function renderGradeEvents() {
    const grade = String(Number(state.applicationMenuGrade || "1") + 1);
    const events = knownEvents.filter((event) => event.subjects?.[grade]?.length);
    const list = byId("cloudEventList");
    list.replaceChildren();
    if (!events.length) list.textContent = `현재 ${Number(grade) - 1}학년의 수강신청이 없습니다.`;
    for (const event of events) {
      const section = document.createElement("section");
      const title = document.createElement("p");
      const mixed = event.subjects["2"]?.length && event.subjects["3"]?.length;
      title.textContent = `${event.school_year} ${event.school_name} ${event.round}차 · ${mixed ? "1·2학년 통합 신청 (관리 작업은 두 학년에 적용)" : `현재 ${Number(grade) - 1}학년 → ${grade}학년 신청`} · ${event.is_open ? "접수 중" : "마감"} · ${new Date(event.created_at).toLocaleString("ko-KR")}`;
      section.appendChild(title);
      const link = document.createElement("a");
      link.href = eventLink(event.id);
      link.textContent = "이 학교·차수 학생 신청 링크";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      section.appendChild(link);
      section.appendChild(button("학생 화면 미리보기", () => teacherAction(async () => {
        openStudentPreview(event);
      })));
      section.appendChild(button(linkedEvents.has(event.id) ? "집계표 연동 해제" : "집계표 연동", () => teacherAction(async () => {
        if (linkedEvents.has(event.id)) {
          linkedEvents.delete(event.id);
          saveLinkedEvents();
          syncSnapshots.delete(String(event.round));
          await syncLinkedResults();
        } else await linkEvent(event);
        await refreshEvents();
      })));
      section.appendChild(button("신청 로그 · 롤백", () => teacherAction(async () => {
        await showHistory(event, section);
        byId("cloudTeacherMessage").textContent = "이력의 복원 버튼은 해당 기록 시각 직전 상태로 되돌립니다.";
      })));
      section.appendChild(button(event.is_open ? "신청 마감" : "다시 열기", () => teacherAction(async () => {
        const result = await rpc("manage_course_event", { p_event: event.id, p_action: event.is_open ? "close" : "open" }, true);
        await refreshEvents();
        await syncLinkedResults();
        byId("cloudTeacherMessage").textContent = result.message;
      })));
      section.appendChild(button("신청 결과 저장", () => teacherAction(async () => {
        const result = await rpc("manage_course_event", { p_event: event.id, p_action: "export" }, true);
        downloadDataWorkbook(result, "results", `온라인_수강신청_결과_${event.round}차.xlsx`);
        byId("cloudTeacherMessage").textContent = `${result.entries.length}명 결과를 백업 파일로 저장했습니다. 집계표 연동 신청은 파일 업로드 없이 자동 반영됩니다.`;
      })));
      section.appendChild(button("전체 학생 코드 재발급", () => teacherAction(async () => {
        if (!window.confirm("모든 학생의 기존 코드가 무효화됩니다. 신청 결과는 유지됩니다. 전체 코드를 재발급할까요?")) {
          byId("cloudTeacherMessage").textContent = "재발급을 취소했습니다.";
          return;
        }
        latestCodes = await rpc("manage_course_event", { p_event: event.id, p_action: "codes" }, true);
        downloadDataWorkbook(latestCodes, "codes", "학생별_신청코드.xlsx");
        byId("cloudTeacherMessage").textContent = "전체 코드를 재발급했습니다. 새 코드를 저장하고 각 학생에게 다시 전달하세요. 기존 코드는 사용할 수 없습니다.";
      })));
      section.appendChild(button("명렬·결과 영구 삭제", () => teacherAction(async () => {
        if (!window.confirm(`${event.school_name} ${event.round}차의 모든 명렬과 신청을 영구 삭제할까요? 복구할 수 없습니다.`)) {
          byId("cloudTeacherMessage").textContent = "삭제를 취소했습니다.";
          return;
        }
        const result = await rpc("manage_course_event", { p_event: event.id, p_action: "delete" }, true);
        if (latestCodes?.id === event.id) latestCodes = null;
        linkedEvents.delete(event.id);
        saveLinkedEvents();
        await refreshEvents();
        byId("cloudTeacherMessage").textContent = result.message;
      })));
      list.appendChild(section);
    }
  }

  updateApplicationGradeControls = () => {
    const grade = state.applicationMenuGrade || "1";
    if (grade !== controlsGrade) {
      gradeDrafts.set(controlsGrade, { roster: pendingRoster, codes: latestCodes, summary: byId("cloudRosterSummary").textContent });
      const draft = gradeDrafts.get(grade);
      pendingRoster = draft?.roster || null;
      latestCodes = draft?.codes || null;
      byId("cloudRosterSummary").textContent = draft?.summary || `현재 ${grade}학년 명렬을 업로드하세요.`;
      byId("cloudTeacherMessage").textContent = "";
      controlsGrade = grade;
    }
    byId("cloudCreateEvent").disabled = !pendingRoster || !session;
    byId("cloudDownloadCodes").disabled = !latestCodes;
    renderGradeEvents();
  };

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
      }), Date.now());
      await refreshEvents();
      byId("cloudTeacherMessage").textContent = "구글 계정으로 로그인했습니다.";
    });
  }
  byId("cloudTeacherLogout").addEventListener("click", () => teacherAction(async () => {
    try { await request("/auth/v1/logout", { authenticated: true }); }
    finally { clearTeacherSession("로그아웃했습니다."); }
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
      pendingRoster = null;
      byId("cloudCreateEvent").disabled = true;
      byId("cloudRosterSummary").textContent = "선택한 명렬을 확인합니다. 실패하면 명렬을 다시 업로드하세요.";
      if (!session) throw new Error("교사 로그인이 필요합니다.");
      if (!file.name.toLowerCase().endsWith(".xlsx")) throw new Error("학생 명렬은 .xlsx 형식이어야 합니다.");
      const allRoster = parseApplicationRoster(await parseWorkbook(await file.arrayBuffer()));
      const currentGrade = state.applicationMenuGrade || "1";
      const roster = allRoster.filter((student) => String(student.grade) === currentGrade);
      if (!roster.length) throw new Error(`현재 ${currentGrade}학년 학생이 없는 명렬입니다. 해당 학년 메뉴에서 업로드하세요.`);
      const grades = [...new Set(roster.map((student) => String(Number(student.grade) + 1)))].sort();
      const subjects = getGroupedApplicationSubjects();
      if (!subjects) throw new Error("1단계에서 편제표를 먼저 불러오세요.");
      for (const grade of grades) {
        if (!subjects[grade]?.length) throw new Error(`${grade}학년 학생선택교육과정 과목을 찾지 못했습니다. 편제표를 확인하세요.`);
      }
      setApplicationTargetGrades(grades);
      pendingRoster = roster;
      byId("cloudCreateEvent").disabled = false;
      byId("cloudRosterSummary").textContent = `${file.name} · 현재 ${currentGrade}학년 ${roster.length}명 · 신청 대상: ${grades.map((g) => `${g}학년`).join(", ")}만` +
        (allRoster.length > roster.length ? ` · 다른 학년 ${allRoster.length - roster.length}명 제외 (해당 학년 메뉴에서 별도 업로드)` : "");
      byId("applicationGroupsTab").click();
      byId("cloudTeacherMessage").textContent = "해당 학년의 그룹·선택 수를 설정한 뒤 온라인 신청 관리 탭에서 수강신청 생성을 누르세요.";
      byId("courseGroupMessage").textContent = `명렬 기준 ${grades.map((g) => `${g}학년`).join(", ")} 그룹만 설정하세요. 설정 후 온라인 신청 관리 탭에서 신청을 생성합니다.`;
    });
  });
  byId("cloudCreateEvent").addEventListener("click", () => {
    teacherAction(async () => {
      if (!session) throw new Error("교사 로그인이 필요합니다.");
      if (!pendingRoster) throw new Error("학생 명렬을 먼저 업로드하세요.");
      if (latestCodes && !window.confirm("이전에 생성한 학생 코드를 저장했나요? 새 신청을 생성하면 이전 코드 다운로드 버튼은 대체됩니다.")) {
        byId("cloudTeacherMessage").textContent = "생성을 취소했습니다. 이전 코드를 먼저 저장하세요.";
        return;
      }
      const allSubjects = getGroupedApplicationSubjects();
      if (!allSubjects) throw new Error("1단계에서 편제표를 먼저 불러오세요.");
      const grades = [...new Set(pendingRoster.map((student) => String(Number(student.grade) + 1)))];
      const subjects = { "1": [], "2": [], "3": [] };
      for (const grade of grades) subjects[grade] = allSubjects[grade] || [];
      const setup = {
        type: "course-application-setup",
        schoolName: byId("schoolName").value.trim(), schoolYear: byId("schoolYear").value.trim(),
        round: state.currentRound, subjects,
        groups: getCourseApplicationGroups(grades),
        roster: pendingRoster,
      };
      for (const student of setup.roster) {
        const targetGrade = String(Number(student.grade) + 1);
        if (!subjects[targetGrade]?.length) {
          throw new Error(`현재 ${student.grade}학년이 신청할 ${targetGrade}학년 학생선택교육과정 과목을 찾지 못했습니다. 1단계 편제표의 교육과정 구분과 ${targetGrade}학년 학기 시수를 확인하세요.`);
        }
      }
      latestCodes = await rpc("create_course_event", { p_setup: setup }, true);
      downloadDataWorkbook(latestCodes, "codes", "학생별_신청코드.xlsx");
      byId("cloudTeacherMessage").textContent = `${setup.round}차 신청을 생성했습니다 (${latestCodes.students.length}명). 학생 코드를 반드시 저장하고 개별 전달하세요.`;
      // Keep the successful creation and its codes visible even if refreshing the list fails.
      try {
        await refreshEvents();
        const created = knownEvents.find((event) => event.id === latestCodes.id);
        if (!created) throw new Error("생성한 신청을 목록에서 찾지 못했습니다. 새로고침 후 집계표 연동을 누르세요.");
        await linkEvent(created);
        await refreshEvents();
      } catch (error) {
        byId("cloudTeacherMessage").textContent += ` 목록 갱신 실패: ${error.message}. 신청은 생성되었으므로 재업로드하지 말고 새로고침을 누르세요.`;
      }
    });
  });
  byId("cloudDownloadCodes").addEventListener("click", () => {
    if (latestCodes) downloadDataWorkbook(latestCodes, "codes", "학생별_신청코드.xlsx");
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
      if (application) updateStudentSemester();
    }
  }

  function isCoreApplicationCourse(course) {
    const area = String(course?.area || course?.category || "").replace(/\s+/g, "");
    if (/국어|영어|수학/.test(area)) return true;
    const subject = String(course?.subject || course?.name || "").replace(/\s+/g, "");
    return /^(국어|화법과작문|독서와작문|문학|언어와매체|영어|영어회화|영어독해와작문|수학|대수|미적분|확률과통계|기하|경제수학|인공지능수학)/.test(subject);
  }

  function renderStudentApplication(data) {
    studentSemesterIndex = 0;
    byId("cloudStudentCourses").classList.remove("hidden");
    const s = data.student;
    if (!["1", "2"].includes(String(s.grade))) throw new Error("신청 가능한 현재 학년은 1·2학년입니다. 교사에게 명렬 확인을 요청하세요.");
    const targetGrade = String(Number(s.grade) + 1);
    byId("cloudStudentTitle").textContent = `${data.schoolYear}학년도 ${data.schoolName} ${data.round}차 · ${targetGrade}학년 수강신청`;
    byId("cloudStudentIdentity").textContent = `${s.grade}학년 ${s.classroom}반 ${s.number}번 ${s.name} · 신청 대상: ${Number(s.grade) + 1}학년`;
    const choices = byId("cloudStudentChoices");
    choices.replaceChildren();
    if (data.groups?.length) {
      for (const group of data.groups) {
        if (group.grade && String(group.grade) !== targetGrade) throw new Error("신청 대상 학년의 그룹 설정이 잘못되었습니다. 교사에게 확인을 요청하세요.");
        const fieldset = document.createElement("fieldset");
        fieldset.dataset.group = group.id;
        fieldset.dataset.count = group.count;
        const semesters = [...new Set(group.courses.map((name) => data.courses.find((c) => c.subject === name)?.semester))];
        fieldset.dataset.semester = ["1", "2"].includes(group.semester) ? group.semester :
          semesters.length === 1 && ["1", "2"].includes(semesters[0]) ? semesters[0] : "0";
        const legend = document.createElement("legend");
        const semester = group.semester ? (group.semester==="0"?"학기 미정":`${group.semester}학기`) : "";
        legend.textContent = `${semester ? semester+" · " : ""}${group.name} · 정확히 ${group.count}과목 선택`;
        fieldset.appendChild(legend);
        for (const subject of group.courses) {
          const course = data.courses.find((c) => c.subject === subject);
          if (!course) throw new Error("그룹 과목 설정이 잘못되었습니다.");
          const label = document.createElement("label"); label.className = "application-subject";
          const box = document.createElement("input"); box.type = "checkbox"; box.value = subject;
          box.dataset.credit = course.credit; box.dataset.core = String(isCoreApplicationCourse(course));
          box.checked = data.selections.includes(subject); box.disabled = !data.open;
          label.append(box, document.createTextNode(`${applicationCourseLabel(course)} · ${course.credit}학점`)); fieldset.appendChild(label);
        }
        choices.appendChild(fieldset);
      }
    } else {
    const semesters = new Map();
    for (const course of [...data.courses].sort((a, b) => String(a.semester || "9").localeCompare(String(b.semester || "9")))) {
      const semester = course.semester || "학기 미정";
      if (!semesters.has(semester)) {
        const group = document.createElement("fieldset");
        group.dataset.semester = ["1", "2"].includes(semester) ? semester : "0";
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
      box.dataset.core = String(isCoreApplicationCourse(course));
      box.checked = data.selections.includes(course.subject);
      box.disabled = !data.open;
      label.append(box, document.createTextNode(`${applicationCourseLabel(course)} · ${course.credit}학점`));
      semesters.get(semester).appendChild(label);
    }
    }
    studentSemesters = [...new Set([...choices.children].map((fieldset) => fieldset.dataset.semester))]
      .sort((a, b) => (a === "0" ? 9 : Number(a)) - (b === "0" ? 9 : Number(b)));
    updateStudentSemester();
    updateSummary();
    byId("cloudStudentMessage").textContent = !data.open ? "접수가 마감되었습니다. 기존 신청만 확인할 수 있습니다."
      : data.submittedAt ? "기존 신청을 불러왔습니다. 수정 후 저장할 수 있습니다." : "과목을 선택하고 신청 저장을 누르세요.";
  }
  function updateStudentSemester() {
    const current = studentSemesters[studentSemesterIndex];
    const last = studentSemesterIndex === studentSemesters.length - 1;
    for (const fieldset of byId("cloudStudentChoices").children) {
      fieldset.classList[fieldset.dataset.semester === current ? "remove" : "add"]("hidden");
    }
    byId("cloudStudentSemesterStatus").textContent = current
      ? `${studentSemesterIndex + 1}/${studentSemesters.length} 단계 · ${current === "0" ? "학기 미정 과목" : current+"학기 수강신청"}` : "";
    byId("cloudStudentPrevious").classList[studentSemesterIndex > 0 ? "remove" : "add"]("hidden");
    byId("cloudStudentNext").classList[last || !current ? "add" : "remove"]("hidden");
    byId("cloudStudentSave").classList[last ? "remove" : "add"]("hidden");
    byId("cloudStudentNext").textContent = `다음: ${studentSemesters[studentSemesterIndex+1] === "0" ? "학기 미정" : studentSemesters[studentSemesterIndex+1]+"학기"}`;
  }
  function validateStudentSemester() {
    if (!application.open) return;
    for (const fieldset of byId("cloudStudentChoices").children) {
      if (fieldset.dataset.semester !== studentSemesters[studentSemesterIndex]) continue;
      const count = fieldset.querySelectorAll("input:checked").length;
      if (fieldset.dataset.group && count !== Number(fieldset.dataset.count)) {
        throw new Error(`${fieldset.querySelector("legend").textContent} · 선택 수를 맞춘 뒤 다음 학기로 이동하세요.`);
      }
    }
  }
  byId("cloudStudentNext").addEventListener("click", () => {
    try {
      validateStudentSemester();
      if (studentSemesterIndex < studentSemesters.length - 1) studentSemesterIndex++;
      updateStudentSemester();
      byId("cloudStudentMessage").textContent = "앞 학기의 선택은 유지됩니다. 모든 학기 선택 후 신청 저장을 누르세요.";
    } catch (error) { byId("cloudStudentMessage").textContent = error.message; }
  });
  byId("cloudStudentPrevious").addEventListener("click", () => {
    if (studentSemesterIndex > 0) studentSemesterIndex--;
    updateStudentSemester();
    byId("cloudStudentMessage").textContent = "선택 내용을 수정한 뒤 다음 학기로 이동하세요.";
  });
  function updateSummary() {
    const selected = [...byId("cloudStudentChoices").querySelectorAll("input:checked")];
    const credits = selected.reduce((total, box) => total + (Number(box.dataset.credit) || 0), 0);
    const coreCredits = selected.reduce((total, box) =>
      total + (box.dataset.core === "true" ? Number(box.dataset.credit) || 0 : 0), 0);
    const corePercent = credits ? Math.round(coreCredits / credits * 100) : 0;
    byId("cloudStudentTotal").textContent = `선택 ${selected.length}개 · 신청 ${credits}학점`;
    byId("cloudStudentCore").textContent = `국·영·수 ${coreCredits}학점 · ${corePercent}%`;
    byId("cloudStudentCoreFill").style.width = `${corePercent}%`;
    byId("cloudStudentCoreTrack").setAttribute("aria-valuenow", String(corePercent));
    for (const fieldset of byId("cloudStudentChoices").querySelectorAll("fieldset[data-group]")) {
      const count = fieldset.querySelectorAll("input:checked").length;
      const group = application.groups.find((g) => g.id === fieldset.dataset.group);
      fieldset.querySelector("legend").textContent = `${fieldset.dataset.semester === "0" ? "" : fieldset.dataset.semester+"학기 · "}${group.name} · ${count}/${group.count}과목 선택`;
      for (const box of fieldset.querySelectorAll("input")) {
        box.disabled = !application.open || (!box.checked && count >= Number(group.count));
      }
    }
  }
  byId("cloudStudentChoices").addEventListener("change", (event) => {
    const box = event.target;
    const fieldset = box?.closest?.("fieldset[data-group]");
    if (fieldset && box.checked && fieldset.querySelectorAll("input:checked").length > Number(fieldset.dataset.count)) {
      box.checked = false;
      byId("cloudStudentMessage").textContent = `이 그룹은 최대 ${fieldset.dataset.count}과목만 선택할 수 있습니다. 기존 선택을 해제한 뒤 변경하세요.`;
    }
    updateSummary();
  });
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
      if (studentSemesterIndex < studentSemesters.length - 1) throw new Error("1학기 선택을 완료하고 다음 학기로 이동한 뒤 모든 학기 신청을 저장하세요.");
      const code = activeCode;
      const selected = [...byId("cloudStudentChoices").querySelectorAll("input:checked")].map((box) => box.value);
      if (!selected.length) throw new Error("과목을 1개 이상 선택하세요.");
      for (const group of application.groups || []) {
        const count = selected.filter((name) => group.courses.includes(name)).length;
        if (count !== group.count) throw new Error(`${group.name}: 정확히 ${group.count}과목을 선택하세요 (현재 ${count}개).`);
      }
      if (previewMode) {
        byId("cloudStudentMessage").textContent = "미리보기 제출 완료 · 실제 신청은 저장되지 않습니다.";
        window.showAppToast?.("미리보기 제출을 확인했습니다. 실제 신청은 저장되지 않았습니다.");
        return;
      }
      const result = eventId
        ? await rpc("save_scoped_course_application", { p_event: eventId, p_code: code, p_selections: selected })
        : await rpc("save_course_application", { p_code: code, p_selections: selected });
      if (activeCode === code) {
        byId("cloudStudentMessage").textContent = result.message;
        window.showAppToast?.(result.message);
      }
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
        await syncLinkedResults();
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
      panel.appendChild(button("로그 엑셀 저장", () =>
        downloadDataWorkbook(data, "history", "수강신청_로그.xlsx")));
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
      if (typeof qrcode !== "function") throw new Error("QR코드 생성 기능을 불러오지 못했습니다. 페이지를 새로고침하세요.");
      const qr = qrcode(0, "M");
      qr.addData(link, "Byte");
      qr.make();
      const qrImage = qr.createSvgTag({cellSize:4, margin:16, scalable:true,
        alt:"학교·차수별 수강신청 페이지로 이동하는 QR코드"});
      return students.map((s) => `<section class="print-page"><h2>수강신청 안내</h2>
        <p>${escapeHtml(s.grade)}학년 ${escapeHtml(s.classroom)}반 ${escapeHtml(s.number)}번 <strong>${escapeHtml(s.name)}</strong></p>
        <p>QR코드를 스캔하거나 아래 학교·차수 신청 주소로 접속하여 본인 코드를 입력하세요.</p>
        <figure class="code-qr">${qrImage}<figcaption>학생 수강신청 페이지</figcaption></figure>
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
        throw new Error("학생별 신청 코드 파일 형식을 확인하세요.");
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
        byId("cloudTeacherMessage").textContent = "이전 로그인에서 저장한 학생별 코드 엑셀을 선택하세요. 예전 JSON도 읽을 수 있으며 재발급 없이 출력합니다.";
        byId("cloudCodeFile").click();
        return;
      }
      openCodes(latestCodes);
      byId("cloudTeacherMessage").textContent = "메일머지 출력창을 열었습니다.";
    }));
    byId("cloudCodeFile").addEventListener("change", (event) => {
      const file = event.target.files[0]; event.target.value = "";
      if (file) teacherAction(async () => {
        let data;
        if (file.name?.toLowerCase().endsWith(".xlsx")) {
          const sheets = await parseWorkbook(await file.arrayBuffer());
          const rows = sheets[0]?.rows || [];
          if (rows[0]?.[0] !== "신청ID" || rows[0]?.[5] !== "신청코드") throw new Error("학생 코드 엑셀 양식을 확인하세요.");
          const records = rows.slice(1).filter((row) => row[0]);
          if (!records.length || records.some((row) => row[0] !== records[0][0])) throw new Error("코드 파일은 하나의 신청만 포함해야 합니다.");
          data = { id: records[0][0], students: records.map((row) => ({
            grade:String(row[1]), classroom:String(row[2]), number:String(row[3]), name:String(row[4]), code:String(row[5])
          })) };
        } else data = JSON.parse(await file.text());
        openCodes(data);
        latestCodes = data;
        byId("cloudTeacherMessage").textContent = "저장한 코드 파일의 출력창을 열었습니다.";
      });
    });
    byId("cloudPrintClass").addEventListener("change", () => {
      try { previewCodes(); }
      catch (error) { byId("cloudTeacherMessage").textContent = error.message; }
    });
    byId("cloudCodeClose").addEventListener("click", () => byId("cloudCodeDialog").close());
    byId("cloudCodePrint").addEventListener("click", () => {
      try {
        byId("printBatch").innerHTML = codeMarkup(filteredPrintStudents());
        // Keep the preview open so another print can rebuild the batch after afterprint clears it.
        window.print();
      } catch (error) { byId("cloudTeacherMessage").textContent = error.message; }
    });
  async function initializeTeacherSession() {
    if (eventId || new URL(window.location.href).hash === "#student" || new URL(window.location.href).hash.startsWith("#apply=")) return;
    const url = new URL(window.location.href);
    if (url.searchParams.has("code") || url.searchParams.has("error")) return completeGoogleLogin();
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!Number.isFinite(saved.lastActivity) || saved.lastActivity > Date.now() || Date.now() - saved.lastActivity >= IDLE_MS) {
      localStorage.removeItem(SESSION_KEY);
      byId("cloudTeacherMessage").textContent = "5분간 활동이 없어 자동 로그아웃했습니다.";
      byId("teacherLoginMessage").textContent = "5분간 활동이 없어 자동 로그아웃했습니다.";
      return;
    }
    setSession(saved.session, saved.lastActivity);
    try {
      await refreshEvents();
    } catch (error) {
      byId("cloudTeacherMessage").textContent = `목록 갱신 실패: ${error.message} 신청 목록 새로고침을 다시 눌러주세요.`;
    }
  }
  initializeTeacherSession().catch((error) => {
    clearTeacherSession(`로그인 처리 실패: ${error.message}`);
    byId("cloudTeacherMessage").textContent = `로그인 처리 실패: ${error.message}`;
  });
  byId("curriculumGoogleLogin").addEventListener("click", () => byId("cloudTeacherGoogleLogin").click());
  byId("headerTeacherLogout").addEventListener("click", () => byId("cloudTeacherLogout").click());
  updateAccountControls();
})();
