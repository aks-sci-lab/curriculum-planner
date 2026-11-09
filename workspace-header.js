"use strict";
// 화면 맨 위 공통 머리 줄(현재 작업 대상·결과 차수·학교·학년도 설정·저장 상태·자료 관리)을 항상 크게 보이지 않게 한다.
//  · 아래로 스크롤하면(창이든 편제표 표 같은 안쪽 스크롤이든) 얇은 띠로 접혀 표 공간을 넓히고, 위로 조금 스크롤하거나 맨 위로 가면 다시 펼친다.
//  · 띠 아래 경계선 가운데 손잡이(1단계 위쪽 접기와 같은 모양)로 직접 접고 펼친다. 직접 접은 상태는 이 브라우저에 기억하고,
//    접힌 띠에 마우스를 올리면 잠깐 펼쳐 보인다. 접힌 띠에서도 결과 차수·설정(⚙)·자료 관리(☰)는 아이콘으로 쓴다.
//  · 저장 상태는 문제가 있을 때만 눈에 띄게(평소엔 '● 저장됨', 마우스를 올리면 시각), 백업 시각은 오래됐을 때만 보인다.
//    저장 상태 요소(id)와 app.js 함수는 그대로 두고 표시 방식만 바꾼다(data-save-state 속성 + CSS).
(function () {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const PREFERENCE_KEY = "curriculum-workspace-header-collapsed";
  const AUTO_DOWN = 80, AUTO_UP = 60;
  let header, toggle, manual = false, auto = false, peek = false, peekTimer = null;
  const scrolls = new WeakMap();
  let upTravel = 0;

  const readPreference = () => { try { return localStorage.getItem(PREFERENCE_KEY) === "1"; } catch { return false; } };
  const writePreference = (value) => { try { localStorage.setItem(PREFERENCE_KEY, value ? "1" : "0"); } catch { /* 기억하지 못해도 동작은 같다 */ } };

  function relayout() {
    if (typeof scheduleCurriculumTableSize === "function") scheduleCurriculumTableSize();
  }

  function apply() {
    const compact = (manual || auto) && !peek;
    const changed = header.classList.contains("is-compact") !== compact;
    header.classList.toggle("is-compact", compact);
    header.classList.toggle("is-peek", peek);
    toggle.setAttribute("aria-expanded", String(!compact));
    toggle.setAttribute("aria-label", compact ? "작업 대상·저장 머리 줄 펼치기" : "작업 대상·저장 머리 줄 접기");
    toggle.querySelector(".collapse-handle-arrow").textContent = compact ? "▼" : "▲";
    toggle.querySelector(".collapse-handle-text").textContent = compact ? "작업 대상·저장 펼치기" : "접기";
    if (changed) relayout();
  }

  // 저장 상태: 실패(재시도·저장 재개 단추나 저장 경고가 보이면) → 눈에 띄게, 저장 완료 → '● 저장됨'
  function syncSaveState() {
    const label = document.getElementById("workspaceSaveStatus");
    if (!label) return;
    const shown = (id) => { const element = document.getElementById(id); return Boolean(element && !element.classList.contains("hidden")); };
    const text = label.textContent.trim();
    const failed = shown("retryWorkspaceSave") || shown("resumeWorkspaceSave") || shown("workspaceStorageWarning") || /실패|부족|중지/.test(text);
    const state = failed ? "failed" : /완료/.test(text) ? "ok" : "busy";
    if (state === "ok") label.dataset.savedAt = new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    header.dataset.saveState = state;
    label.title = state === "ok" ? `${text}${label.dataset.savedAt ? ` · ${label.dataset.savedAt}` : ""}` : text;
  }

  function onScroll(event) {
    const target = event.target === document ? document.scrollingElement || document.documentElement : event.target;
    if (!target || typeof target.scrollTop !== "number" || header.contains(target)) return;
    if (target !== (document.scrollingElement || document.documentElement) && !target.closest?.(".main")) return;
    const top = target.scrollTop;
    const previous = scrolls.has(target) ? scrolls.get(target) : 0;
    scrolls.set(target, top);
    const delta = top - previous;
    if (!delta) return;
    if (delta > 0) {
      upTravel = 0;
      if (!auto && top > AUTO_DOWN) { auto = true; apply(); }
      return;
    }
    upTravel -= delta;
    if (auto && (upTravel >= AUTO_UP || top <= 8)) { auto = false; upTravel = 0; apply(); }
  }

  function init() {
    header = document.querySelector(".workspace-context");
    toggle = document.getElementById("workspaceContextToggle");
    if (!header || !toggle) return;
    manual = readPreference();
    toggle.addEventListener("click", () => {
      const compact = header.classList.contains("is-compact");
      manual = !compact;
      auto = false;
      peek = false;
      writePreference(manual);
      apply();
    });
    // 손잡이 밖 경계선을 눌러도 접고 펼친다.
    document.getElementById("workspaceContextDivider")?.addEventListener("click", (event) => {
      if (!event.target.closest("#workspaceContextToggle")) toggle.click();
    });
    // 접힌 띠(맨 위 경계)에 마우스를 올리면 잠깐 펼쳐 보인다. 띠 안의 아이콘·메뉴를 쓰는 동안에도 유지한다.
    header.addEventListener("mouseenter", () => {
      window.clearTimeout(peekTimer);
      if (!header.classList.contains("is-compact")) return;
      peekTimer = window.setTimeout(() => { peek = true; apply(); }, 350);
    });
    header.addEventListener("mouseleave", () => {
      window.clearTimeout(peekTimer);
      if (!peek) return;
      peekTimer = window.setTimeout(() => {
        if (header.querySelector(".workspace-data-menu[open]") || header.contains(document.activeElement) && document.activeElement.matches("select")) return;
        peek = false; apply();
      }, 500);
    });
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    const observer = new MutationObserver(syncSaveState);
    for (const id of ["workspaceSaveStatus", "retryWorkspaceSave", "resumeWorkspaceSave", "workspaceStorageWarning"]) {
      const element = document.getElementById(id);
      if (element) observer.observe(element, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    }
    syncSaveState();
    apply();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
