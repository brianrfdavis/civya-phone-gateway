-- Resume context follows the case across voice/text switching and after a
-- prior conversation is cleanly ended. Turns still retain their original
-- conversation and channel for audit/idempotency.

create or replace function public.civya_recent_case_turns(p_case_id uuid, p_limit integer default 6)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(rows) order by rows.sequence_number), '[]'::jsonb)
  from (
    select id, speaker, channel, redacted_text as text, created_at, sequence_number
    from public.turns
    where case_id = p_case_id
      and public.civya_can_access_case(p_case_id)
      and processing_status <> 'failed'
    order by sequence_number desc
    limit least(greatest(p_limit, 1), 6)
  ) rows;
$$;

revoke all on function public.civya_recent_case_turns(uuid, integer) from public;
grant execute on function public.civya_recent_case_turns(uuid, integer) to authenticated, service_role;
