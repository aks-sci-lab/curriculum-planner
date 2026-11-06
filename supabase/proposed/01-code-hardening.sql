-- 적용 순서: 기존 upgrade-*.sql 전부(마지막은 upgrade-reselection.sql) 뒤에 한 번만 실행.
-- 내용: ① 소금+서버 후추 해시 ② 첫 접속 시 6자리 코드 변경 ③ 접속 실패 잠금 ④ 학생별 코드 재발급 ⑤ 교사 잠금 해제
-- 6자리 숫자는 유지한다. 학생이 입력하는 코드만 salted 해시(code_hmac)로 보관하고,
-- 기존 함수 체인은 건드리지 않도록 "내부 토큰"(서버만 계산 가능한 32자리 hex)을 대신 넘긴다.
begin;

create schema if not exists course_private;
revoke all on schema course_private from public, anon, authenticated;
create table if not exists course_private.pepper(
  id int primary key default 1 check (id = 1), value text not null);
insert into course_private.pepper(value)
  values (replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')) on conflict do nothing;
revoke all on course_private.pepper from public, anon, authenticated;

alter table public.course_events
  add column if not exists code_salt text not null default replace(gen_random_uuid()::text, '-', '');
alter table public.course_students
  add column if not exists code_hmac text,
  add column if not exists code_must_change boolean not null default true,
  add column if not exists code_changed_at timestamptz;
create unique index if not exists course_students_event_code_hmac_key
  on public.course_students(event_id, code_hmac) where code_hmac is not null;

-- 소금(이벤트별) + 후추(서버 전역) 해시. DB만 유출돼도 6자리 대입으로 역산할 수 없다.
create function public.course_code_hash(p_event uuid, p_code text) returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(
    (select value from course_private.pepper) || ':' ||
    (select code_salt from public.course_events where id = p_event) || ':' || p_code, 'UTF8')), 'hex');
$$;
-- 기존 함수 체인이 비교하는 값(= 학생별 내부 토큰). 학생·교사에게는 보이지 않는다.
create function public.course_student_token(p_student uuid) returns text
language sql stable security definer set search_path = '' as $$
  select left(encode(sha256(convert_to(
    (select value from course_private.pepper) || ':token:' || p_student::text, 'UTF8')), 'hex'), 32);
$$;
create function public.course_is_weak_code(p_code text) returns boolean
language sql immutable set search_path = '' as $$
  select p_code ~ '^(.)\1{5}$' or p_code in ('012345','123456','234567','345678','456789','567890',
    '987654','876543','765432','654321','543210','098765','121212','123123','112233','000123');
$$;
create function public.course_new_code() returns text language plpgsql volatile set search_path = '' as $$
declare c text;
begin
  loop
    c := lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))::bit(32)::bigint) % 1000000)::text, 6, '0');
    exit when not public.course_is_weak_code(c);
  end loop;
  return c;
end; $$;
revoke all on function public.course_code_hash(uuid,text), public.course_student_token(uuid),
  public.course_is_weak_code(text), public.course_new_code() from public, anon, authenticated;

-- 기존 6자리 코드 변환: 해시를 한 번만 역산(백만 개 표)해 salted 해시로 옮기고 원본 해시는 토큰 해시로 교체.
-- 이후 기존 코드는 "첫 접속 변경" 대상이 된다. 긴 32자리 구형 코드는 그대로 둔다.
do $convert$
begin
  if exists (select 1 from public.course_students where code_hmac is null) then
    create temporary table course_six_codes on commit drop as
      select lpad(g::text, 6, '0') as code,
             encode(sha256(convert_to(lpad(g::text, 6, '0'), 'UTF8')), 'hex') as h
      from generate_series(0, 999999) g;
    create index on course_six_codes(h);
    update public.course_students s
      set code_hmac = public.course_code_hash(s.event_id, six.code),
          code_hash = encode(sha256(convert_to(public.course_student_token(s.id), 'UTF8')), 'hex'),
          code_must_change = true
      from course_six_codes six where six.h = s.code_hash;
    update public.course_students set code_must_change = false where code_hmac is null;
  end if;
end $convert$;

-- 코드 발급: 전체/개별 모두 salted 해시 저장, 학생은 첫 접속 때 코드를 바꿔야 한다.
alter function public.issue_course_codes(uuid) rename to issue_course_codes_legacy;
revoke all on function public.issue_course_codes_legacy(uuid) from public, anon, authenticated;

create function public.course_assign_code(p_student uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare s public.course_students; c text;
begin
  select * into strict s from public.course_students where id = p_student;
  loop
    c := public.course_new_code();
    begin
      update public.course_students
        set code_hmac = public.course_code_hash(s.event_id, c),
            code_hash = encode(sha256(convert_to(public.course_student_token(s.id), 'UTF8')), 'hex'),
            code_must_change = true, code_changed_at = null
        where id = s.id;
      return c;
    exception when unique_violation then
      -- 같은 이벤트 안 코드 충돌: 다시 뽑는다.
    end;
  end loop;
end; $$;
revoke all on function public.course_assign_code(uuid) from public, anon, authenticated;

create function public.issue_course_codes(p_event uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.course_students; codes jsonb := '[]';
begin
  for s in select * from public.course_students where event_id = p_event
    order by grade::int, classroom::numeric, number::numeric loop
    codes := codes || jsonb_build_array(jsonb_build_object('id', s.id, 'grade', s.grade,
      'classroom', s.classroom, 'number', s.number, 'name', s.name,
      'code', public.course_assign_code(s.id)));
  end loop;
  return jsonb_build_object('id', p_event, 'students', codes);
end; $$;
revoke all on function public.issue_course_codes(uuid) from public, anon, authenticated;

create function public.reissue_course_code(p_event uuid, p_student uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.course_students;
begin
  if auth.uid() is null then raise exception '교사 로그인이 필요합니다.'; end if;
  perform 1 from public.course_events where id = p_event and owner_id = auth.uid() for update;
  if not found then raise exception '본인이 만든 수강신청만 관리할 수 있습니다.'; end if;
  perform public.assert_course_event_active(p_event);
  select * into s from public.course_students where id = p_student and event_id = p_event;
  if not found then raise exception '해당 신청의 학생이 아닙니다.'; end if;
  return jsonb_build_object('id', p_event, 'students', jsonb_build_array(jsonb_build_object(
    'id', s.id, 'grade', s.grade, 'classroom', s.classroom, 'number', s.number, 'name', s.name,
    'code', public.course_assign_code(s.id))));
end; $$;

-- 접속 실패 잠금. 학생 코드만으로 접속하므로 "어느 학생의 실패인지" 알 수 없어 접속지(IP)·이벤트 단위로 센다.
--  · 접속지: 10분 안에 5회 실패 → 10분 잠금(시간 경과로 자동 해제)
--  · 이벤트: 10분 안에 100회 실패(여러 접속지 합산) → 창이 지나갈 때까지 전체 잠금
create table if not exists public.course_code_failures(
  event_id uuid not null references public.course_events(id) on delete cascade,
  client_key text not null,
  fail_count int not null default 0,
  window_start timestamptz not null default clock_timestamp(),
  locked_until timestamptz,
  primary key (event_id, client_key));
alter table public.course_code_failures enable row level security;
revoke all on public.course_code_failures from public, anon, authenticated;

create function public.course_client_key() returns text language sql stable set search_path = '' as $$
  with h as (select nullif(current_setting('request.headers', true), '')::json as j),
  x as (select string_to_array(coalesce(j->>'x-forwarded-for', ''), ',') as parts, j from h)
  select encode(sha256(convert_to(coalesce(nullif(btrim(j->>'cf-connecting-ip'), ''),
    nullif(btrim(j->>'x-real-ip'), ''),
    nullif(btrim(parts[array_length(parts, 1)]), ''), 'unknown'), 'UTF8')), 'hex') from x;
$$;

create function public.course_check_lock(p_event uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare r public.course_code_failures; total int;
begin
  select * into r from public.course_code_failures
    where event_id = p_event and client_key = public.course_client_key();
  if found and r.locked_until > clock_timestamp() then
    return '접속 실패가 5회를 넘어 10분간 잠겼습니다. 잠시 후 다시 시도하거나 선생님께 문의하세요.';
  end if;
  select coalesce(sum(fail_count), 0) into total from public.course_code_failures
    where event_id = p_event and window_start > clock_timestamp() - interval '10 minutes';
  if total >= 100 then
    return '이 신청에 접속 실패가 많아 잠시 제한됩니다. 선생님께 문의하세요.';
  end if;
  return null;
end; $$;

create function public.course_record_failure(p_event uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into public.course_code_failures(event_id, client_key, fail_count, window_start)
  values (p_event, public.course_client_key(), 1, clock_timestamp())
  on conflict (event_id, client_key) do update set
    fail_count = case when public.course_code_failures.window_start < clock_timestamp() - interval '10 minutes'
                      then 1 else public.course_code_failures.fail_count + 1 end,
    window_start = case when public.course_code_failures.window_start < clock_timestamp() - interval '10 minutes'
                        then clock_timestamp() else public.course_code_failures.window_start end
  returning fail_count into n;
  if n >= 5 then
    update public.course_code_failures set locked_until = clock_timestamp() + interval '10 minutes'
      where event_id = p_event and client_key = public.course_client_key();
  end if;
  return n;
end; $$;

-- 성공해도 실패 카운터를 지우지 않는다(자기 코드로 로그인해 카운터를 초기화하며 대입하는 우회 방지).
create function public.course_authenticate(p_event uuid, p_code text,
  out v_error text, out v_student uuid, out v_token text, out v_must_change boolean)
language plpgsql security definer set search_path = '' as $$
declare s public.course_students; n int;
begin
  v_error := public.course_check_lock(p_event);
  if v_error is not null then return; end if;
  if coalesce(p_code, '') ~ '^[0-9]{6}$' then
    select * into s from public.course_students
      where event_id = p_event and code_hmac = public.course_code_hash(p_event, p_code);
    if found then v_student := s.id; v_token := public.course_student_token(s.id); v_must_change := s.code_must_change; end if;
  elsif coalesce(p_code, '') ~ '^[a-f0-9]{32}$' then   -- 내부 토큰 호출 및 구형 긴 코드
    select * into s from public.course_students
      where event_id = p_event and code_hash = encode(sha256(convert_to(p_code, 'UTF8')), 'hex');
    if found then v_student := s.id; v_token := p_code; v_must_change := false; end if;
  end if;
  if v_student is null then
    n := public.course_record_failure(p_event);
    v_error := case when n >= 5 then '접속 실패가 5회를 넘어 10분간 잠겼습니다. 선생님께 문의하세요.'
      else '해당 신청의 개인 코드를 확인하세요. (남은 시도 ' || (5 - n) || '회)' end;
  end if;
end; $$;
revoke all on function public.course_client_key(), public.course_check_lock(uuid),
  public.course_record_failure(uuid), public.course_authenticate(uuid,text) from public, anon, authenticated;

alter function public.get_scoped_course_application(uuid,text) rename to get_scoped_course_application_hardening_base;
alter function public.save_scoped_course_application(uuid,text,jsonb) rename to save_scoped_course_application_hardening_base;
revoke all on function public.get_scoped_course_application_hardening_base(uuid,text),
  public.save_scoped_course_application_hardening_base(uuid,text,jsonb) from public, anon, authenticated;

create function public.get_scoped_course_application(p_event uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a record; e public.course_events; s public.course_students;
begin
  select * into a from public.course_authenticate(p_event, p_code);
  if a.v_error is not null then
    return jsonb_build_object('error', a.v_error, 'locked', a.v_error like '%잠겼%' or a.v_error like '%제한%');
  end if;
  if a.v_must_change then
    perform public.assert_course_event_active(p_event);
    select * into s from public.course_students where id = a.v_student;
    select * into e from public.course_events where id = p_event;
    return jsonb_build_object('mustChangeCode', true, 'schoolName', e.school_name,
      'schoolYear', e.school_year, 'round', e.round,
      'student', jsonb_build_object('grade', s.grade, 'classroom', s.classroom, 'number', s.number, 'name', s.name));
  end if;
  return public.get_scoped_course_application_hardening_base(p_event, a.v_token);
end; $$;

create function public.save_scoped_course_application(p_event uuid, p_code text, p_selections jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a record;
begin
  select * into a from public.course_authenticate(p_event, p_code);
  if a.v_error is not null then
    return jsonb_build_object('error', a.v_error, 'locked', a.v_error like '%잠겼%' or a.v_error like '%제한%');
  end if;
  if a.v_must_change then return jsonb_build_object('error', '먼저 개인 코드를 새 6자리로 변경하세요.'); end if;
  return public.save_scoped_course_application_hardening_base(p_event, a.v_token, p_selections);
end; $$;

create function public.change_course_code(p_event uuid, p_code text, p_new_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a record; n int;
begin
  select * into a from public.course_authenticate(p_event, p_code);
  if a.v_error is not null then
    return jsonb_build_object('error', a.v_error, 'locked', a.v_error like '%잠겼%' or a.v_error like '%제한%');
  end if;
  perform public.assert_course_event_active(p_event);
  if p_code !~ '^[0-9]{6}$' then return jsonb_build_object('error', '이 코드는 변경할 수 없습니다.'); end if;
  if not a.v_must_change then
    return jsonb_build_object('error', '이미 코드를 변경했습니다. 잊었다면 선생님께 재발급을 요청하세요.');
  end if;
  if coalesce(p_new_code, '') !~ '^[0-9]{6}$' then return jsonb_build_object('error', '새 코드는 6자리 숫자여야 합니다.'); end if;
  if p_new_code = p_code then return jsonb_build_object('error', '받은 코드와 다른 새 코드를 정하세요.'); end if;
  if public.course_is_weak_code(p_new_code) then
    return jsonb_build_object('error', '너무 쉬운 번호입니다. 다른 6자리를 정하세요.');
  end if;
  if exists (select 1 from public.course_students where event_id = p_event
      and code_hmac = public.course_code_hash(p_event, p_new_code)) then
    -- 사용 중인 코드를 알아내는 시도도 실패 횟수에 포함한다.
    n := public.course_record_failure(p_event);
    return jsonb_build_object('error', '사용할 수 없는 번호입니다. 다른 6자리를 정하세요.');
  end if;
  update public.course_students set code_hmac = public.course_code_hash(p_event, p_new_code),
    code_must_change = false, code_changed_at = clock_timestamp() where id = a.v_student;
  return jsonb_build_object('message', '코드를 변경했습니다. 지금부터 새 코드로 접속하세요. 처음 받은 코드는 쓸 수 없습니다.');
end; $$;

create function public.unlock_course_event(p_event uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception '교사 로그인이 필요합니다.'; end if;
  perform 1 from public.course_events where id = p_event and owner_id = auth.uid();
  if not found then raise exception '본인이 만든 수강신청만 관리할 수 있습니다.'; end if;
  delete from public.course_code_failures where event_id = p_event;
  return jsonb_build_object('message', '접속 잠금을 모두 해제했습니다.');
end; $$;

revoke all on function public.get_scoped_course_application(uuid,text),
  public.save_scoped_course_application(uuid,text,jsonb), public.change_course_code(uuid,text,text),
  public.reissue_course_code(uuid,uuid), public.unlock_course_event(uuid) from public, anon, authenticated;
grant execute on function public.get_scoped_course_application(uuid,text),
  public.save_scoped_course_application(uuid,text,jsonb), public.change_course_code(uuid,text,text) to anon, authenticated;
grant execute on function public.reissue_course_code(uuid,uuid), public.unlock_course_event(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
