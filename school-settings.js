// 학교 설정: 학교마다 다른 기준값(개설 기준·정원·교사 증원 기준·점심·창체 등)을 한 화면에서 보고 고치고,
// 파일로 내보내기/가져오기(학생·교사 이름 없음). 각 값은 원래 저장 위치에 그대로 두고 여기서는 모아 보여 준다.
// 위쪽은 순수 계산(DOM·state 없음), '// ---- 앱 연결' 아래가 화면 연결. timetable-view.js 뒤에 로드한다. 계획: docs/multi-school.md

var SCHOOL_SETTINGS_FILE_TYPE = "curriculum-school-settings";
var SCHOOL_SETTINGS_FILE_VERSION = 1;

// key = 묶음.경로, def = 앱 기본값, legacy = 예전부터 쓰던 자료(값을 따로 정한 적 없음)에 적용되는 기본값이 def와 다를 때.
var SCHOOL_SETTINGS_ITEMS = [
  { key: "aggregate.openingPercent", group: "4단계 집계·개설", label: "개설 기준 (학급당 학생 수의 %)", def: 90, min: 1, max: 200, where: "4단계 '집계 기준 설정'" },
  { key: "aggregate.divisionPercent", group: "4단계 집계·개설", label: "분반 기준 (학급당 학생 수의 %)", def: 110, min: 1, max: 300, where: "4단계 '집계 기준 설정'" },
  { key: "aggregate.maxClassSize", group: "4단계 집계·개설", label: "반별 최대 인원 (명)", def: 34, min: 1, max: 99, where: "4단계 '집계 기준 설정'" },
  { key: "hours.maxTeacherHours", group: "5단계 시수 통계", label: "교사 증원 기준 (1인당 한 학기 시수가 이 값을 넘으면)", def: 19, min: 1, max: 40, where: "5단계 '교사 수 추천'" },
  { key: "hours.roamingTeacherHours", group: "5단계 시수 통계", label: "순회교사 기준 (증원하면 1인당 시수가 이 값 이하일 때)", def: 13, min: 0, max: 40, where: "5단계 '교사 수 추천'" },
  { key: "hours.creative.자율", group: "5단계 시수 통계", label: "창체 자율 (학급당 주당 시간)", def: 1, min: 0, max: 10, where: "5단계 시수표 창체 행" },
  { key: "hours.creative.진로", group: "5단계 시수 통계", label: "창체 진로 (학급당 주당 시간)", def: 1, min: 0, max: 10, where: "5단계 시수표 창체 행" },
  { key: "timetable.lunchAfter.1", group: "7단계 시간표", label: "1학년 점심 (몇 교시 뒤)", def: 4, min: 1, max: 11, where: "7단계 조건 설정 '시간'" },
  { key: "timetable.lunchAfter.2", group: "7단계 시간표", label: "2학년 점심 (몇 교시 뒤)", def: 4, min: 1, max: 11, where: "7단계 조건 설정 '시간'" },
  { key: "timetable.lunchAfter.3", group: "7단계 시간표", label: "3학년 점심 (몇 교시 뒤)", def: 4, legacy: 3, min: 1, max: 11, where: "7단계 조건 설정 '시간'" },
  { key: "timetable.rules.maxHours", group: "7단계 시간표", label: "교사 주당 시수 참고 상한", def: 22, min: 1, max: 40, where: "7단계 조건 설정 '규칙'" },
  { key: "timetable.rules.departmentMax.진로", group: "7단계 시간표", label: "진로 교사 주당 시수 상한", def: 10, min: 1, max: 40, where: "7단계 조건 설정 '규칙'" },
  { key: "timetable.creativeFrom", group: "7단계 시간표", label: "시간을 정하지 않은 창체는 몇 교시부터", def: 5, min: 1, max: 12, where: "7단계 조건 설정 '시간'" },
];
// 파일에 통째로 싣는 시간표 조건(숫자 칸 밖의 것). 고정 칸·교사 고정·반 배정·선택 내역·담임처럼 그 해 자료에 묶인 것은 싣지 않는다.
var SCHOOL_SETTINGS_TIMETABLE_KEYS = ["periodsByDay", "creative", "venues", "openDepartments", "doubleSubjects", "rules", "keepBlockTimes"];

function schoolSettingsPath(object, path) {
  let value = object;
  for (const part of path) {
    if (!value || typeof value !== "object") return undefined;
    value = value[part];
  }
  return value;
}

function schoolSettingsNumber(value, item) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= item.min && number <= item.max ? number : null;
}

// 지금 쓰이는 값. sources = { aggregate: { openingPercent… }, hours: 시수 설정, hoursCreative: { 자율, 진로 }, timetable: 시간표 조건 }
// 돌려주는 값: { [key]: { value, explicit(직접 정한 값인지), def } }
function schoolSettingsEffective(sources = {}) {
  const result = {};
  for (const item of SCHOOL_SETTINGS_ITEMS) {
    const [group, ...path] = item.key.split(".");
    let stored = group === "hours" && path[0] === "creative"
      ? schoolSettingsPath(sources.hoursCreative, path.slice(1))
      : schoolSettingsPath(sources[group], path);
    stored = schoolSettingsNumber(stored, item);
    // 창체는 예전 자료(시수 하나)를 앱이 나눠 준 값이므로 설정에 직접 있는지로 '직접 정함'을 본다.
    const explicit = group === "hours" && path[0] === "creative"
      ? schoolSettingsNumber(schoolSettingsPath(sources.hours, path), item) !== null
      : stored !== null;
    const fallback = item.legacy ?? item.def;
    result[item.key] = { value: stored ?? fallback, explicit, def: item.def };
  }
  return result;
}

function schoolSettingsPlain(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// 내보낼 파일 내용. 학생·교사 이름, 명렬, 결과는 넣지 않는다.
function schoolSettingsExport(sources = {}, meta = {}) {
  const effective = schoolSettingsEffective(sources);
  const timetable = {};
  for (const key of SCHOOL_SETTINGS_TIMETABLE_KEYS) {
    const value = sources.timetable?.[key];
    if (value !== undefined && value !== null) timetable[key] = JSON.parse(JSON.stringify(value));
  }
  return {
    type: SCHOOL_SETTINGS_FILE_TYPE, version: SCHOOL_SETTINGS_FILE_VERSION,
    exportedAt: meta.exportedAt || "", appVersion: meta.appVersion || "", schoolName: String(meta.schoolName || ""),
    values: Object.fromEntries(Object.entries(effective).map(([key, entry]) => [key, entry.value])),
    compliance: schoolSettingsPlain(sources.compliance) ? JSON.parse(JSON.stringify(sources.compliance)) : null,
    timetable,
  };
}

// 파일 읽기(글자 → 검증한 내용). 모르는 항목은 버리고, 범위 밖 숫자는 오류로 알린다.
function schoolSettingsParse(text) {
  let file = null;
  try { file = JSON.parse(String(text || "")); } catch { throw new Error("학교 설정 파일(JSON)이 아닙니다."); }
  if (!schoolSettingsPlain(file) || file.type !== SCHOOL_SETTINGS_FILE_TYPE) {
    throw new Error(file?.type === "curriculum-workspace-backup"
      ? "이 파일은 작업 자료 백업입니다. '자료 관리 → 백업 파일 불러오기'로 여세요."
      : "학교 설정 파일이 아닙니다. '학교 설정 → 파일로 내보내기'로 만든 파일을 고르세요.");
  }
  if (!(Number(file.version) >= 1) || Number(file.version) > SCHOOL_SETTINGS_FILE_VERSION) {
    throw new Error("더 새 버전의 앱에서 만든 학교 설정 파일입니다. 앱을 새로 고친 뒤 다시 불러오세요.");
  }
  const values = {};
  const invalid = [];
  for (const item of SCHOOL_SETTINGS_ITEMS) {
    if (!schoolSettingsPlain(file.values) || !(item.key in file.values)) continue;
    const number = schoolSettingsNumber(file.values[item.key], item);
    if (number === null) invalid.push(`${item.label}: ${file.values[item.key]}`);
    else values[item.key] = number;
  }
  if (invalid.length) throw new Error(`학교 설정 파일에 쓸 수 없는 값이 있습니다 — ${invalid.join(", ")}`);
  const timetable = {};
  for (const key of SCHOOL_SETTINGS_TIMETABLE_KEYS) {
    if (schoolSettingsPlain(file.timetable) && file.timetable[key] !== undefined && file.timetable[key] !== null) timetable[key] = file.timetable[key];
  }
  return { schoolName: String(file.schoolName || ""), exportedAt: String(file.exportedAt || ""), values,
    compliance: schoolSettingsPlain(file.compliance) ? file.compliance : null, timetable };
}

// 가져오면 바뀌는 것 목록(확인 창용). parsed = schoolSettingsParse 결과, sources = 지금 값.
function schoolSettingsImportChanges(parsed, sources = {}) {
  const effective = schoolSettingsEffective(sources);
  const changes = [];
  for (const item of SCHOOL_SETTINGS_ITEMS) {
    if (!(item.key in parsed.values)) continue;
    const from = effective[item.key].value;
    const to = parsed.values[item.key];
    if (from !== to) changes.push({ key: item.key, label: item.label, from, to });
  }
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (parsed.compliance && !same(parsed.compliance, sources.compliance)) changes.push({ key: "compliance", label: "편제 점검 기준값(교과(군) 필수 학점·총 이수 학점 등)", from: "지금 값", to: "파일 값" });
  const timetableKeys = Object.keys(parsed.timetable || {}).filter((key) => !same(parsed.timetable[key], sources.timetable?.[key]));
  if (timetableKeys.length) changes.push({ key: "timetable", label: "시간표 조건(요일별 교시·창체·규칙·장소)", from: "지금 값", to: "파일 값", keys: timetableKeys });
  return changes;
}

// 숫자 한 칸을 시간표 조건 객체에 넣은 새 객체(원래 객체는 바꾸지 않는다). path 예: ["rules", "departmentMax", "진로"]
function schoolSettingsWithPath(object, path, value) {
  const next = { ...(schoolSettingsPlain(object) ? object : {}) };
  if (path.length === 1) { next[path[0]] = value; return next; }
  next[path[0]] = schoolSettingsWithPath(next[path[0]], path.slice(1), value);
  return next;
}

// 처음 쓰는 학교(저장된 자료가 없는 브라우저)의 시간표 조건: 점심은 모든 학년 4교시 뒤(예전 기본값은 3학년만 3교시 뒤).
function schoolSettingsNeutralTimetable() {
  return { lunchAfter: { 1: 4, 2: 4, 3: 4 } };
}

// ---- 앱 연결 ----

if (typeof document !== "undefined" && typeof window !== "undefined") {
  const esc = (value) => typeof escapeHtml === "function" ? escapeHtml(value) : String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const byId = (id) => document.getElementById(id);

  function sources() {
    const stored = (selector) => typeof aggregateThresholdStoredValue === "function" ? aggregateThresholdStoredValue(selector) : byId(selector.slice(1))?.value;
    const hours = typeof hoursSettings === "function" ? hoursSettings() : {};
    return {
      aggregate: { openingPercent: stored("#openingPercent"), divisionPercent: stored("#divisionPercent"), maxClassSize: byId("maxClassSize")?.value },
      hours, hoursCreative: typeof hoursCreativeParts === "function" ? hoursCreativeParts(hours) : null,
      timetable: typeof timetableSettings === "function" ? timetableSettings() : {},
      compliance: state.curriculumCompliance?.settings || null,
    };
  }

  function timetableStore() {
    if (!state.timetable || typeof state.timetable !== "object") state.timetable = {};
    return state.timetable;
  }

  // 값 하나를 원래 저장 위치에 넣는다. 못 넣으면 이유(글자)를 돌려준다.
  function applyValue(key, value) {
    const [group, ...path] = key.split(".");
    if (group === "aggregate") {
      if (typeof isRoundLocked === "function" && isRoundLocked(state.currentRound)) return `${state.currentRound}차가 확정되어 집계 기준을 바꿀 수 없습니다. 4단계에서 확정을 해제한 뒤 바꾸세요.`;
      const input = byId(path[0]);
      if (!input) return "집계 기준 칸을 찾지 못했습니다.";
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return "";
    }
    if (group === "hours") {
      if (typeof hoursSettings !== "function" || typeof hoursTargetYear !== "function" || !/^\d{4}$/.test(hoursTargetYear())) return "학교 학년도를 먼저 확인하세요.";
      const settings = hoursSettings(hoursTargetYear(), true);
      if (path[0] === "creative") settings.creative = { ...(typeof hoursCreativeParts === "function" ? hoursCreativeParts(settings) : {}), [path[1]]: value };
      else settings[path[0]] = value;
      return "";
    }
    if (group === "timetable") {
      const store = timetableStore();
      let settings = store.settings && typeof store.settings === "object" ? store.settings : {};
      // 점심은 세 학년 값을 함께 둔다(한 학년만 넣으면 나머지가 예전 기본값으로 읽히지 않게 지금 값을 채움).
      if (path[0] === "lunchAfter") {
        const now = schoolSettingsEffective(sources());
        settings = { ...settings, lunchAfter: { 1: now["timetable.lunchAfter.1"].value, 2: now["timetable.lunchAfter.2"].value, 3: now["timetable.lunchAfter.3"].value, [path[1]]: value } };
      } else settings = schoolSettingsWithPath(settings, path, value);
      store.settings = settings;
      return "";
    }
    return "알 수 없는 항목입니다.";
  }

  function afterChange() {
    if (typeof persistStateSoon === "function") persistStateSoon();
    if (typeof renderHoursStats === "function") renderHoursStats();
    if (typeof renderTimetable === "function") renderTimetable();
  }

  function dialog() {
    let box = byId("schoolSettingsDialog");
    if (box) return box;
    box = document.createElement("dialog");
    box.id = "schoolSettingsDialog";
    box.className = "curriculum-subject-dialog school-settings-dialog";
    box.setAttribute("aria-labelledby", "schoolSettingsTitle");
    box.innerHTML = `<form method="dialog">
      <h2 id="schoolSettingsTitle">학교 설정 (기준값 한눈에 보기)</h2>
      <p class="note">학교마다 다를 수 있는 기준값입니다. 처음 값은 이 앱을 만든 학교의 값이니 우리 학교에 맞는지 확인하세요. 여기서 고치면 각 단계의 설정에 바로 들어갑니다(같은 값). 학급 수·교사 수·교사 명단처럼 해마다 바뀌는 자료는 각 단계에서 넣습니다.</p>
      <div id="schoolSettingsBody"></div>
      <p class="note" id="schoolSettingsMessage" role="status" aria-live="polite"></p>
      <div class="curriculum-version-dialog-actions">
        <button class="button" type="button" id="schoolSettingsExport" title="기준값만 파일로 저장합니다. 학생·교사 이름, 명렬, 결과는 들어가지 않습니다.">파일로 내보내기</button>
        <label class="file-button" for="schoolSettingsImport">파일에서 가져오기<input class="visually-hidden-file" id="schoolSettingsImport" type="file" accept=".json,application/json"></label>
        <button class="button button-primary" type="submit" value="close">닫기</button>
      </div>
    </form>`;
    document.body.append(box);
    box.querySelector("#schoolSettingsBody").addEventListener("change", (event) => {
      const input = event.target.closest?.("[data-school-setting]");
      if (!input) return;
      const item = SCHOOL_SETTINGS_ITEMS.find((entry) => entry.key === input.dataset.schoolSetting);
      const number = schoolSettingsNumber(input.value, item);
      const message = box.querySelector("#schoolSettingsMessage");
      const error = number === null ? `${item.label}: ${item.min}~${item.max} 사이의 정수로 넣어 주세요.` : applyValue(item.key, number);
      if (error) { message.textContent = error; message.style.color = "#a44939"; render(); return; }
      afterChange();
      render();
      message.style.color = "#287956";
      message.textContent = `${item.label} → ${number} (저장됨)`;
    });
    box.querySelector("#schoolSettingsExport").addEventListener("click", () => {
      const file = schoolSettingsExport(sources(), { exportedAt: new Date().toISOString(), appVersion: typeof APP_VERSION !== "undefined" ? APP_VERSION : "", schoolName: byId("schoolName")?.value.trim() || "" });
      const name = `${file.schoolName ? `${file.schoolName}_` : ""}학교설정.json`;
      if (typeof downloadBlob === "function") downloadBlob(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }), name);
      const message = box.querySelector("#schoolSettingsMessage");
      message.style.color = "#287956";
      message.textContent = `'${name}'로 저장했습니다. 기준값만 들어 있습니다(학생·교사 이름 없음).`;
    });
    box.querySelector("#schoolSettingsImport").addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      const message = box.querySelector("#schoolSettingsMessage");
      try {
        const parsed = schoolSettingsParse(await file.text());
        const changes = schoolSettingsImportChanges(parsed, sources());
        if (!changes.length) { message.style.color = "#5c6982"; message.textContent = "파일의 값이 지금 설정과 같습니다. 바꾼 것이 없습니다."; return; }
        const text = `${parsed.schoolName ? `${parsed.schoolName}의 ` : ""}학교 설정 파일에서 아래 ${changes.length}가지를 가져옵니다.\n\n${changes.map((change) => `· ${change.label}: ${change.from} → ${change.to}`).join("\n")}\n\n학생·결과·편제표 자료는 바뀌지 않습니다. 가져올까요?`;
        const ok = typeof appConfirm === "function" ? await appConfirm(text, { title: "학교 설정 가져오기", ok: "가져오기" }) : window.confirm(text);
        if (!ok) { message.style.color = "#5c6982"; message.textContent = "가져오기를 취소했습니다."; return; }
        const skipped = [];
        for (const change of changes) {
          if (change.key === "compliance") {
            const store = typeof planComplianceStore === "function" ? planComplianceStore() : (state.curriculumCompliance ||= { plans: {} });
            store.settings = { ...(store.settings || {}), ...JSON.parse(JSON.stringify(parsed.compliance)) };
            if (typeof planComplianceChanged === "function") planComplianceChanged();
            if (typeof courseCheckSharedSettingsChanged === "function") courseCheckSharedSettingsChanged();
          } else if (change.key === "timetable") {
            const store = timetableStore();
            const settings = { ...(store.settings && typeof store.settings === "object" ? store.settings : {}) };
            for (const key of change.keys) settings[key] = JSON.parse(JSON.stringify(parsed.timetable[key]));
            store.settings = settings;
          } else {
            const error = applyValue(change.key, change.to);
            if (error) skipped.push(`${change.label} — ${error}`);
          }
        }
        afterChange();
        render();
        message.style.color = skipped.length ? "#a44939" : "#287956";
        message.textContent = `학교 설정 ${changes.length - skipped.length}가지를 가져왔습니다.${skipped.length ? ` 가져오지 못한 것: ${skipped.join(" / ")}` : ""}`;
      } catch (error) {
        message.style.color = "#a44939";
        message.textContent = error?.message || String(error);
      }
    });
    return box;
  }

  function render() {
    const box = byId("schoolSettingsDialog");
    if (!box) return;
    const effective = schoolSettingsEffective(sources());
    const locked = typeof isRoundLocked === "function" && isRoundLocked(state.currentRound);
    const groups = [...new Set(SCHOOL_SETTINGS_ITEMS.map((item) => item.group))];
    const targetYear = typeof hoursTargetYear === "function" ? hoursTargetYear() : "";
    box.querySelector("#schoolSettingsBody").innerHTML = groups.map((group) => {
      const note = group.startsWith("5단계") && targetYear ? ` <span class="note">(${targetYear}학년도 시수 통계)</span>`
        : group.startsWith("4단계") && locked ? ` <span class="note">(${esc(state.currentRound)}차 확정 중 — 바꾸려면 확정 해제)</span>` : "";
      return `<section class="school-settings-group"><h3>${esc(group)}${note}</h3><table class="school-settings-table"><thead><tr><th>항목</th><th>지금 값</th><th>처음 값</th><th>고치는 곳</th></tr></thead><tbody>${
        SCHOOL_SETTINGS_ITEMS.filter((item) => item.group === group).map((item) => {
          const entry = effective[item.key];
          const mark = entry.explicit ? (entry.value === item.def ? "" : "바꿈") : "처음 값 그대로";
          return `<tr data-school-setting-row="${esc(item.key)}" data-explicit="${entry.explicit ? "1" : "0"}"><th scope="row"><label for="school-setting-${esc(item.key)}">${esc(item.label)}</label></th>
            <td><input class="cs-num" type="number" id="school-setting-${esc(item.key)}" data-school-setting="${esc(item.key)}" min="${item.min}" max="${item.max}" step="1" value="${entry.value}"${group.startsWith("4단계") && locked ? " disabled" : ""}> <span class="note">${mark}</span></td>
            <td>${item.legacy !== undefined && item.legacy !== item.def ? `${item.legacy} <span class="note">(새로 시작하면 ${item.def})</span>` : item.def}</td><td class="note">${esc(item.where)}</td></tr>`;
        }).join("")}</tbody></table></section>`;
    }).join("") + `<section class="school-settings-group"><h3>그 밖에 학교마다 확인할 것</h3><ul class="note">
        <li>편제 점검 기준값(교과(군) 필수 학점, 총 이수 174·창체 18, 국·수·영 81 등): 1단계 편제표 카드 '편제 점검' → 기준 설정 — 파일로 내보내기/가져오기에 함께 들어갑니다.</li>
        <li>요일별 교시 수·창체 시간·시간표 규칙(연강·하루 최대·공강): 7단계 조건 설정 — 파일에 함께 들어갑니다.</li>
        <li>내년 학급 수·교사 수·교사 명단·특별실: 4·5·6단계에서 해마다 넣습니다(파일에 들어가지 않음).</li></ul></section>`;
  }

  window.openSchoolSettings = function openSchoolSettings() {
    const box = dialog();
    box.querySelector("#schoolSettingsMessage").textContent = "";
    render();
    if (typeof box.showModal === "function" && !box.open) box.showModal();
  };

  // 처음 쓰는 브라우저(저장된 자료 없음·전체 초기화 직후): 새 학교 기본값(중립값)을 넣는다. 저장된 자료가 있는 사용자는 부르지 않는다.
  window.schoolSettingsFreshWorkspace = function schoolSettingsFreshWorkspace() {
    const store = timetableStore();
    if (store.settings && typeof store.settings === "object" && store.settings.lunchAfter) return;
    store.settings = { ...(store.settings && typeof store.settings === "object" ? store.settings : {}), ...schoolSettingsNeutralTimetable() };
  };

  document.addEventListener("click", (event) => {
    if (!event.target.closest?.("#openSchoolSettings, [data-open-school-settings]")) return;
    byId("workspaceDataMenu")?.removeAttribute("open");
    window.openSchoolSettings();
  });
}
