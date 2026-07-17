-- Civya county-demo persistence, identity, authorization, and retention.
-- All records created by this migration are for a fictional sandbox only.

create extension if not exists pgcrypto;

create schema if not exists private;

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name text not null,
  environment text not null default 'sandbox' check (environment = 'sandbox'),
  fictional boolean not null default true check (fictional),
  status text not null default 'active' check (status in ('active', 'suspended', 'archived')),
  content_version text not null,
  retention_days integer not null default 30 check (retention_days between 1 and 90),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.residents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  identity_state text not null default 'anonymous' check (identity_state in ('anonymous', 'verified')),
  first_name text,
  last_name text,
  email text,
  phone text,
  preferred_language text not null default 'en',
  preferred_contact_channel text check (preferred_contact_channel in ('voice', 'chat', 'sms', 'email')),
  row_version bigint not null default 1,
  last_active_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, auth_user_id)
);

create table if not exists public.cases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  resident_id uuid not null references public.residents(id) on delete cascade,
  status text not null default 'started' check (status in (
    'started', 'intake_in_progress', 'documents_needed', 'packet_ready',
    'simulated_submission_ready', 'simulated_submitted',
    'simulated_payment_pending', 'simulated_payment_completed',
    'follow_up_scheduled', 'human_review_required', 'closed'
  )),
  active boolean not null default true,
  county text not null default 'Wayne County',
  municipality text,
  property_address text,
  parcel_id text,
  urgency_level text not null default 'normal' check (urgency_level in ('normal', 'elevated', 'urgent')),
  workflow_state text not null default 'welcome',
  next_question text,
  next_best_action text not null default 'Continue the fictional guided conversation.',
  resume_summary text not null default '',
  review_required boolean not null default false,
  review_reason text,
  completion_state jsonb not null default '{}'::jsonb,
  row_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

create unique index if not exists cases_one_active_per_resident
  on public.cases (tenant_id, resident_id) where active;
create index if not exists cases_tenant_status_idx on public.cases (tenant_id, status, updated_at desc);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  resident_id uuid not null references public.residents(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  channel text not null check (channel in ('voice', 'chat', 'sms', 'email')),
  status text not null default 'active' check (status in ('active', 'ended', 'abandoned')),
  summary text not null default '',
  last_turn_at timestamptz,
  row_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz
);

create unique index if not exists conversations_one_active_per_case_channel
  on public.conversations (case_id, channel) where status = 'active';

create table if not exists public.turns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  resident_id uuid not null references public.residents(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sequence_number bigint generated always as identity,
  speaker text not null check (speaker in ('user', 'assistant', 'system')),
  channel text not null check (channel in ('voice', 'chat', 'sms', 'email')),
  provider_item_id text,
  client_turn_id text not null,
  idempotency_key text not null,
  redacted_text text not null,
  processing_status text not null default 'received' check (processing_status in ('received', 'processing', 'committed', 'failed')),
  processing_result jsonb,
  failure_code text,
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  unique (conversation_id, idempotency_key),
  unique (conversation_id, client_turn_id, speaker),
  unique (conversation_id, provider_item_id, speaker)
);

create index if not exists turns_resume_idx on public.turns (conversation_id, sequence_number desc);

create table if not exists public.case_facts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  resident_id uuid not null references public.residents(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  fact_key text not null check (fact_key ~ '^[a-z][a-z0-9_]{0,79}$'),
  fact_value jsonb not null,
  sensitivity text not null default 'personal' check (sensitivity in ('general', 'personal', 'restricted')),
  confirmation_state text not null default 'confirmed' check (confirmation_state in ('inferred', 'confirmed', 'disputed')),
  source_turn_id uuid references public.turns(id) on delete set null,
  idempotency_key text not null,
  row_version bigint not null default 1,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (case_id, fact_key)
);

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  resident_id uuid not null references public.residents(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  storage_bucket text not null default 'civya-private-documents' check (storage_bucket = 'civya-private-documents'),
  storage_path text not null unique,
  original_file_name text not null,
  content_type text not null check (content_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain')),
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  document_type text not null default 'unknown',
  classification_confidence numeric(5,4) check (classification_confidence between 0 and 1),
  extraction_confidence numeric(5,4) check (extraction_confidence between 0 and 1),
  redacted_extraction jsonb,
  scan_status text not null default 'pending' check (scan_status in ('pending', 'clean', 'rejected', 'failed')),
  review_required boolean not null default true,
  review_reason text,
  idempotency_key text not null,
  row_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (case_id, idempotency_key)
);

create table if not exists public.checklist_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  resident_id uuid not null references public.residents(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  document_type text not null,
  label text not null,
  description text not null default '',
  status text not null default 'missing' check (status in ('missing', 'uploaded', 'verified', 'not_required', 'needs_review')),
  related_document_id uuid references public.documents(id) on delete set null,
  idempotency_key text not null,
  row_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (case_id, document_type),
  unique (case_id, idempotency_key)
);

create table if not exists public.consent (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  resident_id uuid not null references public.residents(id) on delete cascade,
  case_id uuid references public.cases(id) on delete cascade,
  consent_type text not null check (consent_type in ('sms', 'email', 'save_progress', 'document_upload', 'reminder')),
  consent_text text not null,
  granted boolean not null,
  source text not null check (source in ('agent', 'system', 'admin', 'resident')),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (resident_id, idempotency_key)
);

create table if not exists public.review_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  resident_id uuid references public.residents(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  reason text not null,
  priority text not null default 'normal' check (priority in ('normal', 'high', 'urgent')),
  status text not null default 'open' check (status in ('open', 'in_review', 'resolved', 'closed')),
  assigned_to uuid references auth.users(id) on delete set null,
  notes jsonb not null default '[]'::jsonb,
  dedupe_key text not null,
  row_version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (case_id, dedupe_key)
);

create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  resident_id uuid not null references public.residents(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  consent_id uuid not null references public.consent(id) on delete restrict,
  channel text not null check (channel in ('sms', 'email', 'voice')),
  scheduled_for timestamptz not null,
  message_type text not null,
  redacted_message text not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'sent', 'failed', 'cancelled')),
  idempotency_key text not null,
  provider_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (case_id, idempotency_key)
);

create table if not exists public.simulated_transactions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  resident_id uuid not null references public.residents(id) on delete cascade,
  case_id uuid not null references public.cases(id) on delete cascade,
  kind text not null check (kind in ('submission', 'payment', 'callback')),
  status text not null,
  simulated_amount_cents bigint,
  fictional boolean not null default true check (fictional),
  idempotency_key text not null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (case_id, kind, idempotency_key)
);

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  resident_id uuid references public.residents(id) on delete set null,
  case_id uuid references public.cases(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  redacted_payload jsonb not null default '{}'::jsonb,
  source text not null check (source in ('agent', 'system', 'admin', 'resident')),
  request_id text,
  created_at timestamptz not null default now()
);

create index if not exists audit_events_tenant_time_idx on public.audit_events (tenant_id, created_at desc);

create table if not exists public.staff_roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('reviewer', 'admin')),
  status text not null default 'active' check (status in ('invited', 'active', 'revoked')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, auth_user_id)
);

create table if not exists public.demo_invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  token_hash text not null unique,
  label text not null,
  scopes text[] not null default array['resident_demo']::text[],
  expires_at timestamptz not null,
  max_uses integer not null default 1 check (max_uses between 1 and 10000),
  use_count integer not null default 0 check (use_count >= 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists public.demo_scenarios (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  scenario_key text not null,
  scenario_version text not null,
  title text not null,
  fictional boolean not null default true check (fictional),
  resident_profile jsonb not null,
  case_profile jsonb not null,
  expected_path text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, scenario_key, scenario_version)
);

create table if not exists private.rate_limits (
  key_hash text not null,
  bucket text not null,
  window_started_at timestamptz not null,
  hit_count integer not null default 1,
  primary key (key_hash, bucket, window_started_at)
);

create or replace function private.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'tenants', 'residents', 'cases', 'conversations', 'case_facts',
    'documents', 'checklist_items', 'review_tasks', 'reminders',
    'simulated_transactions', 'staff_roles'
  ] loop
    execute format('drop trigger if exists set_updated_at on public.%I', table_name);
    execute format(
      'create trigger set_updated_at before update on public.%I for each row execute function private.set_updated_at()',
      table_name
    );
  end loop;
end;
$$;

create or replace function public.civya_is_staff(p_tenant_id uuid, p_min_role text default 'reviewer')
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.role() = 'service_role' or exists (
    select 1 from public.staff_roles sr
    where sr.tenant_id = p_tenant_id
      and sr.auth_user_id = auth.uid()
      and sr.status = 'active'
      and case
        when p_min_role = 'admin' then sr.role = 'admin'
        else sr.role in ('reviewer', 'admin')
      end
  );
$$;

create or replace function public.civya_owns_resident(p_resident_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.residents r
    where r.id = p_resident_id and r.auth_user_id = auth.uid()
  );
$$;

create or replace function public.civya_can_access_case(p_case_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.cases c
    join public.residents r on r.id = c.resident_id
    where c.id = p_case_id
      and (r.auth_user_id = auth.uid() or public.civya_is_staff(c.tenant_id))
  );
$$;

create or replace function public.civya_can_access_storage_object(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_resident_id uuid;
  v_case_id uuid;
begin
  if p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+$' then
    return false;
  end if;
  v_tenant_id := split_part(p_name, '/', 1)::uuid;
  v_resident_id := split_part(p_name, '/', 2)::uuid;
  v_case_id := split_part(p_name, '/', 3)::uuid;
  return exists (
    select 1
    from public.cases c
    join public.residents r on r.id = c.resident_id
    where c.id = v_case_id
      and c.tenant_id = v_tenant_id
      and c.resident_id = v_resident_id
      and (r.auth_user_id = auth.uid() or public.civya_is_staff(c.tenant_id))
  );
exception when others then
  return false;
end;
$$;

alter table public.tenants enable row level security;
alter table public.residents enable row level security;
alter table public.cases enable row level security;
alter table public.conversations enable row level security;
alter table public.turns enable row level security;
alter table public.case_facts enable row level security;
alter table public.documents enable row level security;
alter table public.checklist_items enable row level security;
alter table public.consent enable row level security;
alter table public.review_tasks enable row level security;
alter table public.reminders enable row level security;
alter table public.simulated_transactions enable row level security;
alter table public.audit_events enable row level security;
alter table public.staff_roles enable row level security;
alter table public.demo_invitations enable row level security;
alter table public.demo_scenarios enable row level security;

create policy tenants_member_read on public.tenants for select to authenticated
  using (public.civya_is_staff(id) or exists (
    select 1 from public.residents r where r.tenant_id = id and r.auth_user_id = auth.uid()
  ));

create policy residents_owner_read on public.residents for select to authenticated
  using (auth_user_id = auth.uid() or public.civya_is_staff(tenant_id));
create policy residents_owner_update on public.residents for update to authenticated
  using (auth_user_id = auth.uid() or public.civya_is_staff(tenant_id))
  with check (auth_user_id = auth.uid() or public.civya_is_staff(tenant_id));

create policy cases_member_read on public.cases for select to authenticated
  using (public.civya_owns_resident(resident_id) or public.civya_is_staff(tenant_id));
create policy cases_member_update on public.cases for update to authenticated
  using (public.civya_owns_resident(resident_id) or public.civya_is_staff(tenant_id))
  with check (public.civya_owns_resident(resident_id) or public.civya_is_staff(tenant_id));

create policy conversations_member_all on public.conversations for all to authenticated
  using (public.civya_owns_resident(resident_id) or public.civya_is_staff(tenant_id))
  with check (public.civya_owns_resident(resident_id) or public.civya_is_staff(tenant_id));
create policy turns_member_read on public.turns for select to authenticated
  using (public.civya_owns_resident(resident_id) or public.civya_is_staff(tenant_id));
create policy facts_member_read on public.case_facts for select to authenticated
  using (public.civya_owns_resident(resident_id) or public.civya_is_staff(tenant_id));
create policy documents_member_read on public.documents for select to authenticated
  using (public.civya_owns_resident(resident_id) or public.civya_is_staff(tenant_id));
create policy documents_member_insert on public.documents for insert to authenticated
  with check (public.civya_owns_resident(resident_id) or public.civya_is_staff(tenant_id));
create policy documents_member_update on public.documents for update to authenticated
  using (public.civya_owns_resident(resident_id) or public.civya_is_staff(tenant_id))
  with check (public.civya_owns_resident(resident_id) or public.civya_is_staff(tenant_id));
create policy checklist_member_read on public.checklist_items for select to authenticated
  using (public.civya_owns_resident(resident_id) or public.civya_is_staff(tenant_id));
create policy consent_member_read on public.consent for select to authenticated
  using (public.civya_owns_resident(resident_id) or public.civya_is_staff(tenant_id));
create policy consent_owner_insert on public.consent for insert to authenticated
  with check (public.civya_owns_resident(resident_id));
create policy reviews_staff_all on public.review_tasks for all to authenticated
  using (public.civya_is_staff(tenant_id)) with check (public.civya_is_staff(tenant_id));
create policy reviews_resident_read on public.review_tasks for select to authenticated
  using (public.civya_owns_resident(resident_id));
create policy reminders_member_read on public.reminders for select to authenticated
  using (public.civya_owns_resident(resident_id) or public.civya_is_staff(tenant_id));
create policy transactions_member_read on public.simulated_transactions for select to authenticated
  using (public.civya_owns_resident(resident_id) or public.civya_is_staff(tenant_id));
create policy audits_staff_read on public.audit_events for select to authenticated
  using (public.civya_is_staff(tenant_id));
create policy audits_owner_read on public.audit_events for select to authenticated
  using (resident_id is not null and public.civya_owns_resident(resident_id));
create policy staff_self_read on public.staff_roles for select to authenticated
  using (auth_user_id = auth.uid() or public.civya_is_staff(tenant_id, 'admin'));
create policy staff_admin_all on public.staff_roles for all to authenticated
  using (public.civya_is_staff(tenant_id, 'admin'))
  with check (public.civya_is_staff(tenant_id, 'admin'));
create policy invitations_admin_all on public.demo_invitations for all to authenticated
  using (public.civya_is_staff(tenant_id, 'admin'))
  with check (public.civya_is_staff(tenant_id, 'admin'));
create policy scenarios_staff_read on public.demo_scenarios for select to authenticated
  using (public.civya_is_staff(tenant_id));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'civya-private-documents',
  'civya-private-documents',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'text/plain']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy civya_storage_member_read on storage.objects for select to authenticated
  using (bucket_id = 'civya-private-documents' and public.civya_can_access_storage_object(name));
create policy civya_storage_member_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'civya-private-documents' and public.civya_can_access_storage_object(name));
create policy civya_storage_member_delete on storage.objects for delete to authenticated
  using (bucket_id = 'civya-private-documents' and public.civya_can_access_storage_object(name));

create or replace function public.civya_bootstrap_session(
  p_tenant_slug text default 'wayne-county-demo',
  p_channel text default 'voice'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant public.tenants%rowtype;
  v_resident public.residents%rowtype;
  v_case public.cases%rowtype;
  v_conversation public.conversations%rowtype;
  v_facts jsonb;
  v_turns jsonb;
  v_is_anonymous boolean;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_channel not in ('voice', 'chat', 'sms', 'email') then raise exception 'invalid channel'; end if;

  select * into v_tenant from public.tenants where slug = p_tenant_slug and status = 'active';
  if not found then raise exception 'sandbox tenant unavailable' using errcode = 'P0002'; end if;

  v_is_anonymous := coalesce((auth.jwt() ->> 'is_anonymous')::boolean, true);

  insert into public.residents (tenant_id, auth_user_id, identity_state, email)
  values (
    v_tenant.id,
    auth.uid(),
    case when v_is_anonymous then 'anonymous' else 'verified' end,
    nullif(auth.jwt() ->> 'email', '')
  )
  on conflict (tenant_id, auth_user_id) do update set
    last_active_at = now(),
    identity_state = case when v_is_anonymous then public.residents.identity_state else 'verified' end,
    email = coalesce(nullif(auth.jwt() ->> 'email', ''), public.residents.email),
    row_version = public.residents.row_version + 1
  returning * into v_resident;

  select * into v_case from public.cases
  where tenant_id = v_tenant.id and resident_id = v_resident.id and active
  for update;
  if not found then
    insert into public.cases (tenant_id, resident_id)
    values (v_tenant.id, v_resident.id)
    returning * into v_case;
  end if;

  select * into v_conversation from public.conversations
  where case_id = v_case.id and channel = p_channel and status = 'active'
  for update;
  if not found then
    insert into public.conversations (tenant_id, resident_id, case_id, channel)
    values (v_tenant.id, v_resident.id, v_case.id, p_channel)
    returning * into v_conversation;
  end if;

  select coalesce(jsonb_object_agg(fact_key, fact_value), '{}'::jsonb)
  into v_facts from public.case_facts
  where case_id = v_case.id and confirmation_state = 'confirmed';

  select coalesce(jsonb_agg(to_jsonb(recent_turns) order by sequence_number), '[]'::jsonb)
  into v_turns
  from (
    select id, speaker, channel, redacted_text as text, created_at, sequence_number
    from public.turns
    where conversation_id = v_conversation.id and processing_status <> 'failed'
    order by sequence_number desc
    limit 6
  ) recent_turns;

  return jsonb_build_object(
    'authentication', jsonb_build_object(
      'userId', auth.uid(),
      'isAnonymous', v_is_anonymous,
      'isVerified', not v_is_anonymous,
      'email', nullif(auth.jwt() ->> 'email', '')
    ),
    'tenant', jsonb_build_object('id', v_tenant.id, 'slug', v_tenant.slug, 'name', v_tenant.name, 'fictional', true),
    'resident', jsonb_build_object('id', v_resident.id, 'identityState', v_resident.identity_state),
    'activeCase', jsonb_build_object(
      'id', v_case.id, 'status', v_case.status, 'rowVersion', v_case.row_version,
      'workflowState', v_case.workflow_state, 'nextQuestion', v_case.next_question,
      'nextBestAction', v_case.next_best_action, 'updatedAt', v_case.updated_at
    ),
    'conversation', jsonb_build_object(
      'id', v_conversation.id, 'channel', v_conversation.channel,
      'status', v_conversation.status, 'rowVersion', v_conversation.row_version
    ),
    'resumeContext', jsonb_build_object(
      'confirmedFacts', v_facts,
      'conversationSummary', coalesce(nullif(v_conversation.summary, ''), v_case.resume_summary, ''),
      'recentTurns', v_turns,
      'currentWorkflowState', v_case.workflow_state,
      'nextQuestion', v_case.next_question
    ),
    'nextAction', jsonb_build_object(
      'kind', case when v_case.next_question is null then 'continue' else 'ask_question' end,
      'prompt', coalesce(v_case.next_question, v_case.next_best_action)
    )
  );
end;
$$;

create or replace function public.civya_create_or_get_conversation(p_case_id uuid, p_channel text)
returns public.conversations
language plpgsql
security definer
set search_path = public
as $$
declare v_case public.cases%rowtype; v_conversation public.conversations%rowtype;
begin
  select * into v_case from public.cases where id = p_case_id;
  if not found or not public.civya_can_access_case(p_case_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  select * into v_conversation from public.conversations
    where case_id = p_case_id and channel = p_channel and status = 'active';
  if found then return v_conversation; end if;
  insert into public.conversations (tenant_id, resident_id, case_id, channel)
  values (v_case.tenant_id, v_case.resident_id, v_case.id, p_channel)
  on conflict (case_id, channel) where status = 'active' do update set updated_at = now()
  returning * into v_conversation;
  return v_conversation;
end;
$$;

create or replace function public.civya_append_turn(
  p_conversation_id uuid,
  p_provider_item_id text,
  p_client_turn_id text,
  p_idempotency_key text,
  p_speaker text,
  p_channel text,
  p_redacted_text text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_conversation public.conversations%rowtype; v_turn public.turns%rowtype; v_inserted boolean := true;
begin
  select * into v_conversation from public.conversations where id = p_conversation_id;
  if not found or not public.civya_can_access_case(v_conversation.case_id) then
    raise exception 'conversation not found' using errcode = 'P0002';
  end if;
  if length(trim(p_redacted_text)) = 0 or length(p_redacted_text) > 12000 then raise exception 'invalid redacted transcript'; end if;

  insert into public.turns (
    tenant_id, resident_id, case_id, conversation_id, speaker, channel,
    provider_item_id, client_turn_id, idempotency_key, redacted_text
  ) values (
    v_conversation.tenant_id, v_conversation.resident_id, v_conversation.case_id,
    v_conversation.id, p_speaker, p_channel, nullif(p_provider_item_id, ''),
    p_client_turn_id, p_idempotency_key, p_redacted_text
  )
  on conflict (conversation_id, idempotency_key) do nothing
  returning * into v_turn;

  if not found then
    v_inserted := false;
    select * into v_turn from public.turns
      where conversation_id = p_conversation_id and idempotency_key = p_idempotency_key;
  else
    update public.conversations set last_turn_at = now(), row_version = row_version + 1
      where id = p_conversation_id;
  end if;
  return jsonb_build_object('turn', to_jsonb(v_turn), 'duplicate', not v_inserted);
end;
$$;

create or replace function public.civya_upsert_case_facts(
  p_case_id uuid,
  p_expected_row_version bigint,
  p_facts jsonb,
  p_source_turn_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_case public.cases%rowtype; v_fact record;
begin
  select * into v_case from public.cases where id = p_case_id for update;
  if not found or not public.civya_can_access_case(p_case_id) then raise exception 'case not found' using errcode = 'P0002'; end if;
  if v_case.row_version <> p_expected_row_version then raise exception 'stale case version' using errcode = '40001'; end if;
  if jsonb_typeof(p_facts) <> 'object' then raise exception 'facts must be an object'; end if;

  for v_fact in select key, value from jsonb_each(p_facts) loop
    insert into public.case_facts (
      tenant_id, resident_id, case_id, fact_key, fact_value, source_turn_id,
      idempotency_key, confirmation_state, confirmed_at
    ) values (
      v_case.tenant_id, v_case.resident_id, v_case.id, v_fact.key, v_fact.value,
      p_source_turn_id, p_idempotency_key || ':' || v_fact.key, 'confirmed', now()
    )
    on conflict (case_id, fact_key) do update set
      fact_value = excluded.fact_value,
      source_turn_id = excluded.source_turn_id,
      idempotency_key = excluded.idempotency_key,
      confirmation_state = 'confirmed',
      confirmed_at = now(),
      row_version = public.case_facts.row_version + 1;
  end loop;
  update public.cases set row_version = row_version + 1 where id = p_case_id returning * into v_case;
  return jsonb_build_object('caseId', v_case.id, 'rowVersion', v_case.row_version);
end;
$$;

create or replace function public.civya_commit_turn_result(
  p_user_turn_id uuid,
  p_expected_case_version bigint,
  p_spoken_response text,
  p_next_question text,
  p_workflow_state text,
  p_case_status text,
  p_conversation_summary text,
  p_completion_state jsonb,
  p_facts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_turn public.turns%rowtype;
  v_case public.cases%rowtype;
  v_conversation public.conversations%rowtype;
  v_fact record;
  v_result jsonb;
begin
  select * into v_user_turn from public.turns where id = p_user_turn_id for update;
  if not found or not public.civya_can_access_case(v_user_turn.case_id) then raise exception 'turn not found' using errcode = 'P0002'; end if;
  if v_user_turn.processing_status = 'committed' then return v_user_turn.processing_result; end if;

  select * into v_case from public.cases where id = v_user_turn.case_id for update;
  if v_case.row_version <> p_expected_case_version then raise exception 'stale case version' using errcode = '40001'; end if;
  select * into v_conversation from public.conversations where id = v_user_turn.conversation_id for update;

  if jsonb_typeof(coalesce(p_facts, '{}'::jsonb)) <> 'object' then raise exception 'facts must be an object'; end if;
  for v_fact in select key, value from jsonb_each(coalesce(p_facts, '{}'::jsonb)) loop
    insert into public.case_facts (
      tenant_id, resident_id, case_id, fact_key, fact_value, source_turn_id,
      idempotency_key, confirmation_state, confirmed_at
    ) values (
      v_case.tenant_id, v_case.resident_id, v_case.id, v_fact.key, v_fact.value,
      v_user_turn.id, v_user_turn.idempotency_key || ':' || v_fact.key, 'confirmed', now()
    )
    on conflict (case_id, fact_key) do update set
      fact_value = excluded.fact_value,
      source_turn_id = excluded.source_turn_id,
      idempotency_key = excluded.idempotency_key,
      confirmation_state = 'confirmed',
      confirmed_at = now(),
      row_version = public.case_facts.row_version + 1;
  end loop;

  update public.cases set
    status = coalesce(nullif(p_case_status, ''), status),
    workflow_state = coalesce(nullif(p_workflow_state, ''), workflow_state),
    next_question = p_next_question,
    resume_summary = left(coalesce(p_conversation_summary, resume_summary), 4000),
    completion_state = coalesce(p_completion_state, completion_state),
    row_version = row_version + 1
  where id = v_case.id returning * into v_case;

  update public.conversations set
    summary = left(coalesce(p_conversation_summary, summary), 4000),
    last_turn_at = now(),
    row_version = row_version + 1
  where id = v_conversation.id returning * into v_conversation;

  insert into public.turns (
    tenant_id, resident_id, case_id, conversation_id, speaker, channel,
    client_turn_id, idempotency_key, redacted_text, processing_status, committed_at
  ) values (
    v_user_turn.tenant_id, v_user_turn.resident_id, v_user_turn.case_id,
    v_user_turn.conversation_id, 'assistant', v_user_turn.channel,
    v_user_turn.client_turn_id || ':assistant', v_user_turn.idempotency_key || ':assistant',
    left(p_spoken_response, 12000), 'committed', now()
  ) on conflict (conversation_id, idempotency_key) do nothing;

  v_result := jsonb_build_object(
    'spokenResponse', p_spoken_response,
    'caseUpdate', jsonb_build_object(
      'caseId', v_case.id, 'status', v_case.status, 'rowVersion', v_case.row_version,
      'workflowState', v_case.workflow_state
    ),
    'nextQuestion', p_next_question,
    'completionState', coalesce(p_completion_state, '{}'::jsonb)
  );
  update public.turns set processing_status = 'committed', processing_result = v_result, committed_at = now()
    where id = v_user_turn.id;
  return v_result;
end;
$$;

create or replace function public.civya_finish_conversation(p_conversation_id uuid, p_summary text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_case_id uuid;
begin
  select case_id into v_case_id from public.conversations where id = p_conversation_id;
  if v_case_id is null or not public.civya_can_access_case(v_case_id) then raise exception 'conversation not found' using errcode = 'P0002'; end if;
  update public.conversations set status = 'ended', summary = coalesce(p_summary, summary), ended_at = now(), row_version = row_version + 1
    where id = p_conversation_id;
end;
$$;

create or replace function public.civya_mark_identity_verified()
returns public.residents
language plpgsql
security definer
set search_path = public
as $$
declare v_resident public.residents%rowtype;
begin
  if auth.uid() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, true) then
    raise exception 'verified identity required' using errcode = '28000';
  end if;
  update public.residents set identity_state = 'verified', email = nullif(auth.jwt() ->> 'email', ''), row_version = row_version + 1
  where auth_user_id = auth.uid()
  returning * into v_resident;
  if not found then raise exception 'resident workspace not found' using errcode = 'P0002'; end if;
  return v_resident;
end;
$$;

create or replace function public.civya_redeem_invitation(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_invite public.demo_invitations%rowtype; v_tenant public.tenants%rowtype;
begin
  select * into v_invite from public.demo_invitations
    where token_hash = p_token_hash and revoked_at is null and expires_at > now() and use_count < max_uses
    for update;
  if not found then raise exception 'invitation invalid or expired' using errcode = '28000'; end if;
  update public.demo_invitations set use_count = use_count + 1 where id = v_invite.id returning * into v_invite;
  select * into v_tenant from public.tenants where id = v_invite.tenant_id and status = 'active';
  if not found then raise exception 'sandbox unavailable' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'invitationId', v_invite.id, 'tenantId', v_tenant.id, 'tenantSlug', v_tenant.slug,
    'scopes', to_jsonb(v_invite.scopes), 'expiresAt', v_invite.expires_at
  );
end;
$$;

create or replace function public.civya_take_rate_limit(
  p_key_hash text,
  p_bucket text,
  p_max_hits integer,
  p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare v_window timestamptz; v_count integer;
begin
  if auth.uid() is null and auth.role() <> 'service_role' then raise exception 'authentication required' using errcode = '28000'; end if;
  if p_max_hits < 1 or p_window_seconds < 1 then raise exception 'invalid rate limit'; end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into private.rate_limits (key_hash, bucket, window_started_at, hit_count)
  values (p_key_hash, p_bucket, v_window, 1)
  on conflict (key_hash, bucket, window_started_at) do update set hit_count = private.rate_limits.hit_count + 1
  returning hit_count into v_count;
  return jsonb_build_object('allowed', v_count <= p_max_hits, 'remaining', greatest(0, p_max_hits - v_count), 'resetAt', v_window + make_interval(secs => p_window_seconds));
end;
$$;

create or replace function public.civya_delete_expired_demo_data()
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_deleted bigint;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required' using errcode = '42501'; end if;
  with deleted as (
    delete from public.cases c
    using public.tenants t
    where c.tenant_id = t.id
      and c.updated_at < now() - make_interval(days => t.retention_days)
    returning c.id
  ) select count(*) into v_deleted from deleted;
  delete from public.residents r
    using public.tenants t
    where r.tenant_id = t.id
      and r.updated_at < now() - make_interval(days => t.retention_days)
      and not exists (select 1 from public.cases c where c.resident_id = r.id);
  delete from private.rate_limits where window_started_at < now() - interval '2 days';
  return v_deleted;
end;
$$;

revoke all on function public.civya_is_staff(uuid, text) from public;
revoke all on function public.civya_owns_resident(uuid) from public;
revoke all on function public.civya_can_access_case(uuid) from public;
revoke all on function public.civya_can_access_storage_object(text) from public;
revoke all on function public.civya_bootstrap_session(text, text) from public;
revoke all on function public.civya_create_or_get_conversation(uuid, text) from public;
revoke all on function public.civya_append_turn(uuid, text, text, text, text, text, text) from public;
revoke all on function public.civya_upsert_case_facts(uuid, bigint, jsonb, uuid, text) from public;
revoke all on function public.civya_commit_turn_result(uuid, bigint, text, text, text, text, text, jsonb, jsonb) from public;
revoke all on function public.civya_finish_conversation(uuid, text) from public;
revoke all on function public.civya_mark_identity_verified() from public;
revoke all on function public.civya_redeem_invitation(text) from public;
revoke all on function public.civya_take_rate_limit(text, text, integer, integer) from public;
revoke all on function public.civya_delete_expired_demo_data() from public;

grant execute on function public.civya_is_staff(uuid, text) to authenticated, service_role;
grant execute on function public.civya_owns_resident(uuid) to authenticated, service_role;
grant execute on function public.civya_can_access_case(uuid) to authenticated, service_role;
grant execute on function public.civya_can_access_storage_object(text) to authenticated, service_role;
grant execute on function public.civya_bootstrap_session(text, text) to authenticated;
grant execute on function public.civya_create_or_get_conversation(uuid, text) to authenticated;
grant execute on function public.civya_append_turn(uuid, text, text, text, text, text, text) to authenticated;
grant execute on function public.civya_upsert_case_facts(uuid, bigint, jsonb, uuid, text) to authenticated;
grant execute on function public.civya_commit_turn_result(uuid, bigint, text, text, text, text, text, jsonb, jsonb) to authenticated;
grant execute on function public.civya_finish_conversation(uuid, text) to authenticated;
grant execute on function public.civya_mark_identity_verified() to authenticated;
grant execute on function public.civya_redeem_invitation(text) to anon, authenticated, service_role;
grant execute on function public.civya_take_rate_limit(text, text, integer, integer) to authenticated, service_role;
grant execute on function public.civya_delete_expired_demo_data() to service_role;

comment on table public.turns is 'Redacted text only. Civya never stores raw audio.';
comment on table public.simulated_transactions is 'Fictional sandbox actions only; never stores real payment credentials.';
comment on table public.demo_scenarios is 'Versioned fictional scenarios; never copied from actual residents.';
