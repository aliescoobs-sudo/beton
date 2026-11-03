# مراجعة Codex للتحضير ديال السيرفر — R9

راجعت `main` على commit `28d96be` بالقراءة فقط، بلا تشغيل Docker أو السكريبتات، وبلا قراءة `.env*` ولا `backups/`.

**حسب الملفات الحالية، R9 مازال فيه موانع قبل اعتماد إطلاق بمعطيات حقيقية نهار 9 نونبر.** هادي مراجعة للإعداد المكتوب؛ إعدادات الـ VPS الفعلية ما تحققناش منها.

1. **حرج — النسخة الاحتياطية ما كتضمنش استرجاع التطبيق كامل.**
   الـ backup كيدير `pg_dump` فقط، بينما ملفات BL وصور الفواتير كاينة فـ volume مستقل `filestore`. ضياع السيرفر يقدر يخلي القاعدة راجعة والمرفقات ضايعة. خاص backup منسّق للقاعدة والملفات، ونسخة آمنة خارج السيرفر لمفاتيح فك التشفير وإصداراتها؛ مفتاح age بوحدو ما كيفكش تشفير الحقول والمرفقات.
   الدليل: [backup-lib.ts:95](/Users/macplanet/BELGOBETON/scripts/backup-lib.ts:95)، [compose:38](/Users/macplanet/BELGOBETON/docker-compose.prod.yml:38)، [server-store.ts:10](/Users/macplanet/BELGOBETON/src/lib/files/server-store.ts:10).

2. **حرج — تدوير المفاتيح يقدر يتجاوز المرفقات ويعطي نجاحاً مضللاً.**
   `app` عندو `FILE_STORE_DIR=/data/file-store`، ولكن `ops` ما عندوش نفس الإعداد صراحة. الافتراضي هو `file-store`؛ والبحث فمجلد غير موجود كيرجع لائحة فارغة. هكذا `crypto:rotate` يقدر يقول إن المفاتيح القديمة يمكن حذفها بلا ما يكون دوّر المرفقات. وحتى بعد تدوير البيانات الحية، خاص الاحتفاظ offline بالمفاتيح اللازمة للـ backups القديمة.
   الدليل: [compose:36](/Users/macplanet/BELGOBETON/docker-compose.prod.yml:36)، [compose:62](/Users/macplanet/BELGOBETON/docker-compose.prod.yml:62)، [env.ts:79](/Users/macplanet/BELGOBETON/src/lib/env.ts:79)، [store.ts:48](/Users/macplanet/BELGOBETON/src/lib/files/store.ts:48)، [crypto-rotate.ts:63](/Users/macplanet/BELGOBETON/scripts/crypto-rotate.ts:63)، [crypto-rotate.ts:80](/Users/macplanet/BELGOBETON/scripts/crypto-rotate.ts:80).

3. **عالٍ — فصل الأسرار الموثق متعارض مع الكود.**
   الـ runbook كيحط `DATABASE_URL_MIGRATOR` فـ `.env.ops.prod` فقط، ولكن validation ديال التطبيق كيطلبها إجبارياً. الإعداد الموثق غادي يفشل عند الإقلاع؛ وإعطاء credential ديال migrator للتطبيق كيخرق الفصل المقصود. خاص فصل validation ديال runtime على maintenance. كذلك backup job خاصو غير credential ديال backup والمفتاح العمومي، عوض وراثة أسرار `ops` كاملة.
   الدليل: [RUNBOOK:18](/Users/macplanet/BELGOBETON/docs/RUNBOOK.md:18)، [env.ts:56](/Users/macplanet/BELGOBETON/src/lib/env.ts:56)، [instrumentation.ts:5](/Users/macplanet/BELGOBETON/src/instrumentation.ts:5)، [compose:61](/Users/macplanet/BELGOBETON/docker-compose.prod.yml:61).

4. **عالٍ — أوامر التركيب والـ backup ناقصها تحميل إعدادات Compose.**
   غير أول أمر فيه `--env-file .env.ops.prod`. الأوامر التالية، وحتى cron ديال backup، كتستعمل Compose بلا هاد الخيار، رغم وجود `${POSTGRES_SUPERUSER_PASSWORD:?…}`. فـ shell نظيفة غادي توقف قبل تشغيل الخدمة. `env_file:` ديال container ما كيعاوضش interpolation ديال Compose. خاص طريقة موحدة وصريحة لجميع أوامر التشغيل والصيانة.
   الدليل: [RUNBOOK:26](/Users/macplanet/BELGOBETON/docs/RUNBOOK.md:26)، [compose:14](/Users/macplanet/BELGOBETON/docker-compose.prod.yml:14)، [backup-nightly.sh:7](/Users/macplanet/BELGOBETON/scripts/ops/backup-nightly.sh:7). [توثيق Docker](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation).

5. **عالٍ — أول تشغيل داخل حلقة مغلقة، وإعادة التشغيل لاحقاً فيها تعارض.**
   Compose كيفرض `REAL_DATA=true`، والتطبيق كيرفض الإقلاع حتى تكمل checklist، بينما الـ runbook كيطلب الدخول للتطبيق باش يتسجل TOTP وتتكمّل checklist. خاص bootstrap محمي ومحدد، قبل إدخال المعاملات الحقيقية، بلا تعطيل الحماية للإطلاق العام.
   زيادة على ذلك، تجربة restore خاصها تكون أحدث من **7 أيام**، بينما الـ runbook كيوصي بها شهرياً: أول restart بعد انتهاء السبعة أيام يقدر يوقف الإنتاج. وتجربة المكتب خاصها تسجل الدليل فقاعدة الإنتاج عبر مسار آمن موثق.
   الدليل: [RUNBOOK:33](/Users/macplanet/BELGOBETON/docs/RUNBOOK.md:33)، [boot.ts:9](/Users/macplanet/BELGOBETON/src/modules/platform-security/boot.ts:9)، [checklist.ts:29](/Users/macplanet/BELGOBETON/src/modules/platform-security/domain/checklist.ts:29)، [RUNBOOK:47](/Users/macplanet/BELGOBETON/docs/RUNBOOK.md:47)، [restore-test.ts:50](/Users/macplanet/BELGOBETON/scripts/restore-test.ts:50).

6. **عالٍ — HTTPS ديال الدومين العام ما مكمّلش.**
   Caddy كيقرأ `APP_DOMAIN` من environment ديالو، ولكن خدمة `proxy` ما كتوصلهاش هاد القيمة. النتيجة حسب الإعداد الحالي هي fallback إلى `localhost`، ماشي شهادة الدومين العمومي. خاص تمرير الدومين صراحة، وضبط DNS، وتجربة HTTPS والتحويل من HTTP وتجديد الشهادة.
   الدليل: [Caddyfile:3](/Users/macplanet/BELGOBETON/Caddyfile:3)، [compose:44](/Users/macplanet/BELGOBETON/docker-compose.prod.yml:44). [توثيق Caddy](https://caddyserver.com/docs/caddyfile/concepts#environment-variables).

7. **عالٍ — اختيار سويسرا خاصو يتسوّى فالوثائق والـ checklist وملف CNDP.**
   اختيارك الجديد واضح، ولكن المتطلبات والـ checklist مازال كيفرضو استضافة مغربية. **سويسرا موجودة فاللائحة الرسمية ديال CNDP للدول ذات الحماية الكافية**؛ هذا ما كيلغيش notification ديال النقل وفق المسطرة المناسبة. خاص توثيق معالجة البيانات ونقلها والاستضافة عند Infomaniak قبل رفع بيانات حقيقية، وما يتعلّمش `moroccan_hosting` بأنه صحيح وهو غير صحيح.
   الدليل: [REQUIREMENTS:292](/Users/macplanet/BELGOBETON/docs/REQUIREMENTS-V1.md:292)، [checklist.ts:14](/Users/macplanet/BELGOBETON/src/modules/platform-security/domain/checklist.ts:14). [لائحة CNDP](https://www.cndp.ma/wp-content/uploads/2023/12/deliberation-n-236-2015-18-12-2015.pdf)، [مسطرة النقل](https://www.cndp.ma/notifier-un-traitement/).

8. **عالٍ — سحب backup يقدر يقول “نجح” على نسخة قديمة أو ناقصة.**
   السكريبت كيتحقق من آخر `.sql.age` فقط: ما كيفرضش حداثته، ولا وجود anchor مطابق. وفشل `pg_dump` يقدر يخلي ملفاً ناقصاً؛ تطابق checksum ديالو بعد النقل ما كيبرهنش أنه backup صالح. `--ignore-existing` كذلك كيمنع إصلاح ملف محلي فاسد تلقائياً.
   خاص نشر الملفات غير بعد اكتمال backup والـ manifest، والتحقق من الزوج كامل، والعمر الأقصى، والتنبيه عند فشل أو تأخر النسخة.
   الدليل: [backup-lib.ts:95](/Users/macplanet/BELGOBETON/scripts/backup-lib.ts:95)، [backup-pull.sh:13](/Users/macplanet/BELGOBETON/scripts/ops/backup-pull.sh:13).

9. **عالٍ — الـ anchor ما عندوش إثبات مستقل للأصالة.**
   الـ checksum والـ audit hash محفوظين فـ JSON على نفس السيرفر. مهاجم سيطر عليه يقدر يعاود يصنع dump وanchor متوافقين. الـ runbook معترف بالتوقيع الناقص، ولكن restore الحالي ما كيتحقق من حتى signature. خاص توقيع/مرجع مستقل خارج السيرفر، والتحقق منه فعلياً أثناء الاسترجاع.
   الدليل: [backup-lib.ts:102](/Users/macplanet/BELGOBETON/scripts/backup-lib.ts:102)، [backup-lib.ts:136](/Users/macplanet/BELGOBETON/scripts/backup-lib.ts:136)، [RUNBOOK:48](/Users/macplanet/BELGOBETON/docs/RUNBOOK.md:48).

10. **عالٍ — تشغيل `ops` offline وصلاحيات الملفات مازال خاصهم إثبات.**
    **استنتاج من Dockerfile:** runtime كيدير `corepack enable`، ولكن ما كيجهزش cache ديال pnpm للمستخدم `app`؛ و`ops` محصور فشبكة بلا إنترنت. أول أمر `corepack pnpm` يقدر يفشل بمحاولة download. الحل: تجهيز pnpm offline فالصورة أو تشغيل السكريبتات مباشرة بـ Node.
    كذلك ما كايناش تهيئة موثقة لملكية `filestore` و`backups`، ولا ACL كتسمح لحساب SSH ديال النسخ يقرا ملفات `0600` بلا ما يقدر يكتبها. خاص تجربة write/pull فعلية من fresh install.
    الدليل: [Dockerfile:17](/Users/macplanet/BELGOBETON/Dockerfile:17)، [compose:71](/Users/macplanet/BELGOBETON/docker-compose.prod.yml:71)، [backup-lib.ts:73](/Users/macplanet/BELGOBETON/scripts/backup-lib.ts:73)، [backup-lib.ts:111](/Users/macplanet/BELGOBETON/scripts/backup-lib.ts:111). [Corepack offline](https://github.com/nodejs/corepack#offline-workflow).

11. **عالٍ — القاعدة غير منشورة حسب Compose؛ “مستحيل توصل من الإنترنت” ما نقدرش نضمنها من الملفات.**
    النقطة الإيجابية: `db` ما عندهاش `ports` وكاينة غير فـ `internal: true`؛ غير proxy كينشر 80 و443. باقي خاص التحقق من firewall ديال Infomaniak وUbuntu، جميع Security Groups، وIPv4 وIPv6، وتجربة خارجية أن 5432 و3000 مسدودين. UFW بوحدو ماشي ضمان للبورتات اللي Docker كينشرها.
    وSSH خاص يتثبت فعلياً بـ `sshd -T`: public key فقط، password وkeyboard-interactive مطفيين، root مطفي، و22 محدود لمصادر الإدارة المناسبة.
    الدليل: [compose:9](/Users/macplanet/BELGOBETON/docker-compose.prod.yml:9)، [compose:73](/Users/macplanet/BELGOBETON/docker-compose.prod.yml:73)، [RUNBOOK:12](/Users/macplanet/BELGOBETON/docs/RUNBOOK.md:12). [Docker/UFW](https://docs.docker.com/engine/network/packet-filtering-firewalls/#docker-and-ufw)، [Infomaniak](https://docs.infomaniak.cloud/network/security_groups/)، [Ubuntu SSH](https://ubuntu.com/server/docs/how-to/security/openssh-server/).

12. **عالٍ — ملفات Excel المستوردة تقدر تدخل للصورة ولـ Git بالغلط.**
    الـ runbook كيحط البيانات فـ `imports/`، وDockerfile كينسخ المشروع كامل، ولكن `imports/` ما مستثناش فـ `.dockerignore` ولا `.gitignore`. البناء من مجلد فيه بيانات حقيقية يقدر ينسخها لطبقات الصورة. خاص استثناؤها ونسخ غير الملفات اللازمة للتشغيل.
    الدليل: [RUNBOOK:37](/Users/macplanet/BELGOBETON/docs/RUNBOOK.md:37)، [Dockerfile:9](/Users/macplanet/BELGOBETON/Dockerfile:9)، [.dockerignore:1](/Users/macplanet/BELGOBETON/.dockerignore:1)، [.gitignore:1](/Users/macplanet/BELGOBETON/.gitignore:1).

13. **متوسط — المراقبة والتحديثات مازال تعليمات، ماشي تجهيز مثبت.**
    `ready` كيتحقق غير من وجود جدولين، ويقدر يعطي نجاح مع migrations ناقصة. Docker healthcheck كيقيس `live` فقط. خاص monitor خارجي لـ HTTPS، وفحص داخلي للجاهزية، وتنبيهات backup/disk/RAM/OOM، وتدوير logs.
    كذلك `unattended-upgrades` ما كيحدّثش محتوى صور Node/Caddy/Postgres تلقائياً؛ خاص دورة rebuild وفحص ونشر مع rollback لصورة محددة، عوض الاعتماد على tags متحركة.
    الدليل: [ready:9](/Users/macplanet/BELGOBETON/src/app/api/health/ready/route.ts:9)، [Dockerfile:25](/Users/macplanet/BELGOBETON/Dockerfile:25)، [RUNBOOK:63](/Users/macplanet/BELGOBETON/docs/RUNBOOK.md:63)، [Dockerfile:4](/Users/macplanet/BELGOBETON/Dockerfile:4)، [compose:45](/Users/macplanet/BELGOBETON/docker-compose.prod.yml:45). [Ubuntu updates](https://ubuntu.com/server/docs/how-to/software/automatic-updates/)، [Docker image updates](https://docs.docker.com/build/building/best-practices/).

**بالنسبة للـ OOM: اختياري هو build خارج سيرفر الإنتاج.** نوصي بـ Linux builder عندو **8 GB RAM أو أكثر كهامش عملي، ماشي minimum مضمون**، يبني صورة لنفس architecture ديال الـ VPS، وتتجرب ثم كتتنشر بـ commit tag وdigest. السيرفر ديال 4 GB يدير pull وتشغيل فقط. الـ runbook الحالي كيوصي بالبناء عليه رغم أن الصورة ما تجرباتش كاملة. [RUNBOOK:21](/Users/macplanet/BELGOBETON/docs/RUNBOOK.md:21)، [RUNBOOK:52](/Users/macplanet/BELGOBETON/docs/RUNBOOK.md:52).

Swap صغيرة، مثلاً 2–4 GB، تقدر تكون احتياط للضغط العابر، ولكن ما نعتمدوش عليها باش نبنيو الصورة فوق PostgreSQL خدام. وحتى backup خاصو تحسين: حساب SHA حالياً كيقرا الملف المشفر كامل للرام؛ خاص hashing بالـ stream. [backup-lib.ts:59](/Users/macplanet/BELGOBETON/scripts/backup-lib.ts:59). حدود الذاكرة والـ swap خاصها قياس؛ Docker ما كيفرضش حدود افتراضياً. [توثيق الموارد](https://docs.docker.com/engine/containers/resource_constraints/).

باش نعتمدو **9 نونبر بمعطيات حقيقية**، خاص قبلها:

- تسوية CNDP والاستضافة السويسرية وتحديث checklist بصدق.
- تجربة تركيب كاملة من قاعدة فارغة، بأسرار مفصولة وHTTPS وSSH/firewall متحقق منهم.
- استرجاع نسخة مسحوبة للمكتب على بيئة جديدة، **بالقاعدة والمرفقات والمفاتيح**، وفتح وثائق فعلية بعد الاسترجاع.
- تثبيت الجدولة والتنبيهات، وحل تعارض 7 أيام/شهر، وتجربة reboot وrollback.
- تثبيت بيانات البداية والشيكات الجارية والوصفات، ورقم آخر فاتورة واختيارات المحاسب؛ ومراجعة النسخة النهائية بعد الدفعة B.

حماية `REAL_DATA` من simulation والـ AI الخارجي موجودة ومزيانة؛ خاص إصلاح مسار التشغيل حولها، والحفاظ عليها.
