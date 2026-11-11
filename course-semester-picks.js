"use strict";
// 두 학기 편성 과목의 개설 학기(사용자 결정): 편제표 1·2학기 묶음에 모두 있는 과목('같은 과목은 한 학기만')이 결과에 학기 꼬리표 없이
// 한 번만 나오면(열 하나) 실제로는 한 학기만 개설된 것으로 본다. 교사가 2단계 결과 검증 미리보기 또는 4단계 과목 메뉴에서 학기를 고르면
// 그 과목을 고른 학생 전부를 그 학기로 고정한다(학생별로 섞지 않음). 고르기 전에는 지금 규칙(이웃 열 학기 → 학생별 택n 추정)으로 나눈다.
// 학기 정하는 순서(사용자 규칙): 결과 머리글·병합 머리글·시트 이름의 학기 표시('2학기', '3-2 택5') → 같은 이름 두 열이면 왼쪽 1학기·오른쪽 2학기(동시 개설)
// → 한 번만 나오면 교사가 고름(차수마다 따로). 추천값(앞 차수 4단계 폐강 학기·한 학기만 개설한 학기 → 이웃 열 → 학생별 추정)은 표시만 하고, 고르기 전에 반영하면 확인 창.
// 저장: state.courseSemesterPicks[학년도][현학년][차수][과목 키] = "1" | "2". 과목 키 = courseSemesterPickKey(과목명).
// 예전 값(차수 없는 [학년도][현학년][키], 다른 구현의 state.twoSemesterPicks)은 1차 값으로 읽어 옮긴다.
// 결과 자료에 적용하는 곳은 둘: app.js splitUntaggedTwoSemesterCourses(결과 취합·다시 정하기 · courseSemesterPickFor를 읽음)와
// 이 파일의 applyTwoSemesterPick(4단계 '개설 학기 바꾸기' · 이미 나눈 자료를 한 학기로 모음). 4·5·6단계·확인서·위계 점검은 모두 이 자료를 읽는다.

// ---- 순수 계산 ----
function courseSemesterPickKey(name) {
  const roman = typeof normalizeRomanNumerals === "function" ? normalizeRomanNumerals : (text) => String(text ?? "");
  return roman(String(name ?? "").replace(/\s*[（(]\s*(?:[23]\s*학년|[12]\s*학기|일반|진로|융합)(?:선택)?\s*[)）]/g, "")).replace(/\s+/g, "");
}

function courseSemesterPicksRestore(saved, legacy = null) {
  const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
  const result = {};
  const put = (year, grade, round, key, semester) => {
    if (!/^\d{4}$/.test(year) || !["1", "2"].includes(grade) || !/^[1-9]\d{0,8}$/.test(round) || !key || !["1", "2"].includes(String(semester))) return;
    const byRound = (((result[year] ||= {})[grade] ||= {})[round] ||= {});
    if (!byRound[key]) byRound[key] = String(semester);
  };
  for (const source of [saved, legacy]) {
    if (!plain(source)) continue;
    for (const [year, grades] of Object.entries(source)) {
      if (!plain(grades)) continue;
      for (const [grade, picks] of Object.entries(grades)) {
        if (!plain(picks)) continue;
        for (const [round, value] of Object.entries(picks)) {
          if (plain(value)) for (const [key, semester] of Object.entries(value)) put(year, grade, round, key, semester);
          else put(year, grade, "1", round, value); // 차수 없는 예전 키 → 1차
        }
      }
    }
  }
  return result;
}

// 저장된 선택이 없을 때의 추천(이웃 열 → 학생별 택n 추정 다수). 앞 차수 결과의 추천은 courseSemesterPreviousRecommendation.
function courseSemesterPickEstimate(entry) {
  const counts = entry?.counts || {};
  const first = Number(counts["1"]) || 0, second = Number(counts["2"]) || 0;
  if (entry?.position === "1" || entry?.position === "2") return { semester: entry.position, basis: `이웃 열 ${entry.position}학기` };
  if (!first && !second) return { semester: "", basis: "" };
  return { semester: second > first ? "2" : "1", basis: `학생별 추정 1학기 ${first}명 · 2학기 ${second}명` };
}

// 앞 차수 4단계 결과에서 추천: 그 과목을 폐강한 학기(재신청 파일) → 한 학기만 개설했으면 그 학기. 1차 고른 값을 그대로 쓰지는 않는다.
// rows = 앞 차수 개설 결정 행(courseOpeningSnapshot 행 모양: grade·semester·name·classCount·decision). 순수 계산.
function courseSemesterRecommendFromRows(rows, grade, key, round) {
  const mine = (rows || []).filter((row) => String(row.grade) === String(grade) && courseSemesterPickKey(row.name) === key && ["1", "2"].includes(String(row.semester)));
  if (!mine.length) return null;
  const closed = [...new Set(mine.filter((row) => row.decision === "closed").map((row) => String(row.semester)))];
  if (closed.length === 1) return { semester: closed[0], basis: `앞 차수(${round}차) ${closed[0]}학기 폐강` };
  const opened = [...new Set(mine.filter((row) => row.decision !== "closed" && Number(row.classCount) > 0).map((row) => String(row.semester)))];
  if (opened.length === 1) return { semester: opened[0], basis: `앞 차수(${round}차) ${opened[0]}학기만 개설` };
  return null;
}

// 결과 자료(data = { courses, students })에서 현 grade학년이 고른 과목 key(두 학기 과목)를 모두 semester 학기 과목 하나로 모은다.
// 'X (1학기)'·'X (2학기)'로 나뉜 과목과 학기 미정으로 남은 기본 과목을 학생 선택째 한 열로 합치고 학점·학기 표시를 고른 학기로 바꾼다.
// 웹 결과(online)는 서버 과목 목록이 기준이라 건드리지 않는다. credits: 고른 학기 학점(편제표 학기 칸), 없으면 원래 값.
// 돌려주는 값: { column(남긴 열), removed(없앤 열 목록), students(옮긴 학생 수) } 또는 null(해당 과목 없음).
function applyTwoSemesterPick(data, grade, key, semester, { credits = 0 } = {}) {
  if (!data?.courses || !["1", "2"].includes(String(semester))) return null;
  grade = String(grade);
  const choosers = (course) => (data.students || []).filter((student) => String(student.grade) === grade &&
    (student.selections || []).some((selection) => String(selection.column) === String(course.column))).length;
  const same = data.courses.filter((course) => course.applicationGroupSource !== "online" &&
    (!course.applicationCurrentGrade || String(course.applicationCurrentGrade) === grade) &&
    courseSemesterPickKey(course.name) === key && (course.applicationCurrentGrade || choosers(course) > 0));
  if (!same.length) return null;
  const semesterOf = (course) => String(course.semesterKey || String(course.name).match(/([12])\s*학기/)?.[1] || "");
  const primary = same.find((course) => semesterOf(course) === String(semester)) ||
    same.slice().sort((a, b) => choosers(b) - choosers(a))[0];
  const gradeTail = String(primary.name).match(/\s*[（(]\s*[23]\s*학년\s*[)）]\s*$/)?.[0] || "";
  const plainName = String(primary.name).replace(/\s*[（(]\s*[23]\s*학년\s*[)）]\s*$/, "").replace(/\s*[（(]\s*[12]\s*학기\s*[)）]/g, "").trim();
  const credit = Number(credits) || Number(primary.applicationSubject?.semesterCredits?.[semester]) || Number(primary.credits) || 0;
  const subject = primary.applicationSubject;
  primary.name = `${plainName} (${semester}학기)${gradeTail}`;
  primary.semesterKey = String(semester);
  primary.credits = credit;
  delete primary.semesterUndecided;
  if (subject) {
    primary.applicationSubject = { ...subject, subject: `${String(subject.subject).replace(/\s*[（(]\s*[12]\s*학기\s*[)）]/g, "").trim()} (${semester}학기)`, semester: String(semester), credit };
  }
  const columns = new Set(same.map((course) => String(course.column)));
  let moved = 0;
  for (const student of data.students || []) {
    if (String(student.grade) !== grade || !(student.selections || []).some((selection) => columns.has(String(selection.column)))) continue;
    let kept = false;
    student.selections = student.selections.flatMap((selection) => {
      if (!columns.has(String(selection.column))) return [selection];
      if (kept) return [];
      kept = true;
      moved++;
      return [selection === primary ? primary : { ...selection, column: primary.column, name: primary.name, semesterKey: primary.semesterKey, credits: primary.credits,
        ...(primary.applicationSubject ? { applicationSubject: primary.applicationSubject } : {}) }];
    });
    student.totalCredits = student.selections.reduce((sum, selection) => sum + (Number(selection.credits) || 0), 0);
  }
  const removed = same.filter((course) => course !== primary).map((course) => String(course.column));
  data.courses = data.courses.filter((course) => !removed.includes(String(course.column)));
  return { column: String(primary.column), removed, students: moved };
}

// ---- 앱 연결 ----
function courseSemesterPickYear() {
  return typeof $ === "function" ? String($("#schoolYear")?.value || "").trim() : "";
}

function courseSemesterPickRound() {
  return typeof state === "undefined" ? "1" : String(state.currentRound || "1");
}

function courseSemesterPickFor(grade, name, year = courseSemesterPickYear(), round = courseSemesterPickRound()) {
  if (typeof state === "undefined") return "";
  return String(state.courseSemesterPicks?.[year]?.[String(grade)]?.[String(round)]?.[courseSemesterPickKey(name)] || "");
}

function setCourseSemesterPick(grade, name, semester, year = courseSemesterPickYear(), round = courseSemesterPickRound()) {
  if (!/^\d{4}$/.test(year) || !["1", "2"].includes(String(grade))) return false;
  const key = courseSemesterPickKey(name);
  if (!key) return false;
  state.courseSemesterPicks ||= {};
  state.courseSemesterPicks[year] ||= {};
  state.courseSemesterPicks[year][String(grade)] ||= {};
  state.courseSemesterPicks[year][String(grade)][String(round)] ||= {};
  if (["1", "2"].includes(String(semester))) state.courseSemesterPicks[year][String(grade)][String(round)][key] = String(semester);
  else delete state.courseSemesterPicks[year][String(grade)][String(round)][key];
  return true;
}

// 지금 차수보다 앞 차수 중 그 학년 결과가 있는 가장 가까운 차수의 4단계 개설 결정으로 추천한다(splitUntaggedTwoSemesterCourses가 부름).
function courseSemesterPreviousRecommendation(grade, name, round = courseSemesterPickRound()) {
  if (typeof applicationRoundNumbers !== "function" || typeof courseOpeningSnapshot !== "function") return null;
  const key = courseSemesterPickKey(name);
  const earlier = applicationRoundNumbers().map(String).filter((item) => Number(item) < Number(round)).sort((a, b) => Number(b) - Number(a));
  for (const previous of earlier) {
    let snapshot = null;
    try { snapshot = courseOpeningSnapshot(previous); } catch { snapshot = null; }
    const rows = (snapshot?.rows || []).filter((row) => String(row.grade) === String(grade));
    if (!rows.length) continue;
    return courseSemesterRecommendFromRows(rows, grade, key, previous);
  }
  return null;
}

// 결과 검증 미리보기의 '개설 학기 선택' 목록: classifyApplicationRecords가 돌려준 두 학기 과목(twoSemesterCourses) 중 한 번만 나온 과목.
function twoSemesterPickCandidates(twoSemesterCourses, grade) {
  const list = [];
  for (const entry of twoSemesterCourses || []) {
    if (String(entry.grade) !== String(grade) || !entry.once || list.some((item) => item.key === entry.key)) continue;
    const choosers = (Number(entry.counts?.["1"]) || 0) + (Number(entry.counts?.["2"]) || 0) + (Number(entry.counts?.[""]) || 0);
    const name = String(entry.name).replace(/\s*[（(]\s*[23]\s*학년\s*[)）]\s*$/, "").trim();
    list.push({ key: entry.key, name, grade: String(grade), choosers, estimate: entry.recommend?.semester || "", basis: entry.recommend?.basis || "",
      pick: entry.pick || "", semester: entry.semester || "" });
  }
  return list;
}

// 머리글 표시나 열 위치로 학기를 정한 두 학기 편성 과목(묻지 않음): 미리보기에 근거만 보여 준다.
function twoSemesterDecidedNotes(courses, grade, onceNames = null) {
  const notes = [];
  for (const course of courses || []) {
    if (course.applicationCurrentGrade && String(course.applicationCurrentGrade) !== String(grade)) continue;
    const source = String(course.semesterSource || "");
    if (!["header", "sheet", "position-left", "position-right"].includes(source)) continue;
    const name = String(course.name).replace(/\s*[（(]\s*[12]\s*학기\s*[)）]/g, "").replace(/\s*[（(]\s*[23]\s*학년\s*[)）]\s*$/, "").trim();
    if (onceNames && !onceNames.has(courseSemesterPickKey(name))) continue;
    const semester = String(course.semesterKey || "");
    const basis = source === "position-left" ? `위치로 정함: 왼쪽 열 → ${semester}학기`
      : source === "position-right" ? `위치로 정함: 오른쪽 열 → ${semester}학기`
      : source === "sheet" ? `시트 이름 '${course.semesterHint || ""}' → ${semester}학기`
      : `머리글 표시 '${course.semesterHint || ""}' → ${semester}학기`;
    notes.push({ name, semester, basis });
  }
  return notes;
}

// 2단계 결과 검증 미리보기의 '두 학기 편성 과목 — 개설 학기 선택'(result-import.js가 그린다). notes = 묻지 않고 정한 과목(근거만).
function twoSemesterPickMarkup(list, grade, notes = []) {
  if (!list?.length && !notes?.length) return "";
  const esc = typeof escapeHtml === "function" ? escapeHtml : (value) => String(value ?? "");
  const target = Number(grade) + 1;
  const rows = (list || []).map((item) => {
    const chosen = item.pick || item.estimate;
    const radios = ["1", "2"].map((semester) => `<label class="result-semester-pick-option"><input type="radio" name="resultSemesterPick-${esc(item.key)}" value="${semester}" data-semester-pick="${esc(item.key)}" data-semester-pick-name="${esc(item.name)}"${chosen === semester ? " checked" : ""} aria-label="${esc(item.name)} ${semester}학기">${target}학년 ${semester}학기</label>`).join("");
    const pickState = item.pick ? `<span class="result-semester-pick-state is-picked">고름</span>` : `<span class="result-semester-pick-state">추천${item.estimate ? ` ${item.estimate}학기` : " 없음"} · 아직 고르지 않음</span>`;
    return `<li><strong>${esc(item.name)}</strong> <span class="result-semester-pick-count">신청 ${item.choosers}명</span> ${radios} ${pickState}<span class="result-semester-pick-basis">추천 근거: ${esc(item.basis || "없음")}</span></li>`;
  }).join("");
  const decided = (notes || []).map((note) => `<li><strong>${esc(note.name)}</strong> <span class="result-semester-pick-basis">${esc(note.basis)}</span></li>`).join("");
  return `<fieldset class="result-semester-picks" id="resultSemesterPicks"><legend>두 학기 편성 과목 — 개설 학기 선택</legend>
    ${rows ? `<p>편제표 ${target}학년 1·2학기에 모두 편성된 과목이 결과에 한 번만(학기 표시 없이) 나왔습니다. 한 학기만 개설된 것으로 보고, 고른 학기로 그 과목을 신청한 학생 전부를 넣습니다(이 차수만, 4단계 과목 메뉴에서도 바꿀 수 있음).</p><ul>${rows}</ul>` : ""}
    ${decided ? `<p>머리글 표시·열 위치로 학기를 정한 과목(묻지 않음):</p><ul class="result-semester-decided">${decided}</ul>` : ""}</fieldset>`;
}

// 4단계 과목 메뉴의 '개설 학기 바꾸기' 대상인지(현 grade학년 결과의 열 column): 두 학기 편성 과목(같은 과목은 한 학기만)이고 웹 결과가 아님.
function aggregateSemesterChoice(grade, column) {
  const course = (state.courses || []).find((item) => String(item.column) === String(column));
  if (!course || course.applicationGroupSource === "online") return null;
  const names = typeof applicationOnceNames === "function" ? applicationOnceNames(grade) : null;
  const key = typeof applicationSeparateKey === "function" ? applicationSeparateKey(course.name) : courseSemesterPickKey(course.name);
  if (!course.applicationSubject?.sameCourseOnce && !names?.has(key)) return null;
  const semester = String(course.semesterKey || String(course.name).match(/([12])\s*학기/)?.[1] || "");
  return { course, key: courseSemesterPickKey(course.name), semester };
}

function courseSemesterPlanCredit(grade, key, semester) {
  if (typeof collectApplicationSubjects !== "function") return 0;
  let subjects = null;
  try { subjects = collectApplicationSubjects({ includeExcluded: true, currentGrade: String(grade) }); } catch { subjects = null; }
  const item = (subjects?.[String(Number(grade) + 1)] || []).find((subject) => courseSemesterPickKey(subject.subject) === key);
  return Number(item?.semesterCredits?.[semester]) || 0;
}

// 4단계 '개설 학기 바꾸기': 선택을 저장하고 지금 차수 결과의 그 과목(나뉜 열 포함)을 고른 학기 한 열로 모은 뒤 그룹을 다시 정한다.
// 옮긴 과목의 개설 학급수 직접 입력·개설/폐강 결정은 학기가 바뀌므로 지운다. 확정된 차수는 바꾸지 않는다.
async function changeCourseOpeningSemester(grade, column, semester) {
  const round = String(state.currentRound);
  if (typeof isRoundLocked === "function" && isRoundLocked(round)) return false;
  const choice = aggregateSemesterChoice(grade, column);
  if (!choice || !["1", "2"].includes(String(semester)) || choice.semester === String(semester)) return false;
  const label = String(choice.course.name).replace(/\s*[（(]\s*[12]\s*학기\s*[)）]/g, "").replace(/\s*[（(]\s*[23]\s*학년\s*[)）]\s*$/, "").trim();
  const text = `${label}을(를) ${Number(grade) + 1}학년 ${semester}학기에만 개설합니다. 이 과목을 고른 현 ${grade}학년 학생 전부를 ${semester}학기로 옮기고, ` +
    `이 과목의 개설 학급수 직접 입력·개설/폐강 결정은 지웁니다(학기가 바뀌므로 다시 정하세요).\n\n4·5·6단계·확인서·위계 점검이 모두 바뀐 학기를 따릅니다. 바꿀까요?`;
  const ok = typeof appConfirm === "function" ? await appConfirm(text, { title: "개설 학기 바꾸기", ok: `${semester}학기로 바꾸기`, cancel: "취소" }) : window.confirm(text);
  if (!ok || (typeof isRoundLocked === "function" && isRoundLocked(round))) return false;
  setCourseSemesterPick(grade, choice.course.name, semester);
  const data = JSON.parse(JSON.stringify({ courses: state.courses, students: state.students }));
  const result = applyTwoSemesterPick(data, grade, choice.key, String(semester), { credits: courseSemesterPlanCredit(grade, choice.key, String(semester)) });
  if (!result) return false;
  if (typeof classifyApplicationRecords === "function") classifyApplicationRecords(data);
  const touched = new Set([result.column, ...result.removed]);
  const dropKeys = (source, prefixed) => Object.fromEntries(Object.entries(source || {}).filter(([key]) =>
    !touched.has(prefixed ? (key.startsWith(`${grade}:`) ? key.slice(String(grade).length + 1) : "") : key)));
  state.classOverrides = dropKeys(state.classOverrides, true);
  state.semesterAssignments = dropKeys(state.semesterAssignments, false);
  state.groupAssignments = dropKeys(state.groupAssignments, false);
  state.roundClosures ||= {};
  state.roundClosures[round] = dropKeys(state.roundClosures[round], true);
  state.courses = data.courses;
  state.students = data.students;
  if (typeof persistState === "function") persistState();
  if (typeof renderRoster === "function") renderRoster();
  if (typeof renderPreview === "function") renderPreview();
  if (typeof renderSemesterClassifier === "function") renderSemesterClassifier();
  if (typeof renderAggregate === "function") renderAggregate();
  if (typeof renderRetakePanel === "function" && Number(state.workflowStep) === 4) renderRetakePanel();
  if (typeof status !== "undefined" && status) {
    status.style.color = "#287956";
    status.textContent = `${label}: ${Number(grade) + 1}학년 ${semester}학기 개설로 바꿨습니다(학생 ${result.students}명).`;
  }
  return true;
}
