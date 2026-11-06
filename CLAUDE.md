# 교육과정 관리 (curriculum-planner)

학교 교육과정 담당자가 **자기 PC에서 혼자** 편제표를 관리하고, 수강신청 결과를 취합·집계·확정하는 브라우저 앱입니다. 빌드 도구 없이 `index.html`을 열면 동작합니다(전역 스크립트, 모듈 시스템 없음).
- 편제표·외부 결과 취합·확인서·집계·시수 통계는 **로컬 전용**(서버 전송 없음, 로그인 불필요).
- **웹 수강신청**만 홈페이지 + 교사 구글 로그인 + Supabase를 씁니다(`supabase-client.js`, `supabase/*.sql`).
- 학생 자료는 개인정보입니다. 학생 명단·결과 엑셀·백업 JSON을 저장소에 커밋하지 마세요.

## 명령
```
node --test tests/*.test.cjs      # 전체 테스트(이 환경에서는 슬래시 경로 사용)
npm run build:css                  # src/legacy.css 를 고친 뒤 styles.css 재생성
npm run build:deploy               # 배포용 파일만 dist/ 에 모음
```
화면 검증은 Playwright(설치돼 있음)로 `file:///.../index.html` 을 열어 **사용자처럼 클릭**해서 합니다. 내부 함수를 직접 호출해 통과시키지 말고, 화면에 보이는 글자·스크린샷으로 확인하세요.

## 학년 규칙 (자주 틀리는 부분)
- **현 N학년 학생은 N+1학년 과목을 신청**합니다. 결과 화면·집계·확인서에는 "현 N학년"과 "N+1학년"이 함께 드러나야 합니다.
- 입학생 편제표 카드: 내년도 신입생(Y+1), 현1학년(Y), 현2학년(Y−1), 현3학년(Y−2). 현1학년 신청은 Y 입학생 편제표의 2학년 열, 현2학년은 Y−1의 3학년 열을 씁니다.
- **전학년 편제표는 업로드하지 않고** Y, Y−1, Y−2 입학생 3개년 편제표에서 학년 열을 가져와 자동 생성합니다(읽기 전용).

## 기능별 파일 지도 (작업할 기능의 파일만 읽으세요)
| 기능 | 주요 파일 |
|---|---|
| 1단계 편제표(업로드·표·선택과목군·행·과목 이동·이력) | `curriculum-data.js`(업로드→과목·선택과목군 데이터 변환, 예전 자료 변환), `curriculum-data-view.js`(데이터로 그린 표·편집), `curriculum-data-export.js`(원본 양식+데이터+수식 내보내기), `curriculum-choice-blocks.js`(택n), `curriculum-subject-actions.js`, `curriculum-subject-list.js`(2022 개정 과목 목록), `curriculum-versions.js`(변경 이력), `curriculum-workbook.js`(수식·내보내기), `curriculum-annual.js`(전학년 생성), `xlsx-parser.js` |
| 1단계 편제 점검표·편성 영역·교과(군) 통계(카드마다 `편제 점검` 팝업, 울산 편제 점검 프로그램 점검표 자동 20+자체 4개, 인정오류·자체 점검은 `state.curriculumCompliance.plans["cohort:연도"/"annual:연도"]`, 기준값은 `.settings`(설정 팝업), 편성 영역은 과목 데이터 `subject.planSection`(`school`/`choice`/`cross`/`extra`)·`planSectionManual` + `curriculumPlanSection(subject, plan)`, 행 메뉴 `편성 영역 바꾸기`, 표의 영역 표시·학점 범위 경고·과목명 `바꾸기`, 점검표·통계 엑셀/인쇄, 2015 개정(2024 이전 입학생)은 점검 대상 아님, 전학년은 학점 범위·과목명·체육·3-2 수능만) | `curriculum-compliance.js`(위쪽 순수 계산 `planComplianceReport`·`planComplianceStats` → `// ---- 앱 연결` 아래 팝업·표 장식, `app.js`보다 먼저 로드, 과목 학점 범위는 `curriculum-subject-list.js`의 `CURRICULUM_OFFICIAL_CREDIT_ROWS`, 위계는 `course-checks.js` 규칙 재사용), 테스트 `tests/curriculum-compliance.test.cjs` |
| 2단계 선택 그룹·결과 업로드/검증 | `course-groups.js`(그룹), `result-import.js`(검증 미리보기) |
| 3단계 확인서 | `app.js`의 `certificateMarkup`, `renderRoster`, `visibleStudents`, `printStudents` |
| 4단계 집계·개설/폐강·재신청·차수 확정 | `app.js`(`aggregateRecords`, 폐강·재신청 패널), `round-status.js`(확정·스냅샷·차수 비교) |
| 5단계 시수 통계 | `hours-stats.js` |
| 웹 수강신청·서버 | `supabase-client.js`, `supabase/*.sql` |
| 위계(선이수)·이수학점 점검(2단계 검증·팝업, 3단계 확인서 점검란·학생 목록 `⚠ 위계` 표시·`위계 경고만` 필터, 4단계 과목 행 `위계 경고 n` 배지(확인 불가는 학년 머리줄 흐린 단추·팝업 접힌 칸에만)·학생 목록 팝업(`#prereqStudentsDialog`)·학년 머리줄·`처리할 것만` 포함·집계표 엑셀 `위계 경고 학생` 시트·재신청 명단 `위계 경고(폐강 후)` 열·부족 학점, 웹 학생 점검표, 웹 교사 `신청 현황 · 위계 점검`·과목 변경 목록 — **위계는 모든 과목 경고만, 저장 막기·서버 검사 없음**) | `course-checks.js`(위쪽 순수 계산(`courseCheckIssueBrief`, 교사 화면 `courseCheckTeacherReview`) → `// ---- 앱 연결` 아래 화면 연결(`courseCheckFlags`: 학생 전체를 한 번 계산해 학생·`학년:열`·학년 Map, 문맥 캐시로 재사용), `app.js`보다 먼저 로드, 설정은 `state.courseChecks`, 기본 위계 `COURSE_CHECK_DEFAULT_RULES`), 테스트 `tests/course-checks*.test.cjs`(`course-checks-flags`는 표시·엑셀·필터, `course-checks-sql`은 점검 정보가 서버 변경 없이 jsonb로 보존되는지·교사 화면 계산을 PGlite 확인) |
| 수강신청 테스트봇(가상 학생 웹 신청·자동 테스트·가상 결과 엑셀) | `test-bot.html`, `test-bot.js`(화면), `test-bot-core.js`(선택 생성기·서버 호출·회차 반복 실행기 `runRepeatedTest`, 순수 함수), `test-bot-bridge.js`(앱↔봇 postMessage, 앱 쪽 응답은 `supabase-client.js`의 `answerTestBot`), `supabase-config.js`(서버 주소 공유) |
| 저장·백업·배포 | `app.js`(저장·백업·전체 초기화), `workspace-file.js`(PC 파일 자동 저장), `app-version.js`, `scripts/build-deploy.js` |
`app.js`(약 6,300줄)는 상태·저장·단계 전환·확인서·집계가 모두 들어 있는 중심 파일이므로 `grep -n "function 이름"`으로 필요한 함수만 읽으세요. 스타일은 `src/legacy.css` → `styles.css`(생성물).

- 편제표는 **데이터 기반**입니다. 원본 엑셀은 내보내기 양식으로만 쓰고, 화면·계산은 과목·선택과목군 데이터로 합니다. 선택과목군을 가짜 병합으로 표시하지 마세요.

## 상태와 저장
- 작업 자료: `localStorage["course-certificate-studio-v1"]`, 선택 그룹은 `curriculum-color-semester-groups-v3*` 키, 원본 편제표 엑셀은 IndexedDB `curriculum-original-workbooks`. `workspace-file.js`가 PC 파일에도 저장합니다.
- 차수별 결과는 `state.rounds[차수]`, 개설/폐강은 `state.roundClosures`, 확정은 `state.roundStatuses`(확정된 차수는 `isRoundLocked`로 잠금).
- 백업 JSON(`type: "curriculum-workspace-backup"`, `backupVersion`)은 형식을 바꿀 때 하위 호환을 유지하세요.

## 테스트 규약 (깨지기 쉬움)
- 테스트는 `app.js` 등에서 **함수 이름 마커로 소스를 잘라** `vm`에 올립니다(`functionSource(source, "function a(", "function b(")`). 함수 이름·순서를 바꾸거나 새 도우미를 그 구간 밖에 두면 테스트가 깨지니, 새 도우미는 쓰는 함수 바로 옆(같은 구간)에 두고 테스트 목록도 갱신하세요.
- `app.js`는 대부분의 모듈보다 먼저 로드됩니다. 다른 파일 함수는 `typeof x === "function"` 가드로 부르세요. 순수 함수 모듈(`curriculum-annual.js`)은 `app.js`보다 먼저 로드합니다.
- `vm` 안에서 만든 `Error`는 `instanceof Error`가 다른 영역이라 거짓이 됩니다. 오류 메시지는 `error?.message`로 읽으세요.

## 성능·정확성 교훈
- `getApplicationGroupSettings()`는 호출당 약 50ms입니다. 학생·과목 반복 안에서 부르지 말고 한 번 읽어 넘기세요.
- 병합 목록(`curriculumSheetMerges`)을 셀·병합마다 다시 만들면 제곱으로 느려집니다. 한 번 만들어 Map/Set으로 조회하세요.
- 편제표와 결과의 과목명은 표기가 다릅니다(`미적분Ⅱ`/`미적분2`, 띄어쓰기). 비교는 `normalizeResultCourseName`/`normalizeRomanNumerals`를 거치세요.
- 엑셀의 숨김 행·초소형 행은 `layout.hiddenRows`로 숨깁니다.

## Git
- 기능 작업은 브랜치에서 하고, **`main`에는 사용자가 말할 때만** 병합합니다. 커밋 메시지·PR 끝에 시스템이 지정한 귀속 문구를 붙입니다.
