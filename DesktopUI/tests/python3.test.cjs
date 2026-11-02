const {test}=require("node:test"),assert=require("node:assert/strict");
const {findPython3,runPython3}=require("./fixtures/python3.cjs");
test("test interpreter rejects Python 2, validates an explicit path and executes UTF-8",()=>{
  assert.throws(()=>findPython3(()=>({status:0,stdout:"2\n"}),"old-python"),/Python 3/);
  assert.deepEqual(findPython3(()=>({status:0,stdout:"3\n"}),"configured-python"),{command:"configured-python",prefix:[]});
  const r=runPython3(["-"],{input:"import sys\nassert sys.version_info[0] == 3\nassert len('地图') == 2\nprint('ok')"});
  assert.equal(r.status,0,r.stderr); assert.equal(r.stdout.trim(),"ok");
});
