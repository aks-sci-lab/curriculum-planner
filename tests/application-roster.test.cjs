// 웹 신청 명렬 로컬 저장(state.applicationRosters): 저장·다시 올리기 교체·읽기(applicationRosterFor)·복원 정리·예전 자료·백업·초기화·
// 저장소 조각, 서버로 보내는 자료는 그대로인지. 학생 자료는 합성(가명).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const client = fs.readFileSync(path.join(root, "supabase-client.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const between = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));

function context(year = "2026") {
  const state = { applicationMenuGrade: "2", applicationRosters: {} };
  let saves = 0;
  const ctx = vm.createContext({ state, console, $: (selector) => (selector === "#schoolYear" ? { value: year } : null), persistStateSoon: () => { saves += 1; } });
  vm.runInContext(between("function applicationRostersRestore(", "async function readApplicationRosterLocal("), ctx);
  return { ctx, state, saves: () => saves };
}

const roster = (grade, count, name = "가명") => Array.from({ length: count }, (_, i) => ({ grade, classroom: String(1 + (i % 3)), number: String(1 + Math.floor(i / 3)), name: `${name}${i + 1}` }));

test("저장: 현 학년 학생만(미제출 포함 전체), 학년도·학년별, 다시 올리면 교체, 읽기는 키 '현학년-반-번호'", () => {
  const { ctx, state, saves } = context();
  ctx.storeApplicationRoster([...roster("2", 9), ...roster("1", 2)], { grade: "2", source: "1차 웹 신청 생성" });
  assert.equal(saves(), 1);
  const saved = plain(state.applicationRosters["2026"]["2"]);
  assert.equal(saved.students.length, 9, "다른 학년 학생은 빼고 저장");
  assert.deepEqual(saved.students[0], { classroom: "1", number: "1", name: "가명1" });
  assert.equal(saved.source, "1차 웹 신청 생성");
  assert.ok(saved.uploadedAt);
  const read = plain(ctx.applicationRosterFor("2"));
  assert.equal(read.students.length, 9);
  assert.deepEqual(read.students[0], { key: "2-1-1", classroom: "1", number: "1", name: "가명1" });
  assert.equal(ctx.applicationRosterFor("1"), null, "올리지 않은 학년은 null");
  // 같은 학년을 다시 올리면 바꿈, 다른 학년은 그대로
  ctx.storeApplicationRoster(roster("1", 4), { grade: "1" });
  ctx.storeApplicationRoster(roster("2", 5, "새"), { grade: "2", source: "다시 올림" });
  assert.equal(ctx.applicationRosterFor("2").students.length, 5);
  assert.equal(ctx.applicationRosterFor("2").students[0].name, "새1");
  assert.equal(ctx.applicationRosterFor("1").students.length, 4);
  // 학년도가 다르면(앱 학년도 기준) 보이지 않음
  const other = context("2027");
  other.state.applicationRosters = state.applicationRosters;
  assert.equal(other.ctx.applicationRosterFor("2"), null);
});

test("복원: 예전 저장분·백업(없음) → 빈 객체, 모양이 틀린 값은 버림", () => {
  const { ctx } = context();
  assert.deepEqual(plain(ctx.applicationRostersRestore(undefined)), {});
  assert.deepEqual(plain(ctx.applicationRostersRestore([])), {});
  const restored = plain(ctx.applicationRostersRestore({ "2026": { "1": { students: [{ classroom: 3, number: 7, name: " 가명 " }, { classroom: "", number: "1" }, "x"], uploadedAt: "t" }, "3": { students: [] }, "2": { students: "x" } }, abc: {} }));
  assert.deepEqual(restored, { "2026": { "1": { students: [{ classroom: "3", number: "7", name: "가명" }], uploadedAt: "t", source: "" } } });
});

test("작업 자료·백업·복원·전체 초기화에 연결, 큰 명렬은 IndexedDB 조각(applicationRosters.학년도)", () => {
  assert.match(app, /applicationRosters: \{\},\n\s+courseChecks: \{\}/, "state 기본값");
  assert.match(between("function workspacePayload(", "function workspaceBackupCompact("), /applicationRosters: state\.applicationRosters,/, "작업 자료(백업·PC 파일·저장소)에 포함");
  assert.match(app, /state\.applicationRosters = typeof applicationRostersRestore === "function" \? applicationRostersRestore\(saved\.applicationRosters\) : \{\};/, "복원(예전 백업은 빈 값)");
  assert.match(app, /state\.classSections = \{\};\n\s+state\.applicationRosters = \{\};/, "전체 초기화 때 지움");
  // 저장소 조각: 2단계 경로 applicationRosters.2026 은 따로, 2,048자 넘으면 내용 해시 조각
  const storeSource = fs.readFileSync(path.join(root, "workspace-store.js"), "utf8");
  const store = vm.createContext({ Blob, Response, CompressionStream, DecompressionStream, setTimeout });
  vm.runInContext(storeSource, store);
  const { ctx } = context();
  ctx.storeApplicationRoster(roster("1", 330), { grade: "1" });
  const payload = { schemaVersion: 2, applicationRosters: plain(ctx.state.applicationRosters), rounds: { "1": null } };
  const split = store.workspaceStoreSplit(payload);
  assert.ok(!split.core.includes("가명1"), "성명 든 큰 명렬은 localStorage 작은 기록에 없음");
  assert.equal(store.workspaceStoreExpand(split.core, (hash) => split.blobs.get(hash)), JSON.stringify(payload), "조각에서 같은 자료로 복원");
});

test("서버로 보내는 것은 그대로: 생성 요청 setup 모양 불변, 로컬 저장은 생성 성공 뒤, 자동 테스트(가상 학생)는 저장 안 함, 다시 올리기는 로그인·서버 없이", () => {
  const createAt = client.indexOf('byId("cloudCreateEvent").addEventListener("click"');
  const create = client.slice(createAt, client.indexOf('byId("cloudCreateRetake").addEventListener', createAt));
  const rpcAt = create.indexOf('rpc("create_course_event", { p_setup: setup }, true)');
  const storeAt = create.indexOf("storeApplicationRoster(setup.roster");
  assert.ok(rpcAt > 0 && storeAt > rpcAt, "서버 생성이 성공한 뒤에만 이 PC에 저장");
  const setupFn = client.slice(client.indexOf("function applicationSetup("), createAt);
  assert.doesNotMatch(setupFn, /applicationRoster|uploadedAt/, "서버로 보내는 setup에 새 값 없음");
  assert.equal((client.match(/storeApplicationRoster\(/g) || []).length, 1, "웹 신청 생성 한 곳에서만 저장(자동 테스트 가상 학생은 저장 안 함)");
  const local = between("async function importApplicationRosterFile(", "function downloadTextFile(");
  assert.doesNotMatch(local, /rpc\(|fetch\(|supabase/i, "다시 올리기는 서버 요청 없음");
  assert.match(html, /<input class="hidden" id="cloudRosterLocalInput" type="file" accept="\.xlsx" aria-label="명렬 올리기\(이 PC에만 저장 · 담임반 현황 미제출 확인용\)">/);
  // 로그인 카드(#supabaseTeacherPanel) 밖, 학년 탭 작업 영역 안(로그인 없이 보임)
  const input = html.indexOf('id="cloudRosterLocalInput"');
  assert.ok(input > html.indexOf('id="applicationGradeWorkspace"') && input < html.indexOf('id="supabaseTeacherPanel"'), "로그인 없이 보이는 곳");
  assert.match(html, /id="cloudRosterLocalSummary"/);
  assert.match(app, /\$\("#cloudRosterLocalInput"\)\?\.addEventListener\("change"/);
  // 서버 SQL은 바꾸지 않음
  const { execSync } = require("node:child_process");
  let changed = "";
  try { changed = execSync("git diff --name-only HEAD -- supabase", { cwd: root, encoding: "utf8" }); } catch { changed = ""; }
  assert.equal(changed.trim(), "");
});

test("importApplicationRosterFile(file, 현학년): 같은 명렬 양식으로 읽어 저장하고 { count, message }, 오류도 message로", async () => {
  const state = { applicationMenuGrade: "1", applicationRosters: {} };
  const sheets = [{ name: "명렬", rows: [["학년", "반", "번호", "성명"], ["2", "1", "1", "가명1"], ["2", "1", "2", "가명2"], ["2", "2", "1", "가명3"]] }];
  const ctx = vm.createContext({ state, console, $: (selector) => (selector === "#schoolYear" ? { value: "2026" } : null), persistStateSoon: () => {},
    parseWorkbook: async () => sheets });
  vm.runInContext(between("function parseApplicationRoster(", "async function readApplicationRosterLocal("), ctx);
  const file = (name) => ({ name, arrayBuffer: async () => new ArrayBuffer(1) });
  const ok = plain(await ctx.importApplicationRosterFile(file("명렬.xlsx"), "2"));
  assert.deepEqual(ok, { count: 3, message: "현 2학년 명렬 3명을 이 PC에 저장했습니다(서버 변경 없음)." });
  assert.equal(ctx.applicationRosterFor("2").students.length, 3);
  assert.equal(ctx.applicationRosterFor("2").source, "명렬.xlsx(명렬 올리기)");
  const wrong = plain(await ctx.importApplicationRosterFile(file("명렬.xlsx"), "1"));
  assert.equal(wrong.count, 0);
  assert.match(wrong.message, /^명렬을 저장하지 못했습니다: 2학년 수강신청에는 현재 1학년 명렬만/);
  assert.match((await ctx.importApplicationRosterFile(file("명렬.csv"), "2")).message, /\.xlsx 형식/);
  assert.match((await ctx.importApplicationRosterFile(null, "2")).message, /명렬 파일을 고르세요/);
  assert.equal(ctx.applicationRosterFor("1"), null, "실패하면 저장하지 않음");
});
