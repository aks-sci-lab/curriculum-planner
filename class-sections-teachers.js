// 6단계 교사 명단: 엑셀 양식 내려받기·올리기(실제 이름으로), 5단계 교사 수로 만든 자리 이름('사회(지리) 1') 판별·안내.
// class-sections-view.js 다음에 로드한다. 위쪽은 순수 계산(DOM·state 없음), '// ---- 앱 연결 ----' 아래가 화면.
// 교사 이름은 학생 개인정보가 아니라 로컬 저장·백업에 그대로 둔다. 배정·고정은 교사 id로 이어지므로 이름을 바꿔도 그대로다.

// ---- 순수 계산 ----

var CLASS_SECTIONS_TEACHER_HEADER = ["이름", "담당 교과", "담당 과목", "불가 시간", "사유", "비고", "번호(고치지 마세요)", "담임(내년 학년-반)"];

// 담임 반 표기: '2-3', '2학년 3반', '2학년3반' → '2-3'(내년 학년-반). 비면 "", 읽지 못하면 null.
function classSectionsTeacherHomeroom(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const match = raw.match(/^([1-3])\s*(?:학년|-|–|~)\s*(\d{1,2})\s*반?$/);
  return match && Number(match[2]) >= 1 ? `${match[1]}-${Number(match[2])}` : null;
}

// '5단계 교사 수로 명단 만들기'가 만든 자리: id 't-교과-n'이고 이름이 '교과 이름 n' 그대로인 교사.
function classSectionsTeacherPlaceholder(teacher, labelOf = (id) => id) {
  const match = String(teacher?.id || "").match(/^t-(.+)-(\d+)$/);
  if (!match || match[1] !== String(teacher.department || "")) return false;
  return String(teacher.name || "").trim() === `${labelOf(match[1])} ${match[2]}` && !String(teacher.alias || "").trim();
}

// 출력물 위 안내: 실제 이름이 없는 교사(자리 이름·빈 이름). 없으면 빈 배열.
function classSectionsTeacherNameWarningsFor(teachers, labelOf = (id) => id) {
  const placeholders = (teachers || []).filter((teacher) => classSectionsTeacherPlaceholder(teacher, labelOf));
  if (!placeholders.length) return [];
  const names = placeholders.map((teacher) => teacher.name);
  return [`실제 이름이 없는 교사 ${placeholders.length}명(${names.slice(0, 4).join(", ")}${names.length > 4 ? " …" : ""}) — 교사 명단에서 이름을 넣으세요(6단계 '교사·시간 설정' → 교사 명단 양식).`];
}

// 불가 시간 글자: 하루 전체(1~periods교시)는 요일만('목'), 나머지는 '월7,화7'. 학년을 적은 칸은 뒤에 '월4(3학년)'.
function classSectionsTeacherSlotsText(slots, days, periods) {
  const groups = new Map(); // 학년 구분 글자('' = 구분 없음) → 칸 집합
  for (const slot of slots || []) {
    const match = String(slot).match(/^([^(]+)(\(.+\))?$/);
    if (!match) continue;
    if (!groups.has(match[2] || "")) groups.set(match[2] || "", new Set());
    groups.get(match[2] || "").add(match[1]);
  }
  const order = (slot) => days.indexOf(slot[0]) * 100 + Number(slot.slice(1));
  const out = [];
  for (const suffix of [...groups.keys()].sort()) {
    const set = groups.get(suffix);
    const parts = [];
    for (const day of days) {
      const all = Array.from({ length: periods }, (_, p) => `${day}${p + 1}`);
      if (all.every((slot) => set.has(slot))) { parts.push(day); all.forEach((slot) => set.delete(slot)); }
    }
    out.push(...[...parts, ...[...set].sort((x, y) => order(x) - order(y))].map((slot) => `${slot}${suffix}`));
  }
  return out.join(",");
}

// '월7,화6~7, 목' → ['월7','화6','화7','목1'…'목N']. 학년을 적으면('월4(3학년)', '월4(1,2학년)') 그 학년 교시의 시각만 → '월4(3학년)'·'월4(1·2학년)'. 모르는 글자는 problems.
function classSectionsTeacherParseSlots(text, days, periods) {
  const slots = new Set();
  const problems = [];
  // 괄호 안(학년)의 쉼표·띄어쓰기에 잘리지 않게 먼저 '(12)'처럼 줄인다. 학년이 아닌 괄호는 '(?)'로 남겨 못 읽은 것으로 알린다.
  const packed = String(text ?? "").replace(/\s*[(（]([^)）]*)[)）]/g, (_, inner) => { const grades = [...new Set(inner.replace(/[^123]/g, "").split(""))].sort().join(""); return /학년/.test(inner) && grades ? `(${grades})` : "(?)"; });
  for (const raw of packed.split(/[,\s/]+/).map((item) => item.trim()).filter(Boolean)) {
    const match = raw.match(/^([월화수목금토일])(?:요일)?(?:\s*(\d{1,2})(?:교시)?(?:\s*[~-]\s*(\d{1,2})(?:교시)?)?)?(?:\(([123]{1,3})\))?$/);
    if (!match || !days.includes(match[1])) { problems.push(raw); continue; }
    const from = match[2] ? Number(match[2]) : 1;
    const to = match[3] ? Number(match[3]) : match[2] ? from : periods;
    if (!(from >= 1 && to <= periods && from <= to)) { problems.push(raw); continue; }
    const suffix = match[4] && match[4].length < 3 ? `(${match[4].split("").join("·")}학년)` : "";
    for (let p = from; p <= to; p += 1) slots.add(`${match[1]}${p}${suffix}`);
  }
  return { slots: [...slots], problems };
}

function classSectionsTeacherSheetRows(teachers, spec = {}) {
  const days = spec.days || ["월", "화", "수", "목", "금"];
  const periods = spec.periods || 7;
  return [CLASS_SECTIONS_TEACHER_HEADER.slice(), ...(teachers || []).map((teacher) => [teacher.name || "", teacher.department || "", teacher.courses || "",
    classSectionsTeacherSlotsText(teacher.unavailable, days, periods), teacher.reason || "", teacher.note || "", teacher.id || "", teacher.homeroom || ""])];
}

// 올린 교사 명단 → 새 명단. 번호(id)가 맞으면 그 교사, 아니면 이름(띄어쓰기 무시)·별칭으로 맞춘다. 없으면 추가.
// 파일에 없는 기존 교사는 지우지 않고 notInList 표시만(지우기는 따로 확인).
// spec: { departments:[id], labelOf, days, periods, newId(index) }
function classSectionsTeacherReadRows(rows, existing, spec = {}) {
  const compact = (value) => String(value ?? "").replace(/\s+/g, "");
  const text = (value) => String(value ?? "").trim();
  const days = spec.days || ["월", "화", "수", "목", "금"];
  const periods = spec.periods || 7;
  const labelOf = spec.labelOf || ((id) => id);
  const headerAt = (rows || []).findIndex((row) => compact(row?.[0]) === "이름");
  if (headerAt < 0) return { error: "'이름' 머리글을 찾지 못했습니다(내려받은 교사 명단 양식인지 확인하세요)." };
  const header = rows[headerAt].map(compact);
  const col = (name) => header.findIndex((cell) => cell.startsWith(compact(name)));
  const at = { name: 0, department: col("담당교과"), courses: col("담당과목"), unavailable: col("불가시간"), reason: col("사유"), note: col("비고"), id: col("번호"), homeroom: col("담임") };
  const departments = spec.departments || [];
  const deptOf = (value) => {
    const raw = text(value);
    if (!raw) return "";
    if (departments.includes(raw)) return raw;
    const byLabel = departments.find((id) => compact(labelOf(id)) === compact(raw));
    return byLabel ?? null;
  };
  const list = (existing || []).map((teacher) => ({ ...teacher }));
  const byId = new Map(list.map((teacher) => [String(teacher.id), teacher]));
  const byName = new Map();
  for (const teacher of list) for (const value of [teacher.name, teacher.alias]) if (compact(value) && !byName.has(compact(value))) byName.set(compact(value), teacher);
  const touched = new Set();
  const problems = [];
  let added = 0;
  let updated = 0;
  let kept = 0;
  const seenNames = new Set();
  const homerooms = new Map(); // 담임 반 → 교사 이름(겹침 확인)
  for (const [offset, row] of rows.slice(headerAt + 1).entries()) {
    const name = text(row?.[at.name]);
    if (!name) continue;
    const line = headerAt + offset + 2;
    if (seenNames.has(compact(name))) { problems.push(`${line}행 ${name}: 같은 이름이 두 번 있습니다(두 번째는 건너뜀)`); continue; }
    seenNames.add(compact(name));
    const department = at.department >= 0 ? deptOf(row[at.department]) : "";
    if (department === null) problems.push(`${line}행 ${name}: 담당 교과 '${text(row[at.department])}'를 모릅니다(예: 과학-물리)`);
    const parsed = at.unavailable >= 0 ? classSectionsTeacherParseSlots(row[at.unavailable], days, periods) : { slots: [], problems: [] };
    if (parsed.problems.length) problems.push(`${line}행 ${name}: 불가 시간 '${parsed.problems.join(", ")}'를 읽지 못했습니다(예: 월7,화7 또는 목, 학년 구분은 월4(3학년))`);
    const values = { name, courses: at.courses >= 0 ? text(row[at.courses]) : "", unavailable: parsed.slots,
      reason: at.reason >= 0 ? text(row[at.reason]) : "", note: at.note >= 0 ? text(row[at.note]) : "" };
    if (department !== null) values.department = department;
    // 담임 열이 있는 양식만 담임을 바꾼다(예전 양식을 올려도 넣어 둔 담임은 그대로).
    if (at.homeroom >= 0) {
      const homeroom = classSectionsTeacherHomeroom(row[at.homeroom]);
      if (homeroom === null) problems.push(`${line}행 ${name}: 담임 '${text(row[at.homeroom])}'를 읽지 못했습니다(예: 2-3 = 내년 2학년 3반)`);
      else if (homeroom && homerooms.has(homeroom)) problems.push(`${line}행 ${name}: 담임 ${homeroom}이 ${homerooms.get(homeroom)} 교사와 겹칩니다(뒤의 것은 비움)`);
      else { values.homeroom = homeroom; if (homeroom) homerooms.set(homeroom, name); }
    }
    const id = at.id >= 0 ? text(row[at.id]) : "";
    const match = (id && byId.get(id) && !touched.has(byId.get(id))) ? byId.get(id) : (byName.get(compact(name)) && !touched.has(byName.get(compact(name))) ? byName.get(compact(name)) : null);
    if (match) {
      touched.add(match);
      const before = JSON.stringify([match.name, match.department || "", match.courses || "", (match.unavailable || []).slice().sort(), match.reason || "", match.note || "", match.homeroom || ""]);
      Object.assign(match, values);
      if (!match.homeroom) delete match.homeroom;
      delete match.notInList;
      const after = JSON.stringify([match.name, match.department || "", match.courses || "", (match.unavailable || []).slice().sort(), match.reason || "", match.note || "", match.homeroom || ""]);
      if (before === after) kept += 1; else updated += 1;
    } else {
      const used = new Set(list.map((teacher) => String(teacher.id)));
      let serial = list.length + 1;
      const make = spec.newId || ((n) => `t${n}`);
      let newId = make(serial);
      while (used.has(newId)) { serial += 1; newId = make(serial); }
      const teacher = { id: newId, department: "", ...values };
      if (!teacher.homeroom) delete teacher.homeroom;
      list.push(teacher);
      touched.add(teacher);
      added += 1;
    }
  }
  const missing = list.filter((teacher) => !touched.has(teacher));
  for (const teacher of missing) teacher.notInList = true;
  return { teachers: list, added, updated, kept, missing: missing.map((teacher) => teacher.name || teacher.id), problems,
    text: `교사 명단: 추가 ${added}·갱신 ${updated}·유지 ${kept}${missing.length ? ` · 명단에 없음 ${missing.length}명(지우지 않고 표시만)` : ""}` };
}

// ---- 앱 연결 ----

function classSectionsTeacherLabelOf() {
  return (id) => (typeof hoursDepartmentName === "function" ? hoursDepartmentName(id) : id);
}

// 출력물(출석부·학생 시간표·블록표 등)이 위에 붙일 안내. 교사 명단이 없으면 빈 배열.
function classSectionsTeacherNameWarnings() {
  if (typeof classSectionsSettings !== "function") return [];
  return classSectionsTeacherNameWarningsFor(classSectionsSettings().teachers, classSectionsTeacherLabelOf());
}

function classSectionsTeacherGrid() {
  const settings = classSectionsSettings();
  const days = String(settings.gridDays || "월,화,수,목,금").split(",").filter(Boolean);
  return { days, periods: Number(settings.gridPeriods) || (typeof CLASS_SECTIONS_PERIODS === "number" ? CLASS_SECTIONS_PERIODS : 7) };
}

function classSectionsTeacherToolsHtml() {
  const settings = classSectionsSettings();
  const esc = classSectionsEsc;
  const warnings = classSectionsTeacherNameWarnings();
  const missing = settings.teachers.filter((teacher) => teacher.notInList).length;
  return `<div class="cs-actions" id="classSectionsTeacherTools">
      <button class="button" type="button" id="classSectionsTeacherExport">교사 명단 양식 내려받기</button>
      <label class="button">교사 명단 올리기<input id="classSectionsTeacherImport" type="file" accept=".xlsx" hidden aria-label="교사 명단 올리기"></label>
      ${missing ? `<button class="button" type="button" id="classSectionsTeacherRemoveMissing">명단에 없는 교사 ${missing}명 지우기</button>` : ""}
      <span class="cs-note">열: 이름·담당 교과(예 과학-물리)·담당 과목(쉼표)·불가 시간(월7,화7 또는 목, 학년마다 시각이 다른 교시는 월4(3학년))·사유·비고. 번호 열은 고치지 마세요(배정·고정이 이어짐).</span></div>
    ${warnings.length ? `<p class="cs-note is-warn" id="classSectionsTeacherNameWarning">${esc(warnings.join(" "))}</p>` : ""}`;
}

function classSectionsTeacherExport() {
  if (typeof createWorkbookBlob !== "function" || typeof downloadBlob !== "function") return;
  const settings = classSectionsSettings();
  const rows = classSectionsTeacherSheetRows(settings.teachers, classSectionsTeacherGrid());
  const guide = [["교사 명단 양식"], ["이름: 실제 이름(출력물·나이스 확인용). 담당 교과: 5단계 시수표 교과 표기(예: 과학-물리, 사회-지리, 국어). 담당 과목: 그 교과 중 맡을 과목만 쉼표로(비우면 교과 전체)."],
    ["불가 시간: '월7,화7'처럼 요일+교시, 하루 전체는 '목', 이어진 교시는 '화6~7'. 사유: 육아시간·순회 등. 비고: 자유."],
    ["불가 시간의 학년 구분: 점심이 학년마다 달라 같은 4교시라도 시각이 다르면 '월4(3학년)'(3학년 4교시 시각에만 불가) 또는 '월4(1·2학년)'(1·2학년 4교시 시각에만 불가)처럼 학년을 적습니다. 학년을 안 적은 '월4'는 두 시각 모두 불가입니다. 학년별 점심은 7단계 시간표의 조건 설정에서 정합니다."],
    ["번호(고치지 마세요): 지금 명단의 교사 번호입니다. 이름을 바꿔도 이 번호로 같은 교사로 맞춰 배정·고정·교실이 이어집니다. 새 교사는 비워 두세요."],
    ["담임(내년 학년-반): 내년에 담임을 맡을 반을 '2-3'(2학년 3반)처럼 적습니다. 비우면 담임 아님. 7단계 시간표의 담임 규칙(담임반 수업 포함, 학년별 창체 시간에 담임 비움)에 씁니다."],
    ["올릴 때: 번호 또는 이름으로 맞춰 갱신·추가하고, 파일에 없는 교사는 지우지 않고 '명단에 없음'으로 표시합니다."]];
  const year = String((Number(typeof $ === "function" ? $("#schoolYear")?.value : 0) || new Date().getFullYear()) + 1);
  return downloadBlob(createWorkbookBlob([{ name: "교사 명단", rows, widths: [12, 14, 22, 22, 12, 16, 16, 16], freeze: "A2" },
    { name: "안내", rows: guide, widths: [110], orientation: "portrait" }]), `${year}_교사명단.xlsx`);
}

async function classSectionsTeacherImport(file) {
  if (!file) return;
  const settings = classSectionsSettings();
  try {
    const sheets = await parseWorkbook(await file.arrayBuffer());
    const sheet = sheets.find((item) => item.name === "교사 명단") || sheets[0];
    const departments = typeof HOURS_DEPARTMENTS !== "undefined" ? HOURS_DEPARTMENTS.map((item) => item.id) : [];
    const read = classSectionsTeacherReadRows(sheet?.rows || [], settings.teachers, { ...classSectionsTeacherGrid(), departments, labelOf: classSectionsTeacherLabelOf(),
      newId: (n) => `t${Date.now().toString(36)}${n}` });
    if (read.error) { classSectionsSetStatus(read.error, true); return; }
    const text = `${read.text}${read.problems.length ? `\n\n확인 ${read.problems.length}건:\n${read.problems.slice(0, 10).join("\n")}${read.problems.length > 10 ? "\n…" : ""}` : ""}\n\n이대로 교사 명단을 바꿀까요?`;
    const ok = typeof classSectionsConfirm === "function" ? await classSectionsConfirm(text, { title: "교사 명단 올리기", ok: "바꾸기" }) : true;
    if (!ok) { classSectionsSetStatus("교사 명단 올리기를 취소했습니다."); return; }
    settings.teachers = read.teachers;
    classSectionsSetStatus(`${read.text}${read.problems.length ? ` · 확인 ${read.problems.length}건(${read.problems.slice(0, 2).join(" / ")})` : ""}`, read.problems.length > 0);
    if (typeof persistStateSoon === "function") persistStateSoon(); else if (typeof persistState === "function") persistState();
  } catch (error) {
    classSectionsSetStatus(`교사 명단을 읽지 못했습니다: ${error?.message || error}`, true);
  } finally {
    classSectionsTeacherRerender();
  }
}

function classSectionsTeacherRerender() {
  if (typeof preserveViewDuring === "function") preserveViewDuring(["#classSectionsTeacherDialog"], renderClassSectionsTeachers); else renderClassSectionsTeachers();
  if (typeof renderClassSections === "function") renderClassSections();
}

// 교사·시간 창 처리기(classSectionsHandleTeacherEvent)가 먼저 부른다. 처리했으면 true.
function classSectionsTeachersEvent(event) {
  const target = event.target;
  if (event.type === "click") {
    const button = target.closest?.("button");
    if (!button) return false;
    if (button.id === "classSectionsTeacherExport") { classSectionsTeacherExport(); return true; }
    if (button.id === "classSectionsTeacherRemoveMissing") {
      const settings = classSectionsSettings();
      const missing = settings.teachers.filter((teacher) => teacher.notInList);
      const ask = typeof classSectionsConfirm === "function"
        ? classSectionsConfirm(`올린 명단에 없는 교사 ${missing.length}명(${missing.slice(0, 5).map((teacher) => teacher.name || teacher.id).join(", ")}${missing.length > 5 ? " …" : ""})을 지울까요? 그 교사에게 고정한 분반은 자동 배정으로 돌아갑니다.`, { title: "명단에 없는 교사 지우기", ok: "지우기" })
        : Promise.resolve(true);
      ask.then((ok) => {
        if (!ok) return;
        const removed = new Set(missing.map((teacher) => String(teacher.id)));
        settings.teachers = settings.teachers.filter((teacher) => !teacher.notInList);
        // 지운 교사에게 고정한 분반(pins.teachers)은 고정을 푼다(자동 배정).
        const store = typeof classSectionsStore === "function" ? classSectionsStore() : {};
        for (const [round, groups] of Object.entries(store)) {
          if (!/^\d+$/.test(round) || !groups || typeof groups !== "object") continue;
          for (const entry of Object.values(groups)) for (const [id, teacherId] of Object.entries(entry?.pins?.teachers || {})) if (removed.has(String(teacherId))) delete entry.pins.teachers[id];
        }
        classSectionsSetStatus(`명단에 없는 교사 ${missing.length}명을 지웠습니다.`);
        if (typeof persistStateSoon === "function") persistStateSoon(); else if (typeof persistState === "function") persistState();
        classSectionsTeacherRerender();
      });
      return true;
    }
    return false;
  }
  if (target.id === "classSectionsTeacherImport") { const file = target.files?.[0]; target.value = ""; classSectionsTeacherImport(file); return true; }
  return false;
}
