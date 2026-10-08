-- Run once in the project's Supabase SQL Editor after the existing upgrades.
begin;

alter table public.course_events
  add column if not exists result_revision bigint not null default 0;

create or replace function public.bump_course_event_result_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.course_events
  set result_revision = result_revision + 1
  where id = new.event_id;
  return new;
end;
$$;
revoke all on function public.bump_course_event_result_revision() from public, anon, authenticated;

drop trigger if exists course_student_result_revision on public.course_students;
create trigger course_student_result_revision
after update of selections on public.course_students
for each row when (old.selections is distinct from new.selections)
execute function public.bump_course_event_result_revision();

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

commit;
