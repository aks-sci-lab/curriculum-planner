    "use strict";
    const rawState = {
      students: [],
      courses: [],
      selectedId: null,
      fileName: "",
      classOverrides: {},
      plannedClassCounts: {},
      semesterAssignments: {},
      customGroupNames: [],
      customGroupNamesByGrade: { "2": [], "3": [] },
      groupAssignments: {},
      selectedCourseColumns: [],
      lastSelectedCourseColumn: null,
      curriculumCatalog: [],
      curriculumCatalogQuery: "",
      curriculumFileName: "",
      curriculumPlanFileName: "",
      curriculumPlanAcademicYear: "",
      curriculumPlansByYear: {},
      curriculumImportedLayout: null,
      curriculumTemplateRows: [],
      curriculumPlan: [],
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
      certificateTargetGrade: "2",
      aggregateTargetGrade: "2",
      classifierTargetGrade: "2",
      rounds: { "1": null },
      roundClosures: { "1": {} },
      applicationImportRevision: 0,
      activeDataSchoolYear: "",
      priorCourseHistory: [],
      historyArchivedYears: {},
    };
    const stateProxyCache = new WeakMap();
    const stateRawTargets = new WeakMap();
    let statePersistenceTimer = null;
    let statePersistenceSuppressed = 0;
    // 새로고침 직후 저장분을 복원하기 전에는 빈 초기 상태로 저장분을 덮어쓰지 않는다.
    let statePersistenceReady = false;

    function scheduleStatePersistence() {
      if (!statePersistenceReady || statePersistenceSuppressed || statePersistenceTimer !== null) return;
      statePersistenceTimer = window.setTimeout(() => {
        statePersistenceTimer = null;
        persistState();
      }, 0);
    }

    function observeState(value) {
      if (!value || typeof value !== "object") return value;
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
    let curriculumLayoutStoredId = "";
    let curriculumLayoutPersistenceTimer = null;
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
        sem11: String(source.sem11 ?? fallback.sem11 ?? ""),
        sem12: String(source.sem12 ?? fallback.sem12 ?? ""),
        sem21: String(source.sem21 ?? fallback.sem21 ?? ""),
        sem22: String(source.sem22 ?? fallback.sem22 ?? ""),
        sem31: String(source.sem31 ?? fallback.sem31 ?? ""),
        sem32: String(source.sem32 ?? fallback.sem32 ?? "")
      };
    }

    function isSelectableDetail(detail) {
      const normalized = normalizeCurriculumDetail(detail);
      return normalized === "일반선택" || normalized === "진로선택" || normalized === "융합선택";
    }

    function applyClassFilterOptions(students) {
      const currentGrade = targetGradeCurrentGrade(state.certificateTargetGrade || "2");
      const classes = [...new Set(students
        .filter((student) => String(student.grade) === currentGrade)
        .map((student) => student.classroom))]
        .sort((a, b) => Number(a) - Number(b));
      $("#classFilter").innerHTML = '<option value="">전체 반</option>' +
        classes.map((classroom) => `<option value="${escapeHtml(classroom)}">${escapeHtml(classroom)}반</option>`).join("");
    }

    // 현재 활성 차수 데이터를 rounds에 동기화한다.
    function syncActiveRound() {
      if (!state.rounds || typeof state.rounds !== "object") state.rounds = { "1": null };
      if (state.students.length || state.fileName.startsWith("온라인 자동 연동") || state.fileName.startsWith("온라인 수동 갱신")) {
        state.rounds[state.currentRound] = {
          fileName: state.fileName,
          dataSchoolYear: state.activeDataSchoolYear,
          gradeFiles: state.rounds[state.currentRound]?.gradeFiles || {},
          students: state.students,
          courses: state.courses,
          classOverrides: state.classOverrides,
          semesterAssignments: {...state.semesterAssignments},
          groupAssignments: {...state.groupAssignments},
          customGroupNames: [...(state.customGroupNames || [])],
          customGroupNamesByGrade: normalizeGradeGroupNames(
            state.customGroupNamesByGrade, state.customGroupNames
          )
        };
      } else if (state.rounds[state.currentRound]) {
        state.rounds[state.currentRound] = null;
      }
    }

    function persistState() {
      if (statePersistenceTimer !== null) {
        window.clearTimeout(statePersistenceTimer);
        statePersistenceTimer = null;
      }
      if (!statePersistenceReady) return false;
      try {
        statePersistenceSuppressed++;
        syncActiveRound();
        statePersistenceSuppressed--;
        const payload = {
          currentRound: state.currentRound,
          rounds: state.rounds,
          roundClosures: state.roundClosures,
          students: state.students,
          courses: state.courses,
          selectedId: state.selectedId,
          fileName: state.fileName,
          classOverrides: state.classOverrides,
          plannedClassCounts: state.plannedClassCounts,
          semesterAssignments: state.semesterAssignments,
          customGroupNames: state.customGroupNames,
          customGroupNamesByGrade: state.customGroupNamesByGrade,
          groupAssignments: state.groupAssignments,
          curriculumCatalog: state.curriculumCatalog,
          curriculumCatalogQuery: state.curriculumCatalogQuery,
          curriculumFileName: state.curriculumFileName,
          curriculumPlanFileName: state.curriculumPlanFileName,
          curriculumPlanAcademicYear: state.curriculumPlanAcademicYear,
          curriculumPlansByYear: state.curriculumPlansByYear,
          curriculumLayoutArchiveId: state.curriculumImportedLayout?.archiveId ||
            curriculumLayoutStoredId || "",
          ...(state.curriculumImportedLayout &&
            curriculumLayoutStoredId !== state.curriculumImportedLayout.archiveId
            ? { curriculumImportedLayout: state.curriculumImportedLayout }
            : {}),
          curriculumTemplateRows: state.curriculumTemplateRows,
          curriculumPlan: state.curriculumPlan,
          curriculumPlanFilters: state.curriculumPlanFilters,
          curriculumTargetGrade: state.curriculumTargetGrade,
          curriculumTargetDivision: state.curriculumTargetDivision,
          curriculumTargetArea: state.curriculumTargetArea,
          curriculumTargetDetail: state.curriculumTargetDetail,
          curriculumBundleName: state.curriculumBundleName,
          curriculumBundlePick: state.curriculumBundlePick,
          workflowStep: state.workflowStep,
          certificateTargetGrade: state.certificateTargetGrade,
          aggregateTargetGrade: state.aggregateTargetGrade,
          classifierTargetGrade: state.classifierTargetGrade,
          openingPercent: $("#openingPercent").value,
          divisionPercent: $("#divisionPercent").value,
          schoolYear: $("#schoolYear").value,
          activeDataSchoolYear: state.activeDataSchoolYear,
          priorCourseHistory: state.priorCourseHistory,
          historyArchivedYears: state.historyArchivedYears,
          round: $("#round").value,
          confirmDate: $("#confirmDate").value,
          schoolName: $("#schoolName").value
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
        return true;
      } catch (error) {
        statePersistenceSuppressed = Math.max(0, statePersistenceSuppressed - 1);
        console.error("작업 상태 저장 실패", error);
        const message = error?.name === "QuotaExceededError"
          ? "브라우저 저장 공간이 부족해 변경 내용을 저장하지 못했습니다. 불필요한 브라우저 데이터를 정리한 뒤 다시 시도하세요."
          : `변경 내용을 저장하지 못했습니다: ${error?.message || "브라우저 저장소 오류"}`;
        if (typeof status !== "undefined") {
          status.style.color = "#a44939";
          status.textContent = message;
        }
        showAppToast(message);
        return false;
      }
    }

    function scheduleCurriculumLayoutPersistence() {
      if (curriculumLayoutPersistenceTimer !== null) {
        window.clearTimeout(curriculumLayoutPersistenceTimer);
      }
      curriculumLayoutPersistenceTimer = window.setTimeout(async () => {
        curriculumLayoutPersistenceTimer = null;
        const layout = state.curriculumImportedLayout;
        if (!layout?.archiveId) return;
        try {
          const snapshot = JSON.parse(JSON.stringify(layout));
          await storeCurriculumLayout(snapshot);
          if (state.curriculumImportedLayout?.archiveId !== snapshot.archiveId) return;
          if (JSON.stringify(state.curriculumImportedLayout) !== JSON.stringify(snapshot)) return;
          curriculumLayoutStoredId = snapshot.archiveId;
          persistState();
        } catch (error) {
          console.error("편제표 저장 실패", error);
          const message = `편제표 저장에 실패했습니다: ${error?.message || "브라우저 저장소 오류"}`;
          status.style.color = "#a44939";
          status.textContent = message;
          showAppToast(message);
        }
      }, 250);
    }

    function clearPersistedState() {
      if (statePersistenceTimer !== null) {
        window.clearTimeout(statePersistenceTimer);
        statePersistenceTimer = null;
      }
      localStorage.removeItem(STORAGE_KEY);
    }

    function renderWorkflowLayout() {
      const step = Number(state.workflowStep) || 3;
      renderCurriculumStep();
      renderRoundStatus();
      renderApplicationSubjects();
      for (const button of workflowSteps.querySelectorAll("[data-workflow-step]")) {
        button.setAttribute("aria-current", Number(button.dataset.workflowStep) === step ? "step" : "false");
      }
      $("#workflowStep2Panel").querySelector("h3").textContent = "2단계 · 학년별 수강신청";
      $("#workflowStep1Panel").classList.toggle("hidden", step !== 1);
      $("#workflowStep2Panel").classList.toggle("hidden", step !== 2);
      $("#workflowStep6Panel").classList.toggle("hidden", step !== 6);
      $("#certificatePanel").classList.toggle("hidden", step !== 3);
      $("#aggregatePanel").classList.toggle("hidden", step !== 4);
      $("#closurePanel").classList.toggle("hidden", step !== 4);
      $("#retakePanel").classList.toggle("hidden", step !== 4);
      $("#classifierPanel").classList.toggle("hidden", step !== 5);
      if (step === 3) renderPreview();
      if (step === 4) {
        renderAggregate();
        renderClosurePanel(state.currentRound);
        renderRetakePanel();
      }
      if (step === 5) renderSemesterClassifier();
    }

    function switchWorkflowStep(step, skipPersist = false) {
      const next = Number(step);
      state.workflowStep = [1, 2, 3, 4, 5, 6].includes(next) ? next : 1;
      renderWorkflowLayout();
      if (!skipPersist) persistState();
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

    // 차수를 전환한다. 현재 활성 데이터를 rounds에 저장하고 대상 차수 데이터를 활성화한다.
    function switchRound(round, skipRender = false) {
      const next = String(round);
      if (!/^[1-9]\d{0,8}$/.test(next) || !Object.hasOwn(state.rounds || {}, next)) return;
      if (next === state.currentRound) return;
      syncActiveRound();
      state.currentRound = next;
      const data = state.rounds[next];
      state.activeDataSchoolYear = String(data?.dataSchoolYear || "");
      state.students = data ? data.students : [];
      state.courses = data ? data.courses : [];
      state.fileName = data ? data.fileName : "";
      state.classOverrides = data ? { ...data.classOverrides } : {};
      state.semesterAssignments = {...data?.semesterAssignments};
      state.groupAssignments = {...data?.groupAssignments};
      state.customGroupNames = [...(data?.customGroupNames || [])];
      state.customGroupNamesByGrade = normalizeGradeGroupNames(
        data?.customGroupNamesByGrade, state.customGroupNames
      );
      state.customGroupNames = [];
      state.selectedCourseColumns = [];
      state.lastSelectedCourseColumn = null;
      state.selectedId = state.students.find((student) =>
        String(student.grade) === targetGradeCurrentGrade(state.certificateTargetGrade || "2"))?.id ||
        state.students[0]?.id || null;
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
      state.students = [];
      state.courses = [];
      state.selectedId = null;
      state.fileName = "";
      state.activeDataSchoolYear = "";
      state.classOverrides = {};
      state.semesterAssignments = {};
      state.groupAssignments = {};
      state.customGroupNames = [];
      state.customGroupNamesByGrade = { "2": [], "3": [] };
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
      state.plannedClassCounts = {};
      state.currentRound = "1";
      state.rounds = { "1": null };
      state.roundClosures = { "1": {} };
      state.priorCourseHistory = [];
      state.historyArchivedYears = {};
      state.semesterAssignments = {};
      state.customGroupNames = [];
      state.customGroupNamesByGrade = { "2": [], "3": [] };
      state.groupAssignments = {};
      state.aggregateTargetGrade = "2";
      state.classifierTargetGrade = "2";
      state.certificateTargetGrade = "2";
      state.selectedCourseColumns = [];
      state.lastSelectedCourseColumn = null;
      state.curriculumCatalog = [];
      state.curriculumCatalogQuery = "";
      state.curriculumFileName = "";
      state.curriculumPlanFileName = "";
      state.curriculumPlanAcademicYear = "";
      state.curriculumPlansByYear = {};
      state.curriculumImportedLayout = null;
      curriculumLayoutStoredId = "";
      state.curriculumTemplateRows = [];
      state.curriculumPlan = [];
      state.curriculumTargetGrade = "1";
      state.curriculumTargetDivision = "학생 선택 교육과정";
      state.curriculumTargetArea = "";
      state.curriculumTargetDetail = "일반선택";
      state.curriculumBundleName = "선택묶음1";
      state.curriculumBundlePick = 1;
      state.curriculumUndoStack = [];
      state.curriculumEditBefore = null;
      state.curriculumEditUndoRecorded = false;
      state.curriculumMutationRevision += 1;
      state.curriculumSelectedRow = null;
      state.curriculumSelectedColumn = null;
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
      $("#curriculumFileName").textContent = "저장된 교육과정 목록 없음";
      $("#curriculumPickList").innerHTML = '<div class="curriculum-empty">교육과정 목록을 불러오면 과목별로 표시됩니다.</div>';
      $("#curriculumCatalogQuery").value = "";
      $("#curriculumCatalogFilterCount").textContent = "";
      $("#curriculumPlanWrap").innerHTML = '<div class="curriculum-empty">편제표 파일을 불러오면 여기에 표시됩니다.</div>';
      $("#curriculumFilterGrade").innerHTML = '<option value="">전체 학년</option>';
      $("#curriculumFilterArea").innerHTML = '<option value="">전체 교과군</option>';
      $("#curriculumFilterDetail").innerHTML = '<option value="">선택 유형</option>';
      $("#curriculumFilterQuery").value = "";
      $("#curriculumFilterCount").textContent = "0개 과목 표시";
      if (rosterInput) rosterInput.value = "";
      if (curriculumPlanInput) curriculumPlanInput.value = "";
      const curriculumInput = $("#curriculumInput");
      if (curriculumInput) curriculumInput.value = "";
      renderPreview();
      state.workflowStep = 1;
      renderWorkflowLayout();
      if (clearSaved) clearPersistedState();
    }

    function restorePersistedState() {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        resetWorkspace(false);
        statePersistenceReady = true;
        return;
      }
      try {
        const saved = JSON.parse(raw);
        if (!Array.isArray(saved.students) || !Array.isArray(saved.courses)) throw new Error("invalid");
        // 차수별 데이터 복원. 구 버전 저장분(students/courses만 있는 경우)은 1차로 이관한다.
        const normalizeRoundData = (data) => {
          if (!data || !Array.isArray(data.students) || !data.students.length) return null;
          return {
            fileName: String(data.fileName || ""),
            dataSchoolYear: String(data.dataSchoolYear || ""),
            gradeFiles: data.gradeFiles && typeof data.gradeFiles === "object" ? data.gradeFiles : {},
            students: data.students,
            courses: normalizeCourses(Array.isArray(data.courses) ? data.courses : []),
            classOverrides: data.classOverrides && typeof data.classOverrides === "object" ? data.classOverrides : {},
            semesterAssignments: data.semesterAssignments,
            groupAssignments: data.groupAssignments,
            customGroupNames: data.customGroupNames,
            customGroupNamesByGrade: normalizeGradeGroupNames(
              data.customGroupNamesByGrade, data.customGroupNames
            )
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
        const activeRound = state.rounds[state.currentRound];
        state.students = activeRound ? activeRound.students : [];
        state.courses = activeRound ? activeRound.courses : [];
        state.selectedId = saved.selectedId || state.students[0]?.id || null;
        state.fileName = activeRound ? activeRound.fileName : "";
        state.activeDataSchoolYear = String(activeRound?.dataSchoolYear || saved.activeDataSchoolYear || "");
        state.priorCourseHistory = Array.isArray(saved.priorCourseHistory)
          ? saved.priorCourseHistory.filter((item) => item && typeof item === "object")
          : [];
        state.historyArchivedYears = saved.historyArchivedYears && typeof saved.historyArchivedYears === "object"
          ? saved.historyArchivedYears : {};
        state.classOverrides = activeRound ? { ...activeRound.classOverrides } : {};
        state.plannedClassCounts = saved.plannedClassCounts && typeof saved.plannedClassCounts === "object"
          ? Object.fromEntries(["2", "3"]
            .filter((grade) => Number.isInteger(saved.plannedClassCounts[grade]) && saved.plannedClassCounts[grade] > 0)
            .map((grade) => [grade, saved.plannedClassCounts[grade]]))
          : {};
        state.semesterAssignments = (activeRound?.semesterAssignments || saved.semesterAssignments) && typeof (activeRound?.semesterAssignments || saved.semesterAssignments) === "object"
          ? (activeRound?.semesterAssignments || saved.semesterAssignments)
          : {};
        state.customGroupNames = Array.isArray(activeRound?.customGroupNames || saved.customGroupNames)
          ? (activeRound?.customGroupNames || saved.customGroupNames).map((name) => String(name ?? "").trim()).filter(Boolean)
          : [];
        state.customGroupNamesByGrade = normalizeGradeGroupNames(
          activeRound?.customGroupNamesByGrade || saved.customGroupNamesByGrade,
          activeRound?.customGroupNames || saved.customGroupNames
        );
        state.customGroupNames = [];
        state.aggregateTargetGrade = ["2", "3"].includes(String(saved.aggregateTargetGrade))
          ? String(saved.aggregateTargetGrade) : "2";
        state.classifierTargetGrade = ["2", "3"].includes(String(saved.classifierTargetGrade))
          ? String(saved.classifierTargetGrade) : "2";
        state.certificateTargetGrade = ["2", "3"].includes(String(saved.certificateTargetGrade))
          ? String(saved.certificateTargetGrade) : "2";
        if (!state.students.some((student) =>
          student.id === state.selectedId &&
          String(student.grade) === targetGradeCurrentGrade(state.certificateTargetGrade))) {
          state.selectedId = state.students.find((student) =>
            String(student.grade) === targetGradeCurrentGrade(state.certificateTargetGrade))?.id || null;
        }
        state.groupAssignments = (activeRound?.groupAssignments || saved.groupAssignments) && typeof (activeRound?.groupAssignments || saved.groupAssignments) === "object"
          ? (activeRound?.groupAssignments || saved.groupAssignments)
          : {};
        state.curriculumCatalog = Array.isArray(saved.curriculumCatalog) ? saved.curriculumCatalog : [];
        state.curriculumCatalogQuery = String(saved.curriculumCatalogQuery || "");
        state.curriculumFileName = String(saved.curriculumFileName || "");
        state.curriculumPlanFileName = String(saved.curriculumPlanFileName || "");
        const persistedLayout = saved.curriculumImportedLayout &&
          Array.isArray(saved.curriculumImportedLayout.rows)
          ? saved.curriculumImportedLayout
          : null;
        const persistedLayoutId = String(saved.curriculumLayoutArchiveId || persistedLayout?.archiveId || "");
        state.curriculumImportedLayout = persistedLayout;
        curriculumLayoutStoredId = persistedLayout ? "" : persistedLayoutId;
        state.curriculumTemplateRows = Array.isArray(saved.curriculumTemplateRows)
          ? saved.curriculumTemplateRows.map((row) => normalizeCurriculumPlanRow(row))
          : [];
        state.curriculumPlan = Array.isArray(saved.curriculumPlan)
          ? saved.curriculumPlan.map((row) => normalizeCurriculumPlanRow(row))
          : [];
        state.curriculumPlansByYear = saved.curriculumPlansByYear && typeof saved.curriculumPlansByYear === "object"
          ? saved.curriculumPlansByYear : {};
        state.curriculumPlanAcademicYear = String(saved.curriculumPlanAcademicYear || saved.schoolYear || "");
        if (state.curriculumPlanAcademicYear && !state.curriculumPlansByYear[state.curriculumPlanAcademicYear]) {
          state.curriculumPlansByYear[state.curriculumPlanAcademicYear] = state.curriculumPlan;
        }
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
        state.workflowStep = ({1:1, 2:2, 3:3, 4:4, 5:4, 6:3, 7:4, 8:4, 9:5, 10:6})[savedStep] || 1;

        $("#fileName").textContent = state.fileName || "불러온 파일 없음";
        $("#openingPercent").value = saved.openingPercent || "90";
        $("#divisionPercent").value = saved.divisionPercent || "110";
        $("#schoolYear").value = saved.schoolYear || $("#schoolYear").value;
        $("#round").value = `${state.currentRound}차`;
        $("#confirmDate").value = saved.confirmDate || $("#confirmDate").value;
        $("#schoolName").value = saved.schoolName || $("#schoolName").value;
        $("#searchInput").disabled = !state.students.length;
        $("#classFilter").disabled = !state.students.length;
        applyClassFilterOptions(state.students);
        $("#studentCount").textContent = `${state.students.length} / ${state.students.length}명`;
        // 화면 표시 오류가 저장 데이터 전체 초기화로 이어지지 않도록 렌더링 실패는 따로 처리한다.
        try {
          renderRoster();
          renderPreview();
          renderCurriculumStep();
          renderSemesterClassifier();
          renderAggregate();
          renderWorkflowLayout();
        } catch (error) {
          console.error("복원한 자료 표시 실패", error);
          status.style.color = "#a44939";
          status.textContent = `저장 자료는 복원했지만 일부 화면을 표시하지 못했습니다: ${error?.message || error}`;
        }
        statePersistenceReady = true;
        if (persistedLayout) {
          scheduleCurriculumLayoutPersistence();
        } else if (persistedLayoutId) {
          const layoutRestoreRevision = state.curriculumMutationRevision;
          loadCurriculumLayout(persistedLayoutId).then((layout) => {
            if (!layout) throw new Error("저장된 편제표를 찾을 수 없습니다.");
            if (state.curriculumImportedLayout ||
                state.curriculumMutationRevision !== layoutRestoreRevision) return;
            state.curriculumImportedLayout = layout;
            curriculumLayoutStoredId = persistedLayoutId;
            renderCurriculumStep();
            renderApplicationSubjects();
            renderPreview();
            renderSemesterClassifier();
            renderAggregate();
            persistState();
          }).catch((error) => {
            console.error("저장된 편제표 복원 실패", error);
            const message = `저장된 편제표를 불러오지 못했습니다: ${error?.message || "브라우저 저장소 오류"}`;
            status.style.color = "#a44939";
            status.textContent = message;
            showAppToast(message);
          });
        }
        if (state.students.length && !status.textContent.startsWith("저장 자료는 복원했지만")) {
          status.style.color = "#287956";
          status.textContent = `새로고침 이전 파일(${state.fileName || "이전 파일"})을 복원했습니다.`;
        }
      } catch (error) {
        console.error("저장 자료 복원 실패", error);
        statePersistenceReady = true;
        resetWorkspace(true);
        try { localStorage.setItem(`${STORAGE_KEY}-unreadable-backup`, raw); } catch (backupError) { /* 공간 부족 시 백업 생략 */ }
        status.style.color = "#a44939";
        status.textContent = "저장 자료 형식을 읽지 못해 초기화했습니다. 원본은 브라우저에 백업해 두었습니다.";
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

    const UNASSIGNED_GROUP = "미분류";

    function resolveCourseCategory(course) {
      const key = String(course.column);
      const assigned = normalizeGroupName(state.groupAssignments[key]);
      if (assigned) return assigned;
      return UNASSIGNED_GROUP;
    }

    function resolveCourseCategoryForOutput(course) {
      const key = String(course.column);
      const assigned = parseAssignedGroupLabel(state.groupAssignments[key]);
      if (assigned.category) return assigned.category;
      return UNASSIGNED_GROUP;
    }

    function applicationGroupForCourse(course, currentGrade, groups = null) {
      const matches = applicationGroupMatchesForCourse(course, currentGrade, groups);
      if (matches.length === 1) return {name:matches[0].name, semester:matches[0].semester};
      if (matches.length > 1) return null;
      const settings = groups || (typeof getApplicationGroupSettings === "function" ? getApplicationGroupSettings() : []);
      const gradeSettings = settings.filter((group) => group.grade === String(Number(currentGrade) + 1));
      const savedGroup = course.applicationGroups?.[String(currentGrade)];
      if (!gradeSettings.length && savedGroup?.name) return savedGroup;
      return null;
    }

    function applicationGroupMatchesForCourse(course, currentGrade, groups = null) {
      const namedGrade = normalizeRomanNumerals(course.name).match(/\(([23])학년\)$/)?.[1];
      if (namedGrade && namedGrade !== String(Number(currentGrade)+1)) return [];
      const settings = groups || (typeof getApplicationGroupSettings === "function" ? getApplicationGroupSettings() : []);
      const normalize = (name) => curriculumCourseNameKey(name)
        .replace(/[\[(](?:일반|진로|융합)(?:선택)?[)\]]$/, "");
      const hint = ["1", "2"].includes(String(course.semesterKey))
        ? String(course.semesterKey) : parseSemesterFromCourseName(course.name);
      const gradeSettings = settings.filter((group) => group.grade === String(Number(currentGrade) + 1));
      const courseMatches = gradeSettings.filter((group) =>
        group.courses.some((name) => normalize(name) === normalize(course.name)));
      const hintedMatches = hint
        ? courseMatches.filter((group) => group.semester === hint)
        : courseMatches;
      return hintedMatches.length ? hintedMatches : courseMatches;
    }

    function classifyApplicationRecords(data) {
      const groups = typeof getApplicationGroupSettings === "function" ? getApplicationGroupSettings() : [];
      const warnings = new Set();
      for (const course of data.courses) {
        course.applicationGroups = {};
        for (const grade of new Set(data.students.filter((student) =>
          student.selections.some((selection) => selection.column === course.column)).map((student) => String(student.grade)))) {
          const group = applicationGroupForCourse(course, grade, groups);
          if (group) course.applicationGroups[grade] = group;
          else {
            const matches = applicationGroupMatchesForCourse(course, grade, groups);
            const hasSemesterSpecificMatches = matches.length > 1 &&
              new Set(matches.map((item) => item.semester)).size > 1;
            if (!hasSemesterSpecificMatches) warnings.add(`${Number(grade)+1}학년 ${course.name}`);
          }
        }
      }
      for (const student of data.students) for (const course of student.selections) {
        course.applicationGroups = data.courses.find((item) => item.column === course.column)?.applicationGroups || {};
      }
      return [...warnings];
    }

    function courseGroupLabel(course, currentGrade) {
      if (currentGrade && !state.groupAssignments[String(course.column)]) {
        const applicationGroup = applicationGroupForCourse(course, currentGrade);
        if (applicationGroup) return `${["1", "2"].includes(applicationGroup.semester) ? applicationGroup.semester+"학기 " : ""}${applicationGroup.name}`;
        const matches = applicationGroupMatchesForCourse(course, currentGrade);
        const resolvedSemester = resolveSemesterKey(course);
        const preferredSemester = ["1", "2"].includes(resolvedSemester)
          ? resolvedSemester : curriculumSemesterForCourse(course, Number(currentGrade) + 1);
        const preferredMatches = matches.filter((group) => group.semester === preferredSemester);
        const groups = preferredMatches.length ? preferredMatches : matches;
        if (groups.length && groups.every((group) => ["1", "2"].includes(group.semester)) &&
            new Set(groups.map((group) => group.semester)).size === groups.length) {
          return groups.slice().sort((a, b) => Number(a.semester) - Number(b.semester))
            .map((group) => `${group.semester}학기 ${group.name}`).join(" / ");
        }
      }
      const semester = resolveSemesterKey(course);
      const category = resolveCourseCategoryForOutput(course);
      if (!semester) return category;
      return category === "과목" ? `${semester}학기` : `${semester}학기 ${category}`;
    }

    function normalizeRomanNumerals(value) {
      const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
      const canonicalNumeral = (number) => {
        const pairs = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
          [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
          [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
        let remaining = number;
        let result = "";
        for (const [amount, symbol] of pairs) {
          while (remaining >= amount) {
            result += symbol;
            remaining -= amount;
          }
        }
        return result;
      };
      return String(value || "").normalize("NFKC")
        .replace(/(?<![A-Za-z])[IVXLCDM]+(?![A-Za-z])/gi, (numeral) => {
          const upper = numeral.toUpperCase();
          let number = 0;
          for (let index = 0; index < upper.length; index++) {
            const current = values[upper[index]];
            const next = values[upper[index + 1]] || 0;
            number += current < next ? -current : current;
          }
          return number > 0 && number <= 3999 && canonicalNumeral(number) === upper
            ? String(number) : numeral;
        });
    }

    function curriculumCourseNameKey(value) {
      return normalizeRomanNumerals(value)
        .replace(/\s+/g, "")
        .replace(/[\[(](?:[12]학기|[23]학년)[)\]]$/, "")
        .trim();
    }

    function curriculumGradesForCourse(course) {
      const schoolYear = String(state.activeDataSchoolYear || "");
      const plan = schoolYear
        ? (state.curriculumPlansByYear?.[schoolYear] ||
          (String(state.curriculumPlanAcademicYear || "") === schoolYear ? state.curriculumPlan : []))
        : state.curriculumPlan;
      const nameKey = curriculumCourseNameKey(course.name);
      if (!nameKey || !Array.isArray(plan)) return new Set();
      return new Set(plan
        .filter((row) => curriculumCourseNameKey(row.subject) === nameKey)
        .map((row) => String(row.grade || ""))
        .filter((grade) => ["2", "3"].includes(grade)));
    }

    function curriculumSemesterForCourse(course, targetGrade) {
      const schoolYear = String(state.activeDataSchoolYear || "");
      const plan = schoolYear
        ? (state.curriculumPlansByYear?.[schoolYear] ||
          (String(state.curriculumPlanAcademicYear || "") === schoolYear ? state.curriculumPlan : []))
        : state.curriculumPlan;
      const nameKey = curriculumCourseNameKey(course.name);
      if (!nameKey || !Array.isArray(plan)) return "";
      const semesterFields = {
        "1": ["sem11", "sem12"],
        "2": ["sem21", "sem22"],
        "3": ["sem31", "sem32"],
      }[String(targetGrade)];
      if (!semesterFields) return "";
      const semesters = new Set();
      for (const row of plan) {
        if (String(row.grade || "") !== String(targetGrade) ||
            curriculumCourseNameKey(row.subject) !== nameKey) continue;
        semesterFields.forEach((field, index) => {
          const value = String(row[field] ?? "").trim();
          if (value && !/^[-–—]+$/.test(value) && !/^0(?:\.0+)?$/.test(value)) {
            semesters.add(String(index + 1));
          }
        });
      }
      return semesters.size === 1 ? [...semesters][0] : "";
    }

    function courseBelongsToCurrentGrade(course, currentGrade, students) {
      const grade = String(currentGrade);
      const targetGrade = String(Number(grade) + 1);
      const namedGrade = normalizeRomanNumerals(course.name).match(/\(([23])학년\)$/)?.[1];
      if (namedGrade) return namedGrade === targetGrade;
      const curriculumGrades = curriculumGradesForCourse(course);
      if (curriculumGrades.size === 1) return curriculumGrades.has(targetGrade);
      if (curriculumGrades.size && !curriculumGrades.has(targetGrade)) return false;
      if (course.applicationCurrentGrade !== undefined && course.applicationCurrentGrade !== null &&
          String(course.applicationCurrentGrade) !== "") {
        return String(course.applicationCurrentGrade) === grade;
      }
      const applicationGroups = course.applicationGroups;
      if (applicationGroups && typeof applicationGroups === "object" && Object.keys(applicationGroups).length) {
        return Object.hasOwn(applicationGroups, grade);
      }
      const selectedGrades = new Set(students.filter((student) =>
        student.selections.some((selection) => String(selection.column) === String(course.column)))
        .map((student) => String(student.grade)));
      if (selectedGrades.size) return selectedGrades.has(grade);
      const rosterGrades = new Set(students.map((student) => String(student.grade)));
      return rosterGrades.size === 1 && rosterGrades.has(grade);
    }

    function coursesForCurrentGrade(currentGrade, courses = state.courses, students = state.students) {
      return courses.filter((course) => courseBelongsToCurrentGrade(course, currentGrade, students));
    }

    function targetGradeCurrentGrade(targetGrade) {
      return String(Number(targetGrade) - 1);
    }

    function gradeGroupNames(targetGrade) {
      const scoped = state.customGroupNamesByGrade?.[String(targetGrade)] || [];
      const legacy = state.customGroupNames || [];
      return [...new Set([...legacy, ...scoped].map(normalizeGroupName).filter(Boolean))];
    }

    function normalizeGradeGroupNames(value, legacyNames = []) {
      const source = value && typeof value === "object" ? value : null;
      const normalize = (names) => Array.isArray(names)
        ? [...new Set(names.map((name) => normalizeGroupName(name)).filter(Boolean))]
        : [];
      if (!source || (!Array.isArray(source["2"]) && !Array.isArray(source["3"]))) {
        const legacy = normalize(legacyNames);
        return { "2": [...legacy], "3": [...legacy] };
      }
      return { "2": normalize(source["2"]), "3": normalize(source["3"]) };
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

    function createRecords(rows) {
      const headerIndex = rows.findIndex((row) =>
        row?.some((value) => String(value).trim() === "학년") &&
        row?.some((value) => String(value).includes("성명")));
      if (headerIndex < 0 || headerIndex < 1) {
        throw new Error("첫 번째 시트에서 학년·반·번호·성명/학점 및 과목 열을 찾지 못했습니다.");
      }

      const creditRow = rows[headerIndex] || [];
      const findColumn = (matcher) => creditRow.findIndex((value) =>
        matcher(String(value ?? "").replace(/\s+/g, "").trim()));
      const gradeColumn = findColumn((value) => value === "학년");
      const classColumn = findColumn((value) => value === "반");
      const numberColumn = findColumn((value) => /^(번호|출석번호)$/.test(value));
      const nameColumn = findColumn((value) => value.includes("성명"));
      const studentIdColumn = findColumn((value) => /학번|학생ID|학생식별번호/.test(value));
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
        if (column === studentIdColumn) continue;
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

      const students = [];
      for (let index = headerIndex + 1; index < rows.length; index++) {
        const row = rows[index];
        if (!row) continue;
        const grade = String(row[gradeColumn] ?? "").trim();
        const classroom = String(row[classColumn] ?? "").trim();
        const number = String(row[numberColumn] ?? "").trim();
        const name = String(row[nameColumn] ?? "").trim();
        const studentId = studentIdColumn >= 0 ? String(row[studentIdColumn] ?? "").trim() : "";
        if (!name || !grade || !classroom || !number) continue;
        const selections = courses.filter((course) => isSelected(row[course.column]));
        students.push({
          id: `${grade}-${classroom}-${number}-${name}`,
          studentId, grade, classroom, number, name, selections,
          totalCredits: selections.reduce((total, course) => total + course.credits, 0)
        });
      }
      if (!students.length) throw new Error("학생 자료 행을 찾지 못했습니다. 엑셀 열 배치를 확인해 주세요.");
      return { courses, students };
    }

    function createCurriculumRecords(rows) {
      const headerIndex = rows.findIndex((row) =>
        row?.some((value) => String(value).trim().includes("과목명")) &&
        row?.some((value) => String(value).trim().includes("기준학점")));
      if (headerIndex < 0) throw new Error("교육과정 목록에서 과목명/기준학점 헤더를 찾지 못했습니다.");
      const headerRow = rows[headerIndex] || [];
      const findColumn = (matcher) => headerRow.findIndex((value) => matcher(String(value ?? "").trim()));
      const subjectColumn = findColumn((value) => value.includes("과목명"));
      const areaColumn = findColumn((value) => value === "교과(군)");
      const area2Column = findColumn((value) => value === "교과(군)2");
      const typeColumn = findColumn((value) => value.includes("과목유형"));
      const creditColumn = findColumn((value) => value.includes("기준학점"));
      const minColumn = findColumn((value) => value.includes("최소"));
      const maxColumn = findColumn((value) => value.includes("최대"));
      if (subjectColumn < 0 || creditColumn < 0) throw new Error("교육과정 목록의 필수 열(과목명/기준학점)이 없습니다.");

      const records = [];
      for (let index = headerIndex + 1; index < rows.length; index++) {
        const row = rows[index] || [];
        const subject = String(row[subjectColumn] ?? "").trim();
        if (!subject) continue;
        records.push({
          area: normalizeCurriculumAreaName(
            areaColumn >= 0 ? String(row[areaColumn] ?? "").trim() : "",
            subject
          ),
          area2: area2Column >= 0 ? String(row[area2Column] ?? "").trim() : "",
          type: typeColumn >= 0 ? String(row[typeColumn] ?? "").trim() : "",
          subject,
          credit: Number(row[creditColumn]) || 0,
          minCredit: minColumn >= 0 ? (Number(row[minColumn]) || 0) : 0,
          maxCredit: maxColumn >= 0 ? (Number(row[maxColumn]) || 0) : 0
        });
      }
      if (!records.length) throw new Error("교육과정 목록에서 과목 데이터를 찾지 못했습니다.");
      return records;
    }

    function createCurriculumPlanRecords(rows, context = "") {
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
        for (const subjectName of subjects) {
          records.push(normalizeCurriculumPlanRow({
            grade: lastGrade,
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

    function curriculumBundleSummaryHtml(rows) {
      const bundles = new Map();
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
      if (!bundles.size) return "";
      const chips = [...bundles.values()]
        .sort((a, b) => Number(a.grade) - Number(b.grade) || a.name.localeCompare(b.name, "ko"))
        .map((item) => `<span class="curriculum-bundle-chip">${escapeHtml(item.grade)}학년 ${escapeHtml(item.name)} · ${item.total}과목 중 ${item.pick}개 선택</span>`)
        .join("");
      return `<div class="curriculum-bundle-summary">${chips}</div>`;
    }

    function curriculumSemesterHoursSummaryHtml(indexedRows, grade) {
      const totals = CURRICULUM_SEMESTER_FIELDS.map((field) => {
        const total = indexedRows.reduce(({ hours, count }, { item }) => {
          if (!String(item[field] || "").trim()) return { hours, count };
          return {
            hours: hours + (Number(item.opCredit) || 0),
            count: count + 1
          };
        }, { hours: 0, count: 0 });
        return { field, label: `${field.slice(3, 4)}-${field.slice(4)}`, ...total };
      });
      if (!totals.some(({ count }) => count)) return "";
      const chips = totals.map(({ label, hours }) =>
        `<span class="curriculum-hours-item">${label} · ${hours}시간</span>`
      ).join("");
      return `<div class="curriculum-hours-summary"><span class="curriculum-hours-title">${escapeHtml(grade)}학년 학기별 시수</span>${chips}</div>`;
    }

    function importedPlanCoveredCells(layout) {
      const covered = new Set();
      for (const reference of layout?.mergedRanges || []) {
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

    // 편제표의 각 과목 행에 대해 위쪽 셀·병합에서 이어받은 학년/교육과정/교과군/선택 유형 문맥을 계산한다.
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

    function curriculumImportedSheetHtml(layout, filters = {}) {
      if (!layout || !Array.isArray(layout.rows) || !layout.rows.length) return "";
      const rows = layout.rows;
      const columns = importedPlanColumnMap(layout);
      const courseRows = new Set();
      const matchingRows = new Set();
      for (const context of importedPlanCourseContexts(layout, columns)) {
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
      const isHiddenRow = (rowIndex) => hasActiveFilter && courseRows.has(rowIndex) && !matchingRows.has(rowIndex);
      const visibleRowIndexes = Array.from({ length: rowCount }, (_, rowIndex) => rowIndex)
        .filter((rowIndex) => !isHiddenRow(rowIndex));
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
      const colGroup = Array.from({ length: columnCount }, (_, column) => {
        const excelWidth = Number(layout.columnWidths?.[column]);
        const width = Number.isFinite(excelWidth) && excelWidth > 0
          ? `${Math.max(44, Math.min(360, Math.round(excelWidth * 7 + 12)))}px`
          : "100px";
        return `<col style="width:${width}">`;
      }).join("");
      const tableRows = visibleRowIndexes.map((rowIndex) => {
        const row = rows[rowIndex] || [];
        const hasHeader = row.some((value) => /과목명|기준학점|운영학점|세부과목/.test(String(value ?? "")));
        const height = Number(layout.rowHeights?.[rowIndex]);
        const rowStyle = Number.isFinite(height) && height > 0
          ? ` style="height:${Math.max(20, Math.min(240, Math.round(height * 1.35)))}px"`
          : "";
        const cells = [];
        for (let column = 0; column < columnCount; column++) {
          const merge = mergeAt.get(`${rowIndex}:${column}`);
          if (!merge && covered.has(`${rowIndex}:${column}`)) continue;
          const sourceRow = merge ? merge.startRow : rowIndex;
          const fill = curriculumCellFill(layout, sourceRow, column);
          const fillStyle = /^#[0-9A-F]{6}$/i.test(fill) ? ` style="background-color:${fill}"` : "";
          const value = String((merge ? rows[merge.startRow] : row)?.[column] ?? "");
          if (!merge && !value) {
            cells.push(`<td contenteditable="true" spellcheck="false" data-source-row="${rowIndex}" data-source-column="${column}"${fillStyle}></td>`);
            continue;
          }
          const span = merge
            ? ` rowspan="${merge.rowSpan}" colspan="${merge.endColumn - merge.startColumn + 1}"`
            : "";
          cells.push(`<td contenteditable="true" spellcheck="false" data-source-row="${sourceRow}" data-source-column="${column}"${span}${fillStyle}>${escapeHtml(value)}</td>`);
        }
        return `<tr${hasHeader ? ' class="curriculum-source-header"' : ""}${rowStyle}>${cells.join("")}</tr>`;
      }).join("");
      return `<div class="curriculum-imported-sheet" aria-label="${escapeHtml(layout.sheetName || "불러온 편제표")}"><table class="curriculum-source-table"><colgroup>${colGroup}</colgroup><tbody>${tableRows}</tbody></table></div>`;
    }

    function curriculumImportedGradeSummaries(rows) {
      const grades = [...new Set(rows.map(({ item }) => String(item.grade || "1")))]
        .sort((a, b) => Number(a) - Number(b));
      return grades.map((grade) => {
        const gradeRows = rows.filter(({ item }) => String(item.grade || "1") === grade);
        return curriculumSemesterHoursSummaryHtml(gradeRows, grade);
      }).join("");
    }

    function filteredCurriculumCatalog() {
      const query = String(state.curriculumCatalogQuery || "").trim().toLocaleLowerCase();
      if (!query) return [...state.curriculumCatalog];
      return state.curriculumCatalog.filter((item) =>
        [item.subject, curriculumAreaOf(item), item.type]
          .some((value) => String(value || "").toLocaleLowerCase().includes(query))
      );
    }

    function isAlreadyPlacedInPlan(item) {
      const subject = String(item?.subject || "").trim();
      return state.curriculumPlan.some((row) => String(row.subject || "").trim() === subject);
    }

    function curriculumPickListHtml() {
      const rows = filteredCurriculumCatalog()
        .map((item, index) => ({ item, index, used: isAlreadyPlacedInPlan(item) }))
        .sort((left, right) => Number(left.used) - Number(right.used) || left.index - right.index);
      if (!rows.length) return `<div class="curriculum-empty">${state.curriculumCatalog.length
        ? "검색 조건에 맞는 과목이 없습니다."
        : "교육과정 목록을 불러오면 과목별로 표시됩니다."}</div>`;
      return rows.map(({ item, used }) => {
        const detail = String(item.type || "").trim();
        return `<button class="curriculum-pick-item${used ? " used" : ""}" type="button" data-curriculum-subject="${escapeHtml(item.subject)}" draggable="${used ? "false" : "true"}"${used ? " disabled" : ""}>
          <span>${escapeHtml(item.subject)}${detail ? ` <small>· ${escapeHtml(detail)}</small>` : ""}</span><small>${escapeHtml(item.credit || 0)}학점</small>
        </button>`;
      }).join("");
    }

    function renderCurriculumCatalog() {
      $("#curriculumFileName").textContent = state.curriculumFileName
        ? `저장된 교육과정: ${state.curriculumFileName} · ${state.curriculumCatalog.length}과목`
        : "저장된 교육과정 목록 없음";
      $("#curriculumPickList").innerHTML = curriculumPickListHtml();
      const queryInput = $("#curriculumCatalogQuery");
      if (queryInput.value !== state.curriculumCatalogQuery) queryInput.value = state.curriculumCatalogQuery;
      const visibleCount = filteredCurriculumCatalog().length;
      $("#curriculumCatalogFilterCount").textContent = state.curriculumCatalog.length
        ? `${visibleCount}/${state.curriculumCatalog.length}과목`
        : "";
    }

    function syncCurriculumTemplateRows() {
      state.curriculumTemplateRows = state.curriculumPlan.map((row) => normalizeCurriculumPlanRow(row));
    }

    function syncCurriculumPlanYearSnapshot(year = $("#schoolYear").value) {
      const academicYear = String(year || "").trim();
      if (!academicYear) return;
      state.curriculumPlanAcademicYear = academicYear;
      state.curriculumPlansByYear = {
        ...(state.curriculumPlansByYear || {}),
        [academicYear]: state.curriculumPlan.map((row) => normalizeCurriculumPlanRow(row))
      };
    }

    function curriculumSnapshot() {
      return JSON.parse(JSON.stringify({
        curriculumPlan: state.curriculumPlan,
        curriculumTemplateRows: state.curriculumTemplateRows,
        curriculumImportedLayout: state.curriculumImportedLayout,
        curriculumPlanFileName: state.curriculumPlanFileName,
        curriculumPlanAcademicYear: state.curriculumPlanAcademicYear,
        curriculumPlansByYear: state.curriculumPlansByYear
      }));
    }

    function recordCurriculumUndo(snapshot = curriculumSnapshot()) {
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
      if (!snapshot.curriculumImportedLayout) curriculumLayoutStoredId = "";
      state.curriculumPlanFileName = snapshot.curriculumPlanFileName;
      state.curriculumPlanAcademicYear = snapshot.curriculumPlanAcademicYear || "";
      state.curriculumPlansByYear = snapshot.curriculumPlansByYear || {};
      scheduleCurriculumLayoutPersistence();
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
      $("#undoCurriculumEdit").disabled = !state.curriculumUndoStack.length;
      renderCurriculumCatalog();
      updateCurriculumFilterOptions();
      $("#curriculumTemplateFileName").textContent = state.curriculumPlanFileName
        ? `불러온 편제표: ${state.curriculumPlanFileName}`
        : "편제표를 불러오지 않았습니다.";
      const importedLayout = state.curriculumImportedLayout;
      if (importedLayout) {
        const planRows = state.curriculumPlan.map((item, index) => ({ item, index }));
        $("#curriculumPlanWrap").innerHTML =
          `${curriculumBundleSummaryHtml(planRows.map(({ item }) => item))}` +
          `${curriculumImportedGradeSummaries(planRows)}` +
          `${curriculumImportedSheetHtml(importedLayout, state.curriculumPlanFilters)}`;
      } else {
        $("#curriculumPlanWrap").innerHTML = '<div class="curriculum-empty">편제표 파일을 불러오면 여기에 표시됩니다.</div>';
        $("#curriculumFilterCount").textContent = "0개 과목 표시";
      }
    }

    function aggregateRecords(
      students,
      courses,
      openingPercent,
      divisionPercent,
      classOverrides = {},
      semesterAssignments = {},
      groupAssignments = {},
      plannedClassCounts = {}
    ) {
      const grades = [...new Set(students.map((student) => student.grade))];
      const reports = grades.map((grade) => {
        const gradeStudents = students.filter((student) => student.grade === grade);
        const classes = new Set(gradeStudents.map((student) => student.classroom)).size;
        const summary = {
          grade,
          students: gradeStudents.length,
          classes,
          plannedClasses: Number.isInteger(plannedClassCounts[String(Number(grade) + 1)]) &&
            plannedClassCounts[String(Number(grade) + 1)] > 0
            ? plannedClassCounts[String(Number(grade) + 1)]
            : classes,
          averageClassSize: classes ? gradeStudents.length / classes : 0,
          openingLimit: classes ? (gradeStudents.length / classes) * openingPercent / 100 : 0,
          divisionLimit: classes ? (gradeStudents.length / classes) * divisionPercent / 100 : 0
        };
        const semesters = [];
        for (const course of courses) {
          if (!courseBelongsToCurrentGrade(course, grade, students)) continue;
          const applicationGroup = applicationGroupForCourse(course, grade);
          const applicationGroups = typeof applicationGroupMatchesForCourse === "function"
            ? applicationGroupMatchesForCourse(course, grade) : [];
          const forcedSemester = semesterAssignments[String(course.column)];
          const parsedAssignedGroup = parseAssignedGroupLabel(groupAssignments[String(course.column)]);
          const displayGrade = Number(grade) + 1;
          const curriculumSemester = curriculumSemesterForCourse(course, displayGrade);
          const enrollment = gradeStudents.filter((student) =>
            student.selections.some((selection) => selection.column === course.column)).length;
          const recommendedClasses = summary.divisionLimit > 0 && enrollment > 0
            ? Math.ceil(enrollment / summary.divisionLimit)
            : 0;
          const overrideKey = `${grade}:${course.column}`;
          const legacyClassCount = Object.prototype.hasOwnProperty.call(classOverrides, overrideKey)
            ? classOverrides[overrideKey]
            : recommendedClasses;
          let matchingGroups = applicationGroups;
          const explicitSemester = [forcedSemester, parsedAssignedGroup.semesterKey]
            .map((value) => String(value || ""))
            .find((value) => value === "1" || value === "2");
          if (matchingGroups.length > 1) {
            const preferredSemester = explicitSemester ||
              (curriculumSemester === "1" || curriculumSemester === "2" ? curriculumSemester : "");
            if (preferredSemester) {
              const preferredGroups = matchingGroups.filter((item) => item.semester === preferredSemester);
              matchingGroups = preferredGroups;
            }
          }
          let groupTargets;
          if (matchingGroups.length > 1 &&
              new Set(matchingGroups.map((item) => item.semester)).size > 1) {
            groupTargets = matchingGroups;
          } else if (matchingGroups.length === 1) {
            groupTargets = matchingGroups;
          } else {
            groupTargets = applicationGroup ? [applicationGroup] : [null];
          }
          for (const targetGroup of groupTargets) {
            const semesterKey = [
              forcedSemester,
              parsedAssignedGroup.semesterKey,
              targetGroup?.semester,
              curriculumSemester,
              course.semesterKey,
            ].map((value) => String(value || ""))
              .find((value) => value === "1" || value === "2") || "";
            const semesterName = semesterKey
              ? `${displayGrade}학년 ${semesterKey}학기`
              : `${displayGrade}학년 미분류`;
            const category = parsedAssignedGroup.category || targetGroup?.name || UNASSIGNED_GROUP;
            let semester = semesters.find((item) => item.name === semesterName);
            if (!semester) {
              semester = { name: semesterName, groups: [], order: semesterKey === "1" ? 1 : semesterKey === "2" ? 2 : 9 };
              semesters.push(semester);
            }
            const groupKey = !parsedAssignedGroup.category && targetGroup?.id
              ? targetGroup.id : category;
            let group = semester.groups.find((item) => item.key === groupKey);
            if (!group) {
              group = { key: groupKey, category, courses: [], choiceCount: null };
              semester.groups.push(group);
            }
            if (Number.isInteger(targetGroup?.count) && targetGroup.count >= 0) {
              group.choiceCount = targetGroup.count;
            }
            const classOverrideKey = `${overrideKey}:${semesterKey}:${groupKey}`;
            const classCount = classOverrides[classOverrideKey] ?? legacyClassCount;
            group.courses.push({
              category,
              classOverrideKey,
              column: course.column,
              name: course.name,
              enrollment,
              enrollmentPerDivision: summary.divisionLimit > 0 ? enrollment / summary.divisionLimit : 0,
              recommendedClasses,
              classCount,
              averageClassSize: classCount ? enrollment / classCount : 0
            });
          }
        }
        for (const semester of semesters) {
          for (const group of semester.groups) {
            group.totalClasses = group.choiceCount === null
              ? group.courses.reduce((total, item) => total + item.classCount, 0)
              : summary.plannedClasses * group.choiceCount;
            group.actualClasses = group.courses.reduce((total, item) => total + item.classCount, 0);
          }
        }
        semesters.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, "ko"));
        return { summary, semesters };
      });
      return { openingPercent, divisionPercent, reports };
    }

    function allocateAggregateClasses(aggregate) {
      const overrides = {};
      let adjustedGroups = 0;
      let skippedGroups = 0;
      for (const report of aggregate.reports) {
        for (const semester of report.semesters) {
          for (const group of semester.groups) {
            if (group.choiceCount === null) { skippedGroups++; continue; }
            const target = group.totalClasses;
            if (!Number.isSafeInteger(target) || target < 0) throw new Error("총 학급수는 0 이상의 안전한 정수여야 합니다.");
            const enrollment = group.courses.reduce((sum, course) => sum + course.enrollment, 0);
            if (!enrollment && target) throw new Error(`${semester.name} ${group.category}: 신청 인원이 없어 학급수를 배분할 수 없습니다.`);
            const positive = group.courses.filter((course) => course.enrollment > 0).length;
            const allocations = group.courses.map((course) => {
              const quota = enrollment ? target * course.enrollment / enrollment : 0;
              const minimum = course.enrollment > 0 && target >= positive ? 1 : 0;
              return { course, quota, minimum, count: Math.max(minimum, Math.floor(quota)) };
            });
            let sum = allocations.reduce((total, item) => total + item.count, 0);
            while (sum !== target) {
              const adding = sum < target;
              const candidates = allocations.filter((item) => adding
                ? item.course.enrollment > 0 : item.count > item.minimum);
              candidates.sort((a, b) => adding
                ? (b.quota - b.count) - (a.quota - a.count)
                : (b.count - b.quota) - (a.count - a.quota));
              if (!candidates.length) throw new Error(`${group.category}: 목표 학급수에 맞출 수 없습니다.`);
              candidates[0].count += adding ? 1 : -1;
              sum += adding ? 1 : -1;
            }
            for (const item of allocations) overrides[item.course.classOverrideKey] = item.count;
            adjustedGroups++;
          }
        }
      }
      if (!adjustedGroups) throw new Error("조정할 선택군이 없습니다. 2단계에서 그룹별 선택 과목 수를 지정하세요.");
      return { overrides, adjustedGroups, skippedGroups };
    }

    function currentStudent() {
      const currentGrade = targetGradeCurrentGrade(state.certificateTargetGrade || "2");
      return state.students.find((student) =>
        student.id === state.selectedId && String(student.grade) === currentGrade) ||
        state.students.find((student) => String(student.grade) === currentGrade) || null;
    }

    function visibleStudents() {
      const query = $("#searchInput").value.trim().toLocaleLowerCase();
      const classValue = $("#classFilter").value;
      const currentGrade = targetGradeCurrentGrade(state.certificateTargetGrade || "2");
      return state.students.filter((student) => {
        const searchable = `${student.name} ${student.grade} ${student.classroom} ${student.number}`.toLocaleLowerCase();
        return String(student.grade) === currentGrade &&
          (!query || searchable.includes(query)) &&
          (!classValue || student.classroom === classValue);
      });
    }

    function renderRoster() {
      const students = visibleStudents();
      const currentGrade = targetGradeCurrentGrade(state.certificateTargetGrade || "2");
      const gradeStudentCount = state.students.filter((student) => String(student.grade) === currentGrade).length;
      for (const tab of $("#certificateGradeTabs")?.querySelectorAll?.("[data-certificate-grade]") || []) {
        tab.setAttribute("aria-selected", String(tab.dataset.certificateGrade) === String(state.certificateTargetGrade || "2") ? "true" : "false");
      }
      $("#studentCount").textContent = `${students.length} / ${gradeStudentCount}명`;
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

    function historyRecordKey(record) {
      return [record.studentId, record.schoolYear, record.grade, record.courseName, record.semester || ""]
        .map((value) => String(value || "").trim()).join("|");
    }

    function studentHistory(student) {
      if (!student.studentId) return [];
      const targetGrade = Number(student.grade) + 1;
      return state.priorCourseHistory.filter((record) =>
        String(record.studentId || "") === String(student.studentId || "") &&
        Number(record.grade) < targetGrade &&
        Number(record.schoolYear) < Number($("#schoolYear").value)
      ).sort((a, b) =>
        Number(a.schoolYear) - Number(b.schoolYear) || Number(a.grade) - Number(b.grade) ||
        String(a.courseName).localeCompare(String(b.courseName), "ko"));
    }

    function addHistoryRecord(record) {
      const key = historyRecordKey(record);
      const existing = new Map(state.priorCourseHistory.map((item) => [historyRecordKey(item), item]));
      if (existing.has(key)) return false;
      existing.set(key, { ...record, status: record.status === "incomplete" ? "incomplete" : "completed" });
      state.priorCourseHistory = [...existing.values()];
      return true;
    }

    function archiveCurrentAcademicYear(previousYear, nextYear) {
      const yearKey = String(previousYear);
      if (!previousYear || state.historyArchivedYears[yearKey]) return { archived: 0, skipped: 0 };
      let archived = 0;
      let skipped = 0;
      for (const student of state.students) {
        if (!student.studentId) {
          skipped++;
          continue;
        }
        const targetGrade = String(Number(student.grade) + 1);
        const studentCourses = new Map();
        for (const course of student.selections || []) {
          studentCourses.set(`${course.name}|${course.semesterKey || ""}`, {
            courseName: course.name,
            semester: course.semesterKey || "",
            credit: Number(course.credits) || 0,
            area: course.area || course.category || ""
          });
        }
        const savedPlan = state.curriculumPlansByYear?.[yearKey];
        const schoolPlan = Array.isArray(savedPlan)
          ? savedPlan
          : (!state.curriculumPlanAcademicYear || state.curriculumPlanAcademicYear === yearKey)
            ? state.curriculumPlan : [];
        for (const row of schoolPlan) {
          if (String(row.grade) !== targetGrade ||
              normalizeCurriculumDivision(row.division) !== "학교 지정 교육과정") continue;
          const name = String(row.subject || "").trim();
          if (!name) continue;
          for (const [semesterIndex, field] of CURRICULUM_SEMESTER_FIELDS.entries()) {
            const credit = Number(row[field]) || 0;
            if (!credit) continue;
            const semester = `${Math.floor(semesterIndex / 2) + 1}-${semesterIndex % 2 + 1}`;
            const key = `${name}|${semester}`;
            studentCourses.set(key, {
              courseName: name,
              semester,
              credit,
              area: row.area || ""
            });
          }
        }
        for (const course of studentCourses.values()) {
          if (addHistoryRecord({
            studentId: String(student.studentId),
            schoolYear: yearKey,
            grade: targetGrade,
            courseName: course.courseName,
            semester: course.semester,
            credit: course.credit,
            area: course.area,
            status: "completed"
          })) archived++;
        }
      }
      state.historyArchivedYears[yearKey] = { nextYear: String(nextYear), archivedAt: new Date().toISOString() };
      return { archived, skipped };
    }

    function prepareAcademicYearImport() {
      const nextYear = String($("#schoolYear").value || "").trim();
      const previousYear = String(state.activeDataSchoolYear || "").trim();
      if (!nextYear) return;
      if (previousYear && previousYear !== nextYear) {
        state.students = [];
        state.courses = [];
        state.selectedId = null;
        state.fileName = "";
        state.classOverrides = {};
        state.semesterAssignments = {};
        state.groupAssignments = {};
        state.rounds = { "1": null };
        state.roundClosures = { "1": {} };
        state.currentRound = "1";
        state.activeDataSchoolYear = nextYear;
      } else if (!previousYear) {
        state.activeDataSchoolYear = nextYear;
      }
    }

    function handleSchoolYearChange() {
      const nextYear = String($("#schoolYear").value || "").trim();
      const previousYear = String(state.activeDataSchoolYear || "").trim();
      if (previousYear && nextYear && Number(nextYear) > Number(previousYear)) {
        const result = archiveCurrentAcademicYear(previousYear, nextYear);
        status.style.color = result.skipped ? "#a44939" : "#287956";
        status.textContent = `${previousYear}학년도 이력을 ${result.archived}개 과목 누적했습니다.` +
          (result.skipped ? ` 학번이 없어 ${result.skipped}명은 자동 연결하지 못했습니다. 이수 이력 파일을 업로드하세요.` : "");
      }
      updateCertificateText();
    }

    async function handleHistoryWorkbook(file) {
      if (!file) return;
      try {
        if (!file.name.toLowerCase().endsWith(".xlsx")) throw new Error("이수 이력 파일은 .xlsx 형식이어야 합니다.");
        const sheets = await parseWorkbook(await file.arrayBuffer());
        const rows = sheets[0]?.rows || [];
        const compact = (value) => String(value ?? "").replace(/\s+/g, "");
        const headerIndex = rows.findIndex((row) => {
          const header = row.map(compact);
          return header.some((value) => /^(학번|학생ID|학생식별번호)$/.test(value)) &&
            header.some((value) => /학년도/.test(value)) &&
            header.some((value) => /^(과목명|과목)$/.test(value));
        });
        if (headerIndex < 0) throw new Error("학번·학년도·과목명 머리글이 있는 이수 이력 양식인지 확인하세요.");
        const header = rows[headerIndex].map(compact);
        const find = (pattern) => header.findIndex((value) => pattern.test(value));
        const columns = {
          studentId: find(/^(학번|학생ID|학생식별번호)$/),
          schoolYear: find(/학년도/),
          grade: find(/^학년$/),
          courseName: find(/^(과목명|과목)$/),
          credit: find(/학점/),
          area: find(/^(교과군|교과)$/),
          semester: find(/학기/),
          status: find(/이수여부|상태/)
        };
        let imported = 0;
        for (const row of rows.slice(headerIndex + 1)) {
          const studentId = String(row[columns.studentId] ?? "").trim();
          const schoolYear = String(row[columns.schoolYear] ?? "").trim().replace(/학년도$/, "");
          const grade = String(row[columns.grade] ?? "").trim().replace(/학년$/, "");
          const courseName = String(row[columns.courseName] ?? "").trim();
          if (!studentId && !schoolYear && !courseName) continue;
          if (!studentId || !/^\d{4}$/.test(schoolYear) || !/^[1-3]$/.test(grade) || !courseName) {
            throw new Error("이수 이력의 학번·4자리 학년도·1~3학년·과목명을 확인하세요.");
          }
          if (addHistoryRecord({
            studentId, schoolYear, grade, courseName,
            credit: Number(row[columns.credit]) || 0,
            area: columns.area >= 0 ? String(row[columns.area] ?? "").trim() : "",
            semester: columns.semester >= 0 ? String(row[columns.semester] ?? "").trim() : "",
            status: columns.status >= 0 && /미이수|미완료/.test(String(row[columns.status] ?? "")) ? "incomplete" : "completed"
          })) imported++;
        }
        status.style.color = "#287956";
        status.textContent = `${file.name}에서 이수 이력 ${imported}개 과목을 추가했습니다.`;
        renderPreview();
        persistState();
      } catch (error) {
        status.style.color = "#a44939";
        status.textContent = error instanceof Error ? error.message : "이수 이력 파일을 처리하지 못했습니다.";
      }
    }

    function certificateMarkup(student, printMode = false) {
      const history = studentHistory(student);
      const completedHistory = history.filter((record) => record.status !== "incomplete");
      const groups = [];
      for (const course of student.selections) {
        const groupName = courseGroupLabel(course, student.grade);
        let group = groups.find((item) => item.name === groupName);
        if (!group) { group = { name: groupName, courses: [] }; groups.push(group); }
        group.courses.push(course);
      }
      const body = groups.length
        ? groups.map((group) => group.courses.map((course, index) => `
            <tr>${index === 0 ? `<td class="group-cell" rowspan="${group.courses.length}">${escapeHtml(group.name)}</td>` : ""}
              <td class="course-cell">${escapeHtml(course.name)}</td><td class="credit-cell">${course.credits || "—"}</td></tr>`).join("")).join("")
        : '<tr><td colspan="3" style="height:56px;text-align:center">신청 과목이 없습니다.</td></tr>';
      const historyBody = history.length
        ? history.map((record) => `<tr>
            <td>${escapeHtml(record.schoolYear)} · ${escapeHtml(record.grade)}학년</td>
            <td>${escapeHtml(record.area || "이전 이수")}</td>
            <td>${escapeHtml(record.courseName)}${record.semester ? ` (${escapeHtml(record.semester)})` : ""}</td>
            <td>${Number(record.credit) || "—"}</td>
            <td>${printMode ? (record.status === "incomplete" ? "미이수" : "이수") :
              `<select class="history-status" data-history-key="${escapeHtml(historyRecordKey(record))}" aria-label="${escapeHtml(record.courseName)} 이수 상태">
                <option value="completed"${record.status !== "incomplete" ? " selected" : ""}>이수</option>
                <option value="incomplete"${record.status === "incomplete" ? " selected" : ""}>미이수</option>
              </select>`}</td>
          </tr>`).join("")
        : `<tr><td colspan="5">${student.studentId ? "등록된 이전 이수 내역이 없습니다." : "학번이 없어 이전 이수 내역과 자동 연결할 수 없습니다."}</td></tr>`;
      const historicalCredits = completedHistory.reduce((sum, course) => sum + (Number(course.credit) || 0), 0);
      const currentCoreCredits = student.selections.reduce((sum, course) =>
        sum + (isCoreCourse(course) ? Number(course.credits) || 0 : 0), 0);
      const historicalCoreCredits = completedHistory.reduce((sum, course) =>
        sum + (isCoreCourse({ area: course.area, category: course.area, name: course.courseName }) ? Number(course.credit) || 0 : 0), 0);
      const totalCredits = historicalCredits + student.totalCredits;
      const coreCredits = historicalCoreCredits + currentCoreCredits;
      const corePercent = totalCredits ? Math.round(coreCredits / totalCredits * 100) : 0;
      const additionalCoreCredits = Math.max(0, totalCredits - coreCredits * 2);
      const coreLimitStatus = coreCredits * 2 > totalCredits
        ? "현재 국·영·수 비율이 50% 권고를 초과했습니다."
        : "현재 국·영·수 비율은 50% 권고 범위입니다.";
      const gauge = `<div class="paper-credit-gauge" aria-label="총 이수 및 신청 ${totalCredits}학점 중 국어·영어·수학 ${coreCredits}학점, ${corePercent}%">
        <div class="paper-credit-gauge-label"><strong>이전 이수 ${historicalCredits}학점 + 현재 신청 ${student.totalCredits}학점</strong><span>국·영·수 ${coreCredits}학점 · ${corePercent}%</span></div>
        <span class="paper-credit-gauge-track core"><span style="width:${corePercent}%"></span></span>
        <div class="paper-credit-gauge-label${coreCredits * 2 > totalCredits ? " over-limit" : ""}"><span>${coreLimitStatus}</span><strong>추가 가능 ${additionalCoreCredits}학점</strong></div>
      </div>`;
      return `<article class="${printMode ? "print-page" : "preview-paper"}">
        <div class="paper">
          <h2 class="paper-title">학생 수강 신청 확인서</h2>
          <div class="paper-meta"><span class="academic">${escapeHtml($("#schoolYear").value || "____")}학년도&nbsp; ${escapeHtml($("#round").value || "수강 신청")}</span><span></span></div>
          <p class="paper-student">${escapeHtml(student.grade)} 학년&nbsp;&nbsp; ${escapeHtml(student.classroom)} 반&nbsp;&nbsp; ${escapeHtml(student.number)} 번&nbsp;&nbsp; ${escapeHtml(student.name)}</p>
          <table class="certificate-table">
            <thead><tr><th class="group-cell">선택군</th><th class="course-cell">과목명</th><th class="credit-cell">학점</th></tr></thead>
            <tbody>${body}</tbody>
          </table>
          <h3 class="history-heading">이전 이수 내역</h3>
          <table class="certificate-table history-table">
            <thead><tr><th>학년도·학년</th><th>교과군</th><th>과목명</th><th>학점</th><th>상태</th></tr></thead>
            <tbody>${historyBody}</tbody>
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
        const currentGrade = targetGradeCurrentGrade(state.certificateTargetGrade || "2");
        const gradeStudentCount = state.students.filter((item) => String(item.grade) === currentGrade).length;
        $("#previewSubheading").textContent = `${gradeStudentCount}명의 확인서를 준비했습니다.`;
        $("#printSelected").disabled = true;
        $("#printAll").disabled = visibleStudents().length === 0;
        return;
      }
      preview.className = "preview-paper";
      preview.innerHTML = certificateMarkup(student);
      $("#previewSubheading").textContent = `${student.grade}학년 ${student.classroom}반 ${student.number}번 · ${student.selections.length}과목 · ${student.totalCredits}학점`;
      $("#printSelected").disabled = false;
      $("#printAll").disabled = visibleStudents().length === 0;
    }

    function renderSemesterClassifier() {
      const container = $("#semesterClassifier");
      const targetGrade = ["2", "3"].includes(String(state.classifierTargetGrade))
        ? String(state.classifierTargetGrade) : "2";
      const currentGrade = targetGradeCurrentGrade(targetGrade);
      for (const tab of $("#classifierGradeTabs")?.querySelectorAll?.("[data-classifier-grade]") || []) {
        tab.setAttribute("aria-selected", String(tab.dataset.classifierGrade) === targetGrade ? "true" : "false");
      }
      const courses = coursesForCurrentGrade(currentGrade);
      if (!courses.length) {
        container.innerHTML = `<div class="aggregate-empty">${targetGrade}학년 과목 자료가 없습니다.</div>`;
        return;
      }
      const customNames = gradeGroupNames(targetGrade);
      const customAndAssigned = [...new Set([
        ...customNames,
        ...courses.map((course) => normalizeGroupName(state.groupAssignments[String(course.column)]))
      ])].filter((name) => name && name !== UNASSIGNED_GROUP);
      const groupNames = [UNASSIGNED_GROUP, ...customAndAssigned];
      const groupedCourses = new Map(groupNames.map((name) => [name, []]));
      for (const course of courses) {
        const category = resolveCourseCategory(course);
        if (!groupedCourses.has(category)) groupedCourses.set(category, []);
        groupedCourses.get(category).push(course);
      }
      const selectedSet = new Set(state.selectedCourseColumns.map((value) => String(value)));
      const unassignedList = groupedCourses.get(UNASSIGNED_GROUP) || [];
      const renderCards = (list) => list.length
        ? list.map((course) => {
          const selectedClass = selectedSet.has(String(course.column)) ? " selected" : "";
          return `<div class="group-course-card${selectedClass}" draggable="true" data-drag-course-column="${course.column}" data-course-grade="${currentGrade}">
            <span title="${escapeHtml(course.name)}">${escapeHtml(course.name)}</span>
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
            <input id="newGroupName" type="text" placeholder="${targetGrade}학년 새 이동수업 반 이름 입력">
            <button class="button" type="button" data-action="add-group">그룹 추가</button>
          </div>
          <div class="group-chip-list">
            ${customNames.length
              ? customNames.map((name) =>
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

    function renderAggregate() {
      const targetGrade = ["2", "3"].includes(String(state.aggregateTargetGrade))
        ? String(state.aggregateTargetGrade) : "2";
      const currentGrade = targetGradeCurrentGrade(targetGrade);
      $("#plannedClassCountLabel").textContent = `${targetGrade}학년 편제 학급수`;
      for (const tab of $("#aggregateGradeTabs")?.querySelectorAll?.("[data-aggregate-grade]") || []) {
        tab.setAttribute("aria-selected", String(tab.dataset.aggregateGrade) === targetGrade ? "true" : "false");
      }
      const students = state.students.filter((student) => String(student.grade) === currentGrade);
      const courses = coursesForCurrentGrade(currentGrade);
      const plannedClassInput = $("#plannedClassCount");
      plannedClassInput.value = String(state.plannedClassCounts[targetGrade] ??
        (students.length ? new Set(students.map((student) => student.classroom)).size : ""));
      if (!students.length || !courses.length) {
        $("#aggregateDescription").textContent = "학생별 신청 명단에서 과목별 인원을 계산했습니다.";
        $("#aggregateContent").innerHTML = `<div class="aggregate-empty">${targetGrade}학년 자료가 없습니다. 해당 학년의 결과를 불러오세요.</div>`;
        $("#downloadAggregate").disabled = true;
        return;
      }
      const openingPercent = Number($("#openingPercent").value);
      const divisionPercent = Number($("#divisionPercent").value);
      if (!(openingPercent > 0) || !(divisionPercent > 0) ||
          !Number.isFinite(openingPercent) || !Number.isFinite(divisionPercent)) {
        $("#aggregateDescription").textContent = "개설 기준과 분반 기준에 0보다 큰 비율을 입력하세요.";
        $("#downloadAggregate").disabled = true;
        return;
      }
      const aggregate = aggregateRecords(
        students, courses, openingPercent, divisionPercent,
        state.classOverrides, state.semesterAssignments, state.groupAssignments, state.plannedClassCounts
      );
      let atRiskCount = 0;
      const allCourses = aggregate.reports.flatMap((report) => report.semesters.flatMap((semester) =>
        semester.groups.flatMap((group) => group.courses)));
      const totalStudents = aggregate.reports.reduce((sum, report) => sum + report.summary.students, 0);
      const totalClasses = aggregate.reports.reduce((sum, report) => sum + report.semesters
        .reduce((semesterSum, semester) => semesterSum + semester.groups
          .reduce((groupSum, group) => groupSum + group.totalClasses, 0), 0), 0);
      $("#aggregateContent").innerHTML = `<div class="aggregate-overview" aria-label="집계 요약">
        <div class="aggregate-overview-card"><span>신청 학생</span><strong>${totalStudents}명</strong></div>
        <div class="aggregate-overview-card"><span>집계 과목</span><strong>${allCourses.length}과목</strong></div>
        <div class="aggregate-overview-card"><span>개설 학급 합계</span><strong>${totalClasses}학급</strong></div>
        <div class="aggregate-overview-card risk"><span>개설 기준 미달</span><strong data-aggregate-risk-count>집계 중</strong></div>
      </div>` + aggregate.reports.map(({ summary, semesters }) => {
        const semesterTables = semesters.map((semester) => {
          const maxCourses = Math.max(...semester.groups.map((group) => group.courses.length));
          const rows = semester.groups.map((group) => {
            const headerCells = group.courses.map((course) => {
              // 신청 인원이 개설기준(학급당 학생수의 N%)보다 적으면 폐강 예정으로 표시한다.
              const risk = course.enrollment < summary.openingLimit;
              if (risk) atRiskCount += 1;
              return `<th class="aggregate-subject${risk ? " at-risk" : ""}">${escapeHtml(course.name)}${risk ? '<span class="at-risk-badge">폐강 예정</span>' : ""}</th>`;
            }).join("");
            const paddingCells = Array.from({ length: maxCourses - group.courses.length }, () => "<th></th>").join("");
            const totalCell = `<th class="aggregate-total" rowspan="5">총 학급수<br><strong>${group.totalClasses}</strong>${group.actualClasses !== group.totalClasses ? `<br><span class="at-risk-text">배정 ${group.actualClasses} · 목표 차이 ${group.actualClasses - group.totalClasses > 0 ? "+" : ""}${group.actualClasses - group.totalClasses}</span>` : ""}</th>`;
            const metricRows = [
              ["인원 수", (course) => {
                const percent = summary.openingLimit > 0
                  ? Math.round(course.enrollment / summary.openingLimit * 100) : 0;
                const width = Math.max(0, Math.min(100, percent));
                const met = course.enrollment >= summary.openingLimit;
                return `<span class="aggregate-enrollment"><span class="aggregate-enrollment-value">${course.enrollment}명${met ? "" : " · 기준 미달"}</span><span class="aggregate-progress-track ${met ? "met" : "below"}" role="img" aria-label="개설 기준의 ${percent}%"><span style="width:${width}%"></span></span></span>`;
              }],
              ["인원수/분반기준", (course) => course.enrollmentPerDivision.toFixed(2)],
              ["개설 학급수", (course) => `<input class="aggregate-class-input" type="number" min="0" step="1" value="${course.classCount}" aria-label="${escapeHtml(semester.name)} ${escapeHtml(course.name)} 개설 학급수" data-override-key="${escapeHtml(course.classOverrideKey)}">`],
              ["학급당 학생수", (course) => course.averageClassSize.toFixed(2)]
            ].map(([label, value]) => {
              const values = group.courses.map((course) => `<td>${value(course)}</td>`).join("");
              const blanks = Array.from({ length: maxCourses - group.courses.length }, () => "<td></td>").join("");
              return `<tr><th class="aggregate-row-label">${label}</th>${values}${blanks}</tr>`;
            }).join("");
            const groupCaption = group.choiceCount === null
              ? group.category
              : `${group.category} · ${group.choiceCount}과목 선택`;
            return `<table class="aggregate-sheet-table"><caption>${escapeHtml(groupCaption)}</caption><tbody><tr><th class="aggregate-row-label">과목</th>${headerCells}${paddingCells}${totalCell}</tr>${metricRows}</tbody></table>`;
          }).join("");
          return `<h3 class="aggregate-semester">${escapeHtml(semester.name)}</h3><div class="aggregate-sheet-wrap">${rows}</div>`;
        }).join("");
        const displayGrade = Number(summary.grade) + 1;
        return `<section class="aggregate-grade">
          <h3 class="aggregate-grade-heading">${displayGrade}학년(현${summary.grade}학년) 수강신청결과(${escapeHtml($("#round").value || "1차")})<span class="aggregate-grade-date">${escapeHtml($("#confirmDate").value)}</span></h3>
          <div class="aggregate-kpis">
            <div class="aggregate-kpi"><span class="aggregate-kpi-label">총학생수</span><span class="aggregate-kpi-value">${summary.students}</span></div>
            <div class="aggregate-kpi"><span class="aggregate-kpi-label">학급당 학생수</span><span class="aggregate-kpi-value">${summary.averageClassSize.toFixed(2)}</span></div>
            <div class="aggregate-kpi"><span class="aggregate-kpi-label">학급당 학생수의 ${openingPercent}% (개설기준)</span><span class="aggregate-kpi-value highlight">${summary.openingLimit.toFixed(2)}</span></div>
            <div class="aggregate-kpi"><span class="aggregate-kpi-label">학급당 학생수의 ${divisionPercent}% (분반기준)</span><span class="aggregate-kpi-value">${summary.divisionLimit.toFixed(2)}</span></div>
            <p class="aggregate-kpi-note">학급당 학생수는 개설기준과 분반기준의 사이가 되도록 조정합니다. 기준 비율은 위 설정에서 변경할 수 있습니다.</p>
          </div>
          ${semesterTables}
        </section>`;
      }).join("");
      const riskSummary = $("#aggregateContent").querySelector("[data-aggregate-risk-count]");
      if (riskSummary) riskSummary.textContent = `${atRiskCount}과목`;
      $("#aggregateDescription").textContent =
        `${state.currentRound}차 · ${targetGrade}학년 · 기준 비율 ${openingPercent}% / ${divisionPercent}% · 폐강 예정 ${atRiskCount}과목`;
      $("#downloadAggregate").disabled = false;
    }

    // 차수 탭·배지·차수별 보관 현황을 동기화한다.
    function renderRoundStatus() {
      $("#roundSelector").innerHTML = applicationRoundNumbers().map((round) =>
        `<button class="round-tab" type="button" role="tab" data-round="${round}" aria-selected="${round === state.currentRound}">${round}차</button>`
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
        const button = data && round !== state.currentRound
          ? `<button class="button" type="button" data-view-round="${round}">이 차수 보기</button>`
          : "";
        return `<div class="round-status-item"><strong>${round}차${current}</strong><span>${info}</span>${button}</div>`;
      }).join("");
    }

    // 현재 차수의 개설·폐강 검토를 집계표와 함께 표시한다.
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
      const openingPercent = Number($("#openingPercent").value) || 90;
      const divisionPercent = Number($("#divisionPercent").value) || 110;
      const currentGrade = targetGradeCurrentGrade(state.aggregateTargetGrade || "2");
      const students = data.students.filter((student) => String(student.grade) === currentGrade);
      if (!students.length) {
        description.textContent = `${Number(currentGrade) + 1}학년 수강신청 데이터가 없습니다.`;
        content.innerHTML = "";
        return;
      }
      const aggregate = aggregateRecords(
        students, data.courses, openingPercent, divisionPercent,
        data.classOverrides || {}, data.semesterAssignments || {}, data.groupAssignments || {}
      );
      const closures = state.roundClosures[round] || {};
      content.innerHTML = aggregate.reports.map(({ summary, semesters }) => {
        const rowsHtml = semesters.flatMap((semester) =>
          semester.groups.flatMap((group) =>
            group.courses.map((course) => ({ semester: semester.name, course }))))
          .map(({ semester, course }) => {
            const key = `${summary.grade}:${course.column}`;
            const risk = course.enrollment < summary.openingLimit;
            const verdict = risk
              ? '<span class="closure-verdict-risk">폐강 예정</span>'
              : '<span class="closure-verdict-open">개설 가능</span>';
            const confirmed = closures[key] || "";
            return `<tr>
              <td class="closure-subject">${escapeHtml(course.name)}</td>
              <td>${escapeHtml(semester)}</td>
              <td>${course.enrollment}</td>
              <td>${summary.openingLimit.toFixed(2)}</td>
              <td>${verdict}</td>
              <td><select class="closure-select" data-closure-round="${round}" data-closure-key="${escapeHtml(key)}" aria-label="${escapeHtml(course.name)} 개설/폐강 확정">
                <option value=""${confirmed === "" ? " selected" : ""}>미정</option>
                <option value="open"${confirmed === "open" ? " selected" : ""}>개설</option>
                <option value="closed"${confirmed === "closed" ? " selected" : ""}>폐강</option>
              </select></td>
            </tr>`;
          }).join("");
        return `<h3 class="closure-grade-heading">${Number(summary.grade) + 1}학년(현${summary.grade}학년) · 총 ${summary.students}명</h3>
          <table class="closure-table"><thead><tr><th>과목</th><th>학기</th><th>신청 인원</th><th>개설기준</th><th>자동 판정</th><th>확정</th></tr></thead><tbody>${rowsHtml}</tbody></table>`;
      }).join("");
    }

    // 등록된 차수별 폐강 결정을 종합해 마지막 신청 명단의 대상을 계산한다.
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

    function renderRetakePanel() {
      const { sourceRound, data, rows, closedCount } = retakeTargets();
      const nextRound = String(Number(sourceRound) + 1);
      const description = $("#retakeDescription");
      const content = $("#retakeContent");
      $("#retakePanel h2").textContent = `${nextRound}차 수강신청 대상자`;
      $("#retakeNextRoundNote").textContent = `${nextRound}차 결과는 2단계에서 차수를 추가한 뒤 불러오세요.`;
      $("#downloadRetakeList").disabled = !rows.length;
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
      content.innerHTML = `<table class="closure-table"><thead><tr><th>학년</th><th>반</th><th>번호</th><th>이름</th><th>폐강 과목</th></tr></thead><tbody>${
        rows.map(({ student, courses }) =>
          `<tr><td>${escapeHtml(student.grade)}</td><td>${escapeHtml(student.classroom)}</td><td>${escapeHtml(student.number)}</td><td>${escapeHtml(student.name)}</td><td class="closure-subject">${escapeHtml(courses.join(", "))}</td></tr>`).join("")
      }</tbody></table>`;
    }

    function downloadRetakeList() {
      const { sourceRound, rows } = retakeTargets();
      if (!rows.length) return;
      const nextRound = Number(sourceRound) + 1;
      const sheetRows = [
        ["학년", "반", "번호", "이름", "폐강 과목"],
        ...rows.map(({ student, courses }) => [student.grade, student.classroom, student.number, student.name, courses.join(", ")])
      ];
      const rowsXml = sheetRows.map((cells, rowIndex) =>
        `<row r="${rowIndex + 1}">${cells.map((value, column) =>
          `<c r="${columnName(column)}${rowIndex + 1}" s="${rowIndex === 0 ? 2 : 7}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`).join("")}</row>`).join("");
      const columns = [8, 8, 8, 12, 40].map((width, index) =>
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
    function collectApplicationSubjects({ includeExcluded = false } = {}) {
      const layout = state.curriculumImportedLayout;
      if (!layout) return null;
      const columns = importedPlanColumnMap(layout);
      if (columns.subject < 0) return null;
      const contexts = importedPlanCourseContexts(layout, columns);
      const result = { "1": [], "2": [], "3": [] };
      const seen = new Map();
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
        // 학년은 학기 열(1-1~3-2) 중 시수가 적힌 위치로 판별하고, 없으면 학년 열 문맥을 사용한다.
        const byGrade = new Map();
        const subjectFill = curriculumCellFill(layout, context.rowIndex, columns.subject);
        columns.semesters.forEach((column, index) => {
          if (column < 0) return;
          const value = String(context.row[column] ?? "").trim();
          // 시수가 비어 있어도 학기 칸에 직접 채운 색이 있으면 해당 학기 편성으로 보고 색상 그룹에 포함한다.
          // 과목명 칸과 같은 색이면 행 전체 강조로 보고 제외한다.
          const fill = value ? "" : curriculumCellFill(layout, context.rowIndex, column);
          const colorOnly = Boolean(fill) && fill !== subjectFill;
          if ((!value && !colorOnly) || /^[-–—]+$/.test(value) || /^0(?:\.0+)?$/.test(value)) return;
          const grade = Math.floor(index / 2) + 1;
          const sem = String((index % 2) + 1);
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
          if (value) byGrade.get(grade).hours.push(value);
        });
        if (!byGrade.size && !columns.semesters.some((column) => column >= 0)) {
          const fallback = context.grade.match(/[123]/)?.[0];
          if (fallback) byGrade.set(Number(fallback), { semesters: [], hours: [] });
        }
        const creditColumn = columns.opCredit >= 0 ? columns.opCredit : columns.baseCredit;
        const credit = creditColumn >= 0
          ? Number(String(context.row[creditColumn]).replace(/[^\d.]/g, "")) || 0
          : 0;
        for (const [grade, info] of byGrade) {
          if (grade !== 2 && grade !== 3) continue;
          for (const name of subject.split(/[,，]/).map((part) =>
            part.replace(/^[*＊★☆■\s]+|[*＊★☆■\s]+$/g, "").trim()).filter(Boolean)) {
            const key = `${grade}:${name}`;
            const existing = seen.get(key);
            if (existing) {
              existing.semester = [...new Set([...existing.semester.split("·"), ...info.semesters])]
                .filter(Boolean).sort().join("·");
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
        container.innerHTML = '<div class="curriculum-empty">1단계 편제표의 학생선택교육과정에서 2·3학년에 편제된 과목을 자동 표시합니다. 교육과정 구분과 학년별 학기 시수를 확인하세요.</div>';
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
        const semesterHtml = [...bySemester.keys()].sort().map((semester) => {
          const items = bySemester.get(semester).map((item) => {
            const meta = [item.type, item.area, item.credit ? `${item.credit}학점` : ""].filter(Boolean).join(" · ");
            return `<div class="application-subject"><span>${escapeHtml(item.subject)}</span><span class="application-subject-meta">${escapeHtml(meta)}</span></div>`;
          }).join("");
          return `<div class="application-semester">${semester === "0" ? "학기 미정" : `${semester}학기`}</div>${items}`;
        }).join("");
        return `<div class="application-grade">${grade}학년 과목(현재 ${Number(grade) - 1}학년이 신청)</div>${semesterHtml}`;
      }).join("");
      if (!container.innerHTML) container.innerHTML = `<div class="curriculum-empty">${Number(state.applicationMenuGrade || "1") + 1}학년 학생선택교육과정 과목이 없습니다. 편제표를 확인하세요.</div>`;
      if (typeof renderCourseGroups === "function") renderCourseGroups();
    }

    // 신청 결과를 편제표의 학년·학기별 과목과 연결한다.
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
            category: item.area || "선택과목"
          };
          courses.push(course);
          courseByGradeName.set(`${grade}:${item.subject}`, course);
          const semesters = String(item.semester || "").split("·");
          if (semesters.length > 1) for (const semester of semesters) {
            const subject = `${item.subject} (${semester}학기)`;
            if (!entries.some((entry) => String(Number(entry.grade)+1)===grade && entry.selections?.includes(subject))) continue;
            const semesterCourse = { ...course, column:`app${courses.length}`,
              name: nameCount.get(item.subject)>1 ? `${subject}(${grade}학년)` : subject, semesterKey:semester };
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
          studentId: String(entry?.studentId || entry?.학번 || "").trim(),
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
        const studentIdColumn = header.findIndex((value) => /^(학번|학생ID|학생식별번호)$/.test(value));
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
          const studentId = studentIdColumn >= 0 ? String(row[studentIdColumn] ?? "").trim() : "";
          students.push({ ...(studentId ? { studentId } : {}), grade, classroom, number, name });
        }
      }
      if (!students.length) throw new Error("학생 명렬에서 학년·반·번호·이름 머리글과 학생을 찾지 못했습니다.");
      return students;
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

    function applyCloudApplicationResults(round, entries, subjects) {
      round = String(round);
      if (!/^[1-9]\d{0,8}$/.test(round)) throw new Error("연동할 신청 차수를 확인하세요.");
      prepareAcademicYearImport();
      const merged = mergeApplications(entries, subjects);
      if (merged.errors.length) throw new Error(`집계표 연동 실패: ${merged.errors[0]}`);
      state.rounds ||= {"1":null};
      state.activeDataSchoolYear = String($("#schoolYear").value || "");
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
        customGroupNamesByGrade: normalizeGradeGroupNames(
          previous?.customGroupNamesByGrade, previous?.customGroupNames
        ),
        dataSchoolYear: state.activeDataSchoolYear,
        fileName: `온라인 수동 갱신 ${merged.students.length}명`
      };
      state.rounds[round] = data;
      if (String(round) === state.currentRound) {
        state.students = data.students;
        state.courses = data.courses;
        state.classOverrides = data.classOverrides;
        state.semesterAssignments = {...data.semesterAssignments};
        state.groupAssignments = {...data.groupAssignments};
        state.customGroupNames = [];
        state.customGroupNamesByGrade = normalizeGradeGroupNames(
          data.customGroupNamesByGrade, data.customGroupNames
        );
        const loadedGrades = [...new Set(data.students.map((student) => String(student.grade)))];
        if (loadedGrades.length === 1) {
          state.certificateTargetGrade = String(Number(loadedGrades[0]) + 1);
          state.selectedId = data.students[0]?.id || null;
        }
        state.fileName = data.fileName;
        if (!state.students.some((student) =>
          student.id === state.selectedId &&
          String(student.grade) === targetGradeCurrentGrade(state.certificateTargetGrade || "2"))) {
          state.selectedId = state.students.find((student) =>
            String(student.grade) === targetGradeCurrentGrade(state.certificateTargetGrade || "2"))?.id || null;
        }
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

    function storeDeveloperGradeResults(data, sourceLabel, grade) {
      prepareAcademicYearImport();
      grade = String(grade);
      const students = data.students.filter((student) => String(student.grade) === grade);
      if (!students.length) throw new Error(`현재 ${grade}학년 학생이 없는 결과 파일입니다. 해당 학년 메뉴에서 업로드하세요.`);
      const courses = normalizeCourses(data.courses.filter((course) =>
        !course.applicationCurrentGrade || course.applicationCurrentGrade === grade));
      const otherStudents = state.students.filter((student) => String(student.grade) !== grade);
      const otherColumns = new Set(otherStudents.flatMap((student) => student.selections.map((course) => course.column)));
      const otherCourses = state.courses.filter((course) =>
        course.applicationCurrentGrade ? course.applicationCurrentGrade !== grade : otherColumns.has(course.column));
      for (const course of otherCourses) otherColumns.add(course.column);
      const occupied = new Set([...otherCourses.map((course) => String(course.column)),
        ...Object.keys(state.classOverrides || {}).map((key) => key.includes(":") ? key.split(":")[1] : key),
        ...Object.keys(state.semesterAssignments || {}),
        ...Object.keys(state.groupAssignments || {})]);
      const remapped = new Map();
      courses.forEach((course, index) => {
        let column = `developer-${grade}-${index}`;
        while (occupied.has(column)) column += "-";
        occupied.add(column);
        remapped.set(course.column, {...course, column, applicationCurrentGrade:grade});
      });
      const nextStudents = students.map((student) => ({
        ...student, selections: student.selections.map((course) => ({...course, column: remapped.get(course.column).column}))
      }));
      state.students = [...otherStudents, ...nextStudents].sort((a,b) =>
        Number(a.grade)-Number(b.grade) || Number(a.classroom)-Number(b.classroom) || Number(a.number)-Number(b.number));
      state.courses = [...otherCourses, ...remapped.values()];
      state.certificateTargetGrade = String(Number(grade) + 1);
      $("#searchInput").value = "";
      $("#classFilter").value = "";
      state.classOverrides = Object.fromEntries(Object.entries(state.classOverrides || {}).filter(([key]) => {
        const column = key.includes(":") ? key.split(":")[1] : key;
        return otherColumns.has(column);
      }));
      for (const key of ["semesterAssignments", "groupAssignments"]) {
        state[key] = Object.fromEntries(Object.entries(state[key] || {}).filter(([column]) => otherColumns.has(column)));
      }
      state.customGroupNamesByGrade = normalizeGradeGroupNames(
        state.customGroupNamesByGrade, state.customGroupNames
      );
      state.customGroupNames = [];
      state.customGroupNamesByGrade[String(Number(grade) + 1)] = [];
      state.rounds ||= {"1":null};
      state.activeDataSchoolYear = String($("#schoolYear").value || "");
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
    }

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

    // 구글폼 응답 시트 행들을 신청 항목 배열로 변환한다.
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

    // 학년 1개분의 집계표 시트 XML을 만든다. 학년별로 시트를 나누어보낸다.
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
          const semesterTotal = semester.groups.reduce((total, group) => total + group.totalClasses, 0);
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
            block.forEach((course, index) => setCell(headerRow, index + 1, course.name, 6));
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

    // 학년별 시트로 나눈 집계표 xlsx 파일 구성을 만든다.
    function buildAggregateXlsxFiles() {
      const openingPercent = Number($("#openingPercent").value);
      const divisionPercent = Number($("#divisionPercent").value);
      const currentGrade = targetGradeCurrentGrade(state.aggregateTargetGrade || "2");
      const students = state.students.filter((student) => String(student.grade) === currentGrade);
      const courses = coursesForCurrentGrade(currentGrade);
      const aggregate = aggregateRecords(
        students, courses, openingPercent, divisionPercent,
        state.classOverrides, state.semesterAssignments, state.groupAssignments, state.plannedClassCounts
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
      const workbook = createXlsxBlob(buildAggregateXlsxFiles());
      const link = document.createElement("a");
      const url = URL.createObjectURL(workbook);
      link.href = url;
      link.download = "과목별_수강신청_집계표.xlsx";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function downloadHistoryTemplate() {
      downloadRowsXlsx([
        ["학번", "학년도", "학년", "과목명", "학점", "교과군", "학기", "이수여부"],
        ["20260001", "2026", "1", "예시 과목", "3", "국어", "1-1", "이수"]
      ], "학생별_이수이력_양식.xlsx");
    }

    function updateCertificateText() {
      renderPreview();
      renderSemesterClassifier();
      renderAggregate();
      persistState();
    }

    function handleWorkbook(file) {
      if (!file) return;
      if (typeof isDeveloperAccount !== "function" || !isDeveloperAccount()) {
        status.textContent = "개발자 계정에서만 결과 엑셀을 업로드할 수 있습니다.";
        return;
      }
      status.textContent = "";
      if (!file.name.toLowerCase().endsWith(".xlsx")) {
        status.textContent = "현재는 .xlsx 형식만 지원합니다.";
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
          if (!isDeveloperAccount()) throw new Error("개발자 계정으로 다시 로그인하세요.");
          if (state.currentRound !== uploadRound) throw new Error("파일을 읽는 중 차수가 바뀌었습니다. 해당 차수에서 다시 업로드하세요.");
          if ((state.applicationMenuGrade || "1") !== uploadGrade) throw new Error("파일을 읽는 중 학년 메뉴가 바뀌었습니다. 해당 학년에서 다시 업로드하세요.");
          if (state.applicationImportRevision !== importRevision) throw new Error("파일을 읽는 중 데이터가 삭제되었습니다. 다시 업로드하세요.");
          if (sheets[0]?.rows[0]?.[0] === "차수" && sheets[0].rows[0][5] === "선택과목") {
            const header = ["차수", "학년", "반", "번호", "성명", "선택과목"];
            if (header.some((name, index) => sheets[0].rows[0][index] !== name)) throw new Error("결과 엑셀의 머리글 형식을 확인하세요.");
            const rows = sheets[0].rows.slice(1).filter((row) => row.some((value) => String(value ?? "").trim()));
            if (!rows.length) throw new Error("신청 결과가 비어 있습니다.");
            if (rows.some((row) => String(row[0]) !== state.currentRound)) throw new Error("업로드한 엑셀의 차수와 현재 선택한 차수가 다릅니다.");
            const subjects = collectApplicationSubjects({ includeExcluded: true });
            const gradeRows = rows.filter((row) => String(row[1]) === uploadGrade);
            if (!gradeRows.length) throw new Error(`현재 ${uploadGrade}학년 학생이 없는 결과 파일입니다. 해당 학년 메뉴에서 업로드하세요.`);
            const entries = gradeRows.map((row) => ({
              grade:String(row[1]), classroom:String(row[2]), number:String(row[3]), name:String(row[4]),
              studentId:String(row[6] ?? "").trim(),
              selections: splitGoogleFormSelections(row[5], new Set([
                ...(subjects?.[String(Number(row[1])+1)] || []).map((course) => course.subject),
                ...(subjects?.[String(Number(row[1])+1)] || []).flatMap((course) =>
                  course.semester.includes("·") ? course.semester.split("·").map((sem) => `${course.subject} (${sem}학기)`) : [])
              ]), true)
            }));
            const merged = mergeApplications(entries);
            if (merged.errors.length) throw new Error(merged.errors.join("\n"));
            const unclassified = classifyApplicationRecords(merged);
            storeDeveloperGradeResults(merged, file.name, uploadGrade);
            status.style.color = "#287956";
            status.textContent = `${state.currentRound}차 현재 ${uploadGrade}학년 ${entries.length}명 저장 · 다른 학년 데이터는 유지됩니다.` +
              (unclassified.length ? ` 그룹 미확인 ${unclassified.length}개: ${unclassified.join(", ")}` : "");
            return;
          }
          const data = createRecords(sheets[0].rows);
          data.students = data.students.filter((student) => String(student.grade) === uploadGrade);
          if (!data.students.length) throw new Error(`현재 ${uploadGrade}학년 학생이 없는 결과 파일입니다. 해당 학년 메뉴에서 업로드하세요.`);
          const unclassified = classifyApplicationRecords(data);
          storeDeveloperGradeResults(data, file.name, uploadGrade);
          status.style.color = "#287956";
          status.textContent = `${state.currentRound}차 현재 ${uploadGrade}학년 ${data.students.length}명 저장 · 다른 학년 데이터는 유지됩니다.` +
            (unclassified.length ? ` 그룹 미확인 ${unclassified.length}개: ${unclassified.join(", ")}. 선택 그룹 또는 파일의 학기 표기를 확인하세요.` : "");
        } catch (error) {
          const message = error instanceof Error ? error.message : "파일을 처리하는 중 오류가 발생했습니다.";
          status.style.color = "#a44939";
          status.textContent = message;
        }
      };
      reader.readAsArrayBuffer(file);
    }

    function handleCurriculumWorkbook(file) {
      if (file && (typeof requireTeacherLogin !== "function" || !requireTeacherLogin())) return;
      if (!file) return;
      status.textContent = "";
      if (!file.name.toLowerCase().endsWith(".xlsx")) {
        status.style.color = "#a44939";
        status.textContent = "교육과정 목록은 .xlsx 형식만 지원합니다.";
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => {
        status.style.color = "#a44939";
        status.textContent = "교육과정 목록 파일을 읽지 못했습니다.";
      };
      reader.onload = async () => {
        try {
          const sheets = await parseWorkbook(reader.result);
          const curriculum = createCurriculumRecords(sheets[0].rows);
          if (!requireTeacherLogin()) throw new Error("로그인이 만료되었습니다. 다시 로그인하세요.");
          state.curriculumCatalog = curriculum;
          state.curriculumFileName = file.name;
          renderCurriculumStep();
          persistState();
          status.style.color = "#287956";
          status.textContent = `교육과정 목록 ${curriculum.length}개 과목을 저장했습니다.`;
        } catch (error) {
          const message = error instanceof Error ? error.message : "교육과정 목록 처리 중 오류가 발생했습니다.";
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
        ? rows.slice(headerStart, headerIndex + 3)
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
        ).join("")
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

    function appendCourseToImportedPlan(item) {
      const layout = state.curriculumImportedLayout;
      if (!layout) throw new Error("먼저 편제표를 불러오세요.");
      const subject = String(item?.subject || "").trim();
      if (!subject) throw new Error("추가할 과목명이 비어 있습니다.");
      if (state.curriculumPlan.some((row) => String(row.subject || "").trim() === subject)) {
        throw new Error(`${subject} 과목은 이미 편제표에 있습니다.`);
      }
      const columns = importedPlanColumnMap(layout);
      if (columns.subject < 0) throw new Error("편제표에서 과목명 열을 찾지 못했습니다.");
      const baseCreditColumn = columns.baseCredit >= 0
        ? columns.baseCredit : columns.genericCredit;
      const opCreditColumn = columns.opCredit >= 0
        ? columns.opCredit : baseCreditColumn;

      const row = Array(Math.max(0, ...layout.rows.map((sourceRow) => sourceRow.length))).fill("");
      const insertion = findImportedPlanInsertion(layout, columns, item);
      const anchor = insertion.anchor;
      const firstPlanRow = state.curriculumPlan[0];
      const grade = String(anchor?.grade?.match(/[123]/)?.[0] || firstPlanRow?.grade || state.curriculumTargetGrade || "1");
      const division = String(anchor?.division || firstPlanRow?.division || state.curriculumTargetDivision || "");
      const area = curriculumAreaOf(item);
      const selectionType = curriculumSelectionType(item.type) || String(item.type || "");
      const values = [
        [columns.subject, item.subject],
        [baseCreditColumn, item.credit || 0],
        [opCreditColumn, item.credit || 0]
      ];
      // 바로 위 과목과 교과군·선택 유형이 같으면 그 병합 셀을 이어받으므로 값을 비워 두고,
      // 다르면 새 행에 직접 적어 넣는다.
      if (!insertion.matchedArea) values.push([columns.area, area]);
      if (!insertion.matchedType) {
        values.push([columns.detail, item.type || ""]);
        const typeColumn = anchor?.typeColumn ?? -1;
        if (typeColumn >= 0 && typeColumn !== columns.subject) {
          values.push([typeColumn, selectionType.replace(/선택$/, "")]);
        }
      }
      if (!anchor) {
        values.push([columns.grade, grade], [columns.division, division]);
      }
      for (const [column, value] of values) {
        if (column >= 0) row[column] = String(value ?? "");
      }
      recordCurriculumUndo();
      const nextLayout = insertImportedPlanLayoutRow(layout, insertion.insertionRow, row,
        anchor && (insertion.matchedArea || insertion.matchedType) ? anchor.rowIndex : -1);
      // 병합을 늘리지 못해 교과군 칸이 빈 채로 남으면 직접 적어 넣는다.
      const insertedCovered = importedPlanCoveredCells(nextLayout);
      const inserted = nextLayout.rows[insertion.insertionRow];
      if (columns.area >= 0 && !inserted[columns.area] && !insertedCovered.has(`${insertion.insertionRow}:${columns.area}`)) {
        inserted[columns.area] = String(area ?? "");
      }
      const anchorTypeColumn = anchor?.typeColumn ?? -1;
      if (anchorTypeColumn >= 0 && !inserted[anchorTypeColumn] &&
        !insertedCovered.has(`${insertion.insertionRow}:${anchorTypeColumn}`)) {
        inserted[anchorTypeColumn] = selectionType.replace(/선택$/, "");
      }
      const planIndex = anchor
        ? state.curriculumPlan.findIndex((planRow) => String(planRow.subject || "").trim() === anchor.subject) + 1
        : state.curriculumPlan.length;
      const planRow = normalizeCurriculumPlanRow({
        grade,
        division,
        area,
        detail: item.type || "일반선택",
        subject,
        baseCredit: item.credit || 0,
        opCredit: item.credit || 0
      });
      const nextPlan = [...state.curriculumPlan];
      nextPlan.splice(planIndex > 0 ? planIndex : state.curriculumPlan.length, 0, planRow);
      state.curriculumPlan = nextPlan;
      syncCurriculumPlanYearSnapshot();
      state.curriculumImportedLayout = nextLayout;
      scheduleCurriculumLayoutPersistence();
      state.curriculumMutationRevision += 1;
      syncCurriculumTemplateRows();
      renderCurriculumStep();
      persistState();
      status.style.color = "#287956";
      status.textContent = anchor
        ? `${item.subject} 과목을 ${anchor.subject} 아래(${insertion.insertionRow + 1}행)에 추가했습니다.`
        : `${item.subject} 과목을 편제표에 추가했습니다.`;
      const insertedCell = $(`#curriculumPlanWrap [data-source-row="${insertion.insertionRow}"][data-source-column="${columns.subject}"]`);
      if (insertedCell) insertedCell.scrollIntoView({ block: "nearest", inline: "nearest" });
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
        ]))
      };
      nextLayout.rows.splice(insertionRow, 0, newRow);
      nextLayout.cellFills=Object.fromEntries(Object.entries(layout.cellFills || {}).map(([key,color])=>{
        const [row,column]=key.split(":").map(Number);
        return [`${row>=insertionRow?row+1:row}:${column}`,color];
      }));
      if (typeof insertPlanFormulaRow === "function") insertPlanFormulaRow(layout, nextLayout, insertionRow);
      return nextLayout;
    }

    // 드롭한 과목이 들어갈 행 번호와 이어받을 문맥(학년·교육과정·교과군·선택 유형)을 찾는다.
    function findImportedPlanInsertion(layout, columns, item) {
      const contexts = importedPlanCourseContexts(layout, columns);
      const area = String(curriculumAreaOf(item) || "").trim();
      const type = curriculumSelectionType(item?.type) || String(item?.type || "").trim();
      const clean = (value) => String(value ?? "").replace(/↔/g, " ").replace(/\s+/g, "").trim();
      const sameArea = contexts.filter((context) => area && clean(context.area) === clean(area));
      const sameAreaAndType = sameArea.filter((context) => type && context.selectionType === type);
      const sameType = contexts.filter((context) => type && context.selectionType === type);
      // 우선순위: 교과군+선택 유형 일치 → 교과군 일치 → 선택 유형 일치 → 마지막 과목 행
      const anchor = sameAreaAndType.at(-1) || sameArea.at(-1) || sameType.at(-1) || contexts.at(-1) || null;
      const matchedArea = Boolean(sameAreaAndType.length || sameArea.length);
      const matchedType = Boolean(sameAreaAndType.length || (!sameArea.length && sameType.length));
      return {
        insertionRow: anchor ? anchor.rowIndex + 1 : layout.rows.length,
        anchor,
        matchedArea,
        matchedType
      };
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
      scheduleCurriculumLayoutPersistence();
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
          .map(([row, height]) => [Number(row) - minRow, height]))
      };
    }

    function expandCurriculumLayoutRows(layout) {
      const rows = layout.rows.map((row) => [...row]);
      for (const reference of layout.mergedRanges || []) {
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
      if (typeof requireTeacherLogin !== "function" || !requireTeacherLogin()) return;
      status.textContent = "";
      if (!file.name.toLowerCase().endsWith(".xlsx")) {
        status.style.color = "#a44939";
        status.textContent = "편제표는 .xlsx 형식만 지원합니다.";
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => {
        status.style.color = "#a44939";
        status.textContent = "편제표 파일을 읽지 못했습니다.";
      };
      reader.onload = async () => {
        try {
          const sheets = await parseWorkbook(reader.result, { expandMergedCells: true, includeLayout: true });
          if (!requireTeacherLogin()) throw new Error("로그인이 만료되었습니다. 다시 로그인하세요.");
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
              sheetPlan = createCurriculumPlanRecords(sheet.rows, `${file.name} ${sheet.name}`);
            } catch (error) {
              parseError = error;
            }
            // 헤더 규칙으로 못 읽으면 표 레이아웃에서 과목 행을 만든다.
            if (!sheetPlan.length) sheetPlan = planRowsFromImportedLayout(layout);
            if (sheetPlan.length || !importedLayout) {
              importedLayout = layout;
              plan = sheetPlan;
            }
            if (plan.length) break;
          }
          if (!importedLayout) throw parseError || new Error("편제표 시트를 찾지 못했습니다.");
          importedLayout.archiveId = await storeCurriculumArchive(reader.result);
          await storeCurriculumLayout(importedLayout);
          curriculumLayoutStoredId = importedLayout.archiveId;
          if (!requireTeacherLogin()) throw new Error("로그인이 만료되었습니다. 다시 로그인하세요.");
          recordCurriculumUndo();
          state.curriculumMutationRevision += 1;
          state.curriculumPlanFilters = { grade: "", division: "", area: "", detail: "", query: "" };
          state.curriculumPlan = plan;
          syncCurriculumPlanYearSnapshot();
          state.curriculumTemplateRows = plan.map((row) => normalizeCurriculumPlanRow(row));
          state.curriculumPlanFileName = file.name;
          state.curriculumImportedLayout = importedLayout;
          renderCurriculumStep();
          if (!persistState()) throw new Error("브라우저 저장 공간이 부족해 편제표를 저장하지 못했습니다.");
          status.style.color = plan.length ? "#287956" : "#a44939";
          status.textContent = plan.length
            ? `편제표 ${plan.length}개 과목을 불러와 반영했습니다.`
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
      $("#printBatch").innerHTML = students.map((student) => certificateMarkup(student, true)).join("");
      window.print();
    }

    rosterInput.addEventListener("change", (event) => { handleWorkbook(event.target.files[0]); event.target.value = ""; });
    $("#curriculumInput").addEventListener("change", (event) => { handleCurriculumWorkbook(event.target.files[0]); event.target.value = ""; });
    curriculumPlanInput.addEventListener("change", (event) => { handleCurriculumPlanWorkbook(event.target.files[0]); event.target.value = ""; });
    $("#undoCurriculumEdit").addEventListener("click", undoCurriculumEdit);
    const curriculumDropZone = $("#curriculumPlanDropZone");
    $("#curriculumPickList").addEventListener("click", (event) => {
      if (state.curriculumSuppressNextClick) {
        state.curriculumSuppressNextClick = false;
        return;
      }
      const button = event.target.closest("[data-curriculum-subject]");
      if (!button || button.disabled) return;
      const item = state.curriculumCatalog.find((row) => row.subject === button.dataset.curriculumSubject);
      if (!item) return;
      try {
        appendCourseToImportedPlan(item);
      } catch (error) {
        status.style.color = "#a44939";
        status.textContent = error instanceof Error ? error.message : "과목을 편제표에 추가하지 못했습니다.";
      }
    });
    $("#curriculumPickList").addEventListener("dragstart", (event) => {
      const button = event.target.closest("[data-curriculum-subject]");
      if (!button || button.disabled) return;
      const subject = button.dataset.curriculumSubject;
      state.curriculumDraggingSubject = subject;
      if (event.dataTransfer) {
        event.dataTransfer.setData("text/plain", subject);
        event.dataTransfer.setData("application/x-curriculum-subject", subject);
        event.dataTransfer.effectAllowed = "copy";
      }
    });
    $("#curriculumPickList").addEventListener("dragend", () => {
      state.curriculumDraggingSubject = "";
      curriculumDropZone.classList.remove("dragover");
    });
    curriculumDropZone.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      curriculumDropZone.classList.add("dragover");
    });
    curriculumDropZone.addEventListener("dragleave", (event) => {
      if (!curriculumDropZone.contains(event.relatedTarget)) curriculumDropZone.classList.remove("dragover");
    });
    curriculumDropZone.addEventListener("drop", (event) => {
      event.preventDefault();
      curriculumDropZone.classList.remove("dragover");
      const subject = event.dataTransfer?.getData("application/x-curriculum-subject") ||
        event.dataTransfer?.getData("text/plain") ||
        state.curriculumDraggingSubject;
      state.curriculumDraggingSubject = "";
      state.curriculumSuppressNextClick = true;
      setTimeout(() => { state.curriculumSuppressNextClick = false; }, 0);
      const item = state.curriculumCatalog.find((row) => row.subject === subject);
      if (!item) {
        status.style.color = "#a44939";
        status.textContent = "과목 정보를 확인하지 못했습니다. 목록에서 다시 끌어 놓아 주세요.";
        return;
      }
      try {
        appendCourseToImportedPlan(item);
      } catch (error) {
        status.style.color = "#a44939";
        status.textContent = error instanceof Error ? error.message : "과목을 편제표에 추가하지 못했습니다.";
      }
    });
    $("#addCurriculumPlanRow").addEventListener("click", appendBlankImportedPlanRow);
    $("#curriculumCatalogQuery").addEventListener("input", (event) => {
      state.curriculumCatalogQuery = event.target.value;
      renderCurriculumCatalog();
      persistState();
    });
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
      renderCurriculumStep();
      persistState();
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
        const row = Number(cell.dataset.sourceRow);
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
      scheduleCurriculumLayoutPersistence();
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
      state.curriculumEditBefore = null;
      state.curriculumEditUndoRecorded = false;
      const mutationRevision = state.curriculumMutationRevision;
      setTimeout(() => {
        if (mutationRevision !== state.curriculumMutationRevision) return;
        try {
          recalculatePlanFormulas(state.curriculumImportedLayout);
          const rows = expandCurriculumLayoutRows(state.curriculumImportedLayout);
          const plan = createCurriculumPlanRecords(
            rows,
            `${state.curriculumPlanFileName} ${state.curriculumImportedLayout.sheetName || ""}`
          );
          state.curriculumPlan = plan;
          syncCurriculumPlanYearSnapshot();
          state.curriculumTemplateRows = plan.map((row) => normalizeCurriculumPlanRow(row));
          renderCurriculumStep();
          persistState();
          scheduleCurriculumLayoutPersistence();
          status.style.color = "#287956";
          status.textContent = "편제표 수정 내용을 저장했습니다.";
        } catch (error) {
          const message = error instanceof Error ? error.message : "편제표 수정 내용을 데이터로 반영하지 못했습니다.";
          status.style.color = "#a44939";
          status.textContent = `화면 수정은 저장했지만 데이터 해석에 실패했습니다: ${message}`;
        }
      }, 0);
    }, true);
    $("#clearCurriculumPlan").addEventListener("click", () => {
      if (state.curriculumImportedLayout || state.curriculumPlan.length) recordCurriculumUndo();
      state.curriculumPlan = [];
      syncCurriculumPlanYearSnapshot();
      state.curriculumTemplateRows = [];
      state.curriculumPlanFileName = "";
      state.curriculumImportedLayout = null;
      curriculumLayoutStoredId = "";
      state.curriculumPlanFilters = { grade: "", division: "", area: "", detail: "", query: "" };
      state.curriculumMutationRevision += 1;
      if (curriculumPlanInput) curriculumPlanInput.value = "";
      renderCurriculumStep();
      persistState();
      status.style.color = "#596780";
      status.textContent = "편제표를 초기화했습니다.";
    });
    $("#searchInput").addEventListener("input", () => { renderRoster(); renderPreview(); });
    $("#preview").addEventListener("change", (event) => {
      const selector = event.target.closest(".history-status");
      if (!selector) return;
      const record = state.priorCourseHistory.find((item) => historyRecordKey(item) === selector.dataset.historyKey);
      if (!record) return;
      record.status = selector.value === "incomplete" ? "incomplete" : "completed";
      renderPreview();
      persistState();
    });
    $("#historyInput").addEventListener("change", (event) => {
      handleHistoryWorkbook(event.target.files[0]);
      event.target.value = "";
    });
    $("#downloadHistoryTemplate").addEventListener("click", downloadHistoryTemplate);
    $("#classFilter").addEventListener("change", () => { renderRoster(); renderPreview(); });
    $("#studentList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-student-id]");
      if (!button) return;
      state.selectedId = button.dataset.studentId;
      renderRoster();
      renderPreview();
      persistState();
    });
    $("#certificateGradeTabs").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-certificate-grade]");
      if (!tab || !["2", "3"].includes(tab.dataset.certificateGrade)) return;
      state.certificateTargetGrade = tab.dataset.certificateGrade;
      $("#searchInput").value = "";
      $("#classFilter").value = "";
      state.selectedId = state.students.find((student) =>
        String(student.grade) === targetGradeCurrentGrade(state.certificateTargetGrade))?.id || null;
      applyClassFilterOptions(state.students);
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
    $("#aggregateGradeTabs").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-aggregate-grade]");
      if (!tab || !["2", "3"].includes(tab.dataset.aggregateGrade)) return;
      state.aggregateTargetGrade = tab.dataset.aggregateGrade;
      renderAggregate();
      renderClosurePanel(state.currentRound);
      persistState();
    });
    $("#classifierGradeTabs").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-classifier-grade]");
      if (!tab || !["2", "3"].includes(tab.dataset.classifierGrade)) return;
      state.classifierTargetGrade = tab.dataset.classifierGrade;
      state.selectedCourseColumns = [];
      state.lastSelectedCourseColumn = null;
      renderSemesterClassifier();
      persistState();
    });
    $("#openingPercent").addEventListener("input", () => { renderAggregate(); persistState(); });
    $("#divisionPercent").addEventListener("input", () => { renderAggregate(); persistState(); });
    $("#plannedClassCount").addEventListener("change", (event) => {
      const input = event.target;
      const value = Number(input.value);
      if (!Number.isInteger(value) || value < 1) {
        input.setCustomValidity("1 이상의 정수를 입력하세요.");
        input.reportValidity();
        input.setCustomValidity("");
        renderAggregate();
        return;
      }
      state.plannedClassCounts ||= {};
      state.plannedClassCounts[String(state.aggregateTargetGrade || "2")] = value;
      renderAggregate();
      persistState();
    });
    $("#adjustAggregateClasses").addEventListener("click", () => {
      const status = $("#aggregateAllocationStatus");
      try {
        const targetGrade = String(state.aggregateTargetGrade || "2");
        const planned = state.plannedClassCounts[targetGrade];
        if (!Number.isSafeInteger(planned) || planned < 1) throw new Error("편제 학급수를 먼저 입력하세요.");
        const grade = targetGradeCurrentGrade(targetGrade);
        const students = state.students.filter((student) => String(student.grade) === grade);
        const opening = Number($("#openingPercent").value);
        const division = Number($("#divisionPercent").value);
        if (!Number.isFinite(opening) || opening <= 0 || !Number.isFinite(division) || division <= 0) {
          throw new Error("개설·분반 기준에 0보다 큰 비율을 입력하세요.");
        }
        const result = allocateAggregateClasses(aggregateRecords(
          students, coursesForCurrentGrade(grade), opening, division,
          state.classOverrides, state.semesterAssignments, state.groupAssignments, state.plannedClassCounts
        ));
        Object.assign(state.classOverrides, result.overrides);
        renderAggregate();
        persistState();
        status.textContent = `${targetGrade}학년 ${result.adjustedGroups}개 선택군을 조정했습니다. 기존 수동값도 재배분했으며 이후 직접 수정할 수 있습니다.${result.skippedGroups ? ` 선택 수 미지정 ${result.skippedGroups}개 그룹은 유지했습니다.` : ""}`;
      } catch (error) {
        status.textContent = `분반 수 조정 실패: ${error.message}`;
      }
    });
    $("#aggregateContent").addEventListener("change", (event) => {
      const input = event.target.closest(".aggregate-class-input");
      if (!input) return;
      const value = input.value === "" ? null : Number(input.value);
      if (value !== null && (!Number.isInteger(value) || value < 0)) {
        input.setCustomValidity("0 이상의 정수를 입력하세요.");
        input.reportValidity();
        input.setCustomValidity("");
        renderAggregate();
        return;
      }
      const key = input.dataset.overrideKey;
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
        const grade = String(state.classifierTargetGrade || "2");
        const names = state.customGroupNamesByGrade[grade] ||= [];
        if (!names.includes(nextName)) names.push(nextName);
        if (input) input.value = "";
        renderSemesterClassifier();
        persistState();
        return;
      }
      const removeButton = event.target.closest('[data-action="remove-group"]');
      if (!removeButton) return;
      const name = normalizeGroupName(removeButton.dataset.groupName);
      if (!name) return;
      const grade = String(state.classifierTargetGrade || "2");
      state.customGroupNamesByGrade[grade] =
        (state.customGroupNamesByGrade[grade] || []).filter((item) => item !== name);
      const currentGrade = targetGradeCurrentGrade(grade);
      const gradeColumns = new Set(coursesForCurrentGrade(currentGrade).map((course) => String(course.column)));
      for (const [column, assigned] of Object.entries(state.groupAssignments)) {
        if (gradeColumns.has(String(column)) && normalizeGroupName(assigned) === name) {
          delete state.groupAssignments[column];
        }
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
      const currentGrade = targetGradeCurrentGrade(state.classifierTargetGrade || "2");
      for (const movedKey of movedKeys) {
        const course = state.courses.find((item) => String(item.column) === movedKey);
        if (!course || !courseBelongsToCurrentGrade(course, currentGrade, state.students)) continue;
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
    $("#schoolYear").addEventListener("change", handleSchoolYearChange);
    workflowSteps.addEventListener("click", (event) => {
      const button = event.target.closest("[data-workflow-step]");
      if (!button) return;
      switchWorkflowStep(button.dataset.workflowStep);
    });
    $("#roundSelector").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-round]");
      if (!tab) return;
      switchRound(tab.dataset.round);
    });
    $("#addApplicationRound").addEventListener("click", () => {
      try {
        if (typeof requireTeacherLogin !== "function" || !requireTeacherLogin()) return;
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
      if (!state.roundClosures[round]) state.roundClosures[round] = {};
      if (select.value) state.roundClosures[round][key] = select.value;
      else delete state.roundClosures[round][key];
      persistState();
      renderAggregate();
      if (Number(state.workflowStep) === 4) renderRetakePanel();
    });
    $("#downloadRetakeList").addEventListener("click", downloadRetakeList);
    resetDataButton.addEventListener("click", () => {
      if (typeof requireTeacherLogin !== "function" || !requireTeacherLogin()) return;
      if (!window.confirm(`${state.currentRound}차의 명단·신청 결과·폐강 검토만 삭제할까요? 편제표와 다른 차수는 유지하며 서버 신청은 삭제하지 않습니다. 집계표 연동은 해제됩니다.`)) return;
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
    window.addEventListener("hashchange", () => window.location.reload());
    document.addEventListener("DOMContentLoaded", () => {
      if (!showStudentApplicationEntry()) restorePersistedState();
    }, { once: true });
