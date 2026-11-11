/* =====================================================================
   مرسى | MARSA — i18n.js (G2.11): central translation + RTL/LTR.
   Contract: docs/online/G2_SPEC.md §i18n.
   Load order: config.js → i18n.js → main.js → supa.js → [assets/i18n/<page>.js] → <page>.js (all defer).

   window.MarsaI18n = {
     register(ns, {ar:{k}, en:{k}})  keys become 'ns.k'; re-applies the page if it is already parsed
     t('ns.k', {var})                 lang → ar → key fallback; {var} interpolation
     lang() 'ar'|'en'   dir() 'rtl'|'ltr'   locale() Intl locale tag
     setLang(l, {persist?})           html[lang,dir], localStorage 'marsa_lang' (unless persist:false), re-apply,
                                      dispatches window 'marsa:langchange' {detail:{lang, dir}}
     hasPageDict()                    true once a page dictionary (not only the shared chrome) is registered
     apply(root?)                     [data-i18n] → text, [data-i18n-html] → innerHTML (trusted dicts only),
                                      [data-i18n-attr="placeholder:ns.k;title:ns.k;aria-label:ns.k"]
     label(domain, code, row?)        status_labels row.label_ar/label_en, else 'label.<domain>.<code>', else code
     fmtDate(d, {time?}) fmtNumber(n, {digits?}) fmtMoney(n, currency='SAR')   Intl, latin digits
     has(key)
   }
   Markup keeps the Arabic text as the default. apply() remembers each element's
   original Arabic so switching back to Arabic restores it even when a
   dictionary has no 'ar' entry for that key.
   Initial lang: localStorage.marsa_lang → MARSA_CONFIG.defaultLocale → 'ar' — on pages marked
   <html data-i18n-page> only (the others are Arabic-only until they get a dictionary).
   Translated pages also carry a tiny inline <head> script that sets lang/dir before first paint.
   ===================================================================== */
(function () {
  'use strict';
  var LANGS = ['ar', 'en'];
  var KEY = 'marsa_lang';
  var LOCALES = { ar: 'ar-SA-u-nu-latn-ca-gregory', en: 'en-GB' };
  var dicts = { ar: {}, en: {} };
  var ORIG = '__marsaI18nOrig';   // per-element cache of the markup's Arabic
  // shared chrome namespaces; any other namespace means "this page has its own dictionary"
  var SHARED_NS = { common: 1, nav: 1, banner: 1, footer: 1, err: 1, field: 1, label: 1 };
  var pageDict = false;

  function norm(l) { return l === 'en' ? 'en' : (l === 'ar' ? 'ar' : null); }
  function initialLang() {
    var l = null;
    try { l = norm(localStorage.getItem(KEY)); } catch (e) { l = null; }
    if (!l) l = norm(((window.MARSA_CONFIG || {}).defaultLocale || '').slice(0, 2));
    return l || 'ar';
  }
  var current = initialLang();
  // Only pages marked <html data-i18n-page> (they ship assets/i18n/<page>.js) are translated.
  // The others stay Arabic for this view; the saved choice is kept for the translated pages.
  if (!document.documentElement.hasAttribute('data-i18n-page')) current = 'ar';

  function lang() { return current; }
  function dir() { return current === 'en' ? 'ltr' : 'rtl'; }
  function locale() { return LOCALES[current]; }
  function has(key) { return dicts[current][key] != null || dicts.ar[key] != null; }

  function interp(s, vars) {
    return vars ? String(s).replace(/\{(\w+)\}/g, function (m, k) { return vars[k] != null ? vars[k] : m; }) : s;
  }
  function t(key, vars) {
    var s = dicts[current][key];
    if (s == null) s = dicts.ar[key];
    if (s == null) return key;
    return interp(s, vars);
  }
  // value for apply(): current lang → (ar: markup original) → ar dict → markup original
  function pick(key, orig) {
    var s = dicts[current][key];
    if (s == null && current === 'ar' && orig != null) return orig;
    if (s == null) s = dicts.ar[key];
    if (s == null) s = orig;
    return s;
  }

  function setHtmlAttrs() {
    var h = document.documentElement;
    h.setAttribute('lang', current);
    h.setAttribute('dir', dir());
  }

  /* ---- text replacement that keeps child icons (<svg>) in place ---- */
  function textNodes(el) {
    var out = [];
    for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && /\S/.test(n.nodeValue)) out.push(n);
    return out;
  }
  function setText(el, key) {
    var o = el[ORIG] || (el[ORIG] = {});
    if (!el.firstElementChild) {
      if (o.text == null) o.text = el.textContent;
      var v = pick(key, o.text);
      if (v != null && el.textContent !== v) el.textContent = v;
      return;
    }
    var nodes = textNodes(el);
    if (o.text == null) o.text = nodes.length ? nodes[0].nodeValue.trim() : '';
    var val = pick(key, o.text);
    if (val == null) return;
    if (!nodes.length) { el.appendChild(document.createTextNode(val)); return; }
    var first = nodes[0];
    var lead = (first.nodeValue.match(/^\s*/) || [''])[0], trail = (first.nodeValue.match(/\s*$/) || [''])[0];
    first.nodeValue = lead + val + trail;
    for (var i = 1; i < nodes.length; i++) nodes[i].nodeValue = ' ';
  }
  function setHtml(el, key) {
    var o = el[ORIG] || (el[ORIG] = {});
    if (o.html == null) o.html = el.innerHTML;
    var v = pick(key, o.html);
    if (v != null && el.innerHTML !== v) el.innerHTML = v;   // dictionaries are trusted, shipped with the site
  }
  function setAttrs(el, spec) {
    var o = el[ORIG] || (el[ORIG] = {});
    o.attr = o.attr || {};
    String(spec).split(';').forEach(function (pair) {
      var i = pair.indexOf(':');
      if (i < 1) return;
      var name = pair.slice(0, i).trim(), key = pair.slice(i + 1).trim();
      if (!name || !key) return;
      if (!(name in o.attr)) o.attr[name] = el.getAttribute(name);
      var v = pick(key, o.attr[name]);
      if (v != null) el.setAttribute(name, v);
    });
  }

  function apply(root) {
    root = root || document;
    if (root === document) setHtmlAttrs();
    var each = function (sel, fn) {
      var list = root.querySelectorAll ? root.querySelectorAll(sel) : [];
      for (var i = 0; i < list.length; i++) fn(list[i]);
      if (root.matches && root.matches(sel)) fn(root);
    };
    each('[data-i18n]', function (el) { setText(el, el.getAttribute('data-i18n')); });
    each('[data-i18n-html]', function (el) { setHtml(el, el.getAttribute('data-i18n-html')); });
    each('[data-i18n-attr]', function (el) { setAttrs(el, el.getAttribute('data-i18n-attr')); });
    return root;
  }

  // opts.persist === false: this page view only (e.g. an untranslated page shown in Arabic
  // without overwriting the visitor's saved choice)
  function setLang(l, opts) {
    l = norm(l) || 'ar';
    current = l;
    if (!(opts && opts.persist === false)) {
      try { localStorage.setItem(KEY, l); } catch (e) { /* storage unavailable: this page view only */ }
    }
    apply(document);
    try { window.dispatchEvent(new CustomEvent('marsa:langchange', { detail: { lang: l, dir: dir() } })); }
    catch (e) { /* very old browsers: no CustomEvent constructor */ }
    return l;
  }

  function register(ns, d) {
    if (!SHARED_NS[ns]) pageDict = true;
    LANGS.forEach(function (l) {
      var src = (d && d[l]) || {};
      Object.keys(src).forEach(function (k) { dicts[l][ns + '.' + k] = src[k]; });
    });
    // a page dictionary (deferred, after i18n.js) registered after the first apply():
    // translate the page again right away so no Arabic flash remains for English readers
    if (applied && current !== 'ar') apply(document);
  }

  function label(domain, code, row) {
    if (row) {
      var v = row['label_' + current] || row.label_ar;
      if (v) return v;
    }
    var key = 'label.' + domain + '.' + code;
    return has(key) ? t(key) : String(code == null ? '' : code);
  }

  /* ---- Intl formatting (latin digits, Gregorian calendar) ---- */
  function toDate(d) {
    if (d == null || d === '') return null;
    var x = d instanceof Date ? d : new Date(d);
    return isNaN(x.getTime()) ? null : x;
  }
  function fmtDate(d, o) {
    var x = toDate(d);
    if (!x) return '';
    var opt = { year: 'numeric', month: 'short', day: 'numeric' };
    if (o && o.time) { opt.hour = '2-digit'; opt.minute = '2-digit'; }
    try { return new Intl.DateTimeFormat(locale(), opt).format(x); }
    catch (e) { return x.toISOString().slice(0, o && o.time ? 16 : 10).replace('T', ' '); }
  }
  function fmtNumber(n, o) {
    var num = Number(n) || 0;
    var dg = o && o.digits != null ? o.digits : null;
    var opt = { minimumFractionDigits: dg == null ? 0 : dg, maximumFractionDigits: dg == null ? 2 : dg };
    try { return new Intl.NumberFormat(current === 'en' ? 'en-GB' : 'ar-SA-u-nu-latn', opt).format(num); }
    catch (e) { return num.toFixed(dg == null ? 2 : dg); }
  }
  function fmtMoney(n, currency) {
    currency = currency || 'SAR';
    var s = fmtNumber(n, { digits: 2 });
    if (currency === 'SAR') return current === 'en' ? 'SAR ' + s : s + ' ر.س';
    return current === 'en' ? currency + ' ' + s : s + ' ' + currency;
  }

  /* ================= shared dictionaries ================= */
  register('common', {
    ar: {
      langToggle: 'English', langToggleAria: 'التبديل إلى اللغة الإنجليزية', langName: 'العربية',
      toTop: 'العودة لأعلى الصفحة', close: 'إغلاق', cancel: 'إلغاء', save: 'حفظ', retry: 'إعادة المحاولة',
      loading: 'جارٍ التحميل…', copy: 'نسخ', copied: 'تم النسخ', yes: 'نعم', no: 'لا', sar: 'ر.س',
      trackInvalid: 'من فضلك أدخل رقم شحنة أو رقم مرجعي صحيح',
      storageFail: 'تعذّر الوصول إلى التخزين المحلي في هذا المتصفح، فلم يُحذف شيء.',
      clearDone: 'تم مسح بياناتك المحفوظة من هذا الجهاز. أعد تحميل الصفحة لتحديث ما يظهر فيها.',
      clearNone: 'لا توجد بيانات محفوظة لموقع مرسى على هذا الجهاز.',
      clearConfirmDemo: 'سيتم حذف كل ما حفظه موقع مرسى في هذا المتصفح (الطلبات والحسابات والرسائل والمسودات). لا يمكن التراجع عن ذلك. هل تريد المتابعة؟',
      clearConfirmStaging: 'سيتم حذف ما حفظه موقع مرسى في هذا المتصفح (الحسابات والمسودات وجلسة الدخول، فستُسجَّل خارج حسابك على هذا الجهاز). البيانات المرسلة إلى الخادم لا تُحذف بهذا الزر؛ لطلب حذفها تواصل معنا. هل تريد المتابعة؟'
    },
    en: {
      langToggle: 'العربية', langToggleAria: 'Switch to Arabic', langName: 'English',
      toTop: 'Back to top', close: 'Close', cancel: 'Cancel', save: 'Save', retry: 'Retry',
      loading: 'Loading…', copy: 'Copy', copied: 'Copied', yes: 'Yes', no: 'No', sar: 'SAR',
      trackInvalid: 'Please enter a valid shipment or reference number',
      storageFail: 'This browser blocks local storage, so nothing was deleted.',
      clearDone: 'Your saved data was removed from this device. Reload the page to refresh what it shows.',
      clearNone: 'There is no Marsa data saved on this device.',
      clearConfirmDemo: 'Everything Marsa saved in this browser (requests, accounts, messages and drafts) will be deleted. This cannot be undone. Continue?',
      clearConfirmStaging: 'What Marsa saved in this browser (accounts, drafts and your sign-in session — you will be signed out on this device) will be deleted. Data already sent to the server is not deleted by this button; contact us to request that. Continue?'
    }
  });

  register('nav', {
    ar: {
      skip: 'تخطَّ إلى المحتوى', tagline: 'منصة سعودية للتخليص الجمركي والشحن أونلاين',
      authNav: 'الدخول إلى المنصة', homeAria: 'مرسى - الصفحة الرئيسية', logoAlt: 'مرسى MARSA - تخليص جمركي وشحن', logoAltShort: 'مرسى MARSA',
      mainMenu: 'القائمة الرئيسية', openMenu: 'فتح القائمة', closeMenu: 'إغلاق القائمة', drawer: 'القائمة الجانبية',
      home: 'الرئيسية', services: 'خدماتنا', calculator: 'حاسبة الرسوم', calculatorFull: 'حاسبة الرسوم الجمركية',
      tracking: 'تتبع الشحنة', bulk: 'الرفع الجماعي', bulkFull: 'الرفع الجماعي للبيانات',
      ocr: 'قراءة المستندات', ocrFull: 'قراءة المستندات (OCR)', about: 'من نحن', contact: 'تواصل معنا',
      request: 'اطلب تخليص', requestNow: 'اطلب تخليص الآن',
      clientLogin: 'دخول العملاء', staffLogin: 'دخول الموظفين', portal: 'بوابتي', platform: 'لوحة المنصة'
    },
    en: {
      skip: 'Skip to content', tagline: 'Saudi platform for online customs clearance and shipping',
      authNav: 'Sign in to the platform', homeAria: 'Marsa - home page', logoAlt: 'MARSA - customs clearance and shipping', logoAltShort: 'MARSA',
      mainMenu: 'Main menu', openMenu: 'Open menu', closeMenu: 'Close menu', drawer: 'Side menu',
      home: 'Home', services: 'Services', calculator: 'Duty calculator', calculatorFull: 'Customs duty calculator',
      tracking: 'Track shipment', bulk: 'Bulk upload', bulkFull: 'Bulk data upload',
      ocr: 'Read documents', ocrFull: 'Document reading (OCR)', about: 'About us', contact: 'Contact us',
      request: 'Request clearance', requestNow: 'Request clearance now',
      clientLogin: 'Client sign-in', staffLogin: 'Staff sign-in', portal: 'My portal', platform: 'Platform console'
    }
  });

  register('banner', {
    ar: {
      demo: 'نسخة عرض تجريبية — البيانات والأرقام توضيحية ولا تُرسل أي بيانات إلى خادم.',
      staging: 'بيئة تجريبية (Staging) — البيانات للاختبار فقط',
      closeDemo: 'إخفاء تنبيه نسخة العرض لهذه الجلسة',
      closeStaging: 'إخفاء تنبيه البيئة التجريبية لهذه الجلسة'
    },
    en: {
      demo: 'Demo version — data and figures are illustrative and nothing is sent to a server.',
      staging: 'Staging environment — test data only',
      closeDemo: 'Hide the demo notice for this session',
      closeStaging: 'Hide the staging notice for this session'
    }
  });

  register('footer', {
    ar: {
      about: 'مرسى منصة سعودية لخدمات التخليص الجمركي والشحن أونلاين، تساعد المستوردين والمصدّرين في المملكة على تخليص شحناتهم بسرعة وشفافية.',
      facebook: 'فيسبوك', linkedin: 'لينكدإن', whatsapp: 'واتساب',
      quickLinks: 'روابط سريعة', faq: 'الأسئلة الشائعة', tools: 'أدوات المنصة',
      bulk: 'الرفع الجماعي (Excel / CSV)', aci: 'البيان المسبق ومنصة فسح', hs: 'تصنيف HS Code',
      contactTitle: 'تواصل معنا', address: 'طريق الملك عبدالعزيز، حي الحمراء – جدة', hours: 'الأحد – الخميس: 8 ص – 5 م',
      clearData: 'مسح بياناتي من هذا الجهاز',
      rights: 'مرسى MARSA. جميع الحقوق محفوظة.',
      disclaimer: 'منصة خاصة لخدمات التخليص الجمركي — غير تابعة لأي جهة حكومية.',
      privacyDemo: '<strong>الخصوصية في نسخة العرض:</strong> ما تُدخله في النماذج والحاسبة يبقى في التخزين المحلي (localStorage) لهذا المتصفح فقط، دون تشفير ودون إرسال إلى أي خادم، فلا تُدخل بيانات حقيقية حساسة. خط الموقع ومكتبة الاتصال مستضافان على الموقع نفسه، فلا يتصل متصفحك بخوادم خارجية لتحميلهما.',
      privacyStaging: '<strong>الخصوصية في البيئة التجريبية (Staging):</strong> هذه بيئة اختبار ببيانات تجريبية، فلا تُدخل بيانات حقيقية أو حساسة. طلبات التخليص ورسائل التواصل والرفع الجماعي وتسجيل الدخول والمستندات المرفوعة تُرسل عبر اتصال مشفّر (HTTPS) إلى قاعدة بيانات الموقع على خدمة Supabase، ويقتصر الاطلاع عليها على الموظفين المخوَّلين وصاحب الطلب وفق صلاحيات قاعدة البيانات. أما الحاسبة والمسودات وجلسة الدخول فتُحفظ في التخزين المحلي (localStorage) لهذا المتصفح. خط الموقع ومكتبة الاتصال مستضافان على الموقع نفسه، فلا يتصل متصفحك بخوادم خارجية لتحميلهما.'
    },
    en: {
      about: 'Marsa is a Saudi platform for online customs clearance and shipping services, helping importers and exporters in the Kingdom clear their shipments quickly and transparently.',
      facebook: 'Facebook', linkedin: 'LinkedIn', whatsapp: 'WhatsApp',
      quickLinks: 'Quick links', faq: 'FAQ', tools: 'Platform tools',
      bulk: 'Bulk upload (Excel / CSV)', aci: 'Advance declaration & FASAH', hs: 'HS Code classification',
      contactTitle: 'Contact us', address: 'King Abdulaziz Road, Al Hamra District – Jeddah', hours: 'Sunday – Thursday: 8 am – 5 pm',
      clearData: 'Clear my data from this device',
      rights: 'MARSA. All rights reserved.',
      disclaimer: 'A private customs clearance service — not affiliated with any government body.',
      privacyDemo: '<strong>Privacy in the demo:</strong> what you enter in forms and the calculator stays in this browser\'s local storage (localStorage) only, unencrypted and never sent to a server, so do not enter real sensitive data. The site font and the connection library are hosted on this site, so your browser does not contact third-party servers to load them.',
      privacyStaging: '<strong>Privacy in staging:</strong> this is a test environment with test data, so do not enter real or sensitive data. Clearance requests, contact messages, bulk uploads, sign-in and uploaded documents are sent over an encrypted connection (HTTPS) to the site database on Supabase, and only authorised staff and the requester can see them, as enforced by database permissions. The calculator, drafts and sign-in session are kept in this browser\'s local storage (localStorage). The site font and the connection library are hosted on this site, so your browser does not contact third-party servers to load them.'
    }
  });

  // err.<CODE>: every MRS_* code (migrations + supa.js + G2 front-end codes) and supa.js generic codes.
  // {f} = the field / detail reported with the error (same placeholder as MarsaApi.i18n.ar).
  register('err', {
    ar: {
      MRS_INVALID: 'قيمة غير صحيحة في حقل «{f}».',
      MRS_REQUIRED: 'حقل «{f}» مطلوب.',
      MRS_TOO_LONG: 'النص في حقل «{f}» أطول من المسموح.',
      MRS_RATE_LIMITED: 'وصلنا عدد كبير من الطلبات خلال وقت قصير. حاول مرة أخرى بعد ساعة.',
      // public anti-spam (20261113000100): per-IP limits / form signals — one generic message
      cdetail_MRS_RATE_LIMITED_try_later: 'عدد كبير من الطلبات، حاول بعد قليل.',
      MRS_NOT_FOUND: 'لم نعثر على بيانات مطابقة. تحقّق من الرقم المرجعي ورمز التتبع.',
      MRS_FORBIDDEN: 'لا تملك صلاحية تنفيذ هذا الإجراء.',
      MRS_AUTH_REQUIRED: 'يلزم تسجيل الدخول أولًا.',
      MRS_MFA_REQUIRED: 'هذا الإجراء يتطلب التحقق بخطوتين. أكمل التحقق ثم حاول مرة أخرى.',
      MFA_INVALID_CODE: 'الرمز غير صحيح أو انتهت صلاحيته. أدخل الرمز الحالي من التطبيق.',
      MFA_AAL2_REQUIRED: 'أدخل رمز التحقق أولًا.',
      MRS_INTAKE_CLOSED: 'استقبال الطلبات متوقف مؤقتًا. تواصل معنا هاتفيًا.',
      MRS_BAD_TRANSITION: 'لا يمكن تغيير الحالة بهذا الشكل.',
      MRS_NOTE_REQUIRED: 'اكتب سبب الإجراء (مطلوب للتصحيح أو الرفض).',
      MRS_CONTAINERS_NOT_RETURNED: 'لا يمكن إنهاء المعاملة تشغيليًا قبل توثيق إرجاع كل الحاويات (المتبقي: {f}).',
      MRS_EVIDENCE_INVALID: 'إثبات الإرجاع يجب أن يكون «إيصال استلام فارغ» مؤكّدًا من الموظف ومرفوعًا على المعاملة نفسها.',
      MRS_APPEND_ONLY: 'هذا السجل لا يقبل التعديل أو الحذف؛ أضف تصحيحًا جديدًا بدلًا من ذلك.',
      MRS_IMMUTABLE: 'الحقل «{f}» لا يمكن تعديله مباشرة.',
      MRS_ALREADY_CONVERTED: 'تم تحويل هذا الطلب إلى معاملة من قبل.',
      MRS_BRANCH_REQUIRED: 'اختر الفرع قبل تحويل الطلب إلى معاملة.',
      MRS_BATCH_NOT_DRAFT: 'هذه الدفعة اعتُمدت أو أُلغيت ولا يمكن تعديلها.',
      MRS_DEMO_MODE: 'هذه الميزة تعمل في النسخة المتصلة فقط. الموقع الآن في وضع نسخة العرض التجريبية (بيانات محلية على جهازك).',
      MRS_NETWORK: 'تعذّر الاتصال بالخادم. تحقّق من اتصالك بالإنترنت ثم حاول مرة أخرى.',
      MRS_CONFIG: 'إعدادات الاتصال غير صحيحة. راجع ملف assets/js/config.js.',
      MRS_LOCAL_SAVE: 'تعذّر الحفظ على هذا الجهاز. فعّل التخزين المحلي ثم حاول مرة أخرى.',
      MRS_UPLOAD: 'تعذّر رفع الملف. حاول مرة أخرى.',
      MRS_FILE_TOO_LARGE: 'حجم الملف أكبر من 25 ميغابايت.',
      MRS_EXTRACTION_DUPLICATE: 'هذا الملف محفوظ من قبل في المستندات المقروءة (للمعاملة نفسها). افتحه من «السجل» بدلًا من حفظه مرة أخرى.',
      MRS_EXTRACTION_VOIDED: 'هذا السجل مُلغى ولا يمكن تعديله.',
      MRS_EXTRACTION_ATTACHED: 'ربط السجل بمعاملة أو بمستند لا يمكن تغييره بعد تعيينه.',
      // AI document reading (20261114000100)
      MRS_AI_DISABLED: 'القراءة بالذكاء الاصطناعي غير مفعّلة لهذه المؤسسة. يفعّلها مدير المؤسسة من «المؤسسة» في لوحة الموظفين.',
      MRS_AI_DAILY_CAP: 'وصلت المؤسسة إلى الحد اليومي للقراءة بالذكاء الاصطناعي. حاول غدًا أو اطلب من مدير المؤسسة رفع الحد.',
      MRS_AI_BUDGET: 'بلغت تكلفة القراءة بالذكاء الاصطناعي ميزانية هذا الشهر. اطلب من مدير المؤسسة رفع الميزانية.',
      MRS_AI_REFUSED: 'رفض نموذج الذكاء الاصطناعي قراءة هذا المستند. استخدم القراءة داخل المتصفح (Tesseract) بدلًا منه.',
      MRS_AI_TRUNCATED: 'المستند أطول من أن يُقرأ كاملًا في طلب واحد. قسّم ملف PDF أو ارفع الصفحات المهمة فقط.',
      MRS_AI_TOO_LARGE: 'الملف أكبر من حد القراءة بالذكاء الاصطناعي: 5 ميغابايت للصورة و10 ميغابايت لملف PDF.',
      MRS_AI_UNSUPPORTED: 'صيغة الملف غير مدعومة للقراءة بالذكاء الاصطناعي. استخدم JPG أو PNG أو WEBP أو GIF أو PDF.',
      MRS_AI_UNAVAILABLE: 'خدمة القراءة بالذكاء الاصطناعي غير متاحة الآن. حاول لاحقًا أو استخدم القراءة داخل المتصفح.',
      MRS_AI_FAILED: 'تعذّرت القراءة بالذكاء الاصطناعي. حاول مرة أخرى أو استخدم القراءة داخل المتصفح.',
      // document matching (20261116000100): invoice ↔ B/L ↔ customs declaration
      MRS_MATCH_DOC_KIND: 'المستند المحفوظ في خانة «{f}» ليس من النوع المطلوب (فاتورة تجارية، بوليصة شحن، بيان جمركي). تحقّق من نوع المستند ثم أعد القراءة.',
      MRS_MATCH_DOC_VOIDED: 'قراءة «{f}» مُلغاة، فلا يمكن حفظ المطابقة عليها. اقرأ المستند من جديد ثم احفظ.',
      MRS_MATCH_VOIDED: 'هذه المطابقة مُلغاة ولا يمكن مراجعتها أو تعديلها.',
      MRS_IDEMPOTENCY_CONFLICT: 'تعارض في إعادة الإرسال: استُخدم مفتاح العملية نفسه لبيانات مختلفة أو انتهت صلاحيته. أعد تحميل الصفحة وحاول مرة أخرى.',
      MRS_IN_PROGRESS: 'العملية نفسها قيد التنفيذ الآن. انتظر لحظات ثم تحقّق من النتيجة قبل إعادة المحاولة.',
      MRS_UNKNOWN_RESULT: 'لم نتمكّن من تأكيد نتيجة العملية بسبب انقطاع الاتصال. إعادة المحاولة آمنة ولن تُنشئ نسخة مكرّرة.',
      MRS_TIMEOUT: 'استغرق الخادم وقتًا أطول من المعتاد. حاول مرة أخرى.',
      MRS_DOCS_MISSING: 'لا يمكن الانتقال إلى هذه المرحلة قبل استكمال المستندات المطلوبة لها ({f}). ارفعها وصنّفها، أو تجاوز القاعدة بصلاحية مدير مع ذكر السبب.',
      // legacy step 2 (20261118000100)
      MRS_DUPLICATE_TX: 'توجد معاملة مسجلة مسبقًا بنفس رقم البوليصة ونفس الوحدة (حاوية أو شاسيه). افتح المعاملة الموجودة بدلًا من تكرارها.',
      MRS_DUPLICATE_APPOINTMENT: 'يوجد موعد مطابق مسجل مسبقًا لنفس الحاوية ورقم الموعد وتاريخ/وقت الموعد.',
      cdetail_MRS_DUPLICATE_TX_container: 'توجد معاملة مسجلة مسبقًا بنفس رقم البوليصة وإحدى الحاويات.',
      cdetail_MRS_DUPLICATE_TX_chassis: 'توجد معاملة Ro-Ro مسجلة مسبقًا بنفس رقم البوليصة ورقم الشاسيه.',
      // legacy step 3 (20261119000100): shipment document batches
      MRS_DOC_WRONG_SLOT: 'المستند مرفوع في الخانة الخطأ: محتواه لا يطابق نوع الخانة ({f}). اختر الخانة الصحيحة ثم أعد القراءة.',
      MRS_DOC_IN_OTHER_BATCH: 'هذا المستند المقروء مضاف إلى حزمة مستندات أخرى مفتوحة أو معتمدة. افتح تلك الحزمة أو أزله منها أولًا.',
      MRS_DOC_BATCH_STATE: 'حالة حزمة المستندات لا تسمح بهذا الإجراء ({f}). المعتمدة لا تُعدَّل ولا تُحذف، والمتجاهلة أو المؤرشفة لا تُعتمد.',
      MRS_DOC_BATCH_STALE: 'عدّل شخص آخر هذه المسودة بعد فتحك لها. أعد تحميلها ثم راجع التغييرات قبل الحفظ أو الاعتماد.',
      MRS_CLIENT_ALIAS_CONFLICT: 'هذا الاسم معتمد مسبقًا كاسم بديل لعميل آخر. اختر ذلك العميل، أو راجع الأسماء البديلة في دليل العملاء.',
      // legacy step 4 (20261120000100): customs declaration approval
      MRS_DECL_STALE: 'تغيّرت المعاملة أو قراءة البيان بعد فتحك للمراجعة. أعد تحميل المراجعة ثم تحقق من القيم قبل الاعتماد.',
      MRS_DECL_BL_MISMATCH: 'رقم البوليصة في البيان لا يطابق بوليصة المعاملة. راجع الرقم، أو أكد صراحةً أن البيان يخص هذه المعاملة (يبقى رقم البوليصة الأصلي دون تغيير).',
      MRS_DECL_NUMBER_CONFLICT: 'للمعاملة بيان جمركي نشط برقم آخر. ألغِ البيان الحالي أو استبدله أولًا ثم اعتمد القراءة.',
      MRS_DECL_ALREADY_APPROVED: 'اعتُمدت قراءة البيان هذه من قبل. لتعديل البيان استخدم «تصحيح البيان» في المعاملة.',
      // legacy step 5 (20261121000100): appointment card drafts, empty-return proofs, TASTO carrier order
      MRS_APPT_DRAFT_EXISTS: 'للمعاملة مسودة بطاقات مواعيد مفتوحة. افتحها واستكملها بدل إنشاء مسودة جديدة (لا حاجة لإعادة القراءة).',
      MRS_APPT_DRAFT_CLOSED: 'مسودة المواعيد مغلقة ({f}) ولا تقبل التعديل أو الاعتماد.',
      MRS_APPT_DRAFT_APPROVED: 'اعتُمدت بطاقات من هذه المسودة، فلا يمكن إلغاؤها أو نقلها إلى معاملة أخرى.',
      MRS_APPT_DRAFT_STALE: 'عدّل شخص آخر مسودة المواعيد بعد فتحك لها. أعد تحميلها ثم راجع التعديلات.',
      MRS_APPT_DRAFT_LIMIT: 'تجاوزت حد المسودة ({f}): 20 بطاقة و25 ميغابايت لكل معاملة كحد أقصى.',
      MRS_APPT_CARD_DUPLICATE: 'بطاقة الموعد هذه مقروءة من قبل ({f}): معتمدة في حركة قائمة، أو بانتظار الاعتماد في مسودة معاملة أخرى (يمكن نقل تلك المسودة إلى هنا).',
      MRS_APPT_CONTAINER_NOT_IN_TX: 'رقم الحاوية في البطاقة ليس من حاويات هذه المعاملة ({f}). اختر حاوية المعاملة أو أضفها قبل الاعتماد.',
      MRS_APPT_PARTY_REQUIRED: 'حدد جهة النقل للبطاقة (مورد أو شركة نقل أو مباشر) واسمها قبل الاعتماد.',
      MRS_DATETIME_REQUIRED: 'أدخل التاريخ والوقت معًا ({f}): التاريخ وحده لا يكفي.',
      MRS_EMPTY_RETURN_CLOSED: 'إثبات إعادة الفارغ هذا مغلق ({f}): المعتمد لا يُعتمد مرة أخرى، والملغى لا يُعدَّل.',
      MRS_EMPTY_RETURN_LOCKED: 'لا يمكن إلغاء آخر إثبات إعادة للحاوية بعد انتهاء المعاملة تشغيليًا ({f}). صحّح المرحلة أولًا.',
      MRS_EMPTY_RETURN_FILE: 'ملف إثبات إعادة الفارغ غير مقبول ({f}): صورة أو PDF بحد أقصى 8 ميغابايت.',
      MRS_TASTO_INVALID: 'رقم أمر النقل يجب أن يبدأ بـ TASTO ثم أرقام فقط، مثل TASTO2026111000001.',
      MRS_TASTO_TAKEN: 'رقم أمر النقل مسجل مسبقًا في معاملة أخرى ({f}).',
      MRS_TASTO_STAGE: 'لا يمكن تسجيل أمر نقل لشركة قبل انتهاء المعاملة جمركيًا (المرحلة الحالية: {f}).',
      MRS_AI_WRONG_DOCUMENT: 'المستند المرفوع ليس من النوع المطلوب ({f}). إن كان فاتورة موعد فارفع بطاقة الموعد نفسها، وإن كان غير إيصال إعادة الفارغ فارفع الإيصال.',
      // legacy step 6 (20261122000100): the payment register and the client custody
      MRS_OVERPAID: 'المبلغ يتجاوز المتبقي من إجمالي الفاتورة (المتبقي: {f}).',
      MRS_PAY_REF_TAKEN: 'المرجع ({f}) مسجل سابقًا في سداد آخر ({x}). راجع السداد السابق قبل المتابعة.',
      MRS_PAY_REF_METHOD: 'الحقل ({f}) لا يخص طريقة السداد المختارة. امسحه أو غيّر طريقة السداد.',
      MRS_PAY_REFERENCE: 'صيغة ({f}) غير صحيحة: رقم السداد أرقام فقط، والمرجع البنكي حروف إنجليزية وأرقام وشرطة بين الأجزاء، ورقم الإيصال حتى 100 حرف.',
      MRS_PAY_FUNDING: 'مصدر التمويل لا يتوافق مع طريقة السداد ({f}).',
      MRS_PAY_ALLOCATION: 'توزيع السداد غير صحيح ({f}).',
      MRS_PAY_DOCUMENT: 'مرفقات السداد غير مقبولة ({f}).',
      MRS_PAY_INVOICE_TAKEN: 'الفاتورة نفسها من الجهة نفسها مسجلة في سداد آخر ({x}). لا يمكن حفظ الفاتورة مرتين.',
      MRS_CONFIRM_INVOICE_REUSE: 'رقم الفاتورة مستخدم سابقًا لجهة أخرى ({x}). إن كانت هذه الفاتورة صادرة فعلًا من جهة مختلفة فأكّد المتابعة.',
      MRS_PAY_LOCKED: 'لا يمكن إلغاء هذا السداد أو تعديله ({f}).',
      MRS_CUSTODY_NEGATIVE: 'لا يمكن أن يصبح رصيد عهدة العميل سالبًا. الرصيد الحالي {x} ريال.',
      MRS_CUSTODY_LINK: 'ربط حركة العهدة غير صحيح ({f}).',
      // legacy step 7 (20261123000100): Daftra alignment
      MRS_DAFTRA_ACCOUNT_NOT_KSA: 'حساب دفترة ليس حسابًا سعوديًا ({f}): يجب أن تكون العملة الريال السعودي والدولة السعودية وضريبة 15 % مفعّلة. لم يُرسل شيء؛ يحوّل المالك الحساب ثم يعيد فحص الاتصال.',
      MRS_DAFTRA_UNMAPPED: 'بنود خدمة بلا كود صنف دفترة معتمد: {x}. اضبط كود الصنف وطابقه وأكّده في «إعداد دفترة» (مرسى لا ينشئ أصنافًا في دفترة).',
      MRS_DAFTRA_CUSTOM_REQUIRED: 'حقول دفترة الإضافية المطلوبة ناقصة في المعاملة: {x}. أكمل البيانات ثم أعد المحاولة؛ لم يُرسل شيء.',
      MRS_DAFTRA_DRAFT_LOCKED: 'مسودة دفترة لهذه الفاتورة موجودة، وتعديل المسودات القائمة غير مسموح. نفّذ التغييرات يدويًا في دفترة كما في بند «تعديل يدوي مطلوب»، ثم أكّد التنفيذ.',
      MRS_DAFTRA_CLIENT_CONFLICT: 'عميل فاتورة دفترة يختلف عن عميل المعاملة المربوط بدفترة؛ الربط مرفوض.',
      MRS_DAFTRA_PURCHASE_DISABLED: 'مسودات فواتير المشتريات للنقلات غير مفعّلة لهذه المؤسسة.',
      MRS_DAFTRA_CONFIRM_MISMATCH: 'رقم الفاتورة المُدخل للتأكيد لا يطابق رقم فاتورة دفترة المعروضة. تحقق من الرقم ثم أعد الإدخال.',
      MRS_DAFTRA_IMPORT: 'بيانات الاستيراد غير مقبولة ({f}).',
      cdetail_MRS_FORBIDDEN_owner_only: 'هذا الإجراء للمالك فقط (مدير النظام على مستوى المؤسسة بجلسة مؤكدة).',
      cdetail_MRS_BAD_TRANSITION_daftra_invoice_issued: 'للمعاملة فاتورة صادرة (معتمدة) في دفترة؛ لا يمكن إلغاء المعاملة.',
      cdetail_MRS_BAD_TRANSITION_daftra_sync_in_flight: 'مزامنة دفترة قيد التنفيذ أو نتيجتها غير مؤكدة لهذه المعاملة؛ انتظر اكتمالها ثم أعد المحاولة.',
      cdetail_MRS_BAD_TRANSITION_daftra_purchase: 'لإحدى نقلات المعاملة مسودة مشتريات في دفترة؛ لا يمكن إلغاء المعاملة.',
      cdetail_MRS_BAD_TRANSITION_opening_disabled: 'فتح مسودة دفترة عند اعتماد البيان غير مفعّل لهذه المؤسسة.',
      cdetail_MRS_BAD_TRANSITION_review_required: 'وُجدت أكثر من فاتورة مطابقة؛ اختر الفاتورة الصحيحة صراحة مع ملاحظة.',
      cdetail_MRS_BAD_TRANSITION_client_inactive: 'العميل غير نشط؛ لا تُنشأ له مسودة في دفترة.',
      cdetail_MRS_BAD_TRANSITION_party_type: 'مسودة المشتريات لنقلة جهة نقلها مورد أو شركة نقل فقط.',
      cdetail_MRS_BAD_TRANSITION_trip_cancelled: 'النقلة ملغاة.',
      cdetail_MRS_BAD_TRANSITION_partial: 'هذه فاتورة بتطابق جزئي للاطلاع فقط؛ تحقق منها ثم اربطها بالبحث بالرقم.',
      cdetail_MRS_REQUIRED_supplier_link: 'جهة النقل غير مربوطة بمورد في دفترة. ابحث عنها في موردي دفترة أولًا.',
      cdetail_MRS_REQUIRED_cost_accruals: 'لا توجد تكلفة مسجلة للنقلة.',
      cdetail_MRS_REQUIRED_remote_product_code: 'اضبط كود صنف دفترة للبند أولًا.',
      cdetail_MRS_REQUIRED_client_link: 'اربط عميل المعاملة بعميل دفترة أولًا.',
      cdetail_MRS_INVALID_not_a_candidate: 'الصنف المختار ليس من نتائج المطابقة الأخيرة. أعد المطابقة.',
      cdetail_MRS_INVALID_code_mismatch: 'كود الصنف في دفترة ({x}) لا يطابق الكود المضبوط.',
      cdetail_MRS_INVALID_code_taken: 'كود الصنف مضبوط لبند آخر ({x}).',
      cdetail_MRS_INVALID_field_key_taken: 'مفتاح الحقل الإضافي ({x}) مستخدم لحقل آخر.',
      cdetail_MRS_INVALID_draft_update_disabled: 'رفض النظام نتيجة مزامنة عدّلت مسودة دفترة قائمة؛ التعديل غير مسموح.',
      cdetail_MRS_INVALID_product_create_disabled: 'رفض النظام نتيجة مزامنة أنشأت صنفًا في دفترة؛ الإنشاء غير مسموح.',
      cdetail_MRS_DAFTRA_IMPORT_empty: 'الملف لا يحتوي صفوفًا.',
      cdetail_MRS_DAFTRA_IMPORT_too_many_rows: 'الحد الأقصى 2000 صف في الاستيراد الواحد.',
      cdetail_MRS_DAFTRA_ACCOUNT_NOT_KSA_not_checked: 'لم يُفحص حساب دفترة بعد. شغّل «فحص الاتصال» أولًا.',
      cdetail_MRS_PAY_FUNDING_fasah_wallet_source: 'طريقة السداد «محفظة فسح» تتطلب أن يكون مصدر التمويل «محفظة فسح».',
      cdetail_MRS_PAY_FUNDING_fasah_wallet_method: 'عند اختيار «محفظة فسح» مصدرًا للتمويل يجب أن تكون طريقة السداد «محفظة فسح».',
      cdetail_MRS_PAY_FUNDING_cash_box_method: 'عند اختيار «الصندوق / النقدية» مصدرًا للتمويل يجب أن تكون طريقة السداد «نقدي».',
      cdetail_MRS_PAY_FUNDING_dry_port_wallet_source: 'طريقة السداد «محفظة الميناء الجاف» تتطلب مصدر تمويل خاصًا بمحفظة الميناء الجاف.',
      cdetail_MRS_PAY_FUNDING_dry_port_wallet_method: 'مصدر تمويل محفظة الميناء الجاف يجب أن يستخدم طريقة السداد «محفظة الميناء الجاف».',
      cdetail_MRS_PAY_FUNDING_payer_name: 'أدخل اسم الشخص الذي سدد من حسابه الشخصي.',
      cdetail_MRS_PAY_FUNDING_paying_account: 'أدخل البنك / الحساب المسدد منه لهذه العملية (سداد، مدى، تحويل بنكي).',
      cdetail_MRS_PAY_FUNDING_wallet_no_account: 'لا تسجل بنكًا على السداد من المحفظة؛ البنك يُسجل في حركة تغذية المحفظة المنفصلة.',
      cdetail_MRS_PAY_LOCKED_daftra: 'هذا السداد مرتبط بدفترة، فلا يُلغى ولا يُعدَّل من مرسى.',
      cdetail_MRS_PAY_LOCKED_invoiced: 'المبلغ المسترد من هذا السداد مفوتر على العميل، فلا يُلغى السداد ولا يُعدَّل.',
      cdetail_MRS_PAY_LOCKED_custody: 'هذا السداد مخصوم من عهدة العميل. ألغِ حركة الخصم أولًا.',
      cdetail_MRS_PAY_ALLOCATION_sum: 'مجموع التوزيعات يجب أن يساوي إجمالي السداد (الفرق: {x} ريال).',
      cdetail_MRS_CUSTODY_LINK_exceeds_payment: 'مبلغ الخصم أكبر من مبلغ السداد المرتبط بهذه المعاملة. الحد الأعلى {x} ريال.',
      cdetail_MRS_PAY_FUNDING_funding_source: 'حدد مصدر تمويل السداد الفعلي.',
      cdetail_MRS_PAY_FUNDING_payment_method: 'اختر طريقة سداد صحيحة.',
      cdetail_MRS_PAY_ALLOCATION_count: 'السداد المشترك يحتاج توزيعين على الأقل، والفردي توزيعًا واحدًا.',
      cdetail_MRS_PAY_ALLOCATION_amount: 'المبلغ المخصص في كل توزيع يجب أن يكون أكبر من صفر.',
      cdetail_MRS_PAY_ALLOCATION_duplicate: 'لا يمكن تكرار المعاملة ورقم الفاتورة نفسيهما داخل السداد المشترك.',
      cdetail_MRS_PAY_ALLOCATION_branch: 'معاملات السداد الواحد يجب أن تكون من الفرع نفسه.',
      cdetail_MRS_PAY_ALLOCATION_client: 'هذا النوع من السداد يخص عميلًا واحدًا: اختر معاملات العميل نفسه.',
      cdetail_MRS_PAY_ALLOCATION_not_allowed: 'السداد الفردي لا يقبل توزيعات، والمشترك تُحدَّد معاملاته وفواتيره في التوزيعات فقط.',
      cdetail_MRS_PAY_DOCUMENT_count: 'يمكن إضافة 8 مرفقات كحد أقصى في عملية حفظ واحدة.',
      cdetail_MRS_PAY_DOCUMENT_size: 'حجم المرفق «{x}» يتجاوز 4 ميغابايت.',
      cdetail_MRS_PAY_DOCUMENT_total: 'إجمالي المرفقات الجديدة يتجاوز 12 ميغابايت. قسّم الرفع على عمليتي حفظ.',
      cdetail_MRS_PAY_DOCUMENT_type: 'المرفق «{x}» يجب أن يكون PDF أو صورة.',
      cdetail_MRS_PAY_DOCUMENT_branch: 'المرفق مسجل لفرع آخر غير فرع السداد.',
      cdetail_MRS_PAY_DOCUMENT_in_use: 'المرفق «{x}» مرتبط بسداد آخر.',
      cdetail_MRS_PAY_DOCUMENT_allocation: 'اربط كل فاتورة في السداد المشترك بالتوزيع الخاص بها، ولا تربط مرفقًا بتوزيع في السداد الفردي.',
      cdetail_MRS_PAY_DOCUMENT_role: 'نوع المرفق غير صحيح (فاتورة الجهة، إثبات السداد، مرفق إضافي).',
      cdetail_MRS_CUSTODY_LINK_transaction_required: 'خصم العهدة يجب أن يكون مرتبطًا بمعاملة.',
      cdetail_MRS_CUSTODY_LINK_payment_required: 'خصم العهدة يجب أن يكون مرتبطًا بسداد محفوظ.',
      cdetail_MRS_CUSTODY_LINK_client_mismatch: 'المعاملة المختارة لا تخص العميل المحدد في العهدة.',
      cdetail_MRS_CUSTODY_LINK_payment_not_in_transaction: 'السداد المختار غير مرتبط بالمعاملة المحددة.',
      cdetail_MRS_CUSTODY_LINK_duplicate_deduction: 'هذا السداد خُصم مسبقًا من عهدة العميل لهذه المعاملة.',
      cdetail_MRS_CUSTODY_LINK_payment_void: 'السداد المختار ملغى.',
      cdetail_MRS_CUSTODY_NEGATIVE_void_deposit: 'لا يمكن إلغاء هذا الإيداع لأن رصيد العهدة سيصبح سالبًا (الرصيد الحالي {x} ريال). ألغِ حركات الخصم أو الإرجاع التي استخدمته أولًا.',
      cdetail_MRS_CUSTODY_NEGATIVE_deduction: 'رصيد عهدة العميل لا يكفي لهذا الخصم (الرصيد الحالي {x} ريال). الرصيد لا يصبح سالبًا أبدًا.',
      cdetail_MRS_CUSTODY_NEGATIVE_refund: 'رصيد عهدة العميل لا يكفي لهذا الإرجاع (الرصيد الحالي {x} ريال). الرصيد لا يصبح سالبًا أبدًا.',
      cdetail_MRS_PAY_INVOICE_TAKEN_internal_invoice_no: 'الرقم الداخلي للفاتورة ({x}) مستخدم في فاتورة أو سداد آخر.',
      cdetail_MRS_INVALID_claim_no_fp: 'رسوم المواعيد: رقم المطالبة هو الرقم المرجعي (Reference No) في فاتورة فسح، وليس الرقم الداخلي FP…. ضع رقم FP في حقل الرقم الداخلي.',
      cdetail_MRS_INVALID_internal_invoice_mismatch: 'هذه الفاتورة مسجلة سابقًا برقم داخلي آخر ({x}). صحّح الرقم الداخلي أو اتركه فارغًا.',
      cdetail_MRS_BAD_TRANSITION_approved_documents: 'هذا السداد معتمد، فلا تُضاف مرفقاته ولا تُحذف. لتغيير المستندات صحّح السداد ليعود إلى المراجعة.',
      cdetail_MRS_AI_WRONG_DOCUMENT_not_payment_proof: 'المستند ليس إثبات سداد (يبدو فاتورة أو مستندًا آخر). ارفعه في خانة فاتورة الجهة أو اختر إثبات السداد.',
      cdetail_MRS_AI_WRONG_DOCUMENT_not_entity_invoice: 'المستند ليس فاتورة جهة (يبدو إثبات سداد أو مستندًا آخر). ارفعه في خانة إثبات السداد أو اختر الفاتورة.',
      cdetail_MRS_NOT_FOUND_doc_batch: 'حزمة المستندات غير موجودة أو لا تملك صلاحية عرضها (المسودات مفصولة حسب الفرع).',
      cdetail_MRS_INVALID_slot_full: 'الخانة ممتلئة: بوليصة واحدة وبيان جمركي واحد، وحتى 10 فواتير و10 بيانات تعبئة.',
      cdetail_MRS_INVALID_duplicate_file: 'الملف نفسه مضاف إلى هذه الحزمة من قبل.',
      cdetail_MRS_INVALID_containers_roro: 'معاملة Ro-Ro لا تقبل حاويات. احذف الحاويات من المسودة أو اختر معاملة حاويات.',
      cdetail_MRS_REQUIRED_documents: 'أضف مستندًا مقروءًا واحدًا على الأقل إلى الحزمة قبل الاعتماد.',
      cdetail_MRS_REQUIRED_client_id: 'اختر العميل (المستورد) قبل إنشاء معاملة جديدة من المسودة.',
      cdetail_MRS_BAD_TRANSITION_cancelled: 'هذا السجل ملغى ولا يقبل التعديل.',
      cdetail_MRS_FORBIDDEN_cost: 'قيمة النقل وعائد المؤسسة متاحان لصلاحيات المالية ومدير العمليات فقط.',
      cdetail_MRS_BAD_TRANSITION_delivered: 'تم النقل لهذه الحركة؛ لا تُعدَّل بياناتها التشغيلية ولا تُلغى.',
      cdetail_MRS_BAD_TRANSITION_same_status: 'المعاملة في هذه المرحلة بالفعل (ربما تقدّمت تلقائيًا). حدّث الصفحة.',
      MRS_EXPIRED: 'انتهت صلاحية هذا الرابط أو الدعوة. اطلب رابطًا جديدًا.',
      MRS_EMAIL_MISMATCH: 'هذه الدعوة مرسلة إلى بريد إلكتروني آخر. سجّل الدخول بالبريد الذي وصلته الدعوة.',
      MRS_EMAIL_UNCONFIRMED: 'يلزم تأكيد بريدك الإلكتروني أولًا من الرسالة المرسلة إليك، ثم أعد فتح رابط الدعوة.',
      DUPLICATE: 'هذا السجل موجود من قبل (تكرار). إن كان ملفًا فقد رُفع سابقًا.',
      FK: 'مرجع غير صالح أو لا يخص مؤسستك.',
      CHECK: 'بعض القيم غير صحيحة.',
      RLS: 'لا تملك صلاحية تنفيذ هذا الإجراء.',
      AUTH_INVALID: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
      AUTH_UNCONFIRMED: 'يلزم تأكيد البريد الإلكتروني أولًا من الرسالة المرسلة إليك.',
      AUTH_EXISTS: 'هذا البريد الإلكتروني مسجّل من قبل.',
      AUTH_WEAK: 'كلمة المرور ضعيفة. استخدم 8 أحرف على الأقل تجمع حروفًا وأرقامًا.',
      AUTH_RATE: 'محاولات كثيرة. انتظر قليلًا ثم حاول مرة أخرى.',
      UNKNOWN: 'حدث خطأ غير متوقع. حاول مرة أخرى.'
    },
    en: {
      MRS_INVALID: 'Invalid value in the “{f}” field.',
      MRS_REQUIRED: 'The “{f}” field is required.',
      MRS_TOO_LONG: 'The text in the “{f}” field is too long.',
      MRS_RATE_LIMITED: 'We received many requests in a short time. Please try again in an hour.',
      cdetail_MRS_RATE_LIMITED_try_later: 'Too many requests. Please try again shortly.',
      MRS_NOT_FOUND: 'No matching data found. Check the reference number and tracking code.',
      MRS_FORBIDDEN: 'You do not have permission to perform this action.',
      MRS_AUTH_REQUIRED: 'Please sign in first.',
      MRS_MFA_REQUIRED: 'This action requires two-step verification. Complete it and try again.',
      MFA_INVALID_CODE: 'The code is wrong or expired. Enter the current code from the app.',
      MFA_AAL2_REQUIRED: 'Enter a verification code first.',
      MRS_INTAKE_CLOSED: 'New requests are temporarily paused. Please contact us by phone.',
      MRS_BAD_TRANSITION: 'The status cannot be changed this way.',
      MRS_NOTE_REQUIRED: 'Enter the reason for this action (required for corrections and rejections).',
      MRS_CONTAINERS_NOT_RETURNED: 'The transaction cannot be closed operationally until every container return is recorded (remaining: {f}).',
      MRS_EVIDENCE_INVALID: 'Return evidence must be an “empty container receipt” confirmed by staff and uploaded to the same transaction.',
      MRS_APPEND_ONLY: 'This record cannot be edited or deleted; add a new correction instead.',
      MRS_IMMUTABLE: 'The “{f}” field cannot be changed directly.',
      MRS_ALREADY_CONVERTED: 'This request has already been converted to a transaction.',
      MRS_BRANCH_REQUIRED: 'Choose a branch before converting the request to a transaction.',
      MRS_BATCH_NOT_DRAFT: 'This batch has been approved or cancelled and can no longer be edited.',
      MRS_DEMO_MODE: 'This feature works in the connected version only. The site is in demo mode (local data on your device).',
      MRS_NETWORK: 'Could not reach the server. Check your internet connection and try again.',
      MRS_CONFIG: 'The connection settings are invalid. Check assets/js/config.js.',
      MRS_LOCAL_SAVE: 'Could not save on this device. Enable local storage and try again.',
      MRS_UPLOAD: 'The file could not be uploaded. Please try again.',
      MRS_FILE_TOO_LARGE: 'The file is larger than 25 MB.',
      MRS_EXTRACTION_DUPLICATE: 'This file is already saved in the read documents (for the same transaction). Open it from “History” instead of saving it again.',
      MRS_EXTRACTION_VOIDED: 'This record is void and cannot be edited.',
      MRS_EXTRACTION_ATTACHED: 'The link to a transaction or document cannot be changed once set.',
      // AI document reading (20261114000100)
      MRS_AI_DISABLED: 'AI reading is not enabled for this organization. An organization admin enables it under “Organization” in the staff dashboard.',
      MRS_AI_DAILY_CAP: 'The organization reached today\'s AI reading limit. Try tomorrow or ask an organization admin to raise it.',
      MRS_AI_BUDGET: 'AI reading reached this month\'s budget. Ask an organization admin to raise it.',
      MRS_AI_REFUSED: 'The AI model declined to read this document. Use in-browser reading (Tesseract) instead.',
      MRS_AI_TRUNCATED: 'The document is too long to read in one request. Split the PDF or upload the important pages only.',
      MRS_AI_TOO_LARGE: 'The file is over the AI reading limit: 5 MB for an image, 10 MB for a PDF.',
      MRS_AI_UNSUPPORTED: 'This file type is not supported for AI reading. Use JPG, PNG, WEBP, GIF or PDF.',
      MRS_AI_UNAVAILABLE: 'The AI reading service is not available right now. Try later or use in-browser reading.',
      MRS_AI_FAILED: 'AI reading failed. Try again or use in-browser reading.',
      // document matching (20261116000100)
      MRS_MATCH_DOC_KIND: 'The document saved as “{f}” is not of the expected type (commercial invoice, bill of lading, customs declaration). Check the document type and read it again.',
      MRS_MATCH_DOC_VOIDED: 'The “{f}” reading is void, so the match cannot be saved on it. Read the document again, then save.',
      MRS_MATCH_VOIDED: 'This match is void and cannot be reviewed or changed.',
      MRS_IDEMPOTENCY_CONFLICT: 'Resubmission conflict: the same operation key was used for different data or has expired. Reload the page and try again.',
      MRS_IN_PROGRESS: 'The same operation is in progress right now. Wait a moment and check the result before retrying.',
      MRS_UNKNOWN_RESULT: 'We could not confirm the result because the connection dropped. Retrying is safe and will not create a duplicate.',
      MRS_TIMEOUT: 'The server took longer than usual to answer. Please try again.',
      MRS_DOCS_MISSING: 'This stage needs its required documents first ({f}). Upload and classify them, or a manager may override the rule with a reason.',
      // legacy step 2 (20261118000100)
      MRS_DUPLICATE_TX: 'A transaction with the same B/L number and the same unit (container or chassis) already exists. Open it instead of creating a duplicate.',
      MRS_DUPLICATE_APPOINTMENT: 'A matching appointment already exists for the same container, appointment number and date/time.',
      cdetail_MRS_DUPLICATE_TX_container: 'A transaction with the same B/L number and one of these containers already exists.',
      cdetail_MRS_DUPLICATE_TX_chassis: 'A Ro-Ro transaction with the same B/L number and chassis number already exists.',
      // legacy step 3 (20261119000100): shipment document batches
      MRS_DOC_WRONG_SLOT: 'The document is in the wrong slot: its content does not match the slot type ({f}). Choose the right slot and read it again.',
      MRS_DOC_IN_OTHER_BATCH: 'This reading already belongs to another open or approved document batch. Open that batch or remove it there first.',
      MRS_DOC_BATCH_STATE: 'The document batch status does not allow this action ({f}). An approved batch cannot be changed or deleted; a discarded or archived one cannot be approved.',
      MRS_DOC_BATCH_STALE: 'Someone else changed this draft after you opened it. Reload it and review the changes before saving or approving.',
      MRS_CLIENT_ALIAS_CONFLICT: 'This name is already an approved alias of another client. Choose that client, or review the aliases in the client directory.',
      // legacy step 4 (20261120000100): customs declaration approval
      MRS_DECL_STALE: 'The transaction or the declaration reading changed after you opened the review. Reload the review and check the values before approving.',
      MRS_DECL_BL_MISMATCH: 'The B/L number on the declaration does not match the transaction B/L. Check it, or confirm explicitly that the declaration belongs to this transaction (the original B/L stays unchanged).',
      MRS_DECL_NUMBER_CONFLICT: 'The transaction already has an active customs declaration with another number. Cancel or replace it first, then approve the reading.',
      MRS_DECL_ALREADY_APPROVED: 'This declaration reading was approved before. To change the declaration use “Correct declaration” on the transaction.',
      // legacy step 5 (20261121000100): appointment card drafts, empty-return proofs, TASTO carrier order
      MRS_APPT_DRAFT_EXISTS: 'The transaction already has an open appointment-card draft. Open and finish it instead of creating a new one (no new read needed).',
      MRS_APPT_DRAFT_CLOSED: 'The appointment draft is closed ({f}) and cannot be changed or approved.',
      MRS_APPT_DRAFT_APPROVED: 'Cards of this draft were approved, so it cannot be cancelled or moved to another transaction.',
      MRS_APPT_DRAFT_STALE: 'Someone else changed the appointment draft after you opened it. Reload it and review the changes.',
      MRS_APPT_DRAFT_LIMIT: 'The draft limit was exceeded ({f}): at most 20 cards and 25 MB per transaction.',
      MRS_APPT_CARD_DUPLICATE: 'This appointment card was read before ({f}): approved in an existing movement, or pending in another transaction\'s draft (that draft can be moved here).',
      MRS_APPT_CONTAINER_NOT_IN_TX: 'The container on the card is not one of this transaction\'s containers ({f}). Choose the transaction\'s container or add it before approving.',
      MRS_APPT_PARTY_REQUIRED: 'Set the transport party of the card (supplier, transport company or direct) and its name before approving.',
      MRS_DATETIME_REQUIRED: 'Enter the date and the time ({f}): a date alone is not enough.',
      MRS_EMPTY_RETURN_CLOSED: 'This empty-return proof is closed ({f}): an approved proof is not approved again and a voided one cannot be changed.',
      MRS_EMPTY_RETURN_LOCKED: 'The last return proof of the container cannot be voided once the transaction is operationally complete ({f}). Correct the stage first.',
      MRS_EMPTY_RETURN_FILE: 'The empty-return proof file is not accepted ({f}): an image or PDF of at most 8 MB.',
      MRS_TASTO_INVALID: 'The transport order number must start with TASTO followed by digits only, e.g. TASTO2026111000001.',
      MRS_TASTO_TAKEN: 'The transport order number is already recorded on another transaction ({f}).',
      MRS_TASTO_STAGE: 'A transport company order cannot be recorded before customs is done (current stage: {f}).',
      MRS_AI_WRONG_DOCUMENT: 'The uploaded document is not of the expected type ({f}). For an appointment invoice upload the appointment card itself; otherwise upload the empty-return receipt.',
      // legacy step 6 (20261122000100): the payment register and the client custody
      MRS_OVERPAID: 'The amount exceeds what is left of the invoice total (left: {f}).',
      MRS_PAY_REF_TAKEN: 'The reference ({f}) is already recorded on another payment ({x}). Review the earlier payment before continuing.',
      MRS_PAY_REF_METHOD: 'The field ({f}) does not belong to the chosen payment method. Clear it or change the method.',
      MRS_PAY_REFERENCE: 'The format of ({f}) is not valid: a SADAD number is digits only, a bank reference is Latin letters and digits with a dash between parts, a receipt is up to 100 characters.',
      MRS_PAY_FUNDING: 'The funding source does not fit the payment method ({f}).',
      MRS_PAY_ALLOCATION: 'The payment allocation is not valid ({f}).',
      MRS_PAY_DOCUMENT: 'The payment attachments are not accepted ({f}).',
      MRS_PAY_INVOICE_TAKEN: 'The same invoice of the same issuer is recorded on another payment ({x}). An invoice cannot be saved twice.',
      MRS_CONFIRM_INVOICE_REUSE: 'This invoice number was used before by another issuer ({x}). If this invoice really comes from a different issuer, confirm to continue.',
      MRS_PAY_LOCKED: 'This payment cannot be voided or corrected ({f}).',
      MRS_CUSTODY_NEGATIVE: 'The client custody balance can never be negative. Current balance: {x} SAR.',
      MRS_CUSTODY_LINK: 'The custody entry link is not valid ({f}).',
      // legacy step 7 (20261123000100): Daftra alignment
      MRS_DAFTRA_ACCOUNT_NOT_KSA: 'The Daftra account is not a Saudi account ({f}): it must use SAR, Saudi Arabia and an active 15 % VAT. Nothing was sent; the owner switches the account, then re-runs the connection probe.',
      MRS_DAFTRA_UNMAPPED: 'Service items without a confirmed Daftra product code: {x}. Set the code, match it and confirm it in «Daftra settings» (Marsa never creates products in Daftra).',
      MRS_DAFTRA_CUSTOM_REQUIRED: 'Required Daftra custom fields are missing on the transaction: {x}. Complete the data and retry; nothing was sent.',
      MRS_DAFTRA_DRAFT_LOCKED: 'A Daftra draft already exists for this invoice and editing existing drafts is not allowed. Make the changes by hand in Daftra as listed in the «Change by hand» item, then confirm.',
      MRS_DAFTRA_CLIENT_CONFLICT: 'The Daftra invoice client differs from the linked Daftra client of the transaction; the link is refused.',
      MRS_DAFTRA_PURCHASE_DISABLED: 'Purchase invoice drafts per trip are not enabled for this organization.',
      MRS_DAFTRA_CONFIRM_MISMATCH: 'The invoice number typed to confirm does not match the Daftra invoice shown. Check the number and type it again.',
      MRS_DAFTRA_IMPORT: 'The import data is not accepted ({f}).',
      cdetail_MRS_FORBIDDEN_owner_only: 'This action is for the owner only (an organization-wide admin with a verified session).',
      cdetail_MRS_BAD_TRANSITION_daftra_invoice_issued: 'The transaction has an issued (approved) Daftra invoice; it cannot be cancelled.',
      cdetail_MRS_BAD_TRANSITION_daftra_sync_in_flight: 'A Daftra sync of this transaction is running or its result is unconfirmed; wait for it, then retry.',
      cdetail_MRS_BAD_TRANSITION_daftra_purchase: 'A trip of this transaction has a Daftra purchase draft; the transaction cannot be cancelled.',
      cdetail_MRS_BAD_TRANSITION_opening_disabled: 'Opening a Daftra draft at declaration approval is not enabled for this organization.',
      cdetail_MRS_BAD_TRANSITION_review_required: 'More than one matching invoice was found; choose the right one explicitly with a note.',
      cdetail_MRS_BAD_TRANSITION_client_inactive: 'The client is inactive; no Daftra draft is created for it.',
      cdetail_MRS_BAD_TRANSITION_party_type: 'A purchase draft is only for a trip carried by a supplier or a transport company.',
      cdetail_MRS_BAD_TRANSITION_trip_cancelled: 'The trip is cancelled.',
      cdetail_MRS_BAD_TRANSITION_partial: 'This invoice is a partial match, a hint only; check it, then link it through the number search.',
      cdetail_MRS_REQUIRED_supplier_link: 'The transport party is not linked to a Daftra supplier. Search the Daftra suppliers first.',
      cdetail_MRS_REQUIRED_cost_accruals: 'The trip has no recorded cost.',
      cdetail_MRS_REQUIRED_remote_product_code: 'Set the Daftra product code of the item first.',
      cdetail_MRS_REQUIRED_client_link: 'Link the transaction client to a Daftra client first.',
      cdetail_MRS_INVALID_not_a_candidate: 'The chosen product is not among the last match results. Run the match again.',
      cdetail_MRS_INVALID_code_mismatch: 'The Daftra product code ({x}) does not match the configured code.',
      cdetail_MRS_INVALID_code_taken: 'The product code is already set on another item ({x}).',
      cdetail_MRS_INVALID_field_key_taken: 'The custom field key ({x}) is used for another field.',
      cdetail_MRS_INVALID_draft_update_disabled: 'A sync result that edited an existing Daftra draft was refused; editing is not allowed.',
      cdetail_MRS_INVALID_product_create_disabled: 'A sync result that created a Daftra product was refused; creating is not allowed.',
      cdetail_MRS_DAFTRA_IMPORT_empty: 'The file has no rows.',
      cdetail_MRS_DAFTRA_IMPORT_too_many_rows: 'At most 2000 rows per import.',
      cdetail_MRS_DAFTRA_ACCOUNT_NOT_KSA_not_checked: 'The Daftra account was not checked yet. Run the connection probe first.',
      cdetail_MRS_PAY_FUNDING_fasah_wallet_source: 'The «Fasah wallet» method needs the «Fasah wallet» funding source.',
      cdetail_MRS_PAY_FUNDING_fasah_wallet_method: 'With the «Fasah wallet» funding source the method must be «Fasah wallet».',
      cdetail_MRS_PAY_FUNDING_cash_box_method: 'With the «Cash box» funding source the method must be «Cash».',
      cdetail_MRS_PAY_FUNDING_dry_port_wallet_source: 'The «Dry port wallet» method needs a dry-port wallet funding source.',
      cdetail_MRS_PAY_FUNDING_dry_port_wallet_method: 'A dry-port wallet funding source must use the «Dry port wallet» method.',
      cdetail_MRS_PAY_FUNDING_payer_name: 'Enter the name of the person who paid from a personal account.',
      cdetail_MRS_PAY_FUNDING_paying_account: 'Enter the bank / account paid from (SADAD, mada, bank transfer).',
      cdetail_MRS_PAY_FUNDING_wallet_no_account: 'Do not record a bank on a wallet payment; the bank belongs to the separate wallet top-up.',
      cdetail_MRS_PAY_LOCKED_daftra: 'This payment is linked in Daftra, so it is not voided or corrected in Marsa.',
      cdetail_MRS_PAY_LOCKED_invoiced: 'The reimbursable amount of this payment is invoiced to the client, so the payment is not voided or corrected.',
      cdetail_MRS_PAY_LOCKED_custody: 'This payment is deducted from the client custody. Void the deduction first.',
      cdetail_MRS_PAY_ALLOCATION_sum: 'The allocations must add up to the payment total (difference: {x} SAR).',
      cdetail_MRS_CUSTODY_LINK_exceeds_payment: 'The deduction is above the payment amount linked to this transaction. Maximum {x} SAR.',
      cdetail_MRS_PAY_FUNDING_funding_source: 'Choose the real funding source of the payment.',
      cdetail_MRS_PAY_FUNDING_payment_method: 'Choose a valid payment method.',
      cdetail_MRS_PAY_ALLOCATION_count: 'A shared payment needs at least two allocations, a single payment exactly one.',
      cdetail_MRS_PAY_ALLOCATION_amount: 'Each allocated amount must be above zero.',
      cdetail_MRS_PAY_ALLOCATION_duplicate: 'The same transaction and invoice number cannot appear twice in a shared payment.',
      cdetail_MRS_PAY_ALLOCATION_branch: 'The transactions of one payment must belong to the same branch.',
      cdetail_MRS_PAY_ALLOCATION_client: 'This kind of payment belongs to one client: choose transactions of the same client.',
      cdetail_MRS_PAY_ALLOCATION_not_allowed: 'A single payment takes no allocations; a shared payment names its transactions and invoices in the allocations only.',
      cdetail_MRS_PAY_DOCUMENT_count: 'At most 8 attachments can be added in one save.',
      cdetail_MRS_PAY_DOCUMENT_size: 'The attachment «{x}» is larger than 4 MB.',
      cdetail_MRS_PAY_DOCUMENT_total: 'The new attachments exceed 12 MB in total. Split the upload over two saves.',
      cdetail_MRS_PAY_DOCUMENT_type: 'The attachment «{x}» must be a PDF or an image.',
      cdetail_MRS_PAY_DOCUMENT_branch: 'The attachment is registered for another branch than the payment.',
      cdetail_MRS_PAY_DOCUMENT_in_use: 'The attachment «{x}» is linked to another payment.',
      cdetail_MRS_PAY_DOCUMENT_allocation: 'Link every invoice of a shared payment to its allocation; do not link an attachment to an allocation in a single payment.',
      cdetail_MRS_PAY_DOCUMENT_role: 'The attachment type is not valid (entity invoice, payment proof, extra).',
      cdetail_MRS_CUSTODY_LINK_transaction_required: 'A custody deduction must be linked to a transaction.',
      cdetail_MRS_CUSTODY_LINK_payment_required: 'A custody deduction must be linked to a saved payment.',
      cdetail_MRS_CUSTODY_LINK_client_mismatch: 'The chosen transaction does not belong to the custody client.',
      cdetail_MRS_CUSTODY_LINK_payment_not_in_transaction: 'The chosen payment is not linked to that transaction.',
      cdetail_MRS_CUSTODY_LINK_duplicate_deduction: 'This payment was already deducted from the client custody for this transaction.',
      cdetail_MRS_CUSTODY_LINK_payment_void: 'The chosen payment is void.',
      cdetail_MRS_CUSTODY_NEGATIVE_void_deposit: 'This deposit cannot be voided: the custody balance would become negative (current balance {x} SAR). Void the deductions or refunds that used it first.',
      cdetail_MRS_CUSTODY_NEGATIVE_deduction: 'The client custody balance is not enough for this deduction (current balance {x} SAR). The balance never goes negative.',
      cdetail_MRS_CUSTODY_NEGATIVE_refund: 'The client custody balance is not enough for this refund (current balance {x} SAR). The balance never goes negative.',
      cdetail_MRS_PAY_INVOICE_TAKEN_internal_invoice_no: 'The internal invoice number ({x}) is already used on another invoice or payment.',
      cdetail_MRS_INVALID_claim_no_fp: 'Appointment fees: the claim number is the Fasah invoice Reference No, not the internal FP… number. Put the FP number in the internal number field.',
      cdetail_MRS_INVALID_internal_invoice_mismatch: 'This invoice is already recorded with another internal number ({x}). Correct the internal number or leave it empty.',
      cdetail_MRS_BAD_TRANSITION_approved_documents: 'This payment is approved, so its attachments cannot be added or removed. To change the documents, correct the payment so it goes back to review.',
      cdetail_MRS_AI_WRONG_DOCUMENT_not_payment_proof: 'The document is not a payment proof (it looks like an invoice or another document). Upload it as the entity invoice or choose the proof.',
      cdetail_MRS_AI_WRONG_DOCUMENT_not_entity_invoice: 'The document is not an entity invoice (it looks like a payment proof or another document). Upload it as the payment proof or choose the invoice.',
      cdetail_MRS_NOT_FOUND_doc_batch: 'The document batch does not exist or you may not view it (drafts are separated by branch).',
      cdetail_MRS_INVALID_slot_full: 'The slot is full: one B/L and one customs declaration, up to 10 invoices and 10 packing lists.',
      cdetail_MRS_INVALID_duplicate_file: 'The same file is already in this batch.',
      cdetail_MRS_INVALID_containers_roro: 'A Ro-Ro transaction takes no containers. Remove the containers from the draft or choose a container transaction.',
      cdetail_MRS_REQUIRED_documents: 'Add at least one read document to the batch before approving.',
      cdetail_MRS_REQUIRED_client_id: 'Choose the client (importer) before creating a new transaction from the draft.',
      cdetail_MRS_BAD_TRANSITION_cancelled: 'This record is cancelled and can no longer be changed.',
      cdetail_MRS_FORBIDDEN_cost: 'Transport value and organisation revenue are available to finance roles and the operations manager only.',
      cdetail_MRS_BAD_TRANSITION_delivered: 'This movement is delivered; its operational data cannot be changed or cancelled.',
      cdetail_MRS_BAD_TRANSITION_same_status: 'The transaction is already at this stage (it may have moved automatically). Refresh the page.',
      MRS_EXPIRED: 'This link or invitation has expired. Ask for a new one.',
      MRS_EMAIL_MISMATCH: 'This invitation was sent to a different e-mail address. Sign in with the address that received it.',
      MRS_EMAIL_UNCONFIRMED: 'Please confirm your e-mail address from the message we sent you first, then open the invitation link again.',
      DUPLICATE: 'This record already exists (duplicate). If it is a file, it was uploaded before.',
      FK: 'Invalid reference, or it does not belong to your organisation.',
      CHECK: 'Some values are invalid.',
      RLS: 'You do not have permission to perform this action.',
      AUTH_INVALID: 'Incorrect e-mail or password.',
      AUTH_UNCONFIRMED: 'Please confirm your e-mail address first from the message we sent you.',
      AUTH_EXISTS: 'This e-mail address is already registered.',
      AUTH_WEAK: 'Weak password. Use at least 8 characters mixing letters and digits.',
      AUTH_RATE: 'Too many attempts. Wait a little and try again.',
      UNKNOWN: 'An unexpected error occurred. Please try again.'
    }
  });

  // field.<f>: English labels for the {f} placeholder of err.* (Arabic: MarsaApi.i18n.ar.fields in supa.js)
  register('field', {
    en: {
      fullName: 'Full name', company: 'Company name', phone: 'Mobile number', email: 'E-mail',
      clientType: 'Client type', taxId: 'VAT number', crNumber: 'Commercial registration', contactPref: 'Contact method',
      direction: 'Operation type', service: 'Service', mode: 'Shipping mode', country: 'Country', port: 'Port',
      goods: 'Goods description', hsCode: 'HS code', declarationNo: 'Declaration number', currency: 'Currency', value: 'Value',
      weight: 'Weight', containerType: 'Container type', containerNumbers: 'Container numbers', count: 'Count',
      blNumber: 'B/L number', shippingLine: 'Shipping line', eta: 'Arrival date', documents: 'Documents',
      calc: 'Estimate', terms: 'Terms and declaration', payload: 'Data', name: 'Name', subject: 'Subject',
      message: 'Message', preferred: 'Preferred contact', consent: 'Consent', reference: 'Reference',
      note: 'Note', status: 'Status', branch: 'Branch', client: 'Client', role: 'Role',
      supersedes_id: 'Previous version', evidence_document_id: 'Evidence document',
      empty_return_receipt_required: 'Empty return receipt', operational_status: 'Operational status',
      financial_status: 'Financial status', raw: 'Original value', row_status: 'Row status', same_status: 'Status',
      raw_text: 'Extracted text', extracted_fields: 'Extracted data', reviewed_fields: 'Reviewed data',
      line_items: 'Line items', review_status: 'Review status', review_note: 'Review note', doc_type: 'Document type',
      source_name: 'File name', source_sha256: 'File fingerprint', transaction_id: 'Transaction', document_id: 'Original document',
      void_reason: 'Void reason',
      slug: 'Short identifier', name_ar: 'Arabic name', name_en: 'English name', ref_prefix: 'Reference prefix',
      default_locale: 'Default language', admin_email: 'Organization admin e-mail', code: 'Branch code', city: 'City',
      is_active: 'Active', public_intake_enabled: 'Public intake', brand_color: 'Brand colour',
      contact_phone: 'Contact phone', contact_email: 'Contact e-mail', address_ar: 'Arabic address',
      address_en: 'English address', logo_path: 'Logo', settings: 'Settings', organization: 'Organization',
      branch_id: 'Branch', client_id: 'Client', invitation: 'Invitation', token: 'Invitation code', last_branch: 'Last active branch',
      slug_taken: 'Short identifier (used by another organization)', membership: 'Membership', filters: 'Filters',
      locale: 'Language', idempotencyKey: 'Operation key', idempotency_key: 'Operation key', unknown_key: 'Unknown field',
      self_invite: 'Self-invitation', admin_exists: 'Organization admin', invitation_pending: 'Pending invitation',
      code_taken: 'Branch code (already used)', expired: 'Expired key',
      // G3 detail codes / fields
      declaration_no: 'Declaration number', declaration_type: 'Declaration type', declaration_date: 'Declaration date',
      declaration_no_taken: 'Declaration number (already used in this organization)',
      declaration_no_cancelled: 'Declaration number (cancelled; only as an explicit replacement)', bl_number: 'B/L number',
      bl_number_taken: 'B/L number (already registered with this type)', bl_type: 'B/L type', bl: 'Bill of lading', alias: 'Alias',
      alias_taken: 'Alias (used by another client)', carrier_id: 'Carrier', shipping_agent_id: 'Shipping agent', terminal_party_id: 'Terminal',
      driver_name: 'Driver name', driver_phone: 'Driver mobile', truck_plate: 'Truck plate', movement_status: 'Appointment / transport status',
      destination: 'Delivery destination', cost_amount: 'Transport value', sell_amount: 'Organisation revenue', delivered_at: 'Delivery time',
      appointment_id: 'Appointment', appointment: 'Appointment', trip: 'Transport movement', appointment_status: 'Appointment status',
      cargo_unit_type: 'Cargo unit type', chassis_no: 'Chassis number', port_code: 'Customs port',
      return_yard_party_id: 'Return yard', return_instruction_document_id: 'Return instruction', driver_id: 'Driver', truck_id: 'Truck',
      container_id: 'Container', container_no: 'Container number', appointment_at: 'Appointment time', window_minutes: 'Appointment window',
      appointment_no: 'Appointment number', occurred_at: 'Date occurred', at: 'Status time', leg_no: 'Leg number',
      cost: 'Cost and sell price (finance and managers only)', cost_basis: 'Cost basis', waiver: 'Waiver (manager role)',
      document_or_amount: 'A document or an amount (required for this kind)', kind: 'Kind', source: 'Source', source_document_id: 'Source document',
      replacement: 'Replacement declaration', replaces_id: 'Replaced declaration', use_cancel_declaration: 'Cancellation (use "Cancel declaration")',
      use_reschedule_appointment: 'Time change (use "Reschedule")', no_change: 'No change', backward: 'Moving back to an earlier status',
      cancelled: 'Cancelled record', resolved: 'Closed exception', link: 'B/L link', reason: 'Reason', severity: 'Severity', packages: 'Packages',
      plate_no: 'Plate number', national_id_last4: 'Last 4 digits of the ID', ids: 'Identifiers', transaction: 'Transaction', org_id: 'Organization',
      stage_skip: 'Stage skip', operational_state: 'Container operational state', gross_weight_kg: 'Gross weight'
    }
  });

  window.MarsaI18n = {
    register: register, t: t, has: has, lang: lang, dir: dir, locale: locale,
    hasPageDict: function () { return pageDict; },
    setLang: setLang, apply: apply, label: label,
    fmtDate: fmtDate, fmtNumber: fmtNumber, fmtMoney: fmtMoney,
    langs: LANGS.slice()
  };

  // The inline <head> snippet of every page already set lang/dir before first paint (same
  // rule: marsa_lang → 'ar'); this is the authoritative pass (also honours
  // MARSA_CONFIG.defaultLocale), then the static markup is translated before main.js runs.
  var applied = false;
  setHtmlAttrs();
  function first() { applied = true; apply(document); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', first);
  else first();
})();
