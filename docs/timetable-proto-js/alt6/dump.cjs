// 실험(alt6): 백업을 복원한 앱에서 6단계 그룹 입력·저장 결과와 7단계 시간표 입력(조건별)을 꺼내 dump.json 에 적는다. 저장소는 고치지 않는다.
const path = require("path"), fs = require("fs");
const { execFileSync } = require("child_process");
const ROOT = process.argv[2], BACKUP = process.argv[3], OUT = process.argv[4];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const { chromium } = require(path.join(globalRoot, "playwright"));
  const { startStaticServer } = require(path.join(ROOT, "e2e/lib/static-server.cjs"));
  const { server, url } = await startStaticServer(ROOT);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, locale: "ko-KR" });
  await context.route(/supabase\.co|googleapis|gstatic/, (route) => route.abort());
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto(url); await page.waitForLoadState("networkidle"); await sleep(1000);
  await page.locator("#workspaceDataMenu summary").click();
  const nav = page.waitForEvent("load", { timeout: 30000 }).catch(() => null);
  await page.locator("#restoreWorkspaceBackup").setInputFiles(BACKUP);
  await page.locator("#appConfirmDialog[open] #appConfirmOk").click({ timeout: 10000 }).catch(() => {});
  await nav; await sleep(2500);
  const data = await page.evaluate(() => {
    const plain = (value) => JSON.parse(JSON.stringify(value, typeof stateJsonReplacer === "function" ? stateJsonReplacer : undefined));
    const round = String(state.currentRound);
    const year = hoursTargetYear();
    const tt = plain(timetableSettings());
    const creativeTotal = Number(timetableInput(round, "1").creativeTotal) || 0;
    const creativeOf = (byGroup) => ({ school: 0, schoolTimes: [], grade: creativeTotal, gradeTimes: {}, byGroup });
    const overrides = {
      base: {},
      double: { doubleSubjects: ["스포츠 생활"] },
      grade: { creative: creativeOf(false) },
      gradeDouble: { creative: creativeOf(false), doubleSubjects: ["스포츠 생활"] },
      byGroup: { creative: creativeOf(true) }
    };
    const variants = {};
    for (const [name, override] of Object.entries(overrides)) {
      variants[name] = { round, set: { variant: name }, semesters: {}, assumptions: {} };
      for (const semester of ["1", "2"]) {
        const prepared = timetableInputCompute(round, semester, year, { ...tt, ...override });
        variants[name].semesters[semester] = plain(prepared.input);
        variants[name].assumptions[semester] = prepared.assumptions.map((entry) => entry.text);
      }
    }
    const source = classSectionsSource(round);
    const cs = classSectionsSettings();
    const groups = source.groups.map((group) => {
      const entry = classSectionsEntry(round, group.key, true);
      const result = entry.sectionResult;
      let plan = null;
      try { plan = classSectionsClassUnitPlan(group, entry, cs); } catch { plan = null; }
      return {
        key: group.key, label: group.label, grade: group.grade, targetGrade: group.targetGrade, semester: group.semester, category: group.category, choice: group.choice, classes: group.classes,
        courses: plain(group.courses), students: group.students.length, rawStudents: plain(classSectionsHomeroomStudents(group)),
        modes: plain(classSectionsCourseConf(cs, "courseModes", group.grade)), departments: plain(classSectionsCourseConf(cs, "courseDepartments", group.grade)), rooms: plain(classSectionsCourseConf(cs, "courseRooms", group.grade)),
        unitOnly: classSectionsClassUnitOnly(group, entry, cs), unitPlan: plan ? plain({ assign: plan.assign, homerooms: plan.homerooms, mapped: plan.mapped, ratio: plan.ratio }) : null,
        entry: plain({ blocks: entry.blocks, classCounts: entry.classCounts, blockTimes: entry.blockTimes, blockMax: entry.blockMax, mode: entry.mode, defaultCapacity: entry.defaultCapacity, maxSectionsPerBlock: entry.maxSectionsPerBlock, pins: entry.pins, classUnit: entry.classUnit }),
        input: plain(classSectionsBuildInput(round, group, entry, { noOccupied: true })),
        result: result ? plain({ sections: result.sections, blocks: result.blocks, unassigned: result.unassigned, teacherOf: result.teacherOf, metrics: result.metrics, issues: (result.issues || []).map((issue) => ({ type: issue.type, severity: issue.severity })) }) : null
      };
    });
    return { round, year, tt, creativeTotal, variants, maxClassSize: source.maxClassSize, groups,
      csSettings: plain({ gridDays: cs.gridDays, gridPeriods: cs.gridPeriods, fixedSlots: cs.fixedSlots, rooms: cs.rooms, useHoursTeachers: cs.useHoursTeachers, promotion: cs.promotion, teacherCount: cs.teachers.length }) };
  });
  await browser.close(); server.close?.();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "dump.json"), JSON.stringify(data));
  for (const [name, value] of Object.entries(data.variants)) { fs.mkdirSync(path.join(OUT, `base-${name}`), { recursive: true }); fs.writeFileSync(path.join(OUT, `base-${name}`, "inputs.json"), JSON.stringify(value)); }
  console.log("groups", data.groups.map((g) => `${g.key} 택${g.choice} 과목${g.courses.length} 학생${g.students} unitOnly=${g.unitOnly} result=${g.result ? g.result.sections.length : "-"}`).join("\n"));
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
