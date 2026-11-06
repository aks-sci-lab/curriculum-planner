-- 적용 순서: 기존 upgrade-*.sql 전부(마지막은 upgrade-reselection.sql) 뒤에 한 번만 실행.
-- 내용: ① 학생별 소금+서버 후추 해시 ② 반·번호(+학년)+6자리 코드로 접속 ③ 첫 접속 시 코드 변경
--       ④ 학생 단위 접속 잠금(5회→10분, 누적 10회 초과→교사 해제) ⑤ 학생별 코드 재발급·잠금 해제
-- 학생이 입력하는 코드만 salted 해시(code_hmac)로 보관하고, 기존 함수 체인은 건드리지 않도록
-- "내부 토큰"(서버만 계산 가능한 32자리 hex)을 대신 넘긴다.
begin;

create schema if not exists course_private;
revoke all on schema course_private from public, anon, authenticated;
create table if not exists course_private.pepper(
  id int primary key default 1 check (id = 1), value text not null);
insert into course_private.pepper(value)
  values (replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')) on conflict do nothing;
revoke all on course_private.pepper from public, anon, authenticated;

alter table public.course_students
  add column if not exists code_hmac text,
  add column if not exists code_must_change boolean not null default true,
  add column if not exists code_changed_at timestamptz;

-- 학생 id + 서버 후추 해시. 학생마다 소금이 달라 같은 코드를 써도 해시가 다르고, DB만 유출돼도 역산할 수 없다.
create function public.course_code_hash(p_student uuid, p_code text) returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(
    (select value from course_private.pepper) || ':code:' || p_student::text || ':' || p_code, 'UTF8')), 'hex');
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

-- 학생 단위 접속 잠금. 반·번호로 학생을 먼저 찾으므로 "누구의 실패인지" 알 수 있다.
--  · 연속 실패 5회 → 10분 잠금(시간 경과로 자동 해제, 연속 수는 0으로)
--  · 누적 실패 10회(= 10분 잠금 두 번) 뒤 또 실패 → 교사가 풀 때까지 잠금
--  · 성공하면 연속 수만 초기화, 누적 수·잠금 횟수는 교사 해제·코드 재발급 때 초기화
-- 없는 반·번호의 실패는 잠글 학생이 없으므로 기록하지 않는다. 접속지(IP)·이벤트 전체 제한은 두지 않는다.
create table if not exists public.course_code_locks(
  student_id uuid primary key references public.course_students(id) on delete cascade,
  event_id uuid not null references public.course_events(id) on delete cascade,
  fail_streak int not null default 0,
  fail_total int not null default 0,
  lock_count int not null default 0,
  locked_until timestamptz,
  teacher_lock boolean not null default false,
  last_failed_at timestamptz);
create index if not exists course_code_locks_event_idx on public.course_code_locks(event_id);
alter table public.course_code_locks enable row level security;
revoke all on public.course_code_locks from public, anon, authenticated;

-- 기존 6자리 코드 변환: 해시를 한 번만 역산(백만 개 표)해 학생별 salted 해시로 옮기고 원본 해시는 토큰 해시로 교체.
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
      set code_hmac = public.course_code_hash(s.id, six.code),
          code_hash = encode(sha256(convert_to(public.course_student_token(s.id), 'UTF8')), 'hex'),
          code_must_change = true
      from course_six_codes six where six.h = s.code_hash;
    update public.course_students set code_must_change = false where code_hmac is null;
  end if;
end $convert$;

-- 코드 발급: 전체/개별 모두 salted 해시 저장, 학생은 첫 접속 때 코드를 바꿔야 한다. 발급하면 그 학생의 잠금도 풀린다.
alter function public.issue_course_codes(uuid) rename to issue_course_codes_legacy;
revoke all on function public.issue_course_codes_legacy(uuid) from public, anon, authenticated;

create function public.course_assign_code(p_student uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare c text := public.course_new_code();
begin
  -- 학생은 반·번호로 식별하므로 같은 신청 안에서 코드가 겹쳐도 무방하다(겹침 검사 없음).
  update public.course_students
    set code_hmac = public.course_code_hash(id, c),
        code_hash = encode(sha256(convert_to(public.course_student_token(id), 'UTF8')), 'hex'),
        code_must_change = true, code_changed_at = null
    where id = p_student;
  if not found then raise exception '학생을 찾지 못했습니다.'; end if;
  delete from public.course_code_locks where student_id = p_student;
  return c;
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

create function public.course_assert_owner(p_event uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception '교사 로그인이 필요합니다.'; end if;
  perform 1 from public.course_events where id = p_event and owner_id = auth.uid();
  if not found then raise exception '본인이 만든 수강신청만 관리할 수 있습니다.'; end if;
end; $$;
revoke all on function public.course_assert_owner(uuid) from public, anon, authenticated;

create function public.reissue_course_code(p_event uuid, p_student uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.course_students;
begin
  perform public.course_assert_owner(p_event);
  perform 1 from public.course_events where id = p_event for update;
  perform public.assert_course_event_active(p_event);
  select * into s from public.course_students where id = p_student and event_id = p_event;
  if not found then raise exception '해당 신청의 학생이 아닙니다.'; end if;
  return jsonb_build_object('id', p_event, 'students', jsonb_build_array(jsonb_build_object(
    'id', s.id, 'grade', s.grade, 'classroom', s.classroom, 'number', s.number, 'name', s.name,
    'code', public.course_assign_code(s.id))));
end; $$;

create function public.course_lock_message(l public.course_code_locks) returns text
language sql stable set search_path = '' as $$
  select case
    when l.teacher_lock then '접속 실패가 너무 많아 잠겼습니다. 선생님께 잠금 해제를 요청하세요.'
    when l.locked_until > clock_timestamp() then
      '접속에 5회 연속 실패해 10분간 잠겼습니다. 약 '
      || greatest(1, ceil(extract(epoch from l.locked_until - clock_timestamp()) / 60))::int
      || '분 뒤 다시 시도하거나 선생님께 잠금 해제를 요청하세요.'
      || case when l.lock_count >= 2 then ' 다음에 또 틀리면 선생님이 풀어 주실 때까지 잠깁니다.' else '' end
  end;
$$;

-- 학생 확인: 반·번호(+학년)로 학생을 찾고 그 학생의 코드 해시와 비교한다.
-- 없는 반·번호와 틀린 코드는 같은 문구로 답해 학생 존재 여부를 드러내지 않는다.
create function public.course_authenticate_student(p_event uuid, p_grade text, p_classroom text,
  p_number text, p_code text, out v_error text, out v_locked boolean, out v_need_grade boolean,
  out v_student uuid, out v_token text, out v_must_change boolean)
language plpgsql security definer set search_path = '' as $$
declare
  g text := nullif(btrim(coalesce(p_grade, '')), '');
  c text := ltrim(btrim(coalesce(p_classroom, '')), '0');
  n text := ltrim(btrim(coalesce(p_number, '')), '0');
  matches int; s public.course_students; l public.course_code_locks;
begin
  v_locked := false; v_need_grade := false;
  perform public.assert_course_event_active(p_event);
  if (g is not null and g !~ '^[12]$') or c !~ '^[1-9][0-9]{0,2}$' or n !~ '^[1-9][0-9]{0,2}$' then
    v_error := '학년·반·번호를 숫자로 입력하세요.'; return;
  end if;
  if coalesce(p_code, '') !~ '^[0-9]{6}$' then v_error := '6자리 숫자 코드를 입력하세요.'; return; end if;
  if g is null then
    select count(*) into matches from public.course_students
      where event_id = p_event and classroom = c and number = n;
    if matches > 1 then v_error := '학년을 선택하세요.'; v_need_grade := true; return; end if;
  end if;
  select * into s from public.course_students
    where event_id = p_event and classroom = c and number = n and (g is null or grade = g) for update;
  if not found then v_error := '반·번호 또는 코드가 맞지 않습니다.'; return; end if;

  select * into l from public.course_code_locks where student_id = s.id;
  if found and (l.teacher_lock or l.locked_until > clock_timestamp()) then
    v_error := public.course_lock_message(l); v_locked := true; return;
  end if;

  if s.code_hmac is not null and s.code_hmac = public.course_code_hash(s.id, p_code) then
    update public.course_code_locks set fail_streak = 0 where student_id = s.id and fail_streak <> 0;
    v_student := s.id; v_token := public.course_student_token(s.id); v_must_change := s.code_must_change;
    return;
  end if;

  insert into public.course_code_locks(student_id, event_id) values (s.id, s.event_id)
    on conflict (student_id) do nothing;
  update public.course_code_locks set fail_streak = fail_streak + 1, fail_total = fail_total + 1,
    last_failed_at = clock_timestamp() where student_id = s.id returning * into l;
  if l.fail_total > 10 then
    update public.course_code_locks set teacher_lock = true, locked_until = null, fail_streak = 0
      where student_id = s.id returning * into l;
  elsif l.fail_streak >= 5 then
    update public.course_code_locks set locked_until = clock_timestamp() + interval '10 minutes',
      fail_streak = 0, lock_count = lock_count + 1 where student_id = s.id returning * into l;
  end if;
  v_error := public.course_lock_message(l);
  v_locked := v_error is not null;
  if not v_locked then v_error := '반·번호 또는 코드가 맞지 않습니다.'; end if;
end; $$;
revoke all on function public.course_lock_message(public.course_code_locks),
  public.course_authenticate_student(uuid,text,text,text,text) from public, anon, authenticated;

create function public.course_auth_error(p_error text, p_locked boolean, p_need_grade boolean) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object('error', p_error,
    'locked', case when p_locked then true end, 'needGrade', case when p_need_grade then true end));
$$;
revoke all on function public.course_auth_error(text,boolean,boolean) from public, anon, authenticated;

alter function public.get_scoped_course_application(uuid,text) rename to get_scoped_course_application_hardening_base;
alter function public.save_scoped_course_application(uuid,text,jsonb) rename to save_scoped_course_application_hardening_base;
revoke all on function public.get_scoped_course_application_hardening_base(uuid,text),
  public.save_scoped_course_application_hardening_base(uuid,text,jsonb) from public, anon, authenticated;

-- 기존 이름(코드만 받는 입구)은 내부 토큰·구형 32자리 코드만 받는다. 기존 함수 체인이 이 이름을 내부에서 부른다.
-- 6자리 코드만으로는 접속할 수 없다(반·번호 없이 대입하는 경로 차단).
create function public.get_scoped_course_application(p_event uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(p_code, '') ~ '^[a-f0-9]{32}$' then
    return public.get_scoped_course_application_hardening_base(p_event, p_code);
  end if;
  return jsonb_build_object('error', '반·번호와 개인 코드를 함께 입력해야 합니다. 화면을 새로고침한 뒤 다시 접속하세요.');
end; $$;

create function public.save_scoped_course_application(p_event uuid, p_code text, p_selections jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(p_code, '') ~ '^[a-f0-9]{32}$' then
    return public.save_scoped_course_application_hardening_base(p_event, p_code, p_selections);
  end if;
  return jsonb_build_object('error', '반·번호와 개인 코드를 함께 입력해야 합니다. 화면을 새로고침한 뒤 다시 접속하세요.');
end; $$;

-- 학생 접속 화면이 학년 선택 칸을 보일지 정한다(학생 정보는 주지 않는다).
create function public.get_course_login_form(p_event uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e public.course_events;
begin
  perform public.assert_course_event_active(p_event);
  select * into e from public.course_events where id = p_event;
  return jsonb_build_object('schoolName', e.school_name, 'schoolYear', e.school_year, 'round', e.round,
    'grades', coalesce((select jsonb_agg(grade order by grade) from
      (select distinct grade from public.course_students where event_id = p_event) g), '[]'::jsonb));
end; $$;

create function public.get_student_course_application(p_event uuid, p_grade text, p_classroom text,
  p_number text, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a record; e public.course_events; s public.course_students;
begin
  select * into a from public.course_authenticate_student(p_event, p_grade, p_classroom, p_number, p_code);
  if a.v_error is not null then return public.course_auth_error(a.v_error, a.v_locked, a.v_need_grade); end if;
  if a.v_must_change then
    select * into s from public.course_students where id = a.v_student;
    select * into e from public.course_events where id = p_event;
    return jsonb_build_object('mustChangeCode', true, 'schoolName', e.school_name,
      'schoolYear', e.school_year, 'round', e.round,
      'student', jsonb_build_object('grade', s.grade, 'classroom', s.classroom, 'number', s.number, 'name', s.name));
  end if;
  return public.get_scoped_course_application_hardening_base(p_event, a.v_token);
end; $$;

create function public.save_student_course_application(p_event uuid, p_grade text, p_classroom text,
  p_number text, p_code text, p_selections jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a record;
begin
  select * into a from public.course_authenticate_student(p_event, p_grade, p_classroom, p_number, p_code);
  if a.v_error is not null then return public.course_auth_error(a.v_error, a.v_locked, a.v_need_grade); end if;
  if a.v_must_change then return jsonb_build_object('error', '먼저 개인 코드를 새 6자리로 변경하세요.'); end if;
  return public.save_scoped_course_application_hardening_base(p_event, a.v_token, p_selections);
end; $$;

create function public.change_course_code(p_event uuid, p_grade text, p_classroom text,
  p_number text, p_code text, p_new_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a record;
begin
  select * into a from public.course_authenticate_student(p_event, p_grade, p_classroom, p_number, p_code);
  if a.v_error is not null then return public.course_auth_error(a.v_error, a.v_locked, a.v_need_grade); end if;
  if not a.v_must_change then
    return jsonb_build_object('error', '이미 코드를 변경했습니다. 잊었다면 선생님께 재발급을 요청하세요.');
  end if;
  if coalesce(p_new_code, '') !~ '^[0-9]{6}$' then return jsonb_build_object('error', '새 코드는 6자리 숫자여야 합니다.'); end if;
  if p_new_code = p_code then return jsonb_build_object('error', '받은 코드와 다른 새 코드를 정하세요.'); end if;
  if public.course_is_weak_code(p_new_code) then
    return jsonb_build_object('error', '너무 쉬운 번호입니다. 다른 6자리를 정하세요.');
  end if;
  -- 다른 학생과 코드가 겹쳐도 반·번호로 구분하므로 검사하지 않는다(검사하면 남의 코드를 알아내는 단서가 된다).
  update public.course_students set code_hmac = public.course_code_hash(id, p_new_code),
    code_must_change = false, code_changed_at = clock_timestamp() where id = a.v_student;
  return jsonb_build_object('message', '코드를 변경했습니다. 지금부터 새 코드로 접속하세요. 처음 받은 코드는 쓸 수 없습니다.');
end; $$;

-- 교사: 학생별 잠금 현황(실패 기록이 있거나 잠긴 학생만).
create function public.get_course_code_locks(p_event uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform public.course_assert_owner(p_event);
  return jsonb_build_object('students', coalesce((select jsonb_agg(jsonb_build_object(
      'id', s.id, 'grade', s.grade, 'classroom', s.classroom, 'number', s.number, 'name', s.name,
      'failStreak', l.fail_streak, 'failTotal', l.fail_total, 'lockCount', l.lock_count,
      'teacherLock', l.teacher_lock,
      'lockedSeconds', case when not l.teacher_lock and l.locked_until > clock_timestamp()
        then ceil(extract(epoch from l.locked_until - clock_timestamp()))::int else 0 end,
      'lastFailedAt', l.last_failed_at)
      order by s.grade::int, s.classroom::numeric, s.number::numeric)
    from public.course_code_locks l join public.course_students s on s.id = l.student_id
    where l.event_id = p_event and (l.fail_total > 0 or l.teacher_lock)), '[]'::jsonb));
end; $$;

create function public.unlock_course_student(p_event uuid, p_student uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.course_students;
begin
  perform public.course_assert_owner(p_event);
  select * into s from public.course_students where id = p_student and event_id = p_event;
  if not found then raise exception '해당 신청의 학생이 아닙니다.'; end if;
  delete from public.course_code_locks where student_id = p_student;
  return jsonb_build_object('message', s.grade || '학년 ' || s.classroom || '반 ' || s.number || '번 '
    || s.name || ' 학생의 접속 잠금을 해제했습니다.');
end; $$;

create function public.unlock_course_event(p_event uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform public.course_assert_owner(p_event);
  delete from public.course_code_locks where event_id = p_event;
  get diagnostics n = row_count;
  return jsonb_build_object('message', '학생 ' || n || '명의 접속 잠금·실패 기록을 모두 해제했습니다.');
end; $$;

revoke all on function public.get_scoped_course_application(uuid,text),
  public.save_scoped_course_application(uuid,text,jsonb), public.get_course_login_form(uuid),
  public.get_student_course_application(uuid,text,text,text,text),
  public.save_student_course_application(uuid,text,text,text,text,jsonb),
  public.change_course_code(uuid,text,text,text,text,text),
  public.reissue_course_code(uuid,uuid), public.get_course_code_locks(uuid),
  public.unlock_course_student(uuid,uuid), public.unlock_course_event(uuid) from public, anon, authenticated;
grant execute on function public.get_scoped_course_application(uuid,text),
  public.save_scoped_course_application(uuid,text,jsonb), public.get_course_login_form(uuid),
  public.get_student_course_application(uuid,text,text,text,text),
  public.save_student_course_application(uuid,text,text,text,text,jsonb),
  public.change_course_code(uuid,text,text,text,text,text) to anon, authenticated;
grant execute on function public.reissue_course_code(uuid,uuid), public.get_course_code_locks(uuid),
  public.unlock_course_student(uuid,uuid), public.unlock_course_event(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
