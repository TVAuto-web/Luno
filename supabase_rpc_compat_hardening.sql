-- ============================================================================
-- LUNO / ComptaPME Pro - RPC compatibility + team security hardening
-- Applied to Supabase project hysznhfowtzfsbdntsyd on 2026-05-22.
--
-- Purpose:
-- - expose RPC names expected by the frontend V8 team/org UI
-- - keep compatibility with existing get_* RPCs already present in production
-- - require authenticated users for sensitive team/invitation mutations
-- ============================================================================

begin;

create or replace function public.user_orgs()
returns table (
  company_id uuid,
  company_name text,
  company_type text,
  user_role text,
  member_count bigint,
  logo_url text
)
language sql
security definer
set search_path = public
as $$
  select * from public.get_user_organizations();
$$;

create or replace function public.list_org_members(p_org_id uuid)
returns table (
  user_id uuid,
  email text,
  full_name text,
  avatar text,
  role text,
  joined_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select * from public.get_org_members(p_org_id);
$$;

create or replace function public.list_pending_invitations(p_org_id uuid)
returns table (
  inv_id uuid,
  email text,
  role text,
  expires_at timestamptz,
  created_at timestamptz,
  token uuid
)
language sql
security definer
set search_path = public
as $$
  select * from public.get_org_invitations(p_org_id);
$$;

create or replace function public.invite_member(p_organization_id uuid, p_email text, p_role text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_caller_role text;
  v_token uuid;
  v_org_name text;
begin
  if v_uid is null then
    return json_build_object('success', false, 'error', 'Authentification requise');
  end if;

  if p_role not in ('owner','admin','editor','viewer','client','collaborator','cabinet_owner') then
    return json_build_object('success', false, 'error', 'Role invalide');
  end if;

  select role into v_caller_role
  from memberships
  where user_id = v_uid and company_id = p_organization_id;

  if v_caller_role is null or v_caller_role not in ('owner', 'admin', 'cabinet_owner') then
    return json_build_object('success', false, 'error', 'Permissions insuffisantes pour inviter des membres');
  end if;

  if exists (
    select 1 from profiles p2
    join memberships m2 on m2.user_id = p2.id
    where lower(p2.email) = lower(trim(p_email))
      and m2.company_id = p_organization_id
  ) then
    return json_build_object('success', false, 'error', 'Cet utilisateur est deja membre de cette organisation');
  end if;

  delete from invitations
  where organization_id = p_organization_id
    and lower(email) = lower(trim(p_email))
    and accepted_at is null;

  insert into invitations (organization_id, invited_by, email, role)
  values (p_organization_id, v_uid, lower(trim(p_email)), p_role)
  returning token into v_token;

  select nom into v_org_name from companies where id = p_organization_id;

  return json_build_object(
    'success', true, 'token', v_token,
    'org_name', v_org_name, 'email', lower(trim(p_email)), 'role', p_role
  );
end;
$$;

create or replace function public.update_member_role(p_org_id uuid, p_user_id uuid, p_new_role text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_caller_role text;
  v_target_role text;
begin
  if v_uid is null then
    return json_build_object('success', false, 'error', 'Authentification requise');
  end if;

  select role into v_caller_role from memberships
  where user_id = v_uid and company_id = p_org_id;
  if v_caller_role is null or v_caller_role not in ('owner','admin','cabinet_owner') then
    return json_build_object('success',false,'error','Permissions insuffisantes');
  end if;

  select role into v_target_role from memberships
  where user_id = p_user_id and company_id = p_org_id;
  if v_target_role is null then
    return json_build_object('success',false,'error','Membre introuvable');
  end if;
  if v_target_role in ('owner','cabinet_owner') then
    return json_build_object('success',false,'error','Impossible de modifier le role du proprietaire');
  end if;
  if p_user_id = v_uid then
    return json_build_object('success',false,'error','Vous ne pouvez pas modifier votre propre role');
  end if;

  update memberships set role = p_new_role
  where user_id = p_user_id and company_id = p_org_id;
  return json_build_object('success',true,'new_role',p_new_role);
end;
$$;

create or replace function public.remove_member(p_org_id uuid, p_user_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_caller_role text;
  v_target_role text;
begin
  if v_uid is null then
    return json_build_object('success', false, 'error', 'Authentification requise');
  end if;

  select role into v_caller_role from memberships
  where user_id = v_uid and company_id = p_org_id;
  if v_caller_role is null or v_caller_role not in ('owner','admin','cabinet_owner') then
    return json_build_object('success',false,'error','Permissions insuffisantes');
  end if;

  select role into v_target_role from memberships
  where user_id = p_user_id and company_id = p_org_id;
  if v_target_role is null then
    return json_build_object('success',false,'error','Membre introuvable');
  end if;
  if v_target_role in ('owner','cabinet_owner') then
    return json_build_object('success',false,'error','Impossible de retirer le proprietaire');
  end if;
  if p_user_id = v_uid then
    return json_build_object('success',false,'error','Utilisez Quitter l organisation pour vous retirer');
  end if;

  delete from memberships where user_id = p_user_id and company_id = p_org_id;
  return json_build_object('success',true);
end;
$$;

create or replace function public.revoke_invitation(p_inv_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_org_id uuid;
  v_caller_role text;
begin
  if v_uid is null then
    return json_build_object('success', false, 'error', 'Authentification requise');
  end if;

  select organization_id into v_org_id
  from invitations where id = p_inv_id and accepted_at is null;
  if not found then
    return json_build_object('success',false,'error','Invitation introuvable ou deja acceptee');
  end if;

  select role into v_caller_role from memberships
  where user_id = v_uid and company_id = v_org_id;
  if v_caller_role is null or v_caller_role not in ('owner','admin','cabinet_owner') then
    return json_build_object('success',false,'error','Permissions insuffisantes');
  end if;

  delete from invitations where id = p_inv_id;
  return json_build_object('success',true);
end;
$$;

create or replace function public.cancel_invitation(p_invitation_id uuid)
returns json
language sql
security definer
set search_path = public
as $$
  select public.revoke_invitation(p_invitation_id);
$$;

create or replace function public.accept_invitation(p_token uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_inv invitations%rowtype;
  v_org_name text;
  v_user_email text;
begin
  if v_uid is null then
    return json_build_object('success', false, 'error', 'Authentification requise');
  end if;

  select * into v_inv
  from invitations
  where token = p_token and accepted_at is null and expires_at > now();

  if not found then
    return json_build_object('success', false, 'error', 'Invitation invalide ou expiree');
  end if;

  select lower(email) into v_user_email from auth.users where id = v_uid;

  if v_user_email is null or v_user_email != lower(v_inv.email) then
    return json_build_object('success', false, 'error', 'Cette invitation est destinee a ' || v_inv.email);
  end if;

  insert into memberships (user_id, company_id, role)
  values (v_uid, v_inv.organization_id, v_inv.role)
  on conflict (company_id, user_id) do update set role = excluded.role;

  update invitations set accepted_at = now() where id = v_inv.id;
  select nom into v_org_name from companies where id = v_inv.organization_id;

  return json_build_object('success', true, 'org_id', v_inv.organization_id, 'org_name', v_org_name, 'role', v_inv.role);
end;
$$;

grant execute on function public.user_orgs() to anon, authenticated;
grant execute on function public.list_org_members(uuid) to anon, authenticated;
grant execute on function public.list_pending_invitations(uuid) to anon, authenticated;

revoke execute on function public.invite_member(uuid,text,text) from public;
revoke execute on function public.update_member_role(uuid,uuid,text) from public;
revoke execute on function public.remove_member(uuid,uuid) from public;
revoke execute on function public.revoke_invitation(uuid) from public;
revoke execute on function public.cancel_invitation(uuid) from public;
revoke execute on function public.accept_invitation(uuid) from public;

grant execute on function public.invite_member(uuid,text,text) to authenticated;
grant execute on function public.update_member_role(uuid,uuid,text) to authenticated;
grant execute on function public.remove_member(uuid,uuid) to authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;
grant execute on function public.cancel_invitation(uuid) to authenticated;
grant execute on function public.accept_invitation(uuid) to authenticated;

commit;
notify pgrst, 'reload schema';
