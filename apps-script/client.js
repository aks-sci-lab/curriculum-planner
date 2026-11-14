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

// 부하 측정용 가상 신청 설정(가상 과목·가상 학생만).
function appsScriptVirtualSetup({ classes = 4, perClass = 30, schoolYear = String(new Date().getFullYear()) } = {}) {
  const names = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);
  const first = names("가상 선택 가", 6), second = names("가상 선택 나", 6);
  const roster = [];
  for (let classroom = 1; classroom <= classes; classroom += 1) {
    for (let number = 1; number <= perClass; number += 1) roster.push({ grade: "1", classroom: String(classroom), number: String(number), name: `가상학생${classroom}-${number}` });
  }
  return {
    type: "course-application-setup", schoolName: "[부하 측정] 가상고등학교", schoolYear, round: "1",
    subjects: { "2": [...first.map((subject) => ({ subject, credit: 4, semester: "1" })), ...second.map((subject) => ({ subject, credit: 4, semester: "2" }))], "3": [] },
    groups: [{ id: "load-1", grade: "2", semester: "1", name: "1학기 택3", count: 3, courses: first }, { id: "load-2", grade: "2", semester: "2", name: "2학기 택3", count: 3, courses: second }],
    roster,
  };
}

// 가상 학생의 선택(그룹마다 정확히 n개, 학생 번호로 정해져 다시 돌려도 같다).
function appsScriptVirtualSelections(setup, index) {
  return setup.groups.flatMap((group, order) => Array.from({ length: group.count }, (_, pick) => group.courses[(index + order + pick * 2) % group.courses.length]))
    .filter((name, position, list) => list.indexOf(name) === position);
}

if (typeof module !== "undefined") module.exports = { appsScriptDelay, appsScriptCall, appsScriptSummary, appsScriptVirtualSetup, appsScriptVirtualSelections };
