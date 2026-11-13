// 다른 학교에서 처음 쓸 때 막히지 않게 돕는 안내: 편제표를 읽지 못한 이유, 편제표를 넣는 두 가지 길,
// 예시·빈 양식(가상 과목, 앱이 그 자리에서 만듦), 첫 실행 안내, 학년도 기본값. app.js 뒤에 로드한다.
// 위쪽은 순수 계산(DOM·state 없음), '// ---- 앱 연결' 아래가 화면 연결이다. 계획·정한 것: docs/multi-school.md

// 학년도 기본값: 새 학년도는 3월에 시작한다(1·2월은 아직 전 학년도).
function schoolGuideDefaultYear(date = new Date()) {
  const year = date.getFullYear();
  return String(date.getMonth() + 1 >= 3 ? year : year - 1);
}

const SCHOOL_GUIDE_SEMESTERS = ["1-1", "1-2", "2-1", "2-2", "3-1", "3-2"];

// 올린 표에서 어느 머리글·열을 찾았고 못 찾았는지(변환기와 같은 importedPlanColumnMap을 씀).
function curriculumPlanReadReport(layout) {
  const letter = (column) => typeof columnName === "function" ? `${columnName(column)}열` : `${column + 1}번째 열`;
  const found = [];
  const missing = [];
  let columns = null;
  try { columns = layout?.rows?.length ? importedPlanColumnMap(layout) : null; } catch { columns = null; }
  if (!columns) return { found, missing: ["표(시트에 내용이 없거나 표를 찾지 못함)"], columns: null };
  if (columns.subject >= 0) found.push(`과목명: ${letter(columns.subject)}`);
  else missing.push("과목명 열 — 머리글에 '과목명' 또는 '세부과목'이 있어야 합니다");
  const semesters = columns.semesters.map((column, index) => ({ column, label: SCHOOL_GUIDE_SEMESTERS[index] }));
  const haveSemesters = semesters.filter((item) => item.column >= 0);
  const lostSemesters = semesters.filter((item) => !(item.column >= 0));
  if (haveSemesters.length) found.push(`학기 열: ${haveSemesters.map((item) => `${item.label}(${letter(item.column)})`).join(", ")}`);
  if (lostSemesters.length) {
    missing.push(`학기 열 ${lostSemesters.map((item) => item.label).join(", ")} — 머리글이 '1학년' 아래 '1학기'·'2학기'(두 줄) 또는 '1-1'·'1학년 1학기'여야 합니다`);
  }
  if (columns.baseCredit >= 0 || columns.opCredit >= 0) {
    found.push(`학점: ${[columns.baseCredit >= 0 ? `기준학점 ${letter(columns.baseCredit)}` : "", columns.opCredit >= 0 ? `운영학점 ${letter(columns.opCredit)}` : ""].filter(Boolean).join(", ")}`);
  } else missing.push("학점 열 — 머리글 '기준학점'·'운영학점'(없어도 읽지만 학점 점검이 부정확해집니다)");
  if (columns.division >= 0) found.push(`구분(학교 지정/학생 선택): ${letter(columns.division)}`);
  else missing.push("구분 열 — 머리글 '구분', 칸 내용이 '학교 지정…'·'학생 선택…'(없으면 모든 과목을 학생 선택으로 봅니다)");
  return { found, missing, columns };
}

// 읽지 못한 이유와 해결 방법. error = layout.planDataError(없으면 표를 다시 보고 추정).
function curriculumPlanErrorGuide(layout, error = "") {
  const report = curriculumPlanReadReport(layout);
  const message = String(error || layout?.planDataError || "").trim();
  let reason = message;
  if (!reason) {
    reason = !report.columns ? "편제표 표가 비어 있습니다."
      : report.columns.subject < 0 ? "편제표에서 과목명 열을 찾지 못했습니다."
        : !report.columns.semesters.some((column) => column >= 0) ? "편제표에서 학년·학기 열을 찾지 못했습니다."
          : "편제표를 과목 데이터로 바꾸지 못했습니다.";
  }
  const hints = [];
  if (/과목 행/.test(reason)) hints.push("머리글 아래에 과목 행이 있어야 합니다. 과목명 칸이 다른 칸과 가로로 합쳐져 있거나, 표가 '소계·합계' 줄보다 아래에 있으면 읽지 못합니다.");
  if (/학년·학기/.test(reason)) hints.push("학기 열이 6개(1-1 ~ 3-2)여야 합니다. 학기 구분 없이 학년 한 열만 있는 편제표는 읽지 못합니다.");
  return {
    reason,
    found: report.found,
    missing: report.missing,
    hints,
    steps: [
      "울산 편제 점검 프로그램 파일(.xlsb 또는 .xlsx, 「N학년_편성과목」 시트가 있는 파일)이 있으면 그 파일을 그대로 올리세요. 가장 확실합니다.",
      "학교 자체 양식이면 '예시 양식 내려받기'로 받은 파일과 머리글을 견주어 고치거나, '빈 양식 내려받기'에 과목을 옮겨 적어 올리세요.",
    ],
  };
}

// 예시·빈 양식(가상 편제표). 앱 변환기가 읽는 모양: 제목 1행 · 학교명 2행 · 머리글 3~4행 · 과목 행 · 소계 · 창체.
// 선택과목군은 학기 열에서 구성 과목 행을 세로로 합친 칸 '택n\nm학점'(앱의 엑셀 내보내기와 같은 표기).
function curriculumSamplePlanSheet({ year = "", blank = false } = {}) {
  const width = 14;
  const row = (values = {}) => Object.assign(Array(width).fill(""), values);
  const rows = [
    row({ 0: `${year || "○○○○"}학년도 신입생 3개년 교육과정 편제표${blank ? "" : " (예시)"}` }),
    row({ 6: "○○고등학교" }),
    row({ 0: "구분", 1: "교과(군)", 2: "세부과목", 4: "기준학점", 5: "운영학점", 6: "1학년", 8: "2학년", 10: "3학년", 12: "이수학점", 13: "필수이수학점" }),
    row({ 6: "1학기", 7: "2학기", 8: "1학기", 9: "2학기", 10: "1학기", 11: "2학기" }),
  ];
  const merges = ["A1:N1", "G2:N2", "A3:A4", "B3:B4", "C3:D4", "E3:E4", "F3:F4", "G3:H3", "I3:J3", "K3:L3", "M3:M4", "N3:N4"];
  const semesterColumn = (key) => 6 + SCHOOL_GUIDE_SEMESTERS.indexOf(key);
  const cell = (column, index) => `${String.fromCharCode(65 + column)}${index + 1}`;
  // [교과(군), 유형, 과목명, 기준학점, 운영학점, 학기]
  const designated = blank ? [["", "", "", "", "", ""], ["", "", "", "", "", ""], ["", "", "", "", "", ""]] : [
    ["국어", "공통", "공통국어1", 4, 4, "1-1"], ["국어", "공통", "공통국어2", 4, 4, "1-2"],
    ["수학", "공통", "공통수학1", 4, 4, "1-1"], ["수학", "공통", "공통수학2", 4, 4, "1-2"],
    ["영어", "공통", "공통영어1", 4, 4, "1-1"], ["영어", "공통", "공통영어2", 4, 4, "1-2"],
    ["사회", "공통", "한국사1", 3, 3, "1-1"], ["사회", "공통", "한국사2", 3, 3, "1-2"],
    ["사회", "공통", "통합사회1", 4, 4, "1-1"], ["사회", "공통", "통합사회2", 4, 4, "1-2"],
    ["과학", "공통", "통합과학1", 4, 4, "1-1"], ["과학", "공통", "통합과학2", 4, 4, "1-2"],
    ["체육", "일반", "체육1", 2, 2, "1-1"], ["체육", "일반", "체육2", 2, 2, "1-2"],
    ["예술", "일반", "음악", 4, 3, "1-1"], ["예술", "일반", "미술", 4, 3, "1-2"],
    ["국어", "일반", "문학", 4, 4, "2-1"], ["국어", "일반", "독서와 작문", 4, 4, "2-2"],
    ["체육", "진로", "운동과 건강", 4, 2, "2-1"], ["체육", "진로", "스포츠 생활1", 2, 2, "2-2"],
  ];
  // 선택과목군: [학기, 택n, 묶음 학점, [[교과(군), 유형, 과목명, 기준, 운영], …]]
  const groups = blank ? [["2-1", 1, 4, [["", "", "", "", ""], ["", "", "", "", ""]]]] : [
    ["2-1", 2, 4, [["수학", "일반", "대수", 4, 4], ["영어", "일반", "영어Ⅰ", 4, 4], ["사회", "일반", "세계시민과 지리", 4, 4], ["과학", "일반", "물리학", 4, 4]]],
    ["2-2", 2, 4, [["수학", "일반", "미적분Ⅰ", 4, 4], ["영어", "일반", "영어Ⅱ", 4, 4], ["사회", "일반", "세계사", 4, 4], ["과학", "일반", "화학", 4, 4]]],
    ["3-1", 1, 4, [["기술·가정/정보", "융합", "지식 재산 일반", 4, 4], ["기술·가정/정보", "진로", "인공지능 기초", 4, 4]]],
    ["3-2", 1, 4, [["교양", "교양", "진로와 직업", 4, 4], ["교양", "교양", "논술", 4, 4]]],
  ];
  const first = rows.length;
  designated.forEach((item, index) => {
    const values = { 1: item[0], 2: item[1], 3: item[2], 4: item[3], 5: item[4] };
    if (index === 0) values[0] = "학교 지정 교육과정";
    if (item[5]) values[semesterColumn(item[5])] = item[4];
    rows.push(row(values));
  });
  if (designated.length > 1) merges.push(`A${first + 1}:A${first + designated.length}`);
  const choiceFirst = rows.length;
  for (const [semester, pick, credit, members] of groups) {
    const start = rows.length;
    members.forEach((item, index) => {
      const values = { 1: item[0], 2: item[1], 3: item[2], 4: item[3], 5: item[4] };
      if (rows.length === choiceFirst) values[0] = "학생 선택 교육과정";
      if (index === 0) values[semesterColumn(semester)] = `택${pick}\n${credit}학점`;
      rows.push(row(values));
    });
    if (members.length > 1) merges.push(`${cell(semesterColumn(semester), start)}:${cell(semesterColumn(semester), rows.length - 1)}`);
  }
  if (rows.length - choiceFirst > 1) merges.push(`A${choiceFirst + 1}:A${rows.length}`);
  const bodyLast = rows.length;
  const sum = (column) => blank ? "" : designated.reduce((total, item) => total + (semesterColumn(item[5]) === column ? Number(item[4]) : 0), 0) +
    groups.reduce((total, group) => total + (semesterColumn(group[0]) === column ? group[1] * group[2] : 0), 0);
  const subtotal = row({ 0: "이수학점 소계" });
  for (let column = 6; column <= 11; column++) subtotal[column] = sum(column);
  if (!blank) subtotal[12] = [6, 7, 8, 9, 10, 11].reduce((total, column) => total + sum(column), 0);
  rows.push(subtotal);
  rows.push(row(blank ? { 0: "창의적 체험활동" } : { 0: "창의적 체험활동", 6: 3, 7: 3, 8: 3, 9: 3, 10: 3, 11: 3, 12: 18 }));
  merges.push(`A${bodyLast + 1}:F${bodyLast + 1}`, `A${bodyLast + 2}:F${bodyLast + 2}`);
  return { name: "편제표", rows, merges, widths: [12, 14, 7, 22, 8, 8, 8, 8, 8, 8, 8, 8, 9, 11] };
}

// 양식과 함께 주는 '작성 방법' 시트(글만).
function curriculumSamplePlanHelpSheet() {
  const lines = [
    "편제표 작성 방법 (교육과정 관리 앱이 읽는 모양)",
    "",
    "1. 머리글: '구분' · '교과(군)' · '세부과목'(또는 '과목명') · '기준학점' · '운영학점' · 학기 열 6개 · '이수학점'.",
    "   학기 열은 '1학년' 아래 '1학기'·'2학기'처럼 두 줄이거나 '1-1' ~ '3-2'처럼 한 줄이어야 합니다.",
    "2. 과목 한 개를 한 행에 적고, 운영하는 학기 칸에 학점(숫자)을 적습니다.",
    "3. 구분 칸: '학교 지정 …'으로 시작하면 모든 학생이 듣는 과목, '학생 선택 …'으로 시작하면 수강신청 과목입니다.",
    "4. 선택과목군(여러 과목 중 n개 선택): 학기 열에서 그 과목들의 칸을 세로로 합치고 '택2 4학점'처럼 적습니다(택n + 과목당 학점).",
    "5. 교차집중(예: 음악↔미술을 1·2학기에 반씩 바꿔 듣기): 과목명에 '음악↔미술'처럼 적거나 올린 뒤 앱에서 지정합니다.",
    "6. 과목 행은 '소계'·'합계'·'창의적 체험활동' 줄 위에 둡니다(그 아래는 읽지 않습니다).",
    "7. 한 파일에 입학생 한 해의 1~3학년 전체(3개년)를 담습니다. 입학연도마다 파일을 따로 올립니다.",
    "8. 울산 편제 점검 프로그램 파일(.xlsb/.xlsx)이 있으면 이 양식으로 옮길 필요 없이 그 파일을 그대로 올리면 됩니다.",
  ];
  return { name: "작성 방법", rows: lines.map((line) => [line]), widths: [110], orientation: "portrait" };
}

// 엑셀 파일(시트 값·병합)을 변환기가 읽는 표 모양으로(테스트·미리 확인용).
function curriculumSamplePlanLayout(sheet) {
  return {
    sheetName: sheet.name, sourceRowOffset: 0, sourceColumnOffset: 0, rowInsertions: [], originalRowCount: sheet.rows.length,
    rows: sheet.rows.map((row) => row.map((value) => value === "" || value === null || value === undefined ? "" : String(value))),
    mergedRanges: [...sheet.merges], formulas: {}, cellFills: {}, rowHeights: {}, hiddenRows: [], columnWidths: [...sheet.widths],
  };
}

// 첫 실행 안내에 쓰는 진행 상태(순수). facts = { schoolName, cohortsNeeded: [연도…], cohortsLoaded: [연도…], hasResults }
function schoolGuideSteps(facts = {}) {
  const needed = facts.cohortsNeeded || [];
  const loaded = new Set((facts.cohortsLoaded || []).map(String));
  const missing = needed.filter((year) => !loaded.has(String(year)));
  return [
    { key: "school", label: "학교 이름·학년도 확인", done: Boolean(String(facts.schoolName || "").trim()),
      detail: facts.schoolName ? `${facts.schoolName} · ${facts.schoolYear}학년도` : `학교 이름을 넣고 학년도(지금 ${facts.schoolYear})가 맞는지 확인하세요.` },
    { key: "plans", label: "입학생 편제표 올리기", done: needed.length > 0 && !missing.length,
      detail: missing.length ? `아직 없는 편제표: ${missing.map((year) => `${year}학년도 입학생`).join(", ")} — 울산 편제 점검 프로그램 파일을 그대로 올려도 됩니다.` : "편제표를 모두 올렸습니다." },
    { key: "results", label: "수강신청 받기 또는 결과 올리기", done: Boolean(facts.hasResults),
      detail: "2단계에서 웹 수강신청을 만들거나, 다른 프로그램에서 받은 결과 엑셀을 올립니다." },
  ];
}

// ---- 앱 연결 ----

if (typeof document !== "undefined" && typeof window !== "undefined") {
  const escapeText = (value) => typeof escapeHtml === "function" ? escapeHtml(value) : String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

  // 1단계 카드: 과목 데이터로 읽지 못한 편제표 표시(누르면 이유·해결 창).
  window.curriculumPlanErrorCardHtml = function curriculumPlanErrorCardHtml(year, layout) {
    if (!layout || layout.derived || layout.planData) return "";
    return `<button class="button curriculum-plan-error-button" type="button" data-plan-error-cohort="${escapeText(year)}" title="이 편제표는 표로만 불러왔습니다. 선택과목군 띠·편제 점검·교차집중 같은 기능을 쓸 수 없습니다. 누르면 읽지 못한 이유와 해결 방법을 보여 줍니다.">읽지 못함 · 이유 보기</button>`;
  };

  // 업로드 직후 상태 줄에 붙일 문구(읽었으면 빈 글자).
  window.curriculumPlanErrorStatus = function curriculumPlanErrorStatus(layout) {
    if (!layout || layout.derived || layout.planData) return "";
    const guide = curriculumPlanErrorGuide(layout);
    return `표는 불러왔지만 과목 데이터로 읽지 못했습니다 — ${guide.reason} 카드의 '읽지 못함 · 이유 보기'를 누르면 해결 방법이 나옵니다.`;
  };

  function guideDialog() {
    let dialog = document.getElementById("curriculumGuideDialog");
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = "curriculumGuideDialog";
    dialog.className = "curriculum-subject-dialog curriculum-guide-dialog";
    dialog.setAttribute("aria-labelledby", "curriculumGuideTitle");
    dialog.innerHTML = `<form method="dialog">
      <h2 id="curriculumGuideTitle">편제표 넣는 방법</h2>
      <div id="curriculumGuideError"></div>
      <ol class="curriculum-guide-ways">
        <li><strong>울산 편제 점검 프로그램 파일을 그대로 올리기 (권장)</strong>
          <p class="note">울산광역시교육청 편제 점검 프로그램 파일(.xlsb 또는 .xlsx, 「1학년_편성과목」·「2학년_편성과목」·「3학년_편성과목」 시트)을 입학생 카드의 '업로드'에 그대로 올리면 과목·선택과목군·교차집중을 읽습니다. 따로 고칠 필요가 없습니다.</p></li>
        <li><strong>학교에서 쓰는 편제표 엑셀(.xlsx) 올리기</strong>
          <p class="note">머리글에 '세부과목'(또는 '과목명')과 학기 열 6개('1학년' 아래 '1학기'·'2학기', 또는 '1-1' ~ '3-2')가 있어야 읽습니다. 선택과목군은 학기 열에 '택2' + 학점으로 적습니다. 아래 예시와 견주어 보거나, 빈 양식에 옮겨 적어 올리세요. 한글(.hwp)·옛 엑셀(.xls)은 읽지 못하니 엑셀에서 .xlsx로 저장해 주세요.</p>
          <p><button class="button" type="button" id="curriculumSampleDownload">예시 양식 내려받기</button>
          <button class="button" type="button" id="curriculumBlankDownload">빈 양식 내려받기</button></p></li>
      </ol>
      <p class="note">편제표는 입학생 한 해의 3개년 편제표를 한 파일로, 입학연도 카드마다 따로 올립니다. 전학년 편제표는 올리지 않고 세 편제표에서 자동으로 만듭니다. 예시 양식의 과목은 가상입니다.</p>
      <div class="curriculum-version-dialog-actions"><button class="button button-primary" type="submit" value="close">닫기</button></div>
    </form>`;
    document.body.append(dialog);
    const download = (blank) => {
      if (typeof createWorkbookBlob !== "function" || typeof downloadBlob !== "function") return;
      const year = typeof state !== "undefined" && state.curriculumPlanType !== "annual" ? String(state.curriculumCohortYear || "") : "";
      const sheets = [curriculumSamplePlanSheet({ year, blank }), curriculumSamplePlanHelpSheet()];
      downloadBlob(createWorkbookBlob(sheets), blank ? "편제표_빈양식.xlsx" : "편제표_예시양식.xlsx");
    };
    dialog.querySelector("#curriculumSampleDownload").addEventListener("click", () => download(false));
    dialog.querySelector("#curriculumBlankDownload").addEventListener("click", () => download(true));
    return dialog;
  }

  // layout을 주면 읽지 못한 이유를 맨 위에 보여 준다.
  window.openCurriculumGuide = function openCurriculumGuide(layout = null, label = "") {
    const dialog = guideDialog();
    const box = dialog.querySelector("#curriculumGuideError");
    if (layout && !layout.planData && !layout.derived) {
      const guide = curriculumPlanErrorGuide(layout);
      const list = (title, items) => items.length ? `<p><strong>${title}</strong></p><ul>${items.map((item) => `<li>${escapeText(item)}</li>`).join("")}</ul>` : "";
      box.innerHTML = `<div class="curriculum-guide-error" role="alert">
        <p><strong>${escapeText(label ? `${label} — ` : "")}과목 데이터로 읽지 못한 이유:</strong> ${escapeText(guide.reason)}</p>
        ${list("찾지 못한 것", guide.missing)}${list("찾은 것", guide.found)}
        ${guide.hints.map((hint) => `<p class="note">${escapeText(hint)}</p>`).join("")}
        <p class="note">지금은 표로만 불러온 상태라 선택과목군 띠·편제 점검·교차집중·교육청 양식 내보내기를 쓸 수 없습니다. 아래 방법으로 다시 올려 주세요('원본 교체').</p>
      </div>`;
      dialog.querySelector("#curriculumGuideTitle").textContent = "편제표를 읽지 못했습니다";
    } else {
      box.innerHTML = "";
      dialog.querySelector("#curriculumGuideTitle").textContent = "편제표 넣는 방법";
    }
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
  };

  document.addEventListener("click", (event) => {
    const errorButton = event.target.closest?.("[data-plan-error-cohort]");
    if (errorButton) {
      const year = errorButton.dataset.planErrorCohort;
      const active = typeof state !== "undefined" && state.curriculumPlanType !== "annual" && String(state.curriculumCohortYear) === String(year);
      const layout = active ? state.curriculumImportedLayout : state.curriculumCohorts?.[year]?.importedLayout;
      window.openCurriculumGuide(layout, `${year}학년도 입학생 편제표`);
      return;
    }
    if (event.target.closest?.("#openCurriculumGuide, [data-open-curriculum-guide]")) window.openCurriculumGuide();
  });
}
