-- Run once in the project's Supabase SQL Editor.
begin;

create table public.course_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  school_name text not null check (length(school_name) between 1 and 100),
  school_year text not null check (school_year ~ '^[0-9]{4}$'),
  round text not null check (round ~ '^[1-9][0-9]{0,8}$'),
  subjects jsonb not null,
  result_revision bigint not null default 0,
  is_open boolean not null default true,
  created_at timestamptz not null default now()
);
create index course_events_owner_idx on public.course_events(owner_id);

create table public.course_students (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.course_events(id) on delete cascade,
  code_hash text not null unique,
  grade text not null check (grade in ('1', '2')),
  classroom text not null check (classroom ~ '^[1-9][0-9]*$'),
  number text not null check (number ~ '^[1-9][0-9]*$'),
  name text not null check (length(name) between 1 and 100),
  selections jsonb not null default '[]'::jsonb,
  submitted_at timestamptz,
  unique (event_id, grade, classroom, number)
);

create function public.bump_course_event_result_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.course_events
  set result_revision = result_revision + 1
  where id = new.event_id;
  return new;
end;
$$;
revoke all on function public.bump_course_event_result_revision() from public, anon, authenticated;
create trigger course_student_result_revision
after update of selections on public.course_students
for each row when (old.selections is distinct from new.selections)
execute function public.bump_course_event_result_revision();

alter table public.course_events enable row level security;
alter table public.course_students enable row level security;
revoke all on public.course_events, public.course_students from anon, authenticated;
grant select on public.course_events to authenticated;
create policy own_events on public.course_events for select to authenticated
  using (owner_id = (select auth.uid()));

do $$
begin
  if to_regclass('pg_catalog.pg_publication') is not null and to_regnamespace('realtime') is not null then
    if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
      raise exception 'Supabase Realtime publication is missing.';
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'course_events'
    ) then
      alter publication supabase_realtime add table public.course_events;
    end if;
  end if;
end;
$$;

create function public.create_course_event(p_setup jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid := auth.uid();
  v_event uuid;
  v_student jsonb;
  v_subject jsonb;
  v_grade text;
  v_code text;
  v_codes jsonb := '[]'::jsonb;
begin
  if v_owner is null then raise exception '교사 로그인이 필요합니다.'; end if;
  if coalesce(p_setup->>'type', '') <> 'course-application-setup' or
     coalesce(p_setup->>'round', '') !~ '^[1-9][0-9]{0,8}$' or
     coalesce(p_setup->>'schoolName', '') = '' or
     coalesce(p_setup->>'schoolYear', '') !~ '^[0-9]{4}$' or
     coalesce(jsonb_typeof(p_setup->'roster'), '') <> 'array' or
     coalesce(jsonb_typeof(p_setup->'subjects'), '') <> 'object' then
    raise exception '온라인 신청 설정 형식이 잘못되었습니다.';
  end if;
  if jsonb_array_length(p_setup->'roster') not between 1 and 10000 then
    raise exception '명렬은 1~10000명이어야 합니다.';
  end if;
  foreach v_grade in array array['2', '3'] loop
    if coalesce(jsonb_typeof(p_setup->'subjects'->v_grade), '') <> 'array' then
      raise exception '학년별 과목 설정이 필요합니다.';
    end if;
    if jsonb_array_length(p_setup->'subjects'->v_grade) > 500 then
      raise exception '학년별 과목은 500개 이하여야 합니다.';
    end if;
    for v_subject in select value from jsonb_array_elements(p_setup->'subjects'->v_grade) loop
      if coalesce(jsonb_typeof(v_subject->'subject'), '') <> 'string' or
         length(btrim(coalesce(v_subject->>'subject', ''))) not between 1 and 200 or
         coalesce(jsonb_typeof(v_subject->'credit'), '') <> 'number' then
        raise exception '과목명과 학점 설정을 확인하세요.';
      end if;
      if (v_subject->>'credit')::numeric not between 0 and 100 then
        raise exception '학점은 0~100 범위여야 합니다.';
      end if;
    end loop;
    if exists (
      select 1 from jsonb_array_elements(p_setup->'subjects'->v_grade)
      group by value->>'subject' having count(*) > 1
    ) then raise exception '동일 학년의 과목명이 중복됩니다.'; end if;
  end loop;
  insert into public.course_events(owner_id, school_name, school_year, round, subjects)
  values (v_owner, btrim(p_setup->>'schoolName'), p_setup->>'schoolYear',
          p_setup->>'round', p_setup->'subjects') returning id into v_event;
  for v_student in select value from jsonb_array_elements(p_setup->'roster') loop
    if coalesce(v_student->>'grade', '') not in ('1', '2') or
       coalesce(v_student->>'classroom', '') !~ '^[1-9][0-9]*$' or
       coalesce(v_student->>'number', '') !~ '^[1-9][0-9]*$' or
       length(btrim(coalesce(v_student->>'name', ''))) not between 1 and 100 then
      raise exception '명렬의 현재 학년·반·번호·이름을 확인하세요.';
    end if;
    v_grade := ((v_student->>'grade')::integer + 1)::text;
    if jsonb_array_length(p_setup->'subjects'->v_grade) = 0 then
      raise exception '명렬에 있는 학생의 다음 학년 과목이 없습니다.';
    end if;
    v_code := replace(gen_random_uuid()::text, '-', '');
    insert into public.course_students(event_id, code_hash, grade, classroom, number, name)
    values (v_event, encode(sha256(convert_to(v_code, 'UTF8')), 'hex'),
      v_student->>'grade', v_student->>'classroom', v_student->>'number', btrim(v_student->>'name'));
    v_codes := v_codes || jsonb_build_array(jsonb_build_object(
      'grade', v_student->>'grade', 'classroom', v_student->>'classroom',
      'number', v_student->>'number', 'name', btrim(v_student->>'name'), 'code', v_code));
  end loop;
  return jsonb_build_object('id', v_event, 'students', v_codes);
end;
$$;

create function public.get_course_application(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_student public.course_students; v_event public.course_events;
begin
  if coalesce(p_code, '') !~ '^[a-f0-9]{32}$' then raise exception '신청 코드를 확인하세요.'; end if;
  select * into v_student from public.course_students
    where code_hash = encode(sha256(convert_to(p_code, 'UTF8')), 'hex');
  if not found then raise exception '신청 코드를 확인하세요.'; end if;
  select * into strict v_event from public.course_events where id = v_student.event_id;
  return jsonb_build_object(
    'student', jsonb_build_object('grade', v_student.grade, 'classroom', v_student.classroom,
      'number', v_student.number, 'name', v_student.name),
    'schoolName', v_event.school_name, 'schoolYear', v_event.school_year,
    'round', v_event.round, 'open', v_event.is_open,
    'courses', v_event.subjects->((v_student.grade::integer + 1)::text),
    'selections', v_student.selections, 'submittedAt', v_student.submitted_at);
end;
$$;

create function public.save_course_application(p_code text, p_selections jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_student public.course_students; v_event public.course_events; v_allowed jsonb;
begin
  if coalesce(p_code, '') !~ '^[a-f0-9]{32}$' then raise exception '신청 코드를 확인하세요.'; end if;
  select * into v_student from public.course_students
    where code_hash = encode(sha256(convert_to(p_code, 'UTF8')), 'hex');
  if not found then raise exception '신청 코드를 확인하세요.'; end if;
  -- Serialize submissions with closing/deleting this event.
  select * into v_event from public.course_events where id = v_student.event_id for update;
  if not found then raise exception '수강신청이 삭제되었습니다.'; end if;
  if not exists (select 1 from public.course_students where id = v_student.id
    and code_hash = encode(sha256(convert_to(p_code, 'UTF8')), 'hex')) then
    raise exception '신청 코드가 변경되었습니다. 학교에서 새 코드를 받으세요.';
  end if;
  if not v_event.is_open then raise exception '수강신청이 마감되었습니다.'; end if;
  if coalesce(jsonb_typeof(p_selections), '') <> 'array' then raise exception '과목을 선택하세요.'; end if;
  v_allowed := v_event.subjects->((v_student.grade::integer + 1)::text);
  if jsonb_array_length(p_selections) not between 1 and jsonb_array_length(v_allowed) or
     exists (select 1 from jsonb_array_elements(p_selections) s
       where jsonb_typeof(s.value) <> 'string' or not exists (
         select 1 from jsonb_array_elements(v_allowed) c where c.value->'subject' = s.value)) or
     exists (select 1 from jsonb_array_elements(p_selections) group by value having count(*) > 1) then
    raise exception '신청 가능한 과목을 중복 없이 1개 이상 선택하세요.';
  end if;
  update public.course_students set selections = p_selections, submitted_at = now()
    where id = v_student.id;
  return jsonb_build_object('message', '신청이 저장되었습니다. 다시 제출하면 기존 신청이 수정됩니다.');
end;
$$;

create function public.manage_course_event(p_event uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_event public.course_events;
  v_entries jsonb;
  v_student public.course_students;
  v_code text;
  v_codes jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then raise exception '교사 로그인이 필요합니다.'; end if;
  select * into v_event from public.course_events
    where id = p_event and owner_id = auth.uid() for update;
  if not found then raise exception '본인이 만든 수강신청만 관리할 수 있습니다.'; end if;
  if p_action in ('open', 'close') then
    update public.course_events set is_open = (p_action = 'open') where id = p_event;
    return jsonb_build_object('message', case when p_action = 'open' then '접수를 열었습니다.' else '접수를 마감했습니다.' end);
  elsif p_action = 'delete' then
    delete from public.course_events where id = p_event;
    return jsonb_build_object('message', '명렬과 신청 결과를 삭제했습니다. 기존 코드는 더 이상 사용할 수 없습니다.');
  elsif p_action = 'codes' then
    for v_student in select * from public.course_students where event_id = p_event loop
      v_code := replace(gen_random_uuid()::text, '-', '');
      update public.course_students set code_hash = encode(sha256(convert_to(v_code, 'UTF8')), 'hex')
        where id = v_student.id;
      v_codes := v_codes || jsonb_build_array(jsonb_build_object(
        'grade', v_student.grade, 'classroom', v_student.classroom, 'number', v_student.number,
        'name', v_student.name, 'code', v_code));
    end loop;
    return jsonb_build_object('id', p_event, 'students', v_codes);
  elsif p_action = 'export' then
    select coalesce(jsonb_agg(jsonb_build_object('type', 'course-application',
      'grade', grade, 'classroom', classroom, 'number', number, 'name', name,
      'selections', selections) order by grade::integer, classroom::numeric, number::numeric), '[]'::jsonb)
    into v_entries from public.course_students where event_id = p_event and submitted_at is not null;
    return jsonb_build_object('type', 'course-application-results', 'round', v_event.round, 'entries', v_entries);
  end if;
  raise exception '알 수 없는 관리 작업입니다.';
end;
$$;

revoke all on function public.create_course_event(jsonb) from public, anon, authenticated;
revoke all on function public.get_course_application(text) from public, anon, authenticated;
revoke all on function public.save_course_application(text, jsonb) from public, anon, authenticated;
revoke all on function public.manage_course_event(uuid, text) from public, anon, authenticated;
grant execute on function public.create_course_event(jsonb), public.manage_course_event(uuid, text) to authenticated;
grant execute on function public.get_course_application(text), public.save_course_application(text, jsonb) to anon, authenticated;

commit;
