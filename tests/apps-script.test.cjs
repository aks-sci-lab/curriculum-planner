const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// apps-script/Code.gs(구글 스프레드시트 + Apps Script 저장소 시제품)를 Node vm에 올리고
// SpreadsheetApp·LockService·PropertiesService·CacheService·ContentService·Utilities를 흉내 내 확인한다. 실제 구글 요청 없음.
const source = fs.readFileSync(path.join(__dirname, "..", "apps-script", "Code.gs"), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function environment({ cacheLimit = 1000 } = {}) {
  const stats = { sheetReads: 0, rowsRead: 0, appends: 0, cellWrites: 0, lockTries: 0, lockHeld: false, lockBusy: false, beforeLock: null, alerts: [], formats: [] };
  const sheets = new Map();
  // 실제 시트처럼 글자를 바꾼다: 숫자처럼 보이는 글자 → 숫자(앞의 0이 사라짐), '='로 시작 → 수식(값이 아님).
  const stored = (value) => {
    if (typeof value !== "string") return value;
    if (value.startsWith("=")) return "#수식";
    return value !== "" && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(value.trim()) ? Number(value) : value;
  };
  const makeSheet = (name) => {
    const rows = [];
    const sheet = {
      name, rows,
      getLastRow: () => rows.length,
      getMaxRows: () => 1000,
      appendRow: (row) => { stats.appends += 1; rows.push(row.map(stored)); },
      getRange: (row, column, count = 1, width = 1) => ({
        getValues: () => { stats.sheetReads += 1; stats.rowsRead += count; return Array.from({ length: count }, (_, r) => Array.from({ length: width }, (_, c) => rows[row - 1 + r]?.[column - 1 + c] ?? "")); },
        setValues: (values) => { stats.cellWrites += 1; assert.equal(values.length, count); values.forEach((line, r) => { assert.equal(line.length, width); rows[row - 1 + r] ||= []; line.forEach((value, c) => { rows[row - 1 + r][column - 1 + c] = stored(value); }); }); },
        setNumberFormat: (format) => { stats.formats.push(`${name}:${column}:${format}`); },
      }),
    };
    return sheet;
  };
  const book = {
    getSheetByName: (name) => sheets.get(name) || null,
    insertSheet: (name) => { assert.ok(!sheets.has(name), name); const sheet = makeSheet(name); sheets.set(name, sheet); return sheet; },
  };
  const properties = new Map();
  const cache = new Map();
  const ui = { ButtonSet: { YES_NO: "YES_NO" }, Button: { YES: "YES", NO: "NO" }, alert: (text) => { stats.alerts.push(text); return "YES"; },
    createMenu: () => ({ addItem() { return this; }, addToUi() {} }) };
  let uuid = 0;
  const ctx = vm.createContext({
    SpreadsheetApp: { getActiveSpreadsheet: () => book, getUi: () => ui },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key) => { stats.propertyReads = (stats.propertyReads || 0) + 1; return properties.has(key) ? properties.get(key) : null; },
      setProperty: (key, value) => { assert.ok(String(value).length <= 9000, "속성 값 9KB 한도"); properties.set(key, String(value)); },
      getProperties: () => { stats.propertyReads = (stats.propertyReads || 0) + 1; return Object.fromEntries(properties); },
      setProperties: (values) => { for (const [key, value] of Object.entries(values)) { assert.ok(String(value).length <= 9000, "속성 값 9KB 한도"); properties.set(key, String(value)); } },
    }) },
    // 실제 캐시처럼 항목 수 상한이 있고, 넘으면 임의의 항목을 지운다(만료 전에도 사라질 수 있다).
    CacheService: { getScriptCache: () => {
      const trim = () => { while (cache.size > cacheLimit) cache.delete([...cache.keys()][Math.floor(cache.size / 2)]); };
      return {
        get: (key) => cache.has(key) ? cache.get(key) : null,
        put: (key, value) => { assert.ok(String(value).length <= 100000); cache.set(key, String(value)); trim(); },
        putAll: (values) => { for (const [key, value] of Object.entries(values)) cache.set(key, String(value)); trim(); },
        getAll: (keys) => Object.fromEntries(keys.filter((key) => cache.has(key)).map((key) => [key, cache.get(key)])),
      };
    } },
    LockService: { getScriptLock: () => ({
      // beforeLock: 잠금을 기다리는 사이 다른 요청이 먼저 끝난 상황을 흉내 낸다(한 번만 실행).
      tryLock: () => { stats.lockTries += 1; if (stats.lockBusy || stats.lockHeld) return false;
        if (stats.beforeLock) { const hook = stats.beforeLock; stats.beforeLock = null; hook(); }
        stats.lockHeld = true; return true; },
      releaseLock: () => { stats.lockHeld = false; },
    }) },
    ContentService: { MimeType: { JSON: "application/json" }, createTextOutput: (text) => ({ text, mime: "", setMimeType(mime) { this.mime = mime; return this; }, getContent() { return this.text; } }) },
    Utilities: { DigestAlgorithm: { SHA_256: "sha256" }, Charset: { UTF_8: "utf8" },
      computeDigest: (algorithm, text) => [...crypto.createHash("sha256").update(String(text), "utf8").digest()].map((byte) => byte > 127 ? byte - 256 : byte),
      getUuid: () => { uuid += 1; return crypto.createHash("md5").update(`uuid-${uuid}`).digest("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5"); } },
  });
  vm.runInContext(source, ctx);
  let clock = Date.UTC(2026, 10, 14);
  vm.runInContext("CLOCK_ = function () { return __clock(); }", Object.assign(ctx, { __clock: () => clock }));
  const call = (body) => {
    const output = ctx.doPost({ postData: { contents: typeof body === "string" ? body : JSON.stringify(body) } });
    assert.equal(output.mime, "application/json");
    assert.equal(stats.lockHeld, false, "요청이 끝나면 잠금이 풀려 있어야 한다");
    return JSON.parse(output.getContent());
  };
  ctx.installAdminKey();
  const adminKey = properties.get("adminKey");
  return { ctx, call, stats, sheets, properties, cache, adminKey, advance: (ms) => { clock += ms; }, clearCache: () => cache.clear() };
}

function setupJson({ roster, year = "2026" } = {}) {
  const subjects2 = ["대수", "영어Ⅰ", "물리학", "화학", "심화 영어 (1학기)", "심화 영어 (2학기)"].map((subject) => ({ subject, credit: 4, semester: /2학기/.test(subject) ? "2" : "1" }));
  const subjects3 = ["확률과 통계", "세계사"].map((subject) => ({ subject, credit: 4, semester: "1" }));
  return {
    type: "course-application-setup", schoolName: "가상고등학교", schoolYear: year, round: "1",
    subjects: { "2": subjects2, "3": subjects3 },
    groups: [
      { id: "g1", grade: "2", semester: "1", name: "2학년 1학기 택2", count: 2, courses: ["대수", "영어Ⅰ", "물리학", "심화 영어 (1학기)"] },
      { id: "g2", grade: "2", semester: "2", name: "2학년 2학기 택1", count: 1, courses: ["화학", "심화 영어 (2학기)"] },
      { id: "g3", grade: "3", semester: "1", name: "3학년 1학기 택1", count: 1, courses: ["확률과 통계", "세계사"] },
    ],
    roster: roster || [1, 2, 3, 4].map((n) => ({ grade: "1", classroom: "1", number: String(n), name: `가상학생${n}`, studentId: `101${n}` })),
  };
}

// 신청을 만들고 학생 n번이 코드를 바꾼 상태까지.
function ready(env, options) {
  const created = env.call({ action: "setup", adminKey: env.adminKey, setup: setupJson(options) });
  assert.ok(created.id, JSON.stringify(created));
  const student = (n, grade = "1") => {
    const code = created.codes.find((item) => item.number === String(n) && item.grade === grade);
    return { event: created.id, classroom: code.classroom, number: code.number, code: code.code };
  };
  const changed = (n, grade = "1") => {
    const who = student(n, grade);
    const next = "482913";
    assert.match(env.call({ action: "changeCode", ...who, newCode: next }).message, /코드를 변경했습니다/);
    return { ...who, code: next };
  };
  return { created, student, changed };
}

test("ping · 알 수 없는 요청 · 잘못된 본문은 JSON 오류로 답한다", () => {
  const env = environment();
  assert.equal(env.call({ action: "ping" }).ok, true);
  assert.match(env.call({ action: "nope" }).error, /알 수 없는 요청/);
  assert.ok(env.call("{not json").error);
  assert.equal(JSON.parse(env.ctx.doGet().getContent()).ok, true);
});

test("관리 열쇠가 없거나 틀리면 교사 동작을 거절한다", () => {
  const env = environment();
  for (const action of ["setup", "results", "close"]) {
    assert.match(env.call({ action, setup: setupJson() }).error, /관리 열쇠가 맞지 않습니다/);
    assert.match(env.call({ action, adminKey: "wrong", setup: setupJson() }).error, /관리 열쇠가 맞지 않습니다/);
  }
  assert.equal(env.sheets.size, 0, "거절된 요청은 시트를 만들지 않는다");
  // 열쇠는 스크립트 속성에만 있고 응답에 나오지 않는다.
  const created = env.call({ action: "setup", adminKey: env.adminKey, setup: setupJson() });
  assert.ok(!JSON.stringify(created).includes(env.adminKey));
  assert.match(env.stats.alerts[0], /관리 열쇠/);
});

test("신청 만들기: 명렬·기록 시트, 학생별 6자리 코드(시트에는 해시만), 설정 검사", () => {
  const env = environment();
  const { created } = ready(env);
  assert.equal(created.codes.length, 4);
  for (const item of created.codes) assert.match(item.code, /^[0-9]{6}$/);
  const roster = env.sheets.get(`명렬_${created.id}`);
  assert.equal(roster.rows.length, 5);
  assert.ok(!JSON.stringify(roster.rows).includes(created.codes[0].code), "시트에 코드 원문이 없다");
  assert.equal(env.sheets.get(`기록_${created.id}`).rows.length, 1);
  const bad = (change) => env.call({ action: "setup", adminKey: env.adminKey, setup: { ...setupJson(), ...change } }).error;
  assert.match(bad({ type: "x" }), /형식이 잘못/);
  assert.match(bad({ schoolName: "" }), /형식이 잘못/);
  assert.match(bad({ roster: [] }), /1~10000명/);
  assert.match(bad({ subjects: { "2": [] } }), /학년별 과목 설정/);
  assert.match(bad({ roster: [{ grade: "1", classroom: "1", number: "1", name: "가" }, { grade: "1", classroom: "01", number: "1", name: "나" }] }), /두 번/);
  assert.match(bad({ schoolYear: "2020" }), /기간이 끝났습니다/);
});

test("학생 접속: 첫 접속은 코드 변경부터, 쉬운 코드 거절, 바꾼 뒤 예전 코드는 못 씀", () => {
  const env = environment();
  const { student, created } = ready(env);
  const who = student(1);
  assert.deepEqual(plain(env.call({ action: "loginForm", event: created.id })), { schoolName: "가상고등학교", schoolYear: "2026", round: "1", grades: ["1"] });
  const first = env.call({ action: "open", ...who });
  assert.equal(first.mustChangeCode, true);
  assert.equal(first.student.name, "가상학생1");
  assert.equal(first.courses, undefined);
  assert.match(env.call({ action: "submit", ...who, selections: ["대수", "영어Ⅰ", "화학"] }).error, /먼저 개인 코드를/);
  assert.match(env.call({ action: "changeCode", ...who, newCode: "111111" }).error, /너무 쉬운/);
  assert.match(env.call({ action: "changeCode", ...who, newCode: "123456" }).error, /너무 쉬운/);
  assert.match(env.call({ action: "changeCode", ...who, newCode: who.code }).error, /다른 새 코드/);
  assert.match(env.call({ action: "changeCode", ...who, newCode: "12345" }).error, /6자리 숫자/);
  assert.match(env.call({ action: "changeCode", ...who, newCode: "482913" }).message, /변경했습니다/);
  assert.equal(env.call({ action: "open", ...who }).error, "반·번호 또는 코드가 맞지 않습니다.");
  const opened = env.call({ action: "open", ...who, code: "482913" });
  assert.equal(opened.open, true);
  assert.deepEqual(opened.courses.map((course) => course.subject).slice(0, 2), ["대수", "영어Ⅰ"]);
  assert.deepEqual(opened.groups.map((group) => group.id), ["g1", "g2"], "내년 학년(2학년) 그룹만");
  assert.deepEqual(plain(opened.selections), []);
  assert.match(env.call({ action: "changeCode", ...who, code: "482913", newCode: "777123" }).error, /이미 코드를 변경/);
  // 캐시가 비어도(6시간 뒤) 속성·시트에서 다시 읽어 같은 답.
  env.clearCache();
  assert.equal(env.call({ action: "open", ...who, code: "482913" }).open, true);
  // 앞에 0이 붙은 반·번호도 같은 학생.
  assert.equal(env.call({ action: "open", ...who, classroom: "01", number: "001", code: "482913" }).student.number, "1");
});

test("제출 규칙: 택n 개수 · 신청 가능한 과목 · 같은 과목 한 학기만 · 마감", () => {
  const env = environment();
  const { changed, created } = ready(env);
  const who = changed(1);
  const submit = (selections) => env.call({ action: "submit", ...who, selections });
  assert.match(submit("대수").error, /과목을 선택하세요/);
  assert.equal(submit(["대수", "화학"]).error, "2학년 1학기 택2: 정확히 2과목을 선택하세요.");
  assert.equal(submit(["대수", "영어Ⅰ", "물리학", "화학"]).error, "2학년 1학기 택2: 정확히 2과목을 선택하세요.");
  assert.equal(submit(["대수", "영어Ⅰ"]).error, "2학년 2학기 택1: 정확히 1과목을 선택하세요.");
  assert.match(submit(["대수", "영어Ⅰ", "화학", "세계사"]).error, /신청 가능한 과목을 중복 없이/);
  assert.match(submit(["대수", "영어Ⅰ", "화학", "화학"]).error, /정확히 1과목|중복 없이/);
  assert.equal(submit(["대수", "심화 영어 (1학기)", "심화 영어 (2학기)"]).error, "1학기와 2학기에 같은 과목을 중복 신청할 수 없습니다.");
  assert.equal(env.stats.appends, 0, "거절된 제출은 기록하지 않는다");
  assert.match(submit(["대수", "영어Ⅰ", "화학"]).message, /저장되었습니다/);
  assert.equal(env.stats.appends, 1);
  // 마감하면 저장 거절, 다시 열면 됨.
  assert.match(env.call({ action: "close", adminKey: env.adminKey, event: created.id }).message, /마감/);
  assert.equal(submit(["물리학", "영어Ⅰ", "화학"]).error, "수강신청이 마감되었습니다.");
  assert.equal(env.call({ action: "open", ...who }).open, false);
  env.call({ action: "close", adminKey: env.adminKey, event: created.id, open: true });
  assert.match(submit(["물리학", "영어Ⅰ", "화학"]).message, /저장되었습니다/);
});

test("학생별 마지막 줄이 유효: 다시 제출하면 줄이 늘고 결과·학생 화면은 마지막 것", () => {
  const env = environment();
  const { changed, created } = ready(env);
  const one = changed(1);
  const two = changed(2);
  env.call({ action: "submit", ...one, selections: ["대수", "영어Ⅰ", "화학"] });
  env.advance(1000);
  env.call({ action: "submit", ...two, selections: ["물리학", "영어Ⅰ", "화학"] });
  env.advance(1000);
  env.call({ action: "submit", ...one, selections: ["대수", "물리학", "심화 영어 (2학기)"] });
  assert.equal(env.sheets.get(`기록_${created.id}`).rows.length, 4, "머리글 + 제출 3줄(덮어쓰지 않음)");
  assert.deepEqual(plain(env.call({ action: "open", ...one }).selections), ["대수", "물리학", "심화 영어 (2학기)"]);
  env.clearCache();
  assert.deepEqual(plain(env.call({ action: "open", ...one }).selections), ["대수", "물리학", "심화 영어 (2학기)"], "캐시가 비어도 시트의 마지막 줄");
  const results = env.call({ action: "results", adminKey: env.adminKey, event: created.id });
  assert.equal(results.students, 4);
  assert.equal(results.submitted, 2);
  const byNumber = Object.fromEntries(results.entries.map((entry) => [entry.number, entry]));
  assert.deepEqual(plain(byNumber["1"].selections), ["대수", "물리학", "심화 영어 (2학기)"]);
  assert.deepEqual(plain(byNumber["2"].selections), ["물리학", "영어Ⅰ", "화학"]);
  assert.equal(byNumber["3"].submittedAt, null);
  assert.equal(byNumber["1"].studentId, "1011");
  assert.equal(results.mismatched, 0, "학생 화면이 읽는 칸과 기록의 마지막 줄이 같다");
  assert.ok(!JSON.stringify(results).includes("482913"), "결과에 코드가 없다");
});

test("제출 1건 = 잠금 없이 학생 한 줄 읽기 + 기록 한 줄 덧붙이기 + 그 학생 칸 쓰기(시트 전체를 읽지 않는다)", () => {
  const env = environment();
  const { changed } = ready(env);
  const who = changed(1);
  env.call({ action: "open", ...who });
  const before = { ...env.stats };
  // 다른 요청이 스크립트 잠금을 쥐고 있어도 제출은 된다.
  env.stats.lockBusy = true;
  assert.match(env.call({ action: "submit", ...who, selections: ["대수", "영어Ⅰ", "화학"] }).message, /저장/);
  env.stats.lockBusy = false;
  assert.equal(env.stats.lockTries, before.lockTries, "제출은 잠금을 잡지 않는다");
  assert.equal(env.stats.sheetReads, before.sheetReads + 1, "시트 읽기는 그 학생 한 줄 한 번");
  assert.equal(env.stats.rowsRead, before.rowsRead + 1);
  assert.equal(env.stats.appends, before.appends + 1);
  assert.equal(env.stats.cellWrites, before.cellWrites + 1);
  assert.equal(env.stats.propertyReads, before.propertyReads, "설정은 캐시에서(속성을 읽지 않는다)");
  // 설정 캐시가 지워져도 속성은 한 번에 읽는다(getProperties 한 번).
  env.clearCache();
  const reads = env.stats.propertyReads;
  assert.equal(env.call({ action: "open", ...who }).open, true);
  assert.equal(env.stats.propertyReads, reads + 1, "속성 읽기는 getProperties 한 번");
});

test("잠금을 못 잡으면 다시 시도하라는 답(retry), 자료는 그대로", () => {
  const env = environment();
  const { student, created } = ready(env);
  const who = student(1);
  env.stats.lockBusy = true;
  const busy = env.call({ action: "changeCode", ...who, newCode: "482913" });
  assert.equal(busy.retry, true);
  assert.match(busy.error, /접속이 많습니다/);
  assert.equal(env.call({ action: "close", adminKey: env.adminKey, event: created.id }).retry, true);
  assert.equal(env.call({ action: "setup", adminKey: env.adminKey, setup: setupJson() }).retry, true);
  env.stats.lockBusy = false;
  assert.equal(env.call({ action: "open", ...who }).mustChangeCode, true, "코드는 바뀌지 않았다");
  assert.match(env.call({ action: "changeCode", ...who, newCode: "482913" }).message, /변경했습니다/);
});

test("틀린 코드: 연속 5회 → 10분 잠금(올바른 코드도 거절), 누적 10회 넘으면 교사 해제 필요", () => {
  const env = environment();
  const { changed } = ready(env);
  const who = changed(1);
  const wrong = () => env.call({ action: "open", ...who, code: "000001" });
  for (let i = 0; i < 4; i += 1) assert.deepEqual(plain(wrong()), { error: "반·번호 또는 코드가 맞지 않습니다." });
  const locked = wrong();
  assert.equal(locked.locked, true);
  assert.match(locked.error, /약 10분 뒤/);
  assert.equal(env.call({ action: "open", ...who }).locked, true, "잠긴 동안에는 올바른 코드도 받지 않는다");
  // 없는 반·번호는 같은 문장, 잠글 학생이 없다.
  assert.deepEqual(plain(env.call({ action: "open", ...who, number: "99" })), { error: "반·번호 또는 코드가 맞지 않습니다." });
  env.advance(11 * 60000);
  assert.equal(env.call({ action: "open", ...who }).open, true);
  for (let i = 0; i < 4; i += 1) wrong();
  assert.match(wrong().error, /약 10분 뒤/);
  env.advance(11 * 60000);
  assert.match(wrong().error, /선생님께 잠금 해제/);
  env.advance(24 * 3600000);
  assert.match(env.call({ action: "open", ...who }).error, /선생님께 잠금 해제/);
  // 다른 학생은 영향이 없다.
  const other = changed(2);
  assert.equal(env.call({ action: "open", ...other }).open, true);
  // 형식이 틀린 입력은 실패로 세지 않는다.
  assert.match(env.call({ action: "open", ...other, code: "12" }).error, /6자리 숫자 코드/);
  assert.match(env.call({ action: "open", ...other, classroom: "가" }).error, /숫자로 입력/);
});

test("재신청 차수: 재선택 대상이 아니면 바꿀 수 없고, 유지 과목은 빼지 못한다", () => {
  const env = environment();
  const roster = [
    { grade: "1", classroom: "1", number: "1", name: "가상학생1", reselectionAllowed: false, retained: ["대수", "영어Ⅰ", "화학"] },
    { grade: "1", classroom: "1", number: "2", name: "가상학생2", reselectionAllowed: true, retained: ["대수", "화학"] },
  ];
  const { changed } = ready(env, { roster });
  const fixed = changed(1);
  const opened = env.call({ action: "open", ...fixed });
  assert.equal(opened.open, false);
  assert.equal(opened.reselectionAllowed, false);
  assert.deepEqual(plain(opened.selections), ["대수", "영어Ⅰ", "화학"]);
  assert.equal(env.call({ action: "submit", ...fixed, selections: ["대수", "물리학", "화학"] }).error, "폐강 과목 신청 학생만 재선택할 수 있습니다. 기존 신청은 유지됩니다.");
  const free = changed(2);
  assert.deepEqual(plain(env.call({ action: "open", ...free }).lockedSelections), ["대수", "화학"]);
  assert.equal(env.call({ action: "submit", ...free, selections: ["물리학", "영어Ⅰ", "화학"] }).error, "폐강되지 않은 기존 선택 과목은 변경할 수 없습니다.");
  assert.match(env.call({ action: "submit", ...free, selections: ["대수", "물리학", "화학"] }).message, /저장/);
});

test("현 1·2학년이 함께 있는 신청은 학년을 고르게 하고, 학년마다 자기 과목만 받는다", () => {
  const env = environment();
  const roster = [
    { grade: "1", classroom: "1", number: "1", name: "가상일학년" },
    { grade: "2", classroom: "1", number: "1", name: "가상이학년" },
  ];
  const { created, student } = ready(env, { roster });
  assert.deepEqual(plain(env.call({ action: "loginForm", event: created.id }).grades), ["1", "2"]);
  const who = student(1, "2");
  assert.deepEqual(plain(env.call({ action: "open", ...who })), { error: "학년을 선택하세요.", needGrade: true });
  assert.equal(env.call({ action: "open", ...who, grade: "2" }).student.name, "가상이학년");
  env.call({ action: "changeCode", ...who, grade: "2", newCode: "482913" });
  const second = { ...who, grade: "2", code: "482913" };
  assert.deepEqual(env.call({ action: "open", ...second }).groups.map((group) => group.id), ["g3"]);
  assert.match(env.call({ action: "submit", ...second, selections: ["대수"] }).error, /정확히 1과목|신청 가능한/);
  assert.match(env.call({ action: "submit", ...second, selections: ["세계사"] }).message, /저장/);
});

test("큰 설정(과목 500개)도 속성 조각으로 저장하고, 학년도가 끝나면 접속을 막는다", () => {
  const env = environment();
  const setup = setupJson();
  setup.subjects["3"] = Array.from({ length: 500 }, (_, index) => ({ subject: `가상 과목 ${index + 1}`, credit: 4, semester: "1", requires: [{ name: "선이수", options: ["가상 과목 1"] }] }));
  const created = env.call({ action: "setup", adminKey: env.adminKey, setup });
  assert.ok(created.id, JSON.stringify(created));
  assert.ok(Number(env.properties.get(`ev:${created.id}:count`)) > 1);
  env.clearCache();
  assert.equal(env.call({ action: "results", adminKey: env.adminKey, event: created.id }).students, 4);
  env.advance(200 * 24 * 3600000);
  assert.match(env.call({ action: "loginForm", event: created.id }).error, /기간이 끝났습니다/);
  assert.match(env.call({ action: "loginForm", event: "없는신청" }).error, /찾지 못했습니다/);
});

// ---- 호출 도우미(apps-script/client.js): 다시 시도·요약·가상 자료 ----
const client = require("../apps-script/client.js");

function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return { status: answer.status || 200, text: async () => answer.text };
  };
  return { fn, calls };
}
const quick = { sleep: async () => {}, random: () => 0.5 };

test("호출 도우미: 단순 요청(text/plain, redirect follow), 잠금·한도·네트워크 오류는 지연을 늘려 다시 시도", async () => {
  const waits = [];
  const options = { sleep: async (ms) => { waits.push(ms); }, random: () => 1 };
  const flaky = fakeFetch([{ text: "<html>Service invoked too many times</html>" }, { text: JSON.stringify({ error: "busy", retry: true }) }, new Error("Failed to fetch"), { text: JSON.stringify({ message: "저장" }) }]);
  const result = await client.appsScriptCall(flaky.fn, "https://script.google.com/macros/s/x/exec", { action: "submit" }, options);
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 4);
  assert.deepEqual(waits, [500, 1000, 2000], "지연이 두 배씩 늘어난다");
  assert.equal(flaky.calls[0].init.method, "POST");
  assert.equal(flaky.calls[0].init.headers["Content-Type"], "text/plain;charset=utf-8");
  assert.equal(flaky.calls[0].init.redirect, "follow");
  assert.equal(JSON.parse(flaky.calls[0].init.body).action, "submit");
  // 규칙 오류는 다시 시도하지 않고 그대로 돌려준다.
  const rule = fakeFetch([{ text: JSON.stringify({ error: "정확히 2과목을 선택하세요." }) }]);
  const refused = await client.appsScriptCall(rule.fn, "u", {}, quick);
  assert.deepEqual([refused.ok, refused.kind, refused.attempts, rule.calls.length], [false, "rule", 1, 1]);
  // 끝까지 안 되면 마지막 종류를 알려 준다.
  const down = fakeFetch([{ status: 429, text: JSON.stringify({ error: "x" }) }]);
  const failed = await client.appsScriptCall(down.fn, "u", {}, { ...quick, retries: 2 });
  assert.deepEqual([failed.ok, failed.kind, failed.attempts], [false, "quota", 3]);
  assert.ok(client.appsScriptDelay(10, { random: () => 1 }) <= 8000, "지연 상한");
});

test("측정 요약과 가상 자료: 가상 선택은 시제품 서버 규칙을 통과한다", async () => {
  const summary = client.appsScriptSummary([{ ok: true, ms: 100, attempts: 1 }, { ok: true, ms: 300, attempts: 2 }, { ok: true, ms: 200, attempts: 1 }, { ok: false, ms: 9000, attempts: 6, kind: "quota" }]);
  assert.deepEqual(summary, { total: 4, success: 3, successRate: 75, retries: 6, retried: 2, median: 200, p95: 300, max: 300, errors: { quota: 1 } });
  const env = environment();
  const setup = client.appsScriptVirtualSetup({ classes: 2, perClass: 5, schoolYear: "2026" });
  assert.ok(setup.roster.every((student) => /^가상학생/.test(student.name)));
  const created = env.call({ action: "setup", adminKey: env.adminKey, setup });
  assert.equal(created.codes.length, 10);
  // 호출 도우미를 흉내 서버에 연결해 학생 10명이 접속 → 코드 변경 → 제출.
  const fetchFn = async (url, init) => ({ status: 200, text: async () => JSON.stringify(env.call(init.body)) });
  const results = [];
  for (const [index, item] of created.codes.entries()) {
    const who = { event: created.id, classroom: item.classroom, number: item.number };
    assert.equal((await client.appsScriptCall(fetchFn, "u", { action: "changeCode", ...who, code: item.code, newCode: "482913" }, quick)).ok, true);
    results.push(await client.appsScriptCall(fetchFn, "u", { action: "submit", ...who, code: "482913", selections: client.appsScriptVirtualSelections(setup, index) }, quick));
  }
  assert.equal(client.appsScriptSummary(results).successRate, 100, JSON.stringify(results.find((item) => !item.ok)));
  assert.equal(env.call({ action: "results", adminKey: env.adminKey, event: created.id }).submitted, 10);
});

// ---- 검토에서 나온 결함 확인 ----

test("캐시가 항목을 임의로 지워도(상한 1,000) 650명 규모에서 로그인·열기·제출·결과가 모두 맞다", () => {
  for (const cacheLimit of [1000, 3, 0]) {
    const env = environment({ cacheLimit });
    const roster = [];
    for (let classroom = 1; classroom <= 10; classroom += 1) for (let number = 1; number <= 34; number += 1) roster.push({ grade: "1", classroom: String(classroom), number: String(number), name: `가상학생1-${classroom}-${number}` });
    for (let classroom = 1; classroom <= 10; classroom += 1) for (let number = 1; number <= 31; number += 1) roster.push({ grade: "2", classroom: String(classroom), number: String(number), name: `가상학생2-${classroom}-${number}` });
    assert.equal(roster.length, 650);
    const created = env.call({ action: "setup", adminKey: env.adminKey, setup: setupJson({ roster }) });
    assert.equal(created.codes.length, 650);
    const picks = (item, index) => item.grade === "2" ? [index % 2 ? "세계사" : "확률과 통계"]
      : [["대수", "영어Ⅰ"], ["물리학", "영어Ⅰ"], ["대수", "물리학"]][index % 3].concat(index % 2 ? "화학" : "심화 영어 (2학기)");
    const expected = new Map();
    created.codes.forEach((item, index) => {
      const who = { event: created.id, grade: item.grade, classroom: item.classroom, number: item.number };
      assert.equal(env.call({ action: "open", ...who, code: item.code }).mustChangeCode, true, `${item.grade}-${item.classroom}-${item.number}`);
      assert.ok(env.call({ action: "changeCode", ...who, code: item.code, newCode: "482913" }).message);
      const opened = env.call({ action: "open", ...who, code: "482913" });
      assert.equal(opened.student.name, item.name);
      assert.deepEqual(plain(opened.selections), []);
      assert.ok(env.call({ action: "submit", ...who, code: "482913", selections: picks(item, index) }).message, `${item.name}`);
      expected.set(`${item.grade}-${item.classroom}-${item.number}`, picks(item, index));
    });
    // 모두 낸 뒤 다시 열어도 자기 선택이 보인다(캐시에서 지워졌다고 '제출 안 함'이 되지 않는다).
    created.codes.forEach((item) => {
      const opened = env.call({ action: "open", event: created.id, grade: item.grade, classroom: item.classroom, number: item.number, code: "482913" });
      assert.deepEqual(plain(opened.selections), expected.get(`${item.grade}-${item.classroom}-${item.number}`), item.name);
    });
    const results = env.call({ action: "results", adminKey: env.adminKey, event: created.id });
    assert.deepEqual([results.students, results.submitted, results.mismatched], [650, 650, 0]);
    for (const entry of results.entries) assert.deepEqual(plain(entry.selections), expected.get(`${entry.grade}-${entry.classroom}-${entry.number}`));
    // 없는 반·번호를 물어도 시트를 읽지 않는다.
    const reads = env.stats.sheetReads;
    assert.equal(env.call({ action: "open", event: created.id, grade: "1", classroom: "11", number: "1", code: "482913" }).error, "반·번호 또는 코드가 맞지 않습니다.");
    assert.equal(env.stats.sheetReads, reads);
  }
});

test("같은 반 두 학생이 번갈아 여러 번 내도 서로의 제출을 잃지 않고, 재선택 불가 학생은 시트의 지금 선택으로 판정한다", () => {
  const env = environment({ cacheLimit: 1 });
  const roster = [
    { grade: "1", classroom: "1", number: "1", name: "가상학생1" },
    { grade: "1", classroom: "1", number: "2", name: "가상학생2", reselectionAllowed: false, retained: ["대수", "영어Ⅰ", "화학"] },
  ];
  const { changed, created } = ready(env, { roster });
  const one = changed(1), two = changed(2);
  env.call({ action: "submit", ...one, selections: ["대수", "영어Ⅰ", "화학"] });
  env.call({ action: "submit", ...two, selections: ["화학", "영어Ⅰ", "대수"] });
  env.call({ action: "submit", ...one, selections: ["물리학", "영어Ⅰ", "화학"] });
  assert.match(env.call({ action: "submit", ...two, selections: ["대수", "물리학", "화학"] }).error, /폐강 과목 신청 학생만/);
  assert.deepEqual(plain(env.call({ action: "open", ...one }).selections), ["물리학", "영어Ⅰ", "화학"]);
  assert.deepEqual(plain(env.call({ action: "open", ...two }).selections), ["화학", "영어Ⅰ", "대수"]);
  const results = env.call({ action: "results", adminKey: env.adminKey, event: created.id });
  assert.deepEqual([results.submitted, results.mismatched], [2, 0]);
});

test("잠금 안에서는 그 줄을 새로 읽는다: 그 사이 올라간 실패 수를 덮어쓰지 않고, 코드 변경이 겹치면 둘째를 거절한다", () => {
  const env = environment();
  const { changed, student, created } = ready(env);
  const who = changed(1);
  const sheet = env.sheets.get(`명렬_${created.id}`);
  env.call({ action: "open", ...who, code: "000001" });
  assert.deepEqual(sheet.rows[1].slice(9, 11), [1, 1]);
  // 올바른 코드로 들어오는 사이(잠금을 기다리는 동안) 다른 요청이 누적 실패를 5로 올렸다.
  env.stats.beforeLock = () => { sheet.rows[1][9] = 3; sheet.rows[1][10] = 5; };
  assert.equal(env.call({ action: "open", ...who }).open, true);
  assert.deepEqual(sheet.rows[1].slice(9, 11), [0, 5], "연속 실패만 0으로, 누적 실패는 새로 읽은 값 그대로");
  // 틀린 코드가 잠금을 기다리는 사이 다른 요청이 이미 교사 잠금을 걸었으면 그 상태를 그대로 답한다.
  env.stats.beforeLock = () => { sheet.rows[1][12] = 1; };
  assert.match(env.call({ action: "open", ...who, code: "000001" }).error, /선생님께 잠금 해제/);
  assert.deepEqual(sheet.rows[1].slice(9, 13), [0, 5, 0, 1]);
  // 같은 학생의 코드 변경 두 건이 겹치면: 먼저 끝난 것만 유효.
  const other = student(2);
  env.stats.beforeLock = () => { sheet.rows[2][6] = 0; };
  assert.match(env.call({ action: "changeCode", ...other, newCode: "482913" }).error, /이미 코드를 변경/);
  // 코드·잠금 칸을 써도 그 학생의 현재 선택 칸은 그대로다.
  const third = changed(3);
  env.call({ action: "submit", ...third, selections: ["대수", "영어Ⅰ", "화학"] });
  env.call({ action: "open", ...third, code: "000001" });
  assert.deepEqual(plain(env.call({ action: "open", ...third }).selections), ["대수", "영어Ⅰ", "화학"]);
});

test("시트가 글자를 바꿔도 그대로: 0으로 시작하는 학번, 숫자·수식처럼 보이는 이름, 숫자만 있는 과목명", () => {
  const env = environment();
  const setup = setupJson({ roster: [
    { grade: "1", classroom: "1", number: "1", name: "=SUM(A1)", studentId: "01234" },
    { grade: "1", classroom: "1", number: "2", name: "1004", studentId: "1e5" },
  ] });
  setup.subjects["2"].push({ subject: "2024", credit: 4, semester: "2" });
  setup.groups[1].courses.push("2024");
  const created = env.call({ action: "setup", adminKey: env.adminKey, setup });
  const who = { event: created.id, classroom: "1", number: "1" };
  env.call({ action: "changeCode", ...who, code: created.codes[0].code, newCode: "482913" });
  assert.equal(env.call({ action: "open", ...who, code: "482913" }).student.name, "=SUM(A1)");
  assert.match(env.call({ action: "submit", ...who, code: "482913", selections: ["대수", "영어Ⅰ", "2024"] }).message, /저장/);
  const results = env.call({ action: "results", adminKey: env.adminKey, event: created.id });
  assert.deepEqual(results.entries.map((entry) => [entry.name, entry.studentId]), [["=SUM(A1)", "01234"], ["1004", "1e5"]]);
  assert.deepEqual(plain(results.entries[0].selections), ["대수", "영어Ⅰ", "2024"]);
  assert.equal(results.mismatched, 0);
  // 글자 칸은 일반 글자 서식으로 만든다(성명·학번·코드해시·유지과목·현재선택, 기록의 선택과목·구분).
  for (const column of [4, 5, 6, 9, 15]) assert.ok(env.stats.formats.includes(`명렬_${created.id}:${column}:@`), String(column));
  assert.ok(env.stats.formats.includes(`기록_${created.id}:5:@`));
});
