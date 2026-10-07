const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {test} = require("node:test");

test("plan cell mapping handles uncolored, merged and multi-subject cells without crossing semesters", () => {
  const source=fs.readFileSync(path.join(__dirname,"..","plan-groups.js"),"utf8");
  const contexts=[
    {rowIndex:1,subject:"A, B",division:"학생 선택 교육과정",row:["","","4","4"]},
    {rowIndex:2,subject:"C",division:"학생 선택 교육과정",row:["","","4",""]},
    {rowIndex:3,subject:"A",division:"학교 지정 교육과정",row:["","","4",""]},
    {rowIndex:4,subject:"B",division:"학생 선택 교육과정",row:["소인수","","4",""]},
    {rowIndex:5,subject:"D",division:"학생 선택 교육과정",row:["","","4","4"]},
  ];
  const ctx=vm.createContext({
    importedPlanColumnMap:()=>({semesters:[-1,-1,2,3,-1,-1]}),
    importedPlanCourseContexts:()=>contexts,
    columnIndex:(reference)=>reference.charCodeAt(0)-65,
  });
  vm.runInContext(source.slice(0,source.indexOf("(() => {")),ctx);
  const map=ctx.planGroupCellMap({mergedRanges:["C2:C3","C6:D6"]},{"2":[
    {subject:"A (1학기)",semester:"1"},{subject:"A (2학기)",semester:"2"},
    {subject:"B (1학기)",semester:"1"},{subject:"B (2학기)",semester:"2"},
    {subject:"C",semester:"1"},{subject:"D (1학기)",semester:"1"},{subject:"D (2학기)",semester:"2"},
  ],"3":[]});
  assert.deepEqual([...map.keys()],["1:2","1:3"]);
  assert.deepEqual([...map.get("1:2").courses],["A (1학기)","B (1학기)","C"]);
  assert.equal(map.get("1:2").semester,"1");
  assert.deepEqual([...map.get("1:3").courses],["A (2학기)","B (2학기)"]);
  assert.equal(map.get("1:3").semester,"2");
});
