"use strict";
// xlsx-parser.js가 셀 주소("AB12")를 열 번호로 바꿀 때 쓰는 함수. 앱에서는 app.js가 같은 이름으로 정의한다.
function columnIndex(reference) {
  const letters = String(reference).match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "";
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result - 1;
}
// 수강신청 테스트봇 화면. 규칙·계산은 test-bot-core.js, 앱 창과의 연결은 test-bot-bridge.js가 맡는다.
// 학생 코드는 이 창의 메모리에만 둔다(localStorage·IndexedDB·주소에 저장하지 않음). 실행 설정만 저장한다.
(() => {
  const Core = TestBotCore;
  const Bridge = TestBotBridge;
  const byId = (id) => document.getElementById(id);
  const OPTIONS_KEY = "curriculum-test-bot-options-v1";
  const config = typeof CURRICULUM_SUPABASE_CONFIG !== "undefined" ? CURRICULUM_SUPABASE_CONFIG : null;

  // ---------- 탭·도움말 ----------
  const tabs = [["botTabServer", "botServerPanel"], ["botTabLocal", "botLocalPanel"]];
  for (const [tabId, panelId] of tabs) {
    byId(tabId).addEventListener("click", () => {
      for (const [otherTab, otherPanel] of tabs) {
        byId(otherTab).setAttribute("aria-selected", String(otherTab === tabId));
        byId(otherPanel).hidden = otherPanel !== panelId;
      }
    });
  }
  byId("botHelpOpen").addEventListener("click", () => byId("botHelpDialog").showModal());
  byId("botHelpClose").addEventListener("click", () => byId("botHelpDialog").close());

  // ---------- 설정 저장(코드 제외) ----------
  const optionFields = ["botScope", "botScopeCount", "botScopeClasses", "botConcurrency", "botDelay", "botPopularity",
    "botWrongPercent", "botWrongTimes", "botViolationPercent", "botResubmitPercent", "botCleanup", "botTeacherCheck",
    "botRepeat", "botRepeatFresh"];
  function loadOptions() {
    try {
      const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) || "{}");
      for (const id of optionFields) {
        if (!(id in saved)) continue;
        if (byId(id).type === "checkbox") byId(id).checked = !!saved[id];
        else byId(id).value = String(saved[id]);
      }
    } catch { /* 설정을 못 읽으면 기본값으로 둔다. */ }
  }
  function saveOptions() {
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(Object.fromEntries(optionFields.map((id) =>
        [id, byId(id).type === "checkbox" ? byId(id).checked : byId(id).value]))));
    } catch { /* 저장 실패는 실행과 무관하다. */ }
  }
  loadOptions();
  for (const id of optionFields) byId(id).addEventListener("change", saveOptions);
  byId("botImport").addEventListener("change", () => {
    if (byId("botImport").checked && !window.confirm("테스트 결과가 교사의 실제 작업 자료(같은 차수)에 반영됩니다. 기존 결과가 바뀔 수 있습니다. 백업했나요? 켤까요?")) {
      byId("botImport").checked = false;
    }
  });

  function options() {
    const number = (id, min, max, fallback) => {
      const value = Number(byId(id).value);
      return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    };
    return {
      scope: byId("botScope").value, count: number("botScopeCount", 1, 10000, 10), classes: byId("botScopeClasses").value,
      concurrency: Math.floor(number("botConcurrency", 1, 30, 5)), delayMs: number("botDelay", 0, 10000, 0),
      popularity: byId("botPopularity").value,
      wrongCodePercent: number("botWrongPercent", 0, 100, 0), wrongCodeTimes: Math.floor(number("botWrongTimes", 0, 12, 0)),
      violationPercent: number("botViolationPercent", 0, 100, 0), resubmitPercent: number("botResubmitPercent", 0, 100, 0),
      cleanup: byId("botCleanup").value, teacherCheck: byId("botTeacherCheck").checked, importToApp: byId("botImport").checked,
      repeatCount: Math.floor(number("botRepeat", 1, Core.REPEAT_MAX, 1)), repeatFresh: byId("botRepeatFresh").checked,
    };
  }

  // ---------- 대상(앱에서 받음 또는 직접 넣기) ----------
  let source = null; // { eventId, link, schoolName, schoolYear, round, students, from: "app"|"file", testEvent, receivedAt }
  let running = null;
  let lastReport = null;

  function renderSource() {
    const summary = byId("botSourceSummary");
    byId("botRun").disabled = !source || !!running;
    if (!source) { summary.textContent = ""; return; }
    const title = [source.schoolYear && `${source.schoolYear}학년도`, source.schoolName, source.round && `${source.round}차`].filter(Boolean).join(" ");
    summary.className = source.from === "app" ? "bot-received" : "";
    summary.textContent = source.from === "app"
      ? `웹앱에서 받음: ${title || "수강신청"} · 학생 ${source.students.length}명 · 받은 시각 ${source.receivedAt.toLocaleTimeString("ko-KR")}${source.testEvent ? " · 자동 테스트용 [테스트] 신청" : ""}`
      : `코드 파일: 학생 ${source.students.length}명 · 수강신청 ${source.eventId.slice(0, 8)}…`;
  }

  // 앱 창과의 연결. 주소의 #bridge=<nonce>와 window.opener가 있을 때만 쓴다.
  let nonce = Bridge.nonceFromHash(window.location.hash);
  const bridgeOptions = () => ({ expectedSource: window.opener, nonce, location: window.location });
  function appConnected() {
    return !!nonce && !!window.opener && !window.opener.closed;
  }
  // quiet: 교사 로그인을 기다리며 다시 알리는 경우(앱 창이 다시 로그인하며 새로 열렸으면 이 신호로 다시 연결된다).
  function announceReady(quiet = false) {
    if (!appConnected()) return;
    window.opener.postMessage({ type: Bridge.READY, nonce }, Bridge.targetOrigin(window.location));
    if (!quiet) byId("botBridgeStatus").textContent = "앱 창과 연결했습니다. 학생 코드를 기다리는 중…";
  }
  window.addEventListener("hashchange", () => {
    const next = Bridge.nonceFromHash(window.location.hash);
    if (next && next !== nonce) { nonce = next; announceReady(); }
  });
  const pendingRequests = new Map();
  window.addEventListener("message", (event) => {
    if (!nonce) return;
    const payload = Bridge.acceptCodes(event, bridgeOptions());
    if (payload) {
      // 실행 중에는 전체 코드를 다시 받지 않는다(회차 사이에 바뀐 코드가 처음 코드로 되돌아가지 않게). 재발급(일부 학생)만 반영한다.
      if (running && !payload.partial) return;
      const merged = Bridge.mergePayload(source?.from === "app" ? source : null, payload);
      source = { ...merged, from: "app", receivedAt: new Date(), autoCreated: payload.partial ? !!source?.autoCreated : payload.autoRun === true };
      if (payload.repeat && !payload.partial) {
        // 앱 자동 테스트 설정 창에서 정한 반복 설정을 이 창 설정에도 맞춘다.
        byId("botRepeat").value = String(payload.repeat.count);
        byId("botRepeatFresh").checked = payload.repeat.freshEvent;
        saveOptions();
      }
      byId("botBridgeStatus").textContent = payload.partial
        ? `앱에서 재발급한 학생 코드 ${payload.students.length}명을 갱신했습니다.`
        : "앱 창에서 학생 코드를 받았습니다. 코드는 이 창의 메모리에만 있습니다.";
      renderSource();
      if (payload.autoRun && !payload.partial && !running) startRun({ auto: true });
      return;
    }
    const response = Bridge.acceptTeacherResponse(event, bridgeOptions());
    if (response && pendingRequests.has(response.id)) {
      const { resolve, reject, timer } = pendingRequests.get(response.id);
      clearTimeout(timer);
      pendingRequests.delete(response.id);
      if (response.ok) resolve(response.data); else reject(new Error(response.error || "앱에서 요청을 처리하지 못했습니다."));
      return;
    }
    const status = Bridge.accept(event, Bridge.STATUS, bridgeOptions());
    if (status) {
      byId("botBridgeStatus").textContent = String(status.message || "");
      byId("botBridgeStatus").className = status.failed ? "bot-note bot-error" : "bot-note";
    }
  });
  let requestSeq = 0;
  function teacherRequest(action, timeoutMs = 60000, eventId = source?.eventId) {
    if (!appConnected()) return Promise.reject(new Error("앱 창이 닫혀 교사 화면 요청을 보낼 수 없습니다."));
    const id = `r${++requestSeq}-${Date.now().toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error("앱 창이 응답하지 않습니다(교사 로그인 만료 또는 창 닫힘)."));
      }, timeoutMs);
      pendingRequests.set(id, { resolve, reject, timer });
      window.opener.postMessage({ type: Bridge.TEACHER_REQUEST, nonce, id, action, eventId }, Bridge.targetOrigin(window.location));
    });
  }
  announceReady();

  // 직접 넣기: 학생 신청 링크 + 학생별_신청코드.xlsx
  let fileCodes = null;
  function applyManualSource() {
    const status = byId("botSourceSummary");
    try {
      if (!fileCodes) return;
      const typed = byId("botEventInput").value.trim();
      const eventId = typed ? Core.parseEventInput(typed) : fileCodes.eventId;
      if (eventId !== fileCodes.eventId) throw new Error("링크의 수강신청과 코드 파일의 신청ID가 다릅니다. 같은 수강신청의 링크·파일인지 확인하세요.");
      source = { eventId, link: typed, schoolName: "", schoolYear: "", round: "", students: fileCodes.students, from: "file", receivedAt: new Date() };
      renderSource();
    } catch (error) {
      source = null;
      renderSource();
      status.className = "bot-error";
      status.textContent = error.message;
    }
  }
  byId("botCodeFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      fileCodes = Core.parseCodeSheets(await parseWorkbook(await file.arrayBuffer()));
      applyManualSource();
    } catch (error) {
      fileCodes = null;
      byId("botSourceSummary").className = "bot-error";
      byId("botSourceSummary").textContent = error.message;
    }
  });
  byId("botEventInput").addEventListener("change", applyManualSource);

  // ---------- 실행 ----------
  // 회차 반복·단계 진행은 Core.runRepeatedTest가 하고, 여기서는 화면 표시·확인 창·앱 창 요청만 맡는다.
  const STEP_LABELS = { pending: "대기", running: "진행 중", pass: "통과", fail: "실패", skip: "건너뜀" };
  function renderSteps(round) {
    const marks = { pending: "·", running: "…", pass: "✓", fail: "✗", skip: "–" };
    byId("botChecklistTitle").textContent = round ? `${round.round}/${round.total}회차 단계` : "단계";
    byId("botChecklist").replaceChildren(...(round?.steps || []).map((step) => {
      const item = document.createElement("li");
      item.dataset.status = step.status;
      item.dataset.step = step.key;
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent = marks[step.status];
      mark.setAttribute("aria-label", STEP_LABELS[step.status]);
      const title = document.createElement("span");
      title.textContent = `${step.name} · ${STEP_LABELS[step.status]}${step.ms ? ` · ${(step.ms / 1000).toFixed(1)}초` : ""}`;
      item.append(mark, title);
      if (step.expected || step.actual) {
        const detail = document.createElement("small");
        detail.textContent = [step.expected && `기대: ${step.expected}`, step.actual && `실제: ${step.actual}`].filter(Boolean).join(" / ");
        item.appendChild(detail);
      }
      return item;
    }));
  }

  function renderStats(records) {
    const summary = Core.summarize(records);
    const cells = [["대상", summary.total], ["성공", summary.ok], ["실패", summary.failed], ["잠김 확인", summary.locked],
      // 재신청 대상이 아닌 학생(서버가 접수를 닫아 둠)은 실패가 아니라 따로 센다.
      ...(summary.skipped ? [["대상 아님", summary.skipped]] : []), ["코드 변경", summary.codeChanged],
      ["요청 수", summary.requests], ["평균 응답", `${summary.averageMs}ms`], ["최대 응답", `${summary.maxMs}ms`],
      ["위반 거절", summary.violationsRefused],
      // 위계(선이수) 위반 시도는 경고만이라 저장되는 것이 정상이다.
      ...(summary.prerequisiteSaved || summary.prerequisiteRefused ? [["위계 경고 저장", summary.prerequisiteSaved]] : [])];
    byId("botStats").replaceChildren(...cells.map(([label, value]) => {
      const box = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = String(value);
      box.append(strong, document.createTextNode(label));
      box.dataset.stat = label;
      return box;
    }));
    const reasons = byId("botReasons");
    reasons.replaceChildren();
    if (summary.reasons.length) {
      const table = document.createElement("table");
      table.className = "bot-table";
      table.innerHTML = "<caption>실패 사유별 학생 수(이번 회차)</caption><thead><tr><th>사유</th><th>학생 수</th></tr></thead>";
      const body = document.createElement("tbody");
      for (const [reason, count] of summary.reasons) {
        const row = body.insertRow();
        row.insertCell().textContent = reason;
        row.insertCell().textContent = String(count);
      }
      table.appendChild(body);
      reasons.appendChild(table);
    }
    return summary;
  }
  function renderRecord(record) {
    const row = document.createElement("tr");
    if (!record.ok && record.status !== "잠김 확인" && !record.skipped) row.className = "is-failed";
    for (const value of [`${record.round || 1}회차`, `${record.grade}-${record.classroom}-${record.number} ${record.name}`, record.status, record.newCode,
      record.selections.join(", "), record.notes.join(" / "), record.failure]) {
      row.insertCell().textContent = value || "";
    }
    byId("botResults").appendChild(row);
  }
  // 회차별 표 + 합계 + 회차 사이 변화.
  function renderRounds(report) {
    const box = byId("botRounds");
    box.replaceChildren();
    if (!report?.rounds.length) return;
    const { rows, totals, trends } = Core.repeatSummary(report);
    const table = document.createElement("table");
    table.className = "bot-table bot-round-table";
    table.id = "botRoundTable";
    const caption = document.createElement("caption");
    caption.textContent = `회차별 결과 · ${report.repeat.count}회 반복 · ${report.repeat.freshEvent ? "회차마다 새 수강신청(회차마다 닫고 삭제)" : "같은 수강신청에서 재신청"}`;
    table.appendChild(caption);
    const head = table.createTHead().insertRow();
    for (const label of ["회차", "결과", "대상", "성공", "실패", "잠김", "대상 아님", "위반 거절", "대조 불일치", "평균 응답", "최대 응답"]) {
      const cell = document.createElement("th");
      cell.textContent = label;
      head.appendChild(cell);
    }
    const body = table.createTBody();
    const line = (row, label, status, className = "") => {
      const tr = body.insertRow();
      if (className) tr.className = className;
      for (const value of [label, status, row.targets, row.ok, row.failed, row.locked, row.skipped || 0, row.violationsRefused,
        row.mismatches === null ? "대조 안 함" : row.mismatches, `${row.averageMs}ms`, `${row.maxMs}ms`]) {
        tr.insertCell().textContent = String(value);
      }
      return tr;
    };
    for (const row of rows) {
      const tr = line(row, `${row.round}회차`, row.status, row.failedSteps || row.stopped ? "is-failed" : "");
      tr.dataset.round = String(row.round);
    }
    if (rows.length > 1 || report.rounds[0]?.status !== "running") {
      line(totals, `합계(끝난 ${totals.rounds}회차)`, totals.failedSteps ? `실패 단계 ${totals.failedSteps}개` : "통과", "bot-total-row");
    }
    box.appendChild(table);
    const notes = [...trends, ...(report.notes || [])];
    if (notes.length) {
      const title = document.createElement("p");
      title.className = "bot-note";
      title.textContent = "회차 사이 변화";
      const list = document.createElement("ul");
      list.id = "botRoundTrends";
      for (const note of notes) {
        const item = document.createElement("li");
        item.textContent = note;
        list.appendChild(item);
      }
      box.append(title, list);
    }
  }

  function waitForConfirm(info) {
    return new Promise((resolve) => {
      const dialog = byId("botConfirmDialog");
      byId("botConfirmEvent").textContent = info;
      byId("botConfirmInput").value = "";
      byId("botConfirmRun").disabled = true;
      const finish = (value) => {
        byId("botConfirmRun").onclick = byId("botConfirmCancel").onclick = null;
        dialog.close();
        resolve(value);
      };
      byId("botConfirmRun").onclick = () => finish(true);
      byId("botConfirmCancel").onclick = () => finish(false);
      dialog.addEventListener("cancel", () => finish(false), { once: true });
      dialog.showModal();
    });
  }
  byId("botConfirmInput").addEventListener("input", () => {
    byId("botConfirmRun").disabled = byId("botConfirmInput").value.trim() !== "테스트";
  });
  // 끝 정리 확인 창. 앱이 자동 테스트로 만든 [테스트] 신청은 기본 선택이 '닫고 삭제', 그 밖의 신청은 '닫기만'.
  // Esc(취소)는 언제나 지우지 않는 '닫기만'.
  function askCleanup({ testEvent = true, round = "" } = {}) {
    return new Promise((resolve) => {
      const dialog = byId("botCleanupDialog");
      const preferred = testEvent ? "delete" : "close";
      const buttons = { delete: byId("botCleanupDelete"), close: byId("botCleanupClose"), keep: byId("botCleanupKeep") };
      const labels = { delete: "닫고 삭제", close: "닫기만", keep: "그대로 두기" };
      for (const [choice, button] of Object.entries(buttons)) {
        button.textContent = labels[choice] + (choice === preferred ? "(기본)" : "");
        button.classList.toggle("button-primary", choice === preferred);
      }
      byId("botCleanupText").textContent = `${round ? `${round}차 테스트가` : "테스트가"} 끝났습니다. ` + (testEvent
        ? "앱이 만든 [테스트] 수강신청을 어떻게 할까요? 테스트 신청이라 실제 학생 자료와 무관하므로 기본은 닫고 삭제입니다."
        : "이 수강신청을 어떻게 할까요? 기본은 닫기만입니다.");
      const finish = (value) => {
        for (const button of Object.values(buttons)) button.onclick = null;
        dialog.close();
        resolve(value);
      };
      for (const choice of Object.keys(buttons)) buttons[choice].onclick = () => finish(choice);
      dialog.addEventListener("cancel", () => finish("close"), { once: true });
      dialog.showModal();
      buttons[preferred].focus();
    });
  }

  // 일시정지 관문: 진행 중인 학생은 끝까지 하고, 새 학생은 이어하기를 누를 때까지 기다린다(회차 중간에서도 같음).
  function createGate() {
    let paused = false;
    let release = null;
    let waiting = Promise.resolve();
    return {
      get paused() { return paused; },
      pause() { if (!paused) { paused = true; waiting = new Promise((resolve) => { release = resolve; }); } },
      resume() { if (paused) { paused = false; release?.(); } },
      wait() { return paused ? waiting : Promise.resolve(); },
    };
  }

  const key = (student) => `${Number(student.grade)}-${Number(student.classroom)}-${Number(student.number)}`;
  const pauseFor = (ms, signal) => new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

  // 교사 로그인이 끝났을 때: 진행을 멈추고, 앱 창에서 다시 로그인하면(같은 창에서 다시 로그인해도 앱이 이 창과 다시 연결) 이어서 진행한다.
  async function waitForTeacher(reason) {
    if (!running) return false;
    if (!appConnected()) throw new Error("앱 창이 닫혀 교사 화면 요청을 이어 갈 수 없습니다. 앱을 다시 열고 자동 테스트를 새로 시작하세요.");
    const { controller } = running;
    running.waitingLogin = true;
    const notice = byId("botLoginNotice");
    notice.hidden = false;
    notice.textContent = `교사 로그인 필요 — 앱 창에서 다시 로그인하면 이어서 진행합니다. (${reason})`;
    byId("botProgressText").textContent = "교사 로그인 필요 — 다시 로그인하면 이어서 진행";
    try {
      for (;;) {
        if (controller.signal.aborted) return false;
        if (!appConnected()) throw new Error("앱 창이 닫혀 이어서 진행할 수 없습니다.");
        announceReady(true);
        try {
          const state = await teacherRequest("session", 8000);
          if (state?.loggedIn) return true;
        } catch { /* 앱 창이 다시 열리는 중이거나 아직 로그인 전이다. */ }
        await pauseFor(4000, controller.signal);
      }
    } finally {
      if (running) running.waitingLogin = false;
      notice.hidden = true;
    }
  }

  async function startRun({ auto = false } = {}) {
    if (!source || running) return;
    if (!config) { byId("botProgressText").textContent = "서버 설정(supabase-config.js)을 불러오지 못했습니다."; return; }
    const opts = options();
    const repeat = Core.normalizeRepeat({ count: opts.repeatCount, freshEvent: opts.repeatFresh });
    const controller = new AbortController();
    const gate = createGate();
    running = { controller, gate, waitingLogin: false };
    byId("botResults").replaceChildren();
    byId("botStats").replaceChildren();
    byId("botReasons").replaceChildren();
    byId("botRounds").replaceChildren();
    byId("botLoginNotice").hidden = true;
    byId("botDownload").disabled = true;
    byId("botRun").disabled = true;
    byId("botStop").disabled = false;
    byId("botPause").disabled = false;
    byId("botPause").textContent = "일시정지";
    byId("botProgressText").textContent = auto ? "앱에서 받은 코드로 자동 실행을 시작합니다…" : "서버와 수강신청을 확인하는 중…";
    byId("botProgress").value = 0;
    renderSteps(null);
    const rng = Core.createRng(Date.now());
    const rpc = Core.createRpcClient({ projectUrl: config.projectUrl, publicKey: config.publicKey, fetchImpl: (...args) => fetch(...args) });
    const connected = appConnected() && source.from === "app";
    let current = null;
    let currentEventId = source.eventId;
    const progress = () => {
      if (!current || running?.waitingLogin) return;
      const done = current.records.length;
      byId("botProgress").max = Math.max(1, current.targets.length);
      byId("botProgress").value = done;
      byId("botProgressText").textContent = `${current.round}/${current.total}회차 · 학생 ${done}/${current.targets.length}${gate.paused ? " · 일시정지" : ""}`;
    };
    // 긴 회차 동안에도 앱 창의 교사 세션(5분 무활동 로그아웃)을 이어 둔다. 실패해도 다음 교사 요청에서 다시 확인한다.
    const keepAlive = connected ? setInterval(() => {
      if (!running || running.waitingLogin) return;
      teacherRequest("session", 15000, currentEventId).then((state) => {
        if (state?.loggedIn === false) byId("botBridgeStatus").textContent = "앱 창의 교사 로그인이 끝났습니다. 다음 교사 화면 대조 전에 다시 로그인하면 이어서 진행합니다.";
      }).catch(() => { /* 다음 교사 요청에서 다시 확인한다. */ });
    }, 60000) : null;
    let report = null;
    try {
      report = await Core.runRepeatedTest({ source, opts, repeat, auto, connected, canCreate: !!source.autoCreated }, {
        rpc, rng, signal: controller.signal, gate,
        now: () => new Date().toLocaleString("ko-KR"),
        teacher: (action, { eventId, timeoutMs } = {}) => teacherRequest(action, timeoutMs, eventId),
        waitForTeacher,
        confirm: (info) => waitForConfirm(`${info.round ? `${info.round}차 테스트 · ` : ""}${info.schoolYear}학년도 ${info.schoolName} ${info.round}차 · 대상 가상 학생 ${info.targets}명 · 동시 접속 ${opts.concurrency}` +
          ` · 반복 ${info.repeat.count}회(${info.repeat.freshEvent ? "회차마다 새 수강신청을 만들고 회차가 끝나면 닫고 삭제" : "같은 수강신청에서 바뀐 코드로 재신청"})`),
        askCleanup,
        acceptCreated: (data) => Bridge.validatePayload(data),
        onRound: (round, state) => {
          current = round;
          lastReport = state;
          if (!round.records.length && !round.targets.length) {
            byId("botStats").replaceChildren();
            byId("botReasons").replaceChildren();
          }
          renderSteps(round);
          renderRounds(state);
          progress();
        },
        onStep: (round) => { if (round === current) renderSteps(round); },
        onRecord: (record, round) => {
          renderRecord(record);
          renderStats(round.records);
          progress();
        },
        onCodes: (records, eventId) => {
          // 이후 회차·재실행은 바뀐 코드로(메모리에만)
          if (source.eventId !== eventId) return;
          for (const record of records) {
            const original = source.students.find((item) => key(item) === key(record));
            if (record.newCode && original) original.code = record.newCode;
          }
        },
        onEvent: (created) => {
          currentEventId = created.eventId;
          source = { ...source, ...created, from: "app", testEvent: true, autoCreated: true, receivedAt: new Date() };
          byId("botBridgeStatus").textContent = `앱이 새 [테스트] 수강신청을 만들어 학생 ${created.students.length}명의 코드를 보냈습니다.`;
          renderSource();
        },
        onRoundEnd: (round, state) => {
          renderSteps(round);
          renderRounds(state);
        },
      });
      lastReport = report;
    } catch (error) {
      byId("botProgressText").textContent = `실행 실패: ${error?.message}`;
    } finally {
      clearInterval(keepAlive);
      running = null;
      byId("botStop").disabled = true;
      byId("botPause").disabled = true;
      byId("botLoginNotice").hidden = true;
      if (report) {
        renderRounds(report);
        const { totals } = Core.repeatSummary(report);
        const done = report.rounds.filter((round) => round.status !== "stopped").length;
        byId("botProgressText").textContent = report.cancelled ? "취소했습니다."
          : report.stopped ? `중지했습니다 · 끝난 회차 ${done}/${report.repeat.count} · 보고서는 끝난 회차까지`
            : report.error ? `실행 실패: ${report.error} · 끝난 회차까지 보고서를 남겼습니다.`
              : totals.failedSteps ? `끝났습니다 · ${report.repeat.count}회차 · 실패 단계 ${totals.failedSteps}개(회차별 결과·체크리스트 확인)`
                : `끝났습니다 · ${report.repeat.count}회차 모두 통과 (학생 ${totals.total}건)`;
      }
      byId("botDownload").disabled = !lastReport?.rounds?.length;
      renderSource();
    }
  }

  byId("botRun").addEventListener("click", () => startRun({ auto: false }));
  byId("botStop").addEventListener("click", () => {
    if (!running) return;
    running.controller.abort();
    running.gate.resume();
    byId("botProgressText").textContent = "중지하는 중… 진행 중인 요청이 끝나면 멈추고, 끝난 회차까지 보고서를 만듭니다.";
  });
  byId("botPause").addEventListener("click", () => {
    if (!running) return;
    if (running.gate.paused) {
      running.gate.resume();
      byId("botPause").textContent = "일시정지";
      byId("botProgressText").textContent = "이어서 진행합니다.";
    } else {
      running.gate.pause();
      byId("botPause").textContent = "이어하기";
      byId("botProgressText").textContent = "일시정지 · 진행 중인 학생만 마무리합니다. ‘이어하기’를 누르면 계속합니다.";
    }
  });

  function downloadBytes(bytes, filename) {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  byId("botDownload").addEventListener("click", () => {
    if (!lastReport?.rounds?.length) return;
    const stamp = new Date();
    const date = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, "0")}-${String(stamp.getDate()).padStart(2, "0")}`;
    downloadBytes(Core.createXlsxBytes(Core.repeatReportSheets(lastReport)), `테스트봇_웹수강신청_결과_${date}.xlsx`);
  });

  // ---------- 결과 파일 만들기(로컬) ----------
  let localSettings = null;
  let localRoster = null;
  function readLocalSettings() {
    const status = byId("localSettings");
    try {
      localSettings = Core.readWorkspaceSettings((name) => localStorage.getItem(name), byId("localGrade").value);
      byId("localRound").value = localSettings.round;
      const groups = localSettings.groups.map((group) =>
        `${["1", "2"].includes(group.semester) ? `${group.semester}학기 ` : ""}${group.name}(택${group.count}/${group.courses.length})`).join(", ");
      status.className = "";
      status.textContent = `${localSettings.schoolYear}학년도 ${localSettings.schoolName} · 현 ${localSettings.grade}학년(${localSettings.cohortYear}학년도 입학생) → ${localSettings.targetGrade}학년 과목 · 현재 ${localSettings.round}차 · 그룹 ${localSettings.groups.length}개: ${groups}` +
        (localSettings.hasPlan ? "" : " · 편제표 학점을 찾지 못해 학점 칸은 비워 둡니다.");
    } catch (error) {
      localSettings = null;
      status.className = "bot-error";
      status.textContent = error.message;
    }
    return localSettings;
  }
  byId("localRead").addEventListener("click", readLocalSettings);
  byId("localGrade").addEventListener("change", () => {
    if (localSettings) readLocalSettings();
    if (localRoster) byId("localRosterStatus").textContent = "학년을 바꿨습니다. 명렬 파일을 다시 선택하세요.";
    localRoster = null;
  });
  byId("localRoster").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      const parsed = Core.parseRosterSheets(await parseWorkbook(await file.arrayBuffer()), byId("localGrade").value);
      localRoster = parsed.students;
      const classes = new Set(localRoster.map((student) => student.classroom)).size;
      byId("localRosterStatus").textContent = `${file.name} · 현 ${byId("localGrade").value}학년 ${localRoster.length}명(${classes}개 반)` +
        (parsed.otherGrade ? ` · 다른 학년 ${parsed.otherGrade}명 제외` : "");
    } catch (error) {
      localRoster = null;
      byId("localRosterStatus").textContent = error.message;
    }
  });
  byId("localGenerate").addEventListener("click", () => {
    const summary = byId("localSummary");
    try {
      const settings = readLocalSettings();
      if (!settings) throw new Error(byId("localSettings").textContent);
      const grade = settings.grade;
      const students = localRoster || Core.generateRoster({ grade, classes: byId("localClasses").value, perClass: byId("localPerClass").value });
      const rng = Core.createRng(Date.now());
      const format = document.querySelector('input[name="localFormat"]:checked').value;
      const romanDigits = byId("localRoman").checked;
      const { entries } = Core.buildResultEntries(students, settings.groups, {
        rng, popularity: byId("localPopularity").value,
        emptyCount: byId("localEmpty").value, violationCount: byId("localViolation").value, unknownCount: byId("localUnknown").value,
      });
      const round = String(Math.max(1, Math.floor(Number(byId("localRound").value) || 1)));
      const rows = format === "form"
        ? Core.buildFormRows(entries, { round, grade, romanDigits })
        : Core.buildWideRows(entries, settings.groups, { grade, credits: settings.credits, romanDigits });
      const filename = Core.resultFileName(grade, format);
      downloadBytes(Core.createXlsxBytes([{ name: "수강신청결과", rows }]), filename);
      const injected = entries.filter((entry) => entry.injected.length);
      const romanCourses = romanDigits ? [...new Set(settings.groups.flatMap((group) => group.courses).filter(Core.hasRoman))] : [];
      const top = Core.courseCounts(entries).slice(0, 6).map(([name, count]) => `${name} ${count}명`).join(", ");
      summary.innerHTML = "";
      const head = document.createElement("p");
      head.className = "bot-received";
      head.textContent = `만들었습니다: ${filename} · 현 ${grade}학년 ${entries.length}명 · ${format === "form" ? "차수·선택과목 목록" : "학생별 과목 표시"} 형식`;
      const detail = document.createElement("p");
      detail.className = "bot-note";
      detail.textContent = `신청이 많은 과목: ${top || "없음"}. 앱 2단계 '현 ${grade}학년' 탭 → 결과 → 결과 엑셀 선택으로 올리세요.` +
        (romanCourses.length ? ` 로마숫자를 숫자로 적은 과목: ${romanCourses.map(Core.romanToDigits).join(", ")}(앱이 같은 과목으로 맞춰야 정상).` : "");
      summary.append(head, detail);
      if (injected.length) {
        const list = document.createElement("ul");
        for (const entry of injected.slice(0, 30)) {
          const item = document.createElement("li");
          item.textContent = `${entry.classroom}반 ${entry.number}번 ${entry.name}: ${entry.injected.join(", ")}`;
          list.appendChild(item);
        }
        const title = document.createElement("p");
        title.textContent = `넣은 오류 ${injected.length}명(앱 검증 화면에 경고가 떠야 정상):`;
        summary.append(title, list);
      }
    } catch (error) {
      summary.className = "bot-error";
      summary.textContent = error.message;
    }
  });
})();
