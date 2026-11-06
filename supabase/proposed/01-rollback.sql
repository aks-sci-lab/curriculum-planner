-- 01-code-hardening.sql 되돌리기. 학생 코드는 복원할 수 없으므로(원본 6자리는 저장하지 않음)
-- 실행 뒤 각 신청에서 앱의 "전체 학생 코드 재발급"을 눌러 새 코드를 나눠 주세요.
begin;
drop function if exists public.get_scoped_course_application(uuid,text);
drop function if exists public.save_scoped_course_application(uuid,text,jsonb);
alter function public.get_scoped_course_application_hardening_base(uuid,text) rename to get_scoped_course_application;
alter function public.save_scoped_course_application_hardening_base(uuid,text,jsonb) rename to save_scoped_course_application;
grant execute on function public.get_scoped_course_application(uuid,text),
  public.save_scoped_course_application(uuid,text,jsonb) to anon, authenticated;

drop function if exists public.change_course_code(uuid,text,text), public.unlock_course_event(uuid),
  public.reissue_course_code(uuid,uuid), public.course_authenticate(uuid,text),
  public.course_record_failure(uuid), public.course_check_lock(uuid), public.course_client_key(),
  public.issue_course_codes(uuid), public.course_assign_code(uuid), public.course_new_code(),
  public.course_is_weak_code(text), public.course_student_token(uuid), public.course_code_hash(uuid,text);
alter function public.issue_course_codes_legacy(uuid) rename to issue_course_codes;
drop table if exists public.course_code_failures;
-- 데이터는 보존하려면 아래 줄은 실행하지 않아도 됩니다(참조하는 함수가 없어 무해).
-- alter table public.course_students drop column code_hmac, drop column code_must_change, drop column code_changed_at;
-- alter table public.course_events drop column code_salt; drop schema course_private cascade;
commit;
