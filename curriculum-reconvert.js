"use strict";
// 1단계 편제표: 예전 변환기(planData.converter < PLAN_DATA_CONVERTER)로 만든 저장 자료를 보관된 원본 엑셀(IndexedDB
// curriculum-original-workbooks)에서 새 변환기로 다시 읽어 초기 자료를 바꾼다. 데이터를 추정으로 고치지 않는다.
//  · 업로드 뒤 교사가 고친 곳 = 업로드 시점 데이터(IndexedDB 'origin:' 기록 → 없으면 같은 원본의 '편제표 업로드' 이력) 와 지금 데이터의 차이.
//    새로 읽은 데이터에 그대로 다시 적용할 수 있으면 재적용하고, 충돌하거나 업로드 시점 데이터가 없으면 확인 창을 띄운다.
//  · 원본이 없으면(울산 파일 불러오기 등) 바꾸지 않고 "원본 파일을 다시 올리면 정확히 갱신됩니다" 안내만 한다. 전학년은 다시 만든다.
// 위쪽은 순수 계산(테스트에서 vm으로 올린다), '// ---- 앱 연결' 아래는 IndexedDB·확인 창·카드 배지. app.js·curriculum-data.js 다음에 로드한다.

var PLAN_RECONVERT_FIELDS = ["name", "originalName", "category", "domain", "area", "kindText", "kind", "kindJoin", "base", "op", "opFormula",
  "cross", "crossSplit", "note", "completion", "required", "planSection", "planSectionManual", "hidden", "values", "semMerge"];
var PLAN_RECONVERT_MAPS = ["credits", "texts", "extra"];
var PLAN_RECONVERT_LABELS = { name: "과목명", originalName: "자동 수정 전 이름", category: "구분", domain: "교과 영역", area: "교과(군)", kindText: "과목 종류 칸",
  kind: "과목 종류", kindJoin: "과목 종류 병합", base: "기준학점", op: "운영학점", opFormula: "운영학점 수식", cross: "교차집중", crossSplit: "교차집중 학급 배분",
  note: "학기 칸 메모", completion: "이수학점", required: "필수이수학점", planSection: "편성 영역", planSectionManual: "편성 영역 지정", hidden: "숨김",
  values: "고정 행 값", semMerge: "학기 칸 병합", credits: "학점", texts: "학기 칸 글자", extra: "추가 열" };

function planReconvertSame(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// 원본 엑셀의 같은 행에서 나온 과목은 같은 과목으로 본다(행 번호가 없는 과목은 이름).
function planReconvertKey(subject) {
  const source = subject?.styleRows?.[0];
  if (source !== null && source !== undefined) return `r${source}`;
  return `n${planDataNameKey(subject?.originalName ?? subject?.name ?? "")}`;
}

function planReconvertName(subject) {
  if (!subject) return "";
  if (subject.fixed) return `고정 행(${(subject.values || []).map((value) => String(value ?? "").trim()).filter(Boolean).slice(0, 2).join(" ") || "빈 행"})`;
  return planDataSubjectNames(subject.name).join(", ") || String(subject.name || "");
}

function planReconvertValueText(value) {
  if (value === undefined || value === null || value === "") return "없음";
  if (Array.isArray(value)) return value.map((item) => /^sem\d\d$/.test(item) ? `${item[3]}-${item[4]}` : String(item)).join("·") || "없음";
  if (typeof value === "object") return value.text !== undefined ? String(value.text || "없음") : JSON.stringify(value);
  return String(value);
}

// 묶음 학점: 운영학점으로 보정한 저장값(creditFrom op, 예전 보정)은 읽지 못한 값(0)으로 본다.
function planReconvertGroupCredit(group) {
  return group?.creditFrom === "op" ? 0 : Number(group?.credit) || 0;
}

// 가장 긴 증가 부분 수열(행 이동을 최소로 찾는다). positions: 지금 순서의 각 과목이 업로드 때 몇 번째였는지.
function planReconvertStable(positions) {
  const tails = [], previous = new Array(positions.length).fill(-1), indexes = [];
  positions.forEach((value, index) => {
    let low = 0, high = tails.length;
    while (low < high) { const mid = (low + high) >> 1; if (positions[tails[mid]] < value) low = mid + 1; else high = mid; }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  });
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]) indexes.push(index);
  return new Set(indexes);
}

// 업로드 시점(base) → 지금(current) 사이에 교사가 고친 곳. base·current: { data, template }
function planReconvertEdits(base, current) {
  const edits = [];
  const before = new Map(base.data.subjects.map((item) => [item.id, item]));
  const now = new Map(current.data.subjects.map((item) => [item.id, item]));
  for (const [id, subject] of now) {
    const was = before.get(id);
    if (!was) continue;
    for (const field of PLAN_RECONVERT_FIELDS) {
      if (!planReconvertSame(was[field], subject[field])) edits.push({ type: "field", id, field, from: was[field], to: subject[field] });
    }
    for (const field of PLAN_RECONVERT_MAPS) {
      const keys = new Set([...Object.keys(was[field] || {}), ...Object.keys(subject[field] || {})]);
      for (const key of keys) {
        if (!planReconvertSame(was[field]?.[key], subject[field]?.[key])) edits.push({ type: "field", id, field, key, from: was[field]?.[key], to: subject[field]?.[key] });
      }
    }
  }
  const order = current.data.subjects.map((item) => item.id);
  const baseOrder = new Map(base.data.subjects.map((item, index) => [item.id, index]));
  const common = order.filter((id) => before.has(id));
  const stable = planReconvertStable(common.map((id) => baseOrder.get(id)));
  const moved = new Set(common.filter((_, index) => !stable.has(index)));
  order.forEach((id, index) => {
    const after = order[index - 1] ?? null;
    if (!before.has(id)) edits.push({ type: "add", id, after, subject: planDataClone(now.get(id)) });
    else if (moved.has(id)) edits.push({ type: "move", id, after });
  });
  for (const [id] of before) if (!now.has(id)) edits.push({ type: "remove", id });
  const groupsBefore = new Map((base.data.groups || []).map((group) => [group.id, group]));
  for (const group of current.data.groups || []) {
    const was = groupsBefore.get(group.id);
    if (!was) { edits.push({ type: "group-add", group: planDataClone(group) }); continue; }
    for (const field of ["fields", "pick", "credit", "members"]) {
      const from = field === "credit" ? planReconvertGroupCredit(was) : was[field];
      const to = field === "credit" ? planReconvertGroupCredit(group) : group[field];
      if (!planReconvertSame(from, to)) edits.push({ type: "group", id: group.id, field, from, to });
    }
  }
  const groupsNow = new Set((current.data.groups || []).map((group) => group.id));
  for (const [id, group] of groupsBefore) if (!groupsNow.has(id)) edits.push({ type: "group-remove", id, group: planDataClone(group) });
  for (const part of ["header", "footer"]) {
    const a = base.template?.[part]?.rows || [], b = current.template?.[part]?.rows || [];
    if (a.length !== b.length) { if (!planReconvertSame(a, b)) edits.push({ type: "template", part }); continue; }
    b.forEach((row, r) => (row || []).forEach((value, c) => {
      if (String(a[r]?.[c] ?? "") !== String(value ?? "")) edits.push({ type: "cell", part, r, c, from: a[r]?.[c] ?? "", to: value ?? "" });
    }));
  }
  return edits;
}

// 고친 곳 한 줄 설명(확인 창 목록)
function planReconvertEditText(edit, base, current) {
  const subject = (id) => current.data.subjects.find((item) => item.id === id) || base.data.subjects.find((item) => item.id === id);
  const group = (id) => (current.data.groups || []).find((item) => item.id === id) || (base.data.groups || []).find((item) => item.id === id);
  const groupLabel = (item) => item ? `${planDataFieldLabel(item.fields || [])} 택${item.pick}` : "선택과목군";
  if (edit.type === "field") {
    const key = edit.key ? /^sem\d\d$/.test(edit.key) ? ` ${edit.key[3]}-${edit.key[4]}` : ` ${edit.key}` : "";
    return `${planReconvertName(subject(edit.id))} · ${PLAN_RECONVERT_LABELS[edit.field] || edit.field}${key}: ${planReconvertValueText(edit.from)} → ${planReconvertValueText(edit.to)}`;
  }
  if (edit.type === "add") return `과목 추가: ${planReconvertName(edit.subject)}`;
  if (edit.type === "remove") return `과목 삭제: ${planReconvertName(subject(edit.id))}`;
  if (edit.type === "move") return `행 이동: ${planReconvertName(subject(edit.id))}`;
  if (edit.type === "group") return `선택과목군 ${groupLabel(group(edit.id))} · ${{ fields: "학기", pick: "택 수", credit: "학점", members: "구성 과목" }[edit.field]}: ${planReconvertValueText(edit.field === "members" ? (edit.from || []).map((id) => planReconvertName(subject(id))) : edit.from)} → ${planReconvertValueText(edit.field === "members" ? (edit.to || []).map((id) => planReconvertName(subject(id))) : edit.to)}`;
  if (edit.type === "group-add") return `선택과목군 묶기: ${groupLabel(edit.group)} (${edit.group.members.map((id) => planReconvertName(subject(id))).join(", ")})`;
  if (edit.type === "group-remove") return `선택과목군 풀기: ${groupLabel(edit.group)}`;
  if (edit.type === "cell") return `${edit.part === "header" ? "머리글" : "소계 아래"} 칸 ${typeof columnName === "function" ? columnName(edit.c) : edit.c}${edit.r + 1}: ${planReconvertValueText(edit.from)} → ${planReconvertValueText(edit.to)}`;
  return `${edit.part === "header" ? "머리글" : "소계 아래"} 행 구성 변경`;
}

// 새로 읽은 데이터(fresh)에 고친 곳(edits)을 다시 적용한다. 업로드 시점 값과 새 값이 다르면(변환기가 바꾼 곳을 교사도 고침) 충돌이다.
function planReconvertApply(base, fresh, edits) {
  const data = planDataClone(fresh.data), template = planDataClone(fresh.template);
  const applied = [], conflicts = [];
  const byKey = new Map();
  for (const item of data.subjects) {
    const key = planReconvertKey(item);
    byKey.set(key, byKey.has(key) ? null : item);
  }
  const idMap = new Map();
  for (const item of base.data.subjects) {
    const target = byKey.get(planReconvertKey(item));
    if (target) idMap.set(item.id, target.id);
  }
  const find = (id) => data.subjects.find((item) => item.id === idMap.get(id)) || null;
  const indexOf = (id) => data.subjects.findIndex((item) => item.id === idMap.get(id));
  const groupKey = (fields, members) => `${[...fields].sort().join(",")}|${[...members].sort().join(",")}`;
  const baseGroups = new Map((base.data.groups || []).map((group) => [group.id, group]));
  const findGroup = (group) => {
    if (!group) return null;
    const members = group.members.map((id) => idMap.get(id));
    if (members.some((id) => !id)) return null;
    return (data.groups || []).find((item) => groupKey(item.fields, item.members) === groupKey(group.fields, members)) || null;
  };
  // 묶음은 구성 과목·학기가 바뀌기 전에 찾아 둔다.
  const groupTargets = new Map([...baseGroups].map(([id, group]) => [id, findGroup(group)]));
  const done = (edit) => applied.push(edit);
  const conflict = (edit, reason) => conflicts.push({ ...edit, reason });
  for (const edit of edits.filter((item) => item.type === "cell" || item.type === "template")) {
    const part = template[edit.part];
    if (edit.type === "template") {
      if (planReconvertSame(part?.rows, base.template?.[edit.part]?.rows)) conflict(edit, "행 수가 바뀐 양식은 다시 적용하지 않습니다");
      else conflict(edit, "새 원본의 양식이 다릅니다");
      continue;
    }
    const value = part?.rows?.[edit.r]?.[edit.c];
    if (String(value ?? "") === String(edit.to ?? "")) done(edit);
    else if (String(value ?? "") === String(edit.from ?? "") && part?.rows?.[edit.r]) { part.rows[edit.r][edit.c] = edit.to; done(edit); }
    else conflict(edit, "새 원본의 같은 칸 값이 다릅니다");
  }
  for (const edit of edits.filter((item) => item.type === "field")) {
    const target = find(edit.id);
    if (!target) { conflict(edit, "새 원본에서 같은 과목 행을 찾지 못했습니다"); continue; }
    const value = edit.key !== undefined ? target[edit.field]?.[edit.key] : target[edit.field];
    if (planReconvertSame(value, edit.to)) { done(edit); continue; }
    if (!planReconvertSame(value, edit.from)) { conflict(edit, "새 원본으로 읽은 값이 업로드 때와 다릅니다"); continue; }
    if (edit.key !== undefined) {
      target[edit.field] ||= {};
      if (edit.to === undefined) delete target[edit.field][edit.key];
      else target[edit.field][edit.key] = planDataClone(edit.to);
    } else if (edit.to === undefined) delete target[edit.field];
    else target[edit.field] = planDataClone(edit.to);
    done(edit);
  }
  for (const edit of edits.filter((item) => item.type === "remove")) {
    const index = indexOf(edit.id);
    if (index < 0) { done(edit); continue; }
    const id = data.subjects[index].id;
    data.subjects.splice(index, 1);
    for (const group of data.groups || []) group.members = group.members.filter((member) => member !== id);
    data.groups = (data.groups || []).filter((group) => group.members.length);
    done(edit);
  }
  for (const edit of edits.filter((item) => item.type === "add" || item.type === "move")) {
    let item, home = -1;
    if (edit.type === "add") {
      item = planDataClone(edit.subject);
      if (data.subjects.some((other) => other.id === item.id) || (data.groups || []).some((group) => group.id === item.id)) item.id = planDataNewId(data, item.fixed ? "f" : "s");
    } else {
      home = indexOf(edit.id);
      if (home < 0) { conflict(edit, "새 원본에서 옮긴 과목 행을 찾지 못했습니다"); continue; }
      [item] = data.subjects.splice(home, 1);
    }
    let at = 0;
    if (edit.after !== null) {
      const previousId = idMap.get(edit.after);
      const previous = previousId ? data.subjects.findIndex((other) => other.id === previousId) : -1;
      if (previous < 0) {
        if (home >= 0) data.subjects.splice(home, 0, item);
        conflict(edit, "새 원본에서 앞 과목 행을 찾지 못했습니다");
        continue;
      }
      at = previous + 1;
    }
    data.subjects.splice(at, 0, item);
    if (edit.type === "add") idMap.set(edit.id, item.id);
    done(edit);
  }
  const mapMembers = (members) => {
    const ids = (members || []).map((id) => idMap.get(id));
    return ids.some((id) => !id) ? null : ids;
  };
  const added = [];
  for (const edit of edits.filter((item) => item.type.startsWith("group"))) {
    if (edit.type === "group-add") {
      const members = mapMembers(edit.group.members);
      if (!members) { conflict(edit, "묶음 과목을 새 원본에서 찾지 못했습니다"); continue; }
      const group = { ...planDataClone(edit.group), id: planDataNewId(data, "g"), members };
      data.groups.push(group);
      added.push({ edit, group });
      continue;
    }
    const target = groupTargets.get(edit.id);
    if (edit.type === "group-remove") {
      if (target) data.groups = data.groups.filter((group) => group !== target);
      done(edit);
      continue;
    }
    if (!target) { conflict(edit, "새 원본에서 같은 선택과목군을 찾지 못했습니다"); continue; }
    if (edit.field === "members") {
      const from = mapMembers(edit.from), to = mapMembers(edit.to);
      if (!to) { conflict(edit, "묶음 과목을 새 원본에서 찾지 못했습니다"); continue; }
      if (planReconvertSame(target.members, to)) { done(edit); continue; }
      if (!from || !planReconvertSame(target.members, from)) { conflict(edit, "새 원본의 묶음 구성이 다릅니다"); continue; }
      target.members = to;
      done(edit);
      continue;
    }
    const value = edit.field === "credit" ? planReconvertGroupCredit(target) : target[edit.field];
    if (planReconvertSame(value, edit.to)) { done(edit); continue; }
    if (!planReconvertSame(value, edit.from)) { conflict(edit, "새 원본으로 읽은 값이 업로드 때와 다릅니다"); continue; }
    target[edit.field] = planDataClone(edit.to);
    if (edit.field === "credit") { delete target.creditFrom; delete target.creditNote; }
    done(edit);
  }
  normalizeCurriculumData(data);
  for (const { edit, group } of added) {
    if ((data.groups || []).some((item) => item.id === group.id)) done(edit);
    else conflict(edit, "다른 묶음과 학기 칸이 겹칩니다");
  }
  return { data, template, applied, conflicts };
}

// 새 원본과 지금 데이터의 차이(업로드 시점 데이터가 없을 때 확인 창에 보여 준다). 같은 원본 행끼리 맞춰 비교한다.
function planReconvertDifferences(current, fresh) {
  const byKey = new Map();
  for (const item of fresh.data.subjects) byKey.set(planReconvertKey(item), byKey.has(planReconvertKey(item)) ? null : item);
  const idMap = new Map();
  const remapped = planDataClone(current.data);
  const used = new Set();
  for (const item of remapped.subjects) {
    const target = byKey.get(planReconvertKey(item));
    const id = target && !used.has(target.id) ? target.id : `x${item.id}`;
    used.add(id);
    idMap.set(item.id, id);
    item.id = id;
  }
  const groupKey = (group) => `${[...group.fields].sort().join(",")}|${[...group.members].sort().join(",")}`;
  const freshGroups = new Map((fresh.data.groups || []).map((group) => [groupKey(group), group.id]));
  for (const group of remapped.groups || []) {
    group.members = group.members.map((id) => idMap.get(id) || id);
    group.id = freshGroups.get(groupKey(group)) || `x${group.id}`;
  }
  // 지금 값 → 원본 값(갱신하면 바뀌는 방향)
  const now = { data: remapped, template: current.template };
  return planReconvertEdits(now, fresh).map((edit) => ({ ...edit, text: planReconvertEditText(edit, now, fresh) }));
}

// 업로드 시점(또는 지금) 데이터 → 새로 읽은 데이터에서 바뀐 것 요약(상태 줄 안내)
function planReconvertSummary(base, fresh) {
  const byKey = new Map(base.data.subjects.map((item) => [planReconvertKey(item), item]));
  let cross = 0, names = 0, other = 0;
  for (const item of fresh.data.subjects) {
    const was = byKey.get(planReconvertKey(item));
    if (item.cross?.length && !was?.cross?.length) cross++;
    if (item.originalName !== undefined && (!was || was.name !== item.name)) names++;
    else if (was && !item.cross?.length && PLAN_RECONVERT_FIELDS.some((field) => field !== "originalName" && !planReconvertSame(was[field], item[field]))) other++;
  }
  const baseGroups = new Map((base.data.groups || []).map((group) => [`${group.fields.join(",")}|${planDataNamesKey(base.data, group.members)}`, group]));
  let credits = 0;
  for (const group of fresh.data.groups || []) {
    const was = baseGroups.get(`${group.fields.join(",")}|${planDataNamesKey(fresh.data, group.members)}`);
    if (was && planReconvertGroupCredit(was) !== (Number(group.credit) || 0)) credits++;
  }
  return { cross, credits, names, other };
}

function planDataNamesKey(data, ids) {
  const byId = new Map(data.subjects.map((item) => [item.id, item]));
  return ids.flatMap((id) => planDataSubjectNames(byId.get(id)?.name).map(planDataNameKey)).sort().join(",");
}

function planReconvertSummaryText(summary) {
  const parts = [];
  if (summary.cross) parts.push(`교차집중 ${summary.cross}곳`);
  if (summary.credits) parts.push(`묶음 학점 ${summary.credits}곳`);
  if (summary.other) parts.push(`그 밖의 칸 ${summary.other}곳`);
  const text = parts.length ? `${parts.join(", ")} 갱신` : "바뀐 곳 없음";
  return summary.names ? `${text} · 공식 과목명 ${summary.names}곳 자동 수정` : text;
}

// ---- 앱 연결

// 업로드 시점 데이터를 원본과 함께 보관한다(다음 변환기 갱신 때 업로드 뒤 고친 곳을 가려낸다).
async function storeCurriculumOrigin(layout) {
  if (!layout?.archiveId || !layout.planData || typeof curriculumArchiveStore !== "function") return;
  await curriculumArchiveStore("put", `origin:${layout.archiveId}`, {
    converter: layout.planData.converter || 0, savedAt: new Date().toISOString(),
    data: planDataClone(layout.planData), template: planDataClone(layout.planTemplate)
  });
}

// 업로드 시점 데이터: IndexedDB 'origin:' 기록 → 같은 원본으로 저장한 첫 이력(편제표 업로드).
async function curriculumReconvertBaseline(year, layout) {
  try {
    const origin = layout.archiveId ? await curriculumArchiveStore("get", `origin:${layout.archiveId}`) : null;
    if (origin?.data?.subjects && origin.template) return { data: origin.data, template: origin.template, source: "origin" };
  } catch { /* 이력에서 찾는다 */ }
  const versions = (typeof state !== "undefined" && state.curriculumVersions?.[String(year)]) || [];
  const version = versions.find((item) => item.snapshot?.layout?.archiveId && item.snapshot.layout.archiveId === layout.archiveId);
  const snapshot = version?.snapshot?.layout;
  if (!snapshot) return null;
  if (snapshot.planData?.subjects && snapshot.planTemplate) return { data: planDataClone(snapshot.planData), template: planDataClone(snapshot.planTemplate), source: "version" };
  // 표 기반 이력(데이터 이전 자료)은 지금 변환 규칙으로 데이터로 바꿔 비교한다(지금 데이터도 같은 규칙으로 바꾼 것이다).
  const converted = typeof curriculumLayoutData === "function" ? curriculumLayoutData(snapshot) : null;
  return converted?.planData ? { data: planDataClone(converted.planData), template: planDataClone(converted.planTemplate), source: "version" } : null;
}

// 원본 엑셀을 새 변환기로 다시 읽는다(업로드와 같은 단계: 시트 자르기 → 데이터 변환 → 공식 과목명 자동 수정).
async function curriculumReconvertFresh(layout, year) {
  if (!layout?.archiveId || typeof curriculumArchiveStore !== "function" || typeof parseWorkbook !== "function") return null;
  const buffer = await curriculumArchiveStore("get", layout.archiveId);
  if (!buffer) return null;
  const sheets = await parseWorkbook(buffer, { expandMergedCells: true, includeLayout: true });
  const sheet = sheets.find((item) => item.layout?.sheetPath && item.layout.sheetPath === layout.sheetPath) ||
    sheets.find((item) => item.name === layout.sheetName);
  if (!sheet) throw new Error("원본 편제표 시트를 찾지 못했습니다.");
  const cropped = cropCurriculumSheet(sheet);
  const { data, template } = curriculumDataFromLayout(cropped);
  const fresh = applyCurriculumData({ ...cropped, ...(layout.autoNameOff ? { autoNameOff: true } : {}) }, data, template);
  if (typeof curriculumApplyAutoNames === "function") curriculumApplyAutoNames(fresh, year);
  return { data: fresh.planData, template: fresh.planTemplate };
}

function curriculumReconvertTargets(years = null) {
  if (typeof state === "undefined") return [];
  const targets = [];
  const seen = new Set();
  const add = (year, layout, active) => {
    if (!layout?.planData || layout.derived || seen.has(layout) || !/^\d{4}$/.test(String(year))) return;
    if (years && !years.includes(String(year))) return;
    seen.add(layout);
    targets.push({ year: String(year), layout, active });
  };
  if (state.curriculumPlanType !== "annual") add(state.curriculumCohortYear, state.curriculumImportedLayout, true);
  for (const [year, item] of Object.entries(state.curriculumCohorts || {})) add(year, item?.importedLayout, false);
  return targets;
}

function curriculumReconvertNeeded(layout) {
  return Boolean(layout?.planData) && !layout.derived && (Number(layout.planData.converter) || 0) < PLAN_DATA_CONVERTER;
}

// 지금 state에서 그 입학생 편제표가 아직 같은 자료인지(다시 읽는 동안 교사가 바꾸지 않았는지)
function curriculumReconvertStillCurrent(target) {
  if (target.active) return state.curriculumPlanType !== "annual" && String(state.curriculumCohortYear) === target.year && state.curriculumImportedLayout === target.layout;
  return state.curriculumCohorts?.[target.year]?.importedLayout === target.layout &&
    !(state.curriculumPlanType !== "annual" && String(state.curriculumCohortYear) === target.year && state.curriculumImportedLayout !== target.layout);
}

function curriculumReconvertCommit(target, data, template, basis) {
  const next = planDataClone({ ...target.layout, changeBaseline: undefined, changeBaselineError: undefined });
  delete next.reconvertPending;
  delete next.reconvertNotice;
  delete next.planDataError;
  applyCurriculumData(next, data, template);
  if (target.active) {
    state.curriculumImportedLayout = next;
    state.curriculumPlan = curriculumPlanFromLayout(next, `${state.curriculumPlanFileName} ${next.sheetName || ""}`, state.curriculumPlan);
    state.curriculumTemplateRows = state.curriculumPlan.map((row) => normalizeCurriculumPlanRow(row));
    state.curriculumUndoStack = [];
    state.curriculumMutationRevision = (Number(state.curriculumMutationRevision) || 0) + 1;
    if (typeof syncActiveCurriculumCohort === "function") syncActiveCurriculumCohort();
  } else {
    const item = state.curriculumCohorts[target.year];
    item.importedLayout = next;
    item.plan = curriculumPlanFromLayout(next, item.fileName, item.plan);
    item.templateRows = item.plan.map((row) => normalizeCurriculumPlanRow(row));
  }
  if (typeof recordCurriculumVersion === "function") {
    const fileName = target.active ? state.curriculumPlanFileName : state.curriculumCohorts?.[target.year]?.fileName;
    recordCurriculumVersion(target.year, next, { reason: "원본 다시 읽기(변환기 갱신)", basis, fileName, auto: true });
  }
  return next;
}

let curriculumReconvertRunning = null;

function curriculumReconvertDialog() {
  let dialog = document.getElementById("curriculumReconvertDialog");
  if (dialog) return dialog;
  document.body.insertAdjacentHTML("beforeend", `<dialog class="curriculum-subject-dialog curriculum-reconvert-dialog" id="curriculumReconvertDialog" aria-labelledby="curriculumReconvertTitle">
    <form method="dialog">
      <h2 id="curriculumReconvertTitle">원본 기준으로 다시 읽기</h2>
      <p class="note" id="curriculumReconvertText"></p>
      <div class="curriculum-reconvert-list" id="curriculumReconvertList"></div>
      <div class="curriculum-subject-actions">
        <button class="button" type="submit" value="keep" id="curriculumReconvertKeep">그대로 두기</button>
        <button class="button button-primary" type="submit" value="update" id="curriculumReconvertUpdate">원본 기준으로 갱신</button>
      </div>
    </form>
  </dialog>`);
  return document.getElementById("curriculumReconvertDialog");
}

function curriculumReconvertAsk({ label, lost, kept, unknown }) {
  if (typeof document === "undefined" || !document.body) return Promise.resolve(false);
  const dialog = curriculumReconvertDialog();
  const escape = typeof escapeHtml === "function" ? escapeHtml : (value) => String(value ?? "");
  document.getElementById("curriculumReconvertTitle").textContent = `원본 기준으로 다시 읽기 · ${label}`;
  document.getElementById("curriculumReconvertText").textContent = unknown
    ? `업로드 때 기록이 없어 업로드 뒤 고친 곳을 가려낼 수 없습니다. 원본 기준으로 갱신하면 지금 편제표와 다른 ${lost.length}곳이 원본 값으로 바뀝니다. 갱신할까요?`
    : `원본 기준으로 갱신하면 업로드 뒤 고친 ${lost.length}곳이 사라집니다. 갱신할까요?${kept.length ? ` (다시 적용할 수 있는 ${kept.length}곳은 그대로 다시 적용합니다)` : ""}`;
  const list = (items, title) => items.length ? `<h3>${escape(title)}</h3><ul>${items.slice(0, 40).map((item) => `<li>${escape(item)}</li>`).join("")}${items.length > 40 ? `<li>외 ${items.length - 40}곳</li>` : ""}</ul>` : "";
  document.getElementById("curriculumReconvertList").innerHTML = list(lost, unknown ? "지금 편제표와 원본이 다른 곳" : "사라지는 곳(충돌)") + list(kept, "다시 적용하는 곳");
  dialog.returnValue = "";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "update"), { once: true });
    dialog.showModal();
  });
}

// 편제표 하나를 다시 읽는다. 돌려주는 값: { status: done|declined|no-original|skipped, text }
async function reconvertCurriculumLayout(target, { ask = true } = {}) {
  const label = `${target.year}학년도 입학생 편제표`;
  const current = { data: target.layout.planData, template: target.layout.planTemplate };
  let fresh = null;
  try { fresh = await curriculumReconvertFresh(target.layout, target.year); } catch (error) {
    return { status: "skipped", text: `${label}: 원본을 다시 읽지 못했습니다(${error?.message || error}).` };
  }
  if (!fresh) {
    if (curriculumReconvertStillCurrent(target)) target.layout.reconvertNotice = PLAN_DATA_CONVERTER;
    return { status: "no-original", text: `${label}는 보관된 원본 파일이 없어 그대로 둡니다. 원본 파일을 다시 올리면 정확히 갱신됩니다.` };
  }
  const base = await curriculumReconvertBaseline(target.year, target.layout);
  let data = fresh.data, template = fresh.template, kept = [], lost = [], unknown = false;
  if (base) {
    const edits = planReconvertEdits(base, current);
    if (edits.length) {
      const result = planReconvertApply(base, fresh, edits);
      data = result.data; template = result.template;
      kept = result.applied.map((edit) => planReconvertEditText(edit, base, current));
      lost = result.conflicts.map((edit) => `${planReconvertEditText(edit, base, current)} — ${edit.reason}`);
    }
  } else {
    unknown = true;
    lost = planReconvertDifferences(current, fresh).map((edit) => edit.text);
  }
  if (!curriculumReconvertStillCurrent(target)) return { status: "skipped", text: "" };
  if (lost.length) {
    const accepted = ask ? await curriculumReconvertAsk({ label, lost, kept, unknown }) : false;
    if (!curriculumReconvertStillCurrent(target)) return { status: "skipped", text: "" };
    if (!accepted) {
      target.layout.reconvertPending = PLAN_DATA_CONVERTER;
      return { status: "declined", text: `${label}는 그대로 두었습니다. 카드의 '원본으로 갱신'으로 언제든 다시 읽을 수 있습니다.` };
    }
    if (unknown) { data = fresh.data; template = fresh.template; }
  }
  const summary = planReconvertSummaryText(planReconvertSummary(base || current, { data, template }));
  const replay = kept.length && !unknown ? ` · 업로드 뒤 고친 ${kept.length}곳 다시 적용` : "";
  const dropped = lost.length ? ` · 고친 곳 ${lost.length}곳은 원본 값으로` : "";
  curriculumReconvertCommit(target, data, template, `${summary}${replay}${dropped}`);
  try { await storeCurriculumOrigin({ archiveId: target.layout.archiveId, planData: fresh.data, planTemplate: fresh.template }); } catch { /* 다음 갱신 때 이력에서 찾는다 */ }
  return { status: "done", text: `${label}를 원본으로 다시 읽었습니다(${summary}${replay}${dropped})` };
}

// 예전 변환기로 만든 편제표를 모두 다시 읽는다. startup: 열 때 자동(거절한 편제표는 묻지 않음), years: 카드 단추로 고른 입학연도.
async function reconvertCurriculumOriginals({ startup = false, years = null } = {}) {
  if (typeof state === "undefined" || typeof PLAN_DATA_CONVERTER === "undefined") return [];
  if (curriculumReconvertRunning) return curriculumReconvertRunning;
  if (typeof isWorkspaceStorageProtected === "function" && isWorkspaceStorageProtected()) return [];
  curriculumReconvertRunning = (async () => {
    const results = [];
    for (const target of curriculumReconvertTargets(years)) {
      if (!curriculumReconvertNeeded(target.layout)) continue;
      if (startup && (target.layout.reconvertPending === PLAN_DATA_CONVERTER || target.layout.reconvertNotice === PLAN_DATA_CONVERTER)) continue;
      results.push(await reconvertCurriculumLayout(target));
    }
    const changed = results.some((result) => result.status === "done");
    // 전학년 편제표는 원본 대신 세 입학생 편제표에서 다시 만든다.
    const schoolYear = typeof document !== "undefined" ? String(document.getElementById("schoolYear")?.value || "") : "";
    const annual = state.curriculumAnnualPlans?.[schoolYear]?.importedLayout;
    if (annual?.derived && (changed || curriculumReconvertNeeded({ ...annual, derived: false })) && typeof buildAnnualPlan === "function") {
      const statusText = typeof status !== "undefined" ? status.textContent : "";
      if (buildAnnualPlan(schoolYear)) {
        results.push({ status: "done", text: `${schoolYear}학년도 전학년 편제표를 세 입학생 편제표에서 다시 만들었습니다` });
        if (state.curriculumPlanType === "annual" && String(state.curriculumCohortYear) === schoolYear && typeof loadCurriculumPlanData === "function") loadCurriculumPlanData("annual", schoolYear);
      } else if (typeof status !== "undefined") status.textContent = statusText;
    }
    if (!results.some((result) => result.status !== "skipped")) return results;
    if (typeof persistState === "function") persistState();
    if (Number(state.workflowStep) === 1 && typeof renderCurriculumStep === "function") renderCurriculumStep();
    else if (typeof renderCurriculumCohortUploads === "function") renderCurriculumCohortUploads();
    if (typeof planComplianceChanged === "function") planComplianceChanged();
    const texts = results.map((result) => result.text).filter(Boolean);
    if (texts.length && typeof status !== "undefined") {
      status.style.color = results.some((result) => result.status === "done") ? "#287956" : "#596780";
      status.textContent = texts.join(" / ");
    }
    return results;
  })();
  try { return await curriculumReconvertRunning; } finally { curriculumReconvertRunning = null; }
}

// 1단계 카드 배지: 거절해 둔 편제표('원본 갱신 필요' + 단추), 원본이 없는 편제표('원본 다시 올리기 권장')
function curriculumReconvertCardHtml(year, layout) {
  if (!layout?.planData || layout.derived || !curriculumReconvertNeeded(layout)) return "";
  if (layout.reconvertPending === PLAN_DATA_CONVERTER) {
    return `<button class="button curriculum-reconvert-button" type="button" data-reconvert-cohort="${year}" title="원본 갱신 필요: 예전 변환기로 만든 편제표입니다. 누르면 원본을 새 변환기로 다시 읽습니다(교차집중·묶음 학점·과목명). 업로드 뒤 고친 곳은 확인 창에서 보여 줍니다." aria-label="${year}학년도 입학생 편제표 원본 갱신 필요 · 원본으로 갱신">원본 갱신 필요</button>`;
  }
  if (layout.reconvertNotice === PLAN_DATA_CONVERTER) {
    return '<span class="curriculum-reconvert-note" title="보관된 원본 파일이 없어 예전 변환 그대로입니다. 원본 파일을 다시 올리면 정확히 갱신됩니다.">원본 다시 올리기 권장</span>';
  }
  return "";
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-reconvert-cohort]");
    if (!button) return;
    reconvertCurriculumOriginals({ years: [button.dataset.reconvertCohort] }).catch((error) => {
      if (typeof status !== "undefined") { status.style.color = "#a44939"; status.textContent = error?.message || String(error); }
    });
  });
}
