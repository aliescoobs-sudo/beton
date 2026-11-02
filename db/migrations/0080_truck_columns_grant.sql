-- R1: managers (owner, partner by policy) may edit a truck's plant, pay basis and stopped decision. Kind and code stay
-- unchangeable (no column grant); the plant of a truck with loads is also guarded by truck_plant_guard.
GRANT UPDATE (plant_id, pay_basis, stopped_decision) ON public.truck TO belgobeton_app;
