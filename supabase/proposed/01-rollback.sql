-- 01-code-hardening.sql 되돌리기. 학생 코드는 복원할 수 없으므로(원본 6자리는 저장하지 않음)
-- 실행 뒤 각 신청에서 앱의 "전체 학생 코드 재발급"을 눌러 새 코드를 나눠 주세요.
-- 앱(supabase-client.js)도 반·번호 입력 이전 버전으로 함께 되돌려야 학생이 접속할 수 있습니다.
begin;
drop function if exists public.get_scoped_course_application(uuid,text);
drop function if exists public.save_scoped_course_application(uuid,text,jsonb);
alter function public.get_scoped_course_application_hardening_base(uuid,text) rename to get_scoped_course_application;
alter function public.save_scoped_course_application_hardening_base(uuid,text,jsonb) rename to save_scoped_course_application;
grant execute on function public.get_scoped_course_application(uuid,text),
  public.save_scoped_course_application(uuid,text,jsonb) to anon, authenticated;

drop function if exists public.get_course_login_form(uuid),
  public.get_student_course_application(uuid,text,text,text,text),
  public.save_student_course_application(uuid,text,text,text,text,jsonb),
  public.change_course_code(uuid,text,text,text,text,text),
  public.get_course_code_locks(uuid), public.unlock_course_student(uuid,uuid), public.unlock_course_event(uuid),
  public.reissue_course_code(uuid,uuid), public.course_auth_error(text,boolean,boolean),
  public.course_authenticate_student(uuid,text,text,text,text),
  public.course_lock_message(public.course_code_locks), public.course_assert_owner(uuid),
  public.issue_course_codes(uuid), public.course_assign_code(uuid), public.course_new_code(),
  public.course_is_weak_code(text), public.course_student_token(uuid), public.course_code_hash(uuid,text);
alter function public.issue_course_codes_legacy(uuid) rename to issue_course_codes;
drop table if exists public.course_code_locks;
-- 데이터는 보존하려면 아래 줄은 실행하지 않아도 됩니다(참조하는 함수가 없어 무해).
-- alter table public.course_students drop column code_hmac, drop column code_must_change, drop column code_changed_at;
-- drop schema course_private cascade;
notify pgrst, 'reload schema';
commit;
