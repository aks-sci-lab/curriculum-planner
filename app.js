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
      curriculumShowMarks: false,
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
      courseChecks: {},
      curriculumCompliance: {},
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
    // state가 바뀔 때마다(프록시 set/delete) 1씩 오른다. 같은 자료로 반복되는 계산은 이 값이 같을 때만 캐시를 쓴다.
    let stateRevision = 0;
    let stateViewOnlyDirty = false;
    const stateRevisionCaches = new Map();
    // 화면 위치만 바꾸는 값(단계·고른 학생·선택 칸 등)은 계산 결과를 바꾸지 않으므로 revision을 올리지 않는다(단계를 오갈 때 캐시가 살아 있게).
    // 캐시하는 계산이 이 값에 기대면 cachedByStateRevision의 key에 넣을 것.
    const STATE_VIEW_ONLY_KEYS = new Set(["workflowStep", "selectedId", "applicationMenuGrade", "curriculumTopCollapsed", "curriculumShowMarks",
      "curriculumSelectedRow", "curriculumSelectedColumn", "selectedCourseColumns", "lastSelectedCourseColumn"]);

    // 자료(state)·학년도가 그대로면 이전 계산 결과를 돌려준다. key에는 state 밖의 입력(학년도 칸 값, 인수)을 넣는다.
    // state를 거치지 않고 바꾸는 자료(예: localStorage의 선택 그룹)에 기대는 계산에는 쓰지 말 것. 강제로 비우려면 invalidateStateCaches().
    function cachedByStateRevision(name, key, compute) {
      let entry = stateRevisionCaches.get(name);
      if (!entry || entry.revision !== stateRevision) {
        entry = { revision: stateRevision, values: new Map() };
        stateRevisionCaches.set(name, entry);
      }
      const cacheKey = String(key);
      if (entry.values.has(cacheKey)) return entry.values.get(cacheKey);
      const value = compute();
      // 계산하는 동안 state가 바뀌었으면(정리용 쓰기 등) 바뀐 뒤의 자료로 다시 계산하도록 저장하지 않는다.
      if (entry.revision === stateRevision) entry.values.set(cacheKey, value);
      return value;
    }

    // 곧바로 저장하지 않고 200ms 뒤 한 번에 저장(여러 변경을 묶음). 창을 닫거나 숨길 때는 즉시 저장된다.
    // 4MB 자료를 매번 직렬화하면 100ms 넘게 걸리므로 화면 조작 처리기에서는 persistState() 대신 이것을 쓴다.
    function persistStateSoon({ viewOnly = false } = {}) {
      if (viewOnly) {
        stateViewOnlyDirty = true;
        return;
      }
      scheduleStatePersistence();
    }

    function invalidateStateCaches() {
      stateRevision++;
    }

    // 프록시를 벗긴 원래 객체. 읽기만 하는 큰 반복·JSON 직렬화에서 프록시 비용을 피할 때 쓴다(여기에 쓰면 저장이 예약되지 않는다).
    function stateRawValue(value) {
      return (value && typeof value === "object" && stateRawTargets.get(value)) || value;
    }

    // JSON.stringify(값, stateJsonReplacer): 안쪽에 섞인 프록시도 원래 객체로 바꿔 직렬화(4MB 자료에서 약 3배 빠름).
    function stateJsonReplacer(key, value) {
      return (value && typeof value === "object" && stateRawTargets.get(value)) || value;
    }

    function scheduleStatePersistence() {
      if (!statePersistenceReady || statePersistenceSuppressed || statePersistenceTimer !== null) return;
      statePersistenceTimer = window.setTimeout(() => {
        statePersistenceTimer = null;
        persistState();
      }, 200);
    }

    function observeState(value) {
      if (!value || typeof value !== "object") return value;
      // 자주 읽는 경로가 먼저: 이미 만든 프록시면 바로 돌려준다(학생·과목 반복에서 읽을 때마다 거치므로).
      const cached = stateProxyCache.get(value);
      if (cached) return cached;
      if (stateRawTargets.has(value)) return value;
      const prototype = Object.getPrototypeOf(value);
      if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
      const proxy = new Proxy(value, {
        get(target, property, receiver) {
          return observeState(Reflect.get(target, property, receiver));
        },
        set(target, property, nextValue, receiver) {
          const rawValue = stateRawTargets.get(nextValue) || nextValue;
          if (Object.is(target[property], rawValue)) return true;
          const updated = Reflect.set(target, property, rawValue, receiver);
          if (updated) {
            // 단계·고른 학생 같은 화면 위치만 바뀌면 4MB를 다시 저장하지 않고, 다음 저장·창 닫기·숨기기 때 함께 저장한다.
            if (target === rawState && STATE_VIEW_ONLY_KEYS.has(property)) stateViewOnlyDirty = true;
            else {
              stateRevision++;
              scheduleStatePersistence();
            }
          }
          return updated;
        },
        deleteProperty(target, property) {
          if (!Object.hasOwn(target, property)) return true;
          const deleted = Reflect.deleteProperty(target, property);
          if (deleted) {
            stateRevision++;
            scheduleStatePersistence();
          }
          return deleted;
        }
      });
      stateProxyCache.set(value, proxy);
      stateRawTargets.set(proxy, value);
      return proxy;
    }

    const state = observeState(rawState);
    const STORAGE_KEY = "course-certificate-studio-v1";
    // 사용자가 자료를 바꿔 이 브라우저에 저장한 시각. 연결된 PC 파일과 내용이 다를 때 확인 문구에 양쪽 시각을 보여 주는 데 쓴다.
    const WORKSPACE_SAVED_AT_KEY = "course-certificate-studio-saved-at";
    // 시작할 때 화면을 그리며 생긴 정리용 저장은 사용자 수정이 아니므로 저장 시각을 바꾸지 않는다.
    let workspaceStartupFlush = false;
    let statePersistenceBlocked = false;
    let protectedStoredState = null;
    let workspaceSaveFailed = false;
    let lastSavedWorkspace = null;
    // 새 저장소(IndexedDB, workspace-store.js) 상태. active: 이번 창이 새 저장소에 저장하는지(아니면 예전처럼 localStorage에 전체 자료)
    // rev: 마지막으로 읽거나 쓴 저장 번호(다른 창 충돌 확인) · known: 저장소에 있는 조각 · cache: 지난번 나눈 결과
    // lastCore: 마지막으로 저장(예약)한 본문 · pending/writing: 쓰기 대기·진행 · force: 다음 쓰기는 번호 확인 없이 모두 다시 씀(저장 재개)
    // migrate: 예전 localStorage 자료를 읽었으니 시작 후 옮김. 이때 lastSavedWorkspace는 localStorage의 작은 기록이다.
    const workspaceStoreState = { active: false, rev: "", known: new Set(), cache: new Map(), lastCore: null,
      pending: null, writing: null, force: false, migrate: false, boot: null };
    let resolveWorkspaceStartup = null;
    // 저장 자료를 모두 읽은 뒤(새 저장소 읽기·옮기기 포함) 풀린다. PC 파일 자동 저장은 이것을 기다린 뒤 파일과 비교한다.
    const workspaceStartupReady = new Promise((resolve) => { resolveWorkspaceStartup = resolve; });
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
        ? `${message}. 새로고침하거나 창을 닫기 전에 작업 자료를 백업하세요('백업 내려받기'). 원본 엑셀은 별도로 보관해야 합니다.`
        : "";
      $("#retryWorkspaceSave").classList.toggle("hidden", !failed);
      $("#workspaceFailureBackup")?.classList.toggle("hidden", !failed);
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
          courseChecks: state.courseChecks,
          curriculumCompliance: state.curriculumCompliance,
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
          curriculumShowMarks: Boolean(state.curriculumShowMarks),
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
          maxClassSize: $("#maxClassSize").value,
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
        // 화면 위치만 바뀐 값(stateViewOnlyDirty)도 이번 저장에 함께 들어간다.
        if (typeof stateViewOnlyDirty === "boolean") stateViewOnlyDirty = false;
        // 새 저장소(IndexedDB)를 쓰면 큰 자료는 그쪽에 조각별로, localStorage에는 작은 기록만 쓴다(workspace-store.js).
        // persistStateSoon(묶음 저장)도 200ms 뒤 여기를 거치므로 같은 저장 계층을 탄다.
        if (workspaceStoreState.active) return persistWorkspaceToStore(workspacePayload());
        const serialized = JSON.stringify(workspacePayload(), typeof stateJsonReplacer === "function" ? stateJsonReplacer : undefined);
        if (serialized !== lastSavedWorkspace) {
          const stored = localStorage.getItem(STORAGE_KEY);
          if (stored !== lastSavedWorkspace) {
            statePersistenceBlocked = true;
            protectedStoredState = stored;
            throw new Error("다른 창의 저장 자료가 변경되어 덮어쓰기를 중지했습니다.");
          }
          try {
            localStorage.setItem(STORAGE_KEY, serialized);
          } catch (storageError) {
            // 브라우저 저장소가 가득 차도 연결된 PC 파일에는 지금 자료를 저장해 둔다.
            const fileName = typeof scheduleWorkspaceFileSave === "function" ? scheduleWorkspaceFileSave() : "";
            const reason = storageError?.name === "QuotaExceededError" || /quota/i.test(storageError?.message || "")
              ? "브라우저 저장 공간이 부족합니다(용량 초과)"
              : storageError?.message || "브라우저 저장소에 쓰지 못했습니다";
            throw new Error(fileName ? `${reason} · PC 파일 '${fileName}'에는 저장을 시도합니다` : reason);
          }
          lastSavedWorkspace = serialized;
          if (!workspaceStartupFlush) {
            try { localStorage.setItem(WORKSPACE_SAVED_AT_KEY, String(Date.now())); } catch { /* 시각 기록은 비교용이므로 실패해도 자료 저장은 유효하다. */ }
          }
          if (typeof scheduleWorkspaceFileSave === "function") scheduleWorkspaceFileSave();
        }
        updateWorkspaceSaveStatus("이 브라우저에 저장 완료");
        return true;
      } catch (error) {
        updateWorkspaceSaveStatus(`자동 저장 실패: ${error.message}`, true);
        return false;
      }
    }

    // ---- 새 저장소(IndexedDB, workspace-store.js) 연결 ----
    function readWorkspaceRecord() {
      try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
    }

    // localStorage에 작은 기록을 쓴다. 예전 큰 자료가 차 있어 쓰지 못하면 지우고 다시 쓴다. 실패해도 자료는 IndexedDB에 있다.
    function writeWorkspaceStoreRecord(record) {
      try {
        localStorage.setItem(STORAGE_KEY, record);
      } catch {
        try { localStorage.removeItem(STORAGE_KEY); localStorage.setItem(STORAGE_KEY, record); } catch { /* 다른 창 알림만 늦어진다. */ }
      }
      lastSavedWorkspace = readWorkspaceRecord();
    }

    function workspaceStoreFailureReason(error) {
      return error?.name === "QuotaExceededError" || /quota/i.test(error?.message || "")
        ? "브라우저 저장 공간이 부족합니다(용량 초과)"
        : error?.message || "브라우저 저장소에 쓰지 못했습니다";
    }

    // persistState가 저장의 단일 진입점이다(묶음 저장도 결국 persistState를 부른다). 직렬화 규칙(stateJsonReplacer)이 있으면 그대로 따른다.
    function persistWorkspaceToStore(payload) {
      const replacer = typeof stateJsonReplacer === "function" ? stateJsonReplacer : undefined;
      const split = workspaceStoreSplit(payload, workspaceStoreState.cache, replacer);
      if (split.core === workspaceStoreState.lastCore) {
        if (!workspaceStoreState.writing && !workspaceSaveFailed) updateWorkspaceSaveStatus("이 브라우저에 저장 완료");
        return true;
      }
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!workspaceStoreState.force && stored !== lastSavedWorkspace) {
        statePersistenceBlocked = true;
        protectedStoredState = stored;
        throw new Error("다른 창의 저장 자료가 변경되어 덮어쓰기를 중지했습니다.");
      }
      workspaceStoreState.cache = split.cache;
      workspaceStoreState.lastCore = split.core;
      workspaceStoreState.pending = { split, startupFlush: workspaceStartupFlush };
      if (!workspaceStoreState.writing) {
        workspaceStoreState.writing = flushWorkspaceStore().finally(() => { workspaceStoreState.writing = null; });
      }
      return true;
    }

    // 예약된 저장을 차례로 IndexedDB에 쓴다. 쓰는 동안 또 바뀌면 마지막 것만 이어서 쓴다.
    async function flushWorkspaceStore() {
      while (workspaceStoreState.pending) {
        const job = workspaceStoreState.pending;
        workspaceStoreState.pending = null;
        try {
          const result = await workspaceStoreWrite(job.split, {
            expectedRev: workspaceStoreState.rev, known: workspaceStoreState.known, force: workspaceStoreState.force
          });
          workspaceStoreState.force = false;
          workspaceStoreState.rev = result.rev;
          workspaceStoreState.known = result.known;
          writeWorkspaceStoreRecord(workspaceStoreRecord(job.split.core, result.rev, result.savedAt));
          if (!job.startupFlush) {
            try { localStorage.setItem(WORKSPACE_SAVED_AT_KEY, String(Date.now())); } catch { /* 시각 기록은 비교용이다. */ }
          }
          if (typeof scheduleWorkspaceFileSave === "function") scheduleWorkspaceFileSave();
          if (!workspaceStoreState.pending) {
            updateWorkspaceSaveStatus("이 브라우저에 저장 완료");
            renderWorkspaceStorageUsage();
          }
        } catch (error) {
          workspaceStoreState.pending = null;
          workspaceStoreState.lastCore = null;
          if (error?.name === "WorkspaceStoreConflict") {
            statePersistenceBlocked = true;
            protectedStoredState = readWorkspaceRecord();
            updateWorkspaceSaveStatus(`자동 저장 실패: ${error.message}`, true);
          } else {
            // 브라우저 저장소가 가득 차도 연결된 PC 파일에는 지금 자료를 저장해 둔다.
            const fileName = typeof scheduleWorkspaceFileSave === "function" ? scheduleWorkspaceFileSave() : "";
            const reason = workspaceStoreFailureReason(error);
            updateWorkspaceSaveStatus(`자동 저장 실패: ${fileName ? `${reason} · PC 파일 '${fileName}'에는 저장을 시도합니다` : reason}`, true);
            renderWorkspaceStorageUsage();
          }
          return false;
        }
      }
      return true;
    }

    function workspaceStoreBusy() {
      return Boolean(workspaceStoreState.writing || workspaceStoreState.pending);
    }

    // 시작할 때 저장 자료를 어디서 읽을지 정한다. null이면 예전처럼 localStorage 전체 자료를 바로 읽는다
    // (그 자료는 시작이 끝난 뒤 새 저장소로 옮긴다). 아니면 IndexedDB를 읽기 시작하고, 읽는 동안 화면을 맞출 작은 설정을 돌려준다.
    function beginWorkspaceStoreBoot() {
      if (typeof workspaceStoreSupported !== "function" || !workspaceStoreSupported()) return null;
      let raw;
      try { raw = localStorage.getItem(STORAGE_KEY); } catch { return null; }
      const record = workspaceStoreParseRecord(raw);
      if (raw && !record) {
        workspaceStoreState.migrate = true;
        return null;
      }
      workspaceStoreState.boot = workspaceStoreRead();
      workspaceStoreState.boot.catch(() => {});
      let settingsRaw;
      try { settingsRaw = record ? workspaceStoreSettingsRaw(record.core) : undefined; } catch { settingsRaw = undefined; }
      return { record: raw, settingsRaw };
    }

    // IndexedDB에서 읽은 자료로 화면을 다시 만든다. 성공하면 true(검증 실패면 원본 보호 상태가 된다).
    // hold: 시작할 때처럼 곧이어 renderWorkflowLayout이 그리면 복원 중 단계 그리기를 미룬다(view-keep.js holdStepRenders).
    function applyStoredWorkspace(loaded, { hold = false } = {}) {
      statePersistenceSuppressed++;
      // 복원하며 그리는 동안 선택 그룹 등이 '원본 보호 중'으로 막히지 않게 한다(저장 예약은 statePersistenceSuppressed가 막는다).
      statePersistenceReady = true;
      statePersistenceBlocked = false;
      try {
        // 선택 그룹은 저장 자료를 읽기 전(빈 편제표)에 정리됐을 수 있어 이 학년도 설정을 먼저 다시 읽는다.
        if (typeof reloadApplicationGroupData === "function") reloadApplicationGroupData(false);
        const restore = () => restorePersistedState(loaded.raw);
        if (hold && typeof holdStepRenders === "function") holdStepRenders(restore);
        else restore();
        if (!statePersistenceBlocked && typeof switchApplicationMenuGrade === "function") switchApplicationMenuGrade(state.applicationMenuGrade);
      } finally {
        statePersistenceSuppressed--;
      }
      if (statePersistenceBlocked) return false;
      workspaceStoreState.active = true;
      workspaceStoreState.rev = loaded.rev;
      workspaceStoreState.known = loaded.known;
      workspaceStoreState.lastCore = loaded.core;
      const record = workspaceStoreParseRecord(readWorkspaceRecord());
      if (record?.workspaceStore?.rev !== loaded.rev) writeWorkspaceStoreRecord(workspaceStoreRecord(loaded.core, loaded.rev, loaded.savedAt));
      else lastSavedWorkspace = readWorkspaceRecord();
      return true;
    }

    async function completeWorkspaceStoreBoot(boot) {
      let loaded = null;
      let failure = null;
      try { loaded = await workspaceStoreState.boot; } catch (error) { failure = error; }
      workspaceStoreState.boot = null;
      // 다른 모듈의 시작 처리(DOMContentLoaded)가 모두 끝난 뒤 자료를 넣는다.
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      if (failure && !boot.record) {
        // 저장한 적이 없는데 IndexedDB를 열 수 없는 브라우저(사생활 보호 창 등): 예전처럼 localStorage에 저장한다.
        updateWorkspaceSaveStatus("이 브라우저에 저장 완료");
        return;
      }
      if (failure || (!loaded && boot.record)) {
        statePersistenceBlocked = true;
        protectedStoredState = boot.record;
        const reason = failure ? failure.message
          : "새 저장소(IndexedDB)에서 작업 자료를 찾지 못했습니다. 브라우저의 사이트 데이터가 지워졌을 수 있습니다. 백업 파일이나 PC 파일에서 불러오세요";
        updateWorkspaceSaveStatus(`복원 실패 · 기존 저장 원본 보호 중: ${reason}`, true);
        return;
      }
      workspaceStoreState.active = true;
      if (!loaded) {
        // 처음 쓰는 브라우저(또는 전체 초기화 직후): 빈 자료로 시작한다.
        workspaceStoreState.rev = "";
        lastSavedWorkspace = readWorkspaceRecord();
        updateWorkspaceSaveStatus("이 브라우저에 저장 완료");
        return;
      }
      applyStoredWorkspace(loaded, { hold: true });
    }

    // 저장·복원 재시도: 이 창의 미저장 변경 대신 새 저장소의 자료를 다시 읽는다.
    async function reloadWorkspaceFromStore() {
      let loaded;
      try {
        loaded = await workspaceStoreRead();
      } catch (error) {
        updateWorkspaceSaveStatus(`저장 원본 읽기 실패: ${error.message}`, true);
        return false;
      }
      if (!loaded) {
        updateWorkspaceSaveStatus("저장 원본 읽기 실패: 새 저장소에 작업 자료가 없습니다", true);
        return false;
      }
      return applyStoredWorkspace(loaded);
    }

    // 예전 localStorage 자료를 새 저장소로 옮긴다. IndexedDB에 다 쓰고 다시 읽어 같은지 확인한 뒤에만 localStorage의 큰 자료를 작은 기록으로 바꾼다.
    async function migrateLegacyWorkspace() {
      workspaceStoreState.migrate = false;
      if (statePersistenceBlocked || typeof workspaceStoreWrite !== "function") return false;
      const localBefore = (readWorkspaceRecord() || "").length;
      if (statePersistenceTimer !== null) {
        window.clearTimeout(statePersistenceTimer);
        statePersistenceTimer = null;
      }
      let payload;
      statePersistenceSuppressed++;
      try {
        syncActiveRound();
        syncActiveCurriculumCohort();
        payload = workspacePayload();
      } finally {
        statePersistenceSuppressed--;
      }
      const replacer = typeof stateJsonReplacer === "function" ? stateJsonReplacer : undefined;
      const expected = JSON.stringify(payload, replacer);
      try {
        const split = workspaceStoreSplit(payload, new Map(), replacer);
        const result = await workspaceStoreWrite(split, { force: true });
        const check = await workspaceStoreRead();
        if (check?.raw !== expected) throw new Error("옮긴 자료를 다시 읽어 보니 원래 자료와 달랐습니다");
        if (statePersistenceBlocked) return false;
        workspaceStoreState.active = true;
        workspaceStoreState.rev = result.rev;
        workspaceStoreState.known = result.known;
        workspaceStoreState.cache = split.cache;
        workspaceStoreState.lastCore = split.core;
        writeWorkspaceStoreRecord(workspaceStoreRecord(split.core, result.rev, result.savedAt));
      } catch (error) {
        workspaceStoreState.active = false;
        showAppToast(`작업 자료를 새 저장소로 옮기지 못했습니다(${workspaceStoreFailureReason(error)}). 예전 저장 자료는 그대로 둡니다. 백업 파일을 받아 두세요.`, "error");
        return false;
      }
      // 옮기는 동안 바뀐 내용이 있으면 이어서 저장한다.
      persistState();
      // 예전 저장소가 거의 찼다면 마지막 변경 일부가 저장되지 못했을 수 있다(용량 초과로 메모리에만 있던 자료).
      if (localBefore >= WORKSPACE_LOCAL_LIMIT * 0.85) {
        status.style.color = "#a44939";
        status.textContent = "브라우저에 마지막으로 저장된 자료를 새 저장소로 옮겼습니다. 업데이트 전에 '자동 저장 실패(용량 초과)'가 났다면 그 뒤의 작업은 빠져 있을 수 있으니, 그때 받은 백업 파일이나 PC 자동 저장 파일을 '자료 관리 ▾'에서 불러오세요.";
      }
      showAppToast("작업 자료를 새 저장소(IndexedDB)로 옮겼습니다. 이제 용량 걱정 없이 저장됩니다.");
      return true;
    }

    // 시작할 때 첫 화면을 그린 뒤 쉬는 시간에 할 일(정리용 저장·옮기기·원본 재변환·캐시 미리 계산).
    function afterWorkspaceFirstPaint(task) {
      if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(task, { timeout: 1500 });
      else window.setTimeout(task, 300);
    }

    // 시작 마무리: 다른 모듈이 모두 로드된 뒤 한 번 더 그리고, 새 저장소 읽기·옮기기를 끝낸다.
    async function finishWorkspaceStartup(boot) {
      try {
        if (boot) await completeWorkspaceStoreBoot(boot);
        if (boot) {
          $("#teacherWorkspace").inert = false;
          $("#teacherWorkspace").removeAttribute("aria-busy");
        }
        refreshCurriculumDerivedPlans();
        // 보이는 단계만 그린다(집계는 4단계일 때 renderWorkflowLayout이 그림). 첫 화면이라 스크롤 보존은 건너뜀.
        if (typeof withoutViewKeep === "function") withoutViewKeep(renderWorkflowLayout);
        else renderWorkflowLayout();
        if (boot) statePersistenceReady = true;
        if (workspaceStoreState.migrate) {
          // 예전 localStorage 자료를 새 저장소로 옮기기(4MB 직렬화·비교)는 첫 화면을 그린 뒤에 한다.
          await new Promise((resolve) => afterWorkspaceFirstPaint(resolve));
          await migrateLegacyWorkspace();
        } else if (statePersistenceTimer !== null) {
          // 예약된 200ms 저장 대신 첫 화면 뒤에 '시작 정리용'으로 한 번 저장한다(저장 시각은 바꾸지 않음).
          window.clearTimeout(statePersistenceTimer);
          statePersistenceTimer = null;
          let userChanged = false;
          const markUserChange = () => { userChanged = true; };
          for (const type of ["input", "change", "drop"]) document.addEventListener(type, markUserChange, { capture: true, once: true });
          afterWorkspaceFirstPaint(() => {
            for (const type of ["input", "change", "drop"]) document.removeEventListener(type, markUserChange, { capture: true });
            // 그 사이 사용자가 고쳤으면 보통 저장(저장 시각 갱신)이 이미 예약·실행되었으므로 시작 정리용 표시를 붙이지 않는다.
            if (userChanged) { if (statePersistenceTimer !== null) persistState(); return; }
            workspaceStartupFlush = true;
            try { persistState(); } finally { workspaceStartupFlush = false; }
          });
        }
        // 다른 단계를 처음 열 때 걸리는 큰 계산(위계 점검·신청 과목)을 쉬는 시간에 미리 해 둔다(같은 자료면 캐시를 씀).
        afterWorkspaceFirstPaint(() => warmWorkflowCaches(afterWorkspaceFirstPaint));
        // 예전 변환기로 만든 편제표는 보관된 원본 엑셀을 새 변환기로 다시 읽는다(curriculum-reconvert.js). 변환기 버전이 낮을 때만 돈다.
        if (typeof reconvertCurriculumOriginals === "function") afterWorkspaceFirstPaint(() => reconvertCurriculumOriginals({ startup: true }).catch(() => {}));
        afterWorkspaceFirstPaint(() => renderWorkspaceStorageUsage());
      } finally {
        resolveWorkspaceStartup?.();
      }
    }

    // 자료 관리 메뉴의 저장 공간 사용량(navigator.storage.estimate). 80%를 넘으면 미리 알린다.
    let workspaceStorageUsageAt = 0;
    let workspaceStorageWarned = false;
    async function renderWorkspaceStorageUsage(force = false) {
      const label = document.getElementById("workspaceStorageUsage");
      if (!label || typeof workspaceStorageEstimate !== "function") return;
      if (!force && Date.now() - workspaceStorageUsageAt < 5000) return;
      workspaceStorageUsageAt = Date.now();
      const usage = workspaceStorageUsageText(await workspaceStorageEstimate());
      const where = workspaceStoreState.active ? "새 저장소(IndexedDB)에 저장 중" : "기본 저장소(localStorage)에 저장 중";
      label.textContent = `${usage.text} · ${where}${usage.warn ? " · 80%를 넘었습니다. 백업을 받아 두세요" : ""}`;
      label.classList.toggle("is-warning", usage.warn);
      if (usage.warn && !workspaceStorageWarned) {
        workspaceStorageWarned = true;
        showAppToast("브라우저 저장 공간을 80% 넘게 쓰고 있습니다. '자료 관리 ▾ → 파일로 백업하기'로 백업을 받아 두세요.", "error");
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
    function workspaceBrowserSavedAt() {
      try {
        const value = Number(localStorage.getItem(WORKSPACE_SAVED_AT_KEY));
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
      const linkedFile = typeof workspaceFileHandle !== "undefined" && workspaceFileHandle ? `'${workspaceFileHandle.name}' ` : "";
      if (!window.confirm("모든 작업 자료를 이 브라우저에서 삭제합니다.\n\n· 편제표(입학생별·전학년)와 변경 이력, 보관된 원본 엑셀\n· 모든 차수의 신청 결과·개설/폐강 결정·확정 상태\n· 선택 그룹 설정과 학교·학년도 설정\n" +
        `· PC 파일 자동 저장 연결 ${linkedFile}— 연결된 PC 파일은 지우지 않고 연결만 끊습니다\n\n되돌릴 수 없습니다. 계속할까요?`)) return;
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
        // 빈 자료가 연결된 PC 파일에 저장되지 않도록 먼저 연결을 끊는다(파일 자체는 지우지 않는다).
        if (typeof disconnectWorkspaceFile === "function") await disconnectWorkspaceFile();
        // 새 저장소(IndexedDB)에 쓰던 것이 끝나기를 기다린 뒤 연결을 닫고 함께 지운다.
        if (typeof workspaceStoreState !== "undefined") await workspaceStoreState.writing?.catch(() => {});
        if (typeof workspaceStoreClose === "function") await workspaceStoreClose();
        clearWorkspaceStorage();
        for (const name of ["curriculum-workspace-file", "curriculum-original-workbooks", "curriculum-workspace-db"]) {
          await new Promise((resolve) => {
            if (typeof indexedDB === "undefined") { resolve(); return; }
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = request.onerror = request.onblocked = () => resolve();
          });
        }
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
    // confirmed: 호출한 쪽에서 이미 교체 확인을 받았을 때(PC 파일이 바뀌어 불러올 때) 확인 창을 다시 띄우지 않는다.
    async function restoreWorkspaceBackup(file, afterWrite = null, { confirmed = false } = {}) {
      if (!file) return false;
      const previous = new Map();
      const written = [];
      let storeReplaced = false;
      let blockedBeforeStore = null;
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
        if (!confirmed && !window.confirm("백업에 포함된 편제표·차수·선택 그룹으로 이 브라우저의 자료를 교체합니다. 현재 자료를 먼저 백업했나요? 온라인 서버 자료는 변경하지 않습니다. 원본 엑셀은 별도로 보관해야 합니다.")) return false;
        entries.push([WORKSPACE_SAVED_AT_KEY, String(Date.now())]);
        // 새 저장소를 쓰면 작업 자료는 IndexedDB에 통째로 바꿔 쓰고(한 번에), localStorage에는 그룹 설정과 작은 기록만 쓴다.
        const useStore = typeof workspaceStoreState !== "undefined" && workspaceStoreState.active;
        if (useStore) entries.shift();
        for (const [key] of entries) previous.set(key, localStorage.getItem(key));
        for (const [key, value] of entries) {
          localStorage.setItem(key, value);
          written.push(key);
        }
        if (useStore) {
          // 바꿔 쓰는 동안 이 창의 자동 저장이 백업 자료를 덮어쓰지 않게 멈춘다(실패하면 아래에서 되돌린다).
          blockedBeforeStore = statePersistenceBlocked;
          statePersistenceBlocked = true;
          workspaceStoreState.pending = null;
          await workspaceStoreState.writing?.catch(() => {});
          const split = workspaceStoreSplit(backup.workspace);
          const result = await workspaceStoreWrite(split, { force: true });
          // 작업 자료는 이미 바뀌었으므로 이 뒤의 실패는 그룹 설정만 되돌리지 않고 그대로 다시 연다.
          storeReplaced = true;
          workspaceStoreState.rev = result.rev;
          writeWorkspaceStoreRecord(workspaceStoreRecord(split.core, result.rev, result.savedAt));
        }
        if (afterWrite) await afterWrite();
        statePersistenceReady = false;
        statePersistenceBlocked = true;
        if (statePersistenceTimer !== null) window.clearTimeout(statePersistenceTimer);
        window.location.reload();
        return true;
      } catch (error) {
        if (storeReplaced) {
          statePersistenceReady = false;
          statePersistenceBlocked = true;
          showAppToast(`백업 자료는 불러왔지만 마무리하지 못했습니다: ${error.message}`, "error");
          window.location.reload();
          return true;
        }
        if (blockedBeforeStore !== null) statePersistenceBlocked = blockedBeforeStore;
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
        return false;
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
      // 다른 단계에서 막 들어올 때는 지킬 스크롤·포커스가 없으므로 보존 도우미를 건너뛴다(view-keep.js).
      if (typeof workflowStepEntering === "function" && workflowStepEntering(step) && typeof withoutViewKeep === "function") {
        return withoutViewKeep(() => renderWorkflowLayoutSteps(step));
      }
      return renderWorkflowLayoutSteps(step);
    }

    function renderWorkflowLayoutSteps(step) {
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
      $("#retakePanel").classList.toggle("hidden", step !== 4);
      $("#roundComparePanel").classList.toggle("hidden", step !== 4);
      $("#classifierPanel").classList.toggle("hidden", step !== 5);
      if (step === 4) {
        renderAggregate();
        renderRetakePanel();
        if (typeof renderRoundCompare === "function") renderRoundCompare();
      }
      if (step === 7 && typeof renderHoursStats === "function") renderHoursStats();
      // 3단계에 들어오면 목록의 첫 학생 확인서를 바로 보여 준다(이미 고른 학생이 목록에 있으면 그대로).
      if (step === 3 && typeof showFirstVisibleStudent === "function") showFirstVisibleStudent();
      // 안 보일 때 미뤄 둔 이 단계의 그리기(view-keep.js). 위에서 직접 그린 것은 이미 빠져 있다.
      if (typeof flushDeferredStepRenders === "function") flushDeferredStepRenders(step);
      if (typeof renderRoundStatusControls === "function") renderRoundStatusControls();
      if (typeof syncNextYearClassInputs === "function") syncNextYearClassInputs();
      renderWorkspaceContext();
      $("#workflowMenuToggle").textContent = `단계 선택 · ${workflowStepLabel(state.workflowStep)}`;
    }

    // 첫 화면 뒤 쉬는 시간에 단계별 큰 계산을 하나씩 미리 해 둔다(캐시). 실패해도 화면에는 영향이 없다.
    function warmWorkflowCaches(schedule) {
      const tasks = [
        () => { if (state.students.length && typeof courseCheckFlags === "function") courseCheckFlags(state.students); },
        () => { for (const grade of ["1", "2"]) collectApplicationSubjects({ includeExcluded: true, currentGrade: grade }); },
        () => { collectApplicationSubjects(); }
      ];
      const next = () => {
        const task = tasks.shift();
        if (!task) return;
        try { task(); } catch { /* 미리 계산은 선택 사항 */ }
        if (tasks.length) schedule(next);
      };
      schedule(next);
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
      if (!skipPersist) {
        // 단계 이동은 화면 위치만 바꾸므로 다음 저장·창 닫기 때 함께 저장한다(persistStateSoon viewOnly).
        if (typeof persistStateSoon === "function") persistStateSoon({ viewOnly: true });
        else persistState();
      }
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
      const gradeNote = document.getElementById("resultGradeNote");
      if (gradeNote) gradeNote.textContent = `파일의 학년은 현재 학년입니다(현 ${grade}학년 → ${Number(grade) + 1}학년 과목 신청). 이 탭에는 학년 열이 ${grade}인 결과를 올립니다.`;
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
          message.textContent = `신청 과목 ${preparation.subjects}개 · 그룹 준비 완료. 외부 프로그램에서 받은 현 ${grade}학년(${Number(grade) + 1}학년 과목 신청) ${state.currentRound}차 결과 엑셀을 업로드하세요. 파일의 학년 열은 현재 학년(${grade})입니다.`;
          action.textContent = "결과 엑셀 업로드";
          action.dataset.nextStep = "results";
        } else {
          message.textContent = `${state.currentRound}차 현 ${grade}학년(${Number(grade) + 1}학년 과목 신청) 결과 ${gradeStudents}명 반영됨. 4단계에서 집계를 확인하고 개설 여부를 확정하세요.`;
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
      $("#fileName").textContent = resultFileNameLabel(data);
      applyClassFilterOptions(state.students);
      renderRoster();
      renderPreview();
      renderSemesterClassifier();
      renderAggregate();
      renderRoundStatus();
      if (!skipRender) renderWorkflowLayout();
      persistState();
    }

    // 결과 파일명 줄: 학년별로 "현 1학년: 파일명 / 현 2학년: 업로드 없음". 온라인 연동처럼 학년별 파일이 없는 자료는 저장된 이름을 그대로 쓴다.
    function resultFileNameLabel(data) {
      const gradeFiles = data?.gradeFiles && typeof data.gradeFiles === "object" ? data.gradeFiles : {};
      if (!Object.keys(gradeFiles).length && data?.fileName) return data.fileName;
      return ["1", "2"].map((grade) => `현 ${grade}학년: ${gradeFiles[grade] || "업로드 없음"}`).join(" / ");
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
      $("#fileName").textContent = "현 1학년: 업로드 없음 / 현 2학년: 업로드 없음";
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
      state.courseChecks = {};
      state.curriculumCompliance = {};
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
      $("#fileName").textContent = "현 1학년: 업로드 없음 / 현 2학년: 업로드 없음";
      $("#round").value = "1차";
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

    // storedRaw: 새 저장소(IndexedDB)에서 읽은 작업 자료 JSON. 없으면 예전처럼 localStorage의 자료를 읽는다.
    function restorePersistedState(storedRaw) {
      let raw = null;
      try {
        raw = storedRaw === undefined ? localStorage.getItem(STORAGE_KEY) : storedRaw;
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
        // 예전 저장분(백업 포함)의 학생 점검 쪽 교과(군) 필수 학점(courseChecks.required)은 편제 점검 기준 설정으로 한 번 옮긴다.
        if (typeof courseCheckMigrateRequired === "function") {
          const migrated = courseCheckMigrateRequired(saved.courseChecks, saved.curriculumCompliance);
          saved.courseChecks = migrated.courseChecks;
          saved.curriculumCompliance = migrated.compliance;
        }
        // 위계·이수학점 점검 설정(규칙·이전 학년 결과). 예전 저장분에는 없고, 예전 '저장 막기' 값은 버린다.
        state.courseChecks = typeof courseCheckNormalizeSettings === "function"
          ? courseCheckNormalizeSettings(saved.courseChecks) : plainObject(saved.courseChecks) ? saved.courseChecks : {};
        // 1단계 편제 점검표(기준값·편제표별 인정 오류·자체 점검). 예전 저장분에는 없다.
        state.curriculumCompliance = typeof planComplianceNormalizeState === "function"
          ? planComplianceNormalizeState(saved.curriculumCompliance) : plainObject(saved.curriculumCompliance) ? saved.curriculumCompliance : {};
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
        state.curriculumShowMarks = saved.curriculumShowMarks === true;
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

        $("#fileName").textContent = typeof resultFileNameLabel === "function"
          ? resultFileNameLabel(activeRound)
          : state.fileName || "현 1학년: 업로드 없음 / 현 2학년: 업로드 없음";
        $("#openingPercent").value = saved.openingPercent || "90";
        $("#divisionPercent").value = saved.divisionPercent || "110";
        // 반별 최대 인원은 나중에 추가된 값이라 이전 저장 자료·백업에는 없다. 없으면 34명.
        $("#maxClassSize").value = saved.maxClassSize || "34";
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
        renderSemesterClassifier();
        // 편제표(1단계)·집계(4단계)는 renderWorkflowLayout이 보이는 단계만 그리고, 나머지는 그 단계를 열 때 그린다.
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
      // state 안의 편제표는 병합 칸 → 색 표를 한 번 만들어 조회한다(칸마다 병합 목록 전체를 다시 훑으면 제곱으로 느려짐).
      const index = typeof curriculumMergedFillIndex === "function" ? curriculumMergedFillIndex(layout) : null;
      if (index) return index.get(`${row}:${column}`) || "";
      for (const ref of layout.mergedRanges || []) {
        const [a,b=a] = ref.split(":");
        const r1=Number(a.match(/\d+/)[0])-1, r2=Number(b.match(/\d+/)[0])-1;
        const c1=columnIndex(a),c2=columnIndex(b);
        if (row>=r1 && row<=r2 && column>=c1 && column<=c2) return layout.cellFills?.[`${r1}:${c1}`] || "";
      }
      return "";
    }

    // 병합 칸마다 그 병합의 왼쪽 위 칸 색. state를 거쳐 읽은 편제표만(바뀌면 stateRevision이 올라 다시 만든다).
    const curriculumMergedFillIndexes = new WeakMap();
    function curriculumMergedFillIndex(layout) {
      if (typeof stateRawTargets === "undefined" || typeof stateRevision !== "number" || !stateRawTargets.has(layout)) return null;
      const raw = stateRawTargets.get(layout);
      const merged = raw.mergedRanges || [];
      const cached = curriculumMergedFillIndexes.get(raw);
      if (cached && cached.revision === stateRevision && cached.merged === merged && cached.length === merged.length && cached.fills === raw.cellFills) return cached.map;
      const map = new Map();
      let cells = 0;
      for (const ref of merged) {
        const [a, b = a] = String(ref).split(":");
        const r1 = Number(a.match(/\d+/)?.[0]) - 1, r2 = Number(b.match(/\d+/)?.[0]) - 1;
        const c1 = columnIndex(a), c2 = columnIndex(b);
        if (![r1, r2, c1, c2].every(Number.isInteger)) continue;
        cells += Math.max(0, r2 - r1 + 1) * Math.max(0, c2 - c1 + 1);
        if (cells > 200000) return null;
        const fill = raw.cellFills?.[`${r1}:${c1}`] || "";
        for (let r = r1; r <= r2; r++) {
          for (let c = c1; c <= c2; c++) {
            const key = `${r}:${c}`;
            if (!map.has(key)) map.set(key, fill);
          }
        }
      }
      curriculumMergedFillIndexes.set(raw, { revision: stateRevision, merged, length: merged.length, fills: raw.cellFills, map });
      return map;
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

    // classifyApplicationRecords의 "2학년 물리학" 목록을 "2학년 과목(현 1학년 신청) 물리학, …"처럼 학년별로 묶는다.
    function describeUnclassifiedCourses(list) {
      const byGrade = new Map();
      for (const item of list || []) {
        const match = String(item).match(/^(\d+)학년\s+(.+)$/);
        const key = match ? match[1] : "";
        if (!byGrade.has(key)) byGrade.set(key, []);
        byGrade.get(key).push(match ? match[2] : String(item));
      }
      return [...byGrade].map(([grade, names]) => grade && Number(grade) > 1
        ? `${grade}학년 과목(현 ${Number(grade) - 1}학년 신청) ${names.join(", ")}`
        : names.join(", ")).join(" / ");
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
      // 예전에 저장한 표 기반 편제표는 열 때 데이터로 바꾼다.
      if (typeof ensureCurriculumPlanData === "function") {
        for (const layout of [state.curriculumImportedLayout,
          ...Object.values(state.curriculumCohorts || {}).map((item) => item?.importedLayout),
          ...Object.values(state.curriculumAnnualPlans || {}).map((item) => item?.importedLayout)]) {
          // 표 기반으로 저장된 예전 자료는 저장된 표로 바꾼 것이므로, 원본이 있으면 원본에서 다시 읽도록 변환기 표시를 0으로 둔다.
          if (layout && !layout.planData && ensureCurriculumPlanData(layout) && layout.archiveId && !layout.derived) layout.planData.converter = 0;
        }
      }
      // 저장된 편제표는 추정으로 고치지 않는다. 예전 변환기로 만든 자료는 원본 엑셀을 새 변환기로 다시 읽는다(curriculum-reconvert.js, 비동기).
      const repairs = [];
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
      return repairs;
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
      // 데이터로 바꾼 편제표는 비교 기준도 데이터로 읽어 같은 규칙으로 비교한다.
      const signatures = layout.planData && typeof curriculumDataSignatures === "function"
        ? curriculumDataSignatures : curriculumSubjectSignatures;
      // 공식 과목명 자동 수정(원래 이름 ↔ 고친 이름)은 같은 과목으로 본다(서식·자동 수정은 교사의 편성 변경이 아니다).
      const nameKey = layout.planData && typeof curriculumDataCompareNameKey === "function"
        ? curriculumDataCompareNameKey(layout, layout.changeBaseline) : undefined;
      const before = signatures(layout.changeBaseline, layout.changeBaseline.plan || null, nameKey);
      const after = signatures(layout, layout.changeBaseline.plan ? state.curriculumPlan : null, nameKey);
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
      // 전학년 편제표는 3개년 편제표에서 자동으로 만들고 시점 저장도 하지 않으므로 변경 비교를 하지 않는다(예전에 올린 전학년 이력과 비교하지 않음).
      if (layout?.derived) {
        delete layout.changeBaseline;
        delete layout.changeBaselineError;
        return;
      }
      if (typeof latestCurriculumSavedVersion === "function" && layout === state.curriculumImportedLayout) {
        // 비교 기준: 마지막 저장 시점(원본 다시 읽기 자동 기록만 뒤에 있으면 정규화된 그 앞 시점, curriculum-versions.js)
        const latest = typeof curriculumComparisonVersion === "function" ? curriculumComparisonVersion() : latestCurriculumSavedVersion();
        if (latest) {
          const stamp = latest.normalized?.at || "";
          if (layout.changeBaseline?.versionId !== latest.id || (layout.changeBaseline.normalizedAt || "") !== stamp) {
            layout.changeBaseline = curriculumSavedBaseline(latest.snapshot, latest.id, latest.savedAt);
            if (stamp) layout.changeBaseline.normalizedAt = stamp;
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
      if (layout.planData && typeof curriculumDataSheetHtml === "function") {
        return curriculumDataSheetHtml(layout, filters, selectionMode, compactView, curriculumTableChanges(layout));
      }
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
      if (typeof planComplianceChanged === "function") planComplianceChanged();
      persistState();
      status.style.color = "#596780";
      status.textContent = "편제표의 직전 변경을 실행취소했습니다.";
      showAppToast("편제표 수정을 실행취소했습니다.");
    }

    function curriculumUndoShortcutApplies(event) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
      if (String(event.key || "").toLowerCase() !== "z" && event.code !== "KeyZ") return false;
      if (Number(state.workflowStep) !== 1 || $("#workflowStep1Panel")?.classList.contains("hidden") || document.querySelector("dialog[open]")) return false;
      if (!state.curriculumImportedLayout) return false;
      const editable = event.target?.closest?.("input, textarea, select, [contenteditable='true'], [contenteditable='']");
      if (!editable) return true;
      if (!editable.closest("#curriculumPlanWrap")) return false;
      // 이 칸에 글자를 입력하기 시작했으면(입력 중) 글자 되돌리기는 브라우저에 맡긴다.
      if (editable.matches("[contenteditable='true'], [contenteditable='']")) return !state.curriculumEditUndoRecorded;
      return false;
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

    // 표 위 변경 상태 문구: 비교 기준 시점(시각·이름)이 보이게. 0개면 '같습니다'. 마우스를 올리면 무엇을 세는지 설명한다.
    function renderCurriculumChangeSummary(layout, changes) {
      const box = $("#curriculumChangeSummary");
      const baseline = layout.changeBaseline;
      if (layout.derived) {
        box.textContent = "전학년 편제표는 3개년 편제표에서 자동으로 만들어 변경 비교를 하지 않습니다";
        box.title = "전학년 편제표는 직접 고치거나 시점으로 저장하지 않습니다. 바뀐 곳은 각 입학생 편제표의 변경 표시·변경 이력에서 확인하세요.";
        return;
      }
      if (baseline?.version !== 2) {
        box.textContent = layout.changeBaselineError ? `변경 비교 실패: ${layout.changeBaselineError}` : "비교 기준 준비 중";
        box.removeAttribute("title");
        return;
      }
      const removed = [...changes.values()].filter((change) => change.kind === "removed").length;
      const changed = changes.size - removed;
      const label = typeof curriculumBaselineLabel === "function" ? curriculumBaselineLabel(baseline) : { time: "", name: "" };
      const detail = [label.time, label.name ? `'${label.name}'` : ""].filter(Boolean).join(", ");
      const point = baseline.source === "saved" ? `마지막 저장 시점${detail ? `(${detail})` : ""}`
        : baseline.source === "original" ? "최초 업로드(저장한 시점 없음)" : "처음 연 시점(저장한 시점 없음)";
      const parts = [];
      if (changed) parts.push(`바뀐 과목 ${changed}개`, "바뀐 과목명은 음영");
      if (removed) parts.push(`삭제 ${removed}개`);
      const text = parts.length ? `${point}보다 ${parts.join(" · ")}` : `${point}과 같습니다`;
      const history = parts.length && baseline.source === "saved" && baseline.versionId
        ? ` <button class="button button-quiet curriculum-change-history" type="button" data-change-history="${escapeHtml(baseline.versionId)}">이력 확인</button>` : "";
      box.innerHTML = `<span>${escapeHtml(text)}</span>${history}`;
      box.title = `비교 기준: ${baseline.source === "saved" ? `마지막으로 '새 시점으로 저장'한 시점${detail ? `(${detail})` : ""}` : point}. ` +
        "그 뒤 학점·학기·선택과목군·교과(군)·과목 종류 등 편성이 바뀐 과목 수입니다. 표에서 바뀐 과목명은 노란 음영으로 표시합니다. " +
        "서식·공식 과목명 자동 수정·원본 다시 읽기(변환기 갱신)는 바뀐 것으로 세지 않습니다." +
        (removed ? " 삭제된 과목은 표에 없으므로 '이력 확인'에서 봅니다." : "") +
        " 새 시점으로 저장하면 그 시점이 새 비교 기준이 됩니다.";
    }

    // 1단계 위쪽(학교·학년도 설정·편제표 카드·변경 이력)과 편제표 표 사이 경계선 가운데의 접기 손잡이.
    // 접힌 상태 ▼ '학교·학년도·편제표 카드 펼치기', 펼친 상태 ▲ '접기'. 접근성 이름에는 예전 단추 이름(상단 펼치기/접기)도 남긴다.
    function syncCurriculumTopToggle() {
      const collapsed = Boolean(state.curriculumTopCollapsed);
      $("#teacherWorkspace").classList.toggle("curriculum-top-collapsed", collapsed);
      const toggle = $("#curriculumTopToggle");
      if (!toggle) return;
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.setAttribute("aria-label", collapsed ? "학교·학년도·편제표 카드 펼치기 (상단 펼치기)" : "접기 · 학교·학년도·편제표 카드 접기 (상단 접기)");
      const arrow = toggle.querySelector(".collapse-handle-arrow");
      const label = toggle.querySelector(".collapse-handle-text");
      if (arrow) arrow.textContent = collapsed ? "▼" : "▲";
      if (label) label.textContent = collapsed ? "학교·학년도·편제표 카드 펼치기" : "접기";
      if (!arrow && !label) toggle.textContent = collapsed ? "상단 펼치기" : "상단 접기";
      $("#curriculumTopDivider")?.classList.toggle("is-collapsed", collapsed);
    }

    function renderCurriculumStep() {
      // 1단계가 안 보이면 그리지 않고 1단계를 열 때 그린다(view-keep.js, 첫 화면·다른 단계 조작이 빨라짐).
      if (typeof deferRenderUntilStepVisible === "function" && deferRenderUntilStepVisible(1, "renderCurriculumStep", renderCurriculumStep)) return;
      const emptyRows = typeof curriculumEmptySubjectRows === "function" ? curriculumEmptySubjectRows(state.curriculumImportedLayout) : [];
      const emptyRowsToggle = $("#curriculumEmptyRowsToggle");
      emptyRowsToggle.classList.toggle("hidden", !emptyRows.length);
      emptyRowsToggle.textContent = `빈 과목 행 ${emptyRows.length}개 ${state.curriculumImportedLayout?.showEmptySubjectRows ? "접기" : "표시"}`;
      emptyRowsToggle.setAttribute("aria-pressed", String(Boolean(state.curriculumImportedLayout?.showEmptySubjectRows)));
      syncCurriculumTopToggle();
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
          "openCurriculumVersionSave", "openCurriculumVersionDialog", "clearCurriculumPlan"]) $(`#${id}`).disabled = true;
        $("#curriculumMergeControls").classList.add("hidden");
      }
      if (typeof syncCurriculumDataControls === "function") syncCurriculumDataControls(state.curriculumImportedLayout);
      renderCurriculumCohortUploads();
      if (typeof renderCurriculumVersions === "function") renderCurriculumVersions();
      if (typeof ensureCurriculumHiddenRows === "function") ensureCurriculumHiddenRows();
      $("#undoCurriculumEdit").disabled = !state.curriculumUndoStack.length;
      $("#clearCurriculumPlan").disabled = (!state.curriculumImportedLayout && !state.curriculumPlan.length) || isDerivedAnnualPlan();
      $("#exportCurriculumPlan").disabled = !state.curriculumImportedLayout && !state.curriculumPlan.length;
      if ($("#exportCurriculumOfficePlan")) $("#exportCurriculumOfficePlan").disabled = !state.curriculumImportedLayout;
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
        renderCurriculumChangeSummary(importedLayout, curriculumTableChanges(importedLayout));
        const planRows = state.curriculumPlan.map((item, index) => ({ item, index }));
        $("#curriculumPlanWrap").innerHTML =
          `${curriculumBundleSummaryHtml(planRows.map(({ item }) => item), importedLayout)}` +
          `${curriculumImportedGradeSummaries(planRows, importedLayout)}` +
          `${curriculumImportedSheetHtml(importedLayout, state.curriculumPlanFilters, curriculumCellSelectionMode, state.curriculumTopCollapsed)}`;
        if (typeof decoratePlanComplianceSheet === "function") decoratePlanComplianceSheet();
      } else {
        $("#curriculumChangeSummary").textContent = "";
        $("#curriculumChangeSummary").removeAttribute("title");
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
      // 과목 행 정보는 묶음마다 다시 만들지 않고 한 번만 만든다.
      const contexts = groups.size ? importedPlanCourseContexts(layout, columns) : [];
      for (const group of groups.values()) {
        for (const context of contexts) {
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
      classBases = {},
      closures = {}
    ) {
      const grades = [...new Set(students.map((student) => student.grade))];
      // 그룹 설정은 읽는 데 시간이 걸리므로 과목마다 다시 읽지 않고 한 번만 읽어 넘긴다.
      const groupSettings = typeof getApplicationGroupSettings === "function" ? getApplicationGroupSettings() : null;
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
          const applicationGroup = applicationGroupForCourse(course, grade, groupSettings, applicationSemester);
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
            group = { category, choiceCount: null, courses: [] };
            semester.groups.push(group);
          }
          // 택n의 n: 온라인 그룹 정보 → 2단계 그룹 설정 → 그룹 이름("2-1 택3") 순으로 찾는다.
          if (!group.choiceCount && category !== UNASSIGNED_GROUP) {
            const settingGroup = course.applicationGroupSource === "online" ? null
              : (groupSettings || []).find((item) => String(item.grade) === String(displayGrade) && item.name === category &&
                (!semesterKey || !item.semester || String(item.semester) === String(semesterKey)));
            const count = [applicationGroup?.count, settingGroup?.count, Number(String(category).match(/택\s*(\d+)/)?.[1])]
              .map(Number).find((value) => Number.isInteger(value) && value > 0);
            if (count) group.choiceCount = count;
          }
          const enrollment = gradeStudents.filter((student) =>
            student.selections.some((selection) => selection.column === course.column)).length;
          // 부동소수 오차(예: 3.0000000000000004)로 올림·비교가 어긋나지 않도록 정수로 계산한다.
          //   신청 인원 ÷ (학생/학급 × 분반%/100) = 신청 인원 × 학급 × 100 ÷ (학생 × 분반%)
          const divisionDenominator = gradeStudents.length * divisionPercent;
          const scaledEnrollment = enrollment * summary.classes * 100;
          const recommendedClasses = summary.classes && divisionDenominator > 0 && enrollment > 0
            ? Math.floor((scaledEnrollment + divisionDenominator - 1) / divisionDenominator)
            : 0;
          const atRisk = summary.classes > 0 && scaledEnrollment < gradeStudents.length * openingPercent;
          const overrideKey = `${grade}:${course.column}`;
          // 교사가 폐강으로 정한 과목은 개설 학급수 0으로 취급한다(확정 스냅샷·시수 통계와 같은 기준).
          const closed = closures?.[overrideKey] === "closed";
          const rawClassCount = Object.prototype.hasOwnProperty.call(classOverrides, overrideKey)
            ? classOverrides[overrideKey]
            : recommendedClasses;
          const classCount = closed ? 0 : rawClassCount;
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
            atRisk,
            closed,
            rawClassCount,
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
      // 검색어는 띄어쓰기로 나눠 모두 맞아야 한다. 이름은 일부만 맞아도 되고, 학년·반·번호는
      // "2학년"·"3반"·"5번"·"1-3"·"1-3-5"·숫자처럼 정확히 맞아야 한다(3반이 13반에 걸리지 않게).
      const terms = query.split(/\s+/).filter(Boolean);
      // '위계 경고만': 위계(선이수) 경고 학생만 남긴다(학생 전체를 한 번 계산한 결과를 쓴다).
      const prereqOnly = !!$("#prereqFilter")?.checked;
      const flagged = prereqOnly && typeof courseCheckFlags === "function" ? courseCheckFlags(state.students).students : null;
      return state.students.filter((student) => {
        const { grade, classroom, number } = student;
        const name = String(student.name || "").toLocaleLowerCase();
        const tokens = new Set([String(grade), String(classroom), String(number), `${grade}학년`, `현${grade}학년`,
          `${classroom}반`, `${number}번`, `${grade}-${classroom}`, `${grade}-${classroom}-${number}`]);
        return terms.every((term) => name.includes(term) || tokens.has(term)) &&
          (!gradeValue || String(student.grade) === gradeValue) &&
          (!classValue || student.classroom === classValue) &&
          (!prereqOnly || !!flagged?.get(student)?.violations.length);
      });
    }

    function renderRoster() {
      if (typeof deferRenderUntilStepVisible === "function" && deferRenderUntilStepVisible(3, "renderRoster", renderRoster)) return;
      const students = visibleStudents();
      $("#studentCount").textContent = `${students.length} / ${state.students.length}명`;
      const prereq = typeof courseCheckFlags === "function" ? courseCheckFlags(state.students) : null;
      const prereqCount = $("#prereqFilterCount");
      if (prereqCount) {
        const gradeValue = $("#gradeFilter")?.value || "";
        prereqCount.textContent = String([...(prereq?.students.values() || [])]
          .filter((entry) => entry.violations.length && (!gradeValue || String(entry.student.grade) === gradeValue)).length);
      }
      const list = $("#studentList");
      if (!students.length) {
        const empty = document.createElement("div");
        empty.className = "empty-roster";
        empty.textContent = $("#prereqFilter")?.checked ? "위계 경고 학생이 없습니다." : "검색 결과가 없습니다.";
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
        const warning = prereq?.students.get(student);
        if (warning?.violations.length) {
          const flag = document.createElement("span");
          flag.className = "student-prereq-flag";
          flag.textContent = "⚠ 위계";
          flag.title = `위계(선이수) 경고: ${warning.violations.map((item) => `${item.issue.course} — ${item.brief}`).join(" / ")}`;
          item.querySelector(".student-name").append(" ", flag);
        }
        item.querySelector(".student-meta").textContent = studentGradeLabel(student);
        item.querySelector(".student-courses").textContent = `${student.selections.length}과목`;
        fragment.appendChild(item);
      }
      list.replaceChildren(fragment);
    }

    // 그룹 설정을 읽는 데 약 50ms가 걸리므로 일괄 인쇄에서는 한 번만 읽어 학생마다 넘긴다.
    function certificateGroupSettings() {
      return typeof getApplicationGroupSettings === "function" ? getApplicationGroupSettings() : [];
    }

    // 현 N학년 학생은 N+1학년 과목을 신청하므로 학생 표기에는 항상 '현'을 붙여 신청 학년과 헷갈리지 않게 한다.
    function studentGradeLabel(student) {
      return `현 ${student.grade}학년 ${student.classroom}반 ${student.number}번`;
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
      // 과목이 많은 학생은 인쇄용 행 높이를 더 줄여 한 장에 담는다(학교명·서명 줄이 다음 장으로 넘어가지 않게).
      const density = student.selections.length >= 22 ? " paper-dense" : student.selections.length >= 15 ? " paper-compact" : "";
      return `<article class="${printMode ? "print-page" : "preview-paper"}${density}">
        <div class="paper">
          <h2 class="paper-title">학생 수강 신청 확인서</h2>
          <div class="paper-meta"><span class="academic">${escapeHtml($("#schoolYear").value || "____")}학년도&nbsp; ${escapeHtml($("#round").value || "수강 신청")}</span></div>
          <p class="paper-student"><span class="paper-student-grade">${escapeHtml(studentGradeLabel(student))} · ${escapeHtml(Number(student.grade) + 1)}학년 선택과목 신청</span>&nbsp;&nbsp; <span class="paper-student-name">${escapeHtml(student.name)}</span></p>
          <table class="certificate-table">
            <thead><tr><th class="group-cell">선택군</th><th class="course-cell">과목명</th><th class="credit-cell">학점</th></tr></thead>
            <tbody>${body}</tbody>
          </table>
          ${typeof courseCheckCertificateHtml === "function" ? courseCheckCertificateHtml(student) : ""}
          ${gauge}
          <div class="paper-closing">
          <p class="paper-total">총 ${student.selections.length}과목(${student.totalCredits}학점)을 위와 같이 수강 신청하였음을 확인합니다.</p>
          <div class="paper-signature">
            <div>${escapeHtml(String($("#confirmDate").value || "").trim() || "　　　년　　월　　일")}</div>
            <div>학생: ${escapeHtml(student.name)}&nbsp;&nbsp;&nbsp; (인)</div>
            <div>학부형:　　　　　　　　　(인)</div>
          </div>
          <p class="paper-school">${escapeHtml(String($("#schoolName").value || "").trim() || "　　　　　　　　　　")}&nbsp; 귀하</p>
          </div>
        </div>
      </article>`;
    }

    function renderPreview() {
      if (typeof deferRenderUntilStepVisible === "function" && deferRenderUntilStepVisible(3, "renderPreview", renderPreview)) return;
      renderCertificateInfoSummary();
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
      $("#previewSubheading").textContent = `${studentGradeLabel(student)} · ${Number(student.grade) + 1}학년 과목 ${student.selections.length}개 · ${student.totalCredits}학점`;
      $("#printSelected").disabled = false;
      syncPrintAllButton();
    }

    // 확인서 기본 정보는 팝업에서 고치고, 화면에는 현재 값만 한 줄로 보여 준다.
    function renderCertificateInfoSummary() {
      const summary = typeof document !== "undefined" ? document.getElementById("certificateInfoSummary") : null;
      if (!summary) return;
      const date = String($("#confirmDate").value || "").trim();
      const school = String($("#schoolName").value || "").trim();
      const part = (label, value) => {
        const item = document.createElement("span");
        item.className = value ? "certificate-info-value" : "certificate-info-value is-missing";
        item.textContent = `${label} ${value || "미입력"}`;
        return item;
      };
      summary.replaceChildren(part("확인 날짜", date), " · ", part("학교명", school));
    }

    function syncPrintAllButton() {
      const count = visibleStudents().length;
      const button = $("#printAll");
      button.disabled = count === 0;
      const classroom = $("#classFilter")?.value;
      const grade = $("#gradeFilter")?.value;
      const scope = `${grade ? `현 ${grade}학년 ` : classroom ? "전 학년 " : ""}${classroom ? `${classroom}반 ` : ""}${$("#prereqFilter")?.checked ? "위계 경고 " : ""}`;
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

    // 반별 최대 인원(학급수 자동 조정 기준). 이전 저장 자료처럼 값이 없거나 잘못되면 34명으로 본다.
    function aggregateMaxClassSize() {
      const value = Number($("#maxClassSize")?.value);
      return Number.isInteger(value) && value >= 1 && value <= 99 ? value : 34;
    }

    // 4단계 학년 탭은 화면 상태로만 둔다(저장 형식에 넣지 않음). 차수를 바꿔도 고른 학년을 기억하고,
    // 그 차수에 그 학년 결과가 없으면 전체로 보여 준다.
    let aggregateGradeScope = "";
    let aggregateAttentionOnly = false;
    let aggregateAdjustUndo = null;
    function activeAggregateGrade() {
      return aggregateGradeScope && (state.students || []).some((student) => String(student.grade) === aggregateGradeScope)
        ? aggregateGradeScope : "";
    }

    // 교사 결정이 없으면 기준을 충족한 과목은 개설, 기준 미달 과목은 미정으로 본다(확정 스냅샷과 같은 기준).
    function aggregateClosureDecision(closures, key, atRisk) {
      return Object.hasOwn(closures || {}, key) ? closures[key] : atRisk ? "" : "open";
    }

    // 택n 그룹의 총 학급수는 n × 학급 수와 같아야 한다. 택 수를 모르는 그룹(미분류 등)은 목표가 없다.
    function aggregateGroupTarget(group, classes) {
      const count = Number(group?.choiceCount);
      return Number.isInteger(count) && count > 0 && Number.isInteger(classes) && classes > 0 ? count * classes : null;
    }

    // 학급수 자동 조정(순수 함수). 폐강 과목은 0학급, 신청자가 있는 과목은 학급당 최대 인원을 넘지 않는
    // 최소 학급(최소 1)에서 시작한다. 목표보다 적으면 학급당 인원이 가장 많은 과목부터(동률이면 표 순서) 한 학급씩 더하고,
    // 최소 합계가 목표보다 많으면 바꾸지 않고 counts를 null로 돌려준다.
    function planGroupClassCounts(courses, target, maxClassSize) {
      const items = (courses || []).map((course, order) => {
        const enrollment = Math.max(0, Number(course.enrollment) || 0);
        const closed = !!course.closed;
        return { key: course.key, enrollment, closed, order,
          count: closed || enrollment === 0 ? 0 : Math.max(1, Math.ceil(enrollment / maxClassSize)) };
      });
      const minimum = items.reduce((sum, item) => sum + item.count, 0);
      const result = { target, minimum, maxClassSize, ok: false, reason: "", counts: null };
      if (!Number.isInteger(target) || target < 0) return { ...result, reason: "no-target" };
      if (minimum > target) return { ...result, reason: "too-few" };
      const open = items.filter((item) => item.count > 0);
      if (minimum < target && !open.length) return { ...result, reason: "no-courses" };
      for (let remaining = target - minimum; remaining > 0; remaining--) {
        let best = open[0];
        // 학급당 인원 비교는 나눗셈 대신 곱셈으로 한다(a/b > c/d ⇔ a·d > c·b).
        for (const item of open) if (item.enrollment * best.count > best.enrollment * item.count) best = item;
        best.count += 1;
      }
      return { ...result, ok: true, counts: Object.fromEntries(items.map((item) => [item.key, item.count])) };
    }

    function aggregateGroupLabel(semester, group) {
      return /^\d-\d/.test(group.category) ? group.category : `${semester.name} · ${group.category}`;
    }

    function aggregatePlanMessage(plan) {
      if (plan.reason === "too-few") return `${plan.maxClassSize}명 이하로는 최소 ${plan.minimum}학급이 필요해 목표 ${plan.target}와 맞출 수 없음 — 협의회 결정 필요`;
      if (plan.reason === "no-courses") return `신청자가 있는 개설 과목이 없어 목표 ${plan.target}학급을 채울 수 없음 — 협의회 결정 필요`;
      if (plan.reason === "no-target") return "택 수를 알 수 없어 목표 학급수가 없음";
      return "";
    }

    function aggregatePlanCourses(report, group) {
      return group.courses.map((course) => ({
        key: `${report.summary.grade}:${course.column}`, enrollment: course.enrollment, closed: course.closed
      }));
    }

    // 확정 전 확인용: 목표(n × 학급 수)와 다른 그룹, 학급당 인원이 최대 인원을 넘는 과목.
    function aggregateClassPlanIssues(aggregate, maxClassSize = aggregateMaxClassSize()) {
      const issues = [];
      for (const report of aggregate?.reports || []) {
        const current = `현${report.summary.grade}학년`;
        for (const semester of report.semesters) {
          for (const group of semester.groups) {
            const target = aggregateGroupTarget(group, report.summary.classes);
            if (target !== null && group.totalClasses !== target) {
              const diff = group.totalClasses - target;
              issues.push(`${aggregateGroupLabel(semester, group)}(${current}): 총 ${group.totalClasses}학급 / 목표 ${target} (${diff > 0 ? "+" : ""}${diff})`);
            }
            for (const course of group.courses) {
              if (!course.closed && course.classCount > 0 && course.enrollment > course.classCount * maxClassSize) {
                issues.push(`${course.displayName || course.name}(${current}): 학급당 ${course.averageClassSize.toFixed(1)}명 > 최대 ${maxClassSize}명`);
              }
            }
          }
        }
      }
      return issues;
    }

    function aggregateSettingsSummaryText(aggregate, maxClassSize) {
      const opening = $("#openingPercent")?.value || "-";
      const division = $("#divisionPercent")?.value || "-";
      const classes = ["1", "2"].map((grade) => {
        const summary = aggregate?.reports.find((report) => String(report.summary.grade) === grade)?.summary;
        const planned = Number((typeof nextYearClassBases === "function" ? nextYearClassBases() : {})[String(Number(grade) + 1)]);
        const value = Number.isInteger(planned) && planned > 0 ? String(planned) : summary ? `${summary.classes}(명단)` : "명단";
        return `${Number(grade) + 1}학년 ${value}`;
      });
      return `개설 ${opening}% · 분반 ${division}% · 최대 ${maxClassSize}명 · 내년 ${classes.join(" · ")}학급`;
    }

    // 학급당 인원 경고: 최대 인원(기본 34) 초과와 분반 기준 초과. 자동 조정뿐 아니라 학급수를 직접 고쳐도 같은 기준으로 표시한다(막지는 않음).
    // 비교는 나눗셈 대신 곱셈으로 한다(학급당 = 신청 ÷ 학급).
    function aggregateCourseWarnings(course, summary, maxClassSize) {
      const active = !course.closed && course.classCount > 0;
      return {
        over: active && course.enrollment > course.classCount * maxClassSize,
        overDivision: active && Number(summary?.divisionLimit) > 0 && course.enrollment > course.classCount * Number(summary.divisionLimit)
      };
    }

    // '처리할 것만' 보기: 결정이 미정인 기준 미달 과목, 학급당 인원 경고가 있는 과목, 위계(선이수) 경고 학생이 있는 과목,
    // 목표 학급수와 맞지 않는 그룹. prereq: courseCheckFlags 결과(없으면 위계는 보지 않는다).
    function aggregateAttention(report, closures, maxClassSize, prereq = null) {
      const grade = String(report.summary.grade);
      const courses = new Set();
      const groups = new Set();
      for (const semester of report.semesters) {
        for (const group of semester.groups) {
          const target = aggregateGroupTarget(group, report.summary.classes);
          if (target !== null && group.totalClasses !== target) groups.add(`${semester.name}\u0000${group.category}`);
          for (const course of group.courses) {
            const key = `${grade}:${course.column}`;
            const warnings = aggregateCourseWarnings(course, report.summary, maxClassSize);
            const undecided = course.atRisk && aggregateClosureDecision(closures, key, course.atRisk) === "";
            const prereqWarning = !!prereq?.courses?.get(key)?.violators?.size;
            if (undecided || warnings.over || warnings.overDivision || prereqWarning) courses.add(key);
          }
        }
      }
      return { courses, groups, count: courses.size + groups.size };
    }

    // 한 학년 집계표: 엑셀 시트와 같은 학교 양식(aggregateSheetModel → aggregateSheetHtml)에 학년 머리줄(위계·학점 요약,
    // 학년 전체 자동 조정·조정 취소)만 붙인다. 학생 수·학급당·개설/분반 기준은 양식 2~3행에 있으므로 따로 요약하지 않는다.
    function aggregateGradeSectionMarkup(report, { closures, round, locked, maxClassSize, attentionOnly, canUndo, prereq = null,
      openingPercent, divisionPercent, undoGroups = null }) {
      const grade = String(report.summary.grade);
      const attention = attentionOnly ? aggregateAttention(report, closures, maxClassSize, prereq) : null;
      const percent = (value, selector, fallback) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value)
        : Number($(selector)?.value) || fallback;
      const model = aggregateSheetModel(report, percent(openingPercent, "#openingPercent", 90), percent(divisionPercent, "#divisionPercent", 110));
      const sheet = aggregateSheetHtml(model, { grade, closures, round, locked, maxClassSize, prereq, attention,
        undoGroups: canUndo ? (undoGroups || new Set()) : null });
      const lockTitle = locked ? ' disabled title="확정된 차수입니다. 확정 해제 후 조정하세요."' : "";
      return `<section class="aggregate-grade aggregate-form-grade" data-aggregate-grade-section="${escapeHtml(grade)}">
        <div class="aggregate-grade-head">
          <span class="aggregate-form-hint">과목명을 누르면 개설·폐강·미정을 정하고, 개설 학급수 칸은 눌러서 바로 고칩니다.</span>
          ${typeof courseCheckAggregateNote === "function" ? courseCheckAggregateNote(grade, prereq) : ""}
          <div class="aggregate-grade-actions">
            <button class="button" type="button" data-aggregate-adjust="grade" data-grade="${escapeHtml(grade)}"${lockTitle}>학급수 자동 조정(학년 전체)</button>
            ${canUndo ? `<button class="button" type="button" data-aggregate-undo="${escapeHtml(grade)}"${lockTitle}>조정 취소</button>` : ""}
          </div>
        </div>
        ${sheet}
      </section>`;
    }

    // 4단계 집계 화면 그리기의 입구. 화면 내용은 renderAggregateView가 그린다(집계 화면을 다시 쓰더라도 이 입구는 그대로 둘 것).
    // - 4단계가 안 보이면 그리지 않고 4단계를 열 때 그린다(view-keep.js deferRenderUntilStepVisible).
    // - 값을 바꿔 다시 그려도 창·표 안 스크롤과 입력 포커스·커서를 그대로 둔다(view-keep.js preserveViewDuring).
    function renderAggregate() {
      if (typeof deferRenderUntilStepVisible === "function" && deferRenderUntilStepVisible(4, "renderAggregate", renderAggregate)) return;
      if (typeof preserveViewDuring === "function") return preserveViewDuring(["#aggregatePanel", "#retakePanel"], renderAggregateView);
      return renderAggregateView();
    }

    function renderAggregateView() {
      const gradeBar = $("#aggregateGradeBar");
      const settingsSummary = $("#aggregateSettingsSummary");
      const maxClassSize = aggregateMaxClassSize();
      if (!state.students.length || !state.courses.length) {
        $("#aggregateDescription").textContent = "학생별 신청 명단에서 과목별 인원을 계산했습니다.";
        $("#aggregateContent").innerHTML = '<div class="aggregate-empty">학생별 신청 명단을 불러오면 집계표가 표시됩니다.</div>';
        if (gradeBar) gradeBar.innerHTML = "";
        if (settingsSummary) settingsSummary.textContent = aggregateSettingsSummaryText(null, maxClassSize);
        $("#downloadAggregate").disabled = true;
        return;
      }
      let thresholds;
      try {
        thresholds = aggregateThresholds();
      } catch (error) {
        $("#aggregateDescription").textContent = error.message;
        $("#aggregateContent").textContent = "유효한 기준 비율을 입력하면 집계를 다시 표시합니다.";
        if (gradeBar) gradeBar.innerHTML = "";
        if (settingsSummary) settingsSummary.textContent = aggregateSettingsSummaryText(null, maxClassSize);
        $("#downloadAggregate").disabled = true;
        return;
      }
      const { openingPercent, divisionPercent } = thresholds;
      const classBases = typeof nextYearClassBases === "function" ? nextYearClassBases() : {};
      const round = String(state.currentRound);
      const locked = typeof isRoundLocked === "function" && isRoundLocked(round);
      const closures = state.roundClosures?.[round] || {};
      const aggregate = aggregateRecords(
        state.students, state.courses, openingPercent, divisionPercent,
        state.classOverrides, state.semesterAssignments, state.groupAssignments, classBases, closures
      );
      if (settingsSummary) settingsSummary.textContent = aggregateSettingsSummaryText(aggregate, maxClassSize);
      // 위계(선이수) 경고는 학생 전체를 한 번만 계산해(같은 자료면 캐시) 배지·팝업·처리할 것만에 함께 쓴다.
      const prereq = typeof courseCheckFlags === "function" ? courseCheckFlags(state.students) : null;
      // 학년 탭이 요약을 겸한다: 학년마다 신청 학생·개설 학급·기준 미달 수를 라벨에 보여 준다.
      const gradeStats = aggregate.reports.map((report) => {
        const groups = report.semesters.flatMap((semester) => semester.groups);
        const courses = groups.flatMap((group) => group.courses);
        return {
          grade: String(report.summary.grade), students: report.summary.students, courses: courses.length,
          classes: groups.reduce((sum, group) => sum + group.totalClasses, 0),
          risk: courses.filter((course) => course.atRisk).length,
          prereq: prereq?.grades.get(String(report.summary.grade))?.violators.length || 0,
          mismatch: groups.filter((group) => {
            const target = aggregateGroupTarget(group, report.summary.classes);
            return target !== null && target !== group.totalClasses;
          }).length
        };
      }).sort((a, b) => Number(a.grade) - Number(b.grade));
      const scope = activeAggregateGrade();
      const shownReports = aggregate.reports.filter((report) => !scope || String(report.summary.grade) === scope)
        .sort((a, b) => Number(a.summary.grade) - Number(b.summary.grade));
      const shownStats = gradeStats.filter((stat) => !scope || stat.grade === scope);
      const atRiskCount = shownStats.reduce((sum, stat) => sum + stat.risk, 0);
      const attentionCount = shownReports.reduce((sum, report) => sum + aggregateAttention(report, closures, maxClassSize, prereq).count, 0);
      const gradeLabel = (grade) => `현 ${grade}학년 → ${Number(grade) + 1}학년`;
      const tabs = [["", "전체", ""], ...gradeStats.map((stat) => [stat.grade, gradeLabel(stat.grade),
        ` · ${stat.students}명 · 개설 ${stat.classes}학급 · 미달 ${stat.risk}${stat.mismatch ? ` · 목표 불일치 ${stat.mismatch}` : ""}${stat.prereq ? ` · 위계 경고 ${stat.prereq}명` : ""}`])]
        .map(([value, label, detail]) => `<button type="button" class="aggregate-grade-tab" data-aggregate-grade="${value}" aria-pressed="${value === scope}"><strong>${label}</strong>${detail}</button>`).join("");
      const missingGrades = ["1", "2"].filter((grade) => !gradeStats.some((stat) => stat.grade === grade));
      const missingNote = missingGrades.length
        ? `<span class="aggregate-missing-note" role="status">${missingGrades.map((grade) => `현 ${grade}학년`).join("·")} 결과 없음 · 2단계에서 올리면 함께 집계</span>` : "";
      const totalLine = !scope
        ? `<span class="aggregate-total-line">합계 ${shownStats.reduce((sum, stat) => sum + stat.students, 0)}명 · ${shownStats.reduce((sum, stat) => sum + stat.courses, 0)}과목 · 개설 ${shownStats.reduce((sum, stat) => sum + stat.classes, 0)}학급 · 기준 미달 ${atRiskCount}과목</span>` : "";
      if (gradeBar) {
        gradeBar.innerHTML = `<div class="aggregate-grade-tabs" role="group" aria-label="학년 선택">${tabs}</div>${missingNote}${totalLine}
          <button type="button" class="button aggregate-risk-filter" data-aggregate-risk-filter aria-pressed="${aggregateAttentionOnly}" title="결정이 미정인 기준 미달 과목, 학급당 인원이 최대 인원·분반 기준을 넘는 과목, 위계(선이수) 경고 학생이 있는 과목, 목표 학급수와 맞지 않는 그룹만 봅니다.">처리할 것만(${attentionCount})</button>`;
      }
      const canUndo = !!aggregateAdjustUndo && aggregateAdjustUndo.round === round;
      if (typeof closeAggregateCourseMenu === "function") closeAggregateCourseMenu();
      $("#aggregateContent").innerHTML = shownReports.map((report) => aggregateGradeSectionMarkup(report, {
        closures, round, locked, maxClassSize, attentionOnly: aggregateAttentionOnly, prereq, openingPercent, divisionPercent,
        canUndo: canUndo && (!aggregateAdjustUndo.grade || aggregateAdjustUndo.grade === String(report.summary.grade)),
        undoGroups: canUndo ? aggregateAdjustUndo.groups : null
      })).join("");
      $("#aggregateDescription").textContent =
        `${round}차${locked ? " · 확정됨(수정 잠금)" : ""} · ${scope ? `${gradeLabel(scope)} 신청` : `${aggregate.reports.length}개 학년`} · 기준 미달 ${atRiskCount}과목(폐강 확정 아님)`;
      $("#downloadAggregate").disabled = false;
    }

    // 학급수 자동 조정: 그룹 하나 또는 학년 전체의 택n 그룹을 목표(n × 학급 수)에 맞춰 개설 학급수 수동 입력으로 저장한다.
    function adjustAggregateClassCounts(grade, semesterName = "", category = "") {
      const round = String(state.currentRound);
      if (typeof isRoundLocked === "function" && isRoundLocked(round)) return null;
      const { openingPercent, divisionPercent } = aggregateThresholds();
      const maxClassSize = aggregateMaxClassSize();
      const aggregate = aggregateRecords(
        state.students, state.courses, openingPercent, divisionPercent,
        state.classOverrides, state.semesterAssignments, state.groupAssignments,
        typeof nextYearClassBases === "function" ? nextYearClassBases() : {},
        state.roundClosures?.[round] || {}
      );
      const report = aggregate.reports.find((item) => String(item.summary.grade) === String(grade));
      if (!report) return null;
      const previous = {};
      const changed = [];
      const problems = [];
      const touchedGroups = new Set();
      for (const semester of report.semesters) {
        for (const group of semester.groups) {
          if (category && (semester.name !== semesterName || group.category !== category)) continue;
          const label = aggregateGroupLabel(semester, group);
          const target = aggregateGroupTarget(group, report.summary.classes);
          if (target === null) {
            if (category) problems.push(`${label}: ${aggregatePlanMessage({ reason: "no-target" })}`);
            continue;
          }
          // 이미 목표와 같고 학급당 최대 인원을 넘는 과목도 없으면 교사가 정한 값을 그대로 둔다.
          if (group.totalClasses === target && !group.courses.some((course) =>
            !course.closed && course.classCount > 0 && course.enrollment > course.classCount * maxClassSize)) continue;
          const plan = planGroupClassCounts(aggregatePlanCourses(report, group), target, maxClassSize);
          if (!plan.ok) {
            problems.push(`${label}: ${aggregatePlanMessage(plan)}`);
            continue;
          }
          let touched = false;
          for (const course of group.courses) {
            const key = `${report.summary.grade}:${course.column}`;
            if (course.closed) continue;
            const next = plan.counts[key];
            if (Object.hasOwn(state.classOverrides, key) && state.classOverrides[key] === next) continue;
            if (!Object.hasOwn(previous, key)) {
              previous[key] = Object.hasOwn(state.classOverrides, key) ? { value: state.classOverrides[key] } : null;
            }
            state.classOverrides[key] = next;
            touched = true;
          }
          if (touched) touchedGroups.add(`${semester.name}\u0000${group.category}`);
          if (touched) changed.push(group.totalClasses !== target ? `${label} ${group.totalClasses}→${target}` : `${label} ${target}학급 재배분`);
        }
      }
      // 조정 취소는 마지막 조정 한 번만 기억한다. groups: 조정한 그룹(그 그룹의 총 학급수 칸에 '조정 취소'를 둔다).
      if (Object.keys(previous).length) aggregateAdjustUndo = { round, grade: String(grade), previous, groups: touchedGroups };
      return { changed, problems };
    }

    function undoAggregateClassAdjust() {
      const undo = aggregateAdjustUndo;
      if (!undo || undo.round !== String(state.currentRound)) return false;
      if (typeof isRoundLocked === "function" && isRoundLocked(undo.round)) return false;
      for (const [key, entry] of Object.entries(undo.previous)) {
        if (entry) state.classOverrides[key] = entry.value;
        else delete state.classOverrides[key];
      }
      aggregateAdjustUndo = null;
      return true;
    }

    // 집계표 양식의 과목명 메뉴(개설·폐강·미정 + 상태 설명 + 위계 경고 학생 보기). 메뉴는 하나만 두고 집계표를 다시 그리면 닫는다.
    function closeAggregateCourseMenu(restoreFocus = false) {
      const menu = typeof document !== "undefined" ? document.getElementById("aggregateCourseMenu") : null;
      if (!menu || menu.hidden) return;
      menu.hidden = true;
      const opener = menu.aggregateOpener;
      menu.aggregateOpener = null;
      menu.aggregateAnchor = null;
      if (restoreFocus && opener?.isConnected) opener.focus({ preventScroll: true });
    }

    function openAggregateCourseMenu(head, anchor = head) {
      let menu = document.getElementById("aggregateCourseMenu");
      if (!menu) {
        const holder = document.createElement("div");
        holder.innerHTML = '<div class="aggregate-course-menu" id="aggregateCourseMenu" role="dialog" hidden></div>';
        menu = holder.firstElementChild;
        document.body.append(menu);
        menu.addEventListener("click", (event) => {
          const choice = event.target.closest("[data-closure-choice]");
          if (choice) {
            if (!choice.disabled) setAggregateClosure(menu.dataset.round, menu.dataset.key, choice.dataset.closureChoice);
            return;
          }
          if (event.target.closest("[data-aggregate-menu-close]")) closeAggregateCourseMenu(true);
          // 위계 경고 학생 보기: 팝업은 문서 공통 처리(data-open-dialog)가 연다. 메뉴만 닫는다.
          else if (event.target.closest("[data-open-dialog]")) closeAggregateCourseMenu();
        });
        menu.addEventListener("keydown", (event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          closeAggregateCourseMenu(true);
        });
      }
      const key = head.dataset.aggregateCourse || "";
      const decision = head.dataset.decision || "";
      const locked = head.hasAttribute("data-locked");
      const label = head.dataset.courseLabel || "";
      const prereqCount = Number(head.dataset.prereqCount) || 0;
      const lines = String(head.dataset.courseStatus || "").split("\n").filter(Boolean);
      const choices = [["open", "개설"], ["closed", "폐강"], ["", "미정"]].map(([value, text]) =>
        `<button type="button" class="aggregate-course-choice${value === "closed" ? " is-closed" : ""}" data-closure-choice="${value}" aria-pressed="${value === decision}"${locked ? " disabled" : ""}>${text}</button>`).join("");
      menu.dataset.key = key;
      menu.dataset.round = head.dataset.closureRound || "";
      menu.setAttribute("aria-label", `${label} 개설 결정`);
      menu.innerHTML = `<div class="aggregate-course-menu-head"><strong>${escapeHtml(label)}</strong><button type="button" class="aggregate-course-menu-close" data-aggregate-menu-close aria-label="닫기">×</button></div>
        <ul class="aggregate-course-menu-status">${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
        <div class="aggregate-course-choices" role="group" aria-label="교사 결정">${choices}</div>
        ${locked ? '<p class="aggregate-course-menu-note">확정된 차수입니다. 확정 해제 후 바꾸세요.</p>' : '<p class="aggregate-course-menu-note">폐강이면 개설 학급수 0, 엑셀처럼 노란 칸·폐강으로 표시하고 재신청 대상이 됩니다.</p>'}
        ${prereqCount ? `<button type="button" class="button aggregate-course-menu-prereq" data-open-dialog="prereqStudentsDialog" data-prereq-course="${escapeHtml(key)}" data-prereq-label="${escapeHtml(label)}">위계 경고 학생 ${prereqCount}명 보기</button>` : ""}`;
      menu.hidden = false;
      menu.aggregateOpener = head;
      menu.aggregateAnchor = anchor;
      // 누른 칸 바로 아래(화면 밖으로 나가면 위)에 붙인다. 문서 기준 위치라 화면을 굴려도 칸과 함께 움직인다.
      const rect = anchor.getBoundingClientRect();
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const below = rect.bottom + 4;
      const top = below + height > window.innerHeight - 8 && rect.top - height - 4 > 8 ? rect.top - height - 4 : below;
      menu.style.left = `${Math.round(left + window.scrollX)}px`;
      menu.style.top = `${Math.round(top + window.scrollY)}px`;
      (menu.querySelector('[data-closure-choice][aria-pressed="true"]:not(:disabled)') ||
        menu.querySelector("[data-closure-choice]:not(:disabled)") || menu.querySelector("[data-aggregate-menu-close]"))?.focus({ preventScroll: true });
    }

    // 교사 결정(개설·폐강·미정)을 저장하고 집계표·재신청 대상자를 다시 그린다. 확정된 차수는 바꾸지 않는다.
    function setAggregateClosure(round, key, value) {
      if (!key || !["", "open", "closed"].includes(value)) return false;
      if (typeof isRoundLocked === "function" && isRoundLocked(round)) {
        renderAggregate();
        return false;
      }
      if (!state.roundClosures[round]) state.roundClosures[round] = {};
      state.roundClosures[round][key] = value;
      persistStateSoon();
      renderAggregate();
      if (Number(state.workflowStep) === 4) renderRetakePanel();
      if (typeof updateRetakeReadiness === "function") updateRetakeReadiness();
      // 다시 그린 뒤 같은 과목 칸으로 초점을 돌려 키보드로 이어서 고칠 수 있게 한다.
      const head = [...document.querySelectorAll("[data-aggregate-course]")].find((item) => item.dataset.aggregateCourse === key);
      head?.focus({ preventScroll: true });
      return true;
    }

    function renderRoundStatus() {
      const statusLabel = (round) => typeof roundStatusLabel === "function" ? roundStatusLabel(round) : "";
      $("#roundSelector").innerHTML = applicationRoundNumbers().map((round) =>
        `<button class="round-tab" type="button" role="tab" data-round="${round}" aria-selected="${round === state.currentRound}">${round}차${statusLabel(round) && statusLabel(round) !== "작성 중" ? ` <small class="round-tab-status">${escapeHtml(statusLabel(round))}</small>` : ""}</button>`
      ).join("");
      const badge = $("#certificateRoundBadge");
      if (badge) badge.textContent = `${state.currentRound}차`;
      const list = $("#roundStatusList");
      if (!list) return;
      list.innerHTML = applicationRoundNumbers().map((round) => {
        const data = state.rounds?.[round];
        const grade = state.applicationMenuGrade || "1";
        const students = data?.students.filter((student) => String(student.grade) === grade) || [];
        const gradeFile = data?.gradeFiles?.[grade] || (Object.keys(data?.gradeFiles || {}).length ? "" : data?.fileName);
        const info = data
          ? `현 ${grade}학년(${Number(grade) + 1}학년 과목 신청): ${gradeFile || students.length ? `${escapeHtml(gradeFile || "이전 파일")} · ${students.length}명` : "업로드 없음"}`
          : `현 ${grade}학년(${Number(grade) + 1}학년 과목 신청): 업로드 없음`;
        const current = round === state.currentRound ? " · 현재 보기" : "";
        const roundState = statusLabel(round) ? ` · ${escapeHtml(statusLabel(round))}` : "";
        const button = data && round !== state.currentRound
          ? `<button class="button" type="button" data-view-round="${round}">이 차수 보기</button>`
          : "";
        return `<div class="round-status-item"><strong>${round}차${current}${roundState}</strong><span>${info}</span>${button}</div>`;
      }).join("");
    }

    // grade를 주면 그 학년(현 학년) 학생과 폐강 과목만 센다. 비우면 두 학년 전체.
    function retakeTargets(grade = "") {
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
        .filter(([key, value]) => value === "closed" && (!grade || key.startsWith(`${grade}:`)))
        .map(([key]) => key));
      const rows = [];
      if (data) {
        for (const student of data.students) {
          if (grade && String(student.grade) !== String(grade)) continue;
          const closedCourses = student.selections.filter((selection) =>
            closedKeys.has(`${student.grade}:${selection.name}`));
          if (closedCourses.length) {
            rows.push({ student, courses: closedCourses.map((selection) => selection.name) });
          }
        }
      }
      return { sourceRound, data, rows, closedCount: closedKeys.size };
    }

    function renderRetakeProgress({ sourceRound, nextRound, data, rows, closedCount, grade = "" }) {
      const list = $("#retakeProgress");
      if (!list) return;
      const nextHasResult = !!state.rounds?.[nextRound]?.students?.some((student) => !grade || String(student.grade) === String(grade));
      const steps = [
        { done: closedCount > 0, label: "폐강 확정", detail: data ? (closedCount ? `${closedCount}과목 폐강` : "위 집계표의 과목명을 눌러 개설/폐강을 정하세요") : `${sourceRound}차 결과 필요` },
        { done: closedCount > 0 && rows.length > 0, label: "재신청 대상 확인", detail: rows.length ? `대상 학생 ${rows.length}명 · 명단을 내려받거나 웹 수강신청에서 재신청 생성` : "폐강 과목을 신청한 학생이 없습니다" },
        { done: nextHasResult, label: `${nextRound}차 결과 반영`, detail: nextHasResult ? `${nextRound}차 결과 반영됨` : `2단계에서 ${nextRound}차를 추가해 결과 업로드` }
      ];
      const currentIndex = steps.findIndex((step) => !step.done);
      list.innerHTML = steps.map((step, index) =>
        `<li data-state="${step.done ? "done" : index === currentIndex ? "current" : "wait"}"${index === currentIndex ? ' aria-current="step"' : ""}><strong>${index + 1}. ${escapeHtml(step.label)}</strong><span>${escapeHtml(step.detail)}</span></li>`).join("");
    }

    function renderRetakePanel() {
      const grade = typeof activeAggregateGrade === "function" ? activeAggregateGrade() : "";
      const { sourceRound, data, rows, closedCount } = retakeTargets(grade);
      const nextRound = String(Number(sourceRound) + 1);
      const description = $("#retakeDescription");
      const content = $("#retakeContent");
      const scopeLabel = grade ? `현 ${grade}학년 · ` : "";
      $("#retakePanel h2").textContent = `${nextRound}차 수강신청 대상자${grade ? `(현 ${grade}학년)` : ""}`;
      const summaryCount = $("#retakeSummaryCount");
      if (summaryCount) {
        summaryCount.textContent = !data ? "결과 없음" : closedCount ? `대상 ${rows.length}명 · 폐강 ${closedCount}과목` : "폐강 과목 없음";
        summaryCount.dataset.state = rows.length ? "alert" : "";
      }
      $("#retakeNextRoundNote").textContent = `${nextRound}차 결과는 2단계에서 차수를 추가한 뒤 불러오세요.`;
      $("#downloadRetakeList").disabled = !rows.length;
      renderRetakeProgress({ sourceRound, nextRound, data, rows, closedCount, grade });
      if (!data) {
        description.textContent = "수강신청 데이터가 없습니다. 2단계에서 명단을 불러오세요.";
        content.innerHTML = "";
        return;
      }
      if (!closedCount) {
        description.textContent = `${scopeLabel}폐강으로 정한 과목이 없습니다. 위 집계표의 과목명을 눌러 개설/폐강을 정하세요.`;
        content.innerHTML = "";
        return;
      }
      description.textContent = `${scopeLabel}${sourceRound}차 결과 기준 · 폐강 확정 과목을 신청한 학생 ${rows.length}명`;
      // 위계 경고(폐강 후): 폐강 과목을 뺀 나머지 신청으로 다시 점검한다(폐강된 선이수 과목 때문에 새로 생긴 경고도 보인다).
      const prereqText = (student, courses) => typeof courseCheckPrereqText === "function" ? courseCheckPrereqText(student, { exclude: courses }) : "";
      content.innerHTML = `<table class="closure-table"><thead><tr><th>현 학년</th><th>반</th><th>번호</th><th>이름</th><th>신청 학년</th><th>폐강 과목</th><th>위계 경고(폐강 후)</th></tr></thead><tbody>${
        rows.map(({ student, courses }) => {
          const warning = prereqText(student, courses);
          return `<tr><td>${escapeHtml(student.grade)}</td><td>${escapeHtml(student.classroom)}</td><td>${escapeHtml(student.number)}</td><td>${escapeHtml(student.name)}</td><td>${Number(student.grade) + 1}학년</td><td class="closure-subject">${escapeHtml(courses.join(", "))}</td><td class="retake-prereq${warning ? " has-issue" : ""}">${warning ? `⚠ ${escapeHtml(warning)}` : ""}</td></tr>`;
        }).join("")
      }</tbody></table>`;
    }

    function downloadRetakeList() {
      // 4단계 학년 탭을 고르면 그 학년만, 전체 탭이면 두 학년 모두 내려받는다.
      const grade = typeof activeAggregateGrade === "function" ? activeAggregateGrade() : "";
      const { sourceRound, rows } = retakeTargets(grade);
      if (!rows.length) return;
      const nextRound = String(Number(sourceRound) + 1);
      const gradeSuffix = grade ? `현${grade}학년` : "";
      const sheetRows = [
        ["현 학년", "반", "번호", "이름", "신청 학년", "폐강 과목", "폐강 후 부족 학점", "위계 경고(폐강 후)"],
        ...rows.map(({ student, courses }) => [student.grade, student.classroom, student.number, student.name, `${Number(student.grade) + 1}학년`, courses.join(", "),
          typeof courseCheckRetakeShortfall === "function" ? courseCheckRetakeShortfall(student, courses) : "",
          typeof courseCheckPrereqText === "function" ? courseCheckPrereqText(student, { exclude: courses }) : ""])
      ];
      const rowsXml = sheetRows.map((cells, rowIndex) =>
        `<row r="${rowIndex + 1}">${cells.map((value, column) =>
          `<c r="${columnName(column)}${rowIndex + 1}" s="${rowIndex === 0 ? 2 : 7}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`).join("")}</row>`).join("");
      const columns = [8, 8, 8, 12, 10, 40, 28, 44].map((width, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
      const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews><cols>${columns}</cols><sheetData>${rowsXml}</sheetData></worksheet>`;
      const workbook = createXlsxBlob({
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${nextRound}차 대상자${gradeSuffix ? `(${gradeSuffix})` : ""}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml": sheetXml,
        "xl/styles.xml": createStylesXml()
      });
      const link = document.createElement("a");
      const url = URL.createObjectURL(workbook);
      link.href = url;
      link.download = `${Number(sourceRound) + 1}차_수강신청_대상자${gradeSuffix ? `_${gradeSuffix}` : ""}(${sourceRound}차_기준).xlsx`;
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
          <p title="${escapeHtml(description)}">${grade === "0" ? "내년도 1학년 시수 기준" : grade === "3" ? "전학년 편제표의 3학년 열 기준" : `수강신청: ${Number(grade) + 1}학년 과목 기준`}</p>${typeof planComplianceCardButton === "function" ? planComplianceCardButton("cohort", year, Boolean(fileName)) : ""}
          <p class="curriculum-cohort-file" title="${escapeHtml(fileName || "미업로드 · 1~3학년 전체 편제표 필요")}">${escapeHtml(fileName || "미업로드")}</p>
          <div>${typeof curriculumReconvertCardHtml === "function" ? curriculumReconvertCardHtml(year, active ? state.curriculumImportedLayout : state.curriculumCohorts?.[year]?.importedLayout) : ""}<button class="button${fileName ? "" : " button-primary"}" type="button" data-cohort-upload="${year}" aria-label="${year}학년도 신입생 3개년 편제표 ${fileName ? "원본 교체" : "업로드"}">${fileName ? "원본 교체" : "업로드"}</button>
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
        <p title="올해 1·2·3학년 입학생의 신입생 3개년 편제표에서 각 학년 열을 가져와 자동으로 만듭니다. 직접 수정하거나 따로 업로드하지 않습니다.">3개년 편제표에서 자동 생성</p>${typeof planComplianceCardButton === "function" ? planComplianceCardButton("annual", annualYear, built) : ""}
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
      if (plan.length && layout?.planData && typeof curriculumDataSubjectCredits === "function") {
        // 데이터로 바꾼 편제표는 과목·선택과목군 데이터의 학기 학점을 그대로 쓴다.
        const credits = curriculumDataSubjectCredits(layout);
        rows = plan.map((row) => {
          const resolved = { ...row };
          const own = credits.get(String(row.subject ?? "").replace(/\s+/g, "").toLowerCase()) || {};
          CURRICULUM_SEMESTER_FIELDS.forEach((field) => {
            if (!String(row[field] ?? "").trim()) { resolved[field] = ""; return; }
            const credit = own[field] || Number(row.opCredit) || Number(row.baseCredit) || 0;
            resolved[field] = credit > 0 ? String(credit) : "";
          });
          if (own.crossNames?.length > 1) {
            resolved.crossNames = own.crossNames.slice(); resolved.crossFields = own.crossFields.slice();
            if (own.crossSplit) resolved.crossSplit = own.crossSplit;
          }
          return resolved;
        });
      } else if (plan.length) {
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
        [year, { fileName: cohort?.fileName || "", plan: annualResolvedPlanRows(year, cohort),
          // 학교 양식 전학년 편제표(curriculum-annual.js buildAnnualCurriculumDataLayout)는 입학생 편제표 데이터·양식을 쓴다.
          ...(cohort?.importedLayout?.planData ? { layout: cohort.importedLayout } : {}) }]));
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
      if (typeof ensureCurriculumPlanData === "function") ensureCurriculumPlanData(layout);
      if (typeof curriculumDataApplyCrossSplits === "function") curriculumDataApplyCrossSplits(layout);
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

    // 편제표에서 신청 과목을 모으는 계산(약 40ms)은 집계·그룹·확인서·단계 표시가 여러 번 부르므로 자료(state)·학년도가 그대로면 캐시를 쓴다.
    // 결과는 부르는 쪽이 고칠 수 있어 항상 복사본을 돌려준다(cloneApplicationSubjects).
    function collectApplicationSubjects(options = {}) {
      if (typeof syncActiveCurriculumCohort === "function") syncActiveCurriculumCohort();
      if (!options.fresh && typeof cachedByStateRevision === "function" && typeof cloneApplicationSubjects === "function") {
        const schoolYear = typeof $ === "function" ? $("#schoolYear")?.value || "" : "";
        const key = [options.includeExcluded ? 1 : 0, options.currentGrade ?? state.applicationMenuGrade ?? "1", schoolYear].join("|");
        return cloneApplicationSubjects(cachedByStateRevision("collectApplicationSubjects", key,
          () => collectApplicationSubjects({ ...options, fresh: true })));
      }
      const { includeExcluded = false, currentGrade: requestedCurrentGrade } = options;
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
      // 교차집중 과목은 학생이 고르는 과목이 아니라 학급마다 학기를 엇갈려 이수하므로 선택 그룹·신청 과목에서 뺀다.
      const crossRows = new Set((layout.planData?.subjects || []).filter((item) => !item.fixed && item.cross?.length).map((item) => item.row));
      for (const context of contexts) {
        if (!String(context.division || "").replace(/\s+/g, "").includes("학생선택교육과정")) continue;
        if (crossRows.has(context.rowIndex)) continue;
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

    function cloneApplicationSubjects(result) {
      if (!result) return result;
      return Object.fromEntries(Object.entries(result).map(([grade, items]) => [grade, items.map((item) => ({
        ...item,
        semesterColors: { ...item.semesterColors },
        semesterGroups: Object.fromEntries(Object.entries(item.semesterGroups || {}).map(([semester, group]) => [semester, { ...group }]))
      }))]));
    }

    function selectedApplicationSubjects() {
      return collectApplicationSubjects();
    }

    function applicationCourseLabel(course) {
      const classification = curriculumSelectionType(course.type).replace(/선택$/, "");
      return `${course.subject}${classification ? `(${classification})` : ""}`;
    }

    function renderApplicationSubjects() {
      if (typeof deferRenderUntilStepVisible === "function" && deferRenderUntilStepVisible(2, "renderApplicationSubjects", renderApplicationSubjects)) return;
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
      let nextCourseColumn = 0;
      for (const grade of ["1", "2", "3"]) {
        for (const item of subjects[grade] || []) {
          // 학년이 다른 동일 이름 과목은 표기에 학년을 붙여 구분한다.
          const displayName = nameCount.get(item.subject) > 1 ? `${item.subject}(${grade}학년)` : item.subject;
          const course = {
            column: `app${nextCourseColumn++}`,
            applicationCurrentGrade: String(Number(grade) - 1),
            name: displayName,
            credits: item.credit || 0,
            // 1·2학기에 모두 편성된 과목을 학기 없이 고른 경우는 학기를 비워 두고, 학생들의 그룹 선택 수로 학기를 정한다.
            semesterKey: String(item.semester || "").includes("·") ? "" : String(item.semester || "").match(/[12]/)?.[0] || "",
            applicationSubject: { ...item },
            category: item.area || "선택과목"
          };
          courses.push(course);
          courseByGradeName.set(`${grade}:${item.subject}`, course);
          const semesters = String(item.semester || "").split("·");
          let semesterVariants = 0;
          if (semesters.length > 1) for (const semester of semesters) {
            const subject = `${item.subject} (${semester}학기)`;
            if (!entries.some((entry) => String(Number(entry.grade)+1)===grade && entry.selections?.includes(subject))) continue;
            const semesterCourse = { ...course, column:`app${nextCourseColumn++}`,
              name: nameCount.get(item.subject)>1 ? `${subject}(${grade}학년)` : subject, semesterKey:semester,
              applicationSubject: { ...item, subject, semester } };
            courses.push(semesterCourse);
            courseByGradeName.set(`${grade}:${subject}`,semesterCourse);
            semesterVariants++;
          }
          // 학기별로 나눠 신청받았고 학기 없이 고른 학생이 없으면, 학기 없는 0명 과목을 집계에 남기지 않는다.
          if (semesterVariants && !entries.some((entry) => String(Number(entry.grade)+1)===grade && entry.selections?.includes(item.subject))) {
            courses.splice(courses.indexOf(course), 1);
            courseByGradeName.delete(`${grade}:${item.subject}`);
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

    // sheets: [{ name, rows: [[셀]], widths, merges, freeze, heights, orientation, fitToHeight }]. 셀은 문자열·숫자·null 또는 { v, f, s }.
    // options.stylesXml: 보고서 공통 스타일(0~10번) 뒤에 스타일을 더 둔 styles.xml(5단계 교사시수표 양식).
    function createWorkbookBlob(sheets, options = {}) {
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
        "xl/styles.xml": options.stylesXml || createReportStylesXml()
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
        // 틀 고정: "A5"는 위 4행, "D5"는 위 4행과 왼쪽 3열.
        const freezeMatch = /^([A-Z]+)(\d+)$/.exec(sheet.freeze || "");
        const freezeColumns = freezeMatch ? [...freezeMatch[1]].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1 : 0;
        const freezeRows = freezeMatch ? Number(freezeMatch[2]) - 1 : 0;
        const freeze = freezeMatch && (freezeColumns || freezeRows)
          ? `<sheetViews><sheetView workbookViewId="0"><pane${freezeColumns ? ` xSplit="${freezeColumns}"` : ""}${freezeRows ? ` ySplit="${freezeRows}"` : ""} topLeftCell="${sheet.freeze}" activePane="${freezeColumns && freezeRows ? "bottomRight" : freezeRows ? "bottomLeft" : "topRight"}" state="frozen"/></sheetView></sheetViews>`
          : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
        const merges = (sheet.merges || []).length
          ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((reference) => `<mergeCell ref="${reference}"/>`).join("")}</mergeCells>`
          : "";
        files[`xl/worksheets/sheet${index + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>${freeze}${cols}<sheetData>${rowsXml}</sheetData>${merges}<pageMargins left="0.25" right="0.25" top="0.4" bottom="0.4" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="${sheet.orientation === "portrait" ? "portrait" : "landscape"}" fitToWidth="1" fitToHeight="${Number(sheet.fitToHeight) || 0}"/></worksheet>`;
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
        $("#fileName").textContent = typeof resultFileNameLabel === "function" ? resultFileNameLabel(data) : state.fileName;
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
      // 학년별 결과 파일을 모두 대신하므로 이전 학년별 파일명은 지운다.
      if (state.rounds?.[state.currentRound]) state.rounds[state.currentRound] = {...state.rounds[state.currentRound], gradeFiles: {}};
      $("#fileName").textContent = state.fileName;
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
        (unclassified.length ? ` 그룹 미확인 ${unclassified.length}개: ${typeof describeUnclassifiedCourses === "function" ? describeUnclassifiedCourses(unclassified) : unclassified.join(", ")}. 선택 그룹 또는 파일의 학기 표기를 확인하세요.` : "");
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
      if (!students.length) throw new Error(`현 ${grade}학년(${Number(grade) + 1}학년 과목 신청) 학생이 없는 결과 파일입니다. 파일의 학년 열(현재 학년)에 맞는 탭에서 올려 주세요.`);
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
      state.fileName = typeof resultFileNameLabel === "function"
        ? resultFileNameLabel({gradeFiles})
        : Object.entries(gradeFiles).map(([g,name]) => `현 ${g}학년: ${name}`).join(" / ");
      // 3단계 확인서는 목록(학년·반·번호 순)의 첫 학생부터 보여 준다.
      state.selectedId = state.students[0]?.id || nextStudents[0].id;
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
    // 과목명 글자를 하나씩 대응시켜 맞춘다: 로마 숫자와 아라비아 숫자(Ⅰ↔1, Ⅱ↔2 …)는 같은 글자로, 띄어쓰기는 있어도 없어도 된다.
    // 숫자 자체는 지우지 않으므로 미적분1과 미적분2는 서로 다른 과목이다.
    const COURSE_NAME_EQUIVALENTS = [["Ⅰ", "ⅰ", "1"], ["Ⅱ", "ⅱ", "2"], ["Ⅲ", "ⅲ", "3"], ["Ⅳ", "ⅳ", "4"], ["Ⅴ", "ⅴ", "5"]];
    function courseNamePattern(name) {
      const characters = [...String(name ?? "").replace(/\s+/g, "")].map((character) => {
        const same = COURSE_NAME_EQUIVALENTS.find((group) => group.includes(character));
        return same ? `[${same.join("")}]` : character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      });
      return new RegExp(`^${characters.join("\\s*")}`);
    }

    function splitGoogleFormSelections(text, knownNames, strict = false) {
      const found = [];
      let rest = String(text ?? "");
      const names = [...knownNames].map((name) => ({ name, pattern: courseNamePattern(name), length: String(name).replace(/\s+/g, "").length }))
        .sort((a, b) => b.length - a.length);
      while (rest.trim()) {
        const trimmed = rest.replace(/^[,\s]+/, "");
        if (!trimmed) break;
        let hit = null, matchedLength = 0;
        for (const candidate of names) {
          const match = trimmed.match(candidate.pattern);
          if (match) { hit = candidate.name; matchedLength = match[0].length; break; }
        }
        if (hit) {
          found.push(hit);
          rest = trimmed.slice(matchedLength);
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

    // ---- 집계표 엑셀 시트: 학교 취합 양식(저장소의 '선택과목 수강신청결과 취합 예시.xlsx')을 따른다 ----
    // 열: A 여백, B 항목명, C~H 과목(한 줄에 최대 6과목), 그룹마다 과목 열 바로 오른쪽에 총 학급수, 그 옆에 '신청 합÷택n'.
    function aggregateSheetColumnWidths() {
      return [6.375, 14.75, 16.375, 14.375, 15.75, 16.375, 16.75, 17.625, 10.25, 12];
    }

    // 셀 너비(엑셀 열 너비 단위)에 글자가 몇 줄로 줄바꿈되는지 어림한다. 한글은 숫자 폭의 약 1.8배.
    function aggregateTextLines(text, columnWidth, fontSize = 12, bold = false) {
      const scale = fontSize / 11 * (bold ? 1.06 : 1);
      const unit = (character) => /[ㄱ-ㆎ가-힣一-鿿]/.test(character) ? 1.8
        : /[()[\]·.,:/]/.test(character) ? 0.6 : 1.05;
      const measure = (word) => [...word].reduce((total, character) => total + unit(character), 0) * scale;
      const available = Math.max(1, columnWidth - 1.2);
      let lines = 1;
      let current = 0;
      for (const word of String(text ?? "").split(/\s+/).filter(Boolean)) {
        const width = measure(word);
        const space = current ? 0.55 * scale : 0;
        if (current && current + space + width <= available) {
          current += space + width;
          continue;
        }
        if (current) lines += 1;
        current = width;
        // 한 낱말이 칸보다 길면 글자 단위로 끊긴다.
        while (current > available) { lines += 1; current -= available; }
      }
      return lines;
    }

    // 블록 칸 서식 이름. 양식처럼 블록 바깥은 이중선, 항목명 열 오른쪽·묶음 사이는 굵은 선, 안쪽은 가는 선.
    //   row: head(과목) | count(인원 수) | division(인원수/분반기준) | classes(개설 학급수) | average(학급당 학생수) | value(총 학급수·신청 합 값)
    //   col: label(B열) | subject | total(총 학급수) | memo(신청 합÷택n)
    function aggregateBlockStyle(row, col, { firstUnit = true, lastUnit = true, firstColumn = false, lastColumn = false, closed = false } = {}) {
      const boxed = col === "total" || col === "memo";
      const left = col === "label" || col === "memo" ? "d" : col === "total" || firstColumn ? "m" : "t";
      const right = col === "label" || lastColumn && col === "subject" ? "m" : boxed ? "d" : "t";
      const top = boxed || row === "count" || row === "head" && firstUnit ? "d" : row === "head" ? "m" : "t";
      const bottom = boxed || row === "head" ? "d" : row === "average" ? (lastUnit ? "d" : "m") : "t";
      let font = "body", format = "general", wrap = 0;
      if (col === "label") font = row === "division" ? "small" : "body";
      else if (col === "subject") {
        if (row === "head") { font = "bold"; wrap = 1; } else if (row === "division" || row === "average") format = "two";
      } else if (col === "total") { font = "bold"; wrap = row === "head" ? 1 : 0; }
      else { font = "small"; wrap = row === "head" ? 1 : 0; format = row === "head" ? "general" : "one"; }
      const fill = closed && col === "subject" && (row === "count" || row === "division") ? "yellow" : "none";
      return [font, format, fill, "c", wrap, left + right + top + bottom].join("|");
    }

    // 집계표 시트가 쓰는 서식 목록(styles.xml의 11번 뒤에 붙는다). createStylesXml과 createWorksheetXml이 같은 목록을 쓴다.
    function aggregateSheetStyles() {
      if (aggregateSheetStyles.cache) return aggregateSheetStyles.cache;
      const keys = new Set([
        "title|general|none|c|0|---m", "small|general|none|r|0|----", "small|general|none|c|1|----",
        "bold|general|none|c|1|mtmm", "bold|general|none|c|1|ttmm", "bold|general|none|c|1|tmmm",
        "bold|two|none|c|1|tmmm", "bold|two|yellow|c|1|tmmm",
        "semester|general|none|c|0|mmmm", "bold|general|none|l|0|----", "note|general|none|l|0|----"
      ]);
      const flags = [false, true];
      for (const row of ["head", "count", "division", "classes", "average"]) {
        for (const firstUnit of flags) for (const lastUnit of flags) {
          keys.add(aggregateBlockStyle(row, "label", { firstUnit, lastUnit }));
          for (const firstColumn of flags) for (const lastColumn of flags) for (const closed of flags) {
            keys.add(aggregateBlockStyle(row, "subject", { firstUnit, lastUnit, firstColumn, lastColumn, closed }));
          }
        }
      }
      for (const row of ["head", "value"]) for (const col of ["total", "memo"]) keys.add(aggregateBlockStyle(row, col));
      const list = [...keys];
      const borders = [...new Set(list.map((key) => key.split("|")[5]))];
      aggregateSheetStyles.cache = {
        list,
        borders,
        fonts: ["title", "semester", "bold", "body", "small", "note"],
        index: new Map(list.map((key, offset) => [key, 11 + offset]))
      };
      return aggregateSheetStyles.cache;
    }

    // 집계표 한 학년 시트의 칸 모델. 엑셀(createWorksheetXml)과 4단계 화면(aggregateSheetHtml)이 같은 모델을 써서 어긋나지 않는다.
    //   칸: { kind: "s"|"n"|"f"|"blank", value, expression, key(서식 이름), meta(화면용 역할·과목·그룹) }
    //   행: { cells, height, kind: "head"|"semester"|"group", semesterIndex, groupIndex } — 화면의 '처리할 것만'이 그룹 단위로 행을 고른다.
    function aggregateSheetModel(report, openingPercent, divisionPercent) {
      const { summary, semesters } = report;
      const widths = aggregateSheetColumnWidths();
      const lastColumn = widths.length - 1;
      const UNIT_SIZE = 6;
      const rows = [];
      const merges = [];
      const rules = [];
      const chunks = [];
      const groups = [];
      let place = { kind: "head", semesterIndex: null, groupIndex: null };
      const addRow = (height) => { rows.push({ cells: [], height, ...place }); return rows.length; };
      const put = (row, column, cell) => { rows[row - 1].cells[column] = cell; };
      const text = (row, column, value, key, meta) => put(row, column, { kind: "s", value, key, meta });
      const number = (row, column, value, key, meta) => put(row, column, { kind: "n", value, key, meta });
      const formula = (row, column, expression, cached, key, meta) => put(row, column, { kind: "f", expression, value: cached, key, meta });
      const blank = (row, column, key, meta) => put(row, column, { kind: "blank", key, meta });
      const cellRef = (column, row) => `${columnName(column)}${row}`;
      const rangeRef = (firstColumn, firstRow, lastMergeColumn, lastRow) =>
        firstColumn === lastMergeColumn && firstRow === lastRow ? cellRef(firstColumn, firstRow)
          : `${cellRef(firstColumn, firstRow)}:${cellRef(lastMergeColumn, lastRow)}`;
      // 병합 범위의 나머지 칸에도 같은 서식을 넣어야 엑셀이 병합 칸 테두리를 빠짐없이 그린다.
      const merge = (firstColumn, firstRow, lastMergeColumn, lastRow, key) => {
        merges.push({ ref: rangeRef(firstColumn, firstRow, lastMergeColumn, lastRow), firstColumn, firstRow, lastColumn: lastMergeColumn, lastRow });
        for (let row = firstRow; row <= lastRow; row++) {
          for (let column = firstColumn; column <= lastMergeColumn; column++) {
            if (!rows[row - 1].cells[column]) blank(row, column, key);
          }
        }
      };
      const confirmDigits = String($("#confirmDate").value || "").match(/\d+/g) || [];
      const today = new Date();
      const shortDate = confirmDigits.length >= 2
        ? `${confirmDigits[0]}.${Number(confirmDigits[1])}.`
        : String($("#confirmDate").value || "").trim() || `${today.getFullYear()}.${today.getMonth() + 1}.`;
      const classes = Number(summary.classes) || 0;
      const students = Number(summary.students) || 0;
      const factor = (percent) => String(Number((percent / 100).toFixed(4)));
      const divisionLimit = Number(summary.divisionLimit) || 0;

      // 1~3행: 제목과 기준 칸. 값은 엑셀에서 고쳐도 따라 바뀌도록 수식으로 둔다(학급 수는 내년 학급 수 입력값 또는 명단 반 수).
      const titleRow = addRow(54.6);
      text(titleRow, 1, `${Number(summary.grade) + 1}학년(현${summary.grade}학년) 수강신청결과(${$("#round").value || "1차"})`, "title|general|none|c|0|---m");
      merge(1, titleRow, 6, titleRow, "title|general|none|c|0|---m");
      text(titleRow, lastColumn, shortDate, "small|general|none|r|0|----");
      const openingRow = addRow(35.45);
      const divisionRow = addRow(35.45);
      text(openingRow, 1, "총학생수", "bold|general|none|c|1|mtmm");
      number(openingRow, 2, students, "bold|general|none|c|1|ttmm", { role: "students" });
      text(openingRow, 3, "학급당 학생수", "bold|general|none|c|1|ttmm");
      if (classes > 0) formula(openingRow, 4, `C2/${classes}`, students / classes, "bold|two|none|c|1|tmmm", { role: "perClass" });
      else number(openingRow, 4, 0, "bold|two|none|c|1|tmmm", { role: "perClass" });
      text(openingRow, 5, `학급당 학생수의 ${openingPercent}%(개설기준)`, "bold|general|none|c|1|mtmm");
      merge(5, openingRow, 6, openingRow, "bold|general|none|c|1|ttmm");
      if (classes > 0) formula(openingRow, 7, `C2/${classes}*${factor(openingPercent)}`, Number(summary.openingLimit) || 0, "bold|two|yellow|c|1|tmmm", { role: "opening" });
      else number(openingRow, 7, 0, "bold|two|yellow|c|1|tmmm", { role: "opening" });
      text(divisionRow, 5, `학급당 학생수의 ${divisionPercent}%(분반기준)`, "bold|general|none|c|1|mtmm");
      merge(5, divisionRow, 6, divisionRow, "bold|general|none|c|1|ttmm");
      if (classes > 0) formula(divisionRow, 7, `C2/${classes}*${factor(divisionPercent)}`, divisionLimit, "bold|two|none|c|1|tmmm", { role: "division" });
      else number(divisionRow, 7, 0, "bold|two|none|c|1|tmmm", { role: "division" });
      text(openingRow, 8, "학급당 학생수는 개설기준과 분반기준의 사이가 되도록 조정", "small|general|none|c|1|----");
      merge(8, openingRow, 9, divisionRow, "small|general|none|c|1|----");
      const divisionCell = "$H$3";

      for (const [semesterIndex, semester] of semesters.entries()) {
        place = { kind: "semester", semesterIndex, groupIndex: null };
        const semesterStart = semesterIndex > 0 ? addRow(18) : rows.length + 1;
        const semesterRow = addRow(36.6);
        text(semesterRow, 1, semester.name, "semester|general|none|c|0|mmmm");
        merge(1, semesterRow, 2, semesterRow, "semester|general|none|c|0|mmmm");

        for (const [groupIndex, group] of semester.groups.entries()) {
          place = { kind: "group", semesterIndex, groupIndex };
          const chunkStart = groupIndex === 0 ? semesterStart : addRow(18);
          chunks.push({ start: chunkStart, semesterIndex, semesterStart: groupIndex === 0 });
          const groupLabel = typeof aggregateGroupLabel === "function" ? aggregateGroupLabel(semester, group) : group.category;
          const choiceCount = Number(group.choiceCount);
          const hasChoice = Number.isInteger(choiceCount) && choiceCount > 0;
          const target = hasChoice && Number.isInteger(classes) && classes > 0 ? choiceCount * classes : null;
          const courses = group.courses;
          const groupTotal = courses.reduce((total, course) => total + (Number(course.classCount) || 0), 0);
          const enrollmentTotal = courses.reduce((total, course) => total + (Number(course.enrollment) || 0), 0);
          const info = { semesterIndex, groupIndex, semester, group, label: groupLabel, target, choiceCount: hasChoice ? choiceCount : null,
            total: groupTotal, enrollmentTotal };
          groups.push(info);
          // 그룹 이름은 블록 위 소제목 줄에 한 번만 쓴다(묶음이 여러 개여도 머리 칸은 모두 '과목').
          const labelRow = addRow(22);
          text(labelRow, 1, groupLabel, "bold|general|none|l|0|----", { role: "group-label", group: info });
          if (target !== null) text(labelRow, 3, `목표 총 학급수 ${target} (택${choiceCount} × ${classes}학급)`, "note|general|none|l|0|----", { role: "group-note", group: info });

          // 과목이 6개를 넘으면 고르게 나눠 여러 묶음으로 이어 쓴다(8과목 → 4+4, 16과목 → 6+5+5).
          const unitCount = Math.max(1, Math.ceil(courses.length / UNIT_SIZE));
          const baseSize = Math.floor(courses.length / unitCount);
          const units = [];
          for (let index = 0, offset = 0; index < unitCount; index++) {
            const size = baseSize + (index < courses.length % unitCount ? 1 : 0);
            units.push(courses.slice(offset, offset + size));
            offset += size;
          }
          const width = Math.max(1, ...units.map((unit) => unit.length));
          const totalColumn = 2 + width;
          const memoColumn = totalColumn + 1;
          const groupFirstRow = rows.length + 1;
          const groupLastRow = groupFirstRow + units.length * 5 - 1;
          const classRanges = [];
          const countRanges = [];
          const memoHeader = hasChoice ? `신청 합÷택${choiceCount}` : "신청 합";
          units.forEach((unit, unitIndex) => {
            const firstUnit = unitIndex === 0;
            const lastUnit = unitIndex === units.length - 1;
            // 과목명이 길면 그 머리 줄만 높여 두 줄이 모두 보이게 한다.
            const lines = Math.max(1, ...unit.map((course, index) =>
              aggregateTextLines(course.displayName || course.name, widths[2 + index], 12, true)),
            firstUnit ? aggregateTextLines("총 학급수", widths[totalColumn], 12, true) : 1,
            firstUnit ? aggregateTextLines(memoHeader, widths[memoColumn], 11) : 1);
            const head = addRow(lines > 1 ? Math.round((lines * 18 + 1.5) * 4) / 4 : 18.75);
            const metric = { count: addRow(18), division: addRow(17.25), classes: addRow(17.25), average: addRow(18) };
            const labels = { head: "과목", count: "인원 수", division: "인원수/분반기준", classes: "개설 학급수", average: "학급당 학생수" };
            const rowOf = { head, ...metric };
            for (const [role, label] of Object.entries(labels)) {
              text(rowOf[role], 1, label, aggregateBlockStyle(role, "label", { firstUnit, lastUnit }));
            }
            for (let index = 0; index < width; index++) {
              const column = 2 + index;
              const course = unit[index];
              const options = { firstUnit, lastUnit, firstColumn: index === 0, lastColumn: index === width - 1,
                closed: !!course && (course.closed || !course.classCount) };
              const key = (role) => aggregateBlockStyle(role, "subject", options);
              if (!course) {
                for (const role of Object.keys(labels)) blank(rowOf[role], column, key(role), { role: "filler", group: info });
                continue;
              }
              const meta = (role) => ({ role, course, group: info });
              const enrollment = Number(course.enrollment) || 0;
              const classCount = Number(course.classCount) || 0;
              text(head, column, course.displayName || course.name, key("head"), meta("head"));
              number(metric.count, column, enrollment, key("count"), meta("count"));
              if (course.closed) text(metric.division, column, "폐강", key("division"), meta("division"));
              else if (divisionLimit > 0) formula(metric.division, column, `${cellRef(column, metric.count)}/${divisionCell}`, enrollment / divisionLimit, key("division"), meta("division"));
              else number(metric.division, column, 0, key("division"), meta("division"));
              // 개설 학급수는 앱의 값(자동 조정·직접 입력 반영, 폐강 0)을 그대로 쓴다.
              number(metric.classes, column, classCount, key("classes"), meta("classes"));
              if (classCount > 0) formula(metric.average, column, `${cellRef(column, metric.count)}/${cellRef(column, metric.classes)}`, enrollment / classCount, key("average"), meta("average"));
              else blank(metric.average, column, key("average"), meta("average"));
            }
            classRanges.push(rangeRef(2, metric.classes, 1 + width, metric.classes));
            countRanges.push(rangeRef(2, metric.count, 1 + width, metric.count));
            if (firstUnit) {
              text(head, totalColumn, "총 학급수", aggregateBlockStyle("head", "total"));
              text(head, memoColumn, memoHeader, aggregateBlockStyle("head", "memo"));
            }
          });
          // 총 학급수·신청 합은 그룹의 첫 '인원 수' 줄부터 마지막 줄까지 한 칸으로 병합한다.
          const valueRow = groupFirstRow + 1;
          formula(valueRow, totalColumn, `SUM(${classRanges.join(",")})`, groupTotal, aggregateBlockStyle("value", "total"), { role: "total", group: info });
          merge(totalColumn, valueRow, totalColumn, groupLastRow, aggregateBlockStyle("value", "total"));
          // 신청 합÷택n: 모든 학생이 그룹에서 n과목씩 신청했으면 총학생수와 같아 누락·중복을 확인할 수 있다.
          formula(valueRow, memoColumn, `SUM(${countRanges.join(",")})${hasChoice ? `/${choiceCount}` : ""}`,
            hasChoice ? enrollmentTotal / choiceCount : enrollmentTotal, aggregateBlockStyle("value", "memo"), { role: "memo", group: info });
          merge(memoColumn, valueRow, memoColumn, groupLastRow, aggregateBlockStyle("value", "memo"));
          // 목표(택n × 학급 수)나 총학생수와 다르면 연한 경고색(엑셀에서 학급수를 고치면 따라 바뀐다).
          if (target !== null) rules.push({ ref: cellRef(totalColumn, valueRow), value: String(target) });
          if (hasChoice) rules.push({ ref: cellRef(memoColumn, valueRow), value: "$C$2" });
        }
      }

      // 양식처럼 A4 세로에 B열부터 너비를 맞춰 인쇄하고(A열은 여백), 블록이 쪽 사이에서 잘리지 않게
      // 그룹(가능하면 학기) 경계에서 쪽을 나눈다. 열 너비 1 = 약 8px(맑은 고딕 11pt), 8% 여유.
      const heightOf = (firstRow, lastRow) => rows.slice(firstRow - 1, lastRow).reduce((total, row) => total + row.height, 0);
      const widthPx = widths.slice(1).reduce((total, value) => total + Math.floor(value * 8 + 5), 0);
      const printScale = Math.min(1, (8.27 - 1.42) * 96 / widthPx);
      const capacity = (11.69 - 1.5) * 72 / printScale * 0.92 - heightOf(1, 3);
      const breaks = [];
      let used = 0;
      chunks.forEach((chunk, index) => {
        const nextStart = chunks[index + 1]?.start ?? rows.length + 1;
        const height = heightOf(chunk.start, nextStart - 1);
        let breakHere = used > 0 && used + height > capacity;
        if (!breakHere && used > 0 && chunk.semesterStart) {
          const semesterEnd = (chunks.find((item, later) => later > index && item.semesterStart)?.start ?? rows.length + 1) - 1;
          const semesterHeight = heightOf(chunk.start, semesterEnd);
          breakHere = used + semesterHeight > capacity && semesterHeight <= capacity;
        }
        if (breakHere) { breaks.push(chunk.start - 1); used = 0; }
        used += height;
      });
      return { summary, widths, lastColumn, rows, merges, rules, breaks, groups };
    }

    function createWorksheetXml(report, openingPercent, divisionPercent) {
      const { widths, lastColumn, rows, merges, rules, breaks } = aggregateSheetModel(report, openingPercent, divisionPercent);
      const styles = aggregateSheetStyles();
      const style = (key) => {
        const id = styles.index.get(key);
        if (id === undefined) throw new Error(`집계표 서식이 없습니다: ${key}`);
        return id;
      };
      const cellRef = (column, row) => `${columnName(column)}${row}`;
      const numberText = (value) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? String(Number(numeric.toPrecision(15))) : "0";
      };
      const rowsXml = rows.map((row, rowIndex) => {
        const cells = [];
        for (let column = 0; column < row.cells.length; column++) {
          const cell = row.cells[column];
          if (!cell) continue;
          const reference = cellRef(column, rowIndex + 1);
          const id = style(cell.key);
          if (cell.kind === "blank") cells.push(`<c r="${reference}" s="${id}"/>`);
          else if (cell.kind === "n") cells.push(`<c r="${reference}" s="${id}"><v>${numberText(cell.value)}</v></c>`);
          else if (cell.kind === "f") cells.push(`<c r="${reference}" s="${id}"><f>${xmlEscape(cell.expression)}</f><v>${numberText(cell.value)}</v></c>`);
          else cells.push(`<c r="${reference}" s="${id}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell.value)}</t></is></c>`);
        }
        return `<row r="${rowIndex + 1}" ht="${row.height}" customHeight="1">${cells.join("")}</row>`;
      }).join("");
      const columns = widths.map((width, index) =>
        `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
      const mergeXml = merges.length
        ? `<mergeCells count="${merges.length}">${merges.map((item) => `<mergeCell ref="${item.ref}"/>`).join("")}</mergeCells>`
        : "";
      const ruleXml = rules.map((rule, index) =>
        `<conditionalFormatting sqref="${rule.ref}"><cfRule type="cellIs" dxfId="0" priority="${index + 1}" operator="notEqual"><formula>${rule.value}</formula></cfRule></conditionalFormatting>`).join("");
      const breakXml = breaks.length
        ? `<rowBreaks count="${breaks.length}" manualBreakCount="${breaks.length}">${breaks.map((id) => `<brk id="${id}" max="16383" man="1"/>`).join("")}</rowBreaks>`
        : "";
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${cellRef(lastColumn, rows.length)}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="16.5"/><cols>${columns}</cols><sheetData>${rowsXml}</sheetData>${mergeXml}${ruleXml}<pageMargins left="0.71" right="0.71" top="0.75" bottom="0.75" header="0.31" footer="0.31"/><pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/>${breakXml}</worksheet>`;
    }

    // 화면용 칸 서식: 엑셀 서식 이름 → CSS 클래스와 테두리(가는 선·굵은 선·이중선). 같은 이름은 한 번만 계산한다.
    function aggregateSheetCellCss(key) {
      const cache = aggregateSheetCellCss.cache || (aggregateSheetCellCss.cache = new Map());
      if (cache.has(key)) return cache.get(key);
      const [font, format, fill, align, wrap, border] = String(key).split("|");
      const line = { t: "1px solid #3a3a3a", m: "2px solid #111", d: "3px double #111" };
      const style = ["left", "right", "top", "bottom"].map((side, index) =>
        line[border?.[index]] ? `border-${side}:${line[border[index]]}` : "").filter(Boolean).join(";");
      const result = { className: `af-${font} af-${align}${wrap === "1" ? " af-wrap" : ""}${fill === "yellow" ? " af-yellow" : ""}`, style, format };
      cache.set(key, result);
      return result;
    }

    // 4단계 화면의 집계표: 엑셀 시트와 같은 모델(aggregateSheetModel)을 같은 열 너비·행 높이·병합·테두리로 그리고,
    // 양식 안에서 개설 학급수 고치기(입력 칸), 과목명 메뉴(개설·폐강·미정), 그룹 총 학급수 칸의 자동 조정·조정 취소,
    // 과목 칸 모서리 표시(기준 미달·인원 초과·위계 경고)를 붙인다. attention: aggregateAttention 결과('처리할 것만').
    function aggregateSheetHtml(model, { grade = "", closures = {}, round = "", locked = false, maxClassSize = 34, prereq = null,
      attention = null, undoGroups = null } = {}) {
      const { summary, widths, lastColumn, rows, merges, groups } = model;
      const esc = typeof escapeHtml === "function" ? escapeHtml : (value) => String(value ?? "");
      const gradeKey = String(grade || summary.grade);
      // A열(여백)은 화면에 그리지 않는다. 열 너비는 엑셀과 같은 비율(1 = 약 8px).
      const columnPx = widths.map((width) => Math.floor(width * 8 + 5));
      const tableWidth = columnPx.slice(1).reduce((total, value) => total + value, 0);
      const anchors = new Map();
      const covered = new Set();
      for (const item of merges) {
        anchors.set(`${item.firstRow}:${item.firstColumn}`, item);
        for (let row = item.firstRow; row <= item.lastRow; row++) {
          for (let column = item.firstColumn; column <= item.lastColumn; column++) {
            if (row !== item.firstRow || column !== item.firstColumn) covered.add(`${row}:${column}`);
          }
        }
      }
      const groupId = (info) => `${info.semester.name}\u0000${info.group.category}`;
      const courseKey = (course) => `${gradeKey}:${course.column}`;
      const shown = new Set(groups.filter((info) => !attention || attention.groups.has(groupId(info)) ||
        info.group.courses.some((course) => attention.courses.has(courseKey(course)))).map((info) => `${info.semesterIndex}:${info.groupIndex}`));
      const semestersShown = new Set([...shown].map((id) => id.split(":")[0]));
      const rowShown = (row) => row.kind === "group" ? shown.has(`${row.semesterIndex}:${row.groupIndex}`)
        : row.kind === "semester" ? semestersShown.has(String(row.semesterIndex)) : true;
      const statuses = new Map();
      const statusOf = (course) => {
        if (statuses.has(course)) return statuses.get(course);
        const key = courseKey(course);
        const decision = aggregateClosureDecision(closures, key, course.atRisk);
        const { over, overDivision } = aggregateCourseWarnings(course, summary, maxClassSize);
        const prereqCount = prereq?.courses?.get(key)?.violators?.size || 0;
        const average = (Number(course.averageClassSize) || 0).toFixed(1);
        const lines = [];
        if (course.closed) lines.push("폐강으로 정한 과목입니다(개설 학급수 0, 다음 차수 재신청 대상).");
        if (course.atRisk) lines.push(`기준 미달: 신청 ${course.enrollment}명이 개설기준 ${Number(summary.openingLimit || 0).toFixed(2)}명보다 적습니다(폐강 확정 아님).`);
        if (over) lines.push(`${maxClassSize}명 초과: 학급당 ${average}명이 최대 인원 ${maxClassSize}명을 넘습니다.`);
        if (overDivision) lines.push(`분반기준 초과: 학급당 ${average}명이 분반기준 ${Number(summary.divisionLimit || 0).toFixed(2)}명을 넘습니다. 학급수를 늘리는 것을 검토하세요.`);
        if (prereqCount) lines.push(`위계 경고 ${prereqCount}명: 선이수 과목 없이 신청한 학생이 있습니다.`);
        if (!course.closed && decision === "") lines.push("교사 결정이 미정입니다. 개설 또는 폐강을 고르세요.");
        if (!lines.length) lines.push("충족: 개설기준 이상이고 학급당 인원이 기준 안에 있습니다.");
        const status = { key, decision, over, overDivision, prereqCount, lines, focus: attention ? attention.courses.has(key) : null };
        statuses.set(course, status);
        return status;
      };
      const formatValue = (cell, format) => {
        if (cell.kind === "blank") return "";
        if (cell.kind === "s") return esc(cell.value);
        const numeric = Number(cell.value);
        if (!Number.isFinite(numeric)) return "";
        return format === "two" ? numeric.toFixed(2) : format === "one" ? numeric.toFixed(1) : String(Number(numeric.toPrecision(15)));
      };
      const lockNote = locked ? "확정된 차수입니다. 확정 해제 후 수정하세요." : "";
      // 모서리 표시가 있는 칸은 그만큼 안쪽 여백을 줘서 가운데 값과 겹치지 않게 한다(글자 수로 어림).
      const cornerPad = (label) => Math.round([...String(label)].reduce((total, character) =>
        total + (/[가-힣]/.test(character) ? 10.5 : 6.5), 0) + 14);
      const cellContent = (cell, format, classes, attrs, styles) => {
        const meta = cell.meta;
        const value = formatValue(cell, format);
        if (!meta) return value;
        const { role, course, group: info } = meta;
        if (role === "perClass") {
          attrs.push(`title="${esc(`${summary.students}명 ÷ ${summary.classes}학급(${summary.classSource === "planned" ? "내년도 편성 입력값" : "명단의 반 수"})`)}"`);
          return value;
        }
        if (role === "students") { attrs.push('title="이 차수 신청 결과의 학생 수"'); return value; }
        if (role === "group-note" && info) {
          const diff = info.target === null ? 0 : info.total - info.target;
          const plan = diff && typeof planGroupClassCounts === "function"
            ? planGroupClassCounts(aggregatePlanCourses({ summary }, info.group), info.target, maxClassSize) : null;
          return `${value}${diff ? ` <span class="af-group-diff">· 현재 ${info.total}학급 (${diff > 0 ? "+" : ""}${diff})</span>` : ' <span class="af-group-ok">· 일치 ✓</span>'}${plan && !plan.ok ? ` <span class="af-plan-message">${esc(aggregatePlanMessage(plan))}</span>` : ""}`;
        }
        if (role === "total" && info) {
          const diff = info.target === null ? 0 : info.total - info.target;
          const crowded = info.group.courses.some((item) => aggregateCourseWarnings(item, summary, maxClassSize).over);
          if (diff) classes.push("af-off");
          if (attention?.groups.has(groupId(info))) classes.push("is-attention");
          const parts = [`<span class="af-total-value">${value}</span>`];
          if (info.target !== null) parts.push(`<span class="af-total-target">목표 ${info.target}${diff ? ` (${diff > 0 ? "+" : ""}${diff})` : " ✓"}</span>`);
          const lock = locked ? ` disabled title="${lockNote}"` : "";
          if (info.target !== null && (diff || crowded)) {
            parts.push(`<button type="button" class="af-mini-button" data-aggregate-adjust="group" data-grade="${esc(gradeKey)}" data-semester="${esc(info.semester.name)}" data-group="${esc(info.group.category)}"${lock} aria-label="${esc(info.label)} 학급수 자동 조정"><span>학급수</span> <span>자동 조정</span></button>`);
          }
          if (undoGroups?.has(groupId(info))) {
            parts.push(`<button type="button" class="af-mini-button" data-aggregate-undo="${esc(gradeKey)}"${lock} aria-label="${esc(info.label)} 학급수 조정 취소">조정 취소</button>`);
          }
          return parts.join("");
        }
        if (role === "memo" && info) {
          if (info.choiceCount && info.enrollmentTotal !== info.choiceCount * (Number(summary.students) || 0)) {
            classes.push("af-off");
            attrs.push(`title="${esc(`신청 합 ${info.enrollmentTotal} ÷ 택${info.choiceCount}이 총학생수 ${summary.students}명과 다릅니다(신청 누락·중복 확인).`)}"`);
          }
          return value;
        }
        if (!course) return value;
        const status = statusOf(course);
        const name = course.displayName || course.name;
        if (status.focus === true) classes.push("is-attention");
        else if (status.focus === false) classes.push("is-dimmed");
        if (course.closed) classes.push("is-closed");
        const infoButton = (label, className, title) =>
          `<button type="button" class="af-tag ${className}" data-aggregate-course-info="${esc(status.key)}" title="${esc(title)}">${label}</button>`;
        if (role === "head") {
          const undecided = !course.closed && status.decision === "";
          if (undecided) classes.push("is-undecided");
          if (course.atRisk && !course.closed) classes.push("is-risk");
          return `<button type="button" class="af-course" data-aggregate-course="${esc(status.key)}" data-closure-round="${esc(round)}" data-decision="${esc(status.decision)}" data-course-label="${esc(name)}" data-group-label="${esc(info.label)}" data-course-status="${esc(status.lines.join("\n"))}" data-prereq-count="${status.prereqCount}"${locked ? " data-locked" : ""} aria-haspopup="dialog" aria-label="${esc(`${name} — 개설/폐강/미정 결정(지금 ${status.decision === "open" ? "개설" : status.decision === "closed" ? "폐강" : "미정"})`)}">${value}</button>`;
        }
        if (role === "count") {
          if (course.atRisk && !course.closed) classes.push("is-risk");
          const tagLabel = course.closed ? "" : course.atRisk ? "미달" : status.decision === "" ? "미정" : "";
          const tag = tagLabel ? infoButton(tagLabel, course.atRisk ? "is-risk" : "is-undecided", status.lines.join("\n")) : "";
          const badge = status.prereqCount && typeof courseCheckCourseBadges === "function" ? courseCheckCourseBadges(prereq, status.key, name) : "";
          if (tag) styles.push(`padding-left:${cornerPad(tagLabel)}px`);
          if (badge) styles.push(`padding-right:${cornerPad(`위계 경고 ${status.prereqCount}`)}px`);
          return `${tag ? `<span class="af-corner af-corner-left">${tag}</span>` : ""}${value}${badge ? `<span class="af-corner af-corner-right">${badge}</span>` : ""}`;
        }
        if (role === "classes") {
          const lock = locked ? ` disabled title="${lockNote}"`
            : course.closed ? ' disabled title="폐강으로 정한 과목은 0학급입니다. 과목명을 눌러 결정을 바꾸면 수정할 수 있습니다."' : "";
          return `<input class="aggregate-class-input af-class-input" type="number" min="0" step="1" value="${esc(course.classCount)}" aria-label="${esc(info.semester.name)} ${esc(name)} 개설 학급수${course.closed ? " (폐강)" : ""}" data-grade="${esc(gradeKey)}" data-course-column="${esc(course.column)}" data-focus-key="aggregate-class:${esc(gradeKey)}:${esc(course.column)}"${lock}>`;
        }
        if (role === "average" && (status.over || status.overDivision)) {
          classes.push("is-over");
          const label = status.over ? `${maxClassSize}명 초과` : "분반기준 초과";
          styles.push(`padding-right:${cornerPad(label)}px`);
          return `${value}<span class="af-corner af-corner-right">${infoButton(label, "is-over", status.lines.join("\n"))}</span>`;
        }
        return value;
      };
      const body = [];
      rows.forEach((row, rowIndex) => {
        if (!rowShown(row)) return;
        const rowNumber = rowIndex + 1;
        const cells = [];
        for (let column = 1; column <= lastColumn; column++) {
          if (covered.has(`${rowNumber}:${column}`)) continue;
          const span = anchors.get(`${rowNumber}:${column}`);
          const spanAttrs = span ? `${span.lastColumn > span.firstColumn ? ` colspan="${span.lastColumn - span.firstColumn + 1}"` : ""}${span.lastRow > span.firstRow ? ` rowspan="${span.lastRow - span.firstRow + 1}"` : ""}` : "";
          const cell = row.cells[column];
          if (!cell) { cells.push(`<td${spanAttrs}></td>`); continue; }
          const css = aggregateSheetCellCss(cell.key);
          const classes = [css.className];
          const attrs = [];
          const styles = css.style ? [css.style] : [];
          if (cell.meta?.role) attrs.push(`data-af-role="${cell.meta.role}"`);
          const content = cellContent(cell, css.format, classes, attrs, styles);
          cells.push(`<td class="${classes.join(" ")}"${styles.length ? ` style="${styles.join(";")}"` : ""}${spanAttrs}${attrs.length ? ` ${attrs.join(" ")}` : ""}>${content}</td>`);
        }
        body.push(`<tr style="height:${Math.round(row.height * 1.2)}px">${cells.join("")}</tr>`);
      });
      const columns = columnPx.slice(1).map((value) => `<col style="width:${(value / tableWidth * 100).toFixed(3)}%">`).join("");
      const empty = !groups.length ? '<p class="aggregate-empty">집계할 과목이 없습니다.</p>'
        : attention && !shown.size ? '<p class="aggregate-empty">처리할 과목이 없습니다. 미정인 기준 미달 과목, 학급당 인원 초과, 위계 경고, 목표 학급수 불일치가 모두 없습니다.</p>' : "";
      return `<div class="aggregate-sheet-wrap aggregate-form-wrap"><table class="aggregate-form${attention ? " is-attention-mode" : ""}" data-aggregate-form="${esc(gradeKey)}" style="max-width:${tableWidth}px"><colgroup>${columns}</colgroup><tbody>${body.join("")}</tbody></table>${empty}</div>`;
    }

    // 4단계 집계표 엑셀의 학년 시트 이름(양식처럼 신청 학년만: '2학년', '3학년')과 인쇄 설정.
    function aggregateSheetName(report) {
      return `${Number(report.summary.grade) + 1}학년`;
    }

    // printTitles가 있는 시트는 쪽마다 그 행(제목·기준 칸)을 되풀이하고, 인쇄 영역은 양식처럼 B열부터로 한다.
    function aggregateWorkbookExtrasXml(sheets) {
      const names = sheets.map((sheet, index) => {
        if (!sheet.printTitles) return "";
        const quoted = `'${xmlEscape(String(sheet.name).replace(/'/g, "''"))}'`;
        const dimension = String(sheet.xml || "").match(/<dimension ref="A1:([A-Z]+)(\d+)"/);
        const area = dimension ? `<definedName name="_xlnm.Print_Area" localSheetId="${index}">${quoted}!$B$1:$${dimension[1]}$${dimension[2]}</definedName>` : "";
        return `${area}<definedName name="_xlnm.Print_Titles" localSheetId="${index}">${quoted}!${sheet.printTitles}</definedName>`;
      }).join("");
      return `${names ? `<definedNames>${names}</definedNames>` : ""}<calcPr calcId="191029" fullCalcOnLoad="1"/>`;
    }

    function createStylesXml() {
      // 앞의 0~10번 서식은 다른 내려받기(재신청 대상자 등)가 번호로 쓰므로 그대로 두고, 집계표 서식은 11번부터 덧붙인다.
      const sheet = aggregateSheetStyles();
      const fontXml = {
        title: '<sz val="24"/>', semester: '<sz val="18"/>', bold: '<b/><sz val="12"/>',
        body: '<sz val="12"/>', small: '<sz val="11"/>', note: '<sz val="11"/><color rgb="FF595959"/>'
      };
      const lineStyle = { t: "thin", m: "medium", d: "double" };
      const side = (name, code) => lineStyle[code] ? `<${name} style="${lineStyle[code]}"><color indexed="64"/></${name}>` : `<${name}/>`;
      const borderXml = sheet.borders.map((code) =>
        `<border>${side("left", code[0])}${side("right", code[1])}${side("top", code[2])}${side("bottom", code[3])}<diagonal/></border>`).join("");
      const formatId = { general: 0, two: 165, one: 166 };
      const xfXml = sheet.list.map((key) => {
        const [font, format, fill, align, wrap, border] = key.split("|");
        const horizontal = { c: "center", l: "left", r: "right" }[align];
        return `<xf numFmtId="${formatId[format]}" fontId="${3 + sheet.fonts.indexOf(font)}" fillId="${fill === "yellow" ? 3 : 0}" borderId="${2 + sheet.borders.indexOf(border)}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="${horizontal}" vertical="center"${wrap === "1" ? ' wrapText="1"' : ""}/></xf>`;
      }).join("");
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <numFmts count="3"><numFmt numFmtId="164" formatCode="0.00"/><numFmt numFmtId="165" formatCode="0.00_ "/><numFmt numFmtId="166" formatCode="0.0_ "/></numFmts>
          <fonts count="${3 + sheet.fonts.length}">
            <font><sz val="11"/><name val="맑은 고딕"/><family val="2"/></font>
            <font><b/><sz val="18"/><name val="맑은 고딕"/><family val="2"/></font>
            <font><b/><sz val="10"/><name val="맑은 고딕"/><family val="2"/></font>
            ${sheet.fonts.map((font) => `<font>${fontXml[font]}<name val="맑은 고딕"/><family val="2"/></font>`).join("")}
          </fonts>
          <fills count="4">
            <fill><patternFill patternType="none"/></fill>
            <fill><patternFill patternType="gray125"/></fill>
            <fill><patternFill patternType="solid"><fgColor rgb="FFFFFF55"/><bgColor indexed="64"/></patternFill></fill>
            <fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>
          </fills>
          <borders count="${2 + sheet.borders.length}">
            <border><left/><right/><top/><bottom/><diagonal/></border>
            <border><left style="thin"><color rgb="FF222222"/></left><right style="thin"><color rgb="FF222222"/></right><top style="thin"><color rgb="FF222222"/></top><bottom style="thin"><color rgb="FF222222"/></bottom><diagonal/></border>
            ${borderXml}
          </borders>
          <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
          <cellXfs count="${11 + sheet.list.length}">
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
            ${xfXml}
          </cellXfs>
          <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
          <dxfs count="1"><dxf><font><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFCE4D6"/></patternFill></fill></dxf></dxfs>
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

    // 집계표 엑셀 뒤에 붙이는 '위계 경고 학생' 시트(학교 서식 시트는 그대로 둔다). 첫 행은 머리글.
    function aggregatePrereqSheetXml(rows) {
      const widths = [10, 6, 6, 10, 10, 22, 16, 44];
      const rowsXml = rows.map((cells, rowIndex) =>
        `<row r="${rowIndex + 1}">${cells.map((value, column) =>
          `<c r="${columnName(column)}${rowIndex + 1}" s="${rowIndex === 0 ? 2 : cells.length === 1 ? 0 : 7}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value ?? "")}</t></is></c>`).join("")}</row>`).join("");
      const columns = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("");
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columns}</cols><sheetData>${rowsXml}</sheetData></worksheet>`;
    }

    function buildAggregateXlsxFiles() {
      const { openingPercent, divisionPercent } = aggregateThresholds();
      const aggregate = aggregateRecords(
        state.students, state.courses, openingPercent, divisionPercent,
        state.classOverrides, state.semesterAssignments, state.groupAssignments,
        typeof nextYearClassBases === "function" ? nextYearClassBases() : {},
        state.roundClosures?.[state.currentRound] || {}
      );
      // 4단계에서 학년 탭을 고르면 그 학년 시트만 만든다(시트 내용은 학교 서식 그대로).
      const grade = typeof activeAggregateGrade === "function" ? activeAggregateGrade() : "";
      const sheets = aggregate.reports.filter((report) => !grade || String(report.summary.grade) === grade).map((report) => ({
        name: aggregateSheetName(report),
        printTitles: "$1:$3",
        xml: createWorksheetXml(report, openingPercent, divisionPercent)
      }));
      // 위계(선이수) 경고 학생 시트: 학년 탭을 고르면 그 학년만. 점검할 편제표가 없으면 만들지 않는다.
      const prereqRows = typeof courseCheckAggregateSheetRows === "function" ? courseCheckAggregateSheetRows(state.students, grade) : null;
      if (prereqRows) sheets.push({ name: "위계 경고 학생", xml: aggregatePrereqSheetXml(prereqRows) });
      const sheetOverrides = sheets.map((sheet, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("");
      const sheetEntries = sheets.map((sheet, index) =>
        `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("");
      const sheetRels = sheets.map((sheet, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("");
      const files = {
        "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetOverrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries}</sheets>${aggregateWorkbookExtrasXml(sheets)}</workbook>`,
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
      const grade = typeof activeAggregateGrade === "function" ? activeAggregateGrade() : "";
      link.download = grade ? `과목별_수강신청_집계표_현${grade}학년.xlsx` : "과목별_수강신청_집계표.xlsx";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function updateCertificateText() {
      renderPreview();
      renderSemesterClassifier();
      renderAggregate();
      // 글자를 칠 때마다 4MB를 직렬화하지 않고 묶어서 저장한다.
      if (typeof persistStateSoon === "function") persistStateSoon(); else persistState();
    }

    function resultImportOptions(grade) {
      return {
        subjects: collectApplicationSubjects({ includeExcluded: true, currentGrade: grade }),
        cohortYear: typeof applicationCohortYear === "function" ? applicationCohortYear(grade) : "",
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
      // '교과 영역'(기초·탐구 등)과 '교과(군)'이 함께 있으면 교과(군)을 교과로 보고 교과 영역은 따로 둔다.
      const areaGroup = find([/교과군/]);
      return {
        subject: subject >= 0 ? subject : (baseCredit > 0 ? baseCredit - 1 : -1),
        area: areaGroup >= 0 ? areaGroup : find([/교과영역/]),
        domain: areaGroup >= 0 ? find([/교과영역/]) : -1,
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
        hiddenRows: (sheet.layout?.hiddenRows || []).filter((row) => row >= minRow && row <= maxRow).map((row) => row - minRow),
        ...(typeof cropCurriculumSheetFormats === "function" ? cropCurriculumSheetFormats(sheet.layout, minRow, maxRow, minColumn, maxColumn) : {})
      };
    }

    // 원본 양식 서식(글꼴·정렬·테두리 번호, 서식 있는 글자)을 자른 범위 기준으로 옮긴다. 칸이 없으면 행·열 서식을 쓴다.
    function cropCurriculumSheetFormats(source, minRow, maxRow, minColumn, maxColumn) {
      if (!Array.isArray(source?.styleTable)) return {};
      const cellStyles = {};
      const cellRich = {};
      for (let row = minRow; row <= maxRow; row++) {
        for (let column = minColumn; column <= maxColumn; column++) {
          const key = `${row}:${column}`;
          const style = source.cellStyles?.[key] ?? source.rowStyles?.[row] ?? source.columnStyles?.[column];
          if (Number.isInteger(style) && style >= 0) cellStyles[`${row - minRow}:${column - minColumn}`] = style;
          if (source.cellRich?.[key]) cellRich[`${row - minRow}:${column - minColumn}`] = source.cellRich[key];
        }
      }
      return { cellStyles, cellRich, styleTable: source.styleTable, baseFont: source.baseFont || null,
        sheetZoom: source.sheetZoom || 100, defaultColumnWidth: source.defaultColumnWidth || 8.43, defaultRowHeight: source.defaultRowHeight || 15 };
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
      // 울산 편제 점검 프로그램(xlsb)은 curriculum-office-format.js가 읽는다.
      if (/\.xlsb$/i.test(file.name) && typeof importCurriculumOfficeXlsbFile === "function") {
        importCurriculumOfficeXlsbFile(file).catch((error) => { status.style.color = "#a44939"; status.textContent = error?.message || String(error); });
        return;
      }
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
          if (typeof isCurriculumOfficeProgram === "function" && isCurriculumOfficeProgram(sheets)) {
            await importCurriculumOfficeProgram(sheets, file, verifyTarget);
            return;
          }
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
            // 업로드한 표를 과목·선택과목군 데이터로 바꾼다. 원본 칸·병합은 내보내기 양식으로만 남는다.
            if (typeof ensureCurriculumPlanData === "function") ensureCurriculumPlanData(layout);
            // 2022 개정 편제표는 공식 과목명으로 확실히 고칠 수 있는 이름(띄어쓰기·표기·유일한 오탈자)을 고친다(curriculum-data.js).
            if (typeof curriculumApplyAutoNames === "function") curriculumApplyAutoNames(layout, cohortYear);
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
          // 원본을 새 변환기로 다시 읽을 때 업로드 뒤 고친 곳을 가려내도록 업로드 시점 데이터를 함께 둔다(curriculum-reconvert.js).
          if (typeof storeCurriculumOrigin === "function") await storeCurriculumOrigin(importedLayout).catch(() => {});
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
          const repairNotes = typeof curriculumDataRepairNotes === "function" ? curriculumDataRepairNotes(importedLayout) : [];
          const autoNames = typeof curriculumAutoNameList === "function" ? curriculumAutoNameList(importedLayout) : [];
          if (autoNames.length) repairNotes.push(`공식 과목명으로 ${autoNames.length}곳 자동 수정(${autoNames.slice(0, 4).map((item) => `${item.from} → ${item.to}`).join(", ")}${autoNames.length > 4 ? " 등" : ""} · 표 위 '자동 수정' 안내에서 되돌리기)`);
          status.textContent = plan.length
            ? `${state.curriculumCohortYear}학년도 ${planType === "annual" ? "전학년" : "신입생 3개년"} 편제표 ${plan.length}개 과목을 불러왔습니다.${repairNotes.length ? ` ${repairNotes.join(" / ")}` : ""}`
            : "편제표 표는 불러왔지만 과목 열을 인식하지 못했습니다. 표를 확인해 주세요.";
        } catch (error) {
          const message = error instanceof Error ? error.message : "편제표 파일 처리 중 오류가 발생했습니다.";
          status.style.color = "#a44939";
          status.textContent = message;
        }
      };
      reader.readAsArrayBuffer(file);
    }


    // 오늘 날짜를 확인서 표기(2026. 9. 28.)로 만든다.
    function certificateTodayLabel(date = new Date()) {
      return `${date.getFullYear()}. ${date.getMonth() + 1}. ${date.getDate()}.`;
    }

    // 인쇄 전에 비어 있는 확인서 기본 정보를 알려 준다. 비어 있으면 확인서에 빈칸으로 인쇄된다.
    function certificateMissingInfo(schoolName, confirmDate) {
      const missing = [];
      if (!String(schoolName || "").trim()) missing.push("학교명");
      if (!String(confirmDate || "").trim()) missing.push("확인 날짜");
      return missing;
    }

    function printStudents(students) {
      if (!students.length) return;
      const missing = certificateMissingInfo($("#schoolName").value, $("#confirmDate").value);
      if (missing.length && !window.confirm(`확인서의 ${missing.join("과 ")}${missing.length > 1 || missing[0] === "확인 날짜" ? "가" : "이"} 비어 있습니다. 빈칸으로 인쇄됩니다.\n\n그대로 인쇄할까요? (취소하면 기본 정보 창을 엽니다)`)) {
        if (typeof openCertificateInfoDialog === "function") openCertificateInfoDialog();
        return;
      }
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
    // Ctrl+Z(맥 ⌘+Z): 1단계 편제표 편집 실행취소. 편제표 칸에 글자를 입력하는 중이면 브라우저 기본(글자 되돌리기)을 그대로 두고,
    // 칸 밖(고른 상태·포커스 없음)일 때만 편제표를 되돌린다. 다른 단계나 편제표 밖 입력칸에서는 가로채지 않는다.
    document.addEventListener("keydown", (event) => {
      if (!curriculumUndoShortcutApplies(event)) return;
      event.preventDefault();
      if (state.curriculumUndoStack.length) undoCurriculumEdit();
      else {
        status.style.color = "#596780";
        status.textContent = "되돌릴 편제표 변경이 없습니다.";
      }
    });
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
      // 데이터 편제표는 칸을 벗어날 때(focusout) 데이터로 한 번에 반영한다.
      if (state.curriculumImportedLayout.planData) return;
      const rowIndex = Number(cell.dataset.sourceRow);
      const columnIndexValue = Number(cell.dataset.sourceColumn);
      if (!Number.isInteger(rowIndex) || !Number.isInteger(columnIndexValue)) return;
      state.curriculumImportedLayout.rows[rowIndex] =state.curriculumImportedLayout.rows[rowIndex] || [];
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
      if (state.curriculumImportedLayout.planData && typeof applyCurriculumDataCellEdit === "function") {
        // 입력을 시작할 때 실행취소 기록은 이미 남겼다(input 처리). 다음 칸으로 옮겨 간 초점은 다시 그린 뒤 되살린다.
        const mutation = state.curriculumMutationRevision;
        setTimeout(() => {
          if (mutation !== state.curriculumMutationRevision) return;
          applyCurriculumDataCellEdit(cell, document.activeElement?.closest?.("[contenteditable='true'][data-source-row]"));
        }, 0);
        return;
      }
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
      syncCurriculumTopToggle();
      renderCurriculumStep();
      persistState();
      scheduleCurriculumTableSize();
    });
    // 변경 상태 문구의 '이력 확인': 위쪽을 펼치고 변경 이력에서 비교 기준 시점 → 현재 편제표 비교를 연다(삭제된 과목도 보인다).
    $("#curriculumChangeSummary").addEventListener("click", (event) => {
      const button = event.target.closest("[data-change-history]");
      if (!button) return;
      if (state.curriculumTopCollapsed) $("#curriculumTopToggle").click();
      const panel = $("#curriculumVersionsPanel");
      panel.open = true;
      panel.querySelector(`[data-version-compare="${CSS.escape(button.dataset.changeHistory)}"][data-version-mode="current"]`)?.click();
      panel.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    // 손잡이뿐 아니라 경계선 어디를 눌러도 접고 펼친다(Enter·Space는 손잡이 단추가 받는다).
    $("#curriculumTopDivider")?.addEventListener("click", (event) => {
      if (event.target.closest("#curriculumTopToggle")) return;
      $("#curriculumTopToggle").click();
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
      // 여러 행에 걸친 과목(원본 양식의 택n·학점 칸)은 과목 행 전체(choiceStart~choiceEnd)를 고른다.
      const row = Number(cell.dataset.choiceStart ?? cell.dataset.sourceRow);
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
          Number(item.dataset.choiceStart ?? item.dataset.sourceRow) >= startRow && Number(item.dataset.choiceEnd ?? item.dataset.sourceRow) <= endRow;
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
      if (selectionLayout.planData && typeof curriculumDataSelectionLabel === "function") {
        $("#curriculumMergeSelection").textContent = curriculumDataSelectionLabel(selectionLayout, curriculumCellSelection);
      }
      $("#curriculumMergeApply").disabled = !horizontal && endRow <= startRow;
      $("#curriculumMergePick").closest?.("label")?.classList.toggle("hidden", !academic || Boolean(selectionLayout.planData));
      $("#curriculumMergeCredit").closest?.("label")?.classList.toggle("hidden", !academic || Boolean(selectionLayout.planData));
      $("#curriculumMergeRelease").disabled = !curriculumChoiceBlocks(state.curriculumImportedLayout).some((block) =>
        block.column === column && startRow <= block.endRow && endRow >= block.startRow);
      const block = curriculumChoiceBlocks(state.curriculumImportedLayout).find((item) =>
        item.column === column && startRow >= item.startRow && startRow <= item.endRow);
      if (!extend && block) {
        $("#curriculumMergePick").value = String(block.pick);
        $("#curriculumMergeCredit").value = String(block.credit || 4);
      }
      if (!selectionLayout.planData && (state.curriculumImportedLayout.mergedRanges || []).some((reference) => {
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
        // 데이터 편제표는 고른 칸 옆에 뜨는 단추를 쓰므로 도구 줄을 펼치지 않는다(펼치면 끄는 중에 표가 아래로 밀린다).
        if (!state.curriculumImportedLayout?.planData) $("#curriculumMergeControls").classList.remove("hidden");
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
    // 학기 칸은 모드 없이 바로 끌어 고른다(5px 넘게 움직이면 끌기, 아니면 클릭 = 학점 바로 수정). 묶음·교차집중 띠에서 시작해도 된다.
    // 터치는 길게 눌러(0.45초) 고르고, 고르는 중에는 다른 칸을 눌러 범위를 넓힌다. 놓으면 옆에 '선택과목군으로 묶기' 단추가 뜬다.
    $("#curriculumPlanWrap").addEventListener("pointerdown", (event) => {
      const band = event.target.closest(".curriculum-group-band, .curriculum-cross-band");
      if (event.button !== 0 || (event.target.closest("input, button") && !band) || event.target.closest("[data-group-handle]")) return;
      const cell = event.target.closest("[data-choice-selectable], [data-choice-column]");
      if (!cell) return;
      const gesture = {
        row: Number(cell.dataset.sourceRow ?? cell.dataset.choiceStart),
        endRow: Number(cell.dataset.choiceEnd ?? cell.dataset.sourceRow),
        column: Number(cell.dataset.sourceColumn ?? cell.dataset.choiceColumn),
        endColumn: Number(cell.dataset.choiceEndColumn ?? cell.dataset.sourceColumn ?? cell.dataset.choiceColumn),
        x: event.clientX, y: event.clientY, pointerId: event.pointerId, touch: event.pointerType === "touch"
      };
      const touchExtend = gesture.touch && curriculumCellSelectionMode && Boolean(curriculumCellSelection);
      if (curriculumCellSelectionMode || event.shiftKey) {
        event.preventDefault();
        startCurriculumRangeSelection(gesture, event.shiftKey || touchExtend);
      } else {
        curriculumSelectionAnchor = { row: Number(cell.dataset.choiceStart ?? gesture.row), endRow: gesture.endRow, column: gesture.column, endColumn: gesture.endColumn };
        if (gesture.touch) {
          gesture.timer = window.setTimeout(() => {
            if (curriculumSelectionGesture !== gesture) return;
            startCurriculumRangeSelection(gesture, false);
            curriculumSelectionDragging = false;
            if (typeof showCurriculumSelectionActions === "function" && curriculumCellSelection) showCurriculumSelectionActions(curriculumCellSelection);
          }, 450);
        }
      }
      curriculumSelectionGesture = gesture;
    });
    document.addEventListener("pointermove", (event) => {
      const gesture = curriculumSelectionGesture;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      if (gesture.touch && !curriculumSelectionDragging) {
        // 터치로 움직이면 표를 스크롤하는 것이다(길게 누르기 취소).
        if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 8) { window.clearTimeout(gesture.timer); curriculumSelectionGesture = null; }
        return;
      }
      if (!(event.buttons & 1)) return;
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
    function stopCurriculumRangeSelection(event) {
      const dragged = curriculumSelectionDragging;
      if (curriculumSelectionGesture?.timer) window.clearTimeout(curriculumSelectionGesture.timer);
      curriculumSelectionDragging = false;
      curriculumSelectionGesture = null;
      // 끌기·Shift+클릭으로 고른 뒤 놓으면 고른 칸 옆에 할 일 단추를 띄운다(데이터 편제표).
      if (dragged && event?.type === "pointerup" && curriculumCellSelection && state.curriculumImportedLayout?.planData &&
          typeof showCurriculumSelectionActions === "function") showCurriculumSelectionActions(curriculumCellSelection);
    }
    document.addEventListener("pointerup", stopCurriculumRangeSelection);
    document.addEventListener("pointercancel", stopCurriculumRangeSelection);
    window.addEventListener("blur", stopCurriculumRangeSelection);
    function applyCurriculumCellSelection(release = false, insertion = "") {
      try {
        if (typeof isWorkspaceStorageProtected === "function" && isWorkspaceStorageProtected()) throw new Error("저장 원본을 먼저 복원하세요.");
        if (!curriculumCellSelection) throw new Error("병합할 셀을 먼저 선택하세요.");
        // 데이터 편제표: 학기 칸 선택은 선택과목군 묶기(팝업)·풀기로 처리한다.
        if (state.curriculumImportedLayout?.planData && typeof applyCurriculumDataSelection === "function") {
          if (insertion) throw new Error("행은 과목 행 끝의 ⋯ 메뉴에서 추가·삭제·이동하세요.");
          applyCurriculumDataSelection(curriculumCellSelection, release);
          return;
        }
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
    $("#prereqFilter")?.addEventListener("change", showFirstVisibleStudent);
    $("#studentList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-student-id]");
      if (!button) return;
      state.selectedId = button.dataset.studentId;
      // 목록을 다시 그려도 목록 스크롤과 누른 학생 단추의 포커스를 그대로 둔다(view-keep.js).
      preserveViewDuring("#studentList", () => {
        renderRoster();
        renderPreview();
      });
      // 고른 학생은 화면 위치일 뿐이라 4MB 전체 저장을 바로 하지 않는다(다음 저장·창 닫기 때 함께 저장).
      persistStateSoon({ viewOnly: true });
    });
    function openCertificateInfoDialog() {
      const dialog = document.getElementById("certificateInfoDialog");
      if (!dialog) return;
      $("#certificateSchoolName").value = $("#schoolName").value;
      if (typeof dialog.showModal === "function") { if (!dialog.open) dialog.showModal(); } else dialog.setAttribute("open", "");
      const firstEmpty = !String($("#schoolName").value || "").trim() ? "#certificateSchoolName"
        : !String($("#confirmDate").value || "").trim() ? "#confirmDate" : "#certificateSchoolName";
      $(firstEmpty).focus();
    }
    $("#openCertificateInfo").addEventListener("click", openCertificateInfoDialog);
    // 설명·설정 팝업 공통: data-open-dialog="팝업 id" 버튼을 누르면 그 팝업을 연다(화면에는 요약과 버튼만 둔다).
    document.addEventListener("click", (event) => {
      const opener = event.target.closest?.("[data-open-dialog]");
      if (!opener) return;
      const dialog = document.getElementById(opener.dataset.openDialog);
      if (!dialog || dialog.open) return;
      if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
      dialog.querySelector("input:not([readonly]), select")?.focus();
    });
    // 팝업의 학교명은 상단 '학교·학년도 설정'의 학교명과 같은 값이다.
    $("#certificateSchoolName").addEventListener("input", (event) => {
      $("#schoolName").value = event.target.value;
      updateCertificateText();
    });
    $("#schoolName").addEventListener("input", () => { $("#certificateSchoolName").value = $("#schoolName").value; });
    $("#certificateDateToday").addEventListener("click", () => {
      $("#confirmDate").value = certificateTodayLabel();
      updateCertificateText();
    });
    $("#printSelected").addEventListener("click", () => {
      const student = currentStudent();
      if (student) printStudents([student]);
    });
    $("#printAll").addEventListener("click", () => printStudents(visibleStudents()));
    $("#downloadAggregate").addEventListener("click", downloadAggregate);
    for (const selector of ["#openingPercent", "#divisionPercent", "#maxClassSize"]) {
      $(selector).addEventListener("input", () => {
        if (typeof isRoundLocked === "function" && isRoundLocked(state.currentRound)) return;
        // 집계표 안에 개설/폐강 결정 칸이 함께 있으므로 집계표만 다시 그리면 결정 기본값도 함께 갱신된다.
        if (typeof renderRoundStatusControls === "function") renderRoundStatusControls();
        renderAggregate();
        persistStateSoon();
      });
    }
    $("#openAggregateSettings").addEventListener("click", () => {
      const dialog = $("#aggregateSettingsDialog");
      const locked = typeof isRoundLocked === "function" && isRoundLocked(state.currentRound);
      $("#aggregateSettingsLockNote").textContent = locked
        ? `${state.currentRound}차가 확정되어 개설·분반 기준과 최대 인원은 잠겨 있습니다. 바꾸려면 확정을 해제하세요.`
        : "값을 바꾸면 집계표에 바로 반영됩니다. 학급 수는 5단계 시수 통계와 같은 값입니다.";
      if (typeof syncNextYearClassInputs === "function") syncNextYearClassInputs();
      if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
    });
    // 4단계 학년 탭: 집계표·개설/폐강 결정·재신청 대상자·차수 비교에 함께 적용한다(화면 상태로만 유지).
    $("#aggregateGradeBar").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-aggregate-grade]");
      const filter = event.target.closest("[data-aggregate-risk-filter]");
      if (filter) {
        aggregateAttentionOnly = !aggregateAttentionOnly;
        renderAggregate();
        return;
      }
      if (!tab) return;
      aggregateGradeScope = tab.dataset.aggregateGrade;
      renderAggregate();
      if (Number(state.workflowStep) === 4) {
        renderRetakePanel();
        if (typeof renderRoundCompare === "function") renderRoundCompare(true);
      }
    });
    $("#aggregateContent").addEventListener("click", (event) => {
      // 과목명(또는 그 과목 칸의 모서리 표시)을 누르면 개설·폐강·미정 메뉴를 연다. 같은 칸을 다시 누르면 닫는다.
      const courseHead = event.target.closest("[data-aggregate-course]");
      const courseInfo = event.target.closest("[data-aggregate-course-info]");
      if (courseHead || courseInfo) {
        const anchor = courseHead || courseInfo;
        const head = courseHead || [...$("#aggregateContent").querySelectorAll("[data-aggregate-course]")]
          .find((item) => item.dataset.aggregateCourse === courseInfo.dataset.aggregateCourseInfo);
        const menu = document.getElementById("aggregateCourseMenu");
        if (menu && !menu.hidden && menu.aggregateAnchor === anchor) closeAggregateCourseMenu();
        else if (head) openAggregateCourseMenu(head, anchor);
        return;
      }
      const adjust = event.target.closest("[data-aggregate-adjust]");
      const undo = event.target.closest("[data-aggregate-undo]");
      if (!adjust && !undo) return;
      if (typeof isRoundLocked === "function" && isRoundLocked(state.currentRound)) return;
      try {
        if (undo) {
          if (undoAggregateClassAdjust()) showAppToast("학급수 자동 조정을 취소하고 조정 전 값으로 되돌렸습니다.");
        } else {
          const result = adjustAggregateClassCounts(adjust.dataset.grade,
            adjust.dataset.aggregateAdjust === "group" ? adjust.dataset.semester : "",
            adjust.dataset.aggregateAdjust === "group" ? adjust.dataset.group : "");
          if (!result) return;
          const message = [
            result.changed.length ? `학급수 조정: ${result.changed.join(", ")}` : "",
            result.problems.length ? `맞출 수 없음: ${result.problems.join(" / ")}` : "",
            !result.changed.length && !result.problems.length ? "이미 목표 학급수와 일치합니다." : ""
          ].filter(Boolean).join(" · ");
          status.style.color = result.problems.length ? "#a44939" : "#287956";
          status.textContent = message;
          showAppToast(message, result.problems.length && !result.changed.length ? "error" : "success");
        }
      } catch (error) {
        showAppToast(error?.message || "학급수를 조정하지 못했습니다.", "error");
        return;
      }
      renderAggregate();
      persistStateSoon();
    });
    // 과목 메뉴 밖을 누르거나 Esc를 누르면 메뉴를 닫는다.
    document.addEventListener("pointerdown", (event) => {
      const menu = document.getElementById("aggregateCourseMenu");
      if (!menu || menu.hidden || menu.contains(event.target) || event.target.closest?.("[data-aggregate-course], [data-aggregate-course-info]")) return;
      closeAggregateCourseMenu();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeAggregateCourseMenu(true);
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
      persistStateSoon();
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
        // 입력 칸이 팝업(예: 시수 설정) 안에 있으면 팝업을 먼저 연다.
        const dialog = target?.closest?.("dialog");
        if (dialog && !dialog.open) { if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", ""); }
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
    $("#workspaceFailureBackup").addEventListener("click", downloadWorkspaceBackup);
    $("#workspaceDataMenu").addEventListener("toggle", (event) => { if (event.currentTarget.open) renderWorkspaceStorageUsage(true); });
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
        if (workspaceStoreState.active || (typeof workspaceStoreParseRecord === "function" && workspaceStoreParseRecord(readWorkspaceRecord()))) {
          reloadWorkspaceFromStore();
          return;
        }
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
      if (workspaceStoreState.active) {
        // 새 저장소는 저장 번호 확인 없이 지금 자료로 모두 다시 쓴다.
        workspaceStoreState.force = true;
        workspaceStoreState.known = new Set();
        workspaceStoreState.lastCore = null;
      }
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
      // 새 저장소에 아직 쓰는 중이면(보통 0.1초 안에 끝난다) 닫기 전에 한 번 묻는다.
      if (workspaceSaveFailed || statePersistenceBlocked || workspaceStoreBusy() ||
          (typeof getApplicationGroupStorageIssue === "function" && getApplicationGroupStorageIssue())) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    document.addEventListener("visibilitychange", () => {
      // 미뤄 둔 화면 위치(단계·고른 학생)도 창을 숨길 때 저장한다.
      if (document.visibilityState === "hidden" && statePersistenceReady && (statePersistenceTimer !== null || stateViewOnlyDirty)) persistState();
    });
    document.addEventListener("keydown", (event) => {
      const label = event.target.closest('label[for][role="button"]');
      if (!label || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      const input = document.getElementById(label.htmlFor);
      if (input && !input.disabled) input.click();
    });
    window.addEventListener("hashchange", () => window.location.reload());
    let workspaceStartupBoot = null;
    const studentApplicationRoute = showStudentApplicationEntry();
    if (!studentApplicationRoute) {
      $("#teacherWorkspace").classList.remove("hidden");
      // 확인 날짜는 저장된 값이 없으면 오늘 날짜로 채운다(저장된 값이 있으면 복원이 덮어쓴다).
      if (!String($("#confirmDate").value || "").trim()) $("#confirmDate").value = certificateTodayLabel();
      // 새 저장소(IndexedDB)에 저장된 자료면 작은 설정만 먼저 맞추고, 큰 자료는 읽는 대로 다시 그린다(그동안 화면 잠금).
      workspaceStartupBoot = beginWorkspaceStoreBoot();
      // 다른 모듈이 아직 안 읽혀 DOMContentLoaded에서 다시 그리므로, 복원 중에는 단계 화면을 그리지 않고 미뤄 둔다(view-keep.js).
      const restoreStartup = () => restorePersistedState(workspaceStartupBoot?.settingsRaw);
      if (typeof holdStepRenders === "function") holdStepRenders(restoreStartup);
      else restoreStartup();
      if (workspaceStartupBoot) {
        $("#teacherWorkspace").inert = true;
        $("#teacherWorkspace").setAttribute("aria-busy", "true");
        updateWorkspaceSaveStatus("저장된 자료를 불러오는 중");
      }
      $("#certificateSchoolName").value = $("#schoolName").value;
      // 결과 검증·차수 확정·시수 통계 모듈은 app.js 다음에 로드되므로 모두 로드된 뒤 한 번 더 그린다.
      document.addEventListener("DOMContentLoaded", () => {
        finishWorkspaceStartup(workspaceStartupBoot).catch((error) => {
          updateWorkspaceSaveStatus(`복원 실패 · 기존 저장 원본 보호 중: ${error?.message || error}`, true);
        });
      }, { once: true });
    } else {
      resolveWorkspaceStartup?.();
    }
    statePersistenceReady = !studentApplicationRoute && !workspaceStartupBoot;
