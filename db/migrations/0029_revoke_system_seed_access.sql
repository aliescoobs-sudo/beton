-- Decision (T10-T15 review): the seed does not run as belgobeton_system. The system role (scheduled jobs, key rotation,
-- security checks) must not be able to insert master data, bump the code counters, or read prices. The pilot seed has its
-- own login role, belgobeton_seed, which exists only when db:bootstrap runs with SIMULATION_ENABLED=true (never with
-- REAL_DATA or in production) and gets its grants from db/seed/seed-role.sql, applied after the migrations.
-- This migration takes back what 0021, 0022, 0027 and 0028 had given system for seeding. The reads of 0017-0023
-- (zone, client, supplier, component, concrete type, recette: the reads jobs and key rotation use) stay.
REVOKE INSERT ON public.zone, public.client, public.supplier, public.recette, public.recette_line,
  public.purchase_price, public.selling_price, public.truck, public.component, public.purchase_unit,
  public.concrete_type FROM belgobeton_system;
--> statement-breakpoint
REVOKE SELECT ON public.purchase_price, public.selling_price FROM belgobeton_system;
--> statement-breakpoint
REVOKE ALL ON public.code_sequence FROM belgobeton_system;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.next_code(text, integer) FROM belgobeton_system;
--> statement-breakpoint
DROP POLICY zone_insert_system ON public.zone;
--> statement-breakpoint
DROP POLICY client_insert_system ON public.client;
--> statement-breakpoint
DROP POLICY supplier_insert_system ON public.supplier;
--> statement-breakpoint
DROP POLICY recette_insert_system ON public.recette;
--> statement-breakpoint
DROP POLICY recette_line_insert_system ON public.recette_line;
--> statement-breakpoint
DROP POLICY purchase_price_read_system ON public.purchase_price;
--> statement-breakpoint
DROP POLICY purchase_price_insert_system ON public.purchase_price;
--> statement-breakpoint
DROP POLICY selling_price_read_system ON public.selling_price;
--> statement-breakpoint
DROP POLICY selling_price_insert_system ON public.selling_price;
--> statement-breakpoint
DROP POLICY component_insert_system ON public.component;
--> statement-breakpoint
DROP POLICY purchase_unit_insert_system ON public.purchase_unit;
--> statement-breakpoint
DROP POLICY concrete_type_insert_system ON public.concrete_type;
--> statement-breakpoint
DROP POLICY truck_insert_system ON public.truck;
--> statement-breakpoint
DROP POLICY code_sequence_system ON public.code_sequence;
