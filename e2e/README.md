# 전과정 자동 테스트(e2e) 하네스

모의 서버 위에서 테스트봇으로 웹 수강신청을 넣고, 앱을 **사용자처럼 클릭**해 1→5단계를 진행하며 결과를 점검합니다.
실제 Supabase 서버에는 요청하지 않습니다(가로채지 못한 외부 요청은 막고 `report.json`의 `blockedRequests`에 남김).

```
npm ci                                   # @electric-sql/pglite (모의 서버)
node e2e/run.cjs --seed 1 --out /tmp/e2e-seed1
```
- Playwright·Chromium은 이 환경에 전역 설치된 것을 씁니다(하네스가 `npm root -g`에서 찾음).
- 옵션: `--seed n`(같은 시드 = 같은 결과) · `--classes 11` · `--perClass 30` · `--concurrency 1`(봇 동시 접속, 1이어야 시드 재현) · `--stopAfter 1|2|3|4` · `--headed` · `--explore 파일.cjs`(2단계 뒤 탐색 스크립트).
- 결과: `--out` 폴더에 `report.json`(단계별 통과/실패·문제 목록·시간·모의 서버 기록 요약·콘솔), 단계별 스크린샷, `downloads/`(코드·집계표·시수 엑셀·백업 JSON·봇 결과), 합성 편제표·명렬 엑셀. 가상 학생만 씁니다.

## 구성
- `lib/mock-supabase.cjs` — `supabase/*.sql` 체인 + `proposed/01·02`(앱이 쓰는 학생 잠금 RPC)를 PGlite에 올리고 Playwright `context.route`로 RPC·REST(`course_events` 목록)·auth(구글 PKCE 흉내: authorize → `?code=` 되돌림 → token)를 처리. 실시간 websocket은 닫음(앱은 30초 동기화로 넘어감).
- `lib/static-server.cjs` — 저장소를 `http://127.0.0.1`로 제공(file://는 앱이 오프라인으로 봄).
- `lib/plan-fixture.cjs` — 합성 2022 개정 편제표(학교 지정 + 2학년 학기별 택3·택1, 3학년 학기별 택5·택1, 교차집중 미술↔연극). 연도만 바꿔 2026·2025 입학생에 씀.
- `lib/harness.cjs` — 브라우저·기록·스크린샷. 테스트봇은 `Date.now()`로 난수 시드를 정하므로 하네스가 페이지에서 `TestBotCore.createRng`를 감싸 시드를 고정합니다(앱 코드는 그대로).
- `run.cjs` — 시나리오: 로그인 → 편제표 업로드 → 웹 방식·그룹 확인 → 학년별 명렬 업로드·신청 생성(자동 연동) → 테스트봇(인기 편중·틀린 코드 4%·위반 시도 10%·재제출 10%) → 마감 → 3단계 확인서 표본 대조 → 4단계 기준(11학급·34명)·집계=서버 대조·개설/폐강·자동 조정·엑셀·1차 확정 → 폐강 학생 재신청(2차, 대상 학생만)·봇 → 2차 집계·확정 → 2차 확인서 → 5단계 시수 설정·표·엑셀 → 새로고침·백업→전체 초기화→복원 비교·저장 용량.
