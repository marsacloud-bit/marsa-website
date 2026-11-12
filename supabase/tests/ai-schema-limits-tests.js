#!/usr/bin/env node
/*
  Marsa (مرسى) — the Claude structured-output schemas of ai-extract stay inside the API's compile limits.
  Live finding 2026-11-12: every ai-doc-v3 reading failed with 400 invalid_request_error «Schemas contains too many
  parameters with union types (20 …) (limit: 16 parameters with unions)». No network, no DB.
  usage: node supabase/tests/ai-schema-limits-tests.js [/path/to/marsa-website] [--quiet]
*/
'use strict';
const path = require('path');
const root = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(__dirname, '..', '..');
const quiet = process.argv.includes('--quiet');
const X = require(path.join(root, 'supabase/functions/ai-extract/extract.js'));
let pass = 0, fail = 0;
function check(name, fn) { try { fn(); pass++; if (!quiet) console.log('ok  ', name); } catch (e) { fail++; console.log('FAIL', name, '—', e.message); } }
function unions(s) {
  if (!s || typeof s !== 'object') return 0;
  if (Array.isArray(s)) return s.reduce((n, x) => n + unions(x), 0);
  let n = (Array.isArray(s.type) || s.anyOf || s.oneOf) ? 1 : 0;
  Object.keys(s).forEach(k => { n += unions(s[k]); });
  return n;
}
const TYPES = ['auto', 'bill_of_lading', 'commercial_invoice', 'customs_declaration', 'supplier_invoice', 'packing_list',
  'appointment_ticket', 'empty_return_receipt', 'appointment_invoice', 'payment_proof'];
['ai-doc-v2', 'ai-doc-v3'].forEach(v => TYPES.forEach(t => {
  let sc = null;
  try { sc = X.outputSchema(t, v); } catch (e) { sc = null; }
  if (!sc) return;
  check(v + ' ' + t + ': at most 16 union-typed parameters', () => {
    const n = unions(sc);
    if (n > 16) throw new Error(n + ' unions');
  });
}));
check('v3: blank text columns of line_items / containers come back as null', () => {
  const data = { doc_type: 'bill_of_lading', detected_documents: [], fields: [], warnings: [],
    line_items: [{ description: 'Pallets', hs_code: '', quantity: null, unit_price: null, amount: null, unit: ' ', scientific_name: '',
      origin_country: 'TR', net_weight: null, gross_weight: 4040, packages: 19, container_number: '', seal_number: '', notes: '' }],
    containers: [{ container_number: 'TSTU7710023', seal_number: '', size_type: '40HC', packages_count: 19, net_weight: null, gross_weight: 4040 }] };
  const msg = { model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: 'text', text: JSON.stringify(data) }] };
  const r = X.parseMessage(msg, 'ai-doc-v3', 'bill_of_lading');
  if (!r.ok) throw new Error('not ok: ' + r.code);
  const li = r.data.line_items[0], c = r.data.containers[0];
  if (li.hs_code !== null || li.unit !== null || li.seal_number !== null) throw new Error('blank item text kept');
  if (li.origin_country !== 'TR' || li.description !== 'Pallets') throw new Error('real values changed');
  if (c.seal_number !== null || c.size_type !== '40HC') throw new Error('container blanks');
});
console.log((fail ? 'FAILED' : 'OK') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
