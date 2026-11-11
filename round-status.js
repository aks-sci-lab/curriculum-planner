"use strict";
var ROUND_STATUS_LABELS = { draft: "작성 중", review: "협의회 검토", confirmed: "확정" };

function roundStatus(round) {
  const entry = state.roundStatuses?.[String(round)];
  return entry && Object.hasOwn(ROUND_STATUS_LABELS, entry.status) ? entry.status : "draft";
}

function roundStatusLabel(round) {
  return ROUND_STATUS_LABELS[roundStatus(round)];
}

function isRoundLocked(round) {
  return roundStatus(round) === "confirmed";
}

function roundStatusData(round) {
  round = String(round);
  if (round === String(state.currentRound) && state.students.length) {
    return {
      students: state.students, courses: state.courses, classOverrides: state.classOverrides,
      semesterAssignments: state.semesterAssignments, groupAssignments: state.groupAssignments
    };
  }
  return state.rounds?.[round] || null;
}

function setRoundStatus(round, status, snapshot = null) {
  round = String(round);
  if (!Object.hasOwn(ROUND_STATUS_LABELS, status)) throw new Error("알 수 없는 차수 상태입니다.");
  state.roundStatuses ||= {};
  if (status === "draft") delete state.roundStatuses[round];
  else state.roundStatuses[round] = { status, updatedAt: new Date().toISOString(), ...(snapshot ? { snapshot } : {}) };
}

function buildRoundSnapshot(round) {
  round = String(round);
  const data = roundStatusData(round);
  if (!data?.students?.length) return null;
  const { openingPercent, divisionPercent } = aggregateThresholds();
  const classBases = typeof nextYearClassBases === "function" ? nextYearClassBases() : {};
  // 이 차수의 개설/폐강 결정(앞 차수 결정은 새 차수를 만들 때 복사돼 이미 이 안에 있다).
  const closures = typeof effectiveRoundClosures === "function" ? effectiveRoundClosures(round) : state.roundClosures?.[round] || {};
  const aggregate = aggregateRecords(
    data.students, data.courses, openingPercent, divisionPercent,
    data.classOverrides || {}, data.semesterAssignments || {}, data.groupAssignments || {}, classBases, closures
  );
  const rows = [];
  for (const { summary, semesters } of aggregate.reports) {
    for (const semester of semesters) {
      for (const group of semester.groups) {
        for (const course of group.courses) {
          const key = `${summary.grade}:${course.column}`;
          const atRisk = course.atRisk;
          const decision = Object.hasOwn(closures, key) ? closures[key] : atRisk ? "" : "open";
          rows.push({
            grade: String(summary.grade),
            targetGrade: String(Number(summary.grade) + 1),
            semester: semester.order === 1 || semester.order === 2 ? String(semester.order) : "",
            group: group.category,
            name: course.subjectName || course.name,
            displayName: course.displayName || course.name,
            enrollment: course.enrollment,
            classCount: Number(course.classCount) || 0,
            decision,
            atRisk
          });
        }
      }
    }
  }
  return {
    createdAt: new Date().toISOString(),
    openingPercent, divisionPercent,
    ...(typeof aggregateMaxClassSize === "function" ? { maxClassSize: aggregateMaxClassSize() } : {}),
    classBases: { ...classBases },
    summaries: aggregate.reports.map(({ summary }) => ({
      grade: String(summary.grade), students: summary.students, classes: summary.classes, classSource: summary.classSource || "roster"
    })),
    rows
  };
}

// ---- 과목 개설 결정의 한 출처 ----
// 과목 개설 결정(현학년·학기·그룹·과목 → 개설 여부·학급 수·인원)은 4단계 집계(aggregateRecords)를 차수 스냅샷 모양으로 만든 행 하나에서 읽는다.
// 확정된 차수는 확정 스냅샷, 아니면 지금 4단계 기준으로 만든 스냅샷(buildRoundSnapshot). 5단계 개설반 자동 값·6단계 분반 수가 모두 이것을 쓴다.
// 읽을 차수(사용자 결정 2026-11 · 차수별 흐름 분리): 맨 위에서 고른 차수 하나(state.currentRound). 숨은 차수 고르기 규칙은 없다.
// (예전 '최근 확정 → 4단계 차수 → 최근 결과' 규칙과 5단계 '선택과목 근거' 고정값은 없앴다. 부르는 곳이 많아 이름은 그대로 둔다.)
function courseOpeningRound() {
  return String(state.currentRound || "1");
}

// 5·6단계 맨 위 '근거' 한 줄(차수 관련 안내는 이 줄 하나): '3차 · 현1: 3차 결과(확정) · 현2: 2차에서 복사(미확정)'.
// 복사한 학년의 앞 차수가 복사 뒤 바뀌었으면 '2차가 복사 뒤 바뀜 · 이 학년 다시 복사' 단추(round-copy.js 서명 비교).
function roundBasisParts(round = state.currentRound) {
  round = String(round);
  const data = roundStatusData(round);
  const sources = state.rounds?.[round]?.gradeSources || {};
  const confirmed = isRoundLocked(round);
  return ["1", "2"].map((grade) => {
    const has = (data?.students || []).some((student) => String(student.grade) === grade);
    const source = sources[grade] || null;
    let text = !has ? "결과 없음" : source?.kind === "copy" ? `${source.round}차에서 복사` : source?.kind === "online" ? `${round}차 웹 신청` : `${round}차 결과`;
    if (has && source?.kind === "partial") text += "(재신청 학생만 바꿈)";
    let changed = "";
    if (has && source?.kind === "copy" && source.from?.round && typeof roundGradeSignature === "function") {
      const from = state.rounds?.[source.from.round] || (String(source.from.round) === String(state.currentRound) ? roundStatusData(source.from.round) : null);
      if (from && roundGradeSignature(from, state.roundClosures?.[source.from.round] || {}, grade) !== source.from.signature) changed = String(source.from.round);
    }
    return { grade, has, text, confirmed, changed };
  });
}

function roundBasisHtml(round = state.currentRound) {
  const esc = typeof escapeHtml === "function" ? escapeHtml : (value) => String(value ?? "");
  const parts = roundBasisParts(round);
  const locked = isRoundLocked(round);
  const items = parts.map((part) => `<span class="round-basis-item">현${part.grade}: ${esc(part.text)}${part.has ? `(${part.confirmed ? "확정" : "미확정"})` : ""}${part.changed
    ? ` · <span class="round-basis-changed">${esc(part.changed)}차가 복사 뒤 바뀜</span> <button type="button" class="button button-quiet" data-round-recopy="${part.grade}"${locked ? " disabled title=\"확정된 차수입니다. 확정 해제 후 다시 복사하세요.\"" : ""}>이 학년 다시 복사</button>` : ""}</span>`).join(" · ");
  return `<p class="round-basis-line" data-round-basis="${esc(String(round))}"><b>근거: ${esc(String(round))}차</b> · ${items}</p>`;
}

// '이 학년 다시 복사': 지금 차수의 그 학년을 앞 차수에서 다시 복사한다(확인 창, 확정 차수는 안 됨).
async function recopyRoundGrade(grade) {
  const round = String(state.currentRound);
  const source = state.rounds?.[round]?.gradeSources?.[grade];
  if (!source?.from?.round || isRoundLocked(round) || typeof copyRoundGrade !== "function") return false;
  const text = `${round}차 현${grade} 결과를 지금의 ${source.from.round}차 현${grade} 결과로 다시 복사합니다. 이 차수에서 이 학년에 고친 개설·폐강·학급 수는 ${source.from.round}차 값으로 바뀝니다.\n\n다시 복사할까요?`;
  const ok = typeof appConfirm === "function" ? await appConfirm(text, { title: "이 학년 다시 복사", ok: "다시 복사", cancel: "취소" }) : window.confirm(text);
  if (!ok || isRoundLocked(round)) return false;
  copyRoundGrade(source.from.round, round, grade);
  if (typeof persistState === "function") persistState();
  if (typeof renderHoursStats === "function" && Number(state.workflowStep) === 7) renderHoursStats();
  if (typeof renderClassSections === "function" && Number(state.workflowStep) === 8) renderClassSections();
  if (typeof renderWorkspaceContext === "function") renderWorkspaceContext();
  return true;
}

if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("click", (event) => {
    const button = event.target?.closest?.("[data-round-recopy]");
    if (button && !button.disabled) recopyRoundGrade(button.dataset.roundRecopy);
  });
}

function courseOpeningSnapshot(round) {
  round = String(round || "");
  if (!round) return null;
  if (isRoundLocked(round) && state.roundStatuses?.[round]?.snapshot) return state.roundStatuses[round].snapshot;
  const compute = () => buildRoundSnapshot(round);
  if (typeof cachedByStateRevision !== "function") return compute();
  let thresholds = "";
  try { const value = aggregateThresholds(); thresholds = `${value.openingPercent}|${value.divisionPercent}`; } catch { thresholds = "x"; }
  const bases = typeof nextYearClassBases === "function" ? JSON.stringify(nextYearClassBases()) : "";
  const year = typeof $ === "function" ? $("#schoolYear")?.value || "" : "";
  // 예외(기준 비율 오류)는 캐시하지 않고 그대로 던진다.
  return cachedByStateRevision("courseOpeningSnapshot", `${round}|${thresholds}|${bases}|${year}`, compute);
}

function courseOpeningRowKey(row) {
  const name = typeof normalizeResultCourseName === "function" ? normalizeResultCourseName(row.name) : String(row.name || "").replace(/\s+/g, "");
  return `${row.grade}|${row.semester || ""}|${row.group || ""}|${name}`;
}

// 확정 스냅샷이 지금 자료로 다시 만든 집계와 다른 과목(확정 뒤 그룹 설정·편제표·결과 분류 규칙이 바뀐 경우).
// 5·6단계는 확정 스냅샷을 쓰므로 4단계 화면과 어긋난다 → 4단계·5단계에 알리고 '확정 해제 후 다시 확정'을 권한다.
function roundSnapshotStale(round) {
  round = String(round || "");
  const snapshot = isRoundLocked(round) ? state.roundStatuses?.[round]?.snapshot : null;
  if (!snapshot?.rows) return [];
  const compute = () => {
    let live = null;
    try { live = buildRoundSnapshot(round); } catch { return []; }
    if (!live) return [];
    const index = (rows) => {
      const map = new Map();
      for (const row of rows) {
        const key = courseOpeningRowKey(row);
        const entry = map.get(key) || { grade: String(row.grade), semester: String(row.semester || ""), name: row.displayName || row.name, classCount: 0, enrollment: 0 };
        entry.classCount += Number(row.classCount) || 0;
        entry.enrollment += Number(row.enrollment) || 0;
        map.set(key, entry);
      }
      return map;
    };
    const before = index(snapshot.rows), after = index(live.rows);
    const differences = [];
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(key), b = after.get(key);
      if (a && b && a.classCount === b.classCount && a.enrollment === b.enrollment) continue;
      const base = a || b;
      differences.push({ grade: base.grade, semester: base.semester, name: String(base.name).replace(/\s*[（(]\s*[12]\s*학기\s*[)）]/g, "").trim(),
        confirmed: a ? a.classCount : null, current: b ? b.classCount : null });
    }
    return differences;
  };
  return typeof cachedByStateRevision === "function" ? cachedByStateRevision("roundSnapshotStale", round, compute) : compute();
}

function roundSnapshotStaleText(differences, limit = 4) {
  const label = (item) => `${Number(item.grade) + 1}학년 ${item.semester ? `${item.semester}학기` : "학기 미정"} ${item.name} ${item.confirmed ?? "없음"}→${item.current ?? "없음"}`;
  return differences.slice(0, limit).map(label).join(", ") + (differences.length > limit ? ` 외 ${differences.length - limit}개` : "");
}

function roundSnapshotDrift(round) {
  const snapshot = state.roundStatuses?.[String(round)]?.snapshot;
  if (!snapshot) return [];
  const drift = [];
  try {
    const { openingPercent, divisionPercent } = aggregateThresholds();
    if (snapshot.openingPercent !== openingPercent || snapshot.divisionPercent !== divisionPercent) {
      drift.push(`기준 비율(확정 ${snapshot.openingPercent}%/${snapshot.divisionPercent}%)`);
    }
  } catch {
    drift.push("기준 비율");
  }
  const current = typeof nextYearClassBases === "function" ? nextYearClassBases() : {};
  for (const grade of ["2", "3"]) {
    if ((Number(snapshot.classBases?.[grade]) || 0) !== (Number(current[grade]) || 0)) {
      drift.push(`내년 ${grade}학년 학급 수(확정 ${Number(snapshot.classBases?.[grade]) || "명단 반 수"})`);
    }
  }
  return drift;
}

function renderRoundStatusControls() {
  const label = document.getElementById("roundConfirmState");
  if (!label) return;
  const round = String(state.currentRound);
  const status = roundStatus(round);
  const hasData = !!roundStatusData(round)?.students?.length;
  const review = document.getElementById("roundMarkReview");
  const confirm = document.getElementById("roundConfirm");
  const unlock = document.getElementById("roundUnlock");
  const note = document.getElementById("roundConfirmNote");
  label.textContent = `${round}차 · ${ROUND_STATUS_LABELS[status]}`;
  label.dataset.status = status;
  review.classList.toggle("hidden", status === "confirmed");
  review.textContent = status === "review" ? "작성 중으로 되돌리기" : "협의회 검토 중으로 표시";
  review.disabled = !hasData;
  confirm.classList.toggle("hidden", status === "confirmed");
  confirm.disabled = !hasData;
  unlock.classList.toggle("hidden", status !== "confirmed");
  // 확정된 차수는 화면 집계가 확정 시점과 달라지지 않도록 기준 비율 입력도 잠근다.
  for (const id of ["openingPercent", "divisionPercent", "maxClassSize"]) {
    const input = document.getElementById(id);
    if (!input) continue;
    input.disabled = status === "confirmed";
    input.title = status === "confirmed" ? "확정된 차수입니다. 확정 해제 후 수정하세요." : "";
  }
  if (status === "confirmed") {
    const updatedAt = state.roundStatuses[round]?.updatedAt;
    const date = updatedAt ? new Date(updatedAt).toLocaleString("ko-KR") : "";
    const drift = roundSnapshotDrift(round);
    note.textContent = `${date ? `${date} 확정 · ` : ""}결과 교체·개설 학급수·개설 결정이 잠겨 있고, 시수 통계는 확정 시점 결과를 씁니다.` +
      (drift.length ? ` 확정 이후 ${drift.join(", ")}이(가) 바뀌어 화면 집계가 확정 시점과 다를 수 있습니다. 반영하려면 확정 해제 후 다시 확정하세요.` : "");
  } else if (!hasData) {
    note.textContent = `${round}차 결과가 없습니다. 2단계에서 결과 엑셀을 반영한 뒤 확정하세요.`;
  } else {
    note.textContent = "기준 미달 과목의 개설/폐강을 정하고 택n 그룹 학급수를 목표에 맞춘 뒤 확정하세요.";
  }
}

function refreshAfterRoundStatusChange(message) {
  persistState();
  renderAggregate();
  renderRoundStatus();
  renderWorkflowLayout();
  if (message) {
    status.style.color = "#287956";
    status.textContent = message;
  }
}

function roundClassPlanIssues(round) {
  round = String(round);
  const data = roundStatusData(round);
  if (!data?.students?.length || typeof aggregateClassPlanIssues !== "function") return [];
  const { openingPercent, divisionPercent } = aggregateThresholds();
  const aggregate = aggregateRecords(
    data.students, data.courses, openingPercent, divisionPercent,
    data.classOverrides || {}, data.semesterAssignments || {}, data.groupAssignments || {},
    typeof nextYearClassBases === "function" ? nextYearClassBases() : {},
    typeof effectiveRoundClosures === "function" ? effectiveRoundClosures(round) : state.roundClosures?.[round] || {}
  );
  return aggregateClassPlanIssues(aggregate);
}

function confirmCurrentRound() {
  const round = String(state.currentRound);
  syncActiveRound();
  const snapshot = buildRoundSnapshot(round);
  if (!snapshot) throw new Error(`${round}차 결과가 없어 확정할 수 없습니다. 2단계에서 결과를 먼저 반영하세요.`);
  const undecided = snapshot.rows.filter((row) => row.atRisk && !row.decision);
  // 택n 그룹 총 학급수(n × 학급 수)와 다르거나 학급당 최대 인원을 넘는 과목이 있으면 목록을 보여 주고 묻는다(막지는 않음).
  const planIssues = typeof roundClassPlanIssues === "function" ? roundClassPlanIssues(round) : [];
  const planText = planIssues.length
    ? `협의회 확정 전 조정이 필요합니다.\n${planIssues.slice(0, 12).map((issue) => `- ${issue}`).join("\n")}${planIssues.length > 12 ? `\n- 외 ${planIssues.length - 12}건` : ""}\n\n`
    : "";
  const undecidedText = undecided.length
    ? `기준 미달인데 개설/폐강을 정하지 않은 과목이 ${undecided.length}개 있습니다(예: ${undecided.slice(0, 3).map((row) => row.displayName).join(", ")}). 미정 과목은 현재 개설 학급 수 그대로 시수 통계에 반영됩니다. `
    : "";
  const question = planIssues.length
    ? `${planText}${undecidedText}그래도 확정할까요? (확정·해제는 이 차수의 두 학년 결과 전체에 적용됩니다.)`
    : undecided.length
      ? `${undecidedText}그래도 ${round}차 결과를 확정할까요?`
      : `${round}차 결과를 확정할까요? 확정하면 결과 교체·과목별 개설 반 수·개설 결정이 잠기고, 시수 통계는 이 시점의 결과를 사용합니다.`;
  const finish = () => {
    setRoundStatus(round, "confirmed", snapshot);
    refreshAfterRoundStatusChange(`${round}차 결과를 확정했습니다. 5단계 시수 통계에서 이 결과를 사용합니다.`);
    if (typeof suggestWorkspaceBackup === "function") suggestWorkspaceBackup("차수 확정");
    return true;
  };
  // 앱 대화상자(#roundConfirmDialog)로 묻고, 없으면(테스트·옛 화면) 브라우저 확인 창.
  if (roundAskDialog({ title: `${round}차 결과 확정`, text: question, ok: planIssues.length || undecided.length ? "그래도 확정" : "확정" }, finish)) return "pending";
  if (!window.confirm(question)) return false;
  return finish();
}

// 앱 안 확인 대화상자. 열었으면 true(답은 onYes로), 대화상자가 없으면 false.
function roundAskDialog({ title, text, ok }, onYes) {
  const dialog = typeof document !== "undefined" ? document.getElementById("roundConfirmDialog") : null;
  if (!dialog || typeof dialog.showModal !== "function") return false;
  dialog.querySelector("#roundConfirmTitle").textContent = title;
  dialog.querySelector("#roundConfirmText").textContent = text;
  dialog.querySelector("#roundConfirmOk").textContent = ok;
  dialog.returnValue = "";
  dialog.addEventListener("close", () => {
    if (dialog.returnValue !== "ok") return;
    try { onYes(); } catch (error) {
      if (typeof status !== "undefined" && status) { status.style.color = "#a44939"; status.textContent = error?.message || "처리하지 못했습니다."; }
    }
  }, { once: true });
  dialog.showModal();
  dialog.querySelector("button[value=cancel]")?.focus();
  return true;
}

function initRoundStatusControls() {
  const review = document.getElementById("roundMarkReview");
  if (!review) return;
  review.addEventListener("click", () => {
    const round = String(state.currentRound);
    if (isRoundLocked(round)) return;
    setRoundStatus(round, roundStatus(round) === "review" ? "draft" : "review");
    refreshAfterRoundStatusChange();
  });
  document.getElementById("roundConfirm").addEventListener("click", () => {
    try {
      confirmCurrentRound();
    } catch (error) {
      status.style.color = "#a44939";
      status.textContent = error instanceof Error ? error.message : "차수를 확정하지 못했습니다.";
    }
  });
  document.getElementById("roundUnlock").addEventListener("click", () => {
    const round = String(state.currentRound);
    const question = `${round}차 확정을 해제할까요? 결과 교체·과목별 개설 반 수·개설 결정을 다시 수정할 수 있고, 시수 통계는 확정 전 결과로 계산됩니다.`;
    const unlock = () => {
      setRoundStatus(round, "review");
      refreshAfterRoundStatusChange(`${round}차 확정을 해제했습니다. 수정 후 다시 확정하세요.`);
    };
    if (roundAskDialog({ title: `${round}차 확정 해제`, text: question, ok: "확정 해제" }, unlock)) return;
    if (!window.confirm(question)) return;
    unlock();
  });
  document.getElementById("downloadRoundCompare").addEventListener("click", downloadRoundCompare);
}

function buildRoundCompare() {
  const rounds = applicationRoundNumbers().filter((round) => roundStatusData(round)?.students?.length);
  const grades = new Map();
  for (const round of rounds) {
    const data = roundStatusData(round);
    const aggregate = aggregateRecords(
      data.students, data.courses, 100, 100, data.classOverrides || {},
      data.semesterAssignments || {}, data.groupAssignments || {}
    );
    for (const { summary, semesters } of aggregate.reports) {
      const grade = String(summary.grade);
      if (!grades.has(grade)) grades.set(grade, { students: {}, sources: {}, courses: new Map() });
      const entry = grades.get(grade);
      entry.students[round] = summary.students;
      const sourceNote = roundCompareSourceNote(round, grade);
      if (sourceNote) entry.sources[round] = sourceNote;
      for (const semester of semesters) {
        for (const group of semester.groups) {
          for (const item of group.courses) {
            const name = item.subjectName || item.name;
            const key = `${normalizeResultCourseName(name)}|${item.semesterKey || ""}`;
            if (!entry.courses.has(key)) entry.courses.set(key, { name, semester: item.semesterKey || "", counts: {} });
            const course = entry.courses.get(key);
            course.counts[round] = (course.counts[round] || 0) + item.enrollment;
          }
        }
      }
    }
  }
  return {
    rounds,
    grades: [...grades.entries()].sort(([a], [b]) => Number(a) - Number(b)).map(([grade, entry]) => ({
      grade,
      students: entry.students,
      sources: entry.sources,
      courses: [...entry.courses.values()].sort((a, b) =>
        (a.semester || "9").localeCompare(b.semester || "9") || a.name.localeCompare(b.name, "ko"))
    }))
  };
}

// 차수 비교 머리글의 학년별 출처 꼬리표: 앞 차수에서 복사한 학년은 '2차에서 복사'(그 차수에 새로 올린 결과가 아님),
// 재신청 학생만 바꾼 학년은 '재신청 학생만'. 직접 올린 결과·웹 결과는 꼬리표 없음(round-copy.js gradeSources).
function roundCompareSourceNote(round, grade) {
  const source = state.rounds?.[String(round)]?.gradeSources?.[String(grade)];
  if (source?.kind === "copy" && source.round) return `${source.round}차에서 복사`;
  if (source?.kind === "partial") return "재신청 학생만 바꿈";
  return "";
}

// 4단계 학년 탭을 고르면 그 학년만 비교한다. 학년 탭만 바꿀 때는 신청 인원이 그대로이므로
// 직전에 만든 비교표를 다시 쓴다(차수마다 집계를 다시 하면 탭 전환이 느려진다).
var lastRoundCompare = null;
function roundCompareForScope(reuse = false) {
  const compare = reuse && lastRoundCompare ? lastRoundCompare : (lastRoundCompare = buildRoundCompare());
  const grade = typeof activeAggregateGrade === "function" ? activeAggregateGrade() : "";
  return grade ? { ...compare, grades: compare.grades.filter((entry) => entry.grade === grade) } : compare;
}

function renderRoundCompare(reuse = false) {
  const content = document.getElementById("roundCompareContent");
  if (!content) return;
  const description = document.getElementById("roundCompareDescription");
  const download = document.getElementById("downloadRoundCompare");
  const compare = roundCompareForScope(reuse);
  const summary = document.getElementById("roundCompareSummaryCount");
  download.disabled = compare.rounds.length < 2;
  if (compare.rounds.length < 2) {
    description.textContent = "결과가 있는 차수가 2개 이상이면 과목별 신청 인원 변화를 비교합니다.";
    if (summary) summary.textContent = `결과 있는 차수 ${compare.rounds.length}개`;
    content.innerHTML = "";
    return;
  }
  if (summary) {
    const first = compare.rounds[0];
    const last = compare.rounds.at(-1);
    const changed = compare.grades.reduce((sum, entry) => sum + entry.courses.filter((course) =>
      (course.counts[last] || 0) !== (course.counts[first] || 0)).length, 0);
    summary.textContent = `${compare.rounds.map((round) => `${round}차`).join("·")} · 인원 변화 ${changed}과목`;
  }
  const first = compare.rounds[0];
  const last = compare.rounds.at(-1);
  description.textContent = `${compare.rounds.map((round) => `${round}차(${roundStatusLabel(round)})`).join(" · ")} · 변화는 ${first}차 대비 ${last}차입니다.`;
  content.innerHTML = compare.grades.map(({ grade, students, courses, sources = {} }) => {
    const headers = compare.rounds.map((round) => `<th scope="col">${round}차${sources[round] ? `<small class="round-compare-source">${escapeHtml(sources[round])}</small>` : ""}</th>`).join("");
    const rows = courses.map((course) => {
      const cells = compare.rounds.map((round) => `<td>${course.counts[round] || 0}</td>`).join("");
      const delta = (course.counts[last] || 0) - (course.counts[first] || 0);
      return `<tr${delta ? ' class="is-changed"' : ""}><th scope="row" class="closure-subject">${escapeHtml(course.name)}</th><td>${course.semester ? `${course.semester}학기` : ""}</td>${cells}<td>${delta > 0 ? `+${delta}` : delta || "-"}</td></tr>`;
    }).join("");
    const totals = compare.rounds.map((round) => `<td>${students[round] || 0}</td>`).join("");
    return `<h3 class="closure-grade-heading">${Number(grade) + 1}학년(현${grade}학년)</h3>
      <div class="aggregate-sheet-wrap"><table class="closure-table round-compare-table"><thead><tr><th scope="col">과목</th><th scope="col">학기</th>${headers}<th scope="col">변화</th></tr></thead>
      <tbody><tr class="round-compare-total"><th scope="row">재적 학생</th><td></td>${totals}<td>${(students[last] || 0) - (students[first] || 0) || "-"}</td></tr>${rows}</tbody></table></div>`;
  }).join("");
}

function downloadRoundCompare() {
  const compare = roundCompareForScope();
  if (compare.rounds.length < 2) return;
  const first = compare.rounds[0];
  const last = compare.rounds.at(-1);
  const sheets = compare.grades.map(({ grade, students, courses, sources = {} }) => ({
    name: `${Number(grade) + 1}학년(현${grade}학년)`,
    widths: [28, 8, ...compare.rounds.map(() => 9), 9],
    freeze: "A3",
    merges: [`A1:${columnName(compare.rounds.length + 2)}1`],
    rows: [
      [{ v: `${$("#schoolYear").value}학년도 ${Number(grade) + 1}학년 차수별 신청 인원 비교`, s: 1 }],
      [{ v: "과목", s: 2 }, { v: "학기", s: 2 }, ...compare.rounds.map((round) => ({ v: `${round}차(${roundStatusLabel(round)}${sources[round] ? ` · ${sources[round]}` : ""})`, s: 2 })), { v: `변화(${first}→${last}차)`, s: 2 }],
      [{ v: "재적 학생", s: 6 }, { v: "", s: 6 }, ...compare.rounds.map((round) => ({ v: students[round] || 0, s: 6 })), { v: (students[last] || 0) - (students[first] || 0), s: 6 }],
      ...courses.map((course) => {
        const delta = (course.counts[last] || 0) - (course.counts[first] || 0);
        return [{ v: course.name, s: 3 }, { v: course.semester ? `${course.semester}학기` : "", s: 4 },
          ...compare.rounds.map((round) => ({ v: course.counts[round] || 0, s: 4 })), { v: delta, s: delta ? 9 : 4 }];
      })
    ]
  }));
  const grade = typeof activeAggregateGrade === "function" ? activeAggregateGrade() : "";
  downloadBlob(createWorkbookBlob(sheets), `${$("#schoolYear").value}학년도_차수별_신청인원_비교${grade ? `_현${grade}학년` : ""}.xlsx`);
}

if (typeof document !== "undefined" && document.getElementById) initRoundStatusControls();
