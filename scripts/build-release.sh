#!/usr/bin/env bash
# =====================================================================
# Marsa — PRODUCTION release folder for Hostinger (main domain). docs/online/ENVIRONMENTS_AR.md §2.4 / §4
#
#   export PROD_SUPABASE_URL='https://<prod-ref>.supabase.co'
#   export PROD_PUBLISHABLE_KEY='sb_publishable_…'     # the PUBLIC key of the production project
#   export PROD_ORG_SLUG='<slug>'                       # organizations.slug of the production tenant
#   ./scripts/build-release.sh OUT_DIR [--allow-dirty] [--in-place]
#   ./scripts/build-release.sh --self-test              # the key / page / guide checks below on built-in samples
#
# --in-place (docs/online/CONVERT_IN_PLACE_AR.md, owner decision 2026-11-08): the CURRENT project becomes production.
#   PROD_SUPABASE_URL / PROD_PUBLISHABLE_KEY must then be exactly the values of assets/js/config.js (the same project);
#   every other rule below stays, and the project ref / key may appear only in assets/js/config.js and .htaccess.
#   Without --in-place the current project / key are refused (a NEW production project).
#
# Writes (OUT_DIR must be outside the repository and empty or missing):
#   OUT_DIR/site/                    upload to an EMPTIED public_html (supabase/production/README.md «cutover»): the
#                                    pages, manifest.json, sw.js, assets/, docs/guide/, robots.txt (Allow: /),
#                                    .htaccess (from deploy/htaccess.production; no Basic Auth)
#   OUT_DIR/marsa-release-prod-<stamp>.zip   the same files, ready for hPanel File Manager → Extract
#   OUT_DIR/edge/                    inbox-sync.ts + daftra-sync.ts single-file bundles (Supabase Dashboard editor;
#                                    NEVER uploaded to Hostinger)
#   OUT_DIR/SHA256SUMS               sha256 of every file above
# Only TRACKED files are copied (git ls-files: make_admin.sql, .env, dumps never qualify), and only the site:
# supabase/, scripts/, deploy/, .github/, docs/ (except docs/guide/), root *.md, config.example.js and
# config.production.example.js stay out. assets/js/config.js is REPLACED by one built from the PROD_* variables;
# sw.js VERSION gets the suffix '-prod'; the manifest and the pages' meta descriptions lose their «(بيئة تجريبية)»
# note; every page gets <html data-marsa-env="production">, a hidden demo banner, hidden data-show-mode="demo"
# blocks and visible data-show-mode="online" blocks (main.js / the page scripts set the same at runtime: first paint
# and crawlers already see production); the guides lose their <!-- env:staging --> … <!-- /env --> lines.
# Safety: refuses a secret key (sb_secret_…, a service_role JWT), an anon JWT of another project (its "ref" must be
# the PROD_SUPABASE_URL ref), a key with characters outside [A-Za-z0-9._-], the staging project / key (unless --in-place,
# which in turn refuses any OTHER project / key), the demo slug
# 'blue-sea', and uncommitted changes to site files (unless --allow-dirty, for a local test build only). Fails when
# staging wording (Staging, بيئة تجريبية, خادم الاختبار, test environment, …) is left in a page outside
# data-show-mode="demo" / data-show-env="staging" / the demo banner, in a guide or in manifest.json.
# Reads only local files; no network.
# =====================================================================
set -euo pipefail
umask 022

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT=""
ALLOW_DIRTY=0
IN_PLACE=0

usage() {
  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}
die() { echo "build-release: $*" >&2; exit 1; }

# ---- Python helpers (one copy: the build and --self-test run the same code)
#   key-kind REF   (the key in $PROD_KEY) → publishable | anon | secret | other-project | unknown
#   transform SITE production edits of the pages and guides (see the header)
#   scan SITE      staging wording left in the pages / guides / manifest.json → exit 1 with the list
#   hashes SITE    sha256 of every inline <script> (any attributes, no src=) for the CSP
#   self-test      every case above on built-in samples
IFS= read -r -d '' PYLIB <<'PYLIB_END' || true
import base64, glob, hashlib, json, os, re, sys
from html.parser import HTMLParser

SEG = re.compile(r'[A-Za-z0-9_-]+')
def key_kind(k, ref):
    if re.match(r'(?i)^sb_secret_', k): return 'secret'
    if re.fullmatch(r'sb_publishable_[A-Za-z0-9_-]+', k): return 'publishable'
    p = k.split('.')
    if len(p) != 3 or not all(SEG.fullmatch(x) for x in p): return 'unknown'
    try: pl = json.loads(base64.urlsafe_b64decode(p[1] + '=' * (-len(p[1]) % 4)))
    except Exception: return 'unknown'
    if not isinstance(pl, dict): return 'unknown'
    if pl.get('role') == 'service_role': return 'secret'
    if pl.get('role') != 'anon': return 'unknown'
    return 'anon' if pl.get('ref') == ref else 'other-project'

STAGING = re.compile(r'staging|test environment|بيئة تجريبية|البيئة التجريبية|البيئة الحالية تجريبية|بيئة اختبار|بيئة التجربة'
                     r'|خادم الاختبار|نسخة عرض تجريبية|نسخة العرض التجريبية', re.I)
HIDDEN = re.compile(r'\s+hidden(?=[\s/>])')
def start_tags(s, attr, fn):
    return re.sub(r'<[a-zA-Z][^<>]*\s' + attr + r'[^<>]*>', lambda m: fn(m.group(0)), s)
def add_hidden(t): return t if HIDDEN.search(t) else re.sub(r'\s*(/?)>$', r' hidden\1>', t)
def prod_html(s):
    if not re.search(r'<html\b[^>]*\sdata-marsa-env=', s):
        s = re.sub(r'<html\b', '<html data-marsa-env="production"', s, count=1)
    s = start_tags(s, r'data-demo-banner(?=[\s>])', add_hidden)
    s = start_tags(s, r'data-show-mode="demo"', add_hidden)
    s = start_tags(s, r'data-show-mode="online"', lambda t: HIDDEN.sub('', t))
    return re.sub(r'(<meta\b[^>]*\scontent=")([^"]*)(")',
                  lambda m: m.group(1) + re.sub(r'\s*\(بيئة تجريبية\)|\s*بيئة تجريبية\.', '', m.group(2)) + m.group(3), s)
def prod_md(s, name='md'):
    s = re.sub(r'^<!-- env:staging -->\n.*?^<!-- /env -->\n', '', s, flags=re.M | re.S)
    if '<!-- env:' in s or '<!-- /env -->' in s:
        raise ValueError(name + ': unbalanced <!-- env:staging --> / <!-- /env --> markers')
    return s

VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'}
SHOWN_ATTRS = ('content', 'title', 'alt', 'aria-label', 'placeholder', 'value')
class Scan(HTMLParser):
    # text + shown attributes outside data-show-mode="demo" / data-show-env="staging" / [data-demo-banner] subtrees
    def __init__(self):
        super().__init__(convert_charrefs=True); self.stack = []; self.hits = []
    def off(self): return bool(self.stack) and self.stack[-1][1]
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        off = self.off() or a.get('data-show-mode') == 'demo' or a.get('data-show-env') == 'staging' or 'data-demo-banner' in a
        if not off:
            for n in SHOWN_ATTRS:
                if a.get(n) and STAGING.search(a[n]): self.hits.append((self.getpos()[0], n + '="' + a[n][:80] + '"'))
        if tag not in VOID: self.stack.append((tag, off))
    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID and self.stack: self.stack.pop()
    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag: del self.stack[i:]; break
    def handle_data(self, d):
        if not self.off() and STAGING.search(d): self.hits.append((self.getpos()[0], ' '.join(d.split())[:80]))
def scan_html(s):
    p = Scan(); p.feed(s); p.close(); return p.hits
def scan_text(s):
    return [(i + 1, l.strip()[:80]) for i, l in enumerate(s.split('\n')) if STAGING.search(l)]

def inline_hashes(htmls):
    seen = []
    for s in htmls:
        for m in re.finditer(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', s, re.S):
            h = "'sha256-" + base64.b64encode(hashlib.sha256(m.group(1).encode('utf-8')).digest()).decode() + "'"
            if h not in seen: seen.append(h)
    return seen

def rd(p): return open(p, encoding='utf-8').read()
def wr(p, s): open(p, 'w', encoding='utf-8').write(s)
def pages(site): return sorted(glob.glob(os.path.join(site, '*.html')))
def guides(site): return sorted(glob.glob(os.path.join(site, 'docs', 'guide', '**', '*.md'), recursive=True))

def self_test():
    n = 0
    def ok(c, what):
        nonlocal n
        if not c: sys.exit('build-release --self-test FAILED: ' + what)
        n += 1
    b64 = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')
    jwt = lambda o, sig='c2lnbmF0dXJl': b64({'alg': 'HS256', 'typ': 'JWT'}) + '.' + b64(o) + '.' + sig
    R = 'prodref0000000000000'
    for k, want in [('sb_publishable_AbC-12_x', 'publishable'), ('sb_secret_abc', 'secret'), ('SB_SECRET_abc', 'secret'),
                    (jwt({'role': 'anon', 'ref': R}), 'anon'), (jwt({'role': 'service_role', 'ref': R}), 'secret'),
                    (jwt({'role': 'anon', 'ref': 'cgzhidyxfpksfckwmauq'}), 'other-project'), (jwt({'role': 'anon'}), 'other-project'),
                    (jwt({'role': 'authenticated', 'ref': R}), 'unknown'), (jwt({'role': 'anon', 'ref': R}, "sig'x"), 'unknown'),
                    ("sb_publishable_ab'c", 'unknown'), ('sb_publishable_ab\nc', 'unknown'), ('a.b', 'unknown'), ('', 'unknown')]:
        ok(key_kind(k, R) == want, 'key_kind(%r) = %s, expected %s' % (k[:40], key_kind(k, R), want))
    page = ('<!doctype html>\n<html lang="ar" dir="rtl">\n<head><meta name="description" content="لوحة مرسى (بيئة تجريبية): الطلبات. بيئة تجريبية.">'
            '<script>var a=1;</script><script type="module">var b=2;</script><script src="x.js"></script></head>\n<body>'
            '<div class="site-demo-banner" role="note" data-demo-banner><p data-demo-banner-text>نسخة عرض تجريبية</p></div>'
            '<p data-show-mode="demo">عرض</p><p class="lead" data-show-mode="online" hidden>متصل</p></body></html>')
    out = prod_html(page)
    ok('<html data-marsa-env="production" lang="ar"' in out, 'html data-marsa-env')
    ok(prod_html(out) == out, 'transform is idempotent')
    ok('data-demo-banner hidden>' in out and '<p data-demo-banner-text>' in out, 'demo banner hidden (not its text)')
    ok('<p data-show-mode="demo" hidden>' in out and '<p class="lead" data-show-mode="online">' in out, 'show-mode demo hidden / online shown')
    ok('content="لوحة مرسى: الطلبات."' in out, 'meta description note removed')
    ok(scan_html(out) == [], 'scan: clean transformed page, got %r' % scan_html(out))
    ok(len(scan_html(page)) == 1 and 'content=' in scan_html(page)[0][1], 'scan: meta content with the note')
    for frag, hits in [('<p>بيئة تجريبية متصلة (Staging)</p>', 1), ('<p title="Test environment">x</p>', 1),
                       ('<span data-show-mode="demo">Staging<br><b>خادم الاختبار</b></span><p>ok</p>', 0),
                       ('<span data-show-mode="online"><span data-show-env="staging">Staging<input type="checkbox"></span>'
                        '<span data-show-env="production">مرسى</span></span>', 0),
                       ('<span data-show-env="staging">x</span><span>هذه بيئة تجريبية</span>', 1),
                       ('<div data-demo-banner><p>Staging</p></div><p>Staging</p>', 1),
                       ('<span data-show-env="production">البيئة الحالية تجريبية</span>', 1)]:
        ok(len(scan_html(frag)) == hits, 'scan_html(%r) → %r' % (frag[:60], scan_html(frag)))
    md = '# Guide\n\n<!-- env:staging -->\n> This is a staging environment.\n<!-- /env -->\n\nText.\n'
    ok(prod_md(md) == '# Guide\n\n\nText.\n' and scan_text(prod_md(md)) == [] and len(scan_text(md)) == 2, 'guide staging block removed')
    try: prod_md('<!-- env:staging -->\n> x\n'); ok(False, 'unbalanced marker accepted')
    except ValueError: ok(True, '')
    ok(len(inline_hashes([page])) == 2, 'inline hashes: <script> and <script type=…>, never src=')
    print('build-release --self-test OK — %d checks' % n)

cmd, args = sys.argv[1], sys.argv[2:]
if cmd == 'key-kind':
    print(key_kind(os.environ['PROD_KEY'], args[0]))
elif cmd == 'transform':
    site = args[0]; ps = pages(site)
    for f in ps: wr(f, prod_html(rd(f)))
    try:
        for f in guides(site): wr(f, prod_md(rd(f), os.path.relpath(f, site)))
    except ValueError as e: sys.exit('build-release: ' + str(e))
    bad = [os.path.basename(f) for f in ps if 'data-marsa-env="production"' not in rd(f)]
    if bad: sys.exit('build-release: <html> without data-marsa-env: ' + ' '.join(bad))
elif cmd == 'scan':
    site = args[0]; hits = []
    for f in pages(site): hits += [os.path.relpath(f, site) + ':%d  %s' % h for h in scan_html(rd(f))]
    for f in guides(site) + [os.path.join(site, 'manifest.json')]:
        hits += [os.path.relpath(f, site) + ':%d  %s' % h for h in scan_text(rd(f))]
    if hits: sys.exit('build-release: staging wording in site/ (put it in data-show-env="staging" / data-show-mode="demo",\n'
                      '  or between <!-- env:staging --> and <!-- /env --> in a guide):\n  ' + '\n  '.join(hits))
elif cmd == 'hashes':
    print(' '.join(inline_hashes([rd(f) for f in pages(args[0])])))
elif cmd == 'self-test':
    self_test()
else:
    sys.exit('build-release: unknown helper ' + cmd)
PYLIB_END
pyl() { python3 -I -c "$PYLIB" "$@"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --in-place) IN_PLACE=1; shift ;;
    --self-test) command -v python3 >/dev/null || die "needs python3"; pyl self-test; exit 0 ;;
    -h|--help) usage 0 ;;
    -*) echo "unknown option: $1" >&2; usage 1 ;;
    *) [ -z "$OUT" ] || die "only one OUT_DIR"; OUT="$1"; shift ;;
  esac
done
[ -n "$OUT" ] || usage 1
command -v git >/dev/null && command -v python3 >/dev/null && command -v zip >/dev/null && command -v shasum >/dev/null \
  || die "needs git, python3, zip and shasum"

# ---- output directory: outside the repo, empty or new (created only after every check below passed)
OUT_PARENT="$(dirname "$OUT")"
[ -d "$OUT_PARENT" ] || die "parent of OUT_DIR does not exist: $OUT_PARENT"
OUT="$(cd "$OUT_PARENT" && pwd -P)/$(basename "$OUT")"
case "$OUT/" in "$(cd "$REPO" && pwd -P)/"*) die "OUT_DIR must be outside the repository" ;; esac
[ ! -e "$OUT" ] || { [ -d "$OUT" ] && [ -z "$(ls -A "$OUT")" ]; } || die "OUT_DIR is not empty: $OUT"

# ---- production values (public only)
URL="${PROD_SUPABASE_URL:-}"; KEY="${PROD_PUBLISHABLE_KEY:-}"; SLUG="${PROD_ORG_SLUG:-}"
[ -n "$URL" ] || die "PROD_SUPABASE_URL is not set"
[ -n "$KEY" ] || die "PROD_PUBLISHABLE_KEY is not set"
[ -n "$SLUG" ] || die "PROD_ORG_SLUG is not set"
URL="${URL%/}"
REF="$(printf '%s' "$URL" | sed -n 's#^https://\([a-z0-9]\{1,40\}\)\.supabase\.co$#\1#p')"
[ -n "$REF" ] || die "PROD_SUPABASE_URL must look like https://<project-ref>.supabase.co"
STAGING_CFG="$REPO/assets/js/config.js"
STAGING_REF="$(sed -n "s#.*supabaseUrl:[[:space:]]*'https://\([a-z0-9]\{1,40\}\)\.supabase\.co'.*#\1#p" "$STAGING_CFG" | head -n 1)"
STAGING_KEY="$(sed -n "s#.*supabaseAnonKey:[[:space:]]*'\([^']*\)'.*#\1#p" "$STAGING_CFG" | head -n 1)"
if [ "$IN_PLACE" = 1 ]; then
  # the current project becomes production: exactly the URL / key of assets/js/config.js, nothing else
  [ -n "$STAGING_REF" ] && [ -n "$STAGING_KEY" ] || die "--in-place: assets/js/config.js holds no project URL / key"
  [ "$REF" = "$STAGING_REF" ] || die "--in-place needs the CURRENT project ($STAGING_REF), got $REF"
  [ "$KEY" = "$STAGING_KEY" ] || die "--in-place needs the CURRENT publishable key of assets/js/config.js"
else
  [ "$REF" != "$STAGING_REF" ] || die "PROD_SUPABASE_URL is the STAGING project ($STAGING_REF) (in-place conversion: --in-place)"
  [ "$KEY" != "$STAGING_KEY" ] || die "PROD_PUBLISHABLE_KEY is the STAGING key"
fi
# the same test as supa.js looksSecret(), plus: only a publishable key or an anon JWT OF THIS PROJECT (payload "ref"),
# and only [A-Za-z0-9._-] (the key is written into a JS string below)
KEY_KIND="$(PROD_KEY="$KEY" pyl key-kind "$REF")"
case "$KEY_KIND" in
  secret) die "PROD_PUBLISHABLE_KEY is a SECRET key (sb_secret_ / service_role). Use the publishable key. Nothing was written." ;;
  other-project) die "PROD_PUBLISHABLE_KEY is an anon JWT of ANOTHER project (its \"ref\" is not $REF; the staging key?). Nothing was written." ;;
  publishable|anon) ;;
  *) die "PROD_PUBLISHABLE_KEY is neither sb_publishable_… nor an anon JWT (only A-Z a-z 0-9 . _ - are allowed)" ;;
esac
printf '%s' "$KEY" | grep -Eq '^[A-Za-z0-9._-]+$' || die "PROD_PUBLISHABLE_KEY holds characters outside [A-Za-z0-9._-]"
printf '%s' "$SLUG" | grep -Eq '^[a-z0-9][a-z0-9-]{1,40}$' || die "PROD_ORG_SLUG must be a lowercase slug (a-z 0-9 -)"
[ "$SLUG" != "blue-sea" ] || die "PROD_ORG_SLUG is the staging demo org 'blue-sea'"

# ---- the site file list: tracked files only, whitelisted
cd "$REPO"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git work tree: $REPO"
COMMIT="$(git rev-parse --short HEAD)"
LIST="$(git ls-files | grep -E '^([^/]+\.html|manifest\.json|sw\.js|assets/.+|docs/guide/.+)$' \
          | grep -vE '^assets/js/config(\.example|\.production\.example)?\.js$' || true)"
[ -n "$LIST" ] || die "no site files found"
DIRTY="$(git status --porcelain -- $(printf '%s\n' "$LIST" | tr '\n' ' ') 2>/dev/null || true)"
if [ -n "$DIRTY" ]; then
  [ "$ALLOW_DIRTY" = 1 ] || die "uncommitted changes in site files (commit first, or --allow-dirty for a test build):
$DIRTY"
  echo "WARNING: building with uncommitted changes (test build only):"; printf '%s\n' "$DIRTY" | sed 's/^/  /'
fi
grep -q '^help\.html$' <<<"$LIST" && ! grep -q '^docs/guide/' <<<"$LIST" && die "help.html needs docs/guide/ (not tracked?)"

SITE="$OUT/site"
mkdir -p "$OUT" "$SITE"
printf '%s\n' "$LIST" | while IFS= read -r f; do
  mkdir -p "$SITE/$(dirname "$f")"
  cp -p "$f" "$SITE/$f"
done

# ---- assets/js/config.js (production; same shape as assets/js/config.production.example.js)
cat > "$SITE/assets/js/config.js" <<EOF
/* ==========================================================================
   مرسى | MARSA — runtime configuration (PRODUCTION)
   Generated by scripts/build-release.sh from commit $COMMIT (template:
   assets/js/config.production.example.js). Public values only: the
   publishable key is public by design (RLS protects the data).
   ========================================================================== */
window.MARSA_CONFIG = {
  supabaseUrl: '$URL',
  supabaseAnonKey: '$KEY',
  orgSlug: '$SLUG',
  environment: 'production'
};
EOF

# ---- sw.js: a production cache name, never shared with a staging build
grep -Eq "^var VERSION = '[^']+';" "$SITE/sw.js" || die "sw.js: no VERSION line"
sed -E "s/^var VERSION = '([^']+)';/var VERSION = '\1-prod';/" "$SITE/sw.js" > "$SITE/sw.js.tmp" && mv "$SITE/sw.js.tmp" "$SITE/sw.js"
grep -Eq "^var VERSION = '[^']+-prod';" "$SITE/sw.js" || die "sw.js: VERSION suffix not applied"

# ---- manifest.json: drop the staging note from the description (must stay valid JSON)
python3 -I - "$SITE/manifest.json" <<'PY'
import json, sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
s = s.replace(' (بيئة تجريبية)', '')
json.loads(s)
open(p, 'w', encoding='utf-8').write(s)
PY

# ---- pages + guides: production first paint (data-marsa-env, hidden demo banner / demo blocks, meta notes, guide blocks)
pyl transform "$SITE"

# ---- robots.txt: the production site is indexable (the staging one says Disallow: /; signed-in pages keep X-Robots-Tag)
printf 'User-agent: *\nAllow: /\n' > "$SITE/robots.txt"

# ---- .htaccess from deploy/htaccess.production (inline-script hashes computed from the copied pages)
HASHES="$(pyl hashes "$SITE")"
sed -e "s#__INLINE_SCRIPT_HASHES__#$HASHES#" -e "s#__SUPABASE_ORIGIN__#$URL#g" -e "s#__SUPABASE_WSS__#wss://$REF.supabase.co#g" \
  "$REPO/deploy/htaccess.production" > "$SITE/.htaccess"
! grep -q '__[A-Z_]*__' "$SITE/.htaccess" || die ".htaccess: placeholder left"
! grep -Eqi 'AuthType|AuthUserFile|Require valid-user' "$SITE/.htaccess" || die ".htaccess: Basic Auth must not be in production"

# ---- edge function bundles (outside site/: pasted into the Supabase Dashboard, never served)
mkdir -p "$OUT/edge"
for fn in inbox-sync daftra-sync; do
  python3 -I "$REPO/scripts/bundle-edge-function.py" "$fn" > "$OUT/edge/$fn.ts"
done

# ---- checks on what will be published
cd "$SITE"
BAD="$(find . -type f \( -name '*.sql' -o -name '*.sh' -o -name '*.py' -o -name '*.ts' -o -name '.env*' -o -name '*.zip' \
         -o -name 'config.example.js' -o -name 'config.production.example.js' \) | sort)"
[ -z "$BAD" ] || die "forbidden files in site/: $BAD"
BAD="$(find . -type f -name '*.md' ! -path './docs/guide/*' | sort)"
[ -z "$BAD" ] || die "markdown outside docs/guide/: $BAD"
[ ! -e supabase ] && [ ! -e scripts ] && [ ! -e deploy ] && [ ! -e .git ] && [ ! -e .github ] || die "repo folder copied into site/"
[ "$(ls docs)" = "guide" ] || die "docs/ must hold guide/ only"
[ "$(cat robots.txt)" = "$(printf 'User-agent: *\nAllow: /')" ] || die "robots.txt is not the production one"
! grep -qE 'sb_secret_|service_role' assets/js/config.js || die "secret marker in site/assets/js/config.js"
if [ "$IN_PLACE" = 1 ]; then
  # the same project: its ref / key belong in config.js and the .htaccess CSP only
  LEAK="$(grep -rIlF -e "$STAGING_REF" -e "$STAGING_KEY" . | grep -vxF -e './assets/js/config.js' -e './.htaccess' || true)"
  [ -z "$LEAK" ] || die "project ref / key outside config.js / .htaccess in site/: $(printf '%s' "$LEAK" | tr '\n' ' ')"
else
  ! grep -rIlF -e "$STAGING_REF" -e "$STAGING_KEY" . >/dev/null \
    || die "staging project ref / key in site/: $(grep -rIlF -e "$STAGING_REF" -e "$STAGING_KEY" . | tr '\n' ' ')"
fi
# staging wording a visitor of production would see (pages outside demo / staging-only blocks, guides, manifest.json)
pyl scan "$SITE"
# every local href / src of the pages exists
python3 -I - "$SITE" <<'PY'
import os, re, sys
root = sys.argv[1]; missing = []
for f in sorted(os.listdir(root)):
    if not f.endswith('.html'): continue
    for ref in re.findall(r'(?:href|src)="([^"]+)"', open(os.path.join(root, f), encoding='utf-8').read()):
        if re.match(r'^(?:[a-z]+:|#|//)', ref): continue
        p = ref.split('#')[0].split('?')[0]
        if p and not os.path.exists(os.path.join(root, p)): missing.append(f + ' → ' + ref)
if missing: sys.exit('build-release: missing local references:\n  ' + '\n  '.join(missing))
PY

# ---- zip + manifest
STAMP="$(date +%Y%m%d-%H%M)"
ZIP="$OUT/marsa-release-prod-$STAMP.zip"
zip -q -r -X "$ZIP" . -x '.DS_Store' '*/.DS_Store'
cd "$OUT"
find site edge -type f | LC_ALL=C sort | while IFS= read -r f; do shasum -a 256 "$f"; done > SHA256SUMS
shasum -a 256 "$(basename "$ZIP")" >> SHA256SUMS

echo "release built from commit $COMMIT$([ -n "$DIRTY" ] && echo ' (+ uncommitted changes)') → $OUT"
echo "  site/: $(find site -type f | wc -l | tr -d ' ') files ($(du -sk site | cut -f1) KB)   edge/: $(ls edge | tr '\n' ' ')"
echo "  config.js → $URL, orgSlug $SLUG, environment production ($KEY_KIND key)$([ "$IN_PLACE" = 1 ] && echo ', IN PLACE (current project)')"
echo "  sw.js VERSION $(sed -n "s/^var VERSION = '\([^']*\)'.*/\1/p" site/sw.js)"
echo "  zip:  $(basename "$ZIP")  sha256 $(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
echo "  SHA256SUMS: $(wc -l < SHA256SUMS | tr -d ' ') entries"
if [ "$IN_PLACE" = 1 ]; then
  echo "Next (in place): docs/online/CONVERT_IN_PLACE_AR.md — the database conversion first (backup, preview, convert),"
  echo "      then a backup of public_html, EMPTY it (keep nothing of the staging files: .htaccess, _headers, robots.txt),"
  echo "      upload the zip and extract. The Edge Functions stay as they are; remove the test-only secrets (runbook)."
  exit 0
fi
echo "Next: supabase/production/README.md «cutover» first (staging on its own subdomain, Auth URLs, a backup of"
echo "      public_html), then EMPTY public_html of the production domain, upload the zip and extract; edge/*.ts go to"
echo "      the PRODUCTION project's Edge Functions (their secrets are set there, never in a file; MARSA_ENV must not be"
echo "      'staging')."
