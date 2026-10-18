-- T16: recovery codes are sealed with the rotatable RECOVERY_CODES_KEYS keyring (format f1.<keyId>.…).
-- Earlier rows used the single-key format v1; none exist outside throwaway test databases.
ALTER TABLE "twoFactor" DROP CONSTRAINT "twoFactor_backupCodes_check";
--> statement-breakpoint
ALTER TABLE "twoFactor" ADD CONSTRAINT "twoFactor_backupCodes_check" CHECK ("backupCodes" LIKE 'f1.%');
