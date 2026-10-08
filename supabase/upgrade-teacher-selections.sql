-- Run after upgrade-selection-groups.sql (and existing semester/round upgrades).
begin;

create or replace function public.get_teacher_course_applications(p_event uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.course_events; entries jsonb;
begin
  select * into e from public.course_events where id=p_event and owner_id=auth.uid();
  if not found then raise exception '본인이 만든 수강신청만 관리할 수 있습니다.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'grade',grade,'classroom',classroom,'number',number,'name',name,
    'selections',selections,'submittedAt',submitted_at)
    order by grade::int,classroom::numeric,number::numeric),'[]'::jsonb)
  into entries from public.course_students where event_id=p_event;
  return jsonb_build_object('entries',entries,'subjects',e.subjects,'groups',e.selection_groups);
end;
$$;

create or replace function public.save_teacher_course_application(
  p_event uuid,p_student uuid,p_selections jsonb,p_previous_selections jsonb,p_previous_submitted_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.course_events; s public.course_students; allowed jsonb; g jsonb; n int;
begin
  select * into e from public.course_events where id=p_event and owner_id=auth.uid() for update;
  if not found then raise exception '본인이 만든 수강신청만 관리할 수 있습니다.'; end if;
  select * into s from public.course_students where id=p_student and event_id=p_event for update;
  if not found then raise exception '해당 신청의 학생이 아닙니다.'; end if;
  if s.selections is distinct from p_previous_selections or s.submitted_at is distinct from p_previous_submitted_at then
    raise exception '학생 신청이 변경되었습니다. 창을 닫고 다시 열어 최신 선택을 확인하세요.';
  end if;
  allowed:=e.subjects->((s.grade::int+1)::text);
  if coalesce(jsonb_typeof(p_selections),'')<>'array' then raise exception '과목을 선택하세요.'; end if;
  if jsonb_array_length(p_selections) not between 1 and jsonb_array_length(allowed)
    or exists(select 1 from jsonb_array_elements(p_selections) item
      where jsonb_typeof(item.value)<>'string' or not exists(
        select 1 from jsonb_array_elements(allowed) c where c.value->'subject'=item.value))
    or exists(select 1 from jsonb_array_elements(p_selections) group by value having count(*)>1) then
    raise exception '신청 가능한 과목을 중복 없이 1개 이상 선택하세요.';
  end if;
  for g in select value from jsonb_array_elements(e.selection_groups)
    where value->>'grade'=((s.grade::int+1)::text) loop
    select count(*) into n from jsonb_array_elements(p_selections) item
      where g->'courses' @> jsonb_build_array(item.value);
    if n<>(g->>'count')::int then raise exception '%: 정확히 %과목을 선택하세요.',g->>'name',g->>'count'; end if;
  end loop;
  perform set_config('course.history_action','teacher_edit',true);
  perform set_config('course.rollback_before','',true);
  update public.course_students set selections=p_selections,submitted_at=clock_timestamp() where id=s.id;
  return jsonb_build_object('message','학생 선택 과목을 변경했습니다.');
end;
$$;

revoke all on function public.get_teacher_course_applications(uuid),
  public.save_teacher_course_application(uuid,uuid,jsonb,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.get_teacher_course_applications(uuid),
  public.save_teacher_course_application(uuid,uuid,jsonb,jsonb,timestamptz) to authenticated;
commit;
