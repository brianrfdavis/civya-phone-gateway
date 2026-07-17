-- Clean, versioned, fictional demo content. Safe to rerun.
-- No temporary runtime residents or cases are imported.

insert into public.tenants (
  id, slug, name, environment, fictional, status, content_version, retention_days, settings
) values (
  '10000000-0000-4000-8000-000000000001',
  'wayne-county-demo',
  'Wayne County Fictional Demonstration',
  'sandbox',
  true,
  'active',
  'fictional-v1.0.0',
  30,
  '{"resident_notice":"Demonstration only. No real applications, submissions, reminders, or payments are created.","county_content_status":"draft_pending_formal_approval"}'::jsonb
)
on conflict (slug) do update set
  name = excluded.name,
  environment = excluded.environment,
  fictional = excluded.fictional,
  status = excluded.status,
  content_version = excluded.content_version,
  retention_days = excluded.retention_days,
  settings = excluded.settings;

insert into public.demo_scenarios (
  id, tenant_id, scenario_key, scenario_version, title, fictional,
  resident_profile, case_profile, expected_path
) values
(
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'owner-occupant-payment-plan', 'fictional-v1.0.0',
  'Fictional owner-occupant exploring a payment plan', true,
  '{"first_name":"Jordan","last_name":"Example","preferred_language":"en","city":"Detroit"}'::jsonb,
  '{"property_address":"1200 Demo Avenue, Detroit, MI 48200","parcel_id":"DEMO-001-0001","urgency_level":"elevated","delinquency_years":["20XX","20XY"]}'::jsonb,
  'simulated_payment_plan_review'
),
(
  '20000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  'fictional-heir-probate', 'fictional-v1.0.0',
  'Fictional heir who needs human review', true,
  '{"first_name":"Avery","last_name":"Example","preferred_language":"en","city":"Detroit"}'::jsonb,
  '{"property_address":"500 Sample Street, Detroit, MI 48200","parcel_id":"DEMO-002-0002","urgency_level":"urgent","relationship_to_owner":"heir"}'::jsonb,
  'human_review_and_fictional_legal_referral'
),
(
  '20000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000001',
  'general-information-only', 'fictional-v1.0.0',
  'General information without sensitive intake', true,
  '{"first_name":null,"last_name":null,"preferred_language":"en","city":null}'::jsonb,
  '{"property_address":null,"parcel_id":null,"urgency_level":"normal"}'::jsonb,
  'approved_general_information'
)
on conflict (tenant_id, scenario_key, scenario_version) do update set
  title = excluded.title,
  fictional = true,
  resident_profile = excluded.resident_profile,
  case_profile = excluded.case_profile,
  expected_path = excluded.expected_path;
