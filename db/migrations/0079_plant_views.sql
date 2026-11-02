-- R1: the two operational views carry the plant of their document (appended last: CREATE OR REPLACE VIEW only appends).
CREATE OR REPLACE VIEW public.sales_order_ops WITH (security_barrier = true) AS
 SELECT o.id,
    o.code,
    o.concrete_type_id,
    o.volume_l,
    o.delivery_date,
    o.zone_id,
    o.site_id,
    c.code AS client_code,
    s.label AS site_label,
    o.reverses_id,
    (EXISTS ( SELECT 1
           FROM public.sales_order r
          WHERE (r.reverses_id = o.id))) AS is_reversed,
    o.plant_id
   FROM ((public.sales_order o
     JOIN public.client c ON ((c.id = o.client_id)))
     LEFT JOIN public.client_site s ON ((s.id = o.site_id)))
  WHERE (ctx.role() = ANY (ARRAY['owner'::text, 'support'::text, 'partner'::text, 'plant'::text]));
--> statement-breakpoint
CREATE OR REPLACE VIEW public.purchase_line_ops WITH (security_barrier = true) AS
 SELECT p.id AS purchase_id,
    p.code,
    s.code AS supplier_code,
    p.order_date,
    l.id AS line_id,
    l.seq,
    c.id AS component_id,
    c.name_fr,
    c.name_ar,
    u.label AS unit_label,
    u.factor_to_base,
    l.qty_milli,
    (EXISTS ( SELECT 1
           FROM public.purchase r
          WHERE (r.reverses_id = p.id))) AS is_reversed,
    p.plant_id
   FROM ((((public.purchase p
     JOIN public.supplier s ON ((s.id = p.supplier_id)))
     JOIN public.purchase_line l ON ((l.purchase_id = p.id)))
     JOIN public.component c ON ((c.id = l.component_id)))
     JOIN public.purchase_unit u ON ((u.id = l.purchase_unit_id)))
  WHERE ((p.reverses_id IS NULL) AND (ctx.role() = ANY (ARRAY['owner'::text, 'support'::text, 'partner'::text, 'plant'::text])));
