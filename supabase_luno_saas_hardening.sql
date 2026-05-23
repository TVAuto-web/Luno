-- ============================================================================
-- LUNO - SaaS data hardening
-- Additive migration: persistent snapshots + integration tables + plan cleanup.
-- Safe to run multiple times.
-- ============================================================================

begin;

create extension if not exists pgcrypto;

-- Plans currently used by the public pricing.
alter table if exists public.subscriptions drop constraint if exists subscriptions_plan_check;
alter table if exists public.subscriptions add constraint subscriptions_plan_check
  check (plan in ('gratuit','essentiel','pro','business','trial','starter','plus','premium','entreprise'));

alter table if exists public.companies add column if not exists siret text;
alter table if exists public.companies add column if not exists tva_num text;
alter table if exists public.companies add column if not exists code_ape text;
alter table if exists public.companies add column if not exists libelle_ape text;
alter table if exists public.companies add column if not exists fiscal_settings jsonb default '{}'::jsonb;
alter table if exists public.companies add column if not exists app_settings jsonb default '{}'::jsonb;

alter table if exists public.profiles add column if not exists onboarding_state jsonb default '{}'::jsonb;

create or replace function public.is_company_member(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.company_id = p_company_id
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.can_edit_company(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.company_id = p_company_id
      and m.user_id = auth.uid()
      and m.role in ('owner','admin','editor','accountant','collaborator','cabinet_owner')
  );
$$;

-- Complete encrypted-ish app persistence boundary.
-- data is JSONB, protected by RLS and server-side service role APIs.
create table if not exists public.app_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade not null,
  company_id uuid references public.companies(id) on delete cascade,
  source text default 'web-app',
  data jsonb not null default '{}'::jsonb,
  version text default '1',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, company_id, source)
);

create table if not exists public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade not null,
  provider text,
  provider_account_id text,
  bank_name text,
  iban_masked text,
  currency text default 'EUR',
  balance numeric(14,2) default 0,
  last_sync_at timestamptz,
  raw jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(company_id, provider, provider_account_id)
);

create table if not exists public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade not null,
  bank_account_id uuid references public.bank_accounts(id) on delete cascade,
  provider text,
  provider_transaction_id text,
  booked_at date,
  label text,
  amount numeric(14,2) not null default 0,
  category text,
  confidence numeric(5,2),
  matched_kind text,
  matched_id uuid,
  raw jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(company_id, provider, provider_transaction_id)
);

create table if not exists public.ocr_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade not null,
  user_id uuid references public.profiles(id) on delete set null,
  file_name text,
  mime_type text,
  provider text default 'openai',
  status text default 'processed',
  extracted jsonb default '{}'::jsonb,
  amount_ht numeric(14,2),
  amount_tva numeric(14,2),
  amount_ttc numeric(14,2),
  supplier_name text,
  document_date date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.signature_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade not null,
  user_id uuid references public.profiles(id) on delete set null,
  devis_id uuid references public.devis(id) on delete set null,
  provider text default 'yousign',
  provider_request_id text,
  provider_document_id text,
  signer_email text not null,
  signer_name text,
  status text default 'pending',
  signing_url text,
  sent_at timestamptz default now(),
  signed_at timestamptz,
  raw jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.fiscal_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade not null,
  kind text not null,
  label text not null,
  due_date date not null,
  status text default 'todo',
  amount numeric(14,2),
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity text,
  entity_id text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create table if not exists public.integration_settings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade not null,
  provider text not null,
  status text default 'not_configured',
  settings jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(company_id, provider)
);

create table if not exists public.account_pro_leads (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete set null,
  user_id uuid references public.profiles(id) on delete set null,
  email text not null,
  company_name text,
  siren text,
  need text default 'compte-pro',
  status text default 'new',
  raw jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

drop trigger if exists set_updated_at_app_snapshots on public.app_snapshots;
drop trigger if exists set_updated_at_bank_accounts on public.bank_accounts;
drop trigger if exists set_updated_at_bank_transactions on public.bank_transactions;
drop trigger if exists set_updated_at_ocr_documents on public.ocr_documents;
drop trigger if exists set_updated_at_signature_requests on public.signature_requests;
drop trigger if exists set_updated_at_fiscal_events on public.fiscal_events;
drop trigger if exists set_updated_at_integration_settings on public.integration_settings;

create trigger set_updated_at_app_snapshots before update on public.app_snapshots for each row execute function public.set_updated_at();
create trigger set_updated_at_bank_accounts before update on public.bank_accounts for each row execute function public.set_updated_at();
create trigger set_updated_at_bank_transactions before update on public.bank_transactions for each row execute function public.set_updated_at();
create trigger set_updated_at_ocr_documents before update on public.ocr_documents for each row execute function public.set_updated_at();
create trigger set_updated_at_signature_requests before update on public.signature_requests for each row execute function public.set_updated_at();
create trigger set_updated_at_fiscal_events before update on public.fiscal_events for each row execute function public.set_updated_at();
create trigger set_updated_at_integration_settings before update on public.integration_settings for each row execute function public.set_updated_at();

create index if not exists idx_app_snapshots_user on public.app_snapshots(user_id);
create index if not exists idx_app_snapshots_company on public.app_snapshots(company_id);
create index if not exists idx_bank_accounts_company on public.bank_accounts(company_id);
create index if not exists idx_bank_transactions_company on public.bank_transactions(company_id);
create index if not exists idx_bank_transactions_account on public.bank_transactions(bank_account_id);
create index if not exists idx_ocr_documents_company on public.ocr_documents(company_id);
create index if not exists idx_signature_requests_company on public.signature_requests(company_id);
create index if not exists idx_fiscal_events_company_due on public.fiscal_events(company_id, due_date);
create index if not exists idx_audit_logs_company on public.audit_logs(company_id);
create index if not exists idx_account_pro_leads_email on public.account_pro_leads(email);

alter table public.app_snapshots enable row level security;
alter table public.bank_accounts enable row level security;
alter table public.bank_transactions enable row level security;
alter table public.ocr_documents enable row level security;
alter table public.signature_requests enable row level security;
alter table public.fiscal_events enable row level security;
alter table public.audit_logs enable row level security;
alter table public.integration_settings enable row level security;
alter table public.account_pro_leads enable row level security;

drop policy if exists "Users manage own snapshots" on public.app_snapshots;
create policy "Users manage own snapshots" on public.app_snapshots for all
  using (user_id = auth.uid() and (company_id is null or public.is_company_member(company_id)))
  with check (user_id = auth.uid() and (company_id is null or public.is_company_member(company_id)));

do $$
declare
  t text;
begin
  foreach t in array array['bank_accounts','bank_transactions','ocr_documents','signature_requests','fiscal_events','integration_settings']
  loop
    execute format('drop policy if exists "Members read %s" on public.%I', t, t);
    execute format('drop policy if exists "Editors write %s" on public.%I', t, t);
    execute format('create policy "Members read %s" on public.%I for select using (public.is_company_member(company_id))', t, t);
    execute format('create policy "Editors write %s" on public.%I for all using (public.can_edit_company(company_id)) with check (public.can_edit_company(company_id))', t, t);
  end loop;
end $$;

drop policy if exists "Members read audit logs" on public.audit_logs;
create policy "Members read audit logs" on public.audit_logs for select
  using (company_id is null or public.is_company_member(company_id));

drop policy if exists "Users create account pro leads" on public.account_pro_leads;
drop policy if exists "Users read own account pro leads" on public.account_pro_leads;
create policy "Users create account pro leads" on public.account_pro_leads for insert
  with check (user_id = auth.uid() or user_id is null);
create policy "Users read own account pro leads" on public.account_pro_leads for select
  using (user_id = auth.uid() or (company_id is not null and public.is_company_member(company_id)));

grant execute on function public.is_company_member(uuid) to authenticated;
grant execute on function public.can_edit_company(uuid) to authenticated;

commit;
notify pgrst, 'reload schema';
