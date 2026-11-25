#!/usr/bin/env node
/*
  Marsa (مرسى) — migration 20261213000100_site_profile.sql + site-profile.js (owner, 23 Nov 2026: every subscribed office
  customises its website; stage A: the website shows the office's own name, colour, contacts and logo).
  LOCAL TESTS ONLY. PGlite (in-memory Postgres), no network.

  Covers: file conventions + all_migrations.sql; preflight + re-run; site_profile (anon, active office only, only the
  public keys, bad colour / foreign logo path dropped, unknown slug NULL); the storage policy (anon reads only the
  current logo of an active office); the 5 site pages carry the hooks and load supa.js before site-profile.js;
  site-profile.js uses textContent / attributes only and keeps the defaults in demo mode; the colour helper (vm run).
  Stage B (same migration): admin_update_org accepts whatsapp (mobile only) / hours_ar / hours_en / about_ar / about_en
  with their limits, other settings unchanged, unknown keys still refused; site_profile returns them; the page hooks;
  the WhatsApp / hours / about / name-swap helpers (vm run on a small fake page).

  usage:
    node supabase/tests/site-profile-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { PGlite } = require('@electric-sql/pglite');

const args = process.argv.slice(2);
const ROOT = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', '..'));
const QUIET = args.includes('--quiet');
const SUPA = path.join(ROOT, 'supabase');
const MIG_DIR = path.join(SUPA, 'migrations');
const MIG = '20261213000100_site_profile.sql';
const MIG_FILE = path.join(MIG_DIR, MIG);

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { if (!QUIET) console.log('\n== ' + t); }

const A = 'a0c10000-0000-4000-8000-000000000001';
const B = 'a0c10000-0000-4000-8000-000000000002';
const U = { admin: 'a0c1aaaa-0000-4000-8000-000000000001' };
const LOGO_A = A + '/logo-1795000000000.png';
const OLD_A = A + '/logo-1790000000000.png';
const LOGO_B = B + '/logo-1795000000001.png';

let db;
async function asRole(who, fn) {
  if (who === 'anon') await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claims', '{"role":"anon"}', false);`);
  else {
    await db.query(`SELECT set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: U[who], role: 'authenticated', aal: 'aal2' })]);
    await db.exec(`SET ROLE authenticated;`);
  }
  try { return await fn(); }
  finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claims', '', false);`); }
}
async function q(sql, params) { return (await db.query(sql, params || [])).rows; }
const as = (who, sql, params) => asRole(who, () => q(sql, params));
const errText = e => (e && (e.message + ' ' + (e.detail || '') + ' ' + (e.hint || ''))) || String(e);
const J = x => JSON.stringify(x);
async function check(name, fn) {
  try {
    const r = await fn();
    if (typeof r === 'string') fail(name, r);
    else if (r === false || r === null || r === 0 || r === undefined) fail(name, 'assertion false');
    else pass(name);
  } catch (e) { fail(name, 'threw: ' + errText(e)); }
}
const migFiles = () => fs.readdirSync(MIG_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
async function freshDb(upTo) {
  const d = new PGlite();
  await d.exec(fs.readFileSync(path.join(SUPA, 'tests', 'shim.sql'), 'utf8'));
  for (const f of migFiles().filter(f => !upTo || f < upTo)) await d.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  return d;
}
const FIXTURES = `
  INSERT INTO public.organizations (id, slug, name_ar, name_en, settings) VALUES
    ('${A}', 'office-a', 'مكتب أ للتخليص', 'Office A Clearance',
     '{"brand_color":"#1e6b5a","contact_phone":"+966500000001","contact_email":"info@office-a.example.com","address_ar":"جدة","address_en":"Jeddah","logo_path":"${LOGO_A}","secret_note":"x","whatsapp":"0554000001","hours_ar":"السبت – الخميس","about_ar":"نبذة أ"}'),
    ('${B}', 'office-b', 'مكتب ب', NULL, '{"brand_color":"red","logo_path":"${LOGO_A}"}');
  INSERT INTO storage.buckets (id, name, public) VALUES ('org-assets', 'org-assets', false) ON CONFLICT (id) DO NOTHING;
  INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ('${U.admin}', 'admin@site.example.com', now());
  INSERT INTO public.profiles (id, full_name) VALUES ('${U.admin}', 'مدير') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.memberships (user_id, org_id, branch_id, role, is_active) VALUES ('${U.admin}', '${A}', NULL, 'admin', true);
  INSERT INTO storage.objects (bucket_id, name) VALUES ('org-assets', '${LOGO_A}'), ('org-assets', '${OLD_A}'), ('org-assets', '${LOGO_B}');
`;
const prof = (who, slug) => as(who, `SELECT public.site_profile($1) r`, [slug]).then(r => r[0].r);
const anonObjects = () => as('anon', `SELECT name FROM storage.objects WHERE bucket_id = 'org-assets' ORDER BY name`).then(r => r.map(x => x.name));

/* ------------------------------------------------------------------ 1. the file */
async function secFile() {
  section('1. file: conventions, all_migrations.sql');
  const s = fs.readFileSync(MIG_FILE, 'utf8');
  await check('preflight on org_served_ports, its schema_versions row, no BEGIN / COMMIT', () =>
    (/version = '20261210000100'/.test(s) && /VALUES \('20261213000100', 'site_profile'\)/.test(s) && !/^\s*(BEGIN|COMMIT)\s*;/im.test(s)) || 'conventions');
  await check('all_migrations.sql: this file verbatim, in order, with its live-DB note', () => {
    const all = fs.readFileSync(path.join(SUPA, 'all_migrations.sql'), 'utf8');
    const h = '-- ===== migrations/' + MIG + ' =====\n';
    const i = all.indexOf(h);
    const order = (all.match(/^-- ===== migrations\/(\S+) =====$/gm) || []).map(l => l.split('/')[1].split(' ')[0]);
    const nx = all.indexOf('\n-- ===== migrations/', i + h.length);
    const body = nx < 0 ? all.slice(i + h.length) : all.slice(i + h.length, nx);
    return (i > 0 && (body === s || body + '\n' === s) && all.indexOf(h, i + 1) < 0 && all.slice(0, 30000).includes(MIG) && J(order) === J(migFiles())) || 'bundle';
  });
  const LATER_PHASES = ['20261214000100_org_ai_keys.sql', '20261215000100_team_tiers.sql'];
  await check('only the known later migrations follow this file', () => {
    const later = migFiles().filter(f => f > MIG);
    return later.every(f => LATER_PHASES.includes(f)) || 'unexpected later files: ' + later.join(', ');
  });
}

/* ------------------------------------------------------------------ 2. preflight + re-run */
async function secPreflight() {
  section('2. preflight + re-run');
  const d = await freshDb(MIG);
  try {
    await check('refused without org_served_ports (schema_versions row removed)', async () => {
      await d.query(`DELETE FROM public.schema_versions WHERE version = '20261210000100'`);
      let r = 'ok'; try { await d.exec(fs.readFileSync(MIG_FILE, 'utf8')); } catch (e) { r = e.message; }
      await d.query(`INSERT INTO public.schema_versions (version, name) VALUES ('20261210000100', 'org_served_ports')`);
      return /SITE PROFILE preflight: apply org_served_ports first/.test(r) || r;
    });
    await check('applies, then re-runs (one policy, one version row)', async () => {
      await d.exec(fs.readFileSync(MIG_FILE, 'utf8'));
      await d.exec(fs.readFileSync(MIG_FILE, 'utf8'));
      const p = (await d.query(`SELECT count(*)::int n FROM pg_policies WHERE schemaname = 'storage' AND policyname = 'marsa_org_assets_site_logo'`)).rows[0].n;
      const v = (await d.query(`SELECT count(*)::int n FROM public.schema_versions WHERE version = '20261213000100'`)).rows[0].n;
      return (p === 1 && v === 1) || J({ p, v });
    });
  } finally { await d.close(); }
}

/* ------------------------------------------------------------------ 3. site_profile */
async function secProfile() {
  section('3. site_profile (anon)');
  await check('office A: names, colour, contacts, addresses, logo — and only these keys', async () => {
    const r = await prof('anon', 'office-a');
    const keys = ['about_ar', 'about_en', 'address_ar', 'address_en', 'brand_color', 'contact_email', 'contact_phone', 'hours_ar', 'hours_en',
      'logo_path', 'name_ar', 'name_en', 'whatsapp'];
    return (r && J(Object.keys(r).sort()) === J(keys) && r.name_ar === 'مكتب أ للتخليص' && r.brand_color === '#1e6b5a'
      && r.whatsapp === '0554000001' && r.hours_ar === 'السبت – الخميس' && r.about_ar === 'نبذة أ' && r.hours_en === null
      && r.contact_phone === '+966500000001' && r.logo_path === LOGO_A && !('secret_note' in r) && !('id' in r)) || J(r);
  });
  await check('office B: a bad colour and another office\'s logo path are dropped', async () => {
    const r = await prof('anon', 'office-b');
    return (r && r.brand_color === null && r.logo_path === null && r.name_ar === 'مكتب ب' && r.name_en === null) || J(r);
  });
  await check('unknown, malformed or inactive office → NULL', async () => {
    const a = await prof('anon', 'nobody-here'), b = await prof('anon', "x'; drop"), c = await prof('anon', null);
    await q(`UPDATE public.organizations SET is_active = false WHERE id = '${A}'`);
    const d = await prof('anon', 'office-a');
    await q(`UPDATE public.organizations SET is_active = true WHERE id = '${A}'`);
    return (a === null && b === null && c === null && d === null) || J({ a, b, c, d });
  });
  await check('a signed-in user gets the same public answer', async () => {
    const r = await prof('admin', 'office-a');
    return (r && r.name_en === 'Office A Clearance') || J(r);
  });
}

/* ------------------------------------------------------------------ 3b. stage B settings */
const upd = (settings) => as('admin', `SELECT public.admin_update_org($1, $2) r`, [A, { settings }]).then(r => r[0].r.settings);
const errOf = async fn => { try { await fn(); return 'ok'; } catch (e) { return errText(e); } };
async function secStageB() {
  section('3b. admin_update_org: the website settings (stage B)');
  await check('saves whatsapp (normalised 05…), hours, about; other settings kept; site_profile shows them', async () => {
    const s = await upd({ whatsapp: '+966 55 400 0002', hours_ar: 'الأحد – الخميس: 9 ص – 6 م', hours_en: 'Sun – Thu: 9 am – 6 pm',
      about_ar: 'مكتب أ يخدم المستوردين منذ عشرين عامًا.', about_en: 'Office A has served importers for twenty years.' });
    const r = await prof('anon', 'office-a');
    return (s.whatsapp === '0554000002' && s.brand_color === '#1e6b5a' && s.logo_path === LOGO_A && s.secret_note === 'x'
      && r.whatsapp === '0554000002' && r.hours_en === 'Sun – Thu: 9 am – 6 pm' && r.about_en === 'Office A has served importers for twenty years.') || J({ s, r });
  });
  await check('refuses a landline WhatsApp, hours over 120, about over 600, an unknown key; accepts the limits', async () => {
    const a = await errOf(() => upd({ whatsapp: '0126143270' }));
    const b = await errOf(() => upd({ hours_ar: 'س'.repeat(121) }));
    const c = await errOf(() => upd({ about_ar: 'ن'.repeat(601) }));
    const d = await errOf(() => upd({ theme: 'dark' }));
    const e = await errOf(() => upd({ about_ar: 'ن'.repeat(600), hours_ar: 'س'.repeat(120) }));
    return (/MRS_INVALID/.test(a) && /whatsapp/.test(a) && /MRS_TOO_LONG/.test(b) && /MRS_TOO_LONG/.test(c) && d !== 'ok' && e === 'ok') || J({ a, b, c, d, e });
  });
  await check('an empty value removes the setting', async () => {
    const s = await upd({ whatsapp: null, about_en: '' });
    return (!('whatsapp' in s) && !('about_en' in s) && !!s.about_ar) || J(s);
  });
  await check('still admin-only (anon refused)', async () => {
    const e = await errOf(() => as('anon', `SELECT public.admin_update_org($1, $2)`, [A, { settings: { whatsapp: '0554000003' } }]));
    return e !== 'ok' || e;
  });
}

/* ------------------------------------------------------------------ 4. the logo policy */
async function secLogo() {
  section('4. storage: a visitor reads only the current logo of an active office');
  await check('anon sees exactly office A\'s current logo (not its old file, not office B\'s)', async () => {
    const r = await anonObjects();
    return J(r) === J([LOGO_A]) || J(r);
  });
  await check('logo changed → the new one only; office inactive → none', async () => {
    await q(`UPDATE public.organizations SET settings = jsonb_set(settings, '{logo_path}', to_jsonb($1::text)) WHERE id = '${A}'`, [OLD_A]);
    const a = await anonObjects();
    await q(`UPDATE public.organizations SET is_active = false WHERE id = '${A}'`);
    const b = await anonObjects();
    await q(`UPDATE public.organizations SET is_active = true, settings = jsonb_set(settings, '{logo_path}', to_jsonb($1::text)) WHERE id = '${A}'`, [LOGO_A]);
    return (J(a) === J([OLD_A]) && b.length === 0) || J({ a, b });
  });
  await check('anon still cannot write or delete in the bucket', async () => {
    let w = 'ok', del = 0;
    try { await as('anon', `INSERT INTO storage.objects (bucket_id, name) VALUES ('org-assets', $1)`, [A + '/logo-1795000000009.png']); } catch (e) { w = 'refused'; }
    del = (await as('anon', `WITH d AS (DELETE FROM storage.objects WHERE name = $1 RETURNING 1) SELECT count(*)::int n FROM d`, [LOGO_A]))[0].n;
    return (w === 'refused' && del === 0) || J({ w, del });
  });
  await check('site_logo_visible: true only for a current logo', async () => {
    const r = await as('anon', `SELECT public.site_logo_visible($1) a, public.site_logo_visible($2) b, public.site_logo_visible(NULL) c`, [LOGO_A, OLD_A]);
    return (r[0].a === true && r[0].b === false && r[0].c === false) || J(r);
  });
}

/* ------------------------------------------------------------------ 5. front end (static + colour helper) */
async function secFront() {
  section('5. pages / supa.js / site-profile.js');
  const supa = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'supa.js'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'site-profile.js'), 'utf8');
  await check('supa.js wraps site_profile and exports it', () =>
    (/rpc\('site_profile', \{ p_org_slug: ORG_SLUG \}/.test(supa) && /siteProfile: siteProfile/.test(supa)) || 'wrapper');
  for (const p of ['office', 'blog', 'consult', 'about', 'contact']) {
    const h = fs.readFileSync(path.join(ROOT, p + '.html'), 'utf8');
    await check(p + '.html: the hooks, and supa.js loaded before site-profile.js', () => {
      const n = k => (h.match(new RegExp(k, 'g')) || []).length;
      const s1 = h.indexOf('<script src="assets/js/supa.js"'), s2 = h.indexOf('<script src="assets/js/site-profile.js"');
      return (n('data-site-logo') === 3 && n('data-site-brand') === 2 && n('data-site-phone') >= 2 && n('data-site-email') >= 2
        && n('data-site-address') >= 1 && n('data-site-whatsapp') >= 1 && n('data-site-hours') >= 1 && s1 > 0 && s2 > s1)
        || J({ logo: n('data-site-logo'), wa: n('data-site-whatsapp'), hours: n('data-site-hours'), s1, s2 });
    });
  }
  await check('contact.html: the branch cards keep their own numbers (no hook inside .branch-meta)', () => {
    const h = fs.readFileSync(path.join(ROOT, 'contact.html'), 'utf8');
    const blocks = h.split('class="branch-meta"').slice(1).map(b => b.slice(0, b.indexOf('</ul>')));
    return (blocks.length > 0 && blocks.every(b => !/data-site-/.test(b))) || 'hooked branch';
  });
  await check('about / contact: the platform name in page texts swapped, the story and the open badge hooked', () => {
    const ab = fs.readFileSync(path.join(ROOT, 'about.html'), 'utf8'), ct = fs.readFileSync(path.join(ROOT, 'contact.html'), 'utf8');
    return (/data-site-about-page/.test(ab) && (ab.match(/data-site-story/g) || []).length === 2 && /data-site-platform-only/.test(ab)
      && (ab.match(/data-site-swap/g) || []).length >= 4 && (ct.match(/data-site-swap/g) || []).length >= 7
      && /id="open-status" data-site-hours-badge/.test(ct)) || 'hooks';
  });
  await check('site-profile.js: data only through textContent / attributes; demo keeps the defaults', () =>
    (!/innerHTML/.test(js) && /textContent = /.test(js) && /isOnline/.test(js) && /HEX\.test/.test(js)) || 'unsafe');
  await check('colour: dark accent keeps white text; a light accent is darkened to be readable', () => {
    const body = { style: { props: {}, setProperty(k, v) { this.props[k] = v; } } };
    const doc = { readyState: 'complete', body, title: 'x', querySelectorAll: () => [] };
    const run = (color) => {
      body.style.props = {};
      const store = { marsa_site_profile: JSON.stringify({ name_ar: 'م', brand_color: color }) };
      const ctx = {
        document: doc, window: { addEventListener() {}, MarsaI18n: null,
          MarsaApi: { isOnline: () => true, siteProfile: () => ({ then() {} }) } },
        localStorage: { getItem: k => store[k] || null, setItem() {}, removeItem() {} }, JSON, Math, parseInt
      };
      ctx.window.document = doc;
      vm.runInNewContext(js, ctx);
      return Object.assign({}, body.style.props);
    };
    const dark = run('#1e6b5a'), light = run('#ffe680');
    const lightAccent = parseInt(light['--accent'].slice(1), 16);
    return (dark['--accent'] === '#1e6b5a' && dark['--on-accent'] === '#ffffff' && light['--accent'] !== '#ffe680'
      && lightAccent < 0xffe680 && /^#[0-9a-f]{6}$/.test(light['--accent-soft'])) || J({ dark, light });
  });
  await check('stage B helpers: WhatsApp link, hours, about text in place of the story, the name in fixed texts', () => {
    const mk = (attrs, text) => {
      const el = { attrs: Object.assign({}, attrs), hidden: 'hidden' in attrs, textContent: text || '', classList: { set: {}, add(c) { this.set[c] = 1; } },
        getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, setAttribute(k, v) { this.attrs[k] = String(v); },
        hasAttribute(k) { return k in this.attrs; }, removeAttribute(k) { delete this.attrs[k]; }, querySelector: () => null };
      el.textNode = { nodeValue: text || '' };
      return el;
    };
    const wa = mk({ 'data-site-whatsapp': '' }, '+966 55 482 1937');
    const hours = mk({ 'data-site-hours': '', 'data-i18n': 'footer.hours' }, 'الأحد – الخميس: 8 ص – 5 م');
    const badge = mk({ 'data-site-hours-badge': '' });
    const aboutP = mk({ 'data-site-about-page': '', hidden: '' });
    const story = mk({ 'data-site-story': '' }, 'قصة');
    const quote = mk({ 'data-site-platform-only': '' }, 'اسمنا مرسى');
    const swap = mk({ 'data-site-swap': '', 'aria-label': 'خريطة فروع مرسى' }, 'فريق مرسى جاهز');
    const all = { '[data-site-whatsapp]': [wa], '[data-site-hours]': [hours], '[data-site-hours-badge]': [badge], '[data-site-about-page]': [aboutP],
      '[data-site-story]': [story], '[data-site-platform-only]': [quote], '[data-site-swap]': [swap] };
    const doc = { readyState: 'complete', body: { style: { setProperty() {} } }, title: 'من نحن | مرسى MARSA',
      querySelectorAll: s => all[s] || [],
      createTreeWalker: el => { let done = false; return { nextNode: () => (done ? null : (done = true, el.textNode)) }; } };
    const store = { marsa_site_profile: JSON.stringify({ name_ar: 'مكتب أ', whatsapp: '0554000002', hours_ar: 'السبت – الخميس', about_ar: 'نبذة المكتب' }) };
    const ctx = { document: doc, NodeFilter: { SHOW_TEXT: 4 },
      window: { addEventListener() {}, MarsaI18n: null, MarsaApi: { isOnline: () => true, siteProfile: () => ({ then() {} }) } },
      localStorage: { getItem: k => store[k] || null, setItem() {}, removeItem() {} }, JSON, Math, parseInt };
    ctx.window.document = doc;
    vm.runInNewContext(js, ctx);
    const res = { href: wa.attrs.href, wa: wa.textContent, hours: hours.textContent, i18n: hours.attrs['data-i18n'], badge: !!badge.classList.set['is-site-off'],
      about: aboutP.textContent, aboutHidden: aboutP.hidden, storyHidden: story.hidden, quoteHidden: quote.hidden,
      swapped: swap.textNode.nodeValue, aria: swap.attrs['aria-label'], title: doc.title };
    return (res.href === 'https://wa.me/966554000002' && res.wa === '+966 55 400 0002' && res.hours === 'السبت – الخميس' && res.i18n === undefined
      && res.badge && res.about === 'نبذة المكتب' && !res.aboutHidden && res.storyHidden && res.quoteHidden
      && res.swapped === 'فريق مكتب أ جاهز' && res.aria === 'خريطة فروع مكتب أ' && res.title === 'من نحن | مكتب أ') || J(res);
  });
}

(async () => {
  await secFile();
  await secPreflight();
  db = await freshDb();
  await db.exec(FIXTURES);
  await secProfile();
  await secStageB();
  await secLogo();
  await db.close();
  await secFront();
  console.log('\n' + '-'.repeat(70));
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ' — ' + nPass + ' passed, ' + nFail + ' failed');
  process.exit(nFail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
