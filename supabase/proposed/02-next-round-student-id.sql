-- create_next_course_event 가 다음 차수 명렬을 만들 때 학번(school_student_id)을 빠뜨리던 문제 수정.
-- upgrade-stable-student-ids.sql 과 upgrade-reselection.sql 이후에 실행. 되돌리려면 아래 old/new 를 바꿔 다시 실행.
begin;
do $migration$
declare
  definition text;
  old_text text := $old$jsonb_build_object('grade',grade,'classroom',classroom,'number',number,'name',name))$old$;
  new_text text := $new$jsonb_build_object('grade',grade,'classroom',classroom,'number',number,'name',name,'studentId',school_student_id))$new$;
begin
  if not exists (select 1 from pg_attribute where attrelid='public.course_students'::regclass
      and attname='school_student_id' and not attisdropped) then
    raise exception 'upgrade-stable-student-ids.sql 을 먼저 실행하세요.';
  end if;
  select pg_get_functiondef('public.create_next_course_event(uuid,jsonb,text)'::regprocedure) into definition;
  if position(new_text in definition) > 0 then return; end if;
  if position(old_text in definition) = 0 then raise exception '기존 명렬 생성 구문을 찾지 못했습니다.'; end if;
  execute replace(definition, old_text, new_text);
end;
$migration$;
commit;
