#!/usr/bin/env node
/*
  Marsa (مرسى) — production release folder: scripts/build-release.sh (supabase/production/README.md «cutover»).
  LOCAL TESTS ONLY: builds into temporary folders outside the repository with DUMMY production values (never a real
  key), reads the repository through git ls-files / git status only (nothing is written there). No network.

  Covers: --self-test; refusals that write nothing (secret keys, an anon JWT of another project such as the staging ref,
  a key with a quote, the staging URL, the demo slug); a dummy build: config.js, sw.js '-prod', robots.txt Allow: /,
  .htaccess (no Basic Auth, www → apex, the inline-script hashes), every page with data-marsa-env="production", a hidden
  demo banner, data-show-mode flipped, no meta «(بيئة تجريبية)», guides without <!-- env:staging --> blocks, the zip
  holding .htaccess + robots.txt, no staging ref / key anywhere; the repository unchanged.

  usage:
    node supabase/tests/release-build-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const args = process.argv.slice(2);
const ROOT = args.find(a => !a.startsWith('--')) || '/Users/apple/Downloads/marsa-website';
const QUIET = args.includes('--quiet');
const SCRIPT = path.join(ROOT, 'scripts', 'build-release.sh');

let nPass = 0, nFail = 0;
const fails = [];
function pass(name) { nPass++; if (!QUIET) console.log('PASS  ' + name); }
function fail(name, why) { nFail++; fails.push(name + ' — ' + why); console.log('FAIL  ' + name + '\n        ' + why); }
function section(t) { console.log('\n== ' + t); }
function check(name, fn) {
  try {
    const r = fn();
    if (typeof r === 'string') fail(name, r);
    else if (!r) fail(name, 'assertion false');
    else pass(name);
  } catch (e) { fail(name, 'threw: ' + (e && e.message)); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'marsa-release-'));
const PROD_REF = 'prodtestref000000000';
const PROD = { PROD_SUPABASE_URL: 'https://' + PROD_REF + '.supabase.co', PROD_PUBLISHABLE_KEY: 'sb_publishable_TESTONLY_dummy', PROD_ORG_SLUG: 'real-org' };
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (o, sig) => b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64(o) + '.' + (sig || 'c2lnbmF0dXJl');
let outSeq = 0;
function build(env, extra) {
  const out = path.join(TMP, 'out' + (++outSeq));
  const r = spawnSync('bash', [SCRIPT, out, '--allow-dirty'].concat(extra || []), {
    encoding: 'utf8', env: Object.assign({ PATH: process.env.PATH, HOME: process.env.HOME }, PROD, env || {}) });
  return { out, code: r.status, text: (r.stdout || '') + (r.stderr || '') };
}
const git = a => execFileSync('git', ['-C', ROOT].concat(a), { encoding: 'utf8' });
const rd = f => fs.readFileSync(f, 'utf8');

function main() {
  const before = git(['status', '--porcelain']);
  const cfg = rd(path.join(ROOT, 'assets', 'js', 'config.js'));
  const STAGING_REF = (cfg.match(/supabaseUrl:\s*'https:\/\/([a-z0-9]+)\.supabase\.co'/) || [])[1] || '';
  const STAGING_KEY = (cfg.match(/supabaseAnonKey:\s*'([^']*)'/) || [])[1] || '';

  section('1. --self-test');
  check('build-release.sh --self-test passes', () => {
    const r = spawnSync('bash', [SCRIPT, '--self-test'], { encoding: 'utf8' });
    return (r.status === 0 && /self-test OK — \d+ checks/.test(r.stdout)) || (r.stdout + r.stderr);
  });

  section('2. refusals (nothing written)');
  const refusals = [
    ['an anon JWT of the STAGING project ref', { PROD_PUBLISHABLE_KEY: jwt({ role: 'anon', ref: STAGING_REF || 'cgzhidyxfpksfckwmauq' }) }, /anon JWT of ANOTHER project/],
    ['an anon JWT without a ref', { PROD_PUBLISHABLE_KEY: jwt({ role: 'anon' }) }, /anon JWT of ANOTHER project/],
    ['an anon JWT of this project with a quote in the signature', { PROD_PUBLISHABLE_KEY: jwt({ role: 'anon', ref: PROD_REF }, "sig'x") }, /neither sb_publishable_/],
    ["a publishable key with a quote (would break config.js)", { PROD_PUBLISHABLE_KEY: "sb_publishable_ab'c" }, /neither sb_publishable_/],
    ['a service_role JWT', { PROD_PUBLISHABLE_KEY: jwt({ role: 'service_role', ref: PROD_REF }) }, /SECRET key/],
    ['an sb_secret_ key', { PROD_PUBLISHABLE_KEY: 'sb_secret_TESTONLY' }, /SECRET key/],
    ['the staging project URL', { PROD_SUPABASE_URL: 'https://' + (STAGING_REF || 'x') + '.supabase.co' }, /STAGING project/],
    ['the staging key', { PROD_PUBLISHABLE_KEY: STAGING_KEY || 'x' }, /STAGING key|neither|SECRET|ANOTHER/],
    ['the demo slug blue-sea', { PROD_ORG_SLUG: 'blue-sea' }, /demo org 'blue-sea'/]
  ];
  for (const [name, env, re] of refusals) {
    check('refused: ' + name, () => {
      const r = build(env);
      return (r.code === 1 && re.test(r.text) && !fs.existsSync(r.out)) || ('exit ' + r.code + ': ' + r.text.slice(-300));
    });
  }

  section('3. a dummy production build');
  const ok = build({});
  check('builds (dummy publishable key)', () => (ok.code === 0 && /release built from commit/.test(ok.text)) || ok.text.slice(-600));
  const site = path.join(ok.out, 'site');
  if (!fs.existsSync(site)) return finish(before);
  const pages = fs.readdirSync(site).filter(f => f.endsWith('.html'));
  check('config.js: the PROD values, environment production', () => {
    const c = rd(path.join(site, 'assets', 'js', 'config.js'));
    return (c.includes("supabaseUrl: '" + PROD.PROD_SUPABASE_URL + "'") && c.includes("supabaseAnonKey: '" + PROD.PROD_PUBLISHABLE_KEY + "'")
      && c.includes("orgSlug: 'real-org'") && c.includes("environment: 'production'")) || c;
  });
  check('sw.js VERSION ends with -prod', () => /^var VERSION = '[^']+-prod';/m.test(rd(path.join(site, 'sw.js'))));
  check('robots.txt: User-agent: * / Allow: /', () => rd(path.join(site, 'robots.txt')) === 'User-agent: *\nAllow: /\n');
  check('.htaccess: no Basic Auth, www → apex before the HTTPS rule, no placeholder, 2+ inline-script hashes', () => {
    const h = rd(path.join(site, '.htaccess'));
    const www = h.indexOf('RewriteCond %{HTTP_HOST} ^www\\.(.+)$ [NC]'), https = h.indexOf('RewriteCond %{HTTPS} off');
    return (!/AuthType|AuthUserFile|Require valid-user/i.test(h) && www > 0 && https > www
      && h.includes('RewriteRule ^ https://%1%{REQUEST_URI} [L,R=301]') && !/__[A-Z_]+__/.test(h)
      && (h.match(/'sha256-[A-Za-z0-9+/=]+'/g) || []).length >= 2) || 'htaccess';
  });
  check('every page: <html data-marsa-env="production">; every demo banner hidden', () => {
    const bad = pages.filter(f => { const s = rd(path.join(site, f));
      return !/<html data-marsa-env="production"/.test(s) || /data-demo-banner>/.test(s); });
    return bad.length === 0 || bad.join(', ');
  });
  check('data-show-mode: every "demo" block hidden, no "online" block hidden', () => {
    const bad = [];
    for (const f of pages) {
      for (const t of rd(path.join(site, f)).match(/<[a-z][^<>]*data-show-mode="(?:demo|online)"[^<>]*>/g) || []) {
        const hidden = /\shidden(?=[\s/>])/.test(t);
        if (/"demo"/.test(t) !== hidden) bad.push(f + ': ' + t.slice(0, 80));
      }
    }
    return bad.length === 0 || bad.slice(0, 5).join(' | ');
  });
  check('meta descriptions without «بيئة تجريبية»; manifest description without it', () => {
    const bad = pages.filter(f => /<meta[^>]*content="[^"]*بيئة تجريبية/.test(rd(path.join(site, f))));
    return (bad.length === 0 && !/بيئة تجريبية/.test(rd(path.join(site, 'manifest.json')))) || bad.join(', ');
  });
  check('guides: no <!-- env:staging --> block and no staging wording left; the staging source still has its markers', () => {
    const md = execFileSync('find', [path.join(site, 'docs', 'guide'), '-name', '*.md'], { encoding: 'utf8' }).trim().split('\n');
    const bad = md.filter(f => /<!-- \/?env|staging|test environment|البيئة الحالية تجريبية|البيئة التجريبية/i.test(rd(f)));
    return (md.length >= 12 && bad.length === 0 && /<!-- env:staging -->/.test(rd(path.join(ROOT, 'docs', 'guide', 'en', 'index.md'))))
      || bad.map(f => path.relative(site, f)).join(', ');
  });
  check('login.html: the staging acknowledgement is staging-only and the production one exists', () => {
    const s = rd(path.join(site, 'login.html'));
    return ((s.match(/data-i18n="login\.ack" data-show-env="staging"/g) || []).length === 2
      && (s.match(/data-i18n="login\.ackProd" data-show-env="production"/g) || []).length === 2) || 'login ack';
  });
  check('style.css hides [data-show-env="staging"] under html[data-marsa-env="production"]', () =>
    /html\[data-marsa-env="production"\] \[data-show-env="staging"\],\s*html:not\(\[data-marsa-env="production"\]\) \[data-show-env="production"\] \{ display: none !important; \}/
      .test(rd(path.join(site, 'assets', 'css', 'style.css'))));
  check('no staging ref / key anywhere in site/', () => {
    if (!STAGING_REF) return 'no staging ref in config.js';
    const r = spawnSync('grep', ['-rIlF', '-e', STAGING_REF].concat(STAGING_KEY ? ['-e', STAGING_KEY] : []).concat(['.']), { cwd: site, encoding: 'utf8' });
    return r.status === 1 || r.stdout;
  });
  check('the zip holds .htaccess and robots.txt', () => {
    const zip = fs.readdirSync(ok.out).find(f => /^marsa-release-prod-.*\.zip$/.test(f));
    const l = execFileSync('unzip', ['-l', path.join(ok.out, zip)], { encoding: 'utf8' });
    return (/\s\.htaccess\n/.test(l) && /\srobots\.txt\n/.test(l)) || l.slice(0, 300);
  });
  finish(before);
}
function finish(before) {
  check('the repository is unchanged (git status identical)', () => git(['status', '--porcelain']) === before);
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + '-'.repeat(70));
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  - ' + f)); }
  console.log((nFail ? 'FAILED' : 'OK') + ` — ${nPass} passed, ${nFail} failed`);
  process.exit(nFail ? 1 : 0);
}
main();
