# RESEARCH.md — KAYAS

Research date: 2026-10-18. Facts below are paraphrased from the listed sources. Items marked (assumption) are our own estimates, not sourced facts.

## 1. Existing software
- **Specialized ready-mix suites** (e.g. Command Alkon Integra/COMMANDseries, Jonel) cover quote-to-cash: quotes, order entry, scheduling, ticketing, truck tracking, invoicing/receivables, plus inventory and credit modules. Dispatch can send orders/mix to the batching system and receive actual batched quantities back.
- They are US/EU products, logistics-centric, and do not model Moroccan payment practices (post-dated cheques, LCN, installments) or owner-level cash-risk forecasting.
- **Generic manufacturing tools** (e.g. Daftra, Arabic-language) handle bills of materials and raw-material consumption, but are not concrete-specific.
- **Cash-forecasting tools** (e.g. Agicap) do scenarios and auto-categorization of inflows/outflows, but know nothing about concrete operations or Moroccan instruments.
- We did not find a Moroccan concrete-specific product (not proof that none exists).
- **Opportunity:** combine cash-risk brain + concrete operations + Moroccan payment instruments.

## 2. Plant software integration
- Common batching software can export shipment/production data (example: COMMANDbatch exports CSV/XLS/XML). File import is a realistic pilot path. Actual export format of the client's plant software is unknown.

## 3. Operational parameters
- Historical rule: discharge within 90 minutes of adding water; newer ASTM guidance lets buyer and producer set the limit case by case. → configurable, default 90 min.
- Typical site unloading allowance ~30 min (≈10 discharge + 20 buffer). Truck capacities vary. → per-truck capacity parameter (assumption: 8 m³).

## 4. Moroccan legal and financial risks

### Cheques
- A cheque is legally payable on sight → a post-dated cheque can be presented before its written date.
- Law 71.24 (Code de commerce reform) is in force: 1-month window to regularize a bounced cheque before prosecution; full payment ends the action; prison range reduced to 6 months–3 years; late-payment fine reduced from 25% to 2% of the cheque amount.
- ~972,000 cheques were rejected for missing/insufficient funds in 2024 → the risk is frequent.

### LCN (lettre de change normalisée)
- Widely used in B2B transactions; Bank Al-Maghrib centralizes LCN payment incidents.

### Law 69-21 (payment deadlines)
- 60 days by default, 120 days by agreement, counted from invoice date; invoice issued at the latest on the last day of the delivery month.
- Late-payment fines: BAM rate (2.5%) + 0.85% per extra month; quarterly declaration (SIMPL); non-declaration fines 5,000–250,000 MAD.
- For revenue < 50M MAD, the late-invoice statement is certified by a chartered accountant.

### E-invoicing (DGI)
- Legal basis: CGI art. 145-IX. As of April 2026 the implementing decree was still under review; some sources give July 2026 for companies with 10–200M MAD revenue and January 2027 for smaller ones. Status unclear → verify with the company's accountant.

### Personal data (law 09-08, CNDP)
- Any client/billing database requires a prior declaration to CNDP.
- Prior authorization is required for sensitive data, national ID numbers, and transfers abroad to countries without adequate protection; CNDP has 30 days, silence = rejection.
- Fines: missing declaration/authorization 10,000–100,000 MAD; illegal transfer abroad 3 months–1 year + 20,000–200,000 MAD.

## 5. Notifications
- WhatsApp Business Platform: from 1 Oct 2026, utility templates are billed per message; first 1,000 service messages per number per month free.
- Telegram bots: inline buttons send callback data to the bot (suits "answer with a button"). Bot chats are not end-to-end encrypted → no sensitive content in messages.

## 6. AI providers (Sept–Oct 2026)
- Claude (Anthropic): Haiku 5.5 $0.10/$0.50 per MTok (prompts ≤100k tokens); Sonnet 5.5 $2/$10; Opus 5.5 $4/$20. API data not used for training without permission; conversation content not retained by default; ZDR available on request. Batch API retains data 29 days (not ZDR-eligible). Fable/Mythos models require 30-day retention.
- Mistral Large 3: ~$0.50/$1.50 per MTok (EU provider).
- Gemini 3.1 Pro Preview: $2/$12 per MTok (below 200k tokens).
- Note: this research was produced by Claude (Anthropic) → conflict of interest; final choice by evaluation.

## 7. Market context
- Ready-mix is the 2nd largest cement outlet in Morocco (~27% of deliveries) and grew 7.94% through July 2026.
- The Competition Council flagged technical non-compliance by some small plants and called for mandatory plant certification → traceability can be a competitive advantage.

## Sources
- Command Alkon Integra: https://old.commandalkon.com/product/integra
- Command Alkon Dispatch: https://commandalkon.com/?p=27585155
- COMMANDbatch spec: https://catalog.jamiesonequipment.com/Asset/COMMANDbatch_RM100200_Spec.pdf
- Daftra manufacturing: https://www.daftra.com/blog/?p=9733
- Agicap: https://www.frenchweb.fr/agicap-recolte-15-millions-deuros-pour-gerer-la-tresorerie-des-pme/399666
- Ready-mix trucks: https://structville.com/ready-mix-concrete-mixer-trucks-and-construction
- 90-minute rule: https://www.hunker.com/2200511/what-is-90-minute-rule-for-mixed-concrete/
- Cheque reform (lawyer interview): https://fnh.ma/articles/bracelet-electronique-justice-penalisation
- Law 71.24 in force: https://fr.le360.ma/economie/cheques-sans-provision-une-reforme-sous-le-signe-du-pragmatisme_GIDEJ64KVJBJDEJI5QZHUAJ6CA/
- Prison/fine changes: https://www.bladi.net/cheques-provision-maroc-met-fin-ere-prison-automatique,119296.html
- 2024 rejections: https://lematin.ma/nation/cheques-sans-provision-le-gouvernement-assouplit-le-cadre-legal/306682/amp
- LCN: https://www.fnh.ma/articles/instruments-de-paiement-18-1-des-lcn-rejetees-en-2014
- Law 69-21: https://upsilon-consulting.com/loi-69-21-delais-paiement/
- 69-21 rates: https://www.bladi.net/entreprises-maroc-attention-amendes-salees,113505.html
- DGI e-invoicing: https://medias24.com/2026/04/16/dgi-facturation-electronique-lancement-en-preparation-les-details-avec-younes-idrissi-kaitouni-1660967/
- E-invoicing calendar: https://experio.ma/facturation-electronique-maroc-2026-guide-conformite/
- CNDP declarations: https://upsilon-consulting.com/declarations-autorisations-cndp-guide-pratique/
- Law 09-08: https://upsilon-consulting.com/loi-09-08-protection-donnees-personnelles/
- CNDP transfers: https://www.cndp.ma/wp-content/uploads/2023/11/CNDP-MICROSOFT-Communiqu_de_presse-20020406.pdf
- WhatsApp pricing: https://help.meetergo.com/en/integrations/automation/whatsapp-pricing
- Telegram buttons: https://core.telegram.org/api/bots/buttons
- Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Anthropic data retention: https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
- LLM pricing overview: https://geotoolbox.ai/blog/ai-token-cost
- Cement market 2026: https://boursenews.ma/article/marches/ciment-maroc-vingt-cinq-ans-cycles-reprise-fragile-2026
- Competition Council: https://fr.hespress.com/461070-461070.html
