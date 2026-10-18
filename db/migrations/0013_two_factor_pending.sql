-- DECISIONS 77 (CP4): a re-enrolment is staged here; the user's current authenticator and recovery codes stay valid
-- in "twoFactor" until the new authenticator is confirmed, then both are swapped in one transaction.
CREATE TABLE two_factor_pending (
  user_id      text PRIMARY KEY REFERENCES "user" ("id"),
  secret       text NOT NULL,                                    -- encrypted by Better Auth, like "twoFactor".secret
  backup_codes text NOT NULL CHECK (backup_codes LIKE 'f1.%'),   -- RECOVERY_CODES_KEYS keyring
  created_at   timestamptz NOT NULL
);
--> statement-breakpoint
REVOKE ALL ON two_factor_pending FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON two_factor_pending TO belgobeton_auth;
