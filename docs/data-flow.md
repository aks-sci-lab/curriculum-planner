# 자료 연결 지도 — 과목 신원과 개설 학급 수가 단계 사이를 어떻게 지나가는가

이 문서는 "4단계 집계와 5단계 시수 통계가 다르게 보인다"는 문제를 계기로 만들었습니다(2026-11). 편제표에서 6단계 출력물까지, 단계마다 **무엇을 읽는지**, **과목을 무엇으로 맞추는지**(이름·키·학기), **어디서 다시 계산하는지**를 적습니다. 코드를 바꿀 때 이 표와 `tests/data-consistency.test.cjs`를 함께 고치세요.

## 한 줄 요약

```
1단계 편제표 데이터 ─▶ collectApplicationSubjects ─▶ 2단계 선택 그룹(getApplicationGroupSettings)
                                   │                           │
                                   ▼                           ▼
                      2단계 결과 취합(createRecords / mergeApplications → classifyApplicationRecords
                                     · splitUntaggedTwoSemesterCourses · 개설 학기 선택 courseSemesterPicks)
                                   │  state.rounds[차수] = { students, courses, classOverrides, … }
                                   ▼
          4단계 aggregateRecords(학기·그룹·과목 → 인원·권장/입력 학급수·폐강) = 화면 집계표·엑셀
                                   │  buildRoundSnapshot(같은 aggregateRecords를 행 목록으로)
                                   ▼
        ★ 과목 개설 결정의 한 출처: courseOpeningRound(현학년) + courseOpeningSnapshot(차수)   (round-status.js)
              확정된 차수 = 확정 스냅샷 · 아니면 지금 4단계 기준 스냅샷(캐시)
                 │                                         │
                 ▼                                         ▼
     5단계 computeHoursStats 개설반 자동 값          6단계 classSectionsSource 분반 수(그룹 = 현학년:학기:택n)
     (편제표 학기 칸 × 4단계 학급 수)                  (학생 명단은 같은 차수 자료, 학급 수는 스냅샷)
```

## 과목 신원(같은 과목인지 맞추는 기준)

| 키 | 만드는 곳 | 모양 | 쓰는 곳 |
|---|---|---|---|
| 결과 열 `column` | `createRecords`(가로형) · `mergeApplications`(목록형) → `storeGradeResults`가 `result-<현학년>-<n>`으로 바꿈 | 차수 안에서만 유일 | 학생 선택 ↔ 과목, `classOverrides["현학년:열"]`, `roundClosures[차수]["현학년:열"]`, `semesterAssignments[열]`, `groupAssignments[열]` |
| 과목명 정규화 | `normalizeResultCourseName`(result-import.js) | 기호·`(n학기)`·`(n학년)`·`(일반/진로/융합)`·가운뎃점·띄어쓰기 제거 + 자동 수정 전 이름 별칭 | 5단계 결과 찾기(`resultIndex`), 스냅샷 비교, 앞 차수 폐강, 6단계 편제표 교과 |
| 학기 | 결과 꼬리표 `(n학기)` · 같은 이름 두 열(`labelRepeatedCourseColumns` 왼쪽 1·오른쪽 2) · 이웃 열(`splitUntaggedTwoSemesterCourses`) · 학생별 택n · **개설 학기 선택** | `"1"`·`"2"`·`""`(학기 미정) | 4단계 학기 구역, 스냅샷 `row.semester`, 5단계 `item.semester`, 6단계 그룹 키 |
| 그룹 | `applicationGroupForCourse`(편제표 묶음 이름 `3-2 택5`) → `course.applicationGroups[현학년]` | `{ name, semester }` | 4단계 그룹, 스냅샷 `row.group`, 6단계 그룹 키 |
| 개설 학기 선택 키 | `courseSemesterPickKey`(course-semester-picks.js) | 정규화 이름(학기·학년·구분 꼬리표, 띄어쓰기 제거) | `state.courseSemesterPicks[학년도][현학년][키]` |
| 개설 결정 행 키 | `courseOpeningRowKey` | `현학년|학기|그룹|정규화 이름` | 확정 스냅샷 ↔ 지금 집계 비교(`roundSnapshotStale`), 6단계 `snapshotCount` |

## 단계별 표

| 단계 | 읽는 것 | 과목 맞추기 | 개설 학급 수 출처 | 다시 계산하는 곳 |
|---|---|---|---|---|
| 1 편제표 | 업로드 원본 → `planData` | 과목 한 행 | — | `curriculumPlanEntries`(5단계용 학기 항목), `collectApplicationSubjects`(신청 과목: 두 학기면 `semester: "1·2"`, `sameCourseOnce`) |
| 2 선택 그룹 | 편제표 묶음(`curriculumPlanGroupAssignments`) | 그룹 과목명 | — | `getApplicationGroupSettings()`(약 50ms, 반복 안에서 부르지 말 것) |
| 2 결과 취합 | 결과 파일 | 열 + 이름 | — | `classifyApplicationRecords` = 두 학기 과목 나누기(`splitUntaggedTwoSemesterCourses`, **저장된 개설 학기가 있으면 그 과목 학생 전부 그 학기**) → 그룹 정하기. 반영 때 `storeGradeResults`가 열 번호를 바꾸고 같은 차수·앞 차수 설정을 **이름 + 학기**로 이어받음 |
| 3 확인서·위계 점검 | `state.students[].selections`(`applicationSelections`) | 선택의 이름·`semesterKey` | — | 저장 자료 그대로(개설 학기를 바꾸면 선택 자체가 바뀌므로 따라감) |
| 4 집계 | 지금 차수 `students`·`courses`·`classOverrides`·폐강(`effectiveRoundClosures`: 앞 차수 결정을 현학년+학기+그룹+이름으로 이어받음)·내년 학급 수 | 열 | 입력값(`classOverrides`) 또는 권장값(인원 ÷ 분반 기준), 폐강이면 0 | `aggregateRecords` 하나(화면·엑셀·스냅샷·학급수 자동 조정이 함께 씀) |
| 차수 확정 | `buildRoundSnapshot` = 같은 `aggregateRecords` | 행 = 현학년·학기·그룹·`subjectName` | 확정 시점 `classCount` | 확정하면 고정. 확정 뒤 자료와 달라지면 `roundSnapshotStale`이 과목을 알려 줌 |
| **한 출처** | `courseOpeningRound(현학년)`: 최근 확정 차수(그 학년 행 있음) → 4단계에서 보는 차수(결과 있음) → 결과가 있는 최근 차수 | — | `courseOpeningSnapshot(차수)`: 확정 스냅샷 또는 지금 4단계 기준 스냅샷(`cachedByStateRevision`) | — |
| 5 시수 | 편제표 학기 항목(학점) + 한 출처 스냅샷 행 | `정규화 이름` + 학기 | 같은 학기 행의 `classCount` 합. **두 학기 편성 과목**: 다른 학기에만 행이 있으면 이 학기 0(근거 '두 학기 편성 · n학기만 개설'), 학기 미정 행은 어느 학기에도 넣지 않고 경고(4단계에서 학기 정하기). 직접 입력(`classOverrides`)이 우선이고 4단계 값과 다르면 칸 표시(`is-differ`) | `computeHoursStats`(`hoursStatsCached`) |
| 6 분반 | 같은 차수 자료(학생 명단) + 확정 스냅샷 학급 수 | 그룹 키 `현학년:학기:택n`, 과목 키 `subjectName` | 스냅샷 `classCount`(없으면 지금 4단계), 6단계 직접 입력은 '4단계와 다름' 표시 | `classSectionsSource`(차수 기본값 = `courseOpeningRound("")`) |

## 찾은 불일치와 고친 곳

재현: `e2e/lib/two-semester-fixture.cjs`(현 2학년 11학급 × 28명, 성명 '학생n'), `심화 영어`(편제표 3-1 택5·3-2 택5에 모두)를 가로형 결과에 **한 열**로, 3-1 과목과 3-2 과목 사이(학기 경계)에 둠. 179명 신청 중 12명은 3-1에서 4과목만(=1학기로 추정), 167명은 3-2에서 4과목만(=2학기로 추정). 하네스 seed 10 백업 위 3차로 올림.

| # | 증상(예전 코드) | 원인 | 고친 곳 |
|---|---|---|---|
| 1 | 한 학기만 개설한 과목이 4단계에 1학기·2학기 두 줄로 나뉨(1학기 12명, 2학기 167명) | 학기 경계 열이면 학생별 택n 추정 → 학생마다 다른 학기 | 결과 검증 미리보기 **'두 학기 편성 과목 — 개설 학기 선택'**(추정값·근거 표시, 고르지 않고 반영하면 확인 창), 고른 학기로 그 과목 학생 전부 고정(`splitUntaggedTwoSemesterCourses` ← `courseSemesterPickFor`) |
| 2 | 12명뿐인 1학기 쪽이 9학급, 167명인 2학기 쪽이 폐강 0학급 | 반영 때 앞 차수(2차, 웹 결과는 1학기 9반·2학기 폐강) 설정을 **이름 + 학기**로 이어받음 | #1로 학기가 하나가 되면 이어받는 대상도 하나. 4단계 '개설 학기 바꾸기'는 그 과목의 학급수 입력·개설 결정을 지움(학기가 바뀌므로) — 이어받은 폐강은 과목 메뉴에 '○차에서 정한 결정을 이어받았습니다'로 보임 |
| 3 | 3차를 보는 4단계와 2차 확정을 읽는 5단계 값이 다른데 안내 없음 | 5단계는 최근 **확정** 차수, 4단계는 지금 차수 | 4단계 안내 `5·6단계는 현 n학년 m차 확정 결과를 씁니다(지금 화면은 k차)`(`aggregateOpeningSourceNotice`) |
| 4 | 5단계와 6단계가 서로 다른 차수를 고를 수 있음 | 차수 고르는 규칙이 두 벌(5단계: 확정 → 최근, 6단계: 확정 → 지금 차수 → 최근) | `courseOpeningRound` 하나로(5단계 고정 차수 설정은 그대로 우선) |
| 5 | 확정 뒤 그룹 설정·편제표·분류 규칙이 바뀌면 4단계 화면(지금 계산)과 5·6단계(확정 스냅샷)가 조용히 어긋남 | 스냅샷은 확정 시점 값 | `roundSnapshotStale` → 4단계 안내·5단계 확인 항목('확정 해제 후 다시 확정') |
| 6 | 학기 미정으로 남은 두 학기 과목을 5단계가 1학기에 넣음(4단계는 '학기 미정' 구역) | '학기 표시 없는 결과는 앞 학기에' 규칙 | 두 학기 편성 과목이면 넣지 않고 경고(4단계 '개설 학기 바꾸기'로 정하기). 한 학기에만 편성된 과목은 예전처럼 그 학기 |
| 7 | 2학기에만 개설한 과목의 1학기 줄이 '결과에 없어 0(과목명 불일치?)' 경고 | 두 학기 편성 여부를 보지 않음 | '두 학기 편성 · n학기만 개설'(경고 없음, 0이라 시수표에서 숨김) |
| 8 | 5단계 직접 입력 개설반이 4단계와 달라도 표시 없음 | — | 칸 `is-differ`(주황 테두리) + title '직접 입력 n반 · 4단계 m반과 다름' |
| 9 | 6단계를 한 번 연 뒤 새 차수를 확정해도 6단계는 앞에 보던 차수(예: 2차 305명)를 계속 보여 줌(5단계는 새 확정 차수) | 6단계 화면 차수(`CLASS_SECTIONS_VIEW.round`)를 한 번 정하면 유지 | 기본값(`courseOpeningRound`)이 더 뒤 차수로 바뀌면 따라감(확정 해제 중에는 고른 차수 유지) — 하네스 2-7에서 발견 |

## 개설 학기 선택(사용자 결정)

- 판별: 편제표 두 학기에 편성된 과목(`sameCourseOnce`)이 결과에 학기 꼬리표 없이 **한 번만** 나오면 '한 학기만 개설'. 같은 이름 두 열(왼쪽 1·오른쪽 2)이면 두 학기 모두 개설이라 고르지 않습니다. 웹 신청은 학생이 학기를 골라 신청하므로(한 학기만 열었으면 그 학기만 나옴) 고르지 않고, 5단계가 '두 학기 편성 · n학기만 개설'로 0을 둡니다.
- 저장: `state.courseSemesterPicks[학년도][현학년][courseSemesterPickKey(과목명)] = "1" | "2"`(백업·IndexedDB 조각 `courseSemesterPicks.학년도`·전체 초기화에 포함, 복원은 `courseSemesterPicksRestore`).
- 바꾸기: 4단계 과목 메뉴 `개설 학기 바꾸기 · N학년 1학기로 / 2학기로`(확정 잠금 따름, 확인 창) → `applyTwoSemesterPick`(나뉜 열을 한 열로 모으고 이름·학점·학기 표시를 바꿈) → `classifyApplicationRecords`로 그룹 다시 정함 → 4·5·6단계·확인서·위계 점검이 같은 자료를 읽어 따라감.
- **학기가 섞인 실제 분포(예: 1학기 1반 + 2학기 8반)**: 지금은 지원하지 않습니다. 결과에 한 열로 나온 과목은 어느 학기에 신청했는지 학생 응답에 없으므로, 섞인 분포는 추정일 뿐입니다. 두 학기 모두 개설하려면 결과 파일에 두 열(또는 `(1학기)`·`(2학기)` 꼬리표)로 받으면 지금 규칙(같은 이름 두 열)이 학생별 학기를 그대로 씁니다. 고르지 않고 반영을 거절하면(확인 창 '돌아가서 고르기') 예전처럼 학생별로 나뉜 채로 둘 수도 없습니다 — 확인 창에서 반영하면 추정 학기로 고정됩니다. 필요해지면 선택지에 '두 학기 나눔(학생별 추정)'을 더하면 됩니다(`pickOf`가 `""`이면 지금 규칙).

## 남긴 것

- 앞 차수 설정 이어받기(`storeGradeResults`·`effectiveRoundClosures`)는 이름 + 학기 기준 그대로입니다. 인원이 크게 바뀐 과목에 앞 차수 학급수가 이어질 수 있으나 4단계에 보이고 고칠 수 있어 그대로 두었습니다.
- 4단계 화면은 확정된 차수도 지금 자료로 계산해 그립니다(스냅샷으로 그리지 않음). 대신 둘이 다르면 알립니다.
- 5단계 '근거 차수 고정'(`settings.sourceRounds`)은 사용자가 고른 것이므로 한 출처 규칙보다 우선합니다.

## 검사

- `tests/data-consistency.test.cjs`: 실제 코드로 같은 자료의 4단계 개설 학급수 = 5단계 개설반 자동 값 = 6단계 분반 수(과목·학기마다), 고르지 않았을 때(학생별)·고른 뒤·학기 바꾸기 뒤·되돌린 뒤, 학기 미정, 확정 스냅샷 어긋남, 차수 규칙, 직접 입력 표시.
- `node e2e/two-semester-consistency-ui.cjs <폴더> <백업>`: 사용자처럼 클릭(미리보기에서 학기 고르기 → 반영 → 4단계 그 학기 구역 → 확정 → 5단계 시수표 칸 = 6단계 분반 수 → 확정 해제 → 학기 바꾸기 → 다시 확정 → 따라감). `node e2e/run.cjs`의 2-7 단계로도 돕니다.
