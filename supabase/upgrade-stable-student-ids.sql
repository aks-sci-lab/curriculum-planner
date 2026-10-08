-- Run once AFTER setup.sql, upgrade-codes-history.sql, and upgrade-realtime-sync.sql.
begin;

alter table public.course_students
  add column if not exists school_student_id text;

create unique index if not exists course_students_event_school_student_id_key
  on public.course_students(event_id, school_student_id)
  where school_student_id is not null;

create or replace function public.issue_course_codes(p_event uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.course_students;
  code text;
  hashed text;
  codes jsonb := '[]';
  old_hashes text[];
begin
  select array_agg(code_hash) into old_hashes
  from public.course_students where event_id = p_event;
  for s in
    select * from public.course_students
    where event_id = p_event
    order by grade::int, classroom::numeric, number::numeric
  loop
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
    codes := codes || jsonb_build_array(jsonb_build_object(
      'id', s.id, 'grade', s.grade, 'classroom', s.classroom,
      'number', s.number, 'name', s.name, 'code', code));
  end loop;
  return jsonb_build_object('id', p_event, 'students', codes);
end;
$$;
revoke all on function public.issue_course_codes(uuid) from public, anon, authenticated;

create or replace function public.create_course_event(p_setup jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  result jsonb;
  v_event uuid;
  v_student jsonb;
  v_school_student_id text;
begin
  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_setup->'roster', '[]'::jsonb)) as roster(value)
    where nullif(btrim(roster.value->>'studentId'), '') is not null
    group by btrim(roster.value->>'studentId')
    having count(*) > 1
  ) then
    raise exception '명렬에 중복된 학번이 있습니다.';
  end if;
  for v_student in select value from jsonb_array_elements(coalesce(p_setup->'roster', '[]'::jsonb)) loop
    if v_student ? 'studentId' and jsonb_typeof(v_student->'studentId') not in ('string', 'null') then
      raise exception '학번은 문자열이어야 합니다.';
    end if;
    v_school_student_id := nullif(btrim(v_student->>'studentId'), '');
    if length(v_school_student_id) > 30 then
      raise exception '학번은 30자 이하여야 합니다.';
    end if;
  end loop;

  result := public.create_course_event_base(p_setup);
  v_event := (result->>'id')::uuid;
  for v_student in select value from jsonb_array_elements(coalesce(p_setup->'roster', '[]'::jsonb)) loop
    v_school_student_id := nullif(btrim(v_student->>'studentId'), '');
    if v_school_student_id is not null then
      update public.course_students
      set school_student_id = v_school_student_id
      where event_id = v_event
        and grade = v_student->>'grade'
        and classroom = v_student->>'classroom'
        and number = v_student->>'number';
      if not found then raise exception '명렬의 학번을 신청 학생과 연결하지 못했습니다.'; end if;
    end if;
  end loop;
  return public.issue_course_codes(v_event);
end;
$$;

create or replace function public.manage_course_event(p_event uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  result jsonb;
  v_entries jsonb;
begin
  if auth.uid() is null then raise exception '교사 로그인이 필요합니다.'; end if;
  perform 1 from public.course_events where id = p_event and owner_id = auth.uid() for update;
  if not found then raise exception '본인이 만든 수강신청만 관리할 수 있습니다.'; end if;
  if p_action = 'codes' then return public.issue_course_codes(p_event); end if;
  if p_action = 'export' then
    result := public.manage_course_event_base(p_event, p_action);
    select coalesce(jsonb_agg(entry.value || jsonb_build_object('studentId', student.school_student_id)), '[]'::jsonb)
    into v_entries
    from jsonb_array_elements(coalesce(result->'entries', '[]'::jsonb)) as entry(value)
    left join public.course_students student
      on student.event_id = p_event
      and student.grade = entry.value->>'grade'
      and student.classroom = entry.value->>'classroom'
      and student.number = entry.value->>'number';
    return jsonb_set(result, '{entries}', v_entries, true);
  end if;
  return public.manage_course_event_base(p_event, p_action);
end;
$$;

revoke all on function public.create_course_event(jsonb), public.manage_course_event(uuid, text)
  from public, anon, authenticated;
grant execute on function public.create_course_event(jsonb), public.manage_course_event(uuid, text)
  to authenticated;

commit;
