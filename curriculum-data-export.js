"use strict";
// 데이터 편제표 엑셀 내보내기 = 원래 양식 + 데이터 + 수식.
// 원본 엑셀(IndexedDB 보관본)의 시트에서 제목·머리글·소계 행과 열 너비·글꼴·채움색은 그대로 두고,
// 과목 행 영역만 데이터로 다시 만든 표(layout.rows·병합·수식)로 새로 채운다. 새 과목 행은 같은 묶음 행의 서식을 복사한다.
// 이수학점·소계·합계·선택과목군 학점은 엑셀 수식으로 연결되고, 파일을 열 때 엑셀이 다시 계산한다.

// 원본 시트(크롭 기준)에서 머리글·과목 영역·소계 영역이 차지하던 행 범위.
function planExportOriginalBounds(template) {
  const headerRows = template.header.rows.length;
  const footerSources = (template.footer.sources || []).filter((source) => Number.isInteger(source));
  const sources = [...(template.header.sources || []), ...footerSources].filter((source) => Number.isInteger(source));
  const footerStart = footerSources.length ? footerSources[0] : template.bodyEnd + 1;
  const last = sources.length ? Math.max(...sources, footerStart + template.footer.rows.length - 1) : template.bodyEnd + template.footer.rows.length;
  return { headerRows, bodyStart: headerRows, footerStart, last };
}

// 원본 행 번호(0부터, 시트 절대 위치)를 새 시트 행 번호로 옮긴다. 과목 영역 안의 범위는 새 과목 영역 전체가 된다.
function planExportRowMapper(bounds, offsetRow, newBodyStart, newFooterStart) {
  const delta = newFooterStart - bounds.footerStart;
  return (row, end) => {
    const local = row - offsetRow;
    if (local < bounds.bodyStart) return row;
    if (local >= bounds.footerStart) return row + delta;
    return offsetRow + (end ? newFooterStart - 1 : newBodyStart);
  };
}

function planExportShiftReferences(text, mapRow) {
  return String(text).split(/("(?:[^"]|"")*"|'(?:[^']|'')*'!)/).map((part) => /^["']/.test(part) ? part :
    part.replace(/(\$?[A-Z]{1,3})(\$?)(\d+)(?::(\$?[A-Z]{1,3})(\$?)(\d+))?/g, (match, c1, d1, r1, c2, d2, r2) => {
      if (c2 === undefined) return `${c1}${d1}${mapRow(Number(r1) - 1, false) + 1}`;
      return `${c1}${d1}${mapRow(Number(r1) - 1, false) + 1}:${c2}${d2}${mapRow(Number(r2) - 1, true) + 1}`;
    })).join("");
}

// 서식 있는 글자 조각 → <r><rPr>…</rPr><t>…</t></r>. inherit 조각은 칸 글꼴을 그대로 쓴다(rPr 없음).
function planExportRichRun(sheet, run) {
  const r = sheet.createElementNS(NS_MAIN, "r");
  if (!run.inherit) {
    const properties = sheet.createElementNS(NS_MAIN, "rPr");
    const add = (name, attributes = {}) => {
      const node = sheet.createElementNS(NS_MAIN, name);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      properties.appendChild(node);
    };
    if (run.b) add("b");
    if (run.i) add("i");
    if (run.s) add("strike");
    if (run.u) add("u");
    if (run.sz) add("sz", { val: run.sz });
    add("color", run.fc ? { rgb: `FF${String(run.fc).replace(/^#/, "")}` } : { theme: 1 });
    if (run.fn) add("rFont", { val: run.fn });
    r.appendChild(properties);
  }
  const t = sheet.createElementNS(NS_MAIN, "t");
  t.setAttribute("xml:space", "preserve");
  t.textContent = run.t;
  r.appendChild(t);
  return r;
}

function planExportWriteCell(sheet, cell, value, formula, runs = null) {
  for (const child of [...cell.children]) cell.removeChild(child);
  cell.removeAttribute("t");
  const text = String(value ?? "");
  if (formula) {
    const f = sheet.createElementNS(NS_MAIN, "f");
    f.textContent = formula;
    cell.appendChild(f);
    if (text !== "" && Number.isFinite(Number(text))) {
      const v = sheet.createElementNS(NS_MAIN, "v");
      v.textContent = String(Number(text));
      cell.appendChild(v);
    }
    return;
  }
  if (text.trim() === "") return;
  if (Number.isFinite(Number(text)) && !/^0\d/.test(text.trim())) {
    const v = sheet.createElementNS(NS_MAIN, "v");
    v.textContent = String(Number(text));
    cell.appendChild(v);
    return;
  }
  cell.setAttribute("t", "inlineStr");
  const is = sheet.createElementNS(NS_MAIN, "is");
  if (Array.isArray(runs) && runs.length && runs.map((run) => run.t).join("") === text) {
    for (const run of runs) is.appendChild(planExportRichRun(sheet, run));
    cell.appendChild(is);
    return;
  }
  const t = sheet.createElementNS(NS_MAIN, "t");
  t.setAttribute("xml:space", "preserve");
  t.textContent = text;
  is.appendChild(t);
  cell.appendChild(is);
}

// 내보낸 '택n\nm학점' 병합 칸은 줄바꿈·가운데 정렬로 보이게 원본 칸 서식을 복사한 서식(xf)을 하나 더 만든다.
function planExportWrapStyles(files, serializer) {
  const path = "xl/styles.xml";
  if (!files[path]) return { wrap: (index) => index, save() {} };
  const doc = parseXml(files[path], "서식");
  const cellXfs = doc.getElementsByTagNameNS(NS_MAIN, "cellXfs")[0];
  const cache = new Map();
  return {
    wrap(index) {
      const key = Number(index) || 0;
      if (!cellXfs) return index;
      if (cache.has(key)) return cache.get(key);
      const source = [...cellXfs.children][key];
      const xf = source ? source.cloneNode(true) : doc.createElementNS(NS_MAIN, "xf");
      if (!source) for (const [name, value] of [["numFmtId", "0"], ["fontId", "0"], ["fillId", "0"], ["borderId", "0"], ["xfId", "0"]]) xf.setAttribute(name, value);
      let alignment = [...xf.children].find((child) => child.localName === "alignment");
      if (!alignment) { alignment = doc.createElementNS(NS_MAIN, "alignment"); xf.insertBefore(alignment, xf.firstChild); }
      alignment.setAttribute("wrapText", "1");
      alignment.setAttribute("vertical", "center");
      if (!alignment.getAttribute("horizontal") || alignment.getAttribute("horizontal") === "general") alignment.setAttribute("horizontal", "center");
      xf.setAttribute("applyAlignment", "1");
      cellXfs.appendChild(xf);
      cellXfs.setAttribute("count", String(cellXfs.children.length));
      cache.set(key, cellXfs.children.length - 1);
      return cellXfs.children.length - 1;
    },
    save() { if (cache.size) files[path] = serializer.serializeToString(doc); }
  };
}

async function buildCurriculumDataWorkbook(sourceLayout) {
  if (!sourceLayout?.planData || !sourceLayout.planTemplate) throw new Error("편제표 데이터가 없습니다. 편제표를 다시 업로드하세요.");
  // 선택과목군은 학기 열에서 구성 과목 행 전체를 한 칸으로 병합해 '택n\nm학점'만 적는다(이수학점·소계 수식은 n × 학점을 더함).
  const layout = typeof curriculumExportLayout === "function" ? curriculumExportLayout(sourceLayout) : sourceLayout;
  // 울산 편제 점검 프로그램에서 불러온 편제표는 원본 양식이 없으므로 기본 양식(화면 표 그대로)으로 저장한다.
  if (layout.officeImport && typeof buildCurriculumBasicWorkbook === "function") return buildCurriculumBasicWorkbook(layout);
  // 원본 엑셀이 이 브라우저에 없으면(백업 복원·다른 PC: 원본은 백업에 넣지 않음) 기본 양식으로 저장하고 알린다.
  const fallback = () => {
    if (typeof buildCurriculumBasicWorkbook !== "function") throw new Error("저장된 원본 편제표가 없습니다. 다시 업로드하세요.");
    const blob = buildCurriculumBasicWorkbook(layout);
    blob.basicFallback = true;
    return blob;
  };
  if (!layout.archiveId || !layout.sheetPath) return fallback();
  const buffer = await curriculumArchiveStore("get", layout.archiveId);
  if (!buffer) return fallback();
  const directory = readZipDirectory(buffer), files = {};
  for (const name of directory.keys()) files[name] = await readZipEntry(buffer, directory, name);
  const sheet = parseXml(files[layout.sheetPath], "편제표");
  const wrapStyles = planExportWrapStyles(files, new XMLSerializer());
  const sheetData = sheet.getElementsByTagNameNS(NS_MAIN, "sheetData")[0];
  const template = layout.planTemplate;
  const meta = layout.planRowMeta || [];
  const offsetRow = layout.sourceRowOffset || 0, offsetColumn = layout.sourceColumnOffset || 0;
  const width = template.width;
  const bounds = planExportOriginalBounds(template);
  const newBodyStart = meta.findIndex((item) => item.type !== "header");
  const newFooterStart = meta.findIndex((item) => item.type === "footer");
  const footerAt = newFooterStart >= 0 ? newFooterStart : layout.rows.length;
  const mapRow = planExportRowMapper(bounds, offsetRow, newBodyStart >= 0 ? newBodyStart : bounds.bodyStart, footerAt);
  const delta = footerAt - bounds.footerStart;
  const originalLast = offsetRow + bounds.last; // 0부터 센 절대 행
  const inColumns = (column) => column >= offsetColumn && column < offsetColumn + width;
  const rowNumber = (node) => Number(node.getAttribute("r"));
  const originalRows = new Map([...sheetData.children].map((node) => [rowNumber(node), node]));
  const parsed = await parseWorkbook(buffer, { includeLayout: true });
  const original = parsed.find((item) => item.layout.sheetPath === layout.sheetPath);
  const originalValue = (row, column) => String(original?.rows?.[row]?.[column] ?? "");
  const originalFormula = (row, column) => original?.layout?.formulas?.[`${row}:${column}`];
  const hidden = new Set(layout.hiddenRows || []);
  // 병합 칸의 가려진 부분은 값을 비운다(서식은 남긴다).
  const covered = new Set();
  for (const reference of layout.mergedRanges || []) {
    const range = planDataRange(reference);
    if (!range) continue;
    for (let row = range.startRow; row <= range.endRow; row++) {
      for (let column = range.startColumn; column <= range.endColumn; column++) {
        if (row !== range.startRow || column !== range.startColumn) covered.add(`${row}:${column}`);
      }
    }
  }
  const usedSources = new Set();
  const subjectById = new Map((layout.planData.subjects || []).map((item) => [item.id, item]));

  // 1) 크롭 위쪽 행은 그대로, 2) 크롭 영역은 새 표로, 3) 크롭 아래 행은 늘어난 만큼 내린다.
  const above = [...sheetData.children].filter((node) => rowNumber(node) <= offsetRow);
  const below = [...sheetData.children].filter((node) => rowNumber(node) > originalLast + 1);
  for (const node of [...sheetData.children]) sheetData.removeChild(node);
  for (const node of above) sheetData.appendChild(node);
  layout.rows.forEach((values, index) => {
    const info = meta[index] || {};
    const source = Number.isInteger(info.source) ? info.source : null;
    const sourceNumber = source === null ? null : source + offsetRow + 1;
    const sourceNode = sourceNumber !== null ? originalRows.get(sourceNumber) : null;
    const firstUse = sourceNumber !== null && !usedSources.has(sourceNumber);
    if (sourceNumber !== null) usedSources.add(sourceNumber);
    const rowNode = sourceNode ? sourceNode.cloneNode(true) : sheet.createElementNS(NS_MAIN, "row");
    rowNode.removeAttribute("spans");
    const absolute = offsetRow + index + 1;
    rowNode.setAttribute("r", String(absolute));
    if (hidden.has(index)) rowNode.setAttribute("hidden", "1"); else rowNode.removeAttribute("hidden");
    const height = Number(layout.rowHeights?.[index]);
    if (!sourceNode && Number.isFinite(height) && height > 0) { rowNode.setAttribute("ht", String(height)); rowNode.setAttribute("customHeight", "1"); }
    const cells = new Map();
    for (const cell of [...rowNode.children]) {
      const column = columnIndex(cell.getAttribute("r"));
      if (!inColumns(column)) {
        // 표 밖 열의 값은 원본 행을 처음 쓸 때만 남긴다(복사한 행에 같은 메모가 되풀이되지 않게).
        if (!firstUse || info.type === "subject" && info.part > 0) rowNode.removeChild(cell);
        else cell.setAttribute("r", `${columnName(column)}${absolute}`);
        continue;
      }
      cell.setAttribute("r", `${columnName(column)}${absolute}`);
      cells.set(column, cell);
    }
    for (let local = 0; local < width; local++) {
      const column = local + offsetColumn;
      const hiddenByMerge = covered.has(`${index}:${local}`);
      const value = hiddenByMerge ? "" : String(values[local] ?? "");
      const formula = hiddenByMerge ? undefined : layout.formulas?.[`${index}:${local}`];
      let cell = cells.get(column);
      // 머리글·소계 행에서 값이 그대로인 칸은 원본 XML(서식 있는 글자 포함)을 그대로 둔다.
      const keepOriginal = info.type !== "subject" && cell && source !== null && formula === undefined &&
        originalFormula(source + offsetRow, column) === undefined && originalValue(source + offsetRow, column) === value;
      if (keepOriginal) continue;
      if (!cell) {
        if (!value.trim() && formula === undefined) continue;
        cell = sheet.createElementNS(NS_MAIN, "c");
        cell.setAttribute("r", `${columnName(column)}${absolute}`);
        const next = [...rowNode.children].find((node) => columnIndex(node.getAttribute("r")) > column) || null;
        rowNode.insertBefore(cell, next);
      }
      // 과목명 칸: 원본의 서식 있는 글자(일부 과목만 빨간 글씨 등)를 지금 과목명에 다시 입힌다.
      const subject = info.type === "subject" && info.part === 0 && local === template.columns.name ? subjectById.get(info.id) : null;
      let runs = subject && typeof planDataNameRuns === "function" ? planDataNameRuns(subject) : null;
      // 새로 넣은 과목 행은 이웃 행 서식을 복사하지만 글자색(변경 표시 빨간 글씨)은 물려받지 않는다: 글자 조각으로 검정 글꼴을 적는다.
      if (subject?.plainFont && value.trim()) {
        const font = (layout.styleTable || [])[layout.cellStyles?.[`${index}:${local}`]] || {};
        if (font.fc) runs = [{ t: value, ...(font.b ? { b: 1 } : {}), ...(font.i ? { i: 1 } : {}), ...(font.sz ? { sz: font.sz } : {}), ...(font.fn ? { fn: font.fn } : {}) }];
      }
      planExportWriteCell(sheet, cell, value, formula === undefined ? "" : shiftPlanFormula(formula, offsetRow, offsetColumn), runs);
      if (layout.wrapCells?.has(`${index}:${local}`)) cell.setAttribute("s", String(wrapStyles.wrap(cell.getAttribute("s"))));
    }
    sheetData.appendChild(rowNode);
  });
  for (const node of below) {
    const next = rowNumber(node) + delta;
    node.setAttribute("r", String(next));
    for (const cell of node.children) {
      cell.setAttribute("r", `${cell.getAttribute("r").replace(/\d+/g, "")}${next}`);
      const f = cell.getElementsByTagNameNS(NS_MAIN, "f")[0];
      if (f?.textContent) f.textContent = planExportShiftReferences(f.textContent, mapRow);
      if (f?.hasAttribute("ref")) f.setAttribute("ref", planExportShiftReferences(f.getAttribute("ref"), mapRow));
    }
    sheetData.appendChild(node);
  }
  for (const node of above) {
    for (const f of node.getElementsByTagNameNS(NS_MAIN, "f")) if (f.textContent) f.textContent = planExportShiftReferences(f.textContent, mapRow);
  }

  // 병합: 크롭 영역 안의 병합은 데이터로 다시 만든 병합으로 바꾸고, 아래쪽 병합은 내린다.
  let merges = sheet.getElementsByTagNameNS(NS_MAIN, "mergeCells")[0];
  if (!merges && layout.mergedRanges?.length) {
    merges = sheet.createElementNS(NS_MAIN, "mergeCells");
    const afterMerges = new Set(["phoneticPr", "conditionalFormatting", "dataValidations", "hyperlinks", "printOptions", "pageMargins",
      "pageSetup", "headerFooter", "rowBreaks", "colBreaks", "customProperties", "cellWatches", "ignoredErrors", "smartTags", "drawing",
      "legacyDrawing", "legacyDrawingHF", "picture", "oleObjects", "controls", "webPublishItems", "tableParts", "extLst"]);
    sheet.documentElement.insertBefore(merges, [...sheet.documentElement.children].find((node) => afterMerges.has(node.localName)) || null);
  }
  if (merges) {
    for (const merge of [...merges.children]) {
      const range = planDataRange(merge.getAttribute("ref"));
      if (!range) continue;
      const overlapsTable = range.startRow <= originalLast && range.endRow >= offsetRow &&
        range.startColumn < offsetColumn + width && range.endColumn >= offsetColumn;
      if (overlapsTable) merge.remove();
      else if (range.startRow > originalLast) merge.setAttribute("ref", planExportShiftReferences(merge.getAttribute("ref"), mapRow));
    }
    for (const reference of layout.mergedRanges || []) {
      const node = sheet.createElementNS(NS_MAIN, "mergeCell");
      node.setAttribute("ref", shiftPlanFormula(reference, offsetRow, offsetColumn));
      merges.appendChild(node);
    }
    if (merges.children.length) merges.setAttribute("count", String(merges.children.length));
    else merges.remove();
  }
  // 조건부 서식·데이터 유효성·인쇄 영역처럼 행을 가리키는 범위도 함께 옮긴다.
  for (const element of [...sheet.getElementsByTagNameNS(NS_MAIN, "conditionalFormatting"), ...sheet.getElementsByTagNameNS(NS_MAIN, "dataValidation")]) {
    if (element.hasAttribute("sqref")) {
      element.setAttribute("sqref", element.getAttribute("sqref").split(/\s+/).map((ref) => planExportShiftReferences(ref, mapRow)).join(" "));
    }
  }
  for (const element of sheet.getElementsByTagNameNS(NS_MAIN, "brk")) {
    const id = Number(element.getAttribute("id"));
    if (Number.isInteger(id) && element.parentNode?.localName === "rowBreaks") element.setAttribute("id", String(mapRow(id - 1, false) + 1));
  }
  const dimension = sheet.getElementsByTagNameNS(NS_MAIN, "dimension")[0];
  if (dimension) {
    const [start, end = start] = dimension.getAttribute("ref").split(":");
    const lastRow = Math.max(mapRow(Number(end.match(/\d+/)?.[0] || 1) - 1, true) + 1, offsetRow + layout.rows.length);
    dimension.setAttribute("ref", `${start}:${end.replace(/\d+/g, "")}${lastRow}`);
  }
  const serializer = new XMLSerializer();
  wrapStyles.save();
  files[layout.sheetPath] = serializer.serializeToString(sheet);

  const workbook = parseXml(files["xl/workbook.xml"], "통합 문서");
  const sheetName = layout.sheetName || "";
  for (const name of workbook.getElementsByTagNameNS(NS_MAIN, "definedName")) {
    const text = name.textContent || "";
    const quoted = `'${sheetName.replace(/'/g, "''")}'!`;
    if (!sheetName || !(text.includes(quoted) || text.includes(`${sheetName}!`))) continue;
    name.textContent = text.split(/(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)/).map((part, index) =>
      index % 2 ? planExportShiftReferences(part, mapRow) : part).join("");
  }
  let calc = workbook.getElementsByTagNameNS(NS_MAIN, "calcPr")[0];
  if (!calc) { calc = workbook.createElementNS(NS_MAIN, "calcPr"); workbook.documentElement.appendChild(calc); }
  calc.setAttribute("fullCalcOnLoad", "1");
  calc.setAttribute("forceFullCalc", "1");
  calc.setAttribute("calcMode", "auto");
  files["xl/workbook.xml"] = serializer.serializeToString(workbook);
  delete files["xl/calcChain.xml"];
  for (const name of ["xl/_rels/workbook.xml.rels", "[Content_Types].xml"]) {
    const doc = parseXml(files[name], name);
    for (const child of [...doc.documentElement.children]) {
      if ((child.getAttribute("Type") || "").endsWith("/calcChain") || child.getAttribute("PartName") === "/xl/calcChain.xml") child.remove();
    }
    files[name] = serializer.serializeToString(doc);
  }
  return createXlsxBlob(files);
}
