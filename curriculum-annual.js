"use strict";
// 올해 전학년 편제표는 따로 올리지 않고, 올해 1·2·3학년 입학생의 신입생 3개년 편제표에서
// 각 학년 열만 가져와 만든다. 1학년=올해 입학생, 2학년=전년도 입학생, 3학년=전전년도 입학생이다.

function annualCohortYears(schoolYear) {
  const year = Number(schoolYear);
  return { 1: String(year), 2: String(year - 1), 3: String(year - 2) };
}

function annualCreditNumber(value) {
  const number = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function annualCreditText(number) {
  return number ? String(Math.round(number * 100) / 100) : "";
}

function annualSubjectKey(subject) {
  return String(subject ?? "").replace(/\s+/g, "");
}

function annualGradeRows(cohorts, schoolYear, grade) {
  const year = annualCohortYears(schoolYear)[grade];
  return (cohorts?.[year]?.plan || []).filter((row) =>
    annualCreditNumber(row[`sem${grade}1`]) || annualCreditNumber(row[`sem${grade}2`]));
}

// 원본 3개년 편제표가 바뀌었는지 알 수 있도록 만들 때 쓴 학기 학점의 지문을 남긴다.
function annualCurriculumSignature(cohorts, schoolYear) {
  const parts = [];
  for (const grade of [1, 2, 3]) {
    parts.push(annualCohortYears(schoolYear)[grade], annualGradeRows(cohorts, schoolYear, grade)
      .map((row) => [row.division, row.area, row.detail, row.subject, row.baseCredit, row.opCredit,
        row[`sem${grade}1`], row[`sem${grade}2`]].join("|")).join("\n"));
  }
  return parts.join("\n#\n");
}

function annualSourceStatus(cohorts, schoolYear) {
  const years = annualCohortYears(schoolYear);
  return [1, 2, 3].map((grade) => ({
    grade, year: years[grade],
    fileName: cohorts?.[years[grade]]?.fileName || "",
    rows: annualGradeRows(cohorts, schoolYear, grade).length
  }));
}

function buildAnnualCurriculumLayout(cohorts, schoolYear) {
  const entries = new Map();
  for (const grade of [1, 2, 3]) {
    for (const row of annualGradeRows(cohorts, schoolYear, grade)) {
      const key = annualSubjectKey(row.subject);
      if (!key) continue;
      if (!entries.has(key)) {
        entries.set(key, {
          division: row.division || "", area: row.area || "", detail: row.detail || "", subject: row.subject,
          baseCredit: row.baseCredit || 0, opCredit: row.opCredit || 0, credits: {}
        });
      }
      const entry = entries.get(key);
      if (!entry.baseCredit && row.baseCredit) entry.baseCredit = row.baseCredit;
      if (!entry.opCredit && row.opCredit) entry.opCredit = row.opCredit;
      for (const semester of [1, 2]) entry.credits[`${grade}-${semester}`] = annualCreditNumber(row[`sem${grade}${semester}`]);
    }
  }
  const divisions = new Map();
  for (const entry of entries.values()) {
    if (!divisions.has(entry.division)) divisions.set(entry.division, new Map());
    const areas = divisions.get(entry.division);
    if (!areas.has(entry.area)) areas.set(entry.area, []);
    areas.get(entry.area).push(entry);
  }
  const header = [
    ["", "", "", "", "", "", "", "", "", "", "", "", ""],
    ["구분", "교과(군)", "세부과목", "", "기준학점", "운영학점", "1학년", "", "2학년", "", "3학년", "", "이수 학점"],
    ["", "", "", "", "", "", "1학기", "2학기", "1학기", "2학기", "1학기", "2학기", ""]
  ];
  header[0][0] = `${schoolYear}학년도 전학년 편제표 (신입생 3개년 편제표 기준)`;
  const semesterKeys = ["1-1", "1-2", "2-1", "2-2", "3-1", "3-2"];
  const totals = Object.fromEntries(semesterKeys.map((key) => [key, 0]));
  const body = [];
  for (const [division, areas] of divisions) {
    let firstOfDivision = true;
    for (const [area, rows] of areas) {
      let firstOfArea = true;
      for (const entry of rows) {
        const sum = semesterKeys.reduce((total, key) => total + (entry.credits[key] || 0), 0);
        for (const key of semesterKeys) totals[key] += entry.credits[key] || 0;
        body.push([
          firstOfDivision ? division : "", firstOfArea ? area : "", entry.detail, entry.subject,
          annualCreditText(entry.baseCredit), annualCreditText(entry.opCredit),
          ...semesterKeys.map((key) => annualCreditText(entry.credits[key])), annualCreditText(sum)
        ]);
        firstOfDivision = false;
        firstOfArea = false;
      }
    }
  }
  const grandTotal = semesterKeys.reduce((total, key) => total + totals[key], 0);
  const subtotal = ["", "", "소계", "", "", "", ...semesterKeys.map((key) => annualCreditText(totals[key])), annualCreditText(grandTotal)];
  return {
    rows: [...header, ...body, subtotal],
    mergedRanges: ["A1:M1", "A2:A3", "B2:B3", "C2:D3", "E2:E3", "F2:F3", "G2:H2", "I2:J2", "K2:L2", "M2:M3"],
    rowInsertions: [], rowHeights: {}, cellFills: {}, formulas: {},
    columnWidths: [16, 14, 10, 24, 8, 8, 8, 8, 8, 8, 8, 8, 10],
    sheetName: "전학년 편제표",
    derived: true
  };
}

// 원본 엑셀이 없는 자동 생성 편제표를 내려받을 때 쓴다.
function buildDerivedCurriculumWorkbook(layout) {
  const rows = layout.rows.map((row, rowIndex) => Array.from({ length: layout.columnWidths.length }, (_, column) => {
    const text = row[column] ?? "";
    if (rowIndex === 0) return { v: text, s: 1 };
    if (rowIndex <= 2) return { v: text, s: 2 };
    const numeric = column >= 4 && text !== "" && Number.isFinite(Number(text));
    return { v: numeric ? Number(text) : text, s: column >= 4 ? 4 : 3 };
  }));
  return createWorkbookBlob([{
    name: layout.sheetName || "전학년 편제표",
    rows,
    widths: layout.columnWidths,
    merges: layout.mergedRanges,
    freeze: "A4"
  }]);
}
