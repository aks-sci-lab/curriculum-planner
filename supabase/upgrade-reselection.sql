-- Run after upgrade-teacher-selections.sql. Existing academic-year guards are preserved.
begin;

alter table public.course_students
  add column retained_selections jsonb not null default '[]'::jsonb,
  add column reselection_allowed boolean not null default true;
alter table public.course_events
  add column source_event_id uuid references public.course_events(id) on delete set null,
  add column reselection_mode text;

create function public.course_base_subject(p_name text)
returns text language sql immutable set search_path='' as $$
  select btrim(regexp_replace(regexp_replace(p_name, '\s*\([12]학기\)', '', 'g'), '\s+', ' ', 'g'));
$$;

create function public.enforce_course_reselection()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if not old.reselection_allowed and
    (new.selections is distinct from old.selections or new.submitted_at is distinct from old.submitted_at) then
    raise exception '폐강 과목 신청 학생만 재선택할 수 있습니다. 기존 신청은 유지됩니다.';
  end if;
  if not new.selections @> old.retained_selections then
    raise exception '폐강되지 않은 기존 선택 과목은 변경할 수 없습니다.';
  end if;
  if exists(select 1 from jsonb_array_elements_text(new.selections) item
    group by public.course_base_subject(item) having count(*)>1) then
    raise exception '1학기와 2학기에 같은 과목을 중복 신청할 수 없습니다.';
  end if;
  return new;
end;
$$;
create trigger course_reselection_guard before update of selections,submitted_at on public.course_students
  for each row execute function public.enforce_course_reselection();
revoke all on function public.course_base_subject(text),public.enforce_course_reselection() from public,anon,authenticated;

alter function public.get_scoped_course_application(uuid,text) rename to get_scoped_course_application_reselection_base;
create function public.get_scoped_course_application(p_event uuid,p_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; s public.course_students;
begin
  result:=public.get_scoped_course_application_reselection_base(p_event,p_code);
  select * into strict s from public.course_students where event_id=p_event
    and code_hash=encode(sha256(convert_to(p_code,'UTF8')),'hex');
  return result||jsonb_build_object('lockedSelections',s.retained_selections,
    'reselectionAllowed',s.reselection_allowed,'open',(result->>'open')::boolean and s.reselection_allowed);
end;
$$;
revoke all on function public.get_scoped_course_application_reselection_base(uuid,text) from public,anon,authenticated;
revoke all on function public.get_scoped_course_application(uuid,text) from public,anon,authenticated;
grant execute on function public.get_scoped_course_application(uuid,text) to anon,authenticated;

alter function public.get_teacher_course_applications(uuid) rename to get_teacher_course_applications_reselection_base;
create function public.get_teacher_course_applications(p_event uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; entries jsonb;
begin
  result:=public.get_teacher_course_applications_reselection_base(p_event);
  select coalesce(jsonb_agg(item||jsonb_build_object('lockedSelections',s.retained_selections,
    'reselectionAllowed',s.reselection_allowed) order by (item->>'grade')::int,
      (item->>'classroom')::numeric,(item->>'number')::numeric),'[]')
    into entries from jsonb_array_elements(result->'entries') item
    join public.course_students s on s.id=(item->>'id')::uuid;
  return result||jsonb_build_object('entries',entries);
end;
$$;
revoke all on function public.get_teacher_course_applications_reselection_base(uuid) from public,anon,authenticated;
revoke all on function public.get_teacher_course_applications(uuid) from public,anon,authenticated;
grant execute on function public.get_teacher_course_applications(uuid) to authenticated;

create function public.create_next_course_event(p_source uuid,p_closed jsonb,p_mode text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.course_events; subjects jsonb:='{"1":[],"2":[],"3":[]}'; groups jsonb:='[]';
  roster jsonb; g jsonb; remaining jsonb; v_grade text; c jsonb; result jsonb;
  s public.course_students; kept jsonb; affected boolean; affected_count int:=0; target uuid;
begin
  select * into e from public.course_events where id=p_source and owner_id=auth.uid() for update;
  if not found then raise exception '본인이 만든 이전 차수 신청을 선택하세요.'; end if;
  perform public.get_teacher_course_applications(p_source);
  if e.is_open then raise exception '이전 차수 신청을 마감한 뒤 다음 차수를 생성하세요.'; end if;
  if p_mode is null or p_mode not in ('all','affected') then raise exception '재선택 방식을 선택하세요.'; end if;
  if coalesce(jsonb_typeof(p_closed),'')<>'array' or jsonb_array_length(p_closed)=0 then
    raise exception '이전 차수에서 폐강 과목을 확정하세요.';
  end if;
  for c in select value from jsonb_array_elements(p_closed) loop
    if coalesce(c->>'grade','') not in ('2','3') or not exists(
      select 1 from jsonb_array_elements(e.subjects->(c->>'grade')) item
      where item->'subject'=c->'subject') then raise exception '폐강 과목의 학년·과목명을 확인하세요.'; end if;
  end loop;
  foreach v_grade in array array['2','3'] loop
    select coalesce(jsonb_agg(item),'[]') into remaining from jsonb_array_elements(e.subjects->v_grade) item
      where not p_closed @> jsonb_build_array(jsonb_build_object('grade',v_grade,'subject',item->>'subject'));
    subjects:=jsonb_set(subjects,array[v_grade],remaining);
  end loop;
  for g in select value from jsonb_array_elements(e.selection_groups) loop
    select coalesce(jsonb_agg(item),'[]') into remaining from jsonb_array_elements(g->'courses') item
      where not p_closed @> jsonb_build_array(jsonb_build_object('grade',g->>'grade','subject',item));
    if jsonb_array_length(remaining)<(g->>'count')::int then
      raise exception '%: 폐강 제외 후 과목 수가 선택 수보다 적습니다. 그룹 구성을 먼저 검토하세요.',g->>'name';
    end if;
    if jsonb_array_length(remaining)>0 then groups:=groups||jsonb_build_array(g||jsonb_build_object('courses',remaining)); end if;
  end loop;
  select jsonb_agg(jsonb_build_object('grade',grade,'classroom',classroom,'number',number,'name',name))
    into roster from public.course_students where event_id=p_source;
  result:=public.create_course_event(jsonb_build_object('type','course-application-setup',
    'schoolName',e.school_name,'schoolYear',e.school_year,'round',(e.round::int+1)::text,
    'subjects',subjects,'groups',groups,'roster',roster));
  target:=(result->>'id')::uuid;
  update public.course_events set source_event_id=p_source,reselection_mode=p_mode where id=target;
  for s in select * from public.course_students where event_id=p_source loop
    select coalesce(jsonb_agg(item),'[]') into kept from jsonb_array_elements(s.selections) item
      where not p_closed @> jsonb_build_array(jsonb_build_object('grade',(s.grade::int+1)::text,'subject',item));
    affected:=jsonb_array_length(kept)<jsonb_array_length(s.selections);
    if affected then affected_count:=affected_count+1; end if;
    if p_mode='affected' then
      update public.course_students set selections=kept,submitted_at=s.submitted_at
        where event_id=target and grade=s.grade and classroom=s.classroom and number=s.number;
      update public.course_students set retained_selections=kept,reselection_allowed=affected
        where event_id=target and grade=s.grade and classroom=s.classroom and number=s.number;
    end if;
  end loop;
  if p_mode='affected' and affected_count=0 then raise exception '폐강 과목을 신청한 재선택 대상 학생이 없습니다.'; end if;
  return result||jsonb_build_object('affectedCount',affected_count,'mode',p_mode);
end;
$$;
revoke all on function public.create_next_course_event(uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.create_next_course_event(uuid,jsonb,text) to authenticated;
notify pgrst,'reload schema';
commit;
