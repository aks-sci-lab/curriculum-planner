-- Run once AFTER setup.sql, including for existing installations.
begin;
alter table public.course_events add column history_started_at timestamptz not null default clock_timestamp();
alter table public.course_students drop constraint course_students_code_hash_key;
alter table public.course_students add constraint course_students_event_code_key unique(event_id, code_hash);
create table public.course_application_history (
  id bigint generated always as identity primary key,
  event_id uuid not null references public.course_events(id) on delete cascade,
  student_id uuid not null references public.course_students(id) on delete cascade,
  recorded_at timestamptz not null default clock_timestamp(),
  action text not null,
  selections jsonb not null,
  submitted_at timestamptz,
  rollback_before timestamptz,
  actor_id uuid
);
create index course_history_lookup on public.course_application_history(student_id, recorded_at, id);
alter table public.course_application_history enable row level security;
revoke all on public.course_application_history from public, anon, authenticated;
insert into public.course_application_history(event_id, student_id, action, selections, submitted_at)
select event_id, id, 'baseline', selections, submitted_at from public.course_students;

create function public.record_course_history()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.course_application_history(event_id, student_id, action, selections, submitted_at, actor_id, rollback_before)
  values (new.event_id, new.id, case when tg_op='INSERT' then 'initial'
    else coalesce(nullif(current_setting('course.history_action', true), ''), 'submit') end,
    new.selections, new.submitted_at, auth.uid(),
    nullif(current_setting('course.rollback_before', true), '')::timestamptz);
  return new;
end;
$$;
create trigger course_history_insert after insert on public.course_students
for each row execute function public.record_course_history();
create trigger course_history_update after update of selections, submitted_at on public.course_students
for each row execute function public.record_course_history();
revoke all on function public.record_course_history() from public, anon, authenticated;

-- Keep existing validation/export behavior behind authenticated wrappers.
alter function public.create_course_event(jsonb) rename to create_course_event_base;
alter function public.manage_course_event(uuid, text) rename to manage_course_event_base;
revoke all on function public.create_course_event_base(jsonb), public.manage_course_event_base(uuid,text)
from public, anon, authenticated;

create function public.issue_course_codes(p_event uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.course_students; code text; hashed text; codes jsonb := '[]'; old_hashes text[];
begin
  select array_agg(code_hash) into old_hashes from public.course_students where event_id=p_event;
  for s in select * from public.course_students where event_id = p_event order by grade::int, classroom::numeric, number::numeric loop
    loop
      code := lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint) % 1000000)::text, 6, '0');
      hashed := encode(sha256(convert_to(code, 'UTF8')), 'hex');
      if hashed = any(old_hashes) then continue; end if;
      begin
        update public.course_students set code_hash = hashed where id = s.id;
        exit;
      exception when unique_violation then
        -- Retry a random collision; never return duplicate codes.
      end;
    end loop;
    codes := codes || jsonb_build_array(jsonb_build_object('id', s.id, 'grade', s.grade,
      'classroom', s.classroom, 'number', s.number, 'name', s.name, 'code', code));
  end loop;
  return jsonb_build_object('id', p_event, 'students', codes);
end;
$$;
revoke all on function public.issue_course_codes(uuid) from public, anon, authenticated;

create function public.create_course_event(p_setup jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  result := public.create_course_event_base(p_setup);
  return public.issue_course_codes((result->>'id')::uuid);
end;
$$;
create function public.manage_course_event(p_event uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception '교사 로그인이 필요합니다.'; end if;
  perform 1 from public.course_events where id = p_event and owner_id = auth.uid() for update;
  if not found then raise exception '본인이 만든 수강신청만 관리할 수 있습니다.'; end if;
  if p_action = 'codes' then return public.issue_course_codes(p_event); end if;
  return public.manage_course_event_base(p_event, p_action);
end;
$$;
revoke all on function public.create_course_event(jsonb), public.manage_course_event(uuid,text) from public, anon, authenticated;
grant execute on function public.create_course_event(jsonb), public.manage_course_event(uuid,text) to authenticated;

create function public.get_scoped_course_application(p_event uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(p_code,'') !~ '^([0-9]{6}|[a-f0-9]{32})$' then raise exception '신청 코드를 확인하세요.'; end if;
  perform 1 from public.course_students where event_id = p_event
    and code_hash = encode(sha256(convert_to(p_code,'UTF8')), 'hex');
  if not found then raise exception '해당 신청의 개인 코드를 확인하세요.'; end if;
  -- The original reader validates long codes. Return the scoped record directly.
  return (select jsonb_build_object(
    'student',jsonb_build_object('grade',s.grade,'classroom',s.classroom,'number',s.number,'name',s.name),
    'schoolName',e.school_name,'schoolYear',e.school_year,'round',e.round,'open',e.is_open,
    'courses',e.subjects->((s.grade::int+1)::text),'selections',s.selections,'submittedAt',s.submitted_at)
    from public.course_students s join public.course_events e on e.id=s.event_id
    where s.event_id=p_event and s.code_hash=encode(sha256(convert_to(p_code,'UTF8')),'hex'));
end;
$$;

create function public.save_scoped_course_application(p_event uuid, p_code text, p_selections jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.course_students; e public.course_events; allowed jsonb;
begin
  select * into e from public.course_events where id=p_event for update;
  if not found then raise exception '수강신청을 찾지 못했습니다.'; end if;
  perform public.get_scoped_course_application(p_event,p_code);
  select * into strict s from public.course_students where event_id=p_event
    and code_hash=encode(sha256(convert_to(p_code,'UTF8')),'hex');
  if not e.is_open then raise exception '수강신청이 마감되었습니다.'; end if;
  if coalesce(jsonb_typeof(p_selections),'') <> 'array' then raise exception '과목을 선택하세요.'; end if;
  allowed := e.subjects->((s.grade::int+1)::text);
  if jsonb_array_length(p_selections) not between 1 and jsonb_array_length(allowed)
    or exists(select 1 from jsonb_array_elements(p_selections) v where jsonb_typeof(v.value)<>'string'
      or not exists(select 1 from jsonb_array_elements(allowed) c where c.value->'subject'=v.value))
    or exists(select 1 from jsonb_array_elements(p_selections) group by value having count(*)>1) then
    raise exception '신청 가능한 과목을 중복 없이 선택하세요.';
  end if;
  perform set_config('course.history_action','submit',true);
  update public.course_students set selections=p_selections,submitted_at=clock_timestamp() where id=s.id;
  return jsonb_build_object('message','신청이 저장되었습니다. 신청 이력도 기록했습니다.');
end;
$$;
revoke all on function public.get_scoped_course_application(uuid,text),
 public.save_scoped_course_application(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.get_scoped_course_application(uuid,text),
 public.save_scoped_course_application(uuid,text,jsonb) to anon, authenticated;
-- Legacy long-code entry remains available only for existing long codes.

create function public.course_event_history(p_event uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform 1 from public.course_events where id=p_event and owner_id=auth.uid();
  if not found then raise exception '본인이 만든 수강신청만 관리할 수 있습니다.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',h.id,'studentId',s.id,'grade',s.grade,
    'classroom',s.classroom,'number',s.number,'name',s.name,'at',h.recorded_at,
    'action',h.action,'selections',h.selections,'submittedAt',h.submitted_at,'rollbackBefore',h.rollback_before)
    order by h.recorded_at desc,h.id desc),'[]'::jsonb)
  into result from public.course_application_history h join public.course_students s on s.id=h.student_id
  where h.event_id=p_event;
  return jsonb_build_object('entries',result,'startedAt',(select history_started_at from public.course_events where id=p_event));
end;
$$;

create function public.rollback_course_event(p_event uuid, p_before timestamptz, p_student uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e public.course_events; s public.course_students; snapshot public.course_application_history; n int:=0;
begin
  select * into e from public.course_events where id=p_event and owner_id=auth.uid() for update;
  if not found then raise exception '본인이 만든 수강신청만 관리할 수 있습니다.'; end if;
  if p_before is null or p_before <= e.history_started_at or p_before > clock_timestamp() then
    raise exception '이력 기록 시작 이후부터 현재까지의 시각을 선택하세요.';
  end if;
  if p_student is not null and not exists(select 1 from public.course_students where id=p_student and event_id=p_event) then
    raise exception '해당 신청의 학생이 아닙니다.';
  end if;
  perform set_config('course.history_action','rollback',true);
  perform set_config('course.rollback_before',p_before::text,true);
  for s in select * from public.course_students where event_id=p_event and (p_student is null or id=p_student) loop
    select * into snapshot from public.course_application_history
      where student_id=s.id and recorded_at < p_before order by recorded_at desc,id desc limit 1;
    if not found then
      if exists(select 1 from public.course_application_history where student_id=s.id and action='baseline') then
        raise exception '업데이트 이전 상태는 복원할 수 없습니다. 더 늦은 시각을 선택하세요.';
      end if;
      snapshot.selections := '[]'::jsonb; snapshot.submitted_at := null;
    end if;
    update public.course_students set selections=snapshot.selections,submitted_at=snapshot.submitted_at where id=s.id;
    n:=n+1;
  end loop;
  return jsonb_build_object('message',n||'명의 신청을 지정 시각 직전 상태로 복원했습니다. 롤백 이력을 기록했습니다.');
end;
$$;
revoke all on function public.course_event_history(uuid),public.rollback_course_event(uuid,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.course_event_history(uuid),public.rollback_course_event(uuid,timestamptz,uuid) to authenticated;
commit;
