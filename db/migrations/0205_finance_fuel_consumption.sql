-- Fuel is charged when dispensed, not when the tank is purchased.
CREATE TABLE finance.finance_fuel_cost (
 id uuid PRIMARY KEY, fill_id uuid NOT NULL UNIQUE REFERENCES public.fuel_fill(id),
 amount_centimes bigint NOT NULL CHECK(amount_centimes>=0 AND amount_centimes<=9007199254740991),
 price_per_litre_centimes bigint NOT NULL CHECK(price_per_litre_centimes>0 AND price_per_litre_centimes<=9007199254740991),
 allocation_id uuid REFERENCES finance.finance_allocation(id), valuation_reference text NOT NULL CHECK(length(valuation_reference) BETWEEN 1 AND 200),
 created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
--> statement-breakpoint

ALTER TABLE finance.finance_fuel_cost ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

ALTER TABLE finance.finance_fuel_cost FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

REVOKE ALL ON finance.finance_fuel_cost FROM PUBLIC;
--> statement-breakpoint

GRANT SELECT,INSERT ON finance.finance_fuel_cost TO belgobeton_app;
--> statement-breakpoint

CREATE POLICY definer_read ON finance.finance_fuel_cost FOR SELECT TO belgobeton_migrator USING(true);
--> statement-breakpoint

CREATE POLICY finance_read ON finance.finance_fuel_cost FOR SELECT TO belgobeton_app USING(ctx.role() IN ('owner','app_admin') AND finance.enabled());
--> statement-breakpoint

CREATE POLICY finance_insert ON finance.finance_fuel_cost FOR INSERT TO belgobeton_app WITH CHECK(ctx.role() IN ('owner','app_admin') AND finance.enabled() AND created_by=ctx.user_id());
--> statement-breakpoint

SELECT audit.attach('finance.finance_fuel_cost');
--> statement-breakpoint

CREATE TRIGGER a_finance_authorize BEFORE INSERT ON finance.finance_fuel_cost FOR EACH ROW EXECUTE FUNCTION finance.write_guard();
--> statement-breakpoint

CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON finance.finance_fuel_cost FOR EACH ROW EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

CREATE TRIGGER immutable_table BEFORE TRUNCATE ON finance.finance_fuel_cost FOR EACH STATEMENT EXECUTE FUNCTION audit.forbid_change();
--> statement-breakpoint

CREATE FUNCTION finance.fuel_cost_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE f public.fuel_fill%ROWTYPE; kind text;
BEGIN
 SELECT * INTO f FROM public.fuel_fill WHERE id=NEW.fill_id;
 SELECT t.kind INTO kind FROM public.truck t WHERE t.id=f.truck_id;
 IF f.id IS NULL OR NEW.amount_centimes<>round(f.litres_ml::numeric*NEW.price_per_litre_centimes/1000)::bigint THEN RAISE EXCEPTION 'fuel valuation does not match dispensing' USING ERRCODE='23514'; END IF;
 IF kind='pump' AND NEW.allocation_id IS NULL THEN RAISE EXCEPTION 'pump fuel needs an explicit allocation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER fuel_cost_guard BEFORE INSERT ON finance.finance_fuel_cost FOR EACH ROW EXECUTE FUNCTION finance.fuel_cost_guard();
--> statement-breakpoint

CREATE FUNCTION finance.source_fuel(p_from date,p_to date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
 IF coalesce(ctx.role(),'') NOT IN ('owner','app_admin') OR NOT finance.enabled() THEN RAISE EXCEPTION 'finance unavailable' USING ERRCODE='42501'; END IF;
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id',f.id,'date',f.filled_on,'plantId',CASE WHEN v.allocation_id IS NULL THEN f.plant_id END,'kind','expense','amountCentimes',v.amount_centimes,'allocation',a.weights,'qtyMl',f.litres_ml,'truck',t.code))
 FROM public.fuel_fill f JOIN public.truck t ON t.id=f.truck_id LEFT JOIN finance.finance_fuel_cost v ON v.fill_id=f.id LEFT JOIN finance.finance_allocation a ON a.id=v.allocation_id
 WHERE f.filled_on BETWEEN p_from AND p_to),'[]'::jsonb);
END $$;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION finance.source_fuel(date,date) TO belgobeton_app;
--> statement-breakpoint
