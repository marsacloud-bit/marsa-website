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
      MRS_IDEMPOTENCY_CONFLICT: 'تعارض في إعادة الإرسال: استُخدم مفتاح العملية نفسه لبيانات مختلفة أو انتهت صلاحيته. أعد تحميل الصفحة وحاول مرة أخرى.',
      MRS_IN_PROGRESS: 'العملية نفسها قيد التنفيذ الآن. انتظر لحظات ثم تحقّق من النتيجة قبل إعادة المحاولة.',
      MRS_UNKNOWN_RESULT: 'لم نتمكّن من تأكيد نتيجة العملية بسبب انقطاع الاتصال. إعادة المحاولة آمنة ولن تُنشئ نسخة مكرّرة.',
      MRS_TIMEOUT: 'استغرق الخادم وقتًا أطول من المعتاد. حاول مرة أخرى.',
      MRS_DOCS_MISSING: 'لا يمكن الانتقال إلى هذه المرحلة قبل استكمال المستندات المطلوبة لها ({f}). ارفعها وصنّفها، أو تجاوز القاعدة بصلاحية مدير مع ذكر السبب.',
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
      MRS_IDEMPOTENCY_CONFLICT: 'Resubmission conflict: the same operation key was used for different data or has expired. Reload the page and try again.',
      MRS_IN_PROGRESS: 'The same operation is in progress right now. Wait a moment and check the result before retrying.',
      MRS_UNKNOWN_RESULT: 'We could not confirm the result because the connection dropped. Retrying is safe and will not create a duplicate.',
      MRS_TIMEOUT: 'The server took longer than usual to answer. Please try again.',
      MRS_DOCS_MISSING: 'This stage needs its required documents first ({f}). Upload and classify them, or a manager may override the rule with a reason.',
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
