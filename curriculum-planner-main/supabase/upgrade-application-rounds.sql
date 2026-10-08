-- Run once after upgrade-semester-groups.sql to allow additional application rounds.
begin;

alter table public.course_events drop constraint course_events_round_check;
alter table public.course_events add constraint course_events_round_check
  check (round ~ '^[1-9][0-9]{0,8}$');

do $migration$
declare
  definition text;
  old_check text := $old$coalesce(p_setup->>'round', '') not in ('1', '2', '3')$old$;
  new_check text := $new$coalesce(p_setup->>'round', '') !~ '^[1-9][0-9]{0,8}$'$new$;
begin
  select pg_get_functiondef('public.create_course_event_base(jsonb)'::regprocedure)
    into definition;
  if position(new_check in definition) > 0 then
    return;
  end if;
  if position(old_check in definition) = 0 then
    raise exception 'Could not locate the existing application round validation.';
  end if;
  execute replace(definition, old_check,
    new_check);
end;
$migration$;

commit;
