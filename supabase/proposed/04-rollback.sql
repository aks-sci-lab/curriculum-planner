-- 04-prerequisite-check.sql 되돌리기: 감싼 함수를 지우고 원래 이름으로 돌린다. 이벤트 자료(jsonb)는 그대로 둔다.
begin;
drop function public.save_scoped_course_application_base(uuid, text, jsonb);
alter function public.save_scoped_course_application_prereq_base(uuid, text, jsonb) rename to save_scoped_course_application_base;
revoke all on function public.save_scoped_course_application_base(uuid, text, jsonb) from public, anon, authenticated;
drop function public.get_scoped_course_application_base(uuid, text);
alter function public.get_scoped_course_application_prereq_base(uuid, text) rename to get_scoped_course_application_base;
revoke all on function public.get_scoped_course_application_base(uuid, text) from public, anon, authenticated;
drop function public.course_prerequisite_violations(jsonb, jsonb);
notify pgrst, 'reload schema';
commit;
