-- ============================================================================
-- LUNO - Priorite 10: qualite donnees Supabase
-- Additive migration for full business data persistence.
-- Safe to run multiple times.
-- ============================================================================

begin;

create extension if not exists pgcrypto;

alter table if exists public.fournisseurs add column if not exists legacy_index integer;
alter table if exists public.fournisseurs add column if not exists tva_num text;
alter table if exists public.fournisseurs add column if not exists adresse text;
alter table if exists public.fournisseurs add column if not exists cp text;
alter table if exists public.fournisseurs add column if not exists ville text;
alter table if exists public.fournisseurs add column if not exists notes text;

alter table if exists public.achats add column if not exists legacy_index integer;
alter table if exists public.achats add column if not exists fournisseur_index integer;
alter table if exists public.achats add column if not exists due_date date;
alter table if exists public.achats add column if not exists raw jsonb default '{}'::jsonb;

alter table if exists public.ecritures add column if not exists legacy_index integer;
alter table if exists public.ecritures add column if not exists journal_code text;
alter table if exists public.ecritures add column if not exists compte_debit text;
alter table if exists public.ecritures add column if not exists compte_credit text;
alter table if exists public.ecritures add column if not exists montant numeric(14,2) default 0;
alter table if exists public.ecritures add column if not exists piece_jointe text;
alter table if exists public.ecritures add column if not exists raw jsonb default '{}'::jsonb;

create table if not exists public.tva_periods (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade not null,
  legacy_index integer,
  period text not null,
  collected numeric(14,2) default 0,
  deductible numeric(14,2) default 0,
  net numeric(14,2) default 0,
  status text default 'en cours',
  raw jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(company_id, period)
);

create table if not exists public.relance_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references public.companies(id) on delete cascade not null,
  legacy_id text,
  nom text not null,
  delai integer default 10,
  type text default 'email',
  objet text,
  message text,
  active boolean default true,
  raw jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(company_id, legacy_id)
);

create table if not exists public.app_snapshot_backups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade not null,
  company_id uuid references public.companies(id) on delete cascade,
  source text default 'web-app',
  version text default '1',
  data jsonb not null default '{}'::jsonb,
  reason text default 'sync',
  created_at timestamptz default now()
);

drop trigger if exists set_updated_at_tva_periods on public.tva_periods;
drop trigger if exists set_updated_at_relance_rules on public.relance_rules;
create trigger set_updated_at_tva_periods before update on public.tva_periods for each row execute function public.set_updated_at();
create trigger set_updated_at_relance_rules before update on public.relance_rules for each row execute function public.set_updated_at();

create index if not exists idx_fournisseurs_company_legacy on public.fournisseurs(company_id, legacy_index);
create index if not exists idx_achats_company_legacy on public.achats(company_id, legacy_index);
create index if not exists idx_ecritures_company_legacy on public.ecritures(company_id, legacy_index);
create index if not exists idx_tva_periods_company on public.tva_periods(company_id);
create index if not exists idx_relance_rules_company on public.relance_rules(company_id);
create index if not exists idx_app_snapshot_backups_company on public.app_snapshot_backups(company_id, created_at desc);
create index if not exists idx_app_snapshot_backups_user on public.app_snapshot_backups(user_id, created_at desc);

alter table public.tva_periods enable row level security;
alter table public.relance_rules enable row level security;
alter table public.app_snapshot_backups enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['tva_periods','relance_rules']
  loop
    execute format('drop policy if exists "Members read %s" on public.%I', t, t);
    execute format('drop policy if exists "Editors write %s" on public.%I', t, t);
    execute format('create policy "Members read %s" on public.%I for select using (public.is_company_member(company_id))', t, t);
    execute format('create policy "Editors write %s" on public.%I for all using (public.can_edit_company(company_id)) with check (public.can_edit_company(company_id))', t, t);
  end loop;
end $$;

drop policy if exists "Users read own snapshot backups" on public.app_snapshot_backups;
create policy "Users read own snapshot backups" on public.app_snapshot_backups for select
  using (user_id = auth.uid() and (company_id is null or public.is_company_member(company_id)));

commit;
notify pgrst, 'reload schema';
