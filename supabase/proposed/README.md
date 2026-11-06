# 보안 강화 SQL (제안 · 서버 미적용)
**Supabase에는 아직 적용하지 않았습니다.** 로컬 PGlite로 기존 `supabase/*.sql` 전체 체인 위에서 실행·검증했습니다(`tests/code-hardening.test.cjs`).

## 정책
- 학생 코드는 6자리 숫자 유지. **첫 접속 때 받은 코드를 새 6자리로 바꿔야** 하고(처음 코드는 이후 무효), 잊으면 교사가 학생별로 재발급합니다.
- 접속 실패 **5회 → 10분 잠금**(접속지 IP 기준, 시간이 지나면 자동 해제) + 이벤트 전체 10분 100회 실패면 모든 접속지 제한 + 교사 수동 해제 버튼.
- 코드는 이벤트별 소금 + 서버 후추로 해시(`code_hmac`). 교사 로그인 도메인 제한은 하지 않습니다.

## 적용 순서 (Supabase 대시보드 → SQL Editor, 한 파일씩 전체 붙여넣고 Run)
1. 기존 `supabase/upgrade-*.sql` 이 모두 적용된 상태여야 합니다(마지막 `upgrade-reselection.sql`).
2. `01-code-hardening.sql` — 기존 학생 6자리 코드를 소금 해시로 변환합니다(백만 개 표 사용, 수 초). **이후 기존 코드로 처음 접속하는 학생은 새 코드를 정하게 됩니다.** 앱(`supabase-client.js`)을 먼저 배포한 뒤 실행하세요. 구버전 앱은 새 응답(`mustChangeCode`/`error`)을 모릅니다.
3. `02-next-round-student-id.sql` — 다음 차수 생성 시 학번이 이어지게 합니다(`upgrade-stable-student-ids.sql` 필요).
4. `03-retention-purge.sql` — (선택) 학년도 종료 +180일 뒤 자동 삭제. `pg_cron` 예약은 주석 안내.

## 되돌리기
- 01: `01-rollback.sql` 실행 후 각 신청에서 **"전체 학생 코드 재발급"** 을 눌러 새 코드를 나눠 주세요(원본 코드는 저장하지 않아 복원 불가). 컬럼(`code_hmac` 등)은 남겨도 무해합니다.
- 02: 파일 안의 `old_text`/`new_text` 를 서로 바꿔 다시 실행.
- 03: `drop trigger course_events_purge_after on public.course_events; drop function public.purge_expired_course_events(); alter table public.course_events drop column purge_after;` 와 `cron.unschedule`.

## 잠금 해제 방식 장단점
| | 시간 경과(현재 구현) | 교사 수동 해제 |
|---|---|---|
| 장점 | 교사 개입 없이 풀림, 학생이 바로 재시도 | 공격이 끝나기 전엔 풀리지 않음 |
| 단점 | 10분마다 5회씩 계속 시도 가능(접속지 바꾸면 더 많이) | 교사가 항상 대기해야 함, 수업 중 학생이 오래 막힘 |
현재: 접속지는 시간 경과로 자동 해제, 이벤트 전체 제한은 10분 창이 지나면 해제, 교사는 "접속 잠금 해제" 버튼으로 언제든 즉시 해제할 수 있습니다.

## 알아둘 한계 (결정 필요)
- **학교 공용 IP**: 같은 학교 와이파이면 접속지가 같아, 학생 5명이 오타를 내면 그 학교 전체가 10분 잠깁니다. 임계값은 `course_record_failure`/`course_check_lock`의 `5`, `100`을 고치면 됩니다.
- **코드만으로 접속**하므로 "학생 한 명" 단위 잠금은 불가능합니다(실패한 코드가 누구 것인지 모름). 학생이 1,000명이면 6자리 코드의 0.1%가 유효해, 이벤트 전체 상한을 두어도 하루 수 명 수준의 추측 성공은 이론상 남습니다. 근본 해결은 접속 시 **반·번호(또는 학번) + 코드**를 함께 입력받아 학생 단위로 잠그는 것입니다(UI·SQL 추가 변경 필요).
- 접속지 판별은 `cf-connecting-ip` → `x-real-ip` → `x-forwarded-for`의 마지막 값 순입니다. Supabase 프로젝트에서 실제 헤더를 확인해 주세요.
