# Spec: `notifications`

Status: DRAFT · Depends on: `rules-engine` · Shared conventions: [CAPABILITY-MAP.md](CAPABILITY-MAP.md)

## 1. Objective
Make sure the right person knows something needs attention, without leaking anything: full detail lives only in the app behind 2FA; Telegram and push carry a content-free nudge (🟡 D40, because bot chats are not end-to-end encrypted — RESEARCH §5).

## 2. Data model

| Table | Key columns | Notes |
|---|---|---|
| `notification` | id, user_id, alert_id, severity, created_at, sim_at, read_at | In-app inbox |
| `subscription_rule` | role / user_id, rule_ids[], min_severity, channels (`inapp`/`push`/`telegram`) | Defaults below |
| `telegram_link` | user_id, chat_id_enc, chat_id_hmac, linked_at, status (`active`/`revoked`) | |
| `telegram_link_code` | code_hash, user_id, expires_at (10 min), used_at | One-time |
| `push_subscription` | user_id, endpoint_enc, keys_enc, created_at | Web Push (VAPID) |
| `outbound_message` | id, channel, user_id, template_key, sent_at, status, error | Payload stored = template key + count only |

Default subscriptions (🟡): owner — all rules ≥ 🔵 in-app, ≥ 🟠 push + Telegram. Partner — same as owner, configurable (OQ10). Office — `PAY-DUE`/`RCV-DUE`/`RCV-OVERDUE`/`LAW6921-*` in-app, task-style without amounts beyond the document. Plant — `STOCK-*`, `TRUCK-OVERCAPACITY`, `RECON-GAP`, missing import/count in-app + push.

## 3. Behaviour
- Triggered when an alert is created, worsens in severity, or loses its override (not on unchanged recomputes — AC-RE-07).
- **Telegram message templates (fixed, no variables except counts and severity emoji):**
  - fr: `BELGOBETON — 1 nouvelle alerte 🔴. Détails dans l'application : https://<host>/alertes`
  - ar: `BELGOBETON — تنبيه جديد 🔴. التفاصيل في التطبيق: https://<host>/alertes`
  No names, codes, amounts, dates, alert ids, or counterparties. Link is generic; the app requires login + 2FA.
- No inline actions in Telegram in MVP; replies to the bot get a fixed "Répondez dans l'application" message. Incoming bot text is discarded (not stored, not sent to AI).
- Linking: in-app (session with 2FA) "Lier Telegram" shows a one-time code; user sends `/start <code>` to the bot; webhook validates the `X-Telegram-Bot-Api-Secret-Token` header, the code hash and expiry, stores chat id encrypted. Unlink in-app or `/stop`.
- Throttle (🟡 A25): per user, at most 1 Telegram message per 15 min (batched: "3 nouvelles alertes"); quiet hours 22:00–07:00 except 🔴.
- Web push: same minimal payload; clicking opens `/alertes`.
- In simulation, Telegram goes to a mock transport by default; a real test bot is allowed only with fake data and is opt-in via env.

## 4. Acceptance criteria
- **AC-NOT-01** Payload builder unit test: for every alert in the simulation, the Telegram and push payloads contain none of: any client/supplier name or code, any digit sequence other than the alert count, any date (leak scanner over the entities table + regex).
- **AC-NOT-02** Webhook rejects requests without the correct secret token header (401) and ignores unknown chat ids.
- **AC-NOT-03** Link code is single-use, expires after 10 min, and requires an authenticated 2FA session to generate.
- **AC-NOT-04** 4 alerts within 15 min to the owner ⇒ 1 Telegram message immediately + 1 batched message after the window; a 🔵 alert at 23:00 waits until 07:00, a 🔴 at 23:00 is sent.
- **AC-NOT-05** Recomputing with no change sends nothing; a severity increase sends once.
- **AC-NOT-06** The in-app inbox shows full detail only to roles allowed by RBAC (plant never sees cash alerts).
- **AC-NOT-07** Messages are in the user's locale (fr / ar).
- **AC-NOT-08** Bot token and VAPID keys come from env; an outbound failure is logged and retried with backoff (pg-boss), without logging the chat id.

## 5. Assumptions relied on
🟡 D40 (minimal Telegram + in-app + push), 🟡 D48 (languages), 🟡 A25 (throttle/quiet hours), default subscriptions 🟡, OQ10 (partner).
