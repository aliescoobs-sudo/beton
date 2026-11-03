-- Lease principal can belong to a plant, truck or an explicit shared allocation;
--> statement-breakpoint
-- interest stays central.
ALTER TABLE finance.finance_facility ADD COLUMN plant_id uuid REFERENCES public.plant(id), ADD COLUMN truck_id uuid REFERENCES public.truck(id), ADD COLUMN allocation_id uuid REFERENCES finance.finance_allocation(id), ADD CHECK (plant_id IS NULL OR allocation_id IS NULL);
--> statement-breakpoint

CREATE FUNCTION finance.facility_asset_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.truck%ROWTYPE;
BEGIN
 IF NEW.truck_id IS NOT NULL THEN
 SELECT * INTO t FROM public.truck WHERE id=NEW.truck_id;
 IF t.id IS NULL THEN RAISE EXCEPTION 'unknown asset' USING ERRCODE='23514'; END IF;
 IF NEW.plant_id IS NULL AND NEW.allocation_id IS NULL THEN NEW.plant_id:=t.plant_id; END IF;
 IF NEW.plant_id IS NOT NULL AND t.plant_id IS DISTINCT FROM NEW.plant_id THEN RAISE EXCEPTION 'asset plant mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER facility_asset_guard BEFORE INSERT ON finance.finance_facility FOR EACH ROW EXECUTE FUNCTION finance.facility_asset_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION finance.facility_post() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE item jsonb; entry uuid; obligation uuid; total numeric:=0; idx integer:=0; last_date date:=NEW.start_date; p bigint; cost bigint; due date;
BEGIN
 IF jsonb_array_length(NEW.schedule)<1 OR jsonb_array_length(NEW.schedule)>600 THEN RAISE EXCEPTION 'invalid facility schedule' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(NEW.schedule) LOOP
 p:=(item->>'principalCentimes')::bigint; cost:=(item->>'costCentimes')::bigint; due:=(item->>'date')::date;
 IF p IS NULL OR cost IS NULL OR due IS NULL OR p<0 OR cost<0 OR p+cost<=0 OR due<last_date THEN RAISE EXCEPTION 'invalid facility item' USING ERRCODE='23514'; END IF;
 last_date:=due; total:=total+p; idx:=idx+1; entry:=gen_random_uuid();
 IF p>0 THEN INSERT INTO finance.finance_entry(id,entry_date,kind,amount_centimes,source_ref,created_by,plant_id,allocation_id)
 VALUES(entry,due,CASE WHEN NEW.kind='leasing' THEN 'leasing' ELSE 'principal' END,p,'facility:principal:'||NEW.id||':'||idx,NEW.created_by,NEW.plant_id,NEW.allocation_id); END IF;
 IF cost>0 THEN INSERT INTO finance.finance_entry(id,entry_date,kind,amount_centimes,source_ref,created_by)
 VALUES(gen_random_uuid(),due,'financing',cost,'facility:cost:'||NEW.id||':'||idx,NEW.created_by); END IF;
 INSERT INTO finance.finance_obligation(id,due_date,direction,amount_centimes,source_ref,label,created_by)
 VALUES(gen_random_uuid(),due,'out',p+cost,'facility:item:'||NEW.id||':'||idx,NEW.label,NEW.created_by);
 END LOOP;
 IF total<>NEW.principal_centimes THEN RAISE EXCEPTION 'facility principal mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.kind='bank' THEN
 obligation:=gen_random_uuid();
 INSERT INTO finance.finance_obligation(id,due_date,direction,amount_centimes,source_ref,label,created_by) VALUES(obligation,NEW.start_date,'in',NEW.principal_centimes,'facility:cash:'||NEW.id,NEW.label,NEW.created_by);
 INSERT INTO finance.finance_payment(id,obligation_id,payment_date,amount_centimes,account_id,reference,created_by) VALUES(gen_random_uuid(),obligation,NEW.start_date,NEW.principal_centimes,NEW.account_id,'facility:cash:'||NEW.id,NEW.created_by);
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint

--> statement-breakpoint
