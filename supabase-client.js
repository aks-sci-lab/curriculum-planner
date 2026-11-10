"use strict";
var requireTeacherLogin;
var unlinkApplicationRound;
var updateApplicationGradeControls;
var updateRetakeReadiness;

(() => {
  // 서버 주소·공개 키는 supabase-config.js 한 곳에서 정한다(수강신청 테스트봇도 같은 값을 쓴다).
  const { projectUrl: PROJECT_URL, publicKey: PUBLIC_KEY } = CURRICULUM_SUPABASE_CONFIG;
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
  let controlsYear = byId("schoolYear").value;
  function isOfflineWorkspace() {
    return new URL(window.location.href).protocol === "file:" || navigator.onLine === false;
  }
  requireTeacherLogin = () => {
    if (session && Date.now() - lastActivity < IDLE_MS) return true;
    if (isOfflineWorkspace()) {
      byId("cloudTeacherMessage").textContent = "오프라인입니다. 웹 수강신청 기능은 인터넷 연결과 교사 로그인이 필요합니다.";
      return false;
    }
    byId("cloudTeacherMessage").textContent = "웹 수강신청 기능은 구글 로그인 후 이용하세요.";
    updateAccountControls();
    byId("teacherLoginMessage").textContent = "웹 수강신청 기능은 오른쪽 위 구글 로그인 후 이용하세요.";
    byId("curriculumGoogleLogin").focus();
    return false;
  };
  function saveSession() {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ session, lastActivity }));
  }

  for (const [guideId, tabId] of [
    ["applicationGuideGroups", "applicationGroupsTab"],
  ]) {
    byId(guideId).addEventListener("click", () => byId(tabId).click());
  }
  byId("applicationGuideResults").addEventListener("click", () => {
    const tabId = state.applicationMode === "web" ? "applicationOnlineTab" : "applicationResultsTab";
    byId(tabId).click();
  });
  byId("applicationGuideAggregate").addEventListener("click", () => {
    if (typeof switchWorkflowStep === "function") switchWorkflowStep(4);
  });
  function updateAccountControls() {
    const studentRoute = !!eventId || new URL(window.location.href).hash === "#student" || new URL(window.location.href).hash.startsWith("#apply=");
    const offlineWorkspace = isOfflineWorkspace();
    const loggedIn = !!session && Date.now() - lastActivity < IDLE_MS && !studentRoute;
    byId("teacherHeader").classList[studentRoute ? "add" : "remove"]("hidden");
    byId("teacherWorkspace").classList[studentRoute ? "add" : "remove"]("hidden");
    byId("headerTeacherLogout").classList[loggedIn ? "remove" : "add"]("hidden");
    byId("curriculumGoogleLogin").classList[loggedIn || offlineWorkspace ? "add" : "remove"]("hidden");
    byId("curriculumGoogleLogin").disabled = !!session;
    byId("curriculumLoginStatus").textContent = session
      ? `${session.user.email} · 로그인 중`
      : offlineWorkspace ? "오프라인 · 로컬 기능 사용 가능" : "로그인 없이 사용 가능 · 웹 수강신청만 로그인 필요";
    byId("cloudTeacherGoogleLogin").classList[offlineWorkspace ? "add" : "remove"]("hidden");
    byId("cloudTeacherOfflineNotice").classList[offlineWorkspace ? "remove" : "add"]("hidden");
  }
  function clearTeacherSession(message) {
    sessionRevision++;
    session = null;
    localStorage.removeItem(SESSION_KEY);
    latestCodes = null;
    printingCodes = null;
    byId("cloudCodeDialog").close();
    byId("cloudTeacherEditDialog").close();
    teacherEdit = null;
    byId("cloudTeacherEditChoices").replaceChildren();
    byId("cloudTeacherEditStudent").replaceChildren();
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
  window.addEventListener("online", updateAccountControls);
  window.addEventListener("offline", updateAccountControls);
  const PKCE_STORAGE_KEY = "curriculum-google-pkce";
  let latestCodes = null;
  let latestCodesMeta = null;
  let activeCode = "";
  let application = null;
  let previewMode = false;
  let studentSemesters = [];
  let studentSemesterIndex = 0;
  let teacherBusy = false;
  let teacherEdit = null;
  let teacherEditBusy = false;
  let studentBusy = false;
  let studentSaved = false;
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
    if (!event && typeof courseCheckAttachToSetup === "function") courseCheckAttachToSetup({ subjects: { [grade]: courses }, groups });
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
    const lockedRounds = [];
    for (const round of rounds) {
      if (typeof isRoundLocked === "function" && isRoundLocked(round)) {
        lockedRounds.push(round);
        continue;
      }
      const events = linked.filter((event) => String(event.round) === round);
      if (events.some((event) => event.school_name !== events[0].school_name || event.school_year !== events[0].school_year)) {
        throw new Error(`${round}차에 다른 학교·학년도의 신청이 연동되어 있습니다. 연동을 해제하세요.`);
      }
      const subjects = { "1": [], "2": [], "3": [] };
      const groups = [];
      const entries = [];
      const identities = new Set();
      for (const event of events) {
        const result = await rpc("manage_course_event", { p_event: event.id, p_action: "export" }, true);
        for (const group of event.groups || []) {
          const overlapping = groups.filter((existing) => existing.grade === group.grade &&
              existing.semester === group.semester &&
              existing.courses.some((name) => group.courses.includes(name)));
          if (overlapping.some((existing) => existing.name !== group.name ||
              existing.count !== group.count ||
              JSON.stringify([...existing.courses].sort()) !== JSON.stringify([...group.courses].sort()))) {
            throw new Error(`${round}차 ${group.name}: 연동 신청의 과목 그룹 설정이 다릅니다.`);
          }
          if (!overlapping.length) groups.push(group);
        }
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
      const snapshot = JSON.stringify({ entries, subjects, groups });
      if (syncSnapshots.get(round) !== snapshot) {
        applyCloudApplicationResults(round, entries, subjects, groups);
        syncSnapshots.set(round, snapshot);
      }
    }
    byId("cloudSyncStatus").textContent = linked.length
      ? `집계표 자동 연동 ${linked.length}개 신청 · 최근 갱신 ${new Date().toLocaleTimeString("ko-KR")} · ${realtimeConnected ? "실시간" : "연결 전 30초 간격"}` +
        (lockedRounds.length ? ` · 확정된 ${lockedRounds.map((round) => `${round}차`).join(", ")}는 반영 중지` : "")
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
    const buttons = [...byId("supabaseTeacherPanel").querySelectorAll("button"), byId("schoolYear")];
    const previous = buttons.map((button) => button.disabled);
    buttons.forEach((button) => { button.disabled = true; });
    // 학년 탭은 disabled로 막지 않는다(누른 것이 조용히 무시됨): aria-disabled로 표시하고, 그동안 누른 학년은 끝난 뒤 바꾼다(course-groups.js).
    const gradeTabs = [byId("applicationGrade1Tab"), byId("applicationGrade2Tab")];
    gradeTabs.forEach((tab) => tab.setAttribute("aria-disabled", "true"));
    byId("cloudRosterInput").disabled = true;
    byId("cloudTeacherMessage").textContent = "처리 중…";
    // 머리 줄 문구: 로그인 전(로그인·토큰 교환 중)에만 '로그인 처리 중…'을 보이고, 끝나면 원래 문구로 되돌린다.
    const loginMessage = byId("teacherLoginMessage");
    const loginBefore = loginMessage.textContent;
    const loginBusyText = "로그인 처리 중…";
    if (!session) loginMessage.textContent = loginBusyText;
    let failed = false;
    try {
      await action();
    } catch (error) {
      failed = true;
      byId("cloudTeacherMessage").textContent = error.message;
      loginMessage.textContent = error.message;
    } finally {
      if (!failed && loginMessage.textContent === loginBusyText) loginMessage.textContent = session ? "" : (loginBefore === loginBusyText ? "" : loginBefore);
      teacherBusy = false;
      buttons.forEach((button, index) => { button.disabled = previous[index]; });
      gradeTabs.forEach((tab) => tab.removeAttribute("aria-disabled"));
      byId("cloudRosterInput").disabled = false;
      byId("cloudDownloadCodes").disabled = !latestCodes;
      byId("cloudSendTestBot").disabled = !latestCodes;
      byId("cloudPrintCodes").disabled = false;
      byId("cloudCreateEvent").disabled = !pendingRoster || !session;
      updateRetakeReadiness();
      if (typeof flushPendingApplicationMenuGrade === "function") flushPendingApplicationMenuGrade();
    }
  }

  function button(text, action, className = "button") {
    const element = document.createElement("button");
    element.type = "button";
    element.className = className;
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

  // '신청 마감' 확인 문구(마감하면 학생이 신청·수정할 수 없음, 다시 열기로 되돌림).
  function closeEventQuestion(event) {
    const mixed = event?.subjects?.["2"]?.length && event?.subjects?.["3"]?.length;
    return `${event?.round ?? ""}차 수강신청을 마감할까요?${mixed ? " (1·2학년 통합 신청이라 두 학년 모두 마감됩니다)" : ""}\n\n마감하면 학생이 더 이상 신청·수정할 수 없습니다. 필요하면 '다시 열기'로 되돌릴 수 있습니다.`;
  }

  function renderGradeEvents() {
    const grade = String(Number(state.applicationMenuGrade || "1") + 1);
    const events = knownEvents.filter((event) => event.subjects?.[grade]?.length);
    const source = byId("cloudRetakeSource");
    const previous = source.value;
    source.replaceChildren();
    for (const event of events.filter((event) => event.school_year === byId("schoolYear").value)) {
      const option = document.createElement("option");
      option.value = event.id;
      option.textContent = `${event.round}차 · ${event.school_name} · ${event.is_open ? "접수 중 (마감 필요)" : "마감"} · ${event.id.slice(0,8)}`;
      source.appendChild(option);
    }
    source.value = [...source.children].some((option) => option.value === previous) ? previous : source.children[0]?.value || "";
    updateRetakeReadiness();
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
      section.className = "cloud-event-card";
      title.className = "cloud-event-title";
      link.href = eventLink(event.id);
      link.className = "cloud-event-link";
      link.textContent = "학생 신청 링크 열기 ↗";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      section.appendChild(link);
      section.appendChild(button("학생 화면 미리보기", () => teacherAction(async () => {
        openStudentPreview(event);
      }), "button button-quiet"));
      section.appendChild(button("신청 현황 · 위계 점검", () => teacherAction(async () => {
        await showApplicationStatusPanel(event, section);
      }), "button button-quiet"));
      section.appendChild(button("학생 선택 과목 변경", () => teacherAction(async () => {
        await openTeacherEditor(event);
      }), "button button-primary"));
      section.appendChild(button(linkedEvents.has(event.id) ? "집계표 연동 해제" : "집계표 연동", () => teacherAction(async () => {
        if (linkedEvents.has(event.id)) {
          linkedEvents.delete(event.id);
          saveLinkedEvents();
          syncSnapshots.delete(String(event.round));
          await syncLinkedResults();
        } else await linkEvent(event);
        await refreshEvents();
      }), "button button-secondary"));
      section.appendChild(button("신청 로그 · 롤백", () => teacherAction(async () => {
        await showHistory(event, section);
        byId("cloudTeacherMessage").textContent = "이력의 복원 버튼은 해당 기록 시각 직전 상태로 되돌립니다.";
      }), "button button-quiet"));
      section.appendChild(button(event.is_open ? "신청 마감" : "다시 열기", () => teacherAction(async () => {
        // 마감은 학생 화면을 바로 닫으므로 한 번 묻는다(다시 열기로 되돌릴 수 있음).
        if (event.is_open && !(await (typeof window.appConfirm === "function"
          ? window.appConfirm(closeEventQuestion(event), { title: "신청 마감", ok: "신청 마감" })
          : Promise.resolve(window.confirm(closeEventQuestion(event)))))) return;
        const result = await rpc("manage_course_event", { p_event: event.id, p_action: event.is_open ? "close" : "open" }, true);
        await refreshEvents();
        await syncLinkedResults();
        byId("cloudTeacherMessage").textContent = result.message;
      }), "button button-quiet"));
      section.appendChild(button("신청 결과 저장", () => teacherAction(async () => {
        const result = await rpc("manage_course_event", { p_event: event.id, p_action: "export" }, true);
        downloadDataWorkbook(result, "results", `온라인_수강신청_결과_${event.round}차.xlsx`);
        byId("cloudTeacherMessage").textContent = `${result.entries.length}명 결과를 백업 파일로 저장했습니다. 집계표 연동 신청은 파일 업로드 없이 자동 반영됩니다.`;
      }), "button button-quiet"));
      section.appendChild(button("전체 학생 코드 재발급", () => teacherAction(async () => {
        if (!window.confirm("모든 학생의 기존 코드가 무효화됩니다. 신청 결과는 유지됩니다. 전체 코드를 재발급할까요?")) {
          byId("cloudTeacherMessage").textContent = "재발급을 취소했습니다.";
          return;
        }
        latestCodes = await rpc("manage_course_event", { p_event: event.id, p_action: "codes" }, true);
        latestCodesMeta = { schoolName: event.school_name, schoolYear: String(event.school_year), round: String(event.round) };
        downloadDataWorkbook(latestCodes, "codes", "학생별_신청코드.xlsx");
        byId("cloudTeacherMessage").textContent = "전체 코드를 재발급했습니다. 새 코드를 저장하고 각 학생에게 다시 전달하세요. 기존 코드는 사용할 수 없습니다.";
      }), "button button-quiet"));
      section.appendChild(button("학생 접속 잠금 · 코드 재발급", () => teacherAction(async () => {
        await showStudentAccessPanel(event, section);
      }), "button button-quiet"));
      section.appendChild(button("학생 잠금 전체 해제", () => teacherAction(async () => {
        if (!window.confirm("이 신청의 모든 학생 접속 잠금과 실패 기록을 지울까요? 코드는 바뀌지 않습니다.")) return;
        const result = await rpc("unlock_course_event", { p_event: event.id }, true);
        byId("cloudTeacherMessage").textContent = result.message;
        if (section.querySelector(".course-code-locks")) await showStudentAccessPanel(event, section);
      }), "button button-quiet"));
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
      }), "button button-danger"));
      list.appendChild(section);
    }
  }

  function retakeClosedSubjects(source) {
    const data = state.rounds?.[String(source.round)];
    const closed = [];
    for (const [key, verdict] of Object.entries(state.roundClosures?.[String(source.round)] || {})) {
      if (verdict !== "closed") continue;
      const separator = key.indexOf(":");
      const grade = String(Number(key.slice(0, separator)) + 1);
      const course = data?.courses.find((item) => String(item.column) === key.slice(separator + 1));
      if (!course) continue;
      const subject = course.applicationSubject?.subject || course.name.replace(/\([23]학년\)$/, "").trim();
      if (source.subjects?.[grade]?.some((item) => item.subject === subject)) closed.push({ grade, subject });
    }
    return closed;
  }

  updateRetakeReadiness = () => {
    const source = knownEvents.find((event) => event.id === byId("cloudRetakeSource").value);
    const lines = [];
    const data = source ? state.rounds?.[String(source.round)] : null;
    const closed = data ? retakeClosedSubjects(source) : [];
    if (!source) {
      lines.push("이 학년·학년도의 이전 신청을 선택하세요.");
    } else {
      lines.push(`${source.round}차 · ${source.is_open ? "접수 중 — 먼저 마감하세요." : "마감 완료"}`);
      lines.push(data ? `로컬 연동 명단 ${data.students.length}명 · 폐강 확정 ${closed.length}과목` : "집계표 연동이 필요합니다.");
      lines.push(byId("cloudRetakeMode").value === "affected"
        ? "폐강 과목 신청 학생만 대체 선택 · 기존 개설 과목과 비대상 학생 결과 유지"
        : "전체 학생 재선택 · 폐강 과목을 제외한 전체 선택지 제공");
      lines.push("새 신청 링크·개인 코드가 발급됩니다. 생성 후 새 코드를 저장·안내하세요.");
    }
    byId("cloudRetakeReadiness").textContent = lines.join("\n");
    byId("cloudReviewRetake").disabled = !data;
    byId("cloudCreateRetake").disabled = teacherBusy || !session || !data || source.is_open || !closed.length;
  };
  byId("cloudRetakeSource").addEventListener("change", updateRetakeReadiness);
  byId("cloudRetakeMode").addEventListener("change", updateRetakeReadiness);
  byId("cloudReviewRetake").addEventListener("click", () => {
    const source = knownEvents.find((event) => event.id === byId("cloudRetakeSource").value);
    if (!source || !state.rounds?.[String(source.round)]) return;
    switchRound(String(source.round));
    switchWorkflowStep(4);
  });

  // 신청 현황: 학생별 신청 목록과 위계(선이수) 경고. 서버가 준 학생 선택과 이벤트에 실린 과목.requires로 화면에서 계산한다
  // (서버 변경·서버 검사 없음, 경고만). 이전 학년 근거가 필요한 위계는 '확인 불가'로 따로 센다.
  async function showApplicationStatusPanel(event, parent) {
    const data = await rpc("get_teacher_course_applications", { p_event: event.id }, true);
    parent.querySelector(".cloud-application-status")?.remove();
    const grade = String(state.applicationMenuGrade || "1");
    const target = String(Number(grade) + 1);
    const review = typeof courseCheckTeacherReview === "function" ? courseCheckTeacherReview(data, grade) : null;
    const panel = document.createElement("section");
    panel.className = "cloud-application-status";
    const heading = document.createElement("h5");
    heading.textContent = `신청 현황 · 현 ${grade}학년 → ${target}학년 과목`;
    panel.appendChild(heading);
    const rows = review?.rows || data.entries.filter((entry) => String(entry.grade) === grade).map((entry) => ({ entry, violations: [], unknowns: [] }));
    const summary = document.createElement("p");
    summary.className = "cloud-status-summary";
    summary.setAttribute("role", "status");
    const submitted = review ? review.submitted : rows.filter(({ entry }) => entry.submittedAt || entry.selections?.length).length;
    const violators = document.createElement("b");
    violators.className = review?.violators ? "has-issue" : "";
    violators.textContent = review?.available ? `위계 경고 ${review.violators}명` : "위계 점검 정보 없음";
    summary.append(`학생 ${rows.length}명 · 제출 ${submitted}명 · `, violators,
      review?.available ? ` · 확인 불가 ${review.unknowns}명(이전 학년 근거 없음, 위반 아님)` : " (점검 정보 없이 만든 예전 신청)");
    panel.appendChild(summary);
    const filterLabel = document.createElement("label");
    const filter = document.createElement("input");
    filter.type = "checkbox";
    filter.className = "cloud-status-prereq-filter";
    filterLabel.append(filter, " 위계 경고만");
    panel.appendChild(filterLabel);
    const table = document.createElement("table");
    table.innerHTML = "<thead><tr><th scope=\"col\">반</th><th scope=\"col\">번호</th><th scope=\"col\">이름</th><th scope=\"col\">제출</th><th scope=\"col\">신청 과목</th><th scope=\"col\">위계 점검</th><th scope=\"col\"><span class=\"sr-only\">변경</span></th></tr></thead>";
    const body = document.createElement("tbody");
    for (const { entry, violations, unknowns } of rows) {
      const row = document.createElement("tr");
      row.className = violations.length ? "has-prereq" : "";
      row.dataset.prereq = violations.length ? "violation" : unknowns.length ? "unknown" : "";
      const cell = (text) => { const td = document.createElement("td"); td.textContent = text; row.appendChild(td); return td; };
      cell(entry.classroom); cell(entry.number); cell(entry.name);
      cell(entry.submittedAt ? "제출" : "미제출");
      cell((entry.selections || []).join(", "));
      const status = cell("");
      for (const issue of violations) {
        const line = document.createElement("div");
        line.className = "is-violation";
        line.textContent = `⚠ ${issue.course}: ${issue.brief}`;
        status.appendChild(line);
      }
      for (const issue of unknowns) {
        const line = document.createElement("div");
        line.className = "is-unknown";
        line.textContent = `확인 불가 · ${issue.course}: ${issue.brief}`;
        status.appendChild(line);
      }
      if (!violations.length && !unknowns.length) status.textContent = !review?.available ? "—" : entry.selections?.length ? "이상 없음" : "";
      const action = document.createElement("td");
      action.appendChild(button("과목 변경", () => teacherAction(async () => {
        await openTeacherEditor(event, entry.id);
      }), "button button-quiet"));
      row.appendChild(action);
      body.appendChild(row);
    }
    table.appendChild(body);
    const wrap = document.createElement("div");
    wrap.className = "aggregate-sheet-wrap";
    wrap.appendChild(table);
    panel.appendChild(wrap);
    const empty = document.createElement("p");
    empty.className = "note hidden";
    empty.textContent = "위계 경고 학생이 없습니다.";
    panel.appendChild(empty);
    filter.addEventListener("change", () => {
      let shown = 0;
      for (const row of body.children) {
        row.hidden = filter.checked && row.dataset.prereq !== "violation";
        if (!row.hidden) shown++;
      }
      empty.classList.toggle("hidden", shown > 0);
    });
    parent.appendChild(panel);
    byId("cloudTeacherMessage").textContent = `신청 현황을 불러왔습니다(현 ${grade}학년 ${rows.length}명${review?.available ? ` · 위계 경고 ${review.violators}명` : ""}). 위계는 경고만 하며 서버는 검사하지 않습니다.`;
  }

  function codeLockStatus(student) {
    if (student.teacherLock) return "잠김 · 교사 해제 필요";
    if (student.lockedSeconds > 0) return `잠김 · 약 ${Math.ceil(student.lockedSeconds / 60)}분 남음(자동 해제)`;
    return `실패 ${student.failTotal}회 · 연속 ${student.failStreak}회`;
  }

  // 학생 단위 접속 잠금 현황(실패 기록이 있는 학생만)과 학생별 잠금 해제·코드 재발급.
  async function showStudentAccessPanel(event, parent) {
    const [locks, data] = await Promise.all([
      rpc("get_course_code_locks", { p_event: event.id }, true),
      rpc("get_teacher_course_applications", { p_event: event.id }, true),
    ]);
    const old = parent.querySelector(".course-code-locks");
    if (old) old.remove();
    const panel = document.createElement("section");
    panel.className = "course-code-locks";
    const heading = document.createElement("h5");
    const locked = locks.students.filter((student) => student.teacherLock || student.lockedSeconds > 0);
    heading.textContent = `학생 접속 잠금 · 잠김 ${locked.length}명 (교사 해제 필요 ${locked.filter((student) => student.teacherLock).length}명)`;
    panel.appendChild(heading);
    const note = document.createElement("p");
    note.className = "note";
    note.textContent = "5회 연속 실패 → 10분 잠금, 누적 10회 뒤 또 실패 → 교사 해제 필요. 반·번호를 아는 다른 사람이 일부러 틀려 잠글 수도 있으니, 학생이 잠겼다고 하면 본인임을 확인한 뒤 해제하세요. 코드를 잊었다면 아래에서 재발급하세요(잠금도 함께 풀립니다).";
    panel.appendChild(note);
    if (!locks.students.length) {
      const empty = document.createElement("p");
      empty.textContent = "접속 실패 기록이 있는 학생이 없습니다.";
      panel.appendChild(empty);
    }
    for (const student of locks.students) {
      const row = document.createElement("div");
      const isLocked = student.teacherLock || student.lockedSeconds > 0;
      row.className = `course-code-lock-row${isLocked ? " is-locked" : ""}`;
      const label = document.createElement("span");
      label.textContent = `${student.grade}학년 ${student.classroom}반 ${student.number}번 ${student.name} · `;
      const status = document.createElement(isLocked ? "strong" : "span");
      status.textContent = codeLockStatus(student) + (student.lockCount ? ` · 10분 잠금 ${student.lockCount}회` : "");
      label.appendChild(status);
      row.appendChild(label);
      row.appendChild(button("잠금 해제", () => teacherAction(async () => {
        const result = await rpc("unlock_course_student", { p_event: event.id, p_student: student.id }, true);
        await showStudentAccessPanel(event, parent);
        byId("cloudTeacherMessage").textContent = result.message;
      }), isLocked ? "button button-primary" : "button button-quiet"));
      panel.appendChild(row);
    }
    const grade = String(state.applicationMenuGrade || "1");
    const entries = data.entries.filter((student) => student.grade === grade);
    const reissue = document.createElement("div");
    reissue.className = "course-reissue";
    const select = document.createElement("select");
    for (const student of entries) {
      const option = document.createElement("option");
      option.value = student.id;
      option.textContent = `${student.grade}학년 ${student.classroom}반 ${student.number}번 ${student.name}`;
      select.appendChild(option);
    }
    reissue.appendChild(select);
    reissue.appendChild(button("선택한 학생 코드 재발급", () => teacherAction(async () => {
      const chosen = entries.find((student) => student.id === select.value);
      if (!chosen) throw new Error("선택한 학년의 학생이 없습니다.");
      if (!window.confirm(`${chosen.classroom}반 ${chosen.number}번 ${chosen.name} 학생의 기존 코드를 무효로 하고 새 코드를 발급할까요? 신청 결과는 유지되고 접속 잠금도 풀립니다. 학생은 새 코드로 처음 접속할 때 코드를 다시 바꿔야 합니다.`)) return;
      const result = await rpc("reissue_course_code", { p_event: event.id, p_student: chosen.id }, true);
      const issued = result.students[0];
      const forwarded = forwardReissuedCode(event, issued);
      await showStudentAccessPanel(event, parent);
      byId("cloudTeacherMessage").textContent = `${issued.classroom}반 ${issued.number}번 ${issued.name} 새 코드: ${issued.code} · 잠금 해제됨 (이 학생에게만 전달하세요. 이 화면을 닫으면 다시 볼 수 없습니다.)` +
        (forwarded ? " 열려 있는 테스트봇 창에도 이 학생의 새 코드를 보냈습니다." : "");
    }), "button button-quiet"));
    panel.appendChild(reissue);
    parent.appendChild(panel);
  }

  async function openTeacherEditor(event, studentId = "") {
    const revision = sessionRevision;
    const data = await rpc("get_teacher_course_applications", { p_event: event.id }, true);
    if (!session || revision !== sessionRevision) throw new Error("다시 로그인하세요.");
    const entries = data.entries.filter((student) => student.grade === String(state.applicationMenuGrade || "1"));
    if (!entries.length) throw new Error("선택한 학년의 학생이 없습니다.");
    // 위계(선이수) 경고 학생은 목록에 표시한다(화면 계산, 경고만).
    const review = typeof courseCheckTeacherReview === "function" ? courseCheckTeacherReview(data, String(state.applicationMenuGrade || "1")) : null;
    const flagged = new Set((review?.rows || []).filter((row) => row.violations.length).map((row) => row.entry.id));
    teacherEdit = { eventId: event.id, entries, subjects: data.subjects, groups: data.groups };
    const select = byId("cloudTeacherEditStudent");
    select.replaceChildren();
    for (const student of entries) {
      const option = document.createElement("option");
      option.value = student.id;
      option.textContent = `${student.grade}학년 ${student.classroom}반 ${student.number}번 ${student.name}${student.submittedAt ? "" : " · 미제출"}${flagged.has(student.id) ? " · ⚠ 위계 경고" : ""}`;
      select.appendChild(option);
    }
    select.value = entries.some((student) => student.id === studentId) ? studentId : entries[0].id;
    byId("cloudTeacherEditSearch").value = "";
    byId("cloudTeacherEditSearch").addEventListener("input", filterTeacherEditStudents);
    renderTeacherEditor();
    byId("cloudTeacherEditDialog").showModal();
  }

  function renderTeacherEditor() {
    if (!teacherEdit) return;
    const student = teacherEdit.entries.find((entry) => entry.id === byId("cloudTeacherEditStudent").value);
    if (!student) throw new Error("학생을 선택하세요.");
    const grade = String(Number(student.grade) + 1);
    const courses = teacherEdit.subjects[grade] || [];
    const groups = (teacherEdit.groups || []).filter((group) => group.grade === grade);
    const choices = byId("cloudTeacherEditChoices");
    choices.replaceChildren();
    for (const group of groups.length ? groups : [{ name: "신청 과목", courses: courses.map((course) => course.subject) }]) {
      const fieldset = document.createElement("fieldset");
      const legend = document.createElement("legend");
      legend.textContent = `${group.semester && group.semester !== "0" ? group.semester + "학기 · " : ""}${group.name}${group.count === undefined ? "" : ` · 정확히 ${group.count}과목 선택`}`;
      fieldset.appendChild(legend);
      if (group.count !== undefined) {
        fieldset.dataset.count = String(group.count);
        fieldset.dataset.label = legend.textContent;
      }
      for (const subject of group.courses) {
        const course = courses.find((item) => item.subject === subject);
        if (!course) throw new Error("그룹 과목 설정이 잘못되었습니다.");
        const label = document.createElement("label");
        label.className = "application-subject";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = subject;
        box.checked = student.selections.includes(subject);
        box.disabled = student.reselectionAllowed === false || student.lockedSelections?.includes(subject);
        label.append(box, document.createTextNode(`${applicationCourseLabel(course)} · ${course.credit}학점`));
        fieldset.appendChild(label);
      }
      choices.appendChild(fieldset);
    }
    updateTeacherEditSummary();
    byId("cloudTeacherEditMessage").textContent = "";
  }

  function filterTeacherEditStudents() {
    const query = byId("cloudTeacherEditSearch").value.trim().toLocaleLowerCase("ko-KR");
    const select = byId("cloudTeacherEditStudent");
    const previous = select.value;
    let firstMatch = "";
    for (const option of select.children) {
      option.hidden = !!query && !option.textContent.toLocaleLowerCase("ko-KR").includes(query);
      if (!option.hidden && !firstMatch) firstMatch = option.value;
    }
    if (select.children.find((option) => option.value === previous)?.hidden) {
      if (!firstMatch) {
        byId("cloudTeacherEditMessage").textContent = "검색 결과가 없습니다. 이름이나 번호를 다시 확인하세요.";
        return;
      }
      select.value = firstMatch;
    }
    if (!select.value && firstMatch) select.value = firstMatch;
    if (previous !== select.value) renderTeacherEditor();
    else byId("cloudTeacherEditMessage").textContent = "";
  }

  function updateTeacherEditSummary() {
    if (!teacherEdit) return;
    const selected = byId("cloudTeacherEditChoices").querySelectorAll("input:checked").length;
    const groups = [...byId("cloudTeacherEditChoices").children];
    for (const fieldset of groups) {
      if (fieldset.dataset.count !== undefined) {
        fieldset.children[0].textContent = `${fieldset.dataset.label} · ${fieldset.querySelectorAll("input:checked").length}/${fieldset.dataset.count} 선택`;
      }
    }
    const student = teacherEdit.entries.find((entry) => entry.id === byId("cloudTeacherEditStudent").value);
    const picked = [...byId("cloudTeacherEditChoices").querySelectorAll("input:checked")].map((box) => box.value);
    for (const box of byId("cloudTeacherEditChoices").querySelectorAll("input")) {
      box.disabled = student?.reselectionAllowed === false || !!student?.lockedSelections?.includes(box.value) ||
        (!box.checked && picked.some((name) => baseApplicationSubject(name) === baseApplicationSubject(box.value)));
    }
    const studentLabel = student ? `${student.grade}학년 ${student.classroom}반 ${student.number}번 ${student.name}` : "학생 선택";
    byId("cloudTeacherEditSummary").textContent = `${studentLabel} · 현재 ${selected}과목 선택`;
    // 지금 고른 과목의 위계(선이수) 경고(저장은 막지 않는다).
    const prereqList = byId("cloudTeacherEditPrereq");
    if (prereqList) {
      prereqList.replaceChildren();
      const review = student && typeof courseCheckTeacherReview === "function"
        ? courseCheckTeacherReview({ entries: [{ ...student, selections: picked }], subjects: teacherEdit.subjects, groups: teacherEdit.groups }, student.grade) : null;
      const row = review?.rows[0];
      for (const issue of [...(row?.violations || []), ...(row?.unknowns || [])]) {
        const item = document.createElement("li");
        item.className = issue.status === "violation" ? "is-violation" : "is-unknown";
        item.textContent = `${issue.status === "violation" ? "⚠ 위계 경고" : "확인 불가"} · ${issue.course}: ${issue.brief}`;
        prereqList.appendChild(item);
      }
    }
  }

  byId("cloudTeacherEditStudent").addEventListener("change", () => {
    try { renderTeacherEditor(); }
    catch (error) { byId("cloudTeacherEditMessage").textContent = error.message; }
  });
  byId("cloudTeacherEditChoices").addEventListener("change", (event) => {
    const student = teacherEdit?.entries.find((entry) => entry.id === byId("cloudTeacherEditStudent").value);
    if (event.target && student?.lockedSelections?.includes(event.target.value)) event.target.checked = true;
    try {
      validateUniqueApplicationCourses([...byId("cloudTeacherEditChoices").querySelectorAll("input:checked")].map((box) => box.value));
    } catch (error) {
      if (event.target?.checked) event.target.checked = false;
      byId("cloudTeacherEditMessage").textContent = error.message;
    }
    updateTeacherEditSummary();
  });
  byId("cloudTeacherEditClose").addEventListener("click", () => byId("cloudTeacherEditDialog").close());
  byId("cloudTeacherEditSearch").addEventListener("input", filterTeacherEditStudents);
  byId("cloudTeacherEditDialog").addEventListener("close", () => {
    teacherEdit = null;
    byId("cloudTeacherEditChoices").replaceChildren();
    byId("cloudTeacherEditStudent").replaceChildren();
  });
  byId("cloudTeacherEditForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (teacherEditBusy) return;
    teacherEditBusy = true;
    const editor = teacherEdit;
    const select = byId("cloudTeacherEditStudent");
    const controls = [select, byId("cloudTeacherEditSave"), ...byId("cloudTeacherEditChoices").querySelectorAll("input")];
    controls.forEach((control) => { control.disabled = true; });
    let saved = false;
    try {
      if (!editor) throw new Error("학생 선택 창을 다시 여세요.");
      const student = editor.entries.find((entry) => entry.id === select.value);
      if (!student) throw new Error("학생을 선택하세요.");
      const selected = [...byId("cloudTeacherEditChoices").querySelectorAll("input:checked")].map((box) => box.value);
      validateUniqueApplicationCourses(selected);
      if (student.reselectionAllowed === false) throw new Error("폐강 과목 신청 학생만 재선택할 수 있습니다.");
      if (student.lockedSelections?.some((name) => !selected.includes(name))) throw new Error("기존 개설 과목은 변경할 수 없습니다.");
      if (!selected.length) throw new Error("과목을 1개 이상 선택하세요.");
      for (const fieldset of byId("cloudTeacherEditChoices").children) {
        if (fieldset.dataset.count !== undefined &&
          fieldset.querySelectorAll("input:checked").length !== Number(fieldset.dataset.count)) {
          throw new Error(`${fieldset.querySelector("legend").textContent} · 선택 수를 맞추세요.`);
        }
      }
      byId("cloudTeacherEditMessage").textContent = "저장 중…";
      await rpc("save_teacher_course_application", {
        p_event: editor.eventId, p_student: student.id, p_selections: selected,
        p_previous_selections: student.selections, p_previous_submitted_at: student.submittedAt
      }, true);
      saved = true;
      if (teacherEdit === editor) {
        byId("cloudTeacherEditMessage").textContent = "학생 선택 과목을 변경했습니다.";
        byId("cloudTeacherEditDialog").close();
      }
      window.showAppToast?.("학생 선택 과목을 변경했습니다.");
      await syncLinkedResults();
      byId("cloudTeacherMessage").textContent = "학생 선택 과목을 변경하고 연동 집계표를 갱신했습니다.";
    } catch (error) {
      const message = saved ? `서버 저장 완료 · 집계표 갱신 실패: ${error.message}` : error.message;
      if (teacherEdit === editor) byId("cloudTeacherEditMessage").textContent = message;
      byId("cloudTeacherMessage").textContent = message;
      window.showAppToast?.(message, "error");
    } finally {
      teacherEditBusy = false;
      controls.forEach((control) => { control.disabled = false; });
      if (teacherEdit === editor) updateTeacherEditSummary();
    }
  });

  updateApplicationGradeControls = () => {
    const grade = state.applicationMenuGrade || "1";
    const year = byId("schoolYear").value;
    if (grade !== controlsGrade || year !== controlsYear) {
      gradeDrafts.set(`${controlsYear}:${controlsGrade}`, { roster: pendingRoster, codes: latestCodes, summary: byId("cloudRosterSummary").textContent });
      const draft = gradeDrafts.get(`${year}:${grade}`);
      pendingRoster = draft?.roster || null;
      latestCodes = draft?.codes || null;
      byId("cloudRosterSummary").textContent = draft?.summary || `현재 ${grade}학년 명렬을 업로드하세요.`;
      byId("cloudTeacherMessage").textContent = "";
      controlsGrade = grade;
      controlsYear = year;
    }
    byId("cloudCreateEvent").disabled = !pendingRoster || !session;
    byId("cloudDownloadCodes").disabled = !latestCodes;
    byId("cloudSendTestBot").disabled = !latestCodes;
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
      // 이동 전에 작업 자료 저장을 끝내 두어 '사이트에서 나가시겠습니까?'가 뜨지 않게 한다(app.js).
      if (typeof prepareWorkspaceNavigation === "function") await prepareWorkspaceNavigation();
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
    const uploadGrade = String(state.applicationMenuGrade || "1");
    const uploadYear = byId("schoolYear").value;
    teacherAction(async () => {
      pendingRoster = null;
      byId("cloudCreateEvent").disabled = true;
      byId("cloudRosterSummary").textContent = "선택한 명렬을 확인합니다. 실패하면 명렬을 다시 업로드하세요.";
      if (!session) throw new Error("교사 로그인이 필요합니다.");
      if (!file.name.toLowerCase().endsWith(".xlsx")) throw new Error("학생 명렬은 .xlsx 형식이어야 합니다.");
      const allRoster = parseApplicationRoster(await parseWorkbook(await file.arrayBuffer()));
      const currentGrade = String(state.applicationMenuGrade || "1");
      if (currentGrade !== uploadGrade || byId("schoolYear").value !== uploadYear) {
        throw new Error("파일을 읽는 중 학년 메뉴 또는 학년도가 바뀌었습니다. 해당 학년에서 다시 업로드하세요.");
      }
      const roster = validateApplicationRosterGrade(allRoster, currentGrade);
      const grades = [...new Set(roster.map((student) => String(Number(student.grade) + 1)))].sort();
      const subjects = getGroupedApplicationSubjects();
      if (!subjects) throw new Error("1단계에서 편제표를 먼저 불러오세요.");
      for (const grade of grades) {
        if (!subjects[grade]?.length) throw new Error(`${grade}학년 학생선택교육과정 과목을 찾지 못했습니다. 편제표를 확인하세요.`);
      }
      setApplicationTargetGrades(grades);
      pendingRoster = roster;
      byId("cloudCreateEvent").disabled = false;
      byId("cloudRosterSummary").textContent = `${file.name} · 현재 ${currentGrade}학년 ${roster.length}명 · 신청 대상: ${grades.map((g) => `${g}학년`).join(", ")}만`;
      // 명렬을 올린 탭(온라인 신청 관리)에 그대로 둔다: 다른 탭으로 옮기면 바로 아래 '수강신청 생성' 단추가 숨는다.
      byId("cloudTeacherMessage").textContent = "명렬을 확인했습니다. ① 과목·그룹 확인 탭에서 그룹·선택 수를 확인한 뒤 아래 '수강신청 생성'을 누르세요.";
      byId("courseGroupMessage").textContent = `명렬 기준 ${grades.map((g) => `${g}학년`).join(", ")} 그룹만 설정하세요. 설정 후 온라인 신청 관리 탭에서 신청을 생성합니다.`;
    });
  });
  // 지금 편제표·선택 그룹으로 수강신청 생성 자료를 만든다(일반 생성과 수강신청 자동 테스트가 함께 쓴다).
  function applicationSetup(roster, schoolName) {
    const allSubjects = getGroupedApplicationSubjects();
    if (!allSubjects) throw new Error("1단계에서 편제표를 먼저 불러오세요.");
    const grades = [...new Set(roster.map((student) => String(Number(student.grade) + 1)))];
    const subjects = { "1": [], "2": [], "3": [] };
    for (const grade of grades) subjects[grade] = allSubjects[grade] || [];
    const setup = {
      type: "course-application-setup",
      schoolName, schoolYear: byId("schoolYear").value.trim(),
      round: state.currentRound, subjects,
      groups: getCourseApplicationGroups(grades),
      roster,
    };
    for (const student of setup.roster) {
      const targetGrade = String(Number(student.grade) + 1);
      if (!subjects[targetGrade]?.length) {
        throw new Error(`현재 ${student.grade}학년이 신청할 ${targetGrade}학년 학생선택교육과정 과목을 찾지 못했습니다. 1단계 편제표의 교육과정 구분과 ${targetGrade}학년 학기 시수를 확인하세요.`);
      }
    }
    // 위계 규칙·학기 지정 학점 등 학생 화면 점검 정보를 기존 subjects·groups jsonb에 싣는다(course-checks.js).
    if (typeof courseCheckAttachToSetup === "function") courseCheckAttachToSetup(setup);
    return setup;
  }
  byId("cloudCreateEvent").addEventListener("click", () => {
    teacherAction(async () => {
      if (!session) throw new Error("교사 로그인이 필요합니다.");
      if (Number(state.currentRound) > 1) throw new Error("2차 이후는 아래 ‘다음 차수 수강신청 생성’에서 재선택 방식을 지정하세요.");
      if (!pendingRoster) throw new Error("학생 명렬을 먼저 업로드하세요.");
      validateApplicationRosterGrade(pendingRoster, state.applicationMenuGrade || "1");
      if (latestCodes && !window.confirm("이전에 생성한 학생 코드를 저장했나요? 새 신청을 생성하면 이전 코드 다운로드 버튼은 대체됩니다.")) {
        byId("cloudTeacherMessage").textContent = "생성을 취소했습니다. 이전 코드를 먼저 저장하세요.";
        return;
      }
      const setup = applicationSetup(pendingRoster, byId("schoolName").value.trim());
      latestCodes = await rpc("create_course_event", { p_setup: setup }, true);
      latestCodesMeta = { schoolName: setup.schoolName, schoolYear: setup.schoolYear, round: String(setup.round) };
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
  byId("cloudCreateRetake").addEventListener("click", () => teacherAction(async () => {
    const source = knownEvents.find((event) => event.id === byId("cloudRetakeSource").value);
    if (!source) throw new Error("이전 차수 신청을 선택하세요.");
    if (source.is_open) throw new Error("이전 차수 신청을 먼저 마감하세요.");
    if (latestCodes && !window.confirm("기존 학생 코드를 저장했나요? 다음 차수의 새 코드를 발급합니다.")) return;
    if (typeof syncActiveRound === "function") syncActiveRound();
    const data = state.rounds?.[String(source.round)];
    if (!data) throw new Error("이전 차수를 집계표에 연동한 뒤 폐강을 확정하세요.");
    const closed = retakeClosedSubjects(source);
    if (!closed.length) throw new Error("선택한 이전 차수의 과목을 집계표에서 폐강으로 확정하세요.");
    const mode = byId("cloudRetakeMode").value;
    latestCodes = await rpc("create_next_course_event", {p_source:source.id,p_closed:closed,p_mode:mode}, true);
    latestCodesMeta = { schoolName: source.school_name, schoolYear: String(source.school_year), round: String(Number(source.round) + 1) };
    downloadDataWorkbook(latestCodes, "codes", "학생별_신청코드.xlsx");
    byId("cloudTeacherMessage").textContent = `${Number(source.round)+1}차 신청 생성 완료 · ${mode === "all" ? "전체 학생 재선택" : `폐강 신청 학생 ${latestCodes.affectedCount}명만 대체 선택 · 나머지 학생 결과 유지`}. 새 신청 코드를 저장하세요.`;
    try {
      await refreshEvents();
      const created = knownEvents.find((event) => event.id === latestCodes.id);
      if (!created) throw new Error("생성한 신청을 목록에서 찾지 못했습니다.");
      await linkEvent(created);
      await refreshEvents();
    } catch (error) {
      byId("cloudTeacherMessage").textContent += ` 신청은 생성되었습니다. 목록·연동 갱신 실패: ${error.message}. 중복 생성하지 말고 목록을 새로고침하세요.`;
    }
  }));
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

  function baseApplicationSubject(name) {
    return String(name).replace(/\s*\([12]학기\)/g, "").replace(/\s+/g, " ").trim();
  }
  function validateUniqueApplicationCourses(names) {
    const seen = new Set();
    for (const name of names) {
      const base = baseApplicationSubject(name);
      if (seen.has(base)) throw new Error(`${base}: 1학기와 2학기에 같은 과목을 중복 신청할 수 없습니다.`);
      seen.add(base);
    }
  }

  function renderStudentApplication(data) {
    studentSemesterIndex = 0;
    studentSaved = false;
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
          box.checked = data.selections.includes(subject); box.disabled = !data.open || data.lockedSelections?.includes(subject);
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
      box.disabled = !data.open || data.lockedSelections?.includes(course.subject);
      label.append(box, document.createTextNode(`${applicationCourseLabel(course)} · ${course.credit}학점`));
      semesters.get(semester).appendChild(label);
    }
    }
    studentSemesters = [...new Set([...choices.children].map((fieldset) => fieldset.dataset.semester))]
      .sort((a, b) => (a === "0" ? 9 : Number(a)) - (b === "0" ? 9 : Number(b)));
    if (typeof courseCheckStudentRender === "function") courseCheckStudentRender(data, { preview: previewMode });
    updateStudentSemester();
    updateSummary();
    updateStudentProgress();
    byId("cloudStudentMessage").textContent = data.reselectionAllowed === false ? "재선택 대상이 아닙니다. 기존 신청은 그대로 유지됩니다."
      : data.lockedSelections?.length ? "기존 개설 과목은 유지됩니다. 폐강 과목을 대체할 과목만 선택하세요."
      : !data.open ? "접수가 마감되었습니다. 기존 신청만 확인할 수 있습니다."
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
    updateStudentProgress();
  }
  function updateStudentProgress() {
    const progress = byId("cloudStudentProgress");
    if (!progress) return;
    const current = studentSaved ? 3 : application ? 2 : 1;
    for (const item of progress.children) {
      const step = Number(item.dataset.progressStep);
      item.classList[step < current ? "add" : "remove"]("is-complete");
      item.classList[step === current ? "add" : "remove"]("is-current");
      item.setAttribute("aria-current", step === current ? "step" : "false");
    }
    const selectionStep = [...progress.children].find((item) => Number(item.dataset.progressStep) === 2)?.children[1];
    if (selectionStep && studentSemesters.length > 1) {
      selectionStep.textContent = `과목 선택 · ${studentSemesterIndex + 1}/${studentSemesters.length}학기`;
    }
  }
  function validateStudentSemester() {
    if (!application.open) return;
    validateUniqueApplicationCourses([...byId("cloudStudentChoices").querySelectorAll("input:checked")].map((box) => box.value));
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
    for (const box of byId("cloudStudentChoices").querySelectorAll("input")) {
      box.disabled = !application.open || !!application.lockedSelections?.includes(box.value);
    }
    for (const fieldset of byId("cloudStudentChoices").querySelectorAll("fieldset[data-group]")) {
      const count = fieldset.querySelectorAll("input:checked").length;
      const group = application.groups.find((g) => g.id === fieldset.dataset.group);
      fieldset.querySelector("legend").textContent = `${fieldset.dataset.semester === "0" ? "" : fieldset.dataset.semester+"학기 · "}${group.name} · ${count}/${group.count}과목 선택`;
      for (const box of fieldset.querySelectorAll("input")) {
        box.disabled = !application.open || application.lockedSelections?.includes(box.value) ||
          (!box.checked && (count >= Number(group.count) ||
            selected.some((chosen) => baseApplicationSubject(chosen.value) === baseApplicationSubject(box.value))));
      }
    }
    for (const box of byId("cloudStudentChoices").querySelectorAll("input")) {
      if (!box.checked && selected.some((chosen) => baseApplicationSubject(chosen.value) === baseApplicationSubject(box.value))) box.disabled = true;
    }
    if (typeof courseCheckStudentUpdate === "function") courseCheckStudentUpdate();
  }
  byId("cloudStudentChoices").addEventListener("change", (event) => {
    studentSaved = false;
    const box = event.target;
    if (box?.checked) {
      try {
        validateUniqueApplicationCourses([...byId("cloudStudentChoices").querySelectorAll("input:checked")].map((input) => input.value));
      } catch (error) {
        box.checked = false;
        byId("cloudStudentMessage").textContent = error.message;
      }
    }
    if (box && application.lockedSelections?.includes(box.value)) box.checked = true;
    const fieldset = box?.closest?.("fieldset[data-group]");
    if (fieldset && box.checked && fieldset.querySelectorAll("input:checked").length > Number(fieldset.dataset.count)) {
      box.checked = false;
      byId("cloudStudentMessage").textContent = `이 그룹은 최대 ${fieldset.dataset.count}과목만 선택할 수 있습니다. 기존 선택을 해제한 뒤 변경하세요.`;
    }
    updateSummary();
  });
  let pendingFirstCode = "";
  let pendingIdentity = null;
  let activeIdentity = null;
  function hideStudentChangeCode() {
    pendingFirstCode = "";
    pendingIdentity = null;
    byId("cloudStudentNewCode").value = "";
    byId("cloudStudentNewCodeConfirm").value = "";
    byId("cloudStudentChangeCode").classList.add("hidden");
  }
  function throwIfServerRefused(result) {
    if (result?.error) throw new Error(result.error);
    return result;
  }
  // 6자리 코드는 반·번호(학년이 둘인 신청은 학년도)와 함께 보내 서버가 학생 단위로 확인·잠금한다.
  function studentIdentity() {
    const value = (id) => String(byId(id).value || "").trim().replace(/^0+(?=\d)/, "");
    return {
      p_grade: gradeRequired ? value("cloudStudentGrade") : "",
      p_classroom: value("cloudStudentClassroom"),
      p_number: value("cloudStudentNumber"),
    };
  }
  function sameIdentity(a, b) {
    return !!a && !!b && a.p_grade === b.p_grade && a.p_classroom === b.p_classroom && a.p_number === b.p_number;
  }
  let gradeRequired = false;
  byId("cloudStudentGradeField").classList.add("hidden");
  function showStudentGradeField() {
    gradeRequired = true;
    byId("cloudStudentGradeField").classList.remove("hidden");
  }
  function resetStudentLogin() {
    activeCode = "";
    activeIdentity = null;
    application = null;
    hideStudentChangeCode();
    byId("cloudStudentChoices").replaceChildren();
    byId("cloudStudentCourses").classList.add("hidden");
  }
  byId("cloudStudentCode").addEventListener("input", resetStudentLogin);
  byId("cloudStudentClassroom").addEventListener("input", resetStudentLogin);
  byId("cloudStudentNumber").addEventListener("input", resetStudentLogin);
  byId("cloudStudentGrade").addEventListener("change", resetStudentLogin);
  if (!eventId) byId("cloudStudentIdentityFields").classList.add("hidden");
  else if (validEvent.test(eventId)) {
    rpc("get_course_login_form", { p_event: eventId }).then((form) => {
      if (Array.isArray(form?.grades) && form.grades.length > 1) showStudentGradeField();
    }).catch((error) => {
      if (!activeCode && !studentBusy) byId("cloudStudentMessage").textContent = error.message;
    });
  }
  async function loginStudent() {
    resetStudentLogin();
    const code = byId("cloudStudentCode").value.trim().toLowerCase();
    if (eventId && !validEvent.test(eventId)) throw new Error("학교 신청 링크가 잘못되었습니다.");
    if (eventId ? !/^(\d{6}|[a-f0-9]{32})$/.test(code) : !/^[a-f0-9]{32}$/.test(code)) {
      throw new Error(eventId ? "학교에서 받은 6자리 숫자 코드를 확인하세요." : "6자리 코드는 학교·차수별 신청 링크에서 입력하세요. 기존 긴 코드는 이 입구에서도 사용할 수 있습니다.");
    }
    const identity = eventId && /^\d{6}$/.test(code) ? studentIdentity() : null;
    if (identity) {
      if (!/^\d{1,3}$/.test(identity.p_classroom) || !/^\d{1,3}$/.test(identity.p_number)) {
        throw new Error("반과 번호를 숫자로 입력하세요.");
      }
      if (gradeRequired && !identity.p_grade) throw new Error("현재 학년을 선택하세요.");
    }
    const data = await rpc(identity ? "get_student_course_application" : eventId ? "get_scoped_course_application" : "get_course_application",
      identity ? { p_event: eventId, ...identity, p_code: code } : eventId ? { p_event: eventId, p_code: code } : { p_code: code });
    if (data?.needGrade) showStudentGradeField();
    throwIfServerRefused(data);
    if (byId("cloudStudentCode").value.trim().toLowerCase() !== code || (identity && !sameIdentity(identity, studentIdentity()))) {
      throw new Error("코드가 변경되었습니다. 다시 본인 확인을 해주세요.");
    }
    if (data.mustChangeCode) {
      pendingFirstCode = code;
      pendingIdentity = identity;
      byId("cloudStudentChangeCode").classList.remove("hidden");
      byId("cloudStudentMessage").textContent = `${data.student.grade}학년 ${data.student.classroom}반 ${data.student.number}번 ${data.student.name} · 새 6자리 코드를 정해 주세요.`;
      byId("cloudStudentNewCode").focus?.();
      return;
    }
    application = data;
    activeCode = code;
    activeIdentity = identity;
    renderStudentApplication(data);
  }
  byId("cloudStudentLogin").addEventListener("submit", (event) => {
    event.preventDefault();
    studentAction(loginStudent);
  });
  byId("cloudStudentChangeCode").addEventListener("submit", (event) => {
    event.preventDefault();
    studentAction(async () => {
      const first = pendingFirstCode;
      const identity = pendingIdentity;
      const next = byId("cloudStudentNewCode").value.trim();
      if (!eventId || !first || !identity) throw new Error("처음 받은 코드로 먼저 접속하세요.");
      if (!/^\d{6}$/.test(next)) throw new Error("새 코드는 6자리 숫자여야 합니다.");
      if (next !== byId("cloudStudentNewCodeConfirm").value.trim()) throw new Error("새 코드 두 칸이 서로 다릅니다.");
      if (next === first) throw new Error("받은 코드와 다른 새 코드를 정하세요.");
      const result = throwIfServerRefused(await rpc("change_course_code", { p_event: eventId, ...identity, p_code: first, p_new_code: next }));
      byId("cloudStudentCode").value = next;
      hideStudentChangeCode();
      await loginStudent();
      if (application) byId("cloudStudentMessage").textContent = `${result.message} 새 코드를 잊지 마세요.`;
    });
  });
  byId("cloudStudentApplication").addEventListener("submit", (event) => {
    event.preventDefault();
    studentAction(async () => {
      if (!activeCode || !application?.open) throw new Error("본인 확인 및 접수 상태를 확인하세요.");
      if (studentSemesterIndex < studentSemesters.length - 1) throw new Error("1학기 선택을 완료하고 다음 학기로 이동한 뒤 모든 학기 신청을 저장하세요.");
      const code = activeCode;
      const identity = activeIdentity;
      const selected = [...byId("cloudStudentChoices").querySelectorAll("input:checked")].map((box) => box.value);
      validateUniqueApplicationCourses(selected);
      if (application.lockedSelections?.some((name) => !selected.includes(name))) throw new Error("기존 개설 과목은 변경할 수 없습니다.");
      if (!selected.length) throw new Error("과목을 1개 이상 선택하세요.");
      for (const group of application.groups || []) {
        const count = selected.filter((name) => group.courses.includes(name)).length;
        if (count !== group.count) throw new Error(`${group.name}: 정확히 ${group.count}과목을 선택하세요 (현재 ${count}개).`);
      }
      // 위계(선이수)는 경고만 한다: 저장을 막지 않고 저장 안내에 경고를 덧붙인다.
      const prerequisiteNote = typeof courseCheckStudentSaveNote === "function" ? courseCheckStudentSaveNote(selected) : "";
      if (previewMode) {
        byId("cloudStudentMessage").textContent = `미리보기 제출 완료 · 실제 신청은 저장되지 않습니다.${prerequisiteNote}`;
        window.showAppToast?.("미리보기 제출을 확인했습니다. 실제 신청은 저장되지 않았습니다.");
        return;
      }
      const result = throwIfServerRefused(identity
        ? await rpc("save_student_course_application", { p_event: eventId, ...identity, p_code: code, p_selections: selected })
        : eventId
          ? await rpc("save_scoped_course_application", { p_event: eventId, p_code: code, p_selections: selected })
          : await rpc("save_course_application", { p_code: code, p_selections: selected }));
      if (activeCode === code) {
        byId("cloudStudentMessage").textContent = `${result.message}${prerequisiteNote}`;
        studentSaved = true;
        updateStudentProgress();
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
        <p>QR코드를 스캔하거나 아래 학교·차수 신청 주소로 접속하여 본인의 반·번호와 코드를 입력하세요. 처음 접속하면 새 6자리 코드로 바꿔야 합니다.</p>
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
  // ---------- 수강신청 테스트봇 연결 ----------
  // 학생 코드는 저장소·주소에 남기지 않고, 내가 연 봇 창에 postMessage로만 보낸다(test-bot-bridge.js 참고).
  // 봇은 같은 연결로 교사 화면 대조(신청 현황·잠금 현황)와 자동 테스트 신청의 정리(닫기·삭제)를 요청할 수 있다.
  const bridge = typeof TestBotBridge !== "undefined" ? TestBotBridge : null;
  let testBot = null;
  const testEvents = new Set();
  // 교사 로그인이 끝나 이 창에서 다시 로그인하면(구글 로그인으로 페이지가 다시 열림) 봇 창과의 연결이 끊긴다.
  // 다시 연결할 수 있게 이 탭의 sessionStorage에 연결 확인값(nonce)·자동 테스트 신청 id·생성 설정만 둔다(학생 코드는 두지 않음).
  const TEST_BOT_LINK_KEY = "curriculum-test-bot-link-v1";
  function saveTestBotLink() {
    try {
      if (!testBot) return;
      sessionStorage.setItem(TEST_BOT_LINK_KEY, JSON.stringify({
        nonce: testBot.nonce, eventId: testBot.eventId || "", eventIds: [...testEvents], autoSetup: testBot.autoSetup || null,
      }));
    } catch { /* 저장하지 못하면 다시 연결만 안 될 뿐이다. */ }
  }
  const savedTestBotLink = (() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(TEST_BOT_LINK_KEY) || "null");
      if (!saved || !/^[a-f0-9]{32}$/.test(String(saved.nonce || ""))) return null;
      const ids = Array.isArray(saved.eventIds) ? saved.eventIds.filter((id) => validEvent.test(String(id))) : [];
      const setup = saved.autoSetup && typeof saved.autoSetup === "object" ? {
        grade: String(saved.autoSetup.grade || "1"), classes: Number(saved.autoSetup.classes) || 1, perClass: Number(saved.autoSetup.perClass) || 1,
        createsLeft: Math.max(0, Math.min(40, Number(saved.autoSetup.createsLeft) || 0)),
      } : null;
      for (const id of ids) testEvents.add(id);
      return { nonce: saved.nonce, eventId: validEvent.test(String(saved.eventId || "")) ? saved.eventId : "", autoSetup: setup };
    } catch { return null; }
  })();
  function testBotOpen() {
    return !!testBot?.window && !testBot.window.closed;
  }
  function postToTestBot(message) {
    if (!testBotOpen() || !bridge) return false;
    testBot.window.postMessage({ ...message, nonce: testBot.nonce }, bridge.targetOrigin(window.location));
    return true;
  }
  function sendTestBotPayload() {
    if (!testBot?.ready) return;
    if (testBot.payload) postToTestBot({ type: bridge.CODES, payload: testBot.payload });
    else if (testBot.status) postToTestBot({ type: bridge.STATUS, ...testBot.status });
  }
  // 앱 쪽 진행 안내. 봇 창이 아직 준비 전이면 준비 신호를 받을 때 보낸다.
  function testBotStatus(message, failed = false) {
    if (!testBot) return;
    testBot.status = { message, failed };
    sendTestBotPayload();
  }
  // 봇 창을 연다(이미 열려 있으면 그 창을 쓴다). 팝업 차단을 피하려고 단추를 누른 그 순간에 부른다.
  function openTestBotWindow() {
    if (!bridge) throw new Error("테스트봇 연결 파일(test-bot-bridge.js)을 불러오지 못했습니다. 페이지를 새로고침하세요.");
    if (testBotOpen()) {
      testBot.window.focus?.();
      return testBot;
    }
    const nonce = bridge.createNonce(crypto);
    const url = new URL("test-bot.html", window.location.href);
    url.search = "";
    url.hash = new URLSearchParams({ bridge: nonce }).toString();
    const opened = window.open(url.href, "_blank");
    if (!opened) throw new Error("테스트봇 창이 팝업 차단으로 열리지 않았습니다. 이 사이트의 팝업을 허용한 뒤 다시 누르세요.");
    testBot = { window: opened, nonce, ready: false, payload: null, eventId: "", autoSetup: null };
    saveTestBotLink();
    return testBot;
  }
  function deliverToTestBot(payload) {
    testBot.payload = payload;
    testBot.eventId = payload.eventId;
    saveTestBotLink();
    sendTestBotPayload();
  }
  // 학생별 코드 재발급: 봇 창이 같은 신청을 받고 있으면 그 학생 코드만 갱신해 보낸다.
  function forwardReissuedCode(event, issued) {
    const sameStudent = (student) => (student.id && student.id === issued.id) ||
      (String(student.grade) === String(issued.grade) && String(student.classroom) === String(issued.classroom) &&
        String(student.number) === String(issued.number));
    if (latestCodes?.id === event.id) {
      latestCodes = { ...latestCodes, students: latestCodes.students.map((student) => sameStudent(student) ? { ...student, ...issued } : student) };
    }
    if (!bridge || !testBotOpen() || testBot.payload?.eventId !== event.id) return false;
    const update = bridge.buildPayload({ id: event.id, students: [issued] }, testBot.payload, testBot.payload.link, true);
    testBot.payload = bridge.mergePayload(testBot.payload, bridge.validatePayload(update));
    if (testBot.ready) postToTestBot({ type: bridge.CODES, payload: update });
    return true;
  }
  byId("cloudSendTestBot").addEventListener("click", () => {
    try {
      if (!latestCodes?.id) throw new Error("보낼 학생 코드가 없습니다. 수강신청을 만들거나 코드를 재발급하세요.");
      if (!window.confirm("테스트용 수강신청에만 쓰세요. 학생 코드가 테스트봇 창으로 전달됩니다. 보낼까요?")) return;
      openTestBotWindow();
      deliverToTestBot({ ...bridge.buildPayload(latestCodes, latestCodesMeta || {}, eventLink(latestCodes.id)),
        testEvent: testEvents.has(latestCodes.id) });
      byId("cloudTeacherMessage").textContent = `테스트봇 창으로 학생 ${latestCodes.students.length}명의 코드를 보냈습니다. 봇 화면에서 실행 설정을 확인하세요.`;
    } catch (error) { byId("cloudTeacherMessage").textContent = error.message; }
  });

  // 수강신청 자동 테스트: [테스트] 신청 생성 → 봇 창에 코드 전달 → 봇이 바로 가상 학생 신청·교사 화면 대조·정리까지 진행.
  function virtualRoster(grade, classes, perClass) {
    const surnames = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임", "한", "오", "서", "신", "권"];
    const roster = [];
    for (let classroom = 1; classroom <= classes; classroom++) {
      for (let number = 1; number <= perClass; number++) {
        roster.push({ grade, classroom: String(classroom), number: String(number),
          name: `${surnames[(classroom * 7 + number) % surnames.length]}가상${String(number).padStart(2, "0")}` });
      }
    }
    return roster;
  }
  byId("cloudAutoTest").addEventListener("click", () => {
    if (!session) {
      byId("cloudTeacherMessage").textContent = "수강신청 자동 테스트는 교사 로그인 후 이용하세요.";
      return;
    }
    const grade = String(state.applicationMenuGrade || "1");
    byId("testBotAutoMessage").textContent = "";
    updateAutoRepeatNote();
    // 2차 이상 차수도 자동 테스트를 허용한다([테스트] 신청이라 실제 차수 자료와 무관). 확인 창에 몇 차 테스트인지 드러낸다.
    byId("testBotAutoSummary").textContent = `${state.currentRound}차 테스트 · ${byId("schoolYear").value}학년도 · 현 ${grade}학년 → ${Number(grade) + 1}학년 과목 · 학교명 '[테스트] ${byId("schoolName").value.trim().replace(/^\[테스트\]\s*/, "") || "학교"}'` +
      (Number(state.currentRound) > 1 ? ` · [테스트] 신청이라 실제 ${state.currentRound}차 결과와 무관합니다.` : "");
    byId("testBotAutoDialog").showModal();
  });
  byId("testBotAutoCancel").addEventListener("click", () => byId("testBotAutoDialog").close());
  // 반복 설정 안내: 회차마다 새 수강신청이면 회차마다 닫고 삭제한다는 것을 시작 전에 알린다.
  function updateAutoRepeatNote() {
    const count = Number(byId("testBotAutoRepeat").value);
    const fresh = byId("testBotAutoFresh").checked;
    const note = byId("testBotAutoRepeatNote");
    note.textContent = !Number.isInteger(count) || count < 1 || count > 20 ? "반복 횟수는 1~20 사이 정수로 입력하세요."
      : fresh ? `주의: 회차마다 [테스트] 수강신청을 새로 만들어 가상 학생 신청·교사 화면 대조를 한 뒤, 회차가 끝나면 그 신청을 닫고 삭제합니다(테스트봇의 정리 설정과 관계없이 ${count}회 모두). 테스트 신청이 쌓이지 않습니다.`
        : count === 1 ? "테스트 수강신청을 한 번 만들고 가상 학생 신청 과정을 1회 진행합니다."
          : `테스트 수강신청은 한 번만 만들고, 2회차부터 가상 학생이 바뀐 코드로 다시 접속해 새 선택으로 재신청하는 과정을 모두 ${count}회 진행합니다. 회차마다 교사 화면과 대조하고, 정리는 마지막 회차 뒤 한 번 합니다.`;
  }
  byId("testBotAutoRepeat").addEventListener("input", updateAutoRepeatNote);
  byId("testBotAutoFresh").addEventListener("change", updateAutoRepeatNote);
  byId("testBotAutoStart").addEventListener("click", () => {
    const classes = Number(byId("testBotAutoClasses").value);
    const perClass = Number(byId("testBotAutoPerClass").value);
    const repeatCount = Number(byId("testBotAutoRepeat").value);
    const freshEvent = byId("testBotAutoFresh").checked;
    if (!Number.isInteger(classes) || classes < 1 || classes > 20 || !Number.isInteger(perClass) || perClass < 1 || perClass > 40) {
      byId("testBotAutoMessage").textContent = "반 수는 1~20, 반별 인원은 1~40 사이 정수로 입력하세요.";
      return;
    }
    if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 20) {
      byId("testBotAutoMessage").textContent = "반복 횟수는 1~20 사이 정수로 입력하세요.";
      return;
    }
    let bot;
    try { bot = openTestBotWindow(); } catch (error) { byId("testBotAutoMessage").textContent = error.message; return; }
    byId("testBotAutoDialog").close();
    testBot.payload = null;
    const grade = String(state.applicationMenuGrade || "1");
    const school = testSchoolName();
    // 회차마다 새 수강신청 방식에서 봇이 다음 회차 신청을 요청할 때 같은 설정으로 만든다.
    testBot.autoSetup = { grade, classes, perClass, createsLeft: freshEvent ? repeatCount - 1 : 0 };
    saveTestBotLink();
    testBotStatus("앱에서 테스트 수강신청을 만드는 중입니다…");
    teacherAction(async () => {
      try {
        if (!session) throw new Error("교사 로그인이 필요합니다.");
        const { setup, created, payload } = await createAutoTestEvent(grade, classes, perClass, school);
        if (bot !== testBot) throw new Error("테스트봇 창이 바뀌었습니다. 다시 시도하세요.");
        deliverToTestBot({ ...payload, autoRun: true, testEvent: true, repeat: { count: repeatCount, freshEvent } });
        byId("cloudTeacherMessage").textContent = `테스트 수강신청(${setup.schoolName} ${setup.round}차, 가상 학생 ${created.students.length}명)을 만들고 테스트봇으로 보냈습니다.` +
          `${repeatCount > 1 ? ` 반복 ${repeatCount}회${freshEvent ? "(회차마다 새 신청을 만들고 닫고 삭제)" : ""}.` : ""} 집계표에는 연동하지 않았습니다.`;
        try { await refreshEvents(); } catch { /* 목록 갱신 실패는 테스트 진행과 무관하다. */ }
      } catch (error) {
        testBotStatus(`앱에서 테스트 수강신청을 만들지 못했습니다: ${error.message}`, true);
        throw error;
      }
    });
  });
  function testSchoolName() {
    return byId("schoolName").value.trim().replace(/^\[테스트\]\s*/, "") || "학교";
  }
  // 자동 테스트용 [테스트] 수강신청 만들기(처음 한 번, 또는 회차마다 새 수강신청 방식의 다음 회차).
  async function createAutoTestEvent(grade, classes, perClass, school) {
    const setup = applicationSetup(virtualRoster(grade, classes, perClass), `[테스트] ${school}`);
    const created = await rpc("create_course_event", { p_setup: setup }, true);
    testEvents.add(created.id);
    saveTestBotLink();
    const payload = bridge.buildPayload(created, { schoolName: setup.schoolName, schoolYear: setup.schoolYear, round: String(setup.round) }, eventLink(created.id));
    return { setup, created, payload };
  }
  // 봇의 반복 실행 중 회차 사이에 부른다. 로그인 중이면 무활동 시간을 새로 세고, 토큰이 곧 끝나면 기존 갱신 경로로 갱신한다.
  // 이미 로그아웃되었으면 되살리지 않고 loggedIn:false만 알린다(교사가 다시 로그인해야 이어짐).
  async function keepTeacherSessionForBot() {
    if (!session || expireIfIdle()) return { loggedIn: false };
    lastActivity = Date.now();
    saveSession();
    if (session.expires_at <= Date.now() / 1000 + 120) {
      const revision = sessionRevision;
      const refreshed = await request("/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: session.refresh_token } });
      if (!session || revision !== sessionRevision) return { loggedIn: false };
      setSession(refreshed, Date.now());
    }
    return { loggedIn: true };
  }
  async function answerTestBot(request) {
    const id = request.eventId;
    if (request.action === "session") return keepTeacherSessionForBot();
    if (request.action === "applications") return rpc("get_teacher_course_applications", { p_event: id }, true);
    if (request.action === "locks") return rpc("get_course_code_locks", { p_event: id }, true);
    // 회차마다 새 수강신청: 이 창의 자동 테스트 설정(남은 횟수)으로만 만든다. 직전 회차 신청은 이미 삭제되었을 수 있다.
    if (request.action === "create") {
      const auto = testBot?.autoSetup;
      if (!auto || auto.createsLeft <= 0) throw new Error("회차마다 새 수강신청은 이 창의 ‘수강신청 자동 테스트’로 정한 횟수만큼만 만들 수 있습니다.");
      if (!session) throw new Error("교사 로그인이 필요합니다.");
      auto.createsLeft--;
      saveTestBotLink();
      const { setup, created, payload } = await createAutoTestEvent(auto.grade, auto.classes, auto.perClass, testSchoolName());
      const data = { ...payload, autoRun: false, testEvent: true };
      testBot.payload = data;
      testBot.eventId = created.id;
      saveTestBotLink();
      byId("cloudTeacherMessage").textContent = `테스트봇 요청으로 다음 회차 테스트 수강신청(${setup.schoolName} ${setup.round}차, 가상 학생 ${created.students.length}명)을 새로 만들었습니다.`;
      try { await refreshEvents(); } catch { /* 목록 갱신 실패는 테스트 진행과 무관하다. */ }
      return data;
    }
    if (!testEvents.has(id)) throw new Error("이 창에서 자동 테스트로 만든 [테스트] 수강신청만 닫기·삭제·잠금 해제·반영할 수 있습니다.");
    if (request.action === "close" || request.action === "delete") {
      const result = await rpc("manage_course_event", { p_event: id, p_action: request.action }, true);
      if (request.action === "delete") { testEvents.delete(id); saveTestBotLink(); }
      try { await refreshEvents(); } catch { /* 목록 갱신 실패는 결과와 무관하다. */ }
      return result;
    }
    if (request.action === "unlock") return rpc("unlock_course_event", { p_event: id }, true);
    // import: 테스트 결과를 이 작업 자료의 해당 차수에 연동한다(기본 꺼짐, 봇과 앱 양쪽에서 경고).
    await refreshEvents();
    const known = knownEvents.find((item) => item.id === id);
    if (!known) throw new Error("테스트 수강신청을 목록에서 찾지 못했습니다.");
    if (!window.confirm(`테스트 수강신청 결과를 이 작업 자료의 ${known.round}차에 반영합니다. 같은 차수의 기존 결과가 테스트 결과로 바뀔 수 있습니다. 계속할까요?`)) {
      throw new Error("앱에서 반영을 취소했습니다.");
    }
    await linkEvent(known);
    return { round: String(known.round), students: (state.rounds?.[String(known.round)]?.students || []).length };
  }
  window.addEventListener("message", (event) => {
    if (!bridge) return;
    // 이 창을 다시 연 뒤(교사 다시 로그인 등) 같은 봇 창이 준비 신호를 다시 보내면, 저장해 둔 nonce로 확인하고 다시 연결한다.
    if (!testBot && savedTestBotLink && event.source && bridge.acceptReady(event, { expectedSource: event.source, nonce: savedTestBotLink.nonce, location: window.location })) {
      testBot = { window: event.source, nonce: savedTestBotLink.nonce, ready: true, payload: null,
        eventId: savedTestBotLink.eventId, autoSetup: savedTestBotLink.autoSetup };
      testBot.status = { message: "앱 창이 다시 열려 테스트봇과 다시 연결했습니다.", failed: false };
      sendTestBotPayload();
      return;
    }
    if (!testBot) return;
    const options = { expectedSource: testBot.window, nonce: testBot.nonce, location: window.location };
    if (bridge.acceptReady(event, options)) {
      testBot.ready = true;
      sendTestBotPayload();
      return;
    }
    const request = bridge.acceptTeacherRequest(event, { ...options, eventId: testBot.eventId || testBot.payload?.eventId });
    if (!request) return;
    answerTestBot(request).then(
      (data) => postToTestBot({ type: bridge.TEACHER_RESPONSE, id: request.id, ok: true, data }),
      (error) => postToTestBot({ type: bridge.TEACHER_RESPONSE, id: request.id, ok: false, error: error?.message || "요청 실패" }));
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
