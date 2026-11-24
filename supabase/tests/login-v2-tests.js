#!/usr/bin/env node
/*
  Sign-in page in the new calm design (owner, 23 Nov 2026). LOCAL, static.
  Covers: <html class="login-v2"> + login-v2.css after login.css (precached); the top bar (office brand via
  site-profile.js, back to the site, the language button); the welcome panel texts in Arabic and English; every
  form / id the sign-in code uses is still there; the office-site header / footer hidden by CSS, not deleted.
  usage: node supabase/tests/login-v2-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const ROOT = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', '..'));
const QUIET = args.includes('--quiet');
let nPass = 0, nFail = 0; const fails = [];
function check(name, fn) {
  let r; try { r = fn(); } catch (e) { r = 'threw: ' + e.message; }
  if (r === true) { nPass++; if (!QUIET) console.log('PASS  ' + name); } else { nFail++; fails.push(name + ' — ' + r); console.log('FAIL  ' + name + '\n        ' + r); }
}
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('login.html'), css = read('assets/css/pages/login-v2.css'), dict = read('assets/i18n/login.js'), sw = read('sw.js');

check('login.html: class login-v2, login-v2.css after login.css, site-profile.js loaded after auth.js', () =>
  (/<html[^>]*class="no-js login-v2"/.test(html) && html.indexOf('pages/login.css') < html.indexOf('pages/login-v2.css')
    && html.indexOf('js/auth.js') < html.indexOf('js/site-profile.js')) || 'html');
check('top bar: office brand (data-site-brand / data-site-logo), back to the site, one language button', () =>
  (/class="lg-top"/.test(html) && /class="lg-brand"[^>]*data-site-brand/.test(html) && /<img data-site-logo/.test(html)
    && /class="lg-back" href="index.html"/.test(html) && (html.match(/data-lang-toggle/g) || []).length === 1) || 'top bar');
check('every sign-in form and field id the code uses is kept', () => {
  const ids = ['client-signin-form', 'client-signup-form', 'staff-signin-form', 'otp-request-form', 'otp-verify-form', 'forgot-form', 'reset-form',
    'invite-signin-form', 'invite-signup-form', 'ci-email', 'ci-password', 'st-email', 'st-password', 'tab-client', 'tab-staff', 'page-title'];
  const miss = ids.filter(id => !html.includes('id="' + id + '"'));
  return miss.length === 0 || 'missing: ' + miss.join(', ');
});
check('the office-site chrome is hidden by CSS, not deleted', () =>
  (/class="site-header"/.test(html) && /class="site-footer"/.test(html) && /\.login-v2 \.site-header/.test(css) && /\.login-v2 \.site-footer/.test(css)
    && /display: none !important/.test(css)) || 'chrome');
check('welcome-panel texts exist in Arabic and English', () => {
  const keys = ['v2Back', 'v2Kicker', 'v2Hello', 'v2Lead', 'v2Pt1', 'v2Pt2', 'v2Pt3'];
  const miss = keys.filter(k => (dict.match(new RegExp('\\b' + k + ':', 'g')) || []).length !== 2);
  return miss.length === 0 || 'missing: ' + miss.join(', ');
});
check('layout: two halves, one column on small screens, start-aligned text, sticky panel', () =>
  (/grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/.test(css) && /max-width: 900px/.test(css) && /text-align: start/.test(css) && /position: sticky/.test(css)) || 'css');
check('sw.js precaches login-v2.css', () => /'assets\/css\/pages\/login-v2\.css'/.test(sw) || 'sw');

console.log('\n' + '-'.repeat(70));
if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
console.log((nFail ? 'FAILED' : 'OK') + ' — ' + nPass + ' passed, ' + nFail + ' failed');
process.exit(nFail ? 1 : 0);
