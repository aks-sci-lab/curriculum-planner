"use strict";
// 앱(교사 화면)과 수강신청 테스트봇 창 사이에서 학생 코드를 메모리로만 주고받는 postMessage 약속.
// 코드는 저장소(localStorage·IndexedDB)나 주소(URL)에 남기지 않는다. 주소에는 일회용 확인값(nonce)만 싣는다.
//   1) 앱이 test-bot.html#bridge=<nonce> 를 새 창으로 연다.
//   2) 봇 창이 window.opener 에 {type:"test-bot-ready", nonce} 를 보낸다.
//   3) 앱은 "내가 연 그 창"이고 nonce가 같을 때만 {type:"test-bot-codes", nonce, payload} 로 답한다.
//   4) 봇은 보낸 창이 window.opener 이고 nonce가 같을 때만 받는다.
// file:// 에서는 origin이 "null"(또는 "file://")로 와서 출처 비교가 의미 없으므로 창 참조와 nonce로 확인하고,
// http(s) 배포 주소에서는 같은 origin에서 온 메시지만 받는다.
var TestBotBridge = (() => {
  const READY = "test-bot-ready";
  const CODES = "test-bot-codes";
  // 앱 → 봇: 진행 안내(테스트 수강신청 생성 중·실패 등). 봇 → 앱: 교사 화면 대조·정리 요청과 그 응답.
  const STATUS = "test-bot-status";
  const TEACHER_REQUEST = "test-bot-teacher-request";
  const TEACHER_RESPONSE = "test-bot-teacher-response";
  const TEACHER_ACTIONS = ["applications", "locks", "close", "delete", "import"];
  const NONCE = /^[a-f0-9]{32}$/;
  const EVENT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const CODE = /^(?:\d{6}|[a-f0-9]{32})$/;

  function createNonce(cryptoObject) {
    const bytes = new Uint8Array(16);
    cryptoObject.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function nonceFromHash(hash) {
    const value = new URLSearchParams(String(hash || "").replace(/^#/, "")).get("bridge") || "";
    return NONCE.test(value) ? value : "";
  }

  function isFileLocation(location) {
    return String(location?.protocol || "") === "file:";
  }

  // postMessage 두 번째 인자. file:// 문서의 origin은 불투명("null")이라 "*" 외에는 전달되지 않는다.
  function targetOrigin(location) {
    return isFileLocation(location) ? "*" : String(location.origin);
  }

  function originAllowed(origin, location) {
    if (isFileLocation(location)) return origin === "null" || origin === "file://" || origin === "";
    return !!origin && origin !== "null" && origin === String(location.origin);
  }

  function messageMatches(event, type, { expectedSource, nonce, location }) {
    if (!event || !expectedSource || event.source !== expectedSource) return false;
    if (!NONCE.test(String(nonce || ""))) return false;
    if (!originAllowed(event.origin, location)) return false;
    const data = event.data;
    return !!data && typeof data === "object" && data.type === type && data.nonce === nonce;
  }

  // 형식만 맞으면 메시지 자료를, 아니면 null. type별 검증은 아래 함수들이 한다.
  function accept(event, type, options) {
    return messageMatches(event, type, options) ? event.data : null;
  }

  // 앱 쪽: 봇이 보낸 교사 화면 요청. 연결된 신청 하나에 대해서만, 정해진 작업만 받는다.
  function acceptTeacherRequest(event, options) {
    const data = accept(event, TEACHER_REQUEST, options);
    if (!data || !TEACHER_ACTIONS.includes(data.action) || !/^[a-z0-9-]{1,40}$/i.test(String(data.id || ""))) return null;
    if (!EVENT_ID.test(String(data.eventId || "")) || data.eventId !== options.eventId) return null;
    return { id: String(data.id), action: data.action, eventId: data.eventId };
  }

  // 봇 쪽: 앱이 보낸 교사 화면 응답.
  function acceptTeacherResponse(event, options) {
    const data = accept(event, TEACHER_RESPONSE, options);
    return data && typeof data.id === "string" ? data : null;
  }

  // 앱 쪽: 내가 연 봇 창이 보낸 준비 신호인지.
  function acceptReady(event, options) {
    return messageMatches(event, READY, options);
  }

  // 봇 쪽: 나를 연 앱 창이 보낸 코드인지. 맞으면 검증한 자료를, 아니면 null을 돌려준다.
  function acceptCodes(event, options) {
    if (!messageMatches(event, CODES, options)) return null;
    try { return validatePayload(event.data.payload); } catch { return null; }
  }

  function text(value) {
    return String(value ?? "").trim();
  }

  function validatePayload(payload) {
    if (!payload || typeof payload !== "object") throw new Error("받은 자료 형식이 잘못되었습니다.");
    const eventId = text(payload.eventId);
    if (!EVENT_ID.test(eventId)) throw new Error("수강신청 식별자가 잘못되었습니다.");
    if (!Array.isArray(payload.students) || !payload.students.length) throw new Error("학생 코드가 없습니다.");
    const students = payload.students.map((student) => {
      const item = {
        id: text(student?.id), grade: text(student?.grade), classroom: text(student?.classroom),
        number: text(student?.number), name: text(student?.name), code: text(student?.code),
      };
      if (!/^[12]$/.test(item.grade) || !item.classroom || !item.number || !CODE.test(item.code)) {
        throw new Error("학생 코드 형식이 잘못되었습니다.");
      }
      return item;
    });
    return {
      eventId, link: text(payload.link), schoolName: text(payload.schoolName), schoolYear: text(payload.schoolYear),
      round: text(payload.round), partial: payload.partial === true, sentAt: text(payload.sentAt), students,
      autoRun: payload.autoRun === true, testEvent: payload.testEvent === true,
    };
  }

  function studentKey(student) {
    const part = (value) => /^\d+$/.test(text(value)) ? String(Number(text(value))) : text(value);
    return student.id ? `id:${student.id}` : `${part(student.grade)}-${part(student.classroom)}-${part(student.number)}`;
  }

  // 재발급처럼 일부 학생만 온 자료는 같은 신청의 기존 목록에 덮어쓴다. 다른 신청이면 새 목록으로 바꾼다.
  function mergePayload(current, incoming) {
    if (!incoming.partial || !current || current.eventId !== incoming.eventId) return { ...incoming, partial: false };
    const byKey = new Map(current.students.map((student) => [studentKey(student), student]));
    const seat = (student) => `${text(student.grade)}-${Number(student.classroom)}-${Number(student.number)}`;
    for (const student of incoming.students) {
      const key = byKey.has(studentKey(student)) ? studentKey(student)
        : [...byKey.keys()].find((existing) => seat(byKey.get(existing)) === seat(student));
      byKey.set(key || studentKey(student), { ...(key ? byKey.get(key) : {}), ...student });
    }
    return { ...current, students: [...byKey.values()], sentAt: incoming.sentAt || current.sentAt, partial: false, autoRun: false };
  }

  function buildPayload(codes, meta = {}, link = "", partial = false) {
    return {
      eventId: codes?.id, link, partial,
      schoolName: meta.schoolName || "", schoolYear: meta.schoolYear || "", round: meta.round || "",
      sentAt: new Date().toISOString(),
      students: (codes?.students || []).map((student) => ({
        id: student.id || "", grade: String(student.grade ?? ""), classroom: String(student.classroom ?? ""),
        number: String(student.number ?? ""), name: String(student.name ?? ""), code: String(student.code ?? ""),
      })),
    };
  }

  return {
    READY, CODES, STATUS, TEACHER_REQUEST, TEACHER_RESPONSE, TEACHER_ACTIONS,
    createNonce, nonceFromHash, targetOrigin, originAllowed, accept,
    acceptReady, acceptCodes, acceptTeacherRequest, acceptTeacherResponse, validatePayload, mergePayload, buildPayload,
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = TestBotBridge;
