# G7 — نتائج الأداء على PGlite (G7_PERF_RESULTS)

> **ملف مُولَّد** بواسطة `supabase/tests/g7-perf.js --write` — لا يُحرَّر يدويًا. الأرقام **مؤشرات لا اتفاقيات مستوى خدمة** (القرار G7-16).
> اختبار الحمل الفعلي على Supabase (staging tier): **قيد انتظار المالك (OWNER-PENDING)**.

## البيئة

- **PGlite in Node, single connection — indicator only** (Postgres 16 مُجمَّع WASM، اتصال واحد، بلا شبكة، بلا تزامن حقيقي).
- Run at: 2026-11-02T15:40:09.553Z · Node v22.23.3 · darwin x64 · CPU: Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz
- Scale: 1 · latency runs per RPC: 20 · G7 migration: present
- Build time: migrations 2.4 s · bulk volume 113.9 s · whole run 172.1 s

## الحجم المُولَّد (لكل مؤسسة × 2)

| الكيان | لكل مؤسسة (مطلوب) | الإجمالي الفعلي في القاعدة |
|---|---:|---:|
| transactions | 5000 | 10503 |
| containers | 20000 | 40003 |
| msg_threads | 10000 | 21000 |
| msg_messages | 50000 | 101000 |
| transaction_events (extra; + trigger events) | 15000 | 121511 |
| documents | 10000 | 20500 |
| supplier_invoices | 500 | 1000 |
| audit_log (triggers) | — | 133085 |

## الإنتاجية المقاسة (RPC throughput)

| العملية | العدد | الأخطاء | الزمن الكلي (ms) | المعدل (/s) | p50 للنداء (ms) | p95 (ms) | max (ms) |
|---|---:|---:|---:|---:|---:|---:|---:|
| convert_request_to_transaction (staff, one call each) | 500 | 0 | 3054.4 | 163.7 | 6.2 | 7.8 | 15.2 |
| msg_ingest_messages (service role, batch of 50) | 1000 | 0 | 2966.1 | 337.1 | 154.5 | 164.5 | 166.3 |
| documents INSERT (clearance staff, RLS) | 500 | 0 | 2161.0 | 231.4 | 4.2 | 5.6 | 7.8 |

## زمن الاستجابة (20 تشغيلًا لكل حالة)

الحد المرن: p95 ≤ 2000 ms على PGlite (WARN لا FAIL).

| RPC | الدور | p50 (ms) | p95 (ms) | max (ms) | الحكم |
|---|---|---:|---:|---:|---|
| search_records | org admin | 130.7 | 137.8 | 147.8 | ضمن الحد |
| search_records | branch manager (JED) | 99.7 | 101.4 | 102.1 | ضمن الحد |
| search_records (empty filter) | org admin | 66.7 | 68.8 | 69.0 | ضمن الحد |
| search_records (empty filter) | branch manager (JED) | 51.8 | 53.4 | 55.2 | ضمن الحد |
| report_transactions | org admin | 201.7 | 213.0 | 229.4 | ضمن الحد |
| report_transactions | branch manager (JED) | 157.3 | 163.8 | 166.8 | ضمن الحد |
| report_containers | org admin | 51.0 | 58.9 | 59.4 | ضمن الحد |
| report_containers | branch manager (JED) | 34.3 | 35.6 | 35.9 | ضمن الحد |
| report_trips (empty path: no trips generated) | org admin | 4.4 | 6.3 | 8.2 | ضمن الحد |
| report_trips (empty path: no trips generated) | branch manager (JED) | 3.9 | 4.9 | 5.3 | ضمن الحد |
| dash_ops | org admin | 143.9 | 160.6 | 160.6 | ضمن الحد |
| dash_ops | branch manager (JED) | 83.3 | 89.0 | 89.4 | ضمن الحد |
| dash_finance | org admin | 32.4 | 57.1 | 61.5 | ضمن الحد |
| dash_finance | branch manager (JED) | 20.1 | 21.0 | 21.3 | ضمن الحد |
| dash_management | org admin | 125.0 | 142.4 | 149.2 | ضمن الحد |
| dash_management | branch manager (JED) | 92.1 | 95.9 | 98.9 | ضمن الحد |
| list_msg_threads | org admin | 223.7 | 236.0 | 401.0 | ضمن الحد |
| list_msg_threads | branch manager (JED) | 110.4 | 114.4 | 115.1 | ضمن الحد |
| get_msg_thread | org admin | 9.6 | 11.1 | 12.6 | ضمن الحد |
| get_msg_thread | branch manager (JED) | 11.8 | 14.6 | 15.6 | ضمن الحد |
| tx_checklist (early path: no requirements configured for the generated transactions) | org admin | 5.1 | 6.5 | 9.5 | ضمن الحد |
| tx_checklist (early path: no requirements configured for the generated transactions) | branch manager (JED) | 5.0 | 5.7 | 6.1 | ضمن الحد |
| margin_report | org admin | 151.8 | 161.1 | 162.2 | ضمن الحد |
| margin_report | branch manager (JED) | 142.0 | 154.9 | 155.0 | ضمن الحد |
| platform_list_subscriptions | platform admin | 3.6 | 5.7 | 7.7 | ضمن الحد |

ملاحظات: `report_trips` لا رحلات في الحجم المُولَّد (قائمة الحجم في المواصفة لا تشملها) فهو يقيس كلفة المسار الفارغ فقط، و`tx_checklist` بلا متطلبات مستندات مُعدّة للمعاملات المولَّدة فيقيس المسار المبكر فقط (كلاهما موسوم في الجدول)؛ كل حالة أخرى يُتحقق أن نتيجتها تحمل بيانات، ولا يُقبل رفض بالدور إلا لـ `margin_report` و`dash_finance`؛ `platform_list_subscriptions` على مؤسستين فقط؛ «branch manager» مقيد بفرع JED (نصف معاملات المؤسسة تقريبًا).

## خطط التنفيذ (EXPLAIN FORMAT JSON)

بوابة صلبة: لا Seq Scan على الجداول الكبيرة للمسندات الأساسية المفلترة بالمؤسسة.

| المسند | الجدول | الحكم | الفهارس المستخدمة | ترشيح بعد الفهرس | عقدة الجذر |
|---|---|---|---|---|---|
| transactions: org + branch + status (queues, dash_ops) | transactions | index | transactions_branch_status_idx | لا | Index Scan |
| transactions: org + created_at month (report_transactions period) | transactions | index | transactions_g6a_created_idx | لا | Bitmap Heap Scan |
| transactions: org + ref (search exact ref) | transactions | index | transactions_ref_uniq | لا | Index Scan |
| transactions: org + bl_number (matching / search) | transactions | index | transactions_bl_idx | لا | Index Scan |
| transactions: org + eta range | transactions | index | transactions_g6a_eta_idx | لا | Index Scan |
| containers: by transaction (tx detail, tx_checklist) | containers | index | containers_tx_no_uniq | لا | Bitmap Heap Scan |
| containers: org + container_no (matching / search) | containers | index | containers_no_idx | لا | Index Scan |
| containers: org + open return deadline (alerts, dash_ops) | containers | index | containers_open_idx | لا | Index Scan |
| msg_threads: org + branch + status, newest first (list_msg_threads) | msg_threads | index | msg_threads_inbox_idx | لا | Limit |
| msg_threads: by transaction (tx_messages) | msg_threads | index | msg_threads_tx_idx | لا | Index Scan |
| msg_threads: org + match review queue | msg_threads | index | msg_threads_match_idx | لا | Index Scan |
| msg_messages: by thread (get_msg_thread) | msg_messages | index | msg_messages_thread_idx | لا | Index Scan |
| msg_messages: org + sender (sender history / matching) | msg_messages | index | msg_messages_from_idx | لا | Index Scan |
| transaction_events: by transaction (timeline, portal) | transaction_events | index | transaction_events_tx_idx | لا | Sort |
| transaction_events: org + to_status + period (dash_management) | transaction_events | index | transaction_events_g6a_status_idx | لا | Index Scan |
| audit_log: org, newest first (admin_audit_log) | audit_log | index | audit_log_org_idx | لا | Limit |
| audit_log: org + period (admin_audit_log from/to) | audit_log | index | audit_log_org_idx | لا | Limit |
| audit_log: by row (record history) | audit_log | index | audit_log_row_idx | لا | Index Scan |
| ADVISORY msg_messages: org + month (G7 recount messages_month) | msg_messages | index | msg_messages_from_idx | لا | Aggregate |
| ADVISORY transactions: org + month count (G7 recount transactions_month) | transactions | index | transactions_g6a_created_idx | لا | Aggregate |

## بايتات التخزين لكل كيان (تغذي نموذج التكلفة)

`pg_total_relation_size` (الجدول + الفهارس + TOAST) ÷ عدد الصفوف. على Postgres المُدار تختلف القيم قليلًا (fillfactor، bloat، WAL).

| الجدول | الصفوف | الحجم الكلي (KB) | الجدول فقط (KB) | بايت/صف (شامل الفهارس) |
|---|---:|---:|---:|---:|
| transactions | 10503 | 6552.0 | 3096.0 | 639 |
| containers | 40003 | 18592.0 | 6960.0 | 476 |
| transaction_events | 121511 | 32888.0 | 25688.0 | 277 |
| documents | 20500 | 19592.0 | 8192.0 | 979 |
| msg_threads | 21000 | 11376.0 | 7392.0 | 555 |
| msg_messages | 101000 | 88528.0 | 50672.0 | 898 |
| audit_log | 133085 | 151680.0 | 127208.0 | 1167 |
| supplier_invoices | 1000 | 648.0 | 208.0 | 664 |
| clients | 403 | 264.0 | 64.0 | 671 |
| service_requests | 501 | 472.0 | 200.0 | 965 |
| bills_of_lading | 10002 | 3392.0 | 1744.0 | 347 |
| transaction_bls | 10002 | 2352.0 | 912.0 | 241 |
| msg_jobs | 1002 | 576.0 | 224.0 | 589 |
| org_usage_counters | 56 | 10888.0 | 10712.0 | 199095 |

حجم القاعدة الكلي بعد التشغيل: 360.9 MB.

ملاحظة G7: `org_usage_counters` (56 صفًا) بلغ 10888.0 KB قبل VACUUM و 10896.0 KB بعده — كل إدراج محسوب يحدّث صفًا واحدًا لكل مؤسسة / مقياس / شهر (صف ساخن)، فتتراكم نسخ ميتة؛ VACUUM العادي يجعل المساحة قابلة لإعادة الاستخدام ولا يصغّر الملف (لذا الرقمان متقاربان)، والنمو يتوقف بعد autovacuum. وتتسلسل الإدراجات المتزامنة على قفل ذلك الصف (البند المفتوح ٢ في G7_SPEC). قيمة «بايت/صف» أعلاه لهذا الجدول لا تُستخدم في نموذج التكلفة.

## الأحكام

- 55 passed, 0 failed, 0 warnings.

## ما لا تثبته هذه الأرقام

- لا تزامن: PGlite اتصال واحد؛ قفل عدادات الباقات (G7) وتنافس الكتابة لا يظهران هنا.
- لا شبكة ولا PostgREST ولا Edge Functions: زمن الشبكة وحدود Supabase (connections، compute tier) غير مقاسة.
- اختبار الحمل على staging وتسعير الطبقة: **قيد انتظار المالك (OWNER-PENDING)** — الإجراء في `G7_COST_MODEL_AR.md`.
