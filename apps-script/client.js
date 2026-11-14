// Apps Script 웹 앱 호출 도우미(시제품). 브라우저와 Node 테스트가 함께 쓴다. 본 구현 때 supabase-client.js의 rpc() 자리에 들어갈 부분.
// 호출: POST, Content-Type text/plain(사전 요청 없는 단순 요청), 본문 JSON, redirect follow → 응답 JSON.
// 다시 시도하는 경우: 네트워크 오류, JSON이 아닌 응답(구글의 한도·오류 화면), HTTP 429·5xx, 응답의 retry: true.
// 다시 시도하지 않는 경우: 규칙 위반 같은 정상 응답의 error(그대로 돌려준다).

function appsScriptDelay(attempt, { baseMs = 500, maxMs = 8000, random = Math.random } = {}) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(ceiling / 2 + random() * ceiling / 2);
}

// 돌려주는 값: { ok, data, attempts, ms, kind } — kind: "ok" | "rule"(규칙·입력 오류) | "busy"(잠금) | "quota"(JSON 아님·429·5xx) | "network"
async function appsScriptCall(fetchFn, url, body, options = {}) {
  const { retries = 5, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now(), timeoutMs = 30000 } = options;
  const started = now();
  let kind = "network";
  let data = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt) await sleep(appsScriptDelay(attempt - 1, options));
    try {
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      let response;
      try {
        response = await fetchFn(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body), redirect: "follow", signal: controller?.signal });
      } finally { if (timer) clearTimeout(timer); }
      const text = await response.text();
      try { data = JSON.parse(text); } catch { data = null; }
      if (!data || typeof data !== "object") { kind = "quota"; data = { error: `서버가 JSON이 아닌 답을 보냈습니다(HTTP ${response.status}).` }; continue; }
      if (response.status === 429 || response.status >= 500) { kind = "quota"; continue; }
      if (data.retry === true) { kind = "busy"; continue; }
      return { ok: !data.error, data, attempts: attempt + 1, ms: now() - started, kind: data.error ? "rule" : "ok" };
    } catch (error) {
      kind = "network";
      data = { error: String(error?.message || error) };
    }
  }
  return { ok: false, data, attempts: retries + 1, ms: now() - started, kind };
}

// 측정 요약: 성공률, 다시 시도 횟수, 응답 시간 중앙값·95%, 오류 종류별 수.
function appsScriptSummary(results) {
  const times = results.filter((item) => item.ok).map((item) => item.ms).sort((a, b) => a - b);
  const at = (ratio) => times.length ? times[Math.min(times.length - 1, Math.ceil(times.length * ratio) - 1)] : null;
  const kinds = {};
  for (const item of results) if (!item.ok) kinds[item.kind] = (kinds[item.kind] || 0) + 1;
  return {
    total: results.length, success: times.length, successRate: results.length ? Math.round(times.length / results.length * 1000) / 10 : 0,
    retries: results.reduce((sum, item) => sum + item.attempts - 1, 0), retried: results.filter((item) => item.attempts > 1).length,
    median: at(0.5), p95: at(0.95), max: times.length ? times[times.length - 1] : null, errors: kinds,
  };
}

// 부하 측정용 가상 신청 설정(가상 과목·가상 학생만). 기본은 실제 규모: 현 1학년 10반 × 34명 + 현 2학년 10반 × 31명 = 650명.
function appsScriptVirtualSetup({ classes1 = 10, perClass1 = 34, classes2 = 10, perClass2 = 31, schoolYear = String(new Date().getFullYear()) } = {}) {
  const names = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);
  const courses = { "2": [names("가상 이학년 가", 6), names("가상 이학년 나", 6)], "3": [names("가상 삼학년 가", 6), names("가상 삼학년 나", 6)] };
  const roster = [];
  for (const [grade, classes, perClass] of [["1", classes1, perClass1], ["2", classes2, perClass2]]) {
    for (let classroom = 1; classroom <= classes; classroom += 1) {
      for (let number = 1; number <= perClass; number += 1) roster.push({ grade, classroom: String(classroom), number: String(number), name: `가상학생${grade}-${classroom}-${number}` });
    }
  }
  const subjects = {}, groups = [];
  for (const grade of ["2", "3"]) {
    subjects[grade] = courses[grade].flatMap((list, index) => list.map((subject) => ({ subject, credit: 4, semester: String(index + 1) })));
    courses[grade].forEach((list, index) => groups.push({ id: `load-${grade}-${index + 1}`, grade, semester: String(index + 1), name: `${grade}학년 ${index + 1}학기 택3`, count: 3, courses: list }));
  }
  return { type: "course-application-setup", schoolName: "[부하 측정] 가상고등학교", schoolYear, round: "1", subjects, groups, roster };
}

// 가상 학생의 선택(내년 학년 그룹마다 정확히 n개, 학생 순서로 정해져 다시 돌려도 같다). grade = 현 학년.
function appsScriptVirtualSelections(setup, index, grade = "1") {
  const target = String(Number(grade) + 1);
  return setup.groups.filter((group) => String(group.grade) === target)
    .flatMap((group, order) => Array.from({ length: group.count }, (_, pick) => group.courses[(index + order + pick * 2) % group.courses.length]))
    .filter((name, position, list) => list.indexOf(name) === position);
}

// '틀린 답' 세기: 느리거나 실패한 것과 달리, 성공이라고 답했는데 자료가 다른 경우와 정상 학생이 코드 오류·잠금을 받은 경우.
// students = [{ grade, classroom, number, sent(보낸 선택), submitted(제출 결과), reopened(제출 뒤 다시 연 결과), calls: [모든 호출 결과] }]
// entries = 교사 결과 읽기의 entries. 돌려주는 값: { wrongCode, lostSubmit, wrongStored, wrongShown, extraStored, total, examples }
function appsScriptWrongAnswers(students, entries) {
  const stored = new Map((entries || []).map((entry) => [`${entry.grade}-${entry.classroom}-${entry.number}`, entry]));
  const same = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
  const counts = { wrongCode: 0, lostSubmit: 0, wrongStored: 0, wrongShown: 0, extraStored: 0 };
  const examples = [];
  const note = (kind, student) => { counts[kind] += 1; if (examples.length < 10) examples.push(`${kind}: ${student.grade}-${student.classroom}-${student.number}`); };
  for (const student of students) {
    const key = `${student.grade}-${student.classroom}-${student.number}`;
    // 정상 학생(올바른 코드)이 '코드가 맞지 않습니다'·잠금·학년 선택을 받으면 서버가 학생을 잘못 본 것.
    if ((student.calls || []).some((call) => call && call.data && (call.data.locked || call.data.needGrade || /맞지 않습니다/.test(String(call.data.error || ""))))) note("wrongCode", student);
    const entry = stored.get(key);
    const ok = student.submitted && student.submitted.ok;
    if (ok && !(entry && entry.submittedAt)) note("lostSubmit", student);
    else if (ok && !same(entry.selections, student.sent)) note("wrongStored", student);
    else if (!ok && entry && entry.submittedAt) note("extraStored", student);
    if (ok && student.reopened && student.reopened.ok && !same(student.reopened.data.selections, student.sent)) note("wrongShown", student);
  }
  return { ...counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0), examples };
}

if (typeof module !== "undefined") module.exports = { appsScriptDelay, appsScriptCall, appsScriptSummary, appsScriptVirtualSetup, appsScriptVirtualSelections, appsScriptWrongAnswers };
