const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const context = vm.createContext({});
vm.runInContext(source.slice(source.indexOf("    function allocateAggregateClasses("),
  source.indexOf("    function currentStudent(")), context);
function allocate(enrollments, target) {
  return context.allocateAggregateClasses({reports:[{semesters:[{name:"2학년 1학기",groups:[{
    category:"선택군",choiceCount:1,totalClasses:target,
    courses:enrollments.map((enrollment,i)=>({enrollment,classOverrideKey:`1:${i}:1:group`}))
  }]}]}]});
}
test("proportional allocation exactly matches planned totals including the reported 338-student examples", () => {
  for (const [enrollments,target,expected] of [
    [[60,86,162,190,124,175,173,44],33,[2,3,5,6,4,6,6,1]],
    [[238,100],11,[8,3]],
    [[0,100],11,[0,11]],
    [[1,999],11,[1,10]],
    [[1,1,1],2,[1,1,0]],
    [[0,0],0,[0,0]],
  ]) {
    const values = Object.values(allocate(enrollments,target).overrides);
    assert.deepEqual(values,expected);
    assert.equal(values.reduce((sum,value)=>sum+value,0),target);
    assert.ok(values.every(Number.isInteger));
  }
});
test("invalid and empty allocation groups surface errors without mutating source data", () => {
  assert.throws(()=>allocate([0,0],11),/신청 인원이 없어/);
  assert.throws(()=>allocate([10],1.5),/정수/);
  assert.throws(()=>context.allocateAggregateClasses({reports:[]}),/조정할 선택군/);
});
test("allocation totals remain exact over varying enrollments and targets", () => {
  for (let target=0;target<=50;target++) {
    for (let count=1;count<=12;count++) {
      const enrollments=Array.from({length:count},(_,i)=>(i*17+target)%39+1);
      const values=Object.values(allocate(enrollments,target).overrides);
      assert.equal(values.reduce((sum,value)=>sum+value,0),target);
      assert.ok(values.every((value)=>value>=0 && Number.isInteger(value)));
      if(target>=count) assert.ok(values.every((value)=>value>=1));
    }
  }
});
