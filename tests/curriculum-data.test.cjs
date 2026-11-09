const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// 데이터 기반 편제표: 업로드한 표 → 과목·선택과목군 데이터 → 화면·엑셀용 표. 실제 학교 파일 대신 같은 형식의 합성 자료를 쓴다.
const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const appFunction = (name) => {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf("\n    function ", start + 1);
  assert.ok(start >= 0 && end > start, name);
  return app.slice(start, end);
};

function context() {
  const ctx = vm.createContext({
    CURRICULUM_DETAIL_OPTIONS: ["공통", "일반선택", "진로선택", "융합선택"],
    CURRICULUM_SEMESTER_FIELDS: ["sem11", "sem12", "sem21", "sem22", "sem31", "sem32"],
    escapeHtml: (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  });
  for (const name of ["columnIndex", "columnName", "curriculumCellFill", "normalizeCurriculumDetail",
    "curriculumSelectionType", "normalizeCurriculumDivision", "normalizeCurriculumAreaName", "isSelectableDetail",
    "normalizeCurriculumPlanRow", "planSubjectKey", "sheetMergeReferenceSet", "importedPlanCoveredCells", "importedPlanCourseContexts",
    "curriculumSubjectNames", "importedPlanColumnMap", "expandCurriculumLayoutRows", "insertImportedPlanLayoutRow",
    "createCurriculumPlanRecords", "curriculumPlanFromLayout", "planRowsFromImportedLayout", "curriculumChangeAttributes"]) {
    vm.runInContext(appFunction(name), ctx);
  }
  const workbook = fs.readFileSync(path.join(root, "curriculum-workbook.js"), "utf8");
  vm.runInContext(workbook.slice(0, workbook.indexOf('document.getElementById("exportCurriculumPlan")')), ctx);
  const versions = fs.readFileSync(path.join(root, "curriculum-versions.js"), "utf8");
  vm.runInContext(versions.slice(0, versions.indexOf("function initCurriculumVersions(")), ctx);
  for (const file of ["curriculum-subject-list.js", "curriculum-choice-blocks.js", "curriculum-data.js", "curriculum-data-view.js", "curriculum-data-export.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), ctx);
  }
  return ctx;
}

// 실제 양식: 제목 1행, 학교명 2행, 머리글 3~4행, 학교 지정(공통 과목 병합) → 학생 선택(택1 묶음 두 개, 이수학점 한 칸 병합),
// 학기 칸 메모(소인수) 과목, 소계·창체 행. '택1' 아래 학점 칸이 다음 과목 행에 있다(지식 재산 일반 택1 / 인공지능 기초 4).
function fixture() {
  const blank = () => Array(14).fill("");
  const row = (values) => Object.assign(blank(), values);
  return {
    sheetName: "편제표", sourceRowOffset: 0, sourceColumnOffset: 0, rowInsertions: [], originalRowCount: 14,
    rows: [
      row({ 0: "2026학년도 신입생 3개년 교육과정 편제표" }),
      row({ 6: "○○고등학교" }),
      row({ 0: "구분", 1: "교과(군)", 2: "세부과목", 4: "기준학점", 5: "운영학점", 6: "1학년", 8: "2학년", 10: "3학년", 12: "이수학점", 13: "필수이수학점" }),
      row({ 6: "1학기", 7: "2학기", 8: "1학기", 9: "2학기", 10: "1학기", 11: "2학기" }),
      row({ 0: "학교 지정 교육과정", 1: "국어", 2: "공통", 3: "공통국어1", 4: "4", 5: "4", 6: "4", 12: "8", 13: "8" }),
      row({ 3: "공통국어2", 4: "4", 5: "4", 7: "4" }),
      row({ 1: "수학", 2: "공통", 3: "공통수학1", 4: "4", 5: "4", 6: "4", 12: "4", 13: "4" }),
      row({ 0: "학생 선택 교육과정", 1: "기술·가정", 2: "융합", 3: "지식 재산 일반", 4: "4", 5: "4", 10: "택1", 12: "8" }),
      row({ 1: "정보", 2: "진로", 3: "인공지능 기초", 4: "4", 5: "4", 10: "4" }),
      row({ 1: "기술·가정", 2: "진로", 3: "발명과 기업가 정신", 4: "4", 5: "4", 11: "택1" }),
      row({ 1: "정보", 2: "융합", 3: "소프트웨어와 생활", 4: "4", 5: "4", 11: "4" }),
      row({ 1: "사회", 2: "진로", 3: "경제", 4: "4", 5: "3", 6: "소인수/2학년/1학기/3학점(순증)", 12: "3" }),
      row({ 0: "이수학점 소계", 6: "8", 7: "4", 8: "0", 9: "0", 10: "4", 11: "4", 12: "20" }),
      row({ 0: "창의적 체험활동", 6: "3", 7: "3", 8: "3", 9: "3", 10: "3", 11: "3", 12: "18" }),
    ],
    mergedRanges: ["A1:N1", "G2:N2", "A3:A4", "B3:B4", "C3:D4", "E3:E4", "F3:F4", "G3:H3", "I3:J3", "K3:L3", "M3:M4", "N3:N4",
      "A5:A7", "B5:B6", "C5:C6", "M5:M6", "N5:N6", "A8:A12", "M8:M11", "G12:L12", "A13:F13", "A14:F14"],
    formulas: { "4:12": "SUM(G5:L6)", "6:12": "SUM(G7:L7)", "7:12": "SUM(G8:L11)", "11:12": "3",
      "12:6": "SUM(G5:G11)", "12:7": "SUM(H5:H11)", "12:8": "SUM(I5:I11)", "12:9": "SUM(J5:J11)", "12:10": "SUM(K5:K11)",
      "12:11": "SUM(L5:L11)", "12:12": "SUM(G13:L13)" },
    cellFills: {}, rowHeights: {}, hiddenRows: [], columnWidths: [10, 10, 6, 24, 6, 6, 6, 6, 6, 6, 6, 6, 8, 8],
  };
}

function converted(ctx = context()) {
  const layout = plain(fixture());
  assert.equal(ctx.ensureCurriculumPlanData(layout), true, layout.planDataError);
  return { ctx, layout: plain(layout) };
}

const subjectByName = (layout, name) => layout.planData.subjects.find((item) => item.name === name);
const range = (ctx, reference) => ctx.planDataRange(reference);
const mergesInColumn = (ctx, layout, column) => layout.mergedRanges.map((reference) => range(ctx, reference))
  .filter((item) => item && item.startColumn === column && item.endColumn === column);

test("업로드한 표는 과목·선택과목군 데이터가 되고 '택1'과 아래 학점 칸은 과목마다 따로 남는다", () => {
  const { ctx, layout } = converted();
  const subjects = layout.planData.subjects.filter((item) => !item.fixed);
  assert.deepEqual(subjects.map((item) => item.name), ["공통국어1", "공통국어2", "공통수학1", "지식 재산 일반", "인공지능 기초",
    "발명과 기업가 정신", "소프트웨어와 생활", "경제"]);
  const groups = layout.planData.groups.map((group) => [group.fields, group.pick, group.credit,
    group.members.map((id) => layout.planData.subjects.find((item) => item.id === id).name)]);
  assert.deepEqual(groups, [
    [["sem31"], 1, 4, ["지식 재산 일반", "인공지능 기초"]],
    [["sem32"], 1, 4, ["발명과 기업가 정신", "소프트웨어와 생활"]],
  ]);
  assert.equal(subjectByName(layout, "경제").note, "소인수/2학년/1학기/3학점(순증)");
  assert.equal(subjectByName(layout, "공통국어1").kindText, "공통");
  assert.equal(subjectByName(layout, "공통국어2").kindJoin, true, "공통 과목 종류 병합은 데이터 묶음으로 남는다");
  // 학년·학기 항목과 소계: 택1 묶음은 1 × 4학점, 소인수(순증)는 소계에서 빠진다.
  const totals = {};
  for (const entry of ctx.curriculumPlanEntries(layout).entries) {
    if (entry.nameIndex > 0 || ["공동", "소인수"].includes(entry.kind)) continue;
    totals[`${entry.grade}-${entry.semester}`] = (totals[`${entry.grade}-${entry.semester}`] || 0) + entry.credit;
  }
  assert.deepEqual(plain(totals), { "1-1": 8, "1-2": 4, "3-1": 8, "3-2": 8 }, "묶음 과목은 각자 학기 항목을 가진다");
  const hours = ctx.curriculumLayoutData(layout) && ctx.curriculumDataChoiceBlocks(layout);
  assert.deepEqual(plain(hours.map((block) => [block.field, block.total, block.subjects])), [
    ["sem31", 4, ["지식 재산 일반", "인공지능 기초"]], ["sem32", 4, ["발명과 기업가 정신", "소프트웨어와 생활"]]]);
});

test("화면은 원본 양식 그대로: 선택과목군은 '택n' 칸 + 그 아래 학점 숫자 칸, 앱 태그·행 메뉴 열 없음", () => {
  const { ctx, layout } = converted();
  const html = ctx.curriculumDataSheetHtml(layout, {}, false, false, new Map());
  const rowHtml = (name) => html.split("<tr").find((part) => part.includes(`data-curriculum-subject="${name}"`));
  const tagCell = rowHtml("지식 재산 일반").match(/<td[^>]*data-source-column="10"[^>]*>[\s\S]*?<\/td>/)[0];
  assert.match(tagCell, /is-group-tag/, "첫 과목 행의 3-1 칸은 '택n' 칸이다");
  assert.match(tagCell, /<button type="button" class="curriculum-group-band"[^>]*>택1<\/button>/, "원본처럼 '택1'만 적힌다(띠·학점 문구 없음)");
  const creditCell = rowHtml("인공지능 기초").match(/<td[^>]*data-source-column="10"[^>]*>[\s\S]*?<\/td>/)[0];
  assert.match(creditCell, /is-group-credit/);
  assert.match(creditCell, /contenteditable="true"[^>]*data-plan-group-credit="[^"]+"[^>]*>4</, "그 아래 칸에는 학점 숫자(원본 양식)가 있고 고칠 수 있다");
  assert.doesNotMatch(html, />택1 · 4학점</, "앱이 덧붙인 '택n · m학점' 띠가 없다");
  assert.equal((html.match(/curriculum-group-band"/g) || []).length, 2);
  assert.match(rowHtml("경제"), /colspan="6"[^>]*>소인수\/2학년\/1학기\/3학점\(순증\)</, "학기 칸 메모는 한 칸으로 보인다");
  assert.doesNotMatch(html, /curriculum-row-tools|plan-section-tag|plan-autoname-mark/, "행 메뉴 열·편성 영역 태그·자동 수정 표시가 기본 화면에 없다");
  assert.match(rowHtml("인공지능 기초"), /class="curriculum-subject-cell"[^>]*>[\s\S]*data-plan-row-menu=/, "행 메뉴(⋯)는 과목명 칸 안에 숨어 있다(마우스를 올리면 보임)");
  assert.match(html, /<thead class="curriculum-data-head">[\s\S]*1학기[\s\S]*<\/thead>/);
  assert.match(html, /이수학점 소계/);
});

test("다시 만든 표는 이수학점·소계·묶음 학점을 수식으로 연결하고 같은 데이터로 다시 읽힌다", () => {
  const { ctx, layout } = converted();
  const subject = subjectByName(layout, "지식 재산 일반");
  assert.equal(layout.formulas[`${subject.row}:12`], `SUM(G${subject.row + 1}:L${subject.row + 4})`, "택1 두 묶음이 이수학점 한 칸을 공유한다");
  assert.equal(layout.rows[subject.row][10], "택1");
  assert.equal(layout.rows[subject.row + 1][10], "4");
  const footer = layout.planRowMeta.findIndex((item) => item.type === "footer");
  assert.equal(layout.rows[footer][0], "이수학점 소계");
  assert.equal(layout.formulas[`${footer}:6`], `SUM(G5:G${footer})`, "소계는 과목 영역 전체를 더한다");
  assert.deepEqual(layout.rows[footer].slice(6, 13), ["8", "4", "0", "0", "4", "4", "20"]);
  const again = ctx.curriculumDataFromLayout(plain({ ...layout, planData: undefined, planTemplate: undefined, planRowMeta: undefined }));
  const strip = (data) => data.subjects.filter((item) => !item.fixed).map((item) =>
    [item.category, item.area, item.kindText, item.name, item.base, item.op, item.credits, item.note]);
  assert.deepEqual(plain(strip(again.data)), plain(strip(layout.planData)));
  assert.deepEqual(plain(again.data.groups.map((group) => [group.fields, group.pick, group.credit, group.members.length])),
    plain(layout.planData.groups.map((group) => [group.fields, group.pick, group.credit, group.members.length])));
});

test("택n 묶음의 학점 칸은 n개이고 둘째 칸부터 첫 칸을 가리키는 수식이다", () => {
  const { ctx, layout } = converted();
  const group = layout.planData.groups[0];
  const { layout: next } = ctx.curriculumDataUpdateGroup(layout, group.id, { pick: "2", credit: "3" });
  const subject = subjectByName(next, "지식 재산 일반");
  assert.deepEqual([1, 2].map((offset) => next.rows[subject.row + offset][10]), ["3", "3"]);
  assert.equal(next.formulas[`${subject.row + 2}:10`], `K${subject.row + 2}`);
  const footer = next.planRowMeta.findIndex((item) => item.type === "footer");
  assert.equal(next.rows[footer][10], "6", "3-1 소계 = 택2 × 3학점");
});

test("과목을 추가하면 같은 구분·교과(군) 끝에 들어가 병합·이수학점·소계가 원래 양식대로 이어진다", () => {
  const { ctx, layout } = converted();
  const { layout: next } = ctx.buildCurriculumDataSubjectChange(layout, [], {
    action: "add", subject: "매체 의사소통", grade: "1", semester: "2", credit: 2, division: "학교 지정 교육과정" });
  const names = next.planData.subjects.filter((item) => !item.fixed).map((item) => item.name);
  assert.deepEqual(plain(names.slice(0, 4)), ["공통국어1", "공통국어2", "매체 의사소통", "공통수학1"]);
  const added = subjectByName(next, "매체 의사소통");
  assert.equal(added.row, 6);
  const mergeAt = (column, row) => mergesInColumn(ctx, next, column).find((item) => item.startRow <= row && item.endRow >= row);
  assert.deepEqual(plain(mergeAt(0, 6)), { startColumn: 0, endColumn: 0, startRow: 4, endRow: 7 }, "구분 병합이 새 행까지 늘어난다");
  assert.deepEqual(plain(mergeAt(1, 6)), { startColumn: 1, endColumn: 1, startRow: 4, endRow: 6 }, "국어 병합이 새 행까지 늘어난다");
  assert.deepEqual(plain(mergeAt(12, 6)), { startColumn: 12, endColumn: 12, startRow: 4, endRow: 6 }, "이수학점 칸도 같은 묶음");
  assert.equal(next.formulas["4:12"], "SUM(G5:L7)");
  assert.equal(next.rows[4][12], "10");
  const footer = next.planRowMeta.findIndex((item) => item.type === "footer");
  assert.equal(next.formulas[`${footer}:7`], `SUM(H5:H${footer})`);
  assert.equal(next.rows[footer][7], "6");
  // 빈 행이 없다: 과목 영역의 모든 행은 과목 이름이 있거나 과목의 아래 행이다.
  for (let row = 4; row < footer; row++) {
    const meta = next.planRowMeta[row];
    assert.ok(meta.type === "subject" && (meta.part > 0 || String(next.rows[row][3]).trim()), `행 ${row + 1}`);
  }
});

test("행 메뉴: 위에 추가·삭제·이동은 묶음과 병합을 데이터에 맞춰 다시 계산한다", () => {
  const { ctx, layout } = converted();
  const target = subjectByName(layout, "경제");
  const { layout: inserted } = ctx.buildCurriculumDataSubjectChange(layout, [], {
    action: "add", subject: "직무 의사소통", grade: "3", semester: "2", credit: 2, division: "학생 선택 교육과정", before: target.id });
  const order = inserted.planData.subjects.filter((item) => !item.fixed).map((item) => item.name);
  assert.equal(order.indexOf("직무 의사소통") + 1, order.indexOf("경제"), "선택한 행 바로 위에 들어간다");

  const ai = subjectByName(layout, "인공지능 기초");
  const { layout: removed } = ctx.curriculumDataDeleteRow(layout, ai.id);
  assert.equal(subjectByName(removed, "인공지능 기초"), undefined);
  const group = removed.planData.groups.find((item) => item.fields[0] === "sem31");
  assert.deepEqual(plain(group.members.map((id) => removed.planData.subjects.find((item) => item.id === id).name)), ["지식 재산 일반"]);
  const studentMerge = mergesInColumn(ctx, removed, 0).find((item) => item.startRow === subjectByName(removed, "지식 재산 일반").row);
  assert.equal(studentMerge.endRow, subjectByName(removed, "경제").rowEnd, "학생 선택 구분 병합이 남은 과목에 맞게 줄어든다");

  const { layout: moved } = ctx.curriculumDataMoveRow(layout, ai.id, -1);
  const movedOrder = moved.planData.subjects.filter((item) => !item.fixed).map((item) => item.name);
  assert.deepEqual(plain(movedOrder.slice(3, 5)), ["인공지능 기초", "지식 재산 일반"]);
  assert.equal(moved.rows[subjectByName(moved, "인공지능 기초").row][10], "택1", "묶음 표시는 묶음의 첫 행을 따른다");
  assert.throws(() => ctx.curriculumDataMoveRow(layout, subjectByName(layout, "지식 재산 일반").id, -1), (error) => /맨 위/.test(error?.message));
});

test("학기 칸을 골라 선택과목군으로 묶고 풀 수 있다", () => {
  const { ctx, layout } = converted();
  const first = subjectByName(layout, "지식 재산 일반");
  const second = subjectByName(layout, "인공지능 기초");
  const selection = { column: 10, startRow: first.row, endRow: second.rowEnd };
  const { layout: released } = ctx.curriculumDataUngroupSelection(layout, selection);
  assert.equal(released.planData.groups.length, 1);
  assert.deepEqual(plain(subjectByName(released, "지식 재산 일반").credits), { sem31: 4 });
  assert.deepEqual(plain(subjectByName(released, "인공지능 기초").credits), { sem31: 4 });
  assert.match(ctx.curriculumDataSelectionLabel(released, selection), /^3-1 · 2과목 선택/);
  const { layout: grouped } = ctx.curriculumDataGroupSelection(released, selection, { pick: "1", credit: "4" });
  const group = grouped.planData.groups.find((item) => item.fields[0] === "sem31");
  assert.deepEqual([group.pick, group.credit, group.members.length], [1, 4, 2]);
  assert.throws(() => ctx.curriculumDataGroupSelection(released, selection, { pick: "3", credit: "4" }), (error) => /택3/.test(error?.message));
});

test("예전 표 기반 편제표(끼워 넣은 행·삭제 흔적)는 열 때 데이터로 바뀐다", () => {
  const ctx = context();
  const legacy = plain(fixture());
  const before = ctx.curriculumPlanEntries(plain(legacy)).entries.map((entry) => [entry.grade, entry.semester, entry.subject, entry.credit]);
  // 예전 앱에서 행을 끼워 넣은 뒤 그 행의 과목을 지운 흔적(빈 행)
  const withBlank = ctx.insertImportedPlanLayoutRow(plain(legacy), 7, []);
  assert.equal(ctx.ensureCurriculumPlanData(withBlank), true, withBlank.planDataError);
  const after = ctx.curriculumPlanEntries(withBlank).entries.map((entry) => [entry.grade, entry.semester, entry.subject, entry.credit]);
  assert.deepEqual(plain(after).sort(), plain(before).sort());
  const footer = withBlank.planRowMeta.findIndex((item) => item.type === "footer");
  assert.equal(footer, 12, "빈 행은 버린다");
});

test("내보내기 행 이동: 과목 영역 아래의 참조는 늘어난 행만큼 내리고 영역 안의 범위는 새 영역 전체가 된다", () => {
  const ctx = context();
  const template = { header: { rows: [[], [], [], []], sources: [0, 1, 2, 3] }, footer: { rows: [[], []], sources: [12, 13] }, bodyEnd: 11 };
  const bounds = ctx.planExportOriginalBounds(template);
  assert.deepEqual(plain(bounds), { headerRows: 4, bodyStart: 4, footerStart: 12, last: 13 });
  const mapRow = ctx.planExportRowMapper(bounds, 0, 4, 14);
  assert.equal(ctx.planExportShiftReferences("SUM(G5:G12)+M13", mapRow), "SUM(G5:G14)+M15");
  assert.equal(ctx.planExportShiftReferences("$A$1:$N$14", mapRow), "$A$1:$N$16");
  assert.equal(ctx.planExportShiftReferences('"G13"&G13', mapRow), '"G13"&G15', "따옴표 안 글자는 그대로 둔다");
});
