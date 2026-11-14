/**
 * 웹 수강신청 — 구글 스프레드시트 + Apps Script 저장소 (시제품)
 *
 * 교사가 자기 구글 드라이브의 스프레드시트에 이 스크립트를 붙여 '웹 앱'으로 배포하면
 * (실행: 나, 액세스: 모든 사용자) 신청 자료가 그 교사의 스프레드시트에만 저장된다.
 * 학생 화면은 앱 홈페이지가 보여 주고, 이 스크립트는 저장과 규칙 검사만 한다.
 *
 * 호출: POST(본문 = JSON 글자, Content-Type text/plain) → 응답 JSON.
 *   { action: "ping" }
 *   교사(관리 열쇠 adminKey 필요): setup · results · close
 *   학생(반·번호 + 6자리 코드):      loginForm · open · changeCode · submit
 * 규칙 판정은 지금 서버(supabase/*.sql)와 같은 문장·같은 순서를 따른다. 대응표: docs/apps-script-web-apply.md
 *
 * 저장 위치
 *   Script Properties: 관리 열쇠, 코드 해시용 소금, 신청 설정(ev:<id>:n 조각)
 *   시트 '명렬_<id>': 학생 한 줄(학년·반·번호·성명·학번·코드 해시·잠금 상태)
 *   시트 '기록_<id>': 제출 한 건 = 한 줄 덧붙이기(학생별 마지막 줄이 유효)
 *   CacheService: 설정·학생·마지막 제출을 6시간까지 기억(시트 읽기를 줄여 동시 실행 시간을 짧게)
 */

var APP_PROTOCOL = 1;
var CACHE_SECONDS = 21600;
var PROPERTY_CHUNK = 8000;
var LOCK_WAIT_MS = 8000;
var ROSTER_HEADER = ['학년', '반', '번호', '성명', '학번', '코드해시', '코드변경필요', '재선택가능', '유지과목', '연속실패', '누적실패', '잠금해제시각', '교사잠금', '잠금횟수'];
var RECORD_HEADER = ['제출시각', '학년', '반', '번호', '선택과목', '구분'];
var WRONG_CODE = '반·번호 또는 코드가 맞지 않습니다.';
var BUSY = '지금 접속이 많습니다. 잠시 뒤 자동으로 다시 시도합니다.';
var WEAK_CODES = ['012345', '123456', '234567', '345678', '456789', '567890', '987654', '876543', '765432', '654321', '543210', '098765', '121212', '123123', '112233', '000123'];

// 테스트에서 시각을 바꿀 수 있게 한 곳에서 읽는다.
var CLOCK_ = null;
function now_() { return CLOCK_ ? CLOCK_() : new Date().getTime(); }

function doPost(e) {
  var result;
  try {
    var request = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    result = handle_(request || {});
  } catch (error) {
    result = { error: String((error && error.message) || error) };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// 주소를 브라우저로 열었을 때(GET) 보이는 안내. 자료는 주지 않는다.
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, protocol: APP_PROTOCOL, message: '수강신청 저장소가 켜져 있습니다. 이 주소를 교육과정 관리 앱에 넣어 주세요.' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handle_(request) {
  var action = String(request.action || '');
  if (action === 'ping') return { ok: true, protocol: APP_PROTOCOL, time: now_() };
  if (action === 'setup' || action === 'results' || action === 'close') {
    requireAdmin_(request.adminKey);
    if (action === 'setup') return teacherSetup_(request.setup);
    if (action === 'results') return teacherResults_(request.event);
    return teacherClose_(request.event, request.open === true);
  }
  if (action === 'loginForm') return studentLoginForm_(request.event);
  if (action === 'open') return studentOpen_(request);
  if (action === 'changeCode') return studentChangeCode_(request);
  if (action === 'submit') return studentSubmit_(request);
  throw new Error('알 수 없는 요청입니다.');
}

// ---- 공통 도우미 ----

function props_() { return PropertiesService.getScriptProperties(); }
function cache_() { return CacheService.getScriptCache(); }
function book_() { return SpreadsheetApp.getActiveSpreadsheet(); }

function sha256_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var value = (bytes[i] + 256) % 256;
    hex += (value < 16 ? '0' : '') + value.toString(16);
  }
  return hex;
}

// 길이가 달라도 걸리는 시간이 비슷하게 견준다.
function sameText_(a, b) {
  a = String(a); b = String(b);
  var diff = a.length ^ b.length;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i % (b.length || 1));
  return diff === 0;
}

function requireAdmin_(key) {
  var stored = props_().getProperty('adminKey');
  if (!stored) throw new Error('관리 열쇠가 아직 없습니다. 스프레드시트 메뉴 [수강신청] → [관리 열쇠 만들기]를 먼저 실행하세요.');
  if (!key || !sameText_(sha256_(String(key)), sha256_(stored))) throw new Error('관리 열쇠가 맞지 않습니다.');
}

function pepper_() {
  var value = props_().getProperty('pepper');
  if (!value) { value = Utilities.getUuid() + Utilities.getUuid(); props_().setProperty('pepper', value); }
  return value;
}

function withLock_(work) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return { error: BUSY, retry: true };
  try { return work(); } finally { lock.releaseLock(); }
}

function eventId_(value) {
  var id = String(value || '');
  if (!/^[a-z0-9]{6,40}$/.test(id)) throw new Error('수강신청을 찾지 못했습니다.');
  return id;
}

// 신청 설정: Script Properties에 조각으로 저장(값 하나 9KB 한도), 읽을 때는 캐시 먼저.
function saveEvent_(event) {
  var text = JSON.stringify(event);
  var values = {};
  var count = Math.ceil(text.length / PROPERTY_CHUNK);
  for (var i = 0; i < count; i++) values['ev:' + event.id + ':' + i] = text.substr(i * PROPERTY_CHUNK, PROPERTY_CHUNK);
  values['ev:' + event.id + ':count'] = String(count);
  props_().setProperties(values);
  if (text.length < 90000) cache_().put('e:' + event.id, text, CACHE_SECONDS);
}

function loadEvent_(value) {
  var id = eventId_(value);
  var text = cache_().get('e:' + id);
  if (!text) {
    var count = Number(props_().getProperty('ev:' + id + ':count') || 0);
    if (!count) throw new Error('수강신청을 찾지 못했습니다.');
    text = '';
    for (var i = 0; i < count; i++) text += props_().getProperty('ev:' + id + ':' + i) || '';
    if (text.length < 90000) cache_().put('e:' + id, text, CACHE_SECONDS);
  }
  return JSON.parse(text);
}

// 지금 서버의 course_school_year_active: 신청 학년도 다음 해 3월 1일 0시(한국 시각)부터 닫힌다.
function assertYearActive_(schoolYear) {
  var expires = Date.UTC(Number(schoolYear) + 1, 2, 1) - 9 * 3600 * 1000;
  if (!(now_() < expires)) throw new Error('이 학년도의 수강신청 기간이 끝났습니다.');
}

function digits_(value) { return String(value == null ? '' : value).trim().replace(/^0+/, ''); }
function studentKey_(grade, classroom, number) { return grade + '-' + classroom + '-' + number; }
function codeHash_(eventId, key, code) { return sha256_(pepper_() + '|' + eventId + '|' + key + '|' + code); }
function baseSubject_(name) { return String(name).replace(/\s*\([12]학기\)/g, '').replace(/\s+/g, ' ').trim(); }

function newCode_() {
  for (var attempt = 0; attempt < 50; attempt++) {
    var hex = Utilities.getUuid().replace(/-/g, '');
    var code = String(parseInt(hex.substr(0, 8), 16) % 1000000);
    while (code.length < 6) code = '0' + code;
    if (!/^(.)\1{5}$/.test(code) && WEAK_CODES.indexOf(code) < 0) return code;
  }
  throw new Error('코드를 만들지 못했습니다.');
}

// ---- 학생 기록(명렬 시트 한 줄 ↔ 캐시) ----

function rosterSheet_(id) { return book_().getSheetByName('명렬_' + id); }
function recordSheet_(id) { return book_().getSheetByName('기록_' + id); }
function studentCacheKey_(event, key) { return 's:' + event.id + ':' + event.version + ':' + key; }
function recordCacheKey_(event, key) { return 'r:' + event.id + ':' + event.version + ':' + key; }

function rowToStudent_(row, index) {
  return { row: index + 2, grade: String(row[0]), classroom: String(row[1]), number: String(row[2]), name: String(row[3]),
    studentId: String(row[4] || ''), hash: String(row[5] || ''), mustChange: Number(row[6]) === 1, allowed: Number(row[7]) !== 0,
    retained: row[8] ? JSON.parse(row[8]) : [], failStreak: Number(row[9]) || 0, failTotal: Number(row[10]) || 0,
    lockedUntil: Number(row[11]) || 0, teacherLock: Number(row[12]) === 1, lockCount: Number(row[13]) || 0 };
}

function studentToRow_(s) {
  return [s.grade, s.classroom, s.number, s.name, s.studentId || '', s.hash, s.mustChange ? 1 : 0, s.allowed ? 1 : 0,
    JSON.stringify(s.retained || []), s.failStreak || 0, s.failTotal || 0, s.lockedUntil || 0, s.teacherLock ? 1 : 0, s.lockCount || 0];
}

function readRoster_(event) {
  var sheet = rosterSheet_(event.id);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, ROSTER_HEADER.length).getValues();
  var students = [];
  for (var i = 0; i < rows.length; i++) if (String(rows[i][0]) !== '') students.push(rowToStudent_(rows[i], i));
  return students;
}

function cacheStudents_(event, students) {
  var batch = {}, size = 0;
  for (var i = 0; i < students.length; i++) {
    var s = students[i];
    batch[studentCacheKey_(event, studentKey_(s.grade, s.classroom, s.number))] = JSON.stringify(s);
    if (++size >= 200) { cache_().putAll(batch, CACHE_SECONDS); batch = {}; size = 0; }
  }
  if (size) cache_().putAll(batch, CACHE_SECONDS);
}

// 학년을 모르면(학년 선택 칸이 없는 신청) 그 신청의 학년마다 찾아본다.
function findStudents_(event, grade, classroom, number) {
  var grades = grade ? [grade] : event.grades;
  var keys = grades.map(function (g) { return studentCacheKey_(event, studentKey_(g, classroom, number)); });
  var hit = cache_().getAll(keys);
  var found = [];
  var missed = false;
  for (var i = 0; i < keys.length; i++) { if (hit[keys[i]]) found.push(JSON.parse(hit[keys[i]])); else missed = true; }
  if (!missed) return found;
  // 명렬을 방금(10분 안에) 다 채웠으면 캐시에 없는 반·번호는 없는 학생이다(틀린 반·번호 때문에 시트를 거듭 읽지 않는다).
  var loadedKey = 's:' + event.id + ':' + event.version + ':loaded';
  if (cache_().get(loadedKey)) return found;
  // 캐시에 없으면(6시간 지남 등) 명렬 시트를 한 번 읽어 다시 채운다.
  var all = readRoster_(event);
  cacheStudents_(event, all);
  cache_().put(loadedKey, '1', 600);
  return all.filter(function (s) { return grades.indexOf(s.grade) >= 0 && s.classroom === classroom && s.number === number; });
}

function writeStudent_(event, student) {
  rosterSheet_(event.id).getRange(student.row, 1, 1, ROSTER_HEADER.length).setValues([studentToRow_(student)]);
  cache_().put(studentCacheKey_(event, studentKey_(student.grade, student.classroom, student.number)), JSON.stringify(student), CACHE_SECONDS);
}

function lockMessage_(student) {
  if (student.teacherLock) return '여러 번 틀려 접속이 잠겼습니다. 선생님께 잠금 해제를 요청하세요.';
  if (student.lockedUntil > now_()) return '여러 번 틀려 잠시 잠겼습니다. 약 ' + Math.max(1, Math.ceil((student.lockedUntil - now_()) / 60000)) + '분 뒤에 다시 시도하세요.';
  return null;
}

// 지금 서버의 course_authenticate_student와 같은 순서·같은 문장.
// 돌려주는 값: { error, locked, needGrade, retry } 또는 { student, event }
function authenticate_(request) {
  var event = loadEvent_(request.event);
  assertYearActive_(event.schoolYear);
  var grade = String(request.grade == null ? '' : request.grade).trim();
  var classroom = digits_(request.classroom);
  var number = digits_(request.number);
  var code = String(request.code == null ? '' : request.code);
  if ((grade && !/^[12]$/.test(grade)) || !/^[1-9][0-9]{0,2}$/.test(classroom) || !/^[1-9][0-9]{0,2}$/.test(number)) {
    return { error: '학년·반·번호를 숫자로 입력하세요.' };
  }
  if (!/^[0-9]{6}$/.test(code)) return { error: '6자리 숫자 코드를 입력하세요.' };
  var matches = findStudents_(event, grade, classroom, number);
  if (!grade && matches.length > 1) return { error: '학년을 선택하세요.', needGrade: true };
  if (!matches.length) return { error: WRONG_CODE };
  var student = matches[0];
  var message = lockMessage_(student);
  if (message) return { error: message, locked: true };
  var key = studentKey_(student.grade, student.classroom, student.number);
  if (student.hash && sameText_(student.hash, codeHash_(event.id, key, code))) {
    if (student.failStreak) {
      var reset = withLock_(function () { student.failStreak = 0; writeStudent_(event, student); return null; });
      if (reset) return reset;
    }
    return { student: student, event: event };
  }
  // 틀린 코드: 잠금을 잡고 실패 수를 올린다(연속 5회 → 10분, 누적 10회 넘으면 교사가 풀 때까지).
  return withLock_(function () {
    var fresh = rowToStudent_(rosterSheet_(event.id).getRange(student.row, 1, 1, ROSTER_HEADER.length).getValues()[0], student.row - 2);
    fresh.failStreak += 1;
    fresh.failTotal += 1;
    if (fresh.failTotal > 10) { fresh.teacherLock = true; fresh.lockedUntil = 0; fresh.failStreak = 0; }
    else if (fresh.failStreak >= 5) { fresh.lockedUntil = now_() + 600000; fresh.failStreak = 0; fresh.lockCount += 1; }
    writeStudent_(event, fresh);
    var locked = lockMessage_(fresh);
    return locked ? { error: locked, locked: true } : { error: WRONG_CODE };
  });
}

// 학생별 마지막 제출(기록 시트의 마지막 줄이 유효). 캐시에 없으면 기록 시트를 한 번 읽어 모두 채운다.
function latestRecords_(event) {
  var sheet = recordSheet_(event.id);
  var latest = {};
  if (!sheet || sheet.getLastRow() < 2) return latest;
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, RECORD_HEADER.length).getValues();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][1]) === '') continue;
    latest[studentKey_(String(rows[i][1]), String(rows[i][2]), String(rows[i][3]))] = { selections: JSON.parse(rows[i][4] || '[]'), submittedAt: Number(rows[i][0]) || 0 };
  }
  return latest;
}

function latestRecord_(event, key) {
  var cached = cache_().get(recordCacheKey_(event, key));
  if (cached) return JSON.parse(cached);
  if (cache_().get('r:' + event.id + ':' + event.version + ':loaded')) return null;
  var latest = latestRecords_(event);
  var batch = {}, size = 0;
  for (var name in latest) {
    batch[recordCacheKey_(event, name)] = JSON.stringify(latest[name]);
    if (++size >= 200) { cache_().putAll(batch, CACHE_SECONDS); batch = {}; size = 0; }
  }
  if (size) cache_().putAll(batch, CACHE_SECONDS);
  // 기록 시트를 다 읽었다는 표시: 아직 제출하지 않은 학생 때문에 시트를 거듭 읽지 않는다.
  cache_().put('r:' + event.id + ':' + event.version + ':loaded', '1', CACHE_SECONDS);
  return latest[key] || null;
}

// ---- 교사 동작 ----

// 지금 서버의 create_course_event와 같은 검사. 돌려주는 값: { id, codes: [{ grade, classroom, number, name, studentId, code }] }
function teacherSetup_(setup) {
  setup = setup || {};
  if (setup.type !== 'course-application-setup' || !/^[1-9][0-9]{0,8}$/.test(String(setup.round || '')) ||
      !String(setup.schoolName || '') || !/^[0-9]{4}$/.test(String(setup.schoolYear || '')) ||
      !Array.isArray(setup.roster) || !setup.subjects || typeof setup.subjects !== 'object') {
    throw new Error('온라인 신청 설정 형식이 잘못되었습니다.');
  }
  assertYearActive_(setup.schoolYear);
  if (setup.roster.length < 1 || setup.roster.length > 10000) throw new Error('명렬은 1~10000명이어야 합니다.');
  ['2', '3'].forEach(function (grade) {
    var list = setup.subjects[grade];
    if (!Array.isArray(list)) throw new Error('학년별 과목 설정이 필요합니다.');
    if (list.length > 500) throw new Error('학년별 과목은 500개 이하여야 합니다.');
    list.forEach(function (item) {
      var name = item && typeof item.subject === 'string' ? item.subject.trim() : '';
      if (!name || name.length > 200) throw new Error('과목 이름을 확인하세요.');
    });
  });
  var groups = Array.isArray(setup.groups) ? setup.groups : [];
  groups.forEach(function (group) {
    if (!group || ['2', '3'].indexOf(String(group.grade)) < 0 || !Array.isArray(group.courses) ||
        !(Number(group.count) >= 0) || Number(group.count) > group.courses.length) {
      throw new Error('선택 그룹 설정을 확인하세요.');
    }
  });
  var seen = {};
  var grades = {};
  var students = setup.roster.map(function (entry, index) {
    var grade = String(entry.grade || '');
    var classroom = digits_(entry.classroom);
    var number = digits_(entry.number);
    var name = String(entry.name || '').trim();
    if (!/^[12]$/.test(grade) || !/^[1-9][0-9]*$/.test(classroom) || !/^[1-9][0-9]*$/.test(number) || !name || name.length > 100) {
      throw new Error('명렬 ' + (index + 1) + '번째 줄의 학년·반·번호·성명을 확인하세요.');
    }
    var key = studentKey_(grade, classroom, number);
    if (seen[key]) throw new Error('명렬에 같은 학년·반·번호가 두 번 있습니다: ' + key);
    seen[key] = true;
    grades[grade] = true;
    return { row: index + 2, grade: grade, classroom: classroom, number: number, name: name, studentId: String(entry.studentId || '').trim(),
      mustChange: true, allowed: entry.reselectionAllowed !== false, retained: Array.isArray(entry.retained) ? entry.retained : [] };
  });
  return withLock_(function () {
    var id = Utilities.getUuid().replace(/-/g, '').substr(0, 16);
    var event = { id: id, version: 1, schoolName: String(setup.schoolName), schoolYear: String(setup.schoolYear), round: String(setup.round),
      open: true, createdAt: now_(), grades: Object.keys(grades).sort(), subjects: setup.subjects, groups: groups };
    var codes = [];
    students.forEach(function (s) {
      var code = newCode_();
      s.hash = codeHash_(id, studentKey_(s.grade, s.classroom, s.number), code);
      codes.push({ grade: s.grade, classroom: s.classroom, number: s.number, name: s.name, studentId: s.studentId, code: code });
    });
    var roster = book_().insertSheet('명렬_' + id);
    roster.getRange(1, 1, 1, ROSTER_HEADER.length).setValues([ROSTER_HEADER]);
    roster.getRange(2, 1, students.length, ROSTER_HEADER.length).setValues(students.map(studentToRow_));
    var record = book_().insertSheet('기록_' + id);
    record.getRange(1, 1, 1, RECORD_HEADER.length).setValues([RECORD_HEADER]);
    saveEvent_(event);
    cacheStudents_(event, students);
    cache_().put('s:' + id + ':1:loaded', '1', 600);
    cache_().put('r:' + id + ':1:loaded', '1', CACHE_SECONDS);
    return { id: id, schoolName: event.schoolName, schoolYear: event.schoolYear, round: event.round, codes: codes };
  });
}

// 신청 결과: 명렬 한 번 + 기록 한 번 읽기. 학생별 마지막 제출이 유효.
function teacherResults_(eventValue) {
  var event = loadEvent_(eventValue);
  var latest = latestRecords_(event);
  var submitted = 0;
  var entries = readRoster_(event).map(function (s) {
    var record = latest[studentKey_(s.grade, s.classroom, s.number)] || null;
    if (record) submitted += 1;
    return { grade: s.grade, classroom: s.classroom, number: s.number, name: s.name, studentId: s.studentId,
      selections: record ? record.selections : s.retained, submittedAt: record ? record.submittedAt : null,
      locked: s.teacherLock || s.lockedUntil > now_() };
  });
  return { id: event.id, schoolName: event.schoolName, schoolYear: event.schoolYear, round: event.round, open: event.open,
    students: entries.length, submitted: submitted, entries: entries };
}

function teacherClose_(eventValue, open) {
  return withLock_(function () {
    var event = loadEvent_(eventValue);
    event.open = open;
    saveEvent_(event);
    return { id: event.id, open: event.open, message: open ? '수강신청을 다시 열었습니다.' : '수강신청을 마감했습니다.' };
  });
}

// ---- 학생 동작 ----

// 접속 화면에 학년 선택 칸을 보일지(학생 정보는 주지 않는다).
function studentLoginForm_(eventValue) {
  var event = loadEvent_(eventValue);
  assertYearActive_(event.schoolYear);
  return { schoolName: event.schoolName, schoolYear: event.schoolYear, round: event.round, grades: event.grades };
}

function targetGrade_(student) { return String(Number(student.grade) + 1); }
function groupsFor_(event, student) {
  var grade = targetGrade_(student);
  return (event.groups || []).filter(function (group) { return String(group.grade) === grade; });
}
function studentInfo_(s) { return { grade: s.grade, classroom: s.classroom, number: s.number, name: s.name }; }

function studentOpen_(request) {
  var auth = authenticate_(request);
  if (auth.error) return auth;
  var s = auth.student, event = auth.event;
  if (s.mustChange) return { mustChangeCode: true, schoolName: event.schoolName, schoolYear: event.schoolYear, round: event.round, student: studentInfo_(s) };
  var record = latestRecord_(event, studentKey_(s.grade, s.classroom, s.number));
  return { student: studentInfo_(s), schoolName: event.schoolName, schoolYear: event.schoolYear, round: event.round,
    open: event.open && s.allowed, courses: event.subjects[targetGrade_(s)] || [], groups: groupsFor_(event, s),
    selections: record ? record.selections : s.retained, submittedAt: record ? record.submittedAt : null,
    lockedSelections: s.retained, reselectionAllowed: s.allowed };
}

function studentChangeCode_(request) {
  var auth = authenticate_(request);
  if (auth.error) return auth;
  var s = auth.student, event = auth.event;
  var next = String(request.newCode == null ? '' : request.newCode);
  if (!s.mustChange) return { error: '이미 코드를 변경했습니다. 잊었다면 선생님께 재발급을 요청하세요.' };
  if (!/^[0-9]{6}$/.test(next)) return { error: '새 코드는 6자리 숫자여야 합니다.' };
  if (next === String(request.code)) return { error: '받은 코드와 다른 새 코드를 정하세요.' };
  if (/^(.)\1{5}$/.test(next) || WEAK_CODES.indexOf(next) >= 0) return { error: '너무 쉬운 번호입니다. 다른 6자리를 정하세요.' };
  return withLock_(function () {
    s.hash = codeHash_(event.id, studentKey_(s.grade, s.classroom, s.number), next);
    s.mustChange = false;
    writeStudent_(event, s);
    return { message: '코드를 변경했습니다. 지금부터 새 코드로 접속하세요. 처음 받은 코드는 쓸 수 없습니다.' };
  });
}

// 선택 저장. 검사 순서는 지금 서버와 같다: 택n 개수 → 마감 → 신청 가능한 과목·중복 → 재선택 잠금 → 같은 과목 한 학기만.
// 통과하면 기록 시트에 한 줄 덧붙인다(appendRow 한 번, 잠금 없음 — 학생별 마지막 줄이 유효).
function studentSubmit_(request) {
  var auth = authenticate_(request);
  if (auth.error) return auth;
  var s = auth.student, event = auth.event;
  if (s.mustChange) return { error: '먼저 개인 코드를 새 6자리로 변경하세요.' };
  var selections = request.selections;
  if (!Array.isArray(selections)) return { error: '과목을 선택하세요.' };
  var groups = groupsFor_(event, s);
  for (var g = 0; g < groups.length; g++) {
    var picked = selections.filter(function (name) { return groups[g].courses.indexOf(name) >= 0; }).length;
    if (picked !== Number(groups[g].count)) return { error: groups[g].name + ': 정확히 ' + groups[g].count + '과목을 선택하세요.' };
  }
  if (!event.open) return { error: '수강신청이 마감되었습니다.' };
  var allowed = (event.subjects[targetGrade_(s)] || []).map(function (item) { return item.subject; });
  var unique = {};
  var valid = selections.length >= 1 && selections.length <= allowed.length && selections.every(function (name) {
    if (typeof name !== 'string' || allowed.indexOf(name) < 0 || unique[name]) return false;
    unique[name] = true;
    return true;
  });
  if (!valid) return { error: '신청 가능한 과목을 중복 없이 선택하세요.' };
  var key = studentKey_(s.grade, s.classroom, s.number);
  if (!s.allowed) {
    var before = latestRecord_(event, key);
    var current = before ? before.selections : s.retained;
    if (JSON.stringify(current.slice().sort()) !== JSON.stringify(selections.slice().sort())) {
      return { error: '폐강 과목 신청 학생만 재선택할 수 있습니다. 기존 신청은 유지됩니다.' };
    }
  }
  if (!s.retained.every(function (name) { return selections.indexOf(name) >= 0; })) {
    return { error: '폐강되지 않은 기존 선택 과목은 변경할 수 없습니다.' };
  }
  var bases = {};
  for (var i = 0; i < selections.length; i++) {
    var base = baseSubject_(selections[i]);
    if (bases[base]) return { error: '1학기와 2학기에 같은 과목을 중복 신청할 수 없습니다.' };
    bases[base] = true;
  }
  var at = now_();
  recordSheet_(event.id).appendRow([at, s.grade, s.classroom, s.number, JSON.stringify(selections), 'submit']);
  cache_().put(recordCacheKey_(event, key), JSON.stringify({ selections: selections, submittedAt: at }), CACHE_SECONDS);
  return { message: '신청이 저장되었습니다. 신청 이력도 기록했습니다.', submittedAt: at };
}

// ---- 설치(스프레드시트 메뉴) ----

function onOpen() {
  SpreadsheetApp.getUi().createMenu('수강신청')
    .addItem('관리 열쇠 만들기', 'installAdminKey')
    .addItem('관리 열쇠 보기', 'showAdminKey')
    .addToUi();
}

// 처음 한 번: 관리 열쇠를 만들어 Script Properties에 넣고 보여 준다(이때 구글이 권한 승인을 묻는다).
function installAdminKey() {
  var ui = SpreadsheetApp.getUi();
  if (props_().getProperty('adminKey')) {
    var answer = ui.alert('관리 열쇠가 이미 있습니다. 새로 만들면 앱에 넣어 둔 예전 열쇠는 쓸 수 없습니다. 새로 만들까요?', ui.ButtonSet.YES_NO);
    if (answer !== ui.Button.YES) return;
  }
  var key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  props_().setProperty('adminKey', key);
  pepper_();
  ui.alert('관리 열쇠(교육과정 관리 앱에 넣으세요. 다른 사람에게 알려 주지 마세요):\n\n' + key);
}

function showAdminKey() {
  var key = props_().getProperty('adminKey');
  SpreadsheetApp.getUi().alert(key ? '관리 열쇠:\n\n' + key : '관리 열쇠가 아직 없습니다. [관리 열쇠 만들기]를 먼저 실행하세요.');
}
