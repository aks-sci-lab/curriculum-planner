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
