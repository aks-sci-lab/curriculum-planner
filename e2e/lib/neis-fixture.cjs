"use strict";
// 가상 나이스 '수강학생 편성' 엑셀(1행 '개설 과목'/'편성 학생' 병합 머리, 2행 열 머리, 이름은 '김00' 식 가림).
// 현 2학년(2025 입학)의 2학년(2026학년도) 1·2학기 이수 기록과, 가린 이름이라 연결되지 않는 1학년(2025학년도) 기록을 만든다.
const { writeXlsx } = require("./xlsx-write.cjs");
const { SCHOOL, GROUPS, CROSS } = require("./plan-fixture.cjs");
const Core = require("../../test-bot-core.js");

const HEAD = [["개설 과목", "", "", "", "", "", "편성 학생", "", "", ""],
  ["학년도", "학기", "학년", "편제명", "개설과목(학점)", "개설강의실", "계열/학년/학과", "반", "번호", "성명"]];
const FAMILY = (area) => area === "기술·가정/정보" ? "기술·가정/정보" : area;
const NEED = { "전자기와 양자": "물리학", "화학 반응의 세계": "화학", "세포와 물질대사": "생명과학", "행성우주과학": "지구과학", "미적분Ⅱ": "미적분Ⅰ" };

// roster: 현 2학년 명렬, chosen3: Map(seat → 3학년 최종 선택), followRate: 3학년 과목의 앞 과목을 2학년에 들었을 확률
function buildNeis({ roster, chosen3, seed, year = 2026, followRate = 0.85 }) {
  const rng = Core.createRng(seed * 7919 + 11);
  const masked = (name) => `${String(name).slice(0, 1)}00`;
  const sems = { "1": [], "2": [] };
  const prior = new Map();
  const g21 = GROUPS.find((g) => g.field === "sem21");
  const g22a = GROUPS.find((g) => g.field === "sem22" && g.pick === 1);
  const g22b = GROUPS.find((g) => g.field === "sem22" && g.pick === 3);
  for (const s of roster) {
    const seat = `${s.classroom}-${s.number}`;
    const wants = (chosen3.get(seat) || []).map((n) => NEED[n]).filter(Boolean).filter(() => rng() < followRate);
    const pick = (group, must) => {
      const names = group.members.map((m) => m[2]);
      const chosen = [...new Set(must.filter((n) => names.includes(n)))].slice(0, group.pick);
      for (const n of Core.shuffle(names, rng)) if (chosen.length < group.pick && !chosen.includes(n)) chosen.push(n);
      return chosen;
    };
    const e21 = pick(g21, wants), e22a = pick(g22a, wants), e22b = pick(g22b, []);
    prior.set(seat, new Set([...e21, ...e22a, ...e22b]));
    const row = (semester, area, name, credit) => [String(year), semester, "2", FAMILY(area), `${name}(${credit})`, `2학년 ${s.classroom}반`, "2학년", String(s.classroom), String(s.number), masked(s.name)];
    for (const [area, , name, , credits] of SCHOOL) {
      if (credits.sem21) sems["1"].push(row("1", area, name, credits.sem21));
      if (credits.sem22) sems["2"].push(row("2", area, name, credits.sem22));
    }
    const art = Number(s.classroom) % 2 ? [CROSS.members[0], CROSS.members[1]] : [CROSS.members[1], CROSS.members[0]];
    sems["1"].push(row("1", art[0][0], art[0][2], CROSS.credit));
    sems["2"].push(row("2", art[1][0], art[1][2], CROSS.credit));
    const areaOf = (group, n) => group.members.find((m) => m[2] === n)[0];
    for (const n of e21) sems["1"].push(row("1", areaOf(g21, n), n, g21.credit));
    for (const n of e22a) sems["2"].push(row("2", areaOf(g22a, n), n, g22a.credit));
    for (const n of e22b) sems["2"].push(row("2", areaOf(g22b, n), n, g22b.credit));
  }
  // 지난 학년도(2025) 1학년 1학기 기록: 이름이 가려져 지금 학생과 연결되지 않아야 한다.
  const last = roster.slice(0, 40).map((s) => [String(year - 1), "1", "1", "국어", "공통국어1(4)", `1학년 ${s.classroom}반`, "1학년", String(s.classroom), String(s.number), masked(s.name)]);
  const sheet = (rows) => ({ name: "수강학생편성", rows: [...HEAD, ...rows], merges: ["A1:F1", "G1:J1"] });
  return {
    files: [
      { name: `수강학생편성_${year}_1학기.xlsx`, bytes: writeXlsx([sheet(sems["1"])]) },
      { name: `수강학생편성_${year}_2학기.xlsx`, bytes: writeXlsx([sheet(sems["2"])]) },
      { name: `수강학생편성_${year - 1}_1학기.xlsx`, bytes: writeXlsx([sheet(last)]) },
    ],
    prior, rows: sems["1"].length + sems["2"].length + last.length,
  };
}
module.exports = { buildNeis, NEED };
