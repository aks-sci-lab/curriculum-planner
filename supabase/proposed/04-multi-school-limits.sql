-- DRAFT(서버 미적용). 여러 학교가 한 서버를 함께 쓸 때의 안전장치. 01~03과 겹치지 않는다(03 = 학년도 종료 +180일 자동 삭제).
-- 적용 순서: 기존 upgrade-*.sql 전체 → (01, 02, 03은 각자 README대로) → 이 파일. 01·03을 적용하지 않았어도 단독으로 실행된다.
--  1) 학교 이름: 앞뒤 공백을 뺀 2~60자(지금은 1자 이상이면 통과).
--  2) 계정당 수강신청 수 제한(기본 30개, 학년도가 끝난 신청 포함). 넘으면 끝난 신청을 지우라고 안내.
--     계정당 학생 수 합계 제한(기본 20,000명). 신청 하나의 명렬 상한(10,000명)은 그대로.
--  3) 학년도가 끝난 뒤(다음 해 3월 1일~)에도 만든 교사가 자기 신청을 보고 지울 수 있는 입구
--     (지금은 학년도가 끝나면 목록·삭제가 모두 막혀 교사가 직접 지울 방법이 없다).
-- 되돌리기: 맨 아래 주석.
begin;

create table if not exists public.course_limits (
  id boolean primary key default true check (id),
  max_events_per_owner int not null default 30 check (max_events_per_owner between 1 and 1000),
  max_students_per_owner int not null default 20000 check (max_students_per_owner between 1 and 1000000)
);
insert into public.course_limits(id) values (true) on conflict do nothing;
alter table public.course_limits enable row level security;
revoke all on table public.course_limits from public, anon, authenticated;

-- 신청을 만들 때(새 신청·다음 차수 모두 course_events에 넣는다) 학교 이름과 계정당 개수를 본다.
create or replace function public.course_events_enforce_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_max int; v_count int;
begin
  new.school_name := btrim(new.school_name);
  if length(new.school_name) not between 2 and 60 then
    raise exception '학교 이름을 2~60자로 입력하세요(학교·학년도 설정).';
  end if;
  select max_events_per_owner into v_max from public.course_limits;
  -- 같은 계정이 동시에 만들어도 세는 값이 어긋나지 않게 계정 단위로 잠근다.
  perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text, 7));
  select count(*) into v_count from public.course_events where owner_id = new.owner_id;
  if v_count >= coalesce(v_max, 30) then
    raise exception '한 계정으로 만들 수 있는 수강신청은 %개까지입니다. 끝난 신청을 ''명렬·결과 영구 삭제''로 지운 뒤 다시 만드세요.', coalesce(v_max, 30);
  end if;
  return new;
end; $$;
drop trigger if exists course_events_enforce_limits on public.course_events;
create trigger course_events_enforce_limits before insert on public.course_events
  for each row execute function public.course_events_enforce_limits();

-- 명렬을 넣을 때 계정당 학생 수 합계를 본다(문장 단위 한 번).
create or replace function public.course_students_enforce_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_max int; v_over uuid;
begin
  select max_students_per_owner into v_max from public.course_limits;
  select e.owner_id into v_over
  from public.course_events e join public.course_students s on s.event_id = e.id
  where e.owner_id in (select e2.owner_id from public.course_events e2 where e2.id in (select event_id from added))
  group by e.owner_id having count(*) > coalesce(v_max, 20000) limit 1;
  if v_over is not null then
    raise exception '한 계정에 저장할 수 있는 학생은 모두 %명까지입니다. 끝난 신청을 지운 뒤 다시 만드세요.', coalesce(v_max, 20000);
  end if;
  return null;
end; $$;
drop trigger if exists course_students_enforce_limits on public.course_students;
create trigger course_students_enforce_limits after insert on public.course_students
  referencing new table as added for each statement execute function public.course_students_enforce_limits();

-- 학년도가 끝난 신청까지 포함한 내 신청 목록(이름·성적 없음: 개수만).
create or replace function public.list_own_course_events() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception '교사 로그인이 필요합니다.'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'schoolName', e.school_name, 'schoolYear', e.school_year, 'round', e.round,
      'createdAt', e.created_at, 'active', public.course_school_year_active(e.school_year),
      'students', (select count(*) from public.course_students s where s.event_id = e.id)
    ) order by e.created_at), '[]'::jsonb)
    from public.course_events e where e.owner_id = auth.uid());
end; $$;

-- 내 신청 지우기(학년도가 끝난 것도). 명렬·신청·이력은 on delete cascade로 함께 지워진다.
create or replace function public.delete_own_course_event(p_event uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_students int;
begin
  if auth.uid() is null then raise exception '교사 로그인이 필요합니다.'; end if;
  perform 1 from public.course_events where id = p_event and owner_id = auth.uid() for update;
  if not found then raise exception '본인이 만든 수강신청만 지울 수 있습니다.'; end if;
  select count(*) into v_students from public.course_students where event_id = p_event;
  delete from public.course_events where id = p_event;
  return jsonb_build_object('message', format('수강신청과 학생 %s명의 명렬·신청을 서버에서 지웠습니다.', v_students), 'students', v_students);
end; $$;

-- 내 계정의 모든 신청 지우기(담당자가 바뀌거나 앱을 더 쓰지 않을 때).
create or replace function public.delete_all_own_course_events() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_events int;
begin
  if auth.uid() is null then raise exception '교사 로그인이 필요합니다.'; end if;
  delete from public.course_events where owner_id = auth.uid();
  get diagnostics v_events = row_count;
  return jsonb_build_object('message', format('이 계정의 수강신청 %s개와 그 명렬·신청을 서버에서 모두 지웠습니다.', v_events), 'events', v_events);
end; $$;

revoke all on function public.course_events_enforce_limits(), public.course_students_enforce_limits(),
  public.list_own_course_events(), public.delete_own_course_event(uuid), public.delete_all_own_course_events()
  from public, anon, authenticated;
grant execute on function public.list_own_course_events(), public.delete_own_course_event(uuid),
  public.delete_all_own_course_events() to authenticated;

notify pgrst, 'reload schema';
commit;

-- 운영자용(대시보드 SQL Editor에서 직접):
--   한도 바꾸기:  update public.course_limits set max_events_per_owner = 50;
--   계정별 사용량: select owner_id, count(*) events, (select count(*) from public.course_students s join public.course_events e2
--                   on e2.id = s.event_id where e2.owner_id = e.owner_id) students from public.course_events e group by owner_id;
-- 되돌리기:
--   drop trigger course_events_enforce_limits on public.course_events;
--   drop trigger course_students_enforce_limits on public.course_students;
--   drop function public.course_events_enforce_limits(), public.course_students_enforce_limits(),
--     public.list_own_course_events(), public.delete_own_course_event(uuid), public.delete_all_own_course_events();
--   drop table public.course_limits;
