-- R18 group 4B (T11 staging rules). Forward migration.
--   1. The audit rows of the STAGING tables carry no cell value. history.label_map holds the names read from the files (clients, drivers, trucks) and
--      history.quarantine holds the raw cells of rows that could not be read; audit.capture() recorded the whole row, so the audit log (read by the owner and
--      support) held them too. A redacting capture takes their place: the row id, the kind, the status, the decision, the place of the row (file, sheet, row),
--      the fixed reason phrase, who and when. The batch table (numbers only) keeps the ordinary capture.
--   2. A STAGED batch can be reversed: staged -> rolled_back (nothing was applied, nothing is deleted). Its quarantined rows are marked discarded (and marked as
--      discarded by the batch, so staging the same files again reopens them); the label decisions stay (they are the owner's, reusable by the next set).
CREATE FUNCTION history.audit_capture_redacted() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_after  jsonb;
  v_before jsonb;
BEGIN
  IF TG_TABLE_NAME = 'label_map' THEN
    v_after := jsonb_build_object('id', NEW.id, 'kind', NEW.kind, 'status', NEW.status, 'uses', NEW.uses, 'client_id', NEW.client_id,
                                  'truck_id', NEW.truck_id, 'driver_id', NEW.driver_id, 'canonical', NEW.canonical, 'decided_by', NEW.decided_by);
    IF TG_OP = 'UPDATE' THEN
      v_before := jsonb_build_object('id', OLD.id, 'kind', OLD.kind, 'status', OLD.status, 'client_id', OLD.client_id, 'truck_id', OLD.truck_id,
                                     'driver_id', OLD.driver_id, 'canonical', OLD.canonical);
    END IF;
  ELSE
    v_after := jsonb_build_object('id', NEW.id, 'kind', NEW.kind, 'set_sha', NEW.set_sha, 'file_ord', NEW.file_ord, 'sheet_pos', NEW.sheet_pos,
                                  'row_no', NEW.row_no, 'reason', NEW.reason, 'status', NEW.status, 'batch_discarded', NEW.batch_discarded,
                                  'decided_by', NEW.decided_by);
    IF TG_OP = 'UPDATE' THEN
      v_before := jsonb_build_object('id', OLD.id, 'status', OLD.status, 'batch_discarded', OLD.batch_discarded);
    END IF;
  END IF;
  PERFORM audit.append(lower(TG_OP), 'history.' || TG_TABLE_NAME, NEW.id::text, v_before, v_after, NULL);
  RETURN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE history.quarantine ADD COLUMN batch_discarded boolean NOT NULL DEFAULT false;
--> statement-breakpoint
DROP TRIGGER audit_capture ON history.label_map;
--> statement-breakpoint
DROP TRIGGER audit_capture ON history.quarantine;
--> statement-breakpoint
CREATE TRIGGER audit_capture AFTER INSERT OR UPDATE ON history.label_map FOR EACH ROW EXECUTE FUNCTION history.audit_capture_redacted();
--> statement-breakpoint
CREATE TRIGGER audit_capture AFTER INSERT OR UPDATE ON history.quarantine FOR EACH ROW EXECUTE FUNCTION history.audit_capture_redacted();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION history.batch_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.id, NEW.kind, NEW.plant_id, NEW.set_sha, NEW.files, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.kind, OLD.plant_id, OLD.set_sha, OLD.files, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'history.batch: only the status and its marks change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT ((OLD.status = 'staged' AND NEW.status IN ('staged', 'applied', 'rolled_back'))
          OR (OLD.status = 'applied' AND NEW.status IN ('applied', 'rolled_back'))
          OR OLD.status = NEW.status) THEN
    RAISE EXCEPTION 'history.batch: % cannot become %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
