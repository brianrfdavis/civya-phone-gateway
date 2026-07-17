-- Durable, entitlement-bound resident reminders.
--
-- A reminder is a request to send generic account-navigation content. It is
-- never evidence that Wayne County received, accepted, or approved anything.
-- Browser roles cannot write this lane. Scheduling, cancellation, dispatch,
-- suppression, and provider receipts all cross service-only RPCs.

create table public.communication_template_versions (
  id uuid primary key default gen_random_uuid(),
  template_key text not null check (template_key ~ '^[a-z0-9][a-z0-9._-]*$'),
  version text not null check (version ~ '^[a-z0-9][a-z0-9._-]*$'),
  channel text not null check (channel in ('sms', 'email')),
  locale text not null default 'en-US' check (locale ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  body_template text not null check (char_length(body_template) between 20 and 480),
  allowed_variables text[] not null default '{}'::text[],
  contains_sensitive_content boolean not null default false check (not contains_sensitive_content),
  approval_state text not null check (approval_state in ('approved', 'retired')),
  approval_authority text not null,
  approved_at timestamptz not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (template_key, version),
  check (array_position(allowed_variables, null) is null),
  check (effective_to is null or effective_to > effective_from)
);

insert into public.communication_template_versions (
  id, template_key, version, channel, locale, body_template,
  allowed_variables, contains_sensitive_content, approval_state,
  approval_authority, approved_at, effective_from, content_sha256
) values (
  'c2100000-0000-4000-8000-000000000001',
  'civya.secure_account_reminder', 'v1', 'sms', 'en-US',
  'Civya reminder: sign in using this secure link to review your saved next step. This text does not confirm County receipt or approval. {{secure_link}}',
  array['secure_link']::text[], false, 'approved',
  'civya-security-and-privacy-review-v1', now(), now(),
  encode(sha256(convert_to(
    'Civya reminder: sign in using this secure link to review your saved next step. This text does not confirm County receipt or approval. {{secure_link}}',
    'UTF8'
  )), 'hex')
);

alter table public.communication_template_versions enable row level security;
revoke all on public.communication_template_versions from public, anon, authenticated, service_role;
grant select on public.communication_template_versions to service_role;

create trigger communication_template_versions_immutable
  before update or delete on public.communication_template_versions
  for each row execute function private.civya_reject_immutable_outcome_mutation();

alter table public.reminders
  add column channel_consent_id uuid references public.consent(id) on delete restrict,
  add column entitlement_id uuid references public.case_entitlements(id) on delete restrict,
  add column template_id uuid references public.communication_template_versions(id) on delete restrict,
  add column delivery_id uuid references public.communication_deliveries(id) on delete restrict,
  add column quiet_hours_timezone text,
  add column quiet_hours_policy_version text,
  add column quiet_hours_checked_at timestamptz,
  add column accepted_at timestamptz,
  add column delivered_at timestamptz,
  add column cancelled_at timestamptz,
  add column suppression_reason_code text,
  add column row_version bigint not null default 1;

create unique index reminders_delivery_unique_idx
  on public.reminders (delivery_id) where delivery_id is not null;
create index reminders_due_dispatch_idx
  on public.reminders (tenant_id, scheduled_for)
  where status in ('scheduled', 'queued');

alter table public.reminders drop constraint if exists reminders_status_check;
alter table public.reminders add constraint reminders_status_check
  check (status in (
    'scheduled', 'queued', 'accepted', 'sent', 'delivered', 'failed',
    'failed_unknown', 'cancelled', 'suppressed'
  ));

alter table public.communication_deliveries
  add column template_id uuid references public.communication_template_versions(id) on delete restrict,
  add column provider_reference_digest text
    check (provider_reference_digest is null or provider_reference_digest ~ '^[0-9a-f]{64}$'),
  add column contact_reference_digest text
    check (contact_reference_digest is null or contact_reference_digest ~ '^[0-9a-f]{64}$'),
  add column accepted_at timestamptz,
  add column failure_reason_code text;

alter table public.communication_deliveries
  drop constraint if exists communication_deliveries_status_check;
alter table public.communication_deliveries
  add constraint communication_deliveries_status_check
  check (status in (
    'planned', 'queued', 'accepted', 'sent', 'delivered', 'failed',
    'failed_unknown', 'suppressed', 'cancelled'
  ));

create unique index communication_delivery_events_dispatch_dedupe_idx
  on public.communication_delivery_events (tenant_id, delivery_id, event_type, payload_sha256)
  where provider_event_id is null;

create table private.communication_suppressions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  resident_id uuid not null references public.residents(id) on delete cascade,
  channel text not null check (channel in ('sms', 'email')),
  contact_reference_digest text not null check (contact_reference_digest ~ '^[0-9a-f]{64}$'),
  reason_code text not null,
  source text not null check (source in ('provider', 'resident', 'staff', 'system')),
  provider_event_id text,
  suppressed_at timestamptz not null default now(),
  lifted_at timestamptz,
  lifted_reason text,
  created_at timestamptz not null default now(),
  check ((lifted_at is null) = (lifted_reason is null))
);

create unique index communication_suppressions_one_active_idx
  on private.communication_suppressions (tenant_id, resident_id, channel, contact_reference_digest)
  where lifted_at is null;
create unique index communication_suppressions_provider_event_idx
  on private.communication_suppressions (tenant_id, provider_event_id)
  where provider_event_id is not null;

alter table private.communication_suppressions enable row level security;
revoke all on private.communication_suppressions from public, anon, authenticated, service_role;

create or replace function private.civya_exact_reminder_entitlement(
  p_actor_user_id uuid,
  p_case_id uuid,
  p_entitlement_id uuid
)
returns public.case_entitlements
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare v_entitlement public.case_entitlements%rowtype;
begin
  select e.* into v_entitlement
  from public.case_entitlements e
  join public.cases c on c.id = e.case_id
  join public.residents r on r.id = e.resident_id
  join public.tenants t on t.id = e.tenant_id
  join public.identity_proof_challenges p on p.id = e.proof_challenge_id
  where e.id = p_entitlement_id
    and e.case_id = p_case_id
    and e.auth_user_id = p_actor_user_id
    and e.tenant_id = c.tenant_id
    and e.resident_id = c.resident_id
    and r.id = c.resident_id
    and r.tenant_id = c.tenant_id
    and r.auth_user_id = p_actor_user_id
    and r.identity_state = 'verified'
    and t.id = c.tenant_id
    and t.status = 'active'
    and t.environment = 'production'
    and not t.fictional
    and c.active
    and e.state = 'active'
    and e.revoked_at is null
    and e.expires_at > now()
    and array['case.read', 'case.participate']::text[] <@ e.scopes
    and p.tenant_id = e.tenant_id
    and p.case_id = e.case_id
    and p.resident_id = e.resident_id
    and p.auth_user_id = e.auth_user_id
    and p.state = 'verified'
    and private.civya_entitlement_has_current_proof(e.id);
  if not found then
    raise exception 'active exact reminder entitlement not found' using errcode = '42501';
  end if;
  return v_entitlement;
end;
$$;

revoke all on function private.civya_exact_reminder_entitlement(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.civya_service_schedule_entitled_reminder(
  p_actor_user_id uuid,
  p_case_id uuid,
  p_entitlement_id uuid,
  p_channel text,
  p_scheduled_for timestamptz,
  p_timezone text,
  p_template_key text,
  p_template_version text,
  p_consent_policy_version text,
  p_confirm_channel_consent boolean,
  p_confirm_reminder_consent boolean,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_entitlement public.case_entitlements%rowtype;
  v_template public.communication_template_versions%rowtype;
  v_existing public.reminders%rowtype;
  v_channel_consent public.consent%rowtype;
  v_reminder_consent public.consent%rowtype;
  v_delivery public.communication_deliveries%rowtype;
  v_reminder public.reminders%rowtype;
  v_outbox private.outbox_events%rowtype;
  v_local timestamp;
  v_local_hour integer;
begin
  perform private.civya_service_required();
  v_entitlement := private.civya_exact_reminder_entitlement(
    p_actor_user_id, p_case_id, p_entitlement_id
  );
  if p_channel <> 'sms' then
    raise exception 'only the approved SMS reminder channel is available' using errcode = '22023';
  end if;
  if p_consent_policy_version <> 'civya-reminder-consent-v1'
     or not coalesce(p_confirm_channel_consent, false)
     or not coalesce(p_confirm_reminder_consent, false) then
    raise exception 'explicit channel and reminder consent are required' using errcode = '42501';
  end if;
  if nullif(trim(p_idempotency_key), '') is null or length(p_idempotency_key) > 160
     or p_idempotency_key !~ '^[A-Za-z0-9_.:-]+$' then
    raise exception 'invalid reminder idempotency key' using errcode = '22023';
  end if;
  if p_scheduled_for < now() + interval '5 minutes'
     or p_scheduled_for > now() + interval '90 days' then
    raise exception 'reminder time must be between five minutes and 90 days away'
      using errcode = '22023';
  end if;
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'unknown reminder timezone' using errcode = '22023';
  end if;
  v_local := p_scheduled_for at time zone p_timezone;
  v_local_hour := extract(hour from v_local)::integer;
  if v_local_hour < 8 or v_local_hour >= 21 then
    raise exception 'reminder time is within quiet hours' using errcode = '22023';
  end if;

  select * into v_template
  from public.communication_template_versions
  where template_key = p_template_key
    and version = p_template_version
    and channel = p_channel
    and approval_state = 'approved'
    and not contains_sensitive_content
    and allowed_variables = array['secure_link']::text[]
    and effective_from <= now()
    and (effective_to is null or effective_to > now());
  if not found then
    raise exception 'approved reminder template not found' using errcode = '55000';
  end if;

  select * into v_existing from public.reminders
  where tenant_id = v_entitlement.tenant_id
    and case_id = p_case_id
    and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.resident_id <> v_entitlement.resident_id
       or v_existing.entitlement_id <> p_entitlement_id
       or v_existing.channel <> p_channel
       or v_existing.scheduled_for <> p_scheduled_for
       or v_existing.template_id <> v_template.id
       or v_existing.quiet_hours_timezone <> p_timezone then
      raise exception 'reminder idempotency conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'reminderId', v_existing.id,
      'deliveryId', v_existing.delivery_id,
      'status', v_existing.status,
      'scheduledFor', v_existing.scheduled_for,
      'duplicate', true,
      'deliveryAuthority', 'provider_receipt_required'
    );
  end if;

  insert into public.consent (
    tenant_id, resident_id, case_id, consent_type, consent_text,
    granted, source, idempotency_key
  ) values (
    v_entitlement.tenant_id, v_entitlement.resident_id, p_case_id, p_channel,
    p_consent_policy_version || ': explicit SMS channel consent',
    true, 'resident', left(p_idempotency_key || ':channel-consent', 200)
  ) returning * into v_channel_consent;

  insert into public.consent (
    tenant_id, resident_id, case_id, consent_type, consent_text,
    granted, source, idempotency_key
  ) values (
    v_entitlement.tenant_id, v_entitlement.resident_id, p_case_id, 'reminder',
    p_consent_policy_version || ': explicit reminder consent',
    true, 'resident', left(p_idempotency_key || ':reminder-consent', 200)
  ) returning * into v_reminder_consent;

  insert into public.communication_deliveries (
    tenant_id, resident_id, case_id, consent_id, channel, message_type,
    redacted_preview, provider_key, status, idempotency_key, scheduled_for,
    template_id
  ) values (
    v_entitlement.tenant_id, v_entitlement.resident_id, p_case_id,
    v_reminder_consent.id, p_channel, 'secure_account_reminder',
    'Generic Civya account reminder; no case details or County outcome content.',
    'twilio', 'planned', 'reminder-delivery:' || p_idempotency_key,
    p_scheduled_for, v_template.id
  ) returning * into v_delivery;

  insert into public.reminders (
    tenant_id, resident_id, case_id, consent_id, channel_consent_id,
    entitlement_id, template_id, delivery_id, channel, scheduled_for,
    message_type, redacted_message, status, idempotency_key,
    quiet_hours_timezone, quiet_hours_policy_version, quiet_hours_checked_at
  ) values (
    v_entitlement.tenant_id, v_entitlement.resident_id, p_case_id,
    v_reminder_consent.id, v_channel_consent.id, p_entitlement_id,
    v_template.id, v_delivery.id, p_channel, p_scheduled_for,
    'secure_account_reminder',
    'Generic Civya account reminder; no case details or County outcome content.',
    'scheduled', p_idempotency_key, p_timezone,
    'civya-quiet-hours-0800-2100-v1', now()
  ) returning * into v_reminder;

  insert into private.outbox_events (
    tenant_id, aggregate_type, aggregate_id, event_type, schema_version,
    payload, idempotency_key
  ) values (
    v_entitlement.tenant_id, 'reminder', v_reminder.id,
    'reminder.delivery.requested', '1',
    jsonb_build_object(
      'reminderId', v_reminder.id,
      'deliveryId', v_delivery.id,
      'caseId', p_case_id,
      'residentId', v_entitlement.resident_id,
      'templateId', v_template.id,
      'notBefore', p_scheduled_for
    ),
    'reminder:' || v_reminder.id::text || ':delivery'
  ) returning * into v_outbox;

  insert into public.audit_events (
    tenant_id, resident_id, case_id, actor_user_id,
    event_type, redacted_payload, source
  ) values (
    v_entitlement.tenant_id, v_entitlement.resident_id, p_case_id,
    p_actor_user_id, 'reminder_scheduled',
    jsonb_build_object(
      'reminderId', v_reminder.id,
      'deliveryId', v_delivery.id,
      'channel', p_channel,
      'scheduledFor', p_scheduled_for,
      'templateKey', v_template.template_key,
      'templateVersion', v_template.version,
      'quietHoursPolicyVersion', v_reminder.quiet_hours_policy_version,
      'outboxEventId', v_outbox.id
    ),
    'resident'
  );

  return jsonb_build_object(
    'reminderId', v_reminder.id,
    'deliveryId', v_delivery.id,
    'status', v_reminder.status,
    'scheduledFor', v_reminder.scheduled_for,
    'duplicate', false,
    'deliveryAuthority', 'provider_receipt_required'
  );
end;
$$;

create or replace function public.civya_service_get_entitled_reminders(
  p_actor_user_id uuid,
  p_case_id uuid,
  p_entitlement_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare v_entitlement public.case_entitlements%rowtype; v_result jsonb;
begin
  perform private.civya_service_required();
  v_entitlement := private.civya_exact_reminder_entitlement(
    p_actor_user_id, p_case_id, p_entitlement_id
  );
  select coalesce(jsonb_agg(jsonb_build_object(
    'reminderId', r.id,
    'deliveryId', r.delivery_id,
    'status', r.status,
    'scheduledFor', r.scheduled_for,
    'channel', r.channel,
    'acceptedAt', r.accepted_at,
    'deliveredAt', r.delivered_at,
    'canCancel', r.status in ('scheduled', 'queued')
  ) order by r.created_at desc), '[]'::jsonb)
  into v_result
  from public.reminders r
  where r.tenant_id = v_entitlement.tenant_id
    and r.resident_id = v_entitlement.resident_id
    and r.case_id = p_case_id
    and r.entitlement_id = p_entitlement_id;
  return v_result;
end;
$$;

create or replace function public.civya_service_cancel_entitled_reminder(
  p_actor_user_id uuid,
  p_case_id uuid,
  p_entitlement_id uuid,
  p_reminder_id uuid,
  p_reason_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_entitlement public.case_entitlements%rowtype;
  v_reminder public.reminders%rowtype;
begin
  perform private.civya_service_required();
  v_entitlement := private.civya_exact_reminder_entitlement(
    p_actor_user_id, p_case_id, p_entitlement_id
  );
  select * into v_reminder from public.reminders
  where id = p_reminder_id
    and tenant_id = v_entitlement.tenant_id
    and resident_id = v_entitlement.resident_id
    and case_id = p_case_id
    and entitlement_id = p_entitlement_id
  for update;
  if not found then raise exception 'reminder not found' using errcode = 'P0002'; end if;
  if v_reminder.status in ('cancelled', 'suppressed', 'failed', 'failed_unknown', 'delivered') then
    return jsonb_build_object(
      'reminderId', v_reminder.id, 'status', v_reminder.status,
      'cancelled', v_reminder.status = 'cancelled', 'duplicate', true
    );
  end if;
  if v_reminder.status not in ('scheduled', 'queued') then
    raise exception 'accepted reminders can no longer be cancelled' using errcode = '55000';
  end if;
  update public.reminders set
    status = 'cancelled', cancelled_at = now(), row_version = row_version + 1,
    suppression_reason_code = coalesce(nullif(trim(p_reason_code), ''), 'resident_cancelled')
  where id = v_reminder.id returning * into v_reminder;
  update public.communication_deliveries set
    status = 'cancelled', failure_reason_code = 'resident_cancelled',
    row_version = row_version + 1
  where id = v_reminder.delivery_id and status in ('planned', 'queued');
  update private.outbox_events set state = 'failed', last_error_code = 'resident_cancelled'
  where aggregate_type = 'reminder' and aggregate_id = v_reminder.id and state = 'pending';
  insert into public.audit_events (
    tenant_id, resident_id, case_id, actor_user_id,
    event_type, redacted_payload, source
  ) values (
    v_reminder.tenant_id, v_reminder.resident_id, v_reminder.case_id,
    p_actor_user_id, 'reminder_cancelled',
    jsonb_build_object('reminderId', v_reminder.id, 'reasonCode', 'resident_cancelled'),
    'resident'
  );
  return jsonb_build_object(
    'reminderId', v_reminder.id, 'status', v_reminder.status,
    'cancelled', true, 'duplicate', false
  );
end;
$$;

create or replace function private.civya_suppress_reminder(
  p_reminder public.reminders,
  p_reason_code text
)
returns public.reminders
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_reminder public.reminders%rowtype;
begin
  update public.reminders set
    status = 'suppressed', suppression_reason_code = p_reason_code,
    row_version = row_version + 1
  where id = p_reminder.id and status in ('scheduled', 'queued')
  returning * into v_reminder;
  if not found then v_reminder := p_reminder; end if;
  update public.communication_deliveries set
    status = 'suppressed', failure_reason_code = p_reason_code,
    row_version = row_version + 1
  where id = p_reminder.delivery_id and status in ('planned', 'queued');
  return v_reminder;
end;
$$;

revoke all on function private.civya_suppress_reminder(public.reminders, text)
  from public, anon, authenticated, service_role;

create or replace function public.civya_service_prepare_reminder_delivery(
  p_reminder_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_reminder public.reminders%rowtype;
  v_delivery public.communication_deliveries%rowtype;
  v_template public.communication_template_versions%rowtype;
  v_resident public.residents%rowtype;
  v_contact_digest text;
  v_local_hour integer;
  v_next_eligible timestamptz;
begin
  perform private.civya_service_required();
  select * into v_reminder from public.reminders where id = p_reminder_id for update;
  if not found then raise exception 'reminder not found' using errcode = 'P0002'; end if;
  if v_reminder.status in ('cancelled', 'suppressed', 'failed', 'failed_unknown', 'accepted', 'delivered', 'sent') then
    return jsonb_build_object(
      'state', 'terminal', 'status', v_reminder.status,
      'reminderId', v_reminder.id, 'deliveryId', v_reminder.delivery_id
    );
  end if;
  if v_reminder.scheduled_for > now() then
    return jsonb_build_object(
      'state', 'deferred', 'status', v_reminder.status,
      'reminderId', v_reminder.id, 'deliveryId', v_reminder.delivery_id,
      'nextEligibleAt', v_reminder.scheduled_for
    );
  end if;
  if not exists (
    select 1 from public.case_entitlements e
    join public.cases c on c.id = e.case_id
    join public.tenants t on t.id = e.tenant_id
    where e.id = v_reminder.entitlement_id
      and e.tenant_id = v_reminder.tenant_id
      and e.case_id = v_reminder.case_id
      and e.resident_id = v_reminder.resident_id
      and e.state = 'active' and e.revoked_at is null and e.expires_at > now()
      and array['case.read', 'case.participate']::text[] <@ e.scopes
      and private.civya_entitlement_has_current_proof(e.id)
      and c.id = v_reminder.case_id and c.tenant_id = v_reminder.tenant_id
      and c.resident_id = v_reminder.resident_id and c.active
      and t.id = v_reminder.tenant_id and t.status = 'active'
      and t.environment = 'production' and not t.fictional
  ) then
    v_reminder := private.civya_suppress_reminder(v_reminder, 'entitlement_inactive');
    return jsonb_build_object('state', 'suppressed', 'status', v_reminder.status,
      'reasonCode', 'entitlement_inactive', 'reminderId', v_reminder.id,
      'deliveryId', v_reminder.delivery_id);
  end if;
  if not exists (
    select 1 from public.consent c
    where c.id = v_reminder.consent_id
      and c.tenant_id = v_reminder.tenant_id
      and c.resident_id = v_reminder.resident_id
      and c.case_id = v_reminder.case_id
      and c.consent_type = 'reminder'
      and c.granted and c.revoked_at is null
  ) or not exists (
    select 1 from public.consent c
    where c.id = v_reminder.channel_consent_id
      and c.tenant_id = v_reminder.tenant_id
      and c.resident_id = v_reminder.resident_id
      and c.case_id = v_reminder.case_id
      and c.consent_type = v_reminder.channel
      and c.granted and c.revoked_at is null
  ) then
    v_reminder := private.civya_suppress_reminder(v_reminder, 'consent_inactive');
    return jsonb_build_object('state', 'suppressed', 'status', v_reminder.status,
      'reasonCode', 'consent_inactive', 'reminderId', v_reminder.id,
      'deliveryId', v_reminder.delivery_id);
  end if;
  select * into v_delivery from public.communication_deliveries
  where id = v_reminder.delivery_id
    and tenant_id = v_reminder.tenant_id
    and resident_id = v_reminder.resident_id
    and case_id = v_reminder.case_id
    and consent_id = v_reminder.consent_id
    and template_id = v_reminder.template_id
    and channel = v_reminder.channel
    and provider_key = 'twilio'
  for update;
  if not found then raise exception 'reminder delivery binding invalid' using errcode = '23514'; end if;
  select * into v_template from public.communication_template_versions
  where id = v_reminder.template_id
    and channel = v_reminder.channel
    and approval_state = 'approved'
    and not contains_sensitive_content
    and allowed_variables = array['secure_link']::text[]
    and effective_from <= now()
    and (effective_to is null or effective_to > now());
  if not found then
    v_reminder := private.civya_suppress_reminder(v_reminder, 'template_inactive');
    return jsonb_build_object('state', 'suppressed', 'status', v_reminder.status,
      'reasonCode', 'template_inactive', 'reminderId', v_reminder.id,
      'deliveryId', v_reminder.delivery_id);
  end if;
  select * into v_resident from public.residents
  where id = v_reminder.resident_id and tenant_id = v_reminder.tenant_id;
  if not found or v_resident.phone is null or v_resident.phone !~ '^\+[1-9][0-9]{7,14}$' then
    v_reminder := private.civya_suppress_reminder(v_reminder, 'contact_unavailable');
    return jsonb_build_object('state', 'suppressed', 'status', v_reminder.status,
      'reasonCode', 'contact_unavailable', 'reminderId', v_reminder.id,
      'deliveryId', v_reminder.delivery_id);
  end if;
  v_contact_digest := encode(sha256(convert_to(
    'civya-phone-reference-v1:' || v_resident.phone, 'UTF8'
  )), 'hex');
  if exists (
    select 1 from private.communication_suppressions s
    where s.tenant_id = v_reminder.tenant_id
      and s.resident_id = v_reminder.resident_id
      and s.channel = v_reminder.channel
      and s.contact_reference_digest = v_contact_digest
      and s.lifted_at is null
  ) then
    v_reminder := private.civya_suppress_reminder(v_reminder, 'contact_suppressed');
    return jsonb_build_object('state', 'suppressed', 'status', v_reminder.status,
      'reasonCode', 'contact_suppressed', 'reminderId', v_reminder.id,
      'deliveryId', v_reminder.delivery_id);
  end if;
  if not exists (select 1 from pg_timezone_names where name = v_reminder.quiet_hours_timezone) then
    v_reminder := private.civya_suppress_reminder(v_reminder, 'timezone_invalid');
    return jsonb_build_object('state', 'suppressed', 'status', v_reminder.status,
      'reasonCode', 'timezone_invalid', 'reminderId', v_reminder.id,
      'deliveryId', v_reminder.delivery_id);
  end if;
  v_local_hour := extract(hour from now() at time zone v_reminder.quiet_hours_timezone)::integer;
  if v_local_hour < 8 or v_local_hour >= 21 then
    v_next_eligible := (
      date_trunc('day', now() at time zone v_reminder.quiet_hours_timezone)
      + case when v_local_hour >= 21 then interval '1 day 8 hours' else interval '8 hours' end
    ) at time zone v_reminder.quiet_hours_timezone;
    update public.reminders set
      scheduled_for = v_next_eligible,
      quiet_hours_checked_at = now(),
      row_version = row_version + 1
    where id = v_reminder.id returning * into v_reminder;
    update public.communication_deliveries set
      scheduled_for = v_next_eligible, row_version = row_version + 1
    where id = v_reminder.delivery_id;
    return jsonb_build_object(
      'state', 'deferred', 'status', v_reminder.status,
      'reasonCode', 'quiet_hours', 'reminderId', v_reminder.id,
      'deliveryId', v_reminder.delivery_id, 'nextEligibleAt', v_next_eligible
    );
  end if;

  update public.reminders set
    status = 'queued', quiet_hours_checked_at = now(), row_version = row_version + 1
  where id = v_reminder.id returning * into v_reminder;
  update public.communication_deliveries set
    status = 'queued', contact_reference_digest = v_contact_digest,
    row_version = row_version + 1
  where id = v_delivery.id returning * into v_delivery;
  return jsonb_build_object(
    'state', 'ready', 'status', v_reminder.status,
    'tenantId', v_reminder.tenant_id,
    'residentId', v_reminder.resident_id,
    'caseId', v_reminder.case_id,
    'entitlementId', v_reminder.entitlement_id,
    'reminderId', v_reminder.id,
    'deliveryId', v_delivery.id,
    'templateId', v_template.id,
    'templateKey', v_template.template_key,
    'templateVersion', v_template.version,
    'templateBody', v_template.body_template,
    'destination', v_resident.phone,
    'contactReferenceDigest', v_contact_digest,
    'quietHoursCheckedAt', v_reminder.quiet_hours_checked_at
  );
end;
$$;

create or replace function public.civya_service_mark_reminder_delivery_outcome(
  p_reminder_id uuid,
  p_external_operation_id uuid,
  p_outcome text,
  p_provider_reference_digest text,
  p_reason_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_reminder public.reminders%rowtype;
  v_operation private.external_operations%rowtype;
  v_event_sha text;
begin
  perform private.civya_service_required();
  if p_outcome not in ('accepted', 'failed', 'failed_unknown') then
    raise exception 'invalid reminder dispatch outcome' using errcode = '22023';
  end if;
  if p_outcome = 'accepted' and p_provider_reference_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'accepted reminder requires a provider reference digest' using errcode = '22023';
  end if;
  select * into v_reminder from public.reminders where id = p_reminder_id for update;
  if not found then raise exception 'reminder not found' using errcode = 'P0002'; end if;
  select * into v_operation from private.external_operations
  where id = p_external_operation_id
    and tenant_id = v_reminder.tenant_id
    and provider_key = 'twilio'
    and operation_kind = 'reminder.send'
    and request_metadata ->> 'deliveryId' = v_reminder.delivery_id::text;
  if not found then raise exception 'external reminder operation mismatch' using errcode = '23514'; end if;
  if (p_outcome = 'accepted' and (
        v_operation.state <> 'succeeded'
        or v_operation.external_reference is distinct from p_provider_reference_digest
      ))
     or (p_outcome = 'failed' and v_operation.state <> 'failed_terminal')
     or (p_outcome = 'failed_unknown' and v_operation.state not in ('in_flight', 'failed_unknown')) then
    raise exception 'external reminder operation state does not prove this outcome'
      using errcode = '55000';
  end if;
  if v_reminder.status = 'delivered' then
    return jsonb_build_object('reminderId', v_reminder.id, 'status', v_reminder.status, 'duplicate', true);
  end if;
  v_event_sha := encode(sha256(convert_to(jsonb_build_object(
    'reminderId', v_reminder.id,
    'operationId', v_operation.id,
    'outcome', p_outcome,
    'providerReferenceDigest', p_provider_reference_digest,
    'reasonCode', p_reason_code
  )::text, 'UTF8')), 'hex');
  update public.communication_deliveries set
    status = p_outcome,
    provider_reference_digest = coalesce(p_provider_reference_digest, provider_reference_digest),
    accepted_at = case when p_outcome = 'accepted' then coalesce(accepted_at, now()) else accepted_at end,
    failure_reason_code = case when p_outcome in ('failed', 'failed_unknown')
      then coalesce(nullif(trim(p_reason_code), ''), p_outcome) else null end,
    row_version = row_version + 1
  where id = v_reminder.delivery_id;
  update public.reminders set
    status = p_outcome,
    provider_reference = null,
    accepted_at = case when p_outcome = 'accepted' then coalesce(accepted_at, now()) else accepted_at end,
    suppression_reason_code = case when p_outcome in ('failed', 'failed_unknown')
      then coalesce(nullif(trim(p_reason_code), ''), p_outcome) else null end,
    row_version = row_version + 1
  where id = v_reminder.id returning * into v_reminder;
  insert into public.communication_delivery_events (
    tenant_id, delivery_id, event_type, payload_sha256, redacted_payload
  ) values (
    v_reminder.tenant_id, v_reminder.delivery_id,
    'dispatch.' || p_outcome, v_event_sha,
    jsonb_build_object(
      'outcome', p_outcome,
      'reasonCode', coalesce(nullif(trim(p_reason_code), ''), p_outcome),
      'authority', case when p_outcome = 'accepted'
        then 'provider_acceptance_not_delivery' else 'dispatch_boundary' end
    )
  ) on conflict do nothing;
  return jsonb_build_object(
    'reminderId', v_reminder.id, 'deliveryId', v_reminder.delivery_id,
    'status', v_reminder.status, 'duplicate', false
  );
end;
$$;

create or replace function public.civya_service_apply_twilio_delivery_receipt(
  p_tenant_id uuid,
  p_provider_event_id uuid,
  p_external_event_id text,
  p_delivery_id uuid,
  p_provider_reference_digest text,
  p_provider_status text,
  p_payload_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_delivery public.communication_deliveries%rowtype;
  v_reminder public.reminders%rowtype;
  v_next_status text;
  v_duplicate boolean := false;
  v_inserted integer := 0;
begin
  perform private.civya_service_required();
  if p_provider_reference_digest !~ '^[0-9a-f]{64}$'
     or p_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid Twilio receipt digest' using errcode = '22023';
  end if;
  if not exists (
    select 1 from private.provider_events e
    where e.id = p_provider_event_id
      and e.tenant_id = p_tenant_id
      and e.provider_key = 'twilio'
      and e.external_event_id = p_external_event_id
      and e.payload_sha256 = p_payload_sha256
      and e.signature_verified
      and e.state = 'processing'
  ) then
    raise exception 'claimed signed Twilio event required' using errcode = '42501';
  end if;
  select * into v_delivery from public.communication_deliveries d
  where d.tenant_id = p_tenant_id
    and d.provider_key = 'twilio'
    and (
      (p_delivery_id is not null and d.id = p_delivery_id)
      or d.provider_reference_digest = p_provider_reference_digest
    )
  order by case when d.id = p_delivery_id then 0 else 1 end
  limit 1
  for update;
  if not found then
    return jsonb_build_object('matched', false, 'status', 'unmatched', 'duplicate', false);
  end if;
  if v_delivery.provider_reference_digest is not null
     and v_delivery.provider_reference_digest <> p_provider_reference_digest then
    raise exception 'Twilio receipt reference mismatch' using errcode = '23505';
  end if;
  select * into v_reminder from public.reminders
  where delivery_id = v_delivery.id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'reminder receipt binding missing' using errcode = '23514'; end if;
  if p_provider_status = 'delivered' then
    v_next_status := 'delivered';
  elsif p_provider_status in ('failed', 'undelivered') then
    v_next_status := case when v_delivery.status = 'delivered' then 'delivered' else 'failed' end;
  elsif p_provider_status in ('accepted', 'queued', 'sending', 'sent') then
    v_next_status := case
      when v_delivery.status = 'delivered' then 'delivered'
      when v_delivery.status = 'failed' then 'failed'
      else 'accepted'
    end;
  else
    v_next_status := v_delivery.status;
  end if;
  insert into public.communication_delivery_events (
    tenant_id, delivery_id, event_type, provider_event_id,
    payload_sha256, redacted_payload
  ) values (
    p_tenant_id, v_delivery.id, 'provider.' || left(p_provider_status, 80),
    p_external_event_id, p_payload_sha256,
    jsonb_build_object(
      'providerStatus', left(p_provider_status, 80),
      'appliedStatus', v_next_status,
      'authority', case when p_provider_status = 'delivered'
        then 'provider_delivery_receipt' else 'provider_status_receipt' end
    )
  ) on conflict (tenant_id, provider_event_id) do nothing;
  get diagnostics v_inserted = row_count;
  v_duplicate := v_inserted = 0;
  if v_duplicate then
    return jsonb_build_object(
      'matched', true, 'deliveryId', v_delivery.id,
      'reminderId', v_reminder.id, 'status', v_delivery.status,
      'duplicate', true
    );
  end if;
  update public.communication_deliveries set
    status = v_next_status,
    provider_reference_digest = coalesce(provider_reference_digest, p_provider_reference_digest),
    accepted_at = case when v_next_status in ('accepted', 'delivered')
      then coalesce(accepted_at, now()) else accepted_at end,
    delivered_at = case when v_next_status = 'delivered'
      then coalesce(delivered_at, now()) else delivered_at end,
    failure_reason_code = case when v_next_status = 'failed'
      then 'provider_delivery_failed' when v_next_status in ('accepted', 'delivered') then null
      else failure_reason_code end,
    row_version = row_version + 1
  where id = v_delivery.id returning * into v_delivery;
  update public.reminders set
    status = v_next_status,
    provider_reference = null,
    accepted_at = case when v_next_status in ('accepted', 'delivered')
      then coalesce(accepted_at, now()) else accepted_at end,
    delivered_at = case when v_next_status = 'delivered'
      then coalesce(delivered_at, now()) else delivered_at end,
    suppression_reason_code = case when v_next_status = 'failed'
      then 'provider_delivery_failed' when v_next_status in ('accepted', 'delivered') then null
      else suppression_reason_code end,
    row_version = row_version + 1
  where id = v_reminder.id returning * into v_reminder;
  update private.external_operations set
    state = case when v_next_status = 'failed' then 'failed_terminal' else 'succeeded' end,
    external_reference = coalesce(external_reference, p_provider_reference_digest),
    completed_at = now(),
    last_error_code = case when v_next_status = 'failed' then 'provider_delivery_failed' else null end
  where tenant_id = p_tenant_id
    and provider_key = 'twilio'
    and operation_kind = 'reminder.send'
    and request_metadata ->> 'deliveryId' = v_delivery.id::text
    and state in ('in_flight', 'failed_unknown');
  return jsonb_build_object(
    'matched', true, 'deliveryId', v_delivery.id,
    'reminderId', v_reminder.id, 'status', v_delivery.status,
    'duplicate', false
  );
end;
$$;

create or replace function public.civya_service_suppress_twilio_contact(
  p_tenant_id uuid,
  p_contact_reference_digest text,
  p_provider_event_id text,
  p_reason_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare v_count integer := 0;
begin
  perform private.civya_service_required();
  if p_contact_reference_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid contact reference digest' using errcode = '22023';
  end if;
  insert into private.communication_suppressions (
    tenant_id, resident_id, channel, contact_reference_digest,
    reason_code, source, provider_event_id
  )
  select distinct d.tenant_id, d.resident_id, d.channel,
    d.contact_reference_digest,
    coalesce(nullif(trim(p_reason_code), ''), 'provider_opt_out'),
    'provider', p_provider_event_id
  from public.communication_deliveries d
  where d.tenant_id = p_tenant_id
    and d.channel = 'sms'
    and d.contact_reference_digest = p_contact_reference_digest
  on conflict do nothing;
  get diagnostics v_count = row_count;
  update public.reminders r set
    status = 'suppressed', suppression_reason_code = 'provider_opt_out',
    row_version = r.row_version + 1
  from public.communication_deliveries d
  where d.id = r.delivery_id
    and d.tenant_id = p_tenant_id
    and d.contact_reference_digest = p_contact_reference_digest
    and r.status in ('scheduled', 'queued');
  update public.communication_deliveries set
    status = 'suppressed', failure_reason_code = 'provider_opt_out',
    row_version = row_version + 1
  where tenant_id = p_tenant_id
    and contact_reference_digest = p_contact_reference_digest
    and status in ('planned', 'queued');
  return jsonb_build_object('suppressedResidents', v_count, 'duplicate', v_count = 0);
end;
$$;

-- Outbox events may carry a redacted not-before timestamp. This keeps a
-- future reminder from burning retry attempts while preserving the generic
-- dispatcher for every other event type.
create or replace function public.civya_service_dispatch_outbox(p_limit integer default 100)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_event private.outbox_events%rowtype;
  v_job private.jobs%rowtype;
  v_jobs jsonb := '[]'::jsonb;
  v_available_at timestamptz;
begin
  perform private.civya_service_required();
  p_limit := least(greatest(p_limit, 1), 1000);
  for v_event in
    select * from private.outbox_events
    where state = 'pending'
    order by created_at
    for update skip locked
    limit p_limit
  loop
    v_available_at := now();
    if coalesce(v_event.payload ->> 'notBefore', '')
       ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then
      v_available_at := greatest(now(), (v_event.payload ->> 'notBefore')::timestamptz);
    end if;
    insert into private.jobs (
      tenant_id, job_type, schema_version, payload, idempotency_key,
      source_type, source_id, available_at
    ) values (
      v_event.tenant_id, 'outbox.' || v_event.event_type, v_event.schema_version,
      v_event.payload || jsonb_build_object('outboxEventId', v_event.id),
      'outbox:' || v_event.id::text, 'outbox_event', v_event.id, v_available_at
    ) on conflict (tenant_id, job_type, idempotency_key) do update
      set updated_at = private.jobs.updated_at
    returning * into v_job;
    update private.outbox_events set
      state = 'enqueued', job_id = v_job.id, enqueued_at = now(),
      dispatch_attempts = dispatch_attempts + 1
    where id = v_event.id;
    v_jobs := v_jobs || jsonb_build_array(private.civya_job_to_json(v_job));
  end loop;
  return v_jobs;
end;
$$;

revoke all on function public.civya_service_schedule_entitled_reminder(
  uuid, uuid, uuid, text, timestamptz, text, text, text, text, boolean, boolean, text
) from public, anon, authenticated;
revoke all on function public.civya_service_get_entitled_reminders(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.civya_service_cancel_entitled_reminder(uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.civya_service_prepare_reminder_delivery(uuid)
  from public, anon, authenticated;
revoke all on function public.civya_service_mark_reminder_delivery_outcome(uuid, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.civya_service_apply_twilio_delivery_receipt(uuid, uuid, text, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.civya_service_suppress_twilio_contact(uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.civya_service_dispatch_outbox(integer)
  from public, anon, authenticated;

grant execute on function public.civya_service_schedule_entitled_reminder(
  uuid, uuid, uuid, text, timestamptz, text, text, text, text, boolean, boolean, text
) to service_role;
grant execute on function public.civya_service_get_entitled_reminders(uuid, uuid, uuid)
  to service_role;
grant execute on function public.civya_service_cancel_entitled_reminder(uuid, uuid, uuid, uuid, text)
  to service_role;
grant execute on function public.civya_service_prepare_reminder_delivery(uuid)
  to service_role;
grant execute on function public.civya_service_mark_reminder_delivery_outcome(uuid, uuid, text, text, text)
  to service_role;
grant execute on function public.civya_service_apply_twilio_delivery_receipt(uuid, uuid, text, uuid, text, text, text)
  to service_role;
grant execute on function public.civya_service_suppress_twilio_contact(uuid, text, text, text)
  to service_role;
grant execute on function public.civya_service_dispatch_outbox(integer)
  to service_role;

comment on table public.communication_template_versions is
  'Immutable approved generic message content. Case facts and County outcome claims are prohibited.';
comment on table private.communication_suppressions is
  'Service-only contact suppression keyed by a one-way contact reference; no raw phone or email is stored here.';
comment on function public.civya_service_prepare_reminder_delivery(uuid) is
  'Worker-only final consent, entitlement, suppression, contact, template, and quiet-hours check. Raw contact is returned only to the trusted worker and never enters a job payload.';
