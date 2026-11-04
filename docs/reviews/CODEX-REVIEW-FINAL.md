# المراجعة الأمنية المستقلة — النسخة النهائية من main

التاريخ: 4 نونبر 2026. النسخة المراجَعة: **`2cfc0bd05c394f86ac812d977b63577ed66f1b93`**، على `main` فـ `/Users/macplanet/BELGOBETON`، بعنوان `C4.4: e2e for the plant picker ...`، مؤرخة بـ `2026-11-04 02:49:17 UTC`. تحققت مرة ثانية قبل تحرير التقرير أن HEAD ما تبدلش وأن working tree نظيفة. التقرير ما كيغطيش commits أو تغييرات غادي يديرها Claude Code من بعد هاد النسخة.

**الحكم: ما نعتمدوش هاد commit للإطلاق بمعطيات حقيقية كما هو.** كاين مسار فعلي فالكود كيخرج معطيات زبناء السونطرال الأخرى لـ `plant_manager`، ومسار offline كيبقي معطيات الزبناء قابلة للعرض بعد الخروج أو إلغاء الجهاز. كاين كذلك خروج مقصود لعنوان الورش لـ Google عند الضغط على الخريطة. ما لقيتش، فالمسارات اللي تتبعت، قراءة مباشرة غير مرخصة لرصيد أو خزينة عند office/plant/driver/accountant؛ هاد النتيجة محدودة بالمراجعة الساكنة وماشي إثبات شامل بانعدام أي تسريب.

المراجعة كانت **قراءة فقط للمستودع الأصلي**، من نسخة مؤقتة للملفات المتتبعة فهاد commit. ما تبدل فيه حتى ملف؛ ما تشغل لا Docker، لا التطبيق، لا اختبارات، لا migrations، لا scripts ديالو؛ وما تقرات لا `.env*`، حتى الأمثلة، لا محتويات `backups/`. تقرات `AI-COLLABORATION.md`، `CP-PROD-PLAN.md`، المتطلبات و`CODEX-REVIEW-R9.md`، ثم مسارات SQL والخدمات والـ routes ذات الصلة. أرقام الاختبارات المذكورة فالـ checkpoints تصريحات ديال البناء، ماشي نتائج أعدت التحقق منها.

فهاد التقرير، **متحقق من الكود** كتعني أن الشرط أو المسار ظاهر فالملفات؛ **مستنتج** كتعني النتيجة المتوقعة ملي يتنفذ المسار. حتى ملاحظة ما كتدعي تجربة استغلال حية أو تحققاً من إعدادات السيرفر الفعلية. الروابط والأسطر كتشير للنسخة المذكورة فوق؛ إلا تبدل main يمكن يتحرك ترقيم الأسطر.

## الملاحظات، مرتبة بالخطورة

### F01 — عالٍ / P1 — لوحة المضخات كتخرق حصر plant_manager فالسونطرال ديالو

**متحقق من الكود:** `pump_board(date)` دالة `SECURITY DEFINER` كتقبل `plant_manager` وكترد جميع jobs ديال النهار، مع `client_name`، `site_label`، رقم الطلب وUUID ديالو، بلا `ctx.plant_scope()` فـ WHERE. صفحة `/pumps` مفتوحة لهاد الدور وما عندهاش module flag كيوقف هاد المسار. `reschedule_pump_job` و`set_order_pumped` كذلك كيتحققو من الدور فقط، بلا ملكية السونطرال ديال job/order. هادشي ما كيتصلحش بـ RLS ديال `sales_order`، حيت القراءة كتدوز بدور definer وعندو سياسات القراءة المخصصة.

**المسار المستنتج:** manager ديال Tétouan يفتح `/fr/pumps?date=...` فيشوف زبناء وطلبات Chefchaouen؛ يقدر يبعث job ID اللي رجعات ليه اللوحة لـ server action ديال تغيير الموعد. هادي قراءة غير مرخصة لمعطيات الزبون وزيادة عليها تغيير عمليات سونطرال أخرى، بلا حاجة لوصول SQL مباشر.

الدليل: [0101_pump_coordination.sql:242](/Users/macplanet/BELGOBETON/db/migrations/0101_pump_coordination.sql:242)، [نفس الملف:175](/Users/macplanet/BELGOBETON/db/migrations/0101_pump_coordination.sql:175)، [نفس الملف:69](/Users/macplanet/BELGOBETON/db/migrations/0101_pump_coordination.sql:69)، [pumps/page.tsx:22](/Users/macplanet/BELGOBETON/src/app/[locale]/(protected)/pumps/page.tsx:22)، [pumps/actions.ts:49](/Users/macplanet/BELGOBETON/src/app/[locale]/(protected)/pumps/actions.ts:49).

الإصلاح المطلوب: تعريف scope ديال pump job/الطلب فالقاعدة، وتطبيقه على القراءة وكل كتابة، بما فيها jobs بلا order. كون المضخة كتتنقل بين السونطرالات ما كيعطيش manager الحق فزبناء وطلبات الجميع. خاص كذلك تدقيق نفس النمط فـ `emergency_instruct` اللي ما كيتحققش من سونطرال emergency، و`redirect_candidates` اللي كيتبع سونطرال case المدخلة بلا تحقق من scope ديال طالبها: [0084:308](/Users/macplanet/BELGOBETON/db/migrations/0084_field_app.sql:308)، [0090:253](/Users/macplanet/BELGOBETON/db/migrations/0090_cancellations.sql:253). إصلاح ثلاثة الأبواب القديمة فـ 0095 صحيح، ولكن ما غطاش هاد الأبواب الجديدة.

### F02 — عالٍ / P1 — بيانات السائق offline كتبقى بعد logout/revocation وبلا فصل بين الحسابات

**متحقق من الكود:** service worker كيخزن `/api/field/session`، رغم `no-store` ديال الرد، فـ cache واحدة `bb-field-v1` بلا هوية الحساب. logout كيمسح `bb_field_day` فقط، وما كيمسحش Cache Storage ولا طابور الصور فـ IndexedDB. فحالة تعذر الشبكة، `loadDay()` كيسترجع آخر day وكيعيّن `session='in'` بلا تحقق من صلاحية session أو الجهاز أو عمر البيانات. الرد فيه أسماء الزبناء، contact، الهاتف والعنوان المفكوك التشفير. طابور taps وطابور الصور كذلك ما مربوطينش بـ user ID.

**المسار المستنتج:** السائق يحمّل النهار، يدير logout وهو online، ومن بعد يتقطع الإنترنت ويتحل التطبيق: service worker يقدر يرجع day المخزنة ويرجع العرض لحالة الدخول. نفس الخطر كيبقى فهاتف مفقود بعد إلغاء الربط، أو فمتصفح مشترك بين سائق وpump operator. إلغاء الجهاز كيوقف الطلبات الجديدة للسيرفر، ما كيمحيش هاد النسخ المحلية.

الدليل: [driver-sw.js:4](/Users/macplanet/BELGOBETON/public/driver-sw.js:4)، [نفس الملف:27](/Users/macplanet/BELGOBETON/public/driver-sw.js:27)، [field-app.tsx:111](/Users/macplanet/BELGOBETON/src/modules/field/ui/field-app.tsx:111)، [نفس الملف:295](/Users/macplanet/BELGOBETON/src/modules/field/ui/field-app.tsx:295)، [photo-queue.ts:12](/Users/macplanet/BELGOBETON/src/modules/field/ui/photo-queue.ts:12)، [field-service.ts:104](/Users/macplanet/BELGOBETON/src/modules/field/service/field-service.ts:104).

الإصلاح المطلوب قبل تشغيل `FIELD_APP_ENABLED`: تخزين مربوط بالحساب، مدة offline محددة، قفل محلي مناسب، ومسح cache/البيانات الشخصية عند logout أو 401 أو تبديل الحساب. طوابير العمل تبقى مربوطة بصاحبها وما تتعرضش للحساب التالي. خاص توثيق أن revocation عن بعد ما يقدرش يمسح فوراً هاتفاً مفصولاً عن الشبكة.

### F03 — عالٍ / P1 — الإلغاءات وتجاوز إقفال النهار كيدوزو بلا step-up

**متحقق من الكود:** actions ديال الإلغاءات كتدير `authorize` فقط. `decideCaseAction` و`setPolicyAction` ما كيدوزوش من `withStepUp`؛ حتى إلغاء order غير منتجة كيدير reversing entries فالقاعدة. `closeDayAction` كذلك كيسمح بـ force مع note بلا step-up. هاد الأبواب ما كترفضش `reenrolRequired`، خلاف المسارات الحساسة الأخرى.

**الأثر المستنتج:** session ديال `app_admin`/owner بعامل ثانٍ قديم، أو بعد recovery code وقبل إعادة التسجيل، تقدر تبدل سياسة تحميل الزبون مسؤولية الإلغاء، تقرر خسارة/تحويل، أو تتجاوز blocking items ديال إقفال النهار. الصلاحية العامة ديال الدور موجودة، ولكن شرط التأكيد الأمني الإضافي مفقود.

الدليل: [cancellations/actions.ts:20](/Users/macplanet/BELGOBETON/src/app/[locale]/(protected)/cancellations/actions.ts:20)، [نفس الملف:60](/Users/macplanet/BELGOBETON/src/app/[locale]/(protected)/cancellations/actions.ts:60)، [0090:165](/Users/macplanet/BELGOBETON/db/migrations/0090_cancellations.sql:165)، [day-close/actions.ts:14](/Users/macplanet/BELGOBETON/src/app/[locale]/(protected)/day-close/actions.ts:14)، [0094:232](/Users/macplanet/BELGOBETON/db/migrations/0094_plant_flows.sql:232).

الإصلاح المطلوب: step-up للقرارات الحساسة وتغيير السياسة وforce-close، مع منع recovery-session من تنفيذها قبل reenrolment، وتحديد صريح لما يبقى مجرد تبليغ ميداني مسموح بلا step-up. هادي ماشي مطالبة بـ TOTP على كل tap ديال السائق.

### F04 — عالٍ / P1 — التركيب الجديد حسب C2 باقي مسدود بفصل credentials وصلاحيات evidence

**متحقق من الكود:** `db-bootstrap` خاصو `DATABASE_URL_BACKUP` باش ينشئ/يضبط دور النسخ. `ops` كيحمّل غير إعدادات app وops؛ حسب runbook هاد credential كاين حصراً فإعدادات backup، وما كيتحقنش فـ bootstrap الموثق. كذلك `init-host.sh` كينشئ `keys/` و`reports/` بـ 0750 بلا owner/group ديال container، بينما runtime كيجري بـ UID/GID 10001، و`checklist-record-restore` خاصو يقرا report وsignature وpublic key من هاد المجلدات.

**المستنتج على fresh install حرفي:** bootstrap غادي يرفض missing backup URL؛ والمجلدات الجديدة المخلوقة كـ root غادي تمنع ops من قراءة evidence/public key، ويمكن حتى تمنع deploy user من رفع التقرير بالطريقة الموثقة. ما تحققتش من ownership الفعلي على أي سيرفر موجود.

الدليل: [db-bootstrap.ts:39](/Users/macplanet/BELGOBETON/scripts/db-bootstrap.ts:39)، [docker-compose.prod.yml:67](/Users/macplanet/BELGOBETON/docker-compose.prod.yml:67)، [نفس الملف:88](/Users/macplanet/BELGOBETON/docker-compose.prod.yml:88)، [init-host.sh:14](/Users/macplanet/BELGOBETON/scripts/ops/init-host.sh:14)، [Dockerfile:24](/Users/macplanet/BELGOBETON/Dockerfile:24)، [checklist-record-restore.ts:26](/Users/macplanet/BELGOBETON/scripts/checklist-record-restore.ts:26)، [RUNBOOK.md:20](/Users/macplanet/BELGOBETON/docs/RUNBOOK.md:20).

الإصلاح المطلوب: مسار bootstrap مؤقت ومحدد كيستقبل credentials اللازمة لإنشاء الأدوار، بلا إضافتها لـ app أو توسيع أسرار backup job؛ وownership/group صريح للمفتاح العمومي وتقارير الاسترجاع. خاص إثبات install كاملة من host نظيف، بلا تعديل يدوي غير موثق للأسرار باش يتجاوز العطل.

### F05 — عالٍ / P1 — deploy.sh كيبدل للمجلد الغلط وrollback ما كيغطيش الفشل المبكر

**متحقق من الكود:** السطر 8 كيبدل من `scripts/ops` إلى `scripts`، ومن بعد كيقلب على `.env.ops.prod` و`./scripts/ops/...` نسبة لهاد المجلد. النتيجة المتوقعة هي lookup فـ `scripts/.env.ops.prod` وتشغيل `scripts/scripts/ops/...`. بعد تصحيح هاد المسار بوحدو، باقي `set -e` كيخرج عند فشل migration أو `up` قبل الوصول لفرع rollback، بعدما يكون `APP_IMAGE` تبدل.

الدليل: [deploy.sh:8](/Users/macplanet/BELGOBETON/scripts/ops/deploy.sh:8)، [نفس الملف:14](/Users/macplanet/BELGOBETON/scripts/ops/deploy.sh:14)، [نفس الملف:16](/Users/macplanet/BELGOBETON/scripts/ops/deploy.sh:16)، [نفس الملف:24](/Users/macplanet/BELGOBETON/scripts/ops/deploy.sh:24)، [RUNBOOK.md:65](/Users/macplanet/BELGOBETON/docs/RUNBOOK.md:65).

**المستنتج:** مسار النشر الموثق ما غاديش يكمل من checkout عادية؛ ووعد الرجوع للصورة السابقة ما كيشملش جميع مراحل الفشل. خاص تصحيح جذر المشروع، معالجة الفشل من بعد تبديل الصورة، وتجربة rollback بما فيها migration/up failure فبيئة منفصلة. الرجوع للصورة ماشي rollback للقاعدة؛ توافق migrations مع الصورة السابقة خاصو يتثبت لكل إصدار.

### F06 — عالٍ / P1 — تدوير المفاتيح باقي كيعطي نجاحاً مع حقول شخصية ما تدوّراتش

**متحقق من الكود:** registry ديال `ENCRYPTED_COLUMNS` ما فيهش `supplier.phone_enc`، `trip_instruction.address_enc`، `pump_job.address_enc` ولا `cancellation_case.redirect_address_enc`. `crypto-rotate` كيدور غير registry والملفات، ومن بعد يقدر يطبع `All live values are on the current keys`. إصلاح مسار filestore فـ C2 صحيح، ولكن ما كيحلش اكتمال registry.

الدليل: [encrypted-columns.ts:5](/Users/macplanet/BELGOBETON/src/modules/platform-security/domain/encrypted-columns.ts:5)، [0020_supplier.sql:10](/Users/macplanet/BELGOBETON/db/migrations/0020_supplier.sql:10)، [0084:92](/Users/macplanet/BELGOBETON/db/migrations/0084_field_app.sql:92)، [0084:110](/Users/macplanet/BELGOBETON/db/migrations/0084_field_app.sql:110)، [0090:34](/Users/macplanet/BELGOBETON/db/migrations/0090_cancellations.sql:34)، [crypto-rotate.ts:44](/Users/macplanet/BELGOBETON/scripts/crypto-rotate.ts:44)، [نفس الملف:87](/Users/macplanet/BELGOBETON/scripts/crypto-rotate.ts:87).

**الأثر المستنتج:** حذف مفتاح قديم من runtime بعد نجاح مضلل يقطع فتح بعض الهواتف والعناوين؛ والاحتفاظ به فـ runtime كيخلي هاد القيم محتاجة المفتاح القديم حتى فعملية rotation بسبب اشتباه اختراق. الاحتفاظ offline بمفاتيح backups القديمة مطلوب، ولكن ما كيعوضش تدوير كل القيم الحية. خاص registry كامل وصلاحيات reseal محدودة للحقول الجديدة، بلا إعطاء system حق تعديل بقية المعاملة.

### F07 — متوسط / P2 — رابط الخريطة كيسلّم عنوان الزبون لـ Google عند الضغط

**متحقق من الكود:** `mapLink` كيبني `https://www.google.com/maps/search/?api=1&query=<العنوان الكامل>` من العنوان المفكوك التشفير. الرابط كيتعرض للسائق وpump operator وكيتحل فنافذة خارجية. هادي navigation بطلب المستخدم، **ماشي إرسال تلقائي من السيرفر ولا استدعاء AI**. `noreferrer` ما كيحيدش العنوان من query ديال الرابط نفسه.

الدليل: [field-service.ts:49](/Users/macplanet/BELGOBETON/src/modules/field/service/field-service.ts:49)، [نفس الملف:307](/Users/macplanet/BELGOBETON/src/modules/field/service/field-service.ts:307)، [field-app.tsx:456](/Users/macplanet/BELGOBETON/src/modules/field/ui/field-app.tsx:456)، [نفس الملف:591](/Users/macplanet/BELGOBETON/src/modules/field/ui/field-app.tsx:591).

**النتيجة المستنتجة:** ملي كيتضغط الرابط وهو متصل، Google كيتوصل بعنوان الورش. إلى الشرط هو ما تخرج حتى معلومة زبون لأي provider غير معتمد، خاص تعطيل هاد الزر حتى يتقبل هاد الاستعمال ويتوثق بوضوح، أو اعتماد بديل مناسب. ما نقدرش نقول «لا معطيات زبناء كتخرج لأي provider» بهاد الكود. ما راجعتش ملف CNDP الفعلي ولا كنفتي فالوضع القانوني ديال هاد النقل.

### F08 — متوسط / P2 — موافقة طلب الوثيقة ما مربوطةش بالتحميل الفعلي

**متحقق من الكود:** R7 فيه `request_document` و`decide_document_request` و`use_document_request`، ولكن route ديال مكتبة الوثائق كتفتح invoice مباشرة بعد فحص الدور والنوع؛ ما كتطلبش approved request وما كتستهلكوش. `office_sales` يقدر يجيب index ويحمّل invoice بالحق العادي ديالو حتى إلا كان طلب النسخة pending/denied. الـ checkpoint نفسه كيعترف أن gate ما كتقدرش تعترض print.

الدليل: [documents/[kind]/[id]/route.ts:35](/Users/macplanet/BELGOBETON/src/app/[locale]/(protected)/documents/[kind]/[id]/route.ts:35)، [0087_document_library.sql:4](/Users/macplanet/BELGOBETON/db/migrations/0087_document_library.sql:4)، [0091_documents_v1.sql:137](/Users/macplanet/BELGOBETON/db/migrations/0091_documents_v1.sql:137)، [document-request-service.ts:releaseDocumentRequest](/Users/macplanet/BELGOBETON/src/modules/ledger/service/document-request-service.ts:144).

**حدود الملاحظة:** طباعة invoice بالمبلغ لـ `office_sales` حق صريح فـ §16.1؛ ما كنحسبوش هاد الحق بوحدو تسريب رصيد. الخلل هو أن الموافقة الإضافية المفروضة على إخراج نسخة مطلوبة من الزبون ما كتحكمش مسار الإخراج. خاص الفصل الواضح بين العرض الداخلي وتسليم نسخة للزبون، وربط المسار المعني بترخيص محدد للوثيقة والشخص، أو إبقاء R7 غير معتمد لهذا الغرض.

### F09 — متوسط / P2 — مسارات المحاسب القديمة كتطلب payment state الممنوعة عليه

**متحقق من الكود:** `invoices.read` و`accounting.export` كيسمحو بـ `accountant`. ولكن `listInvoices` كتنادي دائماً `loadInvoicePayments`، اللي كتستعمل `invoice_payment_state()`؛ هاد الدالة كترفض المحاسب. `getInvoiceDocument` كيدوز من نفس list. الـ export القديم كذلك كينادي نفس الباب أثناء بناء ageing، حتى ملي المطلوب غير journal sales. وفالمكتبة، accountant كيتوجه لمسار `getInvoiceDocument`، ماشي print door.

الدليل: [invoice-service.ts:237](/Users/macplanet/BELGOBETON/src/modules/ledger/service/invoice-service.ts:237)، [نفس الملف:326](/Users/macplanet/BELGOBETON/src/modules/ledger/service/invoice-service.ts:326)، [0068:177](/Users/macplanet/BELGOBETON/db/migrations/0068_allocate_to_invoices.sql:177)، [accounting-export.ts:buildAccountingExport](/Users/macplanet/BELGOBETON/src/modules/ledger/service/accounting-export.ts:170)، [documents route:39](/Users/macplanet/BELGOBETON/src/app/[locale]/(protected)/documents/[kind]/[id]/route.ts:39).

**المستنتج:** أخطاء/فشل قراءة الفواتير وCSV للمحاسب، ماشي تسريب رصيد؛ حماية SQL كتوقف القراءة الممنوعة. الإصلاح ما يكونش بتوسيع `invoice_payment_state` للمحاسب. خاص مسار invoice بلا payments وبلا contacts، واستعمال journal المحاسب المحدود ديال finance عند تشغيله، أو باب مكافئ. هادشي خاص يتحسم خصوصاً أن `FINANCE_ENABLED` طافي افتراضياً.

### F10 — متوسط / P2 — FINANCE_ENABLED=false ما كيوقفش endpoint ديال configuration

**متحقق من الكود:** `/api/finance-configuration` كيمرر `configuration:true` وcallback كتقرا `FINANCE_ENABLED`، ولكن `handleFinancePost` كينادي `enabled()` غير ملي `!deps.configuration`. لذلك هاد callback ما كتتنفذش، وطلب `configure` من owner/app_admin مع step-up يقدر يوصل لـ `executeFinance` ويبدل switch فالقاعدة رغم flag البيئة طافي.

الدليل: [finance-configuration/route.ts:12](/Users/macplanet/BELGOBETON/src/app/api/finance-configuration/route.ts:12)، [http.ts:35](/Users/macplanet/BELGOBETON/src/modules/finance/service/http.ts:35)، [request.ts:66](/Users/macplanet/BELGOBETON/src/modules/finance/service/request.ts:66).

**حدود الأثر:** ما لقيتش به تسريباً لأدوار أخرى؛ الدور وstep-up باقين مفروضين، وبقية مداخل finance كتفحص flag البيئة. الخلل هو كسر تعهد «module off ⇒ endpoints 404». خاص فحص flag البيئة دائماً، والسماح بتجاوز switch القاعدة فقط فعملية configuration.

### F11 — متوسط / P2 — حد محاولات PIN ما متسلسلش مع التحقق وإصدار session

**متحقق من الكود:** login كيقرأ `locked_until`، كيتحقق منه، كيدير Argon2، ومن بعد كيزيد failed أو كينادي `field_login_ok` فاستعلامات منفصلة. `field_login_ok` ما كيعاودش يتأكد من lock وكيصفر failed. ما كاينش حجز ذري لمحاولة أو قفل موحد لهاد السلسلة. PIN مسموح فيه 4 أرقام؛ Origin check ماشي حد للمحاولات من client خارجي.

الدليل: [auth.ts:173](/Users/macplanet/BELGOBETON/src/modules/field/service/auth.ts:173)، [نفس الملف:197](/Users/macplanet/BELGOBETON/src/modules/field/service/auth.ts:197)، [نفس الملف:224](/Users/macplanet/BELGOBETON/src/modules/field/service/auth.ts:224)، [0085_field_login.sql:13](/Users/macplanet/BELGOBETON/db/migrations/0085_field_login.sql:13)، [نفس الملف:24](/Users/macplanet/BELGOBETON/db/migrations/0085_field_login.sql:24)، [pin.ts:4](/Users/macplanet/BELGOBETON/src/modules/field/domain/pin.ts:4).

**مستنتج، بلا تجربة ضغط:** محاولات متزامنة تقدر تقرا الحالة قبل أول lock وتخضع كلها للتحقق؛ محاولة صحيحة متأخرة تقدر تمسح lock تسجل من بعدها. هادشي كيضعف ضمان خمس محاولات، خصوصاً قبل أول binding أو من بعد release. ماشي إثبات أن PIN تكسّر، وما كيلغيش منع الهاتف الآخر إلا كان الجهاز مربوطاً فعلاً. خاص حجز/تسلسل ذري للمحاولات وإعادة تحقق قبل issuance، وحد مناسب على مستوى المصدر/الخدمة. يبقى driver flag طافي حتى يتثبت هاد المسار.

### F12 — متوسط / P2 — بعض الموافقات ما كتحترمش مدة step-up المركزية إلا تشددات

**متحقق من الكود:** `withStepUp` كيرجع افتراضياً لعشر دقائق إلا ما تمرراتش `parameters`. actions ديال تأكيد الأسعار، disclosure وإدارة PIN/device ما كيمرروش هاد callback؛ إدارة users كتمررو، وfinance كتقرا مدة القاعدة مع سقف عشر دقائق.

الدليل: [step-up-guard.ts:39](/Users/macplanet/BELGOBETON/src/modules/platform-security/auth/step-up-guard.ts:39)، [approvals/actions.ts:24](/Users/macplanet/BELGOBETON/src/app/[locale]/(protected)/approvals/actions.ts:24)، [disclosures/actions.ts:44](/Users/macplanet/BELGOBETON/src/app/[locale]/(protected)/disclosures/actions.ts:44)، [admin/field/actions.ts:27](/Users/macplanet/BELGOBETON/src/app/[locale]/(protected)/admin/field/actions.ts:27)، [users/actions.ts:46](/Users/macplanet/BELGOBETON/src/modules/platform-security/ui/users/actions.ts:35)، [0206:4](/Users/macplanet/BELGOBETON/db/migrations/0206_finance_step_up_policy.sql:4).

**المستنتج:** إلا تضبطات `auth.step_up_minutes=1`، هاد الموافقات تقدر تقبل عامل ثانٍ عمره خمس دقائق. ما قرأتش القيمة المطبقة فعلياً. خاص helper موحد كيقرا السياسة المركزية لكل action حساسة، بلا اعتماد على أن كل caller غادي يتذكر callback.

## تغطية السؤال المحوري وباقي الحدود

| المجال | النتيجة من القراءة |
|---|---|
| §16.1، grants وRLS | `ctx.actor_role()` كيتحقق من role والحساب active؛ `ctx.role()` كيمثل app_admin كـ owner، والـ offices كـ office، وmanager كـ plant. money tables الأساسية مقيدة، والقراءات الضيقة عبر definer خاصها actor allowlist وscope داخلها. F01 دليل أن RLS وحدها ما كافياش على الأبواب الجديدة. [0082:27](/Users/macplanet/BELGOBETON/db/migrations/0082_roles_v1.sql:27)، [0030:48](/Users/macplanet/BELGOBETON/db/migrations/0030_money_visibility.sql:48). |
| app_admin | عنده مال وصلاحيات إدارة مقصودة. الخدمات كتمنعو من خلق app_admin آخر، وتعطيل owner أو reset ديال 2FA ديالو؛ trigger كيحمي owner من downgrade/disable. ما لقيتش مسار HTTP يسمح بتغيير/حذف audit log؛ F03 وF12 كيخصو التأكيد الإضافي. [user-admin.ts:98](/Users/macplanet/BELGOBETON/src/modules/platform-security/service/user-admin.ts:98)، [0082:136](/Users/macplanet/BELGOBETON/db/migrations/0082_roles_v1.sql:136). |
| office_sales / office_purchases | تفريق إنشاء البيع والشراء كاين فـ permissions وفي wrappers ديال القاعدة. invoice print كترد مبلغ وثيقة واحدة كما تسمح matrix؛ ما كتردش client balance أو paid-state. reference prices مسموحة صراحة، ومختلفة عن ثمن اتفاق زبون بعينه. هاد الاستثناءات ما خاصهاش تتبلغ كتسريبات. [0082:179](/Users/macplanet/BELGOBETON/db/migrations/0082_roles_v1.sql:179)، [0087:14](/Users/macplanet/BELGOBETON/db/migrations/0087_document_library.sql:14)، [0097:82](/Users/macplanet/BELGOBETON/db/migrations/0097_reference_price_per_plant.sql:82). |
| plant_manager، وصفات C4 والاستلام | القيود الأساسية فـ 0082، إصلاح BL/order-chain/dispatch فـ 0095، ووصفات السونطرال فـ 0105 كاينين. receipt states والملفات الجديدة عندها scope، وكمية variance ماشي مبلغ. هاد النتائج ما كتلغيش F01. [0105:108](/Users/macplanet/BELGOBETON/db/migrations/0105_recipe_per_plant.sql:108)، [0100:67](/Users/macplanet/BELGOBETON/db/migrations/0100_receipt_states.sql:67). |
| driver / pump_operator | server doors كتحدد الرحلات/jobs بـ `ctx.driver_id()`، وكترد contact/address اللازمة للعمل بلا حقول أثمان أو أرصدة. الصور مربوطة برحلة السائق ومرفوضة قبل تسجيل التفريغ. F02 وF11 باقي موانع لتفعيل الهاتف بمعطيات حقيقية. [0084:149](/Users/macplanet/BELGOBETON/db/migrations/0084_field_app.sql:149)، [0084:345](/Users/macplanet/BELGOBETON/db/migrations/0084_field_app.sql:345)، [0098:48](/Users/macplanet/BELGOBETON/db/migrations/0098_driver_bl_photo.sql:48). |
| accountant | لا mapping لـ owner/office، وسياسات قراءة صريحة للفواتير/lines/avoirs/company. باب finance journal كيرد حقول المحاسبة فقط، بلا treasury أو contacts أو balances. المسارات القديمة مكسورة كما فـ F09؛ ما خاصش توسيع المال لإصلاحها. [0082:237](/Users/macplanet/BELGOBETON/db/migrations/0082_roles_v1.sql:213)، [0203:59](/Users/macplanet/BELGOBETON/db/migrations/0203_finance_fail_closed.sql:59). |
| client_portal / supplier_portal | إنشاء الحسابات مرفوض صراحة، وما عندهم لا mapping داخلي ولا مداخل عامة مسموحة بpermissions الحالية؛ ما لقيتش قراءة مباشرة لمال/زبناء عبر routes الحالية. **هاد المراجعة ما كتجيزش تشغيلهم:** ما كاينش هنا نموذج عزل مكتمل user↔client/supplier وسياسات portal-by-party. تشغيل flag أو توسيع permissions بوحده ماشي تنفيذ آمن لبوابة. [user-admin.ts:103](/Users/macplanet/BELGOBETON/src/modules/platform-security/service/user-admin.ts:103)، [0082:58](/Users/macplanet/BELGOBETON/db/migrations/0082_roles_v1.sql:58). |
| §16.3 disclosure | كاين binding للـ requester، item محدد، approval من owner/app_admin، expiry، وعد views مع `FOR UPDATE` وتسجيل audit؛ ما لقيتش طريق من disclosure وحدها للتصفح الحر للأرصدة. الموافقة كتجي من server action مع step-up، مع نقص السياسة المركزية F12. الوقت كيقيد **القراءات الجديدة**؛ الرقم المعروض فعلاً كيبقى فـ React state حتى تتبدل الصفحة، وما كاينش وعد تقني باسترجاع معلومة سبق تشافت. [0088:65](/Users/macplanet/BELGOBETON/db/migrations/0088_disclosure.sql:65)، [0088:89](/Users/macplanet/BELGOBETON/db/migrations/0088_disclosure.sql:89)، [disclosure-ui.tsx:185](/Users/macplanet/BELGOBETON/src/modules/ledger/ui/approvals/disclosure-ui.tsx:185). |
| §16.4 assistant | رفض chosen-amount كيدوز قبل gate/tools/model، وtool runner كيراجع الدور وschema وmoney keys. ولكن detector لغوي/regex، ماشي ضمان لكل الصيغ: مثلاً الأرقام `٥٠٠٠٠` أو مبلغ مكتوب بالكلمات ما داخلينش فـ patterns الحالية. ما كنستنتجش من هاد النقص تسريب رصيد لoffice: أدوات المال ممنوعة عليه، وزيادة على ذلك assistant الشبكي كامل مرفوض مع real data. خاص توسعة normalization إذا غادي يعتمد عليه مستقبلاً. [turn.ts:134](/Users/macplanet/BELGOBETON/src/modules/assistant/service/turn.ts:134)، [chosen-amount.ts:16](/Users/macplanet/BELGOBETON/src/modules/assistant/domain/chosen-amount.ts:16)، [tool-runner.ts:64](/Users/macplanet/BELGOBETON/src/modules/assistant/service/tool-runner.ts:64). |
| provider AI / OCR | validation كيرفض `ASSISTANT_ENABLED` و`AI_EXTRACTION_ENABLED` وAnthropic/key مع production أو `REAL_DATA`. adapter نفسه كيرفض real data/production، وOCR ما موصول حتى extractor خارجي فعلياً. ما لقيتش مسار إرسال AI للخارج بهاد الوضع. [env.ts:158](/Users/macplanet/BELGOBETON/src/lib/env.ts:148)، [anthropic-provider.ts:23](/Users/macplanet/BELGOBETON/src/lib/ai/anthropic-provider.ts:23)، [invoice-extraction.ts:38](/Users/macplanet/BELGOBETON/src/lib/ai/invoice-extraction.ts:27). |
| push وباقي الخروج | push كيمشي لخدمات browser المحددة فقاعدة endpoint، بـ body فارغ؛ لا figures لا customer payload، ولكن كيبقى metadata ديال الاشتراك/وقت الإرسال. الخرائط هي F07. Infomaniak هو provider استضافة مقصود فالمشروع؛ توقيع العقد والتصريحات الفعلية ما تحققوش. CSP ديال المتصفح ماشي firewall لخروج السيرفر، وapp مربوطة بـ edge network. [0089:32](/Users/macplanet/BELGOBETON/db/migrations/0089_notifications.sql:32)، [web-push.ts:100](/Users/macplanet/BELGOBETON/src/modules/platform-security/service/web-push.ts:100)، [compose:46](/Users/macplanet/BELGOBETON/docker-compose.prod.yml:46). |
| documents / BL / attachments | downloads كتراجع permission وRLS، والملفات خارج public ومشفرة ومربوطة بـ UUID، وhash كيتراجع قبل العرض. scan ديال BL كيتقرا عبر join مع delivery scoped؛ driver photo عندها policy scope مباشرة. upload كيراجع النوع والحجم وكيحيد metadata من الصور، ولكن PDF scanning ماشي إثبات بتعقيم شامل لكل PDF ممكن. الملفات محتواها شنو صوّر/رفع المستخدم؛ ماشي وسيلة لإثبات أن صورة موسومة BL خالية دلالياً من المال. F08 باقي قائم. [delivery-file-service.ts:176](/Users/macplanet/BELGOBETON/src/modules/operations/service/delivery-file-service.ts:176)، [bl-photo.ts:157](/Users/macplanet/BELGOBETON/src/modules/field/service/bl-photo.ts:157)، [store.ts:25](/Users/macplanet/BELGOBETON/src/lib/files/store.ts:25)، [validate-upload.ts:43](/Users/macplanet/BELGOBETON/src/lib/files/validate-upload.ts:43). |
| finance مع R2 وR3 | `finance.read/write` محصورة فـ owner/app_admin، export محدود للمحاسب؛ support ما كيرثش finance. أبواب sources كتستعمل `coalesce(ctx.role(),'')` باش ترفض context ناقص، وswitch القاعدة؛ 0207 ربط confirmed revenue بـ `order_price_status` ديال R3؛ triggers ديال الكتابة كتطلب `app.finance_step_up`. ما لقيتش توسيعاً لأرصدة finance نحو office/plant/accountant. F10 كيكسر flag البيئة فconfiguration فقط. [permissions.ts:2](/Users/macplanet/BELGOBETON/src/modules/finance/domain/permissions.ts:2)، [0203:28](/Users/macplanet/BELGOBETON/db/migrations/0203_finance_fail_closed.sql:28)، [0207:5](/Users/macplanet/BELGOBETON/db/migrations/0207_finance_price_status.sql:5)، [0203:92](/Users/macplanet/BELGOBETON/db/migrations/0203_finance_fail_closed.sql:92). |

§16.10 باقي ما تبناش: redirect كيتحقق من strength class، ماشي technical compatibility + تأكيد plant manager قبل القرار التجاري. وزيادة على ذلك، واجهة cancellation كتبعث `redirectOrderId` بلا address، و`decide_cancellation` كتخزن `p_address_enc` كما جات بلا نسخ عنوان site ديال الوجهة؛ لذلك رسالة «العنوان الجديد واصل للسائق» ما مثبتاش فهاد المسار. [0090:279](/Users/macplanet/BELGOBETON/db/migrations/0090_cancellations.sql:279)، [cancellations-board.tsx:131](/Users/macplanet/BELGOBETON/src/modules/operations/ui/cancellations-board.tsx:131)، [0090:314](/Users/macplanet/BELGOBETON/db/migrations/0090_cancellations.sql:314). يبقى تحويل الخرسانة خارج المسار الآلي المعتمد حتى يتكمل التحقق التقني ويتجرب وصول الوجهة للسائق؛ ماشي إصلاح RBAC بوحده كافي هنا.

## C2 مقارنة مع CODEX-REVIEW-R9

الحالات أدناه حكم على **التنفيذ المكتوب**، ماشي شهادة تشغيل على VPS.

| ملاحظة R9 | آخر حالة |
|---|---|
| 1: backup ديال القاعدة بلا الوثائق | تصلح التصميم: dump ثم archive filestore، artifacts بجوج مشفرين، manifest كيتنشر آخر شيء؛ restore كيفتح الملفات بمفاتيح escrow. باقي تجربة استرجاع مستقلة وربط الوثائق المسترجعة بسجلاتها؛ السكريبت كيفتح الملفات الموجودة وما كيثبتش وحده أن كل file ID فكل جدول عندها blob. [backup-lib.ts:173](/Users/macplanet/BELGOBETON/scripts/backup-lib.ts:173)، [نفس الملف:547](/Users/macplanet/BELGOBETON/scripts/backup-lib.ts:547). |
| 2: rotation كتتجاوز filestore | تصلح path الصريح ورفض directory مفقودة وعد الملفات، وباقي **F06** على الحقول غير المسجلة. [crypto-rotate.ts:63](/Users/macplanet/BELGOBETON/scripts/crypto-rotate.ts:63)، [compose:73](/Users/macplanet/BELGOBETON/docker-compose.prod.yml:73). |
| 3: أسرار runtime/maintenance/backup | تحسن: runtime ما كيطلبش migrator، وbackup عندو ملف أسرار بوحدو؛ باقي **F04** فbootstrap. [env.ts:200](/Users/macplanet/BELGOBETON/src/lib/env.ts:186)، [compose:84](/Users/macplanet/BELGOBETON/docker-compose.prod.yml:84). |
| 4: Compose interpolation ناقصة | wrapper `dc.sh` كيمرر env-file صراحة. مسار deploy فيه **F05**. [dc.sh:12](/Users/macplanet/BELGOBETON/scripts/ops/dc.sh:10). |
| 5: حلقة أول تشغيل وتعارض restore-age | `FIRST_BOOT` كيقيد المداخل ويرفض الإقلاع بجانب records؛ boot كيطلب تجربة restore ناجحة بلا توقيف restart لمجرد مرور شهر، وواجهة checklist عندها 35 يوماً. F04 باقي كيعطل إدخال evidence بالطريقة الموثقة. [boot.ts:18](/Users/macplanet/BELGOBETON/src/modules/platform-security/boot.ts:18)، [RUNBOOK:41](/Users/macplanet/BELGOBETON/docs/RUNBOOK.md:41)، [RUNBOOK:56](/Users/macplanet/BELGOBETON/docs/RUNBOOK.md:56). |
| 6: APP_DOMAIN ما واصلش Caddy | تصلح: domain مطلوب صراحة وواصل proxy، بلا fallback localhost. DNS/HTTPS/renewal الفعليين ما تحققوش. [compose:53](/Users/macplanet/BELGOBETON/docker-compose.prod.yml:53)، [Caddyfile:5](/Users/macplanet/BELGOBETON/Caddyfile:5). |
| 7: الاستضافة وCNDP | runbook كيسمي Infomaniak/Switzerland وكيطلب declaration ديال النقل. هادي متطلبات مكتوبة؛ ما شفتش receipts/عقد/تصريحات فعلية، وما عطيتش رأياً قانونياً على كفايتها. [RUNBOOK:8](/Users/macplanet/BELGOBETON/docs/RUNBOOK.md:8). |
| 8: pull ينجح بنسخة ناقصة/قديمة | staging، sha/size، manifest، حد 30h وتنبيه موجودين. `copyAtomic` مازال كيقرا archive كاملة للرام فالمكتب، وfileCount أثناء backup ماشي snapshot ثابت إذا تزادو ملفات بالتزامن؛ هادو حدود تشغيل خاص تجربة الحمل/الاسترجاع تكشفها. [backup-pull.sh:25](/Users/macplanet/BELGOBETON/scripts/ops/backup-pull.sh:25)، [backup-lib:229](/Users/macplanet/BELGOBETON/scripts/backup-lib.ts:229)، [نفس الملف:439](/Users/macplanet/BELGOBETON/scripts/backup-lib.ts:439)، [نفس الملف:211](/Users/macplanet/BELGOBETON/scripts/backup-lib.ts:211). |
| 9: anchor بلا أصالة مستقلة | signed pull receipt بمفتاح المكتب وverification فالrestore موجودين. كيحمي من rewrite **من بعد** pull، وما كيضمنش صحة backup خرجت من سيرفر مخترق قبله؛ runbook صريح فهاد الحد. [backup-lib:289](/Users/macplanet/BELGOBETON/scripts/backup-lib.ts:289)، [نفس الملف:481](/Users/macplanet/BELGOBETON/scripts/backup-lib.ts:481)، [RUNBOOK:57](/Users/macplanet/BELGOBETON/docs/RUNBOOK.md:57). |
| 10: ops offline وownership | plain Node عوض pnpm موجود، وfilestore مهيأ بـ UID 10001، وbackup read-group موجود؛ keys/reports باقي **F04**. [ops.sh:8](/Users/macplanet/BELGOBETON/scripts/ops/ops.sh:8)، [Dockerfile:20](/Users/macplanet/BELGOBETON/Dockerfile:20)، [init-host:12](/Users/macplanet/BELGOBETON/scripts/ops/init-host.sh:12). |
| 11: DB/SSH/firewall | Compose ما ناشراش 5432 ولا 3000، غير proxy عندو ports؛ verify-host وexternal scan موثقين. ما كاين حتى دليل حي هنا على IPv4/IPv6/security groups/SSH. حتى verify-host كيقبل `PermitRootLogin prohibit-password` رغم أن runbook كيطلب `no`؛ نجاحه وحده ما يكفيش لإثبات root-login off. [compose:11](/Users/macplanet/BELGOBETON/docker-compose.prod.yml:11)، [verify-host:13](/Users/macplanet/BELGOBETON/scripts/ops/verify-host.sh:13). |
| 12: imports داخل Git/image | imports، xlsx، keys وreports مستثناة. Dockerfile باقي `COPY . .`، لذلك خاص build context نظيفة ومراجعة أي ملف operational جديد؛ مثلاً `scripts/ops/alert.env` اللي كيطلبو alert.sh ما عندوش exclusion صريح فـ ignore files الحالية. ما قريتش هاد الملف وما كنقولش أنه موجود أو فيه secret. [.dockerignore:15](/Users/macplanet/BELGOBETON/.dockerignore:15)، [Dockerfile:9](/Users/macplanet/BELGOBETON/Dockerfile:9)، [alert.sh:10](/Users/macplanet/BELGOBETON/scripts/ops/alert.sh:10). |
| 13: readiness/monitoring/image updates | readiness كتقارن عدد migrations بالjournal، وhealthcheck كيستعمل ready؛ workflow build/push وdigest deployment مكتوبين. monitor والalerts والـ registry private policy ما تثبتوش، وNode/Caddy tags باقين متحركين بين builds. الصورة النهائية خاصها build وفحص وتجربة نشر بـ digest، مع **F05** محلول. [ready/route.ts:23](/Users/macplanet/BELGOBETON/src/app/api/health/ready/route.ts:23)، [Dockerfile:29](/Users/macplanet/BELGOBETON/Dockerfile:29)، [build-image.yml:39](/Users/macplanet/BELGOBETON/.github/workflows/build-image.yml:39)، [RUNBOOK:71](/Users/macplanet/BELGOBETON/docs/RUNBOOK.md:71). |

## واش نطلقو نهار 9 نونبر بمعطيات حقيقية؟

**حالياً: لا، ماشي بهاد commit كما هو.** تاريخ 9 نونبر ممكن يبقى هدفاً مشروطاً؛ هاد المراجعة ما كتقدمش ضمان أن الإصلاح والتحقق غادي يكملو قبله.

قبل أي إدخال لمعطيات حقيقية:

1. تصحيح **F01** فـ SQL والـ server actions؛ وإلى ما تصلحاتش، منع حسابات `plant_manager` من هاد السطح بشكل فعلي، ماشي غير إخفاء الرابط. لوحة المضخات ما عندهاش flag مستقل حالياً. الدور القديم `plant` غير محصور، وما يصلحش workaround لحصر manager.
2. تصحيح **F04 وF05 وF06**، وإثبات install من الصفر، restart، نشر image محددة، وفشل متعمد للنشر مع rollback ناجح، خارج الإنتاج. تأكيد عدم وجود migrator/backup/superuser credentials فـ app runtime.
3. الاحتفاظ بـ `FIELD_APP_ENABLED=false` حتى حل **F02 وF11** وتجربة logout/offline وتبديل الحساب وإلغاء الجهاز والصور المتأخرة؛ واتخاذ قرار صريح بخصوص الخرائط **F07** قبل فتحها لزبناء حقيقيين.
4. إصلاح **F03 وF12** قبل تفعيل القرارات المعنية؛ وإبقاء التحويلات اللي كتحتاج §16.10 خارج المسار الآلي المعتمد حتى يكتمل التحقق التقني. تفعيل R7 بوصفه بوابة موافقة مشروط بحل **F08**.
5. تصحيح **F09 وF10** قبل اعتماد المحاسب/finance؛ يبقاو portals وfinance طافيين إلى ما تكملش موافقتهم المستقلة. بقاء finance طافية ما كيحلش وحده العطل ديال مسارات المحاسب القديمة؛ خاص تحديد مساره المعتمد.
6. فريق البناء يشغّل التحقق المناسب فبيئة منفصلة، على commit نهائية جديدة: عزل سونطرالين، كل دور جديد، رفض HTTP المباشر، downloads، disclosure بالتزامن/الانتهاء، وstep-up/recovery. **أنا ما شغلتش هاد الاختبارات تنفيذاً لطلب القراءة فقط.** يتسجل commit/digest ديال الإصلاحات ونتائج التحقق، وتتراجع التغييرات الأمنية قبل النشر.
7. استرجاع نسخة مسحوبة وموقعة للمكتب على بيئة نظيفة: قاعدة + جميع المرفقات، مع مطابقة file IDs بالملفات وفتحها، وقراءة عينات الحقول الشخصية بكل المفاتيح اللازمة. جدولة backup/pull/restore والتنبيهات خاصها نجاح مثبت، ماشي cron مكتوبة فقط؛ ومفاتيح كل backup محتفظ بها offline.
8. تحقق حي من HTTPS وSSH/firewall IPv4 وIPv6، وإغلاق 3000 و5432 من الخارج، وتشغيل monitoring والتنبيه؛ وتوثيق إجراءات الاستضافة/المعالجة وملف CNDP المطلوب فالمشروع قبل رفع المعطيات. ما اطلعتش على هاد الأدلة التشغيلية أو الإدارية.

الإطلاق المحدود يقدر يستعمل غير المسارات اللي تصلحات وتتحقق منها، مع flags الأخرى طافية فعلياً. **المعيار ديال القبول هو منع وصول معطيات الزبون أو المال لغير المرخص له، وإمكانية الاسترجاع والنشر بأدلة؛ ماشي اكتمال الشاشات أو عدد الاختبارات وحده.**
