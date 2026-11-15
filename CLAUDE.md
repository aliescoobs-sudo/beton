# KAYAS — project rules (formerly BELGOBETON)
- Read docs/BRIEF.md, docs/DECISIONS.md and docs/DOMAIN.md before any work.
- Principle #0: security and privacy first. Never weaken RBAC, 2FA, audit log or encryption.
- Money is computed by deterministic code only, stored as integer centimes. AI never computes amounts.
- No hard deletes of financial records; corrections are reversing entries.
- No AI action without human confirmation. Pseudonymize data before any AI call.
- Pilot uses fake data only. Never commit secrets; use environment variables.
- Business vocabulary follows docs/DOMAIN.md (m³, recette, LCN, échéance...).
- Security debt: from now on every shortcut or deferred hardening gets one row in docs/SECURITY-DEBT.md (date, area, what, why, what the final audit must verify). No per-task independent review until the final audit. Existing controls (RLS, SECURITY DEFINER doors, audit chain, TOTP, origin check, rate limits) are never removed or weakened. Fictitious data only.
