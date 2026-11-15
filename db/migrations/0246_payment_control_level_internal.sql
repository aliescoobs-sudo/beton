-- T19 item 5: payment_control_level is an internal helper of the control doors and of the instrument gate (they run as definers); no request role needs to call it. No data.
REVOKE EXECUTE ON FUNCTION public.payment_control_level(bigint) FROM belgobeton_app;
