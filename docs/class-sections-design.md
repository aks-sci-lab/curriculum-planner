# 6단계 분반 편성 설계

4단계에서 확정한 개설 과목·분반 수와 학생 신청을 받아 **블록(같은 시간에 열리는 분반 묶음) 배치 → 학생 분반 배정 → 교사 배정 추천**까지 만든다. 요일·교시 전체 시간표 자동 생성은 범위 밖이고, 블록 단위까지만 다룬다.

- 순수 계산: `class-sections.js` (DOM·state 없음, Worker에서도 그대로 동작) — 1차 구현 완료
- 화면 연결: `class-sections-view.js` (2차)
- 테스트: `tests/class-sections.test.cjs` (파일 전체를 vm에 올림, 합성 자료)

## 1. 용어

| 용어 | 뜻 |
|---|---|
| 그룹 | (차수, 현 학년, 학기). 예: 1차 · 현1 → 2학년 1학기 택3 |
| 블록 | 그룹 안에서 같은 시간에 열리는 분반 묶음. 이름 a, b, c … (택n이면 보통 n개) |
| 분반 | 과목의 한 반. id `과목key#번호`(과목 안 번호 1..k), 정원 기본 34 |
| 칸 | (과목, 블록). 한 블록에 같은 과목 분반이 여럿이면 한 칸에 분반 여러 개 |
| 이동 / 학급 단위 | 과목마다 선택. 학급 단위 과목은 블록 계산에서 빠지고 담임반 → 과목 배정만 한다 |

## 2. 저장 데이터 (2차에서 state에 추가)

```js
state.classSections = {
  settings: {                       // 학년도 공통(차수와 무관)
    teachers: [{ id, name, alias, departments: ["물리"], courses: ["물리학"], maxHours,
                 unavailable: [{ day: "월", period: 1, reason: "육아시간" }] }],
    rooms: { "과학실": 3 },          // 특별실 종류 → 수
    fixedSlots: [{ label: "창체", times: [{ day: "금", period: 6 }, { day: "금", period: 7 }], teacherIds: [...] }],
    courseModes: { "<과목key>": "class" },        // 기본 이동
    courseRooms: { "<과목key>": "과학실" }, courseDepartments: { "<과목key>": "물리" } // 비면 5단계 hoursDefaultDepartment
  },
  "<차수>": { "<현학년>:<학기>": {
    version: 1,
    inputSignature,                 // classSectionsSignature(입력) — 다르면 '입력 변경됨, 재계산 필요'
    draft: true,                    // 차수 확정 전 시안
    blocks: [{ id: "a", maxSections: 11, times: [{ day, period }] }],
    maxSectionsPerBlock: 11, defaultCapacity: 34,
    classCounts: { "<과목key>": 3 }, // 6단계 값(4단계 확정 classCount를 출발값으로 보여 주고 따로 저장, 다르면 표시)
    capacities: { "<분반id>": 35 }, // 분반별 정원(기본과 다를 때만)
    mode: "move" | "homeroom" | "balance", seed: 1,
    pins: { sections: { "<분반id>": "a" }, students: { "1-3-12": ["물리학#2"] }, teachers: { "<분반id>": "<교사id>" } },
    result: {                       // classSectionsSolve 결과에서 저장할 것만
      sections: [{ id, courseKey, blockId, capacity, teacherId }],
      assign: { "1-3-12": ["물리학#2", ...] },   // 학생 키는 '현학년-반-번호', 성명 없음
      unassigned: [{ studentKey, courseKey, reason }], metrics, createdAt
    },
    classUnit: { "<묶음 이름>": { assign: { "<담임반>": "<과목key>" } } }
  } }
};
```

- 4단계 `state.roundStatuses[r].snapshot.rows[].classCount`는 읽기만 한다.
- `workspacePayload`·백업(`backupVersion` 하위 호환: 없으면 빈 객체)·`WORKSPACE_STORE_SPLIT_KEYS`에 `classSections` 추가.
- 바뀌는 입력: 학생 신청(차수 결과), 분반 수, 정원, 블록 수·상한·시간, 교사·불가 시간, 고정. 서명이 저장값과 다르면 결과는 지우지 않고 '입력 변경됨' 배지 + 부분 재계산 단추.

## 3. 계산 입력 (`classSectionsSolve(input)`)

```js
{
  groupId, label, grade, targetGrade, semester,
  blocks: 3 | [{ id, label, maxSections, times: [{ day, period }] | ["월1"] }],
  maxSectionsPerBlock: 11, defaultCapacity: 34, capacities: { "<분반id>": 35 },
  courses: [{ key, name, sections, capacity, capacities: [], department, room, credits, family, mode: "move" | "class" }],
  sections: [{ id, courseKey, capacity, blockId, fixed }],        // 선택: 분반을 직접 줄 때
  students: [{ key: "1-3-12", homeroom: "3", courses: ["물리학", ...] }],
  pins: { sections: { id: blockId }, students: { key: [sectionId] }, teachers: { id: teacherId } },
  teachers: [...], departmentTeachers: { "물리": 3 },             // 교사 목록이 없으면 교과별 수만으로 블록 제한
  rooms: { "과학실": 3 }, occupied: [...], fixedSlots: [...],      // occupied = 다른 학년 블록이 쓰는 교사·교실(시간 포함)
  mode, seed, previous: { sections: [{ id, blockId }], assign, teacherOf }, partial, changedStudents,
  timeLimitMs: 20000, suggest: true
}
```

## 4. 알고리즘

학생은 고른 과목 m개(≤ 블록 수)를 서로 다른 블록에서 들어야 한다. 이것은 '과목 → 블록' 단사 함수를 학생마다 고르는 문제이고, 블록이 여럿이면 하나의 유량 문제로 풀리지 않는다. 그래서 세 층으로 나눈다.

1. **블록 배치(분반 → 블록)**
   - 시작: 분반이 적은 과목부터, 같이 신청한 학생이 많은 과목이 이미 있는 블록을 피하고(공출현 행렬), 같은 과목 분반은 서로 다른 블록에 흩뜨린다. 고정 분반·이전 배치 블록을 먼저 둔다.
   - 제약(어기면 그 이동은 하지 않음): 블록당 최대 분반 수, 교과별 '그 블록 시간에 비어 있는 교사 수'(불가 시간·고정 시간·다른 학년의 겹치는 블록에서 쓰는 수를 뺌), 특별실 수.
   - 개선: 학생 배정(2)의 넘침 수 + 블록이 없어 못 듣는 학생 수를 평가값으로, 넘친 칸을 겨냥한 이동(그 과목 분반을 넘친 블록으로, 같이 듣는 과목 분반을 빼내기)·교환과 무작위 이동. 좋아지거나 같으면 받아들인다(같을 때 일부 확률).
2. **학생 배정(과목 → 블록)**: 같은 조합(·담임반·고정·기존 배정)의 학생을 한 단위로 묶고, 단위마다 가능한 순열(블록 단사)별 인원을 정한다.
   - 비용 = 1000 × 정원 넘침 + 균형(칸 인원² / 분반 수) + 담임반 흩어짐(같은 반·같은 과목이 쓰는 블록 수) + 기존 배정에서 바뀐 과목 수.
   - 탐욕 시작 후 담금질 지역 탐색(넘친 칸의 학생을 우선 옮김, 넘침이 같고 다른 칸으로 옮기는 이동도 받아 사슬처럼 풀림).
   - 모든 과목을 서로 다른 블록에 넣을 수 없는 학생은 되도록 많은 과목만 넣고 나머지는 미배정(reason `no-block`).
3. **칸 안 분반 나누기**: 한 블록에 같은 과목 분반이 여럿이면 최소 비용 유량(고정 > 기존 분반 > 담임반 묶음 순으로 비용 0)으로 균등 인원(담임반 모드는 +2까지)에 나눈다. 넘치면 미배정(reason `capacity`).
4. **교사 배정 추천**: 자격(담당 과목 또는 교과) + 불가 시간 + 같은 블록·같은 시각 겹침(학년 간 포함) + 시수 균형. 고정 먼저, 후보가 적은 분반부터 탐욕, 막히면 막고 있는 분반 하나를 다른 교사에게 넘기는 한 단계 교체. 블록 시간이 없으면 시간 점검은 건너뛰고 안내(`no-times`).
5. **여러 그룹(`classSectionsSolveAll`)**: 학기 순으로 풀며 앞 그룹 블록의 교과·특별실 사용량을 시간이 겹치는 뒤 그룹 블록에서 뺀다. 순서에 따라 결과가 달라지므로(블록 시간과 교사·특별실 제한이 있을 때) 여러 순서(입력 순서·거꾸로·교사 수가 빠듯한 그룹 먼저·나중)를 모두 풀고 (미배정 → 교사 불가·겹침·부족 위반 → 분반 인원 차이) 순으로 가장 좋은 것을 고른다(`orders`, `chosenOrder`). 교사는 모든 그룹을 함께 배정(막고 있는 분반을 다른 교사에게 넘기는 증가 경로 교환, 깊이 3)하고 `classSectionsValidateAcross`로 같은 시각 두 분반을 잡는다. 교사가 모자라면 `classSectionsTeacherShortages`가 "지구: 월요일 1교시 분반 2개(2학년 1학기 a블록 1, 3학년 1학기 a블록 1) > 가능한 교사 1명 → 1명 모자람"처럼 설명한다.
6. **블록 시간 추천(`classSectionsRecommendTimes`)**: 한 주 격자(기본 월~금 × 7교시, 설정)에서 고정 시간(창체·진로 등)을 빼고, 학년·학기 블록마다 블록 시수(= 과목 학점)만큼 칸을 고른다. 같은 학년 블록끼리 겹치지 않음(필수), 비용 = 1000 × (같은 시각 같은 교과 분반 합 − 그 시각 가능한 교사 수, 불가 시간·고정 시간 반영) + 50 × 블록이 같은 날 두 번 + 학년별 요일 몰림(시간²). 학년별 '공통 과목용 남길 시간'이 모자라면 경고. 탐욕 시작 + 이동·맞바꾸기 담금질(시드 고정). 요일·교시 전체 시간표는 만들지 않는다.

정수계획(wasm) 대신 이 방식을 쓴 이유: file://에서 wasm 로딩 제약과 용량. 총괄의 HiGHS 기준해와 비교해 부족하면 2차에서 탐색 예산·이동 종류를 늘린다.

**재현성**: 난수는 `seed`로 고정, 탐색 예산은 반복 횟수(`placementSteps`, `evalIterations`, `finalIterations`, 기본값은 학생·분반 수로 정함). `timeLimitMs`는 안전장치이며 걸리면 `stats.timedOut`(이때는 재현성이 보장되지 않음).

**고정·부분 재계산**: `pins.sections`(분반 → 블록), `pins.students`(학생 → 분반), `pins.teachers`(분반 → 교사)는 반드시 지킨다(정원을 넘겨도 지키고 검증기가 알림). `partial: true` + `previous`면 블록 배치는 그대로 두고, `changedStudents`(없으면 `classSectionsChangedStudents(이전 학생, 지금 학생)`로 구함)에 없는 학생은 기존 분반에 고정, 바뀐 학생만 새로 넣는다.

## 5. 검증기 `classSectionsValidate(input, result)`

계산 과정과 독립적으로 결과만 다시 센다.

| type | 뜻 |
|---|---|
| `unassigned` | 미배정(학생 수·과목 수) |
| `missing` / `duplicate` / `not-chosen` | 배정도 미배정 기록도 없음 / 같은 과목 두 번 / 신청 안 한 과목 |
| `block-conflict` | 한 학생이 한 블록에 두 과목 |
| `over-capacity` | 분반 인원 > 정원 |
| `block-over` | 블록 분반 수 > 최대 |
| `teacher-count` / `room-count` | 블록의 교과 분반 수 > 그 시간 가능한 교사 수 / 특별실 수 |
| `teacher-unavailable` / `teacher-double` / `teacher-cross` | 불가 시간 배정 / 같은 블록 두 분반 / 학년 간 같은 시각 겹침 |
| `teacher-missing` | 그 시간에 맡을 교사 없음 |
| `spread` (경고) | 같은 과목 분반 인원 차이 > 기준(기본 4명, 입력 `spreadWarn`) |
| `no-times` (안내) | 블록 시간이 없어 교사 시간 점검 생략 |

## 6. 설명·제안

- 판정: 미배정이 없어도 오류 이슈(블록 한도 초과·억지 배치·교사 불가 시간 등)가 있으면 `explain.feasible: false`, summary에 원인('블록 한도 초과: 분반 34개 > …').
- 원인(`explain.causes`): 과목 신청 > 분반 정원 합(`course-capacity`), 분반 수 > 블록 수 × 상한(`block-limit`), 폐강 과목 신청(`closed`), 블록 수보다 많은 신청(`too-many`), 같은 블록에만 열린 두 과목(`no-block`, 과목 쌍과 학생 수), 칸 정원 부족(`cell-capacity`).
- 제안(`explain.suggestions`, 모두 실제로 다시 풀어 확인한 것만 `verified: true`):
  1. 같은 배치에서 넘친 칸의 분반만 1명씩 올려 보며(최대 +2) 모두 배정되는 최소 목록 → "a블록 사회와 문화 2개 분반을 35명으로 올리면 모두 배정됩니다."
  2. 1이 안 되면 모든 분반 +1로 배치를 다시 찾고 그 배치에서 1을 반복(`source: "new-placement"`, 블록 배치도 바뀜).
  3. 블록당 최대 분반 +1이면 지금 정원으로 되는지.
  4. 분반 수 > 블록 수 × 상한이면(정원 올리기로는 안 풀림): 정원을 35(안 되면 36)명으로 올려 분반 수가 줄어드는 과목을 골라 다시 풀어 확인(`type: "sections"`, 예 "화학 정원 35명(분반 6→5개)으로 바꾸면 …") + 블록당 최대를 ceil(분반/블록)으로 늘리면 되는지.
- 34명으로 '불가능'은 증명이 아니라 '찾지 못함'으로 표시한다(과목 정원 합 부족 같은 구조적 원인만 확정).

## 7. 편성 방식 비교 `classSectionsCompare(input)`

같은 블록 배치에서 학생 배정만 방식별로 다시 해 비교한다.

| 방식 | 가중치(균형/담임반/유지) |
|---|---|
| 완전 이동 `move` | 1 / 0 / 4 |
| 같은 담임반끼리 묶기 우선 `homeroom` | 0.4 / 6 / 4, 칸 안 분반 인원 +2 허용 |
| 분반 인원 균형 `balance` | 5 / 0 / 4 |

지표: 미배정, 분반 인원 차이(최대·평균), 같은 반끼리 비율(과목·담임반마다 가장 많은 분반에 모인 비율), 기존 배정 대비 옮긴 과목 수. 추천: 미배정이 가장 적은 방식 중 — 담임반 방식이 같은 반 비율을 10%p 이상 올리고 인원 차이가 3명 이상 늘지 않으면 담임반, 아니면 균형 방식이 인원 차이를 줄이면 균형, 아니면 완전 이동. 기존 배정이 있고 옮긴 수가 20건 넘게 차이나면 가장 적게 옮기는 방식. 추천 이유 문장을 함께 돌려준다. 성비·성적 균형은 자료가 없어 나중.

## 8. 학급 단위 과목 `classSectionsClassUnitSplit`

`{ courses: [{ key, sections(맡을 학급 수) }], homerooms: [{ id, size }], students? }` → 담임반 → 과목. 신청이 있으면 희망과 다른 학생이 가장 적게(최소 비용 유량), 없으면 반 번호 순서대로(예 8:3 → 1~8반 일본어, 9~11반 정보). 학급 수 합이 담임반 수와 다르면 비율로 맞추고 경고. 이동 계산(`classSectionsSolve`)에서는 `mode: "class"` 과목을 빼고 블록 수도 이동 과목만으로 센다.

## 9. 나이스 수강학생 편성 내보내기 (함수 하나로 분리)

`classSectionsNeisRows(result, { year, semester, targetGrade, courses: { key: { family, credits } }, students: [{ key, classroom, number, name }] })` → 2줄 머리글 + 학생·과목마다 한 줄.

| 열 | 값 |
|---|---|
| 학년도 · 학기 | 다음 학년도 · 학기 |
| 학년 | 수업 듣는 학년(N+1) |
| 편제명 | 교과(군) — 편제표 `family`(예 '사회(역사/도덕포함)') |
| 개설과목(학점) | `과목명(학점)`, 공동교육과정은 `(공동)` 머리(부르는 쪽) |
| 개설강의실 | `블록문자 + 과목명(띄어쓰기 없앰) + 번호` — `classSectionsAssignRoomNames`. **어느 블록에서든 그 과목 분반이 2개 이상이면 그 과목의 모든 분반에 번호, 한 번도 없으면 번호 없음.** 번호는 교사가 모두 배정돼 있으면 과목 안 교사 순번(같은 교사 = 같은 번호, 한 블록에서 겹치지 않을 때), 아니면 블록 안 순번. 사용자 나이스 파일(물리학 a1·a2·b2·c1, 세계사 a·b·c)에서 추정한 규칙 — **확인 필요**. 학급 단위·공통은 `1(2학년 1반)` |
| 계열/학년/학과 | `N학년` |
| 반 · 번호 | 내년 반·번호. 모르면 빈칸 + 오른쪽 참고 열 `참고: 현 학년-반-번호`와 경고(`classSectionsNeisExport` → `{ rows, warnings }`). 내년 반 배정표(고정 양식: 현 학년·현 반·현 번호·새 반·새 번호, `classSectionsClassMapFromRows`)를 올리면 채움 |
| 성명 | 계산 결과에는 없음. 내보낼 때 화면에서 지금 명단으로 채움(저장하지 않음) |

**확인 필요**: (1) 받은 파일은 나이스 '조회' 출력이라 실제 업로드 양식은 다를 수 있음, (2) 강의실 번호의 교사 순번 해석.

## 10. 6단계 화면 (2차 구현: `class-sections-view.js`)

내부 단계 번호 8, 메뉴 '6. 분반 편성'. 예전 보류 메뉴 '이동수업 반편성'은 '이동수업 과목 분류 (보류)'로 이름을 바꿨다.
화면 예(합성 자료): `docs/class-sections-screens/*.png`. 클릭 확인 스크립트: `e2e/class-sections-ui.cjs`.

- 머리: 차수 고르기(기본 = 가장 최근 확정 차수, 확정 전 차수는 '확정 전 시안'), `교사·시간 설정`.
- 그룹 단추(현학년 → 학년 학기 · 그룹, 학생 수·과목 수·택n, 미편성/편성됨/확인 필요). 그룹 = 4단계 집계의 (학년, 학기, 택n 그룹).
- 표시: '확정 전 시안', '입력 변경됨, 재계산 필요'(입력 서명이 저장 결과와 다를 때).
- 기준: 기본 정원(4단계 학급당 최대 인원), 블록 수(택n), 블록당 최대 분반(내년 학급 수), 편성 방식. '블록별로 다르게 · 블록 시간'(블록별 최대·요일·교시 `월1,수2`).
- 과목 표: 신청, 4단계 분반(확정 스냅샷), 6단계 분반(따로 저장, 다르면 '4단계와 다름'), 분반별 정원(`34,35`), 이동/학급 단위, 담당 교과(5단계 교과 목록), 특별실.
- 단추: `편성 계산`(새로 계산, 기존 결과는 '기존 대비 이동' 비교만), `방식 비교·추천`(3방식 표 + 추천 이유 + `이 방식으로 편성`), `바뀐 학생만 다시 계산`(배치·기존 배정 유지).
- 결과: 요약(가능/원인), 원인·제안(`제안 적용` → 정원·분반 수·블록 한도를 바꾸고 다시 계산), 오류·확인 목록, 블록별 분반 카드(강의실 이름·인원/정원·담당 교사 고르기(고정)·`고정`(블록 고정)), 미배정 표, 학생 찾기(현학년-반-번호).
- 학급 단위 과목: 담임반 → 과목 표(추천 비율·희망과 다른 학생 수, 직접 바꾸기, `추천으로 되돌리기`).
- 내보내기: `블록표 엑셀`, `분반 명렬표 엑셀`(분반마다 시트, 성명은 차수 자료에서), `나이스 편성 엑셀`(+ '확인 필요' 시트), `내년 반 배정표 양식`, `내년 반 배정표 올리기`(메모리에만, 저장 안 함).
- 교사·시간 설정 창: 교사(이름·별칭·교과·과목 좁히기·불가 시간 격자·사유·삭제, `교사 추가`, `5단계 교사 수로 명단 만들기`), 고정 시간(`창체·진로 금 6·7교시 넣기`, 모든 교사), 특별실 수(`과학실=3`), 분반 인원 차이 경고 기준, '교사 명단이 없으면 5단계 교과별 교사 수로 블록 제한'.
- 학년별 '진급 때 반 편성'(그대로 올라감 / 새로 편성 / 아직 모름, `settings.promotion[현학년]`): 학급 수가 바뀌면 '새로 편성'으로 고정(그대로 올라감은 고를 수 없고 이유 표시), 같으면 기본 '아직 모름'. '그대로 올라감'이면 지금 반 = 내년 반으로 보고 담임반 묶기(추천 대상)·학급 단위 학생 배정·나이스 반을 정한다. 나이스 번호는 비운다 — 반이 그대로여도 진급 때 번호를 다시 매기는 경우가 많고, 틀린 번호로 올리면 다른 학생에게 잘못 편성돼도 알아채기 어렵지만 빈칸은 올리기 전에 드러나기 때문. 배정표를 올리면 그것이 우선.
- 진급 때 반이 바뀔 수 있음(바뀌는 해도, 그대로인 해도 있음; 예 현1 10학급 → 내년 2학년 11학급): 블록당 최대 분반·학급 단위 반 수 기본값은 내년 학급 수(4단계 기준·확정 스냅샷 `classBases`), 화면에 "현 1학년 10학급 → 내년 2학년 11학급". 내년 반 배정표(`state.classSections.classMaps[현학년]` = { 학생키: {classroom, number} }, 성명 없음)가 있으면 '같은 담임반끼리 묶기'·학급 단위 과목 학생 배정·나이스 반·번호·학급 단위 개설강의실 'N(2학년 N반)'을 새 반 기준으로 한다. 없으면 담임반 묶기는 지금 반 기준 경고 + 추천 제외(`recommendExclude`), 학급 단위 과목은 '과목별 반 수만 확정, 학생 배정은 반 배정표를 올린 뒤'(오류 아님).
- 블록 시간 추천: '블록별로 다르게' 안의 `블록 시간 추천` → 같은 학기 모든 학년 그룹 블록의 추천안 표(칸 고치기 가능, 교사 부족·남는 칸 표시) → `추천 적용`(각 그룹 블록 시간에 씀) / `추천 닫기`. 블록별 교과 분반 수는 편성 결과가 있으면 그 블록, 없으면 과목 분반을 블록에 고르게 나눈 추정. 격자(요일·하루 교시 수)와 학년별 공통 과목용 남길 시간은 교사·시간 설정 창에서.
- 다른 학년 겹침: 그룹 하나만 계산할 때는 같은 차수·학기 다른 그룹의 저장 결과(블록 시간·교사)를 `occupied`로 넘긴다(먼저 편성한 그룹이 우선). `전 학년 함께 다시 계산`은 같은 차수·학기 그룹 전부를 화면 순서(학기·학년·그룹)로 `classSectionsSolveAll`에 넘겨 교사를 함께 배정한다(누른 그룹과 무관하게 같은 결과).
- 담당 교과 기본값·나이스 편제명: 편제표 교과(군)(`collectApplicationSubjects`의 area)을 넘겨 `hoursDefaultDepartment(과목, 교과군)` → '사회와 문화'가 '사회(일반사회)'. 나이스 편제명은 편제표 교과(군)(띄어쓰기 없앰, 예 '사회(역사/도덕포함)') 우선, 없으면 담당 교과에서 추정.
- 학급 단위로 바꾼 과목이 있으면 블록 수 기본값 = 택n − (학생이 고른 학급 단위 과목 수의 최댓값), 안내 문구 표시. 직접 입력하면 그 값.
- 방식 비교 '앞 편성 대비 이동': 앞 편성 결과가 없으면 '–'(지표 `moved: null`).
- 계산은 Worker(Blob URL, `classSectionsWorkerSource`), 실패하면 메인 스레드.

## 11. app.js 등 공용 수정 (2차에 한 것)

- `workflowStepLabel`·`switchWorkflowStep` 허용 목록·복원 보정·`workflowStepStates`에 단계 8, `deferRenderUntilStepVisible(8, "renderClassSections", …)`, 보류 '이동수업 반편성' 이름 정리.
- `workspacePayload`·`restorePersistedState`·백업(`backupVersion`)·`WORKSPACE_STORE_SPLIT_KEYS`에 `classSections`.
- `index.html`: `class-sections.js`(app.js 앞), `class-sections-view.js`(app.js 뒤), 6단계 패널.
- `scripts/build-deploy.js`·`tests/project-integrity.test.cjs` 파일 목록.
- Worker: `classSectionsWorkerSource()`로 Blob URL 생성(실패 시 메인 스레드 폴백). 화면은 `cachedByStateRevision`·`persistStateSoon`·`preserveViewDuring`.

## 12. 총괄 검토용 호출 (조합-인원 입력)

```sh
node -e 'const cs=require("./class-sections.js");const combos=JSON.parse(require("fs").readFileSync(process.argv[1]));const r=cs.classSectionsSolve(cs.classSectionsFromCombos({subjects:combos.subjects,choose:combos.choose,combos:combos.combos,capacity:35,maxSectionsPerBlock:11,sections:combos.sections}));console.log(r.metrics.blockSections,r.unassigned.length,r.elapsedMs+"ms",r.explain.summary,JSON.stringify(r.explain.suggestions))' combos.json
```

`combos.json` = `{ "subjects": [...], "choose": 3, "combos": { "과목A|과목B|과목C": 인원 }, "sections": { "과목A": 4 } }` (`sections`가 없으면 `ceil(신청/capacity)`). 교과별 교사 수 상한은 `departmentTeachers`·`departments`(과목 → 교과)를 함께 넘긴다.

## 13. 6·7차 보완

- 입력 서명(`classSectionsSignature`)은 사용자 입력만: 다른 학년 편성 결과에서 온 `occupied`·같은 학생 그룹 시간 `cohortTimes`는 넣지 않는다. 다른 학년 편성이 이 결과보다 나중에 따로 바뀌면 `#classSectionsOtherChanged` 안내(함께 계산은 같은 `batch`라 안내 없음).
- 학생 키 정규화 `classSectionsStudentKey`/`classSectionsKeyPart`(앞 0·'반'/'번' 제거): 그룹 자료·배정표·이름·명렬표·나이스가 함께 쓴다. 배정표는 학년별로 **합치기**(파일에 있는 학생만 갱신, "갱신 n명 · 유지 m명", 명단에 없는 학생 수 경고), `배정표 지우기`.
- 학급 단위 과목: 나이스 행·배정표 양식은 그 현 학년 학생 전체. 새 반 번호도 정규화, 과목이 정해지지 않은 반은 경고. 블록표·분반 명렬표에 '학급 단위 과목' 시트(맨 뒤, 내년 반 → 과목·반별 학생 수). 내년 반을 모르면 나이스 '확인 필요' 시트에 "n명분 행은 반 배정표를 올린 뒤 생성".
- 과목 운영·담당 교과·특별실은 현 학년별(`settings.courseModes[현학년][과목]` 등, 예전 값은 모든 학년에 복사해 옮김). 교사 id 중복은 다시 매기고 경고.
- 같은 현 학년·학기 그룹끼리 블록 시간이 겹치면 `cohort-clash` 오류(그룹 하나 계산은 다른 그룹의 입력 블록 시간 `cohortTimes`, 함께 계산은 `classSectionsValidateAcross`).
- 폐강 과목 신청은 `closedRequests`(재신청 대상)로 따로 세고 편성 가능 여부·미배정에서 뺀다.
- 교사 부족 제안: `블록 늘리기`·`학급 단위로 운영`(다시 풀어 확인되면 `제안 적용`), `블록 시간 추천 실행`, 교사 명단·5단계 교사 수 확인 안내.
- 결과 머리글: 시안으로 계산 뒤 차수를 확정했고 입력이 같으면 '확정 결과 기준(시안 때 계산 · 입력 같음)'. 오류만 있고 미배정이 없으면 요약은 '학생은 모두 배정했지만 확인 필요 — …'.
- 분반 카드 `li.cs-section`에 `data-room`(나이스 강의실 이름)·`data-course`·`data-size`·`data-capacity`.

## 14. 출력물: 교실 배정·이동 출석부·학생 시간표 (`class-sections-print.js`)

- **교실 배정**(`class-sections.js` 끝 '교실 배정' 구간, 순수·결정적): `classSectionsRoomList`(학년 교실 '2-1'… = 내년 학급 수, 특별실 `settings.rooms` + 이름 `settings.roomNames`, 다른 교실 `settings.extraRooms`) → `classSectionsAssignRooms`(블록마다 최소 비용 매칭: 비용 = 100 × (분반 인원 − 그 내년 반 학생 수), 특별실 과목은 그 종류 특별실, 모자라면 일반 교실(경고)·다른 교실, 그래도 모자라면 `room-short` 원인 문장; 직접 고른 교실 먼저, 같은 그룹은 같은 블록끼리, 다른 그룹은 블록 시간이 겹칠 때 같은 교실 금지; 시간이 없으면 다른 학년 특별실 겹침은 안내만) → `classSectionsValidateRooms`(`room-double`·`room-cross`·`special-mismatch`·`room-grade`·`room-missing`).
- 저장: 직접 고른 교실만 `sectionResult.roomPins`(분반 id → 교실 이름). 자동 배정은 매번 같은 결과로 다시 계산(`classSectionsRoomPlan(차수, 학기)`, `cachedByStateRevision`). 다시 편성하면 직접 고른 값은 사라진다.
- 화면: 분반 카드 '교실' 고르기(`data-cs-room-pick`), 블록 아래 `#classSectionsRoomSummary`(`data-errors`)·`#classSectionsRoomErrors`·`교실 자동으로 되돌리기`(`#classSectionsRoomReset`), 교사·시간 설정 `#classSectionsRoomSettings`. 블록표 엑셀 끝 열 '교실'.
- **이동 출석부**: `classSectionsAttendanceSheet`(위 교시·교실·교사, 제목 '과목(강의실) 출석부', 순서·학년·반·번호·성명 + 날짜 칸(기본 17, `settings.print.attendanceDays`) + 비고, A4 세로·한 장·제목 줄 반복 `printTitles`). 내년 반을 모르면 현 학년-반-번호 + 경고. 단추 `#classSectionsAttendanceGroup`(그룹 = 파일, 분반마다 시트)·`#classSectionsAttendanceTeacher`(같은 학기 모든 그룹, 교사마다 파일 zip)·`#classSectionsAttendanceAll`(분반마다 '2027_1학기_과목(강의실)_교실_교사.xlsx' zip, `createXlsxBlob` 재사용).
- **이동 출석부 보기·저장·인쇄**(사용자 결정: 웹앱에서 조회, 전체 파일 또는 학급별 파일로 저장, 출력): `#classSectionsAttendanceView`(접힘 영역) — 범위 `#classSectionsAttendanceScope`(이 그룹 / 학기 전체), 분반 `#classSectionsAttendancePick`(값 `그룹키|분반id`), `#classSectionsAttendancePrev`/`Next`, 표 `#classSectionsAttendanceTable`(엑셀과 같은 시트 모델 → `classSectionsSheetHtml`, 학생 줄 `tr[data-student]`, 찾은 학생 `.is-found`), 학생 찾기 칸과 연결(`#classSectionsAttendanceStudent`), 그 과목 재신청·미배정 안내 `#classSectionsAttendanceRetake[data-count]`. 저장 묶음은 `CLASS_SECTIONS_ATTENDANCE_BUNDLES`(종류마다 함수 하나: `file` 전체 파일 = '목록' + 분반마다 시트(시트 이름 = 강의실 이름, 학년 사이 겹치면 '3학년 b화학'), `sections` 학급별 파일 zip, `teacher` 교사별 zip, `group` 이 그룹 파일 — 담임반별 묶음은 여기에 한 줄 더하면 됨). 단추 `#classSectionsAttendanceFile`·`All`·`Teacher`·`Group`. 인쇄 `#classSectionsAttendancePrintOne`·`PrintGroup`·`PrintSemester` → `#printBatch .print-page.cs-att-page`(분반마다 A4 세로 한 장, 머리글 줄은 thead라 넘치면 반복).
- **담임학급별 출석부**(사용자 결정: 분반별·담임학급별 둘 다): `classSectionsHomerooms(분반 info, 학생 명단, 학급 단위·재신청)` → 반마다 묶음. 기준 반은 내년 반(배정표·그대로 올라감), 모르면 현재 반('내년 반 미정 — 현재 반 기준' 경고). ① `classSectionsHomeroomStatusSheet` '이동수업 현황'(행 = 학생, 열 = 그룹·블록·시간, 칸 = '과목 강의실 / 교실 · 교사', 학급 단위·재신청·미배정 열, A4 가로 한 장) ② `classSectionsHomeroomAttendanceSheets` 그 반 학생만 추린 분반 출석부(같은 양식, 부제 '○반 학생만 n/전체 m명'). 저장 `CLASS_SECTIONS_ATTENDANCE_BUNDLES.homeroom`(반마다 파일 ①+② zip, `#classSectionsAttendanceHomeroom`)·`homeroomFile`(목록 + 반마다 ①, `#classSectionsAttendanceHomeroomFile`). 화면 범위 '담임반별' → `#classSectionsHomeroomPick`(값 = 반 id)·`#classSectionsHomeroomTable`·`#classSectionsHomeroomBasis`·`#classSectionsHomeroomRetake`, 인쇄 `#classSectionsHomeroomPrintOne`·`#classSectionsHomeroomPrintGrade` → `.print-page.cs-hr-page`(`@page cs-landscape`, A4 가로) + 그 반 `.cs-att-page`. '학급별 파일'은 '분반별 파일'로 이름을 바꿈.
- **담임용 현황 인쇄: 읽을 수 있는 글자 + 두 장**(사용자 결정): 칸 내용은 그대로, 인쇄 칸 글자 12px(9pt), A4 가로. `classSectionsHomeroomStatusLayout`이 열 폭(블록 열은 남는 폭을 나눠 10~40, 전체 160 이하 = 엑셀 90% 배율 안)과 칸 줄 수(한글 1.95·그 밖 1.1·띄어쓰기 0.6 폭 단위)를 어림하고, `classSectionsHomeroomStatusPlan`이 학생을 번호순 고르게 나누되 쪽 수는 쪽마다 학생 줄 높이 합(칸 줄 수마다 따로)이 (쪽 높이 − 제목·부제·안내·머리글)에 들어가는 가장 적은 수(31명 → 16 + 15, 칸이 두 줄이면 한 쪽 19명 → 38명까지 두 장, 적으면 한 장). 블록 열이 많아 접히면 세 장, 그래도 안 되면 글자를 줄이지 않고 더 나누고 `overflow`로 상태 줄에 알림. 인쇄 `classSectionsHomeroomStatusPages` = 쪽마다 `.cs-hr-page`(제목·부제·머리글 반복, 오른쪽 위 `.cs-hr-pageno` '1/2'). 엑셀(반 파일·전체 파일)은 나누지 않은 시트에 같은 자리 수동 쪽 나눔(`rowBreaks`) + 배율(`scale` 90~100, 쪽 맞춤은 수동 나눔을 무시하므로 끔) + 머리글 행 반복 + 머리글 '&P/&N'(`createWorkbookBlob`의 `scale`·`rowBreaks`·`headerText`). 학급 단위·재신청 열은 그 반에 값이 없으면 폭 7.5('학급\n단위'·'재신청\n미배정').
- **한 학기 현황은 두 장 안**(사용자 결정 '담임용은 두 장', 3학년 택5 + 택1처럼 블록 열이 많을 때): `classSectionsHomeroomStatusChoose`가 단계 `CLASS_SECTIONS_HR_MODES`를 차례로 — 1) 9pt 두 줄 칸 → 2) 9pt 한 줄 칸 '과목 · 교실'(교실 '3학년 11반' → '3-11', 강의실 이름·교사는 빼고 표 아래 범례 '강의실(과목 전체 이름, 교실) → 선생님'을 분반마다 한 번, 마지막 쪽에만) → 3) 한 줄 칸 8pt(이때만 칸에 안 들어가는 과목은 5단계 약칭 `hoursShortSubject`, 범례는 전체 이름) → 4) 그래도 두 장을 넘으면 8pt 그대로 더 나누고 상태 줄에 '세 쪽 이상: 반 이름'. 두 장 안에 드는 첫 단계를 쓴다. 인쇄는 단계마다 화면 밖 상자(`.cs-hr-measure[data-font]`)에서 재고, 인쇄 쪽 `.cs-hr-page[data-level][data-font]`(8pt = 10.67px). 엑셀도 같은 단계 규칙을 어림으로(열 폭 상한 9pt 160·8pt 180, 배율 9pt 90%·8pt 80% 이상, 범례는 표 폭 병합 행) — 엑셀 쪽 수 ≥ 인쇄 쪽 수. 화면 표는 늘 1단계. 상태 줄에 '두 장에 맞추려고 한 줄 칸 9pt n개 반'.
- **학생 배부용 '이동수업 안내' 쪽지**(사용자 결정): 학생 한 명에 쪽지 하나, 1·2학기 함께. `classSectionsHandoutSlips([{semester, homeroom}])`(담임반 묶음을 학기마다, 명단·내년 반·미제출은 담임반 규칙 그대로) → 머리 'YYYY학년도 이동수업 안내', '현 1학년 1반 11번 성명 → 내년 2학년 1반 3번'(모르면 '내년 반 미정', 그대로 올라감은 번호 없이) + 표 학기 | 블록(요일·교시) | 과목(강의실은 과목 칸 아래 작은 회색 글씨) | 교실 | 선생님(학기는 rowspan, 한 학기에 그룹이 둘 이상이면 블록 칸에 그룹 표시 '택3 a블록'·'택1 a블록'(`classSectionsHandoutGroupLabels`, 짧은 표시가 겹치면 그룹 이름 그대로), 학급 단위는 '학급 단위(우리 반 교실)' 한 줄, 재신청은 굵게 '재신청 필요(사유)'), 미제출은 표 대신 '수강신청 미제출 — 담임 선생님께 확인하세요', 아래 작은 글씨 '교실·시간은 바뀔 수 있습니다…'. A4 세로에 2·4·6장(기본 4, `settings.print.handoutPer`), `classSectionsHandoutLayout`이 1열/2열 중 글자를 크게 쓸 수 있는 쪽과 글자(0.5pt 단위)를 고름 — 앱은 화면 밖 상자에서 어림 높이가 큰 쪽지 6개를 실제로 재고(`classSectionsHandoutMeasurer`, 1mm 여유), 순수 테스트는 어림(`classSectionsHandoutHeight`). 8pt보다 작아지면 막고 안내(6장 → '4장이나 2장', 4장 → '2장'). 표는 `table-layout:fixed` + `CLASS_SECTIONS_HANDOUT_COLS`. 화면: 담임반 보기 아래 `#classSectionsHandout`(data-per·data-font·data-ok)·`#classSectionsHandoutPer`·`#classSectionsHandoutPrintOne`/`PrintGrade`·`#classSectionsHandoutBlocked`·인쇄 전 경고 `#classSectionsHandoutWarnings`·미리 보기 `#classSectionsHandoutPreview[data-student]`(학생 찾기에 있으면 그 학생, 아니면 첫 학생). 인쇄 `#printBatch .print-page.cs-ho-page`(grid, 쪽지마다 점선 = 자르는 선). 성명은 인쇄 때만 조회, 엑셀 없음.
- **학생 시간표**: `classSectionsStudentTimetable`(같은 현 학년·학기 모든 그룹 배정 → 요일×교시 격자, 칸 = 과목 분반·교실·교사, 고정 시간 = 그 이름, 빈칸 '비움/학급 수업', 시간 없으면 'a블록: …' 목록, 재신청·미배정 '재신청 필요', 학급 단위 과목). 학생 찾기 칸에 한 학생 키 → `#classSectionsTimetablePreview`, `#classSectionsTimetablePrint`(현 반 고르기, 한 장에 2~4명, `#printBatch`), `#classSectionsTimetableExcel`(반별 시트).
- **교실이 모자랄 때(사용자 결정: 교사가 고름)**: 학년 교실·특별실 매칭은 자동, 남는 분반은 다른 교실(`settings.extraRooms`)·다른 학년 교실에 자동으로 넣지 않고 '교실 선택 필요'로 남긴다. `classSectionsAssignRooms`의 `choices[그룹][분반]` = 그 시간에 비어 있는 다른 교실 → 다른 학년 교실 → 특별실(목록 순서, 결정적), 한 블록에 여럿이면 추천을 서로 다르게(`recommended`). `room-short` 문장은 '교실 n개가 모자랍니다 — 아래에서 교실을 고르세요'. 카드 `.cs-room.is-choose`(후보 선택 상자 + `data-cs-room-new` 새 교실 이름 → 다른 교실 목록에 더하고 고정). 특별실 과목이 특별실이 모자라 일반 교실로 가는 것은 그대로 자동 + 경고.
- **내보내기·인쇄 전 경고**(`classSectionsOutputWarnings` → 출력물 칸 맨 위 `#classSectionsOutputWarnings li[data-type=room|teacher]`, 누른 뒤 상태 줄 끝에도): 교실을 고르지 않은 분반 n개, 실제 이름이 아닌 교사(6단계 세션의 `classSectionsTeacherNameWarnings()`가 있을 때). 막지는 않는다.
- **학생 시간표 1·2학기 한 장**: `classSectionsStudentTimetableYear`(제목 '2027학년도 · 현 1학년 → 2학년 이동수업 시간표', 학기마다 `.cs-tt-sem[data-semester]` 격자, 그 학기 블록 시간이 없으면 목록, 재신청은 학기 표시). 한 장에 1명(기본, 위아래)·2명(학기 좌우), 엑셀도 학생마다 두 학기.
- 클릭 확인: `node e2e/class-sections-print-ui.cjs <폴더> <하네스 백업 .json.gz>`.

## 15. 시간표 준비(공통 교과 교사·학급 단위 그룹·시간표 미리 점검)
- **공통 교과 교사**: 공통 교과(`과학-공통`·`사회-공통`)에 따로 정한 교사가 없으면 `classSectionsCommonDepartmentFallback`이 세부 교과 교사를 대체 후보로 넣는다. 5단계 시수 설정의 공통 시수 배분 메모(`allocationNotes[세부 교과][학기]` = '통과8 · 융과4', `hoursShortSubject` 약칭 + 시수)가 그 과목을 어느 세부 교과에 줬는지 적혀 있으면(`classSectionsCommonMemoDepartments`) 그 세부 교과 교사의 담당 과목(`courses`)에 그 과목을 더하고, 메모가 없는 과목만 예전처럼 교과군 세부 교과 교사 모두(담당 교과에 공통). 학기·전 학년 함께 계산(`classSectionsSolveSemesterCurrent`)은 그룹마다 들어간 대체 교사를 교사 id별로 합쳐(`classSectionsJointTeachers`) 넘긴다 — 예전에는 첫 그룹 명단만 넘겨 다른 그룹 공통 과목 분반 교사가 비었다(버그).
- **학급 단위로만 운영되는 그룹**(개설 과목이 모두 학급 단위, `classSectionsClassUnitOnly`): 반마다 따로 하는 반 수업이라 블록 시간을 두지 않는다(입력 블록 times 없음, 저장된 칸 값은 무시, 다른 그룹 학년 겹침·점유에서 뺌, 블록 시간 추천·적용에서 뺌). 화면 블록 표 자리에 `#classSectionsClassUnitOnly` '반 수업(시간표에서 배치)'. 일부 반만 학급 단위인 그룹은 이동 분반이 있으니 그대로. 출력물: 학생 시간표 '반 수업(시간표에서 배치) · 학급 단위 과목: …', 쪽지 블록 칸 '반 수업'(출석부는 원래 이동 분반만).
- **시간표 미리 점검**(`classSectionsTimetablePrecheck`, 결과를 저장할 때 `classSectionsSaveResult`가 그 학년·학기로 계산해 `sectionResult.timetableCheck`에 붙임, 경고만): 블록 밖 빈 칸 = 주 교시(요일 × 교시) − 블록 시수(학급 단위 그룹 0, 블록마다 시간 칸 수 또는 이동 과목 최대 학점) − 고정 시간. 교과마다 그 학년 반 수업 시수(학급 단위 과목 반 수 × 학점) ÷ 교사 수(교사 명단, 없으면 5단계 교사 수)가 빈 칸보다 크면 경고 '최소 ⌈시수 ÷ 빈 칸⌉명'. 학교 지정 과목 반 수업은 6단계 자료에 없어 넣지 않음(7단계 시간표에서). 결과 카드 `#classSectionsTimetableCheck[data-count]`, 상태 줄 '시간표 미리 점검 경고 n건'.
