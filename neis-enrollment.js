"use strict";
// 나이스(NEIS) '수강학생 편성' 자료 읽기·학생 연결(순수 계산, 화면·저장과 무관). 화면 연결은 course-checks.js.
// 파일 형식: 1행 병합 머리(개설 과목 / 편성 학생), 2행 열 머리 + 자동 필터
//   학년도 | 학기 | 학년 | 편제명 | 개설과목(학점) | 개설강의실 | 계열/학년/학과 | 반 | 번호 | 성명
// 사용자가 파일을 손대지 않고 그대로 올린다(머리 행 자동 탐지, 열은 이름으로 찾음, 숫자 칸이 텍스트여도 읽음).
// 개인정보: 성명은 지난 학년도 기록을 지금 학생에게 잇는 데에만 쓰고 저장하지 않는다.
// 저장(neisEnrollmentStore)은 학생 키(현 학년-반-번호)·학년도·학기·학년·편제명·과목명·학점만 남긴다(성명·강의실·계열 없음).

// 열 머리(띄어쓰기 무시) → 필드. 앞의 이름일수록 우선한다.
var NEIS_ENROLLMENT_HEADERS = {
  year: ["학년도"],
  semester: ["학기"],
  grade: ["학년"],
  family: ["편제명", "편제", "교과(군)", "교과군", "교과"],
  subject: ["개설과목(학점)", "개설과목", "과목(학점)", "과목명", "과목"],
  classroom: ["반"],
  number: ["번호"],
  name: ["성명", "이름", "학생명"]
};
// 성명 열은 없어도 된다(사용자가 성명 열을 지우거나 비워서 올린 경우). 이번 학년도 행은 학년·반·번호만으로 잇는다.
var NEIS_ENROLLMENT_REQUIRED = ["year", "semester", "grade", "subject", "classroom", "number"];
// 성명 앞 학적 변동 표시. '(미재학) 홍길동'처럼 붙는다. 이 표시가 있으면 지금 재학생이 아니다.
var NEIS_ENROLLMENT_LEFT = /^\s*[(（\[]\s*(미재학|전출|자퇴|퇴학|제적|면제|유예|휴학|졸업)\s*[)）\]]\s*/;
// 성명을 가리면서 학적 변동 표시가 깨진 경우('(미재학) 홍길동' → '(00'): 성명은 여는 괄호로 시작하지 않으므로 학적 변동으로 본다.
var NEIS_ENROLLMENT_LEFT_GARBLED = /^\s*[(（\[]/;
// 과목명 앞 운영 표시('(공동)물리학 실험(3)', '(소인수)경제(3)'): 과목명에서 떼어 낸다(숫자만 든 괄호는 아니다).
var NEIS_ENROLLMENT_SUBJECT_LABEL = /^\s*[(（]\s*([^()（）\d][^()（）]*?)\s*[)）]\s*/;
// 창의적 체험활동 행은 교과 학점에 넣지 않는다.
var NEIS_ENROLLMENT_CREATIVE = /창의적|체험활동|자율활동|자치활동|동아리활동|진로활동|봉사활동/;

function neisEnrollmentHeaderKey(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

// 머리 행 한 줄에서 필드 → 열 번호. 필수 열이 다 있어야 한다.
function neisEnrollmentColumns(row) {
  const cells = (row || []).map(neisEnrollmentHeaderKey);
  const columns = {};
  for (const [field, names] of Object.entries(NEIS_ENROLLMENT_HEADERS)) {
    for (const name of names) {
      const index = cells.findIndex((cell, column) => cell === name && !Object.values(columns).includes(column));
      if (index >= 0) { columns[field] = index; break; }
    }
    if (columns[field] === undefined && field === "subject") {
      const index = cells.findIndex((cell) => cell.startsWith("개설과목"));
      if (index >= 0) columns.subject = index;
    }
  }
  return NEIS_ENROLLMENT_REQUIRED.every((field) => columns[field] !== undefined) ? columns : null;
}

// 시트 앞 몇 줄(1~3행 + 여유)에서 머리 행을 찾는다. 없으면 null(나이스 형식이 아님).
function neisEnrollmentDetect(rows, { scan = 5 } = {}) {
  for (let index = 0; index < Math.min(scan, (rows || []).length); index++) {
    const columns = neisEnrollmentColumns(rows[index]);
    if (columns) return { headerRow: index, columns };
  }
  return null;
}

// "9반"·"9"·" 9 "·"1학년"·"2학기" → "9". 숫자가 아니면 정리한 글자를 그대로.
function neisEnrollmentNumber(value) {
  const text = String(value ?? "").replace(/\s+/g, "");
  const match = text.match(/^0*(\d+)(?:\.0+)?(?:반|번|학년|학기|학년도)?$/);
  return match ? String(Number(match[1])) : text;
}

// "공통국어2(4)" → { name: "공통국어2", credit: 4 }. 끝 괄호의 숫자만 학점으로 본다(과목명 안의 괄호는 그대로 둔다).
// 앞의 운영 표시는 떼어 label로 둔다: "(공동)물리학 실험(3)" → { name: "물리학 실험", credit: 3, label: "공동" }.
function neisEnrollmentSubject(value) {
  let text = String(value ?? "").replace(/\s+/g, " ").trim();
  const head = text.match(NEIS_ENROLLMENT_SUBJECT_LABEL);
  const label = head && text.slice(head[0].length).trim() ? head[1].trim() : "";
  if (label) text = text.slice(head[0].length).trim();
  const extra = label ? { label } : {};
  const match = text.match(/^(.*\S)\s*[(（]\s*(\d+(?:\.\d+)?)\s*(?:학점)?\s*[)）]$/);
  if (match && !/^[(（]/.test(match[1].trim())) return { name: match[1].trim(), credit: Number(match[2]), ...extra };
  return { name: text, credit: null, ...extra };
}

// 이름이 가려진 자료: 김00, rkd00, 김OO, 김○○, 김*수, 홍**.
function neisEnrollmentMasked(name) {
  const text = String(name ?? "").replace(/\s+/g, "");
  if (!text) return true;
  return /[○◯●◎＊*]/.test(text) || /^[가-힣A-Za-z]{1,6}(?:0{2,}|[Oo]{2,}|[xX]{2,})$/.test(text);
}

// "(미재학) 홍길동" → { name: "홍길동", enrolled: false, status: "미재학" }
// 성명을 가려 표시가 깨진 "(00"·"(미재"도 학적 변동으로 본다(status "학적 변동", garbled). 빈 성명은 가려진 이름으로 본다.
function neisEnrollmentName(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const left = text.match(NEIS_ENROLLMENT_LEFT);
  if (!left && NEIS_ENROLLMENT_LEFT_GARBLED.test(text)) return { name: text, enrolled: false, status: "학적 변동", garbled: true, masked: true };
  const name = left ? text.slice(left[0].length).trim() : text;
  return { name, enrolled: !left, status: left ? left[1] : "", masked: neisEnrollmentMasked(name) };
}

// 시트 하나(행 배열)를 읽는다. 나이스 형식이 아니면 null.
function neisEnrollmentParseRows(rows, { sheetName = "" } = {}) {
  const detected = neisEnrollmentDetect(rows);
  if (!detected) return null;
  const { headerRow, columns } = detected;
  const records = [];
  // other: 반이 숫자가 아닌 행(예: '12반(공동교육과정반)' — 다른 학교 학생). garbled: 학적 변동 표시가 가려진 행.
  const skipped = { empty: 0, invalid: 0, creative: 0, header: 0, other: 0 };
  let garbled = 0;
  for (const row of (rows || []).slice(headerRow + 1)) {
    const cell = (field) => columns[field] === undefined ? "" : String(row?.[columns[field]] ?? "").trim();
    if (!row || !row.some((value) => String(value ?? "").trim())) { skipped.empty++; continue; }
    if (neisEnrollmentColumns(row)) { skipped.header++; continue; }
    const year = neisEnrollmentNumber(cell("year"));
    const semester = neisEnrollmentNumber(cell("semester"));
    const grade = neisEnrollmentNumber(cell("grade"));
    const subject = neisEnrollmentSubject(cell("subject"));
    const person = neisEnrollmentName(cell("name"));
    const family = cell("family").replace(/\s+/g, " ");
    const classroom = neisEnrollmentNumber(cell("classroom"));
    const number = neisEnrollmentNumber(cell("number"));
    if (!/^\d{4}$/.test(year) || !["1", "2"].includes(semester) || !/^[1-9]$/.test(grade) || !subject.name || !/^\d+$/.test(number)) { skipped.invalid++; continue; }
    if (!/^\d+$/.test(classroom)) { skipped.other++; continue; }
    if (NEIS_ENROLLMENT_CREATIVE.test(`${family} ${subject.name}`)) { skipped.creative++; continue; }
    if (person.garbled) garbled++;
    records.push({ year, semester, grade, classroom, number,
      name: person.name, enrolled: person.enrolled, status: person.status, masked: person.masked, family, subject: subject.name, credit: subject.credit });
  }
  return { sheetName, headerRow, records, skipped, garbled };
}

// 통합 문서(시트 목록)에서 나이스 형식 시트를 모두 읽는다. 하나도 없으면 null(기존 결과 양식으로 넘긴다).
function neisEnrollmentParse(sheets) {
  const parts = (sheets || []).map((sheet) => neisEnrollmentParseRows(sheet?.rows || [], { sheetName: sheet?.name || "" })).filter(Boolean);
  if (!parts.length) return null;
  const records = parts.flatMap((part) => part.records);
  const terms = [...new Set(records.map((record) => `${record.year}-${record.semester}`))].sort();
  return { records, terms, sheets: parts.map((part) => part.sheetName), garbled: parts.reduce((sum, part) => sum + part.garbled, 0), skipped: parts.reduce((sum, part) => {
    for (const [key, value] of Object.entries(part.skipped)) sum[key] = (sum[key] || 0) + value;
    return sum;
  }, {}) };
}

// CSV 글자 → 행 배열(따옴표·줄바꿈 포함 칸 지원).
function neisEnrollmentCsvRows(text) {
  const source = String(text ?? "").replace(/^﻿/, "");
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// CSV 파일 바이트 → 글자. UTF-8이 아니면 EUC-KR(엑셀 기본 저장)로 읽는다.
function neisEnrollmentDecode(buffer) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { return new TextDecoder("euc-kr").decode(buffer); }
}

// 같은 행(같은 학생·학기·과목)은 한 번만 둔다(여러 파일을 겹쳐 올려도 된다).
function neisEnrollmentRecordId(record, keyOf = (value) => String(value ?? "").replace(/\s+/g, "")) {
  return [record.year, record.semester, record.grade, record.classroom, record.number, record.name, keyOf(record.subject)].join("|");
}

function neisEnrollmentDedupe(records, keyOf) {
  const seen = new Set();
  const list = [];
  for (const record of records || []) {
    const id = neisEnrollmentRecordId(record, keyOf);
    if (seen.has(id)) continue;
    seen.add(id);
    list.push(record);
  }
  return list;
}

function neisEnrollmentSeat(grade, classroom, number) {
  return `${neisEnrollmentNumber(grade)}-${neisEnrollmentNumber(classroom)}-${neisEnrollmentNumber(number)}`;
}

// 학생 연결.
//  · 지금 학년도(currentYear) 행: 학년·반·번호가 지금 학생 자리(키 "학년-반-번호")다.
//  · 지난 학년도 행: 이름으로 지금 학년도 학생을 찾는다(지난 학년 + 지난 햇수 = 지금 학년인 학생만).
//    같은 이름이 여럿이면 수강 기록(위계 규칙: 지난 과목 → 지금 과목 이어 듣기)으로 좁히고, 그래도 남으면 choices(화면에서 고른 값)를 쓴다.
//  · 이름이 가려진 자료(김00 등)는 이름으로 잇지 않는다(masked).
//  · '(미재학)' 학생은 연결하지 않고 따로 센다(withdrawn).
// choices: { [지난 학년도 사람 id]: "학년-반-번호" | "none" }
// 돌려주는 값의 students: Map 키 → { key, grade, classroom, number, records: [{ year, semester, grade, family, subject, credit }], terms: Set }
function neisEnrollmentLink(records, { currentYear = "", keyOf = null, rules = [], choices = {} } = {}) {
  const key = typeof keyOf === "function" ? keyOf : (value) => String(value ?? "").replace(/\s+/g, "").toLowerCase();
  const list = neisEnrollmentDedupe(records, key);
  const year = String(currentYear || list.reduce((max, record) => record.year > max ? record.year : max, ""));
  const persons = new Map();
  for (const record of list) {
    const id = [record.year, record.grade, record.classroom, record.number, record.name].join("|");
    if (!persons.has(id)) persons.set(id, { id, year: record.year, grade: record.grade, classroom: record.classroom, number: record.number,
      name: record.name, masked: record.masked, enrolled: true, status: "", records: [] });
    const person = persons.get(id);
    if (!record.enrolled) { person.enrolled = false; person.status = record.status || "미재학"; }
    person.records.push(record);
  }
  const students = new Map();
  const withdrawn = [];
  const unlinked = [];
  const ambiguous = [];
  const termGrades = new Map();
  for (const record of list) {
    const term = `${record.year}-${record.semester}`;
    if (!termGrades.has(term)) termGrades.set(term, new Set());
    termGrades.get(term).add(record.grade);
  }
  const plain = (record) => ({ year: record.year, semester: record.semester, grade: record.grade, family: record.family, subject: record.subject, credit: record.credit });
  const attach = (student, person) => {
    for (const record of person.records) {
      student.records.push(plain(record));
      student.terms.add(`${record.year}-${record.semester}`);
    }
    student.sources.push(person.id);
  };
  // 지금 학년도 학생
  const currentByName = new Map();
  for (const person of persons.values()) {
    if (person.year !== year) continue;
    if (!person.enrolled) { withdrawn.push(person); continue; }
    const seat = neisEnrollmentSeat(person.grade, person.classroom, person.number);
    if (!students.has(seat)) {
      students.set(seat, { key: seat, grade: neisEnrollmentNumber(person.grade), classroom: neisEnrollmentNumber(person.classroom),
        number: neisEnrollmentNumber(person.number), records: [], terms: new Set(), sources: [] });
    }
    const student = students.get(seat);
    attach(student, person);
    if (!person.masked) {
      const nameKey = `${person.name}|${student.grade}`;
      if (!currentByName.has(nameKey)) currentByName.set(nameKey, new Set());
      currentByName.get(nameKey).add(seat);
    }
  }
  // 지난 학년도 사람 → 지금 학생
  const maskedTerms = new Set();
  const groups = new Map();
  for (const person of persons.values()) {
    if (person.year >= year) continue;
    if (!person.enrolled) { withdrawn.push(person); continue; }
    if (person.masked) {
      unlinked.push({ person, reason: "masked" });
      for (const record of person.records) maskedTerms.add(`${record.year}-${record.semester}|${record.grade}`);
      continue;
    }
    const expected = String(Number(person.grade) + Number(year) - Number(person.year));
    const groupKey = `${person.year}|${person.name}|${expected}`;
    if (!groups.has(groupKey)) groups.set(groupKey, { priors: [], candidates: [...(currentByName.get(`${person.name}|${expected}`) || [])] });
    groups.get(groupKey).priors.push(person);
  }
  // 이어 듣기 점수: 지난 과목이 앞 과목, 지금 학년도 과목(또는 같은 과목)이 뒤 과목인 규칙 수.
  const ruleList = (rules || []).filter((rule) => rule && !rule.off).map((rule) => [key(rule.before), key(rule.after)]);
  const score = (person, seat) => {
    const before = new Set(person.records.map((record) => key(record.subject)));
    const after = new Set(students.get(seat).records.map((record) => key(record.subject)));
    let value = 0;
    for (const [a, b] of ruleList) if (before.has(a) && after.has(b)) value++;
    return value;
  };
  for (const group of groups.values()) {
    const taken = new Set();
    let priors = [];
    for (const person of group.priors) {
      const choice = choices?.[person.id];
      if (choice === "none") { unlinked.push({ person, reason: "chosen-none" }); continue; }
      if (choice && students.has(choice)) { attach(students.get(choice), person); taken.add(choice); continue; }
      priors.push(person);
    }
    const candidates = group.candidates.filter((seat) => !taken.has(seat));
    if (!priors.length) continue;
    if (!candidates.length) { priors.forEach((person) => unlinked.push({ person, reason: "no-match" })); continue; }
    if (priors.length === 1 && candidates.length === 1) { attach(students.get(candidates[0]), priors[0]); continue; }
    // 여럿: 점수가 가장 높은 짝짓기가 하나뿐이면 그대로 잇는다(사람 수가 적을 때만 모두 따져 본다).
    let best = null, bestScore = -1, tie = false;
    const size = Math.min(priors.length, candidates.length);
    const walk = (index, used, pairs, total) => {
      if (index === priors.length) {
        if (pairs.length !== size) return;
        if (total > bestScore) { best = [...pairs]; bestScore = total; tie = false; }
        else if (total === bestScore) tie = true;
        return;
      }
      for (const seat of candidates) {
        if (used.has(seat)) continue;
        used.add(seat); pairs.push([priors[index], seat]);
        walk(index + 1, used, pairs, total + score(priors[index], seat));
        pairs.pop(); used.delete(seat);
      }
      walk(index + 1, used, pairs, total);
    };
    if (priors.length <= 5 && candidates.length <= 5) walk(0, new Set(), [], 0);
    if (best && !tie && bestScore > 0) {
      const linked = new Set();
      for (const [person, seat] of best) { attach(students.get(seat), person); linked.add(person); }
      priors.filter((person) => !linked.has(person)).forEach((person) => unlinked.push({ person, reason: "no-match" }));
      continue;
    }
    priors.sort((a, b) => Number(a.classroom) - Number(b.classroom) || Number(a.number) - Number(b.number));
    for (const person of priors) ambiguous.push({ id: person.id, person, candidates: [...candidates] });
  }
  // 전입생: 이 자료에 그 학년 기록이 있는 학기인데 그 학생 기록이 없으면(이름이 가려진 학기·동명이인 대기 학생은 빼고) 그 학기를 missing에 둔다.
  const pending = new Set(ambiguous.flatMap((item) => item.candidates));
  const missing = new Map();
  for (const student of students.values()) {
    if (pending.has(student.key)) continue;
    const gaps = [];
    for (const [term, gradeSet] of termGrades) {
      const [termYear] = term.split("-");
      const gradeThen = String(Number(student.grade) - (Number(year) - Number(termYear)));
      if (Number(gradeThen) < 1 || !gradeSet.has(gradeThen) || student.terms.has(term) || maskedTerms.has(`${term}|${gradeThen}`)) continue;
      gaps.push(`${term}-${gradeThen}`);
    }
    if (gaps.length) missing.set(student.key, gaps.sort());
  }
  const countPeople = (items) => new Set(items.map((person) => person.masked ? person.id : `${person.name}|${Number(person.grade) + Number(year) - Number(person.year)}`)).size;
  return {
    currentYear: year, terms: [...termGrades.keys()].sort(), termGrades, students, missing, pending, maskedTerms, ambiguous,
    withdrawn, unlinked, counts: {
      linked: students.size, withdrawn: countPeople(withdrawn), transfers: missing.size,
      unlinked: unlinked.filter((item) => item.reason !== "masked").length, masked: unlinked.filter((item) => item.reason === "masked").length,
      ambiguous: ambiguous.length
    }
  };
}

// 연결 결과 → 저장 형식(최소). grades: 저장할 지금 학년(점검은 현 1·2학년만 한다).
//  { v: 1, currentYear, terms: ["2025-1", …], termGrades: { "2025-1": ["1","2"] }, files: [{ name, uploadedAt }],
//    subjects: [[편제명, 과목명, 학점|null]], students: { "2-3-12": { "2025-1-1": [과목 번호…] } }, missing: { "2-3-12": ["2025-1-1"] },
//    counts: { linked, withdrawn, transfers, unlinked, masked, ambiguous } }
function neisEnrollmentStore(link, { files = [], grades = ["1", "2"], previous = null } = {}) {
  const subjects = [];
  const subjectIndex = new Map();
  const subjectId = (family, name, credit) => {
    const id = `${family}|${name}|${credit ?? ""}`;
    if (!subjectIndex.has(id)) { subjectIndex.set(id, subjects.length); subjects.push([family, name, credit ?? null]); }
    return subjectIndex.get(id);
  };
  const students = {};
  const termGrades = {};
  for (const [term, set] of link.termGrades || []) termGrades[term] = [...set].sort();
  const keep = new Set(grades.map(String));
  for (const student of link.students.values()) {
    if (!keep.has(String(student.grade))) continue;
    const terms = {};
    for (const record of student.records) {
      const term = `${record.year}-${record.semester}-${record.grade}`;
      (terms[term] ||= []).push(subjectId(record.family, record.subject, record.credit));
    }
    students[student.key] = terms;
  }
  // 이번에 올린 자료에 없는 학기는 예전 저장분을 그대로 둔다(성명을 저장하지 않으므로 예전 학기를 다시 연결할 수는 없다).
  const old = neisEnrollmentNormalize(previous);
  const kept = [];
  if (old && old.currentYear === link.currentYear) {
    for (const term of old.terms.filter((item) => !(item in termGrades))) {
      kept.push(term);
      termGrades[term] = old.termGrades[term] || [];
      for (const [key, entry] of Object.entries(old.students)) {
        for (const [termKey, ids] of Object.entries(entry)) {
          if (!termKey.startsWith(`${term}-`)) continue;
          const target = students[key] ||= {};
          target[termKey] = ids.map((id) => subjectId(...old.subjects[id]));
        }
      }
    }
  }
  // 전입생(기록 없는 학기): 그 학년 기록이 있는 학기인데 이 학생 기록이 없으면. 이름이 가려진 학기·동명이인 대기 학생은 빼고 본다.
  const missing = {};
  for (const [key, entry] of Object.entries(students)) {
    if (link.pending?.has(key)) continue;
    const grade = key.split("-")[0];
    const have = new Set(Object.keys(entry).map((termKey) => termKey.split("-").slice(0, 2).join("-")));
    const gaps = [];
    for (const [term, gradeList] of Object.entries(termGrades)) {
      const gradeThen = String(Number(grade) - (Number(link.currentYear) - Number(term.split("-")[0])));
      if (Number(gradeThen) < 1 || !gradeList.includes(gradeThen) || have.has(term) || link.maskedTerms?.has(`${term}|${gradeThen}`)) continue;
      gaps.push(`${term}-${gradeThen}`);
    }
    if (gaps.length) missing[key] = gaps.sort();
  }
  return {
    v: 1, currentYear: link.currentYear, terms: Object.keys(termGrades).sort(), termGrades,
    files: [...(old && old.currentYear === link.currentYear ? old.files : []), ...files].slice(-12), subjects, students, missing,
    counts: { ...link.counts, linked: Object.keys(students).length, transfers: Object.keys(missing).length }, kept
  };
}

// 저장분 정리(모양이 다르면 버린다).
function neisEnrollmentNormalize(value) {
  const object = (item) => Boolean(item) && typeof item === "object" && !Array.isArray(item);
  if (!object(value) || Number(value.v) !== 1 || !/^\d{4}$/.test(String(value.currentYear || ""))) return null;
  const text = (item, max = 200) => String(item ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const subjects = (Array.isArray(value.subjects) ? value.subjects : []).map((item) => Array.isArray(item)
    ? [text(item[0], 60), text(item[1], 120), Number(item[2]) > 0 ? Number(item[2]) : null] : ["", "", null]);
  const terms = (Array.isArray(value.terms) ? value.terms : []).map(String).filter((term) => /^\d{4}-[12]$/.test(term)).sort();
  const termGrades = {};
  for (const term of terms) termGrades[term] = (Array.isArray(value.termGrades?.[term]) ? value.termGrades[term] : []).map(String).filter((grade) => /^[1-9]$/.test(grade));
  const students = {};
  for (const [key, entry] of Object.entries(object(value.students) ? value.students : {})) {
    if (!/^\d-\d{1,3}-\d{1,3}$/.test(key) || !object(entry)) continue;
    const clean = {};
    for (const [termKey, ids] of Object.entries(entry)) {
      if (!/^\d{4}-[12]-[1-9]$/.test(termKey) || !Array.isArray(ids)) continue;
      clean[termKey] = ids.filter((id) => Number.isInteger(id) && id >= 0 && id < subjects.length);
    }
    students[key] = clean;
  }
  const missing = {};
  for (const [key, list] of Object.entries(object(value.missing) ? value.missing : {})) {
    if (students[key] && Array.isArray(list)) missing[key] = list.map(String).filter((item) => /^\d{4}-[12]-[1-9]$/.test(item));
  }
  const count = (item) => Number.isInteger(Number(item)) && Number(item) >= 0 ? Number(item) : 0;
  const counts = object(value.counts) ? value.counts : {};
  return {
    v: 1, currentYear: String(value.currentYear), terms, termGrades,
    files: (Array.isArray(value.files) ? value.files : []).filter(object).map((file) => ({ name: text(file.name), uploadedAt: text(file.uploadedAt, 60) })).slice(-12),
    subjects, students, missing,
    counts: Object.fromEntries(["linked", "withdrawn", "transfers", "unlinked", "masked", "ambiguous"].map((name) => [name, count(counts[name])])),
    kept: (Array.isArray(value.kept) ? value.kept : []).map(String).filter((term) => terms.includes(term))
  };
}

// 저장분에서 학생 한 명의 기록. 없으면 null.
//  records: [{ year, semester, grade, family, name, credit }], missing: 기록이 없는 학기 칸(["sem11", …]), terms: ["2025-1", …]
//  fields: 이 자료가 다루는 학기 칸(기록이 있는 칸 + missing). 여기 없는 칸(올리지 않은 학기)은 이수 여부를 모른다.
function neisEnrollmentStudent(store, grade, classroom, number) {
  const entry = store?.students?.[neisEnrollmentSeat(grade, classroom, number)];
  if (!entry) return null;
  const records = [];
  for (const [termKey, ids] of Object.entries(entry)) {
    const [year, semester, gradeThen] = termKey.split("-");
    for (const id of ids) {
      const [family, name, credit] = store.subjects[id] || [];
      if (name) records.push({ year, semester, grade: gradeThen, family, name, credit });
    }
  }
  const missing = (store.missing?.[neisEnrollmentSeat(grade, classroom, number)] || []).map((termKey) => {
    const [, semester, gradeThen] = termKey.split("-");
    return `sem${gradeThen}${semester}`;
  });
  const fields = new Set(missing);
  for (const termKey of Object.keys(entry)) {
    const [, semester, gradeThen] = termKey.split("-");
    fields.add(`sem${gradeThen}${semester}`);
  }
  return { records, missing: [...new Set(missing)], fields: [...fields].sort(),
    terms: [...new Set(Object.keys(entry).map((termKey) => termKey.split("-").slice(0, 2).join("-")))].sort() };
}
