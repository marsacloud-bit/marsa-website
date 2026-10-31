/* مرسى | MARSA — about.html: coverage map interaction + FAQ search & filter */
(function () {
  'use strict';

  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /* ---------------- Coverage map ---------------- */
  var PORTS = {
    'jeddah': { name: 'ميناء جدة الإسلامي', text: 'أكبر موانئ البحر الأحمر وأهم بوابة لواردات المملكة من الحاويات والبضائع العامة. نتابع فيه استكمال البيانات الجمركية وحضور المعاينة عبر مخلّص جمركي مرخّص شريك.' },
    'jed-air': { name: 'مطار الملك عبدالعزيز الدولي بجدة', text: 'مبنى الشحن الجوي في جدة لتخليص الشحنات العاجلة للمنطقة الغربية: العينات وقطع الغيار والأجهزة الإلكترونية والمستلزمات الطبية، ونتابع فيه الشحنات عبر شركائنا.' },
    'rabigh': { name: 'ميناء الملك عبدالله برابغ', text: 'ميناء حديث شمال جدة على البحر الأحمر، يخدم الحاويات والبضائع العامة والمدينة الاقتصادية. نتابع فيه الشحنات عبر شركائنا.' },
    'ruh-dry': { name: 'الميناء الجاف بالرياض', text: 'يستقبل الحاويات القادمة من ميناء الملك عبدالعزيز بالدمام بالقطار ليتم تخليصها في العاصمة مباشرة، ونتابع فيه الشحنات عبر شركائنا.' },
    'ruh-air': { name: 'مطار الملك خالد الدولي بالرياض', text: 'مركز الشحن الجوي للمنطقة الوسطى، ومناسب للشحنات السريعة والتجارة الإلكترونية والأجهزة والأدوية. نتابع فيه الشحنات عبر شركائنا.' },
    'dammam': { name: 'ميناء الملك عبدالعزيز بالدمام', text: 'أكبر موانئ المملكة على الخليج العربي، ويخدم المنطقة الشرقية والوسطى بخطوط مباشرة من آسيا. نتابع فيه الشحنات عبر شركائنا.' },
    'jubail': { name: 'ميناء الجبيل التجاري', text: 'بوابة مدينة الجبيل الصناعية، ومتخصص في المواد الخام ومستلزمات الإنتاج والمعدات الصناعية. نتابع فيه الشحنات عبر شركائنا.' },
    'batha': { name: 'منفذ البطحاء البري', text: 'المنفذ البري الرئيسي مع الإمارات، ومنه تعبر الشاحنات القادمة من دول الخليج. ننسّق فيه البيان المسبق عبر المخلّص المرخّص والنقل البري حتى مستودعك.' }
  };

  var pins = qsa('.map-pin');
  var btns = qsa('.port-btn');
  var detail = document.getElementById('port-detail');

  function selectPort(key) {
    var data = PORTS[key];
    if (!data) return;
    pins.forEach(function (p) {
      var on = p.getAttribute('data-port') === key;
      p.classList.toggle('is-active', on);
      p.setAttribute('aria-pressed', String(on));
    });
    btns.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-port') === key)); });
    if (detail) {
      detail.innerHTML = '';
      var p = document.createElement('p');
      var s = document.createElement('strong');
      s.textContent = data.name + ': ';
      p.appendChild(s);
      p.appendChild(document.createTextNode(data.text));
      detail.appendChild(p);
    }
  }

  btns.forEach(function (b) {
    b.addEventListener('click', function () { selectPort(b.getAttribute('data-port')); });
  });
  pins.forEach(function (p) {
    p.setAttribute('aria-pressed', 'false');
    p.addEventListener('click', function () { selectPort(p.getAttribute('data-port')); });
    p.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectPort(p.getAttribute('data-port')); }
    });
  });

  /* ---------------- FAQ search + category filter ---------------- */
  var list = document.getElementById('faq-list');
  var search = document.getElementById('faq-search');
  var empty = document.getElementById('faq-empty');
  var chips = qsa('.faq-chips .chip');
  if (!list) return;
  var items = qsa('.acc-item', list);
  var activeCat = 'all';

  // Normalise Arabic text so searches ignore hamza/ta-marbuta/diacritic differences
  function norm(str) {
    return (str || '').toLowerCase()
      .replace(/[ً-ْـ]/g, '')
      .replace(/[أإآ]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي')
      .trim();
  }
  var index = items.map(function (it) { return norm(it.textContent); });

  function apply() {
    var q = norm(search ? search.value : '');
    var shown = 0;
    items.forEach(function (it, i) {
      var catOk = activeCat === 'all' || it.getAttribute('data-cat') === activeCat;
      var qOk = !q || index[i].indexOf(q) !== -1;
      var visible = catOk && qOk;
      it.hidden = !visible;
      if (visible) shown++;
    });
    if (empty) empty.hidden = shown !== 0;
  }

  chips.forEach(function (c) {
    c.addEventListener('click', function () {
      activeCat = c.getAttribute('data-filter') || 'all';
      chips.forEach(function (o) {
        var on = o === c;
        o.classList.toggle('is-active', on);
        o.setAttribute('aria-pressed', String(on));
      });
      apply();
    });
  });
  if (search) search.addEventListener('input', apply);

  // Open a question directly from the URL hash, e.g. about.html#faq-6
  function openFromHash() {
    var id = (location.hash || '').slice(1);
    if (!/^faq-\d+$/.test(id)) return;
    var btn = list.querySelector('.acc-trigger[aria-controls="' + id + '"]');
    if (btn && btn.getAttribute('aria-expanded') !== 'true') btn.click();
    if (btn) btn.scrollIntoView({ block: 'center' });
  }
  openFromHash();
  window.addEventListener('hashchange', openFromHash);
})();
