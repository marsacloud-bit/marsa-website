# مرسى | MARSA — Shared partials & cheat-sheet

Copy these blocks VERBATIM into every page. Only change: `<title>`, meta description, `<body data-page="...">`.

## Active nav link
`main.js` marks the active link automatically from the file name (adds `.is-active` + `aria-current="page"` to `.nav-link` and `.drawer-nav a`).
To force it, set `<body data-page="services">` (value = file name without `.html`: index, services, calculator, tracking, request, about, contact, bulk-upload, login).
`request.html` is not in the desktop `.nav-list` (the header CTA button "اطلب تخليص" links to it) but IS in the drawer and footer.
`login.html` (one page, anchors `#client` / `#staff`, «قريبًا» cards, NO credential inputs) is linked from the topbar `.topbar-auth` (topbar is hidden at 700px and below), the drawer and the footer «روابط سريعة». The 7-link `.nav-list` is unchanged so it still fits from 901px.

## Demo banner, privacy line, clear-data button
- `.site-demo-banner[data-demo-banner]` sits right after `</header>` (before the drawer, which must stay directly before `.drawer-backdrop`). Text: «نسخة عرض تجريبية — البيانات والأرقام توضيحية ولا تُرسل أي بيانات إلى خادم.» The close button `[data-demo-banner-close]` hides it for the session (`sessionStorage` key `marsa_demo_banner_dismissed`, wrapped in try/catch).
- `.footer-privacy` (before `.footer-bottom`): data stays in this browser's localStorage, fonts load from Google Fonts, plus button `[data-clear-local]` «مسح بياناتي من هذا الجهاز»: `main.js` asks `confirm()`, removes every localStorage key starting with `marsa_`, then shows a toast.
- Use the wording «نسخة عرض تجريبية» for all demo labels.

## Page skeleton
```html
<!DOCTYPE html>
<html lang="ar" dir="rtl" class="no-js">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>مرسى | MARSA — تخليص جمركي وشحن أونلاين في السعودية</title>
  <meta name="description" content="مرسى منصة سعودية للتخليص الجمركي والشحن أونلاين في المملكة: البيان الجمركي المسبق عبر منصة فسح، تصنيف HS Code، حساب الرسوم الجمركية وضريبة القيمة المضافة 15%، ومتابعة حالة معاملتك. نسخة عرض تجريبية.">
  <meta name="theme-color" content="#0B3A6E">
  <link rel="icon" type="image/png" href="assets/img/favicon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="assets/css/style.css">
</head>
<body data-page="PAGE">
  <a class="skip-link" href="#main">تخطَّ إلى المحتوى</a>
  [HEADER BLOCK]
  <main id="main">
    [PAGE-HERO] … sections …
  </main>
  [FOOTER BLOCK]
  <script src="assets/js/main.js" defer></script>
  <script src="assets/js/PAGE.js" defer></script>
</body>
</html>
```
Change only the `<title>` (pattern: `اسم الصفحة | مرسى MARSA`) and the meta description.

## HEADER BLOCK (topbar + sticky header + mobile drawer)
```html
  <!-- ============ HEADER (shared) ============ -->
  <div class="topbar">
    <div class="container">
      <span>منصة سعودية للتخليص الجمركي والشحن أونلاين</span>
      <div class="topbar-links">
        <nav class="topbar-auth" aria-label="الدخول إلى المنصة">
          <a href="login.html#client"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>دخول العملاء</a>
          <a href="login.html#staff"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/></svg>دخول الموظفين</a>
        </nav>
        <a href="tel:+966126143270"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg><span dir="ltr">+966 12 614 3270</span></a>
        <a href="mailto:info@marsa-sa.com"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg><span dir="ltr">info@marsa-sa.com</span></a>
      </div>
    </div>
  </div>
  <header class="site-header">
    <div class="container header-inner">
      <a class="brand" href="index.html" aria-label="مرسى - الصفحة الرئيسية">
        <img src="assets/img/logo-header.png" alt="مرسى MARSA - تخليص جمركي وشحن" width="84" height="58">
      </a>
      <nav class="main-nav" aria-label="القائمة الرئيسية">
        <ul class="nav-list">
          <li><a class="nav-link" href="index.html">الرئيسية</a></li>
          <li><a class="nav-link" href="services.html">خدماتنا</a></li>
          <li><a class="nav-link" href="calculator.html">حاسبة الرسوم</a></li>
          <li><a class="nav-link" href="tracking.html">تتبع الشحنة</a></li>
          <li><a class="nav-link" href="bulk-upload.html">الرفع الجماعي</a></li>
          <li><a class="nav-link" href="about.html">من نحن</a></li>
          <li><a class="nav-link" href="contact.html">تواصل معنا</a></li>
        </ul>
      </nav>
      <div class="header-actions">
        <a class="btn btn-primary btn-cta" href="request.html">
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/></svg>
          اطلب تخليص
        </a>
        <button class="nav-toggle" type="button" aria-label="فتح القائمة" aria-expanded="false" aria-controls="mobile-drawer">
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
        </button>
      </div>
    </div>
  </header>
  <div class="site-demo-banner" role="note" data-demo-banner>
    <div class="container">
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z"/><path d="M12 16v-4M12 8h.01"/></svg>
      <p>نسخة عرض تجريبية — البيانات والأرقام توضيحية ولا تُرسل أي بيانات إلى خادم.</p>
      <button class="site-demo-banner-close" type="button" aria-label="إخفاء تنبيه نسخة العرض لهذه الجلسة" data-demo-banner-close>
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </div>
  </div>

  <aside class="drawer" id="mobile-drawer" aria-label="القائمة الجانبية" aria-hidden="true">
    <div class="drawer-head">
      <img src="assets/img/logo-header.png" alt="مرسى MARSA" width="72" height="50">
      <button class="drawer-close" type="button" aria-label="إغلاق القائمة">
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </div>
    <ul class="drawer-nav">
      <li><a href="index.html"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/></svg>الرئيسية</a></li>
      <li><a href="services.html"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>خدماتنا</a></li>
      <li><a href="calculator.html"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15v3M8 18h4"/></svg>حاسبة الرسوم الجمركية</a></li>
      <li><a href="tracking.html"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>تتبع الشحنة</a></li>
      <li><a href="request.html"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/></svg>اطلب تخليص</a></li>
      <li><a href="bulk-upload.html"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/></svg>الرفع الجماعي للبيانات</a></li>
      <li><a href="about.html"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2"/><path d="M12 7v14M5 13H3a9 9 0 0 0 18 0h-2M8 11h8"/></svg>من نحن</a></li>
      <li><a href="contact.html"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8.5 8.5 0 0 1-12.6 7.4L3 21l1.6-5.2A8.5 8.5 0 1 1 21 12z"/></svg>تواصل معنا</a></li>
      <li><a href="login.html#client"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>دخول العملاء</a></li>
      <li><a href="login.html#staff"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/></svg>دخول الموظفين</a></li>
    </ul>
    <div class="drawer-foot">
      <a class="btn btn-primary btn-block" href="request.html">اطلب تخليص الآن</a>
      <a href="tel:+966126143270"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg><span dir="ltr">+966 12 614 3270</span></a>
      <a href="mailto:info@marsa-sa.com"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg><span dir="ltr">info@marsa-sa.com</span></a>
    </div>
  </aside>
  <div class="drawer-backdrop" aria-hidden="true"></div>
  <!-- ============ /HEADER ============ -->
```

## FOOTER BLOCK (wave + footer + back-to-top)
The footer wave is filled with `--bg` (#F4F8FB). If the LAST section before the footer is white (`.section-white`), add `footer-after-white` to `<footer class="site-footer">`.
```html
  <!-- ============ FOOTER (shared) ============ -->
  <footer class="site-footer">
    <svg class="footer-wave" viewBox="0 0 1440 80" preserveAspectRatio="none" aria-hidden="true">
      <path class="fw-fill" d="M0,0 L1440,0 L1440,30 C1200,75 960,10 720,40 C480,70 240,15 0,45 Z"/>
    </svg>
    <div class="container">
      <div class="footer-grid">
        <div class="footer-brand">
          <a class="footer-logo" href="index.html" aria-label="مرسى - الصفحة الرئيسية">
            <img src="assets/img/logo-header.png" alt="مرسى MARSA - تخليص جمركي وشحن" width="107" height="74">
          </a>
          <p>مرسى منصة سعودية لخدمات التخليص الجمركي والشحن أونلاين، تساعد المستوردين والمصدّرين في المملكة على تخليص شحناتهم بسرعة وشفافية.</p>
          <div class="social">
            <a href="contact.html" aria-label="فيسبوك"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h-2.5A3.5 3.5 0 0 0 9 6.5V9H7v3.5h2V21h3.5v-8.5H15l.5-3.5h-3V7a1 1 0 0 1 1-1H15z"/></svg></a>
            <a href="contact.html" aria-label="لينكدإن"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 10v7M8 7v.01M12 17v-4a2 2 0 0 1 4 0v4M12 10v7"/></svg></a>
            <a href="https://wa.me/966554821937" target="_blank" rel="noopener" aria-label="واتساب"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8.5 8.5 0 0 1-12.6 7.4L3 21l1.6-5.2A8.5 8.5 0 1 1 21 12z"/><path d="M9 9.5c.3 1.8 2 3.8 4 4.5l1-1 2 .8"/></svg></a>
          </div>
        </div>
        <div class="footer-col">
          <h3>روابط سريعة</h3>
          <ul class="footer-links">
            <li><a href="index.html">الرئيسية</a></li>
            <li><a href="services.html">خدماتنا</a></li>
            <li><a href="about.html">من نحن</a></li>
            <li><a href="about.html#faq">الأسئلة الشائعة</a></li>
            <li><a href="contact.html">تواصل معنا</a></li>
            <li><a href="login.html#client">دخول العملاء</a></li>
            <li><a href="login.html#staff">دخول الموظفين</a></li>
          </ul>
        </div>
        <div class="footer-col">
          <h3>أدوات المنصة</h3>
          <ul class="footer-links">
            <li><a href="request.html">اطلب تخليص</a></li>
            <li><a href="calculator.html">حاسبة الرسوم الجمركية</a></li>
            <li><a href="tracking.html">تتبع الشحنة</a></li>
            <li><a href="bulk-upload.html">الرفع الجماعي (Excel / CSV)</a></li>
            <li><a href="services.html#aci">البيان المسبق ومنصة فسح</a></li>
            <li><a href="services.html#hs">تصنيف HS Code</a></li>
          </ul>
        </div>
        <div class="footer-col">
          <h3>تواصل معنا</h3>
          <ul class="footer-contact">
            <li><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg><span>طريق الملك عبدالعزيز، حي الحمراء – جدة</span></li>
            <li><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/></svg><a href="tel:+966126143270" dir="ltr">+966 12 614 3270</a></li>
            <li><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg><a href="mailto:info@marsa-sa.com" dir="ltr">info@marsa-sa.com</a></li>
            <li><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8.5 8.5 0 0 1-12.6 7.4L3 21l1.6-5.2A8.5 8.5 0 1 1 21 12z"/><path d="M9 9.5c.3 1.8 2 3.8 4 4.5l1-1 2 .8"/></svg><a href="https://wa.me/966554821937" target="_blank" rel="noopener" dir="ltr">+966 55 482 1937</a></li>
            <li><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg><span>الأحد – الخميس: 8 ص – 5 م</span></li>
          </ul>
        </div>
      </div>
    </div>
    <div class="container footer-privacy">
      <p><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/></svg><span><strong>الخصوصية في نسخة العرض:</strong> ما تُدخله في النماذج والحاسبة يبقى في التخزين المحلي (localStorage) لهذا المتصفح فقط، دون تشفير ودون إرسال إلى أي خادم، فلا تُدخل بيانات حقيقية حساسة. يُحمَّل خط الموقع من خدمة Google Fonts، لذا يتصل متصفحك بخوادم Google عند فتح الصفحات.</span></p>
      <button class="btn btn-sm btn-outline-white" type="button" data-clear-local>مسح بياناتي من هذا الجهاز</button>
    </div>
    <div class="container footer-bottom">
      <span>© <span id="year">2026</span> مرسى MARSA. جميع الحقوق محفوظة.</span>
      <span>منصة خاصة لخدمات التخليص الجمركي — غير تابعة لأي جهة حكومية.</span>
    </div>
  </footer>
  <button class="to-top" type="button" aria-label="العودة لأعلى الصفحة">
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>
  </button>
  <!-- ============ /FOOTER ============ -->
```

## PAGE-HERO pattern (inner pages)
```html
<section class="page-hero" aria-labelledby="page-title">
  <div class="container">
    <nav class="breadcrumb" aria-label="مسار التنقل">
      <ol>
        <li><a href="index.html">الرئيسية</a></li>
        <li aria-current="page">خدماتنا</li>
      </ol>
    </nav>
    <h1 id="page-title">عنوان الصفحة</h1>
    <p class="lead">وصف قصير للصفحة في سطر أو اثنين.</p>
  </div>
  <svg class="page-hero-wave" viewBox="0 0 1440 120" preserveAspectRatio="none" aria-hidden="true">
    <path class="w-back" d="M0,40 C180,90 360,10 560,40 C760,70 900,20 1100,35 C1260,48 1360,70 1440,50 L1440,120 L0,120 Z"/>
    <path class="w-mid" d="M0,70 C220,30 420,100 640,70 C860,40 1040,95 1240,70 C1330,60 1400,55 1440,60 L1440,120 L0,120 Z"/>
    <path class="w-front" d="M0,90 C240,60 460,115 720,90 C980,65 1200,110 1440,85 L1440,120 L0,120 Z"/>
  </svg>
</section>
```
- If the next section is white, add `wave-to-white` to the svg class.
- To pull the first card up over the wave: `<section class="section overlap-up">` (main card should have `.card` + `.shadow-lg`).
- Home hero uses `.hero > .container > .hero-grid > (.hero-copy + .hero-visual)` + `.hero-stats` + `svg.hero-wave` (see index.html).

## CSS cheat-sheet (assets/css/style.css — search "== NN")
- **Tokens**: `--navy #0B3A6E`, `--navy-dark #072A52`, `--navy-deep`, `--blue #1673B8`, `--teal #14A3A8`, `--aqua #3FC1D0`, `--bg #F4F8FB`, `--text #0F1E33`, `--muted`, `--border`, `--success/--warning/--danger` (+ `-bg`), `--grad-brand`, `--grad-sea`, `--grad-dark`, radii `--r-sm/--r/--r-lg/--r-xl/--r-pill`, shadows `--shadow-sm/--shadow/--shadow-lg`, `--ring`.
- **Layout**: `.container` (`.container-narrow`), `.section` (`.section-sm`, `.section-white`, `.section-tint`, `.section-dark`), `.grid .grid-2/3/4`, `.split` (`.split-even`), `.sidebar-layout` (main + 340px aside), `.flex .flex-wrap .items-center .justify-between`, `.stack`.
- **Type**: `.lead .text-muted .text-sm .text-xs .text-center .text-gradient .text-teal .fw-bold .num` (LTR digits, use for numbers/codes).
- **Buttons**: `.btn` + `.btn-primary | .btn-secondary | .btn-ghost | .btn-white | .btn-outline-white`; `.btn-sm .btn-lg .btn-block`; `.btn-group`; `.link-arrow`. Arrow icon for "forward" in RTL points LEFT: `<path d="M19 12H5M11 18l-6-6 6-6"/>`.
- **Badges**: `.badge` + `.badge-teal/-blue/-navy/-success/-warning/-danger`, `.dot` (`.dot-pulse`), `.eyebrow`, `.chip` (`.is-active`).
- **Section head**: `.section-head [.text-center] > .eyebrow + h2 + p.lead`; `.section-head-row` (head + action button).
- **Cards**: `.card` (+ `.card-hover`, `.card-accent`, `.card-feature`, `.card-stat > .stat-value/.stat-label`, `.card-glass` on dark, `.card-muted`, `.card-flush` with `.card-header/.card-body/.card-footer`).
- **Icons**: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">` stroke icons; `.icon-box` (+ `-sm`, `-lg`, `-navy`, `-soft`, `-white`).
- **Forms**: `.form` grid; `.form-row` (2 col) `.form-row-3`; `.form-group > label.form-label (span.req *) + .form-control + .form-hint + .form-error`; states `.form-group.has-error` / `.has-success` / `[aria-invalid="true"]`; `.input-icon` (svg + input), `.input-group > .form-control + .addon` (e.g. "USD" / "ر.س"); `.check`/`.radio` (`<label class="check"><input type="checkbox"> نص</label>`); `.radio-cards > label.radio-card > input + .rc-body > svg.icon + .rc-title + .rc-sub`; `.dropzone` (contains `input[type=file]`, `.icon-box`, `.dropzone-title`, `.dropzone-sub`; JS toggles `.is-dragover`) + `ul.file-list > li.file-item > svg.icon + .file-name + .file-size + button.file-remove`; `.stepper > li.step(.is-active/.is-done) > span.step-label`; `.form-step(.is-active)`; `.form-nav`; `.fieldset > legend`; `.form-success > .success-icon + h3 + .ref-code`; `.demo-note`; `.alert` (+ `-success/-warning/-danger`).
- **Tables**: `.table-wrap > table.table (.table-striped)`, `tfoot` totals, `.kv > li > .k + .v` (summary list, `.v.total`).
- **Accordion**: `.accordion[data-single] > .acc-item > h3.acc-heading > button.acc-trigger[aria-expanded][aria-controls] (text + span.acc-icon)` + `div.acc-panel#id[hidden] > .acc-content`.
- **Tabs**: `[data-tabs] > .tab-list[role=tablist] > button.tab[role=tab][aria-selected][aria-controls]` + `.tab-panel[role=tabpanel]`.
- **Timeline** (tracking): `ol.timeline > li(.is-done/.is-current) > span.tl-dot + span.tl-title + span.tl-meta`. **Progress**: `.progress-meta` + `.progress > .progress-bar[data-width="72"]` (animates when visible; or set style.width).
- **Home bits**: `.shipment-card (.sc-head .sc-id .sc-sub .sc-route .port .line)`, `.float-card`, `.quick-track`, `.steps > .step-card`, `.feature-list > .feature-item`, `.check-list`, `.port-card`, `.testimonial`, `.avatar`, `.cta-band` (with `svg.cta-wave`).
- **Utilities**: `.mt-0..5 .mb-0..4 .gap-1..3 .w-100 .mx-auto .rounded .shadow .shadow-lg .bg-white .bg-tint .divider .hidden .hide-sm .show-sm .sticky .sr-only`.
- **Motion**: add `.reveal` (+ `data-delay="1..5"`) to animate on scroll. Counters: `<span data-count="1250" data-suffix="+" data-prefix="" data-decimals="0">0</span>`.

## JS (assets/js/main.js) — window.Marsa
- `Marsa.toast(msg, "success"|"error"|"warning"|"info")`
- `Marsa.genRef("MRS")` → `MRS-2026-K7Q2ZP`
- `Marsa.saveLocal(key, obj)` appends `{...obj, savedAt}` to a JSON array in localStorage; `Marsa.readLocal(key)` returns the array. Keys used: `marsa_requests`, `marsa_calc_draft`, `marsa_calc`, `marsa_calculations`, `marsa_contacts`, `marsa_messages`, `marsa_doc_checklist`, `marsa_bulk_batches` (do not rename; keep the `marsa_` prefix so the footer clear-data button covers new keys).
- `Marsa.formatSAR(n)` → `"12,345.00 ر.س"` (the old `formatEGP` alias was removed); `Marsa.formatNum(n, digits)`; `Marsa.qs/qsa`; `Marsa.icon("success")` returns svg markup.
- Any `<form data-track-form>` with `input[name="id"]` redirects to `tracking.html?id=…`.
- Page scripts: plain IIFE, `defer`, no modules, no fetch of local files.

## Contact placeholders (keep identical everywhere)
- Phone `+966 12 614 3270` (`tel:+966126143270`, wrap in `dir="ltr"`)
- WhatsApp `+966 55 482 1937` → `https://wa.me/966554821937`
- Email `info@marsa-sa.com`
- Head office `طريق الملك عبدالعزيز، حي الحمراء – جدة`; hours `الأحد – الخميس: 8 ص – 5 م`
- Branches: المقر الرئيسي – جدة (`+966 12 614 3270`، ميناء جدة الإسلامي ومطار الملك عبدالعزيز الدولي بجدة)؛ فرع الدمام `طريق الملك فهد، حي الشاطئ – الدمام` (`+966 13 832 5640`، ميناء الملك عبدالعزيز بالدمام)؛ فرع الرياض `طريق العليا، حي العليا – الرياض` (`+966 11 465 2280`، الميناء الجاف بالرياض ومطار الملك خالد الدولي)؛ فرع الجبيل `حي الفناتير – الجبيل الصناعية` (`+966 13 341 7720`، ميناء الجبيل التجاري).
- Tagline: `منصة سعودية للتخليص الجمركي والشحن أونلاين`. Titles/descriptions say «في السعودية» / «في المملكة».

## Saudi localisation conventions
- Authority: هيئة الزكاة والضريبة والجمارك (ZATCA). Customs platform: منصة فسح (FASAH). Never claim government affiliation.
- Service key `aci` stays in URLs/IDs, visible title «البيان المسبق ومنصة فسح»; field label «رقم البيان الجمركي».
- Conformity: شهادة المطابقة عبر منصة سابر (SABER) — الهيئة السعودية للمواصفات والمقاييس والجودة (SASO).
- Importer prerequisites: السجل التجاري، شهادة التسجيل في ضريبة القيمة المضافة (الرقم الضريبي)، رمز المستورد/التسجيل في فسح.
- Currency: الريال السعودي (SAR), symbol `ر.س` — use `Marsa.formatSAR`. Default rates to SAR: USD 3.75, EUR 4.05, CNY 0.52, AED 1.02.
- VAT 15% on (CIF + customs duty + other taxable fees). Optional editable fee «رسوم خدمات الميناء والمناولة». Marsa fee tiers 750 / 1,250 / 2,000 ر.س.
- Ports & entry points: ميناء جدة الإسلامي، ميناء الملك عبدالعزيز بالدمام، ميناء الجبيل التجاري، ميناء الملك عبدالله برابغ، الميناء الجاف بالرياض، مطار الملك خالد الدولي بالرياض، مطار الملك عبدالعزيز الدولي بجدة، منفذ البطحاء البري. Any «N منافذ» stat must equal the count listed on that page (home and about both list 8).
- Copy: clear Modern Standard Arabic (no Egyptian dialect).
