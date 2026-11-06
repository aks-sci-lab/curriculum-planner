    "use strict";
    var getApplicationCohortYear;
    var curriculumPlanVersionKey;
    let curriculumCellSelectionMode = false;
    let curriculumCellSelection = null;
    let curriculumSelectionAnchor = null;
    let curriculumSelectionDragging = false;
    let curriculumSelectionGesture = null;
    let curriculumFirstRowCache = null;
    const curriculumBaselineLoads = new WeakSet();
    let curriculumTableSizeFrame = null;
    const rawState = {
      students: [],
      courses: [],
      selectedId: null,
      fileName: "",
      classOverrides: {},
      semesterAssignments: {},
      customGroupNames: [],
      groupAssignments: {},
      selectedCourseColumns: [],
      lastSelectedCourseColumn: null,
      curriculumPlanFileName: "",
      curriculumImportedLayout: null,
      curriculumTopCollapsed: true,
      curriculumTemplateRows: [],
      curriculumPlan: [],
      curriculumCohortYear: "2026",
      curriculumPlanType: "cohort",
      curriculumCohorts: {},
      curriculumAnnualPlans: {},
      curriculumTargetGrade: "1",
      curriculumTargetDivision: "학생 선택 교육과정",
      curriculumTargetArea: "",
      curriculumTargetDetail: "일반선택",
      curriculumBundleName: "선택묶음1",
      curriculumBundlePick: 1,
      curriculumUndoStack: [],
      curriculumEditBefore: null,
      curriculumEditUndoRecorded: false,
      curriculumMutationRevision: 0,
      curriculumSelectedRow: null,
      curriculumSelectedColumn: null,
      curriculumPlanFilters: { grade: "", division: "", area: "", detail: "", query: "" },
      workflowStep: 1,
      currentRound: "1",
      rounds: { "1": null },
      roundClosures: { "1": {} },
      roundStatuses: {},
      hoursStats: {},
      curriculumVersions: {},
      applicationImportRevision: 0,
      applicationMenuGrade: "1",
      applicationMode: "external",
    };
    const stateProxyCache = new WeakMap();
    const stateRawTargets = new WeakMap();
    let statePersistenceTimer = null;
    let statePersistenceSuppressed = 0;
    let statePersistenceReady = false;

    function scheduleStatePersistence() {
      if (!statePersistenceReady || statePersistenceSuppressed || statePersistenceTimer !== null) return;
      statePersistenceTimer = window.setTimeout(() => {
        statePersistenceTimer = null;
        persistState();
      }, 200);
    }

    function observeState(value) {
      if (!value || typeof value !== "object") return value;
      if (stateRawTargets.has(value)) return value;
      const prototype = Object.getPrototypeOf(value);
      if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
      if (stateProxyCache.has(value)) return stateProxyCache.get(value);
      const proxy = new Proxy(value, {
        get(target, property, receiver) {
          return observeState(Reflect.get(target, property, receiver));
        },
        set(target, property, nextValue, receiver) {
          const rawValue = stateRawTargets.get(nextValue) || nextValue;
          if (Object.is(target[property], rawValue)) return true;
          const updated = Reflect.set(target, property, rawValue, receiver);
          if (updated) scheduleStatePersistence();
          return updated;
        },
        deleteProperty(target, property) {
          if (!Object.hasOwn(target, property)) return true;
          const deleted = Reflect.deleteProperty(target, property);
          if (deleted) scheduleStatePersistence();
          return deleted;
        }
      });
      stateProxyCache.set(value, proxy);
      stateRawTargets.set(proxy, value);
      return proxy;
    }

    const state = observeState(rawState);
    const STORAGE_KEY = "course-certificate-studio-v1";
    let statePersistenceBlocked = false;
    let protectedStoredState = null;
    let workspaceSaveFailed = false;
    let lastSavedWorkspace = null;
    let curriculumSearchTimer = null;
    let curriculumImportRevision = 0;
    const $ = (selector) => document.querySelector(selector);
    const rosterInput = $("#rosterInput");
    const dropzone = $("#dropzone");
    const status = $("#status");
    const resetDataButton = $("#resetData");
    const workflowSteps = $("#workflowSteps");
    const curriculumPlanInput = $("#curriculumPlanInput");
    const CURRICULUM_DETAIL_OPTIONS = ["공통", "일반선택", "진로선택", "융합선택"];
    const CURRICULUM_DIVISION_OPTIONS = ["학교 지정 교육과정", "학생 선택 교육과정"];
    const CURRICULUM_SEMESTER_FIELDS = ["sem11", "sem12", "sem21", "sem22", "sem31", "sem32"];
    // 편제표 카드: 내년도 신입생("0")과 올해 1·2·3학년 입학생. 3학년 카드는 올해 전학년 편제표를 만드는 데만 쓴다.
    const CURRICULUM_COHORT_GRADES = ["0", "1", "2", "3"];

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      })[character]);
    }

    function isCoreCourse(course) {
      const area = String(course?.area || course?.category || "").replace(/\s+/g, "");
      if (/국어|영어|수학/.test(area)) return true;
      const subject = String(course?.subject || course?.name || "").replace(/\s+/g, "");
      return /^(국어|화법과작문|독서와작문|문학|언어와매체|영어|영어회화|영어독해와작문|수학|대수|미적분|확률과통계|기하|경제수학|인공지능수학)/.test(subject);
    }

    let toastTimer = null;
    function showAppToast(message, kind = "success") {
      const toast = document.getElementById("appToast");
      if (!toast) return;
      toast.textContent = message;
      toast.classList.toggle("error", kind === "error");
      toast.classList.add("visible");
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove("visible"), 3000);
    }
    window.showAppToast = showAppToast;

    // 편제표·결과 업로드·집계·통계는 브라우저 안에서만 처리하므로 로그인 없이 사용한다.
    // 교사 로그인은 서버에 자료를 만드는 웹 수강신청 기능에서만 요구한다.
    function requireLocalWorkspaceAccess() {
      const url = new URL(window.location.href);
      if (url.hash === "#student" || url.hash.startsWith("#apply=") || new URLSearchParams(url.hash.slice(1)).has("event")) {
        showAppToast("교사용 작업 화면에서 이용하세요.", "error");
        return false;
      }
      return true;
    }

    function normalizeCurriculumDetail(value) {
      const raw = String(value ?? "").trim();
      const compact = raw.replace(/\s+/g, "");
      if (compact.includes("공통")) return "공통";
      if (compact.includes("일반선택") || compact === "일반") return "일반선택";
      if (compact.includes("진로선택") || compact === "진로") return "진로선택";
      if (compact.includes("융합선택") || compact === "융합") return "융합선택";
      return "일반선택";
    }

    function curriculumSelectionType(value) {
      const raw = String(value ?? "").trim();
      if (!raw) return "";
      const compact = raw.replace(/\s+/g, "");
      if (compact.includes("공통")) return "공통";
      if (compact.includes("일반")) return "일반선택";
      if (compact.includes("진로")) return "진로선택";
      if (compact.includes("융합")) return "융합선택";
      return "";
    }

    function normalizeCurriculumDivision(value) {
      const raw = String(value ?? "").trim();
      if (raw.includes("학교")) return "학교 지정 교육과정";
      if (raw.includes("학생")) return "학생 선택 교육과정";
      return "학생 선택 교육과정";
    }

    function normalizeCurriculumDivisionFilter(value) {
      const raw = String(value ?? "").trim();
      if (!raw) return "";
      return normalizeCurriculumDivision(raw);
    }

    function normalizeCurriculumDetailFilter(value) {
      const raw = String(value ?? "").trim();
      if (!raw) return "";
      return normalizeCurriculumDetail(raw);
    }

    function normalizeCurriculumAreaName(areaValue, subjectValue = "") {
      const raw = String(areaValue ?? "").trim();
      const subject = String(subjectValue ?? "").trim();
      if (subject.includes("한국사")) return "한국사";
      if (raw.includes("사회") && raw.includes("한국사")) {
        return subject.includes("한국사") ? "한국사" : "사회";
      }
      return raw;
    }

    function curriculumAreaOf(item) {
      return normalizeCurriculumAreaName(item?.area || item?.area2 || "", item?.subject || "");
    }

    function normalizeCurriculumPlanRow(row, fallback = {}) {
      const source = row && typeof row === "object" ? row : {};
      return {
        grade: ["1", "2", "3"].includes(String(source.grade ?? fallback.grade ?? "")) ? String(source.grade ?? fallback.grade) : "1",
        division: normalizeCurriculumDivision(source.division || fallback.division || ""),
        area: normalizeCurriculumAreaName(source.area ?? fallback.area ?? "", source.subject ?? fallback.subject ?? ""),
        detail: normalizeCurriculumDetail(source.detail || source.type || fallback.detail || ""),
        subject: String(source.subject ?? fallback.subject ?? "").trim(),
        baseCredit: Number(source.baseCredit ?? fallback.baseCredit ?? 0) || 0,
        opCredit: Number(source.opCredit ?? fallback.opCredit ?? 0) || 0,
        bundleName: String(source.bundleName ?? fallback.bundleName ?? "").trim(),
        bundlePick: Math.max(1, Number(source.bundlePick ?? fallback.bundlePick ?? 1) || 1),
        semesterGroups: source.semesterGroups && typeof source.semesterGroups === "object"
          ? Object.fromEntries(Object.entries(source.semesterGroups).filter(([field, group]) =>
            CURRICULUM_SEMESTER_FIELDS.includes(field) && group && typeof group === "object").map(([field, group]) => [field, {
            name: String(group.name || "").trim(),
            pick: Math.max(0, Number(group.pick) || 0),
            ...(group.block ? { block: String(group.block), credit: Math.max(0, Number(group.credit) || 0),
              ...(group.crossed ? { crossed: true } : {}) } : {})
          }]))
          : {},
        sem11: String(source.sem11 ?? fallback.sem11 ?? ""),
        sem12: String(source.sem12 ?? fallback.sem12 ?? ""),
        sem21: String(source.sem21 ?? fallback.sem21 ?? ""),
        sem22: String(source.sem22 ?? fallback.sem22 ?? ""),
        sem31: String(source.sem31 ?? fallback.sem31 ?? ""),
        sem32: String(source.sem32 ?? fallback.sem32 ?? "")
      };
    }

    function planSubjectKey(grade, subject) {
      return `${String(grade || "")}::${String(subject || "").trim()}`;
    }

    function isSelectableDetail(detail) {
      const normalized = normalizeCurriculumDetail(detail);
      return normalized === "일반선택" || normalized === "진로선택" || normalized === "융합선택";
    }

    function curriculumBundleKeyForRow(row) {
      if (!row) return "";
      if (normalizeCurriculumDivision(row.division) !== "학생 선택 교육과정") return "";
      if (!isSelectableDetail(row.detail)) return "";
      const bundle = String(row.bundleName || "").trim();
      if (!bundle) return "";
      return `${String(row.grade || "1")}::${bundle}`;
    }

    // 학년·반 필터 선택지를 만든다. 반은 고른 학년의 학생만 보여 주어 1학년 1반과 2학년 1반이 섞이지 않게 한다.
    function applyClassFilterOptions(students) {
      const gradeSelect = $("#gradeFilter");
      const classSelect = $("#classFilter");
      const grades = [...new Set(students.map((student) => String(student.grade)))].sort((a, b) => Number(a) - Number(b));
      const previousGrade = gradeSelect?.value || "";
      const grade = grades.includes(previousGrade) ? previousGrade : "";
      if (gradeSelect) {
        gradeSelect.innerHTML = '<option value="">전체 학년</option>' +
          grades.map((value) => `<option value="${escapeHtml(value)}">현 ${escapeHtml(value)}학년</option>`).join("");
        gradeSelect.value = grade;
        gradeSelect.disabled = !students.length;
      }
      const previousClass = classSelect.value;
      const classes = [...new Set(students.filter((student) => !grade || String(student.grade) === grade)
        .map((student) => student.classroom))].sort((a, b) => Number(a) - Number(b));
      classSelect.innerHTML = '<option value="">전체 반</option>' +
        classes.map((classroom) => `<option value="${escapeHtml(classroom)}">${escapeHtml(classroom)}반</option>`).join("");
      if (classes.includes(previousClass)) classSelect.value = previousClass;
      const note = document.getElementById("gradeFilterNote");
      if (note) {
        const missing = students.length ? ["1", "2"].filter((value) => !grades.includes(value)) : [];
        note.textContent = missing.length ? `현 ${missing.join("·")}학년 결과가 아직 없습니다. 2단계에서 올리면 이 목록에 나타납니다.` : "";
        note.classList.toggle("hidden", !missing.length);
      }
    }

    function syncActiveRound() {
      if (!state.rounds || typeof state.rounds !== "object") state.rounds = { "1": null };
      if (state.students.length || state.fileName.startsWith("온라인 자동 연동")) {
        const current = state.rounds[state.currentRound];
        if (current && current.fileName === state.fileName && current.students === state.students &&
            current.courses === state.courses && current.classOverrides === state.classOverrides &&
            current.semesterAssignments === state.semesterAssignments && current.groupAssignments === state.groupAssignments &&
            current.customGroupNames === state.customGroupNames) return;
        state.rounds[state.currentRound] = {
          fileName: state.fileName,
          gradeFiles: state.rounds[state.currentRound]?.gradeFiles || {},
          students: state.students,
          courses: state.courses,
          classOverrides: state.classOverrides,
          semesterAssignments: state.semesterAssignments,
          groupAssignments: state.groupAssignments,
          customGroupNames: state.customGroupNames || []
        };
      } else if (state.rounds[state.currentRound]) {
        state.rounds[state.currentRound] = null;
      }
    }

    function updateWorkspaceSaveStatus(message, failed = false) {
      workspaceSaveFailed = failed;
      const label = $("#workspaceSaveStatus");
      if (!label) return;
      label.textContent = message;
      const warning = $("#workspaceStorageWarning");
      warning.classList.toggle("hidden", !failed);
      warning.textContent = failed
        ? `${message}. 새로고침하거나 창을 닫기 전에 작업 자료를 백업하세요. 원본 엑셀은 별도로 보관해야 합니다.`
        : "";
      $("#retryWorkspaceSave").classList.toggle("hidden", !failed);
      $("#resumeWorkspaceSave").classList.toggle("hidden", !statePersistenceBlocked);
    }

    function showWorkspaceGroupStorageIssue(message) {
      const warning = $("#workspaceGroupWarning");
      warning.classList.toggle("hidden", !message);
      warning.textContent = message ? `${message}. 2단계 과목·그룹 설정에서 확인하고 창을 닫기 전에 작업 자료를 백업하세요.` : "";
    }

    function isWorkspaceStorageProtected() {
      return statePersistenceBlocked || !statePersistenceReady;
    }

    function workspacePayload() {
      return {
          schemaVersion: 2,
          applicationMenuGrade: state.applicationMenuGrade,
          applicationMode: state.applicationMode,
          currentRound: state.currentRound,
          rounds: state.rounds,
          roundClosures: state.roundClosures,
          roundStatuses: state.roundStatuses,
          hoursStats: state.hoursStats,
          curriculumVersions: state.curriculumVersions,
          students: state.students,
          courses: state.courses,
          selectedId: state.selectedId,
          fileName: state.fileName,
          classOverrides: state.classOverrides,
          semesterAssignments: state.semesterAssignments,
          customGroupNames: state.customGroupNames,
          groupAssignments: state.groupAssignments,
          curriculumPlanFileName: state.curriculumPlanFileName,
          curriculumImportedLayout: state.curriculumImportedLayout,
          curriculumTopCollapsed: state.curriculumTopCollapsed,
          curriculumTemplateRows: state.curriculumTemplateRows,
          curriculumPlan: state.curriculumPlan,
          curriculumCohortYear: state.curriculumCohortYear,
          curriculumPlanType: state.curriculumPlanType,
          curriculumCohorts: state.curriculumCohorts,
          curriculumAnnualPlans: state.curriculumAnnualPlans,
          curriculumPlanFilters: state.curriculumPlanFilters,
          curriculumTargetGrade: state.curriculumTargetGrade,
          curriculumTargetDivision: state.curriculumTargetDivision,
          curriculumTargetArea: state.curriculumTargetArea,
          curriculumTargetDetail: state.curriculumTargetDetail,
          curriculumBundleName: state.curriculumBundleName,
          curriculumBundlePick: state.curriculumBundlePick,
          workflowStep: state.workflowStep,
          openingPercent: $("#openingPercent").value,
          divisionPercent: $("#divisionPercent").value,
          schoolYear: $("#schoolYear").value,
          round: $("#round").value,
          confirmDate: $("#confirmDate").value,
          schoolName: $("#schoolName").value
      };
    }

    function persistState() {
      if (statePersistenceTimer !== null) {
        window.clearTimeout(statePersistenceTimer);
        statePersistenceTimer = null;
      }
      if (statePersistenceBlocked) return false;
      try {
        statePersistenceSuppressed++;
        try {
          syncActiveRound();
          syncActiveCurriculumCohort();
        } finally {
          statePersistenceSuppressed--;
        }
        if (!$("#schoolYear").checkValidity()) throw new Error("학년도에 2000~2100 사이의 정수를 입력하세요.");
        const serialized = JSON.stringify(workspacePayload());
        if (serialized !== lastSavedWorkspace) {
          const stored = localStorage.getItem(STORAGE_KEY);
          if (stored !== lastSavedWorkspace) {
            statePersistenceBlocked = true;
            protectedStoredState = stored;
            throw new Error("다른 창의 저장 자료가 변경되어 덮어쓰기를 중지했습니다.");
          }
          localStorage.setItem(STORAGE_KEY, serialized);
          lastSavedWorkspace = serialized;
          if (typeof scheduleWorkspaceFileSave === "function") scheduleWorkspaceFileSave();
        }
        updateWorkspaceSaveStatus("이 브라우저에 저장 완료");
        return true;
      } catch (error) {
        updateWorkspaceSaveStatus(`자동 저장 실패: ${error.message}`, true);
        return false;
      }
    }

    const BACKUP_TIME_KEY = "curriculum-last-backup-at";
    const BACKUP_STALE_MS = 24 * 60 * 60 * 1000;
    let backupSuggestedAt = 0;
    function lastWorkspaceBackup() {
      try {
        const value = Number(localStorage.getItem(BACKUP_TIME_KEY));
        return Number.isFinite(value) && value > 0 ? value : 0;
      } catch { return 0; }
    }
    function markWorkspaceBackup() {
      try { localStorage.setItem(BACKUP_TIME_KEY, String(Date.now())); } catch { /* 표시용 기록이므로 실패해도 백업은 유효하다. */ }
      renderBackupStatus();
    }
    function workspaceHasWork() {
      return !!state.curriculumImportedLayout || state.students.length > 0 ||
        Object.values(state.rounds || {}).some((data) => data?.students?.length);
    }
    function backupAgeLabel(time) {
      if (!time) return "백업 없음";
      const minutes = Math.floor((Date.now() - time) / 60000);
      if (minutes < 1) return "방금 백업";
      if (minutes < 60) return `${minutes}분 전 백업`;
      if (minutes < 1440) return `${Math.floor(minutes / 60)}시간 전 백업`;
      return `${Math.floor(minutes / 1440)}일 전 백업`;
    }
    function renderBackupStatus() {
      const label = document.getElementById("workspaceBackupStatus");
      if (!label) return;
      const time = lastWorkspaceBackup();
      const stale = workspaceHasWork() && (!time || Date.now() - time > BACKUP_STALE_MS);
      label.textContent = backupAgeLabel(time);
      label.classList.toggle("is-stale", stale);
      label.title = stale ? "작업 내용이 이 브라우저에만 저장되어 있습니다. '파일로 백업하기'를 눌러 보관하세요." : "";
    }
    function suggestWorkspaceBackup(reason) {
      const time = lastWorkspaceBackup();
      if (!workspaceHasWork() || (time && Date.now() - time <= BACKUP_STALE_MS)) return;
      if (Date.now() - backupSuggestedAt < 10 * 60 * 1000) return;
      backupSuggestedAt = Date.now();
      showAppToast(`${reason} 후 백업 파일을 받아 두세요. 자료는 이 브라우저에만 저장됩니다.`);
    }

    // 이 앱이 브라우저에 남기는 작업 자료만 지운다. 교사 로그인 정보는 유지한다.
    const WORKSPACE_RESET_KEYS = /^(?:course-certificate-studio-|curriculum-color-semester-groups-v3|curriculum-last-backup-at$|curriculum-cloud-links:)/;
    let workspaceResetting = false;
    function clearWorkspaceStorage() {
      for (let index = localStorage.length - 1; index >= 0; index--) {
        const key = localStorage.key(index);
        if (key && WORKSPACE_RESET_KEYS.test(key)) localStorage.removeItem(key);
      }
    }

    async function resetWorkspaceAll() {
      if (!requireLocalWorkspaceAccess()) return;
      const recentBackup = Date.now() - lastWorkspaceBackup() < 10 * 60 * 1000;
      if (workspaceHasWork() && !recentBackup &&
          window.confirm("전체 초기화 전에 지금 작업 자료를 백업 파일로 내려받을까요?\n(권장: 초기화하면 되돌릴 수 없습니다)")) {
        downloadWorkspaceBackup();
      }
      if (!window.confirm("모든 작업 자료를 이 브라우저에서 삭제합니다.\n\n· 편제표(입학생별·전학년)와 변경 이력, 보관된 원본 엑셀\n· 모든 차수의 신청 결과·개설/폐강 결정·확정 상태\n· 선택 그룹 설정과 학교·학년도 설정\n\n되돌릴 수 없습니다. 계속할까요?")) return;
      if (window.prompt("확인을 위해 '초기화'를 입력하세요.") !== "초기화") {
        showAppToast("입력이 달라 전체 초기화를 취소했습니다.", "error");
        return;
      }
      try {
        workspaceResetting = true;
        statePersistenceBlocked = true;
        if (statePersistenceTimer !== null) {
          window.clearTimeout(statePersistenceTimer);
          statePersistenceTimer = null;
        }
        clearWorkspaceStorage();
        await new Promise((resolve) => {
          if (typeof indexedDB === "undefined") { resolve(); return; }
          const request = indexedDB.deleteDatabase("curriculum-original-workbooks");
          request.onsuccess = request.onerror = request.onblocked = () => resolve();
        });
        window.location.reload();
      } catch (error) {
        workspaceResetting = false;
        showAppToast(`전체 초기화 실패: ${error.message}`, "error");
      }
    }

    const WORKSPACE_BACKUP_VERSION = 1;
    function buildWorkspaceBackup() {
      syncActiveRound();
      syncActiveCurriculumCohort();
      const groups = {};
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key?.startsWith("curriculum-color-semester-groups-v3")) groups[key] = localStorage.getItem(key);
      }
      return {
        type: "curriculum-workspace-backup",
        backupVersion: WORKSPACE_BACKUP_VERSION,
        appVersion: typeof APP_VERSION === "string" ? APP_VERSION : "",
        createdAt: new Date().toISOString(),
        workspace: workspacePayload(),
        protectedStoredState,
        groups,
        pendingGroupSettings: typeof getApplicationGroupBackup === "function" ? getApplicationGroupBackup() : null,
        note: "개인정보가 포함될 수 있습니다. 원본 엑셀과 온라인 서버 자료는 별도로 백업하세요. 로그인 정보는 포함하지 않습니다."
      };
    }

    function downloadWorkspaceBackup() {
      try {
        downloadTextFile(JSON.stringify(buildWorkspaceBackup(), null, 2), "교육과정_작업자료_백업.json", "application/json");
        markWorkspaceBackup();
        showAppToast("백업 파일을 내려받았습니다. 원본 엑셀도 별도로 보관하세요.");
      } catch (error) {
        showAppToast(`백업 실패: ${error.message}`, "error");
      }
    }

    // afterWrite: 자료를 실제로 교체한 직후(새로고침 직전)에 한 번 부른다. 파일 연결처럼 교체가 끝난 뒤에만 해야 하는 일에 쓴다.
    async function restoreWorkspaceBackup(file, afterWrite = null) {
      if (!file) return false;
      const previous = new Map();
      const written = [];
      try {
        const backup = JSON.parse(await file.text());
        if (backup.type !== "curriculum-workspace-backup" || !backup.groups ||
            typeof backup.groups !== "object" || Array.isArray(backup.groups)) {
          throw new Error("교육과정 작업 자료 백업 JSON을 선택하세요.");
        }
        if (Number(backup.backupVersion) > WORKSPACE_BACKUP_VERSION) {
          throw new Error("더 새로운 버전의 프로그램에서 만든 파일입니다. 프로그램을 최신 버전으로 업데이트하세요.");
        }
        validateWorkspaceData(backup.workspace);
        const entries = [[STORAGE_KEY, JSON.stringify(backup.workspace)]];
        const groupData = { ...backup.groups };
        const pending = backup.pendingGroupSettings;
        if (pending?.canRestore) {
          if (!/^curriculum-color-semester-groups-v3(?::\d{4})?$/.test(pending.key)) {
            throw new Error("백업의 선택 그룹 키가 잘못되었습니다.");
          }
          validateApplicationGroupData(pending.groups, pending.seeded);
          groupData[pending.key] = JSON.stringify(pending.groups);
          groupData[pending.key + "-seeded"] = JSON.stringify(pending.seeded);
        }
        for (const [key, value] of Object.entries(groupData)) {
          if (!/^curriculum-color-semester-groups-v3(?::\d{4})?(?:-seeded)?$/.test(key) || typeof value !== "string") {
            throw new Error("백업의 그룹 저장 형식이 잘못되었습니다.");
          }
          const groupKey = key.replace(/-seeded$/, "");
          validateApplicationGroupData(
            JSON.parse(groupData[groupKey] || "[]"),
            JSON.parse(groupData[groupKey + "-seeded"] || "[]")
          );
          entries.push([key, value]);
        }
        if (!window.confirm("백업에 포함된 편제표·차수·선택 그룹으로 이 브라우저의 자료를 교체합니다. 현재 자료를 먼저 백업했나요? 온라인 서버 자료는 변경하지 않습니다. 원본 엑셀은 별도로 보관해야 합니다.")) return;
        for (const [key] of entries) previous.set(key, localStorage.getItem(key));
        for (const [key, value] of entries) {
          localStorage.setItem(key, value);
          written.push(key);
        }
        if (afterWrite) await afterWrite();
        statePersistenceReady = false;
        statePersistenceBlocked = true;
        if (statePersistenceTimer !== null) window.clearTimeout(statePersistenceTimer);
        window.location.reload();
      } catch (error) {
        const rollbackErrors = [];
        for (const key of written.reverse()) {
          try {
            if (previous.get(key) === null) localStorage.removeItem(key);
            else localStorage.setItem(key, previous.get(key));
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError.message);
          }
        }
        if (rollbackErrors.length) {
          statePersistenceBlocked = true;
          updateWorkspaceSaveStatus(`백업 복원 및 원래 자료 되돌리기 실패: ${rollbackErrors.join(", ")}`, true);
        }
        showAppToast(`백업 복원 실패: ${error.message}`, "error");
      }
    }

    function clearPersistedState() {
      if (statePersistenceTimer !== null) {
        window.clearTimeout(statePersistenceTimer);
        statePersistenceTimer = null;
      }
      localStorage.removeItem(STORAGE_KEY);
    }

    function renderApplicationMode() {
      const mode = state.applicationMode === "web" ? "web" : "external";
      state.applicationMode = mode;
      const external = mode === "external";
      const externalButton = $("#applicationModeExternal");
      const webButton = $("#applicationModeWeb");
      externalButton.setAttribute("aria-pressed", String(external));
      webButton.setAttribute("aria-pressed", String(!external));
      $("#applicationModeSummary").textContent = external
        ? "외부 프로그램 결과 취합"
        : "웹앱으로 학생 신청";
      $("#applicationModeStatus").textContent = external
        ? "외부 프로그램 결과 취합 모드입니다. 과목·그룹을 확인한 뒤 결과 엑셀을 검증·반영하세요."
        : "웹앱 신청 모드입니다. 과목·그룹을 확인한 뒤 교사 로그인 후 학생 신청을 관리하세요.";
      $("#applicationResultsTab").classList.toggle("hidden", !external);
      $("#applicationResultsPanel").classList.toggle("hidden", !external);
      $("#applicationOnlineTab").classList.toggle("hidden", external);
      $("#supabaseTeacherPanel").classList.toggle("hidden", external);
      const nextAction = $("#applicationGuideResults");
      nextAction.innerHTML = external
        ? "<b>2</b> 결과 엑셀 업로드·검증"
        : "<b>2</b> 웹 수강신청 관리";
      const activeTab = document.querySelector("#applicationWorkspaceTabs [aria-selected='true']");
      if (activeTab?.classList.contains("hidden")) openApplicationWorkspaceTab("groups");
    }

    function selectApplicationMode(mode) {
      if (!["external", "web"].includes(mode) || state.applicationMode === mode) return;
      state.applicationMode = mode;
      renderApplicationMode();
      openApplicationWorkspaceTab("groups");
      persistState();
    }

    function workflowStepStates() {
      const hasPlan = !!state.curriculumImportedLayout || !!state.curriculumPlan.length;
      const hasResult = state.students.length > 0;
      const preparation = typeof getApplicationPreparationStatus === "function" ? getApplicationPreparationStatus() : null;
      const prepIssue = !preparation || preparation.storageIssue || !preparation.subjects || preparation.unassigned ||
        preparation.invalidGroups || !preparation.hasSelections;
      const round = state.currentRound;
      const roundState = typeof roundStatus === "function" ? roundStatus(round) : "draft";
      // 시수 통계는 내년도·올해·전년도 입학생 편제표가 모두 있어야 계산할 수 있다.
      let missingCohorts = 0;
      if (typeof annualSourceCohorts === "function" && typeof $ === "function") {
        const schoolYear = Number($("#schoolYear")?.value);
        const cohorts = annualSourceCohorts();
        missingCohorts = [0, 1, 2].filter((grade) => !cohorts[String(schoolYear - grade + 1)]?.plan?.length).length;
      }
      return {
        1: hasPlan ? ["done", "완료"] : ["todo", "필요"],
        2: hasResult ? ["done", "반영됨"] : hasPlan && prepIssue ? ["todo", "확인"] : ["wait", "대기"],
        3: hasResult ? ["done", "가능"] : ["wait", "대기"],
        4: roundState === "confirmed" ? ["done", "확정"] : roundState === "review" ? ["todo", "검토 중"]
          : hasResult ? ["todo", "확정 필요"] : ["wait", "대기"],
        7: roundState !== "confirmed" ? ["wait", "대기"] : missingCohorts ? ["todo", "편제표 필요"] : ["done", "가능"]
      };
    }

    function renderWorkflowStepStates() {
      const states = workflowStepStates();
      for (const button of workflowSteps.querySelectorAll("[data-workflow-step]")) {
        const entry = states[Number(button.dataset.workflowStep)];
        let badge = button.querySelector(".workflow-step-state");
        if (!entry) { badge?.remove(); continue; }
        if (!badge) {
          badge = document.createElement("span");
          badge.className = "workflow-step-state";
          button.append(badge);
        }
        badge.dataset.state = entry[0];
        badge.textContent = entry[1];
      }
      const step = Number(state.workflowStep);
      if (step === 5 || step === 6) $("#workflowDeferred").open = true;
    }

    function renderWorkflowLayout() {
      const step = Number(state.workflowStep) || 3;
      if (step === 1) renderCurriculumStep();
      renderRoundStatus();
      if (step === 2) renderApplicationSubjects();
      renderApplicationMode();
      for (const button of workflowSteps.querySelectorAll("[data-workflow-step]")) {
        button.setAttribute("aria-current", Number(button.dataset.workflowStep) === step ? "step" : "false");
      }
      $("#workflowStep1Panel").classList.toggle("hidden", step !== 1);
      $("#workflowStep2Panel").classList.toggle("hidden", step !== 2);
      $("#workflowStep6Panel").classList.toggle("hidden", step !== 6);
      $("#workflowStep7Panel").classList.toggle("hidden", step !== 7);
      $("#certificatePanel").classList.toggle("hidden", step !== 3);
      $("#aggregatePanel").classList.toggle("hidden", step !== 4);
      $("#closurePanel").classList.toggle("hidden", step !== 4);
      $("#retakePanel").classList.toggle("hidden", step !== 4);
      $("#roundComparePanel").classList.toggle("hidden", step !== 4);
      $("#classifierPanel").classList.toggle("hidden", step !== 5);
      if (step === 4) {
        renderClosurePanel(state.currentRound);
        renderRetakePanel();
        if (typeof renderRoundCompare === "function") renderRoundCompare();
      }
      if (step === 7 && typeof renderHoursStats === "function") renderHoursStats();
      if (typeof renderRoundStatusControls === "function") renderRoundStatusControls();
      if (typeof syncNextYearClassInputs === "function") syncNextYearClassInputs();
      renderWorkspaceContext();
      $("#workflowMenuToggle").textContent = `단계 선택 · ${workflowStepLabel(state.workflowStep)}`;
    }

    // 내부 단계 번호 5·6(이동수업·시간표)은 보류 중이고 시수 통계는 7번으로 저장한다.
    function workflowStepLabel(step) {
      return ({ 1: "1단계", 2: "2단계", 3: "3단계", 4: "4단계", 7: "5단계", 5: "보류 · 이동수업", 6: "보류 · 시간표" })[Number(step)] || "1단계";
    }

    function switchWorkflowStep(step, skipPersist = false) {
      const next = Number(step);
      state.workflowStep = [1, 2, 3, 4, 5, 6, 7].includes(next) ? next : 1;
      renderWorkflowLayout();
      $("#workflowMenuToggle").setAttribute("aria-expanded", "false");
      $("#workflowMenuToggle").textContent = `단계 선택 · ${workflowStepLabel(state.workflowStep)}`;
      if (!skipPersist) persistState();
    }

    function renderWorkspaceContext() {
      const summary = $("#workspaceContextSummary");
      if (!summary) return;
      renderBackupStatus();
      renderWorkflowStepStates();
      const step = Number(state.workflowStep);
      const grade = state.applicationMenuGrade || "1";
      const cohortPlanLabel = state.curriculumPlanType === "annual"
        ? `${state.curriculumCohortYear}학년도 전학년 편제표`
        : `${state.curriculumCohortYear}학년도 신입생 3개년 편제표`;
      const scope = step === 1
        ? cohortPlanLabel
        : step === 2
          ? `현재 ${grade}학년 → ${Number(grade) + 1}학년 신청 · ${applicationCohortYear(grade)}학년도 입학생 편제표`
          : step === 7
            ? `${Number($("#schoolYear").value) + 1}학년도 교과별 시수 통계`
            : `현재 1·2학년 결과 · ${state.currentRound}차`;
      summary.textContent = `${$("#schoolYear").value}학년도 · ${scope}`;
      const dropHint = document.getElementById("resultDropHint");
      if (dropHint) dropHint.textContent = `현 ${grade}학년(${Number(grade) + 1}학년 신청) ${state.currentRound}차 수강신청 결과 엑셀을 여기에 놓으세요`;
      const selector = $("#workspaceRound");
      const options = applicationRoundNumbers().map((round) =>
        `<option value="${round}">${round}차</option>`).join("");
      if (selector.innerHTML !== options) selector.innerHTML = options;
      selector.value = state.currentRound;
      selector.disabled = step === 1 || step === 6 || step === 7;
      const hasPlan = !!state.curriculumImportedLayout || !!state.curriculumPlan.length;
      const message = $("#workflowReadinessMessage");
      const action = $("#workflowNextAction");
      const roundConfirmed = typeof isRoundLocked === "function" && isRoundLocked(state.currentRound);
      if (step === 1) {
        message.textContent = hasPlan
          ? state.curriculumPlanType === "annual"
            ? "전학년 편제표는 올해 1·2·3학년 입학생의 3개년 편제표에서 자동으로 만든 자료입니다. 수정은 각 입학생 편제표에서 하고 '다시 만들기'로 반영하세요."
            : "편제표를 확인한 뒤 2단계에서 신청 학년·그룹·선택 수를 확인하세요. 올해 전학년 편제표는 수강신청 기준에 사용하지 않습니다."
          : state.curriculumPlanType === "annual"
            ? `${state.curriculumCohortYear}학년도 전학년 편제표는 올해 1·2·3학년 입학생 3개년 편제표를 모두 올린 뒤 '만들기'로 생성합니다.`
            : `${state.curriculumCohortYear}학년도 신입생의 3개년 편제표를 먼저 업로드하세요.`;
        action.textContent = state.curriculumPlanType === "annual"
          ? "수강신청 기준 편제표 확인"
          : hasPlan ? "과목·그룹 설정으로" : "편제표 파일 선택";
        action.dataset.nextStep = state.curriculumPlanType === "annual"
          ? `cohort:${applicationCohortYear(grade)}`
          : hasPlan ? "2" : "upload";
      } else if (step === 2) {
        const preparation = typeof getApplicationPreparationStatus === "function" ? getApplicationPreparationStatus() : null;
        const gradeStudents = state.students.filter((student) => String(student.grade) === grade).length;
        if (preparation?.storageIssue) {
          message.textContent = preparation.storageIssue;
          action.textContent = "그룹 설정 원본 확인";
          action.dataset.nextStep = "groups";
        } else if (!preparation || !preparation.subjects) {
          message.textContent = `${applicationCohortYear()}학년도 입학생 편제표에서 신청 학년 과목을 찾지 못했습니다. 편제표의 학생선택 과목과 학기를 확인하세요.`;
          action.textContent = "해당 입학연도 편제표로";
          action.dataset.nextStep = "1";
        } else if (preparation.unassigned || preparation.invalidGroups || !preparation.hasSelections) {
          message.textContent = `신청 과목 ${preparation.subjects}개 · 미분류 ${preparation.unassigned}개 · 설정 확인이 필요한 그룹 ${preparation.invalidGroups}개. 그룹과 선택 수를 맞춰야 결과 검증이 정확합니다.`;
          action.textContent = "과목·그룹 설정 확인";
          action.dataset.nextStep = "groups";
        } else if (!gradeStudents && state.applicationMode === "web") {
          message.textContent = `신청 과목 ${preparation.subjects}개 · 그룹 준비 완료. 웹앱으로 학생 신청을 받으려면 교사 로그인 후 신청을 생성하세요.`;
          action.textContent = "웹 수강신청 관리";
          action.dataset.nextStep = "online";
        } else if (!gradeStudents) {
          message.textContent = `신청 과목 ${preparation.subjects}개 · 그룹 준비 완료. 외부 프로그램에서 받은 현재 ${grade}학년 ${state.currentRound}차 결과 엑셀을 업로드하세요.`;
          action.textContent = "결과 엑셀 업로드";
          action.dataset.nextStep = "results";
        } else {
          message.textContent = `${state.currentRound}차 현재 ${grade}학년 결과 ${gradeStudents}명 반영됨. 4단계에서 집계를 확인하고 개설 여부를 확정하세요.`;
          action.textContent = "집계·개설 확정으로";
          action.dataset.nextStep = "4";
        }
      } else if (step === 7) {
        const readiness = typeof hoursStatsReadiness === "function" ? hoursStatsReadiness() : null;
        message.textContent = readiness?.message || "내년도 학급 수와 교사 수를 입력하면 교과별 평균 시수를 계산합니다.";
        action.textContent = readiness?.actionLabel || "집계·개설 확정으로";
        action.dataset.nextStep = readiness?.nextStep || "4";
      } else if (step === 4 && roundConfirmed) {
        message.textContent = `${state.currentRound}차 결과가 확정되었습니다. 5단계에서 내년도 교과별 시수 통계를 작성하세요.`;
        action.textContent = "시수 통계로";
        action.dataset.nextStep = "7";
      } else {
        message.textContent = state.students.length
          ? `${state.currentRound}차 학생 ${state.students.length}명 · 확인서와 집계는 두 학년 결과를 함께 사용합니다. 기준 미달은 폐강 확정이 아닙니다.`
          : `${state.currentRound}차 결과가 없습니다. 2단계에서 외부 프로그램 결과 엑셀을 업로드하세요.`;
        action.textContent = state.students.length && step !== 4 ? "집계·개설/폐강 검토" : "결과 업로드로";
        action.dataset.nextStep = state.students.length && step !== 4 ? "4" : "2";
      }
    }

    function applicationRoundNumbers() {
      const rounds = new Set(["1", ...Object.keys(state.rounds || {})]);
      return [...rounds].filter((round) => /^[1-9]\d{0,8}$/.test(round) && Number.isSafeInteger(Number(round)))
        .sort((a, b) => Number(a) - Number(b));
    }

    function addApplicationRound() {
      const rounds = applicationRoundNumbers();
      const nextNumber = Math.max(...rounds.map(Number)) + 1;
      if (!Number.isSafeInteger(nextNumber) || nextNumber > 999999999) throw new Error("추가할 차수 번호가 너무 큽니다.");
      const next = String(nextNumber);
      state.rounds[next] = null;
      state.roundClosures[next] = {};
      switchRound(next);
    }

    function switchRound(round, skipRender = false) {
      const next = String(round);
      if (!/^[1-9]\d{0,8}$/.test(next) || !Object.hasOwn(state.rounds || {}, next)) return;
      if (next === state.currentRound) return;
      syncActiveRound();
      state.currentRound = next;
      const data = state.rounds[next];
      state.students = data ? data.students : [];
      state.courses = data ? data.courses : [];
      state.fileName = data ? data.fileName : "";
      state.classOverrides = data ? { ...data.classOverrides } : {};
      state.semesterAssignments = {...data?.semesterAssignments};
      state.groupAssignments = {...data?.groupAssignments};
      state.customGroupNames = [...(data?.customGroupNames || [])];
      state.selectedCourseColumns = [];
      state.lastSelectedCourseColumn = null;
      state.selectedId = state.students[0]?.id || null;
      $("#round").value = `${next}차`;
      $("#fileName").textContent = state.fileName || "불러온 파일 없음";
      applyClassFilterOptions(state.students);
      renderRoster();
      renderPreview();
      renderSemesterClassifier();
      renderAggregate();
      renderRoundStatus();
      if (!skipRender) renderWorkflowLayout();
      persistState();
    }

    function clearApplicationRound() {
      state.applicationImportRevision++;
      syncActiveRound();
      state.rounds[state.currentRound] = null;
      if (state.roundClosures[state.currentRound]) state.roundClosures[state.currentRound] = {};
      if (state.roundStatuses?.[state.currentRound]) delete state.roundStatuses[state.currentRound];
      if (typeof clearResultImportPreview === "function") clearResultImportPreview();
      state.students = [];
      state.courses = [];
      state.selectedId = null;
      state.fileName = "";
      state.classOverrides = {};
      state.semesterAssignments = {};
      state.groupAssignments = {};
      state.customGroupNames = [];
      state.selectedCourseColumns = [];
      state.lastSelectedCourseColumn = null;
      $("#fileName").textContent = "불러온 파일 없음";
      $("#searchInput").value = "";
      $("#searchInput").disabled = true;
      $("#classFilter").disabled = true;
      applyClassFilterOptions([]);
      renderRoster();
      renderPreview();
      renderSemesterClassifier();
      renderAggregate();
      renderRoundStatus();
      renderWorkflowLayout();
      persistState();
    }

    function resetWorkspace(clearSaved = false) {
      state.students = [];
      state.courses = [];
      state.selectedId = null;
      state.fileName = "";
      state.classOverrides = {};
      state.currentRound = "1";
      state.rounds = { "1": null };
      state.roundClosures = { "1": {} };
      state.roundStatuses = {};
      state.hoursStats = {};
      state.curriculumVersions = {};
      state.semesterAssignments = {};
      state.customGroupNames = [];
      state.groupAssignments = {};
      state.selectedCourseColumns = [];
      state.lastSelectedCourseColumn = null;
      state.curriculumPlanFileName = "";
      state.curriculumImportedLayout = null;
      state.curriculumTemplateRows = [];
      state.curriculumPlan = [];
      state.curriculumCohortYear = String($("#schoolYear").value || "2026");
      state.curriculumPlanType = "cohort";
      state.curriculumCohorts = {};
      state.curriculumAnnualPlans = {};
      state.curriculumTargetGrade = "1";
      state.curriculumTargetDivision = "학생 선택 교육과정";
      state.curriculumTargetArea = "";
      state.curriculumTargetDetail = "일반선택";
      state.curriculumBundleName = "선택묶음1";
      state.curriculumBundlePick = 1;
      state.curriculumUndoStack = [];
      state.curriculumEditBefore = null;
      state.curriculumEditUndoRecorded = false;
      state.curriculumSelectedRow = null;
      state.curriculumSelectedColumn = null;
      state.curriculumMutationRevision += 1;
      state.curriculumPlanFilters = { grade: "", division: "", area: "", detail: "", query: "" };
      state.workflowStep = 1;
      $("#fileName").textContent = "불러온 파일 없음";
      $("#round").value = "1차";
      $("#closureContent").innerHTML = "";
      $("#retakeContent").innerHTML = "";
      $("#studentCount").textContent = "0명";
      $("#studentList").innerHTML = '<div class="empty-roster">엑셀 파일을 불러오면<br>학생 목록이 여기에 표시됩니다.</div>';
      $("#searchInput").value = "";
      $("#classFilter").innerHTML = '<option value="">전체 반</option>';
      $("#searchInput").disabled = true;
      $("#classFilter").disabled = true;
      $("#aggregateDescription").textContent = "학생별 신청 명단에서 과목별 인원을 계산했습니다.";
      $("#semesterClassifier").innerHTML = "";
      $("#aggregateContent").innerHTML = '<div class="aggregate-empty">학생별 신청 명단을 불러오면 집계표가 표시됩니다.</div>';
      $("#downloadAggregate").disabled = true;
      $("#curriculumTemplateFileName").textContent = "편제표를 불러오지 않았습니다.";
      $("#curriculumPlanWrap").innerHTML = '<div class="curriculum-empty">편제표 파일을 불러오면 여기에 표시됩니다.</div>';
      $("#curriculumFilterGrade").innerHTML = '<option value="">전체 학년</option>';
      $("#curriculumFilterArea").innerHTML = '<option value="">전체 교과군</option>';
      $("#curriculumFilterDetail").innerHTML = '<option value="">선택 유형</option>';
      $("#curriculumFilterQuery").value = "";
      $("#curriculumFilterCount").textContent = "0개 과목 표시";
      if (rosterInput) rosterInput.value = "";
      if (curriculumPlanInput) curriculumPlanInput.value = "";
      renderPreview();
      renderCurriculumStep();
      state.workflowStep = 1;
      renderWorkflowLayout();
      if (clearSaved) clearPersistedState();
    }

    function restorePersistedState() {
      let raw = null;
      try {
        raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
          resetWorkspace(false);
          statePersistenceBlocked = false;
          protectedStoredState = null;
          lastSavedWorkspace = null;
          updateWorkspaceSaveStatus("이 브라우저에 저장 완료");
          return;
        }
        const saved = JSON.parse(raw);
        validateWorkspaceData(saved);
        state.applicationMenuGrade = saved.applicationMenuGrade === "2" ? "2" : "1";
        // 차수별 데이터 복원. 구 버전 저장분(students/courses만 있는 경우)은 1차로 이관한다.
        const normalizeRoundData = (data) => {
          if (!data) return null;
          return {
            fileName: String(data.fileName || ""),
            gradeFiles: data.gradeFiles && typeof data.gradeFiles === "object" ? data.gradeFiles : {},
            students: data.students,
            courses: normalizeCourses(Array.isArray(data.courses) ? data.courses : []),
            classOverrides: data.classOverrides && typeof data.classOverrides === "object" ? data.classOverrides : {},
            semesterAssignments: data.semesterAssignments,
            groupAssignments: data.groupAssignments,
            customGroupNames: data.customGroupNames
          };
        };
        if (saved.rounds && typeof saved.rounds === "object") {
          state.rounds = Object.fromEntries(Object.entries(saved.rounds)
            .filter(([round]) => /^[1-9]\d{0,8}$/.test(round))
            .map(([round, data]) => [round, normalizeRoundData(data)]));
          if (!state.rounds["1"]) state.rounds["1"] = null;
        } else {
          state.rounds = { "1": normalizeRoundData({ fileName: saved.fileName, students: saved.students, courses: saved.courses, classOverrides: saved.classOverrides }) };
        }
        const savedRound = String(saved.currentRound || "1");
        if (!/^[1-9]\d{0,8}$/.test(savedRound) || !Number.isSafeInteger(Number(savedRound))) throw new Error("invalid");
        state.currentRound = savedRound;
        if (!Object.hasOwn(state.rounds, state.currentRound)) state.rounds[state.currentRound] = null;
        state.roundClosures = saved.roundClosures && typeof saved.roundClosures === "object"
          ? Object.fromEntries(applicationRoundNumbers().map((round) =>
            [round, saved.roundClosures[round] && typeof saved.roundClosures[round] === "object" ? saved.roundClosures[round] : {}]))
          : Object.fromEntries(applicationRoundNumbers().map((round) => [round, {}]));
        const plainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
        state.roundStatuses = plainObject(saved.roundStatuses)
          ? Object.fromEntries(Object.entries(saved.roundStatuses)
            .filter(([round, entry]) => /^[1-9]\d{0,8}$/.test(round) && plainObject(entry) &&
              ["draft", "review", "confirmed"].includes(entry.status))
            .map(([round, entry]) => [round, {
              status: entry.status,
              updatedAt: String(entry.updatedAt || ""),
              ...(plainObject(entry.snapshot) && Array.isArray(entry.snapshot.rows) ? { snapshot: entry.snapshot } : {})
            }]))
          : {};
        state.hoursStats = plainObject(saved.hoursStats)
          ? Object.fromEntries(Object.entries(saved.hoursStats).filter(([year, value]) => /^\d{4}$/.test(year) && plainObject(value)))
          : {};
        state.curriculumVersions = plainObject(saved.curriculumVersions)
          ? Object.fromEntries(Object.entries(saved.curriculumVersions)
            .filter(([year, versions]) => /^(?:\d{4}|annual:\d{4})$/.test(year) && Array.isArray(versions))
            .map(([year, versions]) => [year, versions.filter((version) =>
              plainObject(version) && typeof version.id === "string" && Array.isArray(version.plan))]))
          : {};
        const activeRound = state.rounds[state.currentRound];
        state.students = activeRound ? activeRound.students : [];
        state.courses = activeRound ? activeRound.courses : [];
        state.selectedId = saved.selectedId || state.students[0]?.id || null;
        state.fileName = activeRound ? activeRound.fileName : "";
        state.classOverrides = activeRound ? { ...activeRound.classOverrides } : {};
        state.semesterAssignments = (activeRound?.semesterAssignments || saved.semesterAssignments) && typeof (activeRound?.semesterAssignments || saved.semesterAssignments) === "object"
          ? (activeRound?.semesterAssignments || saved.semesterAssignments)
          : {};
        state.customGroupNames = Array.isArray(activeRound?.customGroupNames || saved.customGroupNames)
          ? (activeRound?.customGroupNames || saved.customGroupNames).map((name) => String(name ?? "").trim()).filter(Boolean)
          : [];
        state.groupAssignments = (activeRound?.groupAssignments || saved.groupAssignments) && typeof (activeRound?.groupAssignments || saved.groupAssignments) === "object"
          ? (activeRound?.groupAssignments || saved.groupAssignments)
          : {};
        state.curriculumPlanFileName = String(saved.curriculumPlanFileName || "");
        state.curriculumTopCollapsed = saved.curriculumTopCollapsed !== false;
        state.curriculumImportedLayout = saved.curriculumImportedLayout &&
          Array.isArray(saved.curriculumImportedLayout.rows)
          ? saved.curriculumImportedLayout
          : null;
        state.curriculumTemplateRows = Array.isArray(saved.curriculumTemplateRows)
          ? saved.curriculumTemplateRows.map((row) => normalizeCurriculumPlanRow(row))
          : [];
        state.curriculumPlan = Array.isArray(saved.curriculumPlan)
          ? saved.curriculumPlan.map((row) => normalizeCurriculumPlanRow(row))
          : [];
        state.curriculumCohorts = saved.curriculumCohorts && typeof saved.curriculumCohorts === "object"
          ? Object.fromEntries(Object.entries(saved.curriculumCohorts).filter(([year, cohort]) =>
            /^\d{4}$/.test(year) && cohort && typeof cohort === "object").map(([year, cohort]) => [year, {
            fileName: String(cohort.fileName || ""),
            importedLayout: cohort.importedLayout && Array.isArray(cohort.importedLayout.rows) ? cohort.importedLayout : null,
            templateRows: Array.isArray(cohort.templateRows) ? cohort.templateRows.map((row) => normalizeCurriculumPlanRow(row)) : [],
            plan: Array.isArray(cohort.plan) ? cohort.plan.map((row) => normalizeCurriculumPlanRow(row)) : []
          }]))
          : {};
        state.curriculumAnnualPlans = saved.curriculumAnnualPlans && typeof saved.curriculumAnnualPlans === "object"
          ? Object.fromEntries(Object.entries(saved.curriculumAnnualPlans).filter(([year, plan]) =>
            /^\d{4}$/.test(year) && plan && typeof plan === "object").map(([year, plan]) => [year, {
            fileName: String(plan.fileName || ""),
            importedLayout: plan.importedLayout && Array.isArray(plan.importedLayout.rows) ? plan.importedLayout : null,
            templateRows: Array.isArray(plan.templateRows) ? plan.templateRows.map((row) => normalizeCurriculumPlanRow(row)) : [],
            plan: Array.isArray(plan.plan) ? plan.plan.map((row) => normalizeCurriculumPlanRow(row)) : []
          }]))
          : {};
        state.curriculumPlanFilters = saved.curriculumPlanFilters &&
          typeof saved.curriculumPlanFilters === "object"
          ? {
            grade: String(saved.curriculumPlanFilters.grade || ""),
            division: String(saved.curriculumPlanFilters.division || ""),
            area: String(saved.curriculumPlanFilters.area || ""),
            detail: String(saved.curriculumPlanFilters.detail || ""),
            query: String(saved.curriculumPlanFilters.query || "")
          }
          : { grade: "", division: "", area: "", detail: "", query: "" };
        state.curriculumTargetGrade = ["1", "2", "3"].includes(String(saved.curriculumTargetGrade))
          ? String(saved.curriculumTargetGrade)
          : "1";
        state.curriculumTargetDivision = normalizeCurriculumDivisionFilter(saved.curriculumTargetDivision || "학생 선택 교육과정");
        state.curriculumTargetArea = String(saved.curriculumTargetArea || "");
        state.curriculumTargetDetail = normalizeCurriculumDetailFilter(saved.curriculumTargetDetail || "일반선택");
        state.curriculumBundleName = String(saved.curriculumBundleName || "선택묶음1").trim() || "선택묶음1";
        state.curriculumBundlePick = Math.max(1, Number(saved.curriculumBundlePick) || 1);
        state.selectedCourseColumns = [];
        state.lastSelectedCourseColumn = null;
        const savedStep = Number(saved.workflowStep);
        state.workflowStep = savedStep > 6 && !saved.schemaVersion
          ? ({7:4, 8:4, 9:5, 10:6})[savedStep] || 1
          : [1, 2, 3, 4, 5, 6, 7].includes(savedStep) ? savedStep : 1;
        state.applicationMode = ["external", "web"].includes(saved.applicationMode)
          ? saved.applicationMode
          : "external";

        $("#fileName").textContent = state.fileName || "불러온 파일 없음";
        $("#openingPercent").value = saved.openingPercent || "90";
        $("#divisionPercent").value = saved.divisionPercent || "110";
        $("#schoolYear").value = saved.schoolYear || $("#schoolYear").value;
        const storedCohortYear = /^\d{4}$/.test(String(saved.curriculumCohortYear || ""))
          ? String(saved.curriculumCohortYear)
          : String($("#schoolYear").value || "2026");
        state.curriculumPlanType = saved.curriculumPlanType === "annual" ? "annual" : "cohort";
        const availableCohortYears = CURRICULUM_COHORT_GRADES.map((grade) =>
          String(Number($("#schoolYear").value) - Number(grade) + 1));
        const activeCohortYear = state.curriculumPlanType === "annual"
          ? String($("#schoolYear").value || "2026")
          : availableCohortYears.includes(storedCohortYear)
          ? storedCohortYear
          : String($("#schoolYear").value || "2026");
        if (!Object.keys(state.curriculumCohorts).length && (state.curriculumImportedLayout || state.curriculumPlan.length)) {
          state.curriculumCohorts[storedCohortYear] = {
            fileName: state.curriculumPlanFileName,
            importedLayout: state.curriculumImportedLayout,
            templateRows: state.curriculumTemplateRows,
            plan: state.curriculumPlan
          };
        }
        const restoredFilters = state.curriculumPlanFilters;
        state.curriculumCohortYear = activeCohortYear;
        if (state.curriculumPlanType === "annual") {
          if (!Object.keys(state.curriculumAnnualPlans).length &&
              (state.curriculumImportedLayout || state.curriculumPlan.length)) {
            state.curriculumAnnualPlans[activeCohortYear] = {
              fileName: state.curriculumPlanFileName,
              importedLayout: state.curriculumImportedLayout,
              templateRows: state.curriculumTemplateRows,
              plan: state.curriculumPlan
            };
          }
          loadCurriculumPlanData("annual", activeCohortYear);
        } else {
          loadCurriculumPlanData("cohort", activeCohortYear);
        }
        state.curriculumPlanFilters = restoredFilters;
        $("#round").value = `${state.currentRound}차`;
        $("#confirmDate").value = saved.confirmDate || $("#confirmDate").value;
        $("#schoolName").value = saved.schoolName || $("#schoolName").value;
        $("#searchInput").disabled = !state.students.length;
        $("#classFilter").disabled = !state.students.length;
        applyClassFilterOptions(state.students);
        $("#studentCount").textContent = `${state.students.length} / ${state.students.length}명`;
        renderRoster();
        renderPreview();
        renderCurriculumStep();
        renderSemesterClassifier();
        renderAggregate();
        renderWorkflowLayout();
        protectedStoredState = null;
        statePersistenceBlocked = false;
        lastSavedWorkspace = raw;
        updateWorkspaceSaveStatus("로컬 자료 복원 완료");
        if (state.students.length) {
          status.style.color = "#287956";
          status.textContent = `새로고침 이전 파일(${state.fileName || "이전 파일"})을 복원했습니다.`;
        }
      } catch (error) {
        statePersistenceBlocked = true;
        protectedStoredState = raw;
        resetWorkspace(false);
        updateWorkspaceSaveStatus(`복원 실패 · 기존 저장 원본 보호 중: ${error.message}`, true);
      }
    }

    function validateWorkspaceData(saved) {
      const object = (value) => value && typeof value === "object" && !Array.isArray(value);
      if (!object(saved) || !Array.isArray(saved.students) || !Array.isArray(saved.courses)) {
        throw new Error("학생·과목 저장 형식이 잘못되었습니다.");
      }
      if (saved.schemaVersion !== undefined && saved.schemaVersion !== 2) {
        throw new Error("지원하지 않는 저장 버전입니다. 최신 앱에서 복원하세요.");
      }
      if (saved.schoolYear !== undefined && !/^(?:20\d{2}|2100)$/.test(String(saved.schoolYear))) {
        throw new Error("저장된 학년도가 잘못되었습니다.");
      }
      const validateRows = (data) => {
        if (!object(data) || !Array.isArray(data.students) || !Array.isArray(data.courses) ||
            data.students.some((student) => !object(student) || !["1", "2", "3"].includes(String(student.grade)) ||
              !Array.isArray(student.selections)) ||
            data.courses.some((course) => !object(course))) {
          throw new Error("차수별 학생·과목 자료가 손상되었습니다.");
        }
      };
      validateRows(saved);
      if (saved.rounds !== undefined) {
        if (!object(saved.rounds)) throw new Error("차수 저장 형식이 잘못되었습니다.");
        for (const [round, data] of Object.entries(saved.rounds)) {
          if (!/^[1-9]\d{0,8}$/.test(round)) throw new Error("차수 번호가 잘못되었습니다.");
          if (data !== null) validateRows(data);
        }
      }
      const validateLayout = (layout) => {
        if (layout !== null && layout !== undefined &&
            (!object(layout) || !Array.isArray(layout.rows) || layout.rows.some((row) => !Array.isArray(row)))) {
          throw new Error("편제표 저장 형식이 잘못되었습니다.");
        }
      };
      validateLayout(saved.curriculumImportedLayout);
      if (saved.curriculumCohorts !== undefined) {
        if (!object(saved.curriculumCohorts)) throw new Error("입학연도별 자료가 손상되었습니다.");
        for (const [year, cohort] of Object.entries(saved.curriculumCohorts)) {
          if (!/^\d{4}$/.test(year) || !object(cohort)) throw new Error("입학연도 저장 형식이 잘못되었습니다.");
          validateLayout(cohort.importedLayout);
        }
        if (saved.curriculumAnnualPlans !== undefined) {
          if (!object(saved.curriculumAnnualPlans)) throw new Error("전학년 편제표 자료가 손상되었습니다.");
          for (const [year, plan] of Object.entries(saved.curriculumAnnualPlans)) {
            if (!/^\d{4}$/.test(year) || !object(plan)) throw new Error("전학년 편제표 저장 형식이 잘못되었습니다.");
            validateLayout(plan.importedLayout);
          }
        }
        if (saved.curriculumPlanType !== undefined && !["cohort", "annual"].includes(saved.curriculumPlanType)) {
          throw new Error("편제표 관리 유형이 잘못되었습니다.");
        }
      }
    }

    function columnIndex(reference) {
      const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "";
      let result = 0;
      for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
      return result - 1;
    }

    function curriculumCellFill(layout, row, column) {
      const direct = layout.cellFills?.[`${row}:${column}`];
      if (direct) return direct;
      for (const ref of layout.mergedRanges || []) {
        const [a,b=a] = ref.split(":");
        const r1=Number(a.match(/\d+/)[0])-1, r2=Number(b.match(/\d+/)[0])-1;
        const c1=columnIndex(a),c2=columnIndex(b);
        if (row>=r1 && row<=r2 && column>=c1 && column<=c2) return layout.cellFills?.[`${r1}:${c1}`] || "";
      }
      return "";
    }

    function isSelected(value) {
      if (value === "" || value === null || value === undefined) return false;
      const normalized = String(value).trim();
      return normalized !== "" && normalized !== "0" && normalized.toLowerCase() !== "false";
    }

    function parseCourseGroup(rawGroup) {
      const cleaned = String(rawGroup ?? "").trim();
      const match = cleaned.match(/^([12])학기\s*(.*)$/);
      if (!match) {
        return { semesterKey: "", category: cleaned || "과목" };
      }
      return { semesterKey: match[1], category: match[2].trim() || "과목" };
    }

    function parseSemesterFromCourseName(name) {
      const cleaned = String(name ?? "").trim();
      const match = cleaned.match(/(?:\(|\[)?([12])학기(?:\)|\])?/);
      return match ? match[1] : "";
    }

    function parseAssignedGroupLabel(label) {
      const cleaned = normalizeGroupName(label);
      const match = cleaned.match(/^([12])학기\s*(.*)$/);
      if (!match) return { semesterKey: "", category: cleaned };
      return { semesterKey: match[1], category: normalizeGroupName(match[2]) || "과목" };
    }

    function resolveSemesterKey(course) {
      if (course.applicationGroupSource === "online") {
        return course.applicationGroups?.[course.applicationCurrentGrade]?.semester || course.semesterKey || "";
      }
      const key = String(course.column);
      const assigned = state.semesterAssignments[key];
      if (assigned === "1" || assigned === "2") return assigned;
      const assignedGroup = parseAssignedGroupLabel(state.groupAssignments[key]);
      if (assignedGroup.semesterKey) return assignedGroup.semesterKey;
      return course.semesterKey || "";
    }

    function normalizeGroupName(value) {
      return String(value ?? "").replace(/\s+/g, " ").trim();
    }

    function courseDefaultCategory(course) {
      return normalizeGroupName(course.category) || "과목";
    }
    const UNASSIGNED_GROUP = "미분류";

    function availableGroupNames(courses) {
      const names = [];
      const pushUnique = (name) => {
        const normalized = normalizeGroupName(name);
        if (!normalized || names.includes(normalized)) return;
        names.push(normalized);
      };
      for (const custom of state.customGroupNames) pushUnique(custom);
      for (const assigned of Object.values(state.groupAssignments)) pushUnique(assigned);
      for (const course of courses) {
        if (course.applicationGroupSource === "online") pushUnique(resolveCourseCategory(course));
      }
      return names;
    }

    function resolveCourseCategory(course) {
      if (course.applicationGroupSource === "online") {
        const group = course.applicationGroups?.[course.applicationCurrentGrade];
        return group ? `${Number(course.applicationCurrentGrade) + 1}학년 ${group.semester === "0" ? "" : group.semester + "학기 "}${group.name}` : UNASSIGNED_GROUP;
      }
      const key = String(course.column);
      const assigned = normalizeGroupName(state.groupAssignments[key]);
      if (assigned) return assigned;
      return UNASSIGNED_GROUP;
    }

    function resolveCourseCategoryForOutput(course) {
      if (course.applicationGroupSource === "online") {
        return course.applicationGroups?.[course.applicationCurrentGrade]?.name || UNASSIGNED_GROUP;
      }
      const key = String(course.column);
      const assigned = parseAssignedGroupLabel(state.groupAssignments[key]);
      if (assigned.category) return assigned.category;
      return UNASSIGNED_GROUP;
    }

    function semesterTitle(key) {
      if (key === "1") return "1학기";
      if (key === "2") return "2학기";
      return "미분류";
    }

    function applicationGroupForCourse(course, currentGrade, groups = null, semesterOverride = "") {
      const namedGrade = String(course.name || "").match(/\(([23])학년\)$/)?.[1];
      if (namedGrade && namedGrade !== String(Number(currentGrade)+1)) return null;
      if (course.applicationGroupSource === "online") {
        return course.applicationGroups?.[String(currentGrade)] || null;
      }
      const settings = groups || (typeof getApplicationGroupSettings === "function" ? getApplicationGroupSettings() : []);
      const normalize = (name) => normalizeRomanNumerals(String(name ?? "").trim()
        .replace(/\s*\([23]학년\)$/, "").replace(/\s*\([12]학기\)/g, "")
        .replace(/\s*\((?:일반|진로|융합)(?:선택)?\)$/, "")).replace(/\s+/g, "");
      const hint = course.semesterKey || parseSemesterFromCourseName(course.name) ||
        (String(semesterOverride).split("·").length === 1 ? String(semesterOverride) : "");
      const matches = settings.filter((group) => group.grade === String(Number(currentGrade) + 1) &&
        (!hint || group.semester === hint) &&
        group.courses.some((name) => normalize(name) === normalize(course.name)));
      if (matches.length === 1) return {name:matches[0].name, semester:matches[0].semester};
      const assigned = course.applicationGroups?.[String(currentGrade)] || null;
      if (!matches.length) return assigned;
      // 두 학기 묶음에 모두 있는 과목은 결과로 추론해 둔 학기 그룹이 그중 하나일 때만 쓴다.
      return assigned && matches.some((group) => group.name === assigned.name && String(group.semester) === String(assigned.semester))
        ? assigned : null;
    }

    // 편제표의 1·2학기 묶음에 모두 있는데 결과에 학기 표시가 없는 과목은, 이 과목을 고른 학생들이
    // 어느 학기 그룹에서 선택 수가 정확히 하나 모자란지로 실제 선택 학기를 정한다(두 학기에 다 개설돼도 선택은 한 학기에 몰릴 수 있다).
    function inferApplicationGroup(course, grade, groups, students, courses = []) {
      const target = String(Number(grade) + 1);
      const key = (name) => normalizeRomanNumerals(String(name ?? "").replace(/\s*\((?:[23]학년|[12]학기|일반|진로|융합)(?:선택)?\)/g, "")).replace(/\s+/g, "");
      const candidates = groups.filter((group) => group.grade === target && Number.isInteger(group.count) && group.count > 0 &&
        group.courses.some((name) => key(name) === key(course.name)));
      if (candidates.length < 2) return null;
      const choosers = students.filter((student) => String(student.grade) === grade &&
        student.selections.some((selection) => selection.column === course.column));
      if (!choosers.length) return null;
      const scores = candidates.map((group) => ({
        group,
        short: choosers.filter((student) => student.selections.filter((selection) => {
          if (selection.column === course.column) return false;
          const owner = applicationGroupForCourse(selection, grade, groups) ||
            courses.find((item) => item.column === selection.column)?.applicationGroups?.[grade];
          return owner && owner.name === group.name && String(owner.semester) === String(group.semester);
        }).length === group.count - 1).length
      })).sort((a, b) => b.short - a.short);
      if (scores[0].short * 2 < choosers.length || scores[0].short === scores[1].short) return null;
      return { name: scores[0].group.name, semester: scores[0].group.semester, inferred: true };
    }

    // 편제표에는 "미적분Ⅱ"처럼, 결과 파일에는 "미적분2"처럼 적는 로마 숫자 표기를 같은 과목으로 맞춘다.
    function normalizeRomanNumerals(text) {
      const digits = { "Ⅰ": "1", "Ⅱ": "2", "Ⅲ": "3", "Ⅳ": "4", "Ⅴ": "5", "ⅰ": "1", "ⅱ": "2", "ⅲ": "3", "ⅳ": "4", "ⅴ": "5" };
      return String(text ?? "").replace(/[ⅠⅡⅢⅣⅤⅰⅱⅲⅳⅴ]/g, (char) => digits[char]);
    }

    function classifyApplicationRecords(data) {
      const groups = typeof getApplicationGroupSettings === "function" ? getApplicationGroupSettings() : [];
      const warnings = new Set();
      const unresolved = [];
      for (const course of data.courses) {
        course.applicationGroups = {};
        for (const grade of new Set(data.students.filter((student) =>
          student.selections.some((selection) => selection.column === course.column)).map((student) => String(student.grade)))) {
          const group = applicationGroupForCourse(course, grade, groups);
          if (group) course.applicationGroups[grade] = group;
          else unresolved.push({ course, grade });
        }
      }
      // 학기를 추론해야 하는 과목끼리 함께 선택된 경우가 있어, 정해진 과목을 반영하며 몇 번 반복한다.
      for (let pass = 0; pass < 4 && unresolved.length; pass++) {
        const before = unresolved.length;
        for (const item of [...unresolved]) {
          const group = inferApplicationGroup(item.course, item.grade, groups, data.students, data.courses);
          if (!group) continue;
          item.course.applicationGroups[item.grade] = group;
          unresolved.splice(unresolved.indexOf(item), 1);
        }
        if (unresolved.length === before) break;
      }
      for (const { course, grade } of unresolved) warnings.add(`${Number(grade)+1}학년 ${course.name}`);
      for (const student of data.students) for (const course of student.selections) {
        course.applicationGroups = data.courses.find((item) => item.column === course.column)?.applicationGroups || {};
      }
      return [...warnings];
    }

    function courseGroupLabel(course, currentGrade, groupSettings = null) {
      const applicationGroup = currentGrade ? applicationGroupForCourse(course, currentGrade, groupSettings) : null;
      if (applicationGroup) return `${["1", "2"].includes(applicationGroup.semester) ? applicationGroup.semester+"학기 " : ""}${applicationGroup.name}`;
      const semester = resolveSemesterKey(course);
      const category = resolveCourseCategoryForOutput(course);
      if (!semester) return category;
      return category === "과목" ? `${semester}학기` : `${semester}학기 ${category}`;
    }

    function courseIndexByColumn(columnKey) {
      return state.courses.findIndex((course) => String(course.column) === String(columnKey));
    }

    function selectCourseColumns(columns, keepAnchor = true) {
      const normalized = [...new Set(columns.map((value) => String(value)).filter(Boolean))];
      state.selectedCourseColumns = normalized;
      if (!keepAnchor) state.lastSelectedCourseColumn = normalized.at(-1) || null;
    }

    function applyCourseSelection(columnKey, event) {
      const key = String(columnKey || "");
      if (!key) return;
      const anchor = state.lastSelectedCourseColumn ? String(state.lastSelectedCourseColumn) : null;
      const currentSelection = new Set(state.selectedCourseColumns.map((value) => String(value)));
      const useRange = Boolean(event?.shiftKey) && anchor && anchor !== key;
      if (useRange) {
        const anchorIndex = courseIndexByColumn(anchor);
        const keyIndex = courseIndexByColumn(key);
        if (anchorIndex >= 0 && keyIndex >= 0) {
          const [start, end] = anchorIndex < keyIndex ? [anchorIndex, keyIndex] : [keyIndex, anchorIndex];
          const range = state.courses.slice(start, end + 1).map((course) => String(course.column));
          if (event?.ctrlKey || event?.metaKey) {
            for (const column of range) currentSelection.add(column);
            selectCourseColumns([...currentSelection], true);
          } else {
            selectCourseColumns(range, true);
          }
          return;
        }
      }
      if (event?.ctrlKey || event?.metaKey) {
        if (currentSelection.has(key)) currentSelection.delete(key);
        else currentSelection.add(key);
        selectCourseColumns([...currentSelection], true);
      } else {
        selectCourseColumns([key], true);
      }
      state.lastSelectedCourseColumn = key;
    }

    function normalizeCourses(courses) {
      return courses.map((course) => {
        const parsed = parseCourseGroup(course.rawGroup || course.group || "");
        const nameSemester = parseSemesterFromCourseName(course.name);
        return {
          ...course,
          rawGroup: course.rawGroup || course.group || "",
          semesterKey: course.semesterKey || parsed.semesterKey || nameSemester || "",
          category: course.category || parsed.category || "과목"
        };
      });
    }

    // 결과표에 같은 과목이 두 열로 나오면 앞쪽(왼쪽) 열이 1학기, 뒤쪽 열이 2학기다. 학기 표시가 없을 때만 채운다.
    function labelRepeatedCourseColumns(courses) {
      const key = (name) => normalizeRomanNumerals(String(name ?? "").replace(/\s*[（(]\s*[12]\s*학기\s*[)）]/g, "")).replace(/\s+/g, "");
      const byName = new Map();
      for (const course of courses) {
        if (!byName.has(key(course.name))) byName.set(key(course.name), []);
        byName.get(key(course.name)).push(course);
      }
      for (const same of byName.values()) {
        if (same.length !== 2) continue;
        const [first, second] = same.sort((a, b) => a.column - b.column);
        if (!first.semesterKey && !second.semesterKey) { first.semesterKey = "1"; second.semesterKey = "2"; }
        else if (!first.semesterKey && second.semesterKey) first.semesterKey = second.semesterKey === "1" ? "2" : "1";
        else if (first.semesterKey && !second.semesterKey) second.semesterKey = first.semesterKey === "1" ? "2" : "1";
        else continue;
        for (const course of same) {
          if (!/[12]\s*학기/.test(course.name)) course.name = `${course.name.trim()}(${course.semesterKey}학기)`;
        }
      }
      return courses;
    }

    function createRecords(rows) {
      const headerIndex = rows.findIndex((row) =>
        row?.some((value) => String(value).trim() === "학년") &&
        row?.some((value) => String(value).includes("성명")));
      if (headerIndex < 0 || headerIndex < 1) {
        throw new Error("첫 번째 시트에서 학년·반·번호·성명/학점 및 과목 열을 찾지 못했습니다.");
      }

      const creditRow = rows[headerIndex] || [];
      const findColumn = (matcher) => creditRow.findIndex((value) => matcher(String(value ?? "").trim()));
      const gradeColumn = findColumn((value) => value === "학년");
      const classColumn = findColumn((value) => value === "반");
      const numberColumn = findColumn((value) => value.includes("번호"));
      const nameColumn = findColumn((value) => value.includes("성명"));
      if ([gradeColumn, classColumn, numberColumn, nameColumn].some((column) => column < 0)) {
        throw new Error("학년/반/번호/성명 열을 자동으로 찾지 못했습니다. 헤더명을 확인해 주세요.");
      }
      const courseStartColumn = nameColumn + 1;

      const firstCandidate = rows[headerIndex - 1] || [];
      const secondCandidate = rows[headerIndex - 2] || [];
      const firstHasSubjects = firstCandidate.slice(courseStartColumn)
        .filter((value) => String(value ?? "").trim() !== "").length >= 2;
      const secondHasSubjects = secondCandidate.slice(courseStartColumn)
        .filter((value) => String(value ?? "").trim() !== "").length >= 2;
      const firstHasSemesterHints = firstCandidate.slice(courseStartColumn)
        .filter((value) => /[12]학기/.test(String(value ?? "").trim())).length >= 2;
      const titleRow = firstHasSubjects ? firstCandidate : (secondHasSubjects ? secondCandidate : firstCandidate);
      const groupRow = firstHasSemesterHints ? firstCandidate : [];

      const courses = [];
      for (let column = courseStartColumn; column < titleRow.length; column++) {
        const name = String(titleRow[column] ?? "").trim();
        if (!name) continue;
        const rawGroup = String(groupRow[column] ?? "").trim();
        const parsedGroup = parseCourseGroup(rawGroup);
        const nameSemester = parseSemesterFromCourseName(name);
        courses.push({
          column,
          name,
          rawGroup,
          semesterKey: parsedGroup.semesterKey || nameSemester || "",
          category: parsedGroup.category,
          credits: Number(creditRow[column]) || 0
        });
      }
      if (!courses.length) throw new Error("과목명과 학점이 있는 열을 찾지 못했습니다.");
      labelRepeatedCourseColumns(courses);

      const students = [];
      const skippedRows = [];
      for (let index = headerIndex + 1; index < rows.length; index++) {
        const row = rows[index];
        if (!row) continue;
        const grade = String(row[gradeColumn] ?? "").trim();
        const classroom = String(row[classColumn] ?? "").trim();
        const number = String(row[numberColumn] ?? "").trim();
        const name = String(row[nameColumn] ?? "").trim();
        if (!name || !grade || !classroom || !number) {
          if (row.some((value) => String(value ?? "").trim())) {
            const missing = [["학년", grade], ["반", classroom], ["번호", number], ["성명", name]]
              .filter(([, value]) => !value).map(([label]) => label);
            skippedRows.push({ row: index + 1, reason: `${missing.join("·")} 없음`, name });
          }
          continue;
        }
        const selections = courses.filter((course) => isSelected(row[course.column]));
        students.push({
          id: `${grade}-${classroom}-${number}-${name}`,
          grade, classroom, number, name, selections,
          totalCredits: selections.reduce((total, course) => total + course.credits, 0)
        });
      }
      if (!students.length) throw new Error("학생 자료 행을 찾지 못했습니다. 엑셀 열 배치를 확인해 주세요.");
      return { courses, students, skippedRows };
    }

    function createCurriculumPlanRecords(rows, context = "", layoutColumns = null) {
      const semesterHeaderPatterns = [
        /(?:^|[^0-9])1-1(?:$|[^0-9])|1학년.*1학기|1학기.*1학년/,
        /(?:^|[^0-9])1-2(?:$|[^0-9])|1학년.*2학기|2학기.*1학년/,
        /(?:^|[^0-9])2-1(?:$|[^0-9])|2학년.*1학기|1학기.*2학년/,
        /(?:^|[^0-9])2-2(?:$|[^0-9])|2학년.*2학기|2학기.*2학년/,
        /(?:^|[^0-9])3-1(?:$|[^0-9])|3학년.*1학기|1학기.*3학년/,
        /(?:^|[^0-9])3-2(?:$|[^0-9])|3학년.*2학기|2학기.*3학년/
      ];
      const compactHeader = (value) => String(value ?? "").replace(/\s+/g, "").replace(/[()（）]/g, "");
      let headerIndex = -1;
      let columns = null;
      for (let rowIndex = 0; rowIndex < Math.min(rows.length, 30); rowIndex++) {
        const headerRows = rows.slice(Math.max(0, rowIndex - 2), Math.min(rows.length, rowIndex + 3));
        const headerWidth = Math.max(0, ...headerRows.map((row) => row?.length || 0));
        const header = Array.from({ length: headerWidth }, (_, column) =>
          headerRows.map((row) => compactHeader(row?.[column])).filter(Boolean).join("")
        );
        const findColumn = (predicate) => {
          for (let column = 0; column < headerWidth; column++) {
            if (headerRows.some((row) => predicate(compactHeader(row?.[column]), column))) return column;
          }
          return header.findIndex((value, column) => predicate(compactHeader(value), column));
        };
        let subject = findColumn((value) => value.includes("과목명") || value.includes("세부과목"));
        let subjectHeaderOffset = -1;
        for (let offset = 0; offset < headerRows.length; offset++) {
          if ((headerRows[offset] || []).some((value) =>
            compactHeader(value).includes("과목명") || compactHeader(value).includes("세부과목")
          )) {
            subjectHeaderOffset = offset;
            break;
          }
        }
        // 학점 또는 시수 표기 모두 허용한다.
        let baseCredit = findColumn((value) => value.includes("기준학점") || value.includes("기준시수") || value === "기준");
        const opCredit = findColumn((value) => value.includes("운영학점") || value.includes("운영시수") || value === "운영");
        if (baseCredit < 0 && opCredit < 0) continue;
        if (baseCredit < 0) baseCredit = opCredit;
        if (subject < 0 && subjectHeaderOffset >= 0 && baseCredit > 0) subject = baseCredit - 1;
        if (subject < 0) continue;
        const semesters = semesterHeaderPatterns.map((pattern) =>
          header.findIndex((value) => pattern.test(compactHeader(value)))
        );
        headerIndex = subjectHeaderOffset >= 0
          ? Math.max(0, rowIndex - 2) + subjectHeaderOffset
          : rowIndex;
        for (let offset = 1; offset <= 2 && headerIndex + offset < rows.length; offset++) {
          const nextHeaderRow = rows[headerIndex + offset] || [];
          const containsHeaderLabel = nextHeaderRow.some((value) => {
            const label = compactHeader(value);
            return label.includes("학기") || label.includes("과목명") ||
              label.includes("기준학점") || label.includes("운영학점") ||
              semesterHeaderPatterns.some((pattern) => pattern.test(label));
          });
          if (containsHeaderLabel) headerIndex += 1;
        }
        columns = {
          grade: findColumn((value, column) => value.includes("학년") && !semesters.includes(column)),
          division: findColumn((value) => value === "구분" || value.includes("교육과정구분")),
          area: findColumn((value) => value.includes("교과군")),
          detail: findColumn((value) =>
            value.includes("세부") || value.includes("과목유형") || value.includes("이수구분")
          ),
          subject,
          baseCredit,
          opCredit,
          bundleName: findColumn((value) => value.includes("선택묶음")),
          bundlePick: findColumn((value) => value.includes("선택수") || value.includes("선택가능수")),
          semesters
        };
        break;
      }
      if (!columns) {
        throw new Error("편제표에서 과목명, 기준학점, 1-1~3-2 학기 열을 찾지 못했습니다.");
      }
      // '세부과목' 병합 머리글이 분류 열(공통/일반/진로/융합)과 과목명 열을 함께 덮으면 오른쪽 열이 과목명이다.
      const typeWords = new Set(["공통", "일반", "진로", "융합", "일반선택", "진로선택", "융합선택"]);
      const dataRows = rows.slice(headerIndex + 1).filter((row) => String(row?.[columns.subject] ?? "").trim());
      const typeLike = dataRows.filter((row) => typeWords.has(String(row[columns.subject]).replace(/\s+/g, ""))).length;
      if (dataRows.length && typeLike * 2 >= dataRows.length && columns.subject + 1 < Math.min(
        ...[columns.baseCredit, columns.opCredit].filter((column) => column >= 0))) {
        if (columns.detail < 0 || columns.detail === columns.subject) columns.detail = columns.subject;
        columns.subject += 1;
      }
      // 화면 레이아웃에서 인식한 열(2줄 머리글의 학년·학기, 병합 '세부과목')을 우선 사용한다.
      if (layoutColumns) {
        if (layoutColumns.subject >= 0) columns.subject = layoutColumns.subject;
        columns.semesters = columns.semesters.map((column, index) =>
          layoutColumns.semesters?.[index] >= 0 ? layoutColumns.semesters[index] : column);
        for (const field of ["grade", "division", "area", "baseCredit", "opCredit"]) {
          if (layoutColumns[field] >= 0) columns[field] = layoutColumns[field];
        }
        if (layoutColumns.detail >= 0) columns.detail = layoutColumns.detail;
        else if (columns.detail === columns.subject) columns.detail = -1;
      }

      const records = [];
      let lastGrade = "1";
      const leadingText = `${context} ${rows.slice(0, headerIndex + 1).flat().map((value) => String(value ?? "")).join(" ")}`;
      const titleGrade = leadingText.match(/([123])\s*학년/);
      if (titleGrade) lastGrade = titleGrade[1];
      let lastDivision = "";
      let lastArea = "";
      let lastDetail = "";
      let activeBundle = null;
      let nextBundleNumber = 1;
      for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex] || [];
        const subject = String(row[columns.subject] ?? "").trim();
        if (!subject || row._mergedFillColumns?.has(columns.subject)) continue;
        if (/소계|합계|총\s*이수|이수\s*학점|창의적\s*체험|표기\s*방법|과목명|세부과목/.test(subject)) continue;
        const gradeValue = String(row[columns.grade] ?? "").trim();
        const gradeMatch = gradeValue.match(/[123]/);
        if (gradeMatch) lastGrade = gradeMatch[0];
        const divisionValue = String(row[columns.division] ?? "").trim();
        if (divisionValue) lastDivision = divisionValue;
        const areaValue = String(row[columns.area] ?? "").trim();
        if (areaValue) lastArea = areaValue;
        const detailValue = String(row[columns.detail] ?? "").trim();
        if (detailValue) lastDetail = detailValue;

        const semesterValues = columns.semesters.map((columnIndex) =>
          columnIndex >= 0 ? String(row[columnIndex] ?? "").trim() : ""
        );
        const pickCellValue = columns.bundlePick >= 0 ? String(row[columns.bundlePick] ?? "").trim() : "";
        const bundleCellValue = columns.bundleName >= 0 ? String(row[columns.bundleName] ?? "").trim() : "";
        const pickText = [pickCellValue, ...semesterValues].find((value) => /택\s*\d+/.test(value)) || "";
        const pickMatch = pickText.match(/택\s*(\d+)/);
        const bundleEligible = normalizeCurriculumDivision(lastDivision) === "학생 선택 교육과정" &&
          isSelectableDetail(lastDetail);
        if (pickMatch) {
          const markedSemester = semesterValues.findIndex((value) => /택\s*\d+/.test(value));
          const markedField = CURRICULUM_SEMESTER_FIELDS[markedSemester] || "";
          if (bundleEligible) {
            activeBundle = {
              name: bundleCellValue || `편제표 선택묶음 ${nextBundleNumber++}`,
              pick: Number(pickMatch[1]),
              semesterField: markedField
            };
          }
        }

        const semesterState = {};
        const notedSemesterFields = new Set();
        CURRICULUM_SEMESTER_FIELDS.forEach((field, index) => {
          const value = semesterValues[index];
          const note = value.match(/([123])\s*학년[\s\S]*?([12](?:\s*[,，]\s*[12])*)\s*학기/);
          if (note) {
            const grade = Number(note[1]);
            const terms = note[2].split(/[,，]/).map((term) => Number(term.trim()));
            for (const term of terms) {
              const notedField = CURRICULUM_SEMESTER_FIELDS[(grade - 1) * 2 + term - 1];
              if (notedField) notedSemesterFields.add(notedField);
            }
            semesterState[field] = "";
          } else {
            const isUnmappedScheduleNote = /[123]\s*학년|\d+\s*학기/.test(value);
            semesterState[field] = value && !isUnmappedScheduleNote ? "●" : "";
          }
        });
        for (const field of notedSemesterFields) semesterState[field] = "●";
        const activeBundleMatches = bundleEligible && activeBundle?.semesterField &&
          semesterState[activeBundle.semesterField];
        const rowBundleName = bundleCellValue || (activeBundleMatches ? activeBundle.name : "");
        const bundlePickValue = Number(
          pickMatch?.[1] || pickCellValue.match(/\d+/)?.[0] ||
          (activeBundleMatches ? activeBundle.pick : 1)
        );
        const subjects = subject.split(/[,，、]/).map((name) => name.trim()).filter(Boolean);
        const firstMarked = CURRICULUM_SEMESTER_FIELDS.findIndex((field) => semesterState[field]);
        const rowGrade = columns.grade < 0 && !titleGrade && firstMarked >= 0
          ? String(Math.floor(firstMarked / 2) + 1)
          : lastGrade;
        for (const subjectName of subjects) {
          records.push(normalizeCurriculumPlanRow({
            grade: rowGrade,
            division: lastDivision,
            area: lastArea,
            detail: lastDetail,
            subject: subjectName,
            baseCredit: columns.baseCredit >= 0 ? row[columns.baseCredit] : 0,
            opCredit: columns.opCredit >= 0 && String(row[columns.opCredit] ?? "").trim()
              ? row[columns.opCredit]
              : row[columns.baseCredit],
            bundleName: rowBundleName,
            bundlePick: bundlePickValue,
            ...semesterState
          }, { grade: "1", division: "학생 선택 교육과정", detail: "일반선택" }));
        }
      }
      if (!records.length) throw new Error("편제표에서 과목 행을 찾지 못했습니다.");
      return records;
    }

    // previousPlan이 있으면 사용자가 직접 지정한 학기 선택 그룹(묶음 연동이 아닌 것)을 이어받는다.
    function curriculumPlanFromLayout(layout, context = "", previousPlan = null) {
      let plan = [];
      let parseError = null;
      try {
        plan = createCurriculumPlanRecords(expandCurriculumLayoutRows(layout), context, importedPlanColumnMap(layout));
      } catch (error) {
        parseError = error;
      }
      if (!plan.length) plan = planRowsFromImportedLayout(layout);
      if (!plan.length && parseError) throw parseError;
      if (Array.isArray(previousPlan)) {
        const manual = new Map();
        for (const row of previousPlan) {
          for (const [field, group] of Object.entries(row?.semesterGroups || {})) {
            if (group && !group.block) manual.set(`${planSubjectKey(row.grade, row.subject)}:${field}`, group);
          }
        }
        for (const row of plan) {
          for (const field of CURRICULUM_SEMESTER_FIELDS) {
            const group = manual.get(`${planSubjectKey(row.grade, row.subject)}:${field}`);
            if (group && row[field]) row.semesterGroups[field] = { name: group.name, pick: group.pick };
          }
        }
      }
      if (typeof linkCurriculumChoiceBlockGroups === "function") linkCurriculumChoiceBlockGroups(plan, layout);
      return plan;
    }

    // 과목 데이터는 편제표 레이아웃에서 파생되므로, 불러온 뒤 최신 해석 규칙(택n 묶음 연동 포함)으로 다시 만든다.
    function refreshCurriculumDerivedPlans() {
      const rebuild = (layout, previous, label) => {
        if (!layout) return null;
        try {
          const plan = curriculumPlanFromLayout(layout, label, previous);
          return plan.length ? plan : null;
        } catch (error) {
          return null;
        }
      };
      const current = rebuild(state.curriculumImportedLayout, state.curriculumPlan, state.curriculumPlanFileName);
      if (current) {
        state.curriculumPlan = current;
        state.curriculumTemplateRows = current.map((row) => normalizeCurriculumPlanRow(row));
      }
      for (const store of [state.curriculumCohorts, state.curriculumAnnualPlans]) {
        for (const item of Object.values(store || {})) {
          const plan = rebuild(item.importedLayout, item.plan, item.fileName);
          if (!plan) continue;
          item.plan = plan;
          item.templateRows = plan.map((row) => normalizeCurriculumPlanRow(row));
        }
      }
    }

    function curriculumBundleSummaryHtml(rows, layout = null) {
      const bundles = new Map();
      const blocks = layout && typeof curriculumChoiceBlocks === "function" ? curriculumChoiceBlocks(layout) : [];
      const blockChips = blocks.map((block) =>
        `<button type="button" class="curriculum-bundle-chip is-linked" data-choice-block-jump="${escapeHtml(block.key)}" title="편제표의 묶음 칸으로 이동">${escapeHtml(block.name)} · ${block.subjects.length}과목 중 ${block.pick} · ${block.credit}학점 → 이수 ${block.total}학점</button>`
      );
      for (const row of rows) {
        if (!isSelectableDetail(row.detail)) continue;
        if (normalizeCurriculumDivision(row.division) !== "학생 선택 교육과정") continue;
        const name = String(row.bundleName || "").trim();
        if (!name) continue;
        const key = `${row.grade}:${name}`;
        const item = bundles.get(key) || { grade: row.grade, name, total: 0, pick: Math.max(1, Number(row.bundlePick) || 1) };
        item.total += 1;
        item.pick = Math.max(item.pick, Math.max(1, Number(row.bundlePick) || 1));
        bundles.set(key, item);
      }
      if (!bundles.size && !blockChips.length) return "";
      const chips = blockChips.join("") + [...bundles.values()]
        .sort((a, b) => Number(a.grade) - Number(b.grade) || a.name.localeCompare(b.name, "ko"))
        .map((item) => `<span class="curriculum-bundle-chip">${escapeHtml(item.grade)}학년 ${escapeHtml(item.name)} · ${item.total}과목 중 ${item.pick}개 선택</span>`)
        .join("");
      return `<details class="curriculum-bundles-details"><summary>선택 묶음 ${blocks.length + bundles.size}개 · 펼쳐 보기</summary><div class="curriculum-bundle-summary">${chips}</div></details>`;
    }

    function curriculumSemesterHoursSummaryHtml(indexedRows, grade, fields = CURRICULUM_SEMESTER_FIELDS) {
      const totals = fields.map((field) => {
        const blocks = new Set();
        const total = indexedRows.reduce(({ hours, count }, { item }) => {
          if (!String(item[field] || "").trim()) return { hours, count };
          const group = item.semesterGroups?.[field];
          if (group?.block) {
            if (blocks.has(group.block)) return { hours, count: count + 1 };
            blocks.add(group.block);
            return { hours: hours + (Number(group.pick) || 0) * (Number(group.credit) || 0), count: count + 1 };
          }
          return {
            hours: hours + (Number(item.opCredit) || 0),
            count: count + 1
          };
        }, { hours: 0, count: 0 });
        return { field, label: `${field.slice(3, 4)}-${field.slice(4)}`, ...total };
      });
      if (!totals.some(({ count }) => count)) return "";
      const chips = totals.filter(({ count }) => count > 0).map(({ label, hours }) =>
        `<span class="curriculum-hours-item">${label} · ${hours}시간</span>`
      ).join("");
      return `<div class="curriculum-hours-summary"><span class="curriculum-hours-title">${escapeHtml(grade)}학년 시수</span>${chips}</div>`;
    }

    function sheetMergeReferenceSet(layout) {
      return new Set(typeof curriculumSheetMerges === "function" && layout
        ? curriculumSheetMerges(layout).map((merge) => merge.reference) : []);
    }

    function importedPlanCoveredCells(layout) {
      const covered = new Set();
      const sheetMergeReferences = sheetMergeReferenceSet(layout);
      for (const reference of layout?.mergedRanges || []) {
        if (sheetMergeReferences.has(reference)) continue;
        const [startRef, endRef = startRef] = String(reference).split(":");
        const startColumn = columnIndex(startRef);
        const endColumn = columnIndex(endRef);
        const startRow = Number(startRef.match(/\d+/)?.[0]) - 1;
        const endRow = Number(endRef.match(/\d+/)?.[0]) - 1;
        if (![startColumn, endColumn, startRow, endRow].every(Number.isInteger)) continue;
        for (let row = startRow; row <= endRow; row++) {
          for (let column = startColumn; column <= endColumn; column++) {
            if (row !== startRow || column !== startColumn) covered.add(`${row}:${column}`);
          }
        }
      }
      return covered;
    }

    function importedPlanCourseContexts(layout, columns = importedPlanColumnMap(layout)) {
      const expandedRows = expandCurriculumLayoutRows(layout);
      const coveredCells = importedPlanCoveredCells(layout);
      const contexts = [];
      let lastGrade = "";
      let lastDivision = "";
      let lastArea = "";
      let lastDetail = "";
      let lastSelectionType = "";
      let lastTypeColumn = -1;
      for (let rowIndex = 0; rowIndex < expandedRows.length; rowIndex++) {
        const row = expandedRows[rowIndex] || [];
        // 제목·안내문처럼 다른 열에서 시작한 병합 셀이 과목명 칸까지 덮은 경우는 과목 행이 아니다.
        const subject = coveredCells.has(`${rowIndex}:${columns.subject}`) ? "" : String(row[columns.subject] ?? "").trim();
        const division = columns.division >= 0 ? String(row[columns.division] ?? "").trim() : "";
        if (columns.grade >= 0 && String(row[columns.grade] ?? "").trim()) lastGrade = String(row[columns.grade]).trim();
        if (division) lastDivision = division;
        if (columns.area >= 0 && String(row[columns.area] ?? "").trim()) lastArea = String(row[columns.area]).trim();
        if (columns.detail >= 0 && String(row[columns.detail] ?? "").trim()) lastDetail = String(row[columns.detail]).trim();
        const isHeader = subject.includes("과목명") || subject.includes("세부과목") || subject === "과목";
        if (isHeader) { lastSelectionType = ""; continue; }
        // 과목명 앞쪽 셀(구분 등)에서 공통/일반/진로/융합 표기를 찾고, 비어 있으면 직전 표기를 이어받는다.
        let typeColumn = -1;
        for (let column = Math.max(0, columns.subject) - 1; column >= 0; column--) {
          if (curriculumSelectionType(row[column])) { typeColumn = column; break; }
        }
        const rowType = typeColumn >= 0
          ? curriculumSelectionType(row[typeColumn])
          : (columns.detail >= 0 ? curriculumSelectionType(row[columns.detail]) : "");
        if (rowType) {
          lastSelectionType = rowType;
          lastTypeColumn = typeColumn;
        }
        if (!subject) continue;
        contexts.push({
          rowIndex,
          row,
          subject,
          grade: lastGrade,
          division: lastDivision,
          area: lastArea,
          detail: lastDetail,
          selectionType: lastSelectionType || curriculumSelectionType(lastDetail),
          typeColumn: lastTypeColumn
        });
      }
      return contexts;
    }

    function curriculumSubjectNames(value) {
      return String(value ?? "").split(/[,，、]/).map((name) =>
        name.replace(/↔/g, " ").replace(/^[*＊★☆■\s]+|[*＊★☆■\s]+$/g, "").replace(/\s+/g, " ").trim()
      ).filter((name) => name && !/소계|합계|총이수|이수학점|창의적체험|과목명|세부과목|교육과정|표기방법/.test(name) &&
        !["공통", "일반", "진로", "융합"].includes(name));
    }

    function curriculumSubjectSignatures(layout, plan = null) {
      const subjects = new Map();
      const columns = importedPlanColumnMap(layout);
      if (columns.subject < 0) return subjects;
      const compact = (value) => String(value ?? "").normalize("NFKC").replace(/\s+/g, "");
      const blocks = curriculumChoiceBlocks(layout, columns);
      const blockMembers = new Map(blocks.map((block) => [block, [...new Set(block.subjects.map(curriculumChoiceSubjectKey))].sort()]));
      const contexts = importedPlanCourseContexts(layout, columns);
      const entriesByRow = new Map();
      for (const entry of curriculumPlanEntries(layout).entries) {
        const entries = entriesByRow.get(entry.rowIndex) || [];
        entries.push(entry);
        entriesByRow.set(entry.rowIndex, entries);
      }
      for (const context of contexts) {
        if (/소계|창의적체험|총이수|이수학점|합계|과목명|세부과목|교육과정|표기방법/.test(compact(context.subject))) continue;
        if (["공통", "일반", "진로", "융합"].includes(compact(context.subject))) continue;
        for (const name of curriculumSubjectNames(context.subject)) {
          const key = curriculumChoiceSubjectKey(name);
          if (!key) continue;
          const subject = subjects.get(key) || { name, records: new Set() };
          const memberships = blocks.filter((block) => context.rowIndex >= block.startRow && context.rowIndex <= block.endRow &&
            blockMembers.get(block).includes(key));
          const placements = new Set((entriesByRow.get(context.rowIndex) || [])
            .filter((entry) => curriculumChoiceSubjectKey(entry.subject) === key &&
              !memberships.some((block) => block.field === `sem${entry.grade}${entry.semester}`))
            .map((entry) => JSON.stringify([`sem${entry.grade}${entry.semester}`, Number(entry.credit), entry.kind, entry.crossed])));
          for (const block of memberships) {
            placements.add(JSON.stringify([block.field, block.credit, "선택", Boolean(block.crossed)]));
          }
          const official = typeof findCurriculumOfficialSubject === "function" ? findCurriculumOfficialSubject(name) : null;
          const detail = context.selectionType || (official?.category === "전문교과" ? "진로선택" : official?.type) || "";
          const identity = {
            division: normalizeCurriculumDivision(context.division),
            area: compact(normalizeCurriculumAreaName(context.area)),
            detail,
            baseCredit: curriculumChoiceNumber(context.row[columns.baseCredit]),
            opCredit: curriculumChoiceNumber(context.row[columns.opCredit])
          };
          for (const placement of placements.size ? placements : [""]) {
            const field = placement ? JSON.parse(placement)[0] : "";
            subject.records.add(JSON.stringify({
              ...identity, placement,
              groups: memberships.filter((block) => block.field === field).map((block) =>
                JSON.stringify([block.pick, block.credit, blockMembers.get(block)])).sort(),
              ...(plan ? { manualGroups: [...new Set(plan.filter((row) =>
                curriculumChoiceSubjectKey(row.subject) === key && row[field] && row.semesterGroups?.[field] &&
                !row.semesterGroups[field].block).map((row) =>
                JSON.stringify([row.semesterGroups[field].name, row.semesterGroups[field].pick])))].sort() } : {})
            }));
          }
          subjects.set(key, subject);
        }
      }
      return new Map([...subjects].map(([key, subject]) => [key, {
        name: subject.name, signature: JSON.stringify([...subject.records].sort())
      }]));
    }

    function curriculumTableChanges(layout) {
      const changes = new Map();
      if (layout?.changeBaseline?.version !== 2 || typeof curriculumPlanEntries !== "function") return changes;
      const before = curriculumSubjectSignatures(layout.changeBaseline, layout.changeBaseline.plan || null);
      const after = curriculumSubjectSignatures(layout, layout.changeBaseline.plan ? state.curriculumPlan : null);
      for (const [key, subject] of after) {
        const previous = before.get(key);
        if (previous?.signature === subject.signature) continue;
        changes.set(key, { kind: previous ? "changed" : "added", label: previous ? "비교 기준 대비 편성 변경" : "비교 기준 대비 과목 추가" });
      }
      for (const [key] of before) {
        if (!after.has(key)) changes.set(key, { kind: "removed", label: "비교 기준 대비 과목 삭제" });
      }
      return changes;
    }

    function curriculumChangeAttributes(changes) {
      if (!changes.length) return "";
      const notes = [...new Set(changes.map((change) => change.label))];
      const note = notes.join(" · ");
      return `data-change-kind="${changes[0].kind}" data-change-note="${escapeHtml(note)}" aria-description="${escapeHtml(note)}"`;
    }

    async function ensureCurriculumChangeBaseline(layout) {
      if (typeof latestCurriculumSavedVersion === "function" && layout === state.curriculumImportedLayout) {
        const latest = latestCurriculumSavedVersion();
        if (latest) {
          if (layout.changeBaseline?.versionId !== latest.id) {
            layout.changeBaseline = curriculumSavedBaseline(latest.snapshot, latest.id, latest.savedAt);
          }
          return;
        }
      }
      if (layout.changeBaseline?.version === 2 || curriculumBaselineLoads.has(layout)) return;
      if (typeof curriculumArchiveStore !== "function" || typeof parseWorkbook !== "function") return;
      curriculumBaselineLoads.add(layout);
      try {
        let baseline;
        if (layout.archiveId) {
          const buffer = await curriculumArchiveStore("get", layout.archiveId);
          if (!buffer) throw new Error("원본 편제표 파일이 없어 이전 값을 확인할 수 없습니다. 편제표를 다시 업로드하세요.");
          const sheets = await parseWorkbook(buffer, { expandMergedCells: true, includeLayout: true });
          const sheet = sheets.find((item) => item.layout?.sheetPath === layout.sheetPath) ||
            sheets.find((item) => item.name === layout.sheetName);
          if (!sheet) throw new Error("원본 편제표 시트를 찾지 못했습니다.");
          baseline = cropCurriculumSheet(sheet);
        } else {
          if (layout.changeBaseline?.source === "original") throw new Error("원본 편제표 파일이 없어 비교 기준을 복원할 수 없습니다.");
          baseline = JSON.parse(JSON.stringify({
            rows: layout.rows, mergedRanges: layout.mergedRanges || [], choiceBlockRanges: layout.choiceBlockRanges || []
          }));
        }
        layout.changeBaseline = {
          version: 2, rows: baseline.rows, mergedRanges: baseline.mergedRanges || [],
          choiceBlockRanges: baseline.choiceBlockRanges || [],
          source: layout.archiveId ? "original" : "current", savedAt: new Date().toISOString()
        };
        delete layout.changeBaselineError;
        if (state.curriculumImportedLayout === layout) {
          renderCurriculumStep();
          persistState();
        }
      } catch (error) {
        layout.changeBaselineError = error.message;
        if (state.curriculumImportedLayout === layout) {
          $("#curriculumChangeSummary").textContent = `변경 비교 실패: ${error.message}`;
          showAppToast(`변경 비교 실패: ${error.message}`, "error");
        }
      }
    }

    function scheduleCurriculumTableSize() {
      if (curriculumTableSizeFrame !== null) cancelAnimationFrame(curriculumTableSizeFrame);
      curriculumTableSizeFrame = requestAnimationFrame(() => {
        curriculumTableSizeFrame = null;
        const wrap = $("#curriculumPlanWrap");
        if (!wrap || Number(state.workflowStep) !== 1 || !wrap.getClientRects().length) return;
        const actions = $("#curriculumPlanDropZone .curriculum-plan-actions");
        const height = Math.max(180, Math.floor(window.innerHeight - wrap.getBoundingClientRect().top -
          (actions?.getBoundingClientRect().height || 40) - 24));
        const value = `${height}px`;
        if (wrap.style.getPropertyValue("--curriculum-table-height") !== value) {
          wrap.style.setProperty("--curriculum-table-height", value);
        }
      });
    }

    function curriculumImportedSheetHtml(layout, filters = {}, selectionMode = false, compactView = false) {
      if (!layout || !Array.isArray(layout.rows) || !layout.rows.length) return "";
      const rows = layout.rows;
      const changes = curriculumTableChanges(layout);
      const columns = importedPlanColumnMap(layout);
      const courseRows = new Set();
      const matchingRows = new Set();
      const contexts = importedPlanCourseContexts(layout, columns);
      const fixedTypeColumns = new Set([columns.detail, ...contexts.map((context) => context.typeColumn)].filter((column) => column >= 0));
      const contextTypes = new Map(contexts.map((context) => [context.rowIndex, context.selectionType || ""]));
      for (const context of contexts) {
        const { rowIndex, row, grade: lastGrade, division: lastDivision, area: lastArea, detail: lastDetail, selectionType } = context;
        courseRows.add(rowIndex);
        const rowGrade = lastGrade.match(/[123]/)?.[0] || "";
        const matchesGrade = !filters.grade || rowGrade === filters.grade;
        const normalizedDivision = lastDivision.replace(/↔/g, " ").trim();
        const matchesDivision = !filters.division ||
          (normalizedDivision && normalizeCurriculumDivision(normalizedDivision) === filters.division);
        const matchesArea = !filters.area || lastArea.replace(/↔/g, " ").trim() === filters.area;
        const matchesDetail = !filters.detail || selectionType === filters.detail;
        const searchable = [...row, lastGrade, lastDivision, lastArea, lastDetail]
          .join(" ").replace(/↔/g, " ").toLocaleLowerCase();
        const query = String(filters.query || "").replace(/↔/g, " ").trim().toLocaleLowerCase();
        const matchesQuery = !query || searchable.includes(query);
        if (matchesGrade && matchesDivision && matchesArea && matchesDetail && matchesQuery) {
          matchingRows.add(rowIndex);
        }
      }
      const hasActiveFilter = Boolean(filters.grade || filters.division || filters.area ||
        filters.detail || String(filters.query || "").replace(/↔/g, " ").trim());
      $("#curriculumFilterCount").textContent = `${matchingRows.size}개 과목 표시`;
      const merges = (Array.isArray(layout.mergedRanges) ? layout.mergedRanges : [])
        .map((reference) => {
          const [startRef, endRef = startRef] = String(reference).split(":");
          const startColumn = columnIndex(startRef);
          const startRow = Number(startRef.match(/\d+/)?.[0]) - 1;
          const endColumn = columnIndex(endRef);
          const endRow = Number(endRef.match(/\d+/)?.[0]) - 1;
          if (![startColumn, startRow, endColumn, endRow].every(Number.isInteger)) return null;
          return { startColumn, startRow, endColumn, endRow };
        })
        .filter(Boolean);
      const rowCount = Math.max(rows.length, ...merges.map((merge) => merge.endRow + 1));
      const columnCount = Math.max(
        0,
        ...rows.map((row) => row?.length || 0),
        ...merges.map((merge) => merge.endColumn + 1),
        layout.columnWidths?.length || 0
      );
      if (!rowCount || !columnCount) return "";
      const sheetMergeByReference = new Map((typeof curriculumSheetMerges === "function" ? curriculumSheetMerges(layout) : [])
        .map((item) => [item.reference, item]));
      const emptySubjectRows = new Set(typeof curriculumEmptySubjectRows === "function" ? curriculumEmptySubjectRows(layout) : []);
      const sheetHiddenRows = new Set(layout.hiddenRows || []);
      const isHiddenRow = (rowIndex) => sheetHiddenRows.has(rowIndex) || (!layout.showEmptySubjectRows && emptySubjectRows.has(rowIndex)) ||
        (hasActiveFilter && courseRows.has(rowIndex) && !matchingRows.has(rowIndex));
      const headerIndex = compactView ? Math.max(0, rows.findIndex((row) =>
        row.some((value) => /세부과목|과목명/.test(String(value))) &&
        row.some((value) => /기준학점|운영학점|기준시수|운영시수/.test(String(value).replace(/\s/g, ""))))) : 0;
      const visibleRowIndexes = Array.from({ length: rowCount }, (_, rowIndex) => rowIndex)
        .filter((rowIndex) => rowIndex >= headerIndex && !isHiddenRow(rowIndex));
      // 필터로 숨겨진 행이 병합 범위에 포함되면 남은 행 기준으로 병합 셀을 다시 배치한다.
      const mergeAt = new Map();
      const covered = new Set();
      for (const merge of merges) {
        const visibleInSpan = visibleRowIndexes.filter((rowIndex) => rowIndex >= merge.startRow && rowIndex <= merge.endRow);
        for (let row = merge.startRow; row <= merge.endRow; row++) {
          for (let column = merge.startColumn; column <= merge.endColumn; column++) {
            covered.add(`${row}:${column}`);
          }
        }
        if (!visibleInSpan.length) continue;
        const anchorRow = visibleInSpan[0];
        covered.delete(`${anchorRow}:${merge.startColumn}`);
        mergeAt.set(`${anchorRow}:${merge.startColumn}`, { ...merge, rowSpan: visibleInSpan.length });
      }
      // 택n 묶음은 '택n' 칸과 아래 학점 칸을 하나의 병합 셀처럼 보여 주고 한 번에 편집한다.
      const blockAt = new Map();
      const choiceBlocks = typeof curriculumChoiceBlocks === "function" ? curriculumChoiceBlocks(layout, columns) : [];
      for (const block of selectionMode ? [] : choiceBlocks) {
        if (block.sheetMerge) continue;
        const crossing = merges.some((merge) => merge.startColumn <= block.column && merge.endColumn >= block.column &&
          merge.startRow <= block.endRow && merge.endRow >= block.startRow &&
          (merge.startRow < block.startRow || merge.endRow > block.endRow || merge.startColumn !== merge.endColumn));
        if (crossing) continue;
        const visibleInBlock = visibleRowIndexes.filter((rowIndex) => rowIndex >= block.startRow && rowIndex <= block.endRow);
        if (!visibleInBlock.length) continue;
        for (let row = block.startRow; row <= block.endRow; row++) {
          covered.add(`${row}:${block.column}`);
          mergeAt.delete(`${row}:${block.column}`);
        }
        covered.delete(`${visibleInBlock[0]}:${block.column}`);
        blockAt.set(`${visibleInBlock[0]}:${block.column}`, { block, rowSpan: visibleInBlock.length });
      }
      const colGroup = Array.from({ length: columnCount }, (_, column) => {
        const excelWidth = Number(layout.columnWidths?.[column]);
        const width = Number.isFinite(excelWidth) && excelWidth > 0
          ? `${Math.max(44, Math.min(360, Math.round(excelWidth * 7 + 12)))}px`
          : "100px";
        return `<col style="width:${width}">`;
      }).join("");
      renderWorkspaceContext();
      const tableRows = visibleRowIndexes.map((rowIndex) => {
        const row = rows[rowIndex] || [];
        const hasHeader = row.some((value) => /과목명|기준학점|운영학점|세부과목/.test(String(value ?? "")));
        const height = Number(layout.rowHeights?.[rowIndex]);
        const rowStyle = Number.isFinite(height) && height > 0
          ? ` style="height:${Math.max(20, Math.min(240, Math.round(height * 1.35)))}px"`
          : "";
        const cells = [];
        for (let column = 0; column < columnCount; column++) {
          const choice = blockAt.get(`${rowIndex}:${column}`);
          if (choice) {
            const { block } = choice;
            const fill = curriculumCellFill(layout, block.startRow, column);
            const fillStyle = /^#[0-9A-F]{6}$/i.test(fill) ? ` style="background-color:${fill}"` : "";
            const label = `${block.grade}학년 ${block.semester}학기 ${escapeHtml(block.name)} 묶음`;
            const subjects = escapeHtml(block.subjects.join(", "));
            cells.push(`<td class="curriculum-choice-cell" rowspan="${choice.rowSpan}" data-choice-block="${escapeHtml(block.key)}" data-choice-column="${column}" data-choice-start="${block.startRow}" data-choice-end="${block.endRow}"${fillStyle} title="${label}: ${subjects}">
              <span class="curriculum-choice-line">택<input class="curriculum-choice-input" style="--digits:${String(block.pick).length}" type="number" min="1" max="${Math.max(1, block.subjects.length)}" step="1" value="${block.pick}" data-choice-field="pick" aria-label="${label} 선택 과목 수"></span>
              <span class="curriculum-choice-line"><input class="curriculum-choice-input" style="--digits:${String(block.credit || "").length || 1}" type="number" min="0.5" max="30" step="any" value="${block.credit || ""}" data-choice-field="credit" aria-label="${label} 과목당 학점">학점</span>
            </td>`);
            continue;
          }
          const merge = mergeAt.get(`${rowIndex}:${column}`);
          if (!merge && covered.has(`${rowIndex}:${column}`)) continue;
          const sourceRow = merge ? merge.startRow : rowIndex;
          const fill = curriculumCellFill(layout, sourceRow, column);
          const fillStyle = /^#[0-9A-F]{6}$/i.test(fill) ? ` style="background-color:${fill}"` : "";
          const value = String((merge ? rows[merge.startRow] : row)?.[column] ?? "");
          const sheetMerge = merge ? sheetMergeByReference.get(`${columnName(merge.startColumn)}${merge.startRow + 1}:${columnName(merge.endColumn)}${merge.endRow + 1}`) : null;
          if (sheetMerge && sheetMerge.kind !== "plain") {
            const block = choiceBlocks.find((block) => block.sheetMerge === sheetMerge.reference && block.column === column);
            const label = curriculumSheetMergeLabel(sheetMerge);
            const selectionAttributes = `data-source-row="${sourceRow}" data-source-column="${column}" data-choice-column="${column}" data-choice-start="${merge.startRow}" data-choice-end="${merge.endRow}" data-choice-end-column="${merge.endColumn}" data-display-row="${rowIndex}"`;
            if (selectionMode) {
              cells.push(`<td class="curriculum-choice-cell curriculum-selectable-cell" rowspan="${merge.rowSpan}" colspan="${merge.endColumn - column + 1}" ${selectionAttributes} data-choice-selectable tabindex="0" role="button" aria-pressed="false"${fillStyle}>${escapeHtml(label)}</td>`);
              continue;
            }
            cells.push(`<td class="curriculum-choice-cell" rowspan="${merge.rowSpan}" colspan="${merge.endColumn - column + 1}" ${selectionAttributes} data-choice-block="${escapeHtml(block?.key || "")}"${fillStyle} title="${escapeHtml(label)}">
              ${sheetMerge.kind === "cross" ? '<span class="curriculum-choice-line">교차집중(↔)</span>' : ""}
              <span class="curriculum-choice-line">택<input class="curriculum-choice-input" type="number" min="1" step="1" style="--digits:${String(sheetMerge.pick).length}" value="${sheetMerge.pick}" data-choice-field="pick" aria-label="선택 과목 수"></span>
              <span class="curriculum-choice-line"><input class="curriculum-choice-input" type="number" min="0.1" step="any" style="--digits:${String(sheetMerge.credit).length}" value="${sheetMerge.credit}" data-choice-field="credit" aria-label="과목당 학점">학점</span></td>`);
            continue;
          }
          if (selectionMode) {
            const span = merge ? ` rowspan="${merge.rowSpan}" colspan="${merge.endColumn - column + 1}"` : "";
            cells.push(`<td tabindex="0" role="button" aria-label="${columnName(column)}${sourceRow + 1} 셀 선택" aria-pressed="false" class="curriculum-selectable-cell" data-choice-selectable data-source-row="${sourceRow}" data-source-column="${column}" data-choice-start="${merge?.startRow ?? sourceRow}" data-choice-end="${merge?.endRow ?? sourceRow}" data-choice-end-column="${merge?.endColumn ?? column}" data-display-row="${rowIndex}"${span}${fillStyle}>${escapeHtml(value) || "&nbsp;"}</td>`);
            continue;
          }
          const subjectNames = column === columns.subject && courseRows.has(sourceRow)
            ? curriculumSubjectNames(value) : [];
          if (subjectNames.length) {
            const rowType = contextTypes.get(sourceRow) || "";
            const namesHtml = subjectNames.map((subject) => {
              const change = changes.get(curriculumChoiceSubjectKey(subject));
              const changeAttributes = curriculumChangeAttributes(change ? [change] : []);
              const check = typeof curriculumOfficialTypeCheck === "function" ? curriculumOfficialTypeCheck(subject, rowType) : { ok: true };
              const flag = check.ok ? "" : " is-unverified";
              const title = check.ok ? "" : ` title="확인 필요: ${escapeHtml(check.reason)}"`;
              return `<button class="curriculum-subject-name${flag}" ${changeAttributes}${title} type="button" data-curriculum-subject="${escapeHtml(subject)}" aria-label="${escapeHtml(subject)} 편성 변경${check.ok ? "" : ` (확인 필요: ${escapeHtml(check.reason)})`}">${escapeHtml(subject)}</button>`;
            }).join(", ");
            const subjectSpan = merge
              ? ` rowspan="${merge.rowSpan}" colspan="${merge.endColumn - merge.startColumn + 1}"` : "";
            cells.push(`<td data-source-row="${sourceRow}" data-source-column="${column}"${subjectSpan}${fillStyle}>${namesHtml}</td>`);
            continue;
          }
          const span = merge
            ? ` rowspan="${merge.rowSpan}" colspan="${merge.endColumn - merge.startColumn + 1}"`
            : "";
          if (fixedTypeColumns.has(column) || column === columns.subject) {
            const hint = column === columns.subject ? "과목명을 누르면 이동·맞교체·삭제할 수 있습니다. 과목은 2022 개정 교육과정 과목 목록으로 검증합니다." : "과목 종류는 2022 개정 교육과정 과목 목록의 고정 분류이므로 수정할 수 없습니다.";
            cells.push(`<td aria-readonly="true" title="${hint}" data-source-row="${sourceRow}" data-source-column="${column}"${span}${fillStyle}>${escapeHtml(value)}</td>`);
            continue;
          }
          const selectionData = columns.semesters.includes(column) &&
              sourceRow >= Math.min(...courseRows) && sourceRow <= Math.max(...courseRows)
            ? ` data-choice-column="${column}" data-choice-start="${sourceRow}" data-choice-end="${merge?.endRow ?? sourceRow}" data-choice-end-column="${merge?.endColumn ?? column}"`
            : "";
          cells.push(`<td contenteditable="${layout.derived ? "false" : "true"}" spellcheck="false" data-source-row="${sourceRow}" data-source-column="${column}"${selectionData}${span}${fillStyle}>${escapeHtml(value)}</td>`);
        }
        return `<tr${hasHeader ? ' class="curriculum-source-header"' : ""}${rowStyle}>${cells.join("")}</tr>`;
      }).join("");
      return `<div class="curriculum-imported-sheet" aria-label="${escapeHtml(layout.sheetName || "불러온 편제표")}"><table class="curriculum-source-table"><colgroup>${colGroup}</colgroup><tbody>${tableRows}</tbody></table></div>`;
    }

    // 편제표 학기 칸 기준 학점 합계. 엑셀 '이수학점 소계'와 같은 규칙을 따른다:
    // 한 칸에 여러 과목(택1 쌍)은 한 번만, 공동·소인수(순증) 과목은 제외, 택n 묶음은 n × 학점으로 한 번만 센다.
    function curriculumLayoutSemesterHours(layout) {
      if (!layout || typeof curriculumPlanEntries !== "function") return null;
      const { entries } = curriculumPlanEntries(layout);
      if (!entries.length) return null;
      const blocks = typeof curriculumChoiceBlocks === "function" ? curriculumChoiceBlocks(layout) : [];
      const totals = Object.fromEntries(CURRICULUM_SEMESTER_FIELDS.map((field) => [field, { hours: 0, count: 0 }]));
      for (const entry of entries) {
        const field = `sem${entry.grade}${entry.semester}`;
        if (!totals[field] || entry.nameIndex > 0 || ["공동", "소인수"].includes(entry.kind)) continue;
        if (blocks.some((block) => block.field === field && entry.rowIndex >= block.startRow && entry.rowIndex <= block.endRow)) continue;
        totals[field].hours += Number(entry.credit) || 0;
        totals[field].count += 1;
      }
      for (const block of blocks) {
        totals[block.field].hours += block.total;
        totals[block.field].count += 1;
      }
      return totals;
    }

    function curriculumImportedGradeSummaries(rows, layout = null) {
      const layoutTotals = curriculumLayoutSemesterHours(layout);
      // 학년 요약은 과목 행의 학년이 아니라 학기 칸(1-1~3-2) 기준으로 묶는다. 여러 학년에 걸친 과목도 해당 학기에 반영된다.
      const summaries = ["1", "2", "3"].map((grade) => {
        const fields = CURRICULUM_SEMESTER_FIELDS.filter((field) => field[3] === grade);
        if (!layoutTotals) return curriculumSemesterHoursSummaryHtml(rows, grade, fields);
        const chips = fields.filter((field) => layoutTotals[field].count > 0).map((field) =>
          `<span class="curriculum-hours-item">${field[3]}-${field[4]} · ${layoutTotals[field].hours}시간</span>`).join("");
        return chips ? `<div class="curriculum-hours-summary"><span class="curriculum-hours-title">${grade}학년 시수</span>${chips}</div>` : "";
      }).join("");
      return summaries ? `<div class="curriculum-hours-summaries">${summaries}</div>` : "";
    }

    function curriculumSelectionGroupRows(planRows = state.curriculumPlan) {
      const result = [];
      planRows.forEach((source, index) => {
        const row = normalizeCurriculumPlanRow(source);
        if (!isSelectableDetail(row.detail) ||
            normalizeCurriculumDivision(row.division) !== "학생 선택 교육과정" ||
            !["2", "3"].includes(row.grade)) return;
        for (const field of CURRICULUM_SEMESTER_FIELDS) {
          if (!String(row[field] || "").trim()) continue;
          const semester = String((CURRICULUM_SEMESTER_FIELDS.indexOf(field) % 2) + 1);
          const assignment = row.semesterGroups[field] || (row.bundleName
            ? { name: row.bundleName, pick: row.bundlePick }
            : null);
          result.push({ index, field, grade: row.grade, semester, area: row.area, detail: row.detail,
            subject: row.subject, name: assignment?.name || "", pick: assignment?.pick ?? 1, block: assignment?.block || "" });
        }
      });
      return result;
    }

    function curriculumSelectionGroupEditorHtml() {
      if (state.curriculumPlanType === "annual") {
        return '<p class="note">전학년 편제표는 3개년 편제표에서 자동으로 만든 자료입니다. 선택 그룹은 각 입학생 3개년 편제표에서 지정합니다.</p>';
      }
      const rows = curriculumSelectionGroupRows();
      if (!rows.length) {
        return '<p class="note">2·3학년 학생 선택 과목이 인식되면 여기에서 학기별 선택 그룹과 선택 수를 지정할 수 있습니다.</p>';
      }
      const tableRows = rows.map((row) => {
        const groupSize = row.name
          ? rows.filter((item) => item.grade === row.grade && item.semester === row.semester && item.name === row.name).length
          : 0;
        if (row.block) {
          return `<tr class="curriculum-selection-group-linked">
          <td>${row.grade}학년</td><td>${row.semester}학기</td><td>${escapeHtml(row.area || "-")}</td>
          <td>${escapeHtml(row.subject)}</td>
          <td><span class="curriculum-linked-group" title="편제표의 택n 묶음과 연결된 그룹입니다. 편제표 묶음 칸에서 수정하세요.">${escapeHtml(row.name)} · 편제표 연동</span></td>
          <td>${row.pick}</td>
        </tr>`;
        }
        return `<tr>
          <td>${row.grade}학년</td><td>${row.semester}학기</td><td>${escapeHtml(row.area || "-")}</td>
          <td>${escapeHtml(row.subject)}</td>
          <td><input class="curriculum-cell-input curriculum-selection-group-name" type="text" maxlength="100"
            data-selection-group-field="name" data-plan-index="${row.index}" data-semester-field="${row.field}"
            value="${escapeHtml(row.name)}" placeholder="예: 과학탐구 A군" aria-label="${row.grade}학년 ${row.semester}학기 ${escapeHtml(row.subject)} 선택그룹"></td>
          <td><input class="curriculum-cell-input curriculum-cell-input-num" type="number" min="0" max="${groupSize}"
            data-selection-group-field="pick" data-plan-index="${row.index}" data-semester-field="${row.field}"
            value="${row.name ? row.pick : ""}" placeholder="-" ${row.name ? "" : "disabled"}
            aria-label="${row.grade}학년 ${row.semester}학기 ${escapeHtml(row.subject)} 그룹 선택 수"></td>
        </tr>`;
      }).join("");
      return `<p class="note curriculum-selection-group-help">편제표의 택n 묶음 과목은 묶음과 자동 연결됩니다(편제표 묶음 칸에서 수정). 그 밖의 과목은 같은 학년·학기에 같은 그룹명을 지정하면 하나의 선택 그룹이 되며, 2단계 수강신청 그룹에도 반영됩니다.</p>
        <div class="aggregate-sheet-wrap curriculum-selection-groups-wrap"><table class="closure-table curriculum-selection-groups">
          <thead><tr><th>학년</th><th>학기</th><th>교과(군)</th><th>선택 과목</th><th>선택 그룹명</th><th>그룹에서 선택할 수</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table></div>`;
    }

    function curriculumPlanGroupAssignments(cohortYear) {
      const planRows = state.curriculumPlanType !== "annual" && String(state.curriculumCohortYear) === String(cohortYear)
        ? state.curriculumPlan
        : state.curriculumCohorts?.[String(cohortYear)]?.plan || [];
      const assignments = new Map();
      for (const source of planRows) {
        const row = normalizeCurriculumPlanRow(source);
        if (!isSelectableDetail(row.detail) ||
            normalizeCurriculumDivision(row.division) !== "학생 선택 교육과정") continue;
        const normalizedSubject = curriculumChoiceSubjectKey(row.subject);
        if (!normalizedSubject) continue;
        for (const field of CURRICULUM_SEMESTER_FIELDS) {
          if (!String(row[field] || "").trim()) continue;
          const fieldGrade = String(Math.floor(CURRICULUM_SEMESTER_FIELDS.indexOf(field) / 2) + 1);
          if (!["2", "3"].includes(fieldGrade)) continue;
          const semester = String((CURRICULUM_SEMESTER_FIELDS.indexOf(field) % 2) + 1);
          const explicit = Object.prototype.hasOwnProperty.call(row.semesterGroups, field);
          const group = explicit ? row.semesterGroups[field] : row.bundleName
            ? { name: row.bundleName, pick: row.bundlePick }
            : null;
          if (!group) continue;
          assignments.set(`${fieldGrade}:${semester}:${normalizedSubject}`, {
            groupName: group.name,
            groupPick: Math.max(0, Number(group.pick) || 0),
            groupConfigured: true,
            groupLinked: Boolean(group.block)
          });
        }
      }
      // 저장된 과목 데이터가 오래되어도 편제표의 택n 묶음을 항상 우선 적용한다.
      const blockLayout = typeof curriculumCohortLayout === "function" ? curriculumCohortLayout(cohortYear) : null;
      if (blockLayout && typeof curriculumChoiceBlocks === "function") {
        for (const block of curriculumChoiceBlocks(blockLayout)) {
          if (!["2", "3"].includes(block.grade)) continue;
          for (const subject of block.subjects) {
            assignments.set(`${block.grade}:${block.semester}:${curriculumChoiceSubjectKey(subject)}`, {
              groupName: block.name, groupPick: block.pick, groupConfigured: true, groupLinked: true
            });
          }
        }
      }
      return assignments;
    }

    if (typeof window !== "undefined") window.updateCurriculumSelectionGroup = (cohortYear, grade, semester, subjects, groupName, groupPick) => {
      const year = String(cohortYear || "");
      const normalizedGrade = String(grade);
      const normalizedSemester = String(semester);
      const field = CURRICULUM_SEMESTER_FIELDS[(Number(normalizedGrade) - 1) * 2 + Number(normalizedSemester) - 1];
      const activePlan = state.curriculumPlanType !== "annual" && String(state.curriculumCohortYear) === year;
      const targetPlan = activePlan ? state.curriculumPlan : state.curriculumCohorts?.[year]?.plan;
      if (!/^\d{4}$/.test(year) || !field || !Array.isArray(subjects) || !Array.isArray(targetPlan)) return false;
      const normalizedSubjects = new Set(subjects.map((subject) => String(subject).replace(/\s+/g, "").toLowerCase()));
      const name = String(groupName || "").trim().slice(0, 100);
      const pick = Number.isInteger(Number(groupPick)) && Number(groupPick) >= 0 ? Number(groupPick) : 1;
      const affected = targetPlan.filter((source) => {
        const row = normalizeCurriculumPlanRow(source);
        return row.grade === normalizedGrade && normalizedSubjects.has(row.subject.replace(/\s+/g, "").toLowerCase());
      });
      if (!affected.length) return false;
      const groupSubjects = new Set(name
        ? targetPlan.filter((source) => {
          const row = normalizeCurriculumPlanRow(source);
          const current = row.semesterGroups[field];
          const currentName = Object.prototype.hasOwnProperty.call(row.semesterGroups, field)
            ? current?.name
            : row.bundleName;
          return row.grade === normalizedGrade && String(row[field] || "").trim() &&
            currentName === name;
        }).map((row) => normalizeCurriculumPlanRow(row).subject.replace(/\s+/g, "").toLowerCase())
        : []);
      for (const source of targetPlan) {
        const row = normalizeCurriculumPlanRow(source);
        if (row.grade !== normalizedGrade || row.semesterGroups[field]?.block) continue;
        const normalizedSubject = row.subject.replace(/\s+/g, "").toLowerCase();
        if (normalizedSubjects.has(normalizedSubject) ||
            (name && groupSubjects.has(normalizedSubject) && String(row[field] || "").trim())) {
          row.semesterGroups[field] = { name, pick };
          Object.assign(source, row);
        }
      }
      if (activePlan) syncCurriculumTemplateRows();
      else if (state.curriculumCohorts[year]) {
        state.curriculumCohorts[year].plan = targetPlan;
        state.curriculumCohorts[year].templateRows = targetPlan.map((row) => normalizeCurriculumPlanRow(row));
      }
      const saved = persistState();
      if (activePlan && state.workflowStep === 1) renderCurriculumStep();
      return saved;
    };

    function curriculumPlanTableHtml(rows, emptyText) {
      const visibleGrade = String(state.curriculumTargetGrade || "1");
      const visibleDivision = normalizeCurriculumDivisionFilter(state.curriculumTargetDivision);
      const visibleArea = String(state.curriculumTargetArea || "").trim();
      const visibleDetail = normalizeCurriculumDetailFilter(state.curriculumTargetDetail);
      const visibleIndexes = rows
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => String(item.grade || "1") === visibleGrade)
        .filter(({ item }) => !visibleDivision || normalizeCurriculumDivision(item.division) === visibleDivision)
        .filter(({ item }) => !visibleArea || String(item.area || "").trim() === visibleArea)
        .filter(({ item }) => !visibleDetail || normalizeCurriculumDetail(item.detail) === visibleDetail);
      if (!visibleIndexes.length) return `<div class="curriculum-empty">${escapeHtml(emptyText)}</div>`;

      const displayGroups = new Map();
      for (const { item, index } of visibleIndexes) {
        const bundleKey = curriculumBundleKeyForRow(item);
        const sharedValues = [
          String(item.grade || "1"),
          normalizeCurriculumDivision(item.division),
          String(item.area || "").trim(),
          normalizeCurriculumDetail(item.detail)
        ];
        if (!bundleKey) {
          sharedValues.push(String(item.baseCredit || 0), String(item.opCredit || 0));
          sharedValues.push(...CURRICULUM_SEMESTER_FIELDS.map((field) => String(item[field] || "").trim()));
        }
        const groupKey = JSON.stringify([bundleKey, ...sharedValues]);
        const current = displayGroups.get(groupKey) || {
          bundleKey,
          indexes: [],
          item,
          pick: 1,
          activeFields: new Set()
        };
        current.indexes.push(index);
        current.pick = Math.max(current.pick, Math.max(1, Number(item.bundlePick) || 1));
        for (const field of CURRICULUM_SEMESTER_FIELDS) {
          if (String(item[field] || "").trim() !== "") current.activeFields.add(field);
        }
        displayGroups.set(groupKey, current);
      }
      let displayRows = [...displayGroups.values()];
      const bundleGroups = new Map();
      for (const displayRow of displayRows) {
        if (!displayRow.bundleKey) continue;
        const current = bundleGroups.get(displayRow.bundleKey) || {
          displayRows: [],
          indexes: [],
          pick: 1,
          activeFields: new Set(),
          hoursByField: Object.fromEntries(CURRICULUM_SEMESTER_FIELDS.map((field) => [field, 0]))
        };
        current.displayRows.push(displayRow);
        current.indexes.push(...displayRow.indexes);
        current.pick = Math.max(current.pick, displayRow.pick);
        for (const field of displayRow.activeFields) current.activeFields.add(field);
        bundleGroups.set(displayRow.bundleKey, current);
      }
      for (const group of bundleGroups.values()) {
        for (const index of group.indexes) {
          const row = rows[index];
          for (const field of CURRICULUM_SEMESTER_FIELDS) {
            if (String(row[field] || "").trim()) {
              group.hoursByField[field] += Number(row.opCredit) || 0;
            }
          }
        }
      }
      const orderedDisplayRows = [];
      const placedBundles = new Set();
      for (const displayRow of displayRows) {
        if (!displayRow.bundleKey) {
          orderedDisplayRows.push(displayRow);
          continue;
        }
        if (placedBundles.has(displayRow.bundleKey)) continue;
        placedBundles.add(displayRow.bundleKey);
        orderedDisplayRows.push(...bundleGroups.get(displayRow.bundleKey).displayRows);
      }
      displayRows = orderedDisplayRows;
      const bundleCellMetaByGroup = new Map();
      for (const [bundleKey, group] of bundleGroups.entries()) {
        group.displayRows.forEach((displayRow, offset) => {
          bundleCellMetaByGroup.set(displayRow, {
            bundleKey,
            first: offset === 0,
            rowSpan: group.displayRows.length,
            pick: group.pick,
            activeFields: group.activeFields,
            hoursByField: group.hoursByField
          });
        });
      }

      const makeOptions = (options, value) =>
        options.map((option) => `<option value="${escapeHtml(option)}"${option === value ? " selected" : ""}>${escapeHtml(option)}</option>`).join("");
      const makeGradeOptions = (value) =>
        ["1", "2", "3"].map((grade) => `<option value="${grade}"${String(value) === grade ? " selected" : ""}>${grade}학년</option>`).join("");
      const semesterLabel = {
        sem11: "1-1",
        sem12: "1-2",
        sem21: "2-1",
        sem22: "2-2",
        sem31: "3-1",
        sem32: "3-2"
      };
      const semesterCell = (item, index, field, bundleMeta) => {
        const active = String(item[field] || "").trim() !== "";
        const label = semesterLabel[field] || field;
        if (bundleMeta) {
          const bundleActive = bundleMeta.activeFields.has(field);
          if (bundleActive) {
            if (!bundleMeta.first) return "";
            const hours = bundleMeta.hoursByField[field] || 0;
            return `<td class="curriculum-sem-cell" rowspan="${bundleMeta.rowSpan}"><button class="curriculum-sem-button active" type="button" data-semester-field="${field}" data-plan-index="${index}" data-bundle-key="${escapeHtml(bundleMeta.bundleKey)}" aria-label="${escapeHtml(item.subject || "")} ${label}, 택${bundleMeta.pick}, ${hours}시간"><span class="curriculum-sem-main">택${bundleMeta.pick}</span><span class="curriculum-sem-hours">${hours}시간</span></button></td>`;
          }
          return `<td class="curriculum-sem-cell"><button class="curriculum-sem-button" type="button" data-semester-field="${field}" data-plan-index="${index}" data-bundle-key="${escapeHtml(bundleMeta.bundleKey)}" aria-label="${escapeHtml(item.subject || "")} ${label}"></button></td>`;
        }
        const hours = active ? Number(item.opCredit) || 0 : 0;
        return `<td class="curriculum-sem-cell"><button class="curriculum-sem-button${active ? " active" : ""}" type="button" data-semester-field="${field}" data-plan-index="${index}" data-bundle-key="" aria-label="${escapeHtml(item.subject || "")} ${label}${active ? `, ${hours}시간` : ""}">${active ? `<span class="curriculum-sem-hours">${hours}시간</span>` : ""}</button></td>`;
      };
      const rowsHtml = displayRows.map((displayRow) => {
        const { item, indexes } = displayRow;
        const index = indexes[0];
        const normalizedDetail = normalizeCurriculumDetail(item.detail);
        const isSelectable = isSelectableDetail(normalizedDetail) && normalizeCurriculumDivision(item.division) === "학생 선택 교육과정";
        const bundleName = isSelectable ? String(item.bundleName || "") : "";
        const bundleMeta = bundleCellMetaByGroup.get(displayRow);
        const semesterCellHtml = CURRICULUM_SEMESTER_FIELDS.map((field) => semesterCell(item, index, field, bundleMeta)).join("");
        const pickValue = isSelectable ? Math.max(1, Number(item.bundlePick) || 1) : "";
        const planIndexes = indexes.join(",");
        const subjectList = indexes.map((subjectIndex) =>
          `<span class="curriculum-subject-entry"><button class="curriculum-subject-name" type="button" data-curriculum-subject="${escapeHtml(rows[subjectIndex].subject)}" data-plan-index="${subjectIndex}" aria-label="${escapeHtml(rows[subjectIndex].subject)} 편성 변경">${escapeHtml(rows[subjectIndex].subject)}</button></span>`
        ).join(", ");
        const baseCredits = [...new Set(indexes.map((subjectIndex) => String(rows[subjectIndex].baseCredit || 0)))].join(", ");
        const opCredits = [...new Set(indexes.map((subjectIndex) => String(rows[subjectIndex].opCredit || 0)))].join(", ");
        const pickCellHtml = `<td><input class="curriculum-cell-input curriculum-cell-input-num" type="number" min="1" step="1" data-plan-field="bundlePick" data-plan-index="${index}" data-plan-indexes="${planIndexes}" data-bundle-key="${escapeHtml(bundleMeta ? bundleMeta.bundleKey : "")}" value="${pickValue}" placeholder="-" ${isSelectable ? "" : "disabled"}></td>`;
        return `<tr>
          <td><select class="curriculum-cell-select" data-plan-field="division" data-plan-index="${index}" data-plan-indexes="${planIndexes}" aria-label="${escapeHtml(item.subject || "")} 구분">
            ${makeOptions(CURRICULUM_DIVISION_OPTIONS, normalizeCurriculumDivision(item.division))}
          </select></td>
          <td><select class="curriculum-cell-select" data-plan-field="grade" data-plan-index="${index}" data-plan-indexes="${planIndexes}" aria-label="${escapeHtml(item.subject || "")} 학년">
            ${makeGradeOptions(item.grade || "1")}
          </select></td>
          <td>${escapeHtml(item.area || "-")}</td>
          <td title="과목별 고정 분류 · 직접 변경 불가">${escapeHtml(normalizedDetail)}</td>
          <td>${subjectList}</td>
          <td><input class="curriculum-cell-input" type="text" data-plan-field="bundleName" data-plan-index="${index}" data-plan-indexes="${planIndexes}" value="${escapeHtml(bundleName)}" placeholder="선택묶음" ${isSelectable ? "" : "disabled"}></td>
          ${pickCellHtml}
          <td>${escapeHtml(baseCredits)}</td>
          <td>${escapeHtml(opCredits)}</td>
          ${semesterCellHtml}
        </tr>`;
      }).join("");
      const visibleRows = visibleIndexes.map(({ item }) => item);
      return `${curriculumBundleSummaryHtml(visibleRows)}${curriculumSemesterHoursSummaryHtml(visibleIndexes, visibleGrade)}<table class="curriculum-table">
        <thead><tr>
          <th style="width:9%">구분</th><th style="width:6%">학년</th><th style="width:7%">교과(군)</th><th style="width:8%">세부</th><th style="width:16%">과목명</th>
          <th style="width:9%">선택묶음</th><th style="width:5%">선택수</th>
          <th style="width:4%">기준</th><th style="width:4%">운영</th>
          <th style="width:4.5%">1-1</th><th style="width:4.5%">1-2</th><th style="width:4.5%">2-1</th><th style="width:4.5%">2-2</th><th style="width:4.5%">3-1</th><th style="width:4.5%">3-2</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>`;
    }

    function createInternalTemplateFromCatalog(catalog) {
      return catalog.map((item) => normalizeCurriculumPlanRow({
        grade: "1",
        division: "학생 선택 교육과정",
        area: curriculumAreaOf(item),
        detail: item.type || "",
        subject: item.subject,
        bundleName: "",
        bundlePick: 1,
        baseCredit: item.credit || 0,
        opCredit: item.credit || 0,
        sem11: "",
        sem12: "",
        sem21: "",
        sem22: "",
        sem31: "",
        sem32: ""
      }, { detail: "일반선택" }));
    }

    function syncCurriculumTemplateRows() {
      state.curriculumTemplateRows = state.curriculumPlan.map((row) => normalizeCurriculumPlanRow(row));
    }

    function curriculumSnapshot() {
      return JSON.parse(JSON.stringify({
        curriculumPlan: state.curriculumPlan,
        curriculumTemplateRows: state.curriculumTemplateRows,
        curriculumImportedLayout: state.curriculumImportedLayout,
        curriculumPlanFileName: state.curriculumPlanFileName
      }));
    }

    function recordCurriculumUndo(snapshot = curriculumSnapshot()) {
      state.curriculumMutationRevision += 1;
      state.curriculumUndoStack.push(snapshot);
      if (state.curriculumUndoStack.length > 50) state.curriculumUndoStack.shift();
      $("#undoCurriculumEdit").disabled = false;
    }

    function undoCurriculumEdit() {
      const snapshot = state.curriculumUndoStack.pop();
      if (!snapshot) return;
      state.curriculumPlan = snapshot.curriculumPlan;
      state.curriculumTemplateRows = snapshot.curriculumTemplateRows;
      state.curriculumImportedLayout = snapshot.curriculumImportedLayout;
      state.curriculumPlanFileName = snapshot.curriculumPlanFileName;
      state.curriculumMutationRevision += 1;
      state.curriculumEditBefore = null;
      state.curriculumEditUndoRecorded = false;
      $("#undoCurriculumEdit").disabled = !state.curriculumUndoStack.length;
      renderCurriculumStep();
      persistState();
      status.style.color = "#596780";
      status.textContent = "편제표의 직전 변경을 실행취소했습니다.";
      showAppToast("편제표 수정을 실행취소했습니다.");
    }

    function curriculumFilterValues(layout) {
      const rows = expandCurriculumLayoutRows(layout);
      const columns = importedPlanColumnMap(layout);
      const areas = new Set();
      const excludedAreaPrefixes = [
        "표기방법안내",
        "2026학년도",
        "이수학점소개",
        "창의적체험활동",
        "학기별총이수학점"
      ];
      let lastArea = "";
      for (const row of rows) {
        const subject = columns.subject >= 0 ? String(row[columns.subject] ?? "").trim() : "";
        if (columns.area >= 0 && String(row[columns.area] ?? "").trim()) lastArea = String(row[columns.area]).trim();
        if (lastArea) lastArea = lastArea.replace(/↔/g, " ").trim();
        if (!subject || subject.includes("과목명") || subject.includes("세부과목")) continue;
        const normalizedArea = lastArea.replace(/\s+/g, "");
        if (lastArea && !excludedAreaPrefixes.some((prefix) => normalizedArea.includes(prefix))) {
          areas.add(lastArea);
        }
      }
      return [...areas].sort((a, b) => a.localeCompare(b, "ko"));
    }

    function updateCurriculumFilterOptions() {
      const areas = state.curriculumImportedLayout
        ? curriculumFilterValues(state.curriculumImportedLayout)
        : [];
      const controls = [
        ["#curriculumFilterGrade", "전체 학년", [
          { value: "1", label: "1학년" },
          { value: "2", label: "2학년" },
          { value: "3", label: "3학년" }
        ], state.curriculumPlanFilters.grade],
        ["#curriculumFilterDivision", "전체 교육과정", [
          { value: "학교 지정 교육과정", label: "학교지정 교육과정" },
          { value: "학생 선택 교육과정", label: "학생선택 교육과정" }
        ], state.curriculumPlanFilters.division],
        ["#curriculumFilterArea", "전체 교과군", areas, state.curriculumPlanFilters.area],
        ["#curriculumFilterDetail", "선택 유형", [
          { value: "공통", label: "공통" },
          { value: "일반선택", label: "일반" },
          { value: "진로선택", label: "진로" },
          { value: "융합선택", label: "융합" }
        ], state.curriculumPlanFilters.detail]
      ];
      for (const [selector, label, values, selected] of controls) {
        const control = $(selector);
        const normalized = values.map((value) => typeof value === "string"
          ? { value, label: value }
          : value);
        const available = normalized.some((option) => option.value === selected) ? selected : "";
        control.innerHTML = `<option value="">${label}</option>${normalized.map((option) =>
          `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("")}`;
        control.value = available;
        const keyBySelector = {
          "#curriculumFilterGrade": "grade",
          "#curriculumFilterDivision": "division",
          "#curriculumFilterArea": "area",
          "#curriculumFilterDetail": "detail"
        };
        state.curriculumPlanFilters[keyBySelector[selector]] = available;
        control.disabled = !normalized.length;
      }
      const queryInput = $("#curriculumFilterQuery");
      const query = state.curriculumPlanFilters.query || "";
      if (queryInput.value !== query) queryInput.value = query;
    }

    function renderCurriculumStep() {
      const emptyRows = typeof curriculumEmptySubjectRows === "function" ? curriculumEmptySubjectRows(state.curriculumImportedLayout) : [];
      const emptyRowsToggle = $("#curriculumEmptyRowsToggle");
      emptyRowsToggle.classList.toggle("hidden", !emptyRows.length);
      emptyRowsToggle.textContent = `빈 과목 행 ${emptyRows.length}개 ${state.curriculumImportedLayout?.showEmptySubjectRows ? "접기" : "표시"}`;
      emptyRowsToggle.setAttribute("aria-pressed", String(Boolean(state.curriculumImportedLayout?.showEmptySubjectRows)));
      $("#teacherWorkspace").classList.toggle("curriculum-top-collapsed", state.curriculumTopCollapsed);
      $("#curriculumTopToggle").setAttribute("aria-expanded", String(!state.curriculumTopCollapsed));
      $("#curriculumTopToggle").textContent = state.curriculumTopCollapsed ? "상단 펼치기" : "상단 접기";
      curriculumCellSelection = null;
      curriculumSelectionAnchor = null;
      curriculumSelectionDragging = false;
      curriculumSelectionGesture = null;
      $("#curriculumMergeApply").disabled = true;
      $("#curriculumMergeRelease").disabled = true;
      $("#curriculumMergeSelection").textContent = "셀 선택: 드래그·Shift+클릭 · 학기 세로 병합: 선택과목군 · 1·2학기 병합: 교차집중";
      $("#curriculumMergePick").closest("label").classList.remove("hidden");
      $("#curriculumMergeCredit").closest("label").classList.remove("hidden");
      $("#curriculumMergeToggle").disabled = !state.curriculumImportedLayout;
      $("#curriculumSplitMerged").disabled = !state.curriculumImportedLayout;
      $("#curriculumAddSubject").disabled = !state.curriculumImportedLayout;
      if (isDerivedAnnualPlan()) {
        for (const id of ["curriculumMergeToggle", "curriculumSplitMerged", "curriculumAddSubject", "addCurriculumPlanRow",
          "openCurriculumVersionSave", "clearCurriculumPlan"]) $(`#${id}`).disabled = true;
        $("#curriculumMergeControls").classList.add("hidden");
      }
      renderCurriculumCohortUploads();
      if (typeof renderCurriculumVersions === "function") renderCurriculumVersions();
      if (typeof ensureCurriculumHiddenRows === "function") ensureCurriculumHiddenRows();
      $("#undoCurriculumEdit").disabled = !state.curriculumUndoStack.length;
      $("#clearCurriculumPlan").disabled = (!state.curriculumImportedLayout && !state.curriculumPlan.length) || isDerivedAnnualPlan();
      $("#exportCurriculumPlan").disabled = !state.curriculumImportedLayout && !state.curriculumPlan.length;
      updateCurriculumFilterOptions();
      const planLabel = state.curriculumPlanType === "annual"
        ? `${state.curriculumCohortYear}학년도 전학년`
        : `${state.curriculumCohortYear}학년도 신입생 3개년`;
      $("#curriculumTemplateFileName").textContent = state.curriculumPlanFileName
        ? `${planLabel} 편제표 · ${state.curriculumPlanFileName}`
        : `${planLabel} 편제표를 불러오지 않았습니다.`;
      $("#curriculumSelectionGroupEditor").innerHTML = curriculumSelectionGroupEditorHtml();
      const importedLayout = state.curriculumImportedLayout;
      if (importedLayout) {
        ensureCurriculumChangeBaseline(importedLayout);
        const changes = curriculumTableChanges(importedLayout);
        const removedSubjects = [...changes.values()].filter((change) => change.kind === "removed").length;
        $("#curriculumChangeSummary").textContent = importedLayout.changeBaseline?.version === 2
          ? `${importedLayout.changeBaseline.source === "saved" ? "마지막 저장본" : importedLayout.changeBaseline.source === "original" ? "최초 업로드(저장본 없음)" : "비교 기준 설정 시점"} 대비 초안 변경 ${changes.size - removedSubjects}과목 · 과목명 음영${removedSubjects ? ` · 삭제 ${removedSubjects}과목(이력 확인)` : ""}`
          : importedLayout.changeBaselineError ? `변경 비교 실패: ${importedLayout.changeBaselineError}` : "원본과 변경 내용 비교 준비 중";
        const planRows = state.curriculumPlan.map((item, index) => ({ item, index }));
        $("#curriculumPlanWrap").innerHTML =
          `${curriculumBundleSummaryHtml(planRows.map(({ item }) => item), importedLayout)}` +
          `${curriculumImportedGradeSummaries(planRows, importedLayout)}` +
          `${curriculumImportedSheetHtml(importedLayout, state.curriculumPlanFilters, curriculumCellSelectionMode, state.curriculumTopCollapsed)}`;
      } else {
        $("#curriculumChangeSummary").textContent = "";
        $("#curriculumPlanWrap").innerHTML = '<div class="curriculum-empty">편제표 파일을 불러오면 여기에 표시됩니다.</div>';
        $("#curriculumFilterCount").textContent = "0개 과목 표시";
      }
      scheduleCurriculumTableSize();
    }

    function curriculumColorGroupOptions(layout, grade, semester) {
      const normalizedGrade = String(grade);
      const normalizedSemester = String(semester);
      if (!layout || !["2", "3"].includes(normalizedGrade) || !["1", "2"].includes(normalizedSemester)) return [];
      const columns = importedPlanColumnMap(layout);
      const semesterColumn = columns.semesters[(Number(normalizedGrade) - 1) * 2 + Number(normalizedSemester) - 1];
      if (!Number.isInteger(semesterColumn) || semesterColumn < 0) return [];
      const rows = expandCurriculumLayoutRows(layout);
      const groups = new Map();
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const label = String(rows[rowIndex]?.[semesterColumn] ?? "").trim().match(/^택\s*(\d+)$/);
        if (!label) continue;
        const fill = curriculumCellFill(layout, rowIndex, semesterColumn);
        if (!fill) continue;
        const key = `${label[0].replace(/\s+/g, "")}:${fill.toUpperCase()}`;
        if (!groups.has(key)) groups.set(key, {
          name: label[0].replace(/\s+/g, ""),
          count: Number(label[1]),
          grade: normalizedGrade,
          semester: normalizedSemester,
          fill,
          rowIndex,
          courses: new Set()
        });
      }
      for (const group of groups.values()) {
        for (const context of importedPlanCourseContexts(layout, columns)) {
          if (normalizeCurriculumDivision(context.division) !== "학생 선택 교육과정" ||
              !isSelectableDetail(context.selectionType || context.detail) ||
              curriculumCellFill(layout, context.rowIndex, semesterColumn).toUpperCase() !== group.fill.toUpperCase()) continue;
          const rowText = [context.subject, ...context.row].join(" ").replace(/\s+/g, "");
          if (/공동교육과정|공동(?=[,，、/·;:()（）\s]|$)|소인수/.test(rowText)) continue;
          for (const subject of String(context.subject).split(/[,，]/)
            .map((name) => name.replace(/↔/g, " ").replace(/^[*＊★☆■\s]+|[*＊★☆■\s]+$/g, "").trim())
            .filter(Boolean)) group.courses.add(subject);
        }
      }
      return [...groups.values()].map((group) => ({ ...group, courses: [...group.courses] }));
    }

    function aggregateRecords(
      students,
      courses,
      openingPercent,
      divisionPercent,
      classOverrides = {},
      semesterAssignments = {},
      groupAssignments = {},
      classBases = {}
    ) {
      const grades = [...new Set(students.map((student) => student.grade))];
      const reports = grades.map((grade) => {
        const gradeStudents = students.filter((student) => student.grade === grade);
        const gradeCourses = courses.filter((course) => !course.applicationCurrentGrade ||
          course.applicationCurrentGrade === String(grade));
        const applicationSubjects = gradeCourses.some((course) => !course.applicationSubject) &&
          typeof collectApplicationSubjects === "function"
          ? collectApplicationSubjects({ includeExcluded: true, currentGrade: String(grade) })
          : null;
        // 내년도 학급 수를 입력했으면 그 값을, 없으면 명단의 반 수를 학급당 기준 인원 계산에 쓴다.
        const rosterClasses = new Set(gradeStudents.map((student) => student.classroom)).size;
        const plannedClasses = Number(classBases?.[String(Number(grade) + 1)]);
        const classSource = Number.isInteger(plannedClasses) && plannedClasses > 0 ? "planned" : "roster";
        const classes = classSource === "planned" ? plannedClasses : rosterClasses;
        const summary = {
          grade,
          students: gradeStudents.length,
          classes,
          rosterClasses,
          classSource,
          averageClassSize: classes ? gradeStudents.length / classes : 0,
          openingLimit: classes ? (gradeStudents.length / classes) * openingPercent / 100 : 0,
          divisionLimit: classes ? (gradeStudents.length / classes) * divisionPercent / 100 : 0
        };
        const semesters = [];
        for (const course of gradeCourses) {
          const applicationSubject = course.applicationSubject || aggregateApplicationSubject(course, grade, applicationSubjects);
          const applicationSemester = applicationSubject?.semester || "";
          const applicationGroup = applicationGroupForCourse(course, grade, null, applicationSemester);
          const forcedSemester = semesterAssignments[String(course.column)];
          const parsedAssignedGroup = parseAssignedGroupLabel(groupAssignments[String(course.column)]);
          const semesterKey = course.applicationGroupSource === "online"
            ? (applicationGroup?.semester || course.semesterKey || "")
            : forcedSemester === "1" || forcedSemester === "2"
            ? forcedSemester
            : (applicationGroup?.semester || parsedAssignedGroup.semesterKey || course.semesterKey || "");
          const displayGrade = Number(grade) + 1;
          const semesterName = semesterKey
            ? `${displayGrade}학년 ${semesterKey}학기`
            : `${displayGrade}학년 미분류`;
          const category = applicationGroup?.name ||
            (course.applicationGroupSource === "online" ? "" : parsedAssignedGroup.category) || UNASSIGNED_GROUP;
          let semester = semesters.find((item) => item.name === semesterName);
          if (!semester) {
            semester = { name: semesterName, groups: [], order: semesterKey === "1" ? 1 : semesterKey === "2" ? 2 : 9 };
            semesters.push(semester);
          }
          let group = semester.groups.find((item) => item.category === category);
          if (!group) {
            group = { category, courses: [] };
            semester.groups.push(group);
          }
          const enrollment = gradeStudents.filter((student) =>
            student.selections.some((selection) => selection.column === course.column)).length;
          const recommendedClasses = summary.divisionLimit > 0 && enrollment > 0
            ? Math.ceil(enrollment / summary.divisionLimit)
            : 0;
          const overrideKey = `${grade}:${course.column}`;
          const classCount = Object.prototype.hasOwnProperty.call(classOverrides, overrideKey)
            ? classOverrides[overrideKey]
            : recommendedClasses;
          group.courses.push({
            category,
            column: course.column,
            name: course.name,
            subjectName: applicationSubject?.subject || course.name,
            semesterKey: semesterKey === "1" || semesterKey === "2" ? semesterKey : "",
            displayName: applicationSubject ? applicationCourseLabel(applicationSubject) : course.name,
            enrollment,
            enrollmentPerDivision: summary.divisionLimit > 0 ? enrollment / summary.divisionLimit : 0,
            recommendedClasses,
            classCount,
            averageClassSize: classCount ? enrollment / classCount : 0
          });
        }
        for (const semester of semesters) {
          for (const group of semester.groups) {
            group.totalClasses = group.courses.reduce((total, item) => total + item.classCount, 0);
          }
        }
        semesters.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "ko"));
        return { summary, semesters };
      });
      return { openingPercent, divisionPercent, reports };
    }

    function aggregateApplicationSubject(course, currentGrade, applicationSubjects) {
      const normalize = (name) => String(name ?? "").trim()
        .replace(/\s*\([23]학년\)$/, "")
        .replace(/\s*\([12]학기\)/g, "")
        .replace(/\s*\((?:공통|일반|진로|융합)(?:선택)?\)$/, "")
        .replace(/\s+/g, " ").trim();
      const normalizedName = normalize(course.name);
      const matches = (applicationSubjects?.[String(Number(currentGrade) + 1)] || []).filter((subject) =>
        normalize(subject.subject) === normalizedName);
      const semester = String(course.semesterKey || parseSemesterFromCourseName(course.name) || "");
      const semesterMatches = semester
        ? matches.filter((subject) => subject.semester?.split("·").includes(semester))
        : matches;
      return semesterMatches.length === 1 ? semesterMatches[0] : matches.length === 1 ? matches[0] : null;
    }

    function currentStudent() {
      return state.students.find((student) => student.id === state.selectedId) || null;
    }

    function visibleStudents() {
      const query = $("#searchInput").value.trim().toLocaleLowerCase();
      const classValue = $("#classFilter").value;
      const gradeValue = $("#gradeFilter")?.value || "";
      return state.students.filter((student) => {
        const searchable = `${student.name} ${student.grade} ${student.classroom} ${student.number}`.toLocaleLowerCase();
        return (!query || searchable.includes(query)) &&
          (!gradeValue || String(student.grade) === gradeValue) &&
          (!classValue || student.classroom === classValue);
      });
    }

    function renderRoster() {
      const students = visibleStudents();
      $("#studentCount").textContent = `${students.length} / ${state.students.length}명`;
      const list = $("#studentList");
      if (!students.length) {
        const empty = document.createElement("div");
        empty.className = "empty-roster";
        empty.textContent = "검색 결과가 없습니다.";
        list.replaceChildren(empty);
        return;
      }
      const template = document.createElement("template");
      template.innerHTML = `<button class="student-item" type="button">
        <span class="student-avatar"></span>
        <span class="student-info"><span class="student-name"></span><span class="student-meta"></span></span>
        <span class="student-courses"></span>
      </button>`;
      const fragment = document.createDocumentFragment();
      for (const student of students) {
        const item = template.content.firstElementChild.cloneNode(true);
        const selected = student.id === state.selectedId;
        item.className = `student-item${selected ? " selected" : ""}`;
        item.dataset.studentId = student.id;
        item.setAttribute("aria-pressed", String(selected));
        item.querySelector(".student-avatar").textContent = student.number;
        item.querySelector(".student-name").textContent = student.name;
        item.querySelector(".student-meta").textContent =
          `${student.grade}학년 ${student.classroom}반 ${student.number}번`;
        item.querySelector(".student-courses").textContent = `${student.selections.length}과목`;
        fragment.appendChild(item);
      }
      list.replaceChildren(fragment);
    }

    // 그룹 설정을 읽는 데 약 50ms가 걸리므로 일괄 인쇄에서는 한 번만 읽어 학생마다 넘긴다.
    function certificateGroupSettings() {
      return typeof getApplicationGroupSettings === "function" ? getApplicationGroupSettings() : [];
    }

    function certificateMarkup(student, printMode = false, groupSettings = certificateGroupSettings()) {
      const groups = [];
      for (const course of student.selections) {
        const groupName = courseGroupLabel(course, student.grade, groupSettings);
        let group = groups.find((item) => item.name === groupName);
        if (!group) { group = { name: groupName, courses: [] }; groups.push(group); }
        group.courses.push(course);
      }
      const body = groups.length
        ? groups.map((group) => group.courses.map((course, index) => `
            <tr>${index === 0 ? `<td class="group-cell" rowspan="${group.courses.length}">${escapeHtml(group.name)}</td>` : ""}
              <td class="course-cell">${escapeHtml(course.applicationSubject ? applicationCourseLabel(course.applicationSubject) : course.name)}</td><td class="credit-cell">${course.credits || "—"}</td></tr>`).join("")).join("")
        : '<tr><td colspan="3" style="height:56px;text-align:center">신청 과목이 없습니다.</td></tr>';
      const coreCredits = student.selections.reduce((sum, course) =>
        sum + (isCoreCourse(course) ? Number(course.credits) || 0 : 0), 0);
      const corePercent = student.totalCredits ? Math.round(coreCredits / student.totalCredits * 100) : 0;
      const gauge = !printMode ? `<div class="paper-credit-gauge" aria-label="총 ${student.totalCredits}학점 중 국어·영어·수학 ${coreCredits}학점, ${corePercent}%">
        <div class="paper-credit-gauge-label"><strong>신청 학점 ${student.totalCredits}학점</strong><span>국·영·수 ${coreCredits}학점 · ${corePercent}%</span></div>
        <span class="paper-credit-gauge-track core"><span style="width:${corePercent}%"></span></span>
      </div>` : "";
      return `<article class="${printMode ? "print-page" : "preview-paper"}">
        <div class="paper">
          <h2 class="paper-title">학생 수강 신청 확인서</h2>
          <div class="paper-meta"><span class="academic">${escapeHtml($("#schoolYear").value || "____")}학년도&nbsp; ${escapeHtml($("#round").value || "수강 신청")}</span><span>${escapeHtml(Number(student.grade) + 1)}학년 선택과목 신청</span></div>
          <p class="paper-student">${escapeHtml(student.grade)} 학년&nbsp;&nbsp; ${escapeHtml(student.classroom)} 반&nbsp;&nbsp; ${escapeHtml(student.number)} 번&nbsp;&nbsp; ${escapeHtml(student.name)}</p>
          <table class="certificate-table">
            <thead><tr><th class="group-cell">선택군</th><th class="course-cell">과목명</th><th class="credit-cell">학점</th></tr></thead>
            <tbody>${body}</tbody>
          </table>
          ${gauge}
          <p class="paper-total">총 ${student.selections.length}과목(${student.totalCredits}학점)을 위와 같이 수강 신청하였음을 확인합니다.</p>
          <div class="paper-signature">
            <div>${escapeHtml($("#confirmDate").value || "　　　년　　월　　일")}</div>
            <div>학생: ${escapeHtml(student.name)}&nbsp;&nbsp;&nbsp; (인)</div>
            <div>학부형:　　　　　　　　　(인)</div>
          </div>
          <p class="paper-school">${escapeHtml($("#schoolName").value || "학교명")}&nbsp; 귀하</p>
        </div>
      </article>`;
    }

    function renderPreview() {
      const student = currentStudent();
      const preview = $("#preview");
      if (!student) {
        preview.className = "placeholder";
        preview.innerHTML = '<div class="placeholder-icon" aria-hidden="true">▤</div><strong>확인서 미리보기</strong><span>학생 목록에서 확인할 학생을 선택하세요.</span>';
        $("#previewSubheading").textContent = `${state.students.length}명의 확인서를 준비했습니다.`;
        $("#printSelected").disabled = true;
        syncPrintAllButton();
        return;
      }
      preview.className = "preview-paper";
      preview.innerHTML = certificateMarkup(student);
      $("#previewSubheading").textContent = `${student.grade}학년 ${student.classroom}반 ${student.number}번 · ${student.selections.length}과목 · ${student.totalCredits}학점`;
      $("#printSelected").disabled = false;
      syncPrintAllButton();
    }

    function syncPrintAllButton() {
      const count = visibleStudents().length;
      const button = $("#printAll");
      button.disabled = count === 0;
      const classroom = $("#classFilter")?.value;
      const grade = $("#gradeFilter")?.value;
      const scope = `${grade ? `현 ${grade}학년 ` : classroom ? "전 학년 " : ""}${classroom ? `${classroom}반 ` : ""}`;
      button.textContent = count === 0 ? "검색 결과 전체 인쇄"
        : `${scope || "검색 결과 "}전체 인쇄 (${count}명)`;
    }

    function renderSemesterClassifier() {
      const container = $("#semesterClassifier");
      if (!state.courses.length) {
        container.innerHTML = "";
        return;
      }
      const customAndAssigned = availableGroupNames(state.courses).filter((name) => name !== UNASSIGNED_GROUP);
      const groupNames = [UNASSIGNED_GROUP, ...customAndAssigned];
      const groupedCourses = new Map(groupNames.map((name) => [name, []]));
      for (const course of state.courses) {
        const category = resolveCourseCategory(course);
        if (!groupedCourses.has(category)) groupedCourses.set(category, []);
        groupedCourses.get(category).push(course);
      }
      const selectedSet = new Set(state.selectedCourseColumns.map((value) => String(value)));
      const unassignedList = groupedCourses.get(UNASSIGNED_GROUP) || [];
      const renderCards = (list) => list.length
        ? list.map((course) => {
          const selectedClass = selectedSet.has(String(course.column)) ? " selected" : "";
          return `<div class="group-course-card${selectedClass}" draggable="true" data-drag-course-column="${course.column}">
            <span title="${escapeHtml(course.name)}">${escapeHtml(course.applicationSubject ? applicationCourseLabel(course.applicationSubject) : course.name)}</span>
            <span class="group-course-meta">${escapeHtml(course.credits || 0)}학점</span>
          </div>`;
        }).join("")
        : '<div class="group-drop-zone-empty">이 그룹으로 과목을 드래그하세요.</div>';
      container.innerHTML = `<div class="semester-classifier-header">
          <p class="semester-classifier-title">과목별 분류 설정</p>
          <span class="semester-classifier-note">Shift+클릭 범위 선택, Ctrl/Cmd+클릭 다중 선택 후 드래그로 한 번에 이동할 수 있습니다.</span>
        </div>
        <div class="group-manager">
          <div class="group-manager-form">
            <input id="newGroupName" type="text" placeholder="새 선택과목 그룹명 입력 (예: 융합탐구군)">
            <button class="button" type="button" data-action="add-group">그룹 추가</button>
          </div>
          <div class="group-chip-list">
            ${state.customGroupNames.length
              ? state.customGroupNames.map((name) =>
                `<span class="group-chip">${escapeHtml(name)}<button type="button" aria-label="${escapeHtml(name)} 그룹 삭제" data-action="remove-group" data-group-name="${escapeHtml(name)}">×</button></span>`).join("")
              : '<span class="group-chip-empty">추가된 사용자 그룹 없음</span>'}
          </div>
        </div>
        <section class="group-drop-zone group-unassigned-top" data-drop-group="${escapeHtml(UNASSIGNED_GROUP)}">
          <p class="group-drop-zone-title">${escapeHtml(UNASSIGNED_GROUP)} 과목</p>
          <div class="group-drop-zone-list horizontal">
            ${renderCards(unassignedList)}
          </div>
        </section>
        <p class="group-board-title">생성된 과목군</p>
        <div class="group-dnd-board">
          ${customAndAssigned.length
            ? customAndAssigned.map((groupName) => {
            const list = groupedCourses.get(groupName) || [];
            return `<section class="group-drop-zone" data-drop-group="${escapeHtml(groupName)}">
              <p class="group-drop-zone-title">${escapeHtml(groupName)}</p>
              <div class="group-drop-zone-list">
                ${renderCards(list)}
              </div>
            </section>`;
          }).join("")
            : '<div class="group-drop-zone-empty">그룹을 추가하면 여기에 과목군이 표시됩니다.</div>'}
        </div>`;
    }

    function aggregateThresholds() {
      const openingPercent = Number($("#openingPercent").value);
      const divisionPercent = Number($("#divisionPercent").value);
      if (!Number.isInteger(openingPercent) || openingPercent < 1 || openingPercent > 200 ||
          !Number.isInteger(divisionPercent) || divisionPercent < 1 || divisionPercent > 300) {
        throw new Error("개설 기준은 1~200%, 분반 기준은 1~300%의 정수로 입력하세요.");
      }
      return { openingPercent, divisionPercent };
    }

    let aggregateGradeScope = "";
    function renderAggregate() {
      if (!state.students.length || !state.courses.length) {
        $("#aggregateDescription").textContent = "학생별 신청 명단에서 과목별 인원을 계산했습니다.";
        $("#aggregateContent").innerHTML = '<div class="aggregate-empty">학생별 신청 명단을 불러오면 집계표가 표시됩니다.</div>';
        $("#downloadAggregate").disabled = true;
        return;
      }
      let thresholds;
      try {
        thresholds = aggregateThresholds();
      } catch (error) {
        $("#aggregateDescription").textContent = error.message;
        $("#aggregateContent").textContent = "유효한 기준 비율을 입력하면 집계를 다시 표시합니다.";
        $("#downloadAggregate").disabled = true;
        return;
      }
      const { openingPercent, divisionPercent } = thresholds;
      const classBases = typeof nextYearClassBases === "function" ? nextYearClassBases() : {};
      const locked = typeof isRoundLocked === "function" && isRoundLocked(state.currentRound);
      const aggregate = aggregateRecords(
        state.students, state.courses, openingPercent, divisionPercent,
        state.classOverrides, state.semesterAssignments, state.groupAssignments, classBases
      );
      let atRiskCount = 0;
      // 학년별 요약(전체 보기에서는 학년마다 따로 보여 주고, 학년을 고르면 그 학년만 집계한다).
      const gradeStats = aggregate.reports.map((report) => {
        const courses = report.semesters.flatMap((semester) => semester.groups.flatMap((group) => group.courses));
        return {
          grade: String(report.summary.grade), students: report.summary.students, courses: courses.length,
          classes: report.semesters.reduce((sum, semester) => sum + semester.groups.reduce((groupSum, group) => groupSum + group.totalClasses, 0), 0),
          risk: courses.filter((course) => course.enrollment < report.summary.openingLimit).length
        };
      });
      const scope = gradeStats.some((stat) => stat.grade === aggregateGradeScope) ? aggregateGradeScope : "";
      const shownReports = aggregate.reports.filter((report) => !scope || String(report.summary.grade) === scope);
      const shownStats = gradeStats.filter((stat) => !scope || stat.grade === scope);
      const courseTotal = shownStats.reduce((sum, stat) => sum + stat.courses, 0);
      const totalStudents = shownStats.reduce((sum, stat) => sum + stat.students, 0);
      const totalClasses = shownStats.reduce((sum, stat) => sum + stat.classes, 0);
      const gradeLabel = (grade) => `현 ${grade}학년 → ${Number(grade) + 1}학년 신청`;
      const gradeTabs = `<div class="aggregate-grade-tabs" role="group" aria-label="학년 선택">` +
        [["", "전체 학년"], ...gradeStats.map((stat) => [stat.grade, gradeLabel(stat.grade)])].map(([value, label]) =>
          `<button type="button" class="aggregate-grade-tab" data-aggregate-grade="${value}" aria-pressed="${value === scope}">${label}</button>`).join("") + `</div>`;
      const missingGrades = ["1", "2"].filter((grade) => !gradeStats.some((stat) => stat.grade === grade));
      const missingNote = missingGrades.length
        ? `<p class="aggregate-missing-note" role="status">${missingGrades.map((grade) => `현 ${grade}학년`).join("·")} 결과가 아직 없어 표시되지 않습니다. 2단계에서 학년 탭을 고르고 결과 엑셀을 올리면 함께 집계됩니다.</p>` : "";
      const gradeBreakdown = !scope && gradeStats.length > 1
        ? `<p class="aggregate-grade-breakdown">${gradeStats.map((stat) =>
          `<span><strong>${gradeLabel(stat.grade)}</strong> ${stat.students}명 · ${stat.courses}과목 · 개설 ${stat.classes}학급 · 기준 미달 ${stat.risk}과목</span>`).join("")}</p>` : "";
      $("#aggregateContent").innerHTML = gradeTabs + `<div class="aggregate-overview" aria-label="집계 요약">
        <div class="aggregate-overview-card"><span>신청 학생${scope ? ` (${gradeLabel(scope)})` : ""}</span><strong>${totalStudents}명</strong></div>
        <div class="aggregate-overview-card"><span>집계 과목</span><strong>${courseTotal}과목</strong></div>
        <div class="aggregate-overview-card"><span>개설 학급 합계</span><strong>${totalClasses}학급</strong></div>
        <div class="aggregate-overview-card risk"><span>개설 기준 미달</span><strong data-aggregate-risk-count>집계 중</strong></div>
      </div>${gradeBreakdown}${missingNote}` + shownReports.map(({ summary, semesters }) => {
        const semesterTables = semesters.map((semester) => {
          const maxCourses = Math.max(...semester.groups.map((group) => group.courses.length));
          const rows = semester.groups.map((group) => {
            const headerCells = group.courses.map((course) => {
              const risk = course.enrollment < summary.openingLimit;
              if (risk) atRiskCount += 1;
              return `<th class="aggregate-subject${risk ? " at-risk" : ""}">${escapeHtml(course.displayName || course.name)}${risk ? '<span class="at-risk-badge">기준 미달</span>' : ""}</th>`;
            }).join("");
            const paddingCells = Array.from({ length: maxCourses - group.courses.length }, () => "<th></th>").join("");
            const totalCell = `<th class="aggregate-total" rowspan="5">총 학급수<br><strong>${group.totalClasses}</strong></th>`;
            const metricRows = [
              ["인원 수", (course) => {
                const percent = summary.openingLimit > 0
                  ? Math.round(course.enrollment / summary.openingLimit * 100) : 0;
                const width = Math.max(0, Math.min(100, percent));
                const met = course.enrollment >= summary.openingLimit;
                return `<span class="aggregate-enrollment"><span class="aggregate-enrollment-value">${course.enrollment}명${met ? "" : " · 기준 미달"}</span><span class="aggregate-progress-track ${met ? "met" : "below"}" role="img" aria-label="개설 기준의 ${percent}%"><span style="width:${width}%"></span></span></span>`;
              }],
              ["인원수/분반기준", (course) => course.enrollmentPerDivision.toFixed(2)],
              ["개설 학급수", (course) => `<input class="aggregate-class-input" type="number" min="0" step="1" value="${course.classCount}" aria-label="${escapeHtml(semester.name)} ${escapeHtml(course.displayName || course.name)} 개설 학급수" data-grade="${escapeHtml(summary.grade)}" data-course-column="${course.column}"${locked ? ' disabled title="확정된 차수입니다. 확정 해제 후 수정하세요."' : ""}>`],
              ["학급당 학생수", (course) => course.averageClassSize.toFixed(2)]
            ].map(([label, value]) => {
              const values = group.courses.map((course) => `<td>${value(course)}</td>`).join("");
              const blanks = Array.from({ length: maxCourses - group.courses.length }, () => "<td></td>").join("");
              return `<tr><th class="aggregate-row-label">${label}</th>${values}${blanks}</tr>`;
            }).join("");
            return `<table class="aggregate-sheet-table"><caption>${escapeHtml(group.category)}</caption><tbody><tr><th class="aggregate-row-label">과목</th>${headerCells}${paddingCells}${totalCell}</tr>${metricRows}</tbody></table>`;
          }).join("");
          return `<h3 class="aggregate-semester">${escapeHtml(semester.name)}</h3><div class="aggregate-sheet-wrap">${rows}</div>`;
        }).join("");
        const displayGrade = Number(summary.grade) + 1;
        return `<section class="aggregate-grade">
          <h3 class="aggregate-grade-heading"><span class="aggregate-grade-badge">현 ${summary.grade}학년 → ${displayGrade}학년 신청</span>${displayGrade}학년(현${summary.grade}학년) 수강신청결과(${escapeHtml($("#round").value || "1차")})<span class="aggregate-grade-date">${escapeHtml($("#confirmDate").value)}</span></h3>
          <div class="aggregate-kpis">
            <div class="aggregate-kpi"><span class="aggregate-kpi-label">총학생수</span><span class="aggregate-kpi-value">${summary.students}</span></div>
            <div class="aggregate-kpi"><span class="aggregate-kpi-label">학급 수 (${summary.classSource === "planned" ? "내년도 편성 입력값" : "명단의 반 수"})</span><span class="aggregate-kpi-value">${summary.classes}</span></div>
            <div class="aggregate-kpi"><span class="aggregate-kpi-label">학급당 학생수</span><span class="aggregate-kpi-value">${summary.averageClassSize.toFixed(2)}</span></div>
            <div class="aggregate-kpi"><span class="aggregate-kpi-label">학급당 학생수의 ${openingPercent}% (개설기준)</span><span class="aggregate-kpi-value highlight">${summary.openingLimit.toFixed(2)}</span></div>
            <div class="aggregate-kpi"><span class="aggregate-kpi-label">학급당 학생수의 ${divisionPercent}% (분반기준)</span><span class="aggregate-kpi-value">${summary.divisionLimit.toFixed(2)}</span></div>
            <p class="aggregate-kpi-note">학급당 학생수는 개설기준과 분반기준의 사이가 되도록 조정합니다. 기준 비율은 위 설정에서 변경할 수 있습니다.</p>
          </div>
          ${semesterTables}
        </section>`;
      }).join("");
      $("#aggregateDescription").textContent =
        `${state.currentRound}차${locked ? " · 확정됨(수정 잠금)" : ""} · ${scope ? gradeLabel(scope) : `${aggregate.reports.length}개 학년`} · 기준 비율 ${openingPercent}% / ${divisionPercent}% · 기준 미달 ${atRiskCount}과목 (폐강 확정 아님)`;
      $("#aggregateContent").querySelector("[data-aggregate-risk-count]").textContent = `${atRiskCount}과목`;
      $("#downloadAggregate").disabled = false;
    }

    function renderRoundStatus() {
      const statusLabel = (round) => typeof roundStatusLabel === "function" ? roundStatusLabel(round) : "";
      $("#roundSelector").innerHTML = applicationRoundNumbers().map((round) =>
        `<button class="round-tab" type="button" role="tab" data-round="${round}" aria-selected="${round === state.currentRound}">${round}차${statusLabel(round) && statusLabel(round) !== "작성 중" ? ` <small class="round-tab-status">${escapeHtml(statusLabel(round))}</small>` : ""}</button>`
      ).join("");
      const badge = $("#certificateRoundBadge");
      if (badge) badge.textContent = `${state.currentRound}차`;
      const aggregateBadge = $("#aggregateRoundBadge");
      if (aggregateBadge) aggregateBadge.textContent = `${state.currentRound}차`;
      const list = $("#roundStatusList");
      if (!list) return;
      list.innerHTML = applicationRoundNumbers().map((round) => {
        const data = state.rounds?.[round];
        const students = data?.students.filter((student) => String(student.grade) === (state.applicationMenuGrade || "1")) || [];
        const info = data
          ? `${escapeHtml(data.gradeFiles?.[state.applicationMenuGrade || "1"] || data.fileName || "이전 파일")} · 현재 ${state.applicationMenuGrade || "1"}학년 ${students.length}명`
          : "불러온 명단 없음";
        const current = round === state.currentRound ? " · 현재 보기" : "";
        const roundState = statusLabel(round) ? ` · ${escapeHtml(statusLabel(round))}` : "";
        const button = data && round !== state.currentRound
          ? `<button class="button" type="button" data-view-round="${round}">이 차수 보기</button>`
          : "";
        return `<div class="round-status-item"><strong>${round}차${current}${roundState}</strong><span>${info}</span>${button}</div>`;
      }).join("");
    }

    function renderClosurePanel(round) {
      const data = state.rounds?.[round];
      $("#closureTitle").textContent = `${round}차 개설/폐강 검토`;
      const description = $("#closureDescription");
      const content = $("#closureContent");
      if (!data) {
        description.textContent = `${round}차 수강신청 데이터가 없습니다. 2단계에서 ${round}차 명단을 불러오세요.`;
        content.innerHTML = "";
        return;
      }
      description.textContent = `${round}차 결과 기준입니다. 개설기준과 자동 판정을 참고해 과목별 개설/폐강 여부를 검토하세요.`;
      let thresholds;
      try {
        thresholds = aggregateThresholds();
      } catch (error) {
        description.textContent = error.message;
        content.textContent = "유효한 기준 비율을 입력한 뒤 최종 결정을 검토하세요.";
        return;
      }
      const { openingPercent, divisionPercent } = thresholds;
      const locked = typeof isRoundLocked === "function" && isRoundLocked(round);
      const aggregate = aggregateRecords(
        data.students, data.courses, openingPercent, divisionPercent,
        data.classOverrides || {}, data.semesterAssignments || {}, data.groupAssignments || {},
        typeof nextYearClassBases === "function" ? nextYearClassBases() : {}
      );
      const closures = state.roundClosures[round] || {};
      if (locked) description.textContent = `${round}차 결과가 확정되어 개설/폐강 결정이 잠겨 있습니다. 수정하려면 위에서 확정을 해제하세요.`;
      content.innerHTML = aggregate.reports.map(({ summary, semesters }) => {
        const rowsHtml = semesters.flatMap((semester) =>
          semester.groups.flatMap((group) =>
            group.courses.map((course) => ({ semester: semester.name, course }))))
          .map(({ semester, course }) => {
            const key = `${summary.grade}:${course.column}`;
            const risk = course.enrollment < summary.openingLimit;
            const verdict = risk
              ? '<span class="closure-verdict-risk">기준 미달</span>'
              : '<span class="closure-verdict-open">기준 충족</span>';
            const confirmed = Object.hasOwn(closures, key) ? closures[key] : risk ? "" : "open";
            return `<tr>
              <td class="closure-subject">${escapeHtml(course.displayName || course.name)}</td>
              <td>${escapeHtml(semester)}</td>
              <td>${course.enrollment}</td>
              <td>${summary.openingLimit.toFixed(2)}</td>
              <td>${verdict}</td>
              <td><select class="closure-select" data-closure-round="${round}" data-closure-key="${escapeHtml(key)}" aria-label="${escapeHtml(course.displayName || course.name)} 교사 최종 결정"${locked ? " disabled" : ""}>
                <option value=""${confirmed === "" ? " selected" : ""}>미정</option>
                <option value="open"${confirmed === "open" ? " selected" : ""}>개설</option>
                <option value="closed"${confirmed === "closed" ? " selected" : ""}>폐강</option>
              </select></td>
            </tr>`;
          }).join("");
        return `<h3 class="closure-grade-heading">${Number(summary.grade) + 1}학년(현${summary.grade}학년) · 총 ${summary.students}명</h3>
          <p class="closure-decision-note">기준 판정은 참고 정보입니다. 개설 여부는 아래에서 교사가 최종 결정하세요.</p>
          <table class="closure-table"><thead><tr><th>과목</th><th>학기</th><th>신청 인원</th><th>개설기준</th><th>기준 비교</th><th>교사 최종 결정</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;
      }).join("");
    }

    function retakeTargets() {
      const rounds = applicationRoundNumbers();
      const sourceRound = [...rounds].reverse().find((round) => state.rounds?.[round]) || "1";
      const data = state.rounds?.[sourceRound] || null;
      const decisions = new Map();
      for (const round of rounds) {
        const roundData = state.rounds?.[round];
        for (const [key, verdict] of Object.entries(state.roundClosures?.[round] || {})) {
          if (verdict !== "open" && verdict !== "closed") continue;
          const separator = key.indexOf(":");
          if (separator < 1 || !roundData) continue;
          const grade = key.slice(0, separator);
          const column = key.slice(separator + 1);
          const course = roundData.courses.find((item) =>
            String(item.column) === column &&
            (!item.applicationCurrentGrade || String(item.applicationCurrentGrade) === grade));
          if (course) decisions.set(`${grade}:${course.name}`, verdict);
        }
      }
      const closedKeys = new Set([...decisions]
        .filter(([, value]) => value === "closed")
        .map(([key]) => key));
      const rows = [];
      if (data) {
        for (const student of data.students) {
          const closedCourses = student.selections.filter((selection) =>
            closedKeys.has(`${student.grade}:${selection.name}`));
          if (closedCourses.length) {
            rows.push({ student, courses: closedCourses.map((selection) => selection.name) });
          }
        }
      }
      return { sourceRound, data, rows, closedCount: closedKeys.size };
    }

    function renderRetakeProgress({ sourceRound, nextRound, data, rows, closedCount }) {
      const list = $("#retakeProgress");
      if (!list) return;
      const nextHasResult = !!state.rounds?.[nextRound]?.students?.length;
      const steps = [
        { done: closedCount > 0, label: "폐강 확정", detail: data ? (closedCount ? `${closedCount}과목 폐강` : "아래 집계표에서 개설/폐강을 정하세요") : `${sourceRound}차 결과 필요` },
        { done: closedCount > 0 && rows.length > 0, label: "재신청 대상 확인", detail: rows.length ? `대상 학생 ${rows.length}명 · 명단을 내려받거나 웹 수강신청에서 재신청 생성` : "폐강 과목을 신청한 학생이 없습니다" },
        { done: nextHasResult, label: `${nextRound}차 결과 반영`, detail: nextHasResult ? `${nextRound}차 결과 반영됨` : `2단계에서 ${nextRound}차를 추가해 결과 업로드` }
      ];
      const currentIndex = steps.findIndex((step) => !step.done);
      list.innerHTML = steps.map((step, index) =>
        `<li data-state="${step.done ? "done" : index === currentIndex ? "current" : "wait"}"${index === currentIndex ? ' aria-current="step"' : ""}><strong>${index + 1}. ${escapeHtml(step.label)}</strong><span>${escapeHtml(step.detail)}</span></li>`).join("");
    }

    function renderRetakePanel() {
      const { sourceRound, data, rows, closedCount } = retakeTargets();
      const nextRound = String(Number(sourceRound) + 1);
      const description = $("#retakeDescription");
      const content = $("#retakeContent");
      $("#retakePanel h2").textContent = `${nextRound}차 수강신청 대상자`;
      $("#retakeNextRoundNote").textContent = `${nextRound}차 결과는 2단계에서 차수를 추가한 뒤 불러오세요.`;
      $("#downloadRetakeList").disabled = !rows.length;
      renderRetakeProgress({ sourceRound, nextRound, data, rows, closedCount });
      if (!data) {
        description.textContent = "수강신청 데이터가 없습니다. 2단계에서 명단을 불러오세요.";
        content.innerHTML = "";
        return;
      }
      if (!closedCount) {
        description.textContent = "폐강으로 확정된 과목이 없습니다. 4단계 집계표 아래에서 개설/폐강을 검토하세요.";
        content.innerHTML = "";
        return;
      }
      description.textContent = `${sourceRound}차 결과 기준 · 폐강 확정 과목을 신청한 학생 ${rows.length}명`;
      content.innerHTML = `<table class="closure-table"><thead><tr><th>현 학년</th><th>반</th><th>번호</th><th>이름</th><th>신청 학년</th><th>폐강 과목</th></tr></thead><tbody>${
        rows.map(({ student, courses }) =>
          `<tr><td>${escapeHtml(student.grade)}</td><td>${escapeHtml(student.classroom)}</td><td>${escapeHtml(student.number)}</td><td>${escapeHtml(student.name)}</td><td>${Number(student.grade) + 1}학년</td><td class="closure-subject">${escapeHtml(courses.join(", "))}</td></tr>`).join("")
      }</tbody></table>`;
    }

    function downloadRetakeList() {
      const { sourceRound, rows } = retakeTargets();
      if (!rows.length) return;
      const nextRound = String(Number(sourceRound) + 1);
      const sheetRows = [
        ["현 학년", "반", "번호", "이름", "신청 학년", "폐강 과목"],
        ...rows.map(({ student, courses }) => [student.grade, student.classroom, student.number, student.name, `${Number(student.grade) + 1}학년`, courses.join(", ")])
      ];
      const rowsXml = sheetRows.map((cells, rowIndex) =>
        `<row r="${rowIndex + 1}">${cells.map((value, column) =>
          `<c r="${columnName(column)}${rowIndex + 1}" s="${rowIndex === 0 ? 2 : 7}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`).join("")}</row>`).join("");
      const columns = [8, 8, 8, 12, 10, 40].map((width, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
      const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews><cols>${columns}</cols><sheetData>${rowsXml}</sheetData></worksheet>`;
      const workbook = createXlsxBlob({
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${nextRound}차 대상자" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml": sheetXml,
        "xl/styles.xml": createStylesXml()
      });
      const link = document.createElement("a");
      const url = URL.createObjectURL(workbook);
      link.href = url;
      link.download = `${Number(sourceRound) + 1}차_수강신청_대상자(${sourceRound}차_기준).xlsx`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // 기존 신청 결과를 읽을 때는 제외 대상 과목도 매핑할 수 있도록 유지한다.
    function applicationCohortYear(currentGrade = state.applicationMenuGrade || "1") {
      const schoolYear = Number(typeof $ === "function" ? $("#schoolYear")?.value || "2026" : "2026");
      const grade = Number(currentGrade);
      return Number.isInteger(schoolYear) && Number.isInteger(grade) && grade >= 1 && grade <= 3
        ? String(schoolYear - grade + 1)
        : String(state.curriculumCohortYear || schoolYear);
    }
    getApplicationCohortYear = applicationCohortYear;

    function renderCurriculumCohortUploads() {
      const schoolYear = Number($("#schoolYear").value);
      if (!Number.isInteger(schoolYear) || schoolYear < 2000 || schoolYear > 2100) return;
      const uploadLabel = $("#curriculumPlanUploadLabel");
      if (uploadLabel) {
        uploadLabel.textContent = state.curriculumPlanFileName ? "선택 편제표 원본 교체" : "선택 편제표 업로드";
        uploadLabel.title = `${state.curriculumPlanType === "annual" ? "전학년" : "신입생 3개년"} 편제표 · 현재 선택한 ${state.curriculumCohortYear}학년도 자료`;
      }
      const cohortCards = CURRICULUM_COHORT_GRADES.map((grade) => {
        const year = String(schoolYear - Number(grade) + 1);
        const active = state.curriculumPlanType !== "annual" && year === String(state.curriculumCohortYear);
        const fileName = active ? state.curriculumPlanFileName : state.curriculumCohorts?.[year]?.fileName;
        const description = grade === "0"
          ? "내년도 1학년 시수 통계용 · 신입생 편제표가 정해지면 업로드"
          : grade === "1"
            ? `현 1학년은 이 편제표의 2학년 과목으로 신청`
            : grade === "2"
              ? `현 2학년은 이 편제표의 3학년 과목으로 신청`
              : "올해 전학년 편제표의 3학년 열을 만드는 데 사용 · 수강신청에는 쓰지 않음";
        return `<article class="curriculum-cohort-card${active ? " is-active" : ""}">
          <h4>${year}학년도 입학생 · ${grade === "0" ? "내년도 신입생" : `현 ${grade}학년`}</h4>
          <p title="${escapeHtml(description)}">${grade === "0" ? "내년도 1학년 시수 기준" : grade === "3" ? "전학년 편제표의 3학년 열 기준" : `수강신청: ${Number(grade) + 1}학년 과목 기준`}</p>
          <p class="curriculum-cohort-file" title="${escapeHtml(fileName || "미업로드 · 1~3학년 전체 편제표 필요")}">${escapeHtml(fileName || "미업로드")}</p>
          <div><button class="button${fileName ? "" : " button-primary"}" type="button" data-cohort-upload="${year}" aria-label="${year}학년도 신입생 3개년 편제표 ${fileName ? "원본 교체" : "업로드"}">${fileName ? "원본 교체" : "업로드"}</button>
          <button class="button" type="button" data-cohort-view="${year}" aria-pressed="${active}" aria-label="${year}학년도 신입생 3개년 편제표 보기">${active ? "편집 중" : "편제표 보기"}</button></div>
        </article>`;
      }).join("");
      const annualYear = String(schoolYear);
      const annualActive = state.curriculumPlanType === "annual" && annualYear === String(state.curriculumCohortYear);
      const cohorts = annualSourceCohorts();
      const sources = annualSourceStatus(cohorts, annualYear);
      const missing = sources.filter((source) => !source.rows);
      const stored = annualActive ? { signature: state.curriculumAnnualPlans?.[annualYear]?.signature, fileName: state.curriculumPlanFileName }
        : state.curriculumAnnualPlans?.[annualYear];
      const built = !!stored?.fileName;
      const stale = built && stored.signature !== undefined && stored.signature !== annualCurriculumSignature(cohorts, annualYear);
      const sourceLine = sources.map((source) => `${source.grade}학년 ${source.year} ${source.rows ? "✓" : "미업로드"}`).join(" · ");
      const annualCard = `<article class="curriculum-cohort-card curriculum-annual-card${annualActive ? " is-active" : ""}">
        <h4>${annualYear}학년도 전학년 편제표</h4>
        <p title="올해 1·2·3학년 입학생의 신입생 3개년 편제표에서 각 학년 열을 가져와 자동으로 만듭니다. 직접 수정하거나 따로 업로드하지 않습니다.">3개년 편제표에서 자동 생성</p>
        <p class="curriculum-cohort-file" title="${escapeHtml(sourceLine)}">${escapeHtml(missing.length ? `${missing.map((source) => `${source.grade}학년(${source.year})`).join("·")} 편제표 필요` : stale ? "원본이 바뀌었습니다. 다시 만드세요" : built ? "생성됨 · 원본과 일치" : "만들 준비 완료")}</p>
        <div><button class="button${built && !stale ? "" : " button-primary"}" type="button" data-annual-build="${annualYear}"${missing.length ? " disabled" : ""} aria-label="${annualYear}학년도 전학년 편제표 ${built ? "다시 만들기" : "만들기"}">${built ? "다시 만들기" : "만들기"}</button>
        <button class="button" type="button" data-annual-view="${annualYear}"${built ? "" : " disabled"} aria-pressed="${annualActive}" aria-label="${annualYear}학년도 전학년 편제표 보기">${annualActive ? "보는 중" : "편제표 보기"}</button></div>
      </article>`;
      $("#curriculumCohortUploads").innerHTML = cohortCards + annualCard;
    }

    function syncActiveCurriculumCohort() {
      const year = String(state.curriculumCohortYear || (typeof $ === "function" ? $("#schoolYear")?.value : "") || "2026");
      if (!/^\d{4}$/.test(year)) return;
      const isAnnual = state.curriculumPlanType === "annual";
      const target = isAnnual ? "curriculumAnnualPlans" : "curriculumCohorts";
      if (!state[target] || typeof state[target] !== "object") state[target] = {};
      const current = state[target][year];
      if (current && current.fileName === state.curriculumPlanFileName &&
          current.importedLayout === state.curriculumImportedLayout &&
          current.templateRows === state.curriculumTemplateRows && current.plan === state.curriculumPlan) return;
      state[target][year] = {
        fileName: state.curriculumPlanFileName || "",
        importedLayout: state.curriculumImportedLayout || null,
        templateRows: state.curriculumTemplateRows || [],
        plan: state.curriculumPlan || []
      };
    }

    function loadCurriculumPlanData(type, year) {
      if (curriculumSearchTimer !== null) {
        window.clearTimeout(curriculumSearchTimer);
        curriculumSearchTimer = null;
      }
      state.curriculumPlanType = type;
      state.curriculumCohortYear = String(year);
      const plans = type === "annual" ? state.curriculumAnnualPlans : state.curriculumCohorts;
      const plan = plans?.[String(year)];
      state.curriculumPlanFileName = plan?.fileName || "";
      state.curriculumImportedLayout = plan?.importedLayout || null;
      state.curriculumTemplateRows = plan?.templateRows || [];
      state.curriculumPlan = plan?.plan || [];
      state.curriculumPlanFilters = { grade: "", division: "", area: "", detail: "", query: "" };
      state.curriculumUndoStack = [];
      state.curriculumEditBefore = null;
      state.curriculumEditUndoRecorded = false;
      state.curriculumSelectedRow = null;
      state.curriculumSelectedColumn = null;
      state.curriculumMutationRevision += 1;
    }

    function switchCurriculumCohort(year) {
      const normalized = String(year || "").trim();
      const schoolYear = Number($("#schoolYear").value);
      const availableYears = CURRICULUM_COHORT_GRADES.map((grade) => String(schoolYear - Number(grade) + 1));
      if (!availableYears.includes(normalized)) {
        status.textContent = "표시된 신입생 3개년 편제표 카드에서 학년도를 선택하세요.";
        return;
      }
      if (state.curriculumPlanType !== "annual" && normalized === state.curriculumCohortYear) return;
      syncActiveCurriculumCohort();
      loadCurriculumPlanData("cohort", normalized);
      renderCurriculumStep();
      renderApplicationSubjects();
      renderWorkspaceContext();
      persistState();
      status.style.color = "#596780";
      status.textContent = state.curriculumImportedLayout
        ? `${normalized}학년도 신입생 편제표를 불러왔습니다.`
        : `${normalized}학년도 신입생 편제표가 없습니다. 이 학년도의 3개년 편제표를 업로드하세요.`;
    }

    // 3개년 편제표의 plan 행에는 학기 칸이 ●로만 남으므로, 전학년 편제표에 옮길 학점은 편제표 표의 칸 값에서 읽는다.
    // 병합된 선택과목군처럼 칸 값이 없으면 운영 학점으로 대신한다.
    const annualResolvedCache = new Map();
    function annualResolvedPlanRows(year, cohort) {
      const plan = cohort?.plan || [];
      const layout = cohort?.importedLayout || null;
      const cached = annualResolvedCache.get(year);
      if (cached && cached.plan === plan && cached.layout === layout) return cached.rows;
      let rows = [];
      if (plan.length) {
        const columns = layout ? importedPlanColumnMap(layout) : null;
        const sheetRows = layout ? expandCurriculumLayoutRows(layout) : [];
        const contexts = new Map();
        if (layout) {
          for (const context of importedPlanCourseContexts(layout, columns)) {
            for (const name of curriculumSubjectNames(context.subject)) contexts.set(name.replace(/\s+/g, ""), context);
          }
        }
        rows = plan.map((row) => {
          const context = contexts.get(String(row.subject ?? "").replace(/\s+/g, ""));
          const resolved = { ...row };
          CURRICULUM_SEMESTER_FIELDS.forEach((field, index) => {
            if (!String(row[field] ?? "").trim()) { resolved[field] = ""; return; }
            const column = columns?.semesters?.[index] ?? -1;
            const cell = context && column >= 0 ? Number(String(sheetRows[context.rowIndex]?.[column] ?? "").replace(/,/g, "")) : NaN;
            const credit = cell > 0 ? cell : Number(row.opCredit) || Number(row.baseCredit) || 0;
            resolved[field] = credit > 0 ? String(credit) : "";
          });
          return resolved;
        });
      }
      annualResolvedCache.set(year, { plan, layout, rows });
      return rows;
    }

    // 현재 보고 있는 편제표가 신입생 3개년 편제표라면 그 내용을 합쳐서, 아니면 저장된 카드 내용 그대로 쓴다.
    function annualSourceCohorts() {
      const cohorts = { ...(state.curriculumCohorts || {}) };
      if (state.curriculumPlanType !== "annual" && /^\d{4}$/.test(String(state.curriculumCohortYear))) {
        cohorts[state.curriculumCohortYear] = {
          fileName: state.curriculumPlanFileName, plan: state.curriculumPlan, importedLayout: state.curriculumImportedLayout
        };
      }
      return Object.fromEntries(Object.entries(cohorts).filter(([year]) => /^\d{4}$/.test(year)).map(([year, cohort]) =>
        [year, { fileName: cohort?.fileName || "", plan: annualResolvedPlanRows(year, cohort) }]));
    }

    function isDerivedAnnualPlan() {
      return state.curriculumPlanType === "annual" && !!state.curriculumImportedLayout?.derived;
    }

    // 올해 1·2·3학년 입학생의 3개년 편제표에서 학년별 열을 가져와 전학년 편제표를 만든다.
    function buildAnnualPlan(year) {
      const normalized = String(year || "").trim();
      const schoolYear = String($("#schoolYear").value || "");
      if (!/^\d{4}$/.test(normalized) || normalized !== schoolYear) {
        status.style.color = "#a44939";
        status.textContent = "올해 전학년 편제표만 만들 수 있습니다.";
        return false;
      }
      syncActiveCurriculumCohort();
      const cohorts = annualSourceCohorts();
      const missing = annualSourceStatus(cohorts, normalized).filter((source) => !source.rows);
      if (missing.length) {
        status.style.color = "#a44939";
        status.textContent = `${missing.map((source) => `${source.grade}학년 ${source.year}학년도 입학생`).join(", ")} 3개년 편제표를 먼저 업로드하세요.`;
        return false;
      }
      const existing = state.curriculumAnnualPlans?.[normalized];
      if (existing?.importedLayout && !existing.importedLayout.derived &&
          !window.confirm("이전에 업로드한 전학년 편제표가 있습니다. 3개년 편제표로 만든 편제표로 바꿀까요?")) return false;
      const layout = buildAnnualCurriculumLayout(cohorts, normalized);
      const plan = curriculumPlanFromLayout(layout, `${normalized} 전학년 편제표`, []);
      state.curriculumAnnualPlans ||= {};
      state.curriculumAnnualPlans[normalized] = {
        fileName: `${normalized}학년도 전학년 편제표 (3개년 편제표에서 자동 생성)`,
        importedLayout: layout,
        templateRows: plan.map((row) => normalizeCurriculumPlanRow(row)),
        plan,
        signature: annualCurriculumSignature(cohorts, normalized)
      };
      return true;
    }

    function switchCurriculumAnnualPlan(year, rebuild = false) {
      const normalized = String(year || "").trim();
      const schoolYear = String($("#schoolYear").value || "");
      if (!/^\d{4}$/.test(normalized) || normalized !== schoolYear) {
        status.style.color = "#a44939";
        status.textContent = "올해 전학년 편제표만 볼 수 있습니다.";
        return;
      }
      if (rebuild && !buildAnnualPlan(normalized)) {
        renderCurriculumStep();
        return;
      }
      if (!state.curriculumAnnualPlans?.[normalized]?.importedLayout) {
        status.style.color = "#a44939";
        status.textContent = "전학년 편제표를 먼저 만드세요.";
        return;
      }
      if (!rebuild && state.curriculumPlanType === "annual" && normalized === state.curriculumCohortYear) return;
      if (state.curriculumPlanType !== "annual" || normalized !== state.curriculumCohortYear) syncActiveCurriculumCohort();
      loadCurriculumPlanData("annual", normalized);
      renderCurriculumStep();
      renderWorkspaceContext();
      persistState();
      status.style.color = "#287956";
      status.textContent = rebuild
        ? `${normalized}학년도 전학년 편제표를 3개년 편제표에서 다시 만들었습니다.`
        : `${normalized}학년도 전학년 편제표를 불러왔습니다. 3개년 편제표를 고치면 '다시 만들기'로 반영하세요.`;
    }
    curriculumPlanVersionKey = () => state.curriculumPlanType === "annual"
      ? `annual:${state.curriculumCohortYear}`
      : String(state.curriculumCohortYear);

    function collectApplicationSubjects({ includeExcluded = false, currentGrade: requestedCurrentGrade } = {}) {
      if (typeof syncActiveCurriculumCohort === "function") syncActiveCurriculumCohort();
      const currentGrade = String(requestedCurrentGrade ?? state.applicationMenuGrade ?? "1");
      const schoolYear = Number(typeof $ === "function" ? $("#schoolYear")?.value || "2026" : "2026");
      const cohortYear = String(schoolYear - Number(currentGrade) + 1);
      const cohortLayout = state.curriculumCohorts?.[cohortYear]?.importedLayout;
      const layout = cohortLayout || (state.curriculumPlanType !== "annual" && String(state.curriculumCohortYear) === cohortYear
        ? state.curriculumImportedLayout
        : null);
      if (!layout) return null;
      const columns = importedPlanColumnMap(layout);
      if (columns.subject < 0) return null;
      const contexts = importedPlanCourseContexts(layout, columns);
      const choiceBlocks = typeof curriculumChoiceBlocks === "function" ? curriculumChoiceBlocks(layout, columns) : [];
      const result = { "1": [], "2": [], "3": [] };
      const seen = new Map();
      const planGroupAssignments = typeof curriculumPlanGroupAssignments === "function"
        ? curriculumPlanGroupAssignments(cohortYear)
        : new Map();
      const colorGroupCoursesBySemester = new Map();
      if (typeof curriculumColorGroupOptions === "function") {
        for (const grade of ["2", "3"]) {
          for (const semester of ["1", "2"]) {
            for (const group of curriculumColorGroupOptions(layout, grade, semester)) {
              const key = `${grade}:${semester}:${group.fill.toUpperCase()}`;
              if (!colorGroupCoursesBySemester.has(key)) colorGroupCoursesBySemester.set(key, new Set());
              for (const course of group.courses) colorGroupCoursesBySemester.get(key).add(course);
            }
          }
        }
      }
      for (const context of contexts) {
        if (!String(context.division || "").replace(/\s+/g, "").includes("학생선택교육과정")) continue;
        const rowText = [context.division, context.detail, context.subject, ...context.row]
          .map((value) => String(value ?? "").replace(/\s+/g, "")).join(" ");
        if (!includeExcluded && /공동교육과정|공동(?=[,，、/·;:()（）\s]|$)|소인수/.test(rowText)) continue;
        // 과목명 앞뒤의 표기 기호(*★☆■)와 교차집중 표시는 신청 양식에서 제외한다.
        const subject = context.subject.replace(/↔/g, " ").replace(/^[*＊★☆■\s]+|[*＊★☆■\s]+$/g, "").trim();
        if (!subject || subject.includes("과목명") || subject.includes("세부과목")) continue;
        // 공통/일반/진로/융합은 과목명이 아니라 선택과목의 분류이므로 과목명으로 들어온 경우 제외한다.
        if (["공통", "일반", "진로", "융합"].includes(subject.replace(/\s+/g, ""))) continue;
        // 교육과정 구분 표기(학생 선택 교육과정 등)가 과목명 칸에 들어온 경우도 제외한다.
        if (subject.includes("교육과정")) continue;
        const type = context.selectionType || "";
        const names = subject.split(/[,，]/).map((part) =>
          part.replace(/^[*＊★☆■\s]+|[*＊★☆■\s]+$/g, "").trim()).filter(Boolean);
        // 학기별 시수뿐 아니라 택n 태그와 색이 일치하는 표시 과목도 해당 학기에 포함한다.
        const byGrade = new Map();
        columns.semesters.forEach((column, index) => {
          if (column < 0) return;
          const value = String(context.row[column] ?? "").trim();
          const grade = Math.floor(index / 2) + 1;
          const sem = String((index % 2) + 1);
          if (!value) {
            if (grade !== 2 && grade !== 3) return;
            const fill = curriculumCellFill(layout, context.rowIndex, column).toUpperCase();
            if (!fill || !names.some((name) =>
              colorGroupCoursesBySemester.get(`${grade}:${sem}:${fill}`)?.has(name))) return;
            if (!byGrade.has(grade)) byGrade.set(grade, { semesters: [], hours: [] });
            byGrade.get(grade).semesters.push(sem);
            return;
          }
          if (/^[-–—]+$/.test(value) || /^0(?:\.0+)?$/.test(value)) return;
          if (/학년/.test(value)) {
            const notedGrade = value.match(/([123])\s*학년/)?.[1];
            const notedSemesters = value.match(/([12](?:\s*[,·]\s*[12])*)\s*학기/)?.[1];
            if (notedGrade && notedSemesters) {
              const semesters = notedSemesters.split(/[,·]/).map((part) => part.trim());
              byGrade.set(Number(notedGrade), { semesters, hours: [] });
            }
            return;
          }
          if (!byGrade.has(grade)) byGrade.set(grade, { semesters: [], hours: [] });
          byGrade.get(grade).semesters.push(sem);
          byGrade.get(grade).hours.push(value);
        });
        if (!byGrade.size && !columns.semesters.some((column) => column >= 0)) {
          const fallback = context.grade.match(/[123]/)?.[0];
          if (fallback) byGrade.set(Number(fallback), { semesters: [], hours: [] });
        }
        for (const block of choiceBlocks) {
          if (context.rowIndex < block.startRow || context.rowIndex > block.endRow) continue;
          const blockGrade = Number(block.grade);
          if (!byGrade.has(blockGrade)) byGrade.set(blockGrade, { semesters: [], hours: [] });
          const info = byGrade.get(blockGrade);
          if (info.semesters.includes(block.semester)) continue;
          info.semesters.push(block.semester);
          info.semesters.sort();
          info.hours.push(String(block.credit));
        }
        const creditColumn = columns.opCredit >= 0 ? columns.opCredit : columns.baseCredit;
        const credit = creditColumn >= 0
          ? Number(String(context.row[creditColumn]).replace(/[^\d.]/g, "")) || 0
          : 0;
        for (const [grade, info] of byGrade) {
          if (grade !== 2 && grade !== 3) continue;
          for (const name of names) {
            const key = `${grade}:${name}`;
            const semesterGroupAssignments = Object.fromEntries(info.semesters.flatMap((semester) => {
              const assignment = planGroupAssignments.get(`${grade}:${semester}:${name.replace(/\s+/g, "").toLowerCase()}`);
              return assignment ? [[semester, assignment]] : [];
            }));
            const existing = seen.get(key);
            if (existing) {
              existing.semester = [...new Set([...existing.semester.split("·"), ...info.semesters])]
                .filter(Boolean).sort().join("·");
              Object.assign(existing.semesterGroups, semesterGroupAssignments);
              for (const sem of info.semesters) existing.semesterColors[sem] =
                curriculumCellFill(layout, context.rowIndex, columns.semesters[(grade-1)*2+Number(sem)-1]);
              continue;
            }
            const item = {
              subject: name,
              area: context.area.replace(/↔/g, " ").trim(),
              type,
              semester: info.semesters.join("·"),
              semesterColors: Object.fromEntries(info.semesters.map((sem) =>
                [sem, curriculumCellFill(layout, context.rowIndex, columns.semesters[(grade-1)*2+Number(sem)-1])])),
              semesterGroups: semesterGroupAssignments,
              hours: info.hours.join("+"),
              credit
            };
            seen.set(key, item);
            result[String(grade)].push(item);
          }
        }
      }
      return result;
    }

    function selectedApplicationSubjects() {
      return collectApplicationSubjects();
    }

    function applicationCourseLabel(course) {
      const classification = curriculumSelectionType(course.type).replace(/선택$/, "");
      return `${course.subject}${classification ? `(${classification})` : ""}`;
    }

    function renderApplicationSubjects() {
      const container = $("#applicationSubjectList");
      if (!container) return;
      const subjects = collectApplicationSubjects();
      const total = subjects ? subjects["1"].length + subjects["2"].length + subjects["3"].length : 0;
      if (!total) {
        const year = applicationCohortYear();
        container.innerHTML = `<div class="curriculum-empty">${escapeHtml(year)}학년도 신입생 편제표의 학생선택교육과정에서 신청 학년 과목을 가져옵니다. 1단계에서 해당 코호트의 3개년 편제표를 업로드하세요.</div>`;
        if (typeof renderCourseGroups === "function") renderCourseGroups();
        return;
      }
      container.innerHTML = [String(Number(state.applicationMenuGrade || "1") + 1)].filter((grade) => subjects[grade].length).map((grade) => {
        const bySemester = new Map();
        for (const item of subjects[grade]) {
          const key = item.semester || "0";
          if (!bySemester.has(key)) bySemester.set(key, []);
          bySemester.get(key).push(item);
        }
        const semesterHtml = ["1", "2"].map((semester) => {
          const semesterCourses = bySemester.get(semester) || [];
          const items = semesterCourses.map((item) => {
            const meta = [item.type, item.area, item.credit ? `${item.credit}학점` : ""].filter(Boolean).join(" · ");
            return `<div class="application-subject"><span>${escapeHtml(item.subject)}</span><span class="application-subject-meta">${escapeHtml(meta)}</span></div>`;
          }).join("");
          return `<section class="application-semester-column"><h5 class="application-semester">${semester}학기 <span>${semesterCourses.length}과목</span></h5>${items || '<p class="application-semester-empty">등록된 과목 없음</p>'}</section>`;
        }).join("");
        const unscheduledHtml = (bySemester.get("0") || []).map((item) => {
          const meta = [item.type, item.area, item.credit ? `${item.credit}학점` : ""].filter(Boolean).join(" · ");
          return `<div class="application-subject"><span>${escapeHtml(item.subject)}</span><span class="application-subject-meta">${escapeHtml(meta)}</span></div>`;
        }).join("");
        const cohortYear = applicationCohortYear();
        return `<div class="application-grade">${grade}학년 과목 · ${escapeHtml(cohortYear)}학년도 신입생 편제표(현재 ${Number(grade) - 1}학년이 신청)</div><div class="application-semester-columns">${semesterHtml}</div>${unscheduledHtml ? `<section class="application-semester-column application-semester-unscheduled"><h5 class="application-semester">학기 미정</h5>${unscheduledHtml}</section>` : ""}`;
      }).join("");
      if (!container.innerHTML) container.innerHTML = `<div class="curriculum-empty">${Number(state.applicationMenuGrade || "1") + 1}학년 학생선택교육과정 과목이 없습니다. 편제표를 확인하세요.</div>`;
      if (typeof renderCourseGroups === "function") renderCourseGroups();
    }

    function buildApplicationPageHtml(subjects) {
      const schoolName = String($("#schoolName").value || "").trim();
      const schoolYear = String($("#schoolYear").value || "").trim();
      const dataJson = JSON.stringify(subjects).replace(/</g, "\\u003c");
      return [
        "<!DOCTYPE html>",
        '<html lang="ko"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<title>수강신청 - ${xmlEscape(schoolName)}</title>`,
        "<style>",
        "body{margin:0;background:#f2f5fb;font-family:'Malgun Gothic','Apple SD Gothic Neo',sans-serif;color:#1f2a44;}",
        ".wrap{max-width:720px;margin:0 auto;padding:24px 16px 60px;}",
        "h1{font-size:22px;margin:0 0 4px;}",
        ".school{color:#5f6d86;font-size:13px;margin:0 0 18px;}",
        ".id-panel{background:#fff;border:1px solid #d7deed;border-radius:12px;padding:14px;display:flex;flex-wrap:wrap;gap:10px;align-items:end;}",
        ".field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#50607b;}",
        ".field input,.field select{padding:8px;border:1px solid #c9d4ea;border-radius:8px;font-size:14px;width:90px;}",
        ".field input[name=name]{width:120px;}",
        "#targetInfo{font-size:14px;font-weight:700;color:#2f4f9f;margin:18px 0 8px;}",
        ".semester{margin:16px 0 6px;font-size:15px;font-weight:700;}",
        ".area{margin:10px 0 4px;font-size:13px;font-weight:700;color:#50607b;}",
        ".course{display:flex;align-items:center;gap:10px;min-height:48px;background:#fff;border:1px solid #d7dfed;border-radius:10px;padding:10px 12px;margin-bottom:7px;font-size:14px;cursor:pointer;}",
        ".course:has(input:checked){border:2px solid #3b68e8;padding:9px 11px;background:#eef3ff;}",
        ".course input{width:20px;height:20px;accent-color:#3b68e8;}",
        ".meta{margin-left:auto;font-size:11px;color:#7a879e;}",
        ".action-bar{position:sticky;bottom:0;margin:14px -4px -4px;padding:12px;border:1px solid #c8d6f7;border-radius:12px;background:#fffffff2;box-shadow:0 -6px 18px #1b31501c;backdrop-filter:blur(10px);}",
        ".summary{display:grid;gap:7px;font-weight:700;font-size:14px;color:#2f4f9f;}",
        ".summary-values{display:flex;justify-content:space-between;gap:8px;}",
        ".summary-values strong{color:#5b45b0;}",
        ".gauge{height:8px;overflow:hidden;border-radius:99px;background:#e4eaf5;}",
        ".gauge span{display:block;height:100%;border-radius:inherit;background:#6c55c7;}",
        "#submitBtn{width:100%;min-height:48px;margin-top:10px;padding:14px;border:0;border-radius:10px;background:#2f4f9f;color:#fff;font-size:16px;font-weight:700;cursor:pointer;}",
        "@media(max-width:480px){.wrap{padding:18px 12px calc(90px + env(safe-area-inset-bottom));}.id-panel{gap:8px}.field{flex:1 1 42%}.field input,.field select{width:100%}.course{font-size:14px}.action-bar{bottom:env(safe-area-inset-bottom);}}",
        ".note{margin-top:10px;font-size:12px;color:#60708a;line-height:1.6;}",
        ".error{color:#b3261e;font-size:13px;font-weight:700;}",
        "</style></head><body>",
        '<main class="wrap">',
        `<h1>${xmlEscape(schoolYear)}학년도 수강신청</h1>`,
        `<p class="school">${xmlEscape(schoolName)}</p>`,
        '<section class="id-panel">',
        '<label class="field">현재 학년<select id="grade"><option value="1">1학년</option><option value="2">2학년</option></select></label>',
        '<label class="field">반<input id="classroom" type="number" min="1" max="30"></label>',
        '<label class="field">번호<input id="number" type="number" min="1" max="99"></label>',
        '<label class="field">이름<input id="name" type="text" maxlength="20"></label>',
        "</section>",
        '<p id="targetInfo"></p>',
        '<div id="courseList"></div>',
        '<div class="action-bar"><div class="summary" id="summary"><div class="summary-values"><span id="summaryTotal">선택한 과목: 0개 · 0학점</span><strong id="summaryCore">국·영·수 0%</strong></div><div class="gauge" role="progressbar" aria-label="신청 학점 중 국어·영어·수학 과목 비율" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="summaryGauge"></span></div></div>',
        '<button id="submitBtn" type="button">신청 파일 저장</button></div>',
        '<p class="note">저장된 신청 파일(.json)을 담임선생님께 제출하세요. 이 페이지는 인터넷 연결 없이도 동작하며, 입력한 내용은 파일로만 저장됩니다.</p>',
        '<p class="error" id="errorMsg"></p>',
        "</main>",
        "<script>",
        `var COURSES = ${dataJson};`,
        "var gradeSel=document.getElementById('grade');",
        "function targetGrade(){return String(Number(gradeSel.value)+1);}",
        "function isCore(c){var a=String(c.area||c.category||'').replace(/\\s+/g,'');if(/국어|영어|수학/.test(a))return true;return /^(국어|화법과작문|독서와작문|문학|언어와매체|영어|영어회화|영어독해와작문|수학|대수|미적분|확률과통계|기하|경제수학|인공지능수학)/.test(String(c.subject||'').replace(/\\s+/g,''));}",
        "function esc(v){return String(v==null?'':v).replace(/[&<>\"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c];});}",
        "function render(){",
        "var tg=targetGrade();var list=COURSES[tg]||[];",
        "document.getElementById('targetInfo').textContent='신청 대상: '+tg+'학년 과목 ('+list.length+'개)';",
        "var semesters={};list.forEach(function(c){var s=c.semester||'0';if(!semesters[s])semesters[s]=[];semesters[s].push(c);});",
        "var html='';Object.keys(semesters).sort().forEach(function(s){",
        "html+='<div class=\"semester\">'+(s==='0'?'학기 미정':s+'학기')+'</div>';",
        "var areas={};semesters[s].forEach(function(c){var a=c.area||'선택과목';if(!areas[a])areas[a]=[];areas[a].push(c);});",
        "Object.keys(areas).forEach(function(a){html+='<div class=\"area\">'+esc(a)+'</div>';",
        "areas[a].forEach(function(c){var classification=String(c.type||'').replace(/선택$/,'');html+='<label class=\"course\"><input type=\"checkbox\" value=\"'+esc(c.subject)+'\" data-credit=\"'+c.credit+'\" data-core=\"'+(isCore(c)?'1':'0')+'\"><span>'+esc(c.subject+(classification?'('+classification+')':''))+'</span><span class=\"meta\">'+(c.credit?c.credit+'학점':'')+'</span></label>';});",
        "});});",
        "document.getElementById('courseList').innerHTML=html||'<p class=\"note\">신청할 수 있는 과목이 없습니다.</p>';",
        "updateSummary();",
        "document.querySelectorAll('#courseList input[type=checkbox]').forEach(function(box){box.addEventListener('change',updateSummary);});",
        "}",
        "function selectedCourses(){return Array.prototype.slice.call(document.querySelectorAll('#courseList input:checked'));}",
        "function updateSummary(){",
        "var sel=selectedCourses();var credits=sel.reduce(function(t,box){return t+(Number(box.dataset.credit)||0);},0);",
        "var core=sel.reduce(function(t,box){return t+(box.dataset.core==='1'?(Number(box.dataset.credit)||0):0);},0);var percent=credits?Math.round(core/credits*100):0;",
        "document.getElementById('summaryTotal').textContent='선택한 과목: '+sel.length+'개 · '+credits+'학점';",
        "document.getElementById('summaryCore').textContent='국·영·수 '+core+'학점 · '+percent+'%';",
        "var gauge=document.getElementById('summaryGauge');gauge.style.width=percent+'%';gauge.parentElement.setAttribute('aria-valuenow',String(percent));",
        "}",
        "gradeSel.addEventListener('change',render);render();",
        "document.getElementById('submitBtn').addEventListener('click',function(){",
        "var err=document.getElementById('errorMsg');err.textContent='';",
        "var classroom=document.getElementById('classroom').value.trim();",
        "var number=document.getElementById('number').value.trim();",
        "var name=document.getElementById('name').value.trim();",
        "var sel=selectedCourses().map(function(box){return box.value;});",
        "if(!classroom||!number||!name){err.textContent='반, 번호, 이름을 모두 입력하세요.';return;}",
        "if(!sel.length){err.textContent='신청할 과목을 1개 이상 선택하세요.';return;}",
        "var payload={type:'course-application',grade:gradeSel.value,classroom:classroom,number:number,name:name,selections:sel};",
        "var blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});",
        "var a=document.createElement('a');a.href=URL.createObjectURL(blob);",
        "a.download='수강신청_'+gradeSel.value+'학년_'+classroom+'반_'+number+'번_'+name+'.json';a.click();",
        "setTimeout(function(){URL.revokeObjectURL(a.href);},1000);",
        "err.textContent='';",
        "document.getElementById('summaryTotal').textContent='신청 파일을 저장했습니다. 파일을 담임선생님께 제출하세요.';",
        "});",
        "<\/script></body></html>"
      ].join("\n");
    }

    function mergeApplications(entries, applicationSubjects = null) {
      const subjects = applicationSubjects || collectApplicationSubjects({ includeExcluded: true }) || { "1": [], "2": [], "3": [] };
      const nameCount = new Map();
      for (const grade of ["1", "2", "3"]) {
        for (const item of subjects[grade] || []) {
          nameCount.set(item.subject, (nameCount.get(item.subject) || 0) + 1);
        }
      }
      const courses = [];
      const courseByGradeName = new Map();
      for (const grade of ["1", "2", "3"]) {
        for (const item of subjects[grade] || []) {
          // 학년이 다른 동일 이름 과목은 표기에 학년을 붙여 구분한다.
          const displayName = nameCount.get(item.subject) > 1 ? `${item.subject}(${grade}학년)` : item.subject;
          const course = {
            column: `app${courses.length}`,
            applicationCurrentGrade: String(Number(grade) - 1),
            name: displayName,
            credits: item.credit || 0,
            semesterKey: String(item.semester || "").match(/[12]/)?.[0] || "",
            applicationSubject: { ...item },
            category: item.area || "선택과목"
          };
          courses.push(course);
          courseByGradeName.set(`${grade}:${item.subject}`, course);
          const semesters = String(item.semester || "").split("·");
          if (semesters.length > 1) for (const semester of semesters) {
            const subject = `${item.subject} (${semester}학기)`;
            if (!entries.some((entry) => String(Number(entry.grade)+1)===grade && entry.selections?.includes(subject))) continue;
            const semesterCourse = { ...course, column:`app${courses.length}`,
              name: nameCount.get(item.subject)>1 ? `${subject}(${grade}학년)` : subject, semesterKey:semester,
              applicationSubject: { ...item, subject, semester } };
            courses.push(semesterCourse);
            courseByGradeName.set(`${grade}:${subject}`,semesterCourse);
          }
        }
      }
      const students = [];
      const errors = [];
      entries.forEach((entry, index) => {
        const label = entry?.name ? `${entry.name}(${index + 1}번째 파일)` : `${index + 1}번째 파일`;
        const grade = String(entry?.grade ?? "").trim();
        const classroom = String(entry?.classroom ?? "").trim();
        const number = String(entry?.number ?? "").trim();
        const name = String(entry?.name ?? "").trim();
        const selections = Array.isArray(entry?.selections) ? entry.selections : [];
        if (!/^[12]$/.test(grade) || !classroom || !number || !name || !selections.length) {
          errors.push(`${label}: 학년(1·2학년)·반·번호·이름·선택 과목이 모두 필요합니다.`);
          return;
        }
        const targetGrade = String(Number(grade) + 1);
        const picked = [];
        const unknown = [];
        for (const subjectName of selections) {
          const course = courseByGradeName.get(`${targetGrade}:${String(subjectName).trim()}`);
          if (course) picked.push(course);
          else unknown.push(subjectName);
        }
        if (unknown.length) errors.push(`${label}: 편제표에 없는 과목 - ${unknown.join(", ")}`);
        if (!picked.length) {
          errors.push(`${label}: 반영된 과목이 없습니다.`);
          return;
        }
        students.push({
          id: `app-${grade}-${classroom}-${number}-${name}`,
          grade, classroom, number, name,
          selections: picked,
          totalCredits: picked.reduce((total, course) => total + (course.credits || 0), 0)
        });
      });
      students.sort((a, b) =>
        Number(a.grade) - Number(b.grade) || Number(a.classroom) - Number(b.classroom) ||
        Number(a.number) - Number(b.number) || a.name.localeCompare(b.name, "ko"));
      return { students, courses, errors };
    }

    function downloadApplicationForm() {
      const subjects = selectedApplicationSubjects();
      const total = subjects ? subjects["1"].length + subjects["2"].length + subjects["3"].length : 0;
      if (!total) {
        status.style.color = "#a44939";
        status.textContent = "1단계에서 편제표를 먼저 불러오세요. 선택과목을 찾지 못했습니다.";
        return;
      }
      const html = buildApplicationPageHtml(subjects);
      const link = document.createElement("a");
      const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
      link.href = url;
      link.download = "수강신청_양식.html";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.style.color = "#287956";
      status.textContent = `학생용 신청 양식을 저장했습니다. (선택과목 ${total}개)`;
    }

    function parseApplicationRoster(sheets) {
      const students = [];
      const identities = new Set();
      for (const sheet of sheets) {
        const compact = (value) => String(value ?? "").replace(/\s+/g, "");
        const headerIndex = sheet.rows.findIndex((row) =>
          row.some((value) => /^(이름|성명|학생명)$/.test(compact(value))) &&
          row.some((value) => compact(value) === "반") &&
          row.some((value) => /^(번호|출석번호)$/.test(compact(value))));
        if (headerIndex < 0) continue;
        const header = sheet.rows[headerIndex].map(compact);
        const gradeColumn = header.indexOf("학년");
        const classroomColumn = header.indexOf("반");
        const numberColumn = header.findIndex((value) => /^(번호|출석번호)$/.test(value));
        const nameColumn = header.findIndex((value) => /^(이름|성명|학생명)$/.test(value));
        const sheetGrade = String(sheet.name).match(/([123])\s*학년/)?.[1] || "";
        for (let index = headerIndex + 1; index < sheet.rows.length; index++) {
          const row = sheet.rows[index];
          const name = String(row[nameColumn] ?? "").trim();
          if (!name) continue;
          const grade = compact(gradeColumn >= 0 ? row[gradeColumn] : sheetGrade).replace(/학년$/, "");
          const classroom = compact(row[classroomColumn]).replace(/반$/, "");
          const number = compact(row[numberColumn]).replace(/번$/, "");
          const location = `${sheet.name} ${index + 1}행`;
          if (!/^[12]$/.test(grade) || !/^[1-9]\d*$/.test(classroom) || !/^[1-9]\d*$/.test(number)) {
            throw new Error(`${location}: 현재 학년(1·2학년), 반, 번호를 확인하세요. 학년 열이 없으면 시트명을 '1학년' 또는 '2학년'으로 지정하세요.`);
          }
          const identity = `${grade}:${classroom}:${number}`;
          if (identities.has(identity)) throw new Error(`${location}: 학년·반·번호가 중복됩니다 (${identity}).`);
          identities.add(identity);
          students.push({ grade, classroom, number, name });
        }
      }
      if (!students.length) throw new Error("학생 명렬에서 학년·반·번호·이름 머리글과 학생을 찾지 못했습니다.");
      return students;
    }

    function validateApplicationRosterGrade(roster, currentGrade) {
      const grade = String(currentGrade);
      if (!["1", "2"].includes(grade)) throw new Error("수강신청 대상 학년 메뉴를 확인하세요.");
      if (!roster.length) throw new Error("학생 명렬이 비어 있습니다.");
      const mismatched = roster.filter((student) => String(student.grade) !== grade);
      if (mismatched.length) {
        const found = [...new Set(mismatched.map((student) => String(student.grade)))].join("·");
        throw new Error(`${Number(grade) + 1}학년 수강신청에는 현재 ${grade}학년 명렬만 업로드할 수 있습니다. 현재 ${found}학년 학생 ${mismatched.length}명이 포함되어 있습니다. 다른 학년을 제외한 명렬을 다시 업로드하세요.`);
      }
      return roster;
    }

    function downloadTextFile(text, filename, type) {
      const url = URL.createObjectURL(new Blob([text], { type }));
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function downloadRowsXlsx(rows, filename) {
      const sheetData = rows.map((row, index) => `<row r="${index + 1}">${row.map((value, column) =>
        `<c r="${columnName(column)}${index + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value ?? "")}</t></is></c>`
      ).join("")}</row>`).join("");
      const blob = createXlsxBlob({
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="데이터" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData><autoFilter ref="A1:${columnName(Math.max(0, ...rows.map((row) => row.length - 1)))}${rows.length}"/></worksheet>`
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // 보고서용 스타일: 0 기본, 1 제목, 2 머리글, 3 왼쪽 정렬, 4 가운데, 5 0.00, 6 합계 글자, 7 합계 0.00, 8 메모, 9 강조, 10 0.0
    function createReportStylesXml() {
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<numFmts count="2"><numFmt numFmtId="164" formatCode="0.00"/><numFmt numFmtId="165" formatCode="0.0"/></numFmts>` +
        `<fonts count="4"><font><sz val="10"/><name val="맑은 고딕"/><family val="2"/></font><font><b/><sz val="14"/><name val="맑은 고딕"/><family val="2"/></font><font><b/><sz val="10"/><name val="맑은 고딕"/><family val="2"/></font><font><sz val="9"/><color rgb="FF8A3B12"/><name val="맑은 고딕"/><family val="2"/></font></fonts>` +
        `<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE9EEF6"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF4F6F9"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF3B0"/><bgColor indexed="64"/></patternFill></fill></fills>` +
        `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF555555"/></left><right style="thin"><color rgb="FF555555"/></right><top style="thin"><color rgb="FF555555"/></top><bottom style="thin"><color rgb="FF555555"/></bottom><diagonal/></border></borders>` +
        `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="11">` +
        `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
        `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +
        `<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
        `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>` +
        `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
        `<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +
        `<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
        `<xf numFmtId="164" fontId="2" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +
        `<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>` +
        `<xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
        `<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +
        `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
    }

    // sheets: [{ name, rows: [[셀]], widths, merges, freeze }]. 셀은 문자열·숫자·null 또는 { v, f, s }.
    function createWorkbookBlob(sheets) {
      const usedNames = new Set();
      const safeSheetName = (name, index) => {
        let base = String(name || `시트${index + 1}`).replace(/[\[\]:*?\/\\]/g, " ").trim().slice(0, 31) || `시트${index + 1}`;
        let candidate = base;
        for (let suffix = 2; usedNames.has(candidate); suffix++) candidate = `${base.slice(0, 28)}(${suffix})`;
        usedNames.add(candidate);
        return candidate;
      };
      const cellXml = (cell, reference) => {
        if (cell === null || cell === undefined || cell === "") return "";
        const spec = typeof cell === "object" ? cell : { v: cell };
        const style = Number.isInteger(spec.s) ? ` s="${spec.s}"` : "";
        if (spec.f) {
          const cached = spec.v === undefined || spec.v === null ? "" : spec.v;
          return typeof cached === "number"
            ? `<c r="${reference}"${style}><f>${xmlEscape(spec.f)}</f><v>${cached}</v></c>`
            : `<c r="${reference}"${style} t="str"><f>${xmlEscape(spec.f)}</f><v>${xmlEscape(cached)}</v></c>`;
        }
        if (spec.v === null || spec.v === undefined || spec.v === "") return style ? `<c r="${reference}"${style}/>` : "";
        if (typeof spec.v === "number" && Number.isFinite(spec.v)) return `<c r="${reference}"${style}><v>${spec.v}</v></c>`;
        return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(spec.v)}</t></is></c>`;
      };
      const names = sheets.map((sheet, index) => safeSheetName(sheet.name, index));
      const files = {
        "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((name, index) => `<sheet name="${xmlEscape(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
        "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
        "xl/styles.xml": createReportStylesXml()
      };
      sheets.forEach((sheet, index) => {
        const rowsXml = (sheet.rows || []).map((row, rowIndex) => {
          const cells = (row || []).map((cell, column) => cellXml(cell, `${columnName(column)}${rowIndex + 1}`)).join("");
          const height = sheet.heights?.[rowIndex] ? ` ht="${sheet.heights[rowIndex]}" customHeight="1"` : "";
          return `<row r="${rowIndex + 1}"${height}>${cells}</row>`;
        }).join("");
        const cols = (sheet.widths || []).length
          ? `<cols>${sheet.widths.map((width, column) => `<col min="${column + 1}" max="${column + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>`
          : "";
        const freeze = sheet.freeze
          ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${Number(sheet.freeze.match(/\d+/)[0]) - 1}" topLeftCell="${sheet.freeze}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
          : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
        const merges = (sheet.merges || []).length
          ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((reference) => `<mergeCell ref="${reference}"/>`).join("")}</mergeCells>`
          : "";
        files[`xl/worksheets/sheet${index + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>${freeze}${cols}<sheetData>${rowsXml}</sheetData>${merges}<pageMargins left="0.25" right="0.25" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
      });
      return createXlsxBlob(files);
    }

    function downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function normalizeApplicationServerUrl(value) {
      let url;
      try {
        url = new URL(String(value).trim());
      } catch (error) {
        throw new Error("Apps Script 배포 주소를 입력하세요.");
      }
      if (url.protocol !== "https:" || url.hostname !== "script.google.com" ||
          url.port || url.username || url.password ||
          !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname) ||
          url.search || url.hash) {
        throw new Error("관리자 키나 추가 매개변수가 없는 https://script.google.com/macros/s/배포ID/exec 주소만 사용할 수 있습니다.");
      }
      return url.href;
    }

    function buildSchoolApplicationLink(serverUrl, pageUrl) {
      const endpoint = normalizeApplicationServerUrl(serverUrl);
      const page = new URL(pageUrl);
      if (page.protocol !== "https:" && page.protocol !== "http:") {
        throw new Error("학생에게 배포할 링크는 게시된 웹사이트에서 만들어 주세요. 로컬 파일 주소는 배포할 수 없습니다.");
      }
      page.search = "";
      page.hash = new URLSearchParams({ apply: endpoint }).toString();
      return page.href;
    }

    function showStudentApplicationEntry() {
      if (window.location.hash === "#student" || new URLSearchParams(window.location.hash.slice(1)).has("event")) {
        $(".workspace").classList.add("hidden");
        $("#supabaseStudentEntry").classList.remove("hidden");
        document.title = "학생 수강신청";
        return true;
      }
      const params = new URLSearchParams(window.location.hash.slice(1));
      if (!params.has("apply")) return false;
      $(".workspace").classList.add("hidden");
      $("#studentEntry").classList.remove("hidden");
      document.title = "학생 수강신청";
      try {
        const endpoint = normalizeApplicationServerUrl(params.get("apply"));
        const frame = $("#studentApplicationFrame");
        frame.src = endpoint;
        frame.classList.remove("hidden");
        $("#studentApplicationFallback").href = endpoint;
        $("#studentApplicationFallback").classList.remove("hidden");
      } catch (error) {
        $("#studentEntryError").textContent = error instanceof Error ? error.message : "학교 신청 링크가 잘못되었습니다.";
        $("#studentFrameHelp").classList.add("hidden");
      }
      return true;
    }

    async function handleApplicationRoster(file) {
      if (!file) return;
      const currentGrade = String(state.applicationMenuGrade || "1");
      try {
        if (!file.name.toLowerCase().endsWith(".xlsx")) throw new Error("학생 명렬은 .xlsx 형식으로 선택하세요.");
        const subjects = selectedApplicationSubjects();
        if (!subjects || !subjects["2"].length && !subjects["3"].length) {
          throw new Error("1단계 편제표의 학생선택교육과정에 2·3학년 과목이 편제되어 있는지 확인하세요.");
        }
        const round = state.currentRound;
        const schoolName = String($("#schoolName").value || "").trim();
        const schoolYear = String($("#schoolYear").value || "").trim();
        const roster = parseApplicationRoster(await parseWorkbook(await file.arrayBuffer()));
        if (String(state.applicationMenuGrade || "1") !== currentGrade) {
          throw new Error("파일을 읽는 중 학년 메뉴가 바뀌었습니다. 해당 학년에서 다시 업로드하세요.");
        }
        validateApplicationRosterGrade(roster, currentGrade);
        for (const student of roster) {
          if (!subjects[String(Number(student.grade) + 1)].length) {
            throw new Error(`현재 ${student.grade}학년이 신청할 ${Number(student.grade) + 1}학년 학생선택교육과정 과목이 없습니다. 편제표의 교육과정 구분과 학기 시수를 확인하세요.`);
          }
        }
        const setup = { type: "course-application-setup", round, schoolName, schoolYear, subjects, roster };
        downloadTextFile(JSON.stringify(setup, null, 2), "온라인_수강신청_설정.json", "application/json");
        status.style.color = "#287956";
        status.textContent = `${round}차 온라인 신청 설정(${roster.length}명)을 저장했습니다. Apps Script 관리자 페이지에 업로드하세요. 기존 신청 결과는 변경하지 않았습니다.`;
      } catch (error) {
        status.style.color = "#a44939";
        status.textContent = error instanceof Error ? error.message : "학생 명렬을 처리하지 못했습니다.";
      }
    }

    function applyCloudApplicationResults(round, entries, subjects, groups = []) {
      round = String(round);
      if (!/^[1-9]\d{0,8}$/.test(round)) throw new Error("연동할 신청 차수를 확인하세요.");
      if (typeof isRoundLocked === "function" && isRoundLocked(round)) {
        throw new Error(`${round}차는 확정된 차수라 웹 신청 결과를 반영하지 않았습니다. 확정을 해제한 뒤 다시 연동하세요.`);
      }
      const merged = mergeApplications(entries, subjects);
      if (merged.errors.length) throw new Error(`집계표 연동 실패: ${merged.errors[0]}`);
      for (const course of merged.courses) {
        const grade = course.applicationCurrentGrade;
        const group = applicationGroupForCourse(course, grade, groups);
        course.applicationGroups = group ? { [grade]: group } : {};
        course.applicationGroupSource = "online";
      }
      state.rounds ||= {"1":null};
      state.rounds[round] ||= null;
      state.roundClosures ||= {};
      state.roundClosures[round] ||= {};
      syncActiveRound();
      const previous = state.rounds[round];
      const data = {
        students: merged.students, courses: merged.courses,
        classOverrides: previous?.classOverrides || {},
        semesterAssignments: previous?.semesterAssignments || {},
        groupAssignments: previous?.groupAssignments || {},
        customGroupNames: previous?.customGroupNames || [],
        fileName: `온라인 자동 연동 ${merged.students.length}명`
      };
      state.rounds[round] = data;
      if (String(round) === state.currentRound) {
        state.students = data.students;
        state.courses = data.courses;
        state.classOverrides = data.classOverrides;
        state.semesterAssignments = {...data.semesterAssignments};
        state.groupAssignments = {...data.groupAssignments};
        state.customGroupNames = [...data.customGroupNames];
        state.fileName = data.fileName;
        if (!state.students.some((student) => student.id === state.selectedId)) state.selectedId = state.students[0]?.id || null;
        $("#fileName").textContent = state.fileName;
        $("#searchInput").disabled = !state.students.length;
        $("#classFilter").disabled = !state.students.length;
        applyClassFilterOptions(state.students);
        renderRoster();
        renderPreview();
        renderSemesterClassifier();
        renderAggregate();
      }
      renderRoundStatus();
      persistState();
    }

    function applyMergedApplications(entries, sourceLabel) {
      if (typeof isRoundLocked === "function" && isRoundLocked(state.currentRound)) {
        status.style.color = "#a44939";
        status.textContent = `${state.currentRound}차는 확정된 차수입니다. 확정을 해제한 뒤 다시 불러오세요.`;
        return;
      }
      const merged = mergeApplications(entries);
      if (!merged.students.length) {
        status.style.color = "#a44939";
        status.textContent = `명단을 만들지 못했습니다. ${merged.errors[0] || ""}`;
        return;
      }
      const unclassified = classifyApplicationRecords(merged);
      state.students = merged.students;
      state.courses = merged.courses;
      state.classOverrides = {};
      state.semesterAssignments = {};
      state.groupAssignments = {};
      state.customGroupNames = [];
      state.selectedCourseColumns = [];
      state.lastSelectedCourseColumn = null;
      state.fileName = `${sourceLabel} ${merged.students.length}명`;
      state.selectedId = merged.students[0].id;
      $("#round").value = `${state.currentRound}차`;
      applyClassFilterOptions(merged.students);
      $("#searchInput").disabled = false;
      $("#classFilter").disabled = false;
      renderRoster();
      renderPreview();
      renderSemesterClassifier();
      renderAggregate();
      renderRoundStatus();
      persistState();
      status.style.color = merged.errors.length ? "#a44939" : "#287956";
      status.textContent = `${state.currentRound}차: ${sourceLabel} ${entries.length}건을 취합해 ${merged.students.length}명 명단을 만들었습니다.` +
        (merged.errors.length ? ` 제외 ${merged.errors.length}건(예: ${merged.errors[0]})` : "") +
        (unclassified.length ? ` 그룹 미확인 ${unclassified.length}개: ${unclassified.join(", ")}. 선택 그룹 또는 파일의 학기 표기를 확인하세요.` : "");
    }

    // 개설/폐강 결정은 차수마다 새로 내려야 하므로 이어받지 않는다.
    function priorRoundSettings(grade) {
      const current = Number(state.currentRound);
      for (const round of applicationRoundNumbers().filter((item) => Number(item) < current).reverse()) {
        const data = state.rounds?.[round];
        const courses = (data?.courses || []).filter((course) => course.applicationCurrentGrade === grade);
        if (courses.length) {
          return {
            round, courses,
            classOverrides: data.classOverrides || {},
            semesterAssignments: data.semesterAssignments || {},
            groupAssignments: data.groupAssignments || {}
          };
        }
      }
      return null;
    }

    // 같은 과목(과목명·학기)의 개설 학급 수·개설 결정·학기·그룹 지정은 새 열로 옮겨 유지한다.
    function storeGradeResults(data, sourceLabel, grade) {
      grade = String(grade);
      if (typeof isRoundLocked === "function" && isRoundLocked(state.currentRound)) {
        throw new Error(`${state.currentRound}차는 확정된 차수입니다. 확정을 해제한 뒤 다시 업로드하세요.`);
      }
      const students = data.students.filter((student) => String(student.grade) === grade);
      if (!students.length) throw new Error(`현재 ${grade}학년 학생이 없는 결과 파일입니다. 해당 학년 메뉴에서 업로드하세요.`);
      const courses = normalizeCourses(data.courses.filter((course) =>
        !course.applicationCurrentGrade || course.applicationCurrentGrade === grade));
      const otherStudents = state.students.filter((student) => String(student.grade) !== grade);
      const otherColumns = new Set(otherStudents.flatMap((student) => student.selections.map((course) => String(course.column))));
      const otherCourses = state.courses.filter((course) =>
        course.applicationCurrentGrade ? course.applicationCurrentGrade !== grade : otherColumns.has(String(course.column)));
      for (const course of otherCourses) otherColumns.add(String(course.column));
      const previousCourses = state.courses.filter((course) => !otherCourses.includes(course));
      const previousColumns = new Set(previousCourses.map((course) => String(course.column)));
      const occupied = new Set(otherColumns);
      const remapped = new Map();
      courses.forEach((course, index) => {
        let column = `result-${grade}-${index}`;
        while (occupied.has(column)) column += "-";
        occupied.add(column);
        remapped.set(course.column, {...course, column, applicationCurrentGrade:grade});
      });
      const nextCourses = [...remapped.values()];
      const courseName = (course) => String(course.name || "").replace(/\s+/g, "");
      const mapColumns = (fromCourses) => {
        const candidates = new Map();
        for (const previous of fromCourses) {
          const sameName = nextCourses.filter((course) => courseName(course) === courseName(previous));
          const sameSemester = sameName.filter((course) => String(course.semesterKey || "") === String(previous.semesterKey || ""));
          const match = sameSemester.length === 1 ? sameSemester[0] : sameName.length === 1 ? sameName[0] : null;
          if (match) candidates.set(String(previous.column), String(match.column));
        }
        const targetCounts = new Map();
        for (const target of candidates.values()) targetCounts.set(target, (targetCounts.get(target) || 0) + 1);
        return new Map([...candidates].filter(([, target]) => targetCounts.get(target) === 1));
      };
      const columnMap = mapColumns(previousCourses);
      const inherited = previousCourses.length ? null : priorRoundSettings(grade);
      const inheritedMap = inherited ? mapColumns(inherited.courses) : new Map();
      const carry = { kept: 0, dropped: 0, inheritedFrom: null, inherited: 0 };
      const remapGradeKeys = (source) => {
        const result = {};
        for (const [key, value] of Object.entries(source || {})) {
          const separator = key.indexOf(":");
          if (separator < 0 || key.slice(0, separator) !== grade) {
            result[key] = value;
            continue;
          }
          const column = key.slice(separator + 1);
          if (columnMap.has(column)) {
            result[`${grade}:${columnMap.get(column)}`] = value;
            carry.kept++;
          } else if (previousColumns.has(column)) carry.dropped++;
        }
        return result;
      };
      const remapColumnKeys = (source) => {
        const result = {};
        for (const [key, value] of Object.entries(source || {})) {
          if (otherColumns.has(key)) result[key] = value;
          else if (columnMap.has(key)) {
            result[columnMap.get(key)] = value;
            carry.kept++;
          } else if (previousColumns.has(key)) carry.dropped++;
        }
        return result;
      };
      const nextStudents = students.map((student) => ({
        ...student, selections: student.selections.map((course) => ({...course, column: remapped.get(course.column).column}))
      }));
      state.students = [...otherStudents, ...nextStudents].sort((a,b) =>
        Number(a.grade)-Number(b.grade) || Number(a.classroom)-Number(b.classroom) || Number(a.number)-Number(b.number));
      state.courses = [...otherCourses, ...nextCourses];
      state.classOverrides = remapGradeKeys(state.classOverrides);
      state.semesterAssignments = remapColumnKeys(state.semesterAssignments);
      state.groupAssignments = remapColumnKeys(state.groupAssignments);
      if (inherited) {
        const inheritInto = (target, source, build) => {
          for (const [key, value] of Object.entries(source)) {
            const mapped = build(key);
            if (mapped && !Object.hasOwn(target, mapped)) { target[mapped] = value; carry.inherited++; }
          }
        };
        inheritInto(state.classOverrides, inherited.classOverrides, (key) => {
          const separator = key.indexOf(":");
          return separator > 0 && key.slice(0, separator) === grade && inheritedMap.has(key.slice(separator + 1))
            ? `${grade}:${inheritedMap.get(key.slice(separator + 1))}` : null;
        });
        inheritInto(state.semesterAssignments, inherited.semesterAssignments, (key) => inheritedMap.get(key) || null);
        inheritInto(state.groupAssignments, inherited.groupAssignments, (key) => inheritedMap.get(key) || null);
        if (carry.inherited) carry.inheritedFrom = inherited.round;
      }
      state.roundClosures ||= {};
      state.roundClosures[state.currentRound] = remapGradeKeys(state.roundClosures[state.currentRound]);
      state.customGroupNames ||= [];
      state.rounds ||= {"1":null};
      const gradeFiles = {...state.rounds[state.currentRound]?.gradeFiles, [grade]:sourceLabel};
      state.rounds[state.currentRound] = {...state.rounds[state.currentRound], gradeFiles};
      state.fileName = Object.entries(gradeFiles).map(([g,name]) => `${g}학년: ${name}`).join(" / ");
      state.selectedId = nextStudents[0].id;
      state.selectedCourseColumns = [];
      state.lastSelectedCourseColumn = null;
      $("#fileName").textContent = state.fileName;
      $("#round").value = `${state.currentRound}차`;
      applyClassFilterOptions(state.students);
      $("#searchInput").disabled = false;
      $("#classFilter").disabled = false;
      $("#studentCount").textContent = `${state.students.length} / ${state.students.length}명`;
      renderRoster();
      renderPreview();
      renderSemesterClassifier();
      renderAggregate();
      persistState();
      renderRoundStatus();
      return carry;
    }

    async function handleApplicationFiles(fileList) {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      const entries = [];
      const failures = [];
      for (const file of files) {
        try {
          const parsed = JSON.parse(await file.text());
          if (parsed?.type === "course-application-results") {
            if (String(parsed.round) !== state.currentRound) {
              throw new Error(`${file.name}: ${parsed.round}차 결과입니다. 해당 차수로 전환한 뒤 다시 불러오세요.`);
            }
            if (!Array.isArray(parsed.entries)) throw new Error(`${file.name}: 신청 결과 형식이 잘못되었습니다.`);
            entries.push(...parsed.entries);
          }
          else if (parsed && (parsed.type === "course-application" || Array.isArray(parsed.selections))) entries.push(parsed);
          else failures.push(file.name);
        } catch (error) {
          failures.push(`${file.name}: ${error instanceof Error ? error.message : "파일 읽기 실패"}`);
        }
      }
      if (!entries.length) {
        status.style.color = "#a44939";
        status.textContent = failures.length
          ? `읽을 수 있는 신청 파일이 없습니다. ${failures[0]}`
          : "신청 결과가 비어 있습니다. 학생 신청이 저장된 결과 JSON을 선택하세요.";
        return;
      }
      applyMergedApplications(entries, "온라인 신청 취합");
      if (failures.length) {
        status.style.color = "#a44939";
        status.textContent += ` 읽지 못한 파일 ${failures.length}개 (${failures[0]}).`;
      }
    }

    function buildAppsScriptCode(subjects) {
      const schoolName = String($("#schoolName").value || "").trim();
      const schoolYear = String($("#schoolYear").value || "").trim();
      const escapeCode = (value) => String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const dataJson = JSON.stringify(subjects).replace(/</g, "\\u003c");
      const lines = [
        "// 이 코드는 '교육과정 관리'에서 생성했습니다.",
        "// 사용법: script.google.com → 새 프로젝트 → 이 코드 전체 붙여넣기 → 저장 → 실행(▶) → 권한 승인",
        "// 실행 로그에 설문 주소와 응답 스프레드시트 주소가 표시됩니다.",
        "// 학교마다 관리자가 각자의 구글 계정으로 실행하면 그 학교만의 폼·응답 시트가 만들어지고,",
        "// 학생에게는 실행 로그의 설문 주소만 공유하면 됩니다. 응답 시트는 실행한 관리자만 볼 수 있습니다.",
        "",
        "var CONFIG = {",
        "  requireSchoolLogin: false, // true: 학교 구글 계정(Workspace)으로 로그인한 학생만 응답 가능",
        "  collectEmail: false,       // true: 응답자 이메일을 함께 수집(로그인 제한과 함께 사용 권장)",
        "  adminEmails: []            // 응답 시트를 함께 관리할 다른 관리자 이메일. 예: ['teacher@school.kr']",
        "};",
        "",
        "function createCourseApplicationForm() {",
        `  var SUBJECTS = ${dataJson};`,
        `  var form = FormApp.create('${escapeCode(schoolYear)}학년도 수강신청 (${escapeCode(schoolName)})');`,
        "  form.setDescription('현재 학년 기준으로 다음 학년에 들을 과목을 선택하세요. 제출은 1회만 가능하니 신중하게 선택하세요.');",
        "  form.setLimitOneResponsePerUser(false);",
        "  if (CONFIG.requireSchoolLogin) form.setRequireLogin(true);",
        "  if (CONFIG.collectEmail) form.setCollectEmail(true);",
        "  var gradeItem = form.addMultipleChoiceItem().setTitle('현재 학년').setRequired(true);",
        "  form.addTextItem().setTitle('반').setRequired(true);",
        "  form.addTextItem().setTitle('번호').setRequired(true);",
        "  form.addTextItem().setTitle('이름').setRequired(true);",
        "  var pages = {};",
        "  var previousPage = null;",
        "  ['2', '3'].forEach(function (grade) {",
        "    var courses = SUBJECTS[grade] || [];",
        "    if (!courses.length) return;",
        "    var page = form.addPageBreakItem().setTitle(grade + '학년 선택과목');",
        "    if (previousPage) page.setGoToPage(FormApp.PageNavigationType.SUBMIT);",
        "    previousPage = page;",
        "    var bySemester = {};",
        "    courses.forEach(function (course) {",
        "      var key = course.semester || '0';",
        "      if (!bySemester[key]) bySemester[key] = [];",
        "      bySemester[key].push(course);",
        "    });",
        "    Object.keys(bySemester).sort().forEach(function (semester) {",
        "      var names = bySemester[semester].map(function (course) { var classification = String(course.type || '').replace(/선택$/, ''); return course.subject + (classification ? '(' + classification + ')' : ''); });",
        "      var title = grade + '학년 ' + (semester === '0' ? '학기 미정' : semester + '학기') + ' 선택과목';",
        "      form.addCheckboxItem().setTitle(title).setChoiceValues(names)",
        "        .setHelpText('이 학기에 들을 과목을 모두 선택하세요. (중복 선택 가능)');",
        "    });",
        "    pages[grade] = page;",
        "  });",
        "  var choices = [];",
        "  if (pages['2']) choices.push(gradeItem.createChoice('1학년', pages['2']));",
        "  if (pages['3']) choices.push(gradeItem.createChoice('2학년', pages['3']));",
        "  if (!choices.length) throw new Error('신청할 수 있는 2·3학년 과목이 없습니다.');",
        "  gradeItem.setChoices(choices);",
        `  var sheet = SpreadsheetApp.create('수강신청 응답 (${escapeCode(schoolName)})');`,
        "  if (CONFIG.adminEmails.length) sheet.addEditors(CONFIG.adminEmails);",
        "  form.setDestination(FormApp.DestinationType.SPREADSHEET, sheet.getId());",
        "  Logger.log('설문 주소: ' + form.getPublishedUrl());",
        "  Logger.log('응답 스프레드시트: ' + sheet.getUrl());",
        "}",
        ""
      ];
      return lines.join("\n");
    }

    // 구글폼 체크박스 응답("과목1, 과목2")을 알려진 과목명 목록으로 분할한다. 과목명에 쉼표가 있어도 동작한다.
    function splitGoogleFormSelections(text, knownNames, strict = false) {
      const found = [];
      let rest = String(text ?? "");
      const names = [...knownNames].sort((a, b) => b.length - a.length);
      while (rest.trim()) {
        const trimmed = rest.replace(/^[,\s]+/, "");
        if (!trimmed) break;
        const hit = names.find((name) => trimmed.startsWith(name));
        if (hit) {
          found.push(hit);
          rest = trimmed.slice(hit.length);
        } else {
          if (strict) throw new Error(`편제표에 없는 선택과목입니다: ${trimmed}`);
          const comma = trimmed.indexOf(",");
          if (comma < 0) break;
          rest = trimmed.slice(comma + 1);
        }
      }
      return found;
    }

    function parseGoogleFormsRows(rows, subjects) {
      const headerIndex = rows.findIndex((row) =>
        (row || []).some((value) => /이름|성명/.test(String(value ?? ""))) &&
        (row || []).some((value) => /학년/.test(String(value ?? ""))));
      if (headerIndex < 0) throw new Error("구글폼 응답 시트에서 머리글 행(학년/이름)을 찾지 못했습니다.");
      const header = rows[headerIndex].map((value) => String(value ?? "").trim());
      const findColumn = (pattern) => header.findIndex((label) => pattern.test(label));
      const gradeColumn = findColumn(/학년/);
      const classroomColumn = findColumn(/^반$|^\s*반\s*/);
      const numberColumn = findColumn(/번호/);
      const nameColumn = findColumn(/이름|성명/);
      if (gradeColumn < 0 || nameColumn < 0) throw new Error("구글폼 응답 시트에 학년/이름 열이 없습니다.");
      // '2학년 1학기 선택과목' 같은 체크박스 질문 열을 학년별로 모은다.
      const questionColumns = header
        .map((label, column) => ({ label, column, grade: label.match(/^([23])\s*학년/)?.[1] || "" }))
        .filter((item) => item.grade && item.column > nameColumn);
      const entries = [];
      for (const row of rows.slice(headerIndex + 1)) {
        const grade = String(row?.[gradeColumn] ?? "").match(/[12]/)?.[0] || "";
        const name = String(row?.[nameColumn] ?? "").trim();
        if (!grade || !name) continue;
        const targetGrade = String(Number(grade) + 1);
        const subjectByLabel = new Map();
        for (const course of subjects?.[targetGrade] || []) {
          subjectByLabel.set(course.subject, course.subject);
          subjectByLabel.set(applicationCourseLabel(course), course.subject);
        }
        const knownNames = new Set(subjectByLabel.keys());
        const selections = [];
        for (const item of questionColumns) {
          if (item.grade !== targetGrade) continue;
          selections.push(...splitGoogleFormSelections(row[item.column], knownNames).map((label) => subjectByLabel.get(label)));
        }
        entries.push({
          type: "course-application",
          grade,
          classroom: String(row?.[classroomColumn] ?? "").trim(),
          number: String(row?.[numberColumn] ?? "").trim(),
          name,
          selections
        });
      }
      return entries;
    }

    async function handleGoogleFormsFile(file) {
      if (!file) return;
      status.textContent = "";
      try {
        const sheets = await parseWorkbook(await file.arrayBuffer());
        const subjects = collectApplicationSubjects({ includeExcluded: true });
        const entries = parseGoogleFormsRows(sheets[0].rows, subjects);
        if (!entries.length) {
          status.style.color = "#a44939";
          status.textContent = "응답 시트에서 학생 응답을 찾지 못했습니다.";
          return;
        }
        applyMergedApplications(entries, "구글폼 응답 취합");
      } catch (error) {
        status.style.color = "#a44939";
        status.textContent = error instanceof Error ? error.message : "구글폼 응답 파일을 처리하지 못했습니다.";
      }
    }

    function xmlEscape(value) {
      return String(value ?? "").replace(/[<>&'"]/g, (character) => ({
        "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;"
      })[character]);
    }

    function columnName(index) {
      let name = "";
      for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
        name = String.fromCharCode(65 + (value - 1) % 26) + name;
      }
      return name;
    }

    function createWorksheetXml(report, openingPercent, divisionPercent) {
      const { summary, semesters } = report;
      //보내기 서식: 과목 6개씩 한 묶음(열)으로 배치하고, 총 학급수는 학기 전체를 하나로 병합한다.
      const BLOCK_SIZE = 6;
      const columnCount = 9; // 라벨 1 + 과목 6 + 총 학급수 1 + 총학생수 메모 1
      const lastColumn = columnCount - 1;
      const rows = [];
      const merges = [];
      const addRow = (height = 22) => {
        rows.push({ cells: Array(columnCount).fill(null), height });
        return rows.length;
      };
      const setCell = (rowNumber, column, value, style, numeric = false) => {
        rows[rowNumber - 1].cells[column] = { value, style, numeric };
      };
      const merge = (firstColumn, firstRow, lastMergeColumn, lastRow) => {
        if (firstColumn !== lastMergeColumn || firstRow !== lastRow) {
          merges.push(`${columnName(firstColumn)}${firstRow}:${columnName(lastMergeColumn)}${lastRow}`);
        }
      };
      const confirmDigits = String($("#confirmDate").value || "").match(/\d+/g) || [];
      const shortDate = confirmDigits.length >= 2
        ? `${confirmDigits[0]}.${Number(confirmDigits[1])}.`
        : String($("#confirmDate").value || "");

      for (const [semesterIndex, semester] of semesters.entries()) {
        let row;
        if (semesterIndex === 0) {
          row = addRow(34);
          const futureGrade = Number(summary.grade) + 1;
          setCell(row, 0, `${futureGrade}학년(현${summary.grade}학년) 수강신청결과(${$("#round").value || "1차"})`, 1);
          merge(0, row, lastColumn - 1, row);
          setCell(row, lastColumn, shortDate, 10);

          addRow(8);
          row = addRow(30);
          setCell(row, 0, "총학생수", 2); setCell(row, 1, summary.students, 3, true);
          setCell(row, 2, "학급당 학생수", 2); setCell(row, 3, summary.averageClassSize, 8, true);
          setCell(row, 4, `학급당 학생수의 ${openingPercent}%(개설기준)`, 2);
          setCell(row, 5, summary.openingLimit, 4, true);
          const noteRow = row;
          setCell(noteRow, 7, "학급당 학생수는 개설기준과 분반기준의 사이가 되도록 조정", 10);

          row = addRow(30);
          setCell(row, 4, `학급당 학생수의 ${divisionPercent}%(분반기준)`, 2);
          setCell(row, 5, summary.divisionLimit, 8, true);
          merge(7, noteRow, 8, row);

          addRow(12);
        }

        row = addRow(26);
        setCell(row, 0, semester.name, 5);
        merge(0, row, 1, row);

          const courses = semester.groups.flatMap((group) => group.courses);
          const semesterTotal = courses.reduce((total, course) => total + course.classCount, 0);
          const blocks = [];
          for (let index = 0; index < courses.length; index += BLOCK_SIZE) {
            blocks.push(courses.slice(index, index + BLOCK_SIZE));
          }
          const semesterFirstRow = rows.length + 1;
          const semesterLastRow = semesterFirstRow + blocks.length * 5 - 1;
          blocks.forEach((block, blockIndex) => {
            const headerRow = addRow(21);
            const metricRows = [addRow(23), addRow(23), addRow(23), addRow(23)];
            setCell(headerRow, 0, "과목", 6);
            block.forEach((course, index) => setCell(headerRow, index + 1, course.displayName || course.name, 6));
            for (let col = block.length + 1; col <= BLOCK_SIZE; col++) setCell(headerRow, col, "", 6);
            if (blockIndex === 0) {
              setCell(headerRow, 7, "총 학급수", 9);
              setCell(metricRows[0], 7, semesterTotal, 9, true);
              merge(7, metricRows[0], 7, semesterLastRow);
              if (semesterIndex === 0) {
                setCell(metricRows[0], 8, summary.students.toFixed(1), 10);
                merge(8, metricRows[0], 8, metricRows[1]);
              }
            }
            const metrics = [
              ["인원 수", (course) => course.enrollment, 3],
              ["인원수/분반기준", (course) => course.enrollmentPerDivision, 8],
              ["개설 학급수", (course) => course.classCount, 3],
              ["학급당 학생수", (course) => course.averageClassSize, 8]
            ];
            for (const [metricIndex, [label, getValue, valueStyle]] of metrics.entries()) {
              const metricRow = metricRows[metricIndex];
              setCell(metricRow, 0, label, 7);
              block.forEach((course, index) =>
                setCell(metricRow, index + 1, getValue(course), valueStyle, true));
              for (let col = block.length + 1; col <= BLOCK_SIZE; col++) setCell(metricRow, col, "", 7);
            }
          });
          addRow(12);
        }

      const rowsXml = rows.map((row, rowIndex) => {
        const cells = row.cells.map((cell, columnIndexValue) => {
          if (!cell) return "";
          const reference = `${columnName(columnIndexValue)}${rowIndex + 1}`;
          if (cell.numeric) {
            const value = Number(cell.value);
            const rounded = Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
            return `<c r="${reference}" s="${cell.style}"><v>${rounded}</v></c>`;
          }
          return `<c r="${reference}" s="${cell.style}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell.value)}</t></is></c>`;
        }).join("");
        return `<row r="${rowIndex + 1}" ht="${row.height}" customHeight="1">${cells}</row>`;
      }).join("");
      const columns = Array.from({ length: columnCount }, (_, index) => {
        const width = index === 0 ? 15 : index === lastColumn ? 11 : index === 7 ? 11 : 13;
        return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
      }).join("");
      const mergeXml = merges.length
        ? `<mergeCells count="${merges.length}">${merges.map((reference) => `<mergeCell ref="${reference}"/>`).join("")}</mergeCells>`
        : "";
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0"/></sheetViews><cols>${columns}</cols><sheetData>${rowsXml}</sheetData>${mergeXml}<pageMargins left="0.25" right="0.25" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
    }

    function createStylesXml() {
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <numFmts count="1"><numFmt numFmtId="164" formatCode="0.00"/></numFmts>
          <fonts count="3">
            <font><sz val="10"/><name val="맑은 고딕"/><family val="2"/></font>
            <font><b/><sz val="18"/><name val="맑은 고딕"/><family val="2"/></font>
            <font><b/><sz val="10"/><name val="맑은 고딕"/><family val="2"/></font>
          </fonts>
          <fills count="3">
            <fill><patternFill patternType="none"/></fill>
            <fill><patternFill patternType="gray125"/></fill>
            <fill><patternFill patternType="solid"><fgColor rgb="FFFFFF55"/><bgColor indexed="64"/></patternFill></fill>
          </fills>
          <borders count="2">
            <border><left/><right/><top/><bottom/><diagonal/></border>
            <border><left style="thin"><color rgb="FF222222"/></left><right style="thin"><color rgb="FF222222"/></right><top style="thin"><color rgb="FF222222"/></top><bottom style="thin"><color rgb="FF222222"/></bottom><diagonal/></border>
          </borders>
          <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
          <cellXfs count="11">
            <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
            <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
            <xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
            <xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
            <xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
            <xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
            <xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
            <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
            <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
            <xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
            <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
          </cellXfs>
          <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
        </styleSheet>`;
    }

    function crc32(bytes) {
      let crc = 0xffffffff;
      for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
      return (crc ^ 0xffffffff) >>> 0;
    }

    function createXlsxBlob(files) {
      const encoder = new TextEncoder();
      const fileEntries = Object.entries(files).map(([name, content]) => ({
        name: encoder.encode(name), data: content instanceof Uint8Array ? content : encoder.encode(content)
      }));
      const localParts = [];
      const centralParts = [];
      let localOffset = 0;
      const write16 = (view, offset, value) => view.setUint16(offset, value, true);
      const write32 = (view, offset, value) => view.setUint32(offset, value, true);
      for (const file of fileEntries) {
        const checksum = crc32(file.data);
        const local = new Uint8Array(30 + file.name.length);
        const localView = new DataView(local.buffer);
        write32(localView, 0, 0x04034b50); write16(localView, 4, 20);
        write16(localView, 6, 0x0800); write16(localView, 8, 0);
        write32(localView, 14, checksum); write32(localView, 18, file.data.length);
        write32(localView, 22, file.data.length); write16(localView, 26, file.name.length);
        local.set(file.name, 30);
        localParts.push(local, file.data);

        const central = new Uint8Array(46 + file.name.length);
        const centralView = new DataView(central.buffer);
        write32(centralView, 0, 0x02014b50); write16(centralView, 4, 20);
        write16(centralView, 6, 20); write16(centralView, 8, 0x0800);
        write16(centralView, 10, 0); write32(centralView, 16, checksum);
        write32(centralView, 20, file.data.length); write32(centralView, 24, file.data.length);
        write16(centralView, 28, file.name.length); write32(centralView, 42, localOffset);
        central.set(file.name, 46);
        centralParts.push(central);
        localOffset += local.length + file.data.length;
      }
      const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
      const end = new Uint8Array(22);
      const endView = new DataView(end.buffer);
      write32(endView, 0, 0x06054b50);
      write16(endView, 8, fileEntries.length); write16(endView, 10, fileEntries.length);
      write32(endView, 12, centralSize); write32(endView, 16, localOffset);
      return new Blob([...localParts, ...centralParts, end], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      });
    }

    function buildAggregateXlsxFiles() {
      const { openingPercent, divisionPercent } = aggregateThresholds();
      const aggregate = aggregateRecords(
        state.students, state.courses, openingPercent, divisionPercent,
        state.classOverrides, state.semesterAssignments, state.groupAssignments,
        typeof nextYearClassBases === "function" ? nextYearClassBases() : {}
      );
      const sheets = aggregate.reports.map((report) => ({
        name: `${Number(report.summary.grade) + 1}학년(현${report.summary.grade}학년)`,
        xml: createWorksheetXml(report, openingPercent, divisionPercent)
      }));
      const sheetOverrides = sheets.map((sheet, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
      const sheetEntries = sheets.map((sheet, index) =>
        `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
      const sheetRels = sheets.map((sheet, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
      const files = {
        "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetOverrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries}</sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
        "xl/styles.xml": createStylesXml()
      };
      sheets.forEach((sheet, index) => {
        files[`xl/worksheets/sheet${index + 1}.xml`] = sheet.xml;
      });
      return files;
    }

    function downloadAggregate() {
      try {
        aggregateThresholds();
      } catch (error) {
        showAppToast(error.message, "error");
        return;
      }
      const workbook = createXlsxBlob(buildAggregateXlsxFiles());
      const link = document.createElement("a");
      const url = URL.createObjectURL(workbook);
      link.href = url;
      link.download = "과목별_수강신청_집계표.xlsx";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function updateCertificateText() {
      renderPreview();
      renderSemesterClassifier();
      renderAggregate();
      persistState();
    }

    function resultImportOptions(grade) {
      return {
        subjects: collectApplicationSubjects({ includeExcluded: true, currentGrade: grade }),
        existingStudents: state.students
      };
    }

    function handleWorkbook(file) {
      if (!file) return;
      status.textContent = "";
      if (!file.name.toLowerCase().endsWith(".xlsx")) {
        status.style.color = "#a44939";
        status.textContent = "현재는 .xlsx 형식만 지원합니다.";
        return;
      }
      if (typeof isRoundLocked === "function" && isRoundLocked(state.currentRound)) {
        status.style.color = "#a44939";
        status.textContent = `${state.currentRound}차는 확정된 차수입니다. 4단계에서 확정을 해제한 뒤 결과를 교체하세요.`;
        return;
      }
      const uploadRound = state.currentRound;
      const uploadGrade = state.applicationMenuGrade || "1";
      const importRevision = state.applicationImportRevision;
      const reader = new FileReader();
      reader.onerror = () => { status.textContent = "파일을 읽지 못했습니다. 다시 선택해 주세요."; };
      reader.onload = async () => {
        try {
          const sheets = await parseWorkbook(reader.result);
          if (state.currentRound !== uploadRound) throw new Error("파일을 읽는 중 차수가 바뀌었습니다. 해당 차수에서 다시 업로드하세요.");
          if ((state.applicationMenuGrade || "1") !== uploadGrade) throw new Error("파일을 읽는 중 학년 메뉴가 바뀌었습니다. 해당 학년에서 다시 업로드하세요.");
          if (state.applicationImportRevision !== importRevision) throw new Error("파일을 읽는 중 데이터가 삭제되었습니다. 다시 업로드하세요.");
          const preview = buildResultImportPreview(sheets, {
            ...resultImportOptions(uploadGrade),
            fileName: file.name, round: uploadRound, grade: uploadGrade, revision: importRevision
          });
          showResultImportPreview(preview);
          const candidate = preview.candidates[preview.selected];
          status.style.color = candidate.issues.blocking.length ? "#a44939" : "#596780";
          status.textContent = candidate.issues.blocking.length
            ? `결과 파일을 반영할 수 없습니다: ${candidate.issues.blocking[0]}`
            : "결과 파일을 확인했습니다. 아래 검증 결과와 변화를 확인한 뒤 '결과 반영'을 누르세요.";
        } catch (error) {
          const message = error instanceof Error ? error.message : "파일을 처리하는 중 오류가 발생했습니다.";
          status.style.color = "#a44939";
          status.textContent = message;
        }
      };
      reader.readAsArrayBuffer(file);
    }

    function importedPlanColumnMap(layout) {
      const rows = expandCurriculumLayoutRows(layout);
      const width = Math.max(0, ...rows.map((row) => row.length));
      const compact = (value) => String(value ?? "").replace(/\s+/g, "").replace(/[()（）]/g, "");
      const isHeaderRow = (row) => (row || []).some((value) => /세부과목|과목명/.test(compact(value))) &&
        (row || []).some((value) => /기준학점|운영학점|기준시수|운영시수/.test(compact(value)));
      let headerIndex = rows.findIndex((row) => isHeaderRow(row));
      if (headerIndex < 0) headerIndex = rows.findIndex((row) => (row || []).some((value) => /세부과목|과목명/.test(compact(value))));
      // 헤더 행 주변만 사용해 제목·안내문·과목 데이터가 열 인식에 섞이지 않도록 한다.
      const headerStart = headerIndex >= 0 ? Math.max(0, headerIndex - 2) : 0;
      const headerRows = headerIndex >= 0
        ? rows.slice(headerStart, headerIndex + 3).map((row, offset) =>
          headerStart + offset <= headerIndex || row.some((value) =>
            /^(?:과목명|세부과목|기준학점|운영학점|기준시수|운영시수|기준|운영|[12]학기|[123]-[12])$/.test(compact(value)))
            ? row : [])
        : rows.slice(0, 6);
      // 표 제목처럼 가로로 넓게 병합된 셀은 열 이름으로 보지 않는다.
      const wideMergedCells = new Set();
      for (const reference of layout.mergedRanges || []) {
        const [startRef, endRef = startRef] = String(reference).split(":");
        const startColumn = columnIndex(startRef);
        const endColumn = columnIndex(endRef);
        const startRow = Number(startRef.match(/\d+/)?.[0]) - 1;
        const endRow = Number(endRef.match(/\d+/)?.[0]) - 1;
        if (![startColumn, endColumn, startRow, endRow].every(Number.isInteger)) continue;
        if (endColumn - startColumn + 1 < Math.max(3, Math.ceil(width / 2))) continue;
        for (let row = startRow; row <= endRow; row++) {
          for (let column = startColumn; column <= endColumn; column++) wideMergedCells.add(`${row}:${column}`);
        }
      }
      const labels = Array.from({ length: width }, (_, column) =>
        headerRows.map((row, offset) =>
          wideMergedCells.has(`${headerStart + offset}:${column}`) ? "" : compact(row[column])
        ).filter(Boolean).join(" ")
      );
      const find = (patterns) => labels.findIndex((label) =>
        patterns.some((pattern) => pattern.test(label))
      );
      const gradeColumn = labels.findIndex((label) =>
        /학년/.test(label) && !/학년도|학기|[123]\s*-\s*[12]/.test(label)
      );
      const semesterPatterns = [
        /(?:^|[^0-9])1-1(?:$|[^0-9])|1학년.*1학기|1학기.*1학년/,
        /(?:^|[^0-9])1-2(?:$|[^0-9])|1학년.*2학기|2학기.*1학년/,
        /(?:^|[^0-9])2-1(?:$|[^0-9])|2학년.*1학기|1학기.*2학년/,
        /(?:^|[^0-9])2-2(?:$|[^0-9])|2학년.*2학기|2학기.*2학년/,
        /(?:^|[^0-9])3-1(?:$|[^0-9])|3학년.*1학기|1학기.*3학년/,
        /(?:^|[^0-9])3-2(?:$|[^0-9])|3학년.*2학기|2학기.*3학년/
      ];
      const baseCredit = find([/기준학점/, /기준시수/]);
      // 병합 머리글 '세부과목'은 분류 열과 과목명 열을 함께 덮으므로 오른쪽 열을 사용한다.
      const subject = labels.reduce((found, label, column) =>
        /과목명|세부과목/.test(label) ? column : found, -1);
      const explicitDivision = find([/교육과정구분/, /과정구분/]);
      const genericDivision = labels.findIndex((label) => /^구분/.test(label));
      const division = explicitDivision >= 0
        ? explicitDivision
        : genericDivision >= 0 && rows.some((row) =>
          /학교|학생/.test(String(row[genericDivision] ?? ""))
        )
          ? genericDivision
          : -1;
      return {
        subject: subject >= 0 ? subject : (baseCredit > 0 ? baseCredit - 1 : -1),
        area: find([/교과군/, /교과영역/]),
        detail: find([/과목유형/, /세부선택/, /세부지정/, /세부유형/, /이수구분/]),
        grade: gradeColumn,
        division,
        baseCredit,
        opCredit: find([/운영학점/, /운영시수/]),
        genericCredit: find([/학점/, /시수/]),
        semesters: semesterPatterns.map((pattern) => labels.findIndex((label) => pattern.test(label)))
      };
    }

    // 표 레이아웃(열 위치)만으로 과목 행을 만든다. 헤더 규칙이 달라 createCurriculumPlanRecords가 실패할 때 사용한다.
    function planRowsFromImportedLayout(layout) {
      const columns = importedPlanColumnMap(layout);
      if (columns.subject < 0) return [];
      const contexts = importedPlanCourseContexts(layout, columns);
      return contexts.map((context) => {
        let grade = context.grade.match(/[123]/)?.[0] || "";
        const semesterIndex = columns.semesters.findIndex((column) =>
          column >= 0 && String(context.row[column] ?? "").trim());
        if (semesterIndex >= 0) grade = String(Math.floor(semesterIndex / 2) + 1);
        const creditOf = (column) => column >= 0
          ? Number(String(context.row[column]).replace(/[^\d.]/g, "")) || 0
          : 0;
        const baseCredit = creditOf(columns.baseCredit) || creditOf(columns.genericCredit);
        const opCredit = creditOf(columns.opCredit) || baseCredit;
        const sem = (index) => columns.semesters[index] >= 0
          ? String(context.row[columns.semesters[index]] ?? "").trim()
          : "";
        return normalizeCurriculumPlanRow({
          grade: grade || "1",
          division: context.division,
          area: context.area.replace(/↔/g, " ").trim(),
          detail: context.selectionType || context.detail || "일반선택",
          subject: context.subject.replace(/↔/g, " ").trim(),
          baseCredit,
          opCredit,
          sem11: sem(0), sem12: sem(1), sem21: sem(2), sem22: sem(3), sem31: sem(4), sem32: sem(5)
        });
      }).filter((row) => row.subject);
    }

    // insertionRow 위치에 행을 끼워 넣고 병합 범위·행 높이를 함께 밀어낸다.
    // extendMergesEndingAt 에 행 번호를 주면, 그 행에서 끝나는 세로 병합(구분·교과군 등)을 새 행까지 늘린다.
    function insertImportedPlanLayoutRow(layout, insertionRow, rowValues, extendMergesEndingAt = -1) {
      const width = Math.max(rowValues.length, ...layout.rows.map((row) => row.length));
      const newRow = Array.from({ length: width }, (_, column) => String(rowValues[column] ?? ""));
      const cellRef = (column, row) => {
        let value = column + 1;
        let name = "";
        while (value > 0) {
          const remainder = (value - 1) % 26;
          name = String.fromCharCode(65 + remainder) + name;
          value = Math.floor((value - 1) / 26);
        }
        return `${name}${row + 1}`;
      };
      const nextLayout = {
        ...layout,
        rows: layout.rows.map((row) => [...row]),
        mergedRanges: (layout.mergedRanges || []).map((reference) => {
          const [startRef, endRef = startRef] = String(reference).split(":");
          const startColumn = columnIndex(startRef);
          const startRow = Number(startRef.match(/\d+/)?.[0]) - 1;
          const endColumn = columnIndex(endRef);
          const endRow = Number(endRef.match(/\d+/)?.[0]) - 1;
          if (![startColumn, startRow, endColumn, endRow].every(Number.isInteger)) return reference;
          let nextStartRow = startRow;
          let nextEndRow = endRow;
          const isVertical = startColumn === endColumn && endRow > startRow;
          if (insertionRow <= startRow) {
            nextStartRow += 1;
            nextEndRow += 1;
          } else if (insertionRow <= endRow) {
            nextEndRow += 1;
          } else if (isVertical && endRow === extendMergesEndingAt && !newRow[startColumn]) {
            nextEndRow += 1;
          }
          const start = cellRef(startColumn, nextStartRow);
          const end = cellRef(endColumn, nextEndRow);
          return start === end ? start : `${start}:${end}`;
        }),
        rowHeights: Object.fromEntries(Object.entries(layout.rowHeights || {}).map(([row, height]) => [
          Number(row) >= insertionRow ? Number(row) + 1 : Number(row),
          height
        ])),
        ...(layout.hiddenRows ? { hiddenRows: layout.hiddenRows.map((row) => row >= insertionRow ? row + 1 : row) } : {})
      };
      nextLayout.rows.splice(insertionRow, 0, newRow);
      nextLayout.cellFills=Object.fromEntries(Object.entries(layout.cellFills || {}).map(([key,color])=>{
        const [row,column]=key.split(":").map(Number);
        return [`${row>=insertionRow?row+1:row}:${column}`,color];
      }));
      if (typeof insertPlanFormulaRow === "function") insertPlanFormulaRow(layout, nextLayout, insertionRow);
      return nextLayout;
    }

    function appendBlankImportedPlanRow() {
      const layout = state.curriculumImportedLayout;
      if (!layout) {
        status.style.color = "#a44939";
        status.textContent = "먼저 편제표를 불러오세요.";
        return;
      }
      recordCurriculumUndo();
      const insertionRow = Number.isInteger(state.curriculumSelectedRow)
        ? Math.max(0, Math.min(state.curriculumSelectedRow, layout.rows.length))
        : layout.rows.length;
      const nextLayout = insertImportedPlanLayoutRow(layout, insertionRow, []);
      state.curriculumImportedLayout = nextLayout;
      state.curriculumSelectedRow = insertionRow;
      state.curriculumMutationRevision += 1;
      renderCurriculumStep();
      persistState();
      status.style.color = "#287956";
      status.textContent = `선택한 행 ${insertionRow + 1} 위에 빈 행을 추가했습니다.`;
      const focusColumn = Number.isInteger(state.curriculumSelectedColumn) ? state.curriculumSelectedColumn : 0;
      const insertedCell = $(`#curriculumPlanWrap [data-source-row="${insertionRow}"][data-source-column="${focusColumn}"]`) ||
        $(`#curriculumPlanWrap [data-source-row="${insertionRow}"]`);
      if (insertedCell) {
        insertedCell.focus();
        insertedCell.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }

    function cropCurriculumSheet(sheet) {
      const sourceRows = sheet.rows || [];
      const ranges = sheet.layout?.mergedRanges || [];
      const parsedRanges = ranges.map((reference) => {
        const [startRef, endRef = startRef] = String(reference).split(":");
        const startColumn = columnIndex(startRef);
        const startRow = Number(startRef.match(/\d+/)?.[0]) - 1;
        const endColumn = columnIndex(endRef);
        const endRow = Number(endRef.match(/\d+/)?.[0]) - 1;
        return { startColumn, startRow, endColumn, endRow };
      }).filter((range) => [range.startColumn, range.startRow, range.endColumn, range.endRow].every(Number.isInteger));

      let minRow = Infinity;
      let maxRow = -1;
      let minColumn = Infinity;
      let maxColumn = -1;
      sourceRows.forEach((row, rowIndex) => {
        (row || []).forEach((value, columnIndex) => {
          if (!row._mergedFillColumns?.has(columnIndex) && String(value ?? "").trim()) {
            minRow = Math.min(minRow, rowIndex);
            maxRow = Math.max(maxRow, rowIndex);
            minColumn = Math.min(minColumn, columnIndex);
            maxColumn = Math.max(maxColumn, columnIndex);
          }
        });
      });
      for (const merge of parsedRanges) {
        if (!String(sourceRows[merge.startRow]?.[merge.startColumn] ?? "").trim()) continue;
        minRow = Math.min(minRow, merge.startRow);
        maxRow = Math.max(maxRow, merge.endRow);
        minColumn = Math.min(minColumn, merge.startColumn);
        maxColumn = Math.max(maxColumn, merge.endColumn);
      }
      if (maxRow < 0 || maxColumn < 0) throw new Error("편제표에 표시할 데이터가 없습니다.");

      const rows = sourceRows.slice(minRow, maxRow + 1).map((sourceRow, rowOffset) => {
        const rowIndex = minRow + rowOffset;
        return Array.from({ length: maxColumn - minColumn + 1 }, (_, columnOffset) => {
          const columnIndex = minColumn + columnOffset;
          return sourceRow?._mergedFillColumns?.has(columnIndex) ? "" : String(sourceRow?.[columnIndex] ?? "");
        });
      });
      const toColumnName = (index) => {
        let value = index + 1;
        let name = "";
        while (value > 0) {
          const remainder = (value - 1) % 26;
          name = String.fromCharCode(65 + remainder) + name;
          value = Math.floor((value - 1) / 26);
        }
        return name;
      };
      const mergedRanges = parsedRanges
        .filter((merge) => merge.startRow >= minRow && merge.endRow <= maxRow &&
          merge.startColumn >= minColumn && merge.endColumn <= maxColumn)
        .map((merge) => {
          const start = `${toColumnName(merge.startColumn - minColumn)}${merge.startRow - minRow + 1}`;
          const end = `${toColumnName(merge.endColumn - minColumn)}${merge.endRow - minRow + 1}`;
          return start === end ? start : `${start}:${end}`;
        });
      return {
        sheetName: sheet.name,
        sourceRowOffset: minRow,
        sourceColumnOffset: minColumn,
        sheetPath: sheet.layout?.sheetPath,
        originalRowCount: rows.length,
        rowInsertions: [],
        formulas: Object.fromEntries(Object.entries(sheet.layout?.formulas || {}).flatMap(([key, formula]) => {
          const [row, column] = key.split(":").map(Number);
          return row >= minRow && row <= maxRow && column >= minColumn && column <= maxColumn
            ? [[`${row-minRow}:${column-minColumn}`, shiftPlanFormula(formula, -minRow, -minColumn)]] : [];
        })),
        rows,
        mergedRanges,
        cellFills: Object.fromEntries(Object.entries(sheet.layout?.cellFills || {}).flatMap(([key, color]) => {
          const [row,column]=key.split(":").map(Number);
          return row>=minRow && row<=maxRow && column>=minColumn && column<=maxColumn
            ? [[`${row-minRow}:${column-minColumn}`,color]] : [];
        })),
        columnWidths: (sheet.layout?.columnWidths || []).slice(minColumn, maxColumn + 1),
        rowHeights: Object.fromEntries(Object.entries(sheet.layout?.rowHeights || {})
          .filter(([row]) => Number(row) >= minRow && Number(row) <= maxRow)
          .map(([row, height]) => [Number(row) - minRow, height])),
        hiddenRows: (sheet.layout?.hiddenRows || []).filter((row) => row >= minRow && row <= maxRow).map((row) => row - minRow)
      };
    }

    function expandCurriculumLayoutRows(layout) {
      const rows = layout.rows.map((row) => [...row]);
      const sheetMergeReferences = sheetMergeReferenceSet(layout);
      for (const reference of layout.mergedRanges || []) {
        if (sheetMergeReferences.has(reference)) continue;
        const [startRef, endRef = startRef] = String(reference).split(":");
        const startColumn = columnIndex(startRef);
        const startRow = Number(startRef.match(/\d+/)?.[0]) - 1;
        const endColumn = columnIndex(endRef);
        const endRow = Number(endRef.match(/\d+/)?.[0]) - 1;
        if (![startColumn, startRow, endColumn, endRow].every(Number.isInteger)) continue;
        const value = rows[startRow]?.[startColumn] ?? "";
        for (let rowIndex = startRow; rowIndex <= endRow; rowIndex++) {
          rows[rowIndex] = rows[rowIndex] || [];
          for (let column = startColumn; column <= endColumn; column++) {
            if (rowIndex === startRow && column === startColumn) continue;
            rows[rowIndex][column] = value;
            if (rowIndex !== startRow) {
              rows[rowIndex]._mergedFillColumns = rows[rowIndex]._mergedFillColumns || new Set();
              rows[rowIndex]._mergedFillColumns.add(column);
            }
          }
        }
      }
      return rows;
    }

    function handleCurriculumPlanWorkbook(file) {
      if (!file) return;
      if (!requireLocalWorkspaceAccess()) return;
      if (state.curriculumPlanType === "annual") {
        status.style.color = "#a44939";
        status.textContent = "전학년 편제표는 업로드하지 않고 신입생 3개년 편제표에서 자동으로 만듭니다. 입학생 카드에서 업로드하세요.";
        return;
      }
      const cohortYear = String(state.curriculumCohortYear);
      const planType = state.curriculumPlanType === "annual" ? "annual" : "cohort";
      status.textContent = "";
      if (!file.name.toLowerCase().endsWith(".xlsx")) {
        status.style.color = "#a44939";
        status.textContent = "편제표는 .xlsx 형식만 지원합니다.";
        return;
      }
      const importRevision = ++curriculumImportRevision;
      const mutationRevision = state.curriculumMutationRevision;
      const schoolYear = $("#schoolYear").value;
      const verifyTarget = () => {
        if (curriculumImportRevision !== importRevision || state.curriculumMutationRevision !== mutationRevision ||
            String(state.curriculumCohortYear) !== cohortYear || state.curriculumPlanType !== planType ||
            $("#schoolYear").value !== schoolYear) {
          throw new Error("파일을 읽는 중 편제표·입학연도·학년도가 바뀌었거나 새 업로드가 시작되었습니다. 대상 자료를 확인한 뒤 다시 업로드하세요.");
        }
        if (!requireLocalWorkspaceAccess()) throw new Error("교사용 작업 화면에서 다시 업로드하세요.");
      };
      const reader = new FileReader();
      reader.onerror = () => {
        status.style.color = "#a44939";
        status.textContent = "편제표 파일을 읽지 못했습니다.";
      };
      reader.onload = async () => {
        try {
          const sheets = await parseWorkbook(reader.result, { expandMergedCells: true, includeLayout: true });
          verifyTarget();
          let plan = [];
          let importedLayout = null;
          let parseError = null;
          for (const sheet of sheets) {
            let layout = null;
            try {
              layout = cropCurriculumSheet(sheet);
            } catch (error) {
              parseError = error;
              continue;
            }
            let sheetPlan = [];
            try {
              sheetPlan = curriculumPlanFromLayout(layout, `${file.name} ${sheet.name}`);
            } catch (error) {
              parseError = error;
            }
            if (!sheetPlan.length) sheetPlan = planRowsFromImportedLayout(layout);
            if (sheetPlan.length || !importedLayout) {
              importedLayout = layout;
              plan = sheetPlan;
            }
            if (plan.length) break;
          }
          if (!importedLayout) throw parseError || new Error("편제표 시트를 찾지 못했습니다.");
          importedLayout.archiveId = await storeCurriculumArchive(reader.result);
          verifyTarget();
          const versionYear = curriculumPlanVersionKey();
          recordCurriculumUndo();
          state.curriculumMutationRevision += 1;
          state.curriculumPlanFilters = { grade: "", division: "", area: "", detail: "", query: "" };
          state.curriculumPlan = plan;
          state.curriculumTemplateRows = plan.map((row) => normalizeCurriculumPlanRow(row));
          state.curriculumPlanFileName = file.name;
          state.curriculumImportedLayout = importedLayout;
          if (typeof recordCurriculumVersion === "function" && !latestCurriculumSavedVersion(versionYear)) {
            recordCurriculumVersion(versionYear, importedLayout, { reason: "편제표 업로드", fileName: file.name, auto: true });
          }
          renderCurriculumStep();
          persistState();
          status.style.color = plan.length ? "#287956" : "#a44939";
          status.textContent = plan.length
            ? `${state.curriculumCohortYear}학년도 ${planType === "annual" ? "전학년" : "신입생 3개년"} 편제표 ${plan.length}개 과목을 불러왔습니다.`
            : "편제표 표는 불러왔지만 과목 열을 인식하지 못했습니다. 표를 확인해 주세요.";
        } catch (error) {
          const message = error instanceof Error ? error.message : "편제표 파일 처리 중 오류가 발생했습니다.";
          status.style.color = "#a44939";
          status.textContent = message;
        }
      };
      reader.readAsArrayBuffer(file);
    }


    function printStudents(students) {
      if (!students.length) return;
      const groupSettings = certificateGroupSettings();
      $("#printBatch").innerHTML = students.map((student) => certificateMarkup(student, true, groupSettings)).join("");
      window.print();
    }

    rosterInput.addEventListener("change", (event) => { handleWorkbook(event.target.files[0]); event.target.value = ""; });
    curriculumPlanInput.addEventListener("change", (event) => { handleCurriculumPlanWorkbook(event.target.files[0]); event.target.value = ""; });
    $("#curriculumCohortUploads").addEventListener("click", (event) => {
      const button = event.target.closest("[data-cohort-upload], [data-cohort-view], [data-annual-build], [data-annual-view]");
      if (!button || button.disabled) return;
      if (button.dataset.annualBuild) {
        switchCurriculumAnnualPlan(button.dataset.annualBuild, true);
        return;
      }
      if (button.dataset.annualView) {
        switchCurriculumAnnualPlan(button.dataset.annualView);
        return;
      }
      switchCurriculumCohort(button.dataset.cohortUpload || button.dataset.cohortView);
      if (button.dataset.cohortUpload) curriculumPlanInput.click();
    });
    $("#undoCurriculumEdit").addEventListener("click", undoCurriculumEdit);
    $("#addCurriculumPlanRow").addEventListener("click", appendBlankImportedPlanRow);
    $("#curriculumPlanFilters").addEventListener("change", (event) => {
      const filter = event.target.closest("select[id^='curriculumFilter']");
      if (!filter) return;
      const key = filter.id === "curriculumFilterGrade" ? "grade" :
        filter.id === "curriculumFilterDivision" ? "division" :
        filter.id === "curriculumFilterArea" ? "area" : "detail";
      state.curriculumPlanFilters[key] = filter.value;
      renderCurriculumStep();
      persistState();
    });
    $("#curriculumFilterQuery").addEventListener("input", (event) => {
      state.curriculumPlanFilters.query = event.target.value.trim();
      if (curriculumSearchTimer !== null) window.clearTimeout(curriculumSearchTimer);
      curriculumSearchTimer = window.setTimeout(() => {
        curriculumSearchTimer = null;
        renderCurriculumStep();
      }, 150);
    });
    $("#curriculumSelectionGroupEditor").addEventListener("change", (event) => {
      const input = event.target.closest("[data-selection-group-field][data-plan-index][data-semester-field]");
      if (!input) return;
      const index = Number(input.dataset.planIndex);
      const field = input.dataset.semesterField;
      const source = state.curriculumPlan[index];
      if (!source || !CURRICULUM_SEMESTER_FIELDS.includes(field)) return;
      const row = normalizeCurriculumPlanRow(source);
      const semester = String((CURRICULUM_SEMESTER_FIELDS.indexOf(field) % 2) + 1);
      const peers = state.curriculumPlan.map((item, rowIndex) => ({ row: normalizeCurriculumPlanRow(item), rowIndex }))
        .filter(({ row: item }) => item.grade === row.grade && String(item[field] || "").trim());
      let groupName = row.semesterGroups[field]?.name ?? row.bundleName;
      let groupPick = row.semesterGroups[field]?.pick ?? row.bundlePick;
      if (input.dataset.selectionGroupField === "name") {
        groupName = input.value.trim().slice(0, 100);
        if (row.semesterGroups[field]?.block) return;
        const blockNames = new Set(state.curriculumPlan.flatMap((item) =>
          item?.semesterGroups?.[field]?.block ? [item.semesterGroups[field].name] : []));
        if (blockNames.has(groupName)) {
          input.setCustomValidity("편제표 택n 묶음 이름입니다. 다른 그룹명을 입력하세요.");
          input.reportValidity();
          input.setCustomValidity("");
          renderCurriculumStep();
          return;
        }
        const matching = peers.filter(({ row: item }) => {
          const currentName = Object.prototype.hasOwnProperty.call(item.semesterGroups, field)
            ? item.semesterGroups[field]?.name
            : item.bundleName;
          return currentName === groupName && groupName;
        });
        if (matching.length) groupPick = matching[0].row.semesterGroups[field]?.pick ?? matching[0].row.bundlePick;
        else if (!row.semesterGroups[field]?.name) groupPick = 1;
      } else {
        groupName = row.semesterGroups[field]?.name ?? row.bundleName;
        const groupSize = peers.filter(({ row: item }) => {
          const currentName = Object.prototype.hasOwnProperty.call(item.semesterGroups, field)
            ? item.semesterGroups[field]?.name
            : item.bundleName;
          return currentName === groupName && Boolean(groupName);
        }).length;
        const value = input.value === "" ? 1 : Number(input.value);
        if (!groupName || !Number.isInteger(value) || value < 0 || value > groupSize) {
          input.setCustomValidity(`0~${groupSize} 사이의 정수를 입력하세요.`);
          input.reportValidity();
          input.setCustomValidity("");
          renderCurriculumStep();
          return;
        }
        groupPick = value;
      }
      if (groupName) {
        const groupSize = peers.filter(({ row: item }) => {
          const currentName = Object.prototype.hasOwnProperty.call(item.semesterGroups, field)
            ? item.semesterGroups[field]?.name
            : item.bundleName;
          return currentName === groupName;
        }).length || 1;
        if (!Number.isInteger(groupPick) || groupPick < 0 || groupPick > groupSize) {
          groupPick = 1;
        }
      } else {
        groupPick = 0;
      }
      recordCurriculumUndo();
      row.semesterGroups[field] = { name: groupName, pick: groupPick };
      source.semesterGroups = row.semesterGroups;
      if (groupName) {
        for (const { row: peer, rowIndex } of peers) {
          if (peer.grade !== row.grade || rowIndex === index) continue;
          const peerName = Object.prototype.hasOwnProperty.call(peer.semesterGroups, field)
            ? peer.semesterGroups[field]?.name
            : peer.bundleName;
          if (peerName !== groupName) continue;
          peer.semesterGroups[field] = { name: groupName, pick: groupPick };
          state.curriculumPlan[rowIndex].semesterGroups = peer.semesterGroups;
        }
      }
      syncCurriculumTemplateRows();
      renderCurriculumStep();
      const saved = persistState();
      if (Number(state.workflowStep) === 2) renderApplicationSubjects();
      status.style.color = saved ? "#287956" : "#a44939";
      status.textContent = saved
        ? `${row.grade}학년 ${semester}학기 선택 그룹을 저장했습니다. 이력 저장을 누르면 날짜와 변경 내용도 남습니다.`
        : "선택 그룹 변경을 반영했지만 저장하지 못했습니다. 상단 저장 경고를 확인하세요.";
    });
    $("#curriculumPlanWrap").addEventListener("focusin", (event) => {
      const cell = event.target.closest("[contenteditable='true'][data-source-row][data-source-column]");
      if (!cell || !state.curriculumImportedLayout) return;
      $("#curriculumPlanWrap").querySelectorAll(".keyboard-current").forEach((item) => item.classList.remove("keyboard-current"));
      cell.classList.add("keyboard-current");
      state.curriculumSelectedRow = Number(cell.dataset.sourceRow);
      state.curriculumSelectedColumn = Number(cell.dataset.sourceColumn);
      state.curriculumEditBefore = curriculumSnapshot();
      state.curriculumEditUndoRecorded = false;
    });
    $("#curriculumPlanWrap").addEventListener("keydown", (event) => {
      const cell = event.target.closest("[contenteditable='true'][data-source-row][data-source-column]");
      if (!cell) return;
      const cells = [...$("#curriculumPlanWrap").querySelectorAll(".curriculum-source-table td[contenteditable='true']")];
      const currentIndex = cells.indexOf(cell);
      if (currentIndex < 0) return;
      let target = null;
      if (event.key === "Tab") {
        target = cells[currentIndex + (event.shiftKey ? -1 : 1)];
      } else if (event.key === "Enter") {
        target = cells.filter((item) => Number(item.dataset.sourceColumn) === Number(cell.dataset.sourceColumn) &&
          Number(item.dataset.sourceRow) > Number(cell.dataset.sourceRow))
          .sort((a, b) => Number(a.dataset.sourceRow) - Number(b.dataset.sourceRow))[0];
      } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        const selection = window.getSelection?.();
        const anchor = selection?.anchorNode;
        const offset = selection?.anchorOffset ?? 0;
        const length = anchor?.textContent?.length ?? 0;
        if (anchor && cell.contains(anchor) && selection.isCollapsed &&
            ((event.key === "ArrowLeft" && offset > 0) ||
             (event.key === "ArrowRight" && offset < length) ||
             (event.key === "ArrowUp" && offset > 0) ||
             (event.key === "ArrowDown" && offset < length))) return;
        const row = Number(cell.dataset.choiceStart ?? cell.dataset.sourceRow);
        const column = Number(cell.dataset.sourceColumn);
        const candidates = cells.filter((item) => item !== cell).map((item) => ({
          item, row: Number(item.dataset.sourceRow), column: Number(item.dataset.sourceColumn)
        }));
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          const direction = event.key === "ArrowLeft" ? -1 : 1;
          target = candidates.filter((item) => item.row === row && (item.column - column) * direction > 0)
            .sort((a, b) => Math.abs(a.column-column) - Math.abs(b.column-column))[0]?.item;
        } else {
          const direction = event.key === "ArrowUp" ? -1 : 1;
          target = candidates.filter((item) => item.column === column && (item.row - row) * direction > 0)
            .sort((a, b) => Math.abs(a.row-row) - Math.abs(b.row-row))[0]?.item;
        }
      }
      if (!target) return;
      event.preventDefault();
      const row = target.dataset.sourceRow;
      const column = target.dataset.sourceColumn;
      cell.blur();
      setTimeout(() => {
        const next = $(`#curriculumPlanWrap [data-source-row="${row}"][data-source-column="${column}"]`);
        next?.focus();
      }, 20);
    });
    $("#curriculumPlanWrap").addEventListener("input", (event) => {
      const cell = event.target.closest("[contenteditable='true'][data-source-row][data-source-column]");
      if (!cell || !state.curriculumImportedLayout) return;
      if (!state.curriculumEditUndoRecorded && state.curriculumEditBefore) {
        recordCurriculumUndo(state.curriculumEditBefore);
        state.curriculumEditUndoRecorded = true;
      }
      const rowIndex = Number(cell.dataset.sourceRow);
      const columnIndexValue = Number(cell.dataset.sourceColumn);
      if (!Number.isInteger(rowIndex) || !Number.isInteger(columnIndexValue)) return;
      state.curriculumImportedLayout.rows[rowIndex] = state.curriculumImportedLayout.rows[rowIndex] || [];
      state.curriculumImportedLayout.rows[rowIndex][columnIndexValue] = cell.innerText.replace(/\r\n?/g, "\n");
      if (state.curriculumImportedLayout.formulas) delete state.curriculumImportedLayout.formulas[`${rowIndex}:${columnIndexValue}`];
      try {
        recalculatePlanFormulas(state.curriculumImportedLayout);
        for (const [key] of Object.entries(state.curriculumImportedLayout.formulas || {})) {
          const [row, column] = key.split(":");
          const target = $(`#curriculumPlanWrap [data-source-row="${row}"][data-source-column="${column}"]`);
          if (target) target.textContent = state.curriculumImportedLayout.rows[Number(row)][Number(column)];
        }
        status.textContent = "편제표 수정 내용과 소계를 반영했습니다.";
      } catch (error) { status.textContent = `소계 계산 실패: ${error.message}`; }
      persistState();
    });
    $("#curriculumPlanWrap").addEventListener("focusout", (event) => {
      const cell = event.target.closest("[contenteditable='true'][data-source-row][data-source-column]");
      if (!cell || !state.curriculumImportedLayout) return;
      const edited = state.curriculumEditUndoRecorded;
      state.curriculumEditBefore = null;
      state.curriculumEditUndoRecorded = false;
      if (!edited) return;
      const mutationRevision = state.curriculumMutationRevision;
      setTimeout(() => {
        if (mutationRevision !== state.curriculumMutationRevision) return;
        try {
          recalculatePlanFormulas(state.curriculumImportedLayout);
          const plan = curriculumPlanFromLayout(
            state.curriculumImportedLayout,
            `${state.curriculumPlanFileName} ${state.curriculumImportedLayout.sheetName || ""}`,
            state.curriculumPlan
          );
          state.curriculumPlan = plan;
          state.curriculumTemplateRows = plan.map((row) => normalizeCurriculumPlanRow(row));
          renderCurriculumStep();
          const saved = persistState();
          status.style.color = "#287956";
          status.textContent = saved ? "편제표 수정 내용을 저장했습니다." : "편제표 수정을 반영했지만 저장하지 못했습니다. 상단 저장 경고를 확인하세요.";
        } catch (error) {
          const message = error instanceof Error ? error.message : "편제표 수정 내용을 데이터로 반영하지 못했습니다.";
          status.style.color = "#a44939";
          status.textContent = `화면 수정은 저장했지만 데이터 해석에 실패했습니다: ${message}`;
        }
      }, 0);
    }, true);
    $("#curriculumTopToggle").addEventListener("click", () => {
      state.curriculumTopCollapsed = !state.curriculumTopCollapsed;
      $("#teacherWorkspace").classList.toggle("curriculum-top-collapsed", state.curriculumTopCollapsed);
      $("#curriculumTopToggle").setAttribute("aria-expanded", String(!state.curriculumTopCollapsed));
      $("#curriculumTopToggle").textContent = state.curriculumTopCollapsed ? "상단 펼치기" : "상단 접기";
      renderCurriculumStep();
      persistState();
      scheduleCurriculumTableSize();
    });
    window.addEventListener("resize", scheduleCurriculumTableSize);
    $("#teacherWorkspace").addEventListener("toggle", scheduleCurriculumTableSize, true);
    if (typeof ResizeObserver !== "undefined") {
      const curriculumSizeObserver = new ResizeObserver(scheduleCurriculumTableSize);
      curriculumSizeObserver.observe($("#curriculumPlanDropZone"));
    }
    $("#curriculumMergeToggle").addEventListener("click", () => {
      curriculumCellSelectionMode = !curriculumCellSelectionMode;
      $("#curriculumMergeToggle").setAttribute("aria-pressed", String(curriculumCellSelectionMode));
      $("#curriculumMergeControls").classList.toggle("hidden", !curriculumCellSelectionMode);
      renderCurriculumStep();
    });
    function selectCurriculumCellRange(cell, extend, end = Number(cell.dataset.choiceEnd ?? cell.dataset.sourceRow)) {
      const row = Number(cell.dataset.sourceRow);
      const column = Number(cell.dataset.sourceColumn);
      const cellEndColumn = Number(cell.dataset.choiceEndColumn ?? column);
      if (!extend || !curriculumSelectionAnchor) {
        curriculumSelectionAnchor = { row, endRow: end, column, endColumn: cellEndColumn };
      }
      const startColumn = Math.min(column, curriculumSelectionAnchor.column);
      const endColumn = Math.max(cellEndColumn, curriculumSelectionAnchor.endColumn ?? curriculumSelectionAnchor.column);
      const startRow = Math.min(row, curriculumSelectionAnchor.row);
      const endRow = Math.max(end, curriculumSelectionAnchor.endRow);
      curriculumCellSelection = { column: startColumn, startRow, endRow, ...(endColumn !== startColumn ? { endColumn } : {}) };
      $("#curriculumPlanWrap").querySelectorAll("[data-choice-selectable]").forEach((item) => {
        const selected = Number(item.dataset.sourceColumn) >= startColumn && Number(item.dataset.sourceColumn) <= endColumn &&
          Number(item.dataset.sourceRow) >= startRow && Number(item.dataset.sourceRow) <= endRow;
        item.classList.toggle("curriculum-cell-selected", selected);
        item.setAttribute("aria-pressed", String(selected));
      });
      const horizontal = endColumn > startColumn;
      const selectionLayout = state.curriculumImportedLayout;
      const selectionColumns = importedPlanColumnMap(selectionLayout);
      if (!curriculumFirstRowCache || curriculumFirstRowCache.revision !== state.curriculumMutationRevision) {
        curriculumFirstRowCache = { revision: state.curriculumMutationRevision, row: curriculumFirstCourseRow(selectionLayout, selectionColumns) };
      }
      const semesterColumns = selectionColumns.semesters;
      const academic = startRow >= curriculumFirstRowCache.row && semesterColumns.includes(startColumn) && semesterColumns.includes(endColumn);
      $("#curriculumMergeSelection").textContent = `${columnName(startColumn)}${startRow + 1}:${columnName(endColumn)}${endRow + 1} · ${academic ? horizontal ? "교차집중 선택과목군" : "선택과목군" : "일반 셀 병합"}`;
      $("#curriculumMergeApply").disabled = !horizontal && endRow <= startRow;
      $("#curriculumMergePick").closest?.("label")?.classList.toggle("hidden", !academic);
      $("#curriculumMergeCredit").closest?.("label")?.classList.toggle("hidden", !academic);
      $("#curriculumMergeRelease").disabled = !curriculumChoiceBlocks(state.curriculumImportedLayout).some((block) =>
        block.column === column && startRow <= block.endRow && endRow >= block.startRow);
      const block = curriculumChoiceBlocks(state.curriculumImportedLayout).find((item) =>
        item.column === column && startRow >= item.startRow && startRow <= item.endRow);
      if (!extend && block) {
        $("#curriculumMergePick").value = String(block.pick);
        $("#curriculumMergeCredit").value = String(block.credit || 4);
      }
      if ((state.curriculumImportedLayout.mergedRanges || []).some((reference) => {
        const range = curriculumChoiceRange(reference);
        return range && range.startColumn <= endColumn && range.endColumn >= startColumn &&
          range.startRow <= endRow && range.endRow >= startRow;
      })) $("#curriculumMergeRelease").disabled = false;
    }
    function startCurriculumRangeSelection(gesture, extend) {
      const anchor = curriculumSelectionAnchor;
      const wrap = $("#curriculumPlanWrap");
      const sheet = wrap.querySelector(".curriculum-imported-sheet");
      const scroll = [wrap.scrollTop, wrap.scrollLeft, sheet?.scrollTop || 0, sheet?.scrollLeft || 0];
      if (!curriculumCellSelectionMode) {
        const table = wrap.querySelector(".curriculum-source-table");
        const widths = [...table.querySelectorAll("col")].map((column) => column.getBoundingClientRect().width);
        const tableWidth = table.getBoundingClientRect().width;
        const heights = [...table.rows].map((row) => row.getBoundingClientRect().height);
        curriculumCellSelectionMode = true;
        $("#curriculumMergeToggle").setAttribute("aria-pressed", "true");
        $("#curriculumMergeControls").classList.remove("hidden");
        renderCurriculumStep();
        // Keep the cells under the pointer when expanded blocks change intrinsic column widths.
        const nextTable = wrap.querySelector(".curriculum-source-table");
        nextTable.style.tableLayout = "fixed";
        nextTable.style.width = `${tableWidth}px`;
        nextTable.style.minWidth = `${tableWidth}px`;
        nextTable.querySelectorAll("col").forEach((column, index) => { column.style.width = `${widths[index]}px`; });
        [...nextTable.rows].forEach((row, index) => { row.style.height = `${heights[index]}px`; });
        [wrap.scrollTop, wrap.scrollLeft] = scroll;
        const nextSheet = wrap.querySelector(".curriculum-imported-sheet");
        if (nextSheet) [nextSheet.scrollTop, nextSheet.scrollLeft] = scroll.slice(2);
      }
      if (extend) curriculumSelectionAnchor = anchor;
      const cell = wrap.querySelector(`[data-choice-selectable][data-source-row="${gesture.row}"][data-source-column="${gesture.column}"]`);
      if (!cell) return;
      selectCurriculumCellRange(cell, extend, gesture.endRow);
      curriculumSelectionDragging = true;
      cell.focus({ preventScroll: true });
    }
    $("#curriculumPlanWrap").addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("input, button")) return;
      const cell = event.target.closest("[data-choice-selectable], [data-choice-column]");
      if (!cell) return;
      const gesture = {
        row: Number(cell.dataset.sourceRow ?? cell.dataset.choiceStart),
        endRow: Number(cell.dataset.choiceEnd ?? cell.dataset.sourceRow),
        column: Number(cell.dataset.sourceColumn ?? cell.dataset.choiceColumn),
        endColumn: Number(cell.dataset.choiceEndColumn ?? cell.dataset.sourceColumn ?? cell.dataset.choiceColumn),
        x: event.clientX, y: event.clientY, pointerId: event.pointerId
      };
      if (curriculumCellSelectionMode || event.shiftKey) {
        event.preventDefault();
        startCurriculumRangeSelection(gesture, event.shiftKey);
      } else {
        curriculumSelectionAnchor = { row: Number(cell.dataset.choiceStart ?? gesture.row), endRow: gesture.endRow, column: gesture.column, endColumn: gesture.endColumn };
      }
      curriculumSelectionGesture = gesture;
    });
    document.addEventListener("pointermove", (event) => {
      const gesture = curriculumSelectionGesture;
      if (!gesture || event.pointerId !== gesture.pointerId || !(event.buttons & 1)) return;
      if (!curriculumSelectionDragging) {
        if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 5) return;
        startCurriculumRangeSelection(gesture, false);
        curriculumSelectionGesture = gesture;
      }
      if (!curriculumSelectionDragging) return;
      event.preventDefault();
      const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-choice-selectable]");
      if (cell) selectCurriculumCellRange(cell, true);
    }, { passive: false });
    function stopCurriculumRangeSelection() {
      curriculumSelectionDragging = false;
      curriculumSelectionGesture = null;
    }
    document.addEventListener("pointerup", stopCurriculumRangeSelection);
    document.addEventListener("pointercancel", stopCurriculumRangeSelection);
    window.addEventListener("blur", stopCurriculumRangeSelection);
    $("#curriculumPlanWrap").addEventListener("keydown", (event) => {
      const cell = event.target.closest("[data-choice-selectable]");
      if (!curriculumCellSelectionMode || !cell) return;
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        selectCurriculumCellRange(cell, event.shiftKey);
      } else if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        const row = event.key === "ArrowUp" ? Number(cell.dataset.choiceStart ?? cell.dataset.sourceRow) - 1 :
          event.key === "ArrowDown" ? Number(cell.dataset.choiceEnd ?? cell.dataset.sourceRow) + 1 : Number(cell.dataset.displayRow ?? cell.dataset.sourceRow);
        const column = event.key === "ArrowLeft" ? Number(cell.dataset.sourceColumn) - 1 :
          event.key === "ArrowRight" ? Number(cell.dataset.choiceEndColumn ?? cell.dataset.sourceColumn) + 1 : Number(cell.dataset.sourceColumn);
        const next = [...$("#curriculumPlanWrap").querySelectorAll("[data-choice-selectable]")].find((item) =>
          row >= Number(item.dataset.choiceStart ?? item.dataset.sourceRow) && row <= Number(item.dataset.choiceEnd ?? item.dataset.sourceRow) &&
          column >= Number(item.dataset.sourceColumn) && column <= Number(item.dataset.choiceEndColumn ?? item.dataset.sourceColumn));
        if (next) {
          if (!curriculumSelectionAnchor) selectCurriculumCellRange(cell, false);
          selectCurriculumCellRange(next, event.shiftKey);
          next.focus();
        }
      }
    });
    function applyCurriculumCellSelection(release = false, insertion = "") {
      try {
        if (typeof isWorkspaceStorageProtected === "function" && isWorkspaceStorageProtected()) throw new Error("저장 원본을 먼저 복원하세요.");
        if (!curriculumCellSelection) throw new Error("병합할 셀을 먼저 선택하세요.");
        let layout = JSON.parse(JSON.stringify(state.curriculumImportedLayout));
        if (insertion === "row") {
          layout = insertImportedPlanLayoutRow(layout, curriculumCellSelection.startRow, []);
        } else if (insertion === "cells") {
          layout = insertCurriculumSheetCells(layout, curriculumCellSelection);
        } else if (release) {
          const endColumn = curriculumCellSelection.endColumn ?? curriculumCellSelection.column;
          const actual = (layout.mergedRanges || []).some((reference) => {
            const r = curriculumChoiceRange(reference);
            return r && r.startColumn <= endColumn && r.endColumn >= curriculumCellSelection.column &&
              r.startRow <= curriculumCellSelection.endRow && r.endRow >= curriculumCellSelection.startRow;
          });
          if (actual) layout = unmergeCurriculumSheetCells(layout, curriculumCellSelection);
          else unmergeCurriculumChoiceCells(layout, curriculumCellSelection);
        } else layout = mergeCurriculumSheetCells(layout, curriculumCellSelection, {
          pick: $("#curriculumMergePick").value, credit: $("#curriculumMergeCredit").value
        });
        const plan = curriculumPlanFromLayout(layout, `${state.curriculumPlanFileName} ${layout.sheetName || ""}`, state.curriculumPlan);
        recordCurriculumUndo();
        state.curriculumMutationRevision += 1;
        state.curriculumImportedLayout = layout;
        state.curriculumPlan = plan;
        syncCurriculumTemplateRows();
        curriculumCellSelectionMode = false;
        curriculumSelectionAnchor = null;
        $("#curriculumMergeToggle").setAttribute("aria-pressed", "false");
        $("#curriculumMergeControls").classList.add("hidden");
        renderCurriculumStep();
        const saved = persistState();
        status.style.color = saved ? "#287956" : "#a44939";
        status.textContent = saved
          ? insertion ? insertion === "row" ? "선택한 위치 위에 행을 삽입했습니다." : "선택 셀을 아래로 밀어 빈 셀을 삽입했습니다."
            : release ? "셀 병합을 해제했습니다. 병합 전 값·수식은 유지됩니다." : "셀을 병합하고 학기 영역의 과목군·이수학점을 연결했습니다."
          : "변경했지만 저장하지 못했습니다. 상단 저장 경고를 확인하세요.";
      } catch (error) {
        status.style.color = "#a44939";
        status.textContent = `묶음을 변경하지 못했습니다: ${error.message}`;
        showAppToast(status.textContent, "error");
      }
    }
    $("#curriculumSplitMerged").addEventListener("click", () => {
      if (!state.curriculumImportedLayout) return;
      if (!curriculumCellSelectionMode || !curriculumCellSelection) {
        if (!curriculumCellSelectionMode) {
          curriculumCellSelectionMode = true;
          $("#curriculumMergeToggle").setAttribute("aria-pressed", "true");
          $("#curriculumMergeControls").classList.remove("hidden");
          renderCurriculumStep();
        }
        status.style.color = "#596780";
        status.textContent = "분리할 병합 셀을 표에서 선택한 뒤 '병합 셀 분리'를 다시 누르세요.";
        showAppToast(status.textContent);
        return;
      }
      applyCurriculumCellSelection(true);
    });
    $("#curriculumMergeApply").addEventListener("click", () => applyCurriculumCellSelection());
    $("#curriculumMergeRelease").addEventListener("click", () => applyCurriculumCellSelection(true));
    $("#curriculumInsertSelectionRow").addEventListener("click", () => applyCurriculumCellSelection(false, "row"));
    $("#curriculumInsertSelectionCells").addEventListener("click", () => applyCurriculumCellSelection(false, "cells"));
    $("#curriculumPlanWrap").addEventListener("change", (event) => {
      const input = event.target.closest("input[data-choice-field]");
      const cell = input?.closest("[data-choice-block]");
      if (!cell || !state.curriculumImportedLayout) return;
      const values = {};
      cell.querySelectorAll("input[data-choice-field]").forEach((item) => { values[item.dataset.choiceField] = item.value; });
      const current = curriculumChoiceBlocks(state.curriculumImportedLayout).find((block) => block.key === cell.dataset.choiceBlock);
      if (current && Number(values.pick) === current.pick && Number(values.credit) === current.credit) return;
      const before = curriculumSnapshot();
      try {
        const layout = JSON.parse(JSON.stringify(state.curriculumImportedLayout));
        const block = applyCurriculumChoiceBlockEdit(layout, cell.dataset.choiceBlock, values);
        recordCurriculumUndo(before);
        state.curriculumMutationRevision = (Number(state.curriculumMutationRevision) || 0) + 1;
        state.curriculumImportedLayout = layout;
        const plan = curriculumPlanFromLayout(layout, `${state.curriculumPlanFileName} ${layout.sheetName || ""}`, state.curriculumPlan);
        state.curriculumPlan = plan;
        state.curriculumTemplateRows = plan.map((row) => normalizeCurriculumPlanRow(row));
        renderCurriculumKeepingChoiceFocus();
        if (Number(state.workflowStep) === 2) renderApplicationSubjects();
        const saved = persistState();
        status.style.color = saved ? "#287956" : "#a44939";
        status.textContent = saved
          ? `${block.name}: ${block.subjects.length}과목 중 ${block.pick}과목 × ${block.credit}학점 = 이수 ${block.total}학점으로 바꿨습니다. 이력 저장을 누르면 날짜와 변경 내용도 남습니다.`
          : "묶음 변경을 반영했지만 저장하지 못했습니다. 상단 저장 경고를 확인하세요.";
      } catch (error) {
        status.style.color = "#a44939";
        status.textContent = `묶음을 바꾸지 못했습니다: ${error instanceof Error ? error.message : error}`;
        renderCurriculumKeepingChoiceFocus();
      }
    });
    // 묶음 칸은 다시 그려지므로, 사용자가 옮겨 간 입력 칸(택n ↔ 학점)과 표 스크롤 위치를 다음 틱에 되살린다.
    function renderCurriculumKeepingChoiceFocus() {
      setTimeout(() => {
        const wrap = $("#curriculumPlanWrap");
        const active = document.activeElement;
        const focusKey = active?.matches?.("input[data-choice-field]") && wrap.contains(active)
          ? { block: active.closest("[data-choice-block]")?.dataset.choiceBlock, field: active.dataset.choiceField }
          : null;
        const sheet = wrap.querySelector(".curriculum-imported-sheet");
        const scroll = [wrap.scrollTop, wrap.scrollLeft, sheet?.scrollTop || 0, sheet?.scrollLeft || 0];
        renderCurriculumStep();
        const nextSheet = wrap.querySelector(".curriculum-imported-sheet");
        [wrap.scrollTop, wrap.scrollLeft] = scroll;
        if (nextSheet) [nextSheet.scrollTop, nextSheet.scrollLeft] = scroll.slice(2);
        if (focusKey?.block) {
          const next = wrap.querySelector(`td[data-choice-block="${CSS.escape(focusKey.block)}"] input[data-choice-field="${focusKey.field}"]`);
          next?.focus({ preventScroll: true });
          next?.select?.();
        }
      }, 0);
    }
    $("#curriculumPlanWrap").addEventListener("click", (event) => {
      const jump = event.target.closest("[data-choice-block-jump]");
      if (!jump) return;
      const target = $(`#curriculumPlanWrap td[data-choice-block="${CSS.escape(jump.dataset.choiceBlockJump)}"]`);
      if (!target) return;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.querySelector("input")?.focus({ preventScroll: true });
    });
    $("#clearCurriculumPlan").addEventListener("click", () => {
      const planLabel = state.curriculumPlanType === "annual"
        ? `${state.curriculumCohortYear}학년도 전학년 편제표`
        : `${state.curriculumCohortYear}학년도 신입생 3개년 편제표`;
      if (!window.confirm(`${planLabel}를 초기화할까요? 다른 편제표와 신청 결과는 유지됩니다. 실행취소로 되돌릴 수 있습니다.`)) return;
      if (state.curriculumImportedLayout || state.curriculumPlan.length) recordCurriculumUndo();
      state.curriculumPlan = [];
      state.curriculumTemplateRows = [];
      state.curriculumPlanFileName = "";
      state.curriculumImportedLayout = null;
      state.curriculumPlanFilters = { grade: "", division: "", area: "", detail: "", query: "" };
      state.curriculumMutationRevision += 1;
      if (curriculumPlanInput) curriculumPlanInput.value = "";
      renderCurriculumStep();
      persistState();
      status.style.color = "#596780";
      status.textContent = "편제표를 초기화했습니다.";
    });
    $("#searchInput").addEventListener("input", () => { renderRoster(); renderPreview(); });
    function showFirstVisibleStudent() {
      const visible = visibleStudents();
      if (visible.length && !visible.some((student) => student.id === state.selectedId)) state.selectedId = visible[0].id;
      renderRoster();
      renderPreview();
    }
    $("#gradeFilter").addEventListener("change", () => {
      applyClassFilterOptions(state.students);
      showFirstVisibleStudent();
    });
    $("#classFilter").addEventListener("change", showFirstVisibleStudent);
    $("#studentList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-student-id]");
      if (!button) return;
      state.selectedId = button.dataset.studentId;
      renderRoster();
      renderPreview();
      persistState();
    });
    $("#printSelected").addEventListener("click", () => {
      const student = currentStudent();
      if (student) printStudents([student]);
    });
    $("#printAll").addEventListener("click", () => printStudents(visibleStudents()));
    $("#downloadAggregate").addEventListener("click", downloadAggregate);
    for (const selector of ["#openingPercent", "#divisionPercent"]) {
      $(selector).addEventListener("input", () => {
        renderAggregate();
        if (Number(state.workflowStep) === 4) renderClosurePanel(state.currentRound);
        persistState();
      });
    }
    $("#aggregateContent").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-aggregate-grade]");
      if (!tab) return;
      aggregateGradeScope = tab.dataset.aggregateGrade;
      renderAggregate();
    });
    $("#aggregateContent").addEventListener("change", (event) => {
      const input = event.target.closest(".aggregate-class-input");
      if (!input) return;
      if (typeof isRoundLocked === "function" && isRoundLocked(state.currentRound)) {
        renderAggregate();
        return;
      }
      const value = input.value === "" ? null : Number(input.value);
      if (value !== null && (!Number.isInteger(value) || value < 0)) {
        input.setCustomValidity("0 이상의 정수를 입력하세요.");
        input.reportValidity();
        input.setCustomValidity("");
        renderAggregate();
        return;
      }
      const key = `${input.dataset.grade}:${input.dataset.courseColumn}`;
      if (value === null) delete state.classOverrides[key];
      else state.classOverrides[key] = value;
      renderAggregate();
      persistState();
    });
    document.addEventListener("scroll", (event) => {
      const wrap = event.target.closest?.(".aggregate-sheet-wrap");
      if (!wrap) return;
      wrap.classList.toggle("is-scrolled-x", wrap.scrollLeft > 0);
      wrap.classList.toggle("is-scrolled-y", wrap.scrollTop > 0);
    }, true);
    $("#semesterClassifier").addEventListener("click", (event) => {
      const card = event.target.closest("[data-drag-course-column]");
      if (card) {
        const key = String(card.dataset.dragCourseColumn || "");
        applyCourseSelection(key, event);
        renderSemesterClassifier();
        return;
      }
      const addButton = event.target.closest('[data-action="add-group"]');
      if (addButton) {
        const input = $("#newGroupName");
        const nextName = normalizeGroupName(input?.value);
        if (!nextName || nextName === UNASSIGNED_GROUP) return;
        if (!state.customGroupNames.includes(nextName)) state.customGroupNames.push(nextName);
        if (input) input.value = "";
        renderSemesterClassifier();
        renderAggregate();
        persistState();
        return;
      }
      const removeButton = event.target.closest('[data-action="remove-group"]');
      if (!removeButton) return;
      const name = normalizeGroupName(removeButton.dataset.groupName);
      if (!name) return;
      state.customGroupNames = state.customGroupNames.filter((item) => item !== name);
      for (const [column, assigned] of Object.entries(state.groupAssignments)) {
        if (normalizeGroupName(assigned) === name) delete state.groupAssignments[column];
      }
      renderPreview();
      renderSemesterClassifier();
      renderAggregate();
      persistState();
    });
    $("#semesterClassifier").addEventListener("dragstart", (event) => {
      const card = event.target.closest("[data-drag-course-column]");
      if (!card) return;
      const courseColumn = String(card.dataset.dragCourseColumn || "");
      if (!courseColumn) return;
      const selected = new Set(state.selectedCourseColumns.map((value) => String(value)));
      if (!selected.has(courseColumn)) {
        selectCourseColumns([courseColumn], false);
        state.lastSelectedCourseColumn = courseColumn;
        renderSemesterClassifier();
      }
      card.classList.add("dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", courseColumn);
        if (typeof event.dataTransfer.setDragImage === "function") {
          const badge = document.createElement("div");
          const count = state.selectedCourseColumns.includes(courseColumn) ? state.selectedCourseColumns.length : 1;
          badge.className = "course-drag-image";
          badge.textContent = `${card.querySelector("span")?.textContent || "과목"}${count > 1 ? ` 외 ${count - 1}과목` : ""}`;
          document.body.appendChild(badge);
          event.dataTransfer.setDragImage(badge, 10, 10);
          setTimeout(() => badge.remove(), 250);
        }
      }
    });
    $("#semesterClassifier").addEventListener("dragend", (event) => {
      const card = event.target.closest("[data-drag-course-column]");
      if (card) card.classList.remove("dragging");
      for (const zone of document.querySelectorAll(".group-drop-zone.dragover")) {
        zone.classList.remove("dragover");
      }
    });
    $("#semesterClassifier").addEventListener("dragover", (event) => {
      const zone = event.target.closest("[data-drop-group]");
      if (!zone) return;
      event.preventDefault();
      zone.classList.add("dragover");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
    $("#semesterClassifier").addEventListener("dragleave", (event) => {
      const zone = event.target.closest("[data-drop-group]");
      if (!zone) return;
      const next = event.relatedTarget;
      if (next && zone.contains(next)) return;
      zone.classList.remove("dragover");
    });
    $("#semesterClassifier").addEventListener("drop", (event) => {
      const zone = event.target.closest("[data-drop-group]");
      if (!zone) return;
      event.preventDefault();
      zone.classList.remove("dragover");
      const targetGroup = normalizeGroupName(zone.dataset.dropGroup);
      if (!targetGroup) return;
      const dragged = document.querySelector(".group-course-card.dragging");
      const fromDragClass = dragged ? String(dragged.dataset.dragCourseColumn || "") : "";
      const fromTransfer = event.dataTransfer ? String(event.dataTransfer.getData("text/plain") || "") : "";
      const key = fromTransfer || fromDragClass;
      if (!key) return;
      const selectedKeys = state.selectedCourseColumns.map((value) => String(value));
      const movedKeys = selectedKeys.includes(key) ? selectedKeys : [key];
      for (const movedKey of movedKeys) {
        const course = state.courses.find((item) => String(item.column) === movedKey);
        if (!course) continue;
        if (targetGroup === UNASSIGNED_GROUP) delete state.groupAssignments[movedKey];
        else state.groupAssignments[movedKey] = targetGroup;
      }
      state.lastSelectedCourseColumn = key;
      renderPreview();
      renderSemesterClassifier();
      renderAggregate();
      persistState();
    });
    for (const selector of ["#schoolYear", "#round", "#confirmDate", "#schoolName"]) {
      $(selector).addEventListener("input", updateCertificateText);
    }
    $("#schoolYear").addEventListener("change", () => {
      const year = Number($("#schoolYear").value);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        status.style.color = "#a44939";
        status.textContent = "학년도는 2000~2100 사이의 정수로 입력하세요.";
        return;
      }
      const cohortYears = CURRICULUM_COHORT_GRADES.map((grade) => String(year - Number(grade) + 1));
      if (state.curriculumPlanType === "annual") {
        switchCurriculumAnnualPlan(String(year));
      } else if (!cohortYears.includes(String(state.curriculumCohortYear))) {
        switchCurriculumCohort(String(year));
      } else {
        renderCurriculumStep();
      }
      if (typeof switchApplicationMenuGrade === "function") switchApplicationMenuGrade(state.applicationMenuGrade || "1");
      persistState();
    });
    workflowSteps.addEventListener("click", (event) => {
      const button = event.target.closest("[data-workflow-step]");
      if (!button) return;
      switchWorkflowStep(button.dataset.workflowStep);
    });
    $("#applicationModeExternal").addEventListener("click", () => selectApplicationMode("external"));
    $("#applicationModeWeb").addEventListener("click", () => selectApplicationMode("web"));
    $("#workflowMenuToggle").addEventListener("click", () => {
      const button = $("#workflowMenuToggle");
      button.setAttribute("aria-expanded", String(button.getAttribute("aria-expanded") !== "true"));
    });
    $("#curriculumFilterToggle").addEventListener("click", () => {
      const button = $("#curriculumFilterToggle");
      scheduleCurriculumTableSize();
      const expanded = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(expanded));
      button.textContent = expanded ? "필터·검색 접기" : "필터·검색 펼치기";
    });
    $("#workspaceRound").addEventListener("change", (event) => switchRound(event.target.value));
    $("#workflowNextAction").addEventListener("click", (event) => {
      const next = event.currentTarget.dataset.nextStep;
      if (next === "upload") curriculumPlanInput.click();
      else if (next === "groups" || next === "online" || next === "results") openApplicationWorkspaceTab(next, true);
      else if (next.startsWith("focus:")) {
        const target = document.getElementById(next.slice(6));
        target?.scrollIntoView?.({ block: "center" });
        target?.focus?.();
      } else if (next.startsWith("cohort:")) {
        switchWorkflowStep("1");
        switchCurriculumCohort(next.slice(7));
      } else {
        if (next === "1" && Number(state.workflowStep) === 2) switchCurriculumCohort(applicationCohortYear());
        if (next === "2" && Number(state.workflowStep) === 1 && typeof switchApplicationMenuGrade === "function") {
          const currentGrade = Number($("#schoolYear").value) - Number(state.curriculumCohortYear) + 1;
          if (currentGrade === 1 || currentGrade === 2) switchApplicationMenuGrade(String(currentGrade));
        }
        switchWorkflowStep(next);
      }
    });
    $("#downloadWorkspaceBackup").addEventListener("click", downloadWorkspaceBackup);
    $("#resetWorkspaceAll").addEventListener("click", resetWorkspaceAll);
    document.addEventListener("click", (event) => {
      const menu = $("#workspaceDataMenu");
      if (!menu?.open) return;
      if (!menu.contains(event.target) || event.target.closest(".workspace-data-menu-items button, .workspace-data-menu-items label")) menu.open = false;
    });
    $("#restoreWorkspaceBackup").addEventListener("change", (event) => {
      restoreWorkspaceBackup(event.target.files[0]);
      event.target.value = "";
    });
    $("#retryWorkspaceSave").addEventListener("click", () => {
      if (statePersistenceBlocked) {
        if (!window.confirm("현재 화면의 미저장 변경 대신 브라우저 저장 원본을 다시 읽습니다. 필요한 자료를 먼저 백업했나요?")) return;
        statePersistenceSuppressed++;
        try {
          restorePersistedState();
          if (!statePersistenceBlocked && typeof switchApplicationMenuGrade === "function") {
            switchApplicationMenuGrade(state.applicationMenuGrade);
          }
        } finally {
          statePersistenceSuppressed--;
        }
      } else {
        persistState();
      }
    });
    $("#resumeWorkspaceSave").addEventListener("click", () => {
      if (!window.confirm("보호 중인 기존 저장 원본을 현재 화면의 자료로 교체합니다. 기존 자료가 사라질 수 있습니다. 작업 자료 백업을 먼저 내려받았나요?")) return;
      statePersistenceBlocked = false;
      try {
        lastSavedWorkspace = localStorage.getItem(STORAGE_KEY);
      } catch (error) {
        statePersistenceBlocked = true;
        updateWorkspaceSaveStatus(`저장 원본 읽기 실패: ${error.message}`, true);
        return;
      }
      if (persistState()) protectedStoredState = null;
      else {
        statePersistenceBlocked = true;
        updateWorkspaceSaveStatus("저장을 재개하지 못했습니다. 기존 원본 보호를 유지합니다.", true);
      }
    });
    $("#roundSelector").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-round]");
      if (!tab) return;
      switchRound(tab.dataset.round);
    });
    $("#addApplicationRound").addEventListener("click", () => {
      try {
        if (!requireLocalWorkspaceAccess()) return;
        addApplicationRound();
        status.style.color = "#287956";
        status.textContent = `${state.currentRound}를 추가했습니다.`;
      } catch (error) {
        status.style.color = "#a44939";
        status.textContent = error instanceof Error ? error.message : "차수를 추가하지 못했습니다.";
      }
    });
    $("#roundStatusList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-view-round]");
      if (!button) return;
      switchRound(button.dataset.viewRound);
    });
    $("#closureContent").addEventListener("change", (event) => {
      const select = event.target.closest("[data-closure-key]");
      if (!select) return;
      const round = select.dataset.closureRound;
      const key = select.dataset.closureKey;
      if (typeof isRoundLocked === "function" && isRoundLocked(round)) {
        renderClosurePanel(round);
        return;
      }
      if (!state.roundClosures[round]) state.roundClosures[round] = {};
      state.roundClosures[round][key] = select.value;
      persistState();
      renderAggregate();
      if (Number(state.workflowStep) === 4) renderRetakePanel();
      if (typeof updateRetakeReadiness === "function") updateRetakeReadiness();
    });
    $("#downloadRetakeList").addEventListener("click", downloadRetakeList);
    resetDataButton.addEventListener("click", () => {
      if (!requireLocalWorkspaceAccess()) return;
      if (typeof isRoundLocked === "function" && isRoundLocked(state.currentRound)) {
        status.style.color = "#a44939";
        status.textContent = `${state.currentRound}차는 확정된 차수입니다. 4단계에서 확정을 해제한 뒤 삭제하세요.`;
        return;
      }
      if (!window.confirm(`${state.currentRound}차의 명단·신청 결과·폐강 검토만 삭제할까요? 편제표와 다른 차수는 유지하며 서버 신청은 삭제하지 않습니다. 자동 연동은 해제됩니다.`)) return;
      try {
        if (typeof unlinkApplicationRound === "function") unlinkApplicationRound(state.currentRound);
        clearApplicationRound();
        status.style.color = "#596780";
        status.textContent = `${state.currentRound}차 데이터만 삭제했습니다. 편제표와 다른 차수는 유지됩니다.`;
      } catch (error) { status.textContent = `차수 삭제 실패: ${error.message}`; }
    });
    dropzone.addEventListener("dragover", (event) => { event.preventDefault(); dropzone.classList.add("dragover"); });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
    dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      dropzone.classList.remove("dragover");
      handleWorkbook(event.dataTransfer.files[0]);
    });
    window.addEventListener("afterprint", () => { $("#printBatch").innerHTML = ""; });
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY || event.newValue === lastSavedWorkspace || !statePersistenceReady) return;
      statePersistenceBlocked = true;
      protectedStoredState = event.newValue;
      updateWorkspaceSaveStatus("다른 창에서 자료가 변경되었습니다. 덮어쓰기를 막기 위해 자동 저장을 중지했습니다.", true);
    });
    window.addEventListener("beforeunload", (event) => {
      if (workspaceResetting || !statePersistenceReady) return;
      if (!statePersistenceBlocked) persistState();
      if (workspaceSaveFailed || statePersistenceBlocked ||
          (typeof getApplicationGroupStorageIssue === "function" && getApplicationGroupStorageIssue())) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && statePersistenceReady && statePersistenceTimer !== null) persistState();
    });
    document.addEventListener("keydown", (event) => {
      const label = event.target.closest('label[for][role="button"]');
      if (!label || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      const input = document.getElementById(label.htmlFor);
      if (input && !input.disabled) input.click();
    });
    window.addEventListener("hashchange", () => window.location.reload());
    const studentApplicationRoute = showStudentApplicationEntry();
    if (!studentApplicationRoute) {
      $("#teacherWorkspace").classList.remove("hidden");
      restorePersistedState();
      // 결과 검증·차수 확정·시수 통계 모듈은 app.js 다음에 로드되므로 모두 로드된 뒤 한 번 더 그린다.
      document.addEventListener("DOMContentLoaded", () => {
        refreshCurriculumDerivedPlans();
        renderAggregate();
        renderWorkflowLayout();
      }, { once: true });
    }
    statePersistenceReady = !studentApplicationRoute;
