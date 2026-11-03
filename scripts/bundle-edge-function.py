#!/usr/bin/env python3
"""Bundle an Edge Function (index.ts + its `import './x.js';` classic scripts) into one file for the
Supabase Dashboard editor. Usage: python3 scripts/bundle-edge-function.py inbox-sync > /tmp/inbox-sync.ts"""
import os, re, sys

name = sys.argv[1]
base = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'supabase', 'functions', name)
src = open(os.path.join(base, 'index.ts'), encoding='utf-8').read()

def inline(m):
    f = m.group(1)
    body = open(os.path.join(base, f), encoding='utf-8').read()
    return f"// ===== bundled from {f} =====\n{body}\n// ===== end {f} =====\n"

out = re.sub(r"^import '\./([\w-]+\.js)';\s*$", inline, src, flags=re.M)
if "import './" in out:
    sys.exit('unbundled relative import left')
sys.stdout.write(f"// Single-file bundle of supabase/functions/{name} for Dashboard deploy (generated; edit the sources).\n" + out)
