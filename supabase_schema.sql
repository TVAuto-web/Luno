-- ════════════════════════════════════════════════════════════════
-- ComptaPME Pro — Schéma Supabase
-- À exécuter UNE SEULE FOIS dans Supabase Studio (SQL Editor)
-- Crée toute la structure relationnelle + triggers + RLS
-- ════════════════════════════════════════════════════════════════

-- ─── 1. PROFILES (extension de auth.users) ───
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text unique not null,
  prenom        text,
  nom           text,
  societe       text,
  siren         text,
  profile_type  text default 'entreprise' check (profile_type in ('entreprise','cabinet')),
  ui_mode       text default 'simple'     check (ui_mode in ('simple','avance')),
  logo          text,
  tva_settings  jsonb,
  brand_color   text default '#1D9E75',
  doc_header    text,
  doc_footer    text,
  currency      text default 'EUR',
  decimal_sep   text default 'comma',
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ─── 2. COMPANIES (sociétés gérées) ───
create table if not exists public.companies (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid references public.profiles(id) on delete cascade not null,
  nom         text not null,
  siren       text,
  forme       text,
  adresse     text,
  email       text,
  exercice    text,
  actif       boolean default true,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ─── 3. MEMBERSHIPS (multi-user par société avec rôles) ───
create table if not exists public.memberships (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references public.companies(id) on delete cascade not null,
  user_id     uuid references public.profiles(id) on delete cascade not null,
  role        text default 'owner' check (role in ('owner','admin','editor','viewer')),
  created_at  timestamptz default now(),
  unique(company_id, user_id)
);

-- ─── 4. CLIENTS ───
create table if not exists public.clients (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references public.companies(id) on delete cascade not null,
  nom         text not null,
  contact     text,
  email       text,
  tel         text,
  siret       text,
  tva_num     text,
  adresse     text,
  cp          text,
  ville       text,
  delai       integer default 30,
  notes       text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ─── 5. FOURNISSEURS ───
create table if not exists public.fournisseurs (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references public.companies(id) on delete cascade not null,
  nom         text not null,
  contact     text,
  email       text,
  tel         text,
  siret       text,
  delai       integer default 30,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ─── 6. DEVIS ───
create table if not exists public.devis (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid references public.companies(id) on delete cascade not null,
  client_id    uuid references public.clients(id) on delete set null,
  num          text not null,
  date         date not null,
  valid_until  date,
  ht           numeric(14,2) not null,
  tva          numeric(5,2) default 20,
  ttc          numeric(14,2),
  st           text default 'en attente' check (st in ('en attente','accepté','refusé')),
  description  text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

-- ─── 7. FACTURES ───
create table if not exists public.factures (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid references public.companies(id) on delete cascade not null,
  client_id    uuid references public.clients(id) on delete set null,
  num          text not null,
  date         date not null,
  due_date     date,
  ht           numeric(14,2) not null,
  tva          numeric(5,2) default 20,
  tva_amount   numeric(14,2),
  ttc          numeric(14,2),
  st           text default 'en attente' check (st in ('payée','en attente','en retard')),
  description  text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

-- ─── 8. ACHATS ───
create table if not exists public.achats (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid references public.companies(id) on delete cascade not null,
  fournisseur_id  uuid references public.fournisseurs(id) on delete set null,
  num             text,
  date            date not null,
  ht              numeric(14,2) not null,
  tva             numeric(5,2),
  tva_amount      numeric(14,2),
  ttc             numeric(14,2),
  st              text default 'en attente',
  description     text,
  created_at      timestamptz default now()
);

-- ─── 9. ECRITURES (journal comptable) ───
create table if not exists public.ecritures (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid references public.companies(id) on delete cascade not null,
  date        date not null,
  journal     text,
  libelle     text,
  compte      text,
  debit       numeric(14,2) default 0,
  credit      numeric(14,2) default 0,
  reference   text,
  created_at  timestamptz default now()
);

-- ─── 10. SALARIÉS ───
create table if not exists public.salaries (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid references public.companies(id) on delete cascade not null,
  nom             text not null,
  prenom          text,
  poste           text,
  statut          text,
  salaire_brut    numeric(14,2),
  date_embauche   date,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ─── 11. SUBSCRIPTIONS ───
create table if not exists public.subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid references public.profiles(id) on delete cascade not null unique,
  plan                     text default 'trial' check (plan in ('essentiel','plus','premium','trial','starter','pro','entreprise')),
  status                   text default 'active' check (status in ('active','past_due','cancelled','expired')),
  trial_ends_at            timestamptz,
  current_period_end       timestamptz,
  stripe_customer_id       text,
  stripe_subscription_id   text,
  created_at               timestamptz default now(),
  updated_at               timestamptz default now()
);

-- ════════════════════════════════════════════════════════════════
-- TRIGGERS : updated_at automatique
-- ════════════════════════════════════════════════════════════════
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at_profiles      on public.profiles;
drop trigger if exists set_updated_at_companies     on public.companies;
drop trigger if exists set_updated_at_clients       on public.clients;
drop trigger if exists set_updated_at_fournisseurs  on public.fournisseurs;
drop trigger if exists set_updated_at_devis         on public.devis;
drop trigger if exists set_updated_at_factures      on public.factures;
drop trigger if exists set_updated_at_subscriptions on public.subscriptions;
drop trigger if exists set_updated_at_salaries      on public.salaries;

create trigger set_updated_at_profiles      before update on public.profiles      for each row execute function public.set_updated_at();
create trigger set_updated_at_companies     before update on public.companies     for each row execute function public.set_updated_at();
create trigger set_updated_at_clients       before update on public.clients       for each row execute function public.set_updated_at();
create trigger set_updated_at_fournisseurs  before update on public.fournisseurs  for each row execute function public.set_updated_at();
create trigger set_updated_at_devis         before update on public.devis         for each row execute function public.set_updated_at();
create trigger set_updated_at_factures      before update on public.factures      for each row execute function public.set_updated_at();
create trigger set_updated_at_subscriptions before update on public.subscriptions for each row execute function public.set_updated_at();
create trigger set_updated_at_salaries      before update on public.salaries      for each row execute function public.set_updated_at();

-- ════════════════════════════════════════════════════════════════
-- TRIGGER : Auto-création profile + société par défaut à l'inscription
-- ════════════════════════════════════════════════════════════════
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_company_id uuid;
  default_societe text;
begin
  -- 1. Profile (extrait les metadata fournies à signUp)
  insert into public.profiles (id, email, prenom, nom, societe, siren, profile_type)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'prenom', ''),
    coalesce(new.raw_user_meta_data->>'nom', ''),
    coalesce(new.raw_user_meta_data->>'societe', 'Mon entreprise'),
    new.raw_user_meta_data->>'siren',
    coalesce(new.raw_user_meta_data->>'profile_type', 'entreprise')
  );

  default_societe := coalesce(new.raw_user_meta_data->>'societe', 'Mon entreprise');

  -- 2. Société par défaut
  insert into public.companies (owner_id, nom, siren, exercice)
  values (
    new.id,
    default_societe,
    new.raw_user_meta_data->>'siren',
    to_char(now(), 'YYYY')
  )
  returning id into new_company_id;

  -- 3. Membership owner
  insert into public.memberships (company_id, user_id, role)
  values (new_company_id, new.id, 'owner');

  -- 4. Abonnement trial 14 jours
  insert into public.subscriptions (user_id, plan, status, trial_ends_at)
  values (new.id, 'trial', 'active', now() + interval '14 days');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY (RLS)
-- ════════════════════════════════════════════════════════════════

-- ─── profiles : un user gère son propre profil ───
alter table public.profiles enable row level security;
drop policy if exists "Read own profile"     on public.profiles;
drop policy if exists "Update own profile"   on public.profiles;
drop policy if exists "Insert own profile"   on public.profiles;
create policy "Read own profile"   on public.profiles for select using (auth.uid() = id);
create policy "Update own profile" on public.profiles for update using (auth.uid() = id);
create policy "Insert own profile" on public.profiles for insert with check (auth.uid() = id);

-- ─── companies : accès via memberships ───
alter table public.companies enable row level security;
drop policy if exists "Members read companies"      on public.companies;
drop policy if exists "Users create companies"      on public.companies;
drop policy if exists "Owners admins update co"     on public.companies;
drop policy if exists "Owners delete companies"     on public.companies;
create policy "Members read companies" on public.companies for select using (
  exists (select 1 from public.memberships m where m.company_id = companies.id and m.user_id = auth.uid())
);
create policy "Users create companies" on public.companies for insert with check (owner_id = auth.uid());
create policy "Owners admins update co" on public.companies for update using (
  exists (select 1 from public.memberships m where m.company_id = companies.id and m.user_id = auth.uid() and m.role in ('owner','admin'))
);
create policy "Owners delete companies" on public.companies for delete using (
  exists (select 1 from public.memberships m where m.company_id = companies.id and m.user_id = auth.uid() and m.role = 'owner')
);

-- ─── memberships ───
alter table public.memberships enable row level security;
drop policy if exists "Read own and same-co memberships" on public.memberships;
drop policy if exists "Owners admins manage memberships" on public.memberships;
create policy "Read own and same-co memberships" on public.memberships for select using (
  user_id = auth.uid() OR
  exists (select 1 from public.memberships m2 where m2.company_id = memberships.company_id and m2.user_id = auth.uid() and m2.role in ('owner','admin'))
);
create policy "Owners admins manage memberships" on public.memberships for all using (
  exists (select 1 from public.memberships m2 where m2.company_id = memberships.company_id and m2.user_id = auth.uid() and m2.role in ('owner','admin'))
)
with check (
  exists (select 1 from public.memberships m2 where m2.company_id = memberships.company_id and m2.user_id = auth.uid() and m2.role in ('owner','admin'))
);

-- ─── Tables d'entité (clients/fournisseurs/devis/factures/achats/ecritures/salaries) :
--     SELECT pour tous les membres, INSERT/UPDATE/DELETE pour owner/admin/editor ───
do $$
declare
  t text;
  read_pol_name text;
  write_pol_name text;
begin
  foreach t in array array['clients','fournisseurs','devis','factures','achats','ecritures','salaries']
  loop
    execute format('alter table public.%I enable row level security;', t);

    read_pol_name  := 'Members read ' || t;
    write_pol_name := 'Editors write ' || t;

    execute format('drop policy if exists %I on public.%I;', read_pol_name, t);
    execute format('drop policy if exists %I on public.%I;', write_pol_name, t);

    -- SELECT : tous les membres
    execute format($f$
      create policy %I on public.%I for select using (
        exists (select 1 from public.memberships m where m.company_id = %I.company_id and m.user_id = auth.uid())
      );
    $f$, read_pol_name, t, t);

    -- INSERT/UPDATE/DELETE : roles owner/admin/editor
    execute format($f$
      create policy %I on public.%I for all using (
        exists (select 1 from public.memberships m where m.company_id = %I.company_id and m.user_id = auth.uid() and m.role in ('owner','admin','editor'))
      ) with check (
        exists (select 1 from public.memberships m where m.company_id = %I.company_id and m.user_id = auth.uid() and m.role in ('owner','admin','editor'))
      );
    $f$, write_pol_name, t, t, t);
  end loop;
end $$;

-- ─── subscriptions : un user lit son abonnement, le système le met à jour ───
alter table public.subscriptions enable row level security;
drop policy if exists "Read own subscription" on public.subscriptions;
create policy "Read own subscription" on public.subscriptions for select using (user_id = auth.uid());

-- ════════════════════════════════════════════════════════════════
-- INDEXES (performance)
-- ════════════════════════════════════════════════════════════════
create index if not exists idx_companies_owner       on public.companies (owner_id);
create index if not exists idx_memberships_user      on public.memberships (user_id);
create index if not exists idx_memberships_company   on public.memberships (company_id);
create index if not exists idx_clients_company       on public.clients (company_id);
create index if not exists idx_fournisseurs_company  on public.fournisseurs (company_id);
create index if not exists idx_factures_company      on public.factures (company_id);
create index if not exists idx_factures_client       on public.factures (client_id);
create index if not exists idx_factures_st           on public.factures (st);
create index if not exists idx_devis_company         on public.devis (company_id);
create index if not exists idx_devis_client          on public.devis (client_id);
create index if not exists idx_achats_company        on public.achats (company_id);
create index if not exists idx_ecritures_company     on public.ecritures (company_id);
create index if not exists idx_salaries_company      on public.salaries (company_id);

-- ════════════════════════════════════════════════════════════════
-- ✓ Schéma installé. Vérifiez dans Table Editor que toutes les
--   tables apparaissent. Aucune donnée n'est créée — un trigger
--   créera profile + société + abonnement à chaque inscription.
-- ════════════════════════════════════════════════════════════════
