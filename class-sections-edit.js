// 6단계 분반 편성 결과 직접 고치기: (a) 과목 × 블록 분반 수 표·같이 신청한 학생 수, (b) 학생 한 명 옮기기, (c) 배정 결과 엑셀 내려받기·올리기.
// class-sections-view.js 다음에 로드한다. 위쪽은 순수 계산(DOM·state 없음, 테스트에서 vm으로 올림), '// ---- 앱 연결' 아래가 화면.
// 학생 자료는 키(현학년-반-번호)로만 다루고 성명은 저장하지 않는다(엑셀에 보일 때만 명단에서 붙임).

// ---- 순수 계산 ----

function classSectionsEditPairKey(a, b) {
  return a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`;
}

// 과목 쌍마다 두 과목을 모두 신청한 학생 수(상호 선택 현황). students: [{ courses:[과목 key] }]
function classSectionsEditCoRequests(students) {
  const pairs = new Map();
  const demand = new Map();
  for (const student of students || []) {
    const list = [...new Set((student.courses || []).map(String))];
    for (const key of list) demand.set(key, (demand.get(key) || 0) + 1);
    for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) {
      const pair = classSectionsEditPairKey(list[i], list[j]);
      pairs.set(pair, (pairs.get(pair) || 0) + 1);
    }
  }
  return { pairs, demand, get: (a, b) => pairs.get(classSectionsEditPairKey(String(a), String(b))) || 0 };
}

// 과목 × 블록 분반 수 표. courses: [{ key, name }](이동 과목), students: 신청(학급 단위 과목 제외 전 원래 신청도 됨).
// 반환 rows[i].perBlock = { 블록id: 분반 수 }, blocks[j] = { id, letter, count, max }, conflicts = 같은 블록 하나에만 있는 두 과목을 함께 신청한 학생이 있는 쌍.
function classSectionsEditPlacementModel(result, courses, students) {
  const blocks = (result?.blocks || []).map((block) => ({ id: block.id, letter: block.letter, count: 0, max: Number(block.maxSections) || null }));
  const co = classSectionsEditCoRequests(students);
  const sections = result?.sections || [];
  const rows = (courses || []).map((course) => {
    const own = sections.filter((section) => section.courseKey === course.key);
    const perBlock = Object.fromEntries(blocks.map((block) => [block.id, own.filter((section) => section.blockId === block.id).length]));
    return { key: course.key, name: course.name || course.key, demand: co.demand.get(course.key) || 0, sections: own.length,
      capacity: own.reduce((sum, section) => sum + (Number(section.capacity) || 0), 0), size: own.reduce((sum, section) => sum + (Number(section.size) || 0), 0), perBlock };
  });
  for (const block of blocks) block.count = rows.reduce((sum, row) => sum + (row.perBlock[block.id] || 0), 0);
  const blocksOf = new Map(rows.map((row) => [row.key, blocks.filter((block) => row.perBlock[block.id] > 0).map((block) => block.id)]));
  const conflicts = [];
  const shared = [];
  for (let i = 0; i < rows.length; i += 1) for (let j = i + 1; j < rows.length; j += 1) {
    const a = rows[i];
    const b = rows[j];
    const count = co.get(a.key, b.key);
    if (!count) continue;
    const blocksA = blocksOf.get(a.key);
    const blocksB = blocksOf.get(b.key);
    const common = blocksA.filter((id) => blocksB.includes(id));
    if (!common.length) continue;
    const union = new Set([...blocksA, ...blocksB]);
    // 두 과목이 모두 같은 블록 하나에만 있으면 둘 다 신청한 학생은 한 과목을 못 듣는다(충돌).
    const item = { a: a.key, b: b.key, aName: a.name, bName: b.name, count, blocks: common };
    if (union.size === 1) conflicts.push(item); else shared.push(item);
  }
  conflicts.sort((x, y) => y.count - x.count);
  shared.sort((x, y) => y.count - x.count);
  return { blocks, rows, co, conflicts, shared };
}

// 표에서 한 과목의 블록별 분반 수를 바꾸면: 그 과목 분반(id '과목#1'…)을 블록 순서대로 고정하고, 다른 과목 분반은 지금 블록에 고정한다
// (배치는 그대로 두고 학생 배정만 다시 계산하기 위함). 반환 { pins:{분반id: 블록id}, sections: 그 과목 분반 수 }.
function classSectionsEditPlacementPins(result, courseKey, counts) {
  const pins = {};
  for (const section of result?.sections || []) if (section.courseKey !== courseKey && section.blockId) pins[section.id] = section.blockId;
  let ord = 0;
  for (const block of result?.blocks || []) {
    const n = Math.max(0, Math.floor(Number(counts?.[block.id]) || 0));
    for (let k = 0; k < n; k += 1) { ord += 1; pins[`${courseKey}#${ord}`] = block.id; }
  }
  return { pins, sections: ord };
}

// 직접 고친 뒤 다시 풀 때: 앞 결과와 비교해 분반이 바뀐 학생(분반 목록이 다른 학생) 목록.
function classSectionsEditChangedStudents(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const same = (a, b) => (a || []).slice().sort().join("|") === (b || []).slice().sort().join("|");
  return [...keys].filter((key) => !same(before?.[key], after?.[key])).sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
}

// 한 과목 칸을 고쳤을 때 다시 배정할 학생: 그 과목 분반에 있던 학생 + 그 과목을 신청한 학생(미배정 포함).
function classSectionsEditCourseStudents(result, courseKey, wishes) {
  const ids = new Set((result?.sections || []).filter((section) => section.courseKey === courseKey).map((section) => section.id));
  const out = new Set();
  for (const [key, list] of Object.entries(result?.assign || {})) if (list.some((id) => ids.has(id))) out.add(key);
  for (const [key, courses] of wishes || []) if ((courses || []).includes(courseKey)) out.add(key);
  return out;
}

// 다시 푼 결과의 '못 푼 정도': 정원·블록으로 못 넣은 미배정(폐강·블록 수 초과·이동 반 학급 단위 제외) + 정원 초과·블록 겹침·중복 오류.
function classSectionsEditBadness(result) {
  const structural = ["closed", "too-many", "class-unit-other-room"];
  return (result?.unassigned || []).filter((item) => !structural.includes(item.reason)).length
    + (result?.issues || []).filter((issue) => issue.severity === "error" && ["over-capacity", "block-conflict", "duplicate", "choice-over"].includes(issue.type)).length;
}

// 학생 한 명 옮기기 창의 표: 행 = 그 학생 이동 과목(신청 + 지금 배정), 열 = 블록, 칸 = 그 과목 분반들(인원/정원).
function classSectionsEditStudentRows(result, studentKey, wishes) {
  const sections = result?.sections || [];
  const assigned = result?.assign?.[studentKey] || [];
  const courseOf = new Map(sections.map((section) => [section.id, section.courseKey]));
  const keys = [];
  for (const key of wishes || []) if (!keys.includes(key) && sections.some((section) => section.courseKey === key)) keys.push(key);
  for (const id of assigned) { const key = courseOf.get(id); if (key && !keys.includes(key)) keys.push(key); }
  return keys.map((key) => {
    const own = sections.filter((section) => section.courseKey === key);
    const cells = {};
    for (const block of result.blocks || []) cells[block.id] = own.filter((section) => section.blockId === block.id)
      .map((section) => ({ id: section.id, size: Number(section.size) || 0, capacity: Number(section.capacity) || 0, roomName: section.roomName || section.id, no: section.noInBlock || 0 }));
    return { courseKey: key, name: own[0]?.courseName || key, wished: (wishes || []).includes(key), current: assigned.find((id) => courseOf.get(id) === key) || "", cells };
  });
}

// 학생 한 명의 새 분반 목록을 검사한다: 블록 겹침·정원 초과(옮겨 들어가는 분반)·택n(학급 단위 과목 포함)·신청하지 않은 과목.
function classSectionsEditCheck(spec) {
  const result = spec.result || {};
  const byId = new Map((result.sections || []).map((section) => [section.id, section]));
  const current = new Set(result.assign?.[spec.studentKey] || []);
  const ids = (spec.ids || []).filter(Boolean);
  const errors = [];
  const warnings = [];
  const usedBlocks = new Map();
  const usedCourses = new Set();
  for (const id of ids) {
    const section = byId.get(id);
    if (!section) { errors.push(`없는 분반 ${id}`); continue; }
    if (usedCourses.has(section.courseKey)) errors.push(`${section.courseName}에 두 분반`);
    usedCourses.add(section.courseKey);
    const other = usedBlocks.get(section.blockId);
    if (other) errors.push(`${section.blockLetter}블록에 두 과목(${other.courseName}, ${section.courseName})`);
    else usedBlocks.set(section.blockId, section);
    const size = (Number(section.size) || 0) + (current.has(id) ? 0 : 1);
    if (size > (Number(section.capacity) || Infinity)) errors.push(`${section.roomName || section.id} 정원 초과(${size}/${section.capacity}명)`);
    if (spec.wishes && !spec.wishes.includes(section.courseKey)) warnings.push(`신청하지 않은 ${section.courseName}`);
  }
  const choose = Number(spec.choose) || 0;
  const total = ids.length + (spec.unit ? 1 : 0);
  if (choose && total > choose) errors.push(`택${choose}보다 많은 과목(${total}과목${spec.unit ? ", 학급 단위 포함" : ""})`);
  else if (choose && total < choose) warnings.push(`택${choose}보다 적은 과목(${total}과목) — 빠진 과목은 미배정(재신청)으로 남습니다`);
  return { errors, warnings, ok: !errors.length };
}

// 추천: 과목마다 분반 하나씩, 블록이 겹치지 않고 정원 안에서 (바꾸는 과목 수, 채움 비율 합)이 가장 작은 조합.
function classSectionsEditRecommend(rows, studentKey, result) {
  const current = new Set(result?.assign?.[studentKey] || []);
  const options = rows.map((row) => Object.values(row.cells).flat().map((cell) => ({ ...cell,
    blockId: (result.sections || []).find((section) => section.id === cell.id)?.blockId || "",
    load: ((cell.size + (current.has(cell.id) ? 0 : 1)) / (cell.capacity || 1)), keep: current.has(cell.id) })).filter((cell) => cell.size + (cell.keep ? 0 : 1) <= (cell.capacity || Infinity)));
  let best = null;
  let visited = 0;
  const pick = [];
  const used = new Set();
  const walk = (i, changes, load) => {
    if (visited++ > 200000) return;
    if (best && (changes > best.changes || (changes === best.changes && load >= best.load))) return;
    if (i === options.length) { best = { ids: pick.slice(), changes, load }; return; }
    for (const cell of options[i].slice().sort((a, b) => Number(b.keep) - Number(a.keep) || a.load - b.load)) {
      if (used.has(cell.blockId)) continue;
      used.add(cell.blockId); pick.push(cell.id);
      walk(i + 1, changes + (cell.keep ? 0 : 1), load + cell.load);
      used.delete(cell.blockId); pick.pop();
    }
  };
  walk(0, 0, 0);
  return best ? best.ids : [];
}

// 배정 결과 엑셀(학생마다 과목별 '블록'·'분반 번호'). 분반 번호 = 그 블록 안 그 과목 번호(noInBlock).
// courses: [{ key, name }], students: [{ key, courses }](신청), names: Map(key → 성명, 파일에만).
function classSectionsEditAssignSheets(result, courses, students, names = new Map()) {
  const sections = result?.sections || [];
  const blocks = result?.blocks || [];
  const list = courses.filter((course) => sections.some((section) => section.courseKey === course.key));
  const byId = new Map(sections.map((section) => [section.id, section]));
  const opened = (course) => blocks.map((block) => ({ block, numbers: sections.filter((section) => section.courseKey === course.key && section.blockId === block.id).map((section) => section.noInBlock).sort((a, b) => a - b) }));
  const head1 = ["현 학년-반-번호", "성명"];
  const head2 = ["", ""];
  const head3 = ["열린 블록", ""];
  const merges = ["A1:A2", "B1:B2"];
  const column = (index) => { let n = index + 1; let text = ""; while (n > 0) { const r = (n - 1) % 26; text = String.fromCharCode(65 + r) + text; n = Math.floor((n - 1) / 26); } return text; };
  list.forEach((course, i) => {
    const at = 2 + i * 2;
    head1.push({ v: course.name, s: 2 }, { v: "", s: 2 });
    head2.push({ v: "블록", s: 2 }, { v: "분반 번호", s: 2 });
    head3.push(opened(course).filter((item) => item.numbers.length).map((item) => `${item.block.letter}(${item.numbers.join("·")})`).join(" "), "");
    merges.push(`${column(at)}1:${column(at + 1)}1`, `${column(at)}3:${column(at + 1)}3`);
  });
  const keys = [...new Set([...(students || []).map((student) => student.key), ...Object.keys(result?.assign || {})])]
    .sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
  const rows = keys.map((key) => {
    const row = [key, names.get(key) || ""];
    const assigned = (result.assign?.[key] || []).map((id) => byId.get(id)).filter(Boolean);
    for (const course of list) {
      const section = assigned.find((item) => item.courseKey === course.key);
      row.push(section ? section.blockLetter : "", section ? section.noInBlock : "");
    }
    return row;
  });
  // 과목별 블록 표: 열린 블록 칸에 분반 번호, 열리지 않은 블록은 회색.
  const blockRows = [["과목", ...blocks.map((block) => `${block.letter}블록`)],
    ...list.map((course) => [course.name, ...opened(course).map((item) => (item.numbers.length ? item.numbers.join("·") : { v: "", s: 6 }))])];
  return [
    { name: "배정 결과", rows: [head1.map((cell) => (typeof cell === "string" ? { v: cell, s: 2 } : cell)), head2.map((cell) => (typeof cell === "string" ? { v: cell, s: 2 } : cell)), head3, ...rows],
      widths: [16, 10, ...list.flatMap(() => [8, 9])], merges, freeze: "C4" },
    { name: "과목별 블록", rows: blockRows, widths: [22, ...blocks.map(() => 10)], orientation: "portrait" },
    { name: "안내", orientation: "portrait", widths: [100], rows: [["배정 결과 고치기"],
      ["'배정 결과' 시트에서 학생의 과목별 '블록'(a·b·…)과 '분반 번호'(그 블록 안 번호, '열린 블록' 줄의 괄호 안 번호)를 고친 뒤 6단계에서 '배정 결과 엑셀 올리기'로 올리세요."],
      ["두 칸을 모두 비우면 그 과목은 미배정(재신청)으로 남습니다. 학생 줄·과목 열을 지우거나 순서를 바꿔도 됩니다(학생 키·과목 이름으로 맞춤)."],
      ["성명은 확인용이며 앱에 저장하지 않습니다."]] }];
}

// 올린 배정 결과 엑셀 → 바뀐 학생의 새 분반 목록과 확인할 문제. rows: 첫 시트 행 배열.
function classSectionsEditReadAssign(rows, result, spec = {}) {
  const sections = result?.sections || [];
  const byLetter = new Map((result?.blocks || []).map((block) => [String(block.letter).toLowerCase(), block.id]));
  const text = (value) => String(value ?? "").trim();
  const compact = (value) => text(value).replace(/\s+/g, "");
  const headerAt = (rows || []).findIndex((row) => compact(row?.[0]) === "현학년-반-번호");
  if (headerAt < 0) return { error: "'현 학년-반-번호' 머리글을 찾지 못했습니다(내려받은 배정 결과 양식인지 확인하세요).", changes: {}, changed: [], problems: [] };
  const header = rows[headerAt] || [];
  const nameKey = new Map();
  for (const section of sections) if (!nameKey.has(compact(section.courseName))) nameKey.set(compact(section.courseName), section.courseKey);
  const columns = [];
  const unknownCourses = [];
  for (let c = 2; c < header.length; c += 1) {
    const name = compact(header[c]);
    if (!name) continue;
    const key = nameKey.get(name);
    if (key) columns.push({ key, name: text(header[c]), col: c }); else unknownCourses.push(text(header[c]));
  }
  const normalize = spec.normalizeKey || ((value) => text(value));
  const known = new Set(spec.studentKeys || Object.keys(result?.assign || {}));
  const changes = {};
  const problems = [];
  const unknownStudents = [];
  const sorted = (list) => list.slice().sort().join("|");
  for (const row of rows.slice(headerAt + 1)) {
    const rawKey = text(row?.[0]);
    if (!rawKey || /^열린\s*블록$/.test(rawKey) || !/\d/.test(rawKey)) continue;
    const key = normalize(rawKey);
    if (!known.has(key)) { unknownStudents.push(rawKey); continue; }
    const ids = [];
    for (const column of columns) {
      const letter = text(row[column.col]).toLowerCase().replace(/블록$/, "");
      const no = Number(text(row[column.col + 1]));
      if (!letter && !text(row[column.col + 1])) continue;
      const blockId = byLetter.get(letter);
      const section = blockId && sections.find((item) => item.courseKey === column.key && item.blockId === blockId && Number(item.noInBlock) === no);
      if (!section) { problems.push(`${key}: ${column.name} ${letter || "?"}블록 ${no || "?"}번 분반이 없습니다`); continue; }
      ids.push(section.id);
    }
    // 엑셀에 없는 과목 열(지운 열)의 지금 배정은 그대로 둔다.
    const listed = new Set(columns.map((column) => column.key));
    for (const id of result.assign?.[key] || []) { const section = sections.find((item) => item.id === id); if (section && !listed.has(section.courseKey)) ids.push(id); }
    if (sorted(ids) !== sorted(result.assign?.[key] || [])) changes[key] = ids;
  }
  // 바뀐 뒤 전체 인원으로 정원·블록 겹침·택n 확인
  const assign = { ...(result.assign || {}), ...changes };
  const sizes = new Map();
  for (const ids of Object.values(assign)) for (const id of ids) sizes.set(id, (sizes.get(id) || 0) + 1);
  const byId = new Map(sections.map((section) => [section.id, section]));
  for (const [id, size] of sizes) {
    const section = byId.get(id);
    if (section && size > section.capacity && (Number(section.size) || 0) < size) problems.push(`${section.roomName || id} 정원 초과(${size}/${section.capacity}명)`);
  }
  for (const [key, ids] of Object.entries(changes)) {
    const check = classSectionsEditCheck({ result: { ...result, sections: sections.map((section) => ({ ...section, size: 0 })), assign: {} }, studentKey: key, ids,
      choose: spec.choose, unit: spec.unitOf?.[key], wishes: spec.wishesOf?.[key] });
    for (const message of check.errors.filter((item) => !/정원 초과/.test(item))) problems.push(`${key}: ${message}`);
  }
  return { changes, changed: Object.keys(changes), problems, unknownStudents, unknownCourses };
}

// ---- 앱 연결 ----

function classSectionsEditWishes(group) {
  return new Map((group?.students || []).map((student) => [student.key, (student.courses || []).slice()]));
}

function classSectionsEditMoveCourses(group, settings) {
  const modes = typeof classSectionsCourseModes === "function" ? classSectionsCourseModes(settings, group) : {};
  return group.courses.filter((course) => modes[course.key] !== "class").map((course) => ({ key: course.key, name: course.name }));
}

function classSectionsEditHtml(round, group, entry, result) {
  if (!result?.sections?.length) return "";
  const esc = typeof classSectionsEsc === "function" ? classSectionsEsc : (value) => String(value ?? "");
  const settings = classSectionsSettings();
  const model = classSectionsEditPlacementModel(result, classSectionsEditMoveCourses(group, settings), group.students);
  const view = CLASS_SECTIONS_VIEW;
  const selected = view.coCourse && model.rows.some((row) => row.key === view.coCourse) ? view.coCourse : "";
  const blocksOf = new Map(model.rows.map((row) => [row.key, model.blocks.filter((block) => row.perBlock[block.id] > 0).map((block) => block.id)]));
  const conflictCells = new Set();
  for (const item of model.conflicts) for (const id of item.blocks) { conflictCells.add(`${item.a}|${id}`); conflictCells.add(`${item.b}|${id}`); }
  const rows = model.rows.map((row) => {
    const co = selected && selected !== row.key ? model.co.get(selected, row.key) : 0;
    const sameBlock = co && blocksOf.get(selected).some((id) => row.perBlock[id] > 0);
    const cells = model.blocks.map((block) => {
      const n = row.perBlock[block.id] || 0;
      const hot = conflictCells.has(`${row.key}|${block.id}`) ? " is-conflict" : sameBlock && n && blocksOf.get(selected).includes(block.id) ? " is-shared" : "";
      return `<td class="cs-place-cell${n ? "" : " is-empty"}${hot}"><input class="cs-num" type="number" min="0" max="30" value="${n}" data-cs-place-course="${esc(row.key)}" data-cs-place-block="${esc(block.id)}" data-focus-key="cs-place-${esc(row.key)}-${esc(block.id)}" aria-label="${esc(row.name)} ${esc(block.letter)}블록 분반 수"></td>`;
    }).join("");
    return `<tr class="${row.key === selected ? "is-selected" : ""}${co ? " has-co" : ""}"><th scope="row"><button class="cs-link" type="button" data-cs-co-course="${esc(row.key)}" aria-pressed="${row.key === selected}" aria-label="${esc(row.name)} 같이 신청한 학생 보기">${esc(row.name)}</button></th>
      <td>${row.demand}</td><td>${row.sections}</td><td>${row.capacity}</td>${cells}<td class="cs-co">${selected && selected !== row.key ? `${co}명${sameBlock ? " · 같은 블록" : ""}` : ""}</td></tr>`;
  }).join("");
  const foot = model.blocks.map((block) => `<td${block.max && block.count > block.max ? ' class="is-over"' : ""}>${block.count}${block.max ? ` / ${block.max}` : ""}${block.max && block.count > block.max ? ` <span class="cs-tag" data-cs-block-over="${esc(block.id)}">최대 ${block.max} 초과</span>` : ""}</td>`).join("");
  const pinnedCount = Object.keys(entry.pins?.sections || {}).length;
  const pairText = (item) => `${item.aName}·${item.bName} ${item.count}명(${item.blocks.map((id) => model.blocks.find((block) => block.id === id)?.letter || id).join("·")}블록)`;
  const conflictNote = model.conflicts.length
    ? `<p class="cs-note is-warn" id="classSectionsCoConflicts">같은 블록 하나에만 있는 두 과목을 함께 신청한 학생: ${esc(model.conflicts.slice(0, 6).map(pairText).join(", "))}${model.conflicts.length > 6 ? " …" : ""} — 한 과목을 다른 블록으로 옮기세요.</p>` : "";
  const coList = selected ? model.rows.filter((row) => row.key !== selected).map((row) => ({ row, n: model.co.get(selected, row.key) })).filter((item) => item.n > 0).sort((a, b) => b.n - a.n) : [];
  const selectedName = model.rows.find((row) => row.key === selected)?.name || "";
  const withName = typeof classSectionsJosa === "function" ? classSectionsJosa(selectedName, "과/와") : `${selectedName}와`;
  return `<section class="cs-card" aria-label="직접 고치기">
    <h4>직접 고치기 <span class="cs-note">과목 × 블록 분반 수 · 같이 신청한 학생 · 학생 옮기기 · 배정 결과 엑셀</span></h4>
    <p class="cs-note">칸의 분반 수를 바꾸면 그 과목 분반을 그 블록에 고정하고(다른 분반도 지금 블록에 고정) 그 과목 학생만 다시 배정합니다 — 나머지 학생은 지금 분반 그대로. 정원·블록 때문에 안 되면 바뀌는 학생이 가장 적게 전체를 다시 풀고, 바뀐 학생이 많으면 적용 전에 묻습니다. 과목 이름을 누르면 같이 신청한 학생 수를 봅니다.</p>
    ${result.editChange ? `<p class="cs-note" id="classSectionsEditChange" data-changed="${result.editChange.changed}" data-own="${result.editChange.own}">최근 직접 고치기: ${esc(result.editChange.label)} · ${esc(classSectionsEditChangeText(result.editChange))}</p>` : ""}
    <p class="cs-note${pinnedCount ? " is-warn" : ""}" id="classSectionsPinNote">표에서 칸을 고치면 이 그룹의 모든 분반이 지금 블록에 고정됩니다(다시 계산해도 블록이 바뀌지 않음).${pinnedCount ? ` 지금 블록 고정 ${pinnedCount}개.` : ""}
      ${pinnedCount ? `<button class="button button-quiet" type="button" id="classSectionsUnpinAll">블록 고정 모두 풀기</button>` : ""}</p>
    <div class="cs-table-wrap" data-scroll-key="cs-place"><table class="cs-table cs-place" id="classSectionsPlacementTable" aria-label="과목 × 블록 분반 수">
      <thead><tr><th>과목</th><th>신청</th><th>분반</th><th>정원 합</th>${model.blocks.map((block) => `<th>${esc(block.letter)}블록</th>`).join("")}<th>${selected ? `${esc(withName)} 같이 신청` : "같이 신청"}</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><th scope="row">블록별 분반 / 최대</th><td></td><td>${model.rows.reduce((sum, row) => sum + row.sections, 0)}</td><td>${model.rows.reduce((sum, row) => sum + row.capacity, 0)}</td>${foot}<td></td></tr></tfoot>
    </table></div>
    ${conflictNote}
    ${selected ? `<p class="cs-note" id="classSectionsCoPanel">${esc(withName)} 같이 신청한 학생: ${coList.length ? esc(coList.map((item) => `${item.row.name} ${item.n}명`).join(", ")) : "없음"}</p>` : ""}
    <div class="cs-actions">
      <button class="button" type="button" id="classSectionsAssignExport">배정 결과 엑셀 내려받기</button>
      <label class="button">배정 결과 엑셀 올리기<input id="classSectionsAssignImport" type="file" accept=".xlsx" hidden aria-label="배정 결과 엑셀 올리기"></label>
      <span class="cs-note">학생 한 명을 옮기려면 아래 '학생 찾기'에서 학생의 '옮기기'를 누르세요.</span>
    </div>
  </section>`;
}

// 표의 분반 수 칸을 바꿈 → 블록 고정 + 분반 수 → 다시 계산(배치 고정, 학생 배정만 다시)
function classSectionsEditApplyPlacement(courseKey, blockId, value) {
  const context = classSectionsCurrent();
  const result = context?.entry?.sectionResult;
  if (!result) return;
  const counts = Object.fromEntries(result.blocks.map((block) => [block.id, result.sections.filter((section) => section.courseKey === courseKey && section.blockId === block.id).length]));
  counts[blockId] = Math.max(0, Math.floor(Number(value) || 0));
  const { pins, sections } = classSectionsEditPlacementPins(result, courseKey, counts);
  const before = { pins: { ...context.entry.pins.sections }, had: Object.prototype.hasOwnProperty.call(context.entry.classCounts, courseKey), count: context.entry.classCounts[courseKey] };
  context.entry.pins.sections = pins;
  context.entry.classCounts[courseKey] = sections;
  const name = result.sections.find((section) => section.courseKey === courseKey)?.courseName || courseKey;
  const affected = classSectionsEditCourseStudents(result, courseKey, classSectionsEditWishes(context.group));
  classSectionsEditSolve({ affected, scopeLabel: `${name} 학생`, label: `${name} 분반을 블록별 ${result.blocks.map((block) => `${block.letter}${counts[block.id]}`).join("·")}개로 고정`,
    restore: () => {
      context.entry.pins.sections = before.pins;
      if (before.had) context.entry.classCounts[courseKey] = before.count; else delete context.entry.classCounts[courseKey];
    } });
}

// 직접 고친 뒤 다시 계산: 앞 배정에서 바뀌는 학생이 가장 적게.
// 1) 고친 학생(그 과목 학생·옮긴 학생)만 풀어 두고 나머지는 앞 분반 그대로(부분 재계산) → 2) 정원·블록 때문에 안 되면 전체를 다시 풀되
// 앞 배정에서 바뀌는 학생에게 큰 비용(keepWeight) → 3) 그래도 안 되면 원인 안내(결과의 요약·제안). 고정 학생·교실 고정은 그대로.
// 바뀐 학생이 고친 학생의 2배를 넘으면 적용 전에 묻고, 취소하면 restore()로 되돌린다.
var CLASS_SECTIONS_EDIT_KEEP_WEIGHT = 200;
async function classSectionsEditSolve(spec) {
  const context = classSectionsCurrent();
  if (!context?.entry?.sectionResult || CLASS_SECTIONS_VIEW.running) return;
  const { round, group, entry, source } = context;
  const scope = { round, group: group.key };
  const previous = entry.sectionResult;
  const prev = { sections: previous.sections.map((section) => ({ id: section.id, blockId: section.blockId })), assign: previous.assign, teacherOf: previous.teacherOf };
  const roomNames = typeof classSectionsPreviousRoomNames === "function" ? classSectionsPreviousRoomNames(previous) : undefined;
  const affected = [...(spec.affected || [])];
  CLASS_SECTIONS_VIEW.running = true;
  classSectionsSetStatus(`${spec.label} · ${spec.scopeLabel} ${affected.length}명만 다시 배정하는 중…`, false, scope);
  renderClassSections();
  try {
    let input = classSectionsBuildInput(round, group, entry, { partial: true, previous: prev, changedStudents: affected, roomNames });
    let result = await classSectionsRunSolver({ kind: "solve", input });
    let path = "partial";
    if (classSectionsEditBadness(result) > classSectionsEditBadness(previous)) {
      classSectionsSetStatus(`${spec.label} · ${spec.scopeLabel}만으로는 정원·블록이 맞지 않아 바뀌는 학생이 가장 적게 전체를 다시 푸는 중…`, false, scope);
      const fullInput = classSectionsBuildInput(round, group, entry, { previous: prev, keepWeight: CLASS_SECTIONS_EDIT_KEEP_WEIGHT, roomNames, baseline: { assign: previous.assign } });
      // 블록 배치는 그대로(고정하지 않은 분반도 지금 블록에) — 학생 배정만 다시.
      fullInput.pins = { ...fullInput.pins, sections: { ...Object.fromEntries(prev.sections.filter((section) => section.blockId).map((section) => [section.id, section.blockId])), ...(fullInput.pins?.sections || {}) } };
      const full = await classSectionsRunSolver({ kind: "solve", input: fullInput });
      if (classSectionsEditBadness(full) < classSectionsEditBadness(result)) { result = full; input = fullInput; path = "full"; }
    }
    const changed = classSectionsEditChangedStudents(previous.assign, result.assign);
    const own = affected.length;
    if (changed.length > Math.max(own * 2, own + 10)) {
      const ok = await classSectionsConfirm(`${spec.label}: 분반이 바뀌는 학생이 ${changed.length}명으로 ${spec.scopeLabel} ${own}명보다 많습니다(정원·블록을 맞추려면 다른 학생도 옮겨야 함). 적용할까요?`, { title: "다시 계산 결과 적용", ok: "적용" });
      if (!ok) { spec.restore?.(); classSectionsSetStatus(`${spec.label}을(를) 취소하고 앞 결과로 되돌렸습니다.`, false, scope); return; }
    }
    classSectionsSaveResult(entry, result, input, group, source);
    entry.sectionResult.editChange = { label: spec.label, changed: changed.length, own, scopeLabel: spec.scopeLabel, path };
    classSectionsSetStatus(`${spec.label} · ${classSectionsEditChangeText(entry.sectionResult.editChange)} · ${result.explain.summary}`, !result.explain.feasible, scope);
  } catch (error) {
    classSectionsSetStatus(`다시 계산 실패: ${error?.message || error}`, true, scope);
  } finally {
    CLASS_SECTIONS_VIEW.running = false;
    if (typeof persistStateSoon === "function") persistStateSoon(); else if (typeof persistState === "function") persistState();
    renderClassSections();
  }
}

function classSectionsEditChangeText(change) {
  if (!change) return "";
  return `분반이 바뀐 학생 ${change.changed}명(${change.scopeLabel} ${change.own}명 포함)${change.path === "full" ? " — 고친 학생만으로는 풀리지 않아 전체를 다시 풀되 바뀌는 학생을 최소로" : ""}`;
}

function classSectionsEditDialog() {
  let dialog = document.getElementById("classSectionsMoveDialog");
  if (!dialog) {
    document.body.insertAdjacentHTML("beforeend", `<dialog class="app-dialog cs-move-dialog" id="classSectionsMoveDialog" aria-labelledby="classSectionsMoveTitle">
      <form method="dialog"><h3 id="classSectionsMoveTitle">학생 옮기기</h3><div id="classSectionsMoveBody"></div>
      <div class="cs-actions"><button class="button" type="button" id="classSectionsMoveRecommend">추천 칸으로</button>
      <button class="button button-primary" type="button" id="classSectionsMoveSave">저장(학생 고정)</button>
      <button class="button" type="button" id="classSectionsMoveUnpin">고정 풀기</button>
      <button class="button" value="cancel" id="classSectionsMoveClose">닫기</button></div></form></dialog>`);
    dialog = document.getElementById("classSectionsMoveDialog");
    dialog.addEventListener("change", () => classSectionsEditRenderMoveIssues());
    dialog.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.id === "classSectionsMoveRecommend") { event.preventDefault(); classSectionsEditUseRecommendation(); }
      else if (button.id === "classSectionsMoveSave") { event.preventDefault(); classSectionsEditSaveMove(); }
      else if (button.id === "classSectionsMoveUnpin") { event.preventDefault(); classSectionsEditSaveMove(true); }
    });
  }
  return dialog;
}

function classSectionsEditMoveContext(studentKey) {
  const context = classSectionsCurrent();
  const result = context?.entry?.sectionResult;
  if (!result) return null;
  const wishes = classSectionsEditWishes(context.group).get(studentKey) || [];
  const rows = classSectionsEditStudentRows(result, studentKey, wishes);
  let unit = "";
  try { unit = classSectionsBuildInput(context.round, context.group, context.entry, { noOccupied: true }).classUnit?.unitOf?.[studentKey] || ""; } catch { unit = ""; }
  return { ...context, result, studentKey, wishes, rows, unit, recommended: classSectionsEditRecommend(rows, studentKey, result) };
}

function classSectionsEditOpenMove(studentKey) {
  const move = classSectionsEditMoveContext(studentKey);
  if (!move) return;
  CLASS_SECTIONS_VIEW.move = { studentKey };
  const esc = classSectionsEsc;
  const dialog = classSectionsEditDialog();
  const recommended = new Set(move.recommended);
  const pinned = move.entry.pins.students?.[studentKey];
  const unitName = move.unit ? (move.group.courses.find((course) => course.key === move.unit)?.name || move.unit) : "";
  const header = move.result.blocks.map((block) => `<th>${esc(block.letter)}블록</th>`).join("");
  const body = move.rows.map((row) => {
    const cells = move.result.blocks.map((block) => {
      const list = row.cells[block.id] || [];
      if (!list.length) return '<td class="is-empty" aria-label="분반 없음"></td>';
      return `<td>${list.map((cell) => `<label class="cs-move-cell${cell.id === row.current ? " is-current" : ""}${recommended.has(cell.id) ? " is-recommended" : ""}">
        <input type="radio" name="cs-move-${esc(row.courseKey)}" value="${esc(cell.id)}"${cell.id === row.current ? " checked" : ""} data-cs-move-course="${esc(row.courseKey)}" data-focus-key="cs-move-${esc(cell.id)}" aria-label="${esc(row.name)} ${esc(cell.roomName)} ${cell.size}/${cell.capacity}명${cell.id === row.current ? " (지금)" : ""}${recommended.has(cell.id) ? " (추천)" : ""}">
        ${esc(cell.roomName)} <span>${cell.size}/${cell.capacity}</span>${cell.id === row.current ? " <em>지금</em>" : ""}${recommended.has(cell.id) ? " <em>추천</em>" : ""}</label>`).join("")}</td>`;
    }).join("");
    return `<tr><th scope="row">${esc(row.name)}${row.wished ? "" : ' <span class="cs-tag">신청 안 함</span>'}</th>${cells}<td><label><input type="radio" name="cs-move-${esc(row.courseKey)}" value=""${row.current ? "" : " checked"} data-cs-move-course="${esc(row.courseKey)}" aria-label="${esc(row.name)} 배정 안 함"> 배정 안 함</label></td></tr>`;
  }).join("");
  dialog.querySelector("#classSectionsMoveTitle").textContent = `학생 옮기기 · ${studentKey}`;
  dialog.querySelector("#classSectionsMoveBody").innerHTML = `
    <p class="cs-note">칸 = 그 과목 분반(인원/정원). 굵은 테두리 = 지금, '추천' = 블록이 겹치지 않고 정원 안에서 덜 바꾸는 조합. 회색 = 그 블록에 그 과목 분반 없음.${unitName ? ` 학급 단위 과목: ${esc(unitName)}(이동 분반 아님).` : ""}${pinned ? " 이 학생은 지금 고정돼 있습니다." : ""}</p>
    <table class="cs-table cs-move" aria-label="${esc(studentKey)} 과목별 분반"><thead><tr><th>과목</th>${header}<th></th></tr></thead><tbody>${body}</tbody></table>
    <div id="classSectionsMoveIssues" role="status" aria-live="polite"></div>`;
  classSectionsEditRenderMoveIssues();
  if (!dialog.open) dialog.showModal();
}

function classSectionsEditPickedIds() {
  const dialog = document.getElementById("classSectionsMoveDialog");
  if (!dialog) return [];
  return [...dialog.querySelectorAll("input[type=radio][data-cs-move-course]:checked")].map((input) => input.value).filter(Boolean);
}

function classSectionsEditRenderMoveIssues() {
  const move = CLASS_SECTIONS_VIEW.move && classSectionsEditMoveContext(CLASS_SECTIONS_VIEW.move.studentKey);
  const box = document.getElementById("classSectionsMoveIssues");
  if (!move || !box) return null;
  const check = classSectionsEditCheck({ result: move.result, studentKey: move.studentKey, ids: classSectionsEditPickedIds(), choose: move.group.choice, unit: move.unit, wishes: move.wishes });
  const esc = classSectionsEsc;
  box.innerHTML = check.errors.length || check.warnings.length
    ? `${check.errors.length ? `<ul class="cs-list is-error">${check.errors.map((text) => `<li>${esc(text)}</li>`).join("")}</ul>` : ""}${check.warnings.length ? `<ul class="cs-list">${check.warnings.map((text) => `<li>${esc(text)}</li>`).join("")}</ul>` : ""}`
    : '<p class="cs-note">문제 없음(블록 겹침·정원 초과·택n 확인).</p>';
  box.dataset.state = check.errors.length ? "error" : "ok";
  return check;
}

function classSectionsEditUseRecommendation() {
  const move = CLASS_SECTIONS_VIEW.move && classSectionsEditMoveContext(CLASS_SECTIONS_VIEW.move.studentKey);
  const dialog = document.getElementById("classSectionsMoveDialog");
  if (!move || !dialog) return;
  for (const id of move.recommended) {
    const input = [...dialog.querySelectorAll("input[type=radio]")].find((item) => item.value === id);
    if (input) input.checked = true;
  }
  classSectionsEditRenderMoveIssues();
}

async function classSectionsEditSaveMove(unpin = false) {
  const move = CLASS_SECTIONS_VIEW.move && classSectionsEditMoveContext(CLASS_SECTIONS_VIEW.move.studentKey);
  const dialog = document.getElementById("classSectionsMoveDialog");
  if (!move) return;
  if (unpin) {
    delete move.entry.pins.students[move.studentKey];
    dialog?.close();
    classSectionsSetStatus(`${move.studentKey} 고정을 풀었습니다. 다음 계산에서 다시 배정합니다.`);
    if (typeof classSectionsChanged === "function") classSectionsChanged();
    return;
  }
  const ids = classSectionsEditPickedIds();
  const check = classSectionsEditCheck({ result: move.result, studentKey: move.studentKey, ids, choose: move.group.choice, unit: move.unit, wishes: move.wishes });
  if (check.errors.length && !(await classSectionsConfirm(`${move.studentKey}: ${check.errors.join(", ")}. 그래도 이렇게 고정할까요?`, { title: "학생 옮기기", ok: "고정" }))) return;
  const had = Object.prototype.hasOwnProperty.call(move.entry.pins.students, move.studentKey);
  const before = move.entry.pins.students[move.studentKey];
  move.entry.pins.students[move.studentKey] = ids;
  dialog?.close();
  CLASS_SECTIONS_VIEW.move = null;
  classSectionsEditSolve({ affected: new Set([move.studentKey]), scopeLabel: "옮긴 학생", label: `${move.studentKey} 옮기기(고정)`,
    restore: () => { if (had) move.entry.pins.students[move.studentKey] = before; else delete move.entry.pins.students[move.studentKey]; } });
}

function classSectionsEditExport() {
  const context = classSectionsCurrent();
  const result = context?.entry?.sectionResult;
  if (!result || typeof createWorkbookBlob !== "function" || typeof downloadBlob !== "function") return;
  const names = typeof classSectionsStudentNames === "function" ? classSectionsStudentNames(context.round) : new Map();
  const sheets = classSectionsEditAssignSheets(result, classSectionsEditMoveCourses(context.group, classSectionsSettings()), context.group.students, names);
  const year = String((Number($("#schoolYear")?.value) || new Date().getFullYear()) + 1);
  const base = `${year}_${context.group.targetGrade}학년_${context.group.semester}학기_${String(context.group.category).replace(/[\\/:*?"<>|]/g, "")}`;
  return downloadBlob(createWorkbookBlob(sheets), `${base}_배정결과.xlsx`);
}

function classSectionsEditNormalizeKey(value) {
  const parts = String(value ?? "").trim().split(/[-\s]+/);
  return parts.length === 3 && typeof classSectionsStudentKey === "function" ? classSectionsStudentKey(parts[0], parts[1], parts[2]) : String(value ?? "").trim();
}

async function classSectionsEditImport(file) {
  const context = classSectionsCurrent();
  const result = context?.entry?.sectionResult;
  if (!file || !result) return;
  try {
    const sheets = await parseWorkbook(await file.arrayBuffer());
    const sheet = sheets.find((item) => item.name === "배정 결과") || sheets[0];
    let unitOf = {};
    try { unitOf = classSectionsBuildInput(context.round, context.group, context.entry, { noOccupied: true }).classUnit?.unitOf || {}; } catch { unitOf = {}; }
    const wishes = classSectionsEditWishes(context.group);
    const read = classSectionsEditReadAssign(sheet?.rows || [], result, { normalizeKey: classSectionsEditNormalizeKey, choose: context.group.choice, unitOf,
      wishesOf: Object.fromEntries(wishes), studentKeys: [...new Set([...wishes.keys(), ...Object.keys(result.assign || {})])] });
    if (read.error) { classSectionsSetStatus(read.error, true); return renderClassSections(); }
    const extra = [...(read.unknownStudents.length ? [`이 그룹에 없는 학생 ${read.unknownStudents.length}명(예: ${read.unknownStudents.slice(0, 3).join(", ")})`] : []),
      ...(read.unknownCourses.length ? [`모르는 과목 열: ${read.unknownCourses.join(", ")}`] : [])];
    if (!read.changed.length) { classSectionsSetStatus(`배정 결과 엑셀: 바뀐 학생이 없습니다.${extra.length ? ` ${extra.join(" · ")}` : ""}${read.problems.length ? ` 확인 ${read.problems.length}건: ${read.problems.slice(0, 3).join(" / ")}` : ""}`, read.problems.length > 0); return renderClassSections(); }
    const text = `바뀐 학생 ${read.changed.length}명(예: ${read.changed.slice(0, 5).join(", ")})을 엑셀대로 고정하고 바뀐 학생만 다시 계산할까요?${read.problems.length ? `\n\n확인할 문제 ${read.problems.length}건:\n${read.problems.slice(0, 10).join("\n")}${read.problems.length > 10 ? "\n…" : ""}` : ""}${extra.length ? `\n\n${extra.join("\n")}` : ""}`;
    if (!(await classSectionsConfirm(text, { title: "배정 결과 엑셀 적용", ok: "적용" }))) { classSectionsSetStatus("배정 결과 엑셀 적용을 취소했습니다."); return renderClassSections(); }
    const before = { ...context.entry.pins.students };
    for (const [key, ids] of Object.entries(read.changes)) context.entry.pins.students[key] = ids;
    classSectionsEditSolve({ affected: new Set(read.changed), scopeLabel: "엑셀에서 고친 학생", label: `배정 결과 엑셀(고친 학생 ${read.changed.length}명 고정${read.problems.length ? ` · 확인 ${read.problems.length}건` : ""})`,
      restore: () => { context.entry.pins.students = before; } });
  } catch (error) {
    classSectionsSetStatus(`배정 결과 엑셀을 읽지 못했습니다: ${error?.message || error}`, true);
    renderClassSections();
  }
}

// class-sections-view.js의 click·change 처리기가 먼저 부른다. 처리했으면 true.
function classSectionsEditClick(target) {
  if (target.dataset?.csCoCourse !== undefined) {
    CLASS_SECTIONS_VIEW.coCourse = CLASS_SECTIONS_VIEW.coCourse === target.dataset.csCoCourse ? "" : target.dataset.csCoCourse;
    renderClassSections();
    return true;
  }
  if (target.dataset?.csMoveStudent !== undefined) { classSectionsEditOpenMove(target.dataset.csMoveStudent); return true; }
  if (target.id === "classSectionsAssignExport") { classSectionsEditExport(); return true; }
  if (target.id === "classSectionsUnpinAll") {
    const context = classSectionsCurrent();
    if (!context?.entry) return true;
    const count = Object.keys(context.entry.pins.sections || {}).length;
    context.entry.pins.sections = {};
    classSectionsSetStatus(`블록 고정 ${count}개를 모두 풀었습니다. '편성 계산'을 누르면 블록 배치부터 다시 찾습니다.`);
    if (typeof classSectionsChanged === "function") classSectionsChanged();
    return true;
  }
  return false;
}

function classSectionsEditChange(target) {
  if (target.dataset?.csPlaceCourse !== undefined) { classSectionsEditApplyPlacement(target.dataset.csPlaceCourse, target.dataset.csPlaceBlock, target.value); return true; }
  if (target.id === "classSectionsAssignImport") { const file = target.files?.[0]; target.value = ""; classSectionsEditImport(file); return true; }
  return false;
}
