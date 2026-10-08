const assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
const {test}=require("node:test");
const source=fs.readFileSync(path.join(__dirname,"..","curriculum-workbook.js"),"utf8");
function context(){
  const ctx=vm.createContext({
    columnIndex:(ref)=>[...ref.replace(/\$/g,"").match(/^[A-Z]+/)[0]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1,
    columnName:(index)=>{let text="";for(let n=index+1;n>0;n=Math.floor((n-1)/26))text=String.fromCharCode(65+(n-1)%26)+text;return text;}
  });
  vm.runInContext(source.slice(0,source.indexOf('document.getElementById("exportCurriculumPlan")')),ctx);
  return ctx;
}
test("numeric edits recalculate SUM ranges, references and dependent subtotals",()=>{
  const ctx=context(),layout={rows:[["2","3"],["4","5"],["0","0"],["0"]],
    formulas:{"2:0":"SUM(A1:B2)","2:1":"A3*2","3:0":"SUM(A1,A2,A3)"}};
  ctx.recalculatePlanFormulas(layout);
  assert.equal(layout.rows[2][0],"14");assert.equal(layout.rows[2][1],"28");assert.equal(layout.rows[3][0],"20");
  layout.rows[0][0]="7";ctx.recalculatePlanFormulas(layout);
  assert.equal(layout.rows[2][0],"19");assert.equal(layout.rows[3][0],"30");
});
test("inserted rows shift formula anchors and ranges and preserve absolute references",()=>{
  const ctx=context();
  const before={formulas:{"3:1":"SUM($A$1:A3)"},rowInsertions:[]},next={};
  ctx.insertPlanFormulaRow(before,next,1);
  assert.equal(next.formulas["4:1"],"SUM($A$1:A4)");
  assert.deepEqual([...next.rowInsertions],[1]);
  assert.equal(ctx.shiftPlanFormula("SUM(G5:G73)",-2,-1),"SUM(F3:F71)");
  assert.equal(ctx.shiftPlanFormula("SUM($A$1:B2)",2,1,null,true),"SUM($A$1:C4)");
});
test("merged-cell copies are not double counted in subtotals",()=>{
  const ctx=context();
  ctx.importedPlanCoveredCells=()=>new Set(["1:0"]);
  const layout={rows:[["4"],["4"],["0"]],formulas:{"2:0":"SUM(A1:A2)"}};
  ctx.recalculatePlanFormulas(layout);
  assert.equal(layout.rows[2][0],"4");
});
test("unsupported or circular formulas surface explicit errors without changing cached totals",()=>{
  const ctx=context(),layout={rows:[["3"],["7"]],formulas:{"1:0":"IF(A1>0,7,0)"}};
  assert.throws(()=>ctx.recalculatePlanFormulas(layout),/지원하지 않는/);
  assert.equal(layout.rows[1][0],"7");
  assert.throws(()=>ctx.recalculatePlanFormulas({rows:[["0"]],formulas:{"0:0":"SUM(A1:A1)"}}),/순환 참조/);
});
