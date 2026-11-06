"use strict";
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
    "botWrongPercent", "botWrongTimes", "botViolationPercent", "botResubmitPercent", "botCleanup", "botTeacherCheck"];
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
  function announceReady() {
    if (!appConnected()) return;
    window.opener.postMessage({ type: Bridge.READY, nonce }, Bridge.targetOrigin(window.location));
    byId("botBridgeStatus").textContent = "앱 창과 연결했습니다. 학생 코드를 기다리는 중…";
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
      const merged = Bridge.mergePayload(source?.from === "app" ? source : null, payload);
      source = { ...merged, from: "app", receivedAt: new Date() };
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
  function teacherRequest(action, timeoutMs = 60000) {
    if (!appConnected()) return Promise.reject(new Error("앱 창이 닫혀 교사 화면 요청을 보낼 수 없습니다."));
    const id = `r${++requestSeq}-${Date.now().toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error("앱 창이 응답하지 않습니다(교사 로그인 만료 또는 창 닫힘)."));
      }, timeoutMs);
      pendingRequests.set(id, { resolve, reject, timer });
      window.opener.postMessage({ type: Bridge.TEACHER_REQUEST, nonce, id, action, eventId: source.eventId }, Bridge.targetOrigin(window.location));
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
  const STEPS = [
    ["server", "서버·수강신청 확인"],
    ["students", "가상 학생 접속·첫 코드 변경·신청·저장 확인"],
    ["teacher", "교사 화면 신청 현황 대조"],
    ["locks", "교사 화면 잠금 현황 대조"],
    ["import", "앱 2단계 결과 반영(선택)"],
    ["cleanup", "테스트 수강신청 정리"],
    ["report", "보고서"],
  ];
  function newSteps() {
    return STEPS.map(([key, name]) => ({ key, name, status: "pending", expected: "", actual: "", ms: 0 }));
  }
  function renderSteps(steps) {
    const marks = { pending: "·", running: "…", pass: "✓", fail: "✗", skip: "–" };
    const labels = { pending: "대기", running: "진행 중", pass: "통과", fail: "실패", skip: "건너뜀" };
    byId("botChecklist").replaceChildren(...steps.map((step) => {
      const item = document.createElement("li");
      item.dataset.status = step.status;
      item.dataset.step = step.key;
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.textContent = marks[step.status];
      mark.setAttribute("aria-label", labels[step.status]);
      const title = document.createElement("span");
      title.textContent = `${step.name} · ${labels[step.status]}${step.ms ? ` · ${(step.ms / 1000).toFixed(1)}초` : ""}`;
      item.append(mark, title);
      if (step.expected || step.actual) {
        const detail = document.createElement("small");
        detail.textContent = [step.expected && `기대: ${step.expected}`, step.actual && `실제: ${step.actual}`].filter(Boolean).join(" / ");
        item.appendChild(detail);
      }
      return item;
    }));
  }
  async function runStep(steps, key, work) {
    const step = steps.find((item) => item.key === key);
    step.status = "running";
    renderSteps(steps);
    const started = Date.now();
    try {
      const result = await work(step);
      step.status = result === "skip" ? "skip" : step.status === "running" ? "pass" : step.status;
    } catch (error) {
      step.status = "fail";
      step.actual = step.actual ? `${step.actual} · ${error.message}` : error.message;
    }
    step.ms = Date.now() - started;
    renderSteps(steps);
    return step;
  }

  function renderStats(records) {
    const summary = Core.summarize(records);
    const cells = [["대상", summary.total], ["성공", summary.ok], ["실패", summary.failed], ["잠김 확인", summary.locked], ["코드 변경", summary.codeChanged],
      ["요청 수", summary.requests], ["평균 응답", `${summary.averageMs}ms`], ["최대 응답", `${summary.maxMs}ms`],
      ["위반 거절", summary.violationsRefused]];
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
      table.innerHTML = "<caption>실패 사유별 학생 수</caption><thead><tr><th>사유</th><th>학생 수</th></tr></thead>";
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
    if (!record.ok) row.className = "is-failed";
    for (const value of [`${record.grade}-${record.classroom}-${record.number} ${record.name}`, record.status, record.newCode,
      record.selections.join(", "), record.notes.join(" / "), record.failure]) {
      row.insertCell().textContent = value || "";
    }
    byId("botResults").appendChild(row);
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
  function askCleanup() {
    return new Promise((resolve) => {
      const dialog = byId("botCleanupDialog");
      const finish = (value) => {
        for (const id of ["botCleanupClose", "botCleanupDelete", "botCleanupKeep"]) byId(id).onclick = null;
        dialog.close();
        resolve(value);
      };
      byId("botCleanupClose").onclick = () => finish("close");
      byId("botCleanupDelete").onclick = () => finish("delete");
      byId("botCleanupKeep").onclick = () => finish("keep");
      dialog.addEventListener("cancel", () => finish("close"), { once: true });
      dialog.showModal();
      byId("botCleanupClose").focus();
    });
  }

  // 일시정지 관문: 진행 중인 학생은 끝까지 하고, 새 학생은 이어하기를 누를 때까지 기다린다.
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

  async function startRun({ auto = false } = {}) {
    if (!source || running) return;
    if (!config) { byId("botProgressText").textContent = "서버 설정(supabase-config.js)을 불러오지 못했습니다."; return; }
    const opts = options();
    const controller = new AbortController();
    const gate = createGate();
    const steps = newSteps();
    const records = [];
    running = { controller, gate };
    const meta = { eventId: source.eventId, schoolName: source.schoolName, schoolYear: source.schoolYear, round: source.round,
      startedAt: new Date().toLocaleString("ko-KR"), mode: "" };
    byId("botResults").replaceChildren();
    byId("botStats").replaceChildren();
    byId("botReasons").replaceChildren();
    byId("botDownload").disabled = true;
    byId("botRun").disabled = true;
    byId("botStop").disabled = false;
    byId("botPause").disabled = false;
    byId("botPause").textContent = "일시정지";
    byId("botProgressText").textContent = auto ? "앱에서 받은 코드로 자동 실행을 시작합니다…" : "서버와 수강신청을 확인하는 중…";
    byId("botProgress").value = 0;
    renderSteps(steps);
    const rng = Core.createRng(Date.now());
    const rpc = Core.createRpcClient({ projectUrl: config.projectUrl, publicKey: config.publicKey, fetchImpl: (...args) => fetch(...args) });
    const targets = Core.planStudents(Core.selectStudents(source.students, opts), { ...opts, rng });
    let server = null;
    try {
      // 1) 서버 방식과 수강신청 확인
      const serverStep = await runStep(steps, "server", async (step) => {
        if (!targets.length) throw new Error("대상 학생이 없습니다. 대상 학생 설정을 확인하세요.");
        server = await Core.detectServerMode(rpc, source.eventId);
        meta.mode = server.mode;
        let info = server.form;
        if (!info) {
          // 예전 방식: 학교·차수를 알려 주는 입구가 없어 첫 학생으로 읽기만 한다.
          const { data } = await rpc("get_scoped_course_application", { p_event: source.eventId, p_code: targets[0].code });
          info = data || {};
        }
        meta.schoolName = info.schoolName || meta.schoolName;
        meta.schoolYear = String(info.schoolYear || meta.schoolYear || "");
        meta.round = String(info.round || meta.round || "");
        step.expected = "수강신청 정보를 읽을 수 있음";
        step.actual = `${meta.schoolYear}학년도 ${meta.schoolName} ${meta.round}차 · ${server.mode === "hardened" ? "반·번호+코드(새 방식)" : "코드만(예전 방식)"} · 대상 ${targets.length}명`;
      });
      if (serverStep.status === "fail") throw new Error(serverStep.actual);
      if (!auto) {
        const accepted = await waitForConfirm(`${meta.schoolYear}학년도 ${meta.schoolName} ${meta.round}차 · 대상 가상 학생 ${targets.length}명 · 동시 접속 ${opts.concurrency}`);
        if (!accepted) {
          steps.find((step) => step.key === "students").actual = "사용자가 취소했습니다.";
          throw Object.assign(new Error("취소했습니다."), { cancelled: true });
        }
      }
      // 2) 가상 학생 실행
      byId("botProgress").max = targets.length;
      byId("botProgress").value = 0;
      const ctx = { rpc, eventId: source.eventId, mode: server.mode, gradeRequired: server.gradeRequired, rng,
        delayMs: opts.delayMs, signal: controller.signal, weights: new Map(), popularity: opts.popularity };
      await runStep(steps, "students", async (step) => {
        await Core.runPool(targets, opts.concurrency, async (student) => {
          await gate.wait();
          if (controller.signal.aborted) return null;
          return Core.runVirtualStudent(student, ctx);
        }, {
          signal: controller.signal,
          onResult: (record, index) => {
            if (!record) return;
            records.push(record);
            const original = source.students.find((item) => key(item) === key(targets[index]));
            if (record.newCode && original) original.code = record.newCode; // 이후 재실행은 바뀐 코드로(메모리에만)
            renderRecord(record);
            byId("botProgress").value = records.length;
            byId("botProgressText").textContent = `${records.length}/${targets.length}명 처리${gate.paused ? " · 일시정지" : ""}`;
            renderStats(records);
          },
        });
        const summary = renderStats(records);
        const violationOk = summary.violationsAccepted === 0;
        step.expected = `${targets.length}명 모두 저장·다시 불러오기 일치${opts.violationPercent ? ", 규칙 위반은 서버가 거절" : ""}`;
        step.actual = `성공 ${summary.ok}명, 실패 ${summary.failed}명${summary.locked ? `, 잠김 확인 ${summary.locked}명` : ""}, 코드 변경 ${summary.codeChanged}명, 평균 응답 ${summary.averageMs}ms` +
          (summary.violationsRefused + summary.violationsAccepted ? `, 위반 거절 ${summary.violationsRefused}/${summary.violationsRefused + summary.violationsAccepted}` : "") +
          (controller.signal.aborted ? " · 중지됨" : "");
        if (controller.signal.aborted || summary.ok + summary.locked !== targets.length || summary.failed || !violationOk) step.status = "fail";
      });
      if (controller.signal.aborted) throw Object.assign(new Error("중지했습니다."), { cancelled: true });
      const connected = appConnected() && source.from === "app";
      // 3) 교사 화면 대조
      await runStep(steps, "teacher", async (step) => {
        if (!opts.teacherCheck || !connected) {
          step.actual = !opts.teacherCheck ? "설정에서 껐습니다." : "앱 창과 연결되지 않아 건너뜁니다(앱의 ‘테스트봇으로 보내기’로 열면 대조합니다).";
          return "skip";
        }
        const data = await teacherRequest("applications");
        const entries = new Map((data?.entries || []).map((entry) => [key(entry), entry]));
        const saved = records.filter((record) => record.verified);
        const mismatched = [];
        for (const record of saved) {
          const entry = entries.get(key(record));
          const stored = Array.isArray(entry?.selections) ? entry.selections : [];
          if (!entry || !entry.submittedAt || stored.length !== record.selections.length || !record.selections.every((name) => stored.includes(name))) {
            mismatched.push(`${record.classroom}-${record.number} ${record.name}`);
          }
        }
        const targetKeys = new Set(targets.map(key));
        const submitted = [...entries.values()].filter((entry) => targetKeys.has(key(entry)) && entry.submittedAt);
        const count = (list) => {
          const map = new Map();
          for (const item of list) for (const name of item.selections || []) map.set(name, (map.get(name) || 0) + 1);
          return map;
        };
        const botCounts = count(saved);
        const teacherCounts = count(submitted);
        const courseDiff = [...new Set([...botCounts.keys(), ...teacherCounts.keys()])]
          .filter((name) => (botCounts.get(name) || 0) !== (teacherCounts.get(name) || 0));
        const others = source.testEvent ? [...entries.values()].filter((entry) => !targetKeys.has(key(entry)) && entry.submittedAt).length : 0;
        step.expected = `신청 완료 ${saved.length}명, 학생별 선택·과목별 인원 모두 일치`;
        step.actual = `교사 화면 신청 완료 ${submitted.length}명, 학생 불일치 ${mismatched.length}명, 과목 인원 불일치 ${courseDiff.length}과목` +
          (mismatched.length ? ` (${mismatched.slice(0, 5).join(", ")})` : "") + (courseDiff.length ? ` (${courseDiff.slice(0, 5).join(", ")})` : "") +
          (others ? `, 대상이 아닌 학생 신청 ${others}명` : "");
        if (mismatched.length || courseDiff.length || submitted.length !== saved.length || others) step.status = "fail";
      });
      // 4) 잠금 대조(새 방식 + 틀린 코드 주입 때만)
      await runStep(steps, "locks", async (step) => {
        const tried = records.filter((record) => record.wrongCode?.attempts);
        if (!opts.teacherCheck || !connected || server.mode !== "hardened" || !tried.length) {
          step.actual = server.mode !== "hardened" ? "예전 방식 서버는 잠금이 없습니다." : !tried.length ? "틀린 코드 주입이 없어 건너뜁니다." : "앱 창과 연결되지 않았거나 대조를 껐습니다.";
          return "skip";
        }
        const data = await teacherRequest("locks");
        const listed = new Map((data?.students || []).map((student) => [key(student), student]));
        const expectedLocked = new Set(tried.filter((record) => record.wrongCode.lockedAfter).map(key));
        const expectedListed = new Set(tried.map(key));
        const missing = [...expectedListed].filter((item) => !listed.has(item));
        const lockedActual = new Set([...listed].filter(([, student]) => student.teacherLock || student.lockedSeconds > 0).map(([item]) => item));
        const lockMismatch = [...new Set([...expectedLocked, ...lockedActual])].filter((item) => expectedLocked.has(item) !== lockedActual.has(item));
        const targetKeys = new Set(targets.map(key));
        const extra = [...listed.keys()].filter((item) => targetKeys.has(item) && !expectedListed.has(item));
        step.expected = `실패 기록 ${expectedListed.size}명, 잠김 ${expectedLocked.size}명`;
        step.actual = `교사 화면 실패 기록 ${listed.size}명(누락 ${missing.length}, 예상 밖 ${extra.length}), 잠김 ${lockedActual.size}명(불일치 ${lockMismatch.length})`;
        if (missing.length || extra.length || lockMismatch.length) step.status = "fail";
      });
      // 5) 앱 2단계 반영(기본 꺼짐)
      await runStep(steps, "import", async (step) => {
        if (!opts.importToApp) { step.actual = "기본 꺼짐(교사 작업 자료 보호)"; return "skip"; }
        if (!connected || !source.testEvent) { step.actual = "앱의 ‘수강신청 자동 테스트’로 만든 신청만 반영할 수 있습니다."; return "skip"; }
        const result = await teacherRequest("import", 180000);
        const saved = records.filter((record) => record.verified).length;
        step.expected = `${meta.round}차에 신청 학생 ${saved}명 이상 반영`;
        step.actual = `${result.round}차 학생 ${result.students}명`;
        if (Number(result.students) < saved) step.status = "fail";
      });
      // 6) 정리
      await runStep(steps, "cleanup", async (step) => {
        if (!source.testEvent || !connected) { step.actual = "앱이 자동 테스트로 만든 신청이 아니어서 그대로 둡니다."; return "skip"; }
        const choice = opts.cleanup === "ask" ? await askCleanup() : opts.cleanup;
        step.expected = { close: "신청 닫기", delete: "신청 닫고 삭제", keep: "그대로 두기" }[choice];
        if (choice === "keep") { step.actual = "그대로 두었습니다."; return "skip"; }
        const closed = await teacherRequest("close");
        step.actual = closed?.message || "닫았습니다.";
        if (choice === "delete") {
          const removed = await teacherRequest("delete");
          step.actual += ` · ${removed?.message || "삭제했습니다."}`;
        }
      });
    } catch (error) {
      if (!error?.cancelled) byId("botProgressText").textContent = `실행 실패: ${error.message}`;
    } finally {
      await runStep(steps, "report", async (step) => {
        const summary = Core.summarize(records);
        const failedSteps = steps.filter((item) => item.status === "fail");
        lastReport = { steps: steps.map((item) => ({ ...item })), records, meta };
        step.actual = `실패 단계 ${failedSteps.length}개 · 학생 성공 ${summary.ok}/${summary.total}`;
        if (failedSteps.length) step.status = "fail";
      });
      const failed = steps.filter((item) => item.status === "fail").length;
      byId("botProgressText").textContent = controller.signal.aborted ? `중지했습니다 · ${records.length}명 처리`
        : failed ? `끝났습니다 · 실패 단계 ${failed}개(체크리스트 확인)` : `끝났습니다 · 모든 단계 통과 (${records.length}명)`;
      running = null;
      byId("botStop").disabled = true;
      byId("botPause").disabled = true;
      byId("botDownload").disabled = !lastReport;
      renderSource();
    }
  }

  byId("botRun").addEventListener("click", () => startRun({ auto: false }));
  byId("botStop").addEventListener("click", () => {
    if (!running) return;
    running.controller.abort();
    running.gate.resume();
    byId("botProgressText").textContent = "중지하는 중… 진행 중인 요청이 끝나면 멈춥니다.";
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
    if (!lastReport) return;
    const labels = { pending: "대기", running: "진행 중", pass: "통과", fail: "실패", skip: "건너뜀" };
    const stepRows = [["단계", "결과", "기대값", "실제값", "걸린 시간(초)"],
      ...lastReport.steps.map((step) => [step.name, labels[step.status], step.expected, step.actual, Number((step.ms / 1000).toFixed(1))])];
    const sheets = [{ name: "단계별 결과", rows: stepRows }, ...Core.resultSheets(lastReport.records, lastReport.meta)];
    const stamp = new Date();
    const date = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, "0")}-${String(stamp.getDate()).padStart(2, "0")}`;
    downloadBytes(Core.createXlsxBytes(sheets), `테스트봇_웹수강신청_결과_${date}.xlsx`);
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
