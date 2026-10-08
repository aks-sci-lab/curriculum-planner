-- Run once after upgrade-selection-groups.sql.
begin;
alter function public.create_course_event(jsonb) rename to create_course_event_group_base;
revoke all on function public.create_course_event_group_base(jsonb) from public,anon,authenticated;
create function public.create_course_event(p_setup jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare g jsonb; name jsonb; semester text;
begin
  if coalesce(jsonb_typeof(p_setup->'groups'),'')<>'array' then raise exception '그룹 설정이 필요합니다.'; end if;
  for g in select value from jsonb_array_elements(p_setup->'groups') loop
    semester:=g->>'semester';
    if coalesce(semester,'') not in ('0','1','2') then raise exception '그룹 학기를 지정하세요.'; end if;
    if coalesce(jsonb_typeof(g->'courses'),'')<>'array' then raise exception '그룹 과목을 지정하세요.'; end if;
    for name in select value from jsonb_array_elements(g->'courses') loop
      if not exists(select 1 from jsonb_array_elements(p_setup->'subjects'->(g->>'grade')) c
        where c.value->'subject'=name and coalesce(nullif(c.value->>'semester',''),'0')=semester) then
        raise exception '다른 학기의 과목을 같은 그룹에 배치할 수 없습니다.';
      end if;
    end loop;
  end loop;
  return public.create_course_event_group_base(p_setup);
end;
$$;
revoke all on function public.create_course_event(jsonb) from public,anon,authenticated;
grant execute on function public.create_course_event(jsonb) to authenticated;
commit;
