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
  const aggregate = aggregateRecords(
    data.students, data.courses, openingPercent, divisionPercent,
    data.classOverrides || {}, data.semesterAssignments || {}, data.groupAssignments || {}, classBases,
    state.roundClosures?.[round] || {}
  );
  const closures = state.roundClosures?.[round] || {};
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
    classBases: { ...classBases },
    summaries: aggregate.reports.map(({ summary }) => ({
      grade: String(summary.grade), students: summary.students, classes: summary.classes, classSource: summary.classSource || "roster"
    })),
    rows
  };
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
  for (const id of ["openingPercent", "divisionPercent"]) {
    const input = document.getElementById(id);
    if (!input) continue;
    input.disabled = status === "confirmed";
    input.title = status === "confirmed" ? "확정된 차수입니다. 확정 해제 후 수정하세요." : "";
  }
  if (status === "confirmed") {
    const updatedAt = state.roundStatuses[round]?.updatedAt;
    const date = updatedAt ? new Date(updatedAt).toLocaleString("ko-KR") : "";
    const drift = roundSnapshotDrift(round);
    note.textContent = `${date ? `${date} 확정 · ` : ""}결과 교체·과목별 개설 반 수·개설 결정이 잠겨 있으며, 시수 통계는 확정 시점 결과를 사용합니다.` +
      (drift.length ? ` 확정 이후 ${drift.join(", ")}이(가) 바뀌어 화면 집계가 확정 시점과 다를 수 있습니다. 반영하려면 확정 해제 후 다시 확정하세요.` : "");
  } else if (!hasData) {
    note.textContent = `${round}차 결과가 없습니다. 2단계에서 결과 엑셀을 반영한 뒤 확정하세요.`;
  } else {
    note.textContent = "기준 미달 과목의 개설/폐강을 결정한 뒤 확정하세요. 확정하면 결과 교체·과목별 개설 반 수·개설 결정이 잠깁니다.";
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

function confirmCurrentRound() {
  const round = String(state.currentRound);
  syncActiveRound();
  const snapshot = buildRoundSnapshot(round);
  if (!snapshot) throw new Error(`${round}차 결과가 없어 확정할 수 없습니다. 2단계에서 결과를 먼저 반영하세요.`);
  const undecided = snapshot.rows.filter((row) => row.atRisk && !row.decision);
  const question = undecided.length
    ? `기준 미달인데 개설/폐강을 정하지 않은 과목이 ${undecided.length}개 있습니다(예: ${undecided.slice(0, 3).map((row) => row.displayName).join(", ")}). 미정 과목은 현재 개설 학급 수 그대로 시수 통계에 반영됩니다. 그래도 ${round}차 결과를 확정할까요?`
    : `${round}차 결과를 확정할까요? 확정하면 결과 교체·과목별 개설 반 수·개설 결정이 잠기고, 시수 통계는 이 시점의 결과를 사용합니다.`;
  if (!window.confirm(question)) return false;
  setRoundStatus(round, "confirmed", snapshot);
  refreshAfterRoundStatusChange(`${round}차 결과를 확정했습니다. 5단계 시수 통계에서 이 결과를 사용합니다.`);
  if (typeof suggestWorkspaceBackup === "function") suggestWorkspaceBackup("차수 확정");
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
    if (!window.confirm(`${round}차 확정을 해제할까요? 결과 교체·과목별 개설 반 수·개설 결정을 다시 수정할 수 있고, 시수 통계는 확정 전 결과로 계산됩니다.`)) return;
    setRoundStatus(round, "review");
    refreshAfterRoundStatusChange(`${round}차 확정을 해제했습니다. 수정 후 다시 확정하세요.`);
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
      if (!grades.has(grade)) grades.set(grade, { students: {}, courses: new Map() });
      const entry = grades.get(grade);
      entry.students[round] = summary.students;
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
      courses: [...entry.courses.values()].sort((a, b) =>
        (a.semester || "9").localeCompare(b.semester || "9") || a.name.localeCompare(b.name, "ko"))
    }))
  };
}

function renderRoundCompare() {
  const content = document.getElementById("roundCompareContent");
  if (!content) return;
  const description = document.getElementById("roundCompareDescription");
  const download = document.getElementById("downloadRoundCompare");
  const compare = buildRoundCompare();
  download.disabled = compare.rounds.length < 2;
  if (compare.rounds.length < 2) {
    description.textContent = "결과가 있는 차수가 2개 이상이면 과목별 신청 인원 변화를 비교합니다.";
    content.innerHTML = "";
    return;
  }
  const first = compare.rounds[0];
  const last = compare.rounds.at(-1);
  description.textContent = `${compare.rounds.map((round) => `${round}차(${roundStatusLabel(round)})`).join(" · ")} · 변화는 ${first}차 대비 ${last}차입니다.`;
  const headers = compare.rounds.map((round) => `<th scope="col">${round}차</th>`).join("");
  content.innerHTML = compare.grades.map(({ grade, students, courses }) => {
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
  const compare = buildRoundCompare();
  if (compare.rounds.length < 2) return;
  const first = compare.rounds[0];
  const last = compare.rounds.at(-1);
  const sheets = compare.grades.map(({ grade, students, courses }) => ({
    name: `${Number(grade) + 1}학년(현${grade}학년)`,
    widths: [28, 8, ...compare.rounds.map(() => 9), 9],
    freeze: "A3",
    merges: [`A1:${columnName(compare.rounds.length + 2)}1`],
    rows: [
      [{ v: `${$("#schoolYear").value}학년도 ${Number(grade) + 1}학년 차수별 신청 인원 비교`, s: 1 }],
      [{ v: "과목", s: 2 }, { v: "학기", s: 2 }, ...compare.rounds.map((round) => ({ v: `${round}차(${roundStatusLabel(round)})`, s: 2 })), { v: `변화(${first}→${last}차)`, s: 2 }],
      [{ v: "재적 학생", s: 6 }, { v: "", s: 6 }, ...compare.rounds.map((round) => ({ v: students[round] || 0, s: 6 })), { v: (students[last] || 0) - (students[first] || 0), s: 6 }],
      ...courses.map((course) => {
        const delta = (course.counts[last] || 0) - (course.counts[first] || 0);
        return [{ v: course.name, s: 3 }, { v: course.semester ? `${course.semester}학기` : "", s: 4 },
          ...compare.rounds.map((round) => ({ v: course.counts[round] || 0, s: 4 })), { v: delta, s: delta ? 9 : 4 }];
      })
    ]
  }));
  downloadBlob(createWorkbookBlob(sheets), `${$("#schoolYear").value}학년도_차수별_신청인원_비교.xlsx`);
}

if (typeof document !== "undefined" && document.getElementById) initRoundStatusControls();
