-- ════════════════════════════════════════════════════════════════
-- V8 : Refonte multi-orgs + invitations + rôles étendus
-- À exécuter dans Supabase Studio (SQL Editor)
-- 100% additif : aucune destruction de données existantes
-- ════════════════════════════════════════════════════════════════

-- ─── 1. PROFILES : ajout full_name + avatar ───
alter table public.profiles add column if not exists full_name text;
alter table public.profiles add column if not exists avatar text;
-- Backfill full_name pour les profils existants
update public.profiles
   set full_name = trim(coalesce(prenom,'') || ' ' || coalesce(nom,''))
 where full_name is null;

-- ─── 2. COMPANIES : ajout "type" (organization type) ───
alter table public.companies add column if not exists type text default 'company';
update public.companies set type = 'company' where type is null;
-- Contrainte d'enum sur type
alter table public.companies drop constraint if exists companies_type_check;
alter table public.companies add constraint companies_type_check
  check (type in ('individual','company','accounting_firm'));

-- ─── 3. MEMBERSHIPS : extension des rôles ───
alter table public.memberships drop constraint if exists memberships_role_check;
alter table public.memberships add constraint memberships_role_check
  check (role in ('owner','admin','accountant','employee','viewer','cabinet_owner','collaborator','assistant'));

-- ─── 4. TABLE INVITATIONS ───
create table if not exists public.invitations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references public.companies(id) on delete cascade not null,
  email           text not null,
  role            text default 'employee'
                       check (role in ('owner','admin','accountant','employee','viewer','cabinet_owner','collaborator','assistant')),
  token           text unique not null default replace(encode(gen_random_bytes(24),'base64'),'/','_'),
  invited_by      uuid references public.profiles(id) on delete set null,
  expires_at      timestamptz default (now() + interval '7 days'),
  accepted_at     timestamptz,
  created_at      timestamptz default now()
);
create index if not exists idx_invitations_org on public.invitations (organization_id);
create index if not exists idx_invitations_email on public.invitations (email);
create index if not exists idx_invitations_token on public.invitations (token);

-- RLS invitations : owner/admin/cabinet_owner peut tout faire sur les invitations de son org
alter table public.invitations enable row level security;
drop policy if exists "Owners read invitations"   on public.invitations;
drop policy if exists "Owners insert invitations" on public.invitations;
drop policy if exists "Owners delete invitations" on public.invitations;
drop policy if exists "Owners update invitations" on public.invitations;
create policy "Owners read invitations" on public.invitations for select using (
  exists (select 1 from public.memberships m
            where m.company_id = invitations.organization_id
              and m.user_id = auth.uid()
              and m.role in ('owner','admin','cabinet_owner'))
);
create policy "Owners insert invitations" on public.invitations for insert with check (
  invited_by = auth.uid()
  and exists (select 1 from public.memberships m
                where m.company_id = invitations.organization_id
                  and m.user_id = auth.uid()
                  and m.role in ('owner','admin','cabinet_owner'))
);
create policy "Owners delete invitations" on public.invitations for delete using (
  exists (select 1 from public.memberships m
            where m.company_id = invitations.organization_id
              and m.user_id = auth.uid()
              and m.role in ('owner','admin','cabinet_owner'))
);
create policy "Owners update invitations" on public.invitations for update using (
  exists (select 1 from public.memberships m
            where m.company_id = invitations.organization_id
              and m.user_id = auth.uid()
              and m.role in ('owner','admin','cabinet_owner'))
);

-- ─── 5. RPC : invite_member(org_id, email, role) → retourne le token ───
create or replace function public.invite_member(p_org_id uuid, p_email text, p_role text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  new_token text;
begin
  if uid is null then raise exception 'Non authentifié'; end if;
  if not exists (
    select 1 from public.memberships m
     where m.company_id = p_org_id
       and m.user_id = uid
       and m.role in ('owner','admin','cabinet_owner')
  ) then
    raise exception 'Permission refusée (rôle owner/admin requis)';
  end if;
  if p_role not in ('owner','admin','accountant','employee','viewer','cabinet_owner','collaborator','assistant') then
    raise exception 'Rôle invalide : %', p_role;
  end if;
  insert into public.invitations (organization_id, email, role, invited_by)
  values (p_org_id, lower(trim(p_email)), p_role, uid)
  returning token into new_token;
  return new_token;
end; $$;

-- ─── 6. RPC : accept_invitation(token) → ajoute le membership ───
create or replace function public.accept_invitation(p_token text)
returns table (organization_id uuid, role text, organization_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  inv record;
  uid uuid := auth.uid();
  uemail text;
begin
  if uid is null then raise exception 'Non authentifié'; end if;
  select email into uemail from auth.users where id = uid;
  select * into inv from public.invitations
    where token = p_token and accepted_at is null and expires_at > now();
  if not found then raise exception 'Invitation invalide ou expirée'; end if;
  if lower(inv.email) <> lower(uemail) then
    raise exception 'Cette invitation est destinée à % (vous êtes connecté avec %)', inv.email, uemail;
  end if;
  insert into public.memberships (company_id, user_id, role)
  values (inv.organization_id, uid, inv.role)
  on conflict (company_id, user_id) do update set role = excluded.role;
  update public.invitations set accepted_at = now() where id = inv.id;
  return query
    select inv.organization_id, inv.role,
           (select c.nom from public.companies c where c.id = inv.organization_id);
end; $$;

-- ─── 7. RPC : peek_invitation(token) — lecture publique de l'aperçu d'une invitation ───
create or replace function public.peek_invitation(p_token text)
returns table (org_id uuid, org_name text, org_type text, role text, email text, expires_at timestamptz, invited_by_name text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select i.organization_id,
           c.nom,
           c.type,
           i.role,
           i.email,
           i.expires_at,
           coalesce(p.full_name, p.prenom || ' ' || p.nom, p.email)
      from public.invitations i
      join public.companies c on c.id = i.organization_id
 left join public.profiles  p on p.id = i.invited_by
     where i.token = p_token
       and i.accepted_at is null
       and i.expires_at > now()
     limit 1;
end; $$;
grant execute on function public.peek_invitation(text) to anon, authenticated;

-- ─── 8. RPC : user_orgs() — toutes les orgs du user courant avec rôle ───
create or replace function public.user_orgs()
returns table (id uuid, name text, type text, role text, is_active boolean)
language sql
security definer
set search_path = public
as $$
  select c.id, c.nom, c.type, m.role, (c.owner_id = auth.uid()) as is_active
    from public.companies c
    join public.memberships m on m.company_id = c.id
   where m.user_id = auth.uid()
   order by c.created_at;
$$;

-- ─── 9. RPC : list_org_members(org_id) — pour la page Équipe ───
create or replace function public.list_org_members(p_org_id uuid)
returns table (user_id uuid, email text, full_name text, avatar text, role text, joined_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.memberships m
     where m.company_id = p_org_id and m.user_id = auth.uid()
  ) then
    raise exception 'Vous n''êtes pas membre de cette organisation';
  end if;
  return query
    select p.id,
           p.email,
           coalesce(p.full_name, trim(coalesce(p.prenom,'') || ' ' || coalesce(p.nom,''))),
           p.avatar,
           m.role,
           m.created_at
      from public.memberships m
      join public.profiles p on p.id = m.user_id
     where m.company_id = p_org_id
     order by m.created_at;
end; $$;

-- ─── 10. RPC : update_member_role(org_id, user_id, new_role) ───
create or replace function public.update_member_role(p_org_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Non authentifié'; end if;
  if not exists (
    select 1 from public.memberships m
     where m.company_id = p_org_id
       and m.user_id = uid
       and m.role in ('owner','admin','cabinet_owner')
  ) then
    raise exception 'Permission refusée';
  end if;
  if p_role not in ('owner','admin','accountant','employee','viewer','cabinet_owner','collaborator','assistant') then
    raise exception 'Rôle invalide';
  end if;
  -- Empêche de modifier son propre rôle (sécurité)
  if p_user_id = uid then
    raise exception 'Vous ne pouvez pas modifier votre propre rôle';
  end if;
  update public.memberships
     set role = p_role
   where company_id = p_org_id and user_id = p_user_id;
end; $$;

-- ─── 11. RPC : remove_member(org_id, user_id) ───
create or replace function public.remove_member(p_org_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Non authentifié'; end if;
  if not exists (
    select 1 from public.memberships m
     where m.company_id = p_org_id and m.user_id = uid
       and m.role in ('owner','admin','cabinet_owner')
  ) then
    raise exception 'Permission refusée';
  end if;
  if p_user_id = uid then
    raise exception 'Vous ne pouvez pas vous retirer vous-même';
  end if;
  delete from public.memberships
   where company_id = p_org_id and user_id = p_user_id;
end; $$;

-- ─── 12. RPC : list_pending_invitations(org_id) ───
create or replace function public.list_pending_invitations(p_org_id uuid)
returns table (id uuid, email text, role text, expires_at timestamptz, invited_by_name text, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.memberships m
     where m.company_id = p_org_id and m.user_id = auth.uid()
       and m.role in ('owner','admin','cabinet_owner')
  ) then
    raise exception 'Permission refusée';
  end if;
  return query
    select i.id, i.email, i.role, i.expires_at,
           coalesce(p.full_name, p.email),
           i.created_at
      from public.invitations i
 left join public.profiles p on p.id = i.invited_by
     where i.organization_id = p_org_id
       and i.accepted_at is null
       and i.expires_at > now()
     order by i.created_at desc;
end; $$;

-- ─── 13. RPC : cancel_invitation(invitation_id) ───
create or replace function public.cancel_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  inv record;
begin
  select * into inv from public.invitations where id = p_invitation_id;
  if not found then raise exception 'Invitation introuvable'; end if;
  if not exists (
    select 1 from public.memberships m
     where m.company_id = inv.organization_id and m.user_id = uid
       and m.role in ('owner','admin','cabinet_owner')
  ) then
    raise exception 'Permission refusée';
  end if;
  delete from public.invitations where id = p_invitation_id;
end; $$;

-- ─── 14. PERMISSIONS GRANTS ───
grant execute on function public.invite_member(uuid, text, text)         to authenticated;
grant execute on function public.accept_invitation(text)                 to authenticated;
grant execute on function public.user_orgs()                             to authenticated;
grant execute on function public.list_org_members(uuid)                  to authenticated;
grant execute on function public.update_member_role(uuid, uuid, text)    to authenticated;
grant execute on function public.remove_member(uuid, uuid)               to authenticated;
grant execute on function public.list_pending_invitations(uuid)          to authenticated;
grant execute on function public.cancel_invitation(uuid)                 to authenticated;

-- ─── 15. Mise à jour du trigger handle_new_user pour set company.type ───
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_company_id uuid;
  default_societe text;
  default_type text;
  default_profile_type text;
begin
  default_profile_type := coalesce(new.raw_user_meta_data->>'profile_type','entreprise');
  -- Mappe profile_type → org type
  if default_profile_type = 'cabinet' then default_type := 'accounting_firm';
  elsif (new.raw_user_meta_data->>'org_type') = 'individual' then default_type := 'individual';
  else default_type := 'company';
  end if;

  default_societe := coalesce(
    new.raw_user_meta_data->>'societe',
    new.raw_user_meta_data->>'org_name',
    'Mon entreprise'
  );

  insert into public.profiles (id, email, prenom, nom, full_name, societe, siren, profile_type)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'prenom', ''),
    coalesce(new.raw_user_meta_data->>'nom', ''),
    trim(coalesce(new.raw_user_meta_data->>'prenom','') || ' ' || coalesce(new.raw_user_meta_data->>'nom','')),
    default_societe,
    new.raw_user_meta_data->>'siren',
    default_profile_type
  );

  insert into public.companies (owner_id, nom, type, siren, exercice)
  values (new.id, default_societe, default_type, new.raw_user_meta_data->>'siren', to_char(now(),'YYYY'))
  returning id into new_company_id;

  -- Choisit le rôle owner selon le type d'org
  insert into public.memberships (company_id, user_id, role)
  values (
    new_company_id, new.id,
    case when default_type = 'accounting_firm' then 'cabinet_owner' else 'owner' end
  );

  insert into public.subscriptions (user_id, plan, status, trial_ends_at)
  values (new.id, 'trial', 'active', now() + interval '14 days');
  return new;
end; $$;

-- ════════════════════════════════════════════════════════════════
-- ✓ V8 installée. Vérifications :
-- ════════════════════════════════════════════════════════════════
select 'companies' as t, count(*) as n, count(*) filter (where type is not null) as with_type from public.companies
union all select 'invitations', count(*), null from public.invitations
union all select 'memberships', count(*), null from public.memberships;
