-- DECISIONS 72: set after a recovery-code login; cleared once a new authenticator is confirmed. While set, every
-- sensitive action is refused (REENROL_REQUIRED).
ALTER TABLE "user" ADD COLUMN "reenrolRequired" boolean NOT NULL DEFAULT false;
