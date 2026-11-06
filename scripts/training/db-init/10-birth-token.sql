-- R13-01: the BIRTH TOKEN of a training volume. The postgres image runs every file of /docker-entrypoint-initdb.d exactly once, when it
-- initialises an EMPTY data directory (the first creation of the volume), as the superuser, against the `postgres` maintenance
-- database. A volume that existed before this file was mounted, a restored dump or a hand-built database has no token. The training
-- seed claims the token (once) with the superuser login of the maintenance container; nobody else can read or write this table.
create table public.volume_birth (
  only_row boolean primary key default true check (only_row),
  token uuid not null default gen_random_uuid(),
  born_at timestamptz not null default now(),
  consumed_at timestamptz
);
revoke all on public.volume_birth from public;
insert into public.volume_birth default values;
