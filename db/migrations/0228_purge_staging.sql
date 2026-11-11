-- R19 gate G3 (retention): the ONE sanctioned erasure of staging personal data. Rollback keeps the staging (label texts, keys, raw quarantine cells) because nothing
-- in the history layer is ever deleted; but those cells are names and free text read from the company's files, and a discarded or rolled-back stage has no further use.
-- history.purge_staging() irreversibly clears them, on the owner's confirmation with a fresh second factor, audited with COUNTS only:
--   * the raw cells and the typed corrections of the quarantined rows of every set that has NO live (staged or applied) batch,
--   * the text and the key of every label that is still undecided, unknown or kept as a bare label ('pending', 'unknown', 'label_only'),
--   and nothing else: no delivery, expense, batch, client, mapping to a record (mapped / new) or any business record is touched (the history rows keep their own
--   cells; an APPLIED set keeps its quarantine, which documents what was applied). It refuses while any batch is only STAGED (a staged batch still needs its labels):
--   decide or roll it back first. Rows are marked `purged_at` and keep their identity; the guards allow no other change of a purged row.
-- Forward migration.
ALTER TABLE history.quarantine ADD COLUMN purged_at timestamptz;
--> statement-breakpoint
ALTER TABLE history.label_map ADD COLUMN purged_at timestamptz;
--> statement-breakpoint
-- a purged row keeps its place (the guards allow no other change), but the same files may be staged again afterwards: the place is unique among LIVE rows only
ALTER TABLE history.quarantine DROP CONSTRAINT quarantine_set_sha_kind_file_ord_sheet_pos_row_no_key;
--> statement-breakpoint
CREATE UNIQUE INDEX quarantine_place_live ON history.quarantine (set_sha, kind, file_ord, sheet_pos, row_no) WHERE purged_at IS NULL;
--> statement-breakpoint
CREATE POLICY purge_update ON history.quarantine FOR UPDATE TO belgobeton_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY purge_update ON history.label_map FOR UPDATE TO belgobeton_migrator USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT UPDATE ON history.quarantine, history.label_map TO belgobeton_migrator;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION history.quarantine_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'history.quarantine: a purged row does not change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.purged_at IS NOT NULL THEN
    -- the purge: only the door's own identity may do it, and the only change is the erasure itself
    IF current_user <> 'belgobeton_migrator' OR NEW.raw <> '{}'::jsonb OR NEW.fixed IS NOT NULL
       OR (NEW.id, NEW.set_sha, NEW.kind, NEW.file_ord, NEW.sheet_pos, NEW.row_no, NEW.reason)
          IS DISTINCT FROM (OLD.id, OLD.set_sha, OLD.kind, OLD.file_ord, OLD.sheet_pos, OLD.row_no, OLD.reason) THEN
      RAISE EXCEPTION 'history.quarantine: a row is purged only by history.purge_staging()' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.set_sha, NEW.kind, NEW.file_ord, NEW.sheet_pos, NEW.row_no, NEW.reason, NEW.raw)
     IS DISTINCT FROM (OLD.id, OLD.set_sha, OLD.kind, OLD.file_ord, OLD.sheet_pos, OLD.row_no, OLD.reason, OLD.raw) THEN
    RAISE EXCEPTION 'history.quarantine: the quarantined row keeps its place and its raw cells' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION history.label_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'history.label_map: a purged label does not change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.purged_at IS NOT NULL THEN
    IF current_user <> 'belgobeton_migrator' OR NEW.key <> 'purged:' || OLD.id::text OR NEW.label <> 'purged'
       OR (NEW.id, NEW.kind, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.kind, OLD.created_at) THEN
      RAISE EXCEPTION 'history.label_map: a label is purged only by history.purge_staging()' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.kind, NEW.key, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.kind, OLD.key, OLD.created_at) THEN
    RAISE EXCEPTION 'history.label_map: the key of a label does not change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION history.purge_staging() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_role text;
  v_q bigint;
  v_l bigint;
  v_counts jsonb;
BEGIN
  v_role := ctx.require_admitted_actor('history.purge_staging');
  IF v_role NOT IN ('owner', 'app_admin') OR ctx.driver_id() IS NOT NULL THEN
    RAISE EXCEPTION 'history.purge_staging: role % may not purge', v_role USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public._require_step_up('history.purge_staging');
  PERFORM pg_advisory_xact_lock(hashtextextended('belgobeton:history-import', 0));
  IF EXISTS (SELECT 1 FROM history.batch WHERE status = 'staged') THEN
    RAISE EXCEPTION 'history.purge_staging: a batch is still staged (decide it or roll it back first)' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE history.quarantine q SET raw = '{}'::jsonb, fixed = NULL, purged_at = clock_timestamp()
   WHERE q.purged_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM history.batch b WHERE b.set_sha = q.set_sha AND b.kind = q.kind AND b.status IN ('staged', 'applied'));
  GET DIAGNOSTICS v_q = ROW_COUNT;
  UPDATE history.label_map l SET key = 'purged:' || l.id::text, label = 'purged', purged_at = clock_timestamp()
   WHERE l.purged_at IS NULL AND l.status IN ('pending', 'unknown', 'label_only');
  GET DIAGNOSTICS v_l = ROW_COUNT;
  v_counts := jsonb_build_object('quarantine_rows_purged', v_q, 'labels_purged', v_l);
  PERFORM audit.record('import', 'history_import', gen_random_uuid()::text, NULL, v_counts, 'history staging purged (counts only)');
  RETURN v_counts;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION history.purge_staging() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION history.purge_staging() TO belgobeton_app;
