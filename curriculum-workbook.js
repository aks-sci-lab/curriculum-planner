"use strict";

function shiftPlanFormula(formula, rowDelta, columnDelta = 0, insertionRow = null, relativeOnly = false) {
  return formula.split(/("(?:[^"]|"")*")/).map((part) => part.startsWith('"') ? part :
    part.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (ref, dollarColumn, letters, dollarRow, digits) => {
    const row = Number(digits) - 1;
    if (insertionRow !== null && row < insertionRow) return ref;
    const column = columnIndex(letters) + (relativeOnly && dollarColumn ? 0 : columnDelta);
    const nextRow = row + (relativeOnly && dollarRow ? 0 : rowDelta);
    if(column<0 || nextRow<0)return "#REF!";
    return `${dollarColumn}${columnName(column)}${dollarRow}${nextRow + 1}`;
  })).join("");
}

function recalculatePlanFormulas(layout) {
  const formulas = layout.formulas || {};
  const covered = typeof importedPlanCoveredCells === "function" ? importedPlanCoveredCells(layout) : new Set();
  const computed = new Map(), visiting = new Set();
  function cellValue(row, column) {
    const key = `${row}:${column}`;
    if (covered.has(key)) return 0;
    if (computed.has(key)) return computed.get(key);
    if (visiting.has(key)) throw new Error("순환 참조 수식이 있습니다.");
    if (!Object.hasOwn(formulas, key)) {
      const value = String(layout.rows[row]?.[column] ?? "").replace(/,/g, "").trim();
      return value !== "" && Number.isFinite(Number(value)) ? Number(value) : 0;
    }
    visiting.add(key);
    let expression = formulas[key].replace(/^=/, "").toUpperCase();
    if (expression.includes("!") || /\b(?:IF|ROUND|SUBTOTAL|SUMIF|AVERAGE)\s*\(/.test(expression)) {
      throw new Error(`${columnName(column)}${row+1}: 지원하지 않는 소계 수식입니다 (${formulas[key]}).`);
    }
    const sumRange = (range) => {
      const [a, b = a] = range.trim().split(":");
      if (!/^\$?[A-Z]+\$?\d+$/.test(a) || !/^\$?[A-Z]+\$?\d+$/.test(b)) {
        if (Number.isFinite(Number(range))) return Number(range);
        throw new Error(`SUM 범위를 확인하세요: ${range}`);
      }
      const r1 = Number(a.match(/\d+/)[0])-1, r2 = Number(b.match(/\d+/)[0])-1;
      const c1 = columnIndex(a.replace(/\$/g, "")), c2 = columnIndex(b.replace(/\$/g, ""));
      let total = 0;
      for (let r=r1; r<=r2; r++) for (let c=c1; c<=c2; c++) total += cellValue(r,c);
      return total;
    };
    expression = expression.replace(/SUM\(([^()]*)\)/g, (_, args) =>
      String(args.split(/[,;]/).reduce((total, arg) => total + sumRange(arg), 0)));
    expression = expression.replace(/\$?[A-Z]+\$?\d+/g, (ref) =>
      String(cellValue(Number(ref.match(/\d+/)[0])-1, columnIndex(ref.replace(/\$/g, "")))));
    const tokens = expression.match(/\d+(?:\.\d+)?|[()+\-*/]/g) || [];
    if (tokens.join("") !== expression.replace(/\s/g, "")) throw new Error(`지원하지 않는 수식: ${formulas[key]}`);
    let index = 0;
    function factor() {
      const token = tokens[index++];
      if (token === "+" || token === "-") return (token === "-" ? -1 : 1)*factor();
      if (token === "(") { const value=add(); if(tokens[index++]!==")") throw new Error("수식 괄호 오류"); return value; }
      if (!token || !/^\d/.test(token)) throw new Error("수식 숫자 오류");
      return Number(token);
    }
    function multiply() { let value=factor(); while(["*","/"].includes(tokens[index])) {const op=tokens[index++],right=factor();value=op==="*"?value*right:value/right;} return value; }
    function add() { let value=multiply(); while(["+","-"].includes(tokens[index])) {const op=tokens[index++],right=multiply();value=op==="+"?value+right:value-right;} return value; }
    const value=add();
    if(index!==tokens.length || !Number.isFinite(value)) throw new Error("소계 수식 계산 오류");
    visiting.delete(key); computed.set(key,value); return value;
  }
  for (const key of Object.keys(formulas)) { const [r,c]=key.split(":").map(Number);cellValue(r,c); }
  for (const [key,value] of computed) {const [r,c]=key.split(":").map(Number); layout.rows[r][c]=String(value);}
}

function insertPlanFormulaRow(previous, next, row) {
  next.rowInsertions = [...(previous.rowInsertions || []), row];
  next.formulas = Object.fromEntries(Object.entries(previous.formulas || {}).map(([key, formula]) => {
    const [r,c]=key.split(":").map(Number);
    return [`${r>=row?r+1:r}:${c}`, shiftPlanFormula(formula, 1, 0, row)];
  }));
}

async function curriculumArchiveStore(operation, id, buffer) {
  const db = await new Promise((resolve, reject) => {
    const request=indexedDB.open("curriculum-original-workbooks",1);
    request.onupgradeneeded=()=>request.result.createObjectStore("archives");
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(new Error("원본 편제표 저장소를 열지 못했습니다."));
  });
  try {
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction("archives",operation==="get"?"readonly":"readwrite");
      const store=tx.objectStore("archives");
      const request=operation==="get"?store.get(id):store.put(buffer,id);
      tx.oncomplete=()=>resolve(request.result);
      tx.onerror=()=>reject(new Error("원본 편제표를 저장하거나 읽지 못했습니다."));
      tx.onabort=()=>reject(new Error("원본 편제표 저장이 중단되었습니다."));
    });
  } finally { db.close(); }
}
async function storeCurriculumArchive(buffer) {
  const id=crypto.randomUUID();
  await curriculumArchiveStore("put",id,buffer);
  return id;
}
async function storeCurriculumLayout(layout) {
  if (!layout?.archiveId || !Array.isArray(layout.rows)) {
    throw new Error("편제표 저장 데이터가 올바르지 않습니다.");
  }
  await curriculumArchiveStore("put",`layout:${layout.archiveId}`,layout);
}
async function loadCurriculumLayout(id) {
  if (!id) return null;
  return await curriculumArchiveStore("get",`layout:${id}`) || null;
}

async function buildOriginalCurriculumWorkbook(layout) {
  if (!layout?.archiveId || !layout.sheetPath) throw new Error("원본 양식을 보존하려면 편제표를 다시 업로드하세요.");
  const buffer=await curriculumArchiveStore("get",layout.archiveId);
  if(!buffer) throw new Error("저장된 원본 편제표가 없습니다. 다시 업로드하세요.");
  const directory=readZipDirectory(buffer), files={};
  for(const name of directory.keys()) files[name]=await readZipEntry(buffer,directory,name);
  const sheet=parseXml(files[layout.sheetPath],"편제표");
  const sheetData=sheet.getElementsByTagNameNS(NS_MAIN,"sheetData")[0];
  const offsetRow=layout.sourceRowOffset || 0, offsetColumn=layout.sourceColumnOffset || 0;
  const serializer=new XMLSerializer();
  function shiftSheetRow(at) {
    for(const row of [...sheetData.children].reverse()) {
      const r=Number(row.getAttribute("r"));
      if(r>=at+1) {row.setAttribute("r",String(r+1)); for(const cell of row.children)cell.setAttribute("r",shiftPlanFormula(cell.getAttribute("r"),1,0,at));}
    }
    for(const f of sheet.getElementsByTagNameNS(NS_MAIN,"f")) f.textContent=shiftPlanFormula(f.textContent,1,0,at);
    for(const element of sheet.querySelectorAll("[ref], [sqref]")) {
      for(const attr of ["ref","sqref"])if(element.hasAttribute(attr))element.setAttribute(attr,shiftPlanFormula(element.getAttribute(attr),1,0,at));
    }
    const template=[...sheetData.children].find((row)=>Number(row.getAttribute("r"))===at);
    const inserted=template?template.cloneNode(true):sheet.createElementNS(NS_MAIN,"row");
    inserted.setAttribute("r",String(at+1));
    for(const cell of [...inserted.children]) {
      cell.setAttribute("r",`${cell.getAttribute("r").replace(/\d+/g,"")}${at+1}`);
      cell.removeAttribute("t");
      for(const child of [...cell.children])cell.removeChild(child);
    }
    const following=[...sheetData.children].find((row)=>Number(row.getAttribute("r"))>at+1);
    sheetData.insertBefore(inserted,following || null);
  }
  for(const row of layout.rowInsertions || [])shiftSheetRow(row+offsetRow);
  const covered=importedPlanCoveredCells(layout);
  const sourceValues=new Map();
  // Unchanged cells keep their original XML, including rich text and formula caches.
  const parsed=await parseWorkbook(buffer,{includeLayout:true});
  const original=parsed.find((s)=>s.layout.sheetPath===layout.sheetPath);
  let rowSources=Array.from({length:layout.originalRowCount},(_,i)=>i+offsetRow);
  for(const row of layout.rowInsertions || [])rowSources.splice(row,0,null);
  for(let r=0;r<layout.rows.length;r++)for(let c=0;c<layout.rows[r].length;c++){
    if(covered.has(`${r}:${c}`))continue;
    const value=String(layout.rows[r][c] ?? ""), sourceRow=rowSources[r];
    const old=sourceRow===null?"":String(original.rows[sourceRow]?.[c+offsetColumn] ?? "");
    const originalFormula = sourceRow === null ? null : original.layout.formulas?.[`${sourceRow}:${c+offsetColumn}`];
    if(value===old && !Object.hasOwn(layout.formulas || {}, `${r}:${c}`) && !originalFormula)continue;
    const ref=`${columnName(c+offsetColumn)}${r+offsetRow+1}`;
    let formula=layout.formulas?.[`${r}:${c}`];
    if(formula !== undefined) {
      if(originalFormula !== undefined) {
        formula=originalFormula;
        for(const insertedRow of layout.rowInsertions || [])formula=shiftPlanFormula(formula,1,0,insertedRow+offsetRow);
      } else formula=shiftPlanFormula(formula,offsetRow,offsetColumn);
    }
    sourceValues.set(ref,{value,formula});
  }
  for(const [ref,{value,formula}] of sourceValues){
    const rowNumber=Number(ref.match(/\d+/)[0]);
    let row=[...sheetData.children].find((node)=>Number(node.getAttribute("r"))===rowNumber);
    if(!row){row=sheet.createElementNS(NS_MAIN,"row");row.setAttribute("r",String(rowNumber));sheetData.insertBefore(row,[...sheetData.children].find((n)=>Number(n.getAttribute("r"))>rowNumber)||null);}
    let cell=[...row.children].find((node)=>node.getAttribute("r")===ref);
    if(!cell){cell=sheet.createElementNS(NS_MAIN,"c");cell.setAttribute("r",ref);row.insertBefore(cell,[...row.children].find((node)=>columnIndex(node.getAttribute("r"))>columnIndex(ref))||null);}
    for(const child of [...cell.children])cell.removeChild(child);
    cell.removeAttribute("t");
    if(formula){const f=sheet.createElementNS(NS_MAIN,"f");f.textContent=formula;cell.appendChild(f);}
    if(formula || value.trim()!=="" && Number.isFinite(Number(value))) {
      const v=sheet.createElementNS(NS_MAIN,"v");v.textContent=formula?value:String(Number(value));cell.appendChild(v);
    }else{
      cell.setAttribute("t","inlineStr");const is=sheet.createElementNS(NS_MAIN,"is"),text=sheet.createElementNS(NS_MAIN,"t");
      text.setAttribute("xml:space","preserve");text.textContent=value;is.appendChild(text);cell.appendChild(is);
    }
  }
  const merges=sheet.getElementsByTagNameNS(NS_MAIN,"mergeCells")[0];
  if(merges){
    for(const merge of [...merges.children]){
      const ref=merge.getAttribute("ref"), start=ref.split(":")[0],r=Number(start.match(/\d+/)[0])-1,c=columnIndex(start);
      if(r>=offsetRow && r<offsetRow+layout.rows.length && c>=offsetColumn && c<offsetColumn+(layout.columnWidths?.length || layout.rows[0].length))merge.remove();
    }
    for(const ref of layout.mergedRanges || []){const node=sheet.createElementNS(NS_MAIN,"mergeCell");node.setAttribute("ref",shiftPlanFormula(ref,offsetRow,offsetColumn));merges.appendChild(node);}
    merges.setAttribute("count",String(merges.children.length));
  }
  files[layout.sheetPath]=serializer.serializeToString(sheet);
  const workbook=parseXml(files["xl/workbook.xml"],"통합 문서");
  let calc=workbook.getElementsByTagNameNS(NS_MAIN,"calcPr")[0];
  if(!calc){calc=workbook.createElementNS(NS_MAIN,"calcPr");workbook.documentElement.appendChild(calc);}
  calc.setAttribute("fullCalcOnLoad","1");calc.setAttribute("forceFullCalc","1");calc.setAttribute("calcMode","auto");
  files["xl/workbook.xml"]=serializer.serializeToString(workbook);
  delete files["xl/calcChain.xml"];
  for(const name of ["xl/_rels/workbook.xml.rels","[Content_Types].xml"]){
    const doc=parseXml(files[name],name);
    for(const child of [...doc.documentElement.children])if((child.getAttribute("Type")||"").endsWith("/calcChain") || child.getAttribute("PartName")==="/xl/calcChain.xml")child.remove();
    files[name]=serializer.serializeToString(doc);
  }
  return createXlsxBlob(files);
}

document.getElementById("exportCurriculumPlan").addEventListener("click",async()=>{
  if(typeof requireTeacherLogin!=="function" || !requireTeacherLogin())return;
  const button=document.getElementById("exportCurriculumPlan");button.disabled=true;
  try{
    const blob=await buildOriginalCurriculumWorkbook(state.curriculumImportedLayout);
    if(!requireTeacherLogin())throw new Error("로그인이 만료되었습니다. 다시 로그인하세요.");
    const url=URL.createObjectURL(blob),link=document.createElement("a");
    link.href=url;link.download=state.curriculumPlanFileName.replace(/\.xlsx$/i,"_수정.xlsx");
    link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    status.textContent="원본 양식을 유지한 편제표 엑셀을 저장했습니다.";
  }catch(error){status.textContent=`편제표 내보내기 실패: ${error.message}`;}
  finally{button.disabled=false;}
});
