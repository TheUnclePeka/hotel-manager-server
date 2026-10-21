create table installation (
  singleton boolean primary key default true check(singleton),
  id uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now()
);
insert into installation(singleton) values(true);

create table users (
  id uuid primary key default gen_random_uuid(),
  login text not null unique check(login = lower(login)),
  name text not null,
  password_hash text not null,
  role text not null check(role in ('owner','manager','reception','viewer')),
  auth_version integer not null default 1,
  disabled_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index one_owner on users(role) where role = 'owner';
insert into users(login,name,password_hash,role)
  select lower(login),login,password_hash,'owner' from auth where id = 1;
-- The old all-powerful sessions cannot be silently upgraded to account sessions.
update devices set revoked_at = coalesce(revoked_at, now());
alter table devices add column user_id uuid references users(id);
alter table devices add column auth_version integer;
alter table devices add column access_expires_at timestamptz;

create table device_refresh_tokens (
  token_hash text primary key,
  device_id uuid not null references devices(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index refresh_device on device_refresh_tokens(device_id);
create table device_invitations (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null references users(id),
  auth_version integer not null,
  created_by uuid not null references users(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create table security_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid references users(id),
  device_id uuid references devices(id),
  event text not null,
  target_id uuid
);
create table auth_rate_limits (
  bucket text primary key,
  attempts integer not null,
  window_end timestamptz not null
);
alter table audit_log add column user_id uuid references users(id);
