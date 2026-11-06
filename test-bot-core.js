"use strict";
// 수강신청 테스트봇의 순수 함수 모음(화면·저장소 없이 동작). test-bot.js(화면)와 tests/test-bot.test.cjs가 함께 쓴다.
// - 선택 생성기: 그룹마다 정확히 n과목, 1·2학기 같은 과목 중복 금지, 인기도 치우침, 규칙 위반 만들기
// - 결과 파일(로컬): 앱 2단계가 받는 두 형식(학생별 과목 표시 / 차수·선택과목 목록)
// - 웹 수강신청(서버): 앱 학생 화면과 같은 RPC로 가상 학생 한 명의 접속·신청·확인 과정
var TestBotCore = (() => {
  // ---------- 공통 ----------
  function createRng(seed = Date.now()) {
    let state = (Number(seed) >>> 0) || 1;
    return () => {
      state = (state + 0x6D2B79F5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(items, rng) {
    const list = [...items];
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  // 전체 중 비율(%)만큼 서로 다른 위치를 고른다. 0보다 크면 최소 1명.
  function pickIndexes(total, percent, rng) {
    const ratio = Math.max(0, Math.min(100, Number(percent) || 0)) / 100;
    const count = ratio > 0 ? Math.max(1, Math.round(total * ratio)) : 0;
    return new Set(shuffle([...Array(total).keys()], rng).slice(0, Math.min(total, count)));
  }

  function pickCount(total, count, rng, excluded = new Set()) {
    const pool = [...Array(total).keys()].filter((index) => !excluded.has(index));
    return new Set(shuffle(pool, rng).slice(0, Math.max(0, Math.min(pool.length, Math.floor(Number(count) || 0)))));
  }

  // 앱과 서버가 "1학기와 2학기에 같은 과목"을 판단하는 기준(과목명에서 "(n학기)"를 뗀 이름).
  function baseSubject(name) {
    return String(name ?? "").replace(/\s*[（(]\s*[12]\s*학기\s*[)）]/g, "").replace(/\s+/g, " ").trim();
  }

  const ROMAN = { "Ⅰ": "1", "Ⅱ": "2", "Ⅲ": "3", "Ⅳ": "4", "Ⅴ": "5", "ⅰ": "1", "ⅱ": "2", "ⅲ": "3", "ⅳ": "4", "ⅴ": "5" };
  function romanToDigits(name) {
    return String(name ?? "").replace(/[ⅠⅡⅢⅣⅤⅰⅱⅲⅳⅴ]/g, (char) => ROMAN[char]);
  }
  function hasRoman(name) {
    return /[ⅠⅡⅢⅣⅤⅰⅱⅲⅳⅴ]/.test(String(name ?? ""));
  }

  function compactName(name) {
    return romanToDigits(baseSubject(name)).replace(/[*＊★☆■↔]/g, "").replace(/\s+/g, "");
  }

  function semesterOfName(name) {
    return String(name ?? "").match(/[（(]\s*([12])\s*학기\s*[)）]/)?.[1] || "";
  }

  // ---------- 선택 생성기 ----------
  // 그룹: { name, count, courses: [과목명], semester }. 과목명은 서버·앱이 쓰는 이름 그대로("X (1학기)" 포함).
  function usableGroups(groups) {
    return (groups || []).filter((group) => Array.isArray(group?.courses) && group.courses.length &&
      Number.isInteger(Number(group.count)) && Number(group.count) >= 0);
  }

  // 인기도 가중치. uniform: 모두 같음. skewed: 그룹마다 1~2과목에 몰리고 약 30%는 거의 신청하지 않음(분반·폐강 확인용).
  function buildPopularityWeights(groups, mode = "uniform", rng = Math.random) {
    const weights = new Map();
    for (const group of usableGroups(groups)) {
      const courses = shuffle(group.courses, rng);
      const hot = mode === "skewed" ? Math.max(1, Math.round(courses.length * 0.2)) : 0;
      const cold = mode === "skewed" ? Math.floor(courses.length * 0.3) : 0;
      courses.forEach((name, index) => {
        const weight = index < hot ? 4 : index >= courses.length - cold ? 0.15 : 1;
        weights.set(name, weight);
      });
    }
    return weights;
  }

  // 가중치 비복원 추출(Efraimidis–Spirakis).
  function weightedSample(items, count, weightOf, rng) {
    return items.map((item) => ({ item, key: Math.pow(Math.max(rng(), 1e-12), 1 / Math.max(weightOf(item), 1e-6)) }))
      .sort((a, b) => b.key - a.key).slice(0, count).map(({ item }) => item);
  }

  // 그룹마다 정확히 count과목을 고른다. 이미 고정된 과목(locked, 재선택에서 유지되는 과목)은 그대로 둔다.
  function chooseSelections(groups, { weights = new Map(), rng = Math.random, locked = [], avoid = [], maxTries = 60 } = {}) {
    const active = usableGroups(groups);
    const weightOf = (name) => (weights.get(name) ?? 1) * (avoid.includes(name) ? 0.05 : 1);
    for (let attempt = 0; attempt < maxTries; attempt++) {
      const chosen = [...locked];
      const bases = new Set(chosen.map(baseSubject));
      let failed = false;
      // 고를 수 있는 과목이 적은 그룹부터 채워 학기 간 중복 충돌을 줄인다.
      const order = shuffle(active, rng).sort((a, b) => (a.courses.length - Number(a.count)) - (b.courses.length - Number(b.count)));
      for (const group of order) {
        const need = Number(group.count) - group.courses.filter((name) => chosen.includes(name)).length;
        if (need < 0) { failed = true; break; }
        if (!need) continue;
        const candidates = group.courses.filter((name) => !chosen.includes(name) && !bases.has(baseSubject(name)));
        if (candidates.length < need) { failed = true; break; }
        for (const name of weightedSample(candidates, need, weightOf, rng)) {
          chosen.push(name);
          bases.add(baseSubject(name));
        }
      }
      if (!failed) return chosen;
    }
    throw new Error("그룹 규칙(택 수·학기 중복 금지)을 모두 만족하는 선택을 찾지 못했습니다. 그룹 설정을 확인하세요.");
  }

  // 그룹 규칙 검사. 앱·서버와 같은 기준: 그룹별 정확히 count, 같은 과목 1·2학기 중복 금지, 그룹 밖 과목 금지.
  function checkSelections(groups, selections) {
    const errors = [];
    const active = usableGroups(groups);
    for (const group of active) {
      const picked = selections.filter((name) => group.courses.includes(name)).length;
      if (picked !== Number(group.count)) errors.push(`${group.name}: ${picked}과목 선택(기준 ${group.count})`);
    }
    const seen = new Set();
    for (const name of selections) {
      const base = baseSubject(name);
      if (seen.has(base)) errors.push(`${base}: 1·2학기 중복`);
      seen.add(base);
    }
    if (active.length) {
      const known = new Set(active.flatMap((group) => group.courses));
      const unknown = selections.filter((name) => !known.has(name));
      if (unknown.length) errors.push(`그룹에 없는 과목: ${unknown.join(", ")}`);
    }
    return errors;
  }

  // 일부러 규칙을 어긴 선택을 만든다(택 수 하나 더 또는 하나 덜). 서버가 거절하는지, 앱이 경고하는지 확인용.
  function violateSelections(groups, selections, rng = Math.random) {
    const active = shuffle(usableGroups(groups).filter((group) => Number(group.count) > 0), rng);
    const bases = new Set(selections.map(baseSubject));
    for (const group of active) {
      const extra = group.courses.filter((name) => !selections.includes(name) && !bases.has(baseSubject(name)));
      if (extra.length) {
        const name = extra[Math.floor(rng() * extra.length)];
        return { selections: [...selections, name], description: `${group.name}: ${Number(group.count) + 1}과목 선택(기준 ${group.count})` };
      }
    }
    for (const group of active) {
      const mine = selections.filter((name) => group.courses.includes(name));
      if (mine.length) {
        const drop = mine[Math.floor(rng() * mine.length)];
        return { selections: selections.filter((name) => name !== drop), description: `${group.name}: ${Number(group.count) - 1}과목 선택(기준 ${group.count})` };
      }
    }
    return null;
  }

  // 위계(선이수) 점검: 이벤트 자료(과목.requires·그룹.checks)를 앱 학생 화면과 같은 계산(course-checks.js)으로 본다.
  // course-checks.js가 없거나 규칙이 없는 예전 신청이면 빈 목록이다.
  function prerequisiteViolations(data, selections) {
    const check = typeof courseCheckApplicationState === "function" ? courseCheckApplicationState
      : typeof globalThis !== "undefined" && typeof globalThis.courseCheckApplicationState === "function" ? globalThis.courseCheckApplicationState : null;
    if (!check || !data) return [];
    return check(data, selections)?.violations || [];
  }
  function hasPrerequisiteRules(data) {
    return (data?.courses || []).some((course) => Array.isArray(course?.requires) && course.requires.length);
  }
  // 그룹 규칙을 지키면서 위계도 지키는 선택(여러 번 다시 뽑는다). 끝내 못 찾으면 마지막 선택을 돌려준다.
  function choosePrerequisiteSafe(data, choose, tries = 40) {
    let picks = choose();
    for (let attempt = 1; attempt < tries && prerequisiteViolations(data, picks).length; attempt++) picks = choose();
    return picks;
  }
  // 일부러 위계를 어긴 선택(그룹 규칙은 지킴). 무작위로 못 찾으면 null.
  function choosePrerequisiteViolation(data, choose, tries = 80) {
    for (let attempt = 0; attempt < tries; attempt++) {
      const picks = choose();
      const violations = prerequisiteViolations(data, picks);
      if (violations.length) return { selections: picks, description: `위계 위반(${violations[0].course} ← ${violations[0].requires})` };
    }
    return null;
  }

  // 그룹이 없는 예전 신청(학기·과목 목록만 있음): 같은 과목 중복 없이 1~4과목.
  function chooseFreeSelections(courses, { weights = new Map(), rng = Math.random } = {}) {
    const names = (courses || []).map((course) => course.subject).filter(Boolean);
    const count = Math.max(1, Math.min(names.length, 1 + Math.floor(rng() * 4)));
    const picked = [];
    const bases = new Set();
    for (const name of weightedSample(names, names.length, (item) => weights.get(item) ?? 1, rng)) {
      if (picked.length >= count) break;
      if (bases.has(baseSubject(name))) continue;
      picked.push(name);
      bases.add(baseSubject(name));
    }
    return picked;
  }

  // ---------- 명렬 ----------
  const SURNAMES = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임", "한", "오", "서", "신", "권"];
  function virtualName(classroom, number) {
    return `${SURNAMES[(Number(classroom) * 7 + Number(number)) % SURNAMES.length]}가상${String(number).padStart(2, "0")}`;
  }

  function generateRoster({ grade, classes, perClass }) {
    const classCount = Math.max(1, Math.min(30, Math.floor(Number(classes) || 0)));
    const size = Math.max(1, Math.min(60, Math.floor(Number(perClass) || 0)));
    const students = [];
    for (let classroom = 1; classroom <= classCount; classroom++) {
      for (let number = 1; number <= size; number++) {
        students.push({ grade: String(grade), classroom: String(classroom), number: String(number), name: virtualName(classroom, number) });
      }
    }
    return students;
  }

  const compact = (value) => String(value ?? "").replace(/\s+/g, "");

  // 학생명렬표(학년·반·번호·성명) 엑셀. 학년 열이 없으면 고른 학년으로 본다. 다른 학년 학생은 뺀다.
  function parseRosterSheets(sheets, grade) {
    const students = [];
    let otherGrade = 0;
    const seen = new Set();
    for (const sheet of sheets || []) {
      const rows = sheet?.rows || [];
      const headerIndex = rows.findIndex((row) => (row || []).some((value) => /^(이름|성명|학생명)$/.test(compact(value))) &&
        (row || []).some((value) => compact(value) === "반") && (row || []).some((value) => /^(번호|출석번호)$/.test(compact(value))));
      if (headerIndex < 0) continue;
      const header = rows[headerIndex].map(compact);
      const columns = {
        grade: header.indexOf("학년"), classroom: header.indexOf("반"),
        number: header.findIndex((value) => /^(번호|출석번호)$/.test(value)),
        name: header.findIndex((value) => /^(이름|성명|학생명)$/.test(value)),
      };
      for (const row of rows.slice(headerIndex + 1)) {
        const name = String(row?.[columns.name] ?? "").trim();
        const classroom = compact(row?.[columns.classroom]).replace(/반$/, "");
        const number = compact(row?.[columns.number]).replace(/번$/, "");
        if (!name || !/^\d+$/.test(classroom) || !/^\d+$/.test(number)) continue;
        const rowGrade = columns.grade >= 0 ? compact(row?.[columns.grade]).replace(/학년$/, "") : String(grade);
        if (String(Number(rowGrade)) !== String(grade)) { otherGrade++; continue; }
        const key = `${Number(classroom)}-${Number(number)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        students.push({ grade: String(grade), classroom: String(Number(classroom)), number: String(Number(number)), name });
      }
    }
    if (!students.length) throw new Error(`명렬에서 현 ${grade}학년 학생(학년·반·번호·성명 머리글)을 찾지 못했습니다.`);
    students.sort((a, b) => Number(a.classroom) - Number(b.classroom) || Number(a.number) - Number(b.number));
    return { students, otherGrade };
  }

  // ---------- 앱 저장 자료(읽기 전용) ----------
  const WORKSPACE_KEY = "course-certificate-studio-v1";
  const GROUP_KEY = "curriculum-color-semester-groups-v3";

  // getItem: localStorage.getItem 과 같은 함수. 앱 자료를 고치지 않고 읽기만 한다.
  function readWorkspaceSettings(getItem, currentGrade) {
    const grade = String(currentGrade);
    if (!["1", "2"].includes(grade)) throw new Error("현 1학년 또는 현 2학년을 고르세요.");
    const raw = getItem(WORKSPACE_KEY);
    if (!raw) throw new Error("이 브라우저에 저장된 앱 자료가 없습니다. 같은 브라우저에서 앱(index.html)을 열어 편제표를 올리고 2단계 선택 그룹을 확인한 뒤 다시 누르세요.");
    let saved;
    try { saved = JSON.parse(raw); } catch { throw new Error("앱 저장 자료를 읽지 못했습니다."); }
    const schoolYear = Number(saved.schoolYear) || new Date().getFullYear();
    const cohortYear = String(schoolYear - Number(grade) + 1);
    const targetGrade = String(Number(grade) + 1);
    const readGroups = (key) => {
      const value = getItem(key);
      if (!value) return null;
      try {
        const list = JSON.parse(value);
        return Array.isArray(list) ? list : null;
      } catch { return null; }
    };
    const stored = readGroups(`${GROUP_KEY}:${cohortYear}`) ?? readGroups(GROUP_KEY) ?? [];
    const groups = stored.filter((group) => String(group?.grade) === targetGrade && Array.isArray(group.courses) && group.courses.length)
      .map((group) => ({ id: group.id, name: String(group.name || "그룹"), semester: String(group.semester ?? "0"),
        count: group.count, courses: group.courses.map(String) }));
    if (!groups.length) {
      throw new Error(`${cohortYear}학년도 입학생(현 ${grade}학년)의 ${targetGrade}학년 선택 그룹이 없습니다. 앱 1단계에 ${cohortYear}학년도 입학생 편제표를 올리고 2단계 '현 ${grade}학년' 탭의 과목·그룹 설정을 확인하세요.`);
    }
    const unset = groups.filter((group) => !Number.isInteger(group.count) || group.count < 0 || group.count > group.courses.length);
    if (unset.length) throw new Error(`선택 수가 정해지지 않은 그룹이 있습니다: ${unset.map((group) => group.name).join(", ")}. 앱 2단계 과목·그룹 설정에서 선택 수를 지정하세요.`);
    groups.sort((a, b) => (a.semester === "0" ? 9 : Number(a.semester)) - (b.semester === "0" ? 9 : Number(b.semester)));
    const plan = saved.curriculumCohorts?.[cohortYear]?.plan ||
      (String(saved.curriculumCohortYear) === cohortYear && saved.curriculumPlanType !== "annual" ? saved.curriculumPlan : null) || [];
    const credits = new Map();
    for (const row of plan) {
      if (String(row?.grade) !== targetGrade) continue;
      const credit = Number(row.opCredit) || Number(row.baseCredit) || 0;
      for (const part of String(row.subject || "").split(/[,，]/)) {
        const key = compactName(part);
        if (key && credit && !credits.has(key)) credits.set(key, credit);
      }
    }
    return {
      grade, targetGrade, cohortYear, schoolYear: String(schoolYear),
      round: String(saved.currentRound || "1"), schoolName: String(saved.schoolName || ""),
      groups, credits, hasPlan: plan.length > 0,
    };
  }

  // ---------- 결과 파일(로컬) ----------
  const UNKNOWN_COURSE = "테스트봇 가상과목";

  // 학생마다 규칙에 맞는 선택을 만들고, 고른 수만큼 오류를 넣는다. injected에 학생별로 넣은 오류를 남긴다.
  function buildResultEntries(students, groups, options = {}) {
    const rng = options.rng || Math.random;
    const weights = options.weights || buildPopularityWeights(groups, options.popularity, rng);
    const total = students.length;
    const empty = pickCount(total, options.emptyCount, rng);
    const violate = pickCount(total, options.violationCount, rng, empty);
    const unknown = pickCount(total, options.unknownCount, rng, empty);
    const entries = students.map((student, index) => {
      const injected = [];
      let selections = [];
      if (empty.has(index)) injected.push("미선택");
      else {
        selections = chooseSelections(groups, { weights, rng });
        if (violate.has(index)) {
          const broken = violateSelections(groups, selections, rng);
          if (broken) { selections = broken.selections; injected.push(`택 수 위반(${broken.description})`); }
        }
        if (unknown.has(index)) { selections = [...selections, UNKNOWN_COURSE]; injected.push(`편제표에 없는 과목(${UNKNOWN_COURSE})`); }
      }
      return { ...student, selections, injected };
    });
    return { entries, weights };
  }

  // 결과 파일에 적을 과목 이름. romanDigits면 "미적분Ⅱ" → "미적분2"(앱이 같은 과목으로 맞추는지 확인).
  function outputName(name, romanDigits) {
    return romanDigits ? romanToDigits(name) : name;
  }

  // 학생별 과목 표시 형식(앱 예시 '선택과목 수강신청결과 예시.xlsx'와 같은 배치).
  //  1행: 빈칸 3개, "과목", 과목명…  2행: 학년·반·번호·성명/학점, 학점…  3행부터: 학생, 선택한 과목 칸에 1
  function buildWideRows(entries, groups, { grade, credits = new Map(), romanDigits = false } = {}) {
    const names = [];
    for (const group of [...usableGroups(groups)].sort((a, b) => (a.semester === "0" ? 9 : Number(a.semester)) - (b.semester === "0" ? 9 : Number(b.semester)))) {
      for (const name of group.courses) if (!names.includes(name)) names.push(name);
    }
    for (const entry of entries) for (const name of entry.selections) if (!names.includes(name)) names.push(name);
    // 두 학기에 모두 있는 과목은 실제 결과 파일처럼 "과목(1학기)"로 붙여 쓴다.
    const title = (name) => {
      const semester = semesterOfName(name);
      const shown = semester ? `${baseSubject(name)}(${semester}학기)` : name;
      return outputName(shown, romanDigits);
    };
    const rows = [
      ["", "", "", "과목", ...names.map(title)],
      ["학년", "반", "번호", "성명/학점", ...names.map((name) => credits.get(compactName(name)) || (name === UNKNOWN_COURSE ? 2 : ""))],
    ];
    for (const entry of entries) {
      rows.push([Number(grade), Number(entry.classroom), Number(entry.number), entry.name,
        ...names.map((name) => entry.selections.includes(name) ? 1 : "")]);
    }
    return rows;
  }

  // 차수·선택과목 목록 형식(앱의 웹 수강신청 결과 저장 파일과 같은 머리글).
  function buildFormRows(entries, { round, grade, romanDigits = false } = {}) {
    return [
      ["차수", "학년", "반", "번호", "성명", "선택과목"],
      ...entries.map((entry) => [String(round), String(grade), String(entry.classroom), String(entry.number), entry.name,
        entry.selections.map((name) => outputName(name, romanDigits)).join(", ")]),
    ];
  }

  function localDate(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function resultFileName(grade, format, date = new Date()) {
    return `테스트봇_수강신청결과(현${grade}학년)${format === "form" ? "_목록형" : ""}_${localDate(date)}.xlsx`;
  }

  function courseCounts(entries) {
    const counts = new Map();
    for (const entry of entries) for (const name of entry.selections) counts.set(name, (counts.get(name) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  }

  // ---------- 엑셀 쓰기(압축 없는 xlsx) ----------
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function zip(files) {
    const encoder = new TextEncoder();
    const entries = Object.entries(files).map(([name, content]) => ({ name: encoder.encode(name), data: encoder.encode(content) }));
    const parts = [];
    const central = [];
    let offset = 0;
    for (const file of entries) {
      const checksum = crc32(file.data);
      const local = new Uint8Array(30 + file.name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
      lv.setUint32(14, checksum, true); lv.setUint32(18, file.data.length, true); lv.setUint32(22, file.data.length, true);
      lv.setUint16(26, file.name.length, true); local.set(file.name, 30);
      parts.push(local, file.data);
      const head = new Uint8Array(46 + file.name.length);
      const cv = new DataView(head.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
      cv.setUint32(16, checksum, true); cv.setUint32(20, file.data.length, true); cv.setUint32(24, file.data.length, true);
      cv.setUint16(28, file.name.length, true); cv.setUint32(42, offset, true); head.set(file.name, 46);
      central.push(head);
      offset += local.length + file.data.length;
    }
    const size = central.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, size, true); ev.setUint32(16, offset, true);
    const all = [...parts, ...central, end];
    const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
    let cursor = 0;
    for (const part of all) { out.set(part, cursor); cursor += part.length; }
    return out;
  }

  const xmlEscape = (value) => String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  function columnName(index) {
    let name = "";
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    return name;
  }

  // sheets: [{ name, rows }]. 숫자는 숫자 칸, 나머지는 글자 칸으로 쓴다.
  function createXlsxBytes(sheets) {
    const files = {
      "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
      "_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, i) => `<sheet name="${xmlEscape(String(sheet.name).slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
    };
    sheets.forEach((sheet, i) => {
      const data = sheet.rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => {
        if (value === "" || value === null || value === undefined) return "";
        const ref = `${columnName(c)}${r + 1}`;
        return typeof value === "number" && Number.isFinite(value)
          ? `<c r="${ref}"><v>${value}</v></c>`
          : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
      }).join("")}</row>`).join("");
      files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${data}</sheetData></worksheet>`;
    });
    return zip(files);
  }

  // ---------- 웹 수강신청(서버) ----------
  const EVENT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

  // 학생 신청 링크(…index.html#event=<id>) 또는 신청 id 자체.
  function parseEventInput(value) {
    const text = String(value ?? "").trim();
    if (EVENT_ID.test(text)) return text.toLowerCase();
    const match = text.match(/[#&?]event=([a-f0-9-]{36})/i);
    if (match && EVENT_ID.test(match[1])) return match[1].toLowerCase();
    throw new Error("학생 신청 링크(…#event=…) 또는 수강신청 id를 확인하세요.");
  }

  function normalizeCode(value) {
    const text = String(value ?? "").trim().toLowerCase();
    return /^\d{1,5}$/.test(text) ? text.padStart(6, "0") : text;
  }

  // 앱에서 내려받은 '학생별_신청코드.xlsx'(신청ID·현재학년·반·번호·이름·신청코드·학생링크).
  function parseCodeSheets(sheets) {
    const rows = sheets?.[0]?.rows || [];
    const header = (rows[0] || []).map(compact);
    const column = (name) => header.indexOf(name);
    const columns = { id: column("신청ID"), grade: column("현재학년"), classroom: column("반"), number: column("번호"),
      name: column("이름"), code: column("신청코드") };
    if (Object.values(columns).some((index) => index < 0)) {
      throw new Error("학생 코드 엑셀 양식(신청ID·현재학년·반·번호·이름·신청코드)을 확인하세요. 앱의 '학생 코드 엑셀 저장'으로 받은 파일을 쓰세요.");
    }
    const records = rows.slice(1).filter((row) => String(row?.[columns.id] ?? "").trim());
    if (!records.length) throw new Error("코드 파일에 학생이 없습니다.");
    const ids = new Set(records.map((row) => String(row[columns.id]).trim().toLowerCase()));
    if (ids.size !== 1) throw new Error("코드 파일에는 수강신청 하나만 들어 있어야 합니다.");
    const eventId = [...ids][0];
    if (!EVENT_ID.test(eventId)) throw new Error("코드 파일의 신청ID 형식이 잘못되었습니다.");
    const students = records.map((row) => ({
      grade: String(row[columns.grade] ?? "").trim(), classroom: String(row[columns.classroom] ?? "").trim(),
      number: String(row[columns.number] ?? "").trim(), name: String(row[columns.name] ?? "").trim(),
      code: normalizeCode(row[columns.code]),
    }));
    if (students.some((student) => !/^(?:\d{6}|[a-f0-9]{32})$/.test(student.code))) throw new Error("코드 파일에 형식이 잘못된 신청코드가 있습니다.");
    return { eventId, students };
  }

  // 대상 학생 고르기: all / first(N명) / class(반 목록 "1,3")
  function selectStudents(students, { scope = "all", count = 0, classes = "" } = {}) {
    const sorted = [...students].sort((a, b) => Number(a.grade) - Number(b.grade) ||
      Number(a.classroom) - Number(b.classroom) || Number(a.number) - Number(b.number));
    if (scope === "first") return sorted.slice(0, Math.max(0, Math.floor(Number(count) || 0)));
    if (scope === "class") {
      const wanted = new Set(String(classes).split(/[,\s·]+/).filter(Boolean).map((value) => String(Number(value))));
      return sorted.filter((student) => wanted.has(String(Number(student.classroom))));
    }
    return sorted;
  }

  const WEAK_CODES = new Set(["012345", "123456", "234567", "345678", "456789", "567890", "987654", "876543", "765432",
    "654321", "543210", "098765", "121212", "123123", "112233", "000123"]);
  function isWeakCode(code) {
    return /^(.)\1{5}$/.test(code) || WEAK_CODES.has(code);
  }
  function makeNewCode(rng, previous = "") {
    for (;;) {
      const code = String(Math.floor(rng() * 1000000)).padStart(6, "0");
      if (code !== previous && !isWeakCode(code)) return code;
    }
  }
  function wrongCode(code, attempt) {
    if (/^\d{6}$/.test(code)) return String((Number(code) + 1 + attempt * 7919) % 1000000).padStart(6, "0");
    return code.split("").reverse().join("") === code ? "0".repeat(32) : code.split("").reverse().join("");
  }

  // 서버 호출기. fetchImpl은 브라우저 fetch 또는 테스트용 흉내. 응답 시간(ms)을 기록한다.
  function createRpcClient({ projectUrl, publicKey, fetchImpl, now = () => Date.now() }) {
    return async function rpc(name, args) {
      const started = now();
      let response;
      try {
        response = await fetchImpl(`${projectUrl}/rest/v1/rpc/${name}`, {
          method: "POST", headers: { apikey: publicKey, "Content-Type": "application/json" },
          body: JSON.stringify(args), credentials: "omit", cache: "no-store",
        });
      } catch {
        const error = new Error("신청 서버에 연결하지 못했습니다.");
        error.ms = now() - started; error.kind = "network";
        throw error;
      }
      const text = await response.text();
      const ms = now() - started;
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {
        const error = new Error("서버 응답을 읽지 못했습니다."); error.ms = ms; error.status = response.status; throw error;
      }
      if (!response.ok) {
        const error = new Error(data?.message || data?.msg || data?.error_description || `서버 요청 실패(${response.status})`);
        error.code = data?.code || ""; error.status = response.status; error.ms = ms;
        throw error;
      }
      return { data, ms };
    };
  }

  // 서버 거절을 한 모양({error, locked})으로. 새 방식은 {error}를 돌려주고, 예전 방식은 예외(HTTP 400)로 거절한다.
  async function attempt(rpc, name, args, record) {
    try {
      const { data, ms } = await rpc(name, args);
      record.times.push(ms);
      if (data?.error) return { error: String(data.error), locked: !!data.locked, needGrade: !!data.needGrade, data };
      return { data };
    } catch (error) {
      if (Number.isFinite(error?.ms)) record.times.push(error.ms);
      return { error: error?.message || "알 수 없는 오류", code: error?.code || "", status: error?.status || 0, thrown: true };
    }
  }

  // 새 방식(반·번호+코드, 01-code-hardening.sql)인지 예전 방식(코드만)인지. 앱 학생 화면처럼 get_course_login_form을 먼저 부른다.
  async function detectServerMode(rpc, eventId) {
    try {
      const { data } = await rpc("get_course_login_form", { p_event: eventId });
      if (data?.error) throw Object.assign(new Error(String(data.error)), { refused: true });
      return { mode: "hardened", form: data || {}, gradeRequired: Array.isArray(data?.grades) && data.grades.length > 1 };
    } catch (error) {
      if (error?.code === "PGRST202" || error?.status === 404) return { mode: "legacy", form: null, gradeRequired: false };
      throw error;
    }
  }

  function identityOf(student, gradeRequired) {
    const strip = (value) => String(value ?? "").trim().replace(/^0+(?=\d)/, "");
    return { p_grade: gradeRequired ? strip(student.grade) : "", p_classroom: strip(student.classroom), p_number: strip(student.number) };
  }

  function sameSet(a, b) {
    return a.length === b.length && a.every((item) => b.includes(item));
  }

  const sleep = (ms, signal) => new Promise((resolve) => {
    if (!ms || signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

  // 가상 학생 한 명: (틀린 코드 k번) → 로그인 → (첫 접속 코드 변경) → 과목·그룹 받기 → (규칙 위반 시도) → 저장 → 다시 불러와 확인 → (재신청)
  async function runVirtualStudent(student, ctx) {
    const { rpc, eventId, mode, gradeRequired = false, rng = Math.random, delayMs = 0, signal } = ctx;
    const plan = student.plan || {};
    const record = {
      grade: student.grade, classroom: student.classroom, number: student.number, name: student.name,
      status: "대기", ok: false, newCode: "", selections: [], verified: false, notes: [], failure: "", times: [],
      wrongCode: null, violation: null, resubmitted: false,
    };
    let code = student.code;
    const hardened = mode === "hardened";
    const identity = identityOf(student, gradeRequired);
    const step = async (name, args) => {
      if (signal?.aborted) throw Object.assign(new Error("중지됨"), { stopped: true });
      await sleep(delayMs, signal);
      return attempt(rpc, name, args, record);
    };
    const login = (value) => hardened
      ? step("get_student_course_application", { p_event: eventId, ...identity, p_code: value })
      : step("get_scoped_course_application", { p_event: eventId, p_code: value });
    const save = (value, selections) => hardened
      ? step("save_student_course_application", { p_event: eventId, ...identity, p_code: value, p_selections: selections })
      : step("save_scoped_course_application", { p_event: eventId, p_code: value, p_selections: selections });
    const fail = (status, reason) => { record.status = status; record.failure = reason; return record; };
    try {
      // 1) 일부러 틀린 코드를 k번 넣어 잠금 동작을 본다.
      if (plan.wrongCodes > 0) {
        record.wrongCode = { attempts: 0, lockedAfter: 0, lastError: "" };
        for (let i = 0; i < plan.wrongCodes; i++) {
          const result = await login(wrongCode(code, i));
          record.wrongCode.attempts++;
          if (!result.error) { record.notes.push("틀린 코드가 받아들여짐(확인 필요)"); break; }
          record.wrongCode.lastError = result.error;
          if (result.locked) { record.wrongCode.lockedAfter = i + 1; break; }
        }
        if (record.wrongCode.lockedAfter) {
          record.notes.push(`틀린 코드 ${record.wrongCode.lockedAfter}번째에 잠김`);
          const blocked = await login(code);
          if (blocked.error) return fail("잠김 확인", `잠긴 뒤 올바른 코드도 거절: ${blocked.error}`);
          record.notes.push("잠긴 뒤에도 올바른 코드가 통과함(확인 필요)");
        } else {
          record.notes.push(`틀린 코드 ${record.wrongCode.attempts}번 거절${hardened ? "(잠기지 않음)" : "(예전 방식은 잠금 없음)"}`);
        }
      }
      // 2) 로그인
      let result = await login(code);
      if (result.error) return fail(result.locked ? "잠김" : "로그인 실패", result.error);
      // 3) 첫 접속 코드 변경
      if (result.data?.mustChangeCode) {
        let changed = null;
        for (let i = 0; i < 3 && !changed; i++) {
          const next = makeNewCode(rng, code);
          const response = await step("change_course_code", { p_event: eventId, ...identity, p_code: code, p_new_code: next });
          if (!response.error) changed = next;
          else if (!/쉬운|다른 새 코드/.test(response.error)) return fail("코드 변경 실패", response.error);
        }
        if (!changed) return fail("코드 변경 실패", "새 코드를 정하지 못했습니다.");
        code = changed;
        record.newCode = changed;
        result = await login(code);
        if (result.error) return fail("로그인 실패", `코드 변경 후 접속 실패: ${result.error}`);
      }
      const data = result.data || {};
      if (!data.open) return fail("접수 마감", data.reselectionAllowed === false ? "재선택 대상이 아님" : "수강신청이 마감되었거나 열려 있지 않습니다.");
      const groups = (data.groups || []).map((group) => ({ ...group, count: Number(group.count) }));
      const locked = Array.isArray(data.lockedSelections) ? data.lockedSelections : [];
      if (ctx.weights && !ctx.weights.size) {
        for (const [name, weight] of buildPopularityWeights(groups.length ? groups : [{ name: "전체", count: 1, courses: (data.courses || []).map((c) => c.subject) }], ctx.popularity, rng)) ctx.weights.set(name, weight);
      }
      const chooseAny = (avoid = []) => groups.length
        ? chooseSelections(groups, { weights: ctx.weights || new Map(), rng, locked, avoid })
        : chooseFreeSelections(data.courses, { weights: ctx.weights || new Map(), rng });
      // 위계 규칙이 있는 신청에서는 정상 학생처럼 선이수 순서를 지켜 고른다(위계는 경고만이라 어겨도 저장된다).
      const prerequisites = hasPrerequisiteRules(data);
      const choose = (avoid = []) => prerequisites ? choosePrerequisiteSafe(data, () => chooseAny(avoid)) : chooseAny(avoid);
      let selections = choose();
      // 4-1) 위계 위반 시도: 위계는 경고만 하므로(서버는 막지 않음) 저장되는 것이 정상이다. 거절되면 실패로 본다.
      //      예전 이벤트에 남은 막기 값(checks.blockPrerequisites)·서버 표시(prerequisiteBlock)는 보지 않는다.
      if (plan.violate && prerequisites && groups.length) {
        const broken = choosePrerequisiteViolation(data, () => chooseAny());
        if (broken) {
          const attempt = await save(code, broken.selections);
          record.prerequisite = { description: broken.description, saved: !attempt.error, refused: !!attempt.error, message: attempt.error || "" };
          record.notes.push(attempt.error ? `위계 경고 과목 저장 거절됨!(${broken.description}: ${attempt.error})`
            : `위계 경고 과목 저장됨(${broken.description})`);
          if (attempt.error) record.prerequisite.unexpected = true;
        }
      }
      // 4) 규칙 위반 선택을 먼저 보내 서버가 거절하는지 본다.
      if (plan.violate && groups.length) {
        const broken = violateSelections(groups, selections, rng);
        if (broken) {
          const refused = await save(code, broken.selections);
          record.violation = { description: broken.description, refused: !!refused.error, message: refused.error || "" };
          record.notes.push(refused.error ? `규칙 위반 거절됨(${broken.description})` : `규칙 위반이 저장됨!(${broken.description})`);
        }
      }
      // 5) 저장 → 6) 다시 불러와 확인
      const saveAndVerify = async (picks) => {
        const saved = await save(code, picks);
        if (saved.error) return saved.error;
        const again = await login(code);
        if (again.error) return `저장 뒤 다시 불러오기 실패: ${again.error}`;
        const stored = Array.isArray(again.data?.selections) ? again.data.selections : [];
        if (!sameSet(stored, picks)) return `저장 내용 불일치(서버: ${stored.join(", ") || "없음"})`;
        return "";
      };
      let problem = await saveAndVerify(selections);
      if (problem) { record.selections = selections; return fail(/불일치|다시 불러오기/.test(problem) ? "확인 실패" : "저장 실패", problem); }
      // 7) 재신청: 이미 신청한 학생이 선택을 바꿔 다시 저장
      if (plan.resubmit) {
        const changed = choose(selections.filter((name) => !locked.includes(name)));
        problem = await saveAndVerify(changed);
        if (problem) { record.selections = changed; return fail("재신청 실패", problem); }
        record.resubmitted = true;
        record.notes.push(sameSet(changed, selections) ? "재신청(같은 선택으로 다시 저장)" : "재신청으로 선택 변경");
        selections = changed;
      }
      record.selections = selections;
      record.verified = true;
      record.ok = true;
      record.status = "완료";
      if (record.violation && !record.violation.refused) { record.ok = false; record.status = "규칙 위반 저장됨"; record.failure = record.violation.description; }
      if (record.prerequisite?.unexpected) { record.ok = false; record.status = "위계 경고 과목 거절됨"; record.failure = `${record.prerequisite.description}: ${record.prerequisite.message}`; }
      return record;
    } catch (error) {
      if (error?.stopped) return fail("중지됨", "사용자가 중지했습니다.");
      return fail("오류", error?.message || "알 수 없는 오류");
    }
  }

  // 학생별 실행 계획(오류 주입 대상) 정하기.
  function planStudents(students, { wrongCodePercent = 0, wrongCodeTimes = 0, violationPercent = 0, resubmitPercent = 0, rng = Math.random } = {}) {
    const wrong = Number(wrongCodeTimes) > 0 ? pickIndexes(students.length, wrongCodePercent, rng) : new Set();
    const violate = pickIndexes(students.length, violationPercent, rng);
    const resubmit = pickIndexes(students.length, resubmitPercent, rng);
    return students.map((student, index) => ({
      ...student,
      plan: { wrongCodes: wrong.has(index) ? Math.floor(Number(wrongCodeTimes)) : 0, violate: violate.has(index), resubmit: resubmit.has(index) },
    }));
  }

  // 동시 접속 수만큼 나눠 실행한다. onResult(record, index)로 진행 상황을 알린다.
  async function runPool(items, concurrency, worker, { signal, onResult } = {}) {
    const results = new Array(items.length);
    let next = 0;
    const size = Math.max(1, Math.min(30, Math.floor(Number(concurrency) || 1)));
    const lanes = Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length && !signal?.aborted) {
        const index = next++;
        results[index] = await worker(items[index], index);
        onResult?.(results[index], index);
      }
    });
    await Promise.all(lanes);
    return results;
  }

  function summarize(records) {
    const done = records.filter(Boolean);
    const times = done.flatMap((record) => record.times);
    const reasons = new Map();
    // 틀린 코드로 일부러 잠근 학생(잠김 확인)은 기대한 결과라 실패로 세지 않는다.
    const expected = (record) => record.status === "잠김 확인";
    // 중지 단추로 끊긴 학생은 실패가 아니라 '중지됨'으로 따로 센다.
    const interrupted = (record) => record.status === "중지됨";
    for (const record of done) {
      if (record.ok || expected(record) || interrupted(record)) continue;
      const key = `${record.status}: ${String(record.failure || "").replace(/\d+분/g, "N분").slice(0, 80)}`;
      reasons.set(key, (reasons.get(key) || 0) + 1);
    }
    return {
      total: done.length,
      ok: done.filter((record) => record.ok).length,
      failed: done.filter((record) => !record.ok && !expected(record) && !interrupted(record)).length,
      interrupted: done.filter(interrupted).length,
      codeChanged: done.filter((record) => record.newCode).length,
      requests: times.length,
      averageMs: times.length ? Math.round(times.reduce((sum, ms) => sum + ms, 0) / times.length) : 0,
      maxMs: times.length ? Math.max(...times) : 0,
      violationsRefused: done.filter((record) => record.violation?.refused).length,
      violationsAccepted: done.filter((record) => record.violation && !record.violation.refused).length,
      // 위계 위반 시도: 경고만이라 저장되는 것이 정상(저장됨), 거절은 비정상.
      prerequisiteSaved: done.filter((record) => record.prerequisite && !record.prerequisite.refused).length,
      prerequisiteRefused: done.filter((record) => record.prerequisite?.refused).length,
      locked: done.filter(expected).length,
      reasons: [...reasons].sort((a, b) => b[1] - a[1]),
    };
  }

  function resultSheets(records, meta = {}) {
    const summary = summarize(records);
    const rows = [["학년", "반", "번호", "이름", "상태", "바뀐 코드", "선택 과목", "저장 확인", "오류 주입·관찰", "실패 사유", "평균 응답(ms)"]];
    for (const record of records.filter(Boolean)) {
      const average = record.times.length ? Math.round(record.times.reduce((sum, ms) => sum + ms, 0) / record.times.length) : "";
      rows.push([String(record.grade), String(record.classroom), String(record.number), record.name, record.status, record.newCode,
        record.selections.join(", "), record.verified ? "확인" : "", record.notes.join(" / "), record.failure, average]);
    }
    const info = [
      ["항목", "값"],
      ["학교·차수", `${meta.schoolYear || ""} ${meta.schoolName || ""} ${meta.round ? `${meta.round}차` : ""}`.trim()],
      ["수강신청 id", meta.eventId || ""],
      ["서버 방식", meta.mode === "hardened" ? "반·번호+코드(새 방식)" : "코드만(예전 방식)"],
      ["실행 시각", meta.startedAt || ""],
      ["대상 학생", summary.total], ["성공", summary.ok], ["실패", summary.failed], ["코드 변경", summary.codeChanged],
      ["요청 수", summary.requests], ["평균 응답(ms)", summary.averageMs], ["최대 응답(ms)", summary.maxMs],
      ["규칙 위반 거절", summary.violationsRefused], ["규칙 위반 저장됨", summary.violationsAccepted], ["잠김 확인", summary.locked],
      ["위계 경고 과목 저장됨", summary.prerequisiteSaved], ["위계 경고 과목 거절(비정상)", summary.prerequisiteRefused],
      [],
      ["실패 사유", "학생 수"],
      ...summary.reasons.map(([reason, count]) => [reason, count]),
    ];
    return [{ name: "학생별 결과", rows }, { name: "요약", rows: info }];
  }

  // ---------- 반복 실행(회차) ----------
  // 같은 수강신청 반복(기본): 1회차만 첫 접속 코드 변경·틀린 코드(잠금) 확인, 2회차부터 바뀐 코드로 재접속해 새 무작위 선택으로 재신청.
  //   이전 회차에 잠긴 학생은 다음 회차 전에 교사 화면 경로로 잠금을 풀고(앱 자동 테스트 신청만) 그 회차에 참여시킨다. 정리는 마지막 회차 뒤 한 번.
  // 회차마다 새 수강신청: 2회차부터 앱에 새 [테스트] 신청을 요청하고, 회차마다 전체 과정을 거친 뒤 닫고 삭제한다.
  const REPEAT_MAX = 20;
  const seatKey = (student) => `${Number(student.grade)}-${Number(student.classroom)}-${Number(student.number)}`;
  const seatLabel = (student) => `${student.classroom}-${student.number} ${student.name || ""}`.trim();

  function normalizeRepeat(value = {}) {
    const count = Math.floor(Number(value?.count));
    return { count: Number.isFinite(count) ? Math.max(1, Math.min(REPEAT_MAX, count)) : 1, freshEvent: value?.freshEvent === true };
  }

  function repeatPlan(repeat, cleanup = "ask") {
    const { count, freshEvent } = normalizeRepeat(repeat);
    return Array.from({ length: count }, (_, index) => ({
      round: index + 1, total: count, freshEvent,
      createEvent: freshEvent && index > 0,
      firstLogin: freshEvent || index === 0,
      injectWrongCodes: freshEvent || index === 0,
      unlockBefore: !freshEvent && index > 0,
      cleanup: freshEvent ? "delete" : index === count - 1 ? cleanup : "none",
    }));
  }

  // 회차에서 바뀐 코드(첫 접속 변경)를 다음 회차 학생 목록에 넘긴다.
  function carryCodes(students, records) {
    const changed = new Map(records.filter((record) => record?.newCode).map((record) => [seatKey(record), record.newCode]));
    return students.map((student) => changed.has(seatKey(student)) ? { ...student, code: changed.get(seatKey(student)) } : student);
  }

  // 회차 대상과 오류 주입 계획. 틀린 코드(잠금)는 첫 접속 회차에만 넣고, 규칙 위반·재신청은 회차마다 새로 고른다.
  function roundTargets(students, plan, opts = {}, rng = Math.random, excluded = new Set()) {
    const pool = selectStudents(students, opts).filter((student) => !excluded.has(seatKey(student)));
    return planStudents(pool, { ...opts, wrongCodePercent: plan.injectWrongCodes ? opts.wrongCodePercent : 0, rng });
  }

  // 서버에 무엇이 저장되어 있어야 하는지(학생별 마지막 확인 선택). 저장 여부가 불확실한 학생은 대조에서 뺀다.
  // 위계 경고 과목 저장 시도가 저장된 뒤 마지막 저장을 확인하지 못한 학생도 서버에 무엇이 남았는지 확실하지 않아 뺀다.
  const UNCERTAIN = new Set(["확인 실패", "재신청 실패", "오류", "중지됨"]);
  function updateExpected(expected, uncertain, records) {
    for (const record of records.filter(Boolean)) {
      const key = seatKey(record);
      if (record.verified) {
        expected.set(key, { selections: [...record.selections], label: seatLabel(record) });
        uncertain.delete(key);
      } else if (UNCERTAIN.has(record.status) || record.prerequisite?.saved) uncertain.add(key);
    }
  }

  function compareTeacherApplications({ entries = [], expected = new Map(), uncertain = new Set(), targetKeys = new Set() } = {}) {
    const byKey = new Map(entries.map((entry) => [seatKey(entry), entry]));
    const checked = [...expected].filter(([key]) => !uncertain.has(key));
    const mismatched = [];
    for (const [key, item] of checked) {
      const entry = byKey.get(key);
      const stored = Array.isArray(entry?.selections) ? entry.selections : [];
      if (!entry || !entry.submittedAt || !sameSet(stored, item.selections)) mismatched.push(item.label || key);
    }
    const submitted = entries.filter((entry) => targetKeys.has(seatKey(entry)) && entry.submittedAt && !uncertain.has(seatKey(entry)));
    const extra = submitted.filter((entry) => !expected.has(seatKey(entry))).map(seatLabel);
    const count = (lists) => {
      const map = new Map();
      for (const list of lists) for (const name of list || []) map.set(name, (map.get(name) || 0) + 1);
      return map;
    };
    const botCounts = count(checked.map(([, item]) => item.selections));
    const teacherCounts = count(submitted.map((entry) => entry.selections));
    const courseDiff = [...new Set([...botCounts.keys(), ...teacherCounts.keys()])]
      .filter((name) => (botCounts.get(name) || 0) !== (teacherCounts.get(name) || 0));
    const others = entries.filter((entry) => !targetKeys.has(seatKey(entry)) && entry.submittedAt).length;
    return { expected: checked.length, submitted: submitted.length, mismatched, extra, courseDiff, others,
      uncertain: [...uncertain].filter((key) => targetKeys.has(key)).length, problems: mismatched.length + extra.length + courseDiff.length };
  }

  function compareLocks({ students = [], records = [], targetKeys = new Set() } = {}) {
    const listed = new Map(students.map((student) => [seatKey(student), student]));
    const tried = records.filter((record) => record?.wrongCode?.attempts);
    const expectedLocked = new Set(tried.filter((record) => record.wrongCode.lockedAfter).map(seatKey));
    const expectedListed = new Set(tried.map(seatKey));
    const missing = [...expectedListed].filter((key) => !listed.has(key));
    const lockedActual = new Set([...listed].filter(([key, student]) => targetKeys.has(key) && (student.teacherLock || student.lockedSeconds > 0)).map(([key]) => key));
    const lockMismatch = [...new Set([...expectedLocked, ...lockedActual])].filter((key) => expectedLocked.has(key) !== lockedActual.has(key));
    const extra = [...listed.keys()].filter((key) => targetKeys.has(key) && !expectedListed.has(key));
    return { listed: listed.size, expectedListed: expectedListed.size, expectedLocked: expectedLocked.size, lockedActual: lockedActual.size,
      missing, extra, lockMismatch, problems: missing.length + extra.length + lockMismatch.length };
  }

  const ROUND_STEPS = [
    ["event", "수강신청 준비"],
    ["server", "서버·수강신청 확인"],
    ["unlock", "이전 회차 잠긴 학생 교사 해제"],
    ["students", "가상 학생 접속·첫 코드 변경·신청·저장 확인"],
    ["teacher", "교사 화면 신청 현황·과목별 인원 대조"],
    ["locks", "교사 화면 잠금 현황 대조"],
    ["import", "앱 2단계 결과 반영(선택)"],
    ["cleanup", "테스트 수강신청 정리"],
  ];
  function newRoundSteps(plan) {
    return ROUND_STEPS.map(([key, name]) => ({
      key, name: key === "students" && !plan.firstLogin ? "가상 학생 바뀐 코드로 재접속·새 선택으로 재신청·저장 확인" : name,
      status: "pending", expected: "", actual: "", ms: 0,
    }));
  }
  const LOGIN_PROBLEM = /로그인|응답하지 않습니다/;

  // 회차 반복 실행기. 화면·창 연결은 io로 받는다(test-bot.js, 테스트는 흉내).
  //   io.rpc, io.rng, io.signal, io.gate.wait(), io.teacher(action, {eventId, timeoutMs}), io.waitForTeacher(reason) → true(로그인 됨)/false(중지),
  //   io.confirm(info), io.askCleanup(), io.acceptCreated(data), io.onRound/onStep/onRecord/onCodes/onEvent/onRoundEnd
  async function runRepeatedTest({ source, opts = {}, repeat = {}, auto = false, connected = false, canCreate = false }, io) {
    const wanted = normalizeRepeat(repeat);
    const notes = [];
    const teacherAvailable = !!connected && typeof io.teacher === "function";
    if (wanted.freshEvent && !(teacherAvailable && canCreate)) {
      wanted.freshEvent = false;
      notes.push("회차마다 새 수강신청은 앱의 ‘수강신청 자동 테스트’로 시작할 때만 됩니다. 이번에는 같은 수강신청으로 반복했습니다.");
    }
    const plans = repeatPlan(wanted, opts.cleanup || "ask");
    const { rpc, rng = Math.random, signal } = io;
    const report = {
      repeat: { count: plans.length, freshEvent: wanted.freshEvent }, rounds: [], notes, stopped: false, cancelled: false, error: "",
      meta: { eventId: source.eventId, schoolName: source.schoolName || "", schoolYear: String(source.schoolYear || ""), round: String(source.round || ""),
        startedAt: io.now ? io.now() : new Date().toISOString(), mode: "" },
    };
    const stopError = (message = "중지했습니다.") => Object.assign(new Error(message), { cancelled: true });
    const isStopped = () => !!signal?.aborted;
    let eventId = source.eventId;
    let testEvent = !!source.testEvent;
    let students = source.students.map((student) => ({ ...student }));
    let server = null;
    let expected = new Map();
    let uncertain = new Set();
    let lockedBefore = new Set();
    let confirmed = !!auto;
    const weights = new Map();

    async function teacherCall(action, options = {}) {
      for (;;) {
        if (isStopped() && !options.ignoreStop) throw stopError();
        try {
          return await io.teacher(action, { eventId, ...options });
        } catch (error) {
          if (options.ignoreStop || error?.cancelled || !LOGIN_PROBLEM.test(error?.message || "") || typeof io.waitForTeacher !== "function") throw error;
          if (!(await io.waitForTeacher(error.message))) throw stopError();
        }
      }
    }
    // 회차 사이·교사 화면 요청 전에 앱 창의 교사 세션을 이어 둔다. 이미 만료되었으면 다시 로그인할 때까지 기다린다.
    async function keepTeacher() {
      const state = await teacherCall("session");
      if (state?.loggedIn === false) {
        if (typeof io.waitForTeacher !== "function" || !(await io.waitForTeacher("교사 로그인이 필요합니다."))) throw stopError();
      }
    }
    const stepOf = (round, key) => round.steps.find((item) => item.key === key);
    const skip = (step, text) => { step.actual = text; return "skip"; };
    function markSkip(round, key, text) {
      const step = stepOf(round, key);
      step.status = "skip";
      step.actual = text;
      io.onStep?.(round, report);
    }
    async function runStep(round, key, work) {
      const step = stepOf(round, key);
      step.status = "running";
      io.onStep?.(round, report);
      const started = Date.now();
      try {
        const result = await work(step);
        step.status = result === "skip" ? "skip" : step.status === "running" ? "pass" : step.status;
      } catch (error) {
        step.status = error?.cancelled ? "skip" : "fail";
        step.actual = step.actual ? `${step.actual} · ${error?.message}` : String(error?.message || "알 수 없는 오류");
        if (error?.cancelled) throw error;
      } finally {
        step.ms = Date.now() - started;
        io.onStep?.(round, report);
      }
      return step;
    }
    async function cleanup(round, plan, { forced = false } = {}) {
      await runStep(round, "cleanup", async (step) => {
        if (plan.cleanup === "none") return skip(step, `마지막 회차(${plan.total}회차)가 끝난 뒤 정리합니다.`);
        if (!testEvent || !teacherAvailable) return skip(step, "앱이 자동 테스트로 만든 신청이 아니어서 그대로 둡니다.");
        const choice = plan.cleanup === "ask" ? (io.askCleanup ? await io.askCleanup() : "close") : plan.cleanup;
        step.expected = { close: "신청 닫기", delete: "신청 닫고 삭제", keep: "그대로 두기" }[choice] +
          (plan.freshEvent ? "(회차마다 새 수강신청 방식은 항상 닫고 삭제)" : "");
        if (choice === "keep") return skip(step, "그대로 두었습니다.");
        const options = { ignoreStop: forced };
        if (!forced) await keepTeacher();
        const closed = await teacherCall("close", options);
        step.actual = closed?.message || "닫았습니다.";
        if (choice === "delete") {
          const removed = await teacherCall("delete", options);
          step.actual += ` · ${removed?.message || "삭제했습니다."}`;
        }
        if (forced) step.actual += " (중지했지만 이 회차 신청을 정리했습니다)";
      });
    }

    for (const plan of plans) {
      if (isStopped()) break;
      const round = { round: plan.round, total: plan.total, plan, eventId, steps: newRoundSteps(plan), records: [], targets: [],
        status: "running", teacher: null, locks: null };
      report.rounds.push(round);
      io.onRound?.(round, report);
      try {
        // 1) 수강신청 준비(새 수강신청 방식의 2회차부터는 앱에 새 [테스트] 신청을 요청)
        const prepared = await runStep(round, "event", async (step) => {
          if (!plan.createEvent) {
            step.actual = plan.round === 1 ? `받은 수강신청 ${eventId.slice(0, 8)}… · 학생 ${students.length}명`
              : "1회차와 같은 수강신청을 이어서 씁니다(바뀐 코드로 재접속).";
            return;
          }
          step.expected = "앱이 새 [테스트] 수강신청을 만들어 학생 코드를 보냄";
          await keepTeacher();
          const data = await teacherCall("create", { timeoutMs: 180000 });
          const created = io.acceptCreated ? io.acceptCreated(data) : data;
          if (!created?.eventId || !Array.isArray(created.students) || !created.students.length) throw new Error("앱이 보낸 새 수강신청 자료가 잘못되었습니다.");
          eventId = created.eventId;
          round.eventId = eventId;
          students = created.students.map((student) => ({ ...student }));
          testEvent = true;
          expected = new Map();
          uncertain = new Set();
          lockedBefore = new Set();
          io.onEvent?.(created);
          step.actual = `새 수강신청 ${eventId.slice(0, 8)}… · 학생 ${students.length}명`;
        });
        if (prepared.status === "fail") throw Object.assign(new Error(prepared.actual), { fatal: true });

        // 2) 서버 방식과 수강신청 확인(새 신청마다)
        if (plan.round === 1 || plan.createEvent) {
          const checked = await runStep(round, "server", async (step) => {
            const scope = selectStudents(students, opts);
            if (!scope.length) throw new Error("대상 학생이 없습니다. 대상 학생 설정을 확인하세요.");
            server = await detectServerMode(rpc, eventId);
            report.meta.mode = server.mode;
            let info = server.form;
            if (!info) {
              // 예전 방식: 학교·차수를 알려 주는 입구가 없어 첫 학생으로 읽기만 한다.
              const { data } = await rpc("get_scoped_course_application", { p_event: eventId, p_code: scope[0].code });
              info = data || {};
            }
            report.meta.schoolName = info.schoolName || report.meta.schoolName;
            report.meta.schoolYear = String(info.schoolYear || report.meta.schoolYear || "");
            report.meta.round = String(info.round || report.meta.round || "");
            step.expected = "수강신청 정보를 읽을 수 있음";
            step.actual = `${report.meta.schoolYear}학년도 ${report.meta.schoolName} ${report.meta.round}차 · ${server.mode === "hardened" ? "반·번호+코드(새 방식)" : "코드만(예전 방식)"} · 대상 ${scope.length}명`;
          });
          if (checked.status === "fail") throw Object.assign(new Error(checked.actual), { fatal: true });
          if (!confirmed) {
            confirmed = io.confirm ? await io.confirm({ ...report.meta, targets: selectStudents(students, opts).length, repeat: report.repeat }) : true;
            if (!confirmed) {
              stepOf(round, "students").actual = "사용자가 취소했습니다.";
              report.cancelled = true;
              throw stopError("취소했습니다.");
            }
          }
        } else markSkip(round, "server", "1회차에서 확인했습니다.");

        // 3) 이전 회차에 잠긴 학생은 교사 화면 경로로 풀고 이번 회차에 다시 참여시킨다.
        let excluded = new Set();
        if (!plan.unlockBefore || !lockedBefore.size) {
          markSkip(round, "unlock", plan.round === 1 ? "첫 회차라 해당 없음" : plan.freshEvent ? "회차마다 새 수강신청이라 해당 없음" : "이전 회차에 잠긴 학생이 없습니다.");
        } else {
          const unlock = await runStep(round, "unlock", async (step) => {
            step.expected = `잠긴 학생 ${lockedBefore.size}명 교사 해제 → 이번 회차 참여(첫 접속 코드 변경부터)`;
            if (server.mode !== "hardened") return skip(step, "예전 방식 서버는 잠금이 없습니다.");
            if (!teacherAvailable || !testEvent) {
              excluded = new Set(lockedBefore);
              return skip(step, `앱의 자동 테스트 신청이 아니어서 교사 해제를 요청하지 않습니다. 잠긴 학생 ${excluded.size}명은 이번 회차에서 뺍니다.`);
            }
            await keepTeacher();
            const result = await teacherCall("unlock");
            step.actual = result?.message || "잠금을 해제했습니다.";
            lockedBefore = new Set();
          });
          if (unlock.status === "fail") excluded = new Set(lockedBefore);
        }

        // 4) 가상 학생
        const targets = roundTargets(students, plan, opts, rng, excluded);
        round.targets = targets;
        io.onRound?.(round, report);
        const ctx = { rpc, eventId, mode: server.mode, gradeRequired: server.gradeRequired, rng,
          delayMs: opts.delayMs || 0, signal, weights, popularity: opts.popularity };
        await runStep(round, "students", async (step) => {
          if (!targets.length) throw new Error("대상 학생이 없습니다. 대상 학생 설정을 확인하세요.");
          try {
            await runPool(targets, opts.concurrency || 1, async (student) => {
              await io.gate?.wait();
              if (isStopped()) return null;
              return runVirtualStudent(student, ctx);
            }, {
              signal,
              onResult: (record) => {
                if (!record) return;
                record.round = plan.round;
                round.records.push(record);
                io.onRecord?.(record, round, report);
              },
            });
          } finally {
            students = carryCodes(students, round.records);
            io.onCodes?.(round.records, eventId);
            updateExpected(expected, uncertain, round.records);
            for (const record of round.records) if (record.status === "잠김 확인" || record.status === "잠김") lockedBefore.add(seatKey(record));
          }
          const summary = summarize(round.records);
          step.expected = `${targets.length}명 모두 저장·다시 불러오기 일치${opts.violationPercent ? ", 규칙 위반은 서버가 거절" : ""}`;
          step.actual = `성공 ${summary.ok}명, 실패 ${summary.failed}명${summary.locked ? `, 잠김 확인 ${summary.locked}명` : ""}, 코드 변경 ${summary.codeChanged}명, 평균 응답 ${summary.averageMs}ms` +
            (summary.violationsRefused + summary.violationsAccepted ? `, 위반 거절 ${summary.violationsRefused}/${summary.violationsRefused + summary.violationsAccepted}` : "") +
            (isStopped() ? ` · 중지됨(${round.records.length}/${targets.length}명 처리)` : "");
          if (isStopped() || summary.ok + summary.locked !== targets.length || summary.failed || summary.violationsAccepted) step.status = "fail";
        });
        if (isStopped()) throw stopError();

        const scopeKeys = new Set(selectStudents(students, opts).map(seatKey));
        // 5) 교사 화면 신청 현황·과목별 인원 대조
        await runStep(round, "teacher", async (step) => {
          if (!opts.teacherCheck || !teacherAvailable) {
            return skip(step, !opts.teacherCheck ? "설정에서 껐습니다." : "앱 창과 연결되지 않아 건너뜁니다(앱의 ‘테스트봇으로 보내기’로 열면 대조합니다).");
          }
          await keepTeacher();
          const data = await teacherCall("applications");
          const result = compareTeacherApplications({ entries: data?.entries || [], expected, uncertain, targetKeys: scopeKeys });
          round.teacher = result;
          step.expected = `신청 완료 ${result.expected}명, 학생별 선택·과목별 인원 모두 일치${plan.round > 1 && !plan.freshEvent ? "(이전 회차 저장분 포함)" : ""}`;
          step.actual = `교사 화면 신청 완료 ${result.submitted}명, 학생 불일치 ${result.mismatched.length}명, 과목 인원 불일치 ${result.courseDiff.length}과목` +
            (result.extra.length ? `, 예상 밖 신청 ${result.extra.length}명` : "") +
            (result.mismatched.length ? ` (${result.mismatched.slice(0, 5).join(", ")})` : "") +
            (result.courseDiff.length ? ` (${result.courseDiff.slice(0, 5).join(", ")})` : "") +
            (result.uncertain ? ` · 저장 여부가 불확실한 학생 ${result.uncertain}명은 대조에서 뺌` : "") +
            (result.others ? ` · 참고: 대상이 아닌 학생 신청 ${result.others}명(이전 실행 등)` : "");
          if (result.problems) step.status = "fail";
        });
        // 6) 잠금 현황 대조(새 방식 + 틀린 코드 주입 회차, 또는 교사 해제 뒤)
        await runStep(round, "locks", async (step) => {
          const tried = round.records.filter((record) => record.wrongCode?.attempts);
          const unlocked = stepOf(round, "unlock").status === "pass";
          if (!opts.teacherCheck || !teacherAvailable || server.mode !== "hardened" || (!tried.length && !unlocked)) {
            return skip(step, server.mode !== "hardened" ? "예전 방식 서버는 잠금이 없습니다."
              : !opts.teacherCheck || !teacherAvailable ? "앱 창과 연결되지 않았거나 대조를 껐습니다."
                : plan.injectWrongCodes ? "틀린 코드 주입이 없어 건너뜁니다." : "틀린 코드는 첫 회차에만 넣습니다.");
          }
          await keepTeacher();
          const data = await teacherCall("locks");
          const result = compareLocks({ students: data?.students || [], records: round.records, targetKeys: scopeKeys });
          round.locks = result;
          step.expected = tried.length ? `실패 기록 ${result.expectedListed}명, 잠김 ${result.expectedLocked}명` : "교사 해제 뒤 대상 학생의 실패 기록·잠김 0명";
          step.actual = `교사 화면 실패 기록 ${result.listed}명(누락 ${result.missing.length}, 예상 밖 ${result.extra.length}), 잠김 ${result.lockedActual}명(불일치 ${result.lockMismatch.length})`;
          if (result.problems) step.status = "fail";
        });
        // 7) 앱 2단계 반영(기본 꺼짐, 같은 수강신청 방식의 마지막 회차에서 한 번)
        await runStep(round, "import", async (step) => {
          if (!opts.importToApp) return skip(step, "기본 꺼짐(교사 작업 자료 보호)");
          if (plan.freshEvent) return skip(step, "회차마다 새 수강신청을 만들고 삭제하는 방식에서는 반영하지 않습니다.");
          if (plan.round !== plan.total) return skip(step, "마지막 회차에서 한 번만 반영합니다.");
          if (!teacherAvailable || !testEvent) return skip(step, "앱의 ‘수강신청 자동 테스트’로 만든 신청만 반영할 수 있습니다.");
          await keepTeacher();
          const result = await teacherCall("import", { timeoutMs: 180000 });
          const saved = [...expected.keys()].filter((key) => !uncertain.has(key)).length;
          step.expected = `${report.meta.round}차에 신청 학생 ${saved}명 이상 반영`;
          step.actual = `${result?.round}차 학생 ${result?.students}명`;
          if (Number(result?.students) < saved) step.status = "fail";
        });
        // 8) 정리
        await cleanup(round, plan);
        round.status = round.steps.some((step) => step.status === "fail") ? "failed" : "done";
      } catch (error) {
        if (error?.cancelled) {
          round.status = "stopped";
          report.stopped = true;
        } else {
          round.status = "failed";
          report.error = String(error?.message || "알 수 없는 오류");
        }
        // 회차마다 새 수강신청 방식: 중지·실패해도 이 회차 신청이 쌓이지 않게 닫고 삭제한다(학생 신청을 시작한 뒤에만).
        if (plan.freshEvent && testEvent && teacherAvailable && stepOf(round, "students").status !== "pending" && stepOf(round, "cleanup").status === "pending") {
          await cleanup(round, plan, { forced: true }).catch(() => {});
        }
        io.onRoundEnd?.(round, report);
        break;
      }
      io.onRoundEnd?.(round, report);
    }
    report.meta.eventId = eventId;
    return report;
  }

  function roundRow(round) {
    const summary = summarize(round.records);
    const checks = [round.teacher, round.locks].filter(Boolean);
    const failedSteps = round.steps.filter((step) => step.status === "fail").length;
    return {
      round: round.round, eventId: round.eventId, stopped: round.status === "stopped",
      status: round.status === "stopped" ? `중지됨(끝나지 않음 · 처리 ${summary.ok + summary.locked + summary.failed}/${round.targets.length}명)` : failedSteps ? `실패 단계 ${failedSteps}개` : round.status === "done" ? "통과" : "진행 중",
      targets: round.targets.length, total: summary.total, ok: summary.ok, failed: summary.failed, locked: summary.locked,
      violationsRefused: summary.violationsRefused, mismatches: checks.length ? checks.reduce((sum, item) => sum + item.problems, 0) : null,
      requests: summary.requests, averageMs: summary.averageMs, maxMs: summary.maxMs, failedSteps,
    };
  }

  // 회차 사이 변화(응답 시간 증가, 실패·대조 불일치가 생긴 회차).
  function compareRounds(rows) {
    const notes = [];
    if (rows.length < 2) return notes;
    const base = rows[0];
    const slow = (row) => row.averageMs >= Math.max(base.averageMs * 1.5, base.averageMs + 20);
    const slowFrom = rows.slice(1).find(slow);
    if (slowFrom) {
      const last = rows[rows.length - 1];
      const stays = rows.filter((row) => row.round >= slowFrom.round).every(slow);
      notes.push(`${slowFrom.round}회차부터 평균 응답 시간 증가(1회차 ${base.averageMs}ms → ${slowFrom.round}회차 ${slowFrom.averageMs}ms` +
        `${last !== slowFrom ? `, ${last.round}회차 ${last.averageMs}ms` : ""})${stays ? "" : " · 이후 다시 낮아진 회차도 있음"}`);
    } else {
      const averages = rows.map((row) => row.averageMs);
      notes.push(`평균 응답 시간은 회차 사이 큰 변화 없음(${Math.min(...averages)}~${Math.max(...averages)}ms)`);
    }
    const spikes = rows.slice(1).filter((row) => row.maxMs >= Math.max(base.maxMs * 3, base.maxMs + 200));
    if (spikes.length) notes.push(`최대 응답 시간 급증: ${spikes.map((row) => `${row.round}회차 ${row.maxMs}ms`).join(", ")}(1회차 ${base.maxMs}ms)`);
    const failing = rows.filter((row) => row.failed > 0);
    if (failing.length) {
      const first = failing[0];
      notes.push(`${!base.failed && first.round > 1 ? `${first.round}회차부터 실패 발생 · ` : ""}실패가 있는 회차: ${failing.map((row) => `${row.round}회차 ${row.failed}명`).join(", ")}`);
    } else notes.push("모든 회차에서 학생 신청 실패 없음");
    const checked = rows.filter((row) => row.mismatches !== null);
    const mismatched = checked.filter((row) => row.mismatches > 0);
    if (mismatched.length) notes.push(`교사 화면 대조 불일치: ${mismatched.map((row) => `${row.round}회차 ${row.mismatches}건`).join(", ")}`);
    else if (checked.length) notes.push(`교사 화면 대조: 대조한 ${checked.length}개 회차 모두 일치`);
    return notes;
  }

  function repeatSummary(report) {
    const rows = report.rounds.map(roundRow);
    const finished = rows.filter((row) => !row.stopped);
    const finishedRecords = report.rounds.filter((round) => round.status !== "stopped").flatMap((round) => round.records);
    const all = summarize(finishedRecords);
    const sum = (key) => finished.reduce((total, row) => total + (row[key] || 0), 0);
    const checked = finished.filter((row) => row.mismatches !== null);
    const totals = {
      rounds: finished.length, targets: sum("targets"), total: sum("total"), ok: sum("ok"), failed: sum("failed"), locked: sum("locked"),
      violationsRefused: sum("violationsRefused"), mismatches: checked.length ? checked.reduce((total, row) => total + row.mismatches, 0) : null,
      requests: all.requests, averageMs: all.averageMs, maxMs: all.maxMs, failedSteps: sum("failedSteps"),
    };
    // 학생 신청까지 가지 못한 회차(수강신청 준비 실패 등)는 응답 시간 비교에서 뺀다.
    return { rows, totals, trends: compareRounds(finished.filter((row) => row.total > 0)) };
  }

  function repeatReportSheets(report) {
    const labels = { pending: "대기", running: "진행 중", pass: "통과", fail: "실패", skip: "건너뜀" };
    const { rows, totals, trends } = repeatSummary(report);
    const header = ["회차", "수강신청 id", "결과", "대상", "처리", "성공", "실패", "잠김 확인", "위반 거절", "대조 불일치", "요청 수", "평균 응답(ms)", "최대 응답(ms)"];
    const line = (row, label, eventId, status) => [label, eventId, status, row.targets, row.total, row.ok, row.failed, row.locked, row.violationsRefused,
      row.mismatches === null ? "대조 안 함" : row.mismatches, row.requests, row.averageMs, row.maxMs];
    const roundSheet = [header,
      ...rows.map((row) => line(row, `${row.round}회차`, row.eventId, row.status)),
      line(totals, `합계(끝난 ${totals.rounds}회차)`, "", totals.failedSteps ? `실패 단계 ${totals.failedSteps}개` : "통과"),
      [], ["회차 사이 변화"], ...trends.map((note) => [note]), ...(report.notes || []).map((note) => [note])];
    const stepRows = [["회차", "단계", "결과", "기대값", "실제값", "걸린 시간(초)"],
      ...report.rounds.flatMap((round) => round.steps.map((step) =>
        [`${round.round}회차`, step.name, labels[step.status], step.expected, step.actual, Number((step.ms / 1000).toFixed(1))]))];
    const records = report.rounds.flatMap((round) => round.records.filter(Boolean));
    const [students, info] = resultSheets(records, report.meta);
    students.rows = students.rows.map((row, index) => [index === 0 ? "회차" : `${records[index - 1].round || 1}회차`, ...row]);
    const at = info.rows.findIndex((row) => row[0] === "실행 시각") + 1;
    info.rows.splice(at, 0,
      ["반복", `${report.repeat.count}회 · ${report.repeat.freshEvent ? "회차마다 새 수강신청(회차마다 닫고 삭제)" : "같은 수강신청에서 바뀐 코드로 재접속·재신청"}`],
      ["끝난 회차", `${totals.rounds}/${report.repeat.count}${report.stopped ? " · 중지함" : ""}`]);
    return [{ name: "회차별 요약", rows: roundSheet }, { name: "단계별 결과", rows: stepRows }, students, info];
  }

  return {
    createRng, shuffle, pickIndexes, baseSubject, romanToDigits, hasRoman, compactName,
    buildPopularityWeights, chooseSelections, checkSelections, violateSelections, chooseFreeSelections,
    prerequisiteViolations, choosePrerequisiteSafe, choosePrerequisiteViolation,
    generateRoster, parseRosterSheets, readWorkspaceSettings, buildResultEntries, buildWideRows, buildFormRows,
    resultFileName, courseCounts, createXlsxBytes, UNKNOWN_COURSE,
    parseEventInput, parseCodeSheets, selectStudents, isWeakCode, makeNewCode, createRpcClient, detectServerMode,
    runVirtualStudent, planStudents, runPool, summarize, resultSheets,
    REPEAT_MAX, normalizeRepeat, repeatPlan, carryCodes, roundTargets, updateExpected, compareTeacherApplications, compareLocks,
    runRepeatedTest, roundRow, compareRounds, repeatSummary, repeatReportSheets,
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = TestBotCore;
