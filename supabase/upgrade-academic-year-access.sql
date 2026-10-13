-- Run once after all existing application upgrades, including teacher selections.
begin;

create function public.course_school_year_expires_at(p_year text)
returns timestamptz language plpgsql immutable set search_path='' as $$
begin
  if p_year is null or p_year !~ '^[0-9]{4}$' then return null; end if;
  if p_year::int not between 2000 and 2100 then return null; end if;
  return make_timestamptz(p_year::int + 1, 3, 1, 0, 0, 0, 'Asia/Seoul');
end;
$$;

create function public.course_school_year_active(p_year text)
returns boolean language sql volatile set search_path='' as $$
  select coalesce(clock_timestamp() < public.course_school_year_expires_at(p_year), false);
$$;
revoke all on function public.course_school_year_expires_at(text),
  public.course_school_year_active(text) from public, anon, authenticated;
grant execute on function public.course_school_year_expires_at(text),
  public.course_school_year_active(text) to authenticated;

create function public.assert_course_school_year_active(p_year text)
returns void language plpgsql set search_path='' as $$
begin
  if not public.course_school_year_active(p_year) then
    raise exception '해당 학년도 이용 기간이 종료되었습니다. 다음 해 3월 1일 00:00(한국 시간)부터 교사 관리와 학생 접속이 차단됩니다. 데이터는 보존됩니다.';
  end if;
end;
$$;

create function public.assert_course_event_active(p_event uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_year text;
begin
  select school_year into v_year from public.course_events where id=p_event;
  if not found then raise exception '수강신청을 찾지 못했습니다.'; end if;
  perform public.assert_course_school_year_active(v_year);
end;
$$;
revoke all on function public.assert_course_school_year_active(text),
  public.assert_course_event_active(uuid) from public, anon, authenticated;

alter policy own_events on public.course_events
  using (owner_id = (select auth.uid()) and public.course_school_year_active(school_year));

-- Wrap every public entry point, retaining its existing validation and ownership checks.
do $migration$
declare
  entry record;
  fn record;
  args text;
  call_args text;
  check_sql text;
  internal_name text;
begin
  for entry in select * from (values
    ('create_course_event', 'jsonb', 'setup', false),
    ('manage_course_event', 'uuid,text', 'event', false),
    ('course_event_history', 'uuid', 'event', false),
    ('rollback_course_event', 'uuid,timestamptz,uuid', 'event', false),
    ('get_teacher_course_applications', 'uuid', 'event', false),
    ('save_teacher_course_application', 'uuid,uuid,jsonb,jsonb,timestamptz', 'event', false),
    ('get_scoped_course_application', 'uuid,text', 'event', true),
    ('save_scoped_course_application', 'uuid,text,jsonb', 'event', true),
    ('get_course_application', 'text', 'code', true),
    ('save_course_application', 'text,jsonb', 'code', true)
  ) as entries(name, signature, kind, student_access) loop
    select p.oid, p.proargnames, pg_get_function_arguments(p.oid) as arguments
      into fn from pg_proc p
      where p.oid=to_regprocedure(format('public.%I(%s)',entry.name,entry.signature));
    if not found then raise exception 'Required application function is missing: %', entry.name; end if;
    internal_name := entry.name || '_year_base';
    args := fn.arguments;
    select string_agg(quote_ident(name), ', ' order by position)
      into call_args from unnest(fn.proargnames) with ordinality as names(name, position);
    check_sql := case entry.kind
      when 'setup' then 'perform public.assert_course_school_year_active(p_setup->>''schoolYear'');'
      when 'event' then 'perform public.assert_course_event_active(p_event);'
      else 'perform public.assert_course_event_active((select event_id from public.course_students where code_hash=encode(sha256(convert_to(p_code,''UTF8'')),''hex'')));'
    end;
    execute format('alter function public.%I(%s) rename to %I',entry.name,entry.signature,internal_name);
    execute format('revoke all on function public.%I(%s) from public,anon,authenticated',internal_name,entry.signature);
    execute format(
      'create function public.%I(%s) returns jsonb language plpgsql security definer set search_path='''' as $body$ begin %s return public.%I(%s); end; $body$',
      entry.name,args,check_sql,internal_name,call_args);
    execute format('revoke all on function public.%I(%s) from public,anon,authenticated',entry.name,entry.signature);
    execute format('grant execute on function public.%I(%s) to authenticated',entry.name,entry.signature);
    if entry.student_access then
      execute format('grant execute on function public.%I(%s) to anon',entry.name,entry.signature);
    end if;
  end loop;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
