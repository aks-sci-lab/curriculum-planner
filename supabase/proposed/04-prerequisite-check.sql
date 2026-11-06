-- 위계(선이수) '저장 막기' 서버 검증 (제안 · 서버 미적용)
-- 적용 순서: 기존 upgrade-*.sql 전부 뒤(마지막 upgrade-reselection.sql). 01-code-hardening.sql 적용 여부와 무관하게 동작한다.
-- 테이블·열은 바꾸지 않는다. 앱이 수강신청을 만들 때 기존 jsonb에 싣는 점검 정보를 읽는다.
--   · course_events.subjects[학년][i].requires = [{ name, designatedSemester?, options: [과목명], prior?: "elective" }]
--   · course_events.selection_groups[i].checks.blockPrerequisites = true  (교사가 '위계 미충족이면 저장 막기'를 켠 신청)
-- 규칙(학생 화면과 같다): 과목 B(학기 s)를 고르면 각 선이수 A에 대해
--   충족 = 편제표 지정 A가 s보다 앞 학기 | 고른 A 중 s보다 앞 학기가 있음
--   판단 안 함 = B의 학기를 모름 | 고른 A의 학기를 모름 | A가 이전 학년 선택 과목(prior)이고 이번 신청에서 A를 고르지 않음
--   그 밖(같은 학기·뒤 학기 선택, 미선택)은 위반 → 막기를 켠 신청이면 저장을 거절한다.
-- 교사 화면의 학생 선택 수정(save_teacher_course_application)은 막지 않는다(교사가 예외를 둘 수 있게).
begin;

create function public.course_prerequisite_violations(p_courses jsonb, p_selections jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  with courses as (
    select value as c from jsonb_array_elements(case when jsonb_typeof(p_courses) = 'array' then p_courses else '[]'::jsonb end)
  ), chosen as (
    select c from courses where jsonb_typeof(p_selections) = 'array' and p_selections ? (c->>'subject')
  ), rules as (
    select ch.c, r.value as r from chosen ch,
      lateral jsonb_array_elements(case when jsonb_typeof(ch.c->'requires') = 'array' then ch.c->'requires' else '[]'::jsonb end) r
    where coalesce(ch.c->>'semester', '') in ('1', '2')
  ), picked as (
    select ru.c, ru.r, oc.c->>'semester' as semester from rules ru,
      lateral jsonb_array_elements(case when jsonb_typeof(ru.r->'options') = 'array' then ru.r->'options' else '[]'::jsonb end) o
      join courses oc on oc.c->'subject' = o.value
    where p_selections ? (o.value #>> '{}')
  )
  select coalesce(jsonb_agg(jsonb_build_object('course', ru.c->>'subject', 'requires', ru.r->>'name')), '[]'::jsonb)
  from rules ru
  where not (coalesce(ru.r->>'designatedSemester', '') in ('1', '2') and ru.r->>'designatedSemester' < ru.c->>'semester')
    and not exists (select 1 from picked p where p.c = ru.c and p.r = ru.r
      and (coalesce(p.semester, '') not in ('1', '2') or p.semester < ru.c->>'semester'))
    and (coalesce(ru.r->>'prior', '') = '' or exists (select 1 from picked p where p.c = ru.c and p.r = ru.r));
$$;
revoke all on function public.course_prerequisite_violations(jsonb, jsonb) from public, anon, authenticated;

-- 가장 안쪽 저장 함수(모든 학생 저장 경로가 거친다)를 감싼다. 학생은 내부 코드 해시로 찾는다.
alter function public.save_scoped_course_application_base(uuid, text, jsonb) rename to save_scoped_course_application_prereq_base;
revoke all on function public.save_scoped_course_application_prereq_base(uuid, text, jsonb) from public, anon, authenticated;
create function public.save_scoped_course_application_base(p_event uuid, p_code text, p_selections jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e public.course_events; s public.course_students; target text; v jsonb;
begin
  select * into e from public.course_events where id = p_event;
  select * into s from public.course_students
    where event_id = p_event and code_hash = encode(sha256(convert_to(coalesce(p_code, ''), 'UTF8')), 'hex');
  if e.id is not null and s.id is not null then
    target := (s.grade::int + 1)::text;
    if exists (select 1 from jsonb_array_elements(e.selection_groups) g
               where g.value->>'grade' = target and g.value->'checks'->>'blockPrerequisites' = 'true') then
      v := public.course_prerequisite_violations(e.subjects->target, p_selections);
      if jsonb_array_length(v) > 0 then
        raise exception '위계 미충족: %은(는) %을(를) 먼저 이수해야 합니다. 담당 선생님과 상의하세요.',
          v->0->>'course', v->0->>'requires';
      end if;
    end if;
  end if;
  return public.save_scoped_course_application_prereq_base(p_event, p_code, p_selections);
end; $$;
revoke all on function public.save_scoped_course_application_base(uuid, text, jsonb) from public, anon, authenticated;

-- 학생 화면이 '서버가 막기를 지원함'을 알 수 있게 응답에 표시를 붙인다(없으면 학생 화면은 경고만).
alter function public.get_scoped_course_application_base(uuid, text) rename to get_scoped_course_application_prereq_base;
revoke all on function public.get_scoped_course_application_prereq_base(uuid, text) from public, anon, authenticated;
create function public.get_scoped_course_application_base(p_event uuid, p_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return public.get_scoped_course_application_prereq_base(p_event, p_code) || jsonb_build_object('prerequisiteBlock', true);
end; $$;
revoke all on function public.get_scoped_course_application_base(uuid, text) from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
