-- Schema hardening and request context helpers (SPEC-platform-security §4).
-- Roles and databases are created by scripts/db-bootstrap.ts (superuser); this runs as belgobeton_migrator.

-- Only the migrator may create objects; runtime roles may only use what migrations grant explicitly.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO belgobeton_app, belgobeton_auth, belgobeton_system;
--> statement-breakpoint

-- Request context, set per transaction by withRlsContext() via set_config(..., true).
-- Empty settings (outside a context) read as NULL, so policies fail closed.
CREATE SCHEMA ctx;
--> statement-breakpoint
CREATE FUNCTION ctx.user_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION ctx.role() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.role', true), '') $$;
--> statement-breakpoint
CREATE FUNCTION ctx.request_id() RETURNS text LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.request_id', true), '') $$;
--> statement-breakpoint
CREATE FUNCTION ctx.sim_at() RETURNS timestamptz LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.sim_at', true), '')::timestamptz $$;
--> statement-breakpoint
REVOKE ALL ON SCHEMA ctx FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ctx FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA ctx TO belgobeton_app, belgobeton_auth, belgobeton_system;
--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ctx TO belgobeton_app, belgobeton_auth, belgobeton_system;
