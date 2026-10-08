-- Run once after upgrade-codes-history.sql. Existing events retain unrestricted selection.
begin;
alter table public.course_events add column selection_groups jsonb not null default '[]'::jsonb;
alter function public.create_course_event(jsonb) rename to create_course_event_codes;
alter function public.get_scoped_course_application(uuid,text) rename to get_scoped_course_application_base;
alter function public.save_scoped_course_application(uuid,text,jsonb) rename to save_scoped_course_application_base;
revoke all on function public.create_course_event_codes(jsonb),
 public.get_scoped_course_application_base(uuid,text),
 public.save_scoped_course_application_base(uuid,text,jsonb) from public,anon,authenticated;

create function public.create_course_event(p_setup jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; groups jsonb:=p_setup->'groups'; g jsonb; grade text; c jsonb;
begin
  if coalesce(jsonb_typeof(groups),'')<>'array' then raise exception '선택 그룹을 설정하세요.'; end if;
  if jsonb_array_length(groups)>1000 then raise exception '선택 그룹이 너무 많습니다.'; end if;
  for g in select value from jsonb_array_elements(groups) loop
    if coalesce(g->>'grade','') not in ('2','3') or length(btrim(coalesce(g->>'name',''))) not between 1 and 100
      or coalesce(g->>'id','')='' or coalesce(jsonb_typeof(g->'courses'),'')<>'array'
      or coalesce(g->>'count','') !~ '^[0-9]+$' then raise exception '그룹 설정 형식을 확인하세요.'; end if;
    if jsonb_array_length(g->'courses')=0 or (g->>'count')::numeric > jsonb_array_length(g->'courses') then
      raise exception '그룹 선택 수는 소속 과목 수 이하여야 합니다.';
    end if;
    for c in select value from jsonb_array_elements(g->'courses') loop
      if jsonb_typeof(c)<>'string' or not exists(
        select 1 from jsonb_array_elements(p_setup->'subjects'->(g->>'grade')) s where s.value->'subject'=c
      ) then raise exception '그룹에 편제표에 없는 과목이 있습니다.'; end if;
    end loop;
  end loop;
  if exists(select 1 from jsonb_array_elements(groups) group by value->>'id' having count(*)>1) then
    raise exception '그룹 ID가 중복됩니다.';
  end if;
  foreach grade in array array['2','3'] loop
    for c in select value from jsonb_array_elements(p_setup->'subjects'->grade) loop
      if (select count(*) from jsonb_array_elements(groups) g,
        lateral jsonb_array_elements(g.value->'courses') item
        where g.value->>'grade'=grade and item.value=c->'subject') <> 1 then
        raise exception '모든 과목은 해당 학년의 한 그룹에 포함되어야 합니다.';
      end if;
    end loop;
    if jsonb_array_length(p_setup->'subjects'->grade)>0 and not exists(
      select 1 from jsonb_array_elements(groups) g where g.value->>'grade'=grade and (g.value->>'count')::numeric>0
    ) then raise exception '학년별 최소 1과목 이상 선택하도록 설정하세요.'; end if;
  end loop;
  result:=public.create_course_event_codes(p_setup);
  update public.course_events set selection_groups=groups where id=(result->>'id')::uuid;
  return result;
end;
$$;

create function public.get_scoped_course_application(p_event uuid,p_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; groups jsonb;
begin
  result:=public.get_scoped_course_application_base(p_event,p_code);
  select coalesce(jsonb_agg(value),'[]') into groups from public.course_events e,
    lateral jsonb_array_elements(e.selection_groups)
    where e.id=p_event and value->>'grade'=((result->'student'->>'grade')::int+1)::text;
  return result||jsonb_build_object('groups',groups);
end;
$$;

create function public.save_scoped_course_application(p_event uuid,p_code text,p_selections jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare data jsonb; g jsonb; n int;
begin
  perform 1 from public.course_events where id=p_event for update;
  data:=public.get_scoped_course_application(p_event,p_code);
  if coalesce(jsonb_typeof(p_selections),'')<>'array' then raise exception '과목을 선택하세요.'; end if;
  for g in select value from jsonb_array_elements(data->'groups') loop
    select count(*) into n from jsonb_array_elements(p_selections) s
      where g->'courses' @> jsonb_build_array(s.value);
    if n<>(g->>'count')::int then raise exception '%: 정확히 %과목을 선택하세요.',g->>'name',g->>'count'; end if;
  end loop;
  return public.save_scoped_course_application_base(p_event,p_code,p_selections);
end;
$$;
revoke all on function public.create_course_event(jsonb),public.get_scoped_course_application(uuid,text),
public.save_scoped_course_application(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.create_course_event(jsonb) to authenticated;
grant execute on function public.get_scoped_course_application(uuid,text),
public.save_scoped_course_application(uuid,text,jsonb) to anon,authenticated;
commit;
