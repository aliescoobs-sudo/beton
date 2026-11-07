-- R13-01 / R14-13: the BIRTH MARKER of a training volume (a consumable marker, NOT a signed token or an attestation). The postgres image
-- runs every file of /docker-entrypoint-initdb.d exactly once, when it initialises an EMPTY data directory (the first creation of the
-- volume), as the superuser, against the `postgres` maintenance database. A volume that existed before this file was mounted, a database
-- restored or hand-built on a cluster without this row has none. The training seed claims it once, with the superuser login of the
-- maintenance container, and the claim binds it to the business database name; nobody else can read or write this table.
-- LIMIT, stated plainly: whoever can restore the maintenance database, a whole cluster or a physical snapshot can carry an UNUSED row
-- into another cluster, and a superuser can write one. Whether a volume is fresh and dedicated stays an operator fact, established
-- outside this code (docs/checkpoints/CP-TRAINING.md); a successful seed does not prove it.
create table public.volume_birth (
  only_row boolean primary key default true check (only_row),
  token uuid not null default gen_random_uuid(),
  born_at timestamptz not null default now(),
  consumed_at timestamptz,
  database_name text -- null until the first claim binds it to the business database
);
revoke all on public.volume_birth from public;
insert into public.volume_birth default values;
