-- DRAFT. 현재는 학년도 종료(다음해 3/1) 후 접속만 막고 데이터는 영구 보존됨.
-- 학년도 종료 + 180일 뒤 명렬·신청·이력을 삭제한다(on delete cascade).
begin;
alter table public.course_events add column if not exists purge_after timestamptz;
update public.course_events set purge_after = public.course_school_year_expires_at(school_year) + interval '180 days'
  where purge_after is null;
create function public.course_events_set_purge_after() returns trigger language plpgsql set search_path='' as $$
begin new.purge_after := coalesce(new.purge_after, public.course_school_year_expires_at(new.school_year) + interval '180 days'); return new; end; $$;
create trigger course_events_purge_after before insert on public.course_events
  for each row execute function public.course_events_set_purge_after();

create function public.purge_expired_course_events() returns int
language plpgsql security definer set search_path='' as $$
declare n int; begin
  delete from public.course_events where purge_after < clock_timestamp();
  get diagnostics n = row_count; return n;
end; $$;
revoke all on function public.purge_expired_course_events() from public, anon, authenticated;
-- pg_cron 사용 시(Supabase: Database > Extensions 에서 켠 뒤):
--   select cron.schedule('purge-course-events','17 3 * * *','select public.purge_expired_course_events()');
commit;
